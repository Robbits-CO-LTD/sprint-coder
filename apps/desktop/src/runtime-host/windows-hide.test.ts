import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Runtime Host Windows console policy', () => {
  it.each([
    'authentication-probe.ts',
    'claude-adapter.ts',
    'codex-adapter.ts',
    'process-tree.ts',
    'owned-cli-process.ts',
  ])('sets windowsHide on every production spawn in %s', (file) => {
    const source = readFileSync(join(__dirname, file), 'utf8');
    // Count the owned CLI factory at adapter call sites, but not its declaration.
    const spawnCount =
      source.match(/(?<!function )\b(?:spawn|spawnOwnedCliProcess)\(/gu)?.length ?? 0;
    const hiddenCount = source.match(/\bwindowsHide:\s*true\b/gu)?.length ?? 0;

    expect(spawnCount).toBeGreaterThan(0);
    expect(hiddenCount).toBe(spawnCount);
  });
});
