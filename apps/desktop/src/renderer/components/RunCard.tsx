import { useEffect, useState } from 'react';
import { STAGE_LABEL, STAGE_ORDER, type TurnRuntimeState } from '../store/appStore';
import { formatElapsed } from '../lib/format';

const TITLE_BY_STATUS: Record<TurnRuntimeState['status'], string> = {
  running: '実行中',
  canceling: '停止しています…',
  completed: '完了',
  canceled: '中止',
  failed: '失敗',
  interrupted: '中断',
};

export function RunCard({ turn, onStop }: { turn: TurnRuntimeState; onStop: () => void }) {
  const isActive = turn.status === 'running' || turn.status === 'canceling';
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isActive) return;
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [isActive]);

  const cardStateClass = isActive
    ? 'running'
    : turn.status === 'completed'
      ? 'done'
      : turn.status === 'failed'
        ? 'blocked'
        : 'done';
  const currentIndex = STAGE_ORDER.indexOf(turn.stage);

  return (
    <div
      className={`run-card ${cardStateClass}${isActive ? '' : ' compact'}`}
      data-testid="run-card"
      data-run-status={turn.status}
    >
      <div className="run-head">
        <span className="run-dot" aria-hidden="true" />
        <span className="run-title">{TITLE_BY_STATUS[turn.status]}</span>
        <span className="run-elapsed">{formatElapsed(now - turn.startedAt)}</span>
        {isActive && (
          <button
            type="button"
            className="run-stop"
            data-testid="run-card-stop-button"
            onClick={onStop}
            disabled={turn.status === 'canceling'}
          >
            停止
          </button>
        )}
      </div>
      {isActive && (
        <div className="run-stages">
          {STAGE_ORDER.map((stage, i) => {
            const state = i < currentIndex ? 'done' : i === currentIndex ? 'current' : '';
            return (
              <div key={stage} className={`stage-row ${state}`}>
                <span className="s-icon" aria-hidden="true">
                  {i < currentIndex ? '✓' : i === currentIndex ? '●' : '○'}
                </span>
                <span>{STAGE_LABEL[stage]}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
