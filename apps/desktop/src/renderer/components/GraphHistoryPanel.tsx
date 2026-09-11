import { useEffect, useRef, useState } from 'react';
import type { GraphDiff, GraphVersionSummary, GraphView } from '@sprint-coder/contracts';

const kindLabels = {
  node: 'ノード',
  edge: '接続',
  lane: 'レーン',
  phase: '段階',
  group: 'グループ',
  diagram: '図の情報',
  source: '根拠参照',
  annotation: '判断の区分',
  mission: '実行計画',
  step: '工程',
};
const actionLabels = { added: '追加', removed: '削除', changed: '変更' };
const fieldLabels = new Map(
  Object.entries({
    id: '識別子',
    label: '名前',
    sublabel: '補足',
    type: '種類',
    tag: 'タグ',
    lane: 'レーン',
    from: '接続元',
    to: '接続先',
    variant: '関係の種類',
    role: '役割',
    title: 'タイトル',
    subtitle: '説明',
    members: '所属するノード',
    wraps: '含まれるノード',
    boundaries: '境界',
    cards: '注記',
    mainPath: '主な経路',
    semanticChecks: '関係の条件',
    diagram_type: '図の種類',
    schema_version: '図の形式',
    locale: '言語',
    legend: '凡例',
    engineering_profile: '設計の検査条件',
    views: '表示ガイド',
    basis: '区分',
    objective: '目的',
    doneCriteria: '完了条件',
    workerId: '担当',
    access: 'アクセス範囲',
    dependsOn: '前提工程',
    writeClaims: '変更範囲',
    resourceClaims: '共有資源',
    nodeId: '図のノード',
    key: '工程ID',
    ordinal: '工程順',
    mode: '実行方式',
    rationale: '説明',
    excerpt: '参照コード',
    contentHash: 'ファイル内容ハッシュ',
    excerptHash: '参照範囲ハッシュ',
    rootIdentityDigest: 'Workspaceの識別情報',
    rootId: 'Workspace',
    path: 'ファイル',
    lineStart: '開始行',
    lineEnd: '終了行',
    elementKind: '参照先の種類',
    elementId: '参照先',
  }),
);

/** Keyed by document/render revision in GraphPanel; a view lease refresh does not reset the comparison. */
export function GraphHistoryPanel({ view }: { view: GraphView }) {
  const available =
    Number.isSafeInteger(view.renderRevision) &&
    typeof window.sprintCoder?.graphs?.history === 'function' &&
    typeof window.sprintCoder?.graphs?.compare === 'function';
  const [versions, setVersions] = useState<GraphVersionSummary[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(available);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [comparison, setComparison] = useState<{
    revision: number;
    diff: GraphDiff | null;
    error: string | null;
  } | null>(null);
  const alive = useRef(true);
  const { taskId, renderRevision } = view;

  useEffect(() => {
    if (!available) return;
    let active = true;
    alive.current = true;
    const api = window.sprintCoder?.graphs;
    if (api)
      void api
        .history({ taskId })
        .then((page) => {
          if (!active) return;
          const previous = page.versions.filter((entry) => entry.renderRevision < renderRevision);
          setVersions(previous);
          setCursor(page.nextBeforeRenderRevision);
          setSelected(previous[0]?.renderRevision ?? null);
        })
        .catch(() => {
          if (active) setHistoryError('変更履歴を取得できませんでした。');
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    return () => {
      active = false;
      alive.current = false;
    };
  }, [taskId, renderRevision, available]);

  useEffect(() => {
    if (selected === null || !available) return;
    let active = true;
    void window.sprintCoder?.graphs
      .compare({ taskId, beforeRenderRevision: selected, afterRenderRevision: renderRevision })
      .then((diff) => {
        if (active) setComparison({ revision: selected, diff, error: null });
      })
      .catch(() => {
        if (active)
          setComparison({
            revision: selected,
            diff: null,
            error: 'この版との差分を取得できませんでした。',
          });
      });
    return () => {
      active = false;
    };
  }, [taskId, renderRevision, selected, available]);

  async function loadEarlier() {
    if (cursor === null || loading || !window.sprintCoder) return;
    setLoading(true);
    setHistoryError(null);
    try {
      const page = await window.sprintCoder.graphs.history({
        taskId,
        beforeRenderRevision: cursor,
      });
      if (!alive.current) return;
      const earlier = page.versions.filter((entry) => entry.renderRevision < renderRevision);
      setVersions((current) =>
        [
          ...new Map(
            [...current, ...earlier].map((entry) => [entry.renderRevision, entry]),
          ).values(),
        ].sort((a, b) => b.renderRevision - a.renderRevision),
      );
      setCursor(page.nextBeforeRenderRevision);
      setSelected((current) => current ?? earlier[0]?.renderRevision ?? null);
    } catch {
      if (alive.current) setHistoryError('以前の履歴を取得できませんでした。');
    } finally {
      if (alive.current) setLoading(false);
    }
  }

  const currentComparison = comparison?.revision === selected ? comparison : null;
  return (
    <details
      className="graph-history"
      data-testid="graph-history"
      data-render-revision={renderRevision}
    >
      <summary>変更履歴</summary>
      {!available ? (
        <p className="settings-hint">このアプリでは変更履歴を利用できません。</p>
      ) : (
        <div className="graph-history-content">
          {versions.length > 0 ? (
            <label>
              比較する保存版
              <select
                className="settings-text-input"
                value={selected ?? ''}
                onChange={(event) => setSelected(Number(event.target.value))}
              >
                {versions.map((version) => (
                  <option key={version.renderRevision} value={version.renderRevision}>
                    版 {version.semanticRevision} · 表示 {version.renderRevision} — {version.title}
                  </option>
                ))}
              </select>
            </label>
          ) : !loading && !historyError ? (
            <p className="settings-hint">
              {renderRevision === 1
                ? '最初の版です。'
                : 'このページに比較できる以前の版はありません。'}
            </p>
          ) : null}
          {loading ? <p role="status">履歴を読み込んでいます…</p> : null}
          {historyError ? <p role="alert">{historyError}</p> : null}
          {cursor !== null ? (
            <button
              className="settings-secondary-button"
              onClick={() => void loadEarlier()}
              disabled={loading}
            >
              もっと前の版を表示
            </button>
          ) : null}
          {selected !== null ? (
            currentComparison === null ? (
              <p role="status">差分を確認しています…</p>
            ) : currentComparison.error ? (
              <p role="alert">{currentComparison.error}</p>
            ) : currentComparison.diff ? (
              <GraphDifference diff={currentComparison.diff} />
            ) : null
          ) : null}
        </div>
      )}
    </details>
  );
}

function GraphDifference({ diff }: { diff: GraphDiff }) {
  return (
    <div data-testid="graph-diff" aria-live="polite">
      {!diff.contentChanged ? (
        <p className="settings-hint">
          {diff.presentationOnly
            ? '内容は同じです。配置・表示のみ変わっています。'
            : '内容の変更はありません。'}
        </p>
      ) : (
        <>
          <p>
            版 {diff.before.semanticRevision} → 版 {diff.after.semanticRevision} ·{' '}
            {diff.changes.length}件の変更
          </p>
          <ol className="graph-diff-changes">
            {diff.changes.map((change, index) => (
              <li key={`${change.kind}:${change.id}:${index}`}>
                <strong>
                  {actionLabels[change.action]} · {kindLabels[change.kind]}{' '}
                  {change.afterLabel ?? change.beforeLabel ?? change.id ?? ''}
                </strong>
                <dl>
                  {change.fields.map((field) => (
                    <div className="graph-diff-field" key={field.name}>
                      <dt>{fieldLabels.get(field.name) ?? field.name}</dt>
                      <dd>
                        <span>変更前</span>
                        <pre>{field.before ?? '—'}</pre>
                      </dd>
                      <dd>
                        <span>変更後</span>
                        <pre>{field.after ?? '—'}</pre>
                      </dd>
                    </div>
                  ))}
                </dl>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}
