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
});
