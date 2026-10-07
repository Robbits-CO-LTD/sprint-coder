import { relative, resolve } from 'node:path';

export function electronBridgeShardIndices(
  value: string | undefined,
  ci: string | undefined,
): number[] {
  if (value === undefined) return [0, 1, 2, 3];
  if (ci !== 'true' || !/^[0-3]$/u.test(value)) throw new Error('Invalid CI Electron bridge shard');
  return [Number(value)];
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid Electron test report');
  }
  return value as Record<string, unknown>;
}

export function collectedTestNames(value: unknown, cwd: string, file: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('No Electron tests collected');
  const names = value.map((item: unknown) => {
    const record = object(item);
    if (
      typeof record.file !== 'string' ||
      resolve(record.file) !== resolve(file) ||
      typeof record.name !== 'string' ||
      !record.name
    ) {
      throw new Error('Unexpected Electron test collection');
    }
    return record.name;
  });
  // Vitest list uses " > " while its runner matches space-separated task ancestors.
  // Refuse ambiguous normalized names instead of silently selecting multiple cases.
  const normalized = names.map(
    (name) => `${relative(cwd, file).replaceAll('\\', '/')} ${name.replaceAll(' > ', ' ')}`,
  );
  if (new Set(names).size !== names.length || new Set(normalized).size !== names.length) {
    throw new Error('Duplicate Electron test names');
  }
  return names;
}

export function partitionTestNames(names: readonly string[], count: number): string[][] {
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    names.length < count ||
    new Set(names).size !== names.length
  ) {
    throw new Error('Invalid Electron test partition');
  }
  const groups = Array.from({ length: count }, () => [] as string[]);
  names.forEach((name, index) => {
    const group = groups[index % count];
    if (!group) throw new Error('Missing Electron test partition');
    group.push(name);
  });
  return groups;
}

export function testNamesPattern(names: readonly string[]): string {
  if (!names.length) throw new Error('Empty Electron test shard');
  const escape = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `^(?:${names.map((name) => escape(name.replaceAll(' > ', ' '))).join('|')})$`;
}

export function assertShardReport(value: unknown, expected: readonly string[]): void {
  const report = object(value);
  if (report.success !== true || !Array.isArray(report.testResults)) {
    throw new Error('Electron test shard failed');
  }
  const passed: string[] = [];
  for (const rawFile of report.testResults) {
    const file = object(rawFile);
    if (!Array.isArray(file.assertionResults)) throw new Error('Missing Electron assertions');
    for (const rawAssertion of file.assertionResults) {
      const assertion = object(rawAssertion);
      if (assertion.status === 'skipped' || assertion.status === 'pending') continue;
      if (
        assertion.status !== 'passed' ||
        !Array.isArray(assertion.ancestorTitles) ||
        !assertion.ancestorTitles.every((title: unknown) => typeof title === 'string') ||
        typeof assertion.title !== 'string'
      )
        throw new Error('Invalid Electron assertion result');
      // JSON assertion ancestors and list names both omit the test module.
      passed.push([...assertion.ancestorTitles, assertion.title].join(' > '));
    }
  }
  if (
    !expected.length ||
    passed.length !== expected.length ||
    new Set(passed).size !== passed.length ||
    passed.some((name) => !expected.includes(name))
  ) {
    throw new Error('Electron test shard coverage mismatch');
  }
}
