# OpenCode と Antigravity を Sprint Coder の通常チャットから使う

状態: 実装済み。OpenCode の無料利用上限を受入の例外として承認済み。

確認日: 2026-11-22

## 使い方

通常チャットのモデル選択で OpenCode と Antigravity のモデルを選べる。OpenCode は公式 CLI 2.2.3 以上の 2.x が必要。Antigravity は設定の「ログイン・接続確認」から専用プロファイルにログインする。

初回はテキストの通常チャットが対象。2026-11-22 の本人指定で、Cursor は今回の対象外。Team の Leader／Worker、画像と CLI 固有のファイル操作も初回の対象外。

## 接続方式

対象の CLI は ACP v1 を標準入出力で提供する。実行ファイルと起動引数は接続先ごとに固定する。CLI をシェル経由で起動せず、プロンプトとモデルを ACP メッセージで渡す。通常チャットの既存 Provider ルートから接続し、標準入出力と子プロセスは既存の所有・停止処理を使う。

| 接続先 | 起動 | モデル・認証 |
| --- | --- | --- |
| OpenCode | `opencode acp` | 分離プロファイルから見えるモデルを使う。モデル ID は `provider/model` を維持する |
| Antigravity | `agy acp` | Antigravity の認証状態を使う。汎用 ACP クライアントに公開される Gemini モデルを表示する |

ACP の行フレーミング、要求と応答の対応付け、出力上限、診断の秘匿は、Grok の ACP クライアントにある既存処理を共通化する。Grok のツール一覧の検証や認証設定は製品固有なので、各接続先ごとの処理に残す。カタログの表示名と保存するモデル ID を分け、表示順の変更で保存済みタスクの接続先が変わらないようにする。

## アプリ内の経路

| 経路 | 既存の入口 | 追加する処理 |
| --- | --- | --- |
| 接続確認 | `main/runtime-host.ts`、`runtime-host/index.ts` | CLI とバージョンを検出し、`initialize` と隔離した `session/new` で判定する |
| モデル選択 | `main/model-catalog-service.ts`、`main/connection-identity.ts` | セッションのモデル選択肢からカタログを作り、接続とモデルの組を共有契約で保存する |
| 送信・キュー・Goal | `main/ipc.ts` の `startSelectedRuntime` | 開始時にモデルと接続を確定し、送信先の表示と既存の送信ポリシーを適用する。公開されていないモデルは送信前にエラーにする |
| 応答・エラー | `runtime-host/protocol.ts`、`main/runtime-host.ts` | 確定したセッションのテキスト更新だけを表示し、認証・プロトコル・終了エラーを既存の表示へ渡す。診断に本文や認証情報を残さない |
| 停止・終了 | `runtime-host/owned-cli-process.ts` | ACP キャンセルと期限付きの子プロセス終了を組み合わせる。終了を確認できない場合は、同じ接続からの次の実行を止める |
| ファイル・コマンド | Managed Harness | CLI のネイティブツールや外部設定で実行権限が広がらないことを確認する。Sprint Coder の既存ツールを使う場合は、同じ作業フォルダー、権限、監査を適用する |

## 安全に接続できる条件

ACP の承認要求は、CLI が承認を求める場合だけ届く。事前許可されている操作、MCP、プラグイン、フック、設定の自動読込は、ACP クライアントで要求を拒否しても止まらない。認証は CLI の専用プロファイルに維持し、空の作業ディレクトリに起動する。Sprint Coder の権限を経由しないファイル操作、子プロセス実行、外部 MCP を防げる証拠が揃った接続先だけを有効にする。既存の OS サンドボックスはコマンドのネットワークを禁止するため、認証・推論通信が必要な CLI にそのまま転用できるかは別に確認する。

## 検証

1. Windows と macOS で、固定された CLI の検出、未導入、未認証、利用可能なモデル取得、モデル選択の保存と復元を確認する。
2. 許可していないファイルやコマンドへのアクセス、プロジェクト設定とグローバル設定からの自動実行、資格情報を含む出力、壊れたプロトコルを、無害な検証用データで確認する。
3. 各 CLI で、選択したモデルからの逐次応答と停止を確認する。停止後は子プロセスが残らないことと、次のターンで別の応答が混ざらないことを確認する。
4. 設定画面と通常チャットを実アプリで確認する。実モデルの呼び出しは適切なアカウントと実行許可が揃った接続先で行う。

現在の確認結果:

- OpenCode 2.2.5 は、macOS の空の作業フォルダーと設定で ACP v1 の初期化とセッション作成に成功し、`model` と `mode` を返した。
- Cursor Agent は、公式アーカイブから一時取得した CLI で ACP v1 の初期化に成功した。認証情報を渡さない試験では、セッションを作ると認証エラー `-32000` を返した。
- Antigravity は、配布元の SHA-512 とコード署名を確認した一時取得の CLI で、ACP v1 の初期化に成功した。認証情報を渡さない試験では、セッションを作ると認証エラー `-32000` を返した。
- Antigravity / Gemini 4 Neon は Apple シリコン Mac の開発版で設定から Google の認証を経て、通常チャットのモデル選択と実応答、実行中の停止に合格した。厳格な CLI 設定を反映した実モデルの Runtime テストも合格した。
- OpenCode / DeepSeek V4.1 Flash Free は CLI 単体で実応答を確認した。開発版の設定、モデル選択、通常チャットの送信は通ったが、OpenCode が `provider.free-limit` を返した。別の無料モデル（Nemotron 3.5 Lightning Free）も Runtime から同じ応答だった。通常チャットの実応答は未確認。2026-11-22 に、無料利用上限による実応答未確認を本人が例外として承認した。
- この開発版での Windows 実機受入は未実施。配布用の Windows・macOS ビルドと公証には、0.8.1 のリリースワークフローを使う。

出典: [Cursor ACP](https://cursor.com/docs/cli/acp)、[OpenCode ACP](https://opencode.ai/docs/cli/acp)、[Antigravity ACP](https://antigravity.google/docs/ide/extensions/acp)、[ACP のツール実行](https://agentclientprotocol.com/protocol/v1/tool-calls)。
