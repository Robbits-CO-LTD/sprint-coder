import type { SkillRef, TurnSkillSelection } from '@sprint-coder/contracts';

export type SkillMention = { start: number; end: number; selection: TurnSkillSelection };

export function mentionText(ref: SkillRef, refs: readonly SkillRef[]): string {
  const ambiguous = refs.some(
    (other) => other.skillId === ref.skillId && other.source !== ref.source,
  );
  return ambiguous ? `$${ref.source}:${ref.skillId}` : `$${ref.skillId}`;
}

/** Text alone never activates a Skill: a mention needs its Task's pinned selection. */
export function skillMentions(
  text: string,
  selections: readonly TurnSkillSelection[],
): SkillMention[] {
  if (!selections.length) return [];
  const mentions: SkillMention[] = [];
  for (const match of text.matchAll(
    /\$(?:(builtin|created|claude|agents):)?([a-zA-Z0-9][a-zA-Z0-9._-]*)/g,
  )) {
    const selection = selections.find(
      ({ ref }) => ref.skillId === match[2] && (!match[1] || ref.source === match[1]),
    );
    if (selection)
      mentions.push({ start: match.index, end: match.index + match[0].length, selection });
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
