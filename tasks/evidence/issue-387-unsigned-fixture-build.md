# Issue #387 unsigned Win32 fixture build checkpoint

Verified 2026-09-15. Status: unsigned compile/contract preparation succeeded; signed-device
Core/Safety acceptance remains `FAIL / EXTERNAL_GATE_NOT_RUN`.

## Source and host binding

- Fixture source baseline: `5b20208eb7b4f7697105dca2bf9436da3aeec910`.
- Preparation checkout: `97df75bdee9a42fc60aa340ecf2080d87fd7cd5b`; its four fixture build inputs
  are byte-identical to the baseline. The signature verifier comes from this preparation commit.
- SSH host: `mainpc`; identity `yuseipc\yusei`; Windows `10.0.26200.0`.
- Explicitly authorized directory: `C:\Users\yusei\sc-issue-387-20260915`. It was absent before
  creation, then empty and non-reparse. Its owner and parent owner are `BUILTIN\Administrators`.
  No ownership, ACL, execution-policy, credential, or security setting was changed.
- Existing Visual Studio 2022 Build Tools:
  `C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools`.
  Compiler `VC\Tools\MSVC\14.44.35207\bin\HostX64\x64\cl.exe`, file version `19.44.35222.0`.
  Existing `RemoteSigned` policy was retained. No dependency installation or native rebuild of
  Sprint Coder was performed.

Only these fixture source files were copied into `source` and their SHA-256 values were checked
before compilation:

| File                                | SHA-256                                                            |
| ----------------------------------- | ------------------------------------------------------------------ |
| `build.ps1`                         | `c9ad32ba8017049d4dc757bb95683e42cc2a2f04acf79cd440fb5f717c580ac9` |
| `fixture_contract.h`                | `194b2329715198ea7c71d68685caa9060d9c25db77c841b2a5772535e9331da1` |
| `win32_acceptance_fixture.cc`       | `d2cb444d0a2d8659f1161d15f22c48b17e3df14ed87862cc9ebb31c135f6ca42` |
| `win32_acceptance_fixture.manifest` | `1d909b77ee3507a3c82a6330f904d9178eedccea15385dc626051123ba942015` |

`verify-signatures.ps1` was subsequently copied into the same source directory for the read-only
unsigned rejection check. Each build directory retains only the EXE, OBJ, and extracted embedded
manifest. The task-local `temp` directory is empty. Final inventory: 11 files, no reparse points,
no remaining fixture processes. Existing applications, model downloads, and checkouts were not
touched.

## Results and reproducibility limit

Both originally empty output directories ran the unchanged `build.ps1`. It uses x64 MSVC with
`/W4 /WX`, the existing hardening flags, and the embedded manifest. In `wWinMain`, the
`--contract-check` branch returns before common-control initialization, window registration,
window creation, and `ShowWindow`. No normal GUI invocation was performed.

| Output directory | EXE SHA-256                                                        |  Bytes | PE machine     | Contract exit | Authenticode |
| ---------------- | ------------------------------------------------------------------ | -----: | -------------- | ------------: | ------------ |
| `build-a`        | `ab21fe00a775edc90c82fca2367b341bdb7a6793eea96dc7af516be172273823` | 119296 | `8664` (AMD64) |             0 | `NotSigned`  |
| `build-b`        | `608f268421bb084b0d3f31b745a84214fd2f597ab33f60fd7eb1d92966c70c5c` | 119296 | `8664` (AMD64) |             0 | `NotSigned`  |

The EXE name in both directories is `sprint-coder-computer-use-fixture.exe`. The compiler and
contract-check procedures reproduced successfully, but the original artifact bytes are **not
identical**. Exactly two bytes differ, at offsets 256 and 97012: the COFF header timestamp and the
timestamp in the PE debug-directory entry (type 13). Those fields were located by parsing the PE
headers/section RVA mapping. Zeroing only the two four-byte timestamp fields in memory produced
equal SHA-256 values (`4ed75acd8113c1d5f9674415af705b4d8ef899d81b487d41c2cda5f3d3d145ce`).
Neither file was modified. This normalized digest is diagnostic only and must never replace the
actual artifact digest in signing, source binding, or acceptance evidence. No build flag was
changed to manufacture a byte-reproducible result.

`mt.exe` extracted each EXE's actual embedded manifest. Both report assembly version `1.0.0.0`,
architecture `amd64`, `requestedExecutionLevel=asInvoker`, and `uiAccess=false`. The source
fixture contract remains V1 with 17 stable control IDs. Contract-check proves unique IDs and
nonempty class/title constants; it does not exercise accessibility, capture, input, scroll, Stop,
or any Safety journey.

`Get-AuthenticodeSignature` on the actual `build-a` EXE returned `NotSigned` and
`Assert-ComputerUseSignature` rejected it as `SIGNATURE_INVALID`. This tests the verifier on an
actual unsigned build, not the product runtime's attach/input rejection.

## Main: exact build command

Run in an existing Windows PowerShell session on `mainpc`. This example deliberately uses a new
`build-c` directory and refuses to overwrite any existing output. The copied source is the
baseline above; compare its hashes before execution. The toolchain changes and TEMP/TMP settings
below apply only to this PowerShell process; no persistent machine settings change.

```powershell
$ErrorActionPreference = 'Stop'
$root = 'C:\Users\yusei\sc-issue-387-20260915'
$out = Join-Path $root 'build-c'
if (Test-Path -LiteralPath $out) { throw 'OUTPUT_ALREADY_EXISTS' }
Import-Module 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\Microsoft.VisualStudio.DevShell.dll'
Enter-VsDevShell -VsInstallPath 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools' -SkipAutomaticLocation -DevCmdArguments '-arch=x64 -host_arch=x64' | Out-Null
$env:TEMP = Join-Path $root 'temp'
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Path $out | Out-Null
Push-Location $out
try {
  & "$root\source\build.ps1" -OutputDirectory $out
  if ($LASTEXITCODE -ne 0) { throw 'BUILD_FAILED' }
} finally { Pop-Location }
Get-FileHash -Algorithm SHA256 -LiteralPath "$out\sprint-coder-computer-use-fixture.exe"
Get-AuthenticodeSignature -LiteralPath "$out\sprint-coder-computer-use-fixture.exe" |
  Select-Object Status
```

`build.ps1` already runs the sole permitted executable invocation:
`sprint-coder-computer-use-fixture.exe --contract-check`. Do not start it with no arguments until
Main allocates the GUI interval.

## Required final-SHA rebuild and signing boundary

After Main integrates #333/#388 and freezes the final SHA, copy/hash those exact fixture inputs
into a separately identified source directory and rebuild into a fresh output directory. These
baseline outputs cannot attest to that later SHA. Sign the final fixture with the same approved
release certificate as the final Windows app/helper/installer, verify timestamps and identities,
and record the **post-signing** fixture hash. The approved certificate/token and signing operator
are still pending; no certificate was generated or used here.

The preflight's successful unit/compile checks cannot replace package-manifest/attestation binding
or any signed/notarized interactive AC/INV. No fixture public input-count probe was introduced.
If #388 needs one, Main must coordinate the probe contract and observation boundary before it is
implemented and the final source SHA is selected.
