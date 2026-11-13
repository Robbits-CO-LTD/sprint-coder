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
 */
export type OfferedTeamUsageMode = Exclude<TeamUsageMode, 'explicit'>;

const TEAM_USAGE_GUIDANCE: Readonly<Record<OfferedTeamUsageMode, string>> = Object.freeze({
  auto: `# Team の使い方: おまかせ

この発言で、利用者は Team を指定していません。Team の道具と組み込み Skill \`sprint-coder-team\` は使える状態ですが、使うかどうかはあなたが判断します。
- 質問・相談・調べもの・説明や、1 つのファイルで済む小さな修正などの些細な依頼では、Worker を雇わず自分で対応する。
- 独立して進められる作業が複数あり、分担した方が明らかに速い、または確実な時だけ Team を使う。
- 迷ったら使わない。
- 使う時は、なぜ分担するのかを利用者に 1 文で伝えてから雇う。人数は必要な最小にする。
- Worker は利用者の AI の利用枠を使う。
Team を使わない時は、Team や Worker に触れずに、普通に対応する。`,
  proactive: `# Team の使い方: 積極的に

この発言で、利用者は Team を指定していません。Team の道具と組み込み Skill \`sprint-coder-team\` は使える状態で、利用者は、分担できる作業には Team を積極的に使うことを望んでいます。
- 複数のファイルや領域にまたがる実装、調べものと実装の並行、実装と確認の分担など、分担できる作業は Team を使う。
- 質問・相談・説明や、ごく小さな修正は、Worker を雇わず自分で対応する。
- 使う時は、どう分担するかを利用者に 1 文で伝えてから雇う。人数は作業に見合う数にし、必要以上に雇わない。
- Worker は利用者の AI の利用枠を使う。
Team を使わない時は、Team や Worker に触れずに、普通に対応する。`,
});

export function teamUsageGuidance(mode: OfferedTeamUsageMode): string {
  return TEAM_USAGE_GUIDANCE[mode];
}

/** 封印の fragment id の頭。直前の Turn が「渡すだけ」だったかを見分ける印にもなる。 */
export const TEAM_USAGE_OFFER_FRAGMENT_PREFIX = 'settings:team-usage-offer:';

export function teamUsageOfferFragmentId(mode: OfferedTeamUsageMode): string {
  const digest = createHash('sha256').update(teamUsageGuidance(mode)).digest('hex');
  return `${TEAM_USAGE_OFFER_FRAGMENT_PREFIX}${mode}:${digest}`;
}

/** Turn を封印する時に、Main（ipc）へ「この Turn で Team を渡せるか」を尋ねるための入力。 */
export type TeamUsageOfferRuntime = Readonly<{
  runtimeKind: RuntimeKind;
  modelSelection: ModelSelection;
}>;
