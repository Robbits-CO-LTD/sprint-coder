import {
  accessSync,
  constants,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { environmentValue } from '../runtime-host/cli-command-resolution';
import { removeTreeWithoutFollowingLinksSync } from '../runtime-host/link-safe-tree-removal';

export const EXTERNAL_ACP_AGENTS = [
  { providerId: 'opencode', connectionId: 'builtin:opencode-cli', name: 'OpenCode' },
  { providerId: 'antigravity', connectionId: 'builtin:antigravity-cli', name: 'Antigravity' },
  { providerId: 'cursor', connectionId: 'builtin:cursor-cli', name: 'Cursor' },
] as const;

export type ExternalAcpAgent = (typeof EXTERNAL_ACP_AGENTS)[number];

export function isExternalAcpConnection(id: string | null): boolean {
  return EXTERNAL_ACP_AGENTS.some(({ connectionId }) => id === connectionId);
}

export function resolveExternalAcpCli(
  agent: ExternalAcpAgent,
): { executable: string; prefix: string[] } | undefined {
  const win = process.platform === 'win32';
  const command = agent.providerId === 'opencode' ? 'opencode' : 'agy';
  const executable = win ? `${command}.exe` : command;
  const search = (environmentValue(process.env, 'PATH') ?? '').split(delimiter);
  const home = homedir();
  const localAppData = environmentValue(process.env, 'LOCALAPPDATA');
  if (agent.providerId === 'cursor') {
    // The Windows shim runs PowerShell and the Unix launcher resolves HOME. Use the
    // official installation's paired node and entry point with the isolated HOME.
    const versions = win
      ? localAppData && join(localAppData, 'cursor-agent', 'versions')
      : join(home, '.local', 'share', 'cursor-agent', 'versions');
    if (!versions) return undefined;
    try {
      for (const version of readdirSync(versions)
        .filter((name) => /^\d{4}\.\d{2}\.\d{2}-[a-f0-9]+$/u.test(name))
        .sort()
        .reverse()) {
        const base = join(versions, version);
        const node = join(base, win ? 'node.exe' : 'node');
        const entry = join(base, 'index.js');
        try {
          if (!statSync(node).isFile() || !statSync(entry).isFile()) continue;
          accessSync(node, constants.X_OK);
          return { executable: node, prefix: [entry] };
        } catch {
          continue;
        }
      }
    } catch {
      return undefined;
    }
    return undefined;
  }
  const known = [
    join(home, '.local', 'bin'),
    ...(agent.providerId === 'opencode' ? [join(home, '.opencode', 'bin')] : []),
    ...(win && localAppData ? [join(localAppData, command, 'bin')] : []),
    ...search,
  ];
  for (const directory of known) {
    if (!isAbsolute(directory)) continue;
    try {
      const candidate = realpathSync(join(directory, executable));
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return { executable: candidate, prefix: [] };
    } catch {
      continue;
    }
  }
  return undefined;
}

export function prepareExternalAcpProfile(
  agent: ExternalAcpAgent,
  profileHome: string,
): { cwd: string; env: NodeJS.ProcessEnv; cleanup: () => Promise<void> } {
  const scratch = mkdtempSync(join(tmpdir(), 'sprint-acp-'));
  const cwd = join(scratch, 'chat');
  try {
    mkdirSync(cwd, { mode: 0o700 });
    const env: NodeJS.ProcessEnv = { TMPDIR: scratch, TMP: scratch, TEMP: scratch };
    for (const key of [
      'PATH',
      'SystemRoot',
      'WINDIR',
      'ComSpec',
      'PATHEXT',
      'USER',
      'LOGNAME',
      'SHELL',
      'TERM',
      '__CF_USER_TEXT_ENCODING',
      'LANG',
      'LC_ALL',
      'SSL_CERT_FILE',
      'SSL_CERT_DIR',
    ]) {
      const value = environmentValue(process.env, key);
      if (value !== undefined) env[key] = value;
    }

    const home = agent.providerId === 'opencode' ? join(scratch, 'home') : profileHome;
    mkdirSync(home, { recursive: true, mode: 0o700 });
    Object.assign(env, {
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, 'appdata'),
      LOCALAPPDATA: join(home, 'localdata'),
      XDG_CONFIG_HOME: join(home, 'config'),
      XDG_DATA_HOME: join(home, 'data'),
      XDG_STATE_HOME: join(home, 'state'),
      XDG_CACHE_HOME: join(home, 'cache'),
    });

    if (agent.providerId === 'opencode') {
      const denyAll = [{ action: '*', resource: '*', effect: 'deny' }];
      const freeModel = 'opencode/deepseek-v4.1-flash-free';
      writeFileSync(
        join(cwd, 'opencode.json'),
        JSON.stringify({
          // The primary model is negotiated over ACP. Auxiliary title/summary requests stay free.
          model: freeModel,
          small_model: freeModel,
          permissions: denyAll,
          policies: ['tool.use', 'mcp.use', 'skill.use', 'plugin.use'].map((action) => ({
            action,
            resource: '*',
            effect: 'deny',
          })),
          agents: { build: { permissions: denyAll }, plan: { permissions: denyAll } },
        }),
        { mode: 0o600, flag: 'wx' },
      );
    } else if (agent.providerId === 'cursor') {
      // Keep login in the dedicated home, permissions and MCP configuration per session.
      const config = join(scratch, 'cursor-config');
      mkdirSync(config, { mode: 0o700 });
      env['CURSOR_CONFIG_DIR'] = config;
      writeFileSync(
        join(config, 'cli-config.json'),
        JSON.stringify({
          version: 1,
          approvalMode: 'allowlist',
          sandbox: { readBoundary: 'workspace' },
          permissions: {
            allow: [],
            deny: ['Read(**)', 'Write(**)', 'Shell(*)', 'WebFetch(*)', 'Mcp(*:*)'],
          },
        }),
        { mode: 0o600, flag: 'wx' },
      );
    } else {
      // Antigravity keeps login in its dedicated profile. Startup settings that grant tool
      // authority are regenerated by Sprint Coder before each connection.
      const profile = join(home, '.gemini', 'antigravity-cli');
      mkdirSync(profile, { recursive: true, mode: 0o700 });
      const config = join(profile, 'settings.json');
      writeFileSync(
        config,
        JSON.stringify({
          toolPermission: 'strict',
          agentMode: 'default',
          useG1Credits: false,
          disableSlashCommands: true,
          permissions: {
            deny: [
              'command(*)',
              'read_file(*)',
              'write_file(*)',
              'read_url(*)',
              'execute_url(*)',
              'download_url(*)',
              'mcp(*)',
            ],
          },
        }),
        { mode: 0o600 },
      );
    }

    return { cwd, env, cleanup: () => removeStoppedProfile(scratch) };
  } catch (error) {
    removeTreeWithoutFollowingLinksSync(scratch);
    throw error;
  }
}

async function removeStoppedProfile(scratch: string): Promise<void> {
  // Windows can report an empty Job before releasing its working directory and log handles.
  for (let attempt = 0; ; attempt++) {
    try {
      removeTreeWithoutFollowingLinksSync(scratch);
      return;
    } catch (error) {
      if (
        process.platform !== 'win32' ||
        !(
          error instanceof Error &&
          'code' in error &&
          (error.code === 'EBUSY' || error.code === 'EPERM')
        ) ||
        attempt >= 5
      )
        throw error;
      await delay(100 * (attempt + 1));
    }
  }
}
