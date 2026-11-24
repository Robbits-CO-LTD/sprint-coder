import { useCallback, useEffect, useRef, useState } from 'react';
import type { SkillCatalogItem, SkillDraft } from '@sprint-coder/contracts';
import { useAppStore } from '../store/appStore';
import { skillActionFailure } from '../../skill-feedback';

export type SkillCreationFailure =
  'catalog-unavailable' | 'builtin-unavailable' | 'task-unavailable';

const creationFailureMessages: Record<SkillCreationFailure, string> = {
  'catalog-unavailable': 'Skill一覧を取得できませんでした。もう一度試してください。',
  'builtin-unavailable':
    'Skill作成に必要な組み込みSkillを読み込めませんでした。もう一度試し、解消しない場合はアプリを再起動してください。',
  'task-unavailable': '新しいTaskを作れませんでした。もう一度試してください。',
};

export function SkillSettingsSection({
  active,
  onCreateWithAi,
}: {
  active: boolean;
  onCreateWithAi?: (request?: {
    prompt: string;
    builtinSkillId: 'skill-creator';
  }) => Promise<SkillCreationFailure | undefined>;
}) {
  const [catalog, setCatalog] = useState<SkillCatalogItem[]>([]);
  const [drafts, setDrafts] = useState<SkillDraft[]>([]);
  const [reviewed, setReviewed] = useState<Set<string>>(new Set());
  const [pendingRemoval, setPendingRemoval] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [creatingWithAi, setCreatingWithAi] = useState(false);
  const loaded = useRef(false);

  const clearFeedback = useCallback(() => {
    setError(null);
    setStatus('');
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    clearFeedback();
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
    } catch (error) {
      setLoadFailed(true);
      setError(
        skillActionFailure(
          'Skill一覧を取得できませんでした',
          error,
          '再読み込みし、解消しない場合はアプリを再起動してください。',
        ),
      );
    } finally {
      setLoading(false);
    }
  }, [clearFeedback]);
  useEffect(() => {
    if (active && !loaded.current && !loading && !loadFailed) void refresh();
  }, [active, loading, loadFailed, refresh]);
  async function reload() {
    loaded.current = false;
    const state = useAppStore.getState();
    await Promise.all([refresh(), state.selectedTaskId === null ? undefined : state.loadSkills()]);
  }
  async function createWithAi() {
    setCreatingWithAi(true);
    clearFeedback();
    try {
      const failure = await onCreateWithAi?.();
      if (failure !== undefined) setError(creationFailureMessages[failure]);
    } catch {
      setError(
        'Skill作成を始められませんでした。もう一度試し、解消しない場合はアプリを再起動してください。',
      );
    } finally {
      setCreatingWithAi(false);
    }
  }
  async function toggleCreated(item: SkillCatalogItem) {
    clearFeedback();
    try {
      const api = window.sprintCoder?.skills;
      if (!api) throw new Error('unavailable');
      await api.setCreatedEnabled(item.ref.skillId, item.ref.digest, !item.enabled);
      setCatalog((xs) =>
        xs.map((x) =>
          x.ref.source === 'created' && x.ref.skillId === item.ref.skillId
            ? { ...x, enabled: !item.enabled }
            : x,
        ),
      );
      setStatus(`${item.name}を${item.enabled ? '無効' : '有効'}にしました。`);
    } catch (error) {
      setError(
        skillActionFailure('Skillの状態を変更できませんでした', error, '再試行してください。'),
      );
    }
  }
  async function toggleActivation(item: SkillCatalogItem) {
    clearFeedback();
    try {
      const api = window.sprintCoder?.skills;
      if (!api) throw new Error('unavailable');
      const next = item.activationPolicy === 'manual' ? 'auto-allowed' : 'manual';
      await api.setActivationPolicy(item.ref, next);
      setCatalog((xs) =>
        xs.map((x) =>
          x.ref.skillId === item.ref.skillId && x.ref.digest === item.ref.digest
            ? { ...x, activationPolicy: next }
            : x,
        ),
      );
      setStatus(`${item.name}の自動選択を${next === 'auto-allowed' ? '有効' : '無効'}にしました。`);
    } catch (error) {
      setError(
        skillActionFailure('Skillの自動選択を変更できませんでした', error, '再試行してください。'),
      );
    }
  }
  async function removeCreated(item: SkillCatalogItem) {
    const key = `created:${item.ref.skillId}`;
    if (pendingRemoval !== key) {
      setPendingRemoval(key);
      return;
    }
    clearFeedback();
    try {
      const api = window.sprintCoder?.skills;
      if (!api) throw new Error('unavailable');
      await api.removeCreated(item.ref.skillId, item.ref.digest);
      setCatalog((xs) => xs.filter((x) => x.ref.skillId !== item.ref.skillId));
      setPendingRemoval(null);
      setStatus(`${item.name}を削除しました。`);
    } catch (error) {
      setError(skillActionFailure('Skillを削除できませんでした', error, '再試行してください。'));
    }
  }
  async function exportCreated(item: SkillCatalogItem, format: 'original' | 'portable') {
    clearFeedback();
    try {
      const api = window.sprintCoder?.skills;
      if (!api) throw new Error('unavailable');
      const destination = await api.exportCreated(item.ref.skillId, item.ref.digest, format);
      setStatus(
        destination === null ? '書き出しをキャンセルしました。' : `${item.name}を書き出しました。`,
      );
    } catch (error) {
      setError(
        skillActionFailure(
          'Skillを書き出せませんでした',
          error,
          '書き出し先を確認して再試行してください。',
        ),
      );
    }
  }
  async function installDraft(draft: SkillDraft) {
    clearFeedback();
    try {
      await useAppStore.getState().installSkillDraft(draft);
      await refresh();
      setStatus(`${draft.name}をインストールしました。`);
    } catch (error) {
      setError(
        skillActionFailure(
          'Skillをインストールできませんでした',
          error,
          '下書きの内容を確認して再試行してください。',
        ),
      );
    }
  }
  async function discardDraft(draft: SkillDraft) {
    clearFeedback();
    try {
      await useAppStore.getState().discardSkillDraft(draft.id);
      setDrafts((xs) => xs.filter((x) => x.id !== draft.id));
      setStatus(`${draft.name}の下書きを破棄しました。`);
    } catch (error) {
      setError(
        skillActionFailure('Skillの下書きを破棄できませんでした', error, '再試行してください。'),
      );
    }
  }

  const taskCatalog = useAppStore((state) => state.skillCatalog);
  const cliSkills = taskCatalog.filter(
    ({ ref }) => ref.source !== 'created' && ref.source !== 'builtin',
  );
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
          <p>Skillは、AIに繰り返し使わせたい手順をまとめたものです。</p>
        </div>
        <div className="settings-skill-heading-actions">
          {onCreateWithAi && (
            <button
              type="button"
              className="settings-primary-button"
              disabled={creatingWithAi}
              onClick={() => void createWithAi()}
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
      <div className="settings-skill-guide">
        <p>
          入力欄に <kbd>&amp;Skill名</kbd>（例 <kbd>&amp;review</kbd>
          ）と入力すると、一致するSkillが青字に変わります。長い名前と先頭が共通なら、短い名前の後ろにスペースを入れて確定します。候補から選ぶには{' '}
          <kbd>$</kbd> または <kbd>/</kbd>{' '}
          を入力します。青字のSkill名の後ろで、続けて別のSkillも選べます。名前を入力欄から削除すると、その送信から外れます。
        </p>
        <dl>
          <dt>OpenCode・Antigravity・Grok・Cursorで接続</dt>
          <dd>選択したCLIのSkillとSprint Coder用のSkillを一緒に使えます。</dd>
          <dt>Claude Codeで接続</dt>
          <dd>Sprint Coder用とClaude Code用のSkillを一緒に使えます。</dd>
          <dt>Codex CLIで接続</dt>
          <dd>Sprint Coder用とCodex用のSkillを一緒に使えます。</dd>
        </dl>
        <details>
          <summary>Skillの読み込み先と自動選択</summary>
          <p>
            CLI用Skillは、プロジェクトの各フォルダー、ユーザーのホームの順に探します。同じIDがある場合は、先に見つかったものが候補になります。
          </p>
          <dl>
            <dt>Claude Code</dt>
            <dd>
              <code>.claude/skills</code> 配下を読みます。ホーム側は <code>CLAUDE_CONFIG_DIR</code>{' '}
              で変更できます。
            </dd>
            <dt>Codex CLI</dt>
            <dd>
              <code>.agents/skills</code>、<code>.codex/skills</code> の順に読みます。ホーム側の{' '}
              <code>.codex</code> は <code>CODEX_HOME</code> で変更できます。
            </dd>
          </dl>
          <p>
            各Skillの手順は <code>〈Skill ID〉/SKILL.md</code>{' '}
            に置きます。モデルの接続先を変えるとCLI用の候補も切り替わります。選んだ内容は送信時に固定されます。
          </p>
          <p>
            「AIでSkillを作成」では、下書きの内容を確認してからインストールします。作成済みSkillの「自動選択」をONにすると、AIが必要なときに使えます。CLI用Skillは送信ごとに手動で選びます。
          </p>
        </details>
      </div>
      {cliSkills.length > 0 && (
        <details className="settings-cli-skills">
          <summary>このタスクのCLI用Skill（{cliSkills.length}件）</summary>
          <ul>
            {cliSkills.map(({ ref, name, description, enabled }) => (
              <li key={`${ref.source}:${ref.skillId}`}>
                <strong>/{ref.skillId}</strong>
                {name !== ref.skillId && <> · {name}</>}
                <small>
                  {ref.source === 'claude'
                    ? 'Claude Code'
                    : ref.source === 'agents'
                      ? 'Codex CLI'
                      : ref.source}
                  {enabled ? '' : ' · 使用不可'} · {description}
                </small>
              </li>
            ))}
          </ul>
        </details>
      )}
      {builtins.map((item) => (
        <div key={item.ref.skillId} className="settings-builtin-skill">
          <span>
            <strong>{item.name}</strong>
            <small>組み込みSkill · {item.description}</small>
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
                  <small>{item.description}</small>
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
                  onToggle={(e) => {
                    const open = e.currentTarget.open;
                    setReviewed((xs) => {
                      const n = new Set(xs);
                      if (open) n.add(draft.id);
                      else n.delete(draft.id);
                      return n;
                    });
                  }}
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
      <p className={status ? 'settings-note' : 'sr-only'} role="status">
        {status}
      </p>
    </section>
  );
}
