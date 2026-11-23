import {
  skillSourceSchema,
  type SkillCatalogItem,
  type SkillRef,
  type TurnSkillSelection,
} from '@sprint-coder/contracts';

const skillSources = new Set<string>(skillSourceSchema.options);

export type SkillMention = { start: number; end: number; selection: TurnSkillSelection };

export function isSkillCreator({ ref }: TurnSkillSelection): boolean {
  return ref.source === 'builtin' && ref.skillId === 'skill-creator';
}

export function removeSkillCreatorMention(text: string, selections: readonly TurnSkillSelection[]) {
  const mentions = skillMentions(text, selections).filter(({ selection }) =>
    isSkillCreator(selection),
  );
  for (const mention of mentions.reverse())
    text = text.slice(0, mention.start) + text.slice(mention.end);
  return text;
}

export function mentionText(ref: SkillRef, refs: readonly SkillRef[]): string {
  const ambiguous = refs.some(
    (other) => other.skillId === ref.skillId && other.source !== ref.source,
  );
  return ambiguous ? `$${ref.source}:${ref.skillId}` : `$${ref.skillId}`;
}

/** Match only the alias at the edit position. A space completes a name shared with a longer ID. */
export function typedSkillAlias(text: string, caret: number, catalog: readonly SkillCatalogItem[]) {
  const start = Math.max(0, caret - 150);
  const match = /(?:^|\s)([&$])(?:([a-z-]+):)?([A-Za-z0-9][A-Za-z0-9._-]{0,127})(\s?)$/u.exec(
    text.slice(start, caret),
  );
  if (!match) return null;
  const [, marker, source, id, space] = match;
  if (id === undefined || (source !== undefined && !skillSources.has(source))) return null;
  const terminated = Boolean(space);
  if (marker === '$' && !terminated) return null;
  const length = 1 + (source === undefined ? 0 : source.length + 1) + id.length;
  const trigger = caret - length - (terminated ? 1 : 0);
  if (trigger > 0 && !/\s/u.test(text[trigger - 1]!)) return null;
  if (!terminated && /[A-Za-z0-9._-]/.test(text[caret] ?? '')) return null;
  const exact = catalog.filter(
    ({ ref }) => ref.skillId === id && (source === undefined || ref.source === source),
  );
  if (exact.length !== 1) return null;
  if (!terminated && catalog.some(({ ref }) => ref.skillId !== id && ref.skillId.startsWith(id)))
    return null;
  return { skill: exact[0]!, trigger, length };
}

export function hasUnselectedSkillMention(
  text: string,
  selections: readonly TurnSkillSelection[],
  catalog: readonly SkillCatalogItem[],
): boolean {
  const selectedPositions = new Set(skillMentions(text, selections).map(({ start }) => start));
  for (const match of text.matchAll(
    /(^|\s)[$&](?:([a-z-]+):)?([A-Za-z0-9][A-Za-z0-9._-]{0,127})(?=$|\s|[,。！？])/gu,
  )) {
    const position = match.index + match[1]!.length;
    const source = match[2];
    const id = match[3]!;
    if (selectedPositions.has(position)) continue;
    if (
      catalog.some(
        ({ ref }) =>
          (source === undefined || ref.source === source) &&
          (id === ref.skillId ||
            (id.startsWith(ref.skillId) && /^[._-]+$/u.test(id.slice(ref.skillId.length)))),
      )
    )
      return true;
  }
  return false;
}

/** Text alone never activates a Skill: a mention needs its Task's pinned selection. */
export function skillMentions(
  text: string,
  selections: readonly TurnSkillSelection[],
): SkillMention[] {
  if (!selections.length) return [];
  const mentions: SkillMention[] = [];
  for (const match of text.matchAll(
    /\$(?:([a-zA-Z0-9][a-zA-Z0-9._-]*):)?([a-zA-Z0-9][a-zA-Z0-9._-]*)/g,
  )) {
    const qualifier = match[1];
    if (qualifier !== undefined && !skillSources.has(qualifier)) continue;
    const id = match[2]!;
    let selection: TurnSkillSelection | undefined;
    for (const candidate of selections) {
      const { skillId, source } = candidate.ref;
      if (qualifier !== undefined && source !== qualifier) continue;
      if (skillId === id) {
        selection = candidate;
        break;
      }
      // Dots, dashes and underscores can be part of the ID or following punctuation.
      if (
        (!selection || skillId.length > selection.ref.skillId.length) &&
        id.startsWith(skillId) &&
        /^[._-]+$/u.test(id.slice(skillId.length))
      ) {
        selection = candidate;
      }
    }
    if (selection) {
      const end = match.index + match[0].length - id.length + selection.ref.skillId.length;
      mentions.push({ start: match.index, end, selection });
    }
  }
  return mentions;
}

/** Settings and older drafts may have a selection but no inline spelling yet. */
export function presentSkillDraft(text: string, selections: readonly TurnSkillSelection[]) {
  const mentions = skillMentions(text, selections);
  const present = new Set(mentions.map((mention) => mention.selection));
  const missing = selections.filter((skill) => !present.has(skill));
  if (!missing.length) return { text, mentions };
  const refs = selections.map((skill) => skill.ref);
  const appended = missing.map((skill) => mentionText(skill.ref, refs)).join(' ');
  const separator = text && !/\s$/u.test(text) ? ' ' : '';
  const visible = text + separator + appended + ' ';
  return { text: visible, mentions: skillMentions(visible, selections) };
}
