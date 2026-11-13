import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  TEAM_OFFER_WORKSPACE_CACHE_TTL_MS,
  TeamOfferWorkspaceGate,
  TeamWorkspaceRepositoryError,
  teamWorkspaceRepositoryMessage,
  workspaceRepositoryProblemOf,
} from './team-workspace-repository';
import { WorkerWorktreeManager, WorktreeError } from './worker-worktree';

const execFileAsync = promisify(execFile);
const gitAvailable = spawnSync('git', ['--version']).status === 0;
const TEST_IDENTITY = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com'];

describe('TeamOfferWorkspaceGate (issue #1241)', () => {
  function gate(
    options: {
      check?: (taskId: string) => Promise<void>;
      workspaceKey?: (taskId: string) => string | null;
      deadlineMs?: number;
    } = {},
  ) {
    let now = 1_000;
    const check = vi.fn(options.check ?? (async () => undefined));
    const workspaceKey = vi.fn(options.workspaceKey ?? (() => 'workspace-a'));
    const instance = new TeamOfferWorkspaceGate({
      check,
      workspaceKey,
      nowMs: () => now,
      ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
    });
    return { instance, check, workspaceKey, advance: (ms: number) => (now += ms) };
  }

  it('answers "not ready" until it has checked, so an unchecked Turn is never offered Team', () => {
    expect(gate().instance.isReady('task-1')).toBe(false);
  });

  it('remembers a passing check for the same Workspace while it lasts', async () => {
    const g = gate();
    await expect(g.instance.refresh('task-1')).resolves.toBe(true);
    expect(g.instance.isReady('task-1')).toBe(true);
    expect(g.instance.isReady('task-2')).toBe(false);
    g.advance(TEAM_OFFER_WORKSPACE_CACHE_TTL_MS);
    expect(g.instance.isReady('task-1')).toBe(true);
    g.advance(1);
    expect(g.instance.isReady('task-1')).toBe(false);
  });

  it('does not offer when the check is refused, throws, or outlasts its deadline', async () => {
    const refused = gate({
      check: async () => {
        throw new TeamWorkspaceRepositoryError('workspace_dirty');
      },
    });
    await expect(refused.instance.refresh('task-1')).resolves.toBe(false);
    expect(refused.instance.isReady('task-1')).toBe(false);

    const hung = gate({ check: () => new Promise<void>(() => undefined), deadlineMs: 20 });
    await expect(hung.instance.refresh('task-1')).resolves.toBe(false);
    expect(hung.instance.isReady('task-1')).toBe(false);

    const unreadable = gate({
      workspaceKey: () => {
        throw new Error('Task not found');
      },
    });
    await expect(unreadable.instance.refresh('task-1')).resolves.toBe(false);
    expect(unreadable.check).not.toHaveBeenCalled();
  });

  it('does not offer a Task without a Workspace, and never asks Git for it', async () => {
    const g = gate({ workspaceKey: () => null });
    await expect(g.instance.refresh('task-1')).resolves.toBe(false);
    expect(g.check).not.toHaveBeenCalled();
    expect(g.instance.isReady('task-1')).toBe(false);
  });

  it('drops an answer once the Task points at another Workspace', async () => {
    let key = 'workspace-a';
    const g = gate({ workspaceKey: () => key });
    await g.instance.refresh('task-1');
    key = 'workspace-b';
    expect(g.instance.isReady('task-1')).toBe(false);
  });

  it('turns "not ready" into "ready" on the next check once the folder is fixed', async () => {
    let committed = false;
    const g = gate({
      check: async () => {
        if (!committed) throw new TeamWorkspaceRepositoryError('workspace_not_git');
      },
    });
    await g.instance.refresh('task-1');
    expect(g.instance.isReady('task-1')).toBe(false);
    committed = true;
    await g.instance.refresh('task-1');
    expect(g.instance.isReady('task-1')).toBe(true);
    // And back: a later refusal (an uncommitted change) replaces the earlier pass at once.
    committed = false;
    await g.instance.refresh('task-1');
    expect(g.instance.isReady('task-1')).toBe(false);
  });
});

describe('workspaceRepositoryProblemOf', () => {
  it.each([
    [new WorktreeError('git_unavailable', 'git binary not found on PATH'), 'git_unavailable'],
    [new WorktreeError('invalid_input', 'Workspace has no roots'), 'workspace_missing'],
    [
      new WorktreeError(
        'create_failed',
        'Command failed: git rev-parse\nfatal: not a git repository (or any of the parent directories): .git',
      ),
      'workspace_not_git',
    ],
    [
      new WorktreeError(
        'create_failed',
        "fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.",
      ),
      'workspace_no_commit',
    ],
    [
      new WorktreeError(
        'create_failed',
        'Nested Git repositories cannot share a workspace-write execution',
      ),
      'workspace_nested_git',
    ],
    [
      new WorktreeError(
        'base_changed',
        'Workspace must be clean before a workspace-write Mission step starts',
      ),
      'workspace_dirty',
    ],
    [
      new WorktreeError(
        'base_changed',
        'Git operation is already in progress in a workspace repository',
      ),
      'workspace_git_operation',
    ],
  ] as const)('reads %s as %s', (error, problem) => {
    expect(workspaceRepositoryProblemOf(error)).toBe(problem);
  });

  it('leaves causes it cannot name to the caller', () => {
    expect(workspaceRepositoryProblemOf(new Error('root missing'))).toBeNull();
    expect(
      workspaceRepositoryProblemOf(new WorktreeError('create_failed', 'ENOENT: realpath')),
    ).toBeNull();
  });

  it('gives each cause its own message the Leader can pass on as it is', () => {
    const messages = [
      'workspace_missing',
      'workspace_not_git',
      'workspace_no_commit',
      'workspace_nested_git',
      'workspace_dirty',
      'workspace_git_operation',
      'git_unavailable',
    ].map((code) => teamWorkspaceRepositoryMessage(code as never));
    expect(new Set(messages).size).toBe(messages.length);
    expect(teamWorkspaceRepositoryMessage('workspace_not_git')).toContain('Git の管理下にない');
    expect(teamWorkspaceRepositoryMessage('workspace_no_commit')).toContain(
      'commit がまだ 1 つも無い',
    );
    expect(teamWorkspaceRepositoryMessage('workspace_dirty')).toContain(
      'commit していない変更がある',
    );
    expect(teamWorkspaceRepositoryMessage('workspace_dirty')).toContain(
      '変更を commit するか片付けてから、もう一度頼んでください',
    );
    const error = new TeamWorkspaceRepositoryError('workspace_dirty');
    expect(error.message).toBe(teamWorkspaceRepositoryMessage('workspace_dirty'));
    expect(error.code).toBe('workspace_dirty');
  });
});

// The same check assignment runs, on real folders: what offering Team and hiring now refuse.
describe.skipIf(!gitAvailable)('the assignment check on real folders (issue #1241)', () => {
  const cleanup: string[] = [];

  beforeEach(async () => {
    const home = await mkdtemp(join(tmpdir(), 'sprint-coder-offer-git-home-'));
    cleanup.push(home);
    await writeFile(join(home, '.gitconfig'), '[core]\n autocrlf = false\n');
    vi.stubEnv('HOME', home);
    vi.stubEnv('XDG_CONFIG_HOME', join(home, 'xdg'));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  async function folder(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), 'sprint-coder-offer-workspace-'));
    cleanup.push(path);
    await writeFile(join(path, 'a.txt'), 'a\n');
    return path;
  }

  async function git(cwd: string, args: readonly string[]): Promise<void> {
    await execFileAsync('git', ['-C', cwd, ...TEST_IDENTITY, ...args]);
  }

  async function problemOf(path: string): Promise<string | null> {
    const worktreesRoot = await mkdtemp(join(tmpdir(), 'sprint-coder-offer-worktrees-'));
    cleanup.push(worktreesRoot);
    const manager = new WorkerWorktreeManager({ worktreesRoot });
    try {
      await manager.requireCleanRepositorySet([path], { timeoutMs: 10_000 });
      return null;
    } catch (error) {
      return workspaceRepositoryProblemOf(error) ?? `unnamed: ${String(error)}`;
    }
  }

  it('names a plain folder, a repository without a commit, and uncommitted changes', async () => {
    const path = await folder();
    expect(await problemOf(path)).toBe('workspace_not_git');

    await git(path, ['init', '-q']);
    expect(await problemOf(path)).toBe('workspace_no_commit');

    await git(path, ['add', 'a.txt']);
    await git(path, ['commit', '-q', '-m', 'init']);
    expect(await problemOf(path)).toBeNull();

    // The user's own change: Team is not offered, and nothing here commits or discards it.
    await writeFile(join(path, 'a.txt'), 'the user is editing\n');
    expect(await problemOf(path)).toBe('workspace_dirty');
    const { stdout } = await execFileAsync('git', ['-C', path, 'status', '--porcelain']);
    expect(stdout).toContain('a.txt');

    await git(path, ['commit', '-q', '-am', 'save']);
    expect(await problemOf(path)).toBeNull();
  });
});
