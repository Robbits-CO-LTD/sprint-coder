import type { TurnRuntimeState } from '../store/appStore';
import type { TurnStage } from '../types/sprint-coder';

export type GenerationPattern = 'drive' | 'orbit' | 'dots' | 'paused' | 'settled';

export function generationPattern(
  stage: TurnStage,
  status: TurnRuntimeState['status'],
): GenerationPattern {
  if (status === 'canceling') return 'paused';
  if (status !== 'running') return 'settled';
  if (stage === 'waiting_approval') return 'paused';
  if (stage === 'executing') return 'orbit';
  if (stage === 'synthesizing') return 'dots';
  return 'drive';
}

export function GenerationIndicator({
  stage,
  status,
}: {
  stage: TurnStage;
  status: TurnRuntimeState['status'];
}) {
  const pattern = generationPattern(stage, status);

  return (
    <span
      className={`generation-indicator generation-indicator--${pattern}`}
      data-testid="generation-indicator"
      data-pattern={pattern}
      data-status={status}
      aria-hidden="true"
    >
      <span className="generation-grid">
        {Array.from({ length: 9 }, (_, index) => (
          <span key={index} className="generation-pixel" />
        ))}
      </span>
    </span>
  );
}
