import { describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';
import { isWatchable } from './workspace-watcher';

const root = resolve('sprint-coder-watchable-workspace');

describe('isWatchable (issue #39)', () => {
  it('accepts an ordinary source file', () => {
    expect(isWatchable(root, 'src/app.ts')).toBe(true);
    expect(isWatchable(root, 'README.md')).toBe(true);
  });

  it('ignores directories that churn without anyone watching them', () => {
    // A recursive watch on a repository sees every build artifact and every git object. Following
    // those would flood the renderer with files the model never touched.
    for (const path of [
      '.git/index',
      'node_modules/react/index.js',
      'dist/bundle.js',
      'build/out.o',
      'coverage/lcov.info',
      'src/.venv/lib/x.py',
      'apps/desktop/.vite/deps/chunk.js',
    ])
      expect(isWatchable(root, path), path).toBe(false);
  });

  it('does not confuse a real path segment with an ignored one', () => {
    // Matched as a whole segment, so a legitimately-named source directory is not swallowed.
    expect(isWatchable(root, 'src/git-utils/index.ts')).toBe(true);
    expect(isWatchable(root, 'src/distribution.ts')).toBe(true);
    expect(isWatchable(root, 'packages/build-tools/src/a.ts')).toBe(true);
  });

  it('ignores editor scratch files, which appear during a write and vanish after it', () => {
    for (const path of ['src/.app.ts.swp', 'src/app.ts~', 'src/.#app.ts', '4913'])
      expect(isWatchable(root, path), path).toBe(false);
  });

  it('rejects a path that escapes the Workspace', () => {
    expect(isWatchable(root, '../outside.txt')).toBe(false);
    expect(isWatchable(root, resolve('sprint-coder-watchable-elsewhere/a.ts'))).toBe(false);
  });

  it('accepts an absolute path that is genuinely inside, which some platforms report', () => {
    expect(isWatchable(root, join(root, 'src', 'a.ts'))).toBe(true);
  });

  it('rejects an empty or absurdly long path', () => {
    expect(isWatchable(root, '')).toBe(false);
    expect(isWatchable(root, `src/${'a'.repeat(2000)}.ts`)).toBe(false);
  });
});
