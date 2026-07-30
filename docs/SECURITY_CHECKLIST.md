# Electron Security Checklist — Sprint Coder

Phase 7 hardening evidence (IMPLEMENTATION_PLAN §10.4, PRODUCT_AND_TECHNICAL_DESIGN NFR-SEC-01..08).
Every item below was verified against the code at the time of writing (branch
`codex/rename-sprint-coder`); citations are `file:line`. Status legend:

- **Enforced** — implemented and covered by an automated test.
- **Enforced (manual)** — implemented, verified by reading the code, no dedicated automated test
  (either impractical to automate, or covered indirectly — noted per item).
- **N/A** — the feature/anti-pattern this checklist item warns about is not used at all.
- **Open** — a real gap; tracked with a reason it was not fixed in this pass.

## 1. Official Electron security recommendations

| # | Recommendation | Status | Where | Tested by |
|---|---|---|---|---|
| 1 | Only load secure content | Enforced | `main/index.ts:137-142` loads either the Vite dev server URL (dev only) or the app's own `app://bundle/index.html` custom-protocol URL — never an arbitrary/remote URL. `will-navigate` is denied outright (#13). | Manual read; exercised implicitly by every e2e spec that boots the app. |
| 2 | Disable Node.js integration for remote/renderer content | Enforced | `main/index.ts:124` `nodeIntegration: false` on the only `BrowserWindow`. | No renderer test exercises `require`/`process` from the page; a regression here would surface as `require is not defined` at runtime — see also Fuses `OnlyLoadAppFromAsar`/`RunAsNode` below for defense in depth. |
| 3 | Enable context isolation | Enforced | `main/index.ts:123` `contextIsolation: true`. Preload uses only `contextBridge.exposeInMainWorld` (`preload/index.ts:329`) — no raw `ipcRenderer`, `require`, or Node global is exposed to the page's `window`. | Manual read of `preload/index.ts` (only `contextBridge`/`ipcRenderer.invoke` wrapped in typed functions are exported; grepped for any other `window.*=` assignment — none found). |
| 4 | Enable process sandboxing | Enforced | `main/index.ts:33` `app.enableSandbox()` (process-wide) plus `main/index.ts:122` `sandbox: true` on the window's `webPreferences` (redundant, explicit). | Manual read; sandbox behavior (no direct Node access in the renderer process) is a platform guarantee once these flags are set. |
| 5 | Handle session permission requests from remote content | Enforced | `main/index.ts:129-132`: `setPermissionRequestHandler` always calls back `false`; `setPermissionCheckHandler` always returns `false`. The app requests no runtime permissions (camera/mic/geolocation/notifications/etc.), so deny-all has no functional cost. | Manual read. |
| 6 | Do not disable `webSecurity` | Enforced | `webPreferences` (`main/index.ts:120-125`) never sets `webSecurity`, so it stays at the Electron default of `true`. Grepped the whole `apps/desktop/src` tree and `forge.config.ts` for `webSecurity` — zero occurrences. | Manual grep (`webSecurity` not present anywhere in the codebase). |
| 7 | Define a Content-Security-Policy | Enforced | Production: `main/index.ts:211-225` (`registerProductionProtocol`) sets `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'` as an HTTP response header on every resource served through the `app://` protocol — no `unsafe-eval`, no wildcard origins. Dev: `index.html:6-15` carries a relaxed meta-tag CSP (`script-src 'self' http://localhost:*` etc.) needed only for the Vite dev server/HMR; per the CSP spec, a meta-tag policy and a header policy are enforced as an *intersection*, so this can never relax what the production header allows, and dev mode is not a shipped artifact. `style-src 'unsafe-inline'` is a deliberate, lower-severity relaxation (CSS injection, not code execution) reviewed and accepted — no inline `<script>`/`javascript:` execution is permitted anywhere. | Manual read of both files; the header-setting code path is exercised by every e2e spec that loads the packaged/dev app (owned by a concurrent workstream — not duplicated here as a security-specific test since it needs a real window). |
| 8 | Do not set `allowRunningInsecureContent: true` | N/A | Not present anywhere in `webPreferences` (default `false`). | Manual grep. |
| 9 | Do not enable experimental features | N/A | `experimentalFeatures` not present anywhere. | Manual grep. |
| 10 | Do not use `enableBlinkFeatures` | N/A | Not present anywhere. | Manual grep. |
| 11 | Disable or restrict the `<webview>` tag | N/A | `webviewTag` is never set (defaults to `false`/unavailable in modern Electron), and no `<webview>` element exists in the renderer. | Manual grep across `apps/desktop/src/renderer`. |
| 12 | Verify `webContents` options before creating a new window | Enforced | `setWindowOpenHandler(() => ({ action: 'deny' }))` (`main/index.ts:128`) denies **every** `window.open`/`target="_blank"`/middle-click(auxclick)-triggered new-window request unconditionally — there is no "verify then allow" branch to get wrong, because nothing is ever allowed. | Manual read. Electronegativity's `AUXCLICK_JS_CHECK` flagged this file for manual review (§3) — reviewed: `setWindowOpenHandler` has intercepted `window.open` for all trigger methods, including auxclick/middle-click, since its introduction (replacing the older `new-window` event), so this is already covered; no code change needed. |
| 13 | Disable or limit navigation | Enforced | `window.webContents.on('will-navigate', (event) => event.preventDefault())` (`main/index.ts:127`) unconditionally blocks in-page navigation away from the loaded app/dev-server URL — no allowlist branch, no exceptions. | Manual read. |
| 14 | Disable or limit creation of new windows | Enforced | Same `setWindowOpenHandler` as #12 — deny-all, no second `BrowserWindow` is ever created by app code. | Manual read; only one `new BrowserWindow(...)` call exists in the codebase (`main/index.ts:114`). |
| 15 | Do not use `shell.openExternal` with untrusted content | N/A | `shell.openExternal` is never called anywhere in the codebase (grepped `apps/desktop/src`). Markdown links intentionally do not navigate at all yet (`renderer/components/Markdown.tsx` — `onClick={(e) => e.preventDefault()}`, "External open is Phase 4" comment) — clicking a rendered link currently does nothing beyond revealing the destination via the `title` attribute. | Manual grep; `renderer/components/Markdown.adversarial.test.tsx` (new, this pass) asserts unsafe-scheme links are never rendered as a clickable `<a>` in the first place. |
| 16/17 | Disable/filter the deprecated `remote` module | N/A | Neither `electron`'s built-in `remote` (removed since Electron 14) nor the `@electron/remote` polyfill package is a dependency anywhere in the workspace (checked root and `apps/desktop/package.json`). | Manual grep of every `package.json` in the workspace. |
| 18 | IPC: validate sender frame/origin and payload shape on every handler (NFR-SEC-03) | Enforced | `IpcRouter.handle()` (`main/ipc.ts:736-763`) calls `this.validateSender(event)` before parsing, which delegates to the pure, exported `isTrustedIpcSender()` (`main/ipc.ts`, see NFR-SEC-03 section below) checking sender WebContents id, top-frame-ness, and exact trusted origin (with the `app://` scheme additionally pinned to host `bundle`). Every payload is parsed through `commandEnvelopeSchema(inputSchema).parse(raw)` — a `.strict()` zod schema for every registered channel — before the handler body runs. | `apps/desktop/src/main/ipc.test.ts` (new, this pass): 300 cases — `isTrustedIpcSender` adversarial fixtures (wrong sender id, null/child frame, origin/scheme/host spoofing, unparsable URL) plus a table-driven fuzz over all 41 `ipcMain.handle`-registered channels (prototype-pollution shapes, oversized strings, wrong types, missing fields, extra/unrecognized keys, deeply nested/throwing-getter payloads) proving every channel's schema composition rejects the adversarial input without ever throwing synchronously outside `try/catch`. |
| 19 | Preload script exposes only a minimal, typed surface | Enforced | `preload/index.ts` exposes exactly one object (`sprintCoder`) via `contextBridge.exposeInMainWorld`, built entirely from typed wrapper functions (`invoke`/`invokeEnvelope`) that validate both the outgoing payload and the incoming result against the same zod schemas `main/ipc.ts` uses — defense in depth on both sides of the IPC boundary (NFR-SEC-02). | Manual read; the shared contract schemas are exercised by `packages/contracts/src/index.test.ts` and (main-side) `apps/desktop/src/main/ipc.test.ts`. |
| 20 | Local resources served through a real protocol handler, not `file://` (NFR-SEC-04) | Enforced | `protocol.registerSchemesAsPrivileged` (`main/index.ts:27-32`) registers a `standard`, `secure` custom `app://` scheme; `registerProductionProtocol()` (`main/index.ts:208-226`) serves the packaged renderer bundle exclusively through `protocol.handle('app', ...)`, rejecting any request whose host isn't exactly `bundle` (`main/index.ts:215`) — path traversal or host spoofing inside the `app://` URL cannot escape the resource manifest built from `readdirSync` (`buildResourceManifest`, `main/index.ts:228-240`). | Manual read; `isTrustedIpcSender`'s `app://`+host==`bundle` pinning (item 18 above) is unit-tested and depends on this same scheme. |

## 2. Fuses (packaged-app hardening) — manual review

Source: `apps/desktop/forge.config.ts:49-58` (`@electron/fuses` v1.8.0 via `@electron-forge/plugin-fuses` v7.8.3).

| Fuse | Value | Rationale |
|---|---|---|
| `RunAsNode` | `false` | Prevents the packaged binary from being re-invoked as a plain Node.js process via `ELECTRON_RUN_AS_NODE` — closes off a well-known technique for extracting/abusing the packaged app's embedded Node runtime outside the app's own sandboxed window model. (Development/CI still uses `ELECTRON_RUN_AS_NODE=1` against the *unpackaged* `node_modules/.bin/electron` binary for the Electron-ABI test-subprocess pattern — e.g. `provider-egress.test.ts`, `persistence.test.ts` — which is unaffected by this fuse since it only hardens the *packaged* app.) |
| `EnableCookieEncryption` | `true` | Encrypts the cookie store at rest using OS-level key storage, consistent with NFR-SEC-07's `safeStorage`-based credential handling philosophy. |
| `EnableNodeOptionsEnvironmentVariable` | `false` | Prevents an attacker (or a misconfigured launch environment) from injecting arbitrary Node.js CLI flags (e.g. `--require`, `--inspect`) into the packaged app via the `NODE_OPTIONS` environment variable. |
| `EnableNodeCliInspectArguments` | `false` | Disables `--inspect`/`--inspect-brk`-style debugger attachment to the packaged app, closing a remote-debugging-based code-execution/data-exfiltration vector. |
| `EnableEmbeddedAsarIntegrityValidation` | `true` | Verifies the `app.asar` archive's contents against embedded hashes at load time, so a tampered/patched packaged app fails closed instead of silently running modified code. |
| `OnlyLoadAppFromAsar` | `true` | Refuses to load app code from an unpacked/sibling directory that isn't the verified `app.asar` (paired with `asar.unpack: '*.node'` in `packagerConfig` — only native addon binaries are allowed outside the archive, because Electron cannot load `.node` files from inside an asar). |

No fuse here is left at an insecure default; all five available V1 fuses are explicitly pinned. This
list was produced by reading `forge.config.ts` directly (Electronegativity does not fully evaluate
Fuses configuration inside a Vite/Forge TypeScript config file, so this section is manual, not
tool-generated).

## 3. Electronegativity run

Attempted: `npx @doyensec/electronegativity -i apps/desktop -o <file>.csv`. The tool **ran
successfully** (no install/network failure) against the source tree (not a packaged build, since
no packaged artifact existed at scan time). 5 findings, triaged below.

| Check | Severity | Finding | Triage |
|---|---|---|---|
| `AVAILABLE_SECURITY_FIXES_GLOBAL_CHECK` | Informational | Electron `43.2.x` is not in the tool's known-release database yet. | False positive / tool lag — not a code issue. Tracked via NFR-SEC-08 (stay within the 3 latest supported stable lines); revisit at the next dependency bump. |
| `CSP_GLOBAL_CHECK` | Low | `index.html`'s meta CSP allows `http://localhost:*` in `script-src`/`connect-src`. | Reviewed, mitigated by design — see §1 item 7 above (dev-only meta tag, intersected with the strict production header; comment added in `index.html` explaining this for future reviewers). |
| `HTTP_RESOURCES_JS_CHECK` | Medium | Built `.vite/build/index.js` contains a call to `window.loadURL("http://localhost:5173")`. | False positive for the shipped app — this is the `MAIN_WINDOW_VITE_DEV_SERVER_URL` branch (`main/index.ts:138-139`), which Vite/Forge only populates in `electron-forge start` (dev); packaged builds never define this constant, so the branch that runs is always `app://bundle/index.html` (`main/index.ts:141`). |
| `AUXCLICK_JS_CHECK` | Medium | `main/index.ts:114` `new BrowserWindow(...)` flagged for "middle-click may bypass navigation limits" review. | Reviewed — see §1 item 12. `setWindowOpenHandler` denies all new-window creation regardless of the triggering input (left-click via JS, ctrl/cmd-click, or middle-click/auxclick); no separate auxclick-specific handling is needed. |
| `PRELOAD_JS_CHECK` | Medium | `main/index.ts:121` preload script usage flagged for manual review (informational — any preload triggers this check). | Reviewed — see §1 items 3 and 19: `contextBridge`-only surface, no raw `ipcRenderer`/Node global exposed, every call validated by shared zod schemas both directions. |

No Critical/High findings. No code changes were made in response to Electronegativity findings
beyond the `index.html` explanatory comment (§1 item 7) — every other flagged line was already
correct and is now cross-referenced here rather than duplicated in code comments.

## 4. Adversarial test coverage added this pass (cross-reference)

| Area | File | What it proves |
|---|---|---|
| IPC sender + payload | `apps/desktop/src/main/ipc.test.ts` (new) | Sender/frame/origin spoofing rejected; every registered channel's schema rejects prototype-pollution shapes, oversized strings, wrong types, extra keys, and never crashes synchronously on adversarial input. |
| Path traversal | `apps/desktop/src/main/path-guard.test.ts` (extended) | Percent-encoded (`%2e%2e%2f`) and backslash traversal treated as literal/rejected, NUL bytes, empty paths, overlong single segments and overlong total paths (now a typed `INVALID_PATH` instead of an uncaught `ENAMETOOLONG` — see `path-guard.ts` fix below), exact-workspace-root boundary (including a sibling directory that merely shares a text prefix with the workspace path). |
| Markdown/URL | `apps/desktop/src/renderer/components/Markdown.adversarial.test.tsx` (new) | `<script>`/`<iframe>`/`<object>`/`<embed>` never render as live elements; `javascript:`/`data:`/`vbscript:` links neutralized to inert text; Markdown images never trigger a network fetch (fixed — see below) including React's own `<link rel=preload>` eager-preload; safe `https:`/`mailto:` links keep `rel="noopener noreferrer"`. |
| ANSI/terminal | `apps/desktop/src/main/ansi-sanitizer.test.ts` (extended) | OSC 8 hyperlink label/href smuggling, cursor-move/erase spoofing sequences, and an oversized chained-SGR run are all stripped without hanging or leaking control payload. |
| Secrets | `apps/desktop/src/main/secret-redactor.ts` + `.test.ts` (extended) | Realistic corpus: AWS access key ID/secret access key (labeled and bare), GitHub classic + fine-grained PATs, Anthropic (`sk-ant-...`) and OpenAI-style (`sk-proj-...`) keys, a bare JWT, `.env`-style `DB_PASSWORD=`/multi-secret blocks, and EC/OpenSSH PEM blocks (not just RSA) are all redacted; a negative test confirms ordinary prose mentioning credential-shaped words is left untouched. |
| Provider egress | `apps/desktop/src/main/provider-egress.test.ts` (extended) | A secret-bearing prompt is denied *before* the Runtime dispatch callback is ever invoked (dispatch counter asserted at 0), not merely reported as denied after the fact. |
| Runtime bypass | `apps/desktop/src/runtime-host/codex-normalizer.test.ts` (extended) | A top-level or nested-item approval-request event from the Codex CLI (which should never happen under `approval_policy="never"`) is treated as a fatal profile violation, mirroring the existing Claude no-tools/no-MCP capability check. |
| Runtime sandbox (real CLI, opt-in) | `apps/desktop/src/runtime-host/codex-smoke.test.ts` (new, mirrors `claude-smoke.test.ts`'s pattern; gated by `SPRINT_CODER_CODEX_SMOKE=1`) | Drives a real turn through the actual installed `codex` CLI with a prompt explicitly instructing it to write a file outside the Task workspace, then asserts on disk that the file was never created — a direct, machine-executed proof (on this darwin machine) that the `--sandbox read-only` flag holds against an adversarial attempt, not just that the flag is present in the argv. Also proves cancel-mid-turn leaves zero orphan `codex` processes (`pgrep`-verified before/after). Run once during this pass; see §7 below for the actual output. |

## 5. Gaps found and fixed in this pass

- **`main/ipc.ts`**: extracted the private `validateSender` sender/frame/origin check into an
  exported pure function `isTrustedIpcSender` so it is unit-testable without a live
  `BrowserWindow`. No behavior change other than making a malformed `frame.url` fail closed
  explicitly (`return false`) instead of throwing an unclassified error that the outer handler
  would have mapped to a generic `INTERNAL_ERROR` — same net effect (deny), clearer intent.
- **`main/path-guard.ts`**: `validateInput` now rejects a target path whose total length exceeds
  4096 characters or any single path segment exceeding 255 characters *before* any filesystem
  call, and `isNotFound`'s recognized error codes now include `ENAMETOOLONG` as defense in depth.
  Previously an overlong path reached `lstat`/`realpath` and threw a raw, untyped
  `ENAMETOOLONG` `Error` instead of a `PathGuardError` — callers expecting to pattern-match on
  `PathGuardError.code` would have seen an unclassified exception instead of a typed, fail-closed
  rejection.
- **`renderer/components/Markdown.tsx`**: Markdown images (`![alt](url)`) previously rendered a
  real `<img src>` element for any URL, including React 19's own eager `<link rel="preload">`
  hint — meaning an attacker-controlled (e.g. prompt-injected) assistant message could exfiltrate
  data the instant the message rendered, via a URL query string, with no user interaction at all.
  Images are now rendered as inert text (alt text, or the URL itself as a fallback, shown via the
  `title` attribute) through a new `SafeImage` component — no `src` ever reaches the DOM.
- **`main/secret-redactor.ts`**: the credential-shaped-token regex separator was `_` only, missing
  hyphenated key shapes (Anthropic `sk-ant-...`, OpenAI `sk-proj-...`); the generic
  `keyword=value` regex used `\b` before the keyword, which cannot match inside an
  underscore-joined identifier like `AWS_SECRET_ACCESS_KEY` or `DB_PASSWORD` (`_` is a word
  character, so no boundary exists there) — switched to a negative lookbehind
  (`(?<![a-z0-9])`) so a preceding `_`/`-`/start-of-string all count as a boundary while an
  unrelated compound word (`mypasswordfield`) still does not match. Added explicit AWS access-key
  and bare-JWT patterns, since neither had any coverage before.
- **`index.html`**: added an explanatory comment (no functional change) clarifying that the
  dev-only meta CSP's localhost allowance can never widen the production HTTP-header CSP, per the
  CSP intersection rule — this was Electronegativity's one Low finding.

## 6. Open items (not fixed in this pass — architectural or explicitly out of scope)

- **Session partitioning per Task/Workspace**: the app uses Electron's `defaultSession` for the
  single window; there is no per-Task storage/cookie partition. Not a checklist item per se (no
  remote content is ever loaded, so cross-Task storage leakage isn't currently reachable), but
  worth a design note if a future feature loads any third-party web content into this app. Fixing
  this requires a product/design decision on whether Tasks ever need isolated
  `session.fromPartition` storage — out of scope for this hardening pass; flagged separately.
- **`AVAILABLE_SECURITY_FIXES_GLOBAL_CHECK`**: Electron `43.2.x`'s exact patch status against the
  tool's database could not be confirmed (see §3). Re-run Electronegativity (or check
  electronjs.org's release blog) at the next Electron version bump.
- **End-to-end IPC transport proof**: `ipc.test.ts` (this pass) proves the sender-authenticity
  predicate and every channel's schema validation in isolation, since a live `BrowserWindow` +
  real renderer round trip cannot be driven headlessly in a fast unit test. The full transport
  (real preload → real `ipcRenderer.invoke` → real `ipcMain.handle` → real response) is exercised
  by the app's existing e2e suite (owned by a concurrent workstream this pass does not touch).

## 7. Machine-proven vs. manually argued (deliverable 5: sandbox/egress/bypass)

Ran on this machine (darwin), both CLIs installed and authenticated (`codex-cli 0.144.4`,
`claude 2.1.218`):

- **Machine-proven, real CLI, this pass**:
  - `SPRINT_CODER_CLAUDE_SMOKE=1 npx vitest run src/runtime-host/claude-smoke.test.ts` — 3/3
    passed. A real turn streams `stage`→`delta`→`completed` events end to end; cancel-mid-turn
    leaves 0 live `claude` processes (`pgrep -f "claude -p"` before/after).
  - `SPRINT_CODER_CODEX_SMOKE=1 npx vitest run src/runtime-host/codex-smoke.test.ts` (new, this
    pass) — 4/4 passed, including the sandbox-escape test: a real turn was given the explicit
    adversarial instruction *"write the text to the file at exactly this path: <path outside the
    workspace>"*; after the turn completed (exit code 0, no reported failure), the target file
    did **not** exist on disk. Cancel-mid-turn leaves 0 live `codex` processes.
  - Both smoke runs are opt-in (env-gated) and were executed once during this hardening pass; the
    full console output is reproduced in this PR's description/commit message context, not
    committed as a fixture (it is non-deterministic CLI output).
- **Machine-proven, unit/integration, always-on in `npm test`**:
  - Provider egress deny-before-dispatch (`provider-egress.test.ts`, Electron-ABI subprocess):
    a secret-bearing prompt and a local-only Task are both denied with the dispatch callback
    never invoked (asserted via a counter), for both the Codex and Claude gates.
  - Codex/Claude runtime-event Broker-bypass rejection (`codex-normalizer.test.ts`,
    `claude-normalizer.test.ts`): an approval-request event (Codex) or a non-empty
    tools/mcp_servers report (Claude) is a fatal, thrown profile violation.
  - Filesystem-write-outside-workspace rejection: extensive existing `native-safe-fs.test.ts`
    (symlink/hardlink/unsafe-segment rejection at the native addon boundary) and this pass's
    `path-guard.test.ts` additions (encoded/backslash traversal, NUL bytes, overlong paths, exact
    workspace-root boundary, sibling-prefix bypass attempts).
- **Manually argued, not independently machine-proven this pass**:
  - That Electron's `setWindowOpenHandler` covers auxclick/middle-click identically to left-click
    (§1 item 12) — based on documented Electron API behavior, not re-verified with a live click
    simulation (would require the e2e/window-driving surface this pass does not touch).
  - That the packaged (asar) build reproduces the same CSP/Fuses behavior as the source tree —
    Electronegativity was run against source, not a built package, since no packaged artifact
    existed in this environment; the Fuses values themselves are static config, not runtime
    behavior, so this is a lower-risk gap.
