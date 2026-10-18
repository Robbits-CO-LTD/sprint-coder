// Test support only (issue #863): a Team detail shaped like a large real Team, used to measure and
// bound what one Team publish costs. It is not exported from the package entry point.
import {
  teamDetailSchema,
  type TeamActivitySummary,
  type TeamDetail,
  type TeamExecutionSummary,
  type TeamMessageSummary,
  type WorkerSummary,
} from './index';

const at = '2026-10-18T04:11:43.000Z';
const teamId = 'team-0000';
const leaderId = 'agent-leader';

export function fixtureWorkerId(index: number): string {
  return `agent-${String(index).padStart(4, '0')}`;
}

/** A Leader message as long as a real assignment or report, written in Markdown. */
export function fixtureMessageContent(index: number, chars = 1_400): string {
  const head = `## 作業 ${index}\n\n- 対象: \`src/worker-${index}.txt\`\n- 条件: 61 行ちょうど\n\n`;
  return (head + '本文 '.repeat(chars)).slice(0, chars);
}

export function fixtureWorker(index: number, liveOutput: string): WorkerSummary {
  return {
    id: fixtureWorkerId(index),
    teamId,
    threadId: `thread-${index}`,
    taskId: 'task-0000',
    kind: 'worker',
    role: `W${String(index).padStart(2, '0')}-${index % 2 === 0 ? 'codex' : 'claude'}`,
    state: 'busy',
    objective: `Create the file src/worker-${index}.txt with exactly 61 lines`,
    writeCapable: true,
    currentActivity: `step ${index}`,
    engine: index % 2 === 0 ? 'codex' : 'claude',
    connectionId: index % 2 === 0 ? 'builtin:codex-cli' : 'builtin:claude-cli',
    requestedProvider: index % 2 === 0 ? 'openai' : 'anthropic',
    requestedModel: index % 2 === 0 ? 'gpt-5.6-luna' : 'sonnet',
    parentAgentId: null,
    depth: 1,
    canDelegate: false,
    managerPolicy: null,
    liveOutput,
    reasoningActive: false,
    usage: { costCents: 0, tokens: 0, timeMs: 0, toolCalls: 0 },
    createdAt: at,
    updatedAt: at,
  };
}

export function fixtureMessage(
  seq: number,
  workerIndex: number,
  toWorker: boolean,
): TeamMessageSummary {
  const worker = fixtureWorkerId(workerIndex);
  return {
    id: `message-${String(seq).padStart(5, '0')}`,
    teamId,
    sourceAgentId: toWorker ? leaderId : worker,
    targetAgentId: toWorker ? worker : leaderId,
    sourceKind: toWorker ? 'leader' : 'worker',
    targetKind: toWorker ? 'worker' : 'leader',
    seq,
    state: 'acknowledged',
    content: fixtureMessageContent(seq),
    executionId: `execution-${workerIndex}`,
    attemptId: null,
    deliveryState: 'acked',
    attempt: 1,
    createdAt: at,
    updatedAt: at,
  };
}

export function fixtureExecution(index: number): TeamExecutionSummary {
  return {
    id: `execution-${index}`,
    teamId,
    assigneeAgentId: fixtureWorkerId(index),
    createdByAgentId: leaderId,
    accessMode: 'workspace-write',
    state: 'running',
    instructionPreview: `Create the file src/worker-${index}.txt with exactly 61 lines`,
    instructionRevision: 1,
    queueOrdinal: null,
    queueReason: null,
    connectionId: 'builtin:claude-cli',
    requestedModel: 'sonnet',
    attemptStartReason: 'initial',
    lastProgressAt: at,
    terminalReason: null,
    missionId: null,
    missionStepOrdinal: null,
    missionStepCount: null,
    worktree: null,
    isolation: null,
    assignedAt: at,
    queuedAt: at,
    startedAt: at,
    completedAt: null,
    updatedAt: at,
  };
}

export function fixtureActivity(seq: number, workerIndex: number): TeamActivitySummary {
  return {
    id: `activity-${String(seq).padStart(5, '0')}`,
    teamId,
    seq,
    type: 'execution_started',
    actorAgentId: leaderId,
    actorRole: 'leader',
    subjectAgentId: fixtureWorkerId(workerIndex),
    subjectRole: `W${workerIndex}`,
    executionId: `execution-${workerIndex}`,
    attemptId: null,
    status: 'running',
    queueReason: null,
    attemptOrdinal: 1,
    terminalReason: null,
    connectionId: 'builtin:claude-cli',
    requestedProvider: 'anthropic',
    requestedModel: 'sonnet',
    modelSelectionReason: 'The Team spec assigns this Worker to Claude.',
    recordedAt: at,
  };
}

/**
 * A Team with `workers` busy Workers, each with a full live output, the assignment and report
 * messages of a real run and 200 activities (the most a detail carries).
 */
export function largeTeamDetail(workers = 32, liveOutputChars = 20_000): TeamDetail {
  const leader: WorkerSummary = {
    ...fixtureWorker(0, ''),
    id: leaderId,
    kind: 'leader',
    role: 'leader',
    state: 'ready',
    objective: null,
    writeCapable: false,
    depth: 0,
    canDelegate: true,
  };
  const list = [leader];
  const messages: TeamMessageSummary[] = [];
  const executions: TeamExecutionSummary[] = [];
  for (let index = 1; index <= workers; index += 1) {
    list.push(fixtureWorker(index, 'x'.repeat(liveOutputChars)));
    messages.push(fixtureMessage(messages.length + 1, index, true));
    messages.push(fixtureMessage(messages.length + 1, index, false));
    executions.push(fixtureExecution(index));
  }
  const activities = Array.from({ length: 200 }, (_, index) =>
    fixtureActivity(index + 1, (index % workers) + 1),
  );
  return teamDetailSchema.parse({
    team: {
      id: teamId,
      taskId: 'task-0000',
      state: 'active',
      leaderAgentId: leaderId,
      budget: {},
      policy: {
        maxAgentDepth: 4,
        maxConcurrentExecutions: 50,
        allowWorkerDirectMessages: true,
        budgetMode: 'bounded',
      },
      revision: 1,
      createdAt: at,
      updatedAt: at,
    },
    workers: list,
    messages,
    executions,
    missions: [],
    activities,
    budgets: [{ scope: 'team', kind: 'costCents', cap: 1000, committed: 0, reserved: 0 }],
  });
}
