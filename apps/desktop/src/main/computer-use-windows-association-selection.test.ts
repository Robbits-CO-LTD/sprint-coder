import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
const dir = join(__dirname, '../../computer-use-native');
const read = (name: string): string =>
  existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : '';
describe('Windows association and selection measurement (N8-1b)', () => {
  it('includes its OS measurement dependency without relying on host include order', () => {
    const source = read('computer_use_windows_uia_source.h');
    expect(source).toContain('#include "computer_use_windows_association_measurement.h"');
  });
  it('requires OS evidence and compares all three boundary measurements', () => {
    const source =
      read('computer_use_windows_association.h') +
      read('computer_use_windows_association_measurement.h');
    for (const token of [
      'AssocIsDangerous',
      'ASSOCSTR_EXECUTABLE',
      'ASSOCSTR_COMMAND',
      'PerceivedType',
      'UserChoice',
      'ProgId',
      'DelegateExecute',
      'DropTarget',
      'SameWindowsOpenFacts',
    ])
      expect(source).toContain(token);
  });
  it('keeps the portable fixture independent of Windows OS headers', () => {
    const visited = new Set<string>();
    const visit = (name: string): void => {
      if (visited.has(name)) return;
      visited.add(name);
      const source = read(name);
      expect(source, name).not.toBe('');
      expect(source, name).not.toMatch(
        /#include\s*<(?:windows|objbase|shlwapi|softpub|wintrust|wincrypt)\.h>/iu,
      );
      for (const match of source.matchAll(/#include\s*"([^"]+)"/gu)) visit(match[1]!);
    };
    visit('computer_use_windows_association_fixture.h');
    expect(read('computer_use_protocol_fuzz.cc')).toContain(
      '#include "computer_use_windows_association_fixture.h"',
    );
  });
  it('pins the Windows-only viewer table independently', () => {
    const source = read('computer_use_windows_document_viewers.h');
    expect(source).toContain('kWindowsDocumentViewerVersion = 1');
    expect(source).toContain('std::array<WindowsDocumentViewer, 0>');
    let hash = 14695981039346656037n;
    for (const byte of [...Buffer.from('windows-document-viewers-v1'), 255, 0, 0, 0, 1])
      hash = ((hash ^ BigInt(byte)) * 1099511628211n) & ((1n << 64n) - 1n);
    expect(source).toContain(`kWindowsDocumentViewerDigestPinned = 0x${hash.toString(16)}ULL`);
    expect(source).toContain(
      'static_assert(kWindowsDocumentViewerDigest == kWindowsDocumentViewerDigestPinned',
    );
  });
  it('reads the complete shell selection and cross-checks SelectionPattern', () => {
    const source = read('computer_use_windows_uia_source.h');
    for (const token of [
      'SVGIO_SELECTION',
      'GetCurrentSelection',
      'UIA_SelectionPatternId',
      'MeasureWindowsSingleSelection',
    ])
      expect(source).toContain(token);
  });
  it('keeps the negative matrix connected to the portable harness and Windows seam', () => {
    const fixture = read('computer_use_windows_association_fixture.h');
    for (const name of [
      'association-unknown-handler',
      'association-rlo-real-executable',
      'association-incomplete-or-unsupported',
      'association-dangerous',
      'association-application',
      'association-ide-unknown-real-path',
      'selection-single',
      'selection-multiple',
      'selection-other',
      'selection-none',
      'selection-read-failed',
      'selection-uia-mismatch',
      'selection-offscreen',
      'selection-uia-read-failed',
      'boundary-changed-takeover',
      'boundary-changed-verdict',
      'measurement-deadline',
      'measurement-expired',
      'measurement-clock-reversed',
      'measurement-cancelled',
    ])
      expect(fixture).toContain(`"${name}"`);
    for (const file of [
      'computer_use_protocol_fuzz.cc',
      'computer_use_windows_association_seam.cc',
    ])
      expect(read(file)).toContain('CheckWindowsAssociationSelection(Check)');
    expect(read('computer_use_windows_approval_measurement.h')).toContain(
      'const WindowsOpenFacts *open_facts = nullptr;',
    );
  });
  it('keeps capabilities and both effect gates closed', () => {
    const source = read('computer_use_windows_host_preflight.inc');
    expect(source).toContain('/*download_open=*/false, /*file_manager_open=*/false');
    expect(source).not.toContain('documentViewerVersion');
    expect(source).not.toContain('approvalApprove');
  });
});
