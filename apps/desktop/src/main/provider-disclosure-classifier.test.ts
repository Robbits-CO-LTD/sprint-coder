import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  assessProviderDisclosure,
  assessProviderEgressDisclosure,
} from './provider-disclosure-classifier';

describe('sealed Workspace root egress classification', () => {
  const root = '/private/tmp/sprint-coder-patrol-20260905/workspace';
  const opaque = '8Jv2mQp7Zx4Lk9Wd6Tn3Rs5Yc1Ua0BfH';

  it('recognizes a Windows descendant only with its Main-issued drive and root', () => {
    const windowsRoot = 'F:\\sc-real-ai-20260910\\fixtures';
    const path = 'F:/sc-real-ai-20260910/fixtures/qwen38';
    expect(assessProviderEgressDisclosure(path).classification).toBe('sensitive');
    for (const root of [windowsRoot, `${windowsRoot}\\`, windowsRoot.replaceAll('\\', '/')]) {
      const content = JSON.stringify({ message: path });
      expect(assessProviderEgressDisclosure(content, [root])).toMatchObject({
        classification: 'safe',
        redactedContent: content,
      });
    }
    for (const content of [
      path.replace('F:', 'G:'),
      path.replace('/fixtures/', '/fixtures-other/'),
      `${path}/${opaque}`,
      `${path}/8Jv2mQp7Zx4Lk9Wd6Tn3R/s5Yc1Ua0BfH8Jv2mQp7Zx`,
      `password="${path}"`,
      `${path}\n${opaque}`,
    ])
      expect(assessProviderEgressDisclosure(content, [windowsRoot]).classification).toBe(
        'sensitive',
      );
  });

  it('uses exact Main-issued root context only for composite entropy', () => {
    expect(assessProviderDisclosure(root).classification).toBe('sensitive');
    expect(assessProviderEgressDisclosure(root).classification).toBe('sensitive');
    expect(assessProviderEgressDisclosure(root, [root])).toMatchObject({
      classification: 'safe',
      redactedContent: root,
    });
  });

  it.each([
    `${root}/child`,
    `${root}-other`,
    `${root}/${opaque}`,
    opaque,
    `${root}\n${opaque}`,
    `password="${root}"`,
    `cookie: ${root}`,
  ])('does not exempt other values or credential fields (%#)', (content) => {
    const assessment = assessProviderEgressDisclosure(content, [root]);
    expect(assessment.classification).toBe('sensitive');
    expect(assessment.redactedContent).not.toBe(content);
  });

  it.each([opaque, 'sk-proj-abcdefghijklmnopqrstuvwxyz1234', 'AKIAIOSFODNN7EXAMPLE'])(
    'still blocks a secret-bearing root (%#)',
    (value) => {
      const secretRoot = `/private/tmp/${value}/workspace`;
      expect(assessProviderEgressDisclosure(secretRoot, [secretRoot]).classification).toBe(
        'sensitive',
      );
    },
  );

  it('cannot exempt an opaque value just by supplying it as a root', () => {
    expect(assessProviderEgressDisclosure(opaque, [opaque]).classification).toBe('sensitive');
  });
});

describe('provider disclosure classifier', () => {
  it.each(['sha256', 'sha384', 'sha512'])(
    'does not redact a valid %s integrity digest',
    (algorithm) => {
      const integrity = `${algorithm}-${createHash(algorithm).update('public package fixture').digest('base64')}`;
      const content = JSON.stringify({ integrity });
      expect(assessProviderDisclosure(content, 'package-lock.json')).toMatchObject({
        classification: 'safe',
        redactedContent: content,
      });
      expect(assessProviderDisclosure(JSON.stringify({ password: integrity })).classification).toBe(
        'sensitive',
      );
    },
  );
  it('recognizes the literal public alphabet without accepting opaque base64', () => {
    expect(assessProviderDisclosure('abcdefghijklmnopqrstuvwxyz').classification).toBe('safe');
    expect(assessProviderDisclosure('8Jv2mQp7Zx4Lk9Wd6Tn3Rs5Yc1Ua0BfH').classification).toBe(
      'sensitive',
    );
  });
  it.each([
    ['URI userinfo', 'postgres://alice:correct-horse@example.com/db', 'uri-userinfo'],
    ['OpenAI key', 'key=sk-proj-abcdefghijklmnopqrstuvwxyz1234', 'ai-provider-token'],
    ['Anthropic key', 'sk-ant-abcdefghijklmnopqrstuvwxyz1234', 'ai-provider-token'],
    ['Slack token', ['xoxb', '1234567890', 'abcdefghijklmnopqrstuvwxyz'].join('-'), 'slack-token'],
    ['GitLab token', 'glpat-abcdefghijklmnopqrstuvwxyz', 'gitlab-token'],
    ['AWS key', 'AKIAIOSFODNN7EXAMPLE', 'known-secret-pattern'],
    ['PEM key', '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----', 'private-key'],
    ['structured field', '{"client_secret":"not-for-a-provider"}', 'credential-field'],
    ['quoted secret with spaces', 'password="correct horse battery staple"', 'credential-field'],
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
    const uncertain = assessProviderDisclosure('region=us-east-1\n', '.env');
    expect(uncertain).toMatchObject({
      classification: 'uncertain',
      reasons: ['credential-prone-filename'],
      redactedContent: '[REDACTED_UNCERTAIN_CREDENTIAL_FILE]',
    });
    expect(uncertain.preview).not.toContain('us-east-1');
    expect(
      assessProviderDisclosure('export const greeting = "hello";\n', 'src/index.ts'),
    ).toMatchObject({ classification: 'safe', reasons: [] });
  });

  it('redacts a complete quoted credential value including spaces', () => {
    const result = assessProviderDisclosure('password="correct horse battery staple"\nnext=ok');
    expect(result.redactedContent).toBe('password=[REDACTED]\nnext=ok');
    expect(result.preview).not.toContain('horse');
  });

  it('bounds the approval preview and never includes a detected raw value', () => {
    const secret = ['xoxb', '1234567890', 'abcdefghijklmnopqrstuvwxyz'].join('-');
    const result = assessProviderDisclosure(`${secret}\n${'safe '.repeat(1_000)}`);
    expect(result.preview.length).toBeLessThanOrEqual(2_080);
    expect(result.preview).not.toContain(secret);
  });
});
