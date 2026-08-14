// Main-side bridge between the ephemeral MCP stdio server (runtime-host/team-mcp-server-source.ts,
// spawned inside the real Claude CLI's own process tree) and TeamCoordinator. The MCP server never
// talks to persistence/TeamCoordinator directly — it only ever knows a local IPC endpoint and a
// per-turn bearer token; this class accepts it only from the kernel-identified CLI process tree,
// then maps it back to the (taskId, turnId) it was issued for. A copied token or settings file is
// therefore insufficient to spoof which Task/Team a call targets.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { executeTeamTool, type ExecuteTeamToolOptions } from './team-tools';
import type { TeamCoordinator } from './team-coordinator';
import { secureLogger } from './secure-logger';
import { parseSkillImportConfirmation } from './import-skill-builtin';
import {
  teamMcpToolNamesForCapabilities,
  type TeamMcpRole,
  type TeamMcpToolName,
} from '../runtime-host/team-mcp-tool-contract';
import {
  isNativeProcessDescendant,
  queryNativeNamedPipePeerIdentity,
  queryNativeProcessIdentity,
  queryNativeSocketPeerIdentity,
  sameNativeProcessIdentity,
  type NativeProcessIdentity,
} from './native-process-identity';

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
function Trace-Broker($stage) {
  if ($env:SPRINT_CODER_PIPE_DIAGNOSTICS -eq '1') {
    [Console]::Error.WriteLine(('stage:' + $stage))
    [Console]::Error.Flush()
  }
}
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
function Send-Frame($frame) {
  [Console]::Out.WriteLine(($frame | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}
$listeners = [System.Collections.ArrayList]::new()
$connections = [System.Collections.ArrayList]::new()
# One pending listener is sufficient because it is replenished immediately after every accept;
# the NamedPipeServerStream instance limit still caps total concurrent connections at 16.
[void]$listeners.Add((New-Listener))
Trace-Broker 'listener-ready'
$stdin = [Console]::OpenStandardInput()
$stdinBuffer = [byte[]]::new(65536)
$stdinPending = ''
$stdinRead = $stdin.ReadAsync($stdinBuffer, 0, $stdinBuffer.Length)
[Console]::Out.WriteLine('{"type":"ready"}')
[Console]::Out.Flush()
while ($true) {
  $tasks = [System.Collections.Generic.List[System.Threading.Tasks.Task]]::new()
  $tasks.Add($stdinRead)
  foreach ($listener in $listeners) { $tasks.Add($listener.Accept) }
  foreach ($connection in $connections) { $tasks.Add($connection.Read) }
  Trace-Broker 'waiting'
  $completed = [System.Threading.Tasks.Task]::WaitAny($tasks.ToArray())
  Trace-Broker ('completed-' + $completed.ToString())
  if ($completed -eq 0) {
    $count = $stdinRead.Result
    if ($count -le 0) { break }
    $stdinPending += [System.Text.Encoding]::UTF8.GetString($stdinBuffer, 0, $count)
    if ($stdinPending.Length -gt 2097152) { break }
    $stdinRead = $stdin.ReadAsync($stdinBuffer, 0, $stdinBuffer.Length)
    while (($newline = $stdinPending.IndexOf([char]10)) -ge 0) {
      $line = $stdinPending.Substring(0, $newline).TrimEnd([char]13)
      $stdinPending = $stdinPending.Substring($newline + 1)
      if ($line.Length -eq 0) { continue }
      $command = $line | ConvertFrom-Json
      $connection = $connections | Where-Object { $_.Id -eq $command.connectionId } | Select-Object -First 1
      if ($null -eq $connection) { continue }
      if ($command.type -eq 'write') {
        try {
          $bytes = [Convert]::FromBase64String([string]$command.data)
          $connection.Pipe.Write($bytes, 0, $bytes.Length)
          $connection.Pipe.Flush()
        } catch {
          [void]$connections.Remove($connection)
          $connection.Pipe.Dispose()
          Send-Frame @{ type = 'close'; connectionId = $connection.Id }
        }
      } elseif ($command.type -eq 'close') {
        [void]$connections.Remove($connection)
        $connection.Pipe.Dispose()
      }
    }
    continue
  }
  $listenerCount = $listeners.Count
  if ($completed -le $listenerCount) {
    Trace-Broker 'accepted'
    $listenerIndex = $completed - 1
    $listener = $listeners[$listenerIndex]
    $listeners.RemoveAt($listenerIndex)
    $pipe = $listener.Pipe
    $id = [Guid]::NewGuid().ToString('N')
    $pipeHandle = $pipe.SafePipeHandle.DangerousGetHandle().ToInt64().ToString()
    $buffer = [byte[]]::new(65536)
    $connection = @{ Id = $id; Pipe = $pipe; Buffer = $buffer; Read = $null }
    [void]$connections.Add($connection)
    Send-Frame @{ type = 'open'; connectionId = $id; pipeHandle = $pipeHandle }
    Trace-Broker 'open-sent'
    $connection.Read = $pipe.ReadAsync($buffer, 0, $buffer.Length)
    Trace-Broker 'read-started'
    [void]$listeners.Add((New-Listener))
    continue
  }
  $connectionIndex = $completed - 1 - $listenerCount
  $connection = $connections[$connectionIndex]
  try { $count = $connection.Read.Result } catch { $count = 0 }
  if ($count -le 0) {
    $connections.RemoveAt($connectionIndex)
    $connection.Pipe.Dispose()
    Send-Frame @{ type = 'close'; connectionId = $connection.Id }
    continue
  }
  $bytes = [byte[]]::new($count)
  [Array]::Copy($connection.Buffer, $bytes, $count)
  Send-Frame @{ type = 'data'; connectionId = $connection.Id; data = [Convert]::ToBase64String($bytes) }
  $connection.Read = $connection.Pipe.ReadAsync($connection.Buffer, 0, $connection.Buffer.Length)
}
`;

interface BridgeConnection {
  readonly destroyed: boolean;
  write(data: string): unknown;
  destroy(): void;
  once(event: 'close', listener: () => void): this;
  on(event: 'data', listener: (chunk: Buffer) => void): this;
  on(event: 'error', listener: () => void): this;
}

class WindowsBrokerConnection extends EventEmitter implements BridgeConnection {
  destroyed = false;

  constructor(
    readonly id: string,
    private readonly send: (frame: Readonly<Record<string, unknown>>) => void,
  ) {
    super();
  }

  write(data: string): void {
    if (this.destroyed) return;
    this.send({
      type: 'write',
      connectionId: this.id,
      data: Buffer.from(data, 'utf8').toString('base64'),
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.send({ type: 'close', connectionId: this.id });
    this.emit('close');
  }

  receive(data: Buffer): void {
    if (!this.destroyed) this.emit('data', data);
  }

  remoteClosed(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('close');
  }
}

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
  skillImportUserText?: string;
  allowProjectMemory?: boolean;
  allowTeamTools?: boolean;
  role?: TeamMcpRole;
  allowedTools?: readonly TeamMcpToolName[];
  contextOwner?: { type: 'turn' | 'team_execution'; id: string };
  initialWaitCursor?: number;
}>;

type Registered = TeamMcpRegistration & {
  waitCursor: number;
  modelCatalogQueried: boolean;
  researchedModels: Set<string>;
  authorizedSkillImport?: { cli: 'claude' | 'codex'; skillId: string; digest: string };
  skillImportReadStarted: boolean;
  runtimeProcessIdentity: NativeProcessIdentity | null;
};

function modelSelectionKey(selection: {
  connectionId: string | null;
  requestedProvider: string | null;
  requestedModel: string | null;
}): string {
  return `${selection.connectionId ?? ''}\0${selection.requestedProvider ?? ''}\0${selection.requestedModel ?? ''}`;
}

type SkillImportSource = { cli: 'claude' | 'codex'; skillId: string };

function parseSkillImportReadInput(input: unknown): SkillImportSource {
  if (typeof input !== 'object' || input === null) throw new Error('invalid skill import source');
  const value = input as { cli?: unknown; skillId?: unknown };
  if (
    (value.cli !== 'claude' && value.cli !== 'codex') ||
    typeof value.skillId !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value.skillId)
  )
    throw new Error('invalid skill import source');
  return { cli: value.cli, skillId: value.skillId };
}

function parseSkillImportSource(input: unknown): SkillImportSource & { digest: string } {
  if (typeof input !== 'object' || input === null) throw new Error('invalid skill import source');
  const source = (input as { source?: unknown }).source;
  const parsed = parseSkillImportReadInput(source);
  const digest = (source as { digest?: unknown }).digest;
  if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest))
    throw new Error('invalid skill import source digest');
  return { ...parsed, digest };
}

function userConfirmedSkillImport(text: string | undefined, source: SkillImportSource): boolean {
  if (text === undefined) return false;
  const confirmation = parseSkillImportConfirmation(text);
  return (
    confirmation !== null &&
    confirmation.cli === source.cli &&
    confirmation.skillId === source.skillId
  );
}

function readDigest(result: unknown): string {
  if (typeof result !== 'object' || result === null) throw new Error('invalid skill import result');
  const digest = (result as { digest?: unknown }).digest;
  if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest))
    throw new Error('invalid skill import result digest');
  return digest;
}

export class TeamMcpBridge {
  private readonly registrations = new Map<string, Registered>();
  private readonly sockets = new Set<BridgeConnection>();
  private readonly windowsConnections = new Map<string, WindowsBrokerConnection>();
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
    private readonly readImportSkillSource?: (
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
      secureLogger.error('Team MCP bridge failed to start', error, {
        event: 'system.team_mcp.start_failed',
        status: 'failed',
      });
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
      const server = createServer((socket) => {
        const peer = queryNativeSocketPeerIdentity(socket);
        const currentUserId = process.getuid?.();
        if (peer === null || (currentUserId !== undefined && peer.userId !== currentUserId)) {
          socket.destroy();
          return;
        }
        this.handleConnection(socket, peer);
      });
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
          SPRINT_CODER_PIPE_DIAGNOSTICS: process.env['CI'] === 'true' ? '1' : '0',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    try {
      await this.attachWindowsBroker(broker);
    } catch (error) {
      broker.kill();
      throw error;
    }
    this.windowsBroker = broker;
    this.socketPathValue = path;
    return path;
  }

  private attachWindowsBroker(broker: ChildProcess): Promise<void> {
    return new Promise((resolve, reject) => {
      const output = createInterface({ input: broker.stdout! });
      let ready = false;
      let stderr = '';
      const timeout = setTimeout(
        () => finish(new Error('Windows pipe broker startup timed out')),
        10_000,
      );
      const finish = (error?: Error): void => {
        clearTimeout(timeout);
        if (error === undefined) resolve();
        else reject(error);
      };
      broker.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
        if (stderr.length > 16_384) stderr = stderr.slice(-16_384);
      });
      broker.once('exit', (code, signal) => {
        for (const connection of this.windowsConnections.values()) connection.remoteClosed();
        this.windowsConnections.clear();
        if (!ready) finish(new Error(`Windows pipe broker exited: ${stderr.trim()}`));
        else
          secureLogger.error(
            'Windows Team MCP pipe broker exited after startup',
            { code, signal, stderr: stderr.trim() },
            { category: 'team', event: 'team.mcp.windows_broker_exited', status: 'failed' },
          );
      });
      output.on('line', (line) => {
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(line) as Record<string, unknown>;
        } catch {
          secureLogger.error(
            'Windows Team MCP pipe broker emitted an invalid frame',
            { lineLength: line.length },
            { category: 'team', event: 'team.mcp.windows_broker_frame_invalid', status: 'failed' },
          );
          broker.kill();
          return;
        }
        if (frame['type'] === 'ready') {
          if (!ready) {
            ready = true;
            finish();
          }
          return;
        }
        const connectionId = frame['connectionId'];
        if (typeof connectionId !== 'string' || connectionId.length > 64) return;
        if (frame['type'] === 'open') {
          const pipeHandle = frame['pipeHandle'];
          if (
            typeof pipeHandle !== 'string' ||
            !/^[1-9][0-9]{0,31}$/.test(pipeHandle) ||
            broker.pid === undefined
          ) {
            this.sendWindowsBrokerFrame(broker, { type: 'close', connectionId });
            return;
          }
          let nativeFailure: unknown;
          const peerIdentity = queryNativeNamedPipePeerIdentity(broker.pid, pipeHandle, (error) => {
            nativeFailure = error;
          });
          if (peerIdentity === null) {
            secureLogger.error(
              'Windows Team MCP pipe peer identity could not be verified',
              { brokerPid: broker.pid, pipeHandleLength: pipeHandle.length, nativeFailure },
              { category: 'team', event: 'team.mcp.windows_peer_unverified', status: 'rejected' },
            );
            this.sendWindowsBrokerFrame(broker, { type: 'close', connectionId });
            return;
          }
          const connection = new WindowsBrokerConnection(connectionId, (message) =>
            this.sendWindowsBrokerFrame(broker, message),
          );
          this.windowsConnections.set(connectionId, connection);
          connection.once('close', () => this.windowsConnections.delete(connectionId));
          this.handleConnection(connection, peerIdentity);
          return;
        }
        const connection = this.windowsConnections.get(connectionId);
        if (connection === undefined) return;
        if (frame['type'] === 'close') connection.remoteClosed();
        else if (frame['type'] === 'data' && typeof frame['data'] === 'string') {
          try {
            connection.receive(Buffer.from(frame['data'], 'base64'));
          } catch {
            connection.destroy();
          }
        }
      });
    });
  }

  private sendWindowsBrokerFrame(
    broker: ChildProcess,
    frame: Readonly<Record<string, unknown>>,
  ): void {
    if (broker.stdin?.writable === true) broker.stdin.write(`${JSON.stringify(frame)}\n`);
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
      skillImportReadStarted: false,
      runtimeProcessIdentity: null,
    });
  }

  bindRuntimeProcess(turnId: string, reported: NativeProcessIdentity): boolean {
    const registration = this.registrations.get(turnId);
    if (registration === undefined) return false;
    const observed = queryNativeProcessIdentity(reported.pid);
    if (observed === null || !sameNativeProcessIdentity(observed, reported)) return false;
    registration.runtimeProcessIdentity = observed;
    return true;
  }

  unregister(turnId: string): void {
    this.registrations.delete(turnId);
  }

  static generateToken(): string {
    return randomBytes(32).toString('hex');
  }

  private handleConnection(
    socket: BridgeConnection,
    peerIdentity: NativeProcessIdentity | null,
  ): void {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    let buffer = '';
    let authenticated = false;
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
        if (line.trim() !== '') void this.handleLine(socket, peerIdentity, line, markAuthenticated);
      }
    });
    socket.on('error', () => socket.destroy());
  }

  private async handleLine(
    socket: BridgeConnection,
    peerIdentity: NativeProcessIdentity | null,
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
    const [, peerRegistration] = found;
    if (
      peerIdentity === null ||
      peerRegistration.runtimeProcessIdentity === null ||
      !isNativeProcessDescendant(peerIdentity, peerRegistration.runtimeProcessIdentity)
    ) {
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
      const allowedTools = new Set<string>(teamMcpToolNamesForCapabilities(registration));
      if (!allowedTools.has(request.tool))
        throw new Error('Tool is not allowed for this Team MCP role');
      if (process.env['SPRINT_CODER_TEAM_MCP_TRACE'] === '1') {
        const teamId = this.coordinator.get(registration.taskId)?.team.id;
        secureLogger.debug(
          'Team MCP tool received',
          { tool: request.tool },
          {
            category: 'team',
            event: 'team.tool.received',
            taskId: registration.taskId,
            turnId,
            ...(teamId === undefined ? {} : { teamId }),
            status: 'received',
          },
        );
      }
      const result =
        request.tool === 'project_memory_remember'
          ? await this.executeProjectMemoryTool(turnId, registration, request.args)
          : request.tool === 'skill_draft_create'
            ? await this.executeSkillDraftTool(turnId, registration, request.args)
            : request.tool === 'skill_import_read'
              ? await this.executeSkillImportReadTool(turnId, registration, request.args)
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
                          request.tool === 'team_wait_reports' ||
                          request.tool === 'team_wait_events',
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
                                }) =>
                                  registration.researchedModels.has(modelSelectionKey(selection)),
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
    const source = parseSkillImportSource(input);
    if (
      registration.authorizedSkillImport === undefined ||
      source.cli !== registration.authorizedSkillImport.cli ||
      source.skillId !== registration.authorizedSkillImport.skillId ||
      source.digest !== registration.authorizedSkillImport.digest
    )
      throw new Error('skill_import_install source was not authorized by skill_import_read');
    delete registration.authorizedSkillImport;
    return this.installPreparedSkill(input, { taskId: registration.taskId, turnId });
  }

  private async executeSkillImportReadTool(
    turnId: string,
    registration: Registered,
    input: unknown,
  ): Promise<unknown> {
    if (
      registration.allowSkillImports !== true ||
      registration.requesterAgentId !== undefined ||
      this.readImportSkillSource === undefined
    )
      throw new Error('skill_import_read is not available for this Turn');
    const source = parseSkillImportReadInput(input);
    if (!userConfirmedSkillImport(registration.skillImportUserText, source))
      throw new Error('skill_import_read requires the user to name the CLI and Skill together');
    if (registration.skillImportReadStarted)
      throw new Error('skill_import_read authorization was already consumed for this Turn');
    registration.skillImportReadStarted = true;
    const result = await this.readImportSkillSource(input, {
      taskId: registration.taskId,
      turnId,
    });
    const digest = readDigest(result);
    registration.authorizedSkillImport = { ...source, digest };
    return result;
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
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.windowsConnections.clear();
    this.windowsBroker?.kill();
    this.windowsBroker = null;
    if (server === null) return;
    // net.Server.close waits for every accepted connection. Claude/Codex may keep an authenticated
    // bridge socket open after a completed turn, so destroy those sockets before waiting or app
    // quit can hang indefinitely.
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
