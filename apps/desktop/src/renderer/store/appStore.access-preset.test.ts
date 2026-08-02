import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from './appStore';

const taskId = 'task-access-preset';
const askPermission = { preset: 'ask' as const, policyEpoch: 0 };

beforeEach(() => {
  useAppStore.setState({ permissionByTask: { [taskId]: askPermission }, error: null });
});

afterEach(() => vi.unstubAllGlobals());

describe('access preset errors', () => {
  it('restores Ask without reporting an error when full access is deliberately canceled', async () => {
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
});
