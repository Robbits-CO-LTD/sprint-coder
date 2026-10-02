import { describe, expect, it } from 'vitest';
import {
  assertShardReport,
  collectedTestNames,
  partitionTestNames,
  testNamesPattern,
} from './electron-test-shards';

describe('bounded Electron test shards', () => {
  it('partitions every collected case exactly once and escapes anchored patterns', () => {
    const names = ['Suite > a (x)', 'Suite > b.*', 'Nested > Suite > c', 'Suite > d', 'Suite > e'];
    const groups = partitionTestNames(names, 4);
    expect(groups.flat().sort()).toEqual([...names].sort());
    for (const group of groups) {
      const pattern = new RegExp(testNamesPattern(group));
      for (const name of names) {
        expect(pattern.test(`${name.replaceAll(' > ', ' ')}`)).toBe(group.includes(name));
        expect(pattern.test(`${name.replaceAll(' > ', ' ')} extra`)).toBe(false);
      }
    }
  });
  it('refuses empty, duplicate, ambiguous, and foreign collections', () => {
    expect(() => collectedTestNames([], '/root', '/root/test.ts')).toThrow();
    expect(() =>
      collectedTestNames([{ name: 'x', file: '/other' }], '/root', '/root/test.ts'),
    ).toThrow();
    expect(() =>
      collectedTestNames(
        ['a > b', 'a b'].map((name) => ({ name, file: '/root/test.ts' })),
        '/root',
        '/root/test.ts',
      ),
    ).toThrow();
    expect(() => partitionTestNames(['x', 'x'], 1)).toThrow();
    expect(() => partitionTestNames(['x'], 4)).toThrow();
    expect(() => testNamesPattern([])).toThrow();
  });
  it('requires precisely the expected passing assertions, including nested suites', () => {
    const assertion = {
      ancestorTitles: ['Nested', 'Suite'],
      title: 'case',
      status: 'passed',
    };
    const report = (assertions: unknown[]) => ({
      success: true,
      testResults: [{ assertionResults: assertions }],
    });
    expect(() => assertShardReport(report([assertion]), ['Nested > Suite > case'])).not.toThrow();
    expect(() => assertShardReport(report([]), ['Nested > Suite > case'])).toThrow();
    expect(() =>
      assertShardReport(report([assertion, assertion]), ['Nested > Suite > case']),
    ).toThrow();
    expect(() =>
      assertShardReport(report([{ ...assertion, status: 'skipped' }]), ['Nested > Suite > case']),
    ).toThrow();
    expect(() =>
      assertShardReport(report([{ ...assertion, status: 'failed' }]), ['Nested > Suite > case']),
    ).toThrow();
    expect(() => assertShardReport(report([assertion]), ['unexpected'])).toThrow();
    expect(() => assertShardReport({ success: false, testResults: [] }, ['case'])).toThrow();
  });
});
