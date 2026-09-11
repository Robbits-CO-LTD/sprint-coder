import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import {
  skillDraftCreateInputSchema,
  type SkillActivationPolicy,
  type SkillCatalog,
  type SkillCatalogItem,
  type SkillDraft,
  type SkillDraftCreateInput,
  type SkillRef,
  type TurnSkillSelection,
} from '@sprint-coder/contracts';
import {
  SkillStore,
  SkillStoreError,
  type ResolvedSkillPackage,
  type SkillCatalogSnapshotEntry,
} from './skill-store';
import { buildSkillCatalogContext, SkillCatalogContextError } from './skill-catalog-context';
import { createPortableSkillFile } from './skill-compatibility';
import { expandSkillArguments } from '../runtime-host/skill-arguments';
import { clipPublicMessage, formatZodIssues } from './zod-issue-message';

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
    if (ref.source !== 'created')
      throw new SkillSettingsError('INVALID_SKILL', '作成済みSkillのみ自動選択を変更できます');
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
    }).catch((error: unknown) => {
      this.store = null;
      throw error;
    });
    return this.store;
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
    if (error.code === 'INVALID_SKILL' && error.publicDetail !== undefined)
      return new SkillSettingsError('INVALID_SKILL', clipPublicMessage(error.publicDetail));
    return new SkillSettingsError('INVALID_SKILL', 'Skillを安全に読み込めません');
  }
  return new SkillSettingsError('INVALID_SKILL', 'Skillの読み込みに失敗しました');
}

export async function createSkillDraftWithPublicError(
  service: Pick<SkillSettingsService, 'createDraft'>,
  input: unknown,
): Promise<SkillDraft> {
  try {
    return await service.createDraft(skillDraftCreateInputSchema.parse(input));
  } catch (error) {
    if (error instanceof z.ZodError)
      throw new SkillSettingsError('INVALID_SKILL', formatZodIssues(error));
    throw skillSettingsPublicError(error);
  }
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
