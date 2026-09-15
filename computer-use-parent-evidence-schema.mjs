import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';

// These are references to required assertions, not additional journeys for every app/model pair.
export const COMPUTER_USE_PARENT_COVERAGE = Object.freeze(
  [
    ...['windows', 'macos'].flatMap((platform) =>
      [
        'FULL_ACCESS_FIVE_CARD_ZERO',
        'REMEMBERED_ONE_CLICK',
        'PICKER_RESUME',
        'SCROLL',
        'FOCUS_LOSS',
        'TYPE_MID_STOP',
        'WINDOW_ESCAPE_DENIED',
        'REPRESENTATIVE_HARD_BOUNDARY',
      ].map((requirement) =>
        Object.freeze({ id: `${platform}:${requirement}`, platform, ac: 'AC-28' }),
      ),
    ),
    { id: 'either:THIRD_PARTY_STATE_CHANGE', platform: 'either', ac: 'AC-28' },
    { id: 'either:SUPERVISED_BOUNDED_GRANT', platform: 'either', ac: 'AC-28' },
    ...[
      'PICKER_TOKEN_REPLAY',
      'NATIVE_PREACCEPT_REJECT',
      'GRANT_SESSION_DIALOG_RACE',
      'PROTOCOL_ABI_DIGEST_MISMATCH',
      'CAPTURE_UNAVAILABLE',
      'OS_PERMISSION_DENIED',
      'PROVIDER_MALFORMED',
      'PROVIDER_OVERSIZE',
      'PROVIDER_EXTRA_TEXT',
    ].map((requirement) =>
      Object.freeze({ id: `tests:${requirement}`, platform: 'tests', ac: 'AC-29' }),
    ),
  ].map(Object.freeze),
);

export const COMPUTER_USE_OWNED_RUN_FACT_KEYS = Object.freeze([
  'runIdDigest',
  'platform',
  'sourceCommit',
  'packageSha256',
  'executableSha256',
  'signerIdentityDigest',
  'processIdentityDigest',
  'nativeManifestDigest',
  'sessionIdDigest',
  'eventChainDigest',
  'privacyReportDigest',
]);
const SHA256 = /^(?!0{64}$)[a-f0-9]{64}$/u;
const SOURCE = /^(?!0{40}$)[a-f0-9]{40}$/u;
const semantic = ['invoke', 'set_text', 'select', 'toggle', 'expand_collapse'];
const actions = [...semantic, 'scroll', 'click', 'type', 'key'];

function fail() {
  // Do not reflect producer strings, unexpected field names, or payloads into diagnostics.
  throw new Error('Computer Use parent closure is invalid');
}
function keys(value, expected) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort())
  )
    fail();
}
function hash(value) {
  if (typeof value !== 'string' || !SHA256.test(value)) fail();
}
function integer(value, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail();
}

export function createPendingComputerUseParentClosure() {
  return {
    providerRuns: { windows: null, macos: null },
    coverage: Object.fromEntries(COMPUTER_USE_PARENT_COVERAGE.map(({ id }) => [id, null])),
  };
}

export function computerUseParentClosureSha256(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function packageDigest(artifacts, platform) {
  return platform === 'windows' ? artifacts.windows.portable.sha256 : artifacts.macos.packageSha256;
}

function validateRun(run, platform, context) {
  keys(run, [
    'schemaVersion',
    ...COMPUTER_USE_OWNED_RUN_FACT_KEYS,
    'binding',
    'rounds',
    'egressConsentDigest',
    'costLimitDigest',
    'providerPath',
  ]);
  if (
    run.schemaVersion !== 1 ||
    run.platform !== (platform === 'windows' ? 'win32' : 'darwin') ||
    !SOURCE.test(run.sourceCommit) ||
    run.sourceCommit !== context.sourceCommit ||
    run.packageSha256 !== packageDigest(context.artifacts, platform)
  )
    fail();
  if (!['structured', 'bounded_json'].includes(run.providerPath)) fail();
  for (const key of [...COMPUTER_USE_OWNED_RUN_FACT_KEYS, 'egressConsentDigest', 'costLimitDigest'])
    if (key !== 'platform' && key !== 'sourceCommit') hash(run[key]);

  const binding = run.binding;
  keys(binding, [
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
  ]);
  for (const field of [
    'connectionIdDigest',
    'modelIdDigest',
    'endpointDigest',
    'catalogDigest',
    'sessionIdDigest',
  ])
    hash(binding[field]);
  integer(binding.policyEpoch);
  if (
    binding.sessionIdDigest !== run.sessionIdDigest ||
    binding.adapterVersion !== 'computer-use-v1' ||
    binding.selectedFromCurrentTask !== true ||
    binding.bindingStable !== true ||
    binding.preflightAttempts !== 1 ||
    binding.preflightPassed !== true ||
    binding.roundsAttempted !== 3 ||
    binding.roundsCompleted !== 3 ||
    binding.isOpenRouter !== false ||
    binding.fallbackUsed !== false ||
    binding.credentialChanged !== false
  )
    fail();
  if (platform === 'windows' && !isDeepStrictEqual(binding, context.primaryProviderBinding)) fail();
  if (!Array.isArray(run.rounds) || run.rounds.length !== 3) fail();
  const requests = new Set();
  for (const [index, round] of run.rounds.entries()) {
    keys(round, [
      'round',
      'revision',
      'updatedRevision',
      'actionClass',
      'actionDigest',
      'nativeActionDigest',
      'nativeRequestDigests',
      'nativeReceiptDigest',
      'brokerDecisionDigest',
      'latencyMs',
      'ttlVerified',
      'result',
    ]);
    integer(round.revision, 1);
    integer(round.updatedRevision, 1);
    integer(round.latencyMs);
    if (
      round.round !== index + 1 ||
      round.updatedRevision <= round.revision ||
      (index > 0 && round.revision < run.rounds[index - 1].updatedRevision) ||
      !actions.includes(round.actionClass) ||
      round.actionDigest !== round.nativeActionDigest ||
      round.ttlVerified !== true ||
      round.result !== 'completed'
    )
      fail();
    for (const field of [
      'actionDigest',
      'nativeActionDigest',
      'nativeReceiptDigest',
      'brokerDecisionDigest',
    ])
      hash(round[field]);
    if (
      !Array.isArray(round.nativeRequestDigests) ||
      round.nativeRequestDigests.length === 0 ||
      round.nativeRequestDigests.length > 4096
    )
      fail();
    for (const requestDigest of round.nativeRequestDigests) {
      hash(requestDigest);
      if (requests.has(requestDigest)) fail();
      requests.add(requestDigest);
    }
  }
  if (
    !run.rounds.some((round) => semantic.includes(round.actionClass)) ||
    !run.rounds.some((round) => ['type', 'set_text', 'scroll'].includes(round.actionClass))
  )
    fail();
}

/**
 * Called by the real generator/verifier. The producer envelope never authenticates itself.
 * verifiedOwnedRunFacts is an out-of-band input from the protected runner, not a JSON flag.
 * A digest reference being present does not prove its assertion passed or its bytes were inspected.
 */
export function validateComputerUseParentClosure(value, context) {
  keys(value, ['providerRuns', 'coverage']);
  keys(value.providerRuns, ['windows', 'macos']);
  keys(
    value.coverage,
    COMPUTER_USE_PARENT_COVERAGE.map(({ id }) => id),
  );
  const unmeasured = [];
  let ownedFactsVerified = context.verifiedOwnedRunFacts !== undefined;
  if (ownedFactsVerified) keys(context.verifiedOwnedRunFacts, ['windows', 'macos']);
  for (const platform of ['windows', 'macos']) {
    const run = value.providerRuns[platform];
    if (run === null) {
      unmeasured.push(`providerRuns.${platform}`);
      ownedFactsVerified = false;
      continue;
    }
    validateRun(run, platform, context);
    const expected = context.verifiedOwnedRunFacts?.[platform];
    if (expected === undefined || expected === null) ownedFactsVerified = false;
    else {
      keys(expected, COMPUTER_USE_OWNED_RUN_FACT_KEYS);
      if (
        !COMPUTER_USE_OWNED_RUN_FACT_KEYS.every((key) => isDeepStrictEqual(run[key], expected[key]))
      )
        fail();
    }
  }
  const { windows, macos } = value.providerRuns;
  if (
    windows !== null &&
    macos !== null &&
    (windows.sessionIdDigest === macos.sessionIdDigest ||
      windows.runIdDigest === macos.runIdDigest ||
      windows.processIdentityDigest === macos.processIdentityDigest)
  )
    fail();
  for (const specification of COMPUTER_USE_PARENT_COVERAGE) {
    const reference = value.coverage[specification.id];
    if (reference === null) {
      unmeasured.push(specification.id);
      continue;
    }
    keys(reference, ['sourceCommit', 'platform', 'packageSha256', 'evidenceDigest', 'proofKind']);
    if (!SOURCE.test(reference.sourceCommit) || reference.sourceCommit !== context.sourceCommit)
      fail();
    hash(reference.evidenceDigest);
    if (specification.platform === 'tests') {
      if (
        !['unit', 'integration', 'native'].includes(reference.proofKind) ||
        reference.platform !== null ||
        reference.packageSha256 !== null
      )
        fail();
    } else {
      if (
        !['windows', 'macos'].includes(reference.platform) ||
        reference.proofKind !== 'core' ||
        (specification.platform !== 'either' && reference.platform !== specification.platform) ||
        reference.packageSha256 !== packageDigest(context.artifacts, reference.platform)
      )
        fail();
      hash(reference.packageSha256);
    }
  }
  return Object.freeze({
    structureValid: true,
    referencesComplete: unmeasured.length === 0,
    ownedFactsVerified,
    assertionsVerified:
      ownedFactsVerified &&
      context.verifiedClosureSha256 !== undefined &&
      context.verifiedClosureSha256 === computerUseParentClosureSha256(value),
    unmeasured: Object.freeze(unmeasured),
  });
}
