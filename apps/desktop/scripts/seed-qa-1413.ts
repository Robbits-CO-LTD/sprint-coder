import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SqlitePersistenceClient } from '../src/main/persistence';
import { SkillSettingsService } from '../src/main/skill-settings-service';

const appRoot = resolve(process.cwd());
const base = join(appRoot, 'qa-1413-local');
// Deliberately refuse to populate an existing profile.
await mkdir(base);
const profile = join(base, 'profile');
const skillHome = join(base, 'skill-home');
await Promise.all([mkdir(profile), mkdir(skillHome)]);
const skillSettings = new SkillSettingsService({ homePath: skillHome });
const makeDraft = (skillId: string, title: string) =>
  skillSettings.createDraft({
    kind: 'chat',
    skillId,
    files: [
      {
        path: 'SKILL.md',
        content:
          '---\nname: ' +
          title +
          '\ndescription: Synthetic QA fixture\n---\n\nWrite a short summary.\n',
      },
    ],
  });
const conflict = await makeDraft('qa-duplicate', 'QA 同名の下書き');
const toInstall = await makeDraft('qa-duplicate', 'QA 導入済みSkill');
await skillSettings.installDraft(toInstall.id, toInstall.digest);
const missing = await makeDraft('qa-missing', 'QA 保存先にない下書き');
await skillSettings.discardDraft(missing.id);
const drafts = await skillSettings.listDrafts();
if (drafts.length !== 1 || drafts[0]?.id !== conflict.id)
  throw new Error('Unexpected Skill Draft fixture state');

const db = new SqlitePersistenceClient(join(profile, 'sprint-coder.sqlite3'));
try {
  const task = db.createTask('#1413 下書きカードの検証');
  const turn = db.startTurn(task.id, '合成サンプルで、下書きカードの失敗理由を確認します。');
  db.recordSkillDraft(task.id, turn.turnId, conflict);
  db.recordSkillDraft(task.id, turn.turnId, missing);
  db.cancelTurnAndFinishGoal(
    task.id,
    turn.turnId,
    '上の下書きは同名のSkillが導入済みです。下の下書きは保存先から取り除いてあります。',
  );
  if (db.snapshot(task.id).activeTurn !== null || db.listRecentApprovals(task.id).length !== 0)
    throw new Error('Unexpected fixture Turn or approval state');
  const fixture = { taskId: task.id, turnId: turn.turnId, conflict, missing };
  const json = JSON.stringify(fixture, null, 2) + '\n';
  await writeFile(join(base, 'session.json'), json, { flag: 'wx' });
  await writeFile(join(appRoot, 'src/renderer/qa-1413-generated.json'), json);
  console.log('Prepared QA #1413 using only synthetic data.');
} finally {
  db.close();
}
