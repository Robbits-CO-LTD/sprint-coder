---
name: release
description: Sprint Coder の stable/beta リリースを安全に準備する。version更新、release PR、Windows x64のビルドとAuthenticode署名、Squirrel自動更新ファイル、macOS成果物、GitHub Draft Releaseへの添付、パッケージ案内、署名・asset・CI検証を扱うときに使用する。
---

# Sprint Coder Release

リポジトリの `AGENTS.md` とこの手順を順守し、署名済み成果物を検証してから GitHub Draft Release を更新する。

## 原則

- release/build設定の変更は高リスクとして `codex/` 作業ブランチとPRを使う。
- 既存のユーザー変更を保持する。リリース作業の一時ファイルや成果物をcommitしない。
- 証明書の秘密鍵、PFXパスワード、tokenを表示・保存・commitしない。thumbprintと証明書Subjectは公開情報として扱える。
- ユーザーが明示しない限りReleaseを公開しない。常にDraftのまま引き渡す。
- タグ、package version、対象commit、成果物内versionが一致しなければ停止する。
- 実在しないassetへのリンクをRelease本文に書かない。
- Windows成果物はWindows上、macOS成果物はmacOS上で作る。cross-buildしない。

## 1. 対象を特定する

1. `apps/desktop/package.json` のversionから既定タグ `v<version>` を得る。
2. `gh release list` と `gh release view <tag>` で対象Draftを確認する。
3. 同じタグのDraftがなければ、PR merge・CI green・ReviewBOT対応後に、merge commitをtargetとしてDraftを作る。古い別versionのDraftを流用しない。
4. stableでは `main` 上のrelease commit、betaでは一致するbeta tagを使う。

## 2. Release PRを完了する

1. version、lockfile、埋め込みclient version、署名設定を確認する。
2. 差分を自己レビューする。
3. `npm run lint`、`npm run typecheck`、関連test、`npm run format:check`を実行する。
4. PRをpushし、ReviewBOTの指摘を修正し、フルCIがgreenになるまで待つ。
5. merge後、`main`を更新し、merge commitへタグを作成・pushする。

PR/CI前に配布物を作ってもよいが、merge commitと異なる場合はアップロードせず、merge commitから再buildする。

## 3. Windows成果物を作成・登録する

Windows PowerShellで [scripts/release-windows.ps1](scripts/release-windows.ps1) を実行する。

```powershell
powershell -ExecutionPolicy Bypass -File .agents/skills/release/scripts/release-windows.ps1 `
  -Tag v0.2.1 `
  -CertificateSha1 <ROBBITS INC.証明書のSHA-1 thumbprint>
```

スクリプトは次をfail-closedで行う。

- cleanな対象commit、Node 22.23.2、GitHub認証、CurrentUser証明書を確認
- `npm ci`、Electron取得、Inno Setup検証、Windows x64 release build
- `Sprint-Coder-Installer.exe` の署名者とthumbprintを検証
- `RELEASES`、`SprintCoder-<version>-full.nupkg`、portable ZIPを検証
- 対象Draftへ4ファイルを `--clobber` で添付
- GitHub上のassetを再取得し、実在するWindows/macOS assetから「パッケージ案内」を生成

対象Draftがまだない場合だけ `-CreateDraftIfMissing` を付ける。PR merge前には付けない。

## 4. macOS成果物を確認する

macOS arm64では次が必要。

- ユーザー向けDMG
- Squirrel.Mac更新ZIP
- ZIPを指す `RELEASES.json`

同じversion、同じ正式なApple署名IDを使う。ad-hoc署名やnotarization未対応なら、その事実をRelease本文へ明記し、自動更新を有効と断定しない。WindowsスクリプトはDraft内にDMGがある場合だけmacOSリンクを案内へ追加する。なければ「準備中」と表示し、壊れたリンクを作らない。

## 5. 最終確認

次を確認して結果を報告する。

- ReleaseはDraftか
- タグとtarget commitは正しいか
- Windows installerの署名状態が `Valid`、Subjectが `ROBBITS INC.` か
- `RELEASES` が同じversionのnupkgを参照するか
- Windows 4点とmacOS 3点（対象の場合）がGitHub上にあるか
- パッケージ案内のURLが実際のasset名と一致するか
- CIとReviewBOTが完了しているか

公開は、ユーザーが明示的に依頼し、全項目が揃った場合だけ行う。
