// Explorer measurements run on the pipe consumer's STA. No COM pointer crosses a thread.
struct WindowsExplorerViewMeasurement {
  std::optional<std::wstring> folder;
  bool point_owner_matches = false;
};

bool WindowsExplorerPointOwner(HWND window, DWORD pid, POINT point) {
  DWORD owner = 0;
  if (!IsWindow(window) || !GetWindowThreadProcessId(window, &owner) || owner != pid) return false;
  HWND hit = WindowFromPoint(point);
  if (hit == nullptr || GetAncestor(hit, GA_ROOT) != window) return false;
  // WindowFromPoint may return a parent. Descend into visible children, including foreign-process
  // preview handlers. An unreadable/deep tree is not proof of ownership.
  for (unsigned depth = 0; depth != 64; ++depth) {
    if (!GetWindowThreadProcessId(hit, &owner) || owner != pid) return false;
    POINT local = point;
    if (!ScreenToClient(hit, &local)) return false;
    HWND child = ChildWindowFromPointEx(hit, local, CWP_SKIPINVISIBLE);
    if (child == hit || child == nullptr) return true;
    hit = child;
  }
  return false;
}

bool WindowsExplorerPlainFolder(const std::wstring &path) {
  if (path.size() < 3 || path[1] != L':' || path[2] != L'\\') return false;
  // Check every component: a namespace junction anywhere in the path is not a plain folder.
  for (std::size_t end = 3; end <= path.size(); ++end) {
    if (end != path.size() && path[end] != L'\\') continue;
    const std::wstring prefix = path.substr(0, end);
    const std::size_t leaf = prefix.find_last_of(L'\\');
    const auto name = prefix.substr(leaf == std::wstring::npos ? 0 : leaf + 1);
    if (name.find(L".{") != std::wstring::npos || name == L"." || name == L"..") return false;
    const DWORD attributes = GetFileAttributesW(prefix.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES || !(attributes & FILE_ATTRIBUTE_DIRECTORY)) return false;
    // Reparse points cannot establish containment of the operation's item either.
    if (attributes & FILE_ATTRIBUTE_REPARSE_POINT) return false;
    // A desktop.ini customizes the folder that holds it. Ancestors commonly carry one (the user
    // profile, Documents) without making this folder a namespace; an ancestor that is a junction
    // already fails SFGAO_FILESYSTEM for the current folder. So only the viewed folder is checked.
    if (end != path.size()) continue;
    const std::wstring ini = prefix + L"\\desktop.ini";
    const DWORD ini_attributes = GetFileAttributesW(ini.c_str());
    if (ini_attributes == INVALID_FILE_ATTRIBUTES) {
      if (GetLastError() != ERROR_FILE_NOT_FOUND && GetLastError() != ERROR_PATH_NOT_FOUND) return false;
      continue;
    }
    // An unreadable INI is indistinguishable from a missing key through the profile API.
    // Until its complete contents can be proven, any customization file is unknown.
    return false;
  }
  return true;
}

std::optional<std::wstring> ReadWindowsExplorerShellView(
    HWND window, const std::function<bool()> &current) {
  using sprint_coder::computer_use::windows_uia_source_detail::ComRef;
  ComRef<IShellWindows> windows;
  if (!current() || FAILED(CoCreateInstance(CLSID_ShellWindows, nullptr, CLSCTX_LOCAL_SERVER,
      IID_PPV_ARGS(windows.Receive())))) return std::nullopt;
  long count = 0;
  if (!current() || FAILED(windows.Get()->get_Count(&count)) || count < 0 || count > 256)
    return std::nullopt;
  bool matched = false;
  std::optional<std::wstring> measured;
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
        !current() || FAILED(browser.Get()->get_HWND(&handle))) return std::nullopt;
    if (reinterpret_cast<HWND>(handle) != window) continue;
    // Multiple tab automation objects can share a top-level HWND. Do not guess its active view.
    if (matched) return std::nullopt;
    matched = true;
    ComRef<IServiceProvider> provider;
    ComRef<IShellBrowser> shell;
    ComRef<IShellView> view;
    ComRef<IFolderView> folder_view;
    ComRef<IPersistFolder2> folder;
    if (!current() || FAILED(browser.Get()->QueryInterface(IID_PPV_ARGS(provider.Receive()))) ||
        !current() || FAILED(provider.Get()->QueryService(SID_STopLevelBrowser, IID_PPV_ARGS(shell.Receive()))) ||
        !current() || FAILED(shell.Get()->QueryActiveShellView(view.Receive())) ||
        !current() || FAILED(view.Get()->QueryInterface(IID_PPV_ARGS(folder_view.Receive()))) ||
        !current() || FAILED(folder_view.Get()->GetFolder(IID_PPV_ARGS(folder.Receive())))) return std::nullopt;
    struct Pidl {
      PIDLIST_ABSOLUTE value = nullptr;
      ~Pidl() { CoTaskMemFree(value); }
    } pidl;
    if (!current() || FAILED(folder.Get()->GetCurFolder(&pidl.value)) || pidl.value == nullptr)
      return std::nullopt;
    ComRef<IShellItem> shell_item;
    SFGAOF attributes = 0;
    if (!current() || FAILED(SHCreateItemFromIDList(pidl.value, IID_PPV_ARGS(shell_item.Receive()))) ||
        !current() || FAILED(shell_item.Get()->GetAttributes(SFGAO_FILESYSTEM | SFGAO_FOLDER, &attributes)) ||
        (attributes & (SFGAO_FILESYSTEM | SFGAO_FOLDER)) != (SFGAO_FILESYSTEM | SFGAO_FOLDER))
      return std::nullopt;
    struct Path {
      PWSTR value = nullptr;
      ~Path() { CoTaskMemFree(value); }
    } path;
    if (!current() || FAILED(shell_item.Get()->GetDisplayName(SIGDN_FILESYSPATH, &path.value)) ||
        path.value == nullptr || !current() || !WindowsExplorerPlainFolder(path.value) || !current())
      return std::nullopt;
    measured = std::wstring(path.value);
  }
  return current() ? measured : std::nullopt;
}

// CoCancelCall is advisory; a provider that ignores cancellation remains on this consumer until
// Main's existing request deadline kills the helper. Never adopt a late result, including cleanup.
class WindowsExplorerDeadline {
public:
  WindowsExplorerDeadline(std::uint64_t epoch, std::uint64_t serial)
      : epoch_(epoch), serial_(serial), thread_(GetCurrentThreadId()),
        deadline_(std::chrono::steady_clock::now() + std::chrono::milliseconds(800)) {
    enabled_ = SUCCEEDED(CoEnableCallCancellation(nullptr));
    if (enabled_) watcher_ = std::thread([this] {
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
  }
  ~WindowsExplorerDeadline() {
    { std::lock_guard lock(mutex_); done_ = true; }
    ready_.notify_one();
    if (watcher_.joinable()) watcher_.join();
    if (enabled_) CoDisableCallCancellation(nullptr);
  }
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

bool MeasureWindowsExplorerView(const Frame &request, const std::string &metadata,
                                std::string *response) {
  if constexpr (!sprint_coder::computer_use::kWindowsExplorerException) return false;
  WindowsSession *session = FindWindowsSession(request);
  std::string session_id;
  std::uint64_t epoch = 0, window_value = 0;
  double x = 0, y = 0;
  if (session == nullptr || !session->approval_route_v2 || session->approval_revoked ||
      !ReadJsonString(metadata, "sessionId", &session_id) || session_id != session->session_id ||
      !ReadJsonUint64(metadata, "cancelEpoch", &epoch) || epoch != session->cancel_epoch ||
      !ReadJsonUint64(metadata, "windowId", &window_value) ||
      reinterpret_cast<HWND>(static_cast<std::uintptr_t>(window_value)) != session->window ||
      !ReadJsonDouble(metadata, "x", &x) || !ReadJsonDouble(metadata, "y", &y) ||
      !std::isfinite(x) || !std::isfinite(y) || std::trunc(x) != x || std::trunc(y) != y ||
      x < LONG_MIN || x > LONG_MAX || y < LONG_MIN || y > LONG_MAX) return false;
  const auto serial = WindowsValidationFrameStopSerial();
  WindowsSessionIdentityResult identity;
  if (!ReadWindowsSessionIdentityOnLane(*session, serial, &identity) ||
      !identity.identity_matches || identity.elevated) return false;
  WindowsExplorerDeadline deadline(epoch, serial);
  const auto current = [&] { return deadline.Current(); };
  if (!current()) return false;
  if (!WindowsExplorerVerifiedWindow(session->pid, session->window) || !current()) return false;
  DWORD owner = 0;
  if (!GetWindowThreadProcessId(session->window, &owner) || owner != session->pid) return false;
  WindowsExplorerViewMeasurement view;
  view.folder = ReadWindowsExplorerShellView(session->window, current);
  view.point_owner_matches = WindowsExplorerPointOwner(session->window, session->pid,
      POINT{static_cast<LONG>(x), static_cast<LONG>(y)});
  if (!current()) return false;
  *response = "{\"shellView\":" + (view.folder.has_value()
      ? "{\"kind\":\"filesystem_folder\",\"path\":\"" + JsonEscape(Utf8FromWide(*view.folder)) + "\"}"
      : std::string("{\"kind\":\"unknown\"}")) +
      ",\"pointOwnerMatches\":" + (view.point_owner_matches ? "true}" : "false}");
  return current();
}
