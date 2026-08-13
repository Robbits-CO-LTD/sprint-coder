import { describe, expect, it } from 'vitest';
import { assessProviderDisclosure } from './provider-disclosure-classifier';

describe('provider disclosure classifier', () => {
  it.each([
    ['URI userinfo', 'postgres://alice:correct-horse@example.com/db', 'uri-userinfo'],
    ['OpenAI key', 'key=sk-proj-abcdefghijklmnopqrstuvwxyz1234', 'ai-provider-token'],
    ['Anthropic key', 'sk-ant-abcdefghijklmnopqrstuvwxyz1234', 'ai-provider-token'],
    ['Slack token', ['xoxb', '1234567890', 'abcdefghijklmnopqrstuvwxyz'].join('-'), 'slack-token'],
    ['GitLab token', 'glpat-abcdefghijklmnopqrstuvwxyz', 'gitlab-token'],
    ['AWS key', 'AKIAIOSFODNN7EXAMPLE', 'known-secret-pattern'],
    ['PEM key', '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----', 'private-key'],
    ['structured field', '{"client_secret":"not-for-a-provider"}', 'credential-field'],
    ['high entropy', 'session 8Jv2mQp7Zx4Lk9Wd6Tn3Rs5Yc1Ua0BfH', 'high-entropy-value'],
  ])('classifies and redacts %s', (_label, content, reason) => {
    const result = assessProviderDisclosure(content);
    expect(result.classification).toBe('sensitive');
    expect(result.reasons).toContain(reason);
    expect(result.redactedContent).not.toBe(content);
    expect(result.preview).not.toContain('correct-horse');
    expect(result.sourceDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.disclosedDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('treats credential-prone filenames as uncertain without blocking ordinary source files', () => {
    expect(assessProviderDisclosure('region=us-east-1\n', '.env')).toMatchObject({
      classification: 'uncertain',
      reasons: ['credential-prone-filename'],
    });
    expect(
      assessProviderDisclosure('export const greeting = "hello";\n', 'src/index.ts'),
    ).toMatchObject({ classification: 'safe', reasons: [] });
  });

  it('bounds the approval preview and never includes a detected raw value', () => {
    const secret = ['xoxb', '1234567890', 'abcdefghijklmnopqrstuvwxyz'].join('-');
    const result = assessProviderDisclosure(`${secret}\n${'safe '.repeat(1_000)}`);
    expect(result.preview.length).toBeLessThanOrEqual(2_080);
    expect(result.preview).not.toContain(secret);
  });
});
