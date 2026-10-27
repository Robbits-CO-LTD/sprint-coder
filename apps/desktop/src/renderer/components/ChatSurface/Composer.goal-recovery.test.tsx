// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Composer } from './Composer';
import { useAppStore } from '../../store/appStore';

const original = '    initial goal\n';
let root: Root;
let container: HTMLDivElement;
let rejectGoal: (error: Error) => void;
let resolveGoal: (result: unknown) => void;
let start: ReturnType<typeof vi.fn>;
let persist: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(0), 0),
  );
  const pending = new Promise((resolve, reject) => {
    resolveGoal = resolve;
    rejectGoal = reject;
  });
  start = vi.fn().mockReturnValue(pending);
  persist = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window, 'sprintCoder', {
    configurable: true,
    value: {
      tasks: { setDraft: persist },
      goals: { start },
    },
  });
  useAppStore.setState(
    {
      ...useAppStore.getInitialState(),
      selectedTaskId: 'task-a',
      draftByTask: { 'task-a': '/goal' },
    },
    true,
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Composer key="task-a" taskId="task-a" />));
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="slash-command-goal"]')!.click(),
  );
  await edit(original);
});

afterEach(async () => {
  await act(async () => root.unmount());
  await vi.runOnlyPendingTimersAsync();
  container.remove();
  useAppStore.setState(useAppStore.getInitialState(), true);
  Reflect.deleteProperty(window, 'sprintCoder');
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function edit(text: string) {
  await act(async () => useAppStore.getState().setDraft('task-a', text));
}
async function send() {
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="composer-send-button"]')!.click(),
  );
  expect(start).toHaveBeenCalledTimes(1);
  expect(container.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(false);
}
async function switchTo(taskId: string) {
  await act(async () => {
    useAppStore.setState({ selectedTaskId: taskId });
    root.render(<Composer key={taskId} taskId={taskId} />);
  });
}
async function fail() {
  await act(async () => rejectGoal(new Error('goal start rejected')));
  await act(async () => vi.advanceTimersByTimeAsync(400));
}

it.each(['new draft', '', original])(
  'preserves a later edit including intentional empty/same text: %j',
  async (newer) => {
    await send();
    await edit('new input before final edit');
    await edit(newer);
    await fail();
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(newer);
    expect(persist).toHaveBeenLastCalledWith('task-a', newer);
    expect(container.querySelector('[data-testid="composer-goal-armed"]')).toBeNull();
  },
);

it('restores an unedited failed Goal and its mode without starting another request', async () => {
  await send();
  await fail();
  expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(original);
  expect(persist).toHaveBeenLastCalledWith('task-a', original);
  expect(container.querySelector('[data-testid="composer-goal-armed"]')).not.toBeNull();
  expect(start).toHaveBeenCalledTimes(1);
});

it('recovers an unedited source Task after unmount and offers explicit Goal retry on return', async () => {
  await send();
  await switchTo('task-b');
  await fail();
  expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('');
  expect(persist).toHaveBeenLastCalledWith('task-a', original);
  await switchTo('task-a');
  expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(original);
  const retry = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Goalとして再試行',
  );
  expect(retry).toBeDefined();
  await act(async () => retry!.click());
  expect(container.querySelector('[data-testid="composer-goal-armed"]')).not.toBeNull();
  expect(start).toHaveBeenCalledTimes(1);
});

it('keeps a newer draft after Task A to B to A and a late failure', async () => {
  await send();
  await switchTo('task-b');
  await switchTo('task-a');
  await edit('returned draft');
  await fail();
  expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('returned draft');
  expect(persist).toHaveBeenLastCalledWith('task-a', 'returned draft');
});

it('does not restore the consumed Goal after success', async () => {
  await send();
  await act(async () => resolveGoal({ task: { id: 'task-a' } }));
  await act(async () => vi.advanceTimersByTimeAsync(400));
  expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('');
  expect(persist).toHaveBeenLastCalledWith('task-a', '');
  expect(container.querySelector('[data-testid="composer-goal-armed"]')).toBeNull();
});

it('admits only one Goal start before the disabled state commits', async () => {
  const button = container.querySelector<HTMLButtonElement>(
    '[data-testid="composer-send-button"]',
  )!;
  await act(async () => {
    button.click();
    button.click();
  });
  expect(start).toHaveBeenCalledTimes(1);
  await fail();
});

it('keeps an explicitly selected image mode when the old Goal fails', async () => {
  await act(async () =>
    useAppStore.setState({
      runtime: { ...useAppStore.getState().runtime, kind: 'codex', codexReadiness: 'ready' },
    }),
  );
  await send();
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="composer-plus"]')!.click(),
  );
  const image = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (button) => button.textContent?.includes('画像を生成'),
  );
  expect(image).toBeDefined();
  await act(async () => image!.click());
  await fail();
  expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('');
  expect(container.querySelector('[data-testid="composer-imagegen-armed"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="composer-goal-armed"]')).toBeNull();
  expect(persist).toHaveBeenLastCalledWith('task-a', '');
});

it('dismisses recovered Goal intent on an explicit cancel or same-text edit', async () => {
  await send();
  await fail();
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="composer-goal-armed"]')!.click(),
  );
  expect(container.textContent).not.toContain('Goalとして再試行');
  expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(original);
  await switchTo('task-b');
  await switchTo('task-a');
  expect(container.textContent).not.toContain('Goalとして再試行');
});
