import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

async function skill(root: string, provider: 'claude' | 'agents', id: string): Promise<string> {
  const path = join(root, provider === 'claude' ? '.claude' : '.agents', 'skills', id);
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, 'SKILL.md'),
    `---\nname: ${id}\ndescription: ${id} description\n---\n`,
  );
  return path;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.skipIf(process.platform === 'win32')('SkillSettingsService', () => {
  it('provides an explicit minimal catalog when the Skill Store is unavailable at startup', async () => {
    const service = new SkillSettingsService({ homePath: await home() });
    service.markContextCatalogUnavailable();

    const catalog = JSON.parse(service.contextCatalogForTurn([], false)) as {
      count: number;
      items: Array<{ id: string; enabled: boolean; availability: string }>;
    };
    expect(catalog.count).toBe(4);
    expect(catalog.items.map(({ id }) => id)).toEqual([
      'import-skill',
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

  it('scans fixed provider roots and reports imported state', async () => {
    const root = await home();
    await skill(root, 'claude', 'writer');
    await skill(root, 'agents', 'reviewer');
    const service = new SkillSettingsService({ homePath: root });

    expect(await service.scan()).toMatchObject({
      claudeDetected: 1,
      agentsDetected: 1,
      importedCount: 0,
      invalidCount: 0,
    });
    const preview = await service.preview(7, 'claude', 'writer');
    await service.import(7, preview.previewId);
    expect(await service.scan()).toMatchObject({ importedCount: 1 });
  });

  it('binds a one-use preview to its sender', async () => {
    const root = await home();
    await skill(root, 'claude', 'writer');
    const service = new SkillSettingsService({ homePath: root });
    const preview = await service.preview(7, 'claude', 'writer');

    await expect(service.import(8, preview.previewId)).rejects.toMatchObject({
      code: 'PREVIEW_EXPIRED',
    });
    await expect(service.import(7, preview.previewId)).rejects.toMatchObject({
      code: 'PREVIEW_EXPIRED',
    });
  });

  it('expires previews deterministically at the TTL boundary', async () => {
    const root = await home();
    await skill(root, 'claude', 'writer');
    let now = 1_000;
    const service = new SkillSettingsService({ homePath: root, now: () => now });
    const preview = await service.preview(7, 'claude', 'writer');
    now += 5 * 60 * 1_000;

    await expect(service.import(7, preview.previewId)).rejects.toMatchObject({
      code: 'PREVIEW_EXPIRED',
    });
  });

  it('rejects a source changed after preview and consumes the token', async () => {
    const root = await home();
    const path = await skill(root, 'claude', 'writer');
    const service = new SkillSettingsService({ homePath: root });
    const preview = await service.preview(7, 'claude', 'writer');
    await writeFile(
      join(path, 'SKILL.md'),
      `${await readFile(join(path, 'SKILL.md'), 'utf8')}\nchanged\n`,
    );

    await expect(service.import(7, preview.previewId)).rejects.toMatchObject({
      code: 'SOURCE_CHANGED',
    });
    await expect(service.import(7, preview.previewId)).rejects.toMatchObject({
      code: 'PREVIEW_EXPIRED',
    });
  });

  it('does not resolve arbitrary provider paths from a skill id', async () => {
    const root = await home();
    const service = new SkillSettingsService({ homePath: root });
    await expect(service.preview(7, 'claude', '../outside')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('detects, applies, disables, and removes an imported skill update', async () => {
    const root = await home();
    const path = await skill(root, 'claude', 'writer');
    const service = new SkillSettingsService({ homePath: root });
    let preview = await service.preview(7, 'claude', 'writer');
    await service.import(7, preview.previewId);
    await writeFile(
      join(path, 'SKILL.md'),
      '---\nname: writer\ndescription: Updated writer\n---\n',
    );

    expect((await service.scan()).installed[0]).toMatchObject({ updateAvailable: true });
    preview = await service.preview(7, 'claude', 'writer');
    await service.update(7, preview.previewId);
    expect((await service.scan()).installed[0]).toMatchObject({
      updateAvailable: false,
      enabled: true,
    });

    await service.setEnabled('claude', 'writer', false);
    expect((await service.scan()).installed[0]).toMatchObject({ enabled: false });
    await service.remove('claude', 'writer');
    expect(await service.scan()).toMatchObject({ importedCount: 0, installed: [] });
  });

  it('returns a catalog and resolves only its pinned enabled revision', async () => {
    const root = await home();
    await skill(root, 'agents', 'reviewer');
    const service = new SkillSettingsService({ homePath: root });
    const preview = await service.preview(7, 'agents', 'reviewer');
    await service.import(7, preview.previewId);

    const catalog = await service.listCatalog();
    expect(catalog.revision).toMatch(/^[a-f0-9]{64}$/);
    const item = catalog.items[0]!;
    expect(item).toMatchObject({
      kind: 'chat',
      name: 'reviewer',
      ref: { source: 'agents', skillId: 'reviewer' },
    });
    const [resolved] = await service.resolveSelections([{ kind: item.kind, ref: item.ref }]);
    expect(resolved?.content).toContain('reviewer description');
    expect(resolved?.packagePath).toContain(item.ref.digest);

    await service.setEnabled('agents', 'reviewer', false);
    await expect(
      service.resolveSelections([{ kind: item.kind, ref: item.ref }]),
    ).rejects.toMatchObject({ code: 'INVALID_SKILL' });
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
  });

  it('installs and enables an AI-prepared imported Skill without a Draft', async () => {
    const root = await home();
    const service = new SkillSettingsService({ homePath: root });
    const installed = await service.installPrepared({
      kind: 'chat',
      skillId: 'imported-writer',
      files: [
        {
          path: 'SKILL.md',
          content:
            '---\nname: Imported Writer\ndescription: Writes with Sprint Coder\n---\n\n# Writer\n',
        },
      ],
    });

    expect(installed).toMatchObject({
      enabled: true,
      kind: 'chat',
      ref: { source: 'created', skillId: 'imported-writer' },
    });
    expect((await service.listCatalog()).items).toContainEqual(installed);
    expect(await service.listDrafts()).toEqual([]);
  });

  it('reads invalid-frontmatter source text from the selected CLI root for AI repair', async () => {
    const root = await home();
    const path = await skill(root, 'claude', 'legacy-writer');
    await writeFile(
      join(path, 'SKILL.md'),
      '---\nname: Legacy Writer\ndescription: Legacy\nallowed-tools: Read\n---\n\n# Legacy\n',
    );
    const service = new SkillSettingsService({ homePath: root });

    const source = await service.readImportSource({ cli: 'claude', skillId: 'legacy-writer' });

    expect(source).toMatchObject({
      cli: 'claude',
      skillId: 'legacy-writer',
      files: [{ path: 'SKILL.md', content: expect.stringContaining('allowed-tools: Read') }],
    });
    expect(source.digest).toMatch(/^[a-f0-9]{64}$/);
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
