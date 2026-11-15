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
import { classifyChanges, scopeOutputs, verifyRequiredJobs } from '../../ci-scope.mjs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearDependencyToolCaches,
  compilerCacheable,
  dependencyCacheValid,
  desktopControlCacheValid,
  desktopControlProbeValid,
  resetDesktopControlOutput,
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
const desktopControlAction = parse(
  readFileSync(join(repo, '.github/actions/prepare-desktop-control/action.yml'), 'utf8'),
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

// macos-latest is Apple silicon; the Windows runners are x64.
function condition(expression, outputs, os = 'Windows', arch = os === 'macOS' ? 'ARM64' : 'X64') {
  const substituted = expression.replace(
    /steps\.([a-z-]+)\.outputs\.([a-z-]+)/gu,
    (_, step, output) => JSON.stringify(outputs[step]?.[output] ?? ''),
  );
  return runInNewContext(
    substituted
      .replace(/runner\.os/gu, JSON.stringify(os))
      .replace(/runner\.arch/gu, JSON.stringify(arch)),
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

  it('builds desktop control only on Windows and macOS, on a miss or an invalid hit, keyed by its source', () => {
    const builds = desktopControlAction.runs.steps.filter((step) =>
      step.name.startsWith('Build desktop-control on'),
    );
    expect(builds).toHaveLength(2);
    const build = builds.find((step) => step.shell === 'pwsh');
    expect(build.run).toContain('npm run build:desktop-control');
    expect(build.run).toContain('if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }');
    const macBuild = builds.find((step) => step.shell === 'bash');
    expect(macBuild.run).toContain('set -euo pipefail');
    expect(macBuild.run).toContain('node ci-cache.mjs reset-desktop-control');
    expect(macBuild.run).toContain('npm run build:desktop-control');
    for (const [hit, valid, expected] of [
      ['', '', true],
      ['false', 'true', true],
      ['true', 'false', true],
      ['true', 'true', false],
    ]) {
      const outputs = { 'desktop-control': { 'cache-hit': hit }, validation: { valid } };
      expect(condition(build.if, outputs, 'Windows')).toBe(expected);
      for (const os of ['Linux', 'macOS']) expect(condition(build.if, outputs, os)).toBe(false);
      expect(condition(macBuild.if, outputs, 'macOS')).toBe(expected);
      for (const os of ['Linux', 'Windows'])
        expect(condition(macBuild.if, outputs, os)).toBe(false);
      // Intel macOS ships no desktop control, so its runners build nothing.
      expect(condition(macBuild.if, outputs, 'macOS', 'X64')).toBe(false);
    }
    const compiler = desktopControlAction.runs.steps.find((step) => step.id === 'compiler');
    for (const [os, expected] of [
      ['Windows', true],
      ['macOS', true],
      ['Linux', false],
    ])
      expect(condition(compiler.if, {}, os)).toBe(expected);
    expect(condition(compiler.if, {}, 'macOS', 'X64')).toBe(false);
    const restore = desktopControlAction.runs.steps.find((step) => step.id === 'desktop-control');
    expect(condition(restore.if, { compiler: { cacheable: 'false' } })).toBe(false);
    expect(condition(restore.if, { compiler: { cacheable: 'true' } })).toBe(true);
    expect(condition(restore.if, { compiler: { cacheable: 'true' } }, 'macOS')).toBe(true);
    expect(condition(restore.if, { compiler: { cacheable: 'false' } }, 'macOS')).toBe(false);
    expect(condition(restore.if, { compiler: { cacheable: 'true' } }, 'Linux')).toBe(false);
    expect(condition(restore.if, { compiler: { cacheable: 'true' } }, 'macOS', 'X64')).toBe(false);
    // The runner OS is part of the key, so a Windows build is never restored on macOS.
    expect(restore.with.key).toContain('${{ runner.os }}-${{ runner.arch }}');
    expect(restore.with.path).toBe('apps/desktop/desktop-control/build/Release');
    // The vendored source, its lock and pinned toolchain, but never its own build output.
    expect(restore.with.key).toContain("'apps/desktop/desktop-control/**'");
    expect(restore.with.key).toContain("'!apps/desktop/desktop-control/build/**'");
    expect(restore.with.key).toContain("'!apps/desktop/desktop-control/target/**'");
    expect(restore.with.key).toContain("'build-desktop-control.mjs'");
    const verify = desktopControlAction.runs.steps.at(-1);
    expect(verify.run).toBe('node ci-cache.mjs assert-desktop-control');
    expect(condition(verify.if, {}, 'Linux')).toBe(false);
    expect(condition(verify.if, {}, 'macOS', 'X64')).toBe(false);
    for (const os of ['Windows', 'macOS']) expect(condition(verify.if, {}, os)).toBe(true);
    // Every Windows job that packages or runs the desktop tests prepares it first.
    for (const [job, consumer] of [
      ['package-windows-build', 'npx electron-forge package --platform=win32 --arch=x64'],
      ['package-windows', 'npx electron-forge make --platform=win32 --arch=x64'],
      ['platform-tests', 'npx vitest run --shard=${{ matrix.shard }} --maxWorkers=1'],
    ]) {
      const steps = workflow.jobs[job].steps;
      const prepare = steps.findIndex(
        (step) => step.uses === './.github/actions/prepare-desktop-control',
      );
      expect(prepare, job).toBeGreaterThan(-1);
      expect(steps.findIndex((step) => step.run?.startsWith(consumer))).toBeGreaterThan(prepare);
    }
    // So does every macOS job that packages or tests the desktop app (Apple silicon ships it).
    for (const [job, consumer] of [
      ['package-macos', 'npx electron-forge package'],
      ['test-macos', 'npx vitest run --shard=${{ matrix.shard }}'],
    ]) {
      const steps = workflow.jobs[job].steps;
      const prepare = steps.findIndex(
        (step) => step.uses === './.github/actions/prepare-desktop-control',
      );
      expect(prepare, job).toBeGreaterThan(-1);
      expect(steps.findIndex((step) => step.run?.startsWith(consumer))).toBeGreaterThan(prepare);
    }
  });

  it('accepts a cached desktop-control build only when its bytes match its seal', () => {
    const root = fixture();
    expect(desktopControlCacheValid(root, 'win32')).toBe(false);
    const directory = join(root, 'apps/desktop/desktop-control/build/Release');
    const executable = join(directory, 'sprint-coder-desktop-control.exe');
    write(executable, 'fixture-desktop-control', 0o755);
    expect(desktopControlCacheValid(root, 'win32')).toBe(false);
    write(
      `${executable}.sha256`,
      `${createHash('sha256').update('fixture-desktop-control').digest('hex')}\n`,
    );
    expect(desktopControlCacheValid(root, 'win32')).toBe(true);
    // The Windows build is not taken for the macOS one.
    expect(desktopControlCacheValid(root, 'darwin')).toBe(false);
    writeFileSync(executable, 'changed');
    expect(desktopControlCacheValid(root, 'win32')).toBe(false);
    writeFileSync(`${executable}.sha256`, 'invalid');
    expect(desktopControlCacheValid(root, 'win32')).toBe(false);
    // Not an executable that starts and reports a version.
    expect(desktopControlProbeValid(root, 'win32')).toBe(false);
    resetDesktopControlOutput(root);
    expect(existsSync(directory)).toBe(false);
    const invoke = spawnSync(
      process.execPath,
      [join(repo, 'ci-cache.mjs'), 'assert-desktop-control'],
      {
        cwd: root,
        encoding: 'utf8',
      },
    );
    expect(invoke.status).not.toBe(0);
  });

  // Windows reports no execute bits, so the macOS layout is checked on Unix hosts only.
  it.skipIf(process.platform === 'win32')(
    'accepts a cached macOS desktop-control build only when it is executable and matches its seal',
    () => {
      const root = fixture();
      const directory = join(root, 'apps/desktop/desktop-control/build/Release');
      const executable = join(directory, 'sprint-coder-desktop-control');
      const content = '#!/bin/sh\necho "agent-desktop 1.2.0"\n';
      write(executable, content, 0o644);
      write(`${executable}.sha256`, `${createHash('sha256').update(content).digest('hex')}\n`);
      // A sealed file that cannot be executed is not the build.
      expect(desktopControlCacheValid(root, 'darwin')).toBe(false);
      chmodSync(executable, 0o755);
      expect(desktopControlCacheValid(root, 'darwin')).toBe(true);
      expect(desktopControlCacheValid(root, 'win32')).toBe(false);
      expect(desktopControlProbeValid(root, 'darwin')).toBe(true);
      const invoke = () =>
        spawnSync(process.execPath, [join(repo, 'ci-cache.mjs'), 'assert-desktop-control'], {
          cwd: root,
          encoding: 'utf8',
        });
      expect(invoke().status).toBe(0);
      writeFileSync(executable, '#!/bin/sh\nexit 1\n');
      expect(desktopControlCacheValid(root, 'darwin')).toBe(false);
      expect(invoke().status).not.toBe(0);
    },
  );

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

describe('CI scope wiring', () => {
  it('routes only opted-in trusted events to MSI and preserves hosted OS coverage', () => {
    const labels = [
      'self-hosted',
      'Windows',
      'X64',
      'robbits-ci',
      'robbits-ci-ready',
      'ci-host-msi',
    ];
    const repository = 'Robbits-CO-LTD/sprint-coder';
    const route = (
      output,
      enabled,
      eventName,
      headRepo,
      actor = 'maintainer',
      author = 'maintainer',
      desktopControl = 'false',
    ) => {
      const expression = workflow.jobs.classify.outputs[output];
      return JSON.parse(
        runInNewContext(expression.slice(3, -2), {
          steps: { scope: { outputs: { desktop_control_rust_required: desktopControl } } },
          vars: { SPRINT_CODER_MSI_CI_ENABLED: enabled },
          github: {
            repository,
            actor,
            event_name: eventName,
            event: {
              pull_request: {
                head: { repo: { full_name: headRepo } },
                user: { login: author },
              },
            },
          },
        }),
      );
    };
    for (const [output, fallback] of [
      ['common_runner', 'ubuntu-latest'],
      ['rust_runner', 'windows-2022'],
    ]) {
      for (const enabled of ['', 'false'])
        expect(route(output, enabled, 'pull_request', repository)).toEqual([fallback]);
      for (const eventName of ['push', 'workflow_dispatch'])
        expect(route(output, 'true', eventName, repository)).toEqual(labels);
      expect(route(output, 'true', 'pull_request', repository)).toEqual([fallback]);
      expect(route(output, 'true', 'pull_request', 'outside/fork')).toEqual([fallback]);
      expect(route(output, 'true', 'pull_request', undefined)).toEqual([fallback]);
      expect(route(output, 'true', 'pull_request', repository, 'dependabot[bot]')).toEqual([
        fallback,
      ]);
      expect(
        route(output, 'true', 'pull_request', repository, 'maintainer', 'dependabot[bot]'),
      ).toEqual([fallback]);
      expect(route(output, 'true', 'pull_request_target', repository)).toEqual([fallback]);
    }
    // MSI lacks the desktop-control toolchain: a push that must build it uses a hosted
    // runner like a PR, while sandbox-only pushes and full runs keep MSI.
    expect(
      route('rust_runner', 'true', 'push', repository, 'maintainer', 'maintainer', 'true'),
    ).toEqual(['windows-2022']);
    expect(
      route('common_runner', 'true', 'push', repository, 'maintainer', 'maintainer', 'true'),
    ).toEqual(labels);
    expect(workflow.jobs.classify.outputs.common_runner).not.toContain('steps.');
    for (const job of ['quality', 'package-tests'])
      expect(workflow.jobs[job]['runs-on']).toBe(
        '${{ fromJSON(needs.classify.outputs.common_runner) }}',
      );
    expect(depsAction.inputs['cache-installed-tree'].default).toBe('true');
    expect(depsAction.runs.steps.find((step) => step.id === 'dependencies').if).toBe(
      "inputs.cache-installed-tree == 'true'",
    );
    for (const job of ['quality', 'package-tests'])
      expect(
        workflow.jobs[job].steps.find((step) => step.uses === './.github/actions/install-deps')
          .with['cache-installed-tree'],
      ).toBe("${{ runner.name != 'MSI-ci' }}");
    expect(workflow.jobs['sandbox-rust-windows']['runs-on']).toBe(
      '${{ fromJSON(needs.classify.outputs.rust_runner) }}',
    );
    expect(workflow.jobs['test-macos']['runs-on']).toBe('macos-latest');
    // Linux is no longer distributed, so it has no package smoke (owner decision, 2026-11-16).
    expect(workflow.jobs['package-linux']).toBeUndefined();
    expect(workflow.jobs['renderer-tests']['runs-on']).toBe('ubuntu-latest');
    expect(workflow.jobs['package-windows']['runs-on']).toBe('windows-2022');
    for (const job of ['quality', 'package-tests', 'sandbox-rust-windows']) {
      const preflight = workflow.jobs[job].steps.find(
        (step) => step.uses === './.github/actions/prepare-msi',
      );
      expect(preflight.if).toBe("runner.name == 'MSI-ci'");
      expect(workflow.jobs[job].steps.indexOf(preflight)).toBe(1);
    }
    const matrix = workflow.jobs.quality.strategy.matrix.include;
    const qualityRows = (runner, full = true) =>
      runInNewContext(matrix.slice(3, -2), {
        fromJSON: JSON.parse,
        contains: (value, token) => value.includes(token),
        needs: {
          classify: {
            outputs: { common_runner: JSON.stringify(runner), full_matrix: String(full) },
          },
        },
      });
    expect(qualityRows(labels)).toEqual([{ label: 'shared', command: 'shared' }]);
    expect(qualityRows(['ubuntu-latest'])).toEqual([
      { label: 'typecheck', command: 'typecheck' },
      { label: 'lint', command: 'lint' },
      { label: 'format', command: 'format:check' },
    ]);
    expect(qualityRows(['ubuntu-latest'], false)).toEqual([
      { label: 'typecheck', command: 'typecheck' },
      { label: 'lint', command: 'lint' },
    ]);
    const shared = workflow.jobs.quality.steps.find(
      (step) => step.if === "matrix.command == 'shared'",
    );
    expect(shared.run).toContain("'typecheck', 'lint', 'format:check'");
    expect(shared.run).toContain('if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }');
  });

  it.each([
    ['README.md', ['classify', 'required']],
    ['website/index.html', ['classify', 'website', 'required']],
    // PRs run static checks only; tests and package smokes run only before a release.
    ['apps/desktop/src/renderer/lib/format.ts', ['classify', 'quality', 'required']],
    ['apps/desktop/src/renderer/components/RunCard.tsx', ['classify', 'quality', 'required']],
    ['apps/desktop/src/main/persistence.ts', ['classify', 'quality', 'required']],
    ['apps/desktop/forge.config.ts', ['classify', 'quality', 'package-tests', 'required']],
    [
      'apps/desktop/desktop-control/crates/windows/src/lib.rs',
      ['classify', 'quality', 'sandbox-rust-windows', 'required'],
    ],
    // A push to main runs the same static checks as a PR.
    ['apps/desktop/forge.config.ts', ['classify', 'quality', 'package-tests', 'required'], 'push'],
    ['README.md', ['classify', 'required'], 'push'],
    [
      'apps/desktop/desktop-control/crates/windows/src/lib.rs',
      ['classify', 'quality', 'sandbox-rust-windows', 'required'],
      'push',
    ],
    // Every test and package smoke: manual CI, and the release call (a tag push with full: true).
    ...['workflow_dispatch', 'release'].map((event) => [
      'README.md',
      [
        'classify',
        'quality',
        'package-tests',
        'sandbox-rust-windows',
        'test-macos',
        'package-macos',
        'platform-tests',
        'electron-bridges',
        'package-windows-build',
        'package-windows',
        'renderer-tests',
        'website',
        'required',
      ],
      event,
    ]),
  ])(
    'selects only the planned workflow jobs for %s (%#)',
    (path, expected, event = 'pull_request') => {
      const release = event === 'release';
      const eventName = release ? 'push' : event;
      const scope = classifyChanges([{ path, status: 'M' }], { eventName, fullTests: release });
      const outputs = scopeOutputs(scope);
      const selected = Object.entries(workflow.jobs)
        .filter(([, job]) => {
          if (!job.if) return true;
          let expression = job.if.replaceAll('always()', 'true');
          for (const [key, value] of Object.entries(outputs))
            expression = expression.replaceAll(
              `needs.classify.outputs.${key}`,
              JSON.stringify(value),
            );
          // The selected jobs pass, so the main failure report stays out of every selection.
          const ref = release ? 'refs/tags/v1.0.0' : 'refs/heads/main';
          const context = {
            github: { event_name: eventName, ref },
            needs: { required: { result: 'success' } },
          };
          return runInNewContext(expression, context, { timeout: 100 });
        })
        .map(([id]) => id);
      expect(new Set(selected)).toEqual(new Set(expected));
      const results = Object.fromEntries(
        workflow.jobs.required.needs.map((id) => [
          id,
          selected.includes(id) ? 'success' : 'skipped',
        ]),
      );
      expect(() => verifyRequiredJobs(scope, results)).not.toThrow();
    },
  );

  it('waits for every job and rejects failures of required package and website checks', () => {
    expect([...workflow.jobs.required.needs].sort()).toEqual(
      Object.keys(workflow.jobs)
        .filter((id) => !['required', 'report-main-failure'].includes(id))
        .sort(),
    );
    const scope = classifyChanges([{ path: 'apps/desktop/forge.config.ts', status: 'M' }], {
      eventName: 'push',
      fullTests: true,
    });
    const results = Object.fromEntries(workflow.jobs.required.needs.map((id) => [id, 'success']));
    for (const job of ['package-windows-build', 'website']) {
      for (const value of ['failure', 'cancelled', 'skipped', undefined])
        expect(() => verifyRequiredJobs(scope, { ...results, [job]: value })).toThrow(job);
    }
    const producer = workflow.jobs['package-windows-build'];
    expect(
      producer.steps.some(
        (step) => step.run === 'npx electron-forge package --platform=win32 --arch=x64',
      ),
    ).toBe(true);
    const installer = workflow.jobs['package-windows'].steps;
    expect(workflow.jobs['package-windows'].needs).toBe('classify');
    expect(
      installer.some((step) => step.run === 'npx electron-forge make --platform=win32 --arch=x64'),
    ).toBe(true);
    expect(installer.some((step) => step.uses?.startsWith('actions/download-artifact@'))).toBe(
      false,
    );
  });

  it('reports a failed main push run as a bug Issue, and nothing else', () => {
    const report = workflow.jobs['report-main-failure'];
    expect(report.needs).toBe('required');
    // Only this job may write Issues; it reads the run's jobs to name the failed ones.
    expect(report.permissions).toEqual({ actions: 'read', issues: 'write' });
    for (const [id, job] of Object.entries(workflow.jobs))
      if (id !== 'report-main-failure') expect(job.permissions?.issues).toBeUndefined();
    expect(report.steps.every((step) => step.uses === undefined)).toBe(true);
    const runs = (event_name, result, ref = 'refs/heads/main') =>
      runInNewContext(report.if.replaceAll('always()', 'true'), {
        github: { event_name, ref },
        needs: { required: { result } },
      });
    expect(runs('push', 'failure')).toBe(true);
    for (const [event, result, ref] of [
      ['push', 'success'],
      ['push', 'cancelled'],
      ['pull_request', 'failure'],
      ['workflow_dispatch', 'failure'],
      ['push', 'failure', 'refs/heads/other'],
      // The release call keeps the tag push event; its failure stops the release instead.
      ['push', 'failure', 'refs/tags/v1.0.0'],
    ])
      expect(runs(event, result, ref)).toBe(false);
    const script = report.steps[0].run;
    expect(script).toContain('${GITHUB_SHA:0:7}');
    expect(script).toContain('select(.conclusion == "failure")');
    expect(script).toContain('map(select(.title == env.ISSUE_TITLE))');
    expect(script).toContain('gh issue comment "${existing}" --body-file "${body}"');
    expect(script).toContain('gh issue create --title "${ISSUE_TITLE}" --label bug');
    expect(script.indexOf('gh issue list --state open')).toBeLessThan(
      script.indexOf('gh issue create'),
    );
  });

  it('runs the full set only when the release workflow asks for it through workflow_call', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(
      ['pull_request', 'push', 'workflow_call', 'workflow_dispatch'].sort(),
    );
    expect(workflow.on.push).toEqual({ branches: ['main'] });
    expect(workflow.on.workflow_call.inputs).toEqual({
      full: expect.objectContaining({ type: 'boolean', required: true }),
    });
    // The called workflow needs no secrets; GitHub would reject a call that passed none it requires.
    expect(workflow.on.workflow_call.secrets).toBeUndefined();
    const classifier = workflow.jobs.classify.steps.find((step) => step.id === 'scope');
    const flag = (inputs) =>
      runInNewContext(classifier.env.CI_FULL_TESTS.slice(3, -2), { inputs }, { timeout: 100 });
    expect(flag({ full: true })).toBe('true');
    for (const inputs of [{ full: false }, {}]) expect(flag(inputs)).toBe('false');
    const docs = workflow.jobs.classify.steps.find(
      (step) => step.name === 'Check documentation whitespace',
    );
    expect(docs.env.CI_DIFF_HEAD).toBe('${{ steps.scope.outputs.diff_head }}');
    expect(workflow.jobs.classify.outputs.diff_head).toBe('${{ steps.scope.outputs.diff_head }}');
    // A called run takes the caller's name and tag ref, so it never shares the main or PR group.
    expect(workflow.concurrency).toEqual({
      group: 'ci-${{ github.workflow }}-${{ github.ref }}',
      'cancel-in-progress': "${{ github.event_name == 'pull_request' }}",
    });
  });
});

describe('full CI partition contract', () => {
  it.skipIf(process.platform === 'win32')(
    'builds the Mac production package explicitly and propagates failures',
    () => {
      for (const job of ['package-macos']) {
        const step = workflow.jobs[job].steps.find(
          (entry) => entry.name === 'Production package smoke',
        );
        expect(step['working-directory']).toBe('apps/desktop');
        expect(step['continue-on-error']).toBeUndefined();
        const root = fixture();
        mkdirSync(join(root, 'apps/desktop'), { recursive: true });
        write(
          join(root, 'bin/npx'),
          '#!/bin/sh\n[ "$1" = "electron-forge" ] && [ "$2" = "package" ] || exit 99\nexit "$CI_FIXTURE_PACKAGE_RESULT"\n',
          0o755,
        );
        for (const exitCode of [0, 7]) {
          const result = spawnSync('bash', ['-e', '-c', step.run], {
            cwd: join(root, step['working-directory']),
            env: {
              ...process.env,
              ...step.env,
              PATH: `${root}/bin:${process.env.PATH}`,
              CI_FIXTURE_PACKAGE_RESULT: String(exitCode),
            },
            encoding: 'utf8',
            timeout: 3_000,
          });
          expect(result.error).toBeUndefined();
          expect(result.status).toBe(exitCode);
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

  it('keeps all Windows shards and native boundaries required for full validation', () => {
    const output = join(fixture(), 'output');
    const classifier = workflow.jobs.classify.steps.find((step) => step.id === 'scope');
    const run = spawnSync(process.execPath, ['ci-scope.mjs', 'classify'], {
      cwd: repo,
      env: { ...process.env, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_OUTPUT: output },
      encoding: 'utf8',
    });
    expect(run.status).toBe(0);
    expect(classifier.run).toBe('node ci-scope.mjs classify');
    expect(readFileSync(output, 'utf8')).toContain('full_matrix=true');
    expect(workflow.jobs['platform-tests'].strategy.matrix).toBe(
      '${{ fromJSON(needs.classify.outputs.platform_matrix) }}',
    );
    const entries = JSON.parse(
      scopeOutputs(classifyChanges([], { eventName: 'workflow_dispatch' })).platform_matrix,
    ).include;
    // macOS runs in test-macos; Linux is no longer tested (owner decision, 2026-11-16).
    expect(entries.filter((entry) => entry.label !== 'Windows')).toEqual([]);
    expect(
      entries.filter((entry) => entry.label === 'Windows').map((entry) => entry.shard),
    ).toEqual(Array.from({ length: 5 }, (_, i) => `${i + 1}/5`));
    const cargoSteps = Object.entries(workflow.jobs).flatMap(([job, definition]) =>
      definition.steps
        .filter((step) => step.run?.includes('--test windows_command'))
        .map((step) => ({ job, step })),
    );
    expect(cargoSteps).toHaveLength(1);
    expect(cargoSteps[0].job).toBe('platform-tests');
    expect(cargoSteps[0].step.if).toContain("matrix.shard == '1/5'");
    // A split related run executes the Windows sandbox boundary once, in its first shard.
    expect(cargoSteps[0].step.if).toContain(
      "needs.classify.outputs.windows_rust_required == 'true' && (matrix.shard == 'related' || startsWith(matrix.shard, 'related 1/'))",
    );
    const relatedStep = workflow.jobs['platform-tests'].steps.find(
      (step) => step.run === 'node ci-scope.mjs related',
    );
    expect(relatedStep.if).toBe("startsWith(matrix.shard, 'related')");
    expect(relatedStep.env.CI_RELATED_SHARD).toBe('${{ matrix.shard }}');
    // The merge checkout's first parent is recognised only against the PR head; the full
    // history it needs is already fetched for related shards.
    expect(relatedStep.env.CI_PR_HEAD).toBe('${{ github.event.pull_request.head.sha }}');
    expect(
      workflow.jobs['platform-tests'].steps.find((step) => step.name === 'Checkout').with[
        'fetch-depth'
      ],
    ).toBe("${{ startsWith(matrix.shard, 'related') && '0' || '1' }}");
    expect(
      workflow.jobs['platform-tests'].steps.find((step) => step.name.endsWith('on Windows')).if,
    ).toContain("!startsWith(matrix.shard, 'related')");
    expect(
      workflow.jobs['platform-tests'].steps.filter((step) =>
        /Linux/u.test(`${step.name} ${step.if ?? ''}`),
      ),
    ).toEqual([]);
    expect(cargoSteps[0].step.shell).toBe('pwsh');
    const rust = workflow.jobs['sandbox-rust-windows'];
    expect(rust.if).toBe(
      "needs.classify.outputs.windows_rust_required == 'true' || needs.classify.outputs.desktop_control_rust_required == 'true'",
    );
    const build = rust.steps.find((step) => step.run?.includes('cargo build --release'));
    expect(build.if).toBe("needs.classify.outputs.windows_rust_required == 'true'");
    // A PR has no test shard that builds desktop control, so the Rust job compiles it.
    const desktopControl = rust.steps.find(
      (step) => step.uses === './.github/actions/prepare-desktop-control',
    );
    expect(desktopControl.if).toBe(
      "needs.classify.outputs.desktop_control_rust_required == 'true'",
    );
    expect(workflow.jobs.classify.outputs.desktop_control_rust_required).toBe(
      '${{ steps.scope.outputs.desktop_control_rust_required }}',
    );
    expect(build.run).toContain('cargo test --no-run --locked');
    expect(build.run).toContain('if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }');
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
    for (const id of ['package-macos']) {
      const job = workflow.jobs[id];
      expect(job.needs).toBe('classify');
      expect(job.steps.some((step) => step.run === 'npx electron-forge package')).toBe(true);
      expect(job.steps.some((step) => step.env?.SPRINT_CODER_MANAGED_LOCAL_LIVE)).toBe(false);
      expect(job.steps.some((step) => step.run?.includes('build:managed-local-sidecar'))).toBe(
        false,
      );
    }
    const required = workflow.jobs.required;
    // The release call: a tag push event with full: true.
    const scope = classifyChanges([], { eventName: 'push', fullTests: true });
    const successful = Object.fromEntries(required.needs.map((id) => [id, 'success']));
    expect(() => verifyRequiredJobs(scope, successful)).not.toThrow();
    for (const dependency of ['sandbox-rust-windows', 'test-macos', 'electron-bridges']) {
      expect(required.needs).toContain(dependency);
      for (const status of ['failure', 'cancelled', 'skipped', ''])
        expect(() => verifyRequiredJobs(scope, { ...successful, [dependency]: status })).toThrow();
    }

    const macTest = workflow.jobs['test-macos'].steps.find((step) =>
      step.name.startsWith('Test desktop'),
    );
    const windowsTest = workflow.jobs['platform-tests'].steps.find((step) =>
      step.name.endsWith('on Windows'),
    );
    for (const step of [macTest, windowsTest]) {
      expect(step.run.match(/--exclude/gu)).toHaveLength(2);
      expect(step.run).toContain('src/main/team-coordinator.test.ts');
      expect(step.run).toContain('src/main/graph-mission-persistence.test.ts');
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
