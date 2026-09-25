// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CLI_REDETECT_ERROR, ProviderSettingsSection } from './ProviderSettingsSection';
import { useAppStore } from '../store/appStore';

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, 'sprintCoder');
});

function runtimeSettings(grokReadiness: 'ready' | 'unavailable') {
  return {
    kind: 'grok',
    codexAvailable: true,
    codexReadiness: 'ready',
    claudeAvailable: true,
    claudeReadiness: 'ready',
    grokAvailable: true,
    grokReadiness,
    codexCli: null,
    claudeCli: null,
    grokCli: null,
    model: 'auto',
    models: [],
    effort: 'high',
    codexEffort: '',
    modelFallbackNotice: null,
  };
}

async function renderSection(refreshRuntimeDetection: () => Promise<void>) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const listConnections = vi.fn().mockResolvedValue([]);
  const getRuntime = vi.fn().mockResolvedValue(runtimeSettings('unavailable'));
  Object.defineProperty(window, 'sprintCoder', {
    configurable: true,
    value: {
      providers: { listConnections, listProfiles: vi.fn().mockResolvedValue([]) },
      settings: { getRuntime, refreshRuntimeDetection: vi.fn(refreshRuntimeDetection) },
    },
  });
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => root.render(<ProviderSettingsSection active />));
  const reload = [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('再読み込み'),
  )!;
  return {
    container,
    root,
    reload,
    listConnections,
    getRuntime,
    refreshRuntimeDetection: window.sprintCoder!.settings.refreshRuntimeDetection,
  };
}

it('detects the CLIs again from the reload button, and only from it (issue #581)', async () => {
  let finishDetection!: () => void;
  const view = await renderSection(
    () =>
      new Promise<void>((resolve) => {
        finishDetection = resolve;
      }),
  );
  try {
    // Opening the section lists Connections without starting any CLI.
    expect(view.listConnections).toHaveBeenCalledOnce();
    expect(view.refreshRuntimeDetection).not.toHaveBeenCalled();

    view.getRuntime.mockResolvedValue(runtimeSettings('ready'));
    await act(async () => view.reload.click());
    expect(view.refreshRuntimeDetection).toHaveBeenCalledOnce();
    expect(view.listConnections).toHaveBeenCalledTimes(2);
    // The runtime state is read only after the new detection has settled.
    expect(view.getRuntime).not.toHaveBeenCalled();
    expect(view.reload.disabled).toBe(true);

    await act(async () => finishDetection());
    expect(view.getRuntime).toHaveBeenCalledOnce();
    expect(useAppStore.getState().runtime.grokReadiness).toBe('ready');
    expect(view.reload.disabled).toBe(false);
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
  } finally {
    await act(async () => view.root.unmount());
  }
});

it('says so when the CLIs could not be detected again, while keeping the Connection list', async () => {
  const view = await renderSection(() => Promise.reject(new Error('IPC failed')));
  try {
    await act(async () => view.reload.click());
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
      CLI_REDETECT_ERROR,
    );
    expect(view.getRuntime).not.toHaveBeenCalled();
    expect(view.reload.disabled).toBe(false);
  } finally {
    await act(async () => view.root.unmount());
  }
});
