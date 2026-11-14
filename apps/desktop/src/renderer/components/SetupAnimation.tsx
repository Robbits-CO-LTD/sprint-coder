import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useLogoGlyph } from '../lib/logo-glyph';
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
import { SetupTeamField } from '../lib/setup-team-field';

// The Setup's stage: one picture per step, in the logo film's own language — lanes of light in
// the logo's three colours that fan out and come together. Drawn with HTML, SVG and CSS keyframes
// (transform and opacity only); the Team step's field of runners is a small canvas
// (lib/setup-team-field.ts). Scenes that tell a story in phases use `usePhaseCycle`, which owns a
// single timer; everything else is CSS that the reduced-motion rules switch off. With motion
// reduced, each scene shows its finished picture, so nothing it says is lost. The whole stage is
// decoration (aria-hidden by its parent): everything it shows is also said among the choices.

type Readiness = 'ready' | 'authentication_required' | 'unavailable';

export type SetupStageProps = {
  step: SetupStepId;
  animate: boolean;
  /** Bumped on every choice; each new value sets off one pulse of light on the stage. */
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
    <div className="setup-stage" data-step={props.step}>
      <div key={props.step} className="setup-scene">
        {sceneFor(props)}
      </div>
      {props.animate && props.burst > 0 && <SetupBurst key={props.burst} />}
    </div>
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

/** A pulse of light across the stage when something is chosen: three streaks, left to right, in
 * the logo's colours. One-shot. */
function SetupBurst() {
  return (
    <span className="setup-burst" aria-hidden="true">
      {[0, 1, 2].map((index) => (
        <i key={index} style={{ '--k': index } as CSSProperties} />
      ))}
    </span>
  );
}

/** The five rows a fan of lanes spreads over, in % of the scene's height. */
const FAN_ROWS = [16, 33, 50, 67, 84] as const;

// ---------- ようこそ: one request fans out to a team, and comes back as one result ----------

const WELCOME_STORIES = [
  { request: 'ログイン画面を作って', result: 'login' },
  { request: '売上のグラフを見やすくして', result: 'chart' },
  { request: '動かない所を直して', result: 'fixed' },
] as const;

/** When the typing starts during the opening (ms after it began). */
const WELCOME_CUE_MS = 1900;

/** typing → the request fans out → the team works → the result. */
const WELCOME_PHASES = [900, 700, 2400, 2600] as const;

const WELCOME_TEAM = ['仲間', '仲間', 'AI', '仲間', '仲間'] as const;

function WelcomeScene({ animate, held }: { animate: boolean; held: boolean }) {
  // During the opening the scene arrives empty and the typing starts on its cue (or at once, if the
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
    <div className="setup-sw" data-phase={animate && !running ? 0 : phase}>
      <svg className="setup-sw-flow" viewBox="0 0 100 100" preserveAspectRatio="none">
        {FAN_ROWS.map((y, k) => (
          <g key={y} data-tone={k < 2 ? 0 : k === 2 ? 1 : 2} style={{ '--k': k } as CSSProperties}>
            <path className="setup-sw-out" d={`M34 50C40 50 38 ${y} 44 ${y}`} pathLength={1} />
            <path className="setup-sw-in" d={`M66 ${y}C72 ${y} 70 50 76 50`} pathLength={1} />
          </g>
        ))}
      </svg>
      <div className="setup-sw-ask">
        <span className="setup-sw-tag">あなたの言葉</span>
        <span className="setup-sw-typed">
          {typed}
          <i className={`setup-sw-caret${typing ? ' is-typing' : ''}`} />
        </span>
      </div>
      <ul className="setup-sw-team">
        {WELCOME_TEAM.map((who, k) => (
          <li
            key={k}
            data-tone={k < 2 ? 0 : k === 2 ? 1 : 2}
            style={{ '--k': k, '--y': `${FAN_ROWS[k]}%` } as CSSProperties}
          >
            <b>{who}</b>
            <span className="setup-sw-bar">
              <i />
            </span>
          </li>
        ))}
      </ul>
      <div className={`setup-sw-result setup-sw-result--${story.result}`}>
        <span className="setup-sw-tag">できあがり</span>
        {story.result === 'login' && (
          <span className="setup-sw-login">
            <i />
            <i />
            <b />
          </span>
        )}
        {story.result === 'chart' && (
          <span className="setup-sw-chart">
            {[46, 72, 58, 90, 66].map((height, index) => (
              <i key={index} style={{ '--h': `${height}%`, '--i': index } as CSSProperties} />
            ))}
          </span>
        )}
        {story.result === 'fixed' && (
          <span className="setup-sw-fixed">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5 12.5 10 17 19 7.5" pathLength={1} />
            </svg>
          </span>
        )}
      </div>
    </div>
  );
}

// ---------- AI: the AIs on this computer, as the logo's three nodes joining into one ----------

const AI_NODES = [
  { key: 'codex', label: 'Codex', y: 20 },
  { key: 'claude', label: 'Claude Code', y: 50 },
  { key: 'grok', label: 'Grok', y: 80 },
] as const;

function ScanScene({ runtime }: { runtime: SetupStageProps['runtime'] }) {
  return (
    <div className="setup-ss">
      <svg className="setup-ss-flow" viewBox="0 0 100 100" preserveAspectRatio="none">
        {AI_NODES.map((node, index) => (
          <g
            key={node.key}
            className={`setup-ss-lane setup-ss-lane--${runtime[node.key]}`}
            data-tone={index}
            style={{ '--i': index } as CSSProperties}
          >
            <path d={`M30 ${node.y}C52 ${node.y} 48 50 70 50`} pathLength={1} />
            <path
              className="setup-ss-glint"
              d={`M30 ${node.y}C52 ${node.y} 48 50 70 50`}
              pathLength={1}
            />
          </g>
        ))}
      </svg>
      {AI_NODES.map((node, index) => (
        <span
          key={node.key}
          className={`setup-ss-node setup-ss-node--${runtime[node.key]}`}
          data-tone={index}
          style={{ '--i': index, '--y': `${node.y}%` } as CSSProperties}
        >
          <i>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              {runtime[node.key] === 'ready' && <path d="M3.6 8.4 6.7 11.3 12.4 4.9" />}
              {runtime[node.key] === 'authentication_required' && <path d="M8 3.6v5.6M8 11.9v.4" />}
              {runtime[node.key] === 'unavailable' && <path d="M4.6 8h6.8" />}
            </svg>
          </i>
          <b>{node.label}</b>
        </span>
      ))}
      <span className="setup-ss-core">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3.5" y="4.5" width="17" height="11.5" rx="2" />
          <path d="M8.5 19.5h7M12 16v3.5" />
        </svg>
        <b>このパソコン</b>
      </span>
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
    <div className="setup-sr" data-tone={preferences.tone}>
      <p className="setup-sr-title">返事の見本</p>
      <div className="setup-sr-chat">
        <p className="setup-sr-bubble setup-sr-bubble--you">{SETUP_PREVIEW_QUESTION}</p>
        <div className="setup-sr-answer">
          <span className="setup-sr-avatar" aria-hidden="true">
            <i />
          </span>
          <p className="setup-sr-bubble setup-sr-bubble--ai" data-testid="setup-preview-reply">
            <span aria-hidden="true">
              {typed}
              <i className={`setup-sr-caret${typing ? ' is-typing' : ''}`} />
            </span>
          </p>
        </div>
      </div>
      <p className="setup-sr-chips" aria-hidden="true">
        {chips.map((chip) => (
          <span key={chip}>{chip}</span>
        ))}
      </p>
    </div>
  );
}

// ---------- Team: a field of runners, as many as the choice puts to work ----------

/** The line under the field: [small lead-in, the large figure, the rest]. */
const TEAM_HEADLINE: Readonly<Record<TeamUsageMode, readonly [string, string, string]>> = {
  explicit: ['ひとつずつ', '1', '人の AI が、順番に進める'],
  auto: ['ふだんは', '1＋', '人。大きな作業には、仲間が加わる'],
  proactive: ['最大', '100', 'の AI が、同時に動く'],
};

function TeamScene({ mode, animate }: { mode: TeamUsageMode; animate: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fieldRef = useRef<SetupTeamField | null>(null);
  const modeRef = useRef(mode);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const field = new SetupTeamField(canvas, { animate, mode: modeRef.current });
    fieldRef.current = field;
    return () => {
      field.destroy();
      fieldRef.current = null;
    };
  }, [animate]);
  useEffect(() => {
    modeRef.current = mode;
    fieldRef.current?.setMode(mode);
  }, [mode]);
  const [lead, figure, rest] = TEAM_HEADLINE[mode];
  return (
    <div className="setup-st" data-mode={mode}>
      <canvas ref={canvasRef} className="setup-st-field" />
      <p className="setup-st-count" key={mode}>
        <small>{lead}</small>
        <b>{figure}</b>
        <span>{rest}</span>
      </p>
    </div>
  );
}

// ---------- 細かい好み: a greeting that becomes "your" AI as the choices change ----------

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
    <div className="setup-sd">
      <span className="setup-sd-avatar" aria-hidden="true">
        {initial ? <b key={initial}>{initial}</b> : <i />}
      </span>
      <p className="setup-sd-greeting" key={greeting}>
        {greeting}
      </p>
      <p className="setup-sd-chips">
        {chips.map((chip) => (
          <span key={chip}>{chip}</span>
        ))}
      </p>
      <span className={`setup-sd-sound${soundEnabled ? ' is-on' : ''}`} aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </span>
    </div>
  );
}

// ---------- 作業場所: the lanes lead to one folder ----------

function WorkspaceScene({ folderLabel }: { folderLabel: string | null }) {
  return (
    <div className={`setup-sf${folderLabel ? ' is-picked' : ''}`}>
      <svg className="setup-sf-flow" viewBox="0 0 100 100" preserveAspectRatio="none">
        {FAN_ROWS.map((y, k) => (
          <path
            key={y}
            data-tone={k < 2 ? 0 : k === 2 ? 1 : 2}
            style={{ '--k': k } as CSSProperties}
            d={`M0 ${y}C24 ${y} 22 50 46 50`}
            pathLength={1}
          />
        ))}
      </svg>
      <span className="setup-sf-folder">
        <span className="setup-sf-back" />
        <span className="setup-sf-files">
          {[0, 1, 2].map((index) => (
            <i key={index} style={{ '--i': index } as CSSProperties} />
          ))}
        </span>
        <span className="setup-sf-front" />
      </span>
      <p className="setup-sf-label">{folderLabel ?? 'まだ選んでいません'}</p>
    </div>
  );
}

// ---------- 完了: the film's last picture again — the lanes, the logo, the beam ----------

/** Eight lanes into each of the logo's three nodes: [where it leaves the left edge, the node], in
 * % of the lanes' own box (three logo-heights tall, centred on the logo). */
const DONE_LANES: readonly (readonly [number, number, number])[] = [0, 1, 2].flatMap((node) =>
  Array.from({ length: 8 }, (_, k): readonly [number, number, number] => [
    node,
    node * 33.3 + 2 + k * 4.2,
    [37.7, 50, 62.4][node]!,
  ]),
);

function DoneScene() {
  const glyph = useLogoGlyph();
  return (
    <div className="setup-sk">
      <span className="setup-sk-mark">
        <svg className="setup-sk-lanes" viewBox="0 0 100 100" preserveAspectRatio="none">
          {DONE_LANES.map(([node, from, to], index) => (
            <path
              key={index}
              data-tone={node}
              style={{ '--k': index % 8 } as CSSProperties}
              d={`M0 ${from}C55 ${from} 60 ${to} 100 ${to}`}
              pathLength={1}
            />
          ))}
        </svg>
        <span className="setup-sk-beam" />
        <span className="setup-sk-halo" />
        {glyph !== null && <img className="setup-sk-glyph" src={glyph} alt="" />}
      </span>
    </div>
  );
}

// ---------- Sparks off the arrow's tip (done step only, motion allowed only) ----------

/** Deterministic, so a snapshot of the page is stable; varied enough to look scattered. */
function sparkPiece(index: number): CSSProperties {
  const angle = ((index * 137.508) % 100) - 50; // degrees either side of straight ahead
  const reach = 120 + ((index * 53) % 220);
  return {
    '--a': `${angle}deg`,
    '--len': `${reach}px`,
    '--d': `${(index % 9) * 34}ms`,
    '--tone': index % 3,
  } as CSSProperties;
}

export function SetupConfetti() {
  return (
    <div className="setup-confetti" aria-hidden="true" data-testid="setup-confetti">
      {Array.from({ length: 30 }, (_, index) => (
        <i key={index} data-tone={index % 3} style={sparkPiece(index)} />
      ))}
    </div>
  );
}
