# BlenderでSprint Coder Teamの編集を表示する

Sprint Coder Teamの10人のWorkerが、同じBlenderシーンの別々の箇所を観察して編集する。人間が全景を動かしている間も、担当者の3D座標と各Workerの画像が見える。

- Blenderアドオンは担当オブジェクト、カーソル、独立視点を管理する。描画時にGPUで視点画像を取得し、編集はメインスレッドで処理する。
- Sprint CoderのMainは認証済みのTeam Workerに、観察と限定された編集のツールを提供する。Worker IDと担当をサーバー側で結び付ける。モデル入力のIDで担当を切り替えない。
- 接続はユーザーが明示的に開始する。シーン切り替え、切断、Worker停止の際に所有権と保留中の操作を無効にする。操作は対象オブジェクトと観察時の状態を再確認してから反映する。
- Phase 1で扱う編集はオブジェクト移動とメッシュ面の押し出し。Blender本体の変更、任意Pythonの実行、公開ネットワークへの接続は対象外。
- 受入では10人の視点とカーソルが実画面に出ること、異なる担当箇所への編集が同じシーンに反映されること、Workerが更新後の画像を見て次の操作を決められることを確認する。衝突、停止、シーン切り替え、スコープ外の変更は境界テストで確認する。

## Blender側の検証

macOSのBlender 5.1.2で、検証用の10メッシュに対してカーソルと異なる視点を10件ずつ目視した。GPUから得た10件のPNGが互いに異なることも確認した。バックグラウンド試験は移動、押し出し、担当外の編集拒否、古い観察と再使用の拒否を対象にする。

```sh
blender --background --factory-startup --python-exit-code 1 --python integrations/blender/tests/test_addon.py
blender --command extension build --source-dir integrations/blender/sprint_coder_team
```

## 接続と使い方

1. アドオンを標準のBlenderに追加し、対象シーンで1〜10個のメッシュを選択する。
2. 3Dビューポートのサイドバーで **Team → Start pairing** を押してコードをコピーする。
3. Sprint Coderの対象Taskで **Team → ポリシー設定 → Blender** を開き、このTeamに接続する。他のTaskでこの接続は使えない。
4. TeamにBlender作業を指示する。各Workerは担当メッシュの画像と面の位置・法線を取得し、移動または押し出しを行う。必要な角度に変えて再撮影できる。
5. 作業を終えたら接続を解除する。選択対象を変更するときはBlenderで新しいペアリングを開始する。

ペアリングコードは一度だけ使え、BlenderとSprint Coderはループバックで通信する。CLIのWorkerはTeam MCPの登録から、ProviderのWorkerはTeam実行時のIDから担当を決める。観察トークンはWorkerとTurnに束縛し、編集後は再観察を要求する。Provider側は画像送信を既存の送信ポリシーに通す。

## Team側の検証

- macOSの隔離開発版でBlenderのTeamパネルからペアリングを開始し、Sprint Coderで10メッシュの名称が表示されることと解除を確認した。接続コードは検証用のものを入力しており、アプリ間のクリップボード操作は未確認。
- 認証済みTeam MCPに接続した10個のWorker IDで、Blender 5.1.2への観察 → 押し出し → 再観察を同時に実行した。10個すべてで面数が増え、画像も変わった。別Team、別Worker、登録解除済みのTurnは拒否された。
- Codexの画像添付とProviderの画像送信経路は対象テストで確認した。実モデルが画像を判断して10人で作業する受入と、複雑な街区の操作感は未確認。
