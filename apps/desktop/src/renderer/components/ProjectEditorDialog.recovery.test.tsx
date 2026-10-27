// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectFolder, ProjectFolderInput, ProjectSummary } from '../types/sprint-coder';
import { useAppStore } from '../store/appStore';
import { ProjectEditorDialog } from './ProjectEditorDialog';

const PARTIAL_ERROR =
  'フォルダ変更は保存済みです。Project名を保存できませんでした。再試行してください。';
const FOLDER_ERROR = 'Project foldersを保存できませんでした。';
const NAME_ERROR = 'Project名を保存できませんでした。';

const summary = (overrides: Partial<ProjectSummary> = {}): ProjectSummary => ({
  id: 'project-1',
  name: 'Original',
  archived: false,
  revision: 1,
  taskCount: 0,
  folderCount: 1,
  primaryFolder: { id: 'root-1', path: '/workspace/one', label: 'one' },
  lastActivityAt: '2026-10-26T00:00:00.000Z',
  createdAt: '2026-10-26T00:00:00.000Z',
  updatedAt: '2026-10-26T00:00:00.000Z',
  ...overrides,
});

type ReplaceRequest = {
  projectId: string;
  expectedRevision: number;
  folders: ProjectFolderInput[];
};
type UpdateRequest = { projectId: string; expectedRevision: number; name?: string };

// Mirrors the Main persistence contract: the revision CAS runs before any unchanged short-cut and
// every accepted write advances the revision by one.
function fakeProjectBoundary() {
  let row = summary();
  let folders: ProjectFolder[] = [
    {
      id: 'root-1',
      projectId: 'project-1',
      path: '/workspace/one',
      label: 'one',
      role: 'primary',
      ordinal: 0,
      status: 'available',
    },
  ];
  const replaceRequests: ReplaceRequest[] = [];
  const updateRequests: UpdateRequest[] = [];
  const failNext = { replace: false, update: false };
  let gate: Promise<void> | null = null;
  const boundary = {
    replaceRequests,
    updateRequests,
    failNext,
    current: () => row,
    hold(): () => void {
      let release!: () => void;
      gate = new Promise((resolve) => {
        release = resolve;
      });
      return release;
    },
    externalRename(name: string): void {
      row = { ...row, name, revision: row.revision + 1 };
    },
    api: {
      list: vi.fn(async () => [row]),
      pickFolders: vi.fn(),
      folders: {
        list: vi.fn(async () => folders),
        replace: vi.fn(async (request: ReplaceRequest) => {
          replaceRequests.push(structuredClone(request));
          if (gate !== null) await gate;
          if (failNext.replace) {
            failNext.replace = false;
            throw new Error('transient IPC failure');
          }
          if (request.expectedRevision !== row.revision) throw new Error('Stale Project revision');
          folders = request.folders.map((folder, ordinal) => ({
            id: folder.id ?? `root-${row.revision}-${ordinal}`,
            projectId: row.id,
            path: folder.path,
            label: folder.label ?? folder.path,
            role: folder.role,
            ordinal,
            status: 'available',
          }));
          const primary = folders.find(({ role }) => role === 'primary') ?? null;
          row = {
            ...row,
            revision: row.revision + 1,
            folderCount: folders.length,
            primaryFolder:
              primary === null
                ? null
                : { id: primary.id, path: primary.path, label: primary.label },
          };
          return row;
        }),
      },
      update: vi.fn(async (request: UpdateRequest) => {
        updateRequests.push(structuredClone(request));
        if (failNext.update) {
          failNext.update = false;
          throw new Error('transient IPC failure');
        }
        if (request.expectedRevision !== row.revision) throw new Error('Stale Project revision');
        if (request.name === undefined || request.name === row.name) return row;
        row = { ...row, name: request.name, revision: row.revision + 1 };
        return row;
      }),
      create: vi.fn(async (input: { name: string; folders: ProjectFolderInput[] }) =>
        summary({ id: 'project-new', name: input.name, folderCount: input.folders.length }),
      ),
    },
  };
  return boundary;
}

type Boundary = ReturnType<typeof fakeProjectBoundary>;

const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');
const mounted: { root: ReturnType<typeof createRoot>; container: HTMLElement }[] = [];

beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement): void {
      this.setAttribute('open', '');
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement): void {
      this.removeAttribute('open');
    },
  });
});

afterAll(() => {
  for (const [name, descriptor] of [
    ['showModal', originalShowModal],
    ['close', originalClose],
  ] as const) {
    if (descriptor === undefined) Reflect.deleteProperty(HTMLDialogElement.prototype, name);
    else Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
  }
});

let boundary: Boundary;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  boundary = fakeProjectBoundary();
  Object.defineProperty(window, 'sprintCoder', {
    configurable: true,
    value: { projects: boundary.api },
  });
  useAppStore.setState({ projects: [boundary.current()], error: null });
});

afterEach(async () => {
  for (const item of mounted.splice(0)) {
    await act(async () => item.root.unmount());
    item.container.remove();
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, 'sprintCoder');
});

// Sidebar keeps the ProjectSummary from when editing started, so the prop stays at the opening
// revision even after the store has absorbed newer summaries.
async function openEditor(project: ProjectSummary | null = summary()) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  const dialogOpenAtSave: boolean[] = [];
  const onSaved = vi.fn((_saved: ProjectSummary) => {
    dialogOpenAtSave.push(container.querySelector('dialog')!.hasAttribute('open'));
  });
  const render = (next: ProjectSummary | null) =>
    act(async () =>
      root.render(<ProjectEditorDialog open project={next} onClose={() => {}} onSaved={onSaved} />),
    );
  await render(project);
  const nameInput = () => container.querySelector<HTMLInputElement>('input[maxlength="120"]')!;
  const button = (label: string) =>
    [...container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === label,
    )!;
  return {
    onSaved,
    dialogOpenAtSave,
    rerender: render,
    alert: () => container.querySelector('[role="alert"]')?.textContent ?? null,
    name: () => nameInput().value,
    paths: () =>
      [...container.querySelectorAll('.project-folder-path')].map((node) => node.textContent),
    primaryPath: () =>
      container
        .querySelector('input[name="primary-folder"]:checked')
        ?.closest('li')
        ?.querySelector('.project-folder-path')?.textContent ?? null,
    async typeName(value: string) {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          nameInput(),
          value,
        );
        nameInput().dispatchEvent(new Event('input', { bubbles: true }));
      });
    },
    async pick(...paths: string[]) {
      boundary.api.pickFolders.mockResolvedValueOnce({
        canceled: false,
        folders: paths.map((path) => ({ path, label: path.split('/').at(-1)! })),
      });
      await act(async () => button('フォルダを選択').click());
    },
    async makePrimary(path: string) {
      const row = [...container.querySelectorAll('li')].find(
        (item) => item.querySelector('.project-folder-path')?.textContent === path,
      )!;
      await act(async () => row.querySelector<HTMLInputElement>('input[type="radio"]')!.click());
    },
    async save() {
      await act(async () => {
        container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
      });
    },
  };
}

const replaceRevisions = () =>
  boundary.replaceRequests.map(({ expectedRevision }) => expectedRevision);
const updateRevisions = () =>
  boundary.updateRequests.map(({ expectedRevision }) => expectedRevision);

describe('ProjectEditorDialog partial save recovery (#959)', () => {
  it('retries only the rename from the saved folder revision after the rename fails', async () => {
    const editor = await openEditor();
    await editor.pick('/workspace/two');
    await editor.typeName('Renamed');
    boundary.failNext.update = true;

    await editor.save();

    expect(replaceRevisions()).toEqual([1]);
    expect(updateRevisions()).toEqual([2]);
    expect(editor.alert()).toBe(PARTIAL_ERROR);
    expect(editor.name()).toBe('Renamed');
    expect(editor.paths()).toEqual(['/workspace/two']);
    expect(editor.onSaved).not.toHaveBeenCalled();
    expect(useAppStore.getState().projects[0]?.revision).toBe(2);

    await editor.save();

    expect(replaceRevisions()).toEqual([1]);
    expect(updateRevisions()).toEqual([2, 2]);
    expect(editor.alert()).toBeNull();
    expect(editor.onSaved).toHaveBeenCalledOnce();
    expect(editor.onSaved.mock.calls[0]![0]).toMatchObject({ name: 'Renamed', revision: 3 });
    expect(editor.dialogOpenAtSave).toEqual([false]);
  });

  it('asks to confirm the Task folder change once, not again for the name retry', async () => {
    const editor = await openEditor(summary({ taskCount: 2 }));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await editor.pick('/workspace/two');
    await editor.typeName('Renamed');
    boundary.failNext.update = true;

    await editor.save();
    await editor.save();

    expect(confirm).toHaveBeenCalledOnce();
    expect(replaceRevisions()).toEqual([1]);
    expect(updateRevisions()).toEqual([2, 2]);
    expect(editor.onSaved.mock.calls[0]![0]).toMatchObject({ name: 'Renamed', revision: 3 });
  });

  it('keeps a name edited after the partial failure and sends only that name', async () => {
    const editor = await openEditor();
    await editor.pick('/workspace/two');
    await editor.typeName('Renamed');
    boundary.failNext.update = true;
    await editor.save();

    await editor.typeName('Renamed again');
    await editor.save();

    expect(replaceRevisions()).toEqual([1]);
    expect(boundary.updateRequests.at(-1)).toMatchObject({
      expectedRevision: 2,
      name: 'Renamed again',
    });
    expect(editor.onSaved.mock.calls[0]![0]).toMatchObject({
      name: 'Renamed again',
      revision: 3,
    });
  });

  it('saves folders edited after the partial failure from the saved revision', async () => {
    const editor = await openEditor();
    await editor.pick('/workspace/two');
    await editor.typeName('Renamed');
    boundary.failNext.update = true;
    await editor.save();

    await editor.pick('/workspace/three');
    await editor.save();

    expect(replaceRevisions()).toEqual([1, 2]);
    expect(boundary.replaceRequests[1]!.folders.map(({ path }) => path)).toEqual([
      '/workspace/three',
    ]);
    expect(updateRevisions()).toEqual([2, 3]);
    expect(editor.onSaved.mock.calls[0]![0]).toMatchObject({ name: 'Renamed', revision: 4 });
  });

  it('adopts only the submitted folders as saved when the draft changes during the save', async () => {
    const editor = await openEditor();
    await editor.pick('/workspace/two', '/workspace/three');
    await editor.typeName('Renamed');
    boundary.failNext.update = true;
    const release = boundary.hold();

    await editor.save();
    await editor.typeName('Typed while saving');
    await editor.makePrimary('/workspace/three');
    await act(async () => release());

    expect(boundary.updateRequests).toMatchObject([{ expectedRevision: 2, name: 'Renamed' }]);
    expect(editor.alert()).toBe(PARTIAL_ERROR);
    expect(editor.name()).toBe('Typed while saving');
    expect(editor.primaryPath()).toBe('/workspace/three');

    await editor.save();

    expect(replaceRevisions()).toEqual([1, 2]);
    expect(boundary.replaceRequests[1]!.folders).toMatchObject([
      { path: '/workspace/two', role: 'secondary' },
      { path: '/workspace/three', role: 'primary' },
    ]);
    expect(updateRevisions()).toEqual([2, 3]);
    expect(editor.onSaved.mock.calls[0]![0]).toMatchObject({
      name: 'Typed while saving',
      revision: 4,
    });
  });

  it('keeps the opening revision and drafts when the folder replace itself fails', async () => {
    const editor = await openEditor();
    await editor.pick('/workspace/two');
    await editor.typeName('Renamed');
    boundary.failNext.replace = true;

    await editor.save();

    expect(replaceRevisions()).toEqual([1]);
    expect(boundary.updateRequests).toEqual([]);
    expect(editor.alert()).toBe(FOLDER_ERROR);
    expect(editor.name()).toBe('Renamed');
    expect(editor.paths()).toEqual(['/workspace/two']);

    await editor.save();

    expect(replaceRevisions()).toEqual([1, 1]);
    expect(updateRevisions()).toEqual([2]);
    expect(editor.onSaved.mock.calls[0]![0]).toMatchObject({ name: 'Renamed', revision: 3 });
  });

  it.each([
    {
      change: 'folders and name',
      edit: async (editor: Awaited<ReturnType<typeof openEditor>>) => {
        await editor.pick('/workspace/two');
        await editor.typeName('Renamed');
      },
      replace: [1],
      update: [2],
      saved: { name: 'Renamed', revision: 3 },
    },
    {
      change: 'name only',
      edit: (editor: Awaited<ReturnType<typeof openEditor>>) => editor.typeName('Renamed'),
      replace: [],
      update: [1],
      saved: { name: 'Renamed', revision: 2 },
    },
    {
      change: 'folders only',
      edit: (editor: Awaited<ReturnType<typeof openEditor>>) => editor.pick('/workspace/two'),
      replace: [1],
      update: [],
      saved: { name: 'Original', revision: 2 },
    },
  ])('saves $change with one pass and closes before onSaved', async (scenario) => {
    const editor = await openEditor();
    await scenario.edit(editor);

    await editor.save();

    expect(replaceRevisions()).toEqual(scenario.replace);
    expect(updateRevisions()).toEqual(scenario.update);
    expect(editor.onSaved).toHaveBeenCalledOnce();
    expect(editor.onSaved.mock.calls[0]![0]).toMatchObject(scenario.saved);
    expect(editor.dialogOpenAtSave).toEqual([false]);
  });

  it('creates a new Project through the existing single create call', async () => {
    const editor = await openEditor(null);
    await editor.pick('/workspace/new');
    await editor.typeName('New Project');

    await editor.save();

    expect(boundary.api.create).toHaveBeenCalledExactlyOnceWith({
      name: 'New Project',
      folders: [{ path: '/workspace/new', label: 'new', role: 'primary' }],
    });
    expect(boundary.api.folders.replace).not.toHaveBeenCalled();
    expect(boundary.api.update).not.toHaveBeenCalled();
    expect(editor.onSaved.mock.calls[0]![0]).toMatchObject({ id: 'project-new' });
  });

  it('reports a real revision conflict without adopting a refreshed same-ID summary', async () => {
    const editor = await openEditor();
    await editor.pick('/workspace/two');
    await editor.typeName('Renamed here');
    boundary.externalRename('Renamed elsewhere');
    await act(async () => useAppStore.getState().refreshProjects());
    await editor.rerender({ ...boundary.current() });

    await editor.save();
    await editor.save();

    expect(replaceRevisions()).toEqual([1, 1]);
    expect(boundary.updateRequests).toEqual([]);
    expect(editor.alert()).toBe(FOLDER_ERROR);
    expect(editor.name()).toBe('Renamed here');
    expect(editor.paths()).toEqual(['/workspace/two']);
    expect(editor.onSaved).not.toHaveBeenCalled();
    expect(boundary.current()).toMatchObject({ name: 'Renamed elsewhere', revision: 2 });
  });

  it('reports a name-only revision conflict with the plain name error', async () => {
    const editor = await openEditor();
    boundary.externalRename('Renamed elsewhere');
    await editor.typeName('Renamed here');

    await editor.save();

    expect(updateRevisions()).toEqual([1]);
    expect(editor.alert()).toBe(NAME_ERROR);
    expect(editor.name()).toBe('Renamed here');
    expect(editor.onSaved).not.toHaveBeenCalled();
  });

  it('does not claim saved folders for a name-only conflict after a newer same-ID prop', async () => {
    const editor = await openEditor();
    await editor.typeName('Renamed here');
    boundary.externalRename('Renamed elsewhere');
    await editor.rerender(summary({ name: 'Renamed elsewhere', revision: 99 }));

    await editor.save();

    expect(boundary.replaceRequests).toEqual([]);
    expect(updateRevisions()).toEqual([1]);
    expect(editor.alert()).toBe(NAME_ERROR);
    expect(editor.name()).toBe('Renamed here');
    expect(editor.onSaved).not.toHaveBeenCalled();
  });

  it('keeps the saved-folders wording after the prop catches up to the saved revision', async () => {
    const editor = await openEditor();
    await editor.pick('/workspace/two');
    await editor.typeName('Renamed');
    boundary.failNext.update = true;
    await editor.save();
    expect(editor.alert()).toBe(PARTIAL_ERROR);

    await editor.rerender({ ...boundary.current() });
    boundary.failNext.update = true;
    await editor.save();

    expect(replaceRevisions()).toEqual([1]);
    expect(updateRevisions()).toEqual([2, 2]);
    expect(editor.alert()).toBe(PARTIAL_ERROR);
    expect(editor.name()).toBe('Renamed');
    expect(editor.paths()).toEqual(['/workspace/two']);

    await editor.save();

    expect(updateRevisions()).toEqual([2, 2, 2]);
    expect(editor.onSaved).toHaveBeenCalledOnce();
    expect(editor.onSaved.mock.calls[0]![0]).toMatchObject({ name: 'Renamed', revision: 3 });
  });
});
