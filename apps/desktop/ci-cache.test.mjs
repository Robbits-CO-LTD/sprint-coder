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

function macExerciseFixture() {
  const root = fixture();
  write(join(root, 'apps/desktop/out/test/Sprint.app/Contents/MacOS/Sprint'), 'fixture', 0o755);
  write(
    join(root, 'bin/npx'),
    `#!${process.execPath}\n` +
      String.raw`
const { appendFileSync, existsSync, writeFileSync } = require('node:fs');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const root = process.env.RUNNER_TEMP;
const trace = join(root, 'trace');
const pid = join(root, 'sidecar-pid');
const smoke = process.argv[2] === 'vitest';
appendFileSync(trace, (smoke ? 'smoke' : 'archify') + ':start\n');
if (smoke) {
  if (process.env.SPRINT_CODER_MANAGED_LOCAL_LIVE !== '1' ||
      !process.cwd().replaceAll('\\', '/').endsWith('/apps/desktop')) process.exit(99);
  if (process.env.CI_FIXTURE_CANCEL === '1') {
    writeFileSync(join(root, 'smoke-pid'), String(process.pid));
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      env: {}, stdio: 'ignore',
    });
    writeFileSync(pid, String(child.pid));
    setInterval(() => {}, 1000);
  } else setTimeout(() => {
    appendFileSync(trace, 'smoke:done\n');
    process.exit(Number(process.env.CI_FIXTURE_SMOKE_RESULT));
  }, 60);
} else if (process.env.CI_FIXTURE_CANCEL === '1') {
  const cancel = () => {
    if (!existsSync(pid)) return setTimeout(cancel, 10);
    writeFileSync(join(root, 'archify-pid'), String(process.pid));
    process.kill(process.ppid, 'SIGTERM');
    setInterval(() => {}, 1000);
  };
  cancel();
} else {
  if (process.env.SPRINT_CODER_MANAGED_LOCAL_LIVE !== undefined) process.exit(99);
  appendFileSync(trace, 'archify:done\n');
  process.exit(Number(process.env.CI_FIXTURE_ARCHIFY_RESULT));
}
`,
    0o755,
  );
  const step = workflow.jobs['package-macos'].steps.find(
    (entry) => entry.name === 'Exercise bundled Archify using the production package',
  );
  return {
    root,
    invoke: (env) =>
      spawnSync('bash', ['-e', '-c', step.run], {
        cwd: root,
        env: {
          ...process.env,
          ...step.env,
          RUNNER_TEMP: root,
          PATH: `${root}/bin:${process.env.PATH}`,
          ...env,
        },
        encoding: 'utf8',
        timeout: 3_000,
      }),
  };
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
    expect(restore.with.key).not.toContain("'**/.cargo/");
    expect(restore.with.key).not.toContain("'**/rust-toolchain");
    expect(restore.with.key).toContain("'.cargo/config*'");
    expect(restore.with.key).toContain("'apps/desktop/sandbox-runner/.cargo/config*'");
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

  it('falls back to an ordinary build when compiler identity is unavailable', () => {
    const root = fixture();
    const result = spawnSync(process.execPath, [join(repo, 'ci-cache.mjs'), 'compiler'], {
      cwd: root,
      env: { ...process.env, PATH: root, Path: root },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('cacheable=false');
    const restore = sandboxAction.runs.steps.find((step) => step.id === 'sandbox');
    expect(condition(restore.if, { compiler: { cacheable: 'false' } })).toBe(false);
    const windowsBuild = sandboxAction.runs.steps.find((step) => step.shell === 'pwsh');
    expect(condition(windowsBuild.if, { sandbox: {}, validation: {} })).toBe(true);
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
  it.skipIf(process.platform === 'win32')(
    'waits for both Mac checks and rejects either failure',
    () => {
      for (const [smoke, archify] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ]) {
        const fixture = macExerciseFixture();
        const result = fixture.invoke({
          CI_FIXTURE_SMOKE_RESULT: String(smoke),
          CI_FIXTURE_ARCHIFY_RESULT: String(archify),
        });
        expect(result.error).toBeUndefined();
        expect(result.status === 0).toBe(smoke === 0 && archify === 0);
        const trace = readFileSync(join(fixture.root, 'trace'), 'utf8');
        expect(trace).toContain('archify:done');
        expect(trace).toContain('smoke:done');
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'kills the restricted-env smoke descendant when cancelled',
    () => {
      const fixture = macExerciseFixture();
      const pids = [];
      try {
        const result = fixture.invoke({ CI_FIXTURE_CANCEL: '1' });
        for (const file of ['sidecar-pid', 'archify-pid', 'smoke-pid']) {
          const path = join(fixture.root, file);
          if (existsSync(path)) pids.push(Number(readFileSync(path, 'utf8')));
        }
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(143);
        expect(pids).toHaveLength(3);
        for (const pid of pids) {
          const child = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
          expect(child.stdout.trim() === '' || child.stdout.trim().startsWith('Z')).toBe(true);
        }
      } finally {
        for (const pid of pids) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            /* Already stopped. */
          }
        }
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'executes all eight Mac groups and rejects empty lists or failed groups',
    () => {
      const root = fixture();
      mkdirSync(join(root, 'apps/desktop'), { recursive: true });
      write(
        join(root, 'bin/npx'),
        '#!/bin/sh\nprintf "%s:%s\\n" "$3" "$SPRINT_CODER_ELECTRON_BRIDGE_SHARD" >> "$RUNNER_TEMP/groups"\ntest "$SPRINT_CODER_ELECTRON_BRIDGE_SHARD" != "$CI_FIXTURE_FAIL_GROUP"\n',
        0o755,
      );
      const mac = workflow.jobs['test-macos'];
      const expected = [];
      for (const row of mac.strategy.matrix.include) {
        for (const [suite, label, file] of [
          ['coordinator', 'Coordinator', 'team-coordinator'],
          ['graph', 'Graph', 'graph-mission-persistence'],
        ]) {
          const step = mac.steps.find((entry) => entry.name === `Test ${label} Electron groups`);
          const invoke = (groups, fail = '') =>
            spawnSync('bash', ['-e', '-c', step.run], {
              cwd: join(root, step['working-directory']),
              env: {
                ...process.env,
                PATH: `${root}/bin:${process.env.PATH}`,
                RUNNER_TEMP: root,
                BRIDGE_GROUPS: groups,
                CI_FIXTURE_FAIL_GROUP: fail,
              },
              encoding: 'utf8',
            });
          expect(invoke(row[suite]).status).toBe(0);
          expected.push(
            ...row[suite].split(' ').map((index) => `src/main/${file}.test.ts:${index}`),
          );
        }
      }
      expect(readFileSync(join(root, 'groups'), 'utf8').trim().split('\n')).toEqual(expected);
      expect(new Set(expected).size).toBe(8);
      for (const label of ['Coordinator', 'Graph']) {
        const step = mac.steps.find((entry) => entry.name === `Test ${label} Electron groups`);
        for (const [groups, fail] of [
          ['', ''],
          ['   ', ''],
          ['0 1', '1'],
        ]) {
          const result = spawnSync('bash', ['-e', '-c', step.run], {
            cwd: join(root, step['working-directory']),
            env: {
              ...process.env,
              PATH: `${root}/bin:${process.env.PATH}`,
              RUNNER_TEMP: root,
              BRIDGE_GROUPS: groups,
              CI_FIXTURE_FAIL_GROUP: fail,
            },
            encoding: 'utf8',
          });
          expect(result.status).not.toBe(0);
        }
      }
    },
  );

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
    const macRows = workflow.jobs['test-macos'].strategy.matrix.include;
    expect(macRows.map((row) => row.shard)).toEqual(['1/3', '2/3', '3/3']);
    const combinations = matrix.include.map((row) => `${row.os}:${row.suite}:${row.shard}`);
    for (const row of macRows) {
      for (const suite of ['coordinator', 'graph']) {
        const indices = row[suite].trim().split(/\s+/u);
        expect(indices.length).toBeGreaterThan(0);
        expect(indices.every((index) => /^[0-3]$/u.test(index))).toBe(true);
        combinations.push(...indices.map((index) => `macos-latest:${suite}:${index}`));
      }
    }
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
      expect(row.os).toBe('windows-2022');
    }
    const runBridge = bridges.steps.find(
      (step) => step.name === 'Run bounded Electron integration group',
    );
    expect(runBridge.run).not.toContain('--shard=');
    expect(runBridge.run).not.toContain('--exclude');
    expect(runBridge.env.SPRINT_CODER_ELECTRON_BRIDGE_SHARD).toBe('${{ matrix.shard }}');
    for (const [suite, name, file] of [
      ['coordinator', 'Coordinator', 'team-coordinator'],
      ['graph', 'Graph', 'graph-mission-persistence'],
    ]) {
      const step = workflow.jobs['test-macos'].steps.find(
        (entry) => entry.name === `Test ${name} Electron groups`,
      );
      expect(step.env.BRIDGE_GROUPS).toBe('${{ matrix.' + suite + ' }}');
      expect(step.run).toContain(`npx vitest run src/main/${file}.test.ts --maxWorkers=1`);
      expect(step.run).not.toContain('--shard=');
      expect(step.run).not.toContain('--exclude');
      expect(step['continue-on-error']).toBeUndefined();
    }
    const archify = workflow.jobs['archify-packaged'];
    expect(archify.strategy.matrix.shard).toEqual([1, 2]);
    expect(archify.strategy.matrix.os).toEqual(['windows-2022']);
    const macPackage = workflow.jobs['package-macos'];
    expect(macPackage.needs).toBeUndefined();
    const packageIndex = macPackage.steps.findIndex(
      (step) => step.name === 'Production package smoke',
    );
    const exerciseIndex = macPackage.steps.findIndex(
      (step) => step.name === 'Exercise bundled Archify using the production package',
    );
    expect(packageIndex).toBeGreaterThanOrEqual(0);
    expect(exerciseIndex).toBeGreaterThan(packageIndex);
    const exerciseMac = macPackage.steps[exerciseIndex];
    expect(exerciseMac.env.SPRINT_CODER_E2E_MODE).toBe('packaged');
    expect(exerciseMac.run).toContain('SPRINT_CODER_E2E_EXECUTABLE_PATH=');
    expect(exerciseMac.run).toContain('--workers=1');
    expect(exerciseMac.run).not.toContain('--shard=');
    expect(exerciseMac['continue-on-error']).toBeUndefined();
    expect(macPackage.steps.some((step) => step.env?.SPRINT_CODER_MANAGED_LOCAL_LIVE)).toBe(false);
    expect(exerciseMac.run).toContain('SPRINT_CODER_MANAGED_LOCAL_LIVE=1');
    expect(exerciseMac.run).toContain('src/main/managed-local-runtime-supervisor.test.ts');
    expect(macPackage.steps.some((step) => step.run?.includes('build:managed-local-sidecar'))).toBe(
      false,
    );
    const required = workflow.jobs.required;
    expect(required.needs).toContain('computer-use-native-gate');
    const macResult = workflow.jobs['macos-result'];
    expect(macResult.needs).toContain('computer-use-native-gate');
    for (const status of ['success', 'failure', 'cancelled', 'skipped', '']) {
      for (const [verification, dependency] of [
        [required.steps[0], 'COMPUTER_USE_NATIVE_RESULT'],
        [macResult.steps[0], 'COMPUTER_USE_NATIVE_RESULT'],
        [macResult.steps[0], 'MACOS_TEST_RESULT'],
      ]) {
        const invocation = spawnSync('bash', ['-e', '-c', verification.run], {
          env: {
            ...process.env,
            QUALITY_RESULT: 'success',
            MACOS_RESULT: 'success',
            WINDOWS_RESULT: 'success',
            COMPUTER_USE_NATIVE_RESULT: 'success',
            ARCHIFY_RESULT: 'success',
            PACKAGE_TEST_RESULT: 'success',
            MACOS_TEST_RESULT: 'success',
            MACOS_PACKAGE_RESULT: 'success',
            ELECTRON_BRIDGE_RESULT: 'success',
            [dependency]: status,
          },
          encoding: 'utf8',
        });
        expect(invocation.status === 0).toBe(status === 'success');
      }
    }

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
            COMPUTER_USE_NATIVE_RESULT: 'success',
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
