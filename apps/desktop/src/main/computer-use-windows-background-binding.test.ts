import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const native = (name: string): string =>
  readFileSync(join(__dirname, '../../computer-use-native', name), 'utf8');

describe('background binding native entry', () => {
  it('registers BG-4 native cases and shares measurement across observation and input', () => {
    expect(native('computer_use_protocol_fuzz.cc')).toContain(
      'windows_background_binding_test::Check()',
    );
    const semantic = native('computer_use_windows_host_uia_semantic.inc');
    expect(semantic).toContain('ComputeWindowsBackgroundControlSignature');
    expect(semantic).toContain('ValidateWindowsBackgroundActionBinding');
    const preflight = native('computer_use_windows_host_preflight.inc');
    expect(
      preflight.match(/ValidateWindowsBackgroundActionBindingWithinFrame\(session, metadata\)/gu),
    ).toHaveLength(2);
    expect(native('computer_use_windows_approval_measurement.h')).toContain(
      'WindowsBackgroundBindingMatches',
    );
  });

  it('keeps unknown providers closed and binds both observation reads without focus fallback', () => {
    const semantic = native('computer_use_windows_host_uia_semantic.inc');
    const guard = semantic.slice(
      semantic.indexOf('bool ValidateWindowsBackgroundActionBinding('),
      semantic.indexOf('bool Utf16FromUtf8('),
    );
    expect(guard).toContain(
      'if (session.input_session.kind != InputSessionKind::kBackground) return true;',
    );
    expect(guard).toContain(
      'FindWindowsSemanticTarget(window, target, element.Receive(), &reason)',
    );
    expect(guard).toContain('WindowsBackgroundBindingMatches(true, observed->second, current)');
    expect(guard).not.toMatch(/SetForegroundWindow|SetFocus|SendInput|GetFocusedElement/u);
    expect(semantic).toContain('if (facts.proxy != WindowsBackgroundProxy::kStable) return false;');
    expect(semantic).not.toContain('facts.proxy = WindowsBackgroundProxy::kStable');
    const observe = native('computer_use_windows_host_pipe.inc');
    expect(observe).toContain('&bindings, background)');
    expect(observe).toContain('&stable_bindings, background)');
  });
});
