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

/** Kept off until the Team status/resume UI ships in E2. */
export function projectMultiFolderUxEnabled(env: FeatureFlagEnvironment = process.env): boolean {
  return env['SPRINT_CODER_PROJECT_MULTI_FOLDER_UX'] === '1';
}
