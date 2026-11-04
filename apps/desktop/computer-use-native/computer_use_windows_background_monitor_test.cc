// Native seam: compile with /std:c++20 /EHsc and user32.lib. No real hooks or GUI input.
#include <windows.h>
#include <chrono>
#include <condition_variable>
#include <iostream>
#include <memory>
#include <string>
#include <thread>
#include <unordered_map>
#include "computer_use_protocol.h"
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
#define GetRawInputData TestRawData
#define DefWindowProcW TestDefWindow
#define RegisterClassExW TestRegisterClass
#define CreateWindowExW TestCreateWindow
#define RegisterRawInputDevices TestRegisterRaw
#define DestroyWindow TestDestroyWindow
#define GetWindowThreadProcessId TestWindowThread
#define GetAncestor TestAncestor
#define GetWindow TestOwner
#define IsWindow TestWindow
#define GetGUIThreadInfo TestThreadInfo
#define GetForegroundWindow TestForeground
#define WindowFromPoint TestHit
#include "computer_use_windows_host_background_monitor.inc"
#undef GetWindowThreadProcessId
#undef GetAncestor
#undef GetWindow
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
  if (!CheckBackgroundMonitor()) return 1;
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
