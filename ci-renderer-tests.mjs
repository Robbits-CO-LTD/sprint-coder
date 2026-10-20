import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(repositoryRoot, 'apps/desktop');
const evidenceRoot = join(repositoryRoot, 'test-results/ci-renderer');

function summarize(label, passed, skips = []) {
  console.log(`${label}: ${passed} passed, ${skips.length} declared skips`);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `${label}: **${passed} required tests passed**, ${skips.length} skips declared before execution.\n\n${skips.map((skip) => `- ${skip}\n`).join('')}\n`,
    );
}

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Invalid ${label}`);
  return value;
}

function array(value, label) {
  if (!Array.isArray(value)) throw new Error(`Missing ${label}`);
  return value;
}

export function validateUnitReport(value) {
  const report = record(value, 'Vitest report');
  if (
    report.success !== true ||
    !Number.isInteger(report.numTotalTests) ||
    report.numTotalTests < 1 ||
    report.numFailedTests !== 0 ||
    report.numFailedTestSuites !== 0 ||
    report.numPendingTests !== 0 ||
    report.numPendingTestSuites !== 0 ||
    report.numTodoTests !== 0
  )
    throw new Error('Renderer unit tests failed, were skipped, or collected no tests');
  const tests = new Set();
  for (const rawFile of array(report.testResults, 'Vitest testResults')) {
    const file = record(rawFile, 'Vitest file');
    if (typeof file.name !== 'string' || file.status !== 'passed' || file.message)
      throw new Error('Invalid or failed Vitest file');
    const assertions = array(file.assertionResults, 'Vitest assertionResults');
    if (!assertions.length) throw new Error('Renderer test file collected no assertions');
    for (const rawAssertion of assertions) {
      const assertion = record(rawAssertion, 'Vitest assertion');
      if (
        typeof assertion.fullName !== 'string' ||
        !assertion.fullName ||
        assertion.status !== 'passed' ||
        array(assertion.failureMessages, 'Vitest failureMessages').length
      )
        throw new Error('Renderer unit assertion failed or was unexpectedly skipped');
      const key = JSON.stringify([file.name, assertion.fullName]);
      if (tests.has(key)) throw new Error('Duplicate Renderer unit assertion');
      tests.add(key);
    }
  }
  if (tests.size !== report.numTotalTests || report.numPassedTests !== tests.size)
    throw new Error('Renderer unit assertion collection/count mismatch');
  return { passed: tests.size, skipped: 0 };
}

export function parseE2ESpecs(value) {
  const specs = array(JSON.parse(value ?? 'null'), 'CI_E2E_SPECS');
  if (
    !specs.length ||
    specs.some(
      (spec) =>
        typeof spec !== 'string' ||
        !/^tests\/e2e\/[a-zA-Z0-9_./-]+\.spec\.ts$/u.test(spec) ||
        spec.split('/').some((part) => part === '..' || part === '.' || part === ''),
    ) ||
    new Set(specs).size !== specs.length
  )
    throw new Error('CI_E2E_SPECS must contain unique, exact tests/e2e/*.spec.ts paths');
  return specs;
}

function playwrightCases(value) {
  const report = record(value, 'Playwright report');
  if (array(report.errors, 'Playwright errors').length)
    throw new Error('Playwright reported a collection or global error');
  const cases = new Map();
  const visit = (rawSuite, ancestors) => {
    const suite = record(rawSuite, 'Playwright suite');
    if (typeof suite.title !== 'string') throw new Error('Invalid Playwright suite title');
    const titles = [...ancestors, suite.title];
    for (const rawSpec of array(suite.specs, 'Playwright specs')) {
      const spec = record(rawSpec, 'Playwright spec');
      if (
        typeof spec.file !== 'string' ||
        typeof spec.title !== 'string' ||
        !Number.isInteger(spec.line) ||
        spec.line < 1
      )
        throw new Error('Invalid Playwright spec identity');
      const tests = array(spec.tests, 'Playwright tests');
      if (!tests.length) throw new Error('Playwright spec collected no tests');
      for (const rawTest of tests) {
        const test = record(rawTest, 'Playwright test');
        if (typeof test.projectId !== 'string' || typeof test.projectName !== 'string')
          throw new Error('Invalid Playwright project identity');
        const key = JSON.stringify([
          spec.file.replaceAll('\\', '/'),
          ...titles,
          spec.title,
          spec.line,
          test.projectId,
          test.projectName,
        ]);
        if (cases.has(key)) throw new Error('Duplicate Playwright test identity');
        cases.set(key, { spec, test });
      }
    }
    for (const child of array(suite.suites ?? [], 'Playwright nested suites')) visit(child, titles);
  };
  for (const suite of array(report.suites, 'Playwright suites')) visit(suite, []);
  return cases;
}

export function validateE2EPlan(value, specs) {
  const cases = playwrightCases(value);
  const selected = new Set(specs.map((spec) => spec.slice('tests/e2e/'.length)));
  const collected = new Set();
  let required = 0;
  const declaredSkips = [];
  for (const { spec, test } of cases.values()) {
    const file = spec.file.replaceAll('\\', '/');
    if (!selected.has(file)) throw new Error(`Unexpected Playwright spec: ${file}`);
    collected.add(file);
    if (test.expectedStatus === 'skipped') declaredSkips.push(`${file}:${spec.line} ${spec.title}`);
    else if (test.expectedStatus === 'passed') required++;
    else throw new Error('Focused E2E must expect passing tests or explicitly declared skips');
  }
  if (!required || selected.size !== collected.size)
    throw new Error('Focused E2E collected no required tests or omitted a selected spec');
  return { required, declaredSkips };
}

export function validateE2EReport(planned, actual, specs) {
  const summary = validateE2EPlan(planned, specs);
  const expected = playwrightCases(planned);
  const executed = playwrightCases(actual);
  if (expected.size !== executed.size) throw new Error('Playwright test collection mismatch');
  for (const [key, { test: plannedTest }] of expected) {
    const result = executed.get(key);
    if (!result) throw new Error('Playwright omitted a collected test');
    const { spec, test } = result;
    const results = array(test.results, 'Playwright test results');
    if (plannedTest.expectedStatus === 'skipped') {
      if (
        test.expectedStatus !== 'skipped' ||
        test.status !== 'skipped' ||
        results.some((attempt) => attempt.status !== 'skipped')
      )
        throw new Error('Declared Playwright skip changed during execution');
      continue;
    }
    if (
      spec.ok !== true ||
      test.expectedStatus !== 'passed' ||
      test.status !== 'expected' ||
      results.length !== 1 ||
      results[0].status !== 'passed' ||
      results[0].error ||
      array(results[0].errors, 'Playwright attempt errors').length
    )
      throw new Error('Required Playwright test failed, retried, was skipped, or did not execute');
  }
  const stats = record(actual.stats, 'Playwright stats');
  if (
    stats.expected !== summary.required ||
    stats.unexpected !== 0 ||
    stats.flaky !== 0 ||
    stats.skipped !== summary.declaredSkips.length
  )
    throw new Error('Playwright execution totals mismatch');
  return { passed: summary.required, declaredSkips: summary.declaredSkips };
}

export async function runChild(args, cwd, reportFile, environment = {}) {
  rmSync(reportFile, { force: true });
  const child = spawn(process.execPath, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...environment },
  });
  let cancellationSignal;
  const forward = (signal) => {
    cancellationSignal = signal;
    child.kill(signal);
  };
  const interrupt = () => forward('SIGINT');
  const terminate = () => forward('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    const outcome = await new Promise((resolveResult, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolveResult({ code, signal }));
    });
    const signal = cancellationSignal ?? outcome.signal;
    if (signal) {
      const error = new Error(`Test command terminated by ${signal}`);
      error.signal = signal;
      throw error;
    }
    if (outcome.code !== 0) {
      const error = new Error(`Test command exited with code ${outcome.code}`);
      error.exitCode = outcome.code ?? 1;
      throw error;
    }
    return JSON.parse(readFileSync(reportFile, 'utf8'));
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}

export async function main(mode) {
  mkdirSync(evidenceRoot, { recursive: true });
  if (mode === 'unit') {
    const reportFile = join(evidenceRoot, 'unit.json');
    const report = await runChild(
      [
        join(repositoryRoot, 'node_modules/vitest/vitest.mjs'),
        'run',
        'src/renderer',
        '--allowOnly=false',
        '--reporter=default',
        '--reporter=json',
        `--outputFile=${reportFile}`,
      ],
      desktopRoot,
      reportFile,
    );
    const summary = validateUnitReport(report);
    summarize('Renderer unit', summary.passed);
    return;
  }
  if (mode !== 'e2e') throw new Error('Usage: node ci-renderer-tests.mjs unit|e2e');
  const specs = parseE2ESpecs(process.env.CI_E2E_SPECS);
  const args = [
    join(repositoryRoot, 'node_modules/playwright/cli.js'),
    'test',
    '--config=playwright.dev.config.ts',
    '--workers=1',
    '--retries=0',
    '--forbid-only',
    '--reporter=json',
    `--output=${join(evidenceRoot, 'e2e-artifacts')}`,
    ...specs,
  ];
  const listFile = join(evidenceRoot, 'list.json');
  const plan = await runChild([...args, '--list'], repositoryRoot, listFile, {
    PLAYWRIGHT_JSON_OUTPUT_FILE: listFile,
  });
  const planned = validateE2EPlan(plan, specs);
  console.log(
    `Focused E2E: ${planned.required} required, ${planned.declaredSkips.length} declared skips`,
  );
  for (const skip of planned.declaredSkips) console.log(`Declared skip: ${skip}`);
  const reportFile = join(evidenceRoot, 'e2e.json');
  const actual = await runChild(args, repositoryRoot, reportFile, {
    PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile,
  });
  const summary = validateE2EReport(plan, actual, specs);
  summarize('Focused E2E', summary.passed, summary.declaredSkips);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    if (error.signal) process.kill(process.pid, error.signal);
    else process.exitCode = Number.isInteger(error.exitCode) ? error.exitCode : 1;
  });
}
