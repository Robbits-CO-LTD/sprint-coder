import type { CanonicalProviderEvent } from '@sprint-coder/contracts';

export const PROVIDER_OUTPUT_LIMIT_MESSAGE =
  '出力トークン上限のため回答が途中で終了しました。出力範囲を絞って再試行してください。';
export const PROVIDER_EMPTY_RESPONSE_MESSAGE =
  'AIから空の応答が返されました。別のモデルを選ぶか、もう一度お試しください。';

export function providerCompletionEvent(
  stopReason: string | null,
): Extract<CanonicalProviderEvent, { type: 'completed' | 'error' }> {
  if (stopReason === 'max_tokens' || stopReason === 'length' || stopReason === 'MAX_TOKENS')
    return {
      type: 'error',
      error: {
        category: 'invalid_request',
        message: PROVIDER_OUTPUT_LIMIT_MESSAGE,
        retryable: false,
        retryAfterMs: null,
        providerCode: 'output_token_limit',
      },
    };
  return { type: 'completed', stopReason };
}
