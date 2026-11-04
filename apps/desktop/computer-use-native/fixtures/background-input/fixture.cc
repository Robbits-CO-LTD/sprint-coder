#include <windows.h>
#include <ole2.h>
#include <UIAutomation.h>
#include <atomic>
#include <algorithm>
#include <array>
#include <string>
#include <thread>
#include "evidence.h"

// Standalone synthetic provider: never linked into the product or its allow table.
constexpr UINT kCommand = WM_APP + 7;
constexpr int kPatterns[] = {UIA_InvokePatternId, UIA_ValuePatternId,
  UIA_SelectionItemPatternId, UIA_TogglePatternId, UIA_ExpandCollapsePatternId,
  UIA_ScrollPatternId};
constexpr const wchar_t* kNames[] = {L"Invoke", L"Value", L"SelectionItem",
  L"Toggle", L"ExpandCollapse", L"Scroll"};
HANDLE release_gate;
std::atomic<int> delay_phase{0}; // 1: preflight read, 2: method entry, 3: post-effect read
std::atomic<bool> patterns_enabled{true};
std::atomic<unsigned> generation{0};
std::atomic<bool> virtualized{false};
HWND main_window;

void Pause(int phase, int index) {
  int expected = phase;
  if (!delay_phase.compare_exchange_strong(expected, 0)) return;
  Evidence("blocked", Number("phase", phase) + Number("index", index));
  // stdin release runs independently even when UIA blocks the GUI thread.
  const DWORD result = WaitForSingleObject(release_gate, INFINITE);
  Evidence("released", Number("phase", phase) + Number("waitResult", result));
}

class Control final : public IRawElementProviderSimple,
                      public IRawElementProviderFragment,
                      public IRawElementProviderFragmentRoot,
                      public IInvokeProvider, public IValueProvider,
                      public ISelectionItemProvider, public IToggleProvider,
                      public IExpandCollapseProvider, public IScrollProvider {
  std::atomic<ULONG> refs_{1};
  std::atomic<unsigned> attempts_{0}, effects_{0}, reads_{0};
  std::atomic<int> state_{0};
  std::atomic<double> horizontal_{0}, vertical_{0};
  std::atomic<bool> post_read_{false};
  std::mutex value_mutex_;
  std::wstring value_ = L"synthetic";
 public:
  HWND hwnd = nullptr;
  const int index;
  explicit Control(int i) : index(i) {}
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** out) override {
    if (!out) return E_POINTER;
    *out = nullptr;
    if (iid == __uuidof(IUnknown) || iid == __uuidof(IRawElementProviderSimple))
      *out = static_cast<IRawElementProviderSimple*>(this);
    else if (iid == __uuidof(IRawElementProviderFragment))
      *out = static_cast<IRawElementProviderFragment*>(this);
    else if (iid == __uuidof(IRawElementProviderFragmentRoot))
      *out = static_cast<IRawElementProviderFragmentRoot*>(this);
    else if (iid == __uuidof(IInvokeProvider)) *out = static_cast<IInvokeProvider*>(this);
    else if (iid == __uuidof(IValueProvider)) *out = static_cast<IValueProvider*>(this);
    else if (iid == __uuidof(ISelectionItemProvider)) *out = static_cast<ISelectionItemProvider*>(this);
    else if (iid == __uuidof(IToggleProvider)) *out = static_cast<IToggleProvider*>(this);
    else if (iid == __uuidof(IExpandCollapseProvider)) *out = static_cast<IExpandCollapseProvider*>(this);
    else if (iid == __uuidof(IScrollProvider)) *out = static_cast<IScrollProvider*>(this);
    if (!*out) return E_NOINTERFACE;
    AddRef();
    return S_OK;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return ++refs_; }
  ULONG STDMETHODCALLTYPE Release() override {
    ULONG count = --refs_;
    if (!count) delete this;
    return count;
  }
  void Snapshot() {
    Evidence("control", Number("index", index) + Number("hwnd", WindowId(hwnd)) +
      Number("pattern", kPatterns[index]) + Number("attempts", attempts_) +
      Number("effects", effects_) + Number("reads", reads_) +
      Number("generation", generation) + Number("virtualized", virtualized) +
      Number("state", state_) + ",\"horizontalPercent\":" + std::to_string(horizontal_.load()) +
      ",\"verticalPercent\":" + std::to_string(vertical_.load()));
  }
  void Read() {
    ++reads_;
    if (post_read_.exchange(false)) Pause(3, index);
    Pause(1, index);
  }
  HRESULT Apply(int state, const wchar_t* method, LPCWSTR value = nullptr,
                double horizontal = -1, double vertical = -1) {
    ++attempts_;
    std::string operation; for (const wchar_t* p = method; *p; ++p) operation += static_cast<char>(*p);
    Evidence("attempt", Number("index", index) + Number("attempts", attempts_) +
      Number("generation", generation) + ",\"method\":\"" + operation + "\"");
    Pause(2, index);
    if (value) { std::lock_guard<std::mutex> lock(value_mutex_); value_ = value; }
    if (horizontal != -1) horizontal_ = horizontal;
    if (vertical != -1) vertical_ = vertical;
    if (index == 5 && virtualized) ++generation;
    state_ = state;
    ++effects_;
    post_read_ = true;
    InvalidateRect(hwnd, nullptr, TRUE);
    Evidence("effect", Number("index", index) + Number("effects", effects_));
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE get_ProviderOptions(ProviderOptions* out) override {
    *out = ProviderOptions_ServerSideProvider; return S_OK;
  }
  HRESULT STDMETHODCALLTYPE GetPatternProvider(PATTERNID id, IUnknown** out) override {
    *out = nullptr;
    Read();
    if (!patterns_enabled || id != kPatterns[index]) return S_OK;
    const IID* ids[] = {&__uuidof(IInvokeProvider), &__uuidof(IValueProvider),
      &__uuidof(ISelectionItemProvider), &__uuidof(IToggleProvider),
      &__uuidof(IExpandCollapseProvider), &__uuidof(IScrollProvider)};
    return QueryInterface(*ids[index], reinterpret_cast<void**>(out));
  }
  HRESULT STDMETHODCALLTYPE GetPropertyValue(PROPERTYID id, VARIANT* out) override {
    VariantInit(out);
    Read();
    if (id == UIA_NamePropertyId || id == UIA_AutomationIdPropertyId ||
        id == UIA_FrameworkIdPropertyId || id == UIA_ClassNamePropertyId) {
      std::wstring text = id == UIA_FrameworkIdPropertyId ? L"P7aSynthetic" :
        id == UIA_ClassNamePropertyId ? L"P7aControl" :
        id == UIA_AutomationIdPropertyId ? L"slot-" + std::to_wstring(index) :
        std::wstring(kNames[index]) + L" item-" + std::to_wstring(generation.load());
      out->vt = VT_BSTR; out->bstrVal = SysAllocString(text.c_str());
    } else if (id == UIA_ControlTypePropertyId) {
      constexpr int types[] = {UIA_ButtonControlTypeId, UIA_EditControlTypeId,
        UIA_ListItemControlTypeId, UIA_CheckBoxControlTypeId,
        UIA_TreeItemControlTypeId, UIA_PaneControlTypeId};
      out->vt = VT_I4; out->lVal = types[index];
    } else if (id == UIA_IsControlElementPropertyId || id == UIA_IsContentElementPropertyId ||
               id == UIA_IsEnabledPropertyId) {
      out->vt = VT_BOOL; out->boolVal = VARIANT_TRUE;
    } else if (id == UIA_HasKeyboardFocusPropertyId || id == UIA_IsKeyboardFocusablePropertyId) {
      out->vt = VT_BOOL; out->boolVal = VARIANT_FALSE;
    }
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE get_HostRawElementProvider(IRawElementProviderSimple** out) override {
    return UiaHostProviderFromHwnd(hwnd, out);
  }
  HRESULT STDMETHODCALLTYPE Navigate(NavigateDirection, IRawElementProviderFragment** out) override {
    *out = nullptr; return S_OK;
  }
  HRESULT STDMETHODCALLTYPE GetRuntimeId(SAFEARRAY** out) override {
    // HWND-hosted roots delegate identity to UIA. Reusing the slot's HWND deliberately
    // keeps the runtime id unchanged while the logical item is replaced.
    *out = nullptr;
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE get_BoundingRectangle(UiaRect* out) override {
    RECT r{}; if (!GetWindowRect(hwnd, &r)) return UIA_E_ELEMENTNOTAVAILABLE;
    *out = {double(r.left), double(r.top), double(r.right-r.left), double(r.bottom-r.top)};
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE GetEmbeddedFragmentRoots(SAFEARRAY** out) override { *out = nullptr; return S_OK; }
  HRESULT STDMETHODCALLTYPE SetFocus() override { return UIA_E_NOTSUPPORTED; }
  HRESULT STDMETHODCALLTYPE get_FragmentRoot(IRawElementProviderFragmentRoot** out) override {
    *out = this; AddRef(); return S_OK;
  }
  HRESULT STDMETHODCALLTYPE ElementProviderFromPoint(double, double, IRawElementProviderFragment** out) override {
    *out = this; AddRef(); return S_OK;
  }
  HRESULT STDMETHODCALLTYPE GetFocus(IRawElementProviderFragment** out) override { *out = nullptr; return S_OK; }
  HRESULT STDMETHODCALLTYPE Invoke() override { return Apply(1, L"Invoke"); }
  HRESULT STDMETHODCALLTYPE SetValue(LPCWSTR value) override { return Apply(1, L"Value", value); }
  HRESULT STDMETHODCALLTYPE get_Value(BSTR* out) override {
    Read(); std::lock_guard<std::mutex> lock(value_mutex_);
    *out = SysAllocString(value_.c_str()); return S_OK;
  }
  HRESULT STDMETHODCALLTYPE get_IsReadOnly(BOOL* out) override { *out = FALSE; return S_OK; }
  HRESULT STDMETHODCALLTYPE Select() override { return Apply(1, L"Select"); }
  HRESULT STDMETHODCALLTYPE AddToSelection() override { return Apply(1, L"AddToSelection"); }
  HRESULT STDMETHODCALLTYPE RemoveFromSelection() override { return Apply(0, L"RemoveFromSelection"); }
  HRESULT STDMETHODCALLTYPE get_IsSelected(BOOL* out) override { Read(); *out = state_ != 0; return S_OK; }
  HRESULT STDMETHODCALLTYPE get_SelectionContainer(IRawElementProviderSimple** out) override { *out = nullptr; return S_OK; }
  HRESULT STDMETHODCALLTYPE Toggle() override { return Apply(state_ ? 0 : 1, L"Toggle"); }
  HRESULT STDMETHODCALLTYPE get_ToggleState(ToggleState* out) override { Read(); *out = state_ ? ToggleState_On : ToggleState_Off; return S_OK; }
  HRESULT STDMETHODCALLTYPE Expand() override { return Apply(1, L"Expand"); }
  HRESULT STDMETHODCALLTYPE Collapse() override { return Apply(0, L"Collapse"); }
  HRESULT STDMETHODCALLTYPE get_ExpandCollapseState(ExpandCollapseState* out) override {
    Read(); *out = state_ ? ExpandCollapseState_Expanded : ExpandCollapseState_Collapsed; return S_OK;
  }
  HRESULT STDMETHODCALLTYPE Scroll(ScrollAmount horizontal, ScrollAmount vertical) override {
    auto delta = [](ScrollAmount amount) -> double {
      switch (amount) {
        case ScrollAmount_LargeDecrement: return -30;
        case ScrollAmount_SmallDecrement: return -10;
        case ScrollAmount_LargeIncrement: return 30;
        case ScrollAmount_SmallIncrement: return 10;
        default: return 0;
      }
    };
    return Apply(1, L"Scroll", nullptr,
      std::clamp(horizontal_.load() + delta(horizontal), 0.0, 100.0),
      std::clamp(vertical_.load() + delta(vertical), 0.0, 100.0));
  }
  HRESULT STDMETHODCALLTYPE SetScrollPercent(double horizontal, double vertical) override {
    if ((horizontal != -1 && (horizontal < 0 || horizontal > 100)) ||
        (vertical != -1 && (vertical < 0 || vertical > 100))) return E_INVALIDARG;
    return Apply(1, L"SetScrollPercent", nullptr, horizontal, vertical);
  }
  HRESULT STDMETHODCALLTYPE get_HorizontallyScrollable(BOOL* out) override { *out = TRUE; return S_OK; }
  HRESULT STDMETHODCALLTYPE get_VerticallyScrollable(BOOL* out) override { *out = TRUE; return S_OK; }
  HRESULT STDMETHODCALLTYPE get_HorizontalScrollPercent(double* out) override { Read(); *out = horizontal_; return S_OK; }
  HRESULT STDMETHODCALLTYPE get_VerticalScrollPercent(double* out) override { Read(); *out = vertical_; return S_OK; }
  HRESULT STDMETHODCALLTYPE get_HorizontalViewSize(double* out) override { *out = 10; return S_OK; }
  HRESULT STDMETHODCALLTYPE get_VerticalViewSize(double* out) override { *out = 10; return S_OK; }
};
std::array<Control*, 6> controls{};

#include "api_probe.h"

LRESULT CALLBACK WindowProc(HWND hwnd, UINT message, WPARAM wp, LPARAM lp) {
  auto* control = reinterpret_cast<Control*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
  if (message == WM_NCCREATE) {
    control = static_cast<Control*>(reinterpret_cast<CREATESTRUCTW*>(lp)->lpCreateParams);
    if (control) { control->hwnd = hwnd; SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(control)); }
  }
  if (message == WM_GETOBJECT && control && static_cast<LONG>(lp) == UiaRootObjectId)
    return UiaReturnRawElementProvider(hwnd, wp, lp, control);
  if (message == WM_PAINT) {
    PAINTSTRUCT ps{}; HDC dc = BeginPaint(hwnd, &ps);
    std::wstring label = control ? std::wstring(kNames[control->index]) + L" item-" +
      std::to_wstring(generation.load()) : L"P7a synthetic provider (test only)";
    TextOutW(dc, 8, 8, label.c_str(), static_cast<int>(label.size())); EndPaint(hwnd, &ps); return 0;
  }
  if (message == kCommand && hwnd == main_window) {
    if (wp == 1) for (auto* c : controls) c->Snapshot();
    if (wp == 2 || wp == 3) {
      ++generation; virtualized = wp == 3;
      for (auto* c : controls) InvalidateRect(c->hwnd, nullptr, TRUE);
      Evidence("replacement", Number("generation", generation) + Number("virtualized", virtualized));
    }
    // Explicit self-test stimuli affect only windows owned by this fixture.
    if (wp == 4) {
      BOOL ok = SetForegroundWindow(hwnd);
      Evidence("stimulus", Number("foregroundAccepted", ok) + Number("hwnd", WindowId(hwnd)));
    }
    if (wp == 5) { SetCapture(hwnd); Evidence("stimulusCapture"); }
    if (wp == 6) ReleaseCapture();
    if (wp == 7) {
      HWND popup = CreateWindowExW(WS_EX_TOPMOST | WS_EX_NOACTIVATE, L"P7aFixture", L"P7a popup",
        WS_POPUP | WS_VISIBLE, 100, 100, 200, 80, hwnd, nullptr, GetModuleHandleW(nullptr), nullptr);
      Evidence("stimulusPopup", Number("hwnd", WindowId(popup)));
    }
    if (wp == 8) DestroyWindow(hwnd);
    if (wp == 9) { patterns_enabled = !patterns_enabled; Evidence("patterns", Number("enabled", patterns_enabled)); }
    return 0;
  }
  if (message == WM_DESTROY && hwnd == main_window) { SetEvent(release_gate); PostQuitMessage(0); return 0; }
  return DefWindowProcW(hwnd, message, wp, lp);
}

// Separate client process: verifies the actual out-of-process UIA surface, no OS input.
int Probe(HWND hwnd, int index, bool apply) {
  DWORD pid = 0; GetWindowThreadProcessId(hwnd, &pid);
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  wchar_t image[32768]{}, own_image[32768]{}, window_class[64]{};
  DWORD size = 32768;
  const bool owned = process && QueryFullProcessImageNameW(process, 0, image, &size) &&
    GetModuleFileNameW(nullptr, own_image, 32768) && _wcsicmp(image, own_image) == 0 &&
    GetClassNameW(hwnd, window_class, 64) && std::wstring(window_class) == L"P7aFixture";
  if (process) CloseHandle(process);
  if (!owned) { Evidence("error", ",\"reason\":\"not_fixture_window\""); return 2; }
  IUIAutomation* automation = nullptr; IUIAutomationElement* element = nullptr;
  HRESULT hr = CoCreateInstance(CLSID_CUIAutomation, nullptr, CLSCTX_INPROC_SERVER,
    IID_PPV_ARGS(&automation));
  if (SUCCEEDED(hr)) hr = automation->ElementFromHandle(hwnd, &element);
  IUnknown* pattern = nullptr;
  if (SUCCEEDED(hr)) hr = element->GetCurrentPattern(kPatterns[index], &pattern);
  if (SUCCEEDED(hr) && !pattern) hr = E_NOINTERFACE;
  SAFEARRAY* runtime = nullptr; BSTR name = nullptr;
  if (SUCCEEDED(hr)) hr = element->GetRuntimeId(&runtime);
  if (SUCCEEDED(hr)) hr = element->get_CurrentName(&name);
  if (SUCCEEDED(hr) && apply) {
    if (index == 0) { IUIAutomationInvokePattern* p = nullptr; hr = pattern->QueryInterface(IID_PPV_ARGS(&p)); if (p) { hr = p->Invoke(); p->Release(); } }
    if (index == 1) { IUIAutomationValuePattern* p = nullptr; hr = pattern->QueryInterface(IID_PPV_ARGS(&p)); if (p) { BSTR value = SysAllocString(L"synthetic-updated"); hr = value ? p->SetValue(value) : E_OUTOFMEMORY; SysFreeString(value); p->Release(); } }
    if (index == 2) { IUIAutomationSelectionItemPattern* p = nullptr; hr = pattern->QueryInterface(IID_PPV_ARGS(&p)); if (p) { hr = p->Select(); p->Release(); } }
    if (index == 3) { IUIAutomationTogglePattern* p = nullptr; hr = pattern->QueryInterface(IID_PPV_ARGS(&p)); if (p) { hr = p->Toggle(); p->Release(); } }
    if (index == 4) { IUIAutomationExpandCollapsePattern* p = nullptr; hr = pattern->QueryInterface(IID_PPV_ARGS(&p)); if (p) { hr = p->Expand(); p->Release(); } }
    if (index == 5) { IUIAutomationScrollPattern* p = nullptr; hr = pattern->QueryInterface(IID_PPV_ARGS(&p)); if (p) { hr = p->Scroll(ScrollAmount_NoAmount, ScrollAmount_SmallIncrement); p->Release(); } }
    BSTR after = nullptr; if (SUCCEEDED(hr)) hr = element->get_CurrentName(&after); SysFreeString(after);
  }
  std::string ids = ",\"runtimeId\":[";
  if (runtime) {
    LONG lower = 0, upper = -1; SafeArrayGetLBound(runtime, 1, &lower); SafeArrayGetUBound(runtime, 1, &upper);
    for (LONG n = lower; n <= upper; ++n) { LONG v = 0; SafeArrayGetElement(runtime, &n, &v); if (n > lower) ids += ","; ids += std::to_string(v); }
  }
  ids += "]";
  // Names are exclusively the fixture's ASCII synthetic labels.
  std::string label; if (name) for (const wchar_t* p = name; *p; ++p) label += *p < 128 && *p != '"' && *p != '\\' ? static_cast<char>(*p) : '?';
  Evidence("probe", Number("index", index) + Number("hresult", static_cast<ULONG>(hr)) + ids + ",\"name\":\"" + label + "\"");
  SysFreeString(name); if (runtime) SafeArrayDestroy(runtime);
  if (pattern) pattern->Release(); if (element) element->Release(); if (automation) automation->Release();
  return SUCCEEDED(hr) ? 0 : 1;
}

int wmain(int argc, wchar_t** argv) {
  p7a_api_probe::sink = [](p7a_api_probe::Api api, unsigned long long attempts) {
    Evidence("apiAttempt", Number("api", api) + Number("attempts", attempts));
  };
  if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) return 2;
  if (argc == 5 && std::wstring(argv[1]) == L"--probe") {
    int index = _wtoi(argv[3]); if (index < 0 || index >= 6) return 2;
    int result = Probe(reinterpret_cast<HWND>(_wcstoui64(argv[2], nullptr, 10)), index, std::wstring(argv[4]) == L"apply");
    CoUninitialize(); return result;
  }
  release_gate = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!release_gate) return 2;
  WNDCLASSW cls{}; cls.lpfnWndProc = WindowProc; cls.hInstance = GetModuleHandleW(nullptr);
  cls.lpszClassName = L"P7aFixture"; cls.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1);
  if (!RegisterClassW(&cls)) return 2;
  main_window = CreateWindowExW(WS_EX_NOACTIVATE, cls.lpszClassName, L"P7a synthetic fixture",
    WS_OVERLAPPEDWINDOW, 80, 80, 550, 400, nullptr, nullptr, cls.hInstance, nullptr);
  if (!main_window) return 2;
  for (int i = 0; i < 6; ++i) {
    controls[i] = new Control(i);
    if (!CreateWindowExW(0, cls.lpszClassName, kNames[i], WS_CHILD | WS_VISIBLE,
      20, 35 + i * 45, 460, 36, main_window, nullptr, cls.hInstance, controls[i])) return 2;
    controls[i]->Snapshot();
  }
  ShowWindow(main_window, SW_SHOWNOACTIVATE);
  Evidence("ready", Number("hwnd", WindowId(main_window)));
  std::thread([] {
    std::string line;
    while (std::getline(std::cin, line)) {
      if (line == "release") { SetEvent(release_gate); continue; }
      if (line == "delay-before" || line == "delay-inside" || line == "delay-after") {
        ResetEvent(release_gate); delay_phase = line == "delay-before" ? 1 : line == "delay-inside" ? 2 : 3;
        Evidence("armed", Number("phase", delay_phase)); continue;
      }
      const char* commands[] = {"snapshot", "replace", "reuse", "foreground", "capture", "release-capture", "popup", "quit", "patterns"};
      for (int i = 0; i < 9; ++i) if (line == commands[i]) {
        if (i == 7) SetEvent(release_gate);
        PostMessageW(main_window, kCommand, i + 1, 0);
      }
    }
    SetEvent(release_gate); PostMessageW(main_window, kCommand, 8, 0);
  }).detach();
  MSG message{};
  while (GetMessageW(&message, nullptr, 0, 0) > 0) { TranslateMessage(&message); DispatchMessageW(&message); }
  Evidence("finished");
  // Process lifetime owns providers and gate; UIA may still hold references at shutdown.
  return 0;
}
