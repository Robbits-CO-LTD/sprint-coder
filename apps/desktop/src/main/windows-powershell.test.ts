import { describe, expect, it } from 'vitest';
import { windowsPowerShellCommand } from './windows-powershell';

describe('windowsPowerShellCommand', () => {
  it('passes a fixed script as one ordinary argument without EncodedCommand', () => {
    const script = '$value = $env:SPRINT_CODER_VALUE\n[Console]::Out.Write($value)';
    const args = windowsPowerShellCommand(script);

    expect(args).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script]);
    expect(args).not.toContain('-EncodedCommand');
  });

  it('rejects an empty or NUL-containing script', () => {
    expect(() => windowsPowerShellCommand('')).toThrow('script is invalid');
    expect(() => windowsPowerShellCommand("Write-Output 'ok'\0ignored")).toThrow(
      'script is invalid',
    );
  });
});
