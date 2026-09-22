# Grok CLI integration

Status: implementation; Windows real-provider acceptance pending.

## Result and boundaries

Add the official xAI Grok Build CLI as `grok`, connection `builtin:grok-cli`, provider `xai`.
Normal Tasks and Team Workers use the same Main-owned permissions, ToolBroker, MCP bridge,
workspace edits and command sessions as the existing CLI runtimes. Persist model selection
independently. Existing xAI API connections are unaffected.

The user assigned real-Grok acceptance to another Windows PC on 2026-09-22. This change's local
checks exercise protocol fixtures, migration and UI; Windows acceptance is a separate Issue.
Release publishing, changing the user's installed app and automatic CLI installation are outside
this change. Unsupported image input and effort controls are not advertised by the Grok adapter.

## Protocol and isolation

Use the official CLI 1.0.40+ (major version 1) via
`grok --no-auto-update agent --no-leader [--model MODEL] stdio`.
Initialize ACP v1, authenticate noninteractively using cached login or the explicit `XAI_API_KEY`,
then create one ephemeral session per Sprint Coder Turn. Model IDs come from the CLI's model
inventory, restricted to Grok IDs. A missing or expired login is actionable, not a successful probe.

Each process receives a fresh working directory, HOME and GROK_HOME. GROK_AUTH_PATH references
the original CLI-owned auth file so token refresh and locking remain in the CLI. No credential
is copied into Sprint Coder's database or diagnostic output. User/project CLI configs, plugins,
hooks, AGENTS.md and autonomous skills are not loaded from the actual workspace. The session
profile exposes only `search_tool`/`use_tool`; native Read/Edit/Bash/Grep/WebFetch/WebSearch
are explicitly denied, including file-backed arguments to `use_tool`. Its advertised inventory is checked before any
user prompt. Only the exact authenticated Sprint Coder MCP server and its authorized tool set
are accepted. Native ACP file/terminal reverse requests are refused. All writes and commands
therefore return to Main's existing permission and audit boundary. Grok's automatic approval
is disabled; only `MCPTool(team__*)` is allowed locally, and Main still checks each request.

Bound JSONL frames, total output, startup waits and turn lifetime. Reject session mismatches,
malformed output and incomplete terminal states. Keep activity timeouts paused while tools are
pending, and terminate the CLI tree on cancellation or protocol failure. Clean private scratch
data after confirmed process exit. Retain only allowlisted diagnostic metadata.

## Verification

1. Protocol/process tests: fragmented UTF-8, request correlation, errors, inventory refusal,
   terminal completion, cancellation and cleanup.
2. Persistence/contracts: migrate existing rows/FKs/indexes, reopen model selections and diagnostics.
3. Main/renderer: settings, catalog, provider egress, Task and Team routing, login hints and effort.
4. Windows acceptance: see `docs/testing/grok-cli-windows-acceptance.md` and the linked GitHub Issue.

## Sources

- https://docs.x.ai/build/cli/headless-scripting
- https://docs.x.ai/build/cli/reference
- https://github.com/xai-org/grok-build (reviewed 2026-09-22, source version 1.0.38)
- Official npm `@xai-official/grok-darwin-arm64@1.0.40`: version/help and uncredentialed ACP
  initialize/model discovery inspected locally. A synthetic key with API URLs pinned to
  localhost confirmed the native tool inventory and stdio MCP startup without inference.
  These are not successful inference evidence.
