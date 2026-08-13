import { describe, expect, it } from 'vitest';
import {
  PROJECT_MEMORY_MCP_TOOL_NAMES,
  SKILL_DRAFT_MCP_TOOL_NAMES,
  SKILL_IMPORT_MCP_TOOL_NAMES,
  TEAM_CORE_MCP_TOOL_NAMES,
  WORKER_TEAM_MCP_TOOL_NAMES,
  teamMcpToolNamesForCapabilities,
} from './team-mcp-tool-contract';

describe('Team MCP tool contract', () => {
  it.each([
    ['team', { role: 'leader' as const, allowTeamTools: true }, TEAM_CORE_MCP_TOOL_NAMES],
    ['memory', { allowTeamTools: false, allowProjectMemory: true }, PROJECT_MEMORY_MCP_TOOL_NAMES],
    [
      'skill creator',
      { allowTeamTools: false, allowSkillDrafts: true },
      SKILL_DRAFT_MCP_TOOL_NAMES,
    ],
    [
      'skill import',
      { allowTeamTools: false, allowSkillImports: true },
      SKILL_IMPORT_MCP_TOOL_NAMES,
    ],
  ])('derives the exact %s Turn subset', (_kind, capabilities, expected) => {
    expect(teamMcpToolNamesForCapabilities(capabilities)).toEqual(expected);
  });

  it('fails closed to leaf Worker tools when role is omitted', () => {
    expect(teamMcpToolNamesForCapabilities({})).toEqual(WORKER_TEAM_MCP_TOOL_NAMES);
    expect(
      teamMcpToolNamesForCapabilities({ allowedTools: ['team_hire_worker', 'team_get_status'] }),
    ).toEqual(['team_get_status']);
  });

  it('publishes hire only to Leader and Manager roles', () => {
    expect(teamMcpToolNamesForCapabilities({ role: 'leader' })).toEqual(TEAM_CORE_MCP_TOOL_NAMES);
    expect(teamMcpToolNamesForCapabilities({ role: 'manager' })).toEqual(TEAM_CORE_MCP_TOOL_NAMES);
    expect(teamMcpToolNamesForCapabilities({ role: 'worker' })).toEqual(WORKER_TEAM_MCP_TOOL_NAMES);
    expect(WORKER_TEAM_MCP_TOOL_NAMES).not.toContain('team_hire_worker');
  });

  it('intersects role capabilities with the registered allowlist', () => {
    expect(
      teamMcpToolNamesForCapabilities({
        role: 'manager',
        allowedTools: ['team_get_status', 'team_send_message'],
      }),
    ).toEqual(['team_get_status', 'team_send_message']);
    expect(
      teamMcpToolNamesForCapabilities({
        role: 'worker',
        allowedTools: ['team_hire_worker', 'team_get_status'],
      }),
    ).toEqual(['team_get_status']);
  });
});
