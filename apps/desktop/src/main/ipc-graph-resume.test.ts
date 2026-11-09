import { describe, expect, it, vi } from 'vitest';

// Importing the router needs an `electron` stub; every channel goes through the router's own
// `handle`/`handleMutation`, which the suite below stubs out to capture handlers. The mock is
// file-wide, which is why this suite lives in its own file rather than inside ipc.test.ts.
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
    const resumeGraphStep = vi.fn(async () => ({ id: input.missionId }));
    const requestGraphConstraintUpdate = vi.fn(
      async (_input: unknown, _requestId: unknown, validate: () => void) => {
        validate();
        return {};
      },
    );
    const agreeGraphConstraintUpdate = vi.fn(
      async (_input: unknown, _consentId: unknown, validate: () => void) => {
        validate();
        return {};
      },
    );
    Object.assign(router, {
      handle: capture,
      handleMutation: capture,
      window: { id: 1, webContents: { once: vi.fn() } },
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
      resumeGraphStep,
      requestGraphConstraintUpdate,
      agreeGraphConstraintUpdate,
    };
  }

  it('gives requesting and agreeing a constraint update their own fresh ids', async () => {
    const h = harness();
    const update = {
      taskId: input.taskId,
      instanceId: input.instanceId,
      renderRevision: 6,
      missionId: input.missionId,
      expectedSemanticRevision: 5,
    };
    await h.handlers.get(IPC_CHANNELS.graphsRequestUpdate)!(update, {});
    expect(h.requestGraphConstraintUpdate).toHaveBeenCalledWith(
      update,
      expect.stringMatching(/^[0-9a-f-]{36}$/u),
      expect.any(Function),
    );
    const agreement = { ...update, requestId: 'request-1', contextDigest: 'a'.repeat(64) };
    await h.handlers.get(IPC_CHANNELS.graphsAgreeUpdate)!(agreement, {});
    expect(h.agreeGraphConstraintUpdate).toHaveBeenCalledWith(
      agreement,
      expect.stringMatching(/^[0-9a-f-]{36}$/u),
      expect.any(Function),
    );
    const [, requestId] = h.requestGraphConstraintUpdate.mock.calls[0]!;
    const [, consentId] = h.agreeGraphConstraintUpdate.mock.calls[0]!;
    expect(consentId).not.toBe(requestId);
  });

  it('refuses an update once the current Mission agreement no longer matches', async () => {
    const h = harness();
    const update = {
      taskId: input.taskId,
      instanceId: input.instanceId,
      renderRevision: 6,
      missionId: input.missionId,
      expectedSemanticRevision: 4,
    };
    await expect(h.handlers.get(IPC_CHANNELS.graphsRequestUpdate)!(update, {})).rejects.toThrow(
      'agreement changed',
    );
  });

  it('refuses a resume once the agreed revision or generation moved on', async () => {
    const stale = harness({ semanticRevision: 6 });
    await expect(stale.handler(input, {})).rejects.toThrow('Graph integration agreement changed');
    expect(stale.resumeGraphStep).not.toHaveBeenCalled();
    const regenerated = harness({ generation: 3 });
    await expect(regenerated.handler(input, {})).rejects.toThrow(
      'Graph integration agreement changed',
    );
    expect(regenerated.resumeGraphStep).not.toHaveBeenCalled();
  });

  it('resumes exactly the agreed step', async () => {
    const { handler, resumeGraphStep } = harness();
    await expect(handler(input, {})).resolves.toEqual({ id: input.missionId });
    expect(resumeGraphStep).toHaveBeenCalledWith(
      input.taskId,
      input.missionId,
      input.stepKey,
      undefined,
    );
  });

  it('passes the workspace review digest through to the step resume', async () => {
    const { handler, resumeGraphStep } = harness();
    const reviewed = { ...input, workspaceReviewDigest: 'a'.repeat(64) };
    await handler(reviewed, {});
    expect(resumeGraphStep).toHaveBeenCalledWith(
      input.taskId,
      input.missionId,
      input.stepKey,
      reviewed.workspaceReviewDigest,
    );
  });
});
