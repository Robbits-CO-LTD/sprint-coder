# Issue #444: Archify graph engineering

Canonical requirements: https://github.com/Robbits-CO-LTD/sprint-coder/issues/444, revised plan generation 2 (AC-1–AC-17, INV-1–INV-14). All requirements remain in scope.
Base: main 51f5705. Original main checkout and its five uncommitted Local AI UI files are preserved.

## Current checkpoint: Task-bound AI proposal tools

- Vendored Archify ed7f4d4b48d4424d36edfed8043de3de8dea6b45 / 2.17.0-dev.1 with both copyright holders and notices; 33 files are pinned by a compiled manifest hash.
- Main bounds input and excludes output paths, remote brand resources and repository/source lookup. Native Archify schema/geometry validation remains authoritative for rendering.
- Separate short-lived Electron utility processes run renderer and checker. No external Node installation or RunAsNode fuse change is used.
- Main verifies executable script contents against the pinned template, removes external resource links and disables unsupported export/copy controls. An app://graph capability serves the result with its own restrictive CSP; parent script-src is unchanged.
- A sandbox=allow-scripts iframe displays Architecture/Workflow beside chat. Frame identity, graph/revision, view instance and element membership gate selection messages. Closing a view expires its capability; stale cleanup cannot revoke a newer view.
- Selection comments append identifiers and the user's comment to the existing chat draft. They do not automatically send, approve or dispatch work.
- Mac development and ad-hoc packaged E2E passed actual render/check/display, theme toggle, selection, draft preservation, view expiration, focus restoration, and cancellation without replacing the previous valid graph.
- The stored-document checkpoint passed all CI at 2c08f2b (run 34524639096), including Mac/Windows packaged operations and restart restoration. Hosted tests activate the application, focus its window and verify the focus precondition before pointer input. Local E2E retains hidden/non-focus presentation. No iframe/CSP privilege is relaxed.
- At a 1024px viewport, three columns reduced the composer to about 120px. While a graph is open at widths up to 1440px, the existing sidebar drawer now preserves conversation width and restores the stored history preference on close. Fresh Mac packaged E2E verifies a composer width of at least 350px, selection/comments and sidebar restoration. The app also passes with PATH empty; updated Windows CI remains to be checked.
- Cancellation initially waited behind the Task mailbox. Render/cancel now use the Graph service's own per-Task execution tracking while retaining sender validation and the update-install mutation gate. The same packaged cancellation case passes.
- SQLite migration v84 stores successful typed IR snapshots and history per Task. It leaves pending PR #453's v83 distinct; the runner checks each applied version individually. Writes check the expected prior render revision atomically and reads verify the semantic digest. HTML/view capabilities are not persisted.
- Geometry/presentation changes retain the semantic revision; labels, relations and Workflow group membership change it. Render revisions advance independently. Restart restoration regenerates and checks saved IR with the pinned engine, preserves graph ID/semantic revision and creates a fresh viewer capability. Mac packaged restart E2E passed both diagram kinds; latest full validation is required before publishing this checkpoint.
- History and comparison APIs read saved versions without issuing another viewer lease or rendering. History is paginated in groups of 25. Main compares the same semantic projection used by the digest, reports ID additions/removals, property before/after values and presentation-only changes, and rejects unrelated/reversed comparisons.
- The Task panel displays selectable history and differences beside the actual diagram. Late comparison responses cannot replace a newer selection. The comment form folds while history is open to preserve graph space. Mac packaged E2E passed label change, layout-only change, older-version selection and restart after those revisions; the latest OS CI still needs verification.
- The difference checkpoint passed all CI at 2bd4d6d (run 34529129121, after retrying the failed/canceled test jobs without product changes).
- Migration v85 stores the latest accepted generation attempt, its ordered state and bounded failure stage. Success and the document version commit in one transaction. Failure/cancellation keep the previous valid document; restart marks unfinished attempts interrupted without changing terminal outcomes. Restore-only rendering does not erase a previous proposal failure.
- Generation updates have a separate persistent sequence. UI ignores stale/cross-Task state and identifies the saved version still being displayed. Cancellation from the UI is bound to the shown generation ID. Shutdown waits for the generation/worker acknowledgement before closing persistence; cleanup errors do not change a committed result.
- The generation-state checkpoint passed all CI at c7909cf (run 34534365130).
- graph_read_document and graph_propose_document now use the common ManagedCodingHarness catalog, shared schemas and authenticated Task/Turn context. The model cannot supply Task/actor/approval identity. Updates require the expected render revision; proposal operations pass the update-install mutation gate. Results are explicitly unverified drafts and do not start workers or Missions. The existing worker catalog allowlist excludes these Task-level planning tools.
- Proposal cancellation is connected to both the dispatch signal and owning Turn finalization, including the native MCP path that may not carry a cancelable signal. The real stdio MCP server publishes/forwards the same managed definitions. An explicit environment-gated Mock sampler drives read → propose → saved readback through the real Main/SQLite/renderer/checker path from chat; it does not generate an image or write storage itself.

## Remaining requirements (not complete)

| Acceptance | Remaining work                                                                                                                                                                    |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-1–AC-9  | Graph Mission contracts, DAG/changes/resource gates, integration checkpoints, actor visibility, branch cancellation/recovery and Canvas/List consistency are not implemented.     |
| AC-10      | Real engine display/selection is connected; broader layouts and cross-platform acceptance remain.                                                                                 |
| AC-11      | Basic Task-bound proposal/read/revision tools are connected. Main-verified SourceRefs and their disclosure/permission integration remain; current diagrams are unverified drafts. |
| AC-12      | Typed IR history, semantic/render revisions, IR difference UI and latest generation outcomes are implemented. SourceRef snapshots/differences remain.                             |
| AC-13      | Human agreement bound to current code/permissions and one-time graph Mission start remain. No graph execution exists yet.                                                         |
| AC-14      | Saved graph data regenerates on Task access after restart. Persistent selection/view settings and execution state overlays remain.                                                |
| AC-15      | The initial iframe/CSP/message boundary is tested. Source access and execution/approval refusal paths must be extended with their future APIs.                                    |
| AC-16      | Mac and Windows packaged utility/asset/display paths passed. The updated no-external-PATH and responsive layout checks remain required on the latest Windows head.                |
| AC-17      | The full propose → discuss → diff → agree → parallel execute → resource wait → join → restart flow is not implemented or accepted.                                                |

## Next action

Verify the tool-path checkpoint's current-head CI. Then add Main-verified SourceRefs to the proposal/read path through existing Workspace guards and provider disclosure checks. Extend differences to SourceRefs and Mission declarations when those contracts are added. Keep agreement and Mission dispatch out of proposal/render operations. Render revisions/view lease generations remain separate from agreement-bearing semantic revisions. Graph v84/v85 must remain distinct from pending #453's v83 through merge.

Keep this PR draft until all mandatory gates, independent review and full product acceptance are satisfied. Do not close #444 based on this rendering checkpoint.
