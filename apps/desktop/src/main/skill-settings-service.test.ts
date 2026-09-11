import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SkillSettingsService } from './skill-settings-service';

const roots: string[] = [];

async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sprint-coder-skill-settings-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Skill activation source boundary', () => {
  it.each(['agents', 'claude', 'builtin'] as const)(
    'rejects activation changes for %s before opening or creating a Skill Store',
    async (source) => {
      const root = await home();
      const service = new SkillSettingsService({ homePath: root });
      await expect(
        service.setActivationPolicy(
          { source, skillId: 'legacy', digest: 'a'.repeat(64) },
          'auto-allowed',
        ),
      ).rejects.toMatchObject({ code: 'INVALID_SKILL' });
      await expect(lstat(join(root, '.sprintcoder'))).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );
});

describe.skipIf(process.platform === 'win32')('SkillSettingsService', () => {
  it('retries opening the store after a transient filesystem failure', async () => {
    const root = await home();
    const blocked = join(root, '.sprintcoder');
    await writeFile(blocked, 'temporary obstruction');
    const service = new SkillSettingsService({ homePath: root });
    await expect(service.listCatalog()).rejects.toThrow();
    await rm(blocked);
    await expect(service.listCatalog()).resolves.toMatchObject({ items: [] });
  });
  it('provides an explicit minimal catalog when the Skill Store is unavailable at startup', async () => {
    const service = new SkillSettingsService({ homePath: await home() });
    service.markContextCatalogUnavailable();

    const catalog = JSON.parse(service.contextCatalogForTurn([], false)) as {
      count: number;
      items: Array<{ id: string; enabled: boolean; availability: string }>;
    };
    expect(catalog.count).toBe(4);
    expect(catalog.items.map(({ id }) => id)).toEqual([
      'imagegen',
      'skill-creator',
      'sprint-coder-product',
      'sprint-coder-team',
    ]);
    expect(catalog.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ enabled: false, availability: 'invalid' }),
      ]),
    );
  });

  it('keeps an AI-produced Skill as a Draft until an exact digest is confirmed for install', async () => {
    const root = await home();
    const service = new SkillSettingsService({ homePath: root });
    const draft = await service.createDraft({
      kind: 'chat',
      skillId: 'review-helper',
      files: [
        {
          path: 'SKILL.md',
          content:
            '---\nname: Review Helper\ndescription: Review code safely\n---\n\n# Review\n\nInspect the requested files.',
        },
        {
          path: 'agents/openai.yaml',
          content: 'display_name: Review Helper\n',
        },
      ],
    });

    const reopened = new SkillSettingsService({ homePath: root });
    expect(await reopened.listDrafts()).toEqual([draft]);
    expect((await service.listCatalog()).items).toEqual([]);
    await expect(service.installDraft(draft.id, '0'.repeat(64))).rejects.toMatchObject({
      code: 'SOURCE_CHANGED',
    });

    const installed = await reopened.installDraft(draft.id, draft.digest);
    expect(installed).toMatchObject({
      kind: 'chat',
      ref: { source: 'created', skillId: 'review-helper', digest: draft.digest },
    });
    expect(await reopened.listDrafts()).toEqual([]);
    expect((await reopened.listCatalog()).items[0]).toMatchObject({
      ref: { source: 'created', skillId: 'review-helper' },
    });
    await reopened.setActivationPolicy(installed.ref, 'auto-allowed');
    expect(await reopened.resolveAutoCandidates('provider')).toEqual([
      expect.objectContaining({
        activationPolicy: 'auto-allowed',
        selection: { ref: installed.ref, kind: 'chat' },
      }),
    ]);
    await expect(
      reopened.setActivationPolicy({ ...installed.ref, digest: '0'.repeat(64) }, 'manual'),
    ).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    await reopened.setActivationPolicy(installed.ref, 'manual');
    expect(await reopened.resolveAutoCandidates('provider')).toEqual([]);
  });

  it('rejects credentials and a Team Draft without a valid Blueprint', async () => {
    const root = await home();
    const service = new SkillSettingsService({ homePath: root });
    await expect(
      service.createDraft({
        kind: 'chat',
        skillId: 'unsafe',
        files: [
          {
            path: 'SKILL.md',
            content:
              '---\nname: Unsafe\ndescription: Unsafe draft\n---\nAuthorization: Bearer sprint-secret-token-value',
          },
        ],
      }),
    ).rejects.toThrow();
    await expect(
      service.createDraft({
        kind: 'team',
        skillId: 'missing-blueprint',
        files: [
          {
            path: 'SKILL.md',
            content: '---\nname: Team\ndescription: Team draft\n---\n',
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SKILL' });
  });
});
