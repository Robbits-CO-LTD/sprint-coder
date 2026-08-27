import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readGgufBlockCount } from './gguf-metadata';

const roots: string[] = [];

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
