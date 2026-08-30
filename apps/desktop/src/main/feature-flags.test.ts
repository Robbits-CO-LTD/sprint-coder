import { describe, expect, it } from 'vitest';
import {
  computerUseDesktopV1Enabled,
  multiProviderModelPickerV2Enabled,
  projectMultiFolderUxEnabled,
  settingsWorkspaceV2Enabled,
} from './feature-flags';

describe('computerUseDesktopV1Enabled', () => {
  it('requires the exact privileged-preview opt-in', () => {
    expect(computerUseDesktopV1Enabled({})).toBe(false);
    expect(computerUseDesktopV1Enabled({ SPRINT_CODER_COMPUTER_USE_DESKTOP_V1: '0' })).toBe(false);
    expect(computerUseDesktopV1Enabled({ SPRINT_CODER_COMPUTER_USE_DESKTOP_V1: 'true' })).toBe(
      false,
    );
    expect(computerUseDesktopV1Enabled({ SPRINT_CODER_COMPUTER_USE_DESKTOP_V1: '1' })).toBe(true);
  });
});

describe('multiProviderModelPickerV2Enabled', () => {
  it('enables the V2 picker by default', () => {
    expect(multiProviderModelPickerV2Enabled({})).toBe(true);
  });

  it('keeps an explicit rollback to the legacy picker', () => {
    expect(
      multiProviderModelPickerV2Enabled({
        SPRINT_CODER_MULTI_PROVIDER_MODEL_PICKER_V2: '0',
      }),
    ).toBe(false);
  });

  it('does not interpret unrelated values as the rollback switch', () => {
    expect(
      multiProviderModelPickerV2Enabled({
        SPRINT_CODER_MULTI_PROVIDER_MODEL_PICKER_V2: '1',
      }),
    ).toBe(true);
  });
});

describe('settingsWorkspaceV2Enabled', () => {
  it('enables the workspace by default and keeps an explicit legacy rollback', () => {
    expect(settingsWorkspaceV2Enabled({})).toBe(true);
    expect(settingsWorkspaceV2Enabled({ SPRINT_CODER_SETTINGS_WORKSPACE_V2: '0' })).toBe(false);
    expect(settingsWorkspaceV2Enabled({ SPRINT_CODER_SETTINGS_WORKSPACE_V2: '1' })).toBe(true);
  });
});

describe('projectMultiFolderUxEnabled', () => {
  it('enables the completed E2 UX by default and keeps an explicit rollback', () => {
    expect(projectMultiFolderUxEnabled({})).toBe(true);
    expect(projectMultiFolderUxEnabled({ SPRINT_CODER_PROJECT_MULTI_FOLDER_UX: '0' })).toBe(false);
    expect(projectMultiFolderUxEnabled({ SPRINT_CODER_PROJECT_MULTI_FOLDER_UX: '1' })).toBe(true);
  });
});
