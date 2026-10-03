import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  join(__dirname, '../../computer-use-native/computer_use_macos.mm'),
  'utf8',
);

function sourceBetween(start: string, end: string): string {
  const startOffset = source.indexOf(start);
  const endOffset = source.indexOf(end, startOffset + start.length);
  expect(startOffset, `missing source marker: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endOffset, `missing source marker: ${end}`).toBeGreaterThan(startOffset);
  return source.slice(startOffset, endOffset);
}

function sourceBetweenLast(start: string, end: string): string {
  const startOffset = source.lastIndexOf(start);
  const endOffset = source.indexOf(end, startOffset + start.length);
  expect(startOffset, `missing source marker: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endOffset, `missing source marker: ${end}`).toBeGreaterThan(startOffset);
  return source.slice(startOffset, endOffset);
}

describe('macOS Computer Use asynchronous native boundary', () => {
  it('keeps parsed validation and snapshot read-only while handing its lock to Dispatch', () => {
    const parse = sourceBetween(
      'bool ParseNativeDispatchRequest(',
      'bool ReserveNativeDispatchRequestLocked(',
    );
    expect(parse).toContain('std::unique_lock<std::mutex>& state_lock');
    expect(parse).toContain('state_lock = std::unique_lock<std::mutex>(session.state_mutex)');
    expect(parse).toContain('CurrentProcessGenerationMatches(session)');
    expect(parse).toContain('request->observation_revision != session.observation_revision');
    // The envelope is v2: payload digest before the lock, context digest from the locked snapshot.
    expect(parse).toContain('request->envelope_digest = StringDigest(envelope_input)');
    expect(parse).toContain('BuildNativeBindingPayloadInput(');
    expect(parse).toContain('BuildNativeBindingContextInput(');
    expect(parse.indexOf('StringDigest(payload_input)')).toBeGreaterThan(0);
    expect(parse.indexOf('StringDigest(payload_input)')).toBeLessThan(
      parse.indexOf('state_lock = std::unique_lock<std::mutex>(session.state_mutex)'),
    );
    expect(parse.indexOf('StringDigest(context_input)')).toBeGreaterThan(
      parse.indexOf('state_lock = std::unique_lock<std::mutex>(session.state_mutex)'),
    );
    expect(parse).not.toMatch(/"taskId"|"turnId"|"ticket"|napi_[a-z_]+\s*\(/u);
    const dispatchResult = sourceBetween('napi_value DispatchResultValue(', 'bool RiskOutcome(');
    expect(dispatchResult).not.toMatch(
      /task_id|turn_id|taskId|turnId|envelope_digest|context_digest|payload_digest/u,
    );
    expect(parse).not.toMatch(/dispatch_replay|inflight_dispatches/u);
    expect(parse).not.toMatch(/CGEventPost|AXUIElement(SetAttributeValue|PerformAction)/u);
  });

  it('binds immutable task and turn ids once at session creation and never on resume', () => {
    const start = sourceBetween('napi_value StartSession(', 'bool PerformNativeStartSession(');
    const worker = sourceBetween(
      'bool PerformNativeStartSession(AsyncNativeStartSessionWork* work) {',
      'void ExecuteNativeStartSession(napi_env env, void* data) {',
    );
    expect(start).toContain('ReadNamedString(env, argv[0], "taskId"');
    expect(start).toContain('ReadNamedString(env, argv[0], "turnId"');
    expect(start).toContain('IsValidNativeBindingId(request.task_id)');
    expect(start).toContain('NativeBindingIdsMatch(');
    expect(start).toContain('"SESSION_ID_REUSE"');
    expect(start.match(/session->task_id = request\.task_id/gu)).toHaveLength(1);
    expect(start.match(/session->turn_id = request\.turn_id/gu)).toHaveLength(1);
    expect(start.indexOf('session->task_id = request.task_id')).toBeLessThan(
      start.indexOf('mac_pending_sessions.emplace('),
    );
    expect(worker).not.toMatch(/task_id\s*=[^=]|turn_id\s*=[^=]/u);
    expect(source.match(/->task_id\s*=[^=]/gu)).toHaveLength(1);
    expect(source.match(/->turn_id\s*=[^=]/gu)).toHaveLength(1);
  });

  it('reserves exactly once under the same snapshot lock before creating deferred work', () => {
    const reserve = sourceBetween(
      'bool ReserveNativeDispatchRequestLocked(',
      'struct AsyncNativeDispatchWork {',
    );
    // The preflight reservation helpers sit between Dispatch and Cancel, so Dispatch ends there.
    const dispatch = sourceBetween('napi_value Dispatch(', 'bool ReserveNativePreflightLocked(');
    expect(reserve).toContain('const NativeDispatchRequest* request');
    expect(reserve).toContain('native_request_id_conflict');
    expect(reserve).toContain('native_request_in_flight');
    expect(reserve).toContain('native_dispatch_busy');
    expect(reserve.match(/inflight_dispatches.emplace\(/gu)).toHaveLength(1);
    expect(reserve).not.toMatch(/napi_|CGEventPost|AXUIElement(SetAttributeValue|PerformAction)/u);
    const lockedBlock = dispatch.slice(
      dispatch.indexOf('std::unique_lock<std::mutex> state_lock;'),
      dispatch.indexOf('if (!parsed)'),
    );
    expect(lockedBlock.indexOf('ParseNativeDispatchRequest(')).toBeGreaterThan(0);
    expect(lockedBlock.indexOf('ReserveNativeDispatchRequestLocked(')).toBeGreaterThan(
      lockedBlock.indexOf('ParseNativeDispatchRequest('),
    );
    expect(lockedBlock).not.toContain('unlock(');
    expect(lockedBlock.trimEnd()).toMatch(/\n {2}\}$/u);
    expect(dispatch.match(/ReserveNativeDispatchRequestLocked\(/gu)).toHaveLength(1);
    expect(dispatch.indexOf('if (!reserved) return DispatchResultValue')).toBeLessThan(
      dispatch.indexOf('napi_create_promise'),
    );
    expect(dispatch.match(/inflight_dispatches.erase\(work->request.request_id\)/gu)).toHaveLength(
      2,
    );
  });

  it.each([
    {
      callback: 'napi_value StartSession(',
      complete: 'void CompleteNativeStartSession(',
      execute: 'void ExecuteNativeStartSession(',
      resource: 'SprintCoderComputerUseStartSession',
      end: 'napi_value CloseSession(',
    },
    {
      callback: 'napi_value Observe(',
      complete: 'void CompleteNativeObservation(',
      execute: 'void ExecuteNativeObservation(',
      resource: 'SprintCoderComputerUseObserve',
      end: 'bool ReadNamedInt32(',
    },
  ])('queues $callback blocking native work away from the N-API callback thread', (markers) => {
    const callbackSource = sourceBetween(markers.callback, markers.end);
    const executeSource = sourceBetweenLast(markers.execute, markers.complete);

    expect(callbackSource).toContain('napi_create_promise');
    expect(callbackSource).toContain('napi_create_async_work');
    expect(callbackSource).toContain('napi_queue_async_work');
    expect(callbackSource).toContain(markers.resource);
    expect(executeSource).toContain(
      'std::lock_guard<std::mutex> serial_lock(mac_dispatch_serial_mutex)',
    );
    expect(executeSource).not.toMatch(/\bnapi_[a-z_]+\s*\(/u);
  });

  it('settles every deferred it created when the async work cannot be created or queued', () => {
    const sites = [...source.matchAll(/napi_create_promise\(env, &work->deferred, &promise\)/gu)];
    // StartSession, Observe, Dispatch and Preflight.
    expect(sites).toHaveLength(5);

    for (const site of sites) {
      const promiseOffset = site.index;
      const queueOffset = source.indexOf('napi_create_async_work', promiseOffset);
      const releaseOffset = source.indexOf('work.release();', promiseOffset);
      expect(queueOffset).toBeGreaterThan(promiseOffset);
      expect(releaseOffset).toBeGreaterThan(queueOffset);
      const queueSource = source.slice(queueOffset, releaseOffset);

      expect(queueSource).toContain('napi_queue_async_work');
      expect(queueSource).toContain(
        'if (work->work != nullptr) napi_delete_async_work(env, work->work);',
      );
      // The deferred exists from here on, so the failure path must settle it exactly once and hand
      // the caller the rejected Promise. Throwing instead would leave the Promise pending forever,
      // and rejecting plus throwing would report the same failure twice.
      expect(queueSource).toContain('NativeErrorValue(env, "ASYNC_UNAVAILABLE",');
      expect(queueSource).toContain('napi_reject_deferred(env, work->deferred, error);');
      expect(queueSource).toContain('return promise;');
      expect(queueSource).not.toContain('ThrowNativeError');
    }
  });

  it('lets cancel advance epochs without waiting for observation state publication', () => {
    const cancelSource = sourceBetween('napi_value Cancel(', 'napi_value Init(');
    const observeWorker = sourceBetweenLast(
      'void ExecuteNativeObservation(',
      'void CompleteNativeObservation(',
    );
    const observeComplete = sourceBetweenLast(
      'void CompleteNativeObservation(',
      'bool ReadNamedInt32(',
    );

    expect(cancelSource).toContain(
      'session->cancel_epoch.store(requested_cancel_epoch, std::memory_order_release)',
    );
    expect(cancelSource).not.toContain('state_mutex');
    expect(observeWorker.match(/ObservationCancellationStillValid\(/gu)?.length).toBeGreaterThan(4);
    expect(observeWorker).toContain('CaptureWindowPng');
    expect(observeWorker).toContain('std::lock_guard<std::mutex> state_lock');
    expect(observeWorker.lastIndexOf('ObservationCancellationStillValid(')).toBeGreaterThan(
      observeWorker.indexOf('std::lock_guard<std::mutex> state_lock'),
    );
    expect(observeComplete).toContain('if (!ObservationCancellationStillValid(*work))');
    expect(observeComplete).not.toContain(
      'work->error_code.empty() && !ObservationCancellationStillValid',
    );
  });

  it('confirms a closed session only from the resolved stop on the N-API thread', () => {
    const stopWorker = sourceBetween('void ExecuteNativeStop(', 'void CompleteNativeStop(');
    const stopComplete = sourceBetween('void CompleteNativeStop(', 'napi_value QueueNativeStop(');
    const closeSource = sourceBetween('napi_value CloseSession(', 'bool ReadWindowBounds(');

    // The closed-session registry is guarded by mac_sessions_mutex like the active session maps.
    // The stop worker runs with the serial dispatch lock held, so reaching the registry from there
    // would invert the lock order that every other session lookup follows.
    expect(stopWorker).not.toContain('mac_closed_sessions');
    expect(stopWorker).not.toContain('ConfirmClosedMacSession');
    // Only the branch that resolves the stop may confirm the close, so assert on the branches
    // themselves rather than on the order the three calls appear in: a confirmation added next to
    // the rejection keeps that order while handing a repeat close a drain that never ran.
    const teardownGuard = 'if (env == nullptr) return;';
    const unconfirmedGuard = 'if (status != napi_ok || !work->drained) {';
    const confirmedGuard = '\n  } else {';
    expect(stopComplete).toContain(teardownGuard);
    expect(stopComplete).toContain(unconfirmedGuard);
    expect(stopComplete.split(confirmedGuard)).toHaveLength(2);
    const beforeTeardownGuard = stopComplete.slice(0, stopComplete.indexOf(teardownGuard));
    const unconfirmedBranch = stopComplete.slice(
      stopComplete.indexOf(unconfirmedGuard),
      stopComplete.indexOf(confirmedGuard),
    );
    const confirmedBranch = stopComplete.slice(stopComplete.indexOf(confirmedGuard));
    // A completion delivered while the environment is tearing down answers nothing, so it must
    // not leave a confirmation behind either.
    expect(beforeTeardownGuard).not.toContain('ConfirmClosedMacSession');
    // The unconfirmed drain rejects and stays re-drainable.
    expect(unconfirmedBranch).toContain('napi_reject_deferred');
    expect(unconfirmedBranch).not.toContain('ConfirmClosedMacSession');
    // The confirmation exists exactly once, inside the resolved branch, ahead of the receipt.
    expect(stopComplete.match(/ConfirmClosedMacSession\(/gu)).toHaveLength(1);
    expect(confirmedBranch).not.toContain('napi_reject_deferred');
    expect(confirmedBranch.indexOf('ConfirmClosedMacSession(')).toBeGreaterThan(0);
    expect(confirmedBranch.indexOf('napi_resolve_deferred')).toBeGreaterThan(
      confirmedBranch.indexOf('ConfirmClosedMacSession('),
    );
    // The session leaves the active maps exactly as before, and the registry records it under the
    // same lock so a repeat close for that id is answerable.
    expect(closeSource.indexOf('RememberClosingMacSession(')).toBeGreaterThan(
      closeSource.indexOf('mac_sessions.erase(session_id);'),
    );
    expect(closeSource.match(/RememberClosingMacSession\(/gu)).toHaveLength(2);
    expect(closeSource).toContain('ThrowNativeError(env, "SESSION_MISSING"');
  });

  it('captures the start epoch before queueing so a pre-worker cancel is not absorbed', () => {
    const startCallback = sourceBetween(
      'napi_value StartSession(',
      'bool PerformNativeStartSession(',
    );
    const startWorker = sourceBetween(
      'bool PerformNativeStartSession(',
      'void ExecuteNativeStartSession(napi_env env, void* data) {',
    );
    const startComplete = sourceBetweenLast(
      'void CompleteNativeStartSession(',
      'napi_value CloseSession(',
    );

    expect(startCallback).toContain('work->start_cancel_epoch = current_cancel_epoch');
    expect(startCallback).toContain(
      'work->start_cancel_epoch =\n          work->session->cancel_epoch.load',
    );
    expect(startWorker).toContain(
      'const std::uint64_t start_cancel_epoch = work->start_cancel_epoch',
    );
    expect(startComplete).toContain('result_cancel_epoch != work->start_cancel_epoch');
  });

  it('emits fail-closed maximum mode and target-global bounds on window-bound mac responses', () => {
    expect(source).toContain('MaximumModeForIdentityFacts');
    expect(source).toContain('com.apple.TextEdit');
    expect(source).toContain('/System/Applications/TextEdit.app/Contents/MacOS/TextEdit');
    expect(source).toContain('com.microsoft.VSCode');
    expect(source).toContain('UBF8T346G9');
    expect(source.match(/"maximumMode"/gu)?.length).toBeGreaterThanOrEqual(4);
    expect(source.match(/SetScreenBoundsProperty\(/gu)?.length).toBeGreaterThanOrEqual(4);
    expect(source).toContain('SetScreenBoundsProperty(env, candidate, bounds)');
    expect(source).toContain('work->screen_bounds = activation_bounds');
    expect(source).toContain('work->screen_bounds = work->observation_bounds');
  });

  it('rejects an unknown signed-looking app instead of granting eligibility by absence from a denylist', () => {
    const eligibility = sourceBetween(
      'bool IsMacComputerUseApplicationEligible(NSString* bundle_id_string,',
      'bool IsMacComputerUseApplicationEligible(NSRunningApplication* application)',
    );

    const unknownSignedLookingApp = {
      bundleId: 'com.example.SignedEditor',
      displayName: 'Visual Studio Code Helper',
      executablePath: '/Applications/Signed Editor.app/Contents/MacOS/Signed Editor',
      teamId: 'NOTMICROSOFT',
    };
    expect(unknownSignedLookingApp).not.toMatchObject({
      bundleId: 'com.apple.TextEdit',
    });
    expect(unknownSignedLookingApp).not.toMatchObject({
      bundleId: 'com.microsoft.VSCode',
      teamId: 'UBF8T346G9',
    });
    for (const untrustedFact of Object.values(unknownSignedLookingApp)) {
      expect(eligibility).not.toContain(untrustedFact);
    }
    expect(eligibility).toContain('IsExactSystemTextEdit');
    expect(eligibility).toContain('IsOfficialMicrosoftVisualStudioCode');
    expect(eligibility).toContain('return false');
    expect(eligibility).not.toContain('ineligible_names');
    expect(eligibility).not.toMatch(/return true;\s*\}/u);
  });

  it('binds every live macOS window and session to the exact process generation', () => {
    expect(source).toContain('#include <libproc.h>');
    expect(source).toContain('bool ReadProcessGenerationToken(');
    expect(source).toContain('proc_pidinfo(');
    expect(source).toContain('PROC_PIDTBSDINFO');
    expect(source).toContain('process_info.pbi_start_tvsec');
    expect(source).toContain('process_info.pbi_start_tvusec');
    expect(source).toContain('std::string process_generation;');

    const windowIdentity = sourceBetween(
      'std::string ComputerWindowIdentityDigest(',
      'napi_value ListWindows(',
    );
    expect(windowIdentity).toContain('std::string_view process_generation');
    expect(windowIdentity).toContain('std::string(process_generation)');

    const listWindows = sourceBetween(
      'napi_value ListWindows(',
      'bool ReadAccessibilityWindowBounds(',
    );
    expect(listWindows).toContain('ReadProcessGenerationToken(pid, &process_generation)');
    expect(listWindows).toContain(
      'ComputerWindowIdentityDigest(\n        app_identity, process_generation,',
    );

    const startWorker = sourceBetween(
      'bool PerformNativeStartSession(AsyncNativeStartSessionWork* work) {',
      'void ExecuteNativeStartSession(napi_env env, void* data) {',
    );
    expect(startWorker).toContain('ReadProcessGenerationToken(pid, &process_generation)');
    expect(startWorker).toContain('existing_session->process_generation != process_generation');
    expect(startWorker).toContain('native_session->process_generation = process_generation');

    const observeWorker = sourceBetweenLast(
      'void ExecuteNativeObservation(',
      'void CompleteNativeObservation(',
    );
    expect(observeWorker.match(/CurrentProcessGenerationMatches\(/gu)?.length).toBeGreaterThan(1);

    const dispatchValidation = sourceBetween(
      'NativeTargetValidation RevalidateBoundTarget(',
      'void CacheDispatchOutcome(',
    );
    expect(dispatchValidation).toContain('CurrentProcessGenerationMatches(*session)');
    expect(source).not.toContain('"processGeneration"');
  });

  it('posts scroll only after binding the event and fresh checks to the exact normalized point', () => {
    const scrollDispatch = sourceBetween(
      'CGEventRef event = CGEventCreateScrollWheelEvent(',
      'validation = RevalidateBoundTarget(request);',
    );
    expect(scrollDispatch).toContain('CGEventSetLocation(event, point)');
    expect(scrollDispatch).toContain('RevalidateVisualPointBeforePost(request, point, &outcome)');
    expect(scrollDispatch.indexOf('CGEventSetLocation(event, point)')).toBeLessThan(
      scrollDispatch.indexOf('RevalidateVisualPointBeforePost(request, point, &outcome)'),
    );
    expect(
      scrollDispatch.indexOf('RevalidateVisualPointBeforePost(request, point, &outcome)'),
    ).toBeLessThan(scrollDispatch.indexOf('CGEventPostToPid('));

    const pointValidation = sourceBetween(
      'bool RevalidateVisualPointBeforePost(',
      'NativeDispatchOutcome PerformVisualDispatch(',
    );
    expect(pointValidation).toContain('RevalidateBoundTarget(request)');
    expect(pointValidation).toContain('ClassifyElementAtPoint(request.session->pid, point');
    expect(pointValidation).toContain('RiskOutcome(risk, failure)');
    expect(pointValidation).toContain(
      'request.visual_control_signatures.contains(control_signature)',
    );
    expect(pointValidation).toContain('FreshVisualPatchMatches(request, failure)');
    expect(pointValidation).toContain('DispatchCancellationStillValid(request)');
  });

  it('reclassifies a click point after the fresh visual capture and immediately before mouse-down', () => {
    const clickDispatch = sourceBetween(
      'if (request.kind == "click") {',
      'CGEventRef event = CGEventCreateScrollWheelEvent(',
    );

    expect(clickDispatch).toContain('RevalidateVisualPointBeforePost(request, point, &outcome)');
    expect(
      clickDispatch.indexOf('RevalidateVisualPointBeforePost(request, point, &outcome)'),
    ).toBeLessThan(clickDispatch.indexOf('CGEventPostToPid('));
    expect(clickDispatch).not.toContain('FreshVisualPatchMatches(request, &outcome)');
  });

  // Issue #500 N2a: native preflight and the single-use ordinary ticket. These are static source
  // contracts. They do not execute the addon and are not native macOS evidence.
  describe('N2a native preflight and ordinary ticket source contracts', () => {
    const sha = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

    it('exports preflight from Init as a default (non-writable) property next to dispatch', () => {
      const init = sourceBetween('napi_value Init(', 'NAPI_MODULE(');
      expect(init).toContain(
        '{"preflight", nullptr, Preflight, nullptr, nullptr, nullptr, napi_default, nullptr},',
      );
      expect(init.indexOf('"dispatch"')).toBeLessThan(init.indexOf('"preflight"'));
      expect(init.match(/napi_default/gu)).toHaveLength(10);
      expect(init).not.toMatch(/napi_(writable|enumerable|configurable)/u);
    });

    it('performs no effect, no activation and no input attempt increment while measuring', () => {
      const preflight = sourceBetween(
        '// Preflight composed only from existing read-only guards.',
        'bool GenerateOrdinaryTicketToken(',
      );
      const callbacks = sourceBetween('bool ReserveNativePreflightLocked(', 'napi_value Cancel(');
      for (const part of [preflight, callbacks]) {
        expect(part).not.toMatch(
          /CGEventPost|CGEventCreate|AXUIElementPerformAction|AXUIElementSetAttributeValue|input_api_attempts|ActivateAndRaise|activateWithOptions|NSRunningApplication/u,
        );
        expect(part).not.toMatch(/Perform(Native|Semantic|Visual|FocusedInput)Dispatch\(/u);
      }
      // A subset of the dispatch guards, never described as identical to them.
      expect(preflight).toContain('SUBSET of the dispatch');
      expect(preflight).toContain('RevalidateBoundTarget(request)');
      expect(preflight).toContain('FindBoundSemanticTarget(request, &risk, &outcome)');
      expect(preflight).toContain('CFRelease(target)');
      expect(preflight).toContain('ClassifyElementAtPoint(request.session->pid, point');
      expect(preflight).toContain('FreshVisualPatchMatches(request, &outcome)');
      expect(preflight).toContain('ClassifyFocusedElement(request.session->pid');
      expect(preflight).toContain('RiskOutcome(risk, &outcome)');
      expect(preflight).toContain('request.visual_control_signatures.contains(control_signature)');
      expect(preflight).toContain('current_control_signature != request.focused_control_signature');
    });

    it('leaves the dispatch effect functions byte-for-byte as they were before N2a', () => {
      // If N2b has to change these, update the expected digests together with a reviewed diff.
      const spans: Array<[string, string, string]> = [
        [
          'NativeDispatchOutcome PerformSemanticDispatch(',
          'bool FreshVisualPatchMatches(',
          'ae3c160379352bb3',
        ],
        [
          'NativeDispatchOutcome PerformVisualDispatch(',
          'NativeDispatchOutcome PerformFocusedInputDispatch(',
          '202ab7a471e750e0',
        ],
        [
          'NativeDispatchOutcome PerformFocusedInputDispatch(',
          'NativeDispatchOutcome PerformNativeDispatch(',
          '8f0351989686557e',
        ],
        [
          'NativeDispatchOutcome PerformNativeDispatch(',
          '// Preflight composed only from existing read-only guards.',
          '3d7a494a5c4a3d77',
        ],
      ];
      for (const [start, end, digest] of spans) {
        expect(sha(sourceBetween(start, end).replaceAll('\r\n', '\n'))).toBe(digest);
      }
    });

    it('reads the own ticket key outside Parse and outside the state lock, as plain values', () => {
      const reader = sourceBetween('bool ReadNativeTicketKey(', 'napi_value NullableStringValue(');
      expect(reader).toContain('napi_has_own_property(env, object, key, &present)');
      expect(reader).not.toMatch(/napi_has_property|napi_get_prototype|napi_get_property_names/u);
      expect(reader).toContain('output->present = present;');
      expect(reader).toContain('kNativeOrdinaryTicketTokenChars');
      for (const [start, end] of [
        ['napi_value Dispatch(', 'bool ReserveNativePreflightLocked('],
        ['napi_value Preflight(', 'napi_value Cancel('],
      ] as const) {
        const callback = sourceBetween(start, end);
        expect(
          callback.indexOf('ReadNativeTicketKey(env, argv[0], &work->request.ticket_key)'),
        ).toBeGreaterThan(0);
        expect(callback.indexOf('ReadNativeTicketKey(')).toBeLessThan(
          callback.indexOf('std::unique_lock<std::mutex> state_lock;'),
        );
        // No N-API call may run inside the locked block.
        const locked = callback.slice(
          callback.indexOf('std::unique_lock<std::mutex> state_lock;'),
          callback.indexOf('if (!parsed)'),
        );
        expect(locked.replace('ParseNativeDispatchRequest(env,', '')).not.toMatch(
          /\bnapi_[a-z_]+\s*\(/u,
        );
        expect(locked).not.toContain('ReadNativeTicketKey(');
      }
      // The legacy path is only taken when the key is absent: Reserve branches on presence.
      const reserve = sourceBetween(
        'bool ReserveNativeDispatchRequestLocked(',
        'struct AsyncNativeDispatchWork {',
      );
      expect(reserve).toContain('if (request->ticket_key.present) {');
      const preflight = sourceBetween('napi_value Preflight(', 'napi_value Cancel(');
      expect(preflight).toContain('if (work->request.ticket_key.present)');
    });

    it('orders Reserve as replay, in-flight, ticket consume, busy, insert', () => {
      const reserve = sourceBetween(
        'bool ReserveNativeDispatchRequestLocked(',
        'struct AsyncNativeDispatchWork {',
      );
      const order = [
        'session.dispatch_replay_cache.find(',
        'session.inflight_dispatches.find(',
        'if (request->ticket_key.present) {',
        'session.ordinary_ticket.Consume(',
        'native_ticket_invalid',
        'kMaxInflightDispatchEntries',
        'inflight_dispatches.emplace(',
      ].map((marker) => reserve.indexOf(marker));
      expect(order.every((offset) => offset > 0)).toBe(true);
      expect([...order].sort((left, right) => left - right)).toEqual(order);
      expect(reserve).toContain('expected.payload_digest = request->payload_digest');
      expect(reserve).toContain('expected.context_digest = request->context_digest');
      expect(reserve).toContain('expected.ticket_generation = session.ticket_generation.load(');
      expect(reserve).toContain(
        'session.cancel_epoch.load(std::memory_order_acquire) != request->cancel_epoch',
      );
      // Replay and in-flight returns must not touch the ticket slot.
      const beforeTicket = reserve.slice(0, reserve.indexOf('if (request->ticket_key.present) {'));
      expect(beforeTicket).not.toMatch(/ordinary_ticket|ticket_generation/u);
      // N2b note: a ticket-required rule belongs after the replay/in-flight checks.
      expect(reserve).toContain('N2b note');
    });

    it('advances the ticket generation on cancel, close, observe, start and every issue', () => {
      const cancel = sourceBetween('napi_value Cancel(', 'napi_value Init(');
      expect(cancel).toContain(
        'session->ticket_generation.fetch_add(1, std::memory_order_acq_rel)',
      );
      expect(cancel).not.toMatch(/state_mutex|lock_guard|unique_lock|ordinary_ticket/u);
      expect(cancel.indexOf('ticket_generation.fetch_add')).toBeLessThan(
        cancel.indexOf('session->cancel_epoch.store('),
      );
      const close = sourceBetween('napi_value CloseSession(', 'bool ReadWindowBounds(');
      expect(close).toContain('session->ticket_generation.fetch_add(1, std::memory_order_acq_rel)');
      expect(close.indexOf('ticket_generation.fetch_add')).toBeLessThan(
        close.indexOf('session->cancel_epoch.store('),
      );
      const drain = sourceBetween('void ExecuteNativeStop(', 'void CompleteNativeStop(');
      expect(drain).toContain('work->session->ordinary_ticket.Invalidate();');
      expect(drain).toContain('work->session->preflight_owner = 0;');
      const helper = sourceBetween(
        'void AdvanceTicketGenerationLocked(',
        'constexpr std::size_t kMaxDispatchReplayEntries',
      );
      expect(helper).toContain('ticket_generation.fetch_add(1, std::memory_order_acq_rel)');
      expect(helper).toContain('ordinary_ticket.Invalidate()');
      // Observe publication and StartSession resume/refocus advance it under the state lock.
      const observeWorker = sourceBetweenLast(
        'void ExecuteNativeObservation(',
        'void CompleteNativeObservation(',
      );
      expect(observeWorker).toContain('AdvanceTicketGenerationLocked(session);');
      expect(
        observeWorker.lastIndexOf(
          'std::lock_guard<std::mutex> state_lock(session.state_mutex);',
          observeWorker.indexOf('AdvanceTicketGenerationLocked(session);'),
        ),
      ).toBeGreaterThan(0);
      const startWorker = sourceBetween(
        'bool PerformNativeStartSession(AsyncNativeStartSessionWork* work) {',
        'void ExecuteNativeStartSession(napi_env env, void* data) {',
      );
      expect(startWorker).toContain('AdvanceTicketGenerationLocked(*existing_session);');
      expect(
        startWorker.lastIndexOf(
          'std::lock_guard<std::mutex> state_lock(existing_session->state_mutex);',
          startWorker.indexOf('AdvanceTicketGenerationLocked(*existing_session);'),
        ),
      ).toBeGreaterThan(0);
      // Reservation, preflight reservation and issue all advance or check the same counter.
      expect(
        source.match(/ticket_generation\.fetch_add\(1, std::memory_order_acq_rel\)/gu)!.length,
      ).toBeGreaterThanOrEqual(5);
    });

    it('issues in the worker under the state lock with the three conditions, and only the owner releases', () => {
      const callbacks = sourceBetween('bool ReserveNativePreflightLocked(', 'napi_value Cancel(');
      const issue = sourceBetween(
        'NativePreflightReceipt IssueOrdinaryTicket(',
        'void ExecuteNativePreflight(',
      );
      expect(issue).toContain('std::lock_guard<std::mutex> state_lock(session.state_mutex);');
      expect(issue).toContain('DispatchCancellationStillValid(request)');
      expect(issue).toContain('session.preflight_owner != owner');
      expect(issue).toContain('session.ticket_generation.load(std::memory_order_acquire) != owner');
      expect(issue).toContain('ticket_binding.ticket_generation = owner;');
      expect(issue.indexOf('DispatchCancellationStillValid(request)')).toBeLessThan(
        issue.indexOf('ReadNativeMonotonicNs(&now_ns)'),
      );
      expect(issue).toContain('kNativeOrdinaryTicketTtlNs');
      // The issue never happens in the completion callback or the N-API callback.
      const complete = sourceBetween('void CompleteNativePreflight(', 'napi_value Preflight(');
      expect(complete).not.toMatch(
        /IssueOrdinaryTicket|ordinary_ticket\.Issue|GenerateOrdinaryTicketToken/u,
      );
      expect(callbacks.match(/IssueOrdinaryTicket\(/gu)).toHaveLength(2);
      const release = sourceBetween(
        'void ReleaseNativePreflightOwner(',
        'NativePreflightReceipt IssueOrdinaryTicket(',
      );
      expect(release).toContain(
        'if (request.session->preflight_owner == owner) request.session->preflight_owner = 0;',
      );
      expect(release).toContain('InvalidateIfGeneration(owner)');
      // Every failure route releases: promise, create, queue, completion and worker exception.
      const preflight = sourceBetween('napi_value Preflight(', 'napi_value Cancel(');
      expect(
        preflight.match(/ReleaseNativePreflightOwner\(work->request, work->owner, true\)/gu),
      ).toHaveLength(2);
      expect(complete).toContain('if (status != napi_ok) {');
      expect(complete).toContain('ReleaseNativePreflightOwner(work->request, work->owner, true)');
      const execute = sourceBetween(
        'void ExecuteNativePreflight(',
        'void CompleteNativePreflight(',
      );
      expect(execute).toContain('catch (...) {');
      expect(execute).toContain('native_preflight_exception');
      expect(execute).not.toContain('unknown_effect');
      expect(execute).toContain(
        'std::lock_guard<std::mutex> serial_lock(mac_dispatch_serial_mutex);',
      );
      expect(execute).not.toMatch(/\bnapi_[a-z_]+\s*\(/u);
    });

    it('draws entropy only from SecRandomCopyBytes, reads a raw monotonic clock and never leaks secrets', () => {
      const generator = sourceBetween(
        'bool GenerateOrdinaryTicketToken(',
        'bool ReadNativeMonotonicNs(',
      );
      expect(generator).toContain('SecRandomCopyBytes(kSecRandomDefault, sizeof(bytes), bytes)');
      expect(generator).toContain('unsigned char bytes[32]');
      expect(generator).not.toMatch(
        /\brand\(|arc4random|std::random|mt19937|random_device|time\(/u,
      );
      // No fallback: a failure returns false before any token exists.
      expect(generator).toContain('return false;');
      const clock = sourceBetween('bool ReadNativeMonotonicNs(', 'bool ReadNativeTicketKey(');
      expect(clock).toContain('clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW)');
      expect(source).not.toMatch(
        /std::chrono::system_clock|gettimeofday|CFAbsoluteTimeGetCurrent|NSDate/u,
      );
      const receipt = sourceBetween('napi_value PreflightReceiptValue(', 'bool ReadNamedBool(');
      expect(receipt).not.toMatch(
        /payload_digest|context_digest|envelope_digest|action_digest|task_id|turn_id/u,
      );
      expect(receipt.match(/"[a-zA-Z]+"/gu)).toEqual([
        '"decision"',
        '"reasonCode"',
        '"deniedResult"',
        '"ticket"',
        '"classifierVersion"',
        '"inputAttemptCount"',
        '"requestId"',
        '"sessionId"',
        '"cancelEpoch"',
        '"observationRevision"',
      ]);
      expect(source).not.toContain('single_use_approval');
      expect(source).not.toContain('SingleUseApproval');
      const dispatchResult = sourceBetween('napi_value DispatchResultValue(', 'bool RiskOutcome(');
      expect(dispatchResult).not.toMatch(/ticket/u);
      // The presented secret is scrubbed right after the reservation and a minted one after use.
      const dispatch = sourceBetween('napi_value Dispatch(', 'bool ReserveNativePreflightLocked(');
      expect(dispatch).toContain('ScrubNativeTicketString(&work->request.ticket_key.token)');
      expect(source).toContain('ScrubNativeTicketString(&work->receipt.ticket)');
    });

    it('keeps every returned preflight reason inside the closed receipt table', () => {
      const table = sourceBetween(
        'constexpr NativePreflightDeniedEntry kNativePreflightDeniedTable[] = {',
        'NativePreflightReceipt MakeDeniedReceipt(',
      );
      const tableReasons = new Set(
        [...table.matchAll(/\{"(native_[a-z_]+)", "(rejected|paused|canceled)"\}/gu)].map(
          (match) => match[1] ?? '',
        ),
      );
      const classifier = new Set([
        'native_secure_field_blocked',
        'native_high_impact_user_takeover',
        'native_target_unclassified',
      ]);
      // Every reason literal produced by a function preflight can reach must be in the table or
      // be one of the three classifier reasons mapped to blocked/takeover.
      const outcomeForValidation = sourceBetween(
        'NativeDispatchOutcome OutcomeForValidation(',
        'bool DispatchCancellationStillValid(',
      );
      const outcomeForValidationSwitch = outcomeForValidation.slice(
        outcomeForValidation.indexOf('switch (validation) {'),
      );
      const reachable = [
        // effect_started is always false for preflight, so only the switch table is reachable.
        outcomeForValidationSwitch,
        sourceBetween('bool RiskOutcome(', 'AXUIElementRef FindBoundSemanticTarget('),
        sourceBetween(
          'AXUIElementRef FindBoundSemanticTarget(',
          'NativeDispatchOutcome PerformSemanticDispatch(',
        ),
        sourceBetween('bool FreshVisualPatchMatches(', 'bool RevalidateVisualPointBeforePost('),
        sourceBetween(
          'NativePreflightReceipt PerformNativePreflight(',
          'bool GenerateOrdinaryTicketToken(',
        ),
        sourceBetween('bool ReserveNativePreflightLocked(', 'struct AsyncNativePreflightWork {'),
        sourceBetween('NativePreflightReceipt IssueOrdinaryTicket(', 'napi_value Preflight('),
      ].join('\n');
      const literals = new Set(
        [...reachable.matchAll(/"(native_[a-z_]+)"/gu)].map((m) => m[1] ?? ''),
      );
      expect(literals.size).toBeGreaterThan(20);
      for (const reason of literals) {
        expect(tableReasons.has(reason) || classifier.has(reason), reason).toBe(true);
      }
      // The legacy-only effect reasons stay out of the table.
      for (const forbidden of [
        'native_input_effect_unknown',
        'native_dispatch_exception_unknown_effect',
        'native_async_completion_unknown_effect',
        'native_ticket_invalid',
      ]) {
        expect(tableReasons.has(forbidden)).toBe(false);
      }
      // An unknown tuple is replaced by a closed denial before it leaves native code.
      expect(source).toContain('SealNativePreflightReceipt(&work->receipt);');
      expect(source).toContain('SealNativePreflightReceipt(&denied);');
    });
  });
});
