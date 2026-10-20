import type { WorkerActivityEntry } from '../types/sprint-coder';
import { workStepIcon, workStepLabel, type WorkStepIcon } from '../lib/worker-thread';
import { Dot, Eye, Pencil, Search, Terminal } from './icons';

const STEP_ICON: Record<WorkStepIcon, typeof Terminal> = {
  edit: Pencil,
  read: Eye,
  search: Search,
  tool: Terminal,
  status: Dot,
};

/** One row of a Worker's work log — the icon of what it did, then the tool or file it touched.
 * Rendered by both the Canvas card and the List row so the two read the same. */
export function WorkStep({
  step,
  as: Tag = 'div',
}: {
  step: WorkerActivityEntry;
  as?: 'div' | 'li';
}) {
  const icon = workStepIcon(step);
  const StepIcon = STEP_ICON[icon];
  return (
    <Tag className={`w-step w-step--${icon}`}>
      <StepIcon size={14} className="w-step-icon" />
      <span className="w-step-label">{workStepLabel(step.label)}</span>
    </Tag>
  );
}
