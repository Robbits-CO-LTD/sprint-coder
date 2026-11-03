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

bool Check(bool value, const char *name) {
  if (!value) std::cerr << name << '\n';
  return value;
}
}

int main() {
  using Owner = sprint_coder::computer_use::BackgroundInputOwner;
  if (!CheckBackgroundMonitor()) return 1;
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
  std::cout << "Background monitor native seam: PASS\n";
  return 0;
}
