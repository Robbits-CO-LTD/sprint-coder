import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
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
    `import {writeSync,existsSync} from 'node:fs';
import {createCaptureEncoder} from ${JSON.stringify(pathToFileURL(resolve(root, 'computer-use-capture-wire.mjs')).href)};
const encode=createCaptureEncoder(process.env.SPRINT_CODER_COMPUTER_USE_CAPTURE_NONCE);
writeSync(3,encode('hello',{pid:process.pid,parentPid:process.ppid,platform:process.platform,sourceCommit:'b'.repeat(40),nativeManifestDigest:'0'.repeat(64),packaged:false,packageReady:false}));
${
  kind === 'await-acquisition'
    ? `const ack=process.argv[2];const deadline=Date.now()+5000;
const waiting=setInterval(()=>{if(typeof ack==='string'&&existsSync(ack)){clearInterval(waiting);writeSync(3,encode('end',{valid:true}));}else if(Date.now()>=deadline){clearInterval(waiting);process.exit(2);}},10);`
    : kind === 'pending'
      ? 'setInterval(()=>{},1000);'
      : kind === 'missing-end'
        ? ''
        : "writeSync(3,encode('end',{valid:true}));"
}
`,
  );
  return { directory, child };
}

function syntheticDefaultAddon(
  run: (fixture: {
    addonPath: string;
    addonSha256: string;
    binding: { retainOwnedProcessIdentity: ReturnType<typeof vi.fn> };
    require: NodeJS.Require;
    loads: ReturnType<typeof vi.fn>;
  }) => void,
): void {
  const { directory } = fixture('normal');
  const path = resolve(directory, 'controlled-default.node');
  writeFileSync(path, 'CONTROLLED_DEFAULT_LOADER_FIXTURE_NOT_NATIVE');
  const addonPath = realpathSync(path);
  const require = createRequire(import.meta.url);
  const originalExtension = require.extensions['.node']!;
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const binding = {
    retainOwnedProcessIdentity: vi.fn((pid: number) => ({
      snapshot: () => ({
        pid,
        parentPid: process.pid,
        startIdentity: 'win32:12347',
        imagePath: process.execPath,
      }),
      isRunning: () => true,
      verifyUnchanged: () => true,
      close: vi.fn(),
    })),
  };
  const loads = vi.fn();
  // Actual default require/cache mechanics, with only this text fixture's extension and platform
  // controlled. This never loads a native artifact or queries a Windows process.
  require.extensions['.node'] = (module, filename) => {
    if (filename !== addonPath) return originalExtension(module, filename);
    loads();
    module.exports = binding;
  };
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  try {
    run({
      addonPath,
      addonSha256: createHash('sha256').update(readFileSync(addonPath)).digest('hex'),
      binding,
      require,
      loads,
    });
  } finally {
    Object.defineProperty(process, 'platform', platform);
    require.extensions['.node'] = originalExtension;
    // Cleanup is limited to this test's synthetic module, never a production cache bypass.
    delete require.cache[addonPath];
  }
}

describe('owned capture private retained process lifecycle', () => {
  it('keeps the controlled producer alive until acquisition is acknowledged', async () => {
    const { directory, child } = fixture('await-acquisition');
    const ack = resolve(directory, 'acquired.ack');
    let acquired = false;
    const close = vi.fn();
    const capture = collector.startOwnedComputerUseCapture({
      executable: process.execPath,
      args: [child, ack],
      retainOwnedProcess: (context: { pid: number; executable: string }) => {
        acquired = true;
        return {
          close,
          isRunning: () => true,
          verifyUnchanged: () => true,
          snapshot: () => ({
            pid: context.pid,
            parentPid: process.pid,
            startIdentity: 'win32:12348',
            imagePath: context.executable,
          }),
        };
      },
    });
    const completed = vi.fn();
    void capture.completed.then(completed).catch(() => undefined);
    try {
      // Generated Node producer and receipt stub only; no native process API is exercised.
      await (capture as unknown as { handshake: Promise<unknown> }).handshake;
      expect(acquired).toBe(true);
      expect(existsSync(ack)).toBe(false);
      await new Promise((resolveWait) => setTimeout(resolveWait, 30));
      expect(completed).not.toHaveBeenCalled();
      writeFileSync(ack, 'ACQUISITION_RETURNED', { flag: 'wx' });
      await expect(capture.completed).resolves.toHaveProperty('processIdentityDigest');
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      (capture as unknown as { stopOwnedChild(): void }).stopOwnedChild();
      await capture.closed;
    }
  });

  it('reuses a default binding only after the same path and hash were verified', () => {
    syntheticDefaultAddon(({ addonPath, addonSha256, binding, require, loads }) => {
      const first = loader.createPinnedOwnedProcessRetainer({ addonPath, addonSha256 });
      const entry = require.cache[addonPath];
      expect(entry?.exports).toBe(binding);
      first({ pid: 123, executable: process.execPath }).close();
      const second = loader.createPinnedOwnedProcessRetainer({ addonPath, addonSha256 });
      second({ pid: 124, executable: process.execPath }).close();
      expect(require.cache[addonPath]).toBe(entry);
      expect(loads).toHaveBeenCalledTimes(1);
      expect(binding.retainOwnedProcessIdentity).toHaveBeenCalledTimes(2);
    });
  });

  it('rejects an unknown default-loader preload even when bytes match', () => {
    syntheticDefaultAddon(({ addonPath, addonSha256, require }) => {
      require(addonPath);
      expect(() => loader.createPinnedOwnedProcessRetainer({ addonPath, addonSha256 })).toThrow(
        'Owned process receipt is unavailable',
      );
    });
  });

  it.each(['disk-old-pin', 'disk-new-pin', 'cache-entry', 'cache-missing', 'exports', 'function'])(
    'refuses a previously verified default load after %s changes',
    (change) => {
      syntheticDefaultAddon(({ addonPath, addonSha256, binding, require, loads }) => {
        const retain = loader.createPinnedOwnedProcessRetainer({ addonPath, addonSha256 });
        const entry = require.cache[addonPath]!;
        let requestedHash = addonSha256;
        if (change.startsWith('disk-')) {
          writeFileSync(addonPath, 'CHANGED_DEFAULT_LOADER_BYTES');
          if (change === 'disk-new-pin')
            requestedHash = createHash('sha256').update(readFileSync(addonPath)).digest('hex');
        } else if (change === 'cache-entry') {
          require.cache[addonPath] = { ...entry };
        } else if (change === 'cache-missing') {
          delete require.cache[addonPath];
        } else if (change === 'exports') {
          entry.exports = { ...binding };
        } else {
          binding.retainOwnedProcessIdentity = vi.fn();
        }
        expect(() =>
          loader.createPinnedOwnedProcessRetainer({ addonPath, addonSha256: requestedHash }),
        ).toThrow('Owned process receipt is unavailable');
        if (!change.startsWith('disk-'))
          expect(() => retain({ pid: 125, executable: process.execPath })).toThrow(
            'Owned process receipt is unavailable',
          );
        expect(loads).toHaveBeenCalledTimes(1);
        expect(binding.retainOwnedProcessIdentity).not.toHaveBeenCalled();
      });
    },
  );

  it('does not mark a default module verified when bytes change during loading', () => {
    syntheticDefaultAddon(({ addonPath, addonSha256, require, loads }) => {
      loads.mockImplementation(() => writeFileSync(addonPath, 'CHANGED_DURING_LOAD'));
      expect(() => loader.createPinnedOwnedProcessRetainer({ addonPath, addonSha256 })).toThrow(
        'Owned process receipt is unavailable',
      );
      expect(require.cache[addonPath]).toBeDefined();
      const changedHash = createHash('sha256').update(readFileSync(addonPath)).digest('hex');
      expect(() =>
        loader.createPinnedOwnedProcessRetainer({ addonPath, addonSha256: changedHash }),
      ).toThrow('Owned process receipt is unavailable');
      expect(loads).toHaveBeenCalledTimes(1);
    });
  });

  it('keeps explicitly injected loader behavior separate from default verified-cache reuse', () => {
    syntheticDefaultAddon(({ addonPath, addonSha256, binding, require, loads }) => {
      const custom = vi.fn(() => binding);
      loader.createPinnedOwnedProcessRetainer({ addonPath, addonSha256 }, custom);
      loader.createPinnedOwnedProcessRetainer({ addonPath, addonSha256 }, custom);
      expect(custom).toHaveBeenCalledTimes(2);
      expect(require.cache[addonPath]).toBeUndefined();
      expect(loads).not.toHaveBeenCalled();
      loader.createPinnedOwnedProcessRetainer({ addonPath, addonSha256 });
      expect(loads).toHaveBeenCalledTimes(1);
    });
  });

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
    'inactive',
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
        isRunning: () => kind !== 'inactive',
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
    if (kind === 'inactive') expect(checks).toBe(0);
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
    'reuses the freshly built native receipt for two acquisition-synchronized captures in CI',
    async () => {
      const { directory, child } = fixture('await-acquisition');
      const driver = resolve(directory, 'driver.mjs');
      const addonPath = resolve(
        root,
        'apps/desktop/native-safe-fs/build/Release/sprint_coder_native_safe_fs.node',
      );
      writeFileSync(
        driver,
        `import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {startPinnedOwnedComputerUseProcessCapture} from ${JSON.stringify(pathToFileURL(resolve(root, 'computer-use-owned-process-receipt.mjs')).href)};
let capture; let successful=false; let phase='pin_start'; let failureReported=false;
try {
 const addonPath=${JSON.stringify(addonPath)};
 const addonSha256=createHash('sha256').update(readFileSync(addonPath)).digest('hex');
 const acknowledgements=${JSON.stringify([resolve(directory, 'acquired-0.ack'), resolve(directory, 'acquired-1.ack')])};
 const identities=[];
 for(let round=0;round<2;round++) {
 phase='pin_start';
 capture=startPinnedOwnedComputerUseProcessCapture({addonPath,addonSha256,capture:{executable:process.execPath,args:[${JSON.stringify(child)},acknowledgements[round]]}});
 // Test-only producer lifetime barrier: release END/exit after synchronous acquisition returns.
 writeFileSync(acknowledgements[round],'ACQUISITION_RETURNED',{flag:'wx'});
 phase='handshake'; await capture.handshake;
 phase='normal_completion'; const completed=await capture.completed;
 phase='capture_closed'; await capture.closed;
 phase='digest';
 if(!/^[a-f0-9]{64}$/.test(completed.processIdentityDigest)||JSON.stringify(completed).includes(process.execPath)) throw new Error();
 identities.push(completed.processIdentityDigest);
 }
 if(identities[0]===identities[1]) throw new Error();
 successful=true;
} catch {process.exitCode=1;process.stderr.write('OWNED_PROCESS_CAPTURE_UNCONFIRMED:'+phase);failureReported=true;} finally {
 if(capture) { capture.stopOwnedChild(); if(!successful)capture.abandon();
  let timer; try {await Promise.race([capture.closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error()),5000);timer.unref();})]);}catch{phase='cleanup';successful=false;process.exitCode=1;}finally{clearTimeout(timer);}
 }
}
if(successful)process.stdout.write('OWNED_PROCESS_CAPTURE_PASS');else if(!failureReported)process.stderr.write('OWNED_PROCESS_CAPTURE_UNCONFIRMED:'+phase);
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
      let diagnostic = '';
      let diagnosticBytes = 0;
      driverProcess.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      driverProcess.stderr.on('data', (chunk: Buffer) => {
        diagnosticBytes += chunk.length;
        diagnostic = diagnosticBytes <= 128 ? diagnostic + chunk.toString('utf8') : '';
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
        const failureBoundary =
          /^OWNED_PROCESS_CAPTURE_UNCONFIRMED:(pin_start|handshake|normal_completion|capture_closed|digest|cleanup)$/u.test(
            diagnostic,
          )
            ? diagnostic
            : 'OWNED_PROCESS_CAPTURE_UNCONFIRMED';
        expect(code, failureBoundary).toBe(0);
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
