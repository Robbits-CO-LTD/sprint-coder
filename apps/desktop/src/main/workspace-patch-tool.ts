import { randomUUID } from 'node:crypto';
import type { EffectiveWorkspaceSet } from '@sprint-coder/contracts';
import { createToolDefinition, createToolId, type ToolDefinition } from '@sprint-coder/domain';
import type { FileRevisionRegistry } from './file-revision';
import type { EditSagaApplyRequest, EditSagaSnapshot } from './edit-saga';
import { PatchValidationError, prepareStructuredPatch } from './structured-patch';
import { describeAnchorFailure } from './anchor-failure-message';

// The agent's edit tool.
//
// It is defined here but published nowhere by default. Workspace mutation is governed by
// `native-mutation-platform-gate.ts`, which is the single decision point for whether the Edit Saga's
// native authority may activate at all, and `index.ts` is the only place that evaluates it. This
// module therefore takes its dependencies as an argument that `index.ts` supplies *only* when that
// gate allows — so a closed gate does not disable the tool, it means the tool was never registered
// and the model never sees it. That is deliberately not the same thing as a tool that exists and
// refuses: a model shown an edit tool that always fails will keep trying it.
//
// Everything the model can reach goes through `prepareStructuredPatch`, which validates the whole
// batch against a pinned file revision before a byte is written, and then through the Edit Saga,
// which is what makes a partly-applied patch impossible. Nothing here writes to disk itself.

export const WORKSPACE_PATCH_TOOL: ToolDefinition = createToolDefinition({
  toolId: createToolId({
    provider: 'builtin',
    namespace: 'workspace',
    name: 'patch',
    version: '1',
  }),
  providerName: 'apply_patch',
  kind: 'fileWrite',
  schemaVersion: 1,
  inputSchema: {
    type: 'object',
    properties: {
      rootId: { type: 'string' },
      path: { type: 'string' },
      edits: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: { oldText: { type: 'string' }, newText: { type: 'string' } },
          required: ['oldText', 'newText'],
          additionalProperties: false,
        },
      },
    },
    required: ['path', 'edits'],
    additionalProperties: false,
  },
  outputSchema: { type: 'object' },
  sideEffect: 'write',
  risk: 'high',
  requiredCapabilities: ['workspace.read', 'workspace.write'],
  executionTarget: 'main',
  implementationKind: 'built-in',
  priority: 10,
  workspaceBinding: { kind: 'any' },
  providerCompatibility: ['codex', 'claude'],
});

export type WorkspacePatchDeps = Readonly<{
  workspaceSetFor: (taskId: string) => EffectiveWorkspaceSet;
  revisions: FileRevisionRegistry;
  apply: (request: EditSagaApplyRequest) => Promise<EditSagaSnapshot>;
  policyEpochFor: (taskId: string) => number;
  newId?: () => string;
  now?: () => string;
}>;

export type WorkspacePatchContext = Readonly<{ taskId: string; turnId: string }>;

/**
 * Raised for a failure the model can act on, carrying the text it should be shown.
 *
 * Distinct from an ordinary error because the two want opposite handling: an anchor that missed is
 * a normal step in editing and the model should get the diagnosis and retry, while a missing
 * Workspace or a failed Saga is not something it can fix by rewording.
 */
export class WorkspacePatchRejection extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspacePatchRejection';
  }
}

export async function executeWorkspacePatch(
  input: unknown,
  context: WorkspacePatchContext,
  deps: WorkspacePatchDeps,
): Promise<{ rootId: string; path: string; sagaId: string; state: string; edits: number }> {
  const request = parseInput(input);
  const workspace = deps.workspaceSetFor(context.taskId);
  if (workspace.roots.length === 0) throw new Error('apply_patch requires a selected Workspace');
  const requestedRootId = request.rootId ?? workspace.primaryRootId;
  const root = workspace.roots.find(({ rootId }) => rootId === requestedRootId);
  if (root === undefined) throw new Error('apply_patch requires a valid Workspace rootId');

  const owner = { taskId: context.taskId, turnId: context.turnId };
  const policyEpoch = deps.policyEpochFor(context.taskId);
  // Read pins the revision the patch is validated against, so a file that changes between this
  // read and the write is a rejected patch rather than a silently clobbered edit.
  const revision = await deps.revisions.read({
    owner,
    rootId: root.rootId,
    workspacePath: root.path,
    targetPath: request.path,
    policyEpoch,
  });

  let plan;
  try {
    plan = await prepareStructuredPatch({
      owner,
      rootId: root.rootId,
      workspacePath: root.path,
      policyEpoch,
      registry: deps.revisions,
      operations: [
        {
          kind: 'update',
          path: request.path,
          revision: revision.reference,
          edits: request.edits,
        },
      ],
    });
  } catch (error) {
    // The whole point of the recovery payload: the model is told what is there now and can retry
    // without re-reading. Anything without one falls through as an ordinary failure.
    if (error instanceof PatchValidationError) {
      const described = describeAnchorFailure(error);
      throw new WorkspacePatchRejection(described ?? error.message);
    }
    throw error;
  }

  const saga = await deps.apply({
    id: (deps.newId ?? randomUUID)(),
    taskId: context.taskId,
    turnId: context.turnId,
    operationId: (deps.newId ?? randomUUID)(),
    plan,
    createdAt: (deps.now ?? (() => new Date().toISOString()))(),
  });
  // A Saga that did not commit left the file as it was; reporting the state rather than throwing
  // lets the model see the difference between "rejected" and "applied".
  return {
    rootId: root.rootId,
    path: request.path,
    sagaId: saga.id,
    state: saga.state,
    edits: request.edits.length,
  };
}

function parseInput(input: unknown): {
  rootId?: string;
  path: string;
  edits: { oldText: string; newText: string }[];
} {
  if (typeof input !== 'object' || input === null)
    throw new Error('apply_patch requires an object');
  const { rootId, path, edits } = input as {
    rootId?: unknown;
    path?: unknown;
    edits?: unknown;
  };
  if (rootId !== undefined && (typeof rootId !== 'string' || rootId.length === 0))
    throw new Error('apply_patch rootId must be a non-empty string');
  if (typeof path !== 'string' || path.length === 0) throw new Error('apply_patch requires a path');
  if (!Array.isArray(edits) || edits.length === 0)
    throw new Error('apply_patch requires at least one edit');
  return {
    ...(typeof rootId === 'string' ? { rootId } : {}),
    path,
    edits: edits.map((edit) => {
      if (typeof edit !== 'object' || edit === null) throw new Error('Each edit must be an object');
      const { oldText, newText } = edit as { oldText?: unknown; newText?: unknown };
      if (typeof oldText !== 'string' || typeof newText !== 'string')
        throw new Error('Each edit needs a string oldText and newText');
      return { oldText, newText };
    }),
  };
}
