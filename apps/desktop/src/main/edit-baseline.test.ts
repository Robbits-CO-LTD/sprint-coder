import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEditBaselines, dirtyPathsFrom } from './edit-baseline';

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'sprint-coder-baseline-'));
  const git = (...args: string[]): void => {
    execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  };
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  return root;
}

function commitAll(root: string): void {
  execFileSync('git', ['-C', root, 'add', '-A'], { stdio: 'ignore' });
  execFileSync(
    'git',
    ['-C', root, '-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '-qm', 'x'],
    { stdio: 'ignore' },
  );
}

describe('dirtyPathsFrom (issue #41)', () => {
  it('collects modified, untracked, staged and both sides of a rename', () => {
    // Both sides of a rename are suspect: the Turn did not create either state, so HEAD is not a
    // safe baseline for either name.
    const paths = dirtyPathsFrom(
      [' M src/a.ts', '?? src/new.ts', 'A  src/staged.ts', 'R  src/old.ts -> src/renamed.ts'].join(
        '\n',
      ),
    );
    expect([...paths].sort()).toEqual([
      'src/a.ts',
      'src/new.ts',
      'src/old.ts',
      'src/renamed.ts',
      'src/staged.ts',
    ]);
  });

  it('unquotes a path git escaped, so an unusual name is not mistaken for clean', () => {
    expect(dirtyPathsFrom(' M "src/\\303\\251.ts"').size).toBe(1);
    expect(dirtyPathsFrom(' M "src/a b.ts"').has('src/a b.ts')).toBe(true);
  });

  it('ignores blank and truncated lines', () => {
    expect(dirtyPathsFrom('\n M\n').size).toBe(0);
  });
});

describe('createEditBaselines (issue #41)', () => {
  it('uses the committed content for a file that was clean when the Turn started', async () => {
    // The whole reason git is preferred: this still answers correctly after the file on disk has
    // already been rewritten, so there is no snapshot to take and no race to lose.
    const root = repo();
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/a.ts'), 'const a = 1;\n');
    commitAll(root);

    const baselines = createEditBaselines(root);
    baselines.note('src/a.ts');
    writeFileSync(join(root, 'src/a.ts'), 'const a = 2;\n');

    expect(await baselines.get('src/a.ts')).toBe('const a = 1;\n');
  });

  it('does NOT use HEAD for a file that already had uncommitted work in it', async () => {
    // HEAD would fold the user's own in-progress edits into the model's diff, attributing their
    // work to the model. The pre-write read is used instead, which is what the Turn actually found.
    const root = repo();
    writeFileSync(join(root, 'a.ts'), 'committed\n');
    commitAll(root);
    writeFileSync(join(root, 'a.ts'), 'my own work in progress\n');

    const baselines = createEditBaselines(root);
    baselines.note('a.ts');
    writeFileSync(join(root, 'a.ts'), 'what the model wrote\n');

    expect(await baselines.get('a.ts')).toBe('my own work in progress\n');
  });

  it('reports no baseline for a file the Turn created', async () => {
    const root = repo();
    writeFileSync(join(root, 'kept.ts'), 'x\n');
    commitAll(root);

    const baselines = createEditBaselines(root);
    baselines.note('brand-new.ts');
    writeFileSync(join(root, 'brand-new.ts'), 'created by the model\n');

    expect(await baselines.get('brand-new.ts')).toBeNull();
  });

  it('falls back to the pre-write content outside a git repository', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sprint-coder-nogit-'));
    writeFileSync(join(root, 'a.ts'), 'before\n');

    const baselines = createEditBaselines(root);
    baselines.note('a.ts');
    writeFileSync(join(root, 'a.ts'), 'after\n');

    expect(await baselines.get('a.ts')).toBe('before\n');
  });

  it('reports no baseline for a path it was never told about', async () => {
    // A watcher only ever sees a file that has already changed, so there is nothing honest to
    // compare against. Null is the answer, not a guess.
    const baselines = createEditBaselines(mkdtempSync(join(tmpdir(), 'sprint-coder-unknown-')));
    expect(await baselines.get('never-mentioned.ts')).toBeNull();
  });

  it('keeps the first answer when a path is noted repeatedly', async () => {
    // Frames arrive continuously; only the first sighting can still see the "before".
    const root = mkdtempSync(join(tmpdir(), 'sprint-coder-repeat-'));
    writeFileSync(join(root, 'a.ts'), 'first\n');
    const baselines = createEditBaselines(root);
    baselines.note('a.ts');
    writeFileSync(join(root, 'a.ts'), 'second\n');
    baselines.note('a.ts');
    expect(await baselines.get('a.ts')).toBe('first\n');
  });

  it('survives git being unavailable entirely', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sprint-coder-nogitbin-'));
    writeFileSync(join(root, 'a.ts'), 'before\n');
    const baselines = createEditBaselines(root, { git: async () => null });
    baselines.note('a.ts');
    expect(await baselines.get('a.ts')).toBe('before\n');
  });
});
