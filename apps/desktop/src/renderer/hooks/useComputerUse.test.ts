import { describe, expect, it, vi } from 'vitest';
import type { ComputerAppProfile, ComputerUseSessionStatus } from '@sprint-coder/contracts';
import {
  computerUseCapabilitiesReady,
  computerUseEntryVisible,
  computerUseModeAdjustmentNotice,
  computerUseTerminalNotice,
  computerUseWindowViews,
  profileView,
  subscribeComputerUseStatusWithReplay,
  useComputerUse,
} from './useComputerUse';

const profile = {
  id: 'profile-1',
  label: 'TextEdit',
  identity: {
    platform: 'darwin',
    identityDigest: 'a'.repeat(64),
    displayName: 'TextEdit',
    bundleId: 'com.apple.TextEdit',
    policyLanguage: 'en',
    maximumMode: 'full_access_app',
  },
  mode: 'full_access_app',
  connectionId: 'connection-1',
  modelId: 'vision-1',
  providerEgressConsent: true,
  remember: true,
  profileRevision: 3,
  policyLanguage: 'en',
  maximumMode: 'full_access_app',
  createdAt: '2026-08-29T00:00:00.000Z',
  updatedAt: '2026-08-29T01:00:00.000Z',
} satisfies ComputerAppProfile;

describe('Computer Use renderer projection', () => {
  it('makes a Main-enforced mode downgrade explicit to the user', () => {
    expect(computerUseModeAdjustmentNotice('full_access_app', 'supervised')).toContain('確認あり');
    expect(computerUseModeAdjustmentNotice('supervised', 'observe_only')).toContain('見るだけ');
    expect(computerUseModeAdjustmentNotice('supervised', 'supervised')).toBeNull();
  });

  it('shows only a fully gated package entry and routes missing OS capabilities to recovery', () => {
    const permissionRequired = {
      platform: 'darwin' as const,
      state: 'native_unavailable' as const,
      featureEnabled: true,
      packageReady: true,
      handshakeReady: true,
      observe: false,
      control: false,
      available: false,
      reasonCode: 'screen_recording_permission_required',
      manifestDigest: 'a'.repeat(64),
    };
    expect(computerUseEntryVisible(permissionRequired)).toBe(true);
    expect(computerUseCapabilitiesReady(permissionRequired)).toBe(false);
    expect(
      computerUseCapabilitiesReady({
        ...permissionRequired,
        observe: true,
        available: true,
      }),
    ).toBe(true);
    expect(computerUseEntryVisible({ ...permissionRequired, packageReady: false })).toBe(false);
    expect(computerUseEntryVisible({ ...permissionRequired, featureEnabled: false })).toBe(false);
    expect(computerUseEntryVisible({ ...permissionRequired, handshakeReady: false })).toBe(false);
  });

  it('subscribes before replaying status and cleans up both delivery paths', async () => {
    const calls: string[] = [];
    const status: ComputerUseSessionStatus = {
      sessionId: 'session-1',
      taskId: 'task-1',
      profileId: 'profile-1',
      windowId: 'window-1',
      connectionId: 'connection-1',
      modelId: 'vision-1',
      appIdentityDigest: 'a'.repeat(64),
      windowIdentityDigest: 'b'.repeat(64),
      profileRevision: 1,
      mode: 'full_access_app' as const,
      maximumMode: 'full_access_app' as const,
      policyLanguage: 'en',
      state: 'observing' as const,
      statusRevision: 1,
      policyEpoch: 1,
      observationRevision: 1,
      round: 1,
      maxRounds: 25 as const,
      startedAt: '2026-08-29T00:00:00.000Z',
      expiresAt: '2026-08-29T01:00:00.000Z',
      lastObservationAt: '2026-08-29T00:00:01.000Z',
      stopReason: null,
      pendingApproval: null,
    };
    const push: { current: ((value: ComputerUseSessionStatus) => void) | null } = { current: null };
    const unsubscribe = vi.fn();
    let resolveQuery!: (value: typeof status) => void;
    const api = {
      subscribeStatus: vi.fn(
        (_sessionId: string, listener: (value: ComputerUseSessionStatus) => void) => {
          calls.push('subscribe');
          push.current = listener;
          return unsubscribe;
        },
      ),
      getStatus: vi.fn(() => {
        calls.push('query');
        return new Promise<ComputerUseSessionStatus>((resolve) => {
          resolveQuery = resolve;
        });
      }),
    };
    const listener = vi.fn();

    const cleanup = subscribeComputerUseStatusWithReplay(api, 'session-1', listener);
    push.current?.({ ...status, state: 'starting', statusRevision: 0 });
    push.current?.({ ...status, state: 'planning', statusRevision: 2 });
    expect(listener).not.toHaveBeenCalled();
    resolveQuery(status);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(['subscribe', 'query']);
    expect(listener.mock.calls.map(([value]) => value.state)).toEqual(['observing', 'planning']);

    cleanup();
    expect(unsubscribe).toHaveBeenCalledOnce();
    push.current?.(status);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('keeps profile revision and a safe identity label', () => {
    expect(profileView(profile)).toMatchObject({
      id: 'profile-1',
      revision: 3,
      identityLabel: `TextEdit · com.apple.TextEdit · ID ${'a'.repeat(64)}`,
    });
  });

  it('binds every window view to the refreshed Main profile revision', () => {
    expect(
      computerUseWindowViews(
        [
          {
            windowId: 'window-1',
            appIdentityDigest: 'a'.repeat(64),
            windowIdentityDigest: 'b'.repeat(64),
            title: 'Untitled',
            bounds: { x: 0, y: 0, width: 800, height: 600 },
            focused: true,
            eligible: true,
            ownerKind: 'application',
            modal: false,
            revision: 7,
            policyLanguage: 'en',
            maximumMode: 'full_access_app',
          },
        ],
        5,
      ),
    ).toEqual([expect.objectContaining({ id: 'window-1', revision: 7, profileRevision: 5 })]);
  });

  it('keeps the freshly issued Quick Start token synchronous across the React state boundary', () => {
    const source = useComputerUse.toString();
    expect(source).toContain('windowCandidatesRef.current = candidateMap');
    expect(source).toContain('windowCandidatesRef.current.get(input.windowCandidateId)');
  });

  it('keeps an actionable notice after an asynchronous session failure', () => {
    expect(
      computerUseTerminalNotice({
        state: 'stopped',
        stopReason: 'error',
      } as ComputerUseSessionStatus),
    ).toContain('再度開始');
    expect(
      computerUseTerminalNotice({
        state: 'stopped',
        stopReason: 'user_stop',
      } as ComputerUseSessionStatus),
    ).toBeNull();
  });
});
