#!/usr/bin/env bash
# File ONE GitHub Issue for a verified finding, with mechanical gates and a read-back check.
#   --run-dir DIR --title-file F --body-file F [--label bug] [--max 5] [--dry-run] [--repo owner/repo]
# Gates (any failure => nothing is created): title prefix/length/no #N/no 。, exactly one
# <!-- bug-sweep:fingerprint=<64hex> --> marker, privacy patterns, fingerprint already on GitHub,
# per-run cap from issues/index.json. Semantic duplicate checking is the operator's job; the script
# prints open bug titles to help. --dry-run runs every gate and the dedup search but creates nothing.
set -uo pipefail
RUN_DIR=""; TITLE_FILE=""; BODY_FILE=""; LABEL="bug"; MAX=5; DRY=0; REPO=""
while [ $# -gt 0 ]; do case "$1" in
  --run-dir) RUN_DIR="$2"; shift 2;;
  --title-file) TITLE_FILE="$2"; shift 2;;
  --body-file) BODY_FILE="$2"; shift 2;;
  --label) LABEL="$2"; shift 2;;
  --max) MAX="$2"; shift 2;;
  --dry-run) DRY=1; shift;;
  --repo) REPO="$2"; shift 2;;
  *) echo "unknown arg: $1" >&2; exit 64;; esac; done
[ -n "$RUN_DIR" ] && [ -f "$TITLE_FILE" ] && [ -f "$BODY_FILE" ] || { echo "--run-dir, --title-file, --body-file are required" >&2; exit 64; }
[ -n "$REPO" ] || REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null)"
[ -n "$REPO" ] || { echo "cannot resolve repository (gh repo view)" >&2; exit 2; }
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
for pat in 'sk-ant-' 'ghp_[A-Za-z0-9]' 'gho_[A-Za-z0-9]' 'Bearer [A-Za-z0-9._-]' 'api[_-]?key *[:=]' '/Users/[A-Za-z0-9._-]+/' 'AKIA[0-9A-Z]{12}' 'xox[baprs]-' 'SC_[A-Z_]+:[a-z]+:[0-9a-f]{6,}' '-----BEGIN'; do
  grep -Eiq -- "$pat" "$BODY_FILE" "$TITLE_FILE" && errors+=("privacy pattern matched in title/body: $pat")
done
count="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).length)' "$INDEX")"
[ "$count" -lt "$MAX" ] || errors+=("per-run cap reached ($count/$MAX issues already created)")
if [ "${#errors[@]}" -gt 0 ]; then printf 'GATE FAILED:\n'; printf ' - %s\n' "${errors[@]}"; exit 2; fi

# fingerprint collision on GitHub (marker match = collision candidate, operator decides)
existing="$(gh issue list --repo "$REPO" --state all --limit 20 --search "bug-sweep:fingerprint=$fp" --json number,state,title,url 2>/dev/null)"
if [ -z "$existing" ]; then echo "dedup_incomplete: gh issue list failed" >&2; exit 3; fi
if [ "$(node -e 'console.log(JSON.parse(process.argv[1]).length)' "$existing")" != "0" ]; then
  echo "COLLISION: an issue with this fingerprint marker already exists — not filing"; echo "$existing"; exit 3
fi
echo "open bugs (semantic duplicate check is yours):"
gh issue list --repo "$REPO" --state open --label "$LABEL" --limit 50 --json number,title --jq '.[] | "  #\(.number) \(.title)"' 2>/dev/null || true

if [ "$DRY" = 1 ]; then echo "DRY RUN OK: title='$title' fingerprint=$fp (nothing created)"; exit 0; fi

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
