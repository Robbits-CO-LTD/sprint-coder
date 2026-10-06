import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearDependencyToolCaches,
  compilerCacheable,
  dependencyCacheValid,
  resetSandboxOutput,
  sandboxCacheValid,
  sandboxProbeValid,
} from '../../ci-cache.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const depsAction = parse(
  readFileSync(join(repo, '.github/actions/install-deps/action.yml'), 'utf8'),
);
const sandboxAction = parse(
  readFileSync(join(repo, '.github/actions/prepare-sandbox/action.yml'), 'utf8'),
);
const workflow = parse(readFileSync(join(repo, '.github/workflows/ci.yml'), 'utf8'));
const cleanup = [];
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'ci-cache-'));
  cleanup.push(root);
  return root;
};
const write = (file, content, mode = 0o600) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, { mode });
};
afterEach(() =>
  cleanup.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })),
);

function condition(expression, outputs, os = 'Windows') {
  const substituted = expression.replace(
    /steps\.([a-z-]+)\.outputs\.([a-z-]+)/gu,
    (_, step, output) => JSON.stringify(outputs[step]?.[output] ?? ''),
  );
  return runInNewContext(
    substituted.replace(/runner\.os/gu, JSON.stringify(os)),
    {},
    { timeout: 100 },
  );
}

function dependencies(root) {
  for (const [name, path] of [
    ['contracts', 'packages/contracts'],
    ['domain', 'packages/domain'],
    ['desktop', 'apps/desktop'],
  ]) {
    const target = join(root, path);
    const link = join(root, 'node_modules/@sprint-coder', name);
    mkdirSync(target, { recursive: true });
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  }
  for (const name of ['tsc', 'vitest'])
    write(
      join(root, 'node_modules/.bin', name + (process.platform === 'win32' ? '.cmd' : '')),
      'fixture',
    );
}

function sandbox(root, platform = process.platform, content = 'fixture-binary') {
  const directory = join(root, 'apps/desktop/sandbox-runner/build/Release');
  const executable = join(
    directory,
    platform === 'win32' ? 'sprint-coder-sandbox-runner.exe' : 'sprint-coder-sandbox-runner',
  );
  write(executable, content, 0o755);
  write(`${executable}.sha256`, createHash('sha256').update(content).digest('hex') + '\n');
  if (platform === 'win32') {
    write(join(directory, 'sandbox-node-pipe-guard.cjs'), 'guard');
    write(join(root, 'apps/desktop/resources/sandbox-node-pipe-guard.cjs'), 'guard');
  }
  return executable;
}

describe('CI cache reuse and fallback', () => {
  it('installs/builds on miss or invalid exact hit and skips only verified exact hits', () => {
    const install = depsAction.runs.steps.find((step) =>
      step.name.startsWith('Install dependencies on'),
    );
    const builds = sandboxAction.runs.steps.filter((step) =>
      step.name.startsWith('Build sandbox helper on'),
    );
    expect(builds).toHaveLength(2);
    const windows = builds.find((step) => step.shell === 'pwsh');
    expect(windows.run).toContain('if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }');
    expect(windows.run).toContain('exit $LASTEXITCODE');
    for (const [hit, valid, expected] of [
      ['', '', true],
      ['false', 'true', true],
      ['true', 'false', true],
      ['true', 'true', false],
    ]) {
      expect(condition(install.if, { dependencies: { 'cache-hit': hit }, links: { valid } })).toBe(
        expected,
      );
      for (const os of ['Windows', 'Linux', 'macOS']) {
        const selected = builds.filter((build) =>
          condition(build.if, { sandbox: { 'cache-hit': hit }, validation: { valid } }, os),
        );
        expect(selected).toHaveLength(expected ? 1 : 0);
        if (expected) expect(selected[0].shell).toBe(os === 'Windows' ? 'pwsh' : 'bash');
      }
    }
    const restore = sandboxAction.runs.steps.find((step) => step.id === 'sandbox');
    expect(condition(restore.if, { compiler: { cacheable: 'false' } })).toBe(false);
    expect(condition(restore.if, { compiler: { cacheable: 'true' } })).toBe(true);
    expect(sandboxAction.runs.steps.at(-1).if).toBeUndefined();
  });

  it('rejects missing, flattened, or previous-checkout workspace links', () => {
    const root = fixture();
    expect(dependencyCacheValid(root)).toBe(false);
    dependencies(root);
    expect(dependencyCacheValid(root)).toBe(true);
    const link = join(root, 'node_modules/@sprint-coder/contracts');
    rmSync(link, { recursive: true });
    mkdirSync(link);
    expect(dependencyCacheValid(root)).toBe(false);
    rmSync(link, { recursive: true });
    const oldCheckout = fixture();
    symlinkSync(oldCheckout, link, process.platform === 'win32' ? 'junction' : 'dir');
    expect(dependencyCacheValid(root)).toBe(false);
  });

  it('discards prior source-transform caches while keeping installed packages and workspace source', () => {
    const root = fixture();
    dependencies(root);
    write(join(root, 'node_modules/.vite/stale-transform.js'), 'stale');
    write(join(root, 'apps/desktop/node_modules/.cache/stale.js'), 'stale');
    write(join(root, 'packages/contracts/src/current.ts'), 'current');
    clearDependencyToolCaches(root);
    expect(existsSync(join(root, 'node_modules/.vite'))).toBe(false);
    expect(existsSync(join(root, 'apps/desktop/node_modules/.cache'))).toBe(false);
    expect(readFileSync(join(root, 'packages/contracts/src/current.ts'), 'utf8')).toBe('current');
    expect(dependencyCacheValid(root)).toBe(true);
  });

  it('rejects changed binary/digest, missing executable permission, and stale Windows guard', () => {
    const root = fixture();
    const binary = sandbox(root);
    expect(sandboxCacheValid(root)).toBe(true);
    writeFileSync(binary, 'changed');
    expect(sandboxCacheValid(root)).toBe(false);
    sandbox(root);
    writeFileSync(`${binary}.sha256`, 'invalid');
    expect(sandboxCacheValid(root)).toBe(false);
    sandbox(root);
    if (process.platform !== 'win32') {
      chmodSync(binary, 0o600);
      expect(sandboxCacheValid(root)).toBe(false);
    }
    sandbox(root, 'win32');
    expect(sandboxCacheValid(root, 'win32')).toBe(true);
    writeFileSync(
      join(root, 'apps/desktop/resources/sandbox-node-pipe-guard.cjs'),
      'changed guard',
    );
    expect(sandboxCacheValid(root, 'win32')).toBe(false);
    resetSandboxOutput(root);
    expect(existsSync(dirname(binary))).toBe(false);
  });

  it('disables reuse for compiler, target, flags, wrapper, and release profile overrides', () => {
    expect(compilerCacheable({ NODE_VERSION: '22.23.3' })).toBe(true);
    for (const name of [
      'RUSTFLAGS',
      'RUSTC',
      'RUSTC_WRAPPER',
      'RUSTC_WORKSPACE_WRAPPER',
      'CARGO_ENCODED_RUSTFLAGS',
      'CARGO_BUILD_TARGET',
      'CARGO_BUILD_RUSTC',
      'CARGO_BUILD_RUSTC_WRAPPER',
      'CARGO_PROFILE_RELEASE_LTO',
      'CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER',
    ])
      expect(compilerCacheable({ [name]: 'override' }), name).toBe(false);
  });

  it('fails closed when build output or executable protocol is invalid', () => {
    const root = fixture();
    const invoke = () =>
      spawnSync(process.execPath, [join(repo, 'ci-cache.mjs'), 'assert-sandbox'], {
        cwd: root,
        encoding: 'utf8',
      });
    expect(invoke().status).not.toBe(0);
    if (process.platform !== 'win32') {
      sandbox(root, process.platform, '#!/usr/bin/env node\nconsole.log("invalid protocol")\n');
      expect(invoke().status).not.toBe(0);
      expect(sandboxProbeValid(root)).toBe(false);
      sandbox(
        root,
        process.platform,
        '#!/usr/bin/env node\nconsole.log(JSON.stringify({protocolVersion:1,available:false,backend:"fixture",reason:null}))\n',
      );
      expect(invoke().status).toBe(0);
      expect(sandboxProbeValid(root)).toBe(true);
    }
  });
});

describe('full CI partition contract', () => {
  it('requires full coverage on every PR and includes all Linux/Windows shards', () => {
    const output = join(fixture(), 'output');
    const classifier = workflow.jobs.classify.steps.find((step) => step.id === 'scope');
    const run = spawnSync('bash', ['-c', classifier.run], {
      env: { ...process.env, GITHUB_OUTPUT: output },
      encoding: 'utf8',
    });
    expect(run.status).toBe(0);
    expect(readFileSync(output, 'utf8').trim()).toBe('full_matrix=true');
    const entries = workflow.jobs['platform-tests'].strategy.matrix.include;
    expect(entries.filter((entry) => entry.label === 'Linux').map((entry) => entry.shard)).toEqual([
      '1/3',
      '2/3',
      '3/3',
    ]);
    expect(
      entries.filter((entry) => entry.label === 'Windows').map((entry) => entry.shard),
    ).toEqual(Array.from({ length: 4 }, (_, i) => `${i + 1}/4`));
    const cargoSteps = Object.entries(workflow.jobs).flatMap(([job, definition]) =>
      definition.steps
        .filter((step) => step.run?.includes('--test windows_command'))
        .map((step) => ({ job, step })),
    );
    expect(cargoSteps).toHaveLength(1);
    expect(cargoSteps[0].job).toBe('computer-use-native-gate');
    expect(cargoSteps[0].step.if).toBe("runner.os == 'Windows'");
    expect(cargoSteps[0].step.shell).toBe('pwsh');
    const bridges = workflow.jobs['electron-bridges'];
    const matrix = bridges.strategy.matrix;
    const combinations = matrix.include.flatMap((row) =>
      [row.shard, ...(row.follow === '' ? [] : [row.follow])].map(
        (index) => `${row.os}:${row.suite}:${index}`,
      ),
    );
    const expected = ['macos-latest', 'windows-2022'].flatMap((os) =>
      ['coordinator', 'graph'].flatMap((suite) =>
        [0, 1, 2, 3].map((index) => `${os}:${suite}:${index}`),
      ),
    );
    expect(combinations).toHaveLength(16);
    expect(new Set(combinations)).toEqual(new Set(expected));
    for (const row of matrix.include) {
      expect(row.file).toBe(
        row.suite === 'coordinator'
          ? 'src/main/team-coordinator.test.ts'
          : 'src/main/graph-mission-persistence.test.ts',
      );
      expect(row.follow === '').toBe(row.os === 'windows-2022');
    }
    const runBridge = bridges.steps.find(
      (step) => step.name === 'Run bounded Electron integration group',
    );
    expect(runBridge.run).not.toContain('--shard=');
    expect(runBridge.run).not.toContain('--exclude');
    expect(runBridge.env.SPRINT_CODER_ELECTRON_BRIDGE_SHARD).toBe('${{ matrix.shard }}');
    const paired = bridges.steps.find(
      (step) => step.name === 'Run paired Mac Electron integration group',
    );
    expect(paired.if).toBe("matrix.follow != ''");
    expect(paired.env.SPRINT_CODER_ELECTRON_BRIDGE_SHARD).toBe('${{ matrix.follow }}');
    expect(paired.run).toBe(runBridge.run);
    const archify = workflow.jobs['archify-packaged'];
    expect(archify.strategy.matrix.shard).toEqual([1, 2]);
    const runArchify = archify.steps.find((step) =>
      step.name?.startsWith('Exercise the real bundled'),
    );
    expect(runArchify.run).toContain('--fully-parallel --workers=1 --shard=${{ matrix.shard }}/2');
    const evidence = archify.steps.find((step) =>
      step.uses?.startsWith('actions/upload-artifact@'),
    );
    expect(evidence.with.name).toContain('${{ matrix.shard }}');

    const macTest = workflow.jobs['test-macos'].steps.find((step) =>
      step.name.startsWith('Test desktop'),
    );
    const windowsTest = workflow.jobs['platform-tests'].steps.find((step) =>
      step.name.endsWith('on Windows'),
    );
    const linuxTest = workflow.jobs['platform-tests'].steps.find((step) =>
      step.name.endsWith('on Linux'),
    );
    for (const step of [macTest, windowsTest]) {
      expect(step.run.match(/--exclude/gu)).toHaveLength(2);
      expect(step.run).toContain('src/main/team-coordinator.test.ts');
      expect(step.run).toContain('src/main/graph-mission-persistence.test.ts');
    }
    expect(linuxTest.run).not.toContain('--exclude');
    for (const name of ['macos-result', 'windows-result']) {
      const result = workflow.jobs[name];
      expect(result.needs).toContain('electron-bridges');
      const verification = result.steps.find((step) =>
        step.run?.includes('ELECTRON_BRIDGE_RESULT'),
      );
      for (const status of ['success', 'failure', 'cancelled', 'skipped']) {
        const invocation = spawnSync('bash', ['-c', verification.run], {
          env: {
            ...process.env,
            PACKAGE_TEST_RESULT: 'success',
            MACOS_TEST_RESULT: 'success',
            MACOS_PACKAGE_RESULT: 'success',
            WINDOWS_E2E_RESULT: 'success',
            FULL_MATRIX: 'true',
            TEST_RESULT: 'success',
            LINUX_PACKAGE_RESULT: 'success',
            WINDOWS_PACKAGE_RESULT: 'success',
            ELECTRON_BRIDGE_RESULT: status,
          },
          encoding: 'utf8',
        });
        expect(invocation.status === 0).toBe(status === 'success');
      }
    }
    for (const job of Object.values(workflow.jobs)) {
      const depsIndex = job.steps?.findIndex(
        (step) => step.uses === './.github/actions/install-deps',
      );
      const nativeIndex = job.steps?.findIndex((step) => step.id === 'better-sqlite-cache');
      if (nativeIndex >= 0) {
        expect(depsIndex).toBeGreaterThanOrEqual(0);
        expect(depsIndex).toBeLessThan(nativeIndex);
      }
    }
  });
});
