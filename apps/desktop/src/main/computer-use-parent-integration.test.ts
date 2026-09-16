import { describe, expect, it, vi } from 'vitest';
import {
  computerUseNativeCloseReceiptSchema,
  computerUseNativeInputReceiptSchema,
} from '@sprint-coder/contracts';
import {
  ComputerUseController,
  type ComputerUseControllerPersistence,
  type ComputerUseStartRequest,
} from './computer-use-controller';
import {
  COMPUTER_USE_NATIVE_FEATURE_FLAG,
  evaluateComputerUseNativeGate,
  loadComputerUseNative,
  type ComputerUseNativeBinding,
} from './computer-use-native';
import { createComputerUseNativeHost } from './computer-use-native-host';
import { computerUseDesktopV1Enabled } from './feature-flags';

// Synthetic native metadata tests the Main integration only; it is never signed-device evidence.
function nativeFixture(platform: 'darwin' | 'win32', signed = true, apiVersion: 1 | 2 = 2) {
  const receipt = (input: unknown) => {
    const { sessionId, cancelEpoch } = computerUseNativeInputReceiptSchema
      .pick({ sessionId: true, cancelEpoch: true })
      .passthrough()
      .parse(input);
    return { sessionId, cancelEpoch, inputAttemptCount: 0, drained: true };
  };
  const addon = {
    probe: vi.fn(),
    pickApplication: vi.fn(),
    listWindows: vi.fn(),
    startSession: vi.fn(),
    observe: vi.fn(),
    dispatch: vi.fn(),
    cancel: vi.fn((input: unknown) => ({ ...receipt(input), result: 'canceled' })),
    close: vi.fn((input: unknown) =>
      computerUseNativeCloseReceiptSchema.parse({ ...receipt(input), result: 'closed' }),
    ),
  };
  const manifest: ComputerUseNativeBinding['manifest'] = {
    version: 1,
    sourceCommit: 'a'.repeat(40),
    platform,
    architecture: platform === 'darwin' ? 'arm64' : 'x64',
    protocolVersion: 1,
    apiVersion,
    nativeVersion: 'parent-integration-test',
    moduleDigest: 'b'.repeat(64),
    binaryDigest: 'b'.repeat(64),
    signerDigest: signed ? 'c'.repeat(64) : null,
    capabilities: ['observe', 'capture', 'accessibility', 'input'],
  };
  const artifactPath = '/synthetic/Resources/native-artifact';
  const probe = evaluateComputerUseNativeGate({
    featureFlag: true,
    packaged: true,
    platform,
    manifest,
    artifactDigest: manifest.binaryDigest,
    artifactPath,
    probe: {
      available: true,
      protocolVersion: 1,
      apiVersion,
      sourceCommit: manifest.sourceCommit,
      backend: 'synthetic-parent-integration',
    },
  });
  return { binding: { manifest, artifactPath, probe, addon }, addon };
}

function controllerFor(binding: ComputerUseNativeBinding, enabled?: () => boolean) {
  const unexpectedPersistence = vi.fn((): never => {
    throw new Error('Unavailable Computer Use must stop before persistence');
  });
  const persistence: ComputerUseControllerPersistence = {
    listComputerAppProfiles: unexpectedPersistence,
    getComputerAppProfile: unexpectedPersistence,
    createComputerAppProfile: unexpectedPersistence,
    updateComputerAppProfile: unexpectedPersistence,
    removeComputerAppProfile: unexpectedPersistence,
    recordComputerActionAudit: unexpectedPersistence,
    completeComputerActionAudit: unexpectedPersistence,
    listComputerActionAudits: unexpectedPersistence,
    getActiveTurnId: unexpectedPersistence,
    getPermissionPolicy: unexpectedPersistence,
  };
  const native = createComputerUseNativeHost(binding, binding.manifest.platform, {
    windowsPhysicalBoundsToDip: (bounds) => bounds,
  });
  const plannerFactory = vi.fn((): never => {
    throw new Error('Unavailable Computer Use must stop before Provider access');
  });
  const controller = new ComputerUseController({
    persistence,
    native,
    plannerFactory,
    repositionEmergencyStop: () => false,
    ...(enabled === undefined ? {} : { featureEnabled: enabled }),
  });
  return { controller, native, plannerFactory, unexpectedPersistence };
}

const start: ComputerUseStartRequest = {
  taskId: 'task-parent-test',
  profileId: 'profile-parent-test',
  windowId: 'window-parent-test',
  mode: 'full_access_app',
  connectionId: 'connection-parent-test',
  modelId: 'model-parent-test',
  providerEgressConsent: true,
  providerEgressConsentBinding: {
    connectionId: 'connection-parent-test',
    modelId: 'model-parent-test',
  },
  remember: true,
  expectedPolicyEpoch: 0,
  expectedWindowRevision: 1,
  expectedProfileRevision: 1,
};

describe('Issue #333 parent availability integration', () => {
  it.each(['darwin', 'win32'] as const)(
    'rejects a signed API 1 %s helper even with explicit opt-in',
    async (platform) => {
      const fixture = nativeFixture(platform, true, 1);
      const { controller, native, plannerFactory, unexpectedPersistence } = controllerFor(
        fixture.binding,
        () => true,
      );
      expect(fixture.binding.probe).toMatchObject({
        available: false,
        reason: 'HANDSHAKE_INVALID',
      });
      expect(native.availability()).toMatchObject({
        state: 'handshake_failed',
        handshakeReady: false,
        available: false,
      });
      expect(controller.availability()).toMatchObject({
        featureEnabled: true,
        available: false,
        observe: false,
        control: false,
      });
      await expect(controller.start(start)).rejects.toThrow('native boundary is unavailable');
      expect(plannerFactory).not.toHaveBeenCalled();
      expect(unexpectedPersistence).not.toHaveBeenCalled();
      for (const method of Object.values(fixture.addon)) expect(method).not.toHaveBeenCalled();
      await controller.dispose();
    },
  );

  it.each(['darwin', 'win32'] as const)(
    'keeps %s native readiness behind the default-OFF controller gate',
    async (platform) => {
      const fixture = nativeFixture(platform);
      const { controller, native, plannerFactory, unexpectedPersistence } = controllerFor(
        fixture.binding,
      );
      expect(native.availability().available).toBe(true);
      expect(controller.availability()).toMatchObject({
        state: 'feature_disabled',
        featureEnabled: false,
        available: false,
        observe: false,
        control: false,
      });
      await expect(controller.start(start)).rejects.toThrow('native boundary is unavailable');
      expect(plannerFactory).not.toHaveBeenCalled();
      expect(unexpectedPersistence).not.toHaveBeenCalled();
      for (const method of Object.values(fixture.addon)) expect(method).not.toHaveBeenCalled();
      await controller.dispose();
    },
  );

  it.each(['darwin', 'win32'] as const)(
    'does not promote unsigned/ad-hoc %s to usable even with explicit opt-in',
    async (platform) => {
      const fixture = nativeFixture(platform, false);
      const { controller, plannerFactory, unexpectedPersistence } = controllerFor(
        fixture.binding,
        () => true,
      );
      expect(fixture.binding.probe.reason).toBe(
        platform === 'darwin' ? 'MACOS_SIGNATURE_REQUIRED' : 'WINDOWS_SIGNATURE_REQUIRED',
      );
      expect(controller.availability()).toMatchObject({
        state: 'unsigned_package',
        featureEnabled: true,
        packageReady: false,
        available: false,
        observe: false,
        control: false,
      });
      await expect(controller.start(start)).rejects.toThrow('native boundary is unavailable');
      expect(plannerFactory).not.toHaveBeenCalled();
      expect(unexpectedPersistence).not.toHaveBeenCalled();
      for (const method of Object.values(fixture.addon)) expect(method).not.toHaveBeenCalled();
      await controller.dispose();
    },
  );

  it.each([undefined, '', '0', 'true', 'yes', '01', '1 '])(
    'uses the same exact opt-in rule through the loader and Main (%s)',
    async (value) => {
      const environment = { [COMPUTER_USE_NATIVE_FEATURE_FLAG]: value };
      const requireAddon = vi.fn();
      const probeHelper = vi.fn();
      const binding = loadComputerUseNative({ environment, requireAddon, probeHelper });
      const { controller } = controllerFor(binding, () => computerUseDesktopV1Enabled(environment));
      expect(binding.probe.reason).toBe('FEATURE_FLAG_DISABLED');
      expect(controller.availability().available).toBe(false);
      expect(requireAddon).not.toHaveBeenCalled();
      expect(probeHelper).not.toHaveBeenCalled();
      await controller.dispose();
    },
  );
});
