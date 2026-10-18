// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TeamConcurrencySetting } from './SettingsDialog';
import { concurrencyOptions, TEAM_CONCURRENCY_RANGE } from '../lib/team-concurrency';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  delete (window as { sprintCoder?: unknown }).sprintCoder;
});

async function mount(settings: Record<string, unknown>): Promise<HTMLDivElement> {
  (window as { sprintCoder?: unknown }).sprintCoder = { settings };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<TeamConcurrencySetting active />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return host;
}

function select(container: HTMLElement): HTMLSelectElement {
  return container.querySelector('[data-testid="settings-team-concurrency-select"]')!;
}

async function choose(container: HTMLElement, value: number): Promise<void> {
  await act(async () => {
    const element = select(container);
    element.value = String(value);
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe('Settings > Team: app-wide Worker concurrency', () => {
  it('shows the saved limit, explains the load and rate-limit cost, and saves a new one', async () => {
    let saved = 50;
    const setTeamConcurrency = vi.fn(async (input: { maxConcurrentExecutions: number }) => {
      saved = input.maxConcurrentExecutions;
    });
    const container = await mount({
      getTeamConcurrency: vi.fn(async () => ({ maxConcurrentExecutions: saved })),
      setTeamConcurrency,
    });

    expect(select(container).value).toBe('50');
    expect(select(container).disabled).toBe(false);
    expect(container.textContent).toContain('アプリ全体で同時に動かせるWorkerの数');
    expect(container.textContent).toContain('CPU・メモリの負荷');
    expect(container.textContent).toContain('サブスクリプションの利用上限');
    const options = [...select(container).options].map(({ value }) => Number(value));
    expect(options[0]).toBe(1);
    expect(options.at(-1)).toBe(100);

    await choose(container, 80);
    expect(setTeamConcurrency).toHaveBeenCalledWith({ maxConcurrentExecutions: 80 });
    expect(select(container).value).toBe('80');
    expect(
      container.querySelector('[data-testid="settings-team-concurrency-state"]')?.textContent,
    ).toContain('80人まで');
  });

  it('returns to the confirmed value when Main rejects the change', async () => {
    const container = await mount({
      getTeamConcurrency: vi.fn(async () => ({ maxConcurrentExecutions: 50 })),
      setTeamConcurrency: vi.fn(async () => {
        throw new Error('rejected');
      }),
    });
    await choose(container, 10);
    expect(select(container).value).toBe('50');
    expect(
      container.querySelector('[data-testid="settings-team-concurrency-error"]')?.textContent,
    ).toContain('直前の値に戻しました');
  });

  it('stays disabled in a shell whose bridge predates the setting', async () => {
    const container = await mount({});
    expect(select(container).disabled).toBe(true);
    expect(container.textContent).toContain('この環境では変更できません');
  });
});

describe('concurrency options', () => {
  it('spans 1 to 100 and keeps an off-list stored value selectable', () => {
    const options = concurrencyOptions();
    expect(options[0]).toBe(TEAM_CONCURRENCY_RANGE.min);
    expect(options.at(-1)).toBe(TEAM_CONCURRENCY_RANGE.max);
    expect(options).toContain(50);
    expect(concurrencyOptions(13)).toContain(13);
    expect(concurrencyOptions(101)).not.toContain(101);
    expect(new Set(concurrencyOptions(50)).size).toBe(concurrencyOptions(50).length);
  });
});
