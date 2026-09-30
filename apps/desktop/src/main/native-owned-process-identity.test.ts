import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nativeSafeFsAddonPath } from './native-safe-fs';

type Receipt = Readonly<{
  snapshot(): Readonly<{
    pid: number;
    parentPid: number;
    startIdentity: string;
    imagePath: string;
  }>;
  isRunning(): boolean;
  verifyUnchanged(): boolean;
  close(): void;
}>;
type RetainedAddon = Readonly<{ retainOwnedProcessIdentity(pid: number): Receipt }>;

async function removeOwnedFixtureRoot(root: string): Promise<void> {
  const withinTemporaryRoot = relative(resolve(tmpdir()), resolve(root));
  if (
    withinTemporaryRoot === '' ||
    withinTemporaryRoot === '..' ||
    withinTemporaryRoot.startsWith(`..${sep}`) ||
    isAbsolute(withinTemporaryRoot)
  )
    throw new Error('OWNED_FIXTURE_ROOT_INVALID');
  await rm(root, { recursive: true, force: true });
}

// New native compilation is held locally. Ordinary Windows CI builds this source before tests;
// a missing API there is a failure, never a stale-artifact skip or a snapshot substitution.
describe.runIf(process.platform === 'win32' && process.env['CI'] === 'true')(
  'native owned Windows process identity receipt',
  () => {
    const addon = (): RetainedAddon => {
      const loaded: unknown = createRequire(import.meta.url)(nativeSafeFsAddonPath());
      expect(loaded).toHaveProperty('retainOwnedProcessIdentity', expect.any(Function));
      return loaded as RetainedAddon;
    };

    async function childFixture<T>(
      exitCode: number,
      run: (child: ChildProcessWithoutNullStreams) => Promise<T>,
    ): Promise<T> {
      const root = await mkdtemp(join(tmpdir(), 'sc-retained-process-'));
      const script = join(root, 'owned-child.cjs');
      await writeFile(
        script,
        "process.stdin.resume(); process.stdout.write('READY\\n'); process.stdin.on('end', () => process.exit(Number(process.argv[2])));\n",
      );
      const child = spawn(process.execPath, [script, String(exitCode)], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const closed = new Promise<void>((resolveClosed) =>
        child.once('close', () => resolveClosed()),
      );
      try {
        await new Promise<void>((resolveReady, reject) => {
          const timer = setTimeout(() => reject(new Error('OWNED_FIXTURE_START_TIMEOUT')), 5_000);
          child.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.stdout.once('data', () => {
            clearTimeout(timer);
            resolveReady();
          });
        });
        return await run(child);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await Promise.race([
          closed,
          new Promise<void>((resolveWait) => {
            const timer = setTimeout(resolveWait, 5_000);
            timer.unref();
          }),
        ]);
        await removeOwnedFixtureRoot(root);
      }
    }

    it.each([0, 259])('retains the same direct child through normal exit %s', async (exitCode) => {
      await childFixture(exitCode, async (child) => {
        const receipt = addon().retainOwnedProcessIdentity(child.pid!);
        try {
          const before = receipt.snapshot();
          expect(before.pid === child.pid).toBe(true);
          expect(before.parentPid === process.pid).toBe(true);
          expect(/^win32:[0-9]+$/u.test(before.startIdentity)).toBe(true);
          expect(before.imagePath.length > 0).toBe(true);
          expect(receipt.isRunning()).toBe(true);
          expect(receipt.verifyUnchanged()).toBe(true);
          const exited = new Promise<void>((resolveExit, rejectExit) => {
            const timer = setTimeout(
              () => rejectExit(new Error('OWNED_FIXTURE_EXIT_TIMEOUT')),
              5_000,
            );
            child.once('exit', () => {
              clearTimeout(timer);
              resolveExit();
            });
          });
          child.stdin.end();
          await exited;
          expect(child.exitCode).toBe(exitCode);
          expect(receipt.isRunning()).toBe(false);
          expect(receipt.verifyUnchanged()).toBe(true);
          const after = receipt.snapshot();
          expect(
            after.pid === before.pid &&
              after.parentPid === before.parentPid &&
              after.startIdentity === before.startIdentity &&
              after.imagePath === before.imagePath,
          ).toBe(true);
          receipt.close();
          receipt.close();
          expect(receipt.verifyUnchanged()).toBe(false);
          expect(() => receipt.snapshot()).toThrow();
          expect(() => receipt.isRunning()).toThrow();
        } finally {
          receipt.close();
        }
      });
    });

    it('rejects invalid inputs, non-owned process identities, and forged receivers', async () => {
      const binding = addon();
      expect(() => Reflect.apply(binding.retainOwnedProcessIdentity, binding, [])).toThrow();
      for (const invalid of [0, -1, 0.5, NaN, Infinity, 2 ** 32, process.pid])
        expect(() => binding.retainOwnedProcessIdentity(invalid)).toThrow();
      expect(() => binding.retainOwnedProcessIdentity(process.ppid)).toThrow();
      await childFixture(0, async (child) => {
        expect(() =>
          Reflect.apply(binding.retainOwnedProcessIdentity, binding, [child.pid, child.pid]),
        ).toThrow();
        expect(() =>
          Reflect.apply(binding.retainOwnedProcessIdentity, binding, [String(child.pid)]),
        ).toThrow();
        const receipt = binding.retainOwnedProcessIdentity(child.pid!);
        try {
          for (const method of [
            receipt.snapshot,
            receipt.isRunning,
            receipt.verifyUnchanged,
            receipt.close,
          ])
            expect(() => Reflect.apply(method, {}, [])).toThrow();
          expect(() => receipt.close.call(Object.create(receipt))).toThrow();
          expect(receipt.verifyUnchanged()).toBe(true);
        } finally {
          receipt.close();
        }
      });
    });

    it('bounds active leases and restores quota after idempotent close', async () => {
      const binding = addon();
      await childFixture(0, async (child) => {
        const receipts: Receipt[] = [];
        try {
          for (let index = 0; index < 16; index++)
            receipts.push(binding.retainOwnedProcessIdentity(child.pid!));
          expect(() => binding.retainOwnedProcessIdentity(child.pid!)).toThrow();
          receipts[0]!.close();
          receipts[0]!.close();
          receipts.push(binding.retainOwnedProcessIdentity(child.pid!));
          expect(receipts.at(-1)!.verifyUnchanged()).toBe(true);
          expect(() => binding.retainOwnedProcessIdentity(child.pid!)).toThrow();
        } finally {
          for (const receipt of receipts) receipt.close();
        }
      });
    });
  },
);
