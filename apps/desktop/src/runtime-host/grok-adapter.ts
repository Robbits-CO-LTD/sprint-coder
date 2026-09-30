import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CodexModelOption, PublicError, RuntimeWriteScope } from '@sprint-coder/contracts';
import type { ToolCatalogSnapshot } from '@sprint-coder/domain';
import desktopPackage from '../../package.json';
import { removeTreeWithoutFollowingLinks } from '../main/worker-worktree';
import { GrokAcpClient, GrokProtocolFailure, GrokRpcError, grokRecord } from './grok-acp';
import { GROK_AGENT_PROFILE, grokEnvironment, prepareGrokIsolation } from './grok-isolation';
import { resolveGrokCommandCandidates } from './grok-command';
import { probeCliCommandCandidates } from './cli-command-resolution';
import { serializeCliExecutionPayload } from './execution-payload';
import { terminateRuntimeProcessTree } from './process-tree';
import { RuntimeFailureDiagnosticCollector } from './runtime-failure-diagnostics';
import {
  RuntimeProgressDeadline,
  RUNTIME_FIRST_EVENT_TIMEOUT_MS,
  RUNTIME_IDLE_TIMEOUT_MS,
} from './runtime-progress-deadline';
import { TEAM_MCP_SERVER_SOURCE } from './team-mcp-server-source';
import { teamMcpNodeCommand } from './team-mcp-node-command';
import {
  GROK_PROTOCOL_COUNT_MAX,
  GROK_PROTOCOL_PENDING_TOOL_MAX,
  GROK_SESSION_UPDATE_KINDS,
  GROK_STOP_REASONS,
  type GrokProtocolDiagnostic,
  type GrokProtocolFailureCode,
  type GrokProtocolPhase,
  type GrokSessionUpdateKind,
  type GrokStopReason,
  type ResolvedCliCommand,
  type RuntimeCanonicalEvent,
  type RuntimeContextFragment,
  type RuntimeFailureDiagnostic,
  type RuntimeProjectContextItem,
  type RuntimeSkillInput,
  type RuntimeTeamMcpOption,
  type RuntimeWorkspaceSet,
} from './protocol';

type Emit = (event: RuntimeCanonicalEvent) => void;
type Fail = (error: PublicError, diagnostic?: RuntimeFailureDiagnostic) => void;
type Control = {
  child: ChildProcessWithoutNullStreams;
  canceled: boolean;
  stop: () => Promise<boolean>;
};
export type GrokProbe = {
  available: boolean;
  readiness: 'ready' | 'authentication_required' | 'unavailable';
  version?: string;
  cli?: ResolvedCliCommand;
  models: CodexModelOption[];
  /** The probe CLI's exit could not be confirmed. `readiness` is still what the CLI answered. */
  stopUnconfirmed?: true;
};
const MODEL_SOURCE = 'https://docs.x.ai/build/cli/headless-scripting';
const capability = (value: boolean) => ({
  value,
  source: 'runtime_metadata' as const,
  sourceReference: MODEL_SOURCE,
});
const AUTO: CodexModelOption = {
  id: 'auto',
  displayName: 'Auto',
  description: 'Grok CLIの既定モデルを使用',
  capabilities: {
    toolCalling: capability(true),
    structuredOutput: capability(false),
    multimodalInput: capability(false),
    reasoning: capability(true),
  },
};

export function grokModelsFromInitialize(value: unknown): CodexModelOption[] {
  const init = grokRecord(value);
  const meta = grokRecord(init['_meta'] ?? {});
  if (meta['grokShell'] !== true) throw new Error('Not the official Grok ACP agent');
  const state = grokRecord(meta['modelState'] ?? {});
  const models = state['availableModels'];
  if (!Array.isArray(models)) return [AUTO];
  const result: CodexModelOption[] = [AUTO];
  for (const raw of models) {
    const model = grokRecord(raw);
    const id = model['modelId'];
    // This connection is xAI-only; custom endpoints require their own Provider connection.
    if (
      typeof id !== 'string' ||
      !/^grok-[a-zA-Z0-9._-]{1,120}$/u.test(id) ||
      result.some((m) => m.id === id)
    )
      continue;
    result.push({
      ...AUTO,
      id,
      displayName: typeof model['name'] === 'string' ? model['name'].slice(0, 128) : id,
      description: `Grok CLI: ${id}`,
    });
    if (result.length === 32) break;
  }
  return result;
}

export function grokAuthenticationMethod(value: unknown): string | null {
  const init = grokRecord(value);
  const methods = Array.isArray(init['authMethods'])
    ? init['authMethods'].map((m) => grokRecord(m)['id'])
    : [];
  // Never open an authentication browser from a background capability probe.
  if (methods.includes('cached_token')) return 'cached_token';
  return methods.includes('xai.api_key') ? 'xai.api_key' : null;
}

function isGrokModelId(value: unknown): value is string {
  return typeof value === 'string' && /^grok-[a-zA-Z0-9._-]{1,120}$/u.test(value);
}

/** Returns the model a `session/set_model` acknowledged, failing closed unless it is `requested`. */
export function grokBoundSessionModel(value: unknown, requested: string): string {
  const model = grokRecord(grokRecord(grokRecord(value)['_meta'] ?? {})['model'] ?? {})['Ok'];
  if (model !== requested) throw new Error('Grok did not bind the requested model');
  return model;
}

export function buildGrokArgs(model = 'auto'): string[] {
  return [
    '--no-auto-update',
    'agent',
    '--no-leader',
    ...(model === 'auto' ? [] : ['--model', model]),
    'stdio',
  ];
}

const INITIALIZE = {
  protocolVersion: 1,
  clientInfo: { name: 'sprint-coder', version: desktopPackage.version },
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
};

type GrokProbeLeftover = Readonly<{
  child: ChildProcessWithoutNullStreams;
  directory: string;
  environment: NodeJS.ProcessEnv;
}>;

/**
 * Capability probes whose CLI exit could not be confirmed (issue #581). Only the isolation that
 * each probe created itself is remembered, so another app instance's or a running Turn's
 * `sprint-coder-grok-*` directory is never a candidate. A directory is removed, without following
 * links, only after its own process is confirmed stopped: when that process exits, or at a later
 * detection.
 */
export class GrokProbeLeftovers {
  private readonly entries = new Set<GrokProbeLeftover>();
  private running: Promise<void> | null = null;
  private rerun = false;

  get size(): number {
    return this.entries.size;
  }

  keep(leftover: GrokProbeLeftover): void {
    this.entries.add(leftover);
    const { child } = leftover;
    if (child.exitCode !== null || child.signalCode !== null) void this.reclaim();
    else child.once('exit', () => void this.reclaim());
  }

  /** Settles after every remembered probe has been checked once more. Never rejects. */
  reclaim(): Promise<void> {
    if (this.running !== null) {
      this.rerun = true;
      return this.running;
    }
    this.running = this.sweep().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async sweep(): Promise<void> {
    do {
      this.rerun = false;
      for (const leftover of [...this.entries]) {
        if (!(await grokProbeStopped(leftover))) continue;
        try {
          await removeTreeWithoutFollowingLinks(leftover.directory);
          this.entries.delete(leftover);
        } catch {
          // Windows can hold a handle briefly after exit; the next detection tries again.
        }
      }
    } while (this.rerun);
  }
}

export const grokProbeLeftovers = new GrokProbeLeftovers();

/** The probe's own stop confirmation, without signaling a root that has already exited: by then
 * its PID may belong to an unrelated process. */
async function grokProbeStopped(leftover: GrokProbeLeftover): Promise<boolean> {
  const { child } = leftover;
  if (child.exitCode === null && child.signalCode === null)
    return terminateRuntimeProcessTree(child, leftover.environment).catch(() => false);
  // Windows confirms a stop by the root's exit alone (process-tree.ts). On POSIX the probe leads
  // its own process group (`detached`), and that group must also be empty.
  if (process.platform === 'win32' || child.pid === undefined) return true;
  try {
    process.kill(-child.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

export async function probeGrok(
  command = 'grok',
  source: Readonly<NodeJS.ProcessEnv> = process.env,
  leftovers: GrokProbeLeftovers = grokProbeLeftovers,
): Promise<GrokProbe> {
  if (source['SPRINT_CODER_E2E_CLI_FIXTURES'] === '1')
    return {
      available: true,
      readiness: 'ready',
      version: 'e2e-fixture',
      models: [AUTO, { ...AUTO, id: 'grok-fixture', displayName: 'Grok fixture' }],
    };
  // A later detection is the next chance to confirm that an earlier probe's CLI has stopped. It
  // runs beside this probe so it cannot outrun the hello budget (probe-budget.ts).
  void leftovers.reclaim();
  const missing: GrokProbe = { available: false, readiness: 'unavailable', models: [] };
  const cli = await probeCliCommandCandidates({
    kind: 'grok',
    candidates: resolveGrokCommandCandidates(command, source),
    environment: grokEnvironment(source),
    timeoutMs: 2_000,
  });
  if (cli === null) return missing;
  const installed = { available: true, version: cli.version, cli, models: [AUTO] };
  let report: GrokProbe;
  let stopUnconfirmed: true | undefined;
  let isolation: ReturnType<typeof prepareGrokIsolation> | undefined;
  let child: ChildProcessWithoutNullStreams | undefined;
  let rpc: GrokAcpClient | undefined;
  try {
    isolation = prepareGrokIsolation(source);
    child = spawn(cli.executable, buildGrokArgs(), {
      cwd: isolation.cwd,
      env: isolation.environment,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    rpc = new GrokAcpClient(
      child,
      () => undefined,
      () => undefined,
    );
    child.stderr.resume();
    const init = await rpc.request('initialize', INITIALIZE, 3_000);
    const models = grokModelsFromInitialize(init);
    const methodId = grokAuthenticationMethod(init);
    if (methodId === null) report = { ...installed, models, readiness: 'authentication_required' };
    else {
      await rpc.request('authenticate', { methodId, _meta: { headless: true } }, 2_000);
      report = { ...installed, models, readiness: 'ready' };
    }
  } catch (error) {
    report = {
      ...installed,
      readiness:
        error instanceof GrokRpcError && error.category === 'authentication'
          ? 'authentication_required'
          : 'unavailable',
    };
  } finally {
    rpc?.close();
    const environment = grokEnvironment(source);
    if (
      child === undefined ||
      (await terminateRuntimeProcessTree(child, environment).catch(() => false))
    )
      cleanupGrokIsolation(isolation);
    else {
      // Unlike a Turn's CLI, this one never received a session, MCP servers or a prompt, so an
      // unconfirmed exit does not make its initialize/authenticate answer wrong (issue #581).
      // Its own isolation waits for a later stop confirmation instead.
      stopUnconfirmed = true;
      if (isolation !== undefined)
        leftovers.keep({ child, directory: isolation.directory, environment });
    }
  }
  return stopUnconfirmed ? { ...report, stopUnconfirmed } : report;
}

export function assertGrokToolInventory(
  value: unknown,
  expectedMcpTools: readonly string[] = [],
): void {
  const nativeTools = ['search_tool', 'use_tool'];
  // Grok re-announces this combined inventory as MCP tools become available.
  // Only aliases of this Turn's Main-authorized bridge tools may join the native pair.
  const allowed = new Set([...nativeTools, ...expectedMcpTools.map((name) => `team__${name}`)]);
  if (
    !Array.isArray(value) ||
    new Set(value).size !== value.length ||
    !nativeTools.every((name) => value.includes(name)) ||
    value.some((name) => typeof name !== 'string' || !allowed.has(name))
  )
    throw new GrokProtocolFailure('inventory_violation', 'Grok native tool isolation failed');
}

export function grokMcpInventoryReady(raw: unknown, expected: readonly string[]): boolean {
  const response = grokRecord(raw);
  const result = grokRecord(response['result'] ?? response);
  if (!Array.isArray(result['servers'])) throw new Error('Missing Grok MCP inventory');
  const servers = result['servers'].map(grokRecord);
  if (
    servers.length !== (expected.length === 0 ? 0 : 1) ||
    servers.some((s) => s['name'] !== 'team')
  )
    throw new Error('Unexpected Grok MCP server');
  if (expected.length === 0) return true;
  if (result['sessionMcpResolved'] !== true) return false;
  const session = grokRecord(servers[0]?.['session']);
  if (session['status'] !== 'ready' || session['enabled'] !== true)
    throw new Error('Grok MCP is unavailable');
  const names = Array.isArray(session['tools'])
    ? session['tools'].map((t) => grokRecord(t)['name'])
    : [];
  if (names.length !== expected.length || !expected.every((name) => names.includes(name)))
    throw new Error('Grok MCP tool inventory changed');
  return true;
}

type GrokProtocolObservation = Omit<GrokProtocolDiagnostic, 'stopConfirmation'>;

/**
 * Fixed-shape record of a Turn's Grok ACP stream for its failure diagnostic (issue #506). Only
 * enums, counts and frame sequences are kept: never session IDs, tool arguments, notification
 * names or text. It observes and never decides completion.
 */
export class GrokProtocolTrace {
  phase: GrokProtocolPhase = 'initialize';
  private promptResultFrame: number | null = null;
  private stopReason: GrokStopReason | null = null;
  private lastSessionUpdateFrame: number | null = null;
  private lastSessionUpdate: GrokSessionUpdateKind | null = null;
  private lastMessageChunkFrame: number | null = null;
  private assistantTextObserved = false;
  private assistantTextChars = 0;
  private frozen: GrokProtocolObservation | null = null;

  /** A `session/update` as the transport received it, before any adapter check. */
  observeSessionUpdate(params: unknown, frame: number): void {
    this.lastSessionUpdateFrame = boundedGrokCount(frame);
    this.lastSessionUpdate = grokSessionUpdateKind(params);
  }

  /** Assistant text the adapter accepted and emitted. */
  observeAssistantText(text: string, frame: number): void {
    this.lastMessageChunkFrame = boundedGrokCount(frame);
    this.assistantTextChars = boundedGrokCount(this.assistantTextChars + text.length);
    if (text.trim() !== '') this.assistantTextObserved = true;
  }

  observePromptResult(result: unknown, frame: number): void {
    this.promptResultFrame = boundedGrokCount(frame);
    const reason =
      typeof result === 'object' && result !== null && !Array.isArray(result)
        ? (result as Record<string, unknown>)['stopReason']
        : undefined;
    this.stopReason = GROK_STOP_REASONS.find((known) => known === reason) ?? 'other';
  }

  /** Captures the state at the first failure. Later frames and failures cannot rewrite it. */
  freeze(
    failureCode: GrokProtocolFailureCode,
    transport: Readonly<{ receivedFrames: number; partialFrame: boolean }>,
    pendingToolCount: number,
  ): void {
    if (this.frozen !== null) return;
    this.frozen = Object.freeze({
      phase: this.phase,
      failureCode,
      promptResultReceived: this.promptResultFrame !== null,
      stopReason: this.stopReason,
      receivedFrames: boundedGrokCount(transport.receivedFrames),
      promptResultFrame: this.promptResultFrame,
      lastSessionUpdateFrame: this.lastSessionUpdateFrame,
      lastSessionUpdate: this.lastSessionUpdate,
      lastMessageChunkFrame: this.lastMessageChunkFrame,
      assistantTextObserved: this.assistantTextObserved,
      assistantTextChars: this.assistantTextChars,
      pendingToolCount: Math.min(pendingToolCount, GROK_PROTOCOL_PENDING_TOOL_MAX),
      partialFrame: transport.partialFrame,
    });
  }

  diagnostic(stopConfirmation: GrokProtocolDiagnostic['stopConfirmation']) {
    return this.frozen === null ? undefined : { ...this.frozen, stopConfirmation };
  }
}

function boundedGrokCount(value: number): number {
  return Math.min(Math.max(0, Math.trunc(value)), GROK_PROTOCOL_COUNT_MAX);
}

function grokSessionUpdateKind(params: unknown): GrokSessionUpdateKind {
  const record = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const kind = record(record(params)?.['update'])?.['sessionUpdate'];
  return GROK_SESSION_UPDATE_KINDS.find((known) => known === kind) ?? 'other';
}

/** The fixed code of an error; `undefined` for one that carries none. */
function grokFailureCode(error: unknown): GrokProtocolFailureCode | undefined {
  if (error instanceof GrokProtocolFailure) return error.failureCode;
  if (error instanceof GrokRpcError) return `rpc_${error.category}`;
  return undefined;
}

/** Runs a response check, giving a failure without its own code the given one. */
function grokChecked<T>(failureCode: GrokProtocolFailureCode, check: () => T): T {
  try {
    return check();
  } catch (error) {
    if (grokFailureCode(error) !== undefined) throw error;
    throw new GrokProtocolFailure(failureCode);
  }
}

export class GrokRuntimeAdapter {
  private readonly active = new Map<string, Control>();
  private quarantined = false;
  private cli: ResolvedCliCommand | null = null;
  private cliVersion: string | null = null;
  constructor(
    private readonly timeoutMs = 10 * 60_000,
    private readonly commandPrefixArgs: readonly string[] = [],
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
    _workspace: RuntimeWorkspaceSet | string | null,
    model: string,
    emit: Emit,
    fail: Fail,
    exited: (code: number, canceled: boolean) => void,
    teamMcp?: RuntimeTeamMcpOption,
    _effort?: string,
    _writeScope: RuntimeWriteScope = 'read-only',
    skills: readonly RuntimeSkillInput[] = [],
    projectItems: readonly RuntimeProjectContextItem[] = [],
    serializedPayload?: string,
    _localImages?: unknown,
    runtimeProcessStarted?: (pid: number) => void,
    _catalog?: ToolCatalogSnapshot,
    _invoke?: (input: {
      callId: string;
      toolName: string;
      arguments: unknown;
      catalogDigest: string;
    }) => Promise<{ success: boolean; output: unknown }>,
  ): void {
    if (this.quarantined) {
      fail(grokStopUnconfirmed());
      return;
    }
    if (this.active.has(turnId)) {
      fail({
        code: 'RUNTIME_FAILED',
        userMessage: 'このTurnはすでに実行中です。',
        retryable: false,
      });
      return;
    }
    if (this.cli === null) {
      fail({
        code: 'RUNTIME_CLI_MISSING',
        userMessage: '対応する公式Grok CLIが見つかりません。',
        retryable: false,
      });
      exited(1, false);
      return;
    }
    const diagnostics = new RuntimeFailureDiagnosticCollector(
      'grok',
      desktopPackage.version,
      this.cliVersion,
      teamMcp !== undefined,
    );
    diagnostics.setCliResolution(this.cli);
    let prepared: ReturnType<typeof prepareGrokIsolation> | undefined;
    let servers: unknown[] = [];
    try {
      prepared = prepareGrokIsolation();
      if (teamMcp !== undefined) {
        const script = join(prepared.directory, 'team-mcp-server.cjs');
        writeFileSync(script, TEAM_MCP_SERVER_SOURCE, { mode: 0o600 });
        servers = [
          {
            name: 'team',
            command: teamMcpNodeCommand(),
            args: [script],
            env: [
              { name: 'TEAM_BRIDGE_SOCKET', value: teamMcp.socketPath },
              { name: 'TEAM_BRIDGE_TOKEN', value: teamMcp.token },
            ],
          },
        ];
      }
    } catch {
      cleanupGrokIsolation(prepared);
      fail(
        {
          code: 'RUNTIME_FAILED',
          userMessage: 'Grok CLIの隔離環境を準備できませんでした。',
          retryable: true,
        },
        diagnostics.snapshot('startup_error'),
      );
      exited(1, false);
      return;
    }
    const isolation = prepared;
    const expectedTools = [
      ...new Set([
        ...(teamMcp?.toolNames ?? []),
        ...(teamMcp?.managedTools ?? []).map((t) => t.name),
      ]),
    ];
    const child = spawn(this.cli.executable, [...this.commandPrefixArgs, ...buildGrokArgs(model)], {
      cwd: isolation.cwd,
      env: isolation.environment,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let failed = false;
    let completed = false;
    let terminalReceived = false;
    let assistantText = false;
    let sessionId: string | null = null;
    let inventorySeen = false;
    const earlyUpdates: Array<{ params: unknown; frame: number }> = [];
    let earlyBytes = 0;
    const trace = new GrokProtocolTrace();
    const messageId = randomUUID();
    const pendingTools = new Set<string>();
    let resumeTools: (() => void) | undefined;
    let stopPromise: Promise<boolean> | undefined;
    const control: Control = {
      child,
      canceled: false,
      stop: () => (stopPromise ??= terminateRuntimeProcessTree(child, grokEnvironment())),
    };
    this.active.set(turnId, control);
    const failAfterStop = (
      error: PublicError,
      stage: Parameters<RuntimeFailureDiagnosticCollector['snapshot']>[0],
      failureCode: GrokProtocolFailureCode,
    ): void => {
      if (failed || completed || control.canceled) return;
      failed = true;
      // Fixed at detection: frames that arrive while the stop is confirmed cannot rewrite it.
      trace.freeze(failureCode, rpc, pendingTools.size);
      void control
        .stop()
        .catch(() => false)
        .then((stopped) => {
          if (!stopped) this.quarantined = true;
          if (stopped && control.canceled) return;
          const grokProtocol = trace.diagnostic(stopped ? 'confirmed' : 'unconfirmed');
          if (grokProtocol !== undefined) diagnostics.recordGrokProtocol(grokProtocol);
          fail(stopped ? error : grokStopUnconfirmed(), diagnostics.snapshot(stage));
        });
    };
    const abort = (
      stage: 'protocol_error' | 'startup_error' | 'spawn_error' | 'abnormal_exit',
      error?: unknown,
      fallbackCode: GrokProtocolFailureCode = 'unexpected',
    ): void => {
      if (error instanceof GrokRpcError && error.httpStatus !== undefined)
        diagnostics.recordGrokHttpStatus(error.httpStatus);
      failAfterStop(
        grokPublicError(error),
        grokDiagnosticStage(stage, error),
        grokFailureCode(error) ?? fallbackCode,
      );
    };
    const deadline = new RuntimeProgressDeadline(
      {
        firstEventMs: RUNTIME_FIRST_EVENT_TIMEOUT_MS,
        idleMs: RUNTIME_IDLE_TIMEOUT_MS,
        totalMs: teamMcp === undefined ? this.timeoutMs : 60 * 60_000,
      },
      (phase) => {
        failAfterStop(
          {
            code: 'RUNTIME_TIMEOUT',
            userMessage: 'Grok CLIの応答待ちがタイムアウトしました。',
            retryable: true,
          },
          `${phase}_timeout`,
          `${phase}_timeout`,
        );
      },
    );
    const applyUpdate = (raw: unknown, frame: number): void => {
      const params = grokRecord(raw);
      if (params['sessionId'] !== sessionId)
        throw new GrokProtocolFailure('session_mismatch', 'Grok session identity changed');
      const event = grokRecord(params['update']);
      const type = event['sessionUpdate'];
      if (type === 'available_commands_update') {
        assertGrokToolInventory(grokRecord(event['_meta'])['tools'], expectedTools);
        inventorySeen = true;
      } else if (type === 'agent_message_chunk' || type === 'agent_thought_chunk') {
        if (!inventorySeen)
          throw new GrokProtocolFailure(
            'content_before_inventory',
            'Grok emitted content before inventory',
          );
        const content = grokRecord(event['content']);
        if (content['type'] === 'text' && typeof content['text'] === 'string') {
          if (type === 'agent_message_chunk' && content['text'].trim() !== '') assistantText = true;
          if (type === 'agent_message_chunk') trace.observeAssistantText(content['text'], frame);
          emit(
            type === 'agent_message_chunk'
              ? { type: 'delta', messageId, delta: content['text'] }
              : { type: 'reasoning', text: content['text'] },
          );
        }
      } else if (type === 'tool_call' || type === 'tool_call_update') {
        const id = event['toolCallId'];
        if (typeof id !== 'string' || id.length > 256)
          throw new GrokProtocolFailure('invalid_tool_identity', 'Invalid Grok tool identity');
        const status = event['status'];
        if (status === 'completed' || status === 'failed') pendingTools.delete(id);
        else if (type === 'tool_call' || status === 'in_progress') pendingTools.add(id);
        if (pendingTools.size > 128)
          throw new GrokProtocolFailure('too_many_tools', 'Too many Grok tools');
        if (pendingTools.size > 0) resumeTools ??= deadline.pauseActivity();
        else {
          resumeTools?.();
          resumeTools = undefined;
        }
        // Arbitrary CLI titles/rawInput contain user data; only emit fixed metadata.
        if (type === 'tool_call')
          emit({
            type: 'operation',
            phase: 'tool_call_start',
            label: 'Grok host tool call',
            sideEffect: false,
          });
      }
    };
    const update = (raw: unknown, frame: number): void => {
      try {
        applyUpdate(raw, frame);
      } catch (error) {
        // A malformed update (not a record, missing content) has no code of its own.
        throw error instanceof GrokProtocolFailure
          ? error
          : new GrokProtocolFailure('session_update_invalid');
      }
    };
    const rpc = new GrokAcpClient(
      child,
      (method, params) => {
        if (failed || completed || control.canceled) return;
        deadline.progress();
        if (method !== 'session/update') return;
        // The transport calls this while it parses the frame, so its count is this frame's.
        const frame = rpc.receivedFrames;
        trace.observeSessionUpdate(params, frame);
        if (sessionId === null) {
          earlyBytes += Buffer.byteLength(JSON.stringify(params));
          if (earlyUpdates.length >= 256 || earlyBytes > 1024 * 1024)
            throw new GrokProtocolFailure('startup_quota', 'Grok startup quota');
          earlyUpdates.push({ params, frame });
        } else update(params, frame);
      },
      (error) => abort('protocol_error', error),
    );
    child.stderr.on('data', (chunk: Buffer) => diagnostics.recordStderr(chunk));
    child.once('spawn', () => {
      if (control.canceled || failed) return;
      if (teamMcp !== undefined && child.pid !== undefined) runtimeProcessStarted?.(child.pid);
      accepted();
    });
    child.once('close', (code) => {
      deadline.stop();
      rpc.close();
      if (!terminalReceived && !completed && !failed && !control.canceled)
        abort('abnormal_exit', undefined, 'process_exited');
      // Stop captures all descendants before cleanup so the bridge cannot outlive its owner.
      void control
        .stop()
        .catch(() => false)
        .then((stopped) => {
          if (!stopped) {
            this.quarantined = true;
            abort('abnormal_exit', undefined, 'stop_unconfirmed');
            return;
          }
          cleanupGrokIsolation(isolation);
          this.active.delete(turnId);
          exited(code ?? (completed ? 0 : 1), control.canceled);
        });
    });
    deadline.start();
    void (async () => {
      try {
        const init = await rpc.request('initialize', INITIALIZE);
        grokChecked('initialize_invalid', () => grokModelsFromInitialize(init));
        const methodId = grokChecked('initialize_invalid', () => grokAuthenticationMethod(init));
        if (methodId === null) throw new GrokRpcError(-32000);
        trace.phase = 'authenticate';
        await rpc.request('authenticate', { methodId, _meta: { headless: true } });
        trace.phase = 'session';
        const created = await rpc.request('session/new', {
          cwd: isolation.cwd,
          mcpServers: servers,
          _meta: {
            agentProfile: GROK_AGENT_PROFILE,
            yoloMode: false,
            autoMode: false,
            rules:
              'Use only the Sprint Coder team MCP tools via search_tool and use_tool. The real Workspace is described in the application context, not your isolated cwd. Native file, terminal and subagent tools are unavailable. Use the exact host input schemas; read changed files back before finishing.',
          },
        });
        const session = grokChecked('session_invalid', () => grokRecord(created));
        if (typeof session['sessionId'] !== 'string' || session['sessionId'].length > 256)
          throw new GrokProtocolFailure('session_invalid', 'Missing Grok session');
        sessionId = session['sessionId'];
        // The CLI applies its campaign default to every new session and ignores `--model` there
        // (issue #515), so an explicit selection is bound to the session before the prompt.
        let boundModel: string | undefined;
        if (model !== 'auto') {
          const bound = await rpc.request('session/set_model', { sessionId, modelId: model });
          boundModel = grokChecked('model_binding_failed', () =>
            grokBoundSessionModel(bound, model),
          );
        }
        trace.phase = 'inventory';
        for (const { params, frame } of earlyUpdates) update(params, frame);
        earlyUpdates.length = 0;
        const start = Date.now();
        while (!inventorySeen) {
          if (failed || control.canceled || Date.now() - start > 15_000)
            throw new GrokProtocolFailure(
              'tool_inventory_timeout',
              'Grok tool inventory unavailable',
            );
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        while (true) {
          if (failed || control.canceled || Date.now() - start > 20_000)
            throw new GrokProtocolFailure(
              'mcp_inventory_timeout',
              'Grok MCP inventory unavailable',
            );
          const inventory = await rpc.request('_x.ai/mcp/list', { sessionId, cache: false });
          if (
            grokChecked('mcp_inventory_invalid', () =>
              grokMcpInventoryReady(inventory, expectedTools),
            )
          )
            break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (failed || control.canceled) return;
        for (const stage of ['understanding', 'planning', 'executing'] as const)
          emit({ type: 'stage', stage });
        const payload =
          serializedPayload ??
          serializeCliExecutionPayload({
            kind: 'grok',
            request: input,
            contextFragments,
            projectItems,
            skills,
          }).text;
        trace.phase = 'prompt';
        const prompted = await rpc.request(
          'session/prompt',
          { sessionId, prompt: [{ type: 'text', text: payload }] },
          teamMcp === undefined ? this.timeoutMs : 60 * 60_000,
          (value, frame) => trace.observePromptResult(value, frame),
        );
        const result = grokChecked('prompt_result_invalid', () => grokRecord(prompted));
        if (failed || control.canceled) return;
        // One code per unmet condition; together they are still the one check they always were.
        if (result['stopReason'] !== 'end_turn')
          throw new GrokProtocolFailure('turn_stop_reason', 'Grok turn did not finish');
        if (pendingTools.size > 0)
          throw new GrokProtocolFailure('turn_pending_tools', 'Grok turn did not finish');
        if (!assistantText)
          throw new GrokProtocolFailure('turn_no_assistant_text', 'Grok turn did not finish');
        const promptMeta = result['_meta'];
        const promptModel =
          typeof promptMeta === 'object' && promptMeta !== null && !Array.isArray(promptMeta)
            ? (promptMeta as Record<string, unknown>)['modelId']
            : undefined;
        // An explicitly selected model that did not run must not be reported as a success.
        if (boundModel !== undefined && promptModel !== undefined && promptModel !== boundModel)
          throw new GrokProtocolFailure(
            'model_mismatch',
            'Grok ran a different model than requested',
          );
        trace.phase = 'stopping';
        terminalReceived = true;
        deadline.stop();
        rpc.close();
        if (!(await control.stop()))
          throw new GrokProtocolFailure('stop_unconfirmed', 'Grok process exit was not confirmed');
        if (failed || control.canceled) return;
        completed = true;
        // Prefer the model that actually answered; an explicit selection never falls back to the
        // session's pre-binding default.
        const resolved = isGrokModelId(promptModel)
          ? promptModel
          : (boundModel ?? grokRecord(session['models'] ?? {})['currentModelId']);
        emit({ type: 'stage', stage: 'synthesizing' });
        emit({
          type: 'completed',
          ...(isGrokModelId(resolved) ? { resolvedModel: resolved } : {}),
        });
      } catch (error) {
        abort(sessionId === null ? 'startup_error' : 'protocol_error', error);
      }
    })();
  }

  async cancel(turnId: string): Promise<boolean> {
    const control = this.active.get(turnId);
    if (control === undefined) return false;
    control.canceled = true;
    if (!(await control.stop().catch(() => false))) {
      this.quarantined = true;
      throw new Error('Grok process exit was not confirmed');
    }
    return false;
  }
  dispose(): void {
    for (const control of this.active.values()) {
      control.canceled = true;
      void control.stop();
    }
  }
}

function cleanupGrokIsolation(
  isolation: ReturnType<typeof prepareGrokIsolation> | undefined,
): void {
  try {
    isolation?.cleanup();
  } catch {
    // Windows can retain scratch-file handles after process exit. Lifecycle notifications
    // must still settle; a locked private scratch directory is not an active CLI process.
  }
}

function grokStopUnconfirmed(): PublicError {
  return {
    code: 'RUNTIME_STOP_UNCONFIRMED',
    userMessage:
      'Grokプロセスの停止を確認できないため、Grokの新しい実行を停止しました。アプリを再起動してから再試行してください。',
    retryable: false,
  };
}

function grokDiagnosticStage(
  stage: 'protocol_error' | 'startup_error' | 'spawn_error' | 'abnormal_exit',
  error: unknown,
): typeof stage | 'billing_error' | 'rate_limit' {
  if ((stage === 'protocol_error' || stage === 'startup_error') && error instanceof GrokRpcError) {
    if (error.category === 'billing') return 'billing_error';
    if (error.category === 'rate_limit') return 'rate_limit';
  }
  return stage;
}

function grokPublicError(error: unknown): PublicError {
  if (error instanceof GrokRpcError && error.category === 'billing')
    return {
      code: 'RUNTIME_BILLING_REQUIRED',
      userMessage: 'Grok Buildの利用残高が不足しています。残高を追加してから再試行してください。',
      retryable: false,
    };
  if (error instanceof GrokRpcError && error.category === 'rate_limit')
    return {
      code: 'RUNTIME_RATE_LIMIT',
      userMessage: 'Grokの利用上限に達しました。時間を置いて再試行してください。',
      retryable: true,
    };
  if (error instanceof GrokRpcError && error.category === 'authentication')
    return {
      code: 'RUNTIME_FAILED',
      userMessage: 'Grok CLIのログインが必要です。ターミナルで grok login を実行してください。',
      retryable: false,
    };
  return {
    code: 'RUNTIME_PROTOCOL_ERROR',
    userMessage:
      'Grok CLIとの接続を確認できませんでした。対応版の公式CLIとログイン状態を確認してください。',
    retryable: true,
  };
}
