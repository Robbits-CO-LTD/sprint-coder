// Adversarial verification: deciding whether work is actually done, without asking the worker.
//
// A Worker reporting `completed` is a claim, not evidence. assurance.ts already refuses to call a
// Turn complete until gating criteria carry Evidence Records, but nothing yet judges *whether the
// work meets the objective* — that judgement is the one an agent is worst placed to make about
// itself. This module is that judge: a panel of independent skeptics, each asked to refute the
// claim, aggregated into one verdict.
//
// Four decisions shape it, and each exists because the obvious alternative fails:
//
//   - **Bias to fail, per skeptic.** A skeptic that times out, dies, or emits unparseable output
//     becomes a refute, not a discarded vote. Missing evidence is evidence of nothing, and the cost
//     of passing broken work is far higher than one more round. The bias lives here, at the point
//     where the evidence went missing, rather than in the aggregator which only counts.
//
//   - **The resumed skeptic cannot carry an approval.** Skeptic 0 is reused across rounds so it
//     remembers what it already objected to, and that memory makes it the most likely to wave work
//     through. Its *approval* is therefore excluded from the quorum while its *refute* still counts.
//     Approval needs a strict majority of the cold panel — the skeptics that came to it fresh.
//
//   - **The bar must not rise between rounds.** A panel free to raise a new objection every round
//     never converges, and correct work fails for reasons nobody stated when it could still have
//     been cheaply addressed. Once a round has told the implementer what to fix, later rounds may
//     add only demonstrable defects, not fresh preferences.
//
//   - **Repetition is a signal, not a loop to run harder.** When consecutive rounds produce exactly
//     the same gaps, more rounds will not help; that is a stall to surface, not to spend on.
//
// Everything here is pure. Spawning skeptics, choosing a model, and enforcing timeouts belong to the
// harness; this module only parses what came back and decides what it means.

export type SkepticConfidence = 'low' | 'medium' | 'high';
export type SkepticBlocking = 'none' | 'contradiction' | 'unverifiable';
export type SkepticFindingKind = 'bug' | 'gap' | 'todo';

/** Why a skeptic's vote is a refute without the skeptic having said so. */
export type DegradedReason = 'timeout' | 'transport' | 'malformed' | 'cancelled';

export type SkepticFinding = Readonly<{
  /** `bug` and `todo` are demonstrable defects; `gap` is an unmet criterion or missing evidence. */
  kind: SkepticFindingKind;
  /** `path:line` when code-related, else where the gap lives ("no test for criterion 3"). */
  location: string;
  detail: string;
}>;

export type SkepticVerdict = Readonly<{
  /** 0 is the resumed gatekeeper; 1 and above are the cold panel. */
  skepticIndex: number;
  refuted: boolean;
  findings: readonly SkepticFinding[];
  evidence: string;
  confidence: SkepticConfidence;
  blocking: SkepticBlocking;
  /** `degraded` marks a vote this module synthesised because the skeptic produced nothing usable. */
  source: 'model' | 'degraded';
}>;

export type PanelResult = Readonly<{
  total: number;
  refutedCount: number;
  /** Whether the cold panel's approval majority was reached, before the decisive-refute override. */
  quorumAchieved: boolean;
  /** The outcome: quorum reached AND no decisive refute from the gatekeeper. */
  achieved: boolean;
  /** Deduplicated, sanitised, capped — what the implementer is told to fix. */
  gaps: readonly SkepticFinding[];
  /** Non-`none` when the panel says this needs a person, not another round. */
  blocking: SkepticBlocking;
}>;

/** Three gives a real majority: one rubber-stamp and one false refute both fail to decide. */
export const PANEL_SIZE_DEFAULT = 3;
export const PANEL_SIZE_MIN = 1;
/** Past five is cost without resolution; the votes stop changing the answer. */
export const PANEL_SIZE_MAX = 5;

/** Identical gaps this many rounds running means rounds are no longer buying anything. */
export const STALL_THRESHOLD = 2;

const MAX_FINDINGS_PER_VERDICT = 20;
const MAX_GAPS = 20;
/** Findings are inlined into the next round's prompt, so each one is bounded in codepoints. */
const MAX_DETAIL_CHARS = 800;
const MAX_LOCATION_CHARS = 256;
const MAX_EVIDENCE_CHARS = 800;

export function clampPanelSize(size: number): number {
  if (!Number.isSafeInteger(size)) return PANEL_SIZE_DEFAULT;
  return Math.min(PANEL_SIZE_MAX, Math.max(PANEL_SIZE_MIN, size));
}

/**
 * The vote to record when a skeptic produced nothing usable.
 *
 * Refuted, always. A panel that ignores its silent members quietly shrinks until one reachable
 * skeptic decides alone, and the round that loses two skeptics to a timeout is exactly the round
 * whose approval is worth least.
 */
export function degradedVerdict(skepticIndex: number, reason: DegradedReason): SkepticVerdict {
  return Object.freeze({
    skepticIndex,
    refuted: true,
    findings: Object.freeze([
      Object.freeze({
        kind: 'gap' as const,
        location: `skeptic ${skepticIndex}`,
        detail: `Verification did not complete (${reason}); the claim is unproven, not disproven.`,
      }),
    ]),
    evidence: `Skeptic ${skepticIndex} produced no verdict (${reason}).`,
    confidence: 'low',
    blocking: 'none',
    source: 'degraded',
  });
}

/**
 * Reads a skeptic's JSON verdict, or reports that it could not be read.
 *
 * Returns null rather than throwing so the caller can turn an unreadable verdict into a degraded
 * refute without a try/catch at every call site. A model that answers in the wrong shape has not
 * cleared the work; it has failed to say anything about it.
 */
export function parseSkepticVerdict(skepticIndex: number, value: unknown): SkepticVerdict | null {
  if (!isRecord(value)) return null;
  if (typeof value.refuted !== 'boolean') return null;
  if (!isConfidence(value.confidence)) return null;
  const blocking = value.blocking === undefined ? 'none' : value.blocking;
  if (!isBlocking(blocking)) return null;
  if (typeof value.evidence !== 'string' || value.evidence.trim().length === 0) return null;
  const rawFindings = value.findings === undefined ? [] : value.findings;
  if (!Array.isArray(rawFindings)) return null;

  const findings: SkepticFinding[] = [];
  for (const raw of rawFindings.slice(0, MAX_FINDINGS_PER_VERDICT)) {
    if (!isRecord(raw)) return null;
    if (!isFindingKind(raw.kind)) return null;
    if (typeof raw.location !== 'string' || typeof raw.detail !== 'string') return null;
    if (raw.detail.trim().length === 0) return null;
    findings.push(
      Object.freeze({
        kind: raw.kind,
        location: sanitize(raw.location, MAX_LOCATION_CHARS),
        detail: sanitize(raw.detail, MAX_DETAIL_CHARS),
      }),
    );
  }
  // A refute with nothing to fix leaves the implementer guessing, which is how a round is wasted.
  if (value.refuted && findings.length === 0) return null;

  return Object.freeze({
    skepticIndex,
    refuted: value.refuted,
    findings: Object.freeze(findings),
    evidence: sanitize(value.evidence, MAX_EVIDENCE_CHARS),
    confidence: value.confidence,
    blocking,
    source: 'model',
  });
}

/**
 * Counts the panel.
 *
 * Approval needs a strict majority of the *cold* panel — skeptic 0's approval is excluded, its
 * refute is not. The bar is taken from the cold panel's size rather than the total so it stays a
 * real majority even when skeptic 0 is missing from the results entirely; deriving it from the total
 * would silently become a plurality in that case. A sole judge (`total <= 1`) simply decides.
 *
 * A high-confidence refute from skeptic 0 overrides the count: it is the member that has seen every
 * previous round, so when it is certain the work is still broken, a fresh majority that disagrees is
 * more likely to be missing history than to be right.
 *
 * One vote per skeptic is the premise the majority rests on, so a repeated index is dropped rather
 * than counted twice: two copies of one approval would otherwise manufacture a quorum no second
 * skeptic ever agreed to. Only the first vote for an index stands, which keeps a retry that resent a
 * verdict from voting again.
 */
export function aggregatePanel(verdicts: readonly SkepticVerdict[]): PanelResult {
  const distinct = dedupeBySkeptic(verdicts);
  const total = distinct.length;
  // Defensive: an empty panel proves nothing, and "proves nothing" is a refusal here.
  if (total === 0)
    return Object.freeze({
      total: 0,
      refutedCount: 0,
      quorumAchieved: false,
      achieved: false,
      gaps: Object.freeze([]),
      blocking: 'none' as const,
    });

  const refutedCount = distinct.filter((verdict) => verdict.refuted).length;
  let quorumAchieved: boolean;
  if (total <= 1) {
    quorumAchieved = refutedCount === 0;
  } else {
    const cold = distinct.filter((verdict) => verdict.skepticIndex >= 1);
    const coldApprovals = cold.filter((verdict) => !verdict.refuted).length;
    quorumAchieved = coldApprovals >= Math.floor(cold.length / 2) + 1;
  }

  const decisiveRefute = distinct.some(
    (verdict) => verdict.skepticIndex === 0 && verdict.refuted && verdict.confidence === 'high',
  );

  return Object.freeze({
    total,
    refutedCount,
    quorumAchieved,
    achieved: quorumAchieved && !decisiveRefute,
    gaps: collectGaps(distinct),
    blocking: panelBlocking(distinct),
  });
}

function dedupeBySkeptic(verdicts: readonly SkepticVerdict[]): readonly SkepticVerdict[] {
  const seen = new Set<number>();
  return verdicts.filter((verdict) => {
    if (seen.has(verdict.skepticIndex)) return false;
    seen.add(verdict.skepticIndex);
    return true;
  });
}

/**
 * Drops objections a later round had no business raising.
 *
 * Once a round has handed the implementer a list, the contract for the next round is that list. A
 * brand-new `gap` — an unmet criterion, a missing test — is a preference the earlier panel had the
 * same chance to state and did not, so raising it now moves the target. A `bug` or a `todo` is
 * different: those are defects in what shipped, and shipping a known defect to protect convergence
 * is the wrong trade.
 *
 * This is a mechanical stand-in for a judgement call, and it errs toward letting work finish. On the
 * first round (`priorGaps` empty) nothing is filtered.
 */
export function selectActionableGaps(
  current: readonly SkepticFinding[],
  priorGaps: readonly SkepticFinding[],
): readonly SkepticFinding[] {
  if (priorGaps.length === 0) return current;
  const prior = new Set(priorGaps.map(gapSignature));
  return Object.freeze(
    current.filter((finding) => prior.has(gapSignature(finding)) || finding.kind !== 'gap'),
  );
}

/**
 * Whether the last `STALL_THRESHOLD` rounds produced the same gaps.
 *
 * Compared as sets of signatures, so re-ordered findings still count as identical. An empty round is
 * never a stall — it is either a pass or a panel that failed to speak.
 */
export function isStalled(
  roundGaps: readonly (readonly SkepticFinding[])[],
  threshold = STALL_THRESHOLD,
): boolean {
  if (threshold < 2 || roundGaps.length < threshold) return false;
  const recent = roundGaps.slice(-threshold).map(signatureSet);
  const [first] = recent;
  if (first === undefined || first.size === 0) return false;
  return recent.every(
    (set) => set.size === first.size && [...first].every((signature) => set.has(signature)),
  );
}

/**
 * How a panel outcome enters the assurance state machine.
 *
 * `verification` is the ordinary "go fix it" that spends a repair round. A panel that could not be
 * heard from at all is an infrastructure problem, not the implementer's, so it retries instead of
 * consuming that round — otherwise a flaky network burns the one repair the Turn is allowed.
 */
export function panelFailureClass(
  result: PanelResult,
  verdicts: readonly SkepticVerdict[],
): 'verification' | 'infrastructure' | null {
  if (result.achieved) return null;
  const everyVoteDegraded =
    verdicts.length > 0 && verdicts.every((verdict) => verdict.source === 'degraded');
  return everyVoteDegraded ? 'infrastructure' : 'verification';
}

function collectGaps(verdicts: readonly SkepticVerdict[]): readonly SkepticFinding[] {
  const seen = new Set<string>();
  const gaps: SkepticFinding[] = [];
  for (const verdict of verdicts) {
    if (!verdict.refuted) continue;
    for (const finding of verdict.findings) {
      const signature = gapSignature(finding);
      if (seen.has(signature)) continue;
      seen.add(signature);
      gaps.push(finding);
      if (gaps.length === MAX_GAPS) return Object.freeze(gaps);
    }
  }
  return Object.freeze(gaps);
}

/**
 * The strongest blocking claim on the panel, but only from skeptics that actually refuted.
 *
 * `contradiction` and `unverifiable` both mean another round cannot help, so they outrank `none`;
 * between them `contradiction` is reported first because an objective that precludes itself is
 * answerable by the user, while an unverifiable one may only need a different environment.
 */
function panelBlocking(verdicts: readonly SkepticVerdict[]): SkepticBlocking {
  const claims = verdicts.filter((verdict) => verdict.refuted).map((verdict) => verdict.blocking);
  if (claims.includes('contradiction')) return 'contradiction';
  if (claims.includes('unverifiable')) return 'unverifiable';
  return 'none';
}

function signatureSet(findings: readonly SkepticFinding[]): Set<string> {
  return new Set(findings.map(gapSignature));
}

/** Two findings are the same gap when they name the same kind, place, and complaint. */
function gapSignature(finding: SkepticFinding): string {
  return [finding.kind, normalize(finding.location), normalize(finding.detail)].join(' ');
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Bounds a model-written string and defuses the tags it could use to escape its frame.
 *
 * Findings are inlined into the next round's prompt inside a reminder block, and they are the one
 * part of that block a model wrote. A verdict containing a literal closing tag could end the block
 * early and have the rest of its text read as instructions. A zero-width space after the opening
 * `<` breaks the tag while leaving it identical on screen.
 *
 * Flattened to a single line first. Every field here is contractually one line — a location, a
 * one-line detail, a one-line citation — and the next round pastes them into a prompt as list items.
 * A `detail` that kept its newlines would leave that list and become prompt structure of its own: a
 * heading, a rule, an instruction to approve. The character cap does not prevent that, because 800
 * characters is ample room to write one. Collapsing whitespace does, and costs nothing real, since
 * a field that was always meant to be one line loses no meaning by being made one.
 *
 * Capped by codepoint rather than by unit so the cut never lands inside a surrogate pair. The
 * ellipsis is counted against the cap rather than added past it, so the result is never longer than
 * `maxChars` asked for — the only characters that can exceed it are the zero-width spaces
 * neutralisation inserts, which is a cost paid per tag rather than per string.
 */
function sanitize(value: string, maxChars: number): string {
  const flattened = value.replace(/\s+/g, ' ').trim();
  const codepoints = Array.from(flattened);
  const capped =
    codepoints.length <= maxChars ? flattened : `${codepoints.slice(0, maxChars - 1).join('')}…`;
  return capped.replace(/<(\/?)(system-reminder|goal-state|user_query)\b/gi, '<​$1$2');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isConfidence(value: unknown): value is SkepticConfidence {
  return value === 'low' || value === 'medium' || value === 'high';
}

function isBlocking(value: unknown): value is SkepticBlocking {
  return value === 'none' || value === 'contradiction' || value === 'unverifiable';
}

function isFindingKind(value: unknown): value is SkepticFindingKind {
  return value === 'bug' || value === 'gap' || value === 'todo';
}
