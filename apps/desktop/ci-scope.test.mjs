import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyChanges, parseNameStatus, verifyRequiredJobs } from '../../ci-scope.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const renderer = 'apps/desktop/src/renderer/';
const changes = (...paths) => paths.map((path) => ({ path, status: 'M' }));
const cleanup = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('CI change boundaries', () => {
  it('checks standalone website changes without desktop jobs and retains checks on wider diffs', () => {
    for (const paths of [['website/index.html'], ['website/film.js', 'tasks/todo.md']])
      expect(classifyChanges(changes(...paths))).toMatchObject({
        mode: 'website',
        fullMatrix: false,
        websiteRequired: true,
      });
    for (const extra of ['package-lock.json', `${renderer}components/RunCard.tsx`, 'unknown']) {
      const scope = classifyChanges(changes('website/index.html', extra));
      expect(scope).toMatchObject({ mode: 'full', websiteRequired: true });
    }
    for (const path of [
      'deploy/website/deploy.sh',
      'ci-website.mjs',
      'apps/desktop/ci-website.test.mjs',
      'ci-scope.mjs',
      '.github/workflows/ci.yml',
      'package-lock.json',
    ])
      expect(classifyChanges(changes(path))).toMatchObject({ mode: 'full', websiteRequired: true });
    for (const status of ['D', 'R100', 'T'])
      expect(classifyChanges([{ path: 'website/index.html', status }])).toMatchObject({
        mode: 'full',
        websiteRequired: true,
      });
    for (const eventName of ['push', 'workflow_dispatch'])
      expect(classifyChanges([], { eventName })).toMatchObject({
        mode: 'full',
        websiteRequired: true,
      });
    expect(classifyChanges(changes('README.md')).websiteRequired).toBe(false);
    expect(classifyChanges([]).websiteRequired).toBe(true);
  });

  it('narrows only prose paths, with additions handled like modifications', () => {
    const scope = classifyChanges([
      { path: 'README.md', status: 'M' },
      { path: 'docs/maintenance.md', status: 'A' },
      { path: 'tasks/ci-plan.md', status: 'M' },
    ]);
    expect(scope).toMatchObject({ mode: 'docs', fullMatrix: false });
  });

  it.each([
    'docs/prompts/worker.md',
    'docs/runtime-prompt.md',
    'docs/runtime_prompt.md',
    'docs/fixtures/input.md',
    'docs/resources/template.md',
    'docs/spec.json',
    '.github/workflows/ci.yml',
    'package-lock.json',
    'apps/desktop/src/preload/index.ts',
    'apps/desktop/src/main/ipc.ts',
    'apps/desktop/src/runtime-host/fixtures/grok-acp.cjs',
    'packages/contracts/src/index.ts',
    'packages/domain/src/team-execution.ts',
    `${renderer}App.tsx`,
    `${renderer}main.tsx`,
    `${renderer}types/sprint-coder.ts`,
    `${renderer}store/appStore.ts`,
    `${renderer}lib/new-helper.ts`,
    `${renderer}lib/effective-workspace-root.ts`,
    `${renderer}hooks/useComputerUse.tsx`,
    `${renderer}components/ProviderSettingsSection.tsx`,
    `${renderer}components/FileEditorDialog.tsx`,
    `${renderer}components/fixtures/example.ts`,
    `${renderer}components/TeamRetainedWorktrees.tsx`,
    `${renderer}components/Sidebar.tsx`,
    `${renderer}components/TeamCanvas/TeamCanvas.tsx`,
    `${renderer}components/NewUnknownComponent.tsx`,
    `${renderer}components/NewUnknownComponent.test.tsx`,
  ])('keeps unknown or integration-sensitive path %s on the full matrix', (path) => {
    expect(classifyChanges(changes(path))).toMatchObject({ mode: 'full', fullMatrix: true });
  });

  it.each(['D', 'R100', 'R', 'C100', 'T', 'U', '?'])('does not narrow status %s', (status) => {
    expect(classifyChanges([{ path: 'docs/readme.md', status }]).mode).toBe('full');
  });

  it.each(['push', 'workflow_dispatch', 'pull_request_target', 'schedule', 'unknown'])(
    'retains full validation for event %s',
    (eventName) => {
      expect(classifyChanges(changes('README.md'), { eventName }).mode).toBe('full');
    },
  );

  it('keeps empty and mixed unknown diffs conservative', () => {
    expect(classifyChanges([]).mode).toBe('full');
    expect(classifyChanges(changes('docs/ci.md', `${renderer}components/RunCard.tsx`)).mode).toBe(
      'renderer',
    );
    expect(
      classifyChanges(
        changes('docs/ci.md', `${renderer}components/RunCard.tsx`, 'unclassified/new.ts'),
      ).mode,
    ).toBe('full');
  });

  it('keeps reviewed display libraries, components, CSS, and their tests on renderer CI', () => {
    for (const path of [
      `${renderer}lib/format.ts`,
      `${renderer}lib/worker-thread.ts`,
      `${renderer}lib/sidebar-preference.ts`,
      `${renderer}components/RunCard.tsx`,
      `${renderer}components/RunCard.test.tsx`,
      `${renderer}index.css`,
    ])
      expect(classifyChanges(changes(path))).toMatchObject({
        mode: 'renderer',
        fullMatrix: false,
      });
  });

  it('keeps control components outside the initial reviewed display allowlist', () => {
    for (const path of [
      `${renderer}components/ChatSurface/Composer.tsx`,
      `${renderer}components/TeamCanvas/WorkerNode.tsx`,
    ])
      expect(classifyChanges(changes(path))).toMatchObject({ mode: 'full' });
  });

  it('narrows the PR 896 RunCard, global CSS, and elapsed-format display change', () => {
    expect(
      classifyChanges(
        changes(
          `${renderer}components/RunCard.tsx`,
          `${renderer}index.css`,
          `${renderer}lib/format.ts`,
        ),
      ),
    ).toMatchObject({ mode: 'renderer', fullMatrix: false });
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
  const allJobs = [
    'classify',
    'quality',
    'package-tests',
    'computer-use-native-gate',
    'computer-use-windows-v2-harness',
    'test-macos',
    'platform-tests',
    'electron-bridges',
    'package-linux',
    'package-windows-build',
    'package-windows',
    'package-macos',
    'renderer-tests',
    'website',
  ];
  const results = (value) => Object.fromEntries(allJobs.map((job) => [job, value]));

  it('requires website success for both standalone and mixed changes', () => {
    for (const paths of [['website/index.html'], ['website/index.html', 'package.json']]) {
      const scope = classifyChanges(changes(...paths));
      expect(verifyRequiredJobs(scope, results('success')).required).toContain('website');
      for (const value of ['failure', 'cancelled', 'skipped', undefined])
        expect(() =>
          verifyRequiredJobs(scope, { ...results('success'), website: value }),
        ).toThrow();
    }
  });

  it('does not accept a missing or unsuccessful Windows package producer', () => {
    const scope = classifyChanges(changes('apps/desktop/src/main/ipc.ts'));
    for (const value of ['failure', 'cancelled', 'skipped', undefined])
      expect(() =>
        verifyRequiredJobs(scope, { ...results('success'), 'package-windows-build': value }),
      ).toThrow('package-windows-build');
  });

  it('accepts docs only when classification itself succeeded', () => {
    const scope = classifyChanges(changes('README.md'));
    expect(
      verifyRequiredJobs(scope, { ...results('skipped'), classify: 'success' }).required,
    ).toEqual(['classify']);
    expect(() => verifyRequiredJobs(scope, {})).toThrow('classify: missing');
  });

  it('requires every full-matrix job, including the renderer runner contracts', () => {
    const scope = classifyChanges(changes('apps/desktop/src/main/ipc.ts'));
    for (const job of allJobs.filter((name) => name !== 'website')) {
      const missing = results('success');
      delete missing[job];
      expect(() => verifyRequiredJobs(scope, missing), job).toThrow(`${job}: missing`);
    }
  });

  it.each(['failure', 'cancelled', 'skipped', '', 'neutral'])(
    'rejects a required renderer result %s',
    (result) => {
      const scope = classifyChanges(changes(`${renderer}lib/format.ts`));
      expect(() =>
        verifyRequiredJobs(scope, { ...results('success'), 'renderer-tests': result }),
      ).toThrow();
    },
  );

  it('allows successful extra jobs, but rejects unexpected failures and unknown IDs', () => {
    const scope = classifyChanges(changes('README.md'));
    expect(() => verifyRequiredJobs(scope, results('success'))).not.toThrow();
    expect(() =>
      verifyRequiredJobs(scope, { ...results('success'), 'package-linux': 'failure' }),
    ).toThrow();
    expect(() => verifyRequiredJobs(scope, { classify: 'success', typo: 'success' })).toThrow(
      'unknown job',
    );
  });

  it.each([
    null,
    { mode: 'typo', fullMatrix: false, reason: '' },
    { mode: 'full', fullMatrix: false, reason: '' },
    { mode: 'docs', fullMatrix: false, websiteRequired: true, reason: '' },
    { mode: 'renderer', fullMatrix: false, websiteRequired: true, reason: '' },
    { mode: 'website', fullMatrix: false, websiteRequired: false, reason: '' },
    { mode: 'full', fullMatrix: true, websiteRequired: true, reason: null },
  ])('rejects an absent or inconsistent scope: %j', (scope) => {
    expect(() => verifyRequiredJobs(scope, results('success'))).toThrow('Invalid CI scope');
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
      expect(entries.mode).toBe('full');
      expect(JSON.parse(entries.scope_json)).toMatchObject({
        mode: 'full',
        fullMatrix: true,
        websiteRequired: false,
      });
      expect(Object.keys(entries).sort()).toEqual([
        'full_matrix',
        'mode',
        'reason',
        'scope_json',
        'website_required',
      ]);
      const summary = readFileSync(join(directory, 'summary'), 'utf8');
      expect(summary).toContain(`Tested SHA: ${'d'.repeat(40)}`);
      expect(summary).toContain(`PR base: ${base}`);
      expect(summary).toContain(`PR head: ${head}`);
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

  it.each(['push', 'workflow_dispatch'])(
    'runs full without consulting PR metadata for %s',
    (eventName) => {
      const result = spawnSync(process.execPath, [join(root, 'ci-scope.mjs'), 'classify'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: eventName,
          GITHUB_EVENT_PATH: '/nonexistent-event.json',
          GITHUB_OUTPUT: '',
          GITHUB_STEP_SUMMARY: '',
        },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ mode: 'full', fullMatrix: true });
    },
  );

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
