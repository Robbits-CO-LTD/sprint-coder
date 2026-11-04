import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseNativePreflightReceipt } from './computer-use-native-host';
import {
  computerUseNativeMessageTypeNames,
  computerUseNativeMessageTypeValue,
} from './computer-use-native-protocol';
import type { ComputerUseNativeSession } from './computer-use-controller';

const session: ComputerUseNativeSession = {
  sessionId: 'session-1',
  platform: 'win32',
  appIdentityDigest: 'a'.repeat(64),
  windowIdentityDigest: 'b'.repeat(64),
  windowId: 'window-1',
  profileRevision: 1,
  cancelEpoch: 0,
  policyLanguage: 'en',
  maximumMode: 'supervised',
  screenBounds: { x: 0, y: 0, width: 100, height: 100 },
};
const context = {
  session,
  requestId: 'request-1',
  observationRevision: 1,
  cancelEpoch: 0,
  expectedClassifierVersion: 3,
  windowsApproval: { route: 'v2', receiptVersion: 3 } as const,
};
const display = {
  effect: 'supervised_action',
  operation: 'click',
  targetLabel: 'Example',
  extension: null,
  externalApplication: 'not_applicable',
  unsignedWarning: 'none',
};
const receipt = {
  decision: 'single_use_approval',
  reasonCode: null,
  deniedResult: null,
  ticket: null,
  classifierVersion: 3,
  inputAttemptCount: 0,
  requestId: 'request-1',
  sessionId: 'session-1',
  cancelEpoch: 0,
  observationRevision: 1,
  receiptVersion: 3,
  approvalGeneration: 1,
  remainingMs: 60_000,
  effect: 'supervised_action',
  display,
};

describe('Windows approval wire contract', () => {
  it('binds ordinary and refusal producer versions to the session route and build attestation', () => {
    const source = readFileSync(
      new URL('../../computer-use-native/computer_use_windows_host_preflight.inc', import.meta.url),
      'utf8',
    );
    const producer = source.slice(
      source.indexOf('std::string WindowsPreflightReceipt('),
      source.indexOf('// The wire request id'),
    );
    expect(producer).toMatch(
      /session\.approval_route_v2\s*\? sprint_coder::computer_use::kNativeEligibilityClassifierVersion\s*: sprint_coder::computer_use::kNativePreflightClassifierVersion/u,
    );
  });

  it.each([1, 3])(
    'accepts ordinary and refused classifier %i receipts without relaxing version checks',
    (classifierVersion) => {
      const ordinary = {
        decision: 'ordinary',
        reasonCode: null,
        deniedResult: null,
        ticket: 'c'.repeat(64),
        classifierVersion,
        inputAttemptCount: 0,
        requestId: context.requestId,
        sessionId: session.sessionId,
        cancelEpoch: context.cancelEpoch,
        observationRevision: context.observationRevision,
      };
      const bound = { ...context, expectedClassifierVersion: classifierVersion };
      expect(parseNativePreflightReceipt(ordinary, bound)).toMatchObject({
        kind: 'ticket',
        ticket: ordinary.ticket,
      });
      expect(
        parseNativePreflightReceipt(
          {
            ...ordinary,
            decision: 'denied',
            reasonCode: 'native_stale_target',
            deniedResult: 'rejected',
            ticket: null,
          },
          bound,
        ),
      ).toMatchObject({ kind: 'refused', result: 'rejected' });
      expect(() =>
        parseNativePreflightReceipt(ordinary, {
          ...bound,
          expectedClassifierVersion: classifierVersion === 1 ? 3 : 1,
        }),
      ).toThrow('native_preflight_invalid');
    },
  );

  it('parses the exact C++ producer golden receipt', () => {
    const source = readFileSync(
      new URL('../../computer-use-native/computer_use_protocol_fuzz.cc', import.meta.url),
      'utf8',
    );
    const golden = source.match(/R"receipt\((.*?)\)receipt"/u)?.[1];
    expect(golden).toBeDefined();
    expect(parseNativePreflightReceipt(JSON.parse(golden!), context)).toMatchObject({
      kind: 'refused',
      approvalOffer: { display },
    });
  });
  it('reserves all three request/result pairs without changing existing numbers', () => {
    const names = computerUseNativeMessageTypeNames();
    for (const [name, value] of Object.entries({
      approval_approve: 15,
      approval_approve_result: 16,
      approval_discard: 17,
      approval_discard_result: 18,
      dispatch_approved: 19,
      dispatch_approved_result: 20,
    })) {
      const type = names.find((candidate) => candidate === name);
      expect(type).toBeDefined();
      if (type !== undefined) expect(computerUseNativeMessageTypeValue(type)).toBe(value);
    }
  });
  it('parses a v3 offer as a no-input pause and sanitizes display labels', () => {
    expect(
      parseNativePreflightReceipt(
        { ...receipt, display: { ...display, targetLabel: 'one\t\u202Etwo' } },
        context,
      ),
    ).toMatchObject({
      kind: 'refused',
      result: 'paused',
      approvalOffer: {
        effect: 'supervised_action',
        display: { ...display, targetLabel: 'one two' },
      },
    });
  });
  it('requires Windows, route v2, classifier 2 and declared receipt version 3', () => {
    const base = { session, requestId: 'request-1', observationRevision: 1, cancelEpoch: 0 };
    const undeclared = { ...base, expectedClassifierVersion: 3 };
    const unbound = { ...base, windowsApproval: context.windowsApproval };
    for (const input of [
      { ...context, session: { ...session, platform: 'darwin' as const } },
      undeclared,
      { ...context, windowsApproval: { route: 'v1' as const, receiptVersion: 3 } },
      { ...context, windowsApproval: { route: 'v2' as const, receiptVersion: 2 } },
      unbound,
      { ...context, expectedClassifierVersion: 1 },
    ])
      expect(() => parseNativePreflightReceipt(receipt, input)).toThrow();
  });
  it.each([undefined, context.windowsApproval])(
    'rejects a Windows v2 offer with approval capability %j',
    (windowsApproval) => {
      const value: Record<string, unknown> = { ...receipt, receiptVersion: 2 };
      delete value['display'];
      expect(() =>
        parseNativePreflightReceipt(value, {
          session,
          requestId: context.requestId,
          observationRevision: context.observationRevision,
          cancelEpoch: context.cancelEpoch,
          expectedClassifierVersion: context.expectedClassifierVersion,
          ...(windowsApproval === undefined ? {} : { windowsApproval }),
        }),
      ).toThrow('native_preflight_invalid');
    },
  );
  it('preserves a macOS v2 offer without display information', () => {
    const value: Record<string, unknown> = { ...receipt, receiptVersion: 2 };
    delete value['display'];
    expect(
      parseNativePreflightReceipt(value, {
        session: { ...session, platform: 'darwin' },
        requestId: context.requestId,
        observationRevision: context.observationRevision,
        cancelEpoch: context.cancelEpoch,
        expectedClassifierVersion: context.expectedClassifierVersion,
      }),
    ).toMatchObject({
      kind: 'refused',
      result: 'paused',
      approvalOffer: {
        kind: 'approval_required',
        approvalGeneration: 1,
        remainingMs: 60_000,
        effect: 'supervised_action',
        display: null,
      },
    });
  });
  it('rejects every missing key, unknown keys and invalid bounds', () => {
    for (const key of Object.keys(receipt)) {
      const value: Record<string, unknown> = { ...receipt };
      delete value[key];
      expect(() => parseNativePreflightReceipt(value, context), key).toThrow();
    }
    for (const patch of [
      { unknown: true },
      { remainingMs: 0 },
      { remainingMs: 60_001 },
      { remainingMs: 1.5 },
      { approvalGeneration: 0 },
      { approvalGeneration: Number.MAX_SAFE_INTEGER + 1 },
      { ticket: 'a'.repeat(64) },
      { inputAttemptCount: -1 },
      { inputAttemptCount: Number.MAX_SAFE_INTEGER + 1 },
      { decision: 'ordinary' },
      { decision: 'replay' },
      { receiptVersion: 4 },
      { effect: 'download_open' },
      { display: null },
    ])
      expect(() => parseNativePreflightReceipt({ ...receipt, ...patch }, context)).toThrow();
    for (const remainingMs of [1, 60_000])
      expect(parseNativePreflightReceipt({ ...receipt, remainingMs }, context)).toMatchObject({
        approvalOffer: { remainingMs },
      });
  });
  it('validates all four display effects and their required fields', () => {
    for (const effect of [
      'supervised_action',
      'high_impact_confirmation',
      'download_open',
      'file_manager_open',
    ]) {
      const open = effect === 'download_open' || effect === 'file_manager_open';
      const value = {
        ...receipt,
        effect,
        display: {
          ...display,
          effect,
          extension: open ? 'c++' : null,
          externalApplication: open ? 'may_open' : 'not_applicable',
        },
      };
      expect(parseNativePreflightReceipt(value, context)).toMatchObject({
        approvalOffer: {
          effect,
          display: value.display,
        },
      });
      for (const key of Object.keys(value.display)) {
        const incomplete: Record<string, unknown> = { ...value.display };
        delete incomplete[key];
        expect(() =>
          parseNativePreflightReceipt({ ...value, display: incomplete }, context),
        ).toThrow();
      }
      for (const patch of [
        { extra: true },
        { operation: 'observe' },
        { unsignedWarning: null },
        { targetLabel: 'x'.repeat(513) },
        { effect: 'invalid' },
      ])
        expect(() =>
          parseNativePreflightReceipt(
            { ...value, display: { ...value.display, ...patch } },
            context,
          ),
        ).toThrow();
      const empty = { ...value, display: { ...value.display, targetLabel: '\u115F' } };
      if (open) expect(() => parseNativePreflightReceipt(empty, context)).toThrow();
      else
        expect(parseNativePreflightReceipt(empty, context)).toMatchObject({
          approvalOffer: { display: { targetLabel: null } },
        });
    }
  });
});
