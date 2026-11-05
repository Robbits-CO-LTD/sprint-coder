// Built by the Explorer live seam with the complete production host, not a replacement. It opens and
// closes only its own Explorer windows: one new top-level window per target, told apart from the
// user's windows by its HWND and its path. Anything ambiguous is NOT_RUN and nothing is closed.
#define wmain ProductionHostMain
#include "explorer-host.cc"
#undef wmain
#include <shldisp.h>
#include <cwctype>
#include <stdexcept>

using sprint_coder::computer_use::windows_uia_source_detail::ComRef;
using Refusal = WindowsExplorerRefusal;

int Fail(int code, const char *reason) {
  std::cout << "FAIL " << code << " " << reason << std::endl;
  return code;
}
int FailReason(int code, const char *reason, Refusal actual, Refusal expected) {
  std::cout << "FAIL " << code << " " << reason << " reason=" << static_cast<int>(actual)
            << " expected=" << static_cast<int>(expected) << std::endl;
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
  // Exactly one top-level window that was absent before the launch and shows the target.
  HWND window = nullptr;
  bool shared = false;
  bool launched = false;
  // New HWNDs showing the target. A user window opened meanwhile on the same path is another one.
  std::vector<HWND> NewWindows(const ExplorerSnapshot &now) const {
    std::vector<HWND> found;
    for (const auto &entry : now.entries) {
      if (entry.path != target_path || before.HasWindow(entry.window)) continue;
      if (std::find(found.begin(), found.end(), entry.window) == found.end())
        found.push_back(entry.window);
    }
    return found;
  }
  // Our window has exactly one automation entry, and it shows the target.
  bool Exclusive(const ExplorerSnapshot &now) const {
    if (!now.valid || window == nullptr || before.HasWindow(window)) return false;
    size_t matches = 0;
    for (const auto &entry : now.entries) {
      if (entry.window != window) continue;
      if (entry.path != target_path) return false;
      ++matches;
    }
    return matches == 1;
  }
  bool Exclusive() const { return Exclusive(ExplorerEntries()); }
  void Ambiguous(const char *reason) {
    std::cout << "NOT_RUN " << reason << std::endl;
    explorer_cleanup_confirmed = false;
    shared = true;
  }
  // Ours only while the new HWNDs on the target are exactly {window} and it has one entry.
  bool OnlyOurs(const ExplorerSnapshot &now) const {
    const auto fresh = NewWindows(now);
    return fresh.size() == 1 && fresh.front() == window && Exclusive(now);
  }
  void RefuseUnlessOurs(const ExplorerSnapshot &now) {
    const auto fresh = NewWindows(now);
    Ambiguous(fresh.size() == 1 && fresh.front() == window ? "explorer_tab_shared"
                                                           : "explorer_window_ambiguous");
  }
  static constexpr ULONGLONG kSettleMs = 500;
  ~OpenedExplorer() {
    // Close nothing that cannot be told apart from the user's windows.
    if (!launched || shared) return;
    // Search by a new HWND on the target even when Open timed out before finding its entry.
    const ULONGLONG deadline = GetTickCount64() + 10000;
    ULONGLONG adopted = 0;  // When a window first seen here was adopted; it must settle, too.
    bool quit = false;
    do {
      auto now = ExplorerEntries();
      if (now.valid) {
        if (window == nullptr) {
          const auto fresh = NewWindows(now);
          if (fresh.size() > 1) { Ambiguous("explorer_window_ambiguous"); return; }
          if (fresh.size() == 1) { window = fresh.front(); adopted = GetTickCount64(); }
        }
        if (window != nullptr && quit && !now.HasWindow(window)) return;
        if (window != nullptr && !quit && (adopted == 0 || GetTickCount64() - adopted >= kSettleMs)) {
          // A user window opened meanwhile on the same path makes ours ambiguous: close nothing.
          if (!OnlyOurs(now)) { RefuseUnlessOurs(now); return; }
          for (auto &entry : now.entries) {
            // Only the entry with our HWND and our path, from the snapshot just checked.
            if (entry.window != window || entry.path != target_path) continue;
            if (FAILED(entry.browser.Get()->Quit())) {
              Fail(22, "explorer_quit");
              explorer_cleanup_confirmed = false;
              return;
            }
            quit = true;
            break;
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
      const auto fresh = NewWindows(after);
      if (fresh.size() > 1) { Ambiguous("explorer_window_ambiguous"); return nullptr; }
      if (fresh.size() == 1) {
        // Record it only if, after a short settle, it is still the only new window on the target.
        window = fresh.front();
        const ULONGLONG settled = GetTickCount64() + kSettleMs;
        while (GetTickCount64() < settled) PumpExplorerMessages();
        ExplorerSnapshot again;
        while (!(again = ExplorerEntries()).valid && GetTickCount64() < deadline) PumpExplorerMessages();
        if (!again.valid || !OnlyOurs(again)) { RefuseUnlessOurs(again); return nullptr; }
        return window;
      }
      PumpExplorerMessages();
    }
    Fail(2, "explorer_entry_timeout");
    return nullptr;
  }
};

// One pipe pair through the production HandlePipeRequest, as the transport test drives it.
struct ExplorerPipe {
  ScopedKernelHandle server, client, event;
  Frame frame;
  bool handshaken = true;
  bool Connect() {
    const auto name = LR"(\\.\pipe\sc-explorer-live-)" + std::to_wstring(GetCurrentProcessId());
    server.value = CreateNamedPipeW(name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
        1, 65536, 65536, 0, nullptr);
    event.value = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (server.value == INVALID_HANDLE_VALUE || event.value == nullptr) return false;
    OVERLAPPED connecting{}; connecting.hEvent = event.value;
    if (ConnectNamedPipe(server.value, &connecting) || GetLastError() != ERROR_IO_PENDING) return false;
    client.value = CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr,
        OPEN_EXISTING, FILE_FLAG_OVERLAPPED, nullptr);
    DWORD transferred = 0;
    if (client.value == INVALID_HANDLE_VALUE ||
        !GetOverlappedResult(server.value, &connecting, &transferred, TRUE)) return false;
    frame.header.message_type = static_cast<std::uint16_t>(MessageType::kProbe);
    frame.header.session_id.bytes[0] = 31;
    frame.header.request_id.bytes[0] = 1;
    return true;
  }
  bool Exchange(const std::string &metadata, std::string *reply_text, bool *probe_result) {
    frame.metadata.assign(metadata.begin(), metadata.end());
    if (!HandlePipeRequest(server.value, BackendProbe{}, frame, &handshaken,
                           WindowsTargetListControl().stop_serial.load())) return false;
    Frame reply;
    if (!ReadFrame(client.value, &reply) || reply.header.request_id.bytes != frame.header.request_id.bytes)
      return false;
    ++frame.header.request_id.bytes[0];
    reply_text->assign(reply.metadata.begin(), reply.metadata.end());
    *probe_result = reply.header.message_type == static_cast<std::uint16_t>(MessageType::kProbeResult);
    return true;
  }
};

// A session bound to the verified explorer.exe and the window this test opened, with the handles
// the host itself holds for a session.
bool BindExplorerSession(HWND window, DWORD pid, WindowsSession *session) {
  session->session_id = "bound";
  session->window = window;
  session->pid = pid;
  session->approval_route_v2 = true;
  session->cancel_epoch = cancellation_epoch.load();
  session->process_handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid);
  if (session->process_handle == nullptr ||
      !ReadProcessPath(session->process_handle, &session->canonical_path) ||
      !ReadProcessStartIdentity(session->process_handle, &session->process_start)) return false;
  session->executable_file = CreateFileW(session->canonical_path.c_str(), GENERIC_READ,
      FILE_SHARE_READ | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, 0, nullptr);
  WindowsFileIdentity identity;
  if (session->executable_file == INVALID_HANDLE_VALUE ||
      !ReadWindowsFileIdentity(session->executable_file, &identity)) return false;
  session->executable_volume_serial = identity.volume_serial;
  session->executable_file_id = identity.file_id;
  return true;
}

std::string MeasureMetadata(HWND window, std::uint64_t epoch, POINT point) {
  return "{\"operation\":\"measure_explorer_view\",\"sessionId\":\"bound\",\"windowId\":\"" +
      std::to_string(reinterpret_cast<std::uintptr_t>(window)) + "\",\"x\":" +
      std::to_string(point.x) + ",\"y\":" + std::to_string(point.y) +
      ",\"cancelEpoch\":" + std::to_string(epoch) + "}";
}

POINT Center(const RECT &rect) {
  return POINT{rect.left + (rect.right - rect.left) / 2, rect.top + (rect.bottom - rect.top) / 2};
}

bool WriteBytes(const std::wstring &path, const std::string &bytes) {
  ScopedKernelHandle file(CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS,
                                      FILE_ATTRIBUTE_NORMAL, nullptr));
  DWORD written = 0;
  return file.value != INVALID_HANDLE_VALUE &&
      WriteFile(file.value, bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr) &&
      written == bytes.size();
}

std::string Utf16Le(const std::wstring &text) {
  std::string bytes("\xFF\xFE", 2);
  for (const wchar_t character : text) {
    bytes.push_back(static_cast<char>(character & 0xFF));
    bytes.push_back(static_cast<char>((character >> 8) & 0xFF));
  }
  return bytes;
}

// Reads the view until it gives `expected`, for views that are still loading. Any other final
// answer fails with the reason it gave.
int ExpectView(HWND window, Refusal expected, const char *what, int code,
               Refusal expected_folder = Refusal::kNone) {
  WindowsExplorerShellView view;
  const ULONGLONG until = GetTickCount64() + 5000;
  do {
    view = ReadWindowsExplorerShellView(window, [] { return true; });
    if (view.refusal == expected && view.folder_refusal == expected_folder) break;
    PumpExplorerMessages();
  } while (GetTickCount64() < until);
  std::cout << "REASON " << what << " view=" << static_cast<int>(view.refusal)
            << " folder=" << static_cast<int>(view.folder_refusal) << std::endl;
  if (view.refusal != expected) return FailReason(code, what, view.refusal, expected);
  if (view.folder_refusal != expected_folder)
    return FailReason(code, what, view.folder_refusal, expected_folder);
  if (view.folder.has_value() != (expected == Refusal::kNone)) return Fail(code, what);
  if (ReadWindowsExplorerShellView(window, [] { return false; }).refusal != Refusal::kCancelled)
    return Fail(code, "cancelled_view");
  if (expected != Refusal::kNone) {
    DWORD pid = 0;
    GetWindowThreadProcessId(window, &pid);
    WindowsV2Judgement process;
    MeasureWindowsV2Process(pid, WindowsV2FactsContext(), &process);
    if (!EnsureWindowsV2Identity(&process)) return Fail(code, "prestart_negative_identity");
    const WindowsExplorerPrestartScope scope{windows_v2_list_generation,
        cancellation_epoch.load(), WindowsValidationFrameStopSerial(), [] { return true; }};
    if (MeasureWindowsExplorerPrestart(process, window, scope))
      return Fail(code, "explorer_prestart_rejects_namespace_or_junction");
  }
  return 0;
}

// Measurement-only acceptance cases: no session is installed and no input API is invoked.
int CheckExplorerPrestart(HWND window, DWORD pid, HWND view) {
  using namespace sprint_coder::computer_use;
  const auto &context = WindowsV2FactsContext();
  WindowsV2Judgement process;
  MeasureWindowsV2Process(pid, context, &process);
  if (!EnsureWindowsV2Identity(&process) || !sessions.empty()) return Fail(60, "prestart_fixture");
  const auto generation = windows_v2_list_generation;
  const auto epoch = cancellation_epoch.load();
  const auto serial = WindowsValidationFrameStopSerial();
  const WindowsExplorerPrestartScope scope{generation, epoch, serial, [] { return true; }};
  if (!MeasureWindowsExplorerPrestart(process, window, scope) || !sessions.empty())
    return Fail(60, "explorer_prestart_measurement_requires_no_session");
  std::cout << "OK explorer_prestart_measurement_requires_no_session\n";
  // A fabricated image never obtains an exception, even with a real Explorer HWND.
  const auto signature = process.measured.facts.signature;
  process.measured.facts.signature = "unsigned";
  if (MeasureWindowsExplorerPrestart(process, window, scope)) return Fail(61, "fake_explorer");
  process.measured.facts.signature = signature;
  for (HWND other : {GetShellWindow(), FindWindowW(L"Shell_TrayWnd", nullptr)}) {
    if (other && MeasureWindowsExplorerPrestart(process, other, scope))
      return Fail(61, "desktop_or_taskbar");
  }
  auto stale = scope;
  stale.current = [] { return false; };
  if (MeasureWindowsExplorerPrestart(process, window, stale)) return Fail(62, "prestart_deadline");
  stale = scope;
  stale.stop_serial = serial + 1;
  if (MeasureWindowsExplorerPrestart(process, window, stale)) return Fail(62, "prestart_stop");
  stale = scope;
  stale.epoch = epoch + 1;
  if (MeasureWindowsExplorerPrestart(process, window, stale)) return Fail(62, "prestart_epoch");
  stale = scope;
  stale.generation = 0;
  if (MeasureWindowsExplorerPrestart(process, window, stale)) return Fail(62, "prestart_generation");
  stale = scope;
  unsigned checks = 0;
  stale.current = [&] {
    if (++checks == 2) Sleep(850);  // Expires the production 800ms COM deadline on this lane.
    return true;
  };
  if (MeasureWindowsExplorerPrestart(process, window, stale)) return Fail(62, "prestart_expired");

  // The same process cache cannot authorize any window without that window's measurement.
  const HWND unmeasured = reinterpret_cast<HWND>(reinterpret_cast<std::uintptr_t>(window) + 1);
  if (WindowsV2VerdictForWindowClass(&process, std::string("CabinetWClass"), nullptr, unmeasured).kind !=
      TargetVerdictKind::kDenied) return Fail(63, "explorer_exception_is_per_window_not_per_pid");
  std::cout << "OK explorer_exception_is_per_window_not_per_pid\n";
  if (!kWindowsApprovalHandlersEnabled || IsProcessElevated(pid)) {
    std::cout << "NOT_RUN explorer_start_and_rejudge_remeasure_view approval_or_elevation\n";
    return 0;
  }
  const auto old_helper = windows_helper_generation;
  struct RestoreHelper {
    std::uint64_t value;
    ~RestoreHelper() { windows_helper_generation = value; }
  } restore{old_helper};
  windows_helper_generation = 1;
  std::string maximum_mode;
  std::optional<WindowsFileKey> not_web;
  bool admitted = false;
  const auto start = [&] {
    return AdmitWindowsV2StartInContext(pid, window, process.executable, context,
        DenyRulesetVersion(TargetPlatform::kWin32), generation, generation, true,
        process.app_identity, process.executable.identity.executable_digest,
        process.executable.identity.signer_digest, &maximum_mode, &not_web, &scope, &admitted);
  };
  if (!start() || !admitted || maximum_mode != "supervised") return Fail(64, "prestart_admission");
  WindowsStartInput start_input;
  start_input.pid = pid;
  start_input.window = window;
  start_input.window_value = reinterpret_cast<std::uintptr_t>(window);
  start_input.app_identity = process.app_identity;
  start_input.canonical_path = process.executable.identity.path;
  start_input.executable_digest = process.executable.identity.executable_digest;
  start_input.signer_digest = process.executable.identity.signer_digest;
  start_input.expected_window_identity = Sha256String("computer-window-identity-v1\n" +
      process.app_identity + "\n" + process.process_start + "\n" + std::to_string(start_input.window_value));
  start_input.main_pid = windows_v2_main_pid;
  start_input.context = context;
  start_input.ruleset_version = DenyRulesetVersion(TargetPlatform::kWin32);
  start_input.requested_generation = start_input.generation = generation;
  start_input.initial_epoch = epoch;
  start_input.stop_serial = serial;
  const auto new_start = [&] {
    ScopedKernelHandle target;
    LockedWindowsExecutable image;
    WindowsNewStartMeasurement measured;
    return MeasureWindowsNewStart(start_input, scope.current, &target, &image, &measured);
  };
  if (!new_start()) return Fail(64, "prestart_common_admission");
  WindowsV2RejudgeWork work;
  work.pid = pid;
  work.window = window;
  work.maximum_mode = maximum_mode;
  work.app_identity = process.app_identity;
  work.process_start = process.process_start;
  work.context = context;
  work.main_pid = windows_v2_main_pid;
  work.epoch = epoch;
  work.stop_serial = serial;
  work.generation = generation;
  if (!DuplicateHandle(GetCurrentProcess(), process.executable.file, GetCurrentProcess(),
          &work.executable.value, 0, FALSE, DUPLICATE_SAME_ACCESS) ||
      !MeasureWindowsV2Rejudge(work).matches) return Fail(64, "prestart_rejudge");
  ShowWindow(view, SW_HIDE);
  const bool started_hidden = start();
  const bool common_started_hidden = new_start();
  const bool rejudged_hidden = MeasureWindowsV2Rejudge(work).matches;
  ShowWindow(view, SW_SHOW);
  if (started_hidden || common_started_hidden || admitted || rejudged_hidden)
    return Fail(64, "explorer_start_and_rejudge_remeasure_view");
  if (!start() || !new_start() || !MeasureWindowsV2Rejudge(work).matches || !sessions.empty())
    return Fail(64, "prestart_restored");
  std::cout << "OK explorer_start_and_rejudge_remeasure_view\n";
  return 0;
}

int ExpectFolder(const std::wstring &path, Refusal expected, const char *what, int code) {
  Refusal reason = Refusal::kNone;
  const bool plain = WindowsExplorerPlainFolder(path, &reason);
  std::cout << "REASON " << what << " folder=" << static_cast<int>(reason) << std::endl;
  if (plain != (expected == Refusal::kNone) || reason != expected)
    return FailReason(code, what, reason, expected);
  return 0;
}

int CheckMeasuredItems(HWND parent, const WindowsExplorerShellView &view,
    const std::wstring &scratch, bool large, bool localized_collision = false) {
  using sprint_coder::computer_use::windows_uia_source_detail::ComRef;
  // Configure only this fixture's exclusive window so the test point is reproducible.
  auto snapshot = ExplorerEntries();
  bool configured = false;
  if (!snapshot.valid) return Fail(66, "item_view_snapshot");
  for (auto &entry : snapshot.entries) {
    if (entry.window != parent || entry.path != NormalizeExplorerPath(scratch)) continue;
    ComRef<IServiceProvider> provider;
    ComRef<IShellBrowser> browser;
    ComRef<IShellView> shell_view;
    ComRef<IFolderView> folder_view;
    if (configured || FAILED(entry.browser.Get()->QueryInterface(IID_PPV_ARGS(provider.Receive()))) ||
        FAILED(provider.Get()->QueryService(SID_STopLevelBrowser, IID_PPV_ARGS(browser.Receive()))) ||
        FAILED(browser.Get()->QueryActiveShellView(shell_view.Receive())) ||
        FAILED(shell_view.Get()->QueryInterface(IID_PPV_ARGS(folder_view.Receive()))) ||
        FAILED(folder_view.Get()->SetCurrentViewMode(FVM_ICON))) return Fail(66, "item_icon_mode");
    configured = true;
  }
  if (!configured) return Fail(66, "item_icon_view_missing");
  for (unsigned attempt = 0; attempt < 8; ++attempt) PumpExplorerMessages();
    // Locate the fixture visually, then ask the real shell-view measurement at that physical point.
    // No selection or input is injected by this case.
    ComRef<IUIAutomation> automation;
    ComRef<IUIAutomationElement> ui_view;
    ComRef<IUIAutomationCondition> list_items;
    ComRef<IUIAutomationElementArray> visible_items;
    VARIANT control; VariantInit(&control); control.vt = VT_I4; control.lVal = UIA_ListItemControlTypeId;
    using sprint_coder::computer_use::windows_uia_source_detail::CreateBoundedAutomation;
    if (!CreateBoundedAutomation(150, 150, automation.Receive()) ||
        FAILED(automation.Get()->ElementFromHandle(view.view, ui_view.Receive())) ||
        FAILED(automation.Get()->CreatePropertyCondition(UIA_ControlTypePropertyId, control, list_items.Receive())) ||
        FAILED(ui_view.Get()->FindAll(TreeScope_Descendants, list_items.Get(), visible_items.Receive())))
      return Fail(66, "item_uia");
    int item_count = 0;
    if (FAILED(visible_items.Get()->get_Length(&item_count))) return Fail(66, "item_count");
    bool folder_checked = false, file_checked = false, collision_checked = false;
    unsigned localized_hits = 0;
    for (int index = 0; index < item_count; ++index) {
      ComRef<IUIAutomationElement> item;
      sprint_coder::computer_use::windows_uia_source_detail::BstrHolder name;
      RECT bounds{}; BOOL offscreen = TRUE;
      if (FAILED(visible_items.Get()->GetElement(index, item.Receive())) ||
          FAILED(item.Get()->get_CurrentName(name.Receive())) ||
          FAILED(item.Get()->get_CurrentBoundingRectangle(&bounds)) ||
          FAILED(item.Get()->get_CurrentIsOffscreen(&offscreen))) return Fail(66, "item_properties");
      const bool is_folder = name.View() == L"AAA-MeasuredChild";
      const bool is_file = name.View() == L"AAB-MeasuredFile.txt" || name.View() == L"AAB-MeasuredFile";
      const bool is_collision = name.View() == L"AAC-setup" || name.View() == L"AAC-setup.exe";
      if ((!is_folder && !is_file && !is_collision) || offscreen) continue;
      const POINT point = Center(bounds);
      const auto started = std::chrono::steady_clock::now();
      const auto current = [&] { return std::chrono::steady_clock::now() - started <
          std::chrono::milliseconds(800); };
      const auto measured = ReadWindowsExplorerShellView(parent, current, &point);
      if (is_folder) {
        if (localized_collision) {
          const std::string stage = windows_explorer_item_stage_for_test;
          if (measured.item || !current() ||
              (stage != "uia_name_uniqueness" && stage != "pidl_classification_and_sibling_scan")) {
            std::cout << "ITEM_DIAGNOSTIC stage=" << stage << std::endl;
            return Fail(66, "explorer_sibling_localized_collision_refused");
          }
          folder_checked = true;
          ++localized_hits;
          continue;
        }
        if (!measured.item || measured.item->kind != "folder" || measured.item->pidl_digest.size() != 64 ||
            NormalizeExplorerPath(measured.item->path) != NormalizeExplorerPath(scratch + L"\\AAA-MeasuredChild"))
        {
          std::cout << "ITEM_DIAGNOSTIC present=" << measured.item.has_value()
                    << " stage=" << windows_explorer_item_stage_for_test
                    << " view=" << static_cast<int>(measured.refusal)
                    << " folder=" << static_cast<int>(measured.folder_refusal);
          if (measured.item) std::cout << " kind=" << measured.item->kind
              << " path=" << Utf8FromWide(measured.item->path)
              << " digest_length=" << measured.item->pidl_digest.size();
          std::cout << std::endl;
          return Fail(66, "explorer_item_is_measured_at_action_point");
        }
        if (!current()) return Fail(66, "explorer_item_deadline");
        // Dry-run the real pre-send guards. No cursor placement or SendInput: a
        // cursor/foreground mismatch is reported separately from the age budget.
        DWORD pid = 0;
        GetWindowThreadProcessId(parent, &pid);
        WindowsSession sending;
        if (!BindExplorerSession(parent, pid, &sending)) return Fail(66, "send_freshness_bind");
        struct ReleaseSending {
          WindowsSession &session;
          ~ReleaseSending() { ReleaseWindowsSessionResources(&session); }
        } release_sending{sending};
        sending.active_window = parent;
        HWND owner = nullptr;
        if (WindowsExplorerPointRefusal(parent, measured.view, pid, point, &owner) != Refusal::kNone)
          return Fail(66, "send_freshness_point");
        auto evidence = std::make_shared<WindowsExplorerDispatchEvidence>(
            WindowsExplorerDispatchEvidence{parent, measured.view, owner, pid, point,
                measured.folder, sending.cancel_epoch, WindowsValidationFrameStopSerial(),
                sending.input_api_attempts, false, measured.item});
        DWORD tick = 0;
        if (!WindowsReadLastInputTick(&tick)) return Fail(66, "send_freshness_tick");
        const auto screen = ReadWindowsExplorerVirtualScreen();
        WindowsExplorerSendContext context{evidence, point, tick,
            RECT{screen.left, screen.top, screen.width, screen.height}};
        INPUT events[3]{};
        if (!WindowsExplorerAbsoluteMove(point, screen, &events[0]))
          return Fail(66, "send_freshness_move");
        events[1].type = events[2].type = INPUT_MOUSE;
        events[1].mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
        events[2].mi.dwFlags = MOUSEEVENTF_LEFTUP;
        std::uint64_t checked_at = 0;
        const bool rechecked = RecheckWindowsExplorerBeforeSend(sending, &context, 3, events, &checked_at);
        bool still_current = false;
        std::uint64_t finished = 0;
        {
          std::lock_guard lock(WindowsTargetListControl().stop_mutex);
          still_current = rechecked && WindowsRoundTripMayInput(sending) &&
              !WindowsSemanticInputInFlightLocked() &&
              WindowsExplorerSendStillCurrent(sending, context, checked_at);
          finished = MonotonicNowNs();
        }
        std::cout << "INFO explorer_send_freshness fixture=" << (large ? "Bulk" : "small")
                  << " hit_to_check_ms=" << (rechecked ? windows_explorer_hit_to_check_ns_for_test / 1e6 : -1.0)
                  << " explorer_send_freshness_ms="
                  << (checked_at && finished >= checked_at ? (finished - checked_at) / 1e6 : -1.0)
                  << " measurement_to_check_ms="
                  << std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count()
                  << " rechecked=" << rechecked << " still_current=" << still_current
                  << " input_sent=0" << std::endl;
        if (!rechecked) {
          if (IsProcessElevated(pid))
            std::cout << "NOT_RUN explorer_send_freshness approval_or_elevation\n";
          else return Fail(66, "send_freshness_recheck");
        } else if (!checked_at || finished < checked_at ||
            finished - checked_at > kWindowsExplorerSendFreshnessNs) {
          return Fail(66, "send_freshness_over_50ms");
        }
        if (large) std::cout << "OK explorer_large_folder_deadline elapsed_ms="
                  << std::chrono::duration_cast<std::chrono::milliseconds>(
                      std::chrono::steady_clock::now() - started).count() << std::endl;
        folder_checked = true;
      } else if (is_collision) {
        if (measured.item || (std::string(windows_explorer_item_stage_for_test) != "file_refused" &&
            std::string(windows_explorer_item_stage_for_test) != "attributes_or_display_collision" &&
            std::string(windows_explorer_item_stage_for_test) != "uia_name_uniqueness"))
          return Fail(66, "explorer_hidden_folder_executable_collision");
        std::cout << "INFO explorer_hidden_folder_executable_collision stage="
                  << windows_explorer_item_stage_for_test << '\n';
        collision_checked = true;
      } else {
        if (measured.item || std::string(windows_explorer_item_stage_for_test) != "file_refused")
          return Fail(66, "explorer_file_item_refused");
        file_checked = true;
      }
    }
    // The small fixture must exercise actual file classification, including hidden extensions.
    if (localized_collision) {
      std::cout << (localized_hits == 2 ? "OK explorer_sibling_localized_collision_refused\n"
          : "NOT_RUN explorer_item_fixture_not_visible localized\n");
      return 0;
    }
    std::cout << (folder_checked ? "OK explorer_item_is_measured_at_action_point\n"
                                 : "NOT_RUN explorer_item_fixture_not_visible folder\n");
    if (!large) std::cout << (file_checked ? "OK explorer_file_item_refused\n"
                               : "NOT_RUN explorer_item_fixture_not_visible file\n");
    if (!large) std::cout << (collision_checked ? "OK explorer_hidden_folder_executable_collision\n"
        : "NOT_RUN explorer_item_fixture_not_visible collision\n");

  return 0;
}

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
  windows_v2_main_pid = GetCurrentProcessId();
  const std::wstring scratch = argv[1];

  // M3 and L2, on the file system only (no Explorer window).
  // A subfolder under a junction-like ancestor is not a plain folder. It is not opened in Explorer:
  // the shell cannot parse a child of such a junction, and Explorer would answer with an error
  // dialog that this test could not close as its own window.
  const auto add_folder = [](const std::wstring &path) {
    return CreateDirectoryW(path.c_str(), nullptr) != FALSE;
  };
  const std::wstring small_fixture = scratch + L"\\Small";
  if (!add_folder(small_fixture) || !add_folder(small_fixture + L"\\AAA-MeasuredChild") ||
      !WriteBytes(small_fixture + L"\\AAB-MeasuredFile.txt", "fixture") ||
      !add_folder(small_fixture + L"\\AAC-setup") ||
      !SetFileAttributesW((small_fixture + L"\\AAC-setup").c_str(), FILE_ATTRIBUTE_HIDDEN) ||
      !WriteBytes(small_fixture + L"\\AAC-setup.exe", "inert fixture"))
    return Fail(66, "item_fixture");
  const std::wstring bulk = scratch + L"\\Bulk";
  const std::wstring alias = scratch + L"\\Alias";
  if (!add_folder(alias) || !add_folder(alias + L"\\AAA-MeasuredChild") ||
      !add_folder(alias + L"\\Bar") ||
      !WriteBytes(alias + L"\\Bar\\desktop.ini", "[.ShellClassInfo]\r\nLocalizedResourceName=AAA-MeasuredChild\r\n") ||
      !SetFileAttributesW((alias + L"\\Bar").c_str(), FILE_ATTRIBUTE_READONLY))
    return Fail(66, "localized_item_fixture");
  if (!add_folder(bulk) || !add_folder(bulk + L"\\AAA-MeasuredChild")) return Fail(66, "bulk_fixture");
  // Keep the file fixture visible in the small folder.
  for (unsigned index = 0; index < 2000; ++index)
    if (!add_folder(bulk + L"\\ZZZ-Bulk-" + std::to_wstring(index)))
      return Fail(66, "large_folder_fixture");
  const std::wstring reparse = scratch + L"\\Reparse";
  if (CreateSymbolicLinkW(reparse.c_str(), scratch.c_str(),
          SYMBOLIC_LINK_FLAG_DIRECTORY | SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE)) {
    const int failed = ExpectFolder(reparse, Refusal::kReparsePoint, "prestart_reparse_folder", 65);
    if (!RemoveDirectoryW(reparse.c_str())) return Fail(65, "reparse_cleanup");
    if (failed) return failed;
  } else {
    std::cout << "NOT_RUN prestart_reparse_folder symlink_privilege\n";
  }
  const std::wstring junction_like = scratch + L"\\JunctionLike";
  if (!add_folder(junction_like) || !add_folder(junction_like + L"\\Sub") ||
      !WritePrivateProfileStringW(L".ShellClassInfo", L"CLSID",
          L"{21EC2020-3AEA-1069-A2DD-08002B30309D}", (junction_like + L"\\desktop.ini").c_str()) ||
      !SetFileAttributesW(junction_like.c_str(), FILE_ATTRIBUTE_READONLY | FILE_ATTRIBUTE_SYSTEM))
    return Fail(30, "junction_like_fixture");
  PIDLIST_ABSOLUTE parsed = nullptr;
  const HRESULT parse = SHParseDisplayName((junction_like + L"\\Sub").c_str(), nullptr, &parsed, 0, nullptr);
  CoTaskMemFree(parsed);
  std::cout << "NOTE junction_like_child_parse=0x" << std::hex << static_cast<unsigned long>(parse)
            << std::dec << std::endl;
  if (int failed = ExpectFolder(junction_like + L"\\Sub", Refusal::kAncestorShellClass,
                                "junction_like_child", 30)) return failed;
  const std::wstring wide_ini = scratch + L"\\WideIni";
  if (!add_folder(wide_ini) || !add_folder(wide_ini + L"\\Sub") ||
      !WriteBytes(wide_ini + L"\\desktop.ini",
          Utf16Le(L"[.shellclassinfo]\r\n  uiclsid = {21EC2020-3AEA-1069-A2DD-08002B30309D}\r\n")))
    return Fail(31, "wide_ini_fixture");
  if (int failed = ExpectFolder(wide_ini + L"\\Sub", Refusal::kAncestorShellClass, "wide_ini_child", 31))
    return failed;
  const std::wstring clsid2 = scratch + L"\\Clsid2";
  if (!add_folder(clsid2) || !add_folder(clsid2 + L"\\Sub") ||
      !WriteBytes(clsid2 + L"\\desktop.ini", "[.ShellClassInfo]\r\nCLSID2={0AFACED1-E828-11D1-9187-B532F1E9575D}\r\n"))
    return Fail(32, "clsid2_fixture");
  if (int failed = ExpectFolder(clsid2 + L"\\Sub", Refusal::kAncestorShellClass, "clsid2_child", 32))
    return failed;
  // A UTF-8 byte order mark and CR-only line ends do not hide the section or the key.
  const std::wstring bom_cr = scratch + L"\\BomCr";
  if (!add_folder(bom_cr) || !add_folder(bom_cr + L"\\Sub") ||
      !WriteBytes(bom_cr + L"\\desktop.ini",
          "\xEF\xBB\xBF[.ShellClassInfo]\rIconResource=x\rCLSID={21EC2020-3AEA-1069-A2DD-08002B30309D}\r"))
    return Fail(36, "bom_cr_fixture");
  if (int failed = ExpectFolder(bom_cr + L"\\Sub", Refusal::kAncestorShellClass, "bom_cr_child", 36))
    return failed;
  // An ancestor that only localizes its name (as C:\Users does) stays a plain ancestor.
  const std::wstring localized = scratch + L"\\Localized";
  if (!add_folder(localized) || !add_folder(localized + L"\\Sub") ||
      !WriteBytes(localized + L"\\desktop.ini",
          "[.ShellClassInfo]\r\nLocalizedResourceName=Localized\r\n[Other]\r\nCLSID={21EC2020-3AEA-1069-A2DD-08002B30309D}\r\n"))
    return Fail(33, "localized_fixture");
  if (int failed = ExpectFolder(localized + L"\\Sub", Refusal::kNone, "localized_child", 33)) return failed;
  // An ancestor desktop.ini that cannot be read (here a directory of that name) is refused.
  const std::wstring unreadable = scratch + L"\\Unreadable";
  if (!add_folder(unreadable) || !add_folder(unreadable + L"\\desktop.ini") ||
      !add_folder(unreadable + L"\\Sub"))
    return Fail(34, "unreadable_fixture");
  if (int failed = ExpectFolder(unreadable + L"\\Sub", Refusal::kAncestorIniUnreadable,
                                "unreadable_child", 34)) return failed;
  // L2: a drive that is not a fixed local disk (here one with no root) is refused by its type.
  const DWORD drives = GetLogicalDrives();
  for (wchar_t letter = L'Z'; letter >= L'D'; --letter) {
    if (drives & (1u << (letter - L'A'))) continue;
    const std::wstring missing = std::wstring(1, letter) + L":\\Folder";
    if (int failed = ExpectFolder(missing, Refusal::kNotFixedDrive, "not_fixed_drive", 35)) return failed;
    break;
  }

  for (const auto &fixture : {small_fixture, bulk, alias}) {
    OpenedExplorer opened;
    HWND window = opened.Open(fixture);
    if (!window) return opened.shared ? 0 : Fail(66, "item_fixture_open");
    if (!opened.Exclusive()) { std::cout << "NOT_RUN explorer_tab_shared\n"; return 0; }
    ShowWindow(window, SW_RESTORE); SetForegroundWindow(window); BringWindowToTop(window);
    const auto view = ReadWindowsExplorerShellView(window, [] { return true; });
    if (int failed = CheckMeasuredItems(window, view, fixture, fixture == bulk, fixture == alias)) return failed;
  }
  {
    // The scratch folder: the full measurement through the production dispatch.
    OpenedExplorer opened;
    HWND parent = opened.Open(scratch);
    if (parent == nullptr) return opened.shared ? 0 : Fail(11, "scratch_open");
    DWORD parent_pid = 0;
    GetWindowThreadProcessId(parent, &parent_pid);
    if (int failed = ExpectView(parent, Refusal::kNone, "scratch_view", 3)) return failed;
    const auto view = ReadWindowsExplorerShellView(parent, [] { return true; });
    if (!view.folder.has_value() || NormalizeExplorerPath(*view.folder) != NormalizeExplorerPath(scratch) ||
        view.view == nullptr) return Fail(3, "scratch_view_path");
    if (!opened.Exclusive()) { std::cout << "NOT_RUN explorer_tab_shared" << std::endl; return 0; }
    ShowWindow(parent, SW_RESTORE);
    SetForegroundWindow(parent);
    BringWindowToTop(parent);
    RECT view_rect{}, window_rect{};
    if (!GetWindowRect(view.view, &view_rect) || !GetWindowRect(parent, &window_rect))
      return Fail(12, "view_rect");
    const POINT inside = Center(view_rect);
    POINT title{Center(window_rect).x, window_rect.top + 12};
    POINT navigation{view_rect.left - 40, inside.y};
    const auto in_window = [&](POINT point) {
      const HWND hit = WindowFromPoint(point);
      return hit != nullptr && GetAncestor(hit, GA_ROOT) == parent;
    };
    if (!in_window(inside)) { std::cout << "NOT_RUN explorer_window_covered" << std::endl; return 0; }

    if (int failed = CheckExplorerPrestart(parent, parent_pid, view.view)) return failed;

    ExplorerPipe pipe;
    if (!pipe.Connect()) return Fail(40, "pipe");
    WindowsSession session;
    if (!BindExplorerSession(parent, parent_pid, &session)) return Fail(40, "bind_session");
    const std::uint64_t epoch = session.cancel_epoch;
    sessions.emplace(FrameIdKey(pipe.frame.header.session_id), std::move(session));
    struct Sessions {
      ~Sessions() {
        for (auto &entry : sessions) ReleaseWindowsSessionResources(&entry.second);
        sessions.clear();
      }
    } bound_sessions;
    const auto dispatch = [&](POINT point, bool *probe_result, std::string *text) {
      return pipe.Exchange(MeasureMetadata(parent, epoch, point), text, probe_result);
    };
    std::string text;
    bool probe_result = false;
    // An elevated explorer.exe (a CI runner as an administrator without UAC) fails the session
    // identity by design, so the dispatch cases cannot reach the view there: NOT_RUN, not FAIL.
    const bool explorer_elevated = IsProcessElevated(parent_pid);
    if (explorer_elevated) {
      if (!dispatch(inside, &probe_result, &text) || probe_result ||
          windows_explorer_trace_for_test.request != Refusal::kIdentity)
        return FailReason(41, "dispatch_elevated_identity", windows_explorer_trace_for_test.request,
                          Refusal::kIdentity);
      std::cout << "NOT_RUN explorer_elevated_dispatch" << std::endl;
    } else {
      // Positive: the dispatch reaches ReadWindowsExplorerShellView and the point is in the view.
      if (!dispatch(inside, &probe_result, &text) || !probe_result ||
          text.find("\"kind\":\"filesystem_folder\"") == std::string::npos ||
          text.find("\"pointOwnerMatches\":true") == std::string::npos ||
          windows_explorer_trace_for_test.request != Refusal::kNone ||
          windows_explorer_trace_for_test.view != Refusal::kNone ||
          windows_explorer_trace_for_test.point != Refusal::kNone) {
        std::cout << "TRACE request=" << static_cast<int>(windows_explorer_trace_for_test.request)
                  << " view=" << static_cast<int>(windows_explorer_trace_for_test.view)
                  << " point=" << static_cast<int>(windows_explorer_trace_for_test.point) << std::endl;
        return Fail(41, "dispatch_positive");
      }
    }
    // M1: the title/tab strip and the navigation pane belong to explorer.exe but not to the view.
    // Checked directly (no session identity), and through the dispatch where it can run.
    for (const auto &[point, what] : {std::pair{title, "title_point"}, std::pair{navigation, "navigation_point"}}) {
      if (point.x <= window_rect.left + 4 || !in_window(point)) {
        std::cout << "NOTE " << what << " outside the window" << std::endl;
        continue;
      }
      if (const auto reason = WindowsExplorerPointRefusal(parent, view.view, parent_pid, point);
          reason != Refusal::kPointOutsideView)
        return FailReason(42, what, reason, Refusal::kPointOutsideView);
      if (explorer_elevated) continue;
      if (!dispatch(point, &probe_result, &text) || !probe_result ||
          text.find("\"pointOwnerMatches\":false") == std::string::npos ||
          text.find("\"kind\":\"filesystem_folder\"") == std::string::npos)
        return Fail(42, what);
      if (windows_explorer_trace_for_test.point != Refusal::kPointOutsideView)
        return FailReason(42, what, windows_explorer_trace_for_test.point, Refusal::kPointOutsideView);
    }
    // M1: a measured view that is not the visible one (an inactive tab, or a tab that is not yet
    // in IShellWindows while another is shown) cannot be tied to the active tab.
    ShowWindow(view.view, SW_HIDE);
    const int hidden = ExpectView(parent, Refusal::kActiveTabUnbound, "hidden_view", 43);
    ShowWindow(view.view, SW_SHOW);
    if (hidden != 0) return hidden;
    if (int failed = ExpectView(parent, Refusal::kNone, "restored_view", 43)) return failed;

    // A foreign-process child inside the view is not explorer.exe's.
    POINT corner{10, 10};
    if (!ClientToScreen(view.view, &corner)) return Fail(12, "view_corner");
    if (const auto reason = WindowsExplorerPointRefusal(parent, view.view, parent_pid, corner);
        reason != Refusal::kNone) return FailReason(12, "parent_point_owner", reason, Refusal::kNone);
    wchar_t self[32768]{};
    GetModuleFileNameW(nullptr, self, 32768);
    std::wstring command = L"\"" + std::wstring(self) + L"\" child " +
        std::to_wstring(reinterpret_cast<std::uintptr_t>(view.view));
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
      EnumChildWindows(view.view, [](HWND window, LPARAM parameter) -> BOOL {
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
    POINT point{10, 10};
    if (!ClientToScreen(search.window, &point)) return Fail(14, "foreign_child_point");
    // Explorer may still be laying out its view after the restore; keep the fixture on top of it.
    const ULONGLONG raised_until = GetTickCount64() + 3000;
    while (WindowFromPoint(point) != search.window && GetTickCount64() < raised_until) {
      SetWindowPos(search.window, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
      PumpExplorerMessages();
    }
    if (WindowFromPoint(point) != search.window) return Fail(14, "foreign_child_hit");
    if (const auto reason = WindowsExplorerPointRefusal(parent, view.view, parent_pid, point);
        reason != Refusal::kPointForeignOwner)
      return FailReason(14, "foreign_child_owner", reason, Refusal::kPointForeignOwner);
  }

  // Namespaces are never filesystem_folder: the Explorer-side folder is not CLSID_ShellFSFolder.
  for (const auto &[target, what] : {std::pair{std::wstring(L"shell:ControlPanelFolder"), "control_panel"},
                                     std::pair{std::wstring(L"shell:AppsFolder"), "apps_folder"}}) {
    OpenedExplorer opened;
    HWND window = opened.Open(target);
    if (window == nullptr) return opened.shared ? 0 : Fail(2, "explorer_open");
    if (int failed = ExpectView(window, Refusal::kNotShellFsFolder, what, 3)) return failed;
  }
  const auto junction = scratch + L"\\Panel.{21EC2020-3AEA-1069-A2DD-08002B30309D}";
  Refusal junction_reason = Refusal::kNone;
  if (!CreateDirectoryW(junction.c_str(), nullptr) || WindowsExplorerPlainFolder(junction, &junction_reason) ||
      junction_reason != Refusal::kJunctionName) return Fail(5, "junction_fixture");
  {
    OpenedExplorer opened;
    HWND window = opened.Open(junction);
    if (window == nullptr) return opened.shared ? 0 : Fail(6, "junction_open");
    // Explorer shows this directory with the file-system folder class; its .{CLSID} name refuses it.
    if (int failed = ExpectView(window, Refusal::kNotPlainFolder, "junction_view", 6,
                                Refusal::kJunctionName)) return failed;
  }
  const auto customized = scratch + L"\\Customized";
  if (!CreateDirectoryW(customized.c_str(), nullptr)) return Fail(7, "customized_fixture");
  const auto ini = customized + L"\\desktop.ini";
  if (!WritePrivateProfileStringW(L".ShellClassInfo", L"CLSID",
      L"{21EC2020-3AEA-1069-A2DD-08002B30309D}", ini.c_str())) return Fail(8, "desktop_ini");
  SetFileAttributesW(customized.c_str(), FILE_ATTRIBUTE_READONLY);
  if (int failed = ExpectFolder(customized, Refusal::kViewedDesktopIni, "customized_folder", 9)) return failed;
  {
    OpenedExplorer opened;
    HWND window = opened.Open(customized);
    if (window == nullptr) return opened.shared ? 0 : Fail(10, "customized_open");
    if (int failed = ExpectView(window, Refusal::kNotShellFsFolder, "customized_view", 10)) return failed;
  }
  std::cout << "OK Explorer view and foreign child\n";
  return 0;
}
