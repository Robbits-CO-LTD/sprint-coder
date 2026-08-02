import { describe, expect, it } from 'vitest';
import { linkSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readWorkspaceTextFile } from './workspace-file';

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'sprint-coder-wsfile-'));
}

describe('readWorkspaceTextFile (issue #39)', () => {
  it('reads a text file inside the Workspace', () => {
    const root = workspace();
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/a.ts'), 'const a = 1;\n');
    expect(readWorkspaceTextFile(root, 'src/a.ts')).toBe('const a = 1;\n');
  });

  it('reads an absolute path when it still resolves inside the Workspace', () => {
    const root = workspace();
    const file = join(root, 'absolute.txt');
    writeFileSync(file, 'inside\n');

    expect(readWorkspaceTextFile(root, file)).toBe('inside\n');
  });

  it('rejects an absolute path outside the Workspace', () => {
    const root = workspace();
    const outside = join(workspace(), 'outside.txt');
    writeFileSync(outside, 'outside\n');

    expect(readWorkspaceTextFile(root, outside)).toBeNull();
  });

  it('does not follow a parent junction out of the Workspace', () => {
    // The exact shape issue #11's generated-image collector was fixed for: the *link* is inside the
    // Workspace, so the upstream path check sees nothing wrong, and only refusing to follow it stops
    // the target's contents being rendered in the UI.
    const root = workspace();
    const outside = workspace();
    const secret = join(outside, 'id_rsa');
    writeFileSync(secret, 'PRIVATE KEY\n');
    symlinkSync(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(readWorkspaceTextFile(root, 'escape/id_rsa')).toBeNull();
  });

  it('refuses a multiply-linked file that may alias data outside the Workspace', () => {
    const outside = workspace();
    const secret = join(outside, 'secret.txt');
    writeFileSync(secret, 'SECRET\n');
    const root = workspace();
    linkSync(secret, join(root, 'alias.txt'));
    expect(readWorkspaceTextFile(root, 'alias.txt')).toBeNull();
  });

  it('refuses a path that climbs out of the Workspace', () => {
    const root = workspace();
    writeFileSync(join(root, '..', 'outside.txt'), 'x');
    expect(readWorkspaceTextFile(root, '../outside.txt')).toBeNull();
  });

  it('refuses a directory and a missing file rather than throwing', () => {
    const root = workspace();
    mkdirSync(join(root, 'dir'));
    expect(readWorkspaceTextFile(root, 'dir')).toBeNull();
    expect(readWorkspaceTextFile(root, 'nope.ts')).toBeNull();
  });

  it('refuses binary content instead of pasting it into the DOM', () => {
    const root = workspace();
    writeFileSync(join(root, 'blob.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));
    expect(readWorkspaceTextFile(root, 'blob.bin')).toBeNull();
  });

  it('returns the tail of a large file, not the head', () => {
    // Where the writing stopped is the interesting part; the first 256KB of a generated file is not.
    const root = workspace();
    const body = `${'a'.repeat(300_000)}TAIL`;
    writeFileSync(join(root, 'big.txt'), body);
    const read = readWorkspaceTextFile(root, 'big.txt');
    expect(read).not.toBeNull();
    expect(read?.endsWith('TAIL')).toBe(true);
    expect((read ?? '').length).toBeLessThanOrEqual(262_144);
  });

  it('returns an empty string for an empty file rather than null', () => {
    // Null means "cannot show this"; an empty file is showable and genuinely empty.
    const root = workspace();
    writeFileSync(join(root, 'empty.ts'), '');
    expect(readWorkspaceTextFile(root, 'empty.ts')).toBe('');
  });
});
