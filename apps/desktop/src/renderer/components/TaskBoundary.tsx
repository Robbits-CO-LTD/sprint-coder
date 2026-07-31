import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import type { TaskSummary } from '../types/sprint-coder';

export type TaskBoundaryActions = {
  selectTask: (taskId: string) => Promise<boolean>;
  createTask: (projectId?: string) => Promise<TaskSummary | null>;
};

const unavailableTaskBoundary: TaskBoundaryActions = {
  selectTask: async () => false,
  createTask: async () => null,
};

// Fail closed when a component is rendered outside App (SSR/component previews): actions are
// supplied by the shell so navigation remains consistent across Sidebar, Settings, and Composer.
const TaskBoundaryContext = createContext<TaskBoundaryActions>(unavailableTaskBoundary);

export function TaskBoundaryProvider({
  value,
  children,
}: {
  value: TaskBoundaryActions;
  children: ReactNode;
}) {
  return <TaskBoundaryContext.Provider value={value}>{children}</TaskBoundaryContext.Provider>;
}

export function useTaskBoundary(): TaskBoundaryActions {
  return useContext(TaskBoundaryContext);
}
