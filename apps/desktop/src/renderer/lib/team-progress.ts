import type { TeamDetail } from '../types/sprint-coder';

export function currentTeamWorkerCount(detail: TeamDetail): number {
  return detail.workers.filter(({ kind, state }) => kind === 'worker' && state !== 'stopped')
    .length;
}

export type TeamRunProgress = {
  label: 'Team実行中';
  detail: string;
};

export function teamRunProgress(detail: TeamDetail | null | undefined): TeamRunProgress | null {
  if (detail == null) return null;
  const workers = detail.workers.filter(
    ({ kind, state }) => kind === 'worker' && state !== 'stopped',
  );
  if (workers.length === 0) return { label: 'Team実行中', detail: 'Workerを編成中' };

  const spawning = workers.filter(({ state }) => state === 'invited' || state === 'spawning');
  if (spawning.length > 0) {
    return {
      label: 'Team実行中',
      detail: `Workerを編成中（${workers.length}人）`,
    };
  }

  const busy = workers.find(({ state }) => state === 'busy');
  if (busy !== undefined) {
    return {
      label: 'Team実行中',
      detail: `${busy.role}が作業中`,
    };
  }

  const reportingWorkerIds = new Set(
    detail.messages
      .filter(({ sourceKind, targetKind }) => sourceKind === 'worker' && targetKind === 'leader')
      .map(({ sourceAgentId }) => sourceAgentId),
  );
  const reportCount = reportingWorkerIds.size;
  if (reportCount >= workers.length) {
    return {
      label: 'Team実行中',
      detail: `報告を統合中（${reportCount}/${workers.length}）`,
    };
  }
  if (reportCount > 0) {
    return {
      label: 'Team実行中',
      detail: `報告を受信中（${reportCount}/${workers.length}）`,
    };
  }

  return { label: 'Team実行中', detail: `${workers.length}人のWorkerへ依頼中` };
}
