import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { redactSecrets } from './secret-redactor';

export const PROVIDER_DISCLOSURE_CLASSIFIER_VERSION = 'provider-disclosure-v2';

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

  const highEntropy = [...content.matchAll(ENTROPY_CANDIDATE)].some(([candidate]) => {
    if (/^(?:[a-f0-9]{24,}|[A-Z0-9_]{24,})$/u.test(candidate)) return false;
    return shannonEntropy(candidate) >= 4.25;
  });
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
  if (highEntropy)
    redactedContent = redactedContent.replace(ENTROPY_CANDIDATE, (candidate) =>
      shannonEntropy(candidate) >= 4.25 ? '[REDACTED_HIGH_ENTROPY]' : candidate,
    );
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

function matches(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(value);
}
