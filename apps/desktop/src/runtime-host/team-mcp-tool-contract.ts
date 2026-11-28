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

export const BLENDER_TEAM_MCP_TOOLS = [
  {
    name: 'blender_observe',
    description:
      'Get a PNG of your assigned Blender mesh from your own view. Returns a one-use observation token. Inspect the image before deciding on an edit. Returns up to 64 face centers and normals in mesh-local coordinates. Set target to claim a named mesh from the selected Blender meshes on your first observation. Your target stays assigned to you. An optional face index selects the face for an extrusion.',
    inputSchema: {
      type: 'object',
      properties: {
        azimuth: { type: 'number', minimum: -360, maximum: 360 },
        elevation: { type: 'number', minimum: -89, maximum: 89 },
        faceIndex: { type: 'integer', minimum: 0 },
        target: { type: 'string', minLength: 1, maxLength: 1024 },
      },
      required: ['azimuth', 'elevation'],
      additionalProperties: false,
    },
  },
  {
    name: 'blender_edit',
    description:
      'Edit your assigned Blender mesh using the token from your last observation. Move takes an XYZ offset. Extrude takes a nonzero distance along the observed face normal. Observe again after the edit to verify it.',
    inputSchema: {
      type: 'object',
      properties: {
        observation: { type: 'string' },
        operation: { enum: ['move', 'extrude'] },
        value: {
          anyOf: [
            { type: 'number' },
            {
              type: 'array',
              items: { type: 'number' },
              minItems: 3,
              maxItems: 3,
            },
          ],
        },
      },
      required: ['observation', 'operation', 'value'],
      additionalProperties: false,
    },
  },
] as const;

export type BlenderTeamToolName = (typeof BLENDER_TEAM_MCP_TOOLS)[number]['name'];

export function isBlenderTeamTool(name: string): name is BlenderTeamToolName {
  return BLENDER_TEAM_MCP_TOOLS.some((tool) => tool.name === name);
}

export const TEAM_MCP_TOOL_NAMES = [
  ...BLENDER_TEAM_MCP_TOOLS.map(({ name }) => name),
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
  blenderEnabled?: boolean;
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
    ...(capabilities.role === 'worker' &&
    capabilities.allowTeamTools !== false &&
    capabilities.blenderEnabled === true
      ? BLENDER_TEAM_MCP_TOOLS.map(({ name }) => name)
      : []),
  ];
  if (capabilities.allowedTools === undefined) return candidates;
  const allowed = new Set(capabilities.allowedTools);
  return candidates.filter((name) => allowed.has(name));
}
