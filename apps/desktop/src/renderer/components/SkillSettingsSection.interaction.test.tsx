// @vitest-environment jsdom
import { StrictMode, act } from 'react';
import type { SkillDraft } from '@sprint-coder/contracts';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { SkillSettingsSection } from './SkillSettingsSection';

afterEach(() => vi.unstubAllGlobals());

it('shows export success, cancellation and failure without exposing the destination', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const item = {
    ref: { source: 'created', skillId: 'review', digest: 'a'.repeat(64) },
    name: 'Review',
    kind: 'chat',
    enabled: true,
    activationPolicy: 'manual',
  };
  const exportCreated = vi
    .fn()
    .mockResolvedValueOnce('C:/private/destination')
    .mockResolvedValueOnce(null)
    .mockRejectedValueOnce({
      code: 'OPERATION_CONFLICT',
      userMessage: '書き出し先に同名のフォルダーがあります。',
      retryable: false,
    })
    .mockRejectedValueOnce({
      code: 'OPERATION_CONFLICT',
      userMessage: 'C:/private/destination',
      retryable: false,
    });
  Object.defineProperty(window, 'sprintCoder', {
    configurable: true,
    value: {
      skills: {
        list: vi.fn().mockResolvedValue({ items: [item] }),
        listDrafts: vi.fn().mockResolvedValue([]),
        exportCreated,
      },
    },
  });
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(<SkillSettingsSection active />));
    const button = [...container.querySelectorAll('button')].find(
      (element) => element.textContent === 'Export',
    )!;
    await act(async () => button.click());
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      'Reviewを書き出しました。',
    );
    await act(async () => button.click());
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      '書き出しをキャンセルしました。',
    );
    await act(async () => button.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      '書き出し先に同名のフォルダーがあります。',
    );
    await act(async () => button.click());
    expect(container.querySelector('[role="status"]')?.textContent?.trim() ?? '').toBe('');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('対象が変更');
    expect(container.textContent).not.toContain('C:/private/destination');
  } finally {
    await act(async () => root.unmount());
    Reflect.deleteProperty(window, 'sprintCoder');
  }
});

it('explains a failed AI-assisted Skill creation and lets the user retry', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const create = vi
    .fn()
    .mockRejectedValueOnce(new Error('private path'))
    .mockResolvedValue(undefined);
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(<SkillSettingsSection active={false} onCreateWithAi={create} />),
    );
    const button = [...container.querySelectorAll('button')].find(
      (item) => item.textContent === 'AIでSkillを作成',
    )!;
    await act(async () => button.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('再起動');
    expect(container.textContent).not.toContain('private path');
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    expect(create).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});

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
      const details = container.querySelectorAll<HTMLDetailsElement>('.settings-skill-draft-files')[
        index
      ];
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
  const list = vi
    .fn()
    .mockRejectedValueOnce(Object.assign(new Error('private folder'), { code: 'FORBIDDEN' }))
    .mockResolvedValue({ items: [] });
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
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('権限');
    expect(container.textContent).not.toContain('private folder');
    const reload = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('再読み込み'),
    );
    expect(reload?.disabled).toBe(false);
    await act(async () => reload?.click());
    expect(list).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    const status = container.querySelector('[role="status"]')!;
    expect(status.textContent).toContain('読み込みました');
    expect(status.classList.contains('sr-only')).toBe(false);
  } finally {
    await act(async () => root.unmount());
    Reflect.deleteProperty(window, 'sprintCoder');
  }
});
