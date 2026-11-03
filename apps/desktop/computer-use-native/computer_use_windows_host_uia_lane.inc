// The bounds on the UI Automation calls of the V1 lane (observe, the point / focus classification, the
// control bindings, the semantic target search, the focused-element signature that the re-validation
// uses). Without them a target that does not answer holds the serial lane for good, and every later
// frame (observe, preflight, dispatch, Cancel) waits behind it (#820). Three rules:
//
//  1. ONE call is bounded. The CONNECTION timeout (500 ms) bounds the first contact with a target and
//     the TRANSACTION timeout (300 ms) a call on an element already connected (measured on a window that
//     does not answer: 311 ms for 300 and 2001 ms for 2000; the connection timeout is the one that
//     governs a first contact). 500 ms leaves a cold app time to load its providers on the first call (a
//     call that still times out is reported as accessibility_timeout, a failure that a new observe does
//     not repeat once the providers are loaded). A call that waits for the connection and then for the
//     transaction is bounded by BOTH: the worst case of one call is counted as 500 + 300 = 800 ms,
//     inside the 1 s of the Cancel acknowledgment (COMPUTER_USE_NATIVE_CANCEL_ACK_TIMEOUT_MS). The two
//     waits DO follow each other: on the CI of PR #822 (2026-10-17) a ClassifyWindowsFocusedElement case
//     of the live seam came back after 844 ms. The margin is SMALL: what is left of the 1 s for
//     everything else the lane does between the epoch moving and the acknowledgment (the pipe, the frame,
//     the answer) was about 156 ms there. Measured on CI one at a time: a transaction-bound call is cut
//     after 310-320 ms, a first contact after 505-514 ms. Under more load the margin can be less (not
//     verified). The live seam's bound on one case is this counted worst case and 150 ms (950 ms).
//  2. The FIRST timed-out call (UIA_E_TIMEOUT or an equivalent failure) ends its path for good: no
//     UI Automation call after it, fail closed, the "unreadable" of the caller. A target that answers
//     the first contact and then stops therefore costs one timeout, not one per remaining call.
//  3. A CANCEL ends the path too, and it is asked before EVERY call (WindowsV1UiaCall, and the entry of
//     every read of properties): the epoch is the one that was current when the path began (observe:
//     the session's own). So a Cancel that arrives while the lane reads a slow but live app waits for
//     at most the call that is under way: one call, 800 ms at the worst, never the whole path.
//  Without an outer deadline, read workers bound noncontact calls to 800 ms and the shared read plus
//  cleanup to 5 s (image jobs: 25 s). An inherited absolute deadline is kept unchanged. A blocked API
//  or destructor keeps its slot busy;
//  Main retains the original request deadline after a residual response. Input path/claim policy is
//  separate. The whole observe has a 25 s budget so that
//  the native answers with its own reason (observation_timeout, with the number of nodes it had read
//  logged) before the 30 s Main gives an observe runs out; it is wide because a tree of several thousand
//  nodes of an ordinary app is read four times (two readings, two binding captures) and must not fail.
//  4. A call that "succeeds" only after (nearly) the whole timeout has not answered either: some
//  systems return a default value for a property when the provider times out (measured on a CI runner:
//  five property reads of a native provider that does not answer took 1.5 s and all succeeded, with
//  empty values). So the time of each call is measured, and a call that took within 30 ms of its
//  timeout AND left its output empty (the shape only a cut-off call produces: no element, no string,
//  zero; WindowsV1UiaEmpty) is a timed-out call (WindowsV1UiaTimed), whatever the HRESULT says. A slow
//  call that did hand back a value has answered: a live app under load can be slow and right, and
//  cutting it off would turn it into "unclassified" (#823). Where an empty output is also a real answer
//  (an empty name, no child, FALSE), a slow one is still taken for a timeout: fail closed. A first
//  contact is the exception: a slow one is a timeout whatever it hands back, because UI Automation
//  builds the element of a window from its HWND even when the app's provider was cut off
//  (WindowsV1UiaContact).
// A failed (timed out, canceled, over the observe budget) read is exactly the "unreadable" of each
// caller (stale target, rejected action, or an observation that is not produced): the meaning of V1's
// answers is not changed.
constexpr DWORD kWindowsV1UiaConnectionTimeoutMs = 500;
constexpr DWORD kWindowsV1UiaTransactionTimeoutMs = 300;
constexpr std::chrono::milliseconds kWindowsV1UiaObserveBudget{25'000};
constexpr std::chrono::milliseconds kWindowsUiaReadBudget{5'000};
constexpr std::chrono::milliseconds kWindowsUiaCallBudget{800};

// The ONE place the V1 lane creates UI Automation. The bounded one when the system has it
// (CreateBoundedAutomation); if IUIAutomation2 cannot be had it falls back to the plain one, as before
// this bound existed (no timeout), and counts it, so that the missing bound is visible and not silent.
std::atomic<long> windows_v1_uia_unbounded_creations{0};
HRESULT CreateWindowsV1Automation(IUIAutomation **automation) {
  *automation = nullptr;
  if (sprint_coder::computer_use::windows_uia_source_detail::CreateBoundedAutomation(
          kWindowsV1UiaConnectionTimeoutMs, kWindowsV1UiaTransactionTimeoutMs, automation))
    return S_OK;
  if (windows_v1_uia_unbounded_creations.fetch_add(1) == 0)
    OutputDebugStringA("computer-use: V1 UI Automation without a call timeout (IUIAutomation2 unavailable)\n");
  return CoCreateInstance(CLSID_CUIAutomation, nullptr, CLSCTX_INPROC_SERVER,
                          IID_PPV_ARGS(automation));
}

enum class WindowsV1UiaStop { kNone, kTimeout, kBudget, kCanceled };

struct WindowsUiaReadProgress {
  std::mutex mutex;
  std::condition_variable ready;
  std::atomic<WindowsV1UiaStop> abandoned{WindowsV1UiaStop::kNone};
  std::atomic<WindowsV1UiaStop> stop{WindowsV1UiaStop::kNone};
  std::atomic<std::size_t> nodes{0};
  bool contact_active = false;
  bool call_active = false;
  std::chrono::steady_clock::time_point contact_started;
  bool done = false;
};

template <class Result> struct WindowsUiaReadPending : WindowsUiaReadProgress {
  std::optional<Result> value;
};

// Installed only by the UIA read worker. No caller's lane or COM pointer crosses threads.
thread_local WindowsUiaReadProgress *windows_uia_read_progress = nullptr;

std::atomic<bool> &WindowsUiaReadWorkerRunning() {
  // A provider stuck in COM may outlive ServePipe and static destruction.
  static auto *running = new std::atomic<bool>{false};
  return *running;
}

std::atomic<bool> &WindowsCaptureWorkerRunning() {
  // A stalled capture must not block a healthy UIA read, or inherit a timed-out UIA worker's slot.
  static auto *running = new std::atomic<bool>{false};
  return *running;
}

struct WindowsV1UiaLane {
  bool has_deadline = false;
  std::chrono::steady_clock::time_point deadline;
  std::uint64_t epoch = 0;
  std::optional<std::uint64_t> stop_serial;
  std::size_t nodes = 0;  // the nodes of the walks read so far (for the log of a spent budget)
  WindowsV1UiaStop stop = WindowsV1UiaStop::kNone;
};
thread_local WindowsV1UiaLane *windows_v1_uia_lane = nullptr;

// One path of UI Automation calls on the lane. The OUTERMOST scope owns the state; one inside it (the
// classification inside a dispatch's own scope, the signature inside a re-validation) shares it. A path
// always watches the cancellation epoch; only the observe has a time budget.
class WindowsV1UiaPath {
public:
  // A path that watches the cancellation epoch as it is now, with no time budget.
  WindowsV1UiaPath()
      : WindowsV1UiaPath(std::chrono::milliseconds::zero(),
                         cancellation_epoch.load(std::memory_order_acquire)) {}
  WindowsV1UiaPath(std::chrono::milliseconds budget, std::uint64_t epoch,
                   std::optional<std::uint64_t> stop_serial = std::nullopt) {
    if (windows_v1_uia_lane != nullptr)
      return;
    if (budget > std::chrono::milliseconds::zero()) {
      lane_.has_deadline = true;
      lane_.deadline = std::chrono::steady_clock::now() + budget;
    }
    lane_.epoch = epoch;
    lane_.stop_serial = stop_serial;
    windows_v1_uia_lane = &lane_;
    owner_ = true;
  }
  // An observation worker inherits the absolute deadline, not a fresh budget.
  explicit WindowsV1UiaPath(WindowsV1UiaLane snapshot) : lane_(std::move(snapshot)) {
    if (windows_v1_uia_lane == nullptr) {
      windows_v1_uia_lane = &lane_;
      owner_ = true;
    }
  }
  ~WindowsV1UiaPath() {
    if (owner_)
      windows_v1_uia_lane = nullptr;
  }
  WindowsV1UiaPath(const WindowsV1UiaPath &) = delete;
  WindowsV1UiaPath &operator=(const WindowsV1UiaPath &) = delete;
  [[nodiscard]] WindowsV1UiaStop Stop() const { return windows_v1_uia_lane != nullptr ? windows_v1_uia_lane->stop : WindowsV1UiaStop::kNone; }
  [[nodiscard]] std::size_t Nodes() const { return windows_v1_uia_lane != nullptr ? windows_v1_uia_lane->nodes : 0; }

private:
  WindowsV1UiaLane lane_;
  bool owner_ = false;
};

// Whether the path may make one more UI Automation call. False for good once a call timed out, the
// action was canceled or (the observe) the budget is spent. Outside any path: false (fail closed). Every
// V1 call is reached from inside a path; a call that is not would watch neither a Cancel nor the first
// timeout, so it is refused instead of made unwatched.
bool WindowsV1UiaMayCall() {
  WindowsV1UiaLane *lane = windows_v1_uia_lane;
  if (lane == nullptr)
    return false;
  // The consumer already rejected this result; no further provider calls are useful.
  if (lane->stop == WindowsV1UiaStop::kNone && windows_uia_read_progress != nullptr)
    lane->stop = windows_uia_read_progress->abandoned.load(std::memory_order_acquire);
  if (lane->stop == WindowsV1UiaStop::kNone) {
    if (cancellation_epoch.load(std::memory_order_acquire) != lane->epoch ||
        (lane->stop_serial.has_value() &&
         (WindowsTargetListControl().stop_serial.load(std::memory_order_acquire) !=
              *lane->stop_serial || parent_process_dead.load(std::memory_order_acquire))))
      lane->stop = WindowsV1UiaStop::kCanceled;
    else if (lane->has_deadline && std::chrono::steady_clock::now() > lane->deadline)
      lane->stop = WindowsV1UiaStop::kBudget;
  }
  if (windows_uia_read_progress != nullptr && lane->stop != WindowsV1UiaStop::kNone)
    windows_uia_read_progress->stop.store(lane->stop, std::memory_order_release);
  return lane->stop == WindowsV1UiaStop::kNone;
}

constexpr HRESULT kWindowsV1UiaTimeoutResult = static_cast<HRESULT>(0x80131505);  // UIA_E_TIMEOUT

// A timeout of UI Automation or of the RPC under it.
bool WindowsV1UiaIsTimeout(HRESULT result) {
  constexpr HRESULT kWin32Timeout = static_cast<HRESULT>(0x800705B4);  // HRESULT_FROM_WIN32(ERROR_TIMEOUT)
  constexpr HRESULT kRpcTimeout = static_cast<HRESULT>(0x8001011F);    // RPC_E_TIMEOUT
  return result == kWindowsV1UiaTimeoutResult || result == kWin32Timeout || result == kRpcTimeout;
}

// The result of a UI Automation call, as success or not. A timed-out call also ends its path.
bool WindowsV1UiaOk(HRESULT result) {
  if (SUCCEEDED(result))
    return true;
  WindowsV1UiaLane *lane = windows_v1_uia_lane;
  if (lane != nullptr && lane->stop == WindowsV1UiaStop::kNone && WindowsV1UiaIsTimeout(result))
    lane->stop = WindowsV1UiaStop::kTimeout;
  if (windows_uia_read_progress != nullptr && lane != nullptr &&
      lane->stop != WindowsV1UiaStop::kNone)
    windows_uia_read_progress->stop.store(lane->stop, std::memory_order_release);
  return false;
}

// A call that took this long and "succeeded" with an empty output has been cut off by its timeout
// (30 ms under it): 270 ms against the 300 ms transaction timeout, 470 ms against the 500 ms connection
// timeout.
constexpr std::chrono::milliseconds kWindowsV1UiaSlowRead{270};
constexpr std::chrono::milliseconds kWindowsV1UiaSlowContact{470};
static_assert(kWindowsV1UiaSlowRead.count() < kWindowsV1UiaTransactionTimeoutMs, "a read is slow before it times out");
static_assert(kWindowsV1UiaSlowContact.count() < kWindowsV1UiaConnectionTimeoutMs, "a contact is slow before it times out");

// Whether the output of a call has the shape a cut-off call leaves behind (#823): nothing. Measured on
// CI, a timed-out read comes back S_OK with an empty value; a slow call that handed back something real
// has answered. One rule for every type, its zero value: no element / pattern / walker / SAFEARRAY (a
// null pointer), no string (a null or zero-length BSTR), and for the value types, which have no "nothing"
// of their own, the zero a cut-off call leaves (0, FALSE, the first enumerator, an all-zero RECT). A
// process id or a control type of 0 is no answer at all. Where the zero is a real answer too (an element
// with no name, a leaf with no child, the last sibling, a control that is not a password one,
// ToggleState_Off, ExpandCollapseState_Collapsed), a SLOW zero is still taken for a timeout: fail closed,
// as before #823 (IsPassword in particular must never read a cut-off FALSE as "not a password"). A fast
// zero is an answer, whatever it is. A cut-off call that writes nothing leaves the caller's starting
// value: every output starts empty (nullptr, 0, FALSE, an all-zero RECT), except the two pattern states,
// which start at ToggleState_Indeterminate / ExpandCollapseState_LeafNode; a slow one of those is taken
// for an answer here, but the caller rejects exactly those values (semantic_state_unavailable), so both
// shapes of a cut-off state read are refused.
inline bool WindowsV1UiaEmpty(BSTR value) { return SysStringLen(value) == 0; }
template <class Pointee> bool WindowsV1UiaEmpty(Pointee *value) { return value == nullptr; }
inline bool WindowsV1UiaEmpty(const RECT &value) {
  return value.left == 0 && value.top == 0 && value.right == 0 && value.bottom == 0;
}
template <class Value>
  requires(std::is_arithmetic_v<Value> || std::is_enum_v<Value>)
bool WindowsV1UiaEmpty(Value value) {
  return value == Value{};
}

class WindowsUiaReadContact {
public:
  WindowsUiaReadContact(bool contact, std::chrono::steady_clock::time_point started)
      : pending_(windows_uia_read_progress) {
    if (pending_ == nullptr)
      return;
    {
      std::lock_guard lock(pending_->mutex);
      pending_->contact_started = started;
      pending_->contact_active = contact;
      pending_->call_active = true;
    }
    pending_->ready.notify_one();
  }
  ~WindowsUiaReadContact() {
    if (pending_ == nullptr)
      return;
    {
      std::lock_guard lock(pending_->mutex);
      pending_->contact_active = false;
      pending_->call_active = false;
    }
    pending_->ready.notify_one();
  }
  void Completed(HRESULT result) {
    // Publish before clearing contact_active, including when later COM cleanup blocks.
    if (pending_ != nullptr && WindowsV1UiaIsTimeout(result))
      pending_->stop.store(WindowsV1UiaStop::kTimeout, std::memory_order_release);
  }

private:
  WindowsUiaReadProgress *pending_;
};

// One UI Automation call of a path: the cancel / timeout / budget check first (E_ABORT, no call made,
// when the path has ended), then the call, timed. `output` is the call's own out-value (read after the
// call). A call that came back only after nearly its whole timeout with an empty output (or, where the
// output proves nothing, with any output) is a timed-out call (UIA_E_TIMEOUT), even if it says S_OK; a
// slow call with a real output is a success.
template <class Value, class Call>
HRESULT WindowsV1UiaTimed(std::chrono::milliseconds slow, bool output_proves_answer, const Value &output, Call &&call) {
  if (!WindowsV1UiaMayCall())
    return E_ABORT;
  const auto start = std::chrono::steady_clock::now();
  WindowsUiaReadContact contact(!output_proves_answer, start);
#if defined(SPRINT_CODER_COMPUTER_USE_TEST_HANG)
  WindowsTestHang(WindowsTestHangPoint::UiaCall);
#endif
  HRESULT result = call();
  if (SUCCEEDED(result) && std::chrono::steady_clock::now() - start >= slow &&
      (!output_proves_answer || WindowsV1UiaEmpty(output)))
    result = kWindowsV1UiaTimeoutResult;
  contact.Completed(result);
  return result;
}
// A call on a connected element (walker moves, the parent): a slow one is an answer when it hands back
// an element.
template <class Value, class Call> HRESULT WindowsV1UiaCall(const Value &output, Call &&call) {
  return WindowsV1UiaTimed(kWindowsV1UiaSlowRead, true, output, call);
}
// The first contact with a target (ElementFromHandle / ElementFromPoint / GetFocusedElement). A slow
// contact is a timeout WHATEVER it hands back (as in #820, kept by #823): UI Automation builds the
// element of a window from its HWND (the host proxy) even when the app's own provider was cut off
// (measured locally: ElementFromHandle on a provider that stopped answering, 1026 ms, S_OK, an element),
// so an element is no proof that the app answered. The output is still named, as every wrapped call names
// its own, but it does not decide.
template <class Value, class Call> HRESULT WindowsV1UiaContact(const Value &output, Call &&call) {
  return WindowsV1UiaTimed(kWindowsV1UiaSlowContact, false, output, call);
}
// One read of a property: true only for a call that answered (in time, or slowly with a value).
template <class Value, class Call> bool WindowsV1UiaRead(const Value &output, Call &&call) {
  return WindowsV1UiaOk(WindowsV1UiaTimed(kWindowsV1UiaSlowRead, true, output, call));
}

// Why the path ended, now (kNone outside a path).
WindowsV1UiaStop WindowsV1UiaCurrentStop() {
  return windows_v1_uia_lane != nullptr ? windows_v1_uia_lane->stop : WindowsV1UiaStop::kNone;
}

// The reason of an action that was NOT sent because the path had ended (a timeout, a Cancel): nothing
// was done, so it is a rejection before any input.
const char *WindowsV1UiaEndedReason() {
  return WindowsV1UiaCurrentStop() == WindowsV1UiaStop::kTimeout ? "accessibility_timeout"
                                                                  : "semantic_action_failed";
}

// One node of a walk was visited.
void WindowsV1UiaCountNode() {
  if (windows_v1_uia_lane != nullptr)
    ++windows_v1_uia_lane->nodes;
  if (windows_uia_read_progress != nullptr)
    windows_uia_read_progress->nodes.fetch_add(1, std::memory_order_relaxed);
}

// The reason an observe gives for a read that did not complete: a target that did not answer
// (accessibility_timeout: transient, a new observe can succeed, for example once a cold app has loaded
// its providers), a spent budget (observation_timeout) or a cancel (observation_stale); else the reason
// the step had.
const char *WindowsV1ObserveReason(WindowsV1UiaStop stop, const char *otherwise) {
  switch (stop) {
  case WindowsV1UiaStop::kTimeout:
    return "accessibility_timeout";
  case WindowsV1UiaStop::kBudget:
    return "observation_timeout";
  case WindowsV1UiaStop::kCanceled:
    return "observation_stale";
  case WindowsV1UiaStop::kNone:
    break;
  }
  return otherwise;
}

bool HasUiAutomation() {
  IUIAutomation *automation = nullptr;
  const HRESULT result =
      CreateWindowsV1Automation(&automation);
  if (FAILED(result) || automation == nullptr)
    return false;
  automation->Release();
  return true;
}

// The warm-up of the client side of UI Automation, once, when the serving host starts (ServeMain,
// after ProbeBackend and before the pipe is connected; not in ProbeMain, whose process ends at once):
// the first contact a process makes loads UI Automation's client side, and that cost would be charged
// to the first app the lane contacts, against the slow-contact mark (kWindowsV1UiaSlowContact): an app
// that answers would be reported as accessibility_timeout. Measured locally (2026-10-18, 40 busy
// processes on 20 cores, a target window that already answered): the cold first contact took
// 160-460 ms; after reading the desktop root once (UI Automation's own element, no app behind it, also
// from another thread) it took 7-34 ms. The read is not a V1 path and decides nothing: its result is
// ignored.
void WarmWindowsV1Automation() {
  IUIAutomation *automation = nullptr;
  if (FAILED(CreateWindowsV1Automation(&automation)) || automation == nullptr)
    return;
  IUIAutomationElement *desktop = nullptr;
  if (SUCCEEDED(automation->GetRootElement(&desktop)) && desktop != nullptr)
    desktop->Release();
  automation->Release();
}

