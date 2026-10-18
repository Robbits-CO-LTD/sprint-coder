# Computer Use を除く品質巡回

対象: `f3f24ad78df92cd2b1ca54e7f04d1185d8ab2fd2`。report-only、Issue 作成 0 件。profile: TypeScript / React / Electron / SQLite / npm lock。読み取り巡回後の実装修正は、同じユーザー依頼による別工程として実施する。

追跡候補 1,328、Computer Use のファイル名による除外 205、UTF-8 text 検査 1,110。非テキストは文字コード検査に含めない。既存 state の Issue 374–378 と旧 report は参照だけに用い、投稿承認を継承しない。新規 Issue の起票・重複確認は未実施（起票依頼なし）。#863 と #879 は既存の Team 性能の残件として区別する。

PASS は記載した経路で確定 Finding がないという意味であり、全行の安全性の保証ではない。

| Rule     | 結果 | 範囲・根拠                                                                                                                        |
| -------- | ---- | --------------------------------------------------------------------------------------------------------------------------------- |
| SEC-01   | PASS | text の credential 形式候補 18 を確認。テスト用 dummy。値を出力しない                                                             |
| SEC-02   | PASS | IPC 入力検証、SQLite binding、Provider endpoint の検証・接続経路を確認。任意の shell 実行はユーザー依頼の Tool として権限判定する |
| SEC-03   | PASS | ipc.ts の共通 handle が sender / envelope / 入出力 schema を検証。window control と Team MCP の別境界も確認                       |
| SEC-04   | SKIP | ローカル desktop。multitenant schema は今回の対象にない                                                                           |
| SEC-05   | SKIP | 外部 webhook endpoint を今回の対象で確認していない                                                                                |
| ERR-01   | PASS | Provider 接続・catalog の bounded read と Runtime Host の終了判定を確認                                                           |
| ERR-02   | FAIL | Canvas の不正な fit 倍率が保存拒否され、best-effort catch に隠れる。後述の実測と修正前回帰テスト                                  |
| ERR-03   | PASS | Runtime Host の exit、quarantine、pending waiter の reject 経路を確認。全 detached job の網羅監査ではない                         |
| ERR-04   | PASS | public-model-catalog の上限付き read、Provider endpoint の拒否契約。関連 26 +18 unit tests PASS                                   |
| DEP-01   | FAIL | baseline production audit 6 件。high 2 / moderate 1 は更新後 0。low 2 は KaTeX と依存元 Mermaid に残る                            |
| ENC-01   | PASS | 検査 text の UTF-8 decode failure 0                                                                                               |
| DB-01    | SKIP | timestamp の完全な保存→表示→復旧の横断監査は未完。UI の履歴復元確認と区別する                                                     |
| DUP-01   | SKIP | 全 query の重複 call graph は未走査                                                                                               |
| DEAD-01  | FAIL | lint warning 2 件。私有 helper と未使用 catch binding。削除後の最終 lint を別工程で確認                                           |
| ARCH-01  | SKIP | 全 handler の責務重複比較は未走査                                                                                                 |
| PERF-01  | PASS | mock flood 3,000 件で long task 0。実 AI 32 人の合格ではない                                                                      |
| TYPE-01  | PASS | baseline typecheck PASS。境界で unknown→schema validation を確認。全 cast を安全と認定した意味ではない                            |
| MAINT-01 | PASS | 追跡された .bak / .old / .tmp 候補 0                                                                                              |

## 確認された配置保存の原因

`useCamera.ts:184` の camToFit と `:200` の camToFocus は MIN_SCALE を適用していない。canvasCameraSchema の最小値は 0.18。実画面で 34 Worker を作成すると scale=0.173333、getCanvasView=null。別の hook テストでは fit=0.1100244498777506、focus=0.07875 となり、修正前のテストが失敗した。ノード数上限は128で、34件という件数そのものは拒否理由ではない。表示計算を保存契約の最小値に揃える修正と、既存 34 Worker E2E を検証する。

## 依存関係の限界

外部の絶対パスの npm と、manifest / lock のコピーだけを持つ隔離ディレクトリ、空の user/global npmrc、限定した環境で audit。対象の scripts / hooks は audit で実行していない。

sharp の [advisory](https://github.com/lovell/sharp/security/advisories/GHSA-wq5f-xc86-pv6w) は glibc Linux 等の条件を含む。Windows 上の RCE 再現を主張しない。[undici 7.30.1](https://github.com/nodejs/undici/releases/tag/v7.30.1)、[yaml 2.9.1](https://github.com/eemeli/yaml/releases/tag/v2.9.1) と sharp 0.35.5 に更新して関連テスト中。残る KaTeX advisory は prototype pollution 等の前提がある。今回その到達性は確定していない。major 更新だけで安全性を保証しない。

証拠は `%TEMP%/beta-quality-20261019/` と隔離 audit のローカル JSON。生ログ、secret 候補、ユーザー情報は GitHub に掲載しない。完全な完了・公開可否は `tasks/beta-quality-20261019.md` の実 AI、配布版、CI、レビューの結果で判断する。
