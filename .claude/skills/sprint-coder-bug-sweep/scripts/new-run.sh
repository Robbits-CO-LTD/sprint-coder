#!/usr/bin/env bash
# Create a run directory for one bug-sweep and print its path.
# Every mode defaults to the safest value. Raise a mode ONLY with an explicit flag that mirrors
# explicit wording in the CURRENT user request, and quote that wording with --authorized-by:
#   --filing report-only|live   default report-only (no GitHub Issue is ever created)
#   --fix off|on                default off (no fix branch, PR, or merge)
#   --real-ai off|on            default off (no real Claude/Codex CLI turn, no billing)
#   --lanes claude,codex[,ollama]
#   --authorized-by TEXT        required when any mode is raised
# Scripts read these modes from manifest.json and fail closed (file-issue.sh, launch-dev-instance.sh).
# The run id carries a random suffix and the directory is created exclusively.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd "$SCRIPT_DIR/../../../.." && pwd)}"
BASE="${BUG_SWEEP_HOME:-$HOME/.cache/sprint-coder-bug-sweep}"
FILING=report-only; FIX=off; REAL_AI=off; LANES="claude,codex"; AUTH=""
while [ $# -gt 0 ]; do case "$1" in
  --filing) FILING="$2"; shift 2;;
  --fix) FIX="$2"; shift 2;;
  --real-ai) REAL_AI="$2"; shift 2;;
  --lanes) LANES="$2"; shift 2;;
  --authorized-by) AUTH="$2"; shift 2;;
  *) echo "unknown arg: $1" >&2; exit 64;; esac; done
case "$FILING" in report-only|live) ;; *) echo "--filing must be report-only|live" >&2; exit 64;; esac
case "$FIX" in off|on) ;; *) echo "--fix must be off|on" >&2; exit 64;; esac
case "$REAL_AI" in off|on) ;; *) echo "--real-ai must be off|on" >&2; exit 64;; esac
if { [ "$FILING" != report-only ] || [ "$FIX" != off ] || [ "$REAL_AI" != off ]; } && [ -z "$AUTH" ]; then
  echo "--authorized-by \"<quoted request wording>\" is required when raising --filing/--fix/--real-ai" >&2; exit 64
fi
sha="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo nogit)"
run_id="$(date -u +%Y%m%dT%H%M%SZ)-$sha-$(openssl rand -hex 3)"
RUN_DIR="$BASE/$run_id"
mkdir -p "$BASE"
mkdir "$RUN_DIR"   # exclusive: a collision is an error, never a shared directory
mkdir "$RUN_DIR/e2e" "$RUN_DIR/lanes" "$RUN_DIR/issues" "$RUN_DIR/evidence"
full_sha="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
branch="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
dirty="$(git -C "$REPO_ROOT" status --short 2>/dev/null | wc -l | tr -d ' ')"
remote="$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null | sed -E 's#(git@github.com:|https://github.com/)##; s#\.git$##' || echo unknown)"
node -e '
  const [out, run_id, repository, repository_root, source_sha, branch, dirty, filing, fix, real_ai, lanes, auth] = process.argv.slice(1);
  const manifest = { schema_version: 2, run_id, repository, repository_root, source_sha, branch, dirty_files: Number(dirty),
    filing_mode: filing, fix_mode: fix, real_ai, authorized_by: auth || null, lanes: lanes.split(",").filter(Boolean),
    limits: { max_issues_per_phase: 5 }, state: "init", started_at: new Date().toISOString(), finished_at: null };
  require("fs").writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
' "$RUN_DIR/manifest.json" "$run_id" "$remote" "$REPO_ROOT" "$full_sha" "$branch" "$dirty" "$FILING" "$FIX" "$REAL_AI" "$LANES" "$AUTH"
printf '%s\n' "$RUN_DIR"
