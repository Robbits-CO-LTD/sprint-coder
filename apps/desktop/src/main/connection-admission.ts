import type { ProviderConnection } from '@sprint-coder/contracts';

export type ConnectionWaitReason =
  'connection_concurrency' | 'requests_per_minute' | 'tokens_per_minute';

export type ConnectionAdmissionCandidate = Readonly<{
  executionId: string;
  teamId: string;
  connectionId: string;
  queueOrdinal: number;
  queuedAt: string;
  estimatedTokens: number;
}>;

type Bucket = {
  requestTokens: number;
  modelTokens: number;
  updatedAtMs: number;
};

const AGING_THRESHOLD_MS = 30_000;

export class ConnectionAdmissionController {
  private readonly connections = new Map<string, ProviderConnection>();
  private readonly activeByConnection = new Map<string, Set<string>>();
  private readonly buckets = new Map<string, Bucket>();
  private readonly candidateByExecution = new Map<string, ConnectionAdmissionCandidate>();
  private lastConnectionId: string | null = null;
  private readonly lastTeamByConnection = new Map<string, string>();

  constructor(private readonly nowMs: () => number = () => Date.now()) {}

  configure(connection: ProviderConnection): void {
    this.connections.set(connection.id, connection);
    const bucket = this.buckets.get(connection.id);
    if (bucket !== undefined) {
      bucket.requestTokens = Math.min(
        bucket.requestTokens,
        connection.rateLimit.requestsPerMinute ?? Number.POSITIVE_INFINITY,
      );
      bucket.modelTokens = Math.min(
        bucket.modelTokens,
        connection.rateLimit.tokensPerMinute ?? Number.POSITIVE_INFINITY,
      );
    }
  }

  waitReason(candidate: ConnectionAdmissionCandidate): ConnectionWaitReason | null {
    const connection = this.requireConnection(candidate.connectionId);
    if (isBypassed(connection)) return null;
    const active = this.activeByConnection.get(connection.id)?.size ?? 0;
    if (
      connection.rateLimit.maxConcurrentRequests !== null &&
      active >= connection.rateLimit.maxConcurrentRequests
    )
      return 'connection_concurrency';
    const bucket = this.refill(connection);
    if (connection.rateLimit.requestsPerMinute !== null && bucket.requestTokens < 1)
      return 'requests_per_minute';
    if (
      connection.rateLimit.tokensPerMinute !== null &&
      bucket.modelTokens < candidate.estimatedTokens
    )
      return 'tokens_per_minute';
    return null;
  }

  admit(candidate: ConnectionAdmissionCandidate): void {
    const reason = this.waitReason(candidate);
    if (reason !== null) throw new Error(`Connection admission denied: ${reason}`);
    const connection = this.requireConnection(candidate.connectionId);
    if (!isBypassed(connection)) {
      const bucket = this.refill(connection);
      if (connection.rateLimit.requestsPerMinute !== null) bucket.requestTokens -= 1;
      if (connection.rateLimit.tokensPerMinute !== null)
        bucket.modelTokens -= candidate.estimatedTokens;
      const active = this.activeByConnection.get(connection.id) ?? new Set<string>();
      active.add(candidate.executionId);
      this.activeByConnection.set(connection.id, active);
    }
    this.candidateByExecution.set(candidate.executionId, candidate);
    this.lastConnectionId = candidate.connectionId;
    this.lastTeamByConnection.set(candidate.connectionId, candidate.teamId);
  }

  release(executionId: string): void {
    const candidate = this.candidateByExecution.get(executionId);
    if (candidate === undefined) return;
    this.candidateByExecution.delete(executionId);
    const active = this.activeByConnection.get(candidate.connectionId);
    active?.delete(executionId);
    if (active?.size === 0) this.activeByConnection.delete(candidate.connectionId);
  }

  selectNext(candidates: readonly ConnectionAdmissionCandidate[]): number {
    const admissible = candidates
      .map((candidate, index) => ({ candidate, index }))
      .filter(({ candidate }) => this.waitReason(candidate) === null)
      .sort((left, right) => left.candidate.queueOrdinal - right.candidate.queueOrdinal);
    if (admissible.length === 0) return -1;
    const connectionIds = [...new Set(admissible.map(({ candidate }) => candidate.connectionId))];
    const connectionId = nextAfter(connectionIds, this.lastConnectionId);
    const withinConnection = admissible.filter(
      ({ candidate }) => candidate.connectionId === connectionId,
    );
    const aged = withinConnection.filter(
      ({ candidate }) => this.nowMs() - Date.parse(candidate.queuedAt) >= AGING_THRESHOLD_MS,
    );
    if (aged.length > 0) return aged[0]!.index;
    const teamIds = [...new Set(withinConnection.map(({ candidate }) => candidate.teamId))];
    const teamId = nextAfter(teamIds, this.lastTeamByConnection.get(connectionId) ?? null);
    return withinConnection.find(({ candidate }) => candidate.teamId === teamId)!.index;
  }

  private requireConnection(connectionId: string): ProviderConnection {
    const connection = this.connections.get(connectionId);
    if (connection === undefined) throw new Error(`Unknown Provider Connection ${connectionId}`);
    return connection;
  }

  private refill(connection: ProviderConnection): Bucket {
    const now = this.nowMs();
    const existing = this.buckets.get(connection.id) ?? {
      requestTokens: connection.rateLimit.requestsPerMinute ?? Number.POSITIVE_INFINITY,
      modelTokens: connection.rateLimit.tokensPerMinute ?? Number.POSITIVE_INFINITY,
      updatedAtMs: now,
    };
    const elapsedMinutes = Math.max(0, now - existing.updatedAtMs) / 60_000;
    if (connection.rateLimit.requestsPerMinute !== null)
      existing.requestTokens = Math.min(
        connection.rateLimit.requestsPerMinute,
        existing.requestTokens + elapsedMinutes * connection.rateLimit.requestsPerMinute,
      );
    if (connection.rateLimit.tokensPerMinute !== null)
      existing.modelTokens = Math.min(
        connection.rateLimit.tokensPerMinute,
        existing.modelTokens + elapsedMinutes * connection.rateLimit.tokensPerMinute,
      );
    existing.updatedAtMs = now;
    this.buckets.set(connection.id, existing);
    return existing;
  }
}

function isBypassed(connection: ProviderConnection): boolean {
  return connection.runtimeKind === 'builtin_cli' || connection.rateLimit.mode === 'bypass';
}

function nextAfter(values: readonly string[], previous: string | null): string {
  if (values.length === 0) throw new Error('A fairness group cannot be empty');
  if (previous === null) return values[0]!;
  const previousIndex = values.indexOf(previous);
  return values[(previousIndex + 1 + values.length) % values.length]!;
}
