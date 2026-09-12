#!/usr/bin/env bash
# Create a run directory for one bug-sweep and print its path.
# Layout: ~/.cache/sprint-coder-bug-sweep/<UTC>-<shortsha>/{manifest.json,e2e,lanes,issues,evidence}
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd "$SCRIPT_DIR/../../../.." && pwd)}"
BASE="${BUG_SWEEP_HOME:-$HOME/.cache/sprint-coder-bug-sweep}"
sha="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo nogit)"
run_id="$(date -u +%Y%m%dT%H%M%SZ)-$sha"
RUN_DIR="$BASE/$run_id"
mkdir -p "$RUN_DIR/e2e" "$RUN_DIR/lanes" "$RUN_DIR/issues" "$RUN_DIR/evidence"
full_sha="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
branch="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
dirty="$(git -C "$REPO_ROOT" status --short 2>/dev/null | wc -l | tr -d ' ')"
remote="$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null | sed -E 's#(git@github.com:|https://github.com/)##; s#\.git$##' || echo unknown)"
cat > "$RUN_DIR/manifest.json" <<JSON
{
  "schema_version": 1,
  "run_id": "$run_id",
  "repository": "$remote",
  "repository_root": "$REPO_ROOT",
  "source_sha": "$full_sha",
  "branch": "$branch",
  "dirty_files": $dirty,
  "filing_mode": "live",
  "fix_mode": "on",
  "lanes": ["claude", "codex"],
  "limits": { "max_issues_per_phase": 5 },
  "state": "init",
  "started_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "finished_at": null
}
JSON
printf '%s\n' "$RUN_DIR"
