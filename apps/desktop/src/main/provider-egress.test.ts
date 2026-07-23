import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PermissionBroker } from './permission-broker';
import { SqlitePersistenceClient } from './persistence';
import { authorizeCodexProviderEgress, dispatchAfterCodexProviderEgress } from './provider-egress';
import type { PreparedContext } from './context-ledger';

const cleanup: string[] = [];
const context: PreparedContext = { fragments: [], usageEvents: [], compacted: false };
const runsWithElectronAbi = process.env.SPRINT_CODER_ELECTRON_EGRESS_TEST === '1';

afterEach(() => {
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

if (runsWithElectronAbi)
  describe('Codex provider egress gate', () => {
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
  });
else
  describe('Codex provider egress Electron ABI bridge', () => {
    it('runs the provider egress suite with the bundled Electron Node ABI', () => {
      const result = spawnSync(
        join(process.cwd(), '../../node_modules/.bin/electron'),
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
      `SELECT capability, decision, reason FROM permission_audit
       ORDER BY created_at, rowid`,
    )
    .all();
  database.close();
  return rows;
}
