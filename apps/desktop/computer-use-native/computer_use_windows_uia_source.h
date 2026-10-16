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

// The path of the item a file browser shows under `display_name`. The folder the view shows is asked
// for its file-system path ONCE; the entries of that folder whose names START WITH the display name
// are then listed in THIS process (FindFirstFileExW: a cost that follows the number of candidates, not
// the size of the folder), and MatchShellDisplayName decides which entry the display name stands for
// (a hidden extension, a shortcut, an 8.3 name). Read-only: windows and views are asked for, never
// navigated, selected or invoked, and nothing is opened. kAbsent when there is no such view, the
// folder has no file-system path (a search, This PC, a library), no entry or more than one entry fits
// the name, there are more candidates than the cap, or the deadline passed.
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
  // The folder's path, once. A folder that is no directory of the file system has none.
  PIDLIST_ABSOLUTE folder_id = nullptr;
  if (FAILED(SHGetIDListFromObject(folder.Get(), &folder_id)) || folder_id == nullptr)
    return ShadowReadResult::kAbsent;
  std::wstring folder_path(32768, L'\0');
  const BOOL has_path = SHGetPathFromIDListEx(folder_id, folder_path.data(),
                                              static_cast<DWORD>(folder_path.size()), GPFIDL_DEFAULT);
  ILFree(folder_id);
  if (!has_path) return ShadowReadResult::kAbsent;
  folder_path.resize(wcslen(folder_path.c_str()));
  if (folder_path.empty() || !ShellDisplayNameUsable(display_name)) return ShadowReadResult::kAbsent;
  std::wstring pattern = folder_path;
  if (pattern.back() != L'\\') pattern.push_back(L'\\');
  pattern.append(display_name);
  pattern.push_back(L'*');
  // A path past MAX_PATH would need the extended prefix: it is not looked up.
  if (pattern.size() >= MAX_PATH) return ShadowReadResult::kAbsent;

  // Whether Explorer shows known extensions decides which entries a display name can stand for.
  SHELLSTATE state{};
  SHGetSetSettings(&state, SSF_SHOWEXTENSIONS, FALSE);
  const bool extensions_shown = state.fShowExtensions != 0;

  std::vector<ShellNameCandidate> candidates;
  FindHandle find;
  WIN32_FIND_DATAW entry{};
  find.handle = FindFirstFileExW(pattern.c_str(), FindExInfoBasic, &entry, FindExSearchNameMatch,
                                 nullptr, FIND_FIRST_EX_LARGE_FETCH);
  if (find.handle == INVALID_HANDLE_VALUE) {
    const DWORD error = GetLastError();
    return error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND ? ShadowReadResult::kAbsent
                                                                         : ShadowReadResult::kFailed;
  }
  for (;;) {
    if (!limits.still_valid()) return ShadowReadResult::kStopped;
    if (limits.now_ns() > limits.deadline_ns) return ShadowReadResult::kAbsent;
    const std::wstring_view found(entry.cFileName);
    if (found != L"." && found != L"..") {
      // One past the cap is enough to know there are too many.
      if (candidates.size() >= kShellMaxCandidates) return ShadowReadResult::kAbsent;
      candidates.push_back(
          {std::wstring(found), (entry.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0});
    }
    if (!FindNextFileW(find.handle, &entry)) {
      if (GetLastError() == ERROR_NO_MORE_FILES) break;
      return ShadowReadResult::kFailed;
    }
  }
  const std::size_t index =
      MatchShellDisplayName(display_name, candidates, extensions_shown, ShellNameEqualsOrdinal);
  if (index == kNoShellMatch) return ShadowReadResult::kAbsent;
  answer->path = folder_path;
  if (answer->path.back() != L'\\') answer->path.push_back(L'\\');
  answer->path.append(candidates[index].name);
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
        const HRESULT initialized = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
        const auto now = [] {
          return static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(
                                                std::chrono::steady_clock::now().time_since_epoch())
                                                .count());
        };
        windows_uia_source_detail::ShellLookupLimits limits;
        limits.still_valid = [valid] { return valid == nullptr || valid(); };
        limits.now_ns = now;
        limits.deadline_ns = now() + windows_uia_source_detail::kShellLookupBudgetNs;
        windows_uia_source_detail::ShellItemAnswer answer;
        const ShadowReadResult result = windows_uia_source_detail::ShellItemPathByName(
            tab, top, display_name, limits, &answer);
        if (SUCCEEDED(initialized)) CoUninitialize();
        {
          std::lock_guard<std::mutex> lock(pending->mutex);
          pending->result = result;
          pending->answer = std::move(answer);
          pending->done = true;
        }
        running.store(false);
        pending->ready.notify_one();
      }).detach();
    } catch (...) {
      running.store(false);
      return ShadowReadResult::kFailed;
    }
    windows_uia_source_detail::ShellItemAnswer answer;
    {
      std::unique_lock<std::mutex> lock(pending->mutex);
      if (!pending->ready.wait_for(lock, windows_uia_source_detail::kShellLookupWait,
                                   [&pending] { return pending->done; }))
        return ShadowReadResult::kAbsent;
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
