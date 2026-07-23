import { execFile } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { devNull } from 'node:os';
import { join } from 'node:path';

// Independent git-worktree isolation manager for write-capable Workers. Each agent gets
// its own worktree under `worktreesRoot`, checked out --detach from a base ref, so a
// Worker's file mutations never touch the primary checkout. This module does not import
// command-runner.ts; it re-implements its own sandboxed git invocation.

export type WorktreeErrorCode =
  'git_unavailable' | 'create_failed' | 'dirty' | 'remove_failed' | 'invalid_input';

export class WorktreeError extends Error {
  constructor(
    readonly code: WorktreeErrorCode,
    message: string,
    options?: Readonly<{ cause?: unknown }>,
  ) {
    super(message, options);
    this.name = 'WorktreeError';
  }
}

export type ExecFileResult = Readonly<{ stdout: string; stderr: string }>;

export type ExecFileOptions = Readonly<{
  env: NodeJS.ProcessEnv;
  timeout?: number;
}>;

export type ExecFileImpl = (
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
) => Promise<ExecFileResult>;

export type WorkerWorktreeManagerOptions = Readonly<{
  worktreesRoot: string;
  execFileImpl?: ExecFileImpl;
}>;

export type CreateWorktreeInput = Readonly<{
  agentId: string;
  repoPath: string;
  baseRef?: string;
}>;

export type CreateWorktreeResult = Readonly<{
  path: string;
  baseHead: string;
}>;

export type CleanupWorktreeInput = Readonly<{
  agentId: string;
  repoPath: string;
}>;

export type CleanupWorktreeResult = Readonly<{
  outcome: 'removed' | 'quarantined';
}>;

const AGENT_ID_PATTERN = /^[0-9a-zA-Z-]+$/;
const GIT_TIMEOUT_MS = 30_000;

export class WorkerWorktreeManager {
  private readonly worktreesRoot: string;
  private readonly execFileImpl: ExecFileImpl;

  constructor(options: WorkerWorktreeManagerOptions) {
    this.worktreesRoot = options.worktreesRoot;
    this.execFileImpl = options.execFileImpl ?? defaultExecFile;
  }

  /** Deterministic worktree directory for an agent. Throws invalid_input for a bad id. */
  worktreePathFor(agentId: string): string {
    validateAgentId(agentId);
    return join(this.worktreesRoot, `worktree-${agentId}`);
  }

  async create({
    agentId,
    repoPath,
    baseRef = 'HEAD',
  }: CreateWorktreeInput): Promise<CreateWorktreeResult> {
    const worktreePath = this.worktreePathFor(agentId);
    if (await pathExists(worktreePath))
      throw new WorktreeError('create_failed', `worktree already exists: ${worktreePath}`);
    await mkdir(this.worktreesRoot, { recursive: true });
    await this.runGit(
      repoPath,
      ['worktree', 'add', '--detach', worktreePath, baseRef],
      'create_failed',
    );
    const { stdout } = await this.runGit(worktreePath, ['rev-parse', 'HEAD'], 'create_failed');
    return { path: worktreePath, baseHead: stdout.trim() };
  }

  async cleanup({ agentId, repoPath }: CleanupWorktreeInput): Promise<CleanupWorktreeResult> {
    const worktreePath = this.worktreePathFor(agentId);
    if (!(await pathExists(worktreePath))) {
      await this.runGit(repoPath, ['worktree', 'prune'], 'remove_failed');
      return { outcome: 'removed' };
    }
    const { stdout: statusOutput } = await this.runGit(
      worktreePath,
      ['status', '--porcelain'],
      'remove_failed',
    );
    // Cleanup policy: never destroy work. If the worktree has any changes, quarantine it
    // (leave it on disk, untouched) instead of removing it.
    if (statusOutput.trim().length > 0) return { outcome: 'quarantined' };
    try {
      await this.runGit(repoPath, ['worktree', 'remove', worktreePath], 'remove_failed');
    } catch (error) {
      // Defensive: a race could dirty the worktree between our status check and the
      // remove call. Surface that distinctly rather than reporting a generic failure.
      if (error instanceof WorktreeError && /modified or untracked files/i.test(error.message))
        throw new WorktreeError('dirty', error.message, { cause: error });
      throw error;
    }
    return { outcome: 'removed' };
  }

  private async runGit(
    dirArg: string,
    subArgs: readonly string[],
    failureCode: Exclude<WorktreeErrorCode, 'git_unavailable' | 'invalid_input'>,
  ): Promise<ExecFileResult> {
    try {
      return await this.execFileImpl('git', ['-c', 'core.hooksPath=', '-C', dirArg, ...subArgs], {
        env: sanitizedGitEnv(),
        timeout: GIT_TIMEOUT_MS,
      });
    } catch (error) {
      if (error instanceof WorktreeError) throw error;
      if (isEnoent(error))
        throw new WorktreeError('git_unavailable', 'git binary not found on PATH', {
          cause: error,
        });
      throw new WorktreeError(failureCode, errorMessage(error), { cause: error });
    }
  }
}

function validateAgentId(agentId: string): void {
  if (!AGENT_ID_PATTERN.test(agentId))
    throw new WorktreeError('invalid_input', `invalid agentId: ${JSON.stringify(agentId)}`);
}

function sanitizedGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const path = process.env['PATH'];
  const home = process.env['HOME'];
  if (path !== undefined) env['PATH'] = path;
  if (home !== undefined) env['HOME'] = home;
  env['GIT_TERMINAL_PROMPT'] = '0';
  env['GIT_CONFIG_GLOBAL'] = devNull;
  env['GIT_CONFIG_SYSTEM'] = devNull;
  return env;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
}

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const defaultExecFile: ExecFileImpl = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args as string[],
      { env: options.env, timeout: options.timeout },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
      },
    );
  });
