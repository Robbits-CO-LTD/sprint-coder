import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Runtime Host Windows console policy', () => {
  it.each(['authentication-probe.ts', 'claude-adapter.ts', 'codex-adapter.ts', 'process-tree.ts'])(
    'sets windowsHide on every production spawn in %s',
    (file) => {
      const source = readFileSync(join(__dirname, file), 'utf8');
      const spawnCount = source.match(/\bspawn\(/gu)?.length ?? 0;
      const hiddenCount = source.match(/\bwindowsHide:\s*true\b/gu)?.length ?? 0;

      expect(spawnCount).toBeGreaterThan(0);
      expect(hiddenCount).toBe(spawnCount);
    },
  );
});
