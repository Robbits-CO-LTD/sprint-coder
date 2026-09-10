// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CommandCard } from './CommandCard';
import type { CommandCardState } from '../store/appStore';

afterEach(() => vi.unstubAllGlobals());

it('stops the owning execution after the answer finishes and permits retry after an error', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const cancel = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
  Object.defineProperty(window, 'sprintCoder', {
    configurable: true,
    value: { turns: { cancel } },
  });
  const card: CommandCardState = {
    command: {
      id: 'command-1',
      taskId: 'task-1',
      turnId: 'finished-turn',
      callId: 'call-1',
      specDigest: 'digest',
      executable: 'node',
      argv: ['hold.cjs'],
      cwd: '/workspace',
      envDelta: {},
      purpose: 'Stop test',
      risk: 'high',
      state: 'running',
      pid: 123,
      exitCode: null,
      signal: null,
      outputBytes: 0,
      truncated: false,
      createdAt: '2026-09-10T00:00:00.000Z',
      startedAt: '2026-09-10T00:00:00.000Z',
      finishedAt: null,
    },
    tail: { lines: [], lastOutputSeq: 0 },
  };
  const container = document.createElement('div');
  const root = createRoot(container);
  const stop = () =>
    [...container.querySelectorAll('button')].find((b) => b.textContent === 'この実行を停止');
  try {
    await act(async () => root.render(<CommandCard taskId="task-1" card={card} />));
    expect(stop()).toBeDefined();
    await act(async () => stop()?.click());
    expect(cancel).toHaveBeenCalledWith({
      taskId: 'task-1',
      turnId: 'finished-turn',
      startNextQueued: false,
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      '停止を確認できませんでした',
    );
    await act(async () => stop()?.click());
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    // Completion comes from the real command event, not an optimistic button update.
    expect(stop()).toBeDefined();
    await act(async () =>
      root.render(
        <CommandCard
          taskId="task-1"
          card={{ ...card, command: { ...card.command, state: 'failed' } }}
        />,
      ),
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('アプリを再起動');
    await act(async () =>
      root.render(
        <CommandCard
          taskId="task-1"
          card={{ ...card, command: { ...card.command, state: 'canceled' } }}
        />,
      ),
    );
    expect(stop()).toBeUndefined();
  } finally {
    await act(async () => root.unmount());
    Reflect.deleteProperty(window, 'sprintCoder');
  }
});
