#!/usr/bin/env bash
# Sprint Coder 公式サイトを、GitHub の main の website/ から本番へ反映する（1 回分）。
# systemd ユーザータイマー（sprintcoder-site-deploy.timer）から 5 分おきに呼ばれる。
#
#   - website/ の git tree ハッシュが、いま公開中の版と同じなら何もしない
#   - 違えば releases/<日時>-<コミット> に展開 → 公開前の検査 → public のリンクを差し替え
#     → 公開後の確認。確認に失敗したら前の版へ戻し、その tree は止めておく（.hold）
#
# 配置（SITE_HOME）:
#   repo.git/          main を浅く取得する bare リポジトリ
#   releases/<id>/     公開する中身（website/ から tools/ と README.md を除いたもの）
#   releases/<id>.meta tree=… commit=… previous=…（直前に公開していた版）の記録（公開ディレクトリの外）
#   public -> releases/<id>   nginx の root。シンボリックリンク
#   legacy-assets/     もう使っていないが外部から参照されうる画像。各版の assets/ に補う
#   .hold              公開しない tree の一覧（tree=… を 1 行ずつ。検査や確認に失敗、rollback.sh で戻した）。
#                      新しい版の公開に成功すると空にする
set -euo pipefail

SITE_HOME=${SITE_HOME:-$HOME/sprintcoder.yuseilab.com}
REPO_URL=${REPO_URL:-https://github.com/Robbits-CO-LTD/sprint-coder.git}
BRANCH=${BRANCH:-main}
SITE_DIR=${SITE_DIR:-website}
SITE_HOST=${SITE_HOST:-sprintcoder.yuseilab.com}
# 公開後の確認先。既定はサーバー自身の nginx（Cloudflare を通さない）
HEALTH_BASE_URL=${HEALTH_BASE_URL:-https://$SITE_HOST}
HEALTH_RESOLVE=${HEALTH_RESOLVE-$SITE_HOST:443:127.0.0.1}
KEEP=${KEEP:-5}
MAX_FILE_BYTES=${MAX_FILE_BYTES:-26214400} # 25 MiB
FORCE=${FORCE:-0}

log() { printf '[sprintcoder-deploy] %s\n' "$*"; }
die() {
  log "ERROR: $*"
  exit 1
}

cd "$SITE_HOME" || die "SITE_HOME がない: $SITE_HOME"
mkdir -p releases

exec 9>"$SITE_HOME/.deploy.lock"
if ! flock -n 9; then
  log "別の反映が動いているので今回は何もしない"
  exit 0
fi

if [ -e public ] && [ ! -L public ]; then
  die "public がシンボリックリンクではない。先に install.sh を実行すること"
fi

switch_to() {
  ln -sfn "releases/$1" public.next
  mv -Tf public.next public
}
hold_tree() { # hold_tree <tree> <理由>  公開しない一覧（.hold）に加える
  [ -n "$1" ] || return 0
  grep -qxF "tree=$1" .hold 2>/dev/null || printf 'tree=%s\n' "$1" >>.hold
  log "保留に追加: ${1:0:12}（$2）"
}
# 切り替えてから確認が終わるまでの間は .pending に記録しておく。確認に失敗したとき・途中で止められたとき・
# 前回がその途中で止まっていたときは、ここで前の版へ戻し、その版を保留にする
recover_pending() {
  [ -f .pending ] || return 0
  local p_id p_prev p_tree
  p_id=$(sed -n 's/^id=//p' .pending)
  p_prev=$(sed -n 's/^previous=//p' .pending)
  p_tree=$(sed -n 's/^tree=//p' .pending)
  if [ -L public ] && [ "$(basename "$(readlink public)")" = "$p_id" ] && [ -n "$p_prev" ] && [ -d "releases/$p_prev" ]; then
    switch_to "$p_prev"
    log "確認の済んでいない $p_id から $p_prev に戻した"
  elif [ -z "$p_prev" ]; then
    log "注意: 最初の公開で戻す先の版が無いので、確認の済んでいない $p_id を公開したままにする"
  fi
  if [ -n "$p_id" ] && [ "$(basename "$(readlink public 2>/dev/null)")" != "$p_id" ]; then
    rm -rf "releases/$p_id" "releases/$p_id.meta"
  fi
  hold_tree "$p_tree" "公開後の確認が済まなかった"
  rm -f .pending
}
if [ -f .pending ]; then
  log "前回は公開後の確認の途中で止まっていた"
  recover_pending
fi

# ---------------------------------------------------------------- 取得と変化の判定
if [ ! -d repo.git ]; then
  git init --quiet --bare repo.git
  git -C repo.git remote add origin "$REPO_URL"
fi
git -C repo.git remote set-url origin "$REPO_URL"
git -C repo.git fetch --quiet --depth=1 --no-tags origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
commit=$(git -C repo.git rev-parse "refs/remotes/origin/$BRANCH")
tree=$(git -C repo.git rev-parse "$commit:$SITE_DIR")

current_id=""
current_tree=""
if [ -L public ]; then
  current_id=$(basename "$(readlink public)")
  if [ -f "releases/$current_id.meta" ]; then
    current_tree=$(sed -n 's/^tree=//p' "releases/$current_id.meta")
  fi
fi

if [ "$tree" = "$current_tree" ]; then
  log "変化なし（${commit:0:8} の $SITE_DIR は公開中の $current_id と同じ）"
  exit 0
fi
if [ "$FORCE" != 1 ] && grep -qxF "tree=$tree" .hold 2>/dev/null; then
  log "この版（${commit:0:8}）は止めてある（.hold）。直したコミットを待つか FORCE=1 で実行"
  exit 0
fi

# ---------------------------------------------------------------- 展開
id="$(date -u +%Y%m%dT%H%M%SZ)-${commit:0:8}"
tmp="releases/.tmp-$id"
rm -rf "$tmp"
mkdir -p "$tmp"
trap 'rm -rf "$SITE_HOME/$tmp"' EXIT
git -C repo.git archive "$commit" "$SITE_DIR" | tar -x -C "$tmp" --strip-components=1
# 補完コピーや除外処理より先に拒否する。assets がリンクだと公開前でも外部へ書き込んでしまう。
if [ -n "$(find "$tmp" ! -type f ! -type d -print -quit)" ]; then
  hold_tree "$tree" "展開内容にリンクまたは特殊ファイルがある"
  die "リンクまたは特殊ファイルを含むので公開しない（${commit:0:8}）"
fi
rm -rf "$tmp/tools" "$tmp/README.md"
if [ -d legacy-assets ] && [ -n "$(ls -A legacy-assets 2>/dev/null)" ]; then
  mkdir -p "$tmp/assets"
  for f in legacy-assets/*; do
    [ -e "$tmp/assets/${f##*/}" ] || cp "$f" "$tmp/assets/"
  done
fi

# ---------------------------------------------------------------- 公開前の検査
problems=()
# シンボリックリンクや特殊ファイルは公開しない（例: website/x -> / だとサーバーのファイルが外から読めてしまう）
while IFS= read -r odd; do
  problems+=("${odd#"$tmp"} は通常のファイルでもディレクトリでもない（リンクなど）")
done < <(find "$tmp" ! -type f ! -type d)
for f in index.html styles.css film.js; do
  [ -f "$tmp/$f" ] || problems+=("$f がない")
done
# ページから参照しているローカルのファイルがすべてあるか
while IFS= read -r html; do
  while IFS= read -r ref; do
    path=${ref%%[?#]*}
    [ -z "$path" ] && continue
    case "$path" in */) path="${path}index.html" ;; esac
    [ -e "$tmp$path" ] || problems+=("${html#"$tmp"} が参照する $ref がない")
  done < <(grep -oE '(href|src|data-src|poster|data-poster)="/[^"/][^"]*"|(href|src)="/"' "$html" | sed -E 's/^[a-z-]+="//; s/"$//' | sort -u)
done < <(find "$tmp" -name '*.html' -type f)
while IFS= read -r big; do
  problems+=("${big#"$tmp"} が大きすぎる（$MAX_FILE_BYTES バイト以上）")
done < <(find "$tmp" -type f -size "+$((MAX_FILE_BYTES - 1))c")
if [ "${#problems[@]}" -gt 0 ]; then
  for p in "${problems[@]}"; do log "検査NG: $p"; done
  hold_tree "$tree" "公開前の検査に失敗"
  die "公開前の検査に失敗したので公開しない（${commit:0:8}）"
fi

mv "$tmp" "releases/$id"
trap - EXIT
printf 'tree=%s\ncommit=%s\nprevious=%s\ndeployed_at=%s\n' "$tree" "$commit" "$current_id" "$(date -u +%FT%TZ)" >"releases/$id.meta"

# ---------------------------------------------------------------- 差し替え
printf 'id=%s\nprevious=%s\ntree=%s\n' "$id" "$current_id" "$tree" >.pending
trap 'log "確認の途中で止められた"; recover_pending; exit 143' TERM INT HUP
switch_to "$id"
log "公開: $id（${commit:0:8}）。前の版: ${current_id:-なし}"

# ---------------------------------------------------------------- 公開後の確認
healthy() {
  local resolve=() page ver
  [ -n "$HEALTH_RESOLVE" ] && resolve=(--resolve "$HEALTH_RESOLVE")
  page=$(curl -fsS --max-time 20 "${resolve[@]}" "$HEALTH_BASE_URL/") || return 1
  ver=$(grep -oE 'film\.js\?v=[0-9A-Za-z._-]+' "releases/$id/index.html" | head -n1)
  [ -n "$ver" ] && ! grep -qF "$ver" <<<"$page" && return 1
  curl -fsS --max-time 20 -o /dev/null "${resolve[@]}" "$HEALTH_BASE_URL/${ver:-film.js}" || return 1
  curl -fsS --max-time 20 -o /dev/null "${resolve[@]}" "$HEALTH_BASE_URL/styles.css" || return 1
}
ok=0
for _ in 1 2 3; do
  if healthy; then
    ok=1
    break
  fi
  sleep 3
done
if [ "$ok" != 1 ]; then
  log "公開後の確認に失敗"
  recover_pending # 前の版へ戻し、失敗した版は消して保留にする
  die "公開後の確認に失敗（${commit:0:8}）"
fi
rm -f .pending # 先に消す（trap を外す前に止められても、確認済みの版を戻さないように）
trap - TERM INT HUP
rm -f .hold
log "確認OK: $HEALTH_BASE_URL"

# ---------------------------------------------------------------- 古い版の整理（公開中と直前の版は必ず残す）
mapfile -t all < <(find releases -mindepth 1 -maxdepth 1 -type d ! -name '.tmp-*' -printf '%f\n' | sort)
excess=$((${#all[@]} - KEEP))
for old in "${all[@]}"; do
  [ "$excess" -le 0 ] && break
  [ "$old" = "$id" ] || [ "$old" = "$current_id" ] && continue
  rm -rf "releases/$old" # .meta は小さいので残す（rollback.sh が previous= をたどれるように）
  log "古い版を削除: $old"
  excess=$((excess - 1))
done
