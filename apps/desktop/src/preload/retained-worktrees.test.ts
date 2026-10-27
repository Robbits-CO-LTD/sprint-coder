// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from 'vitest';
import {
  IPC_CHANNELS,
  type SprintCoderApi,
  type TeamRetainedWorktreeCursor,
} from '@sprint-coder/contracts';
const bridge = vi.hoisted(() => ({
  expose: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  send: vi.fn(),
}));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: bridge.expose },
  ipcRenderer: bridge,
}));
await import('./index');
const api: SprintCoderApi = bridge.expose.mock.calls[0]![1];
const cursor: TeamRetainedWorktreeCursor = {
  taskId: 'task',
  teamId: 'team',
  assignedAt: '2026-10-27T00:00:00.000Z',
  executionId: 'e200',
  repositoryOrdinal: 1,
};
beforeEach(() => {
  bridge.invoke.mockReset();
  bridge.invoke.mockImplementation(async (_channel: string, envelope: { requestId: string }) => ({
    ok: true,
    requestId: envelope.requestId,
    value: { worktrees: [], total: 201, nextCursor: cursor },
  }));
});
describe('retained worktree paging IPC', () => {
  it('sends a typed cursor and validates the returned next cursor', async () => {
    const result = await api.teams.listRetainedWorktrees('task', cursor);
    expect(result.nextCursor).toEqual(cursor);
    expect(bridge.invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.teamsListRetainedWorktrees,
      expect.objectContaining({ payload: { taskId: 'task', cursor } }),
    );
  });
  it('keeps the first-page call compatible and rejects cross-Task cursors before IPC', async () => {
    await api.teams.listRetainedWorktrees('task');
    expect(bridge.invoke).toHaveBeenLastCalledWith(
      IPC_CHANNELS.teamsListRetainedWorktrees,
      expect.objectContaining({ payload: { taskId: 'task' } }),
    );
    await expect(api.teams.listRetainedWorktrees('other', cursor)).rejects.toThrow();
    expect(bridge.invoke).toHaveBeenCalledTimes(1);
  });
});
