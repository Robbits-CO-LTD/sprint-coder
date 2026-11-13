import { useEffect, useId, useRef, useState } from 'react';
import type { AssistantPreferences } from '@sprint-coder/contracts';
import {
  ASSISTANT_CALL_NAME_FIELD,
  ASSISTANT_PREFERENCES_APPLY_NOTE,
  ASSISTANT_PREFERENCE_CHOICE_GROUPS,
  ASSISTANT_PREFERENCE_TOGGLES,
  type AssistantPreferenceChoiceGroup,
} from '../lib/assistant-preferences-options';

type SettingsApi = NonNullable<Window['sprintCoder']>['settings'];

// Null when the preload bridge predates this setting: the section then says so instead of
// rendering controls that would throw on the first change.
export function assistantPreferencesApi(): SettingsApi | null {
  const settings = typeof window === 'undefined' ? undefined : window.sprintCoder?.settings;
  if (
    settings === undefined ||
    typeof settings.getAssistantPreferences !== 'function' ||
    typeof settings.setAssistantPreferences !== 'function'
  )
    return null;
  return settings;
}

/**
 * 「返事の仕方」。項目を変えるたびにすぐ保存する（呼び名は入力を終えた時）。
 * 読み込みと保存は世代で数え、競り負けた古い応答が新しい表示を上書きしないようにする。
 */
export function AssistantPreferencesSettings({ active }: { active: boolean }) {
  const uid = useId();
  const [api] = useState(assistantPreferencesApi);
  const [shown, setShown] = useState<AssistantPreferences | null>(null);
  const [callNameDraft, setCallNameDraft] = useState('');
  const [phase, setPhase] = useState<'idle' | 'loading' | 'saving'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const generation = useRef(0);
  // The newest value Main confirmed, so a failed save can fall back to what is really stored even
  // when an older save succeeded while a newer one was still on its way.
  const confirmed = useRef<{ request: number; preferences: AssistantPreferences } | null>(null);
  // Typing in the call-name field does not start a save, so `generation` cannot tell whether the
  // field holds an unsaved name. `callNameEdits` counts keystrokes; `callNameSent` is the count at
  // which the field last matched a name that was loaded or sent with a save. A save response only
  // rewrites the field while the two agree, so a name being typed is never thrown away — it is
  // saved by the next blur or Enter instead.
  const callNameEdits = useRef(0);
  const callNameSent = useRef(0);

  useEffect(() => {
    if (!active || api === null) return;
    const request = ++generation.current;
    void (async () => {
      setPhase('loading');
      setError(null);
      try {
        const result = await api.getAssistantPreferences();
        if (request !== generation.current) return;
        confirmed.current = { request, preferences: result.preferences };
        setShown(result.preferences);
        setCallNameDraft(result.preferences.callName);
        callNameSent.current = callNameEdits.current;
      } catch {
        if (request !== generation.current) return;
        setError('返事の仕方の設定を読み込めませんでした。設定を開き直してください。');
      } finally {
        if (request === generation.current) setPhase('idle');
      }
    })();
    return () => {
      if (request === generation.current) generation.current += 1;
    };
  }, [active, api]);

  /**
   * `next.callName` is always the last saved (or just committed) name, never the half-typed
   * draft: changing another item does not send a name the user has not finished.
   */
  async function save(next: AssistantPreferences): Promise<void> {
    if (api === null) return;
    const request = ++generation.current;
    const syncCallName = (callName: string) => {
      if (callNameEdits.current === callNameSent.current) setCallNameDraft(callName);
    };
    setShown(next);
    setPhase('saving');
    setError(null);
    setStatus('');
    try {
      const result = await api.setAssistantPreferences(next);
      if (confirmed.current === null || request > confirmed.current.request)
        confirmed.current = { request, preferences: result.preferences };
      if (request !== generation.current) return;
      setShown(result.preferences);
      syncCallName(result.preferences.callName);
      setStatus('返事の仕方を保存しました。');
    } catch {
      if (request !== generation.current) return;
      const fallback = confirmed.current?.preferences ?? null;
      setShown(fallback);
      syncCallName(fallback?.callName ?? '');
      setError('設定を保存できませんでした。直前の値に戻しました。');
    } finally {
      if (request === generation.current) setPhase('idle');
    }
  }

  function commitCallName(): void {
    if (shown === null) return;
    const callName = callNameDraft.trim();
    callNameSent.current = callNameEdits.current;
    if (callName === shown.callName) {
      setCallNameDraft(callName);
      return;
    }
    void save({ ...shown, callName });
  }

  if (api === null)
    return (
      <p className="settings-hint" data-testid="settings-assistant-preferences-unavailable">
        この環境では返事の仕方を変更できません。
      </p>
    );

  const disabled = shown === null;
  return (
    <div
      className="settings-group assistant-preferences-settings"
      data-testid="settings-assistant-preferences"
      aria-busy={phase === 'loading'}
    >
      <p className="settings-hint">{ASSISTANT_PREFERENCES_APPLY_NOTE}</p>

      {ASSISTANT_PREFERENCE_CHOICE_GROUPS.map((group) => (
        <ChoiceGroup
          key={group.key}
          group={group as AssistantPreferenceChoiceGroup}
          name={`${uid}-${group.key}`}
          value={shown?.[group.key] ?? null}
          disabled={disabled}
          onChange={(value) => {
            if (shown !== null) void save({ ...shown, [group.key]: value });
          }}
        />
      ))}

      <label className="settings-field" htmlFor={`${uid}-call-name`}>
        <span className="settings-field-label">{ASSISTANT_CALL_NAME_FIELD.title}</span>
        <input
          id={`${uid}-call-name`}
          className="settings-text-input"
          data-testid="settings-assistant-call-name"
          type="text"
          maxLength={ASSISTANT_CALL_NAME_FIELD.maxLength}
          placeholder={ASSISTANT_CALL_NAME_FIELD.placeholder}
          aria-describedby={`${uid}-call-name-desc`}
          disabled={disabled}
          value={callNameDraft}
          onChange={(event) => {
            callNameEdits.current += 1;
            setCallNameDraft(event.target.value);
          }}
          onBlur={commitCallName}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commitCallName();
            }
          }}
        />
        <small id={`${uid}-call-name-desc`}>{ASSISTANT_CALL_NAME_FIELD.description}</small>
      </label>

      {ASSISTANT_PREFERENCE_TOGGLES.map(({ key, title, description }) => (
        <label
          key={key}
          className={`settings-skill-row${disabled ? ' disabled' : ''}`}
          data-testid={`settings-assistant-${key}`}
        >
          <input
            type="checkbox"
            checked={shown?.[key] ?? false}
            disabled={disabled}
            aria-describedby={`${uid}-${key}-desc`}
            onChange={(event) => {
              if (shown !== null) void save({ ...shown, [key]: event.target.checked });
            }}
          />
          <span>
            <strong>{title}</strong>
            <small id={`${uid}-${key}-desc`}>{description}</small>
          </span>
        </label>
      ))}

      {error !== null && (
        <p
          className="settings-skill-error"
          role="alert"
          data-testid="settings-assistant-preferences-error"
        >
          {error}
        </p>
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {status}
      </p>
    </div>
  );
}

function ChoiceGroup({
  group,
  name,
  value,
  disabled,
  onChange,
}: {
  group: AssistantPreferenceChoiceGroup;
  name: string;
  value: string | null;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <fieldset className="settings-group" data-testid={`settings-assistant-${group.key}`}>
      <legend>{group.title}</legend>
      <p className="settings-hint">{group.description}</p>
      {group.options.map((option) => (
        <label
          key={option.value}
          className={`settings-radio${disabled ? ' disabled' : ''}`}
          data-testid={`settings-assistant-${group.key}-${option.value}`}
        >
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            disabled={disabled}
            onChange={() => onChange(option.value)}
          />
          <span className="settings-radio-text">
            <span className="settings-radio-title">{option.label}</span>
            <span className="settings-radio-desc">{option.description}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
