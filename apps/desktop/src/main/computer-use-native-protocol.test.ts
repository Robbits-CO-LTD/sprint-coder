import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  computerUseApprovalRoundTripWireSchema,
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

describe('Windows background monitor (P3a)', () => {
  it('registers the native BG02/BG03 matrix without opening the public gate', () => {
    const native = (name: string) =>
      readFileSync(join(__dirname, '../../computer-use-native', name), 'utf8');
    expect(native('computer_use_protocol_fuzz.cc')).toContain('CheckBackgroundMonitor()');
    expect(native('computer_use_windows_background_monitor_test.h')).toContain(
      'BG03_lost_event_cannot_bypass_epoch',
    );
    expect(native('computer_use_windows_host_background_monitor.inc')).toContain('WH_MOUSE_LL');
    const validation = native('computer_use_windows_host_session.inc').split(
      'bool ValidateWindowsSession(',
    )[1]!;
    expect(validation.split('bool ReadExact(')[0]).toContain(
      'if (!WindowsBackgroundMonitorCurrent(session))',
    );
    const start = native('computer_use_windows_host_v2_targets.inc');
    expect(start).toContain(
      'StartWindowsBackgroundMonitor(session, input.pid, input.window, false, reason)',
    );
    expect(start).toContain(
      'StartWindowsBackgroundMonitor(session, input.pid, input.window, input.explicit_resume, reason)',
    );
    expect(native('computer_use_windows_background_monitor_test.cc')).toContain(
      '#include "computer_use_windows_host_background_monitor.inc"',
    );
    expect(COMPUTER_USE_WINDOWS_BACKGROUND_INPUT_ENABLED).toBe(false);
  });
});

describe('Windows approval round trip state (P3c)', () => {
  it('pins one bound API call per Unicode scalar, including a surrogate pair', () => {
    const input = readFileSync(
      join(__dirname, '../../computer-use-native/computer_use_windows_host_input.inc'),
      'utf8',
    );
    const scalar = input.split('bool SendUnicodeScalar(')[1]!.split('bool DecodeUtf8Scalars(')[0]!;
    expect(scalar.match(/SendInputForBoundTarget\(/gu)).toHaveLength(1);
    expect(scalar).toContain('INPUT events[4]{};');
    expect(scalar).toContain('expected_epoch, count, events');
    expect(scalar).toContain('sent == count');
  });

  it('registers the native state machine and keeps the background gate closed', () => {
    const native = (name: string) =>
      readFileSync(join(__dirname, '../../computer-use-native', name), 'utf8');
    expect(native('computer_use_windows_approval_round_trip.h')).toContain(
      'class WindowsApprovalRoundTrip',
    );
    expect(native('computer_use_protocol_fuzz.cc')).toContain('CheckApprovalRoundTripState()');
    expect(COMPUTER_USE_WINDOWS_BACKGROUND_INPUT_ENABLED).toBe(false);
  });
  it('pins offer closure, failed preflight exits and target event monitoring', () => {
    const native = (name: string) =>
      readFileSync(join(__dirname, '../../computer-use-native', name), 'utf8');
    const preflight = native('computer_use_windows_host_preflight.inc').split(
      'bool HandleWindowsPreflight(',
    )[1]!;
    expect(preflight.indexOf('!session.round_trip->MayObserve()')).toBeLessThan(
      preflight.indexOf('previous_approval->second.Invalidate()'),
    );
    expect(preflight.indexOf('WindowsRoundTripPreflightGuard')).toBeLessThan(
      preflight.indexOf('response_cache.contains'),
    );
    expect(preflight).toContain('session.round_trip->Offer(binding,');
    expect(preflight).toContain('round_trip_completed = issued && sent');
    const monitor = native('computer_use_windows_host_session.inc');
    for (const event of [
      'EVENT_OBJECT_CREATE',
      'EVENT_OBJECT_DESTROY',
      'EVENT_OBJECT_SHOW',
      'EVENT_OBJECT_HIDE',
      'EVENT_OBJECT_LOCATIONCHANGE',
      'EVENT_OBJECT_REORDER',
      'EVENT_SYSTEM_MOVESIZESTART',
      'EVENT_SYSTEM_MOVESIZEEND',
      'EVENT_SYSTEM_CAPTURESTART',
      'EVENT_SYSTEM_CAPTUREEND',
    ]) {
      expect(monitor).toContain(event);
    }
    expect(monitor).toContain('snapshot.pid, 0, WINEVENT_OUTOFCONTEXT');
    expect(monitor).toContain('current->snapshot.round_trip->TargetEvent()');
    expect(monitor).toContain(
      'if (!all_registered) snapshot.round_trip->Invalidate("monitor_failed")',
    );
    expect(monitor).toContain('if (!started) snapshot.round_trip->Invalidate("monitor_failed")');
    expect(monitor).toContain('acknowledged >= serial');
    const fixture = native('computer_use_windows_approval_round_trip_test.h');
    for (const test of [
      'RT_two_cards_to_ordinary',
      'RT_target_event_failure_latches_in_all_trip_phases',
      'replay',
      'binding_denied',
      'refuse',
      'interlock_refusal',
      'registration',
      'heartbeat',
    ]) {
      expect(fixture).toContain(test);
    }
  });
  it('pins native admission, foreground monitoring and the final input barriers', () => {
    const native = (name: string) =>
      readFileSync(join(__dirname, '../../computer-use-native', name), 'utf8');
    const session = native('computer_use_windows_host_session.inc');
    expect(session).toContain('SetWinEventHook(EVENT_SYSTEM_FOREGROUND');
    expect(session).toContain('PostThreadMessageW(thread_id, kPing');
    expect(session).toContain('existing.round_trip->Return(binding,');
    expect(session).toContain('existing.round_trip->Returned(binding,');
    expect(native('computer_use_windows_host_preflight.inc')).toContain(
      'if (!kWindowsBackgroundInputEnabled)',
    );
    expect(native('computer_use_windows_host_input.inc')).toContain(
      'if (!WindowsRoundTripMayInput(session))',
    );
    expect(native('computer_use_windows_host_uia_semantic.inc')).toContain(
      'pending->round_trip->MayInput(',
    );
    expect(native('computer_use_windows_approval_round_trip.h')).not.toContain('interaction_epoch');
  });
});

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

const roundTripBinding = {
  version: 1,
  roundTripId: 'round-trip-1',
  sessionId: 'session-1',
  taskId: 'task-1',
  turnId: 'turn-1',
  helperGeneration: 1,
  cancelEpoch: 0,
};
const roundTripBegin = {
  ...roundTripBinding,
  kind: 'begin',
  durationMs: 60000,
  mainPid: 42,
  mainProcessStartTime: '123',
  mainImageIdentity: 'a'.repeat(64),
};
const roundTripMessages = [
  roundTripBegin,
  { ...roundTripBinding, kind: 'end', reason: 'approved' },
  { ...roundTripBinding, kind: 'return' },
  { ...roundTripBinding, kind: 'approve', approvalGeneration: 1, observationRevision: 2 },
  {
    ...roundTripBinding,
    kind: 'event',
    sequence: 1,
    state: 'active',
    foreground: 'sprint_coder',
    failureReason: 'none',
    failureLatched: false,
  },
  {
    ...roundTripBinding,
    kind: 'event',
    sequence: 2,
    state: 'failed',
    foreground: 'other',
    failureReason: 'third_window',
    failureLatched: true,
  },
];

describe('Windows approval round trip wire (P1b)', () => {
  it('accepts complete begin/end/return/approve and latched event contracts', () => {
    for (const value of roundTripMessages)
      expect(computerUseApprovalRoundTripWireSchema.parse(value)).toEqual(value);
  });
  it('rejects every missing or unknown field, including return/approve id', () => {
    for (const value of roundTripMessages) {
      expect(
        computerUseApprovalRoundTripWireSchema.safeParse({ ...value, extra: true }).success,
      ).toBe(false);
      for (const key of Object.keys(value)) {
        const incomplete: Record<string, unknown> = { ...value };
        delete incomplete[key];
        expect(
          computerUseApprovalRoundTripWireSchema.safeParse(incomplete).success,
          `${value.kind}.${key}`,
        ).toBe(false);
      }
    }
  });
  it('accepts only positive integer durations up to 60 seconds, not absolute deadlines', () => {
    for (const durationMs of [1, 59999, 60000])
      expect(
        computerUseApprovalRoundTripWireSchema.safeParse({ ...roundTripBegin, durationMs }).success,
      ).toBe(true);
    for (const durationMs of [0, -1, 60001, 1.5, '60000', null, Infinity])
      expect(
        computerUseApprovalRoundTripWireSchema.safeParse({ ...roundTripBegin, durationMs }).success,
      ).toBe(false);
    expect(
      computerUseApprovalRoundTripWireSchema.safeParse({ ...roundTripBegin, expiresAt: 60000 })
        .success,
    ).toBe(false);
  });
  it('rejects unbound identities and unsafe counters', () => {
    for (const patch of [
      { roundTripId: '' },
      { roundTripId: 'x'.repeat(257) },
      { version: 2 },
      { helperGeneration: 0 },
      { cancelEpoch: -1 },
      { cancelEpoch: Number.MAX_SAFE_INTEGER + 1 },
      { mainPid: 0 },
      { mainProcessStartTime: '0' },
      { mainImageIdentity: 'unknown' },
    ])
      expect(
        computerUseApprovalRoundTripWireSchema.safeParse({ ...roundTripBegin, ...patch }).success,
      ).toBe(false);
  });
  it('does not permit third windows or failures without native failure retention', () => {
    const failed = roundTripMessages[5]!;
    for (const patch of [
      { failureLatched: false },
      { failureReason: 'none' },
      { state: 'active' },
      { foreground: 'unknown' },
      { sequence: 0 },
    ])
      expect(
        computerUseApprovalRoundTripWireSchema.safeParse({ ...failed, ...patch }).success,
      ).toBe(false);
    expect(
      computerUseApprovalRoundTripWireSchema.safeParse({
        ...roundTripMessages[4],
        foreground: 'other',
      }).success,
    ).toBe(false);
  });
});

describe('P1b transport vocabulary', () => {
  it('assigns matching native frame numbers to begin/end acknowledgements and events', async () => {
    const protocol = await import('./computer-use-native-protocol');
    const names = protocol.computerUseNativeMessageTypeNames();
    const expected = [
      'approval_round_trip_begin',
      'approval_round_trip_begin_result',
      'approval_round_trip_end',
      'approval_round_trip_end_result',
      'approval_round_trip_event',
    ];
    for (const name of expected) expect(names).toContain(name);
  });
  it('requires an explicit acknowledgement before the focus exception', () => {
    for (const kind of ['begin_result', 'end_result']) {
      const ack = {
        ...roundTripBinding,
        kind,
        accepted: true,
        failureReason: 'none',
        failureLatched: false,
      };
      expect(computerUseApprovalRoundTripWireSchema.safeParse(ack).success).toBe(true);
      expect(
        computerUseApprovalRoundTripWireSchema.safeParse({ ...ack, accepted: false }).success,
      ).toBe(false);
    }
  });
});

describe('P1b native producer parity', () => {
  it('pins every native fixture to the strict schema and rejects missing members', () => {
    const source = readFileSync(
      join(
        __dirname,
        '../../computer-use-native/computer_use_windows_approval_round_trip_wire_test.h',
      ),
      'utf8',
    );
    const fixtures: unknown[] = [...source.matchAll(/R"wire\((.*?)\)wire"/gu)].map((match) =>
      JSON.parse(match[1]!),
    );
    expect(fixtures).toHaveLength(8);
    for (const [index, fixture] of fixtures.entries()) {
      const parsed = computerUseApprovalRoundTripWireSchema.parse(fixture);
      if (index < roundTripMessages.length) expect(parsed).toEqual(roundTripMessages[index]);
      for (const key of Object.keys(parsed)) {
        const incomplete: Record<string, unknown> = { ...parsed };
        delete incomplete[key];
        expect(computerUseApprovalRoundTripWireSchema.safeParse(incomplete).success).toBe(false);
      }
      expect(
        computerUseApprovalRoundTripWireSchema.safeParse({ ...parsed, unknown: true }).success,
      ).toBe(false);
    }
    const harness = readFileSync(
      join(__dirname, '../../computer-use-native/computer_use_windows_approval_wire_test.h'),
      'utf8',
    );
    expect(harness).toContain('if (!CheckApprovalRoundTripWire()) return false;');
  });
  it('pins frame ids in C++ and TypeScript without changing existing ids', async () => {
    const protocol = await import('./computer-use-native-protocol');
    const source = readFileSync(
      join(__dirname, '../../computer-use-native/computer_use_protocol.h'),
      'utf8',
    );
    for (const [type, name, value] of [
      ['approval_round_trip_begin', 'Begin', 21],
      ['approval_round_trip_begin_result', 'BeginResult', 22],
      ['approval_round_trip_end', 'End', 23],
      ['approval_round_trip_end_result', 'EndResult', 24],
      ['approval_round_trip_event', 'Event', 25],
    ] as const) {
      expect(protocol.computerUseNativeMessageTypeValue(type)).toBe(value);
      expect(source).toContain(`kApprovalRoundTrip${name} = ${value},`);
      const frame = {
        messageType: type,
        flags: 0,
        requestId: protocol.newComputerUseNativeFrameId(),
        sessionId: protocol.newComputerUseNativeFrameId(),
        cancelId: null,
        metadata: Buffer.from('{}'),
        binary: Buffer.alloc(0),
      };
      expect(
        protocol.decodeComputerUseNativeFrame(protocol.encodeComputerUseNativeFrame(frame))
          .messageType,
      ).toBe(type);
    }
    expect(protocol.computerUseNativeMessageTypeValue('dispatch_approved_result')).toBe(20);
    expect(protocol.isKnownComputerUseNativeMessageType(26)).toBe(false);
  });
});

describe('P1b malformed wire rejection', () => {
  it('returns rejection rather than throwing for malformed process creation times', () => {
    for (const mainProcessStartTime of ['invalid', '1.5', '', '01', '18446744073709551616']) {
      expect(
        computerUseApprovalRoundTripWireSchema.safeParse({
          ...roundTripBegin,
          mainProcessStartTime,
        }).success,
      ).toBe(false);
    }
  });
  it('requires retained failure in rejected acknowledgements for native failure causes', () => {
    for (const kind of ['begin_result', 'end_result']) {
      const ack = {
        ...roundTripBinding,
        kind,
        accepted: false,
        failureReason: 'expired',
        failureLatched: true,
      };
      expect(computerUseApprovalRoundTripWireSchema.safeParse(ack).success).toBe(true);
      expect(
        computerUseApprovalRoundTripWireSchema.safeParse({ ...ack, failureLatched: false }).success,
      ).toBe(false);
    }
  });
});
