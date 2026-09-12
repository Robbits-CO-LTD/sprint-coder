import type { GraphGeneration, GraphView } from '@sprint-coder/contracts';

const failureLabels = {
  input: '図のデータを確認できませんでした。',
  engine: '描画エンジンを利用できませんでした。',
  render: '図の作成に失敗しました。',
  check: '作成した図が検証を通りませんでした。',
  publish: '図を保存できませんでした。',
};

export function GraphGenerationNotice({
  generation,
  view,
  onCancel,
}: {
  generation: GraphGeneration;
  view: GraphView | null;
  onCancel: () => void;
}) {
  const retained = view
    ? `表示中は保存済みの版 ${view.revision} です。`
    : '図はまだ表示されていません。';
  if (generation.state === 'succeeded' && view?.renderRevision === generation.resultRenderRevision)
    return null;
  return (
    <section
      className="graph-generation"
      data-testid="graph-generation"
      data-state={generation.state}
      role={
        generation.state === 'failed' || generation.state === 'interrupted' ? 'alert' : 'status'
      }
    >
      {generation.proposedTitle ? <strong>{generation.proposedTitle}</strong> : null}
      {generation.state === 'running' || generation.state === 'canceling' ? (
        <>
          <p>
            {generation.state === 'canceling'
              ? '図の作成を取り消しています…'
              : '新しい図を作成しています…'}{' '}
            {retained}
          </p>
          <button
            className="settings-secondary-button"
            onClick={onCancel}
            disabled={generation.state === 'canceling'}
          >
            図の作成を取り消す
          </button>
        </>
      ) : generation.state === 'failed' ? (
        <p>
          新しい図を作成できませんでした。{' '}
          {generation.failureStage ? failureLabels[generation.failureStage] : ''} {retained}
        </p>
      ) : generation.state === 'canceled' ? (
        <p>新しい図の作成を取り消しました。 {retained}</p>
      ) : generation.state === 'interrupted' ? (
        <p>前回の図の作成が途中で終了しました。 {retained}</p>
      ) : (
        <p>新しい図が保存されました。表示の更新を待っています。</p>
      )}
    </section>
  );
}
