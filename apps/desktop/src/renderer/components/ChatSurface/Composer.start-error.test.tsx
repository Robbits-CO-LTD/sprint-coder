// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Composer } from './Composer';
import { useAppStore } from '../../store/appStore';

const initial = useAppStore.getInitialState();
const retiredMessage =
  '内蔵ローカルAI機能は廃止されました。モデルと接続から別のProviderを選択してください。';
let container: HTMLDivElement;
let root: Root;
let start: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useAppStore.setState(initial, true);
  useAppStore.setState({
    selectedTaskId: 'task-a',
    draftByTask: { 'task-a': '保持する依頼', 'task-b': '別の依頼' },
    error: '別の操作の古いエラー',
  });
  start = vi.fn();
  Object.defineProperty(window, 'sprintCoder', {
    configurable: true,
    value: { tasks: {}, turns: { start } },
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useAppStore.getState().dismissToast();
  useAppStore.setState(initial, true);
  Reflect.deleteProperty(window, 'sprintCoder');
  vi.unstubAllGlobals();
});

async function send() {
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="composer-send-button"]')!.click(),
  );
}

it('shows the rejected start reason, preserves the draft, and clears the alert on retry', async () => {
  start
    .mockRejectedValueOnce(new Error(retiredMessage))
    .mockResolvedValueOnce({ turnId: 'turn-retry' });
  await act(async () => root.render(<Composer taskId="task-a" />));
  expect(container.querySelector('[role="alert"]')).toBeNull();
  await send();
  expect(start).toHaveBeenCalledOnce();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(retiredMessage);
  expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('保持する依頼');
  expect(useAppStore.getState().messagesByTask['task-a']).toEqual([]);
  await send();
  expect(start).toHaveBeenCalledTimes(2);
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it('keeps a late failure from another Task from replacing the current request error', async () => {
  let rejectA!: (error: Error) => void;
  let rejectB!: (error: Error) => void;
  start.mockReturnValueOnce(
    new Promise((_resolve, reject) => {
      rejectA = reject;
    }),
  );
  start.mockReturnValueOnce(
    new Promise((_resolve, reject) => {
      rejectB = reject;
    }),
  );
  await act(async () => root.render(<Composer taskId="task-a" />));
  await send();
  await act(async () => {
    useAppStore.setState({ selectedTaskId: 'task-b' });
    root.render(<Composer taskId="task-b" />);
  });
  expect(container.querySelector('[role="alert"]')).toBeNull();
  await send();
  await act(async () => rejectB(new Error('現在のTaskの送信拒否')));
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('現在のTaskの送信拒否');
  await act(async () => rejectA(new Error(retiredMessage)));
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('現在のTaskの送信拒否');
  expect(useAppStore.getState().draftByTask['task-a']).toBe('保持する依頼');
});
