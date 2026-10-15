import { randomUUID } from 'node:crypto';
import {
  COMPUTER_USE_ARTIFACT_LIMITS,
  type ComputerUseArtifactKind,
  type ComputerUseArtifactSizeClass,
} from '@sprint-coder/contracts';

/**
 * #785 (design `tasks/designs/t13-readback-design.md` C6, §4.1, §4.2, §7.1): what Main keeps when
 * an inner session copies a value out of an application, so that a later session can paste it
 * into another one without the text ever passing through the outer conversation.
 *
 * Pure parts and an in-memory store only. Nothing here reads a screen, writes to disk or reaches a
 * provider; the native read, the `copy` vocabulary and the paste path are later slices.
 */

export type ComputerUseArtifactRefusal = 'empty' | 'too_large' | 'secret';

export type PreparedComputerUseArtifactText =
  | Readonly<{ ok: true; text: string; sizeClass: ComputerUseArtifactSizeClass }>
  | Readonly<{ ok: false; reason: ComputerUseArtifactRefusal }>;

/**
 * The text exactly as it would be pasted, or why it cannot be kept.
 *
 * Normalised by `normalizeComputerUseArtifactText` (a copied block keeps its lines and columns;
 * Unicode Tag characters go). Bytes are counted
 * after that, against the input path's own bound, and an oversized value is refused rather than
 * cut — a cut is where an injected sentence would be made to end. A value that looks like a
 * secret is refused outright (§7.1 decision 6).
 */
export function prepareComputerUseArtifactText(raw: string): PreparedComputerUseArtifactText {
  const text = normalizeComputerUseArtifactText(raw);
  if (!/\S/u.test(text)) return { ok: false, reason: 'empty' };
  if (Buffer.byteLength(text, 'utf8') > COMPUTER_USE_ARTIFACT_LIMITS.maxBytes)
    return { ok: false, reason: 'too_large' };
  if (looksLikeComputerUseSecret(text)) return { ok: false, reason: 'secret' };
  return { ok: true, text, sizeClass: computerUseArtifactSizeClass(text) };
}

/** Text that has been through `normalizeComputerUseArtifactText`; secret detection takes only this. */
export type NormalizedComputerUseText = string & {
  readonly __normalizedComputerUseText: unique symbol;
};

/**
 * NFKC; CR, CRLF, U+2028 and U+2029 become LF; LF and TAB stay; every other control or format
 * character goes. Secrets are looked for in this form only: a full-width `ｇｈｐ＿…`, or a token
 * with zero-width characters inside it, becomes the plain token here and would slip past a check
 * made on the raw string.
 */
export function normalizeComputerUseArtifactText(raw: string): NormalizedComputerUseText {
  return raw
    .normalize('NFKC')
    .replace(/\r\n|[\r\u2028\u2029]/gu, '\n')
    .replace(/[\p{Cc}\p{Cf}]/gu, (character) =>
      character === '\n' || character === '\t' ? character : '',
    ) as NormalizedComputerUseText;
}

// What a person is shown of a value (design 4.5, R13). Visible escapes for what would otherwise
// make the screen say one thing and the paste another.
const EXCERPT_LIMIT = 256;
const LABEL_LIMIT = 64;
// Invisible without being a space: Hangul fillers, Braille blank, Mongolian vowel separator,
// combining grapheme joiner. (NFKC already turns the width variants into these.)
const INVISIBLE_FILLERS = /(?:\u115F|\u1160|\u3164|\uFFA0|\u2800|\u180E|\u034F)/u;
const VARIATION_SELECTOR = /[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/u;
const ESCAPED_CLASS = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}]/u;
const COMBINING = /\p{M}/u;

/** `⟦U+XXXX⟧` for one code point. */
function escapeCodePoint(codePoint: number): string {
  return `⟦U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}⟧`;
}

/**
 * Text made safe to look at: LF and TAB become `⏎` and `⇥`; control, format (bidirectional marks,
 * zero-width characters, Tag characters), private-use, unassigned, line and paragraph separators,
 * the fillers above, variation selectors, and combining marks beyond two in a row (or with nothing
 * to combine with) become `⟦U+XXXX⟧`. Cut to `limit` code points of the source, with `…` if cut.
 */
function escapeForDisplay(raw: string, limit: number): string {
  const characters = [...raw.normalize('NFKC').replace(/\r\n/gu, '\n')];
  const shown = characters.slice(0, limit);
  let output = '';
  let marks = 0;
  for (const character of shown) {
    const codePoint = character.codePointAt(0)!;
    if (
      COMBINING.test(character) &&
      !VARIATION_SELECTOR.test(character) &&
      !INVISIBLE_FILLERS.test(character)
    ) {
      marks += 1;
      output += marks > 2 || output === '' ? escapeCodePoint(codePoint) : character;
      continue;
    }
    marks = 0;
    if (character === '\n' || character === '\r') output += '⏎';
    else if (character === '\t') output += '⇥';
    else if (
      ESCAPED_CLASS.test(character) ||
      INVISIBLE_FILLERS.test(character) ||
      VARIATION_SELECTOR.test(character)
    )
      output += escapeCodePoint(codePoint);
    else output += character;
  }
  return characters.length > limit ? `${output}…` : output;
}

/** The excerpt of a value a person is asked about, or shown after a `copy` (256 code points). */
export function computerUseArtifactExcerpt(text: string): string {
  return escapeForDisplay(text, EXCERPT_LIMIT);
}

/** An application or window name from the screen, made safe to show next to an excerpt. */
export function computerUseDisplayLabel(raw: string): string {
  return escapeForDisplay(raw, LABEL_LIMIT);
}

/** The size the outer agent is told, in three steps (design §2.2 item 12). */
export function computerUseArtifactSizeClass(text: string): ComputerUseArtifactSizeClass {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= 256) return 'le_256';
  if (bytes <= 1_024) return 'le_1k';
  return 'le_4k';
}

const SECRET_PATTERNS: readonly RegExp[] = [
  // OpenAI / Anthropic style keys.
  /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{16,}/u,
  // GitHub tokens, classic and fine-grained.
  /(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{20,}/u,
  /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{20,}/u,
  // Slack tokens.
  /(?<![A-Za-z0-9])xox[abposr]-[A-Za-z0-9-]{10,}/u,
  // AWS access key ids.
  /(?<![A-Z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])/u,
  // Google API keys.
  /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}/u,
  // PEM private keys of any kind.
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u,
  // A JWT: a base64url JSON header, a payload and a signature.
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/u,
];

/**
 * Whether a value looks like a credential, a card number or a one-time code (§7.1 decision 6).
 *
 * Deterministic patterns only — a model asked "is this secret?" can be talked out of it by the very
 * screen it is judging. A false positive means something cannot be copied, which is acceptable.
 * Takes normalised text only (the type enforces it): on a raw string, full-width or zero-width
 * spellings of a token do not match.
 */
export function looksLikeComputerUseSecret(text: NormalizedComputerUseText): boolean {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) return true;
  // A one-time code: the whole value is 6 to 8 digits, as authenticator apps and SMS show them —
  // run together or split by single spaces or hyphens (`482913`, `482 913`, `1234-5678`).
  if (/^\s*\d(?:[ -]?\d){5,7}\s*$/u.test(text)) return true;
  // A card number: 13 to 19 digits passing Luhn, as a run of digit groups with a single space,
  // TAB, line feed or hyphen between them (a multi-line field may break a number across lines).
  // Every run of whole groups is tried (not only the whole chain), because a number followed by an
  // expiry date or a CVV, or preceded by a short number, is still a card number. Windows begin and
  // end at group boundaries only, and every group but the last has at least 4 digits (card numbers
  // print as 4-4-4-4, 4-6-5 and the like; only the tail may be short), so runs of short numbers
  // such as phone numbers are not read as cards. Cutting inside an unseparated group would let a
  // long id that merely contains a Luhn-valid slice be flagged. A window keeps one kind of
  // separator, and across TABs or line feeds every group but the last is exactly 4 digits: a number
  // broken across cells or lines still prints 4-4-4-4, while a table of plain numbers (TSV, one
  // value per line) would otherwise be read as cards almost every time. Bounded work: at most
  // ~2,000 groups per 4,096 bytes, each window at most 19 digits.
  for (const chain of text.matchAll(/\d(?:[ \t\n-]?\d)*/gu)) {
    // Groups at even indexes, the separator after group i at index 2i + 1.
    const parts = chain[0].split(/([ \t\n-])/u);
    const groupCount = (parts.length + 1) / 2;
    for (let first = 0; first < groupCount; first += 1) {
      let digits = '';
      for (let last = first; last < groupCount; last += 1) {
        if (last > first) {
          const separator = parts[2 * last - 1]!;
          const previous = parts[2 * (last - 1)]!;
          if (separator !== parts[2 * first + 1]) break;
          const lineOrCell = separator === '\t' || separator === '\n';
          // Only the last group of a window may be short (4-4-4-4-3, 4-4-4-1).
          if (lineOrCell ? previous.length !== 4 : previous.length < 4) break;
        }
        digits += parts[2 * last];
        if (digits.length > 19) break;
        if (digits.length >= 13 && passesLuhn(digits)) return true;
      }
    }
  }
  return false;
}

function passesLuhn(digits: string): boolean {
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/** Who an artifact belongs to. A Task, a Turn and a policy epoch; nothing else can name it. */
export type ComputerUseArtifactBinding = Readonly<{
  taskId: string;
  turnId: string;
  policyEpoch: number;
}>;

export type ComputerUseArtifactReference = Readonly<{
  artifactId: string;
  kind: ComputerUseArtifactKind;
  sizeClass: ComputerUseArtifactSizeClass;
}>;

type StoredArtifact = Readonly<
  ComputerUseArtifactBinding & {
    sourceSessionId: string;
    /** Where the value was read from, as the screen named it. Untrusted; for display only. */
    sourceLabel: string;
    sizeClass: ComputerUseArtifactSizeClass;
    text: string;
    expiresAt: number;
  }
>;

/**
 * Artifacts, in memory only (§4.2, R6). Never written to SQLite, a log or a crash report, and gone
 * with the process. An artifact is bound to the Task, Turn and policy epoch it was copied under,
 * lives for `ttlMs`, and is handed over exactly once: the session it is carried into takes it out
 * of the store and uses it up. Every way of not getting it — another Task or Turn, a changed
 * epoch, expiry, a used or unknown id — looks the same, so a probe learns nothing (N9–N11).
 */
export class ComputerUseArtifactStore {
  private readonly artifacts = new Map<string, StoredArtifact>();

  /**
   * `now` must be a monotonic clock (for example `performance.now()`), not `Date.now()`: a wall
   * clock that is adjusted would stretch or cut the TTL. Only differences are used.
   */
  constructor(private readonly deps: Readonly<{ now: () => number; randomId?: () => string }>) {}

  /**
   * Keeps a copied value. Null when it cannot be kept; why is not for the outer agent.
   *
   * What the same Task holds under another Turn or policy epoch is dropped first (§4.2: a policy
   * epoch change ends an artifact): `take` can never hand it over again, so it must not keep
   * using up the Task's allowance until the TTL. Done here, not in a separate hook, so the store
   * needs no wiring to an epoch-change signal.
   */
  create(
    owner: ComputerUseArtifactBinding & Readonly<{ sourceSessionId: string; sourceLabel?: string }>,
    raw: string,
  ): ComputerUseArtifactReference | null {
    this.dropExpired();
    let held = 0;
    for (const [artifactId, artifact] of this.artifacts) {
      if (artifact.taskId !== owner.taskId) continue;
      if (artifact.turnId !== owner.turnId || artifact.policyEpoch !== owner.policyEpoch)
        this.artifacts.delete(artifactId);
      else held += 1;
    }
    if (held >= COMPUTER_USE_ARTIFACT_LIMITS.maxConcurrentPerTask) return null;
    const prepared = prepareComputerUseArtifactText(raw);
    if (!prepared.ok) return null;
    const artifactId = (this.deps.randomId ?? randomUUID)();
    // An injected id that collides must not overwrite another artifact.
    if (this.artifacts.has(artifactId)) return null;
    this.artifacts.set(artifactId, {
      taskId: owner.taskId,
      turnId: owner.turnId,
      policyEpoch: owner.policyEpoch,
      sourceSessionId: owner.sourceSessionId,
      sourceLabel: owner.sourceLabel ?? '',
      sizeClass: prepared.sizeClass,
      text: prepared.text,
      expiresAt: this.deps.now() + COMPUTER_USE_ARTIFACT_LIMITS.ttlMs,
    });
    return { artifactId, kind: 'text', sizeClass: prepared.sizeClass };
  }

  /**
   * Hands the texts over and forgets them, all or nothing. Null unless every id names a live
   * artifact of this exact binding; a refusal consumes nothing.
   *
   * The creating session (`sourceSessionId`) is kept but not compared here: the taker is the new
   * inner session created by `computer_start { carry }`, which is a different session from the
   * one that copied by construction. Pinning that is the job of the slice that wires `carry`
   * (T15-8, design §4.4), where the taker's session id exists.
   */
  take(
    artifactIds: readonly string[],
    binding: ComputerUseArtifactBinding,
  ): readonly string[] | null {
    const found = this.lookup(artifactIds, binding);
    if (found === null) return null;
    for (const artifactId of artifactIds) this.artifacts.delete(artifactId);
    return found.map((artifact) => artifact.text);
  }

  /**
   * Whether every id names a live artifact of this exact binding, and what each holds, without
   * using any of them up. Main-internal: a paste needs the text to bind its card and its audit to
   * the action it will really send, but only `take` ends an artifact, so a denied card loses
   * nothing. Same refusal as `take` for any id that is not the caller's.
   */
  peek(
    artifactIds: readonly string[],
    binding: ComputerUseArtifactBinding,
  ): readonly string[] | null {
    return this.lookup(artifactIds, binding)?.map((artifact) => artifact.text) ?? null;
  }

  /**
   * What a person is told about artifacts, without their text: where each came from (untrusted,
   * to be escaped before it is shown) and how large it is. Same refusals as `take`. The value is
   * not in the result, so it can go where a label can.
   */
  describe(
    artifactIds: readonly string[],
    binding: ComputerUseArtifactBinding,
  ): readonly Readonly<{ sourceLabel: string; sizeClass: ComputerUseArtifactSizeClass }>[] | null {
    return (
      this.lookup(artifactIds, binding)?.map(({ sourceLabel, sizeClass }) => ({
        sourceLabel,
        sizeClass,
      })) ?? null
    );
  }

  private lookup(
    artifactIds: readonly string[],
    binding: ComputerUseArtifactBinding,
  ): readonly StoredArtifact[] | null {
    this.dropExpired();
    if (artifactIds.length === 0 || new Set(artifactIds).size !== artifactIds.length) return null;
    const found: StoredArtifact[] = [];
    for (const artifactId of artifactIds) {
      const artifact = this.artifacts.get(artifactId);
      if (
        artifact === undefined ||
        artifact.taskId !== binding.taskId ||
        artifact.turnId !== binding.turnId ||
        artifact.policyEpoch !== binding.policyEpoch
      )
        return null;
      found.push(artifact);
    }
    return found;
  }

  /** The Task ended: everything it held goes with it. */
  dropTask(taskId: string): void {
    for (const [artifactId, artifact] of this.artifacts)
      if (artifact.taskId === taskId) this.artifacts.delete(artifactId);
  }

  private dropExpired(): void {
    const now = this.deps.now();
    for (const [artifactId, artifact] of this.artifacts)
      if (artifact.expiresAt <= now) this.artifacts.delete(artifactId);
  }
}
