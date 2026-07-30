import { describe, expect, it } from 'vitest';
import type { SkillCatalogItem } from '@sprint-coder/contracts';
import { buildSkillSearchIndex, filterSkillSearchIndex, virtualWindow } from './skill-picker';

function fixture(index: number): SkillCatalogItem {
  return {
    ref: {
      skillId: `skill-${index}`,
      source: index % 5 === 0 ? 'builtin' : 'created',
      digest: index.toString(16).padStart(64, '0'),
    },
    kind: index % 7 === 0 ? 'team' : 'chat',
    name: `Skill ${index}`,
    description: index === 999 ? '日本語アクセシビリティ監査' : `Fixture ${index}`,
    enabled: true,
    removable: true,
    exportable: true,
  };
}

describe('skill picker index and virtualization', () => {
  const catalog = Array.from({ length: 1_200 }, (_, index) => fixture(index));

  it('searches a 1000+ item catalog through one prebuilt index', () => {
    const index = buildSkillSearchIndex(catalog);
    expect(index).toHaveLength(1_200);
    expect(filterSkillSearchIndex(index, '日本語').map(({ ref }) => ref.skillId)).toEqual([
      'skill-999',
    ]);
    expect(filterSkillSearchIndex(index, 'skill-1199')).toHaveLength(1);
  });

  it('renders only a bounded viewport window', () => {
    const window = virtualWindow(1_200, 18_000, 320, 56);
    expect(window.end - window.start).toBeLessThan(20);
    expect(window.start).toBeGreaterThan(300);
    expect(window.paddingTop + window.paddingBottom).toBeGreaterThan(60_000);
  });

  it('clamps a stale scroll position after filtering to fewer items', () => {
    expect(virtualWindow(3, 1_000, 290, 58)).toEqual({
      start: 2,
      end: 3,
      paddingTop: 116,
      paddingBottom: 0,
    });
  });
});
