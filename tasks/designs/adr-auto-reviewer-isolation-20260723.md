# ADR: Isolated deterministic baseline for Auto approval review

- Status: Accepted
- Date: 2026-07-23
- Scope: Slice 4.5 Approval and Auto reviewer

## Context

The Auto preset needs a reviewer that can grant only one exact execution and must receive immutable policy and risk facts without transcript, raw paths, tool output, credentials, tools, or network access. The production Codex CLI adapter is isolated in a UtilityProcess and read-only, but its current contract does not prove a no-tools/no-network reviewer boundary. Reusing it would also expose the selected workspace as its working directory.

## Decision

Use a Main-owned deterministic risk reviewer as the first Auto-reviewer implementation. Its model boundary accepts a deeply frozen, versioned facts object containing only capability, operation, digests, policy epoch, provider-egress, sandbox, risk, and tool classification. It has no filesystem, process, Runtime, Renderer, or network dependency.

High-risk requests are denied before model invocation. The built-in policy permits only low-risk read operations with no provider egress, a non-full sandbox, and no mutating side effect. A successful response can issue only `allow_once`; its nonce, request fingerprint, execution digest, input digest, and policy epoch are generated or bound in Main. Timeout, exceptions, unknown fields, unknown decisions, and unknown reason codes fail closed. Terminal decisions are cached by review request ID so a late response cannot change a denial.

Production construction is fixed to the synchronous built-in reviewer; model injection is exposed only through an explicitly test-only factory. The final effective policy decision, immutable reviewer authority row, permission audit, Turn event, and any hashed one-time permit are committed in one SQLite transaction before UI publication. Reviewer permits are bound to review request, Task, Turn, call, subject, capability facts, execution digest, and policy epoch. A crash before this transaction leaves no decision or permit and the existing restart recovery interrupts the Turn, so there is no durable pending reviewer authority to resume.

The model function remains an injected interface for tests and a future managed-provider implementation. Connecting Codex CLI or a remote provider to this interface is prohibited until a separate adapter proves no-tools/no-network isolation and routes any egress through the provider-egress policy boundary.

## Consequences

Auto is intentionally conservative and will still deny writes, commands, process execution, network access, and medium/high-risk operations. Ask mode continues to use explicit user approval. This baseline provides deterministic behavior and a security boundary now; broader semantic review requires a later ADR and security gate.
