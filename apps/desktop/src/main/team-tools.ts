// Leader team tools (FR-TEAM-06/13, IMPLEMENTATION_PLAN Slice 5.2): the Leader hires and
// dispatches Workers via tool use during its own Turn instead of the user driving teams.* IPC
// directly. Every tool forwards to TeamCoordinator, which remains the sole issuer of
// source/target envelopes and the sole enforcer of hierarchy policy, budget reservations, and the
// Team/Worker state machines — this file never mutates Team state on its own.
//
// Real Codex/Claude runtimes stay no-tools for now (see runtime-host.ts): these definitions are
// only ever registered on the mock/intelligence-loop ToolBroker (createDefaultToolBroker's
// optional `team` bundle), never on RuntimeHostClient's path.
import { z } from 'zod';
import {
  contextInheritancePolicySchema,
  modelSelectionSchema,
} from '@sprint-coder/contracts';
import {
  createToolDefinition,
  createToolId,
  type JsonValue,
  type ToolDefinition,
} from '@sprint-coder/domain';
import type { ToolBroker } from './tool-broker';
import type { TeamCoordinator } from './team-coordinator';
import { digestCanonical } from './context-compiler';
import type { ToolTranscriptItem } from './context-compiler';
import type { ModelSampler, ModelToolCall } from './intelligence-loop';
import { BUILTIN_TEAM_SKILL_CONTENT } from './team-skill';

const teamToolDefinition = (
  providerName: string,
  name: string,
  properties: Record<string, JsonValue>,
  required: readonly string[],
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
    },
    outputSchema: { type: 'object' },
    sideEffect: 'none',
    risk: 'low',
    requiredCapabilities: [],
    executionTarget: 'main',
    implementationKind: 'built-in',
    priority: 10,
    workspaceBinding: { kind: 'none' },
    providerCompatibility: ['mock'],
  });

export const TEAM_HIRE_WORKER_TOOL = teamToolDefinition(
  'team_hire_worker',
  'hire-worker',
  {
    role: { type: 'string' },
    objective: { type: 'string' },
    contextInheritancePolicy: { type: 'string' },
    writeCapable: { type: 'boolean' },
    modelSelection: {
      type: 'object',
      properties: {
        connectionId: { type: ['string', 'null'] },
        requestedProvider: { type: ['string', 'null'] },
        requestedModel: { type: ['string', 'null'] },
      },
      required: ['connectionId', 'requestedProvider', 'requestedModel'],
      additionalProperties: false,
    },
    managerPolicy: {
      type: 'object',
      properties: {
        maxDirectChildren: { type: 'integer' },
        maxDelegationDepth: { type: 'integer' },
        allowManagerChildren: { type: 'boolean' },
      },
      required: ['maxDelegationDepth', 'allowManagerChildren'],
      additionalProperties: false,
    },
  },
  ['role', 'objective'],
);

export const TEAM_SEND_TO_WORKER_TOOL = teamToolDefinition(
  'team_send_to_worker',
  'send-to-worker',
  { workerId: { type: 'string' }, content: { type: 'string' } },
  ['workerId', 'content'],
);

export const TEAM_ASSIGN_TASK_TOOL = teamToolDefinition(
  'team_assign_task',
  'assign-task',
  {
    workerId: { type: 'string' },
    objective: { type: 'string' },
    doneCriteria: { type: 'array', items: { type: 'string' } },
  },
  ['workerId', 'objective', 'doneCriteria'],
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
  TEAM_HIRE_WORKER_TOOL,
  TEAM_ASSIGN_TASK_TOOL,
  TEAM_STEER_EXECUTION_TOOL,
  TEAM_CANCEL_EXECUTION_TOOL,
  TEAM_GET_STATUS_TOOL,
  TEAM_WAIT_EVENTS_TOOL,
  TEAM_SEND_TO_WORKER_TOOL,
  TEAM_WAIT_REPORTS_TOOL,
  TEAM_STOP_WORKER_TOOL,
]);

function teamToolError(error: unknown): { ok: false; error: string; message: string } {
  return {
    ok: false,
    error: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
  };
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
  | 'team_hire_worker'
  | 'team_assign_task'
  | 'team_steer_execution'
  | 'team_cancel_execution'
  | 'team_get_status'
  | 'team_wait_events'
  | 'team_send_to_worker'
  | 'team_wait_reports'
  | 'team_stop_worker';

export function isTeamToolName(value: unknown): value is TeamToolName {
  return (
    value === 'team_hire_worker' ||
    value === 'team_assign_task' ||
    value === 'team_steer_execution' ||
    value === 'team_cancel_execution' ||
    value === 'team_get_status' ||
    value === 'team_wait_events' ||
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
const hireArgsSchema = z
  .object({
    role: z.string().min(1).max(100),
    objective: z.string().min(1).max(10_000),
    contextInheritancePolicy: contextInheritancePolicySchema.optional(),
    writeCapable: z.boolean().optional(),
    modelSelection: modelSelectionSchema.optional(),
    managerPolicy: z
      .object({
        maxDirectChildren: z.number().int().positive().nullable().optional(),
        maxDelegationDepth: z.number().int().min(1).max(4),
        allowManagerChildren: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();
const sendArgsSchema = z
  .object({ workerId: z.string().min(1).max(128), content: z.string().min(1).max(20_000) })
  .strict();
const assignArgsSchema = z
  .object({
    workerId: z.string().min(1).max(128),
    objective: z.string().min(1).max(10_000),
    doneCriteria: z.array(z.string().min(1).max(1_000)).min(1).max(20),
  })
  .strict();
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
}>;

const DEFAULT_LONG_POLL_TIMEOUT_MS = 60_000;
const DEFAULT_LONG_POLL_INTERVAL_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reportPayload(report: { sourceAgentId: string; seq: number; content: string }) {
  return { workerId: report.sourceAgentId, seq: report.seq, content: report.content };
}

async function executeWaitReports(
  coordinator: TeamCoordinator,
  taskId: string,
  options: ExecuteTeamToolOptions,
): Promise<unknown> {
  const cursor = options.waitReportsCursor;
  const after = cursor?.read() ?? 0;
  const longPoll = options.longPoll ?? false;
  const timeoutMs = options.longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  const intervalMs = options.longPollIntervalMs ?? DEFAULT_LONG_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const reports = coordinator.listWorkerReports(taskId, after, options.requesterAgentId);
    if (reports.length > 0) {
      cursor?.advance(Math.max(after, ...reports.map((report) => report.seq)));
      return { ok: true, reports: reports.map(reportPayload) };
    }
    if (!longPoll || !coordinator.hasBusyWorkers(taskId) || Date.now() >= deadline)
      return { ok: true, reports: [] };
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
}

/** The single execution path for every team tool call, shared by BOTH the mock ToolBroker
 * registration below and the MCP bridge (team-mcp-bridge.ts) that services the real Claude
 * Leader's tool calls. `taskId` always comes from the caller's own trusted binding (ToolBroker's
 * ToolExecutionContext, or the bridge's per-turn registration) — it is never read from `args` —
 * so a tool call can never spoof which Task/Team it targets, let alone the source/target agent
 * identity inside it (this Leader-only entry point lets TeamCoordinator resolve the Leader).
 * Manager runtimes use a separate caller-bound entry point; they never provide their identity in
 * model-controlled arguments. */
export async function executeTeamTool(
  coordinator: TeamCoordinator,
  taskId: string,
  toolName: string,
  args: unknown,
  options: ExecuteTeamToolOptions = {},
): Promise<unknown> {
  if (!isTeamToolName(toolName)) throw new Error(`Unknown team tool: ${toolName}`);
  switch (toolName) {
    case 'team_hire_worker': {
      const request = hireArgsSchema.parse(args);
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
        };
        const worker =
          options.requesterAgentId === undefined
            ? await coordinator.hireWorker(
                hireInput,
                request.managerPolicy === undefined
                  ? null
                  : {
                      ...request.managerPolicy,
                      maxDirectChildren: request.managerPolicy.maxDirectChildren ?? null,
                    },
              )
            : await coordinator.hireWorkerAs(
                hireInput,
                options.requesterAgentId,
                request.managerPolicy === undefined
                  ? null
                  : {
                      ...request.managerPolicy,
                      maxDirectChildren: request.managerPolicy.maxDirectChildren ?? null,
                    },
              );
        return { ok: true, workerId: worker.id, role: worker.role, state: worker.state };
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
    case 'team_assign_task': {
      const request = assignArgsSchema.parse(args);
      try {
        const assignInput = {
          taskId,
          targetAgentId: request.workerId,
          content: request.objective,
          doneCriteria: request.doneCriteria,
        };
        const execution =
          options.requesterAgentId === undefined
            ? await coordinator.assignTask(assignInput)
            : await coordinator.assignTaskAs(assignInput, options.requesterAgentId);
        return {
          ok: true,
          workerId: request.workerId,
          executionId: execution.executionId,
          state: execution.state,
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
      return { ok: true, team: coordinator.get(taskId) };
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
export function registerTeamTools(broker: ToolBroker, coordinator: TeamCoordinator): void {
  broker.registerImplementation({
    toolId: TEAM_HIRE_WORKER_TOOL.toolId,
    implementationKind: 'built-in',
    execute: (input, context) =>
      executeTeamTool(coordinator, context.taskId, 'team_hire_worker', input),
  });
  broker.registerImplementation({
    toolId: TEAM_ASSIGN_TASK_TOOL.toolId,
    implementationKind: 'built-in',
    execute: (input, context) =>
      executeTeamTool(coordinator, context.taskId, 'team_assign_task', input),
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
    execute: (input, context) =>
      executeTeamTool(coordinator, context.taskId, 'team_wait_events', input, {
        waitReportsCursor: {
          read: () => reportCursors.get(context) ?? 0,
          advance: (seq) => reportCursors.set(context, seq),
        },
      }),
  });

  // Per-Turn read cursor: `context` is the exact same frozen object for every dispatch within one
  // Turn (see ToolBroker.startTurn), so keying a WeakMap by it scopes "already surfaced reports"
  // without new persistence state — the same technique default-tools.ts uses for command ids.
  // longPoll stays false here (the default), preserving the exact synchronous,
  // replay-since-cursor behavior the existing tests pin.
  const reportCursors = new WeakMap<object, number>();
  broker.registerImplementation({
    toolId: TEAM_WAIT_REPORTS_TOOL.toolId,
    implementationKind: 'built-in',
    execute: (input, context) =>
      executeTeamTool(coordinator, context.taskId, 'team_wait_reports', input, {
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
// SPRINT_CODER_LEADER_MCP=1 routes the turn through the MCP bridge instead of the deterministic
// mock scenario. Concise and in Japanese to match the rest of the in-app leader/worker copy.
/** Compatibility export for adapters while the authority-bearing copy travels as a context
 * fragment. The content's source of truth is the versioned builtin skill, not this module. */
export const LEADER_MCP_SYSTEM_PROMPT = BUILTIN_TEAM_SKILL_CONTENT;
export const MANAGER_MCP_SYSTEM_PROMPT = `${BUILTIN_TEAM_SKILL_CONTENT}

あなたはTeamのManagerです。team_hire_workerで自分の直下Agentだけを雇用し、
team_assign_taskで直下Agentへ正式taskを割り当ててください。requester identityを引数へ
追加しないでください。権限はMCP tokenへ固定されています。
`;

// --- Deterministic mock team scenario -------------------------------------------------------
//
// Follows the same "keyword marks a fixture scenario" convention as
// createDeterministicMockSampler's `承認テスト`/`コマンドテスト` markers in intelligence-loop.ts.
export const TEAM_SCENARIO_TRIGGER = 'チームテスト';
const TEAM_SCENARIO_ROLES = ['調査', '実装', 'レビュー'] as const;

// Natural team intent (「チームで進めて」「teamでお願い」…) auto-routes the turn into the team
// orchestration path — the user should not need to know the fixture keyword or press ⬡ Team.
const TEAM_INTENT =
  /チームテスト|チーム(?:で|を|に)|(?:^|[^a-zA-Z])team(?:で|を|に)|(?:^|[^0-9０-９一二三四五六七八九十])[1-8一二三四五六七八]人(?:(?:体制)?で|雇って|を雇)/i;

export function isTeamScenarioInput(input: string): boolean {
  return TEAM_INTENT.test(input);
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
          arguments: { role, objective: `${role}: ${excerpt}` },
        })),
      };

    if (assignments.length === 0) {
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
