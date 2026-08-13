import type { CanonicalProviderEvent, NormalizedProviderUsage } from '@sprint-coder/contracts';
import { createHash } from 'node:crypto';
import { ProviderStreamBudget, readBoundedServerSentJson } from './provider-stream-budget';

export async function* normalizeGeminiContentStream(
  body: ReadableStream<Uint8Array>,
  requestedModel: string,
  executionId = requestedModel,
  budget = new ProviderStreamBudget(),
): AsyncIterable<CanonicalProviderEvent> {
  let resolvedModel = requestedModel;
  let stopReason: string | null = null;
  let usage = emptyUsage();
  let toolOrdinal = 0;
  let received = false;
  let failed = false;

  for await (const value of readBoundedServerSentJson(body, budget)) {
    const chunk = record(value);
    if (chunk === null) continue;
    received = true;

    const error = record(chunk.error);
    if (error !== null) {
      failed = true;
      const status = typeof error.status === 'string' ? error.status : null;
      yield {
        type: 'error',
        error: {
          category:
            status === 'RESOURCE_EXHAUSTED'
              ? 'rate_limited'
              : status === 'CANCELLED'
                ? 'canceled'
                : 'provider_unavailable',
          message: 'Gemini streaming request failed',
          retryable:
            status === 'RESOURCE_EXHAUSTED' || status === 'UNAVAILABLE' || status === 'INTERNAL',
          retryAfterMs: null,
          providerCode: status?.slice(0, 128) ?? null,
        },
      };
      continue;
    }

    if (typeof chunk.modelVersion === 'string')
      resolvedModel = stripModelPrefix(chunk.modelVersion);
    usage = mergeUsage(usage, record(chunk.usageMetadata));

    const candidates = Array.isArray(chunk.candidates) ? chunk.candidates : [];
    for (const candidateValue of candidates) {
      const candidate = record(candidateValue);
      if (typeof candidate?.finishReason === 'string') stopReason = candidate.finishReason;
      const content = record(candidate?.content);
      const parts = Array.isArray(content?.parts) ? content.parts : [];
      for (const partValue of parts) {
        const part = record(partValue);
        if (typeof part?.text === 'string') {
          budget.consumeOutput(part.text);
          yield part.thought === true
            ? { type: 'reasoning_delta', text: part.text }
            : { type: 'output_delta', text: part.text };
        }
        const functionCall = record(part?.functionCall);
        if (functionCall !== null && typeof functionCall.name === 'string') {
          toolOrdinal += 1;
          budget.consumeToolCall();
          budget.consumeToolArguments(String(toolOrdinal), JSON.stringify(functionCall.args ?? {}));
          yield {
            type: 'tool_call',
            callId:
              typeof functionCall.id === 'string'
                ? functionCall.id.slice(0, 256)
                : `gemini-call-${createHash('sha256').update(executionId).digest('hex').slice(0, 16)}-${toolOrdinal}`,
            name: functionCall.name.slice(0, 256),
            input: jsonValue(functionCall.args),
            providerMetadata: {
              geminiCallIdPresent: typeof functionCall.id === 'string',
              ...(typeof part?.thoughtSignature === 'string' && part.thoughtSignature.length > 0
                ? { geminiThoughtSignature: part.thoughtSignature.slice(0, 65_536) }
                : {}),
            },
          };
        }
      }
    }
  }

  if (received && !failed) {
    yield {
      type: 'resolution',
      resolution: {
        resolvedProvider: 'google',
        resolvedModel,
      },
    };
    yield { type: 'usage', usage };
    yield { type: 'completed', stopReason };
  }
}

function emptyUsage(): NormalizedProviderUsage {
  return {
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    providerCost: null,
    source: 'provider_api',
  };
}

function mergeUsage(
  current: NormalizedProviderUsage,
  value: Record<string, unknown> | null,
): NormalizedProviderUsage {
  if (value === null) return current;
  return {
    ...current,
    inputTokens: integer(value.promptTokenCount) ?? current.inputTokens,
    outputTokens: integer(value.candidatesTokenCount) ?? current.outputTokens,
    cacheReadTokens: integer(value.cachedContentTokenCount) ?? current.cacheReadTokens,
    reasoningTokens: integer(value.thoughtsTokenCount) ?? current.reasoningTokens,
  };
}

function jsonValue(
  value: unknown,
): Extract<CanonicalProviderEvent, { type: 'tool_call' }>['input'] {
  try {
    return JSON.parse(JSON.stringify(value ?? {})) as Extract<
      CanonicalProviderEvent,
      { type: 'tool_call' }
    >['input'];
  } catch {
    return {};
  }
}

function stripModelPrefix(value: string): string {
  return value.startsWith('models/') ? value.slice('models/'.length) : value;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}
