import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// A LIVE seam for the Windows shadow wiring (classifier v2, S5-b-2b/2c). The wiring block of
// computer_use_windows_host.cc (between its BEGIN/END markers) is cut out as it is and compiled with
// stubs for the host's session and JSON helpers only; everything else is real: the scheduler, the
// launcher thread with its COM apartment, the UI Automation source and the reader. It runs against a
// window the program creates itself, and checks that a capture is handed over without blocking, that
// a record appears, that the deterministic skipped records (V1 invalid, canceled, no point) are exact,
// and that the process survives. Windows only: elsewhere, or where no MSVC can be found, it is
// skipped (but never in CI, where a runner that cannot compile must not turn this into a silent pass).

const nativeDirectory = join(__dirname, '../../computer-use-native');
const hostSource = readFileSync(join(nativeDirectory, 'computer_use_windows_host.cc'), 'utf8');

function wiringBlock(): string {
  const begin = hostSource.indexOf('// BEGIN effect shadow wiring');
  const end = hostSource.indexOf('// END effect shadow wiring');
  if (begin < 0 || end <= begin) throw new Error('Shadow wiring markers changed');
  return hostSource.slice(begin, end);
}

const vswhere = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';
const libraries = [
  'ole32.lib',
  'oleaut32.lib',
  'uiautomationcore.lib',
  'user32.lib',
  'uuid.lib',
  'shell32.lib',
];

function compileArguments(path: string, output: string): string[] {
  return [
    '/nologo',
    '/std:c++20',
    '/EHsc',
    '/W4',
    '/permissive-',
    '/utf-8',
    '/DUNICODE',
    '/D_UNICODE',
    '/DNOMINMAX',
    '/D_WIN32_WINNT=0x0A00',
    `/I${nativeDirectory}`,
    path,
    `/Fe:${output}`,
    `/Fo:${output}.obj`,
    '/link',
    ...libraries,
  ];
}

type Build = Readonly<{ name: string; file: string; args: string[]; verbatim: boolean }>;

function findBuild(path: string, output: string): Build | null {
  if (process.platform !== 'win32') return null;
  if (spawnSync('cl.exe', ['/?'], { stdio: 'ignore' }).status === 0)
    return {
      name: 'cl.exe',
      file: 'cl.exe',
      args: compileArguments(path, output),
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
      `"call "${vcvars}" >nul && cl.exe ${compileArguments(path, output)
        .map((argument) => `"${argument}"`)
        .join(' ')}"`,
    ],
    verbatim: true,
  };
}

const program = String.raw`
#include <windows.h>
#include <ole2.h>
#include <UIAutomation.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <functional>
#include <iostream>
#include <memory>
#include <string>
#include <string_view>
#include <thread>

#include "computer_use_windows_uia_source.h"
#include "computer_use_windows_shadow_scheduler.h"

namespace {

std::atomic<std::uint64_t> cancellation_epoch{0};

struct WindowsSession {
  std::string maximum_mode = "full_access_app";
  std::string policy_language = "en";
  RECT observation_bounds{};
  HWND active_window = nullptr;
  std::uint64_t cancel_epoch = 0;
};

bool ReadJsonString(std::string_view json, std::string_view key, std::string *output) {
  const std::string needle = "\"" + std::string(key) + "\":\"";
  const std::size_t at = json.find(needle);
  if (at == std::string_view::npos) return false;
  const std::size_t begin = at + needle.size();
  const std::size_t end = json.find('"', begin);
  if (end == std::string_view::npos) return false;
  *output = std::string(json.substr(begin, end - begin));
  return true;
}

bool ReadJsonDouble(std::string_view json, std::string_view key, double *output) {
  const std::string needle = "\"" + std::string(key) + "\":";
  const std::size_t at = json.find(needle);
  if (at == std::string_view::npos) return false;
  *output = std::stod(std::string(json.substr(at + needle.size())));
  return true;
}

// The click rule (the host, #500 S5-c-2 PR-2) is its own contract; here a click never opens.
bool WindowsClickOpens(POINT) noexcept { return false; }

//@@BLOCK@@

} // namespace

using namespace sprint_coder::computer_use;

int failures = 0;
void Check(bool ok, const char *name) {
  if (!ok) {
    ++failures;
    std::cout << "FAIL " << name << "\n";
  }
}

HWND g_top = nullptr;
HWND g_edit = nullptr;

LRESULT CALLBACK Proc(HWND window, UINT message, WPARAM w, LPARAM l) {
  if (message == WM_DESTROY) {
    PostQuitMessage(0);
    return 0;
  }
  return DefWindowProcW(window, message, w, l);
}

void WindowThread() {
  WNDCLASSW cls{};
  cls.lpfnWndProc = Proc;
  cls.hInstance = GetModuleHandleW(nullptr);
  cls.lpszClassName = L"Sc500ShadowLiveSeam";
  RegisterClassW(&cls);
  g_top = CreateWindowExW(WS_EX_TOPMOST, cls.lpszClassName, L"sc500-live-seam", WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                          120, 120, 420, 240, nullptr, nullptr, cls.hInstance, nullptr);
  g_edit = CreateWindowExW(0, L"EDIT", L"", WS_CHILD | WS_VISIBLE | WS_BORDER, 20, 20, 300, 28, g_top,
                           nullptr, cls.hInstance, nullptr);
  ShowWindow(g_top, SW_SHOWNA);
  MSG message;
  while (GetMessageW(&message, nullptr, 0, 0) > 0) {
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }
}

bool WaitFor(std::uint64_t total) {
  for (int i = 0; i < 1000 && ProcessShadowLog().Total() < total; ++i) Sleep(10);
  return ProcessShadowLog().Total() >= total;
}

ShadowRecord Last() { return ProcessShadowLog().Snapshot().back(); }

// Can UI Automation read OUR window from this session at all? A hosted runner may run without an
// interactive desktop, where it cannot. The probe asks the same questions the source asks (the
// CUIAutomation8 object with its timeouts, the window by handle, the element at a point), prints
// each answer, and warms UI Automation up in this process (its first use loads providers).
bool ProbeUia(HWND top, POINT inside) {
  const HRESULT initialized = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  bool ok = false;
  IUIAutomation *automation = nullptr;
  HRESULT hr = CoCreateInstance(CLSID_CUIAutomation8, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&automation));
  std::cout << "probe create8 hr=" << std::hex << hr << std::dec << "\n";
  if (SUCCEEDED(hr) && automation) {
    IUIAutomation2 *second = nullptr;
    hr = automation->QueryInterface(IID_PPV_ARGS(&second));
    std::cout << "probe qi2 hr=" << std::hex << hr << std::dec << "\n";
    bool timeouts = false;
    if (SUCCEEDED(hr) && second) {
      timeouts = SUCCEEDED(second->put_ConnectionTimeout(1500)) && SUCCEEDED(second->put_TransactionTimeout(1500));
      second->Release();
    }
    std::cout << "probe timeouts=" << timeouts << "\n";
    IUIAutomationElement *element = nullptr;
    hr = automation->ElementFromHandle(top, &element);
    std::cout << "probe from_handle hr=" << std::hex << hr << std::dec << " element=" << (element != nullptr) << "\n";
    bool named = false;
    if (SUCCEEDED(hr) && element) {
      BSTR name = nullptr;
      named = SUCCEEDED(element->get_CurrentClassName(&name)) && name != nullptr && SysStringLen(name) > 0;
      if (name) SysFreeString(name);
      element->Release();
    }
    std::cout << "probe class_name_read=" << named << "\n";
    IUIAutomationElement *at_point = nullptr;
    hr = automation->ElementFromPoint(inside, &at_point);
    std::cout << "probe from_point hr=" << std::hex << hr << std::dec << " element=" << (at_point != nullptr) << "\n";
    const bool pointed = SUCCEEDED(hr) && at_point != nullptr;
    if (at_point) at_point->Release();
    ok = timeouts && named && pointed;
    automation->Release();
  }
  if (SUCCEEDED(initialized)) CoUninitialize();
  std::cout << "probe ok=" << ok << "\n";
  return ok;
}

int main() {
  std::thread window_thread(WindowThread);
  for (int i = 0; i < 500 && (g_top == nullptr || g_edit == nullptr); ++i) Sleep(10);
  Check(g_top != nullptr && g_edit != nullptr, "window_created");
  if (g_top == nullptr || g_edit == nullptr) return 2;
  Sleep(300);

  WindowsSession session;
  GetWindowRect(g_top, &session.observation_bounds);
  session.active_window = g_top;
  RECT edit{};
  GetWindowRect(g_edit, &edit);
  const double width = static_cast<double>(session.observation_bounds.right - session.observation_bounds.left - 1);
  const double height = static_cast<double>(session.observation_bounds.bottom - session.observation_bounds.top - 1);
  const double x = ((edit.left + edit.right) / 2.0 - session.observation_bounds.left) / width;
  const double y = ((edit.top + edit.bottom) / 2.0 - session.observation_bounds.top) / height;
  const std::string click = "{\"type\":\"click\",\"x\":" + std::to_string(x) + ",\"y\":" + std::to_string(y) + "}";

  POINT inside{(edit.left + edit.right) / 2, (edit.top + edit.bottom) / 2};
  const bool readable = ProbeUia(g_top, inside);

  // A real capture: handed over without blocking the caller, and recorded once, with the V1 verdict.
  const auto start = std::chrono::steady_clock::now();
  ScheduleWindowsEffectShadow(session, click, "click", true, true);
  const auto caller_ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - start).count();
  Check(caller_ms < 500, "schedule_returns_without_waiting_for_the_capture");
  Check(WaitFor(1), "a_record_appears");
  Sleep(200);  // the slot is freed just after the record is kept
  if (ProcessShadowLog().Total() >= 1) {
    const ShadowRecord record = ProcessShadowLog().Snapshot().front();
    Check(record.v1_ordinary, "record_carries_the_v1_verdict");
    Check((record.gaps & (kShadowGapV1Invalid | kShadowGapBusy)) == 0, "the_capture_ran");
    std::cout << "first capture gaps=" << record.gaps << " class=" << static_cast<unsigned>(record.effect_class)
              << " kind=" << static_cast<unsigned>(record.kind) << "\n";
    const bool out_of_budget = (record.gaps & kShadowGapBudget) != 0;
    if (readable && !out_of_budget) {
      // UI Automation reads this window here, and the capture had its budget: it must read without a failure.
      Check((record.gaps & kShadowGapReadFailed) == 0, "the_capture_read_without_failure");
    } else {
      // Where UI Automation cannot read our window, or the budget ran out (a cold first use on a slow
      // runner), the safe side is the only acceptable outcome: a gap, never an ordinary decision.
      Check(record.kind != DecisionKind::kOrdinary && record.gaps != 0, "an_unreadable_capture_is_never_ordinary");
    }
  }

  // V1 could not re-validate: exactly one skipped record, nothing read.
  ScheduleWindowsEffectShadow(session, click, "click", false, false);
  Check(WaitFor(2) && Last().gaps == kShadowGapV1Invalid && !Last().v1_ordinary, "v1_invalid_is_skipped");

  // The cancellation epoch moved before the capture started: exactly one skipped record.
  cancellation_epoch.store(5);
  ScheduleWindowsEffectShadow(session, click, "click", true, true);
  Check(WaitFor(3) && Last().gaps == kShadowGapCanceled, "canceled_before_start_is_skipped");
  Sleep(200);
  cancellation_epoch.store(0);

  // A click without a usable point is not looked up at the screen's origin.
  ScheduleWindowsEffectShadow(session, "{\"type\":\"click\"}", "click", true, true);
  Check(WaitFor(4) && Last().gaps == kShadowGapReadFailed, "click_without_a_point_is_skipped");

  // A type reads the focused element; whatever it finds, the process survives and one record is kept.
  ScheduleWindowsEffectShadow(session, "{\"type\":\"type\"}", "type", true, true);
  Check(WaitFor(5), "type_is_recorded");

  PostMessageW(g_top, WM_CLOSE, 0, 0);
  DestroyWindow(g_top);
  window_thread.join();
  std::cout << (failures == 0 ? "OK\n" : "FAILED\n");
  return failures == 0 ? 0 : 1;
}
`;

// Nothing is created, searched for or compiled off Windows. On Windows without a compiler the test is
// skipped, except in CI, where a runner that cannot compile must fail loudly, not pass silently.
const onWindows = process.platform === 'win32';
const build = (() => {
  if (!onWindows) return null;
  const scratch = mkdtempSync(join(tmpdir(), 'computer-use-shadow-live-seam-'));
  const source = join(scratch, 'seam.cc');
  const binary = join(scratch, 'seam.exe');
  return { scratch, source, binary, compiler: findBuild(source, binary) };
})();

describe.skipIf(!onWindows || (build?.compiler === null && !process.env['CI']))(
  'Windows shadow wiring, live against UI Automation (S5-b-2)',
  () => {
    it('hands a capture over, records exactly, and the process survives', () => {
      expect(build, 'a Windows build context').not.toBeNull();
      const context = build!;
      try {
        expect(context.compiler, 'cl.exe (MSVC) is required on a Windows CI runner').not.toBeNull();
        writeFileSync(context.source, program.replace('//@@BLOCK@@', wiringBlock()));
        const compiler = context.compiler!;
        const built = spawnSync(compiler.file, compiler.args, {
          encoding: 'utf8',
          windowsVerbatimArguments: compiler.verbatim,
          timeout: 180_000,
          env: { ...process.env, VSLANG: '1033' },
        });
        expect(built.status, `${compiler.name}\n${built.stdout}\n${built.stderr}`).toBe(0);
        const run = spawnSync(context.binary, [], { encoding: 'utf8', timeout: 60_000 });
        // The probe lines say why a capture could not read, which differs per runner.
        console.log(run.stdout);
        expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
        expect(run.stdout).toContain('OK');
      } finally {
        rmSync(context.scratch, { recursive: true, force: true });
      }
    }, 300_000);
  },
);
