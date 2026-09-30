# Issue #650: Windows sandbox runner signing boundary

## Confirmed cause and implementation

Base: `28a3b7291f7bc7ec5a482a3952f449ecf3f10261`.
The build script seals unsigned helper bytes. Windows Packager Authenticode signing changes those bytes before `postPackage`, which previously refreshed only Computer Use digests. Runtime verification consequently rejects the otherwise legitimate helper.

Windows `postPackage` now refreshes the sandbox runner SHA-256 from the packaged executable, after Packager signing. The existing macOS behavior remains unchanged. `postMake` streams the final Windows ZIP and full Squirrel NUPKG, requires exactly one helper and sibling digest, verifies their bytes, and requires matching helper digests across artifacts of the same architecture. It fails closed before wrapping Setup with Inno. Delta packages and non-Windows artifacts are unaffected.

The installed MakerZIP copies the packaged directory. MakerSquirrel passes that directory into electron-winstaller. The bundled Squirrel version is `2.0.1+eef37460ae`; its release packaging skips PE files already carrying trusted signatures and can sign other PE files. The final archive check therefore detects subsequent signing mutations rather than assuming that downstream tools preserve bytes. Primary source: https://github.com/Squirrel/Squirrel.Windows/blob/eef37460ae/src/Update/Program.cs . Inno signs its outer installer, not the embedded helper.

## Regression and verification

- The new real `postPackage` regression failed before the fix with a stale digest after a signing byte-mutation surrogate.
- Node 22.23.2, Windows: 34 tests passed, one pinned-Node packaging test explicitly excluded because it requires 22.23.3. Includes real compiled helper probe: modified PE + old seal fails; refreshed seal permits Windows AppContainer probe; further tampering fails.
- Node 24.13.0, Windows: 15 signing/archive focused tests passed. A complete Forge run before adding the real probe passed 24 tests and failed only the same pinned-Node test.
- Archive tests cover final ZIP/NUPKG seals, absent/stale/malformed/misplaced/duplicate digests, cross-artifact mismatch, and unaffected platforms/delta/container artifacts.
- Desktop typecheck and changed-file ESLint/Prettier pass.
- Native helper release build succeeded using cached Cargo dependencies with `CARGO_NET_OFFLINE=true`; no downloads, API calls, credential changes, or actual signing were performed.
- The restricted tool sandbox denies the real AppContainer probe even with a valid digest. The same local test passes with the authorized Windows execution environment; this is recorded separately from application behavior.

## Remaining acceptance gates

This is a draft implementation, not evidence that all Issue #650 acceptance criteria are complete. A real Authenticode-signed package, final ZIP/full NUPKG/wizard installation, and managed-command acceptance require the release signing environment and pinned Node 22.23.3. The PE byte mutation fixture is not an Authenticode signature. macOS/Linux distribution smoke remains separate. Do not close the issue from unit-test success.
