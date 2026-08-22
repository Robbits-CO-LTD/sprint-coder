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

Open <http://127.0.0.1:4174/>. The site source has no build step or application
JavaScript.

## Public routes

- `/` — Homepage
- `/about/` — Product overview
- `/ai-team/` — AI Team Coding
- `/providers/` — Supported runtimes and providers
- `/local-first-security/` — Local-first and security boundaries
- `/managed-harness/` — Managed execution architecture
- `/getting-started/` — Setup guide
- `/releases/` — Current official release and downloads
