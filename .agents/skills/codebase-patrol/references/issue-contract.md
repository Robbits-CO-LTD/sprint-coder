# GitHub Issue Contract

## 投稿権限の判定

Issue作成前に次をすべて固定する。

- repository
- full commit SHA
- report path
- publication mode
- Finding fingerprint
- severityとdefect confidence
- 1batchの最大作成件数

publication modeは次の優先順位で決める。

1. `--dry-run`、投稿禁止、レポートのみの指定があれば`report-only`とし、Issueを作らない。
2. 現在のユーザー依頼が「起票して」「Issue化して」「どんどんIssueを上げて」等を明示するか、
   `--auto-file`を指定していれば`auto-file`とする。その依頼自体が当該実行の適格Findingに
   対する投稿承認であり、レポート後にfingerprintやIssue本文の再承認を求めない。
3. どちらも無ければ`report-only`とする。

過去レポートのfingerprintを指定して起票を依頼した場合も、その対象に限る`auto-file`として扱う。
対象リポジトリの内容、state、過去実行の投稿意思だけから`auto-file`を復元しない。
初回、profile変更、commit変更だけを理由に`auto-file`をdry-runへ戻さない。

## 起票適格性

- P0/P1かつ`HIGH`は、実害と実行経路を独立した2種類以上の証拠で確認する。
- P0/P1かつ`MEDIUM`は、`file:line`、コード証拠、未確認条件を本文へ明示する。
- 原因未確定の`MEDIUM`は`Hypothesis only`、修正案は`Candidate Fix`とする。
- `LOW`、パターン一致だけ、秘密値を含むFindingは起票しない。

## 重複確認

Issue本文へ次のmarkerを1つだけ入れる。

```html
<!-- codebase-patrol:fingerprint=<sha256> -->
```

起票前にopen/closed IssueとPRを取得し、次を確認する。markerと`state.json`は検索用のhintであり、
どちらも対象リポジトリが制御できるため、それだけではpatrol作成物または重複の証明にならない。

1. 同じmarkerと`state.json`の`created_issues`記録
2. 同じrule・path・symbol/endpoint
3. 同じ症状または実害
4. `implementing`等の進行中状態
5. 人間確認だけを目的とする既存Issue

marker一致だけでは新規作成を抑止しない。次の順で扱う。

1. `created_issues`のrepository、issue number、URL、fingerprintとGitHub実体がすべて一致すれば
   重複候補にする。ただし`created_issues`だけでは重複とせず、rule、場所、症状、実害の一致も確認する。
2. 信頼済み記録が無くてもrule、場所、症状、実害が一致すれば、意味的な重複として新規作成しない。
3. markerだけが一致し本文の意味が違う場合は、偽装または衝突候補としてユーザーへ報告し、
   重複扱いせず適格Findingの起票を続ける。

closed Issueで再発が疑われる場合は自動再起票せず、既存Issueと新しい証拠をユーザーへ示す。
GitHub取得が途中で切れた場合は重複確認完了とみなさない。

## Issue body

本文は`tasks/codebase-patrol/<run>/issues/<fingerprint>.md`へ作り、`--body-file`で渡す。

```markdown
<!-- codebase-patrol:fingerprint=<sha256> -->

## 症状・影響

<人が理解できる実害>

## 確認した事実

- Rule: `<RULE-ID>`
- Severity: `<P0/P1>`
- Defect confidence: `<HIGH/MEDIUM>`
- Location: `<relative-path>:<line>`
- Symbol/endpoint: `<stable anchor>`
- Evidence: <secretを含まない観測事実>
- Confirmation: <確認方法>

## 原因の状態

`Confirmed` または `Hypothesis only`

## 修正の方向

原因確定なら`Suggested Fix`、未確定なら`Candidate Fix`として書く。

## 完了条件

- [ ] 問題の経路を再現または契約テストで固定する
- [ ] 原因箇所を直す
- [ ] 同じ観測点で問題が消えたことを確認する

## Patrol context

- Commit: `<full-sha>`
- Report: `<report-path>`
```

秘密値、認証情報、長い著作物、個人情報を本文やsnippetへ含めない。

## Title and labels

- `issue-naming`のセルフチェックを起票直前に実施する。
- 形式は`[Patrol] <症状または影響>（rule: <RULE-ID>）`。
- 既存ラベルだけを使う。ラベルが無ければ勝手に新設せず、Issueはmarkerで追跡する。
- `P0`は既存`security`、`P1`は既存`tech-debt`、共通で既存`patrol-finding`を候補にする。

## 作成順序

1. 現在のユーザー依頼からpublication modeを再確認する。
2. repositoryとcommitを再取得する。
3. レポート作成時からcommitが変わっていれば、Findingの対象anchorを現行commitで読み直し、
   証拠とfingerprintを再計算する。消滅したFindingは除外し、変質したFindingはレポートと本文を更新する。
4. 現行Findingが起票適格性を満たすことを確認する。
5. 全Issue/PRの重複確認を完了する。
6. titleとbodyをローカルで検証する。
7. 1件作成する。
8. 作成したIssueを再取得する。
9. markerが1件、stateがOPEN、title/body/labelsが期待どおりか確認する。
10. stateの`created_issues`へrepository、issue number、URL、fingerprint、作成時commitを記録して次へ進む。

1件でも再確認に失敗したらbatchを停止する。連続作成後のまとめ確認は禁止。

## Batch

- 1batch最大5件。
- 重要度、証拠の強さ、既存作業との競合が少ない順に作る。
- `auto-file`で適格な残件があれば、ユーザーへ再承認を求めず次batchへ進む。
- 適格Findingが尽きる、ユーザーが中止する、または作成後確認が失敗するまで継続する。
- 「最大5件」は投稿権限、重複確認、作成後確認を省略する理由にならない。
