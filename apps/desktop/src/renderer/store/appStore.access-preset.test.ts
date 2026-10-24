import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionSettings, TurnSkillSelection } from '@sprint-coder/contracts';
import { PERMISSION_CHANGE_PENDING_MESSAGE, useAppStore } from './appStore';

const taskId = 'task-access-preset';
const askPermission = { preset: 'ask' as const, policyEpoch: 0 };

beforeEach(() => {
  vi.useFakeTimers();
  useAppStore.setState({
    permissionByTask: { [taskId]: askPermission },
    permissionChangeByTask: {},
    error: null,
    toast: null,
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('access preset errors', () => {
  it('restores Ask without an error when inherited full access is canceled for a new Task', async () => {
    const cancellation = Object.assign(new Error('フルアクセスへの変更をキャンセルしました。'), {
      code: 'USER_CANCELED',
    });
    vi.stubGlobal('window', {
      sprintCoder: {
        permissions: {
          set: vi.fn().mockRejectedValue(cancellation),
          get: vi.fn().mockResolvedValue(askPermission),
        },
      },
    });

    await useAppStore.getState().setAccessPreset(taskId, 'full');

    expect(useAppStore.getState().permissionByTask[taskId]).toEqual(askPermission);
    expect(useAppStore.getState().error).toBeNull();
  });

  it('still reports genuine permission failures', async () => {
    const failure = Object.assign(new Error('この操作は許可されていません。'), {
      code: 'FORBIDDEN',
    });
    vi.stubGlobal('window', {
      sprintCoder: {
        permissions: {
          set: vi.fn().mockRejectedValue(failure),
          get: vi.fn().mockResolvedValue(askPermission),
        },
      },
    });

    await useAppStore.getState().setAccessPreset(taskId, 'full');

    expect(useAppStore.getState().permissionByTask[taskId]).toEqual(askPermission);
    expect(useAppStore.getState().error).toBe('この操作は許可されていません。');
  });
  it('keeps the committed restriction and displays a cleanup failure', async () => {
    useAppStore.setState({ permissionByTask: { [taskId]: { preset: 'full', policyEpoch: 2 } } });
    const committed = { preset: 'ask', policyEpoch: 3 };
    vi.stubGlobal('window', {
      sprintCoder: {
        permissions: {
          set: vi
            .fn()
            .mockRejectedValue(
              new Error('権限の変更は保存されましたが、実行中コマンドの停止を確認できません。'),
            ),
          get: vi.fn().mockResolvedValue(committed),
        },
      },
    });
    await useAppStore.getState().setAccessPreset(taskId, 'ask');
    expect(useAppStore.getState().permissionByTask[taskId]).toEqual(committed);
    expect(useAppStore.getState().error).toContain('停止を確認できません');
  });
});

describe('pending permission changes', () => {
  function deferredPermission() {
    let resolve!: (permission: PermissionSettings) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<PermissionSettings>((accept, decline) => {
      resolve = accept;
      reject = decline;
    });
    const set = vi.fn(() => promise);
    vi.stubGlobal('window', {
      localStorage: null,
      sprintCoder: { permissions: { set, get: vi.fn().mockResolvedValue(askPermission) } },
    });
    return { resolve, reject, set };
  }

  it('keeps the confirmed preset while awaiting approval and ignores duplicate changes', async () => {
    const f = deferredPermission();
    const first = useAppStore.getState().setAccessPreset(taskId, 'full');
    await useAppStore.getState().setAccessPreset(taskId, 'auto');
    expect(useAppStore.getState().permissionByTask[taskId]).toEqual(askPermission);
    expect(useAppStore.getState().permissionChangeByTask[taskId]).toBe('full');
    expect(f.set).toHaveBeenCalledOnce();
    useAppStore.setState({
      selectedTaskId: 'another-task',
      permissionByTask: {
        [taskId]: askPermission,
        'another-task': { preset: 'auto', policyEpoch: 3 },
      },
    });
    f.resolve({ preset: 'full', policyEpoch: 1 });
    await first;
    expect(useAppStore.getState().permissionByTask[taskId]).toEqual({
      preset: 'full',
      policyEpoch: 1,
    });
    expect(useAppStore.getState().permissionByTask['another-task']).toEqual({
      preset: 'auto',
      policyEpoch: 3,
    });
    expect(useAppStore.getState().permissionChangeByTask[taskId]).toBeUndefined();
  });

  it.each(['USER_CANCELED', 'INTERNAL_ERROR'])(
    'clears pending after cancellation/timeout or error (%s)',
    async (code) => {
      const f = deferredPermission();
      const changing = useAppStore.getState().setAccessPreset(taskId, 'full');
      f.reject(Object.assign(new Error('確認を終了しました'), { code }));
      await changing;
      expect(useAppStore.getState().permissionByTask[taskId]).toEqual(askPermission);
      expect(useAppStore.getState().permissionChangeByTask[taskId]).toBeUndefined();
      expect(useAppStore.getState().error).toBe(
        code === 'USER_CANCELED' ? null : '確認を終了しました',
      );
    },
  );

  it('does not overwrite a newer confirmed policy with a delayed answer', async () => {
    const f = deferredPermission();
    const changing = useAppStore.getState().setAccessPreset(taskId, 'full');
    const newer = { preset: 'ask' as const, policyEpoch: 2 };
    useAppStore.setState({ permissionByTask: { [taskId]: newer } });
    f.resolve({ preset: 'full', policyEpoch: 1 });
    await changing;
    expect(useAppStore.getState().permissionByTask[taskId]).toEqual(newer);
    expect(useAppStore.getState().permissionChangeByTask[taskId]).toBeUndefined();
  });

  it('blocks every submission before altering draft, skills, attachments, optimistic messages or turn state', async () => {
    const submit = vi.fn();
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout,
      sprintCoder: {
        turns: { start: submit, queue: submit, steer: submit, stopAndSend: submit },
        goals: { start: submit, resume: submit },
      },
    });
    const skill: TurnSkillSelection = {
      kind: 'chat',
      ref: { source: 'created', skillId: 'example', digest: 'a'.repeat(64) },
    };
    const attachment = {
      id: 'image-1',
      fileName: 'sample.png',
      mimeType: 'image/png' as const,
      byteLength: 1,
      createdAt: '2026-10-23T00:00:00Z',
    };
    useAppStore.setState({
      permissionChangeByTask: { [taskId]: 'full' },
      draftByTask: { [taskId]: '下書き' },
      skillSelectionByTask: { [taskId]: [skill] },
      draftAttachmentsByTask: { [taskId]: [attachment] },
      messagesByTask: { [taskId]: [] },
      sendingByTask: { [taskId]: false },
      turnByTask: {},
    });
    const store = useAppStore.getState();
    await store.startTurn(taskId, '下書き', undefined, [attachment.id]);
    expect(await store.queueMessage(taskId, '下書き')).toBe(false);
    await store.steerMessage(taskId, '下書き', 'turn-1');
    expect(await store.stopAndSend(taskId, '下書き')).toEqual({
      completed: false,
      draftRestored: false,
    });
    expect(await store.startGoal(taskId, '下書き')).toBe(false);
    await store.resumeGoal(taskId);
    expect(submit).not.toHaveBeenCalled();
    expect(useAppStore.getState()).toMatchObject({
      draftByTask: { [taskId]: '下書き' },
      skillSelectionByTask: { [taskId]: [skill] },
      draftAttachmentsByTask: { [taskId]: [attachment] },
      messagesByTask: { [taskId]: [] },
      sendingByTask: { [taskId]: false },
      turnByTask: {},
      toast: { message: PERMISSION_CHANGE_PENDING_MESSAGE },
    });
  });

  it('restores optimistic send state when Main still has a pending confirmation after a renderer reload', async () => {
    const blocked = Object.assign(new Error(PERMISSION_CHANGE_PENDING_MESSAGE), {
      code: 'OPERATION_IN_PROGRESS',
    });
    vi.stubGlobal('window', {
      sprintCoder: {
        turns: { start: vi.fn().mockRejectedValue(blocked) },
        tasks: { setDraft: vi.fn().mockResolvedValue(undefined) },
      },
    });
    useAppStore.setState({
      permissionChangeByTask: {},
      draftByTask: { [taskId]: '下書き' },
      skillSelectionByTask: {},
      draftAttachmentsByTask: {},
      messagesByTask: { [taskId]: [] },
      turnByTask: {},
      pendingOptimisticIdByTask: {},
    });
    await useAppStore.getState().startTurn(taskId, '下書き');
    expect(useAppStore.getState().messagesByTask[taskId]).toEqual([]);
    expect(useAppStore.getState().draftByTask[taskId]).toBe('下書き');
    expect(useAppStore.getState().sendingByTask[taskId]).toBe(false);
    expect(useAppStore.getState().error).toBe(PERMISSION_CHANGE_PENDING_MESSAGE);
  });
});
