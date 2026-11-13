import type { TeamUsageMode } from '@sprint-coder/contracts';
import { useEffect, useId, useRef, useState } from 'react';
import { TEAM_USAGE_NOTES, TEAM_USAGE_OPTIONS } from '../lib/team-usage-options';

type SettingsApi = NonNullable<Window['sprintCoder']>['settings'];

// Null when the preload bridge predates this setting, which keeps the choices disabled instead of
// throwing on click in an older shell.
function teamUsageModeApi(): SettingsApi | null {
  const settings = typeof window === 'undefined' ? undefined : window.sprintCoder?.settings;
  if (
    settings === undefined ||
    typeof settings.getTeamUsageMode !== 'function' ||
    typeof settings.setTeamUsageMode !== 'function'
  )
    return null;
  return settings;
}

/** 「Team の使い方」: Team を言った時だけ使うか、AI の判断でも使うか。選ぶとすぐ保存する。 */
export function TeamUsageModeSetting({ active }: { active: boolean }) {
  const uid = useId();
  const [api] = useState(teamUsageModeApi);
  const [canonical, setCanonical] = useState<TeamUsageMode | null>(null);
  const [shown, setShown] = useState<TeamUsageMode | null>(null);
  const [phase, setPhase] = useState<'idle' | 'loading' | 'saving'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  // Bumped by every read and write, so a response that lost the race never overwrites a newer one.
  const generation = useRef(0);
  // State reads inside the change handler can lag a double-click; the ref cannot.
  const inFlight = useRef(false);

  useEffect(() => {
    if (!active || api === null) return;
    const request = ++generation.current;
    inFlight.current = true;
    void (async () => {
      await Promise.resolve();
      if (request !== generation.current) return;
      setPhase('loading');
      setError(null);
      try {
        const result = await api.getTeamUsageMode();
        if (request !== generation.current) return;
        setCanonical(result.mode);
        setShown(result.mode);
      } catch {
        if (request !== generation.current) return;
        setError('Team の使い方を読み込めませんでした。設定を開き直してください。');
      } finally {
        if (request === generation.current) {
          inFlight.current = false;
          setPhase('idle');
        }
      }
    })();
    return () => {
      if (request !== generation.current) return;
      generation.current += 1;
      inFlight.current = false;
    };
  }, [active, api]);

  async function save(next: TeamUsageMode): Promise<void> {
    if (api === null || inFlight.current || next === canonical) return;
    const request = ++generation.current;
    inFlight.current = true;
    const previous = canonical;
    setShown(next);
    setPhase('saving');
    setError(null);
    setStatus('');
    try {
      const result = await api.setTeamUsageMode({ mode: next });
      if (request !== generation.current) return;
      setCanonical(result.mode);
      setShown(result.mode);
      const label = TEAM_USAGE_OPTIONS.find(({ value }) => value === result.mode)?.label;
      setStatus(`Team の使い方を「${label ?? result.mode}」にしました。`);
    } catch {
      if (request !== generation.current) return;
      // Restore the last value Main confirmed, not the one just attempted.
      setShown(previous);
      setError('Team の使い方を保存できませんでした。直前の選択に戻しました。');
    } finally {
      if (request === generation.current) {
        inFlight.current = false;
        setPhase('idle');
      }
    }
  }

  const disabled = api === null || phase !== 'idle' || shown === null;
  return (
    <fieldset
      className="settings-group team-usage-mode"
      data-testid="settings-team-usage-mode"
      aria-busy={phase === 'loading'}
      aria-describedby={`${uid}-notes`}
    >
      <legend>Team の使い方</legend>
      {TEAM_USAGE_OPTIONS.map(({ value, label, description }) => (
        <label
          key={value}
          className={`settings-radio${disabled ? ' disabled' : ''}`}
          data-testid={`settings-team-usage-mode-${value}`}
        >
          <input
            type="radio"
            name={`${uid}-team-usage-mode`}
            value={value}
            checked={shown === value}
            disabled={disabled}
            onChange={() => void save(value)}
          />
          <span className="settings-radio-text">
            <span className="settings-radio-title">{label}</span>
            <span className="settings-radio-desc">{description}</span>
          </span>
        </label>
      ))}
      <div id={`${uid}-notes`}>
        {TEAM_USAGE_NOTES.map((note) => (
          <p key={note} className="settings-hint">
            {note}
          </p>
        ))}
      </div>
      {api === null && <p className="settings-hint">この環境では変更できません。</p>}
      {error !== null && (
        <p
          className="settings-skill-error"
          role="alert"
          data-testid="settings-team-usage-mode-error"
        >
          {error}
        </p>
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {status}
      </p>
    </fieldset>
  );
}
