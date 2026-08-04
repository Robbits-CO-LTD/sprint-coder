import { randomUUID } from 'node:crypto';
import type { EffectiveWorkspaceSet } from '@sprint-coder/contracts';
import { createToolDefinition, createToolId, type ToolDefinition } from '@sprint-coder/domain';
import { fileRevisionIdentityDigest, type FileRevisionRegistry } from './file-revision';
import type { EditSagaApplyRequest, EditSagaSnapshot } from './edit-saga';
import { PatchValidationError, prepareStructuredPatch } from './structured-patch';
import { describeAnchorFailure } from './anchor-failure-message';
import { isIssuedPathGuard, type PathGuard } from './path-guard';

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
  providerCompatibility: ['*'],
});

export const WORKSPACE_CREATE_FILE_TOOL: ToolDefinition = createToolDefinition({
  toolId: createToolId({
    provider: 'builtin',
    namespace: 'workspace',
    name: 'create-file',
    version: '1',
  }),
  providerName: 'create_file',
  kind: 'fileWrite',
  schemaVersion: 1,
  inputSchema: {
    type: 'object',
    properties: {
      rootId: { type: 'string' },
      path: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  outputSchema: { type: 'object' },
  sideEffect: 'write',
  risk: 'high',
  requiredCapabilities: ['workspace.write'],
  executionTarget: 'main',
  implementationKind: 'built-in',
  priority: 10,
  workspaceBinding: { kind: 'any' },
  providerCompatibility: ['*'],
});

export const WORKSPACE_CREATE_DIRECTORY_TOOL: ToolDefinition = createToolDefinition({
  toolId: createToolId({
    provider: 'builtin',
    namespace: 'workspace',
    name: 'create-directory',
    version: '1',
  }),
  providerName: 'create_directory',
  kind: 'fileWrite',
  schemaVersion: 1,
  inputSchema: {
    type: 'object',
    properties: { rootId: { type: 'string' }, path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  },
  outputSchema: { type: 'object' },
  sideEffect: 'write',
  risk: 'high',
  requiredCapabilities: ['workspace.write'],
  executionTarget: 'main',
  implementationKind: 'built-in',
  priority: 10,
  workspaceBinding: { kind: 'any' },
  providerCompatibility: ['*'],
});

export type WorkspacePatchDeps = Readonly<{
  turnWorkspaceSetFor: (taskId: string, turnId: string) => EffectiveWorkspaceSet | null;
  turnRootMutationBindingsFor: (
    turnId: string,
  ) => ReadonlyMap<string, { workspaceKey: string; rootIdentityDigest: string }>;
  revisions: FileRevisionRegistry;
  apply: (request: EditSagaApplyRequest) => Promise<EditSagaSnapshot>;
  createDirectory?: (input: {
    taskId: string;
    turnId: string;
    rootId: string;
    path: string;
    guard: PathGuard;
  }) => Promise<void>;
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
  approvedGuard?: PathGuard,
  approvedReadGuard?: PathGuard,
): Promise<{
  rootId: string;
  path: string;
  sagaId: string;
  state: string;
  edits: number;
  kind: 'update';
}> {
  const request = parseInput(input);
  const workspace = deps.turnWorkspaceSetFor(context.taskId, context.turnId);
  if (workspace === null) throw new Error('apply_patch requires a sealed Turn Workspace snapshot');
  if (workspace.roots.length === 0) throw new Error('apply_patch requires a selected Workspace');
  const requestedRootId = request.rootId ?? workspace.primaryRootId;
  const root = workspace.roots.find(({ rootId }) => rootId === requestedRootId);
  if (root === undefined) throw new Error('apply_patch requires a valid Workspace rootId');
  const mutationBinding =
    workspace.source === 'project'
      ? deps.turnRootMutationBindingsFor(context.turnId).get(root.rootId)
      : undefined;
  if (workspace.source === 'project' && mutationBinding === undefined)
    throw new Error('apply_patch Turn Workspace identity is incomplete');
  const expectedRootIdentityDigest = mutationBinding?.rootIdentityDigest;

  const owner = { taskId: context.taskId, turnId: context.turnId };
  const policyEpoch = deps.policyEpochFor(context.taskId);
  // Read pins the revision the patch is validated against, so a file that changes between this
  // read and the write is a rejected patch rather than a silently clobbered edit.
  const revision =
    approvedReadGuard === undefined
      ? await deps.revisions.read({
          owner,
          rootId: root.rootId,
          workspacePath: root.path,
          ...(expectedRootIdentityDigest === undefined ? {} : { expectedRootIdentityDigest }),
          targetPath: request.path,
          policyEpoch,
        })
      : await deps.revisions.readGuarded({ owner, guard: approvedReadGuard, policyEpoch });

  let plan;
  try {
    plan = await prepareStructuredPatch({
      owner,
      rootId: root.rootId,
      workspacePath: root.path,
      ...(expectedRootIdentityDigest === undefined ? {} : { expectedRootIdentityDigest }),
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
  assertApprovedPatchTarget(plan, approvedGuard, 'update');

  const saga = await deps.apply({
    id: (deps.newId ?? randomUUID)(),
    taskId: context.taskId,
    turnId: context.turnId,
    operationId: (deps.newId ?? randomUUID)(),
    plan,
    ...(mutationBinding === undefined
      ? {}
      : {
          mutationBinding: {
            rootId: root.rootId,
            workspacePath: root.path,
            workspaceKey: mutationBinding.workspaceKey,
            rootIdentityDigest: mutationBinding.rootIdentityDigest,
          },
        }),
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
    kind: 'update',
  };
}

export async function executeWorkspaceCreateFile(
  input: unknown,
  context: WorkspacePatchContext,
  deps: WorkspacePatchDeps,
  approvedGuard?: PathGuard,
): Promise<{ rootId: string; path: string; sagaId: string; state: string; kind: 'add' }> {
  const request = parseCreateFileInput(input);
  const workspace = deps.turnWorkspaceSetFor(context.taskId, context.turnId);
  if (workspace === null) throw new Error('create_file requires a sealed Turn Workspace snapshot');
  if (workspace.roots.length === 0) throw new Error('create_file requires a selected Workspace');
  const requestedRootId = request.rootId ?? workspace.primaryRootId;
  const root = workspace.roots.find(({ rootId }) => rootId === requestedRootId);
  if (root === undefined) throw new Error('create_file requires a valid Workspace rootId');
  const mutationBinding =
    workspace.source === 'project'
      ? deps.turnRootMutationBindingsFor(context.turnId).get(root.rootId)
      : undefined;
  if (workspace.source === 'project' && mutationBinding === undefined)
    throw new Error('create_file Turn Workspace identity is incomplete');
  const plan = await prepareStructuredPatch({
    owner: { taskId: context.taskId, turnId: context.turnId },
    rootId: root.rootId,
    workspacePath: root.path,
    ...(mutationBinding === undefined
      ? {}
      : { expectedRootIdentityDigest: mutationBinding.rootIdentityDigest }),
    policyEpoch: deps.policyEpochFor(context.taskId),
    registry: deps.revisions,
    operations: [{ kind: 'add', path: request.path, content: request.content }],
  });
  assertApprovedPatchTarget(plan, approvedGuard, 'add');
  const saga = await deps.apply({
    id: (deps.newId ?? randomUUID)(),
    taskId: context.taskId,
    turnId: context.turnId,
    operationId: (deps.newId ?? randomUUID)(),
    plan,
    ...(mutationBinding === undefined
      ? {}
      : {
          mutationBinding: {
            rootId: root.rootId,
            workspacePath: root.path,
            workspaceKey: mutationBinding.workspaceKey,
            rootIdentityDigest: mutationBinding.rootIdentityDigest,
          },
        }),
    createdAt: (deps.now ?? (() => new Date().toISOString()))(),
  });
  return { rootId: root.rootId, path: request.path, sagaId: saga.id, state: saga.state, kind: 'add' };
}

function assertApprovedPatchTarget(
  plan: Awaited<ReturnType<typeof prepareStructuredPatch>>,
  guard: PathGuard | undefined,
  kind: 'add' | 'update',
): void {
  if (guard === undefined) return;
  const operation = plan.operations[0];
  if (
    !isIssuedPathGuard(guard) ||
    operation === undefined ||
    operation.kind !== kind ||
    operation.canonicalPath !== guard.resolvedPath ||
    operation.path !== guard.originalTargetPath ||
    guard.operation !== 'write' ||
    (kind === 'add'
      ? guard.targetIdentity !== null
      : guard.targetIdentity?.kind !== 'file' ||
        operation.preRevision?.identityDigest !== fileRevisionIdentityDigest(guard.targetIdentity))
  )
    throw new Error('Workspace mutation target changed after authorization');
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

function parseCreateFileInput(input: unknown): { rootId?: string; path: string; content: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new Error('create_file requires an object');
  const { rootId, path, content } = input as {
    rootId?: unknown;
    path?: unknown;
    content?: unknown;
  };
  if (rootId !== undefined && (typeof rootId !== 'string' || rootId.length === 0))
    throw new Error('create_file rootId must be a non-empty string');
  if (typeof path !== 'string' || path.length === 0) throw new Error('create_file requires a path');
  if (typeof content !== 'string') throw new Error('create_file requires string content');
  return { ...(typeof rootId === 'string' ? { rootId } : {}), path, content };
}
