# Model Picker Migration

## U0 — Current-state and specification

コードを変更せず、ComposerとSettingsのRuntime／Model Picker、Zustand state、global settings、
Turn snapshot、restart、Team selection、keyboard、accessibility、packaged test、Popover実装を
調査する。

現状はglobal selectionで、Runtime model listは最大32件、全件同期renderである。新Pickerは
この制約を引き継がない。

## Catalog client contract

PickerはRuntime kind、CLI Adapter、Provider SDKを読まない。Main-owned `ModelCatalogClient`の
次だけに依存する。

- revision付きcatalog status
- async query: text、connection/provider、capability、availability、cursor、limit
- selected `ModelSelection`
- selection update
- connection verification warning

検索indexはMainのCatalog Serviceがrevision更新時に一度だけ構築する。Rendererのrender pathへ
catalog件数に比例するfilter、sort、group処理を置かない。

## U1 — Feature flag

`multiProviderModelPickerV2`をMain-owned feature flagとして追加し、既定OFFにする。

- OFF: 旧Picker
- ON: 新Picker
- 両方が同じcanonical selection repositoryを使用
- 既存Claude CLI／Codex CLIだけで新Pickerを利用可能
- Provider基盤が利用不能でもOFFへ戻せる
- 旧Pickerを削除しない

### Performance gate

- 1000件以上の合成catalog fixture
- 初期表示、検索、filter、groupが操作可能な速度
- 2件のcatalogでも仮想化を有効化
- viewportとoverscan外のitemをDOMへ置かない
- query結果はpage単位で取得
- index build回数はcatalog revisionあたり1回
- 実Provider通信を必要としないfixture

## U2 — Parity

OFF／ONでselection、Task保存、restart、effort、Runtime解決、Chat、Team、keyboard、
accessibility tree、packagedアプリを比較する。差分は意図を記録し、旧Pickerは残す。

## U3 — Default ON

Unit、Component、Chat E2E、Team E2E、packaged E2E、keyboard、accessibility、1000件fixture、
restart、3OS CIがgreenになってから既定ONにする。旧Pickerはfallbackとして残す。

## U4 — Remove legacy Picker

独立cleanup PRとする。既定ON、fallback動作確認、旧Picker test不要、全test green、
BLOCKER／CRITICAL 0件を削除条件とする。

## Accessibility

- keyboardだけでopen、検索、filter、group移動、選択、close、focus restore
- 仮想化されたoptionのactive descendantと件数を正しく通知
- verification expired、unknown capability、unavailableを色だけで表さない
- reduced motionで不要なtransitionを止める
