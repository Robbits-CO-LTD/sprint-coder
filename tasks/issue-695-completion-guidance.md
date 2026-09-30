# Completion refusal guidance (#695)

Baseline: main `28a3b729`. Scope is one public message; completion verification, failed state, error code, cancellation, journal and permissions stay unchanged.

## Cause and regression

`verifyEditSagaPostImagesInTransaction` returns open Acceptance Contract criteria even when its committed Saga list is empty. Main's IPC catch maps every `AcceptanceEvidenceMissingError` to one file-specific message. A no-edit/all-refused Turn therefore gets instructions to check changed files that do not exist.

Two IPC regressions (no committed edit / committed edit) failed before the fix on the old message. They assert failed state, authoritative error code, failed completion transaction and absence of runtime blame, cancellation or termination. Guidance now refers to unmet completion conditions for both cases.

## Library carryover classification

PR #644 merged as `74c1179f`; its twelve review threads are resolved. Publication DACL drift, inherited ACL recreation and named ADS findings were addressed in `082e665a` and subsequent hardening. Current main includes `PredictStagedSecurity`, security/stream checks and preflight refusal journaling. Later cleanup and integrity-label findings were also resolved.

Closed #559's final acceptance comment identifies the exact three deferred design candidates: (1) terminalize an intent refused at apply as unapplied, (2) persist DACL in the journal, (3) compatibility observation for old-version intents. All-state searches for DACL/journal, unapplied/intent and old-version/intent found no open duplicate. These remain design holds rather than newly discovered defects: current post-intent apply refusal stopping at `recovery_required`, refusing non-recreatable security before mutation, and old-journal fail-closed behavior were explicitly accepted. Implementing them requires a native/journal compatibility and recovery design; this guidance patch neither changes nor reopens those accepted limits.

The final old beta.13 Windows add-journal observation incompatibility is explicitly accepted in that PR: old sealed identity/mode may fail closed after upgrade with `effect_observation_drift`. It needs a separately designed compatibility migration, and is not reopened here.

Closed #552 fixes Managed Local Worker false success, while closed #516 fixes integrated Worker acceptance evidence; their accepted limits remain intact. #695 concerns Main Turn guidance only. Existing draft work through #693 changes other runtime, journal and file publication paths; no competing completion-message change was found.

## Validation limits

Offline Windows IPC tests exercise Main event settlement. They do not demonstrate paid-provider or installed GUI behavior. Native artifacts are reused from the existing trusted checkout; no download or rebuild is performed.

Focused IPC: 4 passed (both new lanes, active-command refusal and acceptance refusal). Desktop TypeScript, scoped ESLint and Prettier passed. A wider completion group passed six cases but its ten command-image cases stopped before the gate because the locally selected executable imports `bthprops.cpl`, rejected by the existing executable-image seal. This environment result is not represented as a completion regression. Root independently reviewed the one-message diff and both test lanes: PASS, no blocker.

Using the existing verified Node 22.23.3 executable directly (rather than Electron's executable image) resolved that local launch mismatch. All sixteen completion cases and the full 1400-test IPC file passed without production or guard changes, download or rebuild.
