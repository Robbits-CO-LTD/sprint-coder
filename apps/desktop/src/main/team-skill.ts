import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { ContextFragment, PreparedContext } from './context-ledger';
import { estimateTokens } from './context-ledger';
import { SkillStore } from './skill-store';

export const BUILTIN_TEAM_SKILL_ID = 'sprint-coder-team';
export const BUILTIN_TEAM_SKILL_CONTENT = `---
name: sprint-coder-team
description: Sprint Coderで実在するWorkerを安全に編成・監視する
---

# Sprint Coder Team

MCPサーバー \`team\` は通常のChatでも利用できる。まず、ユーザーがTeam、複数人、人数指定、並列作業を求めているか、または依頼が明らかに分割実行の恩恵を受けるかを判断する。該当しない通常の依頼ではTeamツールを呼び出さない。Teamが必要だと判断した場合だけ、以下の実ツールを呼び出す。ツール名を文章へ書くだけで利用したことにしない。

ここでいうTeamはSprint CoderのTeam MCPだけを指す。provider内蔵のAgent、Task、subagent、agent teams、外部CLI、ローカルの同名Skillを代替として使ってはならない。Team MCPが利用できない場合は別の仕組みへfallbackせず、利用不能としてfail closedにする。

1. 最初に \`team_get_status\` を呼び、既存Workerとtaskの状態を確認する。
2. 再利用できるWorkerは再利用し、不足分だけ \`team_hire_worker\` で採用する。役割を重複させない。
3. 各Workerへ \`team_assign_task\` で正式taskを割り当てる。この呼び出しは永続受付後すぐ返るため、完了を待たず全Workerへの割り当てを先に済ませる。渡せる引数は \`workerId\`、\`objective\`、\`doneCriteria\` だけである。scope、non-goals、target paths、constraintsは追加フィールドにせず、objective本文へ明記する。
4. 全Workerへの割り当て後に \`team_wait_reports\` を呼ぶ。この呼び出しはWorkerの終端reportがmailboxへ届くとイベント駆動で返る。acceptedやrunningを完了扱いしない。未完了Workerが残る間は、全reportを受信するまで再度呼ぶ。
5. 実際に届いたreportだけを統合する。存在しないWorker、未着report、行われていない議論を生成しない。
6. blocked、needs_input、failed、canceledをcompletedへ読み替えない。
7. Workerが対象外の作業を続けている、または役割ごと不要になった場合は \`team_stop_worker\` で停止する。停止したWorkerのtaskは未完了のまま扱い、completedとして報告しない。

固定の人数上限はない。ただし依頼に必要な人数だけを採用し、実行環境の同時実行枠や予算を尊重する。Team MCP、Skill、digest、context fragmentの検証に失敗した場合は、Teamを使ったように振る舞わずfail closedにする。
`;
export const BUILTIN_TEAM_SKILL_DIGEST = createHash('sha256')
  .update(BUILTIN_TEAM_SKILL_CONTENT)
  .digest('hex');
export const BUILTIN_TEAM_SKILL_FRAGMENT_ID = `builtin-skill:${BUILTIN_TEAM_SKILL_ID}:${BUILTIN_TEAM_SKILL_DIGEST}`;

export type TeamSkillResolutionAudit = Readonly<{
  requestedCapability: 'team-orchestration';
  selectedSkillId: 'builtin:sprint-coder-team';
  rejectedCandidates: readonly string[];
  digest: string;
  reason: 'reserved-capability';
}>;

export const BUILTIN_TEAM_SKILL_AUDIT: TeamSkillResolutionAudit = Object.freeze({
  requestedCapability: 'team-orchestration',
  selectedSkillId: 'builtin:sprint-coder-team',
  rejectedCandidates: Object.freeze([]),
  digest: BUILTIN_TEAM_SKILL_DIGEST,
  reason: 'reserved-capability',
});

export async function installBuiltinTeamSkill(homePath: string): Promise<void> {
  const store = await SkillStore.open({ rootPath: join(homePath, '.sprintcoder', 'skills') });
  await store.installBuiltin(
    BUILTIN_TEAM_SKILL_ID,
    BUILTIN_TEAM_SKILL_CONTENT,
    BUILTIN_TEAM_SKILL_DIGEST,
  );
}

export function attachBuiltinTeamSkill(
  prepared: PreparedContext,
  taskId: string,
  enabled: boolean,
): PreparedContext {
  if (!enabled) return prepared;
  const fragment: ContextFragment = {
    id: BUILTIN_TEAM_SKILL_FRAGMENT_ID,
    taskId,
    source: 'system',
    trust: 'system',
    tokenEstimate: estimateTokens(BUILTIN_TEAM_SKILL_CONTENT),
    content: BUILTIN_TEAM_SKILL_CONTENT,
    createdAt: new Date().toISOString(),
    messageId: null,
  };
  return { ...prepared, fragments: [...prepared.fragments, fragment] };
}

export function verifyBuiltinTeamSkillAcceptance(
  expected: boolean,
  acceptedFragmentIds: readonly string[],
): boolean {
  return expected === acceptedFragmentIds.includes(BUILTIN_TEAM_SKILL_FRAGMENT_ID);
}
