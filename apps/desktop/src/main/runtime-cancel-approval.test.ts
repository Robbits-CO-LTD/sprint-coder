import { describe, expect, it, vi } from 'vitest';
import type { TurnEvent, TurnStage } from '@sprint-coder/contracts';
import type { IntelligenceStepState, StepSnapshot } from '@sprint-coder/domain';
import { ApprovalCoordinator } from './approval-coordinator';
import { TaskMailbox } from './ipc';
import { MockRuntimeAdapter } from './runtime';

vi.mock('electron', () => ({
  ipcMain: { on: vi.fn(), handle: vi.fn() },
  dialog: { showMessageBox: vi.fn() },
}));

// Issue #1260: Stop pressed while the mock 「承認テスト」 Turn waits on its approval card.
//
// IPC runs `turns.cancel` inside the Task mailbox and awaits the runtime's stop there. The mock
// run, once its approval wait ends, used to queue its intelligence-step bookkeeping on that same
// mailbox, so the stop waited on the run and the run waited on the stop. Every later mutation of
// the Task (the card's 「拒否」 included) then queued behind both, and the Turn stayed
// `waiting_approval` until restart.

type StoredApproval = {
  id: string;
  taskId: string;
  turnId: string;
  callId: string;
  policyEpoch: number;
  challenge: string;
  challengeHash: string;
  revision: number;
  state: 'pending' | 'resolved' | 'canceled';
  decision: 'allow_once' | 'allow_task' | 'deny' | null;
};

class ApprovalStore {
  readonly approvals = new Map<string, StoredApproval>();

  requestApproval(raw: unknown): { approval: StoredApproval } {
    const input = raw as StoredApproval;
    const approval = { ...input, revision: 0, state: 'pending' as const, decision: null };
    this.approvals.set(approval.id, approval);
    return { approval };
  }

  getApproval(taskId: string, approvalId: string): StoredApproval | undefined {
    const approval = this.approvals.get(approvalId);
    return approval?.taskId === taskId ? approval : undefined;
  }

  resolveApproval(raw: unknown): { approval: StoredApproval } {
    const input = raw as { approvalId: string; decision: StoredApproval['decision'] };
    const current = this.approvals.get(input.approvalId);
    if (current === undefined || current.state !== 'pending') throw new Error('APPROVAL_STALE');
    const approval = {
      ...current,
      state: 'resolved' as const,
      decision: input.decision,
      revision: current.revision + 1,
    };
    this.approvals.set(approval.id, approval);
    return { approval };
  }

  cancelPendingApprovalForCall(raw: unknown): { approval: StoredApproval } | null {
    const input = raw as { approvalId: string };
    const current = this.approvals.get(input.approvalId);
    if (current === undefined || current.state !== 'pending') return null;
    const approval = { ...current, state: 'canceled' as const, revision: current.revision + 1 };
    this.approvals.set(approval.id, approval);
    return { approval };
  }

  /** What persistence does when the Turn is canceled: the pending cards are canceled with it. */
  cancelPendingForTurn(turnId: string): void {
    for (const approval of this.approvals.values())
      if (approval.turnId === turnId && approval.state === 'pending')
        this.approvals.set(approval.id, {
          ...approval,
          state: 'canceled',
          revision: approval.revision + 1,
        });
  }
}

class TurnStore {
  state: TurnStage | 'queued' | 'completed' | 'canceled' | 'failed' | 'interrupted' = 'queued';
  readonly events: TurnEvent[] = [];
  readonly steps: StepSnapshot[] = [];
  readonly stepStates = new Map<string, IntelligenceStepState[]>();
  private seq = 0;

  changeStage(taskId: string, turnId: string, stage: TurnStage): TurnEvent {
    this.state = stage;
    return this.record({ type: 'stage.changed', taskId, turnId, seq: ++this.seq, stage });
  }

  assistantMessageIdFor(): string | null {
    return null;
  }

  appendDelta(taskId: string, turnId: string, messageId: string, delta: string): TurnEvent {
    return this.record({
      type: 'message.delta',
      taskId,
      turnId,
      seq: ++this.seq,
      messageId,
      delta,
    });
  }

  completeTurn(
    taskId: string,
    turnId: string,
    state: 'completed' | 'canceled' | 'failed' | 'interrupted',
  ): TurnEvent {
    this.state = state;
    return this.record({
      type: 'turn.completed',
      taskId,
      turnId,
      seq: ++this.seq,
      state,
      diff: [],
    });
  }

  createIntelligenceStep(input: Omit<StepSnapshot, 'stepId' | 'ordinal' | 'createdAt'>) {
    const snapshot: StepSnapshot = {
      ...input,
      stepId: `step-${this.steps.length + 1}`,
      ordinal: this.steps.length + 1,
      createdAt: '2026-11-14T00:00:00.000Z',
    };
    this.steps.push(snapshot);
    this.stepStates.set(snapshot.stepId, []);
    return snapshot;
  }

  transitionIntelligenceStep(stepId: string, state: IntelligenceStepState): void {
    this.stepStates.get(stepId)?.push(state);
  }

  private record<T extends TurnEvent>(event: T): T {
    this.events.push(event);
    return event;
  }
}

function fixture() {
  const taskId = 'task-1260';
  const turnId = 'turn-1260';
  const mailbox = new TaskMailbox();
  const approvals = new ApprovalStore();
  const turns = new TurnStore();
  const turnActive = (): boolean =>
    !['completed', 'canceled', 'failed', 'interrupted'].includes(turns.state);
  const coordinator = new ApprovalCoordinator({
    persistence: approvals,
    now: () => new Date().toISOString(),
    expiresAt: () => new Date(Date.now() + 60_000).toISOString(),
    // The mock reads epoch 0 when persistence has no policy, as here; the same epoch stays current.
    getCurrentPolicyEpoch: () => 0,
    isTurnActive: (task, turn) => task === taskId && turn === turnId && turnActive(),
    evaluatePermission: () => 'approval_required',
    publish: () => undefined,
  });
  const executed: string[] = [];
  /** What the approval wait handed the tool call: never `allow` once the Turn is stopped. */
  const decisions: string[] = [];
  const authorize: ApprovalCoordinator['authorizeTool'] = async (request, control) => {
    try {
      const decision = await coordinator.authorizeTool(request, control);
      decisions.push(`${decision.decision}:${decision.reason}`);
      return decision;
    } catch (error) {
      decisions.push('aborted');
      throw error;
    }
  };
  const runtime = new MockRuntimeAdapter(
    turns,
    (event) => {
      if (event.type === 'message.delta') executed.push(event.delta);
    },
    1,
    (task, action) => mailbox.run(task, action),
    (task, turn, state) => turns.completeTurn(task, turn, state),
    undefined,
    authorize,
  );
  const pending = (): StoredApproval | undefined =>
    [...approvals.approvals.values()].find((approval) => approval.state === 'pending');
  /** The order of IPC's `turns.cancel`: end the Turn's cards, stop the runtime, cancel the Turn. */
  const stop = (endCardsFirst: boolean): Promise<void> =>
    mailbox.run(taskId, async () => {
      if (endCardsFirst) coordinator.turnEnded(taskId, turnId, 'canceled');
      await runtime.cancel(turnId);
      if (!endCardsFirst) coordinator.turnEnded(taskId, turnId, 'canceled');
      approvals.cancelPendingForTurn(turnId);
      turns.completeTurn(taskId, turnId, 'canceled');
    });
  /** IPC's `approvals.resolve`, which also runs in the Task mailbox. */
  const answer = (approval: StoredApproval, decision: 'allow_once' | 'deny'): Promise<void> =>
    mailbox.run(taskId, () => {
      coordinator.resolve({
        taskId,
        turnId,
        approvalId: approval.id,
        decision,
        expectedRevision: approval.revision,
        challenge: approval.challenge,
        operationId: `answer-${decision}`,
      });
    });
  return { taskId, turnId, runtime, turns, approvals, pending, stop, answer, executed, decisions };
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('Timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Settles with the promise, or with 'timeout' if it is still waiting after the deadline. */
function within<T>(promise: Promise<T>, ms = 1_000): Promise<T | 'timeout'> {
  return Promise.race([
    promise,
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), ms)),
  ]);
}

describe('stopping a mock Turn while it waits on an approval card (Issue #1260)', () => {
  for (const [name, endCardsFirst] of [
    ['turns.cancel (cards ended before the runtime stops)', true],
    ['stop for update / stop-and-send (the runtime stops first)', false],
  ] as const)
    it(`ends the Turn as canceled and never runs the tool: ${name}`, async () => {
      const t = fixture();
      t.runtime.start(t.taskId, t.turnId, '承認テスト');
      const card = await waitFor(t.pending);

      await expect(within(t.stop(endCardsFirst))).resolves.toBeUndefined();
      expect(t.turns.state).toBe('canceled');
      expect(t.approvals.approvals.get(card.id)?.state).toBe('canceled');
      expect(t.approvals.approvals.get(card.id)?.decision).toBeNull();

      // A late 「承認」 or 「拒否」 is refused without moving anything: nothing is recorded on the card,
      // the tool never runs, and no reply is streamed for the canceled Turn.
      const allow = await within(
        t.answer(card, 'allow_once').then(
          () => 'resolved',
          (error: Error) => error.message,
        ),
      );
      expect(allow).toBe('APPROVAL_TURN_STALE');
      const late = await within(t.answer(card, 'deny').catch((error: Error) => error.message));
      expect(late).toBe('APPROVAL_TURN_STALE');
      expect(t.approvals.approvals.get(card.id)).toMatchObject({
        state: 'canceled',
        decision: null,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      // The stop withdrew the wait without a decision: a refusal (cards ended first) or the abort.
      expect(t.decisions).toEqual([endCardsFirst ? 'deny:turn_canceled' : 'aborted']);
      expect(t.executed).toEqual([]);
      expect(t.turns.events.filter((event) => event.type === 'turn.completed')).toEqual([
        expect.objectContaining({ state: 'canceled' }),
      ]);
      await t.runtime.dispose();
    });
});
