import {
  type ToolCatalogSnapshot,
  type ToolExecutionContext,
  type ToolId,
  type ToolImplementation,
  type ToolRegistry,
  type ToolCatalogEntry,
  type ToolResourceClaim,
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

type ToolDispatchResultConsumer = (result: unknown) => Promise<unknown> | unknown;

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
  approvalDecision?: 'allow_once' | 'allow_task' | 'deny';
  userInputSelection?: number;
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
  resultGate: OrderedToolResultGate;
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
      gate: new ToolResourceGate(8),
      resultGate: new OrderedToolResultGate(),
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

  async dispatch(
    request: ToolDispatchRequest,
    resultConsumer?: ToolDispatchResultConsumer,
  ): Promise<unknown> {
    if (request.callId.length === 0 || request.callId.length > 128)
      throw new Error('Invalid tool call id');
    const bound = this.turns.get(turnKey(request.taskId, request.turnId));
    if (bound === undefined) throw new Error('No ToolCatalogSnapshot is bound to this Turn');
    if (bound.claimedCallIds.has(request.callId)) throw new Error('Duplicate tool call id');
    bound.claimedCallIds.add(request.callId);
    const ordinal = ++bound.nextOrdinal;
    let terminal = false;
    let resultGateStarted = false;
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
      const claims = normalizeResourceClaims(
        implementation.resourceClaims?.(pinnedInput, bound.context) ?? [
          {
            key: `workspace:${bound.context.workspaceId ?? bound.context.taskId}`,
            mode: entry.parallelism === 'parallel' ? 'read' : 'write',
          },
        ],
      );
      const release = await bound.gate.acquire(claims, request.signal);
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
          ...(authorization.approvalDecision === undefined
            ? {}
            : { authorizationDecision: authorization.approvalDecision }),
          ...(authorization.userInputSelection === undefined
            ? {}
            : { userInputSelection: authorization.userInputSelection }),
        });
      } finally {
        release();
      }
      if (resultConsumer !== undefined) {
        if (request.signal?.aborted) throw abortError(request.signal);
        output = await resultConsumer(output);
      }
      if (!toolValueMatchesSchema(definition.outputSchema, output))
        throw new Error('Tool output does not match the pinned schema');
      if (Buffer.byteLength(JSON.stringify(output), 'utf8') > entry.maxOutputBytes)
        throw new Error('Tool output exceeded the pinned output limit');
      if (resultConsumer !== undefined) {
        resultGateStarted = true;
        await bound.resultGate.complete(ordinal);
        if (request.signal?.aborted) throw abortError(request.signal);
      }
      if (
        entry.supportsBackground &&
        typeof output === 'object' &&
        output !== null &&
        (output as Record<string, unknown>)['state'] === 'running' &&
        typeof (output as Record<string, unknown>)['sessionId'] === 'string'
      )
        transition('backgrounded');
      else transition('succeeded');
      if (!resultGateStarted) {
        resultGateStarted = true;
        await bound.resultGate.complete(ordinal);
      }
      return output;
    } catch (error) {
      if (!terminal) transition(request.signal?.aborted ? 'canceled' : 'failed');
      if (!resultGateStarted) await bound.resultGate.complete(ordinal);
      throw error;
    }
  }
}

type GateWaiter = {
  claims: readonly ToolResourceClaim[];
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abort?: () => void;
};

class ToolResourceGate {
  private readers = 0;
  private readonly active = new Map<string, { readers: number; writer: boolean }>();
  private readonly queue: GateWaiter[] = [];

  constructor(private readonly maxReaders: number) {
    if (!Number.isInteger(maxReaders) || maxReaders < 1)
      throw new Error('Tool resource gate requires a positive reader bound');
  }

  acquire(claims: readonly ToolResourceClaim[], signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    return new Promise((resolve, reject) => {
      const waiter: GateWaiter = {
        claims,
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
    while (this.queue.length > 0) {
      const waiter = this.queue[0]!;
      if (!this.canAcquire(waiter.claims)) return;
      this.queue.shift();
      this.detach(waiter);
      this.activate(waiter.claims);
      waiter.resolve(this.releaseOnce(waiter.claims));
    }
  }

  private canAcquire(claims: readonly ToolResourceClaim[]): boolean {
    if (claims.some(({ mode }) => mode === 'read') && this.readers >= this.maxReaders) return false;
    return claims.every((claim) => {
      const state = this.active.get(claim.key);
      if (state === undefined) return true;
      return claim.mode === 'read' ? !state.writer : !state.writer && state.readers === 0;
    });
  }

  private activate(claims: readonly ToolResourceClaim[]): void {
    if (claims.some(({ mode }) => mode === 'read')) this.readers += 1;
    for (const claim of claims) {
      const state = this.active.get(claim.key) ?? { readers: 0, writer: false };
      if (claim.mode === 'read') state.readers += 1;
      else state.writer = true;
      this.active.set(claim.key, state);
    }
  }

  private releaseOnce(claims: readonly ToolResourceClaim[]): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (claims.some(({ mode }) => mode === 'read')) this.readers = Math.max(0, this.readers - 1);
      for (const claim of claims) {
        const state = this.active.get(claim.key);
        if (state === undefined) continue;
        if (claim.mode === 'read') state.readers = Math.max(0, state.readers - 1);
        else state.writer = false;
        if (state.readers === 0 && !state.writer) this.active.delete(claim.key);
      }
      this.drain();
    };
  }

  private detach(waiter: GateWaiter): void {
    if (waiter.signal !== undefined && waiter.abort !== undefined)
      waiter.signal.removeEventListener('abort', waiter.abort);
  }
}

function normalizeResourceClaims(
  claims: readonly ToolResourceClaim[],
): readonly ToolResourceClaim[] {
  if (claims.length < 1 || claims.length > 32) throw new Error('Invalid tool resource claims');
  const byKey = new Map<string, 'read' | 'write'>();
  for (const claim of claims) {
    if (
      typeof claim.key !== 'string' ||
      claim.key.length < 1 ||
      claim.key.length > 4_096 ||
      (claim.mode !== 'read' && claim.mode !== 'write')
    )
      throw new Error('Invalid tool resource claim');
    const existing = byKey.get(claim.key);
    byKey.set(claim.key, claim.mode === 'write' || existing === 'write' ? 'write' : 'read');
  }
  return Object.freeze(
    [...byKey]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, mode]) => Object.freeze({ key, mode })),
  );
}

class OrderedToolResultGate {
  private nextOrdinal = 1;
  private readonly completed = new Map<number, () => void>();
  private drainScheduled = false;

  complete(ordinal: number): Promise<void> {
    if (!Number.isInteger(ordinal) || ordinal < this.nextOrdinal)
      return Promise.reject(new Error('Managed tool result ordinal is invalid'));
    if (this.completed.has(ordinal))
      return Promise.reject(new Error('Managed tool result ordinal completed twice'));
    return new Promise((resolve) => {
      this.completed.set(ordinal, resolve);
      this.scheduleDrain();
    });
  }

  private scheduleDrain(): void {
    if (this.drainScheduled || !this.completed.has(this.nextOrdinal)) return;
    this.drainScheduled = true;
    setImmediate(() => {
      this.drainScheduled = false;
      const resolve = this.completed.get(this.nextOrdinal);
      if (resolve === undefined) return;
      this.completed.delete(this.nextOrdinal);
      this.nextOrdinal += 1;
      resolve();
      this.scheduleDrain();
    });
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
