import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, sep } from 'node:path';
import type { ExecutionSpec } from '@sprint-coder/domain';
import { canonicalizeExistingPath, pathComparisonKey } from '../path-comparison';
import {
  CommandRunner,
  CommandRunnerError,
  executionSpecPathGuard,
  type CommandOutputChunk,
  type CommandResult,
  type RunOptions,
} from './command-runner';

export type ManagedCommandSnapshot = Readonly<{
  sessionId: string;
  state: 'starting' | 'running' | 'exited' | 'failed' | 'canceled';
  executionId: string | null;
  chunks: readonly CommandOutputChunk[];
  nextCursor: number;
  result: CommandResult | null;
  error: string | null;
}>;

export type ManagedCommandRun = (
  spec: ExecutionSpec,
  options: RunOptions,
) => Promise<CommandResult>;

export type ManagedCommandIdentity = Readonly<{
  sessionId: string;
  executable: string;
  argv: readonly string[];
  cwd: string;
}>;

type Session = {
  id: string;
  state: ManagedCommandSnapshot['state'];
  executionId: string | null;
  spec: ExecutionSpec;
  controller: AbortController;
  chunks: CommandOutputChunk[];
  result: CommandResult | null;
  error: string | null;
  terminationUnconfirmed: boolean;
  started: Promise<void>;
  resolveStarted(): void;
  completion: Promise<void>;
  taskId: string;
  turnId: string;
  /** A run of the shipped desktop-control executable (`terminateTaskDesktopControl`). */
  desktopControl: boolean;
};

export class ManagedCommandSessions {
  private readonly sessions = new Map<string, Session>();
  private sessionSettledListener: ((taskId: string) => void) | undefined;

  constructor(
    private readonly runner = new CommandRunner({ sandboxed: true }),
    private readonly maxSessions = 100,
    private readonly maxChunks = 2_000,
  ) {}

  async start(
    spec: ExecutionSpec,
    owner: Readonly<{ taskId: string; turnId: string }>,
    hooks: Pick<
      RunOptions,
      | 'signal'
      | 'beforeSpawn'
      | 'onStarted'
      | 'onChunk'
      | 'onBatch'
      | 'desktopControlWorkspaceRoots'
      | 'desktopControlExpectedWindowOwner'
      | 'desktopControlSession'
    > & {
      /**
       * Given only for a desktop-control run in the Task's session (`desktop-control-queue.ts`):
       * how the runner's run of this session's process is to be made. Absent, the runner runs it.
       */
      wrapRun?: (run: ManagedCommandRun) => ManagedCommandRun;
      /**
       * Set for a run of the shipped desktop-control executable, which the Task's archive stops
       * (`terminateTaskDesktopControl`), in the foreground or gone on in the background.
       */
      desktopControl?: boolean;
    } = {},
    sessionId = randomUUID(),
  ): Promise<ManagedCommandSnapshot> {
    if (this.sessions.size >= this.maxSessions) this.evictTerminal();
    if (this.sessions.size >= this.maxSessions)
      throw new Error('Managed command session limit reached');
    let resolveStarted = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const session: Session = {
      id: sessionId,
      state: 'starting',
      executionId: null,
      spec,
      controller: new AbortController(),
      chunks: [],
      result: null,
      error: null,
      terminationUnconfirmed: false,
      started,
      resolveStarted,
      completion: Promise.resolve(),
      taskId: owner.taskId,
      turnId: owner.turnId,
      desktopControl: hooks.desktopControl === true,
    };
    this.sessions.set(session.id, session);
    const abortFromCaller = (): void => session.controller.abort(hooks.signal?.reason);
    hooks.signal?.addEventListener('abort', abortFromCaller, { once: true });
    if (hooks.signal?.aborted) abortFromCaller();
    const runner: { run: ManagedCommandRun } =
      hooks.wrapRun === undefined
        ? this.runner
        : { run: hooks.wrapRun((runSpec, options) => this.runner.run(runSpec, options)) };
    session.completion = runner
      .run(spec, {
        signal: session.controller.signal,
        ...(hooks.beforeSpawn === undefined ? {} : { beforeSpawn: hooks.beforeSpawn }),
        ...(hooks.desktopControlWorkspaceRoots === undefined
          ? {}
          : { desktopControlWorkspaceRoots: hooks.desktopControlWorkspaceRoots }),
        ...(hooks.desktopControlExpectedWindowOwner === undefined
          ? {}
          : { desktopControlExpectedWindowOwner: hooks.desktopControlExpectedWindowOwner }),
        ...(hooks.desktopControlSession === undefined
          ? {}
          : { desktopControlSession: hooks.desktopControlSession }),
        onStarted: (startedProcess) => {
          const { executionId } = startedProcess;
          session.executionId = executionId;
          session.state = 'running';
          session.resolveStarted();
          hooks.onStarted?.(startedProcess);
        },
        onBatch: async (chunks) => {
          for (const chunk of chunks) {
            session.chunks.push(chunk);
            await hooks.onChunk?.(chunk);
          }
          if (session.chunks.length > this.maxChunks)
            session.chunks.splice(0, session.chunks.length - this.maxChunks);
          await hooks.onBatch?.(chunks);
        },
      })
      .then((result) => {
        session.result = result;
        session.state = result.canceled ? 'canceled' : 'exited';
      })
      .catch((error: unknown) => {
        session.state = 'failed';
        session.terminationUnconfirmed =
          error instanceof CommandRunnerError && error.code === 'PROCESS_TREE_TERMINATION_FAILED';
        session.error = error instanceof Error ? error.message : 'Command failed';
      })
      .finally(() => {
        hooks.signal?.removeEventListener('abort', abortFromCaller);
        session.resolveStarted();
        // A run gone on in the background after its Turn ends with no Turn to tell; what moves in
        // the Task is told afresh here (issue #1225).
        try {
          this.sessionSettledListener?.(session.taskId);
        } catch {
          // Only a snapshot for the window; the archive checks afresh.
        }
      });
    await session.started;
    if (session.state === 'failed') throw new Error(session.error ?? 'Managed command failed');
    return this.snapshot(session, 0);
  }

  poll(
    sessionId: string,
    owner: Readonly<{ taskId: string; turnId: string }>,
    afterSeq = 0,
  ): ManagedCommandSnapshot {
    const session = this.require(sessionId, owner);
    return this.snapshot(session, afterSeq);
  }

  /**
   * The command this session is running, as the approval subject for `write_stdin` (Issue #473).
   * Ownership is checked here too, so a session this Turn does not own is refused before any
   * approval card is raised.
   */
  commandIdentity(
    sessionId: string,
    owner: Readonly<{ taskId: string; turnId: string }>,
  ): ManagedCommandIdentity {
    const session = this.require(sessionId, owner);
    return Object.freeze({
      sessionId: session.id,
      executable: session.spec.absoluteExecutable,
      argv: Object.freeze([...session.spec.argv]),
      cwd: session.spec.cwdIdentity.canonicalPath,
    });
  }

  writeStdin(
    sessionId: string,
    owner: Readonly<{ taskId: string; turnId: string }>,
    chars: string,
    close = false,
  ): boolean {
    const session = this.require(sessionId, owner);
    return (
      session.executionId !== null && this.runner.writeStdin(session.executionId, chars, close)
    );
  }

  terminate(sessionId: string, owner: Readonly<{ taskId: string; turnId: string }>): boolean {
    const session = this.require(sessionId, owner);
    if (session.state !== 'starting' && session.state !== 'running') return false;
    session.controller.abort(new Error('Managed command terminated'));
    return true;
  }

  async wait(
    sessionId: string,
    owner: Readonly<{ taskId: string; turnId: string }>,
  ): Promise<ManagedCommandSnapshot> {
    const session = this.require(sessionId, owner);
    await session.completion;
    return this.snapshot(session, 0);
  }

  async waitFor(
    sessionId: string,
    owner: Readonly<{ taskId: string; turnId: string }>,
    timeoutMs: number,
  ): Promise<ManagedCommandSnapshot | null> {
    const session = this.require(sessionId, owner);
    if (session.state !== 'starting' && session.state !== 'running')
      return this.snapshot(session, 0);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      timer.unref?.();
      void session.completion.then(() => {
        clearTimeout(timer);
        resolve(this.snapshot(session, 0));
      });
    });
  }

  async dispose(): Promise<void> {
    for (const session of this.sessions.values()) session.controller.abort();
    await Promise.allSettled([...this.sessions.values()].map(({ completion }) => completion));
    await this.runner.dispose();
    this.sessions.clear();
  }

  /** Owner-scoped observation for Turns without a Workspace snapshot. Does not abort sessions. */
  hasActiveTurnSessions(owner: Readonly<{ taskId: string; turnId: string }>): boolean {
    return this.activeTurnSessions(owner).length > 0;
  }

  /**
   * How many of the Task's commands still run, those gone on in the background after their Turn
   * included (a run whose stop could not be confirmed counts, as it may still run). Does not abort.
   */
  activeTaskSessionCount(taskId: string): number {
    return [...this.sessions.values()].filter(
      (session) =>
        session.taskId === taskId &&
        (session.state === 'starting' ||
          session.state === 'running' ||
          session.terminationUnconfirmed),
    ).length;
  }

  /** Observe writers across Turn/Task ownership without taking control of their processes. */
  hasActiveWorkspaceSessions(
    roots: readonly Readonly<{ path: string; rootIdentityDigest: string | undefined }>[],
  ): boolean {
    const targets = roots.map((root) => ({
      ...root,
      path: pathComparisonKey(canonicalizeExistingPath(root.path)),
    }));
    return [...this.sessions.values()].some((session) => {
      if (
        session.state !== 'starting' &&
        session.state !== 'running' &&
        !session.terminationUnconfirmed
      )
        return false;
      // The prepared guard pins the Workspace root even when cwd is a nested directory, and
      // remains reachable through the session after finishTurn releases the owner's tools.
      const guard = executionSpecPathGuard(session.spec);
      const path = pathComparisonKey(guard.workspacePath);
      return targets.some(
        (root) =>
          root.rootIdentityDigest === guard.rootIdentityDigest ||
          containsPath(root.path, path) ||
          containsPath(path, root.path),
      );
    });
  }

  private activeTurnSessions(owner: Readonly<{ taskId: string; turnId: string }>): Session[] {
    return [...this.sessions.values()].filter(
      (session) =>
        session.taskId === owner.taskId &&
        session.turnId === owner.turnId &&
        (session.state === 'starting' ||
          session.state === 'running' ||
          session.terminationUnconfirmed),
    );
  }

  async terminateTurn(owner: Readonly<{ taskId: string; turnId: string }>): Promise<void> {
    const owned = this.activeTurnSessions(owner);
    for (const session of owned)
      if (session.state === 'starting' || session.state === 'running')
        session.controller.abort(new Error('Managed command Turn canceled'));
    await Promise.allSettled(owned.map(({ completion }) => completion));
    if (owned.some(({ terminationUnconfirmed }) => terminationUnconfirmed))
      throw new Error('Managed command Turn cancellation could not be confirmed');
  }

  async terminateTask(taskId: string): Promise<void> {
    await this.beginTaskTermination(taskId)();
  }

  beginTaskTermination(taskId: string): () => Promise<void> {
    return this.beginTermination(
      (session) => session.taskId === taskId,
      'Managed command permission epoch changed',
      'Managed command Task cancellation could not be confirmed',
    );
  }

  /**
   * Stops every run of the Task, those its earlier Turns left in the background included, as
   * `terminateTurn` stops a Turn's (the whole process tree), and resolves once their processes
   * have ended; rejects when an end could not be confirmed. Only the person asks for this (the
   * Task's 「実行中のコマンドを停止」, issue #1225): no agent tool reaches it.
   */
  async terminateTaskCommands(taskId: string): Promise<void> {
    await this.beginTermination(
      (session) => session.taskId === taskId,
      'Managed command stopped by the person',
      'Managed command Task stop could not be confirmed',
    )();
  }

  /** Told the Task of each run whose process ended (or whose end could not be confirmed). */
  onSessionSettled(listener: ((taskId: string) => void) | undefined): void {
    this.sessionSettledListener = listener;
  }

  /**
   * Stops the Task's runs of the desktop-control executable, in the foreground or gone on in the
   * background, as `terminateTurn` stops a Turn's, and resolves once their processes have ended
   * (when the Task is archived). The Task's other commands are left as they are.
   */
  async terminateTaskDesktopControl(taskId: string): Promise<void> {
    await this.beginTermination(
      (session) => session.taskId === taskId && session.desktopControl,
      'Managed command Task archived',
      'Managed command desktop-control cancellation could not be confirmed',
    )();
  }

  private beginTermination(
    selects: (session: Session) => boolean,
    reason: string,
    unconfirmed: string,
  ): () => Promise<void> {
    const owned = [...this.sessions.values()].filter(
      (session) =>
        selects(session) &&
        (session.state === 'starting' ||
          session.state === 'running' ||
          session.terminationUnconfirmed),
    );
    for (const session of owned)
      if (session.state === 'starting' || session.state === 'running')
        session.controller.abort(new Error(reason));
    return async () => {
      await Promise.allSettled(owned.map(({ completion }) => completion));
      if (owned.some(({ terminationUnconfirmed }) => terminationUnconfirmed))
        throw new Error(unconfirmed);
    };
  }

  private snapshot(session: Session, afterSeq: number): ManagedCommandSnapshot {
    const chunks = session.chunks.filter(({ seq }) => seq > afterSeq);
    return Object.freeze({
      sessionId: session.id,
      state: session.state,
      executionId: session.executionId,
      chunks: Object.freeze(chunks.map((chunk) => Object.freeze({ ...chunk }))),
      nextCursor: session.chunks.at(-1)?.seq ?? afterSeq,
      result: session.result,
      error: session.error,
    });
  }

  private require(sessionId: string, owner: Readonly<{ taskId: string; turnId: string }>): Session {
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new Error('Managed command session not found');
    if (session.taskId !== owner.taskId || session.turnId !== owner.turnId)
      throw new Error('Managed command session owner mismatch');
    return session;
  }

  private evictTerminal(): void {
    for (const [id, session] of this.sessions) {
      if (
        session.state === 'starting' ||
        session.state === 'running' ||
        session.terminationUnconfirmed
      )
        continue;
      this.sessions.delete(id);
      if (this.sessions.size < this.maxSessions) return;
    }
  }
}

function containsPath(parent: string, child: string): boolean {
  const suffix = relative(parent, child);
  return suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}
