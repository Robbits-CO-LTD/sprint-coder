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

Team利用が明示された依頼では、必ずMCPサーバー \`team\` の実ツールを呼び出す。ツール名を文章へ書くだけで利用したことにしない。

1. \`team_hire_worker\` で重複しない役割のWorkerを必要人数だけ採用する。
2. 各Workerへobjective、scope、nonGoals、doneCriteria、targetPaths、constraintsを含む正式taskを割り当てる。
3. \`team_wait_reports\` でacceptedやrunningではなく終端reportを待つ。
4. 実際に届いたreportだけを統合する。存在しないWorker、未着report、行われていない議論を生成しない。
5. blocked、needs_input、failed、canceledをcompletedへ読み替えない。

人数指定を守り、必要以上に採用しない。Team MCP、Skill、digest、context fragmentの検証に失敗した場合は、Teamを使ったように振る舞わずfail closedにする。
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
