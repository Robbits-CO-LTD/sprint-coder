export const PROJECT_MEMORY_MCP_TOOL_NAMES = ['project_memory_remember'] as const;
export const SKILL_DRAFT_MCP_TOOL_NAMES = ['skill_draft_create'] as const;
export const SKILL_IMPORT_MCP_TOOL_NAMES = ['skill_import_read', 'skill_import_install'] as const;
export const TEAM_CORE_MCP_TOOL_NAMES = [
  'team_list_models',
  'team_record_model_research',
  'team_hire_worker',
  'team_assign_task',
  'team_assign_mission',
  'team_resume_mission',
  'team_steer_execution',
  'team_cancel_execution',
  'team_get_status',
  'team_wait_events',
  'team_send_to_worker',
  'team_send_message',
  'team_read_messages',
  'team_wait_reports',
  'team_stop_worker',
] as const;

export const TEAM_MCP_TOOL_NAMES = [
  ...PROJECT_MEMORY_MCP_TOOL_NAMES,
  ...SKILL_DRAFT_MCP_TOOL_NAMES,
  ...SKILL_IMPORT_MCP_TOOL_NAMES,
  ...TEAM_CORE_MCP_TOOL_NAMES,
] as const;

export type TeamMcpToolName = (typeof TEAM_MCP_TOOL_NAMES)[number];
export type TeamMcpRole = 'leader' | 'manager' | 'worker';

export const WORKER_TEAM_MCP_TOOL_NAMES = TEAM_CORE_MCP_TOOL_NAMES.filter(
  (name) => name !== 'team_hire_worker',
);

export type TeamMcpToolCapabilities = Readonly<{
  allowProjectMemory?: boolean;
  allowSkillDrafts?: boolean;
  allowSkillImports?: boolean;
  allowTeamTools?: boolean;
  role?: TeamMcpRole;
  allowedTools?: readonly TeamMcpToolName[];
}>;

/** Mirrors TeamMcpBridge's authorization defaults and preserves the canonical tool ordering. */
export function teamMcpToolNamesForCapabilities(
  capabilities: TeamMcpToolCapabilities,
): readonly TeamMcpToolName[] {
  const roleTools =
    capabilities.role === 'worker' ? WORKER_TEAM_MCP_TOOL_NAMES : TEAM_CORE_MCP_TOOL_NAMES;
  const candidates: readonly TeamMcpToolName[] = [
    ...(capabilities.allowProjectMemory === true ? PROJECT_MEMORY_MCP_TOOL_NAMES : []),
    ...(capabilities.allowSkillDrafts === true ? SKILL_DRAFT_MCP_TOOL_NAMES : []),
    ...(capabilities.allowSkillImports === true ? SKILL_IMPORT_MCP_TOOL_NAMES : []),
    ...(capabilities.allowTeamTools === false ? [] : roleTools),
  ];
  if (capabilities.allowedTools === undefined) return candidates;
  const allowed = new Set(capabilities.allowedTools);
  return candidates.filter((name) => allowed.has(name));
}
