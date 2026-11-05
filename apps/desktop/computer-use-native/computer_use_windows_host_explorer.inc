// Explorer measurements run on their owning measurement lane. No COM pointer crosses a thread.
//
// Internal refusal reasons. They never reach the wire: the response says only "unknown",
// pointOwnerMatches false, item kind "unknown", or explorer_view_unreadable. Tests read the reason of
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

struct WindowsExplorerItem {
  std::wstring path;
  std::string pidl_digest;
  std::string kind = "folder";
  std::vector<int> runtime_id;
  bool operator==(const WindowsExplorerItem &) const = default;
};

struct WindowsExplorerShellView {
  std::optional<std::wstring> folder;
  // The measured tab's SHELLDLL_DefView. Input is accepted only inside this window.
  HWND view = nullptr;
  WindowsExplorerRefusal refusal = WindowsExplorerRefusal::kNone;
  WindowsExplorerRefusal folder_refusal = WindowsExplorerRefusal::kNone;
  std::optional<WindowsExplorerItem> item;
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
  std::optional<WindowsExplorerItem> item;
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

// One bounded file-system enumeration covers extension aliases and sibling customizations.
bool WindowsExplorerUnambiguousFolder(const std::wstring &path,
    const std::function<bool()> &current) {
  if (!current()) return false;
  const DWORD attributes = GetFileAttributesW(path.c_str());
  if (attributes == INVALID_FILE_ATTRIBUTES || !(attributes & FILE_ATTRIBUTE_DIRECTORY) ||
      (attributes & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM | FILE_ATTRIBUTE_REPARSE_POINT)))
    return false;
  const auto separator = path.find_last_of(L'\\');
  if (separator == std::wstring::npos) return false;
  const auto parent = path.substr(0, separator + 1);
  const auto leaf = path.substr(separator + 1);
  WIN32_FIND_DATAW entry{};
  struct Search { HANDLE value; ~Search() { if (value != INVALID_HANDLE_VALUE) FindClose(value); } } search{
      FindFirstFileExW((parent + L"*").c_str(), FindExInfoBasic, &entry,
          FindExSearchNameMatch, nullptr, FIND_FIRST_EX_LARGE_FETCH)};
  if (search.value == INVALID_HANDLE_VALUE) return false;
  unsigned count = 0;
  do {
    if (!current()) return false;
    const std::wstring name = entry.cFileName;
    if (name == L"." || name == L"..") continue;
    if (++count > 4096) return false;
    const bool directory = (entry.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
    if (directory && (entry.dwFileAttributes & (FILE_ATTRIBUTE_READONLY | FILE_ATTRIBUTE_SYSTEM))) {
      if (!current()) return false;
      const DWORD ini = GetFileAttributesW((parent + name + L"\\desktop.ini").c_str());
      if (ini != INVALID_FILE_ATTRIBUTES ||
          (GetLastError() != ERROR_FILE_NOT_FOUND && GetLastError() != ERROR_PATH_NOT_FOUND))
        return false;
    }
    const auto dot = name.find_last_of(L'.');
    if (dot == std::wstring::npos ||
        CompareStringOrdinal(name.substr(0, dot).c_str(), -1, leaf.c_str(), -1, TRUE) != CSTR_EQUAL)
      continue;
    // Ordinary folder extensions stay visible; files and .{CLSID} junctions can alias the leaf.
    if (!directory || (name.size() > dot + 2 && name[dot + 1] == L'{' && name.back() == L'}'))
      return false;
  } while (FindNextFileW(search.value, &entry));
  return GetLastError() == ERROR_NO_MORE_FILES && current();
}

bool WindowsExplorerUniqueCachedName(const std::vector<std::wstring> &names,
    const std::wstring &hit_name, const std::function<bool()> &current) {
  unsigned matches = 0;
  for (const auto &name : names) {
    if (!current()) return false;
    if (CompareStringOrdinal(name.c_str(), -1, hit_name.c_str(), -1, TRUE) == CSTR_EQUAL &&
        ++matches > 1) return false;
  }
  return matches == 1 && current();
}

std::optional<WindowsExplorerItem> WindowsExplorerItemFromPidl(
    PCIDLIST_ABSOLUTE parent, PCUITEMID_CHILD child, const std::wstring &folder_path,
    SFGAOF attributes, const std::function<bool()> &current) {
  if (!parent || !child || ILIsEmpty(child) || !ILIsEmpty(ILNext(child)) ||
      (attributes & (SFGAO_FILESYSTEM | SFGAO_FOLDER | SFGAO_LINK)) !=
          (SFGAO_FILESYSTEM | SFGAO_FOLDER)) return std::nullopt;
  struct Absolute { PIDLIST_ABSOLUTE value = nullptr; ~Absolute() { CoTaskMemFree(value); } } absolute;
  absolute.value = ILCombine(parent, child);
  if (!absolute.value || !ILIsParent(parent, absolute.value, TRUE)) return std::nullopt;
  std::wstring path(32768, L'\0');
  if (!current() || !SHGetPathFromIDListEx(absolute.value, path.data(),
      static_cast<DWORD>(path.size()), GPFIDL_DEFAULT)) return std::nullopt;
  path.resize(wcslen(path.c_str()));
  const auto separator = path.find_last_of(L'\\');
  const auto expected_parent = folder_path.size() == 3 ? folder_path.substr(0, 2) : folder_path;
  if (separator == std::wstring::npos ||
      !WindowsExplorerAsciiEqual(path.substr(0, separator), expected_parent) ||
      path.find_first_of(L"/:*?\"<>|", 2) != std::wstring::npos ||
      path.empty() || path.back() == L'.' || path.back() == L' ' ||
      (path.size() >= 4 && WindowsExplorerAsciiEqual(path.substr(path.size() - 4), L".lnk")) ||
      !current() || !WindowsExplorerUnambiguousFolder(path, current) ||
      !WindowsExplorerPlainFolder(path) || !current()) return std::nullopt;
  // SHGetPathFromIDListEx supplies the shell's absolute file-system spelling; no model path
  // participates. Keep non-ASCII case exact, as Main does, and normalize ASCII only.
  for (auto &character : path) if (character >= L'A' && character <= L'Z') character += L'a' - L'A';
  const auto size = ILGetSize(absolute.value);
  if (size < 2 || size > 65536) return std::nullopt;
  const auto *bytes = reinterpret_cast<const std::uint8_t *>(absolute.value);
  const auto digest = Sha256Bytes(std::vector<std::uint8_t>(bytes, bytes + size));
  if (digest.size() != 64) return std::nullopt;
  return WindowsExplorerItem{path, digest, "folder"};
}

thread_local const char *windows_explorer_item_stage_for_test = "not_started";

// UIA supplies the hit display name, never a path or kind. File-system names are unique;
// hidden extensions can alias a file or .{CLSID} junction to the candidate's name, so the
// bounded sibling scan refuses those aliases and hidden/system candidates. PlainFolder checks
// ONLY the parsed candidate, not the drawn entry: a different sibling can use desktop.ini to
// impersonate it. Therefore the same scan refuses every READONLY/SYSTEM sibling folder with
// desktop.ini, and both cached UIA batches must contain exactly one matching ListItem name.
// The parsed PIDL's SHGDN_NORMAL and parsing names must still equal the hit name. No full-view
// COM membership walk is used (GetVisibleItem includes offscreen entries and exhausts 800ms).
// The final UIA hit is rechecked; reordering between this check and SendInput belongs to P5b-B.
std::optional<WindowsExplorerItem> ReadWindowsExplorerItem(
    HWND window, HWND view, IFolderView *folder_view, PCIDLIST_ABSOLUTE parent,
    const std::wstring &folder_path, POINT point, const std::function<bool()> &current) {
  using namespace sprint_coder::computer_use::windows_uia_source_detail;
  DWORD pid = 0;
  if (!current() || !GetWindowThreadProcessId(window, &pid) ||
      WindowsExplorerPointRefusal(window, view, pid, point) != WindowsExplorerRefusal::kNone)
    return std::nullopt;
  ComRef<IUIAutomation> automation;
  ComRef<IUIAutomationElement> root;
  ComRef<IUIAutomationCondition> condition;
  ComRef<IUIAutomationElementArray> items;
  ComRef<IUIAutomationCacheRequest> cache;
  windows_explorer_item_stage_for_test = "uia_setup";
  VARIANT type; VariantInit(&type); type.vt = VT_I4; type.lVal = UIA_ListItemControlTypeId;
  if (!current() || !CreateBoundedAutomation(150, 150, automation.Receive()) ||
      !current() || FAILED(automation.Get()->ElementFromHandle(view, root.Receive())) ||
      !current() || FAILED(automation.Get()->CreatePropertyCondition(UIA_ControlTypePropertyId,
          type, condition.Receive())) ||
      FAILED(automation.Get()->CreateCacheRequest(cache.Receive()))) return std::nullopt;
  for (const auto property : {UIA_NamePropertyId, UIA_ProcessIdPropertyId,
      UIA_IsOffscreenPropertyId, UIA_BoundingRectanglePropertyId, UIA_RuntimeIdPropertyId})
    if (FAILED(cache.Get()->AddProperty(property))) return std::nullopt;
  windows_explorer_item_stage_for_test = "uia_candidate";
  if (!current() || FAILED(root.Get()->FindAllBuildCache(TreeScope_Descendants, condition.Get(), cache.Get(), items.Receive())))
    return std::nullopt;
  int count = 0;
  if (!current() || FAILED(items.Get()->get_Length(&count)) || count < 1 || count > 4096)
    return std::nullopt;
  std::vector<std::wstring> cached_names;
  std::optional<std::wstring> hit_name;
  ComRef<IUIAutomationElement> hit;
  for (int index = 0; index < count; ++index) {
    ComRef<IUIAutomationElement> item;
    RECT bounds{}; BOOL offscreen = TRUE; int owner = 0;
    BstrHolder name;
    if (!current() || FAILED(items.Get()->GetElement(index, item.Receive())) ||
        FAILED(item.Get()->get_CachedProcessId(&owner)) || owner != static_cast<int>(pid) ||
        FAILED(item.Get()->get_CachedIsOffscreen(&offscreen)) ||
        FAILED(item.Get()->get_CachedBoundingRectangle(&bounds)) ||
        FAILED(item.Get()->get_CachedName(name.Receive()))) return std::nullopt;
    cached_names.emplace_back(name.View());
    if (offscreen || !PtInRect(&bounds, point)) continue;
    if (hit_name) return std::nullopt;
    if (name.View().empty()) return std::nullopt;
    hit_name = std::wstring(name.View());
    hit = std::move(item);
  }
  windows_explorer_item_stage_for_test = "uia_name_uniqueness";
  if (!hit_name || !WindowsExplorerUniqueCachedName(cached_names, *hit_name, current))
    return std::nullopt;
  const auto runtime_id = [](IUIAutomationElement *element) -> std::vector<int> {
    VARIANT id; VariantInit(&id);
    const HRESULT read = element->GetCachedPropertyValue(UIA_RuntimeIdPropertyId, &id);
    LONG first = 0, last = -1;
    std::vector<int> values;
    bool valid = SUCCEEDED(read) && id.vt == (VT_ARRAY | VT_I4) && id.parray &&
        SafeArrayGetDim(id.parray) == 1 &&
        SUCCEEDED(SafeArrayGetLBound(id.parray, 1, &first)) &&
        SUCCEEDED(SafeArrayGetUBound(id.parray, 1, &last)) && last >= first && last - first < 64;
    if (valid) for (LONG offset = first; offset <= last; ++offset) {
      int value = 0;
      if (FAILED(SafeArrayGetElement(id.parray, &offset, &value))) { valid = false; break; }
      values.push_back(value);
    }
    VariantClear(&id);
    return valid ? values : std::vector<int>{};
  };
  const auto initial_id = runtime_id(hit.Get());
  if (initial_id.empty() || *hit_name == L"." || *hit_name == L".." ||
      hit_name->find_first_of(L"\\/:*?\"<>|") != std::wstring::npos) return std::nullopt;
  windows_explorer_item_stage_for_test = "pidl_lookup";
  const std::wstring candidate = folder_path + L"\\" + *hit_name;
  const DWORD candidate_attributes = GetFileAttributesW(candidate.c_str());
  if (candidate_attributes == INVALID_FILE_ATTRIBUTES ||
      !(candidate_attributes & FILE_ATTRIBUTE_DIRECTORY) ||
      (candidate_attributes & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM | FILE_ATTRIBUTE_REPARSE_POINT))) {
    windows_explorer_item_stage_for_test = "attributes_or_display_collision";
    // This diagnostic proves the hidden-extension live case reached file classification.
    // It cannot authorize an item and does not feed the measured path.
    if (current()) {
      WIN32_FIND_DATAW entry{};
      const DWORD attributes = GetFileAttributesW(candidate.c_str());
      if (attributes != INVALID_FILE_ATTRIBUTES && !(attributes & FILE_ATTRIBUTE_DIRECTORY))
        windows_explorer_item_stage_for_test = "file_refused";
      else if (attributes == INVALID_FILE_ATTRIBUTES) {
        HANDLE search = FindFirstFileExW((candidate + L".*").c_str(), FindExInfoBasic,
            &entry, FindExSearchNameMatch, nullptr, FIND_FIRST_EX_LARGE_FETCH);
        if (search != INVALID_HANDLE_VALUE) {
          const std::wstring name = entry.cFileName;
          const auto dot = name.find_last_of(L'.');
          if (!(entry.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) && dot != std::wstring::npos &&
              CompareStringOrdinal(name.substr(0, dot).c_str(), -1, hit_name->c_str(), -1, TRUE) == CSTR_EQUAL)
            windows_explorer_item_stage_for_test = "file_refused";
          FindClose(search);
        }
      }
    }
    return std::nullopt;
  }
  ComRef<IShellFolder> folder;
  if (!current() || FAILED(folder_view->GetFolder(IID_PPV_ARGS(folder.Receive()))))
    return std::nullopt;
  struct Child { PITEMID_CHILD value = nullptr; ~Child() { CoTaskMemFree(value); } } child;
  SFGAOF attributes = SFGAO_FILESYSTEM | SFGAO_FOLDER | SFGAO_LINK;
  ULONG eaten = 0;
  if (!current() || FAILED(folder.Get()->ParseDisplayName(nullptr, nullptr, hit_name->data(),
      &eaten, &child.value, &attributes)) || !child.value || ILIsEmpty(child.value) ||
      !ILIsEmpty(ILNext(child.value))) return std::nullopt;
  windows_explorer_item_stage_for_test = "pidl_display_name";
  // Plain parsing names exclude localized aliases and hidden extensions.
  for (const auto flags : {static_cast<SHGDNF>(SHGDN_NORMAL), static_cast<SHGDNF>(SHGDN_INFOLDER | SHGDN_FORPARSING)}) {
    STRRET display{};
    struct Text { PWSTR value = nullptr; ~Text() { CoTaskMemFree(value); } } name;
    if (!current() || FAILED(folder.Get()->GetDisplayNameOf(child.value, flags, &display)) ||
        FAILED(StrRetToStrW(&display, child.value, &name.value)) || !name.value ||
        *hit_name != name.value) return std::nullopt;
  }
  windows_explorer_item_stage_for_test = "pidl_classification_and_sibling_scan";
  auto result = WindowsExplorerItemFromPidl(parent, child.value, folder_path, attributes, current);
  if (!result) return std::nullopt;
  result->runtime_id = initial_id;
  // Shell calls above may pump messages. Refresh all bounds and names in one batch, LAST.
  windows_explorer_item_stage_for_test = "uia_final_hit";
  ComRef<IUIAutomationElementArray> refreshed;
  if (!current() || FAILED(root.Get()->FindAllBuildCache(TreeScope_Descendants, condition.Get(),
      cache.Get(), refreshed.Receive())) || !current() ||
      FAILED(refreshed.Get()->get_Length(&count)) || count < 1 || count > 4096) return std::nullopt;
  cached_names.clear();
  unsigned hits = 0;
  for (int index = 0; index < count; ++index) {
    ComRef<IUIAutomationElement> item;
    RECT bounds{}; BOOL offscreen = TRUE; int owner = 0;
    BstrHolder name;
    if (!current() || FAILED(refreshed.Get()->GetElement(index, item.Receive())) ||
        FAILED(item.Get()->get_CachedName(name.Receive())) ||
        FAILED(item.Get()->get_CachedProcessId(&owner)) || owner != static_cast<int>(pid) ||
        FAILED(item.Get()->get_CachedIsOffscreen(&offscreen)) ||
        FAILED(item.Get()->get_CachedBoundingRectangle(&bounds))) return std::nullopt;
    cached_names.emplace_back(name.View());
    if (offscreen || !PtInRect(&bounds, point)) continue;
    if (++hits != 1 || name.View() != *hit_name || runtime_id(item.Get()) != initial_id)
      return std::nullopt;
    hit = std::move(item);
  }
  if (hits != 1 || !WindowsExplorerUniqueCachedName(cached_names, *hit_name, current))
    return std::nullopt;
  // Bounds alone could describe an item covered by another same-process element.
  ComRef<IUIAutomationElement> at_point;
  ComRef<IUIAutomationTreeWalker> walker;
  if (!current() || FAILED(automation.Get()->ElementFromPoint(point, at_point.Receive())) ||
      !current() || FAILED(automation.Get()->get_RawViewWalker(walker.Receive()))) return std::nullopt;
  bool reached = false;
  for (unsigned depth = 0; depth != 32 && at_point.Get(); ++depth) {
    BOOL same = FALSE;
    if (!current() || FAILED(automation.Get()->CompareElements(hit.Get(), at_point.Get(), &same)))
      return std::nullopt;
    if (same) { reached = true; break; }
    ComRef<IUIAutomationElement> parent_element;
    if (!current() || FAILED(walker.Get()->GetParentElement(at_point.Get(), parent_element.Receive())))
      return std::nullopt;
    at_point = std::move(parent_element);
  }
  if (!reached) return std::nullopt;
  if (!current()) return std::nullopt;
  windows_explorer_item_stage_for_test = "complete";
  return result;
}

WindowsExplorerShellView ReadWindowsExplorerShellView(
    HWND window, const std::function<bool()> &current, const POINT *point = nullptr) {
  using sprint_coder::computer_use::windows_uia_source_detail::ComRef;
  WindowsExplorerShellView result;
  if (point) windows_explorer_item_stage_for_test = "view_lookup";
  const auto refuse = [&](WindowsExplorerRefusal reason) {
    result.folder.reset();
    result.item.reset();
    result.refusal = current() ? reason : WindowsExplorerRefusal::kCancelled;
    return result;
  };
  ComRef<IShellWindows> windows;
  if (!current() || FAILED(CoCreateInstance(CLSID_ShellWindows, nullptr, CLSCTX_LOCAL_SERVER,
      IID_PPV_ARGS(windows.Receive())))) return refuse(WindowsExplorerRefusal::kShellWindows);
  long count = 0;
  if (!current() || FAILED(windows.Get()->get_Count(&count)) || count < 0 || count > 256)
    return refuse(WindowsExplorerRefusal::kShellWindows);
  ComRef<IFolderView> measured_folder_view;
  struct MeasuredParent { PIDLIST_ABSOLUTE value = nullptr;
    ~MeasuredParent() { CoTaskMemFree(value); } } measured_parent;
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
    if (point) {
      measured_parent.value = ILCloneFull(pidl.value);
      if (!measured_parent.value) return refuse(WindowsExplorerRefusal::kViewUnreadable);
      measured_folder_view = std::move(folder_view);
    }
  }
  if (!current()) return refuse(WindowsExplorerRefusal::kCancelled);
  if (!matched) return refuse(WindowsExplorerRefusal::kViewNotFound);
  // Finish shell-window enumeration before the final point check; no slow shell calls follow it.
  if (point) result.item = ReadWindowsExplorerItem(window, result.view, measured_folder_view.Get(),
      measured_parent.value, *result.folder, *point, current);
  if (!current()) {
    windows_explorer_item_stage_for_test = "deadline_or_cancelled";
    return refuse(WindowsExplorerRefusal::kCancelled);
  }
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
  const POINT point{static_cast<LONG>(x), static_cast<LONG>(y)};
  const WindowsExplorerShellView shell_view = ReadWindowsExplorerShellView(session->window, current, &point);
  trace->view = shell_view.refusal;
  trace->folder = shell_view.folder_refusal;
  WindowsExplorerViewMeasurement view;
  view.folder = shell_view.folder;
  HWND point_owner = nullptr;
  trace->point = shell_view.view == nullptr ? WindowsExplorerRefusal::kPointOutsideView
      : WindowsExplorerPointRefusal(session->window, shell_view.view, session->pid,
                                    point, &point_owner);
  view.point_owner_matches = trace->point == WindowsExplorerRefusal::kNone;
  if (!current()) return refuse(WindowsExplorerRefusal::kNotCurrent);
  *response = "{\"shellView\":" + (view.folder.has_value()
      ? "{\"kind\":\"filesystem_folder\",\"path\":\"" + JsonEscape(Utf8FromWide(*view.folder)) + "\"}"
      : std::string("{\"kind\":\"unknown\"}")) +
      ",\"pointOwnerMatches\":" + (view.point_owner_matches ? "true" : "false") +
      ",\"item\":" + (shell_view.item && view.point_owner_matches
          ? "{\"kind\":\"folder\",\"surface\":\"file_list\",\"path\":\"" +
              JsonEscape(Utf8FromWide(shell_view.item->path)) + "\",\"pidlDigest\":\"" +
              shell_view.item->pidl_digest + "\"}"
          : std::string("{\"kind\":\"unknown\"}")) + "}";
  if (!current()) return refuse(WindowsExplorerRefusal::kNotCurrent);
  if (view.point_owner_matches && view.folder.has_value() && shell_view.item &&
      shell_view.refusal == WindowsExplorerRefusal::kNone &&
      shell_view.folder_refusal == WindowsExplorerRefusal::kNone) {
    session->explorer_dispatch_evidence = std::make_shared<WindowsExplorerDispatchEvidence>(
        WindowsExplorerDispatchEvidence{session->window, shell_view.view, point_owner, session->pid,
            point, view.folder, epoch, serial, session->input_api_attempts, false, shell_view.item});
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
  if (kind != "click") return false;
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
      const auto shell_view = ReadWindowsExplorerShellView(session.window, current, &point);
      if (!current() || shell_view.refusal != WindowsExplorerRefusal::kNone ||
          shell_view.folder_refusal != WindowsExplorerRefusal::kNone ||
          !shell_view.folder.has_value() || shell_view.view != evidence->view ||
          shell_view.folder != evidence->folder || !evidence->item ||
          shell_view.item != evidence->item) return false;
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
