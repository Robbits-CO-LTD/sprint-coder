import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const native = (name: string) =>
  readFileSync(join(__dirname, '../../computer-use-native', name), 'utf8');

describe('Windows page origin metadata (N11-B)', () => {
  it('isolates the bounded metadata walk from the legacy capture budget', () => {
    const reader = native('computer_use_windows_shadow_reader.h');
    expect(reader).toContain('kOriginMaxCalls = 128');
    expect(reader).toContain("kOriginDeadlineNs = 30'000'000");
    expect(reader).toContain('if (OriginWithinBudget()) capture->page_origin');
    expect(reader.indexOf('capture.budget_exhausted = gate_.BudgetExhausted()')).toBeLessThan(
      reader.indexOf('CapturePageOrigin(root, &capture)'),
    );
    const harness = native('computer_use_protocol_fuzz.cc');
    for (const name of [
      'winorigin-budget-isolated-from-legacy-capture',
      'winorigin-budget-preserves-classification-and-interlock',
      'winorigin-budget-preserves-subsequent-read',
    ])
      expect(harness).toContain(name);
  });

  it('classifies a freshly verified unique Chrome Document without enabling actions', () => {
    const reader = native('computer_use_windows_shadow_reader.h');
    expect(reader).toContain('CapturePageOrigin(root, &capture)');
    expect(reader).toContain('ClassifyPageOrigin(url).state');
    expect(reader).toContain('ScanDocuments(');
    expect(reader).toContain('capture.page_origin = OriginState::kUnknown');
    const shadow = native('computer_use_windows_shadow.h');
    expect(shadow.match(/page_origin/gu)).toHaveLength(1);
    expect(native('computer_use_protocol_fuzz.cc')).toContain('CheckWindowsPageOrigin()');
    expect(native('computer_use_windows_uia_source.h')).toContain(
      'get_CurrentValue(value.Receive())',
    );
  });
});
