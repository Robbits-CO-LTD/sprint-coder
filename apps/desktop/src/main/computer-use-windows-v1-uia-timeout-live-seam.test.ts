import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Contracts and a LIVE seam for the bounds on the UI Automation calls of the V1 lane (#820). Without
// them, a target that does not answer holds the serial lane for good: every later frame waits behind
// it. The V1 lane creates its UI Automation in ONE place (CreateWindowsV1Automation), which sets the
// ConnectionTimeout / TransactionTimeout of IUIAutomation2, and every path of calls has its own bound
// (WindowsV1UiaPath: the first timed-out call ends the path, a short path has a budget, the observe has
// a budget and the cancellation epoch).
//
// The live seam compiles the real host (computer_use_windows_host.cc, with its entry point renamed) into a
// test program. The program starts ITSELF as a second process that owns the windows (so every UI
// Automation call crosses a process boundary, as it does against a real app): a window that stops
// answering altogether, an ordinary one, and one whose native UI Automation provider answers a few
// property requests and then stops. The V1 paths are called against them (the point and focus
// classification, the observation, the control bindings, the semantic target search, the focused-element
// signature that the re-validation uses). Each must come back within one timeout plus a small margin and
// fail closed. Windows only: elsewhere, or where no MSVC can be found, it is skipped (but never in CI,
// where a runner that cannot compile must not turn this into a silent pass). The build output goes to a
// temporary directory that is removed after the run.

const nativeDirectory = join(__dirname, '../../computer-use-native');
const host = readFileSync(join(nativeDirectory, 'computer_use_windows_host.cc'), 'utf8');
const uiaSource = readFileSync(join(nativeDirectory, 'computer_use_windows_uia_source.h'), 'utf8');
const mainHost = readFileSync(join(__dirname, 'computer-use-native-host.ts'), 'utf8');
const mainWindows = readFileSync(join(__dirname, 'computer-use-native-windows.ts'), 'utf8');

/** Runs a program without blocking the event loop (the test worker must keep answering its parent). */
function run(
  file: string,
  args: string[],
  options: {
    cwd?: string;
    windowsVerbatimArguments?: boolean;
    env?: NodeJS.ProcessEnv;
    timeout: number;
  },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.windowsVerbatimArguments === undefined
        ? {}
        : { windowsVerbatimArguments: options.windowsVerbatimArguments }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const timer = setTimeout(() => child.kill(), options.timeout);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ status: -1, stdout, stderr: stderr + String(error) });
    });
  });
}

/** The code of a file without its line comments. */
const code = (text: string): string => text.replace(/\/\/.*$/gmu, '');

/** A number constant of the host, e.g. "constexpr DWORD kName = 500;" -> 500 (digit separators removed). */
function hostNumber(name: string): number {
  const match = new RegExp(`${name}(?:\\{|\\s*=\\s*)([0-9']+)`, 'u').exec(code(host));
  expect(match, name).not.toBeNull();
  return Number(match![1]!.replaceAll("'", ''));
}

const sixPaths = [
  'ClassifyWindowsPoint',
  'ReadUiaObservation',
  'CaptureWindowsControlBindings',
  'FindWindowsSemanticTarget',
  'ClassifyWindowsFocusedElement',
  'WindowsFocusedElementSignature',
] as const;

describe('V1 lane UI Automation is created in one place, with its call timeouts (#820)', () => {
  it('creates UI Automation only in CreateWindowsV1Automation (and CreateBoundedAutomation)', () => {
    // The host: no CLSID_CUIAutomation8 at all, and exactly one coclass creation: the fallback inside
    // the one helper.
    expect(code(host)).not.toContain('CLSID_CUIAutomation8');
    expect([...code(host).matchAll(/CoCreateInstance\(\s*CLSID_CUIAutomation/gu)]).toHaveLength(1);
    expect([...code(host).matchAll(/CLSID_CUIAutomation(?!8)/gu)]).toHaveLength(1);
    const helper = host.slice(
      host.indexOf('HRESULT CreateWindowsV1Automation('),
      host.indexOf('enum class WindowsV1UiaStop'),
    );
    expect(helper).toContain('CLSID_CUIAutomation, nullptr, CLSCTX_INPROC_SERVER');
    // Every other use goes through the helper.
    const callers = [...code(host).matchAll(/CreateWindowsV1Automation\(&automation\)/gu)];
    expect(callers.length).toBeGreaterThanOrEqual(8);
    // The source header: one place creates the bounded coclass (CUIAutomation8), shared by the shadow
    // source and the V1 lane.
    expect([...code(uiaSource).matchAll(/CLSID_CUIAutomation8/gu)]).toHaveLength(1);
    expect(code(uiaSource)).not.toMatch(/CLSID_CUIAutomation(?!8)/u);
  });

  it('bounds a call with both timeouts, and falls back to the old behaviour visibly', () => {
    const bounded = uiaSource.slice(
      uiaSource.indexOf('inline bool CreateBoundedAutomation('),
      uiaSource.indexOf('// What the shell knows about an item'),
    );
    const compact = bounded.replace(/\s+/gu, ' ');
    expect(compact).toContain(
      'CoCreateInstance(CLSID_CUIAutomation8, nullptr, CLSCTX_INPROC_SERVER',
    );
    expect(compact).toContain('bounded->put_ConnectionTimeout(connection_timeout_ms)');
    expect(compact).toContain('bounded->put_TransactionTimeout(transaction_timeout_ms)');
    // Without the interface or either timeout, no automation is handed out.
    expect(compact).toContain('if (!set) { created->Release(); return false; }');
    const helper = host.slice(
      host.indexOf('// The bounds on the UI Automation calls of the V1 lane'),
      host.indexOf('enum class WindowsV1UiaStop'),
    );
    const helperCompact = helper.replace(/\s+/gu, ' ');
    expect(helperCompact).toContain(
      'CreateBoundedAutomation( kWindowsV1UiaConnectionTimeoutMs, kWindowsV1UiaTransactionTimeoutMs, automation)',
    );
    // The fallback is the plain coclass (as before), counted and logged once, never silent.
    expect(helperCompact).toContain('windows_v1_uia_unbounded_creations.fetch_add(1) == 0');
    expect(helperCompact).toContain('OutputDebugStringA(');
    // The shadow source uses the same creation, with its own (longer) bound.
    expect(uiaSource.replace(/\s+/gu, ' ')).toContain(
      'windows_uia_source_detail::CreateBoundedAutomation(timeout_ms, timeout_ms, automation.Receive())',
    );
  });

  it('keeps the worst cases inside what the lane is given, from the constants themselves', () => {
    const connection = hostNumber('kWindowsV1UiaConnectionTimeoutMs');
    const transaction = hostNumber('kWindowsV1UiaTransactionTimeoutMs');
    const shortBudget = hostNumber('kWindowsV1UiaShortPathBudget');
    const observeBudget = hostNumber('kWindowsV1UiaObserveBudget');
    const cancelAck = Number(
      /COMPUTER_USE_NATIVE_CANCEL_ACK_TIMEOUT_MS = ([0-9_]+)/u
        .exec(mainHost)![1]!
        .replaceAll('_', ''),
    );
    const observeTimeout = Number(
      /operation === 'list_windows' \|\| operation === 'observe'\) return ([0-9_]+)/u
        .exec(mainWindows)![1]!
        .replaceAll('_', ''),
    );
    expect(cancelAck).toBe(1000);
    expect(observeTimeout).toBe(30_000);
    // A short path: the budget, plus the one call that starts just before it is spent (at most the
    // longer of the two timeouts), is inside the Cancel acknowledgment.
    expect(shortBudget + Math.max(connection, transaction)).toBeLessThan(cancelAck);
    // The first contact is allowed to be slower than a call on a connected element, and one timed-out
    // call alone is inside the acknowledgment too.
    expect(connection).toBeGreaterThanOrEqual(transaction);
    expect(connection).toBeLessThan(cancelAck);
    // The observe has a budget of its own, inside what Main gives an observe (which also captures).
    expect(observeBudget).toBeLessThan(observeTimeout);
  });

  it('ends a path at its first timed-out call, and stops climbing at an element that cannot be read', () => {
    const c = code(host).replace(/\s+/gu, ' ');
    // The state: a timeout, a spent budget and a cancel end the path for good.
    expect(c).toContain('enum class WindowsV1UiaStop { kNone, kTimeout, kBudget, kCanceled };');
    expect(c).toContain('lane->stop = WindowsV1UiaStop::kTimeout;');
    expect(c).toContain('lane->stop = WindowsV1UiaStop::kBudget;');
    expect(c).toContain('lane->stop = WindowsV1UiaStop::kCanceled;');
    expect(c).toContain(
      'return result == kUiaTimeout || result == kWin32Timeout || result == kRpcTimeout;',
    );
    // Every walk checks it at each node, and every chain of reads goes through the checked result.
    for (const walk of [
      'bool AppendUiaTree(',
      'bool CollectWindowsControlBindings(',
      'bool FindUiaTargetRecursive(',
    ]) {
      const at = host.indexOf(walk);
      expect(at, walk).toBeGreaterThan(0);
      expect(host.slice(at, at + 700), walk).toContain('!WindowsV1UiaMayCall()');
    }
    expect(c).toContain(
      'WindowsUiaRisk ClassifyWindowsUiaElementSelf(IUIAutomationElement *element) { WindowsUiaRisk risk; if (element == nullptr || !WindowsV1UiaMayCall()) return risk;',
    );
    expect(c).toContain(
      'if (element == nullptr || signature == nullptr || !WindowsV1UiaMayCall()) return false;',
    );
    // The climb stops at an element that could not be read (before the parent is asked for), and the
    // parent is not asked for after the path has ended.
    const climb = c.slice(
      c.indexOf('WindowsUiaRisk ClassifyWindowsUiaElement(IUIAutomationElement *element)'),
    );
    expect(climb.indexOf('if (!risk.metadata_complete) break;')).toBeGreaterThan(0);
    expect(climb.indexOf('if (!risk.metadata_complete) break;')).toBeLessThan(
      climb.indexOf('walker->GetParentElement(current, &parent)'),
    );
    expect(climb).toContain(
      'WindowsV1UiaMayCall() ? walker->GetParentElement(current, &parent) : E_ABORT',
    );
    // The point classification reads the signature only for facts that are complete.
    expect(c).toContain(
      'if (control_signature != nullptr && risk.metadata_complete) ComputeWindowsControlSignature(element, expected_pid, nullptr, control_signature);',
    );
    // The observe reads the focused element's signature only for a classified focus.
    expect(c).toContain(
      'focused_risk.classified && focused_risk.metadata_complete && WindowsFocusedElementSignature(',
    );
    // The scopes: each short path has its own, the observe has the long budget and the epoch.
    expect([
      ...c.matchAll(/const WindowsV1UiaPath path\(kWindowsV1UiaShortPathBudget\);/gu),
    ]).toHaveLength(4);
    expect(c).toContain(
      'const WindowsV1UiaPath uia_path(kWindowsV1UiaObserveBudget, true, session.cancel_epoch);',
    );
  });

  it('names why a read did not complete, and keeps a timed-out action apart from an unconfirmed one', () => {
    const c = code(host).replace(/\s+/gu, ' ');
    // The observe: a target that did not answer is transient (accessibility_timeout), a spent budget is
    // observation_timeout, a cancel is observation_stale.
    expect(c).toContain('return "accessibility_timeout";');
    expect(c).toContain('return "observation_timeout";');
    expect(c).toContain('*reason = unreadable("accessibility_unavailable");');
    expect(c).toContain('*reason = unreadable("accessibility_binding_unavailable");');
    // The semantic target search tells a timeout from "no such target".
    expect(c).toContain(
      'path.Stop() == WindowsV1UiaStop::kTimeout ? "accessibility_timeout" : "target_required"',
    );
    // A pattern call that timed out may have been applied: unconfirmed, told apart.
    expect(c).toContain(
      'WindowsV1UiaIsTimeout(action_result) ? "input_timeout_unconfirmed" : "input_not_confirmed"',
    );
    // A failed read is the "unreadable" of each caller (fail closed).
    expect(c).toContain(
      'const auto decision = ClassifyNativePreflightFacts( {risk.metadata_complete, risk.classified, risk.secure, risk.high_impact});',
    );
    for (const name of ['ClassifyWindowsPoint(', 'ClassifyWindowsFocusedElement(']) {
      const at = host.indexOf(`WindowsUiaRisk ${name}`);
      expect(at, name).toBeGreaterThan(0);
      expect(host.slice(at, at + 1700), name).toContain('return {};');
    }
    expect(host).toContain('*reason = "accessibility_unavailable";');
  });
});

const vswhere = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';
const libraries = [
  'ole32.lib',
  'oleaut32.lib',
  'uiautomationcore.lib',
  'user32.lib',
  'dwmapi.lib',
  'd3d11.lib',
  'dxgi.lib',
  'windowscodecs.lib',
  'bcrypt.lib',
  'advapi32.lib',
  'userenv.lib',
  'crypt32.lib',
  'wintrust.lib',
  'shell32.lib',
  'runtimeobject.lib',
  'windowsapp.lib',
  'uuid.lib',
];

function compileArguments(path: string, output: string, provenance: string): string[] {
  return [
    '/nologo',
    '/std:c++20',
    '/EHsc',
    '/permissive-',
    '/utf-8',
    '/DUNICODE',
    '/D_UNICODE',
    '/DWIN32_LEAN_AND_MEAN',
    '/DNOMINMAX',
    '/D_WIN32_WINNT=0x0A00',
    `/FI${provenance}`,
    `/I${nativeDirectory}`,
    path,
    `/Fe:${output}`,
    `/Fo:${output}.obj`,
    '/link',
    '/DEBUG:NONE',
    ...libraries,
  ];
}

type Build = Readonly<{ name: string; file: string; args: string[]; verbatim: boolean }>;

function findBuild(path: string, output: string, provenance: string): Build | null {
  if (process.platform !== 'win32') return null;
  if (spawnSync('cl.exe', ['/?'], { stdio: 'ignore' }).status === 0)
    return {
      name: 'cl.exe',
      file: 'cl.exe',
      args: compileArguments(path, output, provenance),
      verbatim: false,
    };
  if (!existsSync(vswhere)) return null;
  const found = spawnSync(
    vswhere,
    [
      '-latest',
      '-products',
      '*',
      '-requires',
      'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      '-property',
      'installationPath',
    ],
    { encoding: 'utf8' },
  );
  const root = found.stdout.trim();
  const vcvars = join(root, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
  if (found.status !== 0 || root === '' || !existsSync(vcvars)) return null;
  return {
    name: 'cl.exe (vcvars64)',
    file: 'cmd.exe',
    args: [
      '/d',
      '/s',
      '/c',
      `"call "${vcvars}" >nul && cl.exe ${compileArguments(path, output, provenance)
        .map((argument) => `"${argument}"`)
        .join(' ')}"`,
    ],
    verbatim: true,
  };
}

const program = String.raw`
// The real host, its entry point renamed so this program has its own.
#define wmain computer_use_host_wmain
#include "computer_use_windows_host.cc"
#undef wmain

#include <iostream>
#include <string>
#include <vector>

namespace sc820 {

int failures = 0;
void SeamCheck(bool ok, const std::string &name) {
  if (!ok) {
    ++failures;
    std::cout << "FAIL " << name << std::endl;
  }
}

// ---------------------------------------------------------------- the process that owns the windows

std::atomic<int> g_provider_stall_after{-1};  // property requests answered before the provider stops
std::atomic<int> g_provider_calls{0};

// A minimal native provider: answers a few property requests, then stops answering (sleeps).
class Provider final : public IRawElementProviderSimple {
public:
  explicit Provider(HWND window) : window_(window) {}
  ULONG STDMETHODCALLTYPE AddRef() override { return ++references_; }
  ULONG STDMETHODCALLTYPE Release() override {
    const ULONG left = --references_;
    if (left == 0) delete this;
    return left;
  }
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID id, void **out) override {
    if (id == __uuidof(IUnknown) || id == __uuidof(IRawElementProviderSimple)) {
      *out = static_cast<IRawElementProviderSimple *>(this);
      AddRef();
      return S_OK;
    }
    *out = nullptr;
    return E_NOINTERFACE;
  }
  HRESULT STDMETHODCALLTYPE get_ProviderOptions(ProviderOptions *options) override {
    *options = ProviderOptions_ServerSideProvider;
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE GetPatternProvider(PATTERNID, IUnknown **pattern) override {
    *pattern = nullptr;
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE GetPropertyValue(PROPERTYID property, VARIANT *value) override {
    VariantInit(value);
    const int stall_after = g_provider_stall_after.load();
    if (stall_after >= 0 && g_provider_calls.fetch_add(1) >= stall_after) Sleep(3000);
    if (property == UIA_NamePropertyId) {
      value->vt = VT_BSTR;
      value->bstrVal = SysAllocString(L"sc820-provider");
    } else if (property == UIA_AutomationIdPropertyId) {
      value->vt = VT_BSTR;
      value->bstrVal = SysAllocString(L"provider");
    } else if (property == UIA_ControlTypePropertyId) {
      value->vt = VT_I4;
      value->lVal = UIA_PaneControlTypeId;
    } else if (property == UIA_IsPasswordPropertyId) {
      value->vt = VT_BOOL;
      value->boolVal = VARIANT_FALSE;
    }
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE get_HostRawElementProvider(IRawElementProviderSimple **host_provider) override {
    return UiaHostProviderFromHwnd(window_, host_provider);
  }

private:
  HWND window_;
  std::atomic<ULONG> references_{1};
};

LRESULT CALLBACK HangProc(HWND window, UINT message, WPARAM w, LPARAM l) {
  if (message == WM_APP + 1) {
    Sleep(3000);  // a window that does not answer: its thread is busy and pumps nothing
    return 0;
  }
  if (message == WM_APP + 3) {  // put the keyboard focus on its edit control
    HWND edit = FindWindowExW(window, nullptr, L"EDIT", nullptr);
    if (edit != nullptr) SetFocus(edit);
    return 0;
  }
  if (message == WM_DESTROY) {
    PostQuitMessage(0);
    return 0;
  }
  return DefWindowProcW(window, message, w, l);
}

LRESULT CALLBACK ProviderProc(HWND window, UINT message, WPARAM w, LPARAM l) {
  if (message == WM_APP + 2) {  // arm the provider: it answers w requests, then stops
    g_provider_calls.store(0);
    g_provider_stall_after.store(static_cast<int>(w));
    return 0;
  }
  if (message == WM_GETOBJECT && static_cast<long>(l) == static_cast<long>(UiaRootObjectId)) {
    Provider *provider = new Provider(window);
    const LRESULT answer = UiaReturnRawElementProvider(window, w, l, provider);
    provider->Release();
    return answer;
  }
  if (message == WM_DESTROY) {
    PostQuitMessage(0);
    return 0;
  }
  return DefWindowProcW(window, message, w, l);
}

struct Win {
  HWND handle = nullptr;
  std::thread thread;
};

void MakeWindow(Win &win, WNDPROC proc, const wchar_t *class_name, const wchar_t *title, int x, int y, bool children) {
  std::atomic<bool> ready{false};
  win.thread = std::thread([&win, &ready, proc, class_name, title, x, y, children]() {
    WNDCLASSW cls{};
    cls.lpfnWndProc = proc;
    cls.hInstance = GetModuleHandleW(nullptr);
    cls.lpszClassName = class_name;
    RegisterClassW(&cls);
    win.handle = CreateWindowExW(WS_EX_TOPMOST, class_name, title, WS_OVERLAPPEDWINDOW | WS_VISIBLE, x, y, 300, 200,
                                 nullptr, nullptr, cls.hInstance, nullptr);
    if (children) {
      CreateWindowExW(0, L"BUTTON", L"ok", WS_CHILD | WS_VISIBLE, 20, 20, 100, 30, win.handle, nullptr, cls.hInstance, nullptr);
      CreateWindowExW(0, L"EDIT", L"text", WS_CHILD | WS_VISIBLE | WS_BORDER, 20, 70, 200, 30, win.handle, nullptr, cls.hInstance, nullptr);
    }
    ShowWindow(win.handle, SW_SHOW);
    ready.store(true);
    MSG message;
    while (GetMessageW(&message, nullptr, 0, 0) > 0) {
      TranslateMessage(&message);
      DispatchMessageW(&message);
    }
  });
  for (int i = 0; i < 500 && !ready.load(); ++i) Sleep(10);
}

int RunWindowProcess() {
  CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  Win hang, ordinary, provider;
  MakeWindow(hang, HangProc, L"Sc820Hang", L"sc820-hang", 20, 20, true);
  MakeWindow(ordinary, DefWindowProcW, L"Sc820Ordinary", L"sc820-ordinary", 20, 240, true);
  MakeWindow(provider, ProviderProc, L"Sc820Provider", L"sc820-provider", 340, 20, false);
  std::cout << "READY " << GetCurrentProcessId() << " " << reinterpret_cast<std::uintptr_t>(hang.handle) << " "
            << reinterpret_cast<std::uintptr_t>(ordinary.handle) << " " << reinterpret_cast<std::uintptr_t>(provider.handle)
            << std::endl;
  for (;;) Sleep(1000);  // the test ends this process
}

// ---------------------------------------------------------------- the driver

long long Millis(std::chrono::steady_clock::time_point since) {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - since).count();
}

// Runs the call while the window is stuck, and waits until it wakes before the next case.
template <class Call> long long WhileStuck(HWND window, UINT message, WPARAM w, Call &&call) {
  PostMessageW(window, message, w, 0);
  Sleep(150);
  const auto start = std::chrono::steady_clock::now();
  call();
  const long long elapsed = Millis(start);
  Sleep(3300);
  return elapsed;
}

bool BringToForeground(HWND window) {
  if (GetForegroundWindow() == window) return true;
  const DWORD me = GetCurrentThreadId();
  HWND current = GetForegroundWindow();
  const DWORD other = current != nullptr ? GetWindowThreadProcessId(current, nullptr) : 0;
  const DWORD target = GetWindowThreadProcessId(window, nullptr);
  if (other != 0 && other != me) AttachThreadInput(me, other, TRUE);
  if (target != 0 && target != me) AttachThreadInput(me, target, TRUE);
  ShowWindow(window, SW_SHOW);
  BringWindowToTop(window);
  SetForegroundWindow(window);
  if (other != 0 && other != me) AttachThreadInput(me, other, FALSE);
  if (target != 0 && target != me) AttachThreadInput(me, target, FALSE);
  Sleep(300);
  if (GetForegroundWindow() == window) return true;
  // The last resort: the Alt key lets a process move the foreground.
  keybd_event(VK_MENU, 0, 0, 0);
  keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, 0);
  SetForegroundWindow(window);
  Sleep(300);
  return GetForegroundWindow() == window;
}

int RunDriver(bool ci) {
  CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  wchar_t self[MAX_PATH]{};
  GetModuleFileNameW(nullptr, self, MAX_PATH);
  SECURITY_ATTRIBUTES inherit{sizeof(inherit), nullptr, TRUE};
  HANDLE read_end = nullptr, write_end = nullptr;
  CreatePipe(&read_end, &write_end, &inherit, 0);
  SetHandleInformation(read_end, HANDLE_FLAG_INHERIT, 0);
  STARTUPINFOW startup{sizeof(startup)};
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdOutput = write_end;
  startup.hStdError = write_end;
  startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  PROCESS_INFORMATION child{};
  std::wstring command = std::wstring(L"\"") + self + L"\" window-process";
  if (!CreateProcessW(nullptr, command.data(), nullptr, nullptr, TRUE, 0, nullptr, nullptr, &startup, &child)) {
    std::cout << "FAIL could_not_start_the_window_process" << std::endl;
    return 2;
  }
  CloseHandle(write_end);
  std::string line;
  for (char c; line.find('\n') == std::string::npos;) {
    DWORD got = 0;
    if (!ReadFile(read_end, &c, 1, &got, nullptr) || got == 0) break;
    line.push_back(c);
  }
  unsigned long pid = 0;
  unsigned long long hang_value = 0, ordinary_value = 0, provider_value = 0;
  if (sscanf_s(line.c_str(), "READY %lu %llu %llu %llu", &pid, &hang_value, &ordinary_value, &provider_value) != 4) {
    std::cout << "FAIL the_window_process_did_not_report " << line << std::endl;
    TerminateProcess(child.hProcess, 1);
    return 2;
  }
  const HWND hang = reinterpret_cast<HWND>(static_cast<std::uintptr_t>(hang_value));
  const HWND ordinary = reinterpret_cast<HWND>(static_cast<std::uintptr_t>(ordinary_value));
  const HWND provider = reinterpret_cast<HWND>(static_cast<std::uintptr_t>(provider_value));
  Sleep(600);
  std::cout << "child pid=" << pid << std::endl;

  const long long kOneTimeout = static_cast<long long>(kWindowsV1UiaConnectionTimeoutMs);
  const long long kBound = kOneTimeout + 200;  // one timeout and a small margin
  const long long kHeldUp = 250;               // a call that came back sooner was never held up

  // The very first call of this new process, to a window of another process, reads it: a cold start
  // is not turned into "unreadable" by the timeout.
  {
    std::string tree;
    std::size_t nodes = 0;
    const auto start = std::chrono::steady_clock::now();
    const bool first = ReadUiaObservation(static_cast<std::uint32_t>(pid), ordinary, &tree, &nodes);
    std::cout << "first_call_ok=" << first << " ms=" << Millis(start) << " nodes=" << nodes << std::endl;
    SeamCheck(first, "the_first_call_of_a_new_process_reads_an_ordinary_window");
  }
  SeamCheck(windows_v1_uia_unbounded_creations.load() == 0, "no_unbounded_creation");

  // A measurement means nothing if the point is over some other window.
  const auto over = [](POINT point, HWND window) {
    for (int attempt = 0; attempt < 10; ++attempt) {
      HWND at = WindowFromPoint(point);
      if (at != nullptr && GetAncestor(at, GA_ROOT) == window) return true;
      Sleep(200);
    }
    return false;
  };
  struct Case {
    std::string name;
    long long elapsed;
    bool failed_closed;
    bool required_held_up;
  };
  std::vector<Case> cases;
  const auto client_point = [](HWND window, LONG x, LONG y) {
    POINT point{x, y};
    ClientToScreen(window, &point);
    return point;
  };

  // ---- a window that does not answer at all (another process)
  {
    WindowsUiaRisk risk;
    std::string signature;
    const POINT on_button = client_point(hang, 60, 35);  // on the BUTTON child
    SeamCheck(over(on_button, hang), "the_button_point_is_over_the_hung_window");
    const long long ms = WhileStuck(hang, WM_APP + 1, 0, [&] {
      risk = ClassifyWindowsPoint(on_button, static_cast<std::uint32_t>(pid), &signature);
    });
    std::string reason;
    cases.push_back({"ClassifyWindowsPoint", ms, RejectWindowsRisk(risk, &reason), true});
  }
  {
    std::string out;
    std::size_t count = 0;
    bool ok = true;
    const long long ms = WhileStuck(hang, WM_APP + 1, 0, [&] { ok = ReadUiaObservation(static_cast<std::uint32_t>(pid), hang, &out, &count); });
    cases.push_back({"ReadUiaObservation", ms, !ok, true});
  }
  {
    WindowsControlBindings bindings;
    bool ok = true;
    const long long ms = WhileStuck(hang, WM_APP + 1, 0, [&] { ok = CaptureWindowsControlBindings(static_cast<std::uint32_t>(pid), hang, &bindings); });
    cases.push_back({"CaptureWindowsControlBindings", ms, !ok, true});
  }
  {
    WindowsSession session;
    session.active_window = hang;
    session.pid = static_cast<std::uint32_t>(pid);
    IUIAutomationElement *target = nullptr;
    std::string reason;
    bool ok = true;
    const long long ms = WhileStuck(hang, WM_APP + 1, 0, [&] { ok = FindWindowsSemanticTarget(session, "x", &target, &reason); });
    if (target != nullptr) target->Release();
    SeamCheck(reason == "accessibility_timeout", "a_timed_out_target_search_says_accessibility_timeout");
    cases.push_back({"FindWindowsSemanticTarget", ms, !ok, true});
  }
  // ---- the focused element: the hung window has to be the foreground one, with the focus in its edit
  bool focus_classification = false;
  bool focus_signature = false;
  for (int attempt = 0; attempt < 3 && !focus_classification; ++attempt) {
    if (!BringToForeground(hang)) continue;
    PostMessageW(hang, WM_APP + 3, 0, 0);
    Sleep(300);
    if (GetForegroundWindow() != hang) continue;
    WindowsUiaRisk risk;
    const long long ms = WhileStuck(hang, WM_APP + 1, 0, [&] { risk = ClassifyWindowsFocusedElement(static_cast<std::uint32_t>(pid)); });
    std::string reason;
    if (ms >= kHeldUp) {
      focus_classification = true;
      cases.push_back({"ClassifyWindowsFocusedElement", ms, RejectWindowsRisk(risk, &reason), true});
    }
  }
  for (int attempt = 0; attempt < 3 && !focus_signature; ++attempt) {
    if (!BringToForeground(hang)) continue;
    PostMessageW(hang, WM_APP + 3, 0, 0);
    Sleep(300);
    if (GetForegroundWindow() != hang) continue;
    std::string signature;
    RECT client{};
    GetClientRect(hang, &client);
    bool ok = true;
    const long long ms = WhileStuck(hang, WM_APP + 1, 0, [&] { ok = WindowsFocusedElementSignature(static_cast<std::uint32_t>(pid), client, &signature); });
    if (ms >= kHeldUp) {
      focus_signature = true;
      cases.push_back({"WindowsFocusedElementSignature", ms, !ok, true});
    }
  }
  const bool focus_case = focus_classification && focus_signature;
  std::cout << "focus_case=" << focus_case << std::endl;
  if (ci) SeamCheck(focus_case, "the_focus_paths_ran");

  // ---- a native provider that answers a few requests and then stops: the call that is held up is not
  // the first one, so the calls after it are the ones that must not be made
  bool provider_held_up = false;
  for (int answers : {0, 1, 2, 3, 5}) {
    RECT window_rect{};
    GetWindowRect(provider, &window_rect);
    const POINT inside{(window_rect.left + window_rect.right) / 2, (window_rect.top + window_rect.bottom) / 2};
    SeamCheck(over(inside, provider), "the_point_is_over_the_provider_window");
    WindowsUiaRisk risk;
    std::string signature;
    const long long ms = WhileStuck(provider, WM_APP + 2, static_cast<WPARAM>(answers), [&] {
      risk = ClassifyWindowsPoint(inside, static_cast<std::uint32_t>(pid), &signature);
    });
    std::string reason;
    const bool held = ms >= kHeldUp;
    provider_held_up = provider_held_up || held;
    cases.push_back({"ClassifyWindowsPoint@provider-answers-" + std::to_string(answers), ms, held ? RejectWindowsRisk(risk, &reason) : true, false});
    g_provider_stall_after.store(-1);
  }
  {
    std::string baseline_tree;
    std::size_t baseline_nodes = 0;
    g_provider_stall_after.store(-1);
    const bool baseline = ReadUiaObservation(static_cast<std::uint32_t>(pid), provider, &baseline_tree, &baseline_nodes);
    std::cout << "provider_baseline_observation=" << baseline << " nodes=" << baseline_nodes << std::endl;
  }
  for (int answers : {0, 2, 6}) {
    std::string out;
    std::size_t count = 0;
    bool ok = true;
    const long long ms = WhileStuck(provider, WM_APP + 2, static_cast<WPARAM>(answers), [&] {
      ok = ReadUiaObservation(static_cast<std::uint32_t>(pid), provider, &out, &count);
    });
    cases.push_back({"ReadUiaObservation@provider-answers-" + std::to_string(answers), ms, ms < kHeldUp ? true : !ok, false});
  }
  SeamCheck(provider_held_up, "the_provider_stopped_answering_in_at_least_one_case");

  for (const Case &c : cases) {
    std::cout << "ran " << c.name << " ms=" << c.elapsed << " failed_closed=" << c.failed_closed << std::endl;
    SeamCheck(c.elapsed <= kBound, c.name + "_returns_within_one_timeout_and_a_margin");
    if (c.required_held_up) SeamCheck(c.elapsed >= kHeldUp, c.name + "_was_really_held_up");
    SeamCheck(c.failed_closed, c.name + "_fails_closed");
  }

  TerminateProcess(child.hProcess, 0);
  CloseHandle(child.hProcess);
  CloseHandle(child.hThread);
  std::cout << (failures == 0 ? "OK" : "FAILED") << std::endl;
  return failures == 0 ? 0 : 1;
}

}  // namespace sc820

int main(int argc, char **argv) {
  const std::string mode = argc > 1 ? argv[1] : "";
  if (mode == "window-process") return sc820::RunWindowProcess();
  return sc820::RunDriver(mode == "ci");
}
`;

const onWindows = process.platform === 'win32';

type Context = { scratch: string; source: string; binary: string; compiler: Build | null };
let context: Context | null = null;

// Nothing is created, searched for or compiled off Windows. On Windows without a compiler the test is
// skipped, except in CI, where a runner that cannot compile must fail loudly, not pass silently. The
// scratch directory is made when the tests start and removed when they end, whatever happened.
beforeAll(() => {
  if (!onWindows) return;
  const scratch = mkdtempSync(join(tmpdir(), 'computer-use-v1-uia-timeout-live-seam-'));
  const source = join(scratch, 'seam.cc');
  const binary = join(scratch, 'seam.exe');
  const provenance = join(scratch, 'provenance.h');
  writeFileSync(
    provenance,
    '#pragma once\n#define SPRINT_CODER_SOURCE_COMMIT "0123456789abcdef0123456789abcdef01234567"\n',
  );
  context = { scratch, source, binary, compiler: findBuild(source, binary, provenance) };
});

afterAll(() => {
  if (context !== null) rmSync(context.scratch, { recursive: true, force: true });
  context = null;
});

describe('V1 lane UI Automation against windows that do not answer, live, across processes (#820)', () => {
  it('comes back within one timeout and fails closed on every V1 path', async (testContext) => {
    if (!onWindows || (context?.compiler === null && !process.env['CI'])) {
      testContext.skip();
      return;
    }
    expect(context, 'a Windows build context').not.toBeNull();
    const build = context!;
    expect(build.compiler, 'cl.exe (MSVC) is required on a Windows CI runner').not.toBeNull();
    writeFileSync(build.source, program);
    const compiler = build.compiler!;
    const built = await run(compiler.file, compiler.args, {
      cwd: build.scratch,
      windowsVerbatimArguments: compiler.verbatim,
      timeout: 280_000,
      env: { ...process.env, VSLANG: '1033' },
    });
    expect(built.status, `${compiler.name}\n${built.stdout}\n${built.stderr}`).toBe(0);
    const result = await run(build.binary, process.env['CI'] ? ['ci'] : [], { timeout: 200_000 });
    console.log(result.stdout);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('OK');
    // The six V1 paths all ran (the focus ones only when the window could be made the foreground one:
    // always required in CI, where the program itself fails without them).
    const ran = new Set(
      [...result.stdout.matchAll(/^ran (\w+)(?:@[\w-]+)? /gmu)].map((match) => match[1]),
    );
    const required = process.env['CI'] ? sixPaths : sixPaths.slice(0, 4);
    for (const path of required) expect(ran.has(path), `${path} ran`).toBe(true);
    expect(result.stdout).toMatch(/first_call_ok=1/u);
  }, 480_000);
});
