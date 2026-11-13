import { WorktreeError } from './worker-worktree';

/**
 * Team の Worker がファイルを書く作業（workspace-write）は、割り当ての時の確かめ
 * （`TeamCoordinator.requireWorkspaceWriteEligibility` → `WorkerWorktreeManager.requireCleanRepositorySet`）
 * を通る Workspace でしか始まらない: Git の repo で、commit が 1 つ以上あり、入れ子の repo が無く、
 * commit していない変更も、途中の Git の操作も無いこと（Worker の worktree を、その HEAD から作り、
 * 終わったら同じ checkout へ取り込むため）。割り当ての時に初めて確かめていたので、雇えてしまい、
 * 待機中の Worker だけが残った（issue #1241）。
 *
 * ここには、雇う前・Team を渡す前に同じ確かめを使う所が共有する、断る時の決まった文（理由ごと）と、
 * 渡すだけの Turn のための短い間の cache を置く。
 */

export type TeamWorkspaceRepositoryProblem =
  | 'workspace_missing'
  | 'workspace_not_git'
  | 'workspace_no_commit'
  | 'workspace_nested_git'
  | 'workspace_dirty'
  | 'workspace_git_operation'
  | 'git_unavailable';

const PROBLEM_MESSAGES: Readonly<Record<TeamWorkspaceRepositoryProblem, string>> = Object.freeze({
  workspace_missing:
    'この Task には作業フォルダーが選ばれていないので、ファイルを書く Worker を雇えず、Team で作業を分担できません。作業フォルダーを選んでから、もう一度頼んでください。',
  workspace_not_git:
    'この作業フォルダーは Git の管理下にないので、Team で作業を分担できません。Git の管理を始めて最初の commit をしてから、もう一度頼んでください。',
  workspace_no_commit:
    'この作業フォルダーは Git の管理下にありますが、commit がまだ 1 つも無いので、Team で作業を分担できません。最初の commit をしてから、もう一度頼んでください。',
  workspace_dirty:
    'この作業フォルダーには commit していない変更があるので、Team で作業を分担できません（Worker は最後の commit から作業し、終わったら同じ場所へ取り込むため）。変更を commit するか片付けてから、もう一度頼んでください。',
  workspace_git_operation:
    'この作業フォルダーでは Git の操作（merge や rebase など）が途中なので、Team で作業を分担できません。その操作を終えてから、もう一度頼んでください。',
  workspace_nested_git:
    'この作業フォルダーは、Git の repo の中に別の Git の repo が入れ子になっているので、Team で作業を分担できません。作業フォルダーの組み方を見直してから、もう一度頼んでください。',
  git_unavailable:
    'このパソコンで Git が見つからないので、Team で作業を分担できません。Git を入れてから、もう一度頼んでください。',
});

/** 雇う前に断った理由。Leader が利用者にそのまま伝えられる文を message に持つ。 */
export class TeamWorkspaceRepositoryError extends Error {
  constructor(
    readonly code: TeamWorkspaceRepositoryProblem,
    options?: Readonly<{ cause?: unknown }>,
  ) {
    super(PROBLEM_MESSAGES[code], options);
    this.name = 'TeamWorkspaceRepositoryError';
  }
}

export function teamWorkspaceRepositoryMessage(code: TeamWorkspaceRepositoryProblem): string {
  return PROBLEM_MESSAGES[code];
}

/**
 * 雇用が Workspace の確かめ（Team の列の外）を待つ間に、停止（全員停止・Leader の Turn の停止・
 * Task の archive）が先に通った時の断り。停止の後に Worker を作ったり、Team を active に戻したり
 * しない。
 */
export class TeamHireRevokedError extends Error {
  readonly code = 'hire_revoked';

  constructor() {
    super(
      'Team が停止されたので、待っていた Worker の雇用を取り消しました。続ける時は、もう一度頼んでください。',
    );
    this.name = 'TeamHireRevokedError';
  }
}

/**
 * 割り当ての時の確かめ（`requireCleanRepositorySet`）の失敗を、決まった理由に読み替える。Git は
 * `LC_ALL=C` で動く（safe-git）ので、英語の文で見分ける。読み替えられない失敗（作業フォルダーが
 * 見つからない、など）は null を返し、呼ぶ側が元の失敗をそのまま投げる。
 */
export function workspaceRepositoryProblemOf(
  error: unknown,
): TeamWorkspaceRepositoryProblem | null {
  if (!(error instanceof WorktreeError)) return null;
  const message = error.message;
  if (error.code === 'git_unavailable') return 'git_unavailable';
  if (error.code === 'invalid_input' && message === 'Workspace has no roots')
    return 'workspace_missing';
  if (error.code === 'base_changed')
    return message.startsWith('Git operation is already in progress')
      ? 'workspace_git_operation'
      : 'workspace_dirty';
  if (error.code === 'create_failed') {
    if (message.startsWith('Nested Git repositories')) return 'workspace_nested_git';
    if (/not a git repository/i.test(message)) return 'workspace_not_git';
    if (/ambiguous argument 'HEAD'|unknown revision|bad revision 'HEAD'/i.test(message))
      return 'workspace_no_commit';
  }
  return null;
}

/**
 * 渡すだけの Turn を決める時に、Turn を始める前に確かめた答えをしまっておく時間。利用者の操作で
 * 始まる Turn は、始めるたびに確かめ直すので、これを使うのは queue や Goal の続きのように、入口を
 * 通らずに始まる Turn だけ。commit していない変更は Turn の間にも生まれるので、短くする。
 */
export const TEAM_OFFER_WORKSPACE_CACHE_TTL_MS = 2 * 60_000;
/** 渡すだけの Turn のための確かめで、git の 1 回の実行を待つ上限。 */
export const TEAM_OFFER_WORKSPACE_CHECK_TIMEOUT_MS = 3_000;
/** 確かめ全体（Workspace の確認と git）を待つ上限。Turn の開始をこれ以上は待たせない。 */
export const TEAM_OFFER_WORKSPACE_CHECK_DEADLINE_MS = 5_000;

type CachedAnswer = Readonly<{ workspaceKey: string; ready: boolean; checkedAtMs: number }>;

/**
 * 「おまかせ」「積極的に」で、頼まれていない Turn に Team を渡してよい Workspace か（issue #1241）。
 *
 * Team を渡すかは、Turn を封印する DB の transaction の中で同期に決まるので、git はそこでは
 * 走らせない。Turn を始める入口（非同期の所）で `refresh` し、封印の中では `isReady` で読む。
 * queue から始まる Turn など、入口を通らない Turn は、寿命の間だけ前の答えを使い、無い・古い・
 * Workspace が変わった時は渡さない側に倒す。確かめの失敗（git が無い、時間切れなど）も渡さない。
 */
export class TeamOfferWorkspaceGate {
  private readonly answers = new Map<string, CachedAnswer>();

  constructor(
    private readonly options: Readonly<{
      /** 判定そのもの。Git の repo なら resolve、だめなら reject。 */
      check: (taskId: string) => Promise<void>;
      /** 今の Workspace を表す鍵（root の並び）。Workspace が無ければ null。 */
      workspaceKey: (taskId: string) => string | null;
      nowMs?: () => number;
      ttlMs?: number;
      /** 確かめ全体を待つ上限。過ぎたら渡さない側に倒す。 */
      deadlineMs?: number;
    }>,
  ) {}

  /** 確かめ直して覚える。決して投げない（Turn の開始を失敗させない）。 */
  async refresh(taskId: string): Promise<boolean> {
    let workspaceKey: string | null;
    try {
      workspaceKey = this.options.workspaceKey(taskId);
    } catch {
      this.answers.delete(taskId);
      return false;
    }
    let ready = false;
    if (workspaceKey !== null) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.options.check(taskId),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error('Workspace check timed out')),
              this.options.deadlineMs ?? TEAM_OFFER_WORKSPACE_CHECK_DEADLINE_MS,
            );
          }),
        ]);
        ready = true;
      } catch {
        ready = false;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
    this.answers.set(taskId, {
      workspaceKey: workspaceKey ?? '',
      ready,
      checkedAtMs: this.now(),
    });
    return ready;
  }

  /** 封印の中から同期に読む。無い・古い・Workspace が変わった答えは false。 */
  isReady(taskId: string): boolean {
    const answer = this.answers.get(taskId);
    if (answer === undefined || !answer.ready) return false;
    if (this.now() - answer.checkedAtMs > (this.options.ttlMs ?? TEAM_OFFER_WORKSPACE_CACHE_TTL_MS))
      return false;
    try {
      return this.options.workspaceKey(taskId) === answer.workspaceKey;
    } catch {
      return false;
    }
  }

  forget(taskId: string): void {
    this.answers.delete(taskId);
  }

  private now(): number {
    return this.options.nowMs?.() ?? Date.now();
  }
}
