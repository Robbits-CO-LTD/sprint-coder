import { execFile } from 'node:child_process';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { devNull } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

// Independent git-worktree isolation manager for write-capable Workers. Each agent gets
// its own worktree under `worktreesRoot`, checked out --detach from a base ref, so a
// Worker's file mutations never touch the primary checkout. This module does not import
// command-runner.ts; it re-implements its own sandboxed git invocation.

export type WorktreeErrorCode =
  | 'git_unavailable'
  | 'create_failed'
  | 'dirty'
  | 'base_changed'
  | 'integration_failed'
  | 'remove_failed'
  | 'invalid_input';

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
  worktreeId?: string;
}>;

export type CreateWorktreeResult = Readonly<{
  path: string;
  baseHead: string;
}>;

export type CleanupWorktreeInput = Readonly<{
  agentId: string;
  repoPath: string;
  worktreeId?: string;
}>;

export type CleanupWorktreeResult = Readonly<{
  outcome: 'removed' | 'quarantined';
}>;

export type FinalizeWorktreeInput = Readonly<{
  agentId: string;
  repoPath: string;
  baseHead: string;
  worktreeId?: string;
  commitMessage: string;
}>;

export type FinalizeWorktreeResult = Readonly<{
  workerHead: string;
  changedFiles: readonly string[];
}>;

export type IntegrateWorktreeInput = Readonly<{
  repoPath: string;
  baseHead: string;
  workerHead: string;
}>;

export type IntegrateWorktreeResult = Readonly<{
  integratedHead: string;
  outcome: 'integrated' | 'already_integrated' | 'no_changes';
}>;

export type RevalidateWorktreeIntegrationInput = IntegrateWorktreeInput &
  Readonly<{ integratedHead: string }>;

export type CleanRepositoryBase = Readonly<{ head: string }>;
export type CleanRepository = Readonly<{
  repoPath: string;
  head: string;
  rootPaths: readonly string[];
}>;

const WORKTREE_ID_PATTERN = /^[0-9a-zA-Z-]+$/;
const GIT_TIMEOUT_MS = 30_000;
const WORKER_GIT_IDENTITY = [
  '-c',
  'user.name=Sprint Coder Worker',
  '-c',
  'user.email=worker@sprint-coder.local',
] as const;

export class WorkerWorktreeManager {
  private readonly worktreesRoot: string;
  private readonly execFileImpl: ExecFileImpl;

  constructor(options: WorkerWorktreeManagerOptions) {
    this.worktreesRoot = options.worktreesRoot;
    this.execFileImpl = options.execFileImpl ?? defaultExecFile;
  }

  async requireCleanBase(repoPath: string): Promise<CleanRepositoryBase> {
    const { stdout } = await this.runGit(repoPath, ['rev-parse', 'HEAD'], 'create_failed');
    const head = stdout.trim();
    validateGitHead(head);
    const status = await this.runGit(repoPath, ['status', '--porcelain'], 'create_failed');
    if (status.stdout.trim() !== '')
      throw new WorktreeError(
        'base_changed',
        'Workspace must be clean before a workspace-write Mission step starts',
      );
    return { head };
  }

  async requireCleanRepositorySet(
    rootPaths: readonly string[],
  ): Promise<readonly CleanRepository[]> {
    if (rootPaths.length === 0) throw new WorktreeError('invalid_input', 'Workspace has no roots');
    const rootsByRepository = new Map<string, string[]>();
    for (const rootPath of rootPaths) {
      const result = await this.runGit(rootPath, ['rev-parse', '--show-toplevel'], 'create_failed');
      const repoPath = await realpath(resolve(result.stdout.trim()));
      if (!isAbsolute(repoPath))
        throw new WorktreeError('create_failed', 'Git returned an invalid repository path');
      const roots = rootsByRepository.get(repoPath) ?? [];
      roots.push(await realpath(resolve(rootPath)));
      rootsByRepository.set(repoPath, roots);
    }
    const repoPaths = [...rootsByRepository.keys()].sort();
    for (const [index, repoPath] of repoPaths.entries())
      for (const candidate of repoPaths.slice(index + 1))
        if (isInside(repoPath, candidate) || isInside(candidate, repoPath))
          throw new WorktreeError(
            'create_failed',
            'Nested Git repositories cannot share a workspace-write execution',
          );
    const repositories: CleanRepository[] = [];
    for (const repoPath of repoPaths) {
      const { head } = await this.requireCleanBase(repoPath);
      for (const marker of [
        'MERGE_HEAD',
        'CHERRY_PICK_HEAD',
        'REVERT_HEAD',
        'BISECT_LOG',
        'rebase-apply',
        'rebase-merge',
      ]) {
        const gitPath = await this.runGit(
          repoPath,
          ['rev-parse', '--git-path', marker],
          'create_failed',
        );
        if (await pathExists(resolve(repoPath, gitPath.stdout.trim())))
          throw new WorktreeError(
            'base_changed',
            'Git operation is already in progress in a workspace repository',
          );
      }
      repositories.push(
        Object.freeze({
          repoPath,
          head,
          rootPaths: Object.freeze(rootsByRepository.get(repoPath)!),
        }),
      );
    }
    return Object.freeze(repositories);
  }

  /** Deterministic worktree directory for an execution or agent. */
  worktreePathFor(worktreeId: string): string {
    validateWorktreeId(worktreeId);
    return join(this.worktreesRoot, `worktree-${worktreeId}`);
  }

  async create({
    agentId,
    repoPath,
    baseRef = 'HEAD',
    worktreeId = agentId,
  }: CreateWorktreeInput): Promise<CreateWorktreeResult> {
    validateWorktreeId(agentId);
    const worktreePath = this.worktreePathFor(worktreeId);
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

  async ensureCreated(input: CreateWorktreeInput): Promise<CreateWorktreeResult> {
    const worktreeId = input.worktreeId ?? input.agentId;
    const worktreePath = this.worktreePathFor(worktreeId);
    if (!(await pathExists(worktreePath))) return this.create(input);
    const expectedHead = (
      await this.runGit(input.repoPath, ['rev-parse', input.baseRef ?? 'HEAD'], 'create_failed')
    ).stdout.trim();
    validateGitHead(expectedHead);
    const { stdout } = await this.runGit(worktreePath, ['rev-parse', 'HEAD'], 'create_failed');
    const head = stdout.trim();
    if (head !== expectedHead)
      throw new WorktreeError(
        'create_failed',
        `Existing worktree HEAD does not match its preparing record: expected ${expectedHead}, got ${head}`,
      );
    const status = await this.runGit(worktreePath, ['status', '--porcelain'], 'create_failed');
    if (status.stdout.trim() !== '')
      throw new WorktreeError('dirty', 'Existing preparing worktree contains unsealed changes');
    return { path: worktreePath, baseHead: head };
  }

  async cleanup({
    agentId,
    repoPath,
    worktreeId = agentId,
  }: CleanupWorktreeInput): Promise<CleanupWorktreeResult> {
    validateWorktreeId(agentId);
    const worktreePath = this.worktreePathFor(worktreeId);
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

  /**
   * Collapse everything a Worker did (including its own commits) into one detached commit.
   * The primary checkout is not touched by this operation.
   */
  async finalizeChanges({
    agentId,
    repoPath,
    baseHead,
    worktreeId = agentId,
    commitMessage,
  }: FinalizeWorktreeInput): Promise<FinalizeWorktreeResult> {
    validateWorktreeId(agentId);
    validateGitHead(baseHead);
    if (commitMessage.trim() === '')
      throw new WorktreeError('invalid_input', 'commitMessage must not be empty');
    const worktreePath = this.worktreePathFor(worktreeId);
    if (!(await pathExists(worktreePath)))
      throw new WorktreeError('create_failed', `worktree does not exist: ${worktreePath}`);
    await this.runGit(worktreePath, ['reset', '--soft', baseHead], 'integration_failed');
    await this.runGit(worktreePath, ['add', '--all'], 'integration_failed');
    const { stdout: changedOutput } = await this.runGit(
      worktreePath,
      ['diff', '--cached', '--name-only', '-z', baseHead],
      'integration_failed',
    );
    const changedFiles = changedOutput.split('\0').filter((path) => path !== '');
    if (changedFiles.length === 0) return { workerHead: baseHead, changedFiles: [] };
    await this.runGit(
      worktreePath,
      [
        ...WORKER_GIT_IDENTITY,
        'commit',
        '--no-verify',
        '--no-gpg-sign',
        '-m',
        commitMessage.slice(0, 500),
      ],
      'integration_failed',
    );
    const { stdout } = await this.runGit(worktreePath, ['rev-parse', 'HEAD'], 'integration_failed');
    const workerHead = stdout.trim();
    validateGitHead(workerHead);
    // Make sure callers cannot accidentally integrate a commit from another repository.
    const common = await this.runGit(
      repoPath,
      ['merge-base', baseHead, workerHead],
      'integration_failed',
    );
    if (common.stdout.trim() !== baseHead)
      throw new WorktreeError('integration_failed', 'Worker commit is not based on expected HEAD');
    return { workerHead, changedFiles };
  }

  /** Integrate onto a clean descendant of baseHead. A failed cherry-pick is always aborted. */
  async integrate({
    repoPath,
    baseHead,
    workerHead,
  }: IntegrateWorktreeInput): Promise<IntegrateWorktreeResult> {
    validateGitHead(baseHead);
    validateGitHead(workerHead);
    const currentHead = (
      await this.runGit(repoPath, ['rev-parse', 'HEAD'], 'integration_failed')
    ).stdout.trim();
    const status = await this.runGit(repoPath, ['status', '--porcelain'], 'integration_failed');
    if (status.stdout.trim() !== '')
      throw new WorktreeError(
        'base_changed',
        'Workspace has changes outside the isolated Worker worktree',
      );
    const baseIsAncestor =
      currentHead === baseHead ||
      (await this.tryRunGit(repoPath, ['merge-base', '--is-ancestor', baseHead, currentHead])) !==
        null;
    if (!baseIsAncestor)
      throw new WorktreeError(
        'base_changed',
        `Workspace HEAD is not descended from Worker base: ${baseHead} -> ${currentHead}`,
      );
    if (workerHead === baseHead) return { integratedHead: currentHead, outcome: 'no_changes' };
    if (currentHead !== baseHead) {
      const workerTree = (
        await this.runGit(repoPath, ['rev-parse', `${workerHead}^{tree}`], 'integration_failed')
      ).stdout.trim();
      const currentTree = (
        await this.runGit(repoPath, ['rev-parse', 'HEAD^{tree}'], 'integration_failed')
      ).stdout.trim();
      const currentParent = await this.tryRunGit(repoPath, ['rev-parse', 'HEAD^']);
      if (currentTree === workerTree && currentParent?.stdout.trim() === baseHead)
        return { integratedHead: currentHead, outcome: 'already_integrated' };
      const equivalentCommit = await this.findEquivalentIntegratedCommit(
        repoPath,
        baseHead,
        currentHead,
        workerHead,
      );
      if (equivalentCommit !== null)
        return { integratedHead: equivalentCommit, outcome: 'already_integrated' };
    }
    try {
      await this.runGit(
        repoPath,
        [...WORKER_GIT_IDENTITY, 'cherry-pick', '--no-gpg-sign', workerHead],
        'integration_failed',
      );
    } catch (error) {
      await this.tryRunGit(repoPath, ['cherry-pick', '--abort']);
      if (error instanceof WorktreeError)
        throw new WorktreeError('integration_failed', error.message, { cause: error });
      throw error;
    }
    const integratedHead = (
      await this.runGit(repoPath, ['rev-parse', 'HEAD'], 'integration_failed')
    ).stdout.trim();
    await this.assertEquivalentCommitPatch(repoPath, baseHead, workerHead, integratedHead);
    return { integratedHead, outcome: 'integrated' };
  }

  async revalidateIntegration({
    repoPath,
    baseHead,
    workerHead,
    integratedHead,
  }: RevalidateWorktreeIntegrationInput): Promise<IntegrateWorktreeResult> {
    for (const head of [baseHead, workerHead, integratedHead]) validateGitHead(head);
    const currentHead = (
      await this.runGit(repoPath, ['rev-parse', 'HEAD'], 'integration_failed')
    ).stdout.trim();
    const status = await this.runGit(repoPath, ['status', '--porcelain'], 'integration_failed');
    if (status.stdout.trim() !== '')
      throw new WorktreeError(
        'base_changed',
        'Workspace has changes outside the isolated Worker worktree',
      );
    if (
      currentHead !== integratedHead &&
      (await this.tryRunGit(repoPath, [
        'merge-base',
        '--is-ancestor',
        integratedHead,
        currentHead,
      ])) === null
    )
      throw new WorktreeError(
        'base_changed',
        `Workspace HEAD no longer contains integrated commit: ${integratedHead}`,
      );
    if (workerHead !== baseHead) {
      await this.assertEquivalentCommitPatch(repoPath, baseHead, workerHead, integratedHead);
    }
    return { integratedHead, outcome: 'already_integrated' };
  }

  private async assertEquivalentCommitPatch(
    repoPath: string,
    baseHead: string,
    workerHead: string,
    integratedHead: string,
  ): Promise<void> {
    if (!(await this.commitTreeMatchesWorker(repoPath, baseHead, integratedHead, workerHead)))
      throw new WorktreeError(
        'integration_failed',
        'Integrated patch does not match the isolated Worker result',
      );
  }

  private async findEquivalentIntegratedCommit(
    repoPath: string,
    baseHead: string,
    currentHead: string,
    workerHead: string,
  ): Promise<string | null> {
    const history = await this.runGit(
      repoPath,
      ['rev-list', '--reverse', `${baseHead}..${currentHead}`],
      'integration_failed',
    );
    for (const candidate of history.stdout.split(/\r?\n/u).filter((line) => line !== ''))
      if (await this.commitTreeMatchesWorker(repoPath, baseHead, candidate, workerHead))
        return candidate;
    return null;
  }

  private async commitTreeMatchesWorker(
    repoPath: string,
    baseHead: string,
    candidateHead: string,
    workerHead: string,
  ): Promise<boolean> {
    const candidateParent = await this.tryRunGit(repoPath, ['rev-parse', `${candidateHead}^`]);
    if (candidateParent === null) return false;
    const expected = await this.tryRunGit(repoPath, [
      'merge-tree',
      '--write-tree',
      `--merge-base=${baseHead}`,
      candidateParent.stdout.trim(),
      workerHead,
    ]);
    if (expected === null) return false;
    const expectedTree = expected.stdout.split(/\r?\n/u)[0]?.trim();
    const candidateTree = (
      await this.runGit(repoPath, ['rev-parse', `${candidateHead}^{tree}`], 'integration_failed')
    ).stdout.trim();
    return expectedTree !== undefined && expectedTree === candidateTree;
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

  private async tryRunGit(
    dirArg: string,
    subArgs: readonly string[],
  ): Promise<ExecFileResult | null> {
    try {
      return await this.runGit(dirArg, subArgs, 'integration_failed');
    } catch {
      return null;
    }
  }
}

function isInside(parent: string, child: string): boolean {
  const fromParent = relative(parent, child);
  return (
    fromParent !== '' &&
    fromParent !== '..' &&
    !fromParent.startsWith(`..${sep}`) &&
    !isAbsolute(fromParent)
  );
}

function validateWorktreeId(worktreeId: string): void {
  if (!WORKTREE_ID_PATTERN.test(worktreeId))
    throw new WorktreeError('invalid_input', `invalid worktree id: ${JSON.stringify(worktreeId)}`);
}

function validateGitHead(head: string): void {
  if (!/^[0-9a-f]{40,64}$/i.test(head))
    throw new WorktreeError('invalid_input', `invalid Git object id: ${JSON.stringify(head)}`);
}

function sanitizedGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const path = process.env['PATH'];
  const home = process.env['HOME'];
  if (path !== undefined) env['PATH'] = path;
  if (home !== undefined) env['HOME'] = home;
  env['GIT_TERMINAL_PROMPT'] = '0';
  // Git for Windows rewrites Node's `\\.\nul` device path to `//./nul` and
  // rejects it as a config file. The native DOS device name is accepted by
  // Git while preserving the same "ignore ambient config" behavior.
  const nullConfig = process.platform === 'win32' ? 'NUL' : devNull;
  env['GIT_CONFIG_GLOBAL'] = nullConfig;
  env['GIT_CONFIG_SYSTEM'] = nullConfig;
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
