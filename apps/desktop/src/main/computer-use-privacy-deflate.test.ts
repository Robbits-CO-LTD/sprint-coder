import { deflateRawSync, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { isWellFormedDeflateStream } from './computer-use-privacy-deflate';

const DICTIONARY = Buffer.from('PRIVATE_FIXTURE_typed_text preset dictionary');
/** RFC 1950 §2.2: CMF, FLG and the DICTID an FDICT stream carries before its DEFLATE body. */
const DICTIONARY_HEADER_BYTES = 6;
const MAX_WINDOW_BYTES = 32768;

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

/** Deterministic printable-ASCII noise, so a measured false-positive count stays reproducible. */
function pseudoRandomText(seed: number, length: number): string {
  let state = seed >>> 0;
  let text = '';
  for (let index = 0; index < length; index += 1) {
    state = (state * 1103515245 + 12345) >>> 0;
    text += String.fromCharCode(0x20 + ((state >>> 16) % 95));
  }
  return text;
}

describe('DEFLATE structural validation', () => {
  it('accepts the body of a stream compressed against a preset dictionary', () => {
    for (const level of [0, 1, 6, 9])
      for (const windowBits of [9, 12, 15])
        // Level 0 stores its input, so only there does payload size decide the body size.
        for (const size of level === 0 ? [1, 64, 4096] : [1, 64, 4096, 300 * 1024]) {
          const payload = Buffer.from(
            'PRIVATE_FIXTURE_typed_text preset dictionary log line '.repeat(size / 20 + 1),
          ).subarray(0, size);
          const stream = deflateSync(payload, { dictionary: DICTIONARY, level, windowBits });
          expect(stream[1]! & 0x20).toBe(0x20);
          expect(isWellFormedDeflateStream(...body(stream))).toBe(true);
        }
  });

  it('leaves a body still running when the walk spends its budget a look-alike', () => {
    // The stated limit of bounding the walk: once the budget is spent the parse says nothing, so
    // a real stream this large falls back to the raw scan it would have had anyway. Stored bytes
    // are stepped over rather than walked, so the body that still ends in time is checked too.
    for (const [payloadBytes, recognised] of [
      [64 * 1024, true],
      [512 * 1024, false],
    ] as const) {
      const stream = deflateSync(Buffer.alloc(payloadBytes, 0x41), {
        dictionary: DICTIONARY,
        level: 0,
      });
      expect(stream.length - DICTIONARY_HEADER_BYTES).toBeGreaterThan(64 * 1024);
      expect(isWellFormedDeflateStream(...body(stream))).toBe(recognised);
    }
  });

  it('accepts a raw stream that ends as written and rejects one that ends anywhere else', () => {
    for (const level of [0, 1, 9]) {
      const raw = deflateRawSync(Buffer.from('ordinary log line\n'.repeat(4)), { level });
      // Level 0 stores; the others compress. Dynamic blocks are covered by the test below.
      expect((raw[0]! >>> 1) & 3).toBe(level === 0 ? 0 : 1);
      const stream = Buffer.concat([raw, Buffer.alloc(4)]);
      expect(isWellFormedDeflateStream(stream, MAX_WINDOW_BYTES)).toBe(true);
      // Nothing where the checksum belongs, and a body this short cannot vouch for extra bytes.
      expect(isWellFormedDeflateStream(raw, MAX_WINDOW_BYTES)).toBe(false);
      expect(isWellFormedDeflateStream(Buffer.concat([stream, Buffer.alloc(1)]), 32768)).toBe(
        false,
      );
      expect(isWellFormedDeflateStream(stream.subarray(0, stream.length - 6), 32768)).toBe(false);
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
      expect(isWellFormedDeflateStream(longBody, window)).toBe(true);
      const [shortBody] = body(Buffer.concat([short, Buffer.from(tail)]));
      expect(isWellFormedDeflateStream(shortBody, window)).toBe(false);
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
    expect(isWellFormedDeflateStream(stream.subarray(DICTIONARY_HEADER_BYTES), 32768)).toBe(true);
    // The same bytes read as a 512-byte-window stream describe a reference that cannot exist.
    expect(isWellFormedDeflateStream(stream.subarray(DICTIONARY_HEADER_BYTES), 512)).toBe(false);
  });

  it('rejects an empty buffer, a reserved block type and a stored block with a bad complement', () => {
    expect(isWellFormedDeflateStream(Buffer.alloc(0), MAX_WINDOW_BYTES)).toBe(false);
    // BFINAL=1 with the reserved BTYPE 3 of RFC 1951 §3.2.3.
    expect(isWellFormedDeflateStream(Buffer.from([0x07, 0, 0, 0, 0]), MAX_WINDOW_BYTES)).toBe(
      false,
    );
    const stored = Buffer.from([0x01, 0x02, 0x00, 0xfd, 0xff, 0x41, 0x42, 0, 0, 0, 0]);
    expect(isWellFormedDeflateStream(stored, MAX_WINDOW_BYTES)).toBe(true);
    stored[3] = 0xfc;
    expect(isWellFormedDeflateStream(stored, MAX_WINDOW_BYTES)).toBe(false);
  });

  it('rejects a dynamic header that no longer describes a usable pair of codes', () => {
    const raw = deflateRawSync(Buffer.from(pseudoRandomText(7, 4096)), { level: 9 });
    expect((raw[0]! >>> 1) & 3).toBe(2);
    const stream = Buffer.concat([raw, Buffer.alloc(4)]);
    expect(isWellFormedDeflateStream(stream, MAX_WINDOW_BYTES)).toBe(true);
    let rejected = 0;
    for (let at = 1; at <= 8; at += 1) {
      const broken = Buffer.from(stream);
      broken[at] = broken[at]! ^ 0xff;
      if (!isWellFormedDeflateStream(broken, MAX_WINDOW_BYTES)) rejected += 1;
    }
    // Not every flip has to be fatal, but a header this heavily damaged cannot stay well formed.
    expect(rejected).toBe(8);
  });

  it('refuses a repeating byte pattern however long it holds together', () => {
    // A constant fill decodes into valid symbols for as long as it repeats — 63 of the 256 of
    // them do, printable ones among them. Such a run is not a written stream, and reaching the
    // parse budget must never be read as if it were.
    const accepted = [];
    for (let byte = 0; byte <= 0xff; byte += 1)
      if (isWellFormedDeflateStream(Buffer.alloc(70 * 1024, byte), MAX_WINDOW_BYTES))
        accepted.push(byte);
    expect(accepted).toEqual([]);
  });

  it('finishes a pathological input in bounded time', () => {
    // Uniform bytes are the cheapest way to hold a parse open, and a large real stream is the
    // slowest legitimate input: both may only cost work proportional to the bits allowed.
    const started = performance.now();
    for (const byte of [0x00, 0x55, 0xaa, 0xff])
      expect(isWellFormedDeflateStream(Buffer.alloc(1024 * 1024, byte), MAX_WINDOW_BYTES)).toBe(
        false,
      );
    const stream = deflateSync(Buffer.alloc(8 * 1024 * 1024, 0x41), { dictionary: DICTIONARY });
    // Its compressed body stays well under the parse budget, so it is still recognised.
    expect(isWellFormedDeflateStream(...body(stream))).toBe(true);
    expect(performance.now() - started).toBeLessThan(2000);
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
      if (isWellFormedDeflateStream(...body(value))) misread.push(value.toString('latin1'));
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
});
