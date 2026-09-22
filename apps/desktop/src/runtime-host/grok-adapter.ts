import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CodexModelOption, PublicError, RuntimeWriteScope } from '@sprint-coder/contracts';
import type { ToolCatalogSnapshot } from '@sprint-coder/domain';
import desktopPackage from '../../package.json';
import { GrokAcpClient, GrokRpcError, grokRecord } from './grok-acp';
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
import type {
  ResolvedCliCommand,
  RuntimeCanonicalEvent,
  RuntimeContextFragment,
  RuntimeFailureDiagnostic,
  RuntimeProjectContextItem,
  RuntimeSkillInput,
  RuntimeTeamMcpOption,
  RuntimeWorkspaceSet,
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

export async function probeGrok(
  command = 'grok',
  source: Readonly<NodeJS.ProcessEnv> = process.env,
): Promise<GrokProbe> {
  if (source['SPRINT_CODER_E2E_CLI_FIXTURES'] === '1')
    return {
      available: true,
      readiness: 'ready',
      version: 'e2e-fixture',
      models: [AUTO, { ...AUTO, id: 'grok-fixture', displayName: 'Grok fixture' }],
    };
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
    const stopped =
      child === undefined ||
      (await terminateRuntimeProcessTree(child, grokEnvironment(source)).catch(() => false));
    if (stopped) {
      try {
        isolation?.cleanup();
      } catch {
        /* Cleanup cannot reject a capability response. */
      }
    } else report = { ...installed, readiness: 'unavailable' };
  }
  return report;
}

export function assertGrokToolInventory(value: unknown): void {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !['search_tool', 'use_tool'].every((name) => value.includes(name))
  )
    throw new Error('Grok native tool isolation failed');
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
      prepared?.cleanup();
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
    const earlyUpdates: unknown[] = [];
    let earlyBytes = 0;
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
    ): void => {
      if (failed || completed || control.canceled) return;
      failed = true;
      void control
        .stop()
        .catch(() => false)
        .then((stopped) => {
          if (!stopped) this.quarantined = true;
          if (stopped && control.canceled) return;
          fail(stopped ? error : grokStopUnconfirmed(), diagnostics.snapshot(stage));
        });
    };
    const abort = (
      stage: 'protocol_error' | 'startup_error' | 'spawn_error' | 'abnormal_exit',
      error?: unknown,
    ): void => {
      failAfterStop(grokPublicError(error), stage);
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
        );
      },
    );
    const update = (raw: unknown): void => {
      const params = grokRecord(raw);
      if (params['sessionId'] !== sessionId) throw new Error('Grok session identity changed');
      const event = grokRecord(params['update']);
      const type = event['sessionUpdate'];
      if (type === 'available_commands_update') {
        assertGrokToolInventory(grokRecord(event['_meta'])['tools']);
        inventorySeen = true;
      } else if (type === 'agent_message_chunk' || type === 'agent_thought_chunk') {
        if (!inventorySeen) throw new Error('Grok emitted content before inventory');
        const content = grokRecord(event['content']);
        if (content['type'] === 'text' && typeof content['text'] === 'string') {
          if (type === 'agent_message_chunk' && content['text'].trim() !== '') assistantText = true;
          emit(
            type === 'agent_message_chunk'
              ? { type: 'delta', messageId, delta: content['text'] }
              : { type: 'reasoning', text: content['text'] },
          );
        }
      } else if (type === 'tool_call' || type === 'tool_call_update') {
        const id = event['toolCallId'];
        if (typeof id !== 'string' || id.length > 256)
          throw new Error('Invalid Grok tool identity');
        const status = event['status'];
        if (status === 'completed' || status === 'failed') pendingTools.delete(id);
        else if (type === 'tool_call' || status === 'in_progress') pendingTools.add(id);
        if (pendingTools.size > 128) throw new Error('Too many Grok tools');
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
    const rpc = new GrokAcpClient(
      child,
      (method, params) => {
        if (failed || completed || control.canceled) return;
        deadline.progress();
        if (method !== 'session/update') return;
        if (sessionId === null) {
          earlyBytes += Buffer.byteLength(JSON.stringify(params));
          if (earlyUpdates.length >= 256 || earlyBytes > 1024 * 1024)
            throw new Error('Grok startup quota');
          earlyUpdates.push(params);
        } else update(params);
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
      if (!terminalReceived && !completed && !failed && !control.canceled) abort('abnormal_exit');
      // Stop captures all descendants before cleanup so the bridge cannot outlive its owner.
      void control
        .stop()
        .catch(() => false)
        .then((stopped) => {
          if (!stopped) {
            this.quarantined = true;
            abort('abnormal_exit');
            return;
          }
          isolation.cleanup();
          this.active.delete(turnId);
          exited(code ?? (completed ? 0 : 1), control.canceled);
        });
    });
    deadline.start();
    void (async () => {
      try {
        const init = await rpc.request('initialize', INITIALIZE);
        grokModelsFromInitialize(init);
        const methodId = grokAuthenticationMethod(init);
        if (methodId === null) throw new GrokRpcError(-32000);
        await rpc.request('authenticate', { methodId, _meta: { headless: true } });
        const session = grokRecord(
          await rpc.request('session/new', {
            cwd: isolation.cwd,
            mcpServers: servers,
            _meta: {
              agentProfile: GROK_AGENT_PROFILE,
              yoloMode: false,
              autoMode: false,
              rules:
                'Use only the Sprint Coder team MCP tools via search_tool and use_tool. The real Workspace is described in the application context, not your isolated cwd. Native file, terminal and subagent tools are unavailable. Use the exact host input schemas; read changed files back before finishing.',
            },
          }),
        );
        if (typeof session['sessionId'] !== 'string' || session['sessionId'].length > 256)
          throw new Error('Missing Grok session');
        sessionId = session['sessionId'];
        for (const params of earlyUpdates) update(params);
        earlyUpdates.length = 0;
        const start = Date.now();
        while (!inventorySeen) {
          if (failed || control.canceled || Date.now() - start > 15_000)
            throw new Error('Grok tool inventory unavailable');
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        while (true) {
          if (failed || control.canceled || Date.now() - start > 20_000)
            throw new Error('Grok MCP inventory unavailable');
          const inventory = await rpc.request('_x.ai/mcp/list', { sessionId, cache: false });
          if (grokMcpInventoryReady(inventory, expectedTools)) break;
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
        const result = grokRecord(
          await rpc.request(
            'session/prompt',
            { sessionId, prompt: [{ type: 'text', text: payload }] },
            teamMcp === undefined ? this.timeoutMs : 60 * 60_000,
          ),
        );
        if (failed || control.canceled) return;
        if (result['stopReason'] !== 'end_turn' || pendingTools.size > 0 || !assistantText)
          throw new Error('Grok turn did not finish');
        terminalReceived = true;
        deadline.stop();
        rpc.close();
        if (!(await control.stop())) throw new Error('Grok process exit was not confirmed');
        if (failed || control.canceled) return;
        completed = true;
        const models = grokRecord(session['models'] ?? {});
        const resolved = models['currentModelId'];
        emit({ type: 'stage', stage: 'synthesizing' });
        emit({
          type: 'completed',
          ...(typeof resolved === 'string' && /^grok-[a-zA-Z0-9._-]{1,120}$/u.test(resolved)
            ? { resolvedModel: resolved }
            : {}),
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

function grokStopUnconfirmed(): PublicError {
  return {
    code: 'RUNTIME_STOP_UNCONFIRMED',
    userMessage:
      'Grokプロセスの停止を確認できないため、Grokの新しい実行を停止しました。アプリを再起動してから再試行してください。',
    retryable: false,
  };
}

function grokPublicError(error: unknown): PublicError {
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
