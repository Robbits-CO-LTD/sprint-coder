import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '../..');
const workflow = readFileSync(resolve(repoRoot, '.github/workflows/ci.yml'), 'utf8');
const config = readFileSync(resolve(repoRoot, 'playwright.windows.config.ts'), 'utf8');
const documentation = readFileSync(resolve(repoRoot, 'docs/WINDOWS_E2E.md'), 'utf8');

const windowsE2EJob = workflow.slice(
  workflow.indexOf('\n  e2e-windows:'),
  workflow.indexOf('\n  macos-result:'),
);
const windowsResultJob = workflow.slice(
  workflow.indexOf('\n  windows-result:'),
  workflow.indexOf('\n  required:'),
);

describe('Windows major E2E workflow', () => {
  it('selects every required local flow explicitly and excludes credentialed opt-in specs', () => {
    for (const spec of [
      'keyboard-smoke.spec.ts',
      'setup-wizard.spec.ts',
      'composer-input-boundaries.spec.ts',
      'settings-dialog.spec.ts',
      'project-sidebar.spec.ts',
      'file-edits.spec.ts',
      'approval-flow.spec.ts',
      'team-flow.spec.ts',
    ]) {
      expect(config).toContain(spec);
    }

    expect(config).not.toContain("'**/macos-window-lifecycle.spec.ts'");
    expect(config).not.toContain("'**/leader-mcp-smoke.spec.ts'");
    expect(config).not.toContain("'**/leader-mcp-codex-smoke.spec.ts'");
    expect(documentation).toContain('macos-window-lifecycle.spec.ts');
    expect(documentation).toContain('leader-mcp-smoke.spec.ts');
  });

  it('retains deterministic failure evidence without retries', () => {
    expect(config).toContain('retries: 0');
    expect(config).toContain('workers: 1');
    expect(config).toContain("trace: 'retain-on-failure'");
    expect(config).toContain("screenshot: 'only-on-failure'");
    expect(config).toContain("['html', { open: 'never', outputFolder: 'playwright-report' }]");
  });

  it('runs on every CI invocation and uploads evidence without masking the test exit code', () => {
    expect(windowsE2EJob).not.toContain("if: needs.classify.outputs.full_matrix == 'true'");
    expect(windowsE2EJob).toContain('--config playwright.windows.config.ts');
    expect(windowsE2EJob).toContain('Tee-Object -FilePath $logPath');
    expect(windowsE2EJob).toContain('$testExitCode = $LASTEXITCODE');
    expect(windowsE2EJob).not.toContain('continue-on-error');
    expect(windowsE2EJob).toContain('if: always()');
    expect(windowsE2EJob).toContain('actions/upload-artifact@v7');
    expect(windowsE2EJob).toContain('${{ runner.temp }}/windows-e2e.log');
    expect(windowsE2EJob).toContain('if-no-files-found: warn');
  });

  it('requires Windows E2E success in both fast and full result paths', () => {
    const e2eAssertion = 'test "${WINDOWS_E2E_RESULT}" = \'success\'';
    const fullMatrixBranch = windowsResultJob.indexOf('if [[ "${FULL_MATRIX}" == \'true\' ]]');

    expect(windowsResultJob).toContain(
      'needs: [classify, windows-smoke, platform-tests, package-linux, package-windows, e2e-windows]',
    );
    expect(windowsResultJob.indexOf(e2eAssertion)).toBeGreaterThan(-1);
    expect(windowsResultJob.indexOf(e2eAssertion)).toBeLessThan(fullMatrixBranch);
    expect(workflow).toContain('needs: [quality-result, macos-result, windows-result]');
  });
});
