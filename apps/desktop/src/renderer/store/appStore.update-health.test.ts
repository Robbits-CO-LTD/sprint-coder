import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UpdateHealth } from '../types/sprint-coder';
import { useAppStore } from './appStore';

describe('update health notification', () => {
  it('replaces the runtime status subscription when init runs again', async () => {
    const unsubscribe = vi.fn();
    const subscribeStatus = vi.fn(() => unsubscribe);
    vi.stubGlobal('window', {
      sprintCoder: {
        tasks: { list: async () => [], subscribe: () => () => undefined },
        projects: { list: async () => [] },
        runtime: { subscribeStatus },
      },
    });
    await useAppStore.getState().init();
    await useAppStore.getState().init();
    expect(subscribeStatus).toHaveBeenCalledTimes(2);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    useAppStore.setState({ updateHealth: null, toast: null });
  });

  it('warns on the first failure, escalates at three, and clears after success', async () => {
    let publish!: (health: UpdateHealth) => void;
    vi.stubGlobal('window', {
      setTimeout,
      sprintCoder: {
        tasks: { list: async () => [], subscribe: () => () => undefined },
        projects: { list: async () => [] },
        updates: {
          subscribeHealth: (listener: (health: UpdateHealth) => void) => {
            publish = listener;
            return () => undefined;
          },
        },
      },
    });
    await useAppStore.getState().init();
    const health = (consecutiveFailures: number, failedChecks: number): UpdateHealth => ({
      successfulChecks: 0,
      failedChecks,
      consecutiveFailures,
      lastSuccessAt: null,
      lastFailureAt: '2026-08-12T01:00:00.000Z',
      lastErrorCategory: consecutiveFailures === 0 ? null : 'decryption',
    });

    publish(health(1, 1));
    expect(useAppStore.getState().toast?.message).toContain('自動更新に失敗');
    publish(health(3, 3));
    expect(useAppStore.getState().toast?.message).toContain('3回以上');
    publish({
      ...health(0, 3),
      successfulChecks: 1,
      lastSuccessAt: '2026-08-12T02:00:00.000Z',
    });
    expect(useAppStore.getState().toast).toBeNull();
    expect(useAppStore.getState().updateHealth?.consecutiveFailures).toBe(0);
  });
});
