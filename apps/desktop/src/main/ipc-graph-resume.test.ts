import { describe, expect, it, vi } from 'vitest';
import {
  graphResumeActivationIntent,
  graphResumeStepActivationIntent,
  graphUpdateActivationIntent,
} from '../graph-activation-intent';

// `register()` binds one ipcMain listener directly, so importing the router needs an `electron`
// stub; every other channel goes through the router's own `handle`/`handleMutation`, which the
// suite below stubs out to capture handlers. The mock is file-wide, which is why this suite lives
// in its own file rather than inside ipc.test.ts.
vi.mock('electron', () => ({
  app: {},
  clipboard: {},
  dialog: {},
  ipcMain: { on: vi.fn() },
  MessageChannelMain: class {},
}));

import { IPC_CHANNELS } from '@sprint-coder/contracts';
import { IpcRouter } from './ipc';

describe('graph Mission step resume IPC', () => {
  const input = {
    taskId: 'task-1',
    instanceId: 'view-1',
    renderRevision: 3,
    missionId: 'mission-1',
    stepKey: 'a',
    generation: 2,
  };

  function harness(
    overrides: { semanticRevision?: number; generation?: number; graphId?: string } = {},
  ) {
    const router = Object.create(IpcRouter.prototype) as IpcRouter & Record<string, unknown>;
    const handlers = new Map<string, (input: unknown, event: unknown) => unknown>();
    const capture = (...args: unknown[]): void => {
      const channel = args[0];
      const handler = args[3];
      if (typeof channel !== 'string' || typeof handler !== 'function')
        throw new Error('Unexpected IPC handler registration');
      handlers.set(channel, handler as (input: unknown, event: unknown) => unknown);
    };
    const consume = vi.fn(() => null as { intent: string | null; token?: string } | null);
    const resumeGraphStep = vi.fn(async () => ({ id: input.missionId }));
    const requestGraphConstraintUpdate = vi.fn(
      async (_input: unknown, _token: unknown, validate: () => void) => {
        validate();
        return {};
      },
    );
    const agreeGraphConstraintUpdate = vi.fn(
      async (_input: unknown, _token: unknown, validate: () => void) => {
        validate();
        return {};
      },
    );
    Object.assign(router, {
      handle: capture,
      handleMutation: capture,
      window: { id: 1, webContents: { once: vi.fn() } },
      computerUseActivationGate: { consume, generation: vi.fn(() => 0) },
      computerUseController: { availability: vi.fn(() => null) },
      computerUseNative: { pickApplication: vi.fn() },
      computerUseStatusBySession: new Map(),
      computerUseApprovalSessionById: new Map(),
      computerUseQuickStartLatches: new Map(),
      graphs: {
        liveDocument: vi.fn(() => ({
          id: overrides.graphId ?? 'graph-1',
          semanticRevision: overrides.semanticRevision ?? 5,
        })),
        subscribeGeneration: vi.fn(() => () => undefined),
      },
      teamCoordinator: {
        hasBusyWorkers: vi.fn(() => false),
        resumeGraphStep,
        requestGraphConstraintUpdate,
        agreeGraphConstraintUpdate,
      },
      persistence: {
        getGraphTeamMission: vi.fn(() => ({
          taskId: input.taskId,
          graphId: 'graph-1',
          semanticRevision: 5,
          steps: [{ key: 'a', generation: overrides.generation ?? 2 }],
        })),
      },
    });
    router.register();
    const handler = handlers.get(IPC_CHANNELS.graphsMissionResumeStep);
    if (!handler) throw new Error('graph step resume channel is not registered');
    return {
      handler,
      handlers,
      consume,
      resumeGraphStep,
      requestGraphConstraintUpdate,
      agreeGraphConstraintUpdate,
    };
  }

  it('refuses a step resume that no trusted control activated', async () => {
    const { handler, consume, resumeGraphStep } = harness();
    await expect(handler(input, { sender: {} })).rejects.toThrow('計画の工程再開ボタン');
    expect(consume).toHaveBeenCalledWith({ sender: {} }, 'graph-resume-step');
    expect(resumeGraphStep).not.toHaveBeenCalled();
  });

  it('requires separate bound trusted gestures for requesting and agreeing a constraint update', async () => {
    const h = harness();
    const update = {
      taskId: input.taskId,
      instanceId: input.instanceId,
      renderRevision: 6,
      missionId: input.missionId,
      expectedSemanticRevision: 5,
    };
    const request = h.handlers.get(IPC_CHANNELS.graphsRequestUpdate)!;
    const agree = h.handlers.get(IPC_CHANNELS.graphsAgreeUpdate)!;
    await expect(request(update, {})).rejects.toThrow('確認ボタン');
    expect(h.requestGraphConstraintUpdate).not.toHaveBeenCalled();
    h.consume.mockReturnValue({
      token: 'request-token',
      intent: graphUpdateActivationIntent(update, 'request'),
    });
    await request(update, {});
    expect(h.requestGraphConstraintUpdate).toHaveBeenCalledWith(
      update,
      'request-token',
      expect.any(Function),
    );
    const agreement = { ...update, requestId: 'request-token', contextDigest: 'a'.repeat(64) };
    await expect(agree(agreement, {})).rejects.toThrow('再合意ボタン');
    h.consume.mockReturnValue({
      token: 'consent-token',
      intent: graphUpdateActivationIntent(agreement, 'agree'),
    });
    await expect(agree({ ...agreement, contextDigest: 'b'.repeat(64) }, {})).rejects.toThrow(
      '再合意ボタン',
    );
    await agree(agreement, {});
    expect(h.agreeGraphConstraintUpdate).toHaveBeenCalledWith(
      agreement,
      'consent-token',
      expect.any(Function),
    );
  });

  it('refuses an update gesture once the current Mission agreement no longer matches', async () => {
    const h = harness();
    const update = {
      taskId: input.taskId,
      instanceId: input.instanceId,
      renderRevision: 6,
      missionId: input.missionId,
      expectedSemanticRevision: 4,
    };
    h.consume.mockReturnValue({
      token: 'request-token',
      intent: graphUpdateActivationIntent(update, 'request'),
    });
    await expect(h.handlers.get(IPC_CHANNELS.graphsRequestUpdate)!(update, {})).rejects.toThrow(
      'agreement changed',
    );
  });

  it('refuses an activation bound to a different operation or a different step', async () => {
    const integration = harness();
    integration.consume.mockReturnValue({ intent: graphResumeActivationIntent(input) });
    await expect(integration.handler(input, {})).rejects.toThrow('計画の工程再開ボタン');
    expect(integration.resumeGraphStep).not.toHaveBeenCalled();
    const other = harness();
    other.consume.mockReturnValue({
      intent: graphResumeStepActivationIntent({ ...input, stepKey: 'b' }),
    });
    await expect(other.handler(input, {})).rejects.toThrow('計画の工程再開ボタン');
    expect(other.resumeGraphStep).not.toHaveBeenCalled();
  });

  it('refuses a resume once the agreed revision or generation moved on', async () => {
    const stale = harness({ semanticRevision: 6 });
    stale.consume.mockReturnValue({ intent: graphResumeStepActivationIntent(input) });
    await expect(stale.handler(input, {})).rejects.toThrow('Graph integration agreement changed');
    expect(stale.resumeGraphStep).not.toHaveBeenCalled();
    const regenerated = harness({ generation: 3 });
    regenerated.consume.mockReturnValue({ intent: graphResumeStepActivationIntent(input) });
    await expect(regenerated.handler(input, {})).rejects.toThrow(
      'Graph integration agreement changed',
    );
    expect(regenerated.resumeGraphStep).not.toHaveBeenCalled();
  });

  it('resumes exactly the agreed step for a matching trusted activation', async () => {
    const { handler, consume, resumeGraphStep } = harness();
    consume.mockReturnValue({ intent: graphResumeStepActivationIntent(input) });
    await expect(handler(input, {})).resolves.toEqual({ id: input.missionId });
    expect(resumeGraphStep).toHaveBeenCalledWith(
      input.taskId,
      input.missionId,
      input.stepKey,
      undefined,
    );
  });

  it('binds workspace continuation to the exact review digest in the trusted gesture', async () => {
    const { handler, consume, resumeGraphStep } = harness();
    const reviewed = { ...input, workspaceReviewDigest: 'a'.repeat(64) };
    consume.mockReturnValue({ intent: graphResumeStepActivationIntent(input) });
    await expect(handler(reviewed, {})).rejects.toThrow('計画の工程再開ボタン');
    consume.mockReturnValue({ intent: graphResumeStepActivationIntent(reviewed) });
    await handler(reviewed, {});
    expect(resumeGraphStep).toHaveBeenCalledWith(
      input.taskId,
      input.missionId,
      input.stepKey,
      reviewed.workspaceReviewDigest,
    );
  });
});
