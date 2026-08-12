import { describe, expect, it } from 'vitest';
import {
  compatibilityFor,
  environmentValue,
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
  it('prefers a compatible stable npm Codex over a newer untested desktop alpha', () => {
    const selected = selectResolvedCliCommand([
      candidate({
        executable: 'C:\\OpenAI\\Codex\\bin\\hash\\codex.exe',
        source: 'desktop-versioned',
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

    expect(selected?.executable).toBe('C:\\npm\\codex.exe');
    expect(selected?.compatibility).toBe('compatible');
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
});
