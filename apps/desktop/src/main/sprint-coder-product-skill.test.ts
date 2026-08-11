import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import desktopPackage from '../../package.json';
import {
  BUILTIN_SPRINT_CODER_PRODUCT_SKILL_CONTENT,
  BUILTIN_SPRINT_CODER_PRODUCT_SKILL_DIGEST,
  BUILTIN_SPRINT_CODER_PRODUCT_SKILL_ID,
  SPRINT_CODER_PRODUCT_SPEC_VERSION,
  installBuiltinSprintCoderProductSkill,
} from './sprint-coder-product-skill';
import { SkillStore } from './skill-store';

describe('Sprint Coder product Skill', () => {
  const homes: string[] = [];
  afterEach(async () =>
    Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))),
  );

  it('tracks the desktop version, README, and current diagnostic log contract', async () => {
    expect(SPRINT_CODER_PRODUCT_SPEC_VERSION).toBe(desktopPackage.version);
    expect(BUILTIN_SPRINT_CODER_PRODUCT_SKILL_DIGEST).toMatch(/^[a-f0-9]{64}$/);
    const readme = await readFile(join(process.cwd(), '..', '..', 'README.md'), 'utf8');
    for (const required of [
      '~/.sprintcoder/logs/',
      '%USERPROFILE%\\.sprintcoder\\logs\\',
      'system/system.jsonl',
      'chat/<taskId>.jsonl',
      'team/<teamId>.jsonl',
      '5MB',
      '100 stream',
      'prompt、response、Teamメッセージ本文、環境変数全体は診断ログへ保存しない',
    ])
      expect(BUILTIN_SPRINT_CODER_PRODUCT_SKILL_CONTENT).toContain(required);
    for (const shared of [
      '~/.sprintcoder/logs/',
      '%USERPROFILE%\\.sprintcoder\\logs\\',
      'system/system.jsonl',
      'chat/<taskId>.jsonl',
      'team/<teamId>.jsonl',
      '5MB',
      'prompt、response、Teamメッセージ本文、環境変数全体',
    ]) {
      expect(BUILTIN_SPRINT_CODER_PRODUCT_SKILL_CONTENT).toContain(shared);
      expect(readme).toContain(shared);
    }
  });

  it('installs as a selectable immutable builtin Skill', async () => {
    const home = await mkdtemp(join(tmpdir(), 'sprint-coder-product-skill-'));
    homes.push(home);
    await installBuiltinSprintCoderProductSkill(home);
    const store = await SkillStore.open({ rootPath: join(home, '.sprintcoder', 'skills') });
    const selectable = await store.listSelectable();
    const product = selectable.find(
      ({ skillId }) => skillId === BUILTIN_SPRINT_CODER_PRODUCT_SKILL_ID,
    );
    expect(product).toMatchObject({
      source: 'builtin',
      kind: 'chat',
      digest: BUILTIN_SPRINT_CODER_PRODUCT_SKILL_DIGEST,
      enabled: true,
    });
    const resolved = await store.resolveSelectable(
      'builtin',
      BUILTIN_SPRINT_CODER_PRODUCT_SKILL_ID,
      BUILTIN_SPRINT_CODER_PRODUCT_SKILL_DIGEST,
    );
    expect(await readFile(join(resolved.packagePath, 'SKILL.md'), 'utf8')).toBe(
      BUILTIN_SPRINT_CODER_PRODUCT_SKILL_CONTENT,
    );
  });
});
