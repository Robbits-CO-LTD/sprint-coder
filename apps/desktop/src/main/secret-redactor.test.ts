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

  // Realistic adversarial corpus (Phase 7 hardening, IMPLEMENTATION_PLAN §10.4): each fixture is
  // shaped like a real credential family that could land in Command output, Runtime stderr, or a
  // future support bundle. The assertion is deliberately "the raw secret text never survives" —
  // exact redaction labels are a bonus, not the contract.
  it.each([
    ['AWS access key ID', 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE'],
    [
      'AWS secret access key',
      'aws_secret_access_key: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      'wJalrXUtnFEMI',
    ],
    [
      'bare AWS access key ID with no label',
      'saw this in the log: AKIAIOSFODNN7EXAMPLE and moved on',
      'AKIAIOSFODNN7EXAMPLE',
    ],
    [
      'GitHub classic PAT',
      'export GH_TOKEN=ghp_16C7e42F292c6912E7710c838347Ae178B4a',
      'ghp_16C7e42F292c6912E7710c838347Ae178B4a',
    ],
    [
      'GitHub fine-grained PAT',
      'token=github_pat_11AAAAAAA0aaaaaaaaaaaa_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'github_pat_11AAAAAAA0aaaaaaaaaaaa',
    ],
    [
      'Anthropic API key',
      'ANTHROPIC_API_KEY=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ABCDEFGH',
      'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz',
    ],
    [
      'OpenAI-style project key',
      'OPENAI_API_KEY=sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
      'sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
    ],
    [
      'JWT with no surrounding label',
      'Set-Cookie: session=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U; Path=/',
      'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    ],
    [
      '.env style multi-secret block',
      'DB_PASSWORD=hunter2\nAPI_KEY=abcdefghijklmnop\nSECRET=topsecretvalue',
      'hunter2',
    ],
  ])('redacts a realistic %s from output', (_name, input, secretFragment) => {
    const output = redactSecrets(input);
    expect(output).not.toContain(secretFragment);
  });

  it('redacts an EC and an OpenSSH private key block, not only PKCS#8 RSA', () => {
    const ec = redactSecrets(
      '-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIP...redacted-body...\n-----END EC PRIVATE KEY-----',
    );
    const openssh = redactSecrets(
      '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk...\n-----END OPENSSH PRIVATE KEY-----',
    );
    expect(ec).toBe('[REDACTED_PRIVATE_KEY]');
    expect(openssh).toBe('[REDACTED_PRIVATE_KEY]');
  });

  it('does not touch ordinary prose that merely mentions credential-shaped words', () => {
    const prose = 'The token bucket algorithm limits requests; see the keyboard shortcut docs.';
    expect(redactSecrets(prose)).toBe(prose);
  });
});
