#include <windows.h>
#include <map>
#include <thread>
#include <string>
#include "evidence.h"

// Out-of-context WinEvent callbacks and read-only snapshots. No activation/input APIs.
std::map<HWND, unsigned> known_windows;
unsigned long long event_count = 0, sample_count = 0, max_gap = 0;
ULONGLONG last_sample = 0;
DWORD observer_thread;
HWND last_foreground = nullptr, last_focus = nullptr, last_capture = nullptr;
POINT last_cursor{};
bool first_sample = true;

std::string Identity(HWND hwnd) {
  DWORD pid = 0; DWORD tid = GetWindowThreadProcessId(hwnd, &pid);
  return Number("hwnd", WindowId(hwnd)) + Number("windowPid", pid) + Number("windowTid", tid);
}
BOOL CALLBACK Discover(HWND hwnd, LPARAM baseline) {
  if (!IsWindowVisible(hwnd)) return TRUE;
  LONG_PTR style = GetWindowLongPtrW(hwnd, GWL_STYLE);
  LONG_PTR exstyle = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
  const unsigned flags = ((style & WS_POPUP) ? 1U : 0U) | ((exstyle & WS_EX_TOPMOST) ? 2U : 0U);
  const auto previous = known_windows.find(hwnd);
  const bool changed = previous != known_windows.end();
  const unsigned added = changed ? flags & ~previous->second : flags;
  known_windows[hwnd] = flags;
  if (added)
    Evidence(baseline ? "baselineWindow" : "newWindow", Identity(hwnd) +
      Number("popup", (style & WS_POPUP) != 0) + Number("topmost", (exstyle & WS_EX_TOPMOST) != 0) +
      Number("changedStyle", changed));
  return TRUE;
}
void CALLBACK Event(HWINEVENTHOOK, DWORD event, HWND hwnd, LONG object, LONG child,
                    DWORD thread, DWORD event_time) {
  if (event != EVENT_SYSTEM_FOREGROUND && event != EVENT_OBJECT_FOCUS &&
      event != EVENT_SYSTEM_CAPTURESTART && event != EVENT_SYSTEM_CAPTUREEND &&
      event != EVENT_OBJECT_CREATE && event != EVENT_OBJECT_SHOW && event != EVENT_OBJECT_HIDE && event != EVENT_OBJECT_DESTROY) return;
  if (event == EVENT_OBJECT_CREATE || event == EVENT_OBJECT_SHOW || event == EVENT_OBJECT_HIDE || event == EVENT_OBJECT_DESTROY) {
    if (object != OBJID_WINDOW || child != CHILDID_SELF) return;
    if (event == EVENT_OBJECT_DESTROY || event == EVENT_OBJECT_HIDE) known_windows.erase(hwnd);
    else if (GetAncestor(hwnd, GA_ROOT) == hwnd) Discover(hwnd, 0);
  }
  ++event_count;
  Evidence("winEvent", Identity(hwnd) + Number("event", event) +
    ",\"object\":" + std::to_string(object) + ",\"child\":" + std::to_string(child) +
    Number("eventThread", thread) + Number("eventTime32", event_time));
}
void Sample() {
  const auto now = GetTickCount64();
  if (last_sample && now - last_sample > max_gap) max_gap = now - last_sample;
  last_sample = now; ++sample_count;
  HWND foreground = GetForegroundWindow(); POINT cursor{};
  const BOOL cursor_ok = GetCursorPos(&cursor);
  GUITHREADINFO info{}; info.cbSize = sizeof(info);
  const BOOL gui_ok = GetGUIThreadInfo(0, &info);
  if (first_sample || foreground != last_foreground || info.hwndFocus != last_focus ||
      info.hwndCapture != last_capture || !cursor_ok || !gui_ok ||
      cursor.x != last_cursor.x || cursor.y != last_cursor.y || sample_count % 10 == 0) {
    Evidence("sample", Number("foreground", WindowId(foreground)) +
      Number("focus", WindowId(info.hwndFocus)) + Number("capture", WindowId(info.hwndCapture)) +
      ",\"cursorX\":" + std::to_string(cursor.x) + ",\"cursorY\":" + std::to_string(cursor.y) +
      Number("cursorOk", cursor_ok) + Number("guiOk", gui_ok) + Number("maxGapMs", max_gap));
  }
  first_sample = false; last_foreground = foreground; last_focus = info.hwndFocus;
  last_capture = info.hwndCapture; last_cursor = cursor;
  EnumWindows(Discover, 0);
}
int main() {
  observer_thread = GetCurrentThreadId();
  MSG message{}; PeekMessageW(&message, nullptr, WM_USER, WM_USER, PM_NOREMOVE);
  auto hook = SetWinEventHook(EVENT_MIN, EVENT_MAX, nullptr, Event, 0, 0, WINEVENT_OUTOFCONTEXT);
  if (!hook) { Evidence("error", Number("win32", GetLastError())); return 2; }
  EnumWindows(Discover, 1);
  auto timer = SetTimer(nullptr, 0, 10, nullptr);
  if (!timer) { UnhookWinEvent(hook); Evidence("error", Number("win32", GetLastError())); return 2; }
  Sample(); Evidence("ready", Number("sampleIntervalMs", 10));
  std::thread([] {
    std::string line;
    while (std::getline(std::cin, line)) {
      if (line == "stop") break;
      if (line == "mark") PostThreadMessageW(observer_thread, WM_APP, 0, 0);
    }
    PostThreadMessageW(observer_thread, WM_QUIT, 0, 0);
  }).detach();
  while (GetMessageW(&message, nullptr, 0, 0) > 0) {
    if (message.message == WM_TIMER) Sample();
    if (message.message == WM_APP) { Sample(); Evidence("mark"); }
    DispatchMessageW(&message);
  }
  Sample(); KillTimer(nullptr, timer); UnhookWinEvent(hook);
  Evidence("finished", Number("events", event_count) + Number("samples", sample_count) + Number("maxGapMs", max_gap));
  return 0;
}
