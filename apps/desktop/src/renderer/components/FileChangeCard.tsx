import type { FileChange } from '../types/sprint-coder';

// The files one Runtime tool call wrote (issue #37).
//
// Paths are rendered as plain text, never as a link or an `<img src>`: they arrive from the CLI's
// structured event, but "structured" only means the *shape* is trustworthy — the string itself is
// still chosen by a process acting on a model's output. Main has already dropped anything resolving
// outside the Workspace root, so what reaches here is in-workspace and relative; showing it as inert
// text keeps it that way.
//
// `dir="ltr"` with `<bdi>` because a path is a machine string. A right-to-left character anywhere in
// a filename would otherwise reorder the whole line under the bidi algorithm and show a path that is
// not the one that changed.

const KIND_LABEL: Record<FileChange['kind'], string> = {
  add: '新規',
  update: '変更',
  delete: '削除',
};

export function FileChangeCard({ changes }: { changes: FileChange[] }) {
  return (
    <div className="filechange-card" data-testid="file-change-card" role="note">
      <span className="filechange-title">ファイルを{changes.length}件変更しました</span>
      <ul className="filechange-list">
        {changes.map((change) => (
          <li className="filechange-row" key={`${change.kind}:${change.path}`}>
            <span
              className={`filechange-kind filechange-kind--${change.kind}`}
              data-kind={change.kind}
            >
              {KIND_LABEL[change.kind]}
            </span>
            <bdi className="filechange-path" dir="ltr" title={change.path}>
              {change.path}
            </bdi>
          </li>
        ))}
      </ul>
    </div>
  );
}
