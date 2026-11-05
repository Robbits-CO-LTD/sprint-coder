import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findBuild } from './test-support/msvc-build';

const native = (name: string) =>
  readFileSync(join(__dirname, '../../computer-use-native', name), 'utf8');

const msvc = findBuild();
const clang =
  process.platform !== 'win32' &&
  spawnSync('clang++', ['--version'], { stdio: 'ignore' }).status === 0;

it.runIf(msvc !== null || clang)(
  'foreground_semantic_rechecks_page_before_all_five_inputs',
  () => {
    const semantic = native('computer_use_windows_host_uia_semantic.inc');
    const start = semantic.indexOf('bool WindowsSemanticPageAllowsInput(');
    const end = semantic.indexOf('bool DispatchWindowsSemanticActionOnWorker(', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const dispatch = semantic.slice(
      end,
      semantic.indexOf('bool DispatchWindowsSemanticAction(', end),
    );
    expect(dispatch.match(/if \(!WindowsSemanticPageAllowsInput\(work\)\)/gu)).toHaveLength(5);
    expect(dispatch.match(/InvokeWindowsSemanticInput\(/gu)).toHaveLength(5);
    const program = String.raw`
#include <atomic>
#include <functional>
#include <iostream>
struct Page { bool web = true; };
struct WindowsSemanticWork { Page observed_page; int window = 12, pid = 42; };
struct Pending { std::atomic<bool> page_invalidated{false}; } pending;
Pending *windows_semantic_operation = &pending;
bool live = true, page_matches = true, stop_during_read = false;
int reads = 0, inputs = 0;
bool WindowsV1UiaMayCall() { return live; }
bool RecheckWindowsBoundPageOnLane(int window, int pid, Page, const std::function<bool()> &current) {
  ++reads;
  if (stop_during_read) live = false;
  return window == 12 && pid == 42 && page_matches && current();
}
//@@GUARD@@
int main() {
  for (int action = 0; action < 5; ++action) {
    for (int mode = 0; mode < 5; ++mode) {
      WindowsSemanticWork work;
      live = mode != 2; page_matches = mode != 1; stop_during_read = mode == 3;
      work.observed_page.web = mode != 4;
      pending.page_invalidated = false; reads = inputs = 0;
      if (WindowsSemanticPageAllowsInput(work) && WindowsV1UiaMayCall()) ++inputs;
      const bool allowed = mode == 0 || mode == 4;
      if (inputs != (allowed ? 1 : 0) ||
          reads != (mode == 2 || mode == 4 ? 0 : 1) ||
          pending.page_invalidated != (mode == 1 || mode == 3)) return 1;
    }
  }
  std::cout << "Foreground semantic page guard: PASS\n";
}
`;
    const directory = mkdtempSync(join(tmpdir(), 'sc-semantic-page-'));
    try {
      const input = join(directory, 'guard.cc');
      const output = join(directory, 'guard.exe');
      writeFileSync(input, program.replace('//@@GUARD@@', semantic.slice(start, end)));
      const command = msvc
        ? msvc.wrap(['/nologo', '/std:c++20', '/EHsc', input, `/Fe:${output}`, `/Fo:${output}.obj`])
        : { file: 'clang++', args: ['-std=c++20', input, '-o', output], verbatim: false };
      const built = spawnSync(command.file, command.args, {
        cwd: directory,
        encoding: 'utf8',
        windowsHide: true,
        windowsVerbatimArguments: command.verbatim,
        timeout: 120_000,
      });
      expect(built.status, `${built.error ?? ''}\n${built.stdout}\n${built.stderr}`).toBe(0);
      const ran = spawnSync(output, [], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
      expect(ran.status, `${ran.error ?? ''}\n${ran.stdout}\n${ran.stderr}`).toBe(0);
      expect(ran.stdout).toContain('Foreground semantic page guard: PASS');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
  150_000,
);

it.runIf(msvc !== null || clang)(
  'runs supported browser page evidence and origin native cases',
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'sc-browser-page-'));
    try {
      const output = join(directory, 'page-tests.exe');
      const source = join(__dirname, '../../computer-use-native/computer_use_protocol_fuzz.cc');
      const command = msvc
        ? msvc.wrap([
            '/nologo',
            '/std:c++20',
            '/EHsc',
            '/utf-8',
            source,
            `/Fe:${output}`,
            `/Fo:${output}.obj`,
          ])
        : { file: 'clang++', args: ['-std=c++20', source, '-o', output], verbatim: false };
      const built = spawnSync(command.file, command.args, {
        cwd: directory,
        encoding: 'utf8',
        windowsHide: true,
        windowsVerbatimArguments: command.verbatim,
        timeout: 120_000,
      });
      expect(built.status, `${built.error ?? ''}\n${built.stdout}\n${built.stderr}`).toBe(0);
      const ran = spawnSync(output, [], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
      expect(ran.status, `${ran.error ?? ''}\n${ran.stdout}\n${ran.stderr}`).toBe(0);
      expect(ran.stdout).toContain('Supported browser page evidence: PASS');
      expect(ran.stdout).toContain('Windows page origin: PASS');
      expect(ran.stdout).toContain('Windows origin policy: PASS');
      expect(ran.stdout).toContain('Measured browser RWHH binding: PASS');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
  150_000,
);

describe('Windows page origin metadata (N11-B)', () => {
  it('isolates the bounded metadata walk from the legacy capture budget', () => {
    const reader = native('computer_use_windows_shadow_reader.h');
    expect(reader).toContain('kOriginMaxCalls = 128');
    expect(reader).toContain("kOriginDeadlineNs = 30'000'000");
    expect(reader).toContain('if (OriginWithinBudget()) capture->page_origin');
    expect(reader.indexOf('capture.budget_exhausted = gate_.BudgetExhausted()')).toBeLessThan(
      reader.indexOf('CapturePageOrigin(root, &capture)'),
    );
    const harness = native('computer_use_protocol_fuzz.cc');
    for (const name of [
      'winorigin-budget-isolated-from-legacy-capture',
      'winorigin-budget-preserves-classification-and-interlock',
      'winorigin-budget-preserves-subsequent-read',
    ])
      expect(harness).toContain(name);
  });

  it('classifies a freshly verified unique supported browser Document without enabling actions', () => {
    const reader = native('computer_use_windows_shadow_reader.h');
    expect(reader).toContain('CapturePageOrigin(root, &capture)');
    expect(reader).toContain('ClassifyPageOrigin(url).state');
    expect(reader).toContain('FindPageDocument(');
    expect(reader).not.toContain('ScanPageDocuments(');
    expect(reader).not.toContain('ScanDocuments(');
    expect(reader).toContain('capture.page_origin = OriginState::kUnknown');
    const shadow = native('computer_use_windows_shadow.h');
    expect(shadow).toContain('? capture.page_origin : OriginState::kUnknown');
    expect(native('computer_use_protocol_fuzz.cc')).toContain('CheckWindowsPageOrigin()');
    expect(native('computer_use_windows_uia_source.h')).toContain(
      'get_CurrentValue(value.Receive())',
    );
  });
});

describe('Windows page recheck (N11-C)', () => {
  it('supervised_browser_requires_page_read_and_recheck', () => {
    const preflight = native('computer_use_windows_host_preflight.inc');
    expect(preflight).toContain(
      'if (!readable_page || session.maximum_mode == "observe_only") return unavailable;',
    );
    expect(preflight).toContain('auto evidence = reader.ReadPage();');
    expect(preflight).toContain('return reader.RecheckPage(page) && current();');
    expect(native('computer_use_protocol_fuzz.cc')).toContain(
      'supervised_browser_incomplete_page_never_inputs',
    );
    const targets = native('computer_use_windows_host_v2_targets.inc');
    expect(targets).toContain(
      '!WindowsBrowserInstallAllowsControl(Utf8FromWide(measured.image_path),',
    );
    expect(targets).toContain(
      'CanonicalWindowsTargetDirectory(WindowsTargetKnownFolder(FOLDERID_ProgramFilesX86))',
    );
  });
  it('skips page comparison and invalidation for observe-only sessions', () => {
    const observe = native('computer_use_windows_host_pipe.inc');
    expect(observe).toContain('session.maximum_mode != "observe_only" && session.has_observation');
    expect(observe).toContain(
      'session.maximum_mode != "observe_only" && (observed_page.web || current_page.web)',
    );
  });
  it('binds the observation to tickets and approval remeasurement without extending the wire', () => {
    const input = native('computer_use_windows_host_input.inc');
    const preflight = native('computer_use_windows_host_preflight.inc');
    const observe = native('computer_use_windows_host_pipe.inc');
    expect(input).toContain('WindowsPageBinding(session.observed_page)');
    expect(input).toContain('if (!RecheckWindowsPage(session))');
    expect(preflight).toContain('input.identity.window_identity.value += ":" + WindowsPageBinding');
    expect(preflight.match(/if \(!RecheckWindowsPage\(session\)\)/gu)).toHaveLength(2);
    expect(preflight).toContain('InvalidateWindowsPage(session)');
    const common = native('computer_use_windows_host_common.inc');
    expect(common).toContain('approval->second.Invalidate()');
    expect(common).toContain('InvalidateWindowsTicket(key)');
    expect(observe).toContain('WindowsPageAllowsInput(session.observed_page, current_page)');
    expect(observe).toContain('std::swap(session.observed_page, observed_page)');
  });

  it('covers page changes, card return, confirmation changes and unreadable origins in native components', () => {
    const harness = native('computer_use_protocol_fuzz.cc');
    for (const name of [
      'tab_switch_invalidates_pending_action',
      'same_origin_other_tab_rejects_old_approval',
      'approval_return_rechecks_sensitive_surface',
      'confirmation_change_invalidates_approval',
      'unreadable_origin_never_reuses_previous_origin',
      'same_origin_navigation_invalidates_page',
      'native-window-page-check-is-neutral',
    ])
      expect(harness).toContain(name);
    expect(harness).toContain('if (!CheckWindowsPageRecheck()) return 1;');
    const reader = native('computer_use_windows_shadow_reader.h');
    expect(reader).toContain('PageDocumentStillCurrent(root, document)');
    expect(reader).toContain('const bool within = OriginWithinBudget()');
    expect(native('computer_use_origin_classify.h')).toContain('kOriginClassificationVersion = 2');
  });
});

// Compile the actual Win32 enumeration body with a HWND-list stand-in on every compiler.
// This exercises ownership, geometry and admission without a browser or desktop session.
it.runIf(msvc !== null || clang)(
  'runs the production RWHH enumeration against HWND stand-ins',
  () => {
    const source = native('computer_use_windows_uia_source.h');
    const start = source.indexOf('  ShadowReadResult PageHost(');
    const end = source.indexOf('  ShadowReadResult WindowProcessPath(', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const program = String.raw`
#include <cstdint>
#include <cwchar>
#include <functional>
#include <iostream>
#include <utility>
#include <vector>
#define CALLBACK
using BOOL = int;
using DWORD = unsigned long;
using LPARAM = std::intptr_t;
using HRESULT = int;
constexpr int TRUE = 1, FALSE = 0, GA_ROOT = 2;
bool FAILED(int result) { return result < 0; }
struct Window;
using HWND = Window *;
using UIA_HWND = HWND;
struct RECT { int left = 0, top = 0, right = 100, bottom = 100; };
struct Window {
  const wchar_t *name = L"Chrome_RenderWidgetHostHWND";
  bool visible = true, rect_ok = true, class_ok = true;
  DWORD pid = 42;
  RECT rect;
  HWND top = nullptr;
};
Window top;
std::vector<Window> children;
int calls = 0, permits = 0, converted = 0;
void Called() { if (++calls > permits) std::abort(); }
HWND GetAncestor(HWND window, int) { Called(); return window->top; }
DWORD GetWindowThreadProcessId(HWND window, DWORD *pid) {
  Called(); *pid = window->pid; return window->pid ? 1 : 0;
}
int GetClassNameW(HWND window, wchar_t *name, int) {
  Called(); if (!window->class_ok) return 0;
  std::wcscpy(name, window->name); return static_cast<int>(std::wcslen(name));
}
BOOL IsWindowVisible(HWND window) { Called(); return window->visible; }
BOOL GetWindowRect(HWND window, RECT *rect) {
  Called(); *rect = window->rect; return window->rect_ok;
}
BOOL EnumChildWindows(HWND, BOOL (*visit)(HWND, LPARAM), LPARAM parameter) {
  Called(); for (auto &child : children) if (!visit(&child, parameter)) break;
  return FALSE; // Windows does not specify a usable completion return value.
}
struct IUIAutomationElement {
  HWND hwnd = &top;
  HRESULT get_CurrentNativeWindowHandle(UIA_HWND *output) { Called(); *output = hwnd; return 0; }
};
struct Automation {
  IUIAutomationElement element;
  HRESULT ElementFromHandle(HWND window, IUIAutomationElement **output) {
    Called(); ++converted; element.hwnd = window; *output = &element; return 0;
  }
};
namespace windows_uia_source_detail {
template<class T> struct ComRef {
  T *value = nullptr;
  T *Get() { return value; }
  T **Receive() { return &value; }
};
}
enum class ShadowReadResult { kOk, kFailed, kStopped };
struct Base {
  using Element = unsigned;
  virtual ShadowReadResult PageHost(Element, const std::function<bool()> &, Element *) = 0;
};
struct Source : Base {
  HWND window_ = &top;
  IUIAutomationElement root;
  Automation automation;
  windows_uia_source_detail::ComRef<Automation> automation_{&automation};
  IUIAutomationElement *At(Element) { return &root; }
  ShadowReadResult Keep(HRESULT result, windows_uia_source_detail::ComRef<IUIAutomationElement>, Element *out) {
    *out = 1; return result < 0 ? ShadowReadResult::kFailed : ShadowReadResult::kOk;
  }
//@@PAGE_HOST@@
};
int main() {
  for (int mode = 0; mode < 17; ++mode) {
    top.top = &top; top.pid = 42;
    children = {Window{}}; children[0].top = &top;
    Source source;
    bool expected = false;
    int limit = 128;
    switch (mode) {
    case 0: expected = true; break;
    case 1: children.clear(); break;
    case 2: children.push_back(children[0]); break;
    case 3: children[0].visible = false; break;
    case 4: children[0].rect.right = 0; break;
    case 5: children[0].pid = 99; break;
    case 6: children[0].top = nullptr; break;
    case 7: children[0].class_ok = false; break;
    case 8: children[0].rect_ok = false; break;
    case 9: top.pid = 0; break;
    case 10: children.resize(65); for (auto &w : children) w.name = L"other"; break;
    case 11: limit = 6; break;
    case 12:
      children.push_back(children[0]); children[1].visible = false; expected = true; break;
    case 13:
      children.push_back(children[0]); children[1].rect.bottom = 0; expected = true; break;
    case 14: source.root.hwnd = nullptr; break;
    case 15:
    case 16:
      children.resize(mode == 15 ? 40 : 65);
      for (size_t i = 1; i < children.size(); ++i) children[i].name = L"Intermediate D3D Window";
      expected = mode == 15;
      break;
    }
    calls = permits = converted = 0;
    unsigned output = 0;
    const auto result = source.PageHost(0, [&] {
      if (permits >= limit) return false;
      ++permits; return true;
    }, &output);
    if ((result == ShadowReadResult::kOk) != expected || calls > 128 ||
        converted != (expected ? 1 : 0)) return 1;
  }
  std::cout << "RWHH enumeration: PASS\n";
}
`;
    const directory = mkdtempSync(join(tmpdir(), 'sc-page-host-'));
    try {
      const input = join(directory, 'page-host.cc');
      const output = join(directory, 'page-host.exe');
      writeFileSync(input, program.replace('//@@PAGE_HOST@@', source.slice(start, end)));
      const command = msvc
        ? msvc.wrap(['/nologo', '/std:c++20', '/EHsc', input, `/Fe:${output}`, `/Fo:${output}.obj`])
        : { file: 'clang++', args: ['-std=c++20', input, '-o', output], verbatim: false };
      const built = spawnSync(command.file, command.args, {
        cwd: directory,
        encoding: 'utf8',
        windowsHide: true,
        windowsVerbatimArguments: command.verbatim,
        timeout: 120_000,
      });
      expect(built.status, `${built.error ?? ''}\n${built.stdout}\n${built.stderr}`).toBe(0);
      const ran = spawnSync(output, [], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
      expect(ran.status, `${ran.error ?? ''}\n${ran.stdout}\n${ran.stderr}`).toBe(0);
      expect(ran.stdout).toContain('RWHH enumeration: PASS');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
  150_000,
);
