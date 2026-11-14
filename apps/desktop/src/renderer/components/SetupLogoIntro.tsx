import { useEffect, useRef, useState } from 'react';
import iconUrl from '../../../assets/sprint-coder-icon-master-v1.png';
import { SetupLogoIntro as LogoFilm } from '../lib/setup-logo-intro';
import { LogoSoundPlayer, logoSoundLevel } from '../lib/setup-logo-sound';
import type { LogoIntroVariant } from '../lib/setup-logo-timeline';

/** Keys that skip the film. */
const SKIP_KEYS = new Set(['Enter', ' ', 'Spacebar', 'Escape']);

/**
 * The logo film over the whole Setup, with its sound. A click anywhere, or Enter, Space or
 * Escape, skips it — and does nothing else: while the film plays those keys do not reach the
 * Setup waiting under it (Escape does not close a replay), and Tab does not wander into what
 * cannot be seen. Shortcuts with Ctrl, Alt or the system key are left alone. Once the Setup
 * starts to come in, the film lets clicks and keys through to it, and fades out on its own.
 *
 * The sound plays unless the user has switched sound effects off (see `logoSoundLevel`); since
 * nobody asked for it, a small button — or the M key — silences it for the rest of the film.
 */
export function SetupLogoIntro({
  variant,
  onHandoff,
  onDone,
}: {
  variant: LogoIntroVariant;
  onHandoff: () => void;
  onDone: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const filmRef = useRef<LogoFilm | null>(null);
  const soundRef = useRef<LogoSoundPlayer | null>(null);
  const [handedOff, setHandedOff] = useState(false);
  // How loud this film's sound is, or null for none (decided once, when it starts), and whether
  // it was muted since.
  const [level] = useState(() => logoSoundLevel(variant));
  const hasSound = level !== null;
  const [muted, setMuted] = useState(false);
  // The latest callbacks, without restarting the film when they change.
  const callbacks = useRef({ onHandoff, onDone });
  useEffect(() => {
    callbacks.current = { onHandoff, onDone };
  }, [onHandoff, onDone]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const sound = level === null ? null : new LogoSoundPlayer({ variant, level });
    soundRef.current = sound;
    const film = new LogoFilm(canvas, {
      variant,
      iconUrl,
      ...(sound ? { sound } : {}),
      onHandoff: () => {
        setHandedOff(true);
        callbacks.current.onHandoff();
      },
      onDone: () => callbacks.current.onDone(),
    });
    filmRef.current = film;
    return () => {
      // Destroying the film stops its sound as well; this is for a film that never took it.
      film.destroy();
      sound?.stop();
      filmRef.current = null;
      soundRef.current = null;
    };
  }, [variant, level]);

  const mute = () => {
    soundRef.current?.mute();
    setMuted(true);
  };

  useEffect(() => {
    if (handedOff) return;
    // On the window, before anything else hears it: the Setup's own keys wait for the film.
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return;
      const skips = SKIP_KEYS.has(event.key);
      const mutes = hasSound && (event.key === 'm' || event.key === 'M');
      if (!skips && !mutes && event.key !== 'Tab') return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      if (skips) filmRef.current?.skip();
      else if (mutes) {
        soundRef.current?.mute();
        setMuted(true);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [handedOff, hasSound]);

  return (
    <div
      className="setup-logo-intro"
      data-testid="setup-logo-intro"
      data-variant={variant}
      data-handoff={handedOff ? 'true' : 'false'}
      onPointerDown={(event) => {
        if (handedOff) return;
        event.preventDefault();
        event.stopPropagation();
        filmRef.current?.skip();
      }}
    >
      <canvas ref={canvasRef} className="setup-logo-intro-canvas" aria-hidden="true" />
      {variant !== 'still' && (
        <div className="setup-logo-intro-hints">
          {hasSound && (
            <button
              type="button"
              className="setup-logo-intro-mute"
              data-testid="setup-logo-intro-mute"
              aria-label={muted ? '音を消しました' : '音を消す'}
              aria-pressed={muted}
              disabled={muted}
              tabIndex={-1}
              // A press here is for the sound only: it must not skip the film.
              onPointerDown={(event) => event.stopPropagation()}
              onClick={mute}
            >
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                <path d="M2 6h2.6L8 3.2v9.6L4.6 10H2z" fill="currentColor" />
                {muted ? (
                  <path
                    d="M10.4 6.2l3.6 3.6m0-3.6l-3.6 3.6"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinecap="round"
                    fill="none"
                  />
                ) : (
                  <path
                    d="M10.3 5.6a3.4 3.4 0 0 1 0 4.8M12 3.9a5.8 5.8 0 0 1 0 8.2"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinecap="round"
                    fill="none"
                  />
                )}
              </svg>
              <kbd>M</kbd>
              <span>{muted ? '音を消しました' : '音を消す'}</span>
            </button>
          )}
          <p className="setup-logo-intro-skip">
            <kbd>Enter</kbd>
            <span>またはクリックで飛ばす</span>
          </p>
        </div>
      )}
    </div>
  );
}
