#if !defined(_WIN32)
#error "The Computer Use Windows host must be compiled on Windows"
#endif

#if !defined(SPRINT_CODER_SOURCE_COMMIT)
#error "The Computer Use Windows host requires an embedded source commit"
#endif

#include <windows.h>

#include <ole2.h>
#include <UIAutomation.h>
#include <VersionHelpers.h>
#include <bcrypt.h>
#include <dwmapi.h>
#include <sddl.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <softpub.h>
#include <tlhelp32.h>
#include <userenv.h>
#include <wincrypt.h>
#include <winnls.h>
#include <wintrust.h>
#include <mscat.h>
#include <appmodel.h>
#include <psapi.h>
#include <winioctl.h>

#if defined(_MSC_VER) && __has_include(<winrt/Windows.Graphics.Capture.h>) && \
    __has_include(<windows.graphics.capture.interop.h>) && \
    __has_include(<windows.graphics.directx.direct3d11.interop.h>)
#define SPRINT_CODER_HAS_WINDOWS_GRAPHICS_CAPTURE 1
#include <d3d11.h>
#include <dxgi1_2.h>
#include <wincodec.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <winrt/base.h>
#include <wrl/client.h>
#else
#define SPRINT_CODER_HAS_WINDOWS_GRAPHICS_CAPTURE 0
#endif

// The package catalog the v2 target facts read SignatureKind from (S5-c-3, #500 PR-2).
#if defined(_MSC_VER) && __has_include(<winrt/Windows.ApplicationModel.h>) &&     \
    __has_include(<winrt/Windows.Management.Deployment.h>)
#define SPRINT_CODER_HAS_WINDOWS_PACKAGE_CATALOG 1
#include <winrt/Windows.ApplicationModel.h>
#include <winrt/Windows.Management.Deployment.h>
#else
#define SPRINT_CODER_HAS_WINDOWS_PACKAGE_CATALOG 0
#endif

#if defined(SPRINT_CODER_REQUIRE_WINDOWS_GRAPHICS_CAPTURE) &&                  \
    !SPRINT_CODER_HAS_WINDOWS_GRAPHICS_CAPTURE
#error                                                                         \
    "Windows Graphics Capture headers are required for the packaged Computer Use helper"
#endif

#include <algorithm>
#include <array>
#include <atomic>
#include <charconv>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <functional>
#include <iostream>
#include <iterator>
#include <limits>
#include <memory>
#include <mutex>
#include <set>
#include <span>
#include <string>
#include <string_view>
#include <chrono>
#include <cstdio>
#include <thread>
#include <type_traits>
#include <unordered_map>
#include <utility>
#include <vector>

#include "computer_use_protocol.h"
#include "computer_use_native_ticket.h"
#include "computer_use_preflight_classifier.h"
#include "computer_use_native_eligibility.h"
#include "computer_use_windows_uia_source.h"
#include "computer_use_windows_shadow_scheduler.h"
#include "computer_use_windows_interlock_capture.h"
#include "computer_use_native_refusal_table.h"
#include "computer_use_windows_artifact_read.h"
#include "computer_use_windows_target_facts.h"

namespace {
#include "computer_use_windows_host_common.inc"
#include "computer_use_windows_host_identity.inc"
#include "computer_use_windows_host_target_facts.inc"
#include "computer_use_windows_host_discovery.inc"
#include "computer_use_windows_host_v2_targets.inc"
#include "computer_use_windows_host_discovery_worker.inc"
#include "computer_use_windows_host_session.inc"
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
//  There is deliberately NO time budget on a path: a deep tree of a live app (an Electron or Office
//  window read up the parents, one call each) can take a long time while every call answers, and
//  cutting it short would turn a live app into "unclassified" and change what V1 answers. A Cancel needs
//  no budget either (rule 3). The one budget is the whole observe (25 s), and it is there only so that
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
      : pending_(contact ? windows_uia_read_progress : nullptr) {
    if (pending_ == nullptr)
      return;
    {
      std::lock_guard lock(pending_->mutex);
      pending_->contact_started = started;
      pending_->contact_active = true;
    }
    pending_->ready.notify_one();
  }
  ~WindowsUiaReadContact() {
    if (pending_ == nullptr)
      return;
    {
      std::lock_guard lock(pending_->mutex);
      pending_->contact_active = false;
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

bool HasGraphicsCaptureFactory() {
#if SPRINT_CODER_HAS_WINDOWS_GRAPHICS_CAPTURE
  try {
    auto factory = winrt::get_activation_factory<
        winrt::Windows::Graphics::Capture::GraphicsCaptureItem,
        IGraphicsCaptureItemInterop>();
    return factory != nullptr;
  } catch (...) {
    return false;
  }
#else
  return false;
#endif
}

bool CaptureWindowWithGraphicsCapture(HWND window, std::uint64_t epoch,
                                      std::uint64_t stop_serial,
                                      std::vector<std::uint8_t> *output,
                                      std::size_t *width, std::size_t *height,
                                      WindowsV1UiaStop *stop = nullptr);
bool ReadWindowsPngPatchGrid(std::vector<std::uint8_t> *png, std::size_t width,
                             std::size_t height, std::uint64_t epoch, std::uint64_t serial,
                             std::vector<std::string> *digests, std::size_t *columns,
                             std::size_t *rows, WindowsV1UiaStop *stop);
bool ReadWindowsPngPatchDigest(std::vector<std::uint8_t> *png, std::size_t width,
                               std::size_t height, double x, double y,
                               std::uint64_t epoch, std::uint64_t serial,
                               std::string *digest, std::size_t *index);

#if SPRINT_CODER_HAS_WINDOWS_GRAPHICS_CAPTURE
bool CaptureWindowWithGraphicsCaptureOnWorker(HWND window,
                                      std::vector<std::uint8_t> *output,
                                      std::size_t *width, std::size_t *height) {
  if (!WindowsV1UiaMayCall() || window == nullptr || GetForegroundWindow() != window)
    return false;
  try {
    RECT client_bounds{};
    RECT frame_bounds{};
    if (!ClientBoundsPhysical(window, &client_bounds) ||
        FAILED(DwmGetWindowAttribute(window, DWMWA_EXTENDED_FRAME_BOUNDS,
                                     &frame_bounds, sizeof(frame_bounds))) ||
        frame_bounds.right <= frame_bounds.left ||
        frame_bounds.bottom <= frame_bounds.top ||
        client_bounds.left < frame_bounds.left ||
        client_bounds.top < frame_bounds.top ||
        client_bounds.right > frame_bounds.right ||
        client_bounds.bottom > frame_bounds.bottom)
      return false;
    auto interop = winrt::get_activation_factory<
        winrt::Windows::Graphics::Capture::GraphicsCaptureItem,
        IGraphicsCaptureItemInterop>();
    winrt::Windows::Graphics::Capture::GraphicsCaptureItem capture_item{
        nullptr};
    if (FAILED(interop->CreateForWindow(
            window,
            winrt::guid_of<
                winrt::Windows::Graphics::Capture::GraphicsCaptureItem>(),
            reinterpret_cast<void **>(winrt::put_abi(capture_item)))))
      return false;
    const auto source_size = capture_item.Size();
    if (source_size.Width <= 0 || source_size.Height <= 0 ||
        source_size.Width > 16'384 || source_size.Height > 16'384)
      return false;
    const double source_x_scale =
        static_cast<double>(source_size.Width) /
        static_cast<double>(frame_bounds.right - frame_bounds.left);
    const double source_y_scale =
        static_cast<double>(source_size.Height) /
        static_cast<double>(frame_bounds.bottom - frame_bounds.top);
    const auto crop_left = static_cast<UINT>(std::clamp(
        std::lround((client_bounds.left - frame_bounds.left) * source_x_scale),
        0l, static_cast<long>(source_size.Width - 1)));
    const auto crop_top = static_cast<UINT>(std::clamp(
        std::lround((client_bounds.top - frame_bounds.top) * source_y_scale),
        0l, static_cast<long>(source_size.Height - 1)));
    const auto crop_right = static_cast<UINT>(std::clamp(
        std::lround((client_bounds.right - frame_bounds.left) * source_x_scale),
        static_cast<long>(crop_left + 1),
        static_cast<long>(source_size.Width)));
    const auto crop_bottom = static_cast<UINT>(std::clamp(
        std::lround((client_bounds.bottom - frame_bounds.top) * source_y_scale),
        static_cast<long>(crop_top + 1),
        static_cast<long>(source_size.Height)));
    const UINT client_width = crop_right - crop_left;
    const UINT client_height = crop_bottom - crop_top;
    constexpr double kMaximumRawCapturePixels = (7.0 * 1024.0 * 1024.0) / 4.0;
    const double byte_scale = std::sqrt(kMaximumRawCapturePixels /
                                        (static_cast<double>(client_width) *
                                         static_cast<double>(client_height)));
    const double scale = std::min(
        1.0, std::min(byte_scale,
                      std::min(2'560.0 / static_cast<double>(client_width),
                               1'600.0 / static_cast<double>(client_height))));
    const auto capture_width = static_cast<std::size_t>(
        std::max(1.0, std::floor(static_cast<double>(client_width) * scale)));
    const auto capture_height = static_cast<std::size_t>(
        std::max(1.0, std::floor(static_cast<double>(client_height) * scale)));
    if (capture_width == 0 || capture_height == 0)
      return false;

    Microsoft::WRL::ComPtr<ID3D11Device> device;
    Microsoft::WRL::ComPtr<ID3D11DeviceContext> context;
    D3D_FEATURE_LEVEL level{};
    if (FAILED(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
                                 D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0,
                                 D3D11_SDK_VERSION, &device, &level, &context)))
      return false;
    Microsoft::WRL::ComPtr<IDXGIDevice> dxgi_device;
    if (FAILED(device.As(&dxgi_device)))
      return false;
    winrt::com_ptr<IInspectable> inspectable_device;
    if (FAILED(CreateDirect3D11DeviceFromDXGIDevice(dxgi_device.Get(),
                                                    inspectable_device.put())))
      return false;
    auto direct3d_device = inspectable_device.as<
        winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice>();
    const auto frame_pool =
        winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool::
            CreateFreeThreaded(direct3d_device,
                               winrt::Windows::Graphics::DirectX::
                                   DirectXPixelFormat::B8G8R8A8UIntNormalized,
                               1, source_size);
    struct PoolLifetime {
      decltype(frame_pool) value;
      ~PoolLifetime() { try { value.Close(); } catch (...) {} }
    } pool_lifetime{frame_pool};
    const auto session = frame_pool.CreateCaptureSession(capture_item);
    struct SessionLifetime {
      decltype(session) value;
      ~SessionLifetime() { try { value.Close(); } catch (...) {} }
    } session_lifetime{session};
    // BEGIN windows capture event lease
    // Revocation does not wait for an asynchronous callback already in flight.
    const auto frame_event = std::make_shared<ScopedKernelHandle>();
    frame_event->value = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (frame_event->value == nullptr)
      return false;
    const auto event_token = frame_pool.FrameArrived(
        [frame_event](auto const &, auto const &) { SetEvent(frame_event->value); });
    struct Subscription {
      decltype(frame_pool) pool;
      decltype(event_token) token;
      bool active = true;
      void Revoke() {
        if (!active) return;
        active = false;
        pool.FrameArrived(token);
      }
      ~Subscription() { try { Revoke(); } catch (...) {} }
    } subscription{frame_pool, event_token};
    if (!WindowsV1UiaMayCall()) return false;
    session.StartCapture();
    const auto frame_deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(5'000);
    DWORD ready = WAIT_TIMEOUT;
    while (WindowsV1UiaMayCall()) {
      const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(
          frame_deadline - std::chrono::steady_clock::now()).count();
      if (remaining <= 0) break;
      ready = WaitForSingleObject(frame_event->value,
          static_cast<DWORD>(std::min<std::int64_t>(20, remaining)));
      if (ready != WAIT_TIMEOUT) break;
    }
    subscription.Revoke();
    if (ready != WAIT_OBJECT_0 || !WindowsV1UiaMayCall())
      return false;
    // END windows capture event lease
    const auto frame = frame_pool.TryGetNextFrame();
    if (frame == nullptr)
      return false;
    struct FrameLifetime {
      decltype(frame) value;
      ~FrameLifetime() { try { value.Close(); } catch (...) {} }
    } frame_lifetime{frame};
    if (!WindowsV1UiaMayCall()) return false;
    const auto surface = frame.Surface();
    auto surface_access = surface.as<::Windows::Graphics::DirectX::Direct3D11::
                                         IDirect3DDxgiInterfaceAccess>();
    Microsoft::WRL::ComPtr<ID3D11Texture2D> source_texture;
    if (FAILED(surface_access->GetInterface(IID_PPV_ARGS(&source_texture))))
      return false;
    D3D11_TEXTURE2D_DESC source_desc{};
    source_texture->GetDesc(&source_desc);
    D3D11_TEXTURE2D_DESC staging_desc = source_desc;
    staging_desc.Width = client_width;
    staging_desc.Height = client_height;
    staging_desc.Usage = D3D11_USAGE_STAGING;
    staging_desc.BindFlags = 0;
    staging_desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    staging_desc.MiscFlags = 0;
    Microsoft::WRL::ComPtr<ID3D11Texture2D> staging;
    if (FAILED(device->CreateTexture2D(&staging_desc, nullptr, &staging)))
      return false;
    const D3D11_BOX client_box = {crop_left,  crop_top,    0,
                                  crop_right, crop_bottom, 1};
    context->CopySubresourceRegion(staging.Get(), 0, 0, 0, 0,
                                   source_texture.Get(), 0, &client_box);
    if (!WindowsV1UiaMayCall()) return false;
    D3D11_MAPPED_SUBRESOURCE mapped{};
    if (FAILED(context->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &mapped)))
      return false;
    struct MappedLifetime {
      ID3D11DeviceContext *context;
      ID3D11Texture2D *texture;
      ~MappedLifetime() { context->Unmap(texture, 0); }
    } mapped_lifetime{context.Get(), staging.Get()};
    if (!WindowsV1UiaMayCall()) return false;

    Microsoft::WRL::ComPtr<IWICImagingFactory> imaging;
    if (FAILED(CoCreateInstance(CLSID_WICImagingFactory, nullptr,
                                CLSCTX_INPROC_SERVER,
                                IID_PPV_ARGS(&imaging)))) {
      return false;
    }
    Microsoft::WRL::ComPtr<IWICBitmapEncoder> encoder;
    Microsoft::WRL::ComPtr<IWICBitmapFrameEncode> frame_encoder;
    Microsoft::WRL::ComPtr<IPropertyBag2> options;
    Microsoft::WRL::ComPtr<IWICBitmap> source_bitmap;
    Microsoft::WRL::ComPtr<IWICBitmapScaler> scaler;
    bool success = SUCCEEDED(
        imaging->CreateEncoder(GUID_ContainerFormatPng, nullptr, &encoder));
    // WIC's in-memory stream encoder is intentionally kept bounded. If this
    // platform cannot encode the mapped frame, the helper reports capture
    // unavailable instead of returning raw GPU memory.
    if (success) {
      Microsoft::WRL::ComPtr<IStream> output_stream;
      success = SUCCEEDED(CreateStreamOnHGlobal(nullptr, TRUE, &output_stream));
      if (success)
        success = SUCCEEDED(
            encoder->Initialize(output_stream.Get(), WICBitmapEncoderNoCache));
      if (success)
        success = SUCCEEDED(encoder->CreateNewFrame(&frame_encoder, &options));
      if (success)
        success = SUCCEEDED(frame_encoder->Initialize(options.Get()));
      if (success)
        success = SUCCEEDED(imaging->CreateBitmapFromMemory(
            staging_desc.Width, staging_desc.Height,
            GUID_WICPixelFormat32bppBGRA, mapped.RowPitch,
            mapped.RowPitch * staging_desc.Height,
            static_cast<BYTE *>(mapped.pData), &source_bitmap));
      IWICBitmapSource *source_to_write = source_bitmap.Get();
      if (success && (staging_desc.Width != capture_width ||
                      staging_desc.Height != capture_height)) {
        success = SUCCEEDED(imaging->CreateBitmapScaler(&scaler)) &&
                  SUCCEEDED(scaler->Initialize(
                      source_bitmap.Get(), static_cast<UINT>(capture_width),
                      static_cast<UINT>(capture_height),
                      WICBitmapInterpolationModeFant));
        source_to_write = scaler.Get();
      }
      if (success)
        success = SUCCEEDED(
            frame_encoder->SetSize(static_cast<UINT>(capture_width),
                                   static_cast<UINT>(capture_height)));
      GUID pixel_format = GUID_WICPixelFormat32bppBGRA;
      if (success)
        success = SUCCEEDED(frame_encoder->SetPixelFormat(&pixel_format));
      if (success)
        success =
            source_to_write != nullptr &&
            SUCCEEDED(frame_encoder->WriteSource(source_to_write, nullptr));
      if (success)
        success =
            SUCCEEDED(frame_encoder->Commit()) && SUCCEEDED(encoder->Commit());
      if (success) {
        STATSTG stat{};
        success = SUCCEEDED(output_stream->Stat(&stat, STATFLAG_NONAME)) &&
                  stat.cbSize.QuadPart > 0 &&
                  stat.cbSize.QuadPart <= 8ll * 1024ll * 1024ll;
        if (success) {
          LARGE_INTEGER start{};
          output_stream->Seek(start, STREAM_SEEK_SET, nullptr);
          output->resize(static_cast<std::size_t>(stat.cbSize.QuadPart));
          ULONG read = 0;
          success =
              SUCCEEDED(output_stream->Read(
                  output->data(), static_cast<ULONG>(output->size()), &read)) &&
              read == output->size();
        }
      }
    }
    if (!success || !WindowsV1UiaMayCall())
      return false;
    *width = capture_width;
    *height = capture_height;
    return !output->empty();
  } catch (...) {
    std::fill(output->begin(), output->end(), 0);
    output->clear();
    return false;
  }
}
#else
bool CaptureWindowWithGraphicsCaptureOnWorker(HWND, std::vector<std::uint8_t> *,
                                      std::size_t *, std::size_t *) {
  return false;
}
#endif

#if SPRINT_CODER_HAS_WINDOWS_GRAPHICS_CAPTURE
constexpr std::size_t kVisualPatchSize = 64;
constexpr std::size_t kMaximumVisualPatchDigests = 1'000;

bool DecodePngBgra(std::span<const std::uint8_t> png,
                   std::size_t expected_width, std::size_t expected_height,
                   std::vector<std::uint8_t> *pixels) {
  if (png.empty() || png.size() > 8 * 1024 * 1024 || expected_width == 0 ||
      expected_height == 0 || expected_width > 2'560 ||
      expected_height > 1'600 || pixels == nullptr)
    return false;
  Microsoft::WRL::ComPtr<IStream> stream;
  if (FAILED(CreateStreamOnHGlobal(nullptr, TRUE, &stream)))
    return false;
  ULONG written = 0;
  if (FAILED(stream->Write(png.data(), static_cast<ULONG>(png.size()),
                           &written)) ||
      written != static_cast<ULONG>(png.size()))
    return false;
  LARGE_INTEGER beginning{};
  if (FAILED(stream->Seek(beginning, STREAM_SEEK_SET, nullptr)))
    return false;
  Microsoft::WRL::ComPtr<IWICImagingFactory> imaging;
  Microsoft::WRL::ComPtr<IWICBitmapDecoder> decoder;
  Microsoft::WRL::ComPtr<IWICBitmapFrameDecode> frame;
  Microsoft::WRL::ComPtr<IWICFormatConverter> converter;
  if (FAILED(CoCreateInstance(CLSID_WICImagingFactory, nullptr,
                              CLSCTX_INPROC_SERVER,
                              IID_PPV_ARGS(&imaging))) ||
      FAILED(imaging->CreateDecoderFromStream(
          stream.Get(), nullptr, WICDecodeMetadataCacheOnLoad, &decoder)) ||
      FAILED(decoder->GetFrame(0, &frame)) ||
      FAILED(imaging->CreateFormatConverter(&converter)) ||
      FAILED(converter->Initialize(
          frame.Get(), GUID_WICPixelFormat32bppBGRA,
          WICBitmapDitherTypeNone, nullptr, 0.0,
          WICBitmapPaletteTypeCustom)))
    return false;
  UINT width = 0;
  UINT height = 0;
  if (FAILED(converter->GetSize(&width, &height)) ||
      width != static_cast<UINT>(expected_width) ||
      height != static_cast<UINT>(expected_height))
    return false;
  const std::size_t byte_count = expected_width * expected_height * 4;
  if (byte_count == 0 || byte_count > 8 * 1024 * 1024)
    return false;
  pixels->resize(byte_count);
  const UINT stride = width * 4;
  if (FAILED(converter->CopyPixels(
          nullptr, stride, static_cast<UINT>(pixels->size()),
          pixels->data()))) {
    std::fill(pixels->begin(), pixels->end(), 0);
    pixels->clear();
    return false;
  }
  return true;
}

bool ComputeBgraPatchDigest(std::span<const std::uint8_t> pixels,
                            std::size_t width, std::size_t height,
                            std::size_t column, std::size_t row,
                            std::string *digest) {
  const std::size_t columns = (width + kVisualPatchSize - 1) /
                              kVisualPatchSize;
  const std::size_t rows = (height + kVisualPatchSize - 1) /
                           kVisualPatchSize;
  if (digest == nullptr || width == 0 || height == 0 || column >= columns ||
      row >= rows || pixels.size() != width * height * 4)
    return false;
  const std::size_t left = column * kVisualPatchSize;
  const std::size_t top = row * kVisualPatchSize;
  const std::size_t patch_width =
      std::min(kVisualPatchSize, width - left);
  const std::size_t patch_height =
      std::min(kVisualPatchSize, height - top);
  std::vector<std::uint8_t> patch;
  patch.reserve(patch_width * patch_height * 4);
  for (std::size_t y = 0; y < patch_height; ++y) {
    const std::size_t offset = ((top + y) * width + left) * 4;
    patch.insert(patch.end(), pixels.begin() + offset,
                 pixels.begin() + offset + patch_width * 4);
  }
  std::vector<std::uint8_t> material;
  static constexpr std::string_view prefix =
      "computer-visual-patch-v1\n";
  material.reserve(prefix.size() + 32 + patch.size());
  material.insert(material.end(), prefix.begin(), prefix.end());
  const std::string dimensions =
      std::to_string(left) + "," + std::to_string(top) + "," +
      std::to_string(patch_width) + "," +
      std::to_string(patch_height) + "\n";
  material.insert(material.end(), dimensions.begin(), dimensions.end());
  material.insert(material.end(), patch.begin(), patch.end());
  *digest = Sha256Bytes(material);
  std::fill(patch.begin(), patch.end(), 0);
  std::fill(material.begin(), material.end(), 0);
  return digest->size() == 64;
}

bool VisualPatchCoordinates(std::size_t width, std::size_t height,
                            double normalized_x, double normalized_y,
                            std::size_t *column, std::size_t *row,
                            std::size_t *index) {
  if (width == 0 || height == 0 || normalized_x < 0 || normalized_x > 1 ||
      normalized_y < 0 || normalized_y > 1 || column == nullptr ||
      row == nullptr || index == nullptr)
    return false;
  const std::size_t pixel_x = static_cast<std::size_t>(std::lround(
      normalized_x * static_cast<double>(width - 1)));
  const std::size_t pixel_y = static_cast<std::size_t>(std::lround(
      normalized_y * static_cast<double>(height - 1)));
  const std::size_t columns = (width + kVisualPatchSize - 1) /
                              kVisualPatchSize;
  *column = pixel_x / kVisualPatchSize;
  *row = pixel_y / kVisualPatchSize;
  *index = *row * columns + *column;
  return true;
}

bool ComputePngPatchDigest(std::span<const std::uint8_t> png,
                           std::size_t expected_width,
                           std::size_t expected_height, double normalized_x,
                           double normalized_y, std::string *digest,
                           std::size_t *patch_index = nullptr) {
  std::vector<std::uint8_t> pixels;
  if (!DecodePngBgra(png, expected_width, expected_height, &pixels))
    return false;
  std::size_t column = 0;
  std::size_t row = 0;
  std::size_t index = 0;
  const bool located = VisualPatchCoordinates(
      expected_width, expected_height, normalized_x, normalized_y, &column,
      &row, &index);
  const bool hashed =
      located && ComputeBgraPatchDigest(pixels, expected_width,
                                       expected_height, column, row, digest);
  std::fill(pixels.begin(), pixels.end(), 0);
  if (hashed && patch_index != nullptr)
    *patch_index = index;
  return hashed;
}

bool ComputePngPatchGrid(std::span<const std::uint8_t> png,
                         std::size_t width, std::size_t height,
                         std::vector<std::string> *digests,
                         std::size_t *columns, std::size_t *rows) {
  if (digests == nullptr || columns == nullptr || rows == nullptr)
    return false;
  std::vector<std::uint8_t> pixels;
  if (!DecodePngBgra(png, width, height, &pixels))
    return false;
  *columns = (width + kVisualPatchSize - 1) / kVisualPatchSize;
  *rows = (height + kVisualPatchSize - 1) / kVisualPatchSize;
  if (*columns == 0 || *rows == 0 ||
      *columns * *rows > kMaximumVisualPatchDigests) {
    std::fill(pixels.begin(), pixels.end(), 0);
    return false;
  }
  std::vector<std::string> result;
  result.reserve(*columns * *rows);
  bool complete = true;
  for (std::size_t row = 0; complete && row < *rows; ++row) {
    for (std::size_t column = 0; column < *columns; ++column) {
      std::string digest;
      if (!ComputeBgraPatchDigest(pixels, width, height, column, row,
                                  &digest)) {
        complete = false;
        break;
      }
      result.push_back(std::move(digest));
    }
  }
  std::fill(pixels.begin(), pixels.end(), 0);
  if (!complete)
    return false;
  *digests = std::move(result);
  return true;
}

bool RevalidateVisualPatch(const WindowsSession &session, double normalized_x,
                           double normalized_y, std::string *reason) {
  if (!session.has_observation || session.active_window == nullptr ||
      session.observation_patch_digests.empty() ||
      session.observation_patch_digests.size() >
          kMaximumVisualPatchDigests ||
      session.observation_capture_width == 0 ||
      session.observation_capture_height == 0 ||
      session.observation_patch_columns == 0 ||
      session.observation_patch_rows == 0 ||
      session.observation_patch_digests.size() !=
          session.observation_patch_columns * session.observation_patch_rows) {
    *reason = "visual_observation_missing";
    return false;
  }
  std::size_t column = 0;
  std::size_t row = 0;
  std::size_t patch_index = 0;
  if (!VisualPatchCoordinates(
          session.observation_capture_width,
          session.observation_capture_height, normalized_x, normalized_y,
          &column, &row, &patch_index) ||
      patch_index >= session.observation_patch_digests.size()) {
    *reason = "visual_observation_invalid";
    return false;
  }
  std::vector<std::uint8_t> current_screenshot;
  std::size_t current_width = 0;
  std::size_t current_height = 0;
  if (!CaptureWindowWithGraphicsCapture(
          session.active_window, session.cancel_epoch, WindowsValidationFrameStopSerial(),
          &current_screenshot, &current_width,
          &current_height) ||
      current_width != session.observation_capture_width ||
      current_height != session.observation_capture_height) {
    std::fill(current_screenshot.begin(), current_screenshot.end(), 0);
    *reason = "native_visual_patch_changed";
    return false;
  }
  std::string current_digest;
  std::size_t current_patch_index = 0;
  const bool decoded = ReadWindowsPngPatchDigest(
      &current_screenshot, current_width, current_height, normalized_x,
      normalized_y, session.cancel_epoch, WindowsValidationFrameStopSerial(),
      &current_digest, &current_patch_index);
  std::fill(current_screenshot.begin(), current_screenshot.end(), 0);
  if (!decoded || current_patch_index != patch_index ||
      current_digest != session.observation_patch_digests[patch_index]) {
    *reason = "native_visual_patch_changed";
    return false;
  }
  return true;
}
#else
bool ComputePngPatchGrid(std::span<const std::uint8_t>, std::size_t,
                         std::size_t, std::vector<std::string> *,
                         std::size_t *, std::size_t *) {
  return false;
}

bool RevalidateVisualPatch(const WindowsSession &, double, double,
                           std::string *reason) {
  if (reason != nullptr)
    *reason = "graphics_capture_unavailable";
  return false;
}
#endif

std::string BoundedUtf8(std::string value, std::size_t maximum_bytes) {
  if (value.size() <= maximum_bytes)
    return value;
  value.resize(maximum_bytes);
  while (!value.empty() &&
         (static_cast<unsigned char>(value.back()) & 0xc0) == 0x80)
    value.pop_back();
  if (!value.empty() && static_cast<unsigned char>(value.back()) >= 0xc0)
    value.pop_back();
  return value;
}

std::string UiaRole(CONTROLTYPEID control_type, bool password) {
  if (password)
    return "AXSecureTextField";
  switch (control_type) {
  case UIA_WindowControlTypeId:
    return "AXWindow";
  case UIA_ButtonControlTypeId:
    return "UIAButton";
  case UIA_EditControlTypeId:
    return "UIATextField";
  case UIA_CheckBoxControlTypeId:
    return "UIACheckBox";
  case UIA_RadioButtonControlTypeId:
    return "UIARadioButton";
  case UIA_ComboBoxControlTypeId:
    return "UIAComboBox";
  case UIA_ListItemControlTypeId:
    return "UIAListItem";
  case UIA_MenuItemControlTypeId:
    return "UIAMenuItem";
  case UIA_TabItemControlTypeId:
    return "UIATabItem";
  case UIA_TreeItemControlTypeId:
    return "UIATreeItem";
  case UIA_HyperlinkControlTypeId:
    return "UIAHyperlink";
  default:
    return "UIAControl" +
           std::to_string(static_cast<unsigned int>(control_type));
  }
}

bool AppendUiaTree(IUIAutomationElement *element,
                   IUIAutomationTreeWalker *walker, std::size_t depth,
                   std::size_t *nodes, std::string *json) {
  if (element == nullptr || walker == nullptr || depth > 16 ||
      *nodes >= 5'000 || json->size() > 512 * 1024 || !WindowsV1UiaMayCall())
    return false;
  ++*nodes;
  WindowsV1UiaCountNode();
  BSTR name = nullptr;
  BSTR automation_id = nullptr;
  BSTR help = nullptr;
  CONTROLTYPEID control_type = 0;
  BOOL password = FALSE;
  const bool attributes_read =
      WindowsV1UiaRead(name, [&] { return element->get_CurrentName(&name); }) &&
      WindowsV1UiaRead(automation_id, [&] { return element->get_CurrentAutomationId(&automation_id); }) &&
      WindowsV1UiaRead(help, [&] { return element->get_CurrentHelpText(&help); }) &&
      WindowsV1UiaRead(control_type, [&] { return element->get_CurrentControlType(&control_type); }) &&
      WindowsV1UiaRead(password, [&] { return element->get_CurrentIsPassword(&password); });
  const auto free_string = [](OLECHAR *value) { SysFreeString(value); };
  std::unique_ptr<OLECHAR, decltype(free_string)> owned_name(name, free_string);
  std::unique_ptr<OLECHAR, decltype(free_string)> owned_id(automation_id, free_string);
  std::unique_ptr<OLECHAR, decltype(free_string)> owned_help(help, free_string);
  if (!attributes_read)
    return false;
  const std::string name_utf8 = BoundedUtf8(
      name == nullptr
          ? std::string{}
          : Utf8FromWide(std::wstring_view(name, SysStringLen(name))),
      256);
  const std::string automation_utf8 =
      BoundedUtf8(automation_id == nullptr
                      ? std::string{}
                      : Utf8FromWide(std::wstring_view(
                            automation_id, SysStringLen(automation_id))),
                  256);
  const std::string help_utf8 = BoundedUtf8(
      help == nullptr
          ? std::string{}
          : Utf8FromWide(std::wstring_view(help, SysStringLen(help))),
      4'096);
  const bool text_converted =
      (name == nullptr || SysStringLen(name) == 0 || !name_utf8.empty()) &&
      (automation_id == nullptr || SysStringLen(automation_id) == 0 ||
       !automation_utf8.empty()) &&
      (help == nullptr || SysStringLen(help) == 0 || !help_utf8.empty());
  if (!text_converted)
    return false;
  owned_name.reset();
  owned_id.reset();
  owned_help.reset();
  *json += "{\"role\":\"" +
           JsonEscape(UiaRole(control_type, password == TRUE)) +
           "\",\"title\":\"" + JsonEscape(name_utf8) + "\",\"identifier\":\"" +
           JsonEscape(automation_utf8) + "\"";
  if (!help_utf8.empty())
    *json += ",\"help\":\"" + JsonEscape(help_utf8) + "\"";
  *json += ",\"children\":[";
  IUIAutomationElement *child = nullptr;
  struct ChildOwner {
    IUIAutomationElement *&child;
    ~ChildOwner() { if (child != nullptr) child->Release(); }
  } owned_child{child};
  HRESULT result = WindowsV1UiaCall(child, [&] { return walker->GetFirstChildElement(element, &child); });
  bool first = true;
  bool complete = WindowsV1UiaOk(result);
  while (complete && child != nullptr) {
    if (!first)
      *json += ',';
    first = false;
    if (!AppendUiaTree(child, walker, depth + 1, nodes, json))
      complete = false;
    IUIAutomationElement *next = nullptr;
    if (complete && !WindowsV1UiaOk(WindowsV1UiaCall(next, [&] { return walker->GetNextSiblingElement(child, &next); })))
      complete = false;
    child->Release();
    child = next;
  }
  *json += "]}";
  return complete && json->size() <= 512 * 1024;
}

bool TargetWindowFacts(std::uint32_t pid, HWND window, RECT *bounds) {
  if (window == nullptr || !IsWindow(window) || !IsWindowVisible(window))
    return false;
  if (GetForegroundWindow() != window)
    return false;
  DWORD owner_pid = 0;
  if (GetWindowThreadProcessId(window, &owner_pid) == 0 || owner_pid != pid)
    return false;
  return ClientBoundsPhysical(window, bounds);
}

bool IsProcessElevated(std::uint32_t pid) {
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (process == nullptr)
    return true;
  HANDLE token = nullptr;
  const bool opened = OpenProcessToken(process, TOKEN_QUERY, &token) == TRUE;
  TOKEN_ELEVATION elevation{};
  DWORD length = 0;
  const bool read =
      opened && GetTokenInformation(token, TokenElevation, &elevation,
                                    sizeof(elevation), &length) == TRUE;
  if (token != nullptr)
    CloseHandle(token);
  CloseHandle(process);
  return !read || elevation.TokenIsElevated != 0;
}

bool ReadUiaObservationOnWorker(std::uint32_t pid, HWND window, std::string *tree,
                                std::size_t *nodes) {
  const WindowsV1UiaPath path;
  struct Objects {
    IUIAutomation *automation = nullptr;
    IUIAutomationElement *root = nullptr;
    IUIAutomationTreeWalker *walker = nullptr;
    ~Objects() {
      if (root != nullptr) root->Release();
      if (walker != nullptr) walker->Release();
      if (automation != nullptr) automation->Release();
    }
  } objects;
  IUIAutomation *&automation = objects.automation;
  IUIAutomationElement *&root = objects.root;
  IUIAutomationTreeWalker *&walker = objects.walker;
  if (!WindowsV1UiaMayCall())
    return false;
  if (FAILED(CreateWindowsV1Automation(&automation)) ||
      automation == nullptr)
    return false;
  const HRESULT root_result =
      WindowsV1UiaContact(root, [&] { return automation->ElementFromHandle(window, &root); });
  if (!WindowsV1UiaOk(root_result) || root == nullptr || !WindowsV1UiaMayCall())
    return false;
  const HRESULT walker_result = automation->get_RawViewWalker(&walker);
  std::string value;
  std::size_t count = 0;
  const bool complete = SUCCEEDED(walker_result) && walker != nullptr &&
                        AppendUiaTree(root, walker, 0, &count, &value);
  if (!complete)
    return false;
  *tree = std::move(value);
  *nodes = count;
  (void)pid;
  return true;
}

// Observation rejects a worker timeout as soon as it is known. Classification instead keeps
// the worker's partial risk/signature and first stop, once its COM cleanup has completed.
// Both policies abandon immediately on consumer-side Stop, deadline or slow first contact.
template <class Result, class Measure, class Adopt>
bool RunWindowsUiaRead(bool preserve_stopped_result, Measure measure, Adopt adopt,
                       std::atomic<bool> &running = WindowsUiaReadWorkerRunning()) {
  static_assert(std::is_nothrow_move_constructible_v<Result> && std::is_nothrow_move_assignable_v<Result>,
                "UIA read results must be publishable without throwing.");
  const WindowsV1UiaPath path;
  if (!WindowsV1UiaMayCall()) return false;
  WindowsV1UiaLane snapshot = *windows_v1_uia_lane;
  auto &control = WindowsTargetListControl();
  if (!snapshot.stop_serial.has_value())
    snapshot.stop_serial = WindowsValidationFrameStopSerial();
  std::shared_ptr<WindowsUiaReadPending<Result>> pending;
  try { pending = std::make_shared<WindowsUiaReadPending<Result>>(); }
  catch (...) { if (preserve_stopped_result) WindowsV1UiaOk(kWindowsV1UiaTimeoutResult); return false; }
  {
    std::lock_guard stop_lock(control.stop_mutex);
    if (parent_process_dead.load(std::memory_order_acquire) ||
        control.stop_serial.load(std::memory_order_acquire) != *snapshot.stop_serial) {
      windows_v1_uia_lane->stop = WindowsV1UiaStop::kCanceled;
      return false;
    }
    if (running.exchange(true, std::memory_order_acq_rel)) {
      if (preserve_stopped_result) WindowsV1UiaOk(kWindowsV1UiaTimeoutResult);
      return false;
    }
  }
  try {
    std::thread([pending, snapshot, preserve_stopped_result, measure = std::move(measure), &running]() mutable {
      struct Progress {
        explicit Progress(WindowsUiaReadProgress *value) { windows_uia_read_progress = value; }
        ~Progress() { windows_uia_read_progress = nullptr; }
      } progress(pending.get());
      const WindowsV1UiaPath worker_path(snapshot);
      std::optional<Result> value;
      try {
        struct Apartment {
          HRESULT result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
          ~Apartment() { if (SUCCEEDED(result)) CoUninitialize(); }
        } apartment;
        if (SUCCEEDED(apartment.result) && WindowsV1UiaMayCall()) value = measure();
        else if (FAILED(apartment.result) && preserve_stopped_result) WindowsV1UiaOk(kWindowsV1UiaTimeoutResult);
      } catch (...) {
        value.reset();
        if (preserve_stopped_result) WindowsV1UiaOk(kWindowsV1UiaTimeoutResult);
      }
      // No result or free slot is published while Release/CoUninitialize can still be running.
      {
        std::lock_guard lock(pending->mutex);
        if (pending->abandoned.load(std::memory_order_acquire) == WindowsV1UiaStop::kNone) {
          pending->value = std::move(value);
          pending->stop.store(worker_path.Stop(), std::memory_order_release);
        }
        pending->done = true;
        running.store(false, std::memory_order_release);
      }
      pending->ready.notify_one();
    }).detach();
  } catch (...) {
    running.store(false, std::memory_order_release);
    if (preserve_stopped_result) WindowsV1UiaOk(kWindowsV1UiaTimeoutResult);
    return false;
  }
  std::unique_lock lock(pending->mutex);
  for (;;) {
    {
      std::lock_guard stop_lock(control.stop_mutex);
      WindowsV1UiaLane &lane = *windows_v1_uia_lane;
      auto external_stop = lane.stop;
      if (external_stop == WindowsV1UiaStop::kNone) {
        if (parent_process_dead.load(std::memory_order_acquire) ||
            cancellation_epoch.load(std::memory_order_acquire) != snapshot.epoch ||
            control.stop_serial.load(std::memory_order_acquire) != *snapshot.stop_serial)
          external_stop = WindowsV1UiaStop::kCanceled;
        else if (lane.has_deadline && std::chrono::steady_clock::now() > lane.deadline)
          external_stop = WindowsV1UiaStop::kBudget;
      }
      const auto worker_stop = pending->stop.load(std::memory_order_acquire);
      if (external_stop == WindowsV1UiaStop::kNone && pending->contact_active &&
          std::chrono::steady_clock::now() - pending->contact_started >= kWindowsV1UiaSlowContact)
        external_stop = WindowsV1UiaStop::kTimeout;
      if (external_stop != WindowsV1UiaStop::kNone ||
          (!preserve_stopped_result && worker_stop != WindowsV1UiaStop::kNone)) {
        if (lane.stop == WindowsV1UiaStop::kNone)
          lane.stop = preserve_stopped_result && worker_stop != WindowsV1UiaStop::kNone
              ? worker_stop : external_stop != WindowsV1UiaStop::kNone ? external_stop : worker_stop;
        pending->abandoned.store(lane.stop, std::memory_order_release);
        lane.nodes += pending->nodes.load(std::memory_order_acquire);
        return false;
      }
      if (pending->done) {
        lane.nodes += pending->nodes.load(std::memory_order_acquire);
        lane.stop = worker_stop;
        if (!pending->value.has_value()) return false;
        adopt(std::move(*pending->value));
        return true;
      }
    }
    pending->ready.wait_for(lock, std::chrono::milliseconds(20));
  }
}

struct WindowsUiaObservationResult {
  std::string tree;
  std::size_t nodes = 0;
};

bool ReadUiaObservation(std::uint32_t pid, HWND window, std::string *tree,
                        std::size_t *nodes) {
  return RunWindowsUiaRead<WindowsUiaObservationResult>(false,
      [pid, window]() -> std::optional<WindowsUiaObservationResult> {
        WindowsUiaObservationResult value;
        if (!ReadUiaObservationOnWorker(pid, window, &value.tree, &value.nodes)) return std::nullopt;
        return value;
      }, [tree, nodes](WindowsUiaObservationResult value) {
        *tree = std::move(value.tree);
        *nodes = value.nodes;
      });
}

// BEGIN windows capture read ownership
struct WindowsCaptureBytes {
  std::vector<std::uint8_t> bytes;
  std::size_t width = 0;
  std::size_t height = 0;
  ~WindowsCaptureBytes() { std::fill(bytes.begin(), bytes.end(), 0); }
};

class WindowsCaptureLaneScope {
public:
  explicit WindowsCaptureLaneScope(WindowsV1UiaLane *lane)
      : previous_(std::exchange(windows_v1_uia_lane, lane)) {}
  ~WindowsCaptureLaneScope() { windows_v1_uia_lane = previous_; }
  WindowsCaptureLaneScope(const WindowsCaptureLaneScope &) = delete;
  WindowsCaptureLaneScope &operator=(const WindowsCaptureLaneScope &) = delete;
private:
  WindowsV1UiaLane *previous_;
};

template<class Result, class Measure, class Adopt>
bool RunWindowsImageRead(std::uint64_t epoch, std::uint64_t stop_serial,
                         Measure measure, Adopt adopt, WindowsV1UiaStop *stop) {
  if (stop != nullptr) *stop = WindowsV1UiaStop::kNone;
  WindowsV1UiaLane snapshot = windows_v1_uia_lane != nullptr
      ? *windows_v1_uia_lane : WindowsV1UiaLane{};
  snapshot.epoch = epoch;
  snapshot.stop_serial = stop_serial;
  snapshot.nodes = 0;
  // A failed focus read may omit a signature without invalidating a screenshot. Preserve the
  // caller's timeout state, but give capture its own lane and slot while retaining Stop/deadline.
  if (snapshot.stop == WindowsV1UiaStop::kTimeout) snapshot.stop = WindowsV1UiaStop::kNone;
  bool read = false;
  {
    const WindowsCaptureLaneScope scope(&snapshot);
    read = RunWindowsUiaRead<Result>(false, std::move(measure), std::move(adopt),
                                    WindowsCaptureWorkerRunning());
  }
  if (stop != nullptr) *stop = snapshot.stop;
  return read;
}

bool CaptureWindowWithGraphicsCapture(HWND window, std::uint64_t epoch,
                                      std::uint64_t stop_serial,
                                      std::vector<std::uint8_t> *output,
                                      std::size_t *width, std::size_t *height,
                                      WindowsV1UiaStop *stop) {
  if (stop != nullptr) *stop = WindowsV1UiaStop::kNone;
#if SPRINT_CODER_HAS_WINDOWS_GRAPHICS_CAPTURE
  std::unique_ptr<WindowsCaptureBytes> result;
  const bool captured = RunWindowsImageRead<std::unique_ptr<WindowsCaptureBytes>>(epoch, stop_serial,
        [window]() -> std::optional<std::unique_ptr<WindowsCaptureBytes>> {
          winrt::init_apartment(winrt::apartment_type::multi_threaded);
          struct Runtime { ~Runtime() { winrt::uninit_apartment(); } } runtime;
          auto value = std::make_unique<WindowsCaptureBytes>();
          if (!CaptureWindowWithGraphicsCaptureOnWorker(window, &value->bytes,
                                                        &value->width, &value->height))
            return std::nullopt;
          return value;
        }, [&result](std::unique_ptr<WindowsCaptureBytes> value) noexcept {
          result = std::move(value);
        }, stop);
  if (captured) {
    output->swap(result->bytes);
    *width = result->width;
    *height = result->height;
    return true;
  }
#else
  (void)window; (void)epoch; (void)stop_serial; (void)width; (void)height;
#endif
  std::fill(output->begin(), output->end(), 0);
  output->clear();
  return false;
}
// END windows capture read ownership

// PNG bytes are transferred into one image job, never borrowed from the consumer's output buffer.
struct WindowsPngResult {
  WindowsCaptureBytes image;
  std::vector<std::string> digests;
  std::string digest;
  std::size_t columns = 0, rows = 0, index = 0;
};

bool ReadWindowsPng(std::vector<std::uint8_t> *png, std::size_t width, std::size_t height,
                    std::uint64_t epoch, std::uint64_t serial, bool grid, double x, double y,
                    std::unique_ptr<WindowsPngResult> *result, WindowsV1UiaStop *stop) {
  if (stop != nullptr) *stop = WindowsV1UiaStop::kNone;
#if SPRINT_CODER_HAS_WINDOWS_GRAPHICS_CAPTURE
  try {
    if (!png->empty() && png->size() <= 8 * 1024 * 1024 && width > 0 && height > 0 &&
        width <= 2'560 && height <= 1'600) {
      auto work = std::make_unique<WindowsPngResult>();
      work->image.bytes.swap(*png);
      work->image.width = width; work->image.height = height;
      return RunWindowsImageRead<std::unique_ptr<WindowsPngResult>>(epoch, serial,
          [work = std::move(work), grid, x, y]() mutable -> std::optional<std::unique_ptr<WindowsPngResult>> {
            if (!WindowsV1UiaMayCall()) return std::nullopt;
            const bool ok = grid
                ? ComputePngPatchGrid(work->image.bytes, work->image.width, work->image.height,
                                      &work->digests, &work->columns, &work->rows)
                : ComputePngPatchDigest(work->image.bytes, work->image.width, work->image.height,
                                        x, y, &work->digest, &work->index);
            if (!ok || !WindowsV1UiaMayCall()) return std::nullopt;
            return std::move(work);
          }, [result](std::unique_ptr<WindowsPngResult> value) noexcept {
            *result = std::move(value);
          }, stop);
    }
  } catch (...) {}
#else
  (void)width; (void)height; (void)epoch; (void)serial; (void)grid; (void)x; (void)y; (void)result;
#endif
  std::fill(png->begin(), png->end(), 0); png->clear();
  return false;
}

bool ReadWindowsPngPatchGrid(std::vector<std::uint8_t> *png, std::size_t width,
                             std::size_t height, std::uint64_t epoch, std::uint64_t serial,
                             std::vector<std::string> *digests, std::size_t *columns,
                             std::size_t *rows, WindowsV1UiaStop *stop) {
  std::unique_ptr<WindowsPngResult> result;
  if (!ReadWindowsPng(png, width, height, epoch, serial, true, 0, 0, &result, stop)) return false;
  png->swap(result->image.bytes); digests->swap(result->digests);
  *columns = result->columns; *rows = result->rows;
  return true;
}

bool ReadWindowsPngPatchDigest(std::vector<std::uint8_t> *png, std::size_t width,
                               std::size_t height, double x, double y,
                               std::uint64_t epoch, std::uint64_t serial,
                               std::string *digest, std::size_t *index) {
  std::unique_ptr<WindowsPngResult> result;
  if (!ReadWindowsPng(png, width, height, epoch, serial, false, x, y, &result, nullptr)) return false;
  png->swap(result->image.bytes); digest->swap(result->digest); *index = result->index;
  return true;
}

// BEGIN windows semantic operation ownership
struct WindowsSemanticPending : WindowsUiaReadProgress {
  std::string session_id;
  std::shared_ptr<std::atomic<std::uint64_t>> attempts;
  // stop_mutex protects the claim and its terminal boundary.
  bool input_in_flight = false;
  bool ever_claimed = false;
  // The pending mutex protects the consumer validation handshake and final result.
  bool validation_requested = false;
  bool validation_started = false;
  std::optional<bool> validation;
  bool succeeded = false;
  std::string reason;
};
struct WindowsSemanticControl {
  std::shared_ptr<WindowsSemanticPending> active;
};
WindowsSemanticControl &WindowsSemanticOperations() {
  static auto *state = new WindowsSemanticControl;
  return *state;
}
thread_local WindowsSemanticPending *windows_semantic_operation = nullptr;

bool WindowsSemanticInputInFlightLocked() {
  const auto &active = WindowsSemanticOperations().active;
  return active != nullptr && active->input_in_flight;
}
bool WindowsSemanticInputInFlight() {
  std::lock_guard lock(WindowsTargetListControl().stop_mutex);
  return WindowsSemanticInputInFlightLocked();
}
bool StopWindowsSemanticInput(const WindowsSession &session, std::uint64_t *attempts) {
  std::lock_guard lock(WindowsTargetListControl().stop_mutex);
  const auto &active = WindowsSemanticOperations().active;
  if (active != nullptr && active->session_id == session.session_id) {
    auto expected = WindowsV1UiaStop::kNone;
    active->abandoned.compare_exchange_strong(expected, WindowsV1UiaStop::kCanceled);
    active->ready.notify_all();
    if (active->input_in_flight) return false;
  }
  // The abandoned barrier forbids any later claim; other input runs on this same consumer.
  *attempts = session.input_api_attempts->load(std::memory_order_acquire);
  return true;
}
void DrainWindowsSemanticInputForExit() {
  for (;;) {
    {
      std::lock_guard lock(WindowsTargetListControl().stop_mutex);
      const auto &active = WindowsSemanticOperations().active;
      if (active == nullptr) return;
      auto expected = WindowsV1UiaStop::kNone;
      active->abandoned.compare_exchange_strong(expected, WindowsV1UiaStop::kCanceled);
      active->ready.notify_all();
      if (!active->input_in_flight) return;
    }
    Sleep(10);
  }
}

bool AwaitWindowsSemanticValidation() {
  auto *pending = windows_semantic_operation;
  if (pending == nullptr || !WindowsV1UiaMayCall()) return false;
  std::unique_lock lock(pending->mutex);
  pending->validation_requested = true;
  pending->ready.notify_all();
  while (!pending->validation.has_value()) {
    if (!WindowsV1UiaMayCall()) return false;
    pending->ready.wait_for(lock, std::chrono::milliseconds(20));
  }
  return *pending->validation && WindowsV1UiaMayCall();
}

template <class Call> HRESULT InvokeWindowsSemanticInput(Call &&call, bool *accepted) {
  auto *pending = windows_semantic_operation;
  if (pending == nullptr) return E_ABORT;
  {
    std::lock_guard lock(WindowsTargetListControl().stop_mutex);
    if (WindowsSemanticOperations().active.get() != pending || pending->session_id.empty() ||
        pending->input_in_flight || pending->ever_claimed ||
        pending->abandoned.load(std::memory_order_acquire) != WindowsV1UiaStop::kNone ||
        !WindowsV1UiaMayCall()) return E_ABORT;
    pending->input_in_flight = true;
    pending->ever_claimed = true;
    pending->attempts->fetch_add(1, std::memory_order_acq_rel);
    *accepted = true;
  }
  struct Returned {
    WindowsSemanticPending *pending;
    ~Returned() {
      std::lock_guard lock(WindowsTargetListControl().stop_mutex);
      pending->input_in_flight = false;
      pending->ready.notify_all();
    }
  } returned{pending};
  return call();
}

struct WindowsSemanticWork {
  std::uint32_t pid = 0;
  HWND window = nullptr;
  std::string target_id;
  std::optional<std::string> observed_signature;
  std::string kind;
  std::string metadata;
  ~WindowsSemanticWork() { std::fill(metadata.begin(), metadata.end(), '\0'); }
};
// END windows semantic operation ownership

struct WindowsUiaRisk {
  bool classified = false;
  bool secure = false;
  bool high_impact = false;
  bool metadata_complete = false;
};

std::string LowercaseAscii(std::string value) {
  for (char &character : value)
    if (character >= 'A' && character <= 'Z')
      character = static_cast<char>(character + ('a' - 'A'));
  return value;
}

bool IsWindowsRiskWordCharacter(char character) {
  return (character >= 'a' && character <= 'z') ||
         (character >= '0' && character <= '9');
}

bool ContainsBoundedWindowsRiskTerm(std::string_view text,
                                    std::string_view term) {
  std::size_t offset = 0;
  while ((offset = text.find(term, offset)) != std::string_view::npos) {
    const bool left_bounded =
        offset == 0 || !IsWindowsRiskWordCharacter(text[offset - 1]);
    const std::size_t end = offset + term.size();
    const bool right_bounded =
        end == text.size() || !IsWindowsRiskWordCharacter(text[end]);
    if (left_bounded && right_bounded)
      return true;
    offset = end;
  }
  return false;
}

bool ContainsWindowsRiskText(std::string_view text) {
  static constexpr std::array<std::string_view, 36> terms = {
      "payment",
      "checkout",
      "purchase",
      "billing",
      "credit card",
      "card number",
      "wire transfer",
      "contract",
      "agreement",
      "sign agreement",
      "installer",
      "install application",
      "administrator",
      "admin privileges",
      "sudo",
      "root access",
      "security settings",
      "privacy settings",
      "firewall",
      "accessibility permission",
      "screen recording permission",
      "決済",
      "支払い",
      "支払う",
      "購入",
      "注文を確定",
      "注文する",
      "請求",
      "送金",
      "契約",
      "署名",
      "インストール",
      "管理者",
      "セキュリティ",
      "プライバシー",
      "ファイアウォール",
  };
  for (const auto term : terms)
    if (text.find(term) != std::string_view::npos)
      return true;
  static constexpr std::array<std::string_view, 15> payment_terms = {
      "pay",          "pay now",        "place order", "submit order",
      "complete order", "buy now",      "pagar",       "comprar",
      "acheter",      "bestellen",      "bezahlen",    "pagare",
      "acquistare",   "betalen",        "kopen"};
  for (const auto term : payment_terms)
    if (ContainsBoundedWindowsRiskTerm(text, term))
      return true;
  static constexpr std::array<std::string_view, 9> shell_terms = {
      "integrated terminal", "terminal", "console", "shell", "powershell",
      "command prompt",      "cmd.exe",  "pwsh",    "wsl",
  };
  for (const auto term : shell_terms)
    if (ContainsBoundedWindowsRiskTerm(text, term))
      return true;
  return false;
}

WindowsUiaRisk ClassifyWindowsUiaElementSelf(IUIAutomationElement *element) {
  WindowsUiaRisk risk;
  if (element == nullptr || !WindowsV1UiaMayCall())
    return risk;
  struct Labels {
    BSTR name = nullptr, automation_id = nullptr, help = nullptr;
    ~Labels() {
      if (name != nullptr) SysFreeString(name);
      if (automation_id != nullptr) SysFreeString(automation_id);
      if (help != nullptr) SysFreeString(help);
    }
  } labels;
  BSTR &name = labels.name, &automation_id = labels.automation_id, &help = labels.help;
  CONTROLTYPEID control_type = 0;
  BOOL password = FALSE;
  const bool attributes_read =
      WindowsV1UiaRead(name, [&] { return element->get_CurrentName(&name); }) &&
      WindowsV1UiaRead(automation_id, [&] { return element->get_CurrentAutomationId(&automation_id); }) &&
      WindowsV1UiaRead(help, [&] { return element->get_CurrentHelpText(&help); }) &&
      WindowsV1UiaRead(control_type, [&] { return element->get_CurrentControlType(&control_type); }) &&
      WindowsV1UiaRead(password, [&] { return element->get_CurrentIsPassword(&password); });
  if (!attributes_read) {
    return risk;
  }
  const auto convert = [](BSTR value) {
    return value == nullptr
               ? std::string{}
               : Utf8FromWide(std::wstring_view(value, SysStringLen(value)));
  };
  const std::string name_text = convert(name);
  const std::string automation_text = convert(automation_id);
  const std::string help_text = convert(help);
  const bool text_converted =
      (name == nullptr || SysStringLen(name) == 0 || !name_text.empty()) &&
      (automation_id == nullptr || SysStringLen(automation_id) == 0 ||
       !automation_text.empty()) &&
      (help == nullptr || SysStringLen(help) == 0 || !help_text.empty());
  if (!text_converted) {
    return risk;
  }
  const std::string normalized =
      LowercaseAscii(name_text + "\n" + automation_text + "\n" + help_text);
  risk.classified = control_type != 0 || !normalized.empty();
  risk.secure = password == TRUE ||
                normalized.find("password") != std::string::npos ||
                normalized.find("passcode") != std::string::npos ||
                normalized.find("パスワード") != std::string::npos;
  // Version 1 excludes ordinary save/send/publish/delete labels from this
  // high-impact list.
  risk.high_impact = ContainsWindowsRiskText(normalized);
  risk.metadata_complete = true;
  return risk;
}

WindowsUiaRisk ClassifyWindowsUiaElement(IUIAutomationElement *element) {
  WindowsUiaRisk merged;
  if (element == nullptr)
    return merged;
  const WindowsV1UiaPath path;
  if (!WindowsV1UiaMayCall()) return merged;
  struct Objects {
    IUIAutomation *automation = nullptr;
    IUIAutomationTreeWalker *walker = nullptr;
    IUIAutomationElement *current = nullptr, *parent = nullptr;
    ~Objects() {
      if (parent != nullptr) parent->Release();
      if (current != nullptr) current->Release();
      if (walker != nullptr) walker->Release();
      if (automation != nullptr) automation->Release();
    }
  } objects;
  IUIAutomation *&automation = objects.automation;
  IUIAutomationTreeWalker *&walker = objects.walker;
  IUIAutomationElement *&current = objects.current, *&parent = objects.parent;
  if (FAILED(CreateWindowsV1Automation(&automation)) ||
      automation == nullptr || FAILED(automation->get_RawViewWalker(&walker)) ||
      walker == nullptr) {
    return {};
  }
  element->AddRef();
  current = element;
  bool metadata_complete = true;
  for (std::size_t depth = 0; current != nullptr && depth < 8; ++depth) {
    const WindowsUiaRisk risk = ClassifyWindowsUiaElementSelf(current);
    merged.classified = merged.classified || risk.classified;
    merged.secure = merged.secure || risk.secure;
    merged.high_impact = merged.high_impact || risk.high_impact;
    metadata_complete = metadata_complete && risk.metadata_complete;
    // An element that could not be read ends the climb: the facts are incomplete whatever the parents
    // say (ClassifyNativePreflightFacts puts incomplete metadata ahead of secure and high impact, so
    // the reason does not change), and asking the parents of a target that stopped answering costs one
    // more timeout each.
    if (!risk.metadata_complete)
      break;
    parent = nullptr;
    const HRESULT parent_result =
        WindowsV1UiaCall(parent, [&] { return walker->GetParentElement(current, &parent); });
    if (!WindowsV1UiaOk(parent_result)) {
      metadata_complete = false;
      if (parent != nullptr)
        parent->Release();
      parent = nullptr;
    }
    current->Release();
    current = parent;
    parent = nullptr;
  }
  if (current != nullptr) metadata_complete = false;
  merged.metadata_complete = metadata_complete;
  return merged;
}

WindowsUiaRisk ClassifyWindowsPointOnWorker(POINT point, std::uint32_t expected_pid,
                                    std::string *control_signature) {
  if (control_signature != nullptr)
    control_signature->clear();
  struct Objects {
    IUIAutomation *automation = nullptr;
    IUIAutomationElement *element = nullptr;
    ~Objects() {
      if (element != nullptr) element->Release();
      if (automation != nullptr) automation->Release();
    }
  } objects;
  IUIAutomation *&automation = objects.automation;
  IUIAutomationElement *&element = objects.element;
  if (FAILED(CreateWindowsV1Automation(&automation)) ||
      automation == nullptr)
    return {};
  const POINT query = point;
  const HRESULT found =
      WindowsV1UiaContact(element, [&] { return automation->ElementFromPoint(query, &element); });
  if (!WindowsV1UiaOk(found) || element == nullptr) {
    return {};
  }
  int owner_pid = 0;
  if (!WindowsV1UiaRead(owner_pid, [&] { return element->get_CurrentProcessId(&owner_pid); }) || owner_pid <= 0 ||
      static_cast<std::uint32_t>(owner_pid) != expected_pid) {
    return {};
  }
  const WindowsUiaRisk risk = ClassifyWindowsUiaElement(element);
  // The control signature is only for a target that is going to be acted on: when the facts are
  // incomplete the caller rejects the action and never reads it, so it is not asked for (one more call
  // to an element that has just failed to answer).
  if (control_signature != nullptr && risk.metadata_complete)
    ComputeWindowsControlSignature(element, expected_pid, nullptr, control_signature);
  return risk;
}

WindowsUiaRisk ClassifyWindowsFocusedElementOnWorker(std::uint32_t expected_pid) {
  struct Objects {
    IUIAutomation *automation = nullptr;
    IUIAutomationElement *element = nullptr;
    ~Objects() {
      if (element != nullptr) element->Release();
      if (automation != nullptr) automation->Release();
    }
  } objects;
  IUIAutomation *&automation = objects.automation;
  IUIAutomationElement *&element = objects.element;
  if (FAILED(CreateWindowsV1Automation(&automation)) ||
      automation == nullptr)
    return {};
  const HRESULT found =
      WindowsV1UiaContact(element, [&] { return automation->GetFocusedElement(&element); });
  if (!WindowsV1UiaOk(found) || element == nullptr) {
    return {};
  }
  int owner_pid = 0;
  if (!WindowsV1UiaRead(owner_pid, [&] { return element->get_CurrentProcessId(&owner_pid); }) || owner_pid <= 0 ||
      static_cast<std::uint32_t>(owner_pid) != expected_pid) {
    return {};
  }
  const WindowsUiaRisk risk = ClassifyWindowsUiaElement(element);
  return risk;
}

struct WindowsUiaPointResult {
  WindowsUiaRisk risk;
  std::string signature;
};

WindowsUiaRisk ClassifyWindowsPoint(POINT point, std::uint32_t expected_pid,
                                    std::string *control_signature = nullptr) {
  if (control_signature != nullptr) control_signature->clear();
  WindowsUiaRisk result;
  const bool want_signature = control_signature != nullptr;
  RunWindowsUiaRead<WindowsUiaPointResult>(true,
      [point, expected_pid, want_signature]() -> std::optional<WindowsUiaPointResult> {
        WindowsUiaPointResult value;
        value.risk = ClassifyWindowsPointOnWorker(point, expected_pid, want_signature ? &value.signature : nullptr);
        return value;
      }, [&result, control_signature](WindowsUiaPointResult value) {
        result = value.risk;
        if (control_signature != nullptr) *control_signature = std::move(value.signature);
      });
  return result;
}

WindowsUiaRisk ClassifyWindowsFocusedElement(std::uint32_t expected_pid) {
  WindowsUiaRisk result;
  RunWindowsUiaRead<WindowsUiaRisk>(true,
      [expected_pid]() -> std::optional<WindowsUiaRisk> {
        return ClassifyWindowsFocusedElementOnWorker(expected_pid);
      }, [&result](WindowsUiaRisk value) { result = value; });
  return result;
}

bool ComputeWindowsControlSignature(IUIAutomationElement *element,
                                    std::uint32_t expected_pid,
                                    const RECT *containing_bounds,
                                    std::string *signature) {
  if (element == nullptr || signature == nullptr || !WindowsV1UiaMayCall())
    return false;
  int owner_pid = 0;
  CONTROLTYPEID control_type = 0;
  RECT bounds{};
  struct Values {
    BSTR automation_id = nullptr;
    SAFEARRAY *runtime_id = nullptr;
    bool accessed = false;
    ~Values() {
      if (automation_id != nullptr) SysFreeString(automation_id);
      if (runtime_id != nullptr) {
        if (accessed) SafeArrayUnaccessData(runtime_id);
        SafeArrayDestroy(runtime_id);
      }
    }
  } values;
  BSTR &automation_id = values.automation_id;
  SAFEARRAY *&runtime_id = values.runtime_id;
  const bool facts =
      WindowsV1UiaRead(owner_pid, [&] { return element->get_CurrentProcessId(&owner_pid); }) && owner_pid > 0 &&
      static_cast<std::uint32_t>(owner_pid) == expected_pid &&
      WindowsV1UiaRead(control_type, [&] { return element->get_CurrentControlType(&control_type); }) &&
      WindowsV1UiaRead(bounds, [&] { return element->get_CurrentBoundingRectangle(&bounds); }) &&
      bounds.right > bounds.left && bounds.bottom > bounds.top &&
      (containing_bounds == nullptr ||
       (bounds.left >= containing_bounds->left &&
        bounds.top >= containing_bounds->top &&
        bounds.right <= containing_bounds->right &&
        bounds.bottom <= containing_bounds->bottom)) &&
      WindowsV1UiaRead(automation_id, [&] { return element->get_CurrentAutomationId(&automation_id); }) &&
      WindowsV1UiaRead(runtime_id, [&] { return element->GetRuntimeId(&runtime_id); }) && runtime_id != nullptr &&
      SafeArrayGetDim(runtime_id) == 1;
  if (!facts) {
    return false;
  }
  LONG lower = 0;
  LONG upper = -1;
  LONG *runtime_values = nullptr;
  const bool bounded_shape =
      SUCCEEDED(SafeArrayGetLBound(runtime_id, 1, &lower)) &&
      SUCCEEDED(SafeArrayGetUBound(runtime_id, 1, &upper)) && upper >= lower &&
      upper - lower < 64;
  const HRESULT accessed =
      bounded_shape
          ? SafeArrayAccessData(runtime_id,
                                reinterpret_cast<void **>(&runtime_values))
          : E_FAIL;
  values.accessed = SUCCEEDED(accessed);
  if (!bounded_shape || FAILED(accessed) || runtime_values == nullptr) return false;
  std::string material =
      "computer-control-element-v1\n" + std::to_string(control_type) + "\n" +
      std::to_string(bounds.left) + "," + std::to_string(bounds.top) + "," +
      std::to_string(bounds.right) + "," + std::to_string(bounds.bottom) + "\n";
  for (LONG index = lower; index <= upper; ++index)
    material += std::to_string(runtime_values[index - lower]) + ",";
  material += "\n";
  if (automation_id != nullptr) {
    material += Utf8FromWide(
        std::wstring_view(automation_id, SysStringLen(automation_id)));
  }
  *signature = Sha256String(material);
  return signature->size() == 64;
}

struct WindowsControlBindings {
  std::unordered_map<std::string, std::string> semantic;
  std::set<std::string> visual;
};

bool ReadWindowsElementTargetId(IUIAutomationElement *element,
                                std::string *target_id) {
  if (element == nullptr || target_id == nullptr)
    return false;
  struct Labels {
    BSTR automation_id = nullptr, name = nullptr;
    ~Labels() {
      if (automation_id != nullptr) SysFreeString(automation_id);
      if (name != nullptr) SysFreeString(name);
    }
  } labels;
  BSTR &automation_id = labels.automation_id, &name = labels.name;
  const bool read =
      WindowsV1UiaRead(automation_id, [&] { return element->get_CurrentAutomationId(&automation_id); }) &&
      WindowsV1UiaRead(name, [&] { return element->get_CurrentName(&name); });
  if (!read) {
    return false;
  }
  const std::string automation_utf8 =
      automation_id == nullptr
          ? std::string{}
          : Utf8FromWide(std::wstring_view(automation_id, SysStringLen(automation_id)));
  const std::string name_utf8 =
      name == nullptr
          ? std::string{}
          : Utf8FromWide(std::wstring_view(name, SysStringLen(name)));
  const bool text_converted =
      (automation_id == nullptr || SysStringLen(automation_id) == 0 ||
       !automation_utf8.empty()) &&
      (name == nullptr || SysStringLen(name) == 0 || !name_utf8.empty());
  if (!text_converted) {
    return false;
  }
  *target_id = automation_utf8.empty() ? name_utf8 : automation_utf8;
  return target_id->size() <= 128;
}

bool CollectWindowsControlBindings(IUIAutomationElement *element,
                                   IUIAutomationTreeWalker *walker,
                                   std::uint32_t expected_pid, std::size_t depth,
                                   std::size_t *nodes,
                                   WindowsControlBindings *bindings,
                                   std::set<std::string> *duplicate_targets) {
  if (element == nullptr || walker == nullptr || nodes == nullptr || bindings == nullptr ||
      duplicate_targets == nullptr || depth > 16 || *nodes >= 5'000 || !WindowsV1UiaMayCall())
    return false;
  ++*nodes;
  WindowsV1UiaCountNode();

  std::string signature;
  if (!ComputeWindowsControlSignature(element, expected_pid, nullptr, &signature))
    return false;
  bindings->visual.insert(signature);

  std::string target_id;
  if (!ReadWindowsElementTargetId(element, &target_id))
    return false;
  if (!target_id.empty()) {
    if (duplicate_targets->contains(target_id)) {
      bindings->semantic.erase(target_id);
    } else if (bindings->semantic.contains(target_id)) {
      bindings->semantic.erase(target_id);
      duplicate_targets->insert(target_id);
    } else {
      bindings->semantic.emplace(target_id, signature);
    }
  }

  struct Children {
    IUIAutomationElement *child = nullptr, *next = nullptr;
    ~Children() {
      if (next != nullptr) next->Release();
      if (child != nullptr) child->Release();
    }
  } children;
  IUIAutomationElement *&child = children.child, *&next = children.next;
  const HRESULT first_result =
      WindowsV1UiaCall(child, [&] { return walker->GetFirstChildElement(element, &child); });
  if (!WindowsV1UiaOk(first_result)) {
    return false;
  }
  while (child != nullptr) {
    if (!CollectWindowsControlBindings(child, walker, expected_pid, depth + 1, nodes,
                                       bindings, duplicate_targets)) {
      return false;
    }
    next = nullptr;
    const HRESULT next_result =
        WindowsV1UiaCall(next, [&] { return walker->GetNextSiblingElement(child, &next); });
    child->Release();
    child = nullptr;
    if (!WindowsV1UiaOk(next_result)) return false;
    child = next;
    next = nullptr;
  }
  return true;
}

bool CaptureWindowsControlBindingsOnWorker(std::uint32_t pid, HWND window,
                                  WindowsControlBindings *bindings) {
  if (bindings == nullptr)
    return false;
  struct Objects {
    IUIAutomation *automation = nullptr;
    IUIAutomationElement *root = nullptr;
    IUIAutomationTreeWalker *walker = nullptr;
    ~Objects() {
      if (root != nullptr) root->Release();
      if (walker != nullptr) walker->Release();
      if (automation != nullptr) automation->Release();
    }
  } objects;
  IUIAutomation *&automation = objects.automation;
  IUIAutomationElement *&root = objects.root;
  IUIAutomationTreeWalker *&walker = objects.walker;
  if (FAILED(CreateWindowsV1Automation(&automation)) ||
      automation == nullptr)
    return false;
  const bool initialized =
      WindowsV1UiaOk(WindowsV1UiaContact(root, [&] { return automation->ElementFromHandle(window, &root); })) &&
      root != nullptr &&
      SUCCEEDED(automation->get_RawViewWalker(&walker)) && walker != nullptr;
  std::size_t nodes = 0;
  std::set<std::string> duplicate_targets;
  const bool complete =
      initialized && CollectWindowsControlBindings(root, walker, pid, 0, &nodes, bindings,
                                                   &duplicate_targets);
  return complete && nodes > 0 && nodes <= 5'000;
}

bool CaptureWindowsControlBindings(std::uint32_t pid, HWND window,
                                  WindowsControlBindings *bindings) {
  if (bindings == nullptr) return false;
  // MSVC containers can allocate in a move constructor. Publish only ownership under the
  // engine's locks; swap/destroy the caller's old value after those locks have been released.
  std::unique_ptr<WindowsControlBindings> measured;
  if (!RunWindowsUiaRead<std::unique_ptr<WindowsControlBindings>>(false,
      [pid, window]() -> std::optional<std::unique_ptr<WindowsControlBindings>> {
        auto value = std::make_unique<WindowsControlBindings>();
        if (!CaptureWindowsControlBindingsOnWorker(pid, window, value.get())) return std::nullopt;
        return value;
      }, [&measured](std::unique_ptr<WindowsControlBindings> value) { measured = std::move(value); }))
    return false;
  static_assert(noexcept(bindings->semantic.swap(measured->semantic)) &&
                noexcept(bindings->visual.swap(measured->visual)));
  bindings->semantic.swap(measured->semantic);
  bindings->visual.swap(measured->visual);
  return true;
}

bool WindowsFocusedElementSignatureOnWorker(std::uint32_t expected_pid,
                                    const RECT &client_bounds,
                                    std::string *signature) {
  if (signature == nullptr)
    return false;
  if (!WindowsV1UiaMayCall()) return false;
  struct Objects {
    IUIAutomation *automation = nullptr;
    IUIAutomationElement *element = nullptr;
    ~Objects() {
      if (element != nullptr) element->Release();
      if (automation != nullptr) automation->Release();
    }
  } objects;
  IUIAutomation *&automation = objects.automation;
  IUIAutomationElement *&element = objects.element;
  if (FAILED(CreateWindowsV1Automation(&automation)) ||
      automation == nullptr)
    return false;
  const HRESULT found =
      WindowsV1UiaContact(element, [&] { return automation->GetFocusedElement(&element); });
  if (!WindowsV1UiaOk(found) || element == nullptr) {
    return false;
  }
  const bool result =
      ComputeWindowsControlSignature(element, expected_pid, &client_bounds, signature);
  return result;
}

bool WindowsFocusedElementSignature(std::uint32_t expected_pid,
                                    const RECT &client_bounds,
                                    std::string *signature) {
  if (signature == nullptr) return false;
  std::string measured;
  if (!RunWindowsUiaRead<std::string>(false,
      [expected_pid, client_bounds]() -> std::optional<std::string> {
        std::string value;
        if (!WindowsFocusedElementSignatureOnWorker(expected_pid, client_bounds, &value)) return std::nullopt;
        return value;
      }, [&measured](std::string value) { measured = std::move(value); }))
    return false;
  signature->swap(measured);
  return true;
}

bool RejectWindowsRisk(const WindowsUiaRisk &risk, std::string *reason) {
  using namespace sprint_coder::computer_use;
  const auto decision = ClassifyNativePreflightFacts(
      {risk.metadata_complete, risk.classified, risk.secure, risk.high_impact});
  if (NativePreflightAllowsDispatch(decision)) return false;
  switch (decision.reason) {
    case NativePreflightReason::kSecure:
      *reason = "secure_field_blocked";
      break;
    case NativePreflightReason::kHighImpact:
      *reason = "high_impact_blocked";
      break;
    default:
      *reason = "target_unclassified";
      break;
  }
  return true;
}

bool FindUiaTargetRecursive(IUIAutomationElement *element,
                            IUIAutomationTreeWalker *walker,
                            std::string_view target_id, std::size_t depth,
                            std::size_t *visited, IUIAutomationElement **match,
                            bool *duplicate) {
  if (element == nullptr || walker == nullptr || depth > 16 ||
      *visited >= 5'000 || !WindowsV1UiaMayCall())
    return false;
  ++*visited;
  WindowsV1UiaCountNode();
  using sprint_coder::computer_use::windows_uia_source_detail::BstrHolder;
  BstrHolder automation_owner, name_owner;
  BSTR &automation_id = *automation_owner.Receive(), &name = *name_owner.Receive();
  const bool attributes_read =
      WindowsV1UiaRead(automation_id, [&] { return element->get_CurrentAutomationId(&automation_id); }) &&
      WindowsV1UiaRead(name, [&] { return element->get_CurrentName(&name); });
  if (!attributes_read) {
    return false;
  }
  const std::string automation_utf8 =
      automation_id == nullptr
          ? std::string{}
          : Utf8FromWide(
                std::wstring_view(automation_id, SysStringLen(automation_id)));
  const std::string name_utf8 =
      name == nullptr
          ? std::string{}
          : Utf8FromWide(std::wstring_view(name, SysStringLen(name)));
  if (automation_utf8 == target_id ||
      (automation_utf8.empty() && name_utf8 == target_id)) {
    if (*match == nullptr) {
      element->AddRef();
      *match = element;
    } else {
      *duplicate = true;
    }
  }
  using sprint_coder::computer_use::windows_uia_source_detail::ComRef;
  ComRef<IUIAutomationElement> child_owner, next_owner;
  IUIAutomationElement *&child = *child_owner.Receive(), *&next = *next_owner.Receive();
  if (!WindowsV1UiaOk(WindowsV1UiaCall(child, [&] { return walker->GetFirstChildElement(element, &child); }))) {
    return false;
  }
  while (child != nullptr && !*duplicate) {
    if (!FindUiaTargetRecursive(child, walker, target_id, depth + 1, visited,
                                match, duplicate)) {
      return false;
    }
    next = nullptr;
    if (!WindowsV1UiaOk(WindowsV1UiaCall(next, [&] { return walker->GetNextSiblingElement(child, &next); }))) {
      return false;
    }
    child_owner.Reset();
    child = next;
    next = nullptr;
  }
  return !*duplicate;
}

bool FindWindowsSemanticTarget(HWND window,
                               std::string_view target_id,
                               IUIAutomationElement **output,
                               std::string *reason) {
  if (target_id.empty() || target_id.size() > 128) {
    *reason = "target_required";
    return false;
  }
  using sprint_coder::computer_use::windows_uia_source_detail::ComRef;
  ComRef<IUIAutomation> automation_owner;
  ComRef<IUIAutomationElement> root_owner, match_owner;
  ComRef<IUIAutomationTreeWalker> walker_owner;
  IUIAutomation *&automation = *automation_owner.Receive();
  IUIAutomationElement *&root = *root_owner.Receive(), *&match = *match_owner.Receive();
  IUIAutomationTreeWalker *&walker = *walker_owner.Receive();
  if (FAILED(CreateWindowsV1Automation(&automation)) ||
      automation == nullptr) {
    *reason = "accessibility_unavailable";
    return false;
  }
  const WindowsV1UiaPath path;
  const bool initialized =
      WindowsV1UiaOk(WindowsV1UiaContact(root, [&] { return automation->ElementFromHandle(window, &root); })) &&
      root != nullptr && SUCCEEDED(automation->get_RawViewWalker(&walker)) &&
      walker != nullptr;
  std::size_t visited = 0;
  bool duplicate = false;
  const bool searched =
      initialized && FindUiaTargetRecursive(root, walker, target_id, 0,
                                            &visited, &match, &duplicate);
  root_owner.Reset();
  walker_owner.Reset();
  automation_owner.Reset();
  if (!searched || duplicate || match == nullptr) {
    // A call that timed out is not "no such target": the target did not answer (transient).
    *reason = duplicate ? "target_ambiguous"
              : path.Stop() == WindowsV1UiaStop::kTimeout ? "accessibility_timeout"
                                                          : "target_required";
    return false;
  }
  *output = match;
  match = nullptr;
  return true;
}

bool Utf16FromUtf8(std::string_view value, std::wstring *output) {
  if (value.empty() || value.size() > 4'096)
    return false;
  const int length =
      MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                          static_cast<int>(value.size()), nullptr, 0);
  if (length <= 0)
    return false;
  std::wstring converted(static_cast<std::size_t>(length), L'\0');
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                          static_cast<int>(value.size()), converted.data(),
                          length) != length)
    return false;
  *output = std::move(converted);
  return true;
}

// A pattern of the target, read through the timed read. A read that did not complete (it timed out, or
// "succeeded" too slowly to be believed) hands nothing back: a pattern it did produce is released here,
// so the caller never holds, or acts on, the answer of a target that stopped answering.
template <class Pattern>
bool ReadWindowsV1Pattern(IUIAutomationElement *target, PATTERNID id, Pattern **pattern) {
  *pattern = nullptr;
  const bool read = WindowsV1UiaRead(*pattern, [&] { return target->GetCurrentPatternAs(id, IID_PPV_ARGS(pattern)); });
  if (!read || *pattern == nullptr) {
    if (*pattern != nullptr)
      (*pattern)->Release();
    *pattern = nullptr;
    return false;
  }
  return true;
}

bool DispatchWindowsSemanticActionOnWorker(const WindowsSemanticWork &work, bool *accepted,
                                           std::string *reason) {
  using sprint_coder::computer_use::windows_uia_source_detail::ComRef;
  using sprint_coder::computer_use::windows_uia_source_detail::BstrHolder;
  const auto &target_id = work.target_id;
  const auto &metadata = work.metadata;
  const auto &kind = work.kind;
  ComRef<IUIAutomationElement> target_owner;
  IUIAutomationElement *&target = *target_owner.Receive();
  if (!FindWindowsSemanticTarget(work.window, target_id, &target, reason))
    return false;
  std::string current_target_signature;
  if (!work.observed_signature.has_value() ||
      !ComputeWindowsControlSignature(target, work.pid, nullptr,
                                      &current_target_signature) ||
      current_target_signature != *work.observed_signature) {
    *reason = "stale_target";
    return false;
  }
  if (RejectWindowsRisk(ClassifyWindowsUiaElement(target), reason)) {
    return false;
  }
  if (!AwaitWindowsSemanticValidation()) {
    *reason = "stale_target";
    return false;
  }

  HRESULT action_result = E_FAIL;
  if (kind == "invoke") {
    ComRef<IUIAutomationInvokePattern> pattern_owner;
    IUIAutomationInvokePattern *&pattern = *pattern_owner.Receive();
    if (ReadWindowsV1Pattern(target, UIA_InvokePatternId, &pattern)) {
      // The action is SENT only while the path is alive: after a timeout or a Cancel nothing is done
      // (a rejection before any input), never a call that cannot be confirmed.
      if (!WindowsV1UiaMayCall()) {
        *reason = WindowsV1UiaEndedReason();
      } else {
        action_result = InvokeWindowsSemanticInput([&] { return pattern->Invoke(); }, accepted);
      }
    } else {
      *reason = "semantic_pattern_unavailable";
    }
  } else if (kind == "set_text") {
    std::string text;
    std::wstring wide_text;
    ComRef<IUIAutomationValuePattern> pattern_owner;
    IUIAutomationValuePattern *&pattern = *pattern_owner.Receive();
    if (!ReadJsonString(metadata, "text", &text) ||
        !Utf16FromUtf8(text, &wide_text)) {
      *reason = "invalid_text";
    } else if (ReadWindowsV1Pattern(target, UIA_ValuePatternId, &pattern)) {
      BstrHolder value_owner;
      BSTR &value = *value_owner.Receive();
      value = SysAllocStringLen(wide_text.data(), static_cast<UINT>(wide_text.size()));
      if (value == nullptr && !wide_text.empty()) {
        *reason = "semantic_action_failed";
      } else {
        // The action is SENT only while the path is alive: after a timeout or a Cancel nothing is done
        // (a rejection before any input), never a call that cannot be confirmed.
        if (!WindowsV1UiaMayCall()) {
          *reason = WindowsV1UiaEndedReason();
        } else {
          action_result = InvokeWindowsSemanticInput([&] { return pattern->SetValue(value); }, accepted);
        }
      }
    } else {
      *reason = "semantic_pattern_unavailable";
    }
  } else if (kind == "select") {
    std::string selected_value;
    ComRef<IUIAutomationSelectionItemPattern> pattern_owner;
    IUIAutomationSelectionItemPattern *&pattern = *pattern_owner.Receive();
    BstrHolder name_owner;
    BSTR &name = *name_owner.Receive();
    const bool name_read = WindowsV1UiaRead(name, [&] { return target->get_CurrentName(&name); });
    const std::string target_name =
        name == nullptr || !name_read
            ? std::string{}
            : Utf8FromWide(std::wstring_view(name, SysStringLen(name)));
    if (!name_read) {
      // The target did not answer: nothing is compared with a name that was not read, and nothing is sent.
      *reason = WindowsV1UiaEndedReason();
    } else if (!ReadJsonString(metadata, "value", &selected_value) ||
        (selected_value != target_id && selected_value != target_name)) {
      *reason = "semantic_value_mismatch";
    } else if (ReadWindowsV1Pattern(target, UIA_SelectionItemPatternId, &pattern)) {
      // The action is SENT only while the path is alive: after a timeout or a Cancel nothing is done
      // (a rejection before any input), never a call that cannot be confirmed.
      if (!WindowsV1UiaMayCall()) {
        *reason = WindowsV1UiaEndedReason();
      } else {
        action_result = InvokeWindowsSemanticInput([&] { return pattern->Select(); }, accepted);
      }
    } else {
      *reason = "semantic_pattern_unavailable";
    }
  } else if (kind == "toggle") {
    const bool wants_true =
        metadata.find("\"value\":true") != std::string::npos;
    const bool wants_false =
        metadata.find("\"value\":false") != std::string::npos;
    ComRef<IUIAutomationTogglePattern> pattern_owner;
    IUIAutomationTogglePattern *&pattern = *pattern_owner.Receive();
    if ((!wants_true && !wants_false) ||
        !ReadWindowsV1Pattern(target, UIA_TogglePatternId, &pattern) ||
        pattern == nullptr) {
      *reason = "semantic_pattern_unavailable";
    } else {
      ToggleState current = ToggleState_Indeterminate;
      if (!WindowsV1UiaRead(current, [&] { return pattern->get_CurrentToggleState(&current); }) ||
          current == ToggleState_Indeterminate) {
        *reason = "semantic_state_unavailable";
      } else if ((current == ToggleState_On) == wants_true) {
        action_result = S_OK;
      } else {
        // The action is SENT only while the path is alive: after a timeout or a Cancel nothing is done
        // (a rejection before any input), never a call that cannot be confirmed.
        if (!WindowsV1UiaMayCall()) {
          *reason = WindowsV1UiaEndedReason();
        } else {
          action_result = InvokeWindowsSemanticInput([&] { return pattern->Toggle(); }, accepted);
        }
      }
    }
  } else if (kind == "expand_collapse") {
    const bool wants_expand =
        metadata.find("\"expanded\":true") != std::string::npos;
    const bool wants_collapse =
        metadata.find("\"expanded\":false") != std::string::npos;
    ComRef<IUIAutomationExpandCollapsePattern> pattern_owner;
    IUIAutomationExpandCollapsePattern *&pattern = *pattern_owner.Receive();
    if ((!wants_expand && !wants_collapse) ||
        !ReadWindowsV1Pattern(target, UIA_ExpandCollapsePatternId, &pattern) ||
        pattern == nullptr) {
      *reason = "semantic_pattern_unavailable";
    } else {
      ExpandCollapseState current = ExpandCollapseState_LeafNode;
      if (!WindowsV1UiaRead(current, [&] { return pattern->get_CurrentExpandCollapseState(&current); }) ||
          current == ExpandCollapseState_LeafNode) {
        *reason = "semantic_state_unavailable";
      } else if ((current == ExpandCollapseState_Expanded) == wants_expand) {
        action_result = S_OK;
      } else {
        // The action is SENT only while the path is alive: after a timeout or a Cancel nothing is done
        // (a rejection before any input), never a call that cannot be confirmed.
        if (!WindowsV1UiaMayCall()) {
          *reason = WindowsV1UiaEndedReason();
        } else {
          action_result = InvokeWindowsSemanticInput([&] { return wants_expand ? pattern->Expand() : pattern->Collapse(); }, accepted);
        }
      }
    }
  }
  if (FAILED(action_result) && !*accepted &&
      WindowsV1UiaCurrentStop() == WindowsV1UiaStop::kTimeout)
    *reason = "accessibility_timeout";
  if (FAILED(action_result)) {
    if (reason->empty())
      // A pattern call (Invoke, SetValue, Select, Toggle, Expand) that timed out may still have been
      // applied by the target: unconfirmed, and told apart from the other failures so that the caller
      // does not repeat the action blindly (a retry is the agent's decision, after a new observation).
      *reason = !*accepted ? "semantic_action_failed"
                : WindowsV1UiaIsTimeout(action_result) ? "input_timeout_unconfirmed"
                                                       : "input_not_confirmed";
    return false;
  }
  return true;
}

bool DispatchWindowsSemanticAction(const WindowsSession &session, const RECT &expected,
                                   std::uint64_t expected_epoch, std::string_view kind,
                                   const std::string &metadata, bool *accepted, std::string *reason) {
  *accepted = false;
  const WindowsV1UiaPath path;
  if (!WindowsV1UiaMayCall()) { *reason = WindowsV1UiaEndedReason(); return false; }
  WindowsV1UiaLane snapshot = *windows_v1_uia_lane;
  snapshot.epoch = expected_epoch;
  if (!snapshot.stop_serial.has_value()) snapshot.stop_serial = WindowsValidationFrameStopSerial();
  auto work = std::make_unique<WindowsSemanticWork>();
  if (!ReadJsonString(metadata, "targetId", &work->target_id) || work->target_id.empty() || work->target_id.size() > 128) {
    *reason = "target_required"; return false;
  }
  work->pid = session.pid;
  work->window = session.active_window;
  const auto observed = session.semantic_control_signatures.find(work->target_id);
  if (observed != session.semantic_control_signatures.end()) work->observed_signature = observed->second;
  work->kind = std::string(kind);
  work->metadata = metadata;
  auto pending = std::make_shared<WindowsSemanticPending>();
  pending->session_id = session.session_id;
  pending->attempts = session.input_api_attempts;
  auto &control = WindowsTargetListControl();
  {
    std::lock_guard stop_lock(control.stop_mutex);
    if (!WindowsValidationStillCurrent(snapshot.epoch, *snapshot.stop_serial)) {
      *reason = "semantic_action_failed"; return false;
    }
    if (WindowsUiaReadWorkerRunning().exchange(true, std::memory_order_acq_rel)) {
      *reason = "accessibility_unavailable"; return false;
    }
    WindowsSemanticOperations().active = pending;
  }
  try {
    std::thread([pending, snapshot, work = std::move(work)]() mutable {
      struct Progress {
        explicit Progress(WindowsSemanticPending *value) {
          windows_uia_read_progress = value;
          windows_semantic_operation = value;
        }
        ~Progress() { windows_semantic_operation = nullptr; windows_uia_read_progress = nullptr; }
      } progress(pending.get());
      const WindowsV1UiaPath worker_path(snapshot);
      bool succeeded = false, accepted = false;
      std::string reason;
      try {
        struct Apartment {
          HRESULT result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
          ~Apartment() { if (SUCCEEDED(result)) CoUninitialize(); }
        } apartment;
        if (SUCCEEDED(apartment.result) && WindowsV1UiaMayCall())
          succeeded = DispatchWindowsSemanticActionOnWorker(*work, &accepted, &reason);
        else reason = "accessibility_unavailable";
      } catch (...) {
        succeeded = false;
        reason = accepted ? "input_not_confirmed" : "semantic_action_failed";
      }
      work.reset();
      {
        std::lock_guard lock(pending->mutex);
        std::lock_guard stop_lock(WindowsTargetListControl().stop_mutex);
        if (pending->abandoned.load(std::memory_order_acquire) == WindowsV1UiaStop::kNone) {
          pending->succeeded = succeeded;
          pending->reason = std::move(reason);
          pending->stop.store(worker_path.Stop(), std::memory_order_release);
        }
        pending->done = true;
        if (WindowsSemanticOperations().active == pending) WindowsSemanticOperations().active.reset();
        WindowsUiaReadWorkerRunning().store(false, std::memory_order_release);
      }
      pending->ready.notify_all();
    }).detach();
  } catch (...) {
    std::lock_guard stop_lock(control.stop_mutex);
    if (WindowsSemanticOperations().active == pending) WindowsSemanticOperations().active.reset();
    WindowsUiaReadWorkerRunning().store(false, std::memory_order_release);
    *reason = "accessibility_unavailable";
    return false;
  }
  struct Abandon {
    std::shared_ptr<WindowsSemanticPending> pending;
    ~Abandon() {
      std::lock_guard lock(WindowsTargetListControl().stop_mutex);
      auto none = WindowsV1UiaStop::kNone;
      pending->abandoned.compare_exchange_strong(none, WindowsV1UiaStop::kCanceled);
      pending->ready.notify_all();
    }
  } abandon{pending};
  std::unique_lock lock(pending->mutex);
  for (;;) {
    bool validate = false;
    {
      std::lock_guard stop_lock(control.stop_mutex);
      auto &lane = *windows_v1_uia_lane;
      auto stop = lane.stop;
      if (stop == WindowsV1UiaStop::kNone) stop = pending->abandoned.load(std::memory_order_acquire);
      if (stop == WindowsV1UiaStop::kNone && !WindowsValidationStillCurrent(snapshot.epoch, *snapshot.stop_serial)) stop = WindowsV1UiaStop::kCanceled;
      if (stop == WindowsV1UiaStop::kNone && lane.has_deadline && std::chrono::steady_clock::now() > lane.deadline) stop = WindowsV1UiaStop::kBudget;
      if (stop == WindowsV1UiaStop::kNone && pending->contact_active &&
          std::chrono::steady_clock::now() - pending->contact_started >= kWindowsV1UiaSlowContact) stop = WindowsV1UiaStop::kTimeout;
      if (stop != WindowsV1UiaStop::kNone) {
        auto none = WindowsV1UiaStop::kNone;
        pending->abandoned.compare_exchange_strong(none, stop);
        lane.stop = pending->stop.load(std::memory_order_acquire);
        if (lane.stop == WindowsV1UiaStop::kNone) lane.stop = stop;
        lane.nodes += pending->nodes.load(std::memory_order_acquire);
        *accepted = pending->ever_claimed;
        *reason = pending->input_in_flight ? "semantic_input_in_flight" : pending->ever_claimed ? "input_not_confirmed" :
            stop == WindowsV1UiaStop::kTimeout ? "accessibility_timeout" : "semantic_action_failed";
        return false;
      }
      if (pending->done) {
        lane.stop = pending->stop.load(std::memory_order_acquire);
        lane.nodes += pending->nodes.load(std::memory_order_acquire);
        *accepted = pending->ever_claimed;
        *reason = std::move(pending->reason);
        return pending->succeeded;
      }
      if (pending->validation_requested && !pending->validation_started) {
        pending->validation_started = true;
        validate = true;
      }
    }
    if (validate) {
      lock.unlock();
      const bool valid = RevalidateWindowsTarget(session, expected, expected_epoch);
      lock.lock();
      {
        std::lock_guard stop_lock(control.stop_mutex);
        const bool current = WindowsValidationStillCurrent(snapshot.epoch, *snapshot.stop_serial) &&
            pending->abandoned.load(std::memory_order_acquire) == WindowsV1UiaStop::kNone;
        pending->validation = valid && current;
        if (!valid && current) {
          auto none = WindowsV1UiaStop::kNone;
          pending->abandoned.compare_exchange_strong(none, WindowsV1UiaStop::kCanceled);
          windows_v1_uia_lane->nodes += pending->nodes.load(std::memory_order_acquire);
          windows_v1_uia_lane->stop = pending->stop.load(std::memory_order_acquire);
          *reason = "stale_target";
          pending->ready.notify_all();
          return false;
        }
      }
      pending->ready.notify_all();
    } else pending->ready.wait_for(lock, std::chrono::milliseconds(20));
  }
}

std::string ResponseCacheKey(const Frame &request) {
  std::string identity;
  identity.reserve(sizeof(request.header.message_type) +
                   request.header.session_id.bytes.size() +
                   request.header.request_id.bytes.size());
  identity.append(reinterpret_cast<const char *>(&request.header.message_type),
                  sizeof(request.header.message_type));
  identity.append(
      reinterpret_cast<const char *>(request.header.session_id.bytes.data()),
      request.header.session_id.bytes.size());
  identity.append(
      reinterpret_cast<const char *>(request.header.request_id.bytes.data()),
      request.header.request_id.bytes.size());
  return identity;
}

bool IsLowerHexDigest64(std::string_view value) {
  if (value.size() != 64) return false;
  for (const char c : value)
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  return true;
}

// A dispatch carries the ticket its preflight issued, but a repeat of a finished request is answered
// from the cache whatever ticket (or none) it carries, so the request identity used for that
// comparison leaves the ticket out. Only the exact `"ticket":"<64 lowercase hex>"` member is
// removed; a text field that merely contains those characters has them escaped and never matches.
std::string WithoutDispatchTicket(const std::string &metadata) {
  const std::string needle = "\"ticket\":\"";
  for (std::size_t at = metadata.find(needle); at != std::string::npos;
       at = metadata.find(needle, at + 1)) {
    const std::size_t value_at = at + needle.size();
    if (value_at + 65 > metadata.size() ||
        !IsLowerHexDigest64(std::string_view(metadata).substr(value_at, 64)) ||
        metadata[value_at + 64] != '"')
      continue;
    std::size_t begin = at;
    std::size_t end = value_at + 65;
    if (begin > 0 && metadata[begin - 1] == ',')
      --begin;
    else if (end < metadata.size() && metadata[end] == ',')
      ++end;
    return metadata.substr(0, begin) + metadata.substr(end);
  }
  return metadata;
}

std::string RequestPayloadDigest(const Frame &request) {
  // The metadata the request is compared by. For a dispatch that leaves out the ticket, and the
  // length that goes into the digest is the length of what is compared, not of what was sent.
  std::string metadata(reinterpret_cast<const char *>(request.metadata.data()),
                       request.metadata.size());
  if (request.header.message_type ==
      static_cast<std::uint16_t>(MessageType::kDispatch))
    metadata = WithoutDispatchTicket(metadata);
  const std::uint32_t metadata_bytes =
      request.header.message_type ==
              static_cast<std::uint16_t>(MessageType::kDispatch)
          ? static_cast<std::uint32_t>(metadata.size())
          : request.header.metadata_bytes;
  std::string payload;
  payload.reserve(sizeof(metadata_bytes) + metadata.size() +
                  sizeof(request.header.binary_bytes) + request.binary.size());
  payload.append(reinterpret_cast<const char *>(&metadata_bytes),
                 sizeof(metadata_bytes));
  payload.append(metadata);
  payload.append(reinterpret_cast<const char *>(&request.header.binary_bytes),
                 sizeof(request.header.binary_bytes));
  if (!request.binary.empty())
    payload.append(reinterpret_cast<const char *>(request.binary.data()),
                   request.binary.size());
  return Sha256String(payload);
}

bool RevalidateWindowsTarget(const WindowsSession &session,
                             const RECT &expected,
                             std::uint64_t expected_epoch) {
  if (parent_process_dead.load(std::memory_order_acquire) ||
      !session.has_observation || session.active_window == nullptr ||
      GetForegroundWindow() != session.active_window ||
      session.cancel_epoch != expected_epoch ||
      cancellation_epoch.load(std::memory_order_acquire) != expected_epoch)
    return false;
  RECT current{};
  std::string reason;
  WindowsDialogSetSnapshot dialogs;
  if (!ValidateWindowsSession(session, &current, &reason, &dialogs) ||
      dialogs.digest != session.dialog_set_digest ||
      dialogs.active_window != session.active_window ||
      dialogs.active_identity != session.active_window_identity ||
      dialogs.active_kind != session.active_window_kind)
    return false;
  return current.left == expected.left && current.top == expected.top &&
         current.right == expected.right && current.bottom == expected.bottom;
}

UINT SendInputForBoundTarget(const WindowsSession &session,
                             const RECT &expected, std::uint64_t expected_epoch,
                             UINT count, LPINPUT events) {
  if (WindowsSemanticInputInFlight() || !RevalidateWindowsTarget(session, expected, expected_epoch)) return 0;
  session.input_api_attempts->fetch_add(1, std::memory_order_acq_rel);
  return SendInput(count, events, sizeof(INPUT));
}

WORD VirtualKeyForName(std::string_view key) {
  static const std::unordered_map<std::string_view, WORD> keys = {
      {"Enter", VK_RETURN},   {"Tab", VK_TAB},        {"Escape", VK_ESCAPE},
      {"Backspace", VK_BACK}, {"Delete", VK_DELETE},  {"ArrowUp", VK_UP},
      {"ArrowDown", VK_DOWN}, {"ArrowLeft", VK_LEFT}, {"ArrowRight", VK_RIGHT},
      {"Home", VK_HOME},      {"End", VK_END},
  };
  const auto found = keys.find(key);
  return found == keys.end() ? 0 : found->second;
}

bool SendUnicodeScalar(const WindowsSession &session, const RECT &expected,
                       std::uint64_t expected_epoch, std::uint32_t scalar,
                       bool *accepted) {
  if (!RevalidateWindowsTarget(session, expected, expected_epoch))
    return false;
  INPUT events[2]{};
  events[0].type = INPUT_KEYBOARD;
  events[0].ki.wVk = 0;
  events[0].ki.wScan = static_cast<WORD>(
      scalar <= 0xffff ? scalar : 0xd800 + ((scalar - 0x10000) >> 10));
  events[0].ki.dwFlags = KEYEVENTF_UNICODE;
  events[1] = events[0];
  events[1].ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
  if (scalar > 0xffff) {
    // SendInput's KEYEVENTF_UNICODE consumes UTF-16 units. A supplementary
    // scalar is emitted as a surrogate pair in two complete down/up pairs, with
    // a fresh focus check for each unit.
    const std::uint32_t pair = scalar - 0x10000;
    events[0].ki.wScan = static_cast<WORD>(0xd800 + (pair >> 10));
    events[1].ki.wScan = events[0].ki.wScan;
    const UINT first_pair_sent =
        SendInputForBoundTarget(session, expected, expected_epoch, 2, events);
    if (first_pair_sent > 0)
      *accepted = true;
    if (first_pair_sent != 2 ||
        !RevalidateWindowsTarget(session, expected, expected_epoch))
      return false;
    events[0].ki.wScan = static_cast<WORD>(0xdc00 + (pair & 0x3ff));
    events[1].ki.wScan = events[0].ki.wScan;
  }
  const UINT sent =
      SendInputForBoundTarget(session, expected, expected_epoch, 2, events);
  if (sent > 0)
    *accepted = true;
  return sent == 2 &&
         RevalidateWindowsTarget(session, expected, expected_epoch);
}

bool DecodeUtf8Scalars(std::string_view text,
                       std::vector<std::uint32_t> *output) {
  // The Windows helper accepts the same 4096-byte UTF-8 text ceiling as Main.
  // WideCharToMultiByte is not used here because it can replace malformed
  // sequences instead of rejecting them.
  if (text.empty() || text.size() > 4'096)
    return false;
  for (std::size_t index = 0; index < text.size();) {
    const auto first = static_cast<unsigned char>(text[index]);
    std::uint32_t scalar = 0;
    std::size_t width = 0;
    if (first <= 0x7f) {
      scalar = first;
      width = 1;
    } else if (first >= 0xc2 && first <= 0xdf) {
      scalar = first & 0x1f;
      width = 2;
    } else if (first >= 0xe0 && first <= 0xef) {
      scalar = first & 0x0f;
      width = 3;
    } else if (first >= 0xf0 && first <= 0xf4) {
      scalar = first & 0x07;
      width = 4;
    } else {
      return false;
    }
    if (index + width > text.size())
      return false;
    for (std::size_t offset = 1; offset < width; ++offset) {
      const auto byte = static_cast<unsigned char>(text[index + offset]);
      if ((byte & 0xc0) != 0x80)
        return false;
      scalar = (scalar << 6) | (byte & 0x3f);
    }
    if (scalar > 0x10ffff || (scalar >= 0xd800 && scalar <= 0xdfff) ||
        (width == 3 && scalar < 0x800) || (width == 4 && scalar < 0x10000))
      return false;
    if (!sprint_coder::computer_use::IsTypeTextScalar(scalar)) return false;
    output->push_back(scalar);
    index += width;
  }
  return !output->empty();
}

// What a dispatch needs before it may do anything, shared by the preflight (which issues the
// ticket) and the dispatch itself (which consumes it): the request names this session's current
// cancel epoch and observation, the bound window is still the observed one, and the key/type
// focus has not moved. It performs no input.
bool ValidateWindowsDispatchBinding(const WindowsSession &session,
                                    const std::string &metadata,
                                    std::string *kind, RECT *bounds,
                                    std::string *reason) {
  const std::uint64_t expected_epoch = session.cancel_epoch;
  std::uint64_t requested_epoch = 0;
  std::uint64_t requested_observation = 0;
  if (!ReadJsonString(metadata, "type", kind) ||
      !ReadJsonUint64(metadata, "cancelEpoch", &requested_epoch) ||
      !ReadJsonUint64(metadata, "observationRevision",
                      &requested_observation) ||
      requested_epoch != expected_epoch || requested_observation == 0 ||
      !session.has_observation ||
      requested_observation != session.observation_revision) {
    *reason = "invalid_action";
    return false;
  }
  RECT current_bounds{};
  if (!ValidateWindowsSession(session, &current_bounds, reason))
    return false;
  // S5-c-3 PR-5: a v2 session judges its target again before every input (the preflight that issues
  // the ticket and the dispatch that spends it), and the explicit "not web" table is answered here.
  if (!JudgeWindowsV2Input(session, reason))
    return false;
  const RECT observed = session.observation_bounds;
  if (current_bounds.left != observed.left ||
      current_bounds.top != observed.top ||
      current_bounds.right != observed.right ||
      current_bounds.bottom != observed.bottom ||
      !RevalidateWindowsTarget(session, observed, expected_epoch)) {
    *reason = "stale_target";
    return false;
  }
  if (*kind == "key" || *kind == "type") {
    std::string current_focused_signature;
    if (!session.has_focused_element_signature ||
        !WindowsFocusedElementSignature(session.pid, observed,
                                        &current_focused_signature) ||
        current_focused_signature != session.focused_element_signature) {
      *reason = "focused_target_changed";
      return false;
    }
  }
  *bounds = observed;
  return true;
}

void AppendDigestField(std::string *frame, std::string_view name,
                       std::string_view value, bool present) {
  frame->append(std::to_string(name.size()));
  frame->push_back(':');
  frame->append(name);
  frame->push_back(present ? '1' : '0');
  frame->append(std::to_string(value.size()));
  frame->push_back(':');
  frame->append(value);
}

// The fields the dispatch reads from the request, framed so adjacent fields cannot run together and
// an absent field differs from an empty one. A field the dispatch does not read cannot change what
// it does, so it is not bound.
std::string WindowsDispatchPayloadDigest(const std::string &metadata) {
  std::string frame = "windows-dispatch-payload-v1";
  for (const char *name : {"type", "targetId", "name", "key", "text", "value",
                           "button"}) {
    std::string value;
    const bool present = ReadJsonString(metadata, name, &value);
    AppendDigestField(&frame, name, value, present);
  }
  for (const char *name : {"x", "y", "deltaX", "deltaY"}) {
    double number = 0;
    const bool present = ReadJsonDouble(metadata, name, &number);
    char text[48]{};
    if (present) std::snprintf(text, sizeof(text), "%.17g", number);
    AppendDigestField(&frame, name, text, present);
  }
  // The booleans a toggle and an expand/collapse are decided by, read with the same text search the
  // dispatch uses (true, false or absent), so a flipped target state cannot ride on the same ticket.
  for (const char *name : {"value", "expanded"}) {
    const std::string member = "\"" + std::string(name) + "\":";
    const bool is_true = metadata.find(member + "true") != std::string::npos;
    const bool is_false = metadata.find(member + "false") != std::string::npos;
    AppendDigestField(&frame, std::string(name) + "Boolean",
                      is_true ? "true" : (is_false ? "false" : ""),
                      is_true || is_false);
  }
  return Sha256String(frame);
}

// The session state a dispatch acts on, so a ticket measured against one window state is refused
// against another. It does not include the observation counters of this request (the binding does).
std::string WindowsDispatchContextDigest(const WindowsSession &session) {
  std::string frame = "windows-dispatch-context-v1";
  AppendDigestField(&frame, "app", session.app_identity, true);
  AppendDigestField(&frame, "window", session.window_identity, true);
  AppendDigestField(&frame, "activeWindow", session.active_window_identity, true);
  AppendDigestField(&frame, "activeKind", session.active_window_kind, true);
  AppendDigestField(&frame, "processStart", session.process_start, true);
  AppendDigestField(&frame, "pid", std::to_string(session.pid), true);
  AppendDigestField(&frame, "dialogs", session.dialog_set_digest, true);
  AppendDigestField(&frame, "dialogRevision",
                    std::to_string(session.dialog_set_revision), true);
  AppendDigestField(&frame, "observation",
                    std::to_string(session.observation_revision), true);
  const RECT bounds = session.observation_bounds;
  AppendDigestField(&frame, "bounds",
                    std::to_string(bounds.left) + "," +
                        std::to_string(bounds.top) + "," +
                        std::to_string(bounds.right) + "," +
                        std::to_string(bounds.bottom),
                    true);
  AppendDigestField(&frame, "focused", session.focused_element_signature,
                    session.has_focused_element_signature);
  return Sha256String(frame);
}

std::uint64_t MonotonicNowNs() {
  return static_cast<std::uint64_t>(
      std::chrono::duration_cast<std::chrono::nanoseconds>(
          std::chrono::steady_clock::now().time_since_epoch())
          .count());
}

// Overwrites a secret before its storage is released (the token and the receipt that carries it).
void ScrubString(std::string *value) {
  if (value == nullptr || value->empty()) return;
  SecureZeroMemory(value->data(), value->size());
  value->clear();
}

bool GenerateTicketToken(std::string *token) {
  std::array<std::uint8_t, 32> bytes{};
  token->clear();
  const bool generated =
      BCryptGenRandom(nullptr, bytes.data(), static_cast<ULONG>(bytes.size()),
                      BCRYPT_USE_SYSTEM_PREFERRED_RNG) == 0;
  if (generated) {
    static const char hex[] = "0123456789abcdef";
    for (const auto byte : bytes) {
      token->push_back(hex[byte >> 4]);
      token->push_back(hex[byte & 0x0f]);
    }
  }
  SecureZeroMemory(bytes.data(), bytes.size());
  return generated;
}

sprint_coder::computer_use::NativeOrdinaryTicketBinding WindowsTicketBinding(
    const WindowsSession &session, const std::string &request_id,
    const std::string &action_digest, const std::string &payload_digest,
    std::uint64_t cancel_epoch, std::uint64_t generation) {
  sprint_coder::computer_use::NativeOrdinaryTicketBinding binding;
  binding.session_id = session.session_id;
  binding.request_id = request_id;
  binding.action_digest = action_digest;
  binding.payload_digest = payload_digest;
  binding.context_digest = WindowsDispatchContextDigest(session);
  binding.cancel_epoch = cancel_epoch;
  binding.ticket_generation = generation;
  return binding;
}

// Consumes the ordinary ticket a dispatch carries. A request without the key is refused and leaves
// the slot alone; a request that carries it burns the slot whatever the outcome, and the
// generation advances so a ticket measured before cannot match again. Replays are answered from the
// response cache before this runs, so they need no ticket.
bool ConsumeWindowsDispatchTicket(const std::string &session_key,
                                  const WindowsSession &session,
                                  const std::string &metadata) {
  const auto found = ticket_states.find(session_key);
  std::string token;
  if (found == ticket_states.end() || !ReadJsonString(metadata, "ticket", &token))
    return false;
  WindowsTicketState &state = found->second;
  std::string request_id;
  std::string action_digest;
  std::uint64_t cancel_epoch = 0;
  const bool readable =
      ReadJsonString(metadata, "requestId", &request_id) &&
      ReadJsonString(metadata, "actionDigest", &action_digest) &&
      ReadJsonUint64(metadata, "cancelEpoch", &cancel_epoch) &&
      IsLowerHexDigest64(action_digest);
  const bool consumed =
      readable &&
      state.slot.Consume(
          token,
          WindowsTicketBinding(session, request_id, action_digest,
                               WindowsDispatchPayloadDigest(metadata),
                               cancel_epoch, state.generation),
          MonotonicNowNs());
  state.slot.Invalidate();
  ++state.generation;
  ScrubString(&token);
  return consumed && session.cancel_epoch == cancel_epoch;
}

// BEGIN click rule (#500 S5-c-2 PR-2)
// A single click on a passive item of a file manager only selects it (#777), unless it completes a
// double click or the file manager opens an item on one click (its "single click to open" setting).
// The portable rule is MayOpen; these are the facts only the host knows.

// Whether the user's file manager opens an item on ONE click. Read from the shell state each time.
// The state starts zeroed, so a read that fills nothing says "single click" (= it opens: fail
// closed). fDoubleClickInWebView is TRUE (-1) when a double click is required (the default).
bool WindowsSingleClickOpens() noexcept {
  SHELLSTATE state{};
  SHGetSetSettings(&state, SSF_DOUBLECLICKINWEBVIEW, FALSE);
  return state.fDoubleClickInWebView == 0;
}

// Whether a click made now may complete a double click. The OS pairs two presses within the
// double-click time, whoever sent them, and the earlier press is an input, so it is at or before the
// system's LAST input time: if that is older than the double-click time, no pair can form. That is all
// this asks (see RecentInputMayCompleteDoubleClick); it keeps no record of its own clicks and tells
// nobody's input from anybody's. The price: a click within the double-click time (500 ms by default)
// of any input, this helper's own included, counts as opening; the agent acts one step per model
// round trip, which is seconds. Anything this cannot read is "opens".
bool WindowsRecentInputMayPair() noexcept {
  LASTINPUTINFO info{};
  info.cbSize = sizeof(info);
  const bool read = GetLastInputInfo(&info) != FALSE;
  return sprint_coder::computer_use::RecentInputMayCompleteDoubleClick(
      read, read ? info.dwTime : 0, static_cast<std::uint32_t>(GetTickCount64()),
      GetDoubleClickTime());
}

// Whether a click opens what it lands on: the file manager opens on one click, or it may complete a
// double click.
bool WindowsClickOpens() noexcept {
  return WindowsSingleClickOpens() || WindowsRecentInputMayPair();
}

// What the interlock evaluation knew about the click when it ran (#500 S5-c-2 PR-5, review): whether
// the click is followed at all, whether it was already taken as opening, and the system's last input
// time at that moment. The evaluation can take up to the lane's hold limit; this lets the dispatch
// tell, just before it sends the click, that input came in after the evaluation.
struct WindowsClickBasis {
  bool tracked = false;
  bool opens = false;
  bool input_read = false;
  DWORD input_tick = 0;
};

bool WindowsReadLastInputTick(DWORD *tick) noexcept {
  LASTINPUTINFO info{};
  info.cbSize = sizeof(info);
  if (!GetLastInputInfo(&info)) return false;
  *tick = info.dwTime;
  return true;
}

// Whether input has come in since the evaluation, for a click the evaluation judged as NOT opening
// (a click already taken as opening has nothing to lose). The dispatch then stops the click before
// it is sent (fail closed): the verdict was made for a moment that is no longer the present one, and
// a person's click that now pairs with ours would open the item. A last input time that cannot be
// read counts as moved. The cost: a person moving the mouse during the evaluation stops the click
// (the agent tries again).
bool WindowsInputMovedSinceEvaluation(const WindowsClickBasis &basis) noexcept {
  if (!basis.tracked || basis.opens) return false;
  DWORD now_tick = 0;
  if (!basis.input_read || !WindowsReadLastInputTick(&now_tick)) return true;
  return now_tick != basis.input_tick;
}

// The v2 interlocks' answer for an action whose V1 binding is valid (defined with the synchronous
// entry): a refusal, or no verdict. A click fills `basis` with what the evaluation knew.
sprint_coder::computer_use::InterlockEvaluation
WindowsInterlockRefusal(const WindowsSession &session, const std::string &metadata,
                        const std::string &kind, WindowsClickBasis *basis = nullptr) noexcept;
// END click rule

// BEGIN windows action point
// The screen point a click or scroll lands on: the metadata's x / y (each in 0..1) mapped onto the
// bounds. THE one copy of the mapping: the dispatch, the effect shadow and the synchronous interlock
// entry all call it, so they cannot disagree about where an action lands. False (and no point) when
// x or y is missing or out of range.
bool WindowsActionPoint(const RECT &bounds, const std::string &metadata,
                        POINT *point) {
  double x = 0;
  double y = 0;
  if (!ReadJsonDouble(metadata, "x", &x) || !ReadJsonDouble(metadata, "y", &y) ||
      x < 0 || x > 1 || y < 0 || y > 1)
    return false;
  point->x = bounds.left + static_cast<LONG>(std::lround(
                               x * std::max<LONG>(0, bounds.right - bounds.left - 1)));
  point->y = bounds.top + static_cast<LONG>(std::lround(
                              y * std::max<LONG>(0, bounds.bottom - bounds.top - 1)));
  return true;
}
// END windows action point

bool DispatchWindowsAction(const WindowsSession &session,
                           const std::string &metadata, std::string *result,
                           std::string *reason, bool *accepted) {
  *accepted = false;
  if (WindowsSemanticInputInFlight()) { *reason = "semantic_input_in_flight"; return false; }
  const std::uint64_t expected_epoch = session.cancel_epoch;
  std::string kind;
  RECT bounds{};
  if (!ValidateWindowsDispatchBinding(session, metadata, &kind, &bounds, reason))
    return false;
  // The v2 interlocks again, right before any input (#500 S5-c-2 PR-5): the screen can have changed
  // since the preflight (the ticket lives seconds), and the click facts (the last input time) are read
  // again by the evaluation. A refusal is made before the first input API attempt, SetCursorPos or
  // SendInput. No verdict leaves the V1 guards below as they are.
  WindowsClickBasis click_basis;
  {
    const sprint_coder::computer_use::InterlockEvaluation evaluation =
        WindowsInterlockRefusal(session, metadata, kind, &click_basis);
    if (evaluation.Refuses()) {
      *reason = std::string(evaluation.verdict.DispatchCode());
      return false;
    }
  }
  // The evaluation took time (up to the lane's hold limit) after the binding check, and the focus
  // moved to another control of the same window in that time would send the key or the text to an
  // element the observation never saw. The same check as the binding's, again, before any input.
  if (kind == "key" || kind == "type") {
    std::string current_focused_signature;
    if (!session.has_focused_element_signature ||
        !WindowsFocusedElementSignature(session.pid, bounds, &current_focused_signature) ||
        current_focused_signature != session.focused_element_signature) {
      *reason = "focused_target_changed";
      return false;
    }
  }
  bool dispatched = false;
  if (kind == "click") {
    double x = 0;
    double y = 0;
    if (!ReadJsonDouble(metadata, "x", &x) ||
        !ReadJsonDouble(metadata, "y", &y) || x < 0 || x > 1 || y < 0 ||
        y > 1 || !RevalidateWindowsTarget(session, bounds, expected_epoch)) {
      *reason = "stale_target";
      return false;
    }
    POINT click_point{0, 0};
    if (!WindowsActionPoint(bounds, metadata, &click_point)) {
      *reason = "stale_target";
      return false;
    }
    const int screen_x = click_point.x;
    const int screen_y = click_point.y;
    std::string visual_signature;
    if (RejectWindowsRisk(ClassifyWindowsPoint({screen_x, screen_y},
                                               session.pid, &visual_signature),
                          reason))
      return false;
    if (visual_signature.empty() ||
        !session.visual_control_signatures.contains(visual_signature)) {
      *reason = "stale_target";
      return false;
    }
    if (!RevalidateWindowsTarget(session, bounds, expected_epoch)) {
      *reason = "stale_target";
      return false;
    }
    if (!RevalidateVisualPatch(session, x, y, reason) ||
        !RevalidateWindowsTarget(session, bounds, expected_epoch)) {
      if (reason->empty())
        *reason = "stale_target";
      return false;
    }
    session.input_api_attempts->fetch_add(1, std::memory_order_acq_rel);
    if (!SetCursorPos(screen_x, screen_y)) {
      *reason = "input_unavailable";
      return false;
    }
    std::string current_visual_signature;
    if (RejectWindowsRisk(ClassifyWindowsPoint({screen_x, screen_y},
                                               session.pid,
                                               &current_visual_signature),
                          reason))
      return false;
    if (current_visual_signature.empty() ||
        !session.visual_control_signatures.contains(current_visual_signature)) {
      *reason = "stale_target";
      return false;
    }
    if (!RevalidateWindowsTarget(session, bounds, expected_epoch)) {
      *reason = "stale_target";
      return false;
    }
    // Input came in after the interlock evaluation judged this click as not opening: it is not sent.
    // The reuse of "focused_target_changed" is on purpose (Main maps every code of this kind to the
    // same plain rejection): for a click it means "input from elsewhere came in after the
    // evaluation", not that the focus moved.
    if (WindowsInputMovedSinceEvaluation(click_basis)) {
      *reason = "focused_target_changed";
      return false;
    }
    INPUT events[2]{};
    events[0].type = INPUT_MOUSE;
    events[0].mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
    events[1] = events[0];
    events[1].mi.dwFlags = MOUSEEVENTF_LEFTUP;
    const UINT sent =
        SendInputForBoundTarget(session, bounds, expected_epoch, 2, events);
    if (sent > 0)
      *accepted = true;
    dispatched =
        sent == 2 && RevalidateWindowsTarget(session, bounds, expected_epoch);
  } else if (kind == "scroll") {
    double delta_y_value = 0;
    double delta_x_value = 0;
    double x = 0;
    double y = 0;
    if (!ReadJsonDouble(metadata, "deltaY", &delta_y_value) ||
        !ReadJsonDouble(metadata, "deltaX", &delta_x_value) ||
        !ReadJsonDouble(metadata, "x", &x) ||
        !ReadJsonDouble(metadata, "y", &y) || x < 0 || x > 1 || y < 0 ||
        y > 1) {
      *reason = "invalid_action";
      return false;
    }
    POINT point{0, 0};
    if (!WindowsActionPoint(bounds, metadata, &point)) {
      *reason = "invalid_action";
      return false;
    }
    std::string visual_signature;
    if (RejectWindowsRisk(
            ClassifyWindowsPoint(point, session.pid, &visual_signature),
            reason))
      return false;
    if (visual_signature.empty() ||
        !session.visual_control_signatures.contains(visual_signature)) {
      *reason = "stale_target";
      return false;
    }
    if (!RevalidateWindowsTarget(session, bounds, expected_epoch) ||
        !RevalidateVisualPatch(session, x, y, reason) ||
        !RevalidateWindowsTarget(session, bounds, expected_epoch)) {
      if (reason->empty())
        *reason = "stale_target";
      return false;
    }
    session.input_api_attempts->fetch_add(1, std::memory_order_acq_rel);
    if (!SetCursorPos(point.x, point.y)) {
      *reason = "input_unavailable";
      return false;
    }
    std::string current_visual_signature;
    if (RejectWindowsRisk(
            ClassifyWindowsPoint(point, session.pid, &current_visual_signature),
            reason))
      return false;
    if (current_visual_signature.empty() ||
        !session.visual_control_signatures.contains(current_visual_signature)) {
      *reason = "stale_target";
      return false;
    }
    const auto delta_y = static_cast<std::int32_t>(delta_y_value);
    const auto delta_x = static_cast<std::int32_t>(delta_x_value);
    if ((delta_x == 0 && delta_y == 0) || delta_x < -10'000 ||
        delta_x > 10'000 || delta_y < -10'000 || delta_y > 10'000 ||
        !RevalidateWindowsTarget(session, bounds, expected_epoch)) {
      *reason = "stale_target";
      return false;
    }
    dispatched = true;
    if (delta_y != 0) {
      INPUT vertical{};
      vertical.type = INPUT_MOUSE;
      vertical.mi.mouseData = static_cast<DWORD>(delta_y * WHEEL_DELTA);
      vertical.mi.dwFlags = MOUSEEVENTF_WHEEL;
      const UINT sent = SendInputForBoundTarget(session, bounds, expected_epoch,
                                                1, &vertical);
      if (sent > 0)
        *accepted = true;
      dispatched =
          sent == 1 && RevalidateWindowsTarget(session, bounds, expected_epoch);
    }
    if (dispatched && delta_x != 0) {
      INPUT horizontal{};
      horizontal.type = INPUT_MOUSE;
      horizontal.mi.mouseData = static_cast<DWORD>(delta_x * WHEEL_DELTA);
      horizontal.mi.dwFlags = MOUSEEVENTF_HWHEEL;
      const UINT sent = SendInputForBoundTarget(session, bounds, expected_epoch,
                                                1, &horizontal);
      if (sent > 0)
        *accepted = true;
      dispatched =
          sent == 1 && RevalidateWindowsTarget(session, bounds, expected_epoch);
    }
  } else if (kind == "key") {
    std::string key;
    const WORD virtual_key =
        ReadJsonString(metadata, "key", &key) ? VirtualKeyForName(key) : 0;
    if (virtual_key == 0 ||
        !RevalidateWindowsTarget(session, bounds, expected_epoch)) {
      *reason = "invalid_key";
      return false;
    }
    if (RejectWindowsRisk(ClassifyWindowsFocusedElement(session.pid), reason))
      return false;
    if (!RevalidateWindowsTarget(session, bounds, expected_epoch)) {
      *reason = "stale_target";
      return false;
    }
    INPUT events[2]{};
    events[0].type = INPUT_KEYBOARD;
    events[0].ki.wVk = virtual_key;
    events[1] = events[0];
    events[1].ki.dwFlags = KEYEVENTF_KEYUP;
    const UINT sent =
        SendInputForBoundTarget(session, bounds, expected_epoch, 2, events);
    if (sent > 0)
      *accepted = true;
    dispatched =
        sent == 2 && RevalidateWindowsTarget(session, bounds, expected_epoch);
  } else if (kind == "type") {
    std::string text;
    std::vector<std::uint32_t> scalars;
    if (!ReadJsonString(metadata, "text", &text) ||
        !DecodeUtf8Scalars(text, &scalars) || scalars.size() != 1) {
      *reason = "invalid_text";
      return false;
    }
    if (RejectWindowsRisk(ClassifyWindowsFocusedElement(session.pid), reason))
      return false;
    dispatched = true;
    for (const auto scalar : scalars) {
      if (!SendUnicodeScalar(session, bounds, expected_epoch, scalar,
                             accepted)) {
        dispatched = false;
        break;
      }
    }
  } else if (kind == "invoke" || kind == "set_text" || kind == "select" ||
             kind == "toggle" || kind == "expand_collapse") {
    dispatched =
        DispatchWindowsSemanticAction(session, bounds, expected_epoch, kind,
                                      metadata, accepted, reason) &&
        RevalidateWindowsTarget(session, bounds, expected_epoch);
    if (!dispatched && *accepted && reason->empty())
      *reason = "input_not_confirmed";
  } else {
    *reason = "unsupported_action";
    return false;
  }
  if (!dispatched) {
    if (*accepted) {
      // Preserve whether the owned API is still in flight: Main must retain its original helper
      // until a later Stop proves it returned. Other unconfirmed inputs keep the generic reason.
      if (*reason != "input_timeout_unconfirmed" && *reason != "semantic_input_in_flight")
        *reason = "input_not_confirmed";
    } else if (cancellation_epoch.load(std::memory_order_acquire) !=
             expected_epoch)
      *reason = "canceled";
    else if (reason->empty())
      *reason = "input_not_confirmed";
    return false;
  }
  *result = "completed";
  reason->clear();
  return true;
}

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
         ",\"capabilities\":{"
         "\"observe\":" +
         (backend_ready ? "true" : "false") +
         ",\"control\":" + (backend_ready ? "true" : "false") +
         ",\"uiAutomation\":" + (probe.ui_automation ? "true" : "false") +
         ",\"graphicsCapture\":" + (probe.graphics_capture ? "true" : "false") +
         ",\"sendInput\":" + (probe.send_input ? "true" : "false") +
         ",\"cancellableWindowDiscovery\":true" +
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
         "},\"reason\":\"" + reason + "\"}\n";
}

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
  return WriteFrame(pipe, response, payload, binary);
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
         std::to_string(sprint_coder::computer_use::kNativePreflightClassifierVersion) +
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
std::atomic<bool> &InterlockWorkerRunning() {
  static std::atomic<bool> *const running = new std::atomic<bool>(false);
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
    std::atomic<bool> &running = InterlockWorkerRunning();
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

bool HandleWindowsPreflight(HANDLE pipe, const Frame &request,
                            const std::string &metadata) {
  const WindowsValidationFrameScope frame;
  const std::string session_key = FrameIdKey(request.header.session_id);
  const auto found = sessions.find(session_key);
  if (found == sessions.end())
    return Respond(pipe, request, MessageType::kError,
                   ErrorPayload("session_missing"));
  const WindowsSession &session = found->second;
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
  std::string receipt = WindowsPreflightReceipt(
      session, request_id, cancel_epoch, observation_revision,
      issued ? "ordinary" : "denied",
      issued ? "" : "native_ticket_unavailable", issued ? token : "");
  const bool sent =
      Respond(pipe, request, MessageType::kPreflightResult, receipt);
  // The secret only needs to live until it is on the wire (the slot keeps its own copy).
  ScrubString(&token);
  ScrubString(&receipt);
  // The V1 answer is out; the v2 classifier only watches (see the shadow wiring above).
  ScheduleWindowsEffectShadow(session, metadata, kind, true, issued);
  return sent;
}

bool ObserveWindowsWindow(WindowsSession &session, std::string *response,
                          std::vector<std::uint8_t> *binary,
                          std::string *reason,
                          std::optional<std::uint64_t> queued_stop_serial = std::nullopt) {
  RECT bounds{};
  WindowsDialogSetSnapshot dialogs;
  // The UI Automation reads of the whole observe share one budget and the cancellation epoch (see the
  // bounds above). The reason of a read that did not complete says why (WindowsV1ObserveReason).
  const auto observe_stop_serial = queued_stop_serial.value_or(WindowsValidationFrameStopSerial());
  const WindowsV1UiaPath uia_path(kWindowsV1UiaObserveBudget, session.cancel_epoch, observe_stop_serial);
  const auto unreadable = [&uia_path](const char *otherwise) -> const char * {
    if (uia_path.Stop() == WindowsV1UiaStop::kBudget) {
      // Only a count (never a label or a text): how far the walks got before the budget was spent.
      const std::string note = "computer-use: observe UI Automation budget spent after " +
                               std::to_string(uia_path.Nodes()) + " nodes\n";
      OutputDebugStringA(note.c_str());
    }
    return WindowsV1ObserveReason(uia_path.Stop(), otherwise);
  };
  if (!WindowsV1UiaMayCall()) {
    *reason = unreadable("observation_stale");
    return false;
  }
  if (!ValidateWindowsSession(session, &bounds, reason, &dialogs) ||
      session.cancel_epoch !=
          cancellation_epoch.load(std::memory_order_acquire))
    return false;
  std::string tree;
  std::size_t nodes = 0;
  if (!ReadUiaObservation(session.pid, dialogs.active_window, &tree, &nodes)) {
    *reason = unreadable("accessibility_unavailable");
    return false;
  }
  WindowsControlBindings bindings;
  if (!CaptureWindowsControlBindings(session.pid, dialogs.active_window,
                                     &bindings)) {
    *reason = unreadable("accessibility_binding_unavailable");
    return false;
  }
  std::string stable_tree;
  std::size_t stable_nodes = 0;
  if (!ReadUiaObservation(session.pid, dialogs.active_window, &stable_tree,
                          &stable_nodes) ||
      stable_tree != tree || stable_nodes != nodes) {
    *reason = unreadable("observation_stale");
    return false;
  }
  WindowsControlBindings stable_bindings;
  if (!CaptureWindowsControlBindings(session.pid, dialogs.active_window,
                                     &stable_bindings) ||
      stable_bindings.semantic != bindings.semantic ||
      stable_bindings.visual != bindings.visual) {
    *reason = unreadable("observation_stale");
    return false;
  }
  const WindowsUiaRisk focused_risk =
      ClassifyWindowsFocusedElement(session.pid);
  if (!WindowsValidationStillCurrent(session.cancel_epoch, observe_stop_serial)) {
    *reason = "observation_stale";
    return false;
  }
  // The focused element's signature is read whatever its classification says, as before #820: a live
  // focus that is only unclassified (deeper than the climb, say) keeps its signature, so its key / type
  // is refused later as target_unclassified, not as a focus that moved. After a timeout or a Cancel in
  // this observe the read is refused by the path without a call (no second wait on the element).
  std::string focused_element_signature;
  const bool has_focused_element_signature =
      WindowsFocusedElementSignature(session.pid, bounds, &focused_element_signature);
  if (!WindowsValidationStillCurrent(session.cancel_epoch, observe_stop_serial)) {
    *reason = "observation_stale";
    return false;
  }
  RECT screen_bounds{};
  if (!ScreenBoundsPhysicalForWindow(dialogs.active_window, &screen_bounds)) {
    *reason = "screen_geometry_unavailable";
    return false;
  }
  std::size_t width = 0;
  std::size_t height = 0;
  WindowsV1UiaStop capture_stop = WindowsV1UiaStop::kNone;
  if (!CaptureWindowWithGraphicsCapture(dialogs.active_window, session.cancel_epoch,
                                        observe_stop_serial, binary, &width, &height,
                                        &capture_stop)) {
    *reason = WindowsV1ObserveReason(capture_stop, "graphics_capture_unavailable");
    return false;
  }
  RECT stable_bounds{};
  WindowsDialogSetSnapshot stable_dialogs;
  if (!ValidateWindowsSession(session, &stable_bounds, reason,
                              &stable_dialogs) ||
      session.cancel_epoch !=
          cancellation_epoch.load(std::memory_order_acquire) ||
      stable_dialogs.digest != dialogs.digest ||
      stable_dialogs.active_window != dialogs.active_window ||
      stable_dialogs.active_identity != dialogs.active_identity ||
      stable_dialogs.active_kind != dialogs.active_kind ||
      stable_bounds.left != bounds.left || stable_bounds.top != bounds.top ||
      stable_bounds.right != bounds.right ||
      stable_bounds.bottom != bounds.bottom) {
    binary->clear();
    if (reason->empty())
      *reason = "observation_stale";
    return false;
  }
  const std::size_t screenshot_bytes = binary->size();
  const std::size_t tree_bytes = tree.size();
  if (screenshot_bytes == 0 || screenshot_bytes > 8 * 1024 * 1024 ||
      tree_bytes == 0 || tree_bytes > 512 * 1024 ||
      screenshot_bytes + tree_bytes > kMaxBinaryBytes) {
    binary->clear();
    *reason = "observation_payload_oversized";
    return false;
  }
  std::vector<std::string> patch_digests;
  std::size_t patch_columns = 0;
  std::size_t patch_rows = 0;
  WindowsV1UiaStop png_stop = WindowsV1UiaStop::kNone;
  if (!ReadWindowsPngPatchGrid(binary, width, height, session.cancel_epoch,
                              observe_stop_serial, &patch_digests, &patch_columns,
                              &patch_rows, &png_stop)) {
    binary->clear();
    *reason = WindowsV1ObserveReason(png_stop, "visual_binding_unavailable");
    return false;
  }
  std::vector<std::uint8_t> staged_binary;
  staged_binary.swap(*binary);
  struct StagedBytes {
    std::vector<std::uint8_t> &bytes;
    ~StagedBytes() { std::fill(bytes.begin(), bytes.end(), 0); }
  } staged_bytes{staged_binary};
  staged_binary.reserve(screenshot_bytes + tree_bytes);
  staged_binary.insert(staged_binary.end(), tree.begin(), tree.end());
  const auto next_revision = session.observation_revision + 1;
  const auto next_dialog_revision = session.dialog_set_revision +
      (session.dialog_set_digest != dialogs.digest ? 1 : 0);
  const auto window_value =
      static_cast<std::uint64_t>(reinterpret_cast<UINT_PTR>(session.window));
  std::string staged_response =
      "{\"result\":\"completed\",\"pid\":" + std::to_string(session.pid) +
      ",\"windowId\":\"" + std::to_string(window_value) +
      "\",\"captureWidth\":" + std::to_string(width) +
      ",\"captureHeight\":" + std::to_string(height) +
      ",\"revision\":" + std::to_string(next_revision) +
      ",\"screenshotMimeType\":\"image/png\",\"screenshotBytes\":" +
      std::to_string(screenshot_bytes) +
      ",\"treeBytes\":" + std::to_string(tree_bytes) +
      ",\"treeNodeCount\":" + std::to_string(nodes) +
      ",\"dialogSetRevision\":" +
      std::to_string(next_dialog_revision) +
      ",\"dialogSetDigest\":\"" + dialogs.digest +
      "\",\"activeWindowIdentityDigest\":\"" +
      dialogs.active_identity + "\",\"activeWindowKind\":\"" +
      dialogs.active_kind + "\"" +
      ",\"policyLanguage\":\"" + session.policy_language + "\"" +
      ",\"maximumMode\":\"" + session.maximum_mode +
      "\",\"screenBounds\":" + RectJson(screen_bounds) +
      ",\"focusedElementSignature\":" +
      (has_focused_element_signature
           ? "\"" + focused_element_signature + "\""
           : "null") +
      ",\"focusedElementSecure\":" + (focused_risk.secure ? "true" : "false") +
      ",\"focusedElementHighImpact\":" +
      (focused_risk.high_impact ? "true" : "false") + "}";
  static_assert(std::is_nothrow_swappable_v<std::string> &&
      std::is_nothrow_swappable_v<decltype(session.observation_patch_digests)> &&
      std::is_nothrow_swappable_v<decltype(session.semantic_control_signatures)> &&
      std::is_nothrow_swappable_v<decltype(session.visual_control_signatures)>);
  const char *commit_failure = nullptr;
  {
    // The consumer owns Session state. Reader Stop and parent-death latches use this same lock.
    // All payload preparation and allocating work precede this publication boundary.
    std::lock_guard stop_lock(WindowsTargetListControl().stop_mutex);
    if (!WindowsValidationStillCurrent(session.cancel_epoch, observe_stop_serial)) {
      commit_failure = "observation_stale";
    }
    else if (windows_v1_uia_lane != nullptr && windows_v1_uia_lane->has_deadline &&
        std::chrono::steady_clock::now() > windows_v1_uia_lane->deadline) {
      commit_failure = "observation_timeout";
    }
    if (commit_failure == nullptr) {
      session.dialog_set_revision = next_dialog_revision;
      session.observation_revision = next_revision;
      session.active_window = dialogs.active_window;
      session.active_window_identity.swap(dialogs.active_identity);
      session.active_window_kind.swap(dialogs.active_kind);
      session.dialog_set_digest.swap(dialogs.digest);
      session.observation_bounds = bounds;
      session.observation_capture_width = width;
      session.observation_capture_height = height;
      session.observation_patch_columns = patch_columns;
      session.observation_patch_rows = patch_rows;
      session.observation_patch_digests.swap(patch_digests);
      session.focused_element_signature.swap(focused_element_signature);
      session.has_focused_element_signature = has_focused_element_signature;
      session.semantic_control_signatures.swap(stable_bindings.semantic);
      session.visual_control_signatures.swap(stable_bindings.visual);
      session.has_observation = true;
      response->swap(staged_response);
      binary->swap(staged_binary);
    }
  }
  for (auto &digest : patch_digests) std::fill(digest.begin(), digest.end(), '0');
  if (commit_failure != nullptr) { *reason = commit_failure; return false; }
  reason->clear();
  return true;
}

// BEGIN artifact read (#785 T15-4w)
// The value of ONE node, for `copy`. Like the interlock entry it runs on a worker of its own in the
// multithreaded apartment while the lane waits at most kInterlockLaneHoldLimit, with the same
// single-flight slot (at most one stuck worker in the process); the worker gets everything by value.
// The node is resolved as the semantic actions resolve it (the V1 search by target id, the signature
// the observation recorded, the V1 risk of the element); the facts and the value then come from the
// shadow's source and reader (portable: ReadWindowsArtifactValue), which also judges the role, the
// secure / high-impact / surface facts and the browser window (the judgement lives in that header).
// Any way of not reading is the same "not read". The value is never cached by the helper (the answer
// goes out with Respond, not RespondAndCache) and the copy of it is scrubbed after it is sent.
// Reads only: no input API, no pattern is invoked, nothing is set.
struct ArtifactReadPending {
  // Whatever value is still here when the last owner lets go (the lane gave up, or never took it)
  // is overwritten first.
  ~ArtifactReadPending() { ScrubString(&text); }
  std::mutex mutex;
  std::condition_variable ready;
  bool done = false;
  std::atomic<bool> abandoned{false};
  bool ok = false;
  std::string text;
};

bool ReadWindowsNodeValueOnLane(const WindowsSession &session, const std::string &metadata,
                                std::string *text) noexcept {
  using namespace sprint_coder::computer_use;
  try {
    std::string kind;
    RECT bounds{};
    std::string reason;
    if (!ValidateWindowsDispatchBinding(session, metadata, &kind, &bounds, &reason) || kind != "copy")
      return false;
    std::string target_id;
    if (!ReadJsonString(metadata, "targetId", &target_id) || target_id.empty() || target_id.size() > 128)
      return false;
    const auto observed = session.semantic_control_signatures.find(target_id);
    if (observed == session.semantic_control_signatures.end()) return false;
    const std::uint64_t expected_epoch = session.cancel_epoch;
    auto pending = std::make_shared<ArtifactReadPending>();
    const WindowsSession copy = session;
    const std::string signature = observed->second;
    std::atomic<bool> &running = InterlockWorkerRunning();
    if (running.exchange(true)) return false;
    try {
      std::thread([pending, copy, target_id, signature, expected_epoch, &running]() {
        bool ok = false;
        std::string value;
        try {
          struct ComApartment {
            HRESULT initialized = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
            ~ComApartment() {
              if (SUCCEEDED(initialized)) CoUninitialize();
            }
          } apartment;
          const auto still_valid = [pending, expected_epoch]() {
            return !pending->abandoned.load(std::memory_order_acquire) &&
                   cancellation_epoch.load(std::memory_order_acquire) == expected_epoch;
          };
          // The V1 resolution (search, signature, risk) and the signature the read checks run on
          // this worker inside ONE bounded V1 path (#820), with the epoch of the request: the first
          // timed-out call ends them all and a Cancel stops them before the next call. Outside a path
          // the V1 calls are refused, so without it no node could be read. The path's budget is the
          // lane's wait: once the lane has given up (abandoned), the walk ends at its next call
          // instead of holding the single-flight slot, which the interlock entry shares, for as long
          // as a large tree takes.
          const WindowsV1UiaPath uia_path(kInterlockLaneHoldLimit, expected_epoch);
          sprint_coder::computer_use::windows_uia_source_detail::ComRef<IUIAutomationElement> target_owner;
          IUIAutomationElement *&target = *target_owner.Receive();
          std::string why;
          if (FindWindowsSemanticTarget(copy.active_window, target_id, &target, &why)) {
            std::string current;
            const bool same_control =
                ComputeWindowsControlSignature(target, copy.pid, nullptr, &current) && current == signature;
            // The V1 risk of the element, as for every semantic action: a secure or high-impact
            // element is never read, whatever else says.
            const bool risky = RejectWindowsRisk(ClassifyWindowsUiaElement(target), &why);
            target_owner.Reset();
            if (same_control && !risky) {
              std::unique_ptr<WindowsUiaShadowSource> source = WindowsUiaShadowSource::Create(
                  copy.active_window, POINT{0, 0}, still_valid,
                  WindowsUiaShadowSource::kInterlockUiaTimeoutMs,
                  windows_uia_source_detail::InterlockShellLookupRunning());
              if (source != nullptr) {
                // The element the read finds is checked against the observed signature (runtime id
                // included), the same function the observation and the semantic actions use.
                const std::uint32_t pid = copy.pid;
                source->SetSignatureProvider([pid](IUIAutomationElement *element, std::string *out) {
                  return ComputeWindowsControlSignature(element, pid, nullptr, out);
                });
                ShadowRequestInfo info;
                info.policy_language = copy.policy_language;
                info.maximum_mode = "full_access_app";
                WindowsArtifactReadResult result = ReadWindowsArtifactValue(*source, target_id, info, signature);
                ok = result.ok;
                value = std::move(result.text);
              }
            }
          }
        } catch (...) {
          ok = false;
          value.clear();
        }
        {
          std::lock_guard<std::mutex> lock(pending->mutex);
          // The lane sets `abandoned` while it holds this lock, so this look is not a race: a value
          // that arrives after the lane gave up is overwritten here and never stored.
          if (pending->abandoned.load(std::memory_order_acquire)) {
            ScrubString(&value);
            value.clear();
            ok = false;
          }
          pending->ok = ok;
          pending->text = std::move(value);
          pending->done = true;
        }
        running.store(false);
        pending->ready.notify_one();
      }).detach();
    } catch (...) {
      running.store(false);
      return false;
    }
    {
      std::unique_lock<std::mutex> lock(pending->mutex);
      if (!pending->ready.wait_for(lock, kInterlockLaneHoldLimit, [&pending] { return pending->done; })) {
        pending->abandoned.store(true, std::memory_order_release);
        return false;
      }
      if (!pending->ok) return false;
      *text = pending->text;
      ScrubString(&pending->text);
    }
    // The action was canceled or the window changed while the worker read: no value.
    if (cancellation_epoch.load(std::memory_order_acquire) != expected_epoch ||
        !RevalidateWindowsTarget(session, bounds, expected_epoch) || text->empty() ||
        text->size() > kArtifactReadMaxBytes) {
      ScrubString(text);
      text->clear();
      return false;
    }
    return true;
  } catch (...) {
    ScrubString(text);
    text->clear();
    return false;
  }
}
// END artifact read

bool HandlePipeRequest(HANDLE pipe, const BackendProbe &probe,
                       const Frame &request, bool *handshaken,
                       std::optional<std::uint64_t> queued_stop_serial = std::nullopt,
                       std::shared_ptr<WindowsStartLease> start_lease = nullptr,
                       const std::string& admission_error = {},
                       WindowsDiscoveryAdmission discovery = {},
                       WindowsDiscoveryStopPump* discovery_stop_pump = nullptr) {
  const auto type = static_cast<MessageType>(request.header.message_type);
  if (!IsBoundedUtf8(request.metadata) || !request.binary.empty())
    return false;
  const std::string metadata(
      reinterpret_cast<const char *>(request.metadata.data()),
      request.metadata.size());
  if (!*handshaken && type != MessageType::kHandshake) {
    Respond(pipe, request, MessageType::kError,
            ErrorPayload("HANDSHAKE_REQUIRED"));
    return false;
  }
  if (!admission_error.empty() && type != MessageType::kHandshake)
    return Respond(pipe, request, MessageType::kError, ErrorPayload(admission_error));
  if (type != MessageType::kHandshake) {
    bool replayed = false;
    if (!ReplayCachedResponse(pipe, request, &replayed))
      return false;
    if (replayed)
      return true;
  }
  const WindowsValidationFrameScope validation_frame(queued_stop_serial);
  switch (type) {
  case MessageType::kHandshake: {
    std::uint64_t protocol_version = 0;
    std::uint64_t api_version = 0;
    if (!ReadJsonUint64(metadata, "protocolVersion", &protocol_version) ||
        !ReadJsonUint64(metadata, "apiVersion", &api_version) ||
        protocol_version != kProtocolVersion || api_version != kApiVersion)
      return Respond(pipe, request, MessageType::kError,
                     ErrorPayload("HANDSHAKE_MISMATCH"));
    *handshaken = true;
    if (!Respond(pipe, request, MessageType::kHandshakeResult,
                 ProbeJson(probe)))
      return false;
    break;
  }
  case MessageType::kProbe: {
    std::string operation;
    if (!ReadJsonString(metadata, "operation", &operation))
      operation = "probe";
    if (operation == "read_node_value") {
      // The value of one node for copy (#785 T15-4w): its own answer, never cached.
      WindowsSession *session = FindWindowsSession(request);
      std::string text;
      const bool read = session != nullptr && ReadWindowsNodeValueOnLane(*session, metadata, &text);
      std::string payload = read ? "{\"ok\":true,\"text\":\"" + JsonEscape(text) + "\"}" : "{\"ok\":false}";
      const bool sent = Respond(pipe, request, MessageType::kProbeResult, payload);
      ScrubString(&text);
      ScrubString(&payload);
      if (!sent) return false;
      break;
    }
    std::string response;
    std::string reason;
    bool succeeded = false;
    if (operation == "probe") {
      response = ProbeJson(probe);
      succeeded = true;
    } else if (operation == "pick_application") {
      succeeded = PickWindowsExecutable(&response, &reason);
    } else if (operation == "list_windows_cancellable") {
      if (discovery.not_admitted) {
        WindowsDiscoveryParameters parsed;
        if (ReadWindowsDiscoveryQuery(metadata, &parsed)) {
          response = WindowsDiscoveryReceiptJson(parsed.id, "not_admitted", 0);
          response.pop_back();
          response += ",\"reason\":\"discovery_capacity\"}";
          succeeded = true;
        } else reason = "discovery_input_invalid";
      } else if (discovery.replay_only) {
        reason = "discovery_id_reuse";
      } else {
        succeeded = RunWindowsDiscovery(metadata, std::move(discovery.lease),
            queued_stop_serial.value_or(WindowsTargetListControl().stop_serial.load()),
            &response, &reason, discovery_stop_pump);
        if (discovery_stop_pump != nullptr && discovery_stop_pump->failed) return false;
      }
    } else if (operation == "stop_window_discovery") {
      succeeded = StopWindowsDiscovery(FrameIdKey(request.header.session_id), metadata,
                                       discovery.lease, &response, &reason);
    } else if (operation == "list_targets") {
      // S5-c-3 PR-5: unsupported_operation in a v1 build.
      succeeded = ListWindowsTargets(&response, &reason, queued_stop_serial);
    } else if (operation == "start_session") {
      if (!admission_error.empty()) reason = admission_error;
      else succeeded = StartWindowsSession(request, metadata, &response, &reason, queued_stop_serial, std::move(start_lease));
    } else if (operation == "stop_pending_start") {
      succeeded = StopPendingWindowsStart(request, metadata, &response, &reason);
    } else if (operation == "close_session") {
      succeeded = CloseWindowsSession(request, metadata, &response, &reason);
      if (!succeeded && reason.empty()) reason = "native_close_unconfirmed";
    } else {
      reason = "unsupported_operation";
    }
    if (!succeeded && reason == "semantic_input_in_flight") {
      if (!Respond(pipe, request, MessageType::kError, ErrorPayload(reason))) return false;
      break;
    }
    if (!RespondAndCache(
            pipe, request,
            succeeded ? MessageType::kProbeResult : MessageType::kError,
            succeeded ? std::move(response) : ErrorPayload(reason)))
      return false;
    break;
  }
  case MessageType::kCancel: {
    WindowsSession *session = FindWindowsSession(request);
    std::uint64_t requested_epoch = 0;
    if (session == nullptr ||
        !ReadJsonUint64(metadata, "cancelEpoch", &requested_epoch) ||
        requested_epoch <= session->cancel_epoch) {
      if (!RespondAndCache(pipe, request, MessageType::kError,
                           ErrorPayload("invalid_cancel")))
        return false;
      break;
    }
    std::uint64_t attempts = 0;
    if (!StopWindowsSemanticInput(*session, &attempts)) {
      if (!Respond(pipe, request, MessageType::kError, ErrorPayload("semantic_input_in_flight"))) return false;
      break;
    }
    session->cancel_epoch = requested_epoch;
    InvalidateWindowsTicket(FrameIdKey(request.header.session_id));
    std::uint64_t current = cancellation_epoch.load(std::memory_order_acquire);
    while (requested_epoch > current &&
           !cancellation_epoch.compare_exchange_weak(
               current, requested_epoch, std::memory_order_acq_rel,
               std::memory_order_acquire)) {
    }
    // Cancellation is acknowledged idempotently. Any in-flight atomic input
    // checks the epoch before its next unit and stops; no retry is generated by
    // the native helper.
    if (!RespondAndCache(pipe, request, MessageType::kDispatchResult,
                         "{\"result\":\"canceled\",\"drained\":true,\"sessionId\":\"" +
                             JsonEscape(session->session_id) + "\",\"cancelEpoch\":" +
                             std::to_string(requested_epoch) + ",\"inputAttemptCount\":" +
                             std::to_string(attempts) + "}"))
      return false;
    break;
  }
  case MessageType::kObserve: {
    WindowsSession *session = FindWindowsSession(request);
    if (session == nullptr) {
      if (!RespondAndCache(pipe, request, MessageType::kError,
                           ErrorPayload("session_missing")))
        return false;
      break;
    }
    // A new observation changes what a ticket was measured against, as on macOS.
    InvalidateWindowsTicket(FrameIdKey(request.header.session_id));
    std::string response;
    std::vector<std::uint8_t> binary;
    std::string reason;
    const bool succeeded =
        ObserveWindowsWindow(*session, &response, &binary, &reason, queued_stop_serial);
    if (!RespondAndCache(
            pipe, request,
            succeeded ? MessageType::kObserveResult : MessageType::kError,
            succeeded ? std::move(response) : ErrorPayload(reason),
            succeeded ? std::move(binary) : std::vector<std::uint8_t>{})) {
      return false;
    }
    break;
  }
  case MessageType::kPreflight: {
    // One path for the whole frame: the first timed-out UI Automation call of any of its steps ends all
    // the later ones, and a Cancel ends them too (the inner paths share this state).
    const WindowsV1UiaPath preflight_uia_path;
    if (!HandleWindowsPreflight(pipe, request, metadata)) return false;
    break;
  }
  case MessageType::kDispatch: {
    WindowsSession *session = FindWindowsSession(request);
    if (session == nullptr) {
      if (!RespondAndCache(pipe, request, MessageType::kError,
                           ErrorPayload("session_missing")))
        return false;
      break;
    }
    // A ticket is required for every input. This sits after the replay answer above, so a repeat of
    // a finished request still gets its cached result, and it is not cached itself, so the same
    // request id can be tried again with a ticket.
    if (!ConsumeWindowsDispatchTicket(FrameIdKey(request.header.session_id),
                                      *session, metadata)) {
      if (!Respond(pipe, request, MessageType::kError,
                   ErrorPayload("ticket_invalid")))
        return false;
      break;
    }
    std::string result;
    std::string reason;
    bool accepted = false;
    // One path for the whole dispatch (the interlock, the classification, the signatures, the
    // re-validation): the first timed-out UI Automation call ends all the later ones, and a Cancel ends
    // them too (the inner paths share this state).
    const WindowsV1UiaPath dispatch_uia_path;
    const bool succeeded =
        DispatchWindowsAction(*session, metadata, &result, &reason, &accepted);
    if (!RespondAndCache(
            pipe, request,
            succeeded ? MessageType::kDispatchResult : MessageType::kError,
            succeeded ? "{\"result\":\"completed\",\"reasonCode\":null,\"sessionId\":\"" +
                            JsonEscape(session->session_id) + "\",\"cancelEpoch\":" +
                            std::to_string(session->cancel_epoch) + ",\"inputAttemptCount\":" +
                            std::to_string(session->input_api_attempts->load(std::memory_order_acquire)) + "}"
                      : ErrorPayload(reason, accepted))) {
      return false;
    }
    break;
  }
  default:
    if (!RespondAndCache(pipe, request, MessageType::kError,
                         ErrorPayload("UNSUPPORTED_MESSAGE")))
      return false;
    break;
  }
  return true;
}

bool ServePipe(HANDLE pipe, const BackendProbe &probe) {
  constexpr std::size_t kMaximumQueuedFrames = 64;
  std::mutex queue_mutex;
  std::condition_variable queue_ready;
  struct QueuedFrame {
    Frame frame;
    std::uint64_t stop_serial = 0;
    std::shared_ptr<WindowsStartLease> start_lease;
    std::string admission_error;
    std::shared_ptr<WindowsWireLease> wire_lease;
    WindowsDiscoveryAdmission discovery;
    bool discovery_stop = false;
  };
  std::deque<QueuedFrame> queue;
  bool reader_finished = false;
  bool reader_valid = true;
  std::thread reader([&]() {
    bool reader_handshaken = false;
    Frame request;
    while (ReadFrame(pipe, &request)) {
      if (!IsBoundedUtf8(request.metadata) || !request.binary.empty()) {
        reader_valid = false;
        break;
      }
      const std::string metadata(reinterpret_cast<const char *>(request.metadata.data()),
                                 request.metadata.size());
      std::string operation;
      const auto type = static_cast<MessageType>(request.header.message_type);
      const bool has_operation = type == MessageType::kProbe && ReadJsonString(metadata, "operation", &operation);
      const bool close = has_operation && operation == "close_session";
      const bool pending_stop = has_operation && operation == "stop_pending_start";
      std::shared_ptr<WindowsStartLease> start_lease;
      std::string admission_error;
      WindowsDiscoveryAdmission discovery;
      // This is the same side-effect-free version check used by the consumer. The verified pipe
      // peer may pipeline frames, but cannot obtain an owner before a valid handshake frame.
      if (type == MessageType::kHandshake) {
        std::uint64_t protocol = 0, api = 0;
        if (ReadJsonUint64(metadata, "protocolVersion", &protocol) &&
            ReadJsonUint64(metadata, "apiVersion", &api) && protocol == kProtocolVersion && api == kApiVersion)
          reader_handshaken = true;
      }
      bool fresh_request = false;
      std::shared_ptr<WindowsWireLease> wire_lease;
      if (type != MessageType::kHandshake && reader_handshaken)
        wire_lease = RegisterWindowsWireRequest(ResponseCacheKey(request), RequestPayloadDigest(request),
            &fresh_request, &admission_error);
      if (has_operation && operation == "start_session" && reader_handshaken && admission_error.empty()) {
        WindowsStartParameters parsed;
        if (!ParseWindowsStartParameters(metadata, &parsed)) admission_error = "session_input_invalid";
        else start_lease = AdmitWindowsStart(FrameIdKey(request.header.session_id), parsed.session_id,
            ResponseCacheKey(request), RequestPayloadDigest(request), &admission_error, parsed.cancel_epoch);
      }
      if (has_operation && reader_handshaken && admission_error.empty()) {
        if (operation == "list_windows_cancellable") {
          WindowsDiscoveryParameters parsed;
          if (!ReadWindowsDiscoveryQuery(metadata, &parsed)) admission_error = "discovery_input_invalid";
          else discovery = AdmitWindowsDiscovery(FrameIdKey(request.header.session_id), parsed.id,
              ResponseCacheKey(request), RequestPayloadDigest(request), fresh_request, GetTickCount64(),
              &admission_error);
        } else if (operation == "stop_window_discovery") {
          std::string id;
          if (!ReadWindowsDiscoveryStop(metadata, &id)) admission_error = "discovery_input_invalid";
          else discovery.lease = ReferenceWindowsDiscoveryStop(FrameIdKey(request.header.session_id), id,
                                                               fresh_request);
        }
      }
      if (type == MessageType::kCancel || close || pending_stop) {
        const bool new_cancel = fresh_request && admission_error.empty();
        std::uint64_t requested_epoch = 0;
        if (new_cancel && pending_stop && reader_handshaken) {
          std::string id;
          if (ReadPendingWindowsStop(metadata, &id))
            LatchWindowsPendingStop(FrameIdKey(request.header.session_id), id);
        } else if (new_cancel && !pending_stop &&
            ReadJsonUint64(metadata, "cancelEpoch", &requested_epoch)) {
          auto &control = WindowsTargetListControl();
          std::lock_guard stop_lock(control.stop_mutex);
          // A new Close must stop discovery even when its epoch equals the current input epoch.
          control.stop_serial.fetch_add(1, std::memory_order_acq_rel);
          control.context_candidate.reset();
          // Close invalidates discovery here, but only its consumer owns session epochs. A retry
          // for an already-closed session must not cancel another session or raise the input epoch
          // beyond last_closed_cancel_epoch and prevent a fresh epoch-zero start.
          if (type == MessageType::kCancel) {
            std::uint64_t current =
                cancellation_epoch.load(std::memory_order_acquire);
            while (requested_epoch > current &&
                   !cancellation_epoch.compare_exchange_weak(
                       current, requested_epoch, std::memory_order_acq_rel,
                       std::memory_order_acquire)) {
            }
          }
        }
      }
      {
        std::lock_guard lock(queue_mutex);
        if (queue.size() >= kMaximumQueuedFrames) {
          reader_valid = false;
          break;
        }
        queue.push_back(QueuedFrame{std::move(request),
            WindowsTargetListControl().stop_serial.load(std::memory_order_acquire),
            std::move(start_lease), std::move(admission_error), std::move(wire_lease),
            std::move(discovery), has_operation && operation == "stop_window_discovery"});
      }
      queue_ready.notify_one();
      request = {};
    }
    StopWindowsDiscoveriesForPipeEnd();
    {
      std::lock_guard lock(queue_mutex);
      reader_finished = true;
    }
    queue_ready.notify_one();
  });

  bool handshaken = false;
  bool served = true;
  WindowsDiscoveryStopPump discovery_stop_pump{[&](const std::string& waiting_owner) {
    // Bound each pass even if the reader keeps receiving Stops. Do not run another query or input.
    for (std::size_t count = 0; count < kMaximumQueuedFrames; ++count) {
      QueuedFrame stopped;
      {
        std::lock_guard lock(queue_mutex);
        const auto next = std::find_if(queue.begin(), queue.end(),
            [&](const auto& queued) {
              // This owner's Stop already breaks its wait; keep its usual query/receipt ordering.
              return queued.discovery_stop && FrameIdKey(queued.frame.header.session_id) != waiting_owner;
            });
        if (next == queue.end()) return true;
        stopped = std::move(*next);
        queue.erase(next);
      }
      if (!HandlePipeRequest(pipe, probe, stopped.frame, &handshaken, stopped.stop_serial,
                             std::move(stopped.start_lease), stopped.admission_error,
                             std::move(stopped.discovery))) return false;
    }
    return true;
  }};
  for (;;) {
    QueuedFrame queued;
    {
      std::unique_lock lock(queue_mutex);
      queue_ready.wait(lock,
                       [&]() { return reader_finished || !queue.empty(); });
      if (queue.empty())
        break;
      queued = std::move(queue.front());
      queue.pop_front();
    }
    if (!HandlePipeRequest(pipe, probe, queued.frame, &handshaken, queued.stop_serial,
                           std::move(queued.start_lease), queued.admission_error,
                           std::move(queued.discovery), &discovery_stop_pump)) {
      served = false;
      CancelIoEx(pipe, nullptr);
      break;
    }
  }
  if (reader.joinable())
    reader.join();
  return served && reader_valid;
}

bool ParseUnsigned(std::wstring_view value, DWORD *output) {
  if (value.empty() || value.size() > 10)
    return false;
  DWORD parsed = 0;
  for (const wchar_t character : value) {
    if (character < L'0' || character > L'9')
      return false;
    const auto digit = static_cast<DWORD>(character - L'0');
    if (parsed > (std::numeric_limits<DWORD>::max() - digit) / 10)
      return false;
    parsed = parsed * 10 + digit;
  }
  *output = parsed;
  return parsed > 0;
}

bool ConfigurePerMonitorDpiAwareness() {
  if (SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2))
    return true;
  return GetAwarenessFromDpiAwarenessContext(GetThreadDpiAwarenessContext()) ==
         DPI_AWARENESS_PER_MONITOR_AWARE;
}

bool IsActualParentProcess(DWORD expected_parent_pid) {
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE)
    return false;
  PROCESSENTRY32W entry{};
  entry.dwSize = sizeof(entry);
  bool matches = false;
  if (Process32FirstW(snapshot, &entry)) {
    do {
      if (entry.th32ProcessID == GetCurrentProcessId()) {
        matches = entry.th32ParentProcessID == expected_parent_pid;
        break;
      }
    } while (Process32NextW(snapshot, &entry));
  }
  CloseHandle(snapshot);
  return matches;
}

bool BuildCurrentUserPipeSecurity(SECURITY_ATTRIBUTES *security,
                                  PSECURITY_DESCRIPTOR *descriptor) {
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token))
    return false;
  DWORD token_bytes = 0;
  GetTokenInformation(token, TokenUser, nullptr, 0, &token_bytes);
  std::vector<std::uint8_t> token_buffer(token_bytes);
  const bool read = token_bytes >= sizeof(TOKEN_USER) &&
                    GetTokenInformation(token, TokenUser, token_buffer.data(),
                                        token_bytes, &token_bytes) == TRUE;
  CloseHandle(token);
  if (!read)
    return false;
  const auto *token_user =
      reinterpret_cast<const TOKEN_USER *>(token_buffer.data());
  LPWSTR sid_text = nullptr;
  if (!ConvertSidToStringSidW(token_user->User.Sid, &sid_text) ||
      sid_text == nullptr)
    return false;
  const std::wstring sddl =
      L"D:P(A;;GA;;;SY)(A;;GA;;;" + std::wstring(sid_text) + L")";
  LocalFree(sid_text);
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
          sddl.c_str(), SDDL_REVISION_1, descriptor, nullptr) ||
      *descriptor == nullptr)
    return false;
  security->nLength = sizeof(*security);
  security->lpSecurityDescriptor = *descriptor;
  security->bInheritHandle = FALSE;
  return true;
}

int ProbeMain() {
  HRESULT initialized = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  const BackendProbe probe = ProbeBackend();
  std::cout << ProbeJson(probe);
  if (SUCCEEDED(initialized))
    CoUninitialize();
  return 0;
}

int ServeMain(const std::wstring &pipe_name, DWORD parent_pid) {
  if (pipe_name.size() < 10 || pipe_name.size() > 240 ||
      pipe_name.rfind(L"\\\\.\\pipe\\sprint-coder-computer-use-", 0) != 0)
    return 2;
  if (parent_pid == 0 || !IsActualParentProcess(parent_pid))
    return 2;
  HANDLE parent = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                              FALSE, parent_pid);
  if (parent == nullptr)
    return 3;

  // Keep DLL resolution on the system directory/application directory.  Loading
  // from the current directory or PATH would defeat the packaged-helper digest
  // boundary.
  using SetDefaultDllDirectoriesFn = BOOL(WINAPI *)(DWORD);
  const auto kernel32 = GetModuleHandleW(L"kernel32.dll");
  const auto set_dll_directories =
      kernel32 == nullptr
          ? nullptr
          : reinterpret_cast<SetDefaultDllDirectoriesFn>(
                GetProcAddress(kernel32, "SetDefaultDllDirectories"));
  if (set_dll_directories == nullptr ||
      !set_dll_directories(LOAD_LIBRARY_SEARCH_SYSTEM32 |
                           LOAD_LIBRARY_SEARCH_APPLICATION_DIR)) {
    CloseHandle(parent);
    return 4;
  }

  SECURITY_ATTRIBUTES security{};
  PSECURITY_DESCRIPTOR security_descriptor = nullptr;
  if (!BuildCurrentUserPipeSecurity(&security, &security_descriptor)) {
    CloseHandle(parent);
    return 5;
  }
  // ServePipe reads the next request on one thread while another writes the current response.
  // A synchronous handle serializes those operations: the pending read can block the response
  // until another request arrives. Each overlapped operation owns its own completion event.
  HANDLE pipe = CreateNamedPipeW(
      pipe_name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
      1, 64 * 1024, 64 * 1024, 0, &security);
  LocalFree(security_descriptor);
  if (pipe == INVALID_HANDLE_VALUE) {
    CloseHandle(parent);
    return 6;
  }

  const HRESULT initialized = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  if (FAILED(initialized)) {
    CloseHandle(pipe);
    CloseHandle(parent);
    return 7;
  }
  const BackendProbe probe = ProbeBackend();
  WarmWindowsV1Automation();
  ScopedKernelHandle connected_event(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  OVERLAPPED connection{};
  connection.hEvent = connected_event.value;
  BOOL connected = FALSE;
  if (connected_event.value != nullptr) {
    connected = ConnectNamedPipe(pipe, &connection);
    if (!connected) {
      const DWORD error = GetLastError();
      DWORD transferred = 0;
      connected = error == ERROR_PIPE_CONNECTED ||
                  (error == ERROR_IO_PENDING &&
                   GetOverlappedResult(pipe, &connection, &transferred, TRUE));
    }
  }
  ULONG client_pid = 0;
  const bool authenticated_client =
      connected == TRUE &&
      GetNamedPipeClientProcessId(pipe, &client_pid) == TRUE &&
      client_pid == parent_pid;
  std::atomic<bool> serving{authenticated_client};
  std::thread parent_watcher;
  if (authenticated_client) {
    // The lineage root of the v2 facts (W8): Main, the parent this helper verified and the one client
    // its pipe accepted, fixed before the first request (the facts context reads it once, then).
    windows_v2_main_pid = static_cast<std::uint32_t>(client_pid);
    parent_watcher = std::thread([parent, pipe, &serving]() {
      while (serving.load(std::memory_order_acquire)) {
        if (WaitForSingleObject(parent, 100) == WAIT_OBJECT_0) {
          {
            std::lock_guard stop_lock(WindowsTargetListControl().stop_mutex);
            parent_process_dead.store(true, std::memory_order_release);
            cancellation_epoch.fetch_add(1, std::memory_order_acq_rel);
          }
          CancelIoEx(pipe, nullptr);
          DisconnectNamedPipe(pipe);
          break;
        }
      }
    });
    ServePipe(pipe, probe);
    serving.store(false, std::memory_order_release);
  }
  if (parent_watcher.joinable())
    parent_watcher.join();
  DisconnectNamedPipe(pipe);
  for (auto &entry : sessions)
    ReleaseWindowsSessionResources(&entry.second);
  sessions.clear();
  DrainWindowsSemanticInputForExit();
  DrainWindowsDiscoveryLaunchesForExit();
  if (SUCCEEDED(initialized))
    CoUninitialize();
  CloseHandle(pipe);
  CloseHandle(parent);
  return 0;
}

} // namespace

int wmain(int argc, wchar_t **argv) {
  if (!ConfigurePerMonitorDpiAwareness())
    return 8;
  if (argc == 2 && std::wstring_view(argv[1]) == L"--probe-json")
    return ProbeMain();
  if (argc != 5 || std::wstring_view(argv[1]) != L"--pipe" ||
      std::wstring_view(argv[3]) != L"--parent-pid")
    return 1;
  DWORD parent_pid = 0;
  if (!ParseUnsigned(argv[4], &parent_pid))
    return 1;
  return ServeMain(argv[2], parent_pid);
}
