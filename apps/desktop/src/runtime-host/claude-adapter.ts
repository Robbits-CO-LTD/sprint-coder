import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { lstatSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { PublicError, RuntimeWriteScope } from '@sprint-coder/contracts';
import type { CodexModelOption } from '@sprint-coder/contracts';
import {
  ClaudeAuthenticationError,
  ClaudeCapabilityViolationError,
  ClaudeJsonlNormalizer,
  type ClaudeExpectedCapabilities,
} from './claude-normalizer';
import type {
  RuntimeCanonicalEvent,
  RuntimeContextFragment,
  RuntimeProjectContextItem,
  RuntimeSkillInput,
  RuntimeTeamMcpOption,
} from './protocol';
import { teamMcpNodeCommand } from './team-mcp-node-command';
import { TEAM_MCP_SERVER_SOURCE, TEAM_MCP_TOOL_NAMES } from './team-mcp-server-source';
import { terminateRuntimeProcessTree } from './process-tree';
import { serializeCliExecutionPayload } from './execution-payload';

type ActiveProcess = {
  child: ChildProcessWithoutNullStreams;
  canceled: boolean;
  cleanup: () => void;
};
type EmitEvent = (event: RuntimeCanonicalEvent) => void;
type EmitError = (error: PublicError) => void;

export type ClaudeProbe = {
  available: boolean;
  version?: string;
  models: CodexModelOption[];
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
  },
  {
    id: 'sonnet',
    displayName: 'Sonnet 5',
    description: 'バランス型モデル（claude-sonnet-5）',
  },
  {
    id: 'claude-opus-5',
    displayName: 'Opus 5',
    description: '最も高性能なモデル（claude-opus-5、低速・高コスト）',
  },
  {
    id: 'haiku',
    displayName: 'Haiku 4.5',
    description: '高速・軽量なモデル（claude-haiku-4-5）',
  },
];

export async function probeClaude(
  command = 'claude',
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): Promise<ClaudeProbe> {
  // These E2E cases validate settings/catalog behavior and never execute Claude. Keep that UI
  // deterministic on credential-free CI runners without changing production discovery.
  if (environment['SPRINT_CODER_E2E_CLI_FIXTURES'] === '1') {
    return { available: true, version: 'e2e-fixture', models: CLAUDE_MODELS };
  }
  const availability = await new Promise<Omit<ClaudeProbe, 'models'>>((resolve) => {
    let settled = false;
    const resolvedCommand = resolveClaudeCommand(command);
    const child = spawn(resolvedCommand, ['--version'], {
      env: minimalEnvironment(),
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    const finish = (result: Omit<ClaudeProbe, 'models'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.once('error', () => finish({ available: false }));
    child.once('exit', (code) => {
      const version = Buffer.concat(chunks).toString('utf8').trim();
      finish(
        code === 0
          ? { available: true, ...(version === '' ? {} : { version }) }
          : { available: false },
      );
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ available: false });
    }, 5_000);
  });
  return {
    ...availability,
    models: availability.available ? CLAUDE_MODELS : [],
  };
}

export class ClaudeRuntimeAdapter {
  private readonly active = new Map<string, ActiveProcess>();

  constructor(private readonly timeoutMs = 10 * 60_000) {}

  start(
    turnId: string,
    input: string,
    contextFragments: readonly RuntimeContextFragment[],
    accepted: () => void,
    workspacePath: string | null,
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
    let temporaryDirectory: string | null = null;
    const cwd =
      workspacePath ?? (temporaryDirectory = mkdtempSync(join(tmpdir(), 'sprint-coder-claude-')));
    let teamMcpDirectory: string | null = null;
    let teamMcpArgs: { configPath: string; guidance: string; enableWebSearch: boolean } | undefined;
    if (teamMcp !== undefined) {
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
              command: teamMcpNodeCommand(),
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
        enableWebSearch: teamMcp.enableWebSearch === true,
      };
    }
    // Same independent refusal as the Codex adapter: with no Workspace the cwd is a throwaway temp
    // directory, so nothing may be written there whatever Main asked for.
    const effectiveScope: RuntimeWriteScope = workspacePath === null ? 'read-only' : writeScope;
    const normalizer = new ClaudeJsonlNormalizer(
      claudeExpectedCapabilities(
        effectiveScope,
        teamMcp !== undefined,
        teamMcp?.enableWebSearch === true,
      ),
    );
    const child = spawn(
      resolveClaudeCommand('claude'),
      buildClaudeArgs(model, teamMcpArgs, effort, effectiveScope, workspacePath),
      {
        cwd,
        env: minimalEnvironment(),
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
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
    const timeout = setTimeout(() => {
      if (!failed && !control.canceled) {
        failed = true;
        fail(publicError('RUNTIME_TIMEOUT', 'Claude runtimeがタイムアウトしました。', true));
      }
      void terminateProcessTree(child);
    }, effectiveTimeoutMs);

    createInterface({ input: child.stdout }).on('line', (line) => {
      if (failed || control.canceled || line.trim() === '') return;
      try {
        for (const event of normalizer.push(line)) {
          if (event.type === 'completed') sawCompletion = true;
          emit(event);
        }
      } catch (error) {
        failed = true;
        const violation = error instanceof ClaudeCapabilityViolationError;
        const authenticationRequired = error instanceof ClaudeAuthenticationError;
        fail(
          publicError(
            violation || authenticationRequired ? 'RUNTIME_FAILED' : 'RUNTIME_PROTOCOL_ERROR',
            authenticationRequired
              ? 'Claude Codeへのログインが必要です。ターミナルでclaudeを起動し、/loginを実行してください。'
              : violation
                ? 'Claude runtimeが読み取り専用プロファイルを逸脱したため停止しました。'
                : 'Claude runtimeの出力を解釈できませんでした。',
            false,
          ),
        );
        void terminateProcessTree(child);
      }
    });
    // Drain diagnostics so the child cannot block, but never forward or retain provider output.
    child.stderr.resume();
    child.once('error', (error) => {
      if (failed || control.canceled) return;
      failed = true;
      fail(
        publicError(
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'RUNTIME_CLI_MISSING'
            : 'RUNTIME_FAILED',
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'Claude CLIが見つかりません。'
            : 'Claude runtimeを起動できませんでした。',
          false,
        ),
      );
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      this.active.delete(turnId);
      cleanup();
      const exitCode = code ?? -1;
      if (!control.canceled && !failed && (exitCode !== 0 || !sawCompletion)) {
        failed = true;
        fail(publicError('RUNTIME_FAILED', 'Claude runtimeが正常に完了しませんでした。', true));
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

// Kept as a small local constant rather than importing team-tools.ts's tool name list: the
// Runtime Host boundary is deliberately self-contained (see the ADR's rationale for duplicating
// terminateProcessTree/signalTree instead of sharing a cross-file utility), and the MCP server
// under `mcpServers.team` always fully-qualifies its tool names as `mcp__team__<name>` per the
// MCP naming convention — verified directly against the installed CLI.
const TEAM_MCP_SERVER_NAME = 'team';

function claudeExpectedCapabilities(
  writeScope: RuntimeWriteScope,
  teamMcpEnabled: boolean,
  enableWebSearch: boolean,
): ClaudeExpectedCapabilities {
  const configuredTools = CLAUDE_TOOLS_BY_SCOPE[writeScope];
  const builtInTools =
    configuredTools === 'default' || !enableWebSearch
      ? configuredTools
      : [...configuredTools, 'WebSearch'];
  return {
    builtInTools,
    ...(teamMcpEnabled
      ? {
          teamMcp: {
            serverName: TEAM_MCP_SERVER_NAME,
            toolNames: TEAM_MCP_TOOL_NAMES.map((name) => `mcp__${TEAM_MCP_SERVER_NAME}__${name}`),
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
  'workspace-write': [
    'Read',
    'Glob',
    'Grep',
    'Edit',
    'Write',
    'MultiEdit',
    'NotebookEdit',
    'Bash',
    'TodoWrite',
  ],
  full: 'default',
};

const CLAUDE_PERMISSION_MODE_BY_SCOPE: Record<RuntimeWriteScope, string> = {
  'read-only': 'manual',
  'workspace-write': 'acceptEdits',
  full: 'bypassPermissions',
};

export function buildClaudeArgs(
  model: string,
  teamMcp?: { configPath: string; guidance: string; enableWebSearch?: boolean },
  effort?: string,
  writeScope: RuntimeWriteScope = 'read-only',
  workspacePath?: string | null,
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
    ...(writeScope === 'workspace-write' && workspacePath !== undefined && workspacePath !== null
      ? ['--add-dir', workspacePath]
      : []),
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
          teamMcp.enableWebSearch === true ? 'mcp__team__*,WebSearch' : 'mcp__team__*',
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
  if (command !== 'claude') return command;
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
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // Continue through the macOS locations a Finder-launched app does not inherit in PATH.
      }
    }
    return command;
  }
  if (platform !== 'win32') return command;
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
      join(root, 'claude.exe'),
      join(root, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
    ]) {
      try {
        if (lstatSync(candidate).isFile()) return candidate;
      } catch {
        // Continue searching the same locations Windows uses for npm global executables.
      }
    }
  }
  return command;
}

function minimalEnvironment(): NodeJS.ProcessEnv {
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
  ];
  return Object.fromEntries(
    allowlist.flatMap((key) => {
      const value = process.env[key];
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
): PublicError {
  return { code, userMessage, retryable };
}
