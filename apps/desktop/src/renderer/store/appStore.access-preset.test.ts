import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from './appStore';

const taskId = 'task-access-preset';
const askPermission = { preset: 'ask' as const, policyEpoch: 0 };

beforeEach(() => {
  useAppStore.setState({ permissionByTask: { [taskId]: askPermission }, error: null });
});

afterEach(() => vi.unstubAllGlobals());

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
