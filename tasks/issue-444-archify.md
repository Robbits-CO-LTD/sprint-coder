# Issue #444: Archify graph engineering

Canonical requirements: https://github.com/Robbits-CO-LTD/sprint-coder/issues/444, revised plan generation 2 (AC-1–AC-17, INV-1–INV-14). All requirements remain in scope.
Base: main 51f5705. Original main checkout and its five uncommitted Local AI UI files are preserved.

## Current checkpoint: product rendering boundary

- Vendored Archify ed7f4d4b48d4424d36edfed8043de3de8dea6b45 / 2.17.0-dev.1 with both copyright holders and notices; 33 files are pinned by a compiled manifest hash.
- Main bounds input and excludes output paths, remote brand resources and repository/source lookup. Native Archify schema/geometry validation remains authoritative for rendering.
- Separate short-lived Electron utility processes run renderer and checker. No external Node installation or RunAsNode fuse change is used.
- Main verifies executable script contents against the pinned template, removes external resource links and disables unsupported export/copy controls. An app://graph capability serves the result with its own restrictive CSP; parent script-src is unchanged.
- A sandbox=allow-scripts iframe displays Architecture/Workflow beside chat. Frame identity, graph/revision, view instance and element membership gate selection messages. Closing a view expires its capability; stale cleanup cannot revoke a newer view.
- Selection comments append identifiers and the user's comment to the existing chat draft. They do not automatically send, approve or dispatch work.
- Mac development and ad-hoc packaged E2E passed actual render/check/display, theme toggle, selection, draft preservation, view expiration, focus restoration, and cancellation without replacing the previous valid graph.
- Windows packaged Architecture/Workflow E2E also passed the same operations in CI run 34520023769. Hidden CI windows dropped iframe mouse events despite complete DOM loading and no script/CSP errors; isolated CI runners now present their windows normally, while local E2E retains hidden presentation. This is a test-environment change, not a relaxation of iframe or CSP boundaries.
- At a 1024px viewport, three columns reduced the composer to about 120px. While a graph is open at widths up to 1440px, the existing sidebar drawer now preserves conversation width and restores the stored history preference on close. Fresh Mac packaged E2E verifies a composer width of at least 350px, selection/comments and sidebar restoration. The app also passes with PATH empty; updated Windows CI remains to be checked.
- Cancellation initially waited behind the Task mailbox. Render/cancel now use the Graph service's own per-Task execution tracking while retaining sender validation and the update-install mutation gate. The same packaged cancellation case passes.

## Remaining requirements (not complete)

| Acceptance | Remaining work |
| --- | --- |
| AC-1–AC-9 | Graph Mission contracts, DAG/changes/resource gates, integration checkpoints, actor visibility, branch cancellation/recovery and Canvas/List consistency are not implemented. |
| AC-10 | Real engine display/selection is connected; broader layouts and cross-platform acceptance remain. |
| AC-11 | Main-verified private workspace SourceRefs and AI proposal/read/update tool integration remain. Current diagrams must not be presented as source-verified. |
| AC-12 | SQLite GraphDocument history, semantic revisions/digests, meaningful diff, and persisted generation failure state remain. |
| AC-13 | Human agreement bound to current code/permissions and one-time graph Mission start remain. No graph execution exists yet. |
| AC-14 | Persistent views, task restart restoration and execution state overlays remain. The current service is bounded in-memory storage only. |
| AC-15 | The initial iframe/CSP/message boundary is tested. Source access and execution/approval refusal paths must be extended with their future APIs. |
| AC-16 | Mac and Windows packaged utility/asset/display paths passed. The updated no-external-PATH and responsive layout checks remain required on the latest Windows head. |
| AC-17 | The full propose → discuss → diff → agree → parallel execute → resource wait → join → restart flow is not implemented or accepted. |

## Next action

Inspect required CI for the latest layout and empty-PATH checks. Then add SQLite GraphDocument/SourceRef/semantic version storage and managed AI proposal/read/update tools through existing Workspace guards. Render revisions/view lease generations must remain separate from agreement-bearing semantic revisions. Reserve the next migration number against current main and pending #453 (which uses v83); do not overwrite its migration.

Keep this PR draft until all mandatory gates, independent review and full product acceptance are satisfied. Do not close #444 based on this rendering checkpoint.
