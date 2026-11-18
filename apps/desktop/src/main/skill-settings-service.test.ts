import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
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
  it('projects Claude metadata to portable Grok Skills for manual and automatic selection', async () => {
    const service = new SkillSettingsService({ homePath: await home() });
    const draft = await service.createDraft({
      kind: 'chat',
      skillId: 'portable-grok',
      files: [
        {
          path: 'SKILL.md',
          content:
            '---\nname: Grok review\ndescription: Review safely\nargument-hint: file\n---\nReview $ARGUMENTS.',
        },
      ],
    });
    const installed = await service.installDraft(draft.id, draft.digest);
    expect(installed.compatibility.runtimeSupport.grok).toBe('portable');
    const selected = await service.resolveSelections(
      [{ kind: 'chat', ref: installed.ref }],
      'main.ts',
      'grok',
    );
    expect(selected[0]?.content).toContain('Review main.ts.');
    expect(selected[0]?.content).not.toContain('argument-hint');
    await service.setActivationPolicy(installed.ref, 'auto-allowed');
    expect((await service.resolveAutoCandidates('grok'))[0]?.content).not.toContain(
      'argument-hint',
    );
    expect(service.pinnedAutoCandidates('grok')).toHaveLength(1);
    service.markContextCatalogUnavailable();
    expect(service.pinnedAutoCandidates('grok')).toEqual([]);
  });
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

describe('native CLI Skills', () => {
  it('discovers matching user and project packages alongside Sprint Coder Skills, and pins the chosen revision', async () => {
    const root = await home();
    const workspace = join(root, 'project');
    const service = new SkillSettingsService({ homePath: root });
    const add = async (base: string, config: string, id: string, marker: string) => {
      const dir = join(base, config, 'skills', id);
      await mkdir(join(dir, 'references'), { recursive: true });
      await writeFile(
        join(dir, 'SKILL.md'),
        `---\nname: ${id}\ndescription: test\n---\n${marker}\n`,
      );
      await writeFile(join(dir, 'references', 'sample.txt'), marker);
      return dir;
    };
    const draft = await service.createDraft({
      kind: 'chat',
      skillId: 'shared',
      files: [
        {
          path: 'SKILL.md',
          content: '---\nname: shared\ndescription: shared test\n---\nUse together.\n',
        },
      ],
    });
    const shared = await service.installDraft(draft.id, draft.digest);
    await add(root, '.agents', 'agents-home', 'USER');
    await add(root, '.codex', 'native-test', 'HOME');
    const projectDir = await add(workspace, '.agents', 'native-test', 'PROJECT');
    await add(root, '.claude', 'claude-home', 'CLAUDE');
    const codex = await service.listCatalog('codex', [workspace]);
    const claude = await service.listCatalog('claude', [workspace]);
    expect(codex.items.map((i) => i.ref.skillId)).toEqual(
      expect.arrayContaining(['shared', 'native-test', 'agents-home']),
    );
    expect(codex.items.some((i) => i.ref.source === 'claude')).toBe(false);
    expect(claude.items.map((i) => i.ref.skillId)).toEqual(
      expect.arrayContaining(['shared', 'claude-home']),
    );
    expect(claude.items.some((i) => i.ref.source === 'agents')).toBe(false);
    const nativeClaude = claude.items.find((i) => i.ref.source === 'claude')!;
    const claudePicks = await service.resolveSelections(
      [
        { kind: 'chat', ref: shared.ref },
        { kind: 'chat', ref: nativeClaude.ref },
      ],
      undefined,
      'claude',
      [workspace],
    );
    expect(claudePicks.map((s) => s.selection.ref.source)).toEqual(['created', 'claude']);
    expect(
      await readFile(join(claudePicks[1]!.packagePath, 'references', 'sample.txt'), 'utf8'),
    ).toBe('CLAUDE');
    const ref = codex.items.find((i) => i.ref.skillId === 'native-test')!.ref;
    const picks = [
      { kind: 'chat' as const, ref: shared.ref },
      { kind: 'chat' as const, ref },
    ];
    const resolved = await service.resolveSelections(picks, undefined, 'codex', [workspace]);
    expect(resolved[1]?.content).toContain('PROJECT');
    expect(basename(dirname(dirname(dirname(resolved[1]!.packagePath))))).toBe('revisions');
    expect(await readFile(join(resolved[1]!.packagePath, 'references', 'sample.txt'), 'utf8')).toBe(
      'PROJECT',
    );
    const catalog = JSON.parse(service.contextCatalogForTurn(picks, false, resolved));
    expect(catalog.items).toContainEqual(
      expect.objectContaining({ id: 'native-test', source: 'agents', selected: true }),
    );
    expect(catalog.items.some((i: { id: string }) => i.id === 'agents-home')).toBe(false);
    await expect(
      service.resolveSelections(picks, undefined, 'claude', [workspace]),
    ).rejects.toMatchObject({ code: 'INVALID_SKILL' });
    await expect(
      service.resolveSelections(picks, undefined, 'provider', [workspace]),
    ).rejects.toMatchObject({ code: 'INVALID_SKILL' });
    await writeFile(join(projectDir, 'references', 'sample.txt'), 'CHANGED');
    await expect(
      service.resolveSelections(picks, undefined, 'codex', [workspace]),
    ).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    expect(await readFile(join(resolved[1]!.packagePath, 'references', 'sample.txt'), 'utf8')).toBe(
      'PROJECT',
    );
  });
});
