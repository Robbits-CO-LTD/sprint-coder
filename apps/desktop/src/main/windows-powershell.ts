/**
 * Builds arguments for a trusted, source-controlled PowerShell script.
 *
 * `-EncodedCommand` makes repeated invocations disproportionately expensive under Windows
 * Defender/AMSI on constrained CI and end-user machines. The script is a single argv value and
 * receives all untrusted data through environment variables, so no shell interpolation is needed.
 */
export function windowsPowerShellCommand(script: string): string[] {
  if (script.length === 0 || script.includes('\0'))
    throw new Error('Windows PowerShell script is invalid');
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script];
}

/**
 * Uses PowerShell's standard-input command mode for a trusted script that may be large.
 * Keeping the process command line fixed avoids repeatedly scanning a long command line while
 * still bypassing shell parsing; callers must write only source-controlled text to stdin.
 */
export function windowsPowerShellStdinCommand(): string[] {
  const command =
    "$ErrorActionPreference='Stop'; try { " +
    '[ScriptBlock]::Create([Console]::In.ReadToEnd()).Invoke(); exit 0 ' +
    '} catch { [Console]::Error.WriteLine($_); exit 1 }';
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command];
}
