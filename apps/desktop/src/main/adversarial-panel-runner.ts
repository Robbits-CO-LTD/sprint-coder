// Running the panel: N skeptics, whatever they return, one decision.
//
// adversarial-panel.ts decides what a set of verdicts means. This is the part that gets the verdicts
// — and it exists mostly to handle the ways a skeptic fails to produce one, because in practice that
// is the common case rather than the exceptional one. A model wraps its JSON in a fence, or explains
// itself first, or answers in the wrong shape, or never answers at all.
//
// Every one of those becomes a refute rather than an error. The panel is defined as N votes; a run
// that threw and stopped there would leave the caller to decide what a missing vote means, which is
// exactly the decision that must not be made ad hoc. So this never rejects: it always returns a full
// panel, and a skeptic that could not speak is recorded as having refused to clear the work.
//
// The runner is injected. What actually executes a skeptic — which runtime, which model, what budget
// — is a policy question that belongs to the caller, and keeping it out means the whole orchestration
// is testable without a provider.

import {
  aggregatePanel,
  clampPanelSize,
  degradedVerdict,
  panelFailureClass,
  parseSkepticVerdict,
  selectActionableGaps,
  PANEL_SIZE_DEFAULT,
  type PanelResult,
  type SkepticFinding,
  type SkepticVerdict,
} from './adversarial-panel';

/**
 * Executes one skeptic and returns whatever it said.
 *
 * Free to reject or hang; the panel converts both into a refute. The signal is aborted when the
 * skeptic runs past its deadline, so an implementation that honours it stops paying for a vote that
 * will not be counted.
 */
export type SkepticRunner = (input: {
  skepticIndex: number;
  prompt: string;
  signal: AbortSignal;
}) => Promise<string>;

export type PanelRun = Readonly<{
  result: PanelResult;
  verdicts: readonly SkepticVerdict[];
  /** The gaps to act on: the panel's gaps with later-round preferences filtered out. */
  actionableGaps: readonly SkepticFinding[];
  /** Ready for `recordAssuranceVerification`; null when the panel approved. */
  failureClass: 'verification' | 'infrastructure' | null;
}>;

/** Long enough for a skeptic to read a few files, short enough that a hung one is not the round. */
export const DEFAULT_SKEPTIC_TIMEOUT_MS = 120_000;

export async function runAdversarialPanel(input: {
  runner: SkepticRunner;
  prompt: string;
  panelSize?: number;
  priorGaps?: readonly SkepticFinding[];
  timeoutMs?: number;
}): Promise<PanelRun> {
  const size = clampPanelSize(input.panelSize ?? PANEL_SIZE_DEFAULT);
  const timeoutMs = input.timeoutMs ?? DEFAULT_SKEPTIC_TIMEOUT_MS;
  const verdicts = await Promise.all(
    Array.from({ length: size }, (_unused, skepticIndex) =>
      runOneSkeptic(input.runner, input.prompt, skepticIndex, timeoutMs),
    ),
  );
  const result = aggregatePanel(verdicts);
  return Object.freeze({
    result,
    verdicts: Object.freeze(verdicts),
    actionableGaps: selectActionableGaps(result.gaps, input.priorGaps ?? []),
    failureClass: panelFailureClass(result, verdicts),
  });
}

async function runOneSkeptic(
  runner: SkepticRunner,
  prompt: string,
  skepticIndex: number,
  timeoutMs: number,
): Promise<SkepticVerdict> {
  const controller = new AbortController();
  // `unref` is deliberate: a pending deadline must never be the reason the process stays alive.
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const answer = await Promise.race([
      runner({ skepticIndex, prompt, signal: controller.signal }),
      deadline(controller.signal),
    ]);
    if (answer === TIMED_OUT) return degradedVerdict(skepticIndex, 'timeout');
    const parsed = extractJsonObject(answer);
    if (parsed === null) return degradedVerdict(skepticIndex, 'malformed');
    return parseSkepticVerdict(skepticIndex, parsed) ?? degradedVerdict(skepticIndex, 'malformed');
  } catch {
    // A rejection carries no verdict, and its message is the provider's, not the skeptic's.
    return degradedVerdict(skepticIndex, 'transport');
  } finally {
    clearTimeout(timer);
  }
}

const TIMED_OUT = Symbol('skeptic timed out');

function deadline(signal: AbortSignal): Promise<typeof TIMED_OUT> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(TIMED_OUT);
      return;
    }
    signal.addEventListener('abort', () => resolve(TIMED_OUT), { once: true });
  });
}

/**
 * The largest a verdict can plausibly be. Findings are capped at 800 characters and there are at
 * most twenty of them, so this is generous by an order of magnitude.
 */
const MAX_VERDICT_CHARS = 64_000;
/** How far back from the end to look for a verdict a model buried under narration. */
const MAX_SCAN_CHARS = 128_000;
/** Enough candidates to find a concluding object; far short of one per brace in the answer. */
const MAX_SPANS = 20;

/**
 * Finds the JSON object in a model's answer.
 *
 * Asking for "one JSON object and nothing else" gets it most of the time, and the rest of the time
 * gets a fenced block, or a sentence of preamble, or both. Recovering those is worth doing: the
 * alternative is spending a whole round because a model was chatty.
 *
 * Tried in order of confidence — the whole answer, then a fenced block, then the last balanced brace
 * span, which is the one most likely to be the verdict when a model narrates and then concludes.
 * Anything that is not an object is rejected, so a bare array or string cannot reach the parser.
 *
 * Bounded at every step, because the input is a model's answer and this runs synchronously on the
 * main process after the answer arrives — past the timeout, which only races the runner. A span
 * scan that kept one slice per closing brace is quadratic in the nesting depth, so a deeply nested
 * answer would allocate gigabytes and stall the app. The scan therefore looks only at the tail, and
 * only at candidates small enough to be a verdict; a span too long to be one is never sliced.
 */
export function extractJsonObject(answer: string): unknown | null {
  const trimmed = answer.trim();
  const tail = trimmed.length > MAX_SCAN_CHARS ? trimmed.slice(-MAX_SCAN_CHARS) : trimmed;
  const candidates = [
    ...(trimmed.length <= MAX_VERDICT_CHARS ? [trimmed] : []),
    ...fencedBlocks(tail),
    ...balancedSpans(tail),
  ];
  for (const candidate of candidates) {
    const parsed = tryParseObject(candidate);
    if (parsed !== null) return parsed;
  }
  return null;
}

function tryParseObject(candidate: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(candidate);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function fencedBlocks(text: string): readonly string[] {
  const blocks: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const opening = text.indexOf('```', cursor);
    if (opening < 0) break;

    let contentStart = opening + 3;
    const language = text.slice(contentStart, contentStart + 5).toLowerCase();
    if (language === 'jsonc') contentStart += 5;
    else if (language.startsWith('json')) contentStart += 4;
    while (isFenceHeaderWhitespace(text[contentStart])) contentStart += 1;

    const closing = text.indexOf('```', contentStart);
    if (closing < 0) break;
    if (closing - contentStart <= MAX_VERDICT_CHARS) {
      blocks.push(text.slice(contentStart, closing).trim());
      if (blocks.length > MAX_SPANS) blocks.shift();
    }
    cursor = closing + 3;
  }
  return blocks.reverse();
}

function isFenceHeaderWhitespace(character: string | undefined): boolean {
  return character === ' ' || character === '\t' || character === '\r' || character === '\n';
}

/**
 * Balanced `{...}` spans small enough to be a verdict, newest first.
 *
 * Scans with string and escape awareness so a `}` inside a quoted value cannot close a span early —
 * which matters here, because a finding's `detail` is free text that regularly contains braces.
 *
 * Nothing is copied during the scan. The pass records index pairs and keeps only the last
 * [`MAX_SPANS`] of them, so the text is sliced at most that many times, at the end. Slicing as spans
 * were found — even while discarding all but the last few — is what makes nesting depth decide the
 * allocation: `{{{…}}}` nested k deep closes k spans of length 2, 4, 6 … 2k, so the copying alone
 * totals k² characters however few of the results are kept.
 */
function balancedSpans(text: string): readonly string[] {
  const ranges: { start: number; end: number }[] = [];
  const starts: number[] = [];
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') starts.push(index);
    else if (character === '}') {
      const start = starts.pop();
      if (start === undefined || index + 1 - start > MAX_VERDICT_CHARS) continue;
      ranges.push({ start, end: index + 1 });
      if (ranges.length > MAX_SPANS) ranges.shift();
    }
  }
  return ranges.reverse().map((range) => text.slice(range.start, range.end));
}
