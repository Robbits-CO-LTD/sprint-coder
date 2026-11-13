import { useId, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import type { SetupOption, TeamUsageOption } from '../lib/setup-options';
import type { TeamUsageMode } from '../lib/setup-settings';

// The Setup's own controls. Every choice is a native radio or checkbox underneath, so a radio group
// is announced as one, arrow keys move within it, Space toggles a switch, and the browser keeps the
// focus order — the styling only changes how they look.

/** Remembers where a pointer pressed a choice so its light can spread from that spot. A keyboard
 * choice has no point, and spreads from the middle. */
function useRippleOrigin() {
  const fromPointer = useRef(false);
  return {
    onPointerDown(event: PointerEvent<HTMLElement>) {
      const box = event.currentTarget.getBoundingClientRect();
      event.currentTarget.style.setProperty('--rx', `${event.clientX - box.left}px`);
      event.currentTarget.style.setProperty('--ry', `${event.clientY - box.top}px`);
      fromPointer.current = true;
    },
    settle(element: HTMLElement | null) {
      if (!fromPointer.current && element) {
        element.style.removeProperty('--rx');
        element.style.removeProperty('--ry');
      }
      fromPointer.current = false;
      bounce(element);
    },
  };
}

/** A short squash-and-spring on the chosen card. The individual `scale` property composes with the
 * card's own lift, and a finished Web Animation leaves nothing running. */
function bounce(element: HTMLElement | null): void {
  if (element === null || typeof element.animate !== 'function') return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  element.animate([{ scale: '0.95' }, { scale: '1.04', offset: 0.45 }, { scale: '1' }], {
    duration: 440,
    easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
  });
}

function CheckMark() {
  return (
    <svg className="setup-checkmark" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="7.25" />
      <path d="M4.6 8.3 7 10.6l4.4-5" pathLength={1} />
    </svg>
  );
}

export function SetupChoiceGroup<T extends string>({
  legend,
  options,
  value,
  onChange,
  columns,
  testId,
}: {
  legend: string;
  options: readonly SetupOption<T>[];
  value: T;
  onChange: (value: T) => void;
  columns?: 2 | 3 | 4;
  testId?: string;
}) {
  const name = useId();
  const ripple = useRippleOrigin();
  const [pulse, setPulse] = useState(0);
  return (
    <fieldset className="setup-choices" data-testid={testId}>
      <legend>{legend}</legend>
      <div className="setup-choices-row" data-columns={columns ?? options.length}>
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <label
              key={option.value}
              className={`setup-choice${selected ? ' is-selected' : ''}`}
              onPointerDown={ripple.onPointerDown}
            >
              <input
                type="radio"
                name={name}
                value={option.value}
                checked={selected}
                data-testid={testId ? `${testId}-${option.value}` : undefined}
                onChange={(event) => {
                  ripple.settle(event.currentTarget.parentElement);
                  setPulse((current) => current + 1);
                  onChange(option.value);
                }}
              />
              <span className="setup-choice-text">
                <strong>{option.label}</strong>
                <small>{option.description}</small>
              </span>
              <CheckMark />
              {selected && pulse > 0 && (
                <span key={pulse} className="setup-ripple" aria-hidden="true" />
              )}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

export function SetupSwitch({
  label,
  description,
  checked,
  onChange,
  testId,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  testId?: string;
}) {
  return (
    <label className={`setup-switch${checked ? ' is-on' : ''}`}>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        data-testid={testId}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span className="setup-switch-text">
        <strong>{label}</strong>
        {description && <small>{description}</small>}
      </span>
      <span className="setup-switch-track" aria-hidden="true">
        <i />
      </span>
    </label>
  );
}

type MiniLine = { d: string; who: 'leader' | 'worker-1' | 'worker-2' | 'worker-3'; join?: boolean };

/** One path per teammate, 120×52. Still, the three pictures differ by shape alone: one line; one
 * line that others branch into half-way; four lines side by side from the start. */
const MINI_LINES: Readonly<Record<TeamUsageMode, readonly MiniLine[]>> = {
  explicit: [{ d: 'M8 26H112', who: 'leader' }],
  auto: [
    { d: 'M8 26H112', who: 'leader' },
    { d: 'M50 26C62 26 62 11 74 11H112', who: 'worker-1', join: true },
    { d: 'M58 26C70 26 70 41 82 41H112', who: 'worker-2', join: true },
  ],
  proactive: [
    { d: 'M8 8H112', who: 'worker-1' },
    { d: 'M8 20H112', who: 'leader' },
    { d: 'M8 32H112', who: 'worker-2' },
    { d: 'M8 44H112', who: 'worker-3' },
  ],
};

/** The small picture on each Team card. Decorative — the card's words carry the meaning. */
export function SetupTeamMini({ mode, animate }: { mode: TeamUsageMode; animate: boolean }) {
  return (
    <span
      className={`setup-mini${animate ? ' is-animated' : ''}`}
      data-mode={mode}
      aria-hidden="true"
    >
      <svg viewBox="0 0 120 52">
        {MINI_LINES[mode].map((line, index) => (
          <g
            key={line.d}
            className={line.join ? 'is-join' : undefined}
            style={{ '--c': `var(--setup-${line.who})`, '--k': index } as CSSProperties}
          >
            <path className="setup-mini-base" d={line.d} />
            <path className="setup-mini-line" d={line.d} pathLength={1} />
            <circle
              className="setup-mini-dot"
              r="3.2"
              style={{ offsetPath: `path('${line.d}')` }}
            />
          </g>
        ))}
      </svg>
    </span>
  );
}
export function SetupTeamCards({
  options,
  value,
  onChange,
  animate,
}: {
  options: readonly TeamUsageOption[];
  value: TeamUsageMode;
  onChange: (value: TeamUsageMode) => void;
  animate: boolean;
}) {
  const name = useId();
  const ripple = useRippleOrigin();
  const [pulse, setPulse] = useState(0);
  return (
    <fieldset className="setup-team-cards" data-testid="setup-team-cards">
      <legend className="setup-visually-hidden">Team の使い方</legend>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <label
            key={option.value}
            className={`setup-team-card${selected ? ' is-selected' : ''}`}
            onPointerDown={ripple.onPointerDown}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={selected}
              data-testid={`setup-team-${option.value}`}
              onChange={(event) => {
                ripple.settle(event.currentTarget.parentElement);
                setPulse((current) => current + 1);
                onChange(option.value);
              }}
            />
            <SetupTeamMini mode={option.value} animate={animate} />
            <span className="setup-team-card-text">
              <strong>
                {option.label}
                {option.recommended && <span className="setup-badge">おすすめ</span>}
              </strong>
              <small>{option.description}</small>
            </span>
            <CheckMark />
            {selected && pulse > 0 && (
              <span key={pulse} className="setup-ripple" aria-hidden="true" />
            )}
          </label>
        );
      })}
    </fieldset>
  );
}
