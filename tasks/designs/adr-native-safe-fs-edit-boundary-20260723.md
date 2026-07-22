# ADR: Raw Node-API safe filesystem boundary for Edit Saga

- Status: Accepted
- Date: 2026-07-23
- Scope: Slice 4.7 Edit Transaction

## Context

The product design requires every edit effect and compensation restore to be bound to canonical workspace ancestry, file identity, full content hash, size, and the live policy epoch. Multi-file edits must journal before each effect, recover after a crash without replaying an unknown effect, and never overwrite an external edit during compensation.

Node's public filesystem API exposes pathname-based `rename`, `unlink`, and file creation, but not the handle-relative `openat`/`renameat` family or equivalent Windows handle operations needed to close the validation-to-effect race. The existing `PathGuard` therefore intentionally rejects write/create/rename/delete. Replacing that guard with `stat` immediately followed by a pathname mutation would weaken §12 rather than implement it.

## Decision

Implement a minimal asynchronous raw Node-API addon behind a Main-only `NativeSafeFs` TypeScript interface. Renderer, Runtime, and tools never receive the addon object or raw filesystem authority.

- The addon accepts a previously opened workspace-root identity, normalized relative path segments, expected identities/hashes/sizes, staged bytes/mode, and journaled unpredictable temp/tombstone names. It rejects absolute paths, empty/`.`/`..` segments, NUL, symlink/reparse traversal, special files, and hardlinks independently of Main validation.
- Existing-file expectations are derived from the Main-issued `FileRevisionToken`, persisted into the prepared patch and Saga, and use `SHA-256(JSON.stringify(["native-file-identity-v1", dev, ino, mode, nlink, kind]))` as the cross-boundary identity digest. `dev` and `ino` are captured with bigint stat and serialized as exact decimal strings; they are never rounded through JavaScript `number`. Runtime/Renderer values never supply this identity. A live `NativeSafeFs` session must match the workspace and lease fence before Persistence accepts the intent.
- The immutable artifact binding seals the expected regular-file mode as well as content hash and size. New files default to `0600`; update and compensation restore preserve the Main-sealed pre-revision mode. Auxiliary and final observations must match it exactly.
- It exposes only bounded edit primitives: capability probe, safe create, exchange/backup replace, no-replace move to destination/tombstone, observation, restore, and cleanup. It computes and returns final identity, SHA-256, and size.
- Work runs through `napi_create_async_work`; hashing and filesystem I/O never block Electron's Main event loop.
- POSIX walks ancestry using directory file descriptors and `openat(..., O_NOFOLLOW)`. Create/rename uses no-replace semantics. Update uses atomic exchange where supported, preserving the displaced inode until the Saga commits or compensates. Unsupported kernel/filesystem flags fail closed.
- Windows pins workspace/ancestor handles, rejects reparse points, verifies final handle paths and file IDs, and uses documented no-replace handle rename plus `ReplaceFileW` with a required backup. NTFS/ReFS behavior must be proven in Windows CI before Windows write support is advertised.
- App-private durable pre-images remain mandatory. Same-directory temp/tombstone files are only atomic-effect/recovery aids, use `0600`/exclusive creation where applicable, and are named in the SQLite journal before creation or exchange.
- Every native mutation is preceded by a durable Saga transition. The returned observation is durably recorded before publication. Recovery observes pre/post/tombstone identities and hashes; it never replays an outcome that is unknown.
- Migration v23 backfills pre-v23 Saga history with a versioned synthetic, impossible-to-authorize native identity receipt. This keeps terminal history readable while unresolved legacy work is quarantined and cannot become native write authority; those unresolved legacy Sagas require explicit manual recovery rather than automatic resume.
- Lease quarantine, expiry, revocation, and policy-epoch fencing synchronously invalidate matching NativeSafeFs sessions at the incremented fence. Every native effect must reassert the live session immediately before entering the addon.
- If native invalidation itself fails, the SQLite quarantine still commits and the Persistence client permanently disables native mutation authority for the remainder of the process. Availability may fail closed; the durable quarantine must never roll back with an external addon error.
- Addon load failure, capability-probe failure, unsupported volume/API, or packaging mismatch removes write tools from the Turn catalog. There is no JavaScript pathname mutation fallback.

## Platform verification gate

- macOS arm64/x64: add/update/delete/rename plus symlink, hardlink, parent-swap, leaf-swap, crash, directory durability, and compensation-race harnesses.
- Windows x64: public Win32 APIs only; ancestor pinning, backup identity, rollback, reparse, crash, and NTFS/ReFS matrix on a required CI job.
- Linux: `openat2`/`renameat2` when available; unsupported kernels or filesystems remain read-only. Packaging smoke alone is not evidence of write support.
- The `.node` artifact is unpacked from asar and receives an Electron ABI load/integration test on each supported OS.

## Consequences

Slice 4.7 is split internally into durable Saga/state-machine work and the native effect boundary. Domain, persistence, recovery, and fake-boundary tests may land first, but production workspace mutation remains disabled until the platform gate passes. This adds a small native TCB and build obligation, while retaining a replaceable TypeScript interface for a future out-of-process supervisor.
