import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagedCodingHarness } from './provider-workspace-tools';
import { FileRevisionRegistry } from './file-revision';
import type { EffectiveWorkspaceSet, GraphSourceRef } from '@sprint-coder/contracts';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const context = {
  taskId: 'task-source',
  turnId: 'turn-source',
  workspaceId: 'workspace',
  policyEpoch: 1,
};
const diagram = {
  schema_version: 1,
  diagram_type: 'architecture',
  meta: { title: 'Proof' },
  components: [{ id: 'api', type: 'backend', label: 'API', pos: [40, 40] }],
  connections: [],
};
async function setup(denyRead: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'graph-harness-'));
  directories.push(root);
  await writeFile(join(root, 'code.ts'), 'export const value = 1;\n');
  const workspace: EffectiveWorkspaceSet = {
    source: 'task',
    projectId: null,
    primaryRootId: 'root',
    roots: [{ rootId: 'root', path: root, label: 'Root', role: 'primary', status: 'available' }],
    digest: 'a'.repeat(64),
  };
  const proposals: (readonly GraphSourceRef[])[] = [];
  const harness = new ManagedCodingHarness({
    workspaceFor: () => workspace,
    rootIdentityFor: () => undefined,
    policyEpochFor: () => 1,
    authorizer: (request) => ({
      decision: denyRead && request.entry.providerName === 'read_file' ? 'deny' : 'allow',
      reason: 'fixture-policy',
    }),
    graphs: {
      read: () => ({}),
      propose: async (_input, _context, _control, sources) => {
        proposals.push(sources ?? []);
        return { phase: 'draft' };
      },
    },
  });
  harness.startTurn(context, 'codex');
  return { harness, proposals };
}
function proposal(tokenId: string) {
  return {
    diagram,
    expectedRenderRevision: 0,
    sources: [
      { kind: 'read', tokenId, elementKind: 'node', elementId: 'api', lineStart: 1, lineEnd: 1 },
    ],
  };
}

describe('source receipts behind the real read authorization boundary', () => {
  it('accepts the execution receipt but not a token created during denied preparation', async () => {
    const tokens: string[] = [];
    const original = FileRevisionRegistry.prototype.readGuarded;
    vi.spyOn(FileRevisionRegistry.prototype, 'readGuarded').mockImplementation(async function (
      this: FileRevisionRegistry,
      input,
    ) {
      const read = await original.call(this, input);
      tokens.push(read.reference.tokenId);
      return read;
    });
    const denied = await setup(true);
    await expect(
      denied.harness.broker.dispatch({
        ...context,
        callId: 'denied-read',
        providerName: 'read_file',
        input: { path: 'code.ts' },
      }),
    ).rejects.toThrow();
    expect(tokens).toHaveLength(1);
    await expect(
      denied.harness.broker.dispatch({
        ...context,
        callId: 'forged-proof',
        providerName: 'graph_propose_document',
        input: proposal(tokens[0]!),
      }),
    ).rejects.toThrow('Source read is unavailable');
    expect(denied.proposals).toEqual([]);
    denied.harness.finishTurn(context.taskId, context.turnId);
    await denied.harness.dispose();
    const allowed = await setup(false);
    const read = z.object({ revision: z.object({ tokenId: z.string() }) }).parse(
      await allowed.harness.broker.dispatch({
        ...context,
        callId: 'allowed-read',
        providerName: 'read_file',
        input: { path: 'code.ts', lineStart: 1, lineEnd: 1 },
      }),
    );
    await allowed.harness.broker.dispatch({
      ...context,
      callId: 'verified-proof',
      providerName: 'graph_propose_document',
      input: proposal(read.revision.tokenId),
    });
    expect(allowed.proposals[0]).toMatchObject([
      { path: 'code.ts', excerpt: 'export const value = 1;', elementId: 'api' },
    ]);
    allowed.harness.finishTurn(context.taskId, context.turnId);
    await allowed.harness.dispose();
  });
});
