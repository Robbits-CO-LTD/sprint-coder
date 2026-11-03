import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const native = (name: string) =>
  readFileSync(join(__dirname, '../../computer-use-native', name), 'utf8');

describe('Windows page origin metadata (N11-B)', () => {
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
