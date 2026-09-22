import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GROK_AGENT_PROFILE, grokEnvironment, prepareGrokIsolation } from './grok-isolation';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return { ...actual, tmpdir: vi.fn(actual.tmpdir) };
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(os.tmpdir).mockReset();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function root() {
  const directory = mkdtempSync(join(os.tmpdir(), 'grok-isolation-fixture-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function isolate(source: NodeJS.ProcessEnv) {
  const isolation = prepareGrokIsolation(source);
  cleanups.push(isolation.cleanup);
  return isolation;
}

describe('Grok isolation', () => {
  it('isolates cwd and homes without copying or deleting original auth, config, or skills', () => {
    const originalHome = root();
    const originalGrokHome = join(originalHome, '.grok');
    mkdirSync(join(originalGrokHome, 'skills'), { recursive: true });
    const auth = join(originalGrokHome, 'auth.json');
    writeFileSync(auth, '{"fixture":"AUTH_CANARY"}');
    writeFileSync(join(originalGrokHome, 'config.toml'), 'UNTRUSTED_CONFIG_CANARY');
    const source = Object.freeze({
      HOME: originalHome,
      GROK_HOME: originalGrokHome,
      XAI_API_KEY: 'FIXTURE_API_KEY',
    });
    const isolation = isolate(source);
    const isolatedHome = isolation.environment['HOME']!;
    const grokHome = isolation.environment['GROK_HOME']!;
    expect(isolatedHome).not.toBe(originalHome);
    expect(isolation.environment['USERPROFILE']).toBe(isolatedHome);
    expect(isolation.environment['GROK_AUTH_PATH']).toBe(auth);
    expect(isolation.environment['XAI_API_KEY']).toBe('FIXTURE_API_KEY');
    expect(readdirSync(isolation.cwd)).toEqual([]);
    expect(readdirSync(grokHome)).toEqual(['config.toml']);
    expect(readFileSync(join(grokHome, 'config.toml'), 'utf8')).not.toMatch(
      /AUTH_CANARY|UNTRUSTED_CONFIG_CANARY/,
    );
    expect(source.HOME).toBe(originalHome);
    isolation.cleanup();
    isolation.cleanup();
    expect(existsSync(isolation.directory)).toBe(false);
    expect(readFileSync(auth, 'utf8')).toBe('{"fixture":"AUTH_CANARY"}');
    expect(readFileSync(join(originalGrokHome, 'config.toml'), 'utf8')).toBe(
      'UNTRUSTED_CONFIG_CANARY',
    );
  });

  it('preserves an explicit original auth path and ignores ambient configuration overrides', () => {
    const originalHome = root();
    const auth = join(originalHome, 'shared-auth.json');
    const isolation = isolate({
      HOME: originalHome,
      GROK_AUTH_PATH: auth,
      GROK_HOME: join(originalHome, 'custom'),
      GROK_MANAGED_MCPS_ENABLED: '1',
      GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED: '1',
      GROK_EXTERNAL_OTEL: '1',
    });
    expect(isolation.environment).toMatchObject({
      GROK_AUTH_PATH: auth,
      GROK_MANAGED_MCPS_ENABLED: '0',
      GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED: '0',
      GROK_EXTERNAL_OTEL: '0',
    });
    expect(existsSync(auth)).toBe(false);
    const config = readFileSync(join(isolation.environment['GROK_HOME']!, 'config.toml'), 'utf8');
    for (const section of [
      'managed_mcps',
      'compat.claude',
      'compat.codex',
      'compat.cursor',
      'memory',
    ]) {
      expect(config).toContain(`[${section}]\nenabled = false`);
    }
    expect(config).toContain('auto_update = false');
    expect(config).toContain('use_leader = false');
    const permission = config.split('[permission]')[1]?.split(/\n\[/u)[0];
    expect(permission).toBeDefined();
    const deny = permission?.match(/^deny\s*=\s*(\[[^\n]*\])/mu)?.[1];
    const allow = permission?.match(/^allow\s*=\s*(\[[^\n]*\])/mu)?.[1];
    expect(JSON.parse(deny ?? 'null')).toEqual([
      'Read',
      'Edit',
      'Bash',
      'Grep',
      'WebFetch',
      'WebSearch',
    ]);
    expect(JSON.parse(allow ?? 'null')).toEqual(['MCPTool(team__*)']);
  });

  it('uses USERPROFILE when HOME is absent and creates separate homes for concurrent turns', () => {
    const originalHome = root();
    const first = isolate({ USERPROFILE: originalHome });
    const second = isolate({ USERPROFILE: originalHome });
    expect(first.environment['GROK_AUTH_PATH']).toBe(join(originalHome, '.grok', 'auth.json'));
    expect(first.directory).not.toBe(second.directory);
    first.cleanup();
    expect(existsSync(second.cwd)).toBe(true);
  });

  it.each([{ GROK_AUTH_PATH: 'relative/auth.json' }, { GROK_HOME: 'relative-home' }])(
    'rejects relative auth locations and cleans partial staging: %s',
    (override) => {
      const temporaryRoot = root();
      vi.mocked(os.tmpdir).mockReturnValue(temporaryRoot);
      expect(() => prepareGrokIsolation({ HOME: temporaryRoot, ...override })).toThrow(
        'must be absolute',
      );
      expect(readdirSync(temporaryRoot)).toEqual([]);
    },
  );

  it.skipIf(process.platform === 'win32')('uses owner-only POSIX permissions', () => {
    const isolation = isolate({ HOME: root() });
    for (const directory of [
      isolation.directory,
      isolation.cwd,
      isolation.environment['HOME']!,
      isolation.environment['GROK_HOME']!,
    ]) {
      expect(statSync(directory).mode & 0o077).toBe(0);
    }
    expect(statSync(join(isolation.environment['GROK_HOME']!, 'config.toml')).mode & 0o077).toBe(0);
  });

  it('filters ambient execution hooks, alternative credentials and routing overrides', () => {
    const source = {
      PATH: '/fixture/bin',
      HOME: '/fixture/home',
      XAI_API_KEY: 'FAKE_KEY',
      NODE_OPTIONS: '--require unsafe.cjs',
      LD_PRELOAD: '/fixture/unsafe.so',
      DYLD_INSERT_LIBRARIES: '/fixture/unsafe.dylib',
      GROK_API_BASE: 'https://untrusted.invalid',
      GROK_AGENT: 'unrestricted',
      OPENAI_API_KEY: 'UNRELATED_KEY',
      CODEX_HOME: '/fixture/codex',
      HTTP_PROXY: 'http://untrusted.invalid',
    };
    expect(grokEnvironment(source)).toEqual({
      PATH: source.PATH,
      HOME: source.HOME,
      XAI_API_KEY: source.XAI_API_KEY,
    });
  });

  it('restricts the serialized agent profile to MCP dispatch and disables discovery', () => {
    expect(JSON.parse(JSON.stringify(GROK_AGENT_PROFILE))).toMatchObject({
      tools: ['search_tool', 'use_tool'],
      disallowedTools: ['Agent'],
      injectDefaultTools: false,
      discoverSkills: false,
      inheritSkills: false,
      agentsMd: false,
    });
  });
});
