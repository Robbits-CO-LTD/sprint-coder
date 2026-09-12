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

Open <http://127.0.0.1:4174/>. The site has no build step. The homepage loads one
dependency-free script, `story.js`, which drives the scroll-pinned scenes by
writing CSS custom properties; every other page is plain HTML and CSS.

## Homepage scroll story

`index.html` wraps three pinned scenes (`[data-scene]`). Each is a tall wrapper
with a sticky `.scene-stage`; `story.js` turns the scroll offset inside the
wrapper into a 0–1 progress value and maps sub-ranges of it to `--s-<phase>`
custom properties, which `styles.css` consumes. Phase ranges live in the
`PHASES` table in `story.js`. With `prefers-reduced-motion: reduce`, or when
the script fails to load, the scenes render unpinned in their final state.

The production nginx config sends `script-src 'self' 'unsafe-inline'` and
`style-src 'self'`: keep scripts same-origin, never add inline `style=""`
attributes (CSSOM writes from JS are fine), and bump the `?v=` query on
`styles.css` / `story.js` in every page when either file changes.

## Public routes

- `/` — Homepage
- `/about/` — Product overview
- `/ai-team/` — AI Team Coding
- `/providers/` — Supported runtimes and providers
- `/local-first-security/` — Local-first and security boundaries
- `/managed-harness/` — Managed execution architecture
- `/getting-started/` — Setup guide
- `/releases/` — Current official release and downloads
