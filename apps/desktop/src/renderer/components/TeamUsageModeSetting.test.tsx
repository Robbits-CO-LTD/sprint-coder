// @vitest-environment jsdom
import { StrictMode, act } from 'react';
import type { TeamUsageMode } from '@sprint-coder/contracts';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEAM_USAGE_NOTES, TEAM_USAGE_OPTIONS } from '../lib/team-usage-options';
import { TeamUsageModeSetting } from './TeamUsageModeSetting';

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

function bridge(settings: Record<string, unknown> | undefined): void {
  Object.defineProperty(window, 'sprintCoder', {
    configurable: true,
    value: settings === undefined ? undefined : { settings },
  });
}

let mounted: { root: Root; container: HTMLElement } | null = null;

async function mount(strict = false): Promise<HTMLElement> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted = { root, container };
  await act(async () =>
    root.render(
      strict ? (
        <StrictMode>
          <TeamUsageModeSetting active />
        </StrictMode>
      ) : (
        <TeamUsageModeSetting active />
      ),
    ),
  );
  await flush();
  return container;
}

const radio = (container: HTMLElement, mode: TeamUsageMode) =>
  container.querySelector<HTMLInputElement>(
    `[data-testid="settings-team-usage-mode-${mode}"] input`,
  )!;
const checkedModes = (container: HTMLElement) =>
  TEAM_USAGE_OPTIONS.filter(({ value }) => radio(container, value).checked).map(
    ({ value }) => value,
  );

afterEach(() => {
  if (mounted !== null) {
    act(() => mounted!.root.unmount());
    mounted.container.remove();
    mounted = null;
  }
  bridge(undefined);
  vi.unstubAllGlobals();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('TeamUsageModeSetting ordering', () => {
  it('saves once when the choices are pressed in quick succession', async () => {
    const pending = deferred<{ mode: TeamUsageMode }>();
    const setTeamUsageMode = vi.fn(() => pending.promise);
    bridge({
      getTeamUsageMode: vi.fn().mockResolvedValue({ mode: 'explicit' }),
      setTeamUsageMode,
    });
    const container = await mount();
    await act(async () => {
      radio(container, 'proactive').click();
      radio(container, 'auto').click();
      radio(container, 'explicit').click();
    });
    expect(setTeamUsageMode).toHaveBeenCalledTimes(1);
    expect(setTeamUsageMode).toHaveBeenCalledWith({ mode: 'proactive' });
    // While the first save is in flight, every choice waits.
    for (const { value } of TEAM_USAGE_OPTIONS) expect(radio(container, value).disabled).toBe(true);
    await act(async () => pending.resolve({ mode: 'proactive' }));
    await flush();
    expect(checkedModes(container)).toEqual(['proactive']);
    expect(radio(container, 'auto').disabled).toBe(false);
  });

  it('ignores a slow earlier read that arrives after a newer one', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const first = deferred<{ mode: TeamUsageMode }>();
    const second = deferred<{ mode: TeamUsageMode }>();
    const getTeamUsageMode = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    bridge({ getTeamUsageMode, setTeamUsageMode: vi.fn() });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    mounted = { root, container };
    await act(async () => root.render(<TeamUsageModeSetting active />));
    await flush();
    // The dialog closes and opens again before the first read answers.
    await act(async () => root.render(<TeamUsageModeSetting active={false} />));
    await act(async () => root.render(<TeamUsageModeSetting active />));
    await flush();
    expect(getTeamUsageMode).toHaveBeenCalledTimes(2);
    await act(async () => second.resolve({ mode: 'auto' }));
    await flush();
    await act(async () => first.resolve({ mode: 'proactive' }));
    await flush();
    expect(checkedModes(container)).toEqual(['auto']);
  });
});

describe('TeamUsageModeSetting', () => {
  it.each([false, true])(
    'shows the three choices in plain words and the saved one (strict=%s)',
    async (strict) => {
      bridge({
        getTeamUsageMode: vi.fn().mockResolvedValue({ mode: 'auto' }),
        setTeamUsageMode: vi.fn(),
      });
      const container = await mount(strict);
      expect(container.querySelector('legend')?.textContent).toBe('Team の使い方');
      const text = container.textContent ?? '';
      for (const { label, description } of TEAM_USAGE_OPTIONS) {
        expect(text).toContain(label);
        expect(text).toContain(description);
      }
      for (const note of TEAM_USAGE_NOTES) expect(text).toContain(note);
      expect(text).toContain('言った時だけ');
      expect(text).toContain('おまかせ');
      expect(text).toContain('積極的に');
      expect(text).toContain('Team のメンバーも、AI の利用枠を使います。');
      expect(text).toContain('変更は次の発言から反映されます。');
      // No developer words on the screen.
      expect(text).not.toMatch(/provider|runtime|prompt|MCP|Leader/i);
      expect(checkedModes(container)).toEqual(['auto']);
    },
  );

  it('saves the choice right away and shows what Main confirmed', async () => {
    const setTeamUsageMode = vi.fn(async (input: { mode: TeamUsageMode }) => input);
    bridge({
      getTeamUsageMode: vi.fn().mockResolvedValue({ mode: 'explicit' }),
      setTeamUsageMode,
    });
    const container = await mount();
    expect(checkedModes(container)).toEqual(['explicit']);
    await act(async () => radio(container, 'proactive').click());
    await flush();
    expect(setTeamUsageMode).toHaveBeenCalledTimes(1);
    expect(setTeamUsageMode).toHaveBeenCalledWith({ mode: 'proactive' });
    expect(checkedModes(container)).toEqual(['proactive']);
    expect(container.querySelector('[role="status"]')?.textContent).toContain('積極的に');
  });

  it('goes back to the confirmed choice when saving fails', async () => {
    bridge({
      getTeamUsageMode: vi.fn().mockResolvedValue({ mode: 'explicit' }),
      setTeamUsageMode: vi.fn().mockRejectedValue(new Error('boom')),
    });
    const container = await mount();
    await act(async () => radio(container, 'auto').click());
    await flush();
    expect(checkedModes(container)).toEqual(['explicit']);
    expect(
      container.querySelector('[data-testid="settings-team-usage-mode-error"]')?.textContent,
    ).toContain('保存できませんでした');
  });

  it('stays disabled without breaking when the bridge predates the setting', async () => {
    bridge({ getTeamModelResearch: vi.fn() });
    const container = await mount();
    for (const { value } of TEAM_USAGE_OPTIONS) expect(radio(container, value).disabled).toBe(true);
    expect(container.textContent).toContain('この環境では変更できません。');
  });

  it('keeps the choices disabled when the saved value cannot be read', async () => {
    bridge({
      getTeamUsageMode: vi.fn().mockRejectedValue(new Error('boom')),
      setTeamUsageMode: vi.fn(),
    });
    const container = await mount();
    for (const { value } of TEAM_USAGE_OPTIONS) expect(radio(container, value).disabled).toBe(true);
    expect(
      container.querySelector('[data-testid="settings-team-usage-mode-error"]')?.textContent,
    ).toContain('読み込めませんでした');
  });
});
