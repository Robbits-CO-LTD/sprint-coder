import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

const secureAclScript = String.raw`
$ErrorActionPreference = 'Stop'
$path = $env:SPRINT_CODER_ACL_PATH
$kind = $env:SPRINT_CODER_ACL_KIND
$operation = $env:SPRINT_CODER_ACL_OPERATION
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
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
exit 0
`;

export async function secureWindowsPath(path: string, kind: 'directory' | 'file'): Promise<void> {
  await runAcl(path, kind, 'secure');
}

export async function verifyWindowsPathAcl(
  path: string,
  kind: 'directory' | 'file',
): Promise<void> {
  await runAcl(path, kind, 'verify');
}

async function runAcl(
  path: string,
  kind: 'directory' | 'file',
  operation: 'secure' | 'verify',
): Promise<void> {
  if (process.platform !== 'win32') return;
  const encodedScript = Buffer.from(secureAclScript, 'utf16le').toString('base64');
  await execFileAsync(
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
        SPRINT_CODER_ACL_PATH: path,
        SPRINT_CODER_ACL_KIND: kind,
        SPRINT_CODER_ACL_OPERATION: operation,
      },
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
      maxBuffer: 64 * 1024,
    },
  );
}
