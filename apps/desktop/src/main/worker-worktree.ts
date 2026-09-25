import { execFile } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rmdir,
  stat,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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
  | 'invalid_input'
  /** A read whose Git output is larger than this manager reads at once. */
  | 'too_large'
  /** A worktree Git holds locked (`git worktree lock`), which a discard does not override. */
  | 'locked';

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
  maxBuffer?: number;
}>;

export type ExecFileImpl = (
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
) => Promise<ExecFileResult>;

/**
 * The file system calls `removeTreeWithoutFollowingLinks` makes. Tests replace them to make a
 * removal fail part way, independently of how a Node version's own recursive removal behaves.
 */
export type TreeRemovalFs = Readonly<{
  lstat(path: string): Promise<Readonly<{ isDirectory(): boolean; isSymbolicLink(): boolean }>>;
  readdir(path: string): Promise<string[]>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
}>;

export type WorkerWorktreeManagerOptions = Readonly<{
  worktreesRoot: string;
  execFileImpl?: ExecFileImpl;
  platform?: NodeJS.Platform;
  delay?: (milliseconds: number) => Promise<void>;
  treeRemovalFs?: TreeRemovalFs;
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

export type DiscardWorktreeInput = CleanupWorktreeInput &
  Readonly<{
    /** The path the caller recorded for this worktree. It must be this manager's own path. */
    path: string;
  }>;

export type InspectWorktreeChangesInput = DiscardWorktreeInput &
  Readonly<{
    baseHead: string;
    /** The most entries each list returns; the rest are only flagged as truncated. */
    limit: number;
  }>;

export type WorktreeChangeInspection = Readonly<{
  head: string;
  commitsSinceBase: number;
  status: readonly Readonly<{ code: string; path: string }>[];
  statusTruncated: boolean;
  changesFromBase: readonly Readonly<{ status: string; path: string }>[];
  changesFromBaseTruncated: boolean;
}>;

export type CleanupUnchangedWorktreeInput = CleanupWorktreeInput & Readonly<{ baseHead: string }>;
/**
 * Why a worktree that may still qualify (no `changed: true`) was kept, for a caller's diagnostic
 * (issue #588). `locked` is a `git worktree lock` (the user's, or one `git worktree add` left
 * behind); `busy` is a directory removal or Git worktree removal that a Windows lock (a file held
 * open) outlasted the retry backoff for. Neither ever names a path.
 */
export type CleanupUnchangedKeptReason = 'locked' | 'busy';
/**
 * `changed: true` marks a worktree kept because its HEAD or status differs from its base: it will
 * never qualify, so a caller need not retry it. A worktree kept for any other reason (a Windows
 * lock that outlasted the backoff) may qualify on a later attempt, and `reason` classifies why it
 * was kept this time (issue #588).
 */
export type CleanupUnchangedWorktreeResult = CleanupWorktreeResult &
  Readonly<{ changed?: true; reason?: CleanupUnchangedKeptReason }>;

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
/** How long a Windows lock on a worktree being removed is waited out before it is kept. */
const WINDOWS_REMOVE_RETRY_DELAYS_MS = [100, 200, 400, 800, 1_600, 3_200] as const;
/** Git file listings are read up to this size; a larger one is refused rather than cut. */
const GIT_LISTING_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
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
  private readonly treeRemovalFs: TreeRemovalFs;

  constructor(options: WorkerWorktreeManagerOptions) {
    this.worktreesRoot = options.worktreesRoot;
    this.execFileImpl = options.execFileImpl ?? defaultExecFile;
    this.platform = options.platform ?? process.platform;
    this.delay =
      options.delay ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.treeRemovalFs = options.treeRemovalFs ?? nodeTreeRemovalFs;
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
    if (!(await pathExists(worktreePath))) {
      const { outcome } = await this.unregisterMissingWorktree(repoPath, worktreePath);
      return { outcome };
    }
    const withoutGit = await this.remainsWithoutGit(worktreePath);
    if (withoutGit === 'empty') {
      const { outcome } = await this.removeEmptiedWorktree(repoPath, worktreePath);
      return { outcome };
    }
    if (withoutGit === 'contents') return { outcome: 'quarantined' };
    const { stdout: statusOutput } = await this.runGit(
      worktreePath,
      ['status', '--porcelain'],
      'remove_failed',
    );
    // Cleanup policy: never destroy work. If the worktree has any changes, quarantine it
    // (leave it on disk, untouched) instead of removing it.
    if (statusOutput.trim().length > 0) return { outcome: 'quarantined' };
    const { outcome } = await this.removeUnreviewedWorktree(repoPath, worktreePath);
    return { outcome };
  }

  /**
   * Remove a terminal worktree only when HEAD is still exactly `baseHead` and status is empty.
   * A Worker commit is clean in `git status`, so HEAD is checked before any removal. Ignored
   * files do not block removal: they are never integrated, and they go with the directory (a link
   * among them goes by itself, never what it points at).
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
      return this.unregisterMissingWorktree(repoPath, worktreePath);
    const withoutGit = await this.remainsWithoutGit(worktreePath);
    if (withoutGit === 'empty') return this.removeEmptiedWorktree(repoPath, worktreePath);
    // Git cannot say what these files are, so they never qualify; a discard may remove them.
    if (withoutGit === 'contents') return { outcome: 'quarantined', changed: true };
    if (await this.differsFromBase(worktreePath, baseHead, 'remove_failed'))
      return { outcome: 'quarantined', changed: true };
    return this.removeUnreviewedWorktree(repoPath, worktreePath);
  }

  /**
   * What is left of a worktree directory without its `.git`, or null while `.git` is there. A
   * removal deletes `.git` last (see `removeTreeWithoutFollowingLinks`), so `empty` is a removal
   * that only failed to remove the folder itself, such as a Windows terminal or Explorer window
   * holding it open. Git must not be asked about such a folder: it would look upward for a
   * repository and could read whichever one contains the worktrees root.
   */
  private async remainsWithoutGit(worktreePath: string): Promise<'empty' | 'contents' | null> {
    if (await entryPresent(join(worktreePath, '.git'))) return null;
    return (await directoryHasContent(worktreePath)) ? 'contents' : 'empty';
  }

  /**
   * Finishes a removal that left only the empty folder and its registration, without Git reading
   * the folder. The folder goes only while it is still empty; a Windows lock is waited out as in any
   * removal, and one that outlasts the backoff keeps it `quarantined`. A worktree Git holds locked
   * keeps its registration. So does one whose Git record keeps a submodule store, with its empty
   * folder, as a worktree whose folder is gone does (issue #580).
   */
  private async removeEmptiedWorktree(
    repoPath: string,
    worktreePath: string,
  ): Promise<CleanupUnchangedWorktreeResult> {
    if (await this.isLocked(repoPath, worktreePath))
      return { outcome: 'quarantined', reason: 'locked' };
    if (await this.recordKeepsSubmodules(repoPath, worktreePath))
      return { outcome: 'quarantined', changed: true };
    if (!(await this.removeEmptyDirectory(worktreePath)))
      return { outcome: 'quarantined', reason: 'busy' };
    return this.unregisterWorktree(repoPath, worktreePath);
  }

  /**
   * The folder is gone, so only the registration is left to remove, unless Git's record of the
   * worktree keeps a submodule store (issue #580). A Worker's commits inside a submodule live only
   * there, and without the folder `git worktree remove` deletes the record, store and all, without
   * the submodule check it makes on a worktree that is on disk. Such a worktree is kept for the
   * user to discard, and reported `changed` as one kept for a submodule on disk is: it will never
   * qualify.
   */
  private async unregisterMissingWorktree(
    repoPath: string,
    worktreePath: string,
  ): Promise<CleanupUnchangedWorktreeResult> {
    if (await this.recordKeepsSubmodules(repoPath, worktreePath))
      return { outcome: 'quarantined', changed: true };
    return this.unregisterWorktree(repoPath, worktreePath);
  }

  /**
   * Whether Git's record of the worktree at `worktreePath` (`worktrees/<id>` in the repository's
   * common Git directory, the one whose `gitdir` file names that path) keeps a submodule store with
   * anything in it (issue #580). It reads the record rather than the worktree, so it answers once the
   * folder or its `.git` is gone, when Git can no longer be asked from inside. As in
   * `containsSubmodules`, whatever this cannot read counts as a store. A record whose `gitdir` file is
   * missing is one Git skips too, so `git worktree remove` never reaches it.
   */
  private async recordKeepsSubmodules(repoPath: string, worktreePath: string): Promise<boolean> {
    const commonDir = (
      await this.runGit(repoPath, ['rev-parse', '--git-common-dir'], 'remove_failed')
    ).stdout.trim();
    if (commonDir === '') return true;
    const records = join(resolve(repoPath, commonDir), 'worktrees');
    let ids: string[];
    try {
      ids = await readdir(records);
    } catch (error) {
      // No linked worktree has ever been registered, so nothing can be removed either.
      return !isEnoent(error);
    }
    const wanted = await pathKeys(worktreePath);
    for (const id of ids) {
      const record = join(records, id);
      let gitdir: string;
      try {
        gitdir = await readFile(join(record, 'gitdir'), 'utf8');
      } catch (error) {
        if (isEnoent(error) || errorCode(error) === 'ENOTDIR') continue;
        return true;
      }
      // Git reads `<worktree>/.git`, relative to the record when it is not absolute (Git 2.48+).
      const written = gitdir.trimEnd().replace(/[\\/]\.git$/u, '');
      if (written === '') continue;
      const keys = await pathKeys(isAbsolute(written) ? written : resolve(record, written));
      if (
        keys.some((key) => wanted.includes(key)) &&
        (await directoryHasContent(join(record, 'modules')))
      )
        return true;
    }
    return false;
  }

  /** Removes a directory only while it is empty; false when it stayed (a lock, or new content). */
  private async removeEmptyDirectory(path: string): Promise<boolean> {
    const attempt = async (): Promise<'removed' | 'retry' | 'kept'> => {
      try {
        await this.treeRemovalFs.rmdir(path);
        return 'removed';
      } catch (error) {
        if (isEnoent(error)) return 'removed';
        // Something was written into it meanwhile: leave it for a later look.
        if (errorCode(error) === 'ENOTEMPTY' || errorCode(error) === 'EEXIST') return 'kept';
        if (this.platform === 'win32' && isTransientRemovalError(error)) return 'retry';
        throw new WorktreeError('remove_failed', errorMessage(error), { cause: error });
      }
    };
    let result = await attempt();
    for (const delayMs of WINDOWS_REMOVE_RETRY_DELAYS_MS) {
      if (result !== 'retry') break;
      await this.delay(delayMs);
      result = await attempt();
    }
    return result === 'removed';
  }

  /**
   * The removal `cleanup` and `cleanupUnchanged` make without anyone having looked at the worktree.
   * It keeps two kinds of worktree `git status` cannot vouch for, as `git worktree remove` did before
   * this manager deleted the files itself (issue #544):
   *
   * - One with a submodule: a Worker's commits inside it live only in this worktree's own submodule
   *   store, and a submodule configured to be ignored hides its changes from `git status`. Such a
   *   worktree will never qualify, so `cleanupUnchanged` reports it as `changed`.
   * - One locked with `git worktree lock` (by the user, or by a `git worktree add` that stopped part
   *   way). It is kept without `changed`: once unlocked it may qualify.
   */
  private async removeUnreviewedWorktree(
    repoPath: string,
    worktreePath: string,
  ): Promise<CleanupUnchangedWorktreeResult> {
    if (await this.containsSubmodules(repoPath, worktreePath))
      return { outcome: 'quarantined', changed: true };
    if (await this.isLocked(repoPath, worktreePath))
      return { outcome: 'quarantined', reason: 'locked' };
    return this.removeRegisteredWorktree(repoPath, worktreePath);
  }

  /**
   * Whether the worktree holds a submodule, by the test `git worktree remove` refuses a worktree
   * with, or wider: this worktree's submodule store (`git rev-parse --git-path modules`) exists, or a
   * gitlink (mode 160000) in its index has a directory that is not empty. Git itself only counts a
   * populated gitlink; any content counts here.
   */
  private async containsSubmodules(repoPath: string, worktreePath: string): Promise<boolean> {
    // Without `.git` Git would read another repository: contents Git cannot account for count as a
    // possible submodule, and an emptied folder holds one only in Git's record of it (issue #580).
    const withoutGit = await this.remainsWithoutGit(worktreePath);
    if (withoutGit !== null)
      return (
        withoutGit === 'contents' || (await this.recordKeepsSubmodules(repoPath, worktreePath))
      );
    const modules = (
      await this.runGit(worktreePath, ['rev-parse', '--git-path', 'modules'], 'remove_failed')
    ).stdout.trim();
    if (modules === '' || (await entryPresent(resolve(worktreePath, modules)))) return true;
    const staged = (
      await this.runGit(
        worktreePath,
        ['ls-files', '--stage', '-z'],
        'remove_failed',
        GIT_LISTING_MAX_BUFFER_BYTES,
      )
    ).stdout;
    for (const entry of staged.split('\0')) {
      // `<mode> <object> <stage>\t<path>`
      const tab = entry.indexOf('\t');
      if (!entry.startsWith('160000 ') || tab < 0) continue;
      if (await directoryHasContent(join(worktreePath, entry.slice(tab + 1)))) return true;
    }
    return false;
  }

  /**
   * Whether Git holds the worktree locked (`git worktree lock`, or the lock `git worktree add` keeps
   * while it initializes). Read from the repository's own worktree list, so it answers even when the
   * worktree's `.git` is already gone.
   */
  private async isLocked(repoPath: string, worktreePath: string): Promise<boolean> {
    const listed = (
      await this.runGit(repoPath, ['worktree', 'list', '--porcelain', '-z'], 'remove_failed')
    ).stdout;
    const wanted = await pathKeys(worktreePath);
    let current: string | null = null;
    for (const line of listed.split('\0')) {
      if (line.startsWith('worktree ')) {
        current = line.slice('worktree '.length);
        continue;
      }
      if (current === null || (line !== 'locked' && !line.startsWith('locked '))) continue;
      const keys = await pathKeys(current);
      if (keys.some((key) => wanted.includes(key))) return true;
    }
    return false;
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

  /**
   * Delete a worktree this app created, with every change in it (issue #544). Only a discard the
   * user confirmed comes here: `cleanup` and `cleanupUnchanged` never destroy work. The recorded
   * path must be this manager's own path for `worktreeId`, and a link standing in for that directory
   * is refused rather than followed. The directory goes the way `cleanup` removes one: its files
   * first, never following a link inside it, then only this worktree's registration (never
   * `git worktree prune`), so a removal that stops part way can be finished by the next discard.
   * Worker worktrees are created detached, so there is no branch to delete. A Windows lock that
   * outlasts the backoff keeps the rest of the worktree and reports `quarantined`. A submodule goes
   * with it, since the user confirmed the discard; a worktree Git holds locked is refused before
   * anything is deleted, with code `locked`.
   */
  async discard({
    agentId,
    repoPath,
    path,
    worktreeId = agentId,
  }: DiscardWorktreeInput): Promise<CleanupWorktreeResult> {
    validateWorktreeId(agentId);
    const worktreePath = await this.locateOwnedWorktree({ agentId, repoPath, path, worktreeId });
    const ownPath = worktreePath ?? this.worktreePathFor(worktreeId);
    if (await this.isLocked(repoPath, ownPath))
      throw new WorktreeError('locked', `Worktree is locked by Git: ${ownPath}`);
    // `reason` classifies why an automatic reclaim kept a worktree (issue #588); a user-confirmed
    // discard has no such caller, so it is dropped here exactly as `cleanup` drops it.
    if (worktreePath === null) {
      const { outcome } = await this.unregisterWorktree(repoPath, ownPath);
      return { outcome };
    }
    const { outcome } = await this.removeRegisteredWorktree(repoPath, worktreePath);
    return { outcome };
  }

  /**
   * Whether a retained worktree holds a submodule, by the same test the automatic cleanup keeps one
   * with (issue #544). Reads only. A worktree whose folder is gone holds one while Git's record of
   * it keeps a submodule store, which a discard deletes (issue #580); one this manager cannot read,
   * or does not own, counts as holding one, so the user is warned rather than reassured.
   */
  async hasSubmodules(input: DiscardWorktreeInput): Promise<boolean> {
    try {
      const worktreePath = await this.locateOwnedWorktree(input);
      return worktreePath === null
        ? await this.recordKeepsSubmodules(
            input.repoPath,
            this.worktreePathFor(input.worktreeId ?? input.agentId),
          )
        : await this.containsSubmodules(input.repoPath, worktreePath);
    } catch {
      return true;
    }
  }

  /**
   * Whether `commit` is in the history of the repository's current HEAD, read without changing
   * anything. False also when Git cannot tell, so a caller never treats unverified work as merged.
   */
  async headContains(repoPath: string, commit: string): Promise<boolean> {
    validateGitHead(commit);
    return (
      (await this.tryRunGit(repoPath, ['merge-base', '--is-ancestor', commit, 'HEAD'])) !== null
    );
  }

  /**
   * This manager's own directory for `worktreeId` when the recorded `path` names it and it is on
   * disk, or null when it is gone. Throws for a path this app does not own, or for a link standing
   * in for the directory.
   */
  async locateOwnedWorktree({
    agentId,
    path,
    worktreeId = agentId,
  }: DiscardWorktreeInput): Promise<string | null> {
    validateWorktreeId(agentId);
    if (!this.ownsWorktreePath(worktreeId, path))
      throw new WorktreeError('invalid_input', 'Worktree path is not owned by Sprint Coder');
    const worktreePath = this.worktreePathFor(worktreeId);
    let entry;
    try {
      entry = await lstat(worktreePath);
    } catch (error) {
      if (isEnoent(error)) return null;
      throw error;
    }
    if (!entry.isDirectory())
      throw new WorktreeError('invalid_input', 'Worktree must be its own directory');
    return worktreePath;
  }

  /**
   * What a retained worktree holds now (issue #544), read without changing it: its HEAD, the
   * commits since its base, `git status` with every untracked file, and the tracked files changed
   * since the base. Each list stops at `limit` entries and says whether it was cut.
   */
  async inspectChanges({
    agentId,
    repoPath,
    path,
    baseHead,
    limit,
    worktreeId = agentId,
  }: InspectWorktreeChangesInput): Promise<WorktreeChangeInspection> {
    validateGitHead(baseHead);
    const worktreePath = await this.locateOwnedWorktree({ agentId, repoPath, path, worktreeId });
    if (worktreePath === null)
      throw new WorktreeError(
        'invalid_input',
        `worktree does not exist: ${this.worktreePathFor(worktreeId)}`,
      );
    // Git looks upward for a repository, so a directory that is no longer a worktree would be read
    // as whichever repository contains the worktrees root.
    if ((await this.resolveRepositoryPath(worktreePath)) !== (await realpath(worktreePath)))
      throw new WorktreeError('invalid_input', 'Worktree directory is no longer a Git worktree');
    const head = (
      await this.runGit(worktreePath, ['rev-parse', 'HEAD'], 'create_failed')
    ).stdout.trim();
    validateGitHead(head);
    let commitsSinceBase = 0;
    if (head !== baseHead) {
      const counted = (
        await this.runGit(
          worktreePath,
          ['rev-list', '--count', `${baseHead}..${head}`],
          'create_failed',
        )
      ).stdout.trim();
      if (!/^\d+$/u.test(counted))
        throw new WorktreeError(
          'create_failed',
          `Unexpected commit count: ${JSON.stringify(counted)}`,
        );
      commitsSinceBase = Number(counted);
    }
    // The file lists can be long; one that outgrows even the wider buffer is refused as too large
    // rather than cut at an arbitrary byte.
    const readList = async (args: readonly string[]): Promise<string> => {
      try {
        return (
          await this.runGit(worktreePath, args, 'create_failed', GIT_LISTING_MAX_BUFFER_BYTES)
        ).stdout;
      } catch (error) {
        if (isMaxBufferExceeded(error))
          throw new WorktreeError('too_large', 'Worktree change list is too large to read', {
            cause: error,
          });
        throw error;
      }
    };
    // `-z` keeps every path byte-exact and `--no-renames` gives each entry exactly one path.
    const status = (
      await readList([
        'status',
        '--porcelain=v1',
        '-z',
        '--no-renames',
        '--untracked-files=all',
        '--ignore-submodules=none',
      ])
    )
      .split('\0')
      .filter((entry) => entry.length > 3)
      .map((entry) => ({ code: entry.slice(0, 2), path: entry.slice(3) }));
    const diffTokens = (
      await readList(['diff', '--no-renames', '--name-status', '-z', baseHead, '--'])
    ).split('\0');
    const changesFromBase: { status: string; path: string }[] = [];
    for (let index = 0; index + 1 < diffTokens.length; index += 2) {
      const change = diffTokens[index]!;
      const changedPath = diffTokens[index + 1]!;
      if (change !== '' && changedPath !== '')
        changesFromBase.push({ status: change, path: changedPath });
    }
    const bounded = <T extends { path: string }>(entries: readonly T[]): T[] =>
      entries.slice(0, limit).map((entry) => ({ ...entry, path: entry.path.slice(0, 4_096) }));
    return {
      head,
      commitsSinceBase,
      status: bounded(status),
      statusTruncated: status.length > limit,
      changesFromBase: bounded(changesFromBase),
      changesFromBaseTruncated: changesFromBase.length > limit,
    };
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
   * The directory is gone, so unregister only this worktree. `git worktree prune` would also drop
   * every other registration whose directory is missing, including the user's own worktrees on an
   * unplugged drive. A registration Git refuses to remove (for example a locked one) stays, and the
   * error reaches the caller so it records the reason. A Windows lock that outlasts the backoff
   * keeps the registration and reports `quarantined`, so a later cleanup finishes it.
   */
  private async unregisterWorktree(
    repoPath: string,
    worktreePath: string,
  ): Promise<CleanupUnchangedWorktreeResult> {
    const unregister = async (): Promise<CleanupWorktreeResult> => {
      try {
        await this.runGit(repoPath, ['worktree', 'remove', worktreePath], 'remove_failed');
      } catch (error) {
        // Nothing is registered at this path any more: there is nothing left to remove.
        if (error instanceof WorktreeError && /is not a working tree/i.test(error.message))
          return { outcome: 'removed' };
        throw error;
      }
      return { outcome: 'removed' };
    };
    try {
      return await unregister();
    } catch (error) {
      if (this.platform !== 'win32' || !isPermissionDenied(error)) throw error;
      for (const delayMs of WINDOWS_REMOVE_RETRY_DELAYS_MS) {
        await this.delay(delayMs);
        try {
          return await unregister();
        } catch (retryError) {
          if (!isPermissionDenied(retryError)) throw retryError;
        }
      }
      return { outcome: 'quarantined', reason: 'busy' };
    }
  }

  /**
   * Remove a worktree directory and then its registration. Git never deletes the files: on Windows
   * `git worktree remove` follows a directory junction inside the worktree and empties the folder it
   * points at (issue #544). The files go first, so a removal that stops part way leaves the
   * registration, and the next cleanup or discard finishes what is left.
   */
  private async removeRegisteredWorktree(
    repoPath: string,
    worktreePath: string,
  ): Promise<CleanupUnchangedWorktreeResult> {
    if (!(await this.removeWorktreeDirectory(worktreePath)))
      return { outcome: 'quarantined', reason: 'busy' };
    return this.unregisterWorktree(repoPath, worktreePath);
  }

  /**
   * Deletes the directory without following a link. False when a Windows lock (a file open in an
   * editor, a terminal inside the folder) outlasted the backoff; what could not go stays.
   */
  private async removeWorktreeDirectory(worktreePath: string): Promise<boolean> {
    const attempt = async (): Promise<boolean> => {
      try {
        await removeTreeWithoutFollowingLinks(worktreePath, this.treeRemovalFs);
        return true;
      } catch (error) {
        if (this.platform === 'win32' && isTransientRemovalError(error)) return false;
        throw new WorktreeError('remove_failed', errorMessage(error), { cause: error });
      }
    };
    if (await attempt()) return true;
    for (const delayMs of WINDOWS_REMOVE_RETRY_DELAYS_MS) {
      await this.delay(delayMs);
      if (await attempt()) return true;
    }
    return false;
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
    maxBuffer?: number,
  ): Promise<ExecFileResult> {
    try {
      return await safeGitExec(this.execFileImpl, dirArg, subArgs, {
        env: process.env,
        timeout: GIT_TIMEOUT_MS,
        ...(maxBuffer === undefined ? {} : { maxBuffer }),
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

/** Whether anything is at `path`, without following a link; an unreadable entry counts. */
async function entryPresent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    return !isEnoent(error);
  }
}

/** Whether `path` has anything in it. Anything but an empty directory or nothing at all counts. */
async function directoryHasContent(path: string): Promise<boolean> {
  try {
    const entry = await lstat(path);
    return !entry.isDirectory() || (await readdir(path)).length > 0;
  } catch (error) {
    return !isEnoent(error);
  }
}

/**
 * The spellings a worktree path can have in `git worktree list`: resolved as given, and through the
 * real path of its parent (Git records a real path where the temp folder is itself a link). Case is
 * folded on Windows, where paths are case-insensitive.
 */
async function pathKeys(path: string): Promise<string[]> {
  const fold = (value: string): string =>
    process.platform === 'win32' ? value.toLocaleLowerCase('en-US') : value;
  const keys = [fold(resolve(path))];
  try {
    keys.push(fold(join(await realpath(dirname(resolve(path))), basename(path))));
  } catch {
    // A parent that is gone leaves only the resolved spelling.
  }
  return keys;
}

function isEnoent(error: unknown): boolean {
  return errorCode(error) === 'ENOENT';
}

function errorCode(error: unknown): string {
  return error instanceof Error && 'code' in error
    ? String((error as NodeJS.ErrnoException).code ?? '')
    : '';
}

const nodeTreeRemovalFs: TreeRemovalFs = Object.freeze({
  lstat: (path: string) => lstat(path),
  readdir: (path: string) => readdir(path),
  unlink: (path: string) => unlink(path),
  rmdir: (path: string) => rmdir(path),
  chmod: (path: string, mode: number) => chmod(path, mode),
});

/**
 * Delete `root` and everything below it without ever following a link (issue #544). Every entry
 * is examined with `lstat`: a link, including a Windows directory junction (which `lstat` reports as
 * a link and not a directory), is removed by itself and what it points at is left alone. Neither
 * `git worktree remove` nor a recursive `fs.rm` can be trusted with that: on Windows both empty the
 * folder behind a junction (the latter in the Node that Electron ships).
 *
 * An entry that is already gone counts as removed, so a removal that stopped part way, or one that
 * raced another, can simply run again. At the root `.git` goes last, so a removal that stops at a
 * file inside still leaves a worktree Git can read. One that stops only at the root folder itself
 * (a Windows terminal or Explorer window holding it open) leaves an empty folder without `.git`:
 * `cleanup` and `cleanupUnchanged` recognize that and finish it without asking Git, and a discard
 * finishes it as any other. Errors reach the caller unchanged.
 */
export async function removeTreeWithoutFollowingLinks(
  root: string,
  fs: TreeRemovalFs = nodeTreeRemovalFs,
): Promise<void> {
  await removeEntry(root, fs, true);
}

async function removeEntry(path: string, fs: TreeRemovalFs, root: boolean): Promise<void> {
  let entry: Awaited<ReturnType<TreeRemovalFs['lstat']>>;
  try {
    entry = await fs.lstat(path);
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
  if (entry.isSymbolicLink()) return removeLink(path, fs);
  if (!entry.isDirectory()) return removeFile(path, fs);
  let names: string[];
  try {
    names = await fs.readdir(path);
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
  const ordered = root
    ? [...names.filter((name) => name !== '.git'), ...names.filter((name) => name === '.git')]
    : names;
  for (const name of ordered) await removeEntry(join(path, name), fs, false);
  await ignoreMissing(async () => {
    try {
      await fs.rmdir(path);
    } catch (error) {
      if (!isAccessError(error)) throw error;
      // A read-only directory on Windows refuses removal until its attribute is cleared.
      await fs.chmod(path, 0o777);
      await fs.rmdir(path);
    }
  });
}

/** The link itself: `unlink` removes a file link, and `rmdir` a directory link or junction. */
async function removeLink(path: string, fs: TreeRemovalFs): Promise<void> {
  await ignoreMissing(async () => {
    try {
      await fs.unlink(path);
    } catch (error) {
      if (!isAccessError(error) && errorCode(error) !== 'EISDIR') throw error;
      await fs.rmdir(path);
    }
  });
}

async function removeFile(path: string, fs: TreeRemovalFs): Promise<void> {
  await ignoreMissing(async () => {
    try {
      await fs.unlink(path);
    } catch (error) {
      if (!isAccessError(error)) throw error;
      // A read-only file on Windows refuses deletion until its attribute is cleared.
      await fs.chmod(path, 0o666);
      await fs.unlink(path);
    }
  });
}

async function ignoreMissing(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
}

function isAccessError(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'EPERM' || code === 'EACCES';
}

/** A Windows removal error that a lock released later may clear. */
function isTransientRemovalError(error: unknown): boolean {
  const code = errorCode(error);
  return (
    code === 'EBUSY' ||
    code === 'ENOTEMPTY' ||
    code === 'EPERM' ||
    code === 'EACCES' ||
    isPermissionDenied(error)
  );
}

/** Node's execFile reports output beyond `maxBuffer` with this code; it may arrive as a cause. */
function isMaxBufferExceeded(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (errorCode(error) === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return true;
  return 'cause' in error && isMaxBufferExceeded((error as Error & { cause?: unknown }).cause);
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
      {
        env: options.env,
        timeout: options.timeout,
        ...(options.maxBuffer === undefined ? {} : { maxBuffer: options.maxBuffer }),
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
      },
    );
  });
