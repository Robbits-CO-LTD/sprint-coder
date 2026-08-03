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
