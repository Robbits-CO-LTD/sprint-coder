import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { findBuild } from './test-support/msvc-build';

const run = promisify(execFile);
const browser = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);
const enabled = process.platform === 'win32' && !process.env['CI'] && browser !== undefined;

// Real UIA reads, with no input injection. A kill-on-close Job owns only the browser launched
// with this test's fresh profile, including descendants; even a harness timeout closes the Job.
const program = String.raw`
#include "computer_use_windows_uia_source.h"
#include <iostream>
using namespace sprint_coder::computer_use;
using windows_uia_source_detail::ComRef;
struct Job {
  HANDLE value = CreateJobObjectW(nullptr, nullptr);
  ~Job() { if (value) CloseHandle(value); }
};
struct WindowSearch { HANDLE job; HWND window = nullptr; unsigned visible = 0; };
BOOL CALLBACK FindWindow(HWND window, LPARAM parameter) {
  auto &search = *reinterpret_cast<WindowSearch *>(parameter);
  DWORD pid = 0;
  GetWindowThreadProcessId(window, &pid);
  HANDLE process = OpenProcess(PROCESS_QUERY_INFORMATION, FALSE, pid);
  BOOL member = FALSE;
  if (process) { IsProcessInJob(process, search.job, &member); CloseHandle(process); }
  wchar_t name[128]{};
  wchar_t title[256]{};
  if (member && IsWindowVisible(window)) ++search.visible;
  if (member && IsWindowVisible(window) && GetClassNameW(window, name, 128) &&
      std::wcscmp(name, L"Chrome_WidgetWin_1") == 0 && GetWindowTextW(window, title, 256) &&
      std::wcsstr(title, L"SC Origin Probe")) search.window = window;
  return TRUE;
}
bool Signature(IUIAutomationElement *element, std::string *output) {
  SAFEARRAY *id = nullptr;
  if (FAILED(element->GetRuntimeId(&id)) || !id) return false;
  LONG first = 0, last = -1;
  bool ok = SUCCEEDED(SafeArrayGetLBound(id, 1, &first)) &&
            SUCCEEDED(SafeArrayGetUBound(id, 1, &last)) && last >= first && last - first < 64;
  for (LONG i = first; ok && i <= last; ++i) {
    int value = 0;
    ok = SUCCEEDED(SafeArrayGetElement(id, &i, &value));
    *output += std::to_string(value) + ":";
  }
  SafeArrayDestroy(id);
  return ok;
}
std::string diagnostic = "no owned browser window";
bool Probe(HWND window) {
  std::atomic<bool> slot{false};
  auto source = WindowsUiaShadowSource::Create(window, {}, [] { return true; }, 250, slot);
  if (!source) return false;
  source->SetSignatureProvider(Signature);
  ShadowUiaSource::Element warm_root = 0;
  std::string warm_class, warm_path;
  const auto root_result = source->Root(&warm_root);
  const auto class_result = source->Text(warm_root, ShadowUiaText::kClassName, true, 256, &warm_class);
  const auto path_result = source->WindowProcessPath(warm_root, 4096, &warm_path);
  const auto started = source->NowNs();
  const auto page = WindowsShadowReader(*source).ReadPage();
  diagnostic = "page complete=" + std::to_string(page.complete) + " web=" + std::to_string(page.web) + " origin=" + std::to_string(static_cast<int>(page.origin));
  diagnostic += " root/class/path=" + std::to_string(static_cast<int>(root_result)) + "/" +
      std::to_string(static_cast<int>(class_result)) + "/" + std::to_string(static_cast<int>(path_result)) +
      " elapsed_us=" + std::to_string((source->NowNs() - started) / 1000);
  if (!page.complete || page.origin != OriginState::kOrdinary) return false;
  ComRef<IUIAutomation> automation;
  if (FAILED(CoCreateInstance(CLSID_CUIAutomation, nullptr, CLSCTX_INPROC_SERVER,
                              IID_PPV_ARGS(automation.Receive())))) return false;
  ComRef<IUIAutomationElement> root;
  if (FAILED(automation.Get()->ElementFromHandle(window, root.Receive()))) return false;
  for (const wchar_t *name : {L"Top Button", L"Div Button", L"Normal Frame Button",
                             L"Presentational Frame Button"}) {
    diagnostic = "locating fixture button";
    VARIANT value; VariantInit(&value);
    value.vt = VT_BSTR; value.bstrVal = SysAllocString(name);
    ComRef<IUIAutomationCondition> condition;
    const auto result = automation.Get()->CreatePropertyCondition(UIA_NamePropertyId, value, condition.Receive());
    VariantClear(&value);
    if (FAILED(result)) return false;
    ComRef<IUIAutomationElement> button;
    if (FAILED(root.Get()->FindFirst(TreeScope_Descendants, condition.Get(), button.Receive())) ||
        !button.Get()) return false;
    RECT rect{};
    if (FAILED(button.Get()->get_CurrentBoundingRectangle(&rect)) ||
        rect.right <= rect.left || rect.bottom <= rect.top) return false;
    POINT point{(rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2};
    auto target = WindowsUiaShadowSource::Create(window, point, [] { return true; }, 250, slot);
    if (!target) return false;
    const auto capture = WindowsShadowReader(*target).Capture("click", "");
    const bool frame = std::wcsstr(name, L"Frame") != nullptr;
    const std::string expected_name = frame
        ? (std::wcscmp(name, L"Normal Frame Button") == 0 ? "Normal Frame Button" : "Presentational Frame Button")
        : (std::wcscmp(name, L"Top Button") == 0 ? "Top Button" : "Div Button");
    diagnostic = "target found=" + std::to_string(capture.target_found) + " chain=" + std::to_string(capture.chain.size()) + " reached=" + std::to_string(capture.chain_reached_root) + " frame=" + std::to_string(frame) + " origin=" + std::to_string(static_cast<int>(capture.page_origin));
    if (!capture.target_found || capture.chain.empty() || capture.chain.front().name != expected_name ||
        !capture.chain_reached_root || capture.page_origin !=
          (frame ? OriginState::kUnknown : OriginState::kOrdinary)) return false;
  }
  return true;
}
int wmain(int argc, wchar_t **argv) {
  if (argc != 4 || FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) return 2;
  Job job;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!job.value || !SetInformationJobObject(job.value, JobObjectExtendedLimitInformation,
                                            &limits, sizeof(limits))) return 2;
  std::wstring command = L"\"" + std::wstring(argv[1]) + L"\" --user-data-dir=\"" + argv[2] +
    L"\" --no-first-run --no-default-browser-check --disable-extensions --disable-sync"
    L" --disable-background-networking --disable-component-update --disable-default-apps"
    L" --no-proxy-server --host-resolver-rules=\"MAP probe.example 127.0.0.1, MAP * ~NOTFOUND\""
    L" --force-renderer-accessibility --window-size=1100,900 \"" + argv[3] + L"\"";
  STARTUPINFOW startup{}; startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESHOWWINDOW;
  startup.wShowWindow = SW_SHOWNORMAL;
  PROCESS_INFORMATION process{};
  if (!CreateProcessW(argv[1], command.data(), nullptr, nullptr, FALSE, CREATE_SUSPENDED,
                      nullptr, nullptr, &startup, &process)) {
    std::cout << "NOT_RUN: browser launch blocked\n"; return 77;
  }
  if (!AssignProcessToJobObject(job.value, process.hProcess)) {
    TerminateProcess(process.hProcess, 2);
    CloseHandle(process.hThread); CloseHandle(process.hProcess); return 2;
  }
  ResumeThread(process.hThread); CloseHandle(process.hThread);
  bool passed = false;
  for (int attempt = 0; attempt < 40 && !passed; ++attempt) {
    Sleep(250);
    WindowSearch search{job.value};
    EnumWindows(FindWindow, reinterpret_cast<LPARAM>(&search));
    if (search.window) passed = Probe(search.window);
    else diagnostic = "no fixture window; owned visible windows=" + std::to_string(search.visible);
  }
  TerminateJobObject(job.value, 0);
  WaitForSingleObject(process.hProcess, 5000); CloseHandle(process.hProcess);
  CoUninitialize();
  if (!passed) std::cerr << diagnostic << "\n";
  std::cout << (passed ? "Live browser origin: PASS\n" : "Live browser origin: FAIL\n");
  return passed ? 0 : 1;
}
`;

it.skipIf(!enabled)(
  'reads real Chrome/Edge page and frame origins (Windows, installed browser, non-CI only)',
  async (context) => {
    const compiler = findBuild();
    if (!compiler || !browser) return context.skip();
    const directory = mkdtempSync(join(tmpdir(), 'sc-browser-origin-live-'));
    let requests = 0;
    const server = createServer((_request, response) => {
      ++requests;
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(`<!doctype html><title>SC Origin Probe</title>
        <button>Top Button</button><div><section><button>Div Button</button></section></div>
        <iframe title="Normal Frame" srcdoc="<title>Normal Frame Doc</title><button>Normal Frame Button</button>"></iframe>
        <iframe role="presentation" title="Presentational Frame" srcdoc="<title>Presentational Frame Doc</title><button>Presentational Frame Button</button>"></iframe>`);
    });
    try {
      const input = join(directory, 'probe.cc');
      const output = join(directory, 'probe.exe');
      writeFileSync(input, program);
      const command = compiler.wrap([
        '/nologo',
        '/std:c++20',
        '/EHsc',
        '/utf-8',
        '/DUNICODE',
        '/D_UNICODE',
        '/DNOMINMAX',
        `/I${join(__dirname, '../../computer-use-native')}`,
        input,
        `/Fe:${output}`,
        `/Fo:${output}.obj`,
        '/link',
        'ole32.lib',
        'oleaut32.lib',
        'uiautomationcore.lib',
        'user32.lib',
        'uuid.lib',
        'shell32.lib',
      ]);
      await run(command.file, command.args, {
        cwd: directory,
        windowsHide: true,
        windowsVerbatimArguments: command.verbatim,
        timeout: 120_000,
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing loopback port');
      const result = await run(
        output,
        [browser, join(directory, 'profile'), `http://probe.example:${address.port}/`],
        {
          windowsHide: true,
          timeout: 60_000,
        },
      ).catch((error: unknown) => {
        if (error && typeof error === 'object' && 'code' in error && error.code === 77) {
          console.warn('NOT_RUN: sandbox prevented isolated browser launch');
          context.skip();
        }
        console.error(`Fixture HTTP requests: ${requests}`);
        throw error;
      });
      expect(result.stdout).toContain('Live browser origin: PASS');
    } finally {
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
  },
  190_000,
);
