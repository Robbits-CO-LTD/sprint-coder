import { describe, expect, it } from 'vitest';
import {
  COMPUTER_USE_ARTIFACT_LIMITS,
  COMPUTER_USE_EXCERPT_MAX,
  COMPUTER_USE_TRANSFER_LABEL_MAX,
  computerUseApprovalTransferSchema,
  COMPUTER_USE_LIMITS,
  computerUseArtifactSizeClassSchema,
} from '@sprint-coder/contracts';
import {
  ComputerUseArtifactStore,
  computerUseArtifactExcerpt,
  computerUseArtifactSizeClass,
  computerUseDisplayLabel,
  looksLikeComputerUseSecret,
  normalizeComputerUseArtifactText,
  prepareComputerUseArtifactText,
} from './computer-use-artifact';

const looksSecret = (text: string) =>
  looksLikeComputerUseSecret(normalizeComputerUseArtifactText(text));

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

  it('N3 x N25: secrets are detected after normalisation, not on the raw string', () => {
    const secret = { ok: false, reason: 'secret' } as const;
    // Full-width spelling of a GitHub token.
    expect(prepareComputerUseArtifactText('ｇｈｐ＿0123456789abcdefghijABCDEFGHIJ')).toEqual(
      secret,
    );
    // Zero-width and Tag characters inside the token.
    expect(
      prepareComputerUseArtifactText('gh\u200Bp_0123456789abc\u{E0041}defghijABCDEFGHIJ'),
    ).toEqual(secret);
    // A one-time code in full-width digits, and with a zero-width character inside.
    expect(prepareComputerUseArtifactText('４８２９１３')).toEqual(secret);
    expect(prepareComputerUseArtifactText('482\u200B913')).toEqual(secret);
    // A card number whose digits are full-width.
    expect(prepareComputerUseArtifactText('４１１１ １１１１ １１１１ １１１１')).toEqual(secret);
  });

  it('folds U+2028 / U+2029 into LF like the other line breaks', () => {
    expect(prepareComputerUseArtifactText('a\u2028b\u2029c')).toMatchObject({
      ok: true,
      text: 'a\nb\nc',
    });
  });

  it('measures what will be pasted: the byte limit applies after normalisation', () => {
    // 'ｱ' is 3 bytes and stays 3 bytes as 'ア'; '①' is 3 bytes and becomes '1' (1 byte).
    const grows = '①'.repeat(COMPUTER_USE_ARTIFACT_LIMITS.maxBytes / 2);
    expect(Buffer.byteLength(grows, 'utf8')).toBeGreaterThan(COMPUTER_USE_ARTIFACT_LIMITS.maxBytes);
    expect(prepareComputerUseArtifactText(grows)).toMatchObject({ ok: true });
  });
});

/** One code point, spelled by number so the source holds no invisible character. */
const cp = (value: number): string => String.fromCodePoint(value);

describe('what a person is shown of a value (N23, design 4.5, R13)', () => {
  it.each([
    ['LF and TAB become symbols', 'a\nb\tc', 'a⏎b⇥c'],
    ['CRLF and a lone CR are one line symbol each', 'a\r\nb\rc', 'a⏎b⏎c'],
    ['Hangul filler U+3164 (NFKC makes it U+1160)', `a${cp(0x3164)}b`, 'a⟦U+1160⟧b'],
    ['Hangul choseong filler U+115F', `a${cp(0x115f)}b`, 'a⟦U+115F⟧b'],
    ['Braille blank U+2800', `a${cp(0x2800)}b`, 'a⟦U+2800⟧b'],
    ['half-width Hangul filler (via NFKC)', `a${cp(0xffa0)}b`, 'a⟦U+1160⟧b'],
    ['zero-width space', `a${cp(0x200b)}b`, 'a⟦U+200B⟧b'],
    ['right-to-left override', `a${cp(0x202e)}b`, 'a⟦U+202E⟧b'],
    ['isolate marks', `a${cp(0x2066)}b${cp(0x2069)}`, 'a⟦U+2066⟧b⟦U+2069⟧'],
    ['a Tag character', `a${cp(0xe0041)}b`, 'a⟦U+E0041⟧b'],
    ['a variation selector', `a${cp(0xfe0f)}b`, 'a⟦U+FE0F⟧b'],
    ['line and paragraph separators', `a${cp(0x2028)}b${cp(0x2029)}c`, 'a⟦U+2028⟧b⟦U+2029⟧c'],
    ['a private-use character', `a${cp(0xe000)}b`, 'a⟦U+E000⟧b'],
    ['a control character', `a${cp(7)}b`, 'a⟦U+0007⟧b'],
    ['a lone surrogate', `a${String.fromCharCode(0xd800)}b`, 'a⟦U+D800⟧b'],
    [
      'combining marks beyond two in a row',
      `e${cp(0x301)}${cp(0x302)}${cp(0x303)}${cp(0x304)}`,
      `é${cp(0x302)}${cp(0x303)}⟦U+0304⟧`,
    ],
    ['a combining mark with nothing before it', `${cp(0x301)}a`, '⟦U+0301⟧a'],
    ['the combining grapheme joiner', `a${cp(0x34f)}b`, 'a⟦U+034F⟧b'],
  ])('%s', (_name, raw, expected) => {
    expect(computerUseArtifactExcerpt(raw)).toBe(expected);
  });

  it('leaves ordinary text, accents and Japanese alone', () => {
    for (const text of ['Total 42', 'café', 'こんにちは 世界', 'ก็ ที่']) {
      expect(computerUseArtifactExcerpt(text)).toBe(text.normalize('NFKC'));
    }
  });

  it('cuts at 256 code points of the source and says so', () => {
    expect(computerUseArtifactExcerpt('x'.repeat(256))).toBe('x'.repeat(256));
    expect(computerUseArtifactExcerpt('x'.repeat(257))).toBe(`${'x'.repeat(256)}…`);
    // Counted in characters, not UTF-16 units: an astral character is one.
    expect(computerUseArtifactExcerpt('😀'.repeat(256))).toBe('😀'.repeat(256));
    // Escapes do not eat the budget of the characters after them.
    expect(computerUseArtifactExcerpt(cp(0x200b).repeat(300))).toBe(`${'⟦U+200B⟧'.repeat(256)}…`);
  });

  it('shows what is pasted: no escaped character is ever shown plainly', () => {
    const text = `pay ${cp(0x202e)}evil${cp(0x2066)} to ${cp(0x3164)}bob`;
    const shown = computerUseArtifactExcerpt(text);
    expect(shown).not.toContain(cp(0x202e));
    expect(shown).not.toContain(cp(0x2066));
    expect(shown).not.toContain(cp(0x1160));
    expect(shown.replace(/⟦U\+[0-9A-F]+⟧/gu, '')).toBe('pay evil to bob');
  });

  it('labels from the screen are escaped and cut shorter', () => {
    expect(computerUseDisplayLabel(`Bank${cp(0x202e)}.app`)).toBe('Bank⟦U+202E⟧.app');
    expect(computerUseDisplayLabel('a'.repeat(65))).toBe(`${'a'.repeat(64)}…`);
    expect(computerUseDisplayLabel('line\nbreak')).toBe('line⏎break');
  });
});

describe('what a person is shown, second pass (M1, M2, L1, L2, L5)', () => {
  it('M1: every Default_Ignorable code point is made visible, whatever its category', () => {
    const ignorable = /\p{Default_Ignorable_Code_Point}/u;
    let seen = 0;
    for (let value = 0; value <= 0x10ffff; value += 1) {
      if (value >= 0xd800 && value <= 0xdfff) continue;
      const character = cp(value);
      if (!ignorable.test(character)) continue;
      seen += 1;
      const shown = computerUseArtifactExcerpt(`a${character}b`);
      // Not drawn plainly, and not silently dropped: the reader sees that something is there.
      if (shown === 'ab' || shown.includes(character)) throw new Error(`U+${value.toString(16)}`);
      expect(shown.replace(/⟦U\+[0-9A-F]+⟧/gu, '')).toMatch(/^a.*b$/u);
    }
    expect(seen).toBeGreaterThan(300);
  });

  it.each([0x17b4, 0x17b5, 0x180b, 0x180c, 0x180d, 0x180f])(
    'M1: the nonspacing invisible mark U+%s is escaped, not shown as nothing',
    (value) => {
      expect(computerUseArtifactExcerpt(`a${cp(value)}b`)).toBe(
        `a⟦U+${value.toString(16).toUpperCase().padStart(4, '0')}⟧b`,
      );
    },
  );

  it('L5: an unassigned code point is escaped', () => {
    expect(computerUseArtifactExcerpt(`a${cp(0x378)}b`)).toBe('a⟦U+0378⟧b');
    expect(computerUseArtifactExcerpt(`a${cp(0x10ffff)}b`)).toBe('a⟦U+10FFFF⟧b');
  });

  it.each(['⟦', '⟧', '⏎', '⇥', '⚠'])(
    'L2: the display symbol %s inside a value cannot pass for one of ours',
    (symbol) => {
      const shown = computerUseArtifactExcerpt(`a${symbol}b`);
      expect(shown).toBe(`a⟦U+${symbol.codePointAt(0)!.toString(16).toUpperCase()}⟧b`);
    },
  );

  it('L2: a value that spells out an escape or a line break does not look like one', () => {
    const shown = computerUseArtifactExcerpt('⟦U+202E⟧⏎⇥');
    expect(shown).toBe('⟦U+27E6⟧U+202E⟦U+27E7⟧⟦U+23CE⟧⟦U+21E5⟧');
    // Our own line break and tab are only ever made from a real one.
    expect(computerUseArtifactExcerpt('a\nb\tc')).toBe('a⏎b⇥c');
  });

  describe('M2: a word that mixes look-alike scripts is marked', () => {
    const cyrillicA = cp(0x430);
    const cyrillicO = cp(0x43e);
    const greekOmicron = cp(0x3bf);
    const armenianO = cp(0x585);
    it.each([
      ['Cyrillic а in a Latin word', `p${cyrillicA}y`, '⚠pаy'],
      ['Greek ο in a Latin word', `g${greekOmicron}${greekOmicron}d`, '⚠gοοd'],
      ['Armenian օ in a Latin word', `b${armenianO}b`, '⚠bօb'],
      ['only the mixed word of a sentence', `pay p${cyrillicO}ypal now`, 'pay ⚠pоypal now'],
      ['a mixed word after punctuation', `(ok) "p${cyrillicA}y"`, '(ok) "⚠pаy"'],
      ['Cyrillic with Greek', `${cp(0x430)}${cp(0x3b1)}`, '⚠аα'],
    ])('%s', (_name, text, expected) => {
      expect(computerUseArtifactExcerpt(text)).toBe(expected);
    });

    it('R1: a Lisu letter that looks like a Latin capital marks the word', () => {
      // U+A4EE LISU LETTER A, shaped like a capital A.
      expect(computerUseArtifactExcerpt(`${cp(0xa4ee)}pple`)).toBe(`⚠${cp(0xa4ee)}pple`);
    });

    it('R3: a Cherokee letter among Latin ones marks the word', () => {
      // U+13A0 CHEROKEE LETTER A.
      expect(computerUseArtifactExcerpt(`${cp(0x13aa)}pple`)).toBe(`⚠${cp(0x13aa)}pple`);
      expect(computerUseArtifactExcerpt(`${cp(0x13a0)}${cp(0x13aa)}`)).toBe(
        `${cp(0x13a0)}${cp(0x13aa)}`,
      );
    });

    it('R3: a combining mark inside the word does not split it', () => {
      // Cyrillic а + acute, then Latin: one word with two scripts.
      const word = `${cyrillicA}${cp(0x301)}pple`.normalize('NFKC');
      expect(computerUseArtifactExcerpt(`${cyrillicA}${cp(0x301)}pple`)).toBe(`⚠${word}`);
    });

    it('R2: units and formulas that really mix Latin and Greek are marked too (accepted)', () => {
      for (const text of ['μm', 'kΩ', '2πr', 'Δx'])
        expect(computerUseArtifactExcerpt(text)).toBe(`⚠${text.normalize('NFKC')}`);
    });

    it('R1: the known limits are not detected (design 4.5): one script, or the parts apart', () => {
      expect(computerUseArtifactExcerpt('аррӏе')).toBe('аррӏе');
      expect(computerUseArtifactExcerpt(`${cyrillicA}.pple`)).toBe(`${cyrillicA}.pple`);
    });

    it('a zero-width character inside the word does not hide the mix', () => {
      expect(computerUseArtifactExcerpt(`p${cp(0x200b)}${cyrillicA}y`)).toBe('⚠p⟦U+200B⟧аy');
    });

    it.each([
      ['plain Latin', 'Hello world 42'],
      ['plain Cyrillic', 'привет мир'],
      ['plain Greek', 'γειά σου'],
      ['Japanese beside Latin letters', 'Appleを買う iPhone15 とiPad'],
      ['Latin with digits and symbols', 'a1_b2-c3 $4.50'],
      ['Cyrillic and Latin in different words', 'привет hello'],
      ['Chinese beside Latin', '你好world'],
    ])('leaves %s alone', (_name, text) => {
      expect(computerUseArtifactExcerpt(text)).toBe(text);
    });

    it('does not read full-width letters as another script (NFKC makes them Latin)', () => {
      expect(computerUseArtifactExcerpt(`ｐ${cyrillicA}ｙ`)).toBe('⚠pаy');
      expect(computerUseArtifactExcerpt('ｐａｙ')).toBe('pay');
    });
  });

  describe('L1: what is shown fits the contract, in the worst case', () => {
    const transfer = (label: string, excerpt: string) =>
      computerUseApprovalTransferSchema.parse({
        sourceLabel: label,
        destinationLabel: label,
        destinationTarget: `control:${computerUseDisplayLabel(label)}`,
        sizeClass: 'le_4k',
        excerpt,
      });

    it.each([
      ['64 Tag characters', cp(0xe0041).repeat(64)],
      ['65 private-use characters', cp(0xe000).repeat(65)],
      ['64 zero-width characters', cp(0x200b).repeat(64)],
      ['64 of the longest escape', cp(0x10fffd).repeat(64)],
      ['a long ordinary name', 'a'.repeat(500)],
    ])('a label of %s', (_name, label) => {
      const shown = computerUseDisplayLabel(label);
      expect(shown.length).toBeLessThanOrEqual(COMPUTER_USE_TRANSFER_LABEL_MAX - 'control:'.length);
      expect(() => transfer(shown, 'x')).not.toThrow();
      expect(() => transfer(shown, computerUseArtifactExcerpt('x'))).not.toThrow();
    });

    it('a label cut by what is shown ends with the cut mark and never half an escape', () => {
      const shown = computerUseDisplayLabel(cp(0x10fffd).repeat(64));
      expect(shown.endsWith('…')).toBe(true);
      expect(shown.slice(0, -1)).toMatch(/^(⟦U\+10FFFD⟧)+$/u);
    });

    it('an excerpt of the longest escapes still fits', () => {
      const shown = computerUseArtifactExcerpt(cp(0x10fffd).repeat(300));
      expect(shown.length).toBeLessThanOrEqual(COMPUTER_USE_EXCERPT_MAX);
      expect(() => transfer('a', shown)).not.toThrow();
    });

    it('an excerpt full of marked words still fits', () => {
      const text = Array.from({ length: 100 }, () => `p${cp(0x430)}y`).join(' ');
      expect(() => transfer('a', computerUseArtifactExcerpt(text))).not.toThrow();
    });
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
    ['a GitHub OAuth token', 'gho_0123456789abcdefghijABCDEFGHIJ'],
    ['a GitHub server token', 'ghs_0123456789abcdefghijABCDEFGHIJ'],
    ['a GitHub refresh token', 'ghr_0123456789abcdefghijABCDEFGHIJ'],
    ['a GitHub user token', 'ghu_0123456789abcdefghijABCDEFGHIJ'],
    ['an AWS temporary key id', 'ASIAIOSFODNN7EXAMPLE'],
    ['a Slack user token', 'xoxp-1234567890-abcdefghij'],
    ['a 13-digit card number', '4777777777771'],
    ['a 17-digit card number', '47777777777777777'],
    ['an 18-digit card number', '477777777777777776'],
    ['a 19-digit card number', '4777777777777777775'],
    ['a card number followed by an expiry date', '4111 1111 1111 1111 12/28'],
    ['a card number followed by a CVV', '4111 1111 1111 1111 123'],
    ['a card number after a short number', '1 4111 1111 1111 1111'],
    ['a 19-digit card number printed 4-4-4-4-3', '4777 7777 7777 7777 775'],
    ['a 13-digit card number printed 4-4-4-1', '4777 7777 7777 1'],
    ['a card number in 5-5-6 groups', '41111 11111 111111'],
    ['an Amex number printed 4-6-5', '3782 822463 10005'],
    ['a card number followed by one more digit', '5555 5555 5555 4444 1'],
    ['a card number split by tabs', '4111\t1111\t1111\t1111'],
    ['a card number split across lines', '4111\n1111\n1111\n1111'],
    ['a six-digit code', '482913'],
    ['an eight-digit code with spaces around', '  12345678 '],
    ['a six-digit code shown as 3 + 3', '482 913'],
    ['a six-digit code with a hyphen', '482-913'],
    ['an eight-digit code shown as 4 + 4', '1234 5678'],
  ])('flags %s', (_name, text) => {
    expect(looksSecret(text)).toBe(true);
  });

  it.each([
    ['ordinary text', 'The build finished in 12 minutes.'],
    ['a five-digit number', '48291'],
    ['a nine-digit number', '123456789'],
    ['a nine-digit number shown as 3 + 3 + 3', '123 456 789'],
    ['a five-digit number with a space', '12 345'],
    ['a code separated by two spaces', '482  913'],
    [
      'a table of numbers in tab-separated columns',
      ['3829\t41027\t5521\t90311\t774', '10293\t4482\t66120\t3317\t59012'].join('\n'),
    ],
    [
      'a column of numbers, one per line',
      ['48213', '771024', '5521', '903114', '77412', '102938'].join('\n'),
    ],
    // Luhn-valid when read as 5-5-6 with spaces, but across lines only 4-digit groups make a card.
    ['a column of 5- and 6-digit numbers', '41111\n11111\n111111'],
    // A window keeps one kind of separator: a cell next to a space-separated number is not a card.
    ['a tab-separated cell next to a spaced number', '4111\t1111 1111 1111'],
    ['a code inside a sentence', 'Order 482913 shipped'],
    ['a 16-digit number that fails Luhn', '4111 1111 1111 1112'],
    ['a 12-digit number that passes Luhn', '477777777772'],
    ['an unseparated 18-digit run that fails Luhn as a whole', '411111111111111112'],
    ['an unseparated 20-digit number that passes Luhn', '47777777777777777774'],
    [
      'twenty short numbers in a row',
      Array.from({ length: 20 }, (_, i) => (i % 2 ? '482' : '71')).join(' '),
    ],
    ['two phone numbers', '03-1234-5678 03-1234-5678'],
    ['sk- glued to a word', 'task-aaaaaaaaaaaaaaaaaaaaaa'],
    ['sk- after an underscore', 'my_sk-aaaaaaaaaaaaaaaaaaaaaa'],
    ['a dotted version', '1.2.3'],
    ['a word that starts like a key', 'skeleton key'],
  ])('lets %s through', (_name, text) => {
    expect(looksSecret(text)).toBe(false);
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

  it('is still there one millisecond before the TTL', () => {
    const { artifacts, advance } = store();
    const created = artifacts.create({ ...binding, sourceSessionId: 'session-a' }, 'x')!;
    advance(COMPUTER_USE_ARTIFACT_LIMITS.ttlMs - 1);
    expect(artifacts.take([created.artifactId], binding)).toEqual(['x']);
  });

  it('refuses a duplicate id without overwriting the artifact that has it', () => {
    const artifacts = new ComputerUseArtifactStore({ now: () => 0, randomId: () => 'same' });
    const owner = { ...binding, sourceSessionId: 'session-a' };
    expect(artifacts.create(owner, 'first')).not.toBeNull();
    expect(artifacts.create({ ...owner, taskId: 'task-2' }, 'second')).toBeNull();
    expect(artifacts.take(['same'], binding)).toEqual(['first']);
  });

  it('F1: artifacts of another Turn or policy epoch do not hold the Task allowance', () => {
    const { artifacts } = store();
    const owner = { ...binding, sourceSessionId: 'session-a' };
    const old = ['a', 'b', 'c'].map((text) => artifacts.create(owner, text)!);
    expect(artifacts.create(owner, 'd')).toBeNull();
    // A new Turn: the old ones can never be taken again, so they stop counting.
    const turn2 = { ...owner, turnId: 'turn-2' };
    const fresh = artifacts.create(turn2, 'e');
    expect(fresh).not.toBeNull();
    expect(artifacts.take([old[0]!.artifactId], binding)).toBeNull();
    // A new policy epoch does the same, and the live one under it stays.
    const epoch4 = { ...turn2, policyEpoch: 4 };
    expect(artifacts.create(epoch4, 'f')).not.toBeNull();
    expect(artifacts.take([fresh!.artifactId], { ...binding, turnId: 'turn-2' })).toBeNull();
    // Another Task's artifacts are never touched.
    const other = artifacts.create({ ...owner, taskId: 'task-2' }, 'g')!;
    artifacts.create({ ...epoch4, policyEpoch: 5 }, 'h');
    expect(artifacts.take([other.artifactId], { ...binding, taskId: 'task-2' })).toEqual(['g']);
  });

  it('peek reads without using up, and refuses what take refuses', () => {
    const { artifacts } = store();
    const created = artifacts.create({ ...binding, sourceSessionId: 'session-a' }, 'Total 42')!;
    expect(artifacts.peek([created.artifactId], binding)).toEqual(['Total 42']);
    expect(artifacts.peek([created.artifactId], binding)).toEqual(['Total 42']);
    for (const other of [
      { ...binding, taskId: 'task-2' },
      { ...binding, turnId: 'turn-2' },
      { ...binding, policyEpoch: 4 },
    ])
      expect(artifacts.peek([created.artifactId], other)).toBeNull();
    expect(artifacts.peek(['unknown'], binding)).toBeNull();
    expect(artifacts.peek([], binding)).toBeNull();
    expect(artifacts.peek([created.artifactId, created.artifactId], binding)).toBeNull();
    // Only take uses it up.
    expect(artifacts.take([created.artifactId], binding)).toEqual(['Total 42']);
    expect(artifacts.peek([created.artifactId], binding)).toBeNull();
  });

  it('peek stops at the TTL like take', () => {
    const { artifacts, advance } = store();
    const created = artifacts.create({ ...binding, sourceSessionId: 'session-a' }, 'x')!;
    advance(COMPUTER_USE_ARTIFACT_LIMITS.ttlMs);
    expect(artifacts.peek([created.artifactId], binding)).toBeNull();
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

  it('discard forgets only artifacts of its own binding (T15-8)', () => {
    const { artifacts } = store();
    const owner = { ...binding, sourceSessionId: 'session-a' };
    const id = artifacts.create(owner, 'a')!.artifactId;
    for (const other of [
      { ...binding, taskId: 'task-2' },
      { ...binding, turnId: 'turn-2' },
      { ...binding, policyEpoch: 4 },
    ]) {
      artifacts.discard([id], other);
      expect(artifacts.describe([id], binding)).not.toBeNull();
    }
    artifacts.discard([id], binding);
    expect(artifacts.describe([id], binding)).toBeNull();
  });

  it('referencesMadeBy lists only what that session made, under that binding (T15-8)', () => {
    const { artifacts } = store();
    const mine = artifacts.create({ ...binding, sourceSessionId: 'session-a' }, 'a')!.artifactId;
    artifacts.create({ ...binding, sourceSessionId: 'session-b' }, 'b');
    artifacts.create({ ...binding, taskId: 'task-2', sourceSessionId: 'session-a' }, 'c');
    expect(artifacts.referencesMadeBy('session-a', binding).map((r) => r.artifactId)).toEqual([
      mine,
    ]);
  });
});
