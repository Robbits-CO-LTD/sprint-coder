import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type {
  SkillCandidateSummary,
  SkillCatalog,
  SkillCatalogItem,
  SkillDraft,
  SkillDraftCreateInput,
  SkillImportResult,
  SkillPreviewResult,
  SkillProvider,
  SkillActivationPolicy,
  SkillRef,
  SkillScanResult,
  TurnSkillSelection,
} from '@sprint-coder/contracts';
import {
  SkillStore,
  SkillStoreError,
  type SkillCandidate,
  type SkillImportPreview,
  type ResolvedSkillPackage,
  type SkillCatalogSnapshotEntry,
} from './skill-store';
import { buildSkillCatalogContext, SkillCatalogContextError } from './skill-catalog-context';
import { createPortableSkillFile } from './skill-compatibility';
import { expandSkillArguments } from '../runtime-host/skill-arguments';

const PREVIEW_TTL_MS = 5 * 60 * 1_000;
const MAX_PREVIEWS = 64;

type PreviewRecord = {
  senderId: number;
  provider: SkillProvider;
  skillId: string;
  digest: string;
  expiresAtMs: number;
  preview: SkillImportPreview;
};

export type ResolvedTurnSkill = Readonly<{
  selection: TurnSkillSelection;
  name: string;
  description: string;
  content: string;
  packagePath: string;
  activationPolicy: SkillActivationPolicy;
  compatibility: SkillCatalogItem['compatibility'];
}>;

export class SkillSettingsService {
  private readonly previews = new Map<string, PreviewRecord>();
  private readonly drafts = new Map<string, SkillDraft>();
  private store: Promise<SkillStore> | null = null;
  private contextCatalogEntries: readonly SkillCatalogSnapshotEntry[] = [];
  private autoCandidatesByRuntime: Readonly<
    Record<'codex' | 'claude' | 'provider', readonly ResolvedTurnSkill[]>
  > = { codex: [], claude: [], provider: [] };
  private activationPolicyMutation: Promise<void> = Promise.resolve();

  constructor(
    private readonly input: {
      homePath: string;
      now?: () => number;
    },
  ) {}

  async scan(): Promise<SkillScanResult> {
    const [store, candidates] = await Promise.all([this.getStore(), this.scanCandidates()]);
    const imported = await store.listImported();
    const importedByKey = new Map(
      imported.map((item) => [key(item.provider, item.skillId), item] as const),
    );
    const sourceDigests = new Map<string, string>();
    const validationProblems = new Map<string, string>();
    await Promise.all(
      candidates
        .filter((candidate) => candidate.valid)
        .map(async (candidate) => {
          try {
            const preview = await store.previewImport(candidate);
            sourceDigests.set(key(candidate.provider, candidate.skillId), preview.digest);
          } catch {
            validationProblems.set(
              key(candidate.provider, candidate.skillId),
              'Skillを安全に読み込めません',
            );
          }
        }),
    );
    const summaries: SkillCandidateSummary[] = candidates.map((candidate) => ({
      provider: candidate.provider,
      skillId: candidate.skillId,
      valid: candidate.valid && !validationProblems.has(key(candidate.provider, candidate.skillId)),
      problems: validationProblems.has(key(candidate.provider, candidate.skillId))
        ? [validationProblems.get(key(candidate.provider, candidate.skillId))!]
        : [...candidate.problems],
      imported: importedByKey.has(key(candidate.provider, candidate.skillId)),
      enabled:
        importedByKey.get(key(candidate.provider, candidate.skillId))?.manifest.enabled ?? null,
      updateAvailable:
        importedByKey.has(key(candidate.provider, candidate.skillId)) &&
        sourceDigests.get(key(candidate.provider, candidate.skillId)) !==
          importedByKey.get(key(candidate.provider, candidate.skillId))?.manifest.digest,
    }));
    return {
      candidates: summaries,
      claudeDetected: summaries.filter((item) => item.provider === 'claude').length,
      agentsDetected: summaries.filter((item) => item.provider === 'agents').length,
      importedCount: imported.length,
      invalidCount: summaries.filter((item) => !item.valid).length,
      installed: imported.map((item) => ({
        provider: item.provider,
        skillId: item.skillId,
        name: item.manifest.name,
        enabled: item.manifest.enabled,
        sourceAvailable: sourceDigests.has(key(item.provider, item.skillId)),
        updateAvailable:
          sourceDigests.has(key(item.provider, item.skillId)) &&
          sourceDigests.get(key(item.provider, item.skillId)) !== item.manifest.digest,
      })),
    };
  }

  async preview(
    senderId: number,
    provider: SkillProvider,
    skillId: string,
  ): Promise<SkillPreviewResult> {
    this.removeExpired();
    if (this.previews.size >= MAX_PREVIEWS)
      throw new SkillSettingsError('PREVIEW_LIMIT', 'プレビュー数の上限に達しました');
    const candidate = await this.findCandidate(provider, skillId);
    const preview = await (await this.getStore()).previewImport(candidate);
    const previewId = randomUUID();
    const expiresAtMs = this.now() + PREVIEW_TTL_MS;
    this.previews.set(previewId, {
      senderId,
      provider,
      skillId,
      digest: preview.digest,
      expiresAtMs,
      preview,
    });
    return {
      previewId,
      expiresAt: new Date(expiresAtMs).toISOString(),
      provider,
      skillId,
      name: preview.name,
      description: preview.description,
      files: [...preview.files],
      warnings: [...preview.warnings],
      compatibility: preview.compatibility,
    };
  }

  async import(
    senderId: number,
    previewId: string,
    nativeModeConfirmed = false,
  ): Promise<SkillImportResult> {
    const record = this.consumePreview(senderId, previewId);
    assertCompatibilityApproved(record.preview.compatibility, nativeModeConfirmed);
    const candidate = await this.findCandidate(record.provider, record.skillId);
    const currentPreview = await (await this.getStore()).previewImport(candidate);
    if (currentPreview.digest !== record.digest)
      throw new SkillSettingsError('SOURCE_CHANGED', 'Skillがプレビュー後に変更されました');
    const result = await (await this.getStore()).importSkill(currentPreview);
    await this.refreshContextCatalog();
    return {
      provider: record.provider,
      skillId: record.skillId,
      status: result.status,
      name: result.manifest.name,
    };
  }

  async update(
    senderId: number,
    previewId: string,
    nativeModeConfirmed = false,
  ): Promise<SkillImportResult> {
    const record = this.consumePreview(senderId, previewId);
    assertCompatibilityApproved(record.preview.compatibility, nativeModeConfirmed);
    const candidate = await this.findCandidate(record.provider, record.skillId);
    const currentPreview = await (await this.getStore()).previewImport(candidate);
    if (currentPreview.digest !== record.digest)
      throw new SkillSettingsError('SOURCE_CHANGED', 'Skillがプレビュー後に変更されました');
    const result = await (await this.getStore()).updateSkill(currentPreview);
    await this.refreshContextCatalog();
    return {
      provider: record.provider,
      skillId: record.skillId,
      status: result.status,
      name: result.manifest.name,
    };
  }

  async setEnabled(provider: SkillProvider, skillId: string, enabled: boolean): Promise<void> {
    await (await this.getStore()).setEnabled(provider, skillId, enabled);
    await this.refreshContextCatalog();
  }

  async remove(provider: SkillProvider, skillId: string): Promise<void> {
    await (await this.getStore()).removeImported(provider, skillId);
    await this.refreshContextCatalog();
  }

  async removeCreated(skillId: string, digest: string): Promise<void> {
    await (await this.getStore()).removeCreated(skillId, digest);
    await this.refreshContextCatalog();
  }

  async setCreatedEnabled(skillId: string, digest: string, enabled: boolean): Promise<void> {
    await (await this.getStore()).setCreatedEnabled(skillId, digest, enabled);
    await this.refreshContextCatalog();
  }

  async exportCreated(
    skillId: string,
    digest: string,
    destinationParent: string,
    format: 'original' | 'portable' = 'original',
  ): Promise<string> {
    return (await this.getStore()).exportCreated(skillId, digest, destinationParent, format);
  }

  async listCatalog(): Promise<SkillCatalog> {
    const items = (await (await this.getStore()).listSelectable()).map((item) => ({
      ref: {
        skillId: item.skillId,
        source: item.source,
        digest: item.digest,
      },
      kind: item.kind,
      name: item.name,
      description: item.description,
      enabled: item.enabled,
      activationPolicy: item.activationPolicy,
      compatibility: item.compatibility,
      removable: item.removable,
      exportable: item.exportable,
    }));
    const revision = createHash('sha256').update(JSON.stringify(items)).digest('hex');
    await this.refreshContextCatalog();
    return { revision, items };
  }

  async refreshContextCatalog(): Promise<void> {
    const store = await this.getStore();
    const selectable = await store.listSelectable();
    const entries = await store.listCatalogSnapshotEntries();
    const approved = selectable.filter(
      (item) => item.enabled && item.activationPolicy === 'auto-allowed',
    );
    if (approved.length > 32)
      throw new SkillSettingsError('INVALID_SKILL', '自動選択候補は最大32件です');
    const resolved = await Promise.all(
      approved.map((item) =>
        store.resolveSelectable(item.source, item.skillId, item.digest).then((skill) => ({
          selection: {
            kind: skill.kind,
            ref: { source: skill.source, skillId: skill.skillId, digest: skill.digest },
          },
          name: skill.name,
          description: skill.description,
          content: skill.content,
          packagePath: skill.packagePath,
          activationPolicy: skill.activationPolicy,
          compatibility: skill.compatibility,
        })),
      ),
    );
    const forRuntime = (runtime: 'codex' | 'claude' | 'provider') =>
      resolved
        .filter(({ compatibility }) => compatibility.runtimeSupport[runtime] !== 'blocked')
        .map((skill) => projectResolvedSkillForRuntime(skill, runtime));
    const byRuntime = {
      codex: forRuntime('codex'),
      claude: forRuntime('claude'),
      provider: forRuntime('provider'),
    };
    this.contextCatalogEntries = entries;
    this.autoCandidatesByRuntime = byRuntime;
  }

  markContextCatalogUnavailable(): void {
    this.autoCandidatesByRuntime = { codex: [], claude: [], provider: [] };
    this.contextCatalogEntries = [
      'sprint-coder-team',
      'sprint-coder-product',
      'skill-creator',
      'import-skill',
      'imagegen',
    ].map((skillId) => ({
      source: 'builtin' as const,
      skillId,
      kind: null,
      digest: null,
      name: skillId,
      description: '',
      enabled: false,
      activationPolicy: 'manual' as const,
      compatibility: {
        profile: 'portable' as const,
        runtimeSupport: {
          codex: 'full' as const,
          claude: 'full' as const,
          provider: 'full' as const,
        },
        features: [],
        requestedTools: [],
        warnings: [],
        blockers: [],
        requiresConversion: false,
        nativeModeConsentRequired: false,
      },
      availability: 'invalid' as const,
    }));
  }

  contextCatalogForTurn(
    selections: readonly TurnSkillSelection[],
    includeBuiltinTeamSkill: boolean,
  ): string {
    if (this.contextCatalogEntries.length === 0)
      throw new SkillSettingsError('NOT_FOUND', 'SkillカタログをTurn開始前に取得できません');
    const effectiveSelections = [...selections];
    if (includeBuiltinTeamSkill) {
      const team = this.contextCatalogEntries.find(
        ({ source, skillId, digest }) =>
          source === 'builtin' && skillId === 'sprint-coder-team' && digest !== null,
      );
      if (team !== undefined && team.digest !== null)
        effectiveSelections.push({
          kind: 'team',
          ref: { source: 'builtin', skillId: team.skillId, digest: team.digest },
        });
    }
    try {
      return buildSkillCatalogContext(this.contextCatalogEntries, effectiveSelections);
    } catch (error) {
      if (error instanceof SkillCatalogContextError)
        throw new SkillSettingsError(
          'INVALID_SKILL',
          `Skillカタログの識別情報がTurn上限を超えています（${error.itemCount}件）`,
        );
      throw error;
    }
  }

  async listDrafts(): Promise<SkillDraft[]> {
    const stored = await (await this.getStore()).listCreatedDrafts();
    this.drafts.clear();
    for (const draft of stored) this.drafts.set(draft.id, draft);
    return stored;
  }

  async createDraft(input: SkillDraftCreateInput): Promise<SkillDraft> {
    if (this.drafts.size >= 64)
      throw new SkillSettingsError('PREVIEW_LIMIT', 'Skill Draft数の上限に達しました');
    const validation = (await this.getStore()).validateCreatedSkill(input.skillId, input.files);
    if (validation.kind !== input.kind)
      throw new SkillSettingsError(
        'INVALID_SKILL',
        input.kind === 'team'
          ? 'Team Skillにはteam/blueprint.jsonが必要です'
          : 'Chat SkillへTeam Blueprintを含めることはできません',
      );
    const now = new Date(this.now()).toISOString();
    const draft: SkillDraft = {
      id: randomUUID(),
      kind: validation.kind,
      skillId: validation.skillId,
      name: validation.name,
      description: validation.description,
      digest: validation.digest,
      files: input.files.map((file) => ({ ...file })),
      createdAt: now,
      updatedAt: now,
    };
    await (await this.getStore()).saveCreatedDraft(draft);
    this.drafts.set(draft.id, draft);
    return draft;
  }

  async installDraft(draftId: string, expectedDigest: string): Promise<SkillCatalogItem> {
    const draft =
      this.drafts.get(draftId) ?? (await this.listDrafts()).find(({ id }) => id === draftId);
    if (draft === undefined)
      throw new SkillSettingsError('NOT_FOUND', 'Skill Draftが見つかりません');
    if (draft.digest !== expectedDigest)
      throw new SkillSettingsError('SOURCE_CHANGED', 'Skill Draftが確認後に変更されました');
    const validation = (await this.getStore()).validateCreatedSkill(draft.skillId, draft.files);
    if (validation.compatibility.requiresConversion)
      throw new SkillSettingsError('INVALID_SKILL', 'Skill DraftはPortable版への変換が必要です');
    const installed = await (await this.getStore()).installCreatedSkill(draft.skillId, draft.files);
    await (await this.getStore()).removeCreatedDraft(draftId);
    this.drafts.delete(draftId);
    await this.refreshContextCatalog();
    return {
      ref: {
        skillId: installed.skillId,
        source: installed.source,
        digest: installed.digest,
      },
      kind: installed.kind,
      name: installed.name,
      description: installed.description,
      enabled: installed.enabled,
      activationPolicy: installed.activationPolicy,
      compatibility: installed.compatibility,
      removable: installed.removable,
      exportable: installed.exportable,
    };
  }

  async installPrepared(input: SkillDraftCreateInput): Promise<SkillCatalogItem> {
    const validation = (await this.getStore()).validateCreatedSkill(input.skillId, input.files);
    if (validation.compatibility.requiresConversion)
      throw new SkillSettingsError('INVALID_SKILL', 'Prepared Skill is not Portable-compatible');
    if (validation.kind !== input.kind)
      throw new SkillSettingsError(
        'INVALID_SKILL',
        input.kind === 'team'
          ? 'Team Skillにはteam/blueprint.jsonが必要です'
          : 'Chat SkillへTeam Blueprintを含めることはできません',
      );
    const installed = await (await this.getStore()).installCreatedSkill(input.skillId, input.files);
    await this.refreshContextCatalog();
    return {
      ref: {
        skillId: installed.skillId,
        source: installed.source,
        digest: installed.digest,
      },
      kind: installed.kind,
      name: installed.name,
      description: installed.description,
      enabled: installed.enabled,
      activationPolicy: installed.activationPolicy,
      compatibility: installed.compatibility,
      removable: installed.removable,
      exportable: installed.exportable,
    };
  }

  async readImportSource(input: { cli: 'claude' | 'codex'; skillId: string }): Promise<{
    cli: 'claude' | 'codex';
    skillId: string;
    digest: string;
    files: readonly { path: string; content: string }[];
    warnings: readonly string[];
  }> {
    const store = await this.getStore();
    const roots =
      input.cli === 'claude'
        ? [{ claudePath: join(this.input.homePath, '.claude', 'skills') }]
        : [
            { agentsPath: join(this.input.homePath, '.codex', 'skills') },
            { agentsPath: join(this.input.homePath, '.agents', 'skills') },
          ];
    for (const root of roots) {
      const candidate = (await store.scanSources(root)).find(
        (item) => item.skillId === input.skillId,
      );
      if (candidate === undefined) continue;
      if (!candidate.valid)
        throw new SkillSettingsError('INVALID_SKILL', candidate.problems[0] ?? 'Skillが無効です');
      const source = await store
        .readRepairSource(candidate)
        .catch((error) => Promise.reject(skillSettingsPublicError(error)));
      return { cli: input.cli, ...source };
    }
    throw new SkillSettingsError('NOT_FOUND', '指定されたCLIにSkillが見つかりません');
  }

  async discardDraft(draftId: string): Promise<void> {
    const exists =
      this.drafts.has(draftId) || (await this.listDrafts()).some(({ id }) => id === draftId);
    if (!exists) throw new SkillSettingsError('NOT_FOUND', 'Skill Draftが見つかりません');
    await (await this.getStore()).removeCreatedDraft(draftId);
    this.drafts.delete(draftId);
  }

  async resolveSelections(
    selections: readonly TurnSkillSelection[],
    defaultArguments?: string,
    runtime: 'codex' | 'claude' | 'provider' = 'provider',
  ): Promise<ResolvedTurnSkill[]> {
    const resolved = await Promise.all(
      selections.map(async (selection) => {
        const item: ResolvedSkillPackage = await (
          await this.getStore()
        ).resolveSelectable(selection.ref.source, selection.ref.skillId, selection.ref.digest);
        if (item.kind !== selection.kind)
          throw new SkillSettingsError('SOURCE_CHANGED', 'Skillの種類が変更されました');
        const selectionWithArguments = {
          ...selection,
          ...((selection.arguments ?? defaultArguments) === undefined
            ? {}
            : { arguments: (selection.arguments ?? defaultArguments)!.slice(0, 8_000) }),
        };
        const portableContent =
          item.compatibility.runtimeSupport[runtime] === 'portable'
            ? createPortableSkillFile(Buffer.from(item.content, 'utf8')).toString('utf8')
            : item.content;
        return {
          selection: selectionWithArguments,
          name: item.name,
          description: item.description,
          content: expandSkillArguments(portableContent, selectionWithArguments.arguments),
          packagePath: item.packagePath,
          activationPolicy: item.activationPolicy,
          compatibility: item.compatibility,
        };
      }),
    );
    return resolved;
  }

  async resolveAutoCandidates(
    runtime: 'codex' | 'claude' | 'provider',
  ): Promise<ResolvedTurnSkill[]> {
    await this.refreshContextCatalog();
    return [...this.autoCandidatesByRuntime[runtime]];
  }

  pinnedAutoCandidates(runtime: 'codex' | 'claude' | 'provider'): ResolvedTurnSkill[] {
    return [...this.autoCandidatesByRuntime[runtime]];
  }

  async setActivationPolicy(ref: SkillRef, policy: SkillActivationPolicy): Promise<void> {
    const operation = this.activationPolicyMutation.then(async () => {
      await (
        await this.getStore()
      ).setActivationPolicy(ref.source, ref.skillId, ref.digest, policy);
      await this.refreshContextCatalog();
    });
    this.activationPolicyMutation = operation.catch(() => undefined);
    await operation;
  }

  private async getStore(): Promise<SkillStore> {
    this.store ??= SkillStore.open({
      rootPath: join(this.input.homePath, '.sprintcoder', 'skills'),
    });
    return this.store;
  }

  private scanCandidates(): Promise<SkillCandidate[]> {
    return this.getStore().then((store) =>
      store.scanSources({
        claudePath: join(this.input.homePath, '.claude', 'skills'),
        agentsPath: join(this.input.homePath, '.agents', 'skills'),
      }),
    );
  }

  private async findCandidate(provider: SkillProvider, skillId: string): Promise<SkillCandidate> {
    const candidate = (await this.scanCandidates()).find(
      (item) => item.provider === provider && item.skillId === skillId,
    );
    if (candidate === undefined) throw new SkillSettingsError('NOT_FOUND', 'Skillが見つかりません');
    if (!candidate.valid)
      throw new SkillSettingsError('INVALID_SKILL', candidate.problems[0] ?? 'Skillが無効です');
    return candidate;
  }

  private removeExpired(): void {
    const now = this.now();
    for (const [previewId, record] of this.previews)
      if (record.expiresAtMs <= now) this.previews.delete(previewId);
  }

  private consumePreview(senderId: number, previewId: string): PreviewRecord {
    this.removeExpired();
    const record = this.previews.get(previewId);
    this.previews.delete(previewId);
    if (record === undefined || record.senderId !== senderId)
      throw new SkillSettingsError('PREVIEW_EXPIRED', 'プレビューの有効期限が切れました');
    return record;
  }

  private now(): number {
    return this.input.now?.() ?? Date.now();
  }
}

export class SkillSettingsError extends Error {
  constructor(
    readonly code:
      'NOT_FOUND' | 'INVALID_SKILL' | 'PREVIEW_EXPIRED' | 'PREVIEW_LIMIT' | 'SOURCE_CHANGED',
    message: string,
  ) {
    super(message);
    this.name = 'SkillSettingsError';
  }
}

export function skillSettingsPublicError(error: unknown): SkillSettingsError {
  if (error instanceof SkillSettingsError) return error;
  if (error instanceof SkillStoreError) {
    if (error.code === 'SOURCE_CHANGED')
      return new SkillSettingsError('SOURCE_CHANGED', 'Skillがプレビュー後に変更されました');
    if (error.code === 'CONFLICT')
      return new SkillSettingsError('INVALID_SKILL', '同名のSkillが既に存在します');
    return new SkillSettingsError('INVALID_SKILL', 'Skillを安全に読み込めません');
  }
  return new SkillSettingsError('INVALID_SKILL', 'Skillの読み込みに失敗しました');
}

function key(provider: SkillProvider, skillId: string): string {
  return `${provider}:${skillId}`;
}

function assertCompatibilityApproved(
  compatibility: SkillCatalogItem['compatibility'],
  nativeModeConfirmed: boolean,
): void {
  if (compatibility.requiresConversion)
    throw new SkillSettingsError('INVALID_SKILL', 'SkillはPortable版への変換が必要です');
  if (compatibility.nativeModeConsentRequired && !nativeModeConfirmed)
    throw new SkillSettingsError(
      'INVALID_SKILL',
      'Claude native modeのambient Skill警告を確認してください',
    );
}

function projectResolvedSkillForRuntime(
  skill: ResolvedTurnSkill,
  runtime: 'codex' | 'claude' | 'provider',
): ResolvedTurnSkill {
  if (skill.compatibility.runtimeSupport[runtime] !== 'portable') return skill;
  return {
    ...skill,
    content: createPortableSkillFile(Buffer.from(skill.content, 'utf8')).toString('utf8'),
  };
}
