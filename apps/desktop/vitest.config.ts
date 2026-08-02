import { defineConfig } from 'vitest/config';

// Only the timeouts are configured here; everything else stays on Vitest's defaults.
//
// Vitest's default 5s per-test timeout is written for pure unit tests. A large part of this
// suite is not that: specs open real SQLite databases, spawn child processes, and drive the
// ToolBroker end to end. On a 2-CPU GitHub runner those routinely take longer than 5s while
// still being perfectly healthy — Team tool tests that start several sequential workers timed out
// in CI while passing locally in well under a second.
//
// Raising the ceiling does not weaken any assertion; it only stops the runner from calling a
// slow-but-correct test a failure. It stays bounded so a genuinely hung test still fails rather
// than running until the job's own limit. Specs that legitimately need longer — the Electron ABI
// bridge ones, which re-run whole suites inside a spawned Electron — keep their own larger
// explicit timeouts (35s / 65s), which take precedence over this default.
export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // The Windows suite launches real Electron, PowerShell, cmd, Git, and SQLite child processes.
    // Letting Vitest derive a larger worker count from the host causes those processes to contend
    // until otherwise healthy ACL checks hit their bounded deadline on two-core CI runners. Keep
    // two-way parallelism on Windows; other platforms retain Vitest's automatic worker count.
    ...(process.platform === 'win32' ? { maxWorkers: 2 } : {}),
  },
});
