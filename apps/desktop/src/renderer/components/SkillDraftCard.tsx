import { useState } from 'react';
import type { SkillDraft } from '@sprint-coder/contracts';

export function SkillDraftCard({
  draft,
  onInstall,
  onDiscard,
}: {
  draft: SkillDraft;
  onInstall: () => void;
  onDiscard: () => void;
}) {
  const [confirmed, setConfirmed] = useState(false);

  return (
    <section className="skill-draft-card" aria-labelledby={`skill-draft-${draft.id}`}>
      <header>
        <div>
          <span>{draft.kind === 'team' ? 'Team Skill Draft' : 'Chat Skill Draft'}</span>
          <h3 id={`skill-draft-${draft.id}`}>{draft.name}</h3>
        </div>
        <code>{draft.digest.slice(0, 12)}</code>
      </header>
      <p>{draft.description}</p>
      <details onToggle={(event) => setConfirmed(event.currentTarget.open)}>
        <summary>{draft.files.length}件のファイルを確認</summary>
        {draft.files.map((file) => (
          <div key={file.path} className="skill-draft-file">
            <strong>{file.path}</strong>
            <pre>{file.content}</pre>
          </div>
        ))}
      </details>
      <footer>
        <button type="button" className="turn-diff-action" onClick={onDiscard}>
          破棄
        </button>
        <button
          type="button"
          className="turn-diff-action turn-diff-action--primary"
          disabled={!confirmed}
          title={confirmed ? undefined : 'ファイル内容を開いて確認してください'}
          onClick={onInstall}
        >
          インストール
        </button>
      </footer>
    </section>
  );
}
