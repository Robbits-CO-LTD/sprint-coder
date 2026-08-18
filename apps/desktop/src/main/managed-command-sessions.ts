import { randomUUID } from 'node:crypto';
import type { ExecutionSpec } from '@sprint-coder/domain';
import { CommandRunner, type CommandOutputChunk, type CommandResult } from './command-runner';

export type ManagedCommandSnapshot = Readonly<{
  sessionId: string;
  state: 'starting' | 'running' | 'exited' | 'failed' | 'canceled';
  executionId: string | null;
  chunks: readonly CommandOutputChunk[];
  nextCursor: number;
  result: CommandResult | null;
  error: string | null;
}>;

type Session = {
  id: string;
  state: ManagedCommandSnapshot['state'];
  executionId: string | null;
  controller: AbortController;
  chunks: CommandOutputChunk[];
  result: CommandResult | null;
  error: string | null;
  started: Promise<void>;
  resolveStarted(): void;
  completion: Promise<void>;
};

export class ManagedCommandSessions {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly runner = new CommandRunner({ sandboxed: true }),
    private readonly maxSessions = 100,
    private readonly maxChunks = 2_000,
  ) {}

  async start(spec: ExecutionSpec): Promise<ManagedCommandSnapshot> {
    if (this.sessions.size >= this.maxSessions) this.evictTerminal();
    if (this.sessions.size >= this.maxSessions)
      throw new Error('Managed command session limit reached');
    let resolveStarted = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const session: Session = {
      id: randomUUID(),
      state: 'starting',
      executionId: null,
      controller: new AbortController(),
      chunks: [],
      result: null,
      error: null,
      started,
      resolveStarted,
      completion: Promise.resolve(),
    };
    this.sessions.set(session.id, session);
    session.completion = this.runner
      .run(spec, {
        signal: session.controller.signal,
        onStarted: ({ executionId }) => {
          session.executionId = executionId;
          session.state = 'running';
          session.resolveStarted();
        },
        onChunk: (chunk) => {
          session.chunks.push(chunk);
          if (session.chunks.length > this.maxChunks)
            session.chunks.splice(0, session.chunks.length - this.maxChunks);
        },
      })
      .then((result) => {
        session.result = result;
        session.state = result.canceled ? 'canceled' : 'exited';
      })
      .catch((error: unknown) => {
        session.state = 'failed';
        session.error = error instanceof Error ? error.message : 'Command failed';
      })
      .finally(() => session.resolveStarted());
    await session.started;
    if (session.state === 'failed') throw new Error(session.error ?? 'Managed command failed');
    return this.snapshot(session, 0);
  }

  poll(sessionId: string, afterSeq = 0): ManagedCommandSnapshot {
    const session = this.require(sessionId);
    return this.snapshot(session, afterSeq);
  }

  writeStdin(sessionId: string, chars: string, close = false): boolean {
    const session = this.require(sessionId);
    return (
      session.executionId !== null && this.runner.writeStdin(session.executionId, chars, close)
    );
  }

  terminate(sessionId: string): boolean {
    const session = this.require(sessionId);
    if (session.state !== 'starting' && session.state !== 'running') return false;
    session.controller.abort(new Error('Managed command terminated'));
    return true;
  }

  async wait(sessionId: string): Promise<ManagedCommandSnapshot> {
    const session = this.require(sessionId);
    await session.completion;
    return this.snapshot(session, 0);
  }

  async dispose(): Promise<void> {
    for (const session of this.sessions.values()) session.controller.abort();
    await Promise.allSettled([...this.sessions.values()].map(({ completion }) => completion));
    await this.runner.dispose();
    this.sessions.clear();
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

  private require(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new Error('Managed command session not found');
    return session;
  }

  private evictTerminal(): void {
    for (const [id, session] of this.sessions) {
      if (session.state === 'starting' || session.state === 'running') continue;
      this.sessions.delete(id);
      if (this.sessions.size < this.maxSessions) return;
    }
  }
}
