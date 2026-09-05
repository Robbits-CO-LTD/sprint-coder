// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { TaskRow } from './Sidebar';
import { useAppStore } from '../store/appStore';

it('clears a background running badge from the Task summary even with a stale Turn cache', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const task = {
    id: 'background',
    projectId: null,
    title: 'Background',
    pinned: false,
    archived: false,
    goal: null,
    goalState: null,
    workspacePath: null,
    localOnly: false,
    activeTurnId: 'turn-1' as string | null,
    createdAt: '2026-09-05T00:00:00.000Z',
    updatedAt: '2026-09-05T00:00:00.000Z',
  };
  useAppStore.setState({
    turnByTask: {
      background: {
        turnId: 'turn-1',
        status: 'running',
        stage: 'executing',
        runtimeStarting: false,
        reachedStageIndex: 2,
        startedAt: 0,
        streamingMessageId: null,
        streamingContent: '',
      },
    },
  });
  const container = document.createElement('div');
  const root = createRoot(container);
  const render = (activeTurnId: string | null) =>
    root.render(
      <TaskRow
        task={{ ...task, activeTurnId }}
        selectedTaskId="other"
        onSelect={vi.fn()}
        canManage={false}
        canMove={false}
        activeProjects={[]}
        onMove={vi.fn()}
        onTogglePin={vi.fn()}
        onToggleArchive={vi.fn()}
      />,
    );
  try {
    await act(async () => render('turn-1'));
    expect(container.querySelector('[aria-label="実行中"]')).not.toBeNull();
    await act(async () => render(null));
    expect(container.querySelector('[aria-label="実行中"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    useAppStore.setState({ turnByTask: {} });
    vi.unstubAllGlobals();
  }
});
