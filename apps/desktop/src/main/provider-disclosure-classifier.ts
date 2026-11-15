import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { redactSecrets } from './secret-redactor';

export const PROVIDER_DISCLOSURE_CLASSIFIER_VERSION = 'provider-disclosure-v6';

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
/**
 * A URL whose path is itself the credential: anyone holding it can post as the hook or the bot.
 * Named by its host and path shape, so it is stopped without guessing at how random it looks.
 */
const WEBHOOK_URL =
  /(https?:\/\/(?:hooks\.slack\.com\/(?:services|workflows|triggers)\/|(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/|api\.telegram\.org\/(?:file\/)?bot))[A-Za-z0-9_:/-]{8,}/giu;
const ENTROPY_CANDIDATE = /(?<![A-Za-z0-9_-])[A-Za-z0-9_+/=-]{24,}(?![A-Za-z0-9_-])/gu;

/**
 * Classify file content before it is disclosed to a Provider as context. Besides the recognized
 * credential shapes, a long random-looking value is treated as a possible secret here: a file is
 * read without the user having typed it, so an unlabeled key in it would otherwise go unnoticed.
 */
export function assessProviderDisclosure(
  content: string,
  relativePath?: string,
): ProviderDisclosureAssessment {
  return assessDisclosure(content, relativePath, true);
}

/**
 * Classify what a Turn is about to send to a Provider. Only recognized credential shapes stop the
 * send. A long random-looking value alone does not: URLs, hashes, IDs and base64 are ordinary in a
 * conversation, and guessing at them stopped ordinary requests and then every later Turn of the Task
 * that sent the same conversation again.
 */
export function assessProviderEgressDisclosure(content: string): ProviderDisclosureAssessment {
  return assessDisclosure(content, undefined, false);
}

function assessDisclosure(
  content: string,
  relativePath: string | undefined,
  scanEntropy: boolean,
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
  if (matches(WEBHOOK_URL, content)) reasons.add('webhook-url');
  if (baselineRedacted !== content) reasons.add('known-secret-pattern');

  const contentDocumentSpans = ordinaryDocumentSpans(content, relativePath);
  const highEntropy =
    scanEntropy &&
    [...content.matchAll(ENTROPY_CANDIDATE)].some((match) =>
      isSensitiveEntropyCandidate(match[0], match.index, contentDocumentSpans),
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
    })
    .replace(WEBHOOK_URL, '$1[REDACTED_WEBHOOK]');
  if (highEntropy) {
    const redactedDocumentSpans = ordinaryDocumentSpans(redactedContent, relativePath);
    redactedContent = redactedContent.replace(ENTROPY_CANDIDATE, (candidate, offset: number) =>
      isSensitiveEntropyCandidate(candidate, offset, redactedDocumentSpans)
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

type TextSpan = Readonly<{ start: number; end: number }>;

function ordinaryIdentifier(value: string): boolean {
  return (
    /^(?:[a-z]{3,}|[A-Z][a-z]{2,})(?:[A-Z][a-z]{2,}){2,}$/u.test(value) ||
    /^[a-z]{3,}(?:_[a-z]{3,}){2,}$/u.test(value) ||
    /^[a-z]{3,}(?:-[a-z]{3,}){2,}$/u.test(value)
  );
}

function ordinaryDocumentPath(value: string): boolean {
  if (!value.includes('/') || !/^[A-Za-z/._-]+$/u.test(value)) return false;
  return value
    .split('/')
    .every(
      (segment) =>
        segment !== '' &&
        segment
          .split('.')
          .every(
            (name) =>
              name !== '' &&
              (!isHighEntropyCandidate(name) || ordinaryIdentifier(name)) &&
              (ordinaryIdentifier(name) ||
                name
                  .split(/[_-]/u)
                  .every((word) => /^(?:[a-z]+|[A-Z][a-z]+|[A-Z]{2,})$/u.test(word))),
          ),
    );
}

/** File context alone is insufficient: accept only bounded document syntax and naming shapes. */
function ordinaryDocumentSpans(
  content: string,
  relativePath: string | undefined,
): readonly TextSpan[] {
  if (relativePath === undefined || !/\.(?:md|markdown|txt)$/iu.test(relativePath)) return [];
  const spans: TextSpan[] = [];
  for (const match of content.matchAll(/`([^`\r\n]+)`/gu)) {
    if (ordinaryIdentifier(match[1]!) || ordinaryDocumentPath(match[1]!))
      spans.push({ start: match.index + 1, end: match.index + match[0].length - 1 });
  }
  for (const match of content.matchAll(/https?:\/\/[^\s<>"'`()[\]]+/gu)) {
    try {
      const url = new URL(match[0]);
      if (url.username || url.password) continue;
      // Validate the original spelling too; URL normalization must not hide escaped bytes.
      // Only the host/path is eligible; query and fragment bytes always keep the strict scan.
      const suffix = match[0].search(/[?#]/u);
      const prefix = suffix < 0 ? match[0] : match[0].slice(0, suffix);
      const address = prefix.replace(/^https?:\/\//u, '').replace(/\/$/u, '');
      if (ordinaryDocumentPath(address))
        spans.push({ start: match.index, end: match.index + prefix.length });
    } catch {
      // Malformed URLs remain subject to the ordinary secret scan.
    }
  }
  return spans;
}

function isSensitiveEntropyCandidate(
  candidate: string,
  offset: number,
  documentSpans: readonly TextSpan[],
): boolean {
  if (!isHighEntropyCandidate(candidate)) return false;
  return !documentSpans.some(
    (span) => span.start <= offset && span.end >= offset + candidate.length,
  );
}

function matches(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(value);
}
