import { describe, expect, it, vi } from 'vitest';
import { ManagedCodingHarness, providerToolsFromSnapshot } from './provider-workspace-tools';
import { GRAPH_TOOLS, createGraphToolBoundary } from './graph-tools';

const context = { taskId: 'task-a', turnId: 'turn-a', workspaceId: null, policyEpoch: 1 };
const input = {
  sources: [],
  expectedRenderRevision: 0,
  diagram: {
    schema_version: 1,
    diagram_type: 'architecture',
    meta: { title: 'Draft' },
    components: [{ id: 'api', type: 'backend', label: 'API', pos: [40, 40] }],
  },
};

describe('Task graph tools in the managed harness', () => {
  it('cancels only the owning Turn and passes through the update-install mutation gate', async () => {
    let signal: AbortSignal | undefined;
    const render = vi.fn(async (_raw: unknown, options?: { signal?: AbortSignal }) => {
      signal = options?.signal;
      return new Promise<never>((_resolve, reject) =>
        signal!.addEventListener('abort', () => reject(new Error('stopped')), { once: true }),
      );
    });
    const publish = vi.fn();
    const service = { render, document: () => null, generation: () => null };
    const boundary = createGraphToolBoundary(service, publish, (action) => action());
    expect(() => boundary.read({ renderRevision: 1 }, context)).toThrow('not found');
    const pending = boundary
      .propose(input, context, { callId: 'active' })
      .catch((error: unknown) => error);
    boundary.finishTurn!('other-task', context.turnId);
    expect(signal?.aborted).toBe(false);
    boundary.finishTurn!(context.taskId, context.turnId);
    expect(signal?.aborted).toBe(true);
    expect(await pending).toBeInstanceOf(Error);
    expect(publish).not.toHaveBeenCalled();
    const revoked = boundary
      .propose(input, { ...context, turnId: 'turn-policy' }, { callId: 'policy' })
      .catch((error: unknown) => error);
    boundary.policyEpochChanged!('other-task');
    expect(signal?.aborted).toBe(false);
    boundary.policyEpochChanged!(context.taskId);
    expect(signal?.aborted).toBe(true);
    expect(await revoked).toBeInstanceOf(Error);
    render.mockClear();
    const closed = createGraphToolBoundary(service, publish, async () => {
      throw new Error('installing');
    });
    await expect(closed.propose(input, context, { callId: 'blocked' })).rejects.toThrow(
      'installing',
    );
    expect(render).not.toHaveBeenCalled();
  });
  it.each(['codex', 'claude', 'ollama'])(
    'publishes shared schemas for %s and binds calls to the Turn',
    async (provider) => {
      const read = vi.fn(async () => ({ document: null, phase: 'draft' }));
      const propose = vi.fn(async () => ({
        graphId: 'graph-a',
        phase: 'draft',
        executionStarted: false,
      }));
      const harness = new ManagedCodingHarness({
        workspaceFor: () => null,
        rootIdentityFor: () => undefined,
        policyEpochFor: () => 1,
        authorizer: () => ({ decision: 'allow', reason: 'test' }),
        graphs: { read, propose },
      });
      const snapshot = harness.startTurn(context, provider);
      const offered = providerToolsFromSnapshot(snapshot).filter((tool) =>
        tool.name.startsWith('graph_'),
      );
      expect(offered.map((tool) => tool.name).sort()).toEqual(
        GRAPH_TOOLS.map((tool) => tool.providerName).sort(),
      );
      for (const tool of offered)
        expect(tool.inputSchema).toEqual(
          GRAPH_TOOLS.find((entry) => entry.providerName === tool.name)!.inputSchema,
        );
      await expect(
        harness.broker.dispatch({
          ...context,
          callId: 'read',
          providerName: 'graph_read_document',
          input: {},
        }),
      ).resolves.toMatchObject({ document: null });
      const controller = new AbortController();
      await expect(
        harness.broker.dispatch({
          ...context,
          callId: 'propose',
          providerName: 'graph_propose_document',
          input,
          signal: controller.signal,
        }),
      ).resolves.toMatchObject({ phase: 'draft', executionStarted: false });
      expect(propose).toHaveBeenCalledWith(
        input,
        context,
        expect.objectContaining({ callId: 'propose', signal: controller.signal }),
        [],
      );
      await expect(
        harness.broker.dispatch({
          ...context,
          callId: 'forged',
          providerName: 'graph_propose_document',
          input: { ...input, taskId: 'victim', actorId: 'leader', approved: true },
        }),
      ).rejects.toThrow();
      expect(propose).toHaveBeenCalledTimes(1);
      harness.finishTurn(context.taskId, context.turnId);
      await expect(
        harness.broker.dispatch({
          ...context,
          callId: 'expired',
          providerName: 'graph_read_document',
          input: {},
        }),
      ).rejects.toThrow();
      await harness.broker.dispose();
    },
  );

  it('requires a bound graph service and respects authorization denial', async () => {
    const deps = {
      workspaceFor: () => null,
      rootIdentityFor: () => undefined,
      policyEpochFor: () => 1,
      authorizer: () => ({ decision: 'deny' as const, reason: 'test-denial' }),
    };
    const absent = new ManagedCodingHarness(deps);
    expect(
      absent
        .startTurn(context, 'codex')
        .entries.some((entry) => entry.providerName.startsWith('graph_')),
    ).toBe(false);
    const propose = vi.fn(async () => ({}));
    const bound = new ManagedCodingHarness({ ...deps, graphs: { read: () => ({}), propose } });
    bound.startTurn(context, 'codex');
    await expect(
      bound.broker.dispatch({
        ...context,
        callId: 'denied',
        providerName: 'graph_propose_document',
        input,
      }),
    ).rejects.toThrow('test-denial');
    expect(propose).not.toHaveBeenCalled();
    await absent.broker.dispose();
    await bound.broker.dispose();
  });
});
