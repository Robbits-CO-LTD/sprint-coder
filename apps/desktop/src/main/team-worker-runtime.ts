import { modelSelectionForRuntime } from './connection-identity';
import { randomUUID } from 'node:crypto';
import { posix, win32 } from 'node:path';
import type {
  ChatMessage,
  PublicError,
  RuntimeKind,
  RuntimeWriteScope,
  WorkerCompletion,
} from '@sprint-coder/contracts';
import { verifyToolCatalogSnapshot, type ToolCatalogSnapshot } from '@sprint-coder/domain';
import { RuntimeHostClient } from './runtime-host';
import {
  DeterministicTeamWorkerRuntime,
  WorkerRuntimeExitUnconfirmedError,
  WorkerRuntimeFailureError,
  type TeamRuntimeConversationItem,
  type TeamWorkerRuntime,
  type WorkerActivityEvent,
  type WorkerRuntimeResult,
} from './team-coordinator';
import type { AgentRecord } from './persistence';
import type { PreparedContext } from './context-ledger';
import { serializeCliExecutionPayload } from '../runtime-host/execution-payload';
import {
  runtimeWorkspaceSetFromLegacyPath,
  type RuntimeFailureDiagnostic,
  type RuntimeProcessIdentity,
  type RuntimeTeamMcpOption,
  type RuntimeToolRequest,
  type RuntimeWorkspaceSet,
} from '../runtime-host/protocol';
import { compilePromptGuidance, injectPromptGuidance } from './prompt-context';
import { readWorkerCriteriaReport, workerCriteriaPrompt } from './team-worker-criteria';
import type { ApprovalWaitObserver } from './tool-broker';
import { workerWriteLimitNotice, workspaceWriteLimitsFromTools } from './workspace-write-limits';

// Real Worker execution (Phase 7 follow-up: "Team must work without mocks"). Each dispatched
// Worker task runs one ephemeral, read-only/no-tools turn on a production runtime (Claude/Codex)
// through the same UtilityProcess adapter boundary as chat turns — provider output never reaches
// Main un-normalized. When no production runtime is selectable (probe failed, egress denied, or
// the app runs on the mock runtime without any real CLI available) execution fails explicitly.
// Production must never present simulated Worker output as a real Team report.

export type RealRuntimeChoice = Readonly<{ kind: 'claude' | 'codex' | 'grok'; model: string }>;

const UNKNOWN_RUNTIME_RETRY_DELAY_MS = 60_000;
// Pause before asking the Runtime Host again whether an unconfirmed Turn has exited. The Host keeps
// an exit that arrives with nobody waiting for 60 seconds, so no exit is missed in between.
const UNCONFIRMED_EXIT_RECHECK_DELAY_MS = 1_000;
// Longest a new execution waits for its Worker's previous Turn to finish its own exit wait, which the
// Runtime Host bounds at 30 seconds.
const PREVIOUS_TURN_EXIT_WAIT_MS = 30_000;
const PREVIOUS_TURN_EXIT_UNCONFIRMED_MESSAGE =
  'このWorkerの前回のCLI実行が終了したことをまだ確認できていないため、新しい実行を開始しませんでした。終了を確認でき次第、次の実行を開始できます。確認できないままの場合は、前回のCLIのプロセスが残っていないことを確かめてからアプリを再起動してください。';

export class TeamRuntimeAvailabilityTracker {
  private readonly unavailableUntil = new Map<'claude' | 'codex' | 'grok', number>();

  isAvailable(kind: 'claude' | 'codex' | 'grok', now = Date.now()): boolean {
    const until = this.unavailableUntil.get(kind);
    if (until === undefined) return true;
    if (until > now) return false;
    this.unavailableUntil.delete(kind);
    return true;
  }

  markUnavailable(kind: 'claude' | 'codex' | 'grok', retryAt?: string, now = Date.now()): void {
    const parsed = retryAt === undefined ? Number.NaN : Date.parse(retryAt);
    this.unavailableUntil.set(
      kind,
      Number.isFinite(parsed) ? parsed : now + UNKNOWN_RUNTIME_RETRY_DELAY_MS,
    );
  }
}

export type TeamWorkerRuntimeDeps = Readonly<{
  /** Ordered, policy-allowed runtime candidates. The selected model must be first. */
  selectRuntimes: (worker: AgentRecord) => readonly RealRuntimeChoice[];
  availability: TeamRuntimeAvailabilityTracker;
  workspaceFor: (taskId: string) => string | null;
  catalogFor: (
    kind: 'claude' | 'codex' | 'grok',
    taskId: string,
    runtimeTurnId: string,
    workspace: RuntimeWorkspaceSet,
    worker: AgentRecord,
    writeScope: RuntimeWriteScope,
    /** Present for Team Execution dispatches; Main resolves the owning Mission from it. */
    executionId?: string,
    /** The execution's `onApprovalWait`, bound to this Turn's managed tool calls (issue #573). */
    onApprovalWait?: ApprovalWaitObserver,
  ) => unknown | Promise<unknown>;
  /** Provider egress gate; returns false when policy denies the dispatch. */
  authorizeEgress: (
    kind: 'claude' | 'codex' | 'grok',
    taskId: string,
    turnId: string,
    prompt: string,
    context: PreparedContext,
    /** Canonical Main-issued roots this dispatch may name: the isolation worktree included. */
    knownWorkspaceRoots: readonly string[],
  ) => boolean;
  contextFor?: (worker: AgentRecord, executionId?: string) => PreparedContext;
  writeScopeFor?: (worker: AgentRecord, workspacePath: string | null) => RuntimeWriteScope;
  /**
   * Task の安全設定が書き込みのたびに利用者の承認を求めるとき true（issue #525）。未指定は false で、
   * そのとき指示文は変わらない。
   */
  writeApprovalRequiredFor?: (taskId: string) => boolean;
  teamMcpFor?: (
    worker: AgentRecord,
    turnId: string,
    executionId?: string,
    toolCatalog?: ToolCatalogSnapshot,
  ) => RuntimeTeamMcpOption | undefined;
  releaseTeamMcp?: (turnId: string) => void;
  releaseManagedTurn?: (turnId: string) => void;
  invokeManagedTool?: (
    taskId: string,
    turnId: string,
    request: RuntimeToolRequest,
    signal: AbortSignal,
  ) => Promise<unknown>;
  bindTeamMcpProcess?: (turnId: string, identity: RuntimeProcessIdentity) => boolean;
  codexIsolationRoot?: string;
  /** Explicit development/test opt-in. Production callers leave this false. */
  allowSimulation?: boolean;
}>;

// Managed tools that change the Workspace. Only their policy denials count against a write
// execution; a denied read or search does not mean the Worker failed to write.
export const WORKSPACE_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'create_file',
  'create_directory',
  'apply_patch',
]);

export type WorkerWriteObservation = { committed: number; denied: number };

/** Told to a Worker whose Leader asked for edits that this run cannot make. */
export const WORKER_CANNOT_WRITE_NOTICE =
  'Leaderは編集を依頼していますが、今回の実行ではファイルを変更できません。ファイルは変更せず、必要な変更内容を報告してください。';

/**
 * 安全設定「確認する」の Task で、書き込み可能な実行の Worker に伝える（issue #525）。書き込みは
 * 1回ごとに親の Turn（Leader の Turn、Graph Mission ではそのセッション Turn）の承認カードで利用者の
 * 許可を待つ。
 */
export const WORKER_WRITE_APPROVAL_NOTICE =
  'ファイルの書き込みは、1回ごとに利用者の承認を待ってから反映されます。拒否された書き込みは同じ内容で繰り返さず、必要な変更内容を報告してください。';

/**
 * How much text the Turn has produced, and how much of it came before its last tool call. The
 * Turn's text is every delta joined, what the Worker wrote before a tool call included, so a
 * per-criterion report is read only from the text after that call (issue #550).
 */
type WorkerOutputObservation = { length: number; lastToolAt: number };

type PendingRun = {
  resolve: (finalText: string) => void;
  reject: (error: Error) => void;
  buffer: string[];
  onEvent?: (event: WorkerActivityEvent) => void;
  deltaBuffer: string[];
  deltaTimer: NodeJS.Timeout | null;
  reasoningActive: boolean;
  runtimeStarted: boolean;
  sideEffectsObserved: boolean;
  writeScope: RuntimeWriteScope;
  writes: WorkerWriteObservation;
  output: WorkerOutputObservation;
};

class TeamRuntimeExecutionError extends WorkerRuntimeFailureError {
  constructor(
    publicError: PublicError,
    readonly safeToRetry: boolean,
    runtimeKind: 'claude' | 'codex' | 'grok',
    runtimeTurnId: string,
    failureDiagnostic: RuntimeFailureDiagnostic | undefined,
  ) {
    super(publicError, runtimeKind, runtimeTurnId, failureDiagnostic);
    this.name = 'TeamRuntimeExecutionError';
  }
}

type TeamWorkerExecutionInput = Parameters<TeamWorkerRuntime['execute']>[0];

/** The Worker and the Team execution a Turn ran for; the execution is unknown when none was given. */
type TurnOwner = { agentId: string; executionId: string | undefined };

export class RuntimeHostTeamWorkerRuntime implements TeamWorkerRuntime {
  private readonly executionAborts = new Map<string, AbortController>();
  private readonly simulator = new DeterministicTeamWorkerRuntime();
  private readonly clients = new Map<'claude' | 'codex' | 'grok', RuntimeHostClient>();
  private readonly pending = new Map<string, PendingRun>();
  private readonly activeByAgent = new Map<
    string,
    { kind: 'claude' | 'codex' | 'grok'; taskId: string; turnId: string }
  >();
  /**
   * Turns whose process-tree exit Main could not confirm, keyed by Turn id (issue #548). Their
   * Worker starts no other CLI Turn until the Runtime Host reports the exit. Kept in memory only:
   * an app restart clears it. `cleared` resolves once the exit is confirmed and the record is gone;
   * a disposed runtime never resolves it.
   */
  private readonly unconfirmedExits = new Map<
    string,
    TurnOwner & { kind: 'claude' | 'codex' | 'grok'; cleared: Promise<void> }
  >();
  private readonly unconfirmedExitRechecks = new Set<NodeJS.Timeout>();
  /**
   * Turns still inside their post-Turn exit wait, keyed by Turn id. A stopped or timed-out
   * execution returns before that wait ends, so its Worker can be dispatched again meanwhile;
   * `settled` resolves once the wait has ended and any unconfirmed exit has been recorded.
   */
  private readonly exitWaits = new Map<string, TurnOwner & { settled: Promise<void> }>();
  private disposed = false;

  constructor(private readonly deps: TeamWorkerRuntimeDeps) {}

  private client(kind: 'claude' | 'codex' | 'grok'): RuntimeHostClient {
    const existing = this.clients.get(kind);
    if (existing !== undefined) return existing;
    const created = new RuntimeHostClient(
      (_taskId, turnId, event) => {
        const run = this.pending.get(turnId);
        if (run === undefined) return;
        if (event.type === 'heartbeat') {
          run.onEvent?.({ type: 'heartbeat', at: event.at });
          return;
        }
        if (event.type === 'stage')
          run.onEvent?.({
            type: 'activity',
            phase: event.stage,
            label: stageLabel(event.stage),
            at: new Date().toISOString(),
          });
        if (event.type === 'operation') {
          // Every adapter reports a tool or command it starts as an operation (Claude tool_use,
          // Codex tool and command items, Grok tool_call).
          run.output.lastToolAt = run.output.length;
          if (event.sideEffect === true) run.sideEffectsObserved = true;
          run.onEvent?.({
            type: 'activity',
            phase: event.phase,
            label: event.label,
            at: new Date().toISOString(),
          });
        }
        if (event.type === 'delta') {
          run.buffer.push(event.delta);
          run.output.length += event.delta.length;
          run.deltaBuffer.push(event.delta);
          if (run.deltaTimer === null) run.deltaTimer = setTimeout(() => flushDelta(run), 75);
        }
        if (event.type === 'reasoning' && !run.reasoningActive) {
          run.reasoningActive = true;
          run.onEvent?.({ type: 'reasoningPresence', active: true });
        }
        if (event.type === 'completed') {
          flushDelta(run);
          if (run.reasoningActive) run.onEvent?.({ type: 'reasoningPresence', active: false });
          run.onEvent?.({ type: 'completed' });
          this.pending.delete(turnId);
          run.resolve(run.buffer.join(''));
        }
      },
      (_taskId, turnId, error, diagnostic) => {
        const run = this.pending.get(turnId);
        if (run === undefined) return;
        flushDelta(run);
        if (run.reasoningActive) run.onEvent?.({ type: 'reasoningPresence', active: false });
        this.pending.delete(turnId);
        run.reject(
          new TeamRuntimeExecutionError(
            error,
            !run.runtimeStarted || (run.writeScope === 'read-only' && !run.sideEffectsObserved),
            kind,
            turnId,
            diagnostic?.runtimeKind === kind ? diagnostic : undefined,
          ),
        );
      },
      undefined,
      undefined,
      kind,
      this.deps.codexIsolationRoot,
      (_taskId, turnId, identity) => this.deps.bindTeamMcpProcess?.(turnId, identity) === true,
      (taskId, turnId, request, signal) => {
        if (this.deps.invokeManagedTool === undefined)
          return Promise.reject(new Error('Managed Coding Harness is unavailable'));
        return this.deps.invokeManagedTool(taskId, turnId, request, signal);
      },
    );
    this.clients.set(kind, created);
    return created;
  }

  async start(worker: AgentRecord): Promise<{ pid: null }> {
    void worker;
    return { pid: null };
  }

  async execute(input: TeamWorkerExecutionInput): Promise<WorkerRuntimeResult> {
    const execution: TurnOwner = { agentId: input.worker.id, executionId: input.executionId };
    if (input.signal?.aborted === true) {
      // Stopping this execution does not end an earlier Turn that still blocks its Worker, so it is
      // reported as that refusal: a plain stop would pass for a confirmed one and free a worktree
      // that Turn may still use.
      const refusal = this.previousTurnRefusal(execution, input.signal);
      if (refusal !== null) throw refusal;
      input.signal.throwIfAborted();
    }
    const controller = new AbortController();
    this.executionAborts.set(input.worker.id, controller);
    try {
      const signal =
        input.signal === undefined
          ? controller.signal
          : AbortSignal.any([input.signal, controller.signal]);
      await this.awaitPreviousTurnExit(execution, signal);
      return await this.executeWithSignal({ ...input, signal });
    } finally {
      if (this.executionAborts.get(input.worker.id) === controller)
        this.executionAborts.delete(input.worker.id);
    }
  }

  private async executeWithSignal(input: TeamWorkerExecutionInput): Promise<WorkerRuntimeResult> {
    const choices = uniqueRuntimeChoices(this.deps.selectRuntimes(input.worker)).filter(
      ({ kind }) => this.deps.availability.isAvailable(kind),
    );
    if (choices.length === 0) {
      if (this.deps.allowSimulation === true) return this.simulator.execute(input);
      throw new Error('Real Team Worker runtime is unavailable');
    }

    const taskId = input.worker.taskId;
    const workspacePath =
      input.workspaceSet?.roots.find(({ rootId }) => rootId === input.workspaceSet?.primaryRootId)
        ?.path ??
      (input.workspacePath === undefined ? this.deps.workspaceFor(taskId) : input.workspacePath);
    const runtimeWorkspace = input.workspaceSet ?? workspacePath;
    const requestedWriteScope =
      input.accessMode === 'workspace-write' && input.worker.writeCapable === true
        ? (this.deps.writeScopeFor?.(input.worker, workspacePath) ?? 'read-only')
        : 'read-only';
    const writeScope = requestedWriteScope === 'full' ? 'workspace-write' : requestedWriteScope;
    const context = reserveTeamWorkerContext(
      applyWorkerContextInheritance(
        input.worker,
        this.deps.contextFor?.(input.worker, input.executionId) ?? emptyPreparedContext(),
      ),
    );
    const startedAt = Date.now();
    if (input.signal?.aborted) throw new Error('Worker execution was canceled before start');
    input.onEvent?.({ type: 'accepted', at: new Date().toISOString() });

    let lastAvailabilityError: Error | null = null;
    for (const [index, choice] of choices.entries()) {
      const capability = await this.client(choice.kind).probe();
      if (!capability.available || capability.readiness !== 'ready') {
        this.deps.availability.markUnavailable(choice.kind);
        lastAvailabilityError = new Error(`${choice.kind} Team Worker runtime is unavailable`);
        continue;
      }
      if (index > 0)
        input.onEvent?.({
          type: 'activity',
          phase: 'executing',
          label: `${runtimeLabel(choice.kind)}へfallbackして続行`,
          at: new Date().toISOString(),
        });
      try {
        const {
          finalText,
          writes,
          reportFrom,
          prompt: usedPrompt,
        } = await this.executeChoice(
          input,
          choice,
          taskId,
          context,
          workspacePath,
          runtimeWorkspace,
          writeScope,
        );
        const report = readWorkerCriteriaReport(finalText, input.doneCriteria, { reportFrom });
        const summary = report.summary;
        const writeFailure = workerWriteFailure({
          accessMode: input.accessMode,
          writeCapable: input.worker.writeCapable === true,
          workspacePath,
          writeScope,
          writes,
        });
        return {
          claims: {
            deliveryId: input.envelope.deliveryId,
            sourceAgentId: input.envelope.sourceAgentId,
            targetAgentId: input.envelope.targetAgentId,
          },
          completion: workerWriteCheckedCompletion({
            runtimeVerification: { name: `worker-runtime:${choice.kind}`, outcome: 'pass' },
            report,
            writes,
            writeFailure,
          }),
          usage: {
            costCents: 0,
            tokens: Math.max(1, Math.ceil((usedPrompt.length + summary.length) / 4)),
            timeMs: Date.now() - startedAt,
            toolCalls: 0,
          },
          resolution: {
            resolvedProvider: modelSelectionForRuntime(choice.kind, choice.model).requestedProvider,
            resolvedModel: choice.model,
          },
        };
      } catch (error) {
        if (!isRuntimeAvailabilityError(error)) throw error;
        this.deps.availability.markUnavailable(choice.kind, error.publicError.retryAt);
        if (!error.safeToRetry) {
          input.onEvent?.({ type: 'failed', error: error.message });
          throw error;
        }
        lastAvailabilityError = error;
      }
    }
    const failure = lastAvailabilityError ?? new Error('Real Team Worker runtime is unavailable');
    input.onEvent?.({ type: 'failed', error: failure.message });
    throw failure;
  }

  private async executeChoice(
    input: TeamWorkerExecutionInput,
    choice: RealRuntimeChoice,
    taskId: string,
    context: PreparedContext,
    workspacePath: string | null,
    runtimeWorkspace: RuntimeWorkspaceSet | string | null,
    writeScope: RuntimeWriteScope,
  ): Promise<{
    finalText: string;
    writes: WorkerWriteObservation;
    reportFrom: number;
    prompt: string;
  }> {
    const turnId = randomUUID();
    const writes: WorkerWriteObservation = { committed: 0, denied: 0 };
    const output: WorkerOutputObservation = { length: 0, lastToolAt: 0 };
    const normalizedWorkspace =
      typeof runtimeWorkspace === 'string' || runtimeWorkspace === null
        ? runtimeWorkspaceSetFromLegacyPath(runtimeWorkspace)
        : runtimeWorkspace;
    const toolCatalog = await this.deps.catalogFor(
      choice.kind,
      taskId,
      turnId,
      normalizedWorkspace,
      input.worker,
      writeScope,
      input.executionId,
      input.onApprovalWait,
    );
    // `catalogFor` has now registered this Turn with Main, so every exit below — including a
    // guidance or serialization throw before the CLI ever starts — must run the release. A Graph
    // Mission session Turn is closed by that release, so skipping it strands the whole Mission.
    let teamMcp: RuntimeTeamMcpOption | undefined;
    let runtimeStarted = false;
    let turnFailure: { error: unknown } | null = null;
    const abort = (): void => {
      void this.stop(input.worker.id).catch(() => undefined);
    };
    try {
      const promptToolCatalog: ToolCatalogSnapshot = isToolCatalogSnapshot(toolCatalog)
        ? toolCatalog
        : {
            revision: 0,
            providerId: choice.kind,
            workspaceId: null,
            entries: [],
            digest: 'unavailable',
          };
      // The prompt states the scope the Worker actually runs with, and — now that this choice's own
      // tool catalog is known — the operations that scope's managed tools cannot reach, so it never
      // promises edits its tool catalog cannot make.
      const writable = writeScope !== 'read-only';
      const writeLimitNotice = writable
        ? workerWriteLimitNotice(
            workspaceWriteLimitsFromTools(
              promptToolCatalog.entries.map((entry) => entry.providerName),
            ),
          )
        : '';
      const prompt = buildWorkerPrompt(
        input,
        writable,
        writeLimitNotice,
        this.deps.writeApprovalRequiredFor?.(taskId) === true,
      );
      teamMcp = this.deps.teamMcpFor?.(input.worker, turnId, input.executionId, promptToolCatalog);
      if (input.worker.canDelegate === true && teamMcp === undefined)
        throw new Error('Manager Team MCP is unavailable');
      const contextFragments = injectPromptGuidance(
        context.fragments
          .filter(({ source }) => choice.kind !== 'codex' || source !== 'skill')
          .map((fragment) => ({
            id: fragment.id,
            source: fragment.source,
            trust: fragment.trust,
            authority:
              fragment.source === 'system'
                ? ('system' as const)
                : fragment.source === 'goal' ||
                    (fragment.source === 'history' && fragment.trust === 'user')
                  ? ('user' as const)
                  : ('none' as const),
            content: fragment.content,
          })),
        compilePromptGuidance({
          workspace: normalizedWorkspace,
          toolCatalog: promptToolCatalog,
          writeScope,
          agent: {
            role: 'subagent',
            mode: writeScope === 'read-only' ? 'read-only' : 'write-capable',
          },
          teamMcpEnabled: teamMcp !== undefined,
        }),
      );
      const serializedPayload = serializeCliExecutionPayload({
        kind: choice.kind,
        request: prompt,
        contextFragments,
        projectItems: context.projectItems.map((item) => ({
          id: item.id,
          kind: item.kind,
          authority: item.authority,
          localOnly: item.localOnly,
          sealedDigest: item.sealedDigest,
          content: item.content,
        })),
        ...(teamMcp === undefined ? {} : { teamGuidance: teamMcp.guidance }),
      });
      if (
        !this.deps.authorizeEgress(
          choice.kind,
          taskId,
          turnId,
          serializedPayload.text,
          context,
          // The prompt and the guidance both name the roots Main prepared for this Worker. Declare
          // them so the egress secret scan reads them as workspace structure, not as opaque values.
          // The primary root already carries `workspacePath` in canonical form; declaring the raw
          // spelling too would only add a second, non-canonical entry on Windows.
          canonicalWorkspaceRoots(normalizedWorkspace.roots.map(({ path }) => path)),
        )
      )
        throw new Error(`${choice.kind} Team Worker egress was denied`);
      input.signal?.addEventListener('abort', abort, { once: true });
      input.signal?.throwIfAborted();
      const finalText = await new Promise<string>((resolve, reject) => {
        this.pending.set(turnId, {
          resolve,
          reject,
          buffer: [],
          ...(input.onEvent === undefined ? {} : { onEvent: input.onEvent }),
          deltaBuffer: [],
          deltaTimer: null,
          reasoningActive: false,
          runtimeStarted: false,
          sideEffectsObserved: false,
          writeScope,
          writes,
          output,
        });
        this.activeByAgent.set(input.worker.id, { kind: choice.kind, taskId, turnId });
        runtimeStarted = this.client(choice.kind).start(
          taskId,
          turnId,
          prompt,
          runtimeWorkspace,
          choice.model,
          toolCatalog as never,
          context,
          teamMcp,
          undefined,
          writeScope,
          [],
          serializedPayload,
          undefined,
        );
        const run = this.pending.get(turnId);
        if (run !== undefined) run.runtimeStarted = runtimeStarted;
      });
      return { finalText, writes, reportFrom: output.lastToolAt, prompt };
    } catch (error) {
      turnFailure = { error };
      throw error;
    } finally {
      try {
        if (runtimeStarted) {
          const owner: TurnOwner = { agentId: input.worker.id, executionId: input.executionId };
          // Starting inside a promise turns a synchronous throw from the exit wait into a rejection,
          // which is just as unconfirmed.
          const exited = Promise.resolve()
            .then(() => this.client(choice.kind).waitForTurnExit(turnId))
            .catch((error: unknown) => {
              this.watchUnconfirmedExit(owner, choice.kind, turnId);
              // This error replaces the Turn's own failure, so it carries that failure along.
              throw new WorkerRuntimeExitUnconfirmedError(
                error instanceof Error ? error.message : String(error),
                {
                  cause: error,
                  ...(turnFailure === null ? {} : { originalError: turnFailure.error }),
                },
              );
            });
          this.trackExitWait(owner, turnId, exited);
          await exited;
        }
      } finally {
        input.signal?.removeEventListener('abort', abort);
        this.pending.delete(turnId);
        if (this.activeByAgent.get(input.worker.id)?.turnId === turnId)
          this.activeByAgent.delete(input.worker.id);
        if (teamMcp !== undefined) this.deps.releaseTeamMcp?.(turnId);
        this.deps.releaseManagedTurn?.(turnId);
      }
    }
  }

  /**
   * Holds a new execution while its Worker has a Turn whose exit is still awaited or unconfirmed
   * (for at most PREVIOUS_TURN_EXIT_WAIT_MS), then refuses it before anything starts if one is
   * still there (issue #548). A CLI that may still be running and writing never gets a second one
   * beside it, and an exit confirmed during the hold lets the execution start after all.
   */
  private async awaitPreviousTurnExit(execution: TurnOwner, signal: AbortSignal): Promise<void> {
    // `execute` has already handled a signal aborted before this call, and nothing can abort it in
    // between, so the first place a stop is seen is the end of the hold.
    if (this.blockingTurns(execution.agentId).length > 0) {
      let stopWaiting = (): void => undefined;
      const gaveUp = new Promise<true>((resolve) => {
        const timer = setTimeout(() => resolve(true), PREVIOUS_TURN_EXIT_WAIT_MS);
        const onAbort = (): void => resolve(true);
        signal.addEventListener('abort', onAbort, { once: true });
        stopWaiting = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
        };
      });
      try {
        // An exit wait that fails leaves an unconfirmed record behind, whose background re-check can
        // still confirm the exit; keep waiting on such new records within the same budget.
        const awaited = new Set<TurnOwner>();
        for (;;) {
          const fresh = this.blockingTurns(execution.agentId).filter(
            ({ owner }) => !awaited.has(owner),
          );
          if (fresh.length === 0) break;
          for (const { owner } of fresh) awaited.add(owner);
          const expired = await Promise.race([
            Promise.all(fresh.map(({ released }) => released)).then(() => false),
            gaveUp,
          ]);
          if (expired) break;
        }
      } finally {
        stopWaiting();
      }
    }
    // A stop during the hold does not end a Turn that still blocks the Worker, so that refusal comes
    // first; only without one is this merely a stopped execution.
    const refusal = this.previousTurnRefusal(execution, signal);
    if (refusal !== null) throw refusal;
    signal.throwIfAborted();
  }

  /**
   * The refusal owed to an execution whose Worker still has a blocking Turn, or null. A stop that
   * already ended the execution becomes the refusal's cause.
   */
  private previousTurnRefusal(
    execution: TurnOwner,
    signal: AbortSignal,
  ): WorkerRuntimeExitUnconfirmedError | null {
    const blocking = this.blockingTurns(execution.agentId).map(({ owner }) => owner);
    if (blocking.length === 0) return null;
    return new WorkerRuntimeExitUnconfirmedError(PREVIOUS_TURN_EXIT_UNCONFIRMED_MESSAGE, {
      ...(signal.aborted ? { cause: signal.reason as unknown } : {}),
      // Refusing leaves this execution's own worktree unused only when every blocking Turn ran for
      // another execution. A steered execution reuses its worktree, which an earlier Turn of it may
      // still be using, and an unknown execution may be this one.
      startRefused: blocking.every(
        (turn) =>
          turn.executionId !== undefined &&
          execution.executionId !== undefined &&
          turn.executionId !== execution.executionId,
      ),
    });
  }

  /**
   * Whether a Turn this Worker ran for `executionId`, or for an execution it cannot name, may still
   * be running (issue #544): the same Turns that hold back its next execution.
   */
  hasUnsettledTurn(agentId: string, executionId: string): boolean {
    return this.blockingTurns(agentId).some(
      ({ owner }) => owner.executionId === undefined || owner.executionId === executionId,
    );
  }

  /** The Worker's Turns whose exit is still awaited or unconfirmed, each with when it goes away. */
  private blockingTurns(agentId: string): { owner: TurnOwner; released: Promise<void> }[] {
    return [
      ...[...this.exitWaits.values()].map((wait) => ({ owner: wait, released: wait.settled })),
      ...[...this.unconfirmedExits.values()].map((record) => ({
        owner: record,
        released: record.cleared,
      })),
    ].filter(({ owner }) => owner.agentId === agentId);
  }

  /** Records a Turn's exit wait until it ends; see `exitWaits`. */
  private trackExitWait(owner: TurnOwner, turnId: string, exited: Promise<void>): void {
    const wait = { ...owner, settled: Promise.resolve() };
    wait.settled = exited
      .then(
        () => undefined,
        () => undefined,
      )
      .then(() => {
        if (this.exitWaits.get(turnId) === wait) this.exitWaits.delete(turnId);
      });
    this.exitWaits.set(turnId, wait);
  }

  /**
   * Keeps asking the Runtime Host whether an unconfirmed Turn has exited, and lifts its Worker's
   * block once it has. A Host that went away rejects the wait without the CLI tree being known to
   * have ended (the CLI is not in a job and on POSIX runs in its own process group), so a rejection
   * never counts as an exit; only the Host's exit report does.
   */
  private watchUnconfirmedExit(
    owner: TurnOwner,
    kind: 'claude' | 'codex' | 'grok',
    turnId: string,
  ): void {
    let clear = (): void => undefined;
    const cleared = new Promise<void>((resolve) => {
      clear = resolve;
    });
    const record = { ...owner, kind, cleared };
    this.unconfirmedExits.set(turnId, record);
    const watching = (): boolean => !this.disposed && this.unconfirmedExits.get(turnId) === record;
    const wait = (): void => {
      if (!watching()) return;
      void Promise.resolve()
        .then(() => this.client(kind).waitForTurnExit(turnId))
        .then(
          () => {
            if (!watching()) return;
            this.unconfirmedExits.delete(turnId);
            clear();
          },
          () => {
            if (!watching()) return;
            const timer = setTimeout(() => {
              this.unconfirmedExitRechecks.delete(timer);
              wait();
            }, UNCONFIRMED_EXIT_RECHECK_DELAY_MS);
            timer.unref();
            this.unconfirmedExitRechecks.add(timer);
          },
        );
    };
    wait();
  }

  recordManagedToolResult(turnId: string, result: unknown): void {
    const run = this.pending.get(turnId);
    if (run === undefined) return;
    run.output.lastToolAt = run.output.length;
    // Counted per committed write call, like denials, so a directory creation (which changes no
    // file) still shows that the Worker could write.
    if (isCommittedManagedWrite(result)) run.writes.committed += 1;
    const changes = managedResultChanges(result);
    if (changes.length === 0) return;
    run.sideEffectsObserved = true;
    run.onEvent?.({ type: 'fileChange', changes });
  }

  /** Main reports a managed Workspace write that policy denied, so the outcome can say so. */
  recordManagedToolDenied(turnId: string, toolName: string): void {
    const run = this.pending.get(turnId);
    if (run === undefined) return;
    run.output.lastToolAt = run.output.length;
    if (!WORKSPACE_WRITE_TOOL_NAMES.has(toolName)) return;
    run.writes.denied += 1;
  }

  async stop(agentId: string): Promise<void> {
    const active = this.activeByAgent.get(agentId);
    if (active === undefined) {
      this.executionAborts.get(agentId)?.abort(new Error('Worker execution stopped'));
      return;
    }
    try {
      await this.client(active.kind).cancel(active.taskId, active.turnId);
    } finally {
      const run = this.pending.get(active.turnId);
      if (run !== undefined) {
        flushDelta(run);
        run.onEvent?.({ type: 'canceled', reason: 'Worker execution stopped' });
        this.pending.delete(active.turnId);
        run.reject(new Error('Worker execution stopped'));
      }
      if (this.activeByAgent.get(agentId)?.turnId === active.turnId)
        this.activeByAgent.delete(agentId);
    }
  }

  dispose(): void {
    // Stop watching, but keep the blocks: a disposed Host can no longer confirm those exits.
    this.disposed = true;
    for (const timer of this.unconfirmedExitRechecks) clearTimeout(timer);
    this.unconfirmedExitRechecks.clear();
    for (const controller of this.executionAborts.values()) controller.abort();
    this.executionAborts.clear();
    for (const client of this.clients.values()) client.dispose();
    this.clients.clear();
  }
}

/**
 * Why a write execution could not change the Workspace, or null when it could (issue #527).
 * Read-only investigations never fail here, and neither does a write execution that made no write
 * call in this Turn: an earlier Attempt may already have written to the isolation it reuses, so
 * Main judges that from the isolation itself (issue #550).
 */
export function workerWriteFailure(input: {
  accessMode: TeamWorkerExecutionInput['accessMode'];
  writeCapable: boolean;
  workspacePath: string | null;
  writeScope: RuntimeWriteScope;
  writes: WorkerWriteObservation;
  /**
   * Why a write-capable Worker with a Workspace still ran read-only, when the runtime knows a
   * cause other than the CLI's: its safety setting narrowing the scope.
   */
  readOnlyCause?: string;
}): WorkerWriteFailure | null {
  if (input.accessMode !== 'workspace-write') return null;
  if (input.writeScope === 'read-only')
    return {
      name: 'worker-write-scope',
      detail: !input.writeCapable
        ? 'このWorkerは書き込み可能として採用されていないため、読み取り専用で実行されました。ファイルは変更されていません。'
        : input.workspacePath === null
          ? '書き込み先のWorkspaceがないため、読み取り専用で実行されました。ファイルは変更されていません。'
          : (input.readOnlyCause ??
            'このWorkerには今回の実行で書き込みが許可されなかったため、読み取り専用で実行されました。ファイルは変更されていません。'),
    };
  if (input.writes.denied > 0 && input.writes.committed === 0)
    return {
      name: 'worker-write-denied',
      detail: `書き込みツールの呼び出し${input.writes.denied}件が拒否され、反映された書き込みは1件もありませんでした。`,
    };
  return null;
}

export type WorkerWriteFailure = {
  name: 'worker-write-scope' | 'worker-write-denied';
  detail: string;
};

/**
 * A Worker's completion, judged by its writes. A write execution that could not change any file
 * did not do what the Leader asked, whatever the Worker's own summary says; one whose writes were
 * only partly denied still succeeds, with the denials as a risk. The CLI and the Managed Local
 * Worker both build their completion here, so they judge a write execution alike (issue #552).
 */
export function workerWriteCheckedCompletion(input: {
  runtimeVerification: { name: string; outcome: 'pass' };
  report: ReturnType<typeof readWorkerCriteriaReport>;
  writes: WorkerWriteObservation;
  writeFailure: WorkerWriteFailure | null;
}): WorkerCompletion {
  const { runtimeVerification, report, writes, writeFailure } = input;
  const criteria = report.criteria === undefined ? {} : { criteria: report.criteria };
  return writeFailure === null
    ? {
        status: 'succeeded',
        summary: report.summary,
        artifacts: [],
        verification: [runtimeVerification, ...report.verification],
        risks:
          writes.denied > 0
            ? [
                `書き込みツールの呼び出し${writes.denied}件が拒否されました（反映された書き込みは${writes.committed}件）。`,
              ]
            : [],
        ...criteria,
      }
    : {
        status: 'failed',
        summary: `${writeFailure.detail}\n\nWorkerの報告:\n${report.summary}`.slice(0, 4_000),
        artifacts: [],
        verification: [
          runtimeVerification,
          { name: writeFailure.name, outcome: 'fail', detail: writeFailure.detail },
          ...report.verification,
        ],
        risks: [writeFailure.detail.slice(0, 500)],
        ...criteria,
      };
}

/** A managed Workspace write that its Edit Saga committed; reads and plan updates carry no Saga. */
export function isCommittedManagedWrite(result: unknown): boolean {
  if (typeof result !== 'object' || result === null) return false;
  const record = result as Record<string, unknown>;
  return record['state'] === 'committed' && typeof record['sagaId'] === 'string';
}

function managedResultChanges(
  result: unknown,
): { path: string; kind: 'add' | 'update' | 'delete' }[] {
  if (typeof result !== 'object' || result === null) return [];
  const record = result as Record<string, unknown>;
  const raw = Array.isArray(record['changes'])
    ? record['changes']
    : typeof record['path'] === 'string'
      ? [record]
      : [];
  return raw.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const change = item as Record<string, unknown>;
    const path = change['path'];
    const kind = change['kind'];
    return typeof path === 'string' &&
      path.length > 0 &&
      (kind === 'add' || kind === 'update' || kind === 'delete')
      ? [{ path, kind }]
      : [];
  });
}

function uniqueRuntimeChoices(choices: readonly RealRuntimeChoice[]): RealRuntimeChoice[] {
  const seen = new Set<RealRuntimeChoice['kind']>();
  return choices.filter(({ kind }) => {
    if (seen.has(kind)) return false;
    seen.add(kind);
    return true;
  });
}

/**
 * Deduplicated absolute roots for the egress secret scan. Only Main-issued paths (the Task
 * Workspace and the execution isolation worktree) belong here — never Provider-supplied text.
 *
 * The bytes are passed through as written: the classifier does its own separator normalization and
 * refuses any root with a `.`/`..` segment, and resolving here against the host's own conventions
 * would rewrite a path recorded on the other platform into a root that names nothing.
 */
export function canonicalWorkspaceRoots(
  paths: readonly (string | null | undefined)[],
): readonly string[] {
  return [
    ...new Set(
      paths.filter(
        (path): path is string =>
          typeof path === 'string' &&
          path !== '' &&
          (posix.isAbsolute(path) || win32.isAbsolute(path)),
      ),
    ),
  ];
}

function isRuntimeAvailabilityError(error: unknown): error is TeamRuntimeExecutionError {
  return (
    error instanceof TeamRuntimeExecutionError &&
    ['RUNTIME_RATE_LIMIT', 'RUNTIME_UNAVAILABLE', 'RUNTIME_CLI_MISSING'].includes(
      error.publicError.code,
    )
  );
}

function runtimeLabel(kind: RealRuntimeChoice['kind']): string {
  return kind === 'grok' ? 'Grok CLI' : kind === 'codex' ? 'Codex' : 'Claude Code';
}

function emptyPreparedContext(): PreparedContext {
  return {
    fragments: [],
    projectItems: [],
    projectSnapshotDigest: null,
    usageEvents: [],
    compacted: false,
  };
}

export function reserveTeamWorkerContext(context: PreparedContext): PreparedContext {
  const projectBytes = context.projectItems.reduce(
    (total, item) => total + Buffer.byteLength(item.content, 'utf8'),
    0,
  );
  if (
    context.projectItems.length > 256 ||
    projectBytes > 128 * 1024 ||
    context.projectItems.some((item) => Buffer.byteLength(item.content, 'utf8') > 64 * 1024)
  )
    throw new Error('Inherited Project context cannot fit the Worker protocol budget');
  let remainingBytes = 128 * 1024 - projectBytes;
  let remainingCount = 256 - context.projectItems.length;
  const fragments = [] as PreparedContext['fragments'];
  // Preserve the most recent conversation while shrinking inherited fragments first. Project
  // items are never subsetted: either every sealed item is delivered or execution fails above.
  for (const fragment of [...context.fragments].reverse()) {
    const bytes = Buffer.byteLength(fragment.content, 'utf8');
    if (remainingCount === 0 || bytes > 64 * 1024 || bytes > remainingBytes) continue;
    fragments.unshift(fragment);
    remainingBytes -= bytes;
    remainingCount -= 1;
  }
  return { ...context, fragments };
}

export function applyWorkerContextInheritance(
  worker: AgentRecord,
  sealed: PreparedContext,
): PreparedContext {
  if (
    worker.contextInheritancePolicy === 'none' ||
    worker.contextInheritancePolicy === 'selected_items'
  )
    return { ...sealed, fragments: [], compacted: false };
  if (worker.contextInheritancePolicy === 'full_fork') return sealed;
  const relevant = sealed.fragments.filter(
    ({ source, trust }) =>
      (source === 'history' || source === 'compaction') &&
      (trust === 'user' || trust === 'assistant'),
  );
  const content = relevant
    .slice(-6)
    .map(
      ({ trust, content: fragment }) => `${trust === 'user' ? 'User' : 'Assistant'}: ${fragment}`,
    )
    .join('\n')
    .slice(-8_000);
  return {
    ...sealed,
    fragments:
      content === ''
        ? []
        : [
            {
              id: `team-context-summary:${worker.id}`,
              taskId: worker.taskId,
              source: 'compaction',
              trust: 'assistant',
              tokenEstimate: Math.max(1, Math.ceil(content.length / 4)),
              content: `親Taskの直近要約コンテキスト:\n${content}`,
              createdAt: relevant.at(-1)?.createdAt ?? worker.createdAt,
              messageId: null,
            },
          ],
    compacted: content !== '',
  };
}

/**
 * The CLI Worker's instruction text. `writeLimitNotice` — computed from this choice's own tool
 * catalog once it is known — is placed right after the "Workspace書き込み" line, and only when the
 * Worker is actually write-capable; a Worker with no write access at all keeps its existing
 * WORKER_CANNOT_WRITE_NOTICE instead. When the Task asks before each write, a write-capable Worker
 * is also told so, right after that notice (issue #525).
 */
function buildWorkerPrompt(
  input: TeamWorkerExecutionInput,
  writable: boolean,
  writeLimitNotice: string,
  writeApprovalRequired: boolean,
): string {
  return [
    `あなたはチームの「${input.worker.role}」担当Workerです。`,
    `あなたのAgent ID: ${input.worker.id}`,
    `親Agent ID: ${input.worker.parentAgentId ?? 'Leader'}`,
    input.worker.objective === null ? '' : `目的: ${input.worker.objective}`,
    `Context継承: ${input.worker.contextInheritancePolicy}`,
    `Workspace書き込み: ${writable ? '隔離範囲内で可' : '禁止（読み取り専用）'}`,
    writable ? writeLimitNotice : '',
    writable && writeApprovalRequired ? WORKER_WRITE_APPROVAL_NOTICE : '',
    input.accessMode === 'workspace-write' && !writable ? WORKER_CANNOT_WRITE_NOTICE : '',
    input.workspacePath === undefined
      ? ''
      : `隔離worktree: ${input.workspacePath ?? '利用不可'}${writable ? '（このディレクトリ内だけを変更してください）' : '（読み取り専用）'}`,
    input.workspaceSet === undefined
      ? ''
      : `隔離root: ${input.workspaceSet.roots.map(({ label, path }) => `${label}=${path}`).join(', ')}`,
    '以下のLeaderからの依頼に対応し、結果を日本語で簡潔に報告してください。',
    formatPriorTeamConversation(input.priorConversation),
    '',
    `依頼: ${input.content}`,
    workerCriteriaPrompt(input.doneCriteria ?? []),
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export function formatPriorTeamConversation(
  conversation: readonly TeamRuntimeConversationItem[] | undefined,
): string {
  if (conversation === undefined || conversation.length === 0) return '';
  return [
    '以下は、このAgent自身が以前に受送信したTeam会話です。',
    '現在の依頼を最優先し、過去の成果は参照資料としてそのまま利用してください。',
    'この内容を取得し直すためにTeamツールを呼ぶ必要はありません。',
    ...conversation.map(
      (item) =>
        `[${item.direction === 'received' ? '受信' : '送信'} / ${item.role}]\n${item.content}`,
    ),
  ].join('\n\n');
}

export function buildInheritedWorkerContext(
  worker: AgentRecord,
  messages: readonly ChatMessage[],
): PreparedContext {
  const relevant = messages.filter(({ author }) => author === 'user' || author === 'assistant');
  if (
    worker.contextInheritancePolicy === 'none' ||
    worker.contextInheritancePolicy === 'selected_items'
  )
    return {
      fragments: [],
      projectItems: [],
      projectSnapshotDigest: null,
      usageEvents: [],
      compacted: false,
    };
  if (worker.contextInheritancePolicy === 'summary') {
    const content = relevant
      .slice(-6)
      .map(
        ({ author, content: message }) => `${author === 'user' ? 'User' : 'Assistant'}: ${message}`,
      )
      .join('\n')
      .slice(-8_000);
    if (content.length === 0)
      return {
        fragments: [],
        projectItems: [],
        projectSnapshotDigest: null,
        usageEvents: [],
        compacted: false,
      };
    return {
      projectItems: [],
      projectSnapshotDigest: null,
      fragments: [
        {
          id: `team-context-summary:${worker.id}`,
          taskId: worker.taskId,
          source: 'compaction',
          trust: 'assistant',
          tokenEstimate: Math.max(1, Math.ceil(content.length / 4)),
          content: `親Taskの直近要約コンテキスト:\n${content}`,
          createdAt: relevant.at(-1)?.createdAt ?? worker.createdAt,
          messageId: null,
        },
      ],
      usageEvents: [],
      compacted: true,
    };
  }
  return {
    projectItems: [],
    projectSnapshotDigest: null,
    fragments: relevant.slice(-128).map((message) => ({
      id: `team-context:${message.id}`,
      taskId: worker.taskId,
      source: 'history' as const,
      trust: message.author,
      tokenEstimate: Math.max(1, Math.ceil(message.content.length / 4)),
      content: message.content,
      createdAt: message.createdAt,
      messageId: message.id,
    })),
    usageEvents: [],
    compacted: false,
  };
}

function isToolCatalogSnapshot(value: unknown): value is ToolCatalogSnapshot {
  return verifyToolCatalogSnapshot(value as ToolCatalogSnapshot);
}

function flushDelta(run: PendingRun): void {
  if (run.deltaTimer !== null) clearTimeout(run.deltaTimer);
  run.deltaTimer = null;
  if (run.deltaBuffer.length === 0) return;
  run.onEvent?.({ type: 'outputDelta', text: run.deltaBuffer.join('') });
  run.deltaBuffer.length = 0;
}

function stageLabel(stage: string): string {
  const labels: Record<string, string> = {
    understanding: '依頼を理解中',
    planning: '計画中',
    executing: '実行中',
    waiting_approval: '承認待ち',
    synthesizing: '報告を整理中',
  };
  return labels[stage] ?? stage;
}

/** Kind choice used by ipc: real workers follow the selected runtime; the mock runtime borrows
 *  Claude when it is installed so the default setup gets real Worker output out of the box. */
export function chooseWorkerRuntime(
  selectedKind: RuntimeKind,
  selectedModel: string,
  claudeProbablyAvailable: boolean,
): RealRuntimeChoice | null {
  if (selectedKind === 'claude' || selectedKind === 'codex' || selectedKind === 'grok')
    return { kind: selectedKind, model: selectedModel };
  return claudeProbablyAvailable ? { kind: 'claude', model: 'auto' } : null;
}
