import { createHash } from 'node:crypto';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROJECT_REFERENCE_MAX_BYTES, readProjectReference } from './project-reference-file';

function workspace(): { root: string; identity: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sprint-coder-reference-')));
  const stat = statSync(root, { bigint: true });
  return {
    root,
    identity: createHash('sha256')
      .update(
        JSON.stringify([
          'workspace-root-v2',
          stat.dev.toString(),
          stat.ino.toString(),
          'directory',
        ]),
      )
      .digest('hex'),
  };
}

describe('readProjectReference', () => {
  it('reads bounded UTF-8 and reports its digest', () => {
    const ws = workspace();
    writeFileSync(join(ws.root, 'notes.txt'), 'hello');
    const read = readProjectReference({
      workspacePath: ws.root,
      registeredRootIdentity: ws.identity,
      relativePath: 'notes.txt',
    });
    expect(read).toMatchObject({ status: 'healthy', content: 'hello' });
    expect(read.digest).toBe(createHash('sha256').update('hello').digest('hex'));
  });

  it('rejects traversal, absolute paths, and symlinks', () => {
    const ws = workspace();
    const outside = workspace();
    writeFileSync(join(outside.root, 'secret'), 'secret');
    symlinkSync(join(outside.root, 'secret'), join(ws.root, 'link'));
    for (const relativePath of ['../secret', join(outside.root, 'secret'), 'link']) {
      expect(
        readProjectReference({
          workspacePath: ws.root,
          registeredRootIdentity: ws.identity,
          relativePath,
        }).status,
      ).toBe('unreadable');
    }
  });

  it('rejects directories, invalid UTF-8, NUL, and oversized files', () => {
    const ws = workspace();
    mkdirSync(join(ws.root, 'dir'));
    writeFileSync(join(ws.root, 'invalid'), Buffer.from([0xc3, 0x28]));
    writeFileSync(join(ws.root, 'nul'), 'a\0b');
    writeFileSync(join(ws.root, 'large'), 'a'.repeat(PROJECT_REFERENCE_MAX_BYTES + 1));
    expect(
      readProjectReference({
        workspacePath: ws.root,
        registeredRootIdentity: ws.identity,
        relativePath: 'dir',
      }).status,
    ).toBe('non_text');
    for (const relativePath of ['invalid', 'nul'])
      expect(
        readProjectReference({
          workspacePath: ws.root,
          registeredRootIdentity: ws.identity,
          relativePath,
        }).status,
      ).toBe('non_text');
    expect(
      readProjectReference({
        workspacePath: ws.root,
        registeredRootIdentity: ws.identity,
        relativePath: 'large',
      }).status,
    ).toBe('too_large');
  });

  it('allows a stable hardlink and the exact byte limit', () => {
    const ws = workspace();
    writeFileSync(join(ws.root, 'source'), 'a'.repeat(PROJECT_REFERENCE_MAX_BYTES));
    linkSync(join(ws.root, 'source'), join(ws.root, 'hardlink'));
    expect(
      readProjectReference({
        workspacePath: ws.root,
        registeredRootIdentity: ws.identity,
        relativePath: 'hardlink',
      }).status,
    ).toBe('healthy');
  });

  it('detects a changed Workspace root and missing files', () => {
    const ws = workspace();
    expect(
      readProjectReference({
        workspacePath: ws.root,
        registeredRootIdentity: '0'.repeat(64),
        relativePath: 'missing',
      }).status,
    ).toBe('workspace_changed');
    expect(
      readProjectReference({
        workspacePath: ws.root,
        registeredRootIdentity: ws.identity,
        relativePath: 'missing',
      }).status,
    ).toBe('missing');
  });
});
