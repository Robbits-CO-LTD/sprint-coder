import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseE2ESpecs,
  runChild,
  validateE2EPlan,
  validateE2EReport,
  validateUnitReport,
} from '../../ci-renderer-tests.mjs';

function unitReport() {
  return {
    success: true,
    numTotalTests: 1,
    numPassedTests: 1,
    numFailedTests: 0,
    numFailedTestSuites: 0,
    numPendingTests: 0,
    numPendingTestSuites: 0,
    numTodoTests: 0,
    testResults: [
      {
        name: '/repo/apps/desktop/src/renderer/example.test.ts',
        status: 'passed',
        message: '',
        assertionResults: [{ fullName: 'suite passes', status: 'passed', failureMessages: [] }],
      },
    ],
  };
}

const specs = ['tests/e2e/settings-dialog.spec.ts'];

function playwrightReport({ planned = false, declaredSkip = false } = {}) {
  const spec = (title, line, skipped) => ({
    title,
    file: 'settings-dialog.spec.ts',
    line,
    ok: true,
    tests: [
      {
        projectId: '',
        projectName: '',
        expectedStatus: skipped ? 'skipped' : 'passed',
        status: planned || skipped ? 'skipped' : 'expected',
        results: planned ? [] : [{ status: skipped ? 'skipped' : 'passed', errors: [], retry: 0 }],
      },
    ],
  });
  return {
    errors: [],
    stats: { expected: planned ? 0 : 1, skipped: declaredSkip ? 1 : 0, unexpected: 0, flaky: 0 },
    suites: [
      {
        title: 'settings-dialog.spec.ts',
        specs: [],
        suites: [
          {
            title: 'settings dialog',
            specs: [
              spec('opens settings', 20, false),
              ...(declaredSkip ? [spec('legacy import', 30, true)] : []),
            ],
          },
        ],
      },
    ],
  };
}

const firstSpec = (report) => report.suites[0].suites[0].specs[0];

describe('Test subprocess results', () => {
  it('preserves a failed command exit code', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ci-renderer-gate-'));
    try {
      await expect(
        runChild(['-e', 'process.exit(23)'], root, join(root, 'report.json')),
      ).rejects.toMatchObject({ exitCode: 23 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('preserves a terminated command signal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ci-renderer-gate-'));
    try {
      await expect(
        runChild(['-e', 'process.kill(process.pid, "SIGTERM")'], root, join(root, 'report.json')),
      ).rejects.toMatchObject({ signal: 'SIGTERM' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('Renderer unit result gate', () => {
  it('accepts a complete successful report', () => {
    expect(validateUnitReport(unitReport())).toEqual({ passed: 1, skipped: 0 });
  });

  it.each([
    ['zero tests', (report) => (report.numTotalTests = 0)],
    ['missing assertions', (report) => (report.testResults[0].assertionResults = [])],
    ['missing file results', (report) => (report.testResults = [])],
    ['pending test', (report) => (report.numPendingTests = 1)],
    ['todo test', (report) => (report.numTodoTests = 1)],
    ['failed suite', (report) => (report.numFailedTestSuites = 1)],
    ['failed result', (report) => (report.testResults[0].status = 'failed')],
    ['unexpected skip', (report) => (report.testResults[0].assertionResults[0].status = 'skipped')],
    [
      'hidden failure',
      (report) => report.testResults[0].assertionResults[0].failureMessages.push('failed'),
    ],
    ['incorrect total', (report) => (report.numTotalTests = 2)],
    ['incorrect passing total', (report) => (report.numPassedTests = 0)],
    [
      'duplicate assertion',
      (report) =>
        report.testResults[0].assertionResults.push(report.testResults[0].assertionResults[0]),
    ],
  ])('rejects %s even when the child claims success', (_label, change) => {
    const report = unitReport();
    change(report);
    expect(() => validateUnitReport(report)).toThrow();
  });
});

describe('Focused E2E collection and execution gate', () => {
  it('accepts exact selectors and rejects missing, ambiguous or option-like input', () => {
    expect(parseE2ESpecs(JSON.stringify(specs))).toEqual(specs);
    for (const value of [
      undefined,
      '[]',
      '["--list"]',
      '["tests/e2e/../a.spec.ts"]',
      JSON.stringify([...specs, ...specs]),
    ])
      expect(() => parseE2ESpecs(value)).toThrow();
  });

  it('compares execution to planned collection and reports declared skips separately', () => {
    const planned = playwrightReport({ planned: true, declaredSkip: true });
    const actual = playwrightReport({ declaredSkip: true });
    expect(validateE2EPlan(planned, specs)).toEqual({
      required: 1,
      declaredSkips: ['settings-dialog.spec.ts:30 legacy import'],
    });
    expect(validateE2EReport(planned, actual, specs)).toEqual({
      passed: 1,
      declaredSkips: ['settings-dialog.spec.ts:30 legacy import'],
    });
  });

  it('rejects empty collection or a selector collecting no file', () => {
    const empty = playwrightReport({ planned: true });
    empty.suites = [];
    expect(() => validateE2EPlan(empty, specs)).toThrow();
    expect(() =>
      validateE2EPlan(playwrightReport({ planned: true }), [...specs, 'tests/e2e/missing.spec.ts']),
    ).toThrow();
  });

  it.each([
    ['missing collected test', (report) => (report.suites[0].suites[0].specs = [])],
    [
      'duplicate collected test',
      (report) => report.suites[0].suites[0].specs.push(firstSpec(report)),
    ],
    ['substituted test identity', (report) => (firstSpec(report).title = 'different test')],
    ['failed test', (report) => (firstSpec(report).tests[0].results[0].status = 'failed')],
    [
      'runtime skip',
      (report) => {
        firstSpec(report).tests[0].expectedStatus = 'skipped';
        firstSpec(report).tests[0].status = 'skipped';
        firstSpec(report).tests[0].results[0].status = 'skipped';
      },
    ],
    ['no execution', (report) => (firstSpec(report).tests[0].results = [])],
    [
      'interrupted test',
      (report) => (firstSpec(report).tests[0].results[0].status = 'interrupted'),
    ],
    [
      'retry hiding failure',
      (report) => firstSpec(report).tests[0].results.unshift({ status: 'failed', errors: [] }),
    ],
    ['global error', (report) => report.errors.push({ message: 'setup failed' })],
    ['wrong passing count', (report) => (report.stats.expected = 0)],
    ['unexpected skip count', (report) => (report.stats.skipped = 1)],
  ])('rejects %s', (_label, change) => {
    const actual = playwrightReport();
    change(actual);
    expect(() => validateE2EReport(playwrightReport({ planned: true }), actual, specs)).toThrow();
  });

  it('rejects suites where every collected case is declared skipped', () => {
    const planned = playwrightReport({ planned: true });
    firstSpec(planned).tests[0].expectedStatus = 'skipped';
    expect(() => validateE2EPlan(planned, specs)).toThrow();
  });
});
