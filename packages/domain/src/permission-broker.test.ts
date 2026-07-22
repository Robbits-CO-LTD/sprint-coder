import { describe, expect, it } from 'vitest';
import {
  PermissionBroker,
  createSessionGrant,
  evaluatePermissionPolicy,
  evaluateShellSegments,
  expandAccessPreset,
  parseShellSegments,
  permissionRequestFingerprint,
  revalidateExecutionPermit,
  revokeCapability,
  type PermissionRequest,
  type CapabilityCeiling,
  type PermissionRule,
} from './index';

const NOW = '2026-07-22T12:00:00.000Z';
const PATH_DIGEST = 'a'.repeat(64);
const EXECUTION_DIGEST = 'b'.repeat(64);
const REVIEWER_INPUT_DIGEST = 'c'.repeat(64);

const workspaceWriteRequest = {
  taskId: 'task-1',
  subjectId: 'leader',
  capability: 'workspace.write',
  resource: {
    kind: 'workspace-path',
    workspaceId: 'workspace-1',
    canonicalPath: '/workspace/src/app.ts',
    identityDigest: PATH_DIGEST,
    classification: 'workspace',
  },
  operation: 'write',
  providerEgress: 'none',
  sandboxProfile: 'workspace-write',
  executionSpecDigest: EXECUTION_DIGEST,
  reviewerInputDigest: REVIEWER_INPUT_DIGEST,
  risk: 'low',
} as const;

const permissiveCeiling = {
  entries: [
    {
      capability: 'workspace.read',
      resourceSet: { kind: 'workspace', workspaceId: 'workspace-1' },
      operations: ['read'],
      expiresAt: '2026-07-22T13:00:00.000Z',
      providerEgress: ['none'],
      sandboxProfiles: ['read-only', 'workspace-write'],
    },
    {
      capability: 'workspace.write',
      resourceSet: { kind: 'workspace', workspaceId: 'workspace-1' },
      operations: ['write'],
      expiresAt: '2026-07-22T13:00:00.000Z',
      providerEgress: ['none'],
      sandboxProfiles: ['workspace-write'],
    },
    {
      capability: 'shell.execute',
      resourceSet: { kind: 'workspace', workspaceId: 'workspace-1' },
      operations: ['execute'],
      expiresAt: '2026-07-22T13:00:00.000Z',
      providerEgress: ['none'],
      sandboxProfiles: ['workspace-write'],
    },
  ],
  maxWorkerDepth: 2,
  maxConcurrentWorkers: 4,
} as const;

function basePolicy() {
  return {
    managedDeny: [],
    projectDeny: [],
    parentCeiling: permissiveCeiling,
    modeCeiling: permissiveCeiling,
    sandbox: { feasible: true, profile: 'workspace-write' },
    rememberedGrants: [],
    allowRules: [],
    approvalPolicy: 'ask',
    policyEpoch: 4,
  } as const;
}

function reviewerAllow(request: PermissionRequest = workspaceWriteRequest) {
  return {
    reviewRequestId: 'review-request-1',
    turnId: 'turn-1',
    callId: 'call-1',
    decision: 'allow_once',
    reason: 'reviewer_safe',
    requestFingerprint: permissionRequestFingerprint(request),
    executionSpecDigest: request.executionSpecDigest,
    policyEpoch: 4,
    model: 'reviewer-v1',
    templateVersion: '1',
    inputDigest: request.reviewerInputDigest,
    decisionNonce: 'decision-nonce-0001',
  } as const;
}

describe('PermissionBroker policy evaluation', () => {
  it('evaluates every policy stage in the specified order and records an audit reason', () => {
    const result = evaluatePermissionPolicy({
      request: workspaceWriteRequest,
      policy: basePolicy(),
      now: NOW,
    });

    expect(result).toMatchObject({
      decision: 'approval_required',
      reason: 'approval_policy_ask',
      policyEpoch: 4,
      evaluationTrace: [
        'managed-deny',
        'project-deny',
        'parent-ceiling',
        'mode-ceiling',
        'sandbox',
        'remembered-grant',
        'narrow-allow',
        'approval-policy',
      ],
    });
  });

  it.each([
    ['managedDeny', 'managed_deny'],
    ['projectDeny', 'project_deny'],
  ] as const)(
    '%s is stronger than a remembered grant, allow rule, and reviewer allow',
    (stage, reason) => {
      const exactRule = {
        capability: 'workspace.write',
        resourceSet: { kind: 'path-exact', canonicalPath: '/workspace/src/app.ts' },
        operations: ['write'],
      } as const;
      const grant = createSessionGrant({
        id: 'grant-1',
        subjectId: 'leader',
        capability: 'workspace.write',
        resourceSet: exactRule.resourceSet,
        operations: ['write'],
        scope: 'task',
        expiresAt: '2026-07-22T13:00:00.000Z',
        policyEpoch: 4,
        providerEgress: ['none'],
        sandboxProfiles: ['workspace-write'],
      });

      const result = evaluatePermissionPolicy({
        request: workspaceWriteRequest,
        policy: {
          ...basePolicy(),
          [stage]: [exactRule],
          rememberedGrants: [grant],
          allowRules: [exactRule],
          approvalPolicy: 'auto',
          reviewerDecision: reviewerAllow(),
        },
        now: NOW,
      });

      expect(result).toMatchObject({ decision: 'deny', reason });
    },
  );

  it.each([
    ['resource set', { resourceSet: { kind: 'path-prefix', canonicalPath: '/workspace/docs' } }],
    ['operation', { operations: ['read'] }],
    ['expiry', { expiresAt: '2026-07-22T11:59:59.999Z' }],
    ['provider egress', { providerEgress: ['trusted-local'] }],
    ['sandbox profile', { sandboxProfiles: ['read-only'] }],
  ] as const)(
    'parent capability lattice rejects a request outside its %s dimension',
    (_dimension, override) => {
      const result = evaluatePermissionPolicy({
        request: workspaceWriteRequest,
        policy: {
          ...basePolicy(),
          parentCeiling: {
            ...permissiveCeiling,
            entries: permissiveCeiling.entries.map((entry) =>
              entry.capability === 'workspace.write' ? { ...entry, ...override } : entry,
            ),
          },
          allowRules: [
            {
              capability: 'workspace.write',
              resourceSet: { kind: 'path-prefix', canonicalPath: '/workspace' },
              operations: ['write'],
            },
          ],
        },
        now: NOW,
      });

      expect(result).toMatchObject({ decision: 'deny', reason: 'parent_ceiling' });
    },
  );

  it('does not let an allow rule or auto reviewer cross the mode or sandbox ceiling', () => {
    const allowRule = {
      capability: 'workspace.write',
      resourceSet: { kind: 'path-prefix', canonicalPath: '/workspace' },
      operations: ['write'],
    } as const;

    const modeDenied = evaluatePermissionPolicy({
      request: workspaceWriteRequest,
      policy: {
        ...basePolicy(),
        modeCeiling: {
          ...permissiveCeiling,
          entries: permissiveCeiling.entries.filter(
            ({ capability }) => capability === 'workspace.read',
          ),
        },
        allowRules: [allowRule],
        approvalPolicy: 'auto',
        reviewerDecision: reviewerAllow(),
      },
      now: NOW,
    });
    const sandboxDenied = evaluatePermissionPolicy({
      request: workspaceWriteRequest,
      policy: {
        ...basePolicy(),
        sandbox: { feasible: false, profile: 'workspace-write' },
        allowRules: [allowRule],
        approvalPolicy: 'auto',
        reviewerDecision: reviewerAllow(),
      },
      now: NOW,
    });

    expect(modeDenied).toMatchObject({ decision: 'deny', reason: 'mode_ceiling' });
    expect(sandboxDenied).toMatchObject({ decision: 'deny', reason: 'sandbox_infeasible' });
  });

  it('reaches the reviewer only after routing and only accepts allow-once', () => {
    const result = evaluatePermissionPolicy({
      request: workspaceWriteRequest,
      policy: {
        ...basePolicy(),
        approvalPolicy: 'auto',
        reviewerDecision: reviewerAllow(),
      },
      now: NOW,
    });

    expect(result).toMatchObject({
      decision: 'allow_once',
      reason: 'reviewer_safe',
      evaluationTrace: [
        'managed-deny',
        'project-deny',
        'parent-ceiling',
        'mode-ceiling',
        'sandbox',
        'remembered-grant',
        'narrow-allow',
        'approval-policy',
        'reviewer',
      ],
    });
    const consumed = new Set<string>();
    const consume = (token: string): boolean => {
      if (consumed.has(token)) return false;
      consumed.add(token);
      return true;
    };
    expect(
      revalidateExecutionPermit({
        permit: result.permit!,
        request: workspaceWriteRequest,
        policyEpoch: 4,
        now: NOW,
        consumeOneTimeToken: consume,
      }),
    ).toEqual({ valid: true });
    expect(
      revalidateExecutionPermit({
        permit: result.permit!,
        request: workspaceWriteRequest,
        policyEpoch: 4,
        now: NOW,
        consumeOneTimeToken: consume,
      }),
    ).toEqual({ valid: false, reason: 'one_time_permit_unavailable_or_consumed' });
  });

  it('uses a fixed-size path-free reviewer request fingerprint', () => {
    const fingerprint = permissionRequestFingerprint(workspaceWriteRequest);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint).not.toContain(workspaceWriteRequest.resource.canonicalPath);
    const variants: PermissionRequest[] = [
      { ...workspaceWriteRequest, taskId: 'task-2' },
      { ...workspaceWriteRequest, subjectId: 'worker' },
      { ...workspaceWriteRequest, risk: 'medium' },
      { ...workspaceWriteRequest, reviewerInputDigest: 'd'.repeat(64) },
      {
        ...workspaceWriteRequest,
        resource: { ...workspaceWriteRequest.resource, identityDigest: 'e'.repeat(64) },
      },
    ];
    expect(variants.map(permissionRequestFingerprint)).not.toContain(fingerprint);
    expect(new Set(variants.map(permissionRequestFingerprint)).size).toBe(variants.length);
  });

  it('never lets the reviewer allow a high-risk request', () => {
    const request = { ...workspaceWriteRequest, risk: 'high' } as const;
    const result = evaluatePermissionPolicy({
      request,
      policy: {
        ...basePolicy(),
        approvalPolicy: 'auto',
        reviewerDecision: reviewerAllow(request),
      },
      now: NOW,
    });

    expect(result).toMatchObject({
      decision: 'deny',
      reason: 'reviewer_binding_invalid_or_high_risk',
    });
  });

  it.each([
    ['different input digest', { inputDigest: 'd'.repeat(64) }],
    ['malformed input digest', { inputDigest: 'not-a-digest' }],
    ['short decision nonce', { decisionNonce: 'short' }],
  ] as const)('rejects reviewer authority with %s', (_case, reviewerOverride) => {
    const result = evaluatePermissionPolicy({
      request: workspaceWriteRequest,
      policy: {
        ...basePolicy(),
        approvalPolicy: 'auto',
        reviewerDecision: { ...reviewerAllow(), ...reviewerOverride },
      },
      now: NOW,
    });
    expect(result).toMatchObject({
      decision: 'deny',
      reason: 'reviewer_binding_invalid_or_high_risk',
    });
  });

  it('binds an allow decision to the exact spec digest and current policy epoch', () => {
    const result = evaluatePermissionPolicy({
      request: workspaceWriteRequest,
      policy: {
        ...basePolicy(),
        allowRules: [
          {
            capability: 'workspace.write',
            resourceSet: { kind: 'path-prefix', canonicalPath: '/workspace' },
            operations: ['write'],
          },
        ],
      },
      now: NOW,
    });

    expect(result.decision).toBe('allow');
    expect(result.permit).toBeDefined();
    expect(
      revalidateExecutionPermit({
        permit: result.permit!,
        request: workspaceWriteRequest,
        policyEpoch: 4,
        now: NOW,
      }),
    ).toEqual({ valid: true });
    expect(
      revalidateExecutionPermit({
        permit: result.permit!,
        request: { ...workspaceWriteRequest, executionSpecDigest: 'c'.repeat(64) },
        policyEpoch: 4,
        now: NOW,
      }),
    ).toEqual({ valid: false, reason: 'execution_spec_changed' });
    expect(
      revalidateExecutionPermit({
        permit: result.permit!,
        request: workspaceWriteRequest,
        policyEpoch: 5,
        now: NOW,
      }),
    ).toEqual({ valid: false, reason: 'policy_epoch_changed' });
    expect(
      revalidateExecutionPermit({
        permit: result.permit!,
        request: workspaceWriteRequest,
        policyEpoch: 4,
        now: 'invalid-time',
      }),
    ).toEqual({ valid: false, reason: 'invalid_time' });
  });

  it('does not confuse a sibling path with a path-prefix resource set', () => {
    const result = evaluatePermissionPolicy({
      request: {
        ...workspaceWriteRequest,
        resource: {
          ...workspaceWriteRequest.resource,
          canonicalPath: '/workspace-evil/app.ts',
        },
      },
      policy: {
        ...basePolicy(),
        parentCeiling: {
          ...permissiveCeiling,
          entries: permissiveCeiling.entries.map((entry) =>
            entry.capability === 'workspace.write'
              ? {
                  ...entry,
                  resourceSet: { kind: 'path-prefix', canonicalPath: '/workspace' },
                }
              : entry,
          ),
        },
      },
      now: NOW,
    });

    expect(result).toMatchObject({ decision: 'deny', reason: 'parent_ceiling' });
  });

  it('compares canonical Windows paths case-insensitively without allowing siblings', () => {
    const request = {
      ...workspaceWriteRequest,
      resource: { ...workspaceWriteRequest.resource, canonicalPath: 'c:\\workspace\\src\\app.ts' },
    } as const;
    const windowsCeiling = {
      ...permissiveCeiling,
      entries: permissiveCeiling.entries.map((entry) =>
        entry.capability === 'workspace.write'
          ? {
              ...entry,
              resourceSet: { kind: 'path-prefix' as const, canonicalPath: 'C:\\Workspace' },
            }
          : entry,
      ),
    };
    expect(
      evaluatePermissionPolicy({
        request,
        policy: {
          ...basePolicy(),
          parentCeiling: windowsCeiling,
          modeCeiling: windowsCeiling,
          allowRules: [
            {
              capability: 'workspace.write',
              resourceSet: { kind: 'path-prefix', canonicalPath: 'C:\\Workspace' },
              operations: ['write'],
            },
          ],
        },
        now: NOW,
      }),
    ).toMatchObject({ decision: 'allow' });
  });

  it('never combines resource and operation axes from different ceiling entries', () => {
    const crossProductCeiling = {
      ...permissiveCeiling,
      entries: [
        {
          ...permissiveCeiling.entries[0],
          capability: 'workspace.write',
          resourceSet: { kind: 'path-prefix', canonicalPath: '/workspace/src' },
          operations: ['read'],
        },
        {
          ...permissiveCeiling.entries[1],
          capability: 'workspace.write',
          resourceSet: { kind: 'path-prefix', canonicalPath: '/workspace/docs' },
          operations: ['write'],
        },
      ],
    } as const;

    expect(
      evaluatePermissionPolicy({
        request: workspaceWriteRequest,
        policy: { ...basePolicy(), parentCeiling: crossProductCeiling },
        now: NOW,
      }),
    ).toMatchObject({ decision: 'deny', reason: 'parent_ceiling' });
  });

  it.each([
    { taskId: '' },
    { subjectId: '' },
    { executionSpecDigest: 'not-a-digest' },
    { risk: undefined },
    {
      resource: {
        ...workspaceWriteRequest.resource,
        canonicalPath: '/workspace/../outside/file.txt',
      },
    },
  ])('fails closed for malformed runtime permission facts %#', (override) => {
    expect(
      evaluatePermissionPolicy({
        request: { ...workspaceWriteRequest, ...override } as PermissionRequest,
        policy: basePolicy(),
        now: NOW,
      }),
    ).toMatchObject({ decision: 'deny', reason: 'invalid_request_facts' });
  });
});

describe('access preset expansion', () => {
  it('expands Ask, Auto, and Full into individual policies rather than persisting a preset flag', () => {
    const ask = expandAccessPreset('ask');
    const auto = expandAccessPreset('auto');
    const full = expandAccessPreset('full');

    for (const expanded of [ask, auto, full]) {
      expect(expanded).not.toHaveProperty('preset');
      expect(expanded).toHaveProperty('approvalPolicy');
      expect(expanded).toHaveProperty('allowRules');
      expect(expanded).toHaveProperty('immutableDeny');
    }

    expect(ask).toMatchObject({ approvalPolicy: 'ask', allowRules: [] });
    expect(auto).toMatchObject({ approvalPolicy: 'auto' });
    expect(auto.allowRules).toContainEqual(
      expect.objectContaining({ capability: 'workspace.read', auditReason: 'preset_auto_safe' }),
    );
    expect(full.allowRules).toContainEqual(
      expect.objectContaining({ capability: 'workspace.write', auditReason: 'preset_full' }),
    );
    expect(full.allowRules).not.toContainEqual(
      expect.objectContaining({ capability: 'secret.use' }),
    );
    expect(full.allowRules).not.toContainEqual(
      expect.objectContaining({ capability: 'provider.egress' }),
    );
    expect(new Set(full.allowRules.map((rule) => rule.capability))).toEqual(
      new Set([
        'workspace.read',
        'workspace.write',
        'filesystem.external.read',
        'filesystem.external.write',
        'shell.execute',
        'network.fetch',
        'external.open',
      ]),
    );
    expect(full.immutableDeny).toContainEqual(
      expect.objectContaining({ auditReason: 'immutable_protected_resource' }),
    );
  });

  it('routes an operation not proven safe by Auto to approval', () => {
    const result = evaluatePermissionPolicy({
      request: workspaceWriteRequest,
      policy: {
        ...basePolicy(),
        ...expandAccessPreset('auto'),
      },
      now: NOW,
    });

    expect(result).toMatchObject({
      decision: 'approval_required',
      reason: 'preset_auto_unknown',
    });
  });

  it('keeps protected resources and provider egress denied even under Full', () => {
    const protectedWrite = {
      ...workspaceWriteRequest,
      capability: 'filesystem.external.write',
      resource: {
        kind: 'external-path',
        canonicalPath: '/Users/example/.ssh/config',
        identityDigest: PATH_DIGEST,
        classification: 'credential',
      },
    } as const;
    const providerEgress = {
      ...workspaceWriteRequest,
      capability: 'provider.egress',
      operation: 'egress',
      providerEgress: 'trusted-remote',
      resource: {
        kind: 'provider',
        providerId: 'cloud-model',
        fragmentKind: 'workspace-file',
        byteCount: 100,
        providerTrust: 'trusted-remote',
        dataResidency: 'jp',
        provenanceTrust: 'workspace',
        secretScan: 'clean',
        localOnlyTask: false,
      },
    } as const;

    expect(
      evaluatePermissionPolicy({
        request: protectedWrite,
        policy: { ...basePolicy(), ...expandAccessPreset('full') },
        now: NOW,
      }),
    ).toMatchObject({ decision: 'deny', reason: 'immutable_protected_resource' });
    expect(
      evaluatePermissionPolicy({
        request: providerEgress,
        policy: { ...basePolicy(), ...expandAccessPreset('full') },
        now: NOW,
      }).decision,
    ).not.toBe('allow');
  });

  it('never permits remote provider egress for a local-only Task', () => {
    const request = {
      ...workspaceWriteRequest,
      capability: 'provider.egress',
      operation: 'egress',
      providerEgress: 'trusted-remote',
      resource: {
        kind: 'provider',
        providerId: 'cloud-model',
        fragmentKind: 'workspace-file',
        byteCount: 100,
        providerTrust: 'trusted-remote',
        dataResidency: 'jp',
        provenanceTrust: 'workspace',
        secretScan: 'clean',
        localOnlyTask: true,
      },
    } as const;
    const providerRule = {
      capability: 'provider.egress',
      resourceSet: {
        kind: 'provider-egress',
        providerIds: ['cloud-model'],
        fragmentKinds: ['workspace-file'],
        maxBytes: 1000,
        allowedProviderTrust: ['trusted-remote'],
        allowedResidencies: ['jp'],
        allowedProvenance: ['workspace'],
        requireSecretScanClean: true,
        allowLocalOnlyTaskRemote: true,
      },
      operations: ['egress'],
    } as const;
    const providerCeiling: CapabilityCeiling = {
      entries: [
        {
          ...providerRule,
          expiresAt: '2026-07-22T13:00:00.000Z',
          providerEgress: ['trusted-remote'],
          sandboxProfiles: ['workspace-write'],
        },
      ],
      maxWorkerDepth: 0,
      maxConcurrentWorkers: 0,
    };
    expect(
      evaluatePermissionPolicy({
        request,
        policy: {
          ...basePolicy(),
          parentCeiling: providerCeiling,
          modeCeiling: providerCeiling,
          allowRules: [providerRule],
        },
        now: NOW,
      }),
    ).toMatchObject({ decision: 'deny', reason: 'parent_ceiling' });
  });

  it.each(['app-private', 'credential', 'signing-key', 'update-key'] as const)(
    'denies Workspace-contained %s resources under Full',
    (classification) => {
      expect(
        evaluatePermissionPolicy({
          request: {
            ...workspaceWriteRequest,
            resource: { ...workspaceWriteRequest.resource, classification },
          },
          policy: { ...basePolicy(), ...expandAccessPreset('full') },
          now: NOW,
        }),
      ).toMatchObject({ decision: 'deny', reason: 'immutable_protected_resource' });
    },
  );
});

describe('session grants, expiry, and revocation', () => {
  it('accepts only an exact, unexpired grant for the same subject and policy epoch', () => {
    const grant = createSessionGrant({
      id: 'grant-1',
      subjectId: 'leader',
      capability: 'workspace.write',
      resourceSet: { kind: 'path-exact', canonicalPath: '/workspace/src/app.ts' },
      operations: ['write'],
      scope: 'task',
      expiresAt: '2026-07-22T12:05:00.000Z',
      policyEpoch: 4,
      providerEgress: ['none'],
      sandboxProfiles: ['workspace-write'],
    });
    const policy = { ...basePolicy(), rememberedGrants: [grant] };

    expect(
      evaluatePermissionPolicy({ request: workspaceWriteRequest, policy, now: NOW }),
    ).toMatchObject({ decision: 'allow', reason: 'remembered_grant' });
    expect(
      evaluatePermissionPolicy({
        request: { ...workspaceWriteRequest, subjectId: 'child-worker' },
        policy,
        now: NOW,
      }),
    ).toMatchObject({ decision: 'approval_required' });
    expect(
      evaluatePermissionPolicy({
        request: workspaceWriteRequest,
        policy,
        now: '2026-07-22T12:05:00.001Z',
      }),
    ).toMatchObject({ decision: 'approval_required' });
    expect(
      evaluatePermissionPolicy({
        request: workspaceWriteRequest,
        policy: { ...policy, policyEpoch: 5 },
        now: NOW,
      }),
    ).toMatchObject({ decision: 'approval_required' });
  });

  it('does not let a remembered grant widen provider egress or sandbox authority', () => {
    const grant = createSessionGrant({
      id: 'bounded-grant',
      subjectId: 'leader',
      capability: 'workspace.write',
      resourceSet: { kind: 'path-exact', canonicalPath: '/workspace/src/app.ts' },
      operations: ['write'],
      scope: 'task',
      expiresAt: '2026-07-22T12:05:00.000Z',
      policyEpoch: 4,
      providerEgress: ['none'],
      sandboxProfiles: ['workspace-write'],
    });
    expect(
      evaluatePermissionPolicy({
        request: { ...workspaceWriteRequest, sandboxProfile: 'full' },
        policy: {
          ...basePolicy(),
          sandbox: { feasible: true, profile: 'full' },
          parentCeiling: {
            ...permissiveCeiling,
            entries: permissiveCeiling.entries.map((entry) => ({
              ...entry,
              sandboxProfiles: ['read-only', 'workspace-write', 'full'],
            })),
          },
          modeCeiling: {
            ...permissiveCeiling,
            entries: permissiveCeiling.entries.map((entry) => ({
              ...entry,
              sandboxProfiles: ['read-only', 'workspace-write', 'full'],
            })),
          },
          rememberedGrants: [grant],
        },
        now: NOW,
      }),
    ).toMatchObject({ decision: 'approval_required' });
  });

  it('limits a remembered permit to the grant expiry and ignores unconsumed once grants', () => {
    const taskGrant = createSessionGrant({
      id: 'short-grant',
      subjectId: 'leader',
      capability: 'workspace.write',
      resourceSet: { kind: 'workspace', workspaceId: 'workspace-1' },
      operations: ['write'],
      scope: 'task',
      expiresAt: '2026-07-22T12:01:00.000Z',
      policyEpoch: 4,
      providerEgress: ['none'],
      sandboxProfiles: ['workspace-write'],
    });
    const onceGrant = createSessionGrant({ ...taskGrant, id: 'once-grant', scope: 'once' });

    const allowed = evaluatePermissionPolicy({
      request: workspaceWriteRequest,
      policy: { ...basePolicy(), rememberedGrants: [taskGrant] },
      now: NOW,
    });
    const onceResult = evaluatePermissionPolicy({
      request: workspaceWriteRequest,
      policy: { ...basePolicy(), rememberedGrants: [onceGrant] },
      now: NOW,
    });

    expect(allowed.permit?.expiresAt).toBe(taskGrant.expiresAt);
    expect(onceResult).toMatchObject({ decision: 'approval_required' });
  });

  it('never treats a shell grant without the exact execution digest as remembered authority', () => {
    const shellRequest = {
      ...workspaceWriteRequest,
      capability: 'shell.execute',
      operation: 'execute',
      executionSpecDigest: 'd'.repeat(64),
    } as const;
    const grant = createSessionGrant({
      id: 'shell-grant',
      subjectId: 'leader',
      capability: 'shell.execute',
      resourceSet: { kind: 'path-prefix', canonicalPath: '/workspace' },
      operations: ['execute'],
      scope: 'task',
      expiresAt: '2026-07-22T13:00:00.000Z',
      policyEpoch: 4,
      executionSpecDigest: 'e'.repeat(64),
      providerEgress: ['none'],
      sandboxProfiles: ['workspace-write'],
    });

    expect(
      evaluatePermissionPolicy({
        request: shellRequest,
        policy: { ...basePolicy(), rememberedGrants: [grant] },
        now: NOW,
      }),
    ).toMatchObject({ decision: 'approval_required' });
  });

  it('revokes matching grants, advances policyEpoch, and stops affected child/background work', () => {
    const matchingGrant = createSessionGrant({
      id: 'grant-write',
      subjectId: 'leader',
      capability: 'workspace.write',
      resourceSet: { kind: 'path-prefix', canonicalPath: '/workspace' },
      operations: ['write'],
      scope: 'task',
      expiresAt: '2026-07-22T13:00:00.000Z',
      policyEpoch: 7,
      providerEgress: ['none'],
      sandboxProfiles: ['workspace-write'],
    });
    const unrelatedGrant = createSessionGrant({
      id: 'grant-read',
      subjectId: 'leader',
      capability: 'workspace.read',
      resourceSet: { kind: 'path-prefix', canonicalPath: '/workspace' },
      operations: ['read'],
      scope: 'task',
      expiresAt: '2026-07-22T13:00:00.000Z',
      policyEpoch: 7,
      providerEgress: ['none'],
      sandboxProfiles: ['read-only', 'workspace-write'],
    });

    const result = revokeCapability({
      state: {
        policyEpoch: 7,
        grants: [matchingGrant, unrelatedGrant],
        activities: [
          { id: 'child-1', kind: 'child', requiredCapabilities: ['workspace.write'] },
          { id: 'background-1', kind: 'background', requiredCapabilities: ['workspace.write'] },
          { id: 'outbox-1', kind: 'outbox', requiredCapabilities: ['workspace.write'] },
          { id: 'background-read', kind: 'background', requiredCapabilities: ['workspace.read'] },
        ],
      },
      selector: { capability: 'workspace.write' },
      now: NOW,
    });

    expect(result.policyEpoch).toBe(8);
    expect(result.grants.map((grant: { id: string }) => grant.id)).toEqual(['grant-read']);
    expect(result.stopActivityIds).toEqual(['child-1', 'background-1']);
    expect(result.reevaluateActivityIds).toEqual(['outbox-1']);
  });

  it('a broker uses a spawn-time parent snapshot and never inherits an ambient session grant', () => {
    const broker = new PermissionBroker({
      subjectId: 'leader',
      policy: basePolicy(),
      now: () => NOW,
    });
    const grant = createSessionGrant({
      id: 'ambient-leader-grant',
      subjectId: 'leader',
      capability: 'workspace.write',
      resourceSet: { kind: 'path-prefix', canonicalPath: '/workspace' },
      operations: ['write'],
      scope: 'task',
      expiresAt: '2026-07-22T13:00:00.000Z',
      policyEpoch: 4,
      providerEgress: ['none'],
      sandboxProfiles: ['workspace-write'],
    });
    broker.rememberGrant(grant);
    const child = broker.spawnChild({
      subjectId: 'child-worker',
      parentSubjectId: 'leader',
      parentCeiling: permissiveCeiling,
      policyEpoch: 4,
    });

    expect(child.evaluate({ ...workspaceWriteRequest, subjectId: 'child-worker' })).toMatchObject({
      decision: 'approval_required',
    });
    expect(
      child.evaluate({ ...workspaceWriteRequest, subjectId: 'different-worker' }),
    ).toMatchObject({ decision: 'deny', reason: 'subject_mismatch' });
  });

  it('rejects a child ceiling that exceeds its parent snapshot', () => {
    const broker = new PermissionBroker({
      subjectId: 'leader',
      policy: basePolicy(),
      now: () => NOW,
    });
    const escalated = {
      ...permissiveCeiling,
      entries: [
        ...permissiveCeiling.entries,
        {
          capability: 'filesystem.external.write',
          resourceSet: { kind: 'all' },
          operations: ['write'],
          expiresAt: '2026-07-22T13:00:00.000Z',
          providerEgress: ['none'],
          sandboxProfiles: ['full'],
        },
      ],
    } as const;

    expect(() =>
      broker.spawnChild({
        subjectId: 'child-worker',
        parentSubjectId: 'leader',
        parentCeiling: escalated,
        policyEpoch: 4,
      }),
    ).toThrow('Child ceiling exceeds parent ceiling');
  });

  it('rejects stale and future child policy epochs', () => {
    const broker = new PermissionBroker({
      subjectId: 'leader',
      policy: basePolicy(),
      now: () => NOW,
    });
    for (const policyEpoch of [3, 5])
      expect(() =>
        broker.spawnChild({
          subjectId: 'child-worker',
          parentSubjectId: 'leader',
          parentCeiling: permissiveCeiling,
          policyEpoch,
        }),
      ).toThrow('Child policy epoch must match');
  });

  it('keeps broker and child snapshots immutable after caller mutation', () => {
    const mutablePolicy = structuredClone(basePolicy()) as ReturnType<typeof basePolicy> & {
      allowRules: PermissionRule[];
    };
    const broker = new PermissionBroker({
      subjectId: 'leader',
      policy: mutablePolicy,
      now: () => NOW,
    });
    mutablePolicy.allowRules.push({
      capability: 'workspace.write',
      resourceSet: { kind: 'all' },
      operations: ['write'],
    });
    expect(broker.evaluate(workspaceWriteRequest)).toMatchObject({
      decision: 'approval_required',
    });

    const childCeiling = structuredClone({
      ...permissiveCeiling,
      entries: [permissiveCeiling.entries[0]],
    }) as CapabilityCeiling & { entries: CapabilityCeiling['entries'][number][] };
    const child = broker.spawnChild({
      subjectId: 'child-worker',
      parentSubjectId: 'leader',
      parentCeiling: childCeiling,
      policyEpoch: 4,
    });
    childCeiling.entries.push(structuredClone(permissiveCeiling.entries[1]));

    expect(child.evaluate({ ...workspaceWriteRequest, subjectId: 'child-worker' })).toMatchObject({
      decision: 'deny',
      reason: 'parent_ceiling',
    });
  });
});

describe('shell segment parsing', () => {
  it('returns every executable segment so a later segment cannot hide behind an allowed prefix', () => {
    const parsed = parseShellSegments(
      'git status; rm -rf build && curl https://example.test | tee result.txt',
    );

    expect(parsed).toEqual({
      ok: true,
      autoAllowEligible: false,
      segments: [
        { executable: 'git', argv: ['status'] },
        { executable: 'rm', argv: ['-rf', 'build'] },
        { executable: 'curl', argv: ['https://example.test'] },
        { executable: 'tee', argv: ['result.txt'] },
      ],
    });
  });

  it.each(['echo $(cat /etc/passwd)', 'echo `cat /etc/passwd`', 'echo "unterminated'])(
    'never treats an unsafe or unparseable command as an automatically allowed prefix: %s',
    (command) => {
      const parsed = parseShellSegments(command);

      expect(parsed).toMatchObject({ ok: false, autoAllowEligible: false });
    },
  );

  it('fails closed on redirection because the parser is not the execution boundary', () => {
    expect(parseShellSegments('echo secret > output.txt')).toMatchObject({
      ok: false,
      autoAllowEligible: false,
    });
  });

  it('separates newline-delimited commands and never marks shell text auto-allowable', () => {
    expect(parseShellSegments('git status\nrm -rf build')).toEqual({
      ok: true,
      autoAllowEligible: false,
      segments: [
        { executable: 'git', argv: ['status'] },
        { executable: 'rm', argv: ['-rf', 'build'] },
      ],
    });
  });

  it.each(['echo $HOME', 'echo *.txt', 'echo ~/secret', 'echo {a,b}'])(
    'fails closed for dynamic shell expansion: %s',
    (command) => {
      expect(parseShellSegments(command)).toMatchObject({
        ok: false,
        autoAllowEligible: false,
      });
    },
  );

  it('aggregates every segment and makes any later deny terminal', () => {
    const result = evaluateShellSegments('git status; rm -rf build', (_segment, index) => ({
      decision: index === 0 ? 'allow' : 'deny',
      reason: index === 0 ? 'allowed' : 'dangerous_later_segment',
      policyEpoch: 4,
      evaluationTrace: [],
    }));

    expect(result).toMatchObject({
      ok: true,
      decision: 'deny',
      reason: 'dangerous_later_segment',
      evaluations: [{ decision: 'allow' }, { decision: 'deny' }],
    });
  });
});
