import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from './appStore';

describe('startup recovery diagnostics', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    useAppStore.setState({ recovery: null });
  });

  it('keeps the corrupt bundle path and possible data-loss signal from app info', async () => {
    vi.stubGlobal('window', {
      setTimeout,
      sprintCoder: {
        tasks: { list: async () => [], subscribe: () => () => undefined },
        projects: { list: async () => [] },
        app: {
          getInfo: async () => ({
            version: '0.2.7',
            platform: 'darwin',
            recovery: {
              corruptionDetected: true,
              restoredFromBackup: true,
              freshStart: false,
              corruptBundlePath: '/diagnostics/sprint-coder.db.corrupt-id',
              possibleCommittedDataLoss: true,
              interruptedTurns: 0,
            },
          }),
        },
      },
    });

    await useAppStore.getState().init();
    await vi.waitFor(() =>
      expect(useAppStore.getState().recovery).toMatchObject({
        corruptBundlePath: '/diagnostics/sprint-coder.db.corrupt-id',
        possibleCommittedDataLoss: true,
      }),
    );
  });
});
