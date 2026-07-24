import { describe, expect, it } from 'vitest';
import { decideCableOutcome } from './cables';
import type { CableMessageLike } from './cables';

// Slice 6.4 item 4/7: pure state -> animation-phase decision. Covered as a standalone unit test
// because the mock Team backend acks synchronously in practice (the renderer only ever observes a
// message after it has already been fully delivered/acked), making the 'hold' branch essentially
// untestable end-to-end.

function message(partial: Partial<CableMessageLike>): CableMessageLike {
  return { state: 'dispatching', deliveryState: 'dispatched', ...partial };
}

describe('decideCableOutcome', () => {
  it('glows once deliveryState is acked', () => {
    expect(decideCableOutcome(message({ deliveryState: 'acked' }))).toBe('glow');
  });

  it('glows once state is acknowledged, even if deliveryState lags behind', () => {
    expect(
      decideCableOutcome(message({ state: 'acknowledged', deliveryState: 'dispatched' })),
    ).toBe('glow');
  });

  it('holds (no glow yet) while pre-ack: state dispatching/delivered', () => {
    expect(decideCableOutcome(message({ state: 'dispatching', deliveryState: null }))).toBe(
      'hold',
    );
    expect(decideCableOutcome(message({ state: 'delivered', deliveryState: null }))).toBe('hold');
  });

  it('holds while pre-ack: deliveryState persisted/dispatched', () => {
    expect(decideCableOutcome(message({ state: 'created', deliveryState: 'persisted' }))).toBe(
      'hold',
    );
    expect(decideCableOutcome(message({ state: 'created', deliveryState: 'dispatched' }))).toBe(
      'hold',
    );
  });

  it('flags danger on timedOut or failed deliveryState, never glow', () => {
    expect(decideCableOutcome(message({ deliveryState: 'timedOut' }))).toBe('danger');
    expect(decideCableOutcome(message({ deliveryState: 'failed' }))).toBe('danger');
  });

  it('danger takes priority even if state looks otherwise ambiguous', () => {
    expect(
      decideCableOutcome(message({ state: 'delivered', deliveryState: 'timedOut' })),
    ).toBe('danger');
  });
});
