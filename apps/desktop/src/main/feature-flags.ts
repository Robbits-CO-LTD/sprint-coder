export type FeatureFlagEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * The V2 picker is the default from UI U3 onward. Keeping the old picker mounted behind an
 * explicit `0` preserves the release rollback path until U4 removes the legacy implementation.
 */
export function multiProviderModelPickerV2Enabled(
  env: FeatureFlagEnvironment = process.env,
): boolean {
  return env['SPRINT_CODER_MULTI_PROVIDER_MODEL_PICKER_V2'] !== '0';
}

export function settingsWorkspaceV2Enabled(env: FeatureFlagEnvironment = process.env): boolean {
  return env['SPRINT_CODER_SETTINGS_WORKSPACE_V2'] !== '0';
}

export function projectMultiFolderUxEnabled(env: FeatureFlagEnvironment = process.env): boolean {
  return env['SPRINT_CODER_PROJECT_MULTI_FOLDER_UX'] !== '0';
}

/**
 * Desktop Computer Use is a privileged preview, not a rollout switch.  Only an exact opt-in may
 * make Main probe the separately signed native boundary; every other value stays fail-closed.
 */
export function computerUseDesktopV1Enabled(env: FeatureFlagEnvironment = process.env): boolean {
  return env['SPRINT_CODER_COMPUTER_USE_DESKTOP_V1'] === '1';
}
