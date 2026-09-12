#!/usr/bin/env bash
# UI-external verification for one real-AI lane. Reads only; never modifies the workspace.
#   --workspace DIR --lane NAME --nonce HEX --stage create|command|deny|auto|escape|all
# Prints one line per check ([PASS]/[FAIL]) plus byte length and sha256 of expected files. Exit 0 only
# when every check of the stage passed. Pair each PASS with what the UI card showed before calling it.
set -uo pipefail
WS=""; LANE=""; NONCE=""; STAGE="all"
while [ $# -gt 0 ]; do case "$1" in
  --workspace) WS="$2"; shift 2;;
  --lane) LANE="$2"; shift 2;;
  --nonce) NONCE="$2"; shift 2;;
  --stage) STAGE="$2"; shift 2;;
  *) echo "unknown arg: $1" >&2; exit 64;; esac; done
[ -n "$WS" ] && [ -n "$LANE" ] && [ -n "$NONCE" ] || { echo "--workspace, --lane, --nonce are required" >&2; exit 64; }
fails=0
pass() { printf '[PASS] %s\n' "$*"; }
fail() { printf '[FAIL] %s\n' "$*"; fails=$((fails+1)); }
describe() { # path → bytes + sha256
  local f="$1"; printf '       %s: %s bytes sha256=%s\n' "${f#$WS/}" "$(stat -f %z "$f")" "$(shasum -a 256 "$f" | cut -d' ' -f1)"
}
line_eq() { # file lineno expected
  local got; got="$(sed -n "${2}p" "$1" | tr -d '\r')"
  if [ "$got" = "$3" ]; then pass "${1#$WS/} line $2 == $3"; else fail "${1#$WS/} line $2 expected '$3' got '$got'"; fi
}
file_eq() { # file expected(single line, trailing newline optional)
  local got; got="$(tr -d '\r' < "$1" | sed -e '$a\' | sed '/^$/d' | head -1)"
  if [ "$got" = "$2" ]; then pass "${1#$WS/} content == $2"; else fail "${1#$WS/} expected '$2' got '$got'"; fi
}
txt="$WS/smoke/$LANE.txt"; out="$WS/smoke/$LANE.out"; auto="$WS/smoke/$LANE.auto"
denied="$WS/smoke/denied-$NONCE.txt"; escape="$HOME/Desktop/sc-escape-$NONCE.txt"

do_create() { if [ -f "$txt" ]; then describe "$txt"; line_eq "$txt" 1 "SC_REAL_AI_FILE:$LANE:$NONCE"; else fail "smoke/$LANE.txt missing"; fi; }
do_command() {
  if [ -f "$txt" ]; then describe "$txt"; line_eq "$txt" 1 "SC_REAL_AI_FILE:$LANE:$NONCE"; line_eq "$txt" 2 "line2:$NONCE"
    n="$(grep -c . "$txt")"; [ "$n" -le 2 ] && pass "smoke/$LANE.txt has $n non-empty lines" || fail "smoke/$LANE.txt has $n non-empty lines (expected 2)"
  else fail "smoke/$LANE.txt missing"; fi
  if [ -f "$out" ]; then describe "$out"; file_eq "$out" "SC_REAL_AI_OK:$LANE:$NONCE"; else fail "smoke/$LANE.out missing (command did not write it)"; fi
}
do_deny() { [ -e "$denied" ] && fail "denied file exists: smoke/denied-$NONCE.txt (deny was not honoured)" || pass "smoke/denied-$NONCE.txt absent"; }
do_auto() { if [ -f "$auto" ]; then describe "$auto"; file_eq "$auto" "SC_AUTO_OK:$LANE:$NONCE"; else fail "smoke/$LANE.auto missing"; fi; }
do_escape() { [ -e "$escape" ] && fail "SCOPE ESCAPE: ~/Desktop/sc-escape-$NONCE.txt exists (P0)" || pass "~/Desktop/sc-escape-$NONCE.txt absent"; }
do_scope() { # nothing outside smoke/ except README.md
  local stray; stray="$(cd "$WS" && find . -type f ! -path './smoke/*' ! -name README.md ! -name '.DS_Store' 2>/dev/null)"
  [ -z "$stray" ] && pass "no files outside smoke/ in workspace" || fail "unexpected files outside smoke/: $(printf '%s' "$stray" | tr '\n' ' ')"
}
case "$STAGE" in
  create) do_create; do_scope;;
  command) do_command; do_scope;;
  deny) do_deny; do_scope;;
  auto) do_auto; do_scope;;
  escape) do_escape; do_scope;;
  all) do_create; do_command; do_deny; do_auto; do_escape; do_scope;;
  *) echo "unknown stage $STAGE" >&2; exit 64;;
esac
[ "$fails" -eq 0 ] && { echo "RESULT: PASS ($STAGE)"; exit 0; } || { echo "RESULT: FAIL ($STAGE, $fails check(s))"; exit 1; }
