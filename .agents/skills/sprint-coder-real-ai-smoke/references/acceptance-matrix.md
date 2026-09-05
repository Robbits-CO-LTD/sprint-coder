# 受入マトリクスと報告契約

このreferenceはrun開始前に読み、未実行項目を暗黙のPASSにしない。

## Case matrix

| ID | Case | PASS条件 |
|---|---|---|
| UI-01 | 開発build同一性 | 現在checkoutのprocess/cwd、renderer、画面markerの2つ以上が一致 |
| UI-02 | Chat標準幅 | header、message list、composer、picker、Project、controlsに重なり/clipping/操作不能なし |
| UI-03 | Chat狭幅 | 意図しない横scroll、欠落control、読めない文字、画面外逸脱なし |
| UI-04 | 設定標準幅 | dialogと主要sectionを巡回でき、各controlのlabel/stateが読める |
| UI-05 | モデルと接続 | CLIとOllamaのrow、状態、展開詳細が重ならず操作できる |
| UI-06 | 設定狭幅/keyboard | 狭幅でも操作可能、keyboardで開閉・移動でき、focusが復帰 |
| AI-OL-01 | Ollama実応答 | 導入済みOllama modelの実Turnがcompletedし、空でない最終回答 |
| AI-OL-02 | Ollama file edit | 専用workspaceの期待relative pathに完全一致byteが存在 |
| AI-OL-03 | Ollama command | tool実行がexit 0、stdout markerが完全一致、file内容を実際に検証 |
| AI-CL-01 | Claude/Codex実応答 | 認証済みClaude CLIまたはCodex CLIの実Turnがcompleted |
| AI-CL-02 | Claude/Codex file edit | 専用workspaceの期待relative pathに完全一致byteが存在 |
| AI-CL-03 | Claude/Codex command | tool実行がexit 0、stdout markerが完全一致、file内容を実際に検証 |
| SAFE-01 | workspace隔離 | AIのread/write/command対象がProvider専用一時directory内だけ |
| SAFE-02 | 秘匿 | report/artifactにcredential、prompt/response全文、環境変数全体なし |

## 状態語

- `PASS`: PASS条件を直接観測し、必要な実測証拠がある。
- `FAIL`: 対象は実行できたがPASS条件を満たさない。
- `BLOCKED`: build、auth、Provider、model、操作toolなどの前提が欠けた。
- `NOT_RUN`: 時間または依頼範囲により未実行。必須caseでは総合PASS不可。

`SKIP`は使わない。必須Providerを別Provider、mock、unit testで代替しない。

## Artifactの最小集合

- run timestamp、current commit、dirty statusの有無
- dev build同一性に使った非機密marker
- OS、Node、windowの概略サイズ、theme
- UI caseごとのcomponent screenshotまたは具体的な観測
- Provider laneごとのConnection/model、Task/Turn識別子、最終状態
- fileのrelative path、期待/実測byte length、SHA-256
- commandの安全な要約、exit code、完全一致stdout marker
- local artifact directoryと一時workspace path

機密になりうる画面全体、chat本文全文、system prompt、API key、token、環境変数全体、
home内の無関係なfilenameはartifactへ保存しない。

## 報告形式

```text
総合: PASS | FAIL | BLOCKED
対象: commit=<sha> / dev build markers=<2つ以上> / macOS=<version>
実Provider: Ollama=<connection/model> / CLI=<Claude|Codex connection/model>

UI
- UI-01 PASS — <短い証拠>
...

実AI tool-use
- Ollama: response=<state> / file=<PASS|FAIL> / command=<PASS|FAIL>
  evidence: <relative path, sha256, exit code, marker>
- Claude|Codex: response=<state> / file=<PASS|FAIL> / command=<PASS|FAIL>
  evidence: <relative path, sha256, exit code, marker>

Finding
- <なし、または症状・期待・実測・再現・artifact>

BLOCKED / NOT_RUN
- <case id、理由、確認済み範囲>

Artifacts: <local path>
Temporary workspaces: <paths、保持/削除状態>
```

「UIテスト済み」「AIが使えた」だけの要約にせず、case単位で範囲を示す。
