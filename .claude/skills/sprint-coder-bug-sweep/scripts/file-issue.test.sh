#!/usr/bin/env bash
# Offline tests for the redaction gate of file-issue.sh (no gh, no network, nothing created).
#   bash file-issue.test.sh
# Every case runs the real script with --dry-run --label '' --max 0, so the per-run cap always fails
# the gate before gh is touched; the assertion is only what the redaction scan reported. Cases pass an
# expected reason ("long mixed-case token" …) or "clean", so a case can never pass for another rule's
# reason. Exit 0 when every case passes.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FILE_ISSUE="$SCRIPT_DIR/file-issue.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
RUN_DIR="$TMP/run"
mkdir -p "$RUN_DIR/evidence/claude" "$RUN_DIR/lanes/claude/workspace/smoke"
printf '{"repository":"Robbits-CO-LTD/sprint-coder","filing_mode":"report-only"}\n' > "$RUN_DIR/manifest.json"
printf 'evidence\n' > "$RUN_DIR/evidence/claude/x.md"
# a deep evidence path: whole token >= 32 with mixed case and digits, every component short
DEEP_REL="evidence/claude/run1/Shot2Beta/final"
mkdir -p "$RUN_DIR/$(dirname "$DEEP_REL")"; printf 'evidence\n' > "$RUN_DIR/$DEEP_REL"
# an existing file whose NAME is a long mixed token — existing must not whitelist it
LONGNAME_REL="evidence/claude/Shot1Aaaaaaaaaaaaaaaaaaaaaaaaaaaa.txt"
printf 'evidence\n' > "$RUN_DIR/$LONGNAME_REL"
# the subtree the tested AI writes into: never an exemption, even for short components
AI_REL="lanes/claude/workspace/smoke/Aa1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
printf 'written by the AI under test\n' > "$RUN_DIR/$AI_REL"
AI_DEEP_REL="lanes/claude/workspace/smoke/Aa1aaaaaaaaaaaaaaaaaaaa/BB2bbbbbbbbbbbbbbbbbbbb"
mkdir -p "$RUN_DIR/$(dirname "$AI_DEEP_REL")"; printf 'written by the AI under test\n' > "$RUN_DIR/$AI_DEEP_REL"
FP="$(printf 'bug-sweep-redaction-test' | shasum -a 256 | cut -d' ' -f1)"
TITLE="[bug] 秘匿スキャンの回帰テスト用ダミータイトル"
fails=0
pass() { printf '[PASS] %s\n' "$*"; }
fail() { printf '[FAIL] %s\n' "$*"; fails=$((fails+1)); }

# case_run <expected reason substring | clean> <name> <payload line placed in the body>
case_run() {
  local expect="$1" name="$2" payload="$3" out rc reason
  printf '%s\n' "$TITLE" > "$TMP/title.txt"
  { printf '## 事象\n\n%s\n\n' "$payload"; printf '<!-- bug-sweep:fingerprint=%s -->\n' "$FP"; } > "$TMP/body.md"
  out="$(bash "$FILE_ISSUE" --run-dir "$RUN_DIR" --title-file "$TMP/title.txt" --body-file "$TMP/body.md" \
    --label '' --max 0 --dry-run 2>&1)" && rc=0 || rc=$?
  if [ "$rc" != 2 ]; then fail "$name: expected the gate to fail with exit 2 (got $rc)"; printf '%s\n' "$out"; return 0; fi
  reason="$(printf '%s\n' "$out" | sed -n 's/.*redaction_failed: //p')"
  if [ "$expect" = clean ]; then
    [ -z "$reason" ] && pass "$name: not flagged" || fail "$name: expected clean, got redaction_failed: $reason"
  else
    case "$reason" in
      *"$expect"*) pass "$name: redaction_failed: $reason" ;;
      "") fail "$name: expected redaction_failed ($expect), gate stayed silent" ;;
      *) fail "$name: expected '$expect', got '$reason'" ;;
    esac
  fi
  return 0
}

# 1. the reviewer's case: a slash-containing token whose components are each < 32 chars
case_run 'long mixed-case token' 'slash token (each component < 32)' 'runtime id Aa1aaaaaaaaaaaaaaaaaaaa/BB2bbbbbbbbbbbbbbbbbbbb'
# 2. the previously covered case: one 32+ char mixed-case component
case_run 'long mixed-case token' 'single 32+ mixed-case token' 'value Aa1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb here'
# 3. Base64 padding / plus anywhere in the token
case_run 'base64-like token' 'base64-like token' 'blob AAAABBBBCCCCDDDDEEEEFFFFGGGG1111+abc= tail'
# 4. a relative path that really exists in the repo (the reviewer's example)
case_run clean 'existing repo path (short)' 'apps/desktop/src/main/ipc.ts の approvals ハンドラ'
# 5. a long existing repo path whose dotless prefix is 32+ chars and mixed-case
case_run clean 'existing repo path (long)' 'apps/desktop/src/renderer/components/RunCard.tsx を確認した'
# 6. a short evidence path under RUN_DIR
case_run clean 'existing evidence path under RUN_DIR' 'evidence/claude/x.md に保存した'
# 7. a deep existing evidence path: the whole token is long, but every component is short
case_run clean 'deep existing evidence path' "$DEEP_REL に保存した"
# 8. the same shape that does NOT exist must fail closed
case_run 'long mixed-case token' 'non-existent path-shaped token' 'evidence/claude/Shot9Zzzzzzzzzzzzzzzzzzzzzzzzzzzz'
# 9. existing does NOT whitelist a suspicious component (the file name itself is attacker controlled)
case_run 'long mixed-case token' 'existing file with a long mixed-case name' "$LONGNAME_REL に保存した"
# 10. RUN_DIR lanes/<lane>/workspace is written by the AI under test: no exemption at all
case_run 'long mixed-case token' 'AI-writable workspace path (component)' "$AI_REL を作った"
case_run 'long mixed-case token' 'AI-writable workspace path (whole token)' "$AI_DEEP_REL を作った"

printf '\n%s\n' "$([ "$fails" = 0 ] && echo 'ALL PASS' || echo "$fails FAILED")"
[ "$fails" = 0 ]
