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
  SkillScanResult,
  TurnSkillSelection,
} from '@sprint-coder/contracts';
import {
  SkillStore,
  SkillStoreError,
  type SkillCandidate,
  type SkillImportPreview,
  type ResolvedSkillPackage,
} from './skill-store';

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
}>;

export class SkillSettingsService {
  private readonly previews = new Map<string, PreviewRecord>();
  private readonly drafts = new Map<string, SkillDraft>();
  private store: Promise<SkillStore> | null = null;

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
    };
  }

  async import(senderId: number, previewId: string): Promise<SkillImportResult> {
    const record = this.consumePreview(senderId, previewId);
    const candidate = await this.findCandidate(record.provider, record.skillId);
    const currentPreview = await (await this.getStore()).previewImport(candidate);
    if (currentPreview.digest !== record.digest)
      throw new SkillSettingsError('SOURCE_CHANGED', 'Skillがプレビュー後に変更されました');
    const result = await (await this.getStore()).importSkill(currentPreview);
    return {
      provider: record.provider,
      skillId: record.skillId,
      status: result.status,
      name: result.manifest.name,
    };
  }

  async update(senderId: number, previewId: string): Promise<SkillImportResult> {
    const record = this.consumePreview(senderId, previewId);
    const candidate = await this.findCandidate(record.provider, record.skillId);
    const currentPreview = await (await this.getStore()).previewImport(candidate);
    if (currentPreview.digest !== record.digest)
      throw new SkillSettingsError('SOURCE_CHANGED', 'Skillがプレビュー後に変更されました');
    const result = await (await this.getStore()).updateSkill(currentPreview);
    return {
      provider: record.provider,
      skillId: record.skillId,
      status: result.status,
      name: result.manifest.name,
    };
  }

  async setEnabled(provider: SkillProvider, skillId: string, enabled: boolean): Promise<void> {
    await (await this.getStore()).setEnabled(provider, skillId, enabled);
  }

  async remove(provider: SkillProvider, skillId: string): Promise<void> {
    await (await this.getStore()).removeImported(provider, skillId);
  }

  async removeCreated(skillId: string, digest: string): Promise<void> {
    await (await this.getStore()).removeCreated(skillId, digest);
  }

  async setCreatedEnabled(skillId: string, digest: string, enabled: boolean): Promise<void> {
    await (await this.getStore()).setCreatedEnabled(skillId, digest, enabled);
  }

  async exportCreated(skillId: string, digest: string, destinationParent: string): Promise<string> {
    return (await this.getStore()).exportCreated(skillId, digest, destinationParent);
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
      removable: item.removable,
      exportable: item.exportable,
    }));
    const revision = createHash('sha256').update(JSON.stringify(items)).digest('hex');
    return { revision, items };
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
    const installed = await (await this.getStore()).installCreatedSkill(draft.skillId, draft.files);
    await (await this.getStore()).removeCreatedDraft(draftId);
    this.drafts.delete(draftId);
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
      removable: installed.removable,
      exportable: installed.exportable,
    };
  }

  async installPrepared(input: SkillDraftCreateInput): Promise<SkillCatalogItem> {
    const validation = (await this.getStore()).validateCreatedSkill(input.skillId, input.files);
    if (validation.kind !== input.kind)
      throw new SkillSettingsError(
        'INVALID_SKILL',
        input.kind === 'team'
          ? 'Team Skillにはteam/blueprint.jsonが必要です'
          : 'Chat SkillへTeam Blueprintを含めることはできません',
      );
    const installed = await (await this.getStore()).installCreatedSkill(input.skillId, input.files);
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

  async resolveSelections(selections: readonly TurnSkillSelection[]): Promise<ResolvedTurnSkill[]> {
    const resolved = await Promise.all(
      selections.map(async (selection) => {
        const item: ResolvedSkillPackage = await (
          await this.getStore()
        ).resolveSelectable(selection.ref.source, selection.ref.skillId, selection.ref.digest);
        if (item.kind !== selection.kind)
          throw new SkillSettingsError('SOURCE_CHANGED', 'Skillの種類が変更されました');
        return {
          selection,
          name: item.name,
          description: item.description,
          content: item.content,
          packagePath: item.packagePath,
        };
      }),
    );
    return resolved;
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
