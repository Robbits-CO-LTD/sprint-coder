// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Composer } from './ChatSurface/Composer';
import { LegacyBody, WorkspaceBody } from './SettingsDialog';
import { useAppStore, type RuntimeState } from '../store/appStore';
import { workerRuntimeLabel } from '../lib/team-activity-display';
import { connectionLabel } from '../lib/team-execution-display';

const initial = useAppStore.getInitialState();
let container: HTMLDivElement;
let root: Root;

function grokRuntime(overrides: Partial<RuntimeState> = {}): RuntimeState {
  return {
    ...initial.runtime,
    kind: 'grok',
    grokAvailable: true,
    grokReadiness: 'ready',
    grokCli: {
      source: 'path',
      executable: '/test/bin/grok',
      version: 'grok-test',
      compatibility: 'untested',
      capabilities: [],
    },
    model: 'auto',
    models: [
      { id: 'auto', displayName: 'Auto', description: 'Grok CLIの既定モデルを使用' },
      { id: 'grok-test', displayName: 'Grok Test', description: 'テスト用モデル' },
    ],
    ...overrides,
  };
}

function bridge(runtime = grokRuntime()) {
  let saved = runtime;
  const settings = {
    getRuntime: vi.fn(async () => ({ ...saved, modelFallbackNotice: null })),
    setRuntime: vi.fn(async (kind: RuntimeState['kind']) => {
      saved = { ...saved, kind };
    }),
    setModel: vi.fn(async (model: string) => {
      saved = { ...saved, model };
    }),
    setEffort: vi.fn(),
    setCodexEffort: vi.fn(),
  };
  Object.defineProperty(window, 'sprintCoder', {
    configurable: true,
    value: { settings },
  });
  return settings;
}

function button(testId: string): HTMLButtonElement {
  const element = container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  expect(element).not.toBeNull();
  return element!;
}

async function render(node: ReactNode) {
  await act(async () => root.render(node));
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useAppStore.setState(initial, true);
  useAppStore.setState({ selectedTaskId: 'task-grok' });
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

describe('Grok CLI runtime controls', () => {
  it('selects Grok and its model through the task-scoped bridge without writing effort', async () => {
    const settings = bridge();
    useAppStore.setState({ runtime: grokRuntime({ kind: 'mock' }) });
    await render(<Composer taskId="task-grok" />);
    await act(async () => button('runtime-selector').click());
    expect(button('runtime-option-grok').disabled).toBe(false);
    await act(async () => button('runtime-option-grok').click());

    expect(settings.setRuntime).toHaveBeenCalledWith('grok', 'task-grok');
    expect(settings.getRuntime).toHaveBeenCalledWith('task-grok');
    expect(useAppStore.getState().runtime).toMatchObject({
      kind: 'grok',
      grokAvailable: true,
      grokReadiness: 'ready',
      grokCli: { version: 'grok-test' },
    });
    expect(button('runtime-selector').textContent).toBe('Grok CLI');
    expect(container.querySelector('[data-testid="effort-selector"]')).toBeNull();

    await act(async () => button('model-selector').click());
    await act(async () => button('model-option-grok-test').click());
    expect(settings.setModel).toHaveBeenCalledWith('grok-test', 'task-grok');
    expect(button('model-selector').textContent).toBe('Grok Test');
    expect(settings.setEffort).not.toHaveBeenCalled();
    expect(settings.setCodexEffort).not.toHaveBeenCalled();
  });

  it.each([
    ['unavailable', false, 'Grok CLIが見つかりません'],
    ['unavailable', true, 'Grok CLIは見つかりましたが'],
    ['authentication_required', true, 'grok login'],
  ] as const)(
    'blocks selection when Grok is %s (CLI found: %s) and explains recovery',
    async (readiness, found, hint) => {
      const runtime = grokRuntime({ grokReadiness: readiness, grokAvailable: found });
      const settings = bridge(runtime);
      useAppStore.setState({ runtime });
      await render(<Composer taskId="task-grok" />);
      expect(button('model-selector').disabled).toBe(true);
      expect(button('model-selector').title).toContain(hint);
      await act(async () => button('runtime-selector').click());
      const option = button('runtime-option-grok');
      expect(option.disabled).toBe(true);
      expect(option.title).toContain(hint);
      await act(async () => option.click());
      expect(settings.setRuntime).not.toHaveBeenCalled();
      await act(async () =>
        option.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
      );
      expect(button('runtime-selector').getAttribute('aria-expanded')).toBe('false');
    },
  );

  it('rolls back a failed switch and names Grok in the unavailable message', async () => {
    const settings = bridge();
    settings.setRuntime.mockRejectedValue({ code: 'RUNTIME_UNAVAILABLE' });
    const previous = grokRuntime({ kind: 'mock' });
    useAppStore.setState({ runtime: previous });
    await useAppStore.getState().setRuntime('grok');
    expect(useAppStore.getState().runtime).toEqual(previous);
    expect(useAppStore.getState().toast?.message).toBe(
      'Grok CLIが見つからないため切り替えできません',
    );
  });
});

describe('Grok settings and Team display', () => {
  it.each([LegacyBody, WorkspaceBody])(
    'shows Grok diagnostics and CLI defaults without Claude effort controls in %s',
    async (Body) => {
      bridge();
      useAppStore.setState({ runtime: grokRuntime({ grokReadiness: 'authentication_required' }) });
      await render(<Body open={false} supported onClose={() => {}} />);
      const detection = container.querySelector('[data-testid="settings-cli-grok"]');
      expect(detection?.textContent).toContain('Grok CLI');
      expect(detection?.textContent).toContain('grok login');
      expect(detection?.querySelector('.settings-ok')).not.toBeNull();
      expect(container.querySelector('[data-testid="settings-effort"]')).toBeNull();
      expect(container.textContent).toContain('Grok CLIの既定の推論設定を使用します');
      expect(
        container.querySelector('[data-testid="settings-cli-compatibility-warning"]')?.textContent,
      ).toContain('grok-test は未検証のCLI');

      await act(async () =>
        useAppStore.setState({
          runtime: grokRuntime({ grokReadiness: 'unavailable', grokAvailable: false }),
        }),
      );
      expect(detection?.textContent).toContain('Grok CLIが見つかりません');
      expect(detection?.querySelector('.settings-missing')).not.toBeNull();
      // Found but not confirmed (issue #517): never reported as missing.
      await act(async () =>
        useAppStore.setState({ runtime: grokRuntime({ grokReadiness: 'unavailable' }) }),
      );
      expect(detection?.textContent).not.toContain('Grok CLIが見つかりません');
      expect(detection?.textContent).toContain('grok login');
      await act(async () => useAppStore.setState({ runtime: grokRuntime() }));
      expect(detection?.textContent).toContain('利用可能');
    },
  );

  it('names builtin Grok workers consistently without relabeling xAI API connections', () => {
    expect(connectionLabel('builtin:grok-cli')).toBe('Grok CLI');
    expect(workerRuntimeLabel({ engine: 'grok', connectionId: 'builtin:grok-cli' })).toBe(
      'Grok CLI',
    );
    expect(workerRuntimeLabel({ engine: 'grok', connectionId: null })).toBe('Grok CLI');
    expect(workerRuntimeLabel({ engine: 'grok', connectionId: 'conn-xai-api' })).toBe('API');
  });
});
