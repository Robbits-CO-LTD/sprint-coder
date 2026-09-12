#!/usr/bin/env bash
# Make sure a Vite dev server for THIS checkout is listening on :5173 (the same contract as the E2E
# globalSetup): reuse one that already belongs to this checkout, refuse one from another checkout,
# otherwise start `npm start` in the background and record it as owned in $RUN_DIR/dev-server.pid.
# Note: `npm start` (electron-forge start) also opens its own app window with the developer's default
# profile — that window is NOT a test target. Take the Computer Use window inventory AFTER this script.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd "$SCRIPT_DIR/../../../.." && pwd)}"
RUN_DIR=""; TIMEOUT=120
while [ $# -gt 0 ]; do case "$1" in
  --run-dir) RUN_DIR="$2"; shift 2;;
  --repo-root) REPO_ROOT="$2"; shift 2;;
  --timeout) TIMEOUT="$2"; shift 2;;
  *) echo "unknown arg: $1" >&2; exit 64;; esac; done
[ -n "$RUN_DIR" ] || { echo "--run-dir is required" >&2; exit 64; }
DESKTOP_ROOT="$REPO_ROOT/apps/desktop"
[ -x /opt/homebrew/opt/node@22/bin/node ] && export PATH="/opt/homebrew/opt/node@22/bin:$PATH"

listening_pid() { lsof -nP -iTCP:5173 -sTCP:LISTEN -Fp 2>/dev/null | sed -n 's/^p//p' | head -1; }
pid="$(listening_pid)"
want="$(cd "$DESKTOP_ROOT" && pwd -P)"
if [ -n "$pid" ]; then
  cwd="$(lsof -p "$pid" -a -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
  have="$( [ -n "$cwd" ] && cd "$cwd" 2>/dev/null && pwd -P || echo '')"
  if [ "$have" = "$want" ]; then
    printf '{"owned":false,"pid":%s,"cwd":"%s","status":"reused"}\n' "$pid" "$cwd"; exit 0
  fi
  printf '{"owned":false,"pid":%s,"cwd":"%s","status":"blocked_artifact","reason":"dev server on :5173 belongs to another checkout; not killed"}\n' "$pid" "${cwd:-unknown}"
  exit 3
fi

mkdir -p "$RUN_DIR"
started_at="$(date +%s)"
( cd "$REPO_ROOT" && nohup npm start > "$RUN_DIR/dev-server.log" 2>&1 & echo $! > "$RUN_DIR/dev-server.pid" )
npid="$(cat "$RUN_DIR/dev-server.pid")"
deadline=$((started_at + TIMEOUT))
while [ "$(date +%s)" -lt "$deadline" ]; do
  p="$(listening_pid)"
  if [ -n "$p" ] && [ -f "$DESKTOP_ROOT/.vite/build/index.js" ] && [ "$(stat -f %m "$DESKTOP_ROOT/.vite/build/index.js")" -ge "$started_at" ]; then
    sleep 3
    printf '{"owned":true,"pid":%s,"npm_pid":%s,"cwd":"%s","status":"started","log":"%s"}\n' "$p" "$npid" "$DESKTOP_ROOT" "$RUN_DIR/dev-server.log"; exit 0
  fi
  if ! kill -0 "$npid" 2>/dev/null; then
    echo "npm start exited early; tail of log:" >&2; tail -20 "$RUN_DIR/dev-server.log" >&2; exit 1
  fi
  sleep 2
done
echo "dev server did not become ready within ${TIMEOUT}s (log: $RUN_DIR/dev-server.log)" >&2; exit 1
