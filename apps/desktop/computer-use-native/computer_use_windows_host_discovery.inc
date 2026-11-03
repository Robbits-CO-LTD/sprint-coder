bool ScreenBoundsPhysicalForWindow(HWND window, RECT *bounds) {
  return window != nullptr && ClientBoundsPhysical(window, bounds);
}

std::string RectJson(const RECT &bounds) {
  return "{\"x\":" + std::to_string(bounds.left) +
         ",\"y\":" + std::to_string(bounds.top) +
         ",\"width\":" +
         std::to_string(bounds.right - bounds.left) +
         ",\"height\":" +
         std::to_string(bounds.bottom - bounds.top) + "}";
}

// BEGIN windows package identity (#500 S5-c-3 PR-4)
// The v2 identity of a package target. A Store or System signed package under WindowsApps is
// identified by its family, its publisherId and the image's path inside the package
// (WindowsPackageIdentityFor), so an ordinary Store update, which moves the versioned install
// directory and the bytes, keeps the identity, while another publisher, or another image in the
// same package, does not. Every other target keeps the Win32 identity. v2 builds only: a v1 build
// always answers std::nullopt, and the V1 identity (BuildLockedWindowsExecutableIdentity) and its
// JSON (WindowsIdentityJson) stay byte for byte what they were. Nothing calls this yet: PR-5 uses
// it for list_targets and the v2 start, resume and per-input checks. The executable identity must
// be of the very file the facts held (file id and path), and the running image must have matched,
// or there is no package identity.
struct WindowsPackageIdentity {
  std::string family;
  std::string publisher_id;
  std::string relative_path;
  std::string identity_digest;
};

std::optional<WindowsPackageIdentity>
WindowsTargetPackageIdentity(const WindowsTargetFactsMeasurement &measured,
                             const WindowsExecutableIdentity &identity) {
  if constexpr (!sprint_coder::computer_use::kNativeEligibilityIsV2) {
    (void)measured;
    (void)identity;
    return std::nullopt;
  } else {
    if (measured.facts.running_image_matches != std::optional<bool>(true) ||
        !measured.file_identity.has_value() ||
        !SameWindowsFileIdentity(*measured.file_identity, identity.file_identity) ||
        !SameWindowsTargetName(measured.image_path, identity.path))
      return std::nullopt;
    // The relative path is taken from the path the JSON carries, so Main's suffix check reads the
    // same string.
    const std::optional<sprint_coder::computer_use::WindowsPackageIdentityParts> parts =
        sprint_coder::computer_use::WindowsPackageIdentityFor(
            {measured.facts.packaged, measured.facts.package_signature_kind,
             measured.facts.package_development_mode, measured.facts.package_family,
             measured.package_publisher_id, measured.facts.image_root, identity.path_utf8,
             measured.package_install_root});
    if (!parts.has_value())
      return std::nullopt;
    return WindowsPackageIdentity{parts->family, parts->publisher_id, parts->relative_path,
                                  Sha256String(parts->preimage)};
  }
}

// The identity JSON of a package target: WindowsIdentityJson's fields, with the package digest as
// identityDigest, no signer digest (the package signature, not an embedded one, is what the
// identity rests on), and the family, publisherId and package-relative path that Main recomputes
// the digest from (computerAppNativeIdentityDigest). The mode is the v2 core's, given by PR-5.
std::string WindowsPackageIdentityJson(const WindowsExecutableIdentity &identity,
                                       const WindowsPackageIdentity &package,
                                       std::string_view maximum_mode, std::uint32_t pid = 0) {
  return "{\"platform\":\"win32\",\"identityDigest\":\"" + package.identity_digest +
         "\",\"executablePath\":\"" + JsonEscape(identity.path_utf8) +
         "\",\"executableDigest\":\"" + identity.executable_digest +
         "\",\"signerDigest\":null,\"packageFamilyName\":\"" + JsonEscape(package.family) +
         "\",\"packagePublisherId\":\"" + JsonEscape(package.publisher_id) +
         "\",\"packageRelativePath\":\"" + JsonEscape(package.relative_path) +
         "\",\"appUserModelId\":null,\"displayName\":\"" + JsonEscape(identity.display_name) +
         "\",\"policyLanguage\":\"" + identity.policy_language + "\",\"maximumMode\":\"" +
         JsonEscape(maximum_mode) + "\"" + (pid == 0 ? "" : ",\"pid\":" + std::to_string(pid)) +
         "}";
}
// END windows package identity

// Defined with the discovery measurement (discovery_worker.inc), which registers cancellable I/O.
bool MeasureWindowsPickedIdentity(const std::wstring& path, WindowsExecutableIdentity* identity,
                                  std::uint64_t serial);

std::string WindowsIdentityJson(const WindowsExecutableIdentity &identity,
                                std::uint32_t pid = 0) {
  return "{\"platform\":\"win32\",\"identityDigest\":\"" +
         identity.identity_digest + "\",\"executablePath\":\"" +
         JsonEscape(identity.path_utf8) + "\",\"executableDigest\":\"" +
         identity.executable_digest + "\",\"signerDigest\":" +
         (identity.signer_digest.empty()
              ? "null"
              : "\"" + identity.signer_digest + "\"") +
         ",\"packageFamilyName\":null,\"appUserModelId\":null,\"displayName\":"
         "\"" +
         JsonEscape(identity.display_name) + "\"" +
         ",\"policyLanguage\":\"" + identity.policy_language + "\"" +
         ",\"maximumMode\":\"" + MaximumModeForWindowsExecutable(identity) +
         "\"" +
         (pid == 0 ? "" : ",\"pid\":" + std::to_string(pid)) + "}";
}

bool PickWindowsExecutable(std::string *response, std::string *reason,
                           std::uint64_t serial) {
  if (WindowsTargetListWorkerRunning().load(std::memory_order_acquire)) {
    *reason = "picker_unavailable";
    return false;
  }
  IFileOpenDialog *dialog = nullptr;
  if (FAILED(CoCreateInstance(CLSID_FileOpenDialog, nullptr,
                              CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dialog))) ||
      dialog == nullptr) {
    *reason = "picker_unavailable";
    return false;
  }
  DWORD options = 0;
  dialog->GetOptions(&options);
  dialog->SetOptions(options | FOS_FILEMUSTEXIST | FOS_PATHMUSTEXIST |
                     FOS_FORCEFILESYSTEM | FOS_DONTADDTORECENT |
                     FOS_NODEREFERENCELINKS);
  const COMDLG_FILTERSPEC filters[] = {{L"Applications", L"*.exe"}};
  dialog->SetFileTypes(1, filters);
  dialog->SetDefaultExtension(L"exe");
  const HRESULT shown = dialog->Show(nullptr);
  if (shown == HRESULT_FROM_WIN32(ERROR_CANCELLED)) {
    dialog->Release();
    *response = "null";
    return true;
  }
  if (FAILED(shown)) {
    dialog->Release();
    *reason = "picker_failed";
    return false;
  }
  IShellItem *item = nullptr;
  PWSTR selected_path = nullptr;
  const bool selected =
      SUCCEEDED(dialog->GetResult(&item)) && item != nullptr &&
      SUCCEEDED(item->GetDisplayName(SIGDN_FILESYSPATH, &selected_path)) &&
      selected_path != nullptr;
  if (item != nullptr)
    item->Release();
  dialog->Release();
  if (!selected) {
    if (selected_path != nullptr)
      CoTaskMemFree(selected_path);
    *reason = "picker_selection_invalid";
    return false;
  }
  const std::wstring path(selected_path);
  CoTaskMemFree(selected_path);
  if (path.size() < 5 ||
      _wcsicmp(path.c_str() + path.size() - 4, L".exe") != 0) {
    *reason = "picker_selection_invalid";
    return false;
  }
  WindowsExecutableIdentity identity;
  if (!MeasureWindowsPickedIdentity(path, &identity, serial)) {
    *reason = "identity_unavailable";
    return false;
  }
  if (!IsSupportedWindowsV1Target(identity) ||
      IsDisallowedTargetExecutable(identity.path) ||
      IsKnownProxyExecutable(identity.path)) {
    *reason = "target_application_unsupported";
    return false;
  }
  *response = WindowsIdentityJson(identity);
  return true;
}

bool SameWindowsPath(const std::wstring &left, const std::wstring &right) {
  return left.size() == right.size() &&
         CompareStringOrdinal(left.c_str(), static_cast<int>(left.size()),
                              right.c_str(), static_cast<int>(right.size()),
                              TRUE) == CSTR_EQUAL;
}

bool ReadProcessStartIdentity(HANDLE process, std::string *output) {
  if (process == nullptr || output == nullptr)
    return false;
  FILETIME created{}, exited{}, kernel{}, user{};
  const bool read =
      GetProcessTimes(process, &created, &exited, &kernel, &user) == TRUE;
  if (!read)
    return false;
  ULARGE_INTEGER ticks{};
  ticks.LowPart = created.dwLowDateTime;
  ticks.HighPart = created.dwHighDateTime;
  *output = std::to_string(ticks.QuadPart);
  return true;
}

bool ReadProcessStartIdentity(std::uint32_t pid, std::string *output) {
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (process == nullptr)
    return false;
  const bool read = ReadProcessStartIdentity(process, output);
  CloseHandle(process);
  return read;
}

// BEGIN windows target identity
constexpr std::size_t kMaxWindowsTargetIdentities = 64;
struct WindowsTargetIdentity {
  DWORD pid = 0;
  std::string process_start;
};

bool ReadWindowsTargetIdentities(std::string_view metadata,
                                 std::vector<WindowsTargetIdentity>* output) {
  std::size_t cursor = 0;
  const auto space = [&] {
    while (cursor < metadata.size() && (metadata[cursor] == ' ' || metadata[cursor] == '\t' ||
           metadata[cursor] == '\r' || metadata[cursor] == '\n')) ++cursor;
  };
  const auto token = [&](char expected) {
    space();
    if (cursor >= metadata.size() || metadata[cursor] != expected) return false;
    ++cursor; return true;
  };
  const auto string = [&](std::string* value) {
    space(); return ReadJsonStringValueAt(metadata, &cursor, value);
  };
  const auto decimal = [](std::string_view value, std::uint64_t maximum) {
    if (value.empty() || value.size() > 20 || value.front() < '1' || value.front() > '9') return false;
    std::uint64_t number = 0;
    for (const char character : value) {
      if (character < '0' || character > '9') return false;
      const auto digit = static_cast<std::uint64_t>(character - '0');
      if (number > (maximum - digit) / 10) return false;
      number = number * 10 + digit;
    }
    return true;
  };
  std::vector<WindowsTargetIdentity> targets;
  if (!token('{')) return false;
  bool operation_seen = false, targets_seen = false;
  for (int member = 0; member < 2; ++member) {
    std::string key;
    if (!string(&key) || !token(':')) return false;
    if (key == "operation" && !operation_seen) {
      std::string operation;
      if (!string(&operation) || operation != "check_target_identity") return false;
      operation_seen = true;
    } else if (key == "targets" && !targets_seen) {
      targets_seen = true;
      if (!token('[')) return false;
      space();
      if (cursor < metadata.size() && metadata[cursor] != ']') {
        for (;;) {
          if (targets.size() == kMaxWindowsTargetIdentities || !token('{')) return false;
          WindowsTargetIdentity target;
          bool pid_seen = false, start_seen = false;
          for (int field = 0; field < 2; ++field) {
            std::string name;
            if (!string(&name) || !token(':')) return false;
            if (name == "pid" && !pid_seen) {
              space(); const auto begin = cursor;
              while (cursor < metadata.size() && metadata[cursor] >= '0' && metadata[cursor] <= '9') ++cursor;
              const auto value = metadata.substr(begin, cursor - begin);
              if (!decimal(value, std::numeric_limits<DWORD>::max())) return false;
              for (const char digit : value) target.pid = target.pid * 10 + static_cast<DWORD>(digit - '0');
              pid_seen = true;
            } else if (name == "processStartTime" && !start_seen) {
              if (!string(&target.process_start) ||
                  !decimal(target.process_start, std::numeric_limits<std::uint64_t>::max())) return false;
              start_seen = true;
            } else return false;
            if (!token(field == 0 ? ',' : '}')) return false;
          }
          if (!pid_seen || !start_seen) return false;
          targets.push_back(std::move(target));
          space();
          if (cursor < metadata.size() && metadata[cursor] == ']') break;
          if (!token(',')) return false;
        }
      }
      if (!token(']')) return false;
    } else return false;
    if (!token(member == 0 ? ',' : '}')) return false;
  }
  space();
  if (!operation_seen || !targets_seen || cursor != metadata.size()) return false;
  *output = std::move(targets);
  return true;
}

std::string WindowsTargetIdentityError(DWORD error) {
  return error == ERROR_ACCESS_DENIED ? "access_denied" : "win32_error";
}

std::string CheckWindowsTargetIdentity(const WindowsTargetIdentity& target) {
  const auto unverifiable = [](DWORD error) {
    return "{\"result\":\"unverifiable\",\"reason\":\"" + WindowsTargetIdentityError(error) + "\"}";
  };
  HANDLE process = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, target.pid);
  if (process == nullptr) {
    const DWORD error = GetLastError();
    if (error == ERROR_INVALID_PARAMETER) return "{\"result\":\"terminated\",\"reason\":\"no_process\"}";
    return unverifiable(error);
  }
  struct ProcessScope {
    HANDLE handle;
    ~ProcessScope() { CloseHandle(handle); }
  } scope{process};
  const DWORD wait = WaitForSingleObject(process, 0);
  if (wait == WAIT_OBJECT_0) return "{\"result\":\"terminated\",\"reason\":\"signaled\"}";
  if (wait != WAIT_TIMEOUT) return unverifiable(wait == WAIT_FAILED ? GetLastError() : ERROR_GEN_FAILURE);
  std::string start;
  if (!ReadProcessStartIdentity(process, &start)) return unverifiable(GetLastError());
  if (start != target.process_start) return "{\"result\":\"terminated\",\"reason\":\"start_time_mismatch\"}";
  return "{\"result\":\"alive\"}";
}

bool CheckWindowsTargetIdentities(std::string_view metadata, std::string* response) {
  std::vector<WindowsTargetIdentity> targets;
  // Validate the entire bounded request before opening any process.
  if (!ReadWindowsTargetIdentities(metadata, &targets)) return false;
  std::string result = "{\"results\":[";
  for (std::size_t index = 0; index < targets.size(); ++index) {
    if (index != 0) result += ',';
    result += CheckWindowsTargetIdentity(targets[index]);
  }
  *response = result + "]}";
  return true;
}
// END windows target identity

// Keep the identity check's strict decimal contract without opening a process.
bool ReadWindowsStartIdentity(const std::string& metadata, std::string* process_start) {
  bool required = false;
  process_start->clear();
  if (!ReadOptionalJsonBoolean(metadata, "requireStartIdentity", &required)) return false;
  const bool has_expected = metadata.find("\"expectedProcessStartTime\"") != std::string::npos;
  if (!required) return !has_expected;
  const std::string key = "\"expectedProcessStartTime\"";
  const auto first = metadata.find(key);
  if (first == std::string::npos || metadata.find(key, first + key.size()) != std::string::npos) return false;
  std::size_t cursor = first + key.size();
  const auto space = [&] {
    while (cursor < metadata.size() && (metadata[cursor] == ' ' || metadata[cursor] == '\t' ||
           metadata[cursor] == '\r' || metadata[cursor] == '\n')) ++cursor;
  };
  space();
  if (cursor >= metadata.size() || metadata[cursor++] != ':') return false;
  space();
  std::string value;
  if (!ReadJsonStringValueAt(metadata, &cursor, &value) ||
      value.empty() || value.front() < '1' || value.front() > '9' ||
      !std::all_of(value.begin(), value.end(), [](char c) { return c >= '0' && c <= '9'; }))
    return false;
  space();
  if (cursor >= metadata.size() || (metadata[cursor] != ',' && metadata[cursor] != '}')) return false;
  std::uint64_t ticks = 0;
  const auto parsed = std::from_chars(value.data(), value.data() + value.size(), ticks);
  if (parsed.ec != std::errc{} || parsed.ptr != value.data() + value.size()) return false;
  *process_start = std::move(value);
  return true;
}

struct WindowsStartResult {
  std::uint32_t pid = 0;
  std::string process_start;
  std::uint64_t attempt_count = 0;
  bool execution_unknown = false;
};

WindowsStartResult ReadWindowsStartResult(const std::string& metadata) {
  WindowsStartResult result;
  std::uint64_t pid = 0;
  if (ReadWindowsStartIdentity(metadata, &result.process_start) &&
      ReadJsonUint64(metadata, "pid", &pid) && pid > 0 &&
      pid <= std::numeric_limits<DWORD>::max())
    result.pid = static_cast<DWORD>(pid);
  else result.process_start.clear();
  return result;
}

std::string AppendWindowsStartResult(std::string payload, const WindowsStartResult& start_result,
                                    bool succeeded) {
  if (start_result.process_start.empty() || payload.empty() || payload.back() != '}') return payload;
  const char* outcome = start_result.execution_unknown ? "unconfirmed" :
      start_result.attempt_count == 0 ? "not_attempted" :
      succeeded ? "confirmed" : "unconfirmed";
  payload.pop_back();
  return payload + ",\"startResult\":{\"pid\":" + std::to_string(start_result.pid) +
      ",\"processStartTime\":\"" + start_result.process_start +
      "\",\"attemptCount\":" + std::to_string(start_result.attempt_count) +
      ",\"foregroundResult\":\"" + outcome + "\"}}";
}

bool CheckWindowsStartFocusIdentity(HANDLE process, std::uint32_t pid,
                                    const std::string& expected_start,
                                    const std::string& held_start, HWND window,
                                    HWND focus_window, const std::string& app_identity,
                                    const std::string& expected_window_identity) {
  if (expected_start.empty()) return true; // Legacy starts have not opted into this contract.
  std::string actual_start;
  DWORD window_pid = 0, focus_pid = 0;
  return expected_start == held_start && process != nullptr &&
      GetProcessId(process) == pid && WaitForSingleObject(process, 0) == WAIT_TIMEOUT &&
      ReadProcessStartIdentity(process, &actual_start) && actual_start == expected_start &&
      IsWindow(window) && GetWindowThreadProcessId(window, &window_pid) != 0 && window_pid == pid &&
      IsWindow(focus_window) && GetWindowThreadProcessId(focus_window, &focus_pid) != 0 && focus_pid == pid &&
      Sha256String("computer-window-identity-v1\n" + app_identity + "\n" + actual_start + "\n" +
          std::to_string(static_cast<std::uint64_t>(reinterpret_cast<UINT_PTR>(window)))) ==
          expected_window_identity;
}

bool WindowsSessionProcessMatches(const WindowsSession &session) {
  std::string process_start;
  return session.process_handle != nullptr &&
         GetProcessId(session.process_handle) == session.pid &&
         WaitForSingleObject(session.process_handle, 0) == WAIT_TIMEOUT &&
         ReadProcessStartIdentity(session.process_handle, &process_start) &&
         process_start == session.process_start;
}

struct WindowEnumerationContext {
  std::uint32_t pid = 0;
  std::string app_identity;
  std::string executable_digest;
  std::string process_start;
  std::string policy_language = "unknown";
  std::string maximum_mode = "observe_only";
  bool identity_matches = false;
  bool include_start_identity = false;
  bool elevated = true;
  bool proxy = false;
  std::vector<std::string> candidates;
  std::function<bool()> still_valid;
};

bool IsApplicationWindow(HWND window) {
  if (window == nullptr || GetWindow(window, GW_OWNER) != nullptr ||
      (GetWindowLongPtrW(window, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) != 0)
    return false;
  std::array<wchar_t, 64> class_name{};
  const int class_length = GetClassNameW(window, class_name.data(),
                                         static_cast<int>(class_name.size()));
  if (class_length <= 0 ||
      class_length >= static_cast<int>(class_name.size() - 1))
    return false;
  return _wcsicmp(class_name.data(), L"#32770") != 0;
}

bool ClientBoundsPhysical(HWND window, RECT *bounds) {
  RECT client{};
  POINT origin{};
  if (!GetClientRect(window, &client) || !ClientToScreen(window, &origin))
    return false;
  const LONG width = client.right - client.left;
  const LONG height = client.bottom - client.top;
  if (width <= 0 || height <= 0 || width > 32768 || height > 32768)
    return false;
  *bounds = {origin.x, origin.y, origin.x + width, origin.y + height};
  return true;
}

struct BoundWindowsDialog {
  HWND window = nullptr;
  HWND owner = nullptr;
  RECT bounds{};
  bool modal = false;
  std::string identity;
  std::wstring class_name;
};

struct WindowsDialogSetSnapshot {
  std::vector<BoundWindowsDialog> dialogs;
  std::string digest;
  HWND active_window = nullptr;
  RECT active_bounds{};
  std::string active_identity;
  std::string active_kind;
};

bool ReadWindowClass(HWND window, std::wstring *output) {
  if (window == nullptr || output == nullptr)
    return false;
  std::array<wchar_t, 256> class_name{};
  const int length = GetClassNameW(window, class_name.data(),
                                   static_cast<int>(class_name.size()));
  if (length <= 0 || length >= static_cast<int>(class_name.size() - 1))
    return false;
  output->assign(class_name.data(), static_cast<std::size_t>(length));
  return true;
}

bool IsOwnedByRootWindow(HWND window, HWND root, std::uint32_t pid,
                         HWND *direct_owner) {
  HWND current = window;
  HWND owner = nullptr;
  for (std::size_t depth = 0; depth < 16; ++depth) {
    owner = GetWindow(current, GW_OWNER);
    if (owner == nullptr)
      return false;
    if (depth == 0 && direct_owner != nullptr)
      *direct_owner = owner;
    DWORD owner_pid = 0;
    if (GetWindowThreadProcessId(owner, &owner_pid) == 0 || owner_pid != pid)
      return false;
    if (owner == root)
      return true;
    current = owner;
  }
  return false;
}

bool IsNativeTakeoverDialogClass(std::wstring_view class_name) {
  static constexpr std::array<std::wstring_view, 4> denied = {
      L"Credential Dialog Xaml Host", L"DirectUIHWND",
      L"ApplicationFrameWindow", L"Windows.UI.Core.CoreWindow"};
  for (const auto candidate : denied)
    if (_wcsicmp(std::wstring(class_name).c_str(), candidate.data()) == 0)
      return true;
  return false;
}

struct ShellDialogChildContext {
  bool found = false;
};

BOOL CALLBACK FindShellDialogChild(HWND window, LPARAM parameter) {
  auto *context = reinterpret_cast<ShellDialogChildContext *>(parameter);
  if (context == nullptr)
    return FALSE;
  std::wstring class_name;
  if (!ReadWindowClass(window, &class_name)) {
    context->found = true;
    return FALSE;
  }
  static constexpr std::array<std::wstring_view, 4> shell_classes = {
      L"SHELLDLL_DefView", L"DirectUIHWND", L"SysListView32",
      L"WorkerW"};
  for (const auto candidate : shell_classes) {
    if (_wcsicmp(class_name.c_str(), candidate.data()) == 0) {
      context->found = true;
      return FALSE;
    }
  }
  return TRUE;
}

bool IsNativeTakeoverDialog(HWND window, std::wstring_view class_name) {
  if (IsNativeTakeoverDialogClass(class_name))
    return true;
  if (_wcsicmp(std::wstring(class_name).c_str(), L"#32770") != 0)
    return false;
  ShellDialogChildContext child_context;
  EnumChildWindows(window, FindShellDialogChild,
                   reinterpret_cast<LPARAM>(&child_context));
  if (child_context.found)
    return true;
  std::array<wchar_t, 512> title{};
  const int length = GetWindowTextW(window, title.data(),
                                    static_cast<int>(title.size()));
  if (length < 0 || length >= static_cast<int>(title.size() - 1))
    return true;
  std::wstring normalized(title.data(), static_cast<std::size_t>(length));
  for (wchar_t &character : normalized)
    if (character >= L'A' && character <= L'Z')
      character = static_cast<wchar_t>(character + (L'a' - L'A'));
  static constexpr std::array<std::wstring_view, 13> denied_titles = {
      L"file picker", L"open file", L"save file", L"choose file",
      L"select file", L"select folder", L"administrator", L"security",
      L"credential", L"permission", L"installer", L"installation",
      L"user account control"};
  for (const auto term : denied_titles)
    if (normalized.find(term) != std::wstring::npos)
      return true;
  return false;
}

bool IsNativeTakeoverWindow(HWND window) {
  if (window == nullptr)
    return true;
  std::wstring class_name;
  if (!ReadWindowClass(window, &class_name) ||
      IsNativeTakeoverDialog(window, class_name))
    return true;
  DWORD pid = 0;
  std::wstring process_path;
  if (GetWindowThreadProcessId(window, &pid) == 0 || pid == 0 ||
      !ReadProcessPath(pid, &process_path))
    return true;
  const auto slash = process_path.find_last_of(L"\\/");
  const std::wstring leaf = slash == std::wstring::npos
                                ? process_path
                                : process_path.substr(slash + 1);
  static constexpr std::array<std::wstring_view, 7> denied_processes = {
      L"consent.exe", L"CredentialUIBroker.exe", L"SystemSettings.exe",
      L"msiexec.exe", L"setup.exe", L"install.exe", L"installer.exe"};
  for (const auto candidate : denied_processes)
    if (_wcsicmp(leaf.c_str(), candidate.data()) == 0)
      return true;
  return false;
}

struct DialogEnumerationContext {
  const WindowsSession *session = nullptr;
  std::vector<BoundWindowsDialog> dialogs;
  bool invalid = false;
  bool user_takeover = false;
};

BOOL CALLBACK CollectBoundWindowsDialog(HWND window, LPARAM parameter) {
  auto *context = reinterpret_cast<DialogEnumerationContext *>(parameter);
  if (context == nullptr || context->session == nullptr || context->invalid ||
      !IsWindowVisible(window) || window == context->session->window)
    return context != nullptr && !context->invalid ? TRUE : FALSE;
  DWORD pid = 0;
  if (GetWindowThreadProcessId(window, &pid) == 0 ||
      pid != context->session->pid)
    return TRUE;
  HWND owner = nullptr;
  if (!IsOwnedByRootWindow(window, context->session->window,
                           context->session->pid, &owner))
    return TRUE;
  BoundWindowsDialog dialog;
  dialog.window = window;
  dialog.owner = owner;
  dialog.modal = IsWindowEnabled(owner) == FALSE;
  if (!ClientBoundsPhysical(window, &dialog.bounds) ||
      !ReadWindowClass(window, &dialog.class_name)) {
    context->invalid = true;
    return FALSE;
  }
  if (IsNativeTakeoverDialog(window, dialog.class_name)) {
    context->user_takeover = true;
    return FALSE;
  }
  const auto window_value =
      static_cast<std::uint64_t>(reinterpret_cast<UINT_PTR>(window));
  const auto owner_value =
      static_cast<std::uint64_t>(reinterpret_cast<UINT_PTR>(owner));
  dialog.identity = Sha256String(
      "computer-dialog-identity-v1\n" + context->session->app_identity +
      "\n" + context->session->process_start + "\n" +
      std::to_string(window_value) + "\n" + std::to_string(owner_value));
  if (dialog.identity.size() != 64 || context->dialogs.size() >= 16) {
    context->invalid = true;
    return FALSE;
  }
  context->dialogs.push_back(std::move(dialog));
  return TRUE;
}

bool CaptureWindowsDialogInventory(const WindowsSession &session,
                                   WindowsDialogSetSnapshot *snapshot,
                                   std::string *reason) {
  if (snapshot == nullptr || reason == nullptr || !IsWindow(session.window)) {
    if (reason != nullptr)
      *reason = "session_identity_changed";
    return false;
  }
  DialogEnumerationContext context;
  context.session = &session;
  EnumWindows(CollectBoundWindowsDialog,
              reinterpret_cast<LPARAM>(&context));
  if (context.user_takeover) {
    *reason = "native_dialog_user_takeover";
    return false;
  }
  if (context.invalid) {
    *reason = "dialog_set_unavailable";
    return false;
  }
  std::sort(context.dialogs.begin(), context.dialogs.end(),
            [](const BoundWindowsDialog &left,
               const BoundWindowsDialog &right) {
              return left.identity < right.identity;
            });
  std::string material = "computer-dialog-set-v1\n" +
                         session.window_identity + "\n";
  for (const auto &dialog : context.dialogs) {
    const auto owner_value = static_cast<std::uint64_t>(
        reinterpret_cast<UINT_PTR>(dialog.owner));
    material += dialog.identity + ":" + std::to_string(owner_value) + ":" +
                (dialog.modal ? "modal" : "modeless") + ":" +
                std::to_string(dialog.bounds.left) + "," +
                std::to_string(dialog.bounds.top) + "," +
                std::to_string(dialog.bounds.right) + "," +
                std::to_string(dialog.bounds.bottom) + "\n";
  }
  WindowsDialogSetSnapshot result;
  result.dialogs = std::move(context.dialogs);
  result.digest = Sha256String(material);
  if (result.digest.size() != 64) {
    *reason = "dialog_set_unavailable";
    return false;
  }
  *snapshot = std::move(result);
  return true;
}

bool CaptureWindowsDialogSet(const WindowsSession &session,
                             WindowsDialogSetSnapshot *snapshot,
                             std::string *reason) {
  WindowsDialogSetSnapshot result;
  if (!CaptureWindowsDialogInventory(session, &result, reason))
    return false;
  const HWND foreground = GetForegroundWindow();
  if (foreground == session.window) {
    result.active_window = session.window;
    result.active_identity = session.window_identity;
    result.active_kind = "application";
  } else {
    const auto active = std::find_if(
        result.dialogs.begin(), result.dialogs.end(),
        [foreground](const BoundWindowsDialog &dialog) {
          return dialog.window == foreground;
        });
    if (active == result.dialogs.end()) {
      *reason = IsWindowEnabled(session.window) == FALSE ||
                        IsNativeTakeoverWindow(foreground)
                    ? "native_dialog_user_takeover"
                    : "focus_required";
      return false;
    }
    result.active_window = active->window;
    result.active_identity = active->identity;
    result.active_kind = "dialog";
  }
  if (!ClientBoundsPhysical(result.active_window, &result.active_bounds)) {
    *reason = "window_geometry_changed";
    return false;
  }
  *snapshot = std::move(result);
  return true;
}

bool ResolveWindowsSessionRefocusTarget(const WindowsSession &session,
                                        HWND *target,
                                        std::string *reason) {
  if (target == nullptr || reason == nullptr || !IsWindow(session.window)) {
    if (reason != nullptr)
      *reason = "session_refocus_stale";
    return false;
  }
  const HWND foreground = GetForegroundWindow();
  if (foreground == nullptr) {
    *reason = "native_dialog_user_takeover";
    return false;
  }
  if (foreground != session.window &&
      foreground != session.active_window &&
      IsNativeTakeoverWindow(foreground)) {
    *reason = "native_dialog_user_takeover";
    return false;
  }
  WindowsDialogSetSnapshot inventory;
  if (!CaptureWindowsDialogInventory(session, &inventory, reason))
    return false;
  if (session.dialog_set_digest.empty()) {
    if (session.dialog_set_revision != 0 || !inventory.dialogs.empty() ||
        session.active_window != session.window ||
        session.active_window_identity != session.window_identity ||
        session.active_window_kind != "application" ||
        IsWindowEnabled(session.window) != TRUE) {
      *reason = "session_refocus_stale";
      return false;
    }
    *target = session.window;
    return true;
  }
  if (session.dialog_set_revision == 0 ||
      inventory.digest != session.dialog_set_digest) {
    *reason = "session_refocus_stale";
    return false;
  }
  HWND expected = nullptr;
  if (session.active_window_kind == "application" &&
      session.active_window == session.window &&
      session.active_window_identity == session.window_identity &&
      IsWindowEnabled(session.window) == TRUE) {
    expected = session.window;
  } else if (session.active_window_kind == "dialog") {
    const auto dialog = std::find_if(
        inventory.dialogs.begin(), inventory.dialogs.end(),
        [&session](const BoundWindowsDialog &candidate) {
          return candidate.window == session.active_window &&
                 candidate.identity == session.active_window_identity;
        });
    if (dialog != inventory.dialogs.end() &&
        IsWindowEnabled(dialog->window) == TRUE)
      expected = dialog->window;
  }
  if (expected == nullptr) {
    *reason = IsWindowEnabled(session.window) == FALSE &&
                      session.active_window_kind != "dialog"
                  ? "native_dialog_user_takeover"
                  : "session_refocus_stale";
    return false;
  }
  *target = expected;
  return true;
}

bool ResolveWindowsExplicitResumeTarget(WindowsSession *session, HWND *target,
                                        std::string *reason) {
  if (session == nullptr || target == nullptr || reason == nullptr ||
      !IsWindow(session->window)) {
    if (reason != nullptr)
      *reason = "session_refocus_stale";
    return false;
  }
  const HWND foreground = GetForegroundWindow();
  if (foreground == nullptr) {
    *reason = "native_dialog_user_takeover";
    return false;
  }
  if (foreground != session->window && foreground != session->active_window &&
      IsNativeTakeoverWindow(foreground)) {
    *reason = "native_dialog_user_takeover";
    return false;
  }
  WindowsDialogSetSnapshot inventory;
  if (!CaptureWindowsDialogInventory(*session, &inventory, reason))
    return false;

  const auto find_dialog = [&inventory](HWND window) {
    return std::find_if(
        inventory.dialogs.begin(), inventory.dialogs.end(),
        [window](const BoundWindowsDialog &candidate) {
          return candidate.window == window &&
                 IsWindowEnabled(candidate.window) == TRUE;
        });
  };
  auto selected_dialog = inventory.dialogs.end();
  const HWND last_active = GetLastActivePopup(session->window);
  if (last_active != nullptr && last_active != session->window)
    selected_dialog = find_dialog(last_active);
  if (selected_dialog == inventory.dialogs.end() &&
      session->active_window_kind == "dialog")
    selected_dialog = find_dialog(session->active_window);

  HWND selected_window = nullptr;
  std::string selected_identity;
  std::string selected_kind;
  if (selected_dialog != inventory.dialogs.end()) {
    selected_window = selected_dialog->window;
    selected_identity = selected_dialog->identity;
    selected_kind = "dialog";
  } else if (IsWindowEnabled(session->window) == TRUE) {
    selected_window = session->window;
    selected_identity = session->window_identity;
    selected_kind = "application";
  } else {
    const auto modal = std::find_if(
        inventory.dialogs.begin(), inventory.dialogs.end(),
        [](const BoundWindowsDialog &candidate) {
          return candidate.modal && IsWindowEnabled(candidate.window) == TRUE;
        });
    if (modal != inventory.dialogs.end() &&
        std::find_if(std::next(modal), inventory.dialogs.end(),
                     [](const BoundWindowsDialog &candidate) {
                       return candidate.modal &&
                              IsWindowEnabled(candidate.window) == TRUE;
                     }) == inventory.dialogs.end()) {
      selected_window = modal->window;
      selected_identity = modal->identity;
      selected_kind = "dialog";
    }
  }
  if (selected_window == nullptr || selected_identity.size() != 64) {
    *reason = "native_dialog_user_takeover";
    return false;
  }
  const bool set_changed = inventory.digest != session->dialog_set_digest;
  if ((set_changed || session->dialog_set_revision == 0) &&
      session->dialog_set_revision ==
          std::numeric_limits<std::uint64_t>::max()) {
    *reason = "session_refocus_stale";
    return false;
  }
  if (set_changed || session->dialog_set_revision == 0)
    session->dialog_set_revision += 1;
  session->dialog_set_digest = inventory.digest;
  session->active_window = selected_window;
  session->active_window_identity = std::move(selected_identity);
  session->active_window_kind = std::move(selected_kind);
  InvalidateWindowsObservation(session);
  *target = selected_window;
  return true;
}

BOOL CALLBACK CollectTopLevelWindow(HWND window, LPARAM parameter) {
  auto *context = reinterpret_cast<WindowEnumerationContext *>(parameter);
  if (context != nullptr && context->still_valid && !context->still_valid()) return FALSE;
  DWORD owner_pid = 0;
  if (context == nullptr || !IsWindowVisible(window) ||
      GetWindowThreadProcessId(window, &owner_pid) == 0 ||
      owner_pid != context->pid)
    return TRUE;
  RECT client{};
  if (!ClientBoundsPhysical(window, &client))
    return TRUE;
  const LONG client_width = client.right - client.left;
  const LONG client_height = client.bottom - client.top;
  RECT screen_bounds{};
  if (!ScreenBoundsPhysicalForWindow(window, &screen_bounds))
    return TRUE;
  std::vector<wchar_t> title(513, L'\0');
  const int title_length =
      GetWindowTextW(window, title.data(), static_cast<int>(title.size()));
  std::string title_utf8 = BoundedUtf8(
      title_length > 0
          ? Utf8FromWide(std::wstring_view(title.data(), title_length))
          : "Application window",
      256);
  if (title_utf8.empty())
    title_utf8 = "Application window";
  const auto handle_value =
      static_cast<std::uint64_t>(reinterpret_cast<UINT_PTR>(window));
  const HWND owner = GetWindow(window, GW_OWNER);
  DWORD owner_window_pid = 0;
  if (owner != nullptr)
    GetWindowThreadProcessId(owner, &owner_window_pid);
  const bool same_owner_dialog =
      owner != nullptr && owner_window_pid == context->pid;
  const bool modal = same_owner_dialog && IsWindowEnabled(owner) == FALSE;
  const bool eligible = context->identity_matches && !context->elevated &&
                        !context->proxy && !same_owner_dialog &&
                        IsApplicationWindow(window) &&
                        IsWindowEnabled(window) == TRUE;
  const std::string window_identity = Sha256String(
      "computer-window-identity-v1\n" + context->app_identity + "\n" +
      context->process_start + "\n" + std::to_string(handle_value));
  context->candidates.push_back(
      "{\"windowId\":\"" + std::to_string(handle_value) +
      "\",\"pid\":" + std::to_string(context->pid) + ",\"windowHandle\":\"" +
      std::to_string(handle_value) + "\",\"appIdentityDigest\":\"" +
      context->app_identity + "\",\"windowIdentityDigest\":\"" +
      window_identity + "\",\"title\":\"" + JsonEscape(title_utf8) +
      "\",\"executableDigest\":\"" + context->executable_digest +
      "\",\"bounds\":{" + "\"x\":" + std::to_string(client.left) +
      ",\"y\":" + std::to_string(client.top) +
      ",\"width\":" + std::to_string(client_width) +
      ",\"height\":" + std::to_string(client_height) +
      "},\"screenBounds\":" + RectJson(screen_bounds) +
      ",\"boundsUnit\":\"physical_px\",\"focused\":" +
      (GetForegroundWindow() == window ? "true" : "false") +
      ",\"eligible\":" + (eligible ? "true" : "false") + ",\"ownerKind\":\"" +
      (same_owner_dialog ? "dialog" : "application") +
      "\",\"modal\":" + (modal ? "true" : "false") +
      ",\"policyLanguage\":\"" + context->policy_language +
      "\",\"maximumMode\":\"" + context->maximum_mode +
      "\",\"revision\":1" +
      (context->include_start_identity && eligible
          ? ",\"processStartTime\":\"" + context->process_start + "\"" : "") + "}");
  return context->candidates.size() < 64 ? TRUE : FALSE;
}

bool IsKnownProxyExecutable(const std::wstring &path) {
  const auto slash = path.find_last_of(L"\\/");
  const std::wstring leaf =
      slash == std::wstring::npos ? path : path.substr(slash + 1);
  return _wcsicmp(leaf.c_str(), L"ApplicationFrameHost.exe") == 0 ||
         _wcsicmp(leaf.c_str(), L"WWAHost.exe") == 0;
}

bool IsAcceptanceFixtureExecutable(const std::wstring &path) {
  const auto slash = path.find_last_of(L"\\/");
  const std::wstring leaf =
      slash == std::wstring::npos ? path : path.substr(slash + 1);
  return _wcsicmp(leaf.c_str(),
                  L"sprint-coder-computer-use-fixture.exe") == 0;
}

bool IsDisallowedTargetExecutable(const std::wstring &path) {
  const auto slash = path.find_last_of(L"\\/");
  const std::wstring leaf =
      slash == std::wstring::npos ? path : path.substr(slash + 1);
  static constexpr std::array<std::wstring_view, 28> blocked = {
      L"mstsc.exe",
      L"msrdc.exe",
      L"SystemSettings.exe",
      L"control.exe",
      L"msiexec.exe",
      L"setup.exe",
      L"install.exe",
      L"installer.exe",
      L"powershell.exe",
      L"pwsh.exe",
      L"cmd.exe",
      L"wt.exe",
      L"WindowsTerminal.exe",
      L"wsl.exe",
      L"bash.exe",
      L"cscript.exe",
      L"wscript.exe",
      L"regedit.exe",
      L"mmc.exe",
      L"explorer.exe",
      L"taskmgr.exe",
      L"msrdcw.exe",
      L"RdClient.Windows.exe",
      L"QuickAssist.exe",
      L"TeamViewer.exe",
      L"AnyDesk.exe",
      L"RustDesk.exe",
      L"parsec.exe",
  };
  for (const auto candidate : blocked)
    if (_wcsicmp(leaf.c_str(), candidate.data()) == 0)
      return true;
  return false;
}

bool EnumerateWindowsForExecutable(const std::wstring &canonical_path,
                                   std::string_view expected_identity,
                                   std::string_view expected_executable_digest,
                                   std::string_view expected_signer_digest,
                                   std::vector<std::string> *candidates,
                                   const std::function<bool()>& still_valid = {},
                                   bool include_start_identity = false) {
  const auto current = [&] { return !still_valid || still_valid(); };
  if (!current()) return false;
  ScopedKernelHandle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
  if (snapshot.value == INVALID_HANDLE_VALUE)
    return false;
  PROCESSENTRY32W entry{};
  entry.dwSize = sizeof(entry);
  if (Process32FirstW(snapshot.value, &entry)) {
    do {
      if (!current()) return false;
      if (entry.th32ProcessID == 0)
        continue;
      LockedWindowsExecutable process_executable;
      if (!OpenLockedProcessExecutable(entry.th32ProcessID,
                                       &process_executable))
        continue;
      if (!current()) return false;
      const bool exact_process_identity =
          SameWindowsPath(process_executable.identity.path, canonical_path) &&
          WindowsExecutableIdentityMatches(
              process_executable.identity, expected_identity,
              expected_executable_digest, expected_signer_digest);
      if (!exact_process_identity) {
        CloseLockedWindowsExecutable(&process_executable);
        continue;
      }
      WindowEnumerationContext context;
      context.still_valid = still_valid;
      context.include_start_identity = include_start_identity;
      context.pid = entry.th32ProcessID;
      context.app_identity = std::string(expected_identity);
      context.executable_digest =
          process_executable.identity.executable_digest;
      context.policy_language = process_executable.identity.policy_language;
      context.maximum_mode =
          MaximumModeForWindowsExecutable(process_executable.identity);
      context.identity_matches = exact_process_identity;
      context.elevated = IsProcessElevated(entry.th32ProcessID);
      context.proxy = IsKnownProxyExecutable(process_executable.identity.path) ||
                      IsDisallowedTargetExecutable(
                          process_executable.identity.path);
      if (!ReadProcessStartIdentity(entry.th32ProcessID,
                                    &context.process_start))
        context.identity_matches = false;
      if (!current()) return false;
      EnumWindows(CollectTopLevelWindow, reinterpret_cast<LPARAM>(&context));
      if (!current()) return false;
      CloseLockedWindowsExecutable(&process_executable);
      candidates->insert(candidates->end(), context.candidates.begin(),
                         context.candidates.end());
    } while (candidates->size() < 64 && Process32NextW(snapshot.value, &entry));
  }
  return current();
}

bool LaunchVerifiedExecutable(const LockedWindowsExecutable &locked,
                              HANDLE *process,
                              const std::function<bool()>& claim = {},
                              const std::function<void()>& retire = {}) {
  if (locked.file == INVALID_HANDLE_VALUE || process == nullptr)
    return false;
  const std::wstring &canonical_path = locked.identity.path;
  const auto separator = canonical_path.find_last_of(L"\\/");
  const std::wstring working_directory =
      separator == std::wstring::npos ? std::wstring{}
                                      : canonical_path.substr(0, separator);
  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  PROCESS_INFORMATION information{};
  if (claim && !claim()) return false;
  struct LaunchUnit {
    const std::function<void()>& retire;
    ~LaunchUnit() { if (retire) retire(); }
  } unit{retire};
  ScopedKernelHandle job(CreateJobObjectW(nullptr, nullptr));
  if (!job.value) return false;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE |
      JOB_OBJECT_LIMIT_BREAKAWAY_OK | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK;
  if (!SetInformationJobObject(job.value, JobObjectExtendedLimitInformation,
                               &limits, sizeof(limits))) return false;
  SIZE_T attribute_bytes = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &attribute_bytes);
  if (attribute_bytes == 0) return false;
  std::vector<unsigned char> attribute_storage(attribute_bytes);
  startup.lpAttributeList = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attribute_storage.data());
  if (!InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &attribute_bytes))
    return false;
  struct AttributeList {
    LPPROC_THREAD_ATTRIBUTE_LIST value;
    ~AttributeList() { DeleteProcThreadAttributeList(value); }
  } attributes{startup.lpAttributeList};
  if (!UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST,
                                 &job.value, sizeof(job.value), nullptr, nullptr)) return false;
  struct OwnedChild {
    ScopedKernelHandle process, thread;
    bool verified = false;
    ~OwnedChild() {
      if (!verified && process.value != nullptr && process.value != INVALID_HANDLE_VALUE) {
        if (WaitForSingleObject(process.value, 0) != WAIT_OBJECT_0)
          TerminateProcess(process.value, ERROR_INVALID_IMAGE_HASH);
        // A failed termination is not a cleanup receipt. The consumer and its launch unit stay
        // owned until exit is observed; no consumer/Stop mutex is held while waiting.
        while (WaitForSingleObject(process.value, INFINITE) != WAIT_OBJECT_0) Sleep(1000);
      }
    }
  } child;
  const BOOL created = CreateProcessW(
          canonical_path.c_str(), nullptr, nullptr, nullptr, FALSE,
          CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT, nullptr,
          working_directory.empty() ? nullptr : working_directory.c_str(),
          &startup.StartupInfo, &information);
  child.process.value = information.hProcess;
  child.thread.value = information.hThread;
  if (!created) return false;
  LockedWindowsExecutable launched_image;
  const bool image_matches =
      OpenLockedProcessExecutable(child.process.value, &launched_image) &&
      SameWindowsPath(launched_image.identity.path, locked.identity.path) &&
      SameWindowsFileIdentity(launched_image.identity.file_identity,
                              locked.identity.file_identity) &&
      launched_image.identity.identity_digest == locked.identity.identity_digest &&
      launched_image.identity.executable_digest ==
          locked.identity.executable_digest &&
      launched_image.identity.signer_digest == locked.identity.signer_digest;
  CloseLockedWindowsExecutable(&launched_image);
  if (!image_matches) return false;
  limits.BasicLimitInformation.LimitFlags &= ~JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job.value, JobObjectExtendedLimitInformation,
                               &limits, sizeof(limits))) return false;
  if (ResumeThread(child.thread.value) == static_cast<DWORD>(-1)) {
    limits.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    SetInformationJobObject(job.value, JobObjectExtendedLimitInformation,
                            &limits, sizeof(limits));
    return false;
  }
  child.verified = true;
  *process = child.process.release();
  return true;
}

