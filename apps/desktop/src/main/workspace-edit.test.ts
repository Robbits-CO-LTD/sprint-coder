import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type * as NodeChildProcess from 'node:child_process';
import type * as NodeFs from 'node:fs';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_EDITABLE_BYTES,
  openWorkspaceFileForEdit,
  recoverWorkspaceFileForEdit,
  saveWorkspaceFile,
} from './workspace-edit';
import { secureWindowsPath, verifyWindowsPathAcl } from './windows-acl';

const fileSystemFault = vi.hoisted(() => ({
  failWrite: false,
  failRename: false,
  failAtomicReplace: false,
  failDirectorySync: false,
  failCopyAfterCreate: false,
  concurrentWindowsContent: null as string | null,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeChildProcess>();
  return {
    ...actual,
    execFileSync: (...args: Parameters<typeof actual.execFileSync>) => {
      if (fileSystemFault.failAtomicReplace)
        throw new Error('simulated atomic replacement failure');
      if (fileSystemFault.concurrentWindowsContent !== null) {
        const options = args[2] as { env?: NodeJS.ProcessEnv } | undefined;
        const target = options?.env?.['SPRINT_CODER_TARGET'];
        if (target !== undefined) writeFileSync(target, fileSystemFault.concurrentWindowsContent);
      }
      return actual.execFileSync(...args);
    },
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return {
    ...actual,
    copyFileSync: (...args: Parameters<typeof actual.copyFileSync>) => {
      if (fileSystemFault.failCopyAfterCreate) {
        actual.writeFileSync(args[1], 'partial copy');
        throw new Error('simulated copy failure after destination creation');
      }
      return actual.copyFileSync(...args);
    },
    writeSync: (...args: Parameters<typeof actual.writeSync>) => {
      if (fileSystemFault.failWrite) throw new Error('simulated disk write failure');
      return actual.writeSync(...args);
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (fileSystemFault.failRename) throw new Error('simulated atomic rename failure');
      return actual.renameSync(...args);
    },
    fsyncSync: (...args: Parameters<typeof actual.fsyncSync>) => {
      if (fileSystemFault.failDirectorySync && actual.fstatSync(args[0]).isDirectory())
        throw new Error('simulated directory sync failure');
      return actual.fsyncSync(...args);
    },
  };
});

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

  it('refuses malformed UTF-8 instead of replacing bytes and corrupting them on save', () => {
    const root = workspace();
    const bytes = Buffer.from([0x82, 0xa0, 0x82, 0xa2]);
    writeFileSync(join(root, 'shift-jis.txt'), bytes);
    expect(openWorkspaceFileForEdit(root, 'shift-jis.txt').reason).toBe('binary');
    expect(readFileSync(join(root, 'shift-jis.txt'))).toEqual(bytes);
  });

  it('preserves a UTF-8 BOM when the opened text is saved', () => {
    const root = workspace();
    const file = join(root, 'bom.txt');
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('日本語\r\n')]);
    writeFileSync(file, bytes);
    const opened = openWorkspaceFileForEdit(root, 'bom.txt');
    expect(opened.editable).toBe(true);
    expect(opened.text).toBe('\ufeff日本語\r\n');
    const result = saveWorkspaceFile(root, 'bom.txt', opened.text, opened.digest);
    expect(result.outcome).toBe('saved');
    expect(readFileSync(file)).toEqual(bytes);
  });

  it('never trusts, deletes, or applies workspace files that resemble old recovery metadata', () => {
    const root = workspace();
    const file = join(root, 'important.txt');
    const live = Buffer.from('live user content\n');
    const attackerRecovery = Buffer.from('attacker-chosen replacement\n');
    writeFileSync(file, live);
    writeFileSync(`${file}.sprint-coder-recovery.tmp`, attackerRecovery);
    writeFileSync(`${file}.sprint-coder-stage.tmp`, 'unrelated stage');
    writeFileSync(
      `${file}.sprint-coder-save.json`,
      JSON.stringify({
        version: 1,
        originalDigest: createHash('sha256').update(attackerRecovery).digest('hex'),
        newDigest: createHash('sha256').update('anything').digest('hex'),
      }),
    );
    expect(openWorkspaceFileForEdit(root, 'important.txt')).toMatchObject({
      editable: true,
      text: 'live user content\n',
    });
    expect(recoverWorkspaceFileForEdit(root, 'important.txt')).toMatchObject({
      editable: true,
      text: 'live user content\n',
    });
    expect(readFileSync(file)).toEqual(live);
    expect(readFileSync(`${file}.sprint-coder-recovery.tmp`)).toEqual(attackerRecovery);
    expect(readdirSync(root)).toHaveLength(4);
  });

  it('refuses a parent junction that escapes the Workspace, a directory, and a missing file', () => {
    const root = workspace();
    const outside = workspace();
    writeFileSync(join(outside, 'id_rsa'), 'PRIVATE KEY\n');
    symlinkSync(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    mkdirSync(join(root, 'dir'));
    expect(openWorkspaceFileForEdit(root, 'escape/id_rsa').reason).toBe('outside_workspace');
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

  it('keeps the original byte-for-byte when staging the replacement fails', () => {
    const root = workspace();
    const file = join(root, 'important.txt');
    const original = Buffer.from('original 日本語\r\n', 'utf8');
    writeFileSync(file, original);
    fileSystemFault.failWrite = true;
    try {
      const result = saveWorkspaceFile(
        root,
        'important.txt',
        'replacement\r\n',
        createHash('sha256').update(original).digest('hex'),
      );
      expect(result).toMatchObject({ outcome: 'refused', reason: 'io_error' });
    } finally {
      fileSystemFault.failWrite = false;
    }
    expect(readFileSync(file)).toEqual(original);
    expect(readdirSync(root)).toEqual(['important.txt']);
  });

  it.runIf(process.platform === 'win32')(
    'removes a partial staging file when copying fails after creating it',
    () => {
      const root = workspace();
      const file = join(root, 'important.txt');
      const original = Buffer.from('original 日本語\r\n', 'utf8');
      writeFileSync(file, original);
      fileSystemFault.failCopyAfterCreate = true;
      try {
        const result = saveWorkspaceFile(
          root,
          'important.txt',
          'replacement\r\n',
          createHash('sha256').update(original).digest('hex'),
        );
        expect(result).toMatchObject({ outcome: 'refused', reason: 'io_error' });
      } finally {
        fileSystemFault.failCopyAfterCreate = false;
      }
      expect(readFileSync(file)).toEqual(original);
      expect(readdirSync(root)).toEqual(['important.txt']);
    },
  );

  it('keeps the original bytes when publishing the staged edit fails', () => {
    const root = workspace();
    const file = join(root, 'important.txt');
    const original = Buffer.from('original 日本語\r\n', 'utf8');
    writeFileSync(file, original);
    if (process.platform === 'win32') fileSystemFault.failAtomicReplace = true;
    else fileSystemFault.failRename = true;
    try {
      const result = saveWorkspaceFile(
        root,
        'important.txt',
        'replacement\r\n',
        createHash('sha256').update(original).digest('hex'),
      );
      expect(result).toMatchObject({ outcome: 'refused', reason: 'io_error' });
    } finally {
      fileSystemFault.failRename = false;
      fileSystemFault.failAtomicReplace = false;
    }
    expect(readFileSync(file)).toEqual(original);
    expect(readdirSync(root)).toEqual(['important.txt']);
  });

  it.runIf(process.platform === 'win32')(
    'restores a concurrent Windows edit observed at the File.Replace boundary',
    () => {
      const root = workspace();
      const file = join(root, 'important.txt');
      writeFileSync(file, 'before\n');
      fileSystemFault.concurrentWindowsContent = 'concurrent writer\n';
      try {
        const result = saveWorkspaceFile(root, 'important.txt', 'my edit\n', digestOf('before\n'));
        expect(result).toMatchObject({ outcome: 'conflict', digest: null });
      } finally {
        fileSystemFault.concurrentWindowsContent = null;
      }
      expect(readFileSync(file, 'utf8')).toBe('concurrent writer\n');
      expect(readdirSync(root)).toEqual(['important.txt']);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'reports the committed save when the filesystem rejects parent directory sync',
    () => {
      const root = workspace();
      const file = join(root, 'important.txt');
      writeFileSync(file, 'before\n');
      fileSystemFault.failDirectorySync = true;
      try {
        const result = saveWorkspaceFile(root, 'important.txt', 'after\n', digestOf('before\n'));
        expect(result).toMatchObject({ outcome: 'saved', digest: digestOf('after\n') });
      } finally {
        fileSystemFault.failDirectorySync = false;
      }
      expect(readFileSync(file, 'utf8')).toBe('after\n');
      expect(readdirSync(root)).toEqual(['important.txt']);
    },
  );

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

  it('refuses to write through an escaping parent junction, and leaves the target untouched', () => {
    // The link is inside the Workspace, so a path check alone would let this through — which is why
    // the write path lstats rather than stats.
    const root = workspace();
    const outside = workspace();
    const target = join(outside, 'id_rsa');
    writeFileSync(target, 'PRIVATE KEY\n');
    symlinkSync(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = saveWorkspaceFile(root, 'escape/id_rsa', 'pwned\n', digestOf('PRIVATE KEY\n'));
    expect(result.outcome).toBe('refused');
    expect(result.reason).toBe('outside_workspace');
    expect(readFileSync(target, 'utf8')).toBe('PRIVATE KEY\n');
  });

  it('refuses a multiply-linked file that could alias a target outside the Workspace', () => {
    const outside = workspace();
    const outsideFile = join(outside, 'secret.txt');
    writeFileSync(outsideFile, 'secret\n');
    const root = workspace();
    linkSync(outsideFile, join(root, 'alias.txt'));
    const result = saveWorkspaceFile(root, 'alias.txt', 'changed\n', digestOf('secret\n'));
    expect(result.outcome).toBe('refused');
    expect(readFileSync(outsideFile, 'utf8')).toBe('secret\n');
  });

  it.skipIf(process.platform === 'win32')(
    'preserves POSIX special permission bits and ordinary mode on save',
    () => {
      const root = workspace();
      const file = join(root, 'script.sh');
      writeFileSync(file, '#!/bin/sh\n');
      chmodSync(file, 0o2755);
      const oldTimestamp = new Date('2000-01-01T00:00:00.000Z');
      utimesSync(file, oldTimestamp, oldTimestamp);
      const result = saveWorkspaceFile(
        root,
        'script.sh',
        '#!/bin/sh\necho ok\n',
        digestOf('#!/bin/sh\n'),
      );
      expect(result.outcome).toBe('saved');
      expect(statSync(file).mode & 0o7777).toBe(0o2755);
      expect(statSync(file).mtimeMs).toBeGreaterThan(oldTimestamp.getTime());
    },
  );

  it.skipIf(process.platform === 'win32')(
    'atomically saves a readable file while preserving its read-only mode',
    () => {
      const root = workspace();
      const file = join(root, 'generated.txt');
      writeFileSync(file, 'before\n');
      chmodSync(file, 0o444);

      const result = saveWorkspaceFile(root, 'generated.txt', 'after\n', digestOf('before\n'));

      expect(result.outcome).toBe('saved');
      expect(readFileSync(file, 'utf8')).toBe('after\n');
      expect(statSync(file).mode & 0o222).toBe(0);
    },
  );

  it('publishes a replacement inode instead of truncating the live file in place', () => {
    const root = workspace();
    const file = join(root, 'protected.txt');
    writeFileSync(file, 'before\n');
    const before = statSync(file, { bigint: true });

    const result = saveWorkspaceFile(root, 'protected.txt', 'after\n', digestOf('before\n'));
    const after = statSync(file, { bigint: true });

    expect(result.outcome).toBe('saved');
    expect({ dev: after.dev, ino: after.ino }).not.toEqual({ dev: before.dev, ino: before.ino });
  });

  it.runIf(process.platform === 'win32')(
    'preserves a private Windows ACL across atomic publication',
    async () => {
      const root = workspace();
      const file = join(root, 'private.txt');
      writeFileSync(file, 'before\n');
      await secureWindowsPath(file, 'file');

      const result = saveWorkspaceFile(root, 'private.txt', 'after\n', digestOf('before\n'));

      expect(result.outcome).toBe('saved');
      await verifyWindowsPathAcl(file, 'file');
    },
  );

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
