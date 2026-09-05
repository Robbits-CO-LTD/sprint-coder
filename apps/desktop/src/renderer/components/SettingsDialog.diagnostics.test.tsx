// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { DiagnosticsGroup } from './SettingsDialog';
import { useAppStore } from '../store/appStore';

afterEach(() => {
  vi.unstubAllGlobals();
  useAppStore.setState({ selectedTaskId: null, runtimeStatus: null });
});

it('allows copying again after the selection changes away and back during a copy', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let finishCopy!: () => void;
  const copy = new Promise<void>((resolve) => {
    finishCopy = resolve;
  });
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(() => copy) } });
  Object.defineProperty(window, 'sprintCoder', {
    configurable: true,
    value: {
      runtime: { getFailureDiagnostic: vi.fn().mockResolvedValue('safe diagnostic') },
    },
  });
  useAppStore.setState({ selectedTaskId: 'task-1', runtimeStatus: null });
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(<DiagnosticsGroup />));
    const button = container.querySelector('button')!;
    await act(async () => button.click());
    expect(button.disabled).toBe(true);
    await act(async () => useAppStore.setState({ selectedTaskId: 'task-2' }));
    await act(async () => useAppStore.setState({ selectedTaskId: 'task-1' }));
    await act(async () => finishCopy());
    expect(button.disabled).toBe(false);
  } finally {
    await act(async () => root.unmount());
    Reflect.deleteProperty(window, 'sprintCoder');
  }
});
