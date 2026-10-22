#!/usr/bin/env bash
# deploy.sh / rollback.sh / install.sh の試験。本番には触れない（すべて一時フォルダの中、systemctl も呼ばない）。
# 必要なもの: bash, git, curl, flock, python3。サーバーでも手元の Linux でも動く。
#
#   bash deploy/website/test-deploy.sh
set -euo pipefail

SRC=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d /tmp/sprintcoder-deploy-test.XXXXXX)
PORT=$((20000 + RANDOM % 20000))
export SITE_HOME=$T/site LIB=$T/lib UNITS=$T/units NO_SYSTEMD=1
export HEALTH_BASE_URL=http://127.0.0.1:$PORT HEALTH_RESOLVE=
export REPO_URL=file://$T/origin.git BRANCH=main
server_pid=""
cleanup() {
  [ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null || true
  rm -rf "$T"
}
trap cleanup EXIT

pass=0
fail=0
check() { # check <説明> <条件コマンド...>
  local name=$1
  shift
  if "$@"; then
    echo "PASS $name"
    pass=$((pass + 1))
  else
    echo "FAIL $name"
    fail=$((fail + 1))
  fi
}
served() { curl -fsS "$HEALTH_BASE_URL/$1"; }
start_server() {
  python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$SITE_HOME/public" >/dev/null 2>&1 &
  server_pid=$!
  for _ in $(seq 50); do curl -fs -o /dev/null "$HEALTH_BASE_URL/" && return 0 || sleep 0.1; done
}
stop_server() {
  kill "$server_pid" 2>/dev/null || true
  wait "$server_pid" 2>/dev/null || true
  server_pid=""
}
commit_site() { # commit_site <メッセージ>（作業ツリーの変更を origin.git の main へ）
  git -C "$T/work" add -A
  git -C "$T/work" -c user.name=test -c user.email=test@example.invalid commit -qm "$1"
  git -C "$T/work" push -q origin main
}

# ---------------------------------------------------------------- 準備: 本物そっくりのリポジトリと、旧サイトの public
git init -q --bare "$T/origin.git"
git init -q -b main "$T/work"
git -C "$T/work" remote add origin "$T/origin.git"
mkdir -p "$T/work/website/assets" "$T/work/website/about" "$T/work/website/tools" "$T/work/apps"
cat >"$T/work/website/index.html" <<'EOF'
<!doctype html><title>new</title><link rel="stylesheet" href="/styles.css?v=1" /><script src="/film.js?v=1"></script>
<a href="/about/">about</a><img src="/assets/icon.png" alt="" />
EOF
echo '<!doctype html><title>about</title><a href="/">top</a>' >"$T/work/website/about/index.html"
echo 'body{}' >"$T/work/website/styles.css"
echo '// film' >"$T/work/website/film.js"
echo 'png' >"$T/work/website/assets/icon.png"
echo 'tool' >"$T/work/website/tools/make.sh"
echo 'readme' >"$T/work/website/README.md"
echo 'app' >"$T/work/apps/app.ts"
commit_site "site v1"

mkdir -p "$SITE_HOME/public/assets"
echo '<!doctype html><title>old</title>' >"$SITE_HOME/public/index.html"
echo 'oldpng' >"$SITE_HOME/public/assets/sprint-coder-og.png"

# ---------------------------------------------------------------- 1. 導入: 表示を変えずに public をリンクにする
bash "$SRC/install.sh" >/dev/null
check "install: public がリンクになる" test -L "$SITE_HOME/public"
check "install: 旧サイトのまま" grep -q old "$SITE_HOME/public/index.html"
check "install: 旧画像を legacy-assets へ" test -f "$SITE_HOME/legacy-assets/sprint-coder-og.png"
check "install: スクリプトを配置" test -x "$LIB/deploy.sh"
bash "$SRC/install.sh" >/dev/null
check "install: 再実行しても安全" test "$(find "$SITE_HOME/releases" -mindepth 1 -maxdepth 1 -type d | wc -l)" -eq 1

start_server

# ---------------------------------------------------------------- 2. 初回の反映
bash "$LIB/deploy.sh"
check "deploy: 新サイトを公開" grep -q new <(served index.html)
check "deploy: 下層ページ" grep -q about <(served about/)
check "deploy: tools/ と README.md は公開しない" bash -c '! curl -fs -o /dev/null "$0/tools/make.sh" && ! curl -fs -o /dev/null "$0/README.md"' "$HEALTH_BASE_URL"
check "deploy: website/ の外は公開しない" bash -c '! curl -fs -o /dev/null "$0/apps/app.ts"' "$HEALTH_BASE_URL"
check "deploy: 旧画像を補う" grep -q oldpng <(served assets/sprint-coder-og.png)
check "deploy: メタ情報は公開フォルダの外" bash -c '! ls -A "$0/public/" | grep -q meta' "$SITE_HOME"
first=$(basename "$(readlink "$SITE_HOME/public")")

# ---------------------------------------------------------------- 3. 変化なし
out=$(bash "$LIB/deploy.sh")
check "deploy: 変化なしなら何もしない" grep -q 変化なし <<<"$out"
echo 'x' >"$T/work/apps/app.ts"
commit_site "app only"
out=$(bash "$LIB/deploy.sh")
check "deploy: website/ 以外の変更では何もしない" grep -q 変化なし <<<"$out"

# ---------------------------------------------------------------- 4. 公開前の検査に失敗 → 公開しない
sed -i 's#/assets/icon.png#/assets/missing.png#' "$T/work/website/index.html"
commit_site "broken ref"
check "deploy: 参照切れは失敗で終わる" bash -c '! bash "$0/deploy.sh" >/dev/null 2>&1' "$LIB"
check "deploy: 参照切れでは公開しない" test "$(basename "$(readlink "$SITE_HOME/public")")" = "$first"
out=$(bash "$LIB/deploy.sh")
check "deploy: 同じ壊れた版は再試行しない（.hold）" grep -q 止めてある <<<"$out"

# ---------------------------------------------------------------- 4b. シンボリックリンクは公開しない
sed -i 's#/assets/missing.png#/assets/icon.png#' "$T/work/website/index.html"
ln -s / "$T/work/website/server-root"
commit_site "symlink"
check "deploy: リンクを含む版は失敗で終わる" bash -c '! bash "$0/deploy.sh" >/dev/null 2>&1' "$LIB"
check "deploy: リンクを含む版は公開しない" test "$(basename "$(readlink "$SITE_HOME/public")")" = "$first"
check "deploy: リンク先のファイルは読めない" bash -c '! curl -fs -o /dev/null "$0/server-root/etc/hostname"' "$HEALTH_BASE_URL"
rm "$T/work/website/server-root"

# ---------------------------------------------------------------- 5. 直したコミット → 公開
sed -i 's#/assets/missing.png#/assets/icon.png#; s#<title>new#<title>v2#; s#v=1#v=2#g' "$T/work/website/index.html"
commit_site "site v2"
sleep 1 # 版の名前（秒単位の時刻）が重ならないように
bash "$LIB/deploy.sh" >/dev/null
check "deploy: 直した版を公開" grep -q v2 <(served index.html)
check "deploy: .hold を消す" test ! -e "$SITE_HOME/.hold"
second=$(basename "$(readlink "$SITE_HOME/public")")

# ---------------------------------------------------------------- 6. 公開後の確認に失敗 → 前の版へ戻す
sed -i 's#<title>v2#<title>v3#; s#v=2#v=3#g' "$T/work/website/index.html"
commit_site "site v3"
stop_server # 配信が止まっている＝確認に失敗する
sleep 1
check "deploy: 公開後の確認に失敗したら失敗で終わる" bash -c '! bash "$0/deploy.sh" >/dev/null 2>&1' "$LIB"
check "deploy: 前の版へ戻す" test "$(basename "$(readlink "$SITE_HOME/public")")" = "$second"
start_server
out=$(bash "$LIB/deploy.sh")
check "deploy: 戻した版はすぐ再試行しない" grep -q 止めてある <<<"$out"
FORCE=1 bash "$LIB/deploy.sh" >/dev/null
check "deploy: FORCE=1 で公開できる" grep -q v3 <(served index.html)
third=$(basename "$(readlink "$SITE_HOME/public")")

# ---------------------------------------------------------------- 7. rollback.sh
bash "$LIB/rollback.sh" >/dev/null
check "rollback: 1 つ前の版へ" test "$(basename "$(readlink "$SITE_HOME/public")")" = "$second"
out=$(bash "$LIB/deploy.sh")
check "rollback: タイマーがすぐ元へ戻さない" grep -q 止めてある <<<"$out"
bash "$LIB/rollback.sh" "$third" >/dev/null
check "rollback: 指定した版へ" test "$(basename "$(readlink "$SITE_HOME/public")")" = "$third"

# ---------------------------------------------------------------- 8. 古い版の整理と二重実行
for i in 4 5 6 7 8 9; do
  sed -i "s#<title>v[0-9]*#<title>v$i#" "$T/work/website/index.html"
  commit_site "site v$i"
  sleep 1
  bash "$LIB/deploy.sh" >/dev/null
done
current=$(basename "$(readlink "$SITE_HOME/public")")
count=$(find "$SITE_HOME/releases" -mindepth 1 -maxdepth 1 -type d | wc -l)
check "prune: 版は KEEP(5) 個まで" test "$count" -le 5
check "prune: 公開中の版は残る" test -d "$SITE_HOME/releases/$current"
check "prune: .tmp を残さない" bash -c '! ls -A "$0/releases" | grep -q "^.tmp-"' "$SITE_HOME"
# ---------------------------------------------------------------- 9. rollback は「直前に公開していた版」へ。続けて戻しても保留は残る
next_site() {
  sed -i "s#<title>v[0-9]*#<title>v$1#" "$T/work/website/index.html"
  commit_site "site v$1"
  sleep 1
  bash "$LIB/deploy.sh" >/dev/null
  basename "$(readlink "$SITE_HOME/public")"
}
a=$(basename "$(readlink "$SITE_HOME/public")")
b=$(next_site 10)
bash "$LIB/rollback.sh" >/dev/null # b を取り下げて a へ
check "rollback: 直前の版へ" test "$(basename "$(readlink "$SITE_HOME/public")")" = "$a"
c=$(next_site 11) # 直した版。直前に公開していたのは a
bash "$LIB/rollback.sh" >/dev/null
check "rollback: 取り下げた版ではなく、直前に公開していた版へ" test "$(basename "$(readlink "$SITE_HOME/public")")" = "$a"
bash "$LIB/rollback.sh" >/dev/null # さらにその前へ
check "rollback: 続けて戻せる" test "$(basename "$(readlink "$SITE_HOME/public")")" != "$a"
out=$(bash "$LIB/deploy.sh")
check "rollback: 続けて戻しても main の版を再公開しない" grep -q 止めてある <<<"$out"
check "rollback: 取り下げた版は .hold に残る" test "$(grep -c '^tree=' "$SITE_HOME/.hold")" -ge 2
[ -n "$b$c" ]

# ---------------------------------------------------------------- 10. 確認の途中で止められたら、前の版へ戻す
check "prune: 版の記録（.meta）は残す" test "$(find "$SITE_HOME/releases" -maxdepth 1 -name '*.meta' | wc -l)" -gt "$(find "$SITE_HOME/releases" -mindepth 1 -maxdepth 1 -type d | wc -l)"
FORCE=1 bash "$LIB/deploy.sh" >/dev/null # 保留を外して main を公開し直す
rm -f "$SITE_HOME/.hold"
before=$(basename "$(readlink "$SITE_HOME/public")")
HANG=$((PORT + 1))
python3 -c "import socket,time;s=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind(('127.0.0.1',$HANG));s.listen(16);time.sleep(300)" &
hang_pid=$!
sleep 0.5
run_hanging() { # 応答しない確認先で deploy.sh を動かし、確認の途中で <シグナル> を送る（systemd と同じくプロセスグループごと）
  local sig=$1 i pid
  sed -i "s#<title>v[0-9]*#<title>v$2#" "$T/work/website/index.html"
  commit_site "site v$2"
  sleep 1
  HEALTH_BASE_URL=http://127.0.0.1:$HANG setsid bash "$LIB/deploy.sh" >/dev/null 2>&1 &
  pid=$!
  for i in $(seq 100); do [ -f "$SITE_HOME/.pending" ] && break || sleep 0.1; done
  sleep 1
  kill "-$sig" -- "-$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}
run_hanging TERM 12
check "interrupt: 止められたら前の版へ戻す" test "$(basename "$(readlink "$SITE_HOME/public")")" = "$before"
check "interrupt: .pending を残さない" test ! -e "$SITE_HOME/.pending"
check "interrupt: 止められた版は保留" test -s "$SITE_HOME/.hold"
rm -f "$SITE_HOME/.hold"
run_hanging KILL 13 # 後片付けもできずに止まった
check "crash: 強制終了では .pending が残る" test -f "$SITE_HOME/.pending"
out=$(bash "$LIB/deploy.sh" 2>&1 || true)
check "crash: 次の実行で前の版へ戻す" test "$(basename "$(readlink "$SITE_HOME/public")")" = "$before"
check "crash: 次の実行で保留にして再公開しない" grep -q 止めてある <<<"$out"
kill "$hang_pid" 2>/dev/null || true

exec 8>"$SITE_HOME/.deploy.lock"
flock 8
out=$(bash "$LIB/deploy.sh")
flock -u 8
check "lock: 二重実行しない" grep -q 別の反映 <<<"$out"

echo "---- $pass passed, $fail failed"
[ "$fail" -eq 0 ]
