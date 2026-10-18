import { TEAM_DEFAULT_CONCURRENT_EXECUTIONS } from '@sprint-coder/domain';

/** The most assignments one team_assign_tasks call carries (issue #864): a default Team's
 * concurrency, so one call can start every Worker such a Team runs at once. */
export const TEAM_ASSIGN_TASKS_MAX = TEAM_DEFAULT_CONCURRENT_EXECUTIONS;

/** The most bytes of unparsed request the Team MCP bridge holds before it drops the connection. */
export const TEAM_BRIDGE_MAX_REQUEST_BYTES = 1024 * 1024;

/**
 * The most UTF-8 bytes team_assign_tasks's arguments may take as JSON (issue #864). Fifty long
 * objectives in a 3-byte script reach the bridge's 1 MiB, and the bridge then drops the connection
 * before anything is assigned or reported. Half of it leaves room for the request's own envelope
 * (request ID, token, tool name) and for JSON escapes added when the arguments are serialized
 * again on the way, and is still far more than a Leader's batch needs.
 */
export const TEAM_ASSIGN_TASKS_MAX_BYTES = TEAM_BRIDGE_MAX_REQUEST_BYTES / 2;

/** Says how to recover without echoing the request or the limit. */
export const TEAM_ASSIGN_TASKS_TOO_LARGE_MESSAGE =
  'team_assign_tasks request is too large. Split the assignments into several smaller team_assign_tasks calls (fewer assignments per call) and send long instructions in separate calls.';

export const PROJECT_MEMORY_MCP_TOOL_NAMES = ['project_memory_remember'] as const;
export const SKILL_DRAFT_MCP_TOOL_NAMES = ['skill_draft_create'] as const;
export const TEAM_CORE_MCP_TOOL_NAMES = [
  'team_list_models',
  'team_record_model_research',
  'team_hire_worker',
  'team_assign_task',
  'team_assign_tasks',
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
  allowTeamTools?: boolean;
  role?: TeamMcpRole;
  allowedTools?: readonly TeamMcpToolName[];
}>;

/** Mirrors TeamMcpBridge's authorization defaults and preserves the canonical tool ordering. */
export function teamMcpToolNamesForCapabilities(
  capabilities: TeamMcpToolCapabilities,
): readonly TeamMcpToolName[] {
  const roleTools =
    capabilities.role === 'leader' || capabilities.role === 'manager'
      ? TEAM_CORE_MCP_TOOL_NAMES
      : WORKER_TEAM_MCP_TOOL_NAMES;
  const candidates: readonly TeamMcpToolName[] = [
    ...(capabilities.allowProjectMemory === true ? PROJECT_MEMORY_MCP_TOOL_NAMES : []),
    ...(capabilities.allowSkillDrafts === true ? SKILL_DRAFT_MCP_TOOL_NAMES : []),
    ...(capabilities.allowTeamTools === false ? [] : roleTools),
  ];
  if (capabilities.allowedTools === undefined) return candidates;
  const allowed = new Set(capabilities.allowedTools);
  return candidates.filter((name) => allowed.has(name));
}
