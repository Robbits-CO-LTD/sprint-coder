// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Composer } from './Composer';
import { useAppStore } from '../../store/appStore';

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, 'sprintCoder');
});

it.each(['send', 'queue', 'interrupt'] as const)(
  'preserves indented message text on Composer %s',
  async (action) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const taskId = 'text-preservation';
    const text = '    担当を雇ってください。\n\nこの例文を添削してください。\n';
    const request = vi.fn().mockResolvedValue({ turnId: 'accepted' });
    Object.defineProperty(window, 'sprintCoder', {
      configurable: true,
      value: {
        tasks: { setDraft: vi.fn().mockResolvedValue(undefined) },
        turns: { start: request, queue: request, stopAndSend: request, cancel: vi.fn() },
      },
    });
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      selectedTaskId: taskId,
      permissionByTask: { [taskId]: { preset: 'ask', policyEpoch: 0 } },
      draftByTask: { [taskId]: text },
      turnByTask:
        action === 'send'
          ? {}
          : {
              [taskId]: {
                turnId: 'running',
                stage: 'executing',
                reachedStageIndex: 2,
                status: 'running',
                startedAt: 1,
                streamingMessageId: null,
                streamingContent: '',
                runtimeStarting: false,
              },
            },
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Composer taskId={taskId} />));
      const selector =
        action === 'interrupt'
          ? '[data-testid="composer-interrupt-button"]'
          : '[data-testid="composer-send-button"]';
      const button = container.querySelector<HTMLButtonElement>(selector);
      expect(button?.disabled).toBe(false);
      await act(async () => button?.click());
      expect(request).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ taskId, text }));
      if (action === 'send')
        expect(useAppStore.getState().messagesByTask[taskId]?.[0]?.content).toBe(text);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  },
);
