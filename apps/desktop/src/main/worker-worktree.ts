import { execFile } from 'node:child_process';
import { lstat, mkdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { safeGitExec } from './safe-git';

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
  platform?: NodeJS.Platform;
  delay?: (milliseconds: number) => Promise<void>;
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

export type CleanupUnchangedWorktreeInput = CleanupWorktreeInput & Readonly<{ baseHead: string }>;
/**
 * `changed: true` marks a worktree kept because its HEAD or status differs from its base: it will
 * never qualify, so a caller need not retry it. A worktree kept for any other reason (a Windows
 * lock that outlasted the backoff) may qualify on a later attempt.
 */
export type CleanupUnchangedWorktreeResult = CleanupWorktreeResult & Readonly<{ changed?: true }>;

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
export type SealedWorktreeChange = Readonly<{ status: 'A' | 'D' | 'M' | 'T'; path: string }>;

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
  private readonly platform: NodeJS.Platform;
  private readonly delay: (milliseconds: number) => Promise<void>;

  constructor(options: WorkerWorktreeManagerOptions) {
    this.worktreesRoot = options.worktreesRoot;
    this.execFileImpl = options.execFileImpl ?? defaultExecFile;
    this.platform = options.platform ?? process.platform;
    this.delay =
      options.delay ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
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
      const repoPath = await this.resolveRepositoryPath(rootPath);
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

  /** Resolve the lock namespace without rejecting another integration's temporary working state. */
  async resolveRepositoryPath(rootPath: string): Promise<string> {
    const result = await this.runGit(rootPath, ['rev-parse', '--show-toplevel'], 'create_failed');
    const repoPath = await realpath(resolve(result.stdout.trim()));
    if (!isAbsolute(repoPath))
      throw new WorktreeError('create_failed', 'Git returned an invalid repository path');
    return repoPath;
  }

  /** Deterministic worktree directory for an execution or agent. */
  worktreePathFor(worktreeId: string): string {
    validateWorktreeId(worktreeId);
    return join(this.worktreesRoot, `worktree-${worktreeId}`);
  }

  /** True only for the exact deterministic directory owned by this app instance. */
  ownsWorktreePath(worktreeId: string, candidatePath: string): boolean {
    const expected = resolve(this.worktreePathFor(worktreeId));
    const candidate = resolve(candidatePath);
    return this.platform === 'win32'
      ? expected.toLocaleLowerCase('en-US') === candidate.toLocaleLowerCase('en-US')
      : expected === candidate;
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

  /** Metadata inventory only. The caller must separately bind the actual bytes and path identities. */
  async inspectPreserved(input: CreateWorktreeInput & { path: string; baseHead: string }) {
    validateGitHead(input.baseHead);
    const worktreeId = input.worktreeId ?? input.agentId;
    if (!this.ownsWorktreePath(worktreeId, input.path))
      throw new WorktreeError('invalid_input', 'Preserved worktree path does not match its owner');
    if (!(await lstat(input.path)).isDirectory())
      throw new WorktreeError('invalid_input', 'Preserved worktree must be its own directory');
    const path = await realpath(input.path);
    if ((await this.resolveRepositoryPath(path)) !== path)
      throw new WorktreeError('invalid_input', 'Preserved worktree was replaced');
    const common = async (root: string) =>
      realpath(
        resolve(
          root,
          (
            await this.runGit(root, ['rev-parse', '--git-common-dir'], 'create_failed')
          ).stdout.trim(),
        ),
      );
    const commonPath = await common(input.repoPath);
    if ((await common(path)) !== commonPath)
      throw new WorktreeError('invalid_input', 'Preserved worktree belongs to another repository');
    const registered = (
      await this.runGit(input.repoPath, ['worktree', 'list', '--porcelain', '-z'], 'create_failed')
    ).stdout;
    // Git uses forward slashes on Windows. Normalize that spelling without folding case or
    // accepting another checkout, and recheck the matching entry's actual filesystem target.
    const entry = registered
      .split('\0')
      .find(
        (line) =>
          line.startsWith('worktree ') &&
          isAbsolute(line.slice(9)) &&
          resolve(line.slice(9)) === path,
      );
    if (!entry || (await realpath(entry.slice(9))) !== path)
      throw new WorktreeError('invalid_input', 'Preserved worktree is not registered');
    const head = (await this.runGit(path, ['rev-parse', 'HEAD'], 'create_failed')).stdout.trim();
    validateGitHead(head);
    if (
      (
        await this.runGit(path, ['merge-base', input.baseHead, head], 'create_failed')
      ).stdout.trim() !== input.baseHead
    )
      throw new WorktreeError(
        'base_changed',
        'Preserved worktree is no longer based on its recorded base',
      );
    const gitPath = async (name: string) =>
      resolve(
        path,
        (await this.runGit(path, ['rev-parse', '--git-path', name], 'create_failed')).stdout.trim(),
      );
    for (const marker of [
      'MERGE_HEAD',
      'CHERRY_PICK_HEAD',
      'REVERT_HEAD',
      'rebase-apply',
      'rebase-merge',
    ])
      if (await pathExists(await gitPath(marker)))
        throw new WorktreeError(
          'base_changed',
          'Preserved worktree has an unfinished Git operation',
        );
    const files = async (args: string[]) =>
      (await this.runGit(path, args, 'create_failed')).stdout.split('\0').filter(Boolean);
    const changedFiles = [
      ...new Set([
        ...(await files([
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--no-renames',
          '--name-only',
          '-z',
          input.baseHead,
          '--',
        ])),
        ...(await files([
          'diff',
          '--cached',
          '--no-ext-diff',
          '--no-textconv',
          '--no-renames',
          '--name-only',
          '-z',
          input.baseHead,
          '--',
        ])),
        ...(await files(['ls-files', '--others', '--exclude-standard', '-z'])),
      ]),
    ].sort();
    if (
      changedFiles.length > 500 ||
      changedFiles.some((file) => file.length > 4096 || file.includes('\ufffd'))
    )
      throw new WorktreeError(
        'invalid_input',
        'Preserved file inventory exceeds the review boundary',
      );
    return {
      path,
      commonPath,
      head,
      baseHead: input.baseHead,
      indexPath: await gitPath('index'),
      changedFiles,
    };
  }

  async cleanup({
    agentId,
    repoPath,
    worktreeId = agentId,
  }: CleanupWorktreeInput): Promise<CleanupWorktreeResult> {
    validateWorktreeId(agentId);
    const worktreePath = this.worktreePathFor(worktreeId);
    if (!(await pathExists(worktreePath)))
      return this.removeMissingWorktreeRegistration(repoPath, worktreePath);
    const { stdout: statusOutput } = await this.runGit(
      worktreePath,
      ['status', '--porcelain'],
      'remove_failed',
    );
    // Cleanup policy: never destroy work. If the worktree has any changes, quarantine it
    // (leave it on disk, untouched) instead of removing it.
    if (statusOutput.trim().length > 0) return { outcome: 'quarantined' };
    return this.removeRegisteredWorktree(repoPath, worktreePath);
  }

  /**
   * Remove a terminal worktree only when HEAD is still exactly `baseHead` and status is empty.
   * A Worker commit is clean in `git status`, so HEAD is checked before any removal. Ignored
   * files do not block removal: they are never integrated, and `git worktree remove` deletes
   * them with the directory.
   */
  async cleanupUnchanged({
    agentId,
    repoPath,
    worktreeId = agentId,
    baseHead,
  }: CleanupUnchangedWorktreeInput): Promise<CleanupUnchangedWorktreeResult> {
    validateWorktreeId(agentId);
    validateGitHead(baseHead);
    const worktreePath = this.worktreePathFor(worktreeId);
    if (!(await pathExists(worktreePath)))
      return this.removeMissingWorktreeRegistration(repoPath, worktreePath);
    if (await this.differsFromBase(worktreePath, baseHead, 'remove_failed'))
      return { outcome: 'quarantined', changed: true };
    return this.removeRegisteredWorktree(repoPath, worktreePath);
  }

  /**
   * Whether a worktree differs from its base by the same test `cleanupUnchanged` uses: HEAD moved
   * (a commit, including one an earlier Attempt left) or status shows any change. Reads only.
   */
  async hasChangesFromBase({
    agentId,
    worktreeId = agentId,
    baseHead,
  }: Readonly<{ agentId: string; worktreeId?: string; baseHead: string }>): Promise<boolean> {
    validateWorktreeId(agentId);
    validateGitHead(baseHead);
    const worktreePath = this.worktreePathFor(worktreeId);
    // The same codes `finalizeChanges` reports when it reads this worktree before integration.
    if (!(await pathExists(worktreePath)))
      throw new WorktreeError('create_failed', `worktree does not exist: ${worktreePath}`);
    return this.differsFromBase(worktreePath, baseHead, 'integration_failed');
  }

  private async differsFromBase(
    worktreePath: string,
    baseHead: string,
    code: Exclude<WorktreeErrorCode, 'git_unavailable' | 'invalid_input'>,
  ): Promise<boolean> {
    const head = (await this.runGit(worktreePath, ['rev-parse', 'HEAD'], code)).stdout.trim();
    if (head !== baseHead) return true;
    const status = await this.runGit(
      worktreePath,
      ['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none'],
      code,
    );
    return status.stdout.trim().length > 0;
  }

  /**
   * The directory is already gone, so unregister only this worktree. `git worktree prune` would
   * also drop every other registration whose directory is missing, including the user's own
   * worktrees on an unplugged drive. A registration Git refuses to remove (for example a locked
   * one) stays, and the error reaches the caller so it records the reason.
   */
  private async removeMissingWorktreeRegistration(
    repoPath: string,
    worktreePath: string,
  ): Promise<CleanupWorktreeResult> {
    try {
      await this.runGit(repoPath, ['worktree', 'remove', worktreePath], 'remove_failed');
    } catch (error) {
      // Nothing is registered at this path any more: there is nothing left to remove.
      if (error instanceof WorktreeError && /is not a working tree/i.test(error.message))
        return { outcome: 'removed' };
      throw error;
    }
    return { outcome: 'removed' };
  }

  private async removeRegisteredWorktree(
    repoPath: string,
    worktreePath: string,
  ): Promise<CleanupWorktreeResult> {
    try {
      await this.runGit(repoPath, ['worktree', 'remove', worktreePath], 'remove_failed');
    } catch (error) {
      // Defensive: a race could dirty the worktree between our status check and the
      // remove call. Surface that distinctly rather than reporting a generic failure.
      if (error instanceof WorktreeError && /modified or untracked files/i.test(error.message))
        throw new WorktreeError('dirty', error.message, { cause: error });
      if (this.platform === 'win32' && isPermissionDenied(error)) {
        for (const delayMs of [100, 200, 400, 800, 1_600, 3_200]) {
          await this.delay(delayMs);
          try {
            await this.runGit(repoPath, ['worktree', 'remove', worktreePath], 'remove_failed');
            return { outcome: 'removed' };
          } catch (retryError) {
            if (!isPermissionDenied(retryError)) throw retryError;
          }
        }
        return { outcome: 'quarantined' };
      }
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
      ['diff', '--cached', '--no-renames', '--name-only', '-z', baseHead],
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

  /** Inspect immutable commits rather than trusting a Worker report or a mutable worktree. */
  async readSealedChanges(input: IntegrateWorktreeInput): Promise<readonly SealedWorktreeChange[]> {
    validateGitHead(input.baseHead);
    validateGitHead(input.workerHead);
    const ancestry = await this.runGit(
      input.repoPath,
      ['rev-list', '--parents', '-n', '1', input.workerHead],
      'integration_failed',
    );
    const [head, ...parents] = ancestry.stdout.trim().split(' ');
    if (
      head !== input.workerHead ||
      (head !== input.baseHead && (parents.length !== 1 || parents[0] !== input.baseHead))
    )
      throw new WorktreeError(
        'integration_failed',
        'Worker changes are not a single sealed commit',
      );
    const result = await this.runGit(
      input.repoPath,
      [
        '-c',
        'core.quotePath=true',
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-renames',
        '--name-status',
        input.baseHead,
        input.workerHead,
        '--',
      ],
      'integration_failed',
    );
    return result.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const status = line[0];
        if (
          line[1] !== '\t' ||
          (status !== 'A' && status !== 'D' && status !== 'M' && status !== 'T')
        )
          throw new WorktreeError('integration_failed', 'Unsupported sealed change status');
        const path = decodeGitChangePath(line.slice(2).replace(/\r$/u, ''));
        if (
          path === '' ||
          path.split('/').some((part) => part === '' || part === '.' || part === '..') ||
          path.includes('\0')
        )
          throw new WorktreeError('integration_failed', 'Invalid sealed change path');
        return { status, path };
      });
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
      return await safeGitExec(this.execFileImpl, dirArg, subArgs, {
        env: process.env,
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

function decodeGitChangePath(value: string): string {
  if (!value.startsWith('"')) {
    if (/[^\x20-\x7e]/u.test(value))
      throw new WorktreeError('integration_failed', 'Unquoted Git path bytes');
    return value;
  }
  if (!value.endsWith('"'))
    throw new WorktreeError('integration_failed', 'Invalid quoted Git path');
  const bytes: number[] = [];
  const escapes: Record<string, number> = {
    a: 7,
    b: 8,
    t: 9,
    n: 10,
    v: 11,
    f: 12,
    r: 13,
    '\\': 92,
    '"': 34,
  };
  for (let i = 1; i < value.length - 1; i++) {
    const char = value[i]!;
    if (char !== '\\') {
      if (char === '"' || char.charCodeAt(0) < 32 || char.charCodeAt(0) >= 127)
        throw new WorktreeError('integration_failed', 'Invalid quoted Git path');
      bytes.push(char.charCodeAt(0));
      continue;
    }
    const escaped = value[++i]!;
    if (i >= value.length - 1)
      throw new WorktreeError('integration_failed', 'Invalid Git path escape');
    if (Object.hasOwn(escapes, escaped)) bytes.push(escapes[escaped]!);
    else {
      const octal = value.slice(i, i + 3);
      if (!/^[0-3][0-7]{2}$/u.test(octal))
        throw new WorktreeError('integration_failed', 'Invalid Git path escape');
      bytes.push(Number.parseInt(octal, 8));
      i += 2;
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      Uint8Array.from(bytes),
    );
  } catch {
    throw new WorktreeError('integration_failed', 'Git change path is not valid UTF-8');
  }
}

function validateWorktreeId(worktreeId: string): void {
  if (!WORKTREE_ID_PATTERN.test(worktreeId))
    throw new WorktreeError('invalid_input', `invalid worktree id: ${JSON.stringify(worktreeId)}`);
}

function validateGitHead(head: string): void {
  if (!/^[0-9a-f]{40,64}$/i.test(head))
    throw new WorktreeError('invalid_input', `invalid Git object id: ${JSON.stringify(head)}`);
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

function isPermissionDenied(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = 'code' in error ? String((error as NodeJS.ErrnoException).code ?? '') : '';
  if (code === 'EACCES' || code === 'EPERM') return true;
  if (/permission denied|access (?:is )?denied/i.test(error.message)) return true;
  return 'cause' in error && isPermissionDenied((error as Error & { cause?: unknown }).cause);
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
