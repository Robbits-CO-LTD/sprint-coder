import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { TextDecoder } from 'node:util';
import { inflateSync } from 'node:zlib';
import {
  createPathGuard,
  currentWorkspaceRootIdentityDigest,
  isOrdinaryWorkspaceHistoryPath,
  openGuardedExistingFile,
} from './path-guard';

const fullOid = /^[\da-f]{40}$/u;
const decodedLimit = 4 * 1024 * 1024;
const totalLimit = 16 * 1024 * 1024;
const maxEntries = 512;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export class LocalGithubPushError extends Error {
  constructor(readonly code: 'unsupported_history' | 'protected_path' | 'workspace_changed') {
    super(code);
  }
}

function unsupported(): never {
  throw new LocalGithubPushError('unsupported_history');
}

type TreeEntry = Readonly<{ name: string; mode: '100644' | '100755' | '040000'; oid: string }>;
type PushObject =
  | Readonly<{ oid: string; kind: 'blob'; contentBase64: string }>
  | Readonly<{ oid: string; kind: 'tree'; entries: readonly TreeEntry[]; contentBase64: string }>;
type Identity = Readonly<{ name: string; email: string; date: string }>;

function identity(line: string): Identity {
  const match = /^([^<>\p{Cc}\p{Cf}]+) <([!-~]+)> (0|[1-9]\d{0,10}) ([+-])(\d{2})(\d{2})$/u.exec(
    line,
  );
  if (!match || match[0] !== line) return unsupported();
  const [, name, email, unix, sign, hour, minute] = match;
  if (!name || name.trim() !== name || !email || /[<>]/u.test(email) || !hour || !minute)
    return unsupported();
  const offset = Number(hour) * 60 + Number(minute);
  const local = new Date((Number(unix) + (sign === '-' ? -1 : 1) * offset * 60) * 1000);
  if (
    Number(hour) > 14 ||
    Number(minute) > 59 ||
    offset > 14 * 60 ||
    (sign === '-' && offset === 0) ||
    local.getUTCFullYear() < 1970 ||
    local.getUTCFullYear() > 9999
  )
    return unsupported();
  const time = local.toISOString().slice(0, 19);
  return Object.freeze({ name, email, date: time + sign + hour + ':' + minute });
}

function parseCommit(bytes: Buffer) {
  if (bytes.length > 16 * 1024) return unsupported();
  const text = utf8.decode(bytes);
  const match =
    /^tree ([\da-f]{40})\nparent ([\da-f]{40})\nauthor ([^\n]+)\ncommitter ([^\n]+)\n\n([^\0\r]+)$/u.exec(
      text,
    );
  if (
    !match ||
    match[0] !== text ||
    !match[1] ||
    !match[2] ||
    !match[3] ||
    !match[4] ||
    !match[5]?.trim()
  )
    return unsupported();
  return Object.freeze({
    tree: match[1],
    parent: match[2],
    author: identity(match[3]),
    committer: identity(match[4]),
    message: match[5],
  });
}

function parseTree(bytes: Buffer): readonly TreeEntry[] {
  const entries: TreeEntry[] = [];
  const names = new Set<string>();
  let previousKey = '';
  for (let index = 0; index < bytes.length;) {
    const end = bytes.indexOf(0, index);
    if (end < 0 || end + 21 > bytes.length || end - index > 135 || entries.length >= maxEntries)
      return unsupported();
    const header = utf8.decode(bytes.subarray(index, end));
    const match = /^(100644|100755|40000) ([A-Za-z0-9_. -]{1,128})$/u.exec(header);
    const name = match?.[2];
    if (
      !name ||
      match[0] !== header ||
      name === '.' ||
      name === '..' ||
      name.trim() !== name ||
      name.endsWith('.') ||
      /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(name) ||
      names.has(name.toLowerCase())
    )
      return unsupported();
    names.add(name.toLowerCase());
    const mode = match[1] === '40000' ? '040000' : match[1] === '100755' ? '100755' : '100644';
    // Git sorts directory entries as though their names end in a slash.
    const key = mode === '040000' ? name + '/' : name;
    if (key <= previousKey) return unsupported();
    previousKey = key;
    entries.push(
      Object.freeze({ mode, name, oid: bytes.subarray(end + 1, end + 21).toString('hex') }),
    );
    index = end + 21;
  }
  if (!entries.length) return unsupported();
  return Object.freeze(entries);
}

export type PreparedLocalGithubPush = Readonly<{
  commitOid: string;
  commitContentBase64: string;
  commit: ReturnType<typeof parseCommit>;
  objects: readonly PushObject[];
  paths: readonly string[];
}>;

/**
 * Push preparation is the only consumer of this .git boundary. There are no arbitrary paths,
 * repository config, refs, alternates, native commands, network operations, or returned handles.
 */
export async function readLocalGithubPush(input: {
  workspacePath: string;
  expectedRootIdentity: string;
  commitOid: string;
  allowsPath: (absolutePath: string) => boolean;
  isCurrent: () => boolean;
  signal: AbortSignal;
}): Promise<PreparedLocalGithubPush> {
  const { workspacePath, expectedRootIdentity, commitOid, signal } = input;
  if (!fullOid.test(commitOid)) return unsupported();
  let totalBytes = 0;
  const trees = new Map<string, Extract<PushObject, { kind: 'tree' }>>();
  const blobOids = new Set<string>();
  const paths: string[] = [];
  let inspected = 0;
  const requireCurrent = () => {
    signal.throwIfAborted();
    if (
      !input.isCurrent() ||
      currentWorkspaceRootIdentityDigest(workspacePath) !== expectedRootIdentity
    )
      throw new LocalGithubPushError('workspace_changed');
  };
  const read = async (oid: string, kind: 'commit' | 'tree' | 'blob') => {
    requireCurrent();
    const guard = await createPathGuard({
      workspacePath,
      expectedRootIdentityDigest: expectedRootIdentity,
      operation: 'read',
      targetPath: join('.git', 'objects', oid.slice(0, 2), oid.slice(2)),
    });
    if (guard.chain.some(({ linkTarget }) => linkTarget !== null)) return unsupported();
    const handle = await openGuardedExistingFile(guard, 'read');
    try {
      const initial = await handle.stat({ bigint: true });
      if (initial.nlink !== 1n || initial.size < 1n || initial.size > BigInt(decodedLimit))
        return unsupported();
      const compressed = Buffer.alloc(Number(initial.size) + 1);
      let size = 0;
      while (size < compressed.length) {
        requireCurrent();
        const { bytesRead } = await handle.read(compressed, size, compressed.length - size, size);
        if (bytesRead === 0) break;
        size += bytesRead;
      }
      const final = await handle.stat({ bigint: true });
      if (
        BigInt(size) !== initial.size ||
        final.size !== initial.size ||
        final.nlink !== 1n ||
        final.mtimeNs !== initial.mtimeNs ||
        final.ctimeNs !== initial.ctimeNs
      )
        return unsupported();
      const raw = inflateSync(compressed.subarray(0, size), { maxOutputLength: decodedLimit });
      totalBytes += raw.length;
      if (totalBytes > totalLimit || createHash('sha1').update(raw).digest('hex') !== oid)
        return unsupported();
      const end = raw.indexOf(0);
      if (end < 0 || !raw.subarray(0, end).equals(Buffer.from(kind + ' ' + (raw.length - end - 1))))
        return unsupported();
      return raw.subarray(end + 1);
    } finally {
      await handle.close();
    }
  };
  const visit = async (oid: string, segments: readonly string[]) => {
    if (segments.length >= 16) return unsupported();
    const cached = trees.get(oid);
    if (blobOids.has(oid)) return unsupported();
    const treeBytes = cached === undefined ? await read(oid, 'tree') : undefined;
    const entries = cached?.entries ?? parseTree(treeBytes!);
    for (const entry of entries) {
      const path = [...segments, entry.name];
      const absolutePath = join(workspacePath, ...path);
      if (++inspected > maxEntries) return unsupported();
      if (
        !isOrdinaryWorkspaceHistoryPath(workspacePath, absolutePath) ||
        !input.allowsPath(absolutePath)
      )
        throw new LocalGithubPushError('protected_path');
      if (entry.mode === '040000') {
        await visit(entry.oid, path);
      } else {
        paths.push(path.join('/'));
        if (trees.has(entry.oid)) return unsupported();
        blobOids.add(entry.oid);
      }
    }
    if (treeBytes !== undefined)
      trees.set(
        oid,
        Object.freeze({ kind: 'tree', oid, entries, contentBase64: treeBytes.toString('base64') }),
      );
  };
  try {
    const commitBytes = await read(commitOid, 'commit');
    const commit = parseCommit(commitBytes);
    await visit(commit.tree, []);
    const objects: PushObject[] = [];
    for (const oid of blobOids) {
      const bytes = await read(oid, 'blob');
      objects.push(Object.freeze({ kind: 'blob', oid, contentBase64: bytes.toString('base64') }));
    }
    objects.push(...trees.values());
    requireCurrent();
    return Object.freeze({
      commitOid,
      commitContentBase64: commitBytes.toString('base64'),
      commit,
      paths: Object.freeze(paths),
      objects: Object.freeze(objects),
    });
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof LocalGithubPushError) throw error;
    return unsupported();
  }
}
