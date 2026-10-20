import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** @typedef {{path: string, status: string}} Change Git name-status entries; only A/M may be narrowed. */
/** @typedef {{mode: 'docs' | 'renderer' | 'full', fullMatrix: boolean, e2eSpecs: string[], reason: string}} Scope */

const RENDERER = 'apps/desktop/src/renderer/';
const E2E = 'tests/e2e/';
const KEYBOARD = `${E2E}keyboard-smoke.spec.ts`;
const DISPLAY_LIBS = new Set([
  'format',
  'stages',
  'turn-progress',
  'sidebar-preference',
  'worker-thread',
]);
// These components present state or call their owner's callbacks; they do not issue IPC commands.
// Adding a component requires reviewing its effects before widening this initial fast path.
const DISPLAY_COMPONENTS = new Set([
  'RunCard.tsx',
  'icons.tsx',
  'SidebarResizer.tsx',
  'WorkStep.tsx',
]);
const FULL_JOBS = [
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
];
const KNOWN_JOBS = new Set(['classify', ...FULL_JOBS, 'renderer-e2e']);
const OPT_IN_SPECS = new Set([
  'cli-workspace-egress.spec.ts',
  'leader-mcp-smoke.spec.ts',
  'leader-mcp-codex-smoke.spec.ts',
]);

function safePath(path) {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    !/[\\\u0000-\u001f\u007f]/u.test(path) &&
    !path.startsWith('/') &&
    !path.split('/').some((part) => part === '' || part === '.' || part === '..')
  );
}

function optInSpec(path) {
  const name = path.slice(E2E.length);
  return name.startsWith('real-ai-') || OPT_IN_SPECS.has(name);
}

function isSpec(path) {
  return safePath(path) && path.startsWith(E2E) && path.endsWith('.spec.ts');
}

function docsPath(path) {
  // Runtime inputs and fixtures must not inherit an exemption just because they contain Markdown.
  if (/(?:fixture|resource|prompt|template)/iu.test(path)) return false;
  return (
    /^(?:README|CONTRIBUTING|CHANGELOG|AGENTS|SECURITY|CODE_OF_CONDUCT)\.md$/u.test(path) ||
    /^(?:docs|tasks)\/.+\.md$/u.test(path)
  );
}

function rendererPath(path) {
  if (path === `${RENDERER}index.css`) return true;
  if (!path.startsWith(RENDERER)) return false;
  const local = path.slice(RENDERER.length);
  if (local.startsWith('lib/')) {
    const match = /^lib\/([a-z-]+)(?:\.test)?\.ts$/u.exec(local);
    return match !== null && DISPLAY_LIBS.has(match[1]);
  }
  if (!local.startsWith('components/')) return false;
  const component = local.slice('components/'.length);
  if (DISPLAY_COMPONENTS.has(component)) return true;
  const test = /^([A-Za-z0-9_-]+)(?:\.[A-Za-z0-9_-]+)*\.test\.tsx?$/u.exec(component);
  return test !== null && DISPLAY_COMPONENTS.has(`${test[1]}.tsx`);
}

function displaySpecs(path) {
  if (/\.test\.tsx?$/u.test(path)) return new Set();
  if (path.startsWith(`${RENDERER}lib/`) && !/sidebar-preference|worker-thread/u.test(path))
    return new Set();
  const specs = new Set([KEYBOARD]);
  if (path === `${RENDERER}index.css`) {
    for (const name of ['sidebar-collapse', 'composer-input-boundaries', 'team-flow'])
      specs.add(`${E2E}${name}.spec.ts`);
  }
  if (/Sidebar|ProjectPicker|sidebar-preference/u.test(path)) {
    specs.add(`${E2E}sidebar-collapse.spec.ts`);
    specs.add(`${E2E}project-sidebar.spec.ts`);
  }
  if (/Composer|SlashCommand|skill-picker|slash-commands/u.test(path)) {
    for (const name of [
      'composer-input-boundaries',
      'composer-plus-menu',
      'composer-slash-commands',
    ])
      specs.add(`${E2E}${name}.spec.ts`);
  }
  if (
    /Timeline|MessageBubble|Markdown|Reasoning|RunCard|TurnDiff|WorkStep|worker-thread/u.test(path)
  ) {
    specs.add(`${E2E}timeline-scroll-follow.spec.ts`);
    specs.add(`${E2E}golden-path-2-cancel.spec.ts`);
  }
  if (/Team|Worker|worker-thread/u.test(path)) {
    for (const name of ['team-flow', 'team-task-switch', 'team-activity-history'])
      specs.add(`${E2E}${name}.spec.ts`);
  }
  if (/Graph|Mermaid/u.test(path)) {
    specs.add(`${E2E}archify-graph.spec.ts`);
    specs.add(`${E2E}graph-view-preference.spec.ts`);
  }
  if (/Approval/u.test(path)) specs.add(`${E2E}approval-flow.spec.ts`);
  if (/AppTitlebar/u.test(path)) specs.add(`${E2E}window-titlebar.spec.ts`);
  if (/Setup/u.test(path)) specs.add(`${E2E}setup-wizard.spec.ts`);
  if (/SurfaceFooter/u.test(path)) specs.add(`${E2E}surface-footer.spec.ts`);
  return specs;
}

/**
 * Classifies the complete PR diff, never only its latest commit. Unknown paths and statuses widen
 * the scope. Changed free E2E specs survive widening so the focused job actually executes them.
 * @param {Change[]} changes
 * @param {{eventName?: string}} [options]
 * @returns {Scope}
 */
export function classifyChanges(changes, { eventName = 'pull_request' } = {}) {
  if (!Array.isArray(changes)) throw new Error('Changes must be an array');
  for (const change of changes) {
    if (
      change === null ||
      typeof change !== 'object' ||
      !safePath(change.path) ||
      typeof change.status !== 'string' ||
      change.status.length === 0
    )
      throw new Error('Each change requires a safe repository path and a Git status');
  }
  const changedSpecs = new Set();
  const rendererSpecs = new Set();
  let hasRenderer = false;
  let full = eventName !== 'pull_request' || changes.length === 0;
  let reason =
    eventName !== 'pull_request'
      ? 'Only pull_request events may narrow CI'
      : changes.length === 0
        ? 'An empty diff does not justify skipping validation'
        : 'Documentation-only changes';
  for (const { path, status } of changes) {
    if (status !== 'D' && !status.startsWith('R') && isSpec(path) && !optInSpec(path))
      changedSpecs.add(path);
    if (!['A', 'M'].includes(status)) {
      full = true;
      reason = 'Deletion, rename, or an unfamiliar Git status requires full validation';
    } else if (docsPath(path)) {
      continue;
    } else if (rendererPath(path)) {
      hasRenderer = true;
      for (const spec of displaySpecs(path)) rendererSpecs.add(spec);
    } else {
      full = true;
      reason = 'Changes cross the reviewed documentation and display-only boundaries';
    }
  }
  const mode = full ? 'full' : hasRenderer ? 'renderer' : 'docs';
  if (mode === 'renderer') reason = 'Reviewed renderer display paths';
  const e2eSpecs = new Set([...rendererSpecs, ...changedSpecs]);
  return { mode, fullMatrix: mode === 'full', e2eSpecs: [...e2eSpecs].sort(), reason };
}

function validateScope(scope) {
  if (
    scope === null ||
    typeof scope !== 'object' ||
    !['docs', 'renderer', 'full'].includes(scope.mode) ||
    scope.fullMatrix !== (scope.mode === 'full') ||
    typeof scope.reason !== 'string' ||
    !Array.isArray(scope.e2eSpecs) ||
    scope.e2eSpecs.some((spec) => !safePath(spec) || !isSpec(spec) || optInSpec(spec)) ||
    (scope.mode === 'docs' && scope.e2eSpecs.length !== 0)
  )
    throw new Error('Invalid CI scope');
}

/**
 * @param {Scope} scope
 * @param {Record<string, string>} results GitHub needs results keyed by job ID, not display name.
 * @returns {{required: string[]}}
 */
export function verifyRequiredJobs(scope, results) {
  validateScope(scope);
  if (results === null || typeof results !== 'object' || Array.isArray(results))
    throw new Error('Job results must be an object');
  const required = new Set(['classify']);
  if (scope.mode === 'full') for (const job of FULL_JOBS) required.add(job);
  else if (scope.mode === 'renderer') {
    required.add('quality');
    required.add('renderer-tests');
  }
  if (scope.e2eSpecs.length > 0) required.add('renderer-e2e');
  const failures = [];
  for (const job of required) {
    if (!Object.hasOwn(results, job) || results[job] !== 'success')
      failures.push(`${job}: ${Object.hasOwn(results, job) ? results[job] : 'missing'}`);
  }
  for (const [job, result] of Object.entries(results)) {
    if (!KNOWN_JOBS.has(job)) failures.push(`${job}: unknown job`);
    else if (!required.has(job) && !['success', 'skipped'].includes(result))
      failures.push(`${job}: ${result}`);
  }
  if (failures.length > 0) throw new Error(`Required CI validation failed: ${failures.join(', ')}`);
  return { required: [...required] };
}

/** The one current macOS-only free spec must run on macOS instead of silently skipping on Linux. */
export function focusedE2eMatrix(specs) {
  const mac = specs.filter((spec) => spec === `${E2E}macos-window-lifecycle.spec.ts`);
  const linux = specs.filter((spec) => spec !== `${E2E}macos-window-lifecycle.spec.ts`);
  return {
    include: [
      ...(linux.length > 0 ? [{ os: 'ubuntu-latest', specs: linux }] : []),
      ...(mac.length > 0 ? [{ os: 'macos-latest', specs: mac }] : []),
    ],
  };
}

/** Parse git diff --name-status -z --no-renames; malformed output must never become docs-only. */
export function parseNameStatus(output) {
  if (output === '') return [];
  if (!output.endsWith('\0')) throw new Error('Git diff output was not NUL terminated');
  const fields = output.slice(0, -1).split('\0');
  if (fields.length % 2 !== 0) throw new Error('Malformed Git name-status output');
  const changes = [];
  for (let index = 0; index < fields.length; index += 2)
    changes.push({ status: fields[index], path: fields[index + 1] });
  return changes;
}

function pullRequestChanges(eventPath) {
  if (!eventPath) throw new Error('GITHUB_EVENT_PATH is required for a pull_request event');
  const event = JSON.parse(readFileSync(eventPath, 'utf8'));
  const base = event.pull_request?.base?.sha;
  const head = event.pull_request?.head?.sha;
  if (![base, head].every((sha) => typeof sha === 'string' && /^[a-f0-9]{40,64}$/u.test(sha)))
    throw new Error('Pull request base/head SHAs are missing or invalid');
  const git = (args) =>
    execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trimEnd();
  const mergeBase = git(['merge-base', base, head]);
  if (!/^[a-f0-9]{40,64}$/u.test(mergeBase)) throw new Error('Git returned an invalid merge base');
  // Keep NUL delimiters intact: trimEnd() would remove whitespace belonging to a final filename.
  const diff = execFileSync(
    'git',
    [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--name-status',
      '-z',
      '--no-renames',
      mergeBase,
      head,
      '--',
    ],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  return { changes: parseNameStatus(diff), base, head, mergeBase };
}

function main() {
  if (process.argv[2] === 'classify') {
    const eventName = process.env.GITHUB_EVENT_NAME;
    if (!eventName) throw new Error('GITHUB_EVENT_NAME is required');
    const input =
      eventName === 'pull_request'
        ? pullRequestChanges(process.env.GITHUB_EVENT_PATH)
        : { changes: [] };
    const scope = classifyChanges(input.changes, { eventName });
    const output = {
      mode: scope.mode,
      full_matrix: String(scope.fullMatrix),
      e2e_specs: JSON.stringify(scope.e2eSpecs),
      e2e_matrix: JSON.stringify(focusedE2eMatrix(scope.e2eSpecs)),
      scope_json: JSON.stringify(scope),
      reason: scope.reason,
    };
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        Object.entries(output)
          .map(([key, value]) => `${key}=${value}\n`)
          .join(''),
      );
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `CI scope: **${scope.mode}**\n\n${scope.reason}\n\n` +
          `Tested SHA: ${/^[a-f0-9]{40,64}$/u.test(process.env.GITHUB_SHA ?? '') ? process.env.GITHUB_SHA : 'not provided'}\n\n` +
          `PR base: ${input.base ?? 'not applicable'}\n\n` +
          `PR head: ${input.head ?? 'not applicable'}\n\n` +
          `Focused E2E: ${scope.e2eSpecs.join(', ') || 'none'}\n`,
      );
    process.stdout.write(`${JSON.stringify(scope)}\n`);
  } else if (process.argv[2] === 'gate') {
    const scope = JSON.parse(process.env.CI_SCOPE_JSON ?? 'null');
    const needs = JSON.parse(process.env.CI_JOB_RESULTS_JSON ?? 'null');
    if (needs === null || typeof needs !== 'object' || Array.isArray(needs))
      throw new Error('CI_JOB_RESULTS_JSON must contain GitHub needs results');
    const results = Object.fromEntries(
      Object.entries(needs).map(([job, value]) => [
        job,
        typeof value === 'string' ? value : value?.result,
      ]),
    );
    const verified = verifyRequiredJobs(scope, results);
    process.stdout.write(`Required CI passed: ${verified.required.join(', ')}\n`);
  } else throw new Error('Usage: node ci-scope.mjs classify|gate');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
