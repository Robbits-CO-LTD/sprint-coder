import { describe, expect, it, vi } from 'vitest';
import { SKILL_DRAFT_CREATE_INPUT_JSON_SCHEMA } from '@sprint-coder/contracts';
import { SKILL_DRAFT_TOOL } from './provider-workspace-tools';
import { BUILTIN_SKILL_CREATOR_CONTENT } from './skill-creator-builtin';
import {
  createSkillDraftWithPublicError,
  skillSettingsPublicError,
} from './skill-settings-service';
import { SkillStore, SkillStoreError } from './skill-store';

const skillFile = {
  path: 'SKILL.md',
  content: '---\nname: skill-draft-contract\ndescription: Validate Skill Draft contracts.\n---\n',
} as const;

describe('Skill Draft public contract', () => {
  it('publishes the actual required input fields to Provider runtimes', () => {
    expect(SKILL_DRAFT_TOOL.inputSchema).toEqual(SKILL_DRAFT_CREATE_INPUT_JSON_SCHEMA);
    expect(SKILL_DRAFT_TOOL.inputSchema).toMatchObject({
      required: ['kind', 'skillId', 'files'],
      properties: {
        kind: expect.any(Object),
        skillId: expect.any(Object),
        files: expect.any(Object),
      },
    });
  });

  it('preserves the invalid Team Blueprint path in the public error', () => {
    const store = Object.create(SkillStore.prototype) as SkillStore;
    const blueprint = {
      version: 1,
      kind: 'team',
      policy: {
        maxAgentDepth: 1,
        maxConcurrentExecutions: 1,
        allowWorkerDirectMessages: false,
        budgetMode: 'bounded',
      },
      leaderInstructions: 'Lead.',
      roles: [
        {
          key: 'reviewer',
          title: 'Reviewer',
          parentKey: 'missing-parent',
          responsibility: 'Review.',
          scope: [],
          nonGoals: [],
          doneCriteria: ['Reviewed.'],
          required: true,
          canDelegate: false,
        },
      ],
    };

    let publicError: Error | undefined;
    try {
      store.validateCreatedSkill('skill-draft-contract', [
        skillFile,
        { path: 'team/blueprint.json', content: JSON.stringify(blueprint) },
      ]);
    } catch (error) {
      publicError = skillSettingsPublicError(error);
    }

    expect(publicError?.message).toContain('roles[0].parentKey');
    expect(publicError?.message).toContain('親Roleが存在しません');
  });

  it('reports malformed Blueprint JSON without echoing its content', () => {
    const store = Object.create(SkillStore.prototype) as SkillStore;
    let publicError: Error | undefined;
    try {
      store.validateCreatedSkill('skill-draft-contract', [
        skillFile,
        { path: 'team/blueprint.json', content: '{"label":"PRIVATE_MARKER_VALUE",}' },
      ]);
    } catch (error) {
      publicError = skillSettingsPublicError(error);
    }

    expect(publicError?.message).toContain('team/blueprint.json がJSONとして不正です');
    expect(publicError?.message).not.toContain('PRIVATE_MARKER_VALUE');
  });

  it.each([
    [{ skillId: 'valid', files: [skillFile] }, 'kind'],
    [{ kind: 'chat', skillId: '-invalid', files: [skillFile] }, 'skillId'],
  ])('formats a %s Draft input violation before calling the service', async (input, path) => {
    const createDraft = vi.fn();
    await expect(createSkillDraftWithPublicError({ createDraft }, input)).rejects.toMatchObject({
      code: 'INVALID_SKILL',
      message: expect.stringContaining(path),
    });
    expect(createDraft).not.toHaveBeenCalled();
  });

  it('returns the complete successful Draft result unchanged', async () => {
    const draft = {
      id: 'draft-1',
      kind: 'chat' as const,
      skillId: 'skill-draft-contract',
      name: 'Skill Draft Contract',
      description: 'Validate Skill Draft contracts.',
      digest: 'a'.repeat(64),
      files: [skillFile],
      createdAt: '2026-08-27T00:00:00.000Z',
      updatedAt: '2026-08-27T00:00:00.000Z',
    };
    const createDraft = vi.fn(async () => draft);

    await expect(
      createSkillDraftWithPublicError(
        { createDraft },
        { kind: 'chat', skillId: 'skill-draft-contract', files: [skillFile] },
      ),
    ).resolves.toMatchObject({
      id: 'draft-1',
      skillId: 'skill-draft-contract',
      kind: 'chat',
      files: [skillFile],
    });
    expect(createDraft).toHaveBeenCalledOnce();
  });

  it('keeps non-Blueprint SkillStore details redacted', () => {
    const result = skillSettingsPublicError(
      new SkillStoreError('INVALID_SKILL', 'Skill file is too large: private/path.md'),
    );
    expect(result.message).toBe('Skillを安全に読み込めません');
    expect(result.message).not.toContain('private/path.md');
  });

  it('teaches the built-in creator to confirm the Draft ID', () => {
    expect(BUILTIN_SKILL_CREATOR_CONTENT).toContain('kind、skillId、files');
    expect(BUILTIN_SKILL_CREATOR_CONTENT).toContain('Draft ID');
    expect(BUILTIN_SKILL_CREATOR_CONTENT).toContain('team/blueprint.json');
  });
});
