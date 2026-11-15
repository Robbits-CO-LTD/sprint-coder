import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { electronTestExecutablePath } from './electron-test-runtime';
import { PermissionBroker } from './permission-broker';
import { SqlitePersistenceClient } from './persistence';
import {
  authorizeCodexProviderEgress,
  authorizeOfficialApiProviderEgress,
  describeProviderEgressDenial,
  dispatchAfterCodexProviderEgress,
  dispatchAfterClaudeProviderEgress,
  dispatchAfterGrokProviderEgress,
} from './provider-egress';
import { digestCanonical } from './context-compiler';
import type { PreparedContext } from './context-ledger';
import { compilePromptGuidance, injectPromptGuidance } from './prompt-context';
import { serializeCliExecutionPayload } from '../runtime-host/execution-payload';

const cleanup: string[] = [];
const context: PreparedContext = {
  fragments: [],
  projectItems: [],
  projectSnapshotDigest: null,
  usageEvents: [],
  compacted: false,
};
const runsWithElectronAbi = process.env.SPRINT_CODER_ELECTRON_EGRESS_TEST === '1';

afterEach(() => {
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

if (runsWithElectronAbi)
  describe('Codex provider egress gate', () => {
    it('allows Windows paths for Ollama while preserving secret denial', () => {
      const fixture = createFixture(false);
      const prompt = 'F:/sc-real-ai-20260910/fixtures/qwen38';
      const input = {
        broker: new PermissionBroker(fixture.persistence),
        task: fixture.task,
        turnId: 'windows-path',
        prompt,
        context,
        now: '2026-09-10T00:00:00.000Z',
      };
      // A path is no longer read as a random-looking secret, declared as a root or not.
      expect(authorizeOfficialApiProviderEgress(input, 'ollama', 'trusted-local').allowed).toBe(
        true,
      );
      const bound = { ...input, knownWorkspaceRoots: ['F:\\sc-real-ai-20260910\\fixtures'] };
      expect(authorizeOfficialApiProviderEgress(bound, 'ollama', 'trusted-local').allowed).toBe(
        true,
      );
      expect(
        authorizeOfficialApiProviderEgress(
          {
            ...bound,
            prompt: `${prompt}\npassword="not-for-a-provider"`,
          },
          'ollama',
          'trusted-local',
        ).allowed,
      ).toBe(false);
      fixture.persistence.close();
    });
    it.each([
      { localOnly: true, suffix: '', scanCodes: [] as string[] },
      {
        localOnly: false,
        suffix: '\nAuthorization: Bearer 8Jv2mQp7Zx4Lk9Wd6Tn3Rs5Yc1Ua0BfH',
        scanCodes: ['known-secret-pattern'],
      },
      {
        localOnly: false,
        suffix: '\npassword="not-for-a-provider"',
        scanCodes: ['credential-field'],
      },
    ])(
      'keeps protected egress denied with a known root (%#)',
      ({ localOnly, suffix, scanCodes }) => {
        const fixture = createFixture(localOnly);
        const root = '/private/tmp/sprint-coder-patrol-20260905/workspace';
        let dispatches = 0;
        const decision = dispatchAfterCodexProviderEgress(
          {
            broker: new PermissionBroker(fixture.persistence),
            task: fixture.task,
            turnId: 'protected-workspace-root',
            prompt: `${root}${suffix}`,
            knownWorkspaceRoots: [root],
            context,
            now: '2026-09-05T00:00:00.000Z',
          },
          () => {
            dispatches += 1;
          },
        );
        expect(decision.allowed).toBe(false);
        // A secret-scan denial is explained by its codes, never by the bytes it withheld (issue
        // #841); a local-only denial has nothing from the scan to explain.
        if (scanCodes.length === 0) expect(decision.disclosureReasons).toEqual([]);
        else expect(decision.disclosureReasons).toEqual(expect.arrayContaining(scanCodes));
        expect(JSON.stringify(decision)).not.toContain('8Jv2mQp7Zx4Lk9Wd6Tn3Rs5Yc1Ua0BfH');
        expect(JSON.stringify(decision)).not.toContain('not-for-a-provider');
        expect(dispatches).toBe(0);
        fixture.persistence.close();
      },
    );
    it('allows a long root label set apart from its isolation root (issue #841)', () => {
      const fixture = createFixture(false);
      const root =
        '/Users/dev/Library/Application Support/Sprint Coder/team-worker-worktrees/worktree-14838862-f09e-4174-84e4-68cbb3cac903-1';
      const label = 'realai-ws-codex-graph-Hnb2yq';
      const decide = (prompt: string, turnId: string) =>
        authorizeCodexProviderEgress({
          broker: new PermissionBroker(fixture.persistence),
          task: fixture.task,
          turnId,
          prompt,
          knownWorkspaceRoots: [root],
          context,
          now: '2026-10-18T00:00:00.000Z',
        });
      // The Worker prompt's old `label=root` spelling fused the label into the root's token, which
      // the entropy guess once stopped. The send no longer guesses, so either spelling goes out.
      const fused = decide(`隔離root: ${label}=${root}`, 'fused-label');
      expect(fused).toMatchObject({ allowed: true, disclosureReasons: [] });
      const apart = decide(`隔離root: ${label} = ${root}`, 'separate-label');
      expect(apart).toMatchObject({ allowed: true, disclosureReasons: [] });
      // A key beside the label is still stopped, by its shape.
      const keyed = decide(`隔離root: ${label} = ${root}\napi_key=not-for-a-provider`, 'keyed');
      expect(keyed).toMatchObject({
        allowed: false,
        disclosureReasons: ['credential-field', 'known-secret-pattern'],
      });
      expect(keyed.evaluation.reason).toBe('parent_ceiling');
      fixture.persistence.close();
    });
    it.each(['codex', 'claude', 'grok'] as const)(
      'dispatches %s generated guidance containing the selected Workspace root',
      (kind) => {
        const fixture = createFixture(false);
        const root = '/private/tmp/sprint-coder-patrol-20260905/workspace';
        const guidance = compilePromptGuidance({
          workspace: {
            primaryRootId: 'root',
            digest: 'workspace',
            roots: [{ rootId: 'root', path: root, label: 'workspace', role: 'primary' }],
          },
          toolCatalog: {
            revision: 1,
            providerId: kind,
            workspaceId: 'root',
            entries: [],
            digest: 'catalog',
          },
          workspaceRules: [],
          vcs: [],
        });
        const payload = serializeCliExecutionPayload({
          kind,
          request: 'Reply only OK.',
          contextFragments: injectPromptGuidance([], guidance),
          projectItems: [],
        });
        let dispatches = 0;
        const input = {
          broker: new PermissionBroker(fixture.persistence),
          task: fixture.task,
          turnId: 'workspace-root',
          prompt: payload.text,
          payloadDigest: payload.digest,
          context,
          now: '2026-09-05T00:00:00.000Z',
          knownWorkspaceRoots: [root],
        };
        const dispatch =
          kind === 'grok'
            ? dispatchAfterGrokProviderEgress
            : kind === 'codex'
              ? dispatchAfterCodexProviderEgress
              : dispatchAfterClaudeProviderEgress;
        const decision = dispatch(input, () => {
          dispatches += 1;
        });
        expect(decision.allowed).toBe(true);
        expect(dispatches).toBe(1);
        expect(readAudit(fixture.path)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ capability: 'provider.egress', decision: 'allow' }),
          ]),
        );
        fixture.persistence.close();
      },
    );
    it.each([
      { localOnly: false, prompt: 'clean prompt', allowed: true },
      { localOnly: true, prompt: 'clean prompt', allowed: false },
      { localOnly: false, prompt: 'password=hunter2', allowed: false },
    ])(
      'enforces Grok egress policy and distinct audit identity (%#)',
      ({ localOnly, prompt, allowed }) => {
        const fixture = createFixture(localOnly);
        const broker = new PermissionBroker(fixture.persistence);
        const evaluate = vi.spyOn(broker, 'evaluate');
        const dispatch = vi.fn();
        const decision = dispatchAfterGrokProviderEgress(
          {
            broker,
            task: fixture.task,
            turnId: 'turn-grok-egress',
            prompt,
            context,
            now: '2026-07-23T00:00:00.000Z',
          },
          dispatch,
        );
        expect(decision.allowed).toBe(allowed);
        expect(dispatch).toHaveBeenCalledTimes(allowed ? 1 : 0);
        expect(evaluate.mock.calls[0]?.[0]).toMatchObject({
          request: {
            subjectId: 'runtime:grok:turn-grok-egress',
            resource: { providerId: 'xai-grok-cli' },
          },
        });
        if (allowed) expect(decision.evaluation.reason).toBe('grok_provider_egress');
        expect(readAudit(fixture.path)[0]).toMatchObject({ decision: allowed ? 'allow' : 'deny' });
        fixture.persistence.close();
      },
    );

    it('allows public package integrity metadata through the complete egress gate', () => {
      const fixture = createFixture(false);
      let dispatches = 0;
      const decision = dispatchAfterCodexProviderEgress(
        {
          broker: new PermissionBroker(fixture.persistence),
          task: fixture.task,
          turnId: 'integrity-metadata',
          prompt: JSON.stringify({
            integrity: `sha512-${createHash('sha512').update('public fixture').digest('base64')}`,
          }),
          context,
          now: '2026-07-23T00:00:00.000Z',
        },
        () => {
          dispatches += 1;
        },
      );
      expect(decision.allowed).toBe(true);
      expect(dispatches).toBe(1);
      fixture.persistence.close();
    });

    it('allows and audits a clean non-local Task through the exact provider policy', () => {
      const fixture = createFixture(false);
      const decision = authorizeCodexProviderEgress({
        broker: new PermissionBroker(fixture.persistence),
        task: fixture.task,
        turnId: 'turn-provider-allow',
        prompt: 'clean prompt',
        context,
        now: '2026-07-23T00:00:00.000Z',
      });

      expect(decision).toMatchObject({
        allowed: true,
        evaluation: { decision: 'allow', reason: 'codex_provider_egress' },
      });
      expect(readAudit(fixture.path)).toEqual([
        expect.objectContaining({ capability: 'provider.egress', decision: 'allow' }),
        expect.objectContaining({
          capability: 'provider.egress',
          decision: 'allow',
          reason: 'execution_revalidation_valid',
        }),
      ]);
      fixture.persistence.close();
    });

    it('binds attachment bytes and the exact manifest into provider permission audit', () => {
      const fixture = createFixture(false);
      const attachmentManifestDigest = 'a'.repeat(64);
      let dispatches = 0;
      const decision = dispatchAfterCodexProviderEgress(
        {
          broker: new PermissionBroker(fixture.persistence),
          task: fixture.task,
          turnId: 'turn-provider-images',
          prompt: 'image prompt',
          context,
          now: '2026-07-23T00:00:00.000Z',
          attachmentManifestDigest,
          attachmentByteCount: 4096,
        },
        () => {
          dispatches += 1;
        },
      );

      expect(decision.allowed).toBe(true);
      expect(dispatches).toBe(1);
      const expectedResourceDigest = createHash('sha256')
        .update(
          JSON.stringify({
            kind: 'provider',
            providerId: 'openai-codex',
            fragmentKind: 'prompt',
            byteCount: Buffer.byteLength('image prompt', 'utf8') + 4096,
            providerTrust: 'trusted-remote',
            dataResidency: 'unspecified',
            provenanceTrust: 'system',
            secretScan: 'clean',
            knownRootsDigest: null,
            localOnlyTask: false,
            attachmentManifestDigest,
            attachmentByteCount: 4096,
          }),
        )
        .digest('hex');
      expect(readAudit(fixture.path)).toEqual([
        expect.objectContaining({ resource_digest: expectedResourceDigest }),
        expect.objectContaining({ resource_digest: expectedResourceDigest }),
      ]);
      fixture.persistence.close();
    });

    it('binds the declared Workspace roots into the audited resource', () => {
      const root = '/private/tmp/sprint-coder-known-roots/workspace';
      const auditFor = (knownWorkspaceRoots: readonly string[] | undefined) => {
        const fixture = createFixture(false);
        const decision = authorizeCodexProviderEgress({
          broker: new PermissionBroker(fixture.persistence),
          task: fixture.task,
          turnId: 'turn-known-roots',
          prompt: 'clean prompt',
          context,
          now: '2026-07-23T00:00:00.000Z',
          ...(knownWorkspaceRoots === undefined ? {} : { knownWorkspaceRoots }),
        });
        const audit = readAudit(fixture.path) as { resource_digest: string }[];
        fixture.persistence.close();
        return { allowed: decision.allowed, digest: audit[0]!.resource_digest };
      };
      const resourceDigestWith = (knownRootsDigest: string | null) =>
        createHash('sha256')
          .update(
            JSON.stringify({
              kind: 'provider',
              providerId: 'openai-codex',
              fragmentKind: 'prompt',
              byteCount: Buffer.byteLength('clean prompt', 'utf8'),
              providerTrust: 'trusted-remote',
              dataResidency: 'unspecified',
              provenanceTrust: 'system',
              secretScan: 'clean',
              knownRootsDigest,
              localOnlyTask: false,
              attachmentManifestDigest: null,
              attachmentByteCount: 0,
            }),
          )
          .digest('hex');

      const none = auditFor(undefined);
      const exempted = auditFor([root]);
      // Same prompt, same `clean` verdict — but the audit still distinguishes a Turn that declared
      // a root from one that declared nothing.
      expect(none).toEqual({ allowed: true, digest: resourceDigestWith(null) });
      expect(exempted).toEqual({
        allowed: true,
        digest: resourceDigestWith(digestCanonical([root])),
      });
      // The declaration is a fact about paths, not about spelling or ordering.
      expect(auditFor([`${root}/`, root.replaceAll('/', '\\')]).digest).toBe(exempted.digest);
    });

    it('lets the declared root label through the gate, and binds it into the audit (issue #849)', () => {
      const root = '/private/tmp/sprint-coder-known-roots/workspace';
      const label = 'ws-Q7xK2mZp9LcV4tRb8NfJ3hYd6Wa';
      const prompt = JSON.stringify({ roots: [{ label, path: root }] });
      const gate = (
        content: string,
        knownWorkspaceLabels: readonly string[] | undefined,
        turnId: string,
      ) => {
        const fixture = createFixture(false);
        const decision = authorizeCodexProviderEgress({
          broker: new PermissionBroker(fixture.persistence),
          task: fixture.task,
          turnId,
          prompt: content,
          context,
          now: '2026-07-23T00:00:00.000Z',
          knownWorkspaceRoots: [root],
          ...(knownWorkspaceLabels === undefined ? {} : { knownWorkspaceLabels }),
        });
        const audit = readAudit(fixture.path) as { resource_digest: string }[];
        fixture.persistence.close();
        return { decision, digest: audit[0]!.resource_digest };
      };

      // A random-looking label goes out whether or not it was declared: the send no longer guesses.
      expect(gate(prompt, undefined, 'turn-label-undeclared').decision).toMatchObject({
        allowed: true,
        disclosureReasons: [],
      });
      const declared = gate(prompt, [label], 'turn-label-declared');
      expect(declared.decision).toMatchObject({ allowed: true, disclosureReasons: [] });
      // The audit still tells a declaration with the label from one with only the root.
      expect(gate('clean prompt', [label], 'turn-clean-label').digest).not.toBe(
        gate('clean prompt', undefined, 'turn-clean-root').digest,
      );
      // A real secret beside the declared label is still withheld, by its shape.
      expect(
        gate(`${prompt}\nsk-ant-abcdefghijklmnopqrstuvwxyz1234`, [label], 'turn-label-secret')
          .decision,
      ).toMatchObject({
        allowed: false,
        disclosureReasons: ['ai-provider-token', 'known-secret-pattern'],
      });
    });

    it('rejects partial or unsafe attachment egress facts before evaluation', () => {
      const fixture = createFixture(false);
      expect(() =>
        authorizeCodexProviderEgress({
          broker: new PermissionBroker(fixture.persistence),
          task: fixture.task,
          turnId: 'turn-provider-invalid-images',
          prompt: 'image prompt',
          context,
          now: '2026-07-23T00:00:00.000Z',
          attachmentByteCount: 1,
        }),
      ).toThrow('Invalid provider attachment egress facts');
      expect(readAudit(fixture.path)).toEqual([]);
      fixture.persistence.close();
    });

    it.each([
      { localOnly: true, prompt: 'clean prompt', reason: 'parent_ceiling' },
      { localOnly: false, prompt: 'password=hunter2', reason: 'parent_ceiling' },
    ])('denies before Runtime dispatch and records the reason: $reason', (testCase) => {
      const fixture = createFixture(testCase.localOnly);
      const decision = authorizeCodexProviderEgress({
        broker: new PermissionBroker(fixture.persistence),
        task: fixture.task,
        turnId: 'turn-provider-deny',
        prompt: testCase.prompt,
        context,
        now: '2026-07-23T00:00:00.000Z',
      });

      expect(decision).toMatchObject({
        allowed: false,
        evaluation: { decision: 'deny', reason: testCase.reason },
      });
      expect(readAudit(fixture.path)).toEqual([
        expect.objectContaining({
          capability: 'provider.egress',
          decision: 'deny',
          reason: testCase.reason,
        }),
      ]);
      fixture.persistence.close();
    });

    it('never invokes the Runtime dispatch for a local-only Task', () => {
      const fixture = createFixture(true);
      let dispatches = 0;
      const decision = dispatchAfterCodexProviderEgress(
        {
          broker: new PermissionBroker(fixture.persistence),
          task: fixture.task,
          turnId: 'turn-provider-no-dispatch',
          prompt: 'must stay local',
          context,
          now: '2026-07-23T00:00:00.000Z',
        },
        () => {
          dispatches += 1;
        },
      );
      expect(decision.allowed).toBe(false);
      expect(dispatches).toBe(0);
      fixture.persistence.close();
    });

    it('rejects remote egress when an included Project source was captured local-only', () => {
      const fixture = createFixture(false);
      const decision = authorizeCodexProviderEgress({
        broker: new PermissionBroker(fixture.persistence),
        task: fixture.task,
        turnId: 'turn-project-local-only',
        prompt: 'clean prompt',
        context: {
          ...context,
          projectItems: [
            {
              id: 'memory-1',
              kind: 'memory',
              authority: 'user',
              localOnly: true,
              content: 'captured locally',
              sealedDigest: 'a'.repeat(64),
              sourceTaskId: 'source-task',
              sourceTurnId: 'source-turn',
              sourceReferenceId: null,
              capturedAt: '2026-07-23T00:00:00.000Z',
            },
          ],
        },
        now: '2026-07-23T00:00:00.000Z',
      });

      expect(decision).toMatchObject({
        allowed: false,
        evaluation: { decision: 'deny', reason: 'parent_ceiling' },
      });
      fixture.persistence.close();
    });

    it('allows a trusted loopback Provider for a local-only Task', () => {
      const fixture = createFixture(true);
      const decision = authorizeOfficialApiProviderEgress(
        {
          broker: new PermissionBroker(fixture.persistence),
          task: fixture.task,
          turnId: 'turn-local-provider',
          prompt: 'must stay local',
          context,
          now: '2026-07-23T00:00:00.000Z',
        },
        'ollama',
        'trusted-local',
      );

      expect(decision).toMatchObject({
        allowed: true,
        evaluation: { decision: 'allow', reason: 'ollama_official_api_egress' },
      });
      expect(readAudit(fixture.path)).toEqual([
        expect.objectContaining({ capability: 'provider.egress', decision: 'allow' }),
        expect.objectContaining({
          capability: 'provider.egress',
          decision: 'allow',
          reason: 'execution_revalidation_valid',
        }),
      ]);
      fixture.persistence.close();
    });

    it('keeps the secret scan fail-closed for a trusted loopback Provider', () => {
      const fixture = createFixture(true);
      const decision = authorizeOfficialApiProviderEgress(
        {
          broker: new PermissionBroker(fixture.persistence),
          task: fixture.task,
          turnId: 'turn-local-provider-secret',
          prompt: 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
          context,
          now: '2026-07-23T00:00:00.000Z',
        },
        'ollama',
        'trusted-local',
      );

      expect(decision).toMatchObject({
        allowed: false,
        evaluation: { decision: 'deny', reason: 'parent_ceiling' },
      });
      fixture.persistence.close();
    });

    it('never invokes the Runtime dispatch when the prompt fails the secret scan (adversarial gate proof)', () => {
      // Deliverable 5c (Phase 7 hardening): a dirty prompt is denied *before* any dispatch call,
      // not merely reported as denied after the fact — proven by asserting the dispatch callback
      // itself is never invoked, not just the returned decision shape.
      const fixture = createFixture(false);
      let dispatches = 0;
      const decision = dispatchAfterCodexProviderEgress(
        {
          broker: new PermissionBroker(fixture.persistence),
          task: fixture.task,
          turnId: 'turn-provider-secret-scan',
          prompt: 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
          context,
          now: '2026-07-23T00:00:00.000Z',
        },
        () => {
          dispatches += 1;
        },
      );
      expect(decision.allowed).toBe(false);
      expect(dispatches).toBe(0);
      fixture.persistence.close();
    });

    it.each([
      'postgres://alice:hunter2@example.com/db',
      ['xoxb', '1234567890', 'abcdefghijklmnopqrstuvwxyz'].join('-'),
      'glpat-abcdefghijklmnopqrstuvwxyz',
      // A bare random value is no longer one; a labelled session secret still is.
      'session_token=8Jv2mQp7Zx4Lk9Wd6Tn3Rs5Yc1Ua0BfH',
    ])('blocks a newly classified disclosure before Provider dispatch: %s', (prompt) => {
      const fixture = createFixture(false);
      let dispatches = 0;
      const decision = dispatchAfterCodexProviderEgress(
        {
          broker: new PermissionBroker(fixture.persistence),
          task: fixture.task,
          turnId: 'turn-provider-expanded-secret-scan',
          prompt,
          context,
          now: '2026-07-23T00:00:00.000Z',
        },
        () => {
          dispatches += 1;
        },
      );
      expect(decision.allowed).toBe(false);
      expect(dispatches).toBe(0);
      fixture.persistence.close();
    });

    it('honors a revoked provider.egress capability before Runtime dispatch', () => {
      const fixture = createFixture(false);
      fixture.persistence.revokePermissionCapability(
        fixture.task.id,
        'provider.egress',
        '2026-07-23T00:00:00.000Z',
      );
      let dispatches = 0;
      const decision = dispatchAfterCodexProviderEgress(
        {
          broker: new PermissionBroker(fixture.persistence),
          task: fixture.task,
          turnId: 'turn-provider-revoked',
          prompt: 'clean prompt',
          context,
          now: '2026-07-23T00:00:01.000Z',
        },
        () => {
          dispatches += 1;
        },
      );
      expect(decision).toMatchObject({
        allowed: false,
        evaluation: { decision: 'deny', reason: 'capability_revoked' },
      });
      expect(dispatches).toBe(0);
      fixture.persistence.close();
    });

    // The gate scans the whole conversation the Task sends again on every Turn, so a URL in an
    // earlier request or in the AI's own answer is as much in the send as one in the new request.
    const pullRequest = 'https://github.com/Robbits-CO-LTD/sprint-coder/pull/1306';
    function nextTurnAfter(fixture: ReturnType<typeof createFixture>, request: string) {
      const first = fixture.persistence.startTurn(fixture.task.id, request);
      for (const stage of ['understanding', 'planning', 'executing', 'synthesizing'] as const)
        fixture.persistence.changeStage(fixture.task.id, first.turnId, stage);
      fixture.persistence.completeTurn(
        fixture.task.id,
        first.turnId,
        'completed',
        `ブラウザーで開きました: launch msedge --url ${pullRequest}\n関連: https://github.com/Robbits-CO-LTD/sprint-coder/issues/1298#issuecomment-6892857211`,
      );
      const second = fixture.persistence.startTurn(fixture.task.id, '続けてください');
      return {
        prompt: second.text,
        context: fixture.persistence.prepareContext(fixture.task.id, second.turnId),
        turnId: second.turnId,
      };
    }

    it.each(['claude', 'codex', 'grok'] as const)(
      'lets a %s Turn go on after ordinary URLs in the request and the answer',
      (kind) => {
        const fixture = createFixture(false);
        const next = nextTurnAfter(
          fixture,
          `${pullRequest} を見て。https://www.amazon.co.jp/Echo-Dot-5th-Gen/dp/B09B8SZLLG/ref=sr_1_1 と https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd/edit も。`,
        );
        expect(next.context.fragments.map(({ content }) => content).join('\n')).toContain(
          pullRequest,
        );
        const dispatch =
          kind === 'grok'
            ? dispatchAfterGrokProviderEgress
            : kind === 'codex'
              ? dispatchAfterCodexProviderEgress
              : dispatchAfterClaudeProviderEgress;
        let dispatches = 0;
        const decision = dispatch(
          {
            broker: new PermissionBroker(fixture.persistence),
            task: fixture.task,
            turnId: next.turnId,
            prompt: next.prompt,
            context: next.context,
            now: '2026-11-15T00:00:00.000Z',
          },
          () => {
            dispatches += 1;
          },
        );
        expect(decision).toMatchObject({ allowed: true, disclosureReasons: [] });
        expect(dispatches).toBe(1);
        expect(
          authorizeOfficialApiProviderEgress(
            {
              broker: new PermissionBroker(fixture.persistence),
              task: fixture.task,
              turnId: `${next.turnId}-api`,
              prompt: JSON.stringify({ messages: [{ role: 'tool', content: pullRequest }] }),
              context: next.context,
              now: '2026-11-15T00:00:00.000Z',
            },
            'openai',
          ),
        ).toMatchObject({ allowed: true, disclosureReasons: [] });
        fixture.persistence.close();
      },
    );

    it('still stops a send whose conversation holds a key, and says why', () => {
      const fixture = createFixture(false);
      const key = 'sk-ant-abcdefghijklmnopqrstuvwxyz1234';
      // The Turn that carried the key was itself stopped; its request stays in the conversation.
      const denied = fixture.persistence.startTurn(fixture.task.id, `この key で試して ${key}`);
      fixture.persistence.completeTurn(fixture.task.id, denied.turnId, 'failed');
      const second = fixture.persistence.startTurn(fixture.task.id, 'key なしで、もう一度');
      const next = {
        prompt: second.text,
        context: fixture.persistence.prepareContext(fixture.task.id, second.turnId),
        turnId: second.turnId,
      };
      let dispatches = 0;
      const decision = dispatchAfterClaudeProviderEgress(
        {
          broker: new PermissionBroker(fixture.persistence),
          task: fixture.task,
          turnId: next.turnId,
          prompt: next.prompt,
          context: next.context,
          now: '2026-11-15T00:00:00.000Z',
        },
        () => {
          dispatches += 1;
        },
      );
      expect(decision).toMatchObject({
        allowed: false,
        disclosureReasons: ['ai-provider-token', 'known-secret-pattern'],
      });
      expect(dispatches).toBe(0);
      const message = describeProviderEgressDenial(decision.disclosureReasons);
      expect(message).toContain('API key・鍵や token');
      expect(message).toContain('新しい Task');
      expect(message).not.toContain('abcdefghij');
      fixture.persistence.close();
    });

    it('explains a secret-scan denial from reason codes only', () => {
      expect(describeProviderEgressDenial(undefined)).toBeNull();
      expect(describeProviderEgressDenial([])).toBeNull();
      expect(describeProviderEgressDenial(['webhook-url', 'credential-field'])).toBe(
        '送る内容（依頼の文や、この Task のこれまでの会話）にWebhook の URL・パスワードや鍵の値（password= など）が入っているため、AI に送りませんでした。この Task からは送れないままなので、その部分を外して、新しい Task で依頼してください。',
      );
      // An unknown code still gets a sentence, and a code that maps to the same words is said once.
      expect(describeProviderEgressDenial(['future-code', 'another-code'])).toContain(
        '秘密の情報に見える文字列が入っている',
      );
      const every = describeProviderEgressDenial([
        'ai-provider-token',
        'authorization-header',
        'service-token',
        'cookie',
        'credential-field',
        'credential-prone-filename',
        'gitlab-token',
        'high-entropy-value',
        'known-secret-pattern',
        'private-key',
        'slack-token',
        'uri-userinfo',
        'webhook-url',
      ]);
      // PublicError.userMessage is bounded at 500 characters.
      expect(every?.length).toBeLessThanOrEqual(500);
    });
  });
else
  describe('Codex provider egress Electron ABI bridge', () => {
    it('runs the provider egress suite with the bundled Electron Node ABI', () => {
      const result = spawnSync(
        electronTestExecutablePath(),
        [
          join(process.cwd(), '../../node_modules/vitest/vitest.mjs'),
          'run',
          'src/main/provider-egress.test.ts',
        ],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            SPRINT_CODER_ELECTRON_EGRESS_TEST: '1',
          },
          timeout: 30_000,
        },
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    }, 35_000);
  });

function createFixture(localOnly: boolean) {
  const directory = mkdtempSync(join(tmpdir(), 'sprint-coder-provider-egress-'));
  cleanup.push(directory);
  const path = join(directory, 'test.sqlite3');
  const persistence = new SqlitePersistenceClient(path);
  const task = persistence.createTask('provider gate', localOnly);
  return { path, persistence, task };
}

function readAudit(path: string) {
  const database = new Database(path, { readonly: true });
  const rows = database
    .prepare(
      `SELECT capability, decision, reason, resource_digest FROM permission_audit
       ORDER BY created_at, rowid`,
    )
    .all();
  database.close();
  return rows;
}
