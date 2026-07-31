import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { projectSidebarProjection, type ProjectSidebarGroup } from '../lib/project-sidebar';
import {
  Archive,
  ArchiveRestore,
  MoreHorizontal,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
} from './icons';
import { useTaskBoundary } from './TaskBoundary';
import type { ProjectSummary, TaskSummary } from '../types/sprint-coder';

const COLLAPSED_PROJECTS_KEY = 'sprint-coder:collapsed-projects';

function readCollapsedProjects(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(COLLAPSED_PROJECTS_KEY) ?? '[]');
    return new Set(
      Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [],
    );
  } catch {
    return new Set();
  }
}

function writeCollapsedProjects(projectIds: Set<string>): void {
  try {
    window.localStorage.setItem(COLLAPSED_PROJECTS_KEY, JSON.stringify([...projectIds]));
  } catch {
    // The preference is optional (private browsing / blocked storage); the sidebar still works.
  }
}

type DialogState =
  | { kind: 'create-project' }
  | { kind: 'rename-project'; project: ProjectSummary }
  | { kind: 'archive-project'; project: ProjectSummary }
  | { kind: 'create-task'; project: ProjectSummary }
  | { kind: 'move-task'; task: TaskSummary }
  | null;

export function Sidebar({
  inert,
  collapsed = false,
  onOpenSettings,
}: {
  inert?: boolean;
  collapsed?: boolean;
  onOpenSettings?: (() => void) | undefined;
} = {}) {
  const tasks = useAppStore((s) => s.tasks);
  const projects = useAppStore((s) => s.projects);
  const projectLoadState = useAppStore((s) => s.projectLoadState);
  const projectLoadError = useAppStore((s) => s.projectLoadError);
  const refreshProjects = useAppStore((s) => s.refreshProjects);
  const createProject = useAppStore((s) => s.createProject);
  const updateProject = useAppStore((s) => s.updateProject);
  const assignTask = useAppStore((s) => s.assignTaskToProject);
  const unassignTask = useAppStore((s) => s.unassignTaskFromProject);
  const selectedTaskId = useAppStore((s) => s.selectedTaskId);
  const setPinned = useAppStore((s) => s.setPinned);
  const setArchived = useAppStore((s) => s.setArchived);
  const { selectTask, createTask } = useTaskBoundary();
  const [query, setQuery] = useState('');
  const [collapsedProjects, setCollapsedProjects] = useState(readCollapsedProjects);
  const [archivedProjectsExpanded, setArchivedProjectsExpanded] = useState(false);
  const [archivedTaskGroups, setArchivedTaskGroups] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<DialogState>(null);
  const [dialogValue, setDialogValue] = useState('');
  const [moveTarget, setMoveTarget] = useState('');
  const [pending, setPending] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);

  const projection = useMemo(
    () => projectSidebarProjection(projects, tasks, query, selectedTaskId),
    [projects, tasks, query, selectedTaskId],
  );

  useEffect(() => {
    const element = dialogRef.current;
    if (dialog !== null && element && !element.open) element.showModal();
    if (dialog === null && element?.open) element.close();
  }, [dialog]);

  const focusLater = (selector: string, fallback = '[data-testid="sidebar-new-task-button"]') => {
    requestAnimationFrame(() => {
      // A Project move can change both its section and its disclosure in separate React commits.
      // The second frame waits for both without using a timing guess.
      requestAnimationFrame(() => {
        (
          document.querySelector<HTMLElement>(selector) ??
          document.querySelector<HTMLElement>(fallback)
        )?.focus({
          preventScroll: false,
        });
      });
    });
  };

  const completeDialog = (focusSelector: string): void => {
    // Close synchronously first: native <dialog> restores its opener on close. Focusing before that
    // restoration would be immediately overwritten and strand keyboard users on the old menu.
    dialogRef.current?.close();
    setDialog(null);
    focusLater(focusSelector);
  };

  const closeOpenMenus = (): void => {
    document
      .querySelectorAll<HTMLDetailsElement>('.sb-menu[open]')
      .forEach((menu) => menu.removeAttribute('open'));
  };

  const openDialog = (next: Exclude<DialogState, null>): void => {
    closeOpenMenus();
    setDialogValue(next.kind === 'rename-project' ? next.project.name : '');
    setMoveTarget(next.kind === 'move-task' ? (next.task.projectId ?? '') : '');
    setDialog(next);
  };

  const closeDialog = (): void => {
    if (pending) return;
    setDialog(null);
  };

  const toggleProject = (projectId: string): void => {
    setCollapsedProjects((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      writeCollapsedProjects(next);
      return next;
    });
  };

  const ensureProjectExpanded = (projectId: string): void => {
    setCollapsedProjects((current) => {
      if (!current.has(projectId)) return current;
      const next = new Set(current);
      next.delete(projectId);
      writeCollapsedProjects(next);
      return next;
    });
  };

  const submitDialog = async (): Promise<void> => {
    if (dialog === null) return;
    setPending(true);
    try {
      if (dialog.kind === 'create-project') {
        const created = await createProject(dialogValue);
        if (created === null) return;
        ensureProjectExpanded(created.id);
        completeDialog(`[data-project-heading="${created.id}"]`);
      } else if (dialog.kind === 'rename-project') {
        const updated = await updateProject(dialog.project.id, dialog.project.revision, {
          name: dialogValue,
        });
        if (updated === null) return;
        completeDialog(`[data-project-heading="${updated.id}"]`);
      } else if (dialog.kind === 'archive-project') {
        const updated = await updateProject(dialog.project.id, dialog.project.revision, {
          archived: true,
        });
        if (updated === null) return;
        setArchivedProjectsExpanded(true);
        ensureProjectExpanded(updated.id);
        completeDialog(`[data-project-heading="${updated.id}"]`);
      } else if (dialog.kind === 'create-task') {
        ensureProjectExpanded(dialog.project.id);
        const created = await createTask(dialog.project.id);
        if (created === null) return;
        completeDialog(`[data-task-id="${created.id}"]`);
      } else {
        const updated =
          moveTarget === ''
            ? await unassignTask(dialog.task.id)
            : await assignTask(dialog.task.id, moveTarget);
        if (updated === null) return;
        if (updated.projectId !== null) ensureProjectExpanded(updated.projectId);
        completeDialog(`[data-task-id="${updated.id}"]`);
      }
    } finally {
      setPending(false);
    }
  };

  const restoreProject = async (project: ProjectSummary): Promise<void> => {
    closeOpenMenus();
    const updated = await updateProject(project.id, project.revision, { archived: false });
    if (updated === null) return;
    ensureProjectExpanded(updated.id);
    focusLater(`[data-project-heading="${updated.id}"]`);
  };

  const initialProjectFailure = projectLoadState === 'loading' || projectLoadState === 'error';
  const canManageProjects = projectLoadState !== 'unavailable' && !initialProjectFailure;
  const hasAnything =
    projection.activeProjects.length > 0 ||
    projection.unassignedTasks.length > 0 ||
    projection.unassignedArchivedTasks.length > 0 ||
    projection.archivedProjects.length > 0;
  const rowProps = {
    selectedTaskId,
    onSelect: (taskId: string) => void selectTask(taskId),
    canManage: typeof window.sprintCoder?.tasks?.setPinned === 'function',
    activeProjects: projects.filter((project) => !project.archived),
    onMove: (task: TaskSummary) => openDialog({ kind: 'move-task', task }),
    onTogglePin: (task: TaskSummary) => void setPinned(task.id, !task.pinned),
    onToggleArchive: (task: TaskSummary) => void setArchived(task.id, !task.archived),
  };

  return (
    <nav
      className="sidebar"
      data-testid="sidebar"
      aria-label="Task履歴"
      aria-hidden={collapsed || undefined}
      inert={inert}
    >
      <div className="sb-new-row">
        <button
          type="button"
          className="sb-new"
          data-testid="sidebar-new-task-button"
          onClick={() => void createTask()}
        >
          <Plus size={15} /> 新しいタスク
        </button>
        {canManageProjects && (
          <button
            type="button"
            className="sb-icon-primary"
            aria-label="Projectを作成"
            title="Projectを作成"
            onClick={() => openDialog({ kind: 'create-project' })}
          >
            <Plus size={15} />
          </button>
        )}
      </div>
      <div className="sb-search">
        <Search size={14} />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Project・Taskを検索…"
          aria-label="Project・Taskを検索"
        />
      </div>
      <div className="sb-scroll">
        {projectLoadState === 'refreshing' && <div className="sb-status">Projectを更新中…</div>}
        {projectLoadState === 'unavailable' && (
          <div className="sb-status" role="status">
            Project機能はこの環境では利用できません。
          </div>
        )}
        {projectLoadState === 'stale' && (
          <div className="sb-status sb-status--warning" role="status">
            Projectの更新に失敗しました。前回の結果を表示しています。
            <button type="button" onClick={() => void refreshProjects()}>
              再試行
            </button>
          </div>
        )}
        {initialProjectFailure ? (
          <div className="sb-status" role={projectLoadState === 'error' ? 'alert' : 'status'}>
            {projectLoadState === 'loading' ? (
              'Projectを読み込み中…'
            ) : (
              <>
                Projectを読み込めませんでした。
                {projectLoadError && <span className="sr-only">{projectLoadError}</span>}
                <button type="button" onClick={() => void refreshProjects()}>
                  再試行
                </button>
              </>
            )}
          </div>
        ) : !hasAnything ? (
          <div className="sb-empty">Taskはまだありません</div>
        ) : (
          <>
            {projection.activeProjects.length > 0 && <div className="sb-section">Projects</div>}
            {projection.activeProjects.map((group) => (
              <ProjectGroup
                key={group.project.id}
                group={group}
                expanded={!collapsedProjects.has(group.project.id) || group.forceExpanded}
                archivedExpanded={
                  archivedTaskGroups.has(group.project.id) || group.forceArchivedExpanded
                }
                onToggle={() => toggleProject(group.project.id)}
                onToggleArchived={() =>
                  setArchivedTaskGroups((current) => {
                    const next = new Set(current);
                    if (next.has(group.project.id)) next.delete(group.project.id);
                    else next.add(group.project.id);
                    return next;
                  })
                }
                onCreateTask={() => openDialog({ kind: 'create-task', project: group.project })}
                onRename={() => openDialog({ kind: 'rename-project', project: group.project })}
                onArchive={() => openDialog({ kind: 'archive-project', project: group.project })}
                {...rowProps}
              />
            ))}
            {(projection.unassignedTasks.length > 0 ||
              projection.unassignedArchivedTasks.length > 0) && (
              <section aria-labelledby="unassigned-heading">
                <div className="sb-section" id="unassigned-heading">
                  Projectなし
                </div>
                {projection.unassignedTasks.map((task) => (
                  <TaskRow key={task.id} task={task} {...rowProps} />
                ))}
                <ArchivedTasks
                  tasks={projection.unassignedArchivedTasks}
                  expanded={
                    archivedTaskGroups.has('unassigned') ||
                    projection.forceUnassignedArchivedExpanded
                  }
                  onToggle={() =>
                    setArchivedTaskGroups((current) => {
                      const next = new Set(current);
                      if (next.has('unassigned')) next.delete('unassigned');
                      else next.add('unassigned');
                      return next;
                    })
                  }
                  {...rowProps}
                />
              </section>
            )}
            {projection.archivedProjects.length > 0 && (
              <section>
                <button
                  type="button"
                  className="sb-section sb-section--toggle"
                  aria-expanded={
                    archivedProjectsExpanded || projection.forceArchivedProjectsExpanded
                  }
                  onClick={() => setArchivedProjectsExpanded((value) => !value)}
                >
                  Archived Projects ({projection.archivedProjects.length})
                </button>
                {(archivedProjectsExpanded || projection.forceArchivedProjectsExpanded) &&
                  projection.archivedProjects.map((group) => (
                    <ProjectGroup
                      key={group.project.id}
                      group={group}
                      expanded={!collapsedProjects.has(group.project.id) || group.forceExpanded}
                      archivedExpanded={
                        archivedTaskGroups.has(group.project.id) || group.forceArchivedExpanded
                      }
                      onToggle={() => toggleProject(group.project.id)}
                      onToggleArchived={() =>
                        setArchivedTaskGroups((current) => {
                          const next = new Set(current);
                          if (next.has(group.project.id)) next.delete(group.project.id);
                          else next.add(group.project.id);
                          return next;
                        })
                      }
                      onRename={() =>
                        openDialog({ kind: 'rename-project', project: group.project })
                      }
                      onRestore={() => void restoreProject(group.project)}
                      {...rowProps}
                    />
                  ))}
              </section>
            )}
          </>
        )}
      </div>
      <button
        type="button"
        className="sb-footer"
        data-testid="sidebar-settings-button"
        onClick={onOpenSettings}
        disabled={onOpenSettings === undefined}
        title={onOpenSettings === undefined ? '設定は利用できません' : undefined}
      >
        <Settings size={15} /> 設定
      </button>

      <dialog
        ref={dialogRef}
        className="project-dialog"
        onCancel={(event) => {
          if (pending) {
            event.preventDefault();
            return;
          }
          closeDialog();
        }}
      >
        {dialog && (
          <form
            method="dialog"
            onSubmit={(event) => {
              event.preventDefault();
              void submitDialog();
            }}
          >
            <h2>{dialogTitle(dialog)}</h2>
            {dialog.kind === 'create-project' || dialog.kind === 'rename-project' ? (
              <label>
                Project名
                <input
                  autoFocus
                  required
                  minLength={1}
                  maxLength={120}
                  value={dialogValue}
                  onChange={(event) => setDialogValue(event.target.value)}
                />
              </label>
            ) : dialog.kind === 'move-task' ? (
              <label>
                移動先
                <select
                  autoFocus
                  value={moveTarget}
                  onChange={(event) => setMoveTarget(event.target.value)}
                >
                  <option value="">Projectなし</option>
                  {projects
                    .filter((project) => !project.archived)
                    .map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                </select>
              </label>
            ) : (
              <p>{dialogDescription(dialog)}</p>
            )}
            <div className="project-dialog-actions">
              <button type="button" disabled={pending} onClick={closeDialog}>
                キャンセル
              </button>
              <button
                type="submit"
                disabled={pending || !dialogCanSubmit(dialog, dialogValue, moveTarget)}
              >
                {pending ? '処理中…' : dialogSubmitLabel(dialog)}
              </button>
            </div>
          </form>
        )}
      </dialog>
    </nav>
  );
}

type RowProps = {
  selectedTaskId: string | null;
  onSelect: (taskId: string) => void;
  canManage: boolean;
  activeProjects: ProjectSummary[];
  onMove: (task: TaskSummary) => void;
  onTogglePin: (task: TaskSummary) => void;
  onToggleArchive: (task: TaskSummary) => void;
};

function ProjectGroup({
  group,
  expanded,
  archivedExpanded,
  onToggle,
  onToggleArchived,
  onCreateTask,
  onRename,
  onArchive,
  onRestore,
  ...rowProps
}: {
  group: ProjectSidebarGroup;
  expanded: boolean;
  archivedExpanded: boolean;
  onToggle: () => void;
  onToggleArchived: () => void;
  onCreateTask?: () => void;
  onRename?: () => void;
  onArchive?: () => void;
  onRestore?: () => void;
} & RowProps) {
  const { project, tasks, archivedTasks } = group;
  return (
    <section className="sb-project" aria-labelledby={`project-${project.id}`}>
      <div className="sb-project-heading">
        <button
          type="button"
          id={`project-${project.id}`}
          data-project-heading={project.id}
          className="sb-project-toggle"
          aria-expanded={expanded}
          onClick={onToggle}
          title={project.name}
        >
          <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
          <span>{project.name}</span>
          <span className="sb-count">{project.taskCount}</span>
        </button>
        <details className="sb-menu">
          <summary aria-label={`${project.name}のメニュー`} title="Projectメニュー">
            <MoreHorizontal size={15} />
          </summary>
          <div className="sb-menu-popover">
            {onCreateTask && <button onClick={onCreateTask}>新しいTask</button>}
            {onRename && <button onClick={onRename}>名前を変更</button>}
            {onArchive && <button onClick={onArchive}>アーカイブ</button>}
            {onRestore && <button onClick={onRestore}>復元</button>}
          </div>
        </details>
      </div>
      {expanded && (
        <div className="sb-project-tasks">
          {tasks.length === 0 && archivedTasks.length === 0 ? (
            <div className="sb-project-empty">Taskはありません</div>
          ) : (
            tasks.map((task) => <TaskRow key={task.id} task={task} {...rowProps} />)
          )}
          <ArchivedTasks
            tasks={archivedTasks}
            expanded={archivedExpanded}
            onToggle={onToggleArchived}
            {...rowProps}
          />
        </div>
      )}
    </section>
  );
}

function ArchivedTasks({
  tasks,
  expanded,
  onToggle,
  ...rowProps
}: { tasks: TaskSummary[]; expanded: boolean; onToggle: () => void } & RowProps) {
  if (tasks.length === 0) return null;
  return (
    <div className="sb-task-archive">
      <button type="button" aria-expanded={expanded} onClick={onToggle}>
        Archived ({tasks.length})
      </button>
      {expanded && tasks.map((task) => <TaskRow key={task.id} task={task} {...rowProps} />)}
    </div>
  );
}

function TaskRow({
  task,
  selectedTaskId,
  onSelect,
  canManage,
  activeProjects,
  onMove,
  onTogglePin,
  onToggleArchive,
}: { task: TaskSummary } & RowProps) {
  const isActive = task.id === selectedTaskId;
  return (
    <div className={`sb-row${isActive ? ' active' : ''}`} data-task-id={task.id} tabIndex={-1}>
      <button
        type="button"
        className="sb-item"
        aria-current={isActive ? 'true' : undefined}
        onClick={() => onSelect(task.id)}
        title={task.title}
      >
        {task.pinned && <Pin size={12} />}
        <span>{task.title || '無題のTask'}</span>
        {task.hasConversation === false && <span className="sb-unstarted">未開始</span>}
      </button>
      {canManage && (
        <details className="sb-menu sb-task-menu">
          <summary aria-label={`${task.title || '無題のTask'}のメニュー`}>
            <MoreHorizontal size={14} />
          </summary>
          <div className="sb-menu-popover">
            <button onClick={() => onTogglePin(task)}>
              {task.pinned ? <PinOff size={13} /> : <Pin size={13} />}
              {task.pinned ? 'ピンを解除' : 'ピン留め'}
            </button>
            <button onClick={() => onToggleArchive(task)}>
              {task.archived ? <ArchiveRestore size={13} /> : <Archive size={13} />}
              {task.archived ? '復元' : 'アーカイブ'}
            </button>
            {(task.projectId !== null || activeProjects.length > 0) && (
              <button onClick={() => onMove(task)}>Projectを移動</button>
            )}
          </div>
        </details>
      )}
    </div>
  );
}

function dialogTitle(dialog: Exclude<DialogState, null>): string {
  switch (dialog.kind) {
    case 'create-project':
      return 'Projectを作成';
    case 'rename-project':
      return 'Project名を変更';
    case 'archive-project':
      return 'Projectをアーカイブ';
    case 'create-task':
      return `${dialog.project.name}にTaskを作成`;
    case 'move-task':
      return 'Taskを移動';
  }
}

function dialogDescription(dialog: Exclude<DialogState, null>): string {
  if (dialog.kind === 'archive-project')
    return `「${dialog.project.name}」をアーカイブします。配下のTaskと設定は維持されます。`;
  if (dialog.kind === 'create-task')
    return `「${dialog.project.name}」に未開始のTaskを作成します。`;
  return '';
}

function dialogSubmitLabel(dialog: Exclude<DialogState, null>): string {
  if (dialog.kind === 'archive-project') return 'アーカイブ';
  if (dialog.kind === 'rename-project') return '保存';
  if (dialog.kind === 'move-task') return '移動';
  return '作成';
}

function dialogCanSubmit(
  dialog: Exclude<DialogState, null>,
  value: string,
  moveTarget: string,
): boolean {
  if (dialog.kind === 'create-project' || dialog.kind === 'rename-project') {
    const length = value.trim().length;
    return length >= 1 && length <= 120;
  }
  if (dialog.kind === 'move-task') return moveTarget !== (dialog.task.projectId ?? '');
  return true;
}
