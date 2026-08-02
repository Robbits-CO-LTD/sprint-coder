import { describe, expect, it } from 'vitest';
import { WINDOWS_ACL_TIMEOUT_MS } from './windows-acl';

describe('Windows ACL runner', () => {
  it('keeps its subprocess deadline below the integration-test timeout', () => {
    expect(WINDOWS_ACL_TIMEOUT_MS).toBeGreaterThan(10_000);
    expect(WINDOWS_ACL_TIMEOUT_MS).toBeLessThan(20_000);
  });
});
