// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ProjectEditorDialog } from './ProjectEditorDialog';
import { useAppStore } from '../store/appStore';
import type { ProjectSummary } from '../types/sprint-coder';

const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const [name, descriptor] of [
    ['showModal', originalShowModal],
    ['close', originalClose],
  ] as const) {
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
  }
});

it('saves a same-path relink so the backend can refresh the folder identity', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = false;
    },
  });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  const project: ProjectSummary = {
    id: 'project',
    name: 'workspace',
    revision: 1,
    taskCount: 1,
    archived: false,
    folderCount: 1,
    primaryFolder: { id: 'root', path: '/workspace', label: 'workspace' },
    lastActivityAt: '2026-10-22T00:00:00Z',
    createdAt: '2026-10-22T00:00:00Z',
    updatedAt: '2026-10-22T00:00:00Z',
  };
  const folder = {
    id: 'root',
    projectId: project.id,
    path: '/workspace',
    label: 'workspace',
    role: 'primary' as const,
    status: 'identity_changed' as const,
  };
  const replace = vi.fn().mockResolvedValue({ ...project, revision: 2 });
  const previous = useAppStore.getState();
  useAppStore.setState({
    listProjectFolders: vi.fn().mockResolvedValue([folder]),
    pickProjectFolders: vi.fn().mockResolvedValue({
      canceled: false,
      folders: [{ path: folder.path, label: folder.label }],
    }),
    replaceProjectFolders: replace,
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const saved = vi.fn();
  try {
    await act(async () =>
      root.render(<ProjectEditorDialog open project={project} onClose={vi.fn()} onSaved={saved} />),
    );
    const relink = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === '再リンク',
    )!;
    await act(async () => relink.click());
    await act(async () =>
      container
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(replace).toHaveBeenCalledWith(project.id, 1, [
      {
        id: folder.id,
        path: folder.path,
        label: folder.label,
        role: 'primary',
      },
    ]);
    expect(saved).toHaveBeenCalledWith(expect.objectContaining({ revision: 2 }));
  } finally {
    await act(async () => root.unmount());
    container.remove();
    useAppStore.setState(previous, true);
    vi.unstubAllGlobals();
  }
});
