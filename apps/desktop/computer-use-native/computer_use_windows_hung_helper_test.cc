// Test-only entry points; the pipe still runs the production host and hang hook.
#include <windows.h>
#include <cstdio>
#include <cwchar>
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

// Closes only what the seam can prove it opened: a visible top-level window whose title contains
// the seam's unique scratch file name, whose process image is notepad.exe, and whose process was
// created no earlier than the --now value the seam read just before it spawned Notepad. A window of
// an older process (e.g. the person's packaged Notepad that took the file as a new tab) is never
// closed, only counted as not_owned. WM_CLOSE lets Notepad ask about unsaved text; no process is
// terminated. With close false it only counts. Prints {"matched":n,"not_owned":m}.
static int TitledNotepadWindows(bool close, std::wstring_view needle, const wchar_t *spawned) {
  struct TitleQuery {
    std::wstring_view needle;
    bool close;
    ULONGLONG spawned;
    unsigned matched;
    unsigned not_owned;
  } query{needle, close, 0, 0, 0};
  if (query.needle.size() < 16) return 5;
  wchar_t *end = nullptr;
  query.spawned = std::wcstoull(spawned, &end, 10);
  if (end == spawned || *end != L'\0' || query.spawned == 0) return 6;
  EnumWindows([](HWND window, LPARAM parameter) -> BOOL {
    auto *query = reinterpret_cast<TitleQuery *>(parameter);
    if (!IsWindowVisible(window) || GetWindow(window, GW_OWNER) != nullptr) return TRUE;
    wchar_t title[1024]{};
    const int length = GetWindowTextW(window, title, 1024);
    if (length <= 0 || std::wstring_view(title, length).find(query->needle) == std::wstring_view::npos)
      return TRUE;
    DWORD pid = 0;
    GetWindowThreadProcessId(window, &pid);
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (process == nullptr) return TRUE;
    wchar_t image[32768]{};
    DWORD size = 32768;
    const BOOL named = QueryFullProcessImageNameW(process, 0, image, &size);
    FILETIME created{}, exited{}, kernel{}, user{};
    const BOOL timed = GetProcessTimes(process, &created, &exited, &kernel, &user);
    CloseHandle(process);
    constexpr std::wstring_view suffix = L"\\notepad.exe";
    if (!named || size < suffix.size() ||
        _wcsicmp(image + (size - suffix.size()), suffix.data()) != 0)
      return TRUE;
    const ULONGLONG createdAt =
        (static_cast<ULONGLONG>(created.dwHighDateTime) << 32) | created.dwLowDateTime;
    if (!timed || createdAt < query->spawned) {
      query->not_owned += 1;
      return TRUE;
    }
    query->matched += 1;
    if (query->close) PostMessageW(window, WM_CLOSE, 0, 0);
    return TRUE;
  }, reinterpret_cast<LPARAM>(&query));
  std::printf("{\"matched\":%u,\"not_owned\":%u}\n", query.matched, query.not_owned);
  return 0;
}

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
  // The seam reads this clock just before it spawns Notepad and passes the value to --close-titled
  // and --count-titled (FILETIME, 100 ns units since 1601). GetSystemTimeAsFileTime is the
  // tick-granular system time, and a process creation time is stamped from the system time at
  // creation (that tick or finer), so a process started after the read is never stamped earlier.
  if (argc == 2 && std::wstring_view(argv[1]) == L"--now") {
    FILETIME now{};
    GetSystemTimeAsFileTime(&now);
    std::printf("%llu\n", (static_cast<unsigned long long>(now.dwHighDateTime) << 32) |
                              now.dwLowDateTime);
    return 0;
  }
  if (argc == 4 && (std::wstring_view(argv[1]) == L"--close-titled" ||
                    std::wstring_view(argv[1]) == L"--count-titled"))
    return TitledNotepadWindows(std::wstring_view(argv[1]) == L"--close-titled", argv[2], argv[3]);
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
