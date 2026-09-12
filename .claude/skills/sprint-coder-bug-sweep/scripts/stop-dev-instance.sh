#!/usr/bin/env bash
# Stop only what this run launched.
#   --run-dir DIR --lane NAME      stop the lane's app instance (SIGTERM; no SIGKILL unless --force)
#   --run-dir DIR --dev-server     stop the `npm start` recorded in dev-server.pid (whole process tree)
# A PID is only signalled if its command line still looks like the process we started; otherwise the
# script reports cleanup_hold and leaves it alone. Never touches other checkouts' processes.
set -uo pipefail
RUN_DIR=""; LANE=""; DEV=0; FORCE=0; WAIT=20
while [ $# -gt 0 ]; do case "$1" in
  --run-dir) RUN_DIR="$2"; shift 2;;
  --lane) LANE="$2"; shift 2;;
  --dev-server) DEV=1; shift;;
  --force) FORCE=1; shift;;
  --wait) WAIT="$2"; shift 2;;
  *) echo "unknown arg: $1" >&2; exit 64;; esac; done
[ -n "$RUN_DIR" ] || { echo "--run-dir is required" >&2; exit 64; }

term_tree() { # SIGTERM children first, then the pid
  local p="$1" c
  for c in $(pgrep -P "$p" 2>/dev/null); do term_tree "$c"; done
  kill -TERM "$p" 2>/dev/null || true
}
wait_gone() { local p="$1" i=0; while kill -0 "$p" 2>/dev/null && [ "$i" -lt "$WAIT" ]; do sleep 1; i=$((i+1)); done; ! kill -0 "$p" 2>/dev/null; }

status=0
if [ -n "$LANE" ]; then
  f="$RUN_DIR/lanes/$LANE/app.pid"
  if [ -f "$f" ]; then
    p="$(cat "$f")"
    cmd="$(ps -p "$p" -o command= 2>/dev/null || true)"
    if [ -z "$cmd" ]; then echo "{\"lane\":\"$LANE\",\"result\":\"already_gone\",\"pid\":$p}"
    elif [[ "$cmd" == *"node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"* ]]; then
      kill -TERM "$p" 2>/dev/null || true
      if wait_gone "$p"; then echo "{\"lane\":\"$LANE\",\"result\":\"cleanup_complete\",\"pid\":$p}"
      elif [ "$FORCE" = 1 ]; then kill -KILL "$p" 2>/dev/null; sleep 1; echo "{\"lane\":\"$LANE\",\"result\":\"force_killed\",\"pid\":$p}"
      else echo "{\"lane\":\"$LANE\",\"result\":\"cleanup_hold\",\"pid\":$p,\"reason\":\"still alive ${WAIT}s after SIGTERM; not force-killed\"}"; status=5; fi
    else echo "{\"lane\":\"$LANE\",\"result\":\"cleanup_hold\",\"pid\":$p,\"reason\":\"pid no longer looks like our Electron instance; left alone\"}"; status=5; fi
  else echo "{\"lane\":\"$LANE\",\"result\":\"no_pid_file\"}"; fi
fi
if [ "$DEV" = 1 ]; then
  f="$RUN_DIR/dev-server.pid"
  if [ -f "$f" ]; then
    p="$(cat "$f")"
    cmd="$(ps -p "$p" -o command= 2>/dev/null || true)"
    if [ -z "$cmd" ]; then echo "{\"dev_server\":\"already_gone\",\"pid\":$p}"
    elif [[ "$cmd" == *"npm start"* || "$cmd" == *"electron-forge"* ]]; then
      term_tree "$p"
      if wait_gone "$p"; then echo "{\"dev_server\":\"cleanup_complete\",\"pid\":$p}"
      else echo "{\"dev_server\":\"cleanup_hold\",\"pid\":$p}"; status=5; fi
    else echo "{\"dev_server\":\"cleanup_hold\",\"pid\":$p,\"reason\":\"pid does not look like our npm start; left alone\"}"; status=5; fi
  else echo "{\"dev_server\":\"not_owned\"}"; fi
fi
exit $status
