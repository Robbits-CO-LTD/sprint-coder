import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_EDITABLE_BYTES, openWorkspaceFileForEdit, saveWorkspaceFile } from './workspace-edit';

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'sprint-coder-edit-'));
}

const digestOf = (text: string): string =>
  createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

describe('openWorkspaceFileForEdit (issue #43)', () => {
  it('returns the whole file and a digest of exactly those bytes', () => {
    const root = workspace();
    writeFileSync(join(root, 'a.ts'), 'const a = 1;\n');
    const opened = openWorkspaceFileForEdit(root, 'a.ts');
    expect(opened.editable).toBe(true);
    expect(opened.text).toBe('const a = 1;\n');
    expect(opened.digest).toBe(digestOf('const a = 1;\n'));
  });

  it('refuses a file too large to edit rather than returning part of it', () => {
    // This is the data-loss case the cap exists for: workspace-file.ts returns the last 262KB of a
    // file for the live view, and saving that tail back would overwrite the file with its own end.
    // Editing must never be offered for a file it cannot hold in full.
    const root = workspace();
    writeFileSync(join(root, 'big.txt'), 'a'.repeat(MAX_EDITABLE_BYTES + 1));
    const opened = openWorkspaceFileForEdit(root, 'big.txt');
    expect(opened.editable).toBe(false);
    expect(opened.reason).toBe('too_large');
    expect(opened.text).toBe('');
  });

  it('refuses binary content, which would not survive a UTF-8 round trip', () => {
    const root = workspace();
    writeFileSync(join(root, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02]));
    expect(openWorkspaceFileForEdit(root, 'blob.bin').reason).toBe('binary');
  });

  it('refuses a symlink, a directory, and a missing file', () => {
    const root = workspace();
    const outside = join(workspace(), 'id_rsa');
    writeFileSync(outside, 'PRIVATE KEY\n');
    symlinkSync(outside, join(root, 'link.ts'));
    mkdirSync(join(root, 'dir'));
    expect(openWorkspaceFileForEdit(root, 'link.ts').reason).toBe('not_a_file');
    expect(openWorkspaceFileForEdit(root, 'dir').reason).toBe('not_a_file');
    expect(openWorkspaceFileForEdit(root, 'missing.ts').reason).toBe('not_a_file');
  });

  it('refuses a path outside the Workspace', () => {
    const root = workspace();
    expect(openWorkspaceFileForEdit(root, '../escape.ts').reason).toBe('outside_workspace');
    expect(openWorkspaceFileForEdit(root, '/etc/passwd').reason).toBe('outside_workspace');
  });
});

describe('saveWorkspaceFile (issue #43)', () => {
  it('writes when the file still matches the digest the editor started from', () => {
    const root = workspace();
    writeFileSync(join(root, 'a.ts'), 'before\n');
    const result = saveWorkspaceFile(root, 'a.ts', 'after\n', digestOf('before\n'));
    expect(result.outcome).toBe('saved');
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('after\n');
    expect(result.digest).toBe(digestOf('after\n'));
  });

  it('does not touch the file when it changed underneath', () => {
    // The assertion that matters is the file's contents, not the return value: a "conflict" that
    // still wrote would be the exact bug this guard exists to prevent.
    const root = workspace();
    writeFileSync(join(root, 'a.ts'), 'the model rewrote this\n');
    const result = saveWorkspaceFile(root, 'a.ts', 'my edit\n', digestOf('what I opened\n'));
    expect(result.outcome).toBe('conflict');
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('the model rewrote this\n');
  });

  it('refuses to write outside the Workspace, and leaves the target untouched', () => {
    const outsideRoot = workspace();
    const outside = join(outsideRoot, 'secret.txt');
    writeFileSync(outside, 'original\n');
    const root = workspace();
    const result = saveWorkspaceFile(
      root,
      `../${join(outsideRoot, 'secret.txt').split('/').pop() ?? ''}`,
      'pwned\n',
      digestOf('original\n'),
    );
    expect(result.outcome).toBe('refused');
    expect(readFileSync(outside, 'utf8')).toBe('original\n');
  });

  it('refuses to write through a symlink, and leaves the link target untouched', () => {
    // The link is inside the Workspace, so a path check alone would let this through — which is why
    // the write path lstats rather than stats.
    const root = workspace();
    const target = join(workspace(), 'id_rsa');
    writeFileSync(target, 'PRIVATE KEY\n');
    symlinkSync(target, join(root, 'notes.md'));
    const result = saveWorkspaceFile(root, 'notes.md', 'pwned\n', digestOf('PRIVATE KEY\n'));
    expect(result.outcome).toBe('refused');
    expect(result.reason).toBe('not_a_file');
    expect(readFileSync(target, 'utf8')).toBe('PRIVATE KEY\n');
  });

  it('refuses to write more than the cap', () => {
    const root = workspace();
    writeFileSync(join(root, 'a.ts'), 'small\n');
    const result = saveWorkspaceFile(
      root,
      'a.ts',
      'a'.repeat(MAX_EDITABLE_BYTES + 1),
      digestOf('small\n'),
    );
    expect(result.outcome).toBe('refused');
    expect(result.reason).toBe('too_large');
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('small\n');
  });

  it('refuses a file that does not exist rather than creating one', () => {
    // Every path into this function comes from a file the Runtime reported writing. A save that
    // creates a new file would mean the editor invented a path, which is a bug worth surfacing.
    const root = workspace();
    expect(saveWorkspaceFile(root, 'nope.ts', 'x', digestOf('')).outcome).toBe('refused');
    expect(readdirSync(root)).toEqual([]);
  });

  it('leaves no temporary file behind after a successful save', () => {
    const root = workspace();
    writeFileSync(join(root, 'a.ts'), 'before\n');
    saveWorkspaceFile(root, 'a.ts', 'after\n', digestOf('before\n'));
    expect(readdirSync(root)).toEqual(['a.ts']);
  });

  it('round-trips content the editor is likely to produce', () => {
    // CRLF, tabs, non-ASCII and a trailing newline all have to survive byte-for-byte; a save that
    // normalises them would rewrite lines the user never touched.
    const root = workspace();
    const body = 'a\r\n\tb\n日本語 🎉\n';
    writeFileSync(join(root, 'a.ts'), 'x\n');
    saveWorkspaceFile(root, 'a.ts', body, digestOf('x\n'));
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe(body);
    expect(openWorkspaceFileForEdit(root, 'a.ts').text).toBe(body);
  });
});
