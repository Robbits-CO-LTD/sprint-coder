#pragma once
#include <windows.h>
#include <array>
#include <atomic>

// Acceptance-only interception. Include after Windows headers, before the code under test.
// A host must supply an out-of-band sink: never write evidence to its protocol stdout.
namespace p7a_api_probe {
enum Api { foreground, focus, cursor, input, active, top, allow_foreground, count };
inline std::array<std::atomic<unsigned long long>, count> attempts{};
using Sink = void (*)(Api, unsigned long long);
inline std::atomic<Sink> sink{nullptr};
inline void Attempt(Api api) {
  const auto value = ++attempts[api];
  if (auto callback = sink.load()) callback(api, value);
}
inline BOOL Foreground(HWND hwnd) { Attempt(foreground); return ::SetForegroundWindow(hwnd); }
inline HWND Focus(HWND hwnd) { Attempt(focus); return ::SetFocus(hwnd); }
inline BOOL Cursor(int x, int y) { Attempt(cursor); return ::SetCursorPos(x, y); }
inline UINT Input(UINT size, LPINPUT events, int bytes) { Attempt(input); return ::SendInput(size, events, bytes); }
inline HWND Active(HWND hwnd) { Attempt(active); return ::SetActiveWindow(hwnd); }
inline BOOL Top(HWND hwnd) { Attempt(top); return ::BringWindowToTop(hwnd); }
inline BOOL Allow(DWORD pid) { Attempt(allow_foreground); return ::AllowSetForegroundWindow(pid); }
}
#define SetForegroundWindow p7a_api_probe::Foreground
#define SetFocus p7a_api_probe::Focus
#define SetCursorPos p7a_api_probe::Cursor
#define SendInput p7a_api_probe::Input
#define SetActiveWindow p7a_api_probe::Active
#define BringWindowToTop p7a_api_probe::Top
#define AllowSetForegroundWindow p7a_api_probe::Allow
