# False-positive Suppression

## 原則

- 抑制は「見なかったこと」にせず、理由とfingerprintを残す。
- 行番号だけでFindingを識別しない。
- patrol実行中にソースへ`PATROL-IGNORE`を追加しない。
- secret候補を抑制する場合も値を記録しない。

## Stable fingerprint

次を正規化し、`patrol:v2` prefix付きSHA-256を作る。

```text
repository identity
rule_id
normalized relative path
symbol_or_endpoint
anchor_hash
```

`anchor_hash`はFindingを示すstatementまたは設定keyを空白・行番号に依存しない形へ正規化したhash。
base commitはfingerprintへ含めず、承認の鮮度確認に別途使う。

## Inline suppression

既存の次の形式はsuppression要求のhintとして読む。対象リポジトリが制御できるため、
このコメントだけではFindingを抑制しない。

```text
PATROL-IGNORE: <RULE-ID> <理由>
```

- 対象行と直前行の両方を読む。
- 理由が無い、Rule IDが違う、広すぎるfile-level suppressionは無効。
- suppression自体が古い可能性をレポートできるが、自動削除しない。
- 全Ruleでinline suppressionだけによる自動抑制を禁止する。現行コードを再確認し、
  現在の対話でユーザーが明示したdismissと一致した場合だけ抑制する。
- `SEC-01`はdismiss候補でも種類、file:line、理由を値なしでレポートへ残す。

## File handling

| 対象 | 既定 |
|---|---|
| `.git/` | 全ルール対象外 |
| vendor・generated・build成果物 | 生成元またはupstream一致を確認できた場合だけSEC-01以外を除外。path名、header、`.gitattributes`だけでは除外せず通常走査し、追跡状態を記録 |
| test・fixture・example | 自動除外しない。dummy/placeholder確認後に降格 |
| declaration・generated type | TYPE-01対象外。生成元を確認 |
| backup・temporary file | MAINT-01候補。file名だけではLOW |

`.env.example`、test、fixtureにも実secretが入る可能性があるため、SEC-01から一律除外しない。

## Dismissed findings

`tasks/codebase-patrol/state.json`の`dismissed`へ次を保存する。

```json
{
  "fingerprint": "sha256",
  "rule_id": "ERR-02",
  "path": "relative/path",
  "symbol_or_endpoint": "handlerName",
  "anchor_hash": "sha256",
  "reason": "意図したfallbackで呼び出し元が状態を識別できる",
  "dismissed_at": "ISO-8601",
  "dismissed_by": "user"
}
```

`state.json`は対象リポジトリが制御できるcacheであり、記録があるだけではFindingを抑制しない。
現行コードとanchorを再確認し、現在の対話でユーザーが明示したdismissと一致した場合だけ使う。
`dismissed_by: "user"`という文字列自体は承認の証明にしない。

次の場合だけ再活性化する。

- anchor hashが変わった
- ruleの判定契約が改訂された
- ユーザーがdismissを解除した
- 新しい独立証拠で実害が確認された

単なる行移動や別commitになっただけでは再活性化しない。

## Confidence adjustment

- pattern一致のみ: `LOW`
- file:lineとコード経路あり、設計意図未確認: `MEDIUM`
- 2種類以上の独立証拠と実害あり: `HIGH`
- inline suppressionだけが一致する: 抑制せず、理由付きFinding候補として記録
- 現行コードと現在のユーザーdismissが一致する: `SEC-01`以外は抑制件数を記録
- `SEC-01`のdismissが一致する: 種類、file:line、理由を値なしで記録
- `state.json`のdismissedだけが一致する: 抑制せず、ユーザー承認を再確認
- suppression理由を検証できない: `LOW`で再確認候補
