// @vitest-environment jsdom
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../store/appStore';
import type { TaskSummary } from '../types/sprint-coder';
import { TeamListView } from './TeamListView';
import { TeamCanvas } from './TeamCanvas/TeamCanvas';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const task: TaskSummary = {
  id: 'task-recovery',
  projectId: null,
  title: 'Recovery',
  pinned: false,
  archived: false,
  goal: null,
  goalState: null,
  workspacePath: null,
  localOnly: true,
  createdAt: '2026-10-07T00:00:00Z',
  updatedAt: '2026-10-07T00:00:00Z',
};
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  useAppStore.setState({ teamByTask: {}, teamLoadFailedByTask: {} });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  window.matchMedia = vi
    .fn()
    .mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe.each(['list', 'canvas'] as const)('%s recovery controls', (view) => {
  it.each([
    ['loading', undefined, false, 'Teamを準備しています'],
    ['absent', null, false, 'このTaskにはTeamがありません'],
    ['failed', undefined, true, 'Teamを取得できませんでした'],
  ] as const)(
    'distinguishes %s and keeps Chat and view switching available',
    (_state, detail, failed, text) => {
      useAppStore.setState({
        teamByTask: { [task.id]: detail },
        teamLoadFailedByTask: { [task.id]: failed },
      });
      const back = vi.fn();
      const switchView = vi.fn();
      act(() =>
        root.render(
          view === 'list' ? (
            <TeamListView task={task} onBack={back} onSwitchToCanvasView={switchView} />
          ) : (
            <TeamCanvas
              task={task}
              leaderRef={createRef()}
              leaderAnchorRef={createRef()}
              onRequestExit={back}
              onSwitchToListView={switchView}
            />
          ),
        ),
      );
      expect(container.textContent).toContain(text);
      if (view === 'canvas') {
        const canvas = container.querySelector<HTMLElement>('[data-testid="team-list"]')!;
        expect(document.activeElement).toBe(canvas);
        for (const shiftKey of [false, true]) {
          const tab = new KeyboardEvent('keydown', {
            key: 'Tab',
            shiftKey,
            bubbles: true,
            cancelable: true,
          });
          act(() => canvas.dispatchEvent(tab));
          expect(tab.defaultPrevented).toBe(false);
        }
      }
      const backButton = container.querySelector<HTMLButtonElement>('[data-testid="team-back"]')!;
      const switchButton = container.querySelector<HTMLButtonElement>(
        '[data-testid="team-view-toggle"]',
      )!;
      backButton.focus();
      expect(document.activeElement).toBe(backButton);
      act(() => backButton.click());
      act(() => switchButton.click());
      expect(back).toHaveBeenCalledTimes(1);
      expect(switchView).toHaveBeenCalledTimes(1);
    },
  );
});
