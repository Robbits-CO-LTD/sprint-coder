import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import type { SetupStepId } from '../lib/setup-flow';
import { useRetype, usePhaseCycle } from '../lib/setup-motion';
import { SETUP_PREVIEW_QUESTION, setupPreviewReply } from '../lib/setup-preview';
import {
  CONFIRM_OPTIONS,
  DEPTH_OPTIONS,
  LENGTH_OPTIONS,
  TONE_OPTIONS,
  optionLabel,
} from '../lib/setup-options';
import type { AssistantPreferences, TeamUsageMode } from '../lib/setup-settings';

// The left half of the Setup — the stage. One scene per step, drawn with HTML, SVG and CSS keyframes
// (transform and opacity only), over a slowly turning light whose colours follow the step. Scenes
// that tell a story in phases use `usePhaseCycle`, which owns a single timer; everything else is
// CSS that the reduced-motion rules switch off. With motion reduced, each scene shows its finished
// picture, so nothing it says is lost.

type Readiness = 'ready' | 'authentication_required' | 'unavailable';
type Who = 'leader' | 'worker-1' | 'worker-2' | 'worker-3';

export type SetupStageProps = {
  step: SetupStepId;
  animate: boolean;
  /** Bumped on every choice; each new value sets off one burst of sparks on the stage. */
  burst: number;
  /** The opening is still running: the welcome scene waits for its cue. */
  introPlaying: boolean;
  preferences: AssistantPreferences;
  assistantSupported: boolean;
  teamMode: TeamUsageMode;
  soundEnabled: boolean;
  accessLabel: string;
  runtime: { codex: Readiness; claude: Readiness; grok: Readiness };
  folderLabel: string | null;
};

export function SetupStage(props: SetupStageProps) {
  return (
    <>
      <span className="setup-aurora" aria-hidden="true" />
      <span className="setup-bloom" aria-hidden="true" />
      <div className="setup-stage" data-step={props.step}>
        <div key={props.step} className="setup-scene">
          {sceneFor(props)}
        </div>
        {props.animate && props.burst > 0 && <SetupBurst key={props.burst} />}
      </div>
    </>
  );
}

function sceneFor(props: SetupStageProps): ReactNode {
  switch (props.step) {
    case 'welcome':
      return <WelcomeScene animate={props.animate} held={props.introPlaying} />;
    case 'ai':
      return <ScanScene runtime={props.runtime} />;
    case 'reply':
      return <ReplyScene preferences={props.preferences} animate={props.animate} />;
    case 'team':
      return <TeamScene mode={props.teamMode} animate={props.animate} />;
    case 'details':
      return <DetailsScene {...props} />;
    case 'workspace':
      return <WorkspaceScene folderLabel={props.folderLabel} />;
    case 'done':
      return <DoneScene />;
  }
}

/** Sparks thrown out from the middle of the stage when something is chosen. One-shot. */
function SetupBurst() {
  return (
    <span className="setup-burst" aria-hidden="true">
      {Array.from({ length: 14 }, (_, index) => (
        <i
          key={index}
          style={
            {
              '--a': `${index * (360 / 14) + (index % 2) * 9}deg`,
              '--len': `${120 + ((index * 41) % 90)}px`,
              '--c': BURST_COLORS[index % BURST_COLORS.length],
            } as CSSProperties
          }
        />
      ))}
    </span>
  );
}

const BURST_COLORS = ['var(--accent)', 'var(--ai-accent)', 'var(--success)', 'var(--warning)'];

function Pointer({ who }: { who: Who }) {
  return (
    <svg viewBox="0 0 8 11" aria-hidden="true">
      <path
        d="M0.5 0.5 L0.5 9.5 L2.9 7.3 L4.5 10.6 L6 10 L4.4 6.6 L7.5 6.6 Z"
        style={{ fill: `var(--setup-${who})` }}
      />
    </svg>
  );
}

// ---------- ようこそ: a request is typed, code pours out, and the team's cursors dive in ----------

const WELCOME_STORIES = [
  { request: 'ログイン画面を作って', result: 'login' },
  { request: '売上のグラフを見やすくして', result: 'chart' },
  { request: '動かない所を直して', result: 'fixed' },
] as const;

/** When the window's typing starts during the opening (ms after it began). */
const WELCOME_CUE_MS = 1900;

/** typing → code → team → result. */
const WELCOME_PHASES = [800, 650, 2600, 2400] as const;

const CODE_LINES: readonly (readonly number[])[] = [
  [16, 30],
  [8, 20, 26],
  [8, 12, 34],
  [16, 22, 12],
  [8, 28],
  [8, 14, 20],
  [16, 26],
  [8, 18, 22],
  [16, 12],
];

/** Where each cursor comes from (off the window) and where it lands, in % of the window's width. */
const WELCOME_CURSORS: readonly { who: Who; from: [number, number]; to: [number, number] }[] = [
  { who: 'leader', from: [104, 92], to: [30, 30] },
  { who: 'worker-1', from: [-16, 64], to: [60, 41] },
  { who: 'worker-2', from: [74, -14], to: [20, 53] },
  { who: 'worker-3', from: [112, 30], to: [48, 64] },
];

function WelcomeScene({ animate, held }: { animate: boolean; held: boolean }) {
  // During the opening the window arrives empty and the typing starts on its cue (or at once, if the
  // opening is skipped).
  const [cued, setCued] = useState(false);
  useEffect(() => {
    if (!held) return;
    const timer = window.setTimeout(() => setCued(true), WELCOME_CUE_MS);
    return () => window.clearTimeout(timer);
  }, [held]);
  const running = animate && (!held || cued);
  const { phase, cycle } = usePhaseCycle(WELCOME_PHASES, running);
  const story = WELCOME_STORIES[cycle % WELCOME_STORIES.length]!;
  const typedNow = useRetype(running ? story.request : '', animate);
  const typed = animate ? typedNow : story.request;
  const typing = typed !== story.request;
  return (
    <div className="sw" data-phase={animate && !running ? 0 : phase}>
      <span className="sw-ghost sw-ghost--a" />
      <span className="sw-ghost sw-ghost--b" />
      <div className="sw-window">
        <div className="sw-bar">
          <i />
          <i />
          <i />
        </div>
        <div className="sw-prompt">
          <span className="sw-you">あなた</span>
          <span className="sw-typed">
            {typed}
            <i className={`sw-caret${typing ? ' is-typing' : ''}`} />
          </span>
        </div>
        <div className="sw-code">
          {CODE_LINES.map((tokens, line) => (
            <span key={line} className="sw-line" style={{ '--i': line } as CSSProperties}>
              {tokens.map((width, token) => (
                <i key={token} style={{ width: `${width}%` }} data-t={(line + token) % 4} />
              ))}
            </span>
          ))}
        </div>
        {WELCOME_CURSORS.map((cursor, index) => (
          <span
            key={cursor.who}
            className="sw-cursor"
            style={
              {
                '--x0': `${cursor.from[0]}cqw`,
                '--y0': `${cursor.from[1]}cqw`,
                '--x1': `${cursor.to[0]}cqw`,
                '--y1': `${cursor.to[1]}cqw`,
                '--k': index,
              } as CSSProperties
            }
          >
            <i className="sw-spark" />
            <Pointer who={cursor.who} />
            <b style={{ background: `var(--setup-${cursor.who})` }}>
              {index === 0 ? 'AI' : '仲間'}
            </b>
          </span>
        ))}
      </div>
      <div className={`sw-result sw-result--${story.result}`}>
        <span className="sw-result-tag">できあがり</span>
        {story.result === 'login' && (
          <span className="sw-login">
            <i />
            <i />
            <b />
          </span>
        )}
        {story.result === 'chart' && (
          <span className="sw-chart">
            {[46, 72, 58, 90, 66].map((height, index) => (
              <i key={index} style={{ '--h': `${height}%`, '--i': index } as CSSProperties} />
            ))}
          </span>
        )}
        {story.result === 'fixed' && (
          <span className="sw-fixed">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5 12.5 10 17 19 7.5" pathLength={1} />
            </svg>
          </span>
        )}
      </div>
    </div>
  );
}

// ---------- AI: looking around this computer for AIs ----------

const AI_NODES = [
  { key: 'codex', label: 'Codex' },
  { key: 'claude', label: 'Claude Code' },
  { key: 'grok', label: 'Grok' },
] as const;

function ScanScene({ runtime }: { runtime: SetupStageProps['runtime'] }) {
  return (
    <div className="ss">
      <span className="ss-ring ss-ring--1" />
      <span className="ss-ring ss-ring--2" />
      <span className="ss-sweep" />
      <span className="ss-core">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3.5" y="4.5" width="17" height="11.5" rx="2" />
          <path d="M8.5 19.5h7M12 16v3.5" />
        </svg>
      </span>
      {AI_NODES.map((node, index) => (
        <span
          key={node.key}
          className={`ss-node ss-node--${runtime[node.key]}`}
          style={{ '--i': index } as CSSProperties}
        >
          <i />
          <b>{node.label}</b>
        </span>
      ))}
    </div>
  );
}

// ---------- 返事の仕方: the sample reply, retyped as the choices change ----------

function ReplyScene({
  preferences,
  animate,
}: {
  preferences: AssistantPreferences;
  animate: boolean;
}) {
  const reply = setupPreviewReply(preferences);
  const typed = useRetype(reply, animate);
  const typing = typed !== reply;
  const chips = [
    optionLabel(TONE_OPTIONS, preferences.tone),
    optionLabel(LENGTH_OPTIONS, preferences.length),
    optionLabel(DEPTH_OPTIONS, preferences.depth),
  ];
  return (
    <div className="sr">
      <p className="sr-title">返事の見本</p>
      <div className="sr-chat">
        <p className="sr-bubble sr-bubble--you">{SETUP_PREVIEW_QUESTION}</p>
        <div className="sr-answer">
          <span className="sr-avatar" aria-hidden="true">
            <i />
          </span>
          <p className="sr-bubble sr-bubble--ai" data-testid="setup-preview-reply">
            <span aria-hidden="true">
              {typed}
              <i className={`sr-caret${typing ? ' is-typing' : ''}`} />
            </span>
            {/* Read once, whole, instead of character by character. */}
            <span className="setup-visually-hidden" aria-live="polite">
              {reply}
            </span>
          </p>
        </div>
      </div>
      <p className="sr-chips" aria-hidden="true">
        {chips.map((chip) => (
          <span key={chip}>{chip}</span>
        ))}
      </p>
    </div>
  );
}

// ---------- Team: cursors actually working through a board ----------

/** One full loop of the board, in ms. */
const TEAM_CYCLE = [5200] as const;

type TeamRun = {
  label: string;
  who: Who;
  /** Start and length as a fraction of the loop. */
  start: number;
  length: number;
  /** Arrives part-way through, flying in. */
  join?: boolean;
};

const TEAM_RUNS: Readonly<Record<TeamUsageMode, readonly TeamRun[]>> = {
  // One AI, one job after another.
  explicit: [
    { label: '作業 1', who: 'leader', start: 0.04, length: 0.24 },
    { label: '作業 2', who: 'leader', start: 0.32, length: 0.24 },
    { label: '作業 3', who: 'leader', start: 0.6, length: 0.24 },
  ],
  // Small things alone; when a big job lands, teammates dive in and split it.
  auto: [
    { label: '小さな作業', who: 'leader', start: 0.04, length: 0.18 },
    { label: '大きな作業', who: 'leader', start: 0.36, length: 0.42 },
    { label: '', who: 'worker-1', start: 0.42, length: 0.36, join: true },
    { label: '', who: 'worker-2', start: 0.47, length: 0.31, join: true },
  ],
  // Everyone from the start, side by side.
  proactive: [
    { label: '作業 1', who: 'leader', start: 0.04, length: 0.42 },
    { label: '作業 2', who: 'worker-1', start: 0.05, length: 0.36 },
    { label: '作業 3', who: 'worker-2', start: 0.06, length: 0.46 },
    { label: '作業 4', who: 'worker-3', start: 0.07, length: 0.39 },
  ],
};

const TEAM_CAPTION: Readonly<Record<TeamUsageMode, string>> = {
  explicit: 'AI が 1 人で、順番に片付けます',
  auto: '小さな作業は 1 人で。大きな作業には仲間が飛び込みます',
  proactive: '最初から、みんなで並んで進めます',
};

const ms = (fraction: number) => `${Math.round(fraction * TEAM_CYCLE[0])}ms`;

function TeamScene({ mode, animate }: { mode: TeamUsageMode; animate: boolean }) {
  const { cycle } = usePhaseCycle(TEAM_CYCLE, animate);
  const runs = TEAM_RUNS[mode];
  return (
    <div className="st" data-mode={mode}>
      <span className="st-ghost" />
      <div className="st-board" key={`${mode}-${cycle}`}>
        {mode === 'auto' && (
          <span className="st-big" style={{ '--at': ms(0.3) } as CSSProperties}>
            大きな作業が来た！
          </span>
        )}
        {runs.map((run, index) => (
          <div
            key={index}
            className={`st-row${run.join ? ' is-join' : ''}${mode === 'auto' && index > 0 ? ' is-big' : ''}`}
            style={
              {
                '--start': ms(run.start),
                '--len': ms(run.length),
                '--c': `var(--setup-${run.who})`,
              } as CSSProperties
            }
          >
            <span className="st-label">{run.label}</span>
            <span className="st-track">
              <span className="st-fill">
                <span className="st-cursor">
                  <Pointer who={run.who} />
                  <b>{run.who === 'leader' ? 'AI' : '仲間'}</b>
                </span>
              </span>
            </span>
            <span className="st-done">
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M3.5 8.4 6.6 11.4 12.5 4.8" />
              </svg>
            </span>
          </div>
        ))}
      </div>
      <p className="st-caption" key={`caption-${mode}`}>
        {TEAM_CAPTION[mode]}
      </p>
    </div>
  );
}

// ---------- 細かい好み: a card that becomes "your" AI as the choices change ----------

function greetingFor(preferences: AssistantPreferences, assistantSupported: boolean): string {
  if (!assistantSupported) return 'こんにちは。今日も一緒に進めましょう。';
  const name = preferences.callName.trim();
  const english = preferences.language === 'en';
  let text: string;
  if (english) {
    const lead = name ? `Hi ${name}! ` : 'Hi! ';
    text =
      preferences.tone === 'crisp'
        ? `${lead}Ready when you are.`
        : `${lead}Let's build something great today.`;
  } else {
    const lead = name ? `${name}さん、` : '';
    text =
      preferences.tone === 'casual'
        ? `${lead}やあ！今日もいっしょにやろう。`
        : preferences.tone === 'crisp'
          ? `${lead}準備できています。始めましょう。`
          : `${lead}こんにちは。今日も一緒に進めましょう。`;
  }
  return preferences.emoji ? `${text} ✨` : text;
}

function DetailsScene({
  preferences,
  assistantSupported,
  soundEnabled,
  accessLabel,
}: SetupStageProps) {
  const greeting = greetingFor(preferences, assistantSupported);
  const initial = Array.from(preferences.callName.trim())[0] ?? '';
  const chips: string[] = [];
  if (assistantSupported) {
    chips.push(optionLabel(CONFIRM_OPTIONS, preferences.confirm));
    if (preferences.planFirst) chips.push('先に進め方を見せる');
    if (preferences.suggestNextSteps) chips.push('次の一手を提案');
  }
  chips.push(soundEnabled ? '効果音あり' : '効果音なし');
  chips.push(accessLabel);
  return (
    <div className="sd">
      <div className="sd-card">
        <span className="sd-avatar" aria-hidden="true">
          {initial ? <b key={initial}>{initial}</b> : <i />}
        </span>
        <p className="sd-greeting" key={greeting}>
          {greeting}
        </p>
        <p className="sd-chips">
          {chips.map((chip) => (
            <span key={chip}>{chip}</span>
          ))}
        </p>
        <span className={`sd-sound${soundEnabled ? ' is-on' : ''}`} aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </span>
      </div>
    </div>
  );
}

// ---------- 作業場所 ----------

function WorkspaceScene({ folderLabel }: { folderLabel: string | null }) {
  return (
    <div className={`sf${folderLabel ? ' is-picked' : ''}`}>
      <span className="sf-folder">
        <span className="sf-back" />
        <span className="sf-files">
          {[0, 1, 2].map((index) => (
            <i key={index} style={{ '--i': index } as CSSProperties} />
          ))}
        </span>
        <span className="sf-front" />
      </span>
      <p className="sf-label">{folderLabel ?? 'まだ選んでいません'}</p>
    </div>
  );
}

// ---------- 完了 ----------

function DoneScene() {
  return (
    <div className="sk">
      <span className="sk-rays" />
      <span className="sk-wave sk-wave--1" />
      <span className="sk-wave sk-wave--2" />
      <span className="sk-wave sk-wave--3" />
      <span className="sk-ring">
        <svg viewBox="0 0 64 64" aria-hidden="true">
          <circle cx="32" cy="32" r="29" pathLength={1} />
          <path d="M19 33.5 28 42 45.5 23" pathLength={1} />
        </svg>
      </span>
    </div>
  );
}

// ---------- Confetti (done step only, motion allowed only) ----------

const CONFETTI_COLORS = [
  'var(--accent)',
  'var(--ai-accent)',
  'var(--success)',
  'var(--warning)',
  'var(--setup-worker-2)',
  'var(--info)',
];

/** Deterministic, so a snapshot of the page is stable; varied enough to look scattered. */
function confettiPiece(index: number): CSSProperties {
  const angle = (index * 137.508 * Math.PI) / 180;
  const reach = 140 + ((index * 53) % 170);
  return {
    '--dx': `${Math.round(Math.cos(angle) * reach)}px`,
    '--dy': `${Math.round(Math.sin(angle) * reach * 0.75 - 90)}px`,
    '--r': `${(index * 71) % 360}deg`,
    '--d': `${(index % 7) * 28}ms`,
    '--c': CONFETTI_COLORS[index % CONFETTI_COLORS.length],
  } as CSSProperties;
}

export function SetupConfetti() {
  return (
    <div className="setup-confetti" aria-hidden="true" data-testid="setup-confetti">
      {Array.from({ length: 44 }, (_, index) => (
        <i key={index} className={index % 3 === 0 ? 'is-round' : ''} style={confettiPiece(index)} />
      ))}
    </div>
  );
}
