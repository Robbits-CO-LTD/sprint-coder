import { describe, expect, it } from 'vitest';
import type { TaskSummary } from '../types/sprint-coder';
import { findReusableUnstartedTask } from './reusable-task';

const task = (overrides: Partial<TaskSummary> = {}): TaskSummary => ({
  id: 'task-a',
  projectId: null,
  title: '新しいタスク',
  pinned: false,
  archived: false,
  goal: null,
  goalState: null,
  workspacePath: null,
  localOnly: false,
  hasConversation: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

describe('findReusableUnstartedTask', () => {
  it('reuses an unstarted Task in the same place instead of making another', () => {
    const empty = task({ id: 'empty' });
    expect(findReusableUnstartedTask([empty], null, null)).toBe(empty);
  });

  it('makes a new Task once the conversation has started', () => {
    expect(
      findReusableUnstartedTask([task({ id: 'started', hasConversation: true })], null, null),
    ).toBeNull();
    // An unknown state is not treated as unstarted.
    expect(
      findReusableUnstartedTask([task({ id: 'unknown', hasConversation: undefined })], null, null),
    ).toBeNull();
  });

  it('makes a new Task when the Project differs', () => {
    const inProject = task({ id: 'in-project', projectId: 'project-a' });
    const loose = task({ id: 'loose', projectId: null });
    expect(findReusableUnstartedTask([inProject], null, null)).toBeNull();
    expect(findReusableUnstartedTask([loose], 'project-a', null)).toBeNull();
    expect(findReusableUnstartedTask([inProject, loose], 'project-b', null)).toBeNull();
    expect(findReusableUnstartedTask([inProject, loose], 'project-a', null)).toBe(inProject);
    expect(findReusableUnstartedTask([inProject, loose], null, null)).toBe(loose);
  });

  it('treats a missing projectId as no Project', () => {
    const legacy = task({ id: 'legacy', projectId: undefined as unknown as null });
    expect(findReusableUnstartedTask([legacy], null, null)).toBe(legacy);
  });

  it('does not reuse an archived Task', () => {
    expect(findReusableUnstartedTask([task({ archived: true })], null, null)).toBeNull();
  });

  it('skips Tasks the caller excludes, such as one whose first send is in flight', () => {
    const sending = task({ id: 'sending' });
    expect(findReusableUnstartedTask([sending], null, 'sending', (id) => id === 'sending')).toBe(
      null,
    );
  });

  it('prefers the selected Task, then the newest one', () => {
    const older = task({ id: 'older', createdAt: '2026-01-01T00:00:00.000Z' });
    const newer = task({ id: 'newer', createdAt: '2026-01-02T00:00:00.000Z' });
    expect(findReusableUnstartedTask([older, newer], null, null)).toBe(newer);
    expect(findReusableUnstartedTask([older, newer], null, 'older')).toBe(older);
    // A selected Task elsewhere does not change the pick.
    expect(findReusableUnstartedTask([older, newer], null, 'other')).toBe(newer);
  });
});
