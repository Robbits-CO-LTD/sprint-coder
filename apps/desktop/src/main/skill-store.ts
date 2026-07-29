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
import { skillDraftSchema, teamBlueprintSchema, type SkillDraft } from '@sprint-coder/contracts';

const MAX_FILES = 256;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_DEPTH = 8;
const SKILL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const BUILTIN_SKILL_IDS = new Set(['sprint-coder-team', 'skill-creator']);
const RESERVED_NAMES = new Set(['sprint-coder-team', 'skill-creator', 'team', 'team-hub']);
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
export type SkillSource = 'builtin' | 'created' | SkillProvider;
export type SkillKind = 'chat' | 'team';
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
export type SelectableSkill = Readonly<{
  source: SkillSource;
  skillId: string;
  kind: SkillKind;
  digest: string;
  name: string;
  description: string;
  enabled: boolean;
  removable: boolean;
  exportable: boolean;
}>;
export type ResolvedSkillPackage = SelectableSkill &
  Readonly<{
    content: string;
    packagePath: string;
  }>;
export type CreatedSkillFile = Readonly<{ path: string; content: string }>;
export type CreatedSkillValidation = Readonly<{
  skillId: string;
  name: string;
  description: string;
  kind: SkillKind;
  digest: string;
  files: readonly string[];
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
      join(rootPath, 'created'),
      join(rootPath, 'drafts'),
      join(rootPath, 'imported'),
      join(rootPath, 'imported', 'claude'),
      join(rootPath, 'imported', 'agents'),
      join(rootPath, 'revisions'),
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
    if (!BUILTIN_SKILL_IDS.has(skillId) || !/^[a-f0-9]{64}$/.test(digest))
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
      await this.ensureRevisionFromDirectory('builtin', skillId, digest, staging);
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

  async installCreatedSkill(
    skillId: string,
    files: readonly CreatedSkillFile[],
  ): Promise<SelectableSkill> {
    const validated = this.validateCreatedSkill(skillId, files);

    const createdRoot = join(this.rootPath, 'created');
    const destination = join(createdRoot, skillId);
    if (await pathExists(destination))
      throw new SkillStoreError('CONFLICT', 'A created Skill with this name already exists');
    const staging = join(createdRoot, `.staging-${randomUUID()}`);
    const paths = new Set<string>();
    let totalBytes = 0;
    try {
      await mkdir(staging, { mode: 0o700 });
      for (const file of files) {
        const path = normalizeDraftFilePath(file.path);
        if (paths.has(path))
          throw new SkillStoreError('INVALID_SKILL', `Duplicate Skill file: ${path}`);
        paths.add(path);
        const bytes = Buffer.from(file.content, 'utf8');
        if (bytes.byteLength > MAX_FILE_BYTES)
          throw new SkillStoreError('INVALID_SKILL', `Skill file is too large: ${path}`);
        totalBytes += bytes.byteLength;
        if (totalBytes > MAX_TOTAL_BYTES)
          throw new SkillStoreError('INVALID_SKILL', 'Skill exceeds the total size limit');
        if (containsCredential(file.content))
          throw new SkillStoreError('INVALID_SKILL', `認証情報を含む可能性があります: ${path}`);
        const target = safeChild(staging, path);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeExclusive(target, bytes);
      }
      if (!paths.has('SKILL.md'))
        throw new SkillStoreError('INVALID_SKILL', 'SKILL.md is required');
      if (paths.has('team/blueprint.json')) {
        const raw = files.find(
          ({ path }) => normalizeDraftFilePath(path) === 'team/blueprint.json',
        )!.content;
        teamBlueprintSchema.parse(JSON.parse(raw));
      }
      await syncDirectoryTree(staging);
      await this.ensureRevisionFromDirectory('created', skillId, validated.digest, staging);
      await rename(staging, destination);
      await syncDirectory(createdRoot);
      const installed = await this.readSelectableAt('created', skillId, true);
      if (installed === null)
        throw new SkillStoreError('CONFLICT', 'Created Skill could not be read after install');
      return installed;
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof SkillStoreError) throw error;
      throw new SkillStoreError('INVALID_SKILL', 'Skill Draftの検証に失敗しました');
    }
  }

  validateCreatedSkill(
    skillId: string,
    files: readonly CreatedSkillFile[],
  ): CreatedSkillValidation {
    assertSkillId(skillId);
    if (RESERVED_NAMES.has(skillId.toLowerCase()))
      throw new SkillStoreError('INVALID_SKILL', 'Skill name conflicts with a reserved capability');
    if (files.length === 0 || files.length > MAX_FILES)
      throw new SkillStoreError('INVALID_SKILL', 'Skill file count is invalid');
    const canonical = files.map((file) => ({
      path: normalizeDraftFilePath(file.path),
      bytes: Buffer.from(file.content, 'utf8'),
      content: file.content,
    }));
    const seen = new Set<string>();
    let totalBytes = 0;
    for (const file of canonical) {
      if (seen.has(file.path))
        throw new SkillStoreError('INVALID_SKILL', `Duplicate Skill file: ${file.path}`);
      seen.add(file.path);
      if (file.bytes.byteLength > MAX_FILE_BYTES)
        throw new SkillStoreError('INVALID_SKILL', `Skill file is too large: ${file.path}`);
      totalBytes += file.bytes.byteLength;
      if (totalBytes > MAX_TOTAL_BYTES)
        throw new SkillStoreError('INVALID_SKILL', 'Skill exceeds the total size limit');
      if (containsCredential(file.content))
        throw new SkillStoreError('INVALID_SKILL', `認証情報を含む可能性があります: ${file.path}`);
    }
    const skillFile = canonical.find(({ path }) => path === 'SKILL.md');
    if (skillFile === undefined) throw new SkillStoreError('INVALID_SKILL', 'SKILL.md is required');
    const { name, description } = parseFrontmatter(skillFile.bytes);
    const blueprint = canonical.find(({ path }) => path === 'team/blueprint.json');
    if (blueprint !== undefined) teamBlueprintSchema.parse(JSON.parse(blueprint.content));
    canonical.sort((left, right) => left.path.localeCompare(right.path));
    const digest = createHash('sha256');
    for (const file of canonical)
      digest.update(file.path).update('\0').update(file.bytes).update('\0');
    return {
      skillId,
      name,
      description,
      kind: blueprint === undefined ? 'chat' : 'team',
      digest: digest.digest('hex'),
      files: canonical.map(({ path }) => path),
    };
  }

  async saveCreatedDraft(draft: SkillDraft): Promise<void> {
    const parsed = skillDraftSchema.parse(draft);
    const validation = this.validateCreatedSkill(parsed.skillId, parsed.files);
    if (validation.kind !== parsed.kind || validation.digest !== parsed.digest)
      throw new SkillStoreError('SOURCE_CHANGED', 'Skill Draft identity does not match its files');
    const draftsRoot = join(this.rootPath, 'drafts');
    const destination = safeDraftPath(draftsRoot, parsed.id);
    if (await pathExists(destination))
      throw new SkillStoreError('CONFLICT', 'Skill Draft already exists');
    const staging = join(draftsRoot, `.staging-${randomUUID()}`);
    try {
      await mkdir(staging, { mode: 0o700 });
      await writeExclusive(
        join(staging, 'draft.json'),
        Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`, 'utf8'),
      );
      await syncDirectoryTree(staging);
      await rename(staging, destination);
      await syncDirectory(draftsRoot);
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof SkillStoreError) throw error;
      throw new SkillStoreError('CONFLICT', 'Skill Draft could not be saved atomically');
    }
  }

  async listCreatedDrafts(): Promise<SkillDraft[]> {
    const draftsRoot = join(this.rootPath, 'drafts');
    const drafts: SkillDraft[] = [];
    for (const id of (await readdir(draftsRoot)).sort()) {
      if (id.startsWith('.')) continue;
      const path = safeDraftPath(draftsRoot, id);
      const item = await lstat(path);
      if (!item.isDirectory() || item.isSymbolicLink())
        throw new SkillStoreError('UNSAFE_SOURCE', 'Skill Draft storage is unsafe');
      const parsed = skillDraftSchema.parse(
        JSON.parse(await readFile(join(path, 'draft.json'), 'utf8')),
      );
      const validation = this.validateCreatedSkill(parsed.skillId, parsed.files);
      if (validation.digest !== parsed.digest || validation.kind !== parsed.kind)
        throw new SkillStoreError('SOURCE_CHANGED', 'Stored Skill Draft changed identity');
      drafts.push(parsed);
    }
    return drafts.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async removeCreatedDraft(draftId: string): Promise<void> {
    const draftsRoot = join(this.rootPath, 'drafts');
    const destination = safeDraftPath(draftsRoot, draftId);
    if (!(await pathExists(destination)))
      throw new SkillStoreError('CONFLICT', 'Skill Draft does not exist');
    const trash = join(draftsRoot, `.trash-${randomUUID()}`);
    await rename(destination, trash);
    await syncDirectory(draftsRoot);
    await rm(trash, { recursive: true, force: true });
    await syncDirectory(draftsRoot);
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
      await this.ensureRevisionFromDirectory(
        preview.candidate.provider,
        preview.candidate.skillId,
        snapshot.digest,
        staging,
      );
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
      await this.ensureRevisionFromDirectory(
        preview.candidate.provider,
        preview.candidate.skillId,
        snapshot.digest,
        staging,
      );
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

  async removeCreated(skillId: string, expectedDigest: string): Promise<void> {
    assertSkillId(skillId);
    const current = await this.readSelectableAt('created', skillId, true);
    if (current === null) throw new SkillStoreError('CONFLICT', 'Created Skill does not exist');
    if (current.digest !== expectedDigest)
      throw new SkillStoreError('SOURCE_CHANGED', 'Created Skill changed before removal');
    const createdRoot = join(this.rootPath, 'created');
    const destination = join(createdRoot, skillId);
    const trash = join(createdRoot, `.trash-${randomUUID()}`);
    await rename(destination, trash);
    await syncDirectory(createdRoot);
    await rm(trash, { recursive: true, force: true });
    await syncDirectory(createdRoot);
  }

  async setCreatedEnabled(
    skillId: string,
    expectedDigest: string,
    enabled: boolean,
  ): Promise<void> {
    assertSkillId(skillId);
    const current = await this.readSelectableAt('created', skillId, true);
    if (current === null) throw new SkillStoreError('CONFLICT', 'Created Skill does not exist');
    if (current.digest !== expectedDigest)
      throw new SkillStoreError('SOURCE_CHANGED', 'Created Skill changed before update');
    const marker = join(this.currentPath('created', skillId), '.disabled');
    if (enabled) await rm(marker, { force: true });
    else if (!(await pathExists(marker)))
      await writeExclusive(marker, Buffer.from('disabled\n', 'utf8'));
    await syncDirectory(this.currentPath('created', skillId));
  }

  async exportCreated(
    skillId: string,
    expectedDigest: string,
    destinationParent: string,
  ): Promise<string> {
    assertSkillId(skillId);
    const current = await this.readSelectableAt('created', skillId, true);
    if (current === null) throw new SkillStoreError('CONFLICT', 'Created Skill does not exist');
    if (current.digest !== expectedDigest)
      throw new SkillStoreError('SOURCE_CHANGED', 'Created Skill changed before export');
    const parent = await realpath(destinationParent);
    const parentItem = await lstat(parent);
    if (!parentItem.isDirectory() || parentItem.isSymbolicLink())
      throw new SkillStoreError('UNSAFE_SOURCE', 'Export destination is unsafe');
    const destination = join(parent, skillId);
    if (await pathExists(destination))
      throw new SkillStoreError('CONFLICT', 'Export destination already exists');
    await copySafeDirectory(this.currentPath('created', skillId), destination, {
      omit: new Set(['manifest.json', 'revision.json', '.disabled']),
    });
    await syncDirectoryTree(destination);
    await syncDirectory(parent);
    return destination;
  }

  async listSelectable(): Promise<SelectableSkill[]> {
    const items: SelectableSkill[] = [];
    const builtin = await this.readSelectableAt('builtin', 'skill-creator', true);
    if (builtin !== null) items.push(builtin);
    for (const imported of await this.listImported()) {
      const source = imported.provider;
      const item = await this.readSelectableAt(source, imported.skillId, imported.manifest.enabled);
      if (item !== null) items.push(item);
    }
    const createdRoot = join(this.rootPath, 'created');
    for (const skillId of (await readdir(createdRoot)).sort()) {
      if (!SKILL_ID.test(skillId) || skillId.startsWith('.')) continue;
      const item = await this.readSelectableAt(
        'created',
        skillId,
        !(await pathExists(join(createdRoot, skillId, '.disabled'))),
      );
      if (item !== null) items.push(item);
    }
    return items.sort(
      (left, right) =>
        left.kind.localeCompare(right.kind) ||
        left.name.localeCompare(right.name) ||
        left.source.localeCompare(right.source),
    );
  }

  async resolveSelectable(
    source: SkillSource,
    skillId: string,
    digest: string,
  ): Promise<ResolvedSkillPackage> {
    assertSkillIdForSource(source, skillId);
    if (!/^[a-f0-9]{64}$/.test(digest))
      throw new SkillStoreError('INVALID_SKILL', 'Skill digest is invalid');
    const current = (await this.listSelectable()).find(
      (item) => item.source === source && item.skillId === skillId,
    );
    if (current === undefined || !current.enabled)
      throw new SkillStoreError('INVALID_SKILL', 'Skill is disabled or unavailable');
    if (current.digest !== digest)
      throw new SkillStoreError('SOURCE_CHANGED', 'Skill changed after it was selected');
    const packagePath = this.revisionPath(source, skillId, digest);
    await this.ensureRevisionFromDirectory(
      source,
      skillId,
      digest,
      this.currentPath(source, skillId),
    );
    let content = await readFile(join(packagePath, 'SKILL.md'), 'utf8');
    if (content.length > 40_000)
      throw new SkillStoreError('INVALID_SKILL', 'SKILL.md is too large to execute');
    if (current.kind === 'team') {
      const blueprintText = await readFile(join(packagePath, 'team', 'blueprint.json'), 'utf8');
      const blueprint = teamBlueprintSchema.parse(JSON.parse(blueprintText));
      content = `${content}\n\n## Pinned Team Blueprint\n\n\`\`\`json\n${JSON.stringify(
        blueprint,
        null,
        2,
      )}\n\`\`\`\n`;
      if (content.length > 80_000)
        throw new SkillStoreError('INVALID_SKILL', 'Team Skill context is too large to execute');
    }
    return { ...current, content, packagePath };
  }

  private async readSelectableAt(
    source: SkillSource,
    skillId: string,
    enabled: boolean,
  ): Promise<SelectableSkill | null> {
    const path = this.currentPath(source, skillId);
    try {
      const item = await lstat(path);
      if (!item.isDirectory() || item.isSymbolicLink())
        throw new SkillStoreError('CONFLICT', 'Skill destination is unsafe');
      const skillBytes = await readFile(join(path, 'SKILL.md'));
      const { name, description } = parseFrontmatter(skillBytes);
      const digest =
        source === 'builtin'
          ? (await readBuiltinManifest(path))?.digest
          : source === 'created'
            ? await digestDirectory(path)
            : (await readExistingManifest(path))?.digest;
      if (digest === null || digest === undefined) return null;
      const kind = (await pathExists(join(path, 'team', 'blueprint.json'))) ? 'team' : 'chat';
      await this.ensureRevisionFromDirectory(source, skillId, digest, path);
      return {
        source,
        skillId,
        kind,
        digest,
        name,
        description,
        enabled,
        removable: source !== 'builtin',
        exportable: source === 'created',
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private currentPath(source: SkillSource, skillId: string): string {
    if (source === 'builtin' || source === 'created') return join(this.rootPath, source, skillId);
    return join(this.rootPath, 'imported', source, skillId);
  }

  private revisionPath(source: SkillSource, skillId: string, digest: string): string {
    return join(this.rootPath, 'revisions', source, skillId, digest);
  }

  private async ensureRevisionFromDirectory(
    source: SkillSource,
    skillId: string,
    digest: string,
    sourcePath: string,
  ): Promise<void> {
    const skillRoot = join(this.rootPath, 'revisions', source, skillId);
    await ensurePrivateDirectory(skillRoot);
    const destination = this.revisionPath(source, skillId, digest);
    if (await pathExists(destination)) return;
    const staging = join(skillRoot, `.staging-${randomUUID()}`);
    try {
      await copySafeDirectory(sourcePath, staging, {
        omit: new Set(['manifest.json', '.disabled']),
      });
      await writeExclusive(
        join(staging, 'revision.json'),
        Buffer.from(
          `${JSON.stringify({ version: 1, source, skillId, digest }, null, 2)}\n`,
          'utf8',
        ),
      );
      await syncDirectoryTree(staging);
      try {
        await rename(staging, destination);
      } catch (error) {
        if (!(await pathExists(destination))) throw error;
      }
      await syncDirectory(skillRoot);
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
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

function normalizeDraftFilePath(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\/+/, '');
  const parts = normalized.split('/');
  if (
    normalized === '' ||
    normalized.startsWith('/') ||
    parts.some((part) => part === '' || part === '.' || part === '..') ||
    parts.length > MAX_DEPTH + 1 ||
    parts.some((part) => part.startsWith('.') || SECRET_FILE_NAMES.has(part.toLowerCase()))
  )
    throw new SkillStoreError('UNSAFE_SOURCE', 'Skill Draftのファイルパスが安全ではありません');
  return normalized;
}

function containsCredential(content: string): boolean {
  return [
    /\bAuthorization\s*:\s*(?:Bearer|Basic)\s+\S+/iu,
    /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]\s*["']?[A-Za-z0-9_./+-]{16,}/iu,
    /\bsk-[A-Za-z0-9_-]{16,}\b/u,
  ].some((pattern) => pattern.test(content));
}

function safeDraftPath(root: string, draftId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(draftId))
    throw new SkillStoreError('UNSAFE_SOURCE', 'Skill Draft ID is invalid');
  return safeChild(root, draftId);
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const item = await lstat(path);
  if (!item.isDirectory() || item.isSymbolicLink())
    throw new SkillStoreError('UNSAFE_SOURCE', 'Skill store path must be a real directory');
  await chmod(path, 0o700);
}

async function removeOwnedStagingDirectories(rootPath: string): Promise<void> {
  const draftsRoot = join(rootPath, 'drafts');
  for (const name of await readdir(draftsRoot)) {
    if (!/^\.(?:staging|trash)-[0-9a-f-]{36}$/.test(name)) continue;
    const target = join(draftsRoot, name);
    const item = await lstat(target);
    if (item.isDirectory() && !item.isSymbolicLink())
      await rm(target, { recursive: true, force: true });
  }
  const createdRoot = join(rootPath, 'created');
  for (const name of await readdir(createdRoot)) {
    if (!/^\.(?:staging|trash)-[0-9a-f-]{36}$/.test(name)) continue;
    const target = join(createdRoot, name);
    const item = await lstat(target);
    if (item.isDirectory() && !item.isSymbolicLink())
      await rm(target, { recursive: true, force: true });
  }
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
  const revisionsRoot = join(rootPath, 'revisions');
  for (const source of await readdir(revisionsRoot)) {
    const sourceRoot = join(revisionsRoot, source);
    const sourceItem = await lstat(sourceRoot);
    if (!sourceItem.isDirectory() || sourceItem.isSymbolicLink()) continue;
    for (const skillId of await readdir(sourceRoot)) {
      const skillRoot = join(sourceRoot, skillId);
      const skillItem = await lstat(skillRoot);
      if (!skillItem.isDirectory() || skillItem.isSymbolicLink()) continue;
      for (const name of await readdir(skillRoot)) {
        if (!/^\.staging-[0-9a-f-]{36}$/.test(name)) continue;
        const target = join(skillRoot, name);
        const item = await lstat(target);
        if (item.isDirectory() && !item.isSymbolicLink())
          await rm(target, { recursive: true, force: true });
      }
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

function assertSkillIdForSource(source: SkillSource, skillId: string): void {
  if (!SKILL_ID.test(skillId)) throw new SkillStoreError('INVALID_SKILL', 'Skill id is invalid');
  if (source === 'builtin') {
    if (!BUILTIN_SKILL_IDS.has(skillId))
      throw new SkillStoreError('INVALID_SKILL', 'Builtin Skill id is invalid');
    return;
  }
  if (RESERVED_NAMES.has(skillId.toLowerCase()))
    throw new SkillStoreError('INVALID_SKILL', 'Skill id is reserved');
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

async function digestDirectory(root: string): Promise<string> {
  const entries: { path: string; bytes: Buffer }[] = [];
  await collect(root, '', 0);
  const digest = createHash('sha256');
  for (const entry of entries.sort((left, right) => left.path.localeCompare(right.path)))
    digest.update(entry.path).update('\0').update(entry.bytes).update('\0');
  return digest.digest('hex');

  async function collect(
    directory: string,
    relativeDirectory: string,
    depth: number,
  ): Promise<void> {
    if (depth > MAX_DEPTH)
      throw new SkillStoreError('INVALID_SKILL', 'Skill directory nesting is too deep');
    for (const name of (await readdir(directory)).sort()) {
      if (name === 'manifest.json' || name === 'revision.json' || name.startsWith('.')) continue;
      const relativePath = relativeDirectory === '' ? name : join(relativeDirectory, name);
      const absolutePath = safeChild(root, relativePath);
      const item = await lstat(absolutePath);
      if (item.isSymbolicLink() || (!item.isDirectory() && !item.isFile()))
        throw new SkillStoreError('UNSAFE_SOURCE', `Unsupported file type: ${relativePath}`);
      if (item.isDirectory()) {
        await collect(absolutePath, relativePath, depth + 1);
        continue;
      }
      if (entries.length >= MAX_FILES || item.size > MAX_FILE_BYTES)
        throw new SkillStoreError('INVALID_SKILL', 'Skill revision exceeds its limits');
      entries.push({ path: relativePath, bytes: await readFile(absolutePath) });
    }
  }
}

async function copySafeDirectory(
  sourceRoot: string,
  destinationRoot: string,
  options: { omit: ReadonlySet<string> },
): Promise<void> {
  await mkdir(destinationRoot, { mode: 0o700 });
  let files = 0;
  let totalBytes = 0;
  await copy(sourceRoot, destinationRoot, '', 0);

  async function copy(
    sourceDirectory: string,
    destinationDirectory: string,
    relativeDirectory: string,
    depth: number,
  ): Promise<void> {
    if (depth > MAX_DEPTH)
      throw new SkillStoreError('INVALID_SKILL', 'Skill directory nesting is too deep');
    for (const name of (await readdir(sourceDirectory)).sort()) {
      if (name.startsWith('.') || options.omit.has(name)) continue;
      const relativePath = relativeDirectory === '' ? name : join(relativeDirectory, name);
      const sourcePath = safeChild(sourceRoot, relativePath);
      const destinationPath = safeChild(destinationRoot, relativePath);
      const before = await lstat(sourcePath);
      if (before.isSymbolicLink() || (!before.isDirectory() && !before.isFile()))
        throw new SkillStoreError('UNSAFE_SOURCE', `Unsupported file type: ${relativePath}`);
      if (before.isDirectory()) {
        await mkdir(destinationPath, { mode: 0o700 });
        await copy(sourcePath, destinationPath, relativePath, depth + 1);
        continue;
      }
      files += 1;
      totalBytes += before.size;
      if (files > MAX_FILES || before.size > MAX_FILE_BYTES || totalBytes > MAX_TOTAL_BYTES)
        throw new SkillStoreError('INVALID_SKILL', 'Skill revision exceeds its limits');
      const handle = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
          throw new SkillStoreError('SOURCE_CHANGED', `Skill file changed: ${relativePath}`);
        await writeExclusive(destinationPath, await handle.readFile());
      } finally {
        await handle.close();
      }
    }
  }
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
