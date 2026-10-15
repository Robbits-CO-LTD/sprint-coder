import { describe, expect, it } from 'vitest';
import {
  COMPUTER_USE_ARTIFACT_LIMITS,
  COMPUTER_USE_LIMITS,
  computerUseArtifactSizeClassSchema,
} from '@sprint-coder/contracts';
import {
  ComputerUseArtifactStore,
  computerUseArtifactSizeClass,
  looksLikeComputerUseSecret,
  prepareComputerUseArtifactText,
} from './computer-use-artifact';

/**
 * #785 T15-5: the artifact store and the pure functions behind `copy`
 * (design `tasks/designs/t13-readback-design.md` §4.1, §4.2, §5.2, §7.1).
 * Test names carry the §5.2 negative numbers they pin.
 */

describe('prepareComputerUseArtifactText', () => {
  it('keeps line feeds and tabs, folds CR / CRLF into LF, and applies NFKC', () => {
    expect(prepareComputerUseArtifactText('Ａ\tb\r\nc\rd')).toEqual({
      ok: true,
      text: 'A\tb\nc\nd',
      sizeClass: 'le_256',
    });
  });

  it('N2: drops Unicode Tag characters and other format characters, and refuses what empties', () => {
    expect(prepareComputerUseArtifactText('\u{E0049}\u{E0047}ok​‮')).toEqual({
      ok: true,
      text: 'ok',
      sizeClass: 'le_256',
    });
    expect(prepareComputerUseArtifactText('\u{E0049}\u{E0047}​')).toEqual({
      ok: false,
      reason: 'empty',
    });
  });

  it('drops control characters other than LF and TAB', () => {
    expect(prepareComputerUseArtifactText('a\u0000b\u0007c\u001bd')).toMatchObject({
      ok: true,
      text: 'abcd',
    });
  });

  it('N3: keeps only the NFKC form of compatibility characters', () => {
    expect(prepareComputerUseArtifactText('ｶﾀｶﾅ ①')).toMatchObject({
      ok: true,
      text: 'カタカナ 1',
    });
  });

  it('N8: accepts exactly maxTextActionBytes and refuses one byte more without truncating', () => {
    expect(COMPUTER_USE_ARTIFACT_LIMITS.maxBytes).toBe(COMPUTER_USE_LIMITS.maxTextActionBytes);
    const limit = COMPUTER_USE_ARTIFACT_LIMITS.maxBytes;
    // Multi-byte text: few characters, many bytes.
    const atLimit = 'あ'.repeat(Math.floor(limit / 3)) + 'x'.repeat(limit % 3);
    expect(Buffer.byteLength(atLimit, 'utf8')).toBe(limit);
    expect(prepareComputerUseArtifactText(atLimit)).toMatchObject({ ok: true, text: atLimit });
    expect(prepareComputerUseArtifactText(`${atLimit}x`)).toEqual({
      ok: false,
      reason: 'too_large',
    });
  });

  it('N25: refuses a value that looks like a secret', () => {
    expect(prepareComputerUseArtifactText('ghp_0123456789abcdefghijABCDEFGHIJ')).toEqual({
      ok: false,
      reason: 'secret',
    });
  });

  it('measures what will be pasted: the byte limit applies after normalisation', () => {
    // 'ｱ' is 3 bytes and stays 3 bytes as 'ア'; '①' is 3 bytes and becomes '1' (1 byte).
    const grows = '①'.repeat(COMPUTER_USE_ARTIFACT_LIMITS.maxBytes / 2);
    expect(Buffer.byteLength(grows, 'utf8')).toBeGreaterThan(COMPUTER_USE_ARTIFACT_LIMITS.maxBytes);
    expect(prepareComputerUseArtifactText(grows)).toMatchObject({ ok: true });
  });
});

describe('computerUseArtifactSizeClass', () => {
  it.each([
    [1, 'le_256'],
    [256, 'le_256'],
    [257, 'le_1k'],
    [1_024, 'le_1k'],
    [1_025, 'le_4k'],
    [4_096, 'le_4k'],
  ] as const)('puts %i bytes in %s', (bytes, sizeClass) => {
    expect(computerUseArtifactSizeClass('x'.repeat(bytes))).toBe(sizeClass);
    expect(computerUseArtifactSizeClassSchema.parse(sizeClass)).toBe(sizeClass);
  });
});

describe('looksLikeComputerUseSecret (N25, §7.1 decision 6)', () => {
  it.each([
    ['an OpenAI key', 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWx'],
    ['an Anthropic key', 'here: sk-ant-api03-AbCdEfGhIjKlMnOpQrSt'],
    ['a GitHub token', 'ghp_0123456789abcdefghijABCDEFGHIJ'],
    ['a fine-grained GitHub token', 'github_pat_11ABCDEFG0123456789_abcdef'],
    ['a Slack token', 'xoxb-1234567890-abcdefghij'],
    ['an AWS access key id', 'AKIAIOSFODNN7EXAMPLE'],
    ['a Google API key', 'AIzaSyA-1234567890abcdefghijklmnopqrstu'],
    ['a private key block', '-----BEGIN OPENSSH PRIVATE KEY-----\nabc'],
    [
      'a JWT',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    ],
    ['a card number', '4111 1111 1111 1111'],
    ['a card number with hyphens', 'card 5555-5555-5555-4444 exp'],
    ['a six-digit code', '482913'],
    ['an eight-digit code with spaces around', '  12345678 '],
  ])('flags %s', (_name, text) => {
    expect(looksLikeComputerUseSecret(text)).toBe(true);
  });

  it.each([
    ['ordinary text', 'The build finished in 12 minutes.'],
    ['a five-digit number', '48291'],
    ['a nine-digit number', '123456789'],
    ['a code inside a sentence', 'Order 482913 shipped'],
    ['a 16-digit number that fails Luhn', '4111 1111 1111 1112'],
    ['a dotted version', '1.2.3'],
    ['a word that starts like a key', 'skeleton key'],
  ])('lets %s through', (_name, text) => {
    expect(looksLikeComputerUseSecret(text)).toBe(false);
  });
});

describe('ComputerUseArtifactStore (§4.2)', () => {
  const binding = { taskId: 'task-1', turnId: 'turn-1', policyEpoch: 3 };

  function store(start = 1_000) {
    let now = start;
    let counter = 0;
    const artifacts = new ComputerUseArtifactStore({
      now: () => now,
      randomId: () => `artifact-${(counter += 1)}`,
    });
    return {
      artifacts,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it('creates an opaque reference that carries no content', () => {
    const { artifacts } = store();
    const created = artifacts.create({ ...binding, sourceSessionId: 'session-a' }, 'Total\t42');
    expect(created).toEqual({ artifactId: 'artifact-1', kind: 'text', sizeClass: 'le_256' });
    expect(JSON.stringify(created)).not.toContain('42');
  });

  it('hands the text over once to the same Task, Turn and epoch, then forgets it', () => {
    const { artifacts } = store();
    const created = artifacts.create({ ...binding, sourceSessionId: 'session-a' }, 'Total 42')!;
    expect(artifacts.take([created.artifactId], binding)).toEqual(['Total 42']);
    // Used up by the session it was carried into.
    expect(artifacts.take([created.artifactId], binding)).toBeNull();
  });

  it.each([
    ['N9: another Task', { ...binding, taskId: 'task-2' }],
    ['N10: another Turn', { ...binding, turnId: 'turn-2' }],
    ['N10: a policy epoch change', { ...binding, policyEpoch: 4 }],
  ])('%s cannot take it, and the failure is the same as an unknown id', (_name, other) => {
    const { artifacts } = store();
    const created = artifacts.create({ ...binding, sourceSessionId: 'session-a' }, 'x')!;
    expect(artifacts.take([created.artifactId], other)).toBeNull();
    expect(artifacts.take(['artifact-unknown'], binding)).toBeNull();
    // A refused attempt does not consume it for the rightful owner.
    expect(artifacts.take([created.artifactId], binding)).toEqual(['x']);
  });

  it('N10: is gone after the TTL', () => {
    const { artifacts, advance } = store();
    const created = artifacts.create({ ...binding, sourceSessionId: 'session-a' }, 'x')!;
    advance(COMPUTER_USE_ARTIFACT_LIMITS.ttlMs);
    expect(artifacts.take([created.artifactId], binding)).toBeNull();
  });

  it('N10: is gone when its Task ends', () => {
    const { artifacts } = store();
    const created = artifacts.create({ ...binding, sourceSessionId: 'session-a' }, 'x')!;
    artifacts.dropTask('task-1');
    expect(artifacts.take([created.artifactId], binding)).toBeNull();
  });

  it('takes all or nothing, so a carry with one bad id moves nothing', () => {
    const { artifacts } = store();
    const one = artifacts.create({ ...binding, sourceSessionId: 'session-a' }, 'one')!;
    expect(artifacts.take([one.artifactId, 'artifact-unknown'], binding)).toBeNull();
    expect(artifacts.take([one.artifactId], binding)).toEqual(['one']);
  });

  it('holds at most three per Task at once', () => {
    const { artifacts } = store();
    const owner = { ...binding, sourceSessionId: 'session-a' };
    for (const text of ['a', 'b', 'c']) expect(artifacts.create(owner, text)).not.toBeNull();
    expect(COMPUTER_USE_ARTIFACT_LIMITS.maxConcurrentPerTask).toBe(3);
    expect(artifacts.create(owner, 'd')).toBeNull();
    // Another Task has its own allowance.
    expect(artifacts.create({ ...owner, taskId: 'task-2' }, 'e')).not.toBeNull();
  });

  it('refuses to store what prepare refuses (N8, N25), and stores the normalised text (N3)', () => {
    const { artifacts } = store();
    const owner = { ...binding, sourceSessionId: 'session-a' };
    expect(
      artifacts.create(owner, 'x'.repeat(COMPUTER_USE_ARTIFACT_LIMITS.maxBytes + 1)),
    ).toBeNull();
    expect(artifacts.create(owner, '482913')).toBeNull();
    const created = artifacts.create(owner, 'Ａ\r\nB')!;
    expect(artifacts.take([created.artifactId], binding)).toEqual(['A\nB']);
  });

  it('N11: ids it hands out are unguessable random values by default', () => {
    const artifacts = new ComputerUseArtifactStore({ now: () => 0 });
    const owner = { ...binding, sourceSessionId: 'session-a' };
    const first = artifacts.create(owner, 'a')!.artifactId;
    const second = artifacts.create(owner, 'b')!.artifactId;
    expect(first).toMatch(/^[0-9a-f-]{36}$/u);
    expect(first).not.toBe(second);
  });
});
