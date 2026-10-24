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
  throw new Error('Usage: node ci-renderer-tests.mjs unit');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    if (error.signal) process.kill(process.pid, error.signal);
    else process.exitCode = Number.isInteger(error.exitCode) ? error.exitCode : 1;
  });
}
