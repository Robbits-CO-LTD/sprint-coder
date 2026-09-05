# 調査・原因確定契約

## 目的

「症状がある」と「原因が分かった」を分離する。調査量ではなく、因果関係を反証可能な形で
説明できることを徹底調査の完了条件とする。

## 1. Symptom contract

調査開始時に次を固定する。

```yaml
symptom:
  observed: 実際に起きたこと
  expected: 期待したこと
  expectation_source: spec | acceptance | test-contract | ui-contract | documented-behavior
  initial_state: 再現前の状態
  trigger: 操作または入力
  observation_point: UI、response、log、DB、fileなど
  impact: ユーザーまたはシステムへの具体的影響
  environment: OS、app/version、provider、profile、必要な設定
  source_sha: full commit SHA
```

期待値の出典がない場合、設計上の好みをバグとして起票しない。明白な安全性・データ破壊・
クラッシュ契約は、その一般的契約を根拠として明記できる。

範囲指定だけの`area-audit`では、候補発見前に対象component、主要user journey、除外範囲、
終了条件を固定する。検索一致や巡回Findingはこのcontractを満たすまで単なる候補である。

## 2. Evidence lanes

症状に関係するlaneだけを選び、各laneを広く走査すること自体を目的にしない。

| lane | 主な確認 | 注意点 |
|---|---|---|
| runtime | UI、CLI、API、process、network、timeout | 対象artifactとsourceを結び付ける |
| logs | structured log、stderr、console、trace | 内容をredactし、error文字列だけで原因断定しない |
| state | DB、file、cache、設定、永続化 | read-onlyで前後差を観測し、初期化で証拠を消さない |
| code | entrypoint、call graph、type/schema、error mapping | 入力から観測点までの経路を追う |
| tests | 最小失敗test、既存contract test、近接test | 無関係なgreen testを証拠にしない |
| history | blame、関連commit、Issue、PR、release | 古い状態を現行原因として断定しない |
| boundary | OS、native ABI、Provider、network、auth、artifact | 製品欠陥と環境・外部障害を分離する |

コマンドは対象repositoryの指示とmanifestから選ぶ。高コストE2Eや全suiteは、原因境界がそこに
ある場合か最小再現では判定不能な場合だけ使う。実Provider、課金、credential、production
データを伴う検証は、現在のユーザー権限と安全なfixtureが揃う場合だけ行う。

## 3. Reproduction standard

- deterministicな失敗testまたは純粋関数の再現は、1回のFAILにコード経路と別laneの証拠を加える。
- UI、timing、concurrency、network、native、Providerの症状は、初期状態を戻した独立sessionで
  原則2回同じ正規化症状を確認する。
- pass/failが交互なら`flaky_unresolved`。頻度と条件を調べるまで原因確定しない。
- 再現不能でも、crash dump、永続データ、監査logなど改変されていない一次証拠が因果経路を
  特定できる場合は使える。再現不能理由を必ず残す。

## 4. Root-cause gate

次の全項目がYESの場合だけ`root_cause_confirmed`とする。

### A. Observation

- [ ] 期待値、実際値、初期状態、trigger、観測点が固定されている
- [ ] 再現証拠または同等の一次証拠がsource/environmentへ結び付いている

### B. Causal path

- [ ] 入力から失敗観測点までのcall/data/state pathを説明できる
- [ ] 原因となる`file:line + symbol`、設定、artifact、または外部故障境界を特定した
- [ ] その原因が症状を生むmechanismを1〜3文で説明できる

### C. Corroboration

- [ ] コード読解以外を含む独立した2種類以上の証拠がある
- [ ] 証拠同士が同じ原因経路と矛盾しない
- [ ] 有力な代替原因を最低1つ、実測で除外した

### D. Repair connection

- [ ] 原因を除去する最小責任範囲を示せる
- [ ] 修正後に同じ観測点で症状消失を確認する手順がある
- [ ] 完了条件が原因経路に対応し、単なる実装タスク一覧になっていない

外部依存が原因でも、製品側が契約上処理すべきfailureを誤処理しているなら、その製品側の
error-handling境界を原因として扱える。外部障害しか確認できない場合は製品Issueにしない。

## 5. Counter-hypothesis table

有力な仮説だけを管理し、可能性を無制限に列挙しない。

```markdown
| 仮説 | 予測される観測 | 実測 | 判定 | 証拠 |
|---|---|---|---|---|
| H1 | ... | ... | supported/rejected/open | ... |
```

`supported`が複数残る場合、追加の識別実験を行う。識別できなければ`investigation_hold`とする。

## 6. Finding record

```yaml
finding:
  status: root_cause_confirmed
  symptom: 1文
  impact: 具体的影響
  reproduction: 手順またはcommand
  expectation_source: path、URL、Issue、test名
  cause_anchor: file:line + symbol、設定、artifact、または故障境界
  causal_path: 入力から失敗まで
  evidence:
    - lane: runtime
      fact: redact済みの観測
    - lane: code
      fact: 原因経路
  rejected_alternatives:
    - 仮説と除外根拠
  repair_scope: 最小責任範囲
  verification: 同じ観測点での合格条件
  fingerprint: 安定fingerprint
```

## 7. Stop codes

- `investigation_hold`: 原因確定gateが不足
- `blocked_environment`: 対象environmentまたはartifactを用意できない
- `blocked_auth`: 必要なread権限または安全なcredentialがない
- `blocked_safety`: 再現が許可されない副作用を必要とする
- `flaky_unresolved`: 独立再現が安定しない
- `external_only`: 製品契約違反のない外部障害
- `duplicate`: 同じ原因のIssueが存在する
- `fix_in_progress`: 同じ原因を扱うopen PRが存在する
- `regression_hold`: closed Issueと一致し、reopen判断が必要
- `dedup_incomplete`: Issue/PR inventoryを確認できない
- `redaction_failed`: 安全な本文へ変換できない
