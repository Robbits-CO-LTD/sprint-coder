# Image attachments design and C1a Codex slice

- Status: C1a-1 through C1a-3d complete and independently re-reviewed; final release gate pending
- Date: 2026-08-05
- Scope: FR-CHAT-04 / FR-CHAT-10, split into C1a-C1d

## 1. Outcome and slice ledger

The finished C1 series lets the Composer attach up to four PNG, JPEG, or WebP images. Before
sending, the user can verify file name, media type, size, and reference scope, remove an image, and
keep the draft across a Task switch or app restart. Accepted user messages retain the same public
metadata in history.

The implementation is split at coherent runtime boundaries:

- **C1a (this implementation):** draft custody, direct Turn acceptance, history, and Codex
  app-server `localImage` dispatch. Text remains required. Picking and sending attachments are
  unavailable while a Turn is active.
- **C1b:** queued and stop-and-send attachments. Queue ownership uses `(task_id, ordinal)`, includes
  visible blocked/retry recovery after a model change, and is not approximated in C1a.
- **C1c:** official API Provider inline images. This adds current-message exactly-once delivery that
  cannot be removed by context compaction, plus verified catalog capability enforcement.
- **C1d:** Claude CLI image input if a stable local capability is proven, then general document
  attachments under a separate format/security design.

C1a itself has three reviewable checkpoints. The user-facing capability remains disabled until
C1a-3 is green:

- **C1a-1 draft custody:** public/internal contracts, v64 draft persistence, safe picker/decoder,
  list/remove, preload API, and draft Composer UI. Proof: contract, migration, custody, IPC, and
  component tests. No Turn or Runtime behavior changes.
- **C1a-2 atomic acceptance/history:** direct-start ID binding, exact same-Task ownership,
  accepted-message metadata, reload, rollback, and Renderer reconciliation. Proof: focused
  persistence/Main/store/history tests. Outbound image dispatch remains disabled.
- **C1a-3 Codex dispatch:** custody materialization, provider-egress identity, Runtime v8
  prepare/commit, Codex `localImage`, cleanup, and capability enablement. Proof: focused
  Main/Runtime integration tests followed by the separately approved external smoke.

C1a non-goals are queue/steer/stop-and-send images, API Provider images, Claude images, documents,
drag/drop, paste, OCR, thumbnails, editing, and generated-image reuse. Issue #170 extends the same
design to Windows with a native no-reparse read primitive; it does not introduce a parallel
attachment path or relax the file-identity checks.

Clipboard paste and Composer thumbnails landed after C1a as an additive follow-up. Neither adds a
second custody path: paste keeps the bytes in Main (`clipboard.readImage()`, never Renderer-supplied
content) and reuses the same canonicalizing decoder, and thumbnails are downscaled copies delivered
as base64 for a `data:` URL. Drag/drop, OCR, and editing remain non-goals.

Cheapest coherent proof follows the checkpoints. Deterministic E2E patches Electron's native dialog
and covers selection/removal/focus, Task isolation, and restart hydration only. Direct acceptance and
dispatch use Main/Runtime integration tests with a fake Runtime boundary. The existing E2E CLI
fixture proves availability only and must never execute a Turn.

## 2. Existing-path matrix

| Path                     | Current source                                               | C1a treatment                                                                                      |
| ------------------------ | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Composer send            | `renderer/components/ChatSurface/Composer.tsx:211`           | Pass IDs only on direct start; block every send form when a Turn becomes active with draft images. |
| Optimistic state         | `renderer/store/appStore.ts:1829`                            | Keep drafts until acceptance; remove only IDs confirmed by `turn.accepted`.                        |
| Direct start             | `contracts/index.ts:2763`, `main/ipc.ts:2119`                | Split aliased schemas; capability, ID bind, message, Turn, event, and seal commit together.        |
| Queue / stop-and-send    | `contracts/index.ts:2770,2779`, `persistence.ts:11484,11576` | Unchanged in C1a; C1b owns the state machine.                                                      |
| Message reload           | `persistence.ts:11463`, `renderer/store/appStore.ts:1210`    | Join public metadata into `ChatMessage`; bytes stay Main-owned.                                    |
| Codex dispatch           | `runtime-host/codex-adapter.ts:335`                          | Use verified app-owned numbered paths as `localImage` input after v8 commit.                       |
| Claude / Mock / Provider | adapter and provider paths                                   | Refuse attachment acceptance before mutation. Provider waits for C1c.                              |
| Initial/live state       | list/snapshot and MessagePort events                         | Parse the same metadata default; old fixtures remain readable.                                     |

There is no SSE or REST route in this Electron application.

## 3. Contracts, capability identity, and persistence

Public `imageAttachmentMetadataSchema` contains only Main-generated opaque `id`, normalized
display-only `fileName`, `mimeType`, `byteLength`, and `createdAt`. Internal records additionally
carry `taskId`, nullable `messageId`, SHA-256, and canonical bytes. The public schema enforces up to
four distinct IDs, 5 MiB per image, and a 16 MiB aggregate. Output/event arrays default to `[]` for
old strict payloads; mutation arrays do not default. Non-empty text remains required.

The asynchronous readiness result is frozen into this canonical identity:

`{taskId,connectionId,providerId,modelId,runtimeKind,runtimeInstanceId,readinessRevision,catalogRevision}`

Immediately before the synchronous persistence transaction, Main supplies an immutable `ready`
Codex snapshot no older than five seconds. The transaction resolves Task selection itself and
requires exact identity/revision equality before any write. Changed or expired state returns a
retryable capability error after an asynchronous refresh; it never falls back to text-only. The
identity is checked again before Runtime prepare and before commit. C1b must check it before
cancelling an old Turn.

Migration v64 uses this DDL:

```sql
CREATE UNIQUE INDEX messages_id_task_unique ON messages(id, task_id);
CREATE TABLE image_attachments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  message_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('draft', 'message')),
  file_name TEXT NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp')),
  byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 5242880),
  sha256 TEXT NOT NULL CHECK (
    length(sha256) = 64
    AND sha256 = lower(sha256)
    AND sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  bytes BLOB NOT NULL CHECK (length(bytes) = byte_length),
  created_at TEXT NOT NULL,
  CHECK (
    (state = 'draft' AND message_id IS NULL) OR
    (state = 'message' AND message_id IS NOT NULL)
  ),
  FOREIGN KEY (message_id, task_id) REFERENCES messages(id, task_id) ON DELETE CASCADE
);
CREATE INDEX image_attachments_task_draft_idx
  ON image_attachments(task_id, created_at, id) WHERE state = 'draft';
CREATE INDEX image_attachments_message_idx ON image_attachments(message_id, created_at, id);
```

C1a-2 adds migration v65 instead of changing the already shipped v64 checksum. It adds nullable
`message_ordinal`, a partial unique `(message_id, message_ordinal)` index for accepted rows, and
insert/update guards requiring drafts to have neither owner nor ordinal and accepted rows to have
both. This preserves existing v64 drafts while making the requested attachment order durable and
unambiguous across restart.

The deliberate dual cascade through Task and Message is accepted and tested. Migration tests
inspect `foreign_key_list(image_attachments)`, run `foreign_key_check`, cover v63-to-v65,
v64-to-v65, and idempotent reopen, and inject migration/acceptance failures. All selection, binding, and message
event assembly uses the one Persistence-owned `better-sqlite3` connection. Decoder/file I/O finishes
before the synchronous transaction; it rechecks immutable IDs, BLOB lengths, hashes, ownership, and
exact affected-row counts.

Draft removal constrains attachment ID, Task, and draft state and changes exactly one row. Acceptance
rejects duplicate IDs, selects exactly all requested same-Task drafts, rechecks count/aggregate, then
conditionally updates exactly N rows while creating message, Turn, event, context seal, and ownership
in one transaction. C1b later adds `(task_id, queue_ordinal)` ownership; operation ID is not identity.

## 4. Safe input and canonical decoding

`attachments.pick(taskId)` opens Electron's native dialog in Main. On macOS/Linux, Main opens the
selected path once with `O_RDONLY | O_NOFOLLOW`, uses only that descriptor, requires a regular file
with link count one, and compares handle `fstat` device/inode/size/mtime/ctime before and after the
bounded read. `ELOOP`, `EMLINK`, identity change, non-regular input, or mutation becomes one generic
unsafe-file UI error plus a structured internal reason. Tests cover symlink, hard link, non-regular,
symlink replacement before the single open, and mutation-during-read. A regular-file replacement
before the first open is the input that gets opened and is part of the excluded same-UID race
boundary because there is no trusted pre-open inode identity. On Windows, Main uses the existing
native-safe-fs addon to call `CreateFileW` with `FILE_FLAG_OPEN_REPARSE_POINT`, rejects reparse tags,
directories and multiple links, compares file ID, volume, size and timestamps before/after the
bounded read, and requires the final normalized handle path to match the selected absolute path.
Main never uses `lstat(path)` followed by an ordinary reopen.

C1a adds `sharp` as an exact direct desktop dependency and runs its native rebuild/package gate.
Input is capped at 5 MiB before decode. `sharp` uses `limitInputPixels: 16777216`, `animated: false`,
`unlimited: false`, and `failOn: 'warning'`; metadata must satisfy `(pages ?? 1) === 1`, report
PNG/JPEG/WebP, dimensions `1..8192`, and at most 16,777,216 pixels. Orientation is applied,
ICC/EXIF/XMP are stripped, and Main re-encodes to a fresh non-animated image in the same format.
The returned output `info.format`, width, height, and size are verified again. Only canonical output
is checked against 5 MiB, hashed, stored, materialized, and sent; trailing data/polyglots cannot
become outbound content. Tests include truncation, trailing/polyglot input, declared-dimension
bombs, APNG, animated WebP, malformed 64-character nonhex hashes, and over-limit canonical output.

Display basenames are NFC-normalized and reject NUL, C0/C1 controls, separators, bidi
embedding/override/isolate characters, and empty/dot basenames. Original paths and original bytes
are never persisted, logged, returned to Renderer, or sent externally.

## 5. Custody, egress identity, and Runtime v8

One Main-owned `AttachmentCustodyStore` uses
`app.getPath('userData')/attachment-custody`. Installation initialization creates a root marker with
`O_CREAT|O_EXCL|O_NOFOLLOW`, mode `0600`, and a random installation nonce; an existing root is used
only after no-follow directory/marker validation. Each random per-Turn directory has an exclusive
marker bound to `{installationNonce,turnId,operationId,manifestDigest}`. Canonical files are fsynced,
created exclusively, then chmod `0400`; the directory becomes `0500`. Main retains open handles until
Runtime commit completes. Cleanup accepts only an exact in-memory registry entry, never a
protocol-derived path.

Cleanup is idempotent after completion/error, egress denial, workspace-health failure, protocol
mismatch, confirmed/forced cancel, RuntimeHost exit/restart, dispatch exception, `IpcRouter.dispose`,
and app shutdown. A running Runtime stops before custody removal. Startup scavenging enumerates
direct children only, rejects symlinks, opens markers no-follow, validates installation nonce and a
bounded schema, and removes only validated entries. DB BLOBs remain after temporary cleanup.

Hostile same-UID processes are outside C1a's threat boundary because Codex accepts only a pathname;
`0400`/`0500`, retained handles, and immediate reverification reduce accidental mutation but cannot
make the API cryptographically immutable.

The ordered manifest is `{id,mimeType,byteLength,sha256}[]` over canonical bytes.
`ProviderEgressInput` and provider `PermissionResource` add `attachmentManifestDigest` and
`attachmentByteCount`. ResourceSet containment, resource identity/fingerprint, reviewer digest,
persisted audit, and broker revalidation require exact equality. `byteCount` is an overflow-checked
sum of UTF-8 text and attachment bytes under the existing resource ceiling. The manifest digest is
also in `executionSpecDigest`. A permit is minted only for the prepared manifest and revalidated at
commit; a text-only permit cannot authorize images.

Runtime protocol bumps 7 to 8 and is explicitly two phase:

1. Main sends `prepare` bound to runtime instance, Task, Turn, operation, selection identity,
   ordered manifest, and numbered custody paths.
2. Host opens paths no-follow, decodes, hashes, compares, then replies `prepared` with manifest digest
   and decoded byte count **without** invoking Codex `turn/start`. This is not `started`.
3. Main compares it, rechecks current selection/readiness/policy, constructs and revalidates the exact
   permit, then sends a one-shot `commit` bound to the same IDs, instance, and digest.
4. Host rejects duplicate/stale/mismatched commits, re-fstats and re-hashes immediately before
   constructing `localImage`, and only then invokes Codex `turn/start`. Its existing `started`
   acknowledgement remains the actual Turn-start acknowledgement.

No commit, a bounded prepare timeout, mismatch, Host restart, or duplicate terminates prepared state
and triggers cleanup. `RuntimeHostClient.active` stores expected manifest and phase. C1c Provider
delivery later fetches the accepted current message by ID and delivers exactly once independently of
compactable history.

## 6. IPC and UI state machine

The `attachments` namespace has `capability(taskId)`, `pick(taskId)`, `listDraft(taskId)`, and
`remove({taskId,attachmentId})`. The canonical Task/selection identity binds capability, pick, and
acceptance. Missing/stale/Mock/Claude/non-ready states and unavailable native Windows custody are
unsupported with a reason.
Contracts, `IPC_CHANNELS`, Main schema map, preload, ambient `SprintCoderApi`, and tests change
together.

The plus menu says `画像を添付`. Draft rows show name, formatted size/type, and a remove button whose
accessible name contains the file name. A visible label says `参照範囲: この送信のみ`: bytes are sent
only with this direct Turn, history retains metadata only, later Turns do not automatically resend
them, and reuse is outside C1a.

Renderer owns `draftAttachmentsByTask`, per-Task request revisions, and pick/remove in-flight IDs.
Hydrate/rejection refresh applies only if Task/revision still matches. Accepted IDs clear only after
a matching `turn.accepted`; a stale response cannot overwrite newer pick/remove. The interface
`startTurn(taskId,text,skills,attachmentIds)` stays consistent across contracts, preload, ambient
types, and store. Optimistic messages may show public metadata, then reconcile to the accepted
message identity. Post-accept Runtime failure keeps metadata in auditable history.

If a Turn is active while a draft exists—including the race after pick but before click—the Composer
disables send, queue, and stop-and-send and displays
`画像添付は実行中のTurnにはキュー追加できません。完了後に送信してください`. It never queues
text alone or discards the image. Attach is unavailable during active Turn or Goal mode; Goal cannot
arm while drafts exist. Goal/image-generation one-shot state becomes Task-keyed.

After removal, focus moves to next remove, previous remove, plus trigger, or textarea. `ComposerMenu`
exposes the trigger focus boundary. Failure retains the button. Controls are at least 24x24 CSS px;
status/errors use `aria-live`/`role=alert` without focus theft and persistent actionable text uses
`aria-describedby`. Chips wrap without horizontal scrolling at 200% zoom. IME/multiline/long-text
behavior remains unchanged.

## 7. State matrix

| State/event                      | Result                                                                |
| -------------------------------- | --------------------------------------------------------------------- |
| Picker cancel                    | No row/UI change; focus returns to plus trigger.                      |
| Unsafe/oversized/malformed image | No row; persistent actionable error; text unchanged.                  |
| Task switch/restart              | Reload only owning Task's drafts.                                     |
| Direct start accepted            | Capability, bind, message, Turn, event, and seal commit atomically.   |
| Pre-commit rejection             | Drafts remain; guarded refresh from Main.                             |
| Runtime failure after acceptance | Message and metadata remain in history.                               |
| Active Turn with draft           | Pick/send/queue/stop-and-send disabled with reason; no text fallback. |
| Selection leaves ready Codex     | Draft remains; pick/send block until remove or supported selection.   |
| BLOB/custody/manifest mismatch   | Fail closed before Codex `turn/start`.                                |

## 8. Verification and rollout

1. **C1a-1:** contracts; v1/v63-to-v64 and reopen; FK inspection/check; draft CRUD/cascade;
   decoder/file races; IPC/preload/ambient parity; Composer list/remove/focus/scope; packaged `sharp`.
2. **C1a-2:** duplicate/partial/stale/cross-Task IDs; atomic rollback injection; accepted history and
   reload; guarded Renderer reconciliation; active-Turn race; Goal/image mode Task isolation.
3. **C1a-3:** provider ResourceSet/identity/fingerprint/audit/overflow tests; v8 prepare/commit
   ordering, timeout, duplicate, mismatch, restart and cleanup; Codex localImage; Claude/Mock refusal.
4. **Deterministic E2E:** patch `dialog.showOpenDialog` like existing Project/file-edit specs; use
   production Main validation/storage; cover cancel focus, restart, Task isolation, scope label, 200%
   zoom, keyboard removal, active-Turn reason. Never execute fixture CLI.
5. **External gate after explicit approval:** one real Codex question about a synthetic image; assert
   original name/path never appears in outbound audit or output.

The implementation file map includes contracts/tests; persistence/tests; a new Main attachment
store/tests; Main IPC/provider-egress/domain permission/tests; preload and ambient API; Runtime Host
client/protocol/index/Codex adapter/tests; store/Composer/ComposerMenu/Timeline/MessageBubble/tests;
CSS/E2E; and packaging when `sharp` is introduced. Each checkpoint updates only its relevant subset.

The change crosses shared contracts and more than six files. Independent design re-review is
required before C1a-1; implementation-safety and requirement rechecks are required before PR.

## 9. C1a-1 checkpoint evidence (2026-08-05)

- Three independent design reviews: GO after Runtime/DDL/security/scope corrections.
- Focused post-fix checks: contracts, bounded decoder/read, IPC public-error mapping, v64 migration,
  Renderer revision/live-announcement/policy/focus tests, typecheck, and touched-file lint: green.
- Desktop subsystem: 155 test files passed, 2,316 tests passed, 76 skipped; contracts: 42 passed.
- macOS arm64 production package: built successfully; Sharp 0.35.3 addon and libvips were unpacked,
  signed, and `codesign --verify --deep --strict` passed.
- Post-review findings fixed with regressions: fixed-length positional read plus overflow probe,
  non-leaking `INVALID_REQUEST` mapping, focus-preserving remove state, Task-local live/error state,
  and direct Task cascade proof.
- Scope invariant preserved: Turn start/queue/stop schemas, message history ownership, provider
  egress, Runtime protocol, and Codex adapter behavior are unchanged; production attachment
  capability remains unsupported until C1a-3.

## 10. C1a-2 checkpoint evidence (2026-08-05)

- Three independent checkpoint reviews: scope GO; implementation and security GO after four
  concrete blockers were fixed with regressions.
- Contracts: 43 passed. Focused Renderer/Main: 832 passed. Electron-ABI persistence bridge: 122
  collected, 121 executed and passed, one Windows-only test skipped. Contracts and desktop
  typechecks, formatting, and `git diff --check`: green.
- v65 preserves existing drafts and requested history order. Because v64 never exposed acceptance
  and has no trustworthy ordinal, any pre-existing message-owned v64 row makes migration fail
  closed and rollback; tests prove row/schema preservation and `foreign_key_check` cleanliness.
- Direct acceptance validates the transaction-resolved Task/model/runtime selection, exact
  same-Task ownership, count/aggregate, BLOB length/hash, and exact affected-row counts before one
  transaction commits message, ordered ownership, Turn, event, and context seal.
- Composer now reaches the supported direct-send path with IDs in visible order. Optimistic public
  metadata reconciles to `turn.accepted`, while a concurrently added draft remains. Reload and
  history render metadata only; canonical bytes are neither queried for history nor exposed to
  Renderer.
- Scope invariant preserved: queue, steer, stop-and-send, provider egress, Runtime protocol, and
  Codex adapter are unchanged. Main still supplies a false production capability validator until
  C1a-3 adds the expiring Runtime/readiness identity and two-phase egress boundary.

## 11. C1a-3a/3b foundation checkpoint evidence (2026-08-05)

- Three independent checkpoint reviews are GO after capability-generation, lifecycle, custody,
  crash-recovery, and accepted-row completeness findings were fixed with regressions.
- Runtime capability captures bind Task selection, Codex host kind and instance, readiness/catalog
  revisions, and selected-model membership. Observations expire after five seconds and refresh
  asynchronously with unique echoed operation IDs; late, duplicate, disposed, timed-out, exited,
  or force-restarted generations cannot restore or strand readiness.
- Accepted canonical bytes are loaded only through the exact Task/Turn/user-message relation,
  rehashed, copied, and compared in order with immutable `turn.accepted` metadata. Missing,
  reordered, or byte-corrupted accepted rows fail closed before custody.
- Main custody uses an installation marker, private per-Turn directories, ordered manifests,
  exclusive/no-follow bounded I/O, retained handles, identity rechecks, exact-object leases,
  retryable idempotent release, and candidate-aware startup scavenging. Empty private roots left by
  an initialization crash recover safely; foreign or substituted paths are never deleted.
- Focused checkpoint: capability/custody/Runtime protocol plus Electron-ABI persistence bridge,
  35 parent-process tests passed; desktop typecheck, touched-file lint/format, and diff check are
  green. The Electron bridge also exercised the complete persistence integration suite.
- Scope invariant preserved: Runtime protocol remains v7 start/cancel behavior, no custody path is
  sent yet, Codex `localImage`, two-phase v8 prepare/commit, provider egress permission, and public
  capability enablement remain C1a-3c/3d. Production image dispatch is still disabled.

## 12. C1a-3c Runtime v8 checkpoint evidence (2026-08-05)

- Three independent checkpoint reviews are GO after lifecycle, cancellation, timeout, decode,
  collision, and event-buffer findings were fixed with regressions.
- Protocol v8 adds exact `prepare_images` / `images_prepared` / `commit_images` identities without
  weakening text-only start validation. Main accepts one exact in-memory receipt, binds it to the
  current Runtime instance, and coalesces bound pre-commit cancellation.
- Runtime Host validates the ordered manifest and custody paths, reads no-follow through retained
  handles, performs a full bounded pixel decode, and re-fstats/re-hashes immediately before Codex
  `turn/start`. Only then does the adapter construct ordered app-server `localImage` inputs.
- Duplicate/in-flight prepare, ordinary-start collision, mismatched/late commit, whole-prepare
  timeout, cancellation, Host exit/restart, stalled RPC, child error, and adapter timeout all
  invalidate state and release exactly once. Abort closes retained handles even while native decode
  remains pending; late completion cannot resurrect terminal state.
- Image commits buffer provider events until `started`, capped at 256 events and 1 MiB; overflow
  fails closed and releases custody. Existing text-only acknowledgement timing remains unchanged.
- Runtime subsystem checkpoint: 17 test files passed, 158 tests passed, 17 opt-in real-provider
  smoke tests skipped. Desktop typecheck, touched-file lint/format, and diff check are green.
- Scope invariant preserved: Main production wiring still rejects attachment acceptance. Provider
  egress permit binding, final capability enablement, and custody release integration remain
  C1a-3d; no real Codex/provider execution was performed.

## 13. C1a-3d production integration checkpoint evidence (2026-08-05)

- Renderer submits the exact capability selection digest with an image Turn. Main refreshes Codex
  readiness, validates the digest before the transaction and again inside attachment acceptance,
  then retains the accepted capability binding by Turn until dispatch or cleanup.
- Main loads only the canonical accepted Task/Turn attachments, materializes one exact custody
  lease, refreshes selection/readiness before and after Runtime preparation, and commits only the
  matching in-memory Runtime receipt.
- Provider permission resources, ResourceSets, resource identity, request fingerprint, reviewer
  digest, persisted audit digest, execution-spec digest, and broker revalidation now bind the exact
  attachment manifest and byte count. Text-only permission facts are explicitly `null` / zero and
  cannot authorize an image commit; total egress byte arithmetic is overflow checked.
- Custody cleanup is wired to started acknowledgement, preparation/dispatch failure, egress denial,
  confirmed or forced cancellation, Turn completion, Runtime failure, Router disposal, and startup
  scavenging. Prepared Runtime state is canceled before custody removal on pre-commit teardown, and
  failed lease removal stays retryable.
- Capability remains fail closed for a non-Codex or stale model selection, non-ready Codex, and
  unavailable custody initialization. Windows is enabled only when native no-reparse reading and
  private-ACL custody initialize successfully. Mock, Claude, external Provider, and disabled Team
  routes cannot consume accepted image attachments.
- Focused checkpoint before independent review: contracts/domain/desktop typechecks are green;
  contracts, permission, renderer attachment, IPC fuzz, capability, custody, provider-egress, and
  Runtime Host suites passed. No real Codex/provider execution was performed.
- The first checkpoint review found that a rejecting forced/unconfirmed Runtime cancellation could
  skip custody release. Cancellation now releases in `finally` while preserving the cancellation
  error; a focused Main regression injects that rejection and proves cancel-before-release order.
  A second Main-boundary regression drives canonical accepted bytes through the production custody
  and Runtime preparation methods and verifies exact receipt facts and release. Scope, security,
  and implementation/lifecycle re-reviews are all GO with no remaining concrete findings.
- The first PR CI run exposed a Linux-only package failure: Sharp's versioned
  `libvips-cpp.so.8.18.3` did not match the prior exact `.so` asar-unpack suffix. The native unpack
  glob now includes `.so.*`, with a Forge regression that pins versioned Linux shared-library
  handling; macOS had already passed because its `.dylib` matched the existing rule.
- The second PR #130 CI run confirmed that the original slice correctly failed closed on Windows,
  but exposed six
  POSIX file-safety/image-decoder tests that had not been platform-gated. Those tests now run only
  where the POSIX no-follow contract exists; filename validation remains cross-platform, and a
  Windows-specific regression proved rejection occurred before the selected path or persistence was
  touched. Issue #170 supersedes that temporary gate with native read, hard-link, junction, custody,
  Runtime preparation, and packaged E2E coverage.
- The next Windows shard exposed an initialization-failure resource leak: a deliberately rejected
  then-v65 migration left the opened SQLite handle alive, so Windows correctly refused to remove the
  locked test directory. `SqlitePersistenceClient` now closes the database on any post-open
  initialization failure while preserving the original error. The exact migration refusal test and
  the complete 122-test Electron-ABI persistence suite pass locally; Windows CI remains the
  same-observation-point proof for lock release.
- The review bot found one public type-contract omission: `turnStartInputSchema` and the renderer
  declaration required `attachmentSelectionIdentity`, but `SprintCoderApi.turns.start` did not
  expose it. The contracts interface now matches the validated IPC input exactly.
