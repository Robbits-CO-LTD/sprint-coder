import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyChanges,
  parseNameStatus,
  parseRelatedShard,
  relatedChangedBase,
  relatedTestRuns,
  scopeOutputs,
  verifyRequiredJobs,
} from '../../ci-scope.mjs';
import { partitionWindowsTests } from './vitest.config';

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
    'docs/licenses/geist-ofl.txt',
    'docs/licenses/ibm-plex-sans-jp-ofl.txt',
    'docs/licenses/plemoljp-ofl.txt',
    'apps/desktop/assets/fonts/IBMPlexSansJP-Regular.woff2',
    'apps/desktop/assets/fonts/SOURCES.txt',
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

  it.each([
    [['apps/desktop/src/main/ipc.ts', 'apps/desktop/src/main/persistence.ts'], true],
    [['apps/desktop/package.json', 'package-lock.json'], true],
    [['packages/contracts/src/index.ts'], true],
    [['apps/desktop/vitest.config.ts'], true],
    [['.github/workflows/ci.yml', 'apps/desktop/src/main/team-coordinator.ts'], true],
    [['unclassified/new.ts'], true],
    [['.github/workflows/ci.yml', 'ci-scope.mjs', 'apps/desktop/ci-scope.test.mjs'], false],
    [['apps/desktop/sandbox-runner/Cargo.toml'], false],
    [['apps/desktop/desktop-control/crates/windows/src/lib.rs'], false],
    [[`${renderer}components/RunCard.tsx`], false],
    [['apps/desktop/src/main/task-title.ts'], false],
    [['website/index.html'], false],
    [[], false],
  ])('splits the Windows related run only for wide selections: %j', (paths, split) => {
    const scope = classifyChanges(changes(...paths));
    expect(scope.splitRelated).toBe(split);
    const rows = JSON.parse(scopeOutputs(scope).platform_matrix).include;
    const windows = rows.filter((row) => row.label === 'Windows').map((row) => row.shard);
    if (split)
      expect(windows).toEqual(['related 1/4', 'related 2/4', 'related 3/4', 'related 4/4']);
    else expect(windows.every((shard) => shard === 'related')).toBe(true);
    // Linux and macOS keep one related job; narrow PRs keep their previous job count.
    for (const label of ['Linux', 'macOS'])
      expect(rows.filter((row) => row.label === label).map((row) => row.shard)).toEqual(
        scope.platforms.includes(label.toLowerCase()) ? ['related'] : [],
      );
    if (!split) expect(rows).toHaveLength(scope.platforms.length);
  });

  it('never splits related runs outside pull requests', () => {
    for (const eventName of ['push', 'workflow_dispatch'])
      expect(classifyChanges(changes('apps/desktop/src/main/ipc.ts'), { eventName })).toMatchObject(
        { mode: 'full', splitRelated: false },
      );
    const scope = classifyChanges(changes('README.md'));
    expect(() => scopeOutputs({ ...scope, splitRelated: true })).toThrow('Invalid CI scope');
    expect(() => scopeOutputs({ ...scope, splitRelated: undefined })).toThrow('Invalid CI scope');
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

  it.each(['failure', 'cancelled', 'skipped', undefined])(
    'rejects a split Windows related run when its matrix result is %s',
    (result) => {
      const scope = classifyChanges(changes('apps/desktop/src/main/ipc.ts'));
      expect(scope.splitRelated).toBe(true);
      const results = { classify: 'success', quality: 'success', 'platform-tests': 'success' };
      expect(() => verifyRequiredJobs(scope, results)).not.toThrow();
      const broken = { ...results, 'platform-tests': result };
      if (result === undefined) delete broken['platform-tests'];
      expect(() => verifyRequiredJobs(scope, broken)).toThrow(
        `platform-tests: ${result ?? 'missing'}`,
      );
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

describe('related test shards', () => {
  const coordinator = 'src/main/team-coordinator.test.ts';
  const graph = 'src/main/graph-mission-persistence.test.ts';
  const files = [
    'src/main/persistence.test.ts',
    coordinator,
    ...Array.from({ length: 230 }, (_, i) => `src/main/case-${String(i).padStart(3, '0')}.test.ts`),
    graph,
    'src/main/worker-worktree.test.ts',
  ];
  const runFiles = (run) =>
    run.args.filter((arg, i) => arg.endsWith('.test.ts') && run.args[i - 1] !== '--exclude');

  it('keeps the single related job unchanged: input order, batches of 100, all bridge groups', () => {
    const runs = relatedTestRuns(files, 'related');
    expect(runs.map((run) => run.args.slice(0, 2))).toEqual(
      Array.from({ length: 3 }, () => ['run', '--allowOnly=false']),
    );
    expect(runs.flatMap((run) => run.args.slice(2))).toEqual(files);
    expect(runs.every((run) => Object.keys(run.env).length === 0)).toBe(true);
  });

  it('runs every selected file and every Electron bridge group exactly once across shards', () => {
    const root = resolve('/ci/desktop');
    const executed = [];
    const groups = [];
    for (let index = 1; index <= 4; index++) {
      const runs = relatedTestRuns([...files].reverse(), `related ${index}/4`);
      // Batches must not depend on discovery order, or a file could fall between shards.
      expect(runs).toEqual(relatedTestRuns(files, `related ${index}/4`));
      for (const run of runs) {
        const selected = runFiles(run);
        expect(selected.length).toBeLessThanOrEqual(100);
        if (run.env.SPRINT_CODER_ELECTRON_BRIDGE_SHARD !== undefined) {
          expect(run.args).toEqual(['run', '--allowOnly=false', selected[0]]);
          groups.push(`${selected[0]}:${run.env.SPRINT_CODER_ELECTRON_BRIDGE_SHARD}`);
          continue;
        }
        expect(run.args).toEqual(
          expect.arrayContaining([
            `--shard=${index}/4`,
            '--passWithNoTests',
            '--exclude',
            coordinator,
            graph,
          ]),
        );
        expect(selected).not.toContain(coordinator);
        expect(selected).not.toContain(graph);
        // The Windows CI sequencer is what Vitest applies to each batch for --shard.
        const partition = partitionWindowsTests(
          selected.map((file) => ({ moduleId: resolve(root, file) })),
          root,
          4,
        );
        executed.push(
          ...partition[index - 1].map((spec) =>
            relative(root, spec.moduleId).replaceAll('\\', '/'),
          ),
        );
      }
    }
    expect(executed.sort()).toEqual(
      files.filter((file) => file !== coordinator && file !== graph).sort(),
    );
    expect(groups.sort()).toEqual(
      [coordinator, graph].flatMap((file) => [0, 1, 2, 3].map((g) => `${file}:${g}`)).sort(),
    );
  });

  it('gives each of four Windows shards one group of each bridge suite', () => {
    for (let index = 1; index <= 4; index++)
      expect(
        relatedTestRuns([coordinator, graph], `related ${index}/4`).map(
          (run) => run.env.SPRINT_CODER_ELECTRON_BRIDGE_SHARD,
        ),
      ).toEqual([String(index - 1), String(index - 1)]);
  });

  it.each([
    'related 0/4',
    'related 5/4',
    'related 1/0',
    'related1/4',
    'related 1/4 ',
    'related 1/4;id',
    '1/5',
    '',
    undefined,
  ])('rejects the malformed shard %j', (shard) => {
    expect(() => parseRelatedShard(shard)).toThrow('Invalid related test shard');
    expect(() => relatedTestRuns(files, shard)).toThrow('Invalid related test shard');
  });

  it('rejects unsafe or duplicated related files', () => {
    for (const input of [['../outside.test.ts'], ['a.test.ts', 'a.test.ts'], [null]])
      expect(() => relatedTestRuns(input, 'related 1/4')).toThrow('Invalid related test files');
  });
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

describe('related test comparison base', () => {
  // Mirrors GitHub: the PR opens on `opened`, the base branch then advances, and the
  // pull_request checkout is a merge of the PR head into the current base tip.
  const repository = () => {
    const directory = mkdtempSync(join(tmpdir(), 'ci-related-base-'));
    cleanup.push(directory);
    const git = (...args) => {
      const result = spawnSync(
        'git',
        [
          '-c',
          'user.name=CI Test',
          '-c',
          'user.email=ci@example.invalid',
          '-c',
          'commit.gpgsign=false',
          '-c',
          'core.hooksPath=.',
          ...args,
        ],
        { cwd: directory, encoding: 'utf8' },
      );
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    const commit = (path, content) => {
      writeFileSync(join(directory, path), content);
      git('add', '-A');
      git('commit', '-q', '-m', `change ${path}`);
      return git('rev-parse', 'HEAD');
    };
    git('init', '-q', '-b', 'main');
    writeFileSync(join(directory, 'b.ts'), 'base');
    const opened = commit('a.ts', 'base');
    git('checkout', '-q', '-b', 'pr');
    const head = commit('a.ts', 'pr change');
    git('checkout', '-q', 'main');
    const current = commit('b.ts', 'merged by another PR');
    git('checkout', '-q', '--detach', current);
    git('merge', '-q', '--no-ff', '-m', `Merge ${head} into ${current}`, head);
    const merge = git('rev-parse', 'HEAD');
    // vitest --changed <base> lists `git diff --name-only <base>...HEAD`.
    const changed = (base) => git('diff', '--name-only', `${base}...HEAD`).split('\n').sort();
    return { directory, git, opened, head, current, merge, changed };
  };

  it('compares the merge checkout with its current base, matching the classified PR diff', () => {
    const { directory, git, opened, head, current, changed } = repository();
    // The PR-open base also selects what the base branch gained since: the CI overrun in #1247.
    expect(changed(opened)).toEqual(['a.ts', 'b.ts']);
    const selected = relatedChangedBase({ comparisonBase: opened, prHead: head, cwd: directory });
    expect(selected).toMatchObject({ base: current, fallback: false });
    expect(changed(selected.base)).toEqual(['a.ts']);

    const event = join(directory, 'event.json');
    const output = join(directory, 'output');
    writeFileSync(
      event,
      JSON.stringify({ pull_request: { base: { sha: opened }, head: { sha: head } } }),
    );
    const result = spawnSync(process.execPath, [join(root, 'ci-scope.mjs'), 'classify'], {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_EVENT_PATH: event,
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: '',
      },
    });
    expect(result.status, result.stderr).toBe(0);
    const outputs = Object.fromEntries(
      readFileSync(output, 'utf8')
        .trim()
        .split('\n')
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
    expect(outputs.comparison_base).toBe(opened);
    const classified = git('diff', '--name-only', outputs.diff_base, head).split('\n').sort();
    expect(changed(selected.base)).toEqual(classified);
  });

  it('keeps the PR base for a checkout of the PR head, which already diffs from the fork point', () => {
    const { directory, git, opened, head, changed } = repository();
    git('checkout', '-q', '--detach', head);
    const selected = relatedChangedBase({ comparisonBase: opened, prHead: head, cwd: directory });
    expect(selected).toMatchObject({ base: opened, fallback: false });
    expect(changed(selected.base)).toEqual(['a.ts']);
  });

  it('falls back to the PR base, selecting more tests, whenever the checkout is not recognised', () => {
    const { directory, git, opened, head, current, merge, changed } = repository();
    const fallsBack = (prHead) => {
      const selected = relatedChangedBase({ comparisonBase: opened, prHead, cwd: directory });
      expect(selected).toMatchObject({ base: opened, fallback: true });
      expect(changed(selected.base)).toEqual(expect.arrayContaining(['a.ts']));
    };
    fallsBack('');
    // The merge does not have this PR head as its second parent.
    fallsBack(current);
    // Parents in the other order: the first parent is the PR head, not the base branch.
    git(
      'checkout',
      '-q',
      '--detach',
      git('commit-tree', `${merge}^{tree}`, '-p', head, '-p', current, '-m', 'reversed'),
    );
    fallsBack(head);
    // A first parent that does not contain the PR base is not the PR's base branch.
    const unrelated = git('commit-tree', `${merge}^{tree}`, '-m', 'unrelated root');
    git(
      'checkout',
      '-q',
      '--detach',
      git('commit-tree', `${merge}^{tree}`, '-p', unrelated, '-p', head, '-m', 'unrelated'),
    );
    fallsBack(head);
  });

  it('rejects malformed PR SHAs instead of guessing a base', () => {
    expect(() => relatedChangedBase({ comparisonBase: '' })).toThrow('valid PR base SHA');
    expect(() =>
      relatedChangedBase({ comparisonBase: 'a'.repeat(40), prHead: 'refs/pull/1/head' }),
    ).toThrow('Invalid PR head SHA');
  });
});
