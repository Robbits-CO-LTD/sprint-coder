# CI待ち時間の短縮

基準: main `82b4b69e`。2026-10-24の依頼により、調査で挙げた4項目を実装する。

## 成果と境界

- macOSのCoordinator group 1をshard 2から3へ移し、全caseと3 runnerを維持する。
- websiteと文書だけのPRではサイト専用の構文・参照・画面検証を実行する。混在変更、未知パス、削除、main、手動実行はfullを維持する。fullでもサイト検証が必要な変更を落とさない。
- Electronの既定ダウンロードcacheを永続化する。HTTP 429/5xxと特定の一時通信失敗だけを最大3回試行する。checksum・証明書・archive・権限・不明エラーは失敗を返す。
- Windows packageをproducerで一度作り、同じrunのinstallerと2つのpackaged E2Eへ渡す。installerは`make --skip-package`、E2Eは既存の実行ファイル指定とコピー処理を使う。
- releaseのnative再build、署名、notarization、公開手順、課金Provider実行、製品コード、テストassertion/timeoutは変更対象外。公開とmergeは別の操作である。

## 根拠

- CI 39973650195: macOS各jobは258/500/131秒、Coordinator group 1は約135秒。既存の通常Vitest重みは別stepのbridgeには効かない。
- PR902はwebsiteと作業文書だけだが、CI39611424008で37job・12分37秒。
- CI39955562169の初回はElectron ZIP取得HTTP500で失敗し、再実行後の完了まで22分46秒。
- Windows installerとArchify packaged 2shardが別々にForge packageを生成している。

## 経路と検証

| 経路                              | 変更                                          | 証明                                                                    |
| --------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------- |
| PR全diff分類→required             | website modeとwebsiteRequired、producer必須化 | 分類の混在/削除/非PR、全job待機、欠落/skip/failure拒否                  |
| macOS通常tests→Coordinator→Graph  | group割当だけ変更                             | 両suiteの0..3が各1回、実行loop失敗伝播、実CI所要時間                    |
| website静的配信                   | 独立checker/server/Playwright config          | 構文・参照破損を拒否、全ページdesktop/mobileとホーム操作                |
| Electron install→Forge download   | 共通既定cacheと限定retry                      | fixtureでretry/非retry/上限/終了code、各workflow使用、実CI              |
| Windows package→installer/Archify | 同run artifact共有                            | SHA/実行ファイル/manifest確認、skip-package、既存installer/実worker試験 |

Windows installerのManaged Local smokeはsource側のbuildを読むため、consumerの既存native準備とsidecar buildを維持する。releaseへCI生成packageを流用しない。artifact名はproducerのrun/attempt/SHAに束縛し、consumerはproducer outputを使うため失敗jobのみ再実行にも対応する。

初回CIで追加ブラウザの導入が長時間停止したため、サイト検証は[GitHub hosted Ubuntu同梱のChrome](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md)を利用する。実行時に版を記録し、同じ18項目を実行する。ローカルはPlaywrightのChromiumを既定とし、`WEBSITE_BROWSER_CHANNEL=chrome`でCIと同じ経路を検証できる。

## レビューと完了条件

設計はmacOS、website、Electron、Windows、required gate、artifact/OS境界の6担当で独立確認した。実装後に統合差分を独立レビューする。

1. 直接関連するunit/契約テスト、対象typecheck、lint、format、YAML検証を通す。
2. websiteの実Chromium検証を通す。
3. 同じbranchの実CIで3OS、installer、packaged E2E、requiredを確認し、初回失敗と再実行を区別して時間を記録する。
4. 既存の作業中差分を保持し、変更範囲だけをcommitする。
