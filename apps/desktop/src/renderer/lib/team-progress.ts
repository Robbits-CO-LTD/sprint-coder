import type { TeamDetail } from '../types/sprint-coder';
import {
  latestExecutionForWorker,
  workerWorkPhase,
  WORK_PHASE_LABELS,
  type WorkerWorkPhase,
} from './team-execution-display';

export function currentTeamWorkerCount(detail: TeamDetail): number {
  return detail.workers.filter(({ kind, state }) => kind === 'worker' && state !== 'stopped')
    .length;
}

export function teamWorkPhaseCounts(detail: TeamDetail): Record<WorkerWorkPhase, number> {
  const counts = { working: 0, waiting_integration: 0, integrating: 0, integration_unknown: 0 };
  const seen = new Set<string>();
  for (const worker of detail.workers) {
    if (worker.kind !== 'worker' || worker.state === 'stopped' || seen.has(worker.id)) continue;
    seen.add(worker.id);
    const phase = workerWorkPhase(worker, latestExecutionForWorker(detail.executions, worker.id));
    if (phase !== null) counts[phase] += 1;
  }
  return counts;
}

export function teamWorkPhaseSummary(detail: TeamDetail): string | null {
  return formatWorkPhaseCounts(teamWorkPhaseCounts(detail));
}

function formatWorkPhaseCounts(counts: Record<WorkerWorkPhase, number>): string | null {
  if (Object.values(counts).every((count) => count === 0)) return null;
  const phases: WorkerWorkPhase[] = ['working', 'waiting_integration', 'integrating'];
  if (counts.integration_unknown > 0) phases.push('integration_unknown');
  return phases.map((phase) => `${WORK_PHASE_LABELS[phase]} ${counts[phase]}人`).join(' · ');
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

  const phases = teamWorkPhaseCounts(detail);
  if (phases.waiting_integration + phases.integrating + phases.integration_unknown > 0) {
    return { label: 'Team実行中', detail: formatWorkPhaseCounts(phases)! };
  }
  const busy = workers.find(
    (worker) =>
      workerWorkPhase(worker, latestExecutionForWorker(detail.executions, worker.id)) === 'working',
  );
  if (busy !== undefined) {
    return {
      label: 'Team実行中',
      detail: `${busy.role}が作業中`,
    };
  }

  const reportingWorkerIds = new Set(
    detail.messages
      .filter(
        ({ sourceAgentId, sourceKind, targetKind }) =>
          sourceKind === 'worker' &&
          targetKind === 'leader' &&
          workers.some(({ id }) => id === sourceAgentId),
      )
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
