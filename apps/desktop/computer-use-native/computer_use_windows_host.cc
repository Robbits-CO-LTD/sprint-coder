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
#include "computer_use_windows_risk_terms.h"
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
#include "computer_use_windows_host_uia_lane.inc"
#include "computer_use_windows_host_capture.inc"
#include "computer_use_windows_host_observe.inc"
#include "computer_use_windows_host_uia_semantic.inc"
#include "computer_use_windows_host_input.inc"
#include "computer_use_windows_host_preflight.inc"
#include "computer_use_windows_host_pipe.inc"
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
