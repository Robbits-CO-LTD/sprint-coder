import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectFolder, ProjectFolderInput, ProjectSummary } from '../types/sprint-coder';
import { useAppStore } from '../store/appStore';

export type DraftProjectFolder = Omit<
  Pick<ProjectFolder, 'id' | 'path' | 'label' | 'role' | 'status'>,
  'id'
> & {
  id?: string;
};

export function ProjectEditorDialog({
  open,
  project,
  onClose,
  onSaved,
}: {
  open: boolean;
  project: ProjectSummary | null;
  onClose: () => void;
  onSaved: (project: ProjectSummary) => void;
}) {
  if (!open) return null;
  return (
    <ProjectEditorDialogOpen
      key={project?.id ?? 'new-project'}
      project={project}
      onClose={onClose}
      onSaved={onSaved}
    />
  );
}

function ProjectEditorDialogOpen({
  project,
  onClose,
  onSaved,
}: {
  project: ProjectSummary | null;
  onClose: () => void;
  onSaved: (project: ProjectSummary) => void;
}) {
  const createProject = useAppStore((state) => state.createProject);
  const updateProject = useAppStore((state) => state.updateProject);
  const pickProjectFolders = useAppStore((state) => state.pickProjectFolders);
  const listProjectFolders = useAppStore((state) => state.listProjectFolders);
  const replaceProjectFolders = useAppStore((state) => state.replaceProjectFolders);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(project?.name ?? '');
  const [folders, setFolders] = useState<DraftProjectFolder[]>([]);
  const [originalFolders, setOriginalFolders] = useState<DraftProjectFolder[]>([]);
  const [loading, setLoading] = useState(project !== null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  useEffect(() => {
    if (project === null) return;
    let active = true;
    void listProjectFolders(project.id).then((loaded) => {
      if (!active) return;
      if (loaded === null) {
        setError('Project foldersを読み込めませんでした。再試行してください。');
        setLoadFailed(true);
        setLoading(false);
        return;
      }
      const next = loaded.map(({ id, path, label, role, status }) => ({
        id,
        path,
        label,
        role,
        status,
      }));
      setFolders(next);
      setOriginalFolders(next);
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [listProjectFolders, project]);

  const foldersChanged = useMemo(
    () => JSON.stringify(folderInputs(folders)) !== JSON.stringify(folderInputs(originalFolders)),
    [folders, originalFolders],
  );
  const validName = name.trim().length > 0 && name.trim().length <= 120;

  function finishSave(saved: ProjectSummary): void {
    // Close the native dialog before the parent schedules focus for the saved Project. Otherwise
    // the browser restores focus to the opener after `onSaved`, which cancels Sidebar's guarded
    // focus transfer and strands keyboard users on the create/edit button.
    dialogRef.current?.close();
    onSaved(saved);
  }

  async function chooseFolders(): Promise<void> {
    const picked = await pickProjectFolders();
    if (picked.canceled) return;
    setFolders(draftFoldersFromPicker(folders, picked.folders));
  }

  async function relinkFolder(index: number): Promise<void> {
    const picked = await pickProjectFolders();
    if (picked.canceled || picked.folders[0] === undefined) return;
    const selected = picked.folders[0];
    setFolders((current) =>
      current.map((folder, candidate) =>
        candidate === index
          ? { ...folder, path: selected.path, label: selected.label, status: 'available' }
          : folder,
      ),
    );
  }

  async function save(): Promise<void> {
    if (!validName || loading || loadFailed || pending) return;
    if (
      project !== null &&
      foldersChanged &&
      project.taskCount > 0 &&
      !window.confirm(
        `${project.taskCount}件の所属Taskへフォルダ変更を反映します。進行中の作業がある場合は保存が拒否されます。続けますか？`,
      )
    )
      return;
    setPending(true);
    setError(null);
    try {
      if (project === null) {
        const created = await createProject(name.trim(), folderInputs(folders));
        if (created === null) throw new Error('Projectを作成できませんでした。');
        finishSave(created);
        return;
      }
      let current = project;
      if (foldersChanged) {
        const replaced = await replaceProjectFolders(
          current.id,
          current.revision,
          folderInputs(folders),
        );
        if (replaced === null) throw new Error('Project foldersを保存できませんでした。');
        current = replaced;
      }
      if (name.trim() !== current.name) {
        const renamed = await updateProject(current.id, current.revision, { name: name.trim() });
        if (renamed === null) throw new Error('Project名を保存できませんでした。');
        current = renamed;
      }
      finishSave(current);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="project-dialog project-editor-dialog"
      onCancel={(event) => {
        if (pending) event.preventDefault();
        else onClose();
      }}
    >
      <form
        method="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <h2>{project === null ? '新しいProject' : 'Projectを編集'}</h2>
        <label>
          Project名
          <input
            autoFocus
            required
            maxLength={120}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <div className="project-folders-heading">
          <div>
            <strong>フォルダ</strong>
            <span>{folders.length}/16</span>
          </div>
          <button type="button" onClick={() => void chooseFolders()} disabled={pending}>
            フォルダを選択
          </button>
        </div>
        {loading ? (
          <p role="status">フォルダを読み込み中…</p>
        ) : folders.length === 0 ? (
          <p className="project-folders-empty">フォルダなしでもProjectを作成できます。</p>
        ) : (
          <ol className="project-folder-list">
            {folders.map((folder, index) => (
              <li key={folder.id ?? folder.path} data-folder-status={folder.status}>
                <label className="project-folder-primary">
                  <input
                    type="radio"
                    name="primary-folder"
                    checked={folder.role === 'primary'}
                    onChange={() =>
                      setFolders((current) =>
                        current.map((candidate, candidateIndex) => ({
                          ...candidate,
                          role: candidateIndex === index ? 'primary' : 'secondary',
                        })),
                      )
                    }
                  />
                  Primary
                </label>
                <span className="project-folder-label">{folder.label}</span>
                <span className="project-folder-path" title={folder.path}>
                  {folder.path}
                </span>
                {folder.status !== 'available' && (
                  <span className="project-folder-health" role="status">
                    {folderStatusLabel(folder.status)}
                  </span>
                )}
                <button type="button" onClick={() => void relinkFolder(index)} disabled={pending}>
                  再リンク
                </button>
                <button
                  type="button"
                  aria-label={`${folder.label}を削除`}
                  disabled={pending}
                  onClick={() => {
                    setFolders((current) =>
                      normalizePrimary(current.filter((_, i) => i !== index)),
                    );
                  }}
                >
                  削除
                </button>
              </li>
            ))}
          </ol>
        )}
        <button
          type="button"
          className="project-folders-clear"
          disabled={pending || folders.length === 0}
          onClick={() => setFolders([])}
        >
          0件へ変更
        </button>
        {error !== null && <p role="alert">{error}</p>}
        <div className="project-dialog-actions">
          <button type="button" disabled={pending} onClick={onClose}>
            キャンセル
          </button>
          <button type="submit" disabled={pending || loading || loadFailed || !validName}>
            {pending ? '保存中…' : project === null ? '作成' : '保存'}
          </button>
        </div>
      </form>
    </dialog>
  );
}

export function normalizePrimary(folders: DraftProjectFolder[]): DraftProjectFolder[] {
  if (folders.length === 0) return [];
  const primaryIndex = Math.max(
    0,
    folders.findIndex(({ role }) => role === 'primary'),
  );
  return folders.map((folder, index) => ({
    ...folder,
    role: index === primaryIndex ? 'primary' : 'secondary',
  }));
}

export function folderInputs(folders: DraftProjectFolder[]): ProjectFolderInput[] {
  return folders.map(({ id, path, label, role }) => ({
    ...(id === undefined ? {} : { id }),
    path,
    label,
    role,
  }));
}

export function draftFoldersFromPicker(
  current: readonly DraftProjectFolder[],
  picked: readonly { path: string; label: string }[],
): DraftProjectFolder[] {
  const existingByPath = new Map(current.map((folder) => [folder.path, folder]));
  return picked.map((folder, index) => {
    const existing = existingByPath.get(folder.path);
    return {
      ...(existing?.id === undefined ? {} : { id: existing.id }),
      path: folder.path,
      label: folder.label,
      role: index === 0 ? 'primary' : 'secondary',
      status: existing?.status ?? 'available',
    };
  });
}

function folderStatusLabel(status: ProjectFolder['status']): string {
  switch (status) {
    case 'missing':
      return '見つかりません';
    case 'unreadable':
      return '読取不能';
    case 'identity_changed':
      return '別のフォルダです';
    case 'available':
      return '利用可能';
  }
}
