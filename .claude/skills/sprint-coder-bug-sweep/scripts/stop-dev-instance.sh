#!/usr/bin/env bash
# Stop only what this run launched, and only after proving the PID is still the same process.
#   --run-dir DIR --lane NAME      stop the lane's app instance recorded in lanes/<lane>/app.json
#   --run-dir DIR --dev-server     stop the `npm start` recorded in dev-server.json (whole tree)
# Identity = pid + process start time (ps lstart) + full command line, all captured at launch. A
# reused PID or a different command line yields cleanup_hold and no signal. SIGTERM only; --force
# (SIGKILL) still requires the identity match. Never touches other checkouts' processes.
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

term_tree() { local p="$1" c; for c in $(pgrep -P "$p" 2>/dev/null); do term_tree "$c"; done; kill -TERM "$p" 2>/dev/null || true; }
wait_gone() { local p="$1" i=0; while kill -0 "$p" 2>/dev/null && [ "$i" -lt "$WAIT" ]; do sleep 1; i=$((i+1)); done; ! kill -0 "$p" 2>/dev/null; }
identity_matches() { # json-file pid → 0 if ps lstart+command equal the recorded ones
  local file="$1" pid="$2" now
  now="$(ps -p "$pid" -o lstart=,command= 2>/dev/null || true)"
  [ -n "$now" ] || return 2
  node -e '
    const rec = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const now = process.argv[2]; const lstart = now.slice(0, 24).trim(); const command = now.slice(24).trim();
    process.exit(rec.lstart === lstart && rec.command === command ? 0 : 1);
  ' "$file" "$now"
}
stop_one() { # label json-file tree(0|1)
  local label="$1" file="$2" tree="$3" pid rc
  [ -f "$file" ] || { echo "{\"$label\":\"no_record\"}"; return 0; }
  pid="$(node -p "JSON.parse(require('fs').readFileSync('$file','utf8')).pid")"
  identity_matches "$file" "$pid"; rc=$?
  if [ "$rc" = 2 ]; then echo "{\"$label\":\"already_gone\",\"pid\":$pid}"; return 0; fi
  if [ "$rc" != 0 ]; then echo "{\"$label\":\"cleanup_hold\",\"pid\":$pid,\"reason\":\"pid identity (start time / command) differs from the recorded launch; not signalled\"}"; return 5; fi
  if [ "$tree" = 1 ]; then term_tree "$pid"; else kill -TERM "$pid" 2>/dev/null || true; fi
  if wait_gone "$pid"; then echo "{\"$label\":\"cleanup_complete\",\"pid\":$pid}"; return 0; fi
  if [ "$FORCE" = 1 ] && identity_matches "$file" "$pid"; then kill -KILL "$pid" 2>/dev/null; sleep 1; echo "{\"$label\":\"force_killed\",\"pid\":$pid}"; return 0; fi
  echo "{\"$label\":\"cleanup_hold\",\"pid\":$pid,\"reason\":\"still alive ${WAIT}s after SIGTERM; not force-killed\"}"; return 5
}
status=0
if [ -n "$LANE" ]; then stop_one "lane_$LANE" "$RUN_DIR/lanes/$LANE/app.json" 0 || status=$?; fi
if [ "$DEV" = 1 ]; then stop_one "dev_server" "$RUN_DIR/dev-server.json" 1 || status=$?; fi
exit $status
