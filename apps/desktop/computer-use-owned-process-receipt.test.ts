import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
const root = resolve(__dirname, '../..');
const directories: string[] = [];
let collector: {
  startOwnedComputerUseCapture(input: unknown): {
    completed: Promise<Record<string, unknown>>;
    closed: Promise<void>;
    abandon(): void;
  };
};
let loader: {
  startPinnedOwnedComputerUseProcessCapture(
    input: unknown,
    load?: unknown,
  ): ReturnType<typeof collector.startOwnedComputerUseCapture>;
  createPinnedOwnedProcessRetainer(
    input: unknown,
    load?: unknown,
  ): (context: unknown) => { close(): void; snapshot(): unknown; verifyUnchanged(): boolean };
};
beforeAll(async () => {
  collector = await import(pathToFileURL(resolve(root, 'collect-computer-use-runtime.mjs')).href);
  loader = await import(
    pathToFileURL(resolve(root, 'computer-use-owned-process-receipt.mjs')).href
  );
});
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture(kind: string) {
  const directory = mkdtempSync(resolve(tmpdir(), 'owned-process-receipt-fixture-'));
  directories.push(directory);
  const child = resolve(directory, 'child.mjs');
  writeFileSync(
    child,
    `import {writeSync} from 'node:fs';
import {createCaptureEncoder} from ${JSON.stringify(pathToFileURL(resolve(root, 'computer-use-capture-wire.mjs')).href)};
const encode=createCaptureEncoder(process.env.SPRINT_CODER_COMPUTER_USE_CAPTURE_NONCE);
writeSync(3,encode('hello',{pid:process.pid,parentPid:process.ppid,platform:process.platform,sourceCommit:'b'.repeat(40),nativeManifestDigest:'0'.repeat(64),packaged:false,packageReady:false}));
${kind === 'pending' ? 'setInterval(()=>{},1000);' : kind === 'missing-end' ? '' : "writeSync(3,encode('end',{valid:true}));"}
`,
  );
  return { directory, child };
}
describe('owned capture private retained process lifecycle', () => {
  it.each([
    'normal',
    'changed',
    'missing-end',
    'retainer-throws',
    'pending',
    'malformed',
    'wrong-parent',
    'image-missing',
    'close-failure',
  ])('releases the receipt exactly once on %s without manufacturing run facts', async (kind) => {
    const { child } = fixture(kind);
    const close = vi.fn(() => {
      if (kind === 'close-failure') throw new Error('PRIVATE_CLOSE_DETAIL');
    });
    let checks = 0;
    const retain = vi.fn((context: { pid: number; executable: string }) => {
      if (kind === 'retainer-throws') throw new Error('PRIVATE_BACKEND_DETAIL');
      expect(context.pid).toBeGreaterThan(0);
      expect(context.executable).toBe(process.execPath);
      return {
        close,
        isRunning: () => true,
        verifyUnchanged: () => {
          checks++;
          return kind !== 'changed' || checks === 1;
        },
        snapshot: () => ({
          pid: context.pid,
          parentPid: kind === 'wrong-parent' ? process.pid + 1 : process.pid,
          startIdentity: kind === 'malformed' ? undefined : 'win32:12345',
          imagePath: kind === 'image-missing' ? undefined : context.executable,
        }),
      };
    });
    const capture = collector.startOwnedComputerUseCapture({
      executable: process.execPath,
      args: [child],
      retainOwnedProcess: retain,
    });
    try {
      if (kind === 'pending') capture.abandon();
      if (kind === 'normal') {
        const result = await capture.completed;
        expect(result['processIdentityDigest']).toMatch(/^[a-f0-9]{64}$/u);
        expect(JSON.stringify(result)).not.toContain(process.execPath);
        expect(JSON.stringify(result)).not.toContain('win32:12345');
        expect(result).not.toHaveProperty('processIdentity');
        expect(result).not.toHaveProperty('verifiedOwnedRunFacts');
        expect(result).not.toHaveProperty('finalGateEligible');
      } else
        await expect(capture.completed).rejects.toThrow('Computer Use live capture is incomplete');
    } finally {
      // Only our own generated harmless Node fixture is stopped.
      (capture as unknown as { stopOwnedChild(): void }).stopOwnedChild();
      await capture.closed;
    }
    expect(retain).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(kind === 'retainer-throws' ? 0 : 1);
  });
  it('sanitizes malformed launch and loader inputs before any native loading', () => {
    const poison = Object.defineProperty({}, 'addonPath', {
      get() {
        throw new Error('PRIVATE_INPUT_DETAIL');
      },
    });
    for (const input of [null, poison]) {
      expect(() => loader.createPinnedOwnedProcessRetainer(input)).toThrow(
        'Owned process receipt is unavailable',
      );
      expect(() => loader.startPinnedOwnedComputerUseProcessCapture(input)).toThrow(
        'Owned process receipt is unavailable',
      );
    }
  });
  it.runIf(process.platform === 'win32' && process.env['CI'] === 'true')(
    'uses the freshly built native receipt in the actual pinned collector in CI',
    async () => {
      const { directory, child } = fixture('normal');
      const driver = resolve(directory, 'driver.mjs');
      const addonPath = resolve(
        root,
        'apps/desktop/native-safe-fs/build/Release/sprint_coder_native_safe_fs.node',
      );
      writeFileSync(
        driver,
        `import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {startPinnedOwnedComputerUseProcessCapture} from ${JSON.stringify(pathToFileURL(resolve(root, 'computer-use-owned-process-receipt.mjs')).href)};
let capture; let successful=false;
try {
 const addonPath=${JSON.stringify(addonPath)};
 capture=startPinnedOwnedComputerUseProcessCapture({addonPath,addonSha256:createHash('sha256').update(readFileSync(addonPath)).digest('hex'),capture:{executable:process.execPath,args:[${JSON.stringify(child)}]}});
 const completed=await capture.completed; await capture.closed;
 if(!/^[a-f0-9]{64}$/.test(completed.processIdentityDigest)||JSON.stringify(completed).includes(process.execPath)) throw new Error();
 successful=true;
} catch {process.exitCode=1;} finally {
 if(capture) { capture.stopOwnedChild(); if(!successful)capture.abandon();
  let timer; try {await Promise.race([capture.closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error()),5000);timer.unref();})]);}catch{successful=false;process.exitCode=1;}finally{clearTimeout(timer);}
 }
}
if(successful)process.stdout.write('OWNED_PROCESS_CAPTURE_PASS');else process.stderr.write('OWNED_PROCESS_CAPTURE_UNCONFIRMED');
`,
      );
      const driverProcess = spawn(process.execPath, [driver], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const driverClosed = new Promise<void>((resolveClosed) =>
        driverProcess.once('close', () => resolveClosed()),
      );
      let output = '';
      driverProcess.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      try {
        const code = await new Promise<number | null>((resolveCode, reject) => {
          const timer = setTimeout(() => reject(new Error('OWNED_PROCESS_CI_TIMEOUT')), 10_000);
          driverProcess.once('error', () => {
            clearTimeout(timer);
            reject(new Error('OWNED_PROCESS_CI_START_FAILED'));
          });
          driverProcess.once('close', (exitCode) => {
            clearTimeout(timer);
            resolveCode(exitCode);
          });
        });
        expect(code).toBe(0);
        expect(output).toBe('OWNED_PROCESS_CAPTURE_PASS');
      } finally {
        if (driverProcess.exitCode === null && driverProcess.signalCode === null)
          driverProcess.kill();
        await Promise.race([
          driverClosed,
          new Promise<void>((resolveWait) => {
            const timer = setTimeout(resolveWait, 5000);
            timer.unref();
          }),
        ]);
      }
    },
  );
  it.skipIf(process.platform !== 'win32')(
    'connects the pinned readonly loader to the actual owned capture',
    async () => {
      const { directory, child } = fixture('normal');
      const path = resolve(directory, 'fixture.node');
      writeFileSync(path, 'controlled-loader-fixture-not-native');
      const close = vi.fn();
      const result = loader.startPinnedOwnedComputerUseProcessCapture(
        {
          addonPath: path,
          addonSha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
          capture: { executable: process.execPath, args: [child] },
        },
        () => ({
          retainOwnedProcessIdentity: (pid: number) => ({
            close,
            isRunning: () => true,
            verifyUnchanged: () => true,
            snapshot: () => ({
              pid,
              parentPid: process.pid,
              startIdentity: 'win32:12346',
              imagePath: process.execPath,
            }),
          }),
        }),
      );
      const completed = await result.completed;
      await result.closed;
      expect(completed['processIdentityDigest']).toMatch(/^[a-f0-9]{64}$/u);
      expect(JSON.stringify(completed)).not.toContain('win32:12346');
      expect(JSON.stringify(completed)).not.toContain(process.execPath);
      expect(close).toHaveBeenCalledTimes(1);
    },
  );
  it.skipIf(process.platform !== 'win32')(
    'pins the readonly loader and rejects private backend errors',
    () => {
      const { directory } = fixture('normal');
      const path = resolve(directory, 'fixture.node');
      writeFileSync(path, 'not-a-native-binary; controlled loader fixture only');
      const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
      const close = vi.fn();
      const retain = loader.createPinnedOwnedProcessRetainer(
        { addonPath: path, addonSha256: digest },
        () => ({
          retainOwnedProcessIdentity: () => ({
            close,
            snapshot: () => {
              throw new Error('PRIVATE_BACKEND_DETAIL');
            },
          }),
        }),
      );
      expect(() => retain({ pid: 123, executable: process.execPath })).toThrow(
        'Owned process receipt is unavailable',
      );
      expect(close).toHaveBeenCalledTimes(1);
      const load = vi.fn();
      expect(() =>
        loader.createPinnedOwnedProcessRetainer(
          { addonPath: path, addonSha256: 'a'.repeat(64) },
          load,
        ),
      ).toThrow('Owned process receipt is unavailable');
      expect(load).not.toHaveBeenCalled();
    },
  );
});
