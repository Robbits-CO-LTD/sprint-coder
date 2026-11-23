import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CanonicalProviderEvent,
  ProviderConnection,
  ProviderExecutionRequest,
} from '@sprint-coder/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXTERNAL_ACP_AGENTS } from './external-acp-profile';
import { ExternalAcpRuntime } from './external-acp-runtime';
import type * as ExternalAcpProfile from './external-acp-profile';
import type * as OwnedCliProcess from '../runtime-host/owned-cli-process';
import { terminateRuntimeProcessTree } from '../runtime-host/process-tree';
import { removeTreeWithoutFollowingLinksSync } from '../runtime-host/link-safe-tree-removal';

const modelId = 'opencode/test-free';
const scenario = vi.hoisted(() => ({ behavior: 'success' }));
vi.mock('./external-acp-profile', async (load) => {
  const original = await load<typeof ExternalAcpProfile>();
  return {
    ...original,
    resolveExternalAcpCli: () => ({ executable: process.execPath, prefix: [] }),
  };
});
vi.mock('../runtime-host/owned-cli-process', async (load) => {
  const original = await load<typeof OwnedCliProcess>();
  return {
    ...original,
    spawnOwnedCliProcess: (_path: string, _argv: string[], options: SpawnOptionsWithoutStdio) =>
      spawn(process.execPath, ['-e', fixtureServer, scenario.behavior], options),
    stopOwnedCliProcess: (child: ChildProcessWithoutNullStreams) =>
      process.platform === 'win32'
        ? new Promise<boolean>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
            child.once('exit', () => resolve(!scenario.behavior.endsWith('stop_unconfirmed')));
            child.kill();
          })
        : scenario.behavior.endsWith('stop_unconfirmed')
          ? terminateRuntimeProcessTree(child, process.env).then(() => false)
          : undefined,
  };
});

const fixtureServer = String.raw`
const rl = require('node:readline').createInterface({ input: process.stdin });
const scenario = process.argv[1];
const model = 'opencode/test-free';
const send = (payload) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...payload }) + '\n');
const selection = { id: 'model', category: 'model', currentValue: model,
  options: [{ value: model, name: 'Test Free' }] };
const sessionId = 'fixture-session';
const output = (id, text) => send({ method: 'session/update', params: { sessionId: id,
  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
let promptId;
rl.on('line', line => {
  const request = JSON.parse(line);
  const reply = (result) => send({ id: request.id, result });
  switch (request.method) {
    case 'initialize':
      reply({ protocolVersion: 1, agentInfo: { name: 'OpenCode',
        version: scenario === 'old_version' ? '1.9.0' : '2.2.5' } });
      break;
    case 'session/new':
      if (scenario === 'startup_stop_unconfirmed')
        send({ id: request.id, error: { code: -32603, message: 'session initialization failed' } });
      else reply({ sessionId, configOptions: [selection] });
      break;
    case 'session/prompt':
      if (scenario.startsWith('tool-')) {
        const prompt = request.params.prompt[0].text;
        const marker = prompt.match(/^SPRINT_TOOL_[a-f0-9-]+$/m)?.[0];
        if (scenario === 'tool-result') {
          const hasResult = prompt.includes('The final tool message above is the actual result') && prompt.includes('native terminal, filesystem, built-in tools and subagents are disabled') && prompt.includes('"role":"tool"') && prompt.includes('"toolCallId":"call-1"');
          output(sessionId, hasResult ? 'used actual result' : 'missing result');
        } else {
          output(sessionId, marker.slice(0, 4));
          output(sessionId, marker.slice(4) + '\n' + JSON.stringify({name: scenario === 'tool-absent' ? 'absent' : 'team_get_status', input: {}}));
        }
        reply({stopReason:'end_turn'});
        break;
      }
      if (scenario === 'free_limit') {
        send({ id: request.id, error: { code: -32603, message: 'raw provider detail',
          data: { errorName: 'provider.free-limit' } } });
      } else if (scenario === 'pending' || scenario === 'stop_unconfirmed') {
        output(sessionId, 'started');
      } else {
        output('different-session', 'wrong');
        promptId = request.id;
        send({ id: 'permission', method: 'session/request_permission',
          params: { sessionId, options: [{ optionId: 'allow-always', kind: 'allow_always' }] } });
      }
      break;
    default:
      if (request.id === 'permission' && request.result?.outcome?.outcome === 'cancelled') {
        output(sessionId, 'expected');
        send({ id: promptId, result: { stopReason: 'end_turn' } });
      }
  }
});
`;

const id = 'external-acp-fixture';
const connection: ProviderConnection = {
  id: EXTERNAL_ACP_AGENTS[0].connectionId,
  providerId: 'opencode',
  displayName: 'OpenCode',
  runtimeKind: 'builtin_cli',
  enabled: true,
  secretReference: null,
  verification: { status: 'not_required', verifiedAt: null, expiresAt: null, message: null },
  rateLimit: {
    mode: 'bypass',
    maxConcurrentRequests: null,
    requestsPerMinute: null,
    tokensPerMinute: null,
    lastObservedRateLimitHeaders: null,
  },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('External ACP text chat', () => {
  const root = mkdtempSync(join(tmpdir(), 'sprint-acp-test-'));
  let runtime: ExternalAcpRuntime | undefined;
  afterEach(async () => {
    await runtime?.dispose();
    runtime = undefined;
    removeTreeWithoutFollowingLinksSync(root);
  });

  async function execute(
    behavior: string,
    onEvent?: (event: CanonicalProviderEvent) => void,
    request: Partial<ProviderExecutionRequest> = {},
  ) {
    scenario.behavior = behavior;
    const active = new ExternalAcpRuntime(EXTERNAL_ACP_AGENTS[0], root);
    runtime = active;
    const output: CanonicalProviderEvent[] = [];
    const signal = AbortSignal.timeout(10_000);
    for await (const event of active.execute(
      connection,
      {
        executionId: id,
        connectionId: connection.id,
        modelId,
        messages: [{ role: 'user', content: 'fixture chat' }],
        ...request,
      },
      signal,
    )) {
      output.push(event);
      onEvent?.(event);
    }
    return output;
  }

  it('decodes a split managed call, rejects unoffered tools and returns the actual result to the model', async () => {
    const tools = [
      { name: 'team_get_status', description: 'Team status', inputSchema: { type: 'object' } },
    ];
    expect(await execute('tool-call', undefined, { tools })).toMatchObject([
      { type: 'resolution' },
      { type: 'tool_call', name: 'team_get_status', input: {} },
      { type: 'completed', stopReason: 'tool_calls' },
    ]);
    const rejected = await execute('tool-absent', undefined, { tools });
    expect(rejected.some((e) => e.type === 'tool_call')).toBe(false);
    expect(rejected.at(-1)).toMatchObject({
      type: 'error',
      error: { providerCode: 'invalid_tool_request' },
    });
    expect(
      (
        await execute('tool-result', undefined, {
          tools,
          messages: [
            {
              role: 'assistant',
              content: '',
              toolCalls: [{ callId: 'call-1', name: 'team_get_status', input: {} }],
            },
            {
              role: 'tool',
              toolCallId: 'call-1',
              toolName: 'team_get_status',
              content: 'actual status',
            },
          ],
        })
      )[0],
    ).toEqual({ type: 'output_delta', text: 'used actual result' });
  });
  it('cancels reverse permission requests and discards frames from other sessions', async () => {
    expect(await execute('success')).toEqual([
      { type: 'output_delta', text: 'expected' },
      { type: 'resolution', resolution: { resolvedProvider: 'opencode', resolvedModel: modelId } },
      { type: 'completed', stopReason: 'end_turn' },
    ]);
  });

  it('reports free limits without returning raw provider errors or a completed turn', async () => {
    const events = await execute('free_limit');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'error',
      error: { category: 'rate_limited', providerCode: 'free_limit', retryable: false },
    });
    expect(JSON.stringify(events)).not.toContain('raw provider detail');
  });

  it('does not open a session on a CLI version without the required permissions', async () => {
    expect(await execute('old_version')).toMatchObject([
      { type: 'error', error: { providerCode: 'unsupported_cli_version' } },
    ]);
  });

  it('does not report cancellation success if CLI process exit cannot be confirmed', async () => {
    let stopped: Promise<unknown> | undefined;
    const events = await execute('stop_unconfirmed', (event) => {
      if (event.type === 'output_delta')
        stopped = runtime?.cancel(id).then(
          () => true,
          (error: unknown) => error,
        );
    });
    expect(await stopped).toMatchObject({ code: 'stop_unconfirmed' });
    await expect(runtime?.cancel(id)).rejects.toMatchObject({ code: 'stop_unconfirmed' });
    expect(events).toMatchObject([
      { type: 'output_delta', text: 'started' },
      { type: 'error', error: { providerCode: 'stop_unconfirmed' } },
    ]);
  });

  it('keeps a failed shutdown visible even when the session could not be initialized', async () => {
    expect(await execute('startup_stop_unconfirmed')).toMatchObject([
      { type: 'error', error: { providerCode: 'stop_unconfirmed' } },
    ]);
    await expect(runtime?.cancel(id)).rejects.toMatchObject({ code: 'stop_unconfirmed' });
  });

  it('stops an owned process and never marks the cancelled turn complete', async () => {
    let stopped: Promise<void> | undefined;
    const events = await execute('pending', (event) => {
      if (event.type === 'output_delta') stopped = runtime?.cancel(id);
    });
    await stopped;
    expect(events).toMatchObject([
      { type: 'output_delta', text: 'started' },
      { type: 'error', error: { category: 'canceled' } },
    ]);
  });
});
