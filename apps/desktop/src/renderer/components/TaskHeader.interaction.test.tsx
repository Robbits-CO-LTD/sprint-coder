// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../store/appStore';
import type { TaskSummary } from '../types/sprint-coder';
import { TaskHeader } from './TaskHeader';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const task: TaskSummary = {
  id: 'task-ime',
  projectId: null,
  title: 'Original title',
  pinned: false,
  archived: false,
  goal: null,
  goalState: null,
  workspacePath: null,
  localOnly: true,
  createdAt: '2026-09-30T00:00:00.000Z',
  updatedAt: '2026-09-30T00:00:00.000Z',
};

let root: Root;
let container: HTMLDivElement;
const renameTask = vi.fn(async () => {});
const originalRenameTask = useAppStore.getState().renameTask;

beforeEach(() => {
  renameTask.mockClear();
  useAppStore.setState({ renameTask });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<TaskHeader task={task} onToggleTeam={() => {}} />));
  act(() => container.querySelector<HTMLButtonElement>('.task-title')!.click());
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useAppStore.setState({ renameTask: originalRenameTask });
});

function input() {
  return container.querySelector<HTMLInputElement>('.task-title-input')!;
}

function changeTitle(value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), value);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function keydown(key: string, isComposing = false) {
  const event = new KeyboardEvent('keydown', { key, isComposing, bubbles: true, cancelable: true });
  act(() => input().dispatchEvent(event));
  return event;
}

describe('Task title editing keyboard events', () => {
  it.each(['Enter', 'Escape'])(
    'leaves composing %s to the IME without saving or closing',
    (key) => {
      changeTitle('にほんご');
      const event = keydown(key, true);
      expect(renameTask).not.toHaveBeenCalled();
      expect(input()?.value).toBe('にほんご');
      expect(event.defaultPrevented).toBe(false);
    },
  );

  it('saves once on a separate Enter after composition ends', () => {
    act(() => input().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
    changeTitle('にほんご');
    keydown('Enter', true);
    expect(renameTask).not.toHaveBeenCalled();
    act(() =>
      input().dispatchEvent(
        new CompositionEvent('compositionend', { bubbles: true, data: '日本語' }),
      ),
    );
    changeTitle(' 日本語 ');
    expect(renameTask).not.toHaveBeenCalled();
    expect(keydown('Enter').defaultPrevented).toBe(true);
    expect(renameTask).toHaveBeenCalledExactlyOnceWith(task.id, '日本語');
    expect(input()).toBeNull();
  });

  it('focuses and selects the existing title when editing begins', () => {
    expect(document.activeElement).toBe(input());
    expect(input().selectionStart).toBe(0);
    expect(input().selectionEnd).toBe(task.title.length);
  });

  it('saves a trimmed title once with ordinary Enter', () => {
    changeTitle(' Updated title ');
    keydown('Enter');
    expect(renameTask).toHaveBeenCalledExactlyOnceWith(task.id, 'Updated title');
    expect(input()).toBeNull();
  });

  it('cancels ordinary Escape without saving the draft', () => {
    changeTitle('Updated title');
    keydown('Escape');
    expect(renameTask).not.toHaveBeenCalled();
    expect(input()).toBeNull();
    act(() => container.querySelector<HTMLButtonElement>('.task-title')!.click());
    expect(input().value).toBe(task.title);
  });

  it('preserves blur saving', () => {
    changeTitle(' Updated title ');
    act(() => input().blur());
    expect(renameTask).toHaveBeenCalledExactlyOnceWith(task.id, 'Updated title');
    expect(input()).toBeNull();
  });

  it.each(['   ', task.title, ` ${task.title} `])(
    'does not rename an empty or unchanged title: %j',
    (title) => {
      changeTitle(title);
      keydown('Enter');
      expect(renameTask).not.toHaveBeenCalled();
      expect(input()).toBeNull();
    },
  );
});
