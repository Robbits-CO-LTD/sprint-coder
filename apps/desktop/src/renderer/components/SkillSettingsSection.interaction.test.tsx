// @vitest-environment jsdom
import { StrictMode, act } from 'react';
import type { SkillDraft } from '@sprint-coder/contracts';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { SkillSettingsSection } from './SkillSettingsSection';

afterEach(() => vi.unstubAllGlobals());

it.each([false, true])(
  'keeps draft review local through native toggles and reload (strict=%s)',
  async (strict) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const drafts: SkillDraft[] = ['alpha', 'beta'].map((name) => ({
      id: `draft-${name}`,
      kind: 'chat',
      skillId: name,
      name,
      description: `Synthetic ${name} draft`,
      digest: (name === 'alpha' ? 'a' : 'b').repeat(64),
      files: [{ path: 'SKILL.md', content: `# ${name}` }],
      createdAt: '2026-10-27T00:00:00.000Z',
      updatedAt: '2026-10-27T00:00:00.000Z',
    }));
    const installDraft = vi.fn().mockResolvedValue(undefined);
    const listDrafts = vi.fn().mockResolvedValue(drafts);
    Object.defineProperty(window, 'sprintCoder', {
      configurable: true,
      value: {
        skills: { list: vi.fn().mockResolvedValue({ items: [] }), listDrafts, installDraft },
      },
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const toggle = async (index: number, open: boolean) => {
      const details = container.querySelectorAll('details')[index];
      if (!details) throw new Error('Draft details missing');
      await act(async () => {
        details.open = open;
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };
    const installButtons = () =>
      [...container.querySelectorAll('button')].filter(
        (button) => button.textContent === '内容を確認してインストール',
      );
    const expectEnabled = (alpha: boolean, beta: boolean) => {
      expect(installButtons().map((button) => !button.disabled)).toEqual([alpha, beta]);
    };
    try {
      await act(async () =>
        root.render(
          strict ? (
            <StrictMode>
              <SkillSettingsSection active />
            </StrictMode>
          ) : (
            <SkillSettingsSection active />
          ),
        ),
      );
      expectEnabled(false, false);
      await toggle(0, true);
      expectEnabled(true, false);
      await toggle(1, true);
      expectEnabled(true, true);
      await toggle(0, false);
      expectEnabled(false, true);
      await toggle(1, false);
      expectEnabled(false, false);
      await toggle(0, true);
      expectEnabled(true, false);
      expect(installDraft).not.toHaveBeenCalled();
      const beforeReload = listDrafts.mock.calls.length;
      const reload = [...container.querySelectorAll('button')].find(
        (button) => button.textContent === '再読み込み',
      );
      if (!reload) throw new Error('Reload button missing');
      await act(async () => reload.click());
      expect(listDrafts).toHaveBeenCalledTimes(beforeReload + 1);
      expectEnabled(false, false);
      await toggle(0, false);
      await toggle(0, true);
      expectEnabled(true, false);
      await act(async () => installButtons()[0]?.click());
      expect(installDraft).toHaveBeenCalledExactlyOnceWith('draft-alpha', 'a'.repeat(64), true);
      expectEnabled(false, false);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      Reflect.deleteProperty(window, 'sprintCoder');
    }
  },
);

it('waits for an explicit reload after a failed initial request', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // Only the first request rejects; a buggy automatic retry therefore terminates deterministically.
  const list = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ items: [] });
  Object.defineProperty(window, 'sprintCoder', {
    configurable: true,
    value: {
      skills: { list, listDrafts: vi.fn().mockResolvedValue([]) },
    },
  });
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(<SkillSettingsSection active />));
    expect(list).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('再読み込み');
    const reload = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('再読み込み'),
    );
    expect(reload?.disabled).toBe(false);
    await act(async () => reload?.click());
    expect(list).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    Reflect.deleteProperty(window, 'sprintCoder');
  }
});
