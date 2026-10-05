# Issue #500 実装ミッション（2026-09-29）

## 目的と受入条件

AI が実行中の一般アプリとウィンドウを native/Main の検証済み identity から一覧し、初回のアプリ許可後に対象へ操作できるようにする。macOS と Windows で、禁止クラスの除外、identity 変更時の再確認、既存の Stop・フォーカス・secure input・OS dialog・観測鮮度の拒否境界を保つ。旧 picker の終了は ADR v2 §10 の V1 終了条件がそろってから判断する。

## 現在地と依存

- S1〜S3b は merge 済み。S4 macOS、S5 Windows、S6 UWP、S7 ブラウザ、S8 旧 picker 撤去、S9 実機受入が残る。
- S4 の設計は ADR v2 に記録し、Grok Build（Grok 4.7）との相談と独立した設計レビューを反映した。
- N2b-2までmainへ反映済み。現行native classifier v1は承認クラスを発行せず、Mainはsingle_use_approvalを入力なしpauseとして扱う。次はADR S4-4の承認契約レビューと、N2b-3のprivate native policy型。
- #387 と親 #333 の受入条件、署名済み成果物、macOS/Windows 実機を最終照合する。

## 許可範囲と非対象

許可範囲は `apps/desktop/computer-use-native/**`、`apps/desktop/src/main/computer-use-*.ts`、`apps/desktop/src/main/ipc.ts`、`packages/contracts/src/index.ts`、Computer Use UI/フック、build/manifest/handshake、直接関連テスト・文書・CI。V2 新経路を開く PR には native/Main の deny と実行トリガ interlock を同時に含める。セッション内の画面内容を外側の会話へ返す T13 の新設計、S1〜S3b の再実装、未検証 UWP の許可は非対象。

## 原因・リスク・復旧

V1 は native allow-list と人が選ぶ picker を前提にしているため、AI が一般アプリを列挙して開始できない。V2 は任意のアプリと危険操作を対象へ広げるため、表示名・モデル出力・Renderer を権限根拠にせず、実行中プロセスの identity、面、操作を入力直前まで再検証する。分類不能・handshake 不一致・grant 不一致では拒否する。S4/S5 では V2 flag 既定 OFF、V1 経路を残す。失敗時は V2 を有効にせず、旧経路を使用する。

## 検証と終了地点

各スライスで関連する型・契約・native deny の正負・Main の grant/token/epoch・UI の拒否テストを実施し、独立レビューと最新 head CI を通す。高コスト E2E の前に同一ソース・成果物・実行プロセスを結ぶ preflight を確認する。macOS/Windows の実機で受入 journey を直接操作し、PASS/FAIL/SKIP を記録する。未実施は PASS とせず、#500 を OPEN に保つ。

添付: 0 件中 0 件を確認。Issue 本文・コメントと公開計画を live で確認した。

## 今回のnative slice（2026-10-05）

- base: main 1f4b20ee、branch: codex/issue-500-approval-ticket。ユーザーが承認仕様の設計とMac実装の進行を指示。
- 成果: native所有のpending intentとready execution ticketを分離し、束縛・期限・消費・失効をportable C++型で検証する。UIへの接続と新しいV2入力の公開はN2b-4以降の独立した境界。
- 変更: ADR S4-4、本記録、private approval ticket header、既存compiled protocol harness、直接source-contractテスト。ordinary ticket、Main/native public API、Windows host、controller、UI、flagは変更しない。
- I1（認可5、仕様解釈3、エッジケース2、直接test不足3=13）。設計は認可境界のため独立したfortress-review（Tier A、型3+認可5+新しい承認契約4=12）を先行する。影響、test、要件、障害/復旧、data/securityの5観点を一つの担当が確認する。
- 受入: tokenの再利用・ordinaryとの交換、全bindingの変更、generation0、旧ownerの失効、時計逆行/期限丁度/overflow、承認後の新しいrequest/観測/世代、操作単位type、cancel/失効がfail closed。ready発行前も発行後も失敗でslotを消費する。
- 検証: compiled harness RED/GREEN、clang C++20 strict warning、ASan/UBSan、既存native/host/controller型と直接test、macOS addon source build、両OS CIと独立最終review。UI/実機/Windows GUI/署名受入は未実施とする。
- rollback: このsliceをrevertすればN2b-2のclosed pauseへ戻る。DB・OS・grantの変更はない。
- attachments_viewed: 0/0 (NO_ATTACHMENTS)。GitHubにopen PRなし、既存dirty/user作業を保持。

設計review: independent `approval_plan_review`、5/5 PASS、CRITICAL/HIGH/MEDIUM/LOW 0、Go。plan binding: base=head=1f4b20ee135d26150aa25037c03c2c6c747de159、normalization=codex-review-v1、ADR S4-4節SHA256=a3a339a81edab417fe0c3ee93b8a1d6292399d4f159ce69a5c489552442e0849。Mainが実コードのrevision/generation更新とclosed pauseを再照合。Human Gateは指摘なし、許可済み実装へ進む。

検証: 既存compiled harnessは変更前PASS。新型未実装のREDと、非対応stageへの消費がpendingを消すREDを確認し、stage/generationを持たない旧callbackは現slotを壊さず拒否する最小修正でGREEN。最終clang C++20 -Wall/-Wextra/-Werror/-pedanticおよびASan/UBSanのcompiled harness PASS。既存Main/native/Controller/asyncの4suite 235 PASS、desktop typecheck、Mac addon source build PASS。CPP警告検査はcompiler、TS lintは既存sourceを検査する。型はharnessにのみincludeし、Main-facing経路や実機入力は変更していない。
