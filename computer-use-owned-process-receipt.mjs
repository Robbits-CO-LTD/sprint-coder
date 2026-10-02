import { startOwnedComputerUseCapture, hashExecutable } from './collect-computer-use-runtime.mjs';
import process from 'node:process';
import { lstatSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, resolve, win32 } from 'node:path';

const fail = () => {
  throw new Error('Owned process receipt is unavailable');
};
const requireNative = createRequire(import.meta.url);
const verifiedNativeLoads = new WeakMap();
const verifiedNativePaths = new Set();
const samePath = (left, right) =>
  win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase();
function addonHash(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) fail();
  return hashExecutable(path, 64 * 1024 * 1024);
}

function verifiedCacheMatches(path, hash, entry, verified) {
  return (
    entry !== undefined &&
    verified !== undefined &&
    requireNative.cache[path] === entry &&
    entry.loaded === true &&
    verified.path === path &&
    verified.hash === hash &&
    entry.exports === verified.binding &&
    verified.binding.retainOwnedProcessIdentity === verified.retainOwnedProcessIdentity
  );
}

/** The protected caller must authenticate package/source provenance separately. A hash alone
 * does not authenticate an addon. This exposes only readonly process receipts, never run facts. */
export function createPinnedOwnedProcessRetainer(input, load = requireNative) {
  try {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) fail();
    const { addonPath, addonSha256 } = input;
    if (
      process.platform !== 'win32' ||
      typeof addonPath !== 'string' ||
      !isAbsolute(addonPath) ||
      !addonPath.endsWith('.node') ||
      typeof addonSha256 !== 'string' ||
      !/^(?!0{64}$)[a-f0-9]{64}$/u.test(addonSha256) ||
      typeof load !== 'function'
    )
      fail();
    const path = realpathSync(addonPath);
    if (!samePath(path, resolve(addonPath)) || addonHash(path) !== addonSha256) fail();
    const defaultLoader = load === requireNative;
    let entry = defaultLoader ? requireNative.cache[path] : undefined;
    let verified = entry === undefined ? undefined : verifiedNativeLoads.get(entry);
    // Only this module's verified load may be reused. A missing/replaced cache entry cannot
    // rebind an already loaded native image by deleting its cache and loading again.
    if (
      defaultLoader &&
      (entry === undefined
        ? verifiedNativePaths.has(path)
        : !verifiedCacheMatches(path, addonSha256, entry, verified))
    )
      fail();
    const binding = verified === undefined ? load(path) : verified.binding;
    if (
      addonHash(path) !== addonSha256 ||
      typeof binding?.retainOwnedProcessIdentity !== 'function'
    )
      fail();
    if (defaultLoader) {
      entry = requireNative.cache[path];
      verified ??= Object.freeze({
        path,
        hash: addonSha256,
        binding,
        retainOwnedProcessIdentity: binding.retainOwnedProcessIdentity,
      });
      if (!verifiedCacheMatches(path, addonSha256, entry, verified)) fail();
      verifiedNativeLoads.set(entry, verified);
      verifiedNativePaths.add(path);
    }
    return (context) => {
      let receipt;
      try {
        if (
          !Number.isSafeInteger(context?.pid) ||
          context.pid <= 0 ||
          typeof context.executable !== 'string' ||
          !isAbsolute(context.executable)
        )
          fail();
        if (defaultLoader && !verifiedCacheMatches(path, addonSha256, entry, verified)) fail();
        receipt = defaultLoader
          ? Reflect.apply(verified.retainOwnedProcessIdentity, binding, [context.pid])
          : binding.retainOwnedProcessIdentity(context.pid);
        const measured = receipt.snapshot();
        const baseline = Object.freeze({
          pid: measured?.pid,
          parentPid: measured?.parentPid,
          startIdentity: measured?.startIdentity,
          imagePath: measured?.imagePath,
        });
        if (
          baseline?.pid !== context.pid ||
          baseline.parentPid !== process.pid ||
          typeof baseline.startIdentity !== 'string' ||
          !/^win32:[1-9][0-9]*$/u.test(baseline.startIdentity) ||
          baseline.startIdentity.length > 128 ||
          typeof baseline.imagePath !== 'string' ||
          !isAbsolute(baseline.imagePath) ||
          baseline.imagePath.length > 32768 ||
          !samePath(baseline.imagePath, context.executable) ||
          receipt.isRunning() !== true ||
          receipt.verifyUnchanged() !== true
        )
          fail();
        let closed = false;
        return Object.freeze({
          snapshot: () => {
            if (closed) fail();
            return Object.freeze({ ...baseline });
          },
          verifyUnchanged: () => {
            try {
              return !closed && receipt.verifyUnchanged() === true;
            } catch {
              fail();
            }
          },
          isRunning: () => {
            try {
              return !closed && receipt.isRunning() === true;
            } catch {
              fail();
            }
          },
          close: () => {
            if (closed) return;
            closed = true;
            try {
              receipt.close();
            } catch {
              fail();
            }
          },
        });
      } catch {
        try {
          receipt?.close();
        } catch {
          /* fixed private diagnostic below */
        }
        fail();
      }
    };
  } catch {
    fail();
  }
}

/** Connected protected-caller entry point. No replay input or proof flag is accepted. */
export function startPinnedOwnedComputerUseProcessCapture(input, load) {
  try {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) fail();
    const { capture, addonPath, addonSha256 } = input;
    if (
      !capture ||
      typeof capture !== 'object' ||
      Array.isArray(capture) ||
      Object.hasOwn(capture, 'retainOwnedProcess')
    )
      fail();
    const retainOwnedProcess = createPinnedOwnedProcessRetainer({ addonPath, addonSha256 }, load);
    return startOwnedComputerUseCapture({ ...capture, retainOwnedProcess });
  } catch {
    fail();
  }
}
