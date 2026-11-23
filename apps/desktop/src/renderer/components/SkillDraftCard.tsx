import { useState } from 'react';
import type { SkillDraft } from '@sprint-coder/contracts';
import { skillActionFailure } from '../../skill-feedback';

export function SkillDraftCard({
  draft,
  onInstall,
  onDiscard,
}: {
  draft: SkillDraft;
  onInstall: () => Promise<void>;
  onDiscard: () => Promise<void>;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runAction(action: 'install' | 'discard') {
    setPending(true);
    setError(null);
    try {
      await (action === 'install' ? onInstall() : onDiscard());
    } catch (error) {
      setError(
        skillActionFailure(
          action === 'install'
            ? 'Skillをインストールできませんでした'
            : 'Skillの下書きを破棄できませんでした',
          error,
          'もう一度試してください。',
        ),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      className="skill-draft-card"
      aria-labelledby={`skill-draft-${draft.id}`}
      aria-busy={pending}
    >
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
      {error && (
        <p className="settings-skill-error" role="alert">
          {error}
        </p>
      )}
      <footer>
        <button
          type="button"
          className="turn-diff-action"
          disabled={pending}
          onClick={() => void runAction('discard')}
        >
          破棄
        </button>
        <button
          type="button"
          className="turn-diff-action turn-diff-action--primary"
          disabled={!confirmed || pending}
          title={confirmed ? undefined : 'ファイル内容を開いて確認してください'}
          onClick={() => void runAction('install')}
        >
          インストール
        </button>
      </footer>
    </section>
  );
}
