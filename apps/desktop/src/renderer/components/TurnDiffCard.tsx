import type { TurnDiff } from '../types/sprint-coder';

export function TurnDiffCard({ diff }: { diff: TurnDiff }) {
  if (diff.entries.length === 0) return null;
  return (
    <section className="turn-diff-card" aria-label="このターンの変更">
      <div className="turn-diff-header">
        <strong>変更</strong>
        <span>{diff.entries.length}件</span>
      </div>
      <ul>
        {diff.entries.map((entry) => (
          <li key={`${entry.ordinal}:${entry.path}:${entry.destination ?? ''}`}>
            <span className={`turn-diff-kind turn-diff-kind-${entry.kind}`}>
              {kindLabel(entry.kind)}
            </span>
            <code>{entry.path}</code>
            {entry.destination !== null && (
              <>
                <span aria-hidden="true">→</span>
                <code>{entry.destination}</code>
              </>
            )}
            {entry.status === 'external_drift' && (
              <span className="turn-diff-drift">外部変更あり</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function kindLabel(kind: TurnDiff['entries'][number]['kind']): string {
  switch (kind) {
    case 'add':
      return '追加';
    case 'update':
      return '更新';
    case 'delete':
      return '削除';
    case 'rename':
      return '名前変更';
  }
}
