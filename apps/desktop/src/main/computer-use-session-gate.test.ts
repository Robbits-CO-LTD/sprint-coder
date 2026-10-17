import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { computerUseSessionMayStart } from './computer-use-session-gate';

// #785 T15-E (5): a session does not begin in an archived Task.

function deps(
  options: {
    archived?: boolean;
    activeTurn?: string | null;
    busy?: boolean;
    throws?: boolean;
  } = {},
) {
  const getTask = vi.fn((_taskId: string) => {
    if (options.throws === true) throw new Error('Task not found');
    return { archived: options.archived ?? false };
  });
  const getActiveTurnId = vi.fn((_taskId: string) => options.activeTurn ?? null);
  return {
    persistence: { getTask, getActiveTurnId },
    hasBusyWorkers: vi.fn((_taskId: string) => options.busy === true),
    getTask,
    getActiveTurnId,
  };
}

describe('computerUseSessionMayStart (#785 T15-E (5))', () => {
  it('lets a panel start begin in an idle Task, and a computer_start in the Turn that runs it', () => {
    expect(computerUseSessionMayStart(deps(), 'task-1', null)).toBe(true);
    expect(computerUseSessionMayStart(deps({ activeTurn: 'turn-1' }), 'task-1', 'turn-1')).toBe(
      true,
    );
  });

  it('refuses an archived Task for both kinds of start, before asking anything else', () => {
    for (const owner of [null, 'turn-1']) {
      const archived = deps({ archived: true, activeTurn: owner });
      expect(computerUseSessionMayStart(archived, 'task-1', owner)).toBe(false);
      expect(archived.getActiveTurnId).not.toHaveBeenCalled();
      expect(archived.hasBusyWorkers).not.toHaveBeenCalled();
    }
  });

  it('refuses a Task that cannot be read', () => {
    expect(computerUseSessionMayStart(deps({ throws: true }), 'missing', null)).toBe(false);
  });

  it('keeps the rules it had: another Turn is running, a busy worker, a start from the panel in a running Task', () => {
    expect(computerUseSessionMayStart(deps({ activeTurn: 'turn-2' }), 'task-1', 'turn-1')).toBe(
      false,
    );
    expect(computerUseSessionMayStart(deps({ activeTurn: 'turn-1' }), 'task-1', null)).toBe(false);
    expect(computerUseSessionMayStart(deps({ busy: true }), 'task-1', null)).toBe(false);
  });

  it('is what the router hands the controller as canStartSession', () => {
    const router = readFileSync(join(__dirname, 'ipc.ts'), 'utf8').replace(/\s+/gu, ' ');
    expect(router).toContain("from './computer-use-session-gate'");
    expect(router).toContain(
      'canStartSession: (taskId, ownerTurnId) => computerUseSessionMayStart( { persistence: this.persistence, hasBusyWorkers: (id) => this.teamCoordinator.hasBusyWorkers(id), }, taskId, ownerTurnId, ),',
    );
  });
});
