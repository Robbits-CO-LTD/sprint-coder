# Security and Secrets

## Secret Storage

- Secret操作はElectron Mainだけが行う。
- `safeStorage`を非同期service boundaryで包み、利用不能時はfail closedにする。
- SQLiteのProvider Connectionにはsecret referenceとmask済みmetadataだけを保存する。
- 暗号化payloadはapp-private storageへ保存し、diagnostic export対象外にする。
- Rendererへ完全なsecret、Authorization header、暗号化payloadを返さない。
- API key、Base URL、Organization／Project／Account ID変更時はverificationを即時無効化する。

## Verification

- 既定TTL: 24時間
- expiry state: `verification_expired`
- selectionとcached catalogを削除せず「接続の再確認が必要です」と表示
- 新規Chat／Team executionは再検証成功まで開始しない
- 非生成APIを優先し、存在しない場合だけ最小token probe
- preflight timeout: 3秒
- timeout時はprobeをcancelし、executionを未開始の待機状態に保ち、retry／cancelを表示
- timeoutやnetwork errorをinvalid credentialsへ変換しない
- 実行中attemptはTTL expiryだけで停止しない

background verificationはapp起動、settings表示、Picker表示で可能だが、Pickerを開くたびに全
Connectionへ有料probeを送らない。

## Secure logger

Main、Preload、Provider Adapter、Team Runtimeは共通loggerだけを使う。logger内部で次をredactする。

- Authorization、Bearer
- API key、x-api-key、Provider固有secret header
- access／refresh token
- Cookie、Set-Cookie
- query parameter内secret
- request body内認証情報
- private key、JWT、既知token family

呼び出し側のmask有無を信用しない。raw Provider response、prompt全文、会話全文をdefault logへ
出さない。

## Canary

`SPRINT_CODER_SECRET_CANARY_7f91c`をconnection test、auth failure、Provider exception、retry、
crash report、diagnostic export、application log、audit、IPC、Renderer state、screenshot fixtureへ
通し、どこにも出ないことを検査する。

## CI checks

- SQLite dumpにsecretなし
- config export／diagnostic archiveにsecretなし
- Renderer IPCに完全secretなし
- crash report／Team auditにsecretなし
- production対象pathの`console.log/error/warn/debug`をESLint failure
- test-only smokeの明示allowlistをproduction ruleへ混ぜない
