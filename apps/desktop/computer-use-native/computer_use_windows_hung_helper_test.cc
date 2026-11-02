// Test-only entry points; the pipe still runs the production host and hang hook.
#include <windows.h>
#include <cstdio>
#include <string>
#include <string_view>

#if defined(SPRINT_CODER_COMPUTER_USE_TEST_HANG)
// Only the hook's infinite wait is witnessed. No production wait or timeout is replaced.
DWORD WitnessHang(HANDLE event, DWORD timeout) {
  wchar_t path[32768]{};
  const DWORD size = GetModuleFileNameW(nullptr, path, 32768);
  if (size > 0 && size < 32768) {
    std::wstring marker(path, size);
    marker.resize(marker.find_last_of(L"\\/") + 1);
    marker += L"hang-entered.txt";
    HANDLE file = CreateFileW(marker.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr,
                              CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file != INVALID_HANDLE_VALUE) {
      CloseHandle(file);
    }
  }
  return WaitForSingleObject(event, timeout);
}
// The host detects these headers before including the hook. Repeat that detection here because
// the hook is included early solely to witness its wait, then guarded by pragma once.
#if defined(_MSC_VER) && __has_include(<winrt/Windows.Graphics.Capture.h>) && \
    __has_include(<windows.graphics.capture.interop.h>) && \
    __has_include(<windows.graphics.directx.direct3d11.interop.h>)
#define SPRINT_CODER_HAS_WINDOWS_GRAPHICS_CAPTURE 1
#endif
#define WaitForSingleObject WitnessHang
#include "computer_use_windows_test_hang.h"
#undef WaitForSingleObject
#endif

#define wmain ComputerUseHostMain
#include "computer_use_windows_host.cc"
#undef wmain

int wmain(int argc, wchar_t **argv) {
  if (argc == 3 && std::wstring_view(argv[1]) == L"--window") {
    struct WindowQuery { DWORD pid; HWND window; } query{static_cast<DWORD>(_wtoi(argv[2])), nullptr};
    EnumWindows([](HWND window, LPARAM parameter) -> BOOL {
      auto *query = reinterpret_cast<WindowQuery *>(parameter);
      DWORD pid = 0;
      GetWindowThreadProcessId(window, &pid);
      if (pid == query->pid && IsWindowVisible(window) && GetWindow(window, GW_OWNER) == nullptr) {
        query->window = window;
        return FALSE;
      }
      return TRUE;
    }, reinterpret_cast<LPARAM>(&query));
    if (query.window == nullptr) return 4;
    SetForegroundWindow(query.window);
    std::printf("%llu\n", static_cast<unsigned long long>(reinterpret_cast<UINT_PTR>(query.window)));
    return 0;
  }
  if (argc == 3 && std::wstring_view(argv[1]) == L"--identity") {
    WindowsExecutableIdentity identity;
    if (!BuildWindowsExecutableIdentity(argv[2], &identity)) return 2;
    std::puts(WindowsIdentityJson(identity).c_str());
    return 0;
  }
  if (argc == 2 && std::wstring_view(argv[1]) == L"--fixture") {
    HWND window = CreateWindowExW(0, L"STATIC", L"Hung helper seam", WS_OVERLAPPEDWINDOW,
                                   40, 40, 640, 480, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
    if (window == nullptr) return 3;
    ShowWindow(window, SW_SHOWNORMAL);
    std::printf("{\"pid\":%lu,\"windowId\":\"%llu\"}\n", GetCurrentProcessId(),
                static_cast<unsigned long long>(reinterpret_cast<UINT_PTR>(window)));
    std::fflush(stdout);
    MSG message{};
    while (GetMessageW(&message, nullptr, 0, 0) > 0) {
      TranslateMessage(&message);
      DispatchMessageW(&message);
    }
    return 0;
  }
  return ComputerUseHostMain(argc, argv);
}
