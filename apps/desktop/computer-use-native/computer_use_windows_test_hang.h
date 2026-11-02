#if defined(SPRINT_CODER_COMPUTER_USE_TEST_HANG)
#pragma once

#if defined(SPRINT_CODER_ELIGIBILITY_FROM_BUILD) || \
    defined(SPRINT_CODER_REQUIRE_WINDOWS_GRAPHICS_CAPTURE)
#error "Test hang hooks must not be compiled into a production Computer Use helper"
#endif

#include <windows.h>
#include <string>
#include <string_view>

// Exporting keeps the marker in the binary even with linker dead-code elimination.
extern "C" __declspec(dllexport) inline const char sprint_coder_test_hang_marker[] =
    "SPRINT_CODER_COMPUTER_USE_TEST_HANG_MARKER";

enum class WindowsTestHangPoint { UiaCall, SemanticPattern, Capture, WinVerifyTrust, CreateFileW };

inline void WindowsTestHang(WindowsTestHangPoint point) {
  wchar_t executable[32768]{};
  const DWORD length = GetModuleFileNameW(nullptr, executable, 32768);
  if (length == 0 || length >= 32768) return;
  std::wstring sidecar(executable, length);
  const auto separator = sidecar.find_last_of(L"\\/");
  if (separator == std::wstring::npos) return;
  sidecar.resize(separator + 1);
  sidecar += L"sprint-coder-test-hang.txt";
  HANDLE file = CreateFileW(sidecar.c_str(), GENERIC_READ,
                            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                            nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) return;
  char bytes[64]{};
  DWORD count = 0;
  const BOOL read = ReadFile(file, bytes, sizeof(bytes), &count, nullptr);
  CloseHandle(file);
  if (!read || count == sizeof(bytes)) return;
  std::string_view selected(bytes, count);
  const auto first = selected.find_first_not_of(" \t\r\n");
  if (first == std::string_view::npos) return;
  selected = selected.substr(first, selected.find_last_not_of(" \t\r\n") - first + 1);
  const char *name = nullptr;
  switch (point) {
  case WindowsTestHangPoint::UiaCall: name = "UiaCall"; break;
  case WindowsTestHangPoint::SemanticPattern: name = "SemanticPattern"; break;
  case WindowsTestHangPoint::Capture: name = "Capture"; break;
  case WindowsTestHangPoint::WinVerifyTrust: name = "WinVerifyTrust"; break;
  case WindowsTestHangPoint::CreateFileW: name = "CreateFileW"; break;
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
