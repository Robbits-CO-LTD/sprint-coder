#!/usr/bin/env bash
# Launch an isolated Sprint Coder dev instance for one real-AI lane and print its handle as JSON.
#   --run-dir DIR --lane claude|codex|ollama [--reuse-profile] [--debug-port N] [--repo-root DIR]
# Requires manifest.json real_ai=on (raised by new-run.sh --real-ai on --authorized-by ...): a lane
# sends prompts to a real, billed CLI. The instance uses the repo's own Electron binary against
# apps/desktop, this checkout's :5173 dev server, an isolated SPRINT_CODER_USER_DATA_DIR, real CLIs
# (E2E mock/fixture flags explicitly unset) and SPRINT_CODER_E2E_BACKGROUND=1 (visible, never steals
# focus). Identity (pid + start time + command) is written to lanes/<lane>/app.json for
# stop-dev-instance.sh. With --debug-port the port must be free beforehand, and the DevTools browser
# id printed by THIS launch is bound to the listening pid in lanes/<lane>/debug.json for seed-instance.mjs.
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
[ -f "$RUN_DIR/manifest.json" ] || { echo "manifest.json missing in $RUN_DIR (use new-run.sh)" >&2; exit 64; }
real_ai="$(node -p "JSON.parse(require('fs').readFileSync('$RUN_DIR/manifest.json','utf8')).real_ai ?? 'off'")"
[ "$real_ai" = "on" ] || { echo "blocked_authorization: manifest real_ai=$real_ai — real lanes bill the user's CLIs; create the run with new-run.sh --real-ai on --authorized-by \"<request wording>\"" >&2; exit 6; }
DESKTOP_ROOT="$REPO_ROOT/apps/desktop"
LANE_DIR="$RUN_DIR/lanes/$LANE"; PROFILE="$LANE_DIR/profile"; WS="$LANE_DIR/workspace"
[ -x /opt/homebrew/opt/node@22/bin/node ] && export PATH="/opt/homebrew/opt/node@22/bin:$PATH"

# dev server must be this checkout's
pid="$(lsof -nP -iTCP:5173 -sTCP:LISTEN -Fp 2>/dev/null | sed -n 's/^p//p' | head -1)"
[ -n "$pid" ] || { echo "no dev server on :5173 — run ensure-dev-server.sh first" >&2; exit 3; }
cwd="$(lsof -p "$pid" -a -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
want="$(cd "$DESKTOP_ROOT" && pwd -P)"; have="$( [ -n "$cwd" ] && cd "$cwd" 2>/dev/null && pwd -P || echo '')"
[ "$have" = "$want" ] || { echo "dev server pid=$pid serves another checkout ($cwd) — blocked_artifact" >&2; exit 3; }
for b in index.js preload.js; do [ -f "$DESKTOP_ROOT/.vite/build/$b" ] || { echo "dev bundle missing: apps/desktop/.vite/build/$b" >&2; exit 3; }; done

if [ -f "$LANE_DIR/app.json" ]; then
  old="$(node -p "JSON.parse(require('fs').readFileSync('$LANE_DIR/app.json','utf8')).pid")"
  kill -0 "$old" 2>/dev/null && { echo "lane $LANE already has a running instance pid=$old; stop it first" >&2; exit 4; }
fi
if [ -d "$PROFILE" ] && [ -n "$(ls -A "$PROFILE" 2>/dev/null)" ] && [ "$REUSE" != "1" ]; then
  echo "profile $PROFILE already exists; pass --reuse-profile to relaunch the same profile (restart-persistence case)" >&2; exit 4
fi
if [ -n "$DEBUG_PORT" ]; then
  busy="$(lsof -nP -iTCP:"$DEBUG_PORT" -sTCP:LISTEN -Fp 2>/dev/null | sed -n 's/^p//p' | head -1)"
  [ -z "$busy" ] || { echo "debug port $DEBUG_PORT is already in use by pid $busy — refusing (a seed would bind to a foreign instance)" >&2; exit 7; }
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
launched_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
marker="==== bug-sweep launch $launched_at lane=$LANE reuse=$REUSE ===="
printf '%s\n' "$marker" >> "$LANE_DIR/app.log"     # append: earlier turns' stderr is evidence, never truncated
(
  cd "$REPO_ROOT" || exit 1
  # exec so the subshell PID becomes the Electron main process (env -> nohup -> Electron all exec in place)
  exec env -u SPRINT_CODER_RUNTIME_ADOPT -u SPRINT_CODER_E2E_CLI_FIXTURES -u SPRINT_CODER_ALLOW_SIMULATED_TEAM_WORKERS \
      -u SPRINT_CODER_E2E_HIDDEN -u SPRINT_CODER_E2E_MODE -u SPRINT_CODER_LEADER_MCP -u SPRINT_CODER_REAL_WORKERS \
      SPRINT_CODER_USER_DATA_DIR="$PROFILE" SPRINT_CODER_SKILL_HOME="$PROFILE" SPRINT_CODER_E2E_BACKGROUND=1 \
      nohup "$BIN" ${DEBUG_PORT:+--remote-debugging-port=$DEBUG_PORT} "$DESKTOP_ROOT" >> "$LANE_DIR/app.log" 2>&1 < /dev/null
) &
apid=$!
sleep 6
if ! kill -0 "$apid" 2>/dev/null; then
  echo "instance exited early; tail of app.log:" >&2; tail -30 "$LANE_DIR/app.log" >&2; exit 1
fi
identity="$(ps -p "$apid" -o lstart=,command= 2>/dev/null || true)"
node -e '
  const [out, pid, identity, profile, ws, debug, launched, repo, reuse] = process.argv.slice(1);
  const lstart = identity.slice(0, 24).trim(); const command = identity.slice(24).trim();
  require("fs").writeFileSync(out, JSON.stringify({ pid: Number(pid), lstart, command, profile, workspace: ws,
    debug_port: debug ? Number(debug) : null, launched_at: launched, repo_root: repo, reused_profile: reuse === "1",
    bundle_id: "com.github.Electron" }, null, 2) + "\n");
' "$LANE_DIR/app.json" "$apid" "$identity" "$PROFILE" "$WS" "$DEBUG_PORT" "$launched_at" "$REPO_ROOT" "$REUSE"

browser_id=null
if [ -n "$DEBUG_PORT" ]; then
  for _ in $(seq 1 20); do
    bid="$(awk -v m="$marker" '$0==m{f=1;next} f' "$LANE_DIR/app.log" | grep -o "DevTools listening on ws://127.0.0.1:$DEBUG_PORT/devtools/browser/[0-9a-f-]*" | tail -1 | sed 's#.*/browser/##')"
    [ -n "$bid" ] && break; sleep 1
  done
  lpid="$(lsof -nP -iTCP:"$DEBUG_PORT" -sTCP:LISTEN -Fp 2>/dev/null | sed -n 's/^p//p' | head -1)"
  if [ -z "$bid" ] || [ "$lpid" != "$apid" ]; then
    echo "debug endpoint could not be bound to this launch (browser_id='$bid', listener pid='$lpid', app pid=$apid); stopping the instance" >&2
    kill -TERM "$apid" 2>/dev/null; exit 8
  fi
  printf '{"port":%s,"browser_id":"%s","pid":%s,"launched_at":"%s"}\n' "$DEBUG_PORT" "$bid" "$apid" "$launched_at" > "$LANE_DIR/debug.json"
  browser_id="\"$bid\""
fi
printf '{"lane":"%s","pid":%s,"profile":"%s","workspace":"%s","nonce":"%s","debug_port":%s,"browser_id":%s,"app_log":"%s","bundle_id":"com.github.Electron","reused_profile":%s}\n' \
  "$LANE" "$apid" "$PROFILE" "$WS" "$nonce" "${DEBUG_PORT:-null}" "$browser_id" "$LANE_DIR/app.log" "$([ "$REUSE" = 1 ] && echo true || echo false)"
