import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runChild, validateUnitReport } from '../../ci-renderer-tests.mjs';

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
