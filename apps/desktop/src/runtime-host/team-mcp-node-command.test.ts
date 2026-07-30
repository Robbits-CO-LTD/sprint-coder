import { describe, expect, it } from 'vitest';
import { teamMcpNodeCommand } from './team-mcp-node-command';

describe('Team MCP Node command', () => {
  it('uses PATH Node instead of the fuse-disabled Electron executable', () => {
    expect(teamMcpNodeCommand('darwin')).toBe('node');
    expect(teamMcpNodeCommand('linux')).toBe('node');
    expect(teamMcpNodeCommand('win32')).toBe('node.exe');
  });
});
