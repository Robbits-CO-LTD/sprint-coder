// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  computerAppGrantRequestSchema,
  type ComputerAppGrantRequest,
} from '@sprint-coder/contracts';
import { appGrantActivationIntent } from '../../computer-use-activation-intent';
import { useComputerUseAppGrant } from './useComputerUseAppGrant';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The card is live Main state, not a stored approval, so what matters here is that the Renderer
 * follows Main rather than deciding anything: it shows the card Main published, stops showing it
 * when Main withdraws it, drops it when the user leaves the conversation it belongs to, and never
 * invents an outcome when a click fails.
 */

function card(overrides: Partial<ComputerAppGrantRequest> = {}): ComputerAppGrantRequest {
  return computerAppGrantRequestSchema.parse({
    id: 'request-1',
    taskId: 'task-1',
    kind: 'app-grant',
    state: 'pending',
    revision: 1,
    decision: null,
    noticeCode: null,
    verified: {
      platform: 'darwin',
      identityKind: 'verified-signed',
      publisher: 'TEAMID1234',
      appId: 'com.example.notes',
      maxMode: 'full_access_app',
    },
    untrustedAppName: 'Notes',
    untrustedReason: 'copy the table',
    providerEgressModelId: 'vision-model',
    allowedDecisions: ['allow_once', 'allow_always', 'deny'],
    activationIntents: {
      allow_once: appGrantActivationIntent({
        requestId: 'request-1',
        expectedRevision: 1,
        decision: 'allow_once',
        identityDigest: 'a'.repeat(64),
      }),
      allow_always: appGrantActivationIntent({
        requestId: 'request-1',
        expectedRevision: 1,
        decision: 'allow_always',
        identityDigest: 'a'.repeat(64),
      }),
    },
    expiresAt: '2026-09-21T00:02:00.000Z',
    ...overrides,
  });
}

type Feature = ReturnType<typeof useComputerUseAppGrant>;

function mount(taskId: string): {
  latest: () => Feature;
  setTaskId: (next: string) => void;
  unmount: () => void;
} {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let latest: Feature | null = null;
  let setTaskId: ((next: string) => void) | null = null;
  function Probe({ initialTaskId }: { initialTaskId: string }) {
    const [current, setCurrent] = useState(initialTaskId);
    setTaskId = setCurrent;
    latest = useComputerUseAppGrant(current);
    return null;
  }
  act(() => {
    root.render(<Probe initialTaskId={taskId} />);
  });
  return {
    latest: () => latest!,
    setTaskId: (next) => act(() => setTaskId!(next)),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function installApi(): {
  publish: (request: ComputerAppGrantRequest) => void;
  resolveGrantRequest: ReturnType<typeof vi.fn>;
} {
  const listeners = new Set<(request: ComputerAppGrantRequest) => void>();
  const resolveGrantRequest = vi.fn(async () => undefined);
  (globalThis as { window?: unknown }).window = window;
  (window as unknown as { sprintCoder: unknown }).sprintCoder = {
    computerUse: {
      subscribeGrantRequests: (listener: (request: ComputerAppGrantRequest) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      resolveGrantRequest,
    },
  };
  return {
    publish: (request) => {
      act(() => {
        for (const listener of listeners) listener(request);
      });
    },
    resolveGrantRequest,
  };
}

afterEach(() => {
  delete (window as unknown as { sprintCoder?: unknown }).sprintCoder;
});

describe('useComputerUseAppGrant', () => {
  it('shows the card Main published and answers it with the revision it showed', async () => {
    const api = installApi();
    const view = mount('task-1');
    expect(view.latest().request).toBeNull();

    api.publish(card());
    expect(view.latest().request?.id).toBe('request-1');
    expect(view.latest().busy).toBe(false);

    act(() => view.latest().resolve('allow_once'));
    expect(api.resolveGrantRequest).toHaveBeenCalledWith({
      requestId: 'request-1',
      expectedRevision: 1,
      decision: 'allow_once',
    });
    expect(view.latest().busy).toBe(true);

    // Main's answer is what clears the card, not the click.
    api.publish(card({ state: 'resolved', revision: 2, decision: 'allow_once' }));
    expect(view.latest().request).toBeNull();
    expect(view.latest().busy).toBe(false);
    view.unmount();
  });

  it('keeps a withdrawn card only long enough to say why', () => {
    const api = installApi();
    const view = mount('task-1');
    api.publish(card());
    api.publish(card({ state: 'canceled', revision: 2, noticeCode: 'identity_changed' }));
    expect(view.latest().request).toMatchObject({
      state: 'canceled',
      noticeCode: 'identity_changed',
    });
    view.unmount();
  });

  it('ignores a state that arrives out of order', () => {
    const api = installApi();
    const view = mount('task-1');
    api.publish(card({ revision: 3 }));
    // An earlier revision must not put the buttons back on a card that has moved on.
    api.publish(card({ revision: 2 }));
    expect(view.latest().request?.revision).toBe(3);
    view.unmount();
  });

  it('drops the card when the user moves to another conversation', () => {
    const api = installApi();
    const view = mount('task-1');
    api.publish(card());
    expect(view.latest().request).not.toBeNull();
    view.setTaskId('task-2');
    expect(view.latest().request).toBeNull();
    // A card raised in the other Task is shown there.
    api.publish(card({ id: 'request-2', taskId: 'task-2' }));
    expect(view.latest().request?.id).toBe('request-2');
    view.unmount();
  });

  it('invents no outcome when the click is refused', async () => {
    const api = installApi();
    api.resolveGrantRequest.mockRejectedValueOnce(new Error('stale'));
    const view = mount('task-1');
    api.publish(card());
    await act(async () => {
      view.latest().resolve('allow_always');
      await Promise.resolve();
    });
    // Still on screen, still answerable: the card is whatever Main last said it was.
    expect(view.latest().request?.state).toBe('pending');
    expect(view.latest().busy).toBe(false);
    view.unmount();
  });

  it('does nothing at all when the Computer Use API is absent', () => {
    const view = mount('task-1');
    expect(view.latest().request).toBeNull();
    act(() => view.latest().resolve('deny'));
    view.unmount();
  });
});
