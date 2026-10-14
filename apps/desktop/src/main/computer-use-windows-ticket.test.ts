import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computerUseNativeMessageTypeValue } from './computer-use-native-protocol';

// Source contracts for the Windows helper's ordinary ticket (N2b-4 / ADR v2 S4-4 addendum 5, S5-a).
// The helper cannot run without a live window, so these tie the shape that keeps it correct: a
// preflight that cannot input, a dispatch that cannot start without a ticket, and a ticket that
// does not survive a session boundary.

const nativeDirectory = join(__dirname, '../../computer-use-native');
const host = readFileSync(join(nativeDirectory, 'computer_use_windows_host.cc'), 'utf8');
const protocolHeader = readFileSync(join(nativeDirectory, 'computer_use_protocol.h'), 'utf8');

function between(source: string, from: string, to: string): string {
  const start = source.lastIndexOf(from);
  expect(start, from).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(to, start + from.length);
  expect(end, to).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('Windows helper ordinary ticket (S5-a)', () => {
  it('names the preflight pair in the wire protocol on both sides', () => {
    expect(protocolHeader).toMatch(/kPreflight = 11,/u);
    expect(protocolHeader).toMatch(/kPreflightResult = 12,/u);
    expect(protocolHeader).toContain('MessageType::kPreflightResult);');
    expect(computerUseNativeMessageTypeValue('preflight')).toBe(11);
    expect(computerUseNativeMessageTypeValue('preflight_result')).toBe(12);
  });

  it('sends the Windows preflight as its own message under its own request key', () => {
    const windows = readFileSync(join(__dirname, 'computer-use-native-windows.ts'), 'utf8');
    expect(windows).toContain("'preflight',\n        'preflight',");
    expect(windows).toContain("`preflight:${stringField(value, 'requestId')}`");
    expect(windows).toContain("case 'preflight':\n      return 'preflight_result';");
  });

  it('makes no input call and caches nothing in the preflight', () => {
    const preflight = between(host, 'bool HandleWindowsPreflight(', 'bool ObserveWindowsWindow(');
    for (const forbidden of [
      'SendInput',
      'SendInputForBoundTarget',
      'SendUnicodeScalar',
      'SetCursorPos',
      'DispatchWindowsSemanticAction',
      'DispatchWindowsAction(',
      'input_api_attempts->fetch_add',
      'RespondAndCache',
    ])
      expect(preflight, forbidden).not.toContain(forbidden);
    // It only reads the response cache (to answer a finished request with a replay), never writes.
    expect(preflight).not.toMatch(/response_cache.(emplace|insert|erase|clear)/u);
    expect(preflight).toContain('response_cache.contains(');
    // It checks exactly what a dispatch checks, and answers under the preflight result type.
    expect(preflight).toContain('ValidateWindowsDispatchBinding(session, metadata');
    expect(preflight).toContain('MessageType::kPreflightResult');
    expect(preflight).toContain('kNativeOrdinaryTicketTtlNs');
    // A repeat must get a fresh ticket, so a new issue always burns the previous one first.
    expect(preflight.indexOf('state.slot.Invalidate()')).toBeLessThan(
      preflight.indexOf('state.slot.Issue('),
    );
  });

  it('shares one binding check between the preflight and the dispatch', () => {
    const dispatch = between(host, 'bool DispatchWindowsAction(', 'BackendProbe ProbeBackend(');
    expect(dispatch).toContain('ValidateWindowsDispatchBinding(session, metadata, &kind, &bounds');
    expect(host.match(/ValidateWindowsDispatchBinding\(/gu)).toHaveLength(3);
  });

  it('requires the ticket for every dispatch, after the replay answer and before any input', () => {
    const handler = between(host, 'bool HandlePipeRequest(', 'bool ServePipe(');
    const replay = handler.indexOf('ReplayCachedResponse(pipe, request, &replayed)');
    const dispatchCase = handler.indexOf('case MessageType::kDispatch: {');
    const consume = handler.indexOf('ConsumeWindowsDispatchTicket(', dispatchCase);
    const action = handler.indexOf('DispatchWindowsAction(', dispatchCase);
    expect(replay).toBeGreaterThanOrEqual(0);
    expect(replay).toBeLessThan(dispatchCase);
    expect(consume).toBeGreaterThan(dispatchCase);
    expect(consume).toBeLessThan(action);
    // The refusal is not cached, so the same request id can come back with a ticket.
    const refusal = handler.slice(consume, action);
    expect(refusal).toContain('Respond(pipe, request, MessageType::kError');
    expect(refusal).toContain('ErrorPayload("ticket_invalid")');
    expect(refusal).not.toContain('RespondAndCache');
  });

  it('burns the slot and advances the generation on every presented ticket', () => {
    const consume = between(
      host,
      'bool ConsumeWindowsDispatchTicket(',
      'bool DispatchWindowsAction(',
    );
    // No key at all: refused, slot untouched (same as the macOS native).
    expect(consume).toContain('!ReadJsonString(metadata, "ticket", &token)');
    const consumed = consume.indexOf('state.slot.Consume(');
    const invalidated = consume.indexOf('state.slot.Invalidate();');
    const advanced = consume.indexOf('++state.generation;');
    expect(consumed).toBeGreaterThan(0);
    expect(invalidated).toBeGreaterThan(consumed);
    expect(advanced).toBeGreaterThan(invalidated);
    // The binding carries the request, action, payload, window context, epoch and generation.
    const binding = between(
      host,
      'NativeOrdinaryTicketBinding WindowsTicketBinding(',
      'bool ConsumeWindowsDispatchTicket(',
    );
    for (const field of [
      'session_id',
      'request_id',
      'action_digest',
      'payload_digest',
      'context_digest',
      'cancel_epoch',
      'ticket_generation',
    ])
      expect(binding, field).toContain(`binding.${field}`);
  });

  it('drops the ticket at every session boundary', () => {
    const cancel = between(host, 'case MessageType::kCancel: {', 'case MessageType::kObserve: {');
    expect(cancel).toContain('InvalidateWindowsTicket(');
    // A new observation changes what a ticket was measured against, as on macOS.
    const observe = between(
      host,
      'case MessageType::kObserve: {',
      'case MessageType::kDispatch: {',
    );
    expect(observe).toContain('InvalidateWindowsTicket(FrameIdKey(request.header.session_id))');
    expect(observe.indexOf('InvalidateWindowsTicket(')).toBeLessThan(
      observe.indexOf('ObserveWindowsWindow('),
    );
    const start = between(host, 'bool StartWindowsSession(', 'bool CloseWindowsSession(');
    expect(start).toContain('InvalidateWindowsTicket(session_key)');
    const close = between(host, 'bool CloseWindowsSession(', 'std::string ProbeJson(');
    expect(close).toContain('ForgetWindowsTicket(session_key)');
  });

  it('draws the token from the system CSPRNG and the clock from a monotonic source', () => {
    expect(host).toContain('BCryptGenRandom(nullptr');
    expect(host).toContain('BCRYPT_USE_SYSTEM_PREFERRED_RNG');
    expect(host).toContain('std::chrono::steady_clock::now()');
  });

  it('keeps the receipt keys the Main parser expects', () => {
    const receipt = between(
      host,
      'std::string WindowsPreflightReceipt(',
      'bool HandleWindowsPreflight(',
    );
    for (const key of [
      'decision',
      'reasonCode',
      'deniedResult',
      'ticket',
      'classifierVersion',
      'inputAttemptCount',
      'requestId',
      'sessionId',
      'cancelEpoch',
      'observationRevision',
    ])
      expect(receipt, key).toContain(`\\"${key}\\"`);
    // Version 1 only: the Windows helper offers no approval and does not name that vocabulary.
    expect(receipt).toContain('kNativePreflightClassifierVersion');
    expect(host).not.toMatch(/single_use_approval|receiptVersion/u);
  });
});
