import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runManagedLocalSelfTest,
  hasManagedLocalDraftEvidence,
  formatManagedLocalSelfTestDiagnostic,
  writeManagedLocalSelfTestDiagnostic,
} from './managed-local-self-test';
import type { ManagedLocalRuntimeSession } from './managed-local-runtime-supervisor';

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('Managed Local nonce rejection diagnostics', () => {
  beforeEach(() => vi.stubEnv('CI', 'true'));

  async function rejectedTool(
    parsed: unknown,
    metadata: { finish?: unknown; usage?: unknown } = {},
    expectedMessage = 'Self-test model returned the wrong nonce',
  ): Promise<Error> {
    const scratchRoot = await mkdtemp(join(tmpdir(), 'managed-local-nonce-observation-'));
    roots.push(scratchRoot);
    const requests: Record<string, unknown>[] = [];
    const session = {
      authenticatedFetch: async (_path: string, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return json(
          requests.length === 1
            ? { choices: [{ message: { content: 'READY' } }] }
            : {
                choices: [
                  {
                    ...(Object.hasOwn(metadata, 'finish')
                      ? { finish_reason: metadata.finish }
                      : {}),
                    message: {
                      content: 'PRIVATE_RESPONSE_TEXT',
                      tool_calls: [
                        {
                          id: 'PRIVATE_TOOL_CALL_ID',
                          function: {
                            name: 'sprint_self_test',
                            arguments: JSON.stringify(parsed),
                          },
                        },
                      ],
                    },
                  },
                ],
                ...(Object.hasOwn(metadata, 'usage') ? { usage: metadata.usage } : {}),
              },
        );
      },
    } as unknown as ManagedLocalRuntimeSession;
    const onLoaded = vi.fn();
    try {
      await runManagedLocalSelfTest({
        session,
        modelId: 'c'.repeat(64),
        scratchRoot,
        nonce: '11111111-1111-4111-8111-111111111111',
        onLoaded,
      });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      expect(error.message).toBe(expectedMessage);
      expect(onLoaded).toHaveBeenCalledOnce();
      expect(requests).toHaveLength(2);
      expect(requests[0]).toMatchObject({ max_tokens: 16, stream: false });
      expect(requests[1]).toMatchObject({
        max_tokens: 128,
        stream: false,
        reasoning_effort: 'none',
        chat_template_kwargs: { enable_thinking: false },
      });
      expect(requests[1]).not.toHaveProperty('temperature');
      expect(requests[1]).not.toHaveProperty('seed');
      expect(await readdir(scratchRoot)).toEqual([]);
      return error;
    }
    throw new Error('Controlled wrong nonce was accepted');
  }

  it.each(
    [
      null,
      [],
      'PRIVATE_NONCE_VALUE',
      {},
      { PRIVATE_KEY: 'PRIVATE_NONCE_VALUE' },
      { nonce: 42 },
      { nonce: { content: 'PRIVATE_NONCE_VALUE' } },
      { nonce: 'PRIVATE_NONCE_VALUE', PRIVATE_KEY: true },
    ].map((parsed, index) => [index, parsed] as const),
  )(
    'classifies rejected argument shapes without exposing their values (case %i)',
    async (_index, parsed) => {
      const error = await rejectedTool(parsed);
      const diagnostic = formatManagedLocalSelfTestDiagnostic(error);
      expect(diagnostic).toContain('"reason":"SHAPE_REJECT"');
      expect(diagnostic).not.toContain('PRIVATE_');
      expect(diagnostic).not.toContain('sprint_self_test');
      expect(diagnostic).not.toContain('11111111-1111-4111-8111-111111111111');
    },
  );

  it.each(['stop', 'tool_calls', 'length'])(
    'records allowlisted finish reason %s and bounded usage',
    async (finish) => {
      const error = await rejectedTool(
        { nonce: 'PRIVATE_NONCE_VALUE' },
        {
          finish,
          usage: {
            prompt_tokens: 200,
            completion_tokens: 128,
            completion_tokens_details: { reasoning_tokens: 0 },
          },
        },
      );
      const diagnostic = formatManagedLocalSelfTestDiagnostic(error);
      expect(diagnostic).toContain('"reason":"NONCE_VALUE_REJECT"');
      expect(diagnostic).toContain(`"finishReason":"${finish}"`);
      expect(diagnostic).toContain('"completionTokens":128');
      expect(diagnostic).toContain('"reasoningTokens":0');
      expect(diagnostic).not.toContain('PRIVATE_');
    },
  );

  it('maps missing, unknown and invalid response metadata to fixed markers', async () => {
    const missing = await rejectedTool({ nonce: 'PRIVATE_NONCE_VALUE' });
    expect(formatManagedLocalSelfTestDiagnostic(missing)).toContain('"finishReason":"MISSING"');
    const invalid = await rejectedTool(
      { nonce: 'PRIVATE_NONCE_VALUE' },
      {
        finish: 'PRIVATE_FINISH_REASON',
        usage: {
          prompt_tokens: -1,
          completion_tokens: 1.5,
          completion_tokens_details: { reasoning_tokens: 'PRIVATE_COUNTER' },
        },
      },
    );
    const diagnostic = formatManagedLocalSelfTestDiagnostic(invalid);
    expect(diagnostic).toContain('"finishReason":"UNKNOWN"');
    for (const name of ['promptTokens', 'completionTokens', 'reasoningTokens'])
      expect(diagnostic).toContain(`"${name}":"MISSING"`);
    expect(diagnostic).not.toContain('PRIVATE_');
  });

  it('bounds the one-line packet and preserves the original argument limit', async () => {
    const error = await rejectedTool(
      { nonce: 'x'.repeat(8180) },
      {
        finish: 'length',
        usage: {
          prompt_tokens: 1_000_000,
          completion_tokens: 1_000_000,
          completion_tokens_details: { reasoning_tokens: 1_000_000 },
        },
      },
    );
    const diagnostic = formatManagedLocalSelfTestDiagnostic(error)!;
    expect(diagnostic).toContain('"argumentsLength":8192');
    expect(Buffer.byteLength(diagnostic, 'utf8')).toBeLessThanOrEqual(512);
    expect(diagnostic.match(/\n/gu)).toHaveLength(1);
    const oversized = await rejectedTool(
      { nonce: 'x'.repeat(8181) },
      {},
      'Invalid self-test tool arguments',
    );
    expect(formatManagedLocalSelfTestDiagnostic(oversized)).toBeNull();
  });

  it('clamps key counts and does not serialize raw keys', async () => {
    const error = await rejectedTool(
      Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`PRIVATE_KEY_${index}`, true])),
    );
    const diagnostic = formatManagedLocalSelfTestDiagnostic(error);
    expect(diagnostic).toContain('"keyCount":8');
    expect(diagnostic).not.toContain('PRIVATE_');
  });

  it('rejects unrecognized, malformed, accessor or nonprimitive diagnostic causes', async () => {
    const error = await rejectedTool({ nonce: 'PRIVATE_NONCE_VALUE' });
    const cause = error.cause as Record<string, unknown>;
    for (const replacement of [
      { ...cause, tag: 'PRIVATE_TAG' },
      { ...cause, completionTokens: -1 },
      { ...cause, completionTokens: 1.5 },
      { ...cause, completionTokens: 1_000_001 },
      { ...cause, completionTokens: NaN },
      { ...cause, keyCount: 9 },
      { ...cause, PRIVATE_EXTRA: 'PRIVATE_NONCE_VALUE' },
      { ...cause, finishReason: { toString: () => 'length', toJSON: () => 'PRIVATE_NONCE_VALUE' } },
      Object.defineProperty({ ...cause }, 'completionTokens', { get: () => 'PRIVATE_NONCE_VALUE' }),
    ])
      expect(
        formatManagedLocalSelfTestDiagnostic(new Error('PRIVATE_ERROR', { cause: replacement })),
      ).toBeNull();
    expect(formatManagedLocalSelfTestDiagnostic(new Error('PRIVATE_API_ERROR'))).toBeNull();
    expect(formatManagedLocalSelfTestDiagnostic({ cause })).toBeNull();
    expect(
      formatManagedLocalSelfTestDiagnostic(
        new Proxy(
          {},
          {
            getPrototypeOf: () => {
              throw new Error('PRIVATE_PROTOTYPE_ERROR');
            },
          },
        ),
      ),
    ).toBeNull();
    const getterError = Object.defineProperty(new Error('PRIVATE_ERROR'), 'cause', {
      get: () => {
        throw new Error('PRIVATE_CAUSE_ERROR');
      },
    });
    expect(formatManagedLocalSelfTestDiagnostic(getterError)).toBeNull();
  });

  it('writes once and isolates stderr exceptions from the original rejection', async () => {
    const error = await rejectedTool({ nonce: 'PRIVATE_NONCE_VALUE' });
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    writeManagedLocalSelfTestDiagnostic(error);
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0]![0]).toBe(formatManagedLocalSelfTestDiagnostic(error));
    write.mockImplementation(() => {
      throw new Error('PRIVATE_LOGGER_ERROR');
    });
    expect(() => writeManagedLocalSelfTestDiagnostic(error)).not.toThrow();
    expect(error.message).toBe('Self-test model returned the wrong nonce');
  });

  it.each(['false', 'TRUE', undefined])(
    'produces no packet outside exact CI=true (CI=%s)',
    async (ci) => {
      const error = await rejectedTool({ nonce: 'PRIVATE_NONCE_VALUE' });
      vi.stubEnv('CI', ci);
      expect(formatManagedLocalSelfTestDiagnostic(error)).toBeNull();
      const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      writeManagedLocalSelfTestDiagnostic(error);
      expect(write).not.toHaveBeenCalled();
    },
  );
});

describe('runManagedLocalSelfTest', () => {
  it('does not promote a declared DFlash pair without deterministic text and real draft counts', async () => {
    for (const response of [
      {
        choices: [{ message: { content: 'unexpected' } }],
        timings: { draft_n: 12, draft_n_accepted: 9 },
      },
      { choices: [{ message: { content: 'one two three four five six seven eight nine ten' } }] },
    ]) {
      const onLoaded = vi.fn();
      const session = {
        authenticatedFetch: async () => json(response),
      } as unknown as ManagedLocalRuntimeSession;
      await expect(
        runManagedLocalSelfTest({
          session,
          modelId: 'a'.repeat(64),
          scratchRoot: '/unused',
          nonce: 'unused',
          onLoaded,
          requireDraft: true,
        }),
      ).rejects.toThrow('did not prove');
      expect(onLoaded).not.toHaveBeenCalled();
    }
  });
  it('cancels an oversized streamed response before recording load evidence', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 3; i++) controller.enqueue(new Uint8Array(512 * 1024));
      },
      cancel,
    });
    const onLoaded = vi.fn();
    const session = {
      authenticatedFetch: async () => new Response(body),
    } as unknown as ManagedLocalRuntimeSession;
    await expect(
      runManagedLocalSelfTest({
        session,
        modelId: 'a'.repeat(64),
        scratchRoot: '/unused',
        nonce: 'unused',
        onLoaded,
        requireDraft: true,
      }),
    ).rejects.toThrow('too large');
    expect(cancel).toHaveBeenCalledOnce();
    expect(onLoaded).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    'separates load evidence from an isolated nonce tool round-trip (draft=%s)',
    async (requireDraft) => {
      const scratchRoot = await mkdtemp(join(tmpdir(), 'managed-local-self-test-'));
      roots.push(scratchRoot);
      const nonce = '11111111-1111-4111-8111-111111111111';
      const requests: unknown[] = [];
      const authenticatedFetch = vi.fn(async (_path: string, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)) as unknown);
        if (requests.length === 1)
          return json({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: requireDraft
                    ? 'one two three four five six seven eight nine ten'
                    : 'READY',
                },
              },
            ],
            ...(requireDraft ? { timings: { draft_n: 12, draft_n_accepted: 9 } } : {}),
          });
        if (requests.length === 2)
          return json({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'call-1',
                      type: 'function',
                      function: {
                        name: 'sprint_self_test',
                        arguments: JSON.stringify({ nonce }),
                      },
                    },
                  ],
                },
              },
            ],
          });
        return json({ choices: [{ message: { role: 'assistant', content: 'DONE' } }] });
      });
      const onLoaded = vi.fn();
      const session = { authenticatedFetch } as unknown as ManagedLocalRuntimeSession;

      await runManagedLocalSelfTest({
        session,
        modelId: 'a'.repeat(64),
        scratchRoot,
        nonce,
        onLoaded,
        requireDraft,
      });

      expect(onLoaded).toHaveBeenCalledOnce();
      expect(authenticatedFetch).toHaveBeenCalledTimes(3);
      expect(requests[2]).toMatchObject({
        messages: [
          {},
          { tool_calls: [{ id: 'call-1' }] },
          { role: 'tool', tool_call_id: 'call-1' },
        ],
      });
      await expect(
        readFile(join(scratchRoot, `self-test-${nonce}`, 'nonce.txt')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('does not accept absent, zero, fractional or contradictory structured draft counts', () => {
    for (const timings of [
      null,
      {},
      { draft_n: 0, draft_n_accepted: 0 },
      { draft_n: 1.5, draft_n_accepted: 1 },
      { draft_n: 5, draft_n_accepted: 6 },
      { draft_n: '5', draft_n_accepted: 1 },
    ])
      expect(hasManagedLocalDraftEvidence({ timings })).toBe(false);
    expect(hasManagedLocalDraftEvidence({ timings: { draft_n: 5, draft_n_accepted: 0 } })).toBe(
      true,
    );
  });

  it('rejects a model that substitutes the nonce before touching the witness workspace', async () => {
    const scratchRoot = await mkdtemp(join(tmpdir(), 'managed-local-self-test-bad-'));
    roots.push(scratchRoot);
    let call = 0;
    const session = {
      authenticatedFetch: vi.fn(async () => {
        call += 1;
        return call === 1
          ? json({ choices: [{ message: { content: 'READY' } }] })
          : json({
              choices: [
                {
                  message: {
                    content: null,
                    tool_calls: [
                      {
                        id: 'call-bad',
                        function: {
                          name: 'sprint_self_test',
                          arguments: JSON.stringify({ nonce: 'wrong' }),
                        },
                      },
                    ],
                  },
                },
              ],
            });
      }),
    } as unknown as ManagedLocalRuntimeSession;

    await expect(
      runManagedLocalSelfTest({
        session,
        modelId: 'b'.repeat(64),
        scratchRoot,
        nonce: '22222222-2222-4222-8222-222222222222',
        onLoaded: () => undefined,
      }),
    ).rejects.toThrow('wrong nonce');
  });
});
