import { describe, expect, it } from 'vitest';
import { multiProviderModelPickerV2Enabled, settingsWorkspaceV2Enabled } from './feature-flags';

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
