import {
  type ToolCatalogSnapshot,
  type ToolExecutionContext,
  type ToolId,
  type ToolImplementation,
  type ToolRegistry,
  type ToolCatalogEntry,
  toolValueMatchesSchema,
} from '@sprint-coder/domain';

export type ToolDispatchRequest = {
  taskId: string;
  turnId: string;
  callId: string;
  providerName: string;
  input: unknown;
  signal?: AbortSignal;
};

export type ToolAuthorizationRequest = Readonly<{
  context: ToolExecutionContext;
  callId: string;
  entry: ToolCatalogEntry;
  input: unknown;
}>;
export type ToolAuthorizationDecision = Readonly<{
  decision: 'allow' | 'deny' | 'approval_required';
  reason: string;
  beforeExecute?: () => boolean;
}>;
export type ToolAuthorizer = (
  request: ToolAuthorizationRequest,
) => Promise<ToolAuthorizationDecision> | ToolAuthorizationDecision;

export const managedToolCallStates = [
  'requested',
  'prepared',
  'awaiting_approval',
  'queued',
  'running',
  'backgrounded',
  'succeeded',
  'failed',
  'denied',
  'canceled',
] as const;
export type ManagedToolCallState = (typeof managedToolCallStates)[number];
export type ManagedToolLifecycleEvent = Readonly<{
  taskId: string;
  turnId: string;
  callId: string;
  ordinal: number;
  providerName: string;
  catalogDigest: string;
  state: ManagedToolCallState;
  occurredAt: string;
}>;

export class ToolAuthorizationDeniedError extends Error {
  constructor(readonly authorization: ToolAuthorizationDecision) {
    super(`Tool authorization ${authorization.decision}: ${authorization.reason}`);
    this.name = 'ToolAuthorizationDeniedError';
  }
}

type BoundTurn = {
  context: ToolExecutionContext;
  snapshot: ToolCatalogSnapshot;
  implementations: ReadonlyMap<ToolId, ToolImplementation>;
  claimedCallIds: Set<string>;
  gate: ToolResourceGate;
  nextOrdinal: number;
};

export class ToolBroker {
  private readonly implementations = new Map<ToolId, ToolImplementation>();
  private readonly turns = new Map<string, BoundTurn>();

  constructor(
    private readonly registry: ToolRegistry,
    private readonly getCurrentPolicyEpoch: (taskId: string) => number,
    private readonly authorize: ToolAuthorizer,
    private readonly lifecycle?: (event: ManagedToolLifecycleEvent) => void,
  ) {}

  registerImplementation(implementation: ToolImplementation): void {
    const definition = this.registry.get(implementation.toolId);
    if (definition === undefined) throw new Error('Cannot implement an unregistered ToolId');
    if (definition.implementationKind !== implementation.implementationKind)
      throw new Error('Tool implementation kind does not match its definition');
    if (implementation.implementationKind === 'mcp-gateway')
      throw new Error('MCP Gateway implementations are reserved for Public Beta');
    if (this.implementations.has(implementation.toolId))
      throw new Error(`Duplicate ToolImplementation: ${implementation.toolId}`);
    this.implementations.set(implementation.toolId, Object.freeze({ ...implementation }));
  }

  startTurn(
    context: ToolExecutionContext,
    providerId: string,
    availableToolIds?: readonly ToolId[],
  ): ToolCatalogSnapshot {
    validateContext(context);
    if (this.getCurrentPolicyEpoch(context.taskId) !== context.policyEpoch)
      throw new Error('Cannot bind a Tool catalog to a stale policy epoch');
    const key = turnKey(context.taskId, context.turnId);
    if (this.turns.has(key)) throw new Error('ToolCatalogSnapshot is already bound to this Turn');
    const snapshot = this.registry.createSnapshot({
      providerId,
      workspaceId: context.workspaceId,
      availableToolIds: (availableToolIds ?? [...this.implementations.keys()]).filter((toolId) =>
        this.implementations.has(toolId),
      ),
    });
    const implementations = new Map<ToolId, ToolImplementation>();
    for (const entry of snapshot.entries) {
      const implementation = this.implementations.get(entry.toolId);
      if (implementation === undefined)
        throw new Error('Snapshot selected a ToolId without an implementation');
      implementations.set(entry.toolId, implementation);
    }
    this.turns.set(key, {
      context: Object.freeze({ ...context }),
      snapshot,
      implementations,
      claimedCallIds: new Set(),
      gate: new ToolResourceGate(),
      nextOrdinal: 0,
    });
    return snapshot;
  }

  getTurnSnapshot(taskId: string, turnId: string): ToolCatalogSnapshot | undefined {
    return this.turns.get(turnKey(taskId, turnId))?.snapshot;
  }

  finishTurn(taskId: string, turnId: string): void {
    this.turns.delete(turnKey(taskId, turnId));
  }

  async dispose(): Promise<void> {
    await Promise.all(
      [...this.implementations.values()].map(async (implementation) => implementation.dispose?.()),
    );
    this.turns.clear();
  }

  async dispatch(request: ToolDispatchRequest): Promise<unknown> {
    if (request.callId.length === 0 || request.callId.length > 128)
      throw new Error('Invalid tool call id');
    const bound = this.turns.get(turnKey(request.taskId, request.turnId));
    if (bound === undefined) throw new Error('No ToolCatalogSnapshot is bound to this Turn');
    if (bound.claimedCallIds.has(request.callId)) throw new Error('Duplicate tool call id');
    bound.claimedCallIds.add(request.callId);
    const ordinal = ++bound.nextOrdinal;
    let terminal = false;
    const transition = (state: ManagedToolCallState): void => {
      this.lifecycle?.({
        taskId: request.taskId,
        turnId: request.turnId,
        callId: request.callId,
        ordinal,
        providerName: request.providerName,
        catalogDigest: bound.snapshot.digest,
        state,
        occurredAt: new Date().toISOString(),
      });
      if (state === 'succeeded' || state === 'failed' || state === 'denied' || state === 'canceled')
        terminal = true;
    };
    transition('requested');
    try {
      if (this.getCurrentPolicyEpoch(request.taskId) !== bound.context.policyEpoch)
        throw new Error('Tool dispatch rejected because the policy epoch changed');
      const entry = bound.snapshot.entries.find(
        ({ providerName }) => providerName === request.providerName,
      );
      if (entry === undefined) throw new Error('Tool name is not present in the Turn catalog');
      const definition = this.registry.get(entry.toolId);
      if (
        definition === undefined ||
        definition.version !== entry.version ||
        definition.schemaDigest !== entry.schemaDigest
      )
        throw new Error('Pinned ToolDefinition no longer matches the Turn catalog');
      const implementation = bound.implementations.get(entry.toolId);
      if (implementation === undefined) throw new Error('Pinned ToolImplementation is unavailable');
      if (implementation.implementationKind !== entry.implementationKind)
        throw new Error('Pinned ToolImplementation kind mismatch');
      const runtimeInput = cloneAndFreeze(request.input);
      if (!toolValueMatchesSchema(entry.inputSchema, runtimeInput))
        throw new Error('Tool input does not match the pinned schema');
      const pinnedInput =
        implementation.prepare === undefined
          ? runtimeInput
          : await implementation.prepare(runtimeInput, bound.context, { callId: request.callId });
      if (!isDeeplyFrozen(pinnedInput))
        throw new Error('Tool implementation returned a mutable prepared input');
      transition('prepared');
      transition('awaiting_approval');
      let authorization: ToolAuthorizationDecision;
      try {
        authorization = await this.authorize({
          context: bound.context,
          callId: request.callId,
          entry,
          input: pinnedInput,
        });
      } catch (error) {
        await implementation.authorizationDenied?.(pinnedInput, bound.context);
        throw error;
      }
      if (authorization.decision !== 'allow') {
        await implementation.authorizationDenied?.(pinnedInput, bound.context);
        transition('denied');
        throw new ToolAuthorizationDeniedError(authorization);
      }
      if (this.turns.get(turnKey(request.taskId, request.turnId)) !== bound) {
        await implementation.authorizationDenied?.(pinnedInput, bound.context);
        throw new Error('Tool dispatch rejected because the Turn ended during authorization');
      }
      if (this.getCurrentPolicyEpoch(request.taskId) !== bound.context.policyEpoch) {
        await implementation.authorizationDenied?.(pinnedInput, bound.context);
        throw new Error('Tool dispatch rejected because the policy epoch changed');
      }
      let executionValid: boolean | undefined;
      try {
        executionValid = authorization.beforeExecute?.();
      } catch (error) {
        await implementation.authorizationDenied?.(pinnedInput, bound.context);
        throw error;
      }
      if (executionValid === false) {
        await implementation.authorizationDenied?.(pinnedInput, bound.context);
        throw new ToolAuthorizationDeniedError({
          decision: 'deny',
          reason: 'execution_revalidation_failed',
        });
      }
      if (request.signal?.aborted) {
        await implementation.authorizationDenied?.(pinnedInput, bound.context);
        throw request.signal.reason instanceof Error
          ? request.signal.reason
          : new Error('Tool dispatch was canceled before execution');
      }
      transition('queued');
      const release = await bound.gate.acquire(
        entry.sideEffect === 'none' || entry.sideEffect === 'read' ? 'read' : 'write',
        request.signal,
      );
      let output: unknown;
      try {
        if (
          this.turns.get(turnKey(request.taskId, request.turnId)) !== bound ||
          this.getCurrentPolicyEpoch(request.taskId) !== bound.context.policyEpoch
        )
          throw new Error('Tool dispatch rejected while waiting for its resource claim');
        transition('running');
        output = await implementation.execute(pinnedInput, bound.context, {
          callId: request.callId,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
      } finally {
        release();
      }
      if (!toolValueMatchesSchema(definition.outputSchema, output))
        throw new Error('Tool output does not match the pinned schema');
      transition('succeeded');
      return output;
    } catch (error) {
      if (!terminal) transition(request.signal?.aborted ? 'canceled' : 'failed');
      throw error;
    }
  }
}

type GateMode = 'read' | 'write';
type GateWaiter = {
  mode: GateMode;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abort?: () => void;
};

class ToolResourceGate {
  private readers = 0;
  private writer = false;
  private readonly queue: GateWaiter[] = [];

  acquire(mode: GateMode, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    return new Promise((resolve, reject) => {
      const waiter: GateWaiter = {
        mode,
        resolve,
        reject,
        ...(signal === undefined ? {} : { signal }),
      };
      if (signal !== undefined) {
        waiter.abort = () => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          reject(abortError(signal));
        };
        signal.addEventListener('abort', waiter.abort, { once: true });
      }
      this.queue.push(waiter);
      this.drain();
    });
  }

  private drain(): void {
    if (this.writer || this.queue.length === 0) return;
    if (this.readers > 0 && this.queue[0]?.mode === 'write') return;
    if (this.queue[0]?.mode === 'write') {
      if (this.readers > 0) return;
      const waiter = this.queue.shift()!;
      this.detach(waiter);
      this.writer = true;
      waiter.resolve(this.releaseOnce('write'));
      return;
    }
    while (!this.writer && this.queue[0]?.mode === 'read') {
      const waiter = this.queue.shift()!;
      this.detach(waiter);
      this.readers += 1;
      waiter.resolve(this.releaseOnce('read'));
    }
  }

  private releaseOnce(mode: GateMode): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (mode === 'write') this.writer = false;
      else this.readers = Math.max(0, this.readers - 1);
      this.drain();
    };
  }

  private detach(waiter: GateWaiter): void {
    if (waiter.signal !== undefined && waiter.abort !== undefined)
      waiter.signal.removeEventListener('abort', waiter.abort);
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Tool dispatch was canceled');
}

function isDeeplyFrozen(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return true;
  if (!Object.isFrozen(value)) return false;
  return Object.values(value).every(isDeeplyFrozen);
}

function cloneAndFreeze<T>(value: T): T {
  const cloned = structuredClone(value);
  const freeze = (candidate: unknown): void => {
    if (typeof candidate !== 'object' || candidate === null || Object.isFrozen(candidate)) return;
    for (const nested of Object.values(candidate)) freeze(nested);
    Object.freeze(candidate);
  };
  freeze(cloned);
  return cloned;
}

function turnKey(taskId: string, turnId: string): string {
  return JSON.stringify([taskId, turnId]);
}

function validateContext(context: ToolExecutionContext): void {
  if (
    context.taskId.length === 0 ||
    context.turnId.length === 0 ||
    (context.workspaceId !== null && context.workspaceId.length === 0) ||
    !Number.isInteger(context.policyEpoch) ||
    context.policyEpoch < 0
  )
    throw new Error('Invalid Tool execution context');
}
