// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { PermissionSettings } from '@sprint-coder/contracts';
import { Composer } from './Composer';
import { PERMISSION_CHANGE_PENDING_MESSAGE, useAppStore } from '../../store/appStore';
import { OPEN_PROVIDER_SETTINGS_EVENT } from '../../lib/settings-navigation';
import { GITHUB_ISSUE_INPUT_EXAMPLE } from '../../../github-issue-request';

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, 'sprintCoder');
});

it('keeps an unconnected draft editable, blocks sending and opens connection settings', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const start = vi.fn();
  const open = vi.fn();
  const taskId = 'unconnected';
  Object.defineProperty(window, 'sprintCoder', { configurable: true, value: { turns: { start } } });
  const initial = useAppStore.getInitialState();
  useAppStore.setState({
    ...initial,
    selectedTaskId: taskId,
    runtime: { ...initial.runtime, aiConnectionRequired: true },
    draftByTask: { [taskId]: '下書き' },
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  window.addEventListener(OPEN_PROVIDER_SETTINGS_EVENT, open);
  try {
    await act(async () => root.render(<Composer taskId={taskId} />));
    const notice = container.querySelector('.composer-ai-connection')!;
    expect(notice.textContent).toContain('AI がつながっていません');
    const send = container.querySelector<HTMLButtonElement>(
      '[data-testid="composer-send-button"]',
    )!;
    const textarea = container.querySelector('textarea')!;
    expect(send.disabled).toBe(true);
    expect(textarea.disabled).toBe(false);
    await act(async () => {
      send.click();
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      notice.querySelector('button')!.click();
    });
    expect(start).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledOnce();
    expect(textarea.value).toBe('下書き');
    await act(async () => useAppStore.setState({ runtime: initial.runtime }));
    expect(container.querySelector('.composer-ai-connection')).toBeNull();
    expect(send.disabled).toBe(false);
  } finally {
    window.removeEventListener(OPEN_PROVIDER_SETTINGS_EVENT, open);
    await act(async () => root.unmount());
    container.remove();
  }
});

it('offers the GitHub Issue example and accepts an explicit request without an AI connection', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const taskId = 'github-issue';
  const start = vi.fn().mockResolvedValue({ turnId: 'turn-issue' });
  Object.defineProperty(window, 'sprintCoder', {
    configurable: true,
    value: { tasks: {}, turns: { start } },
  });
  const initial = useAppStore.getInitialState();
  useAppStore.setState({
    ...initial,
    selectedTaskId: taskId,
    runtime: { ...initial.runtime, aiConnectionRequired: true },
    draftByTask: { [taskId]: 'GitHubにIssueを起票して' },
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Composer taskId={taskId} />));
    const hint = container.querySelector('.composer-ai-connection')!;
    await act(async () => hint.querySelector('button')!.click());
    expect(container.querySelector('textarea')?.value).toBe(GITHUB_ISSUE_INPUT_EXAMPLE);
    expect(start).not.toHaveBeenCalled();
    const text = GITHUB_ISSUE_INPUT_EXAMPLE.replace('<所有者>/<リポジトリ>', 'team/repo');
    await act(async () => useAppStore.setState({ draftByTask: { [taskId]: text } }));
    const send = container.querySelector<HTMLButtonElement>(
      '[data-testid="composer-send-button"]',
    )!;
    expect(send.disabled).toBe(false);
    await act(async () => send.click());
    expect(start).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text }));
  } finally {
    await act(async () => root.unmount());
    container.remove();
    useAppStore.setState(initial, true);
  }
});

it('shows confirmation pending with the actual preset, preserves input, blocks Enter, and restores controls on cancel', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const taskId = 'permission-ui';
  const permission = { preset: 'ask' as const, policyEpoch: 0 };
  let cancel!: (error: Error) => void;
  const setPermission = vi.fn(
    () =>
      new Promise<PermissionSettings>((_resolve, reject) => {
        cancel = reject;
      }),
  );
  const start = vi.fn();
  Object.defineProperty(window, 'sprintCoder', {
    configurable: true,
    value: {
      permissions: { set: setPermission, get: vi.fn().mockResolvedValue(permission) },
      turns: { start, queue: vi.fn(), stopAndSend: vi.fn(), cancel: vi.fn() },
    },
  });
  useAppStore.setState({
    ...useAppStore.getInitialState(),
    selectedTaskId: taskId,
    permissionByTask: { [taskId]: permission },
    draftByTask: { [taskId]: '下書き\n続き' },
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let changing: Promise<void> | undefined;
  try {
    await act(async () => root.render(<Composer taskId={taskId} />));
    await act(async () => {
      changing = useAppStore.getState().setAccessPreset(taskId, 'full');
    });
    const selector = container.querySelector<HTMLButtonElement>('[data-testid="access-selector"]')!;
    const send = container.querySelector<HTMLButtonElement>(
      '[data-testid="composer-send-button"]',
    )!;
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(selector.textContent).toBe('確認待ち');
    expect(selector.title).toContain('変更前の権限: 確認する');
    expect(selector.getAttribute('data-access-preset')).toBe('ask');
    expect(selector.getAttribute('aria-busy')).toBe('true');
    expect(selector.disabled).toBe(true);
    expect(send.disabled).toBe(true);
    expect(container.querySelector('.composer-permission-pending')?.textContent).toBe(
      PERMISSION_CHANGE_PENDING_MESSAGE,
    );
    expect(textarea.disabled).toBe(false);
    expect(textarea.value).toBe('下書き\n続き');
    await act(async () =>
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      ),
    );
    expect(start).not.toHaveBeenCalled();
    expect(useAppStore.getState().draftByTask[taskId]).toBe('下書き\n続き');
    for (const options of [{ shiftKey: true }, { isComposing: true }]) {
      const key = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
        ...options,
      });
      await act(async () => {
        textarea.dispatchEvent(key);
      });
      expect(key.defaultPrevented).toBe(false);
    }
    await act(async () => {
      cancel(Object.assign(new Error('cancelled'), { code: 'USER_CANCELED' }));
      await changing;
    });
    expect(selector.getAttribute('data-access-preset')).toBe('ask');
    expect(selector.textContent).toBe('確認する');
    expect(selector.disabled).toBe(false);
    expect(send.disabled).toBe(false);
    expect(container.querySelector('.composer-permission-pending')).toBeNull();

    await act(async () =>
      useAppStore.setState({
        permissionChangeByTask: { [taskId]: 'full' },
        draftByTask: { [taskId]: '' },
        turnByTask: {
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
      }),
    );
    expect(send.getAttribute('aria-label')).toBe('実行を停止');
    expect(send.disabled).toBe(false);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
