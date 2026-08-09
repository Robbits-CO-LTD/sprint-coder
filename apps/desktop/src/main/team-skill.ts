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
CodexやClaude自身のsubagent／Agent Teams機能、外部skill、別MCPを代替として使ってはいけない。
\`team_list_models\`が実際に呼び出せない場合は、代替実行へ進まず「Sprint Coder Team MCPを利用できない」と報告して終了する。
Teamに関する質問・相談ではSkillとMCPを使って正確に回答するが、Workerを採用する必要はない。「雇って」「編集して」「実行して」などの実行依頼だけ、指定されたWorkerの採用と終端reportを完了条件にする。
後続Turnの実行依頼で旧Workerへの割り当てが「Team must be active」になった場合は、team_get_statusでTeam状態を確認する。状態がcompletedなら、そこで終了しない。終端済みの旧Workerは再利用できないため、team_list_modelsの後、今回必要な役割の新しいWorkerをteam_hire_workerで必要人数だけ採用して続行する。新しいWorkerの採用によって完了済みTeamは安全に再形成される。採用が失敗した場合は具体的なエラーを報告し、入力・Role順・モデル選択などを修正できるなら同じTeamで再試行する。採用失敗だけを理由に「新しいTeamが必要」と判断してはならない。Team状態がfailedなどcompleted以外なら再形成できると判断せず、実際の状態とエラーを報告する。

1. \`team_list_models\` で利用可能なConnection／modelとsource付き能力を確認する。まず作業に必要な能力でfilterする。0件なら、CLI modelのunknown能力がfilterで除外された可能性があるため、capabilitiesを空にして再検索し、source付きのunknownとして候補を確認する。unknownを0やfalseと解釈せず、model名やProvider名から能力を推測しない。
2. \`team_hire_worker\` で重複しない役割のAgentを必要人数だけ採用する。workspace-writeを割り当てる予定のAgentは、最初の採用時から\`writeCapable: true\`を必ず指定する。leaf Workerは\`agentKind: "worker"\`を指定し、\`managerPolicy\`を付けない。再委譲するManagerは\`agentKind: "manager"\`を指定し、\`managerPolicy.maxDelegationLevels\`へそのManagerの直下から許す追加段数を指定する。たとえばSubLeaderに直属Workerだけを雇わせる場合は\`{ maxDirectChildren: 2, maxDelegationLevels: 1, allowManagerChildren: false }\`とする。各作業に選んだconnection ID、provider ID、model IDを\`modelSelection\`へ、その選定根拠を\`modelSelectionReason\`へ必ず明示する。
採用がConnection/modelの利用不能で失敗したら、同じ候補を再採用せず\`team_list_models\`を再実行し、現在availableな別ConnectionのAIを選ぶ。availableな候補がなければWorkerを追加せず、その事実を報告する。
3. 30分以内で完了する単発作業は\`team_assign_task\`へ\`workerId\`、\`objective\`、\`doneCriteria\`、\`access\`を渡す。accessは必ずread-onlyまたはworkspace-writeを明示する。scope、nonGoals、targetPaths、constraintsなどは追加フィールドにせず\`objective\`本文へ含め、返されたexecution IDを記録する。queuedは失敗ではない。
4. 30分を超える、または複数の検証可能な境界があるコーディングは\`team_assign_mission\`で2〜12工程に分割する。各工程へ担当workerId、objective、doneCriteria、read-onlyまたはworkspace-writeのaccessを明示する。workspace-writeは書き込み可能Workerだけに割り当てる。
5. Missionがwaiting_resumeになった場合は状態と部分成果を確認し、重複操作を避けられると判断したときだけ\`team_resume_mission\`を呼ぶ。
6. 実行中は \`team_get_status\` を繰り返してcurrentActivity、liveOutput、階層、待機理由を監視する。scope逸脱、誤った実装、重複作業を見つけた時点で、完了を待たず \`team_steer_execution\` を呼ぶ。
7. \`team_wait_reports\` を繰り返し、記録した全execution IDについてaccepted、queued、runningではなく終端reportが届くまで待つ。
8. 全Workerの終端reportを確認してから、実際に届いたreportだけを統合する。存在しないWorker、未着report、行われていない議論を生成しない。
9. blocked、needs_input、failed、canceledをcompletedへ読み替えない。

待機中または実行中の指示を直す場合は \`team_steer_execution\`、不要になった作業を止める場合は
\`team_cancel_execution\` をexecution ID付きで使う。実行中のsteerは同じexecutionの新attemptとして再開される。
Worker自体を終了する場合は\`team_stop_worker\`を\`workerId\`付きで使う。停止は作業成功を意味しないため、未着reportや失敗をcompletedとして報告しない。

Agent同士で情報共有が必要な場合は、送信元Agentの認証済みidentityで
\`team_send_message\`を使い、受信側は\`team_read_messages\`で監査済みmessageを読む。
Team PolicyがWorker間通信を禁止している場合は迂回しない。

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
