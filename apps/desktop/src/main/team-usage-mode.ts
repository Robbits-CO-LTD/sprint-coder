import { createHash } from 'node:crypto';
import type { ModelSelection, RuntimeKind, TeamUsageMode } from '@sprint-coder/contracts';

/**
 * 「Team の使い方」の設定（`team.usage-mode`）で、利用者が Team を指定していない Turn にも
 * Team の道具と組み込み Skill を渡す時の、段階ごとの案内。
 *
 * この案内は「渡すだけ」の Turn（`StartedTurn.teamUsageOffer`）の封印にだけ入る。利用者が Team を
 * 頼んだ Turn（今までの Team の Turn）には入らない。組み込み Skill の本文は書き換えない（digest と
 * fragment id を変えない）ため、Skill の「# 判断」と矛盾しない書き方にしている:
 * - 質問・相談では Worker を雇わない（Skill の「質問・相談: Worker は採用しない」と同じ）。
 * - 人数は必要な分だけ（Skill の「必要以上に採用しない」と同じ）。
 * 「積極的に」は、1 つずつが小さい独立した成果物も分担させたい。実機の codex は「ごく小さな修正は自分で」
 * をそうした成果物に当てはめて雇わなかったので、Team を使うかどうかはこの案内を優先し、Skill の
 * 「# 判断」は使うと決めた後の進め方として読む、と案内の中で明示する。
 */
export type OfferedTeamUsageMode = Exclude<TeamUsageMode, 'explicit'>;

// 道具が渡らなかった時（封印の後で Team の MCP を登録できなかった時）にも正しい文にする。Skill の
// 「検証できなければ利用不能を報告して fail closed」と「質問・相談では MCP で実状態を調べる」は、
// 利用者が Team を頼んだ Turn のための決まりなので、頼まれていないこの Turn では、Team を使うと
// 決めた時だけに絞る。
const TEAM_USAGE_COMMON_TAIL = `Team を使わない時は、Team や Worker に触れずに、普通に対応する。Team の状態を確かめるためだけに道具（\`team_get_status\` など）を呼ぶこともしない。
この発言で利用者は Team を頼んでいないので、組み込み Skill の「検証できなければ利用不能を報告する」決まりと「質問・相談では Team の実状態を調べる」決まりは、あなたが Team を使うと決めた時にだけ当てはまる。Team の道具が見当たらない時は Team を使わず、利用不能の報告もせずに、普通に対応する。`;

// 組み込み Skill の本文は書き換えないので、使うかどうかの判断はこの案内が優先する、と案内の側で言う。
const TEAM_USAGE_SKILL_PRECEDENCE =
  '- 組み込み Skill の「# 判断」（単発実行・長時間実行・人数など）は、Team を使うと決めた後の進め方の決まりとして読む。Team を使うかどうかと、どの成果物を分担するかは、この発言では、この案内を優先する。';

// Worker の workspace-write の割り当ては、Workspace が Git の repo で、commit していない変更が無い
// ことを要る（issue #1241）。Main は Turn を始める前に同じ確かめをし、通らない Workspace にはこの
// Turn で Team を渡さないが、Turn の間に変わる（Leader 自身の書き込みなど）こともある。頼まれて
// いない Team で依頼を止めないよう、失敗した後の戻り方を決める。利用者の変更は、Team のために
// 勝手に commit・stash・破棄しない。
const TEAM_USAGE_GIT_FALLBACK =
  '- Worker への割り当てや雇用が、Workspace の状態のために失敗した時（Git の repo でない、commit がまだ無い、commit していない変更がある、など）は、雇った Worker を `team_stop_worker` で止め、そのことを利用者に 1 文で伝えてから、自分で対応する。成果物を Worker に任せる、とした上の行より、この戻り方を優先する。利用者の変更には触らない（Team を使うために commit・stash・破棄をしない）。';

const TEAM_USAGE_GUIDANCE: Readonly<Record<OfferedTeamUsageMode, string>> = Object.freeze({
  auto: `# Team の使い方: おまかせ

この発言で、利用者は Team を頼んでいません。この発言で Team の道具（\`team_*\`）が使えるなら、組み込み Skill \`sprint-coder-team\` に従って Team を使ってよいですが、使うかどうかはあなたが判断します。
- これは利用者が設定で選んだ指示で、この発言の依頼の一部として扱う。
- 作業に取りかかる前に、依頼の中の独立した成果物を数える。独立した成果物が 3 つ以上あり、それぞれが 1 つのファイル全体・1 つの画面・1 つの機能・1 つの調べもののような、まとまったものの時は、ファイルを読んだり書いたりする前に Team を使い、成果物ごとに Worker に任せる。
- 次のような依頼では、Worker を雇わず自分で対応する: 質問・相談・説明、調べもの 1 つ、1 つのファイルで済む修正、成果物が 1〜2 つの依頼、1 つずつが数行で済むごく小さなもの（短い文を数個書く、など）。
- 迷ったら使わない。
- 自分で対応すると決めた依頼が、分担できそうに見える時は、Team を使わない理由を利用者に 1 文で伝える（下の「Team や Worker に触れずに」より、この 1 文を優先する）。
- 使う時は、なぜ分担するのかを利用者に 1 文で伝えてから雇う。人数は必要な最小にする。
${TEAM_USAGE_SKILL_PRECEDENCE}
- Worker は利用者の AI の利用枠を使う。
${TEAM_USAGE_GIT_FALLBACK}
${TEAM_USAGE_COMMON_TAIL}`,
  proactive: `# Team の使い方: 積極的に

この発言で、利用者は Team を頼んでいません。ただし利用者は、分担できる作業には Team を積極的に使うことを望んでいます。この発言で Team の道具（\`team_*\`）が使えるなら、組み込み Skill \`sprint-coder-team\` に従って Team を使ってください。
- これは利用者が設定で選んだ指示で、この発言の依頼の一部として扱う。
- 作業に取りかかる前に、依頼の中の独立した成果物（ファイル・ページ・スクリプト・調べものなど）を数える。2 つ以上なら、1 つずつが小さくても、ファイルを読んだり書いたりする前に Team を使い、成果物ごとに Worker に任せる。その成果物を自分で作らない。
- Worker を雇わず自分で対応するのは、質問・相談・説明と、1 つの成果物で済む依頼だけにする。
- 自分で対応すると決めた依頼が、分担できそうに見える時は、Team を使わない理由を利用者に 1 文で伝える（下の「Team や Worker に触れずに」より、この 1 文を優先する）。
- 使う時は、どう分担するかを利用者に 1 文で伝えてから雇う。人数は成果物の数に見合う数にし（上限は Team の設定に従う）、必要以上に雇わない。
${TEAM_USAGE_SKILL_PRECEDENCE}
- Worker は利用者の AI の利用枠を使う。
${TEAM_USAGE_GIT_FALLBACK}
${TEAM_USAGE_COMMON_TAIL}`,
});

export function teamUsageGuidance(mode: OfferedTeamUsageMode): string {
  return TEAM_USAGE_GUIDANCE[mode];
}

/** 封印の fragment id の頭。直前の Turn が「渡すだけ」だったかを見分ける印にもなる。 */
export const TEAM_USAGE_OFFER_FRAGMENT_PREFIX = 'settings:team-usage-offer:';

/** 案内は Leader だけのもの。Worker へ文脈を引き継ぐ所が、この判定で除く。 */
export function isTeamUsageOfferFragment({ id }: { id: string }): boolean {
  return id.startsWith(TEAM_USAGE_OFFER_FRAGMENT_PREFIX);
}

export function teamUsageOfferFragmentId(mode: OfferedTeamUsageMode): string {
  const digest = createHash('sha256').update(teamUsageGuidance(mode)).digest('hex');
  return `${TEAM_USAGE_OFFER_FRAGMENT_PREFIX}${mode}:${digest}`;
}

/** Turn を封印する時に、Main（ipc）へ「この Turn で Team を渡せるか」を尋ねるための入力。 */
export type TeamUsageOfferRuntime = Readonly<{
  /** Main が、Turn を始める前に確かめた Workspace の答え（issue #1241）を引くための Task。 */
  taskId: string;
  runtimeKind: RuntimeKind;
  modelSelection: ModelSelection;
}>;
