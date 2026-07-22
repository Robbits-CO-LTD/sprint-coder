import { describe, expect, it } from 'vitest';
import { createStreamingSecretRedactor, redactSecrets } from './secret-redactor';

describe('secret redactor', () => {
  it('redacts common credential forms before persistence', () => {
    expect(redactSecrets('password=hunter2 Bearer abcdefghijklmnop sk_abcdefghijklmnop')).toBe(
      'password=[REDACTED] Bearer [REDACTED] [REDACTED_TOKEN]',
    );
  });

  it('redacts a credential split across stream chunks', () => {
    const redactor = createStreamingSecretRedactor();
    const output =
      redactor.write('safe token=abcd') + redactor.write('efghijkl tail') + redactor.end();

    expect(output).toBe('safe token=[REDACTED] tail');
  });

  it('never emits an oversized private key before its terminator', () => {
    const redactor = createStreamingSecretRedactor();
    const first = redactor.write(`safe-----BEGIN PRIVATE KEY-----${'A'.repeat(10_000)}`);
    const second = redactor.write('-----END PRIVATE KEY-----tail') + redactor.end();

    expect(first).toBe('safe');
    expect(second).toBe('[REDACTED_PRIVATE_KEY]tail');
    expect(first + second).not.toContain('AAAA');
  });
});
