import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type * as NodeChildProcess from 'node:child_process';
import { createHash } from 'node:crypto';
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
function skipWith(context: TestContext, reason: string): never {
  notRun.push({ case: context.task.name, reason });
  console.log(`HUNG_HELPER_NOT_RUN ${JSON.stringify({ case: context.task.name, reason })}`);
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
  // The product attests every spawned helper with Windows PowerShell under a fixed 10 s deadline
  // (attestSpawnedWindowsComputerUseHelper). A runner's first PowerShell start, with its module and
  // Authenticode load, can exceed that alone, so pay it once here with the same executable and
  // module. The product deadline is unchanged: a later attestation that still times out fails.
  const warmStart = performance.now();
  const warm = spawnSync(
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Import-Module "$PSHOME\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1"; $null = Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath '${healthy}'; exit 0`,
    ],
    { windowsHide: true, stdio: 'ignore', timeout: 120_000 },
  );
  console.log(
    `HUNG_HELPER_POWERSHELL_WARMUP ${JSON.stringify({ status: warm.status, ms: Math.round(performance.now() - warmStart) })}`,
  );
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
// reasons are printed once as HUNG_HELPER_NOT_RUN_SUMMARY. Their Stop timing is fixed by the
// fake-timer "kill-stop (N3) replacement baseline" in computer-use-windows-transport.test.ts. The
// live fixing of these scenes moves to N13b (real-machine acceptance) or to an environment with
// the signed acceptance fixture. Where classic Notepad is eligible, they still run unchanged.
let notepadPid: number | undefined;
let notepadWindowId = '';
// Notepad processes that existed before the seam started one. On a PC where System32 notepad.exe
// hands off to the packaged Notepad, the replacement is not a spawn child; whatever appeared after
// this baseline was started by the seam and is closed after the case.
let notepadBaseline: Set<number> | null = null;
let redirectedNotepad = false;
function notepadProcessIds(): Set<number> {
  const result = spawnSync(
    'tasklist.exe',
    ['/FI', 'IMAGENAME eq notepad.exe', '/FO', 'CSV', '/NH'],
    { encoding: 'utf8', windowsHide: true, timeout: 10_000 },
  );
  const ids = new Set<number>();
  for (const line of (result.stdout ?? '').split(/\r?\n/u)) {
    const match = /^"[^"]*","(\d+)"/u.exec(line);
    if (match?.[1]) ids.add(Number(match[1]));
  }
  return ids;
}
function closeSeamNotepads() {
  if (notepadBaseline === null) return;
  const baseline = notepadBaseline;
  notepadBaseline = null;
  const started = [...notepadProcessIds()].filter((pid) => !baseline.has(pid));
  for (const pid of started) {
    const killed = spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 10_000,
    });
    if (killed.status !== 0 && notepadProcessIds().has(pid))
      console.log(
        `HUNG_HELPER_CLEANUP ${JSON.stringify({ reason: 'seam_notepad_not_closed', pid })}`,
      );
  }
  if (redirectedNotepad && started.length === 0)
    // A packaged Notepad that was already running opens the hand-off as a tab of that process;
    // closing it would close the person's own Notepad, so only report it.
    console.log(
      `HUNG_HELPER_CLEANUP ${JSON.stringify({ reason: 'redirected_notepad_window_not_identified' })}`,
    );
  redirectedNotepad = false;
}
async function classicProfile(context: TestContext) {
  const path = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'notepad.exe');
  const result = await run(healthy, ['--identity', path], 30_000);
  if (result.status !== 0) skipWith(context, 'classic_notepad_identity_unavailable');
  const identity = computerAppIdentitySchema.parse(JSON.parse(result.stdout) as unknown);
  if (identity.maximumMode !== 'full_access_app') skipWith(context, 'classic_notepad_not_eligible');
  notepadBaseline = notepadProcessIds();
  const notepad = spawn(path, [], { windowsHide: false, stdio: 'ignore' });
  notepadPid = notepad.pid;
  await delay(500);
  if (notepad.exitCode !== null || notepadPid === undefined) {
    redirectedNotepad = true;
    skipWith(context, 'classic_notepad_redirected_or_exited');
  }
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
  let candidate: Awaited<ReturnType<typeof controller.listWindows>>[number] | undefined;
  for (let attempt = 0; attempt < 5 && candidate === undefined; attempt += 1) {
    const native = (await host.listWindows(profile)).find(
      (window) => window.windowId === notepadWindowId,
    );
    if (native !== undefined)
      candidate = (await controller.listWindows(profile.id)).find(
        (window) => window.windowIdentityDigest === native.windowIdentityDigest,
      );
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
  // stays NOT_RUN); it is not close_session. stop_pending_start is answered in FIFO order by the
  // single serve loop, as close_session is, so its round trip behind queued work is a guide to the
  // queue cost a close pays. It does not include the cancel step or a session's own teardown.
  // Each round: a fresh healthy helper is connected, proxyLoadFrames sessionless discoveries and a
  // fixture start are written in that order, then stop_pending_start for that start is sent.
  it(`measures a sessionless Stop round trip behind ${proxyLoadFrames} queued discoveries as a close latency proxy`, async (context) => {
    live(context);
    observeChildren();
    arm('');
    const window = await startFixture();
    const query = { ...syntheticIdentity, canonicalPath: healthy };
    const times: number[] = [];
    const unansweredAtSend: number[] = [];
    for (let index = 0; index < proxyIterations; index += 1) {
      // A fresh addon (transport client) per round, so no round inherits another's state.
      const { addon } = addonFor(healthy);
      // Connect first, so every frame below is written in call order within one macrotask.
      await settle(addon.discoverWindows!({ discoveryId: `proxy-warm-${index}`, ...query }));
      let answered = 0;
      const load = Array.from({ length: proxyLoadFrames }, (_, queued) =>
        settle(
          addon.discoverWindows!({ discoveryId: `proxy-load-${index}-${queued}`, ...query }),
        ).finally(() => {
          answered += 1;
        }),
      );
      const sessionId = `proxy-start-${index}`;
      const starting = settle(addon.startSession!(fixtureStart(window, sessionId)));
      await delay(0);
      // A discovery not yet answered when Stop is sent was being served or queued by the helper.
      const unanswered = proxyLoadFrames - answered;
      expect(unanswered, 'Stop is sent while the helper holds discovery work').toBeGreaterThan(0);
      const origin = performance.now();
      const stopped = await addon.stopPendingStart!({ sessionId });
      times.push(performance.now() - origin);
      unansweredAtSend.push(unanswered);
      expect(stopped).toMatchObject({ result: 'closed' });
      await Promise.all(load);
      const started = await starting;
      expect(started).toBeInstanceOf(Error);
      expect(errorCode(started), 'the start reached the helper before Stop').not.toBe(
        'Computer Use start canceled before send',
      );
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
      operation: 'stop_pending_start',
      ...percentiles(times),
      load_frames: proxyLoadFrames,
      queued_frames: proxyQueuedFrames,
      min_unanswered_at_send: Math.min(...unansweredAtSend),
    };
    console.log(`HUNG_HELPER_STOP_LATENCY_PROXY ${JSON.stringify(summary)}`);
    expect(summary.max_ms).toBeLessThan(COMPUTER_USE_NATIVE_CLOSE_DRAIN_TIMEOUT_MS);
  }, 600_000);
});
