#if defined(SPRINT_CODER_COMPUTER_USE_TEST_HANG)
#pragma once

#if defined(SPRINT_CODER_ELIGIBILITY_FROM_BUILD) || \
    defined(SPRINT_CODER_REQUIRE_WINDOWS_GRAPHICS_CAPTURE)
#error "Test hang hooks must not be compiled into a production Computer Use helper"
#endif

#if !SPRINT_CODER_HAS_WINDOWS_GRAPHICS_CAPTURE
#error "Test hang hooks require Windows Graphics Capture headers"
#endif

#include <windows.h>
#include <cstdio>
#include <string>
#include <string_view>

// Exporting keeps the marker in the binary even with linker dead-code elimination.
extern "C" __declspec(dllexport) inline const char sprint_coder_test_hang_marker[] =
    "SPRINT_CODER_COMPUTER_USE_TEST_HANG_MARKER";

enum class WindowsTestHangPoint { UiaCall, SemanticPattern, Capture, WinVerifyTrust, CreateFileW, Validation, Rejudge };

// UiaCall hangs at the first contact; the existing 470 ms watchdog returns accessibility_timeout.
// Stop is not held up by this hang, and the occupied worker makes later UIA reads unavailable.
inline void WindowsTestHang(WindowsTestHangPoint point) {
  static const std::wstring sidecar = [] {
    wchar_t executable[32768]{};
    const DWORD length = GetModuleFileNameW(nullptr, executable, 32768);
    if (length == 0 || length >= 32768) return std::wstring{};
    std::wstring path(executable, length);
    const auto separator = path.find_last_of(L"\\/");
    if (separator == std::wstring::npos) return std::wstring{};
    path.resize(separator + 1);
    path += L"sprint-coder-test-hang.txt";
    return path;
  }();
  if (sidecar.empty()) return;
  HANDLE file = CreateFileW(sidecar.c_str(), GENERIC_READ,
                            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                            nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) return;
  char bytes[64]{};
  DWORD count = 0;
  const BOOL read = ReadFile(file, bytes, sizeof(bytes), &count, nullptr);
  CloseHandle(file);
  if (!read) return;
  const auto invalid_selection = [] {
    constexpr const char *message = "Computer Use test hang: invalid sidecar selection; use a known ASCII name without BOM.\n";
    OutputDebugStringA(message);
    std::fputs(message, stderr);
    std::fflush(stderr);
  };
  if (count == sizeof(bytes)) {
    invalid_selection();
    return;
  }
  std::string_view selected(bytes, count);
  const auto first = selected.find_first_not_of(" \t\r\n");
  if (first == std::string_view::npos) return;
  selected = selected.substr(first, selected.find_last_not_of(" \t\r\n") - first + 1);
  if (selected != "UiaCall" && selected != "SemanticPattern" && selected != "Capture" &&
      selected != "WinVerifyTrust" && selected != "CreateFileW" && selected != "Validation" &&
      selected != "Rejudge") {
    invalid_selection();
    return;
  }
  const char *name = nullptr;
  switch (point) {
  case WindowsTestHangPoint::UiaCall: name = "UiaCall"; break;
  case WindowsTestHangPoint::SemanticPattern: name = "SemanticPattern"; break;
  case WindowsTestHangPoint::Capture: name = "Capture"; break;
  case WindowsTestHangPoint::WinVerifyTrust: name = "WinVerifyTrust"; break;
  case WindowsTestHangPoint::CreateFileW: name = "CreateFileW"; break;
  case WindowsTestHangPoint::Validation: name = "Validation"; break;
  case WindowsTestHangPoint::Rejudge: name = "Rejudge"; break;
  }
  if (name == nullptr || selected != name) return;
  // No handle is shared or signaled. Process termination can end this user-mode wait.
  HANDLE event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (event != nullptr) {
    WaitForSingleObject(event, INFINITE);
    CloseHandle(event);
  }
  for (;;) Sleep(INFINITE);
}

#endif
