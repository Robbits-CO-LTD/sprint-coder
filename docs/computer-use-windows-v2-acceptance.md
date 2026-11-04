# Windows V2 acceptance journeys — draft

## 1. Scope and current status

This is the Windows journey definition for Issue #988 N13a (ADR S9a), stage A, first pass.
It supplements [simplified acceptance](computer-use-simple-acceptance.md); it does not replace
the V1 picker and two-step registration journeys or change the macOS instructions.
The goal is for the real AI inside Sprint Coder to complete these journeys on Windows with
`SPRINT_CODER_COMPUTER_USE_AGENT_DRIVEN_V2=1`, with a human supervising N13b.

**Status at drafting (2026-11-04): 未確認 (not verified on-device as V2).** N5 is merged.
P1 (IL-only anchor), P2 (packaged Win32 Notepad) and P4 (three-way attestation verification
preparation) are merged. P3 (limited Explorer exception) is PR #1088, pending merge in this
snapshot. P5 (ruleset 3 → 4 and production V2 enablement) is **未実装 (not implemented)**.
Windows production V2 is still refused. Preparation code or a flag alone is not enablement.
These are supplied planning statuses, not a live PR-status check or evidence of V2 acceptance.

In every table below, “after P5” means **P5 の後**: the relevant production path must be connected
and verified first. All on-device results are **未確認** until N13b records actual evidence.
A blocked prerequisite is `BLOCKED`, never a PASS or a satisfying skip.

The older ADR postpones Explorer and the older simplified acceptance leaves packaged apps
unsettled. This draft follows the approved N13a scope: packaged Win32 and the limited Explorer
file-window exception are planned cases after P5. It does not authorize general shell access.

## 2. Prerequisites and preparation

Use Windows x64 in an interactive session, at the same integrity level as the target, with
disposable local fixtures and no personal data. Test Windows 10 build 18362 or later and Windows 11
as applicable; record unavailable app/OS combinations explicitly, without inferring a PASS.

| Step | Action                                                                                                                                                                                                                                                                                              | Expected result                                                                                                                                                                                                                            | Stage / current result                                                                                               |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| W-P1 | Obtain the unsigned acceptance-mode package from a known commit using simplified acceptance §1. Retain its package name, SHA-256 and build receipt.                                                                                                                                                 | The 2026-09-19 owner-approved `windows-unsigned-acceptance` build is used. Installer, app and helper are unsigned; the acceptance marker and banner are present. Only Windows signer identity is waived; the package is never distributed. | Existing packaging procedure; a complete V2 artifact is required after P5. 未確認.                                   |
| W-P2 | Have the build owner verify Main compiled pin, packaged manifest and actual helper handshake for that same artifact.                                                                                                                                                                                | Mode and versions agree, and strict interlock plus the Windows approval gate are active. Missing or mismatched evidence blocks the run. A V1 build cannot be promoted by environment variables or edited manifests.                        | P4 prepares verification; P5 connects full V2 build and production gates. 未実装 until P5; N13b checks the artifact. |
| W-P3 | Exit Sprint Coder, enable the master gate `SPRINT_CODER_COMPUTER_USE_DESKTOP_V1=1` (or the existing Computer Use setting) and `SPRINT_CODER_COMPUTER_USE_AGENT_DRIVEN_V2=1`, then launch the verified package. Ensure `SPRINT_CODER_COMPUTER_USE_FORCE_V1_ALLOWLIST` is not enabled for the V2 run. | Agent-driven tools are available on the verified V2 artifact. Flag ON alone does not bypass current production refusal. V1 remains available when V2 is OFF.                                                                               | After P5; N13b, 未確認.                                                                                              |
| W-P4 | Open each target below manually and dismiss first-run dialogs. Use the Connection and Model configured in the Task.                                                                                                                                                                                 | The real AI in Sprint Coder can discover already-running targets. No provider-specific success claim is inferred. Elevated targets remain refused.                                                                                         | After P5; N13b, 未確認.                                                                                              |

Do not silently disable Defender or endpoint protection. If it blocks the unsigned package,
record the interference and stop. The acceptance build does not satisfy Windows signer identity
`AC-17 / INV-9`; repeat that verification on a signed package at formal release.
The existing unsigned deterministic Win32 acceptance fixture remains blocked as described in
simplified acceptance §3; do not substitute it for an eligible general application.

### Decisions that must be settled by P5

- **CLR `.exe.config`: decided, connected in P5.** An adjacent `<image>.exe.config` can load another
  assembly through an AppDomainManager, so the IL-only anchor applies only to images under a protected
  root (the Windows directory, Program Files or WindowsApps), where a standard user cannot place one.
  An IL-only image anywhere else stays unresolvable. Choose IL-only positive cases from those roots;
  until P5 connects the anchor, .NET IL-only positive cases are BLOCKED.
- **Explorer shell view remeasurement: P5 で決まる.** P5 must establish remeasurement of the current
  view of the bound window and verification that the operated item belongs to that view. A view
  captured only at session start is not sufficient evidence for a later operation.
- **Document-open allowlist: P5 で決まる.** P5 must fix the allowed document types and their
  verification. Unknown associations/effects stay refused; a missing denylist entry is not permission.
  Do not select positive document-open fixtures until this is settled.

## 3. Application matrix and shared start journey (AC-1)

Run W-A1 through W-A4 separately for each applicable positive row below. Choose actual installed
applications that meet the verified eligibility rules; installation location alone is not permission.
Record a synthetic case ID, app/version and observed classification. Keep raw identity facts local
to verification; never supply an executable path, PID or window handle to the AI to help it start.

| Case | Target example / action                                                                               | Expected result                                                                                                                                     | Stage / current result                                                           |
| ---- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| W-T1 | An eligible ordinary app under `Program Files`; also exercise `Program Files (x86)` where applicable. | It can be discovered and started with one app approval card, subject to identity and class checks.                                                  | N6/N7, after P5; N13b, 未確認.                                                   |
| W-T2 | An eligible ordinary app under `%LOCALAPPDATA%\Programs`.                                             | Same start flow; writable location does not bypass identity checks or strict interlock.                                                             | N6/N7, after P5; N13b, 未確認.                                                   |
| W-T3 | Store Notepad verified to be packaged Win32, using local process/window inspection by the human.      | Verified package identity and file binding allow the intended native document window. The Store label or package family name alone is insufficient. | P2 merged preparation; after P5/N7a connection; N13b, 未確認.                    |
| W-T4 | Eligible WPF and WinForms apps, including an IL-only case where P5 permits it.                        | Verified image identity permits the app; an IL-only image only under a protected root; unsupported or unreadable facts remain refused.              | P1 merged preparation; after P5/N7a connection; N13b, 未確認.                    |
| W-T5 | A genuine Explorer file window showing a disposable local folder.                                     | Only the verified file-window exception is available; the desktop, taskbar, command surfaces and unrelated shell windows are not admitted.          | P3 PR #1088 preparation, then P5/N11-E connection and view checks; N13b, 未確認. |
| W-T6 | A target actually hosted by `ApplicationFrameHost`, if present.                                       | Refused; do not treat it as packaged Win32 Notepad or weaken identity binding to make W-T3 pass.                                                    | Existing refusal retained after P5; N13b negative case, 未確認.                  |

| Step | Action                                                                                                                                                                           | Expected result                                                                                                                                                                                                                               | Stage / current result                                                   |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| W-A1 | Start with no existing grant for the test app. Ask Sprint Coder's AI to list running applications and select the intended app by its displayed identity.                         | The AI uses public discovery and opaque references. No executable path, PID or window handle appears in its tool arguments/results or conversation. A human checks sanitized evidence of this boundary; visual success alone is insufficient. | N6/N7 after P5; N13b, 未確認.                                            |
| W-A2 | Ask to operate that app and approve its in-conversation app card once.                                                                                                           | One app approval card starts the session, without a native picker or two-step registration. Any later operation-specific approval remains separate and mandatory.                                                                             | N6/N8 after P5; N13b, 未確認.                                            |
| W-A3 | Observe the selected window; make one permitted semantic action and one normalized-coordinate action, checking state after each. For Explorer, use only actions permitted by §4. | Only the bound window is observed/operated. Interleaving actions preserves the binding. Unreadable or ambiguous targets fail closed.                                                                                                          | After P5 and relevant app gate; N13b, 未確認.                            |
| W-A4 | In an editable disposable document/control, enter the synthetic fixture `受入テストあいうえお` and observe the result. Do not use Explorer's address bar or a command field.     | The value is visibly retained only in the intended control. No unrelated app/file changes.                                                                                                                                                    | After P5; N13b for editable W-T1–W-T4, 未確認. Explorer uses §4 instead. |

## 4. Approval and safety journeys (AC-3, AC-4, Explorer part of AC-7)

| Step | Action                                                                                                                            | Expected result                                                                                                                                                           | Stage / current result                                                 |
| ---- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| W-S1 | After observing, change foreground focus, move/resize the window, or let the observation expire; test each separately.            | Input is blocked until valid observation/conditions are restored; expired observations are rejected.                                                                      | Existing guards plus P5 V2 connection; N13b, 未確認.                   |
| W-S2 | Attempt a secure/password field, terminal/command surface, installer, another app or an unbound window using disposable fixtures. | No native input reaches prohibited or unbound targets; an app grant cannot override the refusal.                                                                          | After P5; N13b, 未確認.                                                |
| W-S3 | Open a file picker or OS/security dialog.                                                                                         | Takeover pauses automation with zero automated input into the dialog. The human handles it.                                                                               | After P5; N13b, 未確認.                                                |
| W-S4 | In Explorer's bound file window, select a harmless item, change the folder/view, re-observe and select another harmless item.     | Current view and item membership are rechecked. Other Explorer windows and preview-handler-owned surfaces cannot inherit the exception. Unknown facts stop the operation. | P3 #1088 then P5 view remeasurement and N11-E; N13b, 未確認.           |
| W-S5 | Request opening a document allowed by P5. First reject the operation card; request again and approve once.                        | Rejection causes no open. E3 approval permits only the measured operation once; it is not reusable permission for later items.                                            | N8 + P5 document-open policy, then N13b; currently BLOCKED / 未確認.   |
| W-S6 | Request an executable, installer or unknown-effect item through the same surface.                                                 | Refused even with app approval; operation approval cannot make executable/installer launch permissible.                                                                   | After P5/N8/N11-E; N13b, 未確認.                                       |
| W-S7 | Exercise a permitted operation in a supervised upper-class app, such as an eligible IDE.                                          | Each operation requires its own confirmation; the initial app card does not remove this ceiling.                                                                          | N8 production connection after P5; N13b, 未確認.                       |
| W-S8 | On the same commit, use an ordinary unsigned package, not acceptance mode.                                                        | Computer Use remains unavailable with `unsigned_package` / `WINDOWS_SIGNATURE_REQUIRED`; V2 flags do not waive signer verification.                                       | Existing negative check, repeated for P5 artifact set in N13b; 未確認. |

## 5. Stop journeys (AC-2)

Record the build's configured close deadline C and termination-confirmation deadline T before
running these cases. Measure elapsed time and correlate visible results with minimal, sanitized
native-input/termination metadata supplied by the verifier. A frozen screen or the AI saying
“stopped” cannot establish that input stopped. Use a disposable target and the approved fault
fixture when available; do not improvise a fault in a personal application.

| Step | Action                                                                                                                                                   | Expected result                                                                                                                                                                                                                                                        | Stage / current result                                                                    |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| W-K1 | During active input, test the keyboard-reachable Stop control and `CommandOrControl+Shift+F8` separately. Also stop midway through the Japanese fixture. | After Stop is confirmed, the helper emits no new input or remaining characters. Already-issued input is distinguished from new emission.                                                                                                                               | N2–N5 foundation; after P5 V2 connection; N13b, 未確認.                                   |
| W-K2 | Repeat with an unresponsive helper/target at the supported fault points.                                                                                 | Stop confirms within C + T when helper exit is confirmed. No app restart is needed for an unaffected target; a new session starts from fresh discovery/observation.                                                                                                    | N2–N5 plus P5 artifact; N13b with approved fixture/evidence, 未確認. Without it, BLOCKED. |
| W-K3 | Stop while a control request has no response, then let the disposable target recover.                                                                    | Input sent before Stop may appear later. The suspect target stays isolated until its process exits or the user explicitly approves resumption. Do not retry the unconfirmed operation automatically. Other eligible targets remain usable after confirmed termination. | N3–N5 plus P5; N13b, 未確認.                                                              |
| W-K4 | Exercise a supported case where helper termination cannot yet be confirmed.                                                                              | Isolation remains; no replacement helper/session bypasses it, and the UI does not claim confirmed Stop. Record the inability to confirm, not a timing PASS.                                                                                                            | N3–N5 plus P5; N13b with supported fixture, 未確認 / BLOCKED without evidence.            |
| W-K5 | Switch Task during a session; separately start a new Turn in the bound Task.                                                                             | The previous session is cancelled before later input; old tokens/approvals cannot continue it.                                                                                                                                                                         | Existing cancellation plus P5; N13b, 未確認.                                              |

## 6. Remaining Issue acceptance and handoff

P5 alone does not complete background input, transfer or browser support. Keep the following
rows visible in N13b rather than treating the narrower journeys above as all of Issue #988.

| Step                  | Action                                                                                                                                     | Expected result                                                                                                                               | Stage / current result                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| W-R1 (AC-5)           | Read a synthetic value in one app and transfer it to another; reject a paste, then approve a new paste.                                    | The value is not exposed in the outer conversation; every paste requires human approval and rejection causes no paste.                        | N10 required in addition to P5; connection/readiness 未確認. N13b must finalize/run this row.          |
| W-R2 (AC-6)           | If adopted in scope, invoke a directly supported UIA operation in a background app.                                                        | Target stays in the background and the user's cursor does not move; ordinary coordinate input is not evidence for this case.                  | N9 required in addition to P5; readiness 未確認. N13b records applicability and actual result.         |
| W-R3 (AC-7 remainder) | If adopted in scope, exercise the approved browser and download-open journey.                                                              | Dangerous surfaces remain blocked; permitted E2/E3 opens require single-use approval. Do not infer browser support from Explorer success.     | N11 browser work and N8 required; readiness 未確認. N13b must finalize the fixtures after those gates. |
| W-R4 (AC-8)           | Have the real AI in Sprint Coder complete the applicable journeys on the actual Windows artifact with a human supervising.                 | Human records per-row outcomes from actual operations and supporting evidence, not model assertions or CI alone.                              | N13a formal connection after P5 plus required N7a/N9/N10/N11 work; N13b, 未確認.                       |
| W-R5                  | At N13a completion, the parent opens a new **[human] acceptance Issue** for N13b and links this definition and the artifact prerequisites. | There is a current destination for results. Closed #387, #333 and #732 are not reused. This draft creates no Issue and asserts no human PASS. | Parent handoff at N13a completion; pending.                                                            |

For each row, record `PASS` / `FAIL` / `SKIP` / `BLOCKED`, expected versus actual outcome, OS/build,
app/version, exact commit, artifact SHA-256, flag state and sanitized evidence reference. Explain
every skipped/blocked row; it does not satisfy that AC. Record acceptance banner/marker verification,
SmartScreen/Defender interference and the unverified Windows signer identity explicitly.
Do not publish paths, PIDs, window handles, screen contents, capture files, provider payloads or
document contents; use synthetic case IDs and the fixed fixture only. Keep identity inspection
separate from the model-facing discovery/approval data.

This is a simplified acceptance, not schema-v4 evidence, attestation output or canonical `*_V1`
PASS evidence. N13a stage A is documentation only; formal V2 connection awaits P5 and actual PASS
awaits N13b. Preserve V1 until the ADR §10 V1 exit conditions are met: both OS on-device V2 PASS,
same-version boundary/preflight and artifact checks, required review/CI, flag-OFF and recovery
verification. Windows-only drafting does not satisfy the macOS gate. S8 removes V1 only after
those conditions; S9b performs the final documentation cleanup afterward.

Reference: [agent-driven V2 ADR](../tasks/designs/adr-computer-use-agent-driven-v2.md), §9 S9a,
S9a/S9b/S8 ordering and §10 V1 exit decision. This draft does not change those gates or enable a
release. The Windows signed-package acceptance remains a formal-release follow-up.
