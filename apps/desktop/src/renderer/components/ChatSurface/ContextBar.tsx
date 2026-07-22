import { WorkspaceChip } from '../WorkspaceChip';

// ContextBar: workspace / branch / permission preset / usage (§4.2). Workspace is now backed by
// real data (workspace.get/select) via WorkspaceChip; branch/permission/usage chips remain
// placeholders until their APIs land on the preload contract.
export function ContextBar({ taskId }: { taskId: string }) {
  return (
    <div className="context-bar">
      <WorkspaceChip taskId={taskId} variant="context" />
      <span className="ctx-chip">確認して実行</span>
    </div>
  );
}
