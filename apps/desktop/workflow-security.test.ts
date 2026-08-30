import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(__dirname, '../..');
const workflowFiles = [
  '.github/workflows/computer-use-final-gate.yml',
  '.github/workflows/computer-use-evidence-harness.yml',
  '.github/workflows/ci.yml',
  '.github/workflows/release-beta.yml',
] as const;

const workflows = Object.fromEntries(
  workflowFiles.map((file) => [file, readFileSync(resolve(repositoryRoot, file), 'utf8')]),
) as Record<(typeof workflowFiles)[number], string>;

const reviewedActionCommits: Record<string, string> = {
  'actions/checkout': '9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0',
  'actions/setup-node': '820762786026740c76f36085b0efc47a31fe5020',
  'actions/cache': '2c8a9bd7457de244a408f35966fab2fb45fda9c8',
  'actions/upload-artifact': 'bbbca2ddaa5d8feaa63e36b76fdaad77386f024f',
  'actions/download-artifact': '70fc10c6e5e1ce46ad2ea6f2b72d43f7d47b13c3',
  'actions/attest-build-provenance': '977bb373ede98d70efdf65b84cb5f73e068dcc2a',
  'ilammy/msvc-dev-cmd': '0b201ec74fa43914dc39ae48a89fd1d8cb592756',
};

function jobBlock(workflow: string, job: string): string {
  const header = `\n  ${job}:`;
  const start = workflow.indexOf(header);
  expect(start, `job ${job} must exist`).toBeGreaterThanOrEqual(0);
  const nextJob = /\n {2}[A-Za-z0-9_-]+:/gu.exec(workflow.slice(start + header.length));
  const next = nextJob ? start + header.length + nextJob.index : -1;
  return workflow.slice(start, next === -1 ? workflow.length : next);
}

function allJobBlocks(workflow: string): string[] {
  const starts = [...workflow.matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gmu)].map(
    (match) => match.index!,
  );
  return starts.map((start, index) => workflow.slice(start, starts[index + 1]));
}

describe('workflow security boundaries', () => {
  it('pins every third-party action to its reviewed immutable commit', () => {
    for (const [file, workflow] of Object.entries(workflows)) {
      const refs = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)@([^\s#]+)/gmu)];
      expect(refs.length, `${file} must contain action refs`).toBeGreaterThan(0);
      for (const match of refs) {
        const action = match[1]!;
        const ref = match[2]!;
        expect(reviewedActionCommits[action], `${file}: ${action}`).toBe(ref);
        expect(ref).toMatch(/^[0-9a-f]{40}$/u);
      }
    }
  });

  it('scopes permissions per job and protects artifact/attestation jobs', () => {
    for (const workflow of Object.values(workflows)) {
      expect(workflow).toMatch(/^permissions:\s*\{\}\s*$/mu);
      expect(workflow).not.toMatch(/^permissions:\s*\n(?: {2,}.+\n)+/mu);
      for (const block of allJobBlocks(workflow)) {
        if (/^\s+uses:/mu.test(block)) expect(block).toMatch(/^ {4}permissions:/mu);
      }
    }

    const finalGate = workflows['.github/workflows/computer-use-final-gate.yml'];
    for (const job of [
      'verify-evidence-attestation',
      'verify-windows-package',
      'verify-macos-package',
      'validate-evidence',
    ]) {
      expect(jobBlock(finalGate, job)).toContain('environment: computer-use-final-gate');
    }
    expect(jobBlock(finalGate, 'verify-evidence-attestation')).toContain('attestations: read');
    expect(jobBlock(finalGate, 'verify-evidence-attestation')).toContain('actions: read');
    expect(jobBlock(finalGate, 'verify-windows-package')).toContain(
      'needs: [validate-dispatch, verify-evidence-attestation]',
    );
    expect(finalGate.indexOf('gh attestation verify')).toBeLessThan(
      finalGate.indexOf('Assert-PeAmd64'),
    );
    const evidenceHarness = workflows['.github/workflows/computer-use-evidence-harness.yml'];
    for (const job of ['collect-transcript', 'seal-evidence']) {
      expect(jobBlock(evidenceHarness, job)).toContain('environment: computer-use-final-gate');
    }
  });

  it('does not let protected jobs run a candidate ref and binds package provenance', () => {
    const finalGate = workflows['.github/workflows/computer-use-final-gate.yml'];
    expect(finalGate).toContain('WORKFLOW_REF: ${{ github.ref }}');
    expect(finalGate).toContain('[[ "${WORKFLOW_REF}" == \'refs/heads/main\' ]]');
    expect(finalGate).toContain(
      '[[ "${package_path}" == \'.github/workflows/release-beta.yml\' ]]',
    );
    expect(finalGate).toContain('[[ "${package_event}" == \'push\' ]]');
    expect(finalGate).toContain("package_branch=\"$(jq -r '.head_branch' <<< \"${metadata}\")\"");
    expect(finalGate).toMatch(/package_branch.*\^v\[0-9\]/u);
    expect(finalGate).toContain(
      "evidence_branch=\"$(jq -r '.head_branch' <<< \"${evidence_metadata}\")\"",
    );
    expect(finalGate).not.toContain("jq -r '.ref'");
    expect(finalGate).toContain('[[ "${package_repository}" == "${GITHUB_REPOSITORY}" ]]');
    expect(finalGate).toContain('--signer-workflow');
    expect(finalGate).toContain('--source-digest "${SOURCE_COMMIT}"');
    expect(finalGate).toContain('--deny-self-hosted-runners');
    expect(finalGate).toContain('ref: ${{ github.sha }}');

    const evidenceHarness = workflows['.github/workflows/computer-use-evidence-harness.yml'];
    expect(evidenceHarness).toContain('WORKFLOW_REF: ${{ github.ref }}');
    expect(evidenceHarness).toContain('[[ "${WORKFLOW_REF}" == \'refs/heads/main\' ]]');
    expect(evidenceHarness).toContain(
      '[[ "${package_path}" == \'.github/workflows/release-beta.yml\' ]]',
    );
    expect(evidenceHarness).toContain('[[ "${package_event}" == \'push\' ]]');
    expect(evidenceHarness).toContain(
      "package_branch=\"$(jq -r '.head_branch' <<< \"${metadata}\")\"",
    );
    expect(evidenceHarness).toMatch(/package_branch.*\^v\[0-9\]/u);
    expect(evidenceHarness).not.toContain("jq -r '.ref'");
    expect(evidenceHarness).toContain('ref: ${{ github.sha }}');
  });

  it('checks the expected release signer and the actual Windows PE machine type before probing', () => {
    const finalGate = workflows['.github/workflows/computer-use-final-gate.yml'];
    expect(finalGate).toContain('EXPECTED_WINDOWS_SIGNER_THUMBPRINT');
    expect(finalGate).toContain('EXPECTED_WINDOWS_SIGNER_SUBJECT');
    expect(finalGate).toContain('EXPECTED_MACOS_TEAM_IDENTIFIER');
    expect(finalGate).toContain('SignerCertificate.Subject');
    expect(finalGate).toContain('function Assert-PeAmd64');
    expect(finalGate).toContain('0x8664');
    expect(finalGate).toContain(
      'foreach ($pePath in @($app[0].FullName, $helper[0].FullName))',
    );
    expect(finalGate).not.toContain(
      'foreach ($pePath in @($installer[0].FullName) + $portableExecutables)',
    );
    expect(finalGate.indexOf('Assert-PeAmd64')).toBeLessThan(finalGate.indexOf('--probe-json'));

    const release = workflows['.github/workflows/release-beta.yml'];
    const makeStart = release.indexOf('\n  make:');
    const releaseStart = release.indexOf('\n  release:');
    const make = release.slice(makeStart, releaseStart);
    expect(make.indexOf('Require configured protected macOS signing environment')).toBeLessThan(
      make.indexOf('uses: actions/checkout@'),
    );
    const publication = jobBlock(release, 'release');
    expect(publication).toContain('environment: release-publication');
    expect(publication).toContain('RELEASE_PUBLICATION_ENVIRONMENT_SENTINEL');
    expect(
      publication.indexOf('Require configured protected publication environment'),
    ).toBeLessThan(publication.indexOf('uses: actions/checkout@'));
  });

  it('provides a protected signed-Windows package source for the external gate', () => {
    const release = workflows['.github/workflows/release-beta.yml'];
    const signedWindows = jobBlock(release, 'make-windows-signed');
    expect(signedWindows).toContain(
      "if: ${{ vars.COMPUTER_USE_SIGNED_WINDOWS_GATE_ENABLED == 'true' }}",
    );
    expect(signedWindows).toContain('runs-on: windows-2022');
    expect(signedWindows).toContain('environment: windows-signing');
    expect(signedWindows).toContain('WINDOWS_SIGNING_ENVIRONMENT_SENTINEL');
    expect(signedWindows).toContain('SPRINT_CODER_WINDOWS_CERTIFICATE_FILE');
    expect(signedWindows).toContain('SPRINT_CODER_WINDOWS_CERTIFICATE_PASSWORD');
    expect(signedWindows).not.toContain('SPRINT_CODER_ALLOW_UNSIGNED_WINDOWS');
    expect(signedWindows).toContain('npm run make:windows');
    expect(signedWindows).toContain('Get-AuthenticodeSignature');
    const attestation = jobBlock(release, 'attest-computer-use-packages');
    expect(attestation).toContain('needs: [make, make-windows-signed]');
    expect(attestation).toContain('runs-on: ubuntu-latest');
    expect(attestation).toContain('environment: computer-use-final-gate');
    expect(attestation).toContain('actions/attest-build-provenance@');
    expect(attestation).toContain('id-token: write');
    expect(attestation).toContain('attestations: write');
    expect(attestation).toContain('subject-path:');
  });

  it('verifies package attestations before any final-gate package parsing or execution', () => {
    const finalGate = workflows['.github/workflows/computer-use-final-gate.yml'];
    for (const [job, firstUse] of [
      ['verify-windows-package', 'Expand-Archive'],
      ['verify-macos-package', 'hdiutil attach'],
    ] as const) {
      const block = jobBlock(finalGate, job);
      expect(block).toContain('attestations: read');
      expect(block).toContain('GH_TOKEN: ${{ github.token }}');
      expect(block).toContain('gh attestation verify');
      expect(block).toContain('.github/workflows/release-beta.yml');
      expect(block).toMatch(/--source-digest (?:"\$\{SOURCE_COMMIT\}"|\$env:SOURCE_COMMIT)/u);
      expect(block).toContain('--deny-self-hosted-runners');
      expect(block.indexOf('gh attestation verify')).toBeLessThan(block.indexOf(firstUse));
    }
  });
});
