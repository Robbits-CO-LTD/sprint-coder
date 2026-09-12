#!/usr/bin/env bash
# Phase 0 preflight for sprint-coder-bug-sweep.
# Binds the checkout, the :5173 dev server, native prerequisites, CLIs and GitHub. Starts and stops
# nothing. Prints [OK]/[WARN]/[BLOCK] lines; with RUN_DIR set, also writes preflight.txt/json there.
# Exit 0 = no blockers, 2 = at least one [BLOCK].
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd "$SCRIPT_DIR/../../../.." && pwd)}"
DESKTOP_ROOT="$REPO_ROOT/apps/desktop"
RUN_DIR="${RUN_DIR:-}"
LINES=()
blockers=0; warnings=0; lane_claude="unknown"; lane_codex="unknown"
ok()    { LINES+=("[OK]    $*");    printf '[OK]    %s\n' "$*"; }
warn()  { LINES+=("[WARN]  $*");    printf '[WARN]  %s\n' "$*"; warnings=$((warnings+1)); }
block() { LINES+=("[BLOCK] $*");    printf '[BLOCK] %s\n' "$*"; blockers=$((blockers+1)); }
lane()  { LINES+=("[LANE]  $*");    printf '[LANE]  %s\n' "$*"; }   # per-lane availability; never a global blocker
filing_mode="report-only"; real_ai="off"
if [ -n "$RUN_DIR" ] && [ -f "$RUN_DIR/manifest.json" ]; then
  filing_mode="$(node -p "JSON.parse(require('fs').readFileSync('$RUN_DIR/manifest.json','utf8')).filing_mode || 'report-only'")"
  real_ai="$(node -p "JSON.parse(require('fs').readFileSync('$RUN_DIR/manifest.json','utf8')).real_ai || 'off'")"
fi

# 1. repository
if git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  sha="$(git -C "$REPO_ROOT" rev-parse HEAD)"; branch="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)"
  dirty="$(git -C "$REPO_ROOT" status --short | wc -l | tr -d ' ')"
  ok "repo $REPO_ROOT branch=$branch sha=$sha dirty_files=$dirty"
  [ "$dirty" != "0" ] && warn "working tree has $dirty modified/untracked paths; a finding is bound to HEAD only if it also reproduces on a clean tree"
else
  block "not a git repository: $REPO_ROOT"
fi

# 2. node
node_v="$(node --version 2>/dev/null || echo none)"
case "$node_v" in
  v22.*) ok "node $node_v on PATH" ;;
  *) if [ -x /opt/homebrew/opt/node@22/bin/node ]; then
       warn "node on PATH is $node_v but the repo requires 22.x; scripts prepend /opt/homebrew/opt/node@22/bin (for manual commands: export PATH=/opt/homebrew/opt/node@22/bin:\$PATH)"
     else
       block "node on PATH is $node_v and no node@22 found (brew install node@22)"
     fi ;;
esac

# 3. native prerequisites (same checks as tests/e2e/helpers.ts warnAboutUnbuiltDevNativePrerequisites)
fix='npm run prepare:desktop --workspace @sprint-coder/desktop'
addon="$DESKTOP_ROOT/native-safe-fs/build/Release/sprint_coder_native_safe_fs.node"
runner="$DESKTOP_ROOT/sandbox-runner/build/Release/sprint-coder-sandbox-runner"
sqlite="$REPO_ROOT/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
gypi="$REPO_ROOT/node_modules/better-sqlite3/build/config.gypi"
[ -f "$addon" ]  && ok "native-safe-fs addon present" || block "native-safe-fs addon missing (manual file editor cannot save) — fix: $fix"
[ -x "$runner" ] && ok "sandbox-runner present"       || block "sandbox-runner missing (run_command approvals never appear) — fix: $fix"
if [ -f "$sqlite" ]; then
  ev="$(node -p "require('$REPO_ROOT/node_modules/electron/package.json').version" 2>/dev/null || echo '')"
  if [ -f "$gypi" ]; then
    tgt="$(grep -o '"target": *"[^"]*"' "$gypi" | head -1 | sed -E 's/.*"([^"]*)"$/\1/')"
    if [ -n "$tgt" ] && [ -n "$ev" ] && [ "$tgt" = "$ev" ]; then ok "better-sqlite3 built for Electron $ev"
    else block "better-sqlite3 target='$tgt' but Electron='$ev' (main-process init aborts; every spec times out in firstWindow) — fix: $fix"; fi
  else ok "better-sqlite3 present (prebuilt; ABI not verifiable from config.gypi)"; fi
else
  block "better-sqlite3 addon missing — fix: $fix"
fi

# 4. dev Electron binary + main bundle
rel="$(cat "$REPO_ROOT/node_modules/electron/path.txt" 2>/dev/null || true)"
bin="$REPO_ROOT/node_modules/electron/dist/$rel"
if [ -n "$rel" ] && [ -x "$bin" ]; then ok "dev Electron binary: node_modules/electron/dist/$rel"
else block "dev Electron binary missing — run: node node_modules/electron/install.js"; fi
mb="$DESKTOP_ROOT/.vite/build/index.js"
if [ -f "$mb" ]; then ok "dev main bundle present (built $(date -r "$mb" '+%Y-%m-%d %H:%M'))"
else warn "dev main bundle apps/desktop/.vite/build/index.js missing; npm start (or E2E globalSetup) builds it"; fi

# 4b. Vite optimize cache vs workspace packages (stale cache => black renderer, every spec times out)
vcache="$(ls -t "$DESKTOP_ROOT"/node_modules/.vite/deps/@sprint-coder_contracts*.js 2>/dev/null | head -1)"
if [ -n "$vcache" ] && [ -f "$vcache" ]; then
  newest_src="$(find "$REPO_ROOT/packages/contracts/src" "$REPO_ROOT/packages/domain/src" -name '*.ts' -newer "$vcache" 2>/dev/null | head -1)"
  if [ -n "$newest_src" ]; then block "Vite optimize cache apps/desktop/node_modules/.vite/deps is OLDER than workspace package sources (e.g. ${newest_src#$REPO_ROOT/}) — the dev renderer will throw 'does not provide an export named …' and every spec times out. Fix: rm -rf apps/desktop/node_modules/.vite node_modules/.vite, then (re)start the dev server"
  else ok "Vite optimize cache is newer than packages/contracts and packages/domain sources"; fi
else ok "no Vite optimize cache yet (first dev server start will build it)"; fi

# 5. dev server on :5173 — must belong to THIS checkout
pid="$(lsof -nP -iTCP:5173 -sTCP:LISTEN -Fp 2>/dev/null | sed -n 's/^p//p' | head -1)"
if [ -z "$pid" ]; then
  ok "port 5173 is free — E2E globalSetup / ensure-dev-server.sh will start npm start and own it"
else
  cwd="$(lsof -p "$pid" -a -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
  want="$(cd "$DESKTOP_ROOT" 2>/dev/null && pwd -P)"
  have="$( [ -n "$cwd" ] && cd "$cwd" 2>/dev/null && pwd -P || echo '')"
  if [ -n "$have" ] && [ "$have" = "$want" ]; then ok "dev server pid=$pid serves this checkout ($cwd)"
  else block "dev server pid=$pid on :5173 serves ANOTHER checkout: ${cwd:-unknown} — E2E dev mode and launch-dev-instance.sh would mix this repo's main bundle with that renderer. Do not kill it; ask the user to stop it, or run the sweep from that checkout."; fi
fi

# 6. CLIs (read-only probes; no billing). A missing/unauthenticated CLI blocks only ITS lane
#    (Phase 1 mock E2E and the other lane still run) — recorded as [LANE], not [BLOCK].
if command -v claude >/dev/null 2>&1; then
  cv="$(claude --version 2>/dev/null | head -1)"
  cauth="$(claude auth status 2>/dev/null || true)"
  if printf '%s' "$cauth" | grep -q '"loggedIn": *true'; then lane_claude="ok"; lane "claude: ok ($cv logged in)"
  else lane_claude="blocked_auth"; lane "claude: blocked_auth ($cv not logged in — the user must run: claude auth login)"; fi
else lane_claude="blocked_missing"; lane "claude: blocked_missing (claude CLI not on PATH)"; fi
if command -v codex >/dev/null 2>&1; then
  cxv="$(codex --version 2>/dev/null | head -1)"
  cxauth="$(codex login status 2>&1 || true)"
  if printf '%s' "$cxauth" | grep -qi 'logged in'; then lane_codex="ok"; lane "codex: ok ($cxv logged in)"
  else lane_codex="blocked_auth"; lane "codex: blocked_auth ($cxv not logged in — the user must run: codex login)"; fi
else lane_codex="blocked_missing"; lane "codex: blocked_missing (codex CLI not on PATH)"; fi
if [ "$real_ai" = "on" ] && [ "$lane_claude" != "ok" ] && [ "$lane_codex" != "ok" ]; then
  warn "real_ai=on but neither CLI lane is available — Phase 3 will be BLOCKED for both lanes (Phase 1 still runs)"
fi

# 7. GitHub
if gh auth status >/dev/null 2>&1; then
  repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || echo unknown)"
  ok "gh authenticated; repo $repo"
  labels="$(gh label list --limit 200 --json name --jq '.[].name' 2>/dev/null || true)"
  if printf '%s\n' "$labels" | grep -qx bug; then ok "label 'bug' exists"
  elif [ "$filing_mode" = "live" ]; then block "label 'bug' missing and filing_mode=live — file-issue.sh requires it; create the label (gh label create bug) or file with --label ''"
  else warn "label 'bug' missing (filing_mode=$filing_mode; would block a live run)"; fi
else
  block "gh is not authenticated (gh auth login)"
fi

# 8. Playwright inventory (does not launch the app)
total="$(cd "$REPO_ROOT" && SPRINT_CODER_E2E_MODE=dev npx playwright test --list 2>/dev/null | tail -1)"
if [ -n "$total" ]; then ok "playwright: $total"; else warn "playwright --list failed (npm ci?)"; fi

# 9. optional Ollama lane
if curl -s --max-time 2 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  n="$(curl -s --max-time 2 http://127.0.0.1:11434/api/tags | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).models.length))" 2>/dev/null || echo '?')"
  ok "ollama reachable ($n models) — optional lane available"
else warn "ollama not reachable — optional Ollama lane unavailable"; fi

# 10. things that must not be targeted
if pgrep -f '/Applications/Sprint Coder.app/Contents/MacOS/Sprint Coder' >/dev/null 2>&1; then
  warn "packaged Sprint Coder (com.electron.sprint-coder) is running — NOT the target; grant Computer Use to 'Electron' (com.github.Electron) and act only on the window this run launches"
fi
other="$(pgrep -fl 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron' 2>/dev/null | grep -v "$REPO_ROOT" | wc -l | tr -d ' ')"
[ "$other" != "0" ] && warn "$other dev Electron process(es) from other checkouts are running — they share bundle id com.github.Electron; use the before/after window inventory to find the owned window"

printf '\nblockers=%s warnings=%s lanes: claude=%s codex=%s\n' "$blockers" "$warnings" "$lane_claude" "$lane_codex"
if [ -n "$RUN_DIR" ]; then
  mkdir -p "$RUN_DIR"
  printf '%s\n' "${LINES[@]}" > "$RUN_DIR/preflight.txt"
  node -e '
    const fs=require("fs"); const lines=fs.readFileSync(process.argv[1],"utf8").trim().split("\n");
    const items=lines.map(l=>{const m=/^\[(OK|WARN|BLOCK)\]\s+(.*)$/.exec(l); return m?{level:m[1],message:m[2]}:{level:"?",message:l};});
    fs.writeFileSync(process.argv[2], JSON.stringify({checked_at:new Date().toISOString(), blockers:Number(process.argv[3]), warnings:Number(process.argv[4]),
      filing_mode:process.argv[5], real_ai:process.argv[6], lanes:{claude:process.argv[7], codex:process.argv[8]}, items},null,2)+"\n");
  ' "$RUN_DIR/preflight.txt" "$RUN_DIR/preflight.json" "$blockers" "$warnings" "$filing_mode" "$real_ai" "$lane_claude" "$lane_codex"
fi
[ "$blockers" -eq 0 ] && exit 0 || exit 2
