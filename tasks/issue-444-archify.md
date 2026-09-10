# Issue #444: Archify graph engineering

Canonical requirements: https://github.com/Robbits-CO-LTD/sprint-coder/issues/444, revised plan generation 2 (AC-1–AC-17, INV-1–INV-14). All requirements remain in scope.
Base: main 51f5705. Original main checkout and its five uncommitted Local AI UI files are preserved.

## Current checkpoint: persisted generation outcomes

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

## Remaining requirements (not complete)

| Acceptance | Remaining work                                                                                                                                                                |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-1–AC-9  | Graph Mission contracts, DAG/changes/resource gates, integration checkpoints, actor visibility, branch cancellation/recovery and Canvas/List consistency are not implemented. |
| AC-10      | Real engine display/selection is connected; broader layouts and cross-platform acceptance remain.                                                                             |
| AC-11      | Main-verified private workspace SourceRefs and AI proposal/read/update tool integration remain. Current diagrams must not be presented as source-verified.                    |
| AC-12      | Typed IR history, semantic/render revisions, IR difference UI and latest generation outcomes are implemented. SourceRef snapshots/differences remain.                         |
| AC-13      | Human agreement bound to current code/permissions and one-time graph Mission start remain. No graph execution exists yet.                                                     |
| AC-14      | Saved graph data regenerates on Task access after restart. Persistent selection/view settings and execution state overlays remain.                                            |
| AC-15      | The initial iframe/CSP/message boundary is tested. Source access and execution/approval refusal paths must be extended with their future APIs.                                |
| AC-16      | Mac and Windows packaged utility/asset/display paths passed. The updated no-external-PATH and responsive layout checks remain required on the latest Windows head.            |
| AC-17      | The full propose → discuss → diff → agree → parallel execute → resource wait → join → restart flow is not implemented or accepted.                                            |

## Next action

Verify the generation-state checkpoint's current-head CI. Then add Main-verified SourceRefs and managed AI proposal/read/update tools through existing Workspace guards. Extend differences to SourceRefs and Mission declarations when those contracts are added. Keep agreement and Mission dispatch out of proposal/render operations. Render revisions/view lease generations remain separate from agreement-bearing semantic revisions. Graph v84/v85 must remain distinct from pending #453's v83 through merge.

Keep this PR draft until all mandatory gates, independent review and full product acceptance are satisfied. Do not close #444 based on this rendering checkpoint.
