import { constants, deflateRawSync, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { createDeflateBodyWalk } from './computer-use-privacy-deflate';

const DICTIONARY = Buffer.from('PRIVATE_FIXTURE_typed_text preset dictionary');
/** RFC 1950 §2.2: CMF, FLG and the DICTID an FDICT stream carries before its DEFLATE body. */
const DICTIONARY_HEADER_BYTES = 6;
const MAX_WINDOW_BYTES = 32768;

/** A walk of its own, so one case never spends the budget another one needs. */
function reads(bytes: Buffer, windowBytes: number) {
  return createDeflateBodyWalk()(bytes, windowBytes);
}

/** The body of a zlib stream, with the window its own header declares. */
function body(stream: Buffer): [Buffer, number] {
  return [stream.subarray(DICTIONARY_HEADER_BYTES), 1 << ((stream[0]! >>> 4) + 8)];
}

/** Every two-byte prefix of printable text that also passes the zlib header rules with FDICT set. */
function lookAlikeHeaders(): { cmf: number; flg: number }[] {
  const headers: { cmf: number; flg: number }[] = [];
  for (let cmf = 0x20; cmf <= 0x7e; cmf += 1) {
    if ((cmf & 0x0f) !== 8 || cmf >>> 4 > 7) continue;
    for (let flg = 0x20; flg <= 0x7e; flg += 1)
      if ((cmf * 256 + flg) % 31 === 0 && (flg & 0x20) !== 0) headers.push({ cmf, flg });
  }
  return headers;
}

/** Deterministic noise, so a measured false-positive count stays reproducible. */
function pseudoRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => ((state = (state * 1103515245 + 12345) >>> 0) >>> 16) & 0xffff;
}
function pseudoRandomText(seed: number, length: number): string {
  const next = pseudoRandom(seed);
  let text = '';
  for (let index = 0; index < length; index += 1) text += String.fromCharCode(0x20 + (next() % 95));
  return text;
}
function pseudoRandomBytes(seed: number, length: number): Buffer {
  const next = pseudoRandom(seed);
  const bytes = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) bytes[index] = next() & 0xff;
  return bytes;
}
/**
 * Xorshift32, in exact 32-bit arithmetic: the plain multiply above loses its low bits past 2^53
 * and leaves a sequence zlib compresses sixteenfold, which is no use for sizing a body.
 */
function incompressible(seed: number, length: number, printable = false): Buffer {
  let state = seed >>> 0 || 1;
  const bytes = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) {
    state = (state ^ (state << 13)) >>> 0;
    state = state ^ (state >>> 17);
    state = (state ^ (state << 5)) >>> 0;
    bytes[index] = printable ? 0x20 + (state % 95) : state & 0xff;
  }
  return bytes;
}

describe('DEFLATE structural validation', () => {
  it('accepts the body of a stream compressed against a preset dictionary', () => {
    for (const level of [0, 1, 6, 9])
      for (const windowBits of [9, 12, 15])
        for (const size of [1, 64, 4096, 300 * 1024]) {
          const payload = Buffer.from(
            'PRIVATE_FIXTURE_typed_text preset dictionary log line '.repeat(size / 20 + 1),
          ).subarray(0, size);
          const stream = deflateSync(payload, { dictionary: DICTIONARY, level, windowBits });
          expect(stream[1]! & 0x20).toBe(0x20);
          expect(reads(...body(stream))).toBe('written-stream');
        }
  });

  it('accepts a preset-dictionary body of any size a value may hold', () => {
    // Size decides nothing: the walk runs to the end of whatever it is given, so a body far larger
    // than any parse budget this file ever carried is read exactly like a short one. The payloads
    // are chosen so every body here is past 64KiB — incompressible bytes, text that only partly
    // compresses, and level 0, which stores.
    const payloads = {
      binary: (size: number) => incompressible(11, size),
      text: (size: number) => incompressible(13, size, true),
      mixed: (size: number) =>
        Buffer.concat([
          incompressible(17, size >> 1, true),
          incompressible(19, size - (size >> 1)),
        ]),
    };
    const cases: { name: string; bodyBytes: number }[] = [];
    const check = (name: string, payload: Buffer, options: Parameters<typeof deflateSync>[1]) => {
      const stream = deflateSync(payload, { ...options, dictionary: DICTIONARY });
      expect(stream[1]! & 0x20).toBe(0x20);
      const bodyBytes = stream.length - DICTIONARY_HEADER_BYTES;
      expect(bodyBytes).toBeGreaterThan(64 * 1024);
      expect(`${name} ${reads(...body(stream))}`).toBe(`${name} written-stream`);
      cases.push({ name, bodyBytes });
    };
    for (const [kind, make] of Object.entries(payloads))
      for (const size of [200 * 1024, 2 * 1024 * 1024])
        for (const level of [0, 1, 6, 9])
          check(`${kind} ${size} level ${level}`, make(size), { level });
    // Every other knob zlib exposes, around a body that already runs well past 64KiB.
    for (const [strategy, name] of [
      [constants.Z_DEFAULT_STRATEGY, 'default'],
      [constants.Z_FIXED, 'fixed'],
      [constants.Z_HUFFMAN_ONLY, 'huffman'],
    ] as const)
      for (const windowBits of [9, 11, 13, 15])
        for (const memLevel of [1, 5, 9])
          check(`${name} w${windowBits} m${memLevel}`, payloads.mixed(400 * 1024), {
            level: 6,
            strategy,
            windowBits,
            memLevel,
          });
    // The ceiling itself: the largest payload a caller may decode, compressed into a body of
    // several megabytes. Text, because incompressible input is stored rather than compressed.
    check('ceiling 16MiB', payloads.text(16 * 1024 * 1024), { level: 6 });
    console.info(
      JSON.stringify({
        deflateLargeBodyCases: cases.length,
        largestBodyBytes: Math.max(...cases.map(({ bodyBytes }) => bodyBytes)),
      }),
    );
  });

  it('stops walking once one inspection has spent its shared budget', () => {
    // 32MiB of body is all one file's inspection may walk, however many values ask for it: the
    // budget is what stops nested archives multiplying the work. A uniform fill holds a walk open
    // for every byte it is given, so two of them leave nothing for a third.
    const walk = createDeflateBodyWalk();
    const periodic = Buffer.alloc(16 * 1024 * 1024, 0xaa);
    expect([
      walk(periodic, MAX_WINDOW_BYTES),
      walk(periodic, MAX_WINDOW_BYTES),
      walk(periodic, MAX_WINDOW_BYTES),
    ]).toEqual(['look-alike', 'look-alike', 'budget-spent']);
    // Spending it settles nothing, so a stream that is plainly written is not vouched for either.
    const stream = deflateSync(Buffer.from('ordinary log line\n'.repeat(64)), {
      dictionary: DICTIONARY,
    });
    expect(walk(...body(stream))).toBe('budget-spent');
    // A budget belongs to one inspection: a walk of its own decides both as it did before.
    expect(reads(periodic, MAX_WINDOW_BYTES)).toBe('look-alike');
    expect(reads(...body(stream))).toBe('written-stream');
    // No caller can hand over a value past the size the bit counter is proved safe for, and one
    // that is not looked at must not read as ordinary bytes either.
    expect(reads(Buffer.alloc(64 * 1024 * 1024 + 1), MAX_WINDOW_BYTES)).toBe('budget-spent');
    expect(reads(Buffer.alloc(0), MAX_WINDOW_BYTES)).toBe('look-alike');
  });

  it('accepts a raw stream that ends as written and rejects one that ends anywhere else', () => {
    for (const level of [0, 1, 9]) {
      const raw = deflateRawSync(Buffer.from('ordinary log line\n'.repeat(4)), { level });
      // Level 0 stores; the others compress. Dynamic blocks are covered by the test below.
      expect((raw[0]! >>> 1) & 3).toBe(level === 0 ? 0 : 1);
      const stream = Buffer.concat([raw, Buffer.alloc(4)]);
      expect(reads(stream, MAX_WINDOW_BYTES)).toBe('written-stream');
      // Nothing where the checksum belongs, and a body this short cannot vouch for extra bytes.
      expect(reads(raw, MAX_WINDOW_BYTES)).toBe('look-alike');
      expect(reads(Buffer.concat([stream, Buffer.alloc(1)]), 32768)).toBe('look-alike');
      expect(reads(stream.subarray(0, stream.length - 6), 32768)).toBe('look-alike');
    }
  });

  it('accepts a long body that a value stores more bytes after', () => {
    // A log file appends after a compressed record. Only a body long enough to be no accident
    // vouches for what follows it, so the same stream shortened is refused.
    const long = deflateSync(Buffer.from(pseudoRandomText(5, 8 * 1024)), {
      dictionary: DICTIONARY,
    });
    expect(long.length - DICTIONARY_HEADER_BYTES).toBeGreaterThan(1024);
    const short = deflateSync(Buffer.from('ordinary log line\n'.repeat(4)), {
      dictionary: DICTIONARY,
    });
    expect(short.length - DICTIONARY_HEADER_BYTES).toBeLessThan(1024);
    for (const tail of ['x', 'later log line\n'.repeat(16)]) {
      const [longBody, window] = body(Buffer.concat([long, Buffer.from(tail)]));
      expect(reads(longBody, window)).toBe('written-stream');
      const [shortBody] = body(Buffer.concat([short, Buffer.from(tail)]));
      expect(reads(shortBody, window)).toBe('look-alike');
    }
  });

  it('rejects a body whose references reach past the window its header declared', () => {
    // Text that only repeats itself a few kilobytes later, so the stream must carry a long
    // distance to compress at all.
    const text = pseudoRandomText(3, 4096);
    const stream = deflateSync(Buffer.from(text + text.slice(0, 256)), {
      dictionary: DICTIONARY,
      windowBits: 15,
    });
    expect(reads(stream.subarray(DICTIONARY_HEADER_BYTES), 32768)).toBe('written-stream');
    // The same bytes read as a 512-byte-window stream describe a reference that cannot exist.
    expect(reads(stream.subarray(DICTIONARY_HEADER_BYTES), 512)).toBe('look-alike');
  });

  it('rejects an empty buffer, a reserved block type and a stored block with a bad complement', () => {
    expect(reads(Buffer.alloc(0), MAX_WINDOW_BYTES)).toBe('look-alike');
    // BFINAL=1 with the reserved BTYPE 3 of RFC 1951 §3.2.3.
    expect(reads(Buffer.from([0x07, 0, 0, 0, 0]), MAX_WINDOW_BYTES)).toBe('look-alike');
    const stored = Buffer.from([0x01, 0x02, 0x00, 0xfd, 0xff, 0x41, 0x42, 0, 0, 0, 0]);
    expect(reads(stored, MAX_WINDOW_BYTES)).toBe('written-stream');
    stored[3] = 0xfc;
    expect(reads(stored, MAX_WINDOW_BYTES)).toBe('look-alike');
  });

  it('rejects a dynamic header that no longer describes a usable pair of codes', () => {
    const raw = deflateRawSync(Buffer.from(pseudoRandomText(7, 4096)), { level: 9 });
    expect((raw[0]! >>> 1) & 3).toBe(2);
    const stream = Buffer.concat([raw, Buffer.alloc(4)]);
    expect(reads(stream, MAX_WINDOW_BYTES)).toBe('written-stream');
    let rejected = 0;
    for (let at = 1; at <= 8; at += 1) {
      const broken = Buffer.from(stream);
      broken[at] = broken[at]! ^ 0xff;
      if (reads(broken, MAX_WINDOW_BYTES) !== 'written-stream') rejected += 1;
    }
    // Not every flip has to be fatal, but a header this heavily damaged cannot stay well formed.
    expect(rejected).toBe(8);
  });

  it('refuses a repeating byte pattern however long it holds together', () => {
    // A constant fill decodes into valid symbols for as long as it repeats — 63 of the 256 of
    // them do. Such a run is not a written stream at any length, and the walk only ever says so
    // because of how the bytes end, never because it stopped looking.
    for (const size of [70 * 1024, 256 * 1024, 1024 * 1024]) {
      const accepted = [];
      for (let byte = 0; byte <= 0xff; byte += 1)
        if (reads(Buffer.alloc(size, byte), MAX_WINDOW_BYTES) !== 'look-alike') accepted.push(byte);
      expect(`${size}: ${accepted.join(',')}`).toBe(`${size}: `);
    }
  });

  it('rejects every printable-ASCII look-alike of a preset-dictionary stream', () => {
    const headers = lookAlikeHeaders();
    expect(headers.length).toBeGreaterThan(0);
    const tails = [
      '',
      ' ok',
      'est of an ordinary logged line',
      '{"level":"info","message":"session closed"}',
      'ERROR failed to open file: /Users/example/Library/Application Support/app/log.txt',
      'ラウンドが完了しました (round 12)',
      'x'.repeat(512),
      pseudoRandomText(1, 2048),
    ];
    let cases = 0;
    const misread: string[] = [];
    const check = (value: Buffer) => {
      cases += 1;
      if (reads(...body(value)) !== 'look-alike') misread.push(value.toString('latin1'));
    };
    // Every header a line of text can start with, every byte the body can start with, and a
    // handful of continuations: the shapes an ordinary log line, message or JSON value takes.
    for (const { cmf, flg } of headers)
      for (const dictid of ['ordi', '0000', '  \t\n'])
        for (let first = 0x20; first <= 0x7e; first += 1)
          for (const tail of tails)
            check(
              Buffer.concat([
                Buffer.from([cmf, flg]),
                Buffer.from(dictid),
                Buffer.from(String.fromCharCode(first) + tail),
              ]),
            );
    // Random printable text of every length, as a second corpus no hand-picked tail can flatter.
    for (let seed = 1; seed <= 100000; seed += 1)
      check(
        Buffer.concat([
          Buffer.from([headers[seed % headers.length]!.cmf, headers[seed % headers.length]!.flg]),
          Buffer.from(pseudoRandomText(seed, 4 + (seed % 400))),
        ]),
      );
    console.info(JSON.stringify({ deflateLookAlikeCorpus: cases, misread: misread.length }));
    expect(misread).toEqual([]);
  });

  it('rejects every long look-alike of a preset-dictionary stream', () => {
    // Long values are where the walk now goes further than it used to, so the shapes a large
    // stored value takes are held against it at a size no parse budget cuts short: every header
    // ordinary text can begin with, against bodies of 128KiB.
    const KIB = 1024;
    const size = 128 * KIB;
    const grow = (unit: Buffer) =>
      Buffer.concat(new Array(Math.ceil(size / unit.length)).fill(unit)).subarray(0, size);
    const text = (unit: string) => grow(Buffer.from(unit));
    const bodies = new Map<string, Buffer>([
      [
        'prose',
        text(
          'The walk reads the body without decompressing it, so a stream written against a preset dictionary is checked exactly as any other one is. ',
        ),
      ],
      [
        'japanese',
        text('セッションが完了しました。ラウンド 12 の記録を保存しています。エラーはありません。'),
      ],
      [
        'json',
        text('{"level":"info","component":"computer-use","message":"session closed","round":12},'),
      ],
      [
        'log',
        text('2026-09-18T11:22:33.456Z INFO computer-use round=12 status=ok elapsed=412ms\n'),
      ],
      ['base64', text('aGVsbG8gd29ybGQgdGhpcyBpcyBiYXNlNjQgcGFkZGluZyBkYXRhLw==')],
      ['hex', text('0123456789abcdef')],
      ['csv', text('2026-09-18,computer-use,ok,412,12,"round completed",alice@example.com\n')],
      [
        'source',
        text(
          'export function walkBody(bytes: Buffer, windowBytes: number): DeflateBody {\n  return "look-alike";\n}\n',
        ),
      ],
      ['noise', Buffer.from(pseudoRandomText(20260918, size))],
    ]);
    for (const character of [' ', '0', 'A', 'a', '\n', '\t', '\xff'])
      bodies.set(`run ${JSON.stringify(character)}`, text(character));
    for (let period = 1; period <= 16; period += 1) {
      const unit = pseudoRandomBytes(4000 + period, period);
      const repeated = grow(unit);
      const line = text('ordinary logged line ');
      bodies.set(`period ${period}`, repeated);
      // A pattern that holds the walk open and then stops being one, both ways round.
      bodies.set(
        `period ${period} then text`,
        Buffer.concat([repeated.subarray(0, size / 2), line.subarray(0, size / 2)]),
      );
      bodies.set(
        `text then run ${period}`,
        Buffer.concat([line.subarray(0, size / 2), Buffer.alloc(size / 2, unit[0]!)]),
      );
    }
    let cases = 0;
    const misread: string[] = [];
    // The DICTID a value carries is just its next four bytes when the value is ordinary text, and
    // repeating the body's own first four keeps each shape unbroken across it — without them the
    // walk would start four bytes into the body rather than at it.
    const check = (cmf: number, flg: number, name: string, bytes: Buffer) => {
      cases += 1;
      const value = Buffer.concat([Buffer.from([cmf, flg]), bytes.subarray(0, 4), bytes]);
      if (reads(...body(value)) !== 'look-alike')
        misread.push(`${cmf.toString(16)}${flg.toString(16)} ${name}`);
    };
    for (const { cmf, flg } of lookAlikeHeaders())
      for (const [name, bytes] of bodies) check(cmf, flg, name, bytes);
    // The shapes above that hold a walk open for every byte they have, at megabyte scale: the
    // periodic ones and the single-character runs, against the narrowest and widest windows a
    // look-alike header can declare. Nothing here may be decided by how far the walk went.
    const headers = lookAlikeHeaders();
    const deep = [...bodies].filter(
      ([name]) => name.startsWith('period ') || name.startsWith('run '),
    );
    const deepSize = 2 * 1024 * 1024;
    for (const { cmf, flg } of [headers[0]!, headers[headers.length - 1]!])
      for (const [name, bytes] of deep) {
        const long = Buffer.concat(new Array(Math.ceil(deepSize / bytes.length)).fill(bytes));
        check(cmf, flg, `${name} x${(deepSize / size).toFixed(0)}`, long.subarray(0, deepSize));
      }
    console.info(
      JSON.stringify({
        deflateLongLookAlikeCorpus: cases,
        bodyBytes: size,
        deepBodyBytes: deepSize,
        misread: misread.length,
      }),
    );
    expect(misread).toEqual([]);
  });

  it('finishes a pathological input in bounded time', () => {
    // The walk costs one pass over the bits it is given, so its worst case is the value ceiling
    // its callers enforce. Three inputs bracket the rate at that ceiling: a uniform fill, which
    // holds a walk open for every bit of a value; a chain of the smallest dynamic blocks that can
    // be written, which buys the most header work per byte a valid stream ever can; and a stream
    // of the largest payload a caller may decode. Text, not bytes, for the last one: an
    // incompressible payload is stored, and stored bytes are stepped over rather than walked.
    const uniform = [0x00, 0x55, 0xaa, 0xff].map((byte) => Buffer.alloc(4 * 1024 * 1024, byte));
    const chain = minimalDynamicBlockChain(12 * 1024 * 1024);
    const stream = deflateSync(incompressible(23, 16 * 1024 * 1024, true), {
      dictionary: DICTIONARY,
    });
    // Only the walks are timed. Building these fixtures is slower than reading them and would
    // otherwise decide this assertion on a loaded runner.
    const started = performance.now();
    for (const fill of uniform) expect(reads(fill, MAX_WINDOW_BYTES)).toBe('look-alike');
    const uniformMs = performance.now() - started;
    const chainStarted = performance.now();
    expect(reads(chain, MAX_WINDOW_BYTES)).toBe('written-stream');
    const chainMs = performance.now() - chainStarted;
    const streamStarted = performance.now();
    expect(reads(...body(stream))).toBe('written-stream');
    const streamMs = performance.now() - streamStarted;
    const walkedMs = performance.now() - started;
    const rate = (bytes: number, ms: number) => +(bytes / 1024 / 1024 / (ms / 1000)).toFixed(1);
    console.info(
      JSON.stringify({
        uniformFillMiBPerSecond: rate(16 * 1024 * 1024, uniformMs),
        minimalBlockChainMiBPerSecond: rate(chain.length, chainMs),
        realStreamMiBPerSecond: rate(stream.length, streamMs),
        walkedMs: Math.round(walkedMs),
      }),
    );
    // 40MiB of body, over the slowest inputs there are. The shared budget stops one file's
    // inspection at 32MiB, so this covers what a whole inspection can ask for.
    expect(walkedMs).toBeLessThan(8000);
  });
});

/**
 * The most header work a valid DEFLATE body can buy per byte: dynamic blocks whose literal code
 * holds nothing but the end-of-block symbol, so each one re-reads 258 code lengths to emit a
 * single bit. zlib inflates it, which is what makes it a fair worst case rather than a curiosity.
 */
function minimalDynamicBlockChain(targetBytes: number): Buffer {
  // Written straight into the buffer: a bit array of a twelve-megabyte chain is a hundred million
  // elements, and building it would cost far more than the walk this fixture exists to measure.
  const chain = Buffer.alloc(targetBytes + 64);
  let at = 0;
  const push = (value: number, count: number) => {
    for (let index = 0; index < count; index += 1, at += 1)
      if (((value >>> index) & 1) === 1) chain[at >>> 3]! |= 1 << (at & 7);
  };
  // Code-length alphabet: symbol 18 one bit wide, symbols 0 and 1 two bits — a complete code whose
  // canonical MSB-first codes are 18 = "0", 0 = "10", 1 = "11".
  const code = (bitString: string) => {
    for (const character of bitString) {
      if (character === '1') chain[at >>> 3]! |= 1 << (at & 7);
      at += 1;
    }
  };
  const order = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
  const emit = (final: boolean) => {
    push(final ? 1 : 0, 1);
    push(2, 2); // BTYPE 2, dynamic
    push(0, 5); // HLIT  -> 257 literal/length codes
    push(0, 5); // HDIST -> 1 distance code
    push(14, 4); // HCLEN -> 18 entries, far enough along the order to reach symbol 1
    const lengths = new Array<number>(19).fill(0);
    lengths[18] = 1;
    lengths[0] = 2;
    lengths[1] = 2;
    for (let index = 0; index < 18; index += 1) push(lengths[order[index]!]!, 3);
    code('0');
    push(138 - 11, 7); // 138 zero lengths
    code('0');
    push(118 - 11, 7); // 118 more, filling every literal below the end-of-block symbol
    code('11'); // symbol 1: the end-of-block code, one bit wide
    code('10'); // symbol 0: the single distance length
    code('0'); // the end-of-block symbol itself
  };
  while (at / 8 < targetBytes) emit(false);
  emit(true);
  // Zero-padded to the byte, then the four bytes where a zlib checksum sits.
  at = (at + 7) & ~7;
  return chain.subarray(0, at / 8 + 4);
}
