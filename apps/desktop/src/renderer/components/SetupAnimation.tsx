import { useEffect, useRef, useState } from 'react';
import lottie, { type AnimationItem } from 'lottie-web';

const SETUP_ANIMATION_PATH = '/projects/sprint-coder-setup/scene-1/lottie.json';

export function SetupAnimation({ step }: { step: number }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<AnimationItem | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const animation = lottie.loadAnimation({
      container: host,
      renderer: 'svg',
      loop: !reducedMotion,
      autoplay: !reducedMotion,
      path: SETUP_ANIMATION_PATH,
      rendererSettings: {
        progressiveLoad: true,
        preserveAspectRatio: 'xMidYMid meet',
      },
    });
    animationRef.current = animation;
    animation.addEventListener('DOMLoaded', () => setReady(true));
    if (reducedMotion) {
      animation.addEventListener('DOMLoaded', () => animation.goToAndStop(128, true));
    }
    return () => {
      animationRef.current = null;
      animation.destroy();
    };
  }, []);

  useEffect(() => {
    const animation = animationRef.current;
    if (animation === null || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    animation.setSpeed(step === 3 ? 1.22 : 0.82 + step * 0.08);
  }, [step]);

  return (
    <div className={`setup-animation-frame ${ready ? 'is-ready' : ''}`} aria-hidden="true">
      <div className="setup-progress-orbit">
        <div className="setup-progress-runner-track">
          <i className="setup-progress-runner" />
        </div>
        {[0, 1, 2, 3].map((index) => (
          <span
            key={index}
            className={`${index === step ? 'is-active' : ''} ${index < step ? 'is-complete' : ''}`}
          />
        ))}
      </div>
      <div className="setup-animation-fallback">
        <i />
        <i />
        <span />
      </div>
      <div ref={hostRef} className="setup-animation" />
    </div>
  );
}
