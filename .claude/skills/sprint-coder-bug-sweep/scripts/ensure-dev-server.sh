#!/usr/bin/env bash
# Make sure a Vite dev server for THIS checkout is listening on :5173 (same contract as the E2E
# globalSetup): reuse one that belongs to this checkout, refuse one from another checkout, otherwise
# start `npm start` and record it as owned in $RUN_DIR/dev-server.json (pid + start time + command).
# Note: `npm start` (electron-forge start) also opens its own app window with the developer's default
# profile — that window is NOT a test target. Take the Computer Use window inventory AFTER this script.
# Two runs must not race for :5173, and a listener that appears while we wait is only OURS when its
# process descends from the pid we started: a start is serialized by a mkdir lock next to the run dir,
# and readiness requires both `kill -0 <our pid>` and a parent chain from the listener to it.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd "$SCRIPT_DIR/../../../.." && pwd)}"
RUN_DIR=""; TIMEOUT=120; RENDERER_ONLY=0
while [ $# -gt 0 ]; do case "$1" in
  --run-dir) RUN_DIR="$2"; shift 2;;
  --repo-root) REPO_ROOT="$2"; shift 2;;
  --timeout) TIMEOUT="$2"; shift 2;;
  --renderer-only) RENDERER_ONLY=1; shift;;
  *) echo "unknown arg: $1" >&2; exit 64;; esac; done
[ -n "$RUN_DIR" ] && [ -d "$RUN_DIR" ] || { echo "--run-dir must be an existing run directory" >&2; exit 64; }
DESKTOP_ROOT="$REPO_ROOT/apps/desktop"
BUILD="$DESKTOP_ROOT/.vite/build"
[ -x /opt/homebrew/opt/node@22/bin/node ] && export PATH="/opt/homebrew/opt/node@22/bin:$PATH"

listening_pid() { lsof -nP -iTCP:5173 -sTCP:LISTEN -Fp 2>/dev/null | sed -n 's/^p//p' | head -1; }
term_tree() { local p="$1" c; for c in $(pgrep -P "$p" 2>/dev/null); do term_tree "$c"; done; kill -TERM "$p" 2>/dev/null || true; }
# Is $1 the process we started ($2), or one of its descendants? (`ps -o ppid=` walk, depth capped.)
descends_from() {
  local p="$1" want="$2" i=0
  while [ -n "$p" ] && [ "$p" != "0" ] && [ "$p" != "1" ] && [ "$i" -lt 32 ]; do
    [ "$p" = "$want" ] && return 0
    p="$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')"
    i=$((i + 1))
  done
  return 1
}
# Our listener only if the process we started is alive AND the listener descends from it.
ours() { [ -n "$1" ] && kill -0 "$2" 2>/dev/null && descends_from "$1" "$2"; }
LOCK="$(cd "$(dirname "$RUN_DIR")" && pwd)/.dev-server.lock"
lock_held=0
release_lock() { [ "$lock_held" = 1 ] && rm -rf "$LOCK"; lock_held=0; }
acquire_lock() {   # mkdir is atomic; a lock whose owner died is reclaimed once
  local tries=0
  while [ "$tries" -lt 2 ]; do
    if mkdir "$LOCK" 2>/dev/null; then printf '%s\n' "$$" > "$LOCK/pid"; lock_held=1; trap 'release_lock' EXIT INT TERM; return 0; fi
    local owner; owner="$(cat "$LOCK/pid" 2>/dev/null | tr -d ' ')"
    if [ -z "$owner" ] || ! kill -0 "$owner" 2>/dev/null; then rm -rf "$LOCK"; tries=$((tries + 1)); continue; fi
    printf '{"owned":false,"status":"blocked_artifact","reason":"another bug-sweep run (pid %s) is starting a dev server; wait for it or stop that run","lock":"%s"}\n' "$owner" "$LOCK"
    exit 3
  done
  printf '{"owned":false,"status":"blocked_artifact","reason":"could not take the dev-server start lock","lock":"%s"}\n' "$LOCK"
  exit 3
}
want="$(cd "$DESKTOP_ROOT" && pwd -P)"
pid="$(listening_pid)"
if [ -n "$pid" ]; then
  cwd="$(lsof -p "$pid" -a -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
  have="$( [ -n "$cwd" ] && cd "$cwd" 2>/dev/null && pwd -P || echo '')"
  if [ "$have" = "$want" ]; then
    lcmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    case "$lcmd" in
      *electron-forge*) lmode="forge" ;;
      *vite*) lmode="renderer-only" ;;
      *) lmode="unknown" ;;
    esac
    if [ "$RENDERER_ONLY" = 1 ] && [ "$lmode" != "renderer-only" ]; then
      # A forge `npm start` keeps its own Electron window alive; reusing it would leave a second
      # com.github.Electron process and the lane window would be unreachable for app_* tools.
      printf '{"owned":false,"pid":%s,"cwd":"%s","mode":"%s","status":"blocked_artifact","reason":"an existing %s dev server holds :5173; renderer-only needs it stopped first (stop-dev-instance.sh --dev-server if this run owns it, otherwise ask the user)"}\n' "$pid" "$cwd" "$lmode" "$lmode"
      exit 3
    fi
    printf '{"owned":false,"pid":%s,"cwd":"%s","mode":"%s","status":"reused"}\n' "$pid" "$cwd" "$lmode"; exit 0
  fi
  printf '{"owned":false,"pid":%s,"cwd":"%s","status":"blocked_artifact","reason":"dev server on :5173 belongs to another checkout; not killed"}\n' "$pid" "${cwd:-unknown}"
  exit 3
fi

started_at="$(date +%s)"
acquire_lock
if [ "$RENDERER_ONLY" = 1 ]; then
  # Computer Use lanes: `npm start` (electron-forge) also opens its own Electron window, and the app_*
  # tools address only ONE process per bundle id (com.github.Electron), so the lane window would be
  # unreachable. Serve just the renderer with Vite (same :5173 the built main bundle expects) and keep
  # the main/preload/runtime-host bundles a previous `npm start` already built.
  for b in index.js preload.js; do [ -f "$BUILD/$b" ] || { echo "renderer-only needs a previous npm start build: missing apps/desktop/.vite/build/$b" >&2; exit 3; }; done
  ( cd "$DESKTOP_ROOT" && exec nohup npx vite --config vite.renderer.config.ts --port 5173 --strictPort --host localhost > "$RUN_DIR/dev-server.log" 2>&1 < /dev/null ) &
  npid=$!
  sleep 1
  identity="$(ps -p "$npid" -o lstart=,command= 2>/dev/null || true)"
  node -e '
    const [out, pid, identity, started] = process.argv.slice(1);
    const lstart = identity.slice(0, 24).trim(); const command = identity.slice(24).trim();
    require("fs").writeFileSync(out, JSON.stringify({ owned: true, mode: "renderer-only", pid: Number(pid), lstart, command, started_at: started }, null, 2) + "\n");
  ' "$RUN_DIR/dev-server.json" "$npid" "$identity" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  deadline=$((started_at + TIMEOUT))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    p="$(listening_pid)"
    if [ -n "$p" ] && ! ours "$p" "$npid"; then
      printf '{"owned":false,"pid":%s,"status":"blocked_artifact","reason":"a dev server that does not descend from our npx vite (pid %s) took :5173 — another run owns it; not killed"}\n' "$p" "$npid" >&2
      term_tree "$npid"; exit 3
    fi
    if ours "$p" "$npid" && curl -s -o /dev/null --max-time 2 http://localhost:5173/; then
      printf '{"owned":true,"mode":"renderer-only","pid":%s,"npx_pid":%s,"cwd":"%s","status":"started","log":"%s"}\n' "$p" "$npid" "$DESKTOP_ROOT" "$RUN_DIR/dev-server.log"; exit 0
    fi
    if ! kill -0 "$npid" 2>/dev/null; then echo "vite exited early; tail of log:" >&2; tail -20 "$RUN_DIR/dev-server.log" >&2; term_tree "$npid"; exit 1; fi
    sleep 2
  done
  echo "renderer dev server did not become ready within ${TIMEOUT}s; stopping it" >&2; term_tree "$npid"; exit 1
fi
prev_main="$( [ -f "$BUILD/index.js" ] && stat -f %m "$BUILD/index.js" || echo 0 )"
prev_preload="$( [ -f "$BUILD/preload.js" ] && stat -f %m "$BUILD/preload.js" || echo 0 )"
# exec inside the subshell so $! is npm itself (not a wrapper shell that stop-dev-instance.sh cannot match)
( cd "$REPO_ROOT" && exec nohup npm start > "$RUN_DIR/dev-server.log" 2>&1 < /dev/null ) &
npid=$!
sleep 1
identity="$(ps -p "$npid" -o lstart=,command= 2>/dev/null || true)"
node -e '
  const [out, pid, identity, started] = process.argv.slice(1);
  const lstart = identity.slice(0, 24).trim(); const command = identity.slice(24).trim();
  require("fs").writeFileSync(out, JSON.stringify({ owned: true, pid: Number(pid), lstart, command, started_at: started }, null, 2) + "\n");
' "$RUN_DIR/dev-server.json" "$npid" "$identity" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

deadline=$((started_at + TIMEOUT))
while [ "$(date +%s)" -lt "$deadline" ]; do
  p="$(listening_pid)"
  if [ -n "$p" ] && ! ours "$p" "$npid"; then
    printf '{"owned":false,"pid":%s,"status":"blocked_artifact","reason":"a dev server that does not descend from our npm start (pid %s) took :5173 — another run owns it; not killed"}\n' "$p" "$npid" >&2
    term_tree "$npid"; exit 3
  fi
  if ours "$p" "$npid" && [ -f "$BUILD/index.js" ] && [ -f "$BUILD/preload.js" ] \
     && [ "$(stat -f %m "$BUILD/index.js")" -gt "$prev_main" ] && [ "$(stat -f %m "$BUILD/preload.js")" -gt "$prev_preload" ]; then
    sleep 3
    printf '{"owned":true,"pid":%s,"npm_pid":%s,"cwd":"%s","status":"started","runtime_host_bundle":%s,"log":"%s"}\n' \
      "$p" "$npid" "$DESKTOP_ROOT" "$([ -f "$BUILD/runtime-host.js" ] && echo true || echo false)" "$RUN_DIR/dev-server.log"; exit 0
  fi
  if ! kill -0 "$npid" 2>/dev/null; then
    echo "npm start exited early; tail of log:" >&2; tail -20 "$RUN_DIR/dev-server.log" >&2
    term_tree "$npid"; exit 1
  fi
  sleep 2
done
echo "dev server did not become ready within ${TIMEOUT}s; stopping the owned npm start (log: $RUN_DIR/dev-server.log)" >&2
term_tree "$npid"; sleep 2
exit 1
