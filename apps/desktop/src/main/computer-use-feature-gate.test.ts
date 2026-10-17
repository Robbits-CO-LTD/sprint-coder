import { describe, expect, it } from 'vitest';
import {
  computerUseRequestedAtStartup,
  createComputerUseFeatureGate,
} from './computer-use-feature-gate';

const FLAG = 'SPRINT_CODER_COMPUTER_USE_DESKTOP_V1';

describe('Computer Use (beta) feature gate', () => {
  it('is closed by default and opens with the saved setting', () => {
    let setting = false;
    const gate = createComputerUseFeatureGate({
      setting: () => setting,
      environment: {},
      loadedAtStartup: true,
      buildSupported: () => true,
    });
    expect(gate.enabled()).toBe(false);
    expect(gate.settings()).toEqual({
      enabled: false,
      forcedByEnvironment: false,
      effective: false,
      restartRequired: false,
      buildSupported: true,
    });
    setting = true;
    expect(gate.enabled()).toBe(true);
    expect(gate.settings()).toMatchObject({ enabled: true, effective: true });
    // Off closes at once, whatever was loaded at startup.
    setting = false;
    expect(gate.enabled()).toBe(false);
  });

  it('reports a restart instead of opening when the native part was not loaded at startup', () => {
    let setting = false;
    const gate = createComputerUseFeatureGate({
      setting: () => setting,
      environment: {},
      loadedAtStartup: false,
      buildSupported: () => null,
    });
    setting = true;
    expect(gate.enabled()).toBe(false);
    expect(gate.settings()).toEqual({
      enabled: true,
      forcedByEnvironment: false,
      effective: false,
      restartRequired: true,
      buildSupported: null,
    });
  });

  it('keeps the exact env value as a forced-on override', () => {
    const gate = createComputerUseFeatureGate({
      setting: () => false,
      environment: { [FLAG]: '1' },
      loadedAtStartup: true,
    });
    expect(gate.enabled()).toBe(true);
    expect(gate.settings()).toMatchObject({
      enabled: false,
      forcedByEnvironment: true,
      effective: true,
      restartRequired: false,
    });
    for (const value of ['0', 'true', '', undefined])
      expect(
        createComputerUseFeatureGate({
          setting: () => false,
          environment: { [FLAG]: value },
          loadedAtStartup: true,
        }).enabled(),
      ).toBe(false);
  });

  it('asks startup to load the native part for the setting or the env override only', () => {
    expect(computerUseRequestedAtStartup(false, {})).toBe(false);
    expect(computerUseRequestedAtStartup(true, {})).toBe(true);
    expect(computerUseRequestedAtStartup(false, { [FLAG]: '1' })).toBe(true);
    expect(computerUseRequestedAtStartup(false, { [FLAG]: 'yes' })).toBe(false);
  });
});
