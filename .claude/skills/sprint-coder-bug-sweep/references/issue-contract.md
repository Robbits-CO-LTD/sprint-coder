# Phase 2 / 4 — Issue 契約

[bug-investigation-to-issue の GitHub Issue 契約](../../../../.agents/skills/bug-investigation-to-issue/references/github-issue-contract.md) とグローバル skill `issue-naming`（`~/.claude/skills/issue-naming/SKILL.md`）を、この sweep 向けに縮約したもの。食い違えば元の契約が優先。

## 起票適格性

次を **全部** 満たすものだけ起票する。

- 独立した 2 session で同じ正規化症状が出た（E2E: spec 単独再実行 / 実 AI: fresh profile で同 case）
- 期待値の出典がある（spec の expect、設計書 §、受入条件、明白な安全契約: workspace 外へ書かない・承認なしに実行しない・データを失わない）
- 環境起因（native 未 build、dev server 不一致、CLI 未認証、quota）と driver 起因（Computer Use の `unsupported`、stale window）を除外した
- open / closed Issue と open PR の **意味的** 重複を自分で読んで確認した
- redact 済みのタイトルと本文だけで第三者が再現できる
- manifest の `filing_mode=live`（`new-run.sh --filing live --authorized-by "<依頼文の該当語>"` で作った run だけ。`file-issue.sh` は manifest を読み、`report-only` なら `--dry-run` 以外を拒否する）

severity は並び順に使うだけで、証拠不足を補わない。

## タイトル

- `[bug] ` または（spec が古いだけなら）`[test] ` で始め、日本語で **症状** を書く。25〜70 文字、1 主題。
- 識別子（関数名・定数名・testid）を本体に書かない。必要なら末尾の全角括弧に `（spec: golden-path-2）` のように 1 つだけ。
- Issue / PR 番号、run ID、nonce、個人名、path を入れない。句点なし。
- 効用・症状形: 「〜が表示されない」「〜しても反映されない」「〜が実行されてしまう」。

例:
- `[bug] Claude Code で承認したコマンドの結果がコマンドカードに表示されない`
- `[bug] 停止ボタンを押しても Codex の Turn が中止にならず思考中のまま残る`
- `[test] Composer の送信ボタンの表示名変更に golden path の spec が追従していない（spec: golden-path-3）`

## 本文

```markdown
<!-- bug-sweep:fingerprint=<sha256> -->

## 症状と影響

## 再現手順

（E2E 由来: 実行コマンド、spec:行 › タイトル、独立再現の回数。実 AI 由来: lane、Access 設定、case ID、prompt の要旨 1 行、承認操作）

## 期待した結果と根拠

（expect の内容 / 設計書 § / 安全契約）

## 実際の結果

（Expected / Received、Run Card の状態、カードの有無、`verify-lane.sh` の要約: relative path・byte・exit code・marker の有無）

## 独立再現

（session 1 / session 2 の条件と結果）

## 除外した別の説明

（環境・driver・provider quota・spec 陳腐化のどれをどう除外したか）

## 環境

- Repository: `Robbits-CO-LTD/sprint-coder`
- Source: `<full SHA>`
- macOS / Electron / Node / CLI version（秘密を含まない範囲）
- Runtime: mock | Claude Code CLI (<model>) | Codex CLI (<model>)

## 完了条件

- [ ] 同じ手順・同じ観測点で症状が消える
- [ ] 原因に隣接する回帰テスト（vitest または E2E spec）が通る
- [ ] <この Finding 固有の観測可能な条件>

## Bug Sweep context

- 由来: Phase 1 (E2E) | Phase 3 (real AI, lane=<lane>)
- 調査日: <YYYY-MM-DD>
- Evidence: <run ディレクトリ内の相対名。絶対 path は書かない>
```

fingerprint は `sha256(repo | phase | spec or case | 安定した要素名 | 失敗クラス | 正規化した期待差分)`。timestamp、nonce、run ID、port、path、件数を含めない。`triage-e2e.mjs` が E2E 分を出す。実 AI 分は `printf '%s' 'Robbits-CO-LTD/sprint-coder|phase3|RA-05|command-card|wrong-value|exit code missing' | shasum -a 256` で作る。

## label

- `bug` だけを付ける（`[test]` も `bug`）。`patrol-finding`、`planned`、`implementing`、`implemented`、priority 系を付けない。label を新規作成しない。

## 重複確認

1. `gh issue list --state all --search "bug-sweep:fingerprint=<fp>"`（marker 一致は collision 候補であって重複確定ではない）
2. `gh issue list --state all --limit 100 --search "<症状語> <画面名>"` を 2〜3 パターン
3. `gh pr list --state open --search "<症状語>"`
4. 症状・原因経路・影響・完了条件を読んで判断する。
   - `duplicate_open` → 既存 URL を報告、起票しない
   - `fix_in_progress` → PR URL を報告、起票しない
   - `regression_hold` → closed Issue と同原因。reopen もコメントもしない。報告に載せる
   - inventory が取れない → `dedup_incomplete`、以後の起票を止める

## 作成と read-back

```bash
"$S/file-issue.sh" --run-dir "$RUN_DIR" --title-file "$RUN_DIR/issues/<fp>.title" --body-file "$RUN_DIR/issues/<fp>.md" [--label bug] [--max 5] [--dry-run]
```

対象 repository は manifest の `repository` から取り、`--repo` が食い違えば拒否する（cwd の `gh repo view` には依存しない）。script は次を機械チェックし、1 つでも落ちれば作成しない: タイトル prefix と文字数、`#\d+` の混入、marker がちょうど 1 個、**構造化した秘匿スキャン**（Anthropic / OpenAI / GitHub / Slack / AWS / Google の既知 token 形式、JWT、Bearer、秘密鍵ブロック、`api_key=` 型の代入、Unix / Windows / `~` の絶対 path、メールアドレス、nonce 入り marker、40 桁以上の hex、32 文字以上の大小英数混在 token）→ 1 つでも当たれば `redaction_failed`、label の存在、fingerprint 一致の既存 Issue、`--max` 超過。作成後は `gh issue view --json` で OPEN・タイトル一致・marker 1 個・label を確認し、`issues/index.json` に追記する。read-back に失敗した Issue は成功に数えず、以後の起票を止める。

秘匿スキャンは deny-list であって完全ではない。スキャンを通っても、本文に「第三者が特定できる値」「run 固有の値」が残っていないか自分で読み直す。判断に迷う値は削る（fail closed）。

## 秘匿

Issue に入れない: secret / token / cookie / header、prompt と response の全文、環境変数全体、個人名を含む絶対 path、screenshot・録画・DOM dump・raw log、nonce。`app.log` の抜粋は error type と最初の 200 字（redact 済み）まで。
