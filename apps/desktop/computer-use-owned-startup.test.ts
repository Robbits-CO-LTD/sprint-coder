import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const root = resolve(__dirname, '../..');
const directories: string[] = [];
type Capture = {
  completed: Promise<unknown>;
  closed: Promise<void>;
  stopOwnedChild(): void;
  abandon(): void;
};
let collector: { startOwnedComputerUseCapture(input: unknown): Capture };
let startup: {
  collectOwnedComputerUseStartup(
    input: unknown,
    start?: ((input: Record<string, unknown>) => Capture) | undefined,
    load?: unknown,
  ): Promise<Record<string, unknown>>;
  parseOwnedStartupArguments(args: string[], platform?: string): Record<string, string>;
};
let receipt: {
  startPinnedOwnedComputerUseProcessCapture(input: unknown, load?: unknown): Capture;
};
const isWindows = process.platform === 'win32';
const reportKeys = [
  'schemaVersion',
  'evidenceKind',
  'finalGateEligible',
  'sourceCommit',
  'platform',
  'packageSha256',
  'executableSha256',
  'runIdDigest',
  'eventChainDigest',
  'startupProcessIdentityDigest',
  'transportCompleted',
  'sessionCount',
  'frameCount',
].sort();
const failure = 'COMPUTER_USE_OWNED_STARTUP_CHECKPOINT_FAILED';
beforeAll(async () => {
  collector = await import(pathToFileURL(resolve(root, 'collect-computer-use-runtime.mjs')).href);
  startup = await import(
    pathToFileURL(resolve(root, 'collect-computer-use-owned-startup.mjs')).href
  );
  receipt = await import(
    pathToFileURL(resolve(root, 'computer-use-owned-process-receipt.mjs')).href
  );
});
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture(kind = 'valid') {
  const directory = mkdtempSync(resolve(tmpdir(), 'owned-startup-fixture-'));
  directories.push(directory);
  const child = resolve(directory, 'child.mjs');
  // Harmless synthetic Node child; never launches Electron, a Provider, native code, or OS probes.
  writeFileSync(
    child,
    `import {writeSync,readdirSync} from 'node:fs';
import {createCaptureEncoder} from ${JSON.stringify(pathToFileURL(resolve(root, 'computer-use-capture-wire.mjs')).href)};
if(process.env.SPRINT_CODER_COMPUTER_USE_DESKTOP_V1!=='0'||process.env.SPRINT_CODER_E2E_HIDDEN!=='0'||process.env.SPRINT_CODER_E2E_BACKGROUND!=='0'||process.env.PRIVATE_FIXTURE_CREDENTIAL!==undefined||readdirSync(process.env.SPRINT_CODER_USER_DATA_DIR).length!==0) process.exit(9);
const encode=createCaptureEncoder(process.env.SPRINT_CODER_COMPUTER_USE_CAPTURE_NONCE);
writeSync(1,'PRIVATE_FIXTURE_CONTENT');writeSync(2,'PRIVATE_FIXTURE_CONTENT');
writeSync(3,encode('hello',{pid:process.pid,parentPid:process.ppid,platform:process.platform,sourceCommit:'${kind === 'source-mismatch' ? 'c' : 'b'}'.repeat(40),nativeManifestDigest:'0'.repeat(64),packaged:true,packageReady:false}));
${kind === 'timeout' ? 'setInterval(()=>{},1000);' : kind === 'missing-end' ? '' : "writeSync(3,encode('end',{valid:true}));"}
${kind === 'nonzero-exit' ? 'process.exit(7);' : ''}
`,
  );
  const input = {
    executable: process.execPath,
    expectedSourceCommit: 'b'.repeat(40),
    expectedExecutableSha256: createHash('sha256')
      .update(readFileSync(process.execPath))
      .digest('hex'),
    packageSha256: 'a'.repeat(64),
    outputPath: resolve(directory, 'checkpoint.json'),
    timeoutMs: kind === 'timeout' ? 100 : 5_000,
  };
  // Text-only fake addon: only `load` is injected; the real pinned retainer verifies path/hash.
  const addonPath = resolve(directory, 'fixture.node');
  writeFileSync(addonPath, 'controlled-startup-fixture-not-native');
  const addonSha256 = createHash('sha256').update(readFileSync(addonPath)).digest('hex');
  const loads = vi.fn();
  const load = (path: string) => {
    loads(path);
    return {
      retainOwnedProcessIdentity: (pid: number) => ({
        close: () => {},
        isRunning: () => true,
        verifyUnchanged: () => true,
        snapshot: () => ({
          pid,
          parentPid: process.pid,
          startIdentity: 'win32:12346',
          imagePath: process.execPath,
        }),
      }),
    };
  };
  const captures: Capture[] = [];
  const profiles: string[] = [];
  const launches: Record<string, unknown>[] = [];
  const start = (launch: Record<string, unknown>) => {
    launches.push(launch);
    const environment = launch['environment'] as Record<string, string>;
    const profile = environment['SPRINT_CODER_USER_DATA_DIR']!;
    profiles.push(profile);
    expect(readdirSync(profile)).toEqual([]);
    const capturePart = {
      ...launch,
      args: [child],
      environment: { ...environment, PRIVATE_FIXTURE_CREDENTIAL: 'synthetic-only' },
    };
    const capture = isWindows
      ? receipt.startPinnedOwnedComputerUseProcessCapture(
          { capture: capturePart, addonPath, addonSha256 },
          load,
        )
      : collector.startOwnedComputerUseCapture(capturePart);
    captures.push(capture);
    return capture;
  };
  if (isWindows) Object.assign(input, { addonPath, addonSha256 });
  return { input, start, captures, profiles, launches, loads, load, addonPath, addonSha256 };
}

function profileDirectories(outputPath: string) {
  return readdirSync(resolve(outputPath, '..')).filter((name) =>
    name.startsWith('owned-startup-profile-'),
  );
}

function fakeCapture(overrides: Record<string, unknown> = {}, platform = process.platform) {
  const counters = { starts: 0, stops: 0, abandons: 0 };
  const start = () => {
    counters.starts += 1;
    return {
      completed: Promise.resolve({
        hello: { packaged: true, sourceCommit: 'b'.repeat(40), platform },
        executableSha256: createHash('sha256').update(readFileSync(process.execPath)).digest('hex'),
        sessions: [],
        runIdDigest: 'a'.repeat(64),
        eventChainDigest: 'c'.repeat(64),
        frameCount: 2,
        processIdentityDigest: 'd'.repeat(64),
        ...overrides,
      }),
      closed: Promise.resolve(),
      stopOwnedChild: () => {
        counters.stops += 1;
      },
      abandon: () => {
        counters.abandons += 1;
      },
    };
  };
  return { start, counters };
}

async function withPlatform<T>(platform: string, run: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...original, value: platform });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

describe('protected owned startup caller', () => {
  it('uses real owned fixture pipe with fresh profile, stripped credentials and bounded non-authoritative output', async () => {
    const { input, start, captures, profiles } = fixture();
    const result = await startup.collectOwnedComputerUseStartup(input, start);
    await Promise.all(captures.map((capture) => capture.closed));
    expect(result).toMatchObject({
      evidenceKind: 'owned-startup-shutdown-checkpoint',
      finalGateEligible: false,
      transportCompleted: true,
      sessionCount: 0,
      frameCount: 2,
      schemaVersion: 2,
    });
    const bytes = readFileSync(input.outputPath, 'utf8');
    expect(Buffer.byteLength(bytes)).toBeLessThanOrEqual(4096);
    expect(Object.keys(result).sort()).toEqual(reportKeys);
    expect(Object.keys(JSON.parse(bytes)).sort()).toEqual(reportKeys);
    if (isWindows) expect(result['startupProcessIdentityDigest']).toMatch(/^[a-f0-9]{64}$/u);
    else expect(result['startupProcessIdentityDigest']).toBeNull();
    for (const value of [
      'PRIVATE_FIXTURE_CONTENT',
      'pid',
      'parentPid',
      'frames',
      'profile',
      'nonce',
      'startIdentity',
      'imagePath',
      'win32:12346',
      process.execPath,
      process.execPath.replaceAll('\\', '\\\\'),
      'fixture.node',
    ])
      expect(bytes).not.toContain(value);
    expect(profiles).toHaveLength(1);
    expect(() => readdirSync(profiles[0]!)).toThrow();
  });

  it.each(['source-mismatch', 'missing-end', 'nonzero-exit', 'timeout'])(
    'fails %s without writing an artifact or accepting forced root stop',
    async (kind) => {
      const { input, start, captures } = fixture(kind);
      try {
        await expect(startup.collectOwnedComputerUseStartup(input, start)).rejects.toThrow(
          'COMPUTER_USE_OWNED_STARTUP_CHECKPOINT_FAILED',
        );
        expect(() => readFileSync(input.outputPath)).toThrow();
        expect(
          readdirSync(resolve(input.outputPath, '..')).some((name) =>
            name.startsWith('owned-startup-profile-'),
          ),
        ).toBe(true);
      } finally {
        for (const capture of captures) capture.stopOwnedChild();
        await Promise.all(captures.map((capture) => capture.closed));
      }
    },
  );

  it('rejects executable mismatch before launching and rejects caller output overwrite', async () => {
    const { input, start, captures, profiles } = fixture();
    await expect(
      startup.collectOwnedComputerUseStartup(
        { ...input, expectedExecutableSha256: 'f'.repeat(64) },
        start,
      ),
    ).rejects.toThrow('COMPUTER_USE_OWNED_STARTUP_CHECKPOINT_FAILED');
    expect(captures).toHaveLength(0);
    writeFileSync(input.outputPath, 'preserved');
    await expect(startup.collectOwnedComputerUseStartup(input, start)).rejects.toThrow(
      'COMPUTER_USE_OWNED_STARTUP_CHECKPOINT_FAILED',
    );
    expect(readFileSync(input.outputPath, 'utf8')).toBe('preserved');
    expect(profiles).toHaveLength(1);
    expect(() => readdirSync(profiles[0]!)).not.toThrow();
  });

  it('connects only opt-in protected workflow callers and uploads the exact bounded report', () => {
    const workflow = readFileSync(
      resolve(root, '.github/workflows/computer-use-final-gate.yml'),
      'utf8',
    );
    expect(workflow).toContain('collect_owned_startup:');
    expect(workflow).toContain('inputs.collect_owned_startup');
    expect(workflow.match(/node collect-computer-use-owned-startup.mjs/g)).toHaveLength(2);
    // macOS command is byte-for-byte unchanged: darwin has no owned process producer (null digest).
    expect(workflow).toContain(
      'node collect-computer-use-owned-startup.mjs --executable "${executable}" --source-commit "${SOURCE_COMMIT}" --executable-sha256 "${executable_digest}" --package-sha256 "${package_digest}" --output "${STARTUP_REPORT_ROOT}/owned-startup-checkpoint.json"\n',
    );
    const macosCommand = workflow.match(/ {10}node collect-computer-use-owned-startup.mjs.*\n/gu);
    expect(macosCommand?.filter((line) => line.includes('owned-process-addon'))).toHaveLength(1);
    expect(workflow).toContain('Get-FileHash -Algorithm SHA256 -LiteralPath $addon[0].FullName');
    expect(workflow).toContain(
      "$addonRelative = 'resources\\app.asar.unpacked\\native-safe-fs\\build\\Release\\sprint_coder_native_safe_fs.node'",
    );
    expect(workflow).toContain('--owned-process-addon $addon[0].FullName');
    expect(workflow).toContain('--owned-process-addon-sha256 $addonDigest');
    expect(workflow).toContain(
      'Windows startup requires exactly one packaged native-safe-fs addon.',
    );
    expect(workflow).not.toContain('--owned-process-addon "${');
    expect(
      workflow.match(
        /path: \$\{\{ runner.temp \}\}\/computer-use-owned-startup-.*\/owned-startup-checkpoint.json/g,
      ),
    ).toHaveLength(2);
    const index = readFileSync(resolve(root, 'apps/desktop/src/main/index.ts'), 'utf8');
    expect(index.indexOf("app.setPath('userData', resolve(userDataOverride))")).toBeLessThan(
      index.indexOf('app.requestSingleInstanceLock()'),
    );
    expect(index).toContain('createComputerUseCaptureOutput({');
    expect(index).toContain("join(app.getPath('userData'), 'sprint-coder.sqlite3')");
    expect(readFileSync(resolve(root, 'apps/desktop/src/main/ipc.ts'), 'utf8')).toContain(
      'this.computerUseCaptureOutput?.close();',
    );
  });

  it('bounds an unconfirmed root/transport lifetime without treating abandonment as stop proof', async () => {
    const { input } = fixture();
    let stops = 0;
    let abandoned = 0;
    const capture: Capture = {
      completed: new Promise(() => {}),
      closed: new Promise(() => {}),
      stopOwnedChild: () => {
        stops += 1;
      },
      abandon: () => {
        abandoned += 1;
      },
    };
    await expect(
      startup.collectOwnedComputerUseStartup({ ...input, timeoutMs: 20 }, () => capture),
    ).rejects.toThrow('COMPUTER_USE_OWNED_STARTUP_CHECKPOINT_FAILED');
    expect(stops).toBe(1);
    expect(abandoned).toBe(1);
    expect(() => readFileSync(input.outputPath)).toThrow();
    expect(
      readdirSync(resolve(input.outputPath, '..')).some((name) =>
        name.startsWith('owned-startup-profile-'),
      ),
    ).toBe(true);
  });

  it('cancels an in-flight owned startup and rejects already canceled requests before launch', async () => {
    const { input } = fixture();
    const controller = new AbortController();
    let starts = 0;
    let stops = 0;
    let abandoned = 0;
    const start = () => {
      starts += 1;
      return {
        completed: new Promise(() => {}),
        closed: new Promise<void>(() => {}),
        stopOwnedChild: () => {
          stops += 1;
        },
        abandon: () => {
          abandoned += 1;
        },
      };
    };
    const pending = startup.collectOwnedComputerUseStartup(
      { ...input, signal: controller.signal },
      start,
    );
    controller.abort();
    await expect(pending).rejects.toThrow('COMPUTER_USE_OWNED_STARTUP_CHECKPOINT_FAILED');
    expect(starts).toBe(1);
    expect(stops).toBe(1);
    expect(abandoned).toBe(1);
    await expect(
      startup.collectOwnedComputerUseStartup({ ...input, signal: controller.signal }, start),
    ).rejects.toThrow('COMPUTER_USE_OWNED_STARTUP_CHECKPOINT_FAILED');
    expect(starts).toBe(1);
    expect(() => readFileSync(input.outputPath)).toThrow();
  });

  it('refuses publication when synchronous cancellation races an already completed capture', async () => {
    const { input } = fixture();
    const controller = new AbortController();
    const start = () => {
      controller.abort();
      return {
        completed: Promise.resolve({
          hello: { packaged: true, sourceCommit: 'b'.repeat(40), platform: process.platform },
          executableSha256: input.expectedExecutableSha256,
          sessions: [],
          runIdDigest: 'a'.repeat(64),
          eventChainDigest: 'c'.repeat(64),
          frameCount: 2,
          processIdentityDigest: 'd'.repeat(64),
        }),
        closed: Promise.resolve(),
        stopOwnedChild: () => {},
        abandon: () => {},
      };
    };
    await expect(
      startup.collectOwnedComputerUseStartup({ ...input, signal: controller.signal }, start),
    ).rejects.toThrow('COMPUTER_USE_OWNED_STARTUP_CHECKPOINT_FAILED');
    expect(() => readFileSync(input.outputPath)).toThrow();
  });
});

describe('owned startup process identity digest (schemaVersion 2)', () => {
  it.runIf(isWindows)(
    'rejects an addon hash mismatch before spawn, profile creation and native load',
    async () => {
      const { input, start, captures, loads } = fixture();
      await expect(
        startup.collectOwnedComputerUseStartup({ ...input, addonSha256: 'e'.repeat(64) }, start),
      ).rejects.toThrow(failure);
      expect(captures).toHaveLength(0);
      expect(loads).not.toHaveBeenCalled();
      expect(profileDirectories(input.outputPath)).toEqual([]);
      expect(() => readFileSync(input.outputPath)).toThrow();
    },
  );

  it.runIf(isWindows)(
    'rejects hash mismatch through the default starter before any native load',
    async () => {
      const { input, load, loads, captures } = fixture();
      await expect(
        startup.collectOwnedComputerUseStartup(
          { ...input, addonSha256: 'e'.repeat(64) },
          undefined,
          load,
        ),
      ).rejects.toThrow(failure);
      expect(loads).not.toHaveBeenCalled();
      expect(captures).toHaveLength(0);
      expect(profileDirectories(input.outputPath)).toEqual([]);
    },
  );

  it.runIf(isWindows).each([
    ['missing path', { addonPath: undefined }],
    ['missing hash', { addonSha256: undefined }],
    ['relative path', { addonPath: 'fixture.node' }],
    ['non-.node path', { addonPath: resolve(tmpdir(), 'fixture.dll') }],
    ['uppercase hash', { addonSha256: 'A'.repeat(64) }],
    ['zero hash', { addonSha256: '0'.repeat(64) }],
    ['short hash', { addonSha256: 'a'.repeat(63) }],
    ['missing file', { addonPath: resolve(tmpdir(), 'owned-startup-absent-addon.node') }],
  ])('rejects malformed addon (%s) before profile creation or spawn', async (_name, override) => {
    const { input, start, captures } = fixture();
    await expect(
      startup.collectOwnedComputerUseStartup({ ...input, ...override }, start),
    ).rejects.toThrow(failure);
    expect(captures).toHaveLength(0);
    expect(profileDirectories(input.outputPath)).toEqual([]);
  });

  it.runIf(isWindows)(
    'goes through the real pinned retainer and never hands retainOwnedProcess to the capture',
    async () => {
      const { input, start, captures, launches, loads } = fixture();
      const result = await startup.collectOwnedComputerUseStartup(input, start);
      await Promise.all(captures.map((capture) => capture.closed));
      expect(loads).toHaveBeenCalledTimes(1);
      expect(launches).toHaveLength(1);
      for (const launch of launches)
        expect(Object.hasOwn(launch, 'retainOwnedProcess')).toBe(false);
      expect(result['startupProcessIdentityDigest']).toMatch(/^[a-f0-9]{64}$/u);
      const source = readFileSync(resolve(root, 'collect-computer-use-owned-startup.mjs'), 'utf8');
      expect(source).not.toContain('retainOwnedProcess');
      expect(source).not.toContain('createPinnedOwnedProcessRetainer');
      expect(source).toContain('startPinnedOwnedComputerUseProcessCapture');
    },
  );

  it.runIf(isWindows).each([
    ['absent', undefined],
    ['not hex', 'z'.repeat(64)],
    ['uppercase', 'D'.repeat(64)],
    ['short', 'd'.repeat(63)],
    ['all zero', '0'.repeat(64)],
    ['non-string', 7],
  ])('refuses %s digest on win32, writes no report and retains the profile', async (_n, digest) => {
    const { input } = fixture();
    const { start, counters } = fakeCapture({ processIdentityDigest: digest });
    await expect(startup.collectOwnedComputerUseStartup(input, start)).rejects.toThrow(failure);
    expect(counters.starts).toBe(1);
    expect(() => readFileSync(input.outputPath)).toThrow();
    expect(profileDirectories(input.outputPath)).toHaveLength(1);
  });

  it('reports null on darwin (unmeasured, not absent process) and rejects addon arguments', async () => {
    const { input } = fixture();
    const { addonPath, addonSha256, ...darwinInput } = input as Record<string, unknown>;
    expect([addonPath, addonSha256].length).toBe(2);
    const ok = fakeCapture({ processIdentityDigest: undefined }, 'darwin');
    const report = await withPlatform('darwin', () =>
      startup.collectOwnedComputerUseStartup(darwinInput, ok.start),
    );
    expect(report['startupProcessIdentityDigest']).toBeNull();
    expect(report['schemaVersion']).toBe(2);
    expect(
      JSON.parse(readFileSync(input.outputPath, 'utf8')).startupProcessIdentityDigest,
    ).toBeNull();

    for (const extra of [
      { addonPath: resolve(tmpdir(), 'fixture.node') },
      { addonSha256: 'a'.repeat(64) },
      { addonPath: resolve(tmpdir(), 'fixture.node'), addonSha256: 'a'.repeat(64) },
    ]) {
      const refused = fakeCapture({}, 'darwin');
      const rest = { ...darwinInput };
      delete rest['outputPath'];
      const second = resolve(input.outputPath, '..', `second-${Object.keys(extra).length}.json`);
      await expect(
        withPlatform('darwin', () =>
          startup.collectOwnedComputerUseStartup(
            { ...rest, outputPath: second, ...extra },
            refused.start,
          ),
        ),
      ).rejects.toThrow(failure);
      expect(refused.counters.starts).toBe(0);
    }
  });

  it('parses the CLI as a complete per-platform set and rejects duplicates and unknown keys', () => {
    const base = [
      ['--executable', 'e'],
      ['--source-commit', 'c'],
      ['--executable-sha256', 'x'],
      ['--package-sha256', 'p'],
      ['--output', 'o'],
    ].flat() as string[];
    const addon = ['--owned-process-addon', 'a', '--owned-process-addon-sha256', 's'];
    expect(startup.parseOwnedStartupArguments([...base, ...addon], 'win32')).toMatchObject({
      'owned-process-addon': 'a',
      'owned-process-addon-sha256': 's',
    });
    expect(Object.keys(startup.parseOwnedStartupArguments(base, 'darwin'))).toHaveLength(5);
    for (const [args, platform] of [
      [base, 'win32'],
      [[...base, ...addon.slice(0, 2)], 'win32'],
      [[...base, ...addon.slice(2)], 'win32'],
      [[...base, ...addon], 'darwin'],
      [[...base, ...addon.slice(0, 2)], 'darwin'],
      [[...base, ...addon, '--owned-process-addon', 'b'], 'win32'],
      [[...base, ...addon, '--unknown', 'b'], 'win32'],
      [[...base, ...addon, '--output', 'again'], 'win32'],
      [[...base, ...addon, '--output'], 'win32'],
    ] as [string[], string][])
      expect(() => startup.parseOwnedStartupArguments(args, platform)).toThrow();
  });

  it('keeps the startup report distinct from the parent closure owned-run fact', () => {
    const schema = readFileSync(resolve(root, 'computer-use-parent-evidence-schema.mjs'), 'utf8');
    expect(schema).toContain("'processIdentityDigest'");
    expect(schema).not.toContain('startupProcessIdentityDigest');
    expect(schema).not.toContain('owned-startup-shutdown-checkpoint');
    expect(reportKeys).not.toContain('processIdentityDigest');
    const source = readFileSync(resolve(root, 'collect-computer-use-owned-startup.mjs'), 'utf8');
    expect(source).toContain('startupProcessIdentityDigest');
    expect(source).toContain('finalGateEligible: false');
    for (const consumer of [
      'verify-computer-use-final-gate.mjs',
      'computer-use-parent-evidence-schema.mjs',
    ]) {
      const text = readFileSync(resolve(root, consumer), 'utf8');
      expect(text).not.toContain('startupProcessIdentityDigest');
      expect(text).not.toContain('collect-computer-use-owned-startup');
    }
  });

  it.runIf(isWindows && process.env['CI'] === 'true')(
    'binds the packaged-addon digest through the real addon in a separate driver (CI)',
    async () => {
      const directory = mkdtempSync(resolve(tmpdir(), 'owned-startup-ci-'));
      directories.push(directory);
      const ack = resolve(directory, 'acquired.ack');
      const child = resolve(directory, 'child.mjs');
      writeFileSync(
        child,
        `import {writeSync,existsSync} from 'node:fs';
import {createCaptureEncoder} from ${JSON.stringify(pathToFileURL(resolve(root, 'computer-use-capture-wire.mjs')).href)};
const encode=createCaptureEncoder(process.env.SPRINT_CODER_COMPUTER_USE_CAPTURE_NONCE);
const deadline=Date.now()+5000;
const waiting=setInterval(()=>{
 if(existsSync(process.argv[2])){clearInterval(waiting);
  writeSync(3,encode('hello',{pid:process.pid,parentPid:process.ppid,platform:process.platform,sourceCommit:'b'.repeat(40),nativeManifestDigest:'0'.repeat(64),packaged:true,packageReady:false}));
  writeSync(3,encode('end',{valid:true}));
 } else if(Date.now()>=deadline){clearInterval(waiting);process.exit(2);}
},10);
`,
      );
      const addonPath = resolve(
        root,
        'apps/desktop/native-safe-fs/build/Release/sprint_coder_native_safe_fs.node',
      );
      const outputPath = resolve(directory, 'checkpoint.json');
      const driver = resolve(directory, 'driver.mjs');
      writeFileSync(
        driver,
        `import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {collectOwnedComputerUseStartup} from ${JSON.stringify(pathToFileURL(resolve(root, 'collect-computer-use-owned-startup.mjs')).href)};
import {startPinnedOwnedComputerUseProcessCapture} from ${JSON.stringify(pathToFileURL(resolve(root, 'computer-use-owned-process-receipt.mjs')).href)};
const sha=(path)=>createHash('sha256').update(readFileSync(path)).digest('hex');
const addonPath=${JSON.stringify(addonPath)};
const addonSha256=sha(addonPath);
// Default loader: no load injected. The ack is written only after the real acquisition returned.
const start=(launch)=>{
 const capture=startPinnedOwnedComputerUseProcessCapture({addonPath,addonSha256,capture:{...launch,args:[${JSON.stringify(child)},${JSON.stringify(ack)}]}});
 writeFileSync(${JSON.stringify(ack)},'ACQUISITION_RETURNED',{flag:'wx'});
 return capture;
};
try {
 await collectOwnedComputerUseStartup({executable:process.execPath,expectedSourceCommit:'b'.repeat(40),expectedExecutableSha256:sha(process.execPath),packageSha256:'a'.repeat(64),outputPath:${JSON.stringify(outputPath)},timeoutMs:10000,addonPath,addonSha256},start);
 process.stdout.write('OWNED_STARTUP_DIGEST_PASS');
} catch {process.exitCode=1;process.stderr.write('OWNED_STARTUP_DIGEST_FAILED');}
`,
      );
      const driverProcess = spawn(process.execPath, [driver], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      driverProcess.stdout.on('data', (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(0, 128);
      });
      const code = await new Promise<number | null>((resolveCode, reject) => {
        const timer = setTimeout(() => {
          driverProcess.kill();
          reject(new Error('OWNED_STARTUP_CI_TIMEOUT'));
        }, 20_000);
        driverProcess.once('close', (exitCode) => {
          clearTimeout(timer);
          resolveCode(exitCode);
        });
      });
      expect(code).toBe(0);
      expect(output).toBe('OWNED_STARTUP_DIGEST_PASS');
      const report = JSON.parse(readFileSync(outputPath, 'utf8'));
      expect(report.startupProcessIdentityDigest).toMatch(/^[a-f0-9]{64}$/u);
      expect(readFileSync(outputPath, 'utf8')).not.toContain(process.execPath);
    },
  );
});
