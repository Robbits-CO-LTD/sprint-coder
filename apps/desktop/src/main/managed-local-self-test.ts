import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ManagedLocalRuntimeSession } from './managed-local-runtime-supervisor';

const MAX_RESPONSE_BYTES = 1024 * 1024;
const SELF_TEST_COMPLETION_TIMEOUT_MS = 120_000;
const NONCE_DIAGNOSTIC_TAG = 'MANAGED_LOCAL_SELF_TEST_NONCE_V1';
const NONCE_DIAGNOSTIC_FIELDS = [
  'tag',
  'reason',
  'argumentsLength',
  'keyCount',
  'noncePresent',
  'nonceIsString',
  'nonceLength',
  'expectedNonceLength',
  'lengthDelta',
  'firstMismatchIndex',
  'commonPrefixLength',
  'commonSuffixLength',
  'caseInsensitiveEqual',
  'equalIgnoringNonAlnum',
  'actualCharClass',
  'finishReason',
  'promptTokens',
  'completionTokens',
  'reasoningTokens',
] as const;
const NONCE_LENGTH_LIMIT = 8192;
// Worst-case valid packet (all clamps at maximum) is about 550 bytes; over the cap is dropped, not truncated.
const MAX_DIAGNOSTIC_BYTES = 640;
const COMPARISON_FIELDS: readonly string[] = NONCE_DIAGNOSTIC_FIELDS.slice(7, 15);

export async function runManagedLocalSelfTest(
  input: Readonly<{
    session: ManagedLocalRuntimeSession;
    modelId: string;
    scratchRoot: string;
    nonce: string;
    onLoaded(): void | Promise<void>;
    requireDraft?: boolean;
  }>,
): Promise<void> {
  const expected =
    input.requireDraft === true ? 'one two three four five six seven eight nine ten' : 'READY';
  const baseMessages = [{ role: 'user', content: `Reply with exactly: ${expected}` }];
  const loaded = await completion(input.session, {
    model: input.modelId,
    stream: false,
    messages: baseMessages,
    max_tokens: input.requireDraft === true ? 64 : 16,
    ...(input.requireDraft === true ? { temperature: 0, seed: 0 } : {}),
  });
  if (messageContent(loaded).trim().length === 0)
    throw new Error('Managed Local chat self-test returned no text');
  if (
    input.requireDraft === true &&
    (messageContent(loaded).trim() !== expected || !hasManagedLocalDraftEvidence(loaded))
  )
    throw new Error('DFlash self-test did not prove deterministic draft generation');
  await input.onLoaded();

  const toolName = 'sprint_self_test';
  const toolPrompt = `Call ${toolName} once with nonce ${input.nonce}.`;
  const requested = await completion(input.session, {
    model: input.modelId,
    stream: false,
    messages: [{ role: 'user', content: toolPrompt }],
    tools: [
      {
        type: 'function',
        function: {
          name: toolName,
          description: 'Writes and reads a nonce in an isolated self-test workspace.',
          parameters: {
            type: 'object',
            properties: { nonce: { type: 'string' } },
            required: ['nonce'],
            additionalProperties: false,
          },
        },
      },
    ],
    tool_choice: { type: 'function', function: { name: toolName } },
    max_tokens: 128,
  });
  const call = toolCall(requested, toolName, input.nonce);
  const workspace = join(input.scratchRoot, `self-test-${input.nonce}`);
  const witness = join(workspace, 'nonce.txt');
  try {
    await mkdir(workspace, { mode: 0o700 });
    await writeFile(witness, input.nonce, { flag: 'wx', mode: 0o600 });
    if ((await readFile(witness, 'utf8')) !== input.nonce)
      throw new Error('Managed Local self-test witness changed');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
  const finished = await completion(input.session, {
    model: input.modelId,
    stream: false,
    messages: [
      { role: 'user', content: toolPrompt },
      {
        role: 'assistant',
        content: null,
        tool_calls: [call],
      },
      {
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify({ ok: true, nonce: input.nonce }),
      },
    ],
    max_tokens: 32,
  });
  if (messageContent(finished).trim().length === 0)
    throw new Error('Managed Local tool self-test did not complete after the tool result');
}

export function hasManagedLocalDraftEvidence(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const timings = (value as Record<string, unknown>)['timings'];
  if (timings === null || typeof timings !== 'object') return false;
  const { draft_n: draft, draft_n_accepted: accepted } = timings as Record<string, unknown>;
  return (
    typeof draft === 'number' &&
    Number.isSafeInteger(draft) &&
    draft > 0 &&
    draft <= 1_000_000 &&
    typeof accepted === 'number' &&
    Number.isSafeInteger(accepted) &&
    accepted >= 0 &&
    accepted <= draft
  );
}

async function completion(
  session: ManagedLocalRuntimeSession,
  body: Record<string, unknown>,
): Promise<unknown> {
  const response = await session.authenticatedFetch('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...body,
      reasoning_effort: 'none',
      chat_template_kwargs: { enable_thinking: false },
    }),
    signal: AbortSignal.timeout(SELF_TEST_COMPLETION_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Managed Local self-test HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES)
    throw new Error('Managed Local self-test response is too large');
  if (response.body === null) throw new Error('Managed Local self-test response is empty');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error('Managed Local self-test response is too large');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
  ) as unknown;
}

function message(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object') throw new Error('Invalid self-test response');
  const choices = (value as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length !== 1) throw new Error('Invalid self-test choices');
  const first = choices[0];
  if (first === null || typeof first !== 'object') throw new Error('Invalid self-test choice');
  const candidate = (first as Record<string, unknown>).message;
  if (candidate === null || typeof candidate !== 'object')
    throw new Error('Invalid self-test message');
  return candidate as Record<string, unknown>;
}

function messageContent(value: unknown): string {
  const content = message(value).content;
  if (typeof content !== 'string') throw new Error('Invalid self-test text');
  return content;
}

function toolCall(value: unknown, name: string, nonce: string): Record<string, unknown> {
  const calls = message(value).tool_calls;
  if (!Array.isArray(calls) || calls.length !== 1) throw new Error('Invalid self-test tool count');
  const call = calls[0];
  if (call === null || typeof call !== 'object') throw new Error('Invalid self-test tool call');
  const record = call as Record<string, unknown>;
  const fn = record.function;
  if (
    typeof record.id !== 'string' ||
    record.id.length < 1 ||
    fn === null ||
    typeof fn !== 'object' ||
    (fn as Record<string, unknown>).name !== name
  )
    throw new Error('Invalid self-test tool identity');
  const args = (fn as Record<string, unknown>).arguments;
  if (typeof args !== 'string' || args.length > 8_192)
    throw new Error('Invalid self-test tool arguments');
  const parsed = JSON.parse(args) as unknown;
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 1 ||
    (parsed as Record<string, unknown>).nonce !== nonce
  )
    throw new Error('Self-test model returned the wrong nonce', {
      cause: safeNonceDiagnostic(value, parsed, args.length, nonce),
    });
  return record;
}

function safeNonceDiagnostic(
  value: unknown,
  parsed: unknown,
  argumentsLength: number,
  expectedNonce: string,
) {
  try {
    return nonceDiagnostic(value, parsed, argumentsLength, expectedNonce);
  } catch {
    return undefined; // Observation must never replace the original nonce rejection.
  }
}

function diagnosticObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function diagnosticCounter(value: unknown): number | 'MISSING' {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 1_000_000
    ? value
    : 'MISSING';
}

// Compares only lengths and positions; neither nonce nor any fragment of it leaves this function.
function nonceComparison(actual: string, expected: string) {
  const limit = Math.min(actual.length, expected.length, NONCE_LENGTH_LIMIT);
  let prefix = 0;
  while (prefix < limit && actual.charCodeAt(prefix) === expected.charCodeAt(prefix)) prefix += 1;
  let suffix = 0;
  while (
    suffix < limit &&
    actual.charCodeAt(actual.length - 1 - suffix) ===
      expected.charCodeAt(expected.length - 1 - suffix)
  )
    suffix += 1;
  const alnumOnly = (text: string) => text.replace(/[^0-9A-Za-z]/gu, '');
  return {
    lengthDelta: Math.max(
      -NONCE_LENGTH_LIMIT,
      Math.min(NONCE_LENGTH_LIMIT, actual.length - expected.length),
    ),
    firstMismatchIndex: actual === expected ? ('NONE' as const) : prefix,
    commonPrefixLength: prefix,
    commonSuffixLength: suffix,
    caseInsensitiveEqual: actual.toLowerCase() === expected.toLowerCase(),
    equalIgnoringNonAlnum: alnumOnly(actual) === alnumOnly(expected),
    actualCharClass:
      actual.length === 0
        ? ('EMPTY' as const)
        : /^[0-9A-Fa-f]+$/u.test(actual)
          ? ('HEX' as const)
          : /^[0-9A-Za-z]+$/u.test(actual)
            ? ('ALNUM' as const)
            : ('OTHER' as const),
  };
}

function nonceDiagnostic(
  value: unknown,
  parsed: unknown,
  argumentsLength: number,
  expectedNonce: string,
) {
  const args = diagnosticObject(parsed);
  const keys = args === null ? 0 : Object.keys(args).length;
  const noncePresent = args !== null && Object.hasOwn(args, 'nonce');
  const nonce = noncePresent ? args?.['nonce'] : undefined;
  const nonceIsString = typeof nonce === 'string';
  const response = diagnosticObject(value);
  const choices = response?.['choices'];
  const choice = Array.isArray(choices) ? diagnosticObject(choices[0]) : null;
  const finish = choice?.['finish_reason'];
  const finishReason =
    choice === null || !Object.hasOwn(choice, 'finish_reason')
      ? 'MISSING'
      : finish === 'stop' || finish === 'tool_calls' || finish === 'length'
        ? finish
        : 'UNKNOWN';
  const comparison = nonceIsString ? nonceComparison(nonce, expectedNonce) : null;
  const usage = diagnosticObject(response?.['usage']);
  const details = diagnosticObject(usage?.['completion_tokens_details']);
  return Object.freeze({
    tag: NONCE_DIAGNOSTIC_TAG,
    reason:
      args === null || keys !== 1 || !noncePresent || !nonceIsString
        ? 'SHAPE_REJECT'
        : 'NONCE_VALUE_REJECT',
    argumentsLength,
    keyCount: Math.min(keys, 8),
    noncePresent,
    nonceIsString,
    nonceLength: nonceIsString ? Math.min(nonce.length, 8192) : 'MISSING',
    ...(comparison === null
      ? {}
      : {
          expectedNonceLength: Math.min(expectedNonce.length, NONCE_LENGTH_LIMIT),
          ...comparison,
        }),
    finishReason,
    promptTokens: diagnosticCounter(usage?.['prompt_tokens']),
    completionTokens: diagnosticCounter(usage?.['completion_tokens']),
    reasoningTokens: diagnosticCounter(details?.['reasoning_tokens']),
  });
}

// This private cause tag identifies diagnostic shape, not provenance or authority.
export function formatManagedLocalSelfTestDiagnostic(error: unknown): string | null {
  try {
    if (process.env['CI'] !== 'true' || !(error instanceof Error)) return null;
    const cause = diagnosticObject(error.cause);
    if (cause === null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(cause);
    // The comparison fields exist only on a NONCE_VALUE_REJECT-shaped packet (nonce is a string).
    const withComparison = descriptors['nonceIsString']?.value === true;
    const names = NONCE_DIAGNOSTIC_FIELDS.filter(
      (name) => withComparison || !COMPARISON_FIELDS.includes(name),
    );
    if (Reflect.ownKeys(descriptors).length !== names.length) return null;
    const fields: Record<string, unknown> = {};
    for (const name of names) {
      const descriptor = descriptors[name];
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) return null;
      fields[name] = descriptor.value;
    }
    const bounded = (value: unknown, maximum: number) =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
    const finishReason = fields['finishReason'];
    const validComparison = () => {
      if (!withComparison) return true;
      const delta = fields['lengthDelta'];
      const ceiling = Math.min(
        fields['nonceLength'] as number,
        fields['expectedNonceLength'] as number,
      );
      const prefix = fields['commonPrefixLength'];
      return (
        bounded(fields['expectedNonceLength'], 8192) &&
        typeof delta === 'number' &&
        Number.isSafeInteger(delta) &&
        Math.abs(delta) <= 8192 &&
        bounded(prefix, ceiling) &&
        bounded(fields['commonSuffixLength'], ceiling) &&
        (fields['firstMismatchIndex'] === 'NONE' || fields['firstMismatchIndex'] === prefix) &&
        typeof fields['caseInsensitiveEqual'] === 'boolean' &&
        typeof fields['equalIgnoringNonAlnum'] === 'boolean' &&
        typeof fields['actualCharClass'] === 'string' &&
        ['HEX', 'ALNUM', 'OTHER', 'EMPTY'].includes(fields['actualCharClass'])
      );
    };
    if (
      !validComparison() ||
      fields['tag'] !== NONCE_DIAGNOSTIC_TAG ||
      (fields['reason'] !== 'SHAPE_REJECT' && fields['reason'] !== 'NONCE_VALUE_REJECT') ||
      !bounded(fields['argumentsLength'], 8192) ||
      !bounded(fields['keyCount'], 8) ||
      typeof fields['noncePresent'] !== 'boolean' ||
      typeof fields['nonceIsString'] !== 'boolean' ||
      (fields['nonceIsString']
        ? !fields['noncePresent'] || !bounded(fields['nonceLength'], 8192)
        : fields['nonceLength'] !== 'MISSING') ||
      typeof finishReason !== 'string' ||
      !['stop', 'tool_calls', 'length', 'UNKNOWN', 'MISSING'].includes(finishReason) ||
      ['promptTokens', 'completionTokens', 'reasoningTokens'].some(
        (name) => fields[name] !== 'MISSING' && !bounded(fields[name], 1_000_000),
      ) ||
      (fields['reason'] === 'NONCE_VALUE_REJECT') !==
        (fields['keyCount'] === 1 && fields['noncePresent'] && fields['nonceIsString'])
    )
      return null;
    const line = `MANAGED_LOCAL_SELF_TEST_NONCE_DIAGNOSTIC:${JSON.stringify(fields)}\n`;
    return Buffer.byteLength(line, 'utf8') <= MAX_DIAGNOSTIC_BYTES ? line : null;
  } catch {
    return null;
  }
}

export function writeManagedLocalSelfTestDiagnostic(error: unknown): void {
  try {
    const diagnostic = formatManagedLocalSelfTestDiagnostic(error);
    if (diagnostic !== null) process.stderr.write(diagnostic);
  } catch {
    // Optional CI observation must not replace the original verification rejection.
  }
}
