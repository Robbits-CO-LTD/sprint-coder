// Team の Worker が「本当に同時に CLI を動かしていた」人数を、App の DB と Main のログから数える。
// real-ai-team-scale.spec.ts が使う。Playwright に依存しない純粋な関数にして、保存した DB のコピーと
// Main ログにも当て直せるようにしている（node 24 の型除去でそのまま import できる書き方に限る）。
//
// 区間の取り方（根拠は apps/desktop/src/main 配下のコード）:
// - 開始: team_v2_activity_events の `attempt_started`。persistence.ts の transitionTeamAttempt が
//   Attempt を running にするたびに記録する。rate limit の待機から再開したときも、同じ Attempt が
//   もう一度 running になるので、そのたびに新しい区間として始まる。team_attempts.started_at は最初の
//   値を COALESCE で保ち続けるので使わない。
// - 終了: 次のうち、開始より後で最も早いもの。
//   1. Main ログの `team.worker.completed` / `failed` / `canceled`（team-coordinator.ts の
//      handleWorkerActivity が、Worker Runtime の CLI 実行が終わったときに出す）。これを正とする。
//   2. 同じ execution の `execution_waiting`（rate limit・検証・再開待ちへ移った時点。
//      recordTeamAttemptRateLimited は Attempt を閉じずに execution を waiting_rate_limit へ移し、
//      このとき execution_waiting が記録される）。
//   3. team_execution_isolation_completions.created_at（finalizing を終えて waiting_integration に
//      入った時点。統合はこの後なので、統合の時間は区間に入らない）。
//   4. team_attempts.finished_at（統合の後に記録されるため最後の手段。使ったら fallback として数える）。
// - rate limit の待機: execution_waiting の payload.to が waiting_rate_limit のもの、または
//   team_attempts.provider_call_ordinal が 1 以上の Attempt（recordTeamAttemptRateLimited が増やす）。
//   1 件でもあれば、同時編集の合格判定には使わない（呼び出し側が判定不能として失敗させる）。

export type WorkerEnd = Readonly<{ workerId: string; at: number; status: string }>;

export type RunningConcurrency = Readonly<{
  intervals: number;
  maxConcurrent: number;
  secondsAtOrAbove: number;
  threshold: number;
  rateLimitWaits: number;
  rateLimitedAttempts: number;
  endSources: Record<string, number>;
  /** 終了を Main ログ（CLI の終了）で決められなかった区間の数。0 でなければ判定不能。 */
  withoutCliEnd: number;
  byProvider: Record<string, { intervals: number; minS: number; maxS: number; avgS: number }>;
  error?: string;
}>;

type Row = Record<string, unknown>;
type Db = {
  prepare: (sql: string) => { all: () => Row[] };
  close: () => void;
};

/** Main の stdout（secureLogger の JSON 行）から Worker の CLI 実行の終了を拾う。 */
export function parseWorkerEnds(text: string): WorkerEnd[] {
  const ends: WorkerEnd[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes('"team.worker.')) continue;
    try {
      const entry = JSON.parse(line) as {
        event?: string;
        workerId?: string;
        timestamp?: string;
        status?: string;
      };
      const match = /^team\.worker\.(completed|failed|canceled)$/.exec(entry.event ?? '');
      if (match && entry.workerId && entry.timestamp)
        ends.push({ workerId: entry.workerId, at: Date.parse(entry.timestamp), status: match[1]! });
    } catch {
      /* JSON でない行は無視する */
    }
  }
  return ends;
}

export async function runningConcurrency(
  dbPath: string,
  workerEnds: readonly WorkerEnd[],
  threshold: number,
): Promise<RunningConcurrency> {
  const empty = {
    intervals: 0,
    maxConcurrent: 0,
    secondsAtOrAbove: 0,
    threshold,
    rateLimitWaits: 0,
    rateLimitedAttempts: 0,
    endSources: {},
    withoutCliEnd: 0,
    byProvider: {},
  };
  let db: Db | null = null;
  try {
    const sqlite = (await import('node:sqlite')) as unknown as {
      DatabaseSync: new (path: string, options: { readOnly: boolean }) => Db;
    };
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    const activities = db
      .prepare(
        `SELECT type, execution_id, attempt_id, subject_agent_id, payload_json, recorded_at
         FROM team_v2_activity_events ORDER BY seq`,
      )
      .all();
    const attempts = new Map(
      db
        .prepare(
          'SELECT id, finished_at, requested_provider, provider_call_ordinal, state FROM team_attempts',
        )
        .all()
        .map((row) => [String(row['id']), row]),
    );
    const completions = new Map(
      db
        .prepare('SELECT execution_id, created_at FROM team_execution_isolation_completions')
        .all()
        .map((row) => [String(row['execution_id']), Date.parse(String(row['created_at']))]),
    );
    const time = (row: Row): number => Date.parse(String(row['recorded_at']));
    const payloadTo = (row: Row): string | null => {
      try {
        return (JSON.parse(String(row['payload_json'])) as { to?: string }).to ?? null;
      } catch {
        return null;
      }
    };
    const rateLimitWaits = activities.filter(
      (row) => row['type'] === 'execution_waiting' && payloadTo(row) === 'waiting_rate_limit',
    ).length;
    const rateLimitedAttempts = [...attempts.values()].filter(
      (row) =>
        Number(row['provider_call_ordinal'] ?? 0) > 0 || row['state'] === 'waiting_rate_limit',
    ).length;
    const endSources: Record<string, number> = {};
    const byProvider: Record<
      string,
      { intervals: number; minS: number; maxS: number; avgS: number }
    > = {};
    const events: [number, number][] = [];
    let withoutCliEnd = 0;
    for (const start of activities.filter((row) => row['type'] === 'attempt_started')) {
      const startAt = time(start);
      const executionId = String(start['execution_id']);
      const workerId = String(start['subject_agent_id']);
      const attempt = attempts.get(String(start['attempt_id']));
      const candidates: [number, string][] = [];
      const cliEnd = workerEnds
        .filter((end) => end.workerId === workerId && end.at >= startAt)
        .sort((a, b) => a.at - b.at)[0];
      if (cliEnd) candidates.push([cliEnd.at, 'cli_end']);
      else withoutCliEnd++;
      const waiting = activities.find(
        (row) =>
          row['type'] === 'execution_waiting' &&
          String(row['execution_id']) === executionId &&
          time(row) > startAt,
      );
      if (waiting) candidates.push([time(waiting), `execution_waiting:${payloadTo(waiting)}`]);
      const completion = completions.get(executionId);
      if (completion !== undefined && completion > startAt)
        candidates.push([completion, 'isolation_completion']);
      if (attempt && attempt['finished_at'] !== null && attempt['finished_at'] !== undefined)
        candidates.push([Date.parse(String(attempt['finished_at'])), 'attempt_finished_fallback']);
      candidates.sort((a, b) => a[0] - b[0]);
      const end = candidates[0] ?? [Date.now(), 'still_running'];
      endSources[end[1]] = (endSources[end[1]] ?? 0) + 1;
      events.push([startAt, 1], [end[0], -1]);
      const provider = String(attempt?.['requested_provider'] ?? 'unknown');
      const bucket = (byProvider[provider] ??= { intervals: 0, minS: Infinity, maxS: 0, avgS: 0 });
      const seconds = (end[0] - startAt) / 1000;
      bucket.avgS = (bucket.avgS * bucket.intervals + seconds) / (bucket.intervals + 1);
      bucket.intervals++;
      bucket.minS = Math.min(bucket.minS, seconds);
      bucket.maxS = Math.max(bucket.maxS, seconds);
    }
    events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let current = 0;
    let max = 0;
    let above = 0;
    let previous: number | null = null;
    for (const [at, delta] of events) {
      if (previous !== null && current >= threshold) above += at - previous;
      current += delta;
      max = Math.max(max, current);
      previous = at;
    }
    for (const bucket of Object.values(byProvider)) {
      bucket.avgS = Math.round(bucket.avgS);
      bucket.minS = Math.round(bucket.minS);
      bucket.maxS = Math.round(bucket.maxS);
    }
    return {
      intervals: events.length / 2,
      maxConcurrent: max,
      secondsAtOrAbove: Math.round(above / 1000),
      threshold,
      rateLimitWaits,
      rateLimitedAttempts,
      endSources,
      withoutCliEnd,
      byProvider,
    };
  } catch (error) {
    return { ...empty, error: String(error).slice(0, 300) };
  } finally {
    db?.close();
  }
}
