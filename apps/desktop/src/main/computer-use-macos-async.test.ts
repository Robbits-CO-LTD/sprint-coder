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
});
