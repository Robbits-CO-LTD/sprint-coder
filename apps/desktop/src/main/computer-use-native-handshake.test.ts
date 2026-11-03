import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseNativeHandshake,
  WINDOWS_APPROVAL_WIRE_VERSION,
} from './computer-use-native-handshake';

const handshake = {
  protocolVersion: 1,
  apiVersion: 3,
  platform: 'win32',
  napiVersion: 10,
};

describe('Windows approval wire negotiation', () => {
  it('pins the producer and parser to the native receipt wire version', () => {
    const native = readFileSync(
      join(__dirname, '../../computer-use-native/computer_use_windows_approval_wire.h'),
      'utf8',
    );
    expect(native).toMatch(
      new RegExp(`kWindowsApprovalReceiptVersion\\s*=\\s*${WINDOWS_APPROVAL_WIRE_VERSION}`),
    );
    const producer = readFileSync(
      join(__dirname, '../../computer-use-native/computer_use_windows_host_preflight.inc'),
      'utf8',
    );
    expect(producer).toContain(
      'std::to_string(sprint_coder::computer_use::kWindowsApprovalReceiptVersion)',
    );
    expect(producer).toContain('approvalWire');
  });

  it('accepts only the explicit current approval wire version', () => {
    expect(() =>
      parseNativeHandshake(
        { ...handshake, capabilities: { approval: true, approvalWire: 3 } },
        'win32',
      ),
    ).not.toThrow();
  });

  it.each([undefined, null, 1, 2, 4, '3', true])('rejects wire version %s', (approvalWire) => {
    expect(() =>
      parseNativeHandshake(
        { ...handshake, capabilities: { approval: true, approvalWire } },
        'win32',
      ),
    ).toThrow('HANDSHAKE_INVALID');
  });

  it.each([false, undefined])('rejects a wire claim without approval: %s', (approval) => {
    expect(() =>
      parseNativeHandshake({ ...handshake, capabilities: { approval, approvalWire: 3 } }, 'win32'),
    ).toThrow('HANDSHAKE_INVALID');
  });
});
