#pragma once

// Classifier v2, S5-b-2a: the Windows side of the shadow reader. This is the ONLY place that talks
// to UI Automation for the shadow: it implements `ShadowUiaSource` (computer_use_windows_shadow_reader.h)
// with one platform call per method. Nothing here decides what to read or whether it may: the
// reader admits every call through its gate first, and settles every answer.
//
// What it does, and does not do:
//   * it only READS: element properties (control type, class name, name, automation id, help text,
//     password flag), the tree (parent, first child, next sibling, compare), the value of a
//     Document (the page URL), the process that owns a window, and the file-system path of a shell
//     item. No pattern is invoked, no value is written, focus is not moved, no input is sent;
//   * an error is kFailed, "no value / unsupported" is kAbsent, a string over its bound is kTooLong,
//     and none of them is ever turned into an empty string;
//   * strings are folded to NFKC (NormalizeString) before the core sees them, as the core expects,
//     and the bound is judged in UTF-8 BYTES on the converted string (the UTF-16 length is only a
//     cheap cut before converting something huge);
//   * identifiers used to FIND the target are not normalized.
// It is not wired into the host yet (S5-b-2b runs the reader off the serial lane, on a thread that
// has initialized COM). The thread that calls it must have COM initialized.

#include "computer_use_windows_shadow_reader.h"
#include "computer_use_windows_shell_name_match.h"

#include <windows.h>

#include <ole2.h>
#include <UIAutomation.h>
#include <exdisp.h>
#include <servprov.h>
#include <shlguid.h>
#include <shlobj.h>
#include <shobjidl.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cwchar>
#include <functional>
#include <mutex>
#include <memory>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#pragma comment(lib, "normaliz.lib")

namespace sprint_coder::computer_use {

namespace windows_uia_source_detail {

// A UTF-16 string as the shadow wants it: NFKC when `normalize`, then UTF-8, then the byte bound.
// Never truncated and never emptied: lone surrogates and anything NormalizeString refuses are a
// failed read, a string over the bound is too long, an empty string is absent.
[[nodiscard]] inline ShadowReadResult ShadowTextFromUtf16(std::wstring_view text, bool normalize,
                                                          std::size_t maximum_bytes,
                                                          std::string *output) {
  if (text.empty()) return ShadowReadResult::kAbsent;
  if (ShadowUnitsTooLong(text.size(), maximum_bytes)) return ShadowReadResult::kTooLong;
  std::wstring folded(text);
  if (normalize) {
    // NFKC. It can lengthen a string (a ligature becomes several letters), so the cut is checked
    // again afterwards. The documented loop: ask for an estimate, then retry while the buffer is
    // too small.
    const int source_units = static_cast<int>(text.size());
    int estimate = NormalizeString(NormalizationKC, text.data(), source_units, nullptr, 0);
    folded.clear();
    for (int attempt = 0; attempt < 4 && estimate > 0; ++attempt) {
      std::wstring buffer(static_cast<std::size_t>(estimate), L'\0');
      const int written = NormalizeString(NormalizationKC, text.data(), source_units,
                                          buffer.data(), estimate);
      if (written > 0) {
        buffer.resize(static_cast<std::size_t>(written));
        folded = std::move(buffer);
        break;
      }
      if (GetLastError() != ERROR_INSUFFICIENT_BUFFER) return ShadowReadResult::kFailed;
      estimate = -written;
    }
    if (folded.empty()) return ShadowReadResult::kFailed;
    if (ShadowUnitsTooLong(folded.size(), maximum_bytes)) return ShadowReadResult::kTooLong;
  }
  const int units = static_cast<int>(folded.size());
  const int bytes = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, folded.data(), units, nullptr,
                                        0, nullptr, nullptr);
  if (bytes <= 0) return ShadowReadResult::kFailed;
  // The bound is on the converted string; do not build something far beyond it.
  if (static_cast<std::size_t>(bytes) > maximum_bytes) return ShadowReadResult::kTooLong;
  std::string utf8(static_cast<std::size_t>(bytes), '\0');
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, folded.data(), units, utf8.data(), bytes,
                          nullptr, nullptr) != bytes)
    return ShadowReadResult::kFailed;
  return ShadowCheckText(utf8, maximum_bytes, output);
}

// The name of a UIA control type id; an id this table does not know is named by its number, which
// no rule matches (it is not "no role").
[[nodiscard]] inline std::string ControlTypeName(CONTROLTYPEID id) {
  static constexpr const char *kNames[] = {
      "Button",      "Calendar",   "CheckBox", "ComboBox",   "Edit",       "Hyperlink",
      "Image",       "ListItem",   "List",     "Menu",       "MenuBar",    "MenuItem",
      "ProgressBar", "RadioButton", "ScrollBar", "Slider",    "Spinner",    "StatusBar",
      "Tab",         "TabItem",    "Text",     "ToolBar",    "ToolTip",    "Tree",
      "TreeItem",    "Custom",     "Group",    "Thumb",      "DataGrid",   "DataItem",
      "Document",    "SplitButton", "Window",  "Pane",       "Header",     "HeaderItem",
      "Table",       "TitleBar",   "Separator", "SemanticZoom", "AppBar"};
  if (id >= UIA_ButtonControlTypeId && id <= UIA_AppBarControlTypeId)
    return kNames[id - UIA_ButtonControlTypeId];
  return "ControlType" + std::to_string(static_cast<long>(id));
}

[[nodiscard]] inline std::wstring Widen(const std::string &ascii) {
  return std::wstring(ascii.begin(), ascii.end());
}

template <class Interface> class ComRef {
public:
  ComRef() = default;
  explicit ComRef(Interface *pointer) : pointer_(pointer) {}
  ComRef(const ComRef &) = delete;
  ComRef &operator=(const ComRef &) = delete;
  ComRef(ComRef &&other) noexcept : pointer_(other.pointer_) { other.pointer_ = nullptr; }
  ComRef &operator=(ComRef &&other) noexcept {
    if (this != &other) {
      Reset();
      pointer_ = other.pointer_;
      other.pointer_ = nullptr;
    }
    return *this;
  }
  ~ComRef() { Reset(); }
  [[nodiscard]] Interface *Get() const { return pointer_; }
  [[nodiscard]] Interface **Receive() {
    Reset();
    return &pointer_;
  }
  void Reset() {
    if (pointer_ != nullptr) pointer_->Release();
    pointer_ = nullptr;
  }

private:
  Interface *pointer_ = nullptr;
};

// A BSTR that is freed whatever the path.
class BstrHolder {
public:
  BstrHolder() = default;
  BstrHolder(const BstrHolder &) = delete;
  BstrHolder &operator=(const BstrHolder &) = delete;
  ~BstrHolder() {
    if (text_ != nullptr) SysFreeString(text_);
  }
  [[nodiscard]] BSTR *Receive() { return &text_; }
  [[nodiscard]] std::wstring_view View() const {
    return text_ == nullptr ? std::wstring_view() : std::wstring_view(text_, SysStringLen(text_));
  }

private:
  BSTR text_ = nullptr;
};


// What the shell knows about an item: the path in the file system, and whether it opens by browsing.
struct ShellItemAnswer {
  std::wstring path;
  bool is_folder = false;
};

// How long the shell lookup may go on. It is ONE gated call of the reader, so it keeps its own
// limits: the action still being valid, a deadline, and (in the matcher) a cap on the candidate
// entries it collects. A lookup past the deadline, or with more candidates than the cap, is "not
// known". The size of the folder does not matter: only entries whose names start with the display
// name are listed.
struct ShellLookupLimits {
  std::function<bool()> still_valid;
  std::function<std::uint64_t()> now_ns;
  std::uint64_t deadline_ns = 0;
};
constexpr int kShellLookupMaxWindows = 64;
constexpr std::uint64_t kShellLookupBudgetNs = 60'000'000;

// Whether the file system compares two names as equal, the way Explorer does (ordinal, case-blind).
[[nodiscard]] inline bool ShellNameEqualsOrdinal(std::wstring_view left, std::wstring_view right) {
  if (left.size() != right.size()) return false;
  if (left.empty()) return true;
  return CompareStringOrdinal(left.data(), static_cast<int>(left.size()), right.data(),
                              static_cast<int>(right.size()), TRUE) == CSTR_EQUAL;
}

struct FindHandle {
  HANDLE handle = INVALID_HANDLE_VALUE;
  FindHandle() = default;
  FindHandle(const FindHandle &) = delete;
  FindHandle &operator=(const FindHandle &) = delete;
  ~FindHandle() {
    if (handle != INVALID_HANDLE_VALUE) FindClose(handle);
  }
};

struct AbsoluteIdList {
  PIDLIST_ABSOLUTE id = nullptr;
  AbsoluteIdList() = default;
  AbsoluteIdList(const AbsoluteIdList &) = delete;
  AbsoluteIdList &operator=(const AbsoluteIdList &) = delete;
  ~AbsoluteIdList() {
    if (id != nullptr) ILFree(id);
  }
};

[[nodiscard]] inline std::wstring ShellPathWithoutTrailingSeparator(std::wstring path) {
  while (path.size() > 3 && path.back() == L'\\') path.pop_back();
  return path;
}

// Whether a lookup must stop now, before it starts one more call that could block on the file
// system: the action is no longer valid or the caller gave up (kStopped; the caller then also cancels
// a call that is already blocked, but cannot cancel one that is started after), or the deadline passed
// (kAbsent). Asked before EVERY new I/O step of the lookup.
[[nodiscard]] inline bool ShellLookupMustStop(const ShellLookupLimits &limits, ShadowReadResult *result) {
  if (!limits.still_valid()) {
    *result = ShadowReadResult::kStopped;
    return true;
  }
  if (limits.now_ns() > limits.deadline_ns) {
    *result = ShadowReadResult::kAbsent;
    return true;
  }
  return false;
}

// Whether a drive type is one whose files are read from a local disk: not a network drive, an
// optical drive, an unknown one or a root that does not exist.
[[nodiscard]] inline bool ShellDriveIsLocalDisk(UINT drive) {
  if (drive == DRIVE_REMOTE || drive == DRIVE_CDROM || drive == DRIVE_UNKNOWN ||
      drive == DRIVE_NO_ROOT_DIR)
    return false;
  return true;
}

// Whether any part of `path` (below its volume root) is a symbolic link or a volume mount point:
// those can lead to a network or optical location that the drive letter does not show. Cloud file
// tags and other reparse points are not links in this sense. A part that cannot be looked at counts
// as a link (fail-closed), and so does a stop (see ShellLookupMustStop; *result then says why).
[[nodiscard]] inline bool ShellPathHasLink(const std::wstring &root, const std::wstring &path,
                                           const ShellLookupLimits &limits, ShadowReadResult *result) {
  const std::wstring trimmed = ShellPathWithoutTrailingSeparator(path);
  std::size_t at = root.size();
  for (;;) {
    const std::size_t next = trimmed.find(L'\\', at);
    const std::wstring part = trimmed.substr(0, next == std::wstring::npos ? trimmed.size() : next);
    if (part.size() > root.size()) {
      // Each part is one more file system call: not after the caller gave up or the deadline passed (a
      // stop counts as "a link": fail-closed, and the caller returns the stop result).
      if (ShellLookupMustStop(limits, result)) return true;
      WIN32_FIND_DATAW data{};
      FindHandle find;
      find.handle = FindFirstFileExW(part.c_str(), FindExInfoBasic, &data, FindExSearchNameMatch,
                                     nullptr, 0);
      if (find.handle == INVALID_HANDLE_VALUE) return true;
      if (ShellReparseIsLink((data.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0,
                             data.dwReserved0))
        return true;
    }
    if (next == std::wstring::npos) return false;
    at = next + 1;
  }
}

// Whether the folder at `path` is one whose entries may be listed here: a plain directory on a local
// disk, whose view shows exactly its own entries under the names the shell gives them. Decided
// BEFORE any listing, and fail-closed (a doubt is "no"):
//  - a network location (a UNC path, a remote, optical or unknown drive) can block for long. It is
//    excluded in TWO steps: first by the type of the drive letter (GetDriveTypeW on the first three
//    characters: no I/O, so a drive mapped to an SMB share that does not answer is never touched),
//    and only then GetVolumePathNameW finds the VOLUME the path is on (a mount point inside a local
//    drive can lead elsewhere), whose type is checked again. A symbolic link or mount point on the
//    way is refused. The root of a mounted volume itself (C:\\mnt\\vol, listed as the folder) is not
//    listed either: its volume root is longer than its path, which is "no" (fail-closed);
//  - the desktop folders (the user's and the public one) are shown MERGED in the desktop view, so an
//    entry of the other folder looks like one of this folder. Their paths are asked WITHOUT
//    verifying them (KF_FLAG_DONT_VERIFY): a redirected desktop would otherwise be probed over the
//    network.
//
// Every file system call here is preceded by ShellLookupMustStop: on a stop the answer is "no" and
// *result is kStopped or kAbsent (the caller returns it); on any other "no" *result is untouched.
//
// A known limit: the folder could be swapped for a link between this check and the listing (TOCTOU).
// It is accepted, because only a local operation of the same user on this machine can do it, and a
// swap does not make the answer wrong by itself: every candidate must still resolve (by its file
// system path) to the very entry that was listed, and the action is re-evaluated just before it is
// sent (the dispatch guard of the later step), so a folder that changed in between is seen again.
[[nodiscard]] inline bool ShellFolderMayBeListed(const std::wstring &path, const ShellLookupLimits &limits,
                                                 ShadowReadResult *result) {
  if (path.size() < 3 || path[0] == L'\\') return false;
  if (path[1] != L':' || path[2] != L'\\') return false;
  // Step 1: the drive letter's type, with no I/O (a share that does not answer is not touched).
  if (!ShellDriveIsLocalDisk(GetDriveTypeW(path.substr(0, 3).c_str()))) return false;
  // Step 2: the volume the path is really on, and its type. From here on every call may block.
  std::wstring root(MAX_PATH * 2, L'\0');
  if (ShellLookupMustStop(limits, result)) return false;
  if (!GetVolumePathNameW(path.c_str(), root.data(), static_cast<DWORD>(root.size()))) return false;
  root.resize(wcslen(root.c_str()));
  if (root.size() < 3 || root[0] == L'\\' || root.size() > path.size() ||
      !ShellNameEqualsOrdinal(std::wstring_view(path).substr(0, root.size()), root))
    return false;
  if (!ShellDriveIsLocalDisk(GetDriveTypeW(root.c_str()))) return false;
  const std::wstring trimmed = ShellPathWithoutTrailingSeparator(path);
  for (const KNOWNFOLDERID &known : {FOLDERID_Desktop, FOLDERID_PublicDesktop}) {
    PWSTR folder = nullptr;
    if (ShellLookupMustStop(limits, result)) return false;
    if (FAILED(SHGetKnownFolderPath(known, KF_FLAG_DONT_VERIFY, nullptr, &folder)) || folder == nullptr) {
      if (folder != nullptr) CoTaskMemFree(folder);
      return false;
    }
    const bool same = ShellNameEqualsOrdinal(ShellPathWithoutTrailingSeparator(folder), trimmed);
    CoTaskMemFree(folder);
    if (same) return false;
  }
  return !ShellPathHasLink(root, path, limits, result);
}

// Whether the files of the folder can be shown under names that have nothing to do with their file
// names (a desktop.ini with a non-empty [LocalizedFileNames] section: see
// ShellDesktopIniLocalizesFileNames for the rule, which treats what cannot be read as a yes). Then an
// entry that is not a candidate by its file name could still carry the display name. Only that
// section is read; the file is never opened otherwise.
[[nodiscard]] inline bool ShellFolderHasLocalizedFileNames(const std::wstring &path,
                                                           const ShellLookupLimits &limits,
                                                           ShadowReadResult *result) {
  const std::wstring folder = ShellPathWithoutTrailingSeparator(path);
  const std::wstring settings = folder + L"\\desktop.ini";
  // A stop counts as "yes" (fail-closed); *result then says why. Asked before EVERY call below.
  // The shell reads a desktop.ini only in a folder that is read-only or system: other folders are
  // not read at all. And a desktop.ini that is a link (of any kind) is never read, because the profile
  // API would follow it, possibly to a network location (and authenticate there).
  if (ShellLookupMustStop(limits, result)) return true;
  const DWORD folder_attributes = GetFileAttributesW(folder.c_str());
  const bool folder_known = folder_attributes != INVALID_FILE_ATTRIBUTES;
  bool found = false;
  DWORD lookup_error = 0;
  bool is_reparse_point = false;
  DWORD length = 0;
  DWORD section_error = 0;
  if (folder_known && (folder_attributes & (FILE_ATTRIBUTE_READONLY | FILE_ATTRIBUTE_SYSTEM)) != 0) {
    if (ShellLookupMustStop(limits, result)) return true;
    WIN32_FIND_DATAW data{};
    FindHandle find;
    find.handle = FindFirstFileExW(settings.c_str(), FindExInfoBasic, &data, FindExSearchNameMatch,
                                   nullptr, 0);
    found = find.handle != INVALID_HANDLE_VALUE;
    lookup_error = found ? 0 : GetLastError();
    is_reparse_point = found && (data.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
    if (found && !is_reparse_point) {
      if (ShellLookupMustStop(limits, result)) return true;
      std::wstring section(32767, L'\0');
      SetLastError(0);
      length = GetPrivateProfileSectionW(L"LocalizedFileNames", section.data(),
                                         static_cast<DWORD>(section.size()), settings.c_str());
      section_error = GetLastError();
    }
  }
  return ShellDesktopIniLocalizesFileNames(folder_known, folder_attributes, found, lookup_error,
                                           is_reparse_point, length, section_error);
}

// The path of the item a file browser shows under `display_name`. The folder the view shows is asked
// for its file-system path ONCE, and only a plain local directory is looked into (see
// ShellFolderMayBeListed; the root of the desktop namespace has an empty id list and is not; a folder
// whose desktop.ini localizes file names is not either). The folder is listed ONCE in THIS process
// (FindFirstFileExW: file system metadata only), and the SHELL is asked for the name it shows (the
// very name Explorer shows: a hidden extension of any kind, a folder with a dot in its name) only for
// the entries that can carry the display name: those whose file name STARTS WITH it, and the
// directories that are read-only or system (the only ones a desktop.ini can give another name, as
// "Documents" shown as the localized word). MatchShellDisplayName takes the one whose shell name is
// the display name, if there is exactly one and every such entry could be read. Read-only: windows
// and views are asked for, never navigated, selected or invoked, and nothing is opened. kAbsent when
// there is no such view, the folder is not a plain local directory, no or more than one entry fits, a
// name cannot be read, more than the cap of entries need their shell name, or the deadline passed.
[[nodiscard]] inline ShadowReadResult ShellItemPathByName(HWND tab, HWND top,
                                                          std::wstring_view display_name,
                                                          const ShellLookupLimits &limits,
                                                          ShellItemAnswer *answer) {
  ComRef<IShellWindows> windows;
  if (FAILED(CoCreateInstance(CLSID_ShellWindows, nullptr, CLSCTX_LOCAL_SERVER,
                              IID_PPV_ARGS(windows.Receive()))) ||
      windows.Get() == nullptr)
    return ShadowReadResult::kFailed;
  long count = 0;
  if (FAILED(windows.Get()->get_Count(&count))) return ShadowReadResult::kFailed;
  // The view of the tab that holds the item; failing that, the only view of the window.
  ComRef<IShellView> view;
  int top_matches = 0;
  ComRef<IShellView> top_view;
  for (long index = 0; index < count && index < kShellLookupMaxWindows; ++index) {
    if (!limits.still_valid()) return ShadowReadResult::kStopped;
    VARIANT position;
    VariantInit(&position);
    position.vt = VT_I4;
    position.lVal = index;
    ComRef<IDispatch> dispatch;
    if (FAILED(windows.Get()->Item(position, dispatch.Receive())) || dispatch.Get() == nullptr)
      continue;
    ComRef<IWebBrowserApp> application;
    if (FAILED(dispatch.Get()->QueryInterface(IID_PPV_ARGS(application.Receive()))) ||
        application.Get() == nullptr)
      continue;
    SHANDLE_PTR handle = 0;
    if (FAILED(application.Get()->get_HWND(&handle))) continue;
    const HWND candidate = reinterpret_cast<HWND>(static_cast<LONG_PTR>(handle));
    const bool exact = tab != nullptr && candidate == tab;
    const bool whole_window = candidate == top;
    if (!exact && !whole_window) continue;
    ComRef<IServiceProvider> services;
    ComRef<IShellBrowser> browser;
    ComRef<IShellView> candidate_view;
    if (FAILED(application.Get()->QueryInterface(IID_PPV_ARGS(services.Receive()))) ||
        services.Get() == nullptr ||
        FAILED(services.Get()->QueryService(SID_STopLevelBrowser, IID_PPV_ARGS(browser.Receive()))) ||
        browser.Get() == nullptr ||
        FAILED(browser.Get()->QueryActiveShellView(candidate_view.Receive())) ||
        candidate_view.Get() == nullptr)
      continue;
    if (exact) {
      view = std::move(candidate_view);
      break;
    }
    ++top_matches;
    top_view = std::move(candidate_view);
  }
  if (view.Get() == nullptr && top_matches == 1) view = std::move(top_view);
  if (view.Get() == nullptr) return ShadowReadResult::kAbsent;

  ComRef<IFolderView2> folder_view;
  ComRef<IShellFolder> folder;
  if (FAILED(view.Get()->QueryInterface(IID_PPV_ARGS(folder_view.Receive()))) ||
      folder_view.Get() == nullptr ||
      FAILED(folder_view.Get()->GetFolder(IID_PPV_ARGS(folder.Receive()))) || folder.Get() == nullptr)
    return ShadowReadResult::kAbsent;
  // The folder's id list. The root of the desktop namespace has an EMPTY one (its path would be the
  // user's desktop, while the view also merges the public desktop): not looked into.
  AbsoluteIdList folder_id;
  if (FAILED(SHGetIDListFromObject(folder.Get(), &folder_id.id)) || folder_id.id == nullptr ||
      ILIsEmpty(folder_id.id))
    return ShadowReadResult::kAbsent;
  // A slow location is not touched (its folder says so before any I/O of ours).
  ComRef<IShellItem> folder_item;
  SFGAOF folder_attributes = 0;
  if (FAILED(SHCreateItemFromIDList(folder_id.id, IID_PPV_ARGS(folder_item.Receive()))) ||
      folder_item.Get() == nullptr ||
      FAILED(folder_item.Get()->GetAttributes(SFGAO_ISSLOW, &folder_attributes)) ||
      (folder_attributes & SFGAO_ISSLOW) != 0)
    return ShadowReadResult::kAbsent;
  // The folder's path, once. A folder that is no directory of the file system has none.
  std::wstring folder_path(32768, L'\0');
  const BOOL has_path = SHGetPathFromIDListEx(folder_id.id, folder_path.data(),
                                              static_cast<DWORD>(folder_path.size()), GPFIDL_DEFAULT);
  if (!has_path) return ShadowReadResult::kAbsent;
  folder_path.resize(wcslen(folder_path.c_str()));
  if (folder_path.empty() || !ShellDisplayNameUsable(display_name)) return ShadowReadResult::kAbsent;
  // Only a plain local directory: decided before the first listing, and never after the caller gave
  // up or the deadline passed (a call started after the cancel could not be canceled).
  ShadowReadResult stopped = ShadowReadResult::kAbsent;
  if (ShellLookupMustStop(limits, &stopped)) return stopped;
  stopped = ShadowReadResult::kAbsent;
  if (!ShellFolderMayBeListed(folder_path, limits, &stopped)) return stopped;
  std::wstring directory = ShellPathWithoutTrailingSeparator(folder_path);
  directory.push_back(L'\\');
  // The folder itself: every entry (a name that is only the display name's prefix does not decide).
  std::wstring pattern = directory;
  pattern.push_back(L'*');
  // A path past MAX_PATH would need the extended prefix: it is not looked up.
  if (directory.size() >= MAX_PATH - 14) return ShadowReadResult::kAbsent;
  // A desktop.ini that renames files: an entry outside the candidates could carry the display name.
  if (ShellLookupMustStop(limits, &stopped)) return stopped;
  stopped = ShadowReadResult::kAbsent;
  if (ShellFolderHasLocalizedFileNames(folder_path, limits, &stopped)) return stopped;

  std::vector<ShellNameCandidate> candidates;
  FindHandle find;
  WIN32_FIND_DATAW entry{};
  if (ShellLookupMustStop(limits, &stopped)) return stopped;
  find.handle = FindFirstFileExW(pattern.c_str(), FindExInfoBasic, &entry, FindExSearchNameMatch,
                                 nullptr, FIND_FIRST_EX_LARGE_FETCH);
  if (find.handle == INVALID_HANDLE_VALUE) {
    const DWORD error = GetLastError();
    return error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND ? ShadowReadResult::kAbsent
                                                                         : ShadowReadResult::kFailed;
  }
  for (;;) {
    if (ShellLookupMustStop(limits, &stopped)) return stopped;
    const std::wstring_view found(entry.cFileName);
    const bool is_directory = (entry.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
    // An entry needs its shell name only when it can carry the display name (the pure rule in the
    // matcher header: a file name that starts with it, or a read-only / system directory, which a
    // desktop.ini can rename). Hidden entries are not left out (a doubt keeps an entry, which can only
    // make the answer "not known").
    if (ShellEntryNeedsShellName(found, is_directory,
                                 (entry.dwFileAttributes &
                                  (FILE_ATTRIBUTE_READONLY | FILE_ATTRIBUTE_SYSTEM)) != 0,
                                 display_name, ShellNameEqualsOrdinal)) {
      // One past the cap is enough to know there are too many.
      if (candidates.size() >= kShellMaxCandidates) return ShadowReadResult::kAbsent;
      ShellNameCandidate candidate;
      candidate.name = std::wstring(found);
      candidate.is_directory = is_directory;
      // A link is never followed to get a name (its target can be on the network): it stays unknown.
      candidate.is_link = ShellReparseIsLink((entry.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0,
                                             entry.dwReserved0);
      candidates.push_back(std::move(candidate));
    }
    if (!FindNextFileW(find.handle, &entry)) {
      if (GetLastError() == ERROR_NO_MORE_FILES) break;
      return ShadowReadResult::kFailed;
    }
  }
  // The name the shell shows for each candidate. One that cannot be read, or whose path resolved to
  // another entry (Win32 drops a trailing dot or space), is left unknown, which makes the whole
  // answer "not known" (it might be the one, or a second one).
  for (ShellNameCandidate &candidate : candidates) {
    if (ShellLookupMustStop(limits, &stopped)) return stopped;
    if (candidate.is_link) continue;
    ComRef<IShellItem> item;
    PWSTR shown = nullptr;
    PWSTR resolved = nullptr;
    if (SUCCEEDED(SHCreateItemFromParsingName((directory + candidate.name).c_str(), nullptr,
                                              IID_PPV_ARGS(item.Receive()))) &&
        item.Get() != nullptr &&
        SUCCEEDED(item.Get()->GetDisplayName(SIGDN_FILESYSPATH, &resolved)) &&
        resolved != nullptr &&
        ShellResolvedNameIsTheCandidate(candidate.name, ShellLeafName(resolved), ShellNameEqualsOrdinal) &&
        SUCCEEDED(item.Get()->GetDisplayName(SIGDN_NORMALDISPLAY, &shown)) && shown != nullptr) {
      candidate.shell_name = shown;
      candidate.shell_name_known = true;
    }
    if (shown != nullptr) CoTaskMemFree(shown);
    if (resolved != nullptr) CoTaskMemFree(resolved);
  }
  const std::size_t index = MatchShellDisplayName(display_name, candidates, ShellNameEqualsOrdinal);
  if (index == kNoShellMatch) return ShadowReadResult::kAbsent;
  answer->path = directory + candidates[index].name;
  // A directory of the file system is a folder; an archive is a file.
  answer->is_folder = candidates[index].is_directory;
  return ShadowReadResult::kOk;
}

// The shell lookup talks to Explorer, whose calls have no timeout: an Explorer window that does not
// answer would hold the caller for good. So the lookup runs on a thread of its own and the caller
// waits for it a bounded time; a lookup that has not come back is abandoned (kAbsent), and until it
// does no second one is started, so at most one thread can ever be stuck.
struct ShellLookupPending {
  std::mutex mutex;
  std::condition_variable ready;
  bool done = false;
  // Set by the caller when it stops waiting: the lookup stops at its next step.
  std::atomic<bool> abandoned{false};
  // A handle of the lookup's thread (under `mutex`), so a caller that gives up can cancel the file
  // system call the thread is blocked in.
  HANDLE thread = nullptr;
  ShellLookupPending() = default;
  ShellLookupPending(const ShellLookupPending &) = delete;
  ShellLookupPending &operator=(const ShellLookupPending &) = delete;
  ~ShellLookupPending() {
    if (thread != nullptr) CloseHandle(thread);
  }
  ShadowReadResult result = ShadowReadResult::kAbsent;
  ShellItemAnswer answer;
};
constexpr std::chrono::milliseconds kShellLookupWait{150};

// Never destroyed: an abandoned lookup may finish after the process has started to exit.
// One slot per caller: the shadow's own, and the synchronous interlock entry's. A lookup that never
// comes back holds only its own slot, so the two callers cannot starve each other and at most two
// threads can ever be stuck (one per slot).
[[nodiscard]] inline std::atomic<bool> &ShellLookupRunning() {
  static std::atomic<bool> *const running = new std::atomic<bool>(false);
  return *running;
}
[[nodiscard]] inline std::atomic<bool> &InterlockShellLookupRunning() {
  static std::atomic<bool> *const running = new std::atomic<bool>(false);
  return *running;
}

} // namespace windows_uia_source_detail

class WindowsUiaShadowSource final : public ShadowUiaSource {
public:
  // How a capture is told it is still wanted: false once the action was canceled or its target
  // stopped being the one v1 validated.
  using StillValid = std::function<bool()>;

  // The bound of one UI Automation call (connection and transaction). The shadow is asynchronous and
  // may wait longer; the synchronous interlock entry holds the serial lane, so its bound is short
  // (see the lane's worst-case estimate in the host).
  static constexpr DWORD kShadowUiaTimeoutMs = 1500;
  static constexpr DWORD kInterlockUiaTimeoutMs = 250;

  // The thread must have COM initialized. Null when UI Automation cannot be created at all.
  // `timeout_ms` bounds each UI Automation call; `lookup_slot` is the single-flight slot of the
  // shell lookup this source may start (the shadow's and the synchronous entry's are different).
  [[nodiscard]] static std::unique_ptr<WindowsUiaShadowSource> Create(HWND window, POINT point,
                                                                    StillValid still_valid,
                                                                    DWORD timeout_ms,
                                                                    std::atomic<bool> &lookup_slot) {
    using windows_uia_source_detail::ComRef;
    // CUIAutomation8 (Windows 8 and later) is the only coclass that implements IUIAutomation2, whose
    // ConnectionTimeout / TransactionTimeout bound a call to an app that does not answer. The
    // original CUIAutomation does not, and a call to a hung app then never returns (measured), which
    // would hold the shadow's thread and its one slot for the life of the helper. So the timeouts are
    // a precondition: without them there is no source, and the capture is recorded as skipped.
    ComRef<IUIAutomation> automation;
    if (FAILED(CoCreateInstance(CLSID_CUIAutomation8, nullptr, CLSCTX_INPROC_SERVER,
                                IID_PPV_ARGS(automation.Receive()))) ||
        automation.Get() == nullptr)
      return nullptr;
    ComRef<IUIAutomation2> bounded;
    if (FAILED(automation.Get()->QueryInterface(IID_PPV_ARGS(bounded.Receive()))) ||
        bounded.Get() == nullptr ||
        FAILED(bounded.Get()->put_ConnectionTimeout(timeout_ms)) ||
        FAILED(bounded.Get()->put_TransactionTimeout(timeout_ms)))
      return nullptr;
    ComRef<IUIAutomationTreeWalker> walker;
    if (FAILED(automation.Get()->get_RawViewWalker(walker.Receive())) || walker.Get() == nullptr)
      return nullptr;
    return std::unique_ptr<WindowsUiaShadowSource>(new WindowsUiaShadowSource(
        std::move(automation), std::move(walker), window, point, std::move(still_valid),
        lookup_slot));
  }

  ~WindowsUiaShadowSource() override {
    for (IUIAutomationElement *element : elements_) element->Release();
  }
  WindowsUiaShadowSource(const WindowsUiaShadowSource &) = delete;
  WindowsUiaShadowSource &operator=(const WindowsUiaShadowSource &) = delete;

  bool ActionStillValid() override { return still_valid_ == nullptr || still_valid_(); }
  std::uint64_t NowNs() override {
    return static_cast<std::uint64_t>(
        std::chrono::duration_cast<std::chrono::nanoseconds>(
            std::chrono::steady_clock::now().time_since_epoch())
            .count());
  }

  ShadowReadResult Root(Element *output) override {
    windows_uia_source_detail::ComRef<IUIAutomationElement> element;
    const HRESULT result = automation_.Get()->ElementFromHandle(window_, element.Receive());
    return Keep(result, std::move(element), output);
  }
  ShadowReadResult AtPoint(Element *output) override {
    windows_uia_source_detail::ComRef<IUIAutomationElement> element;
    const HRESULT result = automation_.Get()->ElementFromPoint(point_, element.Receive());
    return Keep(result, std::move(element), output);
  }
  ShadowReadResult Focused(Element *output) override {
    windows_uia_source_detail::ComRef<IUIAutomationElement> element;
    const HRESULT result = automation_.Get()->GetFocusedElement(element.Receive());
    return Keep(result, std::move(element), output);
  }
  ShadowReadResult Parent(Element element, Element *output) override {
    IUIAutomationElement *current = At(element);
    if (current == nullptr) return ShadowReadResult::kFailed;
    windows_uia_source_detail::ComRef<IUIAutomationElement> parent;
    const HRESULT result = walker_.Get()->GetParentElement(current, parent.Receive());
    return Keep(result, std::move(parent), output);
  }
  ShadowReadResult FirstChild(Element element, Element *output) override {
    IUIAutomationElement *current = At(element);
    if (current == nullptr) return ShadowReadResult::kFailed;
    windows_uia_source_detail::ComRef<IUIAutomationElement> child;
    const HRESULT result = walker_.Get()->GetFirstChildElement(current, child.Receive());
    return Keep(result, std::move(child), output);
  }
  ShadowReadResult NextSibling(Element element, Element *output) override {
    IUIAutomationElement *current = At(element);
    if (current == nullptr) return ShadowReadResult::kFailed;
    windows_uia_source_detail::ComRef<IUIAutomationElement> sibling;
    const HRESULT result = walker_.Get()->GetNextSiblingElement(current, sibling.Receive());
    return Keep(result, std::move(sibling), output);
  }
  ShadowReadResult Same(Element first, Element second, bool *same) override {
    IUIAutomationElement *left = At(first);
    IUIAutomationElement *right = At(second);
    if (left == nullptr || right == nullptr) return ShadowReadResult::kFailed;
    BOOL equal = FALSE;
    if (FAILED(automation_.Get()->CompareElements(left, right, &equal)))
      return ShadowReadResult::kFailed;
    *same = equal != FALSE;
    return ShadowReadResult::kOk;
  }

  ShadowReadResult Text(Element element, ShadowUiaText what, bool normalize,
                        std::size_t maximum_bytes, std::string *output) override {
    IUIAutomationElement *current = At(element);
    if (current == nullptr) return ShadowReadResult::kFailed;
    if (what == ShadowUiaText::kControlType) {
      CONTROLTYPEID id = 0;
      if (FAILED(current->get_CurrentControlType(&id))) return ShadowReadResult::kFailed;
      return windows_uia_source_detail::ShadowTextFromUtf16(
          windows_uia_source_detail::Widen(windows_uia_source_detail::ControlTypeName(id)),
          false, maximum_bytes, output);
    }
    windows_uia_source_detail::BstrHolder text;
    HRESULT result = E_FAIL;
    switch (what) {
    case ShadowUiaText::kClassName: result = current->get_CurrentClassName(text.Receive()); break;
    case ShadowUiaText::kName: result = current->get_CurrentName(text.Receive()); break;
    case ShadowUiaText::kAutomationId:
      result = current->get_CurrentAutomationId(text.Receive());
      break;
    case ShadowUiaText::kHelpText: result = current->get_CurrentHelpText(text.Receive()); break;
    case ShadowUiaText::kControlType: break;
    }
    if (FAILED(result)) return ShadowReadResult::kFailed;
    return windows_uia_source_detail::ShadowTextFromUtf16(text.View(), normalize, maximum_bytes,
                                                          output);
  }

  ShadowReadResult IsPassword(Element element, bool *is_password) override {
    IUIAutomationElement *current = At(element);
    if (current == nullptr) return ShadowReadResult::kFailed;
    BOOL password = FALSE;
    if (FAILED(current->get_CurrentIsPassword(&password))) return ShadowReadResult::kFailed;
    *is_password = password != FALSE;
    return ShadowReadResult::kOk;
  }

  // The value of a Document is the address of the page in the browsers that publish it. Reading a
  // value is a read; nothing is set.
  ShadowReadResult DocumentUrl(Element document, std::size_t maximum_bytes,
                               std::string *output) override {
    IUIAutomationElement *current = At(document);
    if (current == nullptr) return ShadowReadResult::kFailed;
    windows_uia_source_detail::ComRef<IUIAutomationValuePattern> pattern;
    const HRESULT got = current->GetCurrentPatternAs(
        UIA_ValuePatternId, IID_PPV_ARGS(pattern.Receive()));
    if (FAILED(got)) return ShadowReadResult::kFailed;
    if (pattern.Get() == nullptr) return ShadowReadResult::kAbsent;
    windows_uia_source_detail::BstrHolder value;
    if (FAILED(pattern.Get()->get_CurrentValue(value.Receive()))) return ShadowReadResult::kFailed;
    return windows_uia_source_detail::ShadowTextFromUtf16(value.View(), false, maximum_bytes, output);
  }

  ShadowReadResult WindowProcessPath(Element window, std::size_t maximum_bytes,
                                     std::string *output) override {
    IUIAutomationElement *current = At(window);
    if (current == nullptr) return ShadowReadResult::kFailed;
    return ProcessPathOf(current, maximum_bytes, output);
  }

  ShadowReadResult CoreWindowProcessPath(Element window, std::size_t maximum_bytes,
                                         std::string *output) override {
    IUIAutomationElement *current = At(window);
    if (current == nullptr) return ShadowReadResult::kFailed;
    VARIANT class_name;
    VariantInit(&class_name);
    class_name.vt = VT_BSTR;
    class_name.bstrVal = SysAllocString(L"Windows.UI.Core.CoreWindow");
    if (class_name.bstrVal == nullptr) return ShadowReadResult::kFailed;
    windows_uia_source_detail::ComRef<IUIAutomationCondition> condition;
    const HRESULT made = automation_.Get()->CreatePropertyCondition(UIA_ClassNamePropertyId,
                                                                    class_name, condition.Receive());
    VariantClear(&class_name);
    if (FAILED(made) || condition.Get() == nullptr) return ShadowReadResult::kFailed;
    windows_uia_source_detail::ComRef<IUIAutomationElement> core;
    if (FAILED(current->FindFirst(TreeScope_Descendants, condition.Get(), core.Receive())))
      return ShadowReadResult::kFailed;
    if (core.Get() == nullptr) return ShadowReadResult::kAbsent;
    return ProcessPathOf(core.Get(), maximum_bytes, output);
  }

  // The REAL path of the file-browser item (UI Automation publishes only its display name, and
  // Explorer hides known extensions): the item is looked up by that display name in the shell view of
  // its tab. See ShellItemPathByName for when this is "not known".
  ShadowReadResult ItemPath(Element element, Element tab_element, std::size_t maximum_bytes,
                            std::string *path, bool *is_folder) override {
    IUIAutomationElement *item = At(element);
    if (item == nullptr) return ShadowReadResult::kFailed;
    windows_uia_source_detail::BstrHolder name;
    if (FAILED(item->get_CurrentName(name.Receive()))) return ShadowReadResult::kFailed;
    if (name.View().empty()) return ShadowReadResult::kAbsent;
    // The shell tab is an element the reader already walked to (and paid for); only its window
    // handle is read here.
    HWND tab = nullptr;
    if (tab_element != kNoElement) {
      IUIAutomationElement *tab_node = At(tab_element);
      if (tab_node == nullptr) return ShadowReadResult::kFailed;
      UIA_HWND native = nullptr;
      if (FAILED(tab_node->get_CurrentNativeWindowHandle(&native))) return ShadowReadResult::kFailed;
      tab = reinterpret_cast<HWND>(native);
    }
    // Only a tab of the bound window: an item of any other Explorer window is not read.
    if (tab != nullptr && GetAncestor(tab, GA_ROOT) != window_) return ShadowReadResult::kAbsent;
    // The lookup runs on its own thread (see ShellLookupPending); nothing of this object is used there.
    std::atomic<bool> &running = lookup_slot_;
    if (running.exchange(true)) return ShadowReadResult::kAbsent;
    auto pending = std::make_shared<windows_uia_source_detail::ShellLookupPending>();
    const HWND top = window_;
    const StillValid valid = still_valid_;
    const std::wstring display_name(name.View());
    try {
      std::thread([pending, tab, top, display_name, valid, &running]() {
        ShadowReadResult result = ShadowReadResult::kFailed;
        windows_uia_source_detail::ShellItemAnswer answer;
        try {
          // Released after the lookup, also when something throws.
          struct ComApartment {
            HRESULT initialized = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
            ~ComApartment() {
              if (SUCCEEDED(initialized)) CoUninitialize();
            }
          } apartment;
          const auto now = [] {
            return static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(
                                                  std::chrono::steady_clock::now().time_since_epoch())
                                                  .count());
          };
          windows_uia_source_detail::ShellLookupLimits limits;
          // The caller giving up ends the lookup at its next step, like the action being canceled.
          limits.still_valid = [valid, pending] {
            return !pending->abandoned.load(std::memory_order_acquire) &&
                   (valid == nullptr || valid());
          };
          {
            HANDLE self = nullptr;
            if (DuplicateHandle(GetCurrentProcess(), GetCurrentThread(), GetCurrentProcess(), &self, 0,
                                FALSE, DUPLICATE_SAME_ACCESS)) {
              std::lock_guard<std::mutex> lock(pending->mutex);
              pending->thread = self;
            }
          }
          limits.now_ns = now;
          limits.deadline_ns = now() + windows_uia_source_detail::kShellLookupBudgetNs;
          result = windows_uia_source_detail::ShellItemPathByName(tab, top, display_name, limits,
                                                                  &answer);
        } catch (...) {
          // An exception out of a thread would end the process: the lookup just failed.
          result = ShadowReadResult::kFailed;
          answer = windows_uia_source_detail::ShellItemAnswer{};
        }
        // The slot is released and the waiting caller told, whatever happened above.
        struct Finish {
          std::atomic<bool> &running;
          std::shared_ptr<windows_uia_source_detail::ShellLookupPending> pending;
          ~Finish() {
            running.store(false);
            pending->ready.notify_one();
          }
        } finish{running, pending};
        std::lock_guard<std::mutex> lock(pending->mutex);
        pending->result = result;
        pending->answer = std::move(answer);
        pending->done = true;
      }).detach();
    } catch (...) {
      running.store(false);
      return ShadowReadResult::kFailed;
    }
    windows_uia_source_detail::ShellItemAnswer answer;
    {
      std::unique_lock<std::mutex> lock(pending->mutex);
      if (!pending->ready.wait_for(lock, windows_uia_source_detail::kShellLookupWait,
                                   [&pending] { return pending->done; })) {
        // Given up: the lookup stops at its next step, and a file system call it is blocked in (a
        // disk that does not answer) is canceled, so the single-flight slot is not held for good. A
        // call that cannot be canceled (a driver that never returns) is a known limit.
        pending->abandoned.store(true, std::memory_order_release);
        if (pending->thread != nullptr) CancelSynchronousIo(pending->thread);
        return ShadowReadResult::kAbsent;
      }
      if (pending->result != ShadowReadResult::kOk) return pending->result;
      answer = std::move(pending->answer);
    }
    const ShadowReadResult text =
        windows_uia_source_detail::ShadowTextFromUtf16(answer.path, false, maximum_bytes, path);
    if (text == ShadowReadResult::kOk) *is_folder = answer.is_folder;
    return text;
  }

private:
  static constexpr int kMaxElements = 1024;

  WindowsUiaShadowSource(windows_uia_source_detail::ComRef<IUIAutomation> automation,
                         windows_uia_source_detail::ComRef<IUIAutomationTreeWalker> walker,
                         HWND window, POINT point, StillValid still_valid,
                         std::atomic<bool> &lookup_slot)
      : automation_(std::move(automation)), walker_(std::move(walker)), window_(window),
        point_(point), still_valid_(std::move(still_valid)), lookup_slot_(lookup_slot) {}

  [[nodiscard]] IUIAutomationElement *At(Element element) const {
    return element < elements_.size() ? elements_[element] : nullptr;
  }

  // A navigation / lookup result: an error is a failed read, S_OK with no element is "none", and an
  // element is kept (the table is bounded: a capture makes at most the call budget of lookups).
  ShadowReadResult Keep(HRESULT result,
                        windows_uia_source_detail::ComRef<IUIAutomationElement> element,
                        Element *output) {
    if (FAILED(result)) return ShadowReadResult::kFailed;
    if (element.Get() == nullptr) return ShadowReadResult::kAbsent;
    if (elements_.size() >= static_cast<std::size_t>(kMaxElements)) return ShadowReadResult::kFailed;
    IUIAutomationElement *raw = element.Get();
    raw->AddRef();
    elements_.push_back(raw);
    *output = static_cast<Element>(elements_.size() - 1);
    return ShadowReadResult::kOk;
  }

  // The executable of the process that owns an element. Opened with the least right that answers.
  ShadowReadResult ProcessPathOf(IUIAutomationElement *element, std::size_t maximum_bytes,
                                 std::string *output) {
    int process_id = 0;
    if (FAILED(element->get_CurrentProcessId(&process_id)) || process_id <= 0)
      return ShadowReadResult::kFailed;
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE,
                                 static_cast<DWORD>(process_id));
    if (process == nullptr) return ShadowReadResult::kFailed;
    std::wstring path(32768, L'\0');
    DWORD size = static_cast<DWORD>(path.size());
    const BOOL queried = QueryFullProcessImageNameW(process, 0, path.data(), &size);
    CloseHandle(process);
    if (!queried || size == 0) return ShadowReadResult::kFailed;
    path.resize(size);
    return windows_uia_source_detail::ShadowTextFromUtf16(path, false, maximum_bytes, output);
  }

  windows_uia_source_detail::ComRef<IUIAutomation> automation_;
  windows_uia_source_detail::ComRef<IUIAutomationTreeWalker> walker_;
  HWND window_;
  POINT point_;
  StillValid still_valid_;
  std::atomic<bool> &lookup_slot_;
  std::vector<IUIAutomationElement *> elements_;
};

} // namespace sprint_coder::computer_use
