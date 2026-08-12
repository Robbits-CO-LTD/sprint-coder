import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from './appStore';

describe('model fallback notification', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    useAppStore.getState().dismissToast();
  });

  it('shows the persisted catalog repair reason once when runtime settings consume it', async () => {
    let first = true;
    vi.stubGlobal('window', {
      sprintCoder: {
        settings: {
          getRuntime: () =>
            Promise.resolve({
              kind: 'codex' as const,
              codexAvailable: true,
              codexReadiness: 'ready' as const,
              claudeAvailable: false,
              claudeReadiness: 'unavailable' as const,
              model: 'auto',
              models: [],
              effort: 'medium' as const,
              codexEffort: '',
              modelFallbackNotice: first
                ? {
                    changes: [{ runtimeKind: 'codex' as const, migratedCount: 2, resetCount: 1 }],
                  }
                : null,
            }),
        },
      },
    });
    useAppStore.setState({ selectedTaskId: null, toast: null });

    await useAppStore.getState().loadRuntime();
    expect(useAppStore.getState().toast?.message).toContain('置換 2件、Autoへ戻した 1件');

    useAppStore.getState().dismissToast();
    first = false;
    await useAppStore.getState().loadRuntime();
    expect(useAppStore.getState().toast).toBeNull();
  });
});
