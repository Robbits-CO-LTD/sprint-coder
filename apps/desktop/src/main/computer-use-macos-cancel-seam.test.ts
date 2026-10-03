import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const nativeSourceDirectory = join(__dirname, '../../computer-use-native');
const source = readFileSync(join(nativeSourceDirectory, 'computer_use_macos.mm'), 'utf8');
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
            // The production ticket header is included as-is, never copied into this seam.
            '-I',
            nativeSourceDirectory,
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
          closeClearsDispatchState: boolean;
          cancelAdvancesTicketGeneration: boolean;
          closeAdvancesTicketGeneration: boolean;
          closeKeepsSlotUntilDrain: boolean;
          closeClearsTicketState: boolean;
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
          closeClearsDispatchState: true,
          cancelAdvancesTicketGeneration: true,
          closeAdvancesTicketGeneration: true,
          closeKeepsSlotUntilDrain: true,
          closeClearsTicketState: true,
          lifetimeReleased: true,
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each([false, true])(
    'preserves production parse/reservation/replay and async cleanup semantics (sanitizers=%s)',
    (sanitizers) => {
      const root = mkdtempSync(join(tmpdir(), 'computer-use-reservation-seam-'));
      try {
        const program = join(root, 'seam.cc');
        const binary = join(root, 'seam');
        writeFileSync(
          program,
          `${reservationPreamble}
${functionSource('struct NativeDispatchOutcome {', 'NativeDispatchOutcome OutcomeForValidation(')}
${functionSource('bool DispatchCancellationStillValid(', 'NativeTargetValidation RevalidateBoundTarget(')}
${functionSource('void CacheDispatchOutcome(', 'napi_value DispatchResultValue(')}
${reservationEffects}
${functionSource('bool ParseNativeDispatchRequest(', 'napi_value Cancel(').replaceAll('@autoreleasepool {', '{')}
${reservationDriver}`,
        );
        execFileSync(
          'clang++',
          [
            '-std=c++20',
            '-Wall',
            '-Wextra',
            '-Werror',
            ...(sanitizers ? ['-fsanitize=address,undefined', '-fno-omit-frame-pointer'] : []),
            // The production binding header is included as-is, never copied into this seam.
            '-I',
            nativeSourceDirectory,
            program,
            '-o',
            binary,
          ],
          { stdio: 'pipe', timeout: 30_000 },
        );
        expect(JSON.parse(execFileSync(binary, [], { encoding: 'utf8', timeout: 5_000 }))).toEqual({
          reservationSemantics: true,
          ticketSemantics: true,
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
#include "computer_use_native_ticket.h"
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
  std::atomic<std::uint64_t> ticket_generation{0};
  sprint_coder::computer_use::NativeOrdinaryTicketSlot ordinary_ticket;
  std::uint64_t preflight_owner = 0;
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
  replaySession->inflight_dispatches.emplace("queued", "envelope");
  replaySession->dispatch_replay_cache.emplace("completed", "envelope");
  replaySession->dispatch_replay_order.push_back("completed");
  replaySession->input_api_attempts.fetch_add(3, std::memory_order_acq_rel);
  mac_sessions.emplace(replaySession->session_id, replaySession);
  rejections = 0;
  resolutions = 0;
  const bool replayFirstQueued = closeRequest("replay", 1) == CloseOutcome::kQueued;
  drain();
  const bool replayDrained = rejections == 0 && resolutions == 1;
  const bool closeClearsDispatchState = replaySession->inflight_dispatches.empty() &&
    replaySession->dispatch_replay_cache.empty() && replaySession->dispatch_replay_order.empty();
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

  // Cancel and Close advance the ticket generation without taking the state lock, so an issued
  // ticket stops matching at once. Only the drain, which holds the state lock, clears the stored
  // secret and the preflight owner. This exercises the production Cancel, CloseSession and
  // ExecuteNativeStop bodies with inert OS/N-API seams; it does not run Observe or StartSession.
  current = std::make_shared<MacComputerUseSession>();
  cancellation_epoch.store(0);
  acknowledged = false;
  const std::uint64_t cancelGenerationBefore = current->ticket_generation.load();
  Cancel(&fake, nullptr);
  const bool cancelAdvancesTicketGeneration = current->ticket_generation.load() == cancelGenerationBefore + 1;
  drain();
  auto ticketSession = std::make_shared<MacComputerUseSession>();
  ticketSession->session_id = "ticket";
  sprint_coder::computer_use::NativeOrdinaryTicketBinding ticketBinding;
  ticketBinding.session_id = "ticket";
  ticketBinding.request_id = "request";
  ticketBinding.action_digest = "action";
  ticketBinding.payload_digest = "payload";
  ticketBinding.context_digest = "context";
  ticketBinding.cancel_epoch = 0;
  ticketBinding.ticket_generation = 3;
  const bool ticketIssued = ticketSession->ordinary_ticket.Issue(std::string(64, 'a'), ticketBinding, 100, 1000);
  ticketSession->preflight_owner = 3;
  mac_sessions.emplace(ticketSession->session_id, ticketSession);
  const std::uint64_t closeGenerationBefore = ticketSession->ticket_generation.load();
  const bool ticketCloseQueued = closeRequest("ticket", 1) == CloseOutcome::kQueued;
  const bool closeAdvancesTicketGeneration = ticketIssued && ticketCloseQueued &&
    ticketSession->ticket_generation.load() == closeGenerationBefore + 1;
  const bool closeKeepsSlotUntilDrain = ticketSession->ordinary_ticket.occupied() &&
    ticketSession->preflight_owner == 3;
  drain();
  const bool closeClearsTicketState = !ticketSession->ordinary_ticket.occupied() &&
    ticketSession->preflight_owner == 0;

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
    << ",\\"closeClearsDispatchState\\":" << closeClearsDispatchState
    << ",\\"cancelAdvancesTicketGeneration\\":" << cancelAdvancesTicketGeneration
    << ",\\"closeAdvancesTicketGeneration\\":" << closeAdvancesTicketGeneration
    << ",\\"closeKeepsSlotUntilDrain\\":" << closeKeepsSlotUntilDrain
    << ",\\"closeClearsTicketState\\":" << closeClearsTicketState
    << ",\\"lifetimeReleased\\":" << lifetimeReleased << "}";
}
`;

// The production parser/reservation/queue/cache run below. Only property reads, process identity
// measurement and effects are inert; no OS target or real addon is loaded. Removing autoreleasepool
// braces' keyword lets the existing C++ runner compile this otherwise unmodified worker body.
const reservationPreamble = String.raw`
#include <algorithm>
#include <atomic>
#include <cstdint>
#include <cstdlib>
#include <deque>
#include <iostream>
#include <limits>
#include <memory>
#include <mutex>
#include <set>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_map>
#include <vector>
#include "computer_use_native_binding.h"
#include "computer_use_native_ticket.h"
#include "computer_use_preflight_classifier.h"
struct CGRect { struct { double x, y; } origin; struct { double width, height; } size; };
struct MacDispatchReplayEntry {
  std::string envelope_digest, result, reason_code;
  bool accepted, effect_started;
};
struct MacComputerUseSession {
  std::string session_id = "seam", app_identity = "app", window_identity = "window";
  std::string process_generation = "generation", task_id = "task", turn_id = "turn";
  CGRect expected_bounds{{0, 0}, {100, 100}};
  std::uint32_t pid = 1, window_id = 2;
  std::atomic<bool> closed{false};
  std::atomic<std::uint64_t> cancel_epoch{0};
  std::atomic<std::uint64_t> ticket_generation{0};
  std::atomic<std::uint64_t> input_api_attempts{0};
  sprint_coder::computer_use::NativeOrdinaryTicketSlot ordinary_ticket;
  std::uint64_t preflight_owner = 0;
  std::mutex state_mutex;
  bool has_observation = true;
  std::uint64_t observation_revision = 7, dialog_set_revision = 4;
  CGRect observation_bounds{{0, 0}, {100, 100}};
  std::string dialog_set_digest = "dialogs", active_window_identity = "active";
  std::string active_window_kind = "standard", focused_control_signature = "focused";
  std::uint32_t active_window_id = 2;
  std::set<std::string> visual_control_signatures{"control"};
  std::vector<std::string> visual_patch_digests{"patch"};
  std::unordered_map<std::string, std::string> semantic_control_signatures{{"target", "signature"}};
  std::unordered_map<std::string, MacDispatchReplayEntry> dispatch_replay_cache;
  std::deque<std::string> dispatch_replay_order;
  std::unordered_map<std::string, std::string> inflight_dispatches;
};
constexpr std::size_t kMaxDispatchReplayEntries = 128, kMaxInflightDispatchEntries = 1;
std::shared_ptr<MacComputerUseSession> current;
std::atomic<std::uint64_t> cancellation_epoch{0};
std::mutex mac_dispatch_serial_mutex;
bool generationMatches = true;
bool CurrentProcessGenerationMatches(const MacComputerUseSession&) { return generationMatches; }
bool CheckCancellationEpoch(std::uint64_t epoch) { return cancellation_epoch.load() == epoch; }
std::shared_ptr<MacComputerUseSession> FindMacSession(const std::string& id) {
  return current && current->session_id == id ? current : nullptr;
}
// Digest measurement is inert here: replay cases test production comparison/cache ownership, not
// SHA-256 authenticity. The identity stub keeps every distinct canonical input distinct, so the
// production IsLowerHexDigest check must never be applied to these internal digests.
std::string StringDigest(const std::string& value) { return value; }
std::string AccessibilityTargetLookupDigest(const std::string& value) { return value; }
struct FakeValue {
  std::unordered_map<std::string, std::string> strings;
  std::unordered_map<std::string, double> numbers;
  // The own "ticket" key: absent, null, empty, nonstring or string (ticketValue).
  std::string ticketKind = "absent";
  std::string ticketValue;
};
using napi_env = void*;
using napi_callback_info = void*;
using napi_value = FakeValue*;
using napi_status = int;
using napi_deferred = void*;
struct FakeWork { void (*execute)(napi_env, void*); void (*complete)(napi_env, napi_status, void*); void* data; };
using napi_async_work = FakeWork*;
constexpr int napi_ok = 0;
FakeValue input, promiseValue, resultValue;
std::deque<FakeWork*> queue;
bool failPromise = false, failCreate = false, failQueue = false, failEffect = false;
unsigned promises = 0, rejections = 0, resolutions = 0, deletions = 0, effects = 0;
void RequireStateUnlocked() {
  std::atomic<bool> unlocked{false};
  std::thread contender([&] {
    if (current->state_mutex.try_lock()) { unlocked.store(true); current->state_mutex.unlock(); }
  });
  contender.join();
  if (!unlocked.load()) throw std::runtime_error("snapshot_lock_held_in_napi_queue");
}
int napi_get_cb_info(napi_env, napi_callback_info, size_t* argc, napi_value* argv, void*, void*) {
  *argc = 1; argv[0] = &input; return napi_ok;
}
bool IsObject(napi_env, napi_value) { return true; }
bool ReadNamedString(napi_env, napi_value value, const char* key, std::string* out, std::size_t max = 4096) {
  const auto found = value->strings.find(key);
  if (found == value->strings.end() || found->second.size() > max) return false;
  *out = found->second; return true;
}
bool ReadNamedDouble(napi_env, napi_value value, const char* key, double* out) {
  const auto found = value->numbers.find(key);
  if (found == value->numbers.end()) return false;
  *out = found->second; return true;
}
bool ReadNamedUint32(napi_env env, napi_value value, const char* key, std::uint32_t* out) {
  double number; if (!ReadNamedDouble(env, value, key, &number)) return false;
  *out = static_cast<std::uint32_t>(number); return true;
}
bool ReadNamedUInt64(napi_env env, napi_value value, const char* key, std::uint64_t* out) {
  double number; if (!ReadNamedDouble(env, value, key, &number)) return false;
  *out = static_cast<std::uint64_t>(number); return true;
}
bool ReadNamedInt32(napi_env env, napi_value value, const char* key, std::int32_t* out) {
  double number; if (!ReadNamedDouble(env, value, key, &number)) return false;
  *out = static_cast<std::int32_t>(number); return true;
}
bool ReadNamedBool(napi_env, napi_value, const char*, bool* out) { *out = false; return true; }
bool DecodeUtf8Scalars(const std::string& text, std::vector<std::uint32_t>* out) {
  for (unsigned char character : text) out->push_back(character);
  return true;
}
std::uint16_t KeyCodeForName(const std::string& key) { return key == "Enter" ? 36 : UINT16_MAX; }
napi_value ThrowNativeError(napi_env, const char* code, const char*) { throw std::runtime_error(code); }
napi_value StringValue(napi_env, const char*) { return &resultValue; }
napi_value NativeErrorValue(napi_env, const char*, const char*) { return &resultValue; }
int napi_create_promise(napi_env, napi_deferred* deferred, napi_value* promise) {
  RequireStateUnlocked();
  if (failPromise) return 1;
  ++promises; *deferred = &promiseValue; *promise = &promiseValue; return napi_ok;
}
int napi_create_async_work(napi_env, void*, napi_value, void (*execute)(napi_env, void*), void (*complete)(napi_env, napi_status, void*), void* data, napi_async_work* out) {
  RequireStateUnlocked();
  if (failCreate) return 1;
  *out = new FakeWork{execute, complete, data}; return napi_ok;
}
int napi_queue_async_work(napi_env, napi_async_work work) {
  RequireStateUnlocked();
  if (failQueue) return 1;
  queue.push_back(work); return napi_ok;
}
void napi_delete_async_work(napi_env, napi_async_work work) { ++deletions; delete work; }
void napi_reject_deferred(napi_env, napi_deferred, napi_value) { ++rejections; }
void napi_resolve_deferred(napi_env, napi_deferred, napi_value) { ++resolutions; }
`;

const reservationEffects = String.raw`
// Inert replacements for the ticket key read, the CSPRNG, the monotonic clock and the preflight
// classification. The production Reserve/Issue/Consume/Release/Complete bodies run unmodified.
bool failTicketRead = false, failTokenGen = false, failClock = false, failPreflightEffect = false;
std::uint64_t fakeNowNs = 1'000'000'000ULL;
unsigned tokenCounter = 0, preflights = 0;
void (*preflightHook)() = nullptr;
NativePreflightReceipt preflightResult = MakeNullReceipt("ordinary");
NativePreflightReceipt lastReceipt;
bool ReadNativeTicketKey(napi_env, napi_value value, NativeTicketKeyInput* output) {
  if (failTicketRead) return false;
  output->present = value->ticketKind != "absent";
  output->token_is_string = value->ticketKind == "string";
  output->token = output->token_is_string ? value->ticketValue : std::string();
  return true;
}
bool ReadNativeMonotonicNs(std::uint64_t* output) {
  if (failClock) return false;
  *output = fakeNowNs; return true;
}
bool GenerateOrdinaryTicketToken(std::string* output) {
  if (failTokenGen) return false;
  static const char hex[] = "0123456789abcdef";
  std::string token(64, '0');
  const unsigned value = ++tokenCounter;
  for (unsigned index = 0; index < 8; ++index) token[63 - index] = hex[(value >> (4 * index)) & 0xfu];
  *output = token; return true;
}
NativePreflightReceipt PerformNativePreflight(const NativeDispatchRequest&) {
  if (failPreflightEffect) throw std::runtime_error("inert_preflight_failure");
  ++preflights;
  if (preflightHook != nullptr) preflightHook();
  return preflightResult;
}
napi_value PreflightReceiptValue(napi_env, const NativeDispatchRequest&, const NativePreflightReceipt& receipt) {
  lastReceipt = receipt; return &resultValue;
}
NativeDispatchOutcome lastOutcome;
napi_value DispatchResultValue(napi_env, const NativeDispatchRequest&, const NativeDispatchOutcome& outcome) {
  lastOutcome = outcome; return &resultValue;
}
NativeDispatchOutcome PerformNativeDispatch(const NativeDispatchRequest& request) {
  if (failEffect) throw std::runtime_error("inert_worker_failure");
  if (!DispatchCancellationStillValid(request))
    return MakeDispatchOutcome("canceled", "native_canceled_pre_dispatch");
  ++effects;
  return MakeDispatchOutcome("completed", "", true, true);
}
`;

const reservationDriver = String.raw`
void Check(bool condition, const char* fixedCase) {
  if (!condition) { std::cerr << fixedCase; std::exit(1); }
}
void Reset() {
  Check(queue.empty(), "reset_with_pending_work");
  current = std::make_shared<MacComputerUseSession>();
  cancellation_epoch.store(0);
  generationMatches = true;
  failPromise = failCreate = failQueue = failEffect = false;
  promises = rejections = resolutions = deletions = effects = 0;
  failTicketRead = failTokenGen = failClock = failPreflightEffect = false;
  fakeNowNs = 1'000'000'000ULL;
  preflights = 0;
  preflightHook = nullptr;
  preflightResult = MakeNullReceipt("ordinary");
  lastReceipt = NativePreflightReceipt{};
  input.ticketKind = "absent";
  input.ticketValue.clear();
  input.strings = {{"kind", "click"}, {"requestId", "one"}, {"sessionId", "seam"},
    {"actionDigest", std::string(64, 'a')}, {"appIdentityDigest", "app"}, {"windowIdentityDigest", "window"}};
  input.numbers = {{"pid", 1}, {"windowId", 2}, {"cancelEpoch", 0}, {"observationRevision", 7}, {"x", .5}, {"y", .5}};
}
bool ParseOnly(std::string* error) {
  NativeDispatchRequest request;
  std::unique_lock<std::mutex> lock;
  std::string message;
  return ParseNativeDispatchRequest(&input, &input, &request, lock, error, &message);
}
void Drain() {
  while (!queue.empty()) {
    auto* work = queue.front(); queue.pop_front();
    work->execute(&input, work->data);
    work->complete(&input, napi_ok, work->data);
  }
}
int main() {
  Reset();
  std::string error;
  Check(ParseOnly(&error) && ParseOnly(&error) && current->inflight_dispatches.empty() &&
    current->dispatch_replay_cache.empty() && effects == 0, "readonly_parse_repeat");
  input.strings["targetId"] = "target";
  input.strings["text"] = "x";
  input.strings["value"] = "choice";
  input.strings["key"] = "Enter";
  input.numbers["deltaX"] = 0;
  input.numbers["deltaY"] = 1;
  for (const char* kind : {"invoke", "set_text", "select", "toggle", "expand_collapse", "click", "scroll", "type", "key"}) {
    input.strings["kind"] = kind;
    Check(ParseOnly(&error) && current->inflight_dispatches.empty() &&
      current->dispatch_replay_cache.empty() && effects == 0, "readonly_supported_action");
  }
  input.strings["kind"] = "click";
  input.strings["actionDigest"] = "invalid";
  Check(!ParseOnly(&error) && error == "INVALID_ACTION_ENVELOPE", "invalid_envelope");
  input.strings["actionDigest"] = std::string(64, 'a');
  input.strings["kind"] = "unsupported";
  Check(!ParseOnly(&error) && error == "UNSUPPORTED_ACTION", "unsupported_action");
  input.strings["kind"] = "click";
  input.strings["sessionId"] = "missing";
  Check(!ParseOnly(&error) && error == "SESSION_MISSING", "missing_session");
  input.strings["sessionId"] = "seam";
  current->closed.store(true);
  Check(!ParseOnly(&error) && error == "SESSION_MISSING", "closed_session");
  current->closed.store(false);
  input.numbers["pid"] = 3;
  Check(!ParseOnly(&error) && error == "SESSION_IDENTITY_MISMATCH", "identity_mismatch");
  input.numbers["pid"] = 1;
  generationMatches = false;
  Check(!ParseOnly(&error) && error == "APP_PROCESS_CHANGED", "generation_mismatch");
  generationMatches = true;
  input.numbers["observationRevision"] = 8;
  Check(!ParseOnly(&error) && error == "STALE_TARGET" && current->inflight_dispatches.empty() &&
    current->dispatch_replay_cache.empty(), "stale_observation_without_reservation");
  input.numbers["observationRevision"] = 7;
  {
    NativeDispatchRequest request;
    std::unique_lock<std::mutex> lock;
    std::string message;
    Check(ParseNativeDispatchRequest(&input, &input, &request, lock, &error, &message), "snapshot_parse");
    std::atomic<bool> blocked{false};
    std::thread contender([&] {
      if (current->state_mutex.try_lock()) current->state_mutex.unlock();
      else blocked.store(true);
    });
    contender.join();
    NativeDispatchOutcome replay;
    Check(blocked.load() && lock.owns_lock() && ReserveNativeDispatchRequestLocked(&request, &replay) &&
      current->inflight_dispatches.size() == 1, "snapshot_reserve_atomic");
  }
  Reset();
  Check(Dispatch(&input, nullptr) == &promiseValue && queue.size() == 1 &&
    current->inflight_dispatches.size() == 1, "fresh_dispatch_reserved_once");
  Check(ParseOnly(&error) && queue.size() == 1 && promises == 1 &&
    current->inflight_dispatches.size() == 1, "readonly_parse_during_inflight");
  Check(current->state_mutex.try_lock(), "snapshot_lock_released_before_queue_return");
  current->state_mutex.unlock();
  Dispatch(&input, nullptr);
  Check(lastOutcome.reason_code == "native_request_in_flight" && queue.size() == 1 && promises == 1,
    "same_envelope_inflight");
  input.strings["actionDigest"] = std::string(64, 'b');
  Dispatch(&input, nullptr);
  Check(lastOutcome.reason_code == "native_request_id_conflict" && queue.size() == 1,
    "changed_envelope_inflight_conflict");
  input.strings["requestId"] = "two";
  Dispatch(&input, nullptr);
  Check(lastOutcome.reason_code == "native_dispatch_busy" && current->inflight_dispatches.size() == 1,
    "distinct_request_busy");
  input.strings["requestId"] = "one";
  input.strings["actionDigest"] = std::string(64, 'a');
  Drain();
  Check(effects == 1 && resolutions == 1 && current->inflight_dispatches.empty(), "single_effect_and_release");
  Dispatch(&input, nullptr);
  Check(lastOutcome.result == "completed" && lastOutcome.accepted && lastOutcome.effect_started &&
    effects == 1 && promises == 1 && queue.empty(), "completed_replay_no_second_effect");
  input.strings["actionDigest"] = std::string(64, 'b');
  Dispatch(&input, nullptr);
  Check(lastOutcome.reason_code == "native_request_id_conflict" && effects == 1,
    "changed_envelope_cached_conflict");
  for (int mode = 0; mode < 3; ++mode) {
    Reset();
    failPromise = mode == 0; failCreate = mode == 1; failQueue = mode == 2;
    bool threw = false;
    napi_value result = nullptr;
    try { result = Dispatch(&input, nullptr); }
    catch (const std::runtime_error& failure) { threw = std::string(failure.what()) == "ASYNC_UNAVAILABLE"; }
    Check(current->inflight_dispatches.empty() && current->dispatch_replay_cache.empty() &&
      queue.empty() && effects == 0 && rejections == (mode == 0 ? 0u : 1u) && resolutions == 0 &&
      deletions == (mode == 2 ? 1u : 0u) &&
      (mode == 0 ? threw : !threw && result == &promiseValue), "async_failure_releases_reservation");
    failPromise = failCreate = failQueue = false;
    Dispatch(&input, nullptr); Drain();
    Check(effects == 1 && current->inflight_dispatches.empty(), "async_failure_can_retry_fresh");
  }
  Reset();
  failEffect = true;
  Dispatch(&input, nullptr); Drain();
  Check(lastOutcome.result == "unknown_effect" && lastOutcome.effect_started &&
    current->inflight_dispatches.empty(), "worker_exception_cached_unknown");
  failEffect = false;
  Dispatch(&input, nullptr);
  Check(lastOutcome.result == "unknown_effect" && queue.empty() && effects == 0, "worker_exception_replay");
  Reset();
  Dispatch(&input, nullptr);
  auto* incomplete = queue.front(); queue.pop_front();
  incomplete->complete(&input, 1, incomplete->data);
  Check(lastOutcome.result == "unknown_effect" && current->inflight_dispatches.empty() &&
    deletions == 1, "completion_failure_release");
  Dispatch(&input, nullptr);
  Check(lastOutcome.result == "unknown_effect" && queue.empty() && effects == 0, "completion_failure_replay");
  for (bool close : {false, true}) {
    Reset(); Dispatch(&input, nullptr);
    if (close) current->closed.store(true);
    else { current->cancel_epoch.store(1); cancellation_epoch.store(1); }
    Drain();
    Check(lastOutcome.result == "canceled" && effects == 0 && current->inflight_dispatches.empty(),
      "changed_epoch_or_closed_before_worker");
  }
  Reset();
  for (unsigned index = 0; index <= kMaxDispatchReplayEntries; ++index) {
    NativeDispatchRequest request;
    request.session = current;
    request.request_id = std::to_string(index);
    request.envelope_digest = "envelope";
    CacheDispatchOutcome(request, MakeDispatchOutcome("completed", "", true, true));
  }
  Check(current->dispatch_replay_cache.size() == kMaxDispatchReplayEntries &&
    current->dispatch_replay_order.size() == kMaxDispatchReplayEntries &&
    !current->dispatch_replay_cache.contains("0"), "replay_cache_bounded");
  // The envelope binds the request payload and the lock-held snapshot context. The identity
  // digest stub cannot prove SHA behavior; it shows production compares distinct canonical bytes.
  const auto expectConflict = [&](const char* name, bool semantic, auto mutate) {
    Reset();
    if (semantic) { input.strings["kind"] = "invoke"; input.strings["targetId"] = "target"; }
    Dispatch(&input, nullptr); Drain();
    Check(effects == 1 && lastOutcome.result == "completed", name);
    mutate();
    Dispatch(&input, nullptr);
    Check(lastOutcome.reason_code == "native_request_id_conflict" && effects == 1 && queue.empty(), name);
  };
  expectConflict("payload_x_conflict", false, [&] { input.numbers["x"] = .25; });
  expectConflict("payload_y_conflict", false, [&] { input.numbers["y"] = .75; });
  expectConflict("payload_kind_conflict", false, [&] {
    input.strings["kind"] = "scroll"; input.numbers["deltaX"] = 0; input.numbers["deltaY"] = 1;
  });
  expectConflict("payload_target_conflict", true, [&] { input.strings["targetId"] = "target2"; });
  expectConflict("context_focused_conflict", false, [&] { current->focused_control_signature = "other"; });
  expectConflict("context_visual_control_conflict", false, [&] { current->visual_control_signatures.insert("more"); });
  expectConflict("context_visual_patch_conflict", false, [&] { current->visual_patch_digests = {"changed"}; });
  expectConflict("context_visual_patch_order_conflict", false, [&] {
    current->visual_patch_digests = {"patch", "second"};
  });
  expectConflict("context_target_signature_conflict", true, [&] { current->semantic_control_signatures["target"] = "changed"; });
  expectConflict("context_target_absent_conflict", true, [&] { current->semantic_control_signatures.clear(); });
  expectConflict("context_observation_bounds_conflict", false, [&] { current->observation_bounds.size.width = 101; });
  expectConflict("context_dialog_digest_conflict", false, [&] { current->dialog_set_digest = "other-dialogs"; });
  expectConflict("context_process_generation_conflict", false, [&] { current->process_generation = "other"; });
  expectConflict("context_expected_bounds_conflict", false, [&] { current->expected_bounds.origin.x = 1; });
  expectConflict("context_task_conflict", false, [&] { current->task_id = "other-task"; });
  expectConflict("context_turn_conflict", false, [&] { current->turn_id = "other-turn"; });
  // A target that resolves to an empty signature is not the same as an unresolved target.
  Reset();
  input.strings["kind"] = "invoke"; input.strings["targetId"] = "target";
  current->semantic_control_signatures.clear();
  Dispatch(&input, nullptr); Drain();
  current->semantic_control_signatures["target"] = "";
  Dispatch(&input, nullptr);
  Check(lastOutcome.reason_code == "native_request_id_conflict" && effects == 1, "absent_vs_empty_target_signature");
  // The same request replays unchanged, and a Task/Turn in the request is never read.
  Reset();
  Dispatch(&input, nullptr); Drain();
  input.strings["taskId"] = "request-task"; input.strings["turnId"] = "request-turn";
  Dispatch(&input, nullptr);
  Check(lastOutcome.result == "completed" && effects == 1 && queue.empty() && promises == 1,
    "dispatch_ignores_request_task_turn");
  // A non-finite coordinate fails closed before any reservation.
  Reset();
  input.numbers["x"] = std::numeric_limits<double>::quiet_NaN();
  Check(!ParseOnly(&error) && current->inflight_dispatches.empty() && effects == 0, "nan_payload_fail_closed");
  // ---- Ordinary ticket semantics (production Reserve/Issue/Consume/Release/Complete bodies) ----
  // Digests are the identity stub here, so this proves production comparison and ownership logic,
  // not SHA authenticity. Only the ticket key read, CSPRNG, clock and classification are inert.
  namespace ticketns = sprint_coder::computer_use;
  const auto validToken = [](const std::string& token) { return ticketns::IsValidNativeOrdinaryTicketToken(token); };
  const auto issue = [&](const char* name) -> std::string {
    input.ticketKind = "absent";
    Check(Preflight(&input, nullptr) == &promiseValue, name);
    Drain();
    Check(lastReceipt.decision == "ordinary" && validToken(lastReceipt.ticket) &&
      current->ordinary_ticket.occupied() && current->preflight_owner == 0, name);
    return lastReceipt.ticket;
  };
  const auto dispatchWith = [&](const char* kind, const std::string& value) {
    input.ticketKind = kind;
    input.ticketValue = value;
    Dispatch(&input, nullptr);
  };
  const auto expectTicketInvalid = [&](const char* name, unsigned expectedEffects) {
    Check(lastOutcome.reason_code == "native_ticket_invalid" && lastOutcome.result == "rejected" &&
      !lastOutcome.accepted && !lastOutcome.effect_started && queue.empty() && effects == expectedEffects &&
      current->inflight_dispatches.empty() && !current->ordinary_ticket.occupied(), name);
  };

  // 1. Preflight reserves, performs no effect, issues exactly one ordinary ticket, and that ticket
  // can start exactly one dispatch.
  Reset();
  Check(Preflight(&input, nullptr) == &promiseValue && queue.size() == 1 && current->preflight_owner != 0 &&
    current->inflight_dispatches.empty() && current->dispatch_replay_cache.empty() &&
    current->input_api_attempts.load() == 0, "preflight_reserved");
  Check(current->state_mutex.try_lock(), "preflight_lock_released_before_queue_return");
  current->state_mutex.unlock();
  Drain();
  Check(lastReceipt.decision == "ordinary" && lastReceipt.reason_code.empty() && lastReceipt.denied_result.empty() &&
    validToken(lastReceipt.ticket) && current->preflight_owner == 0 && current->ordinary_ticket.occupied() &&
    effects == 0 && preflights == 1 && current->input_api_attempts.load() == 0 &&
    current->inflight_dispatches.empty() && current->dispatch_replay_cache.empty() &&
    resolutions == 1 && deletions == 1, "preflight_issues_ordinary_without_effect");
  const std::string firstTicket = lastReceipt.ticket;
  dispatchWith("string", firstTicket);
  Check(queue.size() == 1 && current->inflight_dispatches.size() == 1 && !current->ordinary_ticket.occupied(),
    "ticket_consumed_at_reservation");
  Drain();
  Check(effects == 1 && lastOutcome.result == "completed", "ticket_dispatch_runs_once");
  input.strings["requestId"] = "two";
  dispatchWith("string", firstTicket);
  expectTicketInvalid("ticket_second_use_rejected", 1);
  input.strings["requestId"] = "one";
  dispatchWith("null", "");
  Check(lastOutcome.result == "completed" && effects == 1 && queue.empty(), "invalid_ticket_replay_returns_cached_result");

  // 2. A ticket belongs to one request: every bound field, the generation and the epochs.
  Reset();
  {
    const std::string other = issue("issue_for_other_request");
    input.strings["requestId"] = "two";
    dispatchWith("string", other);
    expectTicketInvalid("ticket_for_other_request_rejected", 0);
    dispatchWith("absent", "");
    Check(queue.size() == 1 && current->inflight_dispatches.size() == 1, "no_ticket_key_is_legacy");
    Drain();
    Check(effects == 1 && lastOutcome.result == "completed", "legacy_dispatch_after_burned_ticket");
  }
  const auto mismatch = [&](const char* name, auto mutate) {
    Reset();
    const std::string ticket = issue(name);
    mutate();
    dispatchWith("string", ticket);
    expectTicketInvalid(name, 0);
  };
  mismatch("ticket_action_digest_mismatch", [&] { input.strings["actionDigest"] = std::string(64, 'b'); });
  mismatch("ticket_payload_mismatch", [&] { input.numbers["x"] = .25; });
  mismatch("ticket_context_mismatch", [&] { current->visual_patch_digests = {"changed"}; });
  mismatch("ticket_request_cancel_epoch_mismatch", [&] { input.numbers["cancelEpoch"] = 1; });
  mismatch("ticket_session_cancel_epoch_mismatch", [&] { current->cancel_epoch.store(1); });
  mismatch("ticket_generation_mismatch", [&] { current->ticket_generation.fetch_add(1); });
  Reset();
  {
    issue("issue_before_legacy");
    dispatchWith("absent", "");
    Check(queue.size() == 1 && !current->ordinary_ticket.occupied(), "legacy_reservation_supersedes_ticket");
    Drain();
  }

  // 3. TTL and the monotonic clock.
  {
    const std::uint64_t ttl = ticketns::kNativeOrdinaryTicketTtlNs;
    Check(ttl > 0 && ttl <= ticketns::kNativeOrdinaryTicketMaxTtlNs, "ttl_bounded");
    const auto atTime = [&](const char* name, std::uint64_t now, bool accepted) {
      Reset();
      const std::string ticket = issue(name);
      fakeNowNs = now;
      dispatchWith("string", ticket);
      if (accepted) {
        Check(queue.size() == 1, name);
        Drain();
        Check(effects == 1, name);
      } else {
        expectTicketInvalid(name, 0);
      }
    };
    atTime("ticket_valid_just_before_expiry", 1'000'000'000ULL + ttl - 1, true);
    atTime("ticket_expired_at_ttl", 1'000'000'000ULL + ttl, false);
    atTime("ticket_expired_after_ttl", 1'000'000'000ULL + ttl + 1, false);
    atTime("ticket_clock_went_backwards", 1'000'000'000ULL - 1, false);
    Reset();
    const std::string clockTicket = issue("ticket_clock_failure");
    failClock = true;
    dispatchWith("string", clockTicket);
    expectTicketInvalid("ticket_clock_failure", 0);
  }

  // 4. A ticket key that is present with any value never falls back to the legacy path.
  struct KeyCase { const char* kind; std::string value; };
  const KeyCase keyCases[] = {{"null", ""}, {"empty", ""}, {"nonstring", ""},
    {"string", std::string(64, 'Z')}, {"string", "abc"}, {"string", std::string(64, 'f')}};
  for (const auto& keyCase : keyCases) {
    Reset();
    issue("issue_for_invalid_key_cases");
    dispatchWith(keyCase.kind, keyCase.value);
    expectTicketInvalid("invalid_ticket_key_never_falls_back", 0);
  }

  // 5. Replay and in-flight hits are answered before the ticket and never touch the slot.
  Reset();
  Dispatch(&input, nullptr);
  Drain();
  input.strings["requestId"] = "two";
  issue("issue_for_two");
  input.strings["requestId"] = "one";
  dispatchWith("string", std::string(64, 'f'));
  Check(lastOutcome.result == "completed" && effects == 1 && queue.empty() && current->ordinary_ticket.occupied(),
    "replay_hit_keeps_slot");
  Reset();
  Dispatch(&input, nullptr);
  {
    ticketns::NativeOrdinaryTicketBinding held;
    held.session_id = "s"; held.request_id = "r"; held.action_digest = "a"; held.payload_digest = "p";
    held.context_digest = "c"; held.ticket_generation = 9;
    Check(current->ordinary_ticket.Issue(std::string(64, 'c'), held, 1, 10), "manual_issue");
  }
  dispatchWith("string", std::string(64, 'f'));
  Check(lastOutcome.reason_code == "native_request_in_flight" && queue.size() == 1 && current->ordinary_ticket.occupied(),
    "inflight_hit_keeps_slot");
  Drain();

  // 6. Preflight on replay, conflict, busy and in-flight.
  Reset();
  Dispatch(&input, nullptr);
  Drain();
  Check(Preflight(&input, nullptr) == &resultValue && lastReceipt.decision == "replay" && lastReceipt.reason_code.empty() &&
    lastReceipt.denied_result.empty() && lastReceipt.ticket.empty() && preflights == 0 &&
    !current->ordinary_ticket.occupied() && current->preflight_owner == 0 && queue.empty(), "preflight_replay_matching_envelope");
  input.strings["actionDigest"] = std::string(64, 'b');
  Check(Preflight(&input, nullptr) == &resultValue && lastReceipt.decision == "denied" &&
    lastReceipt.reason_code == "native_request_id_conflict" && lastReceipt.denied_result == "rejected" &&
    lastReceipt.ticket.empty() && preflights == 0 && queue.empty(), "preflight_replay_conflict");
  Reset();
  Check(Preflight(&input, nullptr) == &promiseValue && current->preflight_owner != 0, "preflight_first_queued");
  input.strings["requestId"] = "two";
  Check(Preflight(&input, nullptr) == &resultValue && lastReceipt.decision == "denied" &&
    lastReceipt.reason_code == "native_dispatch_busy" && queue.size() == 1, "one_preflight_per_session");
  Drain();
  Reset();
  Dispatch(&input, nullptr);
  input.strings["requestId"] = "two";
  Check(Preflight(&input, nullptr) == &resultValue && lastReceipt.reason_code == "native_dispatch_busy" &&
    queue.size() == 1 && current->preflight_owner == 0, "preflight_busy_while_dispatch_inflight");
  input.strings["requestId"] = "one";
  Check(Preflight(&input, nullptr) == &resultValue && lastReceipt.reason_code == "native_request_in_flight",
    "preflight_inflight_same_envelope");
  input.strings["actionDigest"] = std::string(64, 'b');
  Check(Preflight(&input, nullptr) == &resultValue && lastReceipt.reason_code == "native_request_id_conflict",
    "preflight_inflight_conflict");
  input.strings["actionDigest"] = std::string(64, 'a');
  Drain();

  // 7. A late completion of preflight A never clears the owner or the ticket of a newer preflight B.
  for (int lateStatus : {0, 1}) {
    Reset();
    Check(Preflight(&input, nullptr) == &promiseValue, "ab_a_queued");
    auto* workA = queue.front();
    queue.pop_front();
    workA->execute(&input, workA->data);
    Check(current->ordinary_ticket.occupied() && current->preflight_owner == 0, "ab_a_executed");
    input.strings["requestId"] = "two";
    Check(Preflight(&input, nullptr) == &promiseValue && current->preflight_owner != 0 &&
      !current->ordinary_ticket.occupied(), "ab_b_reserved_supersedes_a");
    Drain();
    const std::string ticketB = lastReceipt.ticket;
    Check(lastReceipt.decision == "ordinary" && validToken(ticketB) && current->ordinary_ticket.occupied(), "ab_b_issued");
    workA->complete(&input, lateStatus, workA->data);
    Check(current->ordinary_ticket.occupied() && current->preflight_owner == 0 && lastReceipt.ticket != ticketB &&
      (lateStatus == 0 || (lastReceipt.decision == "denied" && lastReceipt.reason_code == "native_async_completion_failed" &&
        lastReceipt.ticket.empty())), "ab_late_a_keeps_b_ticket");
    dispatchWith("string", ticketB);
    Check(queue.size() == 1 && !current->ordinary_ticket.occupied(), "ab_b_ticket_still_usable");
    Drain();
    Check(effects == 1, "ab_b_dispatch_ran");
  }

  // 8. Every async failure releases the owner it holds.
  for (int mode = 0; mode < 3; ++mode) {
    Reset();
    failPromise = mode == 0; failCreate = mode == 1; failQueue = mode == 2;
    bool threw = false;
    napi_value result = nullptr;
    try { result = Preflight(&input, nullptr); }
    catch (const std::runtime_error& failure) { threw = std::string(failure.what()) == "ASYNC_UNAVAILABLE"; }
    Check(current->preflight_owner == 0 && queue.empty() && !current->ordinary_ticket.occupied() && preflights == 0 &&
      effects == 0 && rejections == (mode == 0 ? 0u : 1u) && resolutions == 0 && deletions == (mode == 2 ? 1u : 0u) &&
      (mode == 0 ? threw : !threw && result == &promiseValue), "preflight_async_failure_releases_owner");
    failPromise = failCreate = failQueue = false;
    Check(Preflight(&input, nullptr) == &promiseValue && queue.size() == 1, "preflight_retry_after_async_failure");
    Drain();
  }
  Reset();
  Check(Preflight(&input, nullptr) == &promiseValue, "completion_failure_queued");
  {
    auto* lost = queue.front();
    queue.pop_front();
    lost->complete(&input, 1, lost->data);
  }
  Check(lastReceipt.decision == "denied" && lastReceipt.reason_code == "native_async_completion_failed" &&
    lastReceipt.denied_result == "rejected" && lastReceipt.ticket.empty() && current->preflight_owner == 0 &&
    !current->ordinary_ticket.occupied() && preflights == 0 && deletions == 1 && resolutions == 1,
    "completion_failure_without_execute");
  issue("preflight_after_completion_failure");
  Reset();
  failPreflightEffect = true;
  Check(Preflight(&input, nullptr) == &promiseValue, "worker_exception_queued");
  Drain();
  Check(lastReceipt.decision == "denied" && lastReceipt.reason_code == "native_preflight_exception" &&
    lastReceipt.denied_result == "rejected" && lastReceipt.ticket.empty() && current->preflight_owner == 0 &&
    !current->ordinary_ticket.occupied(), "worker_exception_is_denied_not_unknown_effect");

  // 9. Issue-time conditions are checked when the ticket is issued, under the state lock.
  struct IssueCase { const char* name; void (*hook)(); bool tokenFails; bool clockFails; const char* result; const char* reason; };
  const IssueCase issueCases[] = {
    {"issue_generation_superseded", [] { current->ticket_generation.fetch_add(1, std::memory_order_acq_rel); }, false, false, "rejected", "native_ticket_superseded"},
    {"issue_owner_cleared", [] { current->preflight_owner = 0; }, false, false, "rejected", "native_ticket_superseded"},
    {"issue_closed", [] { current->closed.store(true); }, false, false, "canceled", "native_canceled_pre_dispatch"},
    {"issue_cancel_epoch", [] { current->cancel_epoch.store(1); cancellation_epoch.store(1); }, false, false, "canceled", "native_canceled_pre_dispatch"},
    {"issue_random_failure", nullptr, true, false, "rejected", "native_ticket_unavailable"},
    {"issue_clock_failure", nullptr, false, true, "rejected", "native_ticket_unavailable"},
  };
  for (const auto& issueCase : issueCases) {
    Reset();
    preflightHook = issueCase.hook;
    failTokenGen = issueCase.tokenFails;
    failClock = issueCase.clockFails;
    Check(Preflight(&input, nullptr) == &promiseValue, issueCase.name);
    Drain();
    Check(lastReceipt.decision == "denied" && lastReceipt.reason_code == issueCase.reason &&
      lastReceipt.denied_result == issueCase.result && lastReceipt.ticket.empty() &&
      !current->ordinary_ticket.occupied() && current->preflight_owner == 0 && effects == 0, issueCase.name);
  }

  // 10. Classifier outcomes never issue a ticket and the receipt table stays closed.
  {
    const struct { const char* reason; const char* result; const char* decision; } classified[] = {
      {"native_secure_field_blocked", "rejected", "blocked"},
      {"native_high_impact_user_takeover", "paused", "takeover"},
      {"native_target_unclassified", "rejected", "takeover"},
      {"native_stale_observation", "rejected", "denied"},
      {"native_made_up_reason", "rejected", "denied"},
    };
    for (const auto& entry : classified) {
      Reset();
      preflightResult = PreflightReceiptFromOutcome(MakeDispatchOutcome(entry.result, entry.reason));
      Check(Preflight(&input, nullptr) == &promiseValue, entry.reason);
      Drain();
      const bool unknown = std::string(entry.reason) == "native_made_up_reason";
      Check(lastReceipt.decision == (unknown ? "denied" : entry.decision) &&
        lastReceipt.reason_code == (unknown ? "native_dispatch_failed" : entry.reason) &&
        lastReceipt.ticket.empty() && !current->ordinary_ticket.occupied() && current->preflight_owner == 0, entry.reason);
    }
    const auto closedReceipt = [](const char* decision, const char* reason, const char* result, const std::string& ticket) {
      NativePreflightReceipt receipt;
      receipt.decision = decision;
      receipt.reason_code = reason;
      receipt.denied_result = result;
      receipt.ticket = ticket;
      return NativePreflightReceiptIsClosed(receipt);
    };
    const std::string goodToken(64, 'a');
    Check(closedReceipt("ordinary", "", "", goodToken) && !closedReceipt("ordinary", "", "", "") &&
      !closedReceipt("ordinary", "x", "", goodToken) && !closedReceipt("ordinary", "", "rejected", goodToken) &&
      !closedReceipt("ordinary", "", "", std::string(63, 'a')) && !closedReceipt("ordinary", "", "", std::string(64, 'A')),
      "receipt_ordinary_closed");
    Check(closedReceipt("blocked", "native_secure_field_blocked", "rejected", "") &&
      !closedReceipt("blocked", "native_secure_field_blocked", "paused", "") &&
      !closedReceipt("blocked", "native_secure_field_blocked", "rejected", goodToken) &&
      closedReceipt("takeover", "native_high_impact_user_takeover", "paused", "") &&
      closedReceipt("takeover", "native_target_unclassified", "rejected", "") &&
      !closedReceipt("takeover", "native_high_impact_user_takeover", "rejected", "") &&
      !closedReceipt("takeover", "native_target_unclassified", "paused", "") &&
      closedReceipt("replay", "", "", "") && !closedReceipt("replay", "native_dispatch_busy", "rejected", "") &&
      !closedReceipt("replay", "", "", goodToken) && !closedReceipt("unknown", "", "", "") &&
      !closedReceipt("denied", "native_secure_field_blocked", "rejected", "") &&
      !closedReceipt("denied", "native_high_impact_user_takeover", "paused", "") &&
      !closedReceipt("denied", "native_made_up_reason", "rejected", ""), "receipt_blocked_takeover_replay_closed");
    for (const auto& entry : kNativePreflightDeniedTable) {
      const std::string result = entry.result;
      Check((result == "rejected" || result == "paused" || result == "canceled") &&
        closedReceipt("denied", entry.reason_code, entry.result, "") &&
        !closedReceipt("denied", entry.reason_code, result == "rejected" ? "paused" : "rejected", "") &&
        !closedReceipt("denied", entry.reason_code, entry.result, goodToken), entry.reason_code);
    }
    // The nine OutcomeForValidation(false) pairs, listed independently of the production table.
    const struct { const char* reason; const char* result; } validationPairs[] = {
      {"native_canceled_pre_dispatch", "canceled"}, {"native_capability_unavailable", "rejected"},
      {"native_dialog_user_takeover", "paused"}, {"native_app_identity_changed", "rejected"},
      {"native_process_generation_changed", "rejected"}, {"native_target_ineligible", "rejected"},
      {"native_focus_changed", "rejected"}, {"native_stale_observation", "rejected"},
      {"native_dispatch_failed", "rejected"},
    };
    for (const auto& pair : validationPairs)
      Check(closedReceipt("denied", pair.reason, pair.result, ""), pair.reason);
    NativePreflightReceipt forged;
    forged.decision = "ordinary";
    SealNativePreflightReceipt(&forged);
    Check(forged.decision == "denied" && forged.reason_code == "native_dispatch_failed" &&
      forged.denied_result == "rejected" && forged.ticket.empty(), "ordinary_without_ticket_is_sealed");
  }

  // 11. Key handling in Preflight and N-API failures before any reservation.
  for (const char* kind : {"null", "empty", "nonstring", "string"}) {
    Reset();
    input.ticketKind = kind;
    input.ticketValue = std::string(64, 'a');
    std::string code;
    try { Preflight(&input, nullptr); } catch (const std::runtime_error& failure) { code = failure.what(); }
    Check(code == "INVALID_ACTION" && queue.empty() && current->preflight_owner == 0 && preflights == 0,
      "preflight_rejects_ticket_key");
  }
  Reset();
  failTicketRead = true;
  {
    std::string preflightCode, dispatchCode;
    try { Preflight(&input, nullptr); } catch (const std::runtime_error& failure) { preflightCode = failure.what(); }
    try { Dispatch(&input, nullptr); } catch (const std::runtime_error& failure) { dispatchCode = failure.what(); }
    Check(preflightCode == "INVALID_ACTION_ENVELOPE" && dispatchCode == "INVALID_ACTION_ENVELOPE" && queue.empty() &&
      current->preflight_owner == 0 && current->inflight_dispatches.empty(), "ticket_key_read_failure_fails_closed");
  }
  Reset();
  input.numbers["observationRevision"] = 8;
  {
    std::string code;
    try { Preflight(&input, nullptr); } catch (const std::runtime_error& failure) { code = failure.what(); }
    Check(code == "STALE_TARGET" && queue.empty() && current->preflight_owner == 0 &&
      !current->ordinary_ticket.occupied(), "preflight_stale_observation_no_reservation");
  }
  std::cout << "{\"reservationSemantics\":true,\"ticketSemantics\":true}";
}
`;
