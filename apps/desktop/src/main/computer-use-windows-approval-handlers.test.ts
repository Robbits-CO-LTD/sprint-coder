import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readWindowsHostSource } from '../../../../computer-use-windows-host-source.mjs';

const native = (name: string): string =>
  readFileSync(join(__dirname, '../../computer-use-native', name), 'utf8');

describe('Windows private approval handlers', () => {
  it('routes all three messages without enabling the production capability', () => {
    const host = readWindowsHostSource();
    for (const message of ['ApprovalApprove', 'ApprovalDiscard', 'DispatchApproved']) {
      expect(host.includes(`case MessageType::k${message}:`), message).toBe(true);
    }
    expect(host).toContain('HandleWindowsApproval');
    expect(host).toContain('windows_helper_generation');
    expect(host).toContain('\\"approval\\":false');
    expect(host).toContain('constexpr bool kWindowsApprovalHandlersEnabled = false;');
  });

  it('keeps measurement, lifetime and Stop checks in the private owner', () => {
    const source = native('computer_use_windows_approval_handlers.h');
    for (const contract of [
      'NativeApprovalFlow',
      'WindowsOpenMeasurementDeadline',
      'MeasureWindowsApproval',
      'ConsumeApproved',
      'helper_generation',
      'stop_serial',
      'ClassifyWindowsNativeRisk',
    ]) {
      expect(source).toContain(contract);
    }
  });

  it('runs the lifetime and replay fixture in the native harness', () => {
    const harness = native('computer_use_protocol_fuzz.cc');
    expect(harness).toContain('windows_approval_handlers_test::Check()');
    const fixture = native('computer_use_windows_approval_handlers_test.h');
    for (const contract of [
      "59'999'999'999ULL",
      "60'000'000'000ULL",
      "4'999'999'999ULL",
      "5'000'000'000ULL",
      "149'999'999ULL",
      "150'000'000ULL",
      'claim_delay',
      'backwards',
      'hung_owner',
      'f.approved_inputs != 1',
      'f.ordinary_inputs != 0',
      'f.owner.Discard(stale)',
      'f.reference.helper_generation = 0',
    ]) {
      expect(fixture.includes(contract), contract).toBe(true);
    }
  });

  it('checks the original Stop serial and deadline at the input owner', () => {
    const host = readWindowsHostSource();
    expect(host).toContain('reference.helper_generation != windows_helper_generation');
    expect(host).toContain('reference.facts.cancel_epoch, reference.stop_serial');
    expect(host).toContain('now >= session.approved_deadline_ns');
    expect(host).toContain('MonotonicNowNs() >= pending->approved_deadline_ns');
    expect(host).toContain('pending->ever_claimed');
    expect(host).toContain('work.approved_effect');
    expect(host).toContain('click_basis.tracked = session.approved_click_tracked');
    expect(host).toContain('sample.click_basis = click_basis');
    expect(host.match(/\bSendInput\(/gu)).toHaveLength(1);
    const preflight = host.slice(host.indexOf('bool HandleWindowsPreflight('));
    expect(preflight.indexOf('approval.Offer(')).toBeLessThan(
      preflight.indexOf('WindowsInterlockRefusal(session, metadata, kind)'),
    );
  });
});
