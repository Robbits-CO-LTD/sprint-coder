import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

const MAX_FILES = 256;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_DEPTH = 8;
const SKILL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const RESERVED_NAMES = new Set(['sprint-coder-team', 'team', 'team-hub']);
const SECRET_FILE_NAMES = new Set([
  '.env',
  '.env.local',
  'credentials.json',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_rsa',
]);

export type SkillProvider = 'claude' | 'agents';
export type SkillCandidate = Readonly<{
  provider: SkillProvider;
  sourceRoot: string;
  sourcePath: string;
  skillId: string;
  valid: boolean;
  problems: readonly string[];
}>;
export type SkillImportPreview = Readonly<{
  candidate: SkillCandidate;
  name: string;
  description: string;
  digest: string;
  files: readonly string[];
  warnings: readonly string[];
}>;
export type ImportedSkill = Readonly<{
  status: 'imported' | 'already-imported';
  path: string;
  manifest: SkillManifest;
}>;
export type ImportedSkillSummary = Readonly<{
  provider: SkillProvider;
  skillId: string;
  manifest: SkillManifest;
}>;
export type SkillManifest = Readonly<{
  version: 1;
  source: SkillProvider;
  importedAt: string;
  digest: string;
  name: string;
  description: string;
  activationMode: 'manual';
  enabled: boolean;
}>;

type Snapshot = {
  name: string;
  description: string;
  digest: string;
  files: { path: string; bytes: Buffer }[];
  warnings: string[];
};

export class SkillStoreError extends Error {
  constructor(
    readonly code:
      'UNAVAILABLE' | 'INVALID_SKILL' | 'UNSAFE_SOURCE' | 'SOURCE_CHANGED' | 'CONFLICT',
    message: string,
  ) {
    super(message);
    this.name = 'SkillStoreError';
  }
}

const issuedCandidates = new WeakSet<object>();
const issuedPreviews = new WeakSet<object>();

export class SkillStore {
  private constructor(private readonly rootPath: string) {}

  static async open(input: { rootPath: string }): Promise<SkillStore> {
    if (process.platform === 'win32')
      throw new SkillStoreError(
        'UNAVAILABLE',
        'Skill storage is unavailable on Windows until ACL verification is implemented',
      );
    await ensurePrivateDirectory(input.rootPath);
    const rootPath = await realpath(input.rootPath);
    for (const path of [
      join(rootPath, 'builtin'),
      join(rootPath, 'imported'),
      join(rootPath, 'imported', 'claude'),
      join(rootPath, 'imported', 'agents'),
    ])
      await ensurePrivateDirectory(path);
    await removeOwnedStagingDirectories(rootPath);
    return new SkillStore(rootPath);
  }

  async scanSources(input: {
    claudePath?: string;
    agentsPath?: string;
  }): Promise<SkillCandidate[]> {
    const candidates: SkillCandidate[] = [];
    for (const [provider, sourceRoot] of [
      ['claude', input.claudePath] as const,
      ['agents', input.agentsPath] as const,
    ]) {
      if (sourceRoot === undefined) continue;
      let root: string;
      try {
        root = await realpath(sourceRoot);
        if (!(await lstat(root)).isDirectory()) continue;
      } catch {
        continue;
      }
      const entries = (await readdir(root)).sort().slice(0, MAX_FILES + 1);
      for (const skillId of entries) {
        const problems: string[] = [];
        const sourcePath = join(root, skillId);
        if (!SKILL_ID.test(skillId)) problems.push('Skill folder name is invalid');
        try {
          const item = await lstat(sourcePath);
          if (!item.isDirectory() || item.isSymbolicLink())
            problems.push('Skill candidate must be a real directory');
        } catch {
          problems.push('Skill candidate is unavailable');
        }
        if (RESERVED_NAMES.has(skillId.toLowerCase()))
          problems.push('Skill name conflicts with a reserved capability');
        const candidate = Object.freeze({
          provider,
          sourceRoot: root,
          sourcePath,
          skillId,
          valid: problems.length === 0,
          problems: Object.freeze(problems),
        });
        issuedCandidates.add(candidate);
        candidates.push(candidate);
      }
    }
    return candidates;
  }

  async listImported(): Promise<ImportedSkillSummary[]> {
    const imported: ImportedSkillSummary[] = [];
    for (const provider of ['claude', 'agents'] as const) {
      const providerRoot = join(this.rootPath, 'imported', provider);
      for (const skillId of (await readdir(providerRoot)).sort()) {
        if (!SKILL_ID.test(skillId) || skillId.startsWith('.')) continue;
        const manifest = await readExistingManifest(join(providerRoot, skillId));
        if (manifest !== null) imported.push({ provider, skillId, manifest });
      }
    }
    return imported;
  }

  async installBuiltin(skillId: string, content: string, digest: string): Promise<void> {
    if (skillId !== 'sprint-coder-team' || !/^[a-f0-9]{64}$/.test(digest))
      throw new SkillStoreError('INVALID_SKILL', 'Builtin skill identity is invalid');
    const builtinRoot = join(this.rootPath, 'builtin');
    const destination = join(builtinRoot, skillId);
    const currentManifest = await readBuiltinManifest(destination);
    if (currentManifest?.digest === digest) return;
    const staging = join(builtinRoot, `.staging-${randomUUID()}`);
    const backup = join(builtinRoot, `.backup-${randomUUID()}`);
    try {
      await mkdir(staging, { mode: 0o700 });
      await writeExclusive(join(staging, 'SKILL.md'), Buffer.from(content, 'utf8'));
      await writeExclusive(
        join(staging, 'manifest.json'),
        Buffer.from(
          `${JSON.stringify(
            {
              version: 1,
              source: 'builtin',
              digest,
              name: skillId,
              activationMode: 'system',
              replaceable: false,
            },
            null,
            2,
          )}\n`,
          'utf8',
        ),
      );
      await syncDirectoryTree(staging);
      if (currentManifest !== null) await rename(destination, backup);
      await rename(staging, destination);
      await syncDirectory(builtinRoot);
      await rm(backup, { recursive: true, force: true });
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      if (await pathExists(backup)) await rename(backup, destination).catch(() => undefined);
      throw error;
    }
  }

  async previewImport(candidate: SkillCandidate): Promise<SkillImportPreview> {
    if (!issuedCandidates.has(candidate) || !candidate.valid)
      throw new SkillStoreError('INVALID_SKILL', 'Skill candidate is invalid or was not scanned');
    const snapshot = await readSnapshot(candidate);
    const preview = Object.freeze({
      candidate,
      name: snapshot.name,
      description: snapshot.description,
      digest: snapshot.digest,
      files: Object.freeze(snapshot.files.map((file) => file.path)),
      warnings: Object.freeze(snapshot.warnings),
    });
    issuedPreviews.add(preview);
    return preview;
  }

  async importSkill(preview: SkillImportPreview): Promise<ImportedSkill> {
    if (!issuedPreviews.has(preview))
      throw new SkillStoreError('INVALID_SKILL', 'Import preview was not issued by this process');
    const snapshot = await readSnapshot(preview.candidate);
    if (
      snapshot.digest !== preview.digest ||
      snapshot.name !== preview.name ||
      snapshot.description !== preview.description
    )
      throw new SkillStoreError('SOURCE_CHANGED', 'Skill source changed after preview');

    const providerRoot = join(this.rootPath, 'imported', preview.candidate.provider);
    const destination = join(providerRoot, preview.candidate.skillId);
    const existing = await readExistingManifest(destination);
    if (existing !== null) {
      if (existing.digest === snapshot.digest)
        return { status: 'already-imported', path: destination, manifest: existing };
      throw new SkillStoreError('CONFLICT', 'A different skill with this name is already imported');
    }

    const staging = join(providerRoot, `.staging-${randomUUID()}`);
    const manifest: SkillManifest = {
      version: 1,
      source: preview.candidate.provider,
      importedAt: new Date().toISOString(),
      digest: snapshot.digest,
      name: snapshot.name,
      description: snapshot.description,
      activationMode: 'manual',
      enabled: true,
    };
    try {
      await mkdir(staging, { mode: 0o700 });
      for (const file of snapshot.files) {
        const target = safeChild(staging, file.path);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await chmod(dirname(target), 0o700);
        await writeExclusive(target, file.bytes);
      }
      await writeExclusive(
        join(staging, 'manifest.json'),
        Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
      );
      await syncDirectoryTree(staging);
      try {
        await rename(staging, destination);
      } catch (error) {
        const raced = await readExistingManifest(destination);
        if (raced?.digest === snapshot.digest)
          return { status: 'already-imported', path: destination, manifest: raced };
        throw error;
      }
      await syncDirectory(providerRoot);
      return { status: 'imported', path: destination, manifest };
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof SkillStoreError) throw error;
      throw new SkillStoreError('CONFLICT', 'Skill import could not be committed atomically');
    }
  }

  async updateSkill(preview: SkillImportPreview): Promise<ImportedSkill> {
    if (!issuedPreviews.has(preview))
      throw new SkillStoreError('INVALID_SKILL', 'Import preview was not issued by this process');
    const snapshot = await readSnapshot(preview.candidate);
    if (snapshot.digest !== preview.digest)
      throw new SkillStoreError('SOURCE_CHANGED', 'Skill source changed after preview');
    const providerRoot = join(this.rootPath, 'imported', preview.candidate.provider);
    const destination = join(providerRoot, preview.candidate.skillId);
    const existing = await readExistingManifest(destination);
    if (existing === null) throw new SkillStoreError('CONFLICT', 'Imported skill does not exist');
    if (existing.digest === snapshot.digest)
      return { status: 'already-imported', path: destination, manifest: existing };

    const staging = join(providerRoot, `.staging-${randomUUID()}`);
    const backup = join(providerRoot, `.backup-${randomUUID()}`);
    const manifest: SkillManifest = {
      version: 1,
      source: preview.candidate.provider,
      importedAt: new Date().toISOString(),
      digest: snapshot.digest,
      name: snapshot.name,
      description: snapshot.description,
      activationMode: 'manual',
      enabled: existing.enabled,
    };
    try {
      await materializeSkill(staging, snapshot.files, manifest);
      await rename(destination, backup);
      try {
        await rename(staging, destination);
      } catch (error) {
        await rename(backup, destination).catch(() => undefined);
        throw error;
      }
      await syncDirectory(providerRoot);
      await rm(backup, { recursive: true, force: true });
      await syncDirectory(providerRoot);
      return { status: 'imported', path: destination, manifest };
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof SkillStoreError) throw error;
      throw new SkillStoreError('CONFLICT', 'Skill update could not be committed atomically');
    }
  }

  async setEnabled(provider: SkillProvider, skillId: string, enabled: boolean): Promise<void> {
    assertSkillId(skillId);
    const providerRoot = join(this.rootPath, 'imported', provider);
    const destination = join(providerRoot, skillId);
    const manifest = await readExistingManifest(destination);
    if (manifest === null) throw new SkillStoreError('CONFLICT', 'Imported skill does not exist');
    const temporary = join(destination, `.manifest-${randomUUID()}.tmp`);
    await writeExclusive(
      temporary,
      Buffer.from(`${JSON.stringify({ ...manifest, enabled }, null, 2)}\n`, 'utf8'),
    );
    await rename(temporary, join(destination, 'manifest.json'));
    await syncDirectory(destination);
  }

  async removeImported(provider: SkillProvider, skillId: string): Promise<void> {
    assertSkillId(skillId);
    const providerRoot = join(this.rootPath, 'imported', provider);
    const destination = join(providerRoot, skillId);
    if ((await readExistingManifest(destination)) === null)
      throw new SkillStoreError('CONFLICT', 'Imported skill does not exist');
    const trash = join(providerRoot, `.trash-${randomUUID()}`);
    await rename(destination, trash);
    await syncDirectory(providerRoot);
    await rm(trash, { recursive: true, force: true });
    await syncDirectory(providerRoot);
  }
}

async function materializeSkill(
  staging: string,
  files: { path: string; bytes: Buffer }[],
  manifest: SkillManifest,
): Promise<void> {
  await mkdir(staging, { mode: 0o700 });
  for (const file of files) {
    const target = safeChild(staging, file.path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await chmod(dirname(target), 0o700);
    await writeExclusive(target, file.bytes);
  }
  await writeExclusive(
    join(staging, 'manifest.json'),
    Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
  );
  await syncDirectoryTree(staging);
}

async function readSnapshot(candidate: SkillCandidate): Promise<Snapshot> {
  const canonicalRoot = await realpath(candidate.sourceRoot).catch(() => '');
  const canonicalSource = await realpath(candidate.sourcePath).catch(() => '');
  if (
    canonicalRoot !== candidate.sourceRoot ||
    canonicalSource === '' ||
    dirname(canonicalSource) !== canonicalRoot ||
    basename(canonicalSource) !== candidate.skillId
  )
    throw new SkillStoreError('UNSAFE_SOURCE', 'Skill source escaped or changed identity');
  const sourceStats = await lstat(canonicalSource);
  if (!sourceStats.isDirectory() || sourceStats.isSymbolicLink())
    throw new SkillStoreError('UNSAFE_SOURCE', 'Skill source must be a real directory');

  const files: { path: string; bytes: Buffer }[] = [];
  const warnings: string[] = [];
  let totalBytes = 0;
  await walk(canonicalSource, '', 0);
  const skillFile = files.find((file) => file.path === 'SKILL.md');
  if (skillFile === undefined) throw new SkillStoreError('INVALID_SKILL', 'SKILL.md is required');
  const { name, description } = parseFrontmatter(skillFile.bytes);
  if (RESERVED_NAMES.has(candidate.skillId.toLowerCase()) || RESERVED_NAMES.has(name.toLowerCase()))
    throw new SkillStoreError('INVALID_SKILL', 'Skill name conflicts with a reserved capability');

  files.sort((left, right) => left.path.localeCompare(right.path));
  const digest = createHash('sha256');
  for (const file of files) {
    digest.update(file.path).update('\0').update(file.bytes).update('\0');
  }
  return { name, description, digest: digest.digest('hex'), files, warnings };

  async function walk(directory: string, relativeDirectory: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH)
      throw new SkillStoreError('INVALID_SKILL', 'Skill directory nesting is too deep');
    for (const name of (await readdir(directory)).sort()) {
      const relativePath = relativeDirectory === '' ? name : join(relativeDirectory, name);
      if (name.startsWith('.') || SECRET_FILE_NAMES.has(name.toLowerCase())) {
        warnings.push(`Excluded ${relativePath}`);
        continue;
      }
      const absolutePath = safeChild(canonicalSource, relativePath);
      const before = await lstat(absolutePath);
      if (before.isSymbolicLink() || (!before.isDirectory() && !before.isFile()))
        throw new SkillStoreError('UNSAFE_SOURCE', `Unsupported file type: ${relativePath}`);
      if (before.isDirectory()) {
        await walk(absolutePath, relativePath, depth + 1);
        continue;
      }
      if (files.length >= MAX_FILES)
        throw new SkillStoreError('INVALID_SKILL', 'Skill contains too many files');
      if (before.size > MAX_FILE_BYTES)
        throw new SkillStoreError('INVALID_SKILL', `Skill file is too large: ${relativePath}`);
      const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Buffer;
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
          throw new SkillStoreError('SOURCE_CHANGED', `Skill file changed: ${relativePath}`);
        bytes = await handle.readFile();
        const after = await handle.stat();
        if (
          after.dev !== opened.dev ||
          after.ino !== opened.ino ||
          after.size !== opened.size ||
          after.mtimeMs !== opened.mtimeMs
        )
          throw new SkillStoreError('SOURCE_CHANGED', `Skill file changed: ${relativePath}`);
      } finally {
        await handle.close();
      }
      totalBytes += bytes.length;
      if (totalBytes > MAX_TOTAL_BYTES)
        throw new SkillStoreError('INVALID_SKILL', 'Skill exceeds the total size limit');
      files.push({ path: relativePath, bytes });
    }
  }
}

function parseFrontmatter(bytes: Buffer): { name: string; description: string } {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes))
    throw new SkillStoreError('INVALID_SKILL', 'SKILL.md must be valid UTF-8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (match === null)
    throw new SkillStoreError('INVALID_SKILL', 'SKILL.md frontmatter is required');
  const values = new Map<string, string>();
  for (const rawLine of match[1]!.split(/\r?\n/)) {
    if (rawLine.trim() === '') continue;
    const line = /^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$/.exec(rawLine);
    if (line === null || (line[1] !== 'name' && line[1] !== 'description'))
      throw new SkillStoreError(
        'INVALID_SKILL',
        'Only name and description are allowed in frontmatter',
      );
    if (values.has(line[1]))
      throw new SkillStoreError('INVALID_SKILL', `Duplicate frontmatter key: ${line[1]}`);
    values.set(line[1], parseScalar(line[2]!));
  }
  const name = values.get('name')?.trim();
  const description = values.get('description')?.trim();
  if (!name || !description)
    throw new SkillStoreError('INVALID_SKILL', 'Skill name and description are required');
  return { name, description };
}

function parseScalar(value: string): string {
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === 'string') return parsed;
    } catch {
      // Report a uniform invalid-frontmatter error below.
    }
    throw new SkillStoreError('INVALID_SKILL', 'Invalid quoted frontmatter value');
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'"))
      throw new SkillStoreError('INVALID_SKILL', 'Invalid quoted frontmatter value');
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return value;
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const item = await lstat(path);
  if (!item.isDirectory() || item.isSymbolicLink())
    throw new SkillStoreError('UNSAFE_SOURCE', 'Skill store path must be a real directory');
  await chmod(path, 0o700);
}

async function removeOwnedStagingDirectories(rootPath: string): Promise<void> {
  for (const provider of ['claude', 'agents'] as const) {
    const providerRoot = join(rootPath, 'imported', provider);
    for (const name of await readdir(providerRoot)) {
      if (!/^\.staging-[0-9a-f-]{36}$/.test(name)) continue;
      const target = join(providerRoot, name);
      const item = await lstat(target);
      if (item.isDirectory() && !item.isSymbolicLink())
        await rm(target, { recursive: true, force: true });
    }
  }
}

async function writeExclusive(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await chmod(path, 0o600);
  } finally {
    await handle.close();
  }
}

async function readExistingManifest(path: string): Promise<SkillManifest | null> {
  try {
    const item = await lstat(path);
    if (!item.isDirectory() || item.isSymbolicLink())
      throw new SkillStoreError('CONFLICT', 'Import destination is not a safe directory');
    const parsed: unknown = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'));
    if (!isManifest(parsed))
      throw new SkillStoreError('CONFLICT', 'Existing skill manifest is invalid');
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function readBuiltinManifest(path: string): Promise<{ digest: string } | null> {
  try {
    const item = await lstat(path);
    if (!item.isDirectory() || item.isSymbolicLink())
      throw new SkillStoreError('CONFLICT', 'Builtin skill destination is unsafe');
    const parsed: unknown = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('digest' in parsed) ||
      typeof parsed.digest !== 'string'
    )
      throw new SkillStoreError('CONFLICT', 'Builtin skill manifest is invalid');
    return { digest: parsed.digest };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function isManifest(value: unknown): value is SkillManifest {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Partial<SkillManifest>;
  const valid =
    item.version === 1 &&
    (item.source === 'claude' || item.source === 'agents') &&
    typeof item.importedAt === 'string' &&
    typeof item.digest === 'string' &&
    /^[a-f0-9]{64}$/.test(item.digest) &&
    typeof item.name === 'string' &&
    typeof item.description === 'string' &&
    item.activationMode === 'manual' &&
    (item.enabled === undefined || typeof item.enabled === 'boolean');
  if (valid && item.enabled === undefined) (value as { enabled: boolean }).enabled = true;
  return valid;
}

function assertSkillId(skillId: string): void {
  if (!SKILL_ID.test(skillId) || RESERVED_NAMES.has(skillId.toLowerCase()))
    throw new SkillStoreError('INVALID_SKILL', 'Skill id is invalid');
}

function safeChild(root: string, child: string): string {
  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, child);
  const relativePath = relative(resolvedRoot, target);
  if (
    relativePath === '' ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    resolve(relativePath) === relativePath
  )
    throw new SkillStoreError('UNSAFE_SOURCE', 'Skill path escapes its root');
  return target;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectoryTree(root: string): Promise<void> {
  const directories = [root];
  for (let index = 0; index < directories.length; index += 1) {
    const directory = directories[index]!;
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      if ((await stat(path)).isDirectory()) directories.push(path);
    }
  }
  for (const directory of directories.reverse()) await syncDirectory(directory);
}
