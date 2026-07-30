import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SkillDraftCard } from './SkillDraftCard';

describe('<SkillDraftCard />', () => {
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
