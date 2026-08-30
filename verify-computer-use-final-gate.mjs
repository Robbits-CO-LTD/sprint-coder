import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const MAX_EVIDENCE_BYTES = 64 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_CODE = /^[A-Z0-9][A-Z0-9_-]{0,63}$/u;
const SAFE_ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PENDING_REASON_CODE = 'EXTERNAL_GATE_NOT_RUN';
const CANONICAL_PENDING_TEMPLATE_URL = new URL(
  './tasks/evidence/issue-333-computer-use-final-gate-template.json',
  import.meta.url,
);
const VERIFIER_BOOLEAN_OPTIONS = Object.freeze([
  'self-test',
  'allow-incomplete',
  'trusted-workflow-attestation-verified',
]);
const VERIFIER_VALUE_OPTIONS = Object.freeze([
  'evidence',
  'source-commit',
  'source-run-id',
  'evidence-run-id',
  'evidence-run-attempt',
  'windows-artifact',
  'macos-artifact',
  'windows-portable-name',
  'windows-portable-sha256',
  'windows-installer-name',
  'windows-installer-sha256',
  'macos-sha256',
]);
export const COMPUTER_USE_PROVIDER_ADAPTER_VERSION = 'computer-use-v1';
export const COMPUTER_USE_EVIDENCE_WORKFLOW = '.github/workflows/computer-use-evidence-harness.yml';
export const COMPUTER_USE_TRANSCRIPT_SCHEMA_VERSION = 1;

export const COMPUTER_USE_CORE_JOURNEYS = Object.freeze([
  journey(
    'AC-28-WIN-FIXTURE-IDENTITY-OBSERVE',
    'WIN_FIXTURE_IDENTITY_OBSERVE_V1',
    'PENDING_WIN_FIXTURE_IDENTITY',
  ),
  journey(
    'AC-28-WIN-FIXTURE-SEMANTIC',
    'WIN_FIXTURE_SEMANTIC_ACTIONS_V1',
    'PENDING_WIN_FIXTURE_SEMANTIC',
  ),
  journey(
    'AC-28-WIN-FIXTURE-VISUAL',
    'WIN_FIXTURE_VISUAL_ACTIONS_V1',
    'PENDING_WIN_FIXTURE_VISUAL',
  ),
  journey('AC-28-WIN-FIXTURE-MIXED', 'WIN_FIXTURE_MIXED_ACTIONS_V1', 'PENDING_WIN_FIXTURE_MIXED'),
  journey(
    'AC-28-WIN-FIXTURE-JAPANESE',
    'WIN_FIXTURE_JAPANESE_TEXT_V1',
    'PENDING_WIN_FIXTURE_JAPANESE',
  ),
  journey(
    'AC-28-WIN-NOTEPAD-IDENTITY-OBSERVE',
    'WIN_NOTEPAD_IDENTITY_OBSERVE_V1',
    'PENDING_WIN_NOTEPAD_IDENTITY',
  ),
  journey('AC-28-WIN-NOTEPAD-MIXED', 'WIN_NOTEPAD_MIXED_ACTIONS_V1', 'PENDING_WIN_NOTEPAD_MIXED'),
  journey(
    'AC-28-WIN-NOTEPAD-JAPANESE',
    'WIN_NOTEPAD_JAPANESE_TEXT_V1',
    'PENDING_WIN_NOTEPAD_JAPANESE',
  ),
  journey(
    'AC-28-MAC-TEXTEDIT-IDENTITY-OBSERVE',
    'MAC_TEXTEDIT_IDENTITY_OBSERVE_V1',
    'PENDING_MAC_TEXTEDIT_IDENTITY',
  ),
  journey(
    'AC-28-MAC-TEXTEDIT-SEMANTIC',
    'MAC_TEXTEDIT_SEMANTIC_ACTIONS_V1',
    'PENDING_MAC_TEXTEDIT_SEMANTIC',
  ),
  journey(
    'AC-28-MAC-TEXTEDIT-VISUAL',
    'MAC_TEXTEDIT_VISUAL_ACTIONS_V1',
    'PENDING_MAC_TEXTEDIT_VISUAL',
  ),
  journey(
    'AC-28-MAC-TEXTEDIT-MIXED',
    'MAC_TEXTEDIT_MIXED_ACTIONS_V1',
    'PENDING_MAC_TEXTEDIT_MIXED',
  ),
  journey(
    'AC-28-MAC-TEXTEDIT-JAPANESE',
    'MAC_TEXTEDIT_JAPANESE_TEXT_V1',
    'PENDING_MAC_TEXTEDIT_JAPANESE',
  ),
  journey(
    'AC-28-MAC-VSCODE-IDENTITY-OBSERVE',
    'MAC_VSCODE_IDENTITY_OBSERVE_V1',
    'PENDING_MAC_VSCODE_IDENTITY',
  ),
  journey('AC-28-MAC-VSCODE-MIXED', 'MAC_VSCODE_MIXED_ACTIONS_V1', 'PENDING_MAC_VSCODE_MIXED'),
  journey(
    'AC-28-MAC-VSCODE-TEMP-WORKSPACE',
    'MAC_VSCODE_TEMP_WORKSPACE_V1',
    'PENDING_MAC_VSCODE_WORKSPACE',
  ),
  journey(
    'AC-28-MAC-VSCODE-JAPANESE',
    'MAC_VSCODE_JAPANESE_TEXT_V1',
    'PENDING_MAC_VSCODE_JAPANESE',
  ),
  journey(
    'AC-28-PROVIDER-FIXED-IMAGE-PREFLIGHT',
    'PROVIDER_FIXED_IMAGE_PREFLIGHT_V1',
    'PENDING_PROVIDER_PREFLIGHT',
  ),
  journey(
    'AC-28-PROVIDER-EXACT-THREE-ROUNDS',
    'PROVIDER_EXACT_THREE_ROUNDS_V1',
    'PENDING_PROVIDER_THREE_ROUNDS',
  ),
  journey(
    'AC-28-PROVIDER-NO-FALLBACK',
    'PROVIDER_BINDING_NO_FALLBACK_V1',
    'PENDING_PROVIDER_BINDING',
  ),
]);

export const COMPUTER_USE_SAFETY_JOURNEYS = Object.freeze([
  journey(
    'AC-29-SAME-OWNER-DIALOG-REVISION',
    'SAME_OWNER_DIALOG_INVALIDATION_V1',
    'PENDING_DIALOG_INVALIDATION',
  ),
  journey('AC-29-FOCUS-LOSS', 'FOCUS_LOSS_BEFORE_INPUT_V1', 'PENDING_FOCUS_LOSS'),
  journey('AC-29-GEOMETRY-DRIFT', 'GEOMETRY_DRIFT_BEFORE_INPUT_V1', 'PENDING_GEOMETRY_DRIFT'),
  journey('AC-29-STALE-OBSERVATION', 'STALE_OBSERVATION_REJECT_V1', 'PENDING_STALE_OBSERVATION'),
  journey('AC-29-SECURE-FIELD', 'SECURE_FIELD_STOP_BEFORE_INPUT_V1', 'PENDING_SECURE_FIELD'),
  journey('AC-29-PAYMENT', 'PAYMENT_STOP_BEFORE_INPUT_V1', 'PENDING_PAYMENT'),
  journey('AC-29-CONTRACT', 'CONTRACT_STOP_BEFORE_INPUT_V1', 'PENDING_CONTRACT'),
  journey('AC-29-INSTALLER', 'INSTALLER_STOP_BEFORE_INPUT_V1', 'PENDING_INSTALLER'),
  journey('AC-29-ADMIN', 'ADMIN_STOP_BEFORE_INPUT_V1', 'PENDING_ADMIN'),
  journey('AC-29-FILE-PICKER-TAKEOVER', 'FILE_PICKER_USER_TAKEOVER_V1', 'PENDING_FILE_PICKER'),
  journey('AC-29-OS-PROMPT-TAKEOVER', 'OS_PROMPT_USER_TAKEOVER_V1', 'PENDING_OS_PROMPT'),
  journey('AC-29-OTHER-APP-WINDOW-DENY', 'OTHER_APP_WINDOW_DENY_V1', 'PENDING_OTHER_APP_WINDOW'),
  journey('AC-29-VISUAL-PATCH-DRIFT', 'VISUAL_PATCH_DRIFT_REJECT_V1', 'PENDING_VISUAL_PATCH_DRIFT'),
  journey(
    'AC-29-DUPLICATE-NO-REDISPATCH',
    'DUPLICATE_REQUEST_NO_REDISPATCH_V1',
    'PENDING_DUPLICATE_REQUEST',
  ),
  journey('AC-29-UNKNOWN-EFFECT-NO-RETRY', 'UNKNOWN_EFFECT_NO_RETRY_V1', 'PENDING_UNKNOWN_EFFECT'),
  journey('AC-29-NATIVE-CRASH', 'NATIVE_CRASH_FAIL_CLOSED_V1', 'PENDING_NATIVE_CRASH'),
  journey('AC-29-PARENT-DEATH', 'PARENT_DEATH_CANCEL_V1', 'PENDING_PARENT_DEATH'),
  journey('AC-29-EMERGENCY-SHORTCUT', 'EMERGENCY_SHORTCUT_STOP_V1', 'PENDING_EMERGENCY_SHORTCUT'),
  journey('AC-29-PERSISTENT-STOP', 'PERSISTENT_STOP_CONTROL_V1', 'PENDING_PERSISTENT_STOP'),
  journey('AC-29-ZERO-AFTER-STOP', 'ZERO_INPUT_AFTER_STOP_V1', 'PENDING_ZERO_AFTER_STOP'),
  journey('AC-29-TYPE-MID-STOP', 'TYPE_MID_STOP_ATOMIC_V1', 'PENDING_TYPE_MID_STOP'),
  journey('AC-29-TASK-SWITCH', 'TASK_SWITCH_CANCEL_V1', 'PENDING_TASK_SWITCH'),
  journey('AC-29-NEW-TURN', 'NEW_TURN_CANCEL_V1', 'PENDING_NEW_TURN'),
  journey('AC-29-POLICY-EPOCH', 'POLICY_EPOCH_CANCEL_V1', 'PENDING_POLICY_EPOCH'),
  journey('AC-29-PROMPT-INJECTION', 'PROMPT_INJECTION_SCOPE_HELD_V1', 'PENDING_PROMPT_INJECTION'),
  journey(
    'AC-29-PRIVACY-NONPERSISTENCE',
    'PRIVACY_SURFACE_INSPECTION_V1',
    'PENDING_PRIVACY_INSPECTION',
  ),
  journey(
    'AC-29-UNSIGNED-WINDOWS-FAIL-CLOSED',
    'UNSIGNED_WINDOWS_FAIL_CLOSED_V1',
    'PENDING_UNSIGNED_WINDOWS',
  ),
  journey('AC-29-ADHOC-MACOS-FAIL-CLOSED', 'ADHOC_MACOS_FAIL_CLOSED_V1', 'PENDING_ADHOC_MACOS'),
]);

export const COMPUTER_USE_COMPATIBILITY_JOURNEYS = Object.freeze([
  compatibilityJourney('AC-30-WINDOWS-18362-X64', {
    PASS: rule('WINDOWS_18362_SIGNED_RUNTIME_V1', ['NONE']),
    FAIL: rule('WINDOWS_18362_RUNTIME_PENDING_V1', [
      'SIGNED_RUNTIME_NOT_RUN',
      'SIGNED_RUNTIME_FAILED',
      'OS_BUILD_UNSUPPORTED',
    ]),
  }),
  compatibilityJourney('AC-30-MACOS-12_3', {
    PASS: rule('MACOS_12_3_BUILD_PROBE_V1', ['NONE']),
    FAIL: rule('MACOS_12_3_BUILD_PROBE_FAILED_V1', ['BUILD_PROBE_FAILED']),
  }),
  compatibilityJourney('AC-30-ELECTRON-NAPI', {
    PASS: rule('ELECTRON_NAPI_HANDSHAKE_V1', ['NONE']),
    FAIL: rule('ELECTRON_NAPI_HANDSHAKE_FAILED_V1', ['ABI_HANDSHAKE_FAILED']),
  }),
  compatibilityJourney('AC-30-PROVIDER-STRUCTURED', {
    PASS: rule('PROVIDER_STRUCTURED_SCHEMA_V1', ['NONE']),
    FAIL: rule('PROVIDER_STRUCTURED_PENDING_V1', ['REAL_PROVIDER_NOT_RUN', 'PROVIDER_PATH_FAILED']),
    SKIP: rule('PROVIDER_STRUCTURED_NOT_SELECTED_V1', ['PROVIDER_PATH_NOT_SELECTED']),
  }),
  compatibilityJourney('AC-30-PROVIDER-JSON', {
    PASS: rule('PROVIDER_BOUNDED_JSON_V1', ['NONE']),
    FAIL: rule('PROVIDER_JSON_PENDING_V1', ['REAL_PROVIDER_NOT_RUN', 'PROVIDER_PATH_FAILED']),
    SKIP: rule('PROVIDER_JSON_NOT_SELECTED_V1', ['PROVIDER_PATH_NOT_SELECTED']),
  }),
  compatibilityJourney('AC-30-UNSUPPORTED-LINUX', {
    SKIP: rule('LINUX_UNSUPPORTED_V1', ['UNSUPPORTED_PLATFORM_DOCUMENTED']),
  }),
  compatibilityJourney('AC-30-REMOTE-DESKTOP', {
    SKIP: rule('REMOTE_DESKTOP_UNSUPPORTED_V1', ['OUT_OF_SCOPE_DOCUMENTED']),
  }),
  compatibilityJourney('AC-30-WINDOWS-UWP-PACKAGE-PROXY', {
    SKIP: rule('WINDOWS_UWP_PROXY_UNSUPPORTED_V1', ['UNSUPPORTED_WINDOW_PROXY_DOCUMENTED']),
  }),
  compatibilityJourney('AC-30-HARD-BOUNDARY-POLICY-LANGUAGE', {
    SKIP: rule('OTHER_UI_LANGUAGES_UNSUPPORTED_V1', ['UNSUPPORTED_POLICY_LANGUAGE_DOCUMENTED']),
  }),
]);

export const COMPUTER_USE_CORE_IDS = Object.freeze(COMPUTER_USE_CORE_JOURNEYS.map(({ id }) => id));
export const COMPUTER_USE_SAFETY_IDS = Object.freeze(
  COMPUTER_USE_SAFETY_JOURNEYS.map(({ id }) => id),
);
export const COMPUTER_USE_COMPATIBILITY_IDS = Object.freeze(
  COMPUTER_USE_COMPATIBILITY_JOURNEYS.map(({ id }) => id),
);
export const COMPUTER_USE_JOURNEY_SET_SHA256 = sha256(
  JSON.stringify({
    core: COMPUTER_USE_CORE_JOURNEYS,
    safety: COMPUTER_USE_SAFETY_JOURNEYS,
    compatibility: COMPUTER_USE_COMPATIBILITY_JOURNEYS,
  }),
);

function journey(id, passEvidenceCode, pendingEvidenceCode) {
  return Object.freeze({ id, passEvidenceCode, pendingEvidenceCode });
}

function rule(evidenceCode, reasonCodes) {
  return Object.freeze({ evidenceCode, reasonCodes: Object.freeze(reasonCodes) });
}

function compatibilityJourney(id, rules) {
  return Object.freeze({ id, rules: Object.freeze(rules) });
}

function fail(message) {
  throw new Error(`Computer Use final gate evidence is invalid: ${message}`);
}

function assertNoDuplicateJsonObjectKeys(text) {
  let index = 0;

  const malformed = () => {
    throw new Error('raw JSON is malformed');
  };
  const skipWhitespace = () => {
    while (index < text.length && /[\t\n\r ]/u.test(text[index])) index += 1;
  };
  const parseString = () => {
    if (text[index] !== '"') malformed();
    const start = index;
    index += 1;
    while (index < text.length) {
      const character = text[index];
      if (character === '"') {
        index += 1;
        try {
          return JSON.parse(text.slice(start, index));
        } catch {
          malformed();
        }
      }
      if (character === '\\') {
        index += 1;
        const escape = text[index];
        if (escape === undefined) malformed();
        if (escape === 'u') {
          if (!/^[0-9a-fA-F]{4}$/u.test(text.slice(index + 1, index + 5))) malformed();
          index += 5;
          continue;
        }
        if (!['"', '\\', '/', 'b', 'f', 'n', 'r', 't'].includes(escape)) malformed();
        index += 1;
        continue;
      }
      if (character.charCodeAt(0) <= 0x1f) malformed();
      index += 1;
    }
    malformed();
  };
  const parseNumber = () => {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(text.slice(index));
    if (match === null) malformed();
    index += match[0].length;
  };
  const parseValue = () => {
    skipWhitespace();
    const character = text[index];
    if (character === '{') {
      index += 1;
      skipWhitespace();
      const keys = new Set();
      if (text[index] === '}') {
        index += 1;
        return;
      }
      while (index < text.length) {
        skipWhitespace();
        const key = parseString();
        if (keys.has(key)) throw new Error('duplicate JSON object key');
        keys.add(key);
        skipWhitespace();
        if (text[index] !== ':') malformed();
        index += 1;
        parseValue();
        skipWhitespace();
        if (text[index] === '}') {
          index += 1;
          return;
        }
        if (text[index] !== ',') malformed();
        index += 1;
      }
      malformed();
    }
    if (character === '[') {
      index += 1;
      skipWhitespace();
      if (text[index] === ']') {
        index += 1;
        return;
      }
      while (index < text.length) {
        parseValue();
        skipWhitespace();
        if (text[index] === ']') {
          index += 1;
          return;
        }
        if (text[index] !== ',') malformed();
        index += 1;
      }
      malformed();
    }
    if (character === '"') {
      parseString();
      return;
    }
    for (const literal of ['true', 'false', 'null']) {
      if (text.startsWith(literal, index)) {
        index += literal.length;
        return;
      }
    }
    parseNumber();
  };

  parseValue();
  skipWhitespace();
  if (index !== text.length) malformed();
}

export function parseJsonRejectingDuplicateKeys(text) {
  assertNoDuplicateJsonObjectKeys(text);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('raw JSON is malformed');
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalEventSequence(id, status) {
  const prefix = ['JOURNEY_STARTED', 'PACKAGE_BOUND'];
  if (status === 'SKIP')
    return Object.freeze([...prefix, 'UNSUPPORTED_BOUNDARY_RECORDED', 'JOURNEY_FINISHED']);

  let observations;
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

  return Object.freeze([
    ...prefix,
    ...observations,
    status === 'PASS' ? 'ASSERTION_PASSED' : 'ASSERTION_FAILED',
    'JOURNEY_FINISHED',
  ]);
}

export function computerUseEventSequenceSha256(id, eventSequence, eventDigests) {
  return sha256(JSON.stringify({ id, eventSequence, eventDigests }));
}

export function computerUseTranscriptSha256(journeys) {
  return sha256(JSON.stringify(journeys));
}

export function computerUsePackageBindingSha256({ sourceCommit, sourceRunId, artifacts }) {
  return sha256(JSON.stringify({ sourceCommit, sourceRunId, artifacts }));
}

function record(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail(`${path} must be an object`);
  return value;
}

function exactKeys(value, expected, path) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
    fail(`${path} keys must be exactly ${wanted.join(', ')}`);
}

function digest(value, path, { allowZero = false } = {}) {
  if (typeof value !== 'string' || !SHA256.test(value))
    fail(`${path} must be a lowercase SHA-256 digest`);
  if (!allowZero && value === '0'.repeat(64)) fail(`${path} must not be the pending zero digest`);
}

function safeCode(value, path) {
  if (typeof value !== 'string' || !SAFE_CODE.test(value))
    fail(`${path} must be a bounded stable code`);
}

function requireCompletedBindings({
  expectedSourceCommit,
  expectedSourceRunId,
  expectedEvidenceRunId,
  expectedEvidenceRunAttempt,
  expectedWindowsArtifact,
  expectedMacosArtifact,
  expectedWindowsPortableName,
  expectedWindowsPortableSha256,
  expectedWindowsInstallerName,
  expectedWindowsInstallerSha256,
  expectedMacosSha256,
}) {
  const requiredStrings = [
    ['--source-commit', expectedSourceCommit],
    ['--source-run-id', expectedSourceRunId],
    ['--evidence-run-id', expectedEvidenceRunId],
    ['--windows-artifact', expectedWindowsArtifact],
    ['--macos-artifact', expectedMacosArtifact],
    ['--windows-portable-name', expectedWindowsPortableName],
    ['--windows-portable-sha256', expectedWindowsPortableSha256],
    ['--windows-installer-name', expectedWindowsInstallerName],
    ['--windows-installer-sha256', expectedWindowsInstallerSha256],
    ['--macos-sha256', expectedMacosSha256],
  ];
  for (const [option, value] of requiredStrings) {
    if (typeof value !== 'string' || value.length === 0)
      fail(`${option} is required for completed evidence`);
  }
  if (!/^[0-9a-f]{40}$/u.test(expectedSourceCommit))
    fail('--source-commit must be a lowercase 40-character commit id');
  for (const [option, value] of [
    ['--source-run-id', expectedSourceRunId],
    ['--evidence-run-id', expectedEvidenceRunId],
  ]) {
    if (!/^[1-9][0-9]{0,19}$/u.test(value)) fail(`${option} must be a decimal workflow run id`);
  }
  if (!Number.isSafeInteger(expectedEvidenceRunAttempt) || expectedEvidenceRunAttempt < 1)
    fail('--evidence-run-attempt must be a positive integer');
  for (const [option, value] of [
    ['--windows-portable-sha256', expectedWindowsPortableSha256],
    ['--windows-installer-sha256', expectedWindowsInstallerSha256],
    ['--macos-sha256', expectedMacosSha256],
  ]) {
    if (!SHA256.test(value) || value === '0'.repeat(64))
      fail(`${option} must be a non-zero lowercase SHA-256 digest`);
  }
  for (const [option, value] of [
    ['--windows-artifact', expectedWindowsArtifact],
    ['--macos-artifact', expectedMacosArtifact],
    ['--windows-portable-name', expectedWindowsPortableName],
    ['--windows-installer-name', expectedWindowsInstallerName],
  ]) {
    if (!SAFE_ARTIFACT_NAME.test(value)) fail(`${option} is unsafe`);
  }
}

function requiredJourneyRows(value, journeys, path, { allowIncomplete }) {
  if (!Array.isArray(value) || value.length !== journeys.length)
    fail(`${path} must contain exactly ${journeys.length} rows`);

  for (const [index, specification] of journeys.entries()) {
    const rowPath = `${path}[${index}]`;
    const row = record(value[index], rowPath);
    exactKeys(row, ['id', 'status', 'reasonCode', 'evidenceCode'], rowPath);
    if (row.id !== specification.id)
      fail(`${rowPath}.id must be ${specification.id} in canonical journey order`);
    safeCode(row.reasonCode, `${rowPath}.reasonCode`);
    safeCode(row.evidenceCode, `${rowPath}.evidenceCode`);

    if (row.status === 'PASS') {
      if (allowIncomplete) fail(`${rowPath} Core/Safety PASS is not valid in incomplete mode`);
      if (row.reasonCode !== 'NONE') fail(`${rowPath} PASS must use reasonCode NONE`);
      if (row.evidenceCode !== specification.passEvidenceCode)
        fail(`${rowPath} PASS must use evidenceCode ${specification.passEvidenceCode}`);
      continue;
    }

    if (!allowIncomplete || row.status !== 'FAIL')
      fail(`${rowPath} must PASS the final gate; SKIP is never valid for Core/Safety`);
    if (row.reasonCode !== PENDING_REASON_CODE)
      fail(`${rowPath} incomplete row must use reasonCode ${PENDING_REASON_CODE}`);
    if (row.evidenceCode !== specification.pendingEvidenceCode)
      fail(`${rowPath} incomplete row must use evidenceCode ${specification.pendingEvidenceCode}`);
  }
}

function compatibilityRows(value, { allowIncomplete }) {
  if (!Array.isArray(value) || value.length !== COMPUTER_USE_COMPATIBILITY_JOURNEYS.length)
    fail(
      `ac30Compatibility must contain exactly ${COMPUTER_USE_COMPATIBILITY_JOURNEYS.length} rows`,
    );

  for (const [index, specification] of COMPUTER_USE_COMPATIBILITY_JOURNEYS.entries()) {
    const rowPath = `ac30Compatibility[${index}]`;
    const row = record(value[index], rowPath);
    exactKeys(row, ['id', 'status', 'reasonCode', 'evidenceCode'], rowPath);
    if (row.id !== specification.id)
      fail(`${rowPath}.id must be ${specification.id} in canonical journey order`);
    safeCode(row.reasonCode, `${rowPath}.reasonCode`);
    safeCode(row.evidenceCode, `${rowPath}.evidenceCode`);
    const selectedRule = specification.rules[row.status];
    if (selectedRule === undefined)
      fail(`${rowPath}.status ${String(row.status)} is not valid for ${specification.id}`);
    if (row.evidenceCode !== selectedRule.evidenceCode)
      fail(`${rowPath} ${row.status} must use evidenceCode ${selectedRule.evidenceCode}`);
    if (!selectedRule.reasonCodes.includes(row.reasonCode))
      fail(`${rowPath} ${row.status} uses a non-canonical reasonCode`);
  }

  if (allowIncomplete) return;
  const structured = value.find(({ id }) => id === 'AC-30-PROVIDER-STRUCTURED');
  const boundedJson = value.find(({ id }) => id === 'AC-30-PROVIDER-JSON');
  if (!(
    (structured?.status === 'PASS' && boundedJson?.status === 'SKIP') ||
    (structured?.status === 'SKIP' && boundedJson?.status === 'PASS')
  ))
    fail(
      'exactly one Provider compatibility path must PASS and the unselected path must use its canonical SKIP',
    );
}

function transcriptRows(value, evidenceRows, { allowIncomplete }) {
  const transcript = record(value, 'machineTranscript');
  exactKeys(transcript, ['schemaVersion', 'journeys'], 'machineTranscript');
  if (transcript.schemaVersion !== COMPUTER_USE_TRANSCRIPT_SCHEMA_VERSION)
    fail(`machineTranscript.schemaVersion must be ${COMPUTER_USE_TRANSCRIPT_SCHEMA_VERSION}`);
  if (allowIncomplete && Array.isArray(transcript.journeys) && transcript.journeys.length === 0)
    return transcript;
  if (!Array.isArray(transcript.journeys) || transcript.journeys.length !== evidenceRows.length)
    fail(`machineTranscript.journeys must contain exactly ${evidenceRows.length} rows`);

  for (const [index, evidenceRow] of evidenceRows.entries()) {
    const rowPath = `machineTranscript.journeys[${index}]`;
    const row = record(transcript.journeys[index], rowPath);
    exactKeys(row, ['id', 'eventSequence', 'eventDigests', 'eventSequenceSha256'], rowPath);
    if (row.id !== evidenceRow.id) fail(`${rowPath}.id must be ${evidenceRow.id}`);
    if (!Array.isArray(row.eventSequence) || !Array.isArray(row.eventDigests))
      fail(`${rowPath} eventSequence and eventDigests must be arrays`);
    if (allowIncomplete && row.eventSequence.length === 0 && row.eventDigests.length === 0) {
      digest(row.eventSequenceSha256, `${rowPath}.eventSequenceSha256`, { allowZero: true });
      if (row.eventSequenceSha256 !== '0'.repeat(64))
        fail(`${rowPath}.eventSequenceSha256 must be pending when events are empty`);
      continue;
    }
    const expectedSequence = canonicalEventSequence(evidenceRow.id, evidenceRow.status);
    if (
      row.eventSequence.length !== expectedSequence.length ||
      row.eventSequence.some((event, eventIndex) => event !== expectedSequence[eventIndex])
    )
      fail(`${rowPath}.eventSequence must match the canonical ${evidenceRow.status} sequence`);
    if (row.eventDigests.length !== expectedSequence.length)
      fail(`${rowPath}.eventDigests must bind every canonical event`);
    for (const [eventIndex, eventDigest] of row.eventDigests.entries())
      digest(eventDigest, `${rowPath}.eventDigests[${eventIndex}]`);
    digest(row.eventSequenceSha256, `${rowPath}.eventSequenceSha256`);
    const expectedDigest = computerUseEventSequenceSha256(
      row.id,
      row.eventSequence,
      row.eventDigests,
    );
    if (row.eventSequenceSha256 !== expectedDigest)
      fail(`${rowPath}.eventSequenceSha256 does not bind its canonical event sequence`);
  }
  return transcript;
}

export function validateComputerUseFinalGateEvidence(
  candidate,
  {
    allowIncomplete = false,
    expectedSourceCommit,
    expectedSourceRunId,
    expectedEvidenceRunId,
    expectedEvidenceRunAttempt,
    expectedWindowsArtifact,
    expectedMacosArtifact,
    expectedWindowsPortableName,
    expectedWindowsPortableSha256,
    expectedWindowsInstallerName,
    expectedWindowsInstallerSha256,
    expectedMacosSha256,
  } = {},
) {
  const evidence = record(candidate, 'root');
  exactKeys(
    evidence,
    [
      'schemaVersion',
      'issue',
      'sourceCommit',
      'sourceRunId',
      'completedAt',
      'artifacts',
      'harnessAttestation',
      'machineTranscript',
      'providerBinding',
      'privacy',
      'ac28Core',
      'ac29Safety',
      'ac30Compatibility',
    ],
    'root',
  );
  if (evidence.schemaVersion !== 3 || evidence.issue !== 333) fail('schemaVersion/issue mismatch');
  if (!allowIncomplete)
    requireCompletedBindings({
      expectedSourceCommit,
      expectedSourceRunId,
      expectedEvidenceRunId,
      expectedEvidenceRunAttempt,
      expectedWindowsArtifact,
      expectedMacosArtifact,
      expectedWindowsPortableName,
      expectedWindowsPortableSha256,
      expectedWindowsInstallerName,
      expectedWindowsInstallerSha256,
      expectedMacosSha256,
    });
  if (typeof evidence.sourceCommit !== 'string' || !/^[0-9a-f]{40}$/u.test(evidence.sourceCommit))
    fail('sourceCommit must be a lowercase 40-character commit id');
  if (!allowIncomplete && evidence.sourceCommit === '0'.repeat(40)) fail('sourceCommit is pending');
  if (
    typeof evidence.sourceRunId !== 'string' ||
    !/^[1-9][0-9]{0,19}$/u.test(evidence.sourceRunId)
  ) {
    if (!(allowIncomplete && evidence.sourceRunId === '0'))
      fail('sourceRunId must be a decimal workflow run id');
  }
  if (
    typeof evidence.completedAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(evidence.completedAt) ||
    Number.isNaN(Date.parse(evidence.completedAt))
  )
    fail('completedAt must be a bounded UTC ISO timestamp');

  const artifacts = record(evidence.artifacts, 'artifacts');
  exactKeys(artifacts, ['windows', 'macos'], 'artifacts');
  const windows = record(artifacts.windows, 'artifacts.windows');
  exactKeys(
    windows,
    ['sourceCommit', 'sourceRunId', 'artifactName', 'portable', 'installer'],
    'artifacts.windows',
  );
  if (windows.sourceCommit !== evidence.sourceCommit)
    fail('artifacts.windows.sourceCommit must match sourceCommit');
  if (windows.sourceRunId !== evidence.sourceRunId)
    fail('artifacts.windows.sourceRunId must match sourceRunId');
  if (typeof windows.artifactName !== 'string' || !SAFE_ARTIFACT_NAME.test(windows.artifactName))
    fail('artifacts.windows.artifactName is unsafe');
  for (const kind of ['portable', 'installer']) {
    const artifact = record(windows[kind], `artifacts.windows.${kind}`);
    exactKeys(artifact, ['fileName', 'sha256'], `artifacts.windows.${kind}`);
    if (typeof artifact.fileName !== 'string' || !SAFE_ARTIFACT_NAME.test(artifact.fileName))
      fail(`artifacts.windows.${kind}.fileName is unsafe`);
    digest(artifact.sha256, `artifacts.windows.${kind}.sha256`, {
      allowZero: allowIncomplete,
    });
  }
  if (!allowIncomplete && windows.portable.sha256 === windows.installer.sha256)
    fail('Windows portable and installer SHA-256 digests must be distinct');

  const macos = record(artifacts.macos, 'artifacts.macos');
  exactKeys(
    macos,
    ['sourceCommit', 'sourceRunId', 'artifactName', 'packageSha256'],
    'artifacts.macos',
  );
  if (macos.sourceCommit !== evidence.sourceCommit)
    fail('artifacts.macos.sourceCommit must match sourceCommit');
  if (macos.sourceRunId !== evidence.sourceRunId)
    fail('artifacts.macos.sourceRunId must match sourceRunId');
  if (typeof macos.artifactName !== 'string' || !SAFE_ARTIFACT_NAME.test(macos.artifactName))
    fail('artifacts.macos.artifactName is unsafe');
  digest(macos.packageSha256, 'artifacts.macos.packageSha256', { allowZero: allowIncomplete });

  const harnessAttestation = record(evidence.harnessAttestation, 'harnessAttestation');
  exactKeys(
    harnessAttestation,
    ['workflowPath', 'workflowRunId', 'workflowRunAttempt', 'journeySetSha256', 'transcriptSha256'],
    'harnessAttestation',
  );
  if (harnessAttestation.workflowPath !== COMPUTER_USE_EVIDENCE_WORKFLOW)
    fail(`harnessAttestation.workflowPath must be ${COMPUTER_USE_EVIDENCE_WORKFLOW}`);
  if (!/^[1-9][0-9]{0,19}$/u.test(String(harnessAttestation.workflowRunId))) {
    if (!(allowIncomplete && harnessAttestation.workflowRunId === '0'))
      fail('harnessAttestation.workflowRunId must be a decimal workflow run id');
  }
  if (
    !Number.isSafeInteger(harnessAttestation.workflowRunAttempt) ||
    harnessAttestation.workflowRunAttempt < (allowIncomplete ? 0 : 1)
  )
    fail('harnessAttestation.workflowRunAttempt must be a positive integer');
  digest(harnessAttestation.journeySetSha256, 'harnessAttestation.journeySetSha256', {
    allowZero: allowIncomplete,
  });
  if (!allowIncomplete && harnessAttestation.journeySetSha256 !== COMPUTER_USE_JOURNEY_SET_SHA256)
    fail('harnessAttestation.journeySetSha256 does not bind the canonical journey set');

  const provider = record(evidence.providerBinding, 'providerBinding');
  exactKeys(
    provider,
    [
      'connectionIdDigest',
      'modelIdDigest',
      'endpointDigest',
      'catalogDigest',
      'policyEpoch',
      'adapterVersion',
      'sessionIdDigest',
      'selectedFromCurrentTask',
      'bindingStable',
      'preflightAttempts',
      'preflightPassed',
      'roundsAttempted',
      'roundsCompleted',
      'isOpenRouter',
      'fallbackUsed',
      'credentialChanged',
    ],
    'providerBinding',
  );
  for (const field of [
    'connectionIdDigest',
    'modelIdDigest',
    'endpointDigest',
    'catalogDigest',
    'sessionIdDigest',
  ])
    digest(provider[field], `providerBinding.${field}`, { allowZero: allowIncomplete });
  if (!Number.isSafeInteger(provider.policyEpoch) || provider.policyEpoch < 0)
    fail('providerBinding.policyEpoch must be a non-negative integer');
  if (
    provider.adapterVersion !== COMPUTER_USE_PROVIDER_ADAPTER_VERSION &&
    !(allowIncomplete && provider.adapterVersion === 'PENDING')
  )
    fail(`providerBinding.adapterVersion must be ${COMPUTER_USE_PROVIDER_ADAPTER_VERSION}`);
  for (const field of [
    'selectedFromCurrentTask',
    'bindingStable',
    'preflightPassed',
    'isOpenRouter',
    'fallbackUsed',
    'credentialChanged',
  ])
    if (typeof provider[field] !== 'boolean') fail(`providerBinding.${field} must be boolean`);
  for (const field of ['preflightAttempts', 'roundsAttempted', 'roundsCompleted'])
    if (!Number.isSafeInteger(provider[field]) || provider[field] < 0 || provider[field] > 25)
      fail(`providerBinding.${field} must be between 0 and 25`);
  for (const field of ['isOpenRouter', 'fallbackUsed', 'credentialChanged'])
    if (provider[field] !== false) fail(`providerBinding.${field} must remain false`);
  if (
    !allowIncomplete &&
    (!provider.selectedFromCurrentTask ||
      !provider.bindingStable ||
      provider.preflightAttempts !== 1 ||
      !provider.preflightPassed ||
      provider.roundsAttempted !== 3 ||
      provider.roundsCompleted !== 3)
  )
    fail(
      'the current Task Provider must pass one preflight and exactly three attempted/completed rounds with a stable binding',
    );

  const privacy = record(evidence.privacy, 'privacy');
  const privacyFields = [
    'databaseRawScreenshotAbsent',
    'databaseRawAccessibilityTreeAbsent',
    'databaseTypedTextAbsent',
    'logRawScreenshotAbsent',
    'logRawAccessibilityTreeAbsent',
    'logTypedTextAbsent',
    'telemetryRawScreenAbsent',
    'crashArtifactRawScreenAbsent',
    'providerRawOutputAbsent',
    'providerReasoningAbsent',
    'evidenceArtifactJsonOnly',
  ];
  exactKeys(privacy, privacyFields, 'privacy');
  for (const field of privacyFields) {
    if (typeof privacy[field] !== 'boolean') fail(`privacy.${field} must be boolean`);
    if (!allowIncomplete && privacy[field] !== true) fail(`privacy.${field} must be true`);
  }

  requiredJourneyRows(evidence.ac28Core, COMPUTER_USE_CORE_JOURNEYS, 'ac28Core', {
    allowIncomplete,
  });
  requiredJourneyRows(evidence.ac29Safety, COMPUTER_USE_SAFETY_JOURNEYS, 'ac29Safety', {
    allowIncomplete,
  });
  compatibilityRows(evidence.ac30Compatibility, { allowIncomplete });
  const evidenceRows = [
    ...evidence.ac28Core,
    ...evidence.ac29Safety,
    ...evidence.ac30Compatibility,
  ];
  const machineTranscript = transcriptRows(evidence.machineTranscript, evidenceRows, {
    allowIncomplete,
  });
  digest(harnessAttestation.transcriptSha256, 'harnessAttestation.transcriptSha256', {
    allowZero: allowIncomplete,
  });
  if (
    !allowIncomplete &&
    harnessAttestation.transcriptSha256 !== computerUseTranscriptSha256(machineTranscript.journeys)
  )
    fail('harnessAttestation.transcriptSha256 does not bind machineTranscript');
  if (!allowIncomplete) {
    const packageBindingSha256 = computerUsePackageBindingSha256({
      sourceCommit: evidence.sourceCommit,
      sourceRunId: evidence.sourceRunId,
      artifacts: evidence.artifacts,
    });
    for (const [index, journey] of machineTranscript.journeys.entries()) {
      const packageEventIndex = journey.eventSequence.indexOf('PACKAGE_BOUND');
      if (journey.eventDigests[packageEventIndex] !== packageBindingSha256)
        fail(`machineTranscript.journeys[${index}] PACKAGE_BOUND digest is stale`);
    }
  }

  const expected = [
    [expectedSourceCommit, evidence.sourceCommit, 'sourceCommit'],
    [expectedSourceRunId, evidence.sourceRunId, 'sourceRunId'],
    [expectedEvidenceRunId, harnessAttestation.workflowRunId, 'evidence workflow run id'],
    [
      expectedEvidenceRunAttempt,
      harnessAttestation.workflowRunAttempt,
      'evidence workflow run attempt',
    ],
    [expectedWindowsArtifact, windows.artifactName, 'Windows artifact name'],
    [expectedMacosArtifact, artifacts.macos.artifactName, 'macOS artifact name'],
    [expectedWindowsPortableName, windows.portable.fileName, 'Windows portable file name'],
    [expectedWindowsPortableSha256, windows.portable.sha256, 'Windows portable SHA-256'],
    [expectedWindowsInstallerName, windows.installer.fileName, 'Windows installer file name'],
    [expectedWindowsInstallerSha256, windows.installer.sha256, 'Windows installer SHA-256'],
    [expectedMacosSha256, artifacts.macos.packageSha256, 'macOS package SHA-256'],
  ];
  for (const [wanted, actual, label] of expected)
    if (wanted !== undefined && wanted !== actual)
      fail(`${label} does not match the dispatched package`);

  return Object.freeze({
    issue: evidence.issue,
    sourceCommit: evidence.sourceCommit,
    sourceRunId: evidence.sourceRunId,
    corePassed: evidence.ac28Core.every((row) => row.status === 'PASS'),
    safetyPassed: evidence.ac29Safety.every((row) => row.status === 'PASS'),
    compatibility: Object.freeze({
      passed: evidence.ac30Compatibility.filter((row) => row.status === 'PASS').length,
      failed: evidence.ac30Compatibility.filter((row) => row.status === 'FAIL').length,
      skipped: evidence.ac30Compatibility.filter((row) => row.status === 'SKIP').length,
    }),
  });
}

function validFixture() {
  const passing = ({ id, passEvidenceCode }) => ({
    id,
    status: 'PASS',
    reasonCode: 'NONE',
    evidenceCode: passEvidenceCode,
  });
  const fixture = {
    schemaVersion: 3,
    issue: 333,
    sourceCommit: 'a'.repeat(40),
    sourceRunId: '1234',
    completedAt: '2026-08-30T00:00:00.000Z',
    artifacts: {
      windows: {
        sourceCommit: 'a'.repeat(40),
        sourceRunId: '1234',
        artifactName: 'signed-windows',
        portable: { fileName: 'Sprint-Coder-win32-x64-0.0.0.zip', sha256: 'b'.repeat(64) },
        installer: { fileName: 'Sprint-Coder-Installer.exe', sha256: '3'.repeat(64) },
      },
      macos: {
        sourceCommit: 'a'.repeat(40),
        sourceRunId: '1234',
        artifactName: 'notarized-macos',
        packageSha256: 'c'.repeat(64),
      },
    },
    harnessAttestation: {
      workflowPath: COMPUTER_USE_EVIDENCE_WORKFLOW,
      workflowRunId: '5678',
      workflowRunAttempt: 1,
      journeySetSha256: COMPUTER_USE_JOURNEY_SET_SHA256,
      transcriptSha256: '0'.repeat(64),
    },
    machineTranscript: { schemaVersion: COMPUTER_USE_TRANSCRIPT_SCHEMA_VERSION, journeys: [] },
    providerBinding: {
      connectionIdDigest: 'd'.repeat(64),
      modelIdDigest: 'e'.repeat(64),
      endpointDigest: 'f'.repeat(64),
      catalogDigest: '1'.repeat(64),
      policyEpoch: 7,
      adapterVersion: COMPUTER_USE_PROVIDER_ADAPTER_VERSION,
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
    },
    privacy: {
      databaseRawScreenshotAbsent: true,
      databaseRawAccessibilityTreeAbsent: true,
      databaseTypedTextAbsent: true,
      logRawScreenshotAbsent: true,
      logRawAccessibilityTreeAbsent: true,
      logTypedTextAbsent: true,
      telemetryRawScreenAbsent: true,
      crashArtifactRawScreenAbsent: true,
      providerRawOutputAbsent: true,
      providerReasoningAbsent: true,
      evidenceArtifactJsonOnly: true,
    },
    ac28Core: COMPUTER_USE_CORE_JOURNEYS.map(passing),
    ac29Safety: COMPUTER_USE_SAFETY_JOURNEYS.map(passing),
    ac30Compatibility: COMPUTER_USE_COMPATIBILITY_JOURNEYS.map(({ id, rules }) => {
      const useSkip = rules.PASS === undefined || id === 'AC-30-PROVIDER-JSON';
      const selected = useSkip ? rules.SKIP : rules.PASS;
      const status = useSkip ? 'SKIP' : 'PASS';
      return {
        id,
        status,
        reasonCode: selected.reasonCodes[0],
        evidenceCode: selected.evidenceCode,
      };
    }),
  };
  const evidenceRows = [...fixture.ac28Core, ...fixture.ac29Safety, ...fixture.ac30Compatibility];
  const packageBindingSha256 = computerUsePackageBindingSha256({
    sourceCommit: fixture.sourceCommit,
    sourceRunId: fixture.sourceRunId,
    artifacts: fixture.artifacts,
  });
  fixture.machineTranscript.journeys = evidenceRows.map(({ id, status }) => {
    const eventSequence = canonicalEventSequence(id, status);
    const eventDigests = eventSequence.map((event, index) => sha256(`${id}:${event}:${index}`));
    eventDigests[eventSequence.indexOf('PACKAGE_BOUND')] = packageBindingSha256;
    return {
      id,
      eventSequence,
      eventDigests,
      eventSequenceSha256: computerUseEventSequenceSha256(id, eventSequence, eventDigests),
    };
  });
  fixture.harnessAttestation.transcriptSha256 = computerUseTranscriptSha256(
    fixture.machineTranscript.journeys,
  );
  return fixture;
}

function canonicalPendingTemplate() {
  let template;
  try {
    template = JSON.parse(readFileSync(CANONICAL_PENDING_TEMPLATE_URL, 'utf8'));
  } catch (error) {
    fail(`canonical all-pending template is unavailable: ${error.message}`);
  }
  return template;
}

function assertCanonicalPendingTemplate(evidence) {
  const template = canonicalPendingTemplate();
  if (JSON.stringify(evidence) !== JSON.stringify(template))
    fail('allow-incomplete accepts only the canonical all-pending template');
}

function selfTest() {
  const fixture = validFixture();
  const completedBindings = {
    expectedSourceCommit: fixture.sourceCommit,
    expectedSourceRunId: fixture.sourceRunId,
    expectedEvidenceRunId: fixture.harnessAttestation.workflowRunId,
    expectedEvidenceRunAttempt: fixture.harnessAttestation.workflowRunAttempt,
    expectedWindowsArtifact: fixture.artifacts.windows.artifactName,
    expectedMacosArtifact: fixture.artifacts.macos.artifactName,
    expectedWindowsPortableName: fixture.artifacts.windows.portable.fileName,
    expectedWindowsPortableSha256: fixture.artifacts.windows.portable.sha256,
    expectedWindowsInstallerName: fixture.artifacts.windows.installer.fileName,
    expectedWindowsInstallerSha256: fixture.artifacts.windows.installer.sha256,
    expectedMacosSha256: fixture.artifacts.macos.packageSha256,
  };
  const validateComplete = (candidate, overrides = {}) =>
    validateComputerUseFinalGateEvidence(candidate, {
      ...completedBindings,
      ...overrides,
    });
  assert.equal(validateComplete(fixture).corePassed, true);
  const handAuthored = structuredClone(fixture);
  delete handAuthored.harnessAttestation;
  assert.throws(() => validateComplete(handAuthored), /keys must be exactly.*harnessAttestation/u);
  assert.throws(
    () =>
      validateComplete(fixture, {
        expectedWindowsInstallerSha256: '4'.repeat(64),
      }),
    /Windows installer SHA-256 does not match/u,
  );
  assert.throws(
    () =>
      validateComplete({
        ...fixture,
        ac28Core: fixture.ac28Core.map((row, index) =>
          index === 0 ? { ...row, status: 'SKIP', reasonCode: 'NOT_RUN' } : row,
        ),
      }),
    /must PASS the final gate/u,
  );
  assert.throws(
    () =>
      validateComplete({
        ...fixture,
        ac29Safety: fixture.ac29Safety.map((row, index) =>
          index === 0 ? { ...row, evidenceCode: 'SELF_ATTESTED_PASS' } : row,
        ),
      }),
    /PASS must use evidenceCode SAME_OWNER_DIALOG_INVALIDATION_V1/u,
  );
  assert.throws(
    () =>
      validateComplete({
        ...fixture,
        providerBinding: { ...fixture.providerBinding, roundsAttempted: 4 },
      }),
    /exactly three attempted\/completed rounds/u,
  );
  assert.throws(
    () =>
      validateComplete({
        ...fixture,
        providerBinding: { ...fixture.providerBinding, fallbackUsed: true },
      }),
    /fallbackUsed must remain false/u,
  );
  assert.throws(
    () =>
      validateComplete({
        ...fixture,
        providerBinding: { ...fixture.providerBinding, adapterVersion: 'PENDING' },
      }),
    /adapterVersion must be computer-use-v1/u,
  );
  assert.throws(
    () =>
      validateComplete({
        ...fixture,
        ac30Compatibility: fixture.ac30Compatibility.map((row) =>
          row.id === 'AC-30-PROVIDER-JSON'
            ? {
                ...row,
                status: 'PASS',
                reasonCode: 'NONE',
                evidenceCode: 'PROVIDER_BOUNDED_JSON_V1',
              }
            : row,
        ),
      }),
    /exactly one Provider compatibility path must PASS/u,
  );
  assert.throws(
    () =>
      validateComplete({
        ...fixture,
        ac30Compatibility: fixture.ac30Compatibility.slice(0, -1),
      }),
    /must contain exactly 9 rows/u,
  );
  assert.throws(
    () => validateComplete({ ...fixture, rawScreen: 'forbidden' }),
    /keys must be exactly/u,
  );
  console.log('Computer Use final gate evidence self-test passed.');
}

function parseArguments(argv) {
  const options = Object.create(null);
  const booleanOptions = new Set(VERIFIER_BOOLEAN_OPTIONS);
  const valueOptions = new Set(VERIFIER_VALUE_OPTIONS);
  const knownOptions = new Set([...booleanOptions, ...valueOptions]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) fail(`unknown argument ${argument}`);
    const key = argument.slice(2);
    if (!knownOptions.has(key)) fail(`unknown option ${argument}`);
    if (Object.prototype.hasOwnProperty.call(options, key)) fail(`duplicate option ${argument}`);
    if (booleanOptions.has(key)) {
      options[key] = true;
    } else if (valueOptions.has(key)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) fail(`${argument} requires a value`);
      options[key] = value;
      index += 1;
    }
  }
  return options;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options['self-test']) {
    if (Object.keys(options).length !== 1)
      fail('--self-test cannot be combined with other options');
    selfTest();
    return;
  }
  if (typeof options.evidence !== 'string') fail('--evidence is required');
  if (
    options['allow-incomplete'] !== true &&
    options['trusted-workflow-attestation-verified'] !== true
  )
    fail('completed evidence requires external GitHub artifact attestation verification');
  const bytes = readFileSync(options.evidence);
  if (bytes.length > MAX_EVIDENCE_BYTES) fail(`evidence exceeds ${MAX_EVIDENCE_BYTES} bytes`);
  const text = bytes.toString('utf8');
  let candidate;
  try {
    candidate = parseJsonRejectingDuplicateKeys(text);
  } catch (error) {
    fail(error instanceof Error ? error.message : 'raw JSON is malformed');
  }
  if (options['allow-incomplete'] === true) {
    if (VERIFIER_VALUE_OPTIONS.some((key) => key !== 'evidence' && options[key] !== undefined))
      fail('--allow-incomplete accepts only the canonical all-pending template');
    assertCanonicalPendingTemplate(candidate);
  }
  const result = validateComputerUseFinalGateEvidence(candidate, {
    allowIncomplete: options['allow-incomplete'] === true,
    expectedSourceCommit: options['source-commit'],
    expectedSourceRunId: options['source-run-id'],
    expectedEvidenceRunId: options['evidence-run-id'],
    expectedEvidenceRunAttempt:
      options['evidence-run-attempt'] === undefined
        ? undefined
        : Number(options['evidence-run-attempt']),
    expectedWindowsArtifact: options['windows-artifact'],
    expectedMacosArtifact: options['macos-artifact'],
    expectedWindowsPortableName: options['windows-portable-name'],
    expectedWindowsPortableSha256: options['windows-portable-sha256'],
    expectedWindowsInstallerName: options['windows-installer-name'],
    expectedWindowsInstallerSha256: options['windows-installer-sha256'],
    expectedMacosSha256: options['macos-sha256'],
  });
  console.log(
    JSON.stringify({
      issue: result.issue,
      sourceCommit: result.sourceCommit,
      sourceRunId: result.sourceRunId,
      corePassed: result.corePassed,
      safetyPassed: result.safetyPassed,
      compatibility: result.compatibility,
    }),
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
