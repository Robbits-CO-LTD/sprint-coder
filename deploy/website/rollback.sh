#!/usr/bin/env bash
# 公式サイトを、直前に公開していた版（または指定した版）へ戻す。
# 戻した版の tree は .hold に加え、タイマーがすぐ元へ戻さないようにする（何回続けて戻しても保留は残る）。
# main に直したコミットが入れば、その版は自動で公開される（.hold は tree が違えば効かない）。
#
#   rollback.sh            直前に公開していた版へ（releases/<版>.meta の previous=）
#   rollback.sh <版の名前>  releases/ の中の指定した版へ
set -euo pipefail

SITE_HOME=${SITE_HOME:-$HOME/sprintcoder.yuseilab.com}
log() { printf '[sprintcoder-rollback] %s\n' "$*"; }
meta() { sed -n "s/^$2=//p" "releases/$1.meta" 2>/dev/null || true; }
cd "$SITE_HOME"

exec 9>"$SITE_HOME/.deploy.lock"
flock 9

[ -L public ] || {
  log "public がシンボリックリンクではない"
  exit 1
}
current=$(basename "$(readlink public)")

target=${1:-}
if [ -z "$target" ]; then
  # 直前に公開していた版をたどる（整理で消えていれば、さらにその前へ）
  target=$(meta "$current" previous)
  steps=0
  while [ -n "$target" ] && [ ! -d "releases/$target" ]; do
    steps=$((steps + 1))
    [ "$steps" -gt 100 ] && target="" && break # 記録が循環していても止まるように
    target=$(meta "$target" previous)
  done
fi
if [ -z "$target" ] || [ ! -d "releases/$target" ]; then
  log "戻す先がない（公開中: $current）。残っている版: $(find releases -mindepth 1 -maxdepth 1 -type d ! -name '.tmp-*' -printf '%f ' | sort)"
  exit 1
fi

held_tree=$(meta "$current" tree)
ln -sfn "releases/$target" public.next
mv -Tf public.next public
if [ -z "$held_tree" ]; then
  log "注意: $current の記録（.meta）が無いので保留にできない。main が同じ中身ならタイマーが再公開する"
elif ! grep -qxF "tree=$held_tree" .hold 2>/dev/null; then
  printf 'tree=%s\n' "$held_tree" >>.hold
fi
log "戻した: $current → $target"
