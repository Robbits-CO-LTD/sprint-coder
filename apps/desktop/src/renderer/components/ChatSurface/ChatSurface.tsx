import { useEffect } from 'react';
import type { Ref } from 'react';
import { useAppStore } from '../../store/appStore';
import { SurfaceHeader } from './SurfaceHeader';
import { Timeline } from './Timeline';
import { Composer } from './Composer';
import { SurfaceFooter } from './SurfaceFooter';
import type { TaskSummary } from '../../types/sprint-coder';

// Dev-only mount counter (ADR-002 / Phase 6 Slice 6.2 acceptance: "mount count=1" across a
// chat→team→chat→team cycle). SurfaceLayer moves this component's DOM subtree between the main
// and Leader anchors via a single persistent portal host — it must never actually remount. Read
// via `window.__sprintCoderChatSurfaceMounts` from tests/e2e/team-morph.spec.ts.
//
// Note: this app renders under <StrictMode> (main.tsx), which deliberately double-invokes
// mount effects in dev to surface non-idempotent effects — so the *baseline* value right after
// first load is 2, not 1, in dev-mode E2E. That is a StrictMode artifact, not an extra mount;
// the acceptance-relevant assertion is that the count does not increase again across the morph
// cycle, not that it is literally `1`. Dead-code-eliminated in production builds.
declare global {
  interface Window {
    __sprintCoderChatSurfaceMounts?: number;
  }
}

// ChatSurface: SurfaceHeader + Timeline + ContextBar + Composer + SurfaceFooter (§4.2). Container
// layout and
// viewport context are the only things that differ between the normal Chat layout and the
// Canvas Leader node (demo/index.html §"ChatSurface" / #surfaceWrap.node) — `variant` picks
// between the two; the rest of the tree (Timeline/Composer/store wiring) is shared so a Leader
// node in Team mode is a real, functional ChatSurface instance, not a lookalike.
export function ChatSurface({
  task,
  variant = 'main',
  id,
  ref,
}: {
  task: TaskSummary;
  variant?: 'main' | 'node';
  id?: string | undefined;
  ref?: Ref<HTMLDivElement> | undefined;
}) {
  const stageAnnouncement = useAppStore((s) => s.stageAnnouncement);
  const isNode = variant === 'node';

  useEffect(() => {
    if (import.meta.env.DEV) {
      window.__sprintCoderChatSurfaceMounts = (window.__sprintCoderChatSurfaceMounts ?? 0) + 1;
    }
  }, []);

  return (
    <div
      ref={ref}
      id={id}
      tabIndex={isNode ? -1 : undefined}
      className={`surface${isNode ? ' surface--node' : ''}`}
    >
      <SurfaceHeader title={task.title} variant={variant} />
      {/* Stage changes are announced here; streaming tokens are not sent to the live region
          verbatim (NFR-A11Y-03). */}
      <div aria-live="polite" className="visually-hidden">
        {stageAnnouncement}
      </div>
      <Timeline taskId={task.id} variant={variant} />
      <Composer taskId={task.id} />
      <SurfaceFooter variant={variant} />
    </div>
  );
}
