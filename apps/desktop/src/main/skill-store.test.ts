import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SkillStore, SkillStoreError, type SkillProvider } from './skill-store';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sprint-coder-skills-'));
  roots.push(root);
  return root;
}

async function fixture(
  sourceRoot: string,
  id: string,
  provider: SkillProvider = 'claude',
): Promise<{ provider: SkillProvider; path: string }> {
  const path = join(sourceRoot, id);
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, 'SKILL.md'),
    `---\nname: ${id}\ndescription: Test skill ${id}\n---\n\nInstructions.\n`,
  );
  return { provider, path };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.skipIf(process.platform === 'win32')('SkillStore', () => {
  it('creates a private store and detects either, both, or neither source', async () => {
    const root = await tempRoot();
    const claude = join(root, '.claude', 'skills');
    const agents = join(root, '.agents', 'skills');
    await fixture(claude, 'claude-skill');
    await fixture(agents, 'agent-skill', 'agents');
    const storeRoot = join(root, '.sprintcoder', 'skills');
    const store = await SkillStore.open({ rootPath: storeRoot });

    expect((await lstat(storeRoot)).mode & 0o777).toBe(0o700);
    expect(await store.scanSources({})).toEqual([]);
    expect((await store.scanSources({ claudePath: claude })).map((item) => item.skillId)).toEqual([
      'claude-skill',
    ]);
    expect((await store.scanSources({ agentsPath: agents })).map((item) => item.skillId)).toEqual([
      'agent-skill',
    ]);
    expect(
      (await store.scanSources({ claudePath: claude, agentsPath: agents })).map(
        (item) => `${item.provider}:${item.skillId}`,
      ),
    ).toEqual(['claude:claude-skill', 'agents:agent-skill']);
  });

  it('previews and atomically imports a validated copy with private modes', async () => {
    const root = await tempRoot();
    const source = join(root, '.claude', 'skills');
    const { path } = await fixture(source, 'writer');
    await mkdir(join(path, 'scripts'));
    await writeFile(join(path, 'scripts', 'run.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const storeRoot = join(root, '.sprintcoder', 'skills');
    const store = await SkillStore.open({ rootPath: storeRoot });
    const [candidate] = await store.scanSources({ claudePath: source });
    const preview = await store.previewImport(candidate!);
    const imported = await store.importSkill(preview);

    expect(imported.status).toBe('imported');
    expect(preview.files).toEqual(['scripts/run.sh', 'SKILL.md']);
    expect((await lstat(imported.path)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(imported.path, 'SKILL.md'))).mode & 0o777).toBe(0o600);
    expect((await lstat(join(imported.path, 'scripts', 'run.sh'))).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(join(imported.path, 'manifest.json'), 'utf8'))).toMatchObject({
      version: 1,
      source: 'claude',
      name: 'writer',
      activationMode: 'manual',
      digest: preview.digest,
    });
    expect(
      (await readdir(join(storeRoot, 'imported', 'claude'))).some((name) =>
        name.startsWith('.staging-'),
      ),
    ).toBe(false);
  });

  it('excludes hidden and known-secret files with warnings', async () => {
    const root = await tempRoot();
    const source = join(root, 'skills');
    const { path } = await fixture(source, 'safe');
    await writeFile(join(path, '.env'), 'SECRET=value');
    await mkdir(join(path, '.git'));
    await writeFile(join(path, '.git', 'config'), 'secret');
    await writeFile(join(path, 'credentials.json'), '{}');
    const store = await SkillStore.open({ rootPath: join(root, 'store') });
    const [candidate] = await store.scanSources({ claudePath: source });
    const preview = await store.previewImport(candidate!);

    expect(preview.files).toEqual(['SKILL.md']);
    expect(preview.warnings).toEqual([
      'Excluded .env',
      'Excluded .git',
      'Excluded credentials.json',
    ]);
  });

  it('rejects symlinks, missing SKILL.md, invalid frontmatter, and reserved names', async () => {
    const root = await tempRoot();
    const source = join(root, 'skills');
    await mkdir(source, { recursive: true });
    await fixture(source, 'valid');
    await symlink(join(source, 'valid'), join(source, 'linked'));
    await mkdir(join(source, 'missing'));
    await fixture(source, 'bad-frontmatter');
    await writeFile(
      join(source, 'bad-frontmatter', 'SKILL.md'),
      '---\nname: bad\ndescription: bad\nextra: denied\n---\n',
    );
    await fixture(source, 'team');
    const store = await SkillStore.open({ rootPath: join(root, 'store') });
    const candidates = await store.scanSources({ claudePath: source });

    expect(candidates.find((item) => item.skillId === 'linked')?.valid).toBe(false);
    expect(candidates.find((item) => item.skillId === 'team')?.valid).toBe(false);
    for (const id of ['missing', 'bad-frontmatter']) {
      const candidate = candidates.find((item) => item.skillId === id)!;
      await expect(store.previewImport(candidate)).rejects.toBeInstanceOf(SkillStoreError);
    }
  });

  it('rejects unsafe file types and bounded-resource violations', async () => {
    const root = await tempRoot();
    const source = join(root, 'skills');
    const { path } = await fixture(source, 'bounded');
    await writeFile(join(path, 'large.bin'), Buffer.alloc(1024 * 1024 + 1));
    const store = await SkillStore.open({ rootPath: join(root, 'store') });
    const [candidate] = await store.scanSources({ claudePath: source });
    await expect(store.previewImport(candidate!)).rejects.toMatchObject({
      code: 'INVALID_SKILL',
    });

    await rm(join(path, 'large.bin'));
    await symlink(join(path, 'SKILL.md'), join(path, 'linked.md'));
    await expect(store.previewImport(candidate!)).rejects.toMatchObject({
      code: 'UNSAFE_SOURCE',
    });
  });

  it('is idempotent for the same digest and conflicts on a changed skill', async () => {
    const root = await tempRoot();
    const source = join(root, 'skills');
    const { path } = await fixture(source, 'stable');
    const store = await SkillStore.open({ rootPath: join(root, 'store') });
    let [candidate] = await store.scanSources({ claudePath: source });
    const preview = await store.previewImport(candidate!);
    expect((await store.importSkill(preview)).status).toBe('imported');
    expect((await store.importSkill(preview)).status).toBe('already-imported');

    await writeFile(join(path, 'notes.md'), 'changed');
    [candidate] = await store.scanSources({ claudePath: source });
    const changed = await store.previewImport(candidate!);
    await expect(store.importSkill(changed)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('detects source changes after preview and leaves no partial import', async () => {
    const root = await tempRoot();
    const source = join(root, 'skills');
    const { path } = await fixture(source, 'mutable');
    const storeRoot = join(root, 'store');
    const store = await SkillStore.open({ rootPath: storeRoot });
    const [candidate] = await store.scanSources({ claudePath: source });
    const preview = await store.previewImport(candidate!);
    await writeFile(join(path, 'SKILL.md'), `${await readFile(join(path, 'SKILL.md'), 'utf8')}\n`);

    await expect(store.importSkill(preview)).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    expect(await readdir(join(storeRoot, 'imported', 'claude'))).toEqual([]);
  });

  it('rejects forged previews and unsafe existing destinations', async () => {
    const root = await tempRoot();
    const source = join(root, 'skills');
    await fixture(source, 'forgery');
    const storeRoot = join(root, 'store');
    const store = await SkillStore.open({ rootPath: storeRoot });
    const [candidate] = await store.scanSources({ claudePath: source });
    const preview = await store.previewImport(candidate!);
    await expect(store.importSkill({ ...preview })).rejects.toMatchObject({
      code: 'INVALID_SKILL',
    });

    const destination = join(storeRoot, 'imported', 'claude', 'forgery');
    await writeFile(destination, 'collision');
    await expect(store.importSkill(preview)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('removes only owned stale staging directories when opening', async () => {
    const root = await tempRoot();
    const storeRoot = join(root, 'store');
    await mkdir(
      join(storeRoot, 'imported', 'claude', '.staging-11111111-1111-1111-1111-111111111111'),
      {
        recursive: true,
      },
    );
    await mkdir(join(storeRoot, 'imported', 'claude', '.staging-user-data'), {
      recursive: true,
    });
    await SkillStore.open({ rootPath: storeRoot });
    expect(await readdir(join(storeRoot, 'imported', 'claude'))).toEqual(['.staging-user-data']);
  });

  it('normalizes pre-existing permissive store permissions', async () => {
    const root = await tempRoot();
    const storeRoot = join(root, 'store');
    await mkdir(storeRoot);
    await chmod(storeRoot, 0o777);
    await SkillStore.open({ rootPath: storeRoot });
    expect((await lstat(storeRoot)).mode & 0o777).toBe(0o700);
  });

  it('preserves enabled state across update and removes only an imported skill', async () => {
    const root = await tempRoot();
    const source = join(root, 'skills');
    const { path } = await fixture(source, 'managed');
    const store = await SkillStore.open({ rootPath: join(root, 'store') });
    let [candidate] = await store.scanSources({ claudePath: source });
    let preview = await store.previewImport(candidate!);
    await store.importSkill(preview);
    await store.setEnabled('claude', 'managed', false);
    await writeFile(join(path, 'SKILL.md'), '---\nname: managed\ndescription: Updated\n---\n');
    [candidate] = await store.scanSources({ claudePath: source });
    preview = await store.previewImport(candidate!);
    await store.updateSkill(preview);
    expect((await store.listImported())[0]?.manifest.enabled).toBe(false);
    await store.removeImported('claude', 'managed');
    expect(await store.listImported()).toEqual([]);
    expect(await readFile(join(path, 'SKILL.md'), 'utf8')).toContain('Updated');
  });

  it('lists executable skills, detects Team blueprints, and pins an immutable revision', async () => {
    const root = await tempRoot();
    const source = join(root, 'skills');
    const { path } = await fixture(source, 'company-team');
    await mkdir(join(path, 'team'));
    await writeFile(
      join(path, 'team', 'blueprint.json'),
      JSON.stringify({
        version: 1,
        kind: 'team',
        policy: {
          maxAgentDepth: 4,
          maxConcurrentExecutions: 8,
          allowWorkerDirectMessages: true,
          budgetMode: 'bounded',
        },
        leaderInstructions: 'Lead',
        roles: [
          {
            key: 'worker',
            title: 'Worker',
            parentKey: 'leader',
            responsibility: 'Work',
            scope: [],
            nonGoals: [],
            doneCriteria: ['Done'],
            required: true,
            canDelegate: false,
          },
        ],
      }),
    );
    const store = await SkillStore.open({ rootPath: join(root, 'store') });
    const [candidate] = await store.scanSources({ claudePath: source });
    const preview = await store.previewImport(candidate!);
    await store.importSkill(preview);

    expect(await store.listSelectable()).toEqual([
      expect.objectContaining({
        source: 'claude',
        skillId: 'company-team',
        kind: 'team',
        digest: preview.digest,
        enabled: true,
      }),
    ]);
    const resolved = await store.resolveSelectable('claude', 'company-team', preview.digest);
    expect(resolved.content).toContain('Test skill company-team');
    expect(resolved.content).toContain('Pinned Team Blueprint');
    expect(await readFile(join(resolved.packagePath, 'SKILL.md'), 'utf8')).toContain(
      'Test skill company-team',
    );

    await store.setEnabled('claude', 'company-team', false);
    await expect(
      store.resolveSelectable('claude', 'company-team', preview.digest),
    ).rejects.toMatchObject({ code: 'INVALID_SKILL' });
    expect(await readFile(join(resolved.packagePath, 'SKILL.md'), 'utf8')).toContain(
      'Test skill company-team',
    );
  });

  it('exports and removes a created Skill without deleting its pinned revision', async () => {
    const root = await tempRoot();
    const store = await SkillStore.open({ rootPath: join(root, 'store') });
    const installed = await store.installCreatedSkill('created-reviewer', [
      {
        path: 'SKILL.md',
        content:
          '---\nname: Created Reviewer\ndescription: Review created code\n---\n\nReview files.',
      },
    ]);
    const exportRoot = join(root, 'export');
    await mkdir(exportRoot);
    const exported = await store.exportCreated(installed.skillId, installed.digest, exportRoot);
    expect(await readFile(join(exported, 'SKILL.md'), 'utf8')).toContain('Review files');

    const pinned = (await store.resolveSelectable('created', installed.skillId, installed.digest))
      .packagePath;
    await store.setCreatedEnabled(installed.skillId, installed.digest, false);
    expect((await store.listSelectable())[0]?.enabled).toBe(false);
    await expect(
      store.resolveSelectable('created', installed.skillId, installed.digest),
    ).rejects.toMatchObject({ code: 'INVALID_SKILL' });
    await store.setCreatedEnabled(installed.skillId, installed.digest, true);
    await store.removeCreated(installed.skillId, installed.digest);
    expect(await store.listSelectable()).toEqual([]);
    expect(await readFile(join(pinned, 'SKILL.md'), 'utf8')).toContain('Review files');
  });
});
