import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  computerUseInputAuthoritySchema,
  computerUseInputSessionSchema,
  computerUseWindowsBackgroundCapabilitySchema,
} from '@sprint-coder/contracts';
import {
  COMPUTER_USE_WINDOWS_BACKGROUND_INPUT_ENABLED,
  computerUseInputPathToLedgerPath,
  parseComputerUseWindowsBackgroundCapability,
  computerUseWindowsBackgroundInputAvailable,
} from './computer-use-native-protocol';
import { parseNativeHandshake } from './computer-use-native-handshake';

const capability = { version: 1, capabilityTableVersion: 1, authorityVersion: 1 };
const handshake = {
  protocolVersion: 1,
  apiVersion: 3,
  platform: 'win32',
  napiVersion: 10,
};
const authority = {
  version: 1,
  sessionKind: 'background',
  inputPath: 'background_semantic',
  pattern: 'invoke',
  targetAncestorsDigest: null,
  contentFingerprint: null,
  interactionEpoch: null,
};

describe('Windows background observation (P2b)', () => {
  const native = (name: string) =>
    readFileSync(join(__dirname, '../../computer-use-native', name), 'utf8');

  it('connects target-only observation and capture without reading foreground focus', () => {
    const pipe = native('computer_use_windows_host_pipe.inc');
    expect(pipe).toContain('ValidateWindowsObservationSession(session,');
    expect(pipe).toContain(
      'background ? WindowsUiaRisk{} : ClassifyWindowsFocusedElement(session.pid)',
    );
    expect(pipe).toContain('!background && WindowsFocusedElementSignature(');
    expect(pipe).toContain('&capture_stop, background ? session.pid : 0');
    const observe = native('computer_use_windows_host_observe.inc');
    expect(observe).toContain('WindowsBackgroundObservationNodeAdmitted(');
    expect(observe).toContain('CaptureWindowsBackgroundStartDialogs(session,');
    expect(observe).toContain('ReadWindowsSessionIdentityOnLane(session,');
    const capture = native('computer_use_windows_host_capture.inc');
    expect(capture).toContain('background_pid == 0 ? GetForegroundWindow() == window');
    expect(capture).toContain('MeasureWindowsBackgroundStartFacts(background_pid, window,');
  });
});

describe('Windows background input wire (P1a)', () => {
  it('keeps the legacy helper and foreground handshake unchanged', () => {
    expect(parseNativeHandshake(handshake, 'win32')).toBeNull();
    expect(parseComputerUseWindowsBackgroundCapability(handshake)).toBeNull();
    expect(computerUseWindowsBackgroundInputAvailable(handshake)).toBe(false);
  });

  it('parses a complete declaration without exposing background input', () => {
    const declared = { ...handshake, windowsBackgroundInput: capability };
    expect(parseNativeHandshake(declared, 'win32')).toBeNull();
    expect(parseComputerUseWindowsBackgroundCapability(declared)).toEqual(capability);
    expect(computerUseWindowsBackgroundInputAvailable(declared)).toBe(false);
    expect(COMPUTER_USE_WINDOWS_BACKGROUND_INPUT_ENABLED).toBe(false);
  });

  it.each([
    null,
    {},
    { ...capability, version: 2 },
    { ...capability, capabilityTableVersion: 2 },
    { ...capability, authorityVersion: 2 },
    { ...capability, enabled: true },
    { ...capability, version: '1' },
    { version: 1, authorityVersion: 1 },
  ])('closes only the background route for a malformed declaration: %j', (claim) => {
    const declared = { ...handshake, windowsBackgroundInput: claim };
    expect(parseNativeHandshake(declared, 'win32')).toBeNull();
    expect(parseComputerUseWindowsBackgroundCapability(declared)).toBeNull();
    expect(computerUseWindowsBackgroundInputAvailable(declared)).toBe(false);
  });

  it('cannot open the internal gate through environment or wire claims', () => {
    vi.stubEnv('SPRINT_CODER_WINDOWS_BACKGROUND_INPUT', '1');
    try {
      expect(
        computerUseWindowsBackgroundInputAvailable({
          ...handshake,
          windowsBackgroundInput: capability,
          enabled: true,
        }),
      ).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('does not extend the macOS handshake', () => {
    expect(() =>
      parseNativeHandshake(
        {
          ...handshake,
          platform: 'darwin',
          windowsBackgroundInput: capability,
        },
        'darwin',
      ),
    ).toThrow('HANDSHAKE_INVALID');
  });

  it('maps only the background path to the background ledger kind', () => {
    expect(computerUseInputPathToLedgerPath('background_semantic')).toBe('background_semantic');
    expect(computerUseInputPathToLedgerPath('foreground_semantic')).toBe('normal');
    expect(computerUseInputPathToLedgerPath('foreground_input')).toBe('normal');
  });

  it('requires a complete, closed session shape', () => {
    expect(
      computerUseInputSessionSchema.parse({ kind: 'foreground', backgroundCapabilityVersion: null })
        .kind,
    ).toBe('foreground');
    expect(
      computerUseInputSessionSchema.parse({ kind: 'background', backgroundCapabilityVersion: 1 })
        .kind,
    ).toBe('background');
    for (const value of [
      { kind: 'foreground' },
      { kind: 'background', backgroundCapabilityVersion: null },
      { kind: 'foreground', backgroundCapabilityVersion: 1 },
      { kind: 'background', backgroundCapabilityVersion: 1, enabled: true },
    ])
      expect(computerUseInputSessionSchema.safeParse(value).success).toBe(false);
  });

  it('binds each path to its session and semantic pattern', () => {
    expect(computerUseInputAuthoritySchema.parse(authority)).toEqual(authority);
    expect(
      computerUseInputAuthoritySchema.safeParse({
        ...authority,
        sessionKind: 'foreground',
        inputPath: 'foreground_semantic',
      }).success,
    ).toBe(true);
    expect(
      computerUseInputAuthoritySchema.safeParse({
        ...authority,
        sessionKind: 'foreground',
        inputPath: 'foreground_input',
        pattern: null,
      }).success,
    ).toBe(true);
    for (const patch of [
      { sessionKind: 'foreground' },
      { inputPath: 'foreground_input' },
      { inputPath: 'unknown' },
      { pattern: null },
      { pattern: 'scroll_into_view' },
      { version: 2 },
      { extra: true },
      { interactionEpoch: 1 },
      { contentFingerprint: 'a'.repeat(64) },
    ])
      expect(computerUseInputAuthoritySchema.safeParse({ ...authority, ...patch }).success).toBe(
        false,
      );
    for (const key of Object.keys(authority)) {
      const incomplete: Record<string, unknown> = { ...authority };
      delete incomplete[key];
      expect(computerUseInputAuthoritySchema.safeParse(incomplete).success, key).toBe(false);
    }
  });

  it('pins native producer fixtures to the TypeScript schemas', () => {
    const source = readFileSync(
      join(__dirname, '../../computer-use-native/computer_use_background_wire_test.h'),
      'utf8',
    );
    const fixtures = [...source.matchAll(/R"wire\((.*?)\)wire"/gu)].map((match) =>
      JSON.parse(match[1]!),
    );
    expect(fixtures).toHaveLength(3);
    expect(computerUseWindowsBackgroundCapabilitySchema.parse(fixtures[0])).toEqual(capability);
    expect(computerUseInputSessionSchema.parse(fixtures[1])).toEqual({
      kind: 'background',
      backgroundCapabilityVersion: 1,
    });
    expect(computerUseInputAuthoritySchema.parse(fixtures[2])).toEqual(authority);
  });
});
