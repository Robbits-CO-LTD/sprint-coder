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
  $env:SPRINT_CODER_ACL_ITEMS
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
const MAX_ENCODED_BATCH_CHARS = 20_000;
type AclOperation = 'secure' | 'verify';
type PendingAclRequest = Readonly<{
  paths: readonly WindowsAclPath[];
  operation: AclOperation;
  resolve: () => void;
  reject: (error: unknown) => void;
}>;
const pendingAclRequests: PendingAclRequest[] = [];
let drainingAclRequests = false;

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

async function runAcl(paths: readonly WindowsAclPath[], operation: AclOperation): Promise<void> {
  if (process.platform !== 'win32' || paths.length === 0) return;
  await new Promise<void>((resolve, reject) => {
    pendingAclRequests.push({ paths, operation, resolve, reject });
    void drainAclQueue();
  });
}

async function drainAclQueue(): Promise<void> {
  if (drainingAclRequests) return;
  drainingAclRequests = true;
  try {
    // Let ACL requests started by parallel Vitest files join one wave. Starting many Windows
    // PowerShell hosts at once can starve all of them until their deadlines on GitHub runners.
    await new Promise<void>((resolve) => setImmediate(resolve));
    while (pendingAclRequests.length > 0) {
      const wave = pendingAclRequests.splice(0);
      for (const operation of ['secure', 'verify'] as const) {
        const requests = wave.filter((request) => request.operation === operation);
        if (requests.length === 0) continue;
        try {
          await executeAcl(
            requests.flatMap((request) => request.paths),
            operation,
          );
          for (const request of requests) request.resolve();
        } catch (error) {
          for (const request of requests) request.reject(error);
        }
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  } finally {
    drainingAclRequests = false;
    if (pendingAclRequests.length > 0) void drainAclQueue();
  }
}

async function executeAcl(
  paths: readonly WindowsAclPath[],
  operation: AclOperation,
): Promise<void> {
  const unique = [
    ...new Map(
      paths.map((item) => [`${item.kind}:${item.path.toLocaleLowerCase('en-US')}`, item]),
    ).values(),
  ];
  for (const batch of aclBatches(unique)) await runAclBatch(batch, operation);
}

async function runAclBatch(
  paths: readonly WindowsAclPath[],
  operation: AclOperation,
): Promise<void> {
  const encodedScript = Buffer.from(secureAclScript, 'utf16le').toString('base64');
  const encodedItems = Buffer.from(JSON.stringify(paths), 'utf8').toString('base64');
  await new Promise<void>((resolve, reject) => {
    execFile(
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
          SPRINT_CODER_ACL_ITEMS: encodedItems,
        },
        encoding: 'utf8',
        timeout: WINDOWS_ACL_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 64 * 1024,
      },
      (error) => (error === null ? resolve() : reject(error)),
    );
  });
}

function aclBatches(paths: readonly WindowsAclPath[]): WindowsAclPath[][] {
  const batches: WindowsAclPath[][] = [];
  let current: WindowsAclPath[] = [];
  for (const path of paths) {
    const candidate = [...current, path];
    const encodedLength = Buffer.byteLength(JSON.stringify(candidate), 'utf8') * 2;
    if (encodedLength <= MAX_ENCODED_BATCH_CHARS) {
      current = candidate;
      continue;
    }
    if (current.length === 0) throw new Error('Windows ACL path exceeds the process input limit');
    batches.push(current);
    current = [path];
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
