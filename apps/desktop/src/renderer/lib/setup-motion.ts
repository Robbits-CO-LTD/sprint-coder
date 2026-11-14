import { useEffect, useRef, useState } from 'react';

// Small motion helpers for the Setup. Each one owns exactly one timer or frame request at a time
// and cancels it on change and on unmount, so nothing keeps running once the Setup is gone. With
// `animate` false (reduced motion) none of them schedules anything and the final state is shown.

const TYPE_PER_MS = 0.075; // ~75 characters a second
const ERASE_PER_MS = 0.32;

function commonPrefixLength(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) index += 1;
  return index;
}

/**
 * Shows `target` as if it were typed: when it changes, the part that differs is erased quickly and
 * the new text is typed in. Returns the text to paint right now.
 */
export function useRetype(target: string, animate: boolean): string {
  const [shown, setShown] = useState(() => (animate ? '' : target));
  const shownRef = useRef(shown);

  useEffect(() => {
    if (!animate) {
      shownRef.current = target;
      return;
    }
    const goal = Array.from(target);
    const keep = commonPrefixLength(shownRef.current, target);
    let frame = 0;
    let last: number | null = null;
    let budget = 0;
    let first = true;
    const tick = (now: number) => {
      const elapsed = last === null ? 16 : now - last;
      last = now;
      const current = Array.from(shownRef.current);
      const erasing = current.length > keep && !target.startsWith(shownRef.current);
      budget += elapsed * (erasing ? ERASE_PER_MS : TYPE_PER_MS);
      const count = Math.floor(budget);
      budget -= count;
      let next = shownRef.current;
      if (count > 0) {
        next = erasing
          ? current.slice(0, Math.max(keep, current.length - count)).join('')
          : goal.slice(0, Math.min(goal.length, current.length + count)).join('');
      }
      // The first frame always publishes, so state left behind while motion was off catches up.
      if (next !== shownRef.current || first) {
        shownRef.current = next;
        setShown(next);
      }
      first = false;
      if (next !== target) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, animate]);

  return animate ? shown : target;
}

/**
 * Steps through `durations.length` phases in a loop (phase i lasts durations[i] ms). Without
 * animation it stays on the last phase, which every scene uses as its complete, static picture.
 */
export function usePhaseCycle(
  durations: readonly number[],
  animate: boolean,
): { phase: number; cycle: number } {
  // One counter: phase = tick % count, cycle = how many times the loop came round.
  const [tick, setTick] = useState(0);
  const count = durations.length;
  const phase = tick % count;
  const duration = durations[phase] ?? 1000;
  useEffect(() => {
    if (!animate) return;
    const timer = window.setTimeout(() => setTick((current) => current + 1), duration);
    return () => window.clearTimeout(timer);
  }, [animate, tick, duration]);
  return animate ? { phase, cycle: Math.floor(tick / count) } : { phase: count - 1, cycle: 0 };
}
