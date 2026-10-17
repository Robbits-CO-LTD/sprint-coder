import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Contracts and a LIVE seam for the bound on the UI Automation calls of the V1 lane (#820). Without a
// timeout, a target that does not answer holds the serial lane for good: every later frame waits behind
// it. The V1 lane creates its UI Automation in ONE place (CreateWindowsV1Automation), which sets the
// ConnectionTimeout / TransactionTimeout of IUIAutomation2 (kWindowsV1UiaTimeoutMs).
//
// The live seam compiles the real host (computer_use_windows_host.cc, with its entry point renamed) into a
// test program, makes windows of its own (one of them stops answering for a few seconds), and calls the
// V1 paths against the hung window: the point and focus classification, the observation, the control
// bindings, the semantic target search and the focused-element signature that the re-validation uses.
// Each must come back within the bound plus a margin, and fail closed. Windows only: elsewhere, or where
// no MSVC can be found, it is skipped (but never in CI, where a runner that cannot compile must not turn
// this into a silent pass). The build output goes to a temporary directory.

const nativeDirectory = join(__dirname, '../../computer-use-native');
const host = readFileSync(join(nativeDirectory, 'computer_use_windows_host.cc'), 'utf8');
const uiaSource = readFileSync(join(nativeDirectory, 'computer_use_windows_uia_source.h'), 'utf8');

/** The code of a file without its line comments. */
const code = (text: string): string => text.replace(/\/\/.*$/gmu, '');

describe('V1 lane UI Automation is created in one place, with its call timeouts (#820)', () => {
  it('creates UI Automation only in CreateWindowsV1Automation (and CreateBoundedAutomation)', () => {
    // The host: exactly one coclass creation, and it is the fallback inside the one helper.
    const creations = [...code(host).matchAll(/CLSID_CUIAutomation(?!8)/gu)];
    expect(creations).toHaveLength(1);
    const helper = host.slice(
      host.indexOf('HRESULT CreateWindowsV1Automation('),
      host.indexOf('bool HasUiAutomation() {'),
    );
    expect(helper).toContain('CLSID_CUIAutomation, nullptr, CLSCTX_INPROC_SERVER');
    // Every other use goes through the helper.
    const callers = [...code(host).matchAll(/CreateWindowsV1Automation\(&automation\)/gu)];
    expect(callers.length).toBeGreaterThanOrEqual(8);
    expect(code(host)).not.toMatch(
      /CoCreateInstance\(\s*CLSID_CUIAutomation(?!8)(?![\s\S]{0,80}IID_PPV_ARGS\(automation\))/u,
    );
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
    expect(compact).toContain('bounded->put_ConnectionTimeout(timeout_ms)');
    expect(compact).toContain('bounded->put_TransactionTimeout(timeout_ms)');
    // Without the interface or either timeout, no automation is handed out.
    expect(compact).toContain('if (!set) { created->Release(); return false; }');
    const helper = host.slice(
      host.indexOf('// The bound of ONE UI Automation call'),
      host.indexOf('bool HasUiAutomation() {'),
    );
    const helperCompact = helper.replace(/\s+/gu, ' ');
    expect(helperCompact).toContain('constexpr DWORD kWindowsV1UiaTimeoutMs = 500;');
    expect(helperCompact).toContain('CreateBoundedAutomation( kWindowsV1UiaTimeoutMs, automation)');
    // The fallback is the plain coclass (as before), counted and logged once, never silent.
    expect(helperCompact).toContain('windows_v1_uia_unbounded_creations.fetch_add(1) == 0');
    expect(helperCompact).toContain('OutputDebugStringA(');
    // The bound is shorter than what the lane's other clocks allow: two calls fit in the Cancel
    // acknowledgment (1 s), and it is stated where it is set.
    expect(500 * 2).toBeLessThanOrEqual(1000);
    expect(helper).toContain('COMPUTER_USE_NATIVE_CANCEL_ACK_TIMEOUT_MS');
    // The shadow source uses the same creation, with its own (longer) bound.
    expect(uiaSource.replace(/\s+/gu, ' ')).toContain(
      'windows_uia_source_detail::CreateBoundedAutomation(timeout_ms, automation.Receive())',
    );
  });

  it('turns a failed read into the "unreadable" of each caller (fail closed)', () => {
    // A call that times out returns a failed HRESULT, and every V1 caller already ends there:
    //  - the point / focus classification returns an unclassified risk, which RejectWindowsRisk rejects;
    //  - the observation, the control bindings and the focused-element signature return false;
    //  - the semantic target search fails with target_required / accessibility_unavailable.
    const classify = code(host).replace(/\s+/gu, ' ');
    expect(classify).toContain(
      'const auto decision = ClassifyNativePreflightFacts( {risk.metadata_complete, risk.classified, risk.secure, risk.high_impact});',
    );
    for (const name of ['ClassifyWindowsPoint(', 'ClassifyWindowsFocusedElement(']) {
      const at = host.indexOf(`WindowsUiaRisk ${name}`);
      expect(at, name).toBeGreaterThan(0);
      const body = host.slice(at, at + 1400);
      expect(body, name).toContain('if (FAILED(found) || element == nullptr) {');
      expect(body, name).toContain('return {};');
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

namespace {

int failures = 0;
void Check(bool ok, const char *name) {
  if (!ok) {
    ++failures;
    std::cout << "FAIL " << name << "\n";
  }
}

LRESULT CALLBACK Proc(HWND window, UINT message, WPARAM w, LPARAM l) {
  if (message == WM_APP + 1) {
    Sleep(4500);  // a window that does not answer: its thread is busy and pumps nothing
    return 0;
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

void MakeWindow(Win &win, const wchar_t *class_name, const wchar_t *title, int x) {
  std::atomic<bool> ready{false};
  win.thread = std::thread([&win, &ready, class_name, title, x]() {
    WNDCLASSW cls{};
    cls.lpfnWndProc = Proc;
    cls.hInstance = GetModuleHandleW(nullptr);
    cls.lpszClassName = class_name;
    RegisterClassW(&cls);
    win.handle = CreateWindowExW(WS_EX_TOPMOST, class_name, title, WS_OVERLAPPEDWINDOW | WS_VISIBLE, x, 120, 360, 240,
                                 nullptr, nullptr, cls.hInstance, nullptr);
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

long long Millis(std::chrono::steady_clock::time_point since) {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - since).count();
}

// Makes the window stop answering, waits until it really is stuck, and runs the call.
template <class Call> long long Hung(HWND window, Call &&call) {
  PostMessageW(window, WM_APP + 1, 0, 0);
  Sleep(100);
  const auto start = std::chrono::steady_clock::now();
  call();
  const long long elapsed = Millis(start);
  Sleep(4600);  // let it wake before the next case
  return elapsed;
}

constexpr long long kBound = static_cast<long long>(kWindowsV1UiaTimeoutMs) + 500;  // the bound + a margin
constexpr long long kReallyWaited = 250;  // a call that came back sooner than this was never held up

}  // namespace

int main() {
  CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  Win ordinary, hang;
  MakeWindow(ordinary, L"Sc820V1Ordinary", L"sc820-ordinary", 40);
  MakeWindow(hang, L"Sc820V1Hang", L"sc820-hang", 440);
  Check(ordinary.handle && hang.handle, "windows_created");
  if (!ordinary.handle || !hang.handle) return 2;
  Sleep(400);
  DWORD pid = GetCurrentProcessId();

  // The helper hands out a bounded automation here (the system has IUIAutomation2).
  Check(windows_v1_uia_unbounded_creations.load() == 0, "no_unbounded_creation_so_far");

  // Warm UI Automation up on the ordinary window (the first use loads providers), and show that an
  // ordinary window is read as before.
  std::string tree;
  std::size_t nodes = 0;
  bool warm = false;
  for (int i = 0; i < 3 && !warm; ++i) warm = ReadUiaObservation(pid, ordinary.handle, &tree, &nodes);
  std::cout << "warm observation=" << warm << " nodes=" << nodes << "\n";
  Check(windows_v1_uia_unbounded_creations.load() == 0, "still_no_unbounded_creation");

  RECT rect{};
  GetWindowRect(hang.handle, &rect);
  const POINT centre{(rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2};

  struct Case {
    const char *name;
    long long elapsed;
    bool failed_closed;
  };
  std::vector<Case> cases;

  {  // the classification of a point
    WindowsUiaRisk risk;
    const long long ms = Hung(hang.handle, [&] { risk = ClassifyWindowsPoint(centre, pid); });
    std::string reason;
    cases.push_back({"ClassifyWindowsPoint", ms, RejectWindowsRisk(risk, &reason)});
  }
  {  // the observation
    std::string out;
    std::size_t count = 0;
    bool ok = true;
    const long long ms = Hung(hang.handle, [&] { ok = ReadUiaObservation(pid, hang.handle, &out, &count); });
    cases.push_back({"ReadUiaObservation", ms, !ok});
  }
  {  // the control bindings
    WindowsControlBindings bindings;
    bool ok = true;
    const long long ms = Hung(hang.handle, [&] { ok = CaptureWindowsControlBindings(pid, hang.handle, &bindings); });
    cases.push_back({"CaptureWindowsControlBindings", ms, !ok});
  }
  {  // the semantic target search
    WindowsSession session;
    session.active_window = hang.handle;
    session.pid = pid;
    IUIAutomationElement *target = nullptr;
    std::string reason;
    bool ok = true;
    const long long ms = Hung(hang.handle, [&] { ok = FindWindowsSemanticTarget(session, "x", &target, &reason); });
    if (target != nullptr) target->Release();
    cases.push_back({"FindWindowsSemanticTarget", ms, !ok});
  }
  // The focused element: only if this program can make the hung window the foreground one.
  bool focus_case = false;
  SetForegroundWindow(hang.handle);
  Sleep(300);
  if (GetForegroundWindow() == hang.handle) {
    focus_case = true;
    WindowsUiaRisk risk;
    const long long ms = Hung(hang.handle, [&] { risk = ClassifyWindowsFocusedElement(pid); });
    std::string reason;
    cases.push_back({"ClassifyWindowsFocusedElement", ms, RejectWindowsRisk(risk, &reason)});
    std::string signature;
    RECT client{};
    GetClientRect(hang.handle, &client);
    bool ok = true;
    SetForegroundWindow(hang.handle);
    const long long ms2 = Hung(hang.handle, [&] { ok = WindowsFocusedElementSignature(pid, client, &signature); });
    cases.push_back({"WindowsFocusedElementSignature", ms2, !ok});
  }
  std::cout << "focus_case=" << focus_case << "\n";

  for (const Case &c : cases) {
    std::cout << c.name << " ms=" << c.elapsed << " failed_closed=" << c.failed_closed << "\n";
    Check(c.elapsed <= kBound, (std::string(c.name) + "_returns_within_the_bound").c_str());
    Check(c.elapsed >= kReallyWaited, (std::string(c.name) + "_was_really_held_up").c_str());
    Check(c.failed_closed, (std::string(c.name) + "_fails_closed").c_str());
  }
  Check(cases.size() >= 4, "the_paths_were_run");

  // A window that answers is still read (the bound does not turn a live app into an unreadable one).
  Check(warm, "an_ordinary_window_is_still_observed");

  for (Win *win : {&ordinary, &hang}) {
    PostMessageW(win->handle, WM_CLOSE, 0, 0);
    DestroyWindow(win->handle);
  }
  for (Win *win : {&ordinary, &hang}) win->thread.join();
  std::cout << (failures == 0 ? "OK\n" : "FAILED\n");
  return failures == 0 ? 0 : 1;
}
`;

const onWindows = process.platform === 'win32';
const build = (() => {
  if (!onWindows) return null;
  const scratch = mkdtempSync(join(tmpdir(), 'computer-use-v1-uia-timeout-live-seam-'));
  const source = join(scratch, 'seam.cc');
  const binary = join(scratch, 'seam.exe');
  const provenance = join(scratch, 'provenance.h');
  writeFileSync(
    provenance,
    '#pragma once\n#define SPRINT_CODER_SOURCE_COMMIT "0123456789abcdef0123456789abcdef01234567"\n',
  );
  return { scratch, source, binary, compiler: findBuild(source, binary, provenance) };
})();

describe.skipIf(!onWindows || (build?.compiler === null && !process.env['CI']))(
  'V1 lane UI Automation against a window that does not answer, live (#820)',
  () => {
    it('comes back within the bound and fails closed on every V1 path', () => {
      expect(build, 'a Windows build context').not.toBeNull();
      const context = build!;
      try {
        expect(context.compiler, 'cl.exe (MSVC) is required on a Windows CI runner').not.toBeNull();
        writeFileSync(context.source, program);
        const compiler = context.compiler!;
        const built = spawnSync(compiler.file, compiler.args, {
          encoding: 'utf8',
          cwd: context.scratch,
          windowsVerbatimArguments: compiler.verbatim,
          timeout: 280_000,
          env: { ...process.env, VSLANG: '1033' },
        });
        expect(built.status, `${compiler.name}\n${built.stdout}\n${built.stderr}`).toBe(0);
        const run = spawnSync(context.binary, [], { encoding: 'utf8', timeout: 120_000 });
        console.log(run.stdout);
        expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
        expect(run.stdout).toContain('OK');
      } finally {
        rmSync(context.scratch, { recursive: true, force: true });
      }
    }, 480_000);
  },
);
