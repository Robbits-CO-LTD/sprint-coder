// Leader team tools (FR-TEAM-06/13, IMPLEMENTATION_PLAN Slice 5.2): the Leader hires and
// dispatches Workers via tool use during its own Turn instead of the user driving teams.* IPC
// directly. Every tool forwards to TeamCoordinator, which remains the sole issuer of
// source/target envelopes and the sole enforcer of the max-3 cap, budget reservations, and the
// Team/Worker state machines — this file never mutates Team state on its own.
//
// Real Codex/Claude runtimes stay no-tools for now (see runtime-host.ts): these definitions are
// only ever registered on the mock/intelligence-loop ToolBroker (createDefaultToolBroker's
// optional `team` bundle), never on RuntimeHostClient's path.
import {
  createToolDefinition,
  createToolId,
  type ContextInheritancePolicy,
  type JsonValue,
  type ToolDefinition,
} from '@sprint-coder/domain';
import type { ToolBroker } from './tool-broker';
import type { TeamCoordinator } from './team-coordinator';
import { digestCanonical } from './context-compiler';
import type { ToolTranscriptItem } from './context-compiler';
import type { ModelSampler, ModelToolCall } from './intelligence-loop';

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
  },
  ['role', 'objective'],
);

export const TEAM_SEND_TO_WORKER_TOOL = teamToolDefinition(
  'team_send_to_worker',
  'send-to-worker',
  { workerId: { type: 'string' }, content: { type: 'string' } },
  ['workerId', 'content'],
);

export const TEAM_WAIT_REPORTS_TOOL = teamToolDefinition('team_wait_reports', 'wait-reports', {}, []);

export const TEAM_STOP_WORKER_TOOL = teamToolDefinition(
  'team_stop_worker',
  'stop-worker',
  { workerId: { type: 'string' } },
  ['workerId'],
);

export const TEAM_TOOLS: readonly ToolDefinition[] = Object.freeze([
  TEAM_HIRE_WORKER_TOOL,
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

/** Registers the Leader team tool implementations on an existing mock ToolBroker. Every
 * implementation only ever calls TeamCoordinator methods — it never touches persistence
 * directly and never accepts source/target identity from the tool input, so a tool call can't
 * spoof an envelope's source/target (the coordinator resolves the Leader/Worker itself). */
export function registerTeamTools(broker: ToolBroker, coordinator: TeamCoordinator): void {
  broker.registerImplementation({
    toolId: TEAM_HIRE_WORKER_TOOL.toolId,
    implementationKind: 'built-in',
    execute: async (input, context) => {
      const request = input as {
        role: string;
        objective: string;
        contextInheritancePolicy?: ContextInheritancePolicy;
        writeCapable?: boolean;
      };
      try {
        const worker = await coordinator.hireWorker({
          taskId: context.taskId,
          role: request.role,
          objective: request.objective,
          contextInheritancePolicy: request.contextInheritancePolicy ?? 'summary',
          writeCapable: request.writeCapable ?? false,
        });
        return { ok: true, workerId: worker.id, role: worker.role, state: worker.state };
      } catch (error) {
        return teamToolError(error);
      }
    },
  });

  broker.registerImplementation({
    toolId: TEAM_SEND_TO_WORKER_TOOL.toolId,
    implementationKind: 'built-in',
    execute: async (input, context) => {
      const request = input as { workerId: string; content: string };
      try {
        const message = await coordinator.sendToWorker({
          taskId: context.taskId,
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
    },
  });

  // Per-Turn read cursor: `context` is the exact same frozen object for every dispatch within one
  // Turn (see ToolBroker.startTurn), so keying a WeakMap by it scopes "already surfaced reports"
  // without new persistence state — the same technique default-tools.ts uses for command ids.
  const reportCursors = new WeakMap<object, number>();
  broker.registerImplementation({
    toolId: TEAM_WAIT_REPORTS_TOOL.toolId,
    implementationKind: 'built-in',
    execute: (_input, context) => {
      const after = reportCursors.get(context) ?? 0;
      const reports = coordinator.listWorkerReports(context.taskId, after);
      if (reports.length > 0)
        reportCursors.set(context, Math.max(after, ...reports.map((report) => report.seq)));
      return {
        ok: true,
        reports: reports.map((report) => ({
          workerId: report.sourceAgentId,
          seq: report.seq,
          content: report.content,
        })),
      };
    },
  });

  broker.registerImplementation({
    toolId: TEAM_STOP_WORKER_TOOL.toolId,
    implementationKind: 'built-in',
    execute: async (input, context) => {
      const request = input as { workerId: string };
      try {
        const worker = await coordinator.stopWorker(context.taskId, request.workerId);
        return { ok: true, workerId: worker.id, state: worker.state };
      } catch (error) {
        return teamToolError(error);
      }
    },
  });
}

// --- Deterministic mock team scenario -------------------------------------------------------
//
// Follows the same "keyword marks a fixture scenario" convention as
// createDeterministicMockSampler's `承認テスト`/`コマンドテスト` markers in intelligence-loop.ts.
export const TEAM_SCENARIO_TRIGGER = 'チームテスト';
const TEAM_SCENARIO_ROLES = ['調査', '実装', 'レビュー'] as const;

export function isTeamScenarioInput(input: string): boolean {
  return input.includes(TEAM_SCENARIO_TRIGGER);
}

type ToolCallResult = { callId: string; arguments: unknown; result: unknown };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
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
    return { callId: call.callId, arguments: call.arguments, result: parseJson(resultItem?.content) };
  });
}

function teamCallId(kind: string, input: string, key: string, index: number): string {
  return `team-${kind}-${index}-${digestCanonical({ input, kind, key }).slice(0, 12)}`;
}

/** A fully deterministic mock Leader turn: hire 調査/実装/レビュー, dispatch a task derived from
 * the user message to each, wait for their (simulated, synchronous) reports, then synthesize a
 * final answer. Mirrors createDeterministicMockSampler's shape but drives the multi-step
 * hire → send → wait → answer flow instead of a single mock tool call. */
export function createTeamScenarioSampler(input: string): ModelSampler {
  const excerpt = input.replace(/\s+/g, ' ').trim().slice(0, 160);
  return ({ transcript }) => {
    const hires = callResults(transcript, 'team_hire_worker');
    const sends = callResults(transcript, 'team_send_to_worker');
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

    if (sends.length === 0) {
      const calls: ModelToolCall[] = [];
      hires.forEach(({ arguments: args, result }, index) => {
        const workerId = asRecord(result)?.workerId;
        const role = asRecord(args)?.role;
        if (typeof workerId !== 'string' || typeof role !== 'string') return;
        calls.push({
          callId: teamCallId('send', input, workerId, index),
          toolName: 'team_send_to_worker',
          arguments: { workerId, content: `${role}として「${excerpt}」に対応してください。` },
        });
      });
      return { kind: 'tool-calls', calls };
    }

    if (waits.length === 0)
      return {
        kind: 'tool-calls',
        calls: [
          {
            callId: teamCallId('wait', input, 'reports', 0),
            toolName: 'team_wait_reports',
            arguments: {},
          },
        ],
      };

    const roleByWorkerId = new Map<string, string>();
    for (const { arguments: args, result } of hires) {
      const workerId = asRecord(result)?.workerId;
      const role = asRecord(args)?.role;
      if (typeof workerId === 'string' && typeof role === 'string') roleByWorkerId.set(workerId, role);
    }
    const latestWait = waits.at(-1);
    const reports = Array.isArray(asRecord(latestWait?.result)?.reports)
      ? (asRecord(latestWait?.result)?.reports as unknown[])
      : [];
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
