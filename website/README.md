# Sprint Coder official website

Static source for <https://sprintcoder.yuseilab.com/>.

Sprint Coder and this website are developed, owned, and managed by
[Robbits Inc.](https://robbits.co.jp/). The `yuseilab.com` subdomain is used as
the hosting domain.

## Local preview

From the repository root:

```bash
python3 -m http.server 4174 --directory website
```

Open <http://127.0.0.1:4174/>. There is no build step and no dependency.

## Deploy

Merging a change under `website/` into `main` publishes it automatically within
about five minutes: a timer on the web server pulls `main`, checks the files and
switches the site (see `deploy/website/README.md`). There is nothing to upload
by hand.

## How the homepage works

The homepage is a scroll-driven "film" of **one real run**: on 2026-10-23 a
single request built a 100-member AI team in Sprint Coder (leader 1 +
managers 9 + workers 90; Claude 50, Codex 49, one on-device model), up to 93 of
them were running at the same time, and the workers drew the 90 pictures of an
「AI ずかん」. Every screen is either a recording of that run or a figure drawn
from its run log. Chapter 05 is the earlier 2026-10-20 run (6 at once) and shows
the build → check → redo loop.

| no | id | title | what it shows |
|---|---|---|---|
| 00 | `top` | 序章 | 「本当に動かした 100体のAIチーム」 over the real card wall, the 93 / 50·49·1 / 90 / 26分 cards |
| 01 | `ch-hire` | 招集 | the real request, the real hiring, the hiring order drawn from the log (about 4 min fast-forwarded), 「約4分で 100体のチーム」 |
| 02 | `ch-mix` | 混成 | Claude 50 · Codex 49 · this PC 1 with the models, the real limit setting (100), the real AI-selection guidance |
| 03 | `ch-run` | 稼働 | the real wall (44 running), the 93 meter and the per-second curve, a worker card close-up, the on-device worker, the 25-minute replay (dots glow while running and turn into the drawing when done) |
| 04 | `ch-done` | 完成 | the leader's real final report, the 90 drawings in completion order, 100 / 93 / 90 / 26分 |
| 05 | `ch-check` | 確認 | the 2026-10-20 run: build, check, redo, re-check, 9 tests passed |
| 06 | `ch-safe` | 安心 | four cards |
| 07 | `start` | 始動 | downloads and both full videos (outside the film) |

Each chapter is a `.scene` (a tall wrapper with a sticky `.stage`). `film.js`
turns the scroll position inside a scene into `--p` (0–1) and counts how many of
the thresholds in `data-steps="0.1,0.4"` have been passed. Any element with
`data-show="2"` (step 2 onward) or `data-show="1-3"` (steps 1–3) gets `.on`
while that step is active, and `styles.css` animates it. `data-range="a,b"`
exposes a local 0–1 value as `--r`; when `--r` reaches 1 the element gets
`.is-full`. In the stacked layout (`.fit-off`) every range is shown at its end
state (`--r: 1`), and without JavaScript the CSS default is `--r: 1` too. Scene
videos load when the scene is near and play only while visible. The fixed
`.player` bar shows chapters, auto-play (scrolls the page like a video), sound
(synthesised BGM, off by default) and the full 2:32 video in a `<dialog>`.

More hooks used by the homepage:

- `data-count="100" data-from="1" data-pad="3"` — a number that counts from
  `data-from` to `data-count` with the `--r` of its nearest `[data-range]`.
- `data-values="0,3,9,…"` — shows the value at `--r` from a list sampled from the
  run log (written by `tools/make-hundred.py`). `data-clock="1495"` shows
  `m:ss` of `--r × 1495` seconds. The HTML holds the end value, so without JS it
  reads the final number.
- `data-count-intro="100"` — the opening count-up (000 → 100). It runs only
  when `film.js` starts before 1.5 s after navigation and motion is not stopped.
- `.scene[data-real]` — a chapter of a real run. While the player is in one,
  `.player.is-real` shows 「実演 · 2026年10月23日 · 実際のアプリと実際のAI」 (short
  form 「実演 10/23」 at 1100 px and below). A chapter of the other run sets
  `data-real-label` / `data-real-short` (05: 「実演 · 2026年10月20日 · 6体の回」).
  `data-real-from="3"` delays the label to that step.
- `[data-open-promo="promo-100"]` opens the `<dialog class="modal">` with that
  id (no value: `#promo-modal`, the 4:02 video of the 10-20 run).
- `.focus` — a frame over a recording (`--x --y --w --fh` measured in the
  recording's pixels), used for the on-device worker's card in 03.
- The head script adds `.motion-off` before first paint when 「動きを止める」 was
  chosen earlier, so the opening animation never starts.

### Figures drawn from the run log (`tools/make-hundred.py`)

Never hand-edit the hiring chart, the 25-minute replay, the 93 curve or the
mosaic. `py -I website/tools/make-hundred.py` rewrites the HTML between the
`<!-- h100:hire -->`, `h100:run`, `h100:curve` and `h100:mosaic` markers in
`index.html` from `tools/data/run100.json` (the run log, exported from a copy of
the app's database) and `tools/data/zukan.json` (which worker drew which
picture), and writes `assets/run100-curve-v1.svg` (colours baked in, for `<img>`
on `/ai-team/`). Both data files and the drawings in `assets/zukan-v1/` are
copies from the promo project (private repository
`yusei531642/sprintcoder-promo-100ai`, commit `22cd317`). The drawings are the
SVGs the worker AIs wrote in the run (15 of them recoloured by the leader at the
end), used as `<img>`, with no script.

- Hiring: each dot appears when `--r` passes its hire time (`--h`, 0 = send,
  1 = last hire at 4:16). Running: dots light between `--s` and `--e` (start and
  end of the execution over 24:55) and turn into the worker's drawing at `--e`.
- Workers 1–5 of each department are the left column, 6–10 the right column,
  as in the plan (Claude left, Codex right; the astronaut is the on-device one).
- 「実行中」 counts executions in `running` (it includes the wait for the app to
  merge a worker's result, which took about 20 minutes one at a time).

### Figure label (`.tag-fig`)

Every figure drawn from the log carries a `.tag-fig` 「図 · 実演の記録から作図」
with the fast-forward (「約4分を早送り」「25分を早送り」) on the same screen — same
size and place as `.rec`, but with a grey, non-blinking dot and a dashed border.
Recording labels (`.rec`) and figure labels never sit on the same picture.

Subpages use the same design system (`.page-hero` with a looping clip, cards,
`.reel` blocks with clips, a `.details` section with the technical text).
`/ai-team/#scale` shows the curve as the static `assets/run100-curve-v1.svg`
inside a `.fig` box with its own `.tag-fig`.

With `prefers-reduced-motion: reduce`, scenes render as normal stacked sections,
nothing autoplays and every clip shows its poster frame (the full videos are
still playable in the dialogs). When a chapter does not fit the pinned stage
(short screens such as 375x667, zoomed text), `film.js` adds `.fit-off` and the
chapters stack the same way. Every page also has a 「動きを止める」 button that
pauses all clips. Without JavaScript all text is still in the HTML; the header
gets a solid background and the footage shows the poster frames as CSS
backgrounds.

## Production constraints (CSP)

The live site sends
`default-src 'self'; script-src 'self' 'unsafe-inline' …; style-src 'self'; img-src 'self' data:; font-src 'self'`.

- Never write `style=""` attributes or `<style>` blocks. Per-element values go in
  `data-style="--fx: 40%; --len: 300vh"`; `film.js` applies them through CSSOM.
- No third-party CSS or fonts. The Japanese font is a self-hosted subset of Noto
  Sans JP (SIL OFL 1.1): rebuild it with `py -I website/tools/make-font.py`
  after changing copy, or new characters fall back to the system font.
- Bump `?v=` on `styles.css` / `film.js` in every page when either changes.
- `/assets/` is cached as immutable for 7 days: give a changed image a new
  filename. Treat `/media/` the same way.

## Media (`media/`)

`c100-*.mp4` and `promo100.mp4` come from the 2026-10-23 run: the recordings
attached to release v1 of the promo project (`run.mp4`, `settings.mp4`,
`final.mp4`; the app's window only, captured through the Chrome DevTools
screencast, so no other windows or notifications are in frame). The source
table — recording, start, length, crop — is `tools/make-media-100.py`; rerun it
to regenerate the clips, `promo100.mp4` (the v1 web cut with the synthesised
BGM, under the 25 MiB per-file limit), `promo100.jpg` and
`assets/sprint-coder-og-100.jpg`. The settings clips were recorded before the
run with the same app and user data, and say so on screen.

The other clips (`code`, `review`, `redo`, `recheck`, `hires`, `together`, …)
and `promo-720.mp4` / `promo-1080.webm` / `bgm.m4a` come from the 2026-10-20
run; their table is `tools/make-media.ps1`. The subpages still use some of them.

Every clip shows a label with its speed (`等速` or `早送り ×N`) and, where it
helps, the time since the request was sent (`送信から約13分`).

### Honesty rules

- **The team is 100; the most running at once is 93.** Never 「100体が同時に動いた」
  or 「100体が同時に実行」. Say 「100体のAIチーム」「100体のチーム」 (leader 1 ·
  managers 9 · workers 90) and 「同時に実行中 最大93体」. 「実行中」 includes the
  wait for the result to be merged, and the page says so near every 93.
- **100 is also the limit**, a separate fact: 「同時に動かせる数の上限は100（標準は50）」.
  The leader is not counted toward the limit (only managers and workers are
  executions), so the run had 99 executions. No test or run has yet shown exactly
  100 executions running at once; `/ai-team/` says so.
- Count AIs with 体 on every page (the promo video says 人; the site keeps 体).
  No 「。」 in titles, headlines or the one-line `.lead` copy (only in `.note` and
  multi-sentence card text).
- Numbers come only from the run log and the leader's final report: 100, 9, 90,
  50 / 49 / 1 and the models, 4:16 (last hire), 93 at 4:42, 44 at about 13 min,
  76 at about 7 min, 24:55 (last execution done), 99 executions all completed,
  90 drawings, 26:46 (request to final report). The 2026-10-20 numbers (6 at
  once, 15 tasks, 1 redo, 9 tests, 36:32) appear only in chapter 05, under its
  「もうひとつの実演 10/20」 label, and on `/ai-team/` under that run's heading.
- Figures drawn from the log say 「図 · 実演の記録から作図」 and how much they are
  fast-forwarded. Do not claim speed, cost or accuracy.
- Facts behind the limit (checked 2026-10-24 on `site/hundred-ai`, re-read
  2026-10-27): `packages/domain/src/team.ts` `TEAM_MAX_CONCURRENT_EXECUTIONS = 100`,
  `TEAM_DEFAULT_CONCURRENT_EXECUTIONS = 50`; work beyond the limit waits
  `queued`; fresh assignments start at most 100 per 60 s
  (`TEAM_ASSIGNMENT_RATE_LIMIT`). API-key and on-PC connections run at most 2
  requests at a time per connection; built-in CLIs skip that limit.

After changing the hero's recording label or layout, use the development agent's
Computer Use to check the local preview against the [website checklist](../docs/testing/computer-use/README.md).
Retain the 56 viewport sizes and the start/end positions of the opening chapter:
the label must not overlap the copy or leave the screen. Record the viewport,
chapter position, screenshot, and PASS / FAIL / SKIP / BLOCKED for each case.
If Computer Use is unavailable, report BLOCKED; a static site build is not UI evidence.

## Public routes

- `/` — Homepage (the film)
- `/about/` — Product overview
- `/ai-team/` — How the AI team works
- `/providers/` — Choosing AI (cloud and on-device)
- `/local-first-security/` — Storage, sending and safety
- `/managed-harness/` — How actions are checked and recorded
- `/getting-started/` — Setup guide
- `/releases/` — Downloads (official release and pre-release)
