import { useState } from 'react';
import { useAppStore } from '../../store/appStore';
import { ProjectEditorDialog } from '../ProjectEditorDialog';

export function WorkspaceFolderButton({ taskId }: { taskId: string }) {
  const projectId = useAppStore((state) => state.tasks.find(({ id }) => id === taskId)?.projectId);
  const project = useAppStore((state) => state.projects.find(({ id }) => id === projectId));
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const workspace = typeof window === 'undefined' ? undefined : window.sprintCoder?.workspace;
  const canChoose =
    projectId == null ? typeof workspace?.select === 'function' : project !== undefined;

  async function chooseFolder() {
    if (projectId != null) {
      if (project !== undefined) setEditing(true);
      return;
    }
    setPending(true);
    setError(null);
    try {
      const selected = await workspace?.select(taskId);
      if (selected != null)
        useAppStore.setState((state) => ({
          workspaceByTask: { ...state.workspaceByTask, [taskId]: selected },
        }));
    } catch {
      setError('作業フォルダーを設定できませんでした。');
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="turn-diff-action"
        disabled={pending || !canChoose}
        onClick={() => void chooseFolder()}
      >
        作業フォルダーを選ぶ
      </button>
      {editing && project && (
        <ProjectEditorDialog
          open
          project={project}
          onClose={() => setEditing(false)}
          onSaved={() => setEditing(false)}
        />
      )}
      {error && <p role="alert">{error}</p>}
    </>
  );
}
