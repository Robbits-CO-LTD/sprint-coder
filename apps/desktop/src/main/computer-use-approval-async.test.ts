import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Classifier v2, C4-2b: approvalApprove and dispatchApproved run as asynchronous work, and an
// approval is measured on the serial lane. The rules are source contracts here (the behaviour of
// the real code is driven in the cancel-seam test, on macOS): no N-API call under the state lock,
// no tree read under the state lock, N-API values made on the JS thread only, and the measurement
// gated by the session's route.

const nativeDirectory = join(__dirname, '../../computer-use-native');
const macos = readFileSync(join(nativeDirectory, 'computer_use_macos.mm'), 'utf8');

/** The text of one top-level function: from its signature to the closing brace at column 0. */
function fn(signature: string): string {
  const from = macos.indexOf(signature);
  expect(from, signature).toBeGreaterThanOrEqual(0);
  const to = macos.indexOf('\n}\n', from);
  expect(to, signature).toBeGreaterThan(from);
  return macos.slice(from, to + 2);
}

const code = (text: string): string =>
  text.replace(/\/\/.*$/gmu, '').replace(/"(?:[^"\\]|\\.)*"/gu, '""');

const approveJs = (): string => fn('napi_value ApprovalApprove(');
const dispatchJs = (): string => fn('napi_value DispatchApproved(');
const approveWorker = (): string => fn('void ExecuteNativeApprovalApprove(');
const approveComplete = (): string => fn('void CompleteNativeApprovalApprove(');
const dispatchWorker = (): string => fn('void ExecuteNativeApprovedDispatch(');

/** The block that holds the state lock in a JS-thread function: from its declaration to the close. */
function lockedBlock(text: string): string {
  const from = text.indexOf('std::unique_lock<std::mutex> state_lock;');
  expect(from).toBeGreaterThan(0);
  const to = text.indexOf('\n  }\n', from);
  expect(to).toBeGreaterThan(from);
  return text.slice(from, to);
}

describe('Computer Use approval async work (classifier v2, C4-2b)', () => {
  it('measures only a session bound to route v2, with the version’s own rule set and the build’s attest', () => {
    const measure = fn('MeasureNativeApproval(const NativeDispatchRequest& request) {');
    expect(measure).toContain('request.session->classifier_route != "v2") return {};');
    expect(measure).toContain('MeasureNativeApprovalOnLane(request,');
    expect(measure).toContain('sprint_coder::computer_use::kNativePreflightClassifierVersion');
    // Nothing else decides by the route, and the attest is the preflight's version (1), not 2.
    expect(macos).not.toContain('kNativeApprovalClassifierVersion);');
    expect(macos).not.toContain('single_use_approval');
  });

  it('keeps the JS-thread halves free of the tree and of the flow transitions', () => {
    for (const text of [approveJs(), dispatchJs()]) {
      const body = code(text);
      expect(body).not.toMatch(
        /MeasureNativeApproval|MeasureNativeApprovalOnLane|\.Approve\(|\.ConsumeApproved\(|AXUIElement|CaptureShadow|PerformNativeDispatch|mac_dispatch_serial_mutex/u,
      );
    }
    // The transitions happen on the workers only.
    expect(code(approveWorker())).toContain('session.approval.Approve(');
    expect(code(dispatchWorker())).toContain('session.approval.ConsumeApproved(');
    expect(macos.match(/\.Approve\(/gu)).toHaveLength(1);
    expect(macos.match(/\.ConsumeApproved\(/gu)).toHaveLength(1);
  });

  it('calls no N-API function while the state lock is held', () => {
    for (const text of [approveJs(), dispatchJs()]) {
      const block = code(lockedBlock(text));
      // Parsing is the one call that takes the env, and it is the production parser that leaves the
      // lock held for its caller; nothing else in the block is an N-API call.
      expect(block.replace('ParseNativeDispatchRequest(env,', '')).not.toMatch(
        /napi_|StringValue|NumberValue|BoolValue|NullableStringValue|NativeErrorValue|ThrowNativeError|ApprovalApproveReceiptValue|DispatchResultValue/u,
      );
    }
    // And the rollbacks that take the lock again do so without an N-API call inside it.
    for (const text of [approveJs(), dispatchJs()]) {
      for (const match of text.matchAll(
        /std::lock_guard<std::mutex> state_lock\([^)]*\);[\s\S]*?\n {4}\}/gu,
      ))
        expect(code(match[0])).not.toMatch(/napi_|ThrowNativeError|NativeErrorValue/u);
    }
  });

  it('measures on the worker, on the serial lane, with no state lock held', () => {
    for (const text of [approveWorker(), dispatchWorker()]) {
      const body = code(text);
      expect(body.replaceAll('napi_env', '')).not.toMatch(/napi_/u);
      const serial = body.indexOf(
        'std::lock_guard<std::mutex> serial_lock(mac_dispatch_serial_mutex);',
      );
      const measure = body.indexOf('MeasureNativeApproval(work->request)');
      const state = body.indexOf('std::lock_guard<std::mutex> state_lock(session.state_mutex);');
      expect(serial).toBeGreaterThan(0);
      expect(measure).toBeGreaterThan(serial);
      expect(state).toBeGreaterThan(measure);
      // Exactly one measurement, and the state lock sits in a block of its own after it.
      expect(body.match(/MeasureNativeApproval\(/gu)).toHaveLength(1);
      expect(
        body.match(/std::lock_guard<std::mutex> state_lock\(session\.state_mutex\);/gu),
      ).toHaveLength(1);
    }
    // The input entry runs after the ticket was consumed, outside the state lock.
    const body = code(dispatchWorker());
    const consume = body.indexOf('session.approval.ConsumeApproved(');
    const dispatch = body.indexOf('PerformNativeDispatch(work->request)');
    expect(dispatch).toBeGreaterThan(consume);
    const lockEnd = body.indexOf('if (consumed) work->outcome');
    expect(lockEnd).toBeGreaterThan(consume);
    expect(dispatch).toBeGreaterThan(lockEnd);
  });

  it('makes N-API values on the JS thread only', () => {
    // The workers have none; the receipt and the resolve are in the completion callback or the
    // JS-thread function itself.
    expect(code(approveWorker()).replaceAll('napi_env', '')).not.toMatch(
      /napi_|ApprovalApproveReceiptValue/u,
    );
    expect(code(dispatchWorker()).replaceAll('napi_env', '')).not.toMatch(
      /napi_|DispatchResultValue/u,
    );
    expect(code(approveComplete())).toContain('ApprovalApproveReceiptValue(');
    expect(code(approveComplete())).toContain(
      'napi_resolve_deferred(env, work->deferred, result);',
    );
    expect(macos.match(/ApprovalApproveReceiptValue\(/gu)).toHaveLength(3);
    // Nothing of the napi types lives in the work structure beyond the handles the framework needs.
    const work = /struct AsyncNativeApprovalWork \{[\s\S]*?\n\};/u.exec(macos);
    expect(work).not.toBeNull();
    expect(work![0]).not.toMatch(/napi_value/u);
  });

  it('refuses without burning, marks the generation busy, and rolls back every failure path', () => {
    const js = approveJs();
    expect(js).toContain('session.approval.pending()');
    expect(js).toContain('session.approval.approval_generation() == approval_generation');
    expect(js).toContain('session.approval_busy_generation == 0');
    expect(js).toContain('session.approval_busy_generation = approval_generation;');
    // A promise that could not be created, and work that could not be queued, end the approval and
    // clear the busy mark; the queue failure settles the live deferred.
    expect(js.match(/AbandonNativeApproval\(request, approval_generation\);/gu)).toHaveLength(2);
    expect(js).toContain('napi_reject_deferred(env, work->deferred, error);');
    const abandon = fn('void AbandonNativeApproval(');
    expect(abandon).toContain('request.session->approval.Discard(approval_generation);');
    expect(abandon).toContain('request.session->approval_busy_generation = 0;');
    // The worker clears it on every way out, and the completion callback on a failed status.
    expect(code(approveWorker())).toContain('session.approval_busy_generation = 0;');
    expect(code(approveWorker())).toContain(
      'AbandonNativeApproval(work->request, work->approval_generation);',
    );
    expect(code(approveComplete())).toContain('if (status != napi_ok) {');
    expect(code(approveComplete())).toContain('AbandonNativeApproval(');
    expect(macos).toContain('std::uint64_t approval_busy_generation = 0;');
  });

  it('reserves an approved dispatch without consuming, and the worker consumes and dispatches', () => {
    const js = dispatchJs();
    expect(js).toContain('work->approval_generation = approval_generation;');
    expect(js).toContain('ExecuteNativeApprovedDispatch,');
    expect(js).not.toContain('ExecuteNativeDispatch,');
    expect(js.match(/approval\.Discard\(approval_generation\);/gu)).toHaveLength(2);
    expect(macos).toContain('std::uint64_t approval_generation = 0;');
    const worker = dispatchWorker();
    // A refusal or a failure before the ticket was consumed ends the approval and is cached; one
    // after it is an unknown effect.
    expect(worker).toContain('CacheDispatchOutcome(work->request, work->outcome);');
    expect(worker).toContain('native_dispatch_exception_unknown_effect');
    expect(worker).toContain('AbandonNativeApproval(work->request, work->approval_generation);');
  });
});
