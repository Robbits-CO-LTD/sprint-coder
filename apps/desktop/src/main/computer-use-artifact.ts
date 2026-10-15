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
 * NFKC; CR and CRLF become LF; LF and TAB stay (a copied block keeps its lines and columns); every
 * other control or format character goes, Unicode Tag characters included. Bytes are counted
 * after that, against the input path's own bound, and an oversized value is refused rather than
 * cut — a cut is where an injected sentence would be made to end. A value that looks like a
 * secret is refused outright (§7.1 decision 6).
 */
export function prepareComputerUseArtifactText(raw: string): PreparedComputerUseArtifactText {
  const text = raw
    .normalize('NFKC')
    .replace(/\r\n?/gu, '\n')
    .replace(/[\p{Cc}\p{Cf}]/gu, (character) =>
      character === '\n' || character === '\t' ? character : '',
    );
  if (!/\S/u.test(text)) return { ok: false, reason: 'empty' };
  if (Buffer.byteLength(text, 'utf8') > COMPUTER_USE_ARTIFACT_LIMITS.maxBytes)
    return { ok: false, reason: 'too_large' };
  if (looksLikeComputerUseSecret(text)) return { ok: false, reason: 'secret' };
  return { ok: true, text, sizeClass: computerUseArtifactSizeClass(text) };
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
 */
export function looksLikeComputerUseSecret(text: string): boolean {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) return true;
  // A one-time code: the whole value is 6 to 8 digits.
  if (/^\s*\d{6,8}\s*$/u.test(text)) return true;
  // A card number: 13 to 19 digits, single spaces or hyphens allowed between them, passing Luhn.
  for (const match of text.matchAll(/(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/gu)) {
    const digits = match[0].replace(/[ -]/gu, '');
    if (digits.length >= 13 && digits.length <= 19 && passesLuhn(digits)) return true;
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
  ComputerUseArtifactBinding & { sourceSessionId: string; text: string; expiresAt: number }
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

  constructor(private readonly deps: Readonly<{ now: () => number; randomId?: () => string }>) {}

  /** Keeps a copied value. Null when it cannot be kept; why is not for the outer agent. */
  create(
    owner: ComputerUseArtifactBinding & Readonly<{ sourceSessionId: string }>,
    raw: string,
  ): ComputerUseArtifactReference | null {
    this.dropExpired();
    let held = 0;
    for (const artifact of this.artifacts.values()) if (artifact.taskId === owner.taskId) held += 1;
    if (held >= COMPUTER_USE_ARTIFACT_LIMITS.maxConcurrentPerTask) return null;
    const prepared = prepareComputerUseArtifactText(raw);
    if (!prepared.ok) return null;
    const artifactId = (this.deps.randomId ?? randomUUID)();
    this.artifacts.set(artifactId, {
      taskId: owner.taskId,
      turnId: owner.turnId,
      policyEpoch: owner.policyEpoch,
      sourceSessionId: owner.sourceSessionId,
      text: prepared.text,
      expiresAt: this.deps.now() + COMPUTER_USE_ARTIFACT_LIMITS.ttlMs,
    });
    return { artifactId, kind: 'text', sizeClass: prepared.sizeClass };
  }

  /**
   * Hands the texts over and forgets them, all or nothing. Null unless every id names a live
   * artifact of this exact binding; a refusal consumes nothing.
   */
  take(
    artifactIds: readonly string[],
    binding: ComputerUseArtifactBinding,
  ): readonly string[] | null {
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
    for (const artifactId of artifactIds) this.artifacts.delete(artifactId);
    return found.map((artifact) => artifact.text);
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
