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
    nonce = '11111111-1111-4111-8111-111111111111',
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
        nonce,
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

  const EXPECTED = '11111111-1111-4111-8111-111111111111';
  const packet = (diagnostic: string | null) =>
    JSON.parse(diagnostic!.slice(diagnostic!.indexOf(':') + 1)) as Record<string, unknown>;

  it.each([
    {
      name: 'shorter',
      actual: '11111111-1111-4111-8111',
      expected: {
        lengthDelta: -13,
        firstMismatchIndex: 23,
        commonPrefixLength: 23,
        commonSuffixLength: 3,
        caseInsensitiveEqual: false,
        equalIgnoringNonAlnum: false,
        actualCharClass: 'OTHER',
      },
    },
    {
      name: 'one char substituted',
      actual: '11111111-1111-4111-8111-111111111112',
      expected: {
        lengthDelta: 0,
        firstMismatchIndex: 35,
        commonPrefixLength: 35,
        commonSuffixLength: 0,
        caseInsensitiveEqual: false,
        equalIgnoringNonAlnum: false,
        actualCharClass: 'OTHER',
      },
    },
    {
      name: 'appended',
      actual: `${EXPECTED}Z`,
      expected: {
        lengthDelta: 1,
        firstMismatchIndex: 36,
        commonPrefixLength: 36,
        commonSuffixLength: 0,
        caseInsensitiveEqual: false,
        equalIgnoringNonAlnum: false,
        actualCharClass: 'OTHER',
      },
    },
    {
      name: 'separators differ',
      actual: EXPECTED.replaceAll('-', '_'),
      expected: {
        lengthDelta: 0,
        firstMismatchIndex: 8,
        commonPrefixLength: 8,
        commonSuffixLength: 12,
        caseInsensitiveEqual: false,
        equalIgnoringNonAlnum: true,
        actualCharClass: 'OTHER',
      },
    },
    {
      name: 'separators removed',
      actual: EXPECTED.replaceAll('-', ''),
      expected: {
        lengthDelta: -4,
        firstMismatchIndex: 8,
        commonPrefixLength: 8,
        commonSuffixLength: 12,
        caseInsensitiveEqual: false,
        equalIgnoringNonAlnum: true,
        actualCharClass: 'HEX',
      },
    },
    {
      name: 'empty',
      actual: '',
      expected: {
        lengthDelta: -36,
        firstMismatchIndex: 0,
        commonPrefixLength: 0,
        commonSuffixLength: 0,
        caseInsensitiveEqual: false,
        equalIgnoringNonAlnum: false,
        actualCharClass: 'EMPTY',
      },
    },
    {
      name: 'alphanumeric non hex',
      actual: 'zzzz',
      expected: {
        lengthDelta: -32,
        firstMismatchIndex: 0,
        commonPrefixLength: 0,
        commonSuffixLength: 0,
        caseInsensitiveEqual: false,
        equalIgnoringNonAlnum: false,
        actualCharClass: 'ALNUM',
      },
    },
  ])(
    'adds fixed comparison primitives without the values ($name)',
    async ({ actual, expected }) => {
      const diagnostic = formatManagedLocalSelfTestDiagnostic(
        await rejectedTool({ nonce: actual }),
      );
      expect(packet(diagnostic)).toMatchObject({
        reason: 'NONCE_VALUE_REJECT',
        nonceLength: actual.length,
        expectedNonceLength: 36,
        ...expected,
      });
      expect(Buffer.byteLength(diagnostic!, 'utf8')).toBeLessThanOrEqual(640);
      expect(diagnostic!.match(/\n/gu)).toHaveLength(1);
      expect(diagnostic).not.toContain(EXPECTED);
      if (actual.length > 3) expect(diagnostic).not.toContain(actual);
      // No fragment (including 4-char runs) of either value may appear.
      for (const source of [EXPECTED, actual])
        for (let i = 0; i + 4 <= source.length; i += 1)
          if (/[A-Za-z0-9]/u.test(source.slice(i, i + 4)) && source.slice(i, i + 4) !== '1111')
            expect(diagnostic).not.toContain(source.slice(i, i + 4));
    },
  );

  it('detects a case-only difference', async () => {
    const mixedExpected = 'aB3dEf90-1234-4abc-8DEF-0123456789ab';
    const error = await rejectedTool(
      { nonce: mixedExpected.toLowerCase() },
      {},
      undefined,
      mixedExpected,
    );
    const diagnostic = formatManagedLocalSelfTestDiagnostic(error);
    expect(packet(diagnostic)).toMatchObject({
      caseInsensitiveEqual: true,
      equalIgnoringNonAlnum: false,
      firstMismatchIndex: 1,
      actualCharClass: 'OTHER',
    });
    expect(diagnostic).not.toContain(mixedExpected);
    expect(diagnostic).not.toContain(mixedExpected.toLowerCase());
    expect(diagnostic).not.toContain('aB3d');
    expect(diagnostic).not.toContain('a3dE');
  });
  it('omits comparison fields for shape rejections and clamps extremes', async () => {
    const shape = packet(formatManagedLocalSelfTestDiagnostic(await rejectedTool({ nonce: 42 })));
    for (const name of [
      'expectedNonceLength',
      'lengthDelta',
      'firstMismatchIndex',
      'commonPrefixLength',
      'commonSuffixLength',
      'caseInsensitiveEqual',
      'equalIgnoringNonAlnum',
      'actualCharClass',
    ])
      expect(shape).not.toHaveProperty(name);
    expect(Object.keys(shape)).toHaveLength(11);
    const big = packet(
      formatManagedLocalSelfTestDiagnostic(await rejectedTool({ nonce: '1'.repeat(8180) })),
    );
    expect(big).toMatchObject({
      lengthDelta: 8144,
      commonPrefixLength: 8,
      actualCharClass: 'HEX',
    });
  });

  it('rejects forged or inconsistent comparison fields', async () => {
    const error = await rejectedTool({ nonce: '11111111-1111-4111-8111-111111111112' });
    const cause = error.cause as Record<string, unknown>;
    for (const forged of [
      { expectedNonceLength: 8193 },
      { expectedNonceLength: 'PRIVATE_NONCE_VALUE' },
      { lengthDelta: 8193 },
      { lengthDelta: 1.5 },
      { lengthDelta: 'PRIVATE_NONCE_VALUE' },
      { commonPrefixLength: 37 },
      { commonPrefixLength: -1 },
      { commonSuffixLength: 37 },
      { firstMismatchIndex: 3 },
      { firstMismatchIndex: 'MISSING' },
      { firstMismatchIndex: 36 },
      { caseInsensitiveEqual: 'PRIVATE_NONCE_VALUE' },
      { equalIgnoringNonAlnum: 1 },
      { actualCharClass: 'PRIVATE_NONCE_VALUE' },
      { actualCharClass: 'MISSING' },
    ])
      expect(
        formatManagedLocalSelfTestDiagnostic(
          new Error('PRIVATE_ERROR', { cause: { ...cause, ...forged } }),
        ),
      ).toBeNull();
    const shapeCause = (await rejectedTool({ nonce: 42 })).cause as Record<string, unknown>;
    expect(
      formatManagedLocalSelfTestDiagnostic(
        new Error('PRIVATE_ERROR', { cause: { ...shapeCause, lengthDelta: 1 } }),
      ),
    ).toBeNull();
    for (const name of ['lengthDelta', 'actualCharClass'])
      expect(
        formatManagedLocalSelfTestDiagnostic(
          new Error('PRIVATE_ERROR', {
            cause: Object.defineProperty({ ...cause }, name, { get: () => 0 }),
          }),
        ),
      ).toBeNull();
  });

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
    expect(Buffer.byteLength(diagnostic, 'utf8')).toBeLessThanOrEqual(640);
    expect(diagnostic.match(/\n/gu)).toHaveLength(1);
    const oversized = await rejectedTool(
      { nonce: 'x'.repeat(8181) },
      {},
      'Invalid self-test tool arguments',
    );
    expect(formatManagedLocalSelfTestDiagnostic(oversized)).toBeNull();
  });

  it('keeps the worst-case maximal packet within the cap', async () => {
    const error = await rejectedTool(
      { nonce: '1'.repeat(8180) },
      {
        finish: 'tool_calls',
        usage: {
          prompt_tokens: 1_000_000,
          completion_tokens: 1_000_000,
          completion_tokens_details: { reasoning_tokens: 1_000_000 },
        },
      },
      undefined,
      '2'.repeat(8192),
    );
    const diagnostic = formatManagedLocalSelfTestDiagnostic(error)!;
    expect(packet(diagnostic)).toMatchObject({ expectedNonceLength: 8192, lengthDelta: -12 });
    expect(Buffer.byteLength(diagnostic, 'utf8')).toBeLessThanOrEqual(640);
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
