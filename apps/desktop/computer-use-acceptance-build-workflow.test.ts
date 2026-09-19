import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMPUTER_USE_ACCEPTANCE_BUILD_ENV } from './computer-use-acceptance-build';
import { COMPUTER_USE_WINDOWS_UNSIGNED_ACCEPTANCE } from './src/main/computer-use-acceptance-mode';

const workflow = readFileSync(
  resolve(__dirname, '../../.github/workflows/computer-use-acceptance-build.yml'),
  'utf8',
);
const releaseWorkflow = readFileSync(
  resolve(__dirname, '../../.github/workflows/release-beta.yml'),
  'utf8',
);
const ciWorkflow = readFileSync(resolve(__dirname, '../../.github/workflows/ci.yml'), 'utf8');

describe('Computer Use acceptance build workflow', () => {
  it('is manual-only and requires an explicit unsigned-acceptance confirmation', () => {
    expect(workflow).toContain('on:\n  workflow_dispatch:');
    expect(workflow).not.toMatch(/\n {2}push:/u);
    expect(workflow).not.toMatch(/\n {2}pull_request:/u);
    expect(workflow).toContain('confirm_unsigned_acceptance:');
    expect(workflow).toContain('CONFIRMED: ${{ inputs.confirm_unsigned_acceptance }}');
    expect(workflow).toContain("if ($env:CONFIRMED -ne 'true') {");
    expect(workflow).toContain('permissions: {}');
    expect(workflow).toContain('runs-on: windows-2022');
  });

  it('builds with the acceptance mode and never with the release flag', () => {
    expect(workflow).toContain(
      `${COMPUTER_USE_ACCEPTANCE_BUILD_ENV}: ${COMPUTER_USE_WINDOWS_UNSIGNED_ACCEPTANCE}`,
    );
    expect(workflow).toContain('npm run make:windows');
    expect(workflow).not.toContain('SPRINT_CODER_RELEASE');
    expect(workflow).not.toContain('SPRINT_CODER_WINDOWS_CERTIFICATE');
  });

  it('actively proves the package is unsigned and carries the acceptance mode', () => {
    expect(workflow).toContain(
      './scripts/verify-unsigned-windows-release.ps1 -RequireUnsignedComputerUseHelper',
    );
    expect(workflow).toContain(
      'node scripts/verify-computer-use-acceptance-build.mjs --expect present',
    );
  });

  it('publishes nothing and keeps the artifact short-lived', () => {
    expect(workflow).toContain('name: computer-use-acceptance-windows-x64');
    expect(workflow).toContain('retention-days: 3');
    expect(workflow).not.toContain('sprint-coder-windows');
    expect(workflow).not.toContain('attest-build-provenance');
    expect(workflow).not.toContain('gh release');
    expect(workflow).not.toContain('softprops/action-gh-release');
    expect(workflow).not.toContain('git tag');
  });
});

describe('Computer Use acceptance build release isolation', () => {
  it('never enables the acceptance mode in the release or CI workflows', () => {
    expect(releaseWorkflow).not.toContain(COMPUTER_USE_ACCEPTANCE_BUILD_ENV);
    expect(ciWorkflow).not.toContain(COMPUTER_USE_ACCEPTANCE_BUILD_ENV);
  });

  it('proves every release packaging job produced no acceptance build', () => {
    const scans = releaseWorkflow.match(
      /node scripts\/verify-computer-use-acceptance-build\.mjs --expect absent/gu,
    );
    // macOS, Ubuntu and unsigned Windows share the `make` matrix; `make-windows-signed` is separate.
    expect(scans).toHaveLength(2);
    expect(releaseWorkflow.match(/SPRINT_CODER_RELEASE: '1'/gu)).toHaveLength(4);
  });
});
