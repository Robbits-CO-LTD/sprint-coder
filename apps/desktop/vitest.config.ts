import { relative } from 'node:path';
import { BaseSequencer, type TestSpecification } from 'vitest/node';
import { defineConfig } from 'vitest/config';

// Slow-file seconds from Windows CI run 37307810511. These are placement hints,
// never a test allowlist: every new file receives a positive default weight.
const windowsSeconds: Readonly<Record<string, number>> = {
  'computer-use-owned-startup.test.ts': 7,
  'src/main/command-runner.test.ts': 47,
  'src/main/computer-use-privacy-deflate.test.ts': 18,
  'src/main/computer-use-privacy-inspection.test.ts': 6,
  'src/main/edit-saga-native-integration.test.ts': 23,
  'src/main/graph-mission-persistence.test.ts': 209,
  'src/main/graph-mission-whole-root.test.ts': 38,
  'src/main/graph-workspace-review.test.ts': 7,
  'src/main/grok-persistence.test.ts': 6,
  'src/main/local-model-download-manager.test.ts': 25,
  'src/main/native-safe-fs.test.ts': 15,
  'src/main/persistence-recovery.test.ts': 22,
  'src/main/persistence.test.ts': 93,
  'src/main/project-persistence.test.ts': 9,
  'src/main/provider-egress.test.ts': 12,
  'src/main/sandbox-node-pipe-guard.integration.test.ts': 17,
  'src/main/team-coordinator-persistence.test.ts': 6,
  'src/main/team-coordinator.test.ts': 273,
  'src/main/team-execution-persistence.test.ts': 15,
  'src/main/team-mcp-bridge.test.ts': 13,
  'src/main/team-scenario.test.ts': 10,
  'src/main/team-tools-execute.test.ts': 6,
  'src/main/team-tools.test.ts': 17,
  'src/main/team-worker-runtime.test.ts': 5,
  'src/main/worker-worktree.test.ts': 39,
  'src/runtime-host/codex-adapter.test.ts': 5,
  'src/runtime-host/grok-adapter.test.ts': 74,
};

export function partitionWindowsTests<T extends { moduleId: string }>(
  files: readonly T[],
  root: string,
  count: number,
): T[][] {
  if (!Number.isInteger(count) || count < 1) throw new Error('Invalid CI shard count');
  const groups = Array.from({ length: count }, () => [] as T[]);
  const loads = Array.from({ length: count }, () => 0);
  const weighted = files.map((file) => {
    const path = relative(root, file.moduleId).replaceAll('\\', '/');
    return { file, path, seconds: windowsSeconds[path] ?? 1 };
  });
  weighted.sort(
    (a, b) => b.seconds - a.seconds || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
  for (const { file, seconds } of weighted) {
    let target = 0;
    for (let index = 1; index < count; index++) {
      if (loads[index]! < loads[target]!) target = index;
    }
    groups[target]!.push(file);
    loads[target]! += seconds;
  }
  return groups;
}

export class WindowsCiSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const shard = this.ctx.config.shard;
    if (!shard) return files;
    const group = partitionWindowsTests(files, this.ctx.config.root, shard.count)[shard.index - 1];
    if (!group) throw new Error('Invalid CI shard index');
    return group;
  }
}


// Keep integration deadlines and Windows process concurrency consistent across local and CI runs.
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
    // one worker on Windows so PowerShell-backed ACL tests still run as part of the complete suite
    // without competing hosts; other platforms retain Vitest's automatic worker count.
    ...(process.platform === 'win32' ? { maxWorkers: 1 } : {}),
    ...(process.platform === 'win32' && process.env.CI === 'true'
      ? { sequence: { sequencer: WindowsCiSequencer } }
      : {}),
  },
});
