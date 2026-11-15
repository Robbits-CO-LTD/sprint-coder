import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  assessProviderDisclosure,
  assessProviderEgressDisclosure,
} from './provider-disclosure-classifier';

describe('Provider send (egress) classification', () => {
  const opaque = '8Jv2mQp7Zx4Lk9Wd6Tn3Rs5Yc1Ua0BfH';
  const pullRequest = 'https://github.com/Robbits-CO-LTD/sprint-coder/pull/1306';
  const root = '/private/tmp/sprint-coder-patrol-20260905/workspace';
  const isolationRoot =
    '/Users/dev/Library/Application Support/Sprint Coder/team-worker-worktrees/worktree-3f1c9a7e-5b2d-4e8a-9c04-7d6b1f2a8e35-1';
  // Assembled at run time so the fixtures never sit in the source as a literal webhook or token.
  const slackWebhook = [
    'https://hooks.slack.com/services',
    'T024BE7LD',
    'B01ABCDEF12',
    'aB3aB3cD4cD4eF5eF5gH6gH6',
  ].join('/');
  const discordWebhook = [
    'https://discord.com/api/webhooks',
    '123456789012345678',
    ['Zx8Kp2Qm7Lw4Nv9Rt3Ys6Hb1Jd5Fg0Ca', 'Qw7Er4Ty1Ui8Op5As2Df9Gh6Jk3Lz0Xc', 'Vb'].join('_'),
  ].join('/');
  const telegramBot = `https://api.telegram.org/bot${['123456789', 'AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'].join(':')}/sendMessage`;
  const jwt = [
    'eyJhbGciOiJIUzI1NiJ9',
    'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
    'abcdefghijklmnopqrstuvwxyz012345',
  ].join('.');

  // Each of these used to stop the send as `high-entropy-value`: long, mixed, random-looking.
  it.each([
    'https://example.com/',
    'https://www.amazon.co.jp/dp/B09B8V1LZ3',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.google.com/search?q=bluetooth+speaker&sca_esv=5f1c2d3e4a5b6c7d&ei=AbCdEfGh',
    'https://www.amazon.co.jp/Echo-Dot-5th-Gen/dp/B09B8SZLLG/ref=sr_1_1',
    pullRequest,
    `${pullRequest} を見て`,
    `[PR 1306](${pullRequest})`,
    'https://github.com/Robbits-CO-LTD/sprint-coder/issues/1298#issuecomment-6892857211',
    'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd/edit',
    'https://zenn.dev/example/articles/2a9c1f0b7e3d4c5a6b',
    'https://github.com/Robbits-CO-LTD/sprint-coder/actions/workflows/ci.yml',
    `launch msedge --url ${pullRequest}`,
    JSON.stringify({ request: `この PR を見て\n${pullRequest}\n終わったら教えて` }),
    createHash('sha256').update('fixture').digest('hex'),
    createHash('sha256').update('fixture').digest('base64'),
    '3f1c9a7e-5b2d-4e8a-9c04-7d6b1f2a8e35',
    Buffer.from('a short image chunk for the test').toString('base64'),
    'quickBrownFoxJumpsOverLazyDog123',
    'realai-ws-codex-graph-Hnb2yq',
    // A Workspace root, a Worker's isolation worktree, and an opaque name under either.
    'F:/sc-real-ai-20260910/fixtures/qwen38',
    root,
    `隔離worktree: ${isolationRoot}（このディレクトリ内だけを変更してください）`,
    `${isolationRoot}/${opaque}`,
    `session ${opaque}`,
  ])('lets a value that only looks random through the send (%#)', (content) => {
    expect(assessProviderEgressDisclosure(content)).toMatchObject({
      classification: 'safe',
      reasons: [],
      redactedContent: content,
    });
  });

  it.each([
    ['an Anthropic key', 'sk-ant-abcdefghijklmnopqrstuvwxyz1234', 'ai-provider-token'],
    ['an OpenAI key', `key ${'sk-proj-abcdefghijklmnopqrstuvwxyz1234'}`, 'ai-provider-token'],
    ['a Google API key', 'AIzaSyA1b2C3d4E5f6G7h8I9j0KlMnOpQrStUv', 'ai-provider-token'],
    [
      'a Slack token',
      ['xoxb', '1234567890', 'abcdefghijklmnopqrstuvwxyz'].join('-'),
      'slack-token',
    ],
    ['a GitLab token', 'glpat-abcdefghijklmnopqrstuvwxyz', 'gitlab-token'],
    ['an AWS access key ID', 'AKIAIOSFODNN7EXAMPLE', 'known-secret-pattern'],
    ['a GitHub token', `ghp_${'abcdefghijklmnopqrstuvwxyz0123456789'}`, 'known-secret-pattern'],
    ['a JWT', `token is ${jwt}`, 'known-secret-pattern'],
    ['a bearer header', `Authorization: Bearer ${opaque}`, 'known-secret-pattern'],
    ['userinfo in a URL', 'https://alice:correct-horse@example.com/', 'uri-userinfo'],
    ['a cookie header', `Cookie: session=${opaque}`, 'cookie'],
    ['a password field', 'password = "correct horse battery staple"', 'credential-field'],
    [
      'an access token in a URL query',
      'https://example.com/callback?access_token=correct-horse',
      'credential-field',
    ],
    [
      'an API key field under a root',
      `${isolationRoot}/.env\nAPI_KEY=${opaque}`,
      'credential-field',
    ],
    [
      'a key inside a root',
      `/private/tmp/sk-proj-abcdefghijklmnopqrstuvwxyz1234/w`,
      'ai-provider-token',
    ],
    ['a PEM block', '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----', 'private-key'],
    ['a Slack webhook', slackWebhook, 'webhook-url'],
    ['a Discord webhook', discordWebhook, 'webhook-url'],
    ['a Telegram bot URL', telegramBot, 'webhook-url'],
  ])('still stops %s', (_label, content, reason) => {
    const assessment = assessProviderEgressDisclosure(content);
    expect(assessment.classification).toBe('sensitive');
    expect(assessment.reasons).toContain(reason);
    expect(assessment.reasons).not.toContain('high-entropy-value');
    expect(assessment.redactedContent).not.toBe(content);
  });

  it('redacts the secret part of a webhook URL and keeps its host', () => {
    const assessment = assessProviderEgressDisclosure(`通知先: ${slackWebhook}`);
    expect(assessment.redactedContent).toBe(
      '通知先: https://hooks.slack.com/services/[REDACTED_WEBHOOK]',
    );
    expect(assessment.preview).not.toContain('aB3aB3cD4cD4eF5eF5gH6gH6');
  });

  it('keeps the entropy guess for file content', () => {
    // Only the send changed: a file disclosed as context still treats an opaque value as a secret.
    for (const content of [opaque, `${pullRequest}/${opaque}`])
      expect(assessProviderDisclosure(content, 'notes.json').reasons).toEqual([
        'high-entropy-value',
      ]);
    expect(assessProviderDisclosure(slackWebhook, 'notes.json').reasons).toContain('webhook-url');
  });
});

describe('provider disclosure classifier', () => {
  it.each([
    'See https://github.com/Robbits-CO-LTD/sprint-coder/actions/workflows/ci.yml',
    'See https://img.shields.io/github/v/release/Robbits-CO-LTD/sprint-coder?include_prereleases&logo=github',
    'The public identifier `quickBrownFoxJumpsOverLazyDog` is documented here.',
    'The public identifier `quick_brown_fox_jumps_over_lazy_dog` is documented here.',
    'The public path `docs/quick-brown-fox-jumps-over-lazy-dog` is documented here.',
  ])('preserves ordinary document identifiers and public paths (%#)', (content) => {
    expect(assessProviderDisclosure(content, 'README.md')).toMatchObject({
      classification: 'safe',
      redactedContent: content,
    });
    // A file outside a document keeps the entropy guess; the send to a Provider does not.
    expect(assessProviderDisclosure(content).classification).toBe('sensitive');
    expect(assessProviderDisclosure(content, 'output.json').classification).toBe('sensitive');
    expect(assessProviderEgressDisclosure(content)).toMatchObject({
      classification: 'safe',
      redactedContent: content,
    });
  });
  it.each([
    '8Jv2mQp7Zx4Lk9Wd6Tn3Rs5Yc1Ua0BfH',
    'AbCdEfGhIjKlMnOpQrStUvWxYz',
    'quickBrownFoxJumpsOverLazyDog123',
    'quick_brown_fox_jumps_over_lazy_dog=',
    'sk-proj-abcdefghijklmnopqrstuvwxyz1234',
    'sk-ant-abcdefghijklmnopqrstuvwxyz1234',
    ['xoxb', '1234567890', 'abcdefghijklmnopqrstuvwxyz'].join('-'),
    'glpat-abcdefghijklmnopqrstuvwxyz',
    'AKIAIOSFODNN7EXAMPLE',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop',
  ])('does not let document syntax hide secret-like values (%#)', (secret) => {
    for (const content of [
      `Read \`${secret}\`.`,
      `Read \`docs/${secret}\`.`,
      `See https://example.com/docs/${secret}`,
      `See https://example.com/docs?value=${secret}`,
      `See https://example.com/docs#${secret}`,
      `The identifier \`quickBrownFoxJumpsOverLazyDog\` precedes ${secret}.`,
    ]) {
      const result = assessProviderDisclosure(content, 'README.md');
      expect(result.classification).toBe('sensitive');
      expect(result.redactedContent).not.toContain(secret);
      expect(result.preview).not.toContain(secret);
    }
  });
  it.each([
    'quickBrownFoxJumpsOverLazyDog',
    'See https://example.com/docs?value=quickBrownFoxJumpsOverLazyDog',
    'See https://example.com/docs#quickBrownFoxJumpsOverLazyDog',
    'password="quickBrownFoxJumpsOverLazyDog"',
    'See https://alice:quickBrownFoxJumpsOverLazyDog@example.com/docs',
    '-----BEGIN PRIVATE KEY-----\nquickBrownFoxJumpsOverLazyDog\n-----END PRIVATE KEY-----',
  ])('keeps ambiguous values and credential context sensitive (%#)', (content) => {
    const result = assessProviderDisclosure(content, 'README.md');
    expect(result.classification).toBe('sensitive');
    expect(result.redactedContent).not.toContain('quickBrownFoxJumpsOverLazyDog');
  });
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
