import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ManagedLocalRuntimeSession } from './managed-local-runtime-supervisor';

const MAX_RESPONSE_BYTES = 1024 * 1024;

export async function runManagedLocalSelfTest(
  input: Readonly<{
    session: ManagedLocalRuntimeSession;
    modelId: string;
    scratchRoot: string;
    nonce: string;
    onLoaded(): void | Promise<void>;
  }>,
): Promise<void> {
  const baseMessages = [{ role: 'user', content: 'Reply with exactly: READY' }];
  const loaded = await completion(input.session, {
    model: input.modelId,
    stream: false,
    messages: baseMessages,
    max_tokens: 16,
  });
  if (messageContent(loaded).trim().length === 0)
    throw new Error('Managed Local chat self-test returned no text');
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
    tool_choice: 'auto',
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

async function completion(
  session: ManagedLocalRuntimeSession,
  body: Record<string, unknown>,
): Promise<unknown> {
  const response = await session.authenticatedFetch('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Managed Local self-test HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES)
    throw new Error('Managed Local self-test response is too large');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES)
    throw new Error('Managed Local self-test response is too large');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
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
    throw new Error('Self-test model returned the wrong nonce');
  return record;
}
