// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { SkillDraftCard } from './SkillDraftCard';

describe('<SkillDraftCard />', () => {
  it.each([
    ['NOT_FOUND', 'C:/private/path', '見つかりません'],
    ['OPERATION_CONFLICT', '同名のSkillが既に存在します。', '同名のSkillが既に存在します。'],
    ['OPERATION_CONFLICT', 'C:/private/path', '操作の条件を満たしていません'],
  ])(
    'shows a safe %s error on the card and lets the user retry discard (case %#)',
    async (code, userMessage, reason) => {
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      const discard = vi
        .fn()
        .mockRejectedValueOnce({ code, userMessage, retryable: true })
        .mockResolvedValue(undefined);
      const container = document.createElement('div');
      const root = createRoot(container);
      try {
        await act(async () =>
          root.render(
            <SkillDraftCard
              draft={{
                id: 'draft-1',
                kind: 'chat',
                skillId: 'test',
                name: 'Test',
                description: 'test',
                digest: 'a'.repeat(64),
                files: [{ path: 'SKILL.md', content: '# Test' }],
                createdAt: '2026-07-29T00:00:00.000Z',
                updatedAt: '2026-07-29T00:00:00.000Z',
              }}
              onInstall={vi.fn()}
              onDiscard={discard}
            />,
          ),
        );
        const button = container.querySelector<HTMLButtonElement>('button')!;
        await act(async () => button.click());
        expect(container.querySelector('[role="alert"]')?.textContent).toContain(reason);
        expect(container.textContent).not.toContain('C:/private/path');
        await act(async () => button.click());
        expect(discard).toHaveBeenCalledTimes(2);
        expect(container.querySelector('[role="alert"]')).toBeNull();
      } finally {
        await act(async () => root.unmount());
        vi.unstubAllGlobals();
      }
    },
  );
  it('reports that a reviewed draft changed when installation fails', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const reason = 'Skill Draftが確認後に変更されました';
    const install = vi.fn().mockRejectedValue({
      code: 'OPERATION_CONFLICT',
      userMessage: reason,
      retryable: true,
    });
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <SkillDraftCard
            draft={{
              id: 'draft-1',
              kind: 'chat',
              skillId: 'test',
              name: 'Test',
              description: 'test',
              digest: 'a'.repeat(64),
              files: [{ path: 'SKILL.md', content: '# Test' }],
              createdAt: '2026-07-29T00:00:00.000Z',
              updatedAt: '2026-07-29T00:00:00.000Z',
            }}
            onInstall={install}
            onDiscard={vi.fn()}
          />,
        ),
      );
      const details = container.querySelector('details')!;
      await act(async () => {
        details.open = true;
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      const button = [...container.querySelectorAll('button')].find(
        (item) => item.textContent === 'インストール',
      )!;
      await act(async () => button.click());
      expect(install).toHaveBeenCalledOnce();
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(reason);
      expect(button.disabled).toBe(false);
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  });

  it('shows the immutable digest and files but keeps install disabled before review', () => {
    const html = renderToStaticMarkup(
      <SkillDraftCard
        draft={{
          id: 'draft-1',
          kind: 'team',
          skillId: 'company',
          name: 'Company',
          description: '会社型Team',
          digest: 'a'.repeat(64),
          files: [
            {
              path: 'SKILL.md',
              content: '---\nname: Company\ndescription: 会社型Team\n---\n',
            },
            { path: 'team/blueprint.json', content: '{"version":1}' },
          ],
          createdAt: '2026-07-29T00:00:00.000Z',
          updatedAt: '2026-07-29T00:00:00.000Z',
        }}
        onInstall={vi.fn()}
        onDiscard={vi.fn()}
      />,
    );
    expect(html).toContain('Team Skill Draft');
    expect(html).toContain('aaaaaaaaaaaa');
    expect(html).toContain('SKILL.md');
    expect(html).toContain('team/blueprint.json');
    expect(html).toContain('disabled');
    expect(html).not.toContain('元に戻す');
  });
});
