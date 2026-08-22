# Fortress Review — Issue #309 pre-implementation plan

## Revision binding

- review_target_kind: `plan`
- base_sha: `816bf9e0cae7cec248f8da5cf5d700eceeb61a04`
- issue_plan_version: `184c0c13741820a413a37ddcc43e87077de657546d3aac1bcdb023cf87369c17`
- revision_class: `RVC3_CONTRACT_OR_BOUNDARY`
- affected_lenses: impact, tests, requirements, failure_operations, data_security
- current-head amendment: preserve PR #312 Managed Skill compatibility/activation for `builtin` and
  `created` while removing every external import path

## Reviewer availability

The pinned Terra/PowerShell runner is unavailable on this macOS host. No generic subagent was
substituted. Five Sol fallback lenses are `not_independent`; ReviewBOT/full CI remain mandatory.

| Lens               | Independence      | Status |
| ------------------ | ----------------- | ------ |
| impact             | `not_independent` | PASS   |
| tests              | `not_independent` | PASS   |
| requirements       | `not_independent` | PASS   |
| failure_operations | `not_independent` | PASS   |
| data_security      | `not_independent` | PASS   |

## Lens findings

### Impact

PASS. External import spans contracts/preload/UI, SkillStore/Settings, Main Turn flags, Team MCP,
Provider tools, Runtime Host tool contracts, and built-in installation. PR #312 added compatible
created/native Skill activation; `skill_activate`, Portable conversion, auto-candidates, and legacy
history metadata are not import features and must remain.

### Tests

PASS. Required axes are removed UI/API/channels/tools, direct old-channel/tool rejection, zero
external directory reads, reserved `import-skill` rejection, legacy `claude|agents` row decode,
builtin/created list/select/activate/export/delete, Codex/Claude/Provider normal Turns, and packaged
Settings/Skill selection E2E.

### Requirements

PASS. AC-1 through AC-4 map directly to the seven removal boundaries. Existing imported files and
legacy DB rows remain untouched; only discovery, selection, context, and execution reachability are
removed.

### Failure and operations

PASS. Old IPC handlers are absent, so invokes fail as unsupported. Old MCP names are absent from
catalog/normalization/dispatch and fail as unknown tools. A legacy selection fails with a bounded
unavailable/reserved error before filesystem or Runtime dispatch.

### Data and security

PASS. `claude|agents` remain decoder-only values for old rows. New catalog/selection accepts only
`builtin|created`; no migration deletes or rewrites external files or persisted history.

## Frozen execution amendments

1. Keep `import-skill` in the reserved-ID denylist, but remove its built-in package, installation,
   catalog entry, auto-bind parser, and every Turn capability flag.
2. Keep the legacy source enum in persistence/protocol history schemas; introduce or retain a
   current-catalog guard that exposes only `builtin|created`.
3. Remove external scan/preview/import/update/remove methods and IPC channels, but retain created
   Skill enable/disable/delete/export and compatibility conversion.
4. Remove `skill_import_read/install` from Team MCP and Provider catalogs, authorization state,
   dispatch, server source, and Claude normalization. Keep `skill_activate` and general Team tools.
5. Existing imported directories are neither read nor modified. Tests create canary directories and
   assert zero reads plus byte-for-byte survival.

## Verdict

- Findings: no unresolved CRITICAL/HIGH after the PR #312 preservation amendments.
- Human Gate: no file deletion/migration/release operation; existing external files are preserved.
- Verdict: **Go** for bounded Issue #309 implementation on the bound revision.

## Final diff checkpoint

- Impact: PASS — Settings/public IPC/Main Turn/Team MCP/Provider/Runtime tool surfaces removed;
  `skill_activate`, builtin/created compatibility, Skill Creator, drafts, and export remain.
- Tests: PASS — 1064 focused tests, explicit old-channel/tool rejection, legacy directory canary
  preservation, reserved ID rejection, and 8 packaged Settings E2E tests; retired import tests are
  skipped because their product surface no longer exists.
- Requirements: PASS — current catalog and selection are `builtin|created` only; legacy source
  values remain decode-compatible but fail before filesystem access or Runtime dispatch.
- Failure/operations: PASS — old IPC has no handler and old MCP/Provider names are absent from every
  published catalog/dispatch path.
- Data/security: PASS — existing imported files are not read, modified, or deleted; zero production
  occurrences of removed tool/channel names remain, with `import-skill` only in the reserved deny.
- Final fallback verdict: **PASS**, pending independent ReviewBOT and full CI on the PR head.
