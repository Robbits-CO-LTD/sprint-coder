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

The homepage is a scroll-driven "film" built from **real recordings of the app**.
Each chapter is a `.scene` (a tall wrapper with a sticky `.stage`). `film.js`
turns the scroll position inside a scene into `--p` (0–1) and counts how many of
the thresholds in `data-steps="0.1,0.4"` have been passed. Any element with
`data-show="2"` (step 2 onward) or `data-show="1-3"` (steps 1–3) gets `.on`
while that step is active, and `styles.css` animates it. `data-range="a,b"`
exposes a local 0–1 value as `--r` (used to draw the org-chart wires and sweep
the timeline chart). Scene videos load when the scene is near and play only
while visible. The fixed `.player` bar shows chapters, auto-play (scrolls the
page like a video), sound (synthesised BGM, off by default) and the full 4:02
video in a `<dialog>`.

Subpages use the same design system (`.page-hero` with a looping clip, cards,
`.reel` blocks with clips, a `.details` section with the technical text).

With `prefers-reduced-motion: reduce`, scenes render as normal stacked sections,
nothing autoplays and every clip shows its poster frame (the full video is still
playable in the dialog). When a chapter does not fit the pinned stage (short
screens, zoomed text), `film.js` adds `.fit-off` and the chapters stack the same
way. Every page also has a 「動きを止める」 button that pauses all clips. Without
JavaScript all text is still in the HTML.

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

`assets/sprint-coder-og.jpg` (1200×630) is rendered from a real frame.

After changing the hero's recording label or layout, run
`node website/tools/check-hero-label.cjs http://127.0.0.1:4174/` (with the local
preview running). It checks 56 viewport sizes at the start and end of the
opening chapter and fails if the label overlaps the copy or leaves the screen.

## Public routes

- `/` — Homepage (the film)
- `/about/` — Product overview
- `/ai-team/` — How the AI team works
- `/providers/` — Choosing AI (cloud and on-device)
- `/local-first-security/` — Storage, sending and safety
- `/managed-harness/` — How actions are checked and recorded
- `/getting-started/` — Setup guide
- `/releases/` — Downloads (official release and pre-release)
