import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  accessSync,
  constants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { PublicError } from '@sprint-coder/contracts';
import desktopPackage from '../../package.json';
import type {
  CodexModelOption,
  EffortOption,
  RuntimeWriteScope,
  TurnStage,
} from '@sprint-coder/contracts';
import type { ToolCatalogSnapshot } from '@sprint-coder/domain';
import type {
  RuntimeCanonicalEvent,
  RuntimeCodexConfigPolicy,
  RuntimeContextFragment,
  RuntimeFailureDiagnostic,
  RuntimeFailureStage,
  RuntimeProjectContextItem,
  ResolvedCliCommand,
  RuntimeSkillInput,
  RuntimeTeamMcpOption,
  RuntimeWorkspaceSet,
} from './protocol';
import { runtimeWorkspaceSetFromLegacyPath } from './protocol';
import { RUNTIME_AUTH_PROBE_TIMEOUT_MS, RUNTIME_VERSION_PROBE_TIMEOUT_MS } from './probe-budget';
import { teamMcpNodeCommand } from './team-mcp-node-command';
import { TEAM_MCP_SERVER_SOURCE } from './team-mcp-server-source';
import type { TeamMcpToolName } from './team-mcp-tool-contract';
import { terminateRuntimeProcessTree } from './process-tree';
import { serializeCliExecutionPayload } from './execution-payload';
import { probeCliAuthentication } from './authentication-probe';
import {
  RUNTIME_FIRST_EVENT_TIMEOUT_MS,
  RUNTIME_IDLE_TIMEOUT_MS,
  RuntimeProgressDeadline,
  type RuntimeProgressTimeoutPhase,
} from './runtime-progress-deadline';
import { RuntimeFailureDiagnosticCollector } from './runtime-failure-diagnostics';
import {
  environmentValue,
  probeCliCommandCandidates,
  type CliCommandCandidate,
} from './cli-command-resolution';
import {
  CodexUserConfigSnapshotError,
  codexSkillIsolationArgs,
  enforceCodexSkillIsolation,
  prepareCodexSkillIsolation,
  type CodexSkillIsolation,
} from './codex-skill-isolation';

type ActiveProcess = {
  child: ChildProcessWithoutNullStreams;
  canceled: boolean;
  cleanup: () => void;
  rejectPending: (error: Error) => void;
  releaseLocalImages: () => void;
};
type EmitEvent = (event: RuntimeCanonicalEvent) => void;
type EmitError = (error: PublicError, diagnostic?: RuntimeFailureDiagnostic) => void;
type InvokeManagedTool = (input: {
  callId: string;
  toolName: string;
  arguments: unknown;
  catalogDigest: string;
}) => Promise<{ success: boolean; output: unknown }>;
export type CodexLocalImagePreparation = Readonly<{
  paths: readonly string[];
  beforeTurnStart: () => Promise<void>;
  release: () => Promise<void>;
}>;

export type CodexProbe = {
  available: boolean;
  readiness: 'ready' | 'authentication_required' | 'unavailable';
  version?: string;
  cli?: ResolvedCliCommand;
  models: CodexModelOption[];
};

const CODEX_CLI_REFERENCE = 'https://developers.openai.com/codex/cli/reference';
const CODEX_MODEL_CACHE_REFERENCE = 'Codex CLI models_cache.json';
const unknownCapability = { value: null, source: 'unknown' as const };
const codexRuntimeCapability = (value: boolean, sourceReference: string) => ({
  value,
  source: 'runtime_metadata' as const,
  sourceReference,
});

const CODEX_AUTO_MODEL: CodexModelOption = {
  id: 'auto',
  displayName: 'Auto',
  description: 'Codexの既定モデルを使用',
  capabilities: {
    toolCalling: codexRuntimeCapability(true, CODEX_CLI_REFERENCE),
    structuredOutput: codexRuntimeCapability(true, CODEX_CLI_REFERENCE),
    multimodalInput: unknownCapability,
    reasoning: unknownCapability,
  },
};

const E2E_CODEX_MODELS: CodexModelOption[] = [
  CODEX_AUTO_MODEL,
  {
    id: 'gpt-5.6-terra',
    displayName: 'GPT-5.6-Terra',
    description: 'E2E用のCodexモデルfixture',
    defaultEffort: 'medium',
    efforts: [
      { id: 'low', description: '軽量な推論' },
      { id: 'medium', description: '標準的な推論' },
      { id: 'high', description: '深い推論' },
      { id: 'xhigh', description: 'より深い推論' },
    ],
    capabilities: {
      toolCalling: codexRuntimeCapability(true, CODEX_CLI_REFERENCE),
      structuredOutput: codexRuntimeCapability(true, CODEX_CLI_REFERENCE),
      multimodalInput: codexRuntimeCapability(true, CODEX_MODEL_CACHE_REFERENCE),
      reasoning: codexRuntimeCapability(true, CODEX_MODEL_CACHE_REFERENCE),
    },
  },
];

export async function probeCodex(
  command = 'codex',
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): Promise<CodexProbe> {
  // Packaged E2E exercises model selection without executing the real CLI. CI runners deliberately
  // have no Codex installation or credentials, so expose a deterministic catalog only to the
  // isolated E2E process. Adapter execution remains untouched and would still fail closed.
  if (environment['SPRINT_CODER_E2E_CLI_FIXTURES'] === '1') {
    return {
      available: true,
      readiness: 'ready',
      version: 'e2e-fixture',
      models: E2E_CODEX_MODELS,
    };
  }
  const cli = await probeCliCommandCandidates({
    kind: 'codex',
    candidates: resolveCodexCommandCandidates(command, environment),
    environment: minimalEnvironment(environment),
    timeoutMs: RUNTIME_VERSION_PROBE_TIMEOUT_MS,
  });
  const availability: Omit<CodexProbe, 'models' | 'readiness'> =
    cli === null ? { available: false } : { available: true, version: cli.version, cli };
  const authentication = availability.available
    ? await probeCliAuthentication(
        'codex',
        cli!.executable,
        ['login', 'status'],
        minimalEnvironment(environment),
        RUNTIME_AUTH_PROBE_TIMEOUT_MS,
      )
    : 'unknown';
  return {
    ...availability,
    readiness: !availability.available
      ? 'unavailable'
      : authentication === 'unauthenticated'
        ? 'authentication_required'
        : 'ready',
    models: availability.available ? readCodexModels() : [],
  };
}

export class CodexRuntimeAdapter {
  private readonly active = new Map<string, ActiveProcess>();
  private cliVersion: string | null = null;
  private cli: ResolvedCliCommand | null = null;

  constructor(
    private readonly timeoutMs = 10 * 60_000,
    private readonly command = 'codex',
    private readonly commandPrefixArgs: readonly string[] = [],
    private readonly isolationRoot = tmpdir(),
  ) {}

  setCliVersion(version: string | null): void {
    this.cliVersion = version;
  }

  setCliResolution(cli: ResolvedCliCommand | null): void {
    this.cli = cli;
  }

  start(
    turnId: string,
    input: string,
    contextFragments: readonly RuntimeContextFragment[],
    accepted: () => void,
    workspaceInput: RuntimeWorkspaceSet | string | null,
    model: string,
    emit: EmitEvent,
    fail: EmitError,
    exited: (code: number, canceled: boolean) => void,
    teamMcp?: RuntimeTeamMcpOption,
    // The reasoning level for this turn, already clamped by Main to something the selected model
    // advertises (issue #6). There is no `--effort` flag on this CLI, but `-c
    // model_reasoning_effort=` works — see buildCodexArgs.
    effort?: string,
    writeScope: RuntimeWriteScope = 'read-only',
    skills: readonly RuntimeSkillInput[] = [],
    projectItems: readonly RuntimeProjectContextItem[] = [],
    serializedPayload?: string,
    localImages?: CodexLocalImagePreparation,
    codexConfigPolicy: RuntimeCodexConfigPolicy = { inheritUserConfig: false },
    runtimeProcessStarted?: (pid: number) => void,
    toolCatalogSnapshot?: ToolCatalogSnapshot,
    invokeManagedTool?: InvokeManagedTool,
  ): void {
    let localImageReleasePromise: Promise<void> | null = null;
    const releaseLocalImages = (): Promise<void> => {
      if (localImageReleasePromise === null)
        localImageReleasePromise = (localImages?.release() ?? Promise.resolve()).catch(
          () => undefined,
        );
      return localImageReleasePromise;
    };
    if (this.active.has(turnId)) {
      void releaseLocalImages();
      fail(publicError('RUNTIME_FAILED', 'このTurnはすでに実行中です。', false));
      return;
    }
    const diagnostics = new RuntimeFailureDiagnosticCollector(
      'codex',
      desktopPackage.version,
      this.cliVersion,
      teamMcp !== undefined,
    );
    diagnostics.setCliResolution(this.cli);
    const failWithDiagnostic = (error: PublicError, stage: RuntimeFailureStage): void =>
      fail(error, diagnostics.snapshot(stage));
    let temporaryDirectory: string | null = null;
    let teamMcpDirectory: string | null = null;
    let skillIsolationDirectory: string | null = null;
    const cleanupPaths = (): void => {
      for (const path of [temporaryDirectory, teamMcpDirectory, skillIsolationDirectory]) {
        if (path === null) continue;
        try {
          rmSync(path, { recursive: true, force: true });
        } catch {
          // Cleanup failure must not hide the Runtime failure that triggered it.
        }
      }
    };
    let prepared: {
      cwd: string;
      runtimeWorkspaceRoots: string[];
      multiRoot: boolean;
      primaryRootPresent: boolean;
      teamMcpProfile: CodexTeamMcpProfile | undefined;
      skillIsolation: CodexSkillIsolation;
    };
    try {
      const workspace =
        typeof workspaceInput === 'string' || workspaceInput === null
          ? runtimeWorkspaceSetFromLegacyPath(workspaceInput)
          : workspaceInput;
      const primaryRoot = workspace.roots.find(({ rootId }) => rootId === workspace.primaryRootId);
      const cwd =
        primaryRoot?.path ??
        (temporaryDirectory = mkdtempSync(join(tmpdir(), 'sprint-coder-codex-')));
      const runtimeWorkspaceRoots = workspace.roots.map(({ path }) => path);
      mkdirSync(this.isolationRoot, { recursive: true, mode: 0o700 });
      skillIsolationDirectory = mkdtempSync(join(this.isolationRoot, 'turn-'));
      const skillIsolation = prepareCodexSkillIsolation({
        temporaryRoot: skillIsolationDirectory,
        cwd,
        runtimeWorkspaceRoots,
        skills,
        configPolicy: codexConfigPolicy,
      });
      let teamMcpProfile: CodexTeamMcpProfile | undefined;
      if (teamMcp !== undefined) {
        const nodeCommand = teamMcpNodeCommand();
        teamMcpDirectory = mkdtempSync(join(tmpdir(), 'sprint-coder-codex-mcp-'));
        const scriptPath = join(teamMcpDirectory, 'team-mcp-server.cjs');
        writeFileSync(scriptPath, TEAM_MCP_SERVER_SOURCE, { mode: 0o600 });
        teamMcpProfile = {
          command: nodeCommand,
          scriptPath,
          toolNames: teamMcp.toolNames,
          enableWebSearch: teamMcp.enableWebSearch === true,
        };
      }
      prepared = {
        cwd,
        runtimeWorkspaceRoots,
        multiRoot: runtimeWorkspaceRoots.length > 1,
        primaryRootPresent: primaryRoot !== undefined,
        teamMcpProfile,
        skillIsolation,
      };
      diagnostics.recordCodexIsolation({
        userConfigSnapshot: skillIsolation.userConfigSnapshot,
        selectedSkillCount: skillIsolation.stagedSkills.length,
        disabledUnexpectedSkillCount: 0,
        verified: false,
      });
    } catch (error) {
      void releaseLocalImages();
      cleanupPaths();
      failWithDiagnostic(
        publicError(
          'RUNTIME_FAILED',
          error instanceof CodexUserConfigSnapshotError
            ? 'Codexユーザーconfig.tomlを隔離環境へ読み込めませんでした。設定を確認してください。'
            : 'Codex app-serverを準備できませんでした。',
          false,
        ),
        'startup_error',
      );
      return;
    }
    const {
      cwd,
      runtimeWorkspaceRoots,
      multiRoot,
      primaryRootPresent,
      teamMcpProfile,
      skillIsolation,
    } = prepared;
    // No Workspace means the cwd is a throwaway temp directory, so a write scope there would
    // produce edits the user can never see. Main already refuses to send anything but 'read-only'
    // in that case; this is the adapter refusing independently, so the two would have to fail
    // together for a write to escape.
    const effectiveScope: RuntimeWriteScope = primaryRootPresent ? writeScope : 'read-only';
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(
        this.cli?.executable ?? resolveCodexCommand(this.command),
        [
          ...this.commandPrefixArgs,
          ...buildCodexArgs(model, effort, effectiveScope, teamMcpProfile, skillIsolation),
        ],
        {
          cwd,
          env: {
            ...minimalEnvironment(),
            CODEX_HOME: skillIsolation.codexHome,
            HOME: skillIsolation.isolatedUserHome,
            USERPROFILE: skillIsolation.isolatedUserHome,
            ...(teamMcp === undefined
              ? {}
              : {
                  TEAM_BRIDGE_SOCKET: teamMcp.socketPath,
                  TEAM_BRIDGE_TOKEN: teamMcp.token,
                }),
          },
          detached: process.platform !== 'win32',
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
    } catch {
      void releaseLocalImages();
      cleanupPaths();
      failWithDiagnostic(
        publicError('RUNTIME_FAILED', 'Codex runtimeを起動できませんでした。', false),
        'spawn_error',
      );
      return;
    }
    if (teamMcp !== undefined)
      child.once('spawn', () => {
        if (child.pid === undefined) throw new Error('Codex runtime process id is unavailable');
        runtimeProcessStarted?.(child.pid);
        if (localImages === undefined) accepted();
      });
    let nextRequestId = 1;
    const pending = new Map<
      number,
      {
        resolve: (result: unknown) => void;
        reject: (error: Error) => void;
      }
    >();
    const rejectPending = (error: Error): void => {
      for (const request of pending.values()) request.reject(error);
      pending.clear();
    };
    const cleanup = (): void => {
      void releaseLocalImages();
      cleanupPaths();
    };
    const control: ActiveProcess = {
      child,
      canceled: false,
      cleanup,
      rejectPending,
      releaseLocalImages: () => void releaseLocalImages(),
    };
    this.active.set(turnId, control);

    const bufferedEvents: RuntimeCanonicalEvent[] = [];
    let bufferedEventBytes = 0;
    let imagesAccepted = false;
    const emitRuntime: EmitEvent =
      localImages === undefined
        ? emit
        : (event) => {
            if (imagesAccepted) emit(event);
            else {
              const byteLength = Buffer.byteLength(JSON.stringify(event), 'utf8');
              if (bufferedEvents.length >= 256 || bufferedEventBytes + byteLength > 1024 * 1024)
                throw new Error('Codex pre-accept event buffer overflow');
              bufferedEvents.push(event);
              bufferedEventBytes += byteLength;
            }
          };
    if (localImages === undefined && teamMcp === undefined) accepted();

    let failed = false;
    let sawCompletion = false;
    let stageIndex = -1;
    const assistantMessageId = randomUUID();
    const agentMessageBoundary = new CodexAgentMessageBoundary();
    let skillIsolationReady = false;
    let skillIsolationVerificationPending = false;
    let teamDynamicTools: readonly CodexDynamicToolSpec[] = [];
    const managedDynamicTools =
      toolCatalogSnapshot === undefined ? [] : buildCodexManagedDynamicTools(toolCatalogSnapshot);
    const managedMode = toolCatalogSnapshot !== undefined;
    let activeThreadId: string | null = null;
    const send = (method: string, params: unknown): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const id = nextRequestId++;
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    const sendResponse = (id: number | string, result: unknown): void => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
    };
    const effectiveTimeoutMs = teamMcp === undefined ? this.timeoutMs : 60 * 60_000;
    const deadline = new RuntimeProgressDeadline(
      {
        firstEventMs: RUNTIME_FIRST_EVENT_TIMEOUT_MS,
        idleMs: RUNTIME_IDLE_TIMEOUT_MS,
        totalMs: effectiveTimeoutMs,
      },
      (phase) => {
        if (!failed && !control.canceled) {
          failed = true;
          failWithDiagnostic(
            publicError('RUNTIME_TIMEOUT', codexTimeoutMessage(phase), true),
            `${phase}_timeout`,
          );
        }
        rejectPending(new Error('Codex runtime timed out'));
        void releaseLocalImages();
        void terminateCodexProcessTree(child);
      },
    );
    deadline.start();

    createInterface({ input: child.stdout }).on('line', (line) => {
      if (failed || control.canceled || line.trim() === '') return;
      deadline.progress();
      try {
        const message = JSON.parse(line) as Record<string, unknown>;
        if (typeof message['id'] === 'number' && !('method' in message)) {
          const request = pending.get(message['id']);
          if (request !== undefined) {
            pending.delete(message['id']);
            if ('error' in message)
              request.reject(new Error(appServerErrorMessage(message['error'])));
            else request.resolve(message['result']);
          }
          return;
        }
        if (
          (typeof message['id'] === 'number' || typeof message['id'] === 'string') &&
          typeof message['method'] === 'string'
        ) {
          if (
            message['method'] === 'item/tool/call' &&
            (teamMcp !== undefined || managedDynamicTools.length > 0)
          ) {
            const responseId = message['id'];
            void (async () => {
              const canRespond = (): boolean =>
                !failed &&
                !control.canceled &&
                !child.stdin.destroyed &&
                !child.stdin.writableEnded &&
                this.active.get(turnId) === control;
              try {
                const params = asRecord(message['params']);
                const tool = requiredString(params['tool'], 'dynamic tool name');
                const threadId = requiredString(params['threadId'], 'dynamic tool thread id');
                requiredString(params['turnId'], 'dynamic tool turn id');
                requiredString(params['callId'], 'dynamic tool call id');
                if (params['namespace'] !== null || threadId !== activeThreadId)
                  throw new Error('Unexpected dynamic tool identity');
                const managed = managedDynamicTools.some(({ name }) => name === tool);
                let response: ReturnType<typeof codexDynamicToolResponseFromMcp>;
                if (managed) {
                  if (invokeManagedTool === undefined || toolCatalogSnapshot === undefined)
                    throw new Error('Managed tool bridge is unavailable');
                  const result = await invokeManagedTool({
                    callId: requiredString(params['callId'], 'dynamic tool call id'),
                    toolName: tool,
                    arguments: params['arguments'],
                    catalogDigest: toolCatalogSnapshot.digest,
                  });
                  response = {
                    success: result.success,
                    contentItems: [
                      {
                        type: 'inputText',
                        text: JSON.stringify(result.output ?? null).slice(0, 1024 * 1024),
                      },
                    ],
                  };
                } else {
                  if (teamMcp === undefined || !teamMcp.toolNames.includes(tool as TeamMcpToolName))
                    throw new Error('Unexpected dynamic Team tool');
                  const result = await send('mcpServer/tool/call', {
                    server: 'team',
                    threadId,
                    tool,
                    arguments: params['arguments'],
                  });
                  response = codexDynamicToolResponseFromMcp(result);
                }
                if (!canRespond()) return;
                sendResponse(responseId, response);
              } catch {
                if (!canRespond()) return;
                sendResponse(responseId, {
                  success: false,
                  contentItems: [{ type: 'inputText', text: 'Team tool failed.' }],
                });
              }
            })();
            return;
          }
          respondToCodexRequest(message['method'], message['id'], sendResponse);
          return;
        }
        if (typeof message['method'] === 'string')
          diagnostics.recordNotification(message['method']);
        if (
          message['method'] === 'skills/changed' &&
          skillIsolationReady &&
          !skillIsolationVerificationPending
        ) {
          skillIsolationVerificationPending = true;
          void enforceCodexSkillIsolation(send, skillIsolation)
            .then((disabledUnexpectedSkills) => {
              diagnostics.recordCodexIsolation({
                userConfigSnapshot: skillIsolation.userConfigSnapshot,
                selectedSkillCount: skillIsolation.stagedSkills.length,
                disabledUnexpectedSkillCount: disabledUnexpectedSkills.length,
                verified: true,
              });
            })
            .catch(() => {
              if (failed || control.canceled) return;
              failed = true;
              failWithDiagnostic(
                publicError(
                  'RUNTIME_FAILED',
                  'Codex CLIのSkill隔離を維持できなかったため、このTurnを停止しました。',
                  false,
                ),
                'protocol_error',
              );
              void terminateCodexProcessTree(child);
            })
            .finally(() => {
              skillIsolationVerificationPending = false;
            });
        }
        handleCodexNotification(
          message,
          emitRuntime,
          assistantMessageId,
          agentMessageBoundary,
          (stage) => {
            stageIndex = advanceCodexAppServerStage(stageIndex, stage, emitRuntime);
          },
          () => {
            sawCompletion = true;
            child.stdin.end();
          },
          managedMode,
        );
      } catch {
        failed = true;
        rejectPending(new Error('Codex app-server protocol failed'));
        void releaseLocalImages();
        failWithDiagnostic(
          publicError(
            'RUNTIME_PROTOCOL_ERROR',
            'Codex app-serverの出力を解釈できませんでした。',
            false,
          ),
          'protocol_error',
        );
        void terminateCodexProcessTree(child);
      }
    });
    void (async () => {
      try {
        await send('initialize', {
          clientInfo: {
            name: 'sprint-coder',
            title: 'Sprint Coder',
            version: desktopPackage.version,
          },
          // Multi-root and client-hosted dynamic Team tools are both gated by the app-server's
          // experimentalApi client capability. The latter is required even though dynamicTools is
          // present in the generated v2 schema.
          capabilities: codexInitializeCapabilities(
            multiRoot,
            teamMcp !== undefined || managedDynamicTools.length > 0,
          ),
        });
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`,
        );
        if (teamMcp !== undefined) {
          // Force Codex to initialize and inventory the pinned per-turn MCP before committing the
          // thread's model-visible tool snapshot. Without this request a short Team turn can reach
          // the model before the ephemeral server has been recognized.
          const inventoryResponse = await send('mcpServerStatus/list', {
            cursor: null,
            detail: 'toolsAndAuthOnly',
            limit: 100,
            threadId: null,
          });
          const inventory = validateCodexTeamMcpInventory(inventoryResponse, teamMcp.toolNames);
          if (!inventory.ok) throw new CodexTeamMcpUnavailableError();
          teamDynamicTools = buildCodexTeamDynamicTools(inventoryResponse, teamMcp.toolNames);
        }
        await send('skills/extraRoots/set', {
          extraRoots: [skillIsolation.selectedSkillsRoot],
        });
        const disabledUnexpectedSkills = await enforceCodexSkillIsolation(send, skillIsolation);
        diagnostics.recordCodexIsolation({
          userConfigSnapshot: skillIsolation.userConfigSnapshot,
          selectedSkillCount: skillIsolation.stagedSkills.length,
          disabledUnexpectedSkillCount: disabledUnexpectedSkills.length,
          verified: true,
        });
        skillIsolationReady = true;
        const threadResult = asRecord(
          await send('thread/start', {
            cwd,
            ...(multiRoot ? { runtimeWorkspaceRoots } : {}),
            approvalPolicy: 'never',
            sandbox: managedMode ? 'read-only' : CODEX_SANDBOX_BY_SCOPE[effectiveScope],
            ...(managedMode ? { environments: [] } : {}),
            ephemeral: true,
            ...(teamDynamicTools.length + managedDynamicTools.length === 0
              ? {}
              : { dynamicTools: [...managedDynamicTools, ...teamDynamicTools] }),
            ...(model === 'auto' ? {} : { model }),
          }),
        );
        const thread = asRecord(threadResult['thread']);
        const threadId = requiredString(thread['id'], 'thread id');
        activeThreadId = threadId;
        emitRuntime({ type: 'thread', threadId });
        await localImages?.beforeTurnStart();
        await send('turn/start', {
          threadId,
          input: buildCodexTurnInput(
            serializedPayload ??
              buildCodexPrompt(input, contextFragments, teamMcp?.guidance, skills, projectItems),
            skillIsolation.stagedSkills,
            localImages?.paths ?? [],
          ),
          ...(multiRoot ? { cwd, runtimeWorkspaceRoots } : {}),
          ...(effort === undefined || effort === '' ? {} : { effort }),
        });
        if (localImages !== undefined) {
          accepted();
          imagesAccepted = true;
          for (const event of bufferedEvents) emit(event);
          bufferedEvents.length = 0;
          bufferedEventBytes = 0;
        }
      } catch (error) {
        if (failed || control.canceled) return;
        failed = true;
        failWithDiagnostic(
          multiRoot && isUnsupportedMultiRootError(error)
            ? publicError(
                'RUNTIME_FAILED',
                'このCodex CLIは複数フォルダに対応していません。Codexを更新してから再試行してください。',
                false,
              )
            : publicError(
                'RUNTIME_FAILED',
                error instanceof CodexTeamMcpUnavailableError
                  ? 'CodexがSprint Coder Team MCPの必須ツールを確認できないため、Turn開始前に停止しました。'
                  : codexConfigPolicy.inheritUserConfig
                    ? 'Codexユーザーconfig.tomlを含む隔離環境を開始できませんでした。configを確認してください。'
                    : 'Codex app-serverを開始できませんでした。',
                !(error instanceof CodexTeamMcpUnavailableError),
              ),
          'startup_error',
        );
        void terminateCodexProcessTree(child);
      } finally {
        await releaseLocalImages();
      }
    })();
    // Record only stderr presence/size metadata. Arbitrary stderr may echo private user content,
    // tool arguments, paths, or credentials, so its text must never cross the Runtime boundary.
    child.stderr.on('data', (chunk: Buffer) => diagnostics.recordStderr(chunk));
    child.once('error', (error) => {
      rejectPending(error);
      void releaseLocalImages();
      if (failed || control.canceled) return;
      failed = true;
      failWithDiagnostic(
        publicError(
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'RUNTIME_CLI_MISSING'
            : 'RUNTIME_FAILED',
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'Codex CLIが見つかりません。'
            : 'Codex runtimeを起動できませんでした。',
          false,
        ),
        'spawn_error',
      );
    });
    child.once('exit', (code) => {
      deadline.stop();
      rejectPending(new Error('Codex runtime exited'));
      void releaseLocalImages();
      this.active.delete(turnId);
      cleanup();
      const exitCode = code ?? -1;
      if (!control.canceled && !failed && (exitCode !== 0 || !sawCompletion)) {
        failed = true;
        failWithDiagnostic(
          publicError('RUNTIME_FAILED', 'Codex runtimeが正常に完了しませんでした。', true),
          'abnormal_exit',
        );
      }
      exited(exitCode, control.canceled);
    });
  }

  async cancel(turnId: string): Promise<boolean> {
    const control = this.active.get(turnId);
    if (control === undefined) return false;
    control.canceled = true;
    control.rejectPending(new Error('Codex runtime canceled'));
    control.releaseLocalImages();
    return !(await terminateCodexProcessTree(control.child));
  }

  dispose(): void {
    for (const [turnId] of this.active) void this.cancel(turnId);
  }
}

function codexTimeoutMessage(phase: RuntimeProgressTimeoutPhase): string {
  if (phase === 'first_event')
    return 'Codex runtimeから45秒間応答がなかったため、このTurnを終了しました。接続とCLI実行環境を確認して、もう一度お試しください。';
  if (phase === 'idle')
    return 'Codex runtimeから90秒間新しい応答がなかったため、このTurnを終了しました。接続状態を確認して、もう一度お試しください。';
  return 'Codex runtimeがタイムアウトしました。';
}

export function buildCodexTurnInput(
  text: string,
  skills: readonly RuntimeSkillInput[],
  localImagePaths: readonly string[],
): Array<
  | { type: 'text'; text: string }
  | { type: 'localImage'; path: string }
  | { type: 'skill'; name: string; path: string }
> {
  return [
    { type: 'text', text },
    ...localImagePaths.map((path) => ({ type: 'localImage' as const, path })),
    ...skills.map((skill) => ({ type: 'skill' as const, name: skill.name, path: skill.path })),
  ];
}

export function isUnsupportedMultiRootError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /experimentalApi|runtimeWorkspaceRoots|experimental|invalid (?:params|field)|unknown field/i.test(
    message,
  );
}

function handleCodexNotification(
  message: Record<string, unknown>,
  emit: EmitEvent,
  assistantMessageId: string,
  agentMessageBoundary: CodexAgentMessageBoundary,
  advanceStage: (stage: TurnStage) => void,
  completed: () => void,
  managedMode = false,
): void {
  const method = message['method'];
  if (typeof method !== 'string') return;
  const params = asRecord(message['params']);
  if (method === 'turn/started') {
    advanceStage('understanding');
    return;
  }
  if (method === 'item/agentMessage/delta') {
    advanceStage('synthesizing');
    const itemId = requiredString(params['itemId'], 'agent message item id');
    emit({
      type: 'delta',
      messageId: assistantMessageId,
      delta: agentMessageBoundary.push(itemId, requiredString(params['delta'], 'message delta')),
    });
    return;
  }
  if (method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta') {
    advanceStage('planning');
    emit({ type: 'reasoning', text: requiredString(params['delta'], 'reasoning delta') });
    return;
  }
  if (method === 'item/started') {
    const item = asRecord(params['item']);
    if (managedMode && (item['type'] === 'commandExecution' || item['type'] === 'fileChange'))
      throw new Error('Codex attempted to bypass the Managed Coding Harness');
    const operation = codexOperationForItem(item, 'started');
    if (operation !== null) {
      advanceStage('executing');
      emit(operation);
    }
    return;
  }
  if (method === 'item/completed') {
    const item = asRecord(params['item']);
    if (managedMode && (item['type'] === 'commandExecution' || item['type'] === 'fileChange'))
      throw new Error('Codex attempted to bypass the Managed Coding Harness');
    const operation = codexOperationForItem(item, 'completed');
    if (operation !== null) {
      advanceStage('executing');
      emit(operation);
    }
    if (item['type'] === 'fileChange' && Array.isArray(item['changes'])) {
      advanceStage('executing');
      const changes = item['changes']
        .map((change) => asRecord(change))
        .filter(
          (change) =>
            typeof change['path'] === 'string' &&
            (change['kind'] === 'add' ||
              change['kind'] === 'update' ||
              change['kind'] === 'delete'),
        )
        .map((change) => ({
          path: change['path'] as string,
          kind: change['kind'] as 'add' | 'update' | 'delete',
        }));
      if (changes.length > 0) emit({ type: 'fileChange', changes });
    }
    return;
  }
  if (method === 'turn/completed') {
    const turn = asRecord(params['turn']);
    if (turn['status'] !== 'completed')
      throw new Error(`Codex turn failed with status ${String(turn['status'])}`);
    advanceStage('synthesizing');
    const finalText = agentMessageBoundary.finalText();
    emit(finalText === null ? { type: 'completed' } : { type: 'completed', finalText });
    completed();
  }
}

const CODEX_TOOL_ITEM_TYPES = new Set([
  'mcpToolCall',
  'dynamicToolCall',
  'collabAgentToolCall',
  'webSearch',
  'imageGeneration',
]);

export function codexOperationForItem(
  item: Record<string, unknown>,
  timing: 'started' | 'completed',
): Extract<RuntimeCanonicalEvent, { type: 'operation' }> | null {
  if (item['type'] === 'commandExecution')
    return {
      type: 'operation',
      phase: timing === 'started' ? 'command_start' : 'command_end',
      label: timing === 'started' ? 'Codex command started' : 'Codex command finished',
      sideEffect: false,
    };
  if (typeof item['type'] !== 'string' || !CODEX_TOOL_ITEM_TYPES.has(item['type'])) return null;
  const toolName = typeof item['tool'] === 'string' ? ` (${item['tool']})` : '';
  return {
    type: 'operation',
    phase: timing === 'started' ? 'tool_call_start' : 'tool_call_end',
    sideEffect:
      item['type'] === 'mcpToolCall' ||
      item['type'] === 'collabAgentToolCall' ||
      item['type'] === 'imageGeneration',
    label:
      timing === 'started'
        ? `Codex tool call started${toolName}`
        : `Codex tool call finished${toolName}`,
  };
}

/**
 * Codex streams each commentary/final assistant message as its own `agentMessage` item. Chunks
 * within one item are token continuations, while a new item is a new semantic paragraph. Sprint
 * Coder persists one assistant message per Turn, so preserve that item boundary as Markdown's
 * paragraph separator instead of flattening every progress update into one wall of text.
 */
export class CodexAgentMessageBoundary {
  private activeItemId: string | null = null;
  private activeText = '';

  push(itemId: string, delta: string): string {
    const changedItem = this.activeItemId !== null && this.activeItemId !== itemId;
    const separated = changedItem ? `\n\n${delta}` : delta;
    this.activeText = changedItem ? delta : `${this.activeText}${delta}`;
    this.activeItemId = itemId;
    return separated;
  }

  finalText(): string | null {
    return this.activeText.length === 0 ? null : this.activeText;
  }
}

const CODEX_APP_SERVER_STAGES: readonly TurnStage[] = [
  'understanding',
  'planning',
  'executing',
  'synthesizing',
];

export function advanceCodexAppServerStage(
  currentIndex: number,
  target: TurnStage,
  emit: EmitEvent,
): number {
  const targetIndex = CODEX_APP_SERVER_STAGES.indexOf(target);
  for (let index = currentIndex + 1; index <= targetIndex; index += 1) {
    const stage = CODEX_APP_SERVER_STAGES[index];
    if (stage !== undefined) emit({ type: 'stage', stage });
  }
  return Math.max(currentIndex, targetIndex);
}

function respondToCodexRequest(
  method: string,
  id: number | string,
  respond: (id: number | string, result: unknown) => void,
): void {
  if (
    method === 'item/commandExecution/requestApproval' ||
    method === 'item/fileChange/requestApproval' ||
    method === 'execCommandApproval' ||
    method === 'applyPatchApproval'
  ) {
    respond(id, { decision: 'decline' });
    return;
  }
  if (method === 'mcpServer/elicitation/request') {
    respond(id, { action: 'decline', content: null });
    return;
  }
  if (method === 'item/permissions/requestApproval') {
    respond(id, { permissions: {} });
    return;
  }
  if (method === 'item/tool/requestUserInput') {
    respond(id, { answers: {} });
    return;
  }
  respond(id, { success: false, contentItems: [] });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new Error('Expected object');
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`Missing ${label}`);
  return value;
}

function appServerErrorMessage(value: unknown): string {
  if (typeof value !== 'object' || value === null) return 'Unknown app-server error';
  const message = (value as Record<string, unknown>)['message'];
  return typeof message === 'string' ? message : 'Unknown app-server error';
}

export function buildCodexPrompt(
  input: string,
  contextFragments: readonly RuntimeContextFragment[],
  teamGuidance?: string,
  skills: readonly RuntimeSkillInput[] = [],
  projectItems: readonly RuntimeProjectContextItem[] = [],
): string {
  return serializeCliExecutionPayload({
    kind: 'codex',
    request: input,
    contextFragments,
    projectItems,
    ...(teamGuidance === undefined ? {} : { teamGuidance }),
    skills,
  }).text;
}

export type CodexTeamMcpProfile = Readonly<{
  command: string;
  scriptPath: string;
  toolNames: readonly TeamMcpToolName[];
  enableWebSearch?: boolean;
}>;

export type CodexTeamMcpInventoryValidation = Readonly<{
  ok: boolean;
  serverFound: boolean;
  missingTools: readonly string[];
}>;

export type CodexDynamicToolSpec = Readonly<{
  type: 'function';
  name: string;
  description: string;
  inputSchema: unknown;
  deferLoading: false;
}>;

export function buildCodexManagedDynamicTools(
  snapshot: ToolCatalogSnapshot,
): CodexDynamicToolSpec[] {
  const names = new Set<string>();
  return snapshot.entries.map((entry) => {
    if (names.has(entry.providerName)) throw new Error('Duplicate managed dynamic tool name');
    names.add(entry.providerName);
    return {
      type: 'function',
      name: entry.providerName,
      description: `Sprint Coder managed ${entry.kind} tool: ${entry.providerName}`,
      inputSchema: JSON.parse(JSON.stringify(entry.inputSchema)) as unknown,
      deferLoading: false,
    };
  });
}

export function codexInitializeCapabilities(
  multiRoot: boolean,
  teamMcpEnabled: boolean,
): Record<string, boolean> {
  return multiRoot || teamMcpEnabled ? { experimentalApi: true } : {};
}

export function validateCodexTeamMcpInventory(
  response: unknown,
  expectedTools: readonly TeamMcpToolName[],
): CodexTeamMcpInventoryValidation {
  const data = asRecord(response)['data'];
  const servers = Array.isArray(data) ? data : [];
  const team = servers.find((entry) => asRecord(entry)['name'] === 'team');
  if (team === undefined)
    return { ok: false, serverFound: false, missingTools: [...expectedTools] };
  const tools = asRecord(asRecord(team)['tools']);
  const missingTools = expectedTools.filter((name) => !(name in tools));
  return { ok: missingTools.length === 0, serverFound: true, missingTools };
}

export function buildCodexTeamDynamicTools(
  response: unknown,
  expectedTools: readonly TeamMcpToolName[],
): CodexDynamicToolSpec[] {
  const data = asRecord(response)['data'];
  const servers = Array.isArray(data) ? data : [];
  const team = servers.find((entry) => asRecord(entry)['name'] === 'team');
  if (team === undefined) return [];
  const tools = asRecord(asRecord(team)['tools']);
  return expectedTools.map((name) => {
    const tool = asRecord(tools[name]);
    return {
      type: 'function',
      name,
      description:
        typeof tool['description'] === 'string'
          ? tool['description']
          : `Sprint Coder Team tool ${name}`,
      inputSchema: tool['inputSchema'] ?? { type: 'object' },
      deferLoading: false,
    };
  });
}

export function codexDynamicToolResponseFromMcp(response: unknown): {
  success: boolean;
  contentItems: { type: 'inputText'; text: string }[];
} {
  const result = asRecord(response);
  if (result['isError'] === true)
    return {
      success: false,
      contentItems: [{ type: 'inputText', text: 'Team tool failed.' }],
    };
  const content = Array.isArray(result['content']) ? result['content'] : [];
  const text = content
    .map((item) => asRecord(item))
    .filter((item) => item['type'] === 'text' && typeof item['text'] === 'string')
    .map((item) => item['text'] as string)
    .join('\n')
    .slice(0, 1024 * 1024);
  return {
    success: true,
    contentItems: [
      {
        type: 'inputText',
        text:
          text !== ''
            ? text
            : JSON.stringify(result['structuredContent'] ?? { ok: true }).slice(0, 1024 * 1024),
      },
    ],
  };
}

class CodexTeamMcpUnavailableError extends Error {}

/**
 * The Access preset's write scope as a Codex sandbox mode.
 *
 * These are OS-enforced on macOS (Seatbelt), not advisory: verified 2026-07-25 on codex-cli 0.144.4
 * that `workspace-write` writes inside the cwd and that `read-only` refuses `apply_patch` outright.
 * That is what lets the Codex path be presented as a real boundary rather than as a promise the
 * model is asked to keep.
 */
const CODEX_SANDBOX_BY_SCOPE: Record<RuntimeWriteScope, string> = {
  'read-only': 'read-only',
  'workspace-write': 'workspace-write',
  full: 'danger-full-access',
};

/**
 * `effort` maps to the `model_reasoning_effort` config key via `-c`, the same override mechanism
 * already used for `approval_policy` and `shell_environment_policy.inherit`.
 *
 * There is no `--effort`-equivalent flag (verified: absent from `codex exec --help` on 0.144.4),
 * but the config path works and is the CLI's documented way to override any config.toml value.
 * TOML quoting matters: `-c` parses the value portion as TOML and only falls back to a raw string
 * if that fails, so the level is quoted exactly like the two existing overrides.
 *
 * An empty/undefined effort adds nothing, leaving the CLI's own per-model default — which is the
 * correct behaviour for the `auto` model sentinel, where the concrete model (and therefore its
 * advertised level set) is chosen inside the CLI.
 */
export function buildCodexArgs(
  model: string,
  effort?: string,
  _writeScope: RuntimeWriteScope = 'read-only',
  teamMcp?: CodexTeamMcpProfile,
  skillIsolation?: CodexSkillIsolation,
): string[] {
  return [
    'app-server',
    '--listen',
    'stdio://',
    ...(skillIsolation === undefined ? [] : codexSkillIsolationArgs(skillIsolation)),
    // Stays "never" at every scope. `approval_policy` governs asking the *user* mid-turn, and
    // `codex exec` has no channel to ask on — verified: it is a one-shot stdin invocation, and
    // `on-request` in this mode simply stalls the tool rather than surfacing anything answerable.
    // The sandbox mode above is therefore the entire boundary, which is why it is derived from a
    // validated enum and never from a free-form string.
    '-c',
    'approval_policy="never"',
    // "core" rather than "none": with an empty environment the model's shell has no PATH, so even
    // `sed` fails with "command not found" (observed directly) and the model burns turns
    // rediscovering which tools exist. "core" passes HOME/PATH/USER-class variables and nothing
    // else — secrets in the parent environment still do not reach the model's shell.
    '-c',
    'shell_environment_policy.inherit="core"',
    ...(teamMcp === undefined
      ? []
      : [
          '-c',
          `mcp_servers.team.command=${JSON.stringify(teamMcp.command)}`,
          '-c',
          `mcp_servers.team.args=${JSON.stringify([teamMcp.scriptPath])}`,
          '-c',
          'mcp_servers.team.enabled=true',
          '-c',
          `mcp_servers.team.enabled_tools=${JSON.stringify(teamMcp.toolNames)}`,
          '-c',
          'mcp_servers.team.default_tools_approval_mode="approve"',
          '-c',
          'mcp_servers.team.startup_timeout_sec=10',
          '-c',
          'mcp_servers.team.env_vars=["TEAM_BRIDGE_SOCKET","TEAM_BRIDGE_TOKEN"]',
          // Current Codex versions removed the former tool_search_always_defer_mcp_tools escape
          // hatch. Team turns inventory this pinned server and expose only the expected tools as
          // non-deferred dynamic tools. Do not pass the removed feature override: --strict-config
          // must remain valid across supported CLIs.
          ...(teamMcp.enableWebSearch === true ? ['-c', 'web_search="live"'] : []),
        ]),
    ...(effort === undefined || effort === '' ? [] : ['-c', `model_reasoning_effort="${effort}"`]),
    ...(model === 'auto' ? [] : ['-c', `model="${model}"`]),
  ];
}

/**
 * Reads a model's advertised reasoning levels out of its models_cache.json entry.
 *
 * The CLI publishes `supported_reasoning_levels: [{ effort, description }]` plus
 * `default_reasoning_level` per model, so the effort candidates are data, not a curated guess.
 * They genuinely differ — verified 2026-07-25 against codex-cli 0.144.4's own cache:
 *   GPT-5.6-Sol / GPT-5.6-Terra    low medium high xhigh max ultra
 *   GPT-5.6-Luna                   low medium high xhigh max
 *   GPT-5.5 / 5.4 / 5.4-Mini / 5.3-Codex-Spark
 *                                  low medium high xhigh
 * Offering a level the selected model does not advertise fails the entire turn (API 400 ->
 * `codex exec` exits 1), so a single fixed list would ship a real defect rather than a cosmetic
 * one. Unparseable or absent levels yield `undefined`, which the settings read treats as "no
 * override available" and leaves the CLI's own default in place.
 */
function parseSupportedEfforts(
  record: Record<string, unknown>,
): Pick<CodexModelOption, 'efforts' | 'defaultEffort'> {
  const levels = record['supported_reasoning_levels'];
  if (!Array.isArray(levels)) return {};
  const efforts: EffortOption[] = [];
  const seen = new Set<string>();
  for (const level of levels) {
    if (typeof level !== 'object' || level === null) continue;
    const entry = level as Record<string, unknown>;
    const id = entry['effort'];
    const description = entry['description'];
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    efforts.push({
      id,
      description: typeof description === 'string' ? description.slice(0, 300) : '',
    });
    if (efforts.length === 16) break;
  }
  if (efforts.length === 0) return {};
  const fallback = record['default_reasoning_level'];
  // Only trust the advertised default if it is actually one of the advertised levels — otherwise
  // clamping would substitute a value that fails just as hard as the one it replaced.
  const defaultEffort =
    typeof fallback === 'string' && seen.has(fallback) ? fallback : efforts[0]?.id;
  return defaultEffort === undefined ? { efforts } : { efforts, defaultEffort };
}

function parseCodexModelCapabilities(
  record: Record<string, unknown>,
  efforts: Pick<CodexModelOption, 'efforts' | 'defaultEffort'>,
): NonNullable<CodexModelOption['capabilities']> {
  const modalities = record['input_modalities'];
  const multimodalInput = Array.isArray(modalities)
    ? codexRuntimeCapability(modalities.includes('image'), CODEX_MODEL_CACHE_REFERENCE)
    : unknownCapability;
  return {
    // These are Codex CLI execution-surface capabilities (`tools` and `--output-schema`), while
    // image input and reasoning support are genuinely per-model fields published by the cache.
    toolCalling: codexRuntimeCapability(true, CODEX_CLI_REFERENCE),
    structuredOutput: codexRuntimeCapability(true, CODEX_CLI_REFERENCE),
    multimodalInput,
    reasoning:
      efforts.efforts === undefined
        ? unknownCapability
        : codexRuntimeCapability(true, CODEX_MODEL_CACHE_REFERENCE),
  };
}

export function parseCodexModels(value: unknown): CodexModelOption[] {
  if (typeof value !== 'object' || value === null || !('models' in value)) return [];
  const models = (value as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];
  const result: CodexModelOption[] = [];
  const seen = new Set<string>();
  for (const item of models) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const id = record['slug'];
    const displayName = record['display_name'];
    const description = record['description'];
    if (
      record['visibility'] !== 'list' ||
      typeof id !== 'string' ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(id) ||
      typeof displayName !== 'string' ||
      displayName.length === 0 ||
      displayName.length > 128 ||
      typeof description !== 'string' ||
      description.length > 300 ||
      seen.has(id)
    )
      continue;
    seen.add(id);
    const efforts = parseSupportedEfforts(record);
    result.push({
      id,
      displayName,
      description,
      ...efforts,
      capabilities: parseCodexModelCapabilities(record, efforts),
    });
    if (result.length === 31) break;
  }
  return result;
}

export function readCodexModels(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  userHome: string = homedir(),
): CodexModelOption[] {
  const codexRoot = environment['CODEX_HOME'] ?? join(environment['HOME'] ?? userHome, '.codex');
  try {
    const parsed = JSON.parse(
      readFileSync(join(codexRoot, 'models_cache.json'), 'utf8'),
    ) as unknown;
    return [CODEX_AUTO_MODEL, ...parseCodexModels(parsed)];
  } catch {
    return [CODEX_AUTO_MODEL];
  }
}

export function resolveCodexCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
  searchPath: string | undefined = process.env['PATH'],
  appData: string | null | undefined = process.env['APPDATA'],
  userHome: string = homedir(),
  architecture: NodeJS.Architecture = process.arch,
  localAppData: string | null | undefined = process.env['LOCALAPPDATA'],
): string {
  return (
    resolveCodexCommandCandidates(
      command,
      {
        PATH: searchPath,
        APPDATA: appData ?? undefined,
        HOME: userHome,
        USERPROFILE: userHome,
        LOCALAPPDATA: localAppData ?? undefined,
        PROCESSOR_ARCHITECTURE: architecture,
      },
      platform,
      architecture,
    )[0]?.executable ?? command
  );
}

export function resolveCodexCommandCandidates(
  command: string,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  platform: NodeJS.Platform = process.platform,
  architecture: NodeJS.Architecture = process.arch,
): CliCommandCandidate[] {
  if (command !== 'codex') return [{ executable: command, source: 'explicit' }];
  const searchPath = environmentValue(environment, 'PATH', platform);
  const appData = environmentValue(environment, 'APPDATA', platform);
  const userHome =
    environmentValue(environment, 'HOME', platform) ??
    environmentValue(environment, 'USERPROFILE', platform) ??
    homedir();
  const localAppData = environmentValue(environment, 'LOCALAPPDATA', platform);
  const candidates: CliCommandCandidate[] = [];
  if (platform === 'darwin') {
    const roots = [
      ...(searchPath ?? '').split(delimiter).filter((entry) => entry.length > 0),
      join(userHome, '.local', 'bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
    ];
    for (const root of new Set(roots)) {
      const candidate = join(root, command);
      try {
        // Native installers expose the CLI through a symlink in ~/.local/bin, so follow it.
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, constants.X_OK);
        candidates.push({
          executable: candidate,
          source: root === join(userHome, '.local', 'bin') ? 'user-local' : 'path',
        });
      } catch {
        // Continue through the macOS locations a Finder-launched app does not inherit in PATH.
      }
    }
    return candidates.length === 0 ? [{ executable: command, source: 'fallback' }] : candidates;
  }
  if (platform !== 'win32') return [{ executable: command, source: 'fallback' }];
  candidates.push(...resolveCodexDesktopCandidates(localAppData));
  const packageArchitecture = architecture === 'arm64' ? 'arm64' : 'x64';
  const targetTriple =
    architecture === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  const roots = [
    ...(searchPath ?? '')
      .split(delimiter)
      .map((entry) => entry.trim().replace(/^"(.*)"$/u, '$1'))
      .filter((entry) => entry.length > 0),
    ...(appData == null ? [] : [join(appData, 'npm')]),
    join(userHome, 'AppData', 'Roaming', 'npm'),
  ];
  for (const root of new Set(roots)) {
    for (const candidate of [
      join(root, 'codex.exe'),
      join(
        root,
        'node_modules',
        '@openai',
        'codex',
        'node_modules',
        '@openai',
        `codex-win32-${packageArchitecture}`,
        'vendor',
        targetTriple,
        'bin',
        'codex.exe',
      ),
    ]) {
      try {
        if (lstatSync(candidate).isFile())
          candidates.push({
            executable: candidate,
            source: candidate.includes(`${join('node_modules', '@openai', 'codex')}`)
              ? 'npm'
              : 'path',
          });
      } catch {
        // Continue searching Windows npm's native package locations.
      }
    }
  }
  return candidates;
}

function resolveCodexDesktopCandidates(
  localAppData: string | null | undefined,
): CliCommandCandidate[] {
  if (localAppData == null) return [];
  const binDirectory = join(localAppData, 'OpenAI', 'Codex', 'bin');
  const result: CliCommandCandidate[] = [];
  try {
    const direct = join(binDirectory, 'codex.exe');
    try {
      if (lstatSync(direct).isFile()) result.push({ executable: direct, source: 'desktop-direct' });
    } catch {
      // Continue with versioned desktop directories.
    }
    const candidates = readdirSync(binDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(binDirectory, entry.name, 'codex.exe'))
      .filter((candidate) => {
        try {
          return lstatSync(candidate).isFile();
        } catch {
          return false;
        }
      })
      .sort();
    result.push(
      ...candidates.map((executable) => ({
        executable,
        source: 'desktop-versioned' as const,
      })),
    );
    return result;
  } catch {
    return result;
  }
}

function minimalEnvironment(source: Readonly<NodeJS.ProcessEnv> = process.env): NodeJS.ProcessEnv {
  const allowlist = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'CODEX_HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'SystemRoot',
    'WINDIR',
    'ComSpec',
    'PATHEXT',
  ];
  return Object.fromEntries(
    allowlist.flatMap((key) => {
      const value = source[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
}

export async function terminateCodexProcessTree(
  child: ChildProcessWithoutNullStreams,
): Promise<boolean> {
  return terminateRuntimeProcessTree(child, minimalEnvironment());
}

function publicError(
  code: PublicError['code'],
  userMessage: string,
  retryable: boolean,
): PublicError {
  return { code, userMessage, retryable };
}
