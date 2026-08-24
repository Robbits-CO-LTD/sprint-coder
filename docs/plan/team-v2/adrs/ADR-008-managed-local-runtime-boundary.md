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

Slice Eはnative artifact、process、lease、platform packagingを一つの変更へ混在させず、
次の順に安全境界を固定する。

1. E1: applicationにcompile-time pinされたmanifestだけを受理し、manifest自身と全artifactの
   target、revision、size、SHA-256、license、CPU fallback、symlink/hardlink、実行権限をMainで
   fail-closedに検証する。pinがないtargetではPATH探索やruntime downloadへfallbackしない。
2. E2: pin済み`llama-server`を各native hostでbuild・sign・launch probeし、最終artifactと
   manifestをpackageへ同梱する。GPU backendはprobe済みmatrixだけをmanifestへ載せる。
3. E3: OS割当loopback port、起動ごとのsecret token、引数配列、bounded log、health timeoutを
   所有するprocess supervisorを実装する。
4. E4: single-loaded-model lease、memory再計測、drain、crash/hang/quit/update失効を統合する。

E1のmanifestにある`candidateBackends`はbundleに含まれる候補であり、実行可能性の証明ではない。
実際のbackend可用性はE2のnative launch probeとE3の起動時probeが成功した場合だけ公開する。

E2はllama.cpp `b10516`（commit `b95502ba9aa0eb73a2f4fc8878d7fbe6a847a0b9`）の
公式native release assetをtarget別のsizeとSHA-256へpinする。package時だけnative host用assetを
GitHub releaseから取得し、archive traversalを拒否して`llama-server`、LICENSE、必要な共有library
だけをmaterializeする。通常runtimeからbinaryをdownloadせず、PATH上の既存binaryも使わない。

macOSは正式identityがあるrelease buildではVite build前にsidecarを署名し、local/CIのad-hoc buildでは
上流の有効なlinker署名を保持する。Windows署名設定がある場合もpackage前にsidecarを署名する。
その最終artifactからmanifestを作り、manifest digestをVite buildのMainへcompile-time pinとして埋め込む。
PackagerはManaged Local subtreeを再署名せず、postPackageでartifact、manifest、Main内pinの一致を再読する。

上流archiveの同一directory内library aliasは、manifestが通常fileのtargetを明示する場合だけsymlinkとして
保持できる。Mainはalias名、同一directory、targetの非symlink性、target hashを再検証する。
任意target、親directory symlink、archive外escape、hardlinkは引き続き拒否する。

E3のSupervisorは`127.0.0.1`と`--port 0`を固定し、llama-serverが報告したOS割当portだけを使う。
起動ごとに256-bit tokenを生成して`LLAMA_API_KEY`だけでchildへ渡し、argv、Renderer、DB、診断logへ
tokenを出さない。`/props`が無認証401・認証済み200になることを確認してからrunningへ遷移する。
health、listen、request、stopはすべてbounded timeoutとし、stop deadline後は同じowned childだけを
強制終了する。child環境はlocale、Windows root、専用scratch/cacheだけへ制限し、PATH、loader injection、
home、provider secretを継承しない。Mainのauthenticated fetchは固定loopback originとbounded pathだけを許可する。
