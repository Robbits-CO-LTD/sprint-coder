// What a skeptic is actually asked.
//
// The prompt is the panel's only lever on verdict quality, and two things about it decide whether a
// round is worth running. It must ask for refutation rather than review — a reviewer asked "is this
// good?" produces agreeable prose, while one asked "prove this is not done" goes looking. And it
// must fix the output shape hard enough to parse, because a verdict that cannot be read is a wasted
// round that the panel is obliged to count as a refute.
//
// It also has to be safe to build from untrusted parts. The objective is the user's text, the
// criteria and the claim come from a model, and all three are pasted into a prompt that gives
// instructions. Each is fenced and bounded here rather than trusted to be well-behaved.

import type { SkepticFinding } from './adversarial-panel';

export type SkepticPromptInput = Readonly<{
  /** The user's goal, verbatim. */
  objective: string;
  /** The gating criteria the work must meet. */
  criteria: readonly string[];
  /** What the implementer says it did. Evidence to attack, never evidence in itself. */
  claim: string;
  /** Files the work was allowed to touch, so the skeptic knows where to look. */
  changedPaths: readonly string[];
  /** Gaps an earlier round already raised, empty on the first round. */
  priorGaps: readonly SkepticFinding[];
}>;

const MAX_OBJECTIVE_CHARS = 4_000;
const MAX_CLAIM_CHARS = 8_000;
const MAX_CRITERIA = 20;
const MAX_PATHS = 50;
const MAX_PRIOR_GAPS = 20;

/** Fences untrusted text so its own backticks cannot end the block early. */
const FENCE = '~~~~';

export function buildSkepticPrompt(input: SkepticPromptInput): string {
  const first = input.priorGaps.length === 0;
  return [
    'You are an adversarial verifier. You did NOT do the work below, and your job is to REFUTE the',
    'claim that it is complete — not to review it, praise it, or improve it.',
    '',
    'Default to refuted when uncertain. Passing broken work ends the loop wrongly, which costs far',
    'more than one more round. But refuting costs a round too, so refute for a reason you can point',
    'at, never for a preference.',
    '',
    '# Objective',
    fence(cap(input.objective, MAX_OBJECTIVE_CHARS)),
    '',
    '# Gating criteria',
    ...list(
      input.criteria.slice(0, MAX_CRITERIA),
      '(none were recorded — judge against the objective)',
    ),
    '',
    '# Files the work was allowed to touch',
    ...list(input.changedPaths.slice(0, MAX_PATHS), '(none recorded)'),
    '',
    '# What the implementer claims',
    'Prose is not evidence. Use it only to find claims worth attacking.',
    fence(cap(input.claim, MAX_CLAIM_CHARS)),
    '',
    ...(first ? firstRoundRules() : laterRoundRules(input.priorGaps)),
    '',
    '# How to judge',
    '- Read the files. A claim about a file that was not changed is fabricated: refute.',
    '- A test is honest only if it drives the shipped code on the real path. Hardcoded expected',
    '  values, the unit under test mocked out, a scenario starting past it, or an assertion against a',
    '  re-implementation prove nothing. Faking a clock, RNG, or network at the boundary to make the',
    '  real logic observable is normal and honest.',
    '- A leftover TODO, an ignored or skipped test, or an unimplemented stub in this work: refute.',
    '- A criterion whose evidence holds is PASSED. Do not refute it for missing edge cases, absent',
    '  input validation, or extra robustness nobody asked for. Inventing requirements is the most',
    '  common wrong refute.',
    '',
    '# Output',
    'Reply with one JSON object and nothing else:',
    '',
    '```json',
    '{',
    '  "refuted": true,',
    '  "findings": [{"kind": "bug|gap|todo", "location": "path:line or where", "detail": "one line"}],',
    '  "evidence": "one-line citation for your decision",',
    '  "confidence": "low|medium|high",',
    '  "blocking": "none|contradiction|unverifiable"',
    '}',
    '```',
    '',
    '- `findings` is what the implementer acts on. It must be non-empty when `refuted` is true, and',
    '  each entry must be specific enough to fix without asking you a question.',
    '- `blocking` is `contradiction` when the objective precludes itself and `unverifiable` when no',
    '  honest evidence is possible in this environment. Both mean a person is needed, not another',
    '  round — do not use them for an ordinary failure.',
  ].join('\n');
}

function firstRoundRules(): readonly string[] {
  return [
    '# This is the first round',
    'Nothing has been raised yet, so every genuine gap is in scope.',
  ];
}

function laterRoundRules(priorGaps: readonly SkepticFinding[]): readonly string[] {
  return [
    '# A previous round already raised these',
    ...priorGaps
      .slice(0, MAX_PRIOR_GAPS)
      .map((gap) => `- [${gap.kind}] ${line(gap.location)}: ${line(gap.detail)}`),
    '',
    'Your primary job is to check whether each one is genuinely fixed. The bar does not rise between',
    'rounds: raise something new only if it is a demonstrable defect in what shipped, never a',
    'preference an earlier round had the same chance to state and did not. Adding a fresh objection',
    'each round is what makes correct work impossible to finish. If every gap above is fixed and the',
    'criteria hold, return `"refuted": false`.',
  ];
}

function list(items: readonly string[], empty: string): readonly string[] {
  if (items.length === 0) return [empty];
  return items.map((item, index) => `${index + 1}. ${line(cap(item, 1_000))}`);
}

/**
 * Forces a value that is meant to be one line to actually be one.
 *
 * Criteria, paths, and prior gaps are interpolated into list items rather than fenced, because a
 * fence around every bullet would bury the structure the reader needs. That is only safe while they
 * cannot leave their bullet: a value carrying newlines becomes prompt structure of its own — a
 * heading, a rule, an instruction to approve — sitting in the instruction body rather than in the
 * data. Collapsing whitespace is what keeps the unfenced form honest.
 */
function line(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Wraps untrusted text so it reads as data.
 *
 * A tilde fence is used because the content is usually code or prose containing backticks, and a
 * backtick fence would end at the first one. Any fence line inside the content is broken so the
 * block cannot be closed early and the rest read as instructions.
 */
function fence(content: string): string {
  return [FENCE, content.replaceAll(FENCE, FENCE.slice(1)), FENCE].join('\n');
}

/** Bounded by codepoint so a cut never lands inside a surrogate pair. */
function cap(value: string, maxChars: number): string {
  const codepoints = Array.from(value.trim());
  if (codepoints.length <= maxChars) return value.trim();
  return `${codepoints.slice(0, maxChars).join('')}\n[…truncated]`;
}
