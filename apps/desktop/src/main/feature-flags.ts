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

/**
 * The agent-driven target tools (ADR v2 §9).
 *
 * Two gates, both exact opt-ins. `SPRINT_CODER_COMPUTER_USE_DESKTOP_V1` stays the master switch for
 * the whole feature — the package, signing, and release scans are tied to that name, so its meaning
 * must not change — and this flag adds the v2 tool surface on top of it. Off, the tools are never
 * registered at all, so the model does not see a definition it could call; the default is off.
 */
export function computerUseAgentDrivenV2Enabled(
  env: FeatureFlagEnvironment = process.env,
): boolean {
  return (
    computerUseDesktopV1Enabled(env) && env['SPRINT_CODER_COMPUTER_USE_AGENT_DRIVEN_V2'] === '1'
  );
}
