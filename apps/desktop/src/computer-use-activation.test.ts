import { describe, expect, it } from 'vitest';
import { createTrustedComputerUseUiActivationGate } from './computer-use-activation';
import { approvalActivationIntent, startActivationIntent } from './computer-use-activation-intent';

class ActivationElement {
  readonly dataset: Record<string, string>;

  constructor(kind: 'application' | 'start' | 'approval', intent?: string) {
    this.dataset = {
      computerUseActivation: kind,
      ...(intent === undefined ? {} : { computerUseIntent: intent }),
    };
  }

  closest(): ActivationElement {
    return this;
  }
}

describe('trusted Computer Use UI activation', () => {
  it('changes the bound intent when an authority-bearing choice changes', () => {
    const input = {
      taskId: 'task-1',
      profileId: 'profile-1',
      windowId: 'window-1',
      mode: 'supervised' as const,
      connectionId: 'connection-1',
      modelId: 'model-1',
      providerEgressConsent: true,
      providerEgressConsentBinding: { connectionId: 'connection-1', modelId: 'model-1' },
      remember: true,
      expectedPolicyEpoch: 1,
      expectedWindowRevision: 1,
      expectedProfileRevision: 1,
    };
    expect(startActivationIntent(input)).not.toBe(
      startActivationIntent({ ...input, mode: 'full_access_app' }),
    );
    expect(
      approvalActivationIntent({
        approvalId: 'approval-1',
        expectedRevision: 1,
        decision: 'deny',
        challenge: 'challenge',
      }),
    ).not.toBe(
      approvalActivationIntent({
        approvalId: 'approval-1',
        expectedRevision: 1,
        decision: 'allow_once',
        challenge: 'challenge',
      }),
    );
  });

  it('binds one trusted event to the exact privileged control kind', () => {
    const previous = globalThis.Element;
    Object.assign(globalThis, { Element: ActivationElement });
    try {
      const gate = createTrustedComputerUseUiActivationGate(() => 100);
      const accepted: string[] = [];
      expect(
        gate.observe(
          { isTrusted: true, target: new ActivationElement('application') as unknown as Element },
          (kind) => accepted.push(kind),
        ),
      ).toBe(true);
      expect(accepted).toEqual(['application']);
      expect(gate.consume('start')).toBeNull();
      expect(gate.consume('application')).toBeNull();
      gate.observe({
        isTrusted: true,
        target: new ActivationElement('application') as unknown as Element,
      });
      expect(gate.consume('application')).toEqual({ intent: null });
      expect(gate.consume('application')).toBeNull();
    } finally {
      Object.assign(globalThis, { Element: previous });
    }
  });

  it('ignores synthetic or expired events', () => {
    const previous = globalThis.Element;
    Object.assign(globalThis, { Element: ActivationElement });
    try {
      let now = 0;
      const gate = createTrustedComputerUseUiActivationGate(() => now);
      const target = new ActivationElement('start') as unknown as Element;
      expect(gate.observe({ isTrusted: false, target })).toBe(false);
      expect(gate.consume('start')).toBeNull();
      gate.observe({ isTrusted: true, target });
      now = 2_001;
      expect(gate.consume('start')).toBeNull();
    } finally {
      Object.assign(globalThis, { Element: previous });
    }
  });

  it('binds an approval decision to its own trusted control kind', () => {
    const previous = globalThis.Element;
    Object.assign(globalThis, { Element: ActivationElement });
    try {
      const gate = createTrustedComputerUseUiActivationGate(() => 100);
      expect(
        gate.observe({
          isTrusted: true,
          target: new ActivationElement('approval') as unknown as Element,
        }),
      ).toBe(true);
      expect(gate.consume('start')).toBeNull();
      gate.observe({
        isTrusted: true,
        target: new ActivationElement('approval', 'decision-bound') as unknown as Element,
      });
      expect(gate.consume('approval')).toEqual({ intent: 'decision-bound' });
    } finally {
      Object.assign(globalThis, { Element: previous });
    }
  });
});
