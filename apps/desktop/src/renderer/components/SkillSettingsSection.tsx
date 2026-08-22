import { useEffect, useRef, useState } from 'react';
import type { SkillCatalogItem, SkillDraft } from '@sprint-coder/contracts';

export function SkillSettingsSection({
  active,
  onCreateWithAi,
}: {
  active: boolean;
  onCreateWithAi?: (request?: { prompt: string; builtinSkillId: 'skill-creator' }) => void;
}) {
  const [catalog, setCatalog] = useState<SkillCatalogItem[]>([]);
  const [drafts, setDrafts] = useState<SkillDraft[]>([]);
  const [reviewed, setReviewed] = useState<Set<string>>(new Set());
  const [pendingRemoval, setPendingRemoval] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const loaded = useRef(false);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const api = window.sprintCoder?.skills;
      if (!api) throw new Error('unavailable');
      const [nextCatalog, nextDrafts] = await Promise.all([api.list(), api.listDrafts()]);
      setCatalog(
        nextCatalog.items.filter(({ ref }) => ref.source === 'builtin' || ref.source === 'created'),
      );
      setDrafts(nextDrafts);
      setReviewed(new Set());
      loaded.current = true;
      setStatus('Sprint Coder Skillsを読み込みました。');
    } catch {
      setError('Skill一覧を取得できませんでした。再読み込みしてください。');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    if (active && !loaded.current && !loading) void refresh();
  }, [active, loading]);
  async function reload() {
    loaded.current = false;
    await refresh();
  }
  async function toggleCreated(item: SkillCatalogItem) {
    try {
      await window.sprintCoder?.skills?.setCreatedEnabled(
        item.ref.skillId,
        item.ref.digest,
        !item.enabled,
      );
      setCatalog((xs) =>
        xs.map((x) =>
          x.ref.source === 'created' && x.ref.skillId === item.ref.skillId
            ? { ...x, enabled: !item.enabled }
            : x,
        ),
      );
    } catch {
      setError(`${item.name}の状態を変更できませんでした。`);
    }
  }
  async function toggleActivation(item: SkillCatalogItem) {
    try {
      const next = item.activationPolicy === 'manual' ? 'auto-allowed' : 'manual';
      await window.sprintCoder?.skills?.setActivationPolicy(item.ref, next);
      setCatalog((xs) =>
        xs.map((x) =>
          x.ref.skillId === item.ref.skillId && x.ref.digest === item.ref.digest
            ? { ...x, activationPolicy: next }
            : x,
        ),
      );
    } catch {
      setError(`${item.name}の自動選択設定を変更できませんでした。`);
    }
  }
  async function removeCreated(item: SkillCatalogItem) {
    const key = `created:${item.ref.skillId}`;
    if (pendingRemoval !== key) {
      setPendingRemoval(key);
      return;
    }
    try {
      await window.sprintCoder?.skills?.removeCreated(item.ref.skillId, item.ref.digest);
      setCatalog((xs) => xs.filter((x) => x.ref.skillId !== item.ref.skillId));
      setPendingRemoval(null);
    } catch {
      setError(`${item.name}を削除できませんでした。`);
    }
  }
  async function exportCreated(item: SkillCatalogItem, format: 'original' | 'portable') {
    try {
      const path = await window.sprintCoder?.skills?.exportCreated(
        item.ref.skillId,
        item.ref.digest,
        format,
      );
      if (path) setStatus(`${item.name}を${path}へExportしました。`);
    } catch {
      setError(`${item.name}をExportできませんでした。`);
    }
  }
  async function installDraft(draft: SkillDraft) {
    try {
      const api = window.sprintCoder?.skills;
      if (!api) throw new Error('unavailable');
      await api.installDraft(draft.id, draft.digest, true);
      await reload();
    } catch {
      setError(`${draft.name}をインストールできませんでした。`);
    }
  }
  async function discardDraft(draft: SkillDraft) {
    try {
      await window.sprintCoder?.skills?.discardDraft(draft.id);
      setDrafts((xs) => xs.filter((x) => x.id !== draft.id));
    } catch {
      setError(`${draft.name}のDraftを破棄できませんでした。`);
    }
  }

  const builtins = catalog.filter(({ ref }) => ref.source === 'builtin');
  const created = catalog.filter(({ ref }) => ref.source === 'created');
  return (
    <section
      className="settings-skills"
      aria-labelledby="settings-skills-title"
      aria-busy={loading}
    >
      <div className="settings-section-heading">
        <div>
          <h3 id="settings-skills-title">Skills</h3>
          <p>Sprint Coder内蔵Skillと、Skill Creatorで作成したSkillを管理します。</p>
        </div>
        <div className="settings-skill-heading-actions">
          {onCreateWithAi && (
            <button
              type="button"
              className="settings-primary-button"
              onClick={() => onCreateWithAi()}
            >
              AIでSkillを作成
            </button>
          )}
          <button
            type="button"
            className="settings-secondary-button"
            disabled={loading}
            onClick={() => void reload()}
          >
            再読み込み
          </button>
        </div>
      </div>
      {builtins.map((item) => (
        <div key={item.ref.skillId} className="settings-builtin-skill">
          <span>
            <strong>{item.name}</strong>
            <small>組み込みSkill</small>
          </span>
          <span>常時有効</span>
        </div>
      ))}
      {created.length > 0 && (
        <div className="settings-installed-skills" aria-label="作成済みSkill">
          {created.map((item) => {
            const key = `created:${item.ref.skillId}`;
            return (
              <div key={key} className="settings-installed-row">
                <span>
                  <strong>{item.name}</strong>
                  <small>
                    作成済み · {item.kind === 'team' ? 'Team Skill' : 'Chat Skill'} ·{' '}
                    {item.enabled ? '有効' : '無効'}
                  </small>
                </span>
                <button
                  type="button"
                  className="settings-secondary-button"
                  disabled={!item.enabled}
                  onClick={() => void toggleActivation(item)}
                >
                  自動選択 {item.activationPolicy === 'auto-allowed' ? 'ON' : 'OFF'}
                </button>
                <button
                  type="button"
                  className="settings-secondary-button"
                  onClick={() => void toggleCreated(item)}
                >
                  {item.enabled ? '無効にする' : '有効にする'}
                </button>
                <button
                  type="button"
                  className="settings-secondary-button"
                  onClick={() => void exportCreated(item, 'original')}
                >
                  Export
                </button>
                <button
                  type="button"
                  className="settings-secondary-button"
                  onClick={() => void exportCreated(item, 'portable')}
                >
                  Portable Export
                </button>
                <button
                  type="button"
                  className={
                    pendingRemoval === key ? 'settings-danger-button' : 'settings-secondary-button'
                  }
                  onClick={() => void removeCreated(item)}
                >
                  {pendingRemoval === key ? '削除を確定' : '削除'}
                </button>
              </div>
            );
          })}
        </div>
      )}
      {drafts.length > 0 && (
        <div className="settings-skill-drafts" aria-label="確認待ちのSkill Draft">
          <h4>確認待ちのDraft</h4>
          {drafts.map((draft) => (
            <article key={draft.id} className="settings-skill-draft-card">
              <div>
                <strong>{draft.name}</strong>
                <p>{draft.description}</p>
                <details
                  className="settings-skill-draft-files"
                  onToggle={(e) =>
                    setReviewed((xs) => {
                      const n = new Set(xs);
                      if (e.currentTarget.open) n.add(draft.id);
                      else n.delete(draft.id);
                      return n;
                    })
                  }
                >
                  <summary>ファイル内容を確認</summary>
                  {draft.files.map((file) => (
                    <div key={file.path}>
                      <strong>{file.path}</strong>
                      <pre>{file.content}</pre>
                    </div>
                  ))}
                </details>
              </div>
              <div className="settings-skill-actions">
                <button
                  type="button"
                  className="settings-secondary-button"
                  onClick={() => void discardDraft(draft)}
                >
                  破棄
                </button>
                <button
                  type="button"
                  className="settings-primary-button"
                  disabled={!reviewed.has(draft.id)}
                  onClick={() => void installDraft(draft)}
                >
                  内容を確認してインストール
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
      {error && (
        <p className="settings-skill-error" role="alert">
          {error}
        </p>
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {status}
      </p>
    </section>
  );
}
