import { useEffect, useRef, useState } from 'react';
import { X } from './icons';

export type ProjectMemoryDialogSource = {
  projectId: string;
  turnId: string;
  request: string;
  answer: string;
};

export function ProjectMemoryDialog({
  source,
  onClose,
}: {
  source: ProjectMemoryDialogSource;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  async function save(): Promise<void> {
    const api = window.sprintCoder?.projects.memories;
    if (api === undefined || content.trim() === '') return;
    setSaving(true);
    setError(null);
    try {
      await api.createFromTurn({
        projectId: source.projectId,
        sourceTurnId: source.turnId,
        content,
      });
      window.dispatchEvent(
        new CustomEvent('sprint-coder:project-memory-saved', {
          detail: { projectId: source.projectId },
        }),
      );
      setSaved(true);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Memoryを保存できませんでした。');
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="team-policy-dialog project-memory-dialog"
      aria-labelledby="project-memory-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) onClose();
      }}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialogRef.current && !saving) onClose();
      }}
    >
      <form
        className="team-policy-body"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <header className="team-policy-header project-memory-header">
          <h2 id="project-memory-dialog-title">Projectメモとして保存</h2>
          <button
            type="button"
            className="project-memory-close"
            aria-label="閉じる"
            onClick={onClose}
            disabled={saving}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <p className="settings-note">
          AIの自動記憶とは別に、今後も残したい内容を自分の言葉で要約してください。
        </p>
        <section>
          <h3>Request</h3>
          <pre>{source.request}</pre>
          <h3>Answer</h3>
          <pre>{source.answer}</pre>
        </section>
        <label>
          Memory（1〜4000文字）
          <textarea
            className="project-memory-input"
            autoFocus
            value={content}
            maxLength={4000}
            rows={6}
            disabled={saving || saved}
            onChange={(event) => setContent(event.target.value)}
          />
        </label>
        {error !== null && (
          <p className="project-context-error" role="alert">
            {error}
          </p>
        )}
        {saved && <p role="status">保存しました。次のTurnから利用されます。</p>}
        <div className="project-instruction-actions">
          <span>{content.length.toLocaleString()} / 4,000</span>
          <button type="submit" disabled={saving || saved || content.trim() === ''}>
            {saving ? '保存中…' : saved ? '保存済み' : '保存'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
