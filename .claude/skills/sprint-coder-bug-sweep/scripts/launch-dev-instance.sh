#!/usr/bin/env bash
# Launch an isolated Sprint Coder dev instance for one real-AI lane and print its handle as JSON.
#   --run-dir DIR   --lane claude|codex|ollama   [--reuse-profile]   [--debug-port N]   [--repo-root DIR]
# The instance uses the repo's own Electron binary against apps/desktop, the :5173 dev server of this
# checkout, a fresh SPRINT_CODER_USER_DATA_DIR (own SQLite + single-instance lock), REAL CLIs (the E2E
# mock/fixture flags are explicitly unset) and SPRINT_CODER_E2E_BACKGROUND=1 (visible, never steals
# focus). Only the PID recorded in lanes/<lane>/app.pid is ever stopped by stop-dev-instance.sh.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd "$SCRIPT_DIR/../../../.." && pwd)}"
RUN_DIR=""; LANE=""; REUSE=0; DEBUG_PORT=""
while [ $# -gt 0 ]; do case "$1" in
  --run-dir) RUN_DIR="$2"; shift 2;;
  --lane) LANE="$2"; shift 2;;
  --reuse-profile) REUSE=1; shift;;
  --debug-port) DEBUG_PORT="$2"; shift 2;;
  --repo-root) REPO_ROOT="$2"; shift 2;;
  *) echo "unknown arg: $1" >&2; exit 64;; esac; done
[ -n "$RUN_DIR" ] && [ -n "$LANE" ] || { echo "--run-dir and --lane are required" >&2; exit 64; }
case "$LANE" in claude|codex|ollama) ;; *) echo "lane must be claude|codex|ollama" >&2; exit 64;; esac
DESKTOP_ROOT="$REPO_ROOT/apps/desktop"
LANE_DIR="$RUN_DIR/lanes/$LANE"; PROFILE="$LANE_DIR/profile"; WS="$LANE_DIR/workspace"
[ -x /opt/homebrew/opt/node@22/bin/node ] && export PATH="/opt/homebrew/opt/node@22/bin:$PATH"

# dev server must be this checkout's
pid="$(lsof -nP -iTCP:5173 -sTCP:LISTEN -Fp 2>/dev/null | sed -n 's/^p//p' | head -1)"
[ -n "$pid" ] || { echo "no dev server on :5173 — run ensure-dev-server.sh first" >&2; exit 3; }
cwd="$(lsof -p "$pid" -a -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
want="$(cd "$DESKTOP_ROOT" && pwd -P)"; have="$( [ -n "$cwd" ] && cd "$cwd" 2>/dev/null && pwd -P || echo '')"
[ "$have" = "$want" ] || { echo "dev server pid=$pid serves another checkout ($cwd) — blocked_artifact" >&2; exit 3; }
[ -f "$DESKTOP_ROOT/.vite/build/index.js" ] || { echo "main bundle missing: $DESKTOP_ROOT/.vite/build/index.js" >&2; exit 3; }

if [ -f "$LANE_DIR/app.pid" ] && kill -0 "$(cat "$LANE_DIR/app.pid")" 2>/dev/null; then
  echo "lane $LANE already has a running instance pid=$(cat "$LANE_DIR/app.pid"); stop it first" >&2; exit 4
fi
if [ -d "$PROFILE" ] && [ -n "$(ls -A "$PROFILE" 2>/dev/null)" ] && [ "$REUSE" != "1" ]; then
  echo "profile $PROFILE already exists; pass --reuse-profile to relaunch the same profile (restart-persistence case)" >&2; exit 4
fi
mkdir -p "$PROFILE" "$WS/smoke" "$LANE_DIR"
[ -f "$LANE_DIR/nonce" ] || openssl rand -hex 4 > "$LANE_DIR/nonce"
nonce="$(cat "$LANE_DIR/nonce")"
if [ ! -f "$WS/README.md" ]; then cat > "$WS/README.md" <<README
# bug-sweep workspace ($LANE)

Disposable fixture directory for one sprint-coder-bug-sweep lane. Contains no secrets and no source.
The AI under test may only create files under smoke/. Nothing here is part of any repository.
README
fi

rel="$(cat "$REPO_ROOT/node_modules/electron/path.txt")"
BIN="$REPO_ROOT/node_modules/electron/dist/$rel"
[ -x "$BIN" ] || { echo "dev Electron binary missing: $BIN" >&2; exit 3; }
: > "$LANE_DIR/app.log"
(
  cd "$REPO_ROOT" || exit 1
  env -u SPRINT_CODER_RUNTIME_ADOPT -u SPRINT_CODER_E2E_CLI_FIXTURES -u SPRINT_CODER_ALLOW_SIMULATED_TEAM_WORKERS \
      -u SPRINT_CODER_E2E_HIDDEN -u SPRINT_CODER_E2E_MODE -u SPRINT_CODER_LEADER_MCP -u SPRINT_CODER_REAL_WORKERS \
      SPRINT_CODER_USER_DATA_DIR="$PROFILE" SPRINT_CODER_SKILL_HOME="$PROFILE" SPRINT_CODER_E2E_BACKGROUND=1 \
      nohup "$BIN" ${DEBUG_PORT:+--remote-debugging-port=$DEBUG_PORT} "$DESKTOP_ROOT" >> "$LANE_DIR/app.log" 2>&1 &
  echo $! > "$LANE_DIR/app.pid"
)
apid="$(cat "$LANE_DIR/app.pid")"
sleep 6
if ! kill -0 "$apid" 2>/dev/null; then
  echo "instance exited early; tail of app.log:" >&2; tail -30 "$LANE_DIR/app.log" >&2; exit 1
fi
printf '{"lane":"%s","pid":%s,"profile":"%s","workspace":"%s","nonce":"%s","debug_port":%s,"app_log":"%s","bundle_id":"com.github.Electron","reused_profile":%s}\n' \
  "$LANE" "$apid" "$PROFILE" "$WS" "$nonce" "${DEBUG_PORT:-null}" "$LANE_DIR/app.log" "$([ "$REUSE" = 1 ] && echo true || echo false)"
