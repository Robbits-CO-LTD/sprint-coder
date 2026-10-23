# 公式サイトの自動デプロイ

`main` の `website/` が変わると、数分で <https://sprintcoder.yuseilab.com/> に反映される。

## しくみ

公式サイトは、サーバー `yusei`（LAN 内、Cloudflare 経由で公開）の nginx が
`/home/yusei/sprintcoder.yuseilab.com/public` をそのまま配信している。

GitHub Actions から LAN 内のサーバーへは入れない。そこでサーバー側の systemd ユーザータイマーが
5 分おきに `main` を取りに行く（pull 型）。外から入る口も、GitHub に置く秘密情報も増えない。

`deploy.sh` が 1 回分の処理をする。

1. `main` を浅く取得し、`website/` の git tree ハッシュが公開中の版と同じなら何もしない
   （`website/` 以外の変更では反映しない）
2. 変わっていれば `releases/<日時>-<コミット>/` に `website/` を展開する（`tools/` と `README.md` は除く）
3. 公開前の検査: シンボリックリンクや特殊ファイルがないこと（`website/x -> /` のようなリンクでサーバーの
   ファイルが外から読めてしまうため）、`index.html`・`styles.css`・`film.js` があること、ページが参照するローカルのファイルが
   すべてあること、25 MiB 以上のファイルがないこと
4. `public` のシンボリックリンクを一瞬で差し替える
5. 公開後の確認: サーバー自身の nginx からトップと新しい `film.js?v=`・`styles.css` が取れること。
   失敗したら前の版へ戻す。切り替えてから確認が終わるまでは `.pending` に記録しておき、途中で止められた
   ときもその場で前の版へ戻す。強制終了で戻せなかったときは、次の実行の最初に戻す
6. 古い版は 5 つまで残す。各版の記録 `.meta`（数百バイト）は消さずに残し、`rollback.sh` がたどれるようにする
   （版が増えるほど少しずつ溜まるが、意図した動き）。最初の公開だけは戻す先が無いので、確認に失敗しても
   その版のまま（警告を出して保留にする）

検査や確認に失敗した版は `.hold` に記録され、同じ中身では再試行しない。直したコミットが `main` に
入れば、その版は自動で公開される。

```
~/sprintcoder.yuseilab.com/
  public -> releases/<公開中の版>    nginx の root
  releases/<版>/  releases/<版>.meta
  repo.git/                         main の浅い取得
  legacy-assets/                    使われなくなったが外部から参照されうる画像（各版の assets/ に補う）
  .hold                             公開しない tree の一覧（失敗・rollback）
  .pending                          切り替えてから確認が終わるまでの記録
~/.local/lib/sprintcoder-site/      deploy.sh, rollback.sh
~/.config/systemd/user/             sprintcoder-site-deploy.service / .timer
```

## 導入・更新（サーバーで 1 回。再実行しても安全）

```bash
ssh yusei 'rm -rf /tmp/sprintcoder-site-deploy' && scp -r deploy/website yusei:/tmp/sprintcoder-site-deploy && ssh yusei 'bash /tmp/sprintcoder-site-deploy/install.sh'
```

最初に送り先を消すこと。残っていると `scp -r` が中に `website/` を作ってしまい、古いスクリプトのまま導入される。
PowerShell 7 からも同じ 1 行で動く（`tar … | ssh` は PowerShell ではバイナリが壊れるので使わない）。

前提: そのユーザーの linger が有効であること（無効だとログアウト中はユーザーのタイマーが止まり、`main` の更新が
次のログインまで公開されない）。`install.sh` が `loginctl enable-linger` を試し、できなければ警告を出す。その場合は
管理者が `sudo loginctl enable-linger yusei` を実行する。確認は `loginctl show-user yusei -p Linger`（`Linger=yes`）。

今の `public` ディレクトリを最初の版として取り込み、`public` をリンクに置き換える。この時点では
表示は変わらない。最初のタイマー実行で `main` の内容が公開される。

デプロイ用のスクリプトは、`main` から自動では取り込まない。`main` に入ったコードがサーバーで
勝手に動かないようにするため。`deploy/website/` を変えたら `install.sh` をもう一度実行する。

## 運用

サーバーにログインして実行する。手元から `ssh yusei '…'` で直接実行するときは、先頭に
`export XDG_RUNTIME_DIR=/run/user/$(id -u);` を付ける（非対話の ssh では設定されず、`systemctl --user` が失敗する）。

```bash
systemctl --user start sprintcoder-site-deploy        # すぐ反映する
journalctl --user -u sprintcoder-site-deploy -n 50    # 結果を見る
systemctl --user list-timers sprintcoder-site-deploy  # 次の実行時刻
~/.local/lib/sprintcoder-site/rollback.sh             # 直前に公開していた版へ戻す
~/.local/lib/sprintcoder-site/rollback.sh <版の名前>   # 指定した版へ戻す
FORCE=1 ~/.local/lib/sprintcoder-site/deploy.sh       # .hold を無視して今の main を公開する
systemctl --user disable --now sprintcoder-site-deploy.timer   # 自動反映を止める
```

`rollback.sh` は、各版の記録（`previous=`）から「直前に公開していた版」を選ぶ。名前順ではないので、
以前に取り下げた版を選ぶことはない。戻した版は `.hold` に加わり、何回続けて戻しても、取り下げた版を
タイマーが再び公開することはない。新しい版の公開に成功すると `.hold` は空になる。

## 試験

```bash
bash deploy/website/test-deploy.sh
```

一時フォルダの中だけで動き、本番のフォルダ・nginx・systemd には触れない。bash・git・curl・flock・
python3 があれば、サーバーでも手元の Linux でも実行できる。導入、初回の反映、変化なし、`website/` 以外の変更、
公開前の検査の失敗、公開後の確認の失敗と自動での戻し、`rollback.sh`、古い版の整理、二重実行の防止を確かめる。
