# Patrol Rules

## 共通判定

- ルールはパターン検出の入口であり、欠陥確定ではない。
- `HIGH`には、コード経路・設定・tool出力・再現のうち2種類以上の独立証拠が必要。
- `MEDIUM`には`file:line`、観測事実、実害の説明、未確認条件が必要。
- `LOW`は仮説としてレポートし、Issueを作成しない。
- 技術profile固有ルールは、[profiles.md](profiles.md)でprofileを確認した場合だけ有効化する。
- secret候補は値を出力せず、`<redacted:type>`として扱う。

## Rule catalog

| ID | 優先度 | 種別 | 適用 |
|---|---|---|---|
| SEC-01 | P0 | 追跡ファイル内の秘密情報候補 | 汎用 |
| SEC-02 | P0 | 外部入力を含むquery・command組み立て | 汎用 |
| SEC-03 | P0 | handlerの認証・認可境界欠落 | 条件付き |
| SEC-04 | P0 | tenant・所有者境界欠落 | 条件付き |
| SEC-05 | P0 | webhook真正性検証欠落 | 条件付き |
| ERR-01 | P1 | 明示的error/resultの未確認 | 汎用 |
| ERR-02 | P1 | 失敗を隠すfallback | 汎用 |
| ERR-03 | P1 | 未観測async・process失敗 | 汎用 |
| ERR-04 | P1 | transport/application error境界漏れ | 条件付き |
| DEP-01 | P1 | lock済み依存関係の既知脆弱性 | 条件付き |
| ENC-01 | P1 | repository方針に反するencoding | 汎用 |
| DB-01 | P1 | 時刻の保存・変換・表示契約不一致 | 条件付き |
| DUP-01 | P2 | 同一経路の重複処理・query | 汎用 |
| DEAD-01 | P2 | 到達不能・未使用コード | 汎用 |
| ARCH-01 | P2 | endpoint・責務の二重実装 | 汎用 |
| PERF-01 | P3 | loop内I/O・N+1 | 汎用 |
| TYPE-01 | P3 | 型検査の危険な迂回 | 条件付き |
| MAINT-01 | P3 | backup・一時・stale artifact | 汎用 |

Rule IDはこの18件を正典とする。scan lane、抑制、Issue本文は未定義IDを使わない。

## P0 Security

### SEC-01: 追跡ファイル内の秘密情報候補

- 対象: `git ls-files`で追跡されるtext file。test、fixture、exampleも自動除外しない。
- 検出: credential形式、private key header、token/password代入、接続文字列。
- 確認: placeholder、公開ID、dummy値かを値を再表示せず判定する。
- `HIGH`: 実credentialである証拠と追跡状態を確認した場合。
- 出力: 種類、file:line、追跡状態のみ。値と部分値を出さない。

### SEC-02: 外部入力を含むquery・command組み立て

- 対象: SQL、shell、template、path、filter式へ外部入力を文字列連結する経路。
- 確認: 入力源、validation、parameter binding、実行sinkを同じcall chainで追う。
- 文字列補間の存在だけでは`LOW`。外部入力からsinkまで届けば`MEDIUM`以上。
- framework固有の安全APIを読まずにSQL injectionと断定しない。

### SEC-03: handlerの認証・認可境界欠落

- 条件: route、RPC、job、command handlerと認証方式をprofile確認できた場合。
- 確認: sibling handlerの標準middleware、public endpoint宣言、resource単位認可。
- middleware名や特定directory名を決め打ちしない。
- public endpointの可能性が未解決なら最大`MEDIUM`。

### SEC-04: tenant・所有者境界欠落

- 条件: tenant/org/user ownershipがschema・型・既存queryから確認できた場合。
- 確認: read/write両経路、DB policy、service-role境界、server側filter。
- `org_id`等の特定field名だけで判定しない。
- tenant設計自体が確認できなければSKIPする。

### SEC-05: webhook真正性検証欠落

- 条件: 外部serviceから受けるwebhook endpointを確認できた場合。
- 確認: raw body要件、signature/timestamp/replay検証、失敗時拒否、framework body parser順序。
- Stripe等の特定method名が無いだけではFindingにしない。
- 検証経路が無いことをcall chainで確認した場合だけ`MEDIUM`以上。

## P1 Reliability

### ERR-01: 明示的error/resultの未確認

- 対象: `{data,error}`、`Result`、status tuple、exit codeなど明示的失敗を返すAPI。
- APIがthrowするか、resultを返すかを実装・型・公式契約のいずれかで確認する。
- destructuringや戻り値未使用だけでは`LOW`。
- 下流が失敗値を正常値として扱う経路まで確認できれば`MEDIUM`以上。

### ERR-02: 失敗を隠すfallback

- 対象: `catch`やerror branchが空配列、null、成功応答等へ変換する経路。
- fallbackが設計仕様、best-effort、呼び出し元で識別可能ならFindingにしない。
- 利用者が成功と誤認する観測点を示す。

### ERR-03: 未観測async・process失敗

- 対象: awaitされないpromise、fire-and-forget job、未確認exit code、background task。
- lifecycle、error hook、queue retry、shutdown処理を確認する。
- 意図的なdetachで監視経路があれば抑制する。

### ERR-04: transport/application error境界漏れ

- 条件: retry、fallback、recovery、circuit breakerが存在する場合。
- timeout、connection reset、HTTP error、domain errorが同じ回復条件へ届くか確認する。
- 特定libraryのerror classを前提にせず、実際のadapterとerror mappingを読む。

### DEP-01: lock済み依存関係の既知脆弱性

- 条件: lockfileと対応package managerを確認できた場合。
- 同一commitの既存CIはworkflow定義、実行command、ログから当該auditの実行を確認できた場合だけ
  証拠にする。check名やPASS表示だけなら未検証として扱う。
- 追加実行は[profiles.md](profiles.md)の隔離条件を満たすrunnerでだけ行い、対象working treeでは
  package managerを実行しない。
- 対象リポジトリ内で定義されたscript、Makefile target、repository-supplied binary、
  tool設定のhookは実行しない。安全な実行境界を確認できなければSKIPする。
- toolを勝手にinstallしない。network不可またはtool不在はSKIP。
- advisory severityだけでなく、lock済みversion、runtime/dev区分、到達性の確認状態を書く。

### ENC-01: repository方針に反するencoding

- 対象: tracking対象のtext file。
- repository policy、editorconfig、compiler/runtime期待と照合する。
- BOMや非UTF-8を一律欠陥にしない。policy不一致や実際のdecode failureを示す。

### DB-01: 時刻の保存・変換・表示契約不一致

- 条件: DB schema、serialization、API、表示の経路を確認できた場合。
- `TIMESTAMP WITHOUT TIME ZONE`の文字列一致は`LOW`候補に留める。
- business上のlocal timeかinstantか、DB型、driver変換、timezone付与、表示期待を追う。
- 9時間ずれ等の実害を再現または契約違反として確認した場合だけ`HIGH`候補。

## P2/P3 Maintainability

### DUP-01: 同一経路の重複処理・query

- 同じrequest/job経路で同じresourceを重複取得・変換することをcall graphで確認する。
- cache、整合性再確認、異なるtransaction境界なら抑制する。

### DEAD-01: 到達不能・未使用コード

- compiler、linter、project-native analyzerの結果を優先する。
- public API、reflection、dynamic import、plugin registrationを確認する。
- text searchだけの「参照なし」は`LOW`。

### ARCH-01: endpoint・責務の二重実装

- directory名や同名fileだけで判定しない。
- route registration、method/path、consumer、deployment target、ownershipを比較する。

### PERF-01: loop内I/O・N+1

- loop内I/Oを候補として検出し、件数上限、batch API、lazy loading、transactionを確認する。
- 実際に件数へ比例してI/Oが増える経路を示した場合だけ`MEDIUM`以上。

### TYPE-01: 型検査の危険な迂回

- 条件: 型付き言語またはschema validatorを確認できた場合。
- `any`、unchecked cast、ignore directive、force unwrap等を候補にする。
- boundary validation、test、narrowingがあれば抑制する。
- castの存在だけでは`LOW`。

### MAINT-01: backup・一時・stale artifact

- `.bak`、`.old`、一時生成物、使用されないmigration/flag等を候補にする。
- build/package/ignore対象、復旧手順、意図的fixtureを確認する。
- file名だけでは`LOW`。
