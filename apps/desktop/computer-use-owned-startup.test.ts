import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

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
    start?: (input: Record<string, unknown>) => Capture,
  ): Promise<Record<string, unknown>>;
};
beforeAll(async () => {
  collector = await import(pathToFileURL(resolve(root, 'collect-computer-use-runtime.mjs')).href);
  startup = await import(
    pathToFileURL(resolve(root, 'collect-computer-use-owned-startup.mjs')).href
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
  const captures: Capture[] = [];
  const profiles: string[] = [];
  const start = (launch: Record<string, unknown>) => {
    const environment = launch['environment'] as Record<string, string>;
    const profile = environment['SPRINT_CODER_USER_DATA_DIR']!;
    profiles.push(profile);
    expect(readdirSync(profile)).toEqual([]);
    const capture = collector.startOwnedComputerUseCapture({
      ...launch,
      args: [child],
      environment: { ...environment, PRIVATE_FIXTURE_CREDENTIAL: 'synthetic-only' },
    });
    captures.push(capture);
    return capture;
  };
  return { input, start, captures, profiles };
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
    });
    const bytes = readFileSync(input.outputPath, 'utf8');
    expect(Buffer.byteLength(bytes)).toBeLessThanOrEqual(4096);
    for (const value of [
      'PRIVATE_FIXTURE_CONTENT',
      'pid',
      'parentPid',
      'frames',
      'profile',
      'nonce',
    ])
      expect(bytes).not.toContain(value);
    expect(profiles).toHaveLength(1);
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
    const { input, start, captures } = fixture();
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
  });

  it('connects only opt-in protected workflow callers and uploads the exact bounded report', () => {
    const workflow = readFileSync(
      resolve(root, '.github/workflows/computer-use-final-gate.yml'),
      'utf8',
    );
    expect(workflow).toContain('collect_owned_startup:');
    expect(workflow).toContain('inputs.collect_owned_startup');
    expect(workflow.match(/node collect-computer-use-owned-startup.mjs/g)).toHaveLength(2);
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
