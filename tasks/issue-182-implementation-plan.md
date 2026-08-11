# Issue #182 Phase A implementation plan

## Scope ledger

- User-visible outcome: Project Memory が AI 作成でも Codex/Claude Turn が起動し、拒否/無応答は有限時間で失敗し、起動待ちとモデル実行中が区別される。
- Required changes: (A) 相関可能な invalid start を安全な列挙理由で拒否、(B) Main の拒否/timeout を exactly-once で failure diagnostic に接続、(C) renderer の transient starting 表示。
- Explicit non-goals: #181 の authority matrix 再実装、DB schema、adapter first-event timeout、広範な UI/CSS、#186。
- Cheapest proof: 各 Slice の pure/unit test、境界 checkpoint で Runtime Host/Main integration、最終 checkpoint で desktop test/type/lint/package を一度。

## Frozen contract

- `instruction=user`, `reference=none`, `memory=user|none` を維持し、それ以外は拒否する。
- 相関可能な `start` / `commit_images` 拒否だけを Main に返し、相関不能入力は応答しない。
- 拒否情報は列挙 reason と bounded ID/kind/authority のみ。prompt、Memory content、token、env、credential、絶対 path は含めない。
- reject/timeout/late/duplicate の全経路は Turn failure を最大1回だけ通知する。
- persisted TurnStage / DB schema は変更せず、transient starting 表示を first runtime stage まで優先する。

## Threat model

- Actor: Main/Runtime 間 envelope を破損させるバグ、または context の authority を偽装する入力。
- Assets: prompt、Memory content、token、環境変数、credential、Workspace の絶対 path、Turn の可用性。
- Trust boundary: Main process -> Runtime Host utility process -> provider CLI、および Main -> renderer event projection。
- Abuse/failure cases: forged authority、tampered digest、invalid correlation、Host no-response、late/duplicate reply、診断への secret 混入。
- Fail closed: invalid authority/digest は adapter を開始せず、相関可能なら安全な拒否、相関不能なら無応答、Main timeout は常に残す。

## Public/data boundary

- Runtime protocol に additive な安全な reject metadata を追加できるが、既存 start/error/started 契約と authority matrix は維持する。
- RuntimeFailureDiagnostic の永続化 schema は既存 v1 と互換な追加項目に限定するか、既存 protocol_error fallback を再利用する。
- persisted TurnStage、DB migration、provider adapter contract は変更しない。

## Seven-step execution plan

1. 修正前の failing tests で invalid start の silent drop、timeout diagnostic 欠落、pre-runtime UI 誤表示を再現し、RCA A/B/C/D を確定する。
2. Slice A: boolean validator を維持したまま safe validation/reject result を追加し、authority/digest/correlation を privacy canary 付きで検証する。
3. Slice A: Runtime Host ingress から相関可能な invalid start/commit を bounded reason で即時 error 応答し、相関不能入力は fail closed にする。
4. Slice B: Main で reject と既存15秒timeoutを同じ exactly-once failure reconciliation に接続し、late/duplicate/cancel watchdog の二重通知を防ぐ。
5. Slice B: diagnostic persistence と safe logging を focused integration test で検証し、prompt/Memory/token/env/credential/絶対 path canary の非出力を証明する。
6. Slice C: transient `runtimeStarting` を turn.accepted から最初の runtime stage まで表示し、RunCard を「Runtime起動待ち」から「理解中」へ遷移させる。
7. Codex/Claude、assistant/user Memory、instruction/reference、forged authority、reject/timeout/late/duplicate、queued->starting->understanding を検証し、final diff へ Tier A fortress 5レンズと通常5レーンレビューを実施する。

## Presentation

- RunCard title: `起動中`。
- Stage detail: `Runtime起動待ち`。
- Runtime 受理後の既存文言: `思考中` / `ユーザーの依頼を理解中`。
