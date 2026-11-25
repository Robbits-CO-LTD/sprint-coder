import { lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { currentWorkspaceRootIdentityDigest } from './path-guard';
import { readProjectReference } from './project-reference-file';
import { redactSecrets } from './secret-redactor';

const initialInstructions =
  '# Sprint Coder\n\n<!-- 全プロジェクトでAIに守ってほしい指示をここに書いてください。 -->\n';

export function userConfigHome(): string {
  return resolve(
    process.env['SPRINT_CODER_SKILL_HOME'] ||
      process.env['SPRINT_CODER_USER_DATA_DIR'] ||
      homedir(),
  );
}

/** Create editable defaults once. Concurrent launches and existing user files take precedence. */
export function initializeUserConfig(home: string): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const directory = join(realpathSync(home), '.sprint-coder');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory() || realpathSync(directory) !== directory) return;
  for (const [name, content] of [
    ['settings.json', '{\n  "permissions": { "allow": [], "deny": [] }\n}\n'],
    ['SprintCoder.md', initialInstructions],
  ] as const) {
    try {
      writeFileSync(join(directory, name), content, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}

export function readGlobalSprintCoderInstructions(home: string): string | null {
  let root: string;
  try {
    root = realpathSync(home);
  } catch {
    return null;
  }
  const identity = currentWorkspaceRootIdentityDigest(root);
  if (!identity) return null;
  const { content } = readProjectReference({
    workspacePath: root,
    registeredRootIdentity: identity,
    relativePath: join('.sprint-coder', 'SprintCoder.md'),
  });
  if (!content || content === initialInstructions) return null;
  return redactSecrets(content).trim() || null;
}
