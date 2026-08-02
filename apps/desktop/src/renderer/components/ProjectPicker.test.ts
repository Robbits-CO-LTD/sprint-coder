import { describe, expect, it } from 'vitest';
import type { ProjectFolder, ProjectSummary } from '../types/sprint-coder';
import {
  filterProjectsByQuery,
  nextProjectPickerIndex,
  projectSelectionAction,
} from './ProjectPicker';

const now = '2026-08-02T00:00:00.000Z';
const project = (id: string, name: string): ProjectSummary => ({
  id,
  name,
  archived: false,
  revision: 1,
  taskCount: 0,
  folderCount: 1,
  primaryFolder: null,
  lastActivityAt: now,
  createdAt: now,
  updatedAt: now,
});
const folder = (projectId: string, label: string, path: string): ProjectFolder => ({
  id: `${projectId}-root`,
  projectId,
  path,
  label,
  role: 'primary',
  ordinal: 0,
  status: 'available',
});

describe('Project picker projection', () => {
  const projects = [project('p1', 'Web App'), project('p2', 'API')];
  const folders = {
    p1: [folder('p1', 'test1', '/Users/yusei/test1')],
    p2: [folder('p2', 'backend', '/Users/yusei/services/api')],
  };

  it('searches Project name, folder label, and full path case-insensitively', () => {
    expect(filterProjectsByQuery(projects, folders, 'web').map(({ id }) => id)).toEqual(['p1']);
    expect(filterProjectsByQuery(projects, folders, 'TEST1').map(({ id }) => id)).toEqual(['p1']);
    expect(filterProjectsByQuery(projects, folders, 'services/api').map(({ id }) => id)).toEqual([
      'p2',
    ]);
  });

  it('wraps Arrow navigation and supports Home/End for the complete menu', () => {
    expect(nextProjectPickerIndex(-1, 5, 'ArrowDown')).toBe(0);
    expect(nextProjectPickerIndex(4, 5, 'ArrowDown')).toBe(0);
    expect(nextProjectPickerIndex(0, 5, 'ArrowUp')).toBe(4);
    expect(nextProjectPickerIndex(2, 5, 'Home')).toBe(0);
    expect(nextProjectPickerIndex(2, 5, 'End')).toBe(4);
  });

  it('reassigns only an unstarted Task and creates a new Task after conversation starts', () => {
    expect(projectSelectionAction({ hasConversation: false }, projects[0]!)).toEqual({
      kind: 'reassign',
    });
    expect(projectSelectionAction({ hasConversation: true }, projects[1]!)).toEqual({
      kind: 'create',
    });
    expect(projectSelectionAction({}, null)).toEqual({ kind: 'create' });
  });
});
