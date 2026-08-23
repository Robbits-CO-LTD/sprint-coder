# ADR-008: Managed Local v1の実行境界

- Status: Accepted
- Date: 2026-08-23
- Related: Issue #122、ADR-003、ADR-005、ADR-006

## Decision

Managed Local v1は、pin済みの`llama.cpp` sidecarとGGUFモデルを使う。
sidecarの配布物はSprint Coderのreleaseへ同梱する。
モデル取得機能はsidecarを更新しない。

既存の`openai_compatible` Provider Runtimeを再利用する。
Managed Local専用のProvider protocolは追加しない。
Mainがsidecarの起動、停止、lease、認証済みloopback通信を管理する。

推論場所とモデルの利用形態を次の契約で分ける。

- `ProviderComputeLocation`: `cloud | local`
- `ModelCatalogAccessType`: `subscription | api | local`

推論場所はendpointの信頼度やprocessの実行場所とは別の情報である。
MainはURL、provider名、接続先の信頼度から推測しない。
組み込みCLIと公式APIは`cloud`とする。
Profile接続はProfileの明示値を使う。
mockは`local`とする。

古いProfileや未登録connectionは`cloud` / `api`へ戻す。
明示分類がないconnectionを`local`へ昇格しない。

## Alternatives

| 候補                | 判断         | 理由                                                   |
| ------------------- | ------------ | ------------------------------------------------------ |
| 既存Ollamaへ委譲    | 不採用       | Sprint Coderが取得から検証まで管理する要件を満たさない |
| LocalAI本体を同梱   | v1では不採用 | Windowsネイティブ配布とbackend境界が広すぎる           |
| `llama.cpp` sidecar | 採用         | 3OS、GGUF、OpenAI互換APIを狭い境界で扱える             |

## Security boundary

sidecarはMainだけが起動する。`127.0.0.1`のOS割当portへbindする。
Mainは起動ごとにtokenを生成し、Renderer、DB、ログへ平文を渡さない。

releaseは実行ファイル、backend、license、version、SHA-256をpinする。
Mainは任意URLやPATH上の同名binaryを起動しない。
sidecarはmodel storeを読み取り専用で使い、Workspaceやsecretへアクセスしない。

## Consequences

Slice Aは分類契約と既存Catalogへの接続だけを実装する。
download、hardware inventory、sidecar、UIは後続Sliceで追加する。

`ProviderConnection`は永続化の正本として変更しない。
Rendererには既存項目を保つ`ProviderConnectionView`を返す。
このViewにMainが導出した`computeLocation`を追加する。

Model Catalogはconnectionごとの明示access mapを受け取る。
mapにないconnectionは従来どおり`api`へ分類する。
