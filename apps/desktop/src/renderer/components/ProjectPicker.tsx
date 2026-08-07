import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectFolder, ProjectSummary, TaskSummary } from '../types/sprint-coder';
import { useAppStore } from '../store/appStore';
import { ProjectEditorDialog } from './ProjectEditorDialog';
import { Check, Folder, Plus, Search, X } from './icons';

export function ProjectPicker({ taskId }: { taskId: string }) {
  const tasks = useAppStore((state) => state.tasks);
  const projects = useAppStore((state) => state.projects);
  const assignTask = useAppStore((state) => state.assignTaskToProject);
  const unassignTask = useAppStore((state) => state.unassignTaskFromProject);
  const createTask = useAppStore((state) => state.createTask);
  const listFolders = useAppStore((state) => state.listProjectFolders);
  const setProjectSwitching = useAppStore((state) => state.setProjectSwitching);
  const task = tasks.find(({ id }) => id === taskId);
  const activeProjects = useMemo(() => projects.filter(({ archived }) => !archived), [projects]);
  const selected = activeProjects.find(({ id }) => id === task?.projectId) ?? null;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [foldersByProject, setFoldersByProject] = useState<Record<string, ProjectFolder[]>>({});
  const [pending, setPending] = useState(false);
  const [creating, setCreating] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    void Promise.all(
      activeProjects.map(
        async (project) => [project.id, (await listFolders(project.id)) ?? []] as const,
      ),
    ).then((entries) => {
      if (active) setFoldersByProject(Object.fromEntries(entries));
    });
    function outside(event: MouseEvent): void {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', outside);
    return () => {
      active = false;
      document.removeEventListener('mousedown', outside);
    };
  }, [activeProjects, listFolders, open]);

  const filtered = useMemo(
    () => filterProjectsByQuery(activeProjects, foldersByProject, query),
    [activeProjects, foldersByProject, query],
  );

  async function choose(project: ProjectSummary | null): Promise<void> {
    if (task === undefined || pending) return;
    setPending(true);
    setProjectSwitching(task.id, true);
    try {
      const action = projectSelectionAction(task, project);
      if (action.kind === 'reassign') {
        const reassigned =
          project === null ? await unassignTask(task.id) : await assignTask(task.id, project.id);
        if (reassigned === null) return;
      } else {
        const created = await createTask(project?.id);
        if (created === null) return;
      }
      setOpen(false);
      setQuery('');
      requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
    } finally {
      setPending(false);
      setProjectSwitching(task.id, false);
    }
  }

  return (
    <>
      <div
        className="project-picker"
        ref={wrapRef}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Escape') {
            event.preventDefault();
            setOpen(false);
            triggerRef.current?.focus({ preventScroll: true });
            return;
          }
          if (!isProjectPickerNavigationKey(event.key, event.target instanceof HTMLInputElement))
            return;
          const buttons = [
            ...(wrapRef.current?.querySelectorAll<HTMLButtonElement>(
              '.project-picker-options button:not(:disabled), .project-picker-actions button:not(:disabled)',
            ) ?? []),
          ];
          if (buttons.length === 0) return;
          event.preventDefault();
          const current = buttons.indexOf(event.target as HTMLButtonElement);
          const next = nextProjectPickerIndex(current, buttons.length, event.key);
          buttons[next]?.focus({ preventScroll: true });
          buttons[next]?.scrollIntoView({ block: 'nearest' });
        }}
      >
        <button
          ref={triggerRef}
          type="button"
          className="ctx-chip project-picker-trigger"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          title={selected?.primaryFolder?.path ?? selected?.name ?? 'Projectなしで作業'}
        >
          <Folder size={15} />
          {selected?.name ?? 'Projectなし'}
        </button>
        {open && (
          <div className="project-picker-popover" role="dialog" aria-label="Projectを選択">
            <div className="project-picker-header">
              <div>
                <strong>Projectを切り替え</strong>
                <span>このTaskの作業場所を選択</span>
              </div>
              <kbd>Esc</kbd>
            </div>
            <div className="project-picker-search">
              <Search size={17} />
              <input
                autoFocus
                type="search"
                value={query}
                placeholder="Projectを検索"
                aria-label="Projectを検索"
                onChange={(event) => setQuery(event.target.value)}
              />
              {query !== '' && (
                <button
                  type="button"
                  className="project-picker-clear"
                  aria-label="検索をクリア"
                  onClick={() => setQuery('')}
                >
                  <X size={14} />
                </button>
              )}
            </div>
            <div className="project-picker-results">
              <div className="project-picker-section-label" aria-hidden="true">
                <span>Projects</span>
                <span>{filtered.length}</span>
              </div>
              <div
                className="project-picker-options"
                role={filtered.length > 0 ? 'menu' : undefined}
                aria-label={filtered.length > 0 ? 'Project一覧' : undefined}
              >
                {filtered.map((project) => (
                  <button
                    key={project.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={task?.projectId === project.id}
                    disabled={pending}
                    onClick={() => void choose(project)}
                  >
                    <span className="project-picker-item-icon">
                      <Folder size={16} />
                    </span>
                    <span className="project-picker-item-copy">
                      <strong>{project.name}</strong>
                      {project.primaryFolder != null && <small>{project.primaryFolder.path}</small>}
                    </span>
                    {task?.projectId === project.id && (
                      <span className="project-picker-selection" aria-label="選択中">
                        <Check size={15} />
                      </span>
                    )}
                  </button>
                ))}
                {filtered.length === 0 && (
                  <div className="project-picker-empty" role="status">
                    <span className="project-picker-empty-icon">
                      <Search size={19} />
                    </span>
                    <strong>
                      {query.trim() === ''
                        ? 'Projectはまだありません'
                        : '一致するProjectはありません'}
                    </strong>
                    <span>
                      {query.trim() === ''
                        ? '新しく作成するか、Projectなしで作業を続けられます。'
                        : '検索語を変えて、もう一度お試しください。'}
                    </span>
                  </div>
                )}
              </div>
            </div>
            <div className="project-picker-actions">
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  setOpen(false);
                  setCreating(true);
                }}
              >
                <span className="project-picker-action-icon project-picker-action-icon-accent">
                  <Plus size={16} />
                </span>
                <span>新しいProject</span>
              </button>
              <button type="button" disabled={pending} onClick={() => void choose(null)}>
                <span className="project-picker-action-icon">
                  <X size={16} />
                </span>
                <span>Projectなしで作業</span>
                {task?.projectId === null && (
                  <span className="project-picker-selection" aria-label="選択中">
                    <Check size={15} />
                  </span>
                )}
              </button>
            </div>
            <div className="sr-only" aria-live="polite">
              {pending ? 'Projectを変更中です' : `${filtered.length}件のProject`}
            </div>
          </div>
        )}
      </div>
      <ProjectEditorDialog
        open={creating}
        project={null}
        onClose={() => setCreating(false)}
        onSaved={(project) => {
          setCreating(false);
          void choose(project);
        }}
      />
    </>
  );
}

export function nextProjectPickerIndex(current: number, length: number, key: string): number {
  if (length <= 0) return -1;
  if (key === 'Home') return 0;
  if (key === 'End') return length - 1;
  if (key === 'ArrowUp') return current <= 0 ? length - 1 : current - 1;
  return current < 0 || current >= length - 1 ? 0 : current + 1;
}

export function isProjectPickerNavigationKey(key: string, fromSearchInput: boolean): boolean {
  if (key === 'ArrowDown' || key === 'ArrowUp') return true;
  return !fromSearchInput && (key === 'Home' || key === 'End');
}

export function filterProjectsByQuery(
  projects: readonly ProjectSummary[],
  foldersByProject: Readonly<Record<string, readonly ProjectFolder[]>>,
  query: string,
): ProjectSummary[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === '') return [...projects];
  return projects.filter((project) => {
    const folders = foldersByProject[project.id] ?? [];
    return [project.name, ...folders.flatMap(({ label, path }) => [label, path])].some((value) =>
      value.toLocaleLowerCase().includes(needle),
    );
  });
}

export function projectSelectionAction(
  task: Pick<TaskSummary, 'hasConversation'>,
  _project: ProjectSummary | null,
): { kind: 'reassign' } | { kind: 'create' } {
  return task.hasConversation === false ? { kind: 'reassign' } : { kind: 'create' };
}
