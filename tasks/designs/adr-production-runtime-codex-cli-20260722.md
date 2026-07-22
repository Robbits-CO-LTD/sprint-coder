# ADR: Codex CLI as the first production Runtime Adapter

- Status: Accepted
- Date: 2026-07-22
- Scope: Slice 3.3 Production Runtime Adapter

## Context

vibe-editor3 needs a first production runtime behind the Runtime Host boundary in §11. The Phase-4-and-earlier profile must be non-interactive, read-only, isolated from Main, and capable of emitting machine-readable streaming events.

## Decision

Use the locally installed Codex CLI through `codex exec --json --sandbox read-only`. Run it in an Electron UtilityProcess-owned adapter with approval disabled, ignored user rules/config, ephemeral sessions, a minimal environment, and a task workspace or empty temporary cwd. Provider JSONL is normalized inside the UtilityProcess and is never sent to the Renderer or persisted.

## Rationale

Codex is already installed locally, provides JSON output, and has an explicit sandbox flag. This minimizes new distribution and parsing risk while preserving the provider-neutral, versioned Runtime Host boundary.

## Consequences

Codex is selectable only after a successful startup probe. It cannot accept mid-run steering, so steering returns `STEER_UNSUPPORTED`. Phase-4-and-earlier execution stays read-only; broader tool access requires the future Tool Broker and security gates. Cancellation terminates the CLI process tree, and host/CLI/protocol failures terminate the Turn as failed with a normalized PublicError.
