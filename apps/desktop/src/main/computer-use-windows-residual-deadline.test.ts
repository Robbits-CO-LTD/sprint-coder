import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { operationTimeoutMilliseconds } from './computer-use-native-windows';

it('keeps every Main residual deadline at least ten notifier polls long', () => {
  const native = readFileSync(
    join(__dirname, '../../computer-use-native/computer_use_windows_host_preflight.inc'),
    'utf8',
  );
  const notifier = native.match(/class WindowsRetirementNotifier \{([\s\S]*?)\n\};/u);
  expect(notifier).not.toBeNull();
  const run = notifier![1]!.split('void Run() {')[1];
  expect(run).toBeDefined();
  const polls = [...run!.matchAll(/wait_for\(lock, std::chrono::milliseconds\((\d+)\)\)/gu)];
  expect(polls).toHaveLength(1);
  const pollMilliseconds = Number(polls[0]![1]);
  expect(pollMilliseconds).toBeGreaterThan(0);

  const main = readFileSync(join(__dirname, 'computer-use-native-windows.ts'), 'utf8');
  const timeouts = main.match(
    /export function operationTimeoutMilliseconds\(operation: string\): number \{([\s\S]*?)\n\}/u,
  );
  expect(timeouts).not.toBeNull();
  // Discover operation names from the policy so a new shorter branch is checked too.
  const operations = [...timeouts![1]!.matchAll(/'([a-z_]+)'/gu)].map((match) => match[1]!);
  expect(operations).toContain('read_node_value');
  const shortest = Math.min(
    ...[...operations, 'unknown_operation'].map(operationTimeoutMilliseconds),
  );
  expect(shortest).toBeGreaterThanOrEqual(10 * pollMilliseconds);
});
