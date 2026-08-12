import { describe, expect, it } from 'vitest';
import {
  PROJECT_MEMORY_MCP_TOOL_NAMES,
  SKILL_DRAFT_MCP_TOOL_NAMES,
  SKILL_IMPORT_MCP_TOOL_NAMES,
  TEAM_CORE_MCP_TOOL_NAMES,
  teamMcpToolNamesForCapabilities,
} from './team-mcp-tool-contract';

describe('Team MCP tool contract', () => {
  it.each([
    ['team', { allowTeamTools: true }, TEAM_CORE_MCP_TOOL_NAMES],
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

  it('preserves the bridge default that omitted allowTeamTools means enabled', () => {
    expect(teamMcpToolNamesForCapabilities({})).toEqual(TEAM_CORE_MCP_TOOL_NAMES);
  });
});
