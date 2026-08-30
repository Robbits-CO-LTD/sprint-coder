import { createHash } from 'node:crypto';
import type { ComputerUseNativeManifest } from '@sprint-coder/contracts';

export type ComputerUseNativeCompiledPin = Readonly<{
  version: 1;
  sourceCommit: string;
  platform: 'darwin' | 'win32';
  architecture: string;
  artifactDigest: string;
  manifestDigest: string;
}>;

export function computerUseNativeManifestDigest(manifest: ComputerUseNativeManifest): string {
  const canonical = JSON.stringify([
    manifest.version,
    manifest.sourceCommit,
    manifest.platform,
    manifest.architecture,
    manifest.protocolVersion,
    manifest.apiVersion,
    manifest.nativeVersion,
    manifest.moduleDigest,
    manifest.binaryDigest,
    manifest.signerDigest,
    [...manifest.capabilities].sort(),
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function computerUseNativeCompiledPin(
  manifest: ComputerUseNativeManifest,
): ComputerUseNativeCompiledPin {
  if (manifest.platform !== 'darwin' && manifest.platform !== 'win32')
    throw new Error('Computer Use native compile pin platform is unsupported');
  return Object.freeze({
    version: 1,
    sourceCommit: manifest.sourceCommit,
    platform: manifest.platform,
    architecture: manifest.architecture,
    artifactDigest: manifest.platform === 'darwin' ? manifest.moduleDigest : manifest.binaryDigest,
    manifestDigest: computerUseNativeManifestDigest(manifest),
  });
}

export function parseComputerUseNativeCompiledPin(value: unknown): ComputerUseNativeCompiledPin {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Computer Use native compile pin is unavailable');
  const pin = value as Record<string, unknown>;
  if (
    pin['version'] !== 1 ||
    (pin['platform'] !== 'darwin' && pin['platform'] !== 'win32') ||
    typeof pin['sourceCommit'] !== 'string' ||
    !/^[0-9a-f]{40}$/u.test(pin['sourceCommit']) ||
    typeof pin['architecture'] !== 'string' ||
    pin['architecture'].length === 0 ||
    pin['architecture'].length > 32 ||
    typeof pin['artifactDigest'] !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(pin['artifactDigest']) ||
    typeof pin['manifestDigest'] !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(pin['manifestDigest'])
  )
    throw new Error('Computer Use native compile pin is invalid');
  return Object.freeze({
    version: 1,
    sourceCommit: pin['sourceCommit'],
    platform: pin['platform'],
    architecture: pin['architecture'],
    artifactDigest: pin['artifactDigest'],
    manifestDigest: pin['manifestDigest'],
  });
}

export function computerUseNativeCompiledPinMatches(
  pin: ComputerUseNativeCompiledPin,
  manifest: ComputerUseNativeManifest,
  artifactDigest: string,
): boolean {
  return (
    pin.sourceCommit === manifest.sourceCommit &&
    pin.platform === manifest.platform &&
    pin.architecture === manifest.architecture &&
    pin.artifactDigest === artifactDigest &&
    pin.artifactDigest ===
      (manifest.platform === 'darwin' ? manifest.moduleDigest : manifest.binaryDigest) &&
    pin.manifestDigest === computerUseNativeManifestDigest(manifest)
  );
}
