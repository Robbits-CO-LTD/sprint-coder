# GitHub Issue契約

## 起票適格性

次をすべて満たすFindingだけを起票する。

- `root_cause_confirmed`である
- 現行repository、full source SHA、対象environmentに証拠が結び付いている
- ユーザー影響と期待値の根拠がある
- 原因経路、独立証拠、除外した代替原因、修正後の合格条件がある
- open/closed Issueとopen PRの意味的重複確認が完了している
- redact後のタイトルと本文だけで第三者が再現・判断できる
- 現在の依頼が`live-file`を許可している

severityは優先順位であり、証拠不足を補わない。

## 重複確認

1. repositoryを`gh repo view`またはremoteから再確認する。
   `live-file`では`gh auth status`も確認し、書き込み権限がなければ`blocked_auth`で止める。
2. open/closed Issueを、症状語、component、原因symbol、error class、期待値で複数検索する。
3. open PRを同じ観点で検索する。
4. fingerprint markerがあれば候補抽出に使うが、marker一致だけを重複の根拠にしない。
5. 症状、原因経路、影響、完了条件を読み、意味的に同じなら新規起票しない。

closed Issueと同じ原因が再発している場合は`regression_hold`として既存URLと現在の再現証拠を
報告する。このSkillではreopenやコメントを行わない。

## Privacy

Issueへ含めないもの:

- secret、API key、token、cookie、authorization header、接続文字列、環境変数全体
- prompt/response全文、メール本文、顧客名、完全なemail、電話、住所、billing値
- production record ID、URL query、個人名を含む絶対path
- raw log、DB dump、screenshot、recording、DOM dump

証拠はerror type、sanitized excerpt、basename、HTTP method/status、queryなしpath、安定した
画面名・symbol・test名に縮約する。redactionを確認できなければ`redaction_failed`で止める。

## Title

- `[bug] `から始め、日本語で観測可能な症状と対象を示す
- 原則25〜70文字、1主語・1原因
- Issue/PR番号、内部run ID、個人情報、secret、変動する値を含めない
- 推測語ではなく、確認した症状を書く

## Body template

```markdown
<!-- bug-investigation:fingerprint=<sha256> -->

## 症状と影響

## 再現手順

## 期待した結果と根拠

## 実際の結果

## 根本原因

### 原因経路

### 確認した証拠

### 除外した代替原因

## 影響範囲と非対象

## 環境

- Repository: `owner/repo`
- Source: `<full SHA>`
- Environment: `<redacted minimal facts>`

## 完了条件

- [ ] 原因経路へ直接対応する最小修正がある
- [ ] 修正前と同じ再現手順・観測点で症状が消える
- [ ] 原因に隣接する回帰testが通る
- [ ] `<このFinding固有の観測可能な条件>`

## 調査コンテキスト

- 調査日: `<YYYY-MM-DD>`
- Evidence lanes: `<runtime, code, logs, state, tests, history, boundaryから実施分>`
- 未確認事項: `<なし、またはIssue判断を妨げない事項>`
```

本文では「原因箇所」と「修正案」を分ける。修正方法を一意に証明できない場合、具体案は
`候補`と明記し、完了条件を実装方式へ固定しすぎない。

## Labels

- repositoryに既に存在する`bug`だけを基本とする。
- component labelが明白で既存なら追加できる。
- labelを新規作成しない。priority、`planned`、`implementing`、`implemented`を勝手に付けない。

## 作成とread-back

1. titleとbodyを一時ファイルへ保存し、秘匿とmarkerが1つだけであることを確認する。
2. `gh issue create --body-file <file>`で1件作成する。
3. `gh issue view <number> --json number,url,state,title,body,labels`で直後に取得する。
4. `OPEN`、正確なtitle、fingerprint markerが1つ、意図した既存label、本文の主要sectionを確認する。
5. 失敗時は成功扱いせず、それ以降の作成を止め、外部状態を報告する。

1回最大5件。5件を超える適格Findingは、原因ごとに分離したまま未起票として返す。
