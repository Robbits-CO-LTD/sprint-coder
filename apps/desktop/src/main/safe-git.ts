import { execFile, execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process';

export type SafeGitResult = Readonly<{ stdout: string; stderr: string }>;

export type SafeGitExec = (
  file: string,
  args: readonly string[],
  options: Readonly<{ env: NodeJS.ProcessEnv; timeout?: number }>,
) => Promise<SafeGitResult>;

type SafeGitOptions = Readonly<{
  timeout: number;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
}>;

const FILTER_CONFIG_KEY = /^filter\.(.+)\.(?:clean|smudge|process|required)$/iu;
const MERGE_DRIVER_CONFIG_KEY = /^merge\.(.+)\.driver$/iu;
const SAFE_CONFIG_SUBSECTION = /^[a-zA-Z0-9._-]+$/u;
const CONFIG_LIST_ARGS = ['config', '--no-includes', '--name-only', '--list'] as const;
const ALLOWED_COMMANDS = new Set([
  'add',
  'branch',
  'cherry-pick',
  'commit',
  'diff',
  'hash-object',
  'ls-files',
  'merge-base',
  'merge-tree',
  'reset',
  'rev-list',
  'rev-parse',
  'show',
  'status',
  'worktree',
]);

export function safeGitEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (source['PATH'] !== undefined) env['PATH'] = source['PATH'];
  if (source['HOME'] !== undefined) env['HOME'] = source['HOME'];
  if (source['SYSTEMROOT'] !== undefined) env['SYSTEMROOT'] = source['SYSTEMROOT'];
  const nullConfig = platform === 'win32' ? 'NUL' : '/dev/null';
  env['GIT_CONFIG_GLOBAL'] = nullConfig;
  env['GIT_CONFIG_SYSTEM'] = nullConfig;
  env['GIT_TERMINAL_PROMPT'] = '0';
  env['GIT_OPTIONAL_LOCKS'] = '0';
  env['GIT_ATTR_NOSYSTEM'] = '1';
  env['GIT_PAGER'] = 'cat';
  env['PAGER'] = 'cat';
  env['LC_ALL'] = 'C';
  return env;
}

export function safeGitInvocationArgs(
  cwd: string,
  command: readonly string[],
  localConfigNames: string,
): string[] {
  const filterDrivers = new Set<string>();
  for (const key of localConfigNames.split(/\r?\n/u)) {
    const normalized = key.trim();
    if (normalized === 'include.path' || /^includeif\..+\.path$/iu.test(normalized))
      throw new Error('Repository-local Git config includes are not allowed');
    if (MERGE_DRIVER_CONFIG_KEY.test(normalized))
      throw new Error('Repository-local Git merge drivers are not allowed');
    const match = FILTER_CONFIG_KEY.exec(normalized);
    if (match?.[1] !== undefined && match[1] !== '') {
      if (!SAFE_CONFIG_SUBSECTION.test(match[1]))
        throw new Error('Repository-local Git filter name is unsafe');
      filterDrivers.add(match[1]);
    }
  }
  const filterOverrides = [...filterDrivers]
    .sort()
    .flatMap((driver) => [
      '-c',
      `filter.${driver}.clean=`,
      '-c',
      `filter.${driver}.smudge=`,
      '-c',
      `filter.${driver}.process=`,
      '-c',
      `filter.${driver}.required=false`,
    ]);
  return [
    '--no-pager',
    '-c',
    'core.hooksPath=',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.pager=cat',
    '-c',
    'core.attributesFile=',
    '-c',
    'submodule.recurse=false',
    '-c',
    'checkout.recurseSubmodules=false',
    '-c',
    'pager.status=false',
    '-c',
    'pager.diff=false',
    '-c',
    'diff.external=',
    '-c',
    'interactive.diffFilter=',
    '-c',
    'commit.gpgSign=false',
    '-c',
    'tag.gpgSign=false',
    ...filterOverrides,
    '-C',
    cwd,
    ...hardenGitCommand(command),
  ];
}

export async function safeGitExec(
  exec: SafeGitExec,
  cwd: string,
  command: readonly string[],
  options: SafeGitOptions,
): Promise<SafeGitResult> {
  const env = safeGitEnvironment(options.env);
  const config = await exec('git', configProbeArgs(cwd), { env, timeout: options.timeout });
  return exec('git', safeGitInvocationArgs(cwd, command, config.stdout), {
    env,
    timeout: options.timeout,
  });
}

export function safeGitExecFileSync(
  cwd: string,
  command: readonly string[],
  options: SafeGitOptions,
): string {
  const env = safeGitEnvironment(options.env);
  const common = {
    encoding: 'utf8' as const,
    timeout: options.timeout,
    maxBuffer: options.maxBuffer,
    windowsHide: true,
    env,
  };
  const config = execFileSync('git', configProbeArgs(cwd), common);
  return execFileSync('git', safeGitInvocationArgs(cwd, command, config), common);
}

export function safeGitSpawnSync(
  cwd: string,
  command: readonly string[],
  options: SafeGitOptions,
): SpawnSyncReturns<string> | null {
  const env = safeGitEnvironment(options.env);
  const common = {
    encoding: 'utf8' as const,
    timeout: options.timeout,
    maxBuffer: options.maxBuffer,
    windowsHide: true,
    env,
  };
  const config = spawnSync('git', configProbeArgs(cwd), common);
  if (config.error !== undefined || config.status !== 0) return null;
  return spawnSync('git', safeGitInvocationArgs(cwd, command, config.stdout), common);
}

export function safeGitExecFile(
  cwd: string,
  command: readonly string[],
  options: SafeGitOptions,
): Promise<string | null> {
  const exec: SafeGitExec = (file, args, invocationOptions) =>
    new Promise((resolve, reject) => {
      execFile(
        file,
        args as string[],
        {
          env: invocationOptions.env,
          timeout: invocationOptions.timeout,
          maxBuffer: options.maxBuffer,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error !== null) reject(error);
          else resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
        },
      );
    });
  return safeGitExec(exec, cwd, command, options).then(
    ({ stdout }) => stdout,
    () => null,
  );
}

function configProbeArgs(cwd: string): string[] {
  return [
    '--no-pager',
    '-c',
    'core.hooksPath=',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.pager=cat',
    '-c',
    'core.attributesFile=',
    '-C',
    cwd,
    ...CONFIG_LIST_ARGS,
  ];
}

function hardenGitCommand(command: readonly string[]): string[] {
  const commandIndex = gitCommandIndex(command);
  const name = command[commandIndex];
  if (name === undefined) throw new Error('Git command is required');
  if (!ALLOWED_COMMANDS.has(name)) throw new Error(`Git command is not allowed: ${name}`);
  const prefix = command.slice(0, commandIndex);
  const rest = command.slice(commandIndex + 1);
  if (name === 'diff')
    return [
      ...prefix,
      name,
      '--no-ext-diff',
      '--no-textconv',
      ...without(rest, '--no-ext-diff', '--no-textconv'),
    ];
  if (name === 'show')
    return [
      ...prefix,
      name,
      '--no-ext-diff',
      '--no-textconv',
      ...without(rest, '--no-ext-diff', '--no-textconv'),
    ];
  if (name === 'hash-object')
    return [...prefix, name, '--no-filters', ...without(rest, '--no-filters')];
  if (name === 'commit')
    return [
      ...prefix,
      name,
      '--no-verify',
      '--no-gpg-sign',
      ...without(rest, '--no-verify', '--no-gpg-sign'),
    ];
  if (name === 'cherry-pick' && !rest.includes('--abort'))
    return [
      ...prefix,
      name,
      '--no-gpg-sign',
      '--no-edit',
      ...without(rest, '--no-gpg-sign', '--no-edit'),
    ];
  return [...prefix, name, ...rest];
}

function gitCommandIndex(command: readonly string[]): number {
  let index = 0;
  while (command[index] === '-c') {
    if (command[index + 1] === undefined) throw new Error('Git -c requires a value');
    index += 2;
  }
  return index;
}

function without(values: readonly string[], ...blocked: readonly string[]): string[] {
  const blockedSet = new Set(blocked);
  return values.filter((value) => !blockedSet.has(value));
}
