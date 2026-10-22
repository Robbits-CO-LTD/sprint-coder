#!/usr/bin/env bash
# 公式サイトを 1 つ前の版（または指定した版）へ戻す。
# 戻した版の tree は .hold に記録し、タイマーがすぐ元へ戻さないようにする。
# main に直したコミットが入れば、その版は自動で公開される（.hold は tree が違えば効かない）。
#
#   rollback.sh            1 つ前の版へ
#   rollback.sh <版の名前>  releases/ の中の指定した版へ
set -euo pipefail

SITE_HOME=${SITE_HOME:-$HOME/sprintcoder.yuseilab.com}
log() { printf '[sprintcoder-rollback] %s\n' "$*"; }
cd "$SITE_HOME"

exec 9>"$SITE_HOME/.deploy.lock"
flock 9

[ -L public ] || {
  log "public がシンボリックリンクではない"
  exit 1
}
current=$(basename "$(readlink public)")
mapfile -t all < <(find releases -mindepth 1 -maxdepth 1 -type d ! -name '.tmp-*' -printf '%f\n' | sort)

target=${1:-}
if [ -z "$target" ]; then
  for i in "${!all[@]}"; do
    if [ "${all[$i]}" = "$current" ] && [ "$i" -gt 0 ]; then target=${all[$((i - 1))]}; fi
  done
fi
[ -n "$target" ] && [ -d "releases/$target" ] || {
  log "戻す先がない（公開中: $current、版: ${all[*]}）"
  exit 1
}

held_tree=$(sed -n 's/^tree=//p' "releases/$current.meta" 2>/dev/null || true)
ln -sfn "releases/$target" public.next
mv -Tf public.next public
if [ -n "$held_tree" ]; then
  printf 'tree=%s\nreason=rollback.sh で %s から戻した\n' "$held_tree" "$current" >.hold
fi
log "戻した: $current → $target"
