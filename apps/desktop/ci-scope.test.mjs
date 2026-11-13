import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyChanges,
  parseNameStatus,
  scopeOutputs,
  verifyRequiredJobs,
} from '../../ci-scope.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const renderer = 'apps/desktop/src/renderer/';
const changes = (...paths) => paths.map((path) => ({ path, status: 'M' }));
const cleanup = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('CI change boundaries', () => {
  it.each([
    [['README.md', 'docs/maintenance.md'], 'docs', [], false],
    [['website/index.html', 'docs/maintenance.md'], 'website', [], false],
    [['website/index.html', `${renderer}components/RunCard.tsx`], 'pr', ['linux'], false],
    [[`${renderer}components/TeamUsageModeSetting.tsx`], 'pr', ['linux'], false],
    [['apps/desktop/src/main/task-title.ts'], 'pr', ['linux'], true],
    [['apps/desktop/desktop-control/crates/windows/src/lib.rs'], 'pr', ['windows'], true],
    [['apps/desktop/src/main/persistence.ts'], 'pr', ['linux', 'macos', 'windows'], true],
    [['apps/desktop/src/main/permission-broker.ts'], 'pr', ['linux', 'macos', 'windows'], true],
    [['apps/desktop/src/main/provider-egress.ts'], 'pr', ['linux', 'macos', 'windows'], true],
    [['apps/desktop/src/preload/index.ts'], 'pr', ['linux', 'macos', 'windows'], true],
    [['packages/contracts/src/index.ts'], 'pr', ['linux', 'macos', 'windows'], true],
    [
      ['apps/desktop/src/runtime-host/fixtures/grok-acp.cjs'],
      'pr',
      ['linux', 'macos', 'windows'],
      true,
    ],
    [['unclassified/new.ts'], 'pr', ['linux', 'macos', 'windows'], true],
    [[], 'pr', ['linux', 'macos', 'windows'], true],
  ])('selects bounded platform coverage for %j', (paths, mode, platforms, native) => {
    expect(classifyChanges(changes(...paths))).toMatchObject({ mode, platforms, native });
  });

  it('checks dedicated boundary suites even when native/CI changes have no static imports', () => {
    expect(classifyChanges(changes('apps/desktop/sandbox-runner/Cargo.toml'))).toMatchObject({
      windowsRust: true,
      specs: expect.arrayContaining(['src/main/sandbox-runner.test.ts']),
    });
    expect(
      classifyChanges(changes('apps/desktop/resources/sandbox-node-pipe-guard.cjs')),
    ).toMatchObject({
      platforms: expect.arrayContaining(['windows']),
      native: true,
      specs: expect.arrayContaining([
        'src/main/sandbox-node-pipe-guard.test.ts',
        'src/main/sandbox-node-pipe-guard.integration.test.ts',
      ]),
    });
    expect(classifyChanges(changes('apps/desktop/native-safe-fs/binding.gyp')).specs).toContain(
      'src/main/native-safe-fs.test.ts',
    );
    expect(
      classifyChanges(changes('apps/desktop/desktop-control/crates/windows/src/lib.rs')).specs,
    ).toContain('src/main/desktop-control.test.ts');
    expect(classifyChanges(changes('.github/workflows/ci.yml')).specs).toContain(
      'ci-cache.test.mjs',
    );
    expect(classifyChanges(changes(`${renderer}index.css`)).specs).toContain(
      'src/renderer/components/RunCard.test.tsx',
    );
  });

  it.each([
    'package-lock.json',
    '.github/workflows/release-beta.yml',
    'apps/desktop/forge.config.ts',
    'apps/desktop/installer/windows-wizard.iss',
    'apps/desktop/windows-sandbox-artifacts.ts',
    'apps/desktop/src/main/desktop-control-build.ts',
    'apps/desktop/vendor/archify/index.js',
    'docs/licenses/unicode-license.txt',
    'apps/desktop/src/main/auto-update.ts',
    'apps/desktop/scripts/ensure-inno-setup.ps1',
  ])('checks packages on both PR and main changes to %s, including deletion', (path) => {
    for (const eventName of ['pull_request', 'push']) {
      for (const status of ['A', 'M', 'D'])
        expect(classifyChanges([{ path, status }], { eventName }).distribution).toBe(true);
    }
  });

  it('keeps the full test matrix on main and manual CI, with distribution driven by the diff', () => {
    for (const eventName of ['push', 'workflow_dispatch']) {
      const scope = classifyChanges(changes('README.md'), { eventName });
      expect(scope).toMatchObject({
        mode: 'full',
        platforms: ['linux', 'macos', 'windows'],
        websiteRequired: true,
        distribution: false,
      });
      expect(JSON.parse(scopeOutputs(scope).platform_matrix).include).toHaveLength(8);
    }
    expect(classifyChanges(changes('apps/desktop/src/main/ipc.ts')).distribution).toBe(false);
  });

  it.each(['D', 'R100', 'T', 'U', '?'])('widens coverage for status %s', (status) => {
    expect(classifyChanges([{ path: 'website/index.html', status }])).toMatchObject({
      mode: 'pr',
      platforms: ['linux', 'macos', 'windows'],
      websiteRequired: true,
    });
  });

  it.each([
    null,
    [{}],
    [{ path: '../README.md', status: 'M' }],
    [{ path: 'README.md\nmode=docs', status: 'M' }],
  ])('rejects malformed changes instead of generating a narrowing output: %j', (input) =>
    expect(() => classifyChanges(input)).toThrow(),
  );
});

describe('required CI result aggregation', () => {
  it('requires a successful classification even when all other jobs are skipped', () => {
    const scope = classifyChanges(changes('README.md'));
    expect(verifyRequiredJobs(scope, { classify: 'success', quality: 'skipped' }).required).toEqual(
      ['classify'],
    );
    expect(() => verifyRequiredJobs(scope, {})).toThrow('classify: missing');
  });

  it.each(['failure', 'cancelled', 'skipped', undefined])(
    'rejects an unsuccessful required job: %s',
    (result) => {
      for (const [paths, job] of [
        [['website/index.html'], 'website'],
        [[`${renderer}components/RunCard.tsx`], 'platform-tests'],
        [['packages/contracts/src/index.ts'], 'package-tests'],
        [['apps/desktop/forge.config.ts'], 'package-windows'],
      ]) {
        const scope = classifyChanges(changes(...paths));
        expect(() => verifyRequiredJobs(scope, { classify: 'success', [job]: result })).toThrow(
          `${job}: ${result}`,
        );
      }
    },
  );

  it('rejects an unknown job and failures from jobs that were not selected', () => {
    const scope = classifyChanges(changes('README.md'));
    expect(() =>
      verifyRequiredJobs(scope, { classify: 'success', 'package-linux': 'failure' }),
    ).toThrow('package-linux: failure');
    expect(() => verifyRequiredJobs(scope, { classify: 'success', typo: 'success' })).toThrow(
      'unknown job',
    );
  });

  it.each([
    null,
    { mode: 'typo' },
    { mode: 'full', platforms: [] },
    { mode: 'pr', specs: ['../outside.test.ts'] },
  ])('rejects an absent or inconsistent scope: %j', (scope) =>
    expect(() => verifyRequiredJobs(scope, {})).toThrow('Invalid CI scope'),
  );
});

describe('GitHub classification entrypoint', () => {
  it('parses NUL-delimited names without splitting spaces or losing a deletion', () => {
    expect(parseNameStatus('M\0docs/space name.md\0D\0old.ts\0')).toEqual([
      { status: 'M', path: 'docs/space name.md' },
      { status: 'D', path: 'old.ts' },
    ]);
    expect(() => parseNameStatus('M\0truncated')).toThrow();
    expect(() => parseNameStatus('M\0')).toThrow();
  });

  // The fake git executable uses a POSIX shebang; the classifier itself runs on the Linux CI job.
  it.skipIf(process.platform === 'win32')(
    'uses the event base/head merge-base diff and writes the entire scope',
    () => {
      const directory = mkdtempSync(join(tmpdir(), 'ci-scope-'));
      cleanup.push(directory);
      const base = 'a'.repeat(40);
      const head = 'b'.repeat(40);
      const ancestor = 'c'.repeat(40);
      const event = join(directory, 'event.json');
      const output = join(directory, 'output');
      const log = join(directory, 'git-args');
      writeFileSync(
        event,
        JSON.stringify({ pull_request: { base: { sha: base }, head: { sha: head } } }),
      );
      const git = join(directory, 'git');
      writeFileSync(
        git,
        `#!${process.execPath}\nimport fs from 'node:fs';\n` +
          `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2))+'\\n');\n` +
          `process.stdout.write(process.argv[2]==='merge-base'?${JSON.stringify(`${ancestor}\n`)}:${JSON.stringify(`M\0apps/desktop/src/main/ipc.ts\0`)});\n`,
      );
      chmodSync(git, 0o700);
      const result = spawnSync(process.execPath, [join(root, 'ci-scope.mjs'), 'classify'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${directory}${delimiter}${process.env.PATH}`,
          GITHUB_EVENT_NAME: 'pull_request',
          GITHUB_EVENT_PATH: event,
          GITHUB_SHA: 'd'.repeat(40),
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: join(directory, 'summary'),
        },
      });
      expect(result.status, result.stderr).toBe(0);
      const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
      expect(calls[0]).toEqual(['merge-base', base, head]);
      expect(calls[1]).toEqual([
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--name-status',
        '-z',
        '--no-renames',
        ancestor,
        head,
        '--',
      ]);
      const entries = Object.fromEntries(
        readFileSync(output, 'utf8')
          .trim()
          .split('\n')
          .map((line) => {
            const equals = line.indexOf('=');
            return [line.slice(0, equals), line.slice(equals + 1)];
          }),
      );
      expect(entries.mode).toBe('pr');
      expect(entries.full_matrix).toBe('false');
      expect(entries.distribution_required).toBe('false');
      expect(entries.comparison_base).toBe(base);
      expect(entries.diff_base).toBe(ancestor);
      expect(JSON.parse(entries.scope_json)).toMatchObject({
        mode: 'pr',
        platforms: ['linux', 'macos', 'windows'],
        websiteRequired: false,
      });
      const summary = readFileSync(join(directory, 'summary'), 'utf8');
      expect(summary).toContain(`Tested SHA: ${'d'.repeat(40)}`);
      expect(summary).toContain(`Comparison base: ${ancestor}`);
      expect(summary).toContain(`Diff head: ${head}`);
    },
  );

  it('fails classification before output when PR metadata cannot be trusted', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ci-scope-error-'));
    cleanup.push(directory);
    const event = join(directory, 'event.json');
    const output = join(directory, 'output');
    writeFileSync(event, '{}');
    const result = spawnSync(process.execPath, [join(root, 'ci-scope.mjs'), 'classify'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_EVENT_PATH: event,
        GITHUB_OUTPUT: output,
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('base/head');
    expect(existsSync(output)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'does not turn a failed git diff into an empty docs exemption',
    () => {
      const directory = mkdtempSync(join(tmpdir(), 'ci-scope-git-failure-'));
      cleanup.push(directory);
      const event = join(directory, 'event.json');
      const output = join(directory, 'output');
      writeFileSync(
        event,
        JSON.stringify({
          pull_request: {
            base: { sha: 'a'.repeat(40) },
            head: { sha: 'b'.repeat(40) },
          },
        }),
      );
      const git = join(directory, 'git');
      writeFileSync(
        git,
        `#!${process.execPath}\n` +
          `if(process.argv[2]==='merge-base')process.stdout.write('${'c'.repeat(40)}\\n');\n` +
          `else process.exitCode=17;\n`,
      );
      chmodSync(git, 0o700);
      const result = spawnSync(process.execPath, [join(root, 'ci-scope.mjs'), 'classify'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${directory}${delimiter}${process.env.PATH}`,
          GITHUB_EVENT_NAME: 'pull_request',
          GITHUB_EVENT_PATH: event,
          GITHUB_OUTPUT: output,
        },
      });
      expect(result.status).toBe(1);
      expect(existsSync(output)).toBe(false);
    },
  );

  it('selects full tests and no installers for manual CI', () => {
    const result = spawnSync(process.execPath, [join(root, 'ci-scope.mjs'), 'classify'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_EVENT_PATH: '/nonexistent-event.json',
        GITHUB_OUTPUT: '',
        GITHUB_STEP_SUMMARY: '',
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ mode: 'full', distribution: false });
  });

  it('uses the full before-to-after push range for distribution detection', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ci-push-scope-'));
    cleanup.push(directory);
    const git = (...args) => {
      const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    const commit = (subject) => {
      git('add', 'README.md', 'package.json');
      git(
        '-c',
        'user.name=CI Test',
        '-c',
        'user.email=ci@example.invalid',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=.',
        'commit',
        '-m',
        subject,
      );
      return git('rev-parse', 'HEAD');
    };
    git('init', '-q');
    writeFileSync(join(directory, 'README.md'), 'start');
    writeFileSync(join(directory, 'package.json'), '{}');
    const before = commit('initial');
    writeFileSync(join(directory, 'package.json'), '{"version":"1.0.0"}');
    const packaged = commit('packaging');
    writeFileSync(join(directory, 'README.md'), 'docs only');
    const after = commit('documentation');
    const event = join(directory, 'event.json');
    for (const [base, distribution] of [
      [before, true],
      [packaged, false],
      ['0'.repeat(40), true],
    ]) {
      writeFileSync(event, JSON.stringify({ before: base, after }));
      const result = spawnSync(process.execPath, [join(root, 'ci-scope.mjs'), 'classify'], {
        cwd: directory,
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: 'push',
          GITHUB_EVENT_PATH: event,
          GITHUB_OUTPUT: '',
          GITHUB_STEP_SUMMARY: '',
        },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ mode: 'full', distribution });
    }
  });

  it('normalizes GitHub needs objects and rejects a skipped classification in the CLI gate', () => {
    const scope = classifyChanges(changes('README.md'));
    for (const classification of ['success', 'skipped']) {
      const result = spawnSync(process.execPath, [join(root, 'ci-scope.mjs'), 'gate'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          CI_SCOPE_JSON: JSON.stringify(scope),
          CI_JOB_RESULTS_JSON: JSON.stringify({
            classify: { result: classification, outputs: { mode: 'docs' } },
            quality: { result: 'skipped', outputs: {} },
          }),
        },
      });
      expect(result.status, result.stderr).toBe(classification === 'success' ? 0 : 1);
    }
  });
});
