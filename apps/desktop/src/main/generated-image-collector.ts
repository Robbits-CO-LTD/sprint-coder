import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';

// Takes custody of images Codex generated during a Turn (issue #11).
//
// The security argument for this file's whole shape: `$imagegen` makes the CLI write PNGs to
// `$CODEX_HOME/generated_images/<thread_id>/<call_id>.png` *itself*, outside the sandbox and with no
// write permission from us — verified on codex-cli 0.144.4. What it does NOT do is give us a
// structured event containing the path. The only place a path appears is inside a model-authored
// message ("生成済みファイル: [call_x.png](/Users/…/call_x.png)").
//
// Parsing that would be an arbitrary-file-read primitive driven by attacker-influenceable text: a
// prompt injection in repository content could make the model emit ~/.ssh/id_rsa, and the app would
// dutifully copy it into an artifact the user then opens. So no path from the model is ever read.
// Instead the CLI's own `thread.started` event supplies a thread id (a UUID, validated as such by
// the runtime protocol), and this module enumerates exactly that one directory.
//
// The read-only sandbox is untouched. Nothing here relaxes it; the CLI was already writing here.

/** Bounded so a pathological directory cannot stall a Turn's completion. */
const MAX_IMAGES_PER_TURN = 8;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** Mirrors codex-adapter.ts's own resolution so both agree on where CODEX_HOME is. */
export function codexGeneratedImagesRoot(env: NodeJS.ProcessEnv = process.env): string {
  const codexHome = env['CODEX_HOME'] ?? join(env['HOME'] ?? homedir(), '.codex');
  return join(codexHome, 'generated_images');
}

/**
 * Resolves the directory for one thread, or null if the id would escape the root.
 *
 * The id is already UUID-shaped by the time it reaches Main (the runtime protocol rejects anything
 * else), but this re-checks containment after `resolve` rather than trusting that: a value that gets
 * interpolated into a filesystem path deserves the check at the point of use, not only at the point
 * of entry.
 */
export function resolveThreadImageDirectory(threadId: string, root: string): string | null {
  if (threadId === '' || isAbsolute(threadId)) return null;
  const resolvedRoot = resolve(root);
  const candidate = resolve(resolvedRoot, threadId);
  return candidate === resolvedRoot || candidate.startsWith(resolvedRoot + sep) ? candidate : null;
}

/**
 * Reads the PNGs Codex wrote for a thread.
 *
 * Only regular files ending in `.png` are opened, and only up to the caps above. Whether the bytes
 * really are a PNG is decided by `recordGeneratedImage`'s magic-byte check, not here — the file
 * extension is a filter, never evidence.
 */
export function collectThreadImages(
  threadId: string,
  root = codexGeneratedImagesRoot(),
): { fileName: string; bytes: Buffer }[] {
  const directory = resolveThreadImageDirectory(threadId, root);
  if (directory === null) return [];
  let entries: string[];
  try {
    const directoryStat = lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return [];
    const canonicalRoot = realpathSync(root);
    const canonicalDirectory = realpathSync(directory);
    const relation = canonicalDirectory.slice(canonicalRoot.length);
    const pathEqual = (left: string, right: string) =>
      process.platform === 'win32'
        ? left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US')
        : left === right;
    if (!pathEqual(canonicalDirectory, directory)) return [];
    if (relation !== '' && !relation.startsWith(sep)) return [];
    entries = readdirSync(directory);
  } catch {
    // No directory means the turn generated nothing, which is the common case.
    return [];
  }
  const collected: { fileName: string; bytes: Buffer }[] = [];
  for (const fileName of entries.sort()) {
    if (collected.length >= MAX_IMAGES_PER_TURN) break;
    if (!fileName.toLowerCase().endsWith('.png')) continue;
    const filePath = join(directory, fileName);
    try {
      // `lstatSync`, not `statSync`: statSync follows the link, so a symlink to a regular file
      // reports isFile() === true and would be read. Rejecting symlinks outright is what keeps a
      // planted `leak.png -> ~/.ssh/id_rsa` from being opened at all, rather than relying on the
      // PNG magic-byte check downstream to be the only thing in the way.
      const stats = lstatSync(filePath);
      if (!stats.isFile() || stats.size === 0 || stats.size > MAX_IMAGE_BYTES) continue;
      collected.push({ fileName, bytes: readFileSync(filePath) });
    } catch {
      continue;
    }
  }
  return collected;
}
