import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  join(__dirname, '../../computer-use-native/computer_use_macos.mm'),
  'utf8',
);
function functionSource(start: string, end: string) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error('Native seam source markers changed');
  return source.slice(from, to);
}

// Compile the actual production Cancel and click implementation with inert OS/N-API seams.
// No target process, screen, native addon, Provider, or real input API is used.
describe.skipIf(process.platform !== 'darwin')('macOS native cancellation ordering seam', () => {
  it.each([false, true])(
    'acknowledges Cancel only after the production click pair drains (sanitizers=%s)',
    (sanitizers) => {
      const root = mkdtempSync(join(tmpdir(), 'computer-use-cancel-seam-'));
      try {
        const program = join(root, 'seam.cc');
        const binary = join(root, 'seam');
        writeFileSync(
          program,
          `${preamble}
${functionSource('struct AsyncNativeStopWork {', 'napi_value CloseSession(')}
${functionSource('napi_value CloseSession(', 'bool ReadWindowBounds(')}
${functionSource('napi_value Cancel(', 'napi_value Init(')}
${functionSource('NativeDispatchOutcome PerformVisualDispatch(', 'NativeDispatchOutcome PerformFocusedInputDispatch(')}
${driver}`,
        );
        execFileSync(
          'clang++',
          [
            '-std=c++20',
            '-Wall',
            '-Wextra',
            '-Werror',
            ...(sanitizers ? ['-fsanitize=address,undefined', '-fno-omit-frame-pointer'] : []),
            program,
            '-o',
            binary,
          ],
          { stdio: 'pipe', timeout: 30_000 },
        );
        const result = JSON.parse(
          execFileSync(binary, [], { encoding: 'utf8', timeout: 5_000 }),
        ) as {
          afterDown: number;
          afterValidation: number;
          workerFailureUnconfirmed: boolean;
          stopSettledOnCreateFailure: boolean;
          stopSettledOnQueueFailure: boolean;
          stopWorkReleased: boolean;
          unconfirmedCloseRetained: boolean;
          retainedCloseConfirms: boolean;
          unconfirmedCloseRetriesDrain: boolean;
          confirmedCloseReplaysReceipt: boolean;
          staleRepeatCloseRejected: boolean;
          unclosedSessionStillMissing: boolean;
          closedRegistryBounded: boolean;
          lifetimeReleased: boolean;
        };
        expect(result).toEqual({
          afterDown: 0,
          afterValidation: 0,
          workerFailureUnconfirmed: true,
          stopSettledOnCreateFailure: true,
          stopSettledOnQueueFailure: true,
          stopWorkReleased: true,
          unconfirmedCloseRetained: true,
          retainedCloseConfirms: true,
          unconfirmedCloseRetriesDrain: true,
          confirmedCloseReplaysReceipt: true,
          staleRepeatCloseRejected: true,
          unclosedSessionStillMissing: true,
          closedRegistryBounded: true,
          lifetimeReleased: true,
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

const preamble = `
#include <algorithm>
#include <atomic>
#include <cstdint>
#include <iostream>
#include <memory>
#include <mutex>
#include <vector>
#include <unordered_map>
#include <set>
#include <stdexcept>
#include <string>
using pid_t = int;
bool failStopDrain = false;
// ExecuteNativeStop reads the attempt counter inside its try block, so an inert seam can fail a
// drain exactly where a real stop worker would and leave the close unconfirmed.
struct SeamInputAttemptCounter {
  std::atomic<std::uint64_t> value{0};
  std::uint64_t load(std::memory_order order) const {
    if (failStopDrain) throw std::runtime_error("native stop drain failed");
    return value.load(order);
  }
  std::uint64_t fetch_add(std::uint64_t delta, std::memory_order order) {
    return value.fetch_add(delta, order);
  }
};
struct MacComputerUseSession {
  std::string session_id = "seam";
  int pid = 1;
  std::atomic<bool> closed{false}, observation_publication_claimed{false};
  std::atomic<std::uint64_t> cancel_epoch{0}, observation_publication_epoch{0};
  SeamInputAttemptCounter input_api_attempts;
  std::mutex state_mutex;
  bool has_observation = false;
  std::vector<std::string> visual_patch_digests, dispatch_replay_order;
  std::unordered_map<std::string, std::string> dispatch_replay_cache, inflight_dispatches;
  std::unordered_map<std::string, std::string> semantic_control_signatures;
  std::set<std::string> visual_control_signatures;
};
std::shared_ptr<MacComputerUseSession> current = std::make_shared<MacComputerUseSession>();
std::atomic<std::uint64_t> cancellation_epoch{0};
std::mutex mac_sessions_mutex;
std::unordered_map<std::string, std::shared_ptr<MacComputerUseSession>> mac_sessions, mac_pending_sessions;
struct FakeValue {};
using napi_env = void*;
using napi_callback_info = void*;
using napi_value = FakeValue*;
using napi_status = int;
using napi_deferred = void*;
struct FakeWork { void (*execute)(napi_env, void*); void (*complete)(napi_env, napi_status, void*); void* data; };
using napi_async_work = FakeWork*;
std::vector<FakeWork*> queue;
std::mutex mac_dispatch_serial_mutex;
constexpr int napi_ok = 0;
FakeValue fake;
int napi_get_cb_info(napi_env, napi_callback_info, size_t* argc, napi_value* argv, void*, void*) {
  *argc = 1; argv[0] = &fake; return napi_ok;
}
bool IsObject(napi_env, napi_value) { return true; }
// Stop requests default to the live session; the repeat-close scenarios address a session id that
// the first close already removed, so they set the request explicitly.
bool overrideStopRequest = false;
std::string requestedSessionId;
std::uint64_t requestedCancelEpoch = 0;
bool ReadNamedString(napi_env, napi_value, const char*, std::string* out) { *out = overrideStopRequest ? requestedSessionId : current->session_id; return true; }
bool ReadNamedUInt64(napi_env, napi_value, const char*, std::uint64_t* out) { *out = overrideStopRequest ? requestedCancelEpoch : current->cancel_epoch.load() + 1; return true; }
std::shared_ptr<MacComputerUseSession> FindCancelableMacSession(const std::string&) { return current; }
napi_value ThrowNativeError(napi_env, const char* code, const char*) { throw std::runtime_error(code); }
void napi_create_object(napi_env, napi_value* out) { *out = &fake; }
unsigned namedProperties = 0;
void napi_set_named_property(napi_env, napi_value, const char*, napi_value) { ++namedProperties; }
napi_value StringValue(napi_env, const char*) { return &fake; }
napi_value NumberValue(napi_env, double) { return &fake; }
napi_value BoolValue(napi_env, bool) { return &fake; }
int napi_create_promise(napi_env, napi_deferred* deferred, napi_value* promise) { *deferred = &fake; *promise = &fake; return 0; }
bool failAsyncWorkCreate = false, failAsyncWorkQueue = false;
unsigned rejections = 0, resolutions = 0, deletedWorks = 0;
int napi_create_async_work(napi_env, void*, napi_value, void (*execute)(napi_env, void*), void (*complete)(napi_env, napi_status, void*), void* data, napi_async_work* out) {
  if (failAsyncWorkCreate) return 1;
  *out = new FakeWork{execute, complete, data}; return 0;
}
int napi_queue_async_work(napi_env, napi_async_work work) { if (failAsyncWorkQueue) return 1; queue.push_back(work); return 0; }
void napi_delete_async_work(napi_env, napi_async_work work) { ++deletedWorks; delete work; }
void napi_create_error(napi_env, void*, napi_value, napi_value* error) { *error = &fake; }
napi_value NativeErrorValue(napi_env, const char*, const char*) { return &fake; }
bool rejected = false;
int completeStatus = 0;
void napi_reject_deferred(napi_env, napi_deferred, napi_value) { rejected = true; ++rejections; }
napi_value Cancel(napi_env, napi_callback_info);
bool acknowledged = false;
void napi_resolve_deferred(napi_env, napi_deferred, napi_value) { acknowledged = true; ++resolutions; }
bool cancelAfterValidation = false;
unsigned afterAck = 0;
void injectCancel() { Cancel(&fake, nullptr); if (acknowledged) throw std::runtime_error("early ack"); }
void drain() {
  for (auto* work : queue) { work->execute(&fake, work->data); work->complete(&fake, completeStatus, work->data); }
  queue.clear();
}
using CGFloat = double;
struct CGPoint { double x, y; };
struct CGRect { CGPoint origin; struct { double width, height; } size; };
CGPoint CGPointMake(double x, double y) { return {x, y}; }
using CGEventRef = int*;
constexpr int kCGEventLeftMouseDown = 1, kCGEventLeftMouseUp = 2, kCGMouseButtonLeft = 0, kCGScrollEventUnitLine = 0;
CGEventRef CGEventCreateMouseEvent(void*, int kind, CGPoint, int) { return new int(kind); }
CGEventRef CGEventCreateScrollWheelEvent(void*, int, int, int, int) { return new int(3); }
void CGEventSetLocation(CGEventRef, CGPoint) {}
void CFRelease(CGEventRef event) { delete event; }
void CGEventPostToPid(pid_t, CGEventRef event) {
  if (acknowledged) ++afterAck;
  if (*event == kCGEventLeftMouseDown && current->cancel_epoch.load() == 0) injectCancel();
}
struct NativeDispatchRequest {
  std::shared_ptr<MacComputerUseSession> session = current;
  CGRect observation_bounds{{0, 0}, {100, 100}};
  double x = .5, y = .5;
  int delta_y = 0, delta_x = 0;
  std::string kind = "click";
  std::set<std::string> visual_control_signatures{"control"};
};
enum class NativeTargetValidation { kValid, kCanceled };
NativeTargetValidation RevalidateBoundTarget(const NativeDispatchRequest&) {
  return current->cancel_epoch.load() == 0 ? NativeTargetValidation::kValid : NativeTargetValidation::kCanceled;
}
struct NativeDispatchOutcome { std::string result; };
NativeDispatchOutcome OutcomeForValidation(NativeTargetValidation, bool) { return {"unknown_effect"}; }
NativeDispatchOutcome MakeDispatchOutcome(const char* result, const char*, bool = false, bool = false) { return {result}; }
enum class AxRiskClassification { kNone };
AxRiskClassification ClassifyElementAtPoint(int, CGPoint, std::string* signature) { *signature = "control"; return AxRiskClassification::kNone; }
bool RiskOutcome(AxRiskClassification, NativeDispatchOutcome*) { return false; }
bool RevalidateVisualPointBeforePost(const NativeDispatchRequest&, CGPoint, NativeDispatchOutcome*) {
  if (cancelAfterValidation) injectCancel();
  return true;
}
`;
const driver = `
enum class CloseOutcome { kQueued, kReceipt, kSessionMissing, kInvalidCancel, kOther };
constexpr std::size_t kSeamClosedRecordLimit = 16;
// One close request against the production CloseSession, classified by what it did: queue a drain,
// answer straight away with a receipt (5 properties), or refuse the session id.
CloseOutcome closeRequest(const std::string& sessionId, std::uint64_t cancelEpoch) {
  overrideStopRequest = true;
  requestedSessionId = sessionId;
  requestedCancelEpoch = cancelEpoch;
  const std::size_t queued = queue.size();
  namedProperties = 0;
  try {
    CloseSession(&fake, nullptr);
  } catch (const std::runtime_error& error) {
    const std::string code = error.what();
    if (code == "SESSION_MISSING") return CloseOutcome::kSessionMissing;
    if (code == "INVALID_CANCEL") return CloseOutcome::kInvalidCancel;
    return CloseOutcome::kOther;
  }
  if (queue.size() == queued + 1) return CloseOutcome::kQueued;
  // NativeStopReceipt sets result, sessionId, cancelEpoch, inputAttemptCount and drained, so a
  // repeat close answered straight away builds exactly five properties and queues nothing.
  return queue.size() == queued && namedProperties == 5 ? CloseOutcome::kReceipt : CloseOutcome::kOther;
}

int main() {
  PerformVisualDispatch(NativeDispatchRequest{});
  drain();
  const unsigned afterDown = afterAck;
  current = std::make_shared<MacComputerUseSession>();
  cancellation_epoch.store(0);
  acknowledged = false;
  afterAck = 0;
  cancelAfterValidation = true;
  PerformVisualDispatch(NativeDispatchRequest{});
  drain();
  const unsigned afterValidation = afterAck;
  current = std::make_shared<MacComputerUseSession>();
  cancellation_epoch.store(0);
  acknowledged = false;
  completeStatus = 1;
  mac_sessions.emplace(current->session_id, current);
  injectCancel();
  CloseSession(&fake, nullptr);
  std::weak_ptr<MacComputerUseSession> lifetime = current;
  current.reset();
  if (lifetime.expired()) return 2;
  drain();
  const bool workerFailureUnconfirmed = rejected && !acknowledged;
  // Main keeps the host quarantined until it sees a confirmed close receipt and answers by
  // re-sending the close, so an unconfirmed close has to keep the session id answerable instead of
  // stranding it. Only the confirmed repeat close may release the session.
  const bool unconfirmedCloseRetained = !lifetime.expired();
  completeStatus = 0;
  const bool retainedCloseConfirms = closeRequest("seam", 3) == CloseOutcome::kQueued;
  drain();
  const bool lifetimeReleased = lifetime.expired();

  // A Stop that cannot reach the worker still owns a live deferred, so it must reject it and hand
  // back the Promise instead of throwing and abandoning it. Mode 0 fails napi_create_async_work
  // (no async work handle to delete), mode 1 fails napi_queue_async_work (one handle to delete).
  bool stopSettled[2] = {false, false};
  bool stopWorkReleased = true;
  for (int mode = 0; mode < 2; ++mode) {
    auto stopSession = std::make_shared<MacComputerUseSession>();
    std::weak_ptr<MacComputerUseSession> stopLifetime = stopSession;
    rejections = 0;
    resolutions = 0;
    deletedWorks = 0;
    failAsyncWorkCreate = mode == 0;
    failAsyncWorkQueue = mode == 1;
    bool threw = false;
    napi_value stopPromise = nullptr;
    try {
      stopPromise = QueueNativeStop(&fake, std::move(stopSession), 1, true);
    } catch (const std::runtime_error&) {
      threw = true;
    }
    failAsyncWorkCreate = false;
    failAsyncWorkQueue = false;
    stopSession.reset();
    // Nothing was queued, so draining must not reach a complete callback for the freed work.
    drain();
    stopSettled[mode] = rejections == 1 && resolutions == 0 && !threw && stopPromise != nullptr &&
      deletedWorks == (mode == 0 ? 0u : 1u);
    if (!stopLifetime.expired() || !queue.empty()) stopWorkReleased = false;
  }

  // A drain that failed must be re-run by the repeat close. Reporting it as confirmed without
  // draining again would release the Main-side quarantine on a stop that never completed.
  auto retrySession = std::make_shared<MacComputerUseSession>();
  retrySession->session_id = "retry";
  mac_sessions.emplace(retrySession->session_id, retrySession);
  failStopDrain = true;
  rejections = 0;
  resolutions = 0;
  const bool retryFirstQueued = closeRequest("retry", 1) == CloseOutcome::kQueued;
  drain();
  const bool retryFirstUnconfirmed = rejections == 1 && resolutions == 0;
  rejections = 0;
  resolutions = 0;
  const bool retryRedrains = closeRequest("retry", 2) == CloseOutcome::kQueued;
  drain();
  const bool retryStillUnconfirmed = rejections == 1 && resolutions == 0;
  failStopDrain = false;
  rejections = 0;
  resolutions = 0;
  const bool retryConfirmQueued = closeRequest("retry", 3) == CloseOutcome::kQueued;
  drain();
  const bool unconfirmedCloseRetriesDrain = retryFirstQueued && retryFirstUnconfirmed &&
    retryRedrains && retryStillUnconfirmed && retryConfirmQueued &&
    rejections == 0 && resolutions == 1;

  // A drain that completed after the Main-side close deadline expired has to answer the repeat
  // close with the same receipt, and nothing may still need the session afterwards.
  auto replaySession = std::make_shared<MacComputerUseSession>();
  replaySession->session_id = "replay";
  replaySession->input_api_attempts.fetch_add(3, std::memory_order_acq_rel);
  mac_sessions.emplace(replaySession->session_id, replaySession);
  rejections = 0;
  resolutions = 0;
  const bool replayFirstQueued = closeRequest("replay", 1) == CloseOutcome::kQueued;
  drain();
  const bool replayDrained = rejections == 0 && resolutions == 1;
  std::weak_ptr<MacComputerUseSession> replayLifetime = replaySession;
  replaySession.reset();
  const bool replayReleased = replayLifetime.expired();
  const bool replayedOnce = closeRequest("replay", 2) == CloseOutcome::kReceipt;
  const bool replayedTwice = closeRequest("replay", 3) == CloseOutcome::kReceipt;
  const bool confirmedCloseReplaysReceipt = replayFirstQueued && replayDrained && replayReleased &&
    replayedOnce && replayedTwice && queue.empty();
  const bool staleRepeatCloseRejected = closeRequest("replay", 3) == CloseOutcome::kInvalidCancel;
  const bool unclosedSessionStillMissing =
    closeRequest("never-opened", 1) == CloseOutcome::kSessionMissing;

  // Keeping a close answerable is bounded, so a long-lived process cannot accumulate sessions it
  // can never release.
  std::vector<std::weak_ptr<MacComputerUseSession>> boundedLifetimes;
  failStopDrain = true;
  for (int index = 0; index < 40; ++index) {
    auto boundedSession = std::make_shared<MacComputerUseSession>();
    boundedSession->session_id = "bounded-" + std::to_string(index);
    mac_sessions.emplace(boundedSession->session_id, boundedSession);
    closeRequest(boundedSession->session_id, 1);
    drain();
    boundedLifetimes.push_back(boundedSession);
  }
  failStopDrain = false;
  std::size_t retainedClosedSessions = 0;
  for (const auto& entry : boundedLifetimes)
    if (!entry.expired()) ++retainedClosedSessions;
  const bool closedRegistryBounded = retainedClosedSessions <= kSeamClosedRecordLimit;

  std::cout << std::boolalpha << "{\\"afterDown\\":" << afterDown << ",\\"afterValidation\\":" << afterValidation
    << ",\\"workerFailureUnconfirmed\\":" << workerFailureUnconfirmed
    << ",\\"stopSettledOnCreateFailure\\":" << stopSettled[0]
    << ",\\"stopSettledOnQueueFailure\\":" << stopSettled[1]
    << ",\\"stopWorkReleased\\":" << stopWorkReleased
    << ",\\"unconfirmedCloseRetained\\":" << unconfirmedCloseRetained
    << ",\\"retainedCloseConfirms\\":" << retainedCloseConfirms
    << ",\\"unconfirmedCloseRetriesDrain\\":" << unconfirmedCloseRetriesDrain
    << ",\\"confirmedCloseReplaysReceipt\\":" << confirmedCloseReplaysReceipt
    << ",\\"staleRepeatCloseRejected\\":" << staleRepeatCloseRejected
    << ",\\"unclosedSessionStillMissing\\":" << unclosedSessionStillMissing
    << ",\\"closedRegistryBounded\\":" << closedRegistryBounded
    << ",\\"lifetimeReleased\\":" << lifetimeReleased << "}";
}
`;
