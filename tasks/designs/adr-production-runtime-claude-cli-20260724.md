# ADR: Claude CLI as a second production Runtime Adapter

- Status: Accepted
- Date: 2026-07-24
- Scope: Slice 3.4 Production Runtime Adapter (Claude twin of Slice 3.3)

## Context

Sprint Coder already has one production runtime behind the Runtime Host boundary in §11: Codex
CLI (`tasks/designs/adr-production-runtime-codex-cli-20260722.md`). This ADR adds the locally
installed Claude Code CLI (`claude`, verified against v2.1.218) as a second, architecturally
parallel production runtime, with the same non-interactive, read-only, Main/Renderer-isolated
profile.

## Decision

Use the locally installed Claude Code CLI through a fixed, immutable per-turn invocation:

```
claude -p --output-format stream-json --verbose --include-partial-messages \
  --tools "" --strict-mcp-config --safe-mode \
  --no-session-persistence [--model <id>]
```

Run it in the same Electron UtilityProcess-owned Runtime Host used for Codex. A single Runtime
Host process hosts exactly one adapter kind, selected at spawn time via a `--runtime-kind`
argument (`codex` default, `claude` opt-in) read by `runtime-host/index.ts`; Main's
`RuntimeHostClient` gains a `kind` constructor parameter and `IpcRouter` holds two independent
`RuntimeHostClient` instances (`codexRuntime`, `claudeRuntime`). The prompt is written to the
child's stdin (verified: `claude -p` reads the prompt from stdin when no positional argument is
given, exactly like Codex's `-` convention). cwd is the task workspace if set, else an ephemeral
temp directory. Provider JSONL is normalized inside the UtilityProcess (`claude-normalizer.ts`)
into the same canonical protocol events Codex emits, and is never sent to Main or Renderer
un-normalized.

### Flag-by-flag rationale (verified against the installed CLI's `--help` and real probes)

| Flag                          | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `-p` (`--print`)              | Non-interactive, exits after one response; required for any headless use.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `--output-format stream-json` | Machine-readable streaming JSONL on stdout (Codex's `--json` analog).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `--verbose`                   | **Required** by the CLI: without it, `stream-json` under `--print` fails immediately with `Error: When using --print, --output-format=stream-json requires --verbose` (confirmed by direct probe).                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `--include-partial-messages`  | Emits token-level `stream_event`/`content_block_delta` events (Anthropic Messages-API-shaped), giving real incremental text streaming instead of one delta at turn end. Chosen over the coarser default (whole-message-only `assistant` events) for a materially better streaming UX; the normalizer is written against the fixed flag set as an invariant (see below).                                                                                                                                                                                                                                                                                                  |
| `--tools ""`                  | Disables every built-in tool. Verified via probe: `system/init` reports `"tools":[]`. This is the primary read-only/no-execution guarantee — stronger than Codex's `--sandbox read-only` (which still permits read-only shell/file access): no tool exists to invoke at all, so no file write, no command execution, and no read access is possible either.                                                                                                                                                                                                                                                                                                              |
| `--strict-mcp-config`         | Only load MCP servers from `--mcp-config` (none is ever passed), ignoring all project/user MCP configuration. Verified via probe: `system/init` reports `"mcp_servers":[]` even though this machine's user config has MCP servers configured.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `--safe-mode`                 | Disables CLAUDE.md auto-discovery, plugins, hooks, custom commands/agents, output styles, and workflows for the session (`CLAUDE_CODE_SAFE_MODE=1`), the Claude analog of Codex's `--ignore-user-config --ignore-rules`. Crucially, per its own `--help` text, "Auth, model selection, built-in tools, and permissions work normally" — unlike `--bare`, `--safe-mode` does **not** force API-key-only auth, so the CLI's own local auth (OAuth/keychain) keeps working, satisfying "no API keys handled by the app." Verified via probe with a minimal env (no `ANTHROPIC_API_KEY`): `system/init` reports `"apiKeySource":"none"` and the turn completes successfully. |
| `--no-session-persistence`    | Turn is ephemeral: no session is written to disk and none can be resumed later (Codex's `--ephemeral` analog). Only valid with `--print`, which this profile always uses.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `--model <id>`                | Omitted entirely for the `auto` sentinel (falls back to the CLI's own default model), passed through otherwise. Verified aliases `sonnet`/`opus`/`haiku` each resolve to a concrete model id at session init (`claude-sonnet-5`, `claude-opus-4-8`, `claude-haiku-4-5-20251001` respectively, on this CLI version).                                                                                                                                                                                                                                                                                                                                                      |

Flags evaluated and **not** used: `--allowedTools`/`--disallowedTools` (redundant once `--tools ""`
disables everything), `--max-turns` and `--session-id` (do not exist on this CLI version's
`--help`; the adapter's own 10-minute timeout — identical to Codex's — is the safety net instead),
`--bare` (rejected: forces `ANTHROPIC_API_KEY`-only auth, violating the "use the CLI's own auth"
requirement).

### Normalizer event mapping (Claude stream-json → canonical protocol)

| Claude JSONL                                                              | Canonical event                                                                                                                                          | Notes                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `system`/`init`                                                           | `stage: 'understanding'`                                                                                                                                 | Also verifies `tools: []` and `mcp_servers: []` — a non-empty report throws `ClaudeCapabilityViolationError` (fatal, non-retryable), the Claude analog of Codex's `ApprovalRequestedError` defense.                                                                                                                                  |
| `stream_event` / `content_block_delta` with `delta.type === 'text_delta'` | `stage: 'planning'`, `stage: 'executing'`, `stage: 'synthesizing'` (via the same `advanceTo` stage-filling helper Codex's normalizer uses), then `delta` | Other `stream_event` subtypes (`message_start`, `content_block_start/stop`, `message_delta`, `message_stop`) and non-text-delta deltas are ignored.                                                                                                                                                                                  |
| `assistant` (full message)                                                | _(ignored)_                                                                                                                                              | Superseded by the `stream_event` deltas already emitted for the same content — since the flag set always includes `--include-partial-messages`, this is a documented invariant, not a heuristic. Also carries a same-turn `error` field on model failures, but the terminal `result.is_error` check below is sufficient and simpler. |
| `result` with `is_error: true`                                            | _(throws `ClaudeOutputError`)_                                                                                                                           | Mapped to `RUNTIME_FAILED`/`RUNTIME_PROTOCOL_ERROR` by the adapter, same as Codex's `turn.failed`.                                                                                                                                                                                                                                   |
| `result` with `is_error: false`                                           | `completed` (idempotent)                                                                                                                                 | No `usage` field exists on the canonical protocol today — Codex's own normalizer already discards `usage` from `turn.completed` (see `codex-normalizer.ts`), so Claude's `usage` is discarded identically rather than growing the protocol unilaterally. See Deviations below.                                                       |
| `rate_limit_event`, other `system` subtypes (e.g. `post_turn_summary`)    | _(ignored)_                                                                                                                                              | Forward-compatible: unrecognized-but-well-formed types return `[]`, only unparsable JSON or a missing/non-string `type` throw.                                                                                                                                                                                                       |

## Rationale

Claude Code is already installed locally, provides a JSON streaming output format, and — with
`--tools ""` plus `--strict-mcp-config` — has an even stronger capability-denial guarantee than
Codex's sandboxed read-only mode (zero tools exist, vs. read-only shell/file access). This
minimizes new distribution and parsing risk while preserving the provider-neutral, versioned
Runtime Host boundary and the exact test/fixture idioms already established for Codex.

Model enumeration differs from Codex: Codex ships a `models_cache.json` under `$CODEX_HOME` that
the adapter parses; the installed Claude CLI has no equivalent enumerable catalog. A static
curated list (`auto`, `sonnet`, `opus`, `haiku`) ships instead, each alias verified to resolve to a
concrete model id via a real probe. Main validates `settingsSetModel` against the _currently
active_ Runtime kind's own capability list (Codex's or Claude's are disjoint id spaces), so a
Codex model id can never leak into a Claude turn or vice versa — the renderer only ever sees
already-validated display entries for the active kind.

## Amendment (2026-07-24)

`--permission-mode plan` was removed after real-team smoke testing: with `--tools ""` it added no enforcement, and plan mode made the model narrate planning mechanics (ExitPlanMode, plan files under ~/.claude/plans) into user-visible answers and Worker reports. The read-only/no-tools guarantee rests on `--tools ""` + `--strict-mcp-config` + `--safe-mode`, which are all still verified by the adapter tests and the codex/claude smoke suites.

## Amendment 2 (2026-07-25): model clarity + effort control

User complaints: the curated model list's bare labels ("Sonnet"/"Opus"/"Haiku") don't say what
concrete model actually runs, and the Composer's "effort: medium" chip was static decoration from
the design mock with no way to change it. Both were re-verified empirically on the installed CLI
(2.1.218) before changing any UI.

**Model clarity.** `claude --help`'s own `--model` doc already names the effective default alias
family (`--model <model> Provide an alias for the latest model (e.g. 'fable', 'opus', or
'sonnet') or a model's full name`). Real probe turns (`claude -p "1" --model <alias>
--output-format json`) confirmed each curated alias's resolved id via the result's
`modelUsage`/`canonicalModel` field: `sonnet` → `claude-sonnet-5`, `opus` → `claude-opus-4-8`,
`haiku` → `claude-haiku-4-5-20251001` (`canonicalModel: claude-haiku-4-5`), and the `auto`
sentinel (no `--model` flag at all) also resolves to `claude-sonnet-5` on this installation.
`CLAUDE_MODELS` in `claude-adapter.ts` now spells out each concrete id in its displayName/
description instead of a bare label. A `fable` alias also resolves (to `claude-fable-5`) but was
deliberately left out of the curated list — it isn't part of `--help`'s own example set and adding
it is a curation call beyond "clarify the existing labels."

Additionally, the stream-json `system/init` event carries the resolved `model` field per turn
(confirmed both via the recorded `runtime-host/fixtures/claude-normal.jsonl` fixture and a live
probe). `ClaudeJsonlNormalizer` now captures it and surfaces it on the canonical protocol's
`completed` event (`resolvedModel?: string`, additive/optional — Codex's normalizer never sets
it). `IpcRouter` folds it into the `turn.completed` `TurnEvent` (also additive/optional, not
persisted to the turns table — a live-only surface), and the renderer shows it in the model chip's
tooltip after a Claude turn completes ("Modelを選択（直近のTurnで実際に使用: claude-sonnet-5）").

**Effort control.** `claude --help` documents `--effort <level>  Effort level for the current
session (low, medium, high, xhigh, max)`, and a probe with an invalid value (`--effort bogus`)
printed a non-fatal warning naming the same 5 valid values and fell back to the CLI's default —
confirming the exact enum without guessing. A real differential probe (`--model opus`, prompt
`"1"`, otherwise identical invocation) proved the flag actually changes CLI behavior: `--effort
low` produced zero `thinking_tokens` events, while `--effort max` produced a growing extended-
thinking budget (`system/thinking_tokens` events, 50 → 165 estimated tokens) before the same
`claude-opus-4-8` model answered — i.e. effort is honored, not merely accepted and ignored.

Effort is therefore implemented as a real, persisted, Claude-only control, mirroring the existing
model mechanism: `claudeEffortSchema` (contracts), `runtime.claude.effort` settings key
(persistence — a single global key, not scoped per Runtime kind like `model`, since effort only
ever applies to a Claude turn), `settingsSetEffort` IPC channel/mutation, an `effort?: string`
field on the Runtime Host protocol's `start` envelope (Codex's adapter accepts and ignores it, for
call-signature parity — RUNTIME_PROTOCOL_VERSION bumped 4→5 for both this and the `completed`
event's `resolvedModel` addition), and `buildClaudeArgs` appending `--effort <level>` verbatim.
The Composer's effort chip (`data-testid="effort-selector"`) is a real interactive menu (low/
medium/high/xhigh/max) when Claude is the active, available Runtime, and a disabled static display
otherwise (mock/Codex/Claude-unavailable) — mirroring `ModelChip`'s enable/disable pattern.
Team Workers (`team-worker-runtime.ts`) do not currently thread this setting through; they pick
their own model per hire and are out of scope for this pass.

## Consequences

- Claude is selectable in Settings only after a successful startup probe (`claude --version` +
  parse, mirroring Codex's probe; no billable turn is ever run during probing).
- It cannot accept mid-run steering (headless single-shot invocation): steering returns
  `STEER_UNSUPPORTED`, exactly like Codex. `IpcRouter`'s steer gate now blocks on either
  non-mock kind rather than `=== 'codex'` specifically.
- Cancellation terminates the CLI process tree (same local `terminateProcessTree`/`signalTree`
  SIGTERM→SIGKILL dance duplicated into `claude-adapter.ts`, matching the Codex adapter's
  self-contained idiom rather than a shared cross-file utility) — no orphan processes.
- Egress gating: `provider-egress.ts`'s Codex-specific function was generalized into a shared
  `authorizeProviderEgress` helper parametrized by `providerId`/`subjectId` prefix/audit reason,
  with `authorizeCodexProviderEgress`/`dispatchAfterCodexProviderEgress` kept as unchanged public
  exports (verified byte-for-byte identical behavior against the existing Codex egress tests) and
  new `authorizeClaudeProviderEgress`/`dispatchAfterClaudeProviderEgress` twins
  (`providerId: 'anthropic-claude-code'`, `auditReason: 'claude_provider_egress'`) added
  alongside. Both share the same `provider.egress` Capability and Permission-policy machinery.
- Persistence: `turns.runtime_kind` and `agent_threads.runtime_kind` CHECK constraints only
  allowed `('mock', 'codex')`. SQLite cannot alter a CHECK constraint via `ALTER TABLE`, so
  migration v30 rebuilds both tables (create-new-name → copy → drop-old → rename-new-to-old,
  never renaming the _original_ table away first, which would make SQLite rewrite every other
  table's `REFERENCES` clause to point at a transient name) to widen the constraint to
  `('mock', 'codex', 'claude')`. This requires foreign-key enforcement to be off for the
  migration (dropping a table other rows still reference otherwise triggers an implicit
  cascading `DELETE`); `runMigrations` gained an additive `requiresForeignKeysOff` flag toggled
  outside the migration's transaction (PRAGMA changes are a no-op inside one), verified
  afterward with `PRAGMA foreign_key_check`. The selected model is now stored per Runtime kind
  (`runtime.codex.model` / `runtime.claude.model` settings keys) so switching kinds does not
  clobber the other's remembered preference; `mock` shares Codex's key, preserving prior
  behavior exactly.
- Contracts: `runtimeKindSchema` gained `'claude'` additively; `runtimeSettingsSchema` gained a
  parallel `claudeAvailable: boolean` field alongside the existing `codexAvailable` (existing
  consumers reading `codexAvailable` are unaffected). The Runtime Host protocol's `hello`
  envelope gained parallel `claudeAvailable`/`claudeVersion`/`claudeModels` fields; a given
  Runtime Host process only ever populates one provider's fields meaningfully (the other side
  reports `false`/`[]`), which is validated but does not change any existing Codex-side field.
  Model id/option schemas (`codexModelIdSchema`/`codexModelOptionSchema`/`CodexModelOption`) are
  reused as-is for Claude's aliases/full ids rather than renamed, since the shape is
  provider-agnostic and renaming would be a breaking change for no functional benefit.
- Smoke marker: `SPRINT_CODER_RUNTIME_SMOKE=claude` documents manual verification intent exactly
  like `codex` does today — it is not read by any code path (confirmed for Codex too); the
  Runtime selection itself is persisted via the Settings API regardless of this marker.
