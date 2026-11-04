// Explorer measurements run on their owning measurement lane. No COM pointer crosses a thread.
//
// Internal refusal reasons. They never reach the wire: the response says only "unknown",
// pointOwnerMatches false, or the generic explorer_view_unreadable error. Tests read the reason of
// the last measurement through windows_explorer_trace_for_test, which production never reads.
enum class WindowsExplorerRefusal {
  kNone,
  // The request and its binding.
  kNoSession,
  kSessionUnbound,
  kStaleEpoch,
  kWindowMismatch,
  kPointInvalid,
  kNotCurrent,
  kIdentity,
  kNotVerifiedExplorer,
  kWindowOwner,
  kException,
  // The shell view of the bound window.
  kShellWindows,
  kViewNotFound,
  kTabsAmbiguous,
  kViewUnreadable,
  kActiveTabUnbound,
  kNotShellFsFolder,
  kNotFileSystem,
  kNotPlainFolder,
  kCancelled,
  // The folder path (detail of kNotPlainFolder).
  kPathShape,
  kNotFixedDrive,
  kJunctionName,
  kAttributes,
  kReparsePoint,
  kViewedDesktopIni,
  kAncestorShellClass,
  kAncestorIniUnreadable,
  // The window under the input point.
  kPointOutsideView,
  kPointHidden,
  kPointForeignOwner,
  kPointTreeUnreadable,
};
struct WindowsExplorerTrace {
  WindowsExplorerRefusal request = WindowsExplorerRefusal::kNone;
  WindowsExplorerRefusal view = WindowsExplorerRefusal::kNone;
  WindowsExplorerRefusal folder = WindowsExplorerRefusal::kNone;
  WindowsExplorerRefusal point = WindowsExplorerRefusal::kNone;
};
// Written only by the pipe consumer. A test seam, never serialized.
WindowsExplorerTrace windows_explorer_trace_for_test;
#if defined(SPRINT_CODER_WINDOWS_EXPLORER_TEST_HOOKS)
// Acceptance-test fault injection: the watcher thread cannot be created, or the body throws.
enum class WindowsExplorerFault { kNone, kWatcherThread, kBody };
WindowsExplorerFault windows_explorer_fault_for_test = WindowsExplorerFault::kNone;
// Acceptance-test identity override: the identity must still match; only elevation is ignored.
bool windows_explorer_ignore_elevation_for_test = false;
#endif

struct WindowsExplorerShellView {
  std::optional<std::wstring> folder;
  // The measured tab's SHELLDLL_DefView. Input is accepted only inside this window.
  HWND view = nullptr;
  WindowsExplorerRefusal refusal = WindowsExplorerRefusal::kNone;
  WindowsExplorerRefusal folder_refusal = WindowsExplorerRefusal::kNone;
};

struct WindowsExplorerViewMeasurement {
  std::optional<std::wstring> folder;
  bool point_owner_matches = false;
};

struct WindowsExplorerDispatchEvidence {
  HWND window = nullptr, view = nullptr, point_owner = nullptr;
  DWORD pid = 0;
  POINT point{};
  std::optional<std::wstring> folder;
  std::uint64_t epoch = 0, stop_serial = 0;
  std::weak_ptr<std::atomic<std::uint64_t>> session_binding;
  // Only the pipe consumer dispatches; approved-session copies share this consumption bit.
  mutable bool consumed = false;
};

// The window under the point must be the measured view or one of its descendants, visible, and
// every window from the hit down to the deepest visible child must belong to the verified pid.
// The navigation pane, address bar, command bar, details pane and another tab are outside it.
WindowsExplorerRefusal WindowsExplorerPointRefusal(HWND window, HWND view, DWORD pid, POINT point,
                                                  HWND *point_owner = nullptr) {
  if (point_owner != nullptr) *point_owner = nullptr;
  DWORD owner = 0;
  if (!IsWindow(window) || !GetWindowThreadProcessId(window, &owner) || owner != pid)
    return WindowsExplorerRefusal::kPointForeignOwner;
  if (view == nullptr || !IsWindow(view) || GetAncestor(view, GA_ROOT) != window)
    return WindowsExplorerRefusal::kPointOutsideView;
  if (!GetWindowThreadProcessId(view, &owner) || owner != pid)
    return WindowsExplorerRefusal::kPointForeignOwner;
  HWND hit = WindowFromPoint(point);
  if (hit == nullptr || (hit != view && !IsChild(view, hit)))
    return WindowsExplorerRefusal::kPointOutsideView;
  // WindowFromPoint may return a parent. Descend into visible children, including foreign-process
  // preview handlers. An unreadable/deep tree is not proof of ownership.
  for (unsigned depth = 0; depth != 64; ++depth) {
    // IsWindowVisible also requires every ancestor, the view included, to be visible.
    if (!IsWindowVisible(hit)) return WindowsExplorerRefusal::kPointHidden;
    if (!GetWindowThreadProcessId(hit, &owner) || owner != pid)
      return WindowsExplorerRefusal::kPointForeignOwner;
    POINT local = point;
    if (!ScreenToClient(hit, &local)) return WindowsExplorerRefusal::kPointTreeUnreadable;
    HWND child = ChildWindowFromPointEx(hit, local, CWP_SKIPINVISIBLE);
    if (child == hit || child == nullptr) {
      if (point_owner != nullptr) *point_owner = hit;
      return WindowsExplorerRefusal::kNone;
    }
    hit = child;
  }
  return WindowsExplorerRefusal::kPointTreeUnreadable;
}

bool WindowsExplorerAsciiEqual(std::wstring_view left, std::wstring_view right) {
  if (left.size() != right.size()) return false;
  for (std::size_t index = 0; index != left.size(); ++index) {
    wchar_t a = left[index], b = right[index];
    if (a >= L'a' && a <= L'z') a = static_cast<wchar_t>(a - L'a' + L'A');
    if (b >= L'a' && b <= L'z') b = static_cast<wchar_t>(b - L'a' + L'A');
    if (a != b) return false;
  }
  return true;
}

// Reads one desktop.ini completely and reports whether its [.ShellClassInfo] names a shell class
// (CLSID, CLSID2 or UICLSID), which can turn the folder and everything under it into a namespace.
// nullopt: the file cannot be read completely, which is not proof that the keys are absent.
std::optional<bool> WindowsExplorerIniNamesShellClass(const std::wstring &path) {
  ScopedKernelHandle file(CreateFileW(path.c_str(), GENERIC_READ,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  BY_HANDLE_FILE_INFORMATION information{};
  if (file.value == INVALID_HANDLE_VALUE || !GetFileInformationByHandle(file.value, &information) ||
      (information.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) ||
      information.nFileSizeHigh != 0 || information.nFileSizeLow > 65536)
    return std::nullopt;
  std::string bytes(information.nFileSizeLow, '\0');
  DWORD read = 0;
  if (!bytes.empty() && (!ReadFile(file.value, bytes.data(), static_cast<DWORD>(bytes.size()), &read,
      nullptr) || read != bytes.size()))
    return std::nullopt;
  std::wstring text;
  if (bytes.size() >= 2 && static_cast<unsigned char>(bytes[0]) == 0xFF &&
      static_cast<unsigned char>(bytes[1]) == 0xFE) {
    if (bytes.size() % 2 != 0) return std::nullopt;
    for (std::size_t index = 2; index + 1 < bytes.size(); index += 2)
      text.push_back(static_cast<wchar_t>(static_cast<unsigned char>(bytes[index]) |
          (static_cast<unsigned char>(bytes[index + 1]) << 8)));
  } else {
    if (bytes.size() >= 2 && static_cast<unsigned char>(bytes[0]) == 0xFE &&
        static_cast<unsigned char>(bytes[1]) == 0xFF) return std::nullopt;  // UTF-16BE: unknown.
    // ANSI or UTF-8: the section and key names are ASCII, so bytes are compared as they are. A
    // UTF-8 byte order mark is removed so it cannot hide a section name on the first line.
    const std::size_t skip = bytes.size() >= 3 && static_cast<unsigned char>(bytes[0]) == 0xEF &&
        static_cast<unsigned char>(bytes[1]) == 0xBB && static_cast<unsigned char>(bytes[2]) == 0xBF ? 3 : 0;
    for (std::size_t index = skip; index < bytes.size(); ++index)
      text.push_back(static_cast<wchar_t>(static_cast<unsigned char>(bytes[index])));
  }
  const auto trim = [](std::wstring_view value) {
    while (!value.empty() && (value.front() == L' ' || value.front() == L'\t')) value.remove_prefix(1);
    while (!value.empty() && (value.back() == L' ' || value.back() == L'\t' || value.back() == L'\r'))
      value.remove_suffix(1);
    return value;
  };
  bool in_class_info = false;
  std::wstring_view rest(text);
  while (!rest.empty()) {
    // CR, LF and CRLF all end a line (an empty line between CR and LF is skipped).
    const std::size_t end = rest.find_first_of(L"\r\n");
    const std::wstring_view line = trim(rest.substr(0, end));
    rest = end == std::wstring_view::npos ? std::wstring_view{} : rest.substr(end + 1);
    if (line.empty() || line.front() == L';') continue;
    if (line.front() == L'[') {
      const std::size_t close = line.find(L']');
      in_class_info = close != std::wstring_view::npos &&
          WindowsExplorerAsciiEqual(trim(line.substr(1, close - 1)), L".ShellClassInfo");
      continue;
    }
    const std::size_t equals = line.find(L'=');
    if (!in_class_info || equals == std::wstring_view::npos) continue;
    const auto key = trim(line.substr(0, equals));
    if (WindowsExplorerAsciiEqual(key, L"CLSID") || WindowsExplorerAsciiEqual(key, L"CLSID2") ||
        WindowsExplorerAsciiEqual(key, L"UICLSID")) return true;
  }
  return false;
}

// L2 note: these are file-system reads by path, made in this helper. The shell item that produced
// the path (SHCreateItemFromIDList) binds in-proc; it is reached only after the Explorer-side folder
// object proved to be CLSID_ShellFSFolder, so no namespace extension's folder is created here for
// the viewed folder. Moving every attribute read to Explorer-side proxy objects would need a
// parent folder proxy per component and is left out of this preparation.
bool WindowsExplorerPlainFolder(const std::wstring &path, WindowsExplorerRefusal *reason = nullptr) {
  const auto refuse = [&](WindowsExplorerRefusal value) {
    if (reason != nullptr) *reason = value;
    return false;
  };
  if (reason != nullptr) *reason = WindowsExplorerRefusal::kNone;
  if (path.size() < 3 || path[1] != L':' || path[2] != L'\\' ||
      !((path[0] >= L'A' && path[0] <= L'Z') || (path[0] >= L'a' && path[0] <= L'z')))
    return refuse(WindowsExplorerRefusal::kPathShape);
  // A mapped network drive, removable media or a RAM disk is not a fixed local folder.
  if (GetDriveTypeW(path.substr(0, 3).c_str()) != DRIVE_FIXED)
    return refuse(WindowsExplorerRefusal::kNotFixedDrive);
  // Check every component: a namespace junction anywhere in the path is not a plain folder.
  // The drive root (end == 3, "X:\") is a component too: its attributes and its desktop.ini count.
  for (std::size_t end = 3; end <= path.size(); ++end) {
    if (end != 3 && end != path.size() && path[end] != L'\\') continue;
    const std::wstring prefix = path.substr(0, end);
    const std::size_t leaf = prefix.find_last_of(L'\\');
    const auto name = prefix.substr(leaf == std::wstring::npos ? 0 : leaf + 1);
    if (name.find(L".{") != std::wstring::npos || name == L"." || name == L"..")
      return refuse(WindowsExplorerRefusal::kJunctionName);
    const DWORD attributes = GetFileAttributesW(prefix.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES || !(attributes & FILE_ATTRIBUTE_DIRECTORY))
      return refuse(WindowsExplorerRefusal::kAttributes);
    // Reparse points cannot establish containment of the operation's item either.
    if (attributes & FILE_ATTRIBUTE_REPARSE_POINT) return refuse(WindowsExplorerRefusal::kReparsePoint);
    const std::wstring ini = prefix + (prefix.back() == L'\\' ? L"desktop.ini" : L"\\desktop.ini");
    const DWORD ini_attributes = GetFileAttributesW(ini.c_str());
    if (ini_attributes == INVALID_FILE_ATTRIBUTES) {
      if (GetLastError() != ERROR_FILE_NOT_FOUND && GetLastError() != ERROR_PATH_NOT_FOUND)
        return refuse(end == path.size() ? WindowsExplorerRefusal::kViewedDesktopIni
                                         : WindowsExplorerRefusal::kAncestorIniUnreadable);
      continue;
    }
    if (end == path.size()) {
      // An unreadable INI is indistinguishable from a missing key through the profile API.
      // Until its complete contents can be proven, any customization of the viewed folder is unknown.
      return refuse(WindowsExplorerRefusal::kViewedDesktopIni);
    }
    // Ancestors commonly carry a desktop.ini (C:\Users, the profile, Documents) that only localizes
    // a name. One that names a shell class can make everything below it a namespace, so its keys are
    // read, and one that cannot be read completely is refused.
    const auto names_class = WindowsExplorerIniNamesShellClass(ini);
    if (!names_class.has_value()) return refuse(WindowsExplorerRefusal::kAncestorIniUnreadable);
    if (*names_class) return refuse(WindowsExplorerRefusal::kAncestorShellClass);
  }
  return true;
}

// The measured entry's view must be the window's only visible SHELLDLL_DefView. A tab that is not
// (yet) in IShellWindows, or a measured tab that is not the active one, fails this.
bool WindowsExplorerActiveView(HWND window, HWND view) {
  wchar_t name[32]{};
  if (view == nullptr || !IsWindow(view) || GetAncestor(view, GA_ROOT) != window ||
      !IsWindowVisible(view) || GetClassNameW(view, name, 32) == 0 ||
      std::wstring_view(name) != L"SHELLDLL_DefView") return false;
  struct Search { HWND view; unsigned visible = 0; bool measured = false; } search{view};
  EnumChildWindows(window, [](HWND child, LPARAM parameter) -> BOOL {
    auto *search = reinterpret_cast<Search *>(parameter);
    wchar_t child_name[32]{};
    if (IsWindowVisible(child) && GetClassNameW(child, child_name, 32) != 0 &&
        std::wstring_view(child_name) == L"SHELLDLL_DefView") {
      ++search->visible;
      search->measured = search->measured || child == search->view;
    }
    return search->visible < 2;
  }, reinterpret_cast<LPARAM>(&search));
  return search.visible == 1 && search.measured;
}

WindowsExplorerShellView ReadWindowsExplorerShellView(
    HWND window, const std::function<bool()> &current) {
  using sprint_coder::computer_use::windows_uia_source_detail::ComRef;
  WindowsExplorerShellView result;
  const auto refuse = [&](WindowsExplorerRefusal reason) {
    result.folder.reset();
    result.refusal = current() ? reason : WindowsExplorerRefusal::kCancelled;
    return result;
  };
  ComRef<IShellWindows> windows;
  if (!current() || FAILED(CoCreateInstance(CLSID_ShellWindows, nullptr, CLSCTX_LOCAL_SERVER,
      IID_PPV_ARGS(windows.Receive())))) return refuse(WindowsExplorerRefusal::kShellWindows);
  long count = 0;
  if (!current() || FAILED(windows.Get()->get_Count(&count)) || count < 0 || count > 256)
    return refuse(WindowsExplorerRefusal::kShellWindows);
  bool matched = false;
  for (long index = 0; index < count && current(); ++index) {
    VARIANT item;
    VariantInit(&item);
    item.vt = VT_I4;
    item.lVal = index;
    ComRef<IDispatch> dispatch;
    ComRef<IWebBrowser2> browser;
    SHANDLE_PTR handle = 0;
    if (FAILED(windows.Get()->Item(item, dispatch.Receive())) || dispatch.Get() == nullptr ||
        !current() || FAILED(dispatch.Get()->QueryInterface(IID_PPV_ARGS(browser.Receive()))) ||
        !current() || FAILED(browser.Get()->get_HWND(&handle)))
      return refuse(WindowsExplorerRefusal::kShellWindows);
    if (reinterpret_cast<HWND>(handle) != window) continue;
    // Multiple tab automation objects can share a top-level HWND. Do not guess its active view.
    if (matched) return refuse(WindowsExplorerRefusal::kTabsAmbiguous);
    matched = true;
    ComRef<IServiceProvider> provider;
    ComRef<IShellBrowser> shell;
    ComRef<IShellView> view;
    ComRef<IFolderView> folder_view;
    ComRef<IPersistFolder2> folder;
    HWND view_window = nullptr;
    if (!current() || FAILED(browser.Get()->QueryInterface(IID_PPV_ARGS(provider.Receive()))) ||
        !current() || FAILED(provider.Get()->QueryService(SID_STopLevelBrowser, IID_PPV_ARGS(shell.Receive()))) ||
        !current() || FAILED(shell.Get()->QueryActiveShellView(view.Receive())) ||
        !current() || FAILED(view.Get()->GetWindow(&view_window)) ||
        !current() || FAILED(view.Get()->QueryInterface(IID_PPV_ARGS(folder_view.Receive()))) ||
        !current() || FAILED(folder_view.Get()->GetFolder(IID_PPV_ARGS(folder.Receive()))))
      return refuse(WindowsExplorerRefusal::kViewUnreadable);
    if (!current() || !WindowsExplorerActiveView(window, view_window))
      return refuse(WindowsExplorerRefusal::kActiveTabUnbound);
    result.view = view_window;
    // The Explorer-side folder object itself must be the file-system folder. A folder reached
    // through a CLSID junction (an ancestor's desktop.ini, a .{CLSID} name) is another class.
    CLSID folder_class{};
    if (!current() || FAILED(folder.Get()->GetClassID(&folder_class)) ||
        !IsEqualCLSID(folder_class, CLSID_ShellFSFolder))
      return refuse(WindowsExplorerRefusal::kNotShellFsFolder);
    struct Pidl {
      PIDLIST_ABSOLUTE value = nullptr;
      ~Pidl() { CoTaskMemFree(value); }
    } pidl;
    if (!current() || FAILED(folder.Get()->GetCurFolder(&pidl.value)) || pidl.value == nullptr)
      return refuse(WindowsExplorerRefusal::kViewUnreadable);
    ComRef<IShellItem> shell_item;
    SFGAOF attributes = 0;
    if (!current() || FAILED(SHCreateItemFromIDList(pidl.value, IID_PPV_ARGS(shell_item.Receive()))) ||
        !current() || FAILED(shell_item.Get()->GetAttributes(SFGAO_FILESYSTEM | SFGAO_FOLDER, &attributes)) ||
        (attributes & (SFGAO_FILESYSTEM | SFGAO_FOLDER)) != (SFGAO_FILESYSTEM | SFGAO_FOLDER))
      return refuse(WindowsExplorerRefusal::kNotFileSystem);
    struct Path {
      PWSTR value = nullptr;
      ~Path() { CoTaskMemFree(value); }
    } path;
    if (!current() || FAILED(shell_item.Get()->GetDisplayName(SIGDN_FILESYSPATH, &path.value)) ||
        path.value == nullptr)
      return refuse(WindowsExplorerRefusal::kNotFileSystem);
    WindowsExplorerRefusal folder_reason = WindowsExplorerRefusal::kNone;
    if (!current() || !WindowsExplorerPlainFolder(path.value, &folder_reason) || !current()) {
      result.folder_refusal = folder_reason;
      return refuse(WindowsExplorerRefusal::kNotPlainFolder);
    }
    result.folder = std::wstring(path.value);
  }
  if (!current()) return refuse(WindowsExplorerRefusal::kCancelled);
  if (!matched) return refuse(WindowsExplorerRefusal::kViewNotFound);
  return result;
}

// CoCancelCall is advisory; a provider that ignores cancellation remains on this consumer until
// Main's existing request deadline kills the helper. Never adopt a late result, including cleanup.
class WindowsExplorerDeadline {
public:
  WindowsExplorerDeadline(std::uint64_t epoch, std::uint64_t serial, bool lane_registered = false)
      : io_(!lane_registered), epoch_(epoch), serial_(serial), thread_(GetCurrentThreadId()),
        deadline_(std::chrono::steady_clock::now() + std::chrono::milliseconds(800)) {
    enabled_ = SUCCEEDED(CoEnableCallCancellation(nullptr));
    if (!enabled_) return;
    // A watcher that cannot start leaves the measurement disabled (never current), and the
    // cancellation enabled above is disabled here because the destructor will not see it.
    try {
#if defined(SPRINT_CODER_WINDOWS_EXPLORER_TEST_HOOKS)
      if (windows_explorer_fault_for_test == WindowsExplorerFault::kWatcherThread)
        throw std::bad_alloc();  // std::thread reports its failure by an exception, too.
#endif
      watcher_ = std::thread([this] {
        const HRESULT apartment = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
        std::unique_lock lock(mutex_);
        while (!done_) {
          if (!Current()) {
            CoCancelCall(thread_, 0);
            CancelSynchronousIo(io_.thread);
          }
          ready_.wait_for(lock, std::chrono::milliseconds(10), [this] { return done_; });
        }
        lock.unlock();
        if (SUCCEEDED(apartment)) CoUninitialize();
      });
    } catch (...) {
      enabled_ = false;
      CoDisableCallCancellation(nullptr);
    }
  }
  ~WindowsExplorerDeadline() {
    { std::lock_guard lock(mutex_); done_ = true; }
    ready_.notify_one();
    if (watcher_.joinable()) watcher_.join();
    if (enabled_) CoDisableCallCancellation(nullptr);
  }
  WindowsExplorerDeadline(const WindowsExplorerDeadline &) = delete;
  WindowsExplorerDeadline &operator=(const WindowsExplorerDeadline &) = delete;
  bool Current() const {
    return enabled_ && io_.thread != nullptr && std::chrono::steady_clock::now() < deadline_ &&
        WindowsValidationStillCurrent(epoch_, serial_);
  }
private:
  WindowsNewStartIoRegistration io_;
  std::uint64_t epoch_, serial_;
  DWORD thread_;
  std::chrono::steady_clock::time_point deadline_;
  bool enabled_ = false, done_ = false;
  std::mutex mutex_;
  std::condition_variable ready_;
  std::thread watcher_;
};

// ReadWindowsExplorerShellView is the session-independent view/ordinary-folder measurement shared
// with M2 below. Prestart chooses a probe point inside that view; it never issues input and never
// creates dispatch evidence. The result is consumed on this lane before its held image is released.
bool MeasureWindowsExplorerPrestart(const WindowsV2Judgement &process, HWND window,
                                    const WindowsExplorerPrestartScope &scope) {
  if constexpr (!sprint_coder::computer_use::kWindowsExplorerException) {
    return false;
  } else {
    try {
      if (!scope.current || scope.generation == 0 || !scope.current() ||
          !process.identity_ok || window == nullptr ||
          !sprint_coder::computer_use::WindowsTargetIsVerifiedExplorer(process.measured.facts))
        return false;
      WindowsExplorerDeadline deadline(scope.epoch, scope.stop_serial, /*lane_registered=*/true);
      const auto current = [&] { return deadline.Current() && scope.current(); };
      const auto window_identity = [&](const std::string &start) {
        return Sha256String("computer-window-identity-v1\n" + process.app_identity + "\n" + start +
                            "\n" + std::to_string(reinterpret_cast<std::uintptr_t>(window)));
      };
      const std::string expected_window_identity = window_identity(process.process_start);
      const auto bound = [&] {
        DWORD owner = 0;
        std::string start;
        WindowsFileIdentity held{};
        LockedWindowsExecutable running;
        return current() && GetWindowThreadProcessId(window, &owner) != 0 &&
            owner == process.measured.pid &&
            WindowsTargetWindowClass(window, owner) == std::optional<std::string>("CabinetWClass") &&
            ReadProcessStartIdentity(owner, &start) && start == process.process_start &&
            window_identity(start) == expected_window_identity &&
            ReadWindowsFileIdentity(process.executable.file, &held) &&
            SameWindowsFileIdentity(held, process.executable.identity.file_identity) &&
            OpenLockedProcessExecutable(owner, &running) &&
            SameWindowsFileIdentity(held, running.identity.file_identity) &&
            SameWindowsTargetName(process.executable.identity.path, running.identity.path) && current();
      };
      if (!bound()) return false;
      const auto view = ReadWindowsExplorerShellView(window, current);
      if (!current() || view.refusal != WindowsExplorerRefusal::kNone ||
          view.folder_refusal != WindowsExplorerRefusal::kNone || !view.folder || !view.view)
        return false;
      RECT bounds{};
      if (!GetClientRect(view.view, &bounds) || bounds.right <= bounds.left ||
          bounds.bottom <= bounds.top) return false;
      POINT point{bounds.left + (bounds.right - bounds.left) / 2,
                  bounds.top + (bounds.bottom - bounds.top) / 2};
      if (!ClientToScreen(view.view, &point) || !current() ||
          WindowsExplorerPointRefusal(window, view.view, process.measured.pid, point) !=
              WindowsExplorerRefusal::kNone) return false;
      return bound();
    } catch (...) {
      return false;
    }
  }
}

// P5 REQUIREMENT (M2): the answer alone never authorizes input. Dispatch consumes the native
// evidence and remeasures using its own WindowsActionPoint before attempting any input API.
bool MeasureWindowsExplorerViewUnguarded(const Frame &request, const std::string &metadata,
                                         std::string *response, WindowsExplorerTrace *trace) {
  const auto refuse = [&](WindowsExplorerRefusal reason) {
    trace->request = reason;
    return false;
  };
  WindowsSession *session = FindWindowsSession(request);
  std::string session_id;
  std::uint64_t epoch = 0, window_value = 0;
  double x = 0, y = 0;
  if (session == nullptr) return refuse(WindowsExplorerRefusal::kNoSession);
  session->explorer_dispatch_evidence.reset();
  if (!session->approval_route_v2 || session->approval_revoked ||
      !ReadJsonString(metadata, "sessionId", &session_id) || session_id != session->session_id)
    return refuse(WindowsExplorerRefusal::kSessionUnbound);
  if (!ReadJsonUint64(metadata, "cancelEpoch", &epoch) || epoch != session->cancel_epoch)
    return refuse(WindowsExplorerRefusal::kStaleEpoch);
  if (!ReadJsonUint64(metadata, "windowId", &window_value) ||
      reinterpret_cast<HWND>(static_cast<std::uintptr_t>(window_value)) != session->window)
    return refuse(WindowsExplorerRefusal::kWindowMismatch);
  if (!ReadJsonDouble(metadata, "x", &x) || !ReadJsonDouble(metadata, "y", &y) ||
      !std::isfinite(x) || !std::isfinite(y) || std::trunc(x) != x || std::trunc(y) != y ||
      x < LONG_MIN || x > LONG_MAX || y < LONG_MIN || y > LONG_MAX)
    return refuse(WindowsExplorerRefusal::kPointInvalid);
  const auto serial = WindowsValidationFrameStopSerial();
  // A Stop after enqueue or a cancelled epoch ends the request before any identity work.
  if (!WindowsValidationStillCurrent(epoch, serial)) return refuse(WindowsExplorerRefusal::kNotCurrent);
  WindowsSessionIdentityResult identity;
  if (!ReadWindowsSessionIdentityOnLane(*session, serial, &identity))
    return refuse(WindowsExplorerRefusal::kIdentity);
#if defined(SPRINT_CODER_WINDOWS_EXPLORER_TEST_HOOKS)
  // Acceptance-test only: lets the transport seam reach the deadline on an elevated runner.
  if (windows_explorer_ignore_elevation_for_test) identity.elevated = false;
#endif
  if (!identity.identity_matches || identity.elevated)
    return refuse(WindowsExplorerRefusal::kIdentity);
  WindowsExplorerDeadline deadline(epoch, serial);
  const auto current = [&] { return deadline.Current(); };
#if defined(SPRINT_CODER_WINDOWS_EXPLORER_TEST_HOOKS)
  if (windows_explorer_fault_for_test == WindowsExplorerFault::kBody)
    throw std::bad_alloc();
#endif
  if (!current()) return refuse(WindowsExplorerRefusal::kNotCurrent);
  if (!WindowsExplorerVerifiedWindow(session->pid, session->window))
    return refuse(current() ? WindowsExplorerRefusal::kNotVerifiedExplorer
                            : WindowsExplorerRefusal::kNotCurrent);
  if (!current()) return refuse(WindowsExplorerRefusal::kNotCurrent);
  DWORD owner = 0;
  if (!GetWindowThreadProcessId(session->window, &owner) || owner != session->pid)
    return refuse(WindowsExplorerRefusal::kWindowOwner);
  const WindowsExplorerShellView shell_view = ReadWindowsExplorerShellView(session->window, current);
  trace->view = shell_view.refusal;
  trace->folder = shell_view.folder_refusal;
  WindowsExplorerViewMeasurement view;
  view.folder = shell_view.folder;
  const POINT point{static_cast<LONG>(x), static_cast<LONG>(y)};
  HWND point_owner = nullptr;
  trace->point = shell_view.view == nullptr ? WindowsExplorerRefusal::kPointOutsideView
      : WindowsExplorerPointRefusal(session->window, shell_view.view, session->pid,
                                    point, &point_owner);
  view.point_owner_matches = trace->point == WindowsExplorerRefusal::kNone;
  if (!current()) return refuse(WindowsExplorerRefusal::kNotCurrent);
  *response = "{\"shellView\":" + (view.folder.has_value()
      ? "{\"kind\":\"filesystem_folder\",\"path\":\"" + JsonEscape(Utf8FromWide(*view.folder)) + "\"}"
      : std::string("{\"kind\":\"unknown\"}")) +
      ",\"pointOwnerMatches\":" + (view.point_owner_matches ? "true}" : "false}");
  if (!current()) return refuse(WindowsExplorerRefusal::kNotCurrent);
  if (view.point_owner_matches && view.folder.has_value() &&
      shell_view.refusal == WindowsExplorerRefusal::kNone &&
      shell_view.folder_refusal == WindowsExplorerRefusal::kNone) {
    session->explorer_dispatch_evidence = std::make_shared<WindowsExplorerDispatchEvidence>(
        WindowsExplorerDispatchEvidence{session->window, shell_view.view, point_owner, session->pid,
            point, view.folder, epoch, serial, session->input_api_attempts});
  }
  return true;
}

bool MeasureWindowsExplorerView(const Frame &request, const std::string &metadata,
                                std::string *response) {
  if constexpr (!sprint_coder::computer_use::kWindowsExplorerException) return false;
  windows_explorer_trace_for_test = WindowsExplorerTrace{};
  try {
    std::string measured;
    if (!MeasureWindowsExplorerViewUnguarded(request, metadata, &measured,
                                             &windows_explorer_trace_for_test)) return false;
    *response = std::move(measured);
    return true;
  } catch (...) {
    if (auto *session = FindWindowsSession(request)) session->explorer_dispatch_evidence.reset();
    windows_explorer_trace_for_test.request = WindowsExplorerRefusal::kException;
    return false;
  }
}

// BEGIN windows explorer dispatch guard
// Consume even a refused dispatch, including all approved-session copies sharing the evidence.
std::shared_ptr<const WindowsExplorerDispatchEvidence> ConsumeWindowsExplorerDispatchEvidence(
    std::shared_ptr<const WindowsExplorerDispatchEvidence> evidence) {
  if (evidence) {
    if (std::exchange(evidence->consumed, true)) return nullptr;
  }
  return evidence;
}

bool BeginWindowsExplorerDispatch(const WindowsSession &session, const std::string &kind,
    std::shared_ptr<const WindowsExplorerDispatchEvidence> *evidence) {
  if constexpr (!sprint_coder::computer_use::kWindowsExplorerException) return false;
  // A native-bound path is used only to require a guard, never as proof of eligibility.
  const auto leaf = session.canonical_path.substr(session.canonical_path.find_last_of(L"\\/") + 1);
  if (!*evidence && !WindowsExplorerAsciiEqual(leaf, L"explorer.exe")) return true;
  if (kind != "click" && kind != "scroll") return false;
  return *evidence && session.approval_route_v2 && !session.approval_revoked &&
      (*evidence)->session_binding.lock() == session.input_api_attempts;
}

bool RecheckWindowsExplorerDispatch(const WindowsSession &session,
    const std::shared_ptr<const WindowsExplorerDispatchEvidence> &evidence, POINT point) {
  if constexpr (!sprint_coder::computer_use::kWindowsExplorerException) return false;
  if (!evidence) return true;  // Begin already rejected an Explorer session without evidence.
  try {
    if (!session.approval_route_v2 || session.approval_revoked ||
        evidence->session_binding.lock() != session.input_api_attempts ||
        session.window != evidence->window || session.active_window != session.window ||
        session.pid != evidence->pid || session.cancel_epoch != evidence->epoch ||
        WindowsValidationFrameStopSerial() != evidence->stop_serial ||
        point.x != evidence->point.x || point.y != evidence->point.y ||
        !WindowsValidationStillCurrent(evidence->epoch, evidence->stop_serial)) return false;
    WindowsSessionIdentityResult identity;
    if (!ReadWindowsSessionIdentityOnLane(session, evidence->stop_serial, &identity) ||
        !identity.identity_matches || identity.elevated) return false;
    {
      WindowsExplorerDeadline deadline(evidence->epoch, evidence->stop_serial);
      const auto current = [&] { return deadline.Current(); };
      if (!current() || !WindowsExplorerVerifiedWindow(session.pid, session.window) || !current())
        return false;
      const auto shell_view = ReadWindowsExplorerShellView(session.window, current);
      if (!current() || shell_view.refusal != WindowsExplorerRefusal::kNone ||
          shell_view.folder_refusal != WindowsExplorerRefusal::kNone ||
          !shell_view.folder.has_value() || shell_view.view != evidence->view ||
          shell_view.folder != evidence->folder) return false;
      HWND point_owner = nullptr;
      if (WindowsExplorerPointRefusal(session.window, shell_view.view, session.pid, point,
              &point_owner) != WindowsExplorerRefusal::kNone ||
          point_owner != evidence->point_owner || !current()) return false;
    }
    return WindowsValidationStillCurrent(evidence->epoch, evidence->stop_serial);
  } catch (...) {
    return false;
  }
}

// Button and wheel events carry no coordinates: they land wherever the cursor is when the input
// stream reaches them. An Explorer session therefore sends an absolute move to the re-measured
// POINT in the SAME SendInput array as its button or wheel events, which the OS never interleaves
// with a person's input. False when the point cannot be expressed exactly on the virtual desktop.
// One axis. Windows maps an ABSOLUTE|VIRTUALDESK coordinate to the pixel
// floor(normalized * extent / 65536) from the virtual desktop's origin, so the value chosen is the
// middle of the pixel's interval, ((2 * offset + 1) * 65536) / (2 * extent), which stays in 0..65535.
// False when the coordinate is off the desktop or the value does not map back to the same pixel.
bool WindowsExplorerNormalizeAxis(LONG coordinate, int origin, int extent, LONG *normalized) {
  const std::int64_t offset = static_cast<std::int64_t>(coordinate) - origin;
  if (extent < 1 || offset < 0 || offset >= extent) return false;
  const std::int64_t value = ((2 * offset + 1) * 65536) / (2 * static_cast<std::int64_t>(extent));
  if (value < 0 || value > 65535 || (value * extent) / 65536 != offset) return false;
  *normalized = static_cast<LONG>(value);
  return true;
}

// The virtual desktop's origin and size, which the normalized move is relative to.
struct WindowsExplorerVirtualScreen {
  int left = 0, top = 0, width = 0, height = 0;
  bool operator==(const WindowsExplorerVirtualScreen &) const = default;
};

WindowsExplorerVirtualScreen ReadWindowsExplorerVirtualScreen() {
  return WindowsExplorerVirtualScreen{
      GetSystemMetrics(SM_XVIRTUALSCREEN), GetSystemMetrics(SM_YVIRTUALSCREEN),
      GetSystemMetrics(SM_CXVIRTUALSCREEN), GetSystemMetrics(SM_CYVIRTUALSCREEN)};
}

bool WindowsExplorerAbsoluteMove(POINT point, const WindowsExplorerVirtualScreen &screen,
                                 INPUT *move) {
  *move = INPUT{};
  move->type = INPUT_MOUSE;
  move->mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
  return WindowsExplorerNormalizeAxis(point.x, screen.left, screen.width, &move->mi.dx) &&
         WindowsExplorerNormalizeAxis(point.y, screen.top, screen.height, &move->mi.dy);
}

// With "scroll inactive windows when hovering" off the wheel goes to the keyboard focus, not to the
// window under the cursor. Scroll is sent only when the wheel reaches the window under the cursor,
// or when the keyboard focus of the Explorer thread is inside the measured view.
bool WindowsExplorerWheelReachesView(HWND window, HWND view) {
  UINT routing = MOUSEWHEEL_ROUTING_FOCUS;
  if (!SystemParametersInfoW(SPI_GETMOUSEWHEELROUTING, 0, &routing, 0)) return false;
  if (routing == MOUSEWHEEL_ROUTING_MOUSE_POS) return true;
  DWORD owner = 0;
  const DWORD thread = GetWindowThreadProcessId(window, &owner);
  GUITHREADINFO info{};
  info.cbSize = sizeof(info);
  if (thread == 0 || !GetGUIThreadInfo(thread, &info) || info.hwndFocus == nullptr) return false;
  return info.hwndFocus == view || IsChild(view, info.hwndFocus) != FALSE;
}

// The last step before an Explorer click or scroll: re-measure at the action POINT, then, after that
// re-measure, require the cursor to still be at the POINT and no input (a person's included) since
// `input_tick`, and send [absolute move, actions...] as one array. Nothing is sent on any failure.
bool SendWindowsExplorerPointInput(const WindowsSession &session,
    const std::shared_ptr<const WindowsExplorerDispatchEvidence> &evidence, const RECT &bounds,
    std::uint64_t expected_epoch, POINT point, DWORD input_tick, bool wheel,
    const INPUT *actions, UINT action_count, bool *accepted) {
  if (!evidence || action_count == 0 || action_count > 2) return false;
  INPUT events[3]{};
  // The desktop as it was when the re-measure started. The move itself is fixed only after the last
  // check: a monitor added or a resolution changed during the re-measure would map the same value to
  // another pixel while the bounds, point, cursor and last input time all still agree.
  const WindowsExplorerVirtualScreen measured_screen = ReadWindowsExplorerVirtualScreen();
  if (!WindowsExplorerAbsoluteMove(point, measured_screen, &events[0])) return false;
  for (UINT index = 0; index < action_count; ++index) events[index + 1] = actions[index];
  if (!RecheckWindowsExplorerDispatch(session, evidence, point)) return false;
  if (wheel && !WindowsExplorerWheelReachesView(session.window, evidence->view)) return false;
  POINT cursor{};
  DWORD now_tick = 0;
  if (!GetCursorPos(&cursor) || cursor.x != point.x || cursor.y != point.y ||
      !WindowsReadLastInputTick(&now_tick) || now_tick != input_tick) return false;
  const WindowsExplorerVirtualScreen sending_screen = ReadWindowsExplorerVirtualScreen();
  if (!(sending_screen == measured_screen) ||
      !WindowsExplorerAbsoluteMove(point, sending_screen, &events[0])) return false;
  const UINT count = action_count + 1;
  const UINT sent = SendInputForBoundTarget(session, bounds, expected_epoch, count, events);
  if (sent > 0) *accepted = true;
  return sent == count;
}
// END windows explorer dispatch guard
