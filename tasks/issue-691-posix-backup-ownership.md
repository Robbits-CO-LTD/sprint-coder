# #691 POSIX unused backup cleanup

CI at #672 head b3d1cf000d2be933ec50d476160249e93b7d3fd5 revealed a product defect,
not the earlier Windows basename fixture issue. Actual macOS shard 2/3 and Linux shard 2/3
both failed the new deterministic nonce-backup collision regression with ENOENT: the existing
third-party backup sibling disappeared. POSIX publication exchanges staging and destination,
never creating that backup. Nevertheless both success/intervention paths assigned ownership
from `existsSync(backup)` and finally unlinked it. The old main has the same ownership pattern.

Minimal correction: backup ownership assignment and exceptional backup recovery selection are
Windows-only. Windows keeps exclusive placeholder creation, native backup, ACL retention and
rollback. POSIX no longer claims an unused sibling. The failing collision test remains intact.

Issue #691 records reproduction, actual/expected, impact, hosted OS evidence, and duplicate
comparison against #651/#679/#406/#444. Source code and actual failing CI provide independent
evidence; no macOS/Linux local execution is claimed under the user's Windows-only constraint.

Windows yuseipc / Electron 43.5.0: workspace editor and native publication **31 PASS / 8 POSIX
SKIP**. Desktop typecheck, changed-file ESLint zero warnings, Prettier passed. Actual POSIX
regression acceptance awaits the new exact-head CI. Independent review is recorded in PR #672.
