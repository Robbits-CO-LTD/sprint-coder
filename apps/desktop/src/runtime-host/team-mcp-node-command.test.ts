import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { teamMcpNodeCommand } from './team-mcp-node-command';

describe('Team MCP Node command', () => {
  it('uses PATH Node instead of the fuse-disabled Electron executable on POSIX', () => {
    expect(teamMcpNodeCommand('darwin')).toBe('node');
    expect(teamMcpNodeCommand('linux')).toBe('node');
  });

  it.skipIf(process.platform !== 'win32')('prefers the packaged Node executable on Windows', () => {
    const resources = mkdtempSync(join(tmpdir(), 'sprint-coder-node-resources-'));
    const bundled = join(resources, 'node.exe');
    writeFileSync(bundled, 'fixture');
    expect(teamMcpNodeCommand('win32', { Path: '' }, resources)).toBe(bundled);
  });

  it.skipIf(process.platform !== 'win32')('resolves PATH Node to a trusted absolute path', () => {
    const nodeDirectory = mkdtempSync(join(tmpdir(), 'sprint-coder-path-node-'));
    const executable = join(nodeDirectory, 'node.exe');
    writeFileSync(executable, 'fixture');
    expect(teamMcpNodeCommand('win32', { Path: nodeDirectory }, undefined)).toBe(executable);
  });

  it.skipIf(process.platform !== 'win32')(
    'never falls back to a Workspace-relative node.exe',
    () => {
      expect(() => teamMcpNodeCommand('win32', { Path: '.;relative\\bin' }, undefined)).toThrow(
        /trusted Node\.js executable/,
      );
    },
  );
});
