# Issue 679: Windows native full-path publication

Base: main 28a3b729; independent of bounded sibling names in PR672. No Workspace parser/root policy, public IPC, native addon source, or build changes.

Root cause confirmed: Node supports the valid full target path, but the native wrapper passed ordinary path spelling into GetNamedSecurityInfoW/SetNamedSecurityInfoW/ReplaceFileW. A 255-character component at full path308 produced PreserveReplaceFileDacl Windows error123. Two fresh-directory reproductions failed, while changing only the same three argument spellings to the extended namespace made native publication succeed with the same target/ACL/bytes. Component overflow and general permission failure were excluded.

Minimal change: node:path.toNamespacedPath for replacement/target/backup at replaceWindowsFileWithBackup only, after the Windows availability check. Existing Workspace validation and native same-parent check remain. The API returns no path, so Renderer-visible relative paths are unchanged.

Windows yuseipc / Electron43.5.0 / matching native-safe-fs evidence:

- Before correction: native255component/fullpath308 FAIL error123; real editor open editable=true then save FAIL refused. Different-parent refusal test PASS.
- After: native publication + workspace edit2suites 28PASS8POSIXSKIP. Long nested parent edit saved real bytes. Existing conflict rollback, retained displaced edits, private ACL, BOM, identity and escaping junction/hardlink tests PASS. Different-parent remains refused.
- Desktop typecheck, changed-file ESLint/Prettier and diff-check PASS.

Remaining: exact remote-head aggregate CI, installed editor UI/IPC, UNC share and Windows total path upper bound acceptance. Public Workspace roots with namespace spelling are still rejected by their existing guard; this patch changes only Win32 API argument spelling. No paid API/download/install/release/merge/Issue closure.
