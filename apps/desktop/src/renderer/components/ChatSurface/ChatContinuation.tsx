import { skillRuntimeForConnection } from './skill-runtime';
import { useState } from 'react';
import { requestedSkill, WORKSPACE_REQUEST } from '../../../chat-continuation';
import type { SkillCatalogItem, TurnSkillSelection } from '@sprint-coder/contracts';
import { useAppStore } from '../../store/appStore';
import { ProjectEditorDialog } from '../ProjectEditorDialog';
import { skillUnavailable } from './skill-picker';

export function ChatContinuation({
  taskId,
  onResume,
}: {
  taskId: string;
  onResume: (text: string, skills: readonly TurnSkillSelection[]) => void;
}) {
  const reply = useAppStore((s) => s.messagesByTask[taskId]?.at(-1));
  const projectId = useAppStore((s) => s.tasks.find((task) => task.id === taskId)?.projectId);
  const project = useAppStore((s) => s.projects.find((item) => item.id === projectId));
  const workspace = useAppStore((s) => s.workspaceByTask[taskId]);
  const catalog = useAppStore((s) => s.skillCatalog);
  const runtime = useAppStore((s) => s.runtime.kind);
  const picker = useAppStore((s) => s.modelPicker);
  const teamStarted = useAppStore((s) =>
    s.teamByTask[taskId]?.workers.some((w) => w.kind === 'worker'),
  );
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (reply?.author !== 'assistant' || reply.turnId === null) return null;
  const connection = picker.taskId === taskId ? picker.selection?.connectionId : null;
  const lastLine = reply.content.trimEnd().split('\n').at(-1)?.trim();
  const folderRequested = lastLine === WORKSPACE_REQUEST;
  const match = requestedSkill(lastLine ?? '');
  const skill =
    match && catalog.find(({ ref }) => ref.source === match[1] && ref.skillId === match[2]);
  const skillRuntime = skillRuntimeForConnection(connection, runtime);
  if (
    !folderRequested &&
    (!skill || skillUnavailable(skill, skillRuntime, [], teamStarted === true))
  )
    return null;

  const hasFolder = projectId != null ? Boolean(project?.primaryFolder) : Boolean(workspace?.path);
  async function selectFolder() {
    if (projectId != null) {
      if (project) setEditing(true);
      return;
    }
    setPending(true);
    setError(null);
    try {
      const selected = await window.sprintCoder?.workspace.select(taskId);
      if (selected)
        useAppStore.setState((s) => ({
          workspaceByTask: { ...s.workspaceByTask, [taskId]: selected },
        }));
    } catch {
      setError('作業フォルダーを設定できませんでした。');
    } finally {
      setPending(false);
    }
  }
  function resume(item?: SkillCatalogItem) {
    const state = useAppStore.getState();
    if (state.sendingByTask[taskId] || state.messagesByTask[taskId]?.at(-1)?.id !== reply?.id)
      return;
    const text = item
      ? `「${item.ref.skillId}」を使って、先ほどの依頼を続けてください。`
      : '選んだ作業フォルダーで、先ほどの依頼を続けてください。';
    onResume(text, item ? [{ kind: item.kind, ref: item.ref }] : []);
  }
  return (
    <div>
      <button
        type="button"
        className="turn-diff-action"
        disabled={pending || (folderRequested && projectId != null && !project)}
        onClick={() =>
          folderRequested && !hasFolder ? void selectFolder() : void resume(skill || undefined)
        }
      >
        {skill
          ? `${skill.ref.source}/${skill.ref.skillId} を使って続ける`
          : hasFolder
            ? 'この作業フォルダーで続ける'
            : '作業フォルダーを選ぶ'}
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
    </div>
  );
}
