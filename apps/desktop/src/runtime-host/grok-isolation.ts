import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { environmentValue } from './cli-command-resolution';

// Auth stays owned by the official CLI, including its refresh lock. Do not copy OAuth refresh
// tokens into per-turn homes: refresh-token rotation would strand the original installation.
export function prepareGrokIsolation(source: Readonly<NodeJS.ProcessEnv> = process.env) {
  const directory = mkdtempSync(join(tmpdir(), 'sprint-coder-grok-'));
  const userHome = join(directory, 'home');
  const grokHome = join(userHome, '.grok');
  const cwd = join(directory, 'work');
  try {
    for (const path of [userHome, grokHome, cwd]) mkdirSync(path, { recursive: true, mode: 0o700 });
    writeFileSync(join(grokHome, 'config.toml'), GROK_ISOLATION_CONFIG, { mode: 0o600 });
    const originalHome =
      environmentValue(source, 'HOME') ?? environmentValue(source, 'USERPROFILE') ?? homedir();
    const originalGrokHome = environmentValue(source, 'GROK_HOME') || join(originalHome, '.grok');
    const authPath =
      environmentValue(source, 'GROK_AUTH_PATH') || join(originalGrokHome, 'auth.json');
    if (!isAbsolute(authPath)) throw new Error('Grok authentication path must be absolute');
    const environment: NodeJS.ProcessEnv = {
      ...grokEnvironment(source),
      HOME: userHome,
      USERPROFILE: userHome,
      GROK_HOME: grokHome,
      GROK_AUTH_PATH: authPath,
      GROK_MANAGED_MCPS_ENABLED: '0',
      GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED: '0',
      GROK_EXTERNAL_OTEL: '0',
    };
    return {
      directory,
      cwd,
      environment,
      cleanup: () => rmSync(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export function grokEnvironment(
  source: Readonly<NodeJS.ProcessEnv> = process.env,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    [
      'PATH',
      'HOME',
      'USER',
      'LOGNAME',
      'USERPROFILE',
      'SystemRoot',
      'WINDIR',
      'ComSpec',
      'PATHEXT',
      'TMPDIR',
      'TMP',
      'TEMP',
      'LANG',
      'LC_ALL',
      'SSL_CERT_FILE',
      'SSL_CERT_DIR',
      'XAI_API_KEY',
    ].flatMap((key) => {
      const value = environmentValue(source, key);
      return value === undefined ? [] : [[key, value]];
    }),
  );
}

export const GROK_AGENT_PROFILE = Object.freeze({
  name: 'sprint-coder',
  description: 'Sprint Coder managed host tools',
  tools: ['search_tool', 'use_tool'],
  disallowedTools: ['Agent'],
  injectDefaultTools: false,
  discoverSkills: false,
  inheritSkills: false,
  agentsMd: false,
});

const GROK_ISOLATION_CONFIG = `
[cli]
auto_update = false
use_leader = false
[features]
telemetry = false
[telemetry]
trace_upload = false
otel_enabled = false
[managed_mcps]
enabled = false
gateway_tools_enabled = false
[compat.claude]
enabled = false
[compat.codex]
enabled = false
[compat.cursor]
enabled = false
[memory]
enabled = false
[permission]
# search_tool is a pathless Read. Deny every file path (including use_tool file
# arguments) without denying tool discovery; Read(*) also matches pathless Read.
deny = ["Read(**)", "Edit", "Bash", "Grep", "WebFetch", "WebSearch"]
allow = ["MCPTool(team__*)"]
`;
