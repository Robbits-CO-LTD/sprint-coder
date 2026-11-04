// Built by the Explorer live seam with the production measurement fragment, not a replacement.
#include <windows.h>
#include <exdisp.h>
#include <shlobj.h>
#include <shldisp.h>
#include <cwctype>
#include <shlguid.h>
#include <functional>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>
#include <iostream>
#include "computer_use_windows_uia_source.h"
#include "computer_use_windows_target_facts.h"
#include "explorer-measurement.inc"

using sprint_coder::computer_use::windows_uia_source_detail::ComRef;

int Fail(int code, const char *reason) {
  std::cout << "FAIL " << code << " " << reason << std::endl;
  return code;
}


void PumpExplorerMessages() {
  MsgWaitForMultipleObjects(0, nullptr, FALSE, 25, QS_ALLINPUT);
  MSG message;
  while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }
}

std::wstring NormalizeExplorerPath(std::wstring path) {
  wchar_t expanded[32768]{};
  const DWORD length = GetLongPathNameW(path.c_str(), expanded, 32768);
  if (length > 0 && length < 32768) path.assign(expanded, length);
  for (auto &character : path) {
    if (character == L'/') character = L'\\';
    character = static_cast<wchar_t>(towlower(character));
  }
  while (path.size() > 3 && path.back() == L'\\') path.pop_back();
  return path;
}

std::wstring ExplorerFolderPath(IWebBrowser2 *browser) {
  ComRef<IDispatch> document;
  ComRef<IShellFolderViewDual> view;
  ComRef<Folder> folder;
  ComRef<Folder2> folder2;  // Self is a Folder2 member, not Folder's.
  ComRef<FolderItem> item;
  BSTR path = nullptr;
  if (FAILED(browser->get_Document(document.Receive())) || !document.Get() ||
      FAILED(document.Get()->QueryInterface(IID_PPV_ARGS(view.Receive()))) ||
      FAILED(view.Get()->get_Folder(folder.Receive())) || !folder.Get() ||
      FAILED(folder.Get()->QueryInterface(IID_PPV_ARGS(folder2.Receive()))) ||
      FAILED(folder2.Get()->get_Self(item.Receive())) || !item.Get() ||
      FAILED(item.Get()->get_Path(&path))) return {};
  const auto result = path ? NormalizeExplorerPath(path) : std::wstring{};
  SysFreeString(path);
  return result;
}

std::wstring ExplorerTargetPath(const std::wstring &target) {
  if (target.rfind(L"shell:", 0) != 0) return NormalizeExplorerPath(target);
  PIDLIST_ABSOLUTE pidl = nullptr;
  PWSTR path = nullptr;
  if (FAILED(SHParseDisplayName(target.c_str(), nullptr, &pidl, 0, nullptr))) return {};
  const HRESULT result = SHGetNameFromIDList(pidl, SIGDN_DESKTOPABSOLUTEPARSING, &path);
  const auto normalized = SUCCEEDED(result) && path ? NormalizeExplorerPath(path) : std::wstring{};
  CoTaskMemFree(path);
  CoTaskMemFree(pidl);
  return normalized;
}

struct ExplorerEntry {
  ComRef<IWebBrowser2> browser;
  std::wstring path;
  HWND window = nullptr;
};
struct ExplorerSnapshot {
  std::vector<ExplorerEntry> entries;
  bool valid = false;
  bool ContainsPath(const std::wstring &path) const {
    for (const auto &entry : entries) if (entry.path == path) return true;
    return false;
  }
  bool HasWindow(HWND window) const {
    for (const auto &entry : entries) if (entry.window == window) return true;
    return false;
  }
};
ExplorerSnapshot ExplorerEntries() {
  ExplorerSnapshot result;
  ComRef<IShellWindows> windows;
  long count = 0;
  if (FAILED(CoCreateInstance(CLSID_ShellWindows, nullptr, CLSCTX_LOCAL_SERVER,
      IID_PPV_ARGS(windows.Receive()))) || FAILED(windows.Get()->get_Count(&count)) ||
      count < 0 || count > 256) return result;
  for (long index = 0; index < count; ++index) {
    VARIANT item; VariantInit(&item); item.vt = VT_I4; item.lVal = index;
    ComRef<IDispatch> dispatch;
    ExplorerEntry entry;
    SHANDLE_PTR handle = 0;
    if (FAILED(windows.Get()->Item(item, dispatch.Receive())) || !dispatch.Get() ||
        FAILED(dispatch.Get()->QueryInterface(IID_PPV_ARGS(entry.browser.Receive()))) ||
        FAILED(entry.browser.Get()->get_HWND(&handle))) return result;
    entry.path = ExplorerFolderPath(entry.browser.Get());
    if (entry.path.empty()) return result;
    entry.window = reinterpret_cast<HWND>(handle);
    result.entries.push_back(std::move(entry));
  }
  result.valid = true;
  return result;
}

bool explorer_cleanup_confirmed = true;
struct OpenedExplorer {
  ExplorerSnapshot before = ExplorerEntries();
  std::wstring target_path;
  HWND window = nullptr;
  bool shared = false;
  bool launched = false;
  bool Exclusive() const {
    const auto now = ExplorerEntries();
    if (!now.valid || before.HasWindow(window)) return false;
    size_t matches = 0;
    for (const auto &entry : now.entries) {
      if (entry.window != window) continue;
      if (entry.path != target_path) return false;
      ++matches;
    }
    return matches == 1;
  }
  ~OpenedExplorer() {
    if (!launched) return;
    // Search by the unique target even when Open timed out before finding its entry.
    const ULONGLONG deadline = GetTickCount64() + 10000;
    bool quit = false;
    do {
      auto now = ExplorerEntries();
      if (now.valid) {
        if (quit && !now.ContainsPath(target_path)) return;
        for (auto &entry : now.entries) {
          if (entry.path != target_path || before.ContainsPath(entry.path)) continue;
          window = entry.window;
          if (!Exclusive()) {
            std::cout << "NOT_RUN explorer_tab_shared" << std::endl;
            explorer_cleanup_confirmed = false;
            return;
          }
          if (!quit) {
            if (FAILED(entry.browser.Get()->Quit())) {
              Fail(22, "explorer_quit");
              explorer_cleanup_confirmed = false;
              return;
            }
            quit = true;
          }
        }
      }
      PumpExplorerMessages();
    } while (GetTickCount64() < deadline);
    explorer_cleanup_confirmed = false;
    Fail(22, quit ? "explorer_quit_timeout" : "explorer_cleanup_entry_timeout");
  }
  HWND Open(const std::wstring &target) {
    target_path = ExplorerTargetPath(target);
    if (!before.valid || target_path.empty()) { Fail(2, "explorer_snapshot"); return nullptr; }
    if (before.ContainsPath(target_path)) {
      std::cout << "NOT_RUN explorer_target_preexisting" << std::endl;
      shared = true;
      return nullptr;
    }
    std::wstring command = L"explorer.exe /n,\"" + target + L"\"";
    STARTUPINFOW startup{sizeof(startup)};
    PROCESS_INFORMATION process{};
    if (!CreateProcessW(nullptr, command.data(), nullptr, nullptr, FALSE, 0, nullptr, nullptr,
                        &startup, &process)) { Fail(2, "explorer_launch"); return nullptr; }
    launched = true;
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    const ULONGLONG deadline = GetTickCount64() + 10000;
    while (GetTickCount64() < deadline) {
      auto after = ExplorerEntries();
      if (!after.valid) { PumpExplorerMessages(); continue; }
      ExplorerEntry *candidate = nullptr;
      for (auto &entry : after.entries) {
        if (before.ContainsPath(entry.path) || !(entry.path == target_path)) continue;
        if (candidate) { Fail(2, "explorer_ambiguous_entries"); return nullptr; }
        candidate = &entry;
      }
      if (candidate) {
        window = candidate->window;
        shared = !Exclusive();
        if (shared) {
          std::cout << "NOT_RUN explorer_tab_shared" << std::endl;
          return nullptr;
        }
        return window;
      }
      PumpExplorerMessages();
    }
    Fail(2, "explorer_entry_timeout");
    return nullptr;
  }
};

int wmain(int argc, wchar_t **argv) {
  if (argc == 3 && std::wstring(argv[1]) == L"child") {
    HWND parent = reinterpret_cast<HWND>(static_cast<std::uintptr_t>(_wcstoui64(argv[2], nullptr, 10)));
    HWND child = CreateWindowExW(0, L"STATIC", L"fixture", WS_CHILD | WS_VISIBLE,
                                 0, 0, 100, 100, parent, nullptr, GetModuleHandleW(nullptr), nullptr);
    if (child == nullptr) return Fail(20, "foreign_child_create");
    SetWindowPos(child, HWND_TOP, 0, 0, 100, 100, SWP_SHOWWINDOW);
    MSG message;
    while (GetMessageW(&message, nullptr, 0, 0) > 0) DispatchMessageW(&message);
    return 0;
  }
  if (argc != 2 || FAILED(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED))) return Fail(1, "arguments_or_sta");
  if (!sprint_coder::computer_use::kWindowsExplorerException) return Fail(21, "gate_disabled");
  struct Apartment { ~Apartment() { CoUninitialize(); } } apartment;
  struct CleanupReport {
    ~CleanupReport() {
      if (explorer_cleanup_confirmed) std::cout << "OK explorer_cleanup" << std::endl;
    }
  } cleanup_report;
  const std::wstring scratch = argv[1];
  const auto current = [] { return true; };
  for (const auto &target : {scratch, std::wstring(L"shell:ControlPanelFolder"),
                            std::wstring(L"shell:AppsFolder")}) {
    OpenedExplorer opened;
    HWND window = opened.Open(target);
    if (window == nullptr) return opened.shared ? 0 : Fail(2, "explorer_open");
    std::optional<std::wstring> view;
    const ULONGLONG until = GetTickCount64() + 5000;
    do {
      view = ReadWindowsExplorerShellView(window, current);
      if (view.has_value() || target != scratch) break;
      PumpExplorerMessages();
    } while (GetTickCount64() < until);
    if ((target == scratch) != view.has_value()) return Fail(3, "shell_view_kind");
    if (ReadWindowsExplorerShellView(window, [] { return false; }).has_value()) return Fail(4, "cancelled_view");
  }
  const auto junction = scratch + L"\\Panel.{21EC2020-3AEA-1069-A2DD-08002B30309D}";
  if (!CreateDirectoryW(junction.c_str(), nullptr) || WindowsExplorerPlainFolder(junction)) return Fail(5, "junction_fixture");
  {
    OpenedExplorer opened;
    HWND window = opened.Open(junction);
    if (window == nullptr) return opened.shared ? 0 : Fail(6, "junction_open");
    if (ReadWindowsExplorerShellView(window, current).has_value()) return Fail(6, "junction_view");
  }
  const auto customized = scratch + L"\\Customized";
  if (!CreateDirectoryW(customized.c_str(), nullptr)) return Fail(7, "customized_fixture");
  const auto ini = customized + L"\\desktop.ini";
  if (!WritePrivateProfileStringW(L".ShellClassInfo", L"CLSID",
      L"{21EC2020-3AEA-1069-A2DD-08002B30309D}", ini.c_str())) return Fail(8, "desktop_ini");
  SetFileAttributesW(customized.c_str(), FILE_ATTRIBUTE_READONLY);
  if (WindowsExplorerPlainFolder(customized)) return Fail(9, "customized_folder");
  {
    OpenedExplorer opened;
    HWND window = opened.Open(customized);
    if (window == nullptr) return opened.shared ? 0 : Fail(10, "customized_open");
    if (ReadWindowsExplorerShellView(window, current).has_value()) return Fail(10, "customized_view");
  }
  OpenedExplorer opened;
  HWND parent = opened.Open(scratch);
  if (parent == nullptr) return opened.shared ? 0 : Fail(11, "foreign_parent_open");
  DWORD parent_pid = 0;
  GetWindowThreadProcessId(parent, &parent_pid);
  if (!opened.Exclusive()) { std::cout << "NOT_RUN explorer_tab_shared" << std::endl; return 0; }
  ShowWindow(parent, SW_RESTORE);
  SetForegroundWindow(parent);
  POINT point{10, 10};
  if (!ClientToScreen(parent, &point) || !WindowsExplorerPointOwner(parent, parent_pid, point))
    return Fail(12, "parent_point_owner");
  wchar_t self[32768]{};
  GetModuleFileNameW(nullptr, self, 32768);
  std::wstring command = L"\"" + std::wstring(self) + L"\" child " +
      std::to_wstring(reinterpret_cast<std::uintptr_t>(parent));
  STARTUPINFOW startup{sizeof(startup)};
  PROCESS_INFORMATION process{};
  if (!CreateProcessW(nullptr, command.data(), nullptr, nullptr, FALSE, 0, nullptr, nullptr,
                       &startup, &process)) return Fail(13, "foreign_child_launch");
  struct Child {
    PROCESS_INFORMATION value;
    ~Child() {
      TerminateProcess(value.hProcess, 0);
      WaitForSingleObject(value.hProcess, 2000);
      CloseHandle(value.hProcess);
      CloseHandle(value.hThread);
    }
  } child{process};
  const ULONGLONG until = GetTickCount64() + 5000;
  struct Search { DWORD pid; HWND window = nullptr; } search{process.dwProcessId};
  do {
    EnumChildWindows(parent, [](HWND window, LPARAM parameter) -> BOOL {
      auto *search = reinterpret_cast<Search *>(parameter);
      DWORD pid = 0;
      GetWindowThreadProcessId(window, &pid);
      if (pid == search->pid) { search->window = window; return FALSE; }
      return TRUE;
    }, reinterpret_cast<LPARAM>(&search));
    if (search.window != nullptr) break;
    PumpExplorerMessages();
  } while (GetTickCount64() < until);
  if (search.window == nullptr || WaitForSingleObject(process.hProcess, 0) != WAIT_TIMEOUT)
    return Fail(14, "foreign_child_missing");
  point = POINT{10, 10};
  if (!ClientToScreen(search.window, &point) || WindowFromPoint(point) != search.window ||
      WindowsExplorerPointOwner(parent, parent_pid, point))
    return Fail(14, "foreign_child_owner");
  std::cout << "OK Explorer view and foreign child\n";
  return 0;
}
