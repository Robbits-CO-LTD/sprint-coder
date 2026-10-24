import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** @typedef {{path: string, status: string}} Change Git name-status entries; only A/M may be narrowed. */
/** @typedef {{mode: 'docs' | 'renderer' | 'website' | 'full', fullMatrix: boolean, websiteRequired: boolean, reason: string}} Scope */

const RENDERER = 'apps/desktop/src/renderer/';
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
  'package-windows-build',
  'package-windows',
  'package-macos',
  'renderer-tests',
];
const KNOWN_JOBS = new Set(['classify', ...FULL_JOBS, 'website']);
function safePath(path) {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    !/[\\\u0000-\u001f\u007f]/u.test(path) &&
    !path.startsWith('/') &&
    !path.split('/').some((part) => part === '' || part === '.' || part === '..')
  );
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

function websiteCheckPath(path) {
  return (
    path.startsWith('website/') ||
    path.startsWith('deploy/website/') ||
    path.startsWith('.github/actions/install-deps/') ||
    [
      'ci-website.mjs',
      'apps/desktop/ci-website.test.mjs',
      'ci-scope.mjs',
      'ci-cache.mjs',
      '.github/workflows/ci.yml',
      'package-lock.json',
      'package.json',
      'apps/desktop/package.json',
    ].includes(path)
  );
}

/**
 * Classifies the complete PR diff, never only its latest commit. Unknown paths and statuses widen
 * the scope; UI acceptance is performed separately with Computer Use.
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
  let hasRenderer = false;
  let hasWebsite = false;
  let full = eventName !== 'pull_request' || changes.length === 0;
  let websiteRequired = full;
  let reason =
    eventName !== 'pull_request'
      ? 'Only pull_request events may narrow CI'
      : changes.length === 0
        ? 'An empty diff does not justify skipping validation'
        : 'Documentation-only changes';
  for (const { path, status } of changes) {
    if (websiteCheckPath(path)) websiteRequired = true;
    if (!['A', 'M'].includes(status)) {
      full = true;
      reason = 'Deletion, rename, or an unfamiliar Git status requires full validation';
    } else if (docsPath(path)) {
      continue;
    } else if (path.startsWith('website/')) {
      hasWebsite = true;
    } else if (rendererPath(path)) {
      hasRenderer = true;
    } else {
      full = true;
      reason = 'Changes cross the reviewed documentation and display-only boundaries';
    }
  }
  if (hasWebsite && hasRenderer) {
    full = true;
    reason = 'Website and desktop changes require full validation';
  }
  const mode = full ? 'full' : hasWebsite ? 'website' : hasRenderer ? 'renderer' : 'docs';
  if (mode === 'renderer') reason = 'Reviewed renderer display paths';
  if (mode === 'website') reason = 'Standalone website changes';
  return {
    mode,
    fullMatrix: mode === 'full',
    websiteRequired,
    reason,
  };
}

function validateScope(scope) {
  if (
    scope === null ||
    typeof scope !== 'object' ||
    !['docs', 'renderer', 'website', 'full'].includes(scope.mode) ||
    scope.fullMatrix !== (scope.mode === 'full') ||
    typeof scope.websiteRequired !== 'boolean' ||
    (scope.mode === 'website' && scope.websiteRequired !== true) ||
    (['docs', 'renderer'].includes(scope.mode) && scope.websiteRequired !== false) ||
    typeof scope.reason !== 'string'
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
  if (scope.websiteRequired) required.add('website');
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
      website_required: String(scope.websiteRequired),
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
          `PR head: ${input.head ?? 'not applicable'}\n`,
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
