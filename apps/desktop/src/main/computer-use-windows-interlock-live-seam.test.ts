import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// A LIVE seam for the Windows synchronous interlock entry (classifier v2, S5-c-2 PR-1). The two
// blocks of computer_use_windows_host.cc that matter (the point mapping and the entry, each between
// its BEGIN/END markers) are cut out as they are and compiled with stubs for the host's session,
// cancellation epoch and JSON helpers only; everything else is real: the worker thread in its
// multithreaded apartment, the UI Automation source with its timeouts, the reader and gate, and the
// interlock map. It runs against windows the program creates itself and checks that a window of the
// console class is refused as a shell surface, that a window that does not answer holds the lane at
// most 500 ms (+ a margin) and a second evaluation right after is refused at once (single-flight),
// that a cancel before the start creates no UI Automation object, and that an ordinary window is not
// refused. Windows only: elsewhere, or where no MSVC can be found, it is skipped (but never in CI,
// where a runner that cannot compile must not turn this into a silent pass). The build output goes
// to a temporary directory and has no .pdb.

const nativeDirectory = join(__dirname, '../../computer-use-native');
const hostSource = readFileSync(join(nativeDirectory, 'computer_use_windows_host.cc'), 'utf8');

function block(name: string): string {
  const begin = hostSource.indexOf(`// BEGIN ${name}`);
  const end = hostSource.indexOf(`// END ${name}`);
  if (begin < 0 || end <= begin) throw new Error(`Marker "${name}" changed`);
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
    '/DEBUG:NONE',
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
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <iostream>
#include <memory>
#include <mutex>
#include <string>
#include <string_view>
#include <thread>

// Counts the UI Automation objects created, so a canceled evaluation can be shown to create none.
static std::atomic<int> g_uia_created{0};
static HRESULT CountingCoCreateInstance(REFCLSID clsid, LPUNKNOWN outer, DWORD context, REFIID iid, LPVOID *out) {
  if (IsEqualCLSID(clsid, CLSID_CUIAutomation8)) ++g_uia_created;
  return (::CoCreateInstance)(clsid, outer, context, iid, out);
}
#define CoCreateInstance CountingCoCreateInstance

#include "computer_use_windows_uia_source.h"
#include "computer_use_windows_interlock_capture.h"

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

// Stands in for the capture's evaluation to stall the worker by a chosen time (the real call is still
// made): a real window that does not answer is cut off by UI Automation's own timeout and the gate
// (~265 ms measured) before the lane's 500 ms ever matters, so the lane's own cut-off and the
// single-flight need a worker that really is stuck.
std::atomic<int> g_stall_ms{0};
sprint_coder::computer_use::InterlockEvaluation StallingEvaluate(
    sprint_coder::computer_use::ShadowUiaSource &source, std::string_view kind, std::string_view target_id,
    const sprint_coder::computer_use::ShadowRequestInfo &info, const sprint_coder::computer_use::EffectRuleset &rules) {
  const int stall = g_stall_ms.load();
  if (stall > 0) Sleep(stall);
  return sprint_coder::computer_use::EvaluateWindowsInterlockOnSource(source, kind, target_id, info, rules);
}
#define EvaluateWindowsInterlockOnSource StallingEvaluate

//@@POINT@@

//@@ENTRY@@

} // namespace

using namespace sprint_coder::computer_use;

int failures = 0;
void Check(bool ok, const char *name) {
  if (!ok) {
    ++failures;
    std::cout << "FAIL " << name << "\n";
  }
}

std::atomic<bool> g_hang_armed{false};

LRESULT CALLBACK Proc(HWND window, UINT message, WPARAM w, LPARAM l) {
  if (message == WM_APP + 1) {
    Sleep(3000);  // a window that does not answer: its thread is busy and pumps nothing
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

// A top-level window of its own class and thread, so a window that stops answering stops only itself.
void MakeWindow(Win &win, const wchar_t *class_name, const wchar_t *title, int x) {
  std::atomic<bool> ready{false};
  win.thread = std::thread([&win, &ready, class_name, title, x]() {
    WNDCLASSW cls{};
    cls.lpfnWndProc = Proc;
    cls.hInstance = GetModuleHandleW(nullptr);
    cls.lpszClassName = class_name;
    RegisterClassW(&cls);
    win.handle = CreateWindowExW(WS_EX_TOPMOST, class_name, title, WS_OVERLAPPEDWINDOW | WS_VISIBLE, x, 120,
                                 360, 240, nullptr, nullptr, cls.hInstance, nullptr);
    ShowWindow(win.handle, SW_SHOWNA);
    ready.store(true);
    MSG message;
    while (GetMessageW(&message, nullptr, 0, 0) > 0) {
      TranslateMessage(&message);
      DispatchMessageW(&message);
    }
  });
  for (int i = 0; i < 500 && !ready.load(); ++i) Sleep(10);
}

WindowsSession SessionFor(HWND window) {
  WindowsSession session;
  GetWindowRect(window, &session.observation_bounds);
  session.active_window = window;
  session.cancel_epoch = cancellation_epoch.load();
  return session;
}

const std::string kClick = "{\"type\":\"click\",\"x\":0.5,\"y\":0.5}";

long long Millis(std::chrono::steady_clock::time_point since) {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - since).count();
}

bool WaitIdle(int limit_ms) {
  for (int i = 0; i < limit_ms / 10 && InterlockWorkerRunning().load(); ++i) Sleep(10);
  return !InterlockWorkerRunning().load();
}

int main() {
  Win ordinary, console, hang;
  MakeWindow(ordinary, L"Sc500InterlockOrdinary", L"sc500-ordinary", 40);
  MakeWindow(console, L"ConsoleWindowClass", L"sc500-console", 440);
  MakeWindow(hang, L"Sc500InterlockHang", L"sc500-hang", 840);
  Check(ordinary.handle && console.handle && hang.handle, "windows_created");
  if (!ordinary.handle || !console.handle || !hang.handle) return 2;
  Sleep(400);
  const EffectRuleset ruleset;

  // Warm UI Automation up in this process (its first use loads providers), so a cold start is not
  // mistaken for a hung window. Whether it can read our windows at all is asked of the ordinary one.
  InterlockEvaluation warm;
  for (int i = 0; i < 3; ++i) {
    warm = EvaluateWindowsInterlockOnLane(SessionFor(ordinary.handle), kClick, "click", ruleset);
    if (warm.no_verdict != InterlockNoVerdict::kBudget) break;
    WaitIdle(2000);
  }
  const bool readable = warm.no_verdict == InterlockNoVerdict::kNone || warm.no_verdict == InterlockNoVerdict::kIncomplete
                        ? warm.no_verdict == InterlockNoVerdict::kNone
                        : false;
  std::cout << "warm no_verdict=" << static_cast<int>(warm.no_verdict) << " readable=" << readable << "\n";

  // 5. An ordinary window is not refused (whatever else the answer is).
  {
    const InterlockEvaluation answer = EvaluateWindowsInterlockOnLane(SessionFor(ordinary.handle), kClick, "click", ruleset);
    Check(!answer.Refuses(), "an_ordinary_window_is_not_refused");
    Check(WaitIdle(2000), "the_worker_ends_after_an_ordinary_evaluation");
  }

  // 1. A window of the console class is blocked as a shell surface.
  {
    InterlockEvaluation answer;
    for (int i = 0; i < 3; ++i) {
      answer = EvaluateWindowsInterlockOnLane(SessionFor(console.handle), kClick, "click", ruleset);
      WaitIdle(2000);
      if (answer.Refuses()) break;
    }
    std::cout << "console outcome=" << static_cast<int>(answer.verdict.outcome) << " reason=" << static_cast<int>(answer.verdict.reason)
              << " no_verdict=" << static_cast<int>(answer.no_verdict) << "\n";
    if (readable) {
      Check(answer.Refuses(), "a_console_class_window_is_refused");
      Check(answer.verdict.outcome == InterlockOutcome::kBlocked, "the_console_class_window_is_blocked");
      Check(answer.verdict.reason == InterlockReason::kShellSurface, "the_reason_is_a_shell_surface");
    }
  }

  // 4. Canceled before the start: kCanceled, and no UI Automation object is created.
  {
    WaitIdle(2000);
    WindowsSession session = SessionFor(ordinary.handle);
    cancellation_epoch.store(session.cancel_epoch + 1);
    const int created_before = g_uia_created.load();
    const auto start = std::chrono::steady_clock::now();
    const InterlockEvaluation answer = EvaluateWindowsInterlockOnLane(session, kClick, "click", ruleset);
    Check(answer.no_verdict == InterlockNoVerdict::kCanceled && !answer.Refuses(), "canceled_before_the_start_is_kCanceled");
    Check(g_uia_created.load() == created_before, "a_canceled_evaluation_creates_no_uia_object");
    Check(!InterlockWorkerRunning().load(), "a_canceled_evaluation_starts_no_worker");
    Check(Millis(start) < 100, "a_canceled_evaluation_returns_at_once");
    cancellation_epoch.store(session.cancel_epoch);
  }

  // 2. A real window that does not answer is cut off (UI Automation's timeout and the gate) well
  // inside the lane's bound: kBudget, and not a refusal.
  if (readable) {
    PostMessageW(hang.handle, WM_APP + 1, 0, 0);
    Sleep(60);
    const auto start = std::chrono::steady_clock::now();
    const InterlockEvaluation first = EvaluateWindowsInterlockOnLane(SessionFor(hang.handle), kClick, "click", ruleset);
    const long long first_ms = Millis(start);
    std::cout << "hang window no_verdict=" << static_cast<int>(first.no_verdict) << " ms=" << first_ms << "\n";
    Check(first.no_verdict == InterlockNoVerdict::kBudget && !first.Refuses(), "an_unanswering_window_is_kBudget");
    Check(first_ms <= 500 + 250, "an_unanswering_window_holds_the_lane_at_most_500ms_plus_a_margin");
    Check(WaitIdle(15000), "the_hung_window_worker_ends");
  }

  // 2b. A worker that is stuck past the lane's bound: the lane stops waiting at 500 ms (kBudget).
  // 3. A second evaluation right after is refused at once: one worker at a time (single-flight).
  {
    g_stall_ms.store(1500);
    const WindowsSession session = SessionFor(ordinary.handle);
    const auto start = std::chrono::steady_clock::now();
    const InterlockEvaluation first = EvaluateWindowsInterlockOnLane(session, kClick, "click", ruleset);
    const long long first_ms = Millis(start);
    std::cout << "stalled first no_verdict=" << static_cast<int>(first.no_verdict) << " ms=" << first_ms << "\n";
    Check(first.no_verdict == InterlockNoVerdict::kBudget && !first.Refuses(), "a_stuck_worker_is_kBudget");
    Check(first_ms >= 450 && first_ms <= 500 + 250, "the_lane_waits_500ms_for_a_stuck_worker_and_no_longer");
    const auto second_start = std::chrono::steady_clock::now();
    const InterlockEvaluation second = EvaluateWindowsInterlockOnLane(session, kClick, "click", ruleset);
    const long long second_ms = Millis(second_start);
    std::cout << "stalled second no_verdict=" << static_cast<int>(second.no_verdict) << " ms=" << second_ms << "\n";
    Check(second.no_verdict == InterlockNoVerdict::kBudget && !second.Refuses(), "the_second_evaluation_is_kBudget");
    Check(second_ms < 100, "the_second_evaluation_is_refused_at_once");
    // The stuck worker ends, and the next evaluation runs.
    g_stall_ms.store(0);
    Check(WaitIdle(15000), "the_stuck_worker_ends");
    const InterlockEvaluation after = EvaluateWindowsInterlockOnLane(SessionFor(ordinary.handle), kClick, "click", ruleset);
    Check(after.no_verdict == InterlockNoVerdict::kNone && !after.Refuses(), "an_evaluation_after_the_worker_ended_runs");
    WaitIdle(2000);
  }

  // The action is canceled while the worker reads: kCanceled, whatever it found.
  {
    g_stall_ms.store(200);
    const WindowsSession session = SessionFor(ordinary.handle);
    std::thread mover([&session]() {
      Sleep(80);
      cancellation_epoch.store(session.cancel_epoch + 1);
    });
    const InterlockEvaluation answer = EvaluateWindowsInterlockOnLane(session, kClick, "click", ruleset);
    mover.join();
    Check(answer.no_verdict == InterlockNoVerdict::kCanceled && !answer.Refuses(), "canceled_while_the_worker_reads_is_kCanceled");
    cancellation_epoch.store(session.cancel_epoch);
    g_stall_ms.store(0);
    WaitIdle(2000);
  }

  WaitIdle(15000);
  for (Win *win : {&ordinary, &console, &hang}) {
    PostMessageW(win->handle, WM_CLOSE, 0, 0);
    DestroyWindow(win->handle);
  }
  for (Win *win : {&ordinary, &console, &hang}) win->thread.join();
  std::cout << (failures == 0 ? "OK\n" : "FAILED\n");
  return failures == 0 ? 0 : 1;
}
`;

// Nothing is created, searched for or compiled off Windows. On Windows without a compiler the test is
// skipped, except in CI, where a runner that cannot compile must fail loudly, not pass silently.
const onWindows = process.platform === 'win32';
const build = (() => {
  if (!onWindows) return null;
  const scratch = mkdtempSync(join(tmpdir(), 'computer-use-interlock-live-seam-'));
  const source = join(scratch, 'seam.cc');
  const binary = join(scratch, 'seam.exe');
  return { scratch, source, binary, compiler: findBuild(source, binary) };
})();

describe.skipIf(!onWindows || (build?.compiler === null && !process.env['CI']))(
  'Windows synchronous interlock entry, live against UI Automation (S5-c-2 PR-1)',
  () => {
    it('refuses a console class window, bounds the lane at 500 ms, and starts one worker at a time', () => {
      expect(build, 'a Windows build context').not.toBeNull();
      const context = build!;
      try {
        expect(context.compiler, 'cl.exe (MSVC) is required on a Windows CI runner').not.toBeNull();
        writeFileSync(
          context.source,
          program
            .replace('//@@POINT@@', block('windows action point'))
            .replace('//@@ENTRY@@', block('sync interlock entry')),
        );
        const compiler = context.compiler!;
        const built = spawnSync(compiler.file, compiler.args, {
          encoding: 'utf8',
          cwd: context.scratch,
          windowsVerbatimArguments: compiler.verbatim,
          timeout: 180_000,
          env: { ...process.env, VSLANG: '1033' },
        });
        expect(built.status, `${compiler.name}\n${built.stdout}\n${built.stderr}`).toBe(0);
        const run = spawnSync(context.binary, [], { encoding: 'utf8', timeout: 90_000 });
        console.log(run.stdout);
        expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
        expect(run.stdout).toContain('OK');
      } finally {
        rmSync(context.scratch, { recursive: true, force: true });
      }
    }, 300_000);
  },
);
