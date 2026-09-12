import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { redactSecrets } from './secret-redactor';

export const PROVIDER_DISCLOSURE_CLASSIFIER_VERSION = 'provider-disclosure-v4';

export type ProviderDisclosureClassification = 'safe' | 'sensitive' | 'uncertain';

export type ProviderDisclosureAssessment = Readonly<{
  classification: ProviderDisclosureClassification;
  reasons: readonly string[];
  sourceDigest: string;
  disclosedDigest: string;
  redactedContent: string;
  preview: string;
  classifierVersion: typeof PROVIDER_DISCLOSURE_CLASSIFIER_VERSION;
}>;

const CREDENTIAL_FILENAME =
  /^(?:\.env(?:\..+)?|\.npmrc|\.pypirc|\.netrc|credentials?|secrets?(?:\..+)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|service[-_.]?account(?:\.json)?)$/iu;
const URI_USERINFO = /\b([a-z][a-z0-9+.-]{0,31}:\/\/)([^\s/@:]{1,256})(?::([^\s/@]{0,256}))?@/giu;
const SLACK_TOKEN = /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gu;
const GITLAB_TOKEN = /\bglpat-[A-Za-z0-9_-]{10,}\b/gu;
const PROVIDER_TOKEN =
  /\b(?:sk-(?:ant|proj)-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{20,})\b/gu;
const COOKIE_VALUE = /(?<![a-z0-9_-])(?:set-cookie|cookie)\s*[:=]\s*[^\r\n]{8,}/giu;
const STRUCTURED_CREDENTIAL_FIELD =
  /["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|password|passwd|client[_-]?secret|private[_-]?key|cookie)["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]{4,})/giu;
const ENTROPY_CANDIDATE = /(?<![A-Za-z0-9_-])[A-Za-z0-9_+/=-]{24,}(?![A-Za-z0-9_-])/gu;

export function assessProviderDisclosure(
  content: string,
  relativePath?: string,
): ProviderDisclosureAssessment {
  return assessDisclosure(content, relativePath, []);
}

/** Roots must come from Main's sealed Turn workspace, never from Provider/Renderer text. */
export function assessProviderEgressDisclosure(
  content: string,
  knownWorkspaceRoots: readonly string[] = [],
): ProviderDisclosureAssessment {
  return assessDisclosure(content, undefined, knownWorkspaceRoots);
}

function assessDisclosure(
  content: string,
  relativePath: string | undefined,
  knownWorkspaceRoots: readonly string[],
): ProviderDisclosureAssessment {
  const reasons = new Set<string>();
  const baselineRedacted = redactSecrets(content);
  if (relativePath !== undefined && CREDENTIAL_FILENAME.test(basename(relativePath)))
    reasons.add('credential-prone-filename');
  if (matches(URI_USERINFO, content)) reasons.add('uri-userinfo');
  if (matches(PROVIDER_TOKEN, content)) reasons.add('ai-provider-token');
  if (matches(SLACK_TOKEN, content)) reasons.add('slack-token');
  if (matches(GITLAB_TOKEN, content)) reasons.add('gitlab-token');
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/iu.test(content))
    reasons.add('private-key');
  if (matches(COOKIE_VALUE, content)) reasons.add('cookie');
  if (matches(STRUCTURED_CREDENTIAL_FIELD, content)) reasons.add('credential-field');
  if (baselineRedacted !== content) reasons.add('known-secret-pattern');

  const contentRootSpans = knownRootSpans(content, knownWorkspaceRoots);
  const highEntropy = [...content.matchAll(ENTROPY_CANDIDATE)].some((match) =>
    isSensitiveEntropyCandidate(match[0], match.index, contentRootSpans),
  );
  if (highEntropy) reasons.add('high-entropy-value');

  const directSensitive = [...reasons].some((reason) => reason !== 'credential-prone-filename');
  const classification: ProviderDisclosureClassification = directSensitive
    ? 'sensitive'
    : reasons.has('credential-prone-filename')
      ? 'uncertain'
      : 'safe';
  let redactedContent = baselineRedacted
    .replace(URI_USERINFO, '$1[REDACTED]@')
    .replace(SLACK_TOKEN, '[REDACTED_SLACK_TOKEN]')
    .replace(GITLAB_TOKEN, '[REDACTED_GITLAB_TOKEN]')
    .replace(PROVIDER_TOKEN, '[REDACTED_PROVIDER_TOKEN]')
    .replace(COOKIE_VALUE, (value) => `${value.slice(0, value.search(/[:=]/u) + 1)}[REDACTED]`)
    .replace(STRUCTURED_CREDENTIAL_FIELD, (value) => {
      const separator = value.search(/[:=]/u);
      return separator < 0 ? '[REDACTED_CREDENTIAL]' : `${value.slice(0, separator + 1)}[REDACTED]`;
    });
  if (highEntropy) {
    const redactedRootSpans = knownRootSpans(redactedContent, knownWorkspaceRoots);
    redactedContent = redactedContent.replace(ENTROPY_CANDIDATE, (candidate, offset: number) =>
      isSensitiveEntropyCandidate(candidate, offset, redactedRootSpans)
        ? '[REDACTED_HIGH_ENTROPY]'
        : candidate,
    );
  }
  // A credential-prone file with no recognized token is precisely the case where regex-based
  // redaction cannot establish that any preview or Provider payload is safe. Disclose only an
  // explicit placeholder until the classifier can prove which bytes are non-secret.
  if (classification === 'uncertain') redactedContent = '[REDACTED_UNCERTAIN_CREDENTIAL_FILE]';
  const sourceDigest = sha256(content);
  const disclosedDigest = sha256(redactedContent);
  return Object.freeze({
    classification,
    reasons: Object.freeze([...reasons].sort()),
    sourceDigest,
    disclosedDigest,
    redactedContent,
    preview: boundedPreview(redactedContent),
    classifierVersion: PROVIDER_DISCLOSURE_CLASSIFIER_VERSION,
  });
}

function boundedPreview(content: string): string {
  const value = content.slice(0, 2_048);
  return content.length > value.length ? `${value}\n…[preview truncated]` : value;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function isHighEntropyCandidate(candidate: string): boolean {
  if (/^(?:[a-f0-9]{24,}|[A-Z0-9_]{24,})$/u.test(candidate)) return false;
  if (candidate === 'abcdefghijklmnopqrstuvwxyz') return false;
  if (
    /^(?:sha256-[A-Za-z0-9+/]{43}=|sha384-[A-Za-z0-9+/]{64}|sha512-[A-Za-z0-9+/]{86}==)$/u.test(
      candidate,
    )
  )
    return false;
  return shannonEntropy(candidate) >= 4.25;
}

/** A Main-issued root occurrence inside the scanned text, bounded by real path separators. */
type KnownRootSpan = Readonly<{ start: number; end: number }>;

const ABSOLUTE_ROOT = /^(?:\/|[A-Za-z]:\/)/u;
/** A root preceded or followed by these is a longer name or another path, not the root itself. */
const ROOT_PREFIX_CHARACTER = /[A-Za-z0-9_+.~/\\-]/u;
const ROOT_SUFFIX_CHARACTER = /[A-Za-z0-9_+.~=-]/u;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * Locate every occurrence of a Main-issued Workspace root. A Worker cannot work without naming
 * its own isolation worktree, and that directory is generated by Main (or chosen by the operator),
 * so the root path itself is not a secret. Matching stays segment-exact: a root that continues
 * into a longer name, or that appears embedded in a token, yields no span at all.
 */
function knownRootSpans(
  content: string,
  knownWorkspaceRoots: readonly string[],
): readonly KnownRootSpan[] {
  const spans: KnownRootSpan[] = [];
  for (const root of knownWorkspaceRoots) {
    const normalized = root.replaceAll('\\', '/').replace(/\/+$/u, '');
    if (!ABSOLUTE_ROOT.test(normalized)) continue;
    const segments = normalized.split('/');
    if (segments.slice(1).some((segment) => segment === '' || segment === '.' || segment === '..'))
      continue;
    // Accept the same root spelled with POSIX, Windows, or JSON-escaped Windows separators.
    const pattern = new RegExp(segments.map(escapeRegExp).join('(?:/|\\\\{1,2})'), 'gu');
    for (const match of content.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      if (start > 0 && ROOT_PREFIX_CHARACTER.test(content.charAt(start - 1))) continue;
      if (end < content.length && ROOT_SUFFIX_CHARACTER.test(content.charAt(end))) continue;
      spans.push({ start, end });
    }
  }
  return spans;
}

function isSensitiveEntropyCandidate(
  candidate: string,
  offset: number,
  rootSpans: readonly KnownRootSpan[],
): boolean {
  if (!isHighEntropyCandidate(candidate)) return false;
  // Only the bytes of a Main-issued root are exempt. What the candidate adds below the root, and
  // every high-entropy value outside one, is rescanned exactly as it would be without any root.
  const end = offset + candidate.length;
  const covering = rootSpans
    .filter((span) => span.start < end && span.end > offset)
    .sort((left, right) => left.start - right.start);
  if (covering.length === 0) return true;
  const remainders: string[] = [];
  let cursor = offset;
  for (const span of covering) {
    if (span.start > cursor) remainders.push(candidate.slice(cursor - offset, span.start - offset));
    cursor = Math.max(cursor, span.end);
  }
  if (cursor < end) remainders.push(candidate.slice(cursor - offset));
  return remainders.some((remainder) => {
    ENTROPY_CANDIDATE.lastIndex = 0;
    return [...remainder.matchAll(ENTROPY_CANDIDATE)].some((match) =>
      isHighEntropyCandidate(match[0]),
    );
  });
}

function matches(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(value);
}
