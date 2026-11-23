import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { basename, join, posix, sep, win32 } from 'node:path';
import { z } from 'zod';
import { APPROVAL_DISPLAY_UNDISPLAYABLE_CHARACTERS } from './approval-display-characters';
import { currentWorkspaceRootIdentityDigest } from './path-guard';
import { readProjectReference } from './project-reference-file';

export type ProjectPermissionSettings = Readonly<{
  valid: boolean;
  digest: string;
  allow: readonly string[];
  deny: readonly string[];
}>;

export type ProjectPermissionTarget =
  | { tool: 'Read' | 'Edit'; relativePath: string }
  | {
      tool: 'Bash';
      executable: string;
      argv: readonly string[];
      /** Only the name independently resolved by Main's controlled executable search. */
      trustedExecutableName?: string | undefined;
    };

const settingsDirectory = '.sprint-coder';
const settingsFiles = ['settings.json', 'settings.local.json'];
const ruleList = z.array(z.string().min(1).max(1024)).max(256);
const fileSchema = z.object({
  permissions: z.object({ allow: ruleList.optional(), deny: ruleList.optional() }).strict(),
});

/** Only this plain JSON value is stored after a person confirms the rules in Main. */
export function loadProjectPermissionSettings(workspacePath: string): ProjectPermissionSettings {
  const allow: string[] = [];
  const deny: string[] = [];
  try {
    const root = realpathSync(workspacePath);
    const directory = join(root, settingsDirectory);
    const before = lstatSync(directory, { bigint: true, throwIfNoEntry: false });
    if (before !== undefined) {
      if (!before.isDirectory() || realpathSync(directory) !== directory) throw new Error();
      const identity = currentWorkspaceRootIdentityDigest(root);
      if (identity === null) throw new Error();
      for (const name of settingsFiles) {
        const result = readProjectReference({
          workspacePath: root,
          registeredRootIdentity: identity,
          relativePath: join(settingsDirectory, name),
        });
        if (result.status === 'missing') continue;
        if (result.content === null) throw new Error();
        const { permissions } = fileSchema.parse(JSON.parse(result.content));
        allow.push(...(permissions.allow ?? []));
        deny.push(...(permissions.deny ?? []));
      }
      const after = lstatSync(directory, { bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino || !after.isDirectory())
        throw new Error();
      if (![...deny, ...allow].every((rule) => parseRule(rule) !== null)) throw new Error();
    }
    return {
      valid: true,
      digest: createHash('sha256')
        .update(JSON.stringify([allow, deny]))
        .digest('hex'),
      allow,
      deny,
    };
  } catch {
    return { valid: false, digest: '', allow: [], deny: [] };
  }
}

type Rule =
  { tool: 'Read' | 'Edit'; path: string[] } | { tool: 'Bash'; words: string[]; anyTail: boolean };

function parseRule(text: string): Rule | null {
  if (/\p{Cc}/u.test(text) || APPROVAL_DISPLAY_UNDISPLAYABLE_CHARACTERS.test(text)) return null;
  if (text === 'Read' || text === 'Edit') return { tool: text, path: ['**'] };
  if (text === 'Bash' || text === 'Bash(*)') return { tool: 'Bash', words: [], anyTail: true };
  const match = /^(Read|Edit|Bash)\((.+)\)$/u.exec(text);
  if (!match) return null;
  const expression = match[2]!;
  if (match[1] !== 'Bash') {
    // Always relative to the selected Workspace; use '/' in rules on every platform.
    const path = expression.replace(/^\.\//u, '').split('/');
    if (
      path.some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          /[\\:[\]?{}]/u.test(part) ||
          (part !== '**' && part.split('*').length > 2),
      )
    )
      return null;
    return { tool: match[1] === 'Read' ? 'Read' : 'Edit', path };
  }
  // A final '*' (or Claude-style ':*') means more whole argv entries. Everything else is literal.
  const prefix = expression.endsWith(':*') || expression.endsWith(' *');
  const source = prefix ? expression.slice(0, -2) : expression;
  const tokens = /(?:^| +)(?:'([^']*)'|"([^"]*)"|([^ '"\s;&|<>`$*]+))(?= |$)/guy;
  const words: string[] = [];
  let consumed = 0;
  for (const token of source.matchAll(tokens)) {
    words.push(token[1] ?? token[2] ?? token[3]!);
    consumed = token.index + token[0].length;
  }
  const executable = words[0];
  if (!executable || consumed !== source.length) return null;
  if (!absoluteProgram(executable) && !/^[\w.+-]+$/u.test(executable)) return null;
  return { tool: 'Bash', words, anyTail: prefix };
}

function absoluteProgram(program: string): boolean {
  // Shared settings can contain a rule for another OS.
  return posix.isAbsolute(program) || win32.isAbsolute(program);
}

function fileMatches(path: string[], parts: string[]): boolean {
  // A row tracks which prefixes of the target can be consumed by the pattern so far.
  // Unlike chained wildcard regexes, repeated '**' cannot backtrack exponentially.
  let row = Array.from({ length: parts.length + 1 }, (_, i) => i === 0);
  for (const segment of path) {
    if (segment === '**') {
      for (let i = 1; i < row.length; i++) row[i] ||= row[i - 1]!;
    } else {
      const [start, end] = segment.split('*');
      row = row.map((_, i) => {
        if (i === 0 || !row[i - 1]) return false;
        const part = parts[i - 1]!;
        return end === undefined
          ? part === segment
          : part.length >= start!.length + end.length &&
              part.startsWith(start!) &&
              part.endsWith(end);
      });
    }
  }
  return row[parts.length]!;
}

function matches(rule: Rule, target: ProjectPermissionTarget, deny: boolean): boolean {
  if (rule.tool !== target.tool) return false;
  // Refuse aliases on case-insensitive volumes even where the canonical spelling differs.
  // Explicit allows require the exact spelling, including on case-sensitive APFS/NTFS volumes.
  const fold = (value: string) =>
    deny && process.platform !== 'linux' ? value.normalize('NFC').toLowerCase() : value;
  if (rule.tool !== 'Bash' && target.tool !== 'Bash') {
    const relative = target.relativePath.split(sep).join('/');
    const parts = relative === '' || relative === '.' ? [] : relative.split('/');
    return fileMatches(rule.path.map(fold), parts.map(fold));
  }
  if (rule.tool !== 'Bash' || target.tool !== 'Bash') return false;
  const [program, ...args] = rule.words;
  if (program === undefined) return true;
  if (absoluteProgram(program)) {
    const normalized = process.platform === 'win32' ? program.replaceAll('/', '\\') : program;
    if (fold(normalized) !== fold(target.executable)) return false;
  } else {
    const programName = (s: string) =>
      process.platform === 'win32' ? s.replace(/\.exe$/iu, '') : s;
    const candidates = deny
      ? [basename(target.executable), target.trustedExecutableName]
      : [target.trustedExecutableName];
    if (
      !candidates.some(
        (name) => name !== undefined && fold(programName(name)) === fold(programName(program)),
      )
    )
      return false;
  }
  return (
    (rule.anyTail || target.argv.length === args.length) &&
    args.every((arg, i) => target.argv[i] === arg)
  );
}

export function matchProjectPermissionRules(
  settings: ProjectPermissionSettings,
  target: ProjectPermissionTarget,
): 'allow' | 'deny' | null {
  if (!settings.valid) return 'deny';
  if (target.tool === 'Edit') {
    const parts = target.relativePath.toLowerCase().split(sep).join('/').split('/');
    if (
      parts[0] === settingsDirectory &&
      (parts.length === 1 || settingsFiles.includes(parts[1]!))
    ) {
      return 'deny';
    }
  }
  for (const effect of ['deny', 'allow'] as const) {
    for (const text of settings[effect]) {
      const rule = parseRule(text);
      if (rule === null) return 'deny';
      if (matches(rule, target, effect === 'deny')) return effect;
    }
  }
  return null;
}

/** A search admission needs coverage of descendants; callers must still filter each deny. */
export function projectRuleAllowsReadTree(
  settings: ProjectPermissionSettings,
  relativePath: string,
): boolean {
  if (!settings.valid) return false;
  const target = { tool: 'Read' as const, relativePath };
  return settings.allow.some((text) => {
    const rule = parseRule(text);
    return rule?.tool === 'Read' && rule.path.at(-1) === '**' && matches(rule, target, false);
  });
}
