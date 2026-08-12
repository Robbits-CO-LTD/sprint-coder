import {
  chmodSync,
  copyFileSync,
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { RuntimeCodexConfigPolicy, RuntimeSkillInput } from './protocol';
import { canonicalizeExistingPath, pathComparisonKey } from '../path-comparison';

export type CodexSkillIsolation = Readonly<{
  codexHome: string;
  isolatedUserHome: string;
  shellUserHome: string;
  selectedSkillsRoot: string;
  stagedSkills: readonly RuntimeSkillInput[];
  disabledWorkspaceSkillPaths: readonly string[];
  validationCwds: readonly string[];
  userConfigSnapshot: 'disabled' | 'missing' | 'copied';
}>;

export class CodexUserConfigSnapshotError extends Error {
  constructor() {
    super('Codex user config snapshot failed');
    this.name = 'CodexUserConfigSnapshotError';
  }
}

export function prepareCodexSkillIsolation(input: {
  temporaryRoot: string;
  cwd: string;
  runtimeWorkspaceRoots?: readonly string[];
  skills: readonly RuntimeSkillInput[];
  configPolicy?: RuntimeCodexConfigPolicy;
  environment?: Readonly<NodeJS.ProcessEnv>;
}): CodexSkillIsolation {
  const environment = input.environment ?? process.env;
  const isolatedUserHome = join(input.temporaryRoot, 'user-home');
  const codexHome = join(isolatedUserHome, '.codex');
  const selectedSkillsRoot = join(input.temporaryRoot, 'selected-skills');
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  mkdirSync(selectedSkillsRoot, { recursive: true, mode: 0o700 });
  chmodSync(codexHome, 0o700);
  chmodSync(selectedSkillsRoot, 0o700);
  copyAuthentication(environment, codexHome);
  const userConfigSnapshot = snapshotUserConfig(
    environment,
    codexHome,
    input.configPolicy?.inheritUserConfig === true,
  );

  const stagedSkills = input.skills.map((skill, index) => {
    const sourceSkillFile = join(skill.path, 'SKILL.md');
    if (!lstatSync(skill.path).isDirectory() || !lstatSync(sourceSkillFile).isFile())
      throw new Error('Managed Skill revision is not a regular package');
    const destination = join(selectedSkillsRoot, `selected-${index + 1}`);
    cpSync(skill.path, destination, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
    });
    return { name: skill.name, path: realpathSync.native(join(destination, 'SKILL.md')) };
  });

  const validationCwds = [
    ...new Set(
      input.runtimeWorkspaceRoots === undefined || input.runtimeWorkspaceRoots.length === 0
        ? [input.cwd]
        : input.runtimeWorkspaceRoots,
    ),
  ].sort();
  return {
    codexHome,
    isolatedUserHome,
    shellUserHome: environment['HOME'] ?? environment['USERPROFILE'] ?? homedir(),
    selectedSkillsRoot,
    stagedSkills,
    disabledWorkspaceSkillPaths: discoverWorkspaceSkillPathsForRoots(validationCwds),
    validationCwds,
    userConfigSnapshot,
  };
}

export function codexSkillIsolationArgs(isolation: CodexSkillIsolation): string[] {
  const rules = isolation.disabledWorkspaceSkillPaths
    .map((path) => `{path=${JSON.stringify(path)},enabled=false}`)
    .join(',');
  return [
    '--strict-config',
    '-c',
    'skills.bundled.enabled=false',
    '-c',
    'skills.include_instructions=false',
    '-c',
    `shell_environment_policy.set={HOME=${JSON.stringify(isolation.shellUserHome)},USERPROFILE=${JSON.stringify(isolation.shellUserHome)}}`,
    ...(rules === '' ? [] : ['-c', `skills.config=[${rules}]`]),
  ];
}

export function assertCodexSkillIsolation(
  response: unknown,
  expectedSkills: readonly RuntimeSkillInput[],
  expectedCatalogCount = 1,
): void {
  const catalog = readCodexSkillCatalog(response, expectedCatalogCount);
  const expected = expectedSkillIdentities(expectedSkills);
  for (const enabled of catalog) {
    const actual = enabled.map(({ name, path }) => `${name}\u0000${canonicalPath(path)}`).sort();
    if (
      actual.length !== expected.length ||
      actual.some((value, index) => value !== expected[index])
    )
      throw new Error('Codex Skill isolation exposed an unselected Skill');
  }
}

export function unexpectedCodexSkillPaths(
  response: unknown,
  expectedSkills: readonly RuntimeSkillInput[],
  expectedCatalogCount = 1,
): string[] {
  const expectedPaths = new Set(expectedSkills.map(({ path }) => canonicalPath(path)));
  return [
    ...new Set(
      readCodexSkillCatalog(response, expectedCatalogCount)
        .flat()
        .filter(({ path }) => !expectedPaths.has(canonicalPath(path)))
        .map(({ path }) => canonicalizeExistingPath(path)),
    ),
  ].sort();
}

export async function enforceCodexSkillIsolation(
  send: (method: string, params: unknown) => Promise<unknown>,
  isolation: CodexSkillIsolation,
): Promise<readonly string[]> {
  const list = (): Promise<unknown> =>
    send('skills/list', { cwds: isolation.validationCwds, forceReload: true });
  const first = await list();
  const unexpected = unexpectedCodexSkillPaths(
    first,
    isolation.stagedSkills,
    isolation.validationCwds.length,
  );
  for (const path of unexpected) await send('skills/config/write', { path, enabled: false });
  const verified = unexpected.length === 0 ? first : await list();
  assertCodexSkillIsolation(verified, isolation.stagedSkills, isolation.validationCwds.length);
  return unexpected;
}

function expectedSkillIdentities(expectedSkills: readonly RuntimeSkillInput[]): string[] {
  return expectedSkills.map((skill) => `${skill.name}\u0000${canonicalPath(skill.path)}`).sort();
}

function readCodexSkillCatalog(
  response: unknown,
  expectedCatalogCount: number,
): Array<Array<{ name: string; path: string }>> {
  const record = asRecord(response);
  const data = record['data'];
  if (!Array.isArray(data) || data.length !== expectedCatalogCount)
    throw new Error('Codex Skill isolation returned an invalid catalog');
  const catalog: Array<Array<{ name: string; path: string }>> = [];
  for (const item of data) {
    const entry = asRecord(item);
    const errors = entry['errors'];
    if (!Array.isArray(errors) || errors.length !== 0)
      throw new Error('Codex Skill isolation catalog contains load errors');
    const skills = entry['skills'];
    if (!Array.isArray(skills)) throw new Error('Codex Skill isolation catalog is missing skills');
    const enabled = skills
      .map(asRecord)
      .filter((skill) => skill['enabled'] === true)
      .map((skill) => ({ name: skill['name'], path: skill['path'] }));
    if (enabled.some((skill) => typeof skill.name !== 'string' || typeof skill.path !== 'string'))
      throw new Error('Codex Skill isolation catalog contains invalid metadata');
    catalog.push(enabled.map(({ name, path }) => ({ name: String(name), path: String(path) })));
  }
  return catalog;
}

export function discoverWorkspaceSkillPaths(cwd: string): string[] {
  const result: string[] = [];
  let current = resolve(cwd);
  const filesystemRoot = parse(current).root;
  while (true) {
    const skillsRoot = join(current, '.agents', 'skills');
    try {
      for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const skillFile = join(skillsRoot, entry.name, 'SKILL.md');
        try {
          if (statSync(skillFile).isFile()) result.push(canonicalizeExistingPath(skillFile));
        } catch {
          // A disappearing or unreadable candidate is rechecked by skills/list after startup.
        }
      }
    } catch {
      // This ancestor has no readable .agents/skills directory.
    }
    if (hasGitBoundary(current) || current === filesystemRoot) break;
    current = dirname(current);
  }
  return [...new Set(result)].sort();
}

export function discoverWorkspaceSkillPathsForRoots(roots: readonly string[]): string[] {
  return [...new Set(roots.flatMap((root) => discoverWorkspaceSkillPaths(root)))].sort();
}

function copyAuthentication(environment: Readonly<NodeJS.ProcessEnv>, codexHome: string): void {
  const sourceHome =
    environment['CODEX_HOME'] ??
    join(environment['HOME'] ?? environment['USERPROFILE'] ?? '', '.codex');
  const source = join(sourceHome, 'auth.json');
  try {
    if (!statSync(source).isFile()) return;
    const destination = join(codexHome, 'auth.json');
    copyFileSync(source, destination);
    chmodSync(destination, 0o600);
  } catch {
    // Authentication failure is reported by app-server without exposing the source path.
  }
}

function snapshotUserConfig(
  environment: Readonly<NodeJS.ProcessEnv>,
  codexHome: string,
  enabled: boolean,
): CodexSkillIsolation['userConfigSnapshot'] {
  if (!enabled) return 'disabled';
  const sourceHome =
    environment['CODEX_HOME'] ??
    join(environment['HOME'] ?? environment['USERPROFILE'] ?? '', '.codex');
  const source = join(sourceHome, 'config.toml');
  try {
    const metadata = lstatSync(source);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1024 * 1024)
      throw new CodexUserConfigSnapshotError();
    const destination = join(codexHome, 'config.toml');
    copyFileSync(source, destination);
    chmodSync(destination, 0o600);
    return 'copied';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    if (error instanceof CodexUserConfigSnapshotError) throw error;
    throw new CodexUserConfigSnapshotError();
  }
}

function hasGitBoundary(directory: string): boolean {
  try {
    const stat = lstatSync(join(directory, '.git'));
    return stat.isDirectory() || stat.isFile();
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Expected an object');
  return value as Record<string, unknown>;
}

function canonicalPath(path: string): string {
  return pathComparisonKey(canonicalizeExistingPath(path));
}
