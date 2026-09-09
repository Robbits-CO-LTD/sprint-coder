# Workspace root metadata and provider egress

Refs #424. Implementation base: PR #443 (hidden Electron E2E).

## Confirmed failure

Codex Computer Use against source 760df77 reproduced remote CLI dispatch denial on an empty,
selected Workspace. Main's generated guidance contains the canonical absolute root. The entropy
scanner includes slashes in a candidate, so otherwise ordinary directory components become one
high-entropy value. Audit: provider.egress / deny / parent_ceiling. A fresh Task without a Workspace
completed through the same Codex CLI/model. A generated-guidance + full Electron permission-gate
regression failed for both Codex and Claude before the repair.

## Bounded decision

Pass only the canonical roots of Main's sealed Turn Workspace to egress assessment. When an
entropy candidate is exactly a known POSIX root, evaluate its directory components separately.
Keep the same minimum candidate length and entropy threshold. Keep all recognizable credential
patterns and structured credential fields checked against the original content. A credential-like
component still denies the complete request. No prefix, descendant, regex, or glob exemption.

The generic file-disclosure classifier keeps its original behavior, including classifier version
and approval/redaction semantics. No Renderer/Provider-supplied exemption is accepted. Ordinary
CLI payload bytes, payload digest, local-only enforcement, permission ceiling and final permit
revalidation remain unchanged. Other provider paths without this generated-root context remain
unchanged. Roots with opaque component names may still be denied; this is not a global path
allowlist or a general solution to every entropy false positive.

## Verification

- Before: generated Codex/Claude guidance rejected in two full permission-gate regressions.
- After: both dispatch; local-only Tasks, raw opaque values, credential fields, secret-bearing
  roots, descendants and lookalikes remain denied. Generic disclosure behavior remains covered.
- Real acceptance: hidden Electron UI selects Codex CLI/GPT-5.5, assigns the original canonical
  test Workspace, submits a harmless request, and requires the exact completed response while
  the window remains invisible/unfocused. The opt-in spec requires SPRINT_CODER_REAL_CLI_EGRESS=1;
  SPRINT_CODER_REAL_CLI_EGRESS_WORKSPACE can bind a specific fixture root without deleting it.
- Computer Use native signed-device and real-provider three-round gates (#387/#388) remain separate.
