import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, stat, rename, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GraphMissionPlan } from '@sprint-coder/contracts';
import { nextGraphDocument } from './graph-document';
import { workspaceMutationBinding } from './path-guard';
import { reviewGraphMission, type GraphMissionReviewContext } from './graph-mission-review';
import type * as DirectoryNameRules from './directory-name-rules';
import { NativeSafeFsError } from './native-safe-fs';
import { secureLogger, writeSecureLogEntry, type SecureLogEntry } from './secure-logger';

// The native directory name rules are read for every not-yet-created claim path. A build of the
// addon that predates them throws instead of answering, which is the whole of Issue #465, so the
// review must stay fail-closed *and* leave that error's own code somewhere legible.
const nativeDirectoryRules = vi.hoisted(() => ({ failure: null as Error | null }));
vi.mock('./directory-name-rules', async (importOriginal) => {
  const actual = await importOriginal<typeof DirectoryNameRules>();
  return {
    ...actual,
    directoryCaseSensitive: (
      ...args: Parameters<typeof actual.directoryCaseSensitive>
    ): boolean => {
      if (nativeDirectoryRules.failure !== null) throw nativeDirectoryRules.failure;
      return actual.directoryCaseSensitive(...args);
    },
  };
});

const cleanup: string[] = [];
afterEach(async () => {
  nativeDirectoryRules.failure = null;
  secureLogger.setSink(writeSecureLogEntry);
  for (const root of cleanup.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), 'sc-mission-review-'));
  cleanup.push(path);
  await writeFile(join(path, 'existing.ts'), 'base');
  const binding = await workspaceMutationBinding(path);
  const rootId = 'root';
  const context: GraphMissionReviewContext = {
    workspace: {
      source: 'task',
      projectId: null,
      primaryRootId: rootId,
      digest: 'a'.repeat(64),
      roots: [{ rootId, path, label: 'Code', role: 'primary', status: 'available' }],
    },
    rootIdentities: new Map([[rootId, binding.rootIdentityDigest]]),
    policyEpoch: 1,
    team: { id: 'team', taskId: 'task', leaderAgentId: 'leader', state: 'active' },
    workers: ['a', 'b'].map((id) => ({
      id,
      taskId: 'task',
      teamId: 'team',
      kind: 'worker',
      state: 'ready',
      writeCapable: true,
    })),
    busyWorkerIds: [],
  };
  const plan: GraphMissionPlan = {
    mode: 'graph',
    objective: 'Work',
    doneCriteria: ['Pass'],
    steps: ['a', 'b'].map((key, index) => ({
      key,
      nodeId: key,
      workerId: key,
      objective: key,
      doneCriteria: ['Pass'],
      access: 'workspace-write',
      dependsOn: [],
      writeClaims: [
        { rootId, path: index === 0 ? 'existing.ts' : 'new/sub/file.ts', semanticKeys: ['api'] },
      ],
      resourceClaims: [
        { scope: 'workspace', key: 'database', rootId },
        { scope: 'machine', key: 'browser', rootId: null },
      ],
    })),
  };
  const hash = createHash('sha256').update('base').digest('hex');
  const diagram = {
    schema_version: 2,
    diagram_type: 'workflow',
    meta: { title: 'Plan' },
    lanes: [{ id: 'work', label: 'Work' }],
    nodes: ['a', 'b'].map((id, col) => ({ id, col, lane: 'work', type: 'backend', label: id })),
    edges: [],
  };
  const source = {
    id: randomUUID(),
    rootId,
    rootIdentityDigest: binding.rootIdentityDigest,
    elementKind: 'node' as const,
    elementId: 'a',
    path: 'existing.ts',
    lineStart: 1,
    lineEnd: 1,
    contentHash: hash,
    excerptHash: hash,
    excerpt: 'base',
    observedAt: new Date().toISOString(),
  };
  const document = nextGraphDocument('task', diagram, null, [source], [], plan);
  const input = {
    taskId: 'task',
    renderRevision: document.renderRevision,
    instanceId: randomUUID(),
  };
  return { path, binding, context, plan, diagram, document, input };
}

describe('graph Mission reference review', () => {
  it('anchors whole-root declarations at the canonical workspace without guarding unrelated parents', async () => {
    const f = await fixture();
    const alias = await mkdtemp(join(tmpdir(), 'sc-root-alias-'));
    cleanup.push(alias);
    const link = join(alias, 'workspace');
    await symlink(f.path, link, process.platform === 'win32' ? 'junction' : 'dir');
    const plan = structuredClone(f.plan);
    plan.steps[0]!.writeClaims[0]!.path = null;
    const document = nextGraphDocument('task', f.diagram, null, [], [], plan);
    const context = {
      ...f.context,
      workspace: {
        ...f.context.workspace,
        roots: f.context.workspace.roots.map((root) => ({ ...root, path: link })),
      },
    };
    const result = await reviewGraphMission(f.input, document, () => context);
    expect(result.summary.matched).toBe(true);
    expect(result.claims[0]?.guard.chain).toEqual([]);
    expect(result.claims[0]?.canonicalPath).toBe(f.binding.canonicalPath);
  });
  it('binds existing and missing paths without writing, and keeps write/resource identities separate', async () => {
    const f = await fixture();
    const result = await reviewGraphMission(f.input, f.document, () => f.context);
    expect(result.summary).toMatchObject({ matched: true, issues: [] });
    expect(result.writeFootprints).toHaveLength(2);
    expect(result.writeConflicts).toEqual([{ leftStepKey: 'a', rightStepKey: 'b' }]);
    expect(result.claims).toHaveLength(2);
    expect(result.claims[0]?.guard.targetIdentity?.kind).toBe('file');
    expect(result.claims[1]).toMatchObject({
      canonicalPath: join(f.binding.canonicalPath, 'new/sub/file.ts'),
      missingSuffix: ['sub', 'file.ts'],
      semanticKeys: ['api'],
    });
    expect(result.resources).toContainEqual({
      stepKey: 'a',
      scope: 'workspace',
      key: 'database',
      rootIdentityDigest: f.binding.rootIdentityDigest,
    });
    expect(result.resources).toContainEqual({
      stepKey: 'a',
      scope: 'machine',
      key: 'browser',
      rootIdentityDigest: null,
    });
    await expect(stat(join(f.path, 'new'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(result.summary.contextDigest).toBe(result.contextDigest);
    expect(JSON.stringify(result.summary)).not.toMatch(
      /canonicalPath|contentHash|rootIdentityDigest/u,
    );
  });

  it('rejects missing/cross-Team, busy and non-writing workers without looking up foreign agents', async () => {
    const f = await fixture();
    for (const [context, code] of [
      [{ ...f.context, team: null }, 'team_unavailable'],
      [
        {
          ...f.context,
          workers: f.context.workers.map((worker) => ({ ...worker, teamId: 'foreign' })),
        },
        'worker_unavailable',
      ],
      [{ ...f.context, busyWorkerIds: ['a'] }, 'worker_busy'],
      [
        {
          ...f.context,
          workers: f.context.workers.map((worker) => ({ ...worker, writeCapable: false })),
        },
        'write_denied',
      ],
      [{ ...f.context, rootIdentities: new Map() }, 'root_unavailable'],
    ] as const) {
      const result = await reviewGraphMission(f.input, f.document, () => context);
      expect(result.summary.matched).toBe(false);
      expect(result.writeFootprints).toBeNull();
      expect(result.writeConflicts).toBeNull();
      expect(result.summary.issues.some((issue) => issue.code === code)).toBe(true);
    }
  });

  it('detects changed source bytes, replaced roots and changed policy snapshots', async () => {
    const f = await fixture();
    let reads = 0;
    const changed = await reviewGraphMission(f.input, f.document, () => ({
      ...f.context,
      policyEpoch: ++reads === 1 ? 1 : 2,
    }));
    expect(changed.summary.issues.some((issue) => issue.code === 'state_changed')).toBe(true);
    await writeFile(join(f.path, 'existing.ts'), 'changed');
    expect(
      (await reviewGraphMission(f.input, f.document, () => f.context)).summary.issues.some(
        (issue) => issue.code === 'source_changed',
      ),
    ).toBe(true);
    const previous = `${f.path}-old`;
    cleanup.push(previous);
    await rename(f.path, previous);
    await mkdir(f.path);
    expect(
      (await reviewGraphMission(f.input, f.document, () => f.context)).summary.issues.some(
        (issue) => issue.code === 'root_changed',
      ),
    ).toBe(true);
  });

  it('logs the guard error code behind a blocked claim path without widening the Issue', async () => {
    const f = await fixture();
    const entries: SecureLogEntry[] = [];
    secureLogger.setSink((entry) => entries.push(entry));
    nativeDirectoryRules.failure = new NativeSafeFsError(
      'ADDON_UNAVAILABLE',
      'Directory name rules are unavailable',
    );
    const result = await reviewGraphMission(f.input, f.document, () => f.context);
    expect(result.summary.matched).toBe(false);
    expect(result.summary.issues).toContainEqual({
      code: 'path_unavailable',
      stepKey: 'b',
      rootId: 'root',
      path: 'new/sub/file.ts',
    });
    expect(entries.map((entry) => entry.context)).toContainEqual(
      expect.objectContaining({
        issue: 'path_unavailable',
        stepKey: 'b',
        path: 'new/sub/file.ts',
        error: expect.objectContaining({ name: 'NativeSafeFsError', code: 'ADDON_UNAVAILABLE' }),
      }),
    );
    // The renderer still learns only the Issue: a review summary never describes the native layer.
    expect(JSON.stringify(result.summary)).not.toMatch(/ADDON_UNAVAILABLE|NativeSafeFsError/u);
  });

  it('resolves an internal directory alias but refuses escaping and dangling aliases', async () => {
    const f = await fixture();
    await mkdir(join(f.path, 'inside'));
    await symlink(
      join(f.path, 'inside'),
      join(f.path, 'alias'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const changedPlan = structuredClone(f.plan);
    changedPlan.steps[1]!.writeClaims[0]!.path = 'alias/new.ts';
    const document = nextGraphDocument('task', f.diagram, null, [], [], changedPlan);
    const inside = await reviewGraphMission(f.input, document, () => f.context);
    expect(inside.summary.matched).toBe(true);
    expect(inside.claims[1]?.canonicalPath).toBe(join(f.binding.canonicalPath, 'inside/new.ts'));
    const outside = await mkdtemp(join(tmpdir(), 'sc-mission-outside-'));
    cleanup.push(outside);
    await rm(join(f.path, 'alias'));
    await symlink(
      outside,
      join(f.path, 'alias'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect(
      (await reviewGraphMission(f.input, document, () => f.context)).summary.issues.some(
        (issue) => issue.code === 'path_unavailable',
      ),
    ).toBe(true);
    await rm(join(f.path, 'alias'));
    await symlink(
      join(f.path, 'missing'),
      join(f.path, 'alias'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect(
      (await reviewGraphMission(f.input, document, () => f.context)).summary.issues.some(
        (issue) => issue.code === 'path_unavailable',
      ),
    ).toBe(true);
  });
});
