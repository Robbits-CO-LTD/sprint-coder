import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { DESKTOP_CONTROL_LEADER_ACCENT, desktopControlWorkerAccent } from '@sprint-coder/contracts';
import { useAppStore } from '../store/appStore';
import { writeSetupComplete } from '../lib/setup-preference';
import {
  SETUP_PREFERENCE_STEPS,
  SETUP_STEP_LABELS,
  setupSteps,
  type SetupMode,
  type SetupStepId,
} from '../lib/setup-flow';
import {
  CALL_NAME_MAX,
  DEFAULT_ASSISTANT_PREFERENCES,
  DEFAULT_TEAM_USAGE_MODE,
  clampCallName,
  loadAssistantPreferences,
  loadTeamUsageMode,
  saveAssistantPreferences,
  saveTeamUsageMode,
  setupSettingsSupport,
  type AssistantPreferences,
  type TeamUsageMode,
} from '../lib/setup-settings';
import {
  CONFIRM_OPTIONS,
  DEPTH_OPTIONS,
  LANGUAGE_OPTIONS,
  LENGTH_OPTIONS,
  TEAM_USAGE_COST_NOTE,
  TEAM_USAGE_OPTIONS,
  TONE_OPTIONS,
  choiceTitle,
  optionLabel,
  toggleTitle,
  type SetupOption,
} from '../lib/setup-options';
import { ASSISTANT_CALL_NAME_FIELD } from '../lib/assistant-preferences-options';
import {
  readAccessPresetDefault,
  readLastAccessPreset,
  writeAccessPresetDefault,
  type AccessPresetDefault,
} from '../lib/access-preset-preference';
import {
  playInterfaceCue,
  readSoundEffectPreferences,
  setSoundEffectsEnabled,
  unlockSoundEffects,
} from '../lib/ui-sound';
import { useMediaQuery } from '../lib/useMediaQuery';
import { setupPreviewReply } from '../lib/setup-preview';
import { SetupSky, type SkyTheme } from '../lib/setup-sky';
import type { CueName } from 'uisfx';
import { ArrowLeft, ArrowRight, Check, Folder, Settings, X } from './icons';
import { SetupConfetti, SetupStage } from './SetupAnimation';
import { SetupChoiceGroup, SetupSwitch, SetupTeamCards } from './SetupControls';

type PickedFolder = { path: string; label: string };
type Readiness = 'ready' | 'authentication_required' | 'unavailable';
type PreferenceStep = 'reply' | 'team' | 'details';
/** Whether a stored value has been read. Until it has, nothing stands in for it on screen. */
type Known = 'loading' | 'ready' | 'failed' | 'unsupported';

/** The last values known to be stored, and whether each has been read. */
type Baseline = {
  preferences: AssistantPreferences;
  assistant: Known;
  /** Main has stored the reply preferences at least once (before that, nothing is added). */
  configured: boolean;
  teamMode: TeamUsageMode;
  team: Known;
  soundEnabled: boolean;
  accessDefault: AccessPresetDefault;
};

export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** Same choices, same order, same storage as Settings' "新しいタスクの安全設定". */
const ACCESS_OPTIONS: readonly SetupOption<AccessPresetDefault>[] = [
  { value: 'last', label: '前回選択した設定', description: '直近の選択を引き継ぐ' },
  { value: 'ask', label: '実行前に確認', description: '作業のたびに確認' },
  { value: 'auto', label: '安全時は自動', description: '安全な作業は自動で' },
  { value: 'full', label: 'フルアクセス', description: '使う前に確認が出ます' },
];

const KICKERS: Readonly<Record<SetupStepId, string>> = {
  welcome: 'WELCOME',
  ai: 'CONNECT',
  reply: 'YOUR STYLE',
  team: 'TEAMWORK',
  details: 'FINE TUNE',
  workspace: 'WORKSPACE',
  done: 'READY',
};

/** How long the opening runs before the welcome settles (any click or key ends it sooner). */
const INTRO_MS = 3400;
/** The hand-off into the app after "最初の Task を始める". */
const LEAVE_MS = 520;

/** A colour token's current value, so the canvas paints with the same palette as the CSS. */
function token(name: string, fallback: string): string {
  if (typeof window === 'undefined' || typeof getComputedStyle !== 'function') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

/** The background's look for a step. On "返事の仕方" it follows the choices: the tone picks the
 * light (calm blue, warm, or sharp), and the length how crowded the sky is. */
function skyLook(
  step: SetupStepId,
  preferences: AssistantPreferences,
  teamMode: TeamUsageMode,
): { theme: SkyTheme; density: number } {
  const accent = token('--accent', '#8ab0f0');
  const ai = token('--ai-accent', '#d4a7ff');
  const info = token('--info', '#9dc0f5');
  const success = token('--success', '#7bd89c');
  const warning = token('--warning', '#f2c46d');
  const danger = token('--danger', '#ff938a');
  switch (step) {
    case 'welcome':
      return { theme: { colors: [accent, ai], speed: 1 }, density: 110 };
    case 'ai':
      return { theme: { colors: [info, success], speed: 0.9 }, density: 90 };
    case 'reply': {
      const density = { short: 50, balanced: 100, detailed: 165 }[preferences.length];
      if (preferences.tone === 'casual')
        return { theme: { colors: [warning, danger], speed: 1.15 }, density };
      if (preferences.tone === 'crisp')
        return { theme: { colors: [success, '#e9fbff'], speed: 2.1 }, density };
      return { theme: { colors: [accent, info], speed: 0.75 }, density };
    }
    case 'team':
      return {
        theme: {
          colors: [DESKTOP_CONTROL_LEADER_ACCENT, desktopControlWorkerAccent(0)],
          speed: 1.2,
        },
        density: teamMode === 'proactive' ? 120 : 80,
      };
    case 'details':
      return { theme: { colors: [warning, ai], speed: 0.9 }, density: 90 };
    case 'workspace':
      return { theme: { colors: [success, accent], speed: 1 }, density: 90 };
    case 'done':
      return { theme: { colors: [warning, ai], speed: 1.5 }, density: 150 };
  }
}

function readinessLabel(readiness: Readiness): string {
  if (readiness === 'ready') return '接続済み';
  if (readiness === 'authentication_required') return 'ログインが必要';
  return '未検出';
}

const PREFERENCE_KEYS: readonly (keyof AssistantPreferences)[] = [
  'tone',
  'length',
  'depth',
  'language',
  'confirm',
  'callName',
  'emoji',
  'suggestNextSteps',
  'planFirst',
];

/** Items whose value on screen differs from the baseline (the call name compared as it would be
 * stored). */
function changedKeys(
  screen: AssistantPreferences,
  base: AssistantPreferences,
): (keyof AssistantPreferences)[] {
  return PREFERENCE_KEYS.filter((key) =>
    key === 'callName'
      ? screen.callName.trim() !== base.callName.trim()
      : screen[key] !== base[key],
  );
}

/** What the "細かい好み" row of the summary can list. */
type SummaryItem =
  | 'language'
  | 'confirm'
  | 'callName'
  | 'emoji'
  | 'suggestNextSteps'
  | 'planFirst'
  | 'soundEnabled'
  | 'accessDefault'
  | 'tone'
  | 'length'
  | 'depth'
  | 'teamMode';

const REPLY_KEYS: readonly (keyof AssistantPreferences)[] = ['tone', 'length', 'depth'];
const DETAIL_KEYS: readonly (keyof AssistantPreferences)[] = [
  'language',
  'confirm',
  'callName',
  'emoji',
  'suggestNextSteps',
  'planFirst',
];
export function SetupWizard({
  mode = 'first-run',
  onOpenSettings,
  onClose,
  onBusyChange,
}: {
  mode?: SetupMode;
  onOpenSettings: () => void;
  /** Replay only: the × button, Escape, and the final "完了". */
  onClose?: () => void;
  /** Told whenever a step starts or stops being saved (the replay dialog holds Escape meanwhile). */
  onBusyChange?: (busy: boolean) => void;
}) {
  const runtime = useAppStore((state) => state.runtime);
  const createTask = useAppStore((state) => state.createTask);
  const createProject = useAppStore((state) => state.createProject);
  const pickProjectFolders = useAppStore((state) => state.pickProjectFolders);
  const animate = !useMediaQuery(REDUCED_MOTION_QUERY);
  const replay = mode === 'replay';

  const [support] = useState(setupSettingsSupport);
  const steps = useMemo(
    () => setupSteps({ mode, assistant: support.assistant, team: support.team }),
    [mode, support],
  );
  const [index, setIndex] = useState(0);
  const [direction, setDirection] = useState<'forward' | 'back'>('forward');
  const step = steps[Math.min(index, steps.length - 1)]!;

  // ---------- What is on screen, and what is stored ----------
  //
  // The screen shows drafts; `stored` is the last value known to be stored (the baseline). An item
  // counts as "changed in this Setup" only while its draft differs from the baseline — never as a
  // history of clicks — so putting a choice back, or "あとで決める", removes the change by itself.
  // Only changed items are ever written; every other item keeps whatever is stored at that moment
  // (Settings, opened from the AI step, may have changed it meanwhile). A baseline that has not
  // been read is a state of its own ("loading" / "failed"): it is never stood in for by a default.
  const [preferences, setPreferences] = useState<AssistantPreferences>(
    DEFAULT_ASSISTANT_PREFERENCES,
  );
  const [teamMode, setTeamMode] = useState<TeamUsageMode>(DEFAULT_TEAM_USAGE_MODE);
  const [soundEnabled, setSoundEnabled] = useState(() => readSoundEffectPreferences().enabled);
  // Sounds in the Setup follow the switch on screen (the draft), not only what is stored.
  const soundDraft = useRef(soundEnabled);
  useEffect(() => {
    soundDraft.current = soundEnabled;
  }, [soundEnabled]);
  const cue = useCallback((name: CueName) => playInterfaceCue(name, soundDraft.current), []);
  const [accessDefault, setAccessDefault] = useState<AccessPresetDefault>(readAccessPresetDefault);
  const [lastAccess] = useState(readLastAccessPreset);
  const initialBaseline = (): Baseline => ({
    preferences: DEFAULT_ASSISTANT_PREFERENCES,
    assistant: support.assistant ? 'loading' : 'unsupported',
    configured: false,
    teamMode: DEFAULT_TEAM_USAGE_MODE,
    team: support.team ? 'loading' : 'unsupported',
    soundEnabled: readSoundEffectPreferences().enabled,
    accessDefault: readAccessPresetDefault(),
  });
  const [initial] = useState(initialBaseline);
  const stored = useRef<Baseline>(initial);
  // The same values, for drawing: the summary shows what is stored, never the drafts.
  const [confirmed, setConfirmed] = useState<Baseline>(initial);
  const remember = useCallback((patch: Partial<Baseline>) => {
    stored.current = { ...stored.current, ...patch };
    setConfirmed(stored.current);
  }, []);
  // For the summary: items this Setup changed and stored, and items whose save failed.
  const [savedChanges, setSavedChanges] = useState<ReadonlySet<SummaryItem>>(() => new Set());
  const [failedItems, setFailedItems] = useState<ReadonlySet<SummaryItem>>(() => new Set());
  const noteSaved = useCallback((items: readonly SummaryItem[]) => {
    if (items.length === 0) return;
    setSavedChanges((current) => new Set([...current, ...items]));
    setFailedItems((current) => new Set([...current].filter((item) => !items.includes(item))));
  }, []);
  const noteFailed = useCallback((items: readonly SummaryItem[]) => {
    if (items.length === 0) return;
    setFailedItems((current) => new Set([...current, ...items]));
  }, []);

  const [folder, setFolder] = useState<PickedFolder | null>(null);
  // The Project is made only by "最初の Task を始める"; going back and forth never makes another.
  const createdProject = useRef<{ path: string; id: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  /** Takes in a newly read stored value: a draft still equal to the old baseline follows it; a
   * draft that differs (changed here, not saved) stays. The new value becomes the baseline. */
  const adoptPreferences = useCallback(
    (latest: AssistantPreferences, configured: boolean) => {
      const base = stored.current.preferences;
      const wasKnown = stored.current.assistant === 'ready';
      remember({ preferences: latest, assistant: 'ready', configured });
      setPreferences((current) => {
        if (!wasKnown) return { ...latest }; // nothing could be chosen before it was known
        const next = { ...latest };
        for (const key of changedKeys(current, base)) {
          (next as Record<string, unknown>)[key] = current[key];
        }
        return next;
      });
    },
    [remember],
  );
  const adoptTeam = useCallback(
    (mode: TeamUsageMode) => {
      const base = stored.current.teamMode;
      const wasKnown = stored.current.team === 'ready';
      remember({ teamMode: mode, team: 'ready' });
      setTeamMode((current) => (!wasKnown || current === base ? mode : current));
    },
    [remember],
  );
  /** The two settings kept on this PC (Settings can change them too). */
  const adoptLocal = useCallback(() => {
    const sound = readSoundEffectPreferences().enabled;
    const access = readAccessPresetDefault();
    const base = stored.current;
    remember({ soundEnabled: sound, accessDefault: access });
    setSoundEnabled((current) => (current === base.soundEnabled ? sound : current));
    setAccessDefault((current) => (current === base.accessDefault ? access : current));
  }, [remember]);

  // Reads and saves are numbered: a save bumps the number when it starts and when it ends, and a
  // read that started under an older number is dropped — it may hold what was stored before the
  // save. A dropped read is always made again once no save is under way.
  const generation = useRef(0);
  const saving = useRef(0);
  const readAfterSave = useRef(false);
  // Each read of Main's two settings also gets its own number, so that answers arriving out of
  // order cannot step back: once a later read has answered, an earlier one's answer is dropped.
  // (This PC's two settings are read at once, with nothing to wait for, so they cannot cross.)
  const readSerial = useRef({ assistant: 0, team: 0 });
  const answeredSerial = useRef({ assistant: 0, team: 0 });
  const isLatestAnswer = useCallback((kind: 'assistant' | 'team', serial: number): boolean => {
    if (serial < answeredSerial.current[kind]) return false;
    answeredSerial.current[kind] = serial;
    return true;
  }, []);

  /** Reads what is stored now: at the start, on the Team step, back from Settings, and when the
   * window comes back to the front. A read that fails leaves a known baseline as it was, and marks
   * an unknown one "failed". */
  const refreshStored = useCallback(async (): Promise<void> => {
    // A read that a save overtook is made again: at once if the save is over, else after it.
    for (;;) {
      if (!live.current) return;
      if (saving.current > 0) {
        readAfterSave.current = true;
        return;
      }
      const started = generation.current;
      const overtaken = () => generation.current !== started;
      adoptLocal();
      if (support.assistant) {
        const serial = (readSerial.current.assistant += 1);
        const latest = await loadAssistantPreferences();
        if (!live.current) return;
        if (overtaken()) continue;
        if (isLatestAnswer('assistant', serial)) {
          if (latest) adoptPreferences(latest.preferences, latest.configured);
          else if (stored.current.assistant !== 'ready') remember({ assistant: 'failed' });
        }
      }
      if (support.team) {
        const serial = (readSerial.current.team += 1);
        const mode = await loadTeamUsageMode();
        if (!live.current) return;
        if (overtaken()) continue;
        if (isLatestAnswer('team', serial)) {
          if (mode !== null) adoptTeam(mode);
          else if (stored.current.team !== 'ready') remember({ team: 'failed' });
        }
      }
      return;
    }
  }, [adoptLocal, adoptPreferences, adoptTeam, isLatestAnswer, remember, support]);

  /** "もう一度読み込む" after a failed read. */
  const retryRead = useCallback(() => {
    if (stored.current.assistant === 'failed') remember({ assistant: 'loading' });
    if (stored.current.team === 'failed') remember({ team: 'loading' });
    void refreshStored();
  }, [refreshStored, remember]);

  /** Wraps one save so that reads cannot land on top of it (see `generation`). */
  const whileSaving = useCallback(
    async <T,>(work: () => Promise<T>): Promise<T> => {
      saving.current += 1;
      generation.current += 1;
      try {
        return await work();
      } finally {
        generation.current += 1;
        saving.current -= 1;
        if (saving.current === 0 && readAfterSave.current) {
          readAfterSave.current = false;
          void refreshStored();
        }
      }
    },
    [refreshStored],
  );

  // Start from what is stored, so a replay opens with the current choices selected.
  useEffect(() => {
    void refreshStored();
  }, [refreshStored]);

  // Back from Settings ("接続を設定"), or back to this window: read again. Settings returns the
  // focus to the button that opened it, inside the Setup; the window regains focus on its own.
  const settingsOpened = useRef(false);
  const openSettings = useCallback(() => {
    settingsOpened.current = true;
    onOpenSettings();
  }, [onOpenSettings]);
  useEffect(() => {
    const onWindowFocus = () => void refreshStored();
    window.addEventListener('focus', onWindowFocus);
    return () => window.removeEventListener('focus', onWindowFocus);
  }, [refreshStored]);
  const onFocusIn = useCallback(() => {
    if (!settingsOpened.current) return;
    settingsOpened.current = false;
    void refreshStored();
  }, [refreshStored]);

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
    // The Team step always shows what is stored right now.
    if (step === 'team') void refreshStored();
    // refreshStored is stable for a given bridge; only the step decides.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const updatePreferences = useCallback((patch: Partial<AssistantPreferences>) => {
    setPreferences((current) => ({ ...current, ...patch }));
  }, []);

  // ---------- The living background ----------
  const rootRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const skyRef = useRef<SetupSky | null>(null);
  const lastPress = useRef<{ x: number; y: number; at: number } | null>(null);
  // The opening plays once per Setup, with motion only; any click or key ends it at once.
  const [introState, setIntro] = useState<'playing' | 'done'>(() => (animate ? 'playing' : 'done'));
  // Switching motion off part-way ends the opening at once.
  const intro: 'playing' | 'done' = animate ? introState : 'done';
  const endIntro = useCallback(() => {
    setIntro('done');
    skyRef.current?.finishIntro();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const sky = new SetupSky(canvas, { animate });
    sky.setTeamPalette({
      leader: DESKTOP_CONTROL_LEADER_ACCENT,
      workers: [0, 1, 2].map((n) => desktopControlWorkerAccent(n)),
    });
    skyRef.current = sky;
    return () => {
      sky.destroy();
      skyRef.current = null;
    };
  }, [animate]);

  useEffect(() => {
    if (intro !== 'playing') return;
    skyRef.current?.playIntro('SPRINT CODER');
    const timer = window.setTimeout(() => setIntro('done'), INTRO_MS);
    return () => window.clearTimeout(timer);
  }, [intro]);

  // The stage's colour, pace and crowd follow the step — and, on "返事の仕方", the choices.
  useEffect(() => {
    const sky = skyRef.current;
    if (sky === null) return;
    const look = skyLook(step, preferences, teamMode);
    sky.setTheme(look.theme);
    sky.setDensity(look.density);
    // On the Team step the racing cursors keep to the band under the scene, where nothing covers them.
    if (step === 'team') sky.setTeam(teamMode, 0.86, 0.045);
    // On the welcome, the swarm crosses the whole window, one lane in each band.
    else if (step === 'welcome') sky.setTeam('proactive', 0.5, 0.19);
    else sky.setTeam(null);
    // A sky made again (motion switched on or off) must get the current look too.
  }, [animate, preferences, step, teamMode]);

  /** Where a choice was made: the last press if it was just now, else the focused control. */
  const choicePoint = useCallback((): { x: number; y: number } => {
    const root = rootRef.current?.getBoundingClientRect();
    const press = lastPress.current;
    if (press && performance.now() - press.at < 800) return press;
    const focused = document.activeElement?.closest('label') ?? document.activeElement;
    const box = focused instanceof Element ? focused.getBoundingClientRect() : null;
    return {
      x: (box ? box.left + box.width / 2 : 0) - (root?.left ?? 0),
      y: (box ? box.top + box.height / 2 : 0) - (root?.top ?? 0),
    };
  }, []);

  // Every choice answers three ways: a sound (when sound effects are on), a wave across the whole
  // window from where it was made, and a burst of sparks on the stage.
  const [burst, setBurst] = useState(0);
  const respond = useCallback(
    (name: CueName, sound = soundDraft.current) => {
      playInterfaceCue(name, sound);
      const point = choicePoint();
      skyRef.current?.ripple(point.x, point.y);
      setBurst((current) => current + 1);
    },
    [choicePoint],
  );

  const chooseTeamMode = useCallback(
    (value: TeamUsageMode) => {
      setTeamMode(value);
      respond('select');
    },
    [respond],
  );

  /** The changes on this step, measured against what is known to be stored. Nothing counts as a
   * change while the baseline is unknown (the choices are not offered then). */
  const changesOn = useCallback(
    (
      id: PreferenceStep,
    ): {
      assistant: (keyof AssistantPreferences)[];
      local: SummaryItem[];
      team: boolean;
    } => {
      const base = stored.current;
      const assistant =
        base.assistant === 'ready'
          ? changedKeys(preferences, base.preferences).filter((key) =>
              (id === 'reply' ? REPLY_KEYS : id === 'details' ? DETAIL_KEYS : []).includes(key),
            )
          : [];
      const local: SummaryItem[] = [];
      if (id === 'details') {
        if (soundEnabled !== base.soundEnabled) local.push('soundEnabled');
        if (accessDefault !== base.accessDefault) local.push('accessDefault');
      }
      const team = id === 'team' && base.team === 'ready' && teamMode !== base.teamMode;
      return { assistant, local, team };
    },
    [accessDefault, preferences, soundEnabled, teamMode],
  );

  /** Stores what this step changed, and only that: each item is written only when its draft
   * differs from the baseline, over whatever is stored at that moment. */
  const persist = useCallback(
    async (id: PreferenceStep): Promise<void> => {
      const { assistant, local, team } = changesOn(id);
      if (local.length > 0) {
        if (local.includes('accessDefault')) writeAccessPresetDefault(accessDefault);
        if (local.includes('soundEnabled')) {
          setSoundEffectsEnabled(soundEnabled);
          if (soundEnabled) void unlockSoundEffects();
        }
        remember({
          soundEnabled: readSoundEffectPreferences().enabled,
          accessDefault: readAccessPresetDefault(),
        });
        noteSaved(local);
      }
      if (assistant.length > 0) {
        // Lay only the changed items over what is stored right now. Main replaces the whole set,
        // so if that cannot be read (as with the Team mode), nothing is written: an older value
        // standing in would put back items changed elsewhere since (in Settings, say).
        const latest = await loadAssistantPreferences();
        if (latest === null) {
          noteFailed(assistant);
        } else {
          const snapshot: AssistantPreferences = { ...latest.preferences };
          for (const key of assistant)
            (snapshot as Record<string, unknown>)[key] = preferences[key];
          snapshot.callName = clampCallName(snapshot.callName.trim());
          const result = await saveAssistantPreferences(snapshot);
          if (result.outcome === 'saved' && result.preferences) {
            // What Main kept (it cleans the call name) is the new baseline, and what the items
            // just saved show. An item changed on another step and not stored yet (its own save
            // failed) stays a draft, so going back to that step can still store it.
            const before = stored.current.preferences;
            const kept = result.preferences;
            remember({ preferences: kept, assistant: 'ready', configured: true });
            if (live.current) {
              setPreferences((current) => {
                const next = { ...kept };
                for (const key of changedKeys(current, before)) {
                  if (!assistant.includes(key)) {
                    (next as Record<string, unknown>)[key] = current[key];
                  }
                }
                return next;
              });
            }
            noteSaved(assistant);
          } else if (result.outcome === 'failed') {
            noteFailed(assistant);
          }
        }
      }
      if (team) {
        // Compare with what is stored right now; if that cannot be read, do not guess.
        const latest = await loadTeamUsageMode();
        if (latest === null) {
          noteFailed(['teamMode']);
          return;
        }
        if (latest === teamMode) {
          adoptTeam(latest);
          return;
        }
        const result = await saveTeamUsageMode(teamMode);
        if (result.outcome === 'saved' && result.mode) {
          remember({ teamMode: result.mode, team: 'ready' });
          if (live.current) setTeamMode(result.mode);
          noteSaved(['teamMode']);
        } else if (result.outcome === 'failed') {
          noteFailed(['teamMode']);
        }
      }
    },
    [
      accessDefault,
      adoptTeam,
      changesOn,
      noteFailed,
      noteSaved,
      preferences,
      remember,
      soundEnabled,
      teamMode,
    ],
  );

  /** "あとで決める": nothing is stored, and the step's drafts return to what is stored. */
  const revert = useCallback((id: PreferenceStep) => {
    const saved = stored.current;
    if (id === 'reply') {
      setPreferences((current) => ({
        ...current,
        tone: saved.preferences.tone,
        length: saved.preferences.length,
        depth: saved.preferences.depth,
      }));
    } else if (id === 'team') {
      setTeamMode(saved.teamMode);
    } else {
      setPreferences((current) => ({
        ...saved.preferences,
        tone: current.tone,
        length: current.length,
        depth: current.depth,
      }));
      setSoundEnabled(saved.soundEnabled);
      setAccessDefault(saved.accessDefault);
    }
  }, []);

  const moveTo = useCallback(
    (next: number) => {
      setDirection(next > index ? 'forward' : 'back');
      skyRef.current?.warp(next > index ? 1 : -1);
      setError(null);
      setIndex(Math.max(0, Math.min(steps.length - 1, next)));
    },
    [index, steps.length],
  );

  /** Locks the step while something is under way. The focus is first moved off the controls about
   * to be disabled (onto the heading), so it never falls to the page — where Escape would reach
   * the replay dialog itself. */
  const lockStep = useCallback(() => {
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      active !== headingRef.current &&
      rootRef.current?.contains(active)
    ) {
      headingRef.current?.focus({ preventScroll: true });
    }
    setBusy(true);
  }, []);

  const leave = useCallback(
    async (how: 'continue' | 'skip' | 'back') => {
      if (busy) return;
      if (SETUP_PREFERENCE_STEPS.has(step)) {
        const id = step as PreferenceStep;
        if (how === 'skip') revert(id);
        // "続ける" and "戻る" store the step only when something on it differs from what is
        // stored; passing through untouched (or changing a choice and putting it back) stores nothing.
        else {
          const changes = changesOn(id);
          if (changes.assistant.length + changes.local.length > 0 || changes.team) {
            lockStep();
            try {
              await whileSaving(() => persist(id));
            } finally {
              setBusy(false);
            }
          }
        }
      }
      cue(how === 'back' ? 'back' : 'forward');
      moveTo(how === 'back' ? index - 1 : index + 1);
    },
    [busy, changesOn, cue, index, lockStep, moveTo, persist, revert, step, whileSaving],
  );

  const chooseFolder = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const picked = await pickProjectFolders();
      if (!picked.canceled && picked.folders[0]) setFolder(picked.folders[0]);
    } finally {
      setBusy(false);
    }
  }, [pickProjectFolders]);

  /** The step only remembers the folder; the Project is made by "最初の Task を始める". */
  const continueFromWorkspace = useCallback(() => {
    cue('forward');
    moveTo(index + 1);
  }, [cue, index, moveTo]);

  // Set at once (not on the next render), so a second press in the same moment does nothing.
  const finishing = useRef(false);
  const finish = useCallback(async () => {
    if (busy || finishing.current) return;
    if (replay) {
      cue('success');
      onClose?.();
      return;
    }
    finishing.current = true;
    lockStep();
    setError(null);
    try {
      // The chosen folder becomes a Project now, once: a retry after a failed Task reuses it.
      let projectId: string | undefined;
      if (folder !== null) {
        if (createdProject.current?.path !== folder.path) {
          const project = await createProject(folder.label, [
            { path: folder.path, label: folder.label, role: 'primary' },
          ]);
          if (project === null) {
            setError(
              '作業場所を登録できませんでした。フォルダーを確かめて、もう一度お試しください。',
            );
            return;
          }
          createdProject.current = { path: folder.path, id: project.id };
        }
        projectId = createdProject.current?.id;
      }
      // The stage is drawn into the app: everything rushes inwards while the Task is made, and the
      // app's own entrance (Sidebar, then Chat) picks up from there.
      cue('success');
      setLeaving(true);
      skyRef.current?.implode();
      // The Setup disappears the moment the first Task exists, so the hand-off plays first.
      if (animate) await new Promise((resolve) => window.setTimeout(resolve, LEAVE_MS));
      const task = await createTask(projectId);
      if (task === null) {
        // The hand-off did not happen: the board and the sky come back, and the focus goes to the
        // message rather than falling to the page.
        setLeaving(false);
        skyRef.current?.recover();
        requestAnimationFrame(() =>
          rootRef.current
            ?.querySelector<HTMLElement>('.setup-error, [data-testid="setup-finish"]')
            ?.focus({ preventScroll: true }),
        );
        setError('最初の Task を作れませんでした。もう一度お試しください。');
        return;
      }
      writeSetupComplete();
    } finally {
      finishing.current = false;
      setBusy(false);
    }
  }, [animate, busy, createProject, createTask, cue, folder, lockStep, onClose, replay]);

  // Celebrate on arrival, once.
  useEffect(() => {
    if (step !== 'done') return;
    cue('reward');
    skyRef.current?.celebrate();
  }, [cue, step]);

  const primary = useCallback(() => {
    if (step === 'welcome') {
      if (intro === 'playing') endIntro();
      cue('start');
      moveTo(index + 1);
    } else if (step === 'workspace') continueFromWorkspace();
    else if (step === 'done') void finish();
    else void leave('continue');
  }, [continueFromWorkspace, cue, endIntro, finish, index, intro, leave, moveTo, step]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.key === 'Escape' && replay && onClose) {
        // Also stops the dialog's own Escape. While a step is being saved, Escape waits.
        event.preventDefault();
        if (!busy) onClose();
        return;
      }
      // Enter on a choice, a switch or the name field goes forward, like a form would.
      if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
      const target = event.target;
      if (target instanceof HTMLInputElement) {
        event.preventDefault();
        if (!busy) primary();
      }
    },
    [busy, onClose, primary, replay],
  );

  const runtimeStatus = {
    codex: runtime.codexReadiness,
    claude: runtime.claudeReadiness,
    grok: runtime.grokReadiness,
  };
  const accessLabel = optionLabel(ACCESS_OPTIONS, accessDefault);
  // "前回選択した設定" says nothing to someone who has never chosen: say what it means right now.
  const lastLabel = lastAccess ? optionLabel(ACCESS_OPTIONS, lastAccess) : null;
  const accessDisplay = (value: AccessPresetDefault): string =>
    value === 'last'
      ? `${optionLabel(ACCESS_OPTIONS, 'last')}（${lastLabel ? `今は「${lastLabel}」` : 'はじめは「実行前に確認」'}）`
      : optionLabel(ACCESS_OPTIONS, value);
  const accessOptions = ACCESS_OPTIONS.map((option) =>
    option.value === 'last'
      ? {
          ...option,
          description: lastLabel ? `今は「${lastLabel}」を引き継ぐ` : 'はじめは「実行前に確認」',
        }
      : option,
  );
  const position = index + 1;
  const remaining = steps.length - position;
  const isPreferenceStep = SETUP_PREFERENCE_STEPS.has(step);
  const saved = confirmed;
  // The summary always says what is stored now, with a small mark for what this Setup did to it.
  const NOT_READ = '今の設定を読み込めませんでした';
  const NOT_YET = 'まだ決めていません（今までどおり）';
  const rowNote = (items: readonly SummaryItem[]): SummaryNote => {
    if (items.some((item) => failedItems.has(item)))
      return { text: '保存できませんでした', tone: 'failed' };
    if (items.some((item) => savedChanges.has(item)))
      return { text: '変更しました', tone: 'changed' };
    return { text: '変更なし', tone: 'same' };
  };
  // The "細かい好み" row lists many items under one mark. Each item gets a mark of its own only
  // when the row is mixed — some saved, some not — since the row's mark then cannot speak for all.
  const DETAIL_ROW: readonly SummaryItem[] = [...DETAIL_KEYS, 'soundEnabled', 'accessDefault'];
  const detailRowMixed =
    DETAIL_ROW.some((item) => failedItems.has(item)) &&
    DETAIL_ROW.some((item) => savedChanges.has(item) && !failedItems.has(item));
  const mark = (item: SummaryItem, text: string) =>
    !detailRowMixed
      ? text
      : failedItems.has(item)
        ? `${text}（保存できませんでした）`
        : savedChanges.has(item)
          ? `${text}（変更しました）`
          : text;
  const replySummary =
    saved.assistant !== 'ready'
      ? NOT_READ
      : !saved.configured
        ? NOT_YET
        : `${optionLabel(TONE_OPTIONS, saved.preferences.tone)}・${optionLabel(LENGTH_OPTIONS, saved.preferences.length)}・${optionLabel(DEPTH_OPTIONS, saved.preferences.depth)}`;
  const teamSummary =
    saved.team === 'ready' ? optionLabel(TEAM_USAGE_OPTIONS, saved.teamMode) : NOT_READ;
  const onOff = (title: string, on: boolean) => `${title}: ${on ? 'オン' : 'オフ'}`;
  const detailSummary: string[] = [];
  if (support.assistant) {
    if (saved.assistant !== 'ready') detailSummary.push(`返事の項目: ${NOT_READ}`);
    else if (!saved.configured) detailSummary.push(`返事の項目: ${NOT_YET}`);
    else {
      const p = saved.preferences;
      detailSummary.push(
        mark(
          'language',
          `${choiceTitle('language')}: ${optionLabel(LANGUAGE_OPTIONS, p.language)}`,
        ),
        mark('confirm', `${choiceTitle('confirm')}: ${optionLabel(CONFIRM_OPTIONS, p.confirm)}`),
        mark('callName', p.callName ? `呼び名「${p.callName}」` : '呼び名なし'),
        mark('emoji', onOff(toggleTitle('emoji'), p.emoji)),
        mark('suggestNextSteps', onOff(toggleTitle('suggestNextSteps'), p.suggestNextSteps)),
        mark('planFirst', onOff(toggleTitle('planFirst'), p.planFirst)),
      );
    }
    // A reply item whose save failed is marked even while it is not readable.
    for (const item of DETAIL_KEYS) {
      if (failedItems.has(item) && (saved.assistant !== 'ready' || !saved.configured)) {
        detailSummary.push(`${SUMMARY_ITEM_TITLE[item]}（保存できませんでした）`);
      }
    }
  }
  detailSummary.push(
    mark('soundEnabled', onOff('効果音', saved.soundEnabled)),
    mark('accessDefault', `新しいタスクの安全設定: ${accessDisplay(saved.accessDefault)}`),
  );
  const palette = {
    '--setup-leader': DESKTOP_CONTROL_LEADER_ACCENT,
    '--setup-worker-1': desktopControlWorkerAccent(0),
    '--setup-worker-2': desktopControlWorkerAccent(1),
  } as CSSProperties;

  const heading = (text: ReactNode, hero = false) => (
    <h1 id="setup-title" ref={headingRef} tabIndex={-1} className={hero ? 'setup-hero' : undefined}>
      {text}
    </h1>
  );

  return (
    <main
      ref={rootRef}
      className={`setup-wizard${animate ? ' is-animated' : ' is-still'}${replay ? ' is-replay' : ''}${leaving ? ' is-leaving' : ''}`}
      data-testid="setup-wizard"
      data-step={step}
      data-motion={animate ? 'full' : 'reduced'}
      data-intro={intro}
      data-dir={direction}
      data-tone={preferences.tone}
      data-team={teamMode}
      aria-labelledby="setup-title"
      aria-busy={busy || undefined}
      style={palette}
      onFocus={onFocusIn}
      onKeyDown={(event) => {
        if (intro === 'playing') endIntro();
        onKeyDown(event);
      }}
      onPointerDown={(event) => {
        if (intro === 'playing') endIntro();
        const box = event.currentTarget.getBoundingClientRect();
        lastPress.current = {
          x: event.clientX - box.left,
          y: event.clientY - box.top,
          at: performance.now(),
        };
      }}
      onPointerMove={(event) => {
        if (!animate) return;
        const box = event.currentTarget.getBoundingClientRect();
        skyRef.current?.setPointer(event.clientX - box.left, event.clientY - box.top);
      }}
    >
      <div className="setup-backdrop" aria-hidden="true">
        <i className="setup-orb setup-orb--a" />
        <i className="setup-orb setup-orb--b" />
        <canvas ref={canvasRef} className="setup-sky" data-testid="setup-sky" />
      </div>

      {/* Decoration only: everything it shows is also said on the board. */}
      <div className="setup-visual" aria-hidden="true">
        <SetupStage
          step={step}
          animate={animate}
          burst={burst}
          introPlaying={intro === 'playing'}
          preferences={preferences}
          assistantSupported={support.assistant}
          teamMode={teamMode}
          soundEnabled={soundEnabled}
          accessLabel={accessLabel}
          runtime={runtimeStatus}
          folderLabel={folder?.label ?? null}
        />
        <p className="setup-visual-caption" aria-hidden="true">
          <span>STEP {String(position).padStart(2, '0')}</span>
          <span>{SETUP_STEP_LABELS[step]}</span>
        </p>
        {step === 'done' && animate && <SetupConfetti />}
      </div>

      {/* If making the first Task takes a while, say so: never a screen with nothing on it. */}
      {leaving && (
        <p className="setup-leaving-note" role="status" data-testid="setup-leaving-note">
          最初の Task を準備しています…
        </p>
      )}

      <section className="setup-content">
        <header
          className="setup-progress"
          aria-label={`セットアップ ${position} / ${steps.length}`}
        >
          <span className="setup-wordmark">SPRINT CODER</span>
          <ol>
            {steps.map((id, at) => (
              <li
                key={id}
                className={`${at < index ? 'is-done' : ''}${at === index ? ' is-current' : ''}`}
                aria-current={at === index ? 'step' : undefined}
              >
                <i />
                <span className="setup-visually-hidden">{SETUP_STEP_LABELS[id]}</span>
              </li>
            ))}
            {/* A light runs along the whole track each time the step moves. */}
            <li
              key={`comet-${index}`}
              className={`setup-progress-comet is-${direction}`}
              aria-hidden="true"
            />
          </ol>
          <span className="setup-progress-count" aria-hidden="true">
            {position} / {steps.length}
            {remaining > 0 && <small>あと {remaining}</small>}
          </span>
          {replay && onClose && (
            <button
              type="button"
              className="setup-close"
              data-testid="setup-close"
              aria-label="セットアップを閉じる"
              onClick={onClose}
              // Not while a step is being saved: it closes once the save is over.
              disabled={busy}
            >
              <X size={16} />
            </button>
          )}
        </header>

        <div className="setup-scroll">
          {/* A fieldset, so that while a step is being saved every control on it is locked at once:
              what is stored is always what was on screen when it was sent. */}
          <fieldset
            key={step}
            className={`setup-step setup-step--${direction}`}
            data-testid={`setup-step-${step}`}
            disabled={busy}
            aria-labelledby="setup-title"
          >
            <p className="setup-kicker">{KICKERS[step]}</p>

            {step === 'welcome' && (
              <>
                {heading(
                  <>
                    <span className="setup-words">
                      {['言葉に', 'するだけで、'].map((word, n) => (
                        <span key={word} style={{ '--w': n } as CSSProperties}>
                          {word}
                        </span>
                      ))}
                    </span>
                    <br />
                    <span className="setup-words setup-shine">
                      {['AI の', 'チームが', '動きだす。'].map((word, n) => (
                        <span key={word} style={{ '--w': n + 2 } as CSSProperties}>
                          {word}
                        </span>
                      ))}
                    </span>
                  </>,
                  true,
                )}
                <p className="setup-lead">
                  {
                    'Sprint Coder は、あなたの言葉を、動くものに変えていく仕事場です。返事の仕方やチームの動き方を、1 分ほどであなた好みに整えましょう。'
                  }
                </p>
                <button
                  type="button"
                  className="setup-primary"
                  data-testid="setup-start"
                  onClick={primary}
                >
                  {replay ? '始める' : 'セットアップを始める'} <ArrowRight size={16} />
                </button>
              </>
            )}

            {step === 'ai' && (
              <>
                {heading('使う AI を確認')}
                <p className="setup-lead">
                  このパソコンに入っている AI を、自動で探しました。ほかの AI
                  は、設定からつなげられます。
                </p>
                <ul className="setup-runtime-list">
                  <li>
                    <span className={`setup-status setup-status--${runtime.codexReadiness}`} />
                    <strong>Codex</strong>
                    <small>{readinessLabel(runtime.codexReadiness)}</small>
                  </li>
                  <li>
                    <span className={`setup-status setup-status--${runtime.claudeReadiness}`} />
                    <strong>Claude Code</strong>
                    <small>{readinessLabel(runtime.claudeReadiness)}</small>
                  </li>
                  <li>
                    <span className={`setup-status setup-status--${runtime.grokReadiness}`} />
                    <strong>Grok CLI</strong>
                    <small>
                      {runtime.grokReadiness === 'authentication_required'
                        ? 'ログインが必要です（grok login）'
                        : readinessLabel(runtime.grokReadiness)}
                    </small>
                  </li>
                </ul>
                <button type="button" className="setup-secondary" onClick={openSettings}>
                  <Settings size={15} /> 接続を設定
                </button>
              </>
            )}

            {step === 'reply' && (
              <>
                {heading('返事の仕方を選ぶ')}
                <p className="setup-lead">選ぶたびに、左の見本がその場で書き変わります。</p>
                {/* The sample reply, read once and whole (the stage itself is hidden from reading). */}
                <p
                  className="setup-visually-hidden"
                  aria-live="polite"
                  data-testid="setup-preview-live"
                >
                  {setupPreviewReply(preferences)}
                </p>
                {saved.assistant !== 'ready' ? (
                  <ReadingNotice state={saved.assistant} onRetry={retryRead} />
                ) : (
                  <div className="setup-groups">
                    <SetupChoiceGroup
                      legend={choiceTitle('tone')}
                      options={TONE_OPTIONS}
                      value={preferences.tone}
                      testId="setup-tone"
                      onChange={(tone) => {
                        updatePreferences({ tone });
                        respond('select');
                      }}
                    />
                    <SetupChoiceGroup
                      legend={choiceTitle('length')}
                      options={LENGTH_OPTIONS}
                      value={preferences.length}
                      testId="setup-length"
                      onChange={(length) => {
                        updatePreferences({ length });
                        respond('select');
                      }}
                    />
                    <SetupChoiceGroup
                      legend={choiceTitle('depth')}
                      options={DEPTH_OPTIONS}
                      value={preferences.depth}
                      testId="setup-depth"
                      onChange={(depth) => {
                        updatePreferences({ depth });
                        respond('select');
                      }}
                    />
                  </div>
                )}
              </>
            )}

            {step === 'team' && (
              <>
                {heading('Team の使い方')}
                <p className="setup-lead">
                  大きな作業は、AI が仲間を呼んで手分けできます。どのくらい頼るかを選びましょう。
                </p>
                {saved.team !== 'ready' ? (
                  <ReadingNotice state={saved.team} onRetry={retryRead} />
                ) : (
                  <SetupTeamCards
                    options={TEAM_USAGE_OPTIONS}
                    value={teamMode}
                    onChange={chooseTeamMode}
                    animate={animate}
                  />
                )}
                <p className="setup-note">{TEAM_USAGE_COST_NOTE}</p>
              </>
            )}

            {step === 'details' && (
              <>
                {heading('細かい好み')}
                <p className="setup-lead">気になる所だけ変えれば大丈夫です。</p>
                <div className="setup-detail-grid">
                  {support.assistant && saved.assistant !== 'ready' && (
                    <section className="setup-panel setup-panel--wide">
                      <ReadingNotice state={saved.assistant} onRetry={retryRead} />
                    </section>
                  )}
                  {support.assistant && saved.assistant === 'ready' && (
                    <section className="setup-panel" aria-labelledby="setup-panel-talk">
                      <h2 id="setup-panel-talk">話し方</h2>
                      <SetupChoiceGroup
                        legend={choiceTitle('language')}
                        options={LANGUAGE_OPTIONS}
                        value={preferences.language}
                        testId="setup-language"
                        onChange={(language) => {
                          updatePreferences({ language });
                          respond('select');
                        }}
                      />
                      <label className="setup-field">
                        <span>
                          {ASSISTANT_CALL_NAME_FIELD.title} <small>なくても大丈夫</small>
                        </span>
                        <input
                          type="text"
                          data-testid="setup-call-name"
                          value={preferences.callName}
                          maxLength={CALL_NAME_MAX}
                          placeholder={ASSISTANT_CALL_NAME_FIELD.placeholder}
                          autoComplete="off"
                          spellCheck={false}
                          onChange={(event) =>
                            updatePreferences({
                              callName: clampCallName(event.currentTarget.value),
                            })
                          }
                        />
                      </label>
                      <SetupSwitch
                        label={toggleTitle('emoji')}
                        checked={preferences.emoji}
                        testId="setup-emoji"
                        onChange={(emoji) => {
                          updatePreferences({ emoji });
                          respond(emoji ? 'check' : 'uncheck');
                        }}
                      />
                    </section>
                  )}
                  {support.assistant && saved.assistant === 'ready' && (
                    <section className="setup-panel" aria-labelledby="setup-panel-work">
                      <h2 id="setup-panel-work">作業のしかた</h2>
                      <SetupChoiceGroup
                        legend={choiceTitle('confirm')}
                        options={CONFIRM_OPTIONS}
                        value={preferences.confirm}
                        testId="setup-confirm"
                        onChange={(confirm) => {
                          updatePreferences({ confirm });
                          respond('select');
                        }}
                      />
                      <SetupSwitch
                        label={toggleTitle('planFirst')}
                        checked={preferences.planFirst}
                        testId="setup-plan-first"
                        onChange={(planFirst) => {
                          updatePreferences({ planFirst });
                          respond(planFirst ? 'check' : 'uncheck');
                        }}
                      />
                      <SetupSwitch
                        label={toggleTitle('suggestNextSteps')}
                        checked={preferences.suggestNextSteps}
                        testId="setup-suggest-next"
                        onChange={(suggestNextSteps) => {
                          updatePreferences({ suggestNextSteps });
                          respond(suggestNextSteps ? 'check' : 'uncheck');
                        }}
                      />
                    </section>
                  )}
                  <section
                    className="setup-panel setup-panel--wide"
                    aria-labelledby="setup-panel-app"
                  >
                    <h2 id="setup-panel-app">このアプリ</h2>
                    <SetupSwitch
                      label="効果音"
                      description="完了・失敗・確認待ちを音で知らせます"
                      checked={soundEnabled}
                      testId="setup-sound"
                      onChange={(enabled) => {
                        setSoundEnabled(enabled);
                        // Heard only when it is switched on, never at the moment it is switched off.
                        respond('check', enabled);
                      }}
                    />
                    <SetupChoiceGroup
                      legend="新しいタスクの安全設定"
                      options={accessOptions}
                      value={accessDefault}
                      columns={4}
                      testId="setup-access"
                      onChange={(value) => {
                        setAccessDefault(value);
                        respond('select');
                      }}
                    />
                  </section>
                </div>
              </>
            )}

            {step === 'workspace' && (
              <>
                {heading('作業場所を選ぶ')}
                <p className="setup-lead">
                  AI と一緒に作業するフォルダーをひとつ選びます。あとから、いつでも変えられます。
                </p>
                <button
                  type="button"
                  className={`setup-folder ${folder ? 'is-selected' : ''}`}
                  data-testid="setup-folder"
                  onClick={() => void chooseFolder()}
                  disabled={busy}
                >
                  <Folder size={19} />
                  <span>
                    <strong>{folder?.label ?? 'フォルダーを選ぶ'}</strong>
                    <small>{folder?.path ?? '今あるフォルダーでも、新しいフォルダーでも'}</small>
                  </span>
                  {folder && <Check size={17} />}
                </button>
              </>
            )}

            {step === 'done' && (
              <>
                {heading(
                  <span className="setup-shine">
                    {replay ? '整いました。' : '準備できました。'}
                  </span>,
                  true,
                )}
                <p className="setup-lead">
                  {replay
                    ? '新しい好みは、次の返事から使われます。'
                    : 'あとは、やりたいことをそのまま書くだけ。'}
                  選んだ内容は、あとで設定から変えられます。
                </p>
                {/* What is stored now — Main's values and this PC's — never the drafts on screen. */}
                <ul className="setup-summary" data-testid="setup-summary">
                  <SummaryRow index={0} label="AI" value="確認しました" />
                  {support.assistant && (
                    <SummaryRow
                      index={1}
                      label="返事の仕方"
                      value={replySummary}
                      note={rowNote(REPLY_KEYS)}
                    />
                  )}
                  {support.team && (
                    <SummaryRow
                      index={2}
                      label="Team"
                      value={teamSummary}
                      note={rowNote(['teamMode'])}
                    />
                  )}
                  <SummaryRow
                    index={3}
                    label="細かい好み"
                    value={detailSummary}
                    note={rowNote(DETAIL_ROW)}
                  />
                  {!replay && (
                    <SummaryRow
                      index={4}
                      label="作業場所"
                      value={folder ? folder.label : 'あとで設定'}
                    />
                  )}
                </ul>{' '}
                {failedItems.size > 0 && (
                  <p className="setup-warning" role="status" data-testid="setup-save-warning">
                    保存できなかった設定があります。設定の画面から変えられます。
                  </p>
                )}
              </>
            )}

            {error && (
              <p className="setup-error" role="alert" tabIndex={-1}>
                {error}
              </p>
            )}
          </fieldset>
        </div>

        {step !== 'welcome' && (
          <footer className="setup-actions">
            <button
              type="button"
              className="setup-back"
              data-testid="setup-back"
              onClick={() => void leave('back')}
              disabled={busy}
            >
              <ArrowLeft size={15} /> 戻る
            </button>
            {/* In the footer, so it stays in view however small the window is. */}
            {step === 'done' && (
              <button
                type="button"
                className="setup-primary setup-finish"
                data-testid="setup-finish"
                onClick={() => void finish()}
                disabled={busy}
              >
                {replay ? '完了' : busy ? 'Task を準備中…' : '最初の Task を始める'}{' '}
                {replay ? <Check size={16} /> : <ArrowRight size={16} />}
              </button>
            )}
            {step !== 'done' && (
              <span className="setup-actions-forward">
                {isPreferenceStep && (
                  <button
                    type="button"
                    className="setup-skip"
                    data-testid="setup-skip"
                    onClick={() => void leave('skip')}
                    disabled={busy}
                  >
                    あとで決める
                    <small>今の設定のまま進む</small>
                  </button>
                )}
                <button
                  type="button"
                  className="setup-next"
                  data-testid="setup-next"
                  onClick={primary}
                  disabled={busy}
                >
                  {busy && isPreferenceStep
                    ? '保存中…'
                    : step === 'workspace' && folder === null
                      ? 'あとで設定'
                      : '続ける'}{' '}
                  <ArrowRight size={15} />
                </button>
              </span>
            )}
          </footer>
        )}
      </section>
    </main>
  );
}

type SummaryNote = { text: string; tone: 'changed' | 'same' | 'failed' };

/** Shown in place of choices whose stored value has not been read: never a guessed default. */
function ReadingNotice({ state, onRetry }: { state: Known; onRetry: () => void }) {
  if (state === 'failed') {
    return (
      <div className="setup-reading" role="status" data-testid="setup-reading-failed">
        <p>今の設定を読み込めませんでした。読み込めるまで、ここは選べません。</p>
        <button type="button" className="setup-secondary" onClick={onRetry}>
          もう一度読み込む
        </button>
      </div>
    );
  }
  return (
    <p className="setup-reading" role="status" data-testid="setup-reading">
      今の設定を読み込んでいます…
    </p>
  );
}

/** Names for a reply item that has to be reported without its value. */
const SUMMARY_ITEM_TITLE: Readonly<Record<string, string>> = {
  language: '返事の言語',
  confirm: '進め方',
  callName: '呼び名',
  emoji: '絵文字',
  suggestNextSteps: '次の一手の提案',
  planFirst: '作業の前に進め方を見せる',
};

function SummaryRow({
  index,
  label,
  value,
  note,
}: {
  index: number;
  label: string;
  value: string | readonly string[];
  note?: SummaryNote;
}) {
  return (
    <li style={{ '--i': index } as CSSProperties}>
      <svg className="setup-summary-check" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M3.5 8.4 6.6 11.4 12.5 4.8" pathLength={1} />
      </svg>
      <span>{label}</span>
      <span className="setup-summary-value">
        {typeof value === 'string' ? (
          <strong>{value}</strong>
        ) : (
          // Several items wrap onto as many lines as they need instead of one long run.
          <strong className="setup-summary-items">
            {value.map((item) => (
              <span key={item}>{item}</span>
            ))}
          </strong>
        )}
        {note && (
          <em className={`setup-summary-note is-${note.tone}`} data-tone={note.tone}>
            {note.text}
          </em>
        )}
      </span>
    </li>
  );
}
/** The replay form, opened from Settings: a modal over the app (so focus stays inside, and the
 * workspace underneath is untouched), closed by ×, Escape, or "完了". */
export function SetupReplayDialog({
  onClose,
  onOpenSettings,
}: {
  onClose: () => void;
  onOpenSettings: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  // While a step is being saved the replay does not close, whichever way Escape arrives.
  const busy = useRef(false);
  const onBusyChange = useCallback((value: boolean) => {
    busy.current = value;
  }, []);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
    // The dialog's own first focus would land on ×: the heading is where the Setup begins.
    dialog.querySelector<HTMLElement>('#setup-title')?.focus({ preventScroll: true });
    return () => {
      if (typeof dialog.close === 'function' && dialog.open) dialog.close();
    };
  }, []);
  return (
    <dialog
      ref={dialogRef}
      className="setup-replay-dialog"
      data-testid="setup-replay-dialog"
      aria-labelledby="setup-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy.current) onClose();
      }}
      // The browser can close the dialog whatever `cancel` did (Chromium does on a second Escape
      // in a row with nothing pressed in between). Follow it, so the app never keeps a closed
      // replay mounted and "セットアップをもう一度" switched off.
      onClose={onClose}
    >
      <SetupWizard
        mode="replay"
        onOpenSettings={onOpenSettings}
        onClose={onClose}
        onBusyChange={onBusyChange}
      />
    </dialog>
  );
}
