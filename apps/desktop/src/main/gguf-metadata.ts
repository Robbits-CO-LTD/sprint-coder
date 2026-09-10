import { constants } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';

const GGUF_MAGIC = Buffer.from('GGUF', 'ascii');
const MAX_METADATA_ENTRIES = 65_536;
const MAX_METADATA_BYTES = 64 * 1024 * 1024;
const MAX_KEY_BYTES = 1_024;
const MAX_ARRAY_ITEMS = 1_000_000;

const FIXED_VALUE_BYTES: Readonly<Record<number, number>> = {
  0: 1, // uint8
  1: 1, // int8
  2: 2, // uint16
  3: 2, // int16
  4: 4, // uint32
  5: 4, // int32
  6: 4, // float32
  7: 1, // bool
  10: 8, // uint64
  11: 8, // int64
  12: 8, // float64
};

class GgufReader {
  private position = 0;
  private buffer: Buffer = Buffer.alloc(0);
  private bufferStart = 0;

  constructor(
    private readonly handle: FileHandle,
    private readonly fileSize: number,
  ) {}

  private ensure(length: number): void {
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      this.position + length > this.fileSize ||
      this.position + length > MAX_METADATA_BYTES
    )
      throw new Error('GGUF metadata exceeds its bounded prefix');
  }

  async bytes(length: number): Promise<Buffer> {
    this.ensure(length);
    const output = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const position = this.position + offset;
      if (position < this.bufferStart || position >= this.bufferStart + this.buffer.length) {
        const buffer = Buffer.allocUnsafe(
          Math.min(64 * 1024, this.fileSize - position, MAX_METADATA_BYTES - position),
        );
        const result = await this.handle.read(buffer, 0, buffer.length, position);
        if (result.bytesRead === 0) throw new Error('Unexpected GGUF metadata EOF');
        this.buffer = buffer.subarray(0, result.bytesRead);
        this.bufferStart = position;
      }
      const start = position - this.bufferStart;
      const count = Math.min(length - offset, this.buffer.length - start);
      this.buffer.copy(output, offset, start, start + count);
      offset += count;
    }
    this.position += length;
    return output;
  }

  skip(length: number): void {
    this.ensure(length);
    this.position += length;
  }

  async uint32(): Promise<number> {
    return (await this.bytes(4)).readUInt32LE(0);
  }

  async uint64(): Promise<number> {
    const value = (await this.bytes(8)).readBigUInt64LE(0);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('GGUF integer exceeds safe range');
    return Number(value);
  }

  async string(maxBytes: number): Promise<string> {
    const length = await this.uint64();
    if (length > maxBytes) throw new Error('GGUF metadata string exceeds its bound');
    return (await this.bytes(length)).toString('utf8');
  }
}

async function skipValue(reader: GgufReader, type: number): Promise<void> {
  const fixed = FIXED_VALUE_BYTES[type];
  if (fixed !== undefined) {
    reader.skip(fixed);
    return;
  }
  if (type === 8) {
    const length = await reader.uint64();
    reader.skip(length);
    return;
  }
  if (type !== 9) throw new Error('Unsupported GGUF metadata type');
  const itemType = await reader.uint32();
  if (itemType === 9) throw new Error('Nested GGUF metadata arrays are unsupported');
  const count = await reader.uint64();
  if (count > MAX_ARRAY_ITEMS) throw new Error('GGUF metadata array exceeds its bound');
  const itemBytes = FIXED_VALUE_BYTES[itemType];
  if (itemBytes !== undefined) {
    reader.skip(count * itemBytes);
    return;
  }
  if (itemType !== 8) throw new Error('Unsupported GGUF metadata array type');
  for (let index = 0; index < count; index += 1) {
    const length = await reader.uint64();
    reader.skip(length);
  }
}

async function integerValue(reader: GgufReader, type: number): Promise<number | null> {
  if (type === 4) return reader.uint32();
  if (type === 5) return (await reader.bytes(4)).readInt32LE(0);
  if (type === 10) return reader.uint64();
  if (type === 11) {
    const value = (await reader.bytes(8)).readBigInt64LE(0);
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : null;
  }
  await skipValue(reader, type);
  return null;
}

export type GgufModelMetadata = Readonly<{
  architecture: string | null;
  blockCount: number | null;
  contextLength: number | null;
  kvBytesPerToken?: number;
  hiddenBytesPerToken?: number;
}>;

/** Reads metadata only; model weights and tokenizer contents are never materialized. */
export async function readGgufModelMetadata(path: string): Promise<GgufModelMetadata | null> {
  let handle: FileHandle | null = null;
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) return null;
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== before.dev || stat.ino !== before.ino)
      return null;
    const reader = new GgufReader(handle, stat.size);
    if (!(await reader.bytes(4)).equals(GGUF_MAGIC)) return null;
    const version = await reader.uint32();
    if (version < 2 || version > 3) return null;
    await reader.uint64(); // tensor count
    const metadataCount = await reader.uint64();
    if (metadataCount > MAX_METADATA_ENTRIES) return null;

    const blockCounts: number[] = [];
    let architectureEntries = 0;
    let architecture: string | null = null;
    const contexts: Array<{ key: string; value: number | null }> = [];
    const dimensions = new Map<string, number | null>();
    const recordDimension = (key: string, value: number | null) => {
      dimensions.set(key, dimensions.has(key) ? null : value);
    };
    for (let index = 0; index < metadataCount; index += 1) {
      const key = await reader.string(MAX_KEY_BYTES);
      const type = await reader.uint32();
      if (key === 'general.architecture') {
        architectureEntries += 1;
        if (type === 8) {
          const value = await reader.string(128);
          architecture = /^[a-z][a-z0-9_]{0,127}$/u.test(value) ? value : null;
        } else {
          await skipValue(reader, type);
        }
      } else if (key.endsWith('.context_length')) {
        contexts.push({ key, value: await integerValue(reader, type) });
      } else if (key.endsWith('.block_count')) {
        const value = await integerValue(reader, type);
        recordDimension(key, value);
        if (value !== null && Number.isSafeInteger(value) && value > 0 && value <= 4_096)
          blockCounts.push(value);
      } else if (
        /\.(?:embedding_length|attention\.(?:head_count|head_count_kv|key_length|value_length))$/u.test(
          key,
        )
      ) {
        recordDimension(key, await integerValue(reader, type));
      } else if (key.endsWith('.target_layers') && type === 9) {
        const itemType = await reader.uint32();
        const count = await reader.uint64();
        if (![4, 5, 10, 11].includes(itemType) || count > MAX_ARRAY_ITEMS) return null;
        reader.skip(count * FIXED_VALUE_BYTES[itemType]!);
        recordDimension(key, count);
      } else {
        await skipValue(reader, type);
      }
    }
    if (architectureEntries !== 1) architecture = null;
    const context = contexts.length === 1 ? contexts[0] : undefined;
    const dimension = (suffix: string) => {
      const value = dimensions.get(`${architecture}.${suffix}`);
      return value != null && Number.isSafeInteger(value) && value > 0 ? value : null;
    };
    const embedding = dimension('embedding_length');
    const heads = dimension('attention.head_count');
    const kvHeads = dimension('attention.head_count_kv');
    const layers = dimension('block_count');
    const fallbackHeadSize =
      embedding !== null && heads !== null && embedding % heads === 0 ? embedding / heads : null;
    const keyLength = dimensions.has(`${architecture}.attention.key_length`)
      ? dimension('attention.key_length')
      : fallbackHeadSize;
    const valueLength = dimensions.has(`${architecture}.attention.value_length`)
      ? dimension('attention.value_length')
      : fallbackHeadSize;
    const kvBytes =
      architecture !== null &&
      layers !== null &&
      layers <= 4096 &&
      heads !== null &&
      kvHeads !== null &&
      kvHeads <= heads &&
      keyLength !== null &&
      valueLength !== null
        ? 2 * layers * kvHeads * (keyLength + valueLength)
        : null;
    const targetLayers = dimension('target_layers');
    const hiddenBytes =
      architecture === 'dflash' && embedding !== null && targetLayers !== null
        ? 2 * embedding * targetLayers
        : null;
    return {
      architecture,
      blockCount: blockCounts.length === 1 ? blockCounts[0]! : null,
      ...(kvBytes !== null && Number.isSafeInteger(kvBytes) ? { kvBytesPerToken: kvBytes } : {}),
      ...(hiddenBytes !== null && Number.isSafeInteger(hiddenBytes)
        ? { hiddenBytesPerToken: hiddenBytes }
        : {}),
      contextLength:
        architecture !== null &&
        context?.key === `${architecture}.context_length` &&
        context.value !== null &&
        Number.isSafeInteger(context.value) &&
        context.value > 0
          ? context.value
          : null,
    };
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/** Keeps the existing block-count-only callers compatible with metadata lacking an architecture. */
export async function readGgufBlockCount(path: string): Promise<number | null> {
  return (await readGgufModelMetadata(path))?.blockCount ?? null;
}
