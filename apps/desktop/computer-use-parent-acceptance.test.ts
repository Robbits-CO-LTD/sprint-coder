import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import template from '../../tasks/evidence/issue-333-computer-use-final-gate-template.json';

type Journey = { id: string; passEvidenceCode: string };
type TranscriptRow = {
  id: string;
  eventSequence: string[];
  eventDigests: string[];
  eventSequenceSha256: string;
};
type Evidence = Omit<typeof template, 'machineTranscript'> & {
  machineTranscript: { schemaVersion: number; journeys: TranscriptRow[] };
};
type Verifier = {
  COMPUTER_USE_CORE_JOURNEYS: Journey[];
  COMPUTER_USE_SAFETY_JOURNEYS: Journey[];
  COMPUTER_USE_JOURNEY_SET_SHA256: string;
  validateComputerUseFinalGateEvidence: (
    evidence: unknown,
    bindings?: Record<string, string | number | boolean>,
  ) => { corePassed: boolean; safetyPassed: boolean };
};
const root = resolve(__dirname, '../..');
const validatorPath = resolve(root, 'verify-computer-use-final-gate.mjs');
let verifier: Verifier;
beforeAll(async () => {
  verifier = await import(pathToFileURL(validatorPath).href);
});
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Deliberately synthetic schema input. This does not assert a real runtime observation,
// signature, Provider call, or attestation and must never be emitted as acceptance evidence.
function syntheticEvidence(): Evidence {
  const result: Evidence = structuredClone(template);
  result.sourceCommit = 'a'.repeat(40);
  result.sourceRunId = '1234';
  Object.assign(result.artifacts.windows, {
    sourceCommit: result.sourceCommit,
    sourceRunId: result.sourceRunId,
    portable: { fileName: 'test-portable.zip', sha256: 'b'.repeat(64) },
    installer: { fileName: 'test-installer.exe', sha256: 'c'.repeat(64) },
  });
  Object.assign(result.artifacts.macos, {
    sourceCommit: result.sourceCommit,
    sourceRunId: result.sourceRunId,
    packageSha256: 'd'.repeat(64),
  });
  Object.assign(result.providerBinding, {
    connectionIdDigest: 'e'.repeat(64),
    modelIdDigest: 'f'.repeat(64),
    endpointDigest: '1'.repeat(64),
    catalogDigest: '2'.repeat(64),
    sessionIdDigest: '3'.repeat(64),
    adapterVersion: 'computer-use-v1',
    selectedFromCurrentTask: true,
    bindingStable: true,
    preflightAttempts: 1,
    preflightPassed: true,
    roundsAttempted: 3,
    roundsCompleted: 3,
  });
  for (const key of Object.keys(result.privacy) as Array<keyof Evidence['privacy']>)
    result.privacy[key] = true;
  const passingRow = ({ id, passEvidenceCode }: Journey) => ({
    id,
    status: 'PASS',
    reasonCode: 'NONE',
    evidenceCode: passEvidenceCode,
  });
  result.ac28Core = verifier.COMPUTER_USE_CORE_JOURNEYS.map(passingRow);
  result.ac29Safety = verifier.COMPUTER_USE_SAFETY_JOURNEYS.map(passingRow);
  result.ac30Compatibility = result.ac30Compatibility.map((row) =>
    row.id === 'AC-30-PROVIDER-STRUCTURED'
      ? {
          ...row,
          status: 'PASS',
          reasonCode: 'NONE',
          evidenceCode: 'PROVIDER_STRUCTURED_SCHEMA_V1',
        }
      : row.id === 'AC-30-PROVIDER-JSON'
        ? {
            ...row,
            status: 'SKIP',
            reasonCode: 'PROVIDER_PATH_NOT_SELECTED',
            evidenceCode: 'PROVIDER_JSON_NOT_SELECTED_V1',
          }
        : row,
  );
  const packageDigest = digest({
    sourceCommit: result.sourceCommit,
    sourceRunId: result.sourceRunId,
    artifacts: result.artifacts,
  });
  result.machineTranscript.journeys = [
    ...result.ac28Core,
    ...result.ac29Safety,
    ...result.ac30Compatibility,
  ].map(({ id, status }) => {
    const events = id.startsWith('AC-28-PROVIDER-')
      ? ['PROVIDER_BINDING_RECORDED', 'PROVIDER_RESULT_RECORDED']
      : id.startsWith('AC-28-')
        ? ['TARGET_IDENTITY_RECORDED', 'OBSERVATION_RECORDED', 'ACTION_RESULT_RECORDED']
        : id === 'AC-29-PRIVACY-NONPERSISTENCE'
          ? ['PERSISTENCE_SURFACES_SCANNED']
          : /AC-29-(UNSIGNED-WINDOWS|ADHOC-MACOS)-FAIL-CLOSED/u.test(id)
            ? ['CAPABILITY_PROBE_RECORDED']
            : id.startsWith('AC-29-')
              ? ['OBSERVATION_RECORDED', 'GUARD_DECISION_RECORDED', 'NATIVE_INPUT_COUNT_RECORDED']
              : ['COMPATIBILITY_PROBE_RECORDED'];
    const eventSequence = [
      'JOURNEY_STARTED',
      'PACKAGE_BOUND',
      ...(status === 'SKIP'
        ? ['UNSUPPORTED_BOUNDARY_RECORDED']
        : [...events, status === 'PASS' ? 'ASSERTION_PASSED' : 'ASSERTION_FAILED']),
      'JOURNEY_FINISHED',
    ];
    const eventDigests = eventSequence.map((event) =>
      event === 'PACKAGE_BOUND' ? packageDigest : digest({ id, event }),
    );
    return {
      id,
      eventSequence,
      eventDigests,
      eventSequenceSha256: digest({ id, eventSequence, eventDigests }),
    };
  });
  Object.assign(result.harnessAttestation, {
    workflowRunId: '5678',
    workflowRunAttempt: 1,
    journeySetSha256: verifier.COMPUTER_USE_JOURNEY_SET_SHA256,
    transcriptSha256: digest(result.machineTranscript.journeys),
  });
  return result;
}

function validate(candidate: unknown) {
  return verifier.validateComputerUseFinalGateEvidence(candidate, {
    expectedSourceCommit: 'a'.repeat(40),
    expectedSourceRunId: '1234',
    expectedEvidenceRunId: '5678',
    expectedEvidenceRunAttempt: 1,
    expectedWindowsArtifact: template.artifacts.windows.artifactName,
    expectedMacosArtifact: template.artifacts.macos.artifactName,
    expectedWindowsPortableName: 'test-portable.zip',
    expectedWindowsPortableSha256: 'b'.repeat(64),
    expectedWindowsInstallerName: 'test-installer.exe',
    expectedWindowsInstallerSha256: 'c'.repeat(64),
    expectedMacosSha256: 'd'.repeat(64),
  });
}

describe('Issue #333 parent acceptance dependency integration', () => {
  it('checks the synthetic schema baseline without treating it as externally verified evidence', () => {
    expect(validate(syntheticEvidence())).toMatchObject({ corePassed: false, safetyPassed: false });
    const pending = verifier.validateComputerUseFinalGateEvidence(template, {
      allowIncomplete: true,
    });
    expect(pending).toMatchObject({ corePassed: false, safetyPassed: false });
    const withoutAttestation = spawnSync(
      process.execPath,
      [
        validatorPath,
        '--evidence',
        resolve(root, 'tasks/evidence/issue-333-computer-use-final-gate-template.json'),
      ],
      { encoding: 'utf8' },
    );
    expect(withoutAttestation.status).not.toBe(0);
    expect(withoutAttestation.stderr).toContain(
      'external GitHub artifact attestation verification',
    );
  });

  it('requires #388 evidence even when #387 package/device rows claim PASS', () => {
    const candidate = syntheticEvidence();
    candidate.providerBinding = structuredClone(template.providerBinding);
    expect(() => validate(candidate)).toThrow('providerBinding.');
  });

  it.each(['windows', 'macos'] as const)(
    'requires #387 %s package evidence even when #388 Provider rows claim PASS',
    (platform) => {
      const candidate = syntheticEvidence();
      candidate.artifacts[platform].sourceCommit = '0'.repeat(40);
      expect(() => validate(candidate)).toThrow(`artifacts.${platform}.sourceCommit must match`);
    },
  );

  it.each(['ac28Core', 'ac29Safety'] as const)(
    'rejects each mandatory %s journey left FAIL or SKIP while all others claim PASS',
    (table) => {
      const complete = syntheticEvidence();
      for (const [index, row] of complete[table].entries()) {
        for (const status of ['FAIL', 'SKIP']) {
          const candidate = structuredClone(complete);
          candidate[table][index] = { ...row, status };
          expect(() => validate(candidate), `${row.id}: ${status}`).toThrow(
            'must PASS the final gate',
          );
        }
      }
    },
  );

  it('requires every privacy surface independently of device and Provider PASS labels', () => {
    const complete = syntheticEvidence();
    for (const field of Object.keys(complete.privacy) as Array<keyof Evidence['privacy']>) {
      const candidate = structuredClone(complete);
      candidate.privacy[field] = false;
      expect(() => validate(candidate)).toThrow(`privacy.${field} must be true`);
      const { [field]: omitted, ...remaining } = complete.privacy;
      expect(omitted).toBe(true);
      expect(() => validate({ ...complete, privacy: remaining })).toThrow(
        'privacy keys must be exactly',
      );
    }
  });

  it.each([
    ['preflightAttempts', 0],
    ['preflightAttempts', 2],
    ['preflightPassed', false],
    ['roundsAttempted', 2],
    ['roundsAttempted', 4],
    ['roundsCompleted', 2],
    ['roundsCompleted', 4],
    ['selectedFromCurrentTask', false],
    ['bindingStable', false],
    ['isOpenRouter', true],
    ['fallbackUsed', true],
    ['credentialChanged', true],
  ] as const)('rejects Provider %s=%s despite all-PASS journey labels', (field, value) => {
    const candidate = syntheticEvidence();
    Object.assign(candidate.providerBinding, { [field]: value });
    expect(() => validate(candidate)).toThrow(
      /providerBinding\.|exactly three attempted\/completed rounds/u,
    );
  });
});
