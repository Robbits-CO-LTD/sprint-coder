import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import pending from '../../tasks/evidence/issue-333-computer-use-final-gate-template.json';

const root = resolve(__dirname, '../..');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type ClosureResult = {
  structureValid: boolean;
  referencesComplete: boolean;
  ownedFactsVerified: boolean;
  assertionsVerified: boolean;
  unmeasured: readonly string[];
};
let helper: {
  COMPUTER_USE_PARENT_COVERAGE: Array<{ id: string; platform: string; ac: string }>;
  COMPUTER_USE_OWNED_RUN_FACT_KEYS: string[];
  createPendingComputerUseParentClosure: () => unknown;
  computerUseParentClosureSha256: (closure: unknown) => string;
  validateComputerUseParentClosure: (closure: unknown, context: unknown) => ClosureResult;
};
let verifier: {
  validateComputerUseFinalGateEvidence: (candidate: unknown, options: unknown) => unknown;
};
beforeAll(async () => {
  helper = await import(
    pathToFileURL(resolve(root, 'computer-use-parent-evidence-schema.mjs')).href
  );
  verifier = await import(pathToFileURL(resolve(root, 'verify-computer-use-final-gate.mjs')).href);
});

// Fixture claims are deliberately synthetic. Even complete references are not measured acceptance.
function fixture() {
  const sourceCommit = 'a'.repeat(40);
  const artifacts = {
    windows: { portable: { sha256: 'b'.repeat(64) } },
    macos: { packageSha256: 'd'.repeat(64) },
  };
  const run = (platform: 'win32' | 'darwin') => {
    const sessionIdDigest = hash(`${platform}:session`);
    const binding = {
      connectionIdDigest: hash(`${platform}:connection`),
      modelIdDigest: hash(`${platform}:model`),
      endpointDigest: hash(`${platform}:endpoint`),
      catalogDigest: hash(`${platform}:catalog`),
      policyEpoch: 2,
      adapterVersion: 'computer-use-v1',
      sessionIdDigest,
      selectedFromCurrentTask: true,
      bindingStable: true,
      preflightAttempts: 1,
      preflightPassed: true,
      roundsAttempted: 3,
      roundsCompleted: 3,
      isOpenRouter: false,
      fallbackUsed: false,
      credentialChanged: false,
    };
    return {
      schemaVersion: 1,
      platform,
      sourceCommit,
      sessionIdDigest,
      providerPath: 'structured',
      packageSha256:
        platform === 'win32' ? artifacts.windows.portable.sha256 : artifacts.macos.packageSha256,
      ...Object.fromEntries(
        [
          'runIdDigest',
          'executableSha256',
          'signerIdentityDigest',
          'processIdentityDigest',
          'nativeManifestDigest',
          'eventChainDigest',
          'privacyReportDigest',
          'egressConsentDigest',
          'costLimitDigest',
        ].map((key) => [key, hash(`${platform}:${key}`)]),
      ),
      binding,
      rounds: ['invoke', 'type', 'scroll'].map((actionClass, index) => ({
        round: index + 1,
        revision: index + 1,
        updatedRevision: index + 2,
        actionClass,
        actionDigest: hash(`${platform}:action:${index}`),
        nativeActionDigest: hash(`${platform}:action:${index}`),
        nativeRequestDigests:
          index === 1
            ? [hash(`${platform}:request:${index}:0`), hash(`${platform}:request:${index}:1`)]
            : [hash(`${platform}:request:${index}`)],
        nativeReceiptDigest: hash(`${platform}:receipt:${index}`),
        brokerDecisionDigest: hash(`${platform}:broker:${index}`),
        latencyMs: 12,
        ttlVerified: true,
        result: 'completed',
      })),
    };
  };
  const windows = run('win32');
  const macos = run('darwin');
  const closure = {
    providerRuns: { windows, macos },
    coverage: Object.fromEntries(
      helper.COMPUTER_USE_PARENT_COVERAGE.map(({ id, platform }) => {
        const os = platform === 'macos' ? 'macos' : 'windows';
        return [
          id,
          {
            sourceCommit,
            platform: platform === 'tests' ? null : os,
            packageSha256:
              platform === 'tests'
                ? null
                : os === 'windows'
                  ? artifacts.windows.portable.sha256
                  : artifacts.macos.packageSha256,
            evidenceDigest: hash(id),
            proofKind: platform === 'tests' ? 'integration' : 'core',
          },
        ];
      }),
    ),
  };
  return {
    closure,
    context: { sourceCommit, artifacts, primaryProviderBinding: structuredClone(windows.binding) },
  };
}

function cli(script: string, candidate: unknown, args: string[]) {
  const directory = mkdtempSync(resolve(tmpdir(), 'cu-parent-schema-'));
  const path = resolve(directory, 'candidate.json');
  try {
    writeFileSync(path, JSON.stringify(candidate), { mode: 0o600 });
    return spawnSync(process.execPath, [resolve(root, script), args[0]!, path, ...args.slice(1)], {
      encoding: 'utf8',
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('canonical parent evidence closure', () => {
  it('separates structure, completeness and externally verified assertions', () => {
    const { closure, context } = fixture();
    expect(helper.validateComputerUseParentClosure(closure, context)).toMatchObject({
      structureValid: true,
      referencesComplete: true,
      ownedFactsVerified: false,
      assertionsVerified: false,
    });
    const owned = Object.fromEntries(
      Object.entries(closure.providerRuns).map(([platform, run]) => [
        platform,
        Object.fromEntries(
          helper.COMPUTER_USE_OWNED_RUN_FACT_KEYS.map((key) => [key, Reflect.get(run, key)]),
        ),
      ]),
    );
    expect(
      helper.validateComputerUseParentClosure(closure, {
        ...context,
        verifiedOwnedRunFacts: owned,
      }),
    ).toMatchObject({
      ownedFactsVerified: true,
      assertionsVerified: false,
    });
    expect(
      helper.validateComputerUseParentClosure(closure, {
        ...context,
        verifiedOwnedRunFacts: owned,
        verifiedClosureSha256: helper.computerUseParentClosureSha256(closure),
      }),
    ).toMatchObject({ assertionsVerified: true });
    const verifiedClosureSha256 = helper.computerUseParentClosureSha256(closure);
    closure.providerRuns.macos.rounds[0]!.latencyMs += 1;
    expect(
      helper.validateComputerUseParentClosure(closure, {
        ...context,
        verifiedOwnedRunFacts: owned,
        verifiedClosureSha256,
      }).assertionsVerified,
    ).toBe(false);
    Object.assign(closure.providerRuns.macos, { executableSha256: hash('substituted executable') });
    expect(() =>
      helper.validateComputerUseParentClosure(closure, {
        ...context,
        verifiedOwnedRunFacts: owned,
      }),
    ).toThrow('parent closure is invalid');
  });

  it('holds partial null without accepting a missing platform key', () => {
    const { closure, context } = fixture();
    const partial = {
      ...closure,
      providerRuns: { windows: closure.providerRuns.windows, macos: null },
    };
    expect(helper.validateComputerUseParentClosure(partial, context)).toMatchObject({
      referencesComplete: false,
      ownedFactsVerified: false,
      unmeasured: ['providerRuns.macos'],
    });
    expect(() =>
      helper.validateComputerUseParentClosure(
        { ...closure, providerRuns: { windows: closure.providerRuns.windows } },
        context,
      ),
    ).toThrow();
  });

  it.each([
    'copy',
    'relabeled_copy',
    'os',
    'source',
    'package',
    'session',
    'process',
    'round',
    'revision',
    'action',
    'retry',
    'replayed_request',
    'attested',
  ])('rejects %s substitution in the macOS run', (kind) => {
    const { closure, context } = fixture();
    const mac = closure.providerRuns.macos;
    if (kind === 'copy') closure.providerRuns.macos = structuredClone(closure.providerRuns.windows);
    if (kind === 'relabeled_copy')
      closure.providerRuns.macos = {
        ...structuredClone(closure.providerRuns.windows),
        platform: 'darwin',
        packageSha256: context.artifacts.macos.packageSha256,
      };
    if (kind === 'os') mac.platform = 'win32';
    if (kind === 'source') mac.sourceCommit = 'e'.repeat(40);
    if (kind === 'package') mac.packageSha256 = context.artifacts.windows.portable.sha256;
    if (kind === 'session') {
      mac.sessionIdDigest = closure.providerRuns.windows.sessionIdDigest;
      mac.binding.sessionIdDigest = mac.sessionIdDigest;
    }
    if (kind === 'process')
      Object.assign(mac, {
        processIdentityDigest: Reflect.get(closure.providerRuns.windows, 'processIdentityDigest'),
      });
    if (kind === 'round') mac.rounds.pop();
    if (kind === 'revision') mac.rounds[2]!.updatedRevision = mac.rounds[2]!.revision;
    if (kind === 'action') mac.rounds[0]!.nativeActionDigest = hash('other action');
    if (kind === 'retry') mac.binding.roundsAttempted = 4;
    if (kind === 'replayed_request')
      mac.rounds[1]!.nativeRequestDigests = [...mac.rounds[0]!.nativeRequestDigests];
    if (kind === 'attested') Object.assign(mac, { attested: true });
    expect(() => helper.validateComputerUseParentClosure(closure, context)).toThrow(
      'parent closure is invalid',
    );
  });

  it('requires exact deep equality of the Windows primary compatibility summary', () => {
    const { closure, context } = fixture();
    context.primaryProviderBinding.modelIdDigest = hash('different selected model');
    expect(() => helper.validateComputerUseParentClosure(closure, context)).toThrow();
  });

  it('keeps unmapped canonical requirements separate from legacy row PASS', () => {
    const { closure, context } = fixture();
    for (const spec of helper.COMPUTER_USE_PARENT_COVERAGE) {
      const candidate = structuredClone(closure);
      Object.assign(candidate.coverage, { [spec.id]: null });
      expect(helper.validateComputerUseParentClosure(candidate, context).unmeasured).toContain(
        spec.id,
      );
    }
    closure.coverage['tests:PICKER_TOKEN_REPLAY']!.proofKind = 'core';
    expect(() => helper.validateComputerUseParentClosure(closure, context)).toThrow();
  });

  it.each(['fallbackUsed', 'credentialChanged', 'isOpenRouter'] as const)(
    'rejects macOS %s independently of the Windows summary',
    (field) => {
      const { closure, context } = fixture();
      closure.providerRuns.macos.binding[field] = true;
      expect(() => helper.validateComputerUseParentClosure(closure, context)).toThrow();
    },
  );

  it('preserves the exact legacy pending template but rejects legacy completed evidence', () => {
    const { parentClosure: omitted, ...legacy } = pending;
    expect(omitted).toBeDefined();
    legacy.schemaVersion = 3;
    expect(
      cli('verify-computer-use-final-gate.mjs', legacy, ['--evidence', '--allow-incomplete'])
        .status,
    ).toBe(0);
    expect(() => verifier.validateComputerUseFinalGateEvidence(legacy, {})).toThrow(
      'schema v3 completed evidence is retired',
    );
    legacy.completedAt = '2026-09-15T00:00:00.000Z';
    expect(
      cli('verify-computer-use-final-gate.mjs', legacy, ['--evidence', '--allow-incomplete'])
        .status,
    ).not.toBe(0);
  });

  it('routes real generator capture v2 through the closure validator', () => {
    const capture = {
      schemaVersion: 2,
      completedAt: pending.completedAt,
      providerBinding: pending.providerBinding,
      privacy: pending.privacy,
      parentClosure: helper.createPendingComputerUseParentClosure(),
      journeys: [...pending.ac28Core, ...pending.ac29Safety, ...pending.ac30Compatibility].map(
        (row) => {
          const id = row.id;
          const observed = id.startsWith('AC-28-PROVIDER-')
            ? ['PROVIDER_BINDING_RECORDED', 'PROVIDER_RESULT_RECORDED']
            : id.startsWith('AC-28-')
              ? ['TARGET_IDENTITY_RECORDED', 'OBSERVATION_RECORDED', 'ACTION_RESULT_RECORDED']
              : id === 'AC-29-PRIVACY-NONPERSISTENCE'
                ? ['PERSISTENCE_SURFACES_SCANNED']
                : /AC-29-(UNSIGNED-WINDOWS|ADHOC-MACOS)-FAIL-CLOSED/u.test(id)
                  ? ['CAPABILITY_PROBE_RECORDED']
                  : id.startsWith('AC-29-')
                    ? [
                        'OBSERVATION_RECORDED',
                        'GUARD_DECISION_RECORDED',
                        'NATIVE_INPUT_COUNT_RECORDED',
                      ]
                    : ['COMPATIBILITY_PROBE_RECORDED'];
          const eventSequence = [
            'JOURNEY_STARTED',
            'PACKAGE_BOUND',
            ...(row.status === 'SKIP'
              ? ['UNSUPPORTED_BOUNDARY_RECORDED']
              : [...observed, row.status === 'PASS' ? 'ASSERTION_PASSED' : 'ASSERTION_FAILED']),
            'JOURNEY_FINISHED',
          ];
          return { ...row, eventSequence, eventDigests: eventSequence.map(hash) };
        },
      ),
    };
    const valid = cli('generate-computer-use-final-gate-evidence.mjs', capture, [
      '--capture',
      '--validate-capture-only',
    ]);
    expect(valid.status, valid.stderr).toBe(0);
    capture.parentClosure = {
      providerRuns: { windows: null },
      coverage: pending.parentClosure.coverage,
    };
    const invalid = cli('generate-computer-use-final-gate-evidence.mjs', capture, [
      '--capture',
      '--validate-capture-only',
    ]);
    expect(invalid.status).not.toBe(0);
    expect(invalid.stderr).toContain('parent closure is invalid');
  });
});
