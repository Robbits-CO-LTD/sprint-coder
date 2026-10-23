#!/usr/bin/env bash
# サーバー（yusei）で 1 回実行する。再実行しても安全（スクリプトと unit の更新にも使う）。
#
#   scp -r deploy/website yusei:/tmp/sprintcoder-site-deploy
#   ssh yusei 'bash /tmp/sprintcoder-site-deploy/install.sh'
#
# - 今の public ディレクトリを releases/<日時>-legacy として取り込み、public をそのリンクにする
#   （この時点では表示は変わらない）
# - 今の assets/ の画像を legacy-assets/ に写す（古い SNS カードの画像リンクを切らないため）
# - deploy.sh / rollback.sh を ~/.local/lib/sprintcoder-site/ に置き、タイマーを有効にする
#   （main に入ったスクリプトがサーバーで勝手に動かないよう、スクリプトはここからだけ更新する）
#
# NO_ENABLE=1 を付けるとタイマーを有効にしない（導入だけ）。NO_SYSTEMD=1 は systemctl を一切呼ばない（試験用）。
set -euo pipefail

SRC=$(cd "$(dirname "$0")" && pwd)
SITE_HOME=${SITE_HOME:-$HOME/sprintcoder.yuseilab.com}
LIB=${LIB:-$HOME/.local/lib/sprintcoder-site}
UNITS=${UNITS:-$HOME/.config/systemd/user}
log() { printf '[sprintcoder-install] %s\n' "$*"; }
# ssh yusei '…' のような非対話の接続では設定されないので補う（無いと systemctl --user が失敗する）
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}

mkdir -p "$SITE_HOME/releases" "$SITE_HOME/legacy-assets" "$LIB" "$UNITS"
cd "$SITE_HOME"

exec 9>"$SITE_HOME/.deploy.lock"
flock 9

if [ -d public ] && [ ! -L public ]; then
  id="$(date -u +%Y%m%dT%H%M%SZ)-legacy"
  if [ -d public/assets ]; then
    for f in public/assets/*.png; do
      [ -f "$f" ] && [ ! -e "legacy-assets/${f##*/}" ] && cp "$f" legacy-assets/
    done
  fi
  mv public "releases/$id"
  printf 'tree=legacy\ncommit=none\ndeployed_at=%s\n' "$(date -u +%FT%TZ)" >"releases/$id.meta"
  ln -s "releases/$id" public
  log "既存の public を releases/$id に取り込み、public をリンクにした"
fi

install -m 0755 "$SRC/deploy.sh" "$LIB/deploy.sh"
install -m 0755 "$SRC/rollback.sh" "$LIB/rollback.sh"
install -m 0644 "$SRC/sprintcoder-site-deploy.service" "$UNITS/sprintcoder-site-deploy.service"
install -m 0644 "$SRC/sprintcoder-site-deploy.timer" "$UNITS/sprintcoder-site-deploy.timer"
[ "${NO_SYSTEMD:-0}" = 1 ] || systemctl --user daemon-reload
log "スクリプトと unit を配置した: $LIB, $UNITS"

if [ "${NO_ENABLE:-0}" != 1 ] && [ "${NO_SYSTEMD:-0}" != 1 ]; then
  systemctl --user enable --now sprintcoder-site-deploy.timer
  log "タイマーを有効にした（5 分おき）。すぐ反映するには: systemctl --user start sprintcoder-site-deploy"
  # ユーザーのタイマーは、linger が無効だとログアウト中は止まる（その間の main の更新は公開されない）
  if [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" != yes ]; then
    if loginctl enable-linger "$(id -un)" 2>/dev/null; then
      log "ログアウト中も動くよう linger を有効にした"
    else
      log "注意: linger が無効。ログアウト中はタイマーが止まる。管理者が sudo loginctl enable-linger $(id -un) を実行すること"
    fi
  fi
fi
