import type { ComputerUseOsPermission } from '@sprint-coder/contracts';
import type { ComputerUseNativeProbe } from './computer-use-native-types';

/**
 * Pure facts derived from a native probe response.
 *
 * This module is deliberately a leaf: it imports nothing but types, so both the signed loader
 * (`computer-use-native.ts`) and the Main adapter (`computer-use-native-host.ts`) can depend on it
 * without creating a runtime import cycle. The host must never import a runtime value from the
 * loader — the loader reaches the Windows transport, which reads the host's close budgets at module
 * evaluation time, and a cycle leaves those constants uninitialised (`NaN` under the test
 * transform, a temporal-dead-zone `ReferenceError` in the bundled Main process).
 */

/**
 * The exact `reason` values the two native probes emit when they answer `available: false`
 * (`computer_use_macos.mm` `Probe`, `computer_use_windows_host.cc` `ProbeJson`). Nothing else is
 * accepted: native is a trusted second layer, but its strings are not forwarded verbatim to the
 * renderer, so an unexpected or oversized reason degrades to `NATIVE_PROBE_UNAVAILABLE` exactly as
 * before. Keep this list in sync with those two probes when either grows a reason.
 */
export const COMPUTER_USE_NATIVE_PROBE_REASONS = Object.freeze([
  'ACCESSIBILITY_PERMISSION_REQUIRED',
  'SCREEN_RECORDING_PERMISSION_REQUIRED',
  'SCREEN_CAPTURE_KIT_UNAVAILABLE',
  'WINDOWS_BUILD_UNSUPPORTED',
  'UI_AUTOMATION_UNAVAILABLE',
  'GRAPHICS_CAPTURE_UNAVAILABLE',
] as const);
export type ComputerUseNativeProbeReason = (typeof COMPUTER_USE_NATIVE_PROBE_REASONS)[number];

export function knownNativeProbeReason(value: unknown): ComputerUseNativeProbeReason | null {
  return typeof value === 'string' &&
    (COMPUTER_USE_NATIVE_PROBE_REASONS as readonly string[]).includes(value)
    ? (value as ComputerUseNativeProbeReason)
    : null;
}

/** A native capability fact is granted only when it is literally `true`. */
function nativeCapabilityGranted(capabilities: unknown, key: string): boolean {
  if (typeof capabilities !== 'object' || capabilities === null || Array.isArray(capabilities))
    return false;
  return (capabilities as Record<string, unknown>)[key] === true;
}

export function nativeProbeCapabilities(value: unknown): ComputerUseNativeProbe['capabilities'] {
  return {
    observe: false,
    control: false,
    accessibility: nativeCapabilityGranted(value, 'accessibility'),
    screenCapture: nativeCapabilityGranted(value, 'screenCapture'),
    screenCaptureKit: nativeCapabilityGranted(value, 'screenCaptureKit'),
  };
}

/**
 * The reasons for which the per-capability facts are meaningful. Any other refusal — including an
 * unknown reason that degraded to `NATIVE_PROBE_UNAVAILABLE` — measured nothing, so it must not
 * claim that a specific OS permission is missing.
 */
const MACOS_PERMISSION_PROBE_REASONS: ReadonlySet<string> = new Set<ComputerUseNativeProbeReason>([
  'ACCESSIBILITY_PERMISSION_REQUIRED',
  'SCREEN_RECORDING_PERMISSION_REQUIRED',
  'SCREEN_CAPTURE_KIT_UNAVAILABLE',
]);

/**
 * Which OS permissions the user still has to grant. This only describes an already-closed gate; it
 * never opens one. An empty list means "nothing nameable", not "everything is fine".
 */
export function computerUseMissingNativePermissions(
  probe: ComputerUseNativeProbe,
): readonly ComputerUseOsPermission[] {
  if (probe.available || !MACOS_PERMISSION_PROBE_REASONS.has(probe.reason)) return [];
  const missing: ComputerUseOsPermission[] = [];
  if (probe.capabilities.accessibility !== true) missing.push('accessibility');
  if (probe.capabilities.screenCapture !== true) missing.push('screen_recording');
  return Object.freeze(missing);
}
