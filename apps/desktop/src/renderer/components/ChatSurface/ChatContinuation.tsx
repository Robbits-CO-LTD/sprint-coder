import { skillRuntimeForConnection } from './skill-runtime';
import { requestedSkill, WORKSPACE_REQUEST } from '../../../chat-continuation';
import type { SkillCatalogItem, TurnSkillSelection } from '@sprint-coder/contracts';
import { useAppStore } from '../../store/appStore';
import { taskHasEffectiveWorkspaceRoot } from '../../lib/effective-workspace-root';
import { WorkspaceFolderButton } from './WorkspaceFolderButton';
import { skillUnavailable } from './skill-picker';

export function ChatContinuation({
  taskId,
  onResume,
}: {
  taskId: string;
  onResume: (text: string, skills: readonly TurnSkillSelection[]) => void;
}) {
  const reply = useAppStore((s) => s.messagesByTask[taskId]?.at(-1));
  const hasFolder = useAppStore((state) => taskHasEffectiveWorkspaceRoot(taskId, state));
  const catalog = useAppStore((s) => s.skillCatalog);
  const runtime = useAppStore((s) => s.runtime.kind);
  const picker = useAppStore((s) => s.modelPicker);
  const teamStarted = useAppStore((s) =>
    s.teamByTask[taskId]?.workers.some((w) => w.kind === 'worker'),
  );

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

  if (folderRequested && !hasFolder) return <WorkspaceFolderButton taskId={taskId} />;
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
      <button type="button" className="turn-diff-action" onClick={() => resume(skill || undefined)}>
        {skill
          ? `${skill.ref.source}/${skill.ref.skillId} を使って続ける`
          : 'この作業フォルダーで続ける'}
      </button>
    </div>
  );
}
