#!/usr/bin/env bash
# File ONE GitHub Issue for a verified finding, with mechanical gates and a read-back check.
#   --run-dir DIR --title-file F --body-file F [--label bug] [--max 5] [--dry-run] [--repo owner/repo]
# The target repository comes from $RUN_DIR/manifest.json (a --repo that differs is refused), and
# live filing needs manifest filing_mode=live. Gates (any failure => nothing is created): title
# prefix/length/no #N/no 。, exactly one <!-- bug-sweep:fingerprint=<64hex> --> marker, structured
# redaction scan (known token formats, absolute paths on every platform, e-mail, nonce markers, long
# mixed tokens/hashes) => redaction_failed, label existence, fingerprint already on GitHub, per-run cap.
# Semantic duplicate checking is the operator's job; open bug titles are printed to help.
set -uo pipefail
RUN_DIR=""; TITLE_FILE=""; BODY_FILE=""; LABEL="bug"; MAX=5; DRY=0; REPO_ARG=""
while [ $# -gt 0 ]; do case "$1" in
  --run-dir) RUN_DIR="$2"; shift 2;;
  --title-file) TITLE_FILE="$2"; shift 2;;
  --body-file) BODY_FILE="$2"; shift 2;;
  --label) LABEL="$2"; shift 2;;
  --max) MAX="$2"; shift 2;;
  --dry-run) DRY=1; shift;;
  --repo) REPO_ARG="$2"; shift 2;;
  *) echo "unknown arg: $1" >&2; exit 64;; esac; done
[ -n "$RUN_DIR" ] && [ -f "$TITLE_FILE" ] && [ -f "$BODY_FILE" ] || { echo "--run-dir, --title-file, --body-file are required" >&2; exit 64; }
[ -f "$RUN_DIR/manifest.json" ] || { echo "manifest.json missing in $RUN_DIR" >&2; exit 64; }
REPO="$(node -p "JSON.parse(require('fs').readFileSync('$RUN_DIR/manifest.json','utf8')).repository || ''")"
FILING="$(node -p "JSON.parse(require('fs').readFileSync('$RUN_DIR/manifest.json','utf8')).filing_mode || 'report-only'")"
case "$REPO" in */*) ;; *) echo "manifest repository is not owner/repo: '$REPO'" >&2; exit 2;; esac
[ -z "$REPO_ARG" ] || [ "$REPO_ARG" = "$REPO" ] || { echo "--repo $REPO_ARG differs from manifest repository $REPO — refusing" >&2; exit 2; }
INDEX="$RUN_DIR/issues/index.json"; mkdir -p "$RUN_DIR/issues"; [ -f "$INDEX" ] || echo '[]' > "$INDEX"

title="$(head -1 "$TITLE_FILE" | tr -d '\r')"
errors=()
printf '%s' "$title" | grep -Eq '^\[(bug|test)\] ' || errors+=("title must start with '[bug] ' or '[test] '")
len="$(node -e 'console.log([...process.argv[1]].length)' "$title")"
{ [ "$len" -ge 25 ] && [ "$len" -le 70 ]; } || errors+=("title length $len chars, must be 25..70")
printf '%s' "$title" | grep -Eq '#[0-9]+' && errors+=("title contains an issue/PR number")
printf '%s' "$title" | grep -q '。' && errors+=("title contains 。")
n="$(grep -c '<!-- bug-sweep:fingerprint=' "$BODY_FILE")"
[ "$n" -eq 1 ] || errors+=("body must contain exactly one fingerprint marker (found $n)")
fp="$(sed -n 's/.*<!-- bug-sweep:fingerprint=\([0-9a-f]*\) -->.*/\1/p' "$BODY_FILE" | head -1)"
[ "${#fp}" -eq 64 ] || errors+=("fingerprint must be 64 hex chars (got '${fp}')")
# structured redaction scan (fail closed: any hit => redaction_failed)
redaction="$(node -e '
  const fs = require("fs");
  const title = fs.readFileSync(process.argv[1], "utf8");
  const body = fs.readFileSync(process.argv[2], "utf8").split("\n").filter((l) => !l.includes("bug-sweep:fingerprint=")).join("\n");
  const text = title + "\n" + body;
  const rules = [
    ["anthropic key", /sk-ant-[A-Za-z0-9_-]{8,}/],
    ["openai key", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}/],
    ["github token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
    ["slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
    ["aws access key", /\bAKIA[0-9A-Z]{16}\b/],
    ["google api key", /\bAIza[0-9A-Za-z_-]{30,}\b/],
    ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
    ["bearer header", /\bBearer\s+[A-Za-z0-9._-]{8,}/i],
    ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ["credential assignment", /\b(?:api[_-]?key|secret|token|password|passwd)\s*[:=]\s*["\x27]?[A-Za-z0-9_\-\/+=]{8,}/i],
    ["absolute path (unix)", /(?:^|[\s(`\x27"=])\/(?:Users|home|root|private|tmp|var|opt|etc|Volumes|mnt|srv)\//m],
    ["home path", /(?:^|[\s(`\x27"=])~\//m],
    ["absolute path (windows)", /\b[A-Za-z]:\\[^\s`\x27"]+/],
    ["e-mail address", /[\w.+-]+@[\w-]+\.[\w.-]+/],
    ["nonce-bearing marker", /SC_[A-Z_]+:[a-z]+:[0-9a-f]{6,}/],
    ["hex string >= 40", /\b[0-9a-f]{40,}\b/i],
  ];
  const hits = rules.filter(([, re]) => re.test(text)).map(([name]) => name);
  // Long mixed-case alphanumeric tokens look like secrets. A "/" does NOT exempt a token (Base64
  // and URL-embedded secrets contain "/"): the token is judged per path component, so a relative
  // evidence path like evidence/claude/stray-tee-from-RA-05 passes (short components) while a
  // 32+ char mixed-case component, or any 32+ char token carrying Base64 padding/plus, is flagged.
  const suspiciousComponent = (t) => t.length >= 32 && /[a-z]/.test(t) && /[A-Z]/.test(t) && /\d/.test(t) && !t.includes(".");
  for (const tok of text.match(/[A-Za-z0-9_\-+\/=]{32,}/g) ?? []) {
    if (/[+=]/.test(tok) && /[A-Za-z]/.test(tok) && /\d/.test(tok)) { hits.push("base64-like token"); break; }
    if (tok.split("/").some(suspiciousComponent)) { hits.push("long mixed-case token"); break; }
  }
  process.stdout.write(hits.join("; "));
' "$TITLE_FILE" "$BODY_FILE")"
[ -z "$redaction" ] || errors+=("redaction_failed: $redaction")
if [ -n "$LABEL" ]; then
  labels="$(gh label list --repo "$REPO" --limit 200 --json name --jq '.[].name' 2>/dev/null || true)"
  printf '%s\n' "$labels" | grep -qx -- "$LABEL" || errors+=("label '$LABEL' does not exist in $REPO (create it or pass --label '')")
fi
count="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).length)' "$INDEX")"
[ "$count" -lt "$MAX" ] || errors+=("per-run cap reached ($count/$MAX issues already created)")
if [ "${#errors[@]}" -gt 0 ]; then printf 'GATE FAILED:\n'; printf ' - %s\n' "${errors[@]}"; exit 2; fi

existing="$(gh issue list --repo "$REPO" --state all --limit 20 --search "bug-sweep:fingerprint=$fp" --json number,state,title,url 2>/dev/null)"
[ -n "$existing" ] || { echo "dedup_incomplete: gh issue list failed" >&2; exit 3; }
if [ "$(node -e 'console.log(JSON.parse(process.argv[1]).length)' "$existing")" != "0" ]; then
  echo "COLLISION: an issue with this fingerprint marker already exists — not filing"; echo "$existing"; exit 3
fi
echo "open bugs in $REPO (semantic duplicate check is yours):"
gh issue list --repo "$REPO" --state open --label "${LABEL:-bug}" --limit 50 --json number,title --jq '.[] | "  #\(.number) \(.title)"' 2>/dev/null || true

if [ "$DRY" = 1 ]; then echo "DRY RUN OK: repo=$REPO filing_mode=$FILING title='$title' fingerprint=$fp (nothing created)"; exit 0; fi
[ "$FILING" = "live" ] || { echo "blocked_authorization: manifest filing_mode=$FILING — live filing needs new-run.sh --filing live --authorized-by \"<request wording>\"" >&2; exit 6; }

url="$(gh issue create --repo "$REPO" --title "$title" --body-file "$BODY_FILE" ${LABEL:+--label "$LABEL"} 2>&1 | tail -1)"
num="${url##*/}"
case "$num" in ''|*[!0-9]*) echo "create failed: $url" >&2; exit 4;; esac
view="$(gh issue view "$num" --repo "$REPO" --json number,url,state,title,body,labels 2>/dev/null)"
node -e '
  const v=JSON.parse(process.argv[1]); const title=process.argv[2]; const label=process.argv[3];
  const problems=[];
  if(v.state!=="OPEN") problems.push("state "+v.state);
  if(v.title!==title) problems.push("title mismatch");
  if((v.body.match(/<!-- bug-sweep:fingerprint=/g)||[]).length!==1) problems.push("marker count");
  if(label && !v.labels.some(l=>l.name===label)) problems.push("label missing");
  if(problems.length){ console.error("READ-BACK FAILED: "+problems.join(", ")); process.exit(5); }
' "$view" "$title" "$LABEL" || exit 5
node -e '
  const fs=require("fs"); const [idx,view,fp,run]=process.argv.slice(1); const v=JSON.parse(view);
  const list=JSON.parse(fs.readFileSync(idx,"utf8"));
  list.push({fingerprint:fp, number:v.number, url:v.url, title:v.title, verified_at:new Date().toISOString(), run_dir:run});
  fs.writeFileSync(idx+".tmp", JSON.stringify(list,null,2)+"\n"); fs.renameSync(idx+".tmp", idx);
  console.log(JSON.stringify({created:v.number,url:v.url,state:v.state,fingerprint:fp}));
' "$INDEX" "$view" "$fp" "$RUN_DIR"
