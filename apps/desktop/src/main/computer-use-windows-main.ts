import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { ApprovalRoundTripIdentity } from './computer-use-approval-round-trip';
import { computerUseNativeManifestSchema } from '@sprint-coder/contracts';
import {
  computerUseNativeManifestDigest,
  parseComputerUseNativeCompiledPin,
  verifyWindowsMainAddonDigest,
} from './computer-use-native-provenance';

export type WindowsMainAddon = Readonly<{
  readMainIdentity(): unknown;
  createHelperPermit(pid: number): unknown;
}>;

// Loaded only behind the internal N9 gate; verify the bytes before native code runs.
export function loadWindowsMainAddon(helperPath: string): WindowsMainAddon {
  const directory = dirname(helperPath);
  const manifest = computerUseNativeManifestSchema.parse(
    JSON.parse(
      readFileSync(join(directory, 'computer-use-native.manifest.json'), 'utf8'),
    ) as unknown,
  );
  if (typeof __SPRINT_CODER_COMPUTER_USE_NATIVE_PIN__ === 'undefined')
    throw new Error('Computer Use native compile pin is unavailable');
  const pin = parseComputerUseNativeCompiledPin(__SPRINT_CODER_COMPUTER_USE_NATIVE_PIN__);
  if (pin.manifestDigest !== computerUseNativeManifestDigest(manifest))
    throw new Error('Windows Main addon provenance mismatch');
  const path = verifyWindowsMainAddonDigest(directory, manifest);
  // Residual TOCTOU: the file can change between digest verification and require.
  // Closing this gap requires a native loading boundary; the gate and pin do not eliminate it.
  const value: unknown = createRequire(__filename)(path);
  if (
    typeof value !== 'object' ||
    value === null ||
    !('readMainIdentity' in value) ||
    typeof value.readMainIdentity !== 'function' ||
    !('createHelperPermit' in value) ||
    typeof value.createHelperPermit !== 'function'
  )
    throw new Error('Windows Main addon unavailable');
  const { readMainIdentity, createHelperPermit } = value;
  return {
    readMainIdentity: () => readMainIdentity(),
    createHelperPermit: (pid) => createHelperPermit(pid),
  };
}

let mainImage: Readonly<{ path: string; digest: string }> | undefined;

export function readWindowsMainIdentity(addon: WindowsMainAddon): ApprovalRoundTripIdentity {
  const value = addon.readMainIdentity();
  if (
    typeof value !== 'object' ||
    value === null ||
    !('mainPid' in value) ||
    value.mainPid !== process.pid ||
    !('mainProcessStartTime' in value) ||
    typeof value.mainProcessStartTime !== 'string' ||
    !/^[1-9][0-9]{0,19}$/u.test(value.mainProcessStartTime) ||
    BigInt(value.mainProcessStartTime) > 0xffff_ffff_ffff_ffffn ||
    !('imagePath' in value) ||
    typeof value.imagePath !== 'string' ||
    !value.imagePath
  )
    throw new Error('Windows Main identity unavailable');
  if (mainImage !== undefined && mainImage.path !== value.imagePath)
    throw new Error('Windows Main image changed');
  // The running executable is immutable. Process facts above are still validated on every call.
  mainImage ??= {
    path: value.imagePath,
    digest: createHash('sha256').update(readFileSync(value.imagePath)).digest('hex'),
  };
  return {
    mainPid: process.pid,
    mainProcessStartTime: value.mainProcessStartTime,
    mainImageIdentity: mainImage.digest,
  };
}

export function allowWindowsHelperForeground(
  addon: WindowsMainAddon,
  helperPid: number | undefined,
  requestedPid: number,
): boolean {
  if (
    !Number.isInteger(helperPid) ||
    helperPid === undefined ||
    helperPid <= 0 ||
    helperPid >= 0xffff_ffff ||
    requestedPid !== helperPid
  )
    return false;
  try {
    const permit = addon.createHelperPermit(helperPid);
    return typeof permit === 'function' && permit(requestedPid) === true;
  } catch {
    return false;
  }
}
