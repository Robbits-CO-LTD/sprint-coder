import { describe, expect, it } from 'vitest';
import {
  capabilitiesFromClaudeHelp,
  compatibilityFor,
  environmentValue,
  probeFirstCapableCliCommand,
  selectResolvedCliCommand,
} from './cli-command-resolution';
import type { ResolvedCliCommand } from './protocol';

function candidate(
  input: Partial<ResolvedCliCommand> & Pick<ResolvedCliCommand, 'executable' | 'version'>,
): ResolvedCliCommand {
  return {
    source: 'path',
    compatibility: 'compatible',
    capabilities: ['version_probe'],
    ...input,
  };
}

describe('CLI command selection', () => {
  it('keeps the preferred installation source ahead of later compatibility fallbacks', () => {
    const selected = selectResolvedCliCommand([
      candidate({
        executable: 'C:\\TrustedPath\\codex.exe',
        source: 'path',
        version: 'codex-cli 0.147.0-alpha.6.6',
        compatibility: compatibilityFor('codex', 'codex-cli 0.147.0-alpha.6.6'),
      }),
      candidate({
        executable: 'C:\\npm\\codex.exe',
        source: 'npm',
        version: 'codex-cli 0.136.0',
        compatibility: compatibilityFor('codex', 'codex-cli 0.136.0'),
      }),
    ]);

    expect(selected?.executable).toBe('C:\\TrustedPath\\codex.exe');
    expect(selected?.compatibility).toBe('untested');
  });

  it('does not execute a later candidate after the preferred candidate passes its probes', async () => {
    const attempted: string[] = [];
    const preferred = candidate({ executable: 'C:\\trusted\\codex.exe', version: '0.144.4' });
    const selected = await probeFirstCapableCliCommand(
      'codex',
      [
        { executable: preferred.executable, source: 'path' },
        { executable: 'C:\\user-writable\\codex.exe', source: 'npm' },
      ],
      async (value) => {
        attempted.push(value.executable);
        if (value.executable !== preferred.executable)
          throw new Error('later candidate must not execute');
        return preferred;
      },
    );

    expect(selected).toBe(preferred);
    expect(attempted).toEqual([preferred.executable]);
  });

  it('compares only Codex Desktop candidates when a vendor installation is present', async () => {
    const attempted: string[] = [];
    const selected = await probeFirstCapableCliCommand(
      'codex',
      [
        { executable: 'C:\\OpenAI\\Codex\\bin\\current\\codex.exe', source: 'desktop-direct' },
        {
          executable: 'C:\\OpenAI\\Codex\\bin\\stable\\codex.exe',
          source: 'desktop-versioned',
        },
        { executable: 'C:\\user-writable\\codex.exe', source: 'path' },
      ],
      async (value) => {
        attempted.push(value.executable);
        if (value.source === 'path') throw new Error('PATH candidate must not execute');
        return candidate({
          ...value,
          version: value.source === 'desktop-direct' ? '0.130.0' : '0.144.4',
          compatibility: value.source === 'desktop-direct' ? 'unsupported' : 'verified',
        });
      },
    );

    expect(selected?.source).toBe('desktop-versioned');
    expect(attempted).toEqual([
      'C:\\OpenAI\\Codex\\bin\\current\\codex.exe',
      'C:\\OpenAI\\Codex\\bin\\stable\\codex.exe',
    ]);
  });

  it('rejects an unsupported first-win PATH binary without probing later fallbacks', async () => {
    const attempted: string[] = [];
    const selected = await probeFirstCapableCliCommand(
      'codex',
      [
        { executable: 'C:\\old\\codex.exe', source: 'path' },
        { executable: 'C:\\npm\\codex.exe', source: 'npm' },
      ],
      async (value) => {
        attempted.push(value.executable);
        return candidate({ ...value, version: '0.130.0', compatibility: 'unsupported' });
      },
    );

    expect(selected).toBeNull();
    expect(attempted).toEqual(['C:\\old\\codex.exe']);
  });

  it('classifies the documented probe versions without treating prereleases as verified', () => {
    expect(compatibilityFor('codex', 'codex-cli 0.144.4')).toBe('verified');
    expect(compatibilityFor('codex', 'codex-cli 0.130.0-alpha.5')).toBe('untested');
    expect(compatibilityFor('claude', '2.1.218 (Claude Code)')).toBe('verified');
    expect(compatibilityFor('claude', '2.1.169 (Claude Code)')).toBe('unsupported');
  });

  it('reads Windows environment keys case-insensitively without widening other platforms', () => {
    expect(environmentValue({ Path: 'C:\\Tools' }, 'PATH', 'win32')).toBe('C:\\Tools');
    expect(environmentValue({ Path: '/tools' }, 'PATH', 'darwin')).toBeUndefined();
  });

  it('requires every Claude flag used by the isolated runtime profile', () => {
    const complete = [
      '--output-format stream-json',
      '--include-partial-messages',
      '--strict-mcp-config',
      '--safe-mode',
      '--no-session-persistence',
    ].join('\n');
    expect(capabilitiesFromClaudeHelp(complete)).toEqual([
      'version_probe',
      'stream_json',
      'partial_messages',
      'strict_mcp_config',
      'safe_mode',
      'no_session_persistence',
    ]);
    expect(capabilitiesFromClaudeHelp(complete.replace('--strict-mcp-config', ''))).not.toContain(
      'strict_mcp_config',
    );
  });
});
