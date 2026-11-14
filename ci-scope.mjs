import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** @typedef {{path: string, status: string}} Change Git name-status entries; only A/M may be narrowed. */
const DESKTOP = 'apps/desktop/';
const RENDERER = `${DESKTOP}src/renderer/`;
const PLATFORM_ROWS = {
  linux: { os: 'ubuntu-latest', label: 'Linux' },
  macos: { os: 'macos-latest', label: 'macOS' },
  windows: { os: 'windows-2022', label: 'Windows' },
};
const PLATFORMS = Object.keys(PLATFORM_ROWS);
const CI_SPEC = [
  'ci-scope.test.mjs',
  'ci-cache.test.mjs',
  'workflow-security.test.ts',
  'ci-test-sequencer.test.ts',
  'ci-renderer-tests.test.mjs',
  'forge.config.test.ts',
];
const WINDOWS_SPEC = ['src/main/desktop-control.test.ts'];
const SANDBOX_SPEC = [
  'src/main/sandbox-runner.test.ts',
  'src/main/command-runner.test.ts',
  'src/main/sandbox-node-pipe-guard.test.ts',
  'src/main/sandbox-node-pipe-guard.integration.test.ts',
];
const FILE_SPEC = ['src/main/native-safe-fs.test.ts', 'src/main/path-guard.test.ts'];
const DB_SPEC = ['src/main/persistence.test.ts', 'src/main/ipc.test.ts'];
const SHARED_SPEC = ['src/main/ipc.test.ts', 'src/main/permission-broker.test.ts'];
// These suites rerun their cases inside Electron in four groups (src/main/electron-test-shards.ts).
const ELECTRON_BRIDGE_SPECS = [
  'src/main/team-coordinator.test.ts',
  'src/main/graph-mission-persistence.test.ts',
];
const ELECTRON_BRIDGE_GROUPS = 4;
// A wide PR can select nearly the whole suite. Windows runs it with one worker (vitest.config.ts),
// which needs about 30 minutes, so only that platform is split; each shard takes one bridge group.
const RELATED_SHARDS = { linux: 1, macos: 1, windows: 4 };
const RELATED_BATCH = 100;
const PACKAGE_JOBS = ['package-linux', 'package-macos', 'package-windows-build', 'package-windows'];
const KNOWN_JOBS = new Set([
  'classify',
  'quality',
  'renderer-tests',
  'package-tests',
  'sandbox-rust-windows',
  'test-macos',
  'platform-tests',
  'electron-bridges',
  'website',
  ...PACKAGE_JOBS,
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

function docsPath(path) {
  // Runtime inputs and fixtures must not inherit an exemption just because they contain Markdown.
  if (/(?:fixture|resource|prompt|template)/iu.test(path)) return false;
  return (
    /^(?:README|CONTRIBUTING|CHANGELOG|AGENTS|SECURITY|CODE_OF_CONDUCT)\.md$/u.test(path) ||
    /^(?:docs|tasks)\/.+\.md$/u.test(path)
  );
}

function distributionPath(path) {
  return (
    /^(?:package(?:-lock)?\.json|\.nvmrc|build-(?:better-sqlite3|native-safe-fs|sandbox-runner|desktop-control)\.mjs|native-build-environment\.mjs|ci-(?:windows-package|install-electron)\.mjs)$/u.test(
      path,
    ) ||
    /^\.github\/(?:workflows\/release[^/]*\.ya?ml|actions\/(?:install-deps|install-electron|prepare-sandbox|prepare-desktop-control)\/)/u.test(
      path,
    ) ||
    /^apps\/desktop\/(?:package\.json|forge\.config\.ts|vite\..+\.config\.ts|entitlements\..+\.plist|windows-(?:wizard-installer|sandbox-artifacts)\.ts|src\/main\/desktop-control-build\.ts|vendor\/archify\/|installer\/|assets\/(?:sprint-coder-icon|dmg-background|fonts\/)|scripts\/(?:ensure-inno-setup|verify-unsigned-windows-release|create-macos-update-manifest|generate-dmg-background)|src\/main\/(?:auto-update|update-install-mutation-gate)\.)/u.test(
      path,
    ) ||
    /^packages\/(?:contracts|domain)\/package\.json$/u.test(path) ||
    /^docs\/licenses\/(?:unicode-license|geist-ofl|ibm-plex-sans-jp-ofl|plemoljp-ofl)\.txt$/u.test(
      path,
    )
  );
}

function boundaryPath(path) {
  if (path.startsWith('packages/')) return true;
  const local = path.slice(DESKTOP.length);
  return (
    path.startsWith(DESKTOP) &&
    (/^src\/(?:preload\/|renderer\/(?:store|types)\/)/u.test(local) ||
      /^src\/runtime-host\/.*(?:auth|protocol|sandbox|permission|worktree|workspace|secret|approval|path-guard)/u.test(
        local,
      ) ||
      /^src\/main\/(?:index\.|ipc[.-]|team-(?:coordinator|tools|worker-runtime)|provider-(?:egress|endpoint-policy|workspace-tools)|.*(?:persist|auth|permission|secret|approval|access-confirmation|workspace|write-scope|path-guard|mutation|file-publication|safe-git|worktree|edit-saga|command-runner|process-tree|sandbox|native|windows-))/u.test(
        local,
      ))
  );
}

function windowsNativePath(path) {
  return /^(?:build-desktop-control\.mjs|\.github\/actions\/prepare-desktop-control\/|apps\/desktop\/(?:desktop-control\/|src\/main\/desktop-control))/u.test(
    path,
  );
}

function sandboxPath(path) {
  return /^(?:apps\/desktop\/(?:sandbox-runner\/|resources\/sandbox|src\/main\/sandbox)|build-sandbox-runner\.mjs|\.github\/actions\/prepare-sandbox\/)/u.test(
    path,
  );
}

function fileBoundaryPath(path) {
  return /^(?:apps\/desktop\/(?:native-safe-fs\/|src\/main\/(?:native|path-guard|workspace|edit-saga|write-scope))|build-native-safe-fs\.mjs)/u.test(
    path,
  );
}

function ordinaryDesktopPath(path) {
  return /^apps\/desktop\/src\/[^\s]+\.(?:[cm]?ts|tsx|css)$/u.test(path);
}

function ciPath(path) {
  return /^\.github\/|^(?:ci-|native-build-environment\.mjs)|^apps\/desktop\/(?:ci-|vitest\.config|workflow-security)/u.test(
    path,
  );
}

// Inputs that Vitest's import graph cannot widen: the related run selects only their dedicated
// boundary specs. The Vitest configuration is excluded because changing it reruns every file.
function lightRelatedPath(path) {
  return (
    (ciPath(path) && !path.startsWith(`${DESKTOP}vitest.config`)) ||
    windowsNativePath(path) ||
    /^(?:apps\/desktop\/(?:sandbox-runner|native-safe-fs)\/|build-(?:sandbox-runner|native-safe-fs)\.mjs$)/u.test(
      path,
    )
  );
}

function boundarySpecs(desktop, broad, distribution) {
  // Some specs consume executables, workflow YAML or configuration through files, so Vitest's
  // import graph cannot discover those relationships.
  const paths = desktop.map(({ path }) => path);
  return [
    ...new Set([
      ...(paths.some(ciPath) || broad ? CI_SPEC : []),
      ...(paths.some(windowsNativePath) ? WINDOWS_SPEC : []),
      ...(paths.some(sandboxPath) ? SANDBOX_SPEC : []),
      ...(paths.some(fileBoundaryPath) ? FILE_SPEC : []),
      ...(paths.some((path) => /\/(?:.*persist|ipc[.-]|preload\/)/u.test(path)) ? DB_SPEC : []),
      ...(paths.some(boundaryPath) || (broad && !paths.every(ciPath)) ? SHARED_SPEC : []),
      ...(paths.some((path) => path.startsWith(RENDERER) && path.endsWith('.css'))
        ? ['src/renderer/components/RunCard.test.tsx']
        : []),
      ...(distribution ? ['forge.config.test.ts', 'release-beta-workflow.test.ts'] : []),
    ]),
  ];
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
 * @param {Change[]} changes The complete PR or push diff.
 * @param {{eventName?: string}} [options]
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

  const full = eventName !== 'pull_request';
  const distribution = changes.some(({ path }) => distributionPath(path));
  const websiteRequired = full || changes.some(({ path }) => websiteCheckPath(path));
  const desktop = changes.filter(
    ({ path, status }) =>
      !['A', 'M'].includes(status) || (!docsPath(path) && !path.startsWith('website/')),
  );
  const mode = full
    ? 'full'
    : desktop.length || changes.length === 0
      ? 'pr'
      : websiteRequired
        ? 'website'
        : 'docs';
  const broad =
    desktop.length === 0 ||
    desktop.some(
      ({ path, status }) =>
        !['A', 'M'].includes(status) ||
        (!ordinaryDesktopPath(path) && !windowsNativePath(path) && !path.startsWith('packages/')),
    );
  const allRelatedPlatforms =
    broad || desktop.some(({ path }) => boundaryPath(path) || sandboxPath(path));
  const windows = desktop.some(({ path }) => windowsNativePath(path));
  const windowsOnly = desktop.length > 0 && desktop.every(({ path }) => windowsNativePath(path));
  const platforms =
    full || (mode === 'pr' && allRelatedPlatforms)
      ? [...PLATFORMS]
      : mode === 'pr'
        ? [...(windowsOnly ? [] : ['linux']), ...(windows ? ['windows'] : [])]
        : [];
  const rendererOnly = desktop.length > 0 && desktop.every(({ path }) => path.startsWith(RENDERER));
  return {
    mode,
    shared:
      full ||
      (mode === 'pr' && (broad || desktop.some(({ path }) => path.startsWith('packages/')))),
    platforms,
    native: full || (mode === 'pr' && (!rendererOnly || allRelatedPlatforms)),
    windowsRust:
      full ||
      (mode === 'pr' &&
        (desktop.some(({ path }) => sandboxPath(path)) ||
          (broad && desktop.some(({ path }) => ciPath(path))))),
    distribution,
    websiteRequired,
    // Boundary and dependency changes reach most of the suite through imports or Vitest's
    // rerun triggers; CI-only and native-source changes select only their boundary specs.
    splitRelated:
      mode === 'pr' &&
      allRelatedPlatforms &&
      desktop.some(({ path, status }) => !['A', 'M'].includes(status) || !lightRelatedPath(path)),
    specs: mode === 'pr' ? boundarySpecs(desktop, broad, distribution) : [],
  };
}

function validateScope(scope) {
  if (
    scope === null ||
    typeof scope !== 'object' ||
    !['docs', 'website', 'pr', 'full'].includes(scope.mode) ||
    !['native', 'shared', 'windowsRust', 'distribution', 'websiteRequired', 'splitRelated'].every(
      (key) => typeof scope[key] === 'boolean',
    ) ||
    (scope.mode !== 'pr' && scope.splitRelated) ||
    !Array.isArray(scope.specs) ||
    !scope.specs.every((spec) => safePath(spec) && /\.test\.(?:mjs|ts|tsx)$/u.test(spec)) ||
    !Array.isArray(scope.platforms) ||
    scope.platforms.some((platform) => !PLATFORMS.includes(platform)) ||
    new Set(scope.platforms).size !== scope.platforms.length ||
    (scope.mode === 'full' &&
      (scope.platforms.length !== PLATFORMS.length ||
        !scope.native ||
        !scope.shared ||
        !scope.windowsRust ||
        !scope.websiteRequired)) ||
    (scope.mode === 'pr' && scope.platforms.length === 0) ||
    (['docs', 'website'].includes(scope.mode) &&
      (scope.platforms.length !== 0 ||
        scope.native ||
        scope.shared ||
        scope.windowsRust ||
        scope.distribution ||
        scope.websiteRequired !== (scope.mode === 'website')))
  )
    throw new Error('Invalid CI scope');
}

/** Derive workflow outputs and the required gate from the same selection. */
export function scopeOutputs(scope) {
  validateScope(scope);
  const full = scope.mode === 'full';
  const platformRows = full
    ? [
        ['linux', 3],
        ['windows', 5],
      ].flatMap(([platform, count]) =>
        Array.from({ length: count }, (_, i) => ({
          ...PLATFORM_ROWS[platform],
          shard: `${i + 1}/${count}`,
        })),
      )
    : scope.platforms.flatMap((platform) => {
        const count = scope.splitRelated ? RELATED_SHARDS[platform] : 1;
        return Array.from({ length: count }, (_, i) => ({
          ...PLATFORM_ROWS[platform],
          shard: count === 1 ? 'related' : `related ${i + 1}/${count}`,
        }));
      });
  return {
    mode: scope.mode,
    quality_required: String(full || scope.mode === 'pr'),
    native_required: String(scope.native),
    boundary_specs: JSON.stringify(scope.specs),
    shared_required: String(scope.shared),
    windows_rust_required: String(scope.windowsRust),
    full_matrix: String(full),
    platform_required: String(platformRows.length > 0),
    platform_matrix: JSON.stringify({ include: platformRows }),
    distribution_required: String(scope.distribution),
    website_required: String(scope.websiteRequired),
    scope_json: JSON.stringify(scope),
  };
}

/**
 * @param {ReturnType<typeof classifyChanges>} scope
 * @param {Record<string, string>} results GitHub needs results keyed by job ID, not display name.
 * @returns {{required: string[]}}
 */
export function verifyRequiredJobs(scope, results) {
  const output = scopeOutputs(scope);
  if (results === null || typeof results !== 'object' || Array.isArray(results))
    throw new Error('Job results must be an object');
  const required = new Set(['classify']);
  if (output.quality_required === 'true') required.add('quality');
  if (scope.shared) required.add('package-tests');
  if (scope.windowsRust) required.add('sandbox-rust-windows');
  if (output.platform_required === 'true') required.add('platform-tests');
  if (scope.mode === 'full') {
    required.add('renderer-tests');
    required.add('test-macos');
    required.add('electron-bridges');
  }
  if (scope.distribution) for (const job of PACKAGE_JOBS) required.add(job);
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

const GIT_SHA = /^[a-f0-9]{40,64}$/u;

function diffChanges(base, head) {
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
      base,
      head,
      '--',
    ],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  return parseNameStatus(diff);
}

function eventChanges(eventName, eventPath) {
  if (eventName !== 'pull_request' && eventName !== 'push') return { changes: [] };
  if (!eventPath) throw new Error(`GITHUB_EVENT_PATH is required for a ${eventName} event`);
  const event = JSON.parse(readFileSync(eventPath, 'utf8'));
  const pr = eventName === 'pull_request';
  const comparisonBase = pr ? event.pull_request?.base?.sha : event.before;
  let base = comparisonBase;
  const head = pr ? event.pull_request?.head?.sha : event.after;
  if (![base, head].every((sha) => typeof sha === 'string' && GIT_SHA.test(sha)))
    throw new Error(`Invalid ${eventName} base/head SHAs`);
  if (pr) {
    base = execFileSync('git', ['merge-base', base, head], { encoding: 'utf8' }).trim();
    if (!GIT_SHA.test(base)) throw new Error('Git returned an invalid merge base');
  } else if (/^0+$/u.test(base)) {
    // A newly created main has no prior tree. Compare all tracked files.
    base = execFileSync('git', ['hash-object', '-t', 'tree', '-w', '--stdin'], {
      encoding: 'utf8',
      input: '',
    }).trim();
  } else {
    // A force push can leave the old tip outside checked-out history.
    try {
      execFileSync('git', ['cat-file', '-e', `${base}^{commit}`], { stdio: 'ignore' });
    } catch {
      execFileSync('git', ['fetch', '--no-tags', 'origin', base], { stdio: 'inherit' });
    }
  }
  return { changes: diffChanges(base, head), base, head, comparisonBase };
}

/**
 * Base for `vitest list --changed`, which diffs `<base>...HEAD` against the checked-out tree.
 * A pull_request checkout is GitHub's merge of the PR head into the base branch as it is now,
 * while `pull_request.base.sha` stays at the base tip from when the PR was opened. Diffing from
 * that old tip would also select tests for everything merged into the base branch since then,
 * so a recognised merge checkout compares against its first parent: the merged tree minus the
 * current base is exactly the PR's own change. Any other shape keeps the old base, whose
 * selection is a superset, so a misread checkout runs more tests, never fewer.
 * @param {{comparisonBase: string, prHead?: string, cwd?: string}} options
 * @returns {{base: string, reason: string, fallback: boolean}}
 */
export function relatedChangedBase({ comparisonBase, prHead = '', cwd = process.cwd() }) {
  if (!GIT_SHA.test(comparisonBase ?? ''))
    throw new Error('A valid PR base SHA is required for related tests');
  if (!GIT_SHA.test(prHead ?? '') && prHead !== '')
    throw new Error('Invalid PR head SHA for related tests');
  const fallback = (reason) => ({
    base: comparisonBase,
    reason: `${reason}; using the PR base, which may select extra tests`,
    fallback: true,
  });
  if (prHead === '') return fallback('PR head not provided');
  const git = (...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  const listed = git('rev-list', '--parents', '-n', '1', 'HEAD');
  const [head, ...parents] = listed.status === 0 ? listed.stdout.trim().split(' ') : [];
  // `<base>...HEAD` from the PR head itself already starts at the PR's fork point.
  if (head === prHead) return { base: comparisonBase, reason: 'PR head checkout', fallback: false };
  if (
    parents.length === 2 &&
    parents.every((sha) => GIT_SHA.test(sha)) &&
    parents[1] === prHead &&
    git('merge-base', '--is-ancestor', comparisonBase, parents[0]).status === 0
  )
    return { base: parents[0], reason: 'first parent of the PR merge checkout', fallback: false };
  return fallback('checkout is not a recognised merge of the PR head');
}

function runRelatedTests() {
  const desktop = resolve(dirname(fileURLToPath(import.meta.url)), DESKTOP);
  const { base, reason, fallback } = relatedChangedBase({
    comparisonBase: process.env.CI_COMPARISON_BASE ?? '',
    prHead: process.env.CI_PR_HEAD ?? '',
    cwd: desktop,
  });
  console.log(`Related tests compare against ${base} (${reason})`);
  if (fallback) console.log(`::warning title=Related test base::${reason}`);
  const shard = process.env.CI_RELATED_SHARD || 'related';
  parseRelatedShard(shard);
  const explicit = JSON.parse(process.env.CI_BOUNDARY_SPECS ?? '[]');
  if (!Array.isArray(explicit) || !explicit.every(safePath))
    throw new Error('Invalid CI boundary specs');
  const vitest = resolve(desktop, '../../node_modules/vitest/vitest.mjs');
  for (const spec of explicit) {
    if (!existsSync(resolve(desktop, spec)))
      throw new Error(`Required boundary spec did not resolve: ${spec}`);
  }
  const selected = new Set(explicit);
  const collected = JSON.parse(
    execFileSync(process.execPath, [vitest, 'list', '--filesOnly', '--json', '--changed', base], {
      cwd: desktop,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    }),
  );
  for (const { file } of collected) {
    if (typeof file !== 'string' || !isAbsolute(file))
      throw new Error('Unexpected related test path');
    const local = relative(desktop, file).replaceAll('\\', '/');
    if (!safePath(local)) throw new Error('Related test is outside the desktop workspace');
    selected.add(local);
  }
  if (!selected.size) {
    console.log('No desktop tests match the PR diff or explicit boundary checks.');
    return;
  }
  const runs = relatedTestRuns([...selected], shard);
  console.log(`Running ${selected.size} related desktop test files (${shard})`);
  for (const run of runs) {
    const result = spawnSync(process.execPath, [vitest, ...run.args], {
      cwd: desktop,
      env: { ...process.env, ...run.env },
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      return;
    }
  }
}

/** @returns {{index: number, count: number}} */
export function parseRelatedShard(value) {
  const match = /^related(?: ([1-9][0-9]?)\/([1-9][0-9]?))?$/u.exec(value ?? '');
  const index = Number(match?.[1] ?? 1);
  const count = Number(match?.[2] ?? 1);
  if (!match || index > count) throw new Error('Invalid related test shard');
  return { index, count };
}

/**
 * Vitest invocations for one related shard. Every shard receives the same selection, so the
 * shards together run each selected file, and each Electron bridge group, exactly once.
 * @param {string[]} files
 * @param {string} shard `related` or `related <index>/<count>` from the platform matrix.
 * @returns {{args: string[], env: Record<string, string>}[]}
 */
export function relatedTestRuns(files, shard) {
  const { index, count } = parseRelatedShard(shard);
  if (!Array.isArray(files) || !files.every(safePath) || new Set(files).size !== files.length)
    throw new Error('Invalid related test files');
  const runs = [];
  // Windows process command lines have a 32K-character limit.
  const batches = (list, options) => {
    for (let offset = 0; offset < list.length; offset += RELATED_BATCH)
      runs.push({
        args: [
          'run',
          '--allowOnly=false',
          ...options,
          ...list.slice(offset, offset + RELATED_BATCH),
        ],
        env: {},
      });
  };
  if (count === 1) {
    batches(files, []);
    return runs;
  }
  // Sort so that every shard builds identical batches whatever order Vitest listed them in.
  const sorted = [...files].sort();
  batches(
    sorted.filter((file) => !ELECTRON_BRIDGE_SPECS.includes(file)),
    [
      `--shard=${index}/${count}`,
      // A batch can have fewer files than shards; the other shards run those files.
      '--passWithNoTests',
      ...ELECTRON_BRIDGE_SPECS.flatMap((spec) => ['--exclude', spec]),
    ],
  );
  for (const file of sorted.filter((entry) => ELECTRON_BRIDGE_SPECS.includes(entry))) {
    for (let group = index - 1; group < ELECTRON_BRIDGE_GROUPS; group += count)
      runs.push({
        args: ['run', '--allowOnly=false', file],
        env: { SPRINT_CODER_ELECTRON_BRIDGE_SHARD: String(group) },
      });
  }
  return runs;
}

function main() {
  if (process.argv[2] === 'classify') {
    const eventName = process.env.GITHUB_EVENT_NAME;
    if (!eventName) throw new Error('GITHUB_EVENT_NAME is required');
    const input = eventChanges(eventName, process.env.GITHUB_EVENT_PATH);
    const scope = classifyChanges(input.changes, { eventName });
    const output = {
      ...scopeOutputs(scope),
      comparison_base: input.comparisonBase ?? '',
      diff_base: input.base ?? '',
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
        `CI scope: **${scope.mode}**\n\nSelected platforms: ${scope.platforms.join(', ') || 'none'}\n\n` +
          `Tested SHA: ${/^[a-f0-9]{40,64}$/u.test(process.env.GITHUB_SHA ?? '') ? process.env.GITHUB_SHA : 'not provided'}\n\n` +
          `Comparison base: ${input.base ?? 'not applicable'}\n\n` +
          `Diff head: ${input.head ?? 'not applicable'}\n`,
      );
    process.stdout.write(`${JSON.stringify(scope)}\n`);
  } else if (process.argv[2] === 'related') {
    runRelatedTests();
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
  } else throw new Error('Usage: node ci-scope.mjs classify|gate|related');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
