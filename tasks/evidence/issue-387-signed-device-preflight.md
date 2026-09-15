# Issue #387 signed-device preparation

Status: `CLOSE_HOLD`. Last verified: 2026-09-15. Source baseline:
`5b20208eb7b4f7697105dca2bf9436da3aeec910` (`v0.7.0-beta.3`).
This record contains read-only preparation results, not interactive acceptance. Original Core,
Safety, and Compatibility requirements in `tasks/issue-333-computer-use-final-gate.md` still apply.

## Verified preparation

| Probe                      | Result                                                                                                                                                          | Limit                                                                                                   |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Existing macOS beta.3 app  | `codesign --verify --deep --strict`, native module verification, `stapler validate`, and `spctl --assess --type execute` succeeded                              | No GUI operation or Core/Safety journey ran                                                             |
| macOS manifest             | Source commit matches the baseline above; arm64; module digest `76b290862807135c56e70e74f09403264effbf5a4706a5e3505f8ea16cdb4cff`; release Team ID `7TDY87Y997` | Does not bind a newly built adapter or changed source                                                   |
| Windows host               | `mainpc`, OS build `10.0.26200.0`; x64 SDK SignTool `10.0.26100.0` is present                                                                                   | Existence of System32 Notepad does not prove classic direct-process window compatibility                |
| Windows certificate stores | CurrentUser/My and LocalMachine/My code-signing metadata exposed three local-purpose certificates; no ROBBITS release identity found                            | A disconnected USB token or another machine may hold the approved certificate; no key access attempted  |
| GitHub runners             | Repository Actions API returned `total_count: 0`; no `actions.runner` service found on `mainpc`                                                                 | Interactive/user-session runners were not configured or started                                         |
| GitHub variables           | Repository, `windows-signing`, and `computer-use-final-gate` variable lists were empty                                                                          | Protected sentinels, expected signers, and capture root are not ready; secret values were not requested |

## Read-only signature preflight

`apps/desktop/computer-use-native/fixtures/win32-acceptance/verify-signatures.ps1` provides
`Test-ComputerUseSignedArtifacts`. The fixture README gives its invocation. It requires all four
explicit app/helper/installer/fixture paths and approved public signer metadata, includes every
packaged `.dll`/`.node`, rejects reparse points and duplicate artifact paths, verifies timestamped
Authenticode signatures with SignTool, and rechecks hashes after verification. It never signs or
executes a candidate artifact and never reads private keys or requests a PIN.

The output always identifies itself as `signature-preflight-only` with
`interactiveAcceptance: NOT_RUN`. Its hashes can identify verified bytes, but the output is not an
attested machine transcript. Source/manifest/architecture binding, package attestations, signed
fixture contract checks, and every interactive journey remain independent required checks.

Validation of this preparation change:

- Windows PowerShell headless suite: 19 unit cases passed, including invalid/mismatched signatures,
  absent timestamps, SignTool errors/warnings, unsigned native libraries, reparse points, duplicate
  paths, missing artifacts, and changing digests. OS doubles are synthetic; no test signature was
  created. The source and suite were streamed through SSH for execution without remote file writes.
- A read-only real System32 Notepad signature was valid and the preflight assertion rejected it
  with `SIGNER_MISMATCH` against a different expected identity. This is a verifier check, not proof
  of the product's native input denial.
- The existing macOS app also failed an intentionally incorrect Team ID requirement with exit 1;
  its normal signature/notarization and source/module/signer digest checks succeeded.
- Node 22 desktop typecheck succeeded. Existing fixture tests: 3 passed. The new Windows-only
  Vitest wrapper is skipped on macOS; its PowerShell suite was exercised on Windows as above.

Required signed Windows fixture/package input journeys and notarized macOS interactive journeys
remain `FAIL / EXTERNAL_GATE_NOT_RUN`. No mandatory Core/Safety PASS is claimed.

## Main: exact headless Windows test replay

Remote target: SSH alias `mainpc`, existing `powershell.exe`. This test replay needs **no remote
file path**: the compressed source and unit tests execute in memory. The separately authorized
fixture compile uses the paths in the build record linked below. No checkout, install, policy
bypass, certificate, or GUI operation is needed for the unit replay. Run from this change's
repository/worktree root on Mac:

```bash
PATH=/opt/homebrew/opt/node@22/bin:$PATH node <<'NODE'
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { gzipSync } = require('node:zlib');
const root = 'apps/desktop/computer-use-native/fixtures/win32-acceptance/';
const source = fs.readFileSync(root + 'verify-signatures.ps1', 'utf8');
const tests = fs.readFileSync(root + 'verify-signatures.test.ps1', 'utf8')
  .replace('. "$PSScriptRoot/verify-signatures.ps1"', '');
const encoded = gzipSync(Buffer.from(source + '\n' + tests)).toString('base64');
const entry = "$ProgressPreference='SilentlyContinue'; $s=New-Object IO.MemoryStream(,[Convert]::FromBase64String('" + encoded + "')); $g=New-Object IO.Compression.GzipStream($s,[IO.Compression.CompressionMode]::Decompress); $r=New-Object IO.StreamReader($g); try { & ([scriptblock]::Create($r.ReadToEnd())); exit 0 } catch { Write-Output $_.Exception.Message; exit 1 }";
const result = spawnSync('ssh', [
  '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'mainpc',
  'powershell -NoProfile -NonInteractive -Command "' + entry + '"',
], { encoding: 'utf8', timeout: 30000 });
console.log(result.stdout);
console.error(result.stderr);
if (result.error) console.error(result.error.code);
process.exit(result.status ?? 1);
NODE
```

Expected exit: `0`; summary: `Signature preflight unit tests: 19 passed; interactive acceptance NOT_RUN`.
If Main later synchronizes the source into an approved Windows checkout, the native exact command
from that checkout root is:

```powershell
powershell.exe -NoProfile -NonInteractive -File .\apps\desktop\computer-use-native\fixtures\win32-acceptance\verify-signatures.test.ps1
```

The subsequently authorized [unsigned fixture build checkpoint](issue-387-unsigned-fixture-build.md)
completed two clean Windows x64 builds and headless contract checks under
`C:\Users\yusei\sc-issue-387-20260915`. Both unsigned files are rejected by the signature assertion.
They are compile evidence for baseline `5b20208`, not signed-package acceptance or evidence for a
later integrated source revision.

Remaining preparation after certificate/host coordination: rebuild the fixture from the frozen
final integrated SHA, run the preflight over the actual signed four-file set and packaged libraries,
verify architecture, manifest/package binding and attestations, then allocate the interactive
journeys. Whole signed-package preflight remains unrun because approved signed inputs are not
available.

## Main/operator coordination needed

1. Identify the existing approved ROBBITS signing machine or USB token and its public certificate
   thumbprint/subject. Confirm the scope/operator for validation signing. Never send a private key,
   PFX, PIN, password, certificate secret, or entire environment through task messages.
2. Allocate a Windows GUI interval after #434 finishes using it, plus a macOS interactive interval.
   Confirm required OS permissions through the user; do not change security settings automatically.
3. Freeze the integrated source SHA after the #333/#388 changes are reviewed, then coordinate the
   corresponding signed package/helper/fixture and notarized macOS artifacts. Existing beta.3 bytes
   cannot prove changes added after their source commit. No version/tag/release change is part of
   this preparation task.
4. Main coordinates protected signing/final-gate variables, runners, and workflow provenance.
   The current workflow expects successful release-tag package artifacts and trusted attested
   evidence. A local signature report alone cannot satisfy that contract.
5. #388 supplies runtime capture/Provider evidence; #333 owns product integration and the canonical
   final-gate document. Run original AC/INV journeys against the exact frozen artifacts. Any
   unrun mandatory journey stays `FAIL / EXTERNAL_GATE_NOT_RUN`, never a passing `SKIP`.

Source: [Issue #387](https://github.com/Robbits-CO-LTD/sprint-coder/issues/387), its latest comments,
the repository final-gate/fixture contracts, read-only OS signature checks, certificate-store public
metadata, and repository Actions/variables APIs. No GitHub mutation, signing, installation, GUI
launch, or credential/security change was performed by this preparation task.
