import { STAGE_LABEL, STAGE_ORDER, useAppStore } from '../store/appStore';
import { turnProgress } from '../lib/turn-progress';
import { ArrowRightLeft, X } from './icons';
import type { InspectorState } from '../lib/inspector-preference';

// Inspector panel (issue #16): progress for the active Turn, and the slot for a live edit stream.
//
// WHAT THIS DOES NOT DO, and why: there is no edit stream. The issue's plan was to replay one from
// `prepareStructuredPatch`'s postImage, but that function has no runtime caller — index.ts calls its
// own wiring "dormant", no write ToolDefinition is published, and the native mutation session
// resolver refuses unconditionally. Building the `editStreamEvent` contract and its main-side
// pipeline would be a channel nothing can ever send on, and a window that never fills is exactly the
// "偽の窓" the issue forbids. So the stream slot states plainly that it is not connected, which the
// issue itself asks to make a first-class state.
//
// The progress gauge, by contrast, has a real source: `stage.changed` already flows, so every segment
// shown reflects something that happened.

export function InspectorPanel({
  state,
  onCycle,
  onHide,
  overlay,
}: {
  state: InspectorState;
  onCycle: () => void;
  onHide: () => void;
  overlay: boolean;
}) {
  const selectedTaskId = useAppStore((s) => s.selectedTaskId);
  const turn = useAppStore((s) => s.turnByTask[selectedTaskId ?? '']);
  if (state === 'hidden') return null;

  const progress =
    turn === undefined
      ? null
      : turnProgress({
          reachedIndex: turn.reachedStageIndex,
          stage: turn.stage,
          status: turn.status,
        });
  const rail = state === 'rail';

  return (
    <aside
      className={`insp-panel insp-panel--${state}${overlay ? ' insp-panel--overlay' : ''}`}
      data-testid="inspector-panel"
      data-inspector-state={state}
      aria-label="実行インスペクタ"
    >
      <div className="insp-head">
        {!rail && <span className="insp-title">実行インスペクタ</span>}
        <button
          type="button"
          className="insp-cycle"
          data-testid="inspector-cycle"
          aria-label="インスペクタの幅を切り替え"
          title="インスペクタの幅を切り替え"
          onClick={onCycle}
        >
          <ArrowRightLeft size={14} />
        </button>
        {!rail && (
          <button
            type="button"
            className="insp-close"
            data-testid="inspector-close"
            aria-label="インスペクタを閉じる"
            onClick={onHide}
          >
            <X size={14} />
          </button>
        )}
      </div>

      <div className="insp-section" data-testid="inspector-gauge">
        {/* Five discrete segments, never a percentage: the Claude CLI does not settle a step count in
            advance, so any number here would be invented (issue #16's "推定 % を演じない"). */}
        <div className={`insp-gauge${rail ? ' insp-gauge--rail' : ''}`} role="presentation">
          {STAGE_ORDER.map((stage, index) => (
            <span
              key={stage}
              className={`insp-seg insp-seg--${progress?.segments[index] ?? 'pending'}`}
              data-segment={progress?.segments[index] ?? 'pending'}
            />
          ))}
        </div>
        {!rail && (
          <p className="insp-stage" data-testid="inspector-stage">
            {turn === undefined ? 'まだ実行がありません' : STAGE_LABEL[turn.stage]}
          </p>
        )}
      </div>

      {!rail && (
        <div className="insp-section" data-testid="inspector-stream">
          <span className="insp-label">編集中のファイル</span>
          {/* No fake window and no dummy progress. The condition for this becoming a real stream is
              a runtime producer of prepared patches — see the file header. */}
          <p className="insp-disconnected" data-testid="inspector-stream-disconnected">
            編集ストリームは接続されていません。現在のプロファイルではRuntimeがファイルを書き込まないため、
            表示できる編集がありません。
          </p>
        </div>
      )}
    </aside>
  );
}
