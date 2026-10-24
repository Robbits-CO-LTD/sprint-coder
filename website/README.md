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

The homepage is a scroll-driven "film": 「最大100体のAIを 同時に動かす」. It opens
with a **figure** of the concurrency limit (chapters 00–02), then switches,
explicitly, to **real recordings of the app** (chapters 03–07).

| no | id | title | what it shows |
|---|---|---|---|
| 00 | `top` | 序章 | the 100-dot swarm (figure), the 実演 6体 → 上限 100体 cards |
| 01 | `ch-solo` | 一斉 | one AI queues its work vs. up to 100 at once (figure) |
| 02 | `ch-scale` | 規模 | the swarm fills 1 → 100 with the counter and the 1/6/50/100 tiers, the limit setting, the 「101件目は 順番を待つ」 trust card |
| 03 | `ch-real` | 実演 | 「ここまでは イメージ図」→「ここから 本物」, 6 of 100 dots lit, the real request |
| 04 | `ch-team` | チーム | hires, the org chart, cloud vs. on-device AI, assembly |
| 05 | `ch-together` | 同時 | 6 at once, the timeline chart |
| 06 | `ch-check` | 確認 | build, check, redo, re-check |
| 07 | `ch-done` | 完成 | 36:32, 9 tests, the stats |
| 08 | `ch-safe` | 安心 | four cards |
| 09 | `start` | 始動 | downloads (outside the film) |

Each chapter is a `.scene` (a tall wrapper with a sticky `.stage`). `film.js`
turns the scroll position inside a scene into `--p` (0–1) and counts how many of
the thresholds in `data-steps="0.1,0.4"` have been passed. Any element with
`data-show="2"` (step 2 onward) or `data-show="1-3"` (steps 1–3) gets `.on`
while that step is active, and `styles.css` animates it. `data-range="a,b"`
exposes a local 0–1 value as `--r` (used to draw the org-chart wires, sweep
the timeline chart, light the swarm and the tiers); when `--r` reaches 1 the
element gets `.is-full`. In the stacked layout (`.fit-off`) every range is shown
at its end state (`--r: 1`). Scene videos load when the scene is near and play
only while visible. The fixed `.player` bar shows chapters, auto-play (scrolls
the page like a video), sound (synthesised BGM, off by default) and the full
4:02 video in a `<dialog>`.

More hooks used by the homepage:

- `data-count="100" data-from="1" data-pad="3"` — a number that counts from
  `data-from` to `data-count` with the `--r` of its nearest `[data-range]`
  (`data-pad` zero-pads it). The HTML holds the end value, so without JS it reads
  the final number.
- `data-count-intro="100"` — the opening count-up (000 → 100, easeOutExpo, about
  0.7–1.7 s). It runs only when `film.js` starts before 1.5 s after navigation
  and motion is not stopped; otherwise the HTML 「100」 stays (it never jumps
  from 100 back to 000).
- `.scene.is-live` — set while the chapter is on screen. The swarm's "working"
  twinkle (only the 10 column groups animate) runs only then.
- `.scene[data-real]` — a chapter of the real demo (03–07). While the player is
  in one, `.player.is-real` shows the 「実演 · 2026年10月20日 · 実際のアプリと実際のAI」
  label (short form 「実演 10/20」 at 1100 px and below, so the seek bar keeps at
  least 160 px). `data-real-from="3"` delays the label to that step: 03 uses it so
  the label never shows over the 「イメージ図」 heading or the 6-of-100 figure.
- The head script adds `.motion-off` before first paint when 「動きを止める」 was
  chosen earlier, so the opening animation never starts.

### The swarm figure (`tools/make-swarm.py`)

Never hand-edit the swarm SVG. `py -I website/tools/make-swarm.py` rewrites the
inline SVG between the `<!-- swarm:hero -->`, `<!-- swarm:fill -->` and
`<!-- swarm:real -->` markers in `index.html` and writes the static
`assets/swarm-v1.svg` (all lit) and `assets/swarm-v1-real.svg` (6 lit, 94
outlined) with their colours baked in, for `<img>` use. `/assets/` is immutable:
bump the `v` in the file name when the picture changes.

- Layout: leader 1 (not counted) + managers 10 + members 90 = 100. The
  manager/member split is only an example (caption and `aria-label` say so).
- The 6 `.lit` dots sit in the same place in every figure. Their positions
  represent only the count, not which roles actually ran in the demo.
- DOM order (wires → collines → ld-ring → ld → 10 × `.col`, each `mg` then 9
  `n`) matters: `styles.css` derives `--c` / `--row` / `--i` from `nth-child`.

### Figure label (`.tag-fig`)

Every 100 figure (00, 01, 02, 03, 始動, ai-team) has a `.tag-fig`
「図 · 映像ではありません」 on the same screen — same size and place as `.rec`, but
with a grey, non-blinking dot and a dashed border (`.tag-fig.ink` on lime, which
is `aria-hidden` because it repeats the first label). The 6-of-100 figure in 03
says 「図 · 映像ではありません · 6は実演の数」, and its legend says 「6体 実演で同時に動いた数」
(never 「映像あり」 next to a figure). On 始動 the static swarm and its label sit only
in the empty space right of the download block (`.finale-main`, from 1240 px
wide; hidden below that), never behind the cards or the `.watch` thumbnail of
the real video; that label is `aria-hidden` like the decorative image. Recording labels
(`.rec`) and figure labels never sit on the same picture: the hero no longer
uses `hero.mp4`, and in 03 the request video starts at step 3, after the figure
(in the stacked layouts it is hidden).

### Performance fallback

Per frame, only the 100 dots of chapter 02 recompute (CSS from `--r`). The
twinkle animates 10 groups and stops off screen. No `filter` / `box-shadow` on
dots. If a real phone stutters in 02, drop its `data-range` and light the dots
with 10 more `data-steps` and row rules such as
`[data-step="n"] .col > .u:nth-child(-n + k)`.

Subpages use the same design system (`.page-hero` with a looping clip, cards,
`.reel` blocks with clips, a `.details` section with the technical text).
`/ai-team/#scale` shows the limit with the static `assets/swarm-v1-real.svg`
inside a `.fig` box (its own `.tag-fig` and `.fig-legend`), never on a clip.
Because its page-hero lead mentions 最大100体 over a real clip, the hero also
carries the 「設定で上限を100にした場合。標準は50」 note and says the clip is the
6体 demo. Counting words: AIs are counted with 体 on every page (「ひとりのAI」 became
「1体のAI」, 「ひとりは 順番待ち」 became 「1体は 順番待ち」, the 1体 tier says 「単独」,
about's 「ひとりで始め」 became 「1体から始め」); 人 meaning a person
(「決めるのは人」「人が決める」) stays.

With `prefers-reduced-motion: reduce`, scenes render as normal stacked sections,
nothing autoplays and every clip shows its poster frame (the full video is still
playable in the dialog). When a chapter does not fit the pinned stage (short
screens, zoomed text), `film.js` adds `.fit-off` and the chapters stack the same
way. Every page also has a 「動きを止める」 button that pauses all clips. Without
JavaScript all text is still in the HTML. When `film.js` does not run at all on
the homepage (`html` has neither `.js` nor `.rm`), the header gets a solid
background and the footage chapters show their poster frames as CSS backgrounds
(posters are otherwise set from `data-poster` by JS).

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

All clips are cut from the screen recordings made for the promo video on
2026-10-20 (the in-development build of the app, captured through the Chrome
DevTools screencast, so no other windows or notifications are in frame). The
source table — recording, start, length, speed — is
`tools/make-media.ps1`; rerun it to regenerate every clip, the poster frames, the
full video (`promo-720.mp4`, `promo-1080.webm`, both under Cloudflare's 25 MiB
per-file limit) and `bgm.m4a`.

Honesty rules carried over from the promo: every clip shows a label with its
speed (`等速` or `早送り ×N`), and screens recorded right after the demo say so.
Numbers on the homepage (6 at once, 15 runs, 1 redo, 9 tests passed, 36:32)
come only from the demo's run log and the leader's own test run.

Honesty rules for 「最大100体」:

- **100 is a limit.** It always comes with 最大 / まで / 上限. Never a past
  tense or an achievement (「100体が動いた」「100体のチームで作った」), never
  「100体 始動」. Count AIs with 体 on every page; no 「。」 in titles, headlines
  or the one-line `.lead` copy (only in `.note` and multi-sentence card text).
- Every screen that shows 100 also says 「設定で上限を100にした場合（標準は50）」
  (or its short form) on that screen — 00, 01 (lime beat), 02 (beats A, B and the
  trust card), 03 (the 6-of-100 beat), 始動, and on `/ai-team/` the hero, card 02
  and `#scale` — and every 100 figure carries `.tag-fig`.
- The end of 02 states it plainly: 「101件目は 順番を待つ」 — an automated test
  with mock AIs, worded exactly as far as the test goes (see the facts below:
  101 assignments, 100 finish, the 101st waits instead of failing, because of the
  per-minute start pace). Never 「100体が同時に動いた」 or 「確認済み」 for 100
  concurrent runs; the card says 100 running at once is not tested yet, and there
  is no video of 100 real AIs yet. (Earlier title 「上限100体は 試験で確認」 was
  dropped in review: it read as if the 100 cap itself had been tested.)
- API-key and on-PC (Ollama etc., `openai_compatible`) connections run at most
  2 requests at a time per connection (`provider-connection-service.ts`
  `maxConcurrentRequests: 2`; the settings screen can only lower it,
  `persistence.ts`), so say 「まで」, never 「標準」. Built-in CLIs (Codex, Claude
  Code, Grok) and `bypass` skip that limit (`connection-admission.ts`). The 02
  trust card and `/ai-team/` say so (kept out of the hero note: it pushed the
  00 beat past the stage height at 1920x1080 and turned the whole page fit-off).
- The timeline chart, the stats and the full-video copy never mix in 100.
- **Real demo numbers (6, 15, 1, 9, 36:32) appear only in 03–07**, whose chapter
  tags carry `実演 REAL` and whose player label says 実演. 03 marks the border
  between figure and footage (「ここまでは イメージ図」→「ここから 本物」).
  **One exception:** the single number 「6」 may appear outside 03–07 only as the
  contrast to the limit, always paired with the word 実演 on the same card — the
  00 proof card 「実演 6体」, the 02 tier 「6体 実演」, the 始動 `.watch` line and the
  full-video dialog bar (「同時に動いたのは最大6体」), and the meta descriptions.
  15 / 1 / 9 / 36:32 never appear outside 03–07.

Facts behind the copy (checked in this repository on 2026-10-24, branch
`site/hundred-ai`, which contains v0.6.0):

- `packages/domain/src/team.ts`: `TEAM_MAX_CONCURRENT_EXECUTIONS = 100`,
  `TEAM_DEFAULT_CONCURRENT_EXECUTIONS = 50`. Two settings apply: the app-wide
  limit in Settings > Team (default 50, 1–100) and each Team policy's
  `maxConcurrentExecutions` (1–100). So the site says 「同時に動かせる上限」,
  never 「1チームで」.
- **Who counts toward the limit:** `TeamExecutionScheduler`
  (`apps/desktop/src/main/team-execution-scheduler.ts`) counts active
  executions; every execution is submitted through
  `TeamCoordinator.scheduleExecution` for an agent of `kind === 'worker'`
  (`admitAssignment` in `apps/desktop/src/main/team-coordinator.ts` rejects any
  other target). Managers are hired through `hireWorker` /
  `registerTeamWorker` as Workers with `canDelegate` and a `managerPolicy`, so a
  running manager **counts**. The leader is `kind === 'leader'`, is never an
  execution assignee and **does not count**. Hence the caption
  「リーダー 1 ＋ 部長と担当 最大100」.
- Work beyond the limit is not rejected: it waits `queued`. Separately from the
  concurrency limit, fresh assignments start at most 100 per 60 s
  (`TEAM_ASSIGNMENT_RATE_LIMIT = { limit: 100, windowMs: 60000 }`).
- **What the tests prove (re-checked 2026-10-24):** `team-coordinator.test.ts`
  「queues an assignment beyond the per-minute pace instead of refusing it
  (issue #854)」 sets the limit to 100, hires 101 Workers on the fast
  `TestWorkerRuntime` and assigns 101 tasks: all 101 are accepted, 100 complete,
  the 101st is `queued`. The 101st waits because of the **start pace**, not the
  concurrency limit (the test's own comment: the Team "may run all at once"), and
  no test asserts 100 executions active at the same time
  (`team-execution-scheduler.test.ts` asserts the concurrency cap only at 50 and
  8: `activeCount` 50 / 8 with the rest queued). So the site says 「101件目は
  順番を待つ」 with that exact description, never that 100 ran at once.
- 「雇える数に上限なし」 is **not** claimed: hiring reserves spawn slots and
  budget, which can refuse a hire.
- Re-checked for `/ai-team/` (same branch): `admitAssignment` still accepts only
  `kind === 'worker'` targets and managers are still hired as Workers, so the
  page's technical text says 「Managerも雇われたWorkerとして数え、Leaderは含みません」.
  Per-connection `maxConcurrentRequests` (`apps/desktop/src/main/connection-admission.ts`)
  and provider rate limits also cap cloud AIs; that is stated there too.
- Noto Sans JP has no `tnum` feature, so `make-font.py` no longer asks for it;
  its digits are already equal width (521 units) and `palt` does not touch them,
  so the counters do not jitter.

`assets/sprint-coder-og.jpg` (1200×630) is rendered from a real frame.

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
