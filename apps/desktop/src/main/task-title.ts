// Automatic Task naming from the first user message (issue #4).
//
// Local derivation, not a model summary. The issue left the choice open; this is the option that
// costs no extra provider call, is instant, is deterministic (so it is testable and identical
// across runs), and works under the mock runtime — which matters because mock is the only runtime
// in SPRINT_CODER_E2E_MODE=dev. A model-generated summary would read better but needs a budget, a
// latency window, and a fallback for when it fails; the acceptance criterion "命名に失敗しても会話
// 自体は継続する" is satisfied trivially here because there is nothing to fail.

/**
 * Longest title this produces, in code points.
 *
 * The sidebar row ellipsizes with CSS at roughly 30 half-width characters, so this is not about
 * fitting the row — it is about what `taskSummarySchema` accepts (max 200) and about keeping the
 * `/resume`-style listing readable. 60 leaves room for a meaningful Japanese phrase (Japanese
 * carries far more meaning per code point than English) while staying well under the schema bound.
 */
export const AUTO_TITLE_MAX_LENGTH = 60;

/** Appended when the message was truncated, so a cut-off title does not read as the whole ask. */
const ELLIPSIS = '…';

/**
 * A line has to contain at least one of these to be worth naming a Task after.
 *
 * Stated as what counts rather than as what to reject, because the reject-list version gets this
 * wrong: emoji live in Unicode category `So`, so a `\p{S}`-based "is this all punctuation?" test
 * throws away a perfectly good "🚀 リリース準備" — and a message of nothing but emoji is still a
 * label the user will recognise, unlike one of nothing but "...".
 */
const CARRIES_MEANING = /[\p{L}\p{N}\p{Extended_Pictographic}]/u;

/**
 * Derives a Task title from the first user message, or null when nothing usable is left.
 *
 * Returning null (rather than a degenerate title) is what lets the caller leave the default in
 * place: a message that is only whitespace, only a code fence, or only punctuation would otherwise
 * produce a title that is worse than "新しいタスク".
 */
export function deriveTaskTitle(message: string): string | null {
  const firstLine = firstMeaningfulLine(message);
  if (firstLine === null) return null;

  const cleaned = stripDecoration(firstLine);
  if (cleaned === '' || !CARRIES_MEANING.test(cleaned)) return null;

  // Code points, not UTF-16 units: slicing mid-surrogate would corrupt an emoji or a rarer CJK
  // character into a lone half, and `taskSummarySchema` would happily store the mojibake.
  const characters = Array.from(cleaned);
  if (characters.length <= AUTO_TITLE_MAX_LENGTH) return cleaned;
  return `${characters.slice(0, AUTO_TITLE_MAX_LENGTH).join('').trimEnd()}${ELLIPSIS}`;
}

/**
 * First line with actual content, skipping the openers people habitually put above their real ask.
 *
 * A multi-line paste usually leads with a greeting, a fence, or a heading marker; taking line 1
 * verbatim would name a whole Task "```" or "こんにちは". Only a bounded prefix is skipped so a
 * message that is genuinely nothing but boilerplate still falls back to that boilerplate rather
 * than scanning to the end of a 100k-character paste.
 */
function firstMeaningfulLine(message: string): string | null {
  const lines = message.split(/\r?\n/, 24);
  let inFence = false;
  let fallback: string | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') continue;
    if (/^(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (fallback === null) fallback = line;
    if (isGreeting(line)) continue;
    return line;
  }
  return fallback;
}

/** Standalone pleasantries only. Anything with a real request attached is left alone. */
function isGreeting(line: string): boolean {
  return /^(こんにちは|こんばんは|おはよう(ございます)?|お疲れ様?で?す?|hi|hello|hey|yo)[!!。.、,]*$/i.test(
    line,
  );
}

/**
 * Strips markup that carries no meaning in a one-line label.
 *
 * Deliberately conservative: this removes leading structural markers and collapses whitespace, but
 * never rewrites the words themselves. A title that does not match what the user typed is harder to
 * recognise in the sidebar than one that keeps a stray asterisk.
 */
function stripDecoration(line: string): string {
  return (
    line
      // Leading Markdown structure: heading hashes, blockquote carets, list bullets, ordered-list
      // numbers, and task-list checkboxes.
      .replace(/^\s*#{1,6}\s+/, '')
      .replace(/^\s*>+\s*/, '')
      .replace(/^\s*[-*+]\s+(\[[ xX]\]\s+)?/, '')
      .replace(/^\s*\d+[.)]\s+/, '')
      // Inline emphasis/code around the whole line, e.g. "**バグを直して**" or "`npm test`が落ちる".
      .replace(/[*_`]+/g, '')
      // Any residual control characters, plus every whitespace run collapsed so a tab-indented
      // paste does not become a title full of gaps.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}
