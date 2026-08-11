// Main-side bridge between the ephemeral MCP stdio server (runtime-host/team-mcp-server-source.ts,
// spawned inside the real Claude CLI's own process tree) and TeamCoordinator. The MCP server never
// talks to persistence/TeamCoordinator directly — it only ever knows a local IPC endpoint and a
// per-turn bearer token; this class is the sole thing that maps a validated token back to the
// (taskId, turnId) it was issued for, so a tool call arriving over the wire can never spoof which
// Task/Team it targets (see executeTeamTool in team-tools.ts, which this forwards into).
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeTeamTool, type ExecuteTeamToolOptions } from './team-tools';
import type { TeamCoordinator } from './team-coordinator';
import { secureLogger } from './secure-logger';

// macOS's sockaddr_un.sun_path is 104 bytes (Linux allows 108); staying comfortably under that
// keeps bind() from failing on long app-data paths (a real, previously-hit failure mode on this
// project — see tasks/todo.md). `/tmp` is short and stable across platforms, so it is always
// tried first; `os.tmpdir()` and the caller-provided (userData-derived) directory are fallbacks
// for sandboxes where `/tmp` is not writable.
const MAX_SUN_PATH_BYTES = 100;
const MAX_PENDING_REQUEST_BYTES = 1024 * 1024;
const DEFAULT_AUTHENTICATION_TIMEOUT_MS = 5_000;
const MAX_CONCURRENT_CONNECTIONS = 16;
const WINDOWS_POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const WINDOWS_PIPE_BROKER = String.raw`
$ErrorActionPreference = 'Stop'
$name = $env:SPRINT_CODER_PIPE_NAME
$port = [int]$env:SPRINT_CODER_PIPE_PORT
$secret = $env:SPRINT_CODER_PIPE_SECRET
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$security = [System.IO.Pipes.PipeSecurity]::new()
$security.SetOwner($sid)
$rule = [System.IO.Pipes.PipeAccessRule]::new(
  $sid,
  [System.IO.Pipes.PipeAccessRights]::FullControl,
  [System.Security.AccessControl.AccessControlType]::Allow
)
$security.SetAccessRule($rule)
function New-Listener {
  $pipe = [System.IO.Pipes.NamedPipeServerStream]::new(
    $name,
    [System.IO.Pipes.PipeDirection]::InOut,
    16,
    [System.IO.Pipes.PipeTransmissionMode]::Byte,
    [System.IO.Pipes.PipeOptions]::Asynchronous,
    65536,
    65536,
    $security
  )
  $actual = $pipe.GetAccessControl()
  $rules = @($actual.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]))
  if ($rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value) {
    $pipe.Dispose()
    throw 'Named pipe DACL verification failed'
  }
  return @{
    Pipe = $pipe
    Accept = $pipe.WaitForConnectionAsync()
  }
}
$listeners = [System.Collections.ArrayList]::new()
$connections = [System.Collections.ArrayList]::new()
for ($i = 0; $i -lt 16; $i += 1) { [void]$listeners.Add((New-Listener)) }
[Console]::Out.WriteLine('READY')
while ($true) {
  $tasks = [System.Collections.Generic.List[System.Threading.Tasks.Task]]::new()
  foreach ($listener in $listeners) { $tasks.Add($listener.Accept) }
  foreach ($connection in $connections) { $tasks.Add($connection.Pump) }
  $completed = [System.Threading.Tasks.Task]::WaitAny($tasks.ToArray())
  if ($completed -lt $listeners.Count) {
    $listener = $listeners[$completed]
    $listeners.RemoveAt($completed)
    $pipe = $listener.Pipe
    $tcp = [System.Net.Sockets.TcpClient]::new()
    $tcp.Connect('127.0.0.1', $port)
    $stream = $tcp.GetStream()
    $prefix = [System.Text.Encoding]::UTF8.GetBytes(
      ('{"bridgeToken":"' + $secret + '"}' + [Environment]::NewLine)
    )
    $stream.Write($prefix, 0, $prefix.Length)
    $stream.Flush()
    $toTcp = $pipe.CopyToAsync($stream)
    $toPipe = $stream.CopyToAsync($pipe)
    [void]$connections.Add(@{
      Pipe = $pipe
      Tcp = $tcp
      Stream = $stream
      Pump = [System.Threading.Tasks.Task]::WhenAny($toTcp, $toPipe)
    })
    continue
  }
  $connectionIndex = $completed - $listeners.Count
  $connection = $connections[$connectionIndex]
  $connections.RemoveAt($connectionIndex)
  $connection.Stream.Dispose()
  $connection.Tcp.Dispose()
  $connection.Pipe.Dispose()
  [void]$listeners.Add((New-Listener))
}
`;

export function defaultSocketPathFactory(
  preferredDirectory: string,
  platform: NodeJS.Platform = process.platform,
): () => string {
  return () => {
    const id = randomBytes(16).toString('hex');
    if (platform === 'win32') return `\\\\.\\pipe\\sc-team-${id}`;

    const candidates = [
      join('/tmp', `sc-team-${id}.sock`),
      join(tmpdir(), `sc-team-${id}.sock`),
      join(preferredDirectory, `sc-team-${id}.sock`),
    ];
    const chosen = candidates.find((path) => Buffer.byteLength(path, 'utf8') <= MAX_SUN_PATH_BYTES);
    if (chosen === undefined)
      throw new Error('No socket path candidate fits the platform sun_path length limit');
    return chosen;
  };
}

function isWindowsNamedPipe(path: string): boolean {
  return path.startsWith('\\\\.\\pipe\\') || path.startsWith('\\\\?\\pipe\\');
}

export type TeamMcpRegistration = Readonly<{
  taskId: string;
  token: string;
  requesterAgentId?: string;
  accessCeiling?: 'read-only' | 'workspace-write';
  requireModelResearch?: boolean;
  allowSkillDrafts?: boolean;
  allowSkillImports?: boolean;
  allowProjectMemory?: boolean;
  allowTeamTools?: boolean;
  contextOwner?: { type: 'turn' | 'team_execution'; id: string };
  initialWaitCursor?: number;
}>;

type Registered = TeamMcpRegistration & {
  waitCursor: number;
  modelCatalogQueried: boolean;
  researchedModels: Set<string>;
};

function modelSelectionKey(selection: {
  connectionId: string | null;
  requestedProvider: string | null;
  requestedModel: string | null;
}): string {
  return `${selection.connectionId ?? ''}\0${selection.requestedProvider ?? ''}\0${selection.requestedModel ?? ''}`;
}

export class TeamMcpBridge {
  private readonly registrations = new Map<string, Registered>();
  private readonly sockets = new Set<Socket>();
  private server: Server | null = null;
  private windowsBroker: ChildProcess | null = null;
  private socketPathValue: string | null = null;
  private startPromise: Promise<string> | null = null;

  constructor(
    private readonly coordinator: TeamCoordinator,
    private readonly socketPathFactory: () => string,
    private readonly authenticationTimeoutMs = DEFAULT_AUTHENTICATION_TIMEOUT_MS,
    private readonly listModelCandidates?: NonNullable<
      ExecuteTeamToolOptions['listModelCandidates']
    >,
    private readonly createSkillDraft?: (
      input: unknown,
      context: { taskId: string; turnId: string },
    ) => Promise<unknown>,
    private readonly queueProjectMemoryCandidate?: (
      input: unknown,
      context: { taskId: string; turnId: string },
    ) => Promise<unknown>,
    private readonly installPreparedSkill?: (
      input: unknown,
      context: { taskId: string; turnId: string },
    ) => Promise<unknown>,
  ) {}

  get socketPath(): string | null {
    return this.socketPathValue;
  }

  /** Idempotent: safe to call once at app startup and reuse the same listening socket for every
   * subsequent Leader turn that opts into the MCP path. */
  async ensureStarted(): Promise<string | null> {
    if (this.socketPathValue !== null) return this.socketPathValue;
    if (this.startPromise !== null) return this.startPromise;
    this.startPromise = this.start().catch((error: unknown) => {
      this.startPromise = null;
      // A bridge that fails to start is a soft failure: callers (ipc.ts) treat a null socketPath
      // as "fall back to the mock leader path" rather than crashing turn dispatch.
      secureLogger.error('Team MCP bridge failed to start', error);
      return null as unknown as string;
    });
    return this.startPromise;
  }

  private async start(): Promise<string> {
    const path = this.socketPathFactory();
    if (isWindowsNamedPipe(path)) return this.startWindowsPipe(path);
    return this.startUnixSocket(path);
  }

  private startUnixSocket(path: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (existsSync(path)) {
        try {
          unlinkSync(path);
        } catch {
          // best effort: a stale socket file from a previous crashed run
        }
      }
      const server = createServer((socket) => this.handleConnection(socket, null));
      server.maxConnections = MAX_CONCURRENT_CONNECTIONS;
      server.once('error', (error) => reject(error as Error));
      server.listen(
        {
          path,
          // Keep the Unix socket private by default. Windows named pipes are refused above because
          // libuv creates them with the platform default DACL, which grants broader read access.
          readableAll: false,
          writableAll: false,
          exclusive: true,
        },
        () => {
          try {
            chmodSync(path, 0o600);
          } catch {
            // best effort on platforms without POSIX file modes
          }
          this.server = server;
          this.socketPathValue = path;
          resolve(path);
        },
      );
    });
  }

  private async startWindowsPipe(path: string): Promise<string> {
    const bridgeToken = randomBytes(32).toString('hex');
    const server = createServer((socket) => this.handleConnection(socket, bridgeToken));
    server.maxConnections = MAX_CONCURRENT_CONNECTIONS;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      server.close();
      throw new Error('Windows Team MCP internal endpoint is unavailable');
    }
    const pipeName = path.replace(/^\\\\[.?]\\pipe\\/, '');
    const encodedScript = Buffer.from(WINDOWS_PIPE_BROKER, 'utf16le').toString('base64');
    const broker = spawn(
      WINDOWS_POWERSHELL,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript],
      {
        env: {
          SystemRoot: process.env['SystemRoot'] ?? 'C:\\Windows',
          WINDIR: process.env['WINDIR'] ?? 'C:\\Windows',
          PATH: process.env['PATH'] ?? '',
          TEMP: process.env['TEMP'] ?? '',
          TMP: process.env['TMP'] ?? '',
          USERPROFILE: process.env['USERPROFILE'] ?? '',
          SPRINT_CODER_PIPE_NAME: pipeName,
          SPRINT_CODER_PIPE_PORT: String(address.port),
          SPRINT_CODER_PIPE_SECRET: bridgeToken,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    try {
      await waitForBrokerReady(broker);
    } catch (error) {
      broker.kill();
      server.close();
      throw error;
    }
    this.server = server;
    this.windowsBroker = broker;
    this.socketPathValue = path;
    return path;
  }

  /** Binds a fresh, random bearer token to (taskId, turnId) for the duration of one Leader turn.
   * Call this before starting the Claude runtime for that turn, and always pair it with
   * `unregister` on completion/failure/cancel — an un-unregistered turn keeps its token live. */
  register(turnId: string, registration: TeamMcpRegistration): void {
    this.registrations.set(turnId, {
      ...registration,
      waitCursor: registration.initialWaitCursor ?? 0,
      modelCatalogQueried: false,
      researchedModels: new Set(),
    });
  }

  unregister(turnId: string): void {
    this.registrations.delete(turnId);
  }

  static generateToken(): string {
    return randomBytes(32).toString('hex');
  }

  private handleConnection(socket: Socket, requiredBridgeToken: string | null): void {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    let buffer = '';
    let authenticated = false;
    let bridgeAuthenticated = requiredBridgeToken === null;
    const authenticationTimer = setTimeout(() => socket.destroy(), this.authenticationTimeoutMs);
    authenticationTimer.unref();
    const markAuthenticated = () => {
      if (authenticated) return;
      authenticated = true;
      clearTimeout(authenticationTimer);
    };
    socket.once('close', () => clearTimeout(authenticationTimer));
    socket.on('data', (chunk: Buffer) => {
      if (Buffer.byteLength(buffer, 'utf8') + chunk.byteLength > MAX_PENDING_REQUEST_BYTES) {
        socket.destroy();
        return;
      }
      buffer += chunk.toString('utf8');
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!bridgeAuthenticated) {
          bridgeAuthenticated = matchesBridgeToken(line, requiredBridgeToken);
          if (!bridgeAuthenticated) socket.destroy();
          continue;
        }
        if (line.trim() !== '') void this.handleLine(socket, line, markAuthenticated);
      }
    });
    socket.on('error', () => socket.destroy());
  }

  private async handleLine(
    socket: Socket,
    line: string,
    markAuthenticated: () => void,
  ): Promise<void> {
    let request: { requestId?: unknown; token?: unknown; tool?: unknown; args?: unknown };
    try {
      request = JSON.parse(line) as typeof request;
    } catch {
      socket.destroy();
      return;
    }
    if (
      typeof request.requestId !== 'string' ||
      request.requestId.length === 0 ||
      request.requestId.length > 128
    ) {
      socket.destroy();
      return;
    }
    const respond = (payload: Readonly<Record<string, unknown>>): void => {
      if (!socket.destroyed)
        socket.write(`${JSON.stringify({ requestId: request.requestId, ...payload })}\n`);
    };
    const found = this.findByToken(request.token);
    if (found === undefined) {
      // Unknown/forged token: close without responding rather than confirming or denying which
      // part of the request was wrong (fail-closed, no oracle).
      socket.destroy();
      return;
    }
    markAuthenticated();
    if (typeof request.tool !== 'string') {
      respond({ ok: false, error: 'invalid_tool' });
      return;
    }
    if (request.tool === '__authenticate__') {
      const [, registration] = found;
      respond({
        ok: true,
        result: {
          authenticated: true,
          capabilities: {
            projectMemory: registration.allowProjectMemory === true,
            skillDrafts: registration.allowSkillDrafts === true,
            skillImports: registration.allowSkillImports === true,
            teamTools: registration.allowTeamTools !== false,
          },
        },
      });
      return;
    }
    const [turnId, registration] = found;
    try {
      if (process.env['SPRINT_CODER_TEAM_MCP_TRACE'] === '1')
        secureLogger.debug('Team MCP tool received', { tool: request.tool });
      const result =
        request.tool === 'project_memory_remember'
          ? await this.executeProjectMemoryTool(turnId, registration, request.args)
          : request.tool === 'skill_draft_create'
            ? await this.executeSkillDraftTool(turnId, registration, request.args)
            : request.tool === 'skill_import_install'
              ? await this.executeSkillImportTool(turnId, registration, request.args)
              : registration.allowTeamTools === false
                ? (() => {
                    throw new Error('Team tools are not available for this Turn');
                  })()
                : await executeTeamTool(
                    this.coordinator,
                    registration.taskId,
                    request.tool,
                    request.args,
                    {
                      ...(registration.requesterAgentId === undefined
                        ? {}
                        : { requesterAgentId: registration.requesterAgentId }),
                      ...(registration.accessCeiling === undefined
                        ? {}
                        : { accessCeiling: registration.accessCeiling }),
                      ...(registration.contextOwner === undefined
                        ? {}
                        : { contextOwner: registration.contextOwner }),
                      longPoll:
                        request.tool === 'team_wait_reports' || request.tool === 'team_wait_events',
                      waitReportsCursor: {
                        read: () => registration.waitCursor,
                        advance: (seq) => {
                          registration.waitCursor = seq;
                        },
                      },
                      ...(this.listModelCandidates === undefined
                        ? {}
                        : { listModelCandidates: this.listModelCandidates }),
                      modelCatalogAudit: {
                        wasQueried: () => registration.modelCatalogQueried,
                        markQueried: () => {
                          registration.modelCatalogQueried = true;
                        },
                      },
                      ...(registration.requireModelResearch === true
                        ? {
                            modelResearchAudit: {
                              required: true,
                              record: (input: {
                                modelSelection: {
                                  connectionId: string | null;
                                  requestedProvider: string | null;
                                  requestedModel: string | null;
                                };
                              }) => {
                                registration.researchedModels.add(
                                  modelSelectionKey(input.modelSelection),
                                );
                              },
                              hasEvidence: (selection: {
                                connectionId: string | null;
                                requestedProvider: string | null;
                                requestedModel: string | null;
                              }) => registration.researchedModels.has(modelSelectionKey(selection)),
                            },
                          }
                        : {}),
                    },
                  );
      respond({ ok: true, result });
    } catch (error) {
      respond({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    void turnId;
  }

  private async executeSkillDraftTool(
    turnId: string,
    registration: Registered,
    input: unknown,
  ): Promise<unknown> {
    if (
      registration.allowSkillDrafts !== true ||
      registration.requesterAgentId !== undefined ||
      this.createSkillDraft === undefined
    )
      throw new Error('skill_draft_create is not available for this Turn');
    return this.createSkillDraft(input, { taskId: registration.taskId, turnId });
  }

  private async executeSkillImportTool(
    turnId: string,
    registration: Registered,
    input: unknown,
  ): Promise<unknown> {
    if (
      registration.allowSkillImports !== true ||
      registration.requesterAgentId !== undefined ||
      this.installPreparedSkill === undefined
    )
      throw new Error('skill_import_install is not available for this Turn');
    return this.installPreparedSkill(input, { taskId: registration.taskId, turnId });
  }

  private async executeProjectMemoryTool(
    turnId: string,
    registration: Registered,
    input: unknown,
  ): Promise<unknown> {
    if (
      registration.allowProjectMemory !== true ||
      registration.requesterAgentId !== undefined ||
      this.queueProjectMemoryCandidate === undefined
    )
      throw new Error('project_memory_remember is not available for this Turn');
    return this.queueProjectMemoryCandidate(input, {
      taskId: registration.taskId,
      turnId,
    });
  }

  /** Constant-time token compare: every registered token is compared with `timingSafeEqual`
   * (never a plain `===`/string compare), so a wrong guess cannot be distinguished by timing from
   * a right one for any single candidate. Buffer-length mismatches are checked before calling
   * `timingSafeEqual` (which throws on mismatched lengths) rather than treated as a fast-reject —
   * they still fall through to the same "unknown token" close as every other rejection. */
  private findByToken(token: unknown): [string, Registered] | undefined {
    if (typeof token !== 'string') return undefined;
    const candidate = Buffer.from(token, 'utf8');
    for (const [turnId, registration] of this.registrations) {
      const expected = Buffer.from(registration.token, 'utf8');
      if (expected.length === candidate.length && timingSafeEqual(expected, candidate))
        return [turnId, registration];
    }
    return undefined;
  }

  async dispose(): Promise<void> {
    this.registrations.clear();
    this.startPromise = null;
    const server = this.server;
    this.server = null;
    const socketPath = this.socketPathValue;
    this.socketPathValue = null;
    this.windowsBroker?.kill();
    this.windowsBroker = null;
    if (server === null) return;
    // net.Server.close waits for every accepted connection. Claude/Codex may keep an authenticated
    // bridge socket open after a completed turn, so destroy those sockets before waiting or app
    // quit can hang indefinitely.
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (socketPath !== null && !isWindowsNamedPipe(socketPath)) {
      try {
        unlinkSync(socketPath);
      } catch {
        // already gone
      }
    }
  }
}

function matchesBridgeToken(line: string, expected: string | null): boolean {
  if (expected === null) return true;
  try {
    const parsed = JSON.parse(line) as { bridgeToken?: unknown };
    if (typeof parsed.bridgeToken !== 'string') return false;
    const actualBytes = Buffer.from(parsed.bridgeToken);
    const expectedBytes = Buffer.from(expected);
    return (
      actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
    );
  } catch {
    return false;
  }
}

function waitForBrokerReady(broker: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(
      () => finish(new Error('Windows pipe broker startup timed out')),
      10_000,
    );
    const finish = (error?: Error): void => {
      clearTimeout(timeout);
      broker.stdout?.removeAllListeners();
      broker.stderr?.removeAllListeners();
      broker.removeListener('exit', onExit);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onExit = (): void => finish(new Error(`Windows pipe broker exited: ${stderr.trim()}`));
    broker.once('exit', onExit);
    broker.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.includes('READY')) finish();
    });
    broker.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
  });
}
