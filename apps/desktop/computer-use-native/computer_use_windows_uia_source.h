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

// How long, and for how many items, the shell lookup may go on. It is ONE gated call of the reader,
// so it keeps its own limits: the action still being valid, a deadline, and a cap on the items it
// goes through. A folder bigger than the cap, or a lookup past the deadline, is "not known".
struct ShellLookupLimits {
  std::function<bool()> still_valid;
  std::function<std::uint64_t()> now_ns;
  std::uint64_t deadline_ns = 0;
};
constexpr int kShellLookupMaxItems = 512;
constexpr int kShellLookupMaxWindows = 64;
constexpr std::uint64_t kShellLookupBudgetNs = 60'000'000;

// The path of the item a file browser shows under `display_name`, found in the shell view of the
// tab (or of the window) by its display name. Read-only: windows and views are asked for, never
// navigated, selected or invoked. kAbsent when there is no such view, the name is not unique in the
// view (a hidden extension can make two items look alike), the item has no file-system path
// (a search, This PC, a library), the folder is too big to look through, or the deadline passed.
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
  int items = 0;
  if (FAILED(folder_view.Get()->ItemCount(SVGIO_ALLVIEW, &items))) return ShadowReadResult::kFailed;
  if (items <= 0 || items > kShellLookupMaxItems) return ShadowReadResult::kAbsent;

  ComRef<IShellItem> matched;
  for (int index = 0; index < items; ++index) {
    if (!limits.still_valid()) return ShadowReadResult::kStopped;
    if (limits.now_ns() > limits.deadline_ns) return ShadowReadResult::kAbsent;
    PITEMID_CHILD child = nullptr;
    // An item that cannot be read leaves the uniqueness of the name unknown: the whole lookup is
    // not obtained (a readable file beside an unreadable .lnk of the same display name would
    // otherwise be taken for the target).
    if (FAILED(folder_view.Get()->Item(index, &child)) || child == nullptr)
      return ShadowReadResult::kFailed;
    ComRef<IShellItem> item;
    const HRESULT made =
        SHCreateItemWithParent(nullptr, folder.Get(), child, IID_PPV_ARGS(item.Receive()));
    ILFree(child);
    if (FAILED(made) || item.Get() == nullptr) return ShadowReadResult::kFailed;
    PWSTR shown = nullptr;
    if (FAILED(item.Get()->GetDisplayName(SIGDN_NORMALDISPLAY, &shown)) || shown == nullptr)
      return ShadowReadResult::kFailed;
    const bool same = std::wstring_view(shown) == display_name;
    CoTaskMemFree(shown);
    if (!same) continue;
    // Two items with the same display name (a hidden extension): which one was meant is not known.
    if (matched.Get() != nullptr) return ShadowReadResult::kAbsent;
    matched = std::move(item);
  }
  if (matched.Get() == nullptr) return ShadowReadResult::kAbsent;
  PWSTR file_path = nullptr;
  if (FAILED(matched.Get()->GetDisplayName(SIGDN_FILESYSPATH, &file_path)) || file_path == nullptr)
    return ShadowReadResult::kAbsent;
  answer->path = file_path;
  CoTaskMemFree(file_path);
  SFGAOF attributes = 0;
  if (FAILED(matched.Get()->GetAttributes(SFGAO_FOLDER | SFGAO_STREAM, &attributes)))
    return ShadowReadResult::kFailed;
  // An archive is both a folder and a stream: it is a file with an extension.
  answer->is_folder = (attributes & SFGAO_FOLDER) != 0 && (attributes & SFGAO_STREAM) == 0;
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
[[nodiscard]] inline std::atomic<bool> &ShellLookupRunning() {
  static std::atomic<bool> *const running = new std::atomic<bool>(false);
  return *running;
}

} // namespace windows_uia_source_detail

class WindowsUiaShadowSource final : public ShadowUiaSource {
public:
  // How a capture is told it is still wanted: false once the action was canceled or its target
  // stopped being the one v1 validated.
  using StillValid = std::function<bool()>;

  // The thread must have COM initialized. Null when UI Automation cannot be created at all.
  [[nodiscard]] static std::unique_ptr<WindowsUiaShadowSource> Create(HWND window, POINT point,
                                                                    StillValid still_valid) {
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
        FAILED(bounded.Get()->put_ConnectionTimeout(kTimeoutMilliseconds)) ||
        FAILED(bounded.Get()->put_TransactionTimeout(kTimeoutMilliseconds)))
      return nullptr;
    ComRef<IUIAutomationTreeWalker> walker;
    if (FAILED(automation.Get()->get_RawViewWalker(walker.Receive())) || walker.Get() == nullptr)
      return nullptr;
    return std::unique_ptr<WindowsUiaShadowSource>(new WindowsUiaShadowSource(
        std::move(automation), std::move(walker), window, point, std::move(still_valid)));
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
  ShadowReadResult ItemPath(Element element, std::size_t maximum_bytes, std::string *path,
                            bool *is_folder) override {
    IUIAutomationElement *item = At(element);
    if (item == nullptr) return ShadowReadResult::kFailed;
    windows_uia_source_detail::BstrHolder name;
    if (FAILED(item->get_CurrentName(name.Receive()))) return ShadowReadResult::kFailed;
    if (name.View().empty()) return ShadowReadResult::kAbsent;
    // The shell tab that shows the item is its nearest ShellTabWindowClass ancestor.
    HWND tab = nullptr;
    {
      item->AddRef();
      windows_uia_source_detail::ComRef<IUIAutomationElement> cursor(item);
      for (int hops = 0; hops < 16 && cursor.Get() != nullptr; ++hops) {
        windows_uia_source_detail::BstrHolder class_name;
        if (SUCCEEDED(cursor.Get()->get_CurrentClassName(class_name.Receive())) &&
            class_name.View() == L"ShellTabWindowClass") {
          UIA_HWND native = nullptr;
          if (SUCCEEDED(cursor.Get()->get_CurrentNativeWindowHandle(&native)))
            tab = reinterpret_cast<HWND>(native);
          break;
        }
        windows_uia_source_detail::ComRef<IUIAutomationElement> parent;
        if (FAILED(walker_.Get()->GetParentElement(cursor.Get(), parent.Receive()))) break;
        cursor = std::move(parent);
      }
    }
    // Only a tab of the bound window: an item of any other Explorer window is not read.
    if (tab != nullptr && GetAncestor(tab, GA_ROOT) != window_) return ShadowReadResult::kAbsent;
    // The lookup runs on its own thread (see ShellLookupPending); nothing of this object is used there.
    std::atomic<bool> &running = windows_uia_source_detail::ShellLookupRunning();
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
  static constexpr DWORD kTimeoutMilliseconds = 1500;

  WindowsUiaShadowSource(windows_uia_source_detail::ComRef<IUIAutomation> automation,
                         windows_uia_source_detail::ComRef<IUIAutomationTreeWalker> walker,
                         HWND window, POINT point, StillValid still_valid)
      : automation_(std::move(automation)), walker_(std::move(walker)), window_(window),
        point_(point), still_valid_(std::move(still_valid)) {}

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
  std::vector<IUIAutomationElement *> elements_;
};

} // namespace sprint_coder::computer_use
