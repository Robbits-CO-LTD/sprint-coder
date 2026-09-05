---
name: bug-investigation-to-issue
description: >-
  報告された、または指定範囲の調査で見つかったバグ候補を、再現、期待値、実行経路、
  ログ・データ、コード、履歴から
  根本原因または故障境界まで徹底調査し、反証と重複確認を通過したものだけを
  1原因1件でGitHub Issueに起票する。トリガー: バグを徹底調査してIssue化、
  不具合の原因を調べて起票、再現してIssueにして。広範なコード品質巡回、修正実装、
  PR作成、既存Issueのcloseには使わない。
---

# Bug Investigation to Issue

症状をIssueへ転記するのではなく、第三者が再現・判断・修正できる証拠束へ変換する。
根拠が不足した観測は起票せず、`investigation_hold`として不足項目を返す。

## 権限と境界

- 現在のユーザー依頼に「起票して」「Issue化して」など明示的な投稿意図がある場合だけ
  `live-file`とする。それ以外は`report-only`でIssue本文案まで作る。
- 調査はread-onlyを基本とし、製品コードの修正、commit、push、PR、既存Issueへの
  コメント・close・reopen・label変更を行わない。
- 既存Issueまたは修正中PRが同じ根本原因を扱う場合、新規Issueを作らずURLと対応関係を返す。
- 1根本原因につき1Issue。同じ原因が複数症状を生む場合は1件へまとめ、別原因は分ける。
- 1回の起票は最大5件。残件は証拠付き候補として報告し、無理に統合しない。
- 本番の送信、決済、削除、公開、顧客データ変更は再現に使わない。安全なfixture、隔離profile、
  dry-run、read-only観測へ置き換えられなければ`blocked_safety`で止める。
- secret、token、cookie、認証header、個人情報、prompt/response全文、顧客データ、URL query、
  secretを含み得る絶対pathをログ・成果物・Issueへ出さない。

## 先に読む契約

1. 毎回 [調査・原因確定契約](references/investigation-contract.md) を読む。
2. 起票またはIssue本文案を作る段階で
   [GitHub Issue契約](references/github-issue-contract.md) を読む。
3. Sprint Coderの可視UI再現が必要な場合だけ`../sprint-coder-e2e-patrol/SKILL.md`を読む。
4. 指定範囲から候補を発見する必要がある場合だけ、静的調査には
   `../codebase-patrol/SKILL.md`、可視UI調査には`../sprint-coder-e2e-patrol/SKILL.md`を読む。
   どちらもこの実行内では`report-only`の候補発見laneとして使い、Issue作成は本Skillの
   原因確定・重複・秘匿gateを通過した後にだけ行う。

## 実行フロー

### 1. Preflight

1. repository root、remote、current branch、full SHA、`git status --short`を実測する。
2. 対象に適用される`AGENTS.md`、仕様、受入条件、関連テスト、manifestを読む。
3. ユーザーの既存変更を記録し、調査中に上書きしない。
4. 症状、影響範囲、発生環境、観測時刻、期待値の出典を「確認済み」と「未確認」に分ける。
5. 現在の依頼から`live-file`か`report-only`かを固定する。

症状が提示されている場合は`symptom-led`、範囲だけが提示されている場合は`area-audit`とする。
`area-audit`では対象範囲と時間・件数の上限を固定し、静的、可視UI、または両方の発見laneを
選ぶ。発見laneのFindingをそのままIssueにせず、候補ごとに以降の原因調査を行う。

### 2. Reproduce and bind

最初に「何が、どの初期状態から、どの操作で、どの観測点に失敗するか」を1文で固定する。
最小再現を作り、実行中のprocess・artifact・source SHA・profile・設定が調査対象と一致することを
確認する。UI、network、Provider、native、DB、OS境界を跨ぐ場合は、どの境界までは正常で、
どこから期待値とずれたかを個別に観測する。

### 3. Investigate causally

[調査・原因確定契約](references/investigation-contract.md)に従い、次を満たすまで仮説として扱う。

- 症状を再現した実行証拠がある。再現不能なら同等の一次証拠と再現不能理由がある。
- 入力から失敗観測点までの経路と、原因箇所または外部故障境界を特定した。
- コード読解以外を含む、独立した2種類以上の証拠が因果説明と一致する。
- 少なくとも1つの有力な代替原因を実測で除外した。
- 原因を取り除けば同じ観測点がどう正常化するか、検証方法を説明できる。

検索の一致、UIの見た目、単発のconsole error、古いIssue、AIの推測だけでは原因確定にしない。
原因が確定しない場合は調査を続けるか、不足証拠を明示して`investigation_hold`で止める。

### 4. Split and deduplicate

候補ごとに安定fingerprintを作る。少なくともrepository、component、入力境界、原因symbolまたは
故障境界、失敗契約を含め、行番号、timestamp、run IDなど変動値を含めない。

同一run内の候補、open/closed GitHub Issues、open PR、直近の関連履歴を検索する。
タイトル一致だけでなく、症状、原因経路、ユーザー影響、完了条件を意味的に照合する。
closed Issueと同じ原因の再発は新規起票せず`regression_hold`とし、勝手にreopenしない。

### 5. Draft and file

[GitHub Issue契約](references/github-issue-contract.md)に沿って、日本語のタイトルと本文を
ローカルで完成させる。起票直前にrepository、full SHA、原因anchor、重複結果、秘匿を再確認する。
headが変わっていたら該当経路だけ現行headで再検証し、証拠が消えた候補は起票しない。

`live-file`では`gh issue create --body-file`で1件ずつ作成し、直後に`gh issue view`で
番号、URL、OPEN、正確なタイトル、本文marker、既存labelをread-backする。read-backに失敗したら
成功件数へ含めず、それ以降の起票を止める。`report-only`では本文案を提示して停止する。

## 完了報告

次を簡潔に返す。

- 調査対象と実測したsource/environment
- `root_cause_confirmed` / `investigation_hold` / `duplicate` / `fix_in_progress`の件数
- 確定した原因経路と除外した代替原因
- 作成したIssueの番号・URL、または起票しなかった理由
- 未確認事項と、次に必要な最小証拠

テスト成功を実症状の解消証拠に置き換えず、SKIPや外部要因を成功扱いしない。
