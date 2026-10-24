// Leader team tools (FR-TEAM-06/13, IMPLEMENTATION_PLAN Slice 5.2): the Leader hires and
// dispatches Workers via tool use during its own Turn instead of the user driving teams.* IPC
// directly. Every tool forwards to TeamCoordinator, which remains the sole issuer of
// source/target envelopes and the sole enforcer of hierarchy policy, budget reservations, and the
// Team/Worker state machines — this file never mutates Team state on its own.
//
// The same provider-neutral definitions feed the mock ToolBroker, the real CLI MCP bridge, and
// official API tool loops. TeamCoordinator remains the only authority-bearing implementation.
import { z } from 'zod';
import {
  contextInheritancePolicySchema,
  modelSelectionSchema,
  type ModelSelection,
  type ProviderTool,
} from '@sprint-coder/contracts';
import {
  createToolDefinition,
  createToolId,
  TeamDelegationError,
  type ToolExecutionContext,
  type JsonValue,
  type ToolDefinition,
} from '@sprint-coder/domain';
import type { ToolBroker } from './tool-broker';
import type { TeamBatchAssignmentOutcome, TeamCoordinator } from './team-coordinator';
import { digestCanonical } from './context-compiler';
import type { ToolTranscriptItem } from './context-compiler';
import type { ModelSampler, ModelToolCall } from './intelligence-loop';
import { BUILTIN_TEAM_SKILL_CONTENT } from './team-skill';
import { maskTeamHiringMarkdown } from './team-hiring-markdown';
import { leaderWriteLimitNote } from './workspace-write-limits';
import { writeScopeNote } from './write-scope';
import {
  TEAM_ASSIGN_TASKS_MAX,
  TEAM_ASSIGN_TASKS_MAX_BYTES,
  TEAM_ASSIGN_TASKS_TOO_LARGE_MESSAGE,
} from '../runtime-host/team-mcp-tool-contract';

const teamToolDefinition = (
  providerName: string,
  name: string,
  properties: Record<string, JsonValue>,
  required: readonly string[],
  schemaExtensions: Readonly<Record<string, JsonValue>> = {},
): ToolDefinition =>
  createToolDefinition({
    toolId: createToolId({ provider: 'builtin', namespace: 'team', name, version: '1' }),
    providerName,
    // kind:'search' + sideEffect:'none' is a deliberate choice, not a mislabel: these tools DO
    // have effects (spawn Workers, reserve budget), but their authority boundary is
    // TeamCoordinator's own budget/cap/state machine, not the interactive Capability/Approval
    // system. Modeling them as capability-gated ('agentControl') would force a human Approval
    // Card on every autonomous Leader hire/dispatch, which contradicts FR-TEAM-06/13.
    kind: 'search',
    schemaVersion: 1,
    inputSchema: {
      type: 'object',
      properties,
      required: [...required],
      additionalProperties: false,
      ...schemaExtensions,
    },
    outputSchema: { type: 'object' },
    sideEffect: 'none',
    risk: 'low',
    requiredCapabilities: [],
    executionTarget: 'main',
    implementationKind: 'built-in',
    priority: 10,
    workspaceBinding: { kind: 'none' },
    providerCompatibility: ['*'],
  });

const MANAGER_WRITE_REQUIREMENTS =
  '子に編集を委譲するManagerは、雇用時writeCapable: trueとManager自身への割当access: workspace-writeの両方が必要です。調査だけのManagerはread-onlyを使います。';

export const TEAM_HIRE_WORKER_TOOL = teamToolDefinition(
  'team_hire_worker',
  'hire-worker',
  {
    agentKind: { type: 'string', enum: ['worker', 'manager'] },
    role: { type: 'string' },
    objective: { type: 'string' },
    contextInheritancePolicy: { type: 'string' },
    writeCapable: { type: 'boolean' },
    modelSelection: {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        requestedProvider: { type: 'string' },
        requestedModel: { type: 'string' },
      },
      required: ['connectionId', 'requestedProvider', 'requestedModel'],
      additionalProperties: false,
    },
    modelSelectionReason: { type: 'string' },
    blueprintRoleKey: { type: 'string' },
    managerPolicy: {
      type: 'object',
      properties: {
        maxDirectChildren: { type: 'integer', minimum: 1 },
        maxDelegationLevels: { type: 'integer', minimum: 1, maximum: 4 },
        allowManagerChildren: { type: 'boolean' },
      },
      required: ['maxDelegationLevels', 'allowManagerChildren'],
      additionalProperties: false,
    },
  },
  ['agentKind', 'role', 'objective'],
);

export const TEAM_LIST_MODELS_TOOL = teamToolDefinition(
  'team_list_models',
  'list-models',
  {
    text: { type: 'string' },
    connectionIds: { type: 'array', items: { type: 'string' } },
    providerIds: { type: 'array', items: { type: 'string' } },
    capabilities: { type: 'array', items: { type: 'string' } },
    cursor: { type: 'string' },
    limit: { type: 'integer' },
  },
  [],
);

export const TEAM_SEND_TO_WORKER_TOOL = teamToolDefinition(
  'team_send_to_worker',
  'send-to-worker',
  { workerId: { type: 'string' }, content: { type: 'string' } },
  ['workerId', 'content'],
);

export const TEAM_SEND_MESSAGE_TOOL = teamToolDefinition(
  'team_send_message',
  'send-message',
  { targetAgentId: { type: 'string' }, content: { type: 'string' } },
  ['targetAgentId', 'content'],
);

export const TEAM_READ_MESSAGES_TOOL = teamToolDefinition(
  'team_read_messages',
  'read-messages',
  { afterSeq: { type: 'integer' } },
  [],
);

export const TEAM_ASSIGN_TASK_TOOL = teamToolDefinition(
  'team_assign_task',
  'assign-task',
  {
    workerId: { type: 'string' },
    objective: { type: 'string' },
    doneCriteria: { type: 'array', items: { type: 'string' } },
    access: { type: 'string', enum: ['read-only', 'workspace-write'] },
  },
  ['workerId', 'objective', 'doneCriteria'],
);

export const TEAM_ASSIGN_TASKS_TOOL = teamToolDefinition(
  'team_assign_tasks',
  'assign-tasks',
  {
    assignments: {
      type: 'array',
      minItems: 1,
      maxItems: TEAM_ASSIGN_TASKS_MAX,
      items: {
        type: 'object',
        properties: {
          workerId: { type: 'string' },
          objective: { type: 'string' },
          doneCriteria: { type: 'array', items: { type: 'string' } },
          access: { type: 'string', enum: ['read-only', 'workspace-write'] },
        },
        required: ['workerId', 'objective', 'doneCriteria'],
        additionalProperties: false,
      },
    },
  },
  ['assignments'],
);

export const TEAM_ASSIGN_MISSION_TOOL = teamToolDefinition(
  'team_assign_mission',
  'assign-mission',
  {
    objective: { type: 'string' },
    doneCriteria: { type: 'array', items: { type: 'string' } },
    steps: {
      type: 'array',
      minItems: 2,
      maxItems: 12,
      items: {
        type: 'object',
        properties: {
          workerId: { type: 'string' },
          objective: { type: 'string' },
          doneCriteria: { type: 'array', items: { type: 'string' } },
          access: { type: 'string', enum: ['read-only', 'workspace-write'] },
        },
        required: ['workerId', 'objective', 'doneCriteria', 'access'],
        additionalProperties: false,
      },
    },
  },
  ['objective', 'doneCriteria', 'steps'],
);

export const TEAM_RESUME_MISSION_TOOL = teamToolDefinition(
  'team_resume_mission',
  'resume-mission',
  { missionId: { type: 'string' } },
  ['missionId'],
);

export const TEAM_STEER_EXECUTION_TOOL = teamToolDefinition(
  'team_steer_execution',
  'steer-execution',
  {
    executionId: { type: 'string' },
    instruction: { type: 'string' },
  },
  ['executionId', 'instruction'],
);

export const TEAM_CANCEL_EXECUTION_TOOL = teamToolDefinition(
  'team_cancel_execution',
  'cancel-execution',
  { executionId: { type: 'string' } },
  ['executionId'],
);

export const TEAM_GET_STATUS_TOOL = teamToolDefinition('team_get_status', 'get-status', {}, []);

export const TEAM_WAIT_EVENTS_TOOL = teamToolDefinition(
  'team_wait_events',
  'wait-events',
  { cursor: { type: 'integer' } },
  [],
);

export const TEAM_WAIT_REPORTS_TOOL = teamToolDefinition(
  'team_wait_reports',
  'wait-reports',
  {},
  [],
);

export const TEAM_STOP_WORKER_TOOL = teamToolDefinition(
  'team_stop_worker',
  'stop-worker',
  { workerId: { type: 'string' } },
  ['workerId'],
);

export const TEAM_TOOLS: readonly ToolDefinition[] = Object.freeze([
  TEAM_LIST_MODELS_TOOL,
  TEAM_HIRE_WORKER_TOOL,
  TEAM_ASSIGN_TASK_TOOL,
  TEAM_ASSIGN_TASKS_TOOL,
  TEAM_ASSIGN_MISSION_TOOL,
  TEAM_RESUME_MISSION_TOOL,
  TEAM_STEER_EXECUTION_TOOL,
  TEAM_CANCEL_EXECUTION_TOOL,
  TEAM_GET_STATUS_TOOL,
  TEAM_WAIT_EVENTS_TOOL,
  TEAM_SEND_MESSAGE_TOOL,
  TEAM_READ_MESSAGES_TOOL,
  TEAM_SEND_TO_WORKER_TOOL,
  TEAM_WAIT_REPORTS_TOOL,
  TEAM_STOP_WORKER_TOOL,
]);

export const TEAM_TOOL_DESCRIPTIONS: Readonly<Record<string, string>> = Object.freeze({
  team_list_models:
    '利用可能なConnectionとモデルをsource付き能力情報で検索します。Worker雇用前の選定に使います。',
  team_hire_worker: `自分の直下にWorkerまたはManagerを雇用します。leafはagentKind=workerかつmanagerPolicyなし、ManagerはagentKind=managerかつmaxDelegationLevelsを自分より下へ許可する相対段数で指定します。${MANAGER_WRITE_REQUIREMENTS}`,
  team_assign_task: `自分の直下Workerへtaskを割り当て、execution IDを返します。${MANAGER_WRITE_REQUIREMENTS}`,
  team_assign_tasks: `複数の直下Workerへtaskを1回でまとめて割り当てます（1〜${TEAM_ASSIGN_TASKS_MAX}件）。複数のWorkerへ割り当てるときはteam_assign_taskを繰り返さずこれを使うと、全員が同時に動き始めます。各要素はteam_assign_taskと同じ検証を受けて個別に成否が決まるので、results[].okを確認し、原因を解消してから失敗した要素だけを出し直します。長い指示が多くて1回に収まらないときは、件数を減らして数回に分けます。${MANAGER_WRITE_REQUIREMENTS}`,
  team_assign_mission: `10〜30分単位の2〜12工程を順番に実行する永続Missionを作成します。長時間のコーディングに使います。${MANAGER_WRITE_REQUIREMENTS}`,
  team_resume_mission:
    '再開待ちのMissionを、既存の部分変更を検査する新しいAttemptとして再開します。',
  team_steer_execution: '自分の配下で実行中または待機中のexecutionへ修正指示を送ります。',
  team_cancel_execution: '自分の配下のexecutionを取り消します。',
  team_get_status:
    '現在のTeam階層、Agent、execution、待機状態を取得します。waitingForWorkerは同じWorkerの先行実行待ち、workerQueueDepthはそのWorkerを待っている実行件数です。Manager/Workerには権限内の祖先・自分の配下だけが返ります。',
  team_wait_events: '指定cursor以降の配下Worker報告を取得します。',
  team_wait_reports: '配下Workerの新しい完了報告を待ちます。',
  team_send_message: '同じTeamのAgentへ監査される直接messageを送信します。',
  team_read_messages: '自分宛ての未読Team messageをsequence順に取得します。',
  team_send_to_worker: '既存Workerへ直接messageを送信します。',
  team_stop_worker: '指定Workerを停止します。',
});

const MANAGER_TEAM_TOOL_NAMES = new Set(
  Object.keys(TEAM_TOOL_DESCRIPTIONS).filter(
    (name) => name !== 'team_send_to_worker' && name !== 'team_stop_worker',
  ),
);

function providerToolDefinition(tool: ToolDefinition): ProviderTool {
  const providerInputSchema = tool.inputSchema as unknown as ProviderTool['inputSchema'];
  const inputSchema =
    tool.providerName === 'team_hire_worker'
      ? ({
          ...(providerInputSchema as Record<string, ProviderTool['inputSchema']>),
          required: ['agentKind', 'role', 'objective', 'modelSelection', 'modelSelectionReason'],
        } as ProviderTool['inputSchema'])
      : providerInputSchema;
  return {
    name: tool.providerName,
    description: TEAM_TOOL_DESCRIPTIONS[tool.providerName]!,
    inputSchema,
  };
}

export const LEADER_PROVIDER_TOOLS: readonly ProviderTool[] = Object.freeze(
  TEAM_TOOLS.filter(
    (tool) =>
      tool.providerName !== 'team_send_message' && tool.providerName !== 'team_read_messages',
  ).map(providerToolDefinition),
);

/** Official API Managers receive the same coordinator-backed authority as CLI Managers, expressed
 * in the provider-neutral tool contract. Leader-only arbitrary messaging/stopping is deliberately
 * omitted: executeTeamTool also enforces this server-side through requesterAgentId. */
export const MANAGER_PROVIDER_TOOLS: readonly ProviderTool[] = Object.freeze(
  TEAM_TOOLS.filter((tool) => MANAGER_TEAM_TOOL_NAMES.has(tool.providerName)).map(
    providerToolDefinition,
  ),
);

export const WORKER_PROVIDER_TOOLS: readonly ProviderTool[] = Object.freeze(
  TEAM_TOOLS.filter(
    (tool) =>
      tool.providerName === 'team_get_status' ||
      tool.providerName === 'team_send_message' ||
      tool.providerName === 'team_read_messages',
  ).map(providerToolDefinition),
);

export function teamToolError(error: unknown): {
  ok: false;
  error: string;
  message: string;
  code?: string;
  details?: Readonly<Record<string, number | string | boolean | null>>;
} {
  return {
    ok: false,
    error: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof TeamDelegationError ? { code: error.code, details: error.details } : {}),
  };
}

function readOnlyDelegationError(): TeamDelegationError {
  return new TeamDelegationError(
    'execution_access_ceiling',
    `read-only execution cannot delegate workspace-write access. ${MANAGER_WRITE_REQUIREMENTS} 現在の実行からは昇格できません。必要な設定を親Agentへ報告してください。`,
    {
      accessCeiling: 'read-only',
      requestedAccess: 'workspace-write',
      requiredManagerWriteCapable: true,
      requiredManagerAccess: 'workspace-write',
      recovery: 'notify_parent',
    },
  );
}

// Hiring cadence: a burst of instantaneous hires reads as fake ("the leader isn't actually
// deciding anything"). Each hire pauses briefly so the spawn choreography paces like a leader
// working through its plan. Overridable for tests (SPRINT_CODER_TEAM_PACING_MS=0).
const HIRE_PACING_MS = Number(process.env['SPRINT_CODER_TEAM_PACING_MS'] ?? 1200);
const pacing = (): Promise<void> =>
  HIRE_PACING_MS <= 0
    ? Promise.resolve()
    : new Promise((resolve) => setTimeout(resolve, HIRE_PACING_MS));

export type TeamToolName =
  | 'team_list_models'
  | 'team_record_model_research'
  | 'team_hire_worker'
  | 'team_assign_task'
  | 'team_assign_tasks'
  | 'team_assign_mission'
  | 'team_resume_mission'
  | 'team_steer_execution'
  | 'team_cancel_execution'
  | 'team_get_status'
  | 'team_wait_events'
  | 'team_send_message'
  | 'team_read_messages'
  | 'team_send_to_worker'
  | 'team_wait_reports'
  | 'team_stop_worker';

export function isTeamToolName(value: unknown): value is TeamToolName {
  return (
    value === 'team_list_models' ||
    value === 'team_record_model_research' ||
    value === 'team_hire_worker' ||
    value === 'team_assign_task' ||
    value === 'team_assign_tasks' ||
    value === 'team_assign_mission' ||
    value === 'team_resume_mission' ||
    value === 'team_steer_execution' ||
    value === 'team_cancel_execution' ||
    value === 'team_get_status' ||
    value === 'team_wait_events' ||
    value === 'team_send_message' ||
    value === 'team_read_messages' ||
    value === 'team_send_to_worker' ||
    value === 'team_wait_reports' ||
    value === 'team_stop_worker'
  );
}

// Wire-level argument shapes for every team tool. These are deliberately re-validated here (in
// addition to whatever gate a caller sits behind) because executeTeamTool is invoked from two
// places with very different trust boundaries: the mock ToolBroker (which already validates the
// call against the pinned ToolDefinition schema before dispatch) and the MCP bridge (where the
// arguments come straight off the wire from a CLI subprocess with no upstream schema gate at
// all). `.strict()` rejects any extra property — including an attacker- or model-supplied
// `sourceAgentId`/`taskId` — so identity can never be smuggled in through tool arguments; the
// taskId always comes from the caller's own registration/context, never from `args`.
const hireCommonShape = {
  role: z.string().min(1).max(100),
  objective: z.string().min(1).max(10_000),
  contextInheritancePolicy: contextInheritancePolicySchema.optional(),
  writeCapable: z.boolean().optional(),
  modelSelection: modelSelectionSchema.optional(),
  modelSelectionReason: z.string().min(1).max(2_000).optional(),
  blueprintRoleKey: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
    .optional(),
};
const managerHirePolicySchema = z
  .object({
    maxDirectChildren: z.number().int().positive().nullable().optional(),
    maxDelegationLevels: z.number().int().min(1).max(4),
    allowManagerChildren: z.boolean(),
  })
  .strict();
const hireArgsSchema = z.discriminatedUnion('agentKind', [
  z.object({ ...hireCommonShape, agentKind: z.literal('worker') }).strict(),
  z
    .object({
      ...hireCommonShape,
      agentKind: z.literal('manager'),
      managerPolicy: managerHirePolicySchema,
    })
    .strict(),
]);

function usesLegacyDelegationField(args: unknown): boolean {
  if (typeof args !== 'object' || args === null) return false;
  const managerPolicy = (args as Record<string, unknown>)['managerPolicy'];
  return (
    typeof managerPolicy === 'object' &&
    managerPolicy !== null &&
    Object.hasOwn(managerPolicy, 'maxDelegationDepth')
  );
}
const listModelsArgsSchema = z
  .object({
    text: z.string().max(200).optional(),
    connectionIds: z.array(z.string().min(1).max(256)).max(32).optional(),
    providerIds: z.array(z.string().min(1).max(128)).max(32).optional(),
    capabilities: z
      .array(z.enum(['toolCalling', 'structuredOutput', 'multimodalInput', 'reasoning']))
      .max(4)
      .optional(),
    cursor: z
      .string()
      .regex(/^cursor:[0-9]+$/)
      .nullable()
      .optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();
const modelResearchArgsSchema = z
  .object({
    modelSelection: modelSelectionSchema.refine(
      (selection) =>
        selection.connectionId !== null &&
        selection.requestedProvider !== null &&
        selection.requestedModel !== null,
      'Model research must identify a Connection, Provider, and model',
    ),
    summary: z.string().min(1).max(2_000),
    sources: z
      .array(
        z
          .string()
          .url()
          .refine((value) => value.startsWith('https://') || value.startsWith('http://')),
      )
      .min(1)
      .max(8),
  })
  .strict();
const sendArgsSchema = z
  .object({ workerId: z.string().min(1).max(128), content: z.string().min(1).max(20_000) })
  .strict();
const directMessageArgsSchema = z
  .object({
    targetAgentId: z.string().min(1).max(128),
    content: z.string().min(1).max(20_000),
  })
  .strict();
const readMessagesArgsSchema = z.object({ afterSeq: z.number().int().min(0).optional() }).strict();
const assignArgsSchema = z
  .object({
    workerId: z.string().min(1).max(128),
    objective: z.string().min(1).max(10_000),
    doneCriteria: z.array(z.string().min(1).max(1_000)).min(1).max(20),
    access: z.enum(['read-only', 'workspace-write']).default('read-only'),
  })
  .strict();
const assignTasksArgsSchema = z
  .object({
    assignments: z.array(assignArgsSchema).min(1).max(TEAM_ASSIGN_TASKS_MAX),
  })
  .strict();
const assignMissionArgsSchema = z
  .object({
    objective: z.string().min(1).max(20_000),
    doneCriteria: z.array(z.string().min(1).max(1_000)).min(1).max(64),
    steps: z
      .array(
        z
          .object({
            workerId: z.string().min(1).max(128),
            objective: z.string().min(1).max(10_000),
            doneCriteria: z.array(z.string().min(1).max(1_000)).min(1).max(20),
            access: z.enum(['read-only', 'workspace-write']),
          })
          .strict(),
      )
      .min(2)
      .max(12),
  })
  .strict();
const resumeMissionArgsSchema = z.object({ missionId: z.string().min(1).max(128) }).strict();
const steerExecutionArgsSchema = z
  .object({
    executionId: z.string().min(1).max(128),
    instruction: z.string().min(1).max(100_000),
  })
  .strict();
const cancelExecutionArgsSchema = z.object({ executionId: z.string().min(1).max(128) }).strict();
const getStatusArgsSchema = z.object({}).strict();
const waitEventsArgsSchema = z.object({ cursor: z.number().int().min(0).optional() }).strict();
const waitArgsSchema = z.object({}).strict();
const stopArgsSchema = z.object({ workerId: z.string().min(1).max(128) }).strict();

export type TeamWaitReportsCursor = Readonly<{
  read(): number;
  advance(seq: number): void;
}>;

export type ExecuteTeamToolOptions = Readonly<{
  /** Trusted caller identity supplied by the token registration, never by model arguments. */
  requesterAgentId?: string;
  /** Access ceiling sealed by the caller's parent Team execution. Delegated callers default to
   * read-only when an older registration did not persist this field. */
  accessCeiling?: 'read-only' | 'workspace-write';
  /** Immutable root Turn or parent Team execution context to inherit for newly-created work. */
  contextOwner?: { type: 'turn' | 'team_execution'; id: string };
  /** Long-poll team_wait_reports instead of returning immediately (real Leader over MCP). The
   * mock ToolBroker path always omits this (or passes false) to keep its synchronous,
   * replay-since-cursor semantics exactly as tested. */
  longPoll?: boolean;
  /** Where to read/advance the "already surfaced to this caller" report watermark. Callers own
   * the storage: the mock path keys it off the ToolBroker's per-Turn context object (a WeakMap),
   * the MCP bridge keys it off the registered turnId. */
  waitReportsCursor?: TeamWaitReportsCursor;
  longPollTimeoutMs?: number;
  longPollIntervalMs?: number;
  /** Abort of the owning tool call/Turn. A long-poll stops waiting immediately (Issue #753) by
   * throwing the signal's reason, so ToolBroker records the call as canceled (never succeeded)
   * and no report is consumed or cursor advanced for a call whose result nobody will read. */
  signal?: AbortSignal;
  listModelCandidates?(input: {
    taskId: string;
    text: string;
    connectionIds: readonly string[];
    providerIds: readonly string[];
    capabilities: readonly ('toolCalling' | 'structuredOutput' | 'multimodalInput' | 'reasoning')[];
    cursor: string | null;
    limit: number;
  }): Promise<unknown> | unknown;
  /** False only for the isolated deterministic Mock Team fixture. Real Leaders and Managers must
   * keep the catalog query + explicit model-selection contract. */
  modelSelectionRequired?: boolean;
  /** Per real Leader/Manager turn. A successful catalog read must precede an audited hire. */
  modelCatalogAudit?: Readonly<{
    wasQueried(): boolean;
    markQueried(): void;
  }>;
  /** Present only when the user's Team model-research setting is enabled for this Leader/Manager
   * turn. Recording is a separate audited step after native Web search and before hiring. */
  modelResearchAudit?: Readonly<{
    required: boolean;
    record(input: {
      modelSelection: ModelSelection;
      summary: string;
      sources: readonly string[];
    }): void;
    hasEvidence(modelSelection: ModelSelection): boolean;
  }>;
}>;

const DEFAULT_LONG_POLL_TIMEOUT_MS = 60_000;
const DEFAULT_LONG_POLL_INTERVAL_MS = 500;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function reportPayload(report: {
  sourceAgentId: string;
  seq: number;
  content: string;
  executionId: string | null;
  attemptId: string | null;
}) {
  return {
    workerId: report.sourceAgentId,
    seq: report.seq,
    content: report.content,
    executionId: report.executionId,
    attemptId: report.attemptId,
  };
}

async function executeWaitReports(
  coordinator: TeamCoordinator,
  taskId: string,
  options: ExecuteTeamToolOptions,
): Promise<unknown> {
  const cursor = options.waitReportsCursor;
  const longPoll = options.longPoll ?? false;
  const timeoutMs = options.longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  const intervalMs = options.longPollIntervalMs ?? DEFAULT_LONG_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    options.signal?.throwIfAborted();
    // Re-read the trusted cursor on every pass: concurrent waits sharing one Turn context must
    // never deliver the same report twice, and the watermark only ever moves forward. The
    // list + advance pair below is synchronous, so it is atomic between waits.
    const after = cursor?.read() ?? 0;
    const reports = coordinator.listWorkerReports(taskId, after, options.requesterAgentId);
    if (reports.length > 0) {
      cursor?.advance(Math.max(after, cursor.read(), ...reports.map((report) => report.seq)));
      return { ok: true, reports: reports.map(reportPayload) };
    }
    // Executions parked for a person's resume already reported and will not report again until
    // resumed, so they do not keep the wait open (issue #852).
    if (
      !longPoll ||
      !coordinator.hasBusyWorkers(taskId, { progressingOnly: true }) ||
      Date.now() >= deadline
    )
      return { ok: true, reports: [] };
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())), options.signal);
  }
}

/** The single execution path for every team tool call, shared by BOTH the mock ToolBroker
 * registration below and the MCP bridge (team-mcp-bridge.ts) that services the real Claude
 * Leader's tool calls. `taskId` always comes from the caller's own trusted binding (ToolBroker's
 * ToolExecutionContext, or the bridge's per-turn registration) — it is never read from `args` —
 * so a tool call can never spoof which Task/Team it targets, let alone the source/target agent
 * identity inside it. Leader, Manager, and Worker callers share this entry point; non-Leader
 * identity is supplied only by the trusted MCP/provider runtime context, never model arguments. */
export async function executeTeamTool(
  coordinator: TeamCoordinator,
  taskId: string,
  toolName: string,
  args: unknown,
  options: ExecuteTeamToolOptions = {},
): Promise<unknown> {
  if (!isTeamToolName(toolName)) throw new Error(`Unknown team tool: ${toolName}`);
  switch (toolName) {
    case 'team_list_models': {
      const request = listModelsArgsSchema.parse(args);
      if (options.listModelCandidates === undefined)
        return teamToolError(new Error('Team model catalog is unavailable'));
      const result = await options.listModelCandidates({
        taskId,
        text: request.text ?? '',
        connectionIds: request.connectionIds ?? [],
        providerIds: request.providerIds ?? [],
        capabilities: request.capabilities ?? [],
        cursor: request.cursor ?? null,
        limit: request.limit ?? 50,
      });
      options.modelCatalogAudit?.markQueried();
      return result;
    }
    case 'team_record_model_research': {
      const request = modelResearchArgsSchema.parse(args);
      if (options.modelResearchAudit?.required !== true)
        return teamToolError(new Error('Model Web research is not enabled for this Team turn'));
      options.modelResearchAudit.record(request);
      return {
        ok: true,
        modelSelection: request.modelSelection,
        sourcesRecorded: request.sources.length,
      };
    }
    case 'team_hire_worker': {
      if (usesLegacyDelegationField(args))
        return teamToolError(
          new TeamDelegationError(
            'legacy_delegation_field',
            'managerPolicy.maxDelegationDepth is no longer accepted; use relative maxDelegationLevels',
          ),
        );
      const parsed = hireArgsSchema.safeParse(args);
      if (!parsed.success) return teamToolError(parsed.error);
      const request = parsed.data;
      if (
        options.modelSelectionRequired !== false &&
        options.listModelCandidates !== undefined &&
        (request.modelSelection === undefined ||
          request.modelSelectionReason === undefined ||
          options.modelCatalogAudit?.wasQueried() !== true)
      )
        return teamToolError(
          new Error(
            'Real Team Leaders and Managers must query the model catalog, select an available model, and record the selection reason',
          ),
        );
      if (
        options.modelResearchAudit?.required === true &&
        (request.modelSelection === undefined ||
          !options.modelResearchAudit.hasEvidence(request.modelSelection))
      )
        return teamToolError(
          new Error(
            'Web research evidence for this exact model must be recorded before hiring the Worker',
          ),
        );
      await pacing();
      try {
        const hireInput = {
          taskId,
          role: request.role,
          objective: request.objective,
          contextInheritancePolicy: request.contextInheritancePolicy ?? 'summary',
          writeCapable: request.writeCapable ?? false,
          ...(request.modelSelection === undefined
            ? {}
            : { modelSelection: request.modelSelection }),
          ...(request.modelSelectionReason === undefined
            ? {}
            : { modelSelectionReason: request.modelSelectionReason }),
          ...(request.blueprintRoleKey === undefined
            ? {}
            : { blueprintRoleKey: request.blueprintRoleKey }),
        };
        const worker =
          options.requesterAgentId === undefined
            ? await coordinator.hireWorker(
                hireInput,
                request.agentKind === 'worker'
                  ? null
                  : {
                      ...request.managerPolicy,
                      maxDirectChildren: request.managerPolicy.maxDirectChildren ?? null,
                    },
              )
            : await coordinator.hireWorkerAs(
                hireInput,
                options.requesterAgentId,
                request.agentKind === 'worker'
                  ? null
                  : {
                      ...request.managerPolicy,
                      maxDirectChildren: request.managerPolicy.maxDirectChildren ?? null,
                    },
              );
        return {
          ok: true,
          workerId: worker.id,
          role: worker.role,
          state: worker.state,
          agentKind: request.agentKind,
          parentAgentId: worker.parentAgentId,
          depth: worker.depth,
          canDelegate: worker.canDelegate,
          writeCapable: worker.writeCapable,
          remainingDelegationLevels:
            worker.managerPolicy == null
              ? 0
              : Math.max(0, worker.managerPolicy.maxDelegationDepth - worker.depth),
        };
      } catch (error) {
        return teamToolError(error);
      }
    }
    case 'team_send_to_worker': {
      const request = sendArgsSchema.parse(args);
      try {
        if (options.requesterAgentId !== undefined)
          throw new Error('Manager must use team_assign_task for child work');
        const message = await coordinator.sendToWorker({
          taskId,
          targetAgentId: request.workerId,
          content: request.content,
        });
        return {
          ok: true,
          workerId: request.workerId,
          messageId: message.id,
          state: message.state,
          deliveryState: message.deliveryState,
        };
      } catch (error) {
        return teamToolError(error);
      }
    }
    case 'team_send_message': {
      const request = directMessageArgsSchema.parse(args);
      if (options.requesterAgentId === undefined)
        return teamToolError(new Error('team_send_message requires a caller-bound Agent identity'));
      try {
        const message = await coordinator.sendAgentMessageAs(
          taskId,
          options.requesterAgentId,
          request.targetAgentId,
          request.content,
        );
        return {
          ok: true,
          messageId: message.id,
          targetAgentId: message.targetAgentId,
          seq: message.seq,
          state: message.state,
        };
      } catch (error) {
        return teamToolError(error);
      }
    }
    case 'team_read_messages': {
      const request = readMessagesArgsSchema.parse(args);
      if (options.requesterAgentId === undefined)
        return teamToolError(
          new Error('team_read_messages requires a caller-bound Agent identity'),
        );
      try {
        const messages = coordinator.listAgentMessages(
          taskId,
          options.requesterAgentId,
          request.afterSeq ?? 0,
        );
        return {
          ok: true,
          messages: messages.map((message) => ({
            messageId: message.id,
            sourceAgentId: message.sourceAgentId,
            seq: message.seq,
            content: message.content,
            createdAt: message.createdAt,
          })),
        };
      } catch (error) {
        return teamToolError(error);
      }
    }
    case 'team_assign_task': {
      const request = assignArgsSchema.parse(args);
      try {
        if (
          options.requesterAgentId !== undefined &&
          (options.accessCeiling ?? 'read-only') === 'read-only' &&
          request.access === 'workspace-write'
        )
          throw readOnlyDelegationError();
        const assignInput = {
          taskId,
          targetAgentId: request.workerId,
          content: request.objective,
          doneCriteria: request.doneCriteria,
          accessMode: request.access,
        };
        const execution =
          options.requesterAgentId === undefined
            ? options.contextOwner === undefined
              ? await coordinator.assignTask(assignInput)
              : await coordinator.assignTask(assignInput, options.contextOwner)
            : options.contextOwner === undefined
              ? await coordinator.assignTaskAs(assignInput, options.requesterAgentId)
              : await coordinator.assignTaskAs(
                  assignInput,
                  options.requesterAgentId,
                  options.contextOwner,
                );
        const workspaceWriteLimitNote =
          request.access === 'workspace-write'
            ? leaderWriteLimitNote(coordinator.workspaceWriteLimits)
            : '';
        return {
          ok: true,
          workerId: request.workerId,
          executionId: execution.executionId,
          state: execution.state,
          writeScope: request.access,
          writeScopeNote: writeScopeNote(request.access, coordinator.taskAccessPreset?.(taskId)),
          ...(workspaceWriteLimitNote === ''
            ? {}
            : { workspaceWriteLimit: workspaceWriteLimitNote }),
        };
      } catch (error) {
        return teamToolError(error);
      }
    }
    case 'team_assign_tasks': {
      // Issue #864: the whole call is refused only for a malformed request, as team_assign_task's
      // is. Each element then gets team_assign_task's checks and its own result, and the elements
      // that pass stay assigned whatever happens to the others. A batch too large to cross the CLI
      // bridge is refused whole on every path, so a Leader meets the same limit everywhere.
      if (Buffer.byteLength(JSON.stringify(args) ?? '', 'utf8') > TEAM_ASSIGN_TASKS_MAX_BYTES)
        return {
          ok: false,
          error: 'RequestTooLarge',
          code: 'request_too_large',
          message: TEAM_ASSIGN_TASKS_TOO_LARGE_MESSAGE,
        };
      const request = assignTasksArgsSchema.parse(args);
      const readOnlyCeiling =
        options.requesterAgentId !== undefined &&
        (options.accessCeiling ?? 'read-only') === 'read-only';
      const admissible = request.assignments
        .map((assignment, index) => ({ assignment, index }))
        .filter(({ assignment }) => !(readOnlyCeiling && assignment.access === 'workspace-write'));
      let outcomes: readonly TeamBatchAssignmentOutcome[];
      try {
        outcomes = await coordinator.assignTasks(
          taskId,
          admissible.map(({ assignment }) => ({
            targetAgentId: assignment.workerId,
            content: assignment.objective,
            doneCriteria: assignment.doneCriteria,
            accessMode: assignment.access,
          })),
          options.requesterAgentId ?? null,
          options.contextOwner,
        );
      } catch (error) {
        return teamToolError(error);
      }
      const outcomeByIndex = new Map(
        admissible.map(({ index }, position) => [index, outcomes[position]]),
      );
      const results = request.assignments.map((assignment, index) => {
        const outcome = outcomeByIndex.get(index);
        const base = { index, workerId: assignment.workerId, writeScope: assignment.access };
        if (outcome === undefined) return { ...base, ...teamToolError(readOnlyDelegationError()) };
        if (!outcome.ok) return { ...base, ...teamToolError(outcome.error) };
        return {
          ...base,
          ok: true as const,
          executionId: outcome.submission.executionId,
          state: outcome.submission.state,
        };
      });
      const assignedWrite = results.some(
        (result) => result.ok && result.writeScope === 'workspace-write',
      );
      const workspaceWriteLimitNote = assignedWrite
        ? leaderWriteLimitNote(coordinator.workspaceWriteLimits)
        : '';
      const assigned = results.filter(({ ok }) => ok).length;
      return {
        ok: true,
        assigned,
        failed: results.length - assigned,
        results,
        writeScopeNote: assignedWrite
          ? writeScopeNote('workspace-write', coordinator.taskAccessPreset?.(taskId))
          : writeScopeNote('read-only', undefined),
        ...(workspaceWriteLimitNote === '' ? {} : { workspaceWriteLimit: workspaceWriteLimitNote }),
      };
    }
    case 'team_assign_mission': {
      const request = assignMissionArgsSchema.parse(args);
      try {
        if (
          options.requesterAgentId !== undefined &&
          (options.accessCeiling ?? 'read-only') === 'read-only' &&
          request.steps.some(({ access }) => access === 'workspace-write')
        )
          throw readOnlyDelegationError();
        const missionInput = {
          taskId,
          objective: request.objective,
          doneCriteria: request.doneCriteria,
          steps: request.steps,
        };
        const mission =
          options.contextOwner === undefined
            ? await coordinator.assignMission(missionInput, options.requesterAgentId ?? null)
            : await coordinator.assignMission(
                missionInput,
                options.requesterAgentId ?? null,
                options.contextOwner,
              );
        const missionHasWorkspaceWrite = request.steps.some(
          ({ access }) => access === 'workspace-write',
        );
        const workspaceWriteLimitNote = missionHasWorkspaceWrite
          ? leaderWriteLimitNote(coordinator.workspaceWriteLimits)
          : '';
        const missionWriteScopeNote = missionHasWorkspaceWrite
          ? writeScopeNote('workspace-write', coordinator.taskAccessPreset?.(taskId))
          : writeScopeNote('read-only', undefined);
        return {
          ok: true,
          missionId: mission.id,
          state: mission.state,
          currentStepOrdinal: mission.currentStepOrdinal,
          // ステップごとに request.steps と同じ並び順で作られる（team-coordinator.assignMission）ので、
          // index で access を引き当てられる。
          executions: mission.steps.map(({ ordinal, executionId }, index) => ({
            ordinal,
            executionId,
            writeScope: request.steps[index]?.access ?? 'read-only',
          })),
          writeScopeNote: missionWriteScopeNote,
          ...(workspaceWriteLimitNote === ''
            ? {}
            : { workspaceWriteLimit: workspaceWriteLimitNote }),
        };
      } catch (error) {
        return teamToolError(error);
      }
    }
    case 'team_resume_mission': {
      const request = resumeMissionArgsSchema.parse(args);
      try {
        const mission = await coordinator.resumeMission(
          taskId,
          request.missionId,
          options.requesterAgentId ?? null,
          options.accessCeiling ?? 'read-only',
        );
        return {
          ok: true,
          missionId: mission.id,
          state: mission.state,
          currentStepOrdinal: mission.currentStepOrdinal,
        };
      } catch (error) {
        return teamToolError(error);
      }
    }
    case 'team_steer_execution': {
      const request = steerExecutionArgsSchema.parse(args);
      try {
        const execution = await coordinator.steerExecution(
          taskId,
          request.executionId,
          request.instruction,
          options.requesterAgentId ?? null,
          options.accessCeiling ?? 'read-only',
        );
        return { ok: true, executionId: execution.executionId, state: execution.state };
      } catch (error) {
        return teamToolError(error);
      }
    }
    case 'team_cancel_execution': {
      const request = cancelExecutionArgsSchema.parse(args);
      try {
        const execution = await coordinator.cancelExecution(
          taskId,
          request.executionId,
          options.requesterAgentId ?? null,
        );
        return { ok: true, executionId: execution.executionId, state: execution.state };
      } catch (error) {
        return teamToolError(error);
      }
    }
    case 'team_get_status': {
      getStatusArgsSchema.parse(args);
      return {
        ok: true,
        team:
          options.requesterAgentId === undefined
            ? coordinator.get(taskId)
            : coordinator.getForAgent(taskId, options.requesterAgentId),
      };
    }
    case 'team_wait_events': {
      const request = waitEventsArgsSchema.parse(args);
      return executeWaitReports(coordinator, taskId, {
        ...options,
        ...(request.cursor === undefined
          ? {}
          : { waitReportsCursor: { read: () => request.cursor ?? 0, advance: () => undefined } }),
      });
    }
    case 'team_wait_reports': {
      waitArgsSchema.parse(args);
      return executeWaitReports(coordinator, taskId, options);
    }
    case 'team_stop_worker': {
      const request = stopArgsSchema.parse(args);
      try {
        if (options.requesterAgentId !== undefined)
          throw new Error(
            'Manager must cancel its execution instead of stopping arbitrary Workers',
          );
        const worker = await coordinator.stopWorker(taskId, request.workerId);
        return { ok: true, workerId: worker.id, state: worker.state };
      } catch (error) {
        return teamToolError(error);
      }
    }
  }
}

/** Registers the Leader team tool implementations on an existing mock ToolBroker. Every
 * implementation only ever calls executeTeamTool/TeamCoordinator — it never touches persistence
 * directly and never accepts source/target identity from the tool input, so a tool call can't
 * spoof an envelope's source/target (the coordinator resolves the Leader/Worker itself). */
export function registerTeamTools(
  broker: ToolBroker,
  coordinator: TeamCoordinator,
  options: Pick<ExecuteTeamToolOptions, 'listModelCandidates'> & {
    modelSelectionRequired?: (context: ToolExecutionContext) => boolean;
  } = {},
): void {
  const modelCatalogQueried = new WeakSet<object>();
  // Issue #753: real (non-fixture) Turns reach these implementations through the managed tool
  // catalog (the MCP bridge dispatches a managed `team_wait_*` via the ToolBroker, never via
  // executeTeamTool's own bridge branch), so long-polling must be requested here too. Without it a
  // busy Worker made every wait return empty after ~1s. Only the isolated mock fixture, and
  // callers that cannot classify the Turn, keep the synchronous replay semantics.
  // NOTE: modelSelectionRequired is reused as "this is not the isolated mock Team fixture"; the
  // provider-workspace-tools wiring that supplies it is the single place that knows that.
  const longPollFor = (context: ToolExecutionContext): boolean =>
    options.modelSelectionRequired?.(context) === true;
  broker.registerImplementation({
    toolId: TEAM_LIST_MODELS_TOOL.toolId,
    implementationKind: 'built-in',
    execute: (input, context) =>
      executeTeamTool(coordinator, context.taskId, 'team_list_models', input, {
        ...(options.listModelCandidates === undefined
          ? {}
          : { listModelCandidates: options.listModelCandidates }),
        modelCatalogAudit: {
          wasQueried: () => modelCatalogQueried.has(context),
          markQueried: () => modelCatalogQueried.add(context),
        },
      }),
  });
  broker.registerImplementation({
    toolId: TEAM_HIRE_WORKER_TOOL.toolId,
    implementationKind: 'built-in',
    execute: (input, context) =>
      executeTeamTool(coordinator, context.taskId, 'team_hire_worker', input, {
        ...(options.listModelCandidates === undefined
          ? {}
          : { listModelCandidates: options.listModelCandidates }),
        modelSelectionRequired: options.modelSelectionRequired?.(context) ?? true,
        modelCatalogAudit: {
          wasQueried: () => modelCatalogQueried.has(context),
          markQueried: () => modelCatalogQueried.add(context),
        },
      }),
  });
  broker.registerImplementation({
    toolId: TEAM_ASSIGN_TASK_TOOL.toolId,
    implementationKind: 'built-in',
    execute: (input, context) =>
      executeTeamTool(coordinator, context.taskId, 'team_assign_task', input, {
        contextOwner: { type: 'turn', id: context.turnId },
      }),
  });
  broker.registerImplementation({
    toolId: TEAM_ASSIGN_TASKS_TOOL.toolId,
    implementationKind: 'built-in',
    execute: (input, context) =>
      executeTeamTool(coordinator, context.taskId, 'team_assign_tasks', input, {
        contextOwner: { type: 'turn', id: context.turnId },
      }),
  });
  broker.registerImplementation({
    toolId: TEAM_ASSIGN_MISSION_TOOL.toolId,
    implementationKind: 'built-in',
    execute: (input, context) =>
      executeTeamTool(coordinator, context.taskId, 'team_assign_mission', input, {
        contextOwner: { type: 'turn', id: context.turnId },
      }),
  });
  broker.registerImplementation({
    toolId: TEAM_RESUME_MISSION_TOOL.toolId,
    implementationKind: 'built-in',
    execute: (input, context) =>
      executeTeamTool(coordinator, context.taskId, 'team_resume_mission', input),
  });
  broker.registerImplementation({
    toolId: TEAM_STEER_EXECUTION_TOOL.toolId,
    implementationKind: 'built-in',
    execute: (input, context) =>
      executeTeamTool(coordinator, context.taskId, 'team_steer_execution', input),
  });
  broker.registerImplementation({
    toolId: TEAM_CANCEL_EXECUTION_TOOL.toolId,
    implementationKind: 'built-in',
    execute: (input, context) =>
      executeTeamTool(coordinator, context.taskId, 'team_cancel_execution', input),
  });
  broker.registerImplementation({
    toolId: TEAM_GET_STATUS_TOOL.toolId,
    implementationKind: 'built-in',
    execute: (input, context) =>
      executeTeamTool(coordinator, context.taskId, 'team_get_status', input),
  });

  broker.registerImplementation({
    toolId: TEAM_SEND_TO_WORKER_TOOL.toolId,
    implementationKind: 'built-in',
    execute: (input, context) =>
      executeTeamTool(coordinator, context.taskId, 'team_send_to_worker', input),
  });
  broker.registerImplementation({
    toolId: TEAM_WAIT_EVENTS_TOOL.toolId,
    implementationKind: 'built-in',
    execute: (input, context, control) =>
      executeTeamTool(coordinator, context.taskId, 'team_wait_events', input, {
        longPoll: longPollFor(context),
        ...(control.signal === undefined ? {} : { signal: control.signal }),
        waitReportsCursor: {
          read: () => reportCursors.get(context) ?? 0,
          advance: (seq) => reportCursors.set(context, seq),
        },
      }),
  });

  // Per-Turn read cursor: `context` is the exact same frozen object for every dispatch within one
  // Turn (see ToolBroker.startTurn), so keying a WeakMap by it scopes "already surfaced reports"
  // without new persistence state — the same technique default-tools.ts uses for command ids.
  // longPoll is false unless the Turn is a real one (see longPollFor), preserving the exact
  // synchronous, replay-since-cursor behavior the mock fixture tests pin.
  const reportCursors = new WeakMap<object, number>();
  broker.registerImplementation({
    toolId: TEAM_WAIT_REPORTS_TOOL.toolId,
    implementationKind: 'built-in',
    execute: (input, context, control) =>
      executeTeamTool(coordinator, context.taskId, 'team_wait_reports', input, {
        longPoll: longPollFor(context),
        ...(control.signal === undefined ? {} : { signal: control.signal }),
        waitReportsCursor: {
          read: () => reportCursors.get(context) ?? 0,
          advance: (seq) => reportCursors.set(context, seq),
        },
      }),
  });

  broker.registerImplementation({
    toolId: TEAM_STOP_WORKER_TOOL.toolId,
    implementationKind: 'built-in',
    execute: (input, context) =>
      executeTeamTool(coordinator, context.taskId, 'team_stop_worker', input),
  });
}

// --- Leader MCP guidance ----------------------------------------------------------------------
//
// Appended to the real Codex/Claude Leader's prompt only when
// The MCP bridge is the default for real CLI Team turns; SPRINT_CODER_LEADER_MCP=0 is the explicit
// rollback switch. Concise and in Japanese to match the rest of the in-app leader/worker copy.
/** Compatibility export for adapters while the authority-bearing copy travels as a context
 * fragment. The content's source of truth is the versioned builtin skill, not this module. */
export const LEADER_MCP_SYSTEM_PROMPT = BUILTIN_TEAM_SKILL_CONTENT;
export const MANAGER_MCP_SYSTEM_PROMPT = `${BUILTIN_TEAM_SKILL_CONTENT}

あなたはTeamのManagerです。team_hire_workerで自分の直下Agentだけを雇用してください。
子のworkspace-writeを委譲できる上限は、親から割り当てられた現在の実行のaccessです。
writeCapable: trueだけでは足りず、Manager自身への割当access: workspace-writeも必要です。
read-onlyの現在の実行からは昇格できません。不足する設定を親Agentへ報告し、同じ設定で再試行しないでください。
team_assign_taskで直下Agentへ正式taskを割り当ててください。requester identityを引数へ
追加しないでください。作業開始時、配下の待機中、最終報告前にteam_read_messagesを確認し、
必要な情報はteam_send_messageで同じTeamのAgentへ共有してください。配下Agentの終端reportを
確認・統合したら、必ず自分の親Agentへ結果をteam_send_messageで報告してください。
直下のleaf Workerを雇う場合はagentKind: "worker"を指定し、managerPolicyを付けないでください。
再委譲するManagerを雇う場合だけagentKind: "manager"とmanagerPolicyを指定します。
managerPolicy.maxDelegationLevelsはその子Managerの直下から許す追加段数で、直属Workerだけなら1です。
雇用可否はTeam Policyと自分のManager Policyで判断してください。
配下のexecutionがcompletedになり中央workspaceへ統合されたファイルは、自分の隔離worktreeには現れません。
read_fileが利用できる場合は、確認にread_file({path: "rootからの相対path", teamResultExecutionId: "配下の完了executionId"})を使ってください。
別rootはrootIdも指定します。読めるのはそのexecutionの統合済み変更pathの現在内容です。
この中央readは自分の編集のread-backにはならず、そのrevisionを隔離worktreeの編集へ使うこともできません。
権限はMCP tokenへ固定されています。
`;
export const WORKER_MCP_SYSTEM_PROMPT = `あなたはTeamのWorkerです。
作業開始時と最終報告前、長い作業では区切りごとにteam_read_messagesで自分宛てのmessageを確認し、
他Agentとの情報共有には親から渡された永続Agent IDを使ってteam_send_messageを呼び出してください。
team_get_statusには自分の権限範囲だけが表示されます。宛先IDが不明なら親へ確認してください。
taskIdや送信元identityを引数へ追加しないでください。
権限はMCP tokenへ固定されています。Team管理ツールを呼び出してはいけません。
`;

// --- Deterministic mock team scenario -------------------------------------------------------
//
// Follows the same "keyword marks a fixture scenario" convention as
// createDeterministicMockSampler's `承認テスト`/`コマンドテスト` markers in intelligence-loop.ts.
export const TEAM_SCENARIO_TRIGGER = 'チームテスト';
const TEAM_SCENARIO_ROLES = ['調査', '実装', 'レビュー'] as const;

// Natural team intent (「チームで進めて」「teamでお願い」「組織を Team で作って」「3 人雇って」…)
// auto-routes the turn into the team orchestration path — the user should not need to know the
// fixture keyword or press ⬡ Team. Japanese input commonly puts a half- or full-width space
// between an ASCII word or a digit and the Japanese that follows, so `team` before a particle
// (で/を/に) and a count before its counter (人/名/り) tolerate those spaces; a tab or newline
// still separates, and `team` followed by an arbitrary word mid-sentence (「READMEに team 使える？
// と書いて」) is still no intent.
const TEAM_INTENT =
  /^\s*\/team(?=\s+\S)|チームテスト|チーム(?:で|を|に|内(?:で|の))|(?:^|[^a-zA-Z])team(?:(?=[ぁ-んァ-ヶ一-龠々ー])|[ \u3000]+(?=[でをに][ぁ-んァ-ヶ一-龠々ー]))|^[ \u3000]*team[ \u3000]+(?=[ぁ-んァ-ヶ一-龠々ー])|(?:^|[^a-zA-Z])team\s*(?:[1-9][0-9]*|[１-９][０-９]*|[一二三四五六七八九十百]+)[ \u3000]*(?:り|名|人)(?=.*(?:雇|挨拶|会話|担当|メンバー))|(?:^|[^0-9０-９一二三四五六七八九十百])(?:[1-9][0-9]*|[１-９][０-９]*|[一二三四五六七八九十百]+)[ \u3000]*(?:名|人(?:(?:体制)?で|雇って|を雇))/i;
const TEAM_COMPOUND_EXECUTION_INTENT =
  /チーム(?:編成|作成)(?=(?:して|し|する|を?お願い|してください|してほしい))/i;
const TEAM_RELATION_INTENT =
  /チーム(?:の)?(?:メンバー|リーダー)|チームの(?:会話|挨拶|メッセージ|報告|担当|役割)|(?:^|[^a-zA-Z])team\s+(?:skill|mcp)\b/i;
const TEAM_CONSULTATION_ENDING =
  /(?:できますか|できる(?:の)?|可能ですか|可能(?:なの)?|教えて|説明して|とは)[。.!！?？]*$/i;
const TEAM_WORKER_EXECUTION_ACTION =
  /(?:(?:雇って|雇用して|採用して|作成して|編集して|実装して|実行して|作業して|調査して|検証して|監査して|レビューして|挨拶して|会話させて|分担して|進めて|コードを書いて)(?:ください|ほしい)?|(?:編集|実装|実行|作業|調査|検証|監査|レビュー|採用|雇用)?(?:を)?お願い(?:します)?)$/i;
const TEAM_EXECUTION_MARKER =
  /^\s*\/team(?=\s+\S)|チーム(?:で|を|に|内で|(?:内の|の)?(?:メンバー|担当|リーダー)(?:で|に))|(?:^|[^a-zA-Z])team(?:(?:で|を)|[ \u3000]+(?=[でを][ぁ-んァ-ヶ一-龠々ー]))|(?:^|[^a-zA-Z])team\s+(?:skill|mcp)(?:\s*を使って|で)|(?:^|[^a-zA-Z])team\s*(?:[1-9][0-9]*|[１-９][０-９]*|[一二三四五六七八九十百]+)[ \u3000]*(?:り|名|人)|(?:worker|agent|ワーカー|担当|メンバー|リーダー)[^。.!！?？\r\n]{0,40}(?:雇って|雇用して|採用して)|(?:^|[^0-9０-９一二三四五六七八九十百])(?:[1-9][0-9]*|[１-９][０-９]*|[一二三四五六七八九十百]+)[ \u3000]*(?:名|人)(?:(?:体制|構成)?で|を?雇)/i;
// This new entry path requires a member as the direct object of hiring. The broader legacy
// execution marker also accepts 採用して (including adopting a proposal/library), so cannot be
// promoted to initial Team intent.
const TEAM_HIRING_COUNT =
  '(?:[1-9][0-9]*|[１-９][０-９]*|[一二三四五六七八九十百]+)[ \\u3000]*(?:人|名)';
const TEAM_EXPLICIT_MEMBER_HIRING = new RegExp(
  `(?:\\b(?:worker|agent)\\b|ワーカー|担当(?:者)?|メンバー|リーダー)[ \\u3000]*(?:${TEAM_HIRING_COUNT}[ \\u3000]*)?を[ \\u3000]*(?:${TEAM_HIRING_COUNT}[ \\u3000]*)?(?:雇って|雇用して)`,
  'gi',
);
// A trailing escape still ends an unclosed quote; otherwise each escaped quote can trigger
// another failed scan of the remainder of a long pasted example.
const TEAM_HIRING_QUOTED_TEXT =
  /(?<ticks>`+)[\s\S]*?(?:\k<ticks>|$)|(?<fence>~{3,})[\s\S]*?(?:\k<fence>|$)|「[^」]*(?:」|$)|『[^』]*(?:』|$)|“[^”]*(?:”|$)|”[^”]*(?:”|$)|＂[^＂]*(?:＂|$)|〝[^〟〞]*(?:[〟〞]|$)|‘[^’]*(?:’|$)|"(?:\\[\s\S]|[^"\\])*(?:"|\\?$)|(?<![a-zA-Z])'(?:\\[\s\S]|[^'\\])*(?:'|\\?$)/g;
const TEAM_HIRING_IMMEDIATE_NEGATION = /^(?:は|も(?!ら)|ない|なく|ません|ほしく|欲しく)/;
const TEAM_HIRING_DIRECT_REQUEST =
  /^(?:ください|ほしい|欲しい|いただくようお願いします|(?:もらえ|いただけ|くれ)(?:(?:ますか|ませんか|ませんでしょうか|ないでしょうか)[?？]?|ない[?？]))$/;
const TEAM_HIRING_OBJECT_WORD = '[a-zA-Z0-9Ａ-Ｚａ-ｚ０-９一-龠々ァ-ヶー_/#+@\uFFFB\uFFFC-]+';
const TEAM_HIRING_OBJECT_NOUN = `${TEAM_HIRING_OBJECT_WORD}(?:\\(${TEAM_HIRING_OBJECT_WORD}\\)|（${TEAM_HIRING_OBJECT_WORD}）)?`;
const TEAM_HIRING_OBJECT_QUANTITY =
  /[0-9０-９一二三四五六七八九十百千]+[ \u3000]*(?:人|名|件|枚|個|本|つ)(?:ずつ)?[ \u3000]*/gy;
// Only quantities, joined nouns and a directory destination may precede the complete action.
// In particular these terms cannot consume verbal clauses such as 「させないで自分で」.
const TEAM_HIRING_FOLLOWING_OBJECT = new RegExp(
  `^${TEAM_HIRING_OBJECT_NOUN}(?:[ \\u3000]*(?:と|や|の|及び|および|・)[ \\u3000]*${TEAM_HIRING_OBJECT_NOUN})*[ \\u3000]*を[ \\u3000]*(?:(?:[a-zA-Z0-9０-９一-龠々ァ-ヶー_-]+[/\\\\])+[ \\u3000]*に[ \\u3000]*)?`,
);
const TEAM_HIRING_FOLLOWING_ACTION = new RegExp(`^${TEAM_WORKER_EXECUTION_ACTION.source}`, 'i');
const TEAM_HIRING_CAUSATIVE_ACTION =
  /^[一-龠々ァ-ヶー]+[かがさたなばまらわ]せ(?:ます|て(?:ください|ほしい)?)?$/;
const TEAM_HIRING_FOLLOWUP_REQUEST = /^(?:教えて|説明して|報告して)(?:ください|ほしい)?$/;
const TEAM_HIRING_SENTENCES = /[^。.!！?？\r\n]+[。.!！?？]*/g;
// Unlike these quotation particles, an ambiguous adverb such as なんか can start an independent thought.
// Presentation tags and up to three unparsed emphasis closers keep a quotation attached.
// Literal-example barriers and whitespace after a list marker start an independent segment.
const TEAM_HIRING_QUOTED_CONTINUATION =
  /^[、,\s\uFFFB]*(?:[*_]{1,3}(?![\s*_])[、,\s\uFFFB]*)?(?:と|って|なんて|など|みたい|のよう)/;
const TEAM_HIRING_INDEPENDENT_COURTESY = /^[、,\s\uFFFB]*とても助かります[。.!！?？\s\uFFFB]*$/;

function splitHiringSentences(input: string): readonly string[] {
  const sentences: string[] = [];
  let chunks: string[] = [];
  const finish = () => {
    // Courtesy remains in the group until its end: a later quotation particle can still make
    // both the request and the courtesy reported speech.
    for (;;) {
      const last = chunks.at(-1);
      if (last === undefined || !TEAM_HIRING_INDEPENDENT_COURTESY.test(last)) break;
      chunks.pop();
    }
    if (chunks.length > 0) sentences.push(chunks.join(''));
    chunks = [];
  };
  for (const [segment] of input.matchAll(TEAM_HIRING_SENTENCES)) {
    // Consume punctuation runs once. A quotation particle keeps its unknown reporting suffix
    // attached so the affirmative check cannot mistake the quoted request for an instruction.
    if (!TEAM_HIRING_QUOTED_CONTINUATION.test(segment)) finish();
    chunks.push(segment);
  }
  finish();
  return sentences;
}

function hiringActionAfterObject(clause: string): string {
  let quantityEnd = 0;
  let lastQuantityStart = 0;
  // Sticky matching scans only the quantity prefix. Keeping it outside the noun expression
  // prevents retrying the whole noun suffix at every quantity when a long input has no object.
  for (const quantity of clause.matchAll(TEAM_HIRING_OBJECT_QUANTITY)) {
    lastQuantityStart = quantity.index;
    quantityEnd = quantity.index + quantity[0].length;
  }
  // The final quantity may itself be the noun: 「1人ずつ2件を調査して」. Two candidates suffice;
  // earlier quantity tokens never need to be restored and re-scanned.
  for (const start of quantityEnd === 0 ? [0] : [quantityEnd, lastQuantityStart]) {
    const remaining = clause.slice(start);
    const object = TEAM_HIRING_FOLLOWING_OBJECT.exec(remaining);
    if (object !== null) return remaining.slice(object[0].length);
  }
  return clause;
}

function joinHiringContinuationLines(input: string): string {
  const lines = input
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return lines
    .map((line, index) => {
      const nextLine = lines[index + 1];
      if (nextLine === undefined) return line;
      // A completed polite request may introduce a list on the next line. Keep reporting
      // continuations such as 「と伝えました」 attached instead of manufacturing a request.
      if (
        /(?:ください|お願いします|(?:ますか|ませんか|でしょうか)[?？]?)$/.test(line) &&
        (!/^[ぁ-ん]/.test(nextLine) || /^(?:よろしくお願いします[。.!！]*$|あと、)/.test(nextLine))
      )
        return `${line}。`;
      // Japanese verb suffixes may wrap between 「して」 and 「ください」. Only ASCII words
      // need a separating space to avoid creating or removing a role's word boundary.
      return /[a-zA-Z0-9_]$/.test(line) && /^[a-zA-Z0-9_]/.test(nextLine) ? `${line} ` : line;
    })
    .join('');
}

function isAffirmativeHiringClause(clause: string, first: boolean, hasFollowing: boolean): boolean {
  if (TEAM_HIRING_IMMEDIATE_NEGATION.test(clause)) return false;
  if (first && TEAM_HIRING_DIRECT_REQUEST.test(clause)) return true;
  if (clause === 'いただいて') return first && hasFollowing;
  const actionAfterObject = hiringActionAfterObject(clause);
  return (
    [clause, actionAfterObject].some(
      (action) =>
        TEAM_HIRING_FOLLOWING_ACTION.test(action) || TEAM_HIRING_CAUSATIVE_ACTION.test(action),
    ) ||
    (!first && actionAfterObject !== clause && TEAM_HIRING_FOLLOWUP_REQUEST.test(actionAfterObject))
  );
}

function sentenceHasExplicitMemberHiring(sentence: string): boolean {
  let end = sentence.length;
  while (end > 0 && '。.!！'.includes(sentence.charAt(end - 1))) end -= 1;
  const clauses = sentence
    .slice(0, end)
    .split(/[、,]/)
    .map((clause) => clause.trim())
    .filter((clause) => clause !== '');
  const firstAffirmative = clauses.map((clause, index) =>
    isAffirmativeHiringClause(clause, true, index + 1 < clauses.length),
  );
  const affirmativeSuffix = Array<boolean>(clauses.length + 1).fill(true);
  for (let index = clauses.length - 1; index >= 0; index -= 1) {
    const clause = clauses[index];
    if (clause === undefined) continue;
    affirmativeSuffix[index] =
      isAffirmativeHiringClause(clause, false, index + 1 < clauses.length) &&
      affirmativeSuffix[index + 1] === true;
  }
  return clauses.some((clause, index) => {
    const tailIsAffirmative = affirmativeSuffix[index + 1] === true;
    const bareHiringIsAffirmative =
      index + 1 === clauses.length ||
      (firstAffirmative[index + 1] === true && affirmativeSuffix[index + 2] === true);
    if (!tailIsAffirmative && !bareHiringIsAffirmative) return false;
    // Each match inspects only its own comma clause. The remaining clauses are evaluated once
    // above, so repeated hiring phrases cannot trigger quadratic suffix splitting or checks.
    for (const match of clause.matchAll(TEAM_EXPLICIT_MEMBER_HIRING)) {
      const following = clause.slice(match.index + match[0].length).trimStart();
      if (following === '') {
        if (bareHiringIsAffirmative) return true;
      } else if (
        tailIsAffirmative &&
        isAffirmativeHiringClause(following, true, index + 1 < clauses.length)
      )
        return true;
    }
    return false;
  });
}

function isExplicitMemberHiringInput(input: string): boolean {
  if (!input.includes('雇')) return false;
  // Mask before splitting sentences so punctuation inside quotes cannot expose an instruction.
  // A non-whitespace barrier also prevents joining a role and verb across a quoted fragment.
  // A line break alone does not complete a request: its prohibition or reporting suffix may
  // continue on the next line. Preserve that continuation for the affirmative-only classifier.
  const unquoted = joinHiringContinuationLines(
    maskTeamHiringMarkdown(input).replace(TEAM_HIRING_QUOTED_TEXT, '\uFFFC'),
  );
  const sentences = splitHiringSentences(unquoted);
  return sentences.some(sentenceHasExplicitMemberHiring);
}
const TEAM_ROLE_ASSIGNMENT_EXECUTION_ACTION =
  /(?:雇って|雇用して|採用して|作成して|構築して|編集して|実装して|実行して|作業して|調査して|検証して|監査して|レビューして|分担して|進めて)(?:ください|ほしい)?[。.!！?？]*$/i;
const TEAM_ROLE_ASSIGNMENT_NEGATION =
  /割り当て(?:ない|ず)|(?:リーダー|\bleader\b|ワーカー|\bworker\b)[^。.!！?？\r\n]{0,60}(?:にしない|にせず|にして(?:は)?(?:いけない|ならない)|へ変更しない|を変更しない|変えない|使わない|禁止)|^\s*(?:please\s+)?(?:(?:don't|do not|never|shouldn't|should not|mustn't|must not)\s+(?:use|set|assign|make)|(?:use|set|assign|make)\s+neither)\b|\b(?:don't|do not|never|shouldn't|should not|mustn't|must not)\s+(?:use|set|assign|make)\b[^.!?\r\n]{0,80}\b(?:leader|worker)\b|\bnot\s+as\s+(?:the\s+)?(?:leader|worker)\b|\bwithout\s+(?:using|setting|assigning|making)\b[^.!?\r\n]{0,80}\b(?:leader|worker)\b|(?:^|[,;—-])\s*(?:actually\s*[,;—-]?\s*)?(?:don['’]t|do not)[.!]?\s*$/i;
const TEAM_QUOTED_ROLE_ASSIGNMENT =
  /(?:[「『“"'`][^」』”"'`\r\n]{0,240}(?:リーダー|\bleader\b)[^」』”"'`\r\n]{0,240}(?:ワーカー|\bworker\b)[^」』”"'`\r\n]{0,240}[」』”"'`]|[「『“"'`][^」』”"'`\r\n]{0,240}(?:ワーカー|\bworker\b)[^」』”"'`\r\n]{0,240}(?:リーダー|\bleader\b)[^」』”"'`\r\n]{0,240}[」』”"'`])/i;
const TEAM_ROLE_ASSIGNMENT_MODEL =
  '(?:codex|claude|ollama|現在(?:選択中|選択している)のモデル|ローカルLLM)';
const TEAM_JAPANESE_ROLE_ASSIGNMENT_FOLLOWUP = `(?:${TEAM_ROLE_ASSIGNMENT_MODEL}|リーダー|ワーカー|実装|構築|作業|調査|検証|レビュー|機能|skill|スキル)`;
const TEAM_JAPANESE_ROLE_ASSIGNMENT_ACTION = `(?:(?:へ|に)変更(?:して|した)?|にして|にした)(?=$|[、,。.!！?？\\r\\n]|${TEAM_JAPANESE_ROLE_ASSIGNMENT_FOLLOWUP}|\\s+${TEAM_JAPANESE_ROLE_ASSIGNMENT_FOLLOWUP})`;
const TEAM_ENGLISH_ROLE_ASSIGNMENT_MODEL =
  '(?:codex|claude|ollama|(?:the\\s+)?current(?:ly selected)?\\s+model|(?:the\\s+)?local\\s+llm)';
const TEAM_ENGLISH_ROLE_ASSIGNMENT_REQUEST = new RegExp(
  `^\\s*(?:please\\s+)?(?:use|set|assign|make)\\s+(?:${TEAM_ENGLISH_ROLE_ASSIGNMENT_MODEL}\\s+(?:as\\s+)?(?:the\\s+)?leader\\s+(?:and|,)\\s+${TEAM_ENGLISH_ROLE_ASSIGNMENT_MODEL}\\s+(?:as\\s+)?(?:the\\s+)?worker|${TEAM_ENGLISH_ROLE_ASSIGNMENT_MODEL}\\s+(?:as\\s+)?(?:the\\s+)?worker\\s+(?:and|,)\\s+${TEAM_ENGLISH_ROLE_ASSIGNMENT_MODEL}\\s+(?:as\\s+)?(?:the\\s+)?leader)\\s*,?\\s*(?:to|and|then)\\s+(?:implement|build|create|execute|investigate|review|work on)\\b[^.!?\\r\\n]{0,160}[.!]?\\s*$`,
  'i',
);
const TEAM_JAPANESE_PAIRED_ROLE_ASSIGNMENT = new RegExp(
  `(?:リーダーを${TEAM_ROLE_ASSIGNMENT_MODEL}[、,]\\s*ワーカーを${TEAM_ROLE_ASSIGNMENT_MODEL}${TEAM_JAPANESE_ROLE_ASSIGNMENT_ACTION}|ワーカーを${TEAM_ROLE_ASSIGNMENT_MODEL}[、,]\\s*リーダーを${TEAM_ROLE_ASSIGNMENT_MODEL}${TEAM_JAPANESE_ROLE_ASSIGNMENT_ACTION}|${TEAM_ROLE_ASSIGNMENT_MODEL}をリーダー[、,]\\s*${TEAM_ROLE_ASSIGNMENT_MODEL}をワーカー${TEAM_JAPANESE_ROLE_ASSIGNMENT_ACTION}|${TEAM_ROLE_ASSIGNMENT_MODEL}をワーカー[、,]\\s*${TEAM_ROLE_ASSIGNMENT_MODEL}をリーダー${TEAM_JAPANESE_ROLE_ASSIGNMENT_ACTION})`,
  'i',
);

// A Team turn is commonly resumed with a short instruction that no longer repeats
// the word "Team". Keep this deliberately narrow: ordinary follow-up questions must not silently
// gain team capabilities just because an older turn once used them.
const TEAM_CONTINUATION =
  /^(?:(?:continue|resume|retry|続けて|続行|再開|再試行|リトライ)(?:してください|して|お願い)?|(?:やって|進めて|実行して)(?:ください|ほしい)?|お願いします)[。.!！]?$/i;
const TEAM_MEMBER_CHANGE_TARGET = /\bworker\b|\bagent\b|ワーカー|担当|メンバー|リーダー/i;
const TEAM_MEMBER_MODEL_TARGET = /codex|claude|ollama/gi;
const TEAM_MEMBER_CHANGE_ACTION =
  /(?:にして|にした|(?:へ|を)変更(?:して|した)?|変えて|入れ替(?:えて)?|交代)(?=$|[、,。.!！?？\r\n])|(?:codex|claude|ollama)nisite(?=$|[、,。.!！?？\r\n])|\b(?:nisite|kaete|change|switch|replace)\b/i;
const EXISTING_TEAM_MEMBER_REFERENCE =
  /(?:\b(?:worker|agent)\b|担当|メンバー|リーダー)(?:同士(?:で|の)?|たち(?:と|で|に|へ|から|の|を)?|達(?:と|で|に|へ|から|の|を)?|と|で|に|へ|から|の|を)/i;
const EXISTING_TEAM_INTERACTION =
  /(?:挨拶|会話|メッセージ|報告|連絡|返信|返事)(?:を|し|して|させ|させて)/i;
const EXISTING_TEAM_DELEGATION =
  /(?:\b(?:worker|agent)\b|担当|メンバー|リーダー)(?:に|へ)[^。.!！?？\r\n]{0,40}(?:作業|実行|編集|実装|調査|検証|レビュー)(?:を)?(?:させ|してもら|依頼し|任せ)/i;
const REPEATED_TEAM_ACTION =
  /(?:もう一度|もう一回|再度).*(?:挨拶|会話|メッセージ|連絡|返信|返事)(?:を|し|して|させ|させて)/i;

export function isTeamScenarioInput(input: string): boolean {
  return (
    TEAM_INTENT.test(input) ||
    TEAM_COMPOUND_EXECUTION_INTENT.test(input) ||
    TEAM_RELATION_INTENT.test(input) ||
    isExplicitTeamRoleAssignmentInput(input) ||
    isExplicitMemberHiringInput(input)
  );
}

function hasAssignedTeamRole(input: string, role: 'leader' | 'worker'): boolean {
  const japaneseRole = role === 'leader' ? 'リーダー' : 'ワーカー';
  const modelBeforeRole = new RegExp(
    `[^、,。.!！?？\\r\\n]{1,40}(?:を|は)${japaneseRole}${TEAM_JAPANESE_ROLE_ASSIGNMENT_ACTION}`,
    'i',
  );
  const roleBeforeModel = new RegExp(
    `${japaneseRole}(?:を|には)[^、,。.!！?？\\r\\n]{1,40}${TEAM_JAPANESE_ROLE_ASSIGNMENT_ACTION}`,
    'i',
  );
  return modelBeforeRole.test(input) || roleBeforeModel.test(input);
}

function isExplicitTeamRoleAssignmentInput(input: string): boolean {
  const trimmed = input.trim();
  const hasJapaneseExecution = TEAM_ROLE_ASSIGNMENT_EXECUTION_ACTION.test(trimmed);
  const hasEnglishExecution = TEAM_ENGLISH_ROLE_ASSIGNMENT_REQUEST.test(trimmed);
  const hasBothJapaneseRoles =
    (hasAssignedTeamRole(trimmed, 'leader') && hasAssignedTeamRole(trimmed, 'worker')) ||
    TEAM_JAPANESE_PAIRED_ROLE_ASSIGNMENT.test(trimmed);
  return (
    ((hasBothJapaneseRoles && hasJapaneseExecution) || hasEnglishExecution) &&
    !TEAM_ROLE_ASSIGNMENT_NEGATION.test(trimmed) &&
    !TEAM_QUOTED_ROLE_ASSIGNMENT.test(trimmed) &&
    !TEAM_CONSULTATION_ENDING.test(trimmed)
  );
}

/** Team相談にもSkill/MCPは提供するが、Worker不在を失敗にするのは明示的な実行依頼だけ。 */
export function requiresTeamWorkersInput(input: string): boolean {
  const trimmed = input.trim();
  // Preserve leading indentation until Markdown examples have been excluded.
  if (isExplicitMemberHiringInput(input)) return true;
  if (!isTeamScenarioInput(input)) return false;
  if (isExplicitTeamRoleAssignmentInput(trimmed)) return true;
  if (TEAM_COMPOUND_EXECUTION_INTENT.test(trimmed)) return true;
  const hasExplicitExecutionClause = trimmed
    .split(/[、,。.!！?？\r\n]+/)
    .some((clause) => TEAM_WORKER_EXECUTION_ACTION.test(clause.trim()));
  return TEAM_EXECUTION_MARKER.test(trimmed) && hasExplicitExecutionClause;
}

export function isTeamScenarioFixtureInput(input: string): boolean {
  return input.includes(TEAM_SCENARIO_TRIGGER);
}

export function isTeamContinuationInput(input: string): boolean {
  const trimmed = input.trim();
  if (TEAM_CONTINUATION.test(trimmed)) return true;
  if (TEAM_CONSULTATION_ENDING.test(trimmed)) return false;
  if (!TEAM_MEMBER_CHANGE_ACTION.test(trimmed)) return false;
  if (TEAM_MEMBER_CHANGE_TARGET.test(trimmed)) return true;
  const namedModels = new Set(
    (trimmed.match(TEAM_MEMBER_MODEL_TARGET) ?? []).map((model) => model.toLowerCase()),
  );
  return namedModels.size >= 2;
}

/** Existing Teamの相手や直前のTeam操作を指す、Teamという語を省略したfollow-up。 */
export function isExistingTeamFollowupInput(input: string): boolean {
  const trimmed = input.trim();
  return (
    (EXISTING_TEAM_MEMBER_REFERENCE.test(trimmed) && EXISTING_TEAM_INTERACTION.test(trimmed)) ||
    EXISTING_TEAM_DELEGATION.test(trimmed) ||
    REPEATED_TEAM_ACTION.test(trimmed)
  );
}

type ToolCallResult = { callId: string; arguments: unknown; result: unknown };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseJson(content: string | undefined): unknown {
  if (content === undefined) return undefined;
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

function callResults(
  transcript: readonly ToolTranscriptItem[],
  toolName: string,
): readonly ToolCallResult[] {
  const calls = transcript.filter(
    (item): item is Extract<ToolTranscriptItem, { type: 'tool-call' }> =>
      item.type === 'tool-call' && item.toolName === toolName,
  );
  return calls.map((call) => {
    const resultItem = transcript.find(
      (item): item is Extract<ToolTranscriptItem, { type: 'tool-result' }> =>
        item.type === 'tool-result' && item.callId === call.callId,
    );
    return {
      callId: call.callId,
      arguments: call.arguments,
      result: parseJson(resultItem?.content),
    };
  });
}

function teamCallId(kind: string, input: string, key: string, index: number): string {
  return `team-${kind}-${index}-${digestCanonical({ input, kind, key }).slice(0, 12)}`;
}

/** A fully deterministic mock Leader turn: hire 調査/実装/レビュー, formally assign a task derived
 * from the user message to each, wait for their reports, then synthesize a
 * final answer. Mirrors createDeterministicMockSampler's shape but drives the multi-step
 * hire → assign → wait → answer flow instead of a single mock tool call. */
export function createTeamScenarioSampler(input: string): ModelSampler {
  const excerpt = input.replace(/\s+/g, ' ').trim().slice(0, 160);
  return ({ transcript }) => {
    const hires = callResults(transcript, 'team_hire_worker');
    const assignments = callResults(transcript, 'team_assign_task');
    const waits = callResults(transcript, 'team_wait_reports');

    if (hires.length === 0)
      return {
        kind: 'tool-calls',
        calls: TEAM_SCENARIO_ROLES.map((role, index) => ({
          callId: teamCallId('hire', input, role, index),
          toolName: 'team_hire_worker',
          arguments: { agentKind: 'worker', role, objective: `${role}: ${excerpt}` },
        })),
      };

    if (assignments.length === 0) {
      const failedHire = hires.find(({ result }) => asRecord(result)?.ok === false);
      if (failedHire !== undefined) {
        const failure = asRecord(failedHire.result);
        const message =
          typeof failure?.message === 'string'
            ? failure.message
            : typeof failure?.error === 'string'
              ? failure.error
              : 'unknown Team hire error';
        throw new Error(`Deterministic Team fixture hire failed: ${message}`);
      }
      const calls: ModelToolCall[] = [];
      hires.forEach(({ arguments: args, result }, index) => {
        const workerId = asRecord(result)?.workerId;
        const role = asRecord(args)?.role;
        if (typeof workerId !== 'string' || typeof role !== 'string') return;
        calls.push({
          callId: teamCallId('assign', input, workerId, index),
          toolName: 'team_assign_task',
          arguments: {
            workerId,
            objective: `${role}として「${excerpt}」に対応してください。`,
            doneCriteria: ['検証可能な結果をLeaderへ報告する'],
          },
        });
      });
      return { kind: 'tool-calls', calls };
    }

    const reports = waits.flatMap(({ result }) => {
      const value = asRecord(result)?.reports;
      return Array.isArray(value) ? value : [];
    });
    const reportedWorkerIds = new Set(
      reports
        .map((entry) => asRecord(entry)?.workerId)
        .filter((workerId): workerId is string => typeof workerId === 'string'),
    );
    if (reportedWorkerIds.size < hires.length)
      return {
        kind: 'tool-calls',
        calls: [
          {
            callId: teamCallId('wait', input, 'reports', waits.length),
            toolName: 'team_wait_reports',
            arguments: {},
          },
        ],
      };

    const roleByWorkerId = new Map<string, string>();
    for (const { arguments: args, result } of hires) {
      const workerId = asRecord(result)?.workerId;
      const role = asRecord(args)?.role;
      if (typeof workerId === 'string' && typeof role === 'string')
        roleByWorkerId.set(workerId, role);
    }
    const lines = reports.map((entry) => {
      const record = asRecord(entry);
      const workerId = typeof record?.workerId === 'string' ? record.workerId : '';
      const role = roleByWorkerId.get(workerId) ?? '担当';
      const content = typeof record?.content === 'string' ? record.content : '';
      const summary = asRecord(parseJson(content))?.summary;
      return `- ${role}: ${typeof summary === 'string' ? summary : content}`;
    });
    return {
      kind: 'final',
      text:
        `「${excerpt}」について、チーム（${TEAM_SCENARIO_ROLES.join('・')}）から報告を受け取りました。\n` +
        `${lines.join('\n')}\n` +
        '以上の報告を統合した結論です。',
    };
  };
}
