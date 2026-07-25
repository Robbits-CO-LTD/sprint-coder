import { useEffect, useRef, useState } from 'react';
import { readReasoning, reasoningParagraphs, reasoningVersion } from '../lib/reasoning-buffer';

// The expandable half of the thinking pill (issue #17).
//
// Reads the reasoning text from the module-level buffer through a single rAF loop rather than from
// the store. The text deliberately never enters zustand: every fragment would otherwise be a store
// update, and every store update a re-render of every subscriber, for a stream that only this panel
// consumes.
//
// `role="region"` with a label and NOT `role="log"`. `role="log"` carries an implicit
// `aria-live="polite"`, which would make a screen reader read every incoming fragment aloud — the
// exact behaviour NFR-A11Y-03 forbids, and the reason the issue says never to copy that role here.

export function ReasoningPanel({
  turnId,
  truncated,
  panelId,
  variant,
}: {
  turnId: string;
  truncated: boolean;
  panelId: string;
  variant: 'main' | 'node';
}) {
  const [paragraphs, setParagraphs] = useState<string[]>(() =>
    reasoningParagraphs(readReasoning(turnId).text),
  );
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let frame = 0;
    let lastVersion = -1;
    const tick = (): void => {
      const current = reasoningVersion();
      if (current !== lastVersion) {
        lastVersion = current;
        setParagraphs(reasoningParagraphs(readReasoning(turnId).text));
      }
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [turnId]);

  // Follow the newest thought, but only within this panel — the issue is explicit that opening it
  // must not move the timeline's own scroll position.
  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [paragraphs]);

  return (
    <div
      className={`think-panel${variant === 'node' ? ' think-panel--node' : ''}`}
      id={panelId}
      role="region"
      aria-label="AIの思考"
      data-testid="reasoning-panel"
      ref={scrollRef}
    >
      {paragraphs.length === 0 ? (
        <p className="think-empty" data-testid="reasoning-panel-empty">
          思考の記録を待っています
        </p>
      ) : (
        paragraphs.map((paragraph, index) => (
          <p
            // Index-keyed on purpose: paragraphs only ever grow and the last one is rewritten as it
            // streams, so a content key would remount the line the user is reading on every fragment.
            key={index}
            className={`think-para${index === paragraphs.length - 1 ? ' latest' : ''}`}
          >
            {paragraph}
          </p>
        ))
      )}
      {truncated && (
        <p className="think-truncated" data-testid="reasoning-truncated">
          思考が長すぎるため、以降は記録していません。
        </p>
      )}
    </div>
  );
}
