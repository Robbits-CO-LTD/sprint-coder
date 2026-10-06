import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { partitionWindowsTests } from './vitest.config';
import { electronTestExecutablePath } from './src/main/electron-test-runtime';

const root = resolve('/ci/desktop');
const specification = (path: string, pool = 'forks') => ({
  moduleId: resolve(root, path),
  pool,
});

describe('Windows CI test partition', () => {
  it('can be imported directly by the Electron bridge without the Vite config bundler', () => {
    const configUrl = pathToFileURL(resolve(__dirname, 'vitest.config.ts')).href;
    expect(() =>
      execFileSync(
        electronTestExecutablePath(),
        ['--input-type=module', '-e', `await import(${JSON.stringify(configUrl)})`],
        {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          timeout: 20_000,
          stdio: 'pipe',
        },
      ),
    ).not.toThrow();
  });

  it('preserves every specification exactly once, including new files and multiple pools', () => {
    const files = [
      specification('src/main/team-coordinator.test.ts'),
      specification('new.test.ts'),
      specification('new.test.ts', 'threads'),
      ...Array.from({ length: 400 }, (_, index) => specification(`future-${index}.test.ts`)),
    ];
    const original = [...files];
    for (const count of [1, 3, 7]) {
      const groups = partitionWindowsTests(files, root, count);
      expect(groups).toHaveLength(count);
      expect(groups.flat()).toHaveLength(files.length);
      expect(new Set(groups.flat())).toEqual(new Set(files));
      expect(files).toEqual(original);
    }
  });

  it('assigns the same files to each shard regardless of discovery order', () => {
    const files = Array.from({ length: 30 }, (_, index) => specification(`${index}.test.ts`));
    expect(partitionWindowsTests([...files].reverse(), root, 3)).toEqual(
      partitionWindowsTests(files, root, 3),
    );
  });

  it('separates the measured slow bridges and spreads unknown files across the remaining load', () => {
    const coordinator = specification('src/main/team-coordinator.test.ts');
    const graph = specification('src/main/graph-mission-persistence.test.ts');
    const persistence = specification('src/main/persistence.test.ts');
    const files = [coordinator, graph, persistence];
    expect(partitionWindowsTests(files, root, 3)).toEqual([[coordinator], [graph], [persistence]]);
    const unknown = Array.from({ length: 300 }, (_, index) =>
      specification(`new-${index}.test.ts`),
    );
    const groups = partitionWindowsTests([...files, ...unknown], root, 3);
    const weight = (file: (typeof files)[number]) =>
      file === coordinator ? 273 : file === graph ? 209 : file === persistence ? 93 : 1;
    const loads = groups.map((group) => group.reduce((sum, file) => sum + weight(file), 0));
    expect(Math.max(...loads) - Math.min(...loads)).toBeLessThanOrEqual(1);
  });

  it('handles empty and undersized collections without dropping tests', () => {
    expect(partitionWindowsTests([], root, 3)).toEqual([[], [], []]);
    const file = specification('single.test.ts');
    expect(partitionWindowsTests([file], root, 3)).toEqual([[file], [], []]);
    for (const count of [0, -1, 1.5, NaN]) {
      expect(() => partitionWindowsTests([file], root, count)).toThrow('Invalid CI shard count');
    }
  });
});
