import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type * as NodeChildProcess from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type TestContext } from 'vitest';
import { computerAppIdentitySchema, computerUseEligibilitySchema } from '@sprint-coder/contracts';
import {
  ComputerUseController,
  type ComputerUseControllerPersistence,
} from './computer-use-controller';
import { createComputerAppGrantFixtureStore } from './computer-use-grant-fixture';
import { COMPUTER_USE_WINDOWS_UNSIGNED_ACCEPTANCE } from './computer-use-acceptance-mode';
import {
  COMPUTER_USE_NATIVE_CLOSE_ATTEMPT_LIMIT,
  COMPUTER_USE_NATIVE_CLOSE_DRAIN_TIMEOUT_MS,
  createComputerUseNativeHost,
} from './computer-use-native-host';
import {
  COMPUTER_USE_NATIVE_CLOSE_TRANSPORT_TIMEOUT_MS,
  createWindowsComputerUseNativeAddon,
  operationTimeoutMilliseconds,
} from './computer-use-native-windows';
import type { ComputerUseNativeAddon, ComputerUseNativeBinding } from './computer-use-native-types';
import type { ComputerAppProfileRecord } from './persistence';

// Pass through every OS operation. The observer owns only the child/exit/kill timestamps and cleanup;
// attestation, framing, pipe, deadlines, Host and Controller are all the production implementations.
const observer = vi.hoisted(() => ({
  spawned: null as ((child: ChildProcess, options: SpawnOptions) => void) | null,
}));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof NodeChildProcess>();
  return {
    ...actual,
    spawn: (file: string, args: string[], options: SpawnOptions) => {
      const child = actual.spawn(file, args, options);
      observer.spawned?.(child, options);
      return child;
    },
  };
});

const nativeDirectory = join(__dirname, '../../computer-use-native');
const source = join(nativeDirectory, 'computer_use_windows_hung_helper_test.cc');
const commit = '0123456789abcdef0123456789abcdef01234567';
const enabled = process.env['SPRINT_CODER_HUNG_HELPER_SEAM'] === '1';
const ci = Boolean(process.env['CI']);
const hostSource = readFileSync(join(__dirname, 'computer-use-native-host.ts'), 'utf8');
function numberConstant(text: string, name: string): number {
  const match = new RegExp(`${name}(?:\\s*=\\s*|\\{)([0-9_']+)`, 'u').exec(text);
  if (!match?.[1]) throw new Error(`Missing constant ${name}`);
  return Number(match[1].replaceAll('_', '').replaceAll("'", ''));
}
const cancelBudget = numberConstant(hostSource, 'COMPUTER_USE_NATIVE_CANCEL_ACK_TIMEOUT_MS');
const stopBudget =
  cancelBudget +
  COMPUTER_USE_NATIVE_CLOSE_DRAIN_TIMEOUT_MS * COMPUTER_USE_NATIVE_CLOSE_ATTEMPT_LIMIT;
// The transport's positive kill path (a close that expires with no unconfirmed semantic input or
// discovery, killed about killBudget after the first close) is not reachable live from the current
// hook points: UiaCall, Capture, WinVerifyTrust and CreateFileW park a worker while the serve loop
// keeps answering, and SemanticPattern is retained by design. No case here can therefore observe
// that kill. It is fixed by the N2-1 fake-timer baseline in computer-use-windows-transport.test.ts
// ("kill-stop (N3) replacement baseline for current Stop timing"); here killBudget is only the wait
// that proves a retained helper was not killed.
const killBudget =
  cancelBudget +
  COMPUTER_USE_NATIVE_CLOSE_DRAIN_TIMEOUT_MS * (COMPUTER_USE_NATIVE_CLOSE_ATTEMPT_LIMIT - 1) +
  COMPUTER_USE_NATIVE_CLOSE_TRANSPORT_TIMEOUT_MS;
const uiaWatchdog = numberConstant(
  readFileSync(join(nativeDirectory, 'computer_use_windows_host_uia_lane.inc'), 'utf8'),
  'kWindowsV1UiaSlowContact',
);
const margin = 2_000;
const caseTimeout = killBudget * 3 + 60_000;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean, timeout: number, label: string) {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start >= timeout) throw new Error(`Timed out: ${label}`);
    await delay(20);
  }
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Expected native object');
  return value as Record<string, unknown>;
}
function errorCode(value: unknown): string | null {
  return value instanceof Error ? String(Reflect.get(value, 'code') ?? value.message) : null;
}
const settle = (value: unknown) => Promise.resolve(value).catch((error: unknown) => error);
type ChildEvidence = {
  child: ChildProcess;
  exited: boolean;
  kills: number[];
  exitAt: number | null;
  temp?: string;
};
const children: ChildEvidence[] = [];
const controllers: ComputerUseController[] = [];
let scratch: string | undefined;
let hung = '';
let healthy = '';
let unavailable = 'live seam requires SPRINT_CODER_HUNG_HELPER_SEAM=1';
let ready = false;
const probes = new Map<string, Record<string, unknown>>();
// Every skipped live case is counted and printed once, so a skip never passes silently.
const notRun: Array<{ case: string; reason: string }> = [];
// The only NOT_RUN the CI live job expects: windows-2022 does not make System32 Notepad
// full_access_app, so the session cases cannot start there. Any other reason in that job (a broken
// --identity, a Store redirect, a missing owned window, ...) fails the case instead of skipping.
const ciExpectedNotRun = 'classic_notepad_not_eligible';
function skipWith(context: TestContext, reason: string): never {
  notRun.push({ case: context.task.name, reason });
  console.log(`HUNG_HELPER_NOT_RUN ${JSON.stringify({ case: context.task.name, reason })}`);
  if (ci && enabled && reason !== ciExpectedNotRun)
    throw new Error(`Unexpected NOT_RUN reason in the CI live seam: ${reason}`);
  return context.skip(reason);
}

const libraries = [
  'ole32.lib',
  'oleaut32.lib',
  'uiautomationcore.lib',
  'user32.lib',
  'dwmapi.lib',
  'd3d11.lib',
  'dxgi.lib',
  'windowscodecs.lib',
  'bcrypt.lib',
  'advapi32.lib',
  'userenv.lib',
  'crypt32.lib',
  'wintrust.lib',
  'shell32.lib',
  'runtimeobject.lib',
  'windowsapp.lib',
  'uuid.lib',
];
function compiler() {
  if (spawnSync('cl.exe', ['/?'], { stdio: 'ignore', windowsHide: true }).status === 0) return '';
  const vswhere = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';
  if (!existsSync(vswhere)) return null;
  const result = spawnSync(
    vswhere,
    [
      '-latest',
      '-products',
      '*',
      '-requires',
      'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      '-property',
      'installationPath',
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  const root = result.stdout?.trim();
  if (result.status !== 0 || !root) return null;
  const vcvars = join(root, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
  return existsSync(vcvars) ? vcvars : null;
}
async function run(file: string, args: string[], timeout: number, verbatim = false) {
  const child = spawn(file, args, {
    cwd: scratch,
    windowsHide: true,
    windowsVerbatimArguments: verbatim,
    env: { ...process.env, VSLANG: '1033' },
    stdio: 'pipe',
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  return await new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        // A vcvars shell owns cl/link descendants. Kill the owned tree, then wait for close,
        // before scratch removal; terminating only cmd.exe can leave a compiler holding it.
        if (child.pid !== undefined) {
          spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
            timeout: 10_000,
          });
        }
        child.kill();
      }, timeout);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (status) => {
        clearTimeout(timer);
        if (timedOut) reject(new Error('Seam subprocess timed out; owned process tree terminated'));
        else resolve({ status, stdout, stderr });
      });
    },
  );
}
// The product attests every spawned helper with Windows PowerShell under a fixed 10 s deadline
// (attestSpawnedWindowsComputerUseHelper: Import-Module of the Security module, Get-Process of the
// helper and its MainModule, SHA-256 of the image, Get-AuthenticodeSignature of the image). On a
// fresh runner the first module load and the first Authenticode/catalog lookup of a newly built
// image can take longer than that, and an attestation killed at 10 s leaves nothing warmed for
// the next one. So the same steps run once here, on the same powershell.exe and module path and on
// the exact images the seam spawns (hung and healthy), under a generous deadline, and each stage is
// printed as HUNG_HELPER_ATTEST_WARMUP. A failed or expired warm-up fails the run (never NOT_RUN).
// The product deadline, attestation and process are untouched: a later attestation that still
// exceeds 10 s fails its case and is a product finding.
const attestWarmupTimeout = 120_000;
function attestWarmup() {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$total = [System.Diagnostics.Stopwatch]::StartNew()',
    '$stage = [System.Diagnostics.Stopwatch]::StartNew()',
    'Import-Module "$PSHOME\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1"',
    '$importMs = $stage.ElapsedMilliseconds',
    '$stage.Restart()',
    '$self = Get-Process -Id $PID -ErrorAction Stop',
    'try { $null = $self.MainModule.FileName } finally { $self.Dispose() }',
    '$mainModuleMs = $stage.ElapsedMilliseconds',
    '$images = foreach ($imagePath in @($env:SPRINT_CODER_SEAM_WARM_HUNG, $env:SPRINT_CODER_SEAM_WARM_HEALTHY)) {',
    '  $stage.Restart()',
    '  $stream = [System.IO.File]::Open($imagePath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)',
    '  try {',
    '    $sha = [System.Security.Cryptography.SHA256]::Create()',
    "    try { $digest = ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }",
    '  } finally { $stream.Dispose() }',
    '  $shaMs = $stage.ElapsedMilliseconds',
    '  $stage.Restart()',
    '  $signature = Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath $imagePath',
    '  [pscustomobject]@{image=[System.IO.Path]::GetFileName($imagePath);digest=$digest;sha256_ms=$shaMs;authenticode_ms=$stage.ElapsedMilliseconds;signature=$signature.Status.ToString()}',
    '}',
    '[pscustomobject]@{import_ms=$importMs;main_module_ms=$mainModuleMs;images=@($images);script_ms=$total.ElapsedMilliseconds} | ConvertTo-Json -Compress -Depth 4',
  ].join('\n');
  const start = performance.now();
  const warm = spawnSync(
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: attestWarmupTimeout,
      maxBuffer: 64 * 1024,
      env: {
        ...process.env,
        SPRINT_CODER_SEAM_WARM_HUNG: hung,
        SPRINT_CODER_SEAM_WARM_HEALTHY: healthy,
      },
    },
  );
  const processMs = Math.round(performance.now() - start);
  const failure = (reason: string) => {
    const detail = {
      status: warm.status,
      signal: warm.signal,
      reason,
      process_ms: processMs,
      stderr: (warm.stderr ?? '').trim().slice(-400),
    };
    console.log(`HUNG_HELPER_ATTEST_WARMUP ${JSON.stringify(detail)}`);
    return new Error(`Attestation warm-up failed: ${reason}`);
  };
  if (warm.error) throw failure(errorCode(warm.error) ?? 'spawn_error');
  if (warm.status !== 0) throw failure('nonzero_exit');
  const stages = record(JSON.parse(warm.stdout.trim()) as unknown);
  const images = Array.isArray(stages['images']) ? stages['images'].map(record) : [];
  if (images.length !== 2) throw failure('missing_image_stages');
  for (const [index, binary] of [hung, healthy].entries()) {
    // The warm-up hashed the same file the product will attest.
    const digest = createHash('sha256').update(readFileSync(binary)).digest('hex');
    if (images[index]?.['digest'] !== digest) throw failure('image_digest_mismatch');
    delete images[index]?.['digest'];
  }
  console.log(
    `HUNG_HELPER_ATTEST_WARMUP ${JSON.stringify({ status: 0, process_ms: processMs, ...stages, images })}`,
  );
}
beforeAll(async () => {
  if (!enabled) return;
  if (process.platform !== 'win32') {
    unavailable = 'Windows is required';
    if (ci) throw new Error(unavailable);
    return;
  }
  const vcvars = compiler();
  if (vcvars === null) {
    unavailable = 'MSVC unavailable (or sandbox denies compiler discovery)';
    if (ci) throw new Error(unavailable);
    return;
  }
  scratch = mkdtempSync(join(tmpdir(), 'sc-hung-helper-seam-'));
  const provenance = join(scratch, 'provenance.h');
  writeFileSync(provenance, `#define SPRINT_CODER_SOURCE_COMMIT "${commit}"\n`);
  hung = join(scratch, 'hung.exe');
  healthy = join(scratch, 'healthy.exe');
  for (const [binary, flag] of [
    [hung, true],
    [healthy, false],
  ] as const) {
    const args = [
      '/nologo',
      '/std:c++20',
      '/EHsc',
      '/permissive-',
      '/utf-8',
      '/DUNICODE',
      '/D_UNICODE',
      '/DWIN32_LEAN_AND_MEAN',
      '/DNOMINMAX',
      '/D_WIN32_WINNT=0x0A00',
      '/DSPRINT_CODER_ELIGIBILITY_V2=0',
      `/FI${provenance}`,
      `/I${nativeDirectory}`,
      ...(flag ? ['/DSPRINT_CODER_COMPUTER_USE_TEST_HANG=1'] : []),
      source,
      `/Fe:${binary}`,
      `/Fo:${binary}.obj`,
      '/link',
      '/DEBUG:NONE',
      ...libraries,
    ];
    const result =
      vcvars === ''
        ? await run('cl.exe', args, 280_000)
        : await run(
            'cmd.exe',
            [
              '/d',
              '/s',
              '/c',
              `"call "${vcvars}" >nul && cl.exe ${args.map((arg) => `"${arg}"`).join(' ')}"`,
            ],
            280_000,
            true,
          );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const probe = await run(binary, ['--probe-json'], 30_000);
    expect(probe.status, 'native probe exit code').toBe(0);
    probes.set(binary, record(JSON.parse(probe.stdout) as unknown));
  }
  attestWarmup();
  ready = true;
}, 650_000);

function live(context: TestContext) {
  if (ready) return;
  if (ci && enabled) throw new Error(unavailable);
  skipWith(context, unavailable);
}
function arm(point: string) {
  if (!scratch) throw new Error('No scratch directory');
  rmSync(join(scratch, 'hang-entered.txt'), { force: true });
  writeFileSync(join(scratch, 'sprint-coder-test-hang.txt'), point, 'ascii');
}
const entered = () => Boolean(scratch && existsSync(join(scratch, 'hang-entered.txt')));
async function awaitHang(request: Promise<unknown>, timeout: number) {
  let settled = false;
  let outcome: unknown;
  void request.then((value) => {
    settled = true;
    outcome = value;
  });
  await until(() => entered() || settled, timeout, 'hang entry or request completion');
  if (!entered()) {
    if (outcome instanceof Error) throw outcome;
    throw new Error('Request completed without reaching the selected hang');
  }
}
function observeChildren() {
  observer.spawned = (child, options) => {
    const temp = options.env?.['SPRINT_CODER_COMPUTER_USE_HELPER_TEMP'];
    const evidence: ChildEvidence = {
      child,
      exited: false,
      kills: [],
      exitAt: null,
      ...(temp ? { temp } : {}),
    };
    children.push(evidence);
    const kill = child.kill.bind(child);
    vi.spyOn(child, 'kill').mockImplementation((signal) => {
      evidence.kills.push(performance.now());
      return kill(signal);
    });
    child.once('exit', () => {
      evidence.exited = true;
      evidence.exitAt = performance.now();
    });
    child.once('error', () => {
      if (child.pid === undefined) evidence.exited = true;
    });
  };
}
afterEach(async () => {
  // Every step runs even when an earlier one fails; failures are collected and thrown at the end.
  const failures: unknown[] = [];
  const step = async (action: () => unknown) => {
    try {
      await action();
    } catch (error) {
      failures.push(error);
    }
  };
  // Keep observing through disposal: a failed case may still have an active start or session.
  for (const controller of controllers.splice(0)) await step(() => controller.dispose());
  await step(() => {
    for (const row of children) if (!row.exited) row.child.kill();
  });
  await step(() =>
    until(() => children.every((row) => row.exited), 10_000, 'all seam children exited'),
  );
  observer.spawned = null;
  await step(() =>
    until(
      () => children.every((row) => !row.temp || !existsSync(row.temp)),
      10_000,
      'transport scratch removed',
    ),
  );
  await step(closeSeamNotepads);
  children.length = 0;
  await step(() => vi.unstubAllGlobals());
  await step(() => vi.restoreAllMocks());
  await step(() => {
    if (scratch) arm('');
  });
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'seam cleanup failed');
}, 60_000);
afterAll(async () => {
  if (notRun.length > 0) {
    const reasons = [...new Set(notRun.map((row) => row.reason))];
    console.log(
      `HUNG_HELPER_NOT_RUN_SUMMARY ${JSON.stringify({
        count: notRun.length,
        reason: reasons.length === 1 ? reasons[0] : 'mixed',
        reasons: Object.fromEntries(
          reasons.map((reason) => [reason, notRun.filter((row) => row.reason === reason).length]),
        ),
        cases: notRun.map((row) => row.case),
      })}`,
    );
  }
  if (!scratch) return;
  const directory = scratch;
  expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(directory, { recursive: true, force: true });
      break;
    } catch {
      await delay(100);
    }
  }
  expect(existsSync(directory), 'seam scratch removed').toBe(false);
}, 10_000);

function addonFor(binary: string) {
  vi.stubGlobal('__SPRINT_CODER_COMPUTER_USE_ACCEPTANCE_BUILD__', {
    mode: COMPUTER_USE_WINDOWS_UNSIGNED_ACCEPTANCE,
    marker: 'hung-helper-live-seam',
  });
  const binaryDigest = createHash('sha256').update(readFileSync(binary)).digest('hex');
  const measured = probes.get(binary);
  if (!measured) throw new Error('Native probe missing');
  const capabilities = record(measured['capabilities']);
  const eligibility = computerUseEligibilitySchema.parse(measured['eligibility']);
  const probe: ComputerUseNativeBinding['probe'] = {
    available: measured['available'] === true,
    protocolVersion: 1,
    apiVersion: 3,
    backend: String(measured['backend']),
    reason: String(measured['reason']),
    artifactPath: binary,
    artifactDigest: binaryDigest,
    capabilities: {
      observe: capabilities['observe'] === true,
      control: capabilities['control'] === true,
      accessibility: capabilities['uiAutomation'] === true,
      screenCapture: capabilities['graphicsCapture'] === true,
      cancellableWindowDiscovery: capabilities['cancellableWindowDiscovery'] === true,
    },
  };
  const addon = createWindowsComputerUseNativeAddon(binary, measured, {
    binaryDigest,
    signerDigest: null,
    sourceCommit: commit,
    eligibility,
  });
  return {
    addon,
    binding: {
      addon,
      artifactPath: binary,
      probe,
      manifest: {
        version: 1,
        sourceCommit: commit,
        platform: 'win32',
        architecture: 'x64',
        protocolVersion: 1,
        apiVersion: 3,
        nativeVersion: 'live-seam',
        moduleDigest: binaryDigest,
        binaryDigest,
        signerDigest: null,
        eligibility,
        capabilities: ['observe', 'capture', 'accessibility', 'input'],
      },
    } satisfies ComputerUseNativeBinding,
  };
}
function profileFor(
  identity: ReturnType<typeof computerAppIdentitySchema.parse>,
): ComputerAppProfileRecord {
  if (identity.platform !== 'win32') throw new Error('Windows identity required');
  return {
    id: 'seam-profile',
    platform: 'win32',
    kind: 'win32-executable',
    label: 'Seam',
    canonicalPath: identity.executablePath,
    appUrl: null,
    identity,
    identityDigest: identity.identityDigest,
    executableDigest: identity.executableDigest,
    version: null,
    mode: 'full_access_app',
    connectionId: 'seam-connection',
    modelId: 'seam-model',
    providerEgressConsent: true,
    remember: false,
    revision: 1,
    createdAt: '2026-11-02T00:00:00.000Z',
    updatedAt: '2026-11-02T00:00:00.000Z',
  };
}
function controllerFor(
  binding: ComputerUseNativeBinding,
  profile: ComputerAppProfileRecord,
  startPoint?: string,
) {
  const real = binding.addon!;
  const addon: ComputerUseNativeAddon = startPoint
    ? {
        ...real,
        startSession: (input) => {
          arm(startPoint);
          return real.startSession!(input);
        },
      }
    : real;
  const host = createComputerUseNativeHost({ ...binding, addon }, 'win32', {
    windowsPhysicalBoundsToDip: (value) => value,
  });
  const unused = (): never => {
    throw new Error('Unexpected persistence operation');
  };
  const persistence: ComputerUseControllerPersistence = {
    ...createComputerAppGrantFixtureStore().api,
    listComputerAppProfiles: () => [profile],
    getComputerAppProfile: () => profile,
    createComputerAppProfile: unused,
    updateComputerAppProfile: unused,
    removeComputerAppProfile: unused,
    recordComputerActionAudit: unused,
    completeComputerActionAudit: unused,
    recordComputerActionApprovalOutcome: unused,
    listComputerActionAudits: () => [],
    getActiveTurnId: () => null,
    getPermissionPolicy: () => ({ policyEpoch: 0 }),
  };
  const controller = new ComputerUseController({
    persistence,
    native: host,
    featureEnabled: () => true,
    agentDrivenEnabled: () => true,
    repositionEmergencyStop: () => true,
  });
  controllers.push(controller);
  return { host, controller };
}
// Session cases. V1 starts a session only on System32 classic Notepad or a signed acceptance
// fixture (identity.inc). Neither this PC nor the CI windows-2022 image makes classic Notepad
// full_access_app, and this slice has no signed fixture, so every case that needs a session is a
// counted NOT_RUN (classic_notepad_not_eligible) in every environment, CI included; the count and
// reasons are printed once as HUNG_HELPER_NOT_RUN_SUMMARY. The live fixing of these scenes and the
// close_session measurement move to N13b (real-machine acceptance) or to an environment with the
// signed acceptance fixture. What this job fixes live is the sessionless Stop paths (the fixture
// start and discovery cases above) and the close latency proxy. Of the session scenes, only the
// transport's deadline paths (cancel and close expiring, kill or retention) are fixed elsewhere,
// by the fake-timer "kill-stop (N3) replacement baseline" in computer-use-windows-transport.test.ts,
// and the post-receipt idle teardown that keeps an unconfirmed discovery by its fake transport
// cases. A real helper answering at once while a UiaCall or Capture worker is parked, an immediate
// pending-start Controller Stop, and the busy close distribution are not fixed anywhere yet.
// Where classic Notepad is eligible, these cases still run unchanged.
let notepadPid: number | undefined;
let notepadWindowId = '';
// What the seam owns of a Notepad it opened: the spawned process, and the unique scratch file it
// opened, whose name appears in the window title. On a PC where System32 notepad.exe hands off to
// the packaged Notepad, the replacement is another process the seam did not spawn and cannot own
// by pid; only a window whose title carries that unique name is the seam's.
let notepadChild: ChildProcess | undefined;
let notepadTitle: string | undefined;
function cleanupNote(detail: Record<string, unknown>) {
  console.log(`HUNG_HELPER_CLEANUP ${JSON.stringify(detail)}`);
}
// Never ends a process by pid set or image name: a Notepad the person opened during the case must
// keep its unsaved text. The spawned child is ended through its own handle; any other window is
// asked to close with WM_CLOSE (the fixture's --close-titled), which lets Notepad prompt rather
// than discard. Whatever stays open is reported on one line and does not fail the case.
async function closeSeamNotepads() {
  const child = notepadChild;
  const title = notepadTitle;
  notepadChild = undefined;
  notepadTitle = undefined;
  if (child !== undefined && child.exitCode === null && child.signalCode === null) {
    child.kill();
    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 5_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
      if (child.exitCode !== null || child.signalCode !== null) {
        clearTimeout(timer);
        resolve(true);
      }
    });
    if (!exited) cleanupNote({ reason: 'seam_notepad_child_not_exited', pid: child.pid });
  }
  if (title === undefined) return;
  try {
    const closed = await run(healthy, ['--close-titled', title], 10_000);
    if (closed.status !== 0) {
      cleanupNote({ reason: 'seam_notepad_window_query_failed', status: closed.status });
      return;
    }
    if (Number(closed.stdout.trim()) === 0) return;
    let remaining = Number.NaN;
    for (let attempt = 0; attempt < 25; attempt += 1) {
      await delay(200);
      const count = await run(healthy, ['--count-titled', title], 10_000);
      remaining = count.status === 0 ? Number(count.stdout.trim()) : Number.NaN;
      if (remaining === 0) return;
    }
    cleanupNote({ reason: 'seam_notepad_window_not_closed', title, remaining });
  } catch (error) {
    cleanupNote({ reason: 'seam_notepad_window_query_failed', error: errorCode(error) });
  }
}
async function classicProfile(context: TestContext) {
  const path = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'notepad.exe');
  const result = await run(healthy, ['--identity', path], 30_000);
  if (result.status !== 0) skipWith(context, 'classic_notepad_identity_unavailable');
  const identity = computerAppIdentitySchema.parse(JSON.parse(result.stdout) as unknown);
  if (identity.maximumMode !== 'full_access_app') skipWith(context, 'classic_notepad_not_eligible');
  if (!scratch) throw new Error('No scratch directory');
  // A unique, existing scratch file: Notepad opens it without a prompt and shows its name in the
  // title, which is how the seam recognises its own window after a hand-off.
  const title = `sc-hung-helper-seam-${randomUUID()}.txt`;
  const file = join(scratch, title);
  writeFileSync(file, '');
  notepadTitle = title;
  const notepad = spawn(path, [file], { windowsHide: false, stdio: 'ignore' });
  notepadChild = notepad;
  notepadPid = notepad.pid;
  await delay(500);
  if (notepad.exitCode !== null || notepadPid === undefined)
    skipWith(context, 'classic_notepad_redirected_or_exited');
  notepadWindowId = '';
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const window = await run(healthy, ['--window', String(notepadPid)], 5_000);
    if (window.status === 0) {
      notepadWindowId = window.stdout.trim();
      break;
    }
    await delay(100);
  }
  if (!notepadWindowId) skipWith(context, 'owned_classic_notepad_window_unavailable');
  return profileFor(identity);
}
async function prepare(context: TestContext, binary = hung, startPoint?: string) {
  const profile = await classicProfile(context);
  const { addon, binding } = addonFor(binary);
  const { controller, host } = controllerFor(binding, profile, startPoint);
  // Controller candidates carry a one-time token, never the HWND (beginWindowCandidates().commit()
  // replaces the native windowId with randomUUID()). Find the owned window by HWND in the Host's
  // native list, then pick the Controller candidate with the same window identity digest (derived
  // from the app identity, process start and HWND) and start with that candidate's token.
  // A missing or empty digest, or more than one matching candidate, is an implementation mix-up and
  // fails; only a window that is not listed at all (e.g. a Store hand-off) is a counted NOT_RUN.
  // In CI too this whole path is NOT_RUN (classic_notepad_not_eligible on windows-2022; any other
  // reason fails there); close_session is measured in N13b (real-machine acceptance) or where the
  // signed acceptance fixture is available. This job fixes the sessionless Stop paths and the proxy.
  let candidate: Awaited<ReturnType<typeof controller.listWindows>>[number] | undefined;
  for (let attempt = 0; attempt < 5 && candidate === undefined; attempt += 1) {
    const native = (await host.listWindows(profile)).find(
      (window) => window.windowId === notepadWindowId,
    );
    if (native !== undefined) {
      const digest: unknown = native.windowIdentityDigest;
      if (typeof digest !== 'string' || digest.length === 0)
        throw new Error('Native window for the owned HWND has no window identity digest');
      const matches = (await controller.listWindows(profile.id)).filter(
        (window) => window.windowIdentityDigest === digest,
      );
      if (matches.length > 1)
        throw new Error(`${matches.length} Controller candidates share the owned window digest`);
      candidate = matches[0];
    }
    if (candidate === undefined) await delay(200);
  }
  if (candidate === undefined)
    skipWith(context, 'classic_notepad_window_unavailable_or_store_redirect');
  const selected = candidate;
  const start = () =>
    controller.start({
      taskId: 'seam-task',
      profileId: profile.id,
      windowId: selected.windowId,
      mode: profile.mode,
      connectionId: profile.connectionId,
      modelId: profile.modelId,
      providerEgressConsent: true,
      providerEgressConsentBinding: {
        connectionId: profile.connectionId,
        modelId: profile.modelId,
      },
      remember: false,
      expectedPolicyEpoch: 0,
      expectedWindowRevision: selected.revision,
      expectedProfileRevision: 1,
    });
  return { profile, addon, host, controller, start };
}
// A window of the seam's own fixture process (`--fixture`), recorded as a spawn child.
async function startFixture() {
  const fixture = spawn(healthy, ['--fixture'], { windowsHide: false, stdio: 'pipe' });
  let output = '';
  fixture.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  await until(() => output.includes('\n'), 5_000, 'fixture window');
  return record(JSON.parse(output) as unknown);
}
// The synthetic identity is never accepted: WinVerifyTrust and CreateFileW both precede the
// identity/allow-list checks, so a start on the fixture reaches them without a session.
const syntheticIdentity = {
  canonicalPath: '',
  identityDigest: 'a'.repeat(64),
  executableDigest: 'b'.repeat(64),
  identity: { signerDigest: null },
};
function fixtureStart(window: Record<string, unknown>, sessionId: string) {
  const profile = { ...syntheticIdentity, canonicalPath: healthy, revision: 1 };
  return {
    profile,
    sessionId,
    pid: window['pid'],
    windowId: window['windowId'],
    cancelEpoch: 0,
    appIdentityDigest: profile.identityDigest,
    windowIdentityDigest: 'c'.repeat(64),
    expectedBoundsX: 0,
    expectedBoundsY: 0,
    expectedBoundsWidth: 640,
    expectedBoundsHeight: 480,
  };
}
// Load sizes. The helper rejects its pipe at 64 queued frames (ServePipe kMaximumQueuedFrames).
const busyLoadFrames = 16;
const busyQueuedFrames = busyLoadFrames + 2; // load + cancel + close
const proxyLoadFrames = 8;
const proxyQueuedFrames = proxyLoadFrames + 2; // load + start + stop_pending_start
const proxyIterations = 30;
const proxyAttemptLimit = proxyIterations * 2;
function percentiles(times: number[]) {
  const sorted = [...times].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50_ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95_ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    max_ms: sorted.at(-1),
  };
}
function report(name: string, origin: number, response: unknown, stopMs: number) {
  console.log(
    `HUNG_HELPER_STOP ${JSON.stringify({ case: name, stop_ms: stopMs, response: errorCode(response) ?? (typeof response === 'object' && response !== null ? Reflect.get(response, 'result') : null), children: children.filter((row) => row.temp).map((row) => ({ kill_ms: row.kills.map((at) => at - origin), exit_ms: row.exitAt === null ? null : row.exitAt - origin })) })}`,
  );
}

describe('hung helper seam static contracts (#1002)', () => {
  it('derives deadlines from the production constants and keeps the opt-in separate', () => {
    expect(stopBudget).toBe(21_000);
    expect(killBudget).toBe(41_000);
    expect(uiaWatchdog).toBe(470);
    expect(readFileSync(source, 'utf8')).toContain('#include "computer_use_windows_test_hang.h"');
    // The workflow isolation (one job, one env entry) is checked in workflow-security.test.ts.
    expect(proxyQueuedFrames).toBeLessThan(64);
    expect(busyQueuedFrames).toBeLessThan(64);
  }, 5_000);

  it('closes only Notepad the seam owns, never by pid set or image name', () => {
    const seam = readFileSync(
      join(__dirname, 'computer-use-windows-hung-helper-live-seam.test.ts'),
      'utf8',
    );
    const start = seam.indexOf('async function closeSeamNotepads(');
    const end = seam.indexOf('\nasync function classicProfile(', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const cleanup = seam.slice(start, end);
    // The spawned child is ended through its own handle; anything else only by WM_CLOSE on a
    // window titled with the seam's unique scratch file name.
    expect(cleanup).toContain('child.kill()');
    expect(cleanup).toContain("['--close-titled', title]");
    expect(cleanup).not.toMatch(/taskkill|tasklist|process\.kill\(|\/F\b|IMAGENAME/u);
    // No before/after pid difference anywhere in the seam decides what to end.
    expect(seam).not.toContain(['notepad', 'Baseline'].join(''));
    expect(seam).not.toContain(['IMAGENAME eq', 'notepad'].join(' '));
    const fixture = readFileSync(source, 'utf8');
    const mode = fixture.slice(
      fixture.indexOf('L"--close-titled"'),
      fixture.indexOf('L"--identity"'),
    );
    expect(mode).toContain('PostMessageW(window, WM_CLOSE, 0, 0)');
    expect(mode).toContain('L"\\\\notepad.exe"');
    expect(mode).not.toMatch(/TerminateProcess|taskkill/u);
  }, 5_000);
});

describe('real hung helper / transport / Host / Controller (#1002)', () => {
  for (const point of ['WinVerifyTrust', 'CreateFileW']) {
    it(
      `cancels a fixture start hung in ${point} before the V1 allow-list`,
      async (context) => {
        live(context);
        observeChildren();
        arm('');
        const window = await startFixture();
        const { addon } = addonFor(hung);
        arm(point);
        const starting = settle(addon.startSession!(fixtureStart(window, 'fixture-start')));
        await awaitHang(starting, operationTimeoutMilliseconds('start_session') * 2 + margin);
        const origin = performance.now();
        const stopped = await addon.stopPendingStart!({ sessionId: 'fixture-start' });
        const elapsed = performance.now() - origin;
        expect(stopped).toMatchObject({ result: 'closed', drained: true });
        expect(elapsed).toBeLessThan(COMPUTER_USE_NATIVE_CLOSE_DRAIN_TIMEOUT_MS);
        expect(errorCode(await starting)).toBe('session_start_canceled');
        await until(
          () => children.filter((row) => row.temp).every((row) => row.exited),
          margin,
          'idle helper exit',
        );
        report(context.task.name, origin, stopped, elapsed);
      },
      caseTimeout,
    );
  }
  for (const point of ['WinVerifyTrust', 'CreateFileW']) {
    it(
      `cancels a pending Controller start in ${point}`,
      async (context) => {
        live(context);
        observeChildren();
        arm('');
        const target = await prepare(context, hung, point);
        const statuses: Array<{ state: string; stopReason: string | null }> = [];
        target.controller.subscribe((status) => statuses.push(status));
        const starting = settle(target.start());
        await awaitHang(starting, operationTimeoutMilliseconds('start_session') * 2 + margin);
        const origin = performance.now();
        await target.controller.stopForTask('seam-task', 'task_changed');
        const elapsed = performance.now() - origin;
        // Confirms at once today; a missed ack deadline would add at least cancelBudget.
        expect(elapsed).toBeLessThan(cancelBudget);
        expect(await starting).toBeInstanceOf(Error);
        expect(statuses.at(-1)).toMatchObject({ state: 'stopped', stopReason: 'task_changed' });
        await until(
          () => children.filter((row) => row.temp).every((row) => row.exited),
          margin,
          'pending-start helper exit',
        );
        report(`controller-start-${point}`, origin, { result: 'stopped' }, elapsed);
      },
      caseTimeout,
    );
  }
  it(
    'retains a helper with unconfirmed discovery hung in CreateFileW',
    async (context) => {
      live(context);
      observeChildren();
      arm('CreateFileW');
      const { addon } = addonFor(hung);
      const discovery = settle(
        addon.discoverWindows!({
          discoveryId: 'hung-discovery',
          canonicalPath: healthy,
          identityDigest: 'a'.repeat(64),
          executableDigest: 'b'.repeat(64),
          identity: { signerDigest: null },
        }),
      );
      await awaitHang(discovery, operationTimeoutMilliseconds('list_windows_cancellable') + margin);
      const origin = performance.now();
      expect(await discovery).toBeInstanceOf(Error);
      await delay(Math.max(0, killBudget + margin - (performance.now() - origin)));
      expect(children.filter((row) => row.temp)).toHaveLength(1);
      expect(children.find((row) => row.temp)?.kills).toEqual([]);
      // This read-only worker cannot claim a launch after Stop. Native can return a drained
      // receipt even though the worker remains hung; discovery Stop itself never arms teardown.
      const stopOrigin = performance.now();
      const stop = await addon.stopWindowDiscovery!({ discoveryId: 'hung-discovery' });
      const elapsed = performance.now() - stopOrigin;
      expect(stop).toMatchObject({ result: 'stopped', drained: true });
      expect(elapsed).toBeLessThan(COMPUTER_USE_NATIVE_CLOSE_DRAIN_TIMEOUT_MS);
      expect(children.find((row) => row.temp)?.kills).toEqual([]);
      report('discovery-CreateFileW', stopOrigin, stop, elapsed);
    },
    caseTimeout,
  );

  it(
    'stops sessionless Controller discovery while its CreateFileW worker remains hung',
    async (context) => {
      live(context);
      observeChildren();
      arm('');
      const identity = await run(healthy, ['--identity', healthy], 30_000);
      expect(identity.status).toBe(0);
      const profile = profileFor(
        computerAppIdentitySchema.parse(JSON.parse(identity.stdout) as unknown),
      );
      const { binding } = addonFor(hung);
      const { controller } = controllerFor(binding, profile);
      arm('CreateFileW');
      const discovering = settle(controller.beginWindowCandidates(profile.id, 'seam-task').result);
      await awaitHang(
        discovering,
        operationTimeoutMilliseconds('list_windows_cancellable') + margin,
      );
      const origin = performance.now();
      await controller.stopForTask('seam-task', 'task_changed');
      const elapsed = performance.now() - origin;
      expect(await discovering).toBeInstanceOf(Error);
      // Confirms at once today; a missed ack deadline would add at least cancelBudget.
      expect(elapsed).toBeLessThan(cancelBudget);
      expect(children.filter((row) => row.temp)).toHaveLength(1);
      expect(children.find((row) => row.temp)?.kills).toEqual([]);
      report('controller-discovery-CreateFileW', origin, { result: 'stopped' }, elapsed);
    },
    caseTimeout,
  );

  for (const point of ['UiaCall', 'Capture']) {
    it(
      `stops observation hung in ${point} through the worker cancellation path`,
      async (context) => {
        live(context);
        observeChildren();
        arm('');
        const target = await prepare(context);
        const session = await target.start();
        arm(point);
        const observationOrigin = performance.now();
        const observation = settle(
          target.addon.observe!({
            sessionId: session.sessionId,
            requestId: 'hung-observe',
            cancelEpoch: 0,
          }),
        );
        await until(entered, operationTimeoutMilliseconds('observe') - margin, 'observation hang');
        if (point === 'UiaCall') {
          const result = await observation;
          expect(errorCode(result)).toBe('accessibility_timeout');
          expect(performance.now() - observationOrigin).toBeGreaterThanOrEqual(uiaWatchdog);
          expect(performance.now() - observationOrigin).toBeLessThan(uiaWatchdog + margin);
        }
        const origin = performance.now();
        await target.controller.stopForTask('seam-task', 'task_changed');
        const elapsed = performance.now() - origin;
        // Stop is cancel (ack deadline cancelBudget) then close. The worker cancellation path
        // acknowledges at once, so the whole Stop stays under the cancel ack deadline; an expired
        // cancel ack alone would already reach cancelBudget.
        expect(elapsed).toBeLessThan(cancelBudget);
        expect(target.controller.getStatus(session.sessionId)).toMatchObject({
          state: 'stopped',
          stopReason: 'task_changed',
        });
        const result = await observation;
        expect(result).toBeInstanceOf(Error);
        await until(
          () => children.filter((row) => row.temp).every((row) => row.exited),
          margin,
          'closed helper exit',
        );
        report(point, origin, result, elapsed);
      },
      caseTimeout,
    );
  }
  it(
    'retains claimed semantic input after Controller native_unavailable',
    async (context) => {
      live(context);
      observeChildren();
      arm('');
      const target = await prepare(context);
      const session = await target.start();
      const observation = record(
        await target.addon.observe!({
          sessionId: session.sessionId,
          requestId: 'semantic-observe',
          cancelEpoch: 0,
        }),
      );
      const nodes: Record<string, unknown>[] = [];
      const visit = (value: unknown) => {
        if (Array.isArray(value)) {
          value.forEach(visit);
          return;
        }
        const node = record(value);
        nodes.push(node);
        if (Array.isArray(node['children'])) node['children'].forEach(visit);
      };
      visit(JSON.parse(String(observation['tree'])) as unknown);
      const edit = nodes.find((node) => node['role'] === 'UIATextField');
      expect(edit, 'classic Notepad edit control').toBeDefined();
      const targetId = edit?.['identifier'] || edit?.['title'];
      expect(typeof targetId).toBe('string');
      const action = {
        sessionId: session.sessionId,
        requestId: 'hung-semantic',
        cancelEpoch: 0,
        observationRevision: observation['revision'],
        type: 'set_text',
        targetId,
        text: 'synthetic seam value',
      };
      const request = {
        ...action,
        actionDigest: createHash('sha256').update(JSON.stringify(action)).digest('hex'),
      };
      const preflight = record(await target.addon.preflight!(request));
      expect(preflight['decision']).toBe('ordinary');
      expect(typeof preflight['ticket']).toBe('string');
      arm('SemanticPattern');
      const dispatch = settle(target.addon.dispatch!({ ...request, ticket: preflight['ticket'] }));
      await awaitHang(dispatch, operationTimeoutMilliseconds('dispatch') - margin);
      const origin = performance.now();
      await target.controller.stopForTask('seam-task', 'task_changed');
      const elapsed = performance.now() - origin;
      expect(errorCode(await dispatch)).toBe('semantic_input_in_flight');
      expect(elapsed).toBeGreaterThanOrEqual(stopBudget - margin);
      expect(elapsed).toBeLessThan(stopBudget + margin);
      expect(target.controller.getStatus(session.sessionId)).toMatchObject({
        state: 'stopped',
        stopReason: 'native_unavailable',
      });
      expect(target.host.availability()).toMatchObject({ reasonCode: 'native_stop_unconfirmed' });
      await delay(Math.max(0, killBudget + margin - (performance.now() - origin)));
      expect(children.filter((row) => row.temp).every((row) => row.kills.length === 0)).toBe(true);
      report('SemanticPattern', origin, { result: 'native_unavailable' }, elapsed);
    },
    caseTimeout,
  );

  it(
    'keeps a closed session helper while a hung discovery is unconfirmed, then idle-tears it down',
    async (context) => {
      live(context);
      observeChildren();
      arm('');
      const target = await prepare(context);
      const session = await target.start();
      arm('CreateFileW');
      const discovery = settle(
        target.addon.discoverWindows!({
          discoveryId: 'idle-discovery',
          ...syntheticIdentity,
          canonicalPath: healthy,
        }),
      );
      await awaitHang(discovery, operationTimeoutMilliseconds('list_windows_cancellable') + margin);
      // The close receipt arms idle teardown (shutdownWhenIdle); shutdownIfIdle must still keep
      // the helper while the sent discovery is unconfirmed.
      const origin = performance.now();
      await target.controller.stopForTask('seam-task', 'task_changed');
      expect(target.controller.getStatus(session.sessionId)).toMatchObject({
        state: 'stopped',
        stopReason: 'task_changed',
      });
      await delay(Math.max(0, killBudget + margin - (performance.now() - origin)));
      const helper = children.find((row) => row.temp);
      expect(helper?.kills).toEqual([]);
      expect(helper?.exited).toBe(false);
      const stop = await target.addon.stopWindowDiscovery!({ discoveryId: 'idle-discovery' });
      expect(stop).toMatchObject({ result: 'stopped' });
      await until(() => helper?.exited === true, margin, 'idle teardown after discovery Stop');
      report('idle-teardown-discovery-CreateFileW', origin, stop, performance.now() - origin);
    },
    caseTimeout,
  );

  it(`measures healthy close behind ${busyLoadFrames} queued observations (below 64 frames)`, async (context) => {
    live(context);
    observeChildren();
    arm('');
    const profile = await classicProfile(context);
    const times: number[] = [];
    const unansweredAtSend: number[] = [];
    for (let index = 0; index < 30; index += 1) {
      const { addon, binding } = addonFor(healthy);
      const host = createComputerUseNativeHost(binding, 'win32', {
        windowsPhysicalBoundsToDip: (value) => value,
      });
      const windows = await host.listWindows(profile);
      const selected = windows.find((window) => window.windowId === notepadWindowId);
      expect(selected, 'owned classic Notepad window').toBeDefined();
      const session = await host.startSession({
        profile,
        windowId: selected!.windowId,
        sessionId: `busy-session-${index}`,
        taskId: 'seam-task',
        turnId: 'seam-turn',
        cancelEpoch: 0,
      });
      const baseline = await addon.observe!({
        sessionId: session.sessionId,
        requestId: `healthy-${index}`,
        cancelEpoch: 0,
      });
      expect(baseline).toMatchObject({ result: 'completed' });
      let answered = 0;
      const load = Array.from({ length: busyLoadFrames }, (_, queued) =>
        settle(
          addon.observe!({
            sessionId: session.sessionId,
            requestId: `busy-${index}-${queued}`,
            cancelEpoch: 0,
          }),
        ).finally(() => {
          answered += 1;
        }),
      );
      await delay(0);
      // An observation not yet answered when close is sent was being served or queued.
      const unanswered = busyLoadFrames - answered;
      expect(unanswered, 'close is sent while the helper holds observation work').toBeGreaterThan(
        0,
      );
      const origin = performance.now();
      await host.close(session);
      times.push(performance.now() - origin);
      unansweredAtSend.push(unanswered);
      await Promise.all(load);
      await until(
        () => children.filter((row) => row.temp).every((row) => row.exited),
        margin,
        'busy helper exit',
      );
    }
    const summary = {
      ...percentiles(times),
      load_frames: busyLoadFrames,
      min_unanswered_at_send: Math.min(...unansweredAtSend),
    };
    console.log(`HUNG_HELPER_CLOSE_LATENCY ${JSON.stringify(summary)}`);
    expect(summary.max_ms).toBeLessThan(COMPUTER_USE_NATIVE_CLOSE_DRAIN_TIMEOUT_MS);
  }, 600_000);

  // A stand-in for the busy close above while no session can be started (HUNG_HELPER_CLOSE_LATENCY
  // stays NOT_RUN); it is not close_session, only a reference value until close_session is measured
  // in N13b (real-machine acceptance). stop_pending_start is answered in FIFO order by the single
  // serve loop, as close_session is, so its round trip behind queued work shows the queue cost a
  // close would pay. It does not include the cancel step or a session's own teardown, and it is not
  // a basis for choosing N3's close deadline C.
  // Each round: a fresh healthy helper is connected, proxyLoadFrames sessionless discoveries and a
  // fixture start are issued in that order, and stop_pending_start for that start is sent before
  // any reply can be read. Between issuing and Stop only promise jobs run (no timer, no I/O
  // callback), so the connected client writes the load and the start ahead of Stop while no reply
  // is processed: every load frame is unanswered when Stop is written and is served before it. A
  // round with no unanswered load at send, or whose start never reached the helper, is not counted
  // and is retried, up to proxyAttemptLimit rounds; the uncounted rounds are reported.
  it(`measures a sessionless Stop round trip behind ${proxyLoadFrames} queued discoveries as a close latency proxy`, async (context) => {
    live(context);
    observeChildren();
    arm('');
    const window = await startFixture();
    const query = { ...syntheticIdentity, canonicalPath: healthy };
    const times: number[] = [];
    const unansweredAtSend: number[] = [];
    const uncounted = { no_load_at_send: 0, start_not_sent: 0 };
    let attempts = 0;
    while (times.length < proxyIterations && attempts < proxyAttemptLimit) {
      attempts += 1;
      // A fresh addon (transport client) per round, so no round inherits another's state.
      const { addon } = addonFor(healthy);
      // Connect first, so every frame below is written by the connected client without I/O.
      await settle(addon.discoverWindows!({ discoveryId: `proxy-warm-${attempts}`, ...query }));
      let answered = 0;
      const load = Array.from({ length: proxyLoadFrames }, (_, queued) =>
        settle(
          addon.discoverWindows!({ discoveryId: `proxy-load-${attempts}-${queued}`, ...query }),
        ).finally(() => {
          answered += 1;
        }),
      );
      const sessionId = `proxy-start-${attempts}`;
      const starting = settle(addon.startSession!(fixtureStart(window, sessionId)));
      // Promise jobs only: lets the start pass ensureConnected and be written, reads no reply.
      for (let turn = 0; turn < 200; turn += 1) await Promise.resolve();
      // A discovery not yet answered when Stop is sent is queued ahead of it in the helper.
      const unanswered = proxyLoadFrames - answered;
      const origin = performance.now();
      const stopped = await settle(addon.stopPendingStart!({ sessionId }));
      const elapsed = performance.now() - origin;
      await Promise.all(load);
      const started = await starting;
      expect(started).toBeInstanceOf(Error);
      if (errorCode(started) === 'Computer Use start canceled before send') {
        uncounted.start_not_sent += 1;
      } else if (unanswered === 0) {
        uncounted.no_load_at_send += 1;
      } else {
        expect(stopped).toMatchObject({ result: 'closed' });
        times.push(elapsed);
        unansweredAtSend.push(unanswered);
      }
      // Cleanup, outside the measured time. A helper that served discoveries is not torn down when
      // idle (discoverWindows clears idleShutdownPending; stopWindowDiscovery never arms teardown),
      // and the addon exposes no shutdown, so the seam ends this round's helper itself and waits
      // for its exit and its transport scratch removal before the next round.
      for (const row of children) if (row.temp && !row.exited) row.child.kill();
      await until(
        () => children.filter((row) => row.temp).every((row) => row.exited),
        COMPUTER_USE_NATIVE_CLOSE_DRAIN_TIMEOUT_MS,
        'proxy helper exit',
      );
      await until(
        () => children.every((row) => !row.temp || !existsSync(row.temp)),
        COMPUTER_USE_NATIVE_CLOSE_DRAIN_TIMEOUT_MS,
        'proxy transport scratch removed',
      );
    }
    const summary = {
      proxy_for: 'close_session',
      reference_until: 'close_session measured in N13b',
      operation: 'stop_pending_start',
      ...percentiles(times),
      load_frames: proxyLoadFrames,
      queued_frames: proxyQueuedFrames,
      min_unanswered_at_send: unansweredAtSend.length > 0 ? Math.min(...unansweredAtSend) : null,
      attempts,
      uncounted,
    };
    console.log(`HUNG_HELPER_STOP_LATENCY_PROXY ${JSON.stringify(summary)}`);
    expect(times, 'loaded rounds measured within the attempt limit').toHaveLength(proxyIterations);
    expect(summary.min_unanswered_at_send).toBeGreaterThan(0);
    expect(summary.max_ms).toBeLessThan(COMPUTER_USE_NATIVE_CLOSE_DRAIN_TIMEOUT_MS);
  }, 600_000);
});
