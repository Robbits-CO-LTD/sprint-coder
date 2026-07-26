import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type {
  SkillCandidateSummary,
  SkillImportResult,
  SkillPreviewResult,
  SkillProvider,
  SkillScanResult,
} from '@sprint-coder/contracts';
import {
  SkillStore,
  SkillStoreError,
  type SkillCandidate,
  type SkillImportPreview,
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

export class SkillSettingsService {
  private readonly previews = new Map<string, PreviewRecord>();
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
