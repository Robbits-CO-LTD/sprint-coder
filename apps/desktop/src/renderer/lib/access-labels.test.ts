import { describe, expect, it } from 'vitest';
import { accessDescription, accessEnforcement, commandSandboxDescription } from './access-labels';

describe('managed access labels', () => {
  it('shows the measured sandbox backend instead of the selected Runtime', () => {
    const capability = {
      available: true,
      backend: 'macos-seatbelt',
      reason: null,
      probedAt: '2026-08-18T00:00:00.000Z',
    };
    expect(accessEnforcement(capability)).toBe('os-sandbox');
    expect(accessDescription('auto', capability)).toContain('macos-seatbelt');
    expect(commandSandboxDescription(capability)).not.toMatch(/Codex|Claude|Mock/u);
  });

  it('describes Auto as auto-allowing Workspace file edits and reviewing the rest (issue #526)', () => {
    const description = accessDescription('auto', null);
    expect(description).toContain('Workspace内のファイルの作成・編集は自動で許可します');
    expect(description).toContain('コマンドなどそれ以外の操作は自動レビューで判定します');
  });

  it('reports fail-closed command removal with the probe reason', () => {
    const capability = {
      available: false,
      backend: 'linux-bubblewrap-landlock-seccomp',
      reason: 'bubblewrap_probe_failed',
      probedAt: '2026-08-18T00:00:00.000Z',
    };
    expect(accessEnforcement(capability)).toBe('command-unavailable');
    expect(commandSandboxDescription(capability)).toContain('bubblewrap_probe_failed');
  });
});
