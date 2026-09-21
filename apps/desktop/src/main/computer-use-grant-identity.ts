import { createHash } from 'node:crypto';

/**
 * What an application grant is bound to (ADR v2 §6.2, §6.3).
 *
 * A leaf on purpose: no import of the controller, the store, or the native host. Everything here is
 * a function of its arguments, which is what makes "would this grant still match?" answerable in a
 * test without a database or a native boundary — and what keeps the module graph acyclic, which the
 * close-budget regression in `computer-use-native-module-graph.test.ts` exists to protect.
 */

export type ComputerAppGrantPlatform = 'darwin' | 'win32';
export type ComputerAppGrantIdentityKind = 'verified-signed' | 'unverified';

/**
 * The identity facts a grant records, derived from what this installation can actually verify.
 *
 * V1's stored identity does not carry a Windows publisher common name, so `publisher` is null there
 * rather than a digest wearing a publisher's clothes: the settings screen prints this field as a
 * verified fact, and a field that is sometimes a name and sometimes a hash is not a verified fact.
 * The same rule governs every nullable below — an attribute this installation cannot observe is
 * null, never a stand-in.
 */
export type ComputerAppGrantIdentity = Readonly<{
  platform: ComputerAppGrantPlatform;
  identityKind: ComputerAppGrantIdentityKind;
  /** `H(...)` over the fields ADR v2 §6.2 names for this platform and signing class. */
  grantIdentityDigest: string;
  /** macOS: bundle id. Windows: package family name, else the canonical image leaf name. */
  appId: string;
  /** macOS: Team ID. Windows: null until S5 carries a signer CN. */
  publisher: string | null;
  signingIdentifier: string | null;
  signerDigest: string | null;
  packageFamilyName: string | null;
  /** Normalised, never displayed: a re-verification input, and a path is a V1 privacy boundary. */
  executablePath: string;
  executableDigest: string | null;
  cdHash: string | null;
}>;

/**
 * Domain separator and format version for `grantIdentityDigest`.
 *
 * Bumping it invalidates every stored digest, which is the correct outcome: a changed derivation
 * means the stored digest no longer means what the new code thinks it means, and a grant that cannot
 * be re-derived must fall back to asking the user rather than matching by accident.
 */
export const COMPUTER_APP_GRANT_IDENTITY_VERSION = 1;

/**
 * Which fields decide whether a stored grant still describes the application in front of us.
 *
 * Split into three unions whose combination is checked against the record type below, so a field
 * added to `ComputerAppGrantIdentity` is a compile error until someone has decided which group it
 * belongs in. That decision is the security-relevant one: silently landing in none of them would
 * mean a new identity attribute could change without invalidating any grant.
 */
type GrantIdentityComparedField =
  | 'platform'
  | 'identityKind'
  // Covers, per platform: bundle id + Team ID + signing identifier (macOS), signer digest + image
  // leaf + parent directory (Windows Win32), package family + signer digest (Windows package), and
  // executable path + executable digest (unverified).
  | 'grantIdentityDigest'
  // Compared on top of the digest for every identity *except* a Windows package — see
  // `grantIdentityComparesExecutablePath`. The macOS derivation deliberately excludes the path so
  // that an ordinary in-place update keeps the grant, and "same signer, different location" is a
  // different application (ADR v2 §6.3) which has to stop matching.
  | 'executablePath';

/**
 * Compared only for `unverified` applications, where the executable digest *is* the identity, and
 * ignored for signed ones, where it moves on every ordinary update (ADR v2 §6.2.1).
 */
type GrantIdentityComparedWhenUnverifiedField = 'executableDigest';

/**
 * Recorded and shown, never compared.
 *
 * `cdHash` moves whenever a signed application is updated; §6.2.1 keeps the grant and records the
 * change instead of re-asking. The rest are display facts derived from the digest inputs, so they
 * cannot move without the digest moving.
 */
type GrantIdentityRecordedOnlyField =
  'appId' | 'publisher' | 'signingIdentifier' | 'signerDigest' | 'packageFamilyName' | 'cdHash';

type GrantIdentityClassifiedField =
  | GrantIdentityComparedField
  | GrantIdentityComparedWhenUnverifiedField
  | GrantIdentityRecordedOnlyField;
type UnclassifiedGrantIdentityField = Exclude<
  keyof ComputerAppGrantIdentity,
  GrantIdentityClassifiedField
>;
// A field added to `ComputerAppGrantIdentity` and to neither list above fails to compile here.
const GRANT_IDENTITY_FIELDS_ARE_CLASSIFIED: UnclassifiedGrantIdentityField extends never
  ? true
  : never = true;
void GRANT_IDENTITY_FIELDS_ARE_CLASSIFIED;

/**
 * Why a stored grant no longer applies (ADR v2 §6.3).
 *
 * `denied_class` is a revocation — the ruleset now forbids this class of application, so the user is
 * not asked again. The others are re-confirmations: the next request raises a card.
 */
export type ComputerAppGrantMismatch =
  'denied_class' | 'signing_class_changed' | 'identity_changed' | 'executable_changed';

/**
 * Derives the grant identity from the identity record V1 already stores for an application.
 *
 * Returns null rather than a partial identity. Every caller treats null as "no grant is possible for
 * this application", which is the fail-closed answer: a malformed or incomplete identity must not
 * produce a digest that some other application could also produce.
 */
export function computerAppGrantIdentityFrom(identity: unknown): ComputerAppGrantIdentity | null {
  if (typeof identity !== 'object' || identity === null || Array.isArray(identity)) return null;
  const record = identity as Record<string, unknown>;
  const text = (key: string): string | null => {
    const value = record[key];
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  };
  const digest = (key: string): string | null => {
    const value = text(key);
    return value !== null && /^[a-f0-9]{64}$/u.test(value) ? value : null;
  };
  const platform = record['platform'];
  if (platform !== 'darwin' && platform !== 'win32') return null;
  const rawExecutablePath = text('executablePath');
  if (rawExecutablePath === null) return null;
  const executablePath = normalizeExecutablePath(platform, rawExecutablePath);
  const executableDigest = digest('executableDigest');

  if (platform === 'darwin') {
    const bundleId = text('bundleId');
    const teamId = text('teamId');
    const signingIdentifier = text('signingIdentifier');
    const signed = teamId !== null || signingIdentifier !== null;
    if (signed && bundleId === null) return null;
    if (!signed && executableDigest === null) return null;
    return Object.freeze({
      platform,
      identityKind: signed ? 'verified-signed' : 'unverified',
      grantIdentityDigest: signed
        ? grantDigest('darwin-signed', [bundleId, teamId, signingIdentifier])
        : grantDigest('unverified', [platform, executablePath, executableDigest]),
      appId: bundleId ?? executableLeafName(platform, executablePath),
      publisher: teamId,
      signingIdentifier,
      signerDigest: null,
      packageFamilyName: null,
      executablePath,
      executableDigest,
      cdHash: digest('cdHash'),
    });
  }

  const signerDigest = digest('signerDigest');
  const packageFamilyName = text('packageFamilyName');
  if (signerDigest === null && executableDigest === null) return null;
  const leaf = executableLeafName(platform, executablePath);
  return Object.freeze({
    platform,
    identityKind: signerDigest === null ? 'unverified' : 'verified-signed',
    grantIdentityDigest:
      signerDigest === null
        ? grantDigest('unverified', [platform, executablePath, executableDigest])
        : packageFamilyName === null
          ? grantDigest('win32-signed', [
              signerDigest,
              leaf,
              executableParentDirectory(platform, executablePath),
            ])
          : grantDigest('win32-package', [packageFamilyName, signerDigest]),
    appId: packageFamilyName ?? leaf,
    // V1 verifies a Windows signer by digest and never resolves its common name. Naming the digest
    // as the publisher would put an unreadable hash where the settings screen promises a publisher.
    publisher: null,
    signingIdentifier: null,
    signerDigest,
    packageFamilyName,
    executablePath,
    executableDigest,
    cdHash: null,
  });
}

/**
 * Whether a stored grant still describes the application observed now.
 *
 * Whole-identity equality over an explicit field list, not a deep compare: see the lists above for
 * which fields participate and why.
 */
export function computerAppGrantIdentityMatches(
  stored: ComputerAppGrantIdentity,
  observed: ComputerAppGrantIdentity,
): boolean {
  return computerAppGrantMismatch(stored, observed, false) === null;
}

/**
 * The single decision point for re-confirmation and revocation (ADR v2 §6.3).
 *
 * `deniedNow` is the deny-ruleset verdict for the application as the current ruleset sees it. It is
 * checked first, because a class that is now forbidden must be revoked outright rather than turned
 * into another card the user could approve.
 */
export function computerAppGrantMismatch(
  stored: ComputerAppGrantIdentity,
  observed: ComputerAppGrantIdentity,
  deniedNow: boolean,
): ComputerAppGrantMismatch | null {
  if (deniedNow) return 'denied_class';
  if (stored.platform !== observed.platform || stored.identityKind !== observed.identityKind)
    return 'signing_class_changed';
  if (
    stored.grantIdentityDigest !== observed.grantIdentityDigest ||
    (grantIdentityComparesExecutablePath(stored) &&
      stored.executablePath !== observed.executablePath)
  )
    return 'identity_changed';
  if (
    stored.identityKind === 'unverified' &&
    (stored.executableDigest === null || stored.executableDigest !== observed.executableDigest)
  )
    return 'executable_changed';
  return null;
}

/**
 * Whether the normalised executable path is part of this identity's equality.
 *
 * It is, for everything except a Windows packaged application. A package installs under
 * `WindowsApps\<PackageFullName>_<version>_<arch>__<publisherId>\`, so the *version is in the
 * directory name*: comparing the path would turn every ordinary Store update into
 * `identity_changed` and re-ask for permission the user already gave. The package's own identity is
 * stronger than a path anyway — package family name plus Authenticode signer are exactly what the
 * digest is derived from, and neither can be forged by installing somewhere else.
 *
 * A non-package Win32 executable keeps the comparison: there, "the same signer, in a different
 * directory" is a genuinely different application, and the parent directory is part of the digest
 * precisely so that it is.
 */
function grantIdentityComparesExecutablePath(identity: ComputerAppGrantIdentity): boolean {
  return !(
    identity.platform === 'win32' &&
    identity.identityKind === 'verified-signed' &&
    identity.packageFamilyName !== null
  );
}

/**
 * Whether a signed application was updated underneath a grant that survives it (ADR v2 §6.2.1).
 *
 * Not a mismatch: the grant continues, and the settings screen shows the date so an application that
 * changes suspiciously often is visible to the person who granted it.
 */
export function computerAppGrantCodeChanged(
  stored: ComputerAppGrantIdentity,
  observed: ComputerAppGrantIdentity,
): boolean {
  if (stored.identityKind !== 'verified-signed') return false;
  const changed = (left: string | null, right: string | null): boolean =>
    left !== null && right !== null && left !== right;
  return (
    changed(stored.cdHash, observed.cdHash) ||
    changed(stored.executableDigest, observed.executableDigest)
  );
}

/**
 * Length-prefixed, NUL-separated, variant-tagged.
 *
 * Without the length prefixes, `('ab', 'c')` and `('a', 'bc')` would hash alike once a separator can
 * appear inside a value — and an application controls neither of these fields, but it does control
 * how its bundle id is spelled. A null is a distinct token, never an empty string: "this
 * installation cannot see a Team ID" and "this application has an empty Team ID" are different
 * facts, and collapsing them is exactly the kind of forged-attribute equality §6.2 forbids.
 */
function grantDigest(variant: string, fields: readonly (string | null)[]): string {
  const hash = createHash('sha256');
  hash.update(`computer-app-grant-identity/v${COMPUTER_APP_GRANT_IDENTITY_VERSION}/${variant}`);
  for (const field of fields) {
    hash.update('\u0000');
    hash.update(field === null ? 'null' : `text:${field.length}:${field}`);
  }
  return hash.digest('hex');
}

/**
 * One spelling per path, so a grant is not defeated by a separator or a letter case.
 *
 * Windows paths are case-insensitive, so they fold; macOS paths are compared as written, because a
 * case-sensitive volume makes two differently-cased paths two different files and folding them would
 * make a grant match an application it was never given for.
 */
export function normalizeExecutablePath(platform: ComputerAppGrantPlatform, path: string): string {
  const trimmed = path.trim();
  if (platform === 'darwin') return trimmed.replace(/\/{2,}/gu, '/').replace(/(?!^)\/$/u, '');
  const backslashed = trimmed.replace(/\//gu, '\\');
  // A leading `\\` is a UNC prefix and is the one place a doubled separator is meaningful.
  const uncPrefix = backslashed.startsWith('\\\\') ? '\\\\' : '';
  return (
    uncPrefix +
    backslashed
      .slice(uncPrefix.length)
      .replace(/\\{2,}/gu, '\\')
      .replace(/(?!^)\\$/u, '')
  ).toLowerCase();
}

function executableLeafName(platform: ComputerAppGrantPlatform, path: string): string {
  const segments = normalizeExecutablePath(platform, path)
    .split(/[\\/]/u)
    .filter((segment) => segment !== '');
  return segments.at(-1) ?? path;
}

function executableParentDirectory(platform: ComputerAppGrantPlatform, path: string): string {
  const normalized = normalizeExecutablePath(platform, path);
  const segments = normalized.split(/[\\/]/u).filter((segment) => segment !== '');
  return segments.length <= 1 ? '' : segments.slice(0, -1).join('\\');
}
