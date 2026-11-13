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
  type SetupSaveOutcome,
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
import { SetupSky, type SkyTheme } from '../lib/setup-sky';
import type { CueName } from 'uisfx';
import { ArrowLeft, ArrowRight, Check, Folder, Settings, X } from './icons';
import { SetupConfetti, SetupStage } from './SetupAnimation';
import { SetupChoiceGroup, SetupSwitch, SetupTeamCards } from './SetupControls';

type PickedFolder = { path: string; label: string };
type Readiness = 'ready' | 'authentication_required' | 'unavailable';
type PreferenceStep = 'reply' | 'team' | 'details';
/** What happened to a preference step: chosen and stored, or left as it was. */
type Decision = 'saved' | 'skipped';

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

/** The fields each step owns, to tell whether leaving by "戻る" changed anything. */
function replyFields(p: AssistantPreferences): string {
  return `${p.tone}|${p.length}|${p.depth}`;
}
function detailFields(p: AssistantPreferences): string {
  return `${p.language}|${p.confirm}|${p.callName.trim()}|${p.emoji}|${p.suggestNextSteps}|${p.planFirst}`;
}

export function SetupWizard({
  mode = 'first-run',
  onOpenSettings,
  onClose,
}: {
  mode?: SetupMode;
  onOpenSettings: () => void;
  /** Replay only: the × button, Escape, and the final "完了". */
  onClose?: () => void;
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

  // Drafts on screen, and the values last stored (what "戻る" compares against and "あとで決める"
  // returns to).
  const [preferences, setPreferences] = useState<AssistantPreferences>(
    DEFAULT_ASSISTANT_PREFERENCES,
  );
  const [teamMode, setTeamMode] = useState<TeamUsageMode>(DEFAULT_TEAM_USAGE_MODE);
  const [soundEnabled, setSoundEnabled] = useState(() => readSoundEffectPreferences().enabled);
  const [accessDefault, setAccessDefault] = useState<AccessPresetDefault>(readAccessPresetDefault);
  const stored = useRef({
    preferences: DEFAULT_ASSISTANT_PREFERENCES,
    teamMode: DEFAULT_TEAM_USAGE_MODE as TeamUsageMode,
    soundEnabled,
    accessDefault,
  });
  const touched = useRef({ preferences: false, team: false });
  const [decisions, setDecisions] = useState<Partial<Record<PreferenceStep, Decision>>>({});
  const [failed, setFailed] = useState<ReadonlySet<'assistant' | 'team'>>(() => new Set());

  const [folder, setFolder] = useState<PickedFolder | null>(null);
  const [projectId, setProjectId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Start from what is stored, so a replay opens with the current choices selected. A choice made
  // before the answer arrives wins over it.
  useEffect(() => {
    let live = true;
    if (support.assistant) {
      void loadAssistantPreferences().then((state) => {
        if (!live) return;
        stored.current.preferences = state.preferences;
        if (!touched.current.preferences) setPreferences(state.preferences);
      });
    }
    if (support.team) {
      void loadTeamUsageMode().then((value) => {
        if (!live) return;
        stored.current.teamMode = value;
        if (!touched.current.team) setTeamMode(value);
      });
    }
    return () => {
      live = false;
    };
  }, [support]);

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [step]);

  const updatePreferences = useCallback((patch: Partial<AssistantPreferences>) => {
    touched.current.preferences = true;
    setPreferences((current) => ({ ...current, ...patch }));
  }, []);

  // ---------- The living background ----------
  const rootRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const skyRef = useRef<SetupSky | null>(null);
  const lastPress = useRef<{ x: number; y: number; at: number } | null>(null);
  // The opening plays once per Setup, with motion only; any click or key ends it at once.
  const [intro, setIntro] = useState<'playing' | 'done'>(() => (animate ? 'playing' : 'done'));
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
  }, [preferences, step, teamMode]);

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
    (cue: CueName) => {
      playInterfaceCue(cue);
      const point = choicePoint();
      skyRef.current?.ripple(point.x, point.y);
      setBurst((current) => current + 1);
    },
    [choicePoint],
  );

  const chooseTeamMode = useCallback(
    (value: TeamUsageMode) => {
      touched.current.team = true;
      setTeamMode(value);
      respond('select');
    },
    [respond],
  );

  const noteOutcome = useCallback((key: 'assistant' | 'team', outcome: SetupSaveOutcome) => {
    if (outcome === 'unsupported') return;
    setFailed((current) => {
      const next = new Set(current);
      if (outcome === 'failed') next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const persist = useCallback(
    async (id: PreferenceStep): Promise<void> => {
      if (id === 'reply' || id === 'details') {
        if (id === 'details') {
          writeAccessPresetDefault(accessDefault);
          stored.current.accessDefault = accessDefault;
          if (soundEnabled !== readSoundEffectPreferences().enabled) {
            setSoundEffectsEnabled(soundEnabled);
          }
          stored.current.soundEnabled = soundEnabled;
          if (soundEnabled) void unlockSoundEffects();
        }
        if (support.assistant) {
          const snapshot = { ...preferences, callName: clampCallName(preferences.callName.trim()) };
          const result = await saveAssistantPreferences(snapshot);
          noteOutcome('assistant', result.outcome);
          if (result.outcome === 'saved' && result.preferences) {
            const saved = result.preferences;
            stored.current.preferences = saved;
            // Main cleans the call name; show what it kept.
            setPreferences((current) => ({ ...current, callName: saved.callName }));
          }
        }
      } else {
        const outcome = await saveTeamUsageMode(teamMode);
        noteOutcome('team', outcome);
        if (outcome === 'saved') stored.current.teamMode = teamMode;
      }
      setDecisions((current) => ({ ...current, [id]: 'saved' }));
    },
    [accessDefault, noteOutcome, preferences, soundEnabled, support.assistant, teamMode],
  );

  const changedSinceStored = useCallback(
    (id: PreferenceStep): boolean => {
      const saved = stored.current;
      if (id === 'reply') return replyFields(preferences) !== replyFields(saved.preferences);
      if (id === 'team') return teamMode !== saved.teamMode;
      return (
        detailFields(preferences) !== detailFields(saved.preferences) ||
        soundEnabled !== saved.soundEnabled ||
        accessDefault !== saved.accessDefault
      );
    },
    [accessDefault, preferences, soundEnabled, teamMode],
  );

  /** "あとで決める": nothing is stored, and the step's draft returns to what is stored. */
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
    setDecisions((current) =>
      current[id] === 'saved' ? current : { ...current, [id]: 'skipped' },
    );
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

  const leave = useCallback(
    async (how: 'continue' | 'skip' | 'back') => {
      if (busy) return;
      if (SETUP_PREFERENCE_STEPS.has(step)) {
        const id = step as PreferenceStep;
        if (how === 'skip') revert(id);
        else if (how === 'continue' || changedSinceStored(id)) {
          setBusy(true);
          try {
            await persist(id);
          } finally {
            setBusy(false);
          }
        }
      }
      playInterfaceCue(how === 'back' ? 'back' : 'forward');
      moveTo(how === 'back' ? index - 1 : index + 1);
    },
    [busy, changedSinceStored, index, moveTo, persist, revert, step],
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

  const continueFromWorkspace = useCallback(async () => {
    if (folder === null) {
      moveTo(index + 1);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const project = await createProject(folder.label, [
        { path: folder.path, label: folder.label, role: 'primary' },
      ]);
      if (project === null) {
        setError('作業場所を登録できませんでした。フォルダーを確かめて、もう一度お試しください。');
        return;
      }
      setProjectId(project.id);
      playInterfaceCue('forward');
      moveTo(index + 1);
    } finally {
      setBusy(false);
    }
  }, [createProject, folder, index, moveTo]);

  const finish = useCallback(async () => {
    if (replay) {
      playInterfaceCue('success');
      onClose?.();
      return;
    }
    setBusy(true);
    setError(null);
    // The stage is drawn into the app: everything rushes inwards while the Task is made, and the
    // app's own entrance (Sidebar, then Chat) picks up from there.
    playInterfaceCue('success');
    setLeaving(true);
    skyRef.current?.implode();
    try {
      // The Setup disappears the moment the first Task exists, so the hand-off plays first.
      if (animate) await new Promise((resolve) => window.setTimeout(resolve, LEAVE_MS));
      const task = await createTask(projectId);
      if (task === null) {
        setLeaving(false);
        setError('最初の Task を作れませんでした。もう一度お試しください。');
        return;
      }
      writeSetupComplete();
    } finally {
      setBusy(false);
    }
  }, [animate, createTask, onClose, projectId, replay]);

  // Celebrate on arrival, once.
  useEffect(() => {
    if (step !== 'done') return;
    playInterfaceCue('reward');
    skyRef.current?.celebrate();
  }, [step]);

  const primary = useCallback(() => {
    if (step === 'welcome') {
      if (intro === 'playing') endIntro();
      playInterfaceCue('start');
      moveTo(index + 1);
    } else if (step === 'workspace') void continueFromWorkspace();
    else if (step === 'done') void finish();
    else void leave('continue');
  }, [continueFromWorkspace, endIntro, finish, index, intro, leave, moveTo, step]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.key === 'Escape' && replay && onClose) {
        event.preventDefault();
        onClose();
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
  const position = index + 1;
  const remaining = steps.length - position;
  const isPreferenceStep = SETUP_PREFERENCE_STEPS.has(step);
  const leftAs = replay ? '今のまま' : 'おすすめのまま';

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
      style={palette}
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

      <div className="setup-visual">
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
            >
              <X size={16} />
            </button>
          )}
        </header>

        <div className="setup-scroll">
          <div
            key={step}
            className={`setup-step setup-step--${direction}`}
            data-testid={`setup-step-${step}`}
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
                <button type="button" className="setup-secondary" onClick={onOpenSettings}>
                  <Settings size={15} /> 接続を設定
                </button>
              </>
            )}

            {step === 'reply' && (
              <>
                {heading('返事の仕方を選ぶ')}
                <p className="setup-lead">選ぶたびに、左の見本がその場で書き変わります。</p>
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
              </>
            )}

            {step === 'team' && (
              <>
                {heading('Team の使い方')}
                <p className="setup-lead">
                  大きな作業は、AI が仲間を呼んで手分けできます。どのくらい頼るかを選びましょう。
                </p>
                <SetupTeamCards
                  options={TEAM_USAGE_OPTIONS}
                  value={teamMode}
                  onChange={chooseTeamMode}
                  animate={animate}
                />
                <p className="setup-note">{TEAM_USAGE_COST_NOTE}</p>
              </>
            )}

            {step === 'details' && (
              <>
                {heading('細かい好み')}
                <p className="setup-lead">気になる所だけ変えれば大丈夫です。</p>
                <div className="setup-detail-grid">
                  {support.assistant && (
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
                  {support.assistant && (
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
                        respond(enabled ? 'check' : 'uncheck');
                      }}
                    />
                    <SetupChoiceGroup
                      legend="新しいタスクの安全設定"
                      options={ACCESS_OPTIONS}
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
                <ul className="setup-summary" data-testid="setup-summary">
                  <SummaryRow index={0} label="AI" value="確認しました" />
                  {support.assistant && (
                    <SummaryRow
                      index={1}
                      label="返事の仕方"
                      value={
                        decisions.reply === 'saved'
                          ? `${optionLabel(TONE_OPTIONS, preferences.tone)}・${optionLabel(LENGTH_OPTIONS, preferences.length)}・${optionLabel(DEPTH_OPTIONS, preferences.depth)}`
                          : leftAs
                      }
                    />
                  )}
                  {support.team && (
                    <SummaryRow
                      index={2}
                      label="Team"
                      value={
                        decisions.team === 'saved'
                          ? optionLabel(TEAM_USAGE_OPTIONS, teamMode)
                          : leftAs
                      }
                    />
                  )}
                  <SummaryRow
                    index={3}
                    label="細かい好み"
                    value={
                      decisions.details === 'saved'
                        ? [
                            support.assistant
                              ? optionLabel(LANGUAGE_OPTIONS, preferences.language)
                              : null,
                            support.assistant && preferences.callName.trim()
                              ? `呼び名「${preferences.callName.trim()}」`
                              : null,
                            soundEnabled ? '効果音あり' : '効果音なし',
                            accessLabel,
                          ]
                            .filter(Boolean)
                            .join('・')
                        : leftAs
                    }
                  />
                  {!replay && (
                    <SummaryRow
                      index={4}
                      label="作業場所"
                      value={projectId && folder ? folder.label : 'あとで設定'}
                    />
                  )}
                </ul>
                {failed.size > 0 && (
                  <p className="setup-warning" role="status" data-testid="setup-save-warning">
                    保存できなかった設定があります。設定の画面から変えられます。
                  </p>
                )}
              </>
            )}

            {error && (
              <p className="setup-error" role="alert">
                {error}
              </p>
            )}
          </div>
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
                    {replay ? '今のままにする' : 'あとで決める'}
                    <small>{replay ? '変えずに進む' : 'おすすめの設定で進む'}</small>
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

function SummaryRow({ index, label, value }: { index: number; label: string; value: string }) {
  return (
    <li style={{ '--i': index } as CSSProperties}>
      <svg className="setup-summary-check" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M3.5 8.4 6.6 11.4 12.5 4.8" pathLength={1} />
      </svg>
      <span>{label}</span>
      <strong>{value}</strong>
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
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
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
        onClose();
      }}
    >
      <SetupWizard mode="replay" onOpenSettings={onOpenSettings} onClose={onClose} />
    </dialog>
  );
}
