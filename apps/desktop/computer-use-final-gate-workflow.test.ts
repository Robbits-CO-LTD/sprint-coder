import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

type EvidenceRow = {
  id: string;
  status: string;
  reasonCode: string;
  evidenceCode: string;
};

type EvidenceTemplate = {
  schemaVersion: number;
  sourceCommit: string;
  sourceRunId: string;
  completedAt: string;
  artifacts: {
    windows: {
      sourceCommit: string;
      sourceRunId: string;
      artifactName: string;
      portable: { fileName: string; sha256: string };
      installer: { fileName: string; sha256: string };
    };
    macos: {
      sourceCommit: string;
      sourceRunId: string;
      artifactName: string;
      packageSha256: string;
    };
  };
  harnessAttestation: {
    workflowPath: string;
    workflowRunId: string;
    workflowRunAttempt: number;
    journeySetSha256: string;
    transcriptSha256: string;
  };
  machineTranscript: {
    schemaVersion: number;
    journeys: Array<{
      id: string;
      eventSequence: string[];
      eventDigests: string[];
      eventSequenceSha256: string;
    }>;
  };
  providerBinding: Record<string, boolean | number | string>;
  privacy: Record<string, boolean>;
  ac28Core: EvidenceRow[];
  ac29Safety: EvidenceRow[];
  ac30Compatibility: EvidenceRow[];
};

type CanonicalJourneys = {
  core: Array<{ id: string; passEvidenceCode: string; pendingEvidenceCode: string }>;
  safety: Array<{ id: string; passEvidenceCode: string; pendingEvidenceCode: string }>;
  compatibility: Array<{ id: string }>;
};

const repositoryRoot = resolve(__dirname, '../..');
const workflow = readFileSync(
  resolve(repositoryRoot, '.github/workflows/computer-use-final-gate.yml'),
  'utf8',
);
const evidenceWorkflowPath = resolve(
  repositoryRoot,
  '.github/workflows/computer-use-evidence-harness.yml',
);
const evidenceWorkflow = existsSync(evidenceWorkflowPath)
  ? readFileSync(evidenceWorkflowPath, 'utf8')
  : '';
const documentation = readFileSync(
  resolve(repositoryRoot, 'tasks/issue-333-computer-use-final-gate.md'),
  'utf8',
);
const templatePath = resolve(
  repositoryRoot,
  'tasks/evidence/issue-333-computer-use-final-gate-template.json',
);
const templateBytes = readFileSync(templatePath);
const template = JSON.parse(templateBytes.toString('utf8')) as EvidenceTemplate;
const validatorPath = resolve(repositoryRoot, 'verify-computer-use-final-gate.mjs');
const generatorPath = resolve(repositoryRoot, 'generate-computer-use-final-gate-evidence.mjs');
const validatorUrl = pathToFileURL(validatorPath).href;
const canonical = JSON.parse(
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `import { COMPUTER_USE_CORE_JOURNEYS as core, COMPUTER_USE_SAFETY_JOURNEYS as safety, COMPUTER_USE_COMPATIBILITY_JOURNEYS as compatibility } from ${JSON.stringify(validatorUrl)}; process.stdout.write(JSON.stringify({ core, safety, compatibility }));`,
    ],
    { encoding: 'utf8' },
  ),
) as CanonicalJourneys;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalEventSequence(id: string, status: string): string[] {
  const prefix = ['JOURNEY_STARTED', 'PACKAGE_BOUND'];
  if (status === 'SKIP') return [...prefix, 'UNSUPPORTED_BOUNDARY_RECORDED', 'JOURNEY_FINISHED'];
  let observations: string[];
  if (id.startsWith('AC-28-PROVIDER-'))
    observations = ['PROVIDER_BINDING_RECORDED', 'PROVIDER_RESULT_RECORDED'];
  else if (id.startsWith('AC-28-'))
    observations = ['TARGET_IDENTITY_RECORDED', 'OBSERVATION_RECORDED', 'ACTION_RESULT_RECORDED'];
  else if (id === 'AC-29-PRIVACY-NONPERSISTENCE') observations = ['PERSISTENCE_SURFACES_SCANNED'];
  else if (id === 'AC-29-UNSIGNED-WINDOWS-FAIL-CLOSED' || id === 'AC-29-ADHOC-MACOS-FAIL-CLOSED')
    observations = ['CAPABILITY_PROBE_RECORDED'];
  else if (id.startsWith('AC-29-'))
    observations = [
      'OBSERVATION_RECORDED',
      'GUARD_DECISION_RECORDED',
      'NATIVE_INPUT_COUNT_RECORDED',
    ];
  else observations = ['COMPATIBILITY_PROBE_RECORDED'];
  return [
    ...prefix,
    ...observations,
    status === 'PASS' ? 'ASSERTION_PASSED' : 'ASSERTION_FAILED',
    'JOURNEY_FINISHED',
  ];
}

function passingEvidence(): EvidenceTemplate {
  const result = structuredClone(template);
  result.sourceCommit = 'a'.repeat(40);
  result.sourceRunId = '1234';
  result.artifacts.windows = {
    sourceCommit: result.sourceCommit,
    sourceRunId: result.sourceRunId,
    artifactName: 'signed-windows',
    portable: {
      fileName: 'Sprint-Coder-win32-x64-0.0.0.zip',
      sha256: 'b'.repeat(64),
    },
    installer: { fileName: 'Sprint-Coder-Installer.exe', sha256: '3'.repeat(64) },
  };
  result.artifacts.macos = {
    sourceCommit: result.sourceCommit,
    sourceRunId: result.sourceRunId,
    artifactName: 'notarized-macos',
    packageSha256: 'c'.repeat(64),
  };
  Object.assign(result.providerBinding, {
    connectionIdDigest: 'd'.repeat(64),
    modelIdDigest: 'e'.repeat(64),
    endpointDigest: 'f'.repeat(64),
    catalogDigest: '1'.repeat(64),
    policyEpoch: 7,
    adapterVersion: 'computer-use-v1',
    sessionIdDigest: '2'.repeat(64),
    selectedFromCurrentTask: true,
    bindingStable: true,
    preflightAttempts: 1,
    preflightPassed: true,
    roundsAttempted: 3,
    roundsCompleted: 3,
    isOpenRouter: false,
    fallbackUsed: false,
    credentialChanged: false,
  });
  for (const key of Object.keys(result.privacy)) result.privacy[key] = true;
  result.ac28Core = canonical.core.map(({ id, passEvidenceCode }) => ({
    id,
    status: 'PASS',
    reasonCode: 'NONE',
    evidenceCode: passEvidenceCode,
  }));
  result.ac29Safety = canonical.safety.map(({ id, passEvidenceCode }) => ({
    id,
    status: 'PASS',
    reasonCode: 'NONE',
    evidenceCode: passEvidenceCode,
  }));
  result.ac30Compatibility[3] = {
    id: 'AC-30-PROVIDER-STRUCTURED',
    status: 'PASS',
    reasonCode: 'NONE',
    evidenceCode: 'PROVIDER_STRUCTURED_SCHEMA_V1',
  };
  result.ac30Compatibility[4] = {
    id: 'AC-30-PROVIDER-JSON',
    status: 'SKIP',
    reasonCode: 'PROVIDER_PATH_NOT_SELECTED',
    evidenceCode: 'PROVIDER_JSON_NOT_SELECTED_V1',
  };
  const rows = [...result.ac28Core, ...result.ac29Safety, ...result.ac30Compatibility];
  const packageBindingSha256 = sha256(
    JSON.stringify({
      sourceCommit: result.sourceCommit,
      sourceRunId: result.sourceRunId,
      artifacts: result.artifacts,
    }),
  );
  result.machineTranscript.journeys = rows.map(({ id, status }) => {
    const eventSequence = canonicalEventSequence(id, status);
    const eventDigests = eventSequence.map((event, index) => sha256(`${id}:${event}:${index}`));
    eventDigests[eventSequence.indexOf('PACKAGE_BOUND')] = packageBindingSha256;
    return {
      id,
      eventSequence,
      eventDigests,
      eventSequenceSha256: sha256(JSON.stringify({ id, eventSequence, eventDigests })),
    };
  });
  result.harnessAttestation = {
    workflowPath: '.github/workflows/computer-use-evidence-harness.yml',
    workflowRunId: '5678',
    workflowRunAttempt: 1,
    journeySetSha256: JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `import { COMPUTER_USE_JOURNEY_SET_SHA256 as digest } from ${JSON.stringify(validatorUrl)}; process.stdout.write(JSON.stringify(digest));`,
        ],
        { encoding: 'utf8' },
      ),
    ) as string,
    transcriptSha256: sha256(JSON.stringify(result.machineTranscript.journeys)),
  };
  return result;
}

function validateFixture(
  candidate: EvidenceTemplate,
  extraArguments: string[] = [],
  attestationVerified = true,
) {
  const root = mkdtempSync(resolve(tmpdir(), 'sprint-coder-cu-final-gate-'));
  const path = resolve(root, 'computer-use-final-gate.json');
  try {
    writeFileSync(path, `${JSON.stringify(candidate)}\n`, { encoding: 'utf8', mode: 0o600 });
    return spawnSync(
      process.execPath,
      [
        validatorPath,
        '--evidence',
        path,
        ...(attestationVerified ? ['--trusted-workflow-attestation-verified'] : []),
        ...extraArguments,
      ],
      { encoding: 'utf8' },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('Computer Use external final gate', () => {
  it('binds the portable ZIP and installer independently and rejects stale installer substitution', () => {
    expect(workflow).toContain('portable_sha256:');
    expect(workflow).toContain('installer_sha256:');
    expect(workflow).toContain('--windows-portable-sha256 "${WINDOWS_PORTABLE_SHA256}"');
    expect(workflow).toContain('--windows-installer-sha256 "${WINDOWS_INSTALLER_SHA256}"');

    const staleInstaller = passingEvidence();
    const installerResult = validateFixture(staleInstaller, [
      '--windows-installer-sha256',
      '4'.repeat(64),
    ]);
    expect(installerResult.status).not.toBe(0);
    expect(installerResult.stderr).toContain('Windows installer SHA-256');

    const stalePortable = passingEvidence();
    const portableResult = validateFixture(stalePortable, [
      '--windows-portable-sha256',
      '5'.repeat(64),
    ]);
    expect(portableResult.status).not.toBe(0);
    expect(portableResult.stderr).toContain('Windows portable SHA-256');

    const wrongRun = passingEvidence();
    wrongRun.artifacts.windows.sourceRunId = '9999';
    const runResult = validateFixture(wrongRun);
    expect(runResult.status).not.toBe(0);
    expect(runResult.stderr).toContain('artifacts.windows.sourceRunId must match sourceRunId');

    const staleTranscript = passingEvidence();
    const firstJourney = staleTranscript.machineTranscript.journeys[0]!;
    firstJourney.eventDigests[1] = '6'.repeat(64);
    firstJourney.eventSequenceSha256 = sha256(
      JSON.stringify({
        id: firstJourney.id,
        eventSequence: firstJourney.eventSequence,
        eventDigests: firstJourney.eventDigests,
      }),
    );
    staleTranscript.harnessAttestation.transcriptSha256 = sha256(
      JSON.stringify(staleTranscript.machineTranscript.journeys),
    );
    const transcriptResult = validateFixture(staleTranscript);
    expect(transcriptResult.status).not.toBe(0);
    expect(transcriptResult.stderr).toContain('PACKAGE_BOUND digest is stale');
  });

  it('rejects hand-authored all-PASS JSON without a trusted harness transcript attestation', () => {
    expect(existsSync(evidenceWorkflowPath)).toBe(true);
    expect(evidenceWorkflow).toContain('actions/attest-build-provenance@');
    expect(evidenceWorkflow).toContain('seal-evidence:');
    expect(evidenceWorkflow).toContain('runs-on: ubuntu-latest');
    expect(workflow).toContain('gh attestation verify');
    expect(workflow).toContain('.github/workflows/computer-use-evidence-harness.yml');
    expect(workflow).toContain('--source-digest "${SOURCE_COMMIT}"');
    expect(workflow).toContain('--deny-self-hosted-runners');
    expect(workflow).toContain("evidence_path=\"$(jq -r '.path'");
    expect(workflow).toContain('--evidence-run-attempt "${EVIDENCE_RUN_ATTEMPT}"');
    expect(workflow).toContain('--trusted-workflow-attestation-verified');

    const handAuthored = passingEvidence();
    const result = validateFixture(handAuthored, [], false);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('external GitHub artifact attestation verification');
  });

  it('refuses synthetic PASS capture and can only seal incomplete CLOSE_HOLD evidence', () => {
    const expected = passingEvidence();
    const root = mkdtempSync(resolve(tmpdir(), 'sprint-coder-cu-harness-'));
    const capturePath = resolve(root, 'computer-use-machine-transcript.json');
    const outputPath = resolve(root, 'computer-use-final-gate.json');
    const rows = [...expected.ac28Core, ...expected.ac29Safety, ...expected.ac30Compatibility];
    const passingCapture = {
      schemaVersion: 1,
      completedAt: expected.completedAt,
      providerBinding: expected.providerBinding,
      privacy: expected.privacy,
      journeys: rows.map((row, index) => ({
        ...row,
        eventSequence: expected.machineTranscript.journeys[index]!.eventSequence,
        eventDigests: expected.machineTranscript.journeys[index]!.eventDigests,
      })),
    };
    const generatorArguments = [
      generatorPath,
      '--capture',
      capturePath,
      '--output',
      outputPath,
      '--source-commit',
      expected.sourceCommit,
      '--source-run-id',
      expected.sourceRunId,
      '--windows-artifact',
      expected.artifacts.windows.artifactName,
      '--windows-portable-name',
      expected.artifacts.windows.portable.fileName,
      '--windows-portable-sha256',
      expected.artifacts.windows.portable.sha256,
      '--windows-installer-name',
      expected.artifacts.windows.installer.fileName,
      '--windows-installer-sha256',
      expected.artifacts.windows.installer.sha256,
      '--macos-artifact',
      expected.artifacts.macos.artifactName,
      '--macos-sha256',
      expected.artifacts.macos.packageSha256,
      '--workflow-run-id',
      expected.harnessAttestation.workflowRunId,
      '--workflow-run-attempt',
      String(expected.harnessAttestation.workflowRunAttempt),
    ];
    try {
      writeFileSync(capturePath, `${JSON.stringify(passingCapture)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      const refused = spawnSync(process.execPath, generatorArguments, { encoding: 'utf8' });
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain(
        'real runtime journey capture is not implemented; Core/Safety PASS evidence cannot be sealed',
      );

      const incompleteRows = [
        ...template.ac28Core,
        ...template.ac29Safety,
        ...template.ac30Compatibility,
      ];
      const incompleteCapture = {
        schemaVersion: 1,
        completedAt: template.completedAt,
        providerBinding: template.providerBinding,
        privacy: template.privacy,
        journeys: incompleteRows.map((row) => {
          const eventSequence = canonicalEventSequence(row.id, row.status);
          return {
            ...row,
            eventSequence,
            eventDigests: eventSequence.map((event, index) =>
              sha256(`${row.id}:${event}:${index}`),
            ),
          };
        }),
      };
      writeFileSync(capturePath, `${JSON.stringify(incompleteCapture)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      const generated = spawnSync(process.execPath, generatorArguments, { encoding: 'utf8' });
      expect(generated.status, generated.stderr).toBe(0);
      const sealed = JSON.parse(readFileSync(outputPath, 'utf8')) as EvidenceTemplate;
      expect(sealed.ac28Core.every(({ status }) => status === 'FAIL')).toBe(true);
      expect(
        spawnSync(
          process.execPath,
          [validatorPath, '--evidence', outputPath, '--allow-incomplete'],
          { encoding: 'utf8' },
        ).status,
      ).toBe(0);
      expect(
        spawnSync(
          process.execPath,
          [validatorPath, '--evidence', outputPath, '--trusted-workflow-attestation-verified'],
          { encoding: 'utf8' },
        ).status,
      ).not.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is manual-only and requires explicit signed package and bounded evidence artifacts', () => {
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).not.toContain('pull_request:');
    expect(workflow).not.toContain('push:');
    expect(workflow).toContain('signed_windows_artifact:');
    expect(workflow).toContain('notarized_macos_artifact:');
    expect(workflow).toContain('evidence_artifact:');
    expect(workflow).toContain('confirm_external_gate:');
    expect(workflow).toContain('schema-v3 machine transcript');
    expect(workflow).toContain('run-id: ${{ inputs.package_run_id }}');
    expect(workflow).toContain('run-id: ${{ inputs.evidence_run_id }}');
    expect(workflow).toContain('Evidence and package runs must use the same source commit.');
  });

  it('uses platform final-gate runners and verifies package trust before evidence', () => {
    expect(workflow).toContain('runs-on: [self-hosted, windows, x64, computer-use-final-gate]');
    expect(workflow).toContain('runs-on: [self-hosted, macOS, computer-use-final-gate]');
    expect(workflow).toContain('Get-AuthenticodeSignature');
    expect(workflow).toContain('/usr/bin/xcrun stapler validate');
    expect(workflow).toContain('/usr/bin/codesign --verify --deep --strict');
    expect(workflow).toContain('/usr/bin/lipo -archs');
    expect(workflow).toContain('Setup Node.js for strict manifest validation');
    expect(workflow).toContain('has unexpected keys');
    expect(workflow).toContain('nativeVersion is invalid');
    expect(workflow).toContain('App and native module TeamIdentifier differ.');
    expect(workflow).toContain('$helperProbe.sourceCommit -ne $env:SOURCE_COMMIT');
    expect(workflow).toContain(
      'Signed macOS Computer Use source commit does not match the package run.',
    );
    expect(workflow).toContain('Native manifest contains an unknown capability.');
    expect(workflow).toContain('Native manifest capabilities are duplicated.');
    expect(workflow).toContain('node verify-computer-use-final-gate.mjs --self-test');
    expect(workflow).toContain('--windows-portable-sha256 "${WINDOWS_PORTABLE_SHA256}"');
    expect(workflow).toContain('--windows-installer-sha256 "${WINDOWS_INSTALLER_SHA256}"');
    expect(workflow).toContain('--macos-sha256 "${MACOS_SHA256}"');
  });

  it('does not receive Provider credentials or upload raw acceptance output', () => {
    expect(workflow).not.toContain('secrets.');
    expect(evidenceWorkflow).not.toContain('secrets.');
    expect(workflow).not.toMatch(/[A-Z][A-Z0-9_]*_API_KEY/u);
    expect(evidenceWorkflow).not.toMatch(/[A-Z][A-Z0-9_]*_API_KEY/u);
    expect(workflow).not.toContain('upload-artifact');
    expect(evidenceWorkflow).toContain('--validate-capture-only');
    expect(evidenceWorkflow.indexOf('--validate-capture-only')).toBeLessThan(
      evidenceWorkflow.indexOf('Upload bounded machine transcript for trusted sealing'),
    );
    expect(workflow).toContain('Evidence artifact must contain only computer-use-final-gate.json.');
    expect(documentation).toContain(
      'No endpoint, credential, model, or adapter fallback is allowed.',
    );
    expect(documentation).toContain('Do not upload screenshots');
    expect(templateBytes.byteLength).toBeLessThanOrEqual(64 * 1024);
  });

  it('uses the exact complete ordered Core, Safety, and Compatibility journey sets', () => {
    expect(template.schemaVersion).toBe(3);
    expect(template.ac28Core.map(({ id }) => id)).toEqual(canonical.core.map(({ id }) => id));
    expect(template.ac29Safety.map(({ id }) => id)).toEqual(canonical.safety.map(({ id }) => id));
    expect(template.ac30Compatibility.map(({ id }) => id)).toEqual(
      canonical.compatibility.map(({ id }) => id),
    );
    expect(template.ac28Core).toHaveLength(20);
    expect(template.ac29Safety).toHaveLength(28);
    expect(template.ac30Compatibility).toHaveLength(9);
    const requiredPassCodes = [...canonical.core, ...canonical.safety].map(
      ({ passEvidenceCode }) => passEvidenceCode,
    );
    expect(new Set(requiredPassCodes).size).toBe(48);
    expect(template.ac30Compatibility.at(-1)).toEqual({
      id: 'AC-30-HARD-BOUNDARY-POLICY-LANGUAGE',
      status: 'SKIP',
      reasonCode: 'UNSUPPORTED_POLICY_LANGUAGE_DOCUMENTED',
      evidenceCode: 'OTHER_UI_LANGUAGES_UNSUPPORTED_V1',
    });
    expect(documentation).toContain('English and Japanese');
    expect(documentation).toContain('`supervised` or `observe_only`');
    for (const { id, passEvidenceCode } of [...canonical.core, ...canonical.safety]) {
      expect(documentation).toContain(`\`${id}\``);
      expect(documentation).toContain(`\`${passEvidenceCode}\``);
    }
  });

  it('never represents missing Core or Safety evidence as SKIP or generic self-attestation', () => {
    expect(
      template.ac28Core.every(
        (row, index) =>
          row.status === 'FAIL' &&
          row.reasonCode === 'EXTERNAL_GATE_NOT_RUN' &&
          row.evidenceCode === canonical.core[index]?.pendingEvidenceCode,
      ),
    ).toBe(true);
    expect(
      template.ac29Safety.every(
        (row, index) =>
          row.status === 'FAIL' &&
          row.reasonCode === 'EXTERNAL_GATE_NOT_RUN' &&
          row.evidenceCode === canonical.safety[index]?.pendingEvidenceCode,
      ),
    ).toBe(true);
    expect(
      template.ac30Compatibility
        .filter((row) => row.status === 'SKIP')
        .every((row) => row.reasonCode !== 'NONE'),
    ).toBe(true);
    expect(documentation).toContain('Core and Safety never accept `SKIP`');

    const valid = passingEvidence();
    expect(validateFixture(valid).status).toBe(0);
    valid.ac29Safety[0]!.evidenceCode = 'SELF_ATTESTED_PASS';
    const rejected = validateFixture(valid);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain(
      'PASS must use evidenceCode SAME_OWNER_DIALOG_INVALIDATION_V1',
    );
  });

  it('self-tests strict provider and journey bindings and keeps the template incomplete', () => {
    expect(
      execFileSync(process.execPath, [validatorPath, '--self-test'], { encoding: 'utf8' }),
    ).toContain('self-test passed');
    expect(
      execFileSync(
        process.execPath,
        [validatorPath, '--evidence', templatePath, '--allow-incomplete'],
        { encoding: 'utf8' },
      ),
    ).toContain('"corePassed":false');
    expect(
      spawnSync(process.execPath, [validatorPath, '--evidence', templatePath], {
        encoding: 'utf8',
      }).status,
    ).not.toBe(0);
  });

  it('rejects pending adapter provenance and two simultaneously selected Provider paths', () => {
    const pendingAdapter = passingEvidence();
    pendingAdapter.providerBinding['adapterVersion'] = 'PENDING';
    const rejectedAdapter = validateFixture(pendingAdapter);
    expect(rejectedAdapter.status).not.toBe(0);
    expect(rejectedAdapter.stderr).toContain(
      'providerBinding.adapterVersion must be computer-use-v1',
    );

    const ambiguousPath = passingEvidence();
    ambiguousPath.ac30Compatibility[4] = {
      id: 'AC-30-PROVIDER-JSON',
      status: 'PASS',
      reasonCode: 'NONE',
      evidenceCode: 'PROVIDER_BOUNDED_JSON_V1',
    };
    const rejectedPath = validateFixture(ambiguousPath);
    expect(rejectedPath.status).not.toBe(0);
    expect(rejectedPath.stderr).toContain('exactly one Provider compatibility path must PASS');
  });
});
