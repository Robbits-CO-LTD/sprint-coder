import { STAGE_LABEL, STAGE_ORDER, useAppStore } from '../store/appStore';
import { turnProgress } from '../lib/turn-progress';
import { ArrowRightLeft, X } from './icons';
import type { InspectorState } from '../lib/inspector-preference';
import { LiveFileEditView } from './LiveFileEdit';

const FILE_KIND_LABEL: Record<'add' | 'update' | 'delete', string> = {
  add: '新規',
  update: '変更',
  delete: '削除',
};

// Inspector panel (issue #16): progress for the active Turn, and the live edit stream.
//
// The edit stream was empty when this panel shipped: the issue's plan was to replay
// `prepareStructuredPatch`'s postImage, and that function had no runtime caller. Issue #37 gave it a
// real producer instead — the Runtimes now report their own writes (`files.changed`), so what is
// listed here is a file the CLI actually wrote, path-checked against the Workspace root in Main.
//
// The disconnected state is still a first-class case rather than an empty list, because it is the
// normal one at the `ask` preset and whenever no Workspace is selected: nothing can be written, so
// saying "no edits yet" would misdescribe why.

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
  const entries = useAppStore((s) => s.fileChangesByTask[selectedTaskId ?? '']);
  const permission = useAppStore((s) => s.permissionByTask[selectedTaskId ?? '']);
  const workspacePath = useAppStore((s) => s.workspaceByTask[selectedTaskId ?? '']);
  if (state === 'hidden') return null;

  // Mirrors main/write-scope.ts's resolveWriteScope. Kept as an explicit pair rather than a single
  // boolean so the panel can say WHICH of the two conditions is missing — "grant access" and "pick a
  // folder" are different actions, and a generic "not connected" would leave the user guessing.
  const hasWorkspace = workspacePath !== undefined && workspacePath !== null;
  const writable = hasWorkspace && permission !== undefined && permission.preset !== 'ask';
  const reason = !hasWorkspace
    ? 'Workspaceが選択されていないため、Runtimeはファイルを書き込めません。ヘッダーからフォルダを選んでください。'
    : 'Access modeが「確認する」のため、Runtimeはファイルを書き込みません。「自動」以上にすると編集できます。';
  // Newest first, capped: this panel is a live tail, not an audit log — the full history stays in
  // the timeline, which shows each edit in the Turn that produced it.
  const recent = (entries ?? [])
    .flatMap((entry) => entry.changes.map((change) => ({ ...change, seq: entry.seq })))
    .slice(-40)
    .reverse();

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
          {/* The live body sits above the list: while a Turn is writing, the contents are what the
              user is watching, and the list of what has already landed is the summary beneath it. */}
          <LiveFileEditView />
          {writable ? (
            recent.length === 0 ? (
              <p className="insp-disconnected" data-testid="inspector-stream-empty">
                このTaskではまだファイルが変更されていません。
              </p>
            ) : (
              <ul className="insp-files" data-testid="inspector-file-list">
                {recent.map((entry) => (
                  <li className="insp-file" key={`${entry.seq}:${entry.path}`}>
                    <span className={`insp-file-kind insp-file-kind--${entry.kind}`}>
                      {FILE_KIND_LABEL[entry.kind]}
                    </span>
                    {/* dir=ltr and bdi: a path is a machine string, and a right-to-left character
                        anywhere in it would otherwise reorder the whole line and misrepresent which
                        file was touched. */}
                    <bdi className="insp-file-path" dir="ltr" title={entry.path}>
                      {entry.path}
                    </bdi>
                  </li>
                ))}
              </ul>
            )
          ) : (
            <p className="insp-disconnected" data-testid="inspector-stream-disconnected">
              {reason}
            </p>
          )}
        </div>
      )}
    </aside>
  );
}
