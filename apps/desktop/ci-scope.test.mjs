import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyChanges,
  focusedE2eMatrix,
  parseNameStatus,
  verifyRequiredJobs,
} from '../../ci-scope.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const renderer = 'apps/desktop/src/renderer/';
const spec = (name) => `tests/e2e/${name}.spec.ts`;
const changes = (...paths) => paths.map((path) => ({ path, status: 'M' }));
const cleanup = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('CI change boundaries', () => {
  it('narrows only prose paths, with additions handled like modifications', () => {
    const scope = classifyChanges([
      { path: 'README.md', status: 'M' },
      { path: 'docs/maintenance.md', status: 'A' },
      { path: 'tasks/ci-plan.md', status: 'M' },
    ]);
    expect(scope).toMatchObject({ mode: 'docs', fullMatrix: false, e2eSpecs: [] });
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

  it('maps the reviewed small display libraries to the renderer path', () => {
    expect(classifyChanges(changes(`${renderer}lib/format.ts`)).mode).toBe('renderer');
    expect(classifyChanges(changes(`${renderer}lib/worker-thread.ts`)).e2eSpecs).toContain(
      spec('team-activity-history'),
    );
  });

  it('uses unit tests without E2E for pure display libraries and renderer-test-only diffs', () => {
    for (const paths of [
      [`${renderer}lib/format.ts`, `${renderer}lib/stages.ts`, `${renderer}lib/turn-progress.ts`],
      [`${renderer}components/RunCard.test.tsx`, `${renderer}lib/worker-thread.test.ts`],
    ]) {
      expect(classifyChanges(changes(...paths))).toMatchObject({ mode: 'renderer', e2eSpecs: [] });
    }
    expect(classifyChanges(changes(`${renderer}lib/sidebar-preference.ts`)).e2eSpecs).toContain(
      spec('sidebar-collapse'),
    );
  });

  it('keeps reviewed RunCard display changes on renderer CI with cancel coverage', () => {
    const scope = classifyChanges(changes(`${renderer}components/RunCard.tsx`));
    expect(scope.mode).toBe('renderer');
    expect(scope.e2eSpecs).toEqual(
      expect.arrayContaining([spec('keyboard-smoke'), spec('golden-path-2-cancel')]),
    );
  });

  it('maps global CSS to input, sidebar, and Team interaction coverage', () => {
    expect(classifyChanges(changes(`${renderer}index.css`)).e2eSpecs).toEqual(
      [
        spec('keyboard-smoke'),
        spec('composer-input-boundaries'),
        spec('sidebar-collapse'),
        spec('team-flow'),
      ].sort(),
    );
  });

  it('keeps control components outside the initial reviewed display allowlist', () => {
    for (const path of [
      `${renderer}components/ChatSurface/Composer.tsx`,
      `${renderer}components/TeamCanvas/WorkerNode.tsx`,
    ])
      expect(classifyChanges(changes(path))).toMatchObject({ mode: 'full', e2eSpecs: [] });
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

  it('executes changed free specs even on a full or E2E-only diff (PR 897/898 shape)', () => {
    for (const paths of [
      [spec('golden-path-3-queue')],
      ['apps/desktop/src/main/team-coordinator.ts', spec('team-task-switch')],
      ['apps/desktop/src/main/ipc.ts', spec('new-same-task-regression')],
    ]) {
      const scope = classifyChanges(changes(...paths));
      expect(scope.mode).toBe('full');
      expect(scope.e2eSpecs).toContain(paths.at(-1));
    }
  });

  it('keeps display coverage when another changed path widens the scope to full', () => {
    const display = `${renderer}components/RunCard.tsx`;
    const narrow = classifyChanges(changes(display));
    for (const extra of ['package.json', 'apps/desktop/src/main/ipc.ts']) {
      const wide = classifyChanges(changes(display, extra));
      expect(wide.mode).toBe('full');
      expect(wide.e2eSpecs).toEqual(narrow.e2eSpecs);
    }
    const mixed = classifyChanges(changes(display, 'package.json', spec('sidebar-collapse')));
    expect(new Set(mixed.e2eSpecs)).toEqual(
      new Set([...narrow.e2eSpecs, spec('sidebar-collapse')]),
    );
  });

  it('retains explicitly changed specs for integration-sensitive UI paths', () => {
    const scope = classifyChanges(
      changes(
        `${renderer}components/Sidebar.tsx`,
        spec('sidebar-collapse'),
        spec('sidebar-collapse'),
      ),
    );
    expect(scope.mode).toBe('full');
    expect(scope.e2eSpecs).toEqual([spec('sidebar-collapse')]);
    expect(
      classifyChanges(changes(`${renderer}components/Sidebar.tsx`, 'apps/desktop/src/main/ipc.ts'))
        .e2eSpecs,
    ).toEqual([]);
  });

  it.each([
    'real-ai-workspace',
    'real-ai-team-scale',
    'cli-workspace-egress',
    'leader-mcp-smoke',
    'leader-mcp-codex-smoke',
  ])('does not activate opt-in real-provider spec %s', (name) => {
    expect(classifyChanges(changes(spec(name)))).toMatchObject({ mode: 'full', e2eSpecs: [] });
  });

  it('does not attempt to execute a deleted spec', () => {
    expect(classifyChanges([{ path: spec('sidebar-collapse'), status: 'D' }])).toMatchObject({
      mode: 'full',
      e2eSpecs: [],
    });
  });

  it('routes macOS-only changed coverage onto a macOS runner', () => {
    const scope = classifyChanges(
      changes(spec('macos-window-lifecycle'), spec('team-task-switch')),
    );
    expect(focusedE2eMatrix(scope.e2eSpecs)).toEqual({
      include: [
        { os: 'ubuntu-latest', specs: [spec('team-task-switch')] },
        { os: 'macos-latest', specs: [spec('macos-window-lifecycle')] },
      ],
    });
    expect(focusedE2eMatrix([])).toEqual({ include: [] });
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
    'package-windows',
    'e2e-windows',
    'archify-packaged',
    'package-macos',
    'renderer-tests',
    'renderer-e2e',
  ];
  const results = (value) => Object.fromEntries(allJobs.map((job) => [job, value]));

  it('requires focused display checks when a mixed change also requires the full scope', () => {
    const scope = classifyChanges(changes(`${renderer}components/RunCard.tsx`, 'package.json'));
    expect(() =>
      verifyRequiredJobs(scope, { ...results('success'), 'renderer-e2e': 'skipped' }),
    ).toThrow('renderer-e2e: skipped');
  });

  it('accepts docs only when classification itself succeeded', () => {
    const scope = classifyChanges(changes('README.md'));
    expect(
      verifyRequiredJobs(scope, { ...results('skipped'), classify: 'success' }).required,
    ).toEqual(['classify']);
    expect(() => verifyRequiredJobs(scope, {})).toThrow('classify: missing');
  });

  it('requires focused E2E for renderer and full diffs whenever specs were selected', () => {
    for (const scope of [
      classifyChanges(changes(`${renderer}components/RunCard.tsx`)),
      classifyChanges(changes(spec('team-task-switch'))),
    ]) {
      expect(() =>
        verifyRequiredJobs(scope, { ...results('success'), 'renderer-e2e': 'skipped' }),
      ).toThrow('renderer-e2e: skipped');
    }
  });

  it('requires every full-matrix job, including the renderer runner contracts', () => {
    const scope = classifyChanges(changes('apps/desktop/src/main/ipc.ts'));
    expect(verifyRequiredJobs(scope, results('success')).required).not.toContain('renderer-e2e');
    for (const job of allJobs.filter((name) => name !== 'renderer-e2e')) {
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
    { mode: 'typo', fullMatrix: false, e2eSpecs: [], reason: '' },
    { mode: 'full', fullMatrix: false, e2eSpecs: [], reason: '' },
    { mode: 'docs', fullMatrix: false, e2eSpecs: [spec('team-flow')], reason: '' },
    { mode: 'full', fullMatrix: true, e2eSpecs: [spec('real-ai-workspace')], reason: '' },
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
    'uses the event base/head merge-base diff and writes the entire scope and E2E matrix',
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
          `process.stdout.write(process.argv[2]==='merge-base'?${JSON.stringify(`${ancestor}\n`)}:${JSON.stringify(`M\0${spec('macos-window-lifecycle')}\0`)});\n`,
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
      expect(JSON.parse(entries.scope_json).e2eSpecs).toEqual([spec('macos-window-lifecycle')]);
      expect(JSON.parse(entries.e2e_matrix)).toEqual({
        include: [{ os: 'macos-latest', specs: [spec('macos-window-lifecycle')] }],
      });
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
