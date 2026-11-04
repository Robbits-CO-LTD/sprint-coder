// Native seam: compile with /std:c++20 /EHsc and user32.lib. No real hooks or GUI input.
#include <windows.h>
#include <chrono>
#include <condition_variable>
#include <iostream>
#include <memory>
#include <string>
#include <thread>
#include <unordered_map>
#include <atomic>
#include "computer_use_protocol.h"
inline DWORD TestEventTick() { return 1000; }
#define GetTickCount TestEventTick
#include "computer_use_windows_background_monitor_test.h"

namespace {
struct WindowsBackgroundMonitor;
struct WindowsSession {
  sprint_coder::computer_use::InputSession input_session;
  std::shared_ptr<WindowsBackgroundMonitor> background_monitor;
};
struct Window { DWORD pid; HWND root; HWND owner = nullptr; };
std::unordered_map<HWND, Window> windows;
HWND foreground = nullptr, hit = nullptr, capture = nullptr;
bool capture_readable = true;
HWND Id(std::uintptr_t id) { return reinterpret_cast<HWND>(id); }
DWORD TestWindowThread(HWND hwnd, DWORD *pid) {
  const auto found = windows.find(hwnd);
  if (found == windows.end()) return 0;
  if (pid) *pid = found->second.pid;
  return found->second.pid;
}
HWND TestAncestor(HWND hwnd, UINT) {
  const auto found = windows.find(hwnd);
  return found == windows.end() ? nullptr : found->second.root;
}
HWND TestOwner(HWND hwnd, UINT) { return windows.at(hwnd).owner; }
BOOL TestChild(HWND parent, HWND child) { return child != parent && TestAncestor(child, GA_ROOT) == parent; }
BOOL TestWindow(HWND hwnd) { return windows.contains(hwnd); }
BOOL TestThreadInfo(DWORD, GUITHREADINFO *info) {
  info->hwndCapture = capture;
  return capture_readable;
}
HWND TestForeground() { return foreground; }
HWND TestHit(POINT) { return hit; }
bool raw_registration_ok = true, raw_window_ok = true, raw_read_ok = true;
DWORD raw_type = RIM_TYPEMOUSE;
unsigned raw_registered = 0, raw_removed = 0, raw_destroyed = 0, raw_defaulted = 0;
UINT TestRawData(HRAWINPUT, UINT command, void *data, UINT *size, UINT header_size) {
  if (!raw_read_ok || command != RID_HEADER || header_size != sizeof(RAWINPUTHEADER) ||
      *size != sizeof(RAWINPUTHEADER)) return static_cast<UINT>(-1);
  static_cast<RAWINPUTHEADER *>(data)->dwType = raw_type;
  return sizeof(RAWINPUTHEADER);
}
LRESULT TestDefWindow(HWND, UINT, WPARAM, LPARAM) { ++raw_defaulted; return 0; }
ATOM TestRegisterClass(const WNDCLASSEXW *cls) {
  return cls->lpfnWndProc != nullptr ? 1 : 0;
}
HWND TestCreateWindow(DWORD, LPCWSTR, LPCWSTR, DWORD, int, int, int, int,
                      HWND parent, HMENU, HINSTANCE, LPVOID) {
  return raw_window_ok && parent == HWND_MESSAGE ? Id(100) : nullptr;
}
BOOL TestRegisterRaw(PCRAWINPUTDEVICE device, UINT count, UINT size) {
  if (count != 1 || size != sizeof(RAWINPUTDEVICE) ||
      device->usUsagePage != 1 || device->usUsage != 2) return FALSE;
  if (device->dwFlags == RIDEV_REMOVE && device->hwndTarget == nullptr) {
    ++raw_removed;
    return TRUE;
  }
  if (device->dwFlags != RIDEV_INPUTSINK || device->hwndTarget != Id(100)) return FALSE;
  ++raw_registered;
  return raw_registration_ok;
}
BOOL TestDestroyWindow(HWND hwnd) { if (hwnd == Id(100)) ++raw_destroyed; return TRUE; }
std::atomic<bool> scrolling_hook_failed = false;
HWINEVENTHOOK TestEventHook(DWORD first, DWORD, HMODULE, WINEVENTPROC, DWORD, DWORD, DWORD) {
  if (first == EVENT_SYSTEM_SCROLLINGSTART) { scrolling_hook_failed = true; return nullptr; }
  return reinterpret_cast<HWINEVENTHOOK>(1);
}
HHOOK TestMouseHook(int, HOOKPROC, HINSTANCE, DWORD) { return reinterpret_cast<HHOOK>(1); }
BOOL TestUnhookEvent(HWINEVENTHOOK) { return TRUE; }
BOOL TestUnhookMouse(HHOOK) { return TRUE; }
#define SetWinEventHook TestEventHook
#define SetWindowsHookExW TestMouseHook
#define UnhookWinEvent TestUnhookEvent
#define UnhookWindowsHookEx TestUnhookMouse
#define GetRawInputData TestRawData
#define DefWindowProcW TestDefWindow
#define RegisterClassExW TestRegisterClass
#define CreateWindowExW TestCreateWindow
#define RegisterRawInputDevices TestRegisterRaw
#define DestroyWindow TestDestroyWindow
#define GetWindowThreadProcessId TestWindowThread
#define GetAncestor TestAncestor
#define GetWindow TestOwner
#define IsChild TestChild
#define IsWindow TestWindow
#define GetGUIThreadInfo TestThreadInfo
#define GetForegroundWindow TestForeground
#define WindowFromPoint TestHit
#include "computer_use_windows_host_background_monitor.inc"
#undef GetTickCount
#undef SetWinEventHook
#undef SetWindowsHookExW
#undef UnhookWinEvent
#undef UnhookWindowsHookEx
#undef GetWindowThreadProcessId
#undef GetAncestor
#undef GetWindow
#undef IsChild
#undef IsWindow
#undef GetGUIThreadInfo
#undef GetForegroundWindow
#undef WindowFromPoint
#undef GetRawInputData
#undef DefWindowProcW
#undef RegisterClassExW
#undef CreateWindowExW
#undef RegisterRawInputDevices
#undef DestroyWindow

bool Check(bool value, const char *name) {
  if (!value) std::cerr << name << '\n';
  return value;
}
}

int main() {
  using Owner = sprint_coder::computer_use::BackgroundInputOwner;
  using namespace sprint_coder::computer_use;
  if (!CheckBackgroundMonitor()) return 1;
  const auto value = BackgroundPatternPermission(BackgroundPattern::kValue, 5);
  {
    WindowsBackgroundMonitorState state(1, [] { return 1000u; });
    state.Registered(true);
    state.Claim(1, value, 1000);
    state.TargetEvent(Owner::kTarget, EVENT_OBJECT_VALUECHANGE, 5, 0, 0, 1001, 1001);
    if (!Check(state.Snapshot().paused, "ATTR_before_begin_call_pauses")) return 1;
  }
  for (bool begin_call : {true, false}) {
    const char *name = begin_call ?
        "ATTR_finish_without_end_call_pauses_and_revokes_permission" :
        "ATTR_finish_without_begin_call_pauses_and_revokes_permission";
    WindowsBackgroundMonitorState state(1, [] { return 1000u; });
    state.Registered(true);
    const auto epoch = state.Snapshot().epoch;
    const auto claim = state.Claim(epoch, value, 1000);
    if (!Check(claim != 0 && (!begin_call || state.BeginCall(claim, 1000)), name)) return 1;
    if (!Check(!state.Finish(claim, 1010), name)) return 1;
    const auto finished = state.Snapshot();
    if (!Check(finished.paused && finished.unknown_effect && finished.epoch > epoch, name)) return 1;
    state.TargetEvent(Owner::kTarget, EVENT_OBJECT_VALUECHANGE, 5, 0, 0, 1001, 1011);
    const auto after_event = state.Snapshot();
    // Pausing is latched: a later matching event cannot restore the old authority.
    if (!Check(after_event.paused && after_event.unknown_effect &&
                   after_event.epoch == finished.epoch && after_event.epoch > epoch &&
                   state.Claim(after_event.epoch, value, 1012) == 0, name)) return 1;
  }
  for (const auto tick : {999u, 1000u, 1001u}) {
    WindowsBackgroundMonitorState state(1, [] { return 1000u; });
    state.Registered(true);
    const auto claim = state.Claim(1, value, 1000);
    state.BeginCall(claim, 1000);
    state.TargetEvent(Owner::kTarget, EVENT_OBJECT_VALUECHANGE, 5, 0, 0, tick, 1100);
    if (!Check((state.EndCall(claim, 1101), state.Finish(claim, 1101)) == (tick > 1000) &&
                   state.Snapshot().unknown_effect == (tick <= 1000),
               "ATTR_generation_before_or_same_tick_delivered_after_claim")) return 1;
  }
  // Separate claim, call and completion clocks; no sleeps or OS input.
  for (int phase = 0; phase < 3; ++phase) {
    static std::uint32_t tick;
    tick = 1000;
    WindowsBackgroundMonitorState state(1, [] { return tick; });
    state.Registered(true);
    const auto claim = state.Claim(1, value, 1000);
    tick = 1020;
    if (!state.BeginCall(claim, 1020)) return 1;
    if (phase != 0 && !state.EndCall(claim, 1030)) return 1;
    const auto arrival = phase == 0 ? 1021 : phase == 1 ? 1179 : 1180;
    state.TargetEvent(Owner::kTarget, EVENT_OBJECT_VALUECHANGE, 5, 0, 0,
        1021, arrival);
    if (!Check(state.Snapshot().paused == (phase >= 2),
               "ATTR_call_and_end_grace_but_not_expired_before_finish")) return 1;
  }
  for (const auto generated : {1010u, 1020u}) {
    WindowsBackgroundMonitorState state(1, [] { return 1020u; });
    state.Registered(true);
    const auto claim = state.Claim(1, value, 1000);
    state.BeginCall(claim, 1020);
    state.TargetEvent(Owner::kTarget, EVENT_OBJECT_VALUECHANGE, 5, 0, 0, generated, 1021);
    if (!Check(state.Snapshot().paused, "ATTR_generation_before_or_at_begin_call_pauses")) return 1;
  }
  for (int invalid = 0; invalid < 5; ++invalid) {
    WindowsBackgroundMonitorState state(1, [] { return 1000u; });
    state.Registered(true);
    const auto claim = state.Claim(1, value, 1000);
    if (invalid != 0 && invalid != 2) state.BeginCall(claim, 1000);
    if (invalid == 4) state.EndCall(claim, 1001);
    const bool accepted = invalid == 1 || invalid == 2 ?
        state.BeginCall(claim + (invalid == 2), 1002) :
        state.EndCall(claim + (invalid == 3), 1002);
    if (!Check(!accepted && state.Snapshot().paused && state.Snapshot().unknown_effect,
               "ATTR_invalid_call_boundary_order_or_claim_pauses")) return 1;
  }
  {
    WindowsBackgroundMonitorState state(1, [] { return 1000u; });
    state.Registered(true);
    const auto claim = state.Claim(1, value, 1000);
    state.BeginCall(claim, 1000);
    state.EndCall(claim, 1010);
    if (!Check(state.Finish(claim, 1200) && state.Claim(1, value, 1200) != 0,
               "ATTR_finish_does_not_restart_end_call_grace")) return 1;
  }
  for (const auto tick : {0xffffffefu, 0xfffffff0u, 0x10u}) {
    WindowsBackgroundMonitorState state(1, [] { return 0xfffffff0u; });
    state.Registered(true);
    const auto claim = state.Claim(1, value, 1000);
    state.BeginCall(claim, 1000);
    state.TargetEvent(Owner::kTarget, EVENT_OBJECT_VALUECHANGE, 5, 0, 0, tick, 1001);
    if (!Check((state.EndCall(claim, 1002), state.Finish(claim, 1002)) == (tick == 0x10u), "ATTR_generation_tick_wrap")) return 1;
  }
  {
    static std::uint32_t tick = 1000;
    WindowsBackgroundMonitorState state(1, [] { return tick; });
    state.Registered(true);
    const auto first = state.Claim(1, value, 1000);
    state.BeginCall(first, 1000);
    if (!(state.EndCall(first, 1010), state.Finish(first, 1010))) return 1;
    tick = 1160;
    const auto second = state.Claim(1, value, 1160);
    state.BeginCall(second, 1160);
    state.TargetEvent(Owner::kTarget, EVENT_OBJECT_VALUECHANGE, 5, 0, 0, 1001, 1161);
    if (!Check(second != 0 && !(state.EndCall(second, 1162), state.Finish(second, 1162)) && state.Snapshot().unknown_effect,
               "ATTR_previous_claim_delayed_event_cannot_use_next_claim")) return 1;
  }
  {
    WindowsBackgroundMonitorState state(1, [] { return 1000u; });
    state.Registered(true);
    const auto first = state.Claim(1, value, 1000);
    state.BeginCall(first, 1000);
    if (!(state.EndCall(first, 1010), state.Finish(first, 1010))) return 1;
    if (!Check(state.Claim(1, value, 1159) == 0 && state.Claim(1, 1159) == 0 &&
                   !state.Snapshot().paused && state.Claim(1, value, 1160) != 0,
               "ATTR_grace_refuses_claim_until_deadline")) return 1;
  }
  for (auto pattern : {BackgroundPattern::kInvoke, BackgroundPattern::kValue,
                       BackgroundPattern::kToggle, BackgroundPattern::kSelectionItem,
                       BackgroundPattern::kExpandCollapse, BackgroundPattern::kScroll}) {
    const auto permission = BackgroundPatternPermission(pattern, 5);
    const std::array<unsigned, 5> expected = pattern == BackgroundPattern::kInvoke ?
        std::array<unsigned, 5>{1, 2} : pattern == BackgroundPattern::kValue ?
        std::array<unsigned, 5>{2, 2} : pattern == BackgroundPattern::kSelectionItem ?
        std::array<unsigned, 5>{2, 1, 1, 1, 1} : std::array<unsigned, 5>{2};
    if (!Check(permission.limits == expected, "ATTR_pattern_kind_caps")) return 1;
    for (std::size_t kind = 0; kind < permission.events.size(); ++kind) {
      if (permission.events[kind] == 0) continue;
      for (bool grace : {false, true}) {
        WindowsBackgroundMonitorState state(1, [] { return 1000u; });
        state.Registered(true);
        const auto claim = state.Claim(1, permission, 1000);
        state.BeginCall(claim, 1000);
        for (unsigned count = 0; count < permission.limits[kind]; ++count)
          state.TargetEvent(Owner::kTarget, permission.events[kind], 5, 0, 0, 1001, 1001);
        if (!Check(!state.Snapshot().paused, "ATTR_kind_limit_inclusive")) return 1;
        if (grace && !(state.EndCall(claim, 1002), state.Finish(claim, 1002))) return 1;
        state.TargetEvent(Owner::kTarget, permission.events[kind], 5, 0, 0, 1002, 1003);
        if (!Check(state.Snapshot().paused && state.Snapshot().unknown_effect == !grace,
                   "ATTR_each_kind_first_excess_pauses")) return 1;
      }
    }
  }
  {
    // Exercise the independent total cap with a synthetic permission, not the production table.
    auto permission = value;
    permission.limits = {16, 16};
    WindowsBackgroundMonitorState state(1, [] { return 1000u; });
    state.Registered(true);
    const auto claim = state.Claim(1, permission, 1000);
    state.BeginCall(claim, 1000);
    for (unsigned count = 0; count < 16; ++count)
      state.TargetEvent(Owner::kTarget, permission.events[count % 2], 5, 0, 0, 1001, 1001);
    if (!Check(!state.Snapshot().paused, "ATTR_total_limit_inclusive")) return 1;
    state.TargetEvent(Owner::kTarget, EVENT_OBJECT_VALUECHANGE, 5, 0, 0, 1001, 1001);
    if (!Check(state.Snapshot().unknown_effect, "ATTR_total_first_excess_pauses")) return 1;
  }
  for (auto pattern : {BackgroundPattern::kExpandCollapse, BackgroundPattern::kScroll}) {
    for (auto event : {EVENT_OBJECT_SHOW, EVENT_OBJECT_HIDE,
                       EVENT_SYSTEM_SCROLLINGSTART, EVENT_SYSTEM_SCROLLINGEND}) {
      WindowsBackgroundMonitorState state(1, [] { return 1000u; });
      state.Registered(true);
      const auto claim = state.Claim(1, BackgroundPatternPermission(pattern, 5), 1000);
      state.BeginCall(claim, 1000);
      state.TargetEvent(Owner::kTarget, event, 5, 0, 0, 1001, 1001);
      if (!Check(state.Snapshot().unknown_effect, "ATTR_show_hide_scrolling_never_exempt")) return 1;
    }
  }
  // Arrival order matrix. Synthetic times avoid sleep and OS input.
  for (int order = 0; order < 7; ++order) {
    WindowsBackgroundMonitorState state(1, [] { return 1000u; });
    state.Registered(true);
    std::uint64_t claim = 0;
    if (order != 0) claim = state.Claim(1, value, 1000);
    if (order != 0) state.BeginCall(claim, 1000);
    if (order >= 2 && !(state.EndCall(claim, 1010) && state.Finish(claim, 1010))) return 1;
    if (order == 5) claim = state.Claim(1,
        BackgroundPatternPermission(BackgroundPattern::kInvoke, 6), 1160);
    if (order == 6) claim = state.Claim(1, value, 1160);
    if (order >= 5) state.BeginCall(claim, 1160);
    const auto now = order == 0 ? 999 : order == 1 ? 1001 :
        order == 2 ? 1010 : order == 3 ? 1159 : order == 4 ? 1160 : 1161;
    state.TargetEvent(Owner::kTarget, EVENT_OBJECT_VALUECHANGE, 5, OBJID_CLIENT, 0, 1001, now);
    const bool pause = order == 0 || order == 4 || order == 5;
    if (!Check(state.Snapshot().paused == pause &&
                   state.Snapshot().unknown_effect == (order == 5),
               "ATTR_arrival_before_during_after_finish_grace_and_next_claim")) return 1;
  }
  for (auto pattern : {BackgroundPattern::kInvoke, BackgroundPattern::kValue,
                       BackgroundPattern::kToggle, BackgroundPattern::kSelectionItem,
                       BackgroundPattern::kExpandCollapse, BackgroundPattern::kScroll}) {
    const auto permission = BackgroundPatternPermission(pattern, 5);
    for (auto event : permission.events) {
      if (event == 0) continue;
      WindowsBackgroundMonitorState state(1, [] { return 1000u; });
      state.Registered(true);
      const auto claim = state.Claim(1, permission, 1000);
      state.BeginCall(claim, 1000);
      state.TargetEvent(Owner::kTarget, event, 5, OBJID_CLIENT, 0, 1001, 1001);
      if (!Check((state.EndCall(claim, 1002), state.Finish(claim, 1002)) && !state.Snapshot().paused,
                 "ATTR_each_pattern_expected_event")) return 1;
    }
  }
  for (int mismatch = 0; mismatch < 7; ++mismatch) {
    WindowsBackgroundMonitorState state(1, [] { return 1000u; });
    state.Registered(true);
    auto permission = value;
    permission.child_known = mismatch == 2 || mismatch == 3;
    permission.object = OBJID_CLIENT;
    permission.child = 7;
    if (mismatch == 6) permission.hwnd = 0;
    const auto claim = state.Claim(1, permission, 1000);
    state.BeginCall(claim, 1000);
    state.TargetEvent(mismatch == 4 ? Owner::kUnknown : Owner::kTarget,
        mismatch == 1 ? EVENT_OBJECT_INVOKED : EVENT_OBJECT_VALUECHANGE,
        mismatch == 0 ? 6 : 5, mismatch == 2 ? OBJID_WINDOW : OBJID_CLIENT,
        mismatch == 3 ? 8 : 7, 1001, mismatch == 5 ? 999 : 1001);
    if (!Check(!(state.EndCall(claim, 1002), state.Finish(claim, 1002)) && state.Snapshot().unknown_effect,
               "ATTR_wrong_hwnd_kind_object_child_owner_time_or_missing_hwnd")) return 1;
  }
  {
    WindowsBackgroundMonitorState state(1, [] { return 1000u; });
    state.Registered(true);
    auto permission = value;
    permission.child_known = true;
    permission.object = OBJID_CLIENT;
    permission.child = 7;
    const auto claim = state.Claim(1, permission, 1000);
    state.BeginCall(claim, 1000);
    state.TargetEvent(Owner::kTarget, EVENT_OBJECT_VALUECHANGE, 5, OBJID_CLIENT, 7, 1001, 1001);
    if (!Check((state.EndCall(claim, 1002), state.Finish(claim, 1002)), "ATTR_known_child_matches")) return 1;
  }
  for (bool finish_first : {false, true}) {
    WindowsBackgroundMonitorState state(1, [] { return 1000u; });
    state.Registered(true);
    const auto claim = state.Claim(1, value, 1000);
    state.BeginCall(claim, 1000);
    for (unsigned count = 0; count < 2; ++count)
      state.TargetEvent(Owner::kTarget, EVENT_OBJECT_VALUECHANGE, 5, 0, 0, 1001, 1001);
    if (!Check(!state.Snapshot().paused, "ATTR_limit_inclusive")) return 1;
    if (finish_first && !(state.EndCall(claim, 1002), state.Finish(claim, 1002))) return 1;
    state.TargetEvent(Owner::kTarget, EVENT_OBJECT_VALUECHANGE, 5, 0, 0, 1001, 1003);
    if (!Check(state.Snapshot().paused && state.Snapshot().unknown_effect == !finish_first,
               "ATTR_limit_shared_by_claim_and_grace")) return 1;
  }
  {
    WindowsBackgroundMonitorState state(1, [] { return 1000u; });
    state.Registered(true);
    const auto first = state.Claim(1, value, 1000);
    state.BeginCall(first, 1000);
    for (unsigned count = 0; count < 2; ++count)
      state.TargetEvent(Owner::kTarget, EVENT_OBJECT_VALUECHANGE, 5, 0, 0, 1001, 1001);
    if (!(state.EndCall(first, 1002), state.Finish(first, 1002))) return 1;
    const auto second = state.Claim(1, value, 1152);
    state.BeginCall(second, 1152);
    if (!Check(!state.Finish(first, 1153), "ATTR_old_finish_cannot_end_next_claim")) return 1;
    state.TargetEvent(Owner::kTarget, EVENT_OBJECT_VALUECHANGE, 5, 0, 0, 1001, 1154);
    if (!Check((state.EndCall(second, 1155), state.Finish(second, 1155)), "ATTR_next_claim_gets_fresh_count")) return 1;
    // An old Finish must not refresh the existing grace interval either.
    if (state.Finish(second, 1200)) return 1;
    state.TargetEvent(Owner::kTarget, EVENT_OBJECT_VALUECHANGE, 5, 0, 0, 1001, 1305);
    if (!Check(state.Snapshot().paused, "ATTR_old_finish_cannot_extend_grace")) return 1;
  }
  {
    WindowsBackgroundMonitorState state(1, [] { return 1000u; });
    state.Registered(true);
    const auto first = state.Claim(1, value, 1000);
    state.BeginCall(first, 1000);
    if (!(state.EndCall(first, 1001), state.Finish(first, 1001)) || !state.Claim(1, 1151)) return 1;
    state.TargetEvent(Owner::kTarget, EVENT_OBJECT_VALUECHANGE, 5, 0, 0, 1152, 1152);
    if (!Check(state.Snapshot().unknown_effect,
               "ATTR_unattributed_next_claim_discards_old_permission")) return 1;
  }
  for (bool stop_first : {false, true}) {
    WindowsBackgroundMonitorState state(1, [] { return 1000u; });
    state.Registered(true);
    if (stop_first) state.Pause();
    const auto claim = state.Claim(1, value, 1000);
    state.BeginCall(claim, 1000);
    if (!stop_first) state.Pause();
    state.TargetEvent(Owner::kTarget, EVENT_OBJECT_VALUECHANGE, 5, 0, 0, 1001, 1001);
    if (!Check(!(state.EndCall(claim, 1002), state.Finish(claim, 1002)) && state.Snapshot().paused &&
                   state.Snapshot().unknown_effect == !stop_first,
               "ATTR_stop_before_or_after_claim_linearization")) return 1;
  }
  for (DWORD event : {EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_CAPTURESTART, EVENT_SYSTEM_CAPTUREEND,
                     EVENT_SYSTEM_MOVESIZESTART, EVENT_SYSTEM_MOVESIZEEND, EVENT_OBJECT_CREATE,
                     EVENT_OBJECT_DESTROY, EVENT_OBJECT_FOCUS}) {
    WindowsBackgroundMonitorState state(1, [] { return 1000u; });
    state.Registered(true);
    const auto claim = state.Claim(1,
        BackgroundPatternPermission(BackgroundPattern::kExpandCollapse, 5), 1000);
    state.BeginCall(claim, 1000);
    state.TargetEvent(Owner::kTarget, event, 5, OBJID_WINDOW, 0, 1001, 1001);
    if (!Check(!(state.EndCall(claim, 1002), state.Finish(claim, 1002)) && state.Snapshot().unknown_effect,
               "ATTR_foreground_capture_movesize_popup_never_exempt")) return 1;
  }
  for (bool after_finish : {false, true}) {
    for (int termination = 0; termination < 4; ++termination) {
      WindowsBackgroundMonitorState state(1, [] { return 1000u; });
      state.Registered(true);
      const auto claim = state.Claim(1, value, 1000);
      state.BeginCall(claim, 1000);
      if (after_finish && !(state.EndCall(claim, 1010), state.Finish(claim, 1010))) return 1;
      if (termination == 0) state.Pause(); // Stop / helper exit.
      if (termination == 1) state.Registered(false);
      if (termination == 2) state.Registered(true); // Re-registration is not resume.
      if (termination == 3) { state.BeginMonitoring(1000); state.CheckHealth(1300); }
      state.TargetEvent(Owner::kTarget, EVENT_OBJECT_VALUECHANGE, 5, 0, 0, 1001, 1011);
      state.Registered(true);
      if (!Check(state.Snapshot().paused && !state.Claim(state.Snapshot().epoch, value, 1301) &&
                     state.Snapshot().unknown_effect == !after_finish,
                 "ATTR_stop_exit_reregister_health_revoke_permission")) return 1;
      WindowsBackgroundMonitorState resumed(state.Snapshot().epoch + 1);
      resumed.Registered(true);
      resumed.TargetEvent(Owner::kTarget, EVENT_OBJECT_VALUECHANGE, 5, 0, 0, 1302);
      if (!Check(resumed.Snapshot().paused, "ATTR_fresh_monitor_does_not_inherit_grace")) return 1;
    }
  }
  for (const auto event_tick : {999u, 1000u, 1001u}) {
    WindowsBackgroundMonitor monitor(10, Id(1), 1);
    monitor.state.Registered(true);
    WindowsBackgroundMonitor::current = &monitor;
    auto permission = value;
    permission.child_known = true;
    permission.object = OBJID_CLIENT;
    permission.child = 7;
    const auto claim = monitor.state.Claim(1, permission);
    monitor.state.BeginCall(claim);
    WindowsBackgroundMonitor::Target(nullptr, EVENT_OBJECT_VALUECHANGE, Id(5), OBJID_CLIENT, 7, 10, event_tick);
    monitor.state.EndCall(claim);
    if (!Check(monitor.state.Finish(claim) == (event_tick > 1000), "ATTR_callback_passes_metadata")) return 1;
    monitor.Stop();
    WindowsBackgroundMonitor::Target(nullptr, EVENT_OBJECT_VALUECHANGE, Id(5), OBJID_CLIENT, 7, 10, event_tick);
    if (!Check(monitor.state.Snapshot().paused, "ATTR_native_stop_revokes_grace")) return 1;
    WindowsBackgroundMonitor::current = nullptr;
  }
  for (int scenario = 0; scenario < 3; ++scenario) {
    WindowsBackgroundMonitor monitor(10, Id(1), 1);
    monitor.state.BeginMonitoring();
    monitor.state.Registered(true);
    WindowsBackgroundMonitor::current = &monitor;
    raw_type = scenario == 0 ? RIM_TYPEKEYBOARD : RIM_TYPEMOUSE;
    raw_read_ok = scenario != 2;
    raw_defaulted = 0;
    WindowsBackgroundMonitor::RawWindow(Id(100), WM_INPUT, RIM_INPUT, 1);
    if (!Check(raw_defaulted == 1 && monitor.state.Snapshot().paused == (scenario == 2),
               "BG08_raw_header_failure_and_default_cleanup")) return 1;
    const auto after_correlation = sprint_coder::computer_use::BackgroundMonitorNow() +
        sprint_coder::computer_use::kBackgroundMouseCorrelationMs + 1;
    if (!Check((monitor.state.Claim(1, after_correlation) != 0) == (scenario == 0),
               "BG08_native_keyboard_ignored_mouse_requires_hook")) return 1;
    WindowsBackgroundMonitor::current = nullptr;
  }
  for (int scenario = 0; scenario < 3; ++scenario) {
    WindowsBackgroundMonitor monitor(10, Id(1), 1);
    raw_window_ok = scenario != 1;
    raw_registration_ok = scenario != 2;
    raw_registered = raw_removed = raw_destroyed = 0;
    std::stop_source stopped;
    stopped.request_stop();
    monitor.RunRawPump(stopped.get_token());
    if (!Check(raw_registered == (scenario == 1 ? 0u : 1u) &&
                   raw_removed == (scenario == 0 ? 1u : 0u) &&
                   raw_destroyed == (scenario == 1 ? 0u : 1u) &&
                   monitor.state.Snapshot().paused && !monitor.state.Claim(1),
               "BG08_raw_sink_registration_failure_and_cleanup")) return 1;
    monitor.Initialized(true);
    if (!Check(!monitor.state.Claim(monitor.state.Snapshot().epoch),
               "BG08_native_registration_recovery_stays_paused")) return 1;
  }
  windows = {{Id(1), {10, Id(1)}}, {Id(2), {10, Id(2)}},
             {Id(3), {20, Id(3), Id(1)}}, {Id(4), {30, Id(4)}},
             {Id(5), {10, Id(1)}}, {Id(6), {40, Id(6)}}};
  windows.emplace(Id(7), Window{20, Id(1)}); // Foreign-process child.
  windows.emplace(Id(8), Window{10, Id(2)}); // Same PID, different top-level.
  for (auto hwnd : {static_cast<HWND>(nullptr), Id(99), Id(1), Id(2), Id(7), Id(8), Id(5)}) {
    if (!Check(WindowsBackgroundElementWindowValid(hwnd, 10, Id(1)) == (hwnd == Id(5)),
               "ATTR_element_hwnd_requires_live_same_pid_descendant_not_root")) return 1;
  }
  {
    foreground = Id(4);
    raw_window_ok = raw_registration_ok = true;
    WindowsBackgroundMonitor monitor(10, Id(1), 1);
    if (!Check(!monitor.Start() && scrolling_hook_failed && monitor.state.Snapshot().paused &&
                   monitor.state.Claim(1) == 0,
               "ATTR_scrolling_hook_registration_failure_pauses")) return 1;
    monitor.Stop();
  }
  foreground = Id(4);
  for (auto target : {Id(1), Id(2), Id(3), Id(5)}) {
    WindowsBackgroundMonitor monitor(10, Id(1), 1);
    monitor.state.Registered(true);
    WindowsBackgroundMonitor::current = &monitor;
    if (!Check(monitor.Belongs(target) == Owner::kTarget, "BG03_process_owned_child_attribution")) return 1;
    WindowsBackgroundMonitor::Foreground(nullptr, EVENT_SYSTEM_FOREGROUND, target, 0, 0, 0, 0);
    if (!Check(!monitor.state.Claim(1), "BG03_any_source_foreground_closes_claim")) return 1;
    WindowsBackgroundMonitor::current = nullptr;
  }
  for (auto other : {Id(4), Id(6)}) {
    WindowsBackgroundMonitor monitor(10, Id(1), 1);
    monitor.state.Registered(true);
    hit = foreground = other;
    capture = nullptr;
    monitor.SamplePointer({0, 0});
    monitor.state.Foreground(monitor.Belongs(foreground));
    if (!Check(monitor.state.Claim(1) != 0, "BG02_other_app_and_sprint_coder_continue")) return 1;
  }
  for (int scenario = 0; scenario < 4; ++scenario) {
    WindowsBackgroundMonitor monitor(10, Id(1), 1);
    monitor.state.Registered(true);
    foreground = Id(4);
    hit = scenario == 0 ? Id(5) : scenario == 2 ? Id(99) : Id(4);
    capture = scenario == 1 ? Id(2) : nullptr;
    capture_readable = scenario != 3;
    monitor.SamplePointer({0, 0});
    if (!Check(!monitor.state.Claim(1), "BG03_inactive_hit_capture_or_unknown")) return 1;
  }
  for (DWORD event : {EVENT_SYSTEM_MOVESIZESTART, EVENT_SYSTEM_MOVESIZEEND,
                     EVENT_SYSTEM_CAPTURESTART, EVENT_OBJECT_VALUECHANGE,
                     EVENT_OBJECT_INVOKED, EVENT_OBJECT_CREATE, EVENT_OBJECT_DESTROY}) {
    WindowsBackgroundMonitor monitor(10, Id(1), 1);
    monitor.state.Registered(true);
    WindowsBackgroundMonitor::current = &monitor;
    // Child events and destroyed HWNDs must not disappear through an IsWindow filter.
    WindowsBackgroundMonitor::Target(nullptr, event, nullptr, OBJID_CLIENT, 7, 10, 1);
    if (!Check(!monitor.state.Claim(1), "BG03_unattributed_target_winevent")) return 1;
    WindowsBackgroundMonitor::current = nullptr;
  }
  for (int scenario = 0; scenario < 5; ++scenario) {
    WindowsBackgroundMonitor monitor(10, Id(1), 1);
    monitor.state.Registered(scenario != 4);
    if (scenario == 1) monitor.state.Pause();
    if (scenario == 2) monitor.state.Claim(1);
    const bool retired = monitor.state.RetireForForeground(scenario == 3 ? 2 : 1);
    if (!Check(retired == (scenario == 0), "handoff requires healthy idle current authority")) return 1;
    if (!Check(!monitor.state.Claim(monitor.state.Snapshot().epoch), "retirement closes background input")) return 1;
    if (!Check(!monitor.state.RetireForForeground(1), "retirement cannot be reused")) return 1;
  }
  std::cout << "Background monitor native seam: PASS\n";
  return 0;
}
