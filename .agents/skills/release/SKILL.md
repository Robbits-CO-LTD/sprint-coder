---
name: release
description: Sprint Coder の stable/beta リリースを安全に準備する。前回の公開リリース以降の全変更からSemVerを一度だけ決定し、version更新、release PR、Windows x64のローカルAuthenticode署名、GitHub Actionsのplatform制御、macOS署名・notarization、Squirrel更新ファイル、GitHub Draft Release、asset・CI検証を扱うときに使用する。
---

# Sprint Coder Release

リポジトリの `AGENTS.md` とこの手順を順守する。リリース単位でversionを一度だけ決め、署名・notarization済み成果物を検証してからGitHub Draft Releaseを更新する。

## 原則

- release/build設定の変更は高リスクとして `codex/` 作業ブランチとPRを使う。
- 既存のユーザー変更を保持する。リリース作業の一時ファイルや成果物をcommitしない。
- 秘密鍵、証明書パスワード、token、USB tokenのPINを表示・保存・commitしない。
- ユーザーが明示しない限りtagをpushせず、Releaseを公開しない。Draftまでの権限と公開権限を分ける。
- tag、package version、対象commit、成果物内versionが一致しなければ停止する。
- 実在しないassetへのリンクをRelease本文に書かない。
- Windows成果物はWindows上、macOS成果物はmacOS上で作る。cross-buildしない。

## 1. Versionをリリース時に一度だけ決める

commitごとにversionを上げない。リリース準備を開始したときだけ、次の順で判定する。

1. `gh release list` と `gh release view` で、対象commitの祖先にある直近の公開stable releaseとtagを特定する。現在のpackage versionを基準versionにしない。
2. そのtagの次からリリース対象commitまでの全commit、merge済みPR、実差分を確認する。version bump commit自体は変更種別に数えない。
3. 各変更を下表で分類し、最も大きい変更種別をリリース全体へ一度だけ適用する。commit prefixは初期分類に使うが、実際のユーザー影響を優先する。
4. 基準versionから目標versionを計算する。package versionがすでに目標versionなら再度上げない。基準versionなら目標versionへ一度だけ更新する。その他の不一致は停止して理由を確認する。
5. version、lockfile、埋め込みclient versionを同じ目標versionへ揃える。同一リリース範囲では以後変更しない。

| 最大の変更 | 0.xでの更新 | 1.0.0以降 | 例 |
| --- | --- | --- | --- |
| PATCH | `0.4.0 → 0.4.1` | PATCH | bug fix、UI微調整、既存機能内のrefactor/perf、runtime依存更新 |
| MINOR | `0.4.x → 0.5.0` | MINOR | 新機能、Provider、設定項目、主要UI、workflow |
| BREAKING | `0.5.1 → 0.6.0` | MAJOR | 互換性を壊す変更 |

1.0.0未満ではMAJORを通常使わず、breaking changeもMINORへ上げる。1.0.0以降のbreaking changeだけ次のMAJORへ上げる。

Conventional Commitsの既定分類は次とする。

- `feat:` はMINOR。
- `fix:`、`perf:`、`refactor:` はPATCH。
- `docs:`、`test:`、`chore:` だけなら通常はversionを変えず、releaseを作らない。
- `feat!:`、`fix!:`、本文の `BREAKING CHANGE:` はBREAKING。
- テストがfixやfeatureに付随する場合、テスト自体で追加のbumpはせず、元の変更種別を使う。
- shipped runtime dependencyの更新はPATCH、dev-only/tooling更新は通常 `chore:` として据え置く。
- commit typeと実差分が矛盾する場合、新しい設定やProviderを `fix:` としてPATCH扱いせず、実際の最大変更を採用する。

例: `0.4.2` 以降に2件のfix、Gemini Provider追加、Provider共通化があれば、最大はMINORなので `0.5.0` へ一度だけ上げる。

betaでは先に上記でstableの目標base versionを決め、そのbaseにbeta suffixを付ける。`gh release list` とremote tagを列挙し、対象baseの `v<base>-beta.N` にある最大Nの次を選ぶ。既存tagや既存releaseの番号を再利用しない。beta番号の進行を、同じ変更範囲に対する新たなSemVer bumpとして扱わない。

## 2. Platformと署名方針を確定する

リリースtagやActionsを起動する前に、ユーザーの明示指示を確認する。

- ユーザーが「Windowsコードサイニングあり」と明示した場合だけsigned Windows releaseを選ぶ。
- signed Windows releaseでは、GitHub Actionsの配布buildはmacOSだけにする。WindowsとLinuxの配布buildをActionsで実行しない。品質検証jobは必要な範囲で実行してよい。
- signed Windows成果物は証明書を利用できるWindows環境で [scripts/release-windows.ps1](scripts/release-windows.ps1) を使ってbuild・検証・Draftへ登録する。
- 現行workflowがtag pushでWindows buildも起動する構成なら、そのままtagをpushしない。platform選択をfail-closedで強制するrelease/build変更を別PRまたは同じrelease PRに含め、CI green後に進む。
- 明示がなければWindows署名を推測しない。現在のrelease仕様に沿うunsigned Windows方針を報告し、署名済みと表記しない。

## 3. Release PRを完了する

1. version、lockfile、埋め込みclient version、署名設定、platform選択を確認する。
2. 差分を自己レビューする。
3. `npm run lint`、`npm run typecheck`、関連test、`npm run format:check`を実行する。
4. PRをpushし、ReviewBOTの指摘を修正し、フルCIがgreenになるまで待つ。
5. merge後に`main`を更新する。ユーザーがtag作成を明示している場合だけ、merge commitへtagを作成・pushする。

PR/CI前に配布物を作ってもよいが、merge commitと異なる成果物はuploadせず、merge commitから再buildする。

## 4. macOSを署名・notarizeする

macOS releaseはnotarizationを必須とし、未実施・失敗・タイムアウトを成功扱いしない。ad-hoc署名や「未notarize」と注記した配布へフォールバックしない。

1. 正式な `Developer ID Application` で `.app` と内包native binariesを署名する。
2. `notarytool submit --wait` の結果が `Accepted` であることを機械的に確認する。
3. `.app` へticketをstapleし、`stapler validate`、`codesign --verify --deep --strict`、`spctl --assess --type execute`を通す。
4. notarize・staple済み `.app` からDMGとSquirrel.Mac更新ZIPを作る。ZIPを指す `RELEASES.json` を生成する。
5. 生成したDMGを別途 `notarytool submit --wait` し、`Accepted` を確認してからDMGへticketをstapleする。`stapler validate` と `spctl --assess --type open --context context:primary-signature` を通す。
6. cleanupを `always()` で実行し、一時keychain、P12、API key、app/DMGのnotarization archive/resultをartifactやcacheへ残さない。

必要secret、正式署名ID、Accepted、staple、Gatekeeper評価のいずれかを確認できなければDraft assetを完成扱いせず停止する。
現行workflowがDMGを生成後にnotarize・stapleしない構成なら、そのままrelease tagをpushせず、上記順序をfail-closedで実装するrelease/build PRを先に完了する。

## 5. signed Windows成果物を作成する

ユーザーがWindowsコードサイニングありと明示した場合、Windows PowerShellで次を実行する。

```powershell
powershell -ExecutionPolicy Bypass -File .agents/skills/release/scripts/release-windows.ps1 `
  -Tag <target-tag> `
  -CertificateSha1 <ROBBITS INC.証明書のSHA-1 thumbprint>
```

スクリプトはcleanな対象commit、Node、証明書、署名者、thumbprint、Squirrel更新ファイル、Draftとtarget commitをfail-closedで検証し、既存assetを上書きせず登録する。対象Draftがない場合だけ `-CreateDraftIfMissing` を付ける。PR merge前には付けない。

## 6. Draftと最終状態を検証する

次を確認して結果を報告する。

- ReleaseはDraftか。tagとtarget commit、versionは一致するか。
- SemVer判定は前回公開release以降の全変更を根拠にし、bumpは一度だけか。
- macOS notarizationは `Accepted` か。staple、codesign、Gatekeeper評価はgreenか。
- macOSのDMG、更新ZIP、`RELEASES.json` は同じversionで相互参照が正しいか。
- Windows署名ありの場合、Actionsの配布buildはmacOSだけで、Windows signerは `Valid`、Subjectは `ROBBITS INC.` か。
- `RELEASES` は同じversionのnupkgを参照し、必要asset名とRelease本文URLは一致するか。
- CI、ReviewBOT、secret cleanupが完了しているか。

公開は、ユーザーが明示的に依頼し、全項目が揃った場合だけ行う。
