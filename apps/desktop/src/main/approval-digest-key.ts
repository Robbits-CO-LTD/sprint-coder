import { createHmac, randomBytes } from 'node:crypto';
import { closeSync, constants, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The per-install key that keys every digest taken over approval content.
 *
 * An unsalted hash is not the same as not keeping the content. A digest stored beside its byte
 * count lets anyone holding the database hash candidates offline until one matches, which recovers
 * exactly the low-entropy values a stdin write carries — the password typed for `sudo -S`, the
 * passphrase for `gpg --passphrase-fd 0` (Issue #473). An HMAC under a key that never enters the
 * database leaves the stored value unverifiable on its own, while staying deterministic enough for
 * `allow_task` to recognise a repeat of the same bytes.
 *
 * The key lives in one 32-byte file under the app's private directory at mode 0600, created on
 * first use and never read by the Renderer, never written to SQLite, and never logged.
 */
const KEY_BYTES = 32;
const KEY_DIRECTORY = 'approval-digest';
const KEY_FILE = 'content-mac.key';

let configuredDirectory: string | undefined;
let cachedKey: Buffer | undefined;

/**
 * Points the key at the app's private directory. Called once during Main startup, before any
 * approval can be raised.
 *
 * Without it the key is generated per process, which is safe but forgetful: an `allow_task` grant
 * recorded before a restart simply stops matching and the user is asked again.
 */
export function configureApprovalDigestKey(directoryPath: string): void {
  configuredDirectory = directoryPath;
  cachedKey = undefined;
}

/** Test seam: forget the loaded key and any configured location. */
export function resetApprovalDigestKeyForTest(): void {
  configuredDirectory = undefined;
  cachedKey = undefined;
}

/**
 * Keyed digest of approval content, hex encoded.
 *
 * `label` separates domains so a value MAC'd for one purpose can never be compared against the
 * same value MAC'd for another.
 */
export function approvalContentMac(label: string, value: string): string {
  return createHmac('sha256', approvalDigestKey())
    .update(label, 'utf8')
    .update('\0', 'utf8')
    .update(value, 'utf8')
    .digest('hex');
}

function approvalDigestKey(): Buffer {
  if (cachedKey !== undefined) return cachedKey;
  cachedKey =
    configuredDirectory === undefined
      ? randomBytes(KEY_BYTES)
      : loadOrCreateKey(configuredDirectory);
  return cachedKey;
}

function loadOrCreateKey(directoryPath: string): Buffer {
  const path = join(directoryPath, KEY_DIRECTORY, KEY_FILE);
  const existing = readKey(path);
  if (existing !== undefined) return existing;
  mkdirSync(join(directoryPath, KEY_DIRECTORY), { recursive: true, mode: 0o700 });
  const created = randomBytes(KEY_BYTES);
  try {
    const descriptor = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      writeFileSync(descriptor, created);
    } finally {
      closeSync(descriptor);
    }
    return created;
  } catch {
    // Another process created it between the read and the exclusive open. Its key is as good as
    // this one, and both processes must agree, so take what is on disk.
    return readKey(path) ?? created;
  }
}

function readKey(path: string): Buffer | undefined {
  try {
    const bytes = readFileSync(path);
    return bytes.length === KEY_BYTES ? bytes : undefined;
  } catch {
    return undefined;
  }
}
