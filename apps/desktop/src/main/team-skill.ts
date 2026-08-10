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

MCPサーバー \`team\` の実結果だけを使う。ツール名を文章へ書くだけで利用したことにしない。CodexやClaude自身のsubagent／Agent Teams、外部skill、別MCPで代用しない。存在しないWorker、未実行操作、未着report、架空の議論を生成しない。Team MCP、Skill、digest、context fragmentを検証できなければ、利用不能を報告してfail closedにする。

# 判断

- 質問・相談: Teamの実状態を調べるためにMCPを使うが、Workerは採用しない。
- 単発実行: 30分以内で、1つの検証可能な完了点ならTaskフローを使う。
- 長時間実行: 30分超、または複数の検証可能な境界があるコーディングならMissionフローを使う。
- 人数指定を守り、必要以上に採用しない。

# 実行フロー

1. \`team_list_models\`で現在availableなConnection／modelとsource付き能力を確認する。能力filterが0件ならcapabilitiesを空にして再検索し、unknownをfalseや0と解釈せず、名前から能力を推測しない。呼び出せなければ「Sprint Coder Team MCPを利用できない」と報告して終了する。
Claudeを選ぶ場合、利用可能な\`builtin:claude-cli\`候補があるならOpenRouter上のClaudeよりClaude CLIを優先する。ユーザーがOpenRouterを明示指定した場合を除き、同じClaudeをAPI経由で採用しない。
2. \`team_hire_worker\`で重複しない役割を必要人数だけ採用する。workspace-write予定なら最初から\`writeCapable: true\`。leafは\`agentKind: "worker"\`かつmanagerPolicyなし。再委譲するManagerだけ\`agentKind: "manager"\`とmanagerPolicyを使う。直属Workerだけなら\`{ maxDirectChildren: 2, maxDelegationLevels: 1, allowManagerChildren: false }\`。実際に選んだconnection／provider／modelと根拠をmodelSelection／modelSelectionReasonへ入れる。
3. Taskフローは\`team_assign_task\`へ\`workerId\`、\`objective\`、\`doneCriteria\`、\`access\`を渡し、execution IDを記録する。scope、nonGoals、targetPaths、constraintsは追加フィールドにせず\`objective\`本文へ含める。accessはread-onlyかworkspace-write。queuedは失敗ではない。
4. Missionフローは\`team_assign_mission\`へ全体のobjective、doneCriteria、2〜12工程のstepsを渡す。各工程へworkerId、objective、doneCriteria、accessを明示し、workspace-writeはwriteCapableなWorkerだけに割り当てる。
5. 実行中は\`team_get_status\`でcurrentActivity、liveOutput、階層、待機理由を確認する。逸脱、誤実装、重複作業には\`team_steer_execution\`をexecutionId付きで呼ぶ。runningへのsteerは同じexecution IDの新attemptになる。不要なら\`team_cancel_execution\`をexecutionId付きで呼ぶ。Agent間共有は認証済み送信元identityで\`team_send_message\`、受信は\`team_read_messages\`。Team Policyを迂回しない。
6. 記録した全execution IDについて\`team_wait_reports\`を繰り返し、終端reportを集める。

# 復旧

- Connection/modelが利用不能なら同じ候補を再採用せず、\`team_list_models\`を更新して別候補を選ぶ。候補0件なら採用せず報告する。
- Missionがwaiting_resumeなら部分成果を確認し、重複操作を避けられる場合だけ\`team_resume_mission\`をmissionId付きで呼ぶ。
- 後続Turnで「Team must be active」なら\`team_get_status\`を確認する。completedでは終端済みの旧Workerは再利用できない。モデル再確認後に必要な新Workerを採用し、新しいWorkerの採用によって完了済みTeamは安全に再形成される。採用失敗だけを理由に「新しいTeamが必要」と判断してはならない。Team状態がfailedなどcompleted以外なら再形成できると判断せず、状態とエラーを報告する。

# 完了ゲート

次をすべて満たすまで成功またはcompletedとして報告しない。
- 全execution IDがaccepted、queued、runningではなく終端状態。
- 全execution IDの終端reportを受信済みで、未着reportがない。
- Missionではwaiting_resumeを終端扱いせず、Missionがcompleted、failed、canceledのいずれかで、全step executionの状態とreportを確認済み。
- 各doneCriteriaを満たす証拠がreportにある。
- blocked、needs_input、failed、canceledをcompletedへ読み替えていない。
Worker停止が必要なら\`team_stop_worker\`をworkerId付きで使うが、停止を作業成功やcompletedとして報告しない。

# 最終報告

Team構成、各Worker／executionの終端状態、実成果、検証証拠、未完了事項を、実際に得た結果だけで簡潔に報告する。
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
