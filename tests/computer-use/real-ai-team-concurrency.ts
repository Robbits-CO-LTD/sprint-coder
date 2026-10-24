// Team の Worker が「本当に同時に CLI を動かしていた」人数を、App の DB と Main のログから数える。
// Computer Use の実AI検証で使う純粋な集計関数。保存した DB のコピーと
// Main ログにも当て直せるようにしている（node 24 の型除去でそのまま import できる書き方に限る）。
//
// 区間の取り方（根拠は apps/desktop/src 配下のコード）:
// - 開始: その Attempt の `attempt_started`（team_v2_activity_events）より後で、その Worker の CLI が
//   実際に出力を出し始めた最初の記録。具体的には Main ログの `team.worker.activity` か
//   `team.worker.fileChange` の最初の 1 件。
//   - `attempt_started` そのものは使わない。team-coordinator.ts は dispatch の前にこれを記録し、
//     その後 team-worker-runtime.ts の execute が probe・catalog の準備（Codex は隔離環境も）を経てから
//     RuntimeHostClient.start で CLI を起動するので、準備の時間まで区間に入ってしまう。
//   - `team.worker.accepted` も使わない（execute の冒頭、probe より前に出る）。
//   - `team.worker.activity` は、team-worker-runtime.ts の RuntimeHostClient のイベント処理が、
//     Runtime Host から届いた `stage`（claude-normalizer.ts / codex-adapter.ts が CLI の出力を読んで
//     出す）と `operation`（CLI が始めたツールやコマンド）を activity にしたもの。どちらも CLI が起動して
//     出力した後にしか届かない。`team.worker.fileChange` も CLI のファイル操作の後に出る。
//     outputDelta・heartbeat は handleWorkerActivity がログに出さないので使えない。
//   - 例外として、最初の Runtime が使えずに別の Runtime へ fallback するとき、CLI を起動する前に
//     「…へfallbackして続行」の activity が出る。そこで、team_attempts.resolved_provider が
//     requested_provider と違う Attempt が 1 件でもあれば判定不能にする。resolved_provider が
//     NULL の Attempt は、fallback していないと確かめられないので、これも判定不能に数える。
//   - rate limit の待機から再開したときは、同じ Attempt がもう一度 running になり `attempt_started`
//     が記録されるので、その後の最初の CLI の記録から新しい区間として数える。
//   - CLI が最初の出力を出すまでの分だけ、開始は実際の起動より遅い時刻になる（区間は短めになる）。
//     一方、終了に使う Main ログは CLI が実際に終わった後に記録されるので、その分だけ区間は少し長く
//     なりうる。終了側の遅れは、ログを書くまでの短い時間（数十 ms 程度）と見込んでいる。
// - 終了: 開始より後で、次のうち最も早いもの。
//   1. Main ログの `team.worker.completed` / `failed` / `canceled`（team-coordinator.ts の
//      handleWorkerActivity が、Worker Runtime の CLI 実行が終わったときに出す）。これを正とする。
//   2. 同じ execution の `execution_waiting`（rate limit・検証・再開待ちへ移った時点。
//      recordTeamAttemptRateLimited は Attempt を閉じずに execution を waiting_rate_limit へ移し、
//      このとき execution_waiting が記録される）。
//   3. team_execution_isolation_completions.created_at（finalizing を終えて waiting_integration に
//      入った時点。統合はこの後なので、統合の時間は区間に入らない）。
//   4. team_attempts.finished_at（統合の後に記録されるため最後の手段。使ったら fallback として数える）。
// - 開始・終了のどちらかを Main ログで決められない区間が 1 件でもあれば判定不能（呼び出し側が失敗させる）。
// - rate limit の待機: execution_waiting の payload.to が waiting_rate_limit のもの、または
//   team_attempts.provider_call_ordinal が 1 以上の Attempt（recordTeamAttemptRateLimited が増やす）。
//   1 件でもあれば、同時編集の合格判定には使わない（呼び出し側が判定不能として失敗させる）。

export type WorkerEvent = Readonly<{
  workerId: string;
  at: number;
  /** cli: CLI が動いている証拠（activity / fileChange）。end: CLI の実行の終了。 */
  kind: 'cli' | 'end';
  status: string;
}>;

export type RunningConcurrency = Readonly<{
  intervals: number;
  maxConcurrent: number;
  secondsAtOrAbove: number;
  threshold: number;
  rateLimitWaits: number;
  rateLimitedAttempts: number;
  /** 別の Runtime へ fallback した Attempt の数。0 でなければ判定不能。 */
  fallbackAttempts: number;
  endSources: Record<string, number>;
  /** 開始を Main ログ（CLI の最初の出力）で決められなかった区間の数。0 でなければ判定不能。 */
  withoutCliStart: number;
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

/** Main の stdout（secureLogger の JSON 行）から、Worker の CLI が動いていた証拠と終了を拾う。 */
export function parseWorkerEvents(text: string): WorkerEvent[] {
  const events: WorkerEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes('"team.worker.')) continue;
    try {
      const entry = JSON.parse(line) as { event?: string; workerId?: string; timestamp?: string };
      const match = /^team\.worker\.(activity|fileChange|completed|failed|canceled)$/.exec(
        entry.event ?? '',
      );
      if (match && entry.workerId && entry.timestamp)
        events.push({
          workerId: entry.workerId,
          at: Date.parse(entry.timestamp),
          kind: match[1] === 'activity' || match[1] === 'fileChange' ? 'cli' : 'end',
          status: match[1]!,
        });
    } catch {
      /* JSON でない行は無視する */
    }
  }
  return events.sort((a, b) => a.at - b.at);
}

export async function runningConcurrency(
  dbPath: string,
  workerEvents: readonly WorkerEvent[],
  threshold: number,
): Promise<RunningConcurrency> {
  const empty = {
    intervals: 0,
    maxConcurrent: 0,
    secondsAtOrAbove: 0,
    threshold,
    rateLimitWaits: 0,
    rateLimitedAttempts: 0,
    fallbackAttempts: 0,
    endSources: {},
    withoutCliStart: 0,
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
          `SELECT id, finished_at, requested_provider, resolved_provider, provider_call_ordinal, state
           FROM team_attempts`,
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
    // An Attempt whose resolved provider is unknown (NULL) cannot be shown not to have fallen back,
    // so it counts here too (the run is then undecidable rather than certified).
    let fallbackAttempts = [...attempts.values()].filter(
      (row) =>
        row['resolved_provider'] === null ||
        row['resolved_provider'] === undefined ||
        row['resolved_provider'] !== row['requested_provider'],
    ).length;
    const endSources: Record<string, number> = {};
    const byProvider: Record<
      string,
      { intervals: number; minS: number; maxS: number; avgS: number }
    > = {};
    const events: [number, number][] = [];
    let withoutCliStart = 0;
    let withoutCliEnd = 0;
    for (const started of activities.filter((row) => row['type'] === 'attempt_started')) {
      const attemptStartedAt = time(started);
      const executionId = String(started['execution_id']);
      const workerId = String(started['subject_agent_id']);
      const attempt = attempts.get(String(started['attempt_id']));
      // An interval whose Attempt row is missing has no provider to check for a fallback, so the
      // run is undecidable rather than certified.
      if (attempt === undefined) fallbackAttempts++;
      // この Attempt の区間を打ち切る App 側の記録（CLI の終了ログ以外）。
      const appEnds: [number, string][] = [];
      const waiting = activities.find(
        (row) =>
          row['type'] === 'execution_waiting' &&
          String(row['execution_id']) === executionId &&
          time(row) > attemptStartedAt,
      );
      if (waiting) appEnds.push([time(waiting), `execution_waiting:${payloadTo(waiting)}`]);
      const completion = completions.get(executionId);
      if (completion !== undefined && completion > attemptStartedAt)
        appEnds.push([completion, 'isolation_completion']);
      if (attempt && attempt['finished_at'] !== null && attempt['finished_at'] !== undefined)
        appEnds.push([Date.parse(String(attempt['finished_at'])), 'attempt_finished_fallback']);
      appEnds.sort((a, b) => a[0] - b[0]);
      const limit = appEnds[0]?.[0] ?? Number.POSITIVE_INFINITY;
      // 開始: attempt_started の後、App 側の打ち切りより前に出た、その Worker の最初の CLI の記録。
      const cliStart = workerEvents.find(
        (event) =>
          event.workerId === workerId &&
          event.kind === 'cli' &&
          event.at >= attemptStartedAt &&
          event.at < limit,
      );
      if (cliStart === undefined) {
        withoutCliStart++;
        continue;
      }
      const candidates: [number, string][] = appEnds.filter(([at]) => at > cliStart.at);
      const cliEnd = workerEvents.find(
        (event) => event.workerId === workerId && event.kind === 'end' && event.at >= cliStart.at,
      );
      if (cliEnd) candidates.push([cliEnd.at, 'cli_end']);
      else withoutCliEnd++;
      candidates.sort((a, b) => a[0] - b[0]);
      const end = candidates[0] ?? [Date.now(), 'still_running'];
      endSources[end[1]] = (endSources[end[1]] ?? 0) + 1;
      events.push([cliStart.at, 1], [end[0], -1]);
      const provider = String(attempt?.['requested_provider'] ?? 'unknown');
      const bucket = (byProvider[provider] ??= { intervals: 0, minS: Infinity, maxS: 0, avgS: 0 });
      const seconds = (end[0] - cliStart.at) / 1000;
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
      fallbackAttempts,
      endSources,
      withoutCliStart,
      withoutCliEnd,
      byProvider,
    };
  } catch (error) {
    return { ...empty, error: String(error).slice(0, 300) };
  } finally {
    db?.close();
  }
}
