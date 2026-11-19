import { describe, expect, it } from 'vitest';
import { parseGoalConclusion, goalDecision } from './goal-outcome';
const id = 'turn-A';
const progress = {
  status: 'continue',
  summary: '初稿を保存した',
  next: '参照元を確認する',
} as const;
function reply(report: object, owner = id) {
  return '回答\n\n```sprint-goal\n' + JSON.stringify({ turnId: owner, ...report }) + '\n```';
}
describe('Goal conclusion', () => {
  it('requires a scoped, final, structured report and evidence', () => {
    const achieved = { status: 'achieved', summary: '検証コードは314と一致した' };
    expect(parseGoalConclusion(reply(achieved), id)).toEqual({ report: achieved, text: '回答' });
    for (const text of [
      '確認コードを教えてください',
      reply(achieved, 'turn-B'),
      reply(achieved) + '\n引用例です',
      reply({ ...achieved, summary: '  ' }),
      reply({ status: 'continue', summary: '作成した' }),
    ])
      expect(parseGoalConclusion(text, id)).toBeNull();
    expect(goalDecision(null, null, 0).status).toBe('blocked');
  });
  it('accepts a quoted opening fence inside the final JSON report', () => {
    const quoted = {
      ...progress,
      summary: '確認: ```sprint-goal',
      next: '説明に ```sprint-goal を加える',
    };
    for (const newline of ['\n', '\r\n']) {
      const answer = reply(quoted).replaceAll('\n', newline);
      expect(parseGoalConclusion(answer, id)).toEqual({ report: quoted, text: '回答' });
      expect(parseGoalConclusion(answer, 'another-turn')).toBeNull();
    }
  });
  it('continues progress but stops a repeated step or an exhausted unattended run', () => {
    expect(goalDecision(progress, null, 0)).toEqual(progress);
    expect(goalDecision(progress, progress, 1).status).toBe('blocked');
    expect(goalDecision(progress, null, 12).status).toBe('blocked');
  });
});
