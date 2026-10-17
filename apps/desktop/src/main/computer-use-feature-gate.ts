import type { ComputerUseSettings } from '@sprint-coder/contracts';
import { computerUseDesktopV1Enabled, type FeatureFlagEnvironment } from './feature-flags';

/**
 * The user-facing gate for desktop Computer Use (beta).
 *
 * The persisted setting is the switch. `SPRINT_CODER_COMPUTER_USE_DESKTOP_V1=1` stays a forced-on
 * override for CI and acceptance runs; it is read once, because the environment of a running
 * process does not change.
 *
 * The signed native part is loaded once, at startup, and only when the feature was requested then.
 * So turning the setting on at runtime cannot open the gate in the same process: it reports
 * `restartRequired` instead, and the gate opens after a restart. Turning it off closes the gate at
 * once, whatever was loaded.
 */
export type ComputerUseFeatureGate = Readonly<{
  /** Main's feature gate: requested now and the native part was loaded for it at startup. */
  enabled(): boolean;
  settings(): ComputerUseSettings;
}>;

export type ComputerUseFeatureGateOptions = Readonly<{
  /** The persisted user choice, read on every call. */
  setting: () => boolean;
  environment?: FeatureFlagEnvironment;
  /**
   * Whether startup asked the native loader to load the feature. Omitted means the caller did not
   * gate loading on the setting (unit and embedded routers), so only the request decides.
   */
  loadedAtStartup?: boolean;
  /** Whether the native part is usable in this build; null when that is not known yet. */
  buildSupported?: () => boolean | null;
}>;

/** What startup reads before it loads the native part: the env override or the saved setting. */
export function computerUseRequestedAtStartup(
  setting: boolean,
  environment: FeatureFlagEnvironment = process.env,
): boolean {
  return computerUseDesktopV1Enabled(environment) || setting;
}

export function createComputerUseFeatureGate(
  options: ComputerUseFeatureGateOptions,
): ComputerUseFeatureGate {
  const forcedByEnvironment = computerUseDesktopV1Enabled(options.environment ?? process.env);
  const loadedAtStartup = options.loadedAtStartup ?? true;
  const requested = (): boolean => forcedByEnvironment || options.setting();
  return Object.freeze({
    enabled: () => loadedAtStartup && requested(),
    settings: (): ComputerUseSettings => {
      const enabled = options.setting();
      const wanted = forcedByEnvironment || enabled;
      return {
        enabled,
        forcedByEnvironment,
        effective: loadedAtStartup && wanted,
        restartRequired: !loadedAtStartup && wanted,
        buildSupported: options.buildSupported?.() ?? null,
      };
    },
  });
}
