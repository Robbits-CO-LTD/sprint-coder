import { describe, expect, it } from 'vitest';
import { posix, win32 } from 'node:path';
import { relativizeWorkspacePath, resolveWriteScope } from './write-scope';

const rel = (workspace: string, candidate: string): string | null =>
  relativizeWorkspacePath(workspace, candidate, posix.resolve, posix.relative);

describe('resolveWriteScope (issue #37)', () => {
  it('maps each preset to a scope only when a Workspace exists', () => {
    expect(resolveWriteScope('ask', '/tmp/ws')).toBe('read-only');
    expect(resolveWriteScope('auto', '/tmp/ws')).toBe('workspace-write');
    expect(resolveWriteScope('full', '/tmp/ws')).toBe('full');
  });

  it('refuses every write scope with no Workspace, including full', () => {
    // Not a nicety: with no Workspace the adapters run in a temp directory that is deleted when the
    // Turn ends, so a write there produces an edit the user can never see while the model reports
    // success. 'full' is the case worth pinning — it is the preset a user reaches for when they want
    // fewer restrictions, and it must still not write into a directory that is about to vanish.
    for (const preset of ['ask', 'auto', 'full'] as const)
      expect(resolveWriteScope(preset, null)).toBe('read-only');
  });
});

describe('relativizeWorkspacePath (issue #37)', () => {
  it('returns a relative path for a file inside the Workspace', () => {
    expect(rel('/tmp/ws', '/tmp/ws/src/app.ts')).toBe('src/app.ts');
  });

  it('normalizes Windows separators for the cross-platform timeline contract', () => {
    expect(
      relativizeWorkspacePath(
        'C:\\workspace',
        'C:\\workspace\\src\\app.ts',
        win32.resolve,
        win32.relative,
        win32.sep,
      ),
    ).toBe('src/app.ts');
  });

  it('preserves a backslash that is part of a valid POSIX file name', () => {
    expect(rel('/tmp/ws', '/tmp/ws/foo\\bar.txt')).toBe('foo\\bar.txt');
  });

  it('rejects a path outside the Workspace, however it is spelled', () => {
    // Each of these is a real shape a Runtime could report: a sibling directory, a traversal, an
    // absolute path elsewhere, and the classic target of a prompt injection. None may reach the
    // timeline, because the user reads it as a record of what the app allowed.
    expect(rel('/tmp/ws', '/tmp/ws-other/app.ts')).toBeNull();
    expect(rel('/tmp/ws', '/tmp/ws/../escape.ts')).toBeNull();
    expect(rel('/tmp/ws', '/etc/passwd')).toBeNull();
    expect(rel('/tmp/ws', `${process.env['HOME'] ?? '/root'}/.ssh/id_rsa`)).toBeNull();
  });

  it('rejects the Workspace root itself', () => {
    // A "change" to the root is not a file edit; rendering it as one would be a claim with no
    // referent.
    expect(rel('/tmp/ws', '/tmp/ws')).toBeNull();
  });

  it('rejects an empty or absurdly long path instead of truncating it', () => {
    expect(rel('/tmp/ws', '')).toBeNull();
    expect(rel('/tmp/ws', `/tmp/ws/${'a'.repeat(5000)}.ts`)).toBeNull();
  });

  it('normalises a traversal that stays inside rather than rejecting it', () => {
    // `src/../src/app.ts` is inside and resolves cleanly; rejecting it would drop a real edit.
    expect(rel('/tmp/ws', '/tmp/ws/src/../src/app.ts')).toBe('src/app.ts');
  });
});
