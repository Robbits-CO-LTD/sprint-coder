import { describe, expect, it } from 'vitest';
import {
  computerUseNativeDiscoveryResultSchema,
  computerUseNativeDiscoveryStopReceiptSchema,
} from './index';

describe('private native discovery evidence', () => {
  const receipt = { discoveryId: 'host:1', drained: true, launchAttemptCount: 1 };

  it('keeps query completion, query non-admission and Stop evidence distinct', () => {
    const completed = { ...receipt, result: 'completed', windows: [] };
    const stopped = { ...receipt, result: 'stopped' };
    const refused = {
      ...receipt,
      result: 'not_admitted',
      launchAttemptCount: 0,
      reason: 'discovery_capacity',
    };
    expect(computerUseNativeDiscoveryResultSchema.parse(completed)).toEqual(completed);
    expect(computerUseNativeDiscoveryResultSchema.parse(refused)).toEqual(refused);
    expect(computerUseNativeDiscoveryStopReceiptSchema.parse(stopped)).toEqual(stopped);
    expect(computerUseNativeDiscoveryStopReceiptSchema.safeParse(completed).success).toBe(false);
    expect(computerUseNativeDiscoveryStopReceiptSchema.safeParse(refused).success).toBe(false);
    expect(computerUseNativeDiscoveryResultSchema.safeParse(stopped).success).toBe(false);
    expect(
      computerUseNativeDiscoveryResultSchema.safeParse({ ...refused, launchAttemptCount: 1 })
        .success,
    ).toBe(false);
  });

  it('rejects incomplete, cross-scope and unbounded terminal claims', () => {
    for (const change of [
      { discoveryId: '' },
      { discoveryId: 'x'.repeat(257) },
      { discoveryId: undefined, sessionId: 'host:1' },
      { drained: false },
      { launchAttemptCount: -1 },
      { launchAttemptCount: 2 },
      { launchAttemptCount: 0.5 },
      { sessionId: 'unrelated-session' },
    ])
      expect(
        computerUseNativeDiscoveryStopReceiptSchema.safeParse({
          ...receipt,
          result: 'stopped',
          ...change,
        }).success,
      ).toBe(false);
    expect(
      computerUseNativeDiscoveryResultSchema.safeParse({
        ...receipt,
        result: 'completed',
        windows: Array.from({ length: 65 }, () => ({})),
      }).success,
    ).toBe(false);
  });
});
