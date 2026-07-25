import { useAppStore } from '../store/appStore';
import { Folder } from './icons';

// Shared workspace chip logic for TaskHeader (§4.1) and ContextBar (§4.2): unselected shows
// "Workspace未選択", selected shows the folder name with the full path in the title, and
// clicking (re)opens the folder picker via workspace.select. Falls back to a read-only chip
// when the backend hasn't wired the workspace API yet (graceful degrade).
export function WorkspaceChip({
  taskId,
  variant,
}: {
  taskId: string;
  variant: 'header' | 'context';
}) {
  const workspace = useAppStore((s) => s.workspaceByTask[taskId]);
  const selectWorkspace = useAppStore((s) => s.selectWorkspace);
  const supported =
    typeof window !== 'undefined' && typeof window.sprintCoder?.workspace?.select === 'function';

  const label = workspace ? workspace.name : 'Workspace未選択';
  const dot =
    variant === 'context' ? (
      <span
        className="dot"
        style={{ background: workspace ? 'var(--success)' : 'var(--text-secondary)' }}
      />
    ) : null;

  if (!supported) {
    return (
      <span
        className={variant === 'header' ? 'goal-chip' : 'ctx-chip'}
        title={workspace ? workspace.path : 'Workspace選択は今回のバックエンドでは未対応です'}
      >
        {dot}
        <Folder size={13} /> {label}
      </span>
    );
  }

  return (
    <button
      type="button"
      className={variant === 'header' ? 'goal-chip chip-btn' : 'ctx-chip chip-btn'}
      title={workspace ? workspace.path : 'クリックしてWorkspaceフォルダを選択'}
      onClick={() => void selectWorkspace(taskId)}
    >
      {dot}
      <Folder size={13} /> {label}
    </button>
  );
}
