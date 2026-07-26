import { useEffect, useRef, useState } from 'react';
import type {
  SkillCandidateSummary,
  SkillPreviewResult,
  SkillScanResult,
} from '@sprint-coder/contracts';

type CandidateState = 'idle' | 'previewing' | 'ready' | 'importing' | 'imported' | 'failed';

export function SkillSettingsSection({ active }: { active: boolean }) {
  const [scan, setScan] = useState<SkillScanResult | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [previews, setPreviews] = useState<Map<string, SkillPreviewResult>>(new Map());
  const [states, setStates] = useState<Map<string, CandidateState>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [pendingRemoval, setPendingRemoval] = useState<string | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    if (!active || scan !== null || loading) return;
    void refresh();
  }, [active, loading, scan]);

  async function refresh(): Promise<void> {
    const request = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const result = await skillApi().scanSkills();
      if (request !== generation.current) return;
      setScan(result);
      setSelected(new Set());
      setPreviews(new Map());
      setStates(new Map());
      setStatus(`${result.claudeDetected + result.agentsDetected}件のSkillを検出しました。`);
    } catch {
      if (request === generation.current)
        setError('Skill一覧を取得できませんでした。再読み込みしてください。');
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }

  function toggle(candidate: SkillCandidateSummary): void {
    if (
      !candidate.valid ||
      (candidate.imported && !candidate.updateAvailable) ||
      isBusy(states.get(key(candidate)))
    )
      return;
    const candidateKey = key(candidate);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(candidateKey)) next.delete(candidateKey);
      else next.add(candidateKey);
      return next;
    });
    setPreviews((current) => {
      const next = new Map(current);
      next.delete(candidateKey);
      return next;
    });
    setStates((current) => {
      const next = new Map(current);
      next.set(candidateKey, 'idle');
      return next;
    });
  }

  async function previewSelected(): Promise<void> {
    if (scan === null) return;
    setError(null);
    const chosen = scan.candidates.filter((candidate) => selected.has(key(candidate)));
    const nextPreviews = new Map(previews);
    const nextStates = new Map(states);
    for (const candidate of chosen) {
      const candidateKey = key(candidate);
      nextStates.set(candidateKey, 'previewing');
      setStates(new Map(nextStates));
      try {
        const preview = await skillApi().previewSkill(candidate.provider, candidate.skillId);
        nextPreviews.set(candidateKey, preview);
        nextStates.set(candidateKey, 'ready');
      } catch {
        nextStates.set(candidateKey, 'failed');
      }
      setPreviews(new Map(nextPreviews));
      setStates(new Map(nextStates));
    }
    const ready = [...nextStates.values()].filter((state) => state === 'ready').length;
    setStatus(`${chosen.length}件中${ready}件の内容を確認しました。`);
  }

  async function importReady(): Promise<void> {
    const nextStates = new Map(states);
    let imported = 0;
    let attempted = 0;
    for (const [candidateKey, preview] of previews) {
      if (nextStates.get(candidateKey) !== 'ready') continue;
      attempted += 1;
      nextStates.set(candidateKey, 'importing');
      setStates(new Map(nextStates));
      try {
        const candidate = scan?.candidates.find((item) => key(item) === candidateKey);
        if (candidate?.updateAvailable) await skillApi().updateSkill(preview.previewId);
        else await skillApi().importSkill(preview.previewId);
        nextStates.set(candidateKey, 'imported');
        imported += 1;
      } catch {
        nextStates.set(candidateKey, 'failed');
      }
      setStates(new Map(nextStates));
    }
    setStatus(`${attempted}件中${imported}件を読み込みました。`);
    const result = await skillApi()
      .scanSkills()
      .catch(() => null);
    if (result !== null) setScan(result);
  }

  async function setInstalledEnabled(
    provider: SkillCandidateSummary['provider'],
    skillId: string,
    enabled: boolean,
  ): Promise<void> {
    setError(null);
    try {
      await skillApi().setSkillEnabled(provider, skillId, enabled);
      await refresh();
      setStatus(`${skillId}を${enabled ? '有効' : '無効'}にしました。`);
    } catch {
      setError(`${skillId}の状態を変更できませんでした。`);
    }
  }

  async function removeInstalled(
    provider: SkillCandidateSummary['provider'],
    skillId: string,
  ): Promise<void> {
    const installedKey = `${provider}:${skillId}`;
    if (pendingRemoval !== installedKey) {
      setPendingRemoval(installedKey);
      return;
    }
    setError(null);
    try {
      await skillApi().removeSkill(provider, skillId);
      setPendingRemoval(null);
      await refresh();
      setStatus(`${skillId}を削除しました。`);
    } catch {
      setError(`${skillId}を削除できませんでした。`);
    }
  }

  const busy = [...states.values()].some(isBusy);
  const readyCount = [...states.values()].filter((state) => state === 'ready').length;
  const candidates = scan?.candidates ?? [];

  return (
    <section
      className="settings-skills"
      aria-labelledby="settings-skills-title"
      aria-busy={loading}
    >
      <div className="settings-section-heading">
        <div>
          <h3 id="settings-skills-title">Skills</h3>
          <p>Claude CodeとCodexのSkillを検証済みコピーとして読み込みます。</p>
        </div>
        <button
          type="button"
          className="settings-secondary-button"
          onClick={() => void refresh()}
          disabled={loading || busy}
        >
          再読み込み
        </button>
      </div>

      <dl className="settings-skill-counts">
        <div>
          <dt>Claude Skills</dt>
          <dd>{loading ? '確認中' : `${scan?.claudeDetected ?? 0}件検出`}</dd>
        </div>
        <div>
          <dt>Agent Skills</dt>
          <dd>{loading ? '確認中' : `${scan?.agentsDetected ?? 0}件検出`}</dd>
        </div>
        <div>
          <dt>読み込み済み</dt>
          <dd>{scan?.importedCount ?? 0}件</dd>
        </div>
      </dl>

      <div className="settings-builtin-skill">
        <span>
          <strong>Sprint Coder Team</strong>
          <small>組み込みSkill</small>
        </span>
        <span>置換不可</span>
      </div>

      {(scan?.installed.length ?? 0) > 0 && (
        <div className="settings-installed-skills" aria-label="読み込み済みSkill">
          {scan!.installed.map((installed) => {
            const installedKey = `${installed.provider}:${installed.skillId}`;
            return (
              <div key={installedKey} className="settings-installed-row">
                <span>
                  <strong>{installed.name}</strong>
                  <small>
                    {providerLabel(installed.provider)}
                    {installed.updateAvailable ? ' · 更新あり' : ''}
                    {!installed.sourceAvailable ? ' · 読込元なし' : ''}
                  </small>
                </span>
                <button
                  type="button"
                  className="settings-secondary-button"
                  onClick={() =>
                    void setInstalledEnabled(
                      installed.provider,
                      installed.skillId,
                      !installed.enabled,
                    )
                  }
                >
                  {installed.enabled ? '無効にする' : '有効にする'}
                </button>
                <button
                  type="button"
                  className={
                    pendingRemoval === installedKey
                      ? 'settings-danger-button'
                      : 'settings-secondary-button'
                  }
                  onClick={() => void removeInstalled(installed.provider, installed.skillId)}
                >
                  {pendingRemoval === installedKey ? '削除を確定' : '削除'}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {error !== null && (
        <p className="settings-skill-error" role="alert">
          {error}
        </p>
      )}

      <button
        type="button"
        className="settings-secondary-button settings-skill-toggle"
        aria-expanded={expanded}
        aria-controls="settings-skill-list"
        disabled={loading || busy}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? '候補を閉じる' : '候補を選択'}
      </button>

      {expanded && (
        <fieldset id="settings-skill-list" className="settings-skill-list">
          <legend>読み込むSkill</legend>
          {candidates.length === 0 ? (
            <p className="settings-hint">読み込み可能なSkillは見つかりませんでした。</p>
          ) : (
            candidates.map((candidate) => {
              const candidateKey = key(candidate);
              const state = states.get(candidateKey) ?? 'idle';
              const disabled =
                !candidate.valid || (candidate.imported && !candidate.updateAvailable) || busy;
              const preview = previews.get(candidateKey);
              return (
                <label
                  key={candidateKey}
                  className={`settings-skill-row${disabled ? ' disabled' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(candidateKey)}
                    disabled={disabled}
                    onChange={() => toggle(candidate)}
                  />
                  <span>
                    <strong>{candidate.skillId}</strong>
                    <small>
                      {providerLabel(candidate.provider)} ·{' '}
                      {candidate.imported
                        ? candidate.updateAvailable
                          ? '更新可能'
                          : '読み込み済み'
                        : !candidate.valid
                          ? (candidate.problems[0] ?? '無効なSkill')
                          : stateLabel(state)}
                    </small>
                    {preview !== undefined && (
                      <small>
                        含まれるファイル {preview.files.length}件
                        {preview.warnings.length > 0 ? ` · 警告 ${preview.warnings.length}件` : ''}
                      </small>
                    )}
                  </span>
                </label>
              );
            })
          )}
        </fieldset>
      )}

      {expanded && candidates.length > 0 && (
        <div className="settings-skill-actions">
          <button
            type="button"
            className="settings-secondary-button"
            disabled={selected.size === 0 || busy}
            onClick={() => void previewSelected()}
          >
            内容を確認
          </button>
          <button
            type="button"
            className="settings-primary-button"
            disabled={readyCount === 0 || busy}
            onClick={() => void importReady()}
          >
            {readyCount}件を読み込む
          </button>
        </div>
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {status}
      </p>
    </section>
  );
}

function key(candidate: Pick<SkillCandidateSummary, 'provider' | 'skillId'>): string {
  return `${candidate.provider}:${candidate.skillId}`;
}

function isBusy(state: CandidateState | undefined): boolean {
  return state === 'previewing' || state === 'importing';
}

function providerLabel(provider: SkillCandidateSummary['provider']): string {
  return provider === 'claude' ? 'Claude' : 'Agents';
}

function stateLabel(state: CandidateState): string {
  switch (state) {
    case 'previewing':
      return '内容を確認中';
    case 'ready':
      return '確認済み';
    case 'importing':
      return '読み込み中';
    case 'imported':
      return '読み込み済み';
    case 'failed':
      return '処理に失敗';
    default:
      return '読み込み可能';
  }
}

function skillApi(): NonNullable<Window['sprintCoder']>['settings'] {
  if (window.sprintCoder?.settings === undefined) throw new Error('Skill settings are unavailable');
  return window.sprintCoder.settings;
}
