/**
 * Structural validation of a DEFLATE stream (RFC 1951), used to tell a body that really was
 * compressed from bytes that only satisfy the two weak zlib header rules. Nothing is
 * decompressed: symbols are walked for their bit cost alone, so a body compressed against a
 * preset dictionary — whose back references point into bytes this process does not hold — is
 * checked exactly like any other. Distances are therefore judged by their symbol only: with a
 * dictionary in play, a distance beyond the output produced so far is legitimate.
 */

/** RFC 1951 §3.2.7: the order the code length alphabet's own lengths appear in a dynamic header. */
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
/** RFC 1951 §3.2.5: extra bits carried by length symbols 257-285 and by distance symbols 0-29. */
const LENGTH_EXTRA_BITS = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DISTANCE_EXTRA_BITS = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];
/** RFC 1951 §3.2.5: the smallest distance each distance symbol stands for. */
const DISTANCE_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
/** RFC 1951 §3.2.7: literal/length lengths never exceed 286 entries, distance lengths never 30. */
const MAX_LITERAL_SYMBOLS = 286;
const MAX_DISTANCE_SYMBOLS = 30;
const FIXED_LITERAL_SYMBOLS = 288;
const MAX_CODE_BITS = 15;
const END_OF_BLOCK = 256;
const ZLIB_TRAILER_BYTES = 4;
/**
 * How much of the stream is parsed before a still-valid body is taken at its word. A prefix this
 * long cannot be text that happened to match, and the work stays bounded however large the value
 * is: every symbol consumes at least one bit, so the walk is linear in the bits it is allowed.
 */
const MAX_PARSED_BYTES = 64 * 1024;
/** Keeps the bit counter inside 32-bit arithmetic. Callers bound values far below this already. */
const MAX_STREAM_BYTES = 64 * 1024 * 1024;

/** A canonical Huffman code. `left` is 0 when complete, negative when over-subscribed. */
type Huffman = { counts: number[]; symbols: number[]; left: number };
/** How a block ended: as written, against the parse budget, or not as a DEFLATE block at all. */
type Walk = 'block-end' | 'budget-reached' | 'invalid';

function createBitReader(bytes: Buffer) {
  const totalBits = bytes.length * 8;
  let position = 0;
  return {
    /** Reads `count` bits, least-significant first as RFC 1951 §3.1.1 packs them. -1 if short. */
    read(count: number): number {
      if (position + count > totalBits) return -1;
      let value = 0;
      for (let index = 0; index < count; index += 1, position += 1)
        value |= ((bytes[position >>> 3]! >>> (position & 7)) & 1) << index;
      return value;
    },
    align(): void {
      position = (position + 7) & ~7;
    },
    /** The bits between here and the next byte boundary, which a written stream leaves zero. */
    paddingBits(): number {
      const width = (8 - (position & 7)) & 7;
      if (width === 0) return 0;
      return (bytes[position >>> 3]! >>> (position & 7)) & ((1 << width) - 1);
    },
    skipBytes(count: number): boolean {
      if (position + count * 8 > totalBits) return false;
      position += count * 8;
      return true;
    },
    parsedBytes(): number {
      return position >>> 3;
    },
    /** Whole bytes left once the current position is rounded up to the next byte boundary. */
    remainingBytes(): number {
      return bytes.length - ((position + 7) >>> 3);
    },
  };
}
type BitReader = ReturnType<typeof createBitReader>;

/**
 * Builds the decode tables of RFC 1951 §3.2.2 from code lengths, in the counts/symbols form zlib's
 * own reference decoder uses. An over-subscribed code (`left` negative) describes no Huffman code
 * at all and must not be decoded with; an incomplete one (`left` positive) is legal only where the
 * format allows it, which is the caller's judgement.
 */
function buildHuffman(lengths: readonly number[], offset: number, count: number): Huffman {
  const counts = new Array<number>(MAX_CODE_BITS + 1).fill(0);
  for (let symbol = 0; symbol < count; symbol += 1) counts[lengths[offset + symbol]!]! += 1;
  let left = 1;
  for (let length = 1; length <= MAX_CODE_BITS; length += 1) {
    left = (left << 1) - counts[length]!;
    if (left < 0) return { counts, symbols: [], left };
  }
  const starts = new Array<number>(MAX_CODE_BITS + 2).fill(0);
  for (let length = 1; length <= MAX_CODE_BITS; length += 1)
    starts[length + 1] = starts[length]! + counts[length]!;
  const symbols = new Array<number>(count - counts[0]!).fill(0);
  for (let symbol = 0; symbol < count; symbol += 1) {
    const length = lengths[offset + symbol]!;
    if (length !== 0) symbols[starts[length]!++] = symbol;
  }
  return { counts, symbols, left };
}

/** Walks one code MSB-first through the canonical code. -1 for an unused code or a short read. */
function decodeSymbol(reader: BitReader, code: Huffman): number {
  let value = 0;
  let first = 0;
  let index = 0;
  for (let length = 1; length <= MAX_CODE_BITS; length += 1) {
    const bit = reader.read(1);
    if (bit < 0) return -1;
    value |= bit;
    const count = code.counts[length]!;
    if (value - first < count) return code.symbols[index + (value - first)]!;
    index += count;
    first = (first + count) << 1;
    value <<= 1;
  }
  return -1;
}

const FIXED = (() => {
  const literals = new Array<number>(FIXED_LITERAL_SYMBOLS)
    .fill(0)
    .map((_, symbol) => (symbol < 144 ? 8 : symbol < 256 ? 9 : symbol < 280 ? 7 : 8));
  return {
    literals: buildHuffman(literals, 0, FIXED_LITERAL_SYMBOLS),
    // RFC 1951 §3.2.6 gives 30 distance codes 5 bits wide, leaving codes 30 and 31 unused: this
    // code is deliberately incomplete, and decoding either of them fails as it must.
    distances: buildHuffman(
      new Array<number>(MAX_DISTANCE_SYMBOLS).fill(5),
      0,
      MAX_DISTANCE_SYMBOLS,
    ),
  };
})();

/** RFC 1951 §3.2.7. `undefined` for any header that is not a well formed pair of code tables. */
function readDynamicCodes(
  reader: BitReader,
): { literals: Huffman; distances: Huffman } | undefined {
  const literalCount = reader.read(5);
  const distanceCount = reader.read(5);
  const lengthCount = reader.read(4);
  if (literalCount < 0 || distanceCount < 0 || lengthCount < 0) return undefined;
  const literals = literalCount + 257;
  const distances = distanceCount + 1;
  if (literals > MAX_LITERAL_SYMBOLS || distances > MAX_DISTANCE_SYMBOLS) return undefined;
  const codeLengths = new Array<number>(CODE_LENGTH_ORDER.length).fill(0);
  for (let index = 0; index < lengthCount + 4; index += 1) {
    const length = reader.read(3);
    if (length < 0) return undefined;
    codeLengths[CODE_LENGTH_ORDER[index]!] = length;
  }
  // The alphabet the lengths themselves are written in must be exactly complete: a decoder that
  // met an unused code here would have nothing to read the following lengths with.
  const lengthCode = buildHuffman(codeLengths, 0, codeLengths.length);
  if (lengthCode.left !== 0) return undefined;
  const lengths = new Array<number>(literals + distances).fill(0);
  let written = 0;
  while (written < lengths.length) {
    const symbol = decodeSymbol(reader, lengthCode);
    if (symbol < 0) return undefined;
    if (symbol < 16) {
      lengths[written++] = symbol;
      continue;
    }
    let repeat: number;
    let value = 0;
    if (symbol === 16) {
      if (written === 0) return undefined;
      value = lengths[written - 1]!;
      repeat = reader.read(2);
      if (repeat < 0) return undefined;
      repeat += 3;
    } else if (symbol === 17) {
      repeat = reader.read(3);
      if (repeat < 0) return undefined;
      repeat += 3;
    } else {
      repeat = reader.read(7);
      if (repeat < 0) return undefined;
      repeat += 11;
    }
    if (written + repeat > lengths.length) return undefined;
    for (let index = 0; index < repeat; index += 1) lengths[written++] = value;
  }
  // Without an end-of-block code the block could never be closed.
  if (lengths[END_OF_BLOCK] === 0) return undefined;
  const literalCode = buildHuffman(lengths, 0, literals);
  const distanceCode = buildHuffman(lengths, literals, distances);
  // Incomplete codes are legal only in the degenerate case zlib itself allows: a single code of
  // one bit, every other symbol unused.
  const usable = (code: Huffman, count: number) =>
    code.left === 0 || (code.left > 0 && count === code.counts[0]! + code.counts[1]!);
  if (!usable(literalCode, literals) || !usable(distanceCode, distances)) return undefined;
  return { literals: literalCode, distances: distanceCode };
}

/** RFC 1951 §3.2.4: an uncompressed block carries its length and that length's ones complement. */
function walkStoredBlock(reader: BitReader): Walk {
  reader.align();
  const length = reader.read(16);
  const complement = reader.read(16);
  if (length < 0 || complement < 0 || (length ^ 0xffff) !== complement) return 'invalid';
  return reader.skipBytes(length) ? 'block-end' : 'invalid';
}

function walkCompressedBlock(
  reader: BitReader,
  literals: Huffman,
  distances: Huffman,
  windowBytes: number,
): Walk {
  for (;;) {
    if (reader.parsedBytes() >= MAX_PARSED_BYTES) return 'budget-reached';
    const symbol = decodeSymbol(reader, literals);
    if (symbol < 0) return 'invalid';
    if (symbol === END_OF_BLOCK) return 'block-end';
    // A literal is the whole symbol; only a length/distance pair carries further bits.
    if (symbol < END_OF_BLOCK) continue;
    const length = symbol - 257;
    if (length >= LENGTH_EXTRA_BITS.length) return 'invalid';
    if (reader.read(LENGTH_EXTRA_BITS[length]!) < 0) return 'invalid';
    const distance = decodeSymbol(reader, distances);
    if (distance < 0 || distance >= DISTANCE_EXTRA_BITS.length) return 'invalid';
    const extra = reader.read(DISTANCE_EXTRA_BITS[distance]!);
    if (extra < 0) return 'invalid';
    // How far back a reference may reach is the window the header declared, and a preset
    // dictionary lives inside that same window. Nothing further back can be a written reference,
    // while a reference beyond the output produced so far stays legitimate here: reaching into
    // the dictionary is exactly what these streams do.
    if (DISTANCE_BASE[distance]! + extra > windowBytes) return 'invalid';
  }
}

/**
 * True when `bytes` parse as the DEFLATE body of a zlib stream whose window is `windowBytes`:
 * every block header is well formed, every symbol is one the format defines, every reference
 * stays inside the window, and the stream ends exactly where a written one does — on a final
 * block, zero-padded to its last byte, followed by nothing but the 4-byte Adler-32 of RFC 1950
 * §2.2. A body longer than the parse budget is taken at its word once that much of it has held
 * together; text cannot stay well formed for that long.
 *
 * How it ends is what keeps ordinary text out, and measurably so: text must decode as symbols and
 * then run out at the one position, and on the one bit, a written stream would. Zero padding is
 * not required by RFC 1951, but zlib — the writer behind every stream this app can meet — always
 * pads that way. The cost of all three is that a real stream which was cut short, damaged, or
 * stored with trailing bytes reads as ordinary bytes here, the same trade this decoder already
 * makes for any stream it cannot inflate.
 */
export function isWellFormedDeflateStream(bytes: Buffer, windowBytes: number): boolean {
  if (bytes.length === 0 || bytes.length > MAX_STREAM_BYTES) return false;
  const reader = createBitReader(bytes);
  for (;;) {
    if (reader.parsedBytes() >= MAX_PARSED_BYTES) return true;
    const header = reader.read(3);
    if (header < 0) return false;
    const type = header >>> 1;
    // RFC 1951 §3.2.3 reserves BTYPE 3, so these bytes were never a written block.
    if (type === 3) return false;
    let walk: Walk;
    if (type === 0) walk = walkStoredBlock(reader);
    else {
      const codes = type === 1 ? FIXED : readDynamicCodes(reader);
      if (codes === undefined) return false;
      walk = walkCompressedBlock(reader, codes.literals, codes.distances, windowBytes);
    }
    if (walk === 'invalid') return false;
    if (walk === 'budget-reached') return true;
    if ((header & 1) === 1)
      return reader.paddingBits() === 0 && reader.remainingBytes() === ZLIB_TRAILER_BYTES;
  }
}
