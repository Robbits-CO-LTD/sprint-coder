import type { Ref } from 'react';
import { useAppStore } from '../../store/appStore';
import { SurfaceHeader } from './SurfaceHeader';
import { Timeline } from './Timeline';
import { Composer } from './Composer';
import type { TaskSummary } from '../../types/sprint-coder';

// ChatSurface: SurfaceHeader + Timeline + ContextBar + Composer (§4.2). Container layout and
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
  id?: string;
  ref?: Ref<HTMLDivElement>;
}) {
  const stageAnnouncement = useAppStore((s) => s.stageAnnouncement);
  const isNode = variant === 'node';

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
      <Timeline taskId={task.id} />
      <Composer taskId={task.id} />
    </div>
  );
}
