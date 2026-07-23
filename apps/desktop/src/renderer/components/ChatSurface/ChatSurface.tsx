import { useAppStore } from '../../store/appStore';
import { SurfaceHeader } from './SurfaceHeader';
import { Timeline } from './Timeline';
import { Composer } from './Composer';
import type { TaskSummary } from '../../types/sprint-coder';

// ChatSurface: SurfaceHeader + Timeline + ContextBar + Composer (§4.2). Container layout and
// viewport context are the only things that should ever differ between the normal Chat layout
// and a future Canvas node — this component is written so that contract stays true even though
// Canvas/Team is out of scope for this slice.
export function ChatSurface({ task }: { task: TaskSummary }) {
  const stageAnnouncement = useAppStore((s) => s.stageAnnouncement);

  return (
    <div className="surface">
      <SurfaceHeader title={task.title} />
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
