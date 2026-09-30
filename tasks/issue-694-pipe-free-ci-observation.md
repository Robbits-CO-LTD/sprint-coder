# Pipe-free child CI observation

Related Issue694 and draft PR686. Original head7bc41f0f on main28a3b729 had a Windows CommandRunner pipe-free exit1 failure. Same-head failed-only attempt2 completed FAILURE, but that product shard passed and the native AppContainer fixture instead returned spawnSync error EPERM/statusnull for stdioignore. The original failure is not considered fixed by its later pass.

Diagnostic follow-up retains every status0 assertion and the original product behavior. The product fixture captures stderr and bounded status/signal/error/node/uv metadata before throwing. The native fixture executes ignore, inherit and workspace-file-FD children before asserting, so a failure contains contrasting native paths. No production fallback, sandbox permission relaxation, timeout change or Defender setting changes.

Existing Windows yuseipc Node22.23.3 artifacts: both updated fixtures PASS2 with69 name-filter exclusions,19.29 seconds. Desktop typecheck, changed ESLint/Prettier and diff-check PASS. Independent runtime_fixes read-only review PASS/no blocker. CI controls on the affected windows-2022 host remain pending and root cause remains unconfirmed. Local package success does not establish affected-host acceptance.
