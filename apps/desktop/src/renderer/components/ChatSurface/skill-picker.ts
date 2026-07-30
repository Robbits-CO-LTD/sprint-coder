import type { SkillCatalogItem } from '@sprint-coder/contracts';

export type IndexedSkill = Readonly<{
  skill: SkillCatalogItem;
  searchText: string;
}>;

export function buildSkillSearchIndex(
  skills: readonly SkillCatalogItem[],
): readonly IndexedSkill[] {
  return skills.map((skill) => ({
    skill,
    searchText: [skill.name, skill.description, skill.ref.skillId, skill.ref.source, skill.kind]
      .join('\u0000')
      .toLocaleLowerCase(),
  }));
}

export function filterSkillSearchIndex(
  index: readonly IndexedSkill[],
  query: string,
): readonly SkillCatalogItem[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized === '') return index.map(({ skill }) => skill);
  return index
    .filter(({ searchText }) => searchText.includes(normalized))
    .map(({ skill }) => skill);
}

export type VirtualWindow = Readonly<{
  start: number;
  end: number;
  paddingTop: number;
  paddingBottom: number;
}>;

export function virtualWindow(
  itemCount: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  overscan = 4,
): VirtualWindow {
  if (itemCount <= 0) return { start: 0, end: 0, paddingTop: 0, paddingBottom: 0 };
  const safeRowHeight = Math.max(1, rowHeight);
  const start = Math.min(
    itemCount - 1,
    Math.max(0, Math.floor(Math.max(0, scrollTop) / safeRowHeight) - overscan),
  );
  const visibleCount = Math.ceil(Math.max(0, viewportHeight) / safeRowHeight);
  const end = Math.min(itemCount, start + visibleCount + overscan * 2);
  return {
    start,
    end,
    paddingTop: start * safeRowHeight,
    paddingBottom: Math.max(0, (itemCount - end) * safeRowHeight),
  };
}
