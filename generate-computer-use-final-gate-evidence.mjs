import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  COMPUTER_USE_COMPATIBILITY_IDS,
  COMPUTER_USE_CORE_IDS,
  COMPUTER_USE_EVIDENCE_WORKFLOW,
  COMPUTER_USE_JOURNEY_SET_SHA256,
  COMPUTER_USE_SAFETY_IDS,
  COMPUTER_USE_TRANSCRIPT_SCHEMA_VERSION,
  computerUseEventSequenceSha256,
  computerUsePackageBindingSha256,
  computerUseTranscriptSha256,
  validateComputerUseFinalGateEvidence,
} from './verify-computer-use-final-gate.mjs';

const MAX_CAPTURE_BYTES = 64 * 1024;
const GENERATOR_BOOLEAN_OPTIONS = Object.freeze(['validate-capture-only']);
const GENERATOR_VALUE_OPTIONS = Object.freeze([
  'capture',
  'output',
  'source-commit',
  'source-run-id',
  'windows-artifact',
  'windows-portable-name',
  'windows-portable-sha256',
  'windows-installer-name',
  'windows-installer-sha256',
  'macos-artifact',
  'macos-sha256',
  'workflow-run-id',
  'workflow-run-attempt',
]);

function fail(message) {
  throw new Error(`Computer Use evidence harness refused capture: ${message}`);
}

function parseArguments(argv) {
  const options = Object.create(null);
  const booleanOptions = new Set(GENERATOR_BOOLEAN_OPTIONS);
  const valueOptions = new Set(GENERATOR_VALUE_OPTIONS);
  const knownOptions = new Set([...booleanOptions, ...valueOptions]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) fail(`unknown argument ${argument}`);
    const key = argument.slice(2);
    if (!knownOptions.has(key)) fail(`unknown option ${argument}`);
    if (Object.prototype.hasOwnProperty.call(options, key)) fail(`duplicate option ${argument}`);
    if (booleanOptions.has(key)) {
      options[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) fail(`${argument} requires a value`);
    options[key] = value;
    index += 1;
  }
  return options;
}

function exactKeys(value, expected, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail(`${path} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
    fail(`${path} keys must be exactly ${wanted.join(', ')}`);
}

function required(options, key) {
  const value = options[key];
  if (typeof value !== 'string' || value.length === 0) fail(`--${key} is required`);
  return value;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const capturePath = required(options, 'capture');
  const captureBytes = readFileSync(capturePath);
  if (captureBytes.length > MAX_CAPTURE_BYTES) fail(`capture exceeds ${MAX_CAPTURE_BYTES} bytes`);
  const capture = JSON.parse(captureBytes.toString('utf8'));
  exactKeys(
    capture,
    ['schemaVersion', 'completedAt', 'providerBinding', 'privacy', 'journeys'],
    'capture',
  );
  if (capture.schemaVersion !== COMPUTER_USE_TRANSCRIPT_SCHEMA_VERSION)
    fail(`capture.schemaVersion must be ${COMPUTER_USE_TRANSCRIPT_SCHEMA_VERSION}`);
  if (!Array.isArray(capture.journeys)) fail('capture.journeys must be an array');

  const allIds = [
    ...COMPUTER_USE_CORE_IDS,
    ...COMPUTER_USE_SAFETY_IDS,
    ...COMPUTER_USE_COMPATIBILITY_IDS,
  ];
  if (
    capture.journeys.length !== allIds.length ||
    capture.journeys.some((row, index) => row?.id !== allIds[index])
  )
    fail('capture.journeys must use the complete canonical order');

  const evidenceRows = capture.journeys.map((row, index) => {
    exactKeys(
      row,
      ['id', 'status', 'reasonCode', 'evidenceCode', 'eventSequence', 'eventDigests'],
      `capture.journeys[${index}]`,
    );
    if (
      !Array.isArray(row.eventSequence) ||
      !Array.isArray(row.eventDigests) ||
      row.eventSequence.some(
        (event) => typeof event !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(event),
      ) ||
      row.eventDigests.some(
        (eventDigest) => typeof eventDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(eventDigest),
      )
    )
      fail(`capture.journeys[${index}] events must contain only bounded codes and SHA-256 digests`);
    return {
      id: row.id,
      status: row.status,
      reasonCode: row.reasonCode,
      evidenceCode: row.evidenceCode,
    };
  });
  const mandatoryRows = evidenceRows.slice(
    0,
    COMPUTER_USE_CORE_IDS.length + COMPUTER_USE_SAFETY_IDS.length,
  );
  if (mandatoryRows.some(({ status }) => status === 'PASS'))
    fail(
      'real runtime journey capture is not implemented; Core/Safety PASS evidence cannot be sealed',
    );
  const validateCaptureOnly = options['validate-capture-only'] === true;
  if (
    validateCaptureOnly &&
    Object.keys(options).some((key) => key !== 'capture' && key !== 'validate-capture-only')
  )
    fail('--validate-capture-only accepts only --capture');
  const sourceCommit = validateCaptureOnly ? 'a'.repeat(40) : required(options, 'source-commit');
  const sourceRunId = validateCaptureOnly ? '1' : required(options, 'source-run-id');
  const artifacts = {
    windows: {
      sourceCommit,
      sourceRunId,
      artifactName: validateCaptureOnly
        ? 'capture-validation-windows'
        : required(options, 'windows-artifact'),
      portable: {
        fileName: validateCaptureOnly
          ? 'Sprint-Coder-win32-x64-validation.zip'
          : required(options, 'windows-portable-name'),
        sha256: validateCaptureOnly ? 'b'.repeat(64) : required(options, 'windows-portable-sha256'),
      },
      installer: {
        fileName: validateCaptureOnly
          ? 'Sprint-Coder-Installer.exe'
          : required(options, 'windows-installer-name'),
        sha256: validateCaptureOnly
          ? 'c'.repeat(64)
          : required(options, 'windows-installer-sha256'),
      },
    },
    macos: {
      sourceCommit,
      sourceRunId,
      artifactName: validateCaptureOnly
        ? 'capture-validation-macos'
        : required(options, 'macos-artifact'),
      packageSha256: validateCaptureOnly ? 'd'.repeat(64) : required(options, 'macos-sha256'),
    },
  };
  const packageBindingSha256 = computerUsePackageBindingSha256({
    sourceCommit,
    sourceRunId,
    artifacts,
  });
  const journeys = capture.journeys.map((row) => {
    const eventDigests = [...row.eventDigests];
    const packageEventIndex = row.eventSequence.indexOf('PACKAGE_BOUND');
    if (packageEventIndex < 0) fail(`${row.id} is missing canonical PACKAGE_BOUND`);
    if (!validateCaptureOnly && eventDigests[packageEventIndex] !== packageBindingSha256)
      fail(`${row.id} PACKAGE_BOUND digest does not match the computed package binding`);
    return {
      id: row.id,
      eventSequence: row.eventSequence,
      eventDigests,
      eventSequenceSha256: computerUseEventSequenceSha256(row.id, row.eventSequence, eventDigests),
    };
  });
  const evidence = {
    schemaVersion: 3,
    issue: 333,
    sourceCommit,
    sourceRunId,
    completedAt: capture.completedAt,
    artifacts,
    harnessAttestation: {
      workflowPath: COMPUTER_USE_EVIDENCE_WORKFLOW,
      workflowRunId: validateCaptureOnly ? '1' : required(options, 'workflow-run-id'),
      workflowRunAttempt: validateCaptureOnly
        ? 1
        : Number(required(options, 'workflow-run-attempt')),
      journeySetSha256: COMPUTER_USE_JOURNEY_SET_SHA256,
      transcriptSha256: computerUseTranscriptSha256(journeys),
    },
    machineTranscript: { schemaVersion: COMPUTER_USE_TRANSCRIPT_SCHEMA_VERSION, journeys },
    providerBinding: capture.providerBinding,
    privacy: capture.privacy,
    ac28Core: evidenceRows.slice(0, COMPUTER_USE_CORE_IDS.length),
    ac29Safety: evidenceRows.slice(
      COMPUTER_USE_CORE_IDS.length,
      COMPUTER_USE_CORE_IDS.length + COMPUTER_USE_SAFETY_IDS.length,
    ),
    ac30Compatibility: evidenceRows.slice(
      COMPUTER_USE_CORE_IDS.length + COMPUTER_USE_SAFETY_IDS.length,
    ),
  };
  validateComputerUseFinalGateEvidence(evidence, { allowIncomplete: true });
  if (validateCaptureOnly) {
    console.log('Computer Use incomplete machine transcript is bounded and canonical.');
    return;
  }
  const outputPath = required(options, 'output');
  const output = `${JSON.stringify(evidence)}\n`;
  if (Buffer.byteLength(output) > MAX_CAPTURE_BYTES) fail('sealed evidence exceeds 64 KiB');
  writeFileSync(outputPath, output, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
