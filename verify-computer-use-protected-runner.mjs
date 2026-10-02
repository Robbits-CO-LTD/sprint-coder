import { validateComputerUseFinalGateEvidence } from './verify-computer-use-final-gate.mjs';

function snapshot(value) {
  const copy = globalThis.structuredClone(value);
  function freeze(item) {
    if (item !== null && typeof item === 'object') {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
    return item;
  }
  return freeze(copy);
}

/**
 * Library-only assembly for the already trusted protected runner. Callbacks must measure facts
 * independently of the capture and verify every assertion; this adapter does not authenticate
 * callback implementations, manufacture closure proof, or replace workflow attestation.
 */
export async function verifyComputerUseProtectedRunnerEvidence(candidate, options = {}) {
  try {
    const {
      measureOwnedRunFacts,
      verifyParentAssertions,
      expectedSourceCommit,
      expectedWindowsPortableSha256,
      expectedMacosSha256,
      expectedSourceRunId,
      expectedEvidenceRunId,
      expectedEvidenceRunAttempt,
      expectedWindowsArtifact,
      expectedMacosArtifact,
      expectedWindowsPortableName,
      expectedWindowsInstallerName,
      expectedWindowsInstallerSha256,
      trustedWorkflowAttestationVerified = false,
      allowIncomplete = false,
    } = options;
    if (
      typeof measureOwnedRunFacts !== 'function' ||
      typeof verifyParentAssertions !== 'function' ||
      typeof expectedSourceCommit !== 'string' ||
      typeof expectedWindowsPortableSha256 !== 'string' ||
      typeof expectedMacosSha256 !== 'string' ||
      !/^(?!0{40}$)[a-f0-9]{40}$/u.test(expectedSourceCommit ?? '') ||
      !/^(?!0{64}$)[a-f0-9]{64}$/u.test(expectedWindowsPortableSha256 ?? '') ||
      !/^(?!0{64}$)[a-f0-9]{64}$/u.test(expectedMacosSha256 ?? '') ||
      typeof trustedWorkflowAttestationVerified !== 'boolean' ||
      typeof allowIncomplete !== 'boolean'
    )
      throw new Error();
    const evidence = snapshot(candidate);
    const release = snapshot({
      sourceCommit: expectedSourceCommit,
      sourceRunId: expectedSourceRunId,
      evidenceRunId: expectedEvidenceRunId,
      evidenceRunAttempt: expectedEvidenceRunAttempt,
      windowsArtifact: expectedWindowsArtifact,
      macosArtifact: expectedMacosArtifact,
      windowsPortableName: expectedWindowsPortableName,
      windowsInstallerName: expectedWindowsInstallerName,
      windowsInstallerSha256: expectedWindowsInstallerSha256,
      windowsPortableSha256: expectedWindowsPortableSha256,
      macosSha256: expectedMacosSha256,
    });
    const validation = {
      allowIncomplete,
      expectedSourceCommit,
      expectedWindowsPortableSha256,
      expectedMacosSha256,
      expectedSourceRunId,
      expectedEvidenceRunId,
      expectedEvidenceRunAttempt,
      expectedWindowsArtifact,
      expectedMacosArtifact,
      expectedWindowsPortableName,
      expectedWindowsInstallerName,
      expectedWindowsInstallerSha256,
    };
    // Validate untrusted evidence before giving its closure to the protected assertion collector.
    validateComputerUseFinalGateEvidence(evidence, validation);
    const windows = snapshot(await measureOwnedRunFacts('windows', snapshot(release)));
    const macos = snapshot(await measureOwnedRunFacts('macos', snapshot(release)));
    if (windows === null || windows === undefined || macos === null || macos === undefined)
      throw new Error();
    const verifiedClosureSha256 = await verifyParentAssertions(
      snapshot(evidence.parentClosure),
      snapshot(release),
    );
    if (
      typeof verifiedClosureSha256 !== 'string' ||
      !/^(?!0{64}$)[a-f0-9]{64}$/u.test(verifiedClosureSha256)
    )
      throw new Error();
    return validateComputerUseFinalGateEvidence(evidence, {
      ...validation,
      allowIncomplete,
      trustedWorkflowAttestationVerified,
      verifiedOwnedRunFacts: { windows, macos },
      verifiedClosureSha256,
    });
  } catch {
    // Never disclose callback errors, producer values or evidence fields.
    throw new Error('COMPUTER_USE_PROTECTED_RUNNER_VERIFICATION_FAILED');
  }
}
