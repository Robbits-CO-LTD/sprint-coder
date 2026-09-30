import { ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type * as childProcess from 'node:child_process';
import { PassThrough } from 'node:stream';
import type { PublicError } from '@sprint-coder/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GrokRuntimeAdapter } from './grok-adapter';
import {
  isRuntimeFailureDiagnostic,
  type GrokProtocolDiagnostic,
  type RuntimeCanonicalEvent,
  type RuntimeFailureDiagnostic,
} from './protocol';

// Issue #506 Slice A: the adapter reads the real ACP transport while this file decides exactly
// which bytes arrive in which `data` event. A child process's writes can be coalesced or split
// by the OS, so data-event boundaries are only deterministic with an in-memory child.

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  stop: vi.fn<() => Promise<boolean>>(),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof childProcess>()),
  spawn: mocks.spawn,
}));
vi.mock('./process-tree', () => ({ terminateRuntimeProcessTree: mocks.stop }));
vi.mock('./grok-isolation', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  prepareGrokIsolation: () => ({
    directory: '/inert-grok-fixture',
    cwd: '/inert-grok-fixture/work',
    environment: {},
    cleanup: vi.fn(),
  }),
}));

const SESSION_ID = 'fixture-session-PRIVATE';
const fixtures: Array<{ adapter: GrokRuntimeAdapter; child: ChildProcessWithoutNullStreams }> = [];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.stop.mockResolvedValue(true);
});

afterEach(async () => {
  for (const { adapter, child } of fixtures.splice(0)) {
    adapter.dispose();
    child.emit('close', 0);
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  }
  await Promise.resolve();
});

/** Lets every pending continuation of the previous data event run. */
const nextDataEvent = () => new Promise<void>((resolve) => setImmediate(resolve));

const line = (value: unknown) => `${JSON.stringify({ jsonrpc: '2.0', ...(value as object) })}\n`;
const update = (value: unknown, sessionId = SESSION_ID) =>
  line({ method: 'session/update', params: { sessionId, update: value } });
const chunk = (text: string) =>
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
const INVENTORY = update({
  sessionUpdate: 'available_commands_update',
  _meta: { tools: ['search_tool', 'use_tool'] },
});

type Options = Readonly<{
  model?: string;
  /** Frames the fake sends just before its `session/new` reply. */
  beforeSession?: string;
  promptModel?: string;
}>;

async function startTurn(options: Options = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  // No OS process is started. Only the real ACP transport and adapter lifecycle run.
  const child = Object.assign(new ChildProcess(), {
    stdin,
    stdout,
    stderr,
    stdio: [stdin, stdout, stderr, null, null],
  }) as ChildProcessWithoutNullStreams;
  mocks.spawn.mockReturnValue(child);
  let framesSent = 0;
  /** Delivers these bytes as exactly one `data` event. */
  const deliver = (bytes: Buffer | string) => {
    const buffer = typeof bytes === 'string' ? Buffer.from(bytes) : bytes;
    framesSent += buffer.toString('utf8').split('\n').length - 1;
    stdout.emit('data', buffer);
  };
  let promptId: unknown;
  let pendingInput = '';
  stdin.on('data', (data: Buffer) => {
    pendingInput += data.toString('utf8');
    let index: number;
    while ((index = pendingInput.indexOf('\n')) >= 0) {
      const request = JSON.parse(pendingInput.slice(0, index)) as Record<string, unknown>;
      pendingInput = pendingInput.slice(index + 1);
      if (!('method' in request) || !('id' in request)) continue;
      const reply = (result: unknown) => deliver(line({ id: request['id'], result }));
      switch (request['method']) {
        case 'initialize':
          reply({ _meta: { grokShell: true }, authMethods: [{ id: 'cached_token' }] });
          break;
        case 'authenticate':
          reply({});
          break;
        case 'session/new':
          deliver(options.beforeSession ?? INVENTORY);
          reply({ sessionId: SESSION_ID, models: { currentModelId: 'grok-fixture' } });
          break;
        case 'session/set_model':
          reply({
            _meta: { model: { Ok: (request['params'] as Record<string, unknown>)['modelId'] } },
          });
          break;
        case '_x.ai/mcp/list':
          reply({ servers: [], sessionMcpResolved: true });
          break;
        case 'session/prompt':
          promptId = request['id'];
          break;
        default:
          throw new Error('Unexpected fixture RPC');
      }
    }
  });
  const adapter = new GrokRuntimeAdapter();
  fixtures.push({ adapter, child });
  adapter.setCliResolution({
    executable: '/inert-grok-fixture/grok',
    source: 'explicit',
    version: 'grok 1.0.40',
    compatibility: 'compatible',
    capabilities: ['acp'],
  });
  const events: RuntimeCanonicalEvent[] = [];
  const failures: Array<{ error: PublicError; diagnostic: RuntimeFailureDiagnostic | undefined }> =
    [];
  adapter.start(
    'turn',
    'Synthetic request',
    [],
    vi.fn(),
    null,
    options.model ?? 'auto',
    (event) => events.push(event),
    (error, diagnostic) => failures.push({ error, diagnostic }),
    vi.fn(),
  );
  child.emit('spawn');
  const promptReply = (payload: Record<string, unknown>) => line({ id: promptId, ...payload });
  const result = (stopReason = 'end_turn') =>
    promptReply({
      result: {
        stopReason,
        ...(options.promptModel === undefined ? {} : { _meta: { modelId: options.promptModel } }),
      },
    });
  const settled = () =>
    vi.waitFor(() =>
      expect(failures.length + events.filter((e) => e.type === 'completed').length).toBe(1),
    );
  const text = () =>
    events.flatMap((event) => (event.type === 'delta' ? [event.delta] : [])).join('');
  const completions = () => events.filter((event) => event.type === 'completed');
  /** The only failure, checked to be a valid Grok diagnostic that carries no private value. */
  const protocol = (): GrokProtocolDiagnostic => {
    expect(failures).toHaveLength(1);
    const diagnostic = failures[0]?.diagnostic;
    expect(isRuntimeFailureDiagnostic(diagnostic)).toBe(true);
    expect(JSON.stringify(diagnostic)).not.toMatch(/PRIVATE|こんにちは|search_tool/u);
    expect(diagnostic?.grokProtocol).toBeDefined();
    return diagnostic!.grokProtocol!;
  };
  const waitForPrompt = async () => {
    await vi.waitFor(() => expect(promptId).toBeDefined());
    return framesSent;
  };
  return {
    adapter,
    child,
    deliver,
    events,
    failures,
    promptReply,
    result,
    settled,
    text,
    completions,
    protocol,
    waitForPrompt,
    framesSent: () => framesSent,
  };
}

/** Splits `wire` at byte offsets into consecutive data events. */
function splitAt(wire: Buffer, offsets: readonly number[]): Buffer[] {
  const bounds = [0, ...offsets, wire.length];
  return bounds.slice(1).map((end, index) => wire.subarray(bounds[index], end));
}

async function deliverEach(turn: Awaited<ReturnType<typeof startTurn>>, parts: readonly Buffer[]) {
  for (const part of parts) {
    turn.deliver(part);
    await nextDataEvent();
  }
}

describe('Grok prompt result and text order across data events (issue #506)', () => {
  const HEAD = 'こんにちは、';
  const TAIL = '世界🚀';

  const bodyThenResult = (turn: Awaited<ReturnType<typeof startTurn>>) =>
    Buffer.from(chunk(HEAD) + chunk(TAIL) + turn.result());

  const splits: ReadonlyArray<readonly [string, (wire: Buffer) => number[]]> = [
    ['in one data event', () => []],
    [
      'one data event per line',
      (wire) => {
        const offsets: number[] = [];
        for (let index = wire.indexOf(10); index >= 0; index = wire.indexOf(10, index + 1))
          if (index + 1 < wire.length) offsets.push(index + 1);
        return offsets;
      },
    ],
    ['split inside a line', (wire) => [Math.floor(wire.indexOf(10) / 2)]],
    [
      'split inside a multi-byte UTF-8 character',
      (wire) => [wire.indexOf(Buffer.from('に')) + 1, wire.indexOf(Buffer.from('🚀')) + 2],
    ],
  ];

  it.each(splits)('text then result: completes once with the whole text (%s)', async (_, at) => {
    const turn = await startTurn();
    await turn.waitForPrompt();
    const wire = bodyThenResult(turn);
    const parts = splitAt(wire, at(wire));
    expect(Buffer.concat(parts).equals(wire)).toBe(true);
    await deliverEach(turn, parts);
    await turn.settled();
    expect(turn.failures).toEqual([]);
    expect(turn.text()).toBe(HEAD + TAIL);
    expect(turn.completions()).toHaveLength(1);
  });

  // Characterization of orders that break the ACP contract (text after the prompt result). These
  // pin what happens today and are not the desired contract. Slice B observed grok 1.0.41 (4 real
  // turns, 2026-09-30) sending every agent_message_chunk, then response_completed and
  // turn_completed, before the result, and no text after it. Following the #506 plan, completion
  // therefore gets no drain until a real CLI is seen sending text after its result.
  it('result then text in one data event: completes with the whole text (Slice C current behavior)', async () => {
    const turn = await startTurn();
    await turn.waitForPrompt();
    await deliverEach(turn, [Buffer.from(turn.result() + chunk(HEAD + TAIL))]);
    await turn.settled();
    expect(turn.failures).toEqual([]);
    expect(turn.text()).toBe(HEAD + TAIL);
    expect(turn.completions()).toHaveLength(1);
  });

  it('result then text in separate data events: fails as having no text (Slice C current behavior)', async () => {
    const turn = await startTurn();
    const before = await turn.waitForPrompt();
    await deliverEach(turn, [Buffer.from(turn.result()), Buffer.from(chunk(HEAD + TAIL))]);
    await turn.settled();
    expect(turn.failures[0]?.error.code).toBe('RUNTIME_PROTOCOL_ERROR');
    expect(turn.completions()).toHaveLength(0);
    expect(turn.text()).toBe('');
    expect(turn.protocol()).toEqual({
      phase: 'prompt',
      failureCode: 'turn_no_assistant_text',
      promptResultReceived: true,
      stopReason: 'end_turn',
      receivedFrames: before + 1,
      promptResultFrame: before + 1,
      lastSessionUpdateFrame: expect.any(Number),
      lastSessionUpdate: 'available_commands_update',
      lastMessageChunkFrame: null,
      assistantTextObserved: false,
      assistantTextChars: 0,
      pendingToolCount: 0,
      partialFrame: false,
      stopConfirmation: 'confirmed',
    });
  });

  it('text head, result and text tail in one data event: completes with the whole text (Slice C current behavior)', async () => {
    const turn = await startTurn();
    await turn.waitForPrompt();
    await deliverEach(turn, [Buffer.from(chunk(HEAD) + turn.result() + chunk(TAIL))]);
    await turn.settled();
    expect(turn.failures).toEqual([]);
    expect(turn.text()).toBe(HEAD + TAIL);
    expect(turn.completions()).toHaveLength(1);
  });

  it('text head and result, then the tail in a later data event: completes without the tail (Slice C current behavior)', async () => {
    const turn = await startTurn();
    await turn.waitForPrompt();
    await deliverEach(turn, [Buffer.from(chunk(HEAD) + turn.result()), Buffer.from(chunk(TAIL))]);
    await turn.settled();
    expect(turn.failures).toEqual([]);
    expect(turn.text()).toBe(HEAD);
    expect(turn.completions()).toHaveLength(1);
  });
});

describe('Grok protocol diagnostic failure codes (issue #506)', () => {
  it.each([
    ['max_tokens', 'turn_stop_reason', 'max_tokens'],
    ['refusal', 'turn_stop_reason', 'refusal'],
    ['PRIVATE_future_reason', 'turn_stop_reason', 'other'],
  ] as const)(
    'records a %s stop reason after text as %s',
    async (stopReason, failureCode, normalized) => {
      const turn = await startTurn();
      const before = await turn.waitForPrompt();
      await deliverEach(turn, [Buffer.from(chunk('こんにちは') + turn.result(stopReason))]);
      await turn.settled();
      expect(turn.protocol()).toMatchObject({
        phase: 'prompt',
        failureCode,
        stopReason: normalized,
        promptResultReceived: true,
        promptResultFrame: before + 2,
        lastMessageChunkFrame: before + 1,
        lastSessionUpdateFrame: before + 1,
        lastSessionUpdate: 'agent_message_chunk',
        assistantTextObserved: true,
        assistantTextChars: 'こんにちは'.length,
      });
    },
  );

  it('names the Grok turn_completed update that precedes the result', async () => {
    const turn = await startTurn();
    const before = await turn.waitForPrompt();
    // The order grok 1.0.41 sent in Slice B, with a stop reason that fails the Turn.
    await deliverEach(turn, [
      Buffer.from(
        chunk('こんにちは') +
          update({ sessionUpdate: 'response_completed' }) +
          update({ sessionUpdate: 'turn_completed' }) +
          turn.result('max_tokens'),
      ),
    ]);
    await turn.settled();
    expect(turn.protocol()).toMatchObject({
      failureCode: 'turn_stop_reason',
      lastSessionUpdate: 'turn_completed',
      lastSessionUpdateFrame: before + 3,
      promptResultFrame: before + 4,
      lastMessageChunkFrame: before + 1,
    });
  });

  it('records a tool still pending at the result', async () => {
    const turn = await startTurn();
    await turn.waitForPrompt();
    await deliverEach(turn, [
      Buffer.from(
        update({ sessionUpdate: 'tool_call', toolCallId: 'PRIVATE_tool', status: 'in_progress' }) +
          chunk('こんにちは') +
          turn.result(),
      ),
    ]);
    await turn.settled();
    expect(turn.protocol()).toMatchObject({
      failureCode: 'turn_pending_tools',
      pendingToolCount: 1,
      assistantTextObserved: true,
    });
  });

  it('counts whitespace-only text without treating it as an answer', async () => {
    const turn = await startTurn();
    await turn.waitForPrompt();
    await deliverEach(turn, [Buffer.from(chunk('  \n') + turn.result())]);
    await turn.settled();
    expect(turn.protocol()).toMatchObject({
      failureCode: 'turn_no_assistant_text',
      assistantTextObserved: false,
      assistantTextChars: 3,
    });
  });

  it.each([
    [
      'a foreign session',
      (): string => update({ sessionUpdate: 'plan' }, 'PRIVATE_other'),
      'session_mismatch',
      1,
    ],
    [
      'an invalid tool identity',
      (): string => update({ sessionUpdate: 'tool_call', toolCallId: 5 }),
      'invalid_tool_identity',
      1,
    ],
    [
      'more than 128 pending tools',
      (): string =>
        Array.from({ length: 129 }, (_, index) =>
          update({ sessionUpdate: 'tool_call', toolCallId: `t${index}` }),
        ).join(''),
      'too_many_tools',
      129,
    ],
    ['a malformed update', (): string => update([]), 'session_update_invalid', 1],
    [
      'a rogue tool inventory',
      (): string =>
        update({
          sessionUpdate: 'available_commands_update',
          _meta: { tools: ['search_tool', 'use_tool', 'bash'] },
        }),
      'inventory_violation',
      1,
    ],
    ['an unparsable frame', (): string => 'not-json\n', 'json_parse_failed', 1],
    ['an invalid RPC frame', (): string => '[]\n', 'rpc_invalid', 1],
  ] as const)(
    'records %s during the prompt as %s',
    async (_, frames, failureCode, failingFrame) => {
      const turn = await startTurn();
      const before = await turn.waitForPrompt();
      await deliverEach(turn, [Buffer.from(frames())]);
      await turn.settled();
      expect(turn.failures[0]?.error.code).toBe('RUNTIME_PROTOCOL_ERROR');
      const protocol = turn.protocol();
      expect(protocol).toMatchObject({
        phase: 'prompt',
        failureCode,
        promptResultReceived: false,
        stopReason: null,
      });
      // Counted up to the frame that failed; frames after it are not.
      expect(protocol.receivedFrames).toBe(before + failingFrame);
    },
  );

  it.each([
    [
      'text before the tool inventory',
      chunk('PRIVATE early text'),
      'content_before_inventory',
      'inventory',
    ],
    ['more than 256 updates before the session', INVENTORY.repeat(257), 'startup_quota', 'session'],
  ] as const)('records %s as %s', async (_, beforeSession, failureCode, phase) => {
    const turn = await startTurn({ beforeSession });
    await turn.settled();
    expect(turn.protocol()).toMatchObject({ phase, failureCode, promptResultReceived: false });
  });

  it('records a model that differs from the bound one', async () => {
    const turn = await startTurn({ model: 'grok-4.6', promptModel: 'grok-other' });
    await turn.waitForPrompt();
    await deliverEach(turn, [Buffer.from(chunk('こんにちは') + turn.result())]);
    await turn.settled();
    expect(turn.protocol()).toMatchObject({
      phase: 'prompt',
      failureCode: 'model_mismatch',
      promptResultReceived: true,
    });
  });

  it('records a process exit before the result with the unterminated tail', async () => {
    const turn = await startTurn();
    await turn.waitForPrompt();
    await deliverEach(turn, [Buffer.from(chunk('こんにちは') + '{"jsonrpc":')]);
    turn.child.emit('close', 0);
    await turn.settled();
    expect(turn.protocol()).toMatchObject({
      phase: 'prompt',
      failureCode: 'process_exited',
      partialFrame: true,
      assistantTextObserved: true,
      promptResultReceived: false,
    });
  });

  it('keeps the Grok billing stage and HTTP status beside the RPC failure code', async () => {
    const turn = await startTurn();
    await turn.waitForPrompt();
    turn.deliver(
      turn.promptReply({
        error: { code: -32603, message: 'Internal error', data: { http_status: 402 } },
      }),
    );
    await turn.settled();
    expect(turn.failures[0]?.error.code).toBe('RUNTIME_BILLING_REQUIRED');
    expect(turn.failures[0]?.diagnostic).toMatchObject({
      failureStage: 'billing_error',
      httpStatus: 402,
      grokProtocol: { phase: 'prompt', failureCode: 'rpc_billing' },
    });
  });

  it('records an unconfirmed stop after the result in the stopping phase', async () => {
    mocks.stop.mockResolvedValue(false);
    const turn = await startTurn();
    await turn.waitForPrompt();
    await deliverEach(turn, [Buffer.from(chunk('こんにちは') + turn.result())]);
    await turn.settled();
    expect(turn.failures[0]?.error.code).toBe('RUNTIME_STOP_UNCONFIRMED');
    expect(turn.protocol()).toMatchObject({
      phase: 'stopping',
      failureCode: 'stop_unconfirmed',
      promptResultReceived: true,
      stopReason: 'end_turn',
      stopConfirmation: 'unconfirmed',
    });
  });

  it('fixes the first failure while its stop is confirmed; later frames and failures cannot rewrite it', async () => {
    let confirmStop!: (stopped: boolean) => void;
    mocks.stop.mockReturnValue(
      new Promise<boolean>((resolve) => {
        confirmStop = resolve;
      }),
    );
    const turn = await startTurn();
    const before = await turn.waitForPrompt();
    await deliverEach(turn, [Buffer.from(chunk('こんにちは') + turn.result('max_tokens'))]);
    await vi.waitFor(() => expect(mocks.stop).toHaveBeenCalled());
    // Arrives during stop confirmation: more text, a pending tool, a broken frame and an exit.
    await deliverEach(turn, [
      Buffer.from(
        chunk('PRIVATE late text') +
          update({ sessionUpdate: 'tool_call', toolCallId: 'late' }) +
          'not-json\n{"partial":',
      ),
    ]);
    turn.child.emit('close', 1);
    confirmStop(true);
    await turn.settled();
    expect(turn.protocol()).toEqual({
      phase: 'prompt',
      failureCode: 'turn_stop_reason',
      promptResultReceived: true,
      stopReason: 'max_tokens',
      receivedFrames: before + 2,
      promptResultFrame: before + 2,
      lastSessionUpdateFrame: before + 1,
      lastSessionUpdate: 'agent_message_chunk',
      lastMessageChunkFrame: before + 1,
      assistantTextObserved: true,
      assistantTextChars: 'こんにちは'.length,
      pendingToolCount: 0,
      partialFrame: false,
      stopConfirmation: 'confirmed',
    });
    expect(turn.text()).toBe('こんにちは');
  });
});
