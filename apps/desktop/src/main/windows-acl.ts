import { execFile } from 'node:child_process';

const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
// Keep the subprocess deadline below Vitest's 20 second integration-test ceiling while allowing
// for PowerShell startup contention on two-core Windows runners. The previous 10 second deadline
// expired when several ACL-backed stores were exercised in parallel, even though the commands
// completed normally when run in isolation.
export const WINDOWS_ACL_TIMEOUT_MS = 18_000;

const secureAclScript = String.raw`
$ErrorActionPreference = 'Stop'
$items = @((([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(
  [Console]::In.ReadToEnd()
))) | ConvertFrom-Json))
$operation = $env:SPRINT_CODER_ACL_OPERATION
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
foreach ($item in $items) {
$path = [string]$item.path
$kind = [string]$item.kind
if ($operation -eq 'secure') {
  if ($kind -eq 'directory') {
    $acl = [System.Security.AccessControl.DirectorySecurity]::new()
    $inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  } else {
    $acl = [System.Security.AccessControl.FileSecurity]::new()
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
  }
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
    $sid,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    $inheritance,
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
  $acl.SetAccessRule($rule)
  if ($kind -eq 'directory') {
    [System.IO.Directory]::SetAccessControl($path, $acl)
  } else {
    [System.IO.File]::SetAccessControl($path, $acl)
  }
}
if ($kind -eq 'directory') {
  $actual = [System.IO.Directory]::GetAccessControl($path)
} else {
  $actual = [System.IO.File]::GetAccessControl($path)
}
if (-not $actual.AreAccessRulesProtected) { throw 'ACL inheritance is enabled' }
if ($actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) {
  throw 'ACL owner is not the current user'
}
$rules = @($actual.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]))
if ($rules.Count -ne 1) { throw 'ACL contains unexpected explicit rules' }
$only = $rules[0]
if ($only.IdentityReference.Value -ne $sid.Value) { throw 'ACL grants another principal' }
if ($only.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) {
  throw 'ACL rule is not an allow rule'
}
if (($only.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne
    [System.Security.AccessControl.FileSystemRights]::FullControl) {
  throw 'ACL does not grant the current user full control'
}
}
exit 0
`;

export type WindowsAclPath = Readonly<{ path: string; kind: 'directory' | 'file' }>;

export async function secureWindowsPath(path: string, kind: 'directory' | 'file'): Promise<void> {
  await secureWindowsPaths([{ path, kind }]);
}

export async function secureWindowsPaths(paths: readonly WindowsAclPath[]): Promise<void> {
  await runAcl(paths, 'secure');
}

export async function verifyWindowsPathAcl(
  path: string,
  kind: 'directory' | 'file',
): Promise<void> {
  await verifyWindowsPaths([{ path, kind }]);
}

export async function verifyWindowsPaths(paths: readonly WindowsAclPath[]): Promise<void> {
  await runAcl(paths, 'verify');
}

async function runAcl(
  paths: readonly WindowsAclPath[],
  operation: 'secure' | 'verify',
): Promise<void> {
  if (process.platform !== 'win32' || paths.length === 0) return;
  const unique = [
    ...new Map(
      paths.map((item) => [`${item.kind}:${item.path.toLocaleLowerCase('en-US')}`, item]),
    ).values(),
  ];
  const encodedScript = Buffer.from(secureAclScript, 'utf16le').toString('base64');
  const encodedItems = Buffer.from(JSON.stringify(unique), 'utf8').toString('base64');
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      POWERSHELL,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript],
      {
        env: {
          SystemRoot: process.env['SystemRoot'] ?? 'C:\\Windows',
          WINDIR: process.env['WINDIR'] ?? 'C:\\Windows',
          PATH: process.env['PATH'] ?? '',
          TEMP: process.env['TEMP'] ?? '',
          TMP: process.env['TMP'] ?? '',
          USERPROFILE: process.env['USERPROFILE'] ?? '',
          SPRINT_CODER_ACL_OPERATION: operation,
        },
        encoding: 'utf8',
        timeout: WINDOWS_ACL_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 64 * 1024,
      },
      (error) => (error === null ? resolve() : reject(error)),
    );
    // A Skill can contain 256 files, so its encoded ACL list can exceed Windows' roughly 32K
    // process-environment limit. Standard input has no such environment-block ceiling.
    child.stdin?.end(encodedItems);
  });
}
