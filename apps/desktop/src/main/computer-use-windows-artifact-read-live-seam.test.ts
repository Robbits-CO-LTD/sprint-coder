import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// A LIVE seam for the Windows read of one node's value (#785 T15-4w). The portable read
// (computer_use_windows_artifact_read.h) runs against the real UI Automation source: windows the
// program creates itself and the acceptance fixture, built here and started by this test. Shown: an
// Edit of an ordinary window and the fixture's Edit are read (their value, exactly); a password Edit
// is refused and its value never asked for; a Button, a ComboBox and a static text without a value are
// refused; a window of a browser's class (Chrome_WidgetWin_*) and a console window are refused. Windows
// only: elsewhere, or where no MSVC can be found, it is skipped (never in CI, where a runner that cannot
// compile must not turn this into a silent pass). Only windows and processes this test starts itself
// are touched, and they are closed at the end.

const nativeDirectory = join(__dirname, '../../computer-use-native');
const fixtureDirectory = join(nativeDirectory, 'fixtures', 'win32-acceptance');
const vswhere = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';

type Build = Readonly<{
  name: string;
  wrap: (arguments_: string[]) => { file: string; args: string[]; verbatim: boolean };
}>;

function findBuild(): Build | null {
  if (process.platform !== 'win32') return null;
  if (spawnSync('cl.exe', ['/?'], { stdio: 'ignore' }).status === 0)
    return { name: 'cl.exe', wrap: (args) => ({ file: 'cl.exe', args, verbatim: false }) };
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
    wrap: (args) => ({
      file: 'cmd.exe',
      args: [
        '/d',
        '/s',
        '/c',
        `"call "${vcvars}" >nul && cl.exe ${args.map((argument) => `"${argument}"`).join(' ')}"`,
      ],
      verbatim: true,
    }),
  };
}

const program = String.raw`
#include <windows.h>
#include <ole2.h>
#include <UIAutomation.h>

#include <atomic>
#include <chrono>
#include <cstdint>
#include <iostream>
#include <memory>
#include <string>
#include <thread>

#include "computer_use_windows_uia_source.h"
#include "computer_use_windows_artifact_read.h"

using namespace sprint_coder::computer_use;

static std::atomic<bool> g_lookup_slot{false};

int g_failures = 0;
void Check(bool ok, const char *name) {
  if (!ok) {
    ++g_failures;
    std::cout << "FAIL " << name << "\n";
  }
}

struct Read { WindowsArtifactReadResult result; long long micros; };

Read ReadOf(HWND window, const std::string &target) {
  const auto started = std::chrono::steady_clock::now();
  Read read;
  const auto valid = []() { return true; };
  std::unique_ptr<ShadowUiaSource> source =
      WindowsUiaShadowSource::Create(window, POINT{0, 0}, valid, WindowsUiaShadowSource::kInterlockUiaTimeoutMs, g_lookup_slot);
  if (source == nullptr) {
    read.result.incomplete = true;
  } else {
    ShadowRequestInfo info;
    info.policy_language = "en";
    info.maximum_mode = "full_access_app";
    read.result = ReadWindowsArtifactValue(*source, target, info);
  }
  read.micros = std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now() - started).count();
  return read;
}

LRESULT CALLBACK Proc(HWND window, UINT message, WPARAM w, LPARAM l) {
  if (message == WM_DESTROY) {
    PostQuitMessage(0);
    return 0;
  }
  return DefWindowProcW(window, message, w, l);
}

struct Win { HWND handle = nullptr; std::thread thread; };

HWND Child(HWND parent, const wchar_t *klass, const wchar_t *text, DWORD style, int id, int y) {
  return CreateWindowExW(0, klass, text, WS_CHILD | WS_VISIBLE | style, 10, y, 300, 24, parent,
                         reinterpret_cast<HMENU>(static_cast<INT_PTR>(id)), GetModuleHandleW(nullptr), nullptr);
}

// A top-level window of its own class, with the controls of the cases below, on a thread of its own.
void MakeWindow(Win &win, const wchar_t *class_name, const wchar_t *title, int x) {
  std::atomic<bool> ready{false};
  win.thread = std::thread([&win, &ready, class_name, title, x]() {
    WNDCLASSW cls{};
    cls.lpfnWndProc = Proc;
    cls.hInstance = GetModuleHandleW(nullptr);
    cls.lpszClassName = class_name;
    RegisterClassW(&cls);
    win.handle = CreateWindowExW(WS_EX_TOPMOST, class_name, title, WS_OVERLAPPEDWINDOW | WS_VISIBLE, x, 120, 360, 300,
                                 nullptr, nullptr, cls.hInstance, nullptr);
    Child(win.handle, L"STATIC", L"Plain label", SS_LEFT, 2005, 10);
    Child(win.handle, L"EDIT", L"own value", ES_AUTOHSCROLL, 2001, 40);
    Child(win.handle, L"EDIT", L"secret", ES_AUTOHSCROLL | ES_PASSWORD, 2002, 70);
    Child(win.handle, L"BUTTON", L"Press", BS_PUSHBUTTON, 2003, 100);
    Child(win.handle, L"EDIT", L"", ES_AUTOHSCROLL, 2004, 130);
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

// Presses the control with this automation id (UI Automation InvokePattern). Used on the fixture only.
bool InvokeById(HWND window, const wchar_t *automation_id) {
  IUIAutomation *automation = nullptr;
  if (FAILED(CoCreateInstance(__uuidof(CUIAutomation), nullptr, CLSCTX_INPROC_SERVER, __uuidof(IUIAutomation),
                              reinterpret_cast<void **>(&automation))) || automation == nullptr)
    return false;
  bool pressed = false;
  IUIAutomationElement *root = nullptr;
  if (SUCCEEDED(automation->ElementFromHandle(window, &root)) && root != nullptr) {
    VARIANT id;
    VariantInit(&id);
    id.vt = VT_BSTR;
    id.bstrVal = SysAllocString(automation_id);
    IUIAutomationCondition *condition = nullptr;
    if (SUCCEEDED(automation->CreatePropertyCondition(UIA_AutomationIdPropertyId, id, &condition)) && condition != nullptr) {
      IUIAutomationElement *button = nullptr;
      if (SUCCEEDED(root->FindFirst(TreeScope_Descendants, condition, &button)) && button != nullptr) {
        IUIAutomationInvokePattern *pattern = nullptr;
        if (SUCCEEDED(button->GetCurrentPatternAs(UIA_InvokePatternId, __uuidof(IUIAutomationInvokePattern),
                                                  reinterpret_cast<void **>(&pattern))) && pattern != nullptr) {
          pressed = SUCCEEDED(pattern->Invoke());
          pattern->Release();
        }
        button->Release();
      }
      condition->Release();
    }
    VariantClear(&id);
    root->Release();
  }
  automation->Release();
  return pressed;
}

int main(int argc, char **argv) {
  const bool ci = argc > 1 && std::string(argv[1]) == "ci";
  const std::string fixture_path = argc > 2 ? argv[2] : "";
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  Win ordinary, browser, console;
  MakeWindow(ordinary, L"Sc785ArtifactOrdinary", L"sc785-ordinary", 40);
  MakeWindow(browser, L"Chrome_WidgetWin_1", L"sc785-browser", 440);
  MakeWindow(console, L"ConsoleWindowClass", L"sc785-console", 840);
  if (ordinary.handle == nullptr || browser.handle == nullptr || console.handle == nullptr) return 2;
  Sleep(600);

  // Whether UI Automation reads our own windows at all (a cold start needs a warm-up).
  Read warm;
  for (int i = 0; i < 6; ++i) {
    warm = ReadOf(ordinary.handle, "2001");
    if (warm.result.ok) break;
    Sleep(300);
  }
  const bool readable = warm.result.ok;
  std::cout << "readable=" << readable << "\n";
  if (ci) Check(readable, "uia_reads_our_windows");
  if (readable) {
    const Read edit = ReadOf(ordinary.handle, "2001");
    Check(edit.result.ok && edit.result.text == "own value", "ordinary_edit_value_is_read");
    std::cout << "ordinary edit read micros=" << edit.micros << "\n";
    const Read password = ReadOf(ordinary.handle, "2002");
    Check(!password.result.ok && password.result.verdict.Has(ArtifactReadRefusal::kSecure), "password_edit_is_refused");
    const Read button = ReadOf(ordinary.handle, "2003");
    Check(!button.result.ok && button.result.verdict.Has(ArtifactReadRefusal::kRoleNotAllowed), "button_is_refused");
    const Read empty = ReadOf(ordinary.handle, "2004");
    Check(!empty.result.ok && empty.result.verdict.MayRead(), "edit_without_a_value_is_refused");
    const Read label = ReadOf(ordinary.handle, "2005");
    Check(!label.result.ok, "static_text_without_a_value_is_refused");
    const Read missing = ReadOf(ordinary.handle, "9999");
    Check(!missing.result.ok, "unknown_target_is_refused");
    const Read chrome = ReadOf(browser.handle, "2001");
    Check(!chrome.result.ok && chrome.result.verdict.Has(ArtifactReadRefusal::kBrowserWindow), "chrome_widget_window_is_refused");
    const Read shell = ReadOf(console.handle, "2001");
    Check(!shell.result.ok && shell.result.verdict.Has(ArtifactReadRefusal::kSurfaceNotOrdinary), "console_window_is_refused");
  }

  // The acceptance fixture, started by this program and closed at the end.
  if (!fixture_path.empty()) {
    STARTUPINFOA startup{};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION process{};
    std::string command = "\"" + fixture_path + "\"";
    if (CreateProcessA(nullptr, command.data(), nullptr, nullptr, FALSE, 0, nullptr, nullptr, &startup, &process)) {
      HWND window = nullptr;
      for (int i = 0; i < 100 && window == nullptr; ++i) {
        Sleep(100);
        HWND found = FindWindowW(L"SprintCoderComputerUseAcceptanceFixtureV1", nullptr);
        DWORD pid = 0;
        if (found != nullptr) GetWindowThreadProcessId(found, &pid);
        if (found != nullptr && pid == process.dwProcessId) window = found;
      }
      Sleep(800);
      if (window != nullptr && readable) {
        const Read edit = ReadOf(window, "1001");
        // The fixture's main form is FLAT: the Edit sits beside the "Password field" caption, and the
        // read judges the captions around a text field (a PIN or a password caption makes it secure,
        // as in a web form). So this Edit is refused, on purpose (fail closed): the verdict says secure.
        Check(!edit.result.ok && edit.result.verdict.Has(ArtifactReadRefusal::kSecure), "fixture_edit_beside_a_password_caption_is_refused");
        const Read password = ReadOf(window, "1005");
        Check(!password.result.ok && password.result.verdict.Has(ArtifactReadRefusal::kSecure), "fixture_password_edit_is_refused");
        for (const char *id : {"1002", "1003", "1004", "1006", "1007", "1008", "1009", "1101"}) {
          const Read refused = ReadOf(window, id);
          Check(!refused.result.ok, (std::string("fixture_control_without_a_readable_value_is_refused_") + id).c_str());
        }
        // The safe dialog the fixture opens has no such caption: its Edit is read. The button is
        // pressed through UI Automation (the fixture is ours, and so is the press).
        if (InvokeById(window, L"1010")) {
          HWND dialog = nullptr;
          for (int i = 0; i < 100 && dialog == nullptr; ++i) {
            Sleep(100);
            HWND found = FindWindowW(L"SprintCoderComputerUseSafeDialogV1", nullptr);
            DWORD pid = 0;
            if (found != nullptr) GetWindowThreadProcessId(found, &pid);
            if (found != nullptr && pid == process.dwProcessId) dialog = found;
          }
          Sleep(500);
          Check(dialog != nullptr, "fixture_safe_dialog_opened");
          if (dialog != nullptr) {
            const Read dialog_edit = ReadOf(dialog, "1201");
            Check(dialog_edit.result.ok && dialog_edit.result.text == "Safe dialog text", "fixture_safe_dialog_edit_value_is_read");
            std::cout << "fixture dialog edit read micros=" << dialog_edit.micros << " refusals="
                      << static_cast<int>(dialog_edit.result.verdict.refusals) << "\n";
            const Read close = ReadOf(dialog, "1202");
            Check(!close.result.ok, "fixture_safe_dialog_button_is_refused");
          }
        } else {
          Check(!ci, "fixture_safe_dialog_button_pressed");
        }
      } else if (ci) {
        Check(false, "fixture_window_found");
      }
      TerminateProcess(process.hProcess, 0);
      CloseHandle(process.hThread);
      CloseHandle(process.hProcess);
    } else if (ci) {
      Check(false, "fixture_started");
    }
  }
  for (Win *win : {&ordinary, &browser, &console}) PostMessageW(win->handle, WM_CLOSE, 0, 0);
  for (Win *win : {&ordinary, &browser, &console}) win->thread.join();
  std::cout << (g_failures == 0 ? "OK\n" : "FAILED\n");
  return g_failures == 0 ? 0 : 1;
}
`;

const build = findBuild();
const ci = process.env['CI'] !== undefined;
const onWindows = process.platform === 'win32';

describe.skipIf(!onWindows || (build === null && !ci))(
  'Windows read of one node value, live (#785 T15-4w)',
  () => {
    it('reads an Edit and the fixture Edit, and refuses a password, a button, a browser class and a console', () => {
      expect(build, 'cl.exe (MSVC) is required on a Windows CI runner').not.toBeNull();
      const scratch = mkdtempSync(join(tmpdir(), 'computer-use-artifact-read-'));
      try {
        const run = (args: string[]) => {
          const command = build!.wrap(args);
          return spawnSync(command.file, command.args, {
            encoding: 'utf8',
            windowsVerbatimArguments: command.verbatim,
            timeout: 240_000,
            env: { ...process.env, VSLANG: '1033' },
          });
        };
        const fixtureExecutable = join(scratch, 'fixture.exe');
        const fixtureBuild = run([
          '/nologo',
          '/std:c++20',
          '/EHsc',
          '/O2',
          '/MT',
          '/W4',
          '/GS',
          '/permissive-',
          '/utf-8',
          '/DUNICODE',
          '/D_UNICODE',
          '/DWIN32_LEAN_AND_MEAN',
          '/D_WIN32_WINNT=0x0A00',
          `/I${fixtureDirectory}`,
          join(fixtureDirectory, 'win32_acceptance_fixture.cc'),
          `/Fo:${join(scratch, 'fixture.obj')}`,
          `/Fe:${fixtureExecutable}`,
          '/link',
          '/SUBSYSTEM:WINDOWS,10.00',
          '/MANIFEST:EMBED',
          `/MANIFESTINPUT:${join(fixtureDirectory, 'win32_acceptance_fixture.manifest')}`,
          'user32.lib',
          'gdi32.lib',
          'comctl32.lib',
          'comdlg32.lib',
          'shell32.lib',
        ]);
        expect(fixtureBuild.status, `fixture\n${fixtureBuild.stdout}\n${fixtureBuild.stderr}`).toBe(
          0,
        );

        const source = join(scratch, 'seam.cc');
        const binary = join(scratch, 'seam.exe');
        writeFileSync(source, program);
        const built = run([
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
          source,
          `/Fe:${binary}`,
          `/Fo:${binary}.obj`,
          '/link',
          '/DEBUG:NONE',
          'ole32.lib',
          'oleaut32.lib',
          'uiautomationcore.lib',
          'user32.lib',
          'uuid.lib',
          'shell32.lib',
        ]);
        expect(built.status, `${built.stdout}\n${built.stderr}`).toBe(0);
        const executed = spawnSync(
          binary,
          ci ? ['ci', fixtureExecutable] : ['local', fixtureExecutable],
          {
            encoding: 'utf8',
            timeout: 120_000,
          },
        );
        console.log(executed.stdout);
        expect(executed.status, `${executed.stdout}\n${executed.stderr}`).toBe(0);
        expect(executed.stdout).toContain('OK');
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    }, 400_000);
  },
);
