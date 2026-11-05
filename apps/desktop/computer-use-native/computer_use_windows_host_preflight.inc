BackendProbe ProbeBackend() {
  BackendProbe result;
  const auto build = WindowsBuildNumber();
  result.os_supported = build >= kMinimumWindowsBuild;
  result.ui_automation = result.os_supported && HasUiAutomation();
  // The process-level probe proves the WGC API factory only. A real
  // single-window frame requires a user-selected, foreground, identity-bound
  // target and is therefore checked by `observe`. Probe must neither fabricate
  // a target nor require a full-screen fallback.
  result.graphics_capture = result.os_supported && HasGraphicsCaptureFactory();
  result.send_input = result.os_supported;
  return result;
}

std::string ProbeJson(const BackendProbe &probe) {
  std::string viewer_digest(16, '0');
  for (std::size_t index = 0; index < viewer_digest.size(); ++index)
    viewer_digest[index] = "0123456789abcdef"[
        (sprint_coder::computer_use::kWindowsDocumentViewerDigestPinned >>
         ((15 - index) * 4)) & 0xf];
  const bool backend_ready = probe.os_supported && probe.ui_automation &&
                             probe.graphics_capture && probe.send_input;
  const char *reason = !probe.os_supported    ? "WINDOWS_BUILD_UNSUPPORTED"
                       : !probe.ui_automation ? "UI_AUTOMATION_UNAVAILABLE"
                       : !probe.graphics_capture
                           ? "GRAPHICS_CAPTURE_UNAVAILABLE"
                           : "READY";
  return std::string("{\"protocolVersion\":") +
         std::to_string(kProtocolVersion) +
         ",\"apiVersion\":" + std::to_string(kApiVersion) +
         ",\"sourceCommit\":\"" + std::string(kSourceCommit) + "\"" +
         ",\"backend\":\"windows-uia-graphics-capture-sendinput\"" +
         ",\"platform\":\"win32\",\"architecture\":\"x64\",\"napiVersion\":10" +
         ",\"available\":" + (backend_ready ? "true" : "false") +
         ",\"windowsDocumentViewers\":{\"version\":" +
         std::to_string(sprint_coder::computer_use::kWindowsDocumentViewerVersion) +
         ",\"digest\":\"" + viewer_digest + "\"}" +
         ",\"capabilities\":{"
         "\"observe\":" +
         (backend_ready ? "true" : "false") +
         ",\"control\":" + (backend_ready ? "true" : "false") +
         ",\"uiAutomation\":" + (probe.ui_automation ? "true" : "false") +
         ",\"graphicsCapture\":" + (probe.graphics_capture ? "true" : "false") +
         ",\"sendInput\":" + (probe.send_input ? "true" : "false") +
         ",\"cancellableWindowDiscovery\":true" +
         ",\"identityBoundStart\":true" +
         ",\"artifactRead\":true" +
         (kWindowsApprovalHandlersEnabled
              ? ",\"approval\":true,\"approvalWire\":" +
                    std::to_string(sprint_coder::computer_use::kWindowsApprovalReceiptVersion)
              : std::string(",\"approval\":false")) +
         "},\"eligibility\":{\"mode\":\"" +
         std::string(sprint_coder::computer_use::kNativeEligibilityModeName) +
         "\",\"rulesetVersion\":" +
         std::to_string(sprint_coder::computer_use::kNativeEligibilityRulesetVersion) +
         ",\"classifierVersion\":" +
         std::to_string(sprint_coder::computer_use::kNativeEligibilityClassifierVersion) +
         ",\"lexiconVersion\":" +
         std::to_string(sprint_coder::computer_use::kNativeEligibilityLexiconVersion) +
         ",\"ticketRequired\":" +
         (sprint_coder::computer_use::kNativeEligibilityTicketRequired ? "true" : "false") +
         ",\"interlockEnforced\":" +
         (sprint_coder::computer_use::kNativeEligibilityInterlockEnforced ? "true" : "false") +
         "},\"reason\":\"" + reason + "\"}\n";
}

// BEGIN windows residual response ownership
WindowsWorkerSlot &InterlockWorkerRunning();

// A response is flagged only while a worker that THIS request started still holds its slot (see
// WindowsWorkerSlot). Work the scheduler owns (the effect shadow) or that a worker thread starts (the
// shell lookups: each its own single-flight slot, which a lookup that never returns holds alone) is no
// request's residual work.
struct WindowsResidualResponse {
  FrameHeader header;
  WindowsWorkerLaunches workers;
};

class WindowsResidualRequestScope;
thread_local const WindowsResidualRequestScope *windows_residual_request = nullptr;

// A nested Stop or a later request does not own workers that another request started.
class WindowsResidualRequestScope {
public:
  explicit WindowsResidualRequestScope(const Frame &request)
      : request_(&request), previous_(windows_residual_request),
        previous_launches_(windows_worker_launches) {
    windows_residual_request = this;
    windows_worker_launches = &launches_;
  }
  ~WindowsResidualRequestScope() {
    windows_residual_request = previous_;
    windows_worker_launches = previous_launches_;
  }
  WindowsResidualRequestScope(const WindowsResidualRequestScope &) = delete;
  WindowsResidualRequestScope &operator=(const WindowsResidualRequestScope &) = delete;
  WindowsWorkerLaunches Workers(const Frame &request) const noexcept {
    return request_ == &request ? launches_.Holding() : WindowsWorkerLaunches{};
  }
private:
  const Frame *request_;
  const WindowsResidualRequestScope *previous_;
  WindowsWorkerLaunches *previous_launches_;
  WindowsWorkerLaunches launches_;
};

// Every frame goes out through Respond or a retirement delivery under this lock. So the notifier can
// write a retirement while the consumer serves a long request (an observe, a discovery wait, the modal
// picker), and a retirement is queued and written only after its own response.
std::mutex &WindowsPipeWriteMutex() {
  static std::mutex mutex;
  return mutex;
}
std::condition_variable &WindowsResidualReady() {
  static std::condition_variable ready;
  return ready;
}
// Guarded by WindowsPipeWriteMutex.
std::vector<WindowsResidualResponse> windows_residual_responses;

bool DeliverWindowsRetiredOperationsLocked(HANDLE pipe) {
  for (auto it = windows_residual_responses.begin(); it != windows_residual_responses.end();) {
    if (!it->workers.Retired()) { ++it; continue; }
    auto header = it->header;
    header.message_type = static_cast<std::uint16_t>(MessageType::kOperationRetired);
    header.flags = 0;
    const auto payload = "{\"helperGeneration\":" + std::to_string(windows_helper_generation) + "}";
    if (!WriteFrame(pipe, header, payload, {})) return false;
    it = windows_residual_responses.erase(it);
  }
  return true;
}

bool DeliverWindowsRetiredOperations(HANDLE pipe) {
  std::lock_guard lock(WindowsPipeWriteMutex());
  return DeliverWindowsRetiredOperationsLocked(pipe);
}

// Sends each retirement as soon as its workers end, independently of the request being served. Idle
// while nothing is queued; otherwise it looks again every 20 ms.
class WindowsRetirementNotifier {
public:
  explicit WindowsRetirementNotifier(HANDLE pipe) : pipe_(pipe) {}
  ~WindowsRetirementNotifier() { Stop(); }
  WindowsRetirementNotifier(const WindowsRetirementNotifier &) = delete;
  WindowsRetirementNotifier &operator=(const WindowsRetirementNotifier &) = delete;
  bool Start() noexcept {
    try {
      thread_ = std::thread([this] { Run(); });
      return true;
    } catch (...) {
      return false;
    }
  }
  // Called by the consumer once its loop has ended; nothing is written to the pipe after it. Only the
  // consumer (Respond, its own retirement delivery) and this notifier write frames; the reader never
  // does, so once stopping_ is set no writer is left. A write that holds the
  // lock may never finish while Main is alive but not reading (ServePipe also ends on a protocol
  // violation, with the pipe open), so cancel until the lock is free: a cancel can land just before
  // the write is issued, and a single one would then miss it. Once stopping_ is set under the lock,
  // the notifier writes nothing more.
  void Stop() noexcept {
    while (!WindowsPipeWriteMutex().try_lock()) {
      CancelIoEx(pipe_, nullptr);
      Sleep(1);
    }
    stopping_ = true;
    WindowsPipeWriteMutex().unlock();
    WindowsResidualReady().notify_all();
    if (thread_.joinable()) thread_.join();
  }
  [[nodiscard]] bool Failed() const noexcept { return failed_.load(std::memory_order_acquire); }
private:
  void Run() {
    std::unique_lock lock(WindowsPipeWriteMutex());
    while (!stopping_) {
      if (windows_residual_responses.empty()) WindowsResidualReady().wait(lock);
      else WindowsResidualReady().wait_for(lock, std::chrono::milliseconds(20));
      if (stopping_) break;
      if (!DeliverWindowsRetiredOperationsLocked(pipe_)) {
        failed_.store(true, std::memory_order_release);
        CancelIoEx(pipe_, nullptr);
        break;
      }
    }
  }
  HANDLE pipe_;
  bool stopping_ = false;  // under WindowsPipeWriteMutex
  std::atomic<bool> failed_{false};
  std::thread thread_;
};

std::string ErrorPayload(std::string_view code, bool accepted = false) {
  return std::string("{\"result\":\"rejected\",\"code\":\"") +
         std::string(code) +
         "\",\"accepted\":" + (accepted ? "true" : "false") + "}";
}

bool Respond(HANDLE pipe, const Frame &request, MessageType type,
             std::string_view payload,
             std::span<const std::uint8_t> binary = {}) {
  FrameHeader response = request.header;
  response.message_type = static_cast<std::uint16_t>(type);
  response.cancel_id = {};
  response.flags = 0;
  std::lock_guard write_lock(WindowsPipeWriteMutex());
  bool queued = false;
  if (type != MessageType::kHandshakeResult &&
      type != MessageType::kApprovalRoundTripEvent &&
      type != MessageType::kBackgroundInteractionEvent) {
    const auto workers = windows_residual_request != nullptr ? windows_residual_request->Workers(request)
                                                             : WindowsWorkerLaunches{};
    if (!workers.Retired()) {
      if (windows_residual_responses.size() >= 128) return false;
      response.flags = sprint_coder::computer_use::kResidualWorkFlag;
      try {
        windows_residual_responses.push_back({response, workers});
      } catch (...) {
        return false;
      }
      queued = true;
    }
  }
  if (!WriteFrame(pipe, response, payload, binary)) {
    // Never retire a response that was not written.
    if (queued) windows_residual_responses.pop_back();
    return false;
  }
  if (queued) WindowsResidualReady().notify_all();
  return true;
}
// END windows residual response ownership

// The background binding re-finds the target with a full raw-view search. Without an outer deadline a
// read gets kWindowsUiaReadBudget (5 s) and the noncontact call watchdog, which would refuse a deep but
// answering tree that the observe of the same window accepts. So this search gets the D Main gives
// these frames (preflight and approval: 10 s), counted from here: the helper takes the frame no earlier
// than Main sent it, so this can never end a search Main would still have accepted, and it is never
// unbounded. An inherited deadline is kept as it is.
bool ValidateWindowsBackgroundActionBindingWithinFrame(const WindowsSession &session,
                                                       const std::string &metadata) {
  WindowsV1UiaLane *lane = windows_v1_uia_lane;
  const bool bounded_here = lane != nullptr && !lane->has_deadline;
  if (bounded_here) {
    lane->has_deadline = true;
    lane->deadline = std::chrono::steady_clock::now() + kWindowsUiaFrameBudget;
  }
  struct Restore {
    WindowsV1UiaLane *lane;
    ~Restore() {
      if (lane != nullptr) lane->has_deadline = false;
    }
  } restore{bounded_here ? lane : nullptr};
  return ValidateWindowsBackgroundActionBinding(session, metadata);
}

bool RespondAndCache(HANDLE pipe, const Frame &request, MessageType type,
                     std::string payload,
                     std::vector<std::uint8_t> binary = {}) {
  const std::string key = ResponseCacheKey(request);
  const std::string request_digest = RequestPayloadDigest(request);
  if (request_digest.size() != 64)
    return false;
  if (!response_cache.contains(key)) {
    const std::size_t incoming_bytes = payload.size() + binary.size();
    while (
        !response_cache_order.empty() &&
        (response_cache_order.size() >= kMaximumCachedResponses ||
         response_cache_bytes + incoming_bytes > kMaximumResponseCacheBytes)) {
      const auto evicted = response_cache.find(response_cache_order.front());
      if (evicted != response_cache.end()) {
        response_cache_bytes -=
            evicted->second.metadata.size() + evicted->second.binary.size();
        MarkWindowsWireCached(response_cache_order.front(), {}, false);
        response_cache.erase(evicted);
      }
      response_cache_order.pop_front();
    }
    if (incoming_bytes > kMaximumResponseCacheBytes)
      return false;
    response_cache_order.push_back(key);
    response_cache_bytes += incoming_bytes;
    if (!MarkWindowsWireCached(key, request_digest, true)) return false;
    response_cache.emplace(
        key, CachedResponse{type, request_digest, std::move(payload),
                            std::move(binary)});
  }
  const auto found = response_cache.find(key);
  return found != response_cache.end() &&
         Respond(pipe, request, found->second.type, found->second.metadata,
                 found->second.binary);
}

bool ReplayCachedResponse(HANDLE pipe, const Frame &request, bool *replayed) {
  const auto found = response_cache.find(ResponseCacheKey(request));
  if (found == response_cache.end()) {
    *replayed = false;
    return true;
  }
  *replayed = true;
  const std::string request_digest = RequestPayloadDigest(request);
  if (request_digest.size() != 64)
    return false;
  if (found->second.request_digest != request_digest)
    return Respond(pipe, request, MessageType::kError,
                   ErrorPayload("request_id_conflict"));
  return Respond(pipe, request, found->second.type, found->second.metadata,
                 found->second.binary);
}

WindowsSession *FindWindowsSession(const Frame &request) {
  const auto found = sessions.find(FrameIdKey(request.header.session_id));
  return found == sessions.end() ? nullptr : &found->second;
}

std::string WindowsPreflightReceipt(const WindowsSession &session,
                                    const std::string &request_id,
                                    std::uint64_t cancel_epoch,
                                    std::uint64_t observation_revision,
                                    std::string_view decision,
                                    std::string_view denied_reason,
                                    const std::string &ticket,
                                    std::string_view refusal_result = "rejected") {
  const bool denied = decision == "denied";
  const bool ordinary = decision == "ordinary";
  // A v2 refusal (blocked / takeover) carries its reason and the result of its own table row.
  const bool refused = decision == "blocked" || decision == "takeover";
  const bool with_reason = denied || refused;
  return "{\"decision\":\"" + std::string(decision) +
         "\",\"reasonCode\":" +
         (with_reason ? "\"" + std::string(denied_reason) + "\"" : std::string("null")) +
         ",\"deniedResult\":" +
         (denied ? "\"rejected\""
                 : (refused ? "\"" + std::string(refusal_result) + "\"" : std::string("null"))) +
         ",\"ticket\":" + (ordinary ? "\"" + ticket + "\"" : "null") +
         ",\"classifierVersion\":" +
         std::to_string(session.approval_route_v2
                            ? sprint_coder::computer_use::kNativeEligibilityClassifierVersion
                            : sprint_coder::computer_use::kNativePreflightClassifierVersion) +
         ",\"inputAttemptCount\":" +
         std::to_string(session.input_api_attempts->load(std::memory_order_acquire)) +
         ",\"requestId\":\"" + JsonEscape(request_id) + "\",\"sessionId\":\"" +
         JsonEscape(session.session_id) + "\",\"cancelEpoch\":" +
         std::to_string(cancel_epoch) + ",\"observationRevision\":" +
         std::to_string(observation_revision) + "}";
}

// The wire request id of the dispatch for a request id, derived the way Main derives it
// (the first 16 bytes of SHA-256("request:" + id)), so a finished dispatch can be found in the
// response cache from the preflight that precedes its repeat.
bool DispatchFrameIdFor(const std::string &request_id,
                        sprint_coder::computer_use::FrameId *id) {
  const std::string digest = Sha256String("request:" + request_id);
  if (digest.size() < 32) return false;
  for (std::size_t index = 0; index < 16; ++index) {
    const auto nibble = [](char c) -> int {
      return c >= '0' && c <= '9' ? c - '0' : (c >= 'a' && c <= 'f' ? c - 'a' + 10 : -1);
    };
    const int high = nibble(digest[index * 2]);
    const int low = nibble(digest[index * 2 + 1]);
    if (high < 0 || low < 0) return false;
    id->bytes[index] = static_cast<std::uint8_t>(high * 16 + low);
  }
  return true;
}

// Side-effect-free: it makes no input call. It checks the same binding a dispatch checks, and on
// success issues the one ordinary ticket that dispatch must present. Risk classification of the
// target stays in the dispatch for now, so a secure or high-impact target is refused there exactly
// as before; this step only decides whether a dispatch may start. A preflight is never cached,
// because a repeat must get a fresh ticket rather than a spent one. Like the macOS preflight, any
// preflight for an existing session first voids the ticket it holds, whatever its own outcome, and
// a request whose dispatch already finished answers `replay` (the dispatch is then answered from
// the cache and needs no ticket).
// BEGIN effect shadow wiring (classifier v2 S5-b-2b)
// The v2 effect classifier runs here in SHADOW: after the V1 preflight has its answer, the request
// is handed to a low-priority thread of its own, which reads the target through UI Automation,
// classifies, and keeps an enum-only summary in the shadow ring. Nothing here decides anything: the
// V1 receipt is built before this is called and is returned exactly as V1 built it. This function
// reads nothing through UI Automation (that is the shadow thread's work, one capture at a time),
// holds no lock, calls no input API, and never throws.
//
// It is called only from HandleWindowsPreflight, once, after ValidateWindowsDispatchBinding: a
// binding that could not be re-validated leaves a skipped record and reads nothing. The shadow gives
// way to everything else: the capture stops at the first refusal of its gate (cancel epoch, call
// and time budget) and a hung target costs only the shadow's own thread.
void LaunchWindowsShadowThread(std::function<void()> work) {
  std::thread([work = std::move(work)]() mutable {
    SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_LOWEST);
    const HRESULT initialized = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    work();
    if (SUCCEEDED(initialized))
      CoUninitialize();
  }).detach();
}

// Enum values and counters only, to the debug output (the macOS shadow does the same to os_log):
// never a label, a title, a URL or a path. A ShadowRecord holds none of them.
void ReportWindowsEffectShadow(const sprint_coder::computer_use::ShadowRecord &record) {
  char line[160];
  const int length = std::snprintf(
      line, sizeof(line),
      "computer-use effect shadow action=%u class=%u kind=%u reason=%u gaps=%u v1_ordinary=%d\n",
      static_cast<unsigned>(record.action), static_cast<unsigned>(record.effect_class),
      static_cast<unsigned>(record.kind), static_cast<unsigned>(record.reason),
      static_cast<unsigned>(record.gaps), record.v1_ordinary ? 1 : 0);
  if (length > 0)
    OutputDebugStringA(line);
}

// Never destroyed: a capture still running when the process exits must not find it torn down.
sprint_coder::computer_use::WindowsShadowScheduler &WindowsEffectShadow() {
  static sprint_coder::computer_use::WindowsShadowScheduler *const scheduler =
      new sprint_coder::computer_use::WindowsShadowScheduler(
          sprint_coder::computer_use::ProcessShadowLog(), LaunchWindowsShadowThread,
          ReportWindowsEffectShadow);
  return *scheduler;
}

void ScheduleWindowsEffectShadow(const WindowsSession &session,
                                 const std::string &metadata,
                                 const std::string &kind, bool v1_valid,
                                 bool v1_ordinary) noexcept {
  using namespace sprint_coder::computer_use;
  try {
    WindowsShadowJob job;
    job.kind = kind;
    job.v1_ordinary = v1_ordinary;
    job.maximum_mode = session.maximum_mode;
    job.policy_language = session.policy_language;
    (void)ReadJsonString(metadata, "key", &job.key);
    (void)ReadJsonString(metadata, "targetId", &job.target_id);
    // The point a click or scroll lands on, computed as the dispatch computes it.
    POINT point{0, 0};
    const bool point_known =
        WindowsActionPoint(session.observation_bounds, metadata, &point);
    job.click_tracked = kind == "click" && point_known;
    job.click_opens = job.click_tracked && WindowsClickOpens();
    const HWND window = session.active_window;
    const std::uint64_t expected_epoch = session.cancel_epoch;
    // Valid while the cancellation epoch is the one the preflight was bound to (a cancel and the
    // death of the parent both move it).
    const auto still_valid = [expected_epoch]() {
      return cancellation_epoch.load(std::memory_order_acquire) == expected_epoch;
    };
    WindowsShadowEnvironment environment;
    environment.still_valid = still_valid;
    // A click or scroll whose point is not a point of the window is not looked up at the screen's
    // origin: no source, so the capture is recorded as skipped.
    const bool needs_point = kind == "click" || kind == "scroll";
    environment.open_source = [window, point, still_valid, point_known, needs_point]()
        -> std::unique_ptr<ShadowUiaSource> {
      if (needs_point && !point_known)
        return nullptr;
      return WindowsUiaShadowSource::Create(
          window, point, still_valid,
          WindowsUiaShadowSource::kShadowUiaTimeoutMs,
          windows_uia_source_detail::ShellLookupRunning());
    };
    WindowsEffectShadow().Schedule(std::move(job), v1_valid,
                                   std::move(environment));
  } catch (...) {
    // A shadow failure is invisible to the caller.
  }
}
// END effect shadow wiring

// BEGIN sync interlock entry (classifier v2 S5-c-1)
// The shadow's capture, called synchronously: the same UI Automation source and the same reader and
// gate (a cancellation check before every call, a budget of kShadowMaxAxCalls calls and
// kShadowDeadlineNs, and the end-of-capture check), answered by the portable
// EvaluateWindowsInterlockOnSource. A canceled or out-of-budget capture, a failed read and
// incomplete facts are NO VERDICT (the answer carries the reason): never a refusal and never an
// approval, so the V1 preflight decides.
//
// Called from exactly two places, through WindowsInterlockRefusal below: the preflight, before it
// issues a ticket, and the dispatch, before any input (#500 S5-c-2 PR-5). The caller must call it
// only AFTER the V1 re-validation of the bound target succeeded (ValidateWindowsDispatchBinding): the
// point is only right for a binding that is still valid.
//
// THE SERIAL LANE IS HELD AT MOST kInterlockLaneHoldLimit. The lane's thread is an STA (the picker
// and the WinRT capture need it), and a UI Automation call to an app that does not answer is
// bounded only by its timeout. So the evaluation runs on a worker thread of its own, one per
// evaluation, in the multithreaded apartment, and the lane waits for it a bounded time: a worker
// that has not answered by then is abandoned (kBudget), and until it ends no second one is started
// (single-flight), so at most one such thread is ever stuck. The worker gets everything by value
// and never touches `sessions`; the lane's own apartment is not changed.
//
// Worst case of one wait. The gate bounds the START of a step, not its length. For a step that makes
// ONE UI Automation call: the gate's deadline (150 ms) + that call (250 ms) + creating the source and
// starting the thread (50 ms) = 450 ms, within the 500 ms the lane may wait (the static_assert below
// states only this case). Some steps make several calls inside ONE gate step: ItemPath (two UI
// Automation calls, then a shell lookup's wait of 150 ms: up to 650 ms) and CoreWindowProcessPath
// (two calls: 500 ms). Started just before the deadline they can run past 500 ms (about 850 ms by
// this arithmetic); for them the lane's wait_for cut-off (kBudget, worker abandoned) is the real
// bound of the hold, not the estimate. Before the wait the lane also reads the click facts
// (WindowsClickOpens: a settings read and GetLastInputInfo, microseconds, never a wait); that read
// sits outside this bound.
constexpr std::chrono::milliseconds kInterlockLaneHoldLimit{500};
static_assert(150 + sprint_coder::computer_use::WindowsUiaShadowSource::kInterlockUiaTimeoutMs + 50 <= 500,
              "holds for a step of ONE UI Automation call only; longer steps are bounded by the wait_for cut-off");
static_assert(sprint_coder::computer_use::kShadowDeadlineNs == 150'000'000,
              "the lane's worst-case estimate assumes the gate's 150 ms deadline");

struct InterlockPending {
  std::mutex mutex;
  std::condition_variable ready;
  bool done = false;
  // Set by the lane when it stops waiting: the worker's captures then stop at the next call.
  std::atomic<bool> abandoned{false};
  sprint_coder::computer_use::InterlockEvaluation result;
};

// Never destroyed: an abandoned worker may end after the process has started to exit.
WindowsWorkerSlot &InterlockWorkerRunning() {
  static WindowsWorkerSlot *const running = new WindowsWorkerSlot;
  return *running;
}

sprint_coder::computer_use::InterlockEvaluation EvaluateWindowsInterlockOnLane(
    const WindowsSession &session, const std::string &metadata, const std::string &kind,
    const sprint_coder::computer_use::EffectRuleset &ruleset,
    WindowsClickBasis *basis = nullptr) noexcept {
  using namespace sprint_coder::computer_use;
  InterlockEvaluation unavailable;
  unavailable.no_verdict = InterlockNoVerdict::kIncomplete;
  try {
    POINT point{0, 0};
    const bool point_known =
        WindowsActionPoint(session.observation_bounds, metadata, &point);
    // A click or scroll whose point is not a point of the window is not looked up at the screen's
    // origin.
    if ((kind == "click" || kind == "scroll") && !point_known)
      return unavailable;
    const std::uint64_t expected_epoch = session.cancel_epoch;
    const auto epoch_unchanged = [expected_epoch]() {
      return cancellation_epoch.load(std::memory_order_acquire) == expected_epoch;
    };
    // Canceled before anything is created or read: no verdict, no worker and no UI Automation object.
    if (!epoch_unchanged()) {
      unavailable.no_verdict = InterlockNoVerdict::kCanceled;
      return unavailable;
    }
    // The click facts the host alone knows, taken HERE on the lane (a cheap system call, never a
    // wait) and handed to the worker by value: the worker touches no session and no system state.
    // The time of the last input is read at this request, not when a worker finally runs.
    const bool click_tracked = kind == "click" && point_known;
    // The last input time first, then the click facts (which read it again): the time of the basis is
    // never later than the one the verdict used.
    if (basis != nullptr && click_tracked) {
      basis->input_read = WindowsReadLastInputTick(&basis->input_tick);
    }
    const bool click_opens = click_tracked && WindowsClickOpens();
    if (basis != nullptr) {
      basis->tracked = click_tracked;
      basis->opens = click_opens;
    }
    // Everything that can throw is prepared BEFORE the single-flight slot is taken, so a failure
    // here cannot leave the slot taken for ever.
    auto pending = std::make_shared<InterlockPending>();
    // Everything the worker needs, by value.
    const HWND window = session.active_window;
    const std::string maximum_mode = session.maximum_mode;
    const std::string policy_language = session.policy_language;
    const std::string kind_copy = kind;
    std::string key;
    std::string target_id;
    (void)ReadJsonString(metadata, "key", &key);
    (void)ReadJsonString(metadata, "targetId", &target_id);
    const EffectRuleset ruleset_copy = ruleset;
    // A v2 session's capture also reads who provides each element, and carries the explicit table's
    // "not web" answer of this frame's judgement (S5-c-3 PR-5). Every other session: not asked.
    WindowsStrictCaptureIdentity strict;
    strict.asked = session.eligibility_basis == EligibilityBasis::kV2Denylist;
    strict.process_id = strict.asked ? session.pid : 0;
    strict.target_not_web = strict.asked ? session.v2_input_not_web : std::nullopt;
    // Single-flight: a worker still stuck from an earlier evaluation means no second one.
    WindowsWorkerSlot &running = InterlockWorkerRunning();
    if (running.exchange(true)) {
      unavailable.no_verdict = InterlockNoVerdict::kBudget;
      return unavailable;
    }
    try {
      std::thread([pending, window, point, maximum_mode, policy_language, kind_copy, key,
                   target_id, ruleset_copy, strict, expected_epoch, click_tracked, click_opens,
                   &running]() {
        InterlockEvaluation answer;
        answer.no_verdict = InterlockNoVerdict::kIncomplete;
        try {
          // Declared before the source: released after it, also when something throws.
          struct ComApartment {
            HRESULT initialized = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
            ~ComApartment() {
              if (SUCCEEDED(initialized)) CoUninitialize();
            }
          } apartment;
          {
            const auto still_valid = [pending, expected_epoch]() {
              return !pending->abandoned.load(std::memory_order_acquire) &&
                     cancellation_epoch.load(std::memory_order_acquire) == expected_epoch;
            };
            std::unique_ptr<ShadowUiaSource> source = WindowsUiaShadowSource::Create(
                window, point, still_valid, WindowsUiaShadowSource::kInterlockUiaTimeoutMs,
                windows_uia_source_detail::InterlockShellLookupRunning());
            if (source != nullptr) {
              ShadowRequestInfo info;
              info.kind = kind_copy;
              info.key = key;
              info.maximum_mode = maximum_mode;
              info.policy_language = policy_language;
              info.click_tracked = click_tracked;
              info.click_opens = click_opens;
              answer = EvaluateWindowsInterlockOnSource(*source, kind_copy, target_id, info,
                                                        ruleset_copy, strict);
            }
          }
        } catch (...) {
          answer = InterlockEvaluation{};
          answer.no_verdict = InterlockNoVerdict::kIncomplete;
        }
        {
          std::lock_guard<std::mutex> lock(pending->mutex);
          pending->result = answer;
          pending->done = true;
        }
        running.store(false);
        pending->ready.notify_one();
      }).detach();
    } catch (...) {
      running.store(false);
      return unavailable;
    }
    InterlockEvaluation answer;
    {
      std::unique_lock<std::mutex> lock(pending->mutex);
      if (!pending->ready.wait_for(lock, kInterlockLaneHoldLimit,
                                   [&pending] { return pending->done; })) {
        pending->abandoned.store(true, std::memory_order_release);
        unavailable.no_verdict = InterlockNoVerdict::kBudget;
        return unavailable;
      }
      answer = pending->result;
    }
    // The action was canceled while the worker read: no verdict, whatever it found.
    if (!epoch_unchanged()) {
      unavailable.no_verdict = InterlockNoVerdict::kCanceled;
      return unavailable;
    }
    return answer;
  } catch (...) {
    return unavailable;
  }
}
// Windows has no approval path (the route v2 build is refused for win32 by
// build-computer-use-eligibility.mjs), so a file opened from a file manager or a download list is a
// closed approval.
constexpr sprint_coder::computer_use::EffectRuleset kWindowsInterlockRuleset{
    /*download_open=*/false, /*file_manager_open=*/false};

// How often the interlocks had NO verdict, by reason, and how often the lane's time ran out. Only
// enum names and counts are written, never a label or a title.
void CountWindowsInterlockNoVerdict(sprint_coder::computer_use::InterlockNoVerdict reason) noexcept {
  using sprint_coder::computer_use::InterlockNoVerdict;
  static std::atomic<std::uint64_t> counts[4];
  const std::size_t index = static_cast<std::size_t>(reason);
  if (index >= 4) return;
  const std::uint64_t count = counts[index].fetch_add(1, std::memory_order_relaxed) + 1;
  const char *name = reason == InterlockNoVerdict::kCanceled
                         ? "canceled"
                         : (reason == InterlockNoVerdict::kBudget ? "budget" : "incomplete");
  char line[96];
  const int written = std::snprintf(line, sizeof(line), "computer-use interlock: no verdict %s count=%llu\n",
                                    name, static_cast<unsigned long long>(count));
  if (written > 0) OutputDebugStringA(line);
}

sprint_coder::computer_use::InterlockEvaluation
WindowsInterlockRefusal(const WindowsSession &session, const std::string &metadata,
                        const std::string &kind, WindowsClickBasis *basis) noexcept {
  const sprint_coder::computer_use::InterlockEvaluation evaluation =
      EvaluateWindowsInterlockOnLane(session, metadata, kind, kWindowsInterlockRuleset, basis);
  if (!evaluation.Refuses() &&
      evaluation.no_verdict != sprint_coder::computer_use::InterlockNoVerdict::kNone)
    CountWindowsInterlockNoVerdict(evaluation.no_verdict);
  // The session's policy (S5-c-3 PR-3): a v1 session keeps the answer as it is (no verdict, V1
  // decides); a v2 session takes over what the interlocks could not judge and is answered by the strict
  // map. A basis this build does not admit is answered strictly.
  return sprint_coder::computer_use::ApplyIncompletePolicy(
      evaluation, sprint_coder::computer_use::SessionInterlockPolicy(
                      session.eligibility_basis, sprint_coder::computer_use::kNativeEligibilityIsV2));
}
// END sync interlock entry


// BEGIN windows approval measurement and handlers (#991 N8-2c)
bool HandleWindowsApprovalRoundTrip(HANDLE pipe, const Frame &request, const std::string &metadata,
                                   MessageType type) {
  using namespace sprint_coder::computer_use;
  // P3c is dormant in production. No request, environment variable or Renderer value opens it.
  if (!kWindowsBackgroundInputEnabled)
    return Respond(pipe, request, MessageType::kError, ErrorPayload("approval_round_trip_unavailable"));
  const auto received_ms = MonotonicNowNs() / 1000000;
  auto *session = FindWindowsSession(request);
  ApprovalRoundTripBinding binding;
  std::uint64_t version = 0;
  std::string kind;
  if (session == nullptr || !ReadWindowsRoundTripBinding(*session, metadata, &binding) ||
      !ReadJsonUint64(metadata, "version", &version) || version != kApprovalRoundTripVersion ||
      !ReadJsonString(metadata, "kind", &kind))
    return Respond(pipe, request, MessageType::kError, ErrorPayload("approval_round_trip_invalid"));
  const bool begin = type == MessageType::kApprovalRoundTripBegin;
  bool accepted = false;
  if (begin && kind == "begin") {
    std::uint64_t duration = 0, pid = 0;
    std::string process_start, image;
    ULONG client_pid = 0;
    if (!ReadJsonUint64(metadata, "durationMs", &duration) ||
        duration == 0 || duration > kApprovalRoundTripMaxDurationMs ||
        !ReadJsonUint64(metadata, "mainPid", &pid) || pid == 0 || pid > MAXDWORD ||
        !GetNamedPipeClientProcessId(pipe, &client_pid) || client_pid != pid ||
        !ReadJsonString(metadata, "mainProcessStartTime", &process_start) ||
        !ReadJsonString(metadata, "mainImageIdentity", &image))
      return Respond(pipe, request, MessageType::kError, ErrorPayload("approval_round_trip_invalid"));
    ScopedKernelHandle main_process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE,
                                                static_cast<DWORD>(pid)));
    std::string actual_start, actual_image;
    std::wstring path;
    if (main_process.value == nullptr || !ReadProcessStartIdentity(main_process.value, &actual_start) ||
        actual_start != process_start || !ReadProcessPath(main_process.value, &path))
      return Respond(pipe, request, MessageType::kError, ErrorPayload("approval_round_trip_invalid"));
    ScopedKernelHandle executable(CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_DELETE,
        nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
    if (executable.value == INVALID_HANDLE_VALUE || !ReadFileDigest(executable.value, &actual_image) ||
        actual_image != image || !session->has_observation || WindowsSemanticInputInFlight())
      return Respond(pipe, request, MessageType::kError, ErrorPayload("approval_round_trip_invalid"));
    bool pending_input = false;
    {
      std::lock_guard lock(WindowsTargetListControl().stop_mutex);
      pending_input = WindowsSemanticOperations().active != nullptr;
    }
    if (pending_input)
      return Respond(pipe, request, MessageType::kError, ErrorPayload("approval_round_trip_invalid"));
    if (!session->round_trip) session->round_trip = std::make_shared<WindowsApprovalRoundTrip>();
    if (session->round_trip->MayBegin()) {
      const bool next_card = !session->round_trip->MayLegacyStart();
      RECT bounds{};
      std::string reason;
      WindowsSessionIdentityResult next_identity;
      const bool next_valid = !next_card ||
          (ReadWindowsSessionIdentityOnLane(*session, WindowsValidationFrameStopSerial(), &next_identity) &&
           next_identity.identity_matches && !next_identity.elevated && WindowsRoundTripCurrent(*session));
      if (next_card ? !next_valid :
          !ValidateWindowsSession(*session, &bounds, &reason)) session->round_trip->Invalidate();
      else {
        if (!next_card) session->round_trip_monitor = std::make_shared<WindowsRoundTripMonitor>();
        const bool monitoring = next_card ? WindowsRoundTripCurrent(*session) :
            session->round_trip_monitor->Start(*session, static_cast<DWORD>(pid));
        const auto now = MonotonicNowNs();
        const auto key = FrameIdKey(request.header.session_id);
        const auto approval = approval_states.find(key);
        const auto remaining = approval != approval_states.end() && approval->second.occupied()
            ? (approval->second.deadline() > now ? (approval->second.deadline() - now) / 1000000 : 0)
            : kApprovalRoundTripMaxDurationMs;
        std::lock_guard lock(WindowsTargetListControl().stop_mutex);
        // Begin and the semantic input claim share the Stop lock. A pending worker cannot cross
        // this boundary after Begin; already-issued input prevents admission.
        if (WindowsSemanticOperations().active == nullptr &&
            WindowsValidationStillCurrent(session->cancel_epoch, WindowsValidationFrameStopSerial())) {
          // The offer's remaining time was measured before the Main/helper round trip.
          accepted = session->round_trip->Begin(binding, received_ms, (std::min)(duration, remaining), remaining,
              session->observation_revision, ticket_states[key].generation, monitoring);
          if (accepted) InvalidateWindowsTicket(key);
        }
      }
    }
    if (accepted && !WindowsRoundTripCurrent(*session)) accepted = false;
    if (!accepted) session->round_trip->Invalidate();
  } else if (!begin && kind == "end" && session->round_trip) {
    std::string reason;
    if (ReadJsonString(metadata, "reason", &reason) && WindowsRoundTripCurrent(*session))
      accepted = session->round_trip->End(binding, reason == "approved", MonotonicNowNs() / 1000000);
    if (!accepted) session->round_trip->Invalidate();
  }
  const bool failed = session->round_trip && session->round_trip->Failed();
  const std::string failure = failed ? session->round_trip->Failure() : "target_changed";
  ApprovalRoundTripFields fields{{"version", std::uint64_t{kApprovalRoundTripVersion}},
      {"roundTripId", binding.id}, {"sessionId", binding.session}, {"taskId", binding.task},
      {"turnId", binding.turn}, {"helperGeneration", binding.generation}, {"cancelEpoch", binding.epoch},
      {"kind", std::string(begin ? "begin_result" : "end_result")}, {"accepted", accepted},
      {"failureReason", accepted ? std::string("none") : failure}, {"failureLatched", failed}};
  const auto payload = ApprovalRoundTripWire(fields);
  if (payload.empty()) return Respond(pipe, request, MessageType::kError, ErrorPayload("approval_round_trip_invalid"));
  return Respond(pipe, request, begin ? MessageType::kApprovalRoundTripBeginResult :
                                       MessageType::kApprovalRoundTripEndResult, payload);
}

// The gate, the lane's measurement (a UI Automation read on a bounded worker) and the three private
// message handlers. Behaviour seams that compile the ordinary preflight on any platform cut this
// block and stand behind kWindowsApprovalHandlersEnabled (only the final build declaration opens it).
// N8-2c keeps this gate closed. The authenticated generation is nevertheless mandatory, including
// fixture builds; a missing generation cannot become a wildcard when N8-3 connects Main.
bool WindowsApprovalGate(const WindowsSession &session) {
  const bool open = WindowsApprovalSessionGate(session);
  if (!open && session.maximum_mode == "supervised") session.approval_revoked = true;
  return open &&
      (session.maximum_mode == "supervised" || session.maximum_mode == "full_access_app");
}

bool ReadWindowsApprovalReference(const WindowsSession &session, const std::string &metadata,
    std::uint64_t ticket_generation, sprint_coder::computer_use::WindowsApprovalReference *reference,
    bool offer = false) {
  auto &facts = reference->facts;
  reference->stop_serial = WindowsValidationFrameStopSerial();
  facts.session_id = session.session_id;
  facts.context_digest = WindowsDispatchContextDigest(session);
  facts.payload_digest = WindowsDispatchPayloadDigest(metadata);
  facts.current_cancel_epoch = cancellation_epoch.load(std::memory_order_acquire);
  facts.ticket_generation = ticket_generation;
  return ReadJsonUint64(metadata, "helperGeneration", &reference->helper_generation) &&
      reference->helper_generation != 0 && reference->helper_generation == windows_helper_generation &&
      (offer || ReadJsonUint64(metadata, "approvalGeneration", &facts.approval_generation)) &&
      ReadJsonString(metadata, "taskId", &facts.task_id) &&
      ReadJsonString(metadata, "turnId", &facts.turn_id) &&
      ReadJsonString(metadata, "requestId", &facts.request_id) &&
      ReadJsonString(metadata, "actionDigest", &facts.action_digest) &&
      IsLowerHexDigest64(facts.action_digest) &&
      ReadJsonUint64(metadata, "cancelEpoch", &facts.cancel_epoch) &&
      facts.cancel_epoch == session.cancel_epoch &&
      ReadJsonUint64(metadata, "observationRevision", &facts.observation_revision) &&
      facts.observation_revision == session.observation_revision;
}

sprint_coder::computer_use::WindowsPageEvidence ReadWindowsPage(const WindowsSession &session, HWND window, const std::string &window_identity) {
  using namespace sprint_coder::computer_use;
  WindowsPageEvidence unavailable;
  wchar_t class_name[256]{};
  ShadowUiaCapture window_class;
  window_class.window_class_read = GetClassNameW(window, class_name, 256) > 0;
  window_class.window_class = Utf8FromWide(class_name);
  const auto path = Utf8FromWide(session.canonical_path);
  window_class.process_path_read = !path.empty();
  window_class.process_path = path;
  const bool readable_page = windows_shadow_detail::IsPageBindableBrowser(window_class);
  const bool capped_browser = (session.maximum_mode == "observe_only" || session.maximum_mode == "supervised") &&
      artifact_read_detail::IsBrowserExecutable(path) && windows_shadow_detail::IsWebWindowClass(window_class);
  const bool same_window = window == session.active_window && !window_identity.empty() &&
      window_identity == session.active_window_identity;
  unavailable.web = readable_page || capped_browser || (same_window && session.observed_page.web);
  // Electron/CEF and embedded WebView2 pages are not bound here; existing interlocks own them.
  if (!readable_page || session.maximum_mode == "observe_only") return unavailable;
  const auto epoch = session.cancel_epoch;
  const auto serial = WindowsValidationFrameStopSerial();
  const auto start = MonotonicNowNs();
  WindowsOpenMeasurementLimits limits{[epoch, serial] {
    return WindowsValidationStillCurrent(epoch, serial);
  }, MonotonicNowNs, start, start + 150'000'000};
  auto page = RunWindowsOpenMeasurement<WindowsPageEvidence>(limits,
      [window, pid = session.pid, epoch](const WindowsOpenMeasurementLimits &budget) {
    const WindowsV1UiaPath path(std::chrono::milliseconds(150), epoch);
    auto source = WindowsUiaShadowSource::Create(window, POINT{}, [budget] { return budget.MayRead(); },
        WindowsUiaShadowSource::kInterlockUiaTimeoutMs,
        windows_uia_source_detail::InterlockShellLookupRunning());
    if (!source) return WindowsPageEvidence{};
    source->SetSignatureProvider([pid](IUIAutomationElement *element, std::string *signature) {
      return ComputeWindowsControlSignature(element, pid, nullptr, signature);
    });
    WindowsShadowReader reader(*source);
    auto evidence = reader.ReadPage();
    if (!budget.MayRead()) return WindowsPageEvidence{};
    return evidence;
  }, nullptr, windows_association_detail::WindowsPageMeasurementRunning());
  // A missing/expired read cannot turn a known web window into a native window.
  page.web = true;
  return page;
}

bool RecheckWindowsBoundPageOnLane(HWND window, std::uint32_t pid,
    const sprint_coder::computer_use::WindowsPageEvidence &page,
    const std::function<bool()> &current) {
  if (!current()) return false;
  if (!page.web) return true;
  auto source = sprint_coder::computer_use::WindowsUiaShadowSource::Create(window, POINT{}, current,
      sprint_coder::computer_use::WindowsUiaShadowSource::kInterlockUiaTimeoutMs,
      sprint_coder::computer_use::windows_uia_source_detail::InterlockShellLookupRunning());
  if (!source) return false;
  source->SetSignatureProvider([pid](IUIAutomationElement *element, std::string *signature) {
    return ComputeWindowsControlSignature(element, pid, nullptr, signature);
  });
  sprint_coder::computer_use::WindowsShadowReader reader(*source);
  return reader.RecheckPage(page) && current();
}

bool RecheckWindowsPage(const WindowsSession &session) {
  const auto current = ReadWindowsPage(session, session.active_window, session.active_window_identity);
  if (!session.page_observation_invalidated &&
      sprint_coder::computer_use::WindowsPageAllowsInput(session.observed_page, current)) return true;
  InvalidateWindowsPage(session);
  if (session.round_trip && !session.round_trip->MayLegacyStart()) session.round_trip->Invalidate();
  return false;
}

bool RecheckWindowsPageBeforeInput(const WindowsSession &session) {
  using namespace sprint_coder::computer_use;
  if (!session.observed_page.web) return true;
  const auto epoch = session.cancel_epoch;
  const auto serial = WindowsValidationFrameStopSerial();
  const auto start = MonotonicNowNs();
  WindowsOpenMeasurementLimits limits{[epoch, serial] {
    return WindowsValidationStillCurrent(epoch, serial);
  }, MonotonicNowNs, start, start + 150'000'000};
  const bool matches = !session.page_observation_invalidated &&
      RunWindowsOpenMeasurement<bool>(limits,
          [window = session.active_window, pid = session.pid, page = session.observed_page, epoch]
          (const WindowsOpenMeasurementLimits &budget) {
    const WindowsV1UiaPath path(std::chrono::milliseconds(150), epoch);
    return RecheckWindowsBoundPageOnLane(window, pid, page, [budget] { return budget.MayRead(); });
  });
  if (matches) return true;
  InvalidateWindowsPage(session);
  if (session.round_trip) session.round_trip->Invalidate();
  return false;
}

sprint_coder::computer_use::WindowsApprovalSample MeasureWindowsApprovalOnLane(
    const WindowsSession &session, const std::string &metadata, std::uint64_t deadline) {
  using namespace sprint_coder::computer_use;
  const auto start = MonotonicNowNs();
  const auto epoch = session.cancel_epoch;
  const auto serial = WindowsValidationFrameStopSerial();
  WindowsOpenMeasurementLimits limits{[epoch, serial] {
    return WindowsValidationStillCurrent(epoch, serial);
  }, MonotonicNowNs, start, deadline};
  std::string kind, reason;
  RECT bounds{};
  if (!WindowsApprovalGate(session) || !limits.MayRead() || WindowsSemanticInputInFlight() ||
      !ValidateWindowsBackgroundActionBindingWithinFrame(session, metadata) ||
      !ValidateWindowsDispatchBinding(session, metadata, &kind, &bounds, &reason)) return {};
  if (!RecheckWindowsPage(session)) {
    WindowsApprovalSample refused;
    refused.measured.takeover = true;
    return refused;
  }
  if (kind == "type") {
    std::string text;
    std::vector<std::uint32_t> scalars;
    if (!ReadJsonString(metadata, "text", &text) || !DecodeUtf8Scalars(text, &scalars)) return {};
    // An approval binds one scalar. Longer text is outside the approval's scope, not unmeasurable:
    // the preflight leaves it to the ordinary interlock, which refuses an approval decision.
    if (scalars.size() != 1) {
      WindowsApprovalSample outside;
      outside.outside_approval_scope = true;
      return outside;
    }
  }
  POINT point{};
  if ((kind == "click" || kind == "scroll") && !WindowsActionPoint(bounds, metadata, &point)) return {};
  // Everything the worker reads is owned by value: RunWindowsOpenMeasurement may abandon the worker
  // at the deadline or on Stop and return while it still runs. The worker builds the request's
  // views from its own copy (WindowsApprovalMeasurementRead); this frame and the session may be gone.
  WindowsApprovalOwnedRequest request;
  request.kind = kind;
  request.maximum_mode = session.maximum_mode;
  request.policy_language = session.policy_language;
  (void)ReadJsonString(metadata, "key", &request.key);
  request.click_tracked = kind == "click";
  // Read on the lane, before the worker exists, and handed to it by value (as the interlock entry
  // does); the worker reads no system state of its own for them.
  WindowsApprovalClickBasis click_basis;
  click_basis.tracked = request.click_tracked;
  DWORD input_tick = 0;
  click_basis.input_read = !request.click_tracked || WindowsReadLastInputTick(&input_tick);
  click_basis.input_tick = input_tick;
  request.click_opens = request.click_tracked && WindowsClickOpens();
  click_basis.opens = request.click_opens;
  std::string target;
  (void)ReadJsonString(metadata, "targetId", &target);
  const auto window = session.active_window;
  // input.request stays empty here; the worker fills it from its own copy of the request.
  WindowsApprovalMeasurementInput input;
  input.ruleset = kWindowsInterlockRuleset;
  input.route = ClassifierRoute::kV2;
  input.attested_classifier_version = kNativeEligibilityClassifierVersion;
  input.approval_gate = true;
  input.background = session.input_session.kind == InputSessionKind::kBackground;
  if (input.background) {
    const auto observed = session.semantic_control_signatures.find(target);
    if (observed == session.semantic_control_signatures.end()) return {};
    input.observed_background_binding = observed->second;
  }
  input.strict = {true, session.pid, session.v2_input_not_web};
  input.identity.app_identity = {true, session.app_identity + ":" + session.executable_digest + ":" + session.signer_digest};
  input.identity.process_generation = {true, std::to_string(session.pid) + ":" + session.process_start};
  input.identity.window_identity = {true, session.active_window_identity};
  if (session.observed_page.web)
    input.identity.window_identity.value += ":" + WindowsPageBinding(session.observed_page);
  input.identity.geometry_present = true;
  input.identity.x = bounds.left;
  input.identity.y = bounds.top;
  input.identity.width = bounds.right - bounds.left;
  input.identity.height = bounds.bottom - bounds.top;
  return RunWindowsOpenMeasurement<WindowsApprovalSample>(limits, WindowsApprovalMeasurementRead(
      std::move(request), [window, point, input, target, epoch, click_basis](
          const ShadowRequestInfo &info, const WindowsOpenMeasurementLimits &budget) mutable {
    // `info` views the worker's own copy of the request; nothing here refers to the caller.
    input.request = info;
    const std::string operation(info.kind);
    const WindowsV1UiaPath uia_path(std::chrono::milliseconds(150), epoch);
    auto source = WindowsUiaShadowSource::Create(window, point, [budget] { return budget.MayRead(); },
        WindowsUiaShadowSource::kInterlockUiaTimeoutMs,
        windows_uia_source_detail::InterlockShellLookupRunning());
    if (!source) return WindowsApprovalSample{};
    WindowsUiaRisk native_risk;
    source->SetSignatureProvider([pid = input.strict.process_id, window, &input, &native_risk](
        IUIAutomationElement *element, std::string *signature) {
      if (input.background) {
        if (!ComputeWindowsBackgroundControlSignature(element, pid, window, signature)) return false;
        input.current_background_binding = *signature;
      } else if (!ComputeWindowsControlSignature(element, pid, nullptr, signature)) return false;
      native_risk = ClassifyWindowsUiaElement(element);
      return native_risk.metadata_complete;
    });
    WindowsShadowReader reader(*source);
    reader.ReadChainIdentity(true);
    const auto capture = reader.Capture(operation, target);
    std::string target_signature;
    if (reader.ReadTargetSignature(&target_signature) != ShadowReadResult::kOk)
      return WindowsApprovalSample{};
    std::array<std::int64_t, 4> target_frame{};
    if (reader.ReadTargetFrame(&target_frame) == ShadowReadResult::kOk)
      input.target_frame = {true, target_frame[0], target_frame[1], target_frame[2], target_frame[3]};
    input.capture = &capture;
    input.stopped_by_cancel = reader.Canceled() || reader.Gate().BudgetExhausted() || !budget.MayRead();
    const NativeRiskBits risk{native_risk.classified, native_risk.secure, native_risk.high_impact,
                              native_risk.confirmation, native_risk.other};
    const bool complete = native_risk.metadata_complete && capture.target_found &&
                          capture.chain_reached_root && !capture.read_failed;
    WindowsApprovalDisplay display;
    display.operation = operation;
    display.effect = MeasureWindowsApproval(input).effect;
    // Labels remain explicitly unverified. The closed E2/E3 gates cannot borrow an old path or
    // selection; their open facts are required by MeasureWindowsApprovalSample when connected.
    auto sample = MeasureWindowsApprovalSample(input, std::move(display), risk, complete);
    sample.click_basis = click_basis;
    if (sample.measured.eligible)
      sample.measured.authority_digest = Sha256Hex(sample.measured.authority_digest + target_signature);
    return sample;
  }));
}

sprint_coder::computer_use::WindowsApprovalEnvironment WindowsApprovalEnvironmentFor(
    const WindowsSession &session, const std::string &metadata) {
  using namespace sprint_coder::computer_use;
  return {MonotonicNowNs, GenerateTicketToken,
      [&session](const WindowsApprovalReference &reference, const std::function<void()> &commit) {
        std::lock_guard lock(WindowsTargetListControl().stop_mutex);
        if (!WindowsApprovalGate(session) ||
            reference.helper_generation != windows_helper_generation ||
            !WindowsValidationStillCurrent(reference.facts.cancel_epoch, reference.stop_serial) ||
            WindowsSemanticInputInFlightLocked()) return false;
        commit();
        return true;
      }, [&session, &metadata](std::uint64_t deadline) {
        return MeasureWindowsApprovalOnLane(session, metadata, deadline);
      }};
}

bool HandleWindowsApproval(HANDLE pipe, const Frame &request, const std::string &metadata,
                           MessageType type) {
  using namespace sprint_coder::computer_use;
  const auto key = FrameIdKey(request.header.session_id);
  auto *session = FindWindowsSession(request);
  const auto found = approval_states.find(key);
  if (session == nullptr || found == approval_states.end() || !WindowsApprovalGate(*session))
    return Respond(pipe, request, MessageType::kError, ErrorPayload("native_approval_unavailable"));
  auto &state = found->second;
  ApprovalRoundTripBinding trip_binding;
  if (session->round_trip && !session->round_trip->MayLegacyStart()) {
    const bool allowed = WindowsRoundTripCurrent(*session) &&
        (type == MessageType::kApprovalApprove
             ? ReadWindowsRoundTripBinding(*session, metadata, &trip_binding) && session->round_trip->MayObserve()
             : type == MessageType::kDispatchApproved && WindowsRoundTripMayInput(*session));
    if (!allowed) {
      if (type == MessageType::kApprovalDiscard) session->round_trip->Invalidate("rejected");
      state.Invalidate();
      return Respond(pipe, request, MessageType::kError, ErrorPayload("approval_round_trip_rejected"));
    }
  } else if (metadata.find("\"roundTripId\"") != std::string::npos) {
    return Respond(pipe, request, MessageType::kError, ErrorPayload("approval_round_trip_rejected"));
  }
  WindowsApprovalReference reference;
  if (type == MessageType::kApprovalDiscard) {
    if (!ReadJsonUint64(metadata, "helperGeneration", &reference.helper_generation) ||
        !ReadJsonUint64(metadata, "approvalGeneration", &reference.facts.approval_generation) ||
        reference.helper_generation != windows_helper_generation)
      return Respond(pipe, request, MessageType::kError, ErrorPayload("native_approval_unavailable"));
    const bool discarded = state.Discard(reference);
    return Respond(pipe, request, MessageType::kApprovalDiscardResult,
                   discarded ? "{\"discarded\":true}" : "{\"discarded\":false}");
  }
  if (!ReadWindowsApprovalReference(*session, metadata, ticket_states[key].generation, &reference)) {
    (void)state.Discard(reference);
    return Respond(pipe, request, MessageType::kError, ErrorPayload("native_approval_unavailable"));
  }
  const auto environment = WindowsApprovalEnvironmentFor(*session, metadata);
  NativeApprovalEffect effect = NativeApprovalEffect::kInvalid;
  auto outcome = type == MessageType::kApprovalApprove
      ? state.Approve(reference, environment) : state.Dispatch(reference, environment, &effect);
  if (!trip_binding.id.empty() && (!outcome.ok || !WindowsRoundTripCurrent(*session) ||
      !session->round_trip->Exchange(trip_binding, session->observation_revision,
          ticket_states[key].generation, MonotonicNowNs() / 1000000))) {
    session->round_trip->Invalidate();
    state.Invalidate();
    outcome = {false, NativeApprovalFailure::kRevalidationFailed};
  }
  if (type == MessageType::kApprovalApprove) {
    const auto denial = NativeApprovalDenialFor(outcome.failure);
    const auto &facts = reference.facts;
    return Respond(pipe, request, MessageType::kApprovalApproveResult,
        std::string("{\"ok\":") + (outcome.ok ? "true" : "false") +
        ",\"reasonCode\":" + (outcome.ok ? "null" : "\"" + std::string(denial.reason_code) + "\"") +
        ",\"deniedResult\":" + (outcome.ok ? "null" : "\"" + std::string(denial.result) + "\"") +
        ",\"sessionId\":\"" + JsonEscape(facts.session_id) +
        "\",\"requestId\":\"" + JsonEscape(facts.request_id) +
        "\",\"cancelEpoch\":" + std::to_string(facts.cancel_epoch) +
        ",\"observationRevision\":" + std::to_string(facts.observation_revision) +
        ",\"approvalGeneration\":" + std::to_string(facts.approval_generation) +
        ",\"inputAttemptCount\":" + std::to_string(session->input_api_attempts->load()) + "}");
  }
  if (!outcome.ok) return Respond(pipe, request, MessageType::kError,
                                  ErrorPayload(NativeApprovalDenialFor(outcome.failure).reason_code));
  auto dispatch_session = *session;
  dispatch_session.approved_started_ns = state.claimed_at();
  dispatch_session.approved_deadline_ns = state.deadline();
  dispatch_session.approved_stop_serial = reference.stop_serial;
  dispatch_session.approved_helper_generation = reference.helper_generation;
  const auto &click_basis = state.dispatch_click_basis();
  dispatch_session.approved_click_tracked = click_basis.tracked;
  dispatch_session.approved_click_opens = click_basis.opens;
  dispatch_session.approved_click_input_read = click_basis.input_read;
  dispatch_session.approved_click_input_tick = click_basis.input_tick;
  std::string result, reason;
  bool accepted = false;
  const bool succeeded = DispatchWindowsAction(dispatch_session, metadata, &result, &reason, &accepted, effect);
  if (session->round_trip) session->round_trip->InputFinished();
  return RespondAndCache(pipe, request, succeeded ? MessageType::kDispatchApprovedResult : MessageType::kError,
      succeeded ? "{\"result\":\"completed\",\"reasonCode\":null,\"sessionId\":\"" +
          JsonEscape(session->session_id) + "\",\"cancelEpoch\":" + std::to_string(session->cancel_epoch) +
          ",\"inputAttemptCount\":" + std::to_string(session->input_api_attempts->load()) + "}"
        : ErrorPayload(reason, accepted));
}

// END windows approval measurement and handlers

bool HandleWindowsPreflight(HANDLE pipe, const Frame &request,
                            const std::string &metadata) {
  const WindowsValidationFrameScope frame;
  const std::string session_key = FrameIdKey(request.header.session_id);
  const auto found = sessions.find(session_key);
  if (found == sessions.end())
    return Respond(pipe, request, MessageType::kError,
                   ErrorPayload("session_missing"));
  const WindowsSession &session = found->second;
  if (!WindowsRoundTripCurrent(session) || (session.round_trip && !session.round_trip->MayObserve()))
    return Respond(pipe, request, MessageType::kError, ErrorPayload("approval_round_trip_rejected"));
  bool round_trip_completed = false;
  sprint_coder::computer_use::WindowsRoundTripPreflightGuard round_trip_guard{
      session.round_trip.get(), &round_trip_completed};
  const auto previous_approval = approval_states.find(session_key);
  if (previous_approval != approval_states.end()) previous_approval->second.Invalidate();
  WindowsTicketState &state = ticket_states[session_key];
  state.slot.Invalidate();
  ++state.generation;
  std::string request_id;
  std::string action_digest;
  std::uint64_t cancel_epoch = 0;
  std::uint64_t observation_revision = 0;
  if (!ReadJsonString(metadata, "requestId", &request_id) ||
      request_id.empty() || request_id.size() > 256 ||
      !ReadJsonString(metadata, "actionDigest", &action_digest) ||
      !IsLowerHexDigest64(action_digest) ||
      !ReadJsonUint64(metadata, "cancelEpoch", &cancel_epoch) ||
      !ReadJsonUint64(metadata, "observationRevision", &observation_revision))
    return Respond(pipe, request, MessageType::kError,
                   ErrorPayload("invalid_action"));
  Frame finished;
  finished.header = request.header;
  finished.header.message_type = static_cast<std::uint16_t>(MessageType::kDispatch);
  if (DispatchFrameIdFor(request_id, &finished.header.request_id) &&
      response_cache.contains(ResponseCacheKey(finished)))
    return Respond(pipe, request, MessageType::kPreflightResult,
                   WindowsPreflightReceipt(session, request_id, cancel_epoch,
                                           observation_revision, "replay", "",
                                           ""));
  std::string kind;
  RECT bounds{};
  std::string reason;
  if (!ValidateWindowsBackgroundActionBindingWithinFrame(session, metadata)) {
    return Respond(pipe, request, MessageType::kPreflightResult,
        WindowsPreflightReceipt(session, request_id, cancel_epoch, observation_revision,
                                "denied", "native_stale_target", ""));
  }
  if (!ValidateWindowsDispatchBinding(session, metadata, &kind, &bounds,
                                      &reason)) {
    const bool denied_sent =
        Respond(pipe, request, MessageType::kPreflightResult,
                WindowsPreflightReceipt(session, request_id, cancel_epoch,
                                        observation_revision, "denied",
                                        "native_" + reason, ""));
    // V1 could not re-validate the bound target and its denial is out: the shadow only records
    // that it read nothing.
    if (!kind.empty())
      ScheduleWindowsEffectShadow(session, metadata, kind, false, false);
    return denied_sent;
  }
  if (!RecheckWindowsPage(session))
    return Respond(pipe, request, MessageType::kPreflightResult,
        WindowsPreflightReceipt(session, request_id, cancel_epoch, observation_revision,
                                "takeover", "native_target_unclassified", "", "rejected"));
  if (WindowsApprovalGate(session)) {
    using namespace sprint_coder::computer_use;
    auto &approval = approval_states[session_key];
    approval.Invalidate();
    WindowsApprovalReference reference;
    WindowsApprovalSample measured;
    std::string offer_receipt;
    const WindowsApprovalReceiptContext context{request_id, session.session_id, cancel_epoch,
        observation_revision, session.input_api_attempts->load(std::memory_order_acquire)};
    const bool offered =
        ReadWindowsApprovalReference(session, metadata, state.generation, &reference, true) &&
        approval.Offer(reference, context, WindowsApprovalEnvironmentFor(session, metadata),
                       &offer_receipt, &measured);
    // One measurement decides. Offered: no ordinary ticket. A takeover, an unmeasurable request, an
    // approval that cannot be offered, or a failed offer is refused (never an ordinary ticket). A
    // measured ordinary or blocked decision continues to the interlock below, which issues the
    // ordinary ticket or refuses with the blocked reason code.
    switch (RouteWindowsApprovalPreflight(offered, measured)) {
    case WindowsApprovalPreflightRoute::kOffered: {
      if (session.round_trip && !session.round_trip->MayLegacyStart()) {
        ApprovalRoundTripBinding binding;
        if (!ReadWindowsRoundTripBinding(session, metadata, &binding) ||
            !WindowsRoundTripCurrent(session) || !session.round_trip->Offer(binding,
                session.observation_revision, MonotonicNowNs() / 1000000)) {
          approval.Invalidate();
          return Respond(pipe, request, MessageType::kError, ErrorPayload("approval_round_trip_rejected"));
        }
      }
      round_trip_completed = Respond(pipe, request, MessageType::kPreflightResult, offer_receipt);
      if (!round_trip_completed) approval.Invalidate();
      return round_trip_completed;
    }
    case WindowsApprovalPreflightRoute::kRefuse:
      return Respond(pipe, request, MessageType::kPreflightResult,
          WindowsPreflightReceipt(session, request_id, cancel_epoch, observation_revision,
                                  "denied", "native_approval_unavailable", ""));
    case WindowsApprovalPreflightRoute::kInterlock:
      break;
    }
  }
  // The v2 interlocks (#500 S5-c-2 PR-5): AFTER the V1 binding is valid and BEFORE a ticket is
  // issued. A refusal issues no ticket (the slot was invalidated above). No verdict (budget,
  // incomplete facts, canceled) leaves the V1 answer: an ordinary ticket as before.
  {
    const sprint_coder::computer_use::InterlockEvaluation evaluation =
        WindowsInterlockRefusal(session, metadata, kind);
    if (evaluation.Refuses()) {
      const std::string decision(evaluation.verdict.DecisionName());
      const std::string code(evaluation.verdict.ReasonCode());
      const std::string result(evaluation.verdict.DeniedResult());
      const bool sent = Respond(
          pipe, request, MessageType::kPreflightResult,
          sprint_coder::computer_use::NativePreflightRefusalAllowed(decision, code, result)
              ? WindowsPreflightReceipt(session, request_id, cancel_epoch, observation_revision,
                                        decision, code, "", result)
              : WindowsPreflightReceipt(session, request_id, cancel_epoch, observation_revision,
                                        "denied", "native_preflight_invalid", ""));
      // The V1 answer is "no ticket": the shadow records that V1 did not issue its ordinary one.
      ScheduleWindowsEffectShadow(session, metadata, kind, true, false);
      return sent;
    }
  }
  std::string token;
  bool issued = false;
  if (GenerateTicketToken(&token)) {
    auto binding = WindowsTicketBinding(session, request_id, action_digest,
                                        WindowsDispatchPayloadDigest(metadata),
                                        cancel_epoch, state.generation);
    const auto now = MonotonicNowNs();
    // Crypto and target reads stay outside the reader's Stop lock. Only the bounded slot commit
    // is ordered with Stop, using the original frame rather than a fresh serial after the wait.
    std::lock_guard stop_lock(WindowsTargetListControl().stop_mutex);
    if (session.cancel_epoch == cancel_epoch &&
        WindowsValidationStillCurrent(cancel_epoch, frame.StopSerial()))
      issued = state.slot.Issue(token, std::move(binding), now,
          sprint_coder::computer_use::kNativeOrdinaryTicketTtlNs);
  }
  if (session.round_trip && !session.round_trip->MayLegacyStart()) {
    sprint_coder::computer_use::ApprovalRoundTripBinding binding;
    if (!issued || !ReadWindowsRoundTripBinding(session, metadata, &binding) ||
        !WindowsRoundTripCurrent(session) || !session.round_trip->Exchange(binding,
            session.observation_revision, state.generation, MonotonicNowNs() / 1000000)) {
      session.round_trip->Invalidate();
      state.slot.Invalidate();
      issued = false;
    }
  }
  std::string receipt = WindowsPreflightReceipt(
      session, request_id, cancel_epoch, observation_revision,
      issued ? "ordinary" : "denied",
      issued ? "" : "native_ticket_unavailable", issued ? token : "");
  const bool sent =
      Respond(pipe, request, MessageType::kPreflightResult, receipt);
  round_trip_completed = issued && sent;
  // The secret only needs to live until it is on the wire (the slot keeps its own copy).
  ScrubString(&token);
  ScrubString(&receipt);
  // The V1 answer is out; the v2 classifier only watches (see the shadow wiring above).
  ScheduleWindowsEffectShadow(session, metadata, kind, true, issued);
  return sent;
}

