import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as FsPromises from 'node:fs/promises';
import { readGgufBlockCount, readGgufModelMetadata } from './gguf-metadata';

const roots: string[] = [];
const io = vi.hoisted(() => ({ reads: 0 }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof FsPromises>();
  return {
    ...original,
    open: async (...args: Parameters<typeof original.open>) => {
      const handle = await original.open(...args);
      const read = handle.read.bind(handle);
      handle.read = ((...readArgs: Parameters<typeof read>) => {
        io.reads += 1;
        return read(...readArgs);
      }) as typeof handle.read;
      return handle;
    },
  };
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function uint32(value: number): Buffer {
  const output = Buffer.alloc(4);
  output.writeUInt32LE(value);
  return output;
}

function uint64(value: number): Buffer {
  const output = Buffer.alloc(8);
  output.writeBigUInt64LE(BigInt(value));
  return output;
}

function string(value: string): Buffer {
  const body = Buffer.from(value, 'utf8');
  return Buffer.concat([uint64(body.length), body]);
}

function metadataString(key: string, value: string): Buffer {
  return Buffer.concat([string(key), uint32(8), string(value)]);
}

function metadataUint32(key: string, value: number): Buffer {
  return Buffer.concat([string(key), uint32(4), uint32(value)]);
}

function gguf(entries: readonly Buffer[]): Buffer {
  return Buffer.concat([
    Buffer.from('GGUF', 'ascii'),
    uint32(3),
    uint64(0),
    uint64(entries.length),
    ...entries,
  ]);
}

async function fixture(body: Buffer): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sprint-coder-gguf-meta-'));
  roots.push(root);
  const path = join(root, 'model.gguf');
  await writeFile(path, body);
  return path;
}

describe('readGgufBlockCount', () => {
  it('reads tokenizer strings in bounded blocks rather than issuing one read per token', async () => {
    const tokens = Buffer.concat([
      string('tokenizer.ggml.tokens'),
      uint32(9),
      uint32(8),
      uint64(5000),
      ...Array.from({ length: 5000 }, () => string('token')),
    ]);
    const path = await fixture(gguf([tokens, metadataUint32('llama.block_count', 40)]));
    io.reads = 0;
    expect(await readGgufBlockCount(path)).toBe(40);
    expect(io.reads).toBeLessThan(20);
  });
  it('reads one architecture block count without loading tensor data', async () => {
    const path = await fixture(
      gguf([
        metadataString('general.architecture', 'llama'),
        metadataUint32('llama.block_count', 40),
      ]),
    );
    expect(await readGgufBlockCount(path)).toBe(40);
  });

  it('fails closed for malformed or ambiguous metadata', async () => {
    const malformed = await fixture(Buffer.from('not-gguf'));
    const ambiguous = await fixture(
      gguf([metadataUint32('llama.block_count', 40), metadataUint32('vision.block_count', 24)]),
    );
    expect(await readGgufBlockCount(malformed)).toBeNull();
    expect(await readGgufBlockCount(ambiguous)).toBeNull();
  });
});

describe('readGgufModelMetadata', () => {
  it('identifies a DFlash draft and its architecture-bound context from the actual GGUF', async () => {
    const path = await fixture(
      gguf([
        metadataString('general.architecture', 'dflash'),
        metadataUint32('dflash.block_count', 2),
        metadataUint32('dflash.context_length', 32768),
      ]),
    );
    expect(await readGgufModelMetadata(path)).toEqual({
      architecture: 'dflash',
      blockCount: 2,
      contextLength: 32768,
    });
  });

  it.each([
    [],
    [metadataUint32('dflash.context_length', 0)],
    [metadataUint32('llama.context_length', 32768)],
    [metadataString('dflash.context_length', '32768')],
    [
      metadataUint32('dflash.context_length', 32768),
      metadataUint32('dflash.context_length', 32768),
    ],
    [metadataUint32('dflash.context_length', 32768), metadataUint32('vision.context_length', 2048)],
  ])(
    'does not infer a context limit from missing, invalid, or ambiguous metadata: %j',
    async (...entries) => {
      const path = await fixture(
        gguf([metadataString('general.architecture', 'dflash'), ...entries]),
      );
      expect((await readGgufModelMetadata(path))?.contextLength).toBeNull();
    },
  );

  it('rejects duplicate architecture keys even when they agree', async () => {
    const path = await fixture(
      gguf([
        metadataString('general.architecture', 'dflash'),
        metadataString('general.architecture', 'dflash'),
        metadataUint32('dflash.context_length', 32768),
      ]),
    );
    expect(await readGgufModelMetadata(path)).toEqual({
      architecture: null,
      blockCount: null,
      contextLength: null,
    });
  });

  it('rejects truncated and oversized architecture strings without reading model tensors', async () => {
    const truncated = await fixture(
      gguf([metadataString('general.architecture', 'dflash')]).subarray(0, 40),
    );
    const oversized = await fixture(
      gguf([metadataString('general.architecture', 'x'.repeat(129))]),
    );
    expect(await readGgufModelMetadata(truncated)).toBeNull();
    expect(await readGgufModelMetadata(oversized)).toBeNull();
  });
});
