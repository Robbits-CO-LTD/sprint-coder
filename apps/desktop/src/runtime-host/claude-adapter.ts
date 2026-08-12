import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  accessSync,
  constants,
  lstatSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { PublicError, RuntimeWriteScope } from '@sprint-coder/contracts';
import type { CodexModelOption } from '@sprint-coder/contracts';
import desktopPackage from '../../package.json';
import {
  ClaudeAuthenticationError,
  ClaudeCapabilityViolationError,
  ClaudeJsonlNormalizer,
  ClaudeRateLimitError,
  type ClaudeExpectedCapabilities,
} from './claude-normalizer';
import type {
  RuntimeCanonicalEvent,
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

type ActiveProcess = {
  child: ChildProcessWithoutNullStreams;
  canceled: boolean;
  cleanup: () => void;
};
type EmitEvent = (event: RuntimeCanonicalEvent) => void;
type EmitError = (error: PublicError, diagnostic?: RuntimeFailureDiagnostic) => void;

export type ClaudeProbe = {
  available: boolean;
  readiness: 'ready' | 'authentication_required' | 'unavailable';
  version?: string;
  cli?: ResolvedCliCommand;
  models: CodexModelOption[];
};

const CLAUDE_MODEL_CONFIG_SOURCE = 'https://code.claude.com/docs/en/model-config';
const CLAUDE_MODEL_OVERVIEW_SOURCE =
  'https://platform.claude.com/docs/en/about-claude/models/overview';
const CLAUDE_CLI_REFERENCE_SOURCE = 'https://code.claude.com/docs/en/cli-usage';
const claudeCapability = (sourceReference: string) => ({
  value: true,
  source: 'official_curated' as const,
  sourceReference,
});
const CLAUDE_CODE_CAPABILITIES: NonNullable<CodexModelOption['capabilities']> = {
  toolCalling: claudeCapability(CLAUDE_MODEL_CONFIG_SOURCE),
  structuredOutput: claudeCapability(CLAUDE_CLI_REFERENCE_SOURCE),
  multimodalInput: claudeCapability(CLAUDE_MODEL_OVERVIEW_SOURCE),
  reasoning: claudeCapability(CLAUDE_MODEL_CONFIG_SOURCE),
};

// The CLI does not expose a model catalog to enumerate (unlike Codex's models_cache.json), so a
// static curated list ships instead, per the ADR. Every entry below is verified against the
// installed CLI with a real probe turn (`claude -p "1" --model <id> --output-format json --tools ''
// --strict-mcp-config --safe-mode --no-session-persistence`), reading the concrete model id back
// from the result's `modelUsage` key — displayName/description spell out that verified id so
// "which model is this?" has a concrete answer instead of a bare label.
//
// Re-probed 2026-07-25 on CLI 2.1.218 (issue #7):
//   (no --model)         -> claude-sonnet-5            (the adapter's own `auto` sentinel)
//   --model sonnet       -> claude-sonnet-5
//   --model haiku        -> claude-haiku-4-5-20251001
//   --model opus         -> claude-opus-4-8            <-- alias lags behind the tier
//   --model claude-opus-5 -> claude-opus-5
//   --model fable        -> claude-opus-4-8            <-- silent fallback, see below
//   --model claude-fable-5 -> claude-opus-4-8          <-- likewise
//
// Hence the asymmetry in this list: `sonnet` and `haiku` stay as aliases because they verifiably
// resolve to the current model of their tier and will keep tracking it for free, while the top
// tier pins the concrete `claude-opus-5`. The `opus` alias still resolves to claude-opus-4-8 on
// this CLI, so keeping it would mean a user who picks "the most capable model" silently gets an
// older one — a stale alias is worse than a pin that has to be bumped by hand. Retiring a catalog
// id needs a matching entry in `RETIRED_CLAUDE_MODEL_IDS` (main/persistence.ts) so an existing
// preference follows rather than silently pinning the old model.
//
// `fable` remains deliberately absent, but for a different reason than before: it is now listed in
// `claude --help`'s own alias examples, so the earlier "not a documented tier" rationale no longer
// holds — however both `fable` and `claude-fable-5` resolve to claude-opus-4-8 here, i.e. the CLI
// accepts them and silently serves something else. Shipping a "Fable 5" entry that does not run
// Fable 5 is worse than omitting it. Re-probe before adding: if `--model claude-fable-5` ever
// reports `claude-fable-5` in `modelUsage`, it belongs in this list.
const CLAUDE_MODELS: CodexModelOption[] = [
  {
    id: 'auto',
    displayName: 'Auto',
    description: 'Claude Codeの既定モデルを使用（現在: Sonnet 5 / claude-sonnet-5）',
    capabilities: CLAUDE_CODE_CAPABILITIES,
  },
  {
    id: 'sonnet',
    displayName: 'Sonnet 5',
    description: 'バランス型モデル（claude-sonnet-5）',
    capabilities: CLAUDE_CODE_CAPABILITIES,
  },
  {
    id: 'claude-opus-5',
    displayName: 'Opus 5',
    description: '最も高性能なモデル（claude-opus-5、低速・高コスト）',
    capabilities: CLAUDE_CODE_CAPABILITIES,
  },
  {
    id: 'haiku',
    displayName: 'Haiku 4.5',
    description: '高速・軽量なモデル（claude-haiku-4-5）',
    capabilities: CLAUDE_CODE_CAPABILITIES,
  },
];

export async function probeClaude(
  command = 'claude',
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): Promise<ClaudeProbe> {
  // These E2E cases validate settings/catalog behavior and never execute Claude. Keep that UI
  // deterministic on credential-free CI runners without changing production discovery.
  if (environment['SPRINT_CODER_E2E_CLI_FIXTURES'] === '1') {
    return { available: true, readiness: 'ready', version: 'e2e-fixture', models: CLAUDE_MODELS };
  }
  const cli = await probeCliCommandCandidates({
    kind: 'claude',
    candidates: resolveClaudeCommandCandidates(command, environment),
    environment: minimalEnvironment(environment),
    timeoutMs: RUNTIME_VERSION_PROBE_TIMEOUT_MS,
  });
  const availability: Omit<ClaudeProbe, 'models' | 'readiness'> =
    cli === null ? { available: false } : { available: true, version: cli.version, cli };
  const authentication = availability.available
    ? await probeCliAuthentication(
        'claude',
        cli!.executable,
        ['auth', 'status', '--json'],
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
    models: availability.available ? CLAUDE_MODELS : [],
  };
}

export class ClaudeRuntimeAdapter {
  private readonly active = new Map<string, ActiveProcess>();
  private cliVersion: string | null = null;
  private cli: ResolvedCliCommand | null = null;

  constructor(private readonly timeoutMs = 10 * 60_000) {}

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
    effort?: string,
    writeScope: RuntimeWriteScope = 'read-only',
    _skills: readonly RuntimeSkillInput[] = [],
    projectItems: readonly RuntimeProjectContextItem[] = [],
    serializedPayload?: string,
  ): void {
    if (this.active.has(turnId)) {
      fail(publicError('RUNTIME_FAILED', 'このTurnはすでに実行中です。', false));
      return;
    }
    const diagnostics = new RuntimeFailureDiagnosticCollector(
      'claude',
      desktopPackage.version,
      this.cliVersion,
      teamMcp !== undefined,
    );
    diagnostics.setCliResolution(this.cli);
    const failWithDiagnostic = (error: PublicError, stage: RuntimeFailureStage): void =>
      fail(error, diagnostics.snapshot(stage));
    let temporaryDirectory: string | null = null;
    const workspace =
      typeof workspaceInput === 'string' || workspaceInput === null
        ? runtimeWorkspaceSetFromLegacyPath(workspaceInput)
        : workspaceInput;
    const primaryRoot = workspace.roots.find(({ rootId }) => rootId === workspace.primaryRootId);
    const cwd =
      primaryRoot?.path ??
      (temporaryDirectory = mkdtempSync(join(tmpdir(), 'sprint-coder-claude-')));
    const runtimeWorkspaceRoots = workspace.roots.map(({ path }) => path);
    let teamMcpDirectory: string | null = null;
    let teamMcpArgs:
      | {
          configPath: string;
          guidance: string;
          toolNames: readonly TeamMcpToolName[];
          enableWebSearch: boolean;
        }
      | undefined;
    if (teamMcp !== undefined) {
      let nodeCommand: string;
      try {
        nodeCommand = teamMcpNodeCommand();
      } catch {
        if (temporaryDirectory !== null)
          rmSync(temporaryDirectory, { recursive: true, force: true });
        failWithDiagnostic(
          publicError(
            'RUNTIME_FAILED',
            'Team機能に必要な同梱Node.jsを起動できません。アプリを再インストールしてください。',
            false,
          ),
          'startup_error',
        );
        return;
      }
      teamMcpDirectory = mkdtempSync(join(tmpdir(), 'sprint-coder-claude-mcp-'));
      const scriptPath = join(teamMcpDirectory, 'team-mcp-server.cjs');
      const configPath = join(teamMcpDirectory, 'mcp-config.json');
      writeFileSync(scriptPath, TEAM_MCP_SERVER_SOURCE, { mode: 0o600 });
      writeFileSync(
        configPath,
        JSON.stringify({
          mcpServers: {
            team: {
              type: 'stdio',
              command: nodeCommand,
              args: [scriptPath],
              env: {
                TEAM_BRIDGE_SOCKET: teamMcp.socketPath,
                TEAM_BRIDGE_TOKEN: teamMcp.token,
              },
            },
          },
        }),
        { mode: 0o600 },
      );
      teamMcpArgs = {
        configPath,
        guidance: teamMcp.guidance,
        toolNames: teamMcp.toolNames,
        enableWebSearch: teamMcp.enableWebSearch === true,
      };
    }
    // Same independent refusal as the Codex adapter: with no Workspace the cwd is a throwaway temp
    // directory, so nothing may be written there whatever Main asked for.
    const effectiveScope: RuntimeWriteScope = primaryRoot === undefined ? 'read-only' : writeScope;
    const normalizer = new ClaudeJsonlNormalizer(
      claudeExpectedCapabilities(
        effectiveScope,
        teamMcp?.toolNames,
        teamMcp?.enableWebSearch === true,
      ),
    );
    const child = spawn(
      this.cli?.executable ?? resolveClaudeCommand('claude'),
      buildClaudeArgs(model, teamMcpArgs, effort, effectiveScope, runtimeWorkspaceRoots),
      {
        cwd,
        env: minimalEnvironment(),
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    const cleanup = (): void => {
      if (temporaryDirectory !== null) rmSync(temporaryDirectory, { recursive: true, force: true });
      if (teamMcpDirectory !== null) rmSync(teamMcpDirectory, { recursive: true, force: true });
    };
    const control: ActiveProcess = { child, canceled: false, cleanup };
    this.active.set(turnId, control);
    accepted();
    child.stdin.end(serializedPayload ?? buildClaudePrompt(input, contextFragments, projectItems));

    let failed = false;
    let sawCompletion = false;
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
            publicError('RUNTIME_TIMEOUT', claudeTimeoutMessage(phase), true),
            `${phase}_timeout`,
          );
        }
        void terminateProcessTree(child);
      },
    );
    deadline.start();

    createInterface({ input: child.stdout }).on('line', (line) => {
      if (failed || control.canceled || line.trim() === '') return;
      deadline.progress();
      try {
        for (const event of normalizer.push(line)) {
          if (event.type === 'completed') sawCompletion = true;
          emit(event);
        }
      } catch (error) {
        failed = true;
        if (error instanceof ClaudeCapabilityViolationError)
          diagnostics.recordCapabilityMismatch(error.missingTools, error.unexpectedTools);
        failWithDiagnostic(claudeOutputErrorToPublicError(error), 'protocol_error');
        void terminateProcessTree(child);
      }
    });
    // Keep only presence/size metadata; provider stderr text never crosses the Runtime boundary.
    child.stderr.on('data', (chunk: Buffer) => diagnostics.recordStderr(chunk));
    child.once('error', (error) => {
      if (failed || control.canceled) return;
      failed = true;
      failWithDiagnostic(
        publicError(
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'RUNTIME_CLI_MISSING'
            : 'RUNTIME_FAILED',
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'Claude CLIが見つかりません。'
            : 'Claude runtimeを起動できませんでした。',
          false,
        ),
        'spawn_error',
      );
    });
    child.once('exit', (code) => {
      deadline.stop();
      this.active.delete(turnId);
      cleanup();
      const exitCode = code ?? -1;
      if (!control.canceled && !failed && (exitCode !== 0 || !sawCompletion)) {
        failed = true;
        failWithDiagnostic(
          publicError('RUNTIME_FAILED', 'Claude runtimeが正常に完了しませんでした。', true),
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
    return !(await terminateProcessTree(control.child));
  }

  dispose(): void {
    for (const [turnId] of this.active) void this.cancel(turnId);
  }
}

function claudeTimeoutMessage(phase: RuntimeProgressTimeoutPhase): string {
  if (phase === 'first_event')
    return 'Claude runtimeから45秒間応答がなかったため、このTurnを終了しました。接続とCLI実行環境を確認して、もう一度お試しください。';
  if (phase === 'idle')
    return 'Claude runtimeから90秒間新しい応答がなかったため、このTurnを終了しました。接続状態を確認して、もう一度お試しください。';
  return 'Claude runtimeがタイムアウトしました。';
}

export function claudeOutputErrorToPublicError(error: unknown): PublicError {
  if (error instanceof ClaudeRateLimitError) {
    return publicError(
      'RUNTIME_RATE_LIMIT',
      `Claude Codeの利用上限に達しました。${claudeRateLimitResetMessage(error.resetAtEpochSeconds)}`,
      false,
      claudeRateLimitRetryAt(error.resetAtEpochSeconds),
    );
  }
  if (error instanceof ClaudeAuthenticationError)
    return publicError(
      'RUNTIME_FAILED',
      'Claude Codeへのログインが必要です。ターミナルでclaudeを起動し、/loginを実行してください。',
      false,
    );
  if (error instanceof ClaudeCapabilityViolationError)
    return publicError(
      'RUNTIME_FAILED',
      'Claude runtimeが読み取り専用プロファイルを逸脱したため停止しました。',
      false,
    );
  return publicError(
    'RUNTIME_PROTOCOL_ERROR',
    'Claude runtimeの出力を解釈できませんでした。',
    false,
  );
}

function claudeRateLimitResetMessage(resetAtEpochSeconds: number | null): string {
  if (resetAtEpochSeconds === null) return 'リセット後にもう一度お試しください。';
  const resetAt = new Date(resetAtEpochSeconds * 1_000);
  if (!Number.isFinite(resetAt.getTime())) return 'リセット後にもう一度お試しください。';
  const formatted = new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(resetAt);
  return `${formatted}にリセット予定です。`;
}

function claudeRateLimitRetryAt(resetAtEpochSeconds: number | null): string | undefined {
  if (resetAtEpochSeconds === null) return undefined;
  const retryAt = new Date(resetAtEpochSeconds * 1_000);
  return Number.isFinite(retryAt.getTime()) ? retryAt.toISOString() : undefined;
}

// Kept as a small local constant rather than importing team-tools.ts's tool name list: the
// Runtime Host boundary is deliberately self-contained (see the ADR's rationale for duplicating
// terminateProcessTree/signalTree instead of sharing a cross-file utility), and the MCP server
// under `mcpServers.team` always fully-qualifies its tool names as `mcp__team__<name>` per the
// MCP naming convention — verified directly against the installed CLI.
const TEAM_MCP_SERVER_NAME = 'team';

function claudeExpectedCapabilities(
  writeScope: RuntimeWriteScope,
  teamMcpToolNames: readonly TeamMcpToolName[] | undefined,
  enableWebSearch: boolean,
): ClaudeExpectedCapabilities {
  const configuredTools = CLAUDE_TOOLS_BY_SCOPE[writeScope];
  const builtInTools =
    configuredTools === 'default' || !enableWebSearch
      ? configuredTools
      : [...configuredTools, 'WebSearch'];
  return {
    builtInTools,
    ...(teamMcpToolNames !== undefined
      ? {
          teamMcp: {
            serverName: TEAM_MCP_SERVER_NAME,
            toolNames: teamMcpToolNames.map((name) => `mcp__${TEAM_MCP_SERVER_NAME}__${name}`),
          },
        }
      : {}),
  };
}

export function buildClaudePrompt(
  input: string,
  contextFragments: readonly RuntimeContextFragment[],
  projectItems: readonly RuntimeProjectContextItem[] = [],
): string {
  return serializeCliExecutionPayload({
    kind: 'claude',
    request: input,
    contextFragments,
    projectItems,
  }).text;
}

// Immutable per-turn invocation profile (see the ADR for the verified rationale behind each
// flag). `--tools ""` and `--strict-mcp-config` are the read-only/no-tools guarantee;
// `--safe-mode` drops hooks/plugins/CLAUDE.md/custom commands the way Codex's
// `--ignore-user-config --ignore-rules` do; `--no-session-persistence` keeps the turn ephemeral.
// Plan mode is deliberately NOT used: with `--tools ""` no tool exists anyway, and plan mode
// makes the model narrate planning mechanics (ExitPlanMode, plan files) into its answers.
//
// `teamMcp` (Leader MCP milestone, see the ADR amendment) is the one case where `--safe-mode`
// cannot be used: verified directly against the installed CLI, `--safe-mode` disables MCP server
// loading entirely (its own `--help` text lists "MCP servers" among what it turns off), which
// would make the Leader's team_* tools permanently unreachable. `--setting-sources ""` +
// `--disable-slash-commands` are the verified substitute — empirically confirmed (real `claude`
// process, no mocking) to reproduce every other property `--safe-mode` provides for this profile:
// no CLAUDE.md auto-discovery (`system/init`'s effective context did not include a project/user
// CLAUDE.md marker used as a probe), no plugins (`"plugins":[]`), no hooks/custom commands
// (loaded only from the user/project/local settings sources this flag empties), and no slash
// commands (`"slash_commands":[]`) — while `--mcp-config`'s explicit server (not a "setting
// source") still connects and `--tools ""` still empties the built-in tool set exactly as
// without `--safe-mode`. `--strict-mcp-config` then pins the MCP surface to exactly that one
// server, and `--allowedTools mcp__team__*` further pins it to exactly the 4 team tools.
//
// `effort` (reasoning effort control, see the ADR amendment) maps straight to `--effort <level>`.
// Verified directly against the installed CLI: `claude --help` documents "Effort level for the
// current session (low, medium, high, xhigh, max)", plus the undocumented-but-accepted
// `ultracode` (see the probe log on `claudeEffortSchema`), and a probe with an invalid value emits
// a non-fatal warning and falls back to the CLI's own default rather than erroring — so an
// out-of-range value here degrades gracefully even if it ever reached the CLI unvalidated (Main
// still validates against `claudeEffortSchema` before it gets this far).
/**
 * The built-in tool set for each write scope.
 *
 * Read-only gets the read tools rather than the empty set it had before issue #37. The empty set was
 * the stronger statement, but it made the default preset useless in a way that was actively
 * misleading: with no tools at all the model still believes it has them (the system prompt describes
 * them), so it narrates invented tool calls in prose — observed directly, a turn that answered "Let
 * me find the file first. **Tool: bash** …" and then stopped. Read/Glob/Grep cannot write, and
 * `--permission-mode manual` refuses anything that is not on this list, so the boundary that matters
 * is unchanged while the model can actually look at the code it is being asked about.
 *
 * The wider sets are an allowlist the CLI applies to itself, NOT an OS boundary —
 * §Managed Runtime is explicit that "単なるtool非公開はsecurity boundaryに数えない", so a Turn run
 * at either of the wider scopes is labelled trusted-unmanaged in the UI. Bash is included from
 * workspace-write up because a code assistant that can edit but not run the test it just changed is
 * not usable; that is exactly the trade the label exists to disclose.
 */
const CLAUDE_TOOLS_BY_SCOPE: Record<RuntimeWriteScope, readonly string[] | 'default'> = {
  'read-only': ['Read', 'Glob', 'Grep'],
  'workspace-write': ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'NotebookEdit', 'Bash'],
  full: 'default',
};

const CLAUDE_PERMISSION_MODE_BY_SCOPE: Record<RuntimeWriteScope, string> = {
  'read-only': 'manual',
  'workspace-write': 'acceptEdits',
  full: 'bypassPermissions',
};

export function buildClaudeArgs(
  model: string,
  teamMcp?: {
    configPath: string;
    guidance: string;
    toolNames: readonly TeamMcpToolName[];
    enableWebSearch?: boolean;
  },
  effort?: string,
  writeScope: RuntimeWriteScope = 'read-only',
  workspaceRoots: readonly string[] = [],
): string[] {
  const configuredTools = CLAUDE_TOOLS_BY_SCOPE[writeScope];
  const tools =
    configuredTools === 'default'
      ? configuredTools
      : [...configuredTools, ...(teamMcp?.enableWebSearch === true ? ['WebSearch'] : [])].join(',');
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--tools',
    tools,
    // Only meaningful once tools exist. `acceptEdits` lets the edit tools through without an
    // interactive prompt there is no channel for; `manual` is what read-only relies on to refuse
    // anything that slips into the tool set, and its refusals come back structured on
    // `permission_denials` rather than as prose (verified on 2.1.218).
    '--permission-mode',
    CLAUDE_PERMISSION_MODE_BY_SCOPE[writeScope],
    // Pins writable paths to the Workspace even at workspace-write. Without it the CLI's own notion
    // of the project root is the cwd, which is the same directory — this makes the intent explicit
    // and survives a future change to how cwd is chosen.
    ...workspaceRoots.flatMap((path) => ['--add-dir', path]),
    '--strict-mcp-config',
    ...(teamMcp === undefined
      ? ['--safe-mode']
      : ['--setting-sources', '', '--disable-slash-commands']),
    '--no-session-persistence',
    ...(teamMcp === undefined
      ? []
      : [
          '--mcp-config',
          teamMcp.configPath,
          '--allowedTools',
          [
            ...teamMcp.toolNames.map((name) => `mcp__team__${name}`),
            ...(teamMcp.enableWebSearch === true ? ['WebSearch'] : []),
          ].join(','),
          '--append-system-prompt',
          teamMcp.guidance,
        ]),
    ...(model === 'auto' ? [] : ['--model', model]),
    ...(effort === undefined ? [] : ['--effort', effort]),
  ];
}

export function resolveClaudeCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
  searchPath: string | undefined = process.env['PATH'],
  appData: string | null | undefined = process.env['APPDATA'],
  userHome: string = homedir(),
): string {
  return (
    resolveClaudeCommandCandidates(
      command,
      {
        PATH: searchPath,
        APPDATA: appData ?? undefined,
        HOME: userHome,
        USERPROFILE: userHome,
      },
      platform,
    )[0]?.executable ?? command
  );
}

export function resolveClaudeCommandCandidates(
  command: string,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  platform: NodeJS.Platform = process.platform,
): CliCommandCandidate[] {
  if (command !== 'claude') return [{ executable: command, source: 'explicit' }];
  const searchPath = environmentValue(environment, 'PATH', platform);
  const appData = environmentValue(environment, 'APPDATA', platform);
  const userHome =
    environmentValue(environment, 'HOME', platform) ??
    environmentValue(environment, 'USERPROFILE', platform) ??
    homedir();
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
        // Claude's native installer exposes the versioned binary through this user-local symlink.
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
  const roots = [
    ...(searchPath ?? '')
      .split(delimiter)
      .map((entry) => entry.trim().replace(/^"(.*)"$/u, '$1'))
      .filter((entry) => entry.length > 0),
    ...(appData == null ? [] : [join(appData, 'npm')]),
    join(userHome, 'AppData', 'Roaming', 'npm'),
  ];
  const userLocal = join(userHome, '.local', 'bin', 'claude.exe');
  try {
    if (lstatSync(userLocal).isFile())
      candidates.push({ executable: userLocal, source: 'user-local' });
  } catch {
    // Continue through PATH and npm locations.
  }
  for (const root of new Set(roots)) {
    for (const candidate of [
      join(root, 'claude.exe'),
      join(root, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
    ]) {
      try {
        if (lstatSync(candidate).isFile())
          candidates.push({
            executable: candidate,
            source: candidate.includes(`${join('node_modules', '@anthropic-ai', 'claude-code')}`)
              ? 'npm'
              : 'path',
          });
      } catch {
        // Continue searching the same locations Windows uses for npm global executables.
      }
    }
  }
  return candidates;
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

async function terminateProcessTree(child: ChildProcessWithoutNullStreams): Promise<boolean> {
  return terminateRuntimeProcessTree(child, minimalEnvironment());
}

function publicError(
  code: PublicError['code'],
  userMessage: string,
  retryable: boolean,
  retryAt?: string,
): PublicError {
  return { code, userMessage, retryable, ...(retryAt === undefined ? {} : { retryAt }) };
}
