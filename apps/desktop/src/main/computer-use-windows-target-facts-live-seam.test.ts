import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// A LIVE seam for the Windows target facts (S5-c-3, #500 PR-2). The `windows target facts` block of
// computer_use_windows_host.cc (between its BEGIN/END markers) and the host functions it uses are
// cut out as they are and compiled into a program that measures processes it starts itself: cmd,
// the conhost under it, a copy of cmd under another name, mstsc, the acceptance fixture (built
// here), the fixture as this program's own child, a process with a shell below it, one with a
// renamed copy of cmd below it (found by its running image, not its name), one with a GUI below it,
// one with a pseudo console below it, and the fixture after its running image was renamed and another file put
// at its path once that path had been read. Each measurement is checked fact by fact, and then
// judged by the shared core (computer_use_target_eligibility.h) to show which class refuses it. The
// rename must come out as a mismatch of the running image, with every fact read from the running
// image and none from the replacement: if it did not, the expansion (PR-6) must not ship.
//
// Windows only: elsewhere, or where no MSVC can be found, it is skipped (never in CI, where a
// runner that cannot compile must not turn this into a silent pass). Every process it starts is in
// a job it ends at the end; no other window or process is touched.

const nativeDirectory = join(__dirname, '../../computer-use-native');
const fixtureDirectory = join(nativeDirectory, 'fixtures', 'win32-acceptance');
const host = readFileSync(join(nativeDirectory, 'computer_use_windows_host.cc'), 'utf8');
const vswhere = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';

function cut(start: string, end: string): string {
  const from = host.indexOf(start);
  const to = host.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`Native seam source markers changed: ${start}`);
  return host.slice(from, to);
}

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

const preamble = String.raw`
#include <windows.h>

#include <bcrypt.h>
#include <shlobj.h>
#include <softpub.h>
#include <tlhelp32.h>
#include <wincrypt.h>
#include <wintrust.h>
#include <mscat.h>
#include <appmodel.h>
#include <psapi.h>
#include <winioctl.h>
`;

const includes = String.raw`
#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#include "computer_use_target_eligibility.h"
#include "computer_use_windows_target_facts.h"
`;

const program = String.raw`
using namespace sprint_coder::computer_use;

int g_failures = 0;

void Check(bool ok, const std::string &name) {
  if (!ok) {
    ++g_failures;
    std::cout << "FAIL " << name << "\n";
  }
}

std::string Show(const std::optional<std::string> &value) {
  return value.has_value() ? "\"" + *value + "\"" : "-";
}
std::string Show(const std::optional<bool> &value) {
  return value.has_value() ? (*value ? "true" : "false") : "-";
}

bool Is(const std::optional<std::string> &value, std::string_view expected) {
  return value.has_value() &&
         target_eligibility_detail::AsciiLower(*value) == target_eligibility_detail::AsciiLower(expected);
}
bool Is(const std::optional<bool> &value, bool expected) {
  return value.has_value() && *value == expected;
}

bool g_self_elevated = false;

// The class the core refuses with, as a user would see it: this runner may be elevated (then every
// process it starts is, and W7 comes first), and these targets are judged as processes (the window
// is the caller's to give).
std::string ClassOf(TargetFacts facts) {
  if (g_self_elevated && facts.token_elevated == std::optional<bool>(true))
    facts.token_elevated = false;
  if (!facts.window_class.has_value()) facts.window_class = std::string{};
  const TargetClassification explained = ClassifyTargetExplained(facts);
  if (explained.verdict.kind == TargetVerdictKind::kUnresolvable) return "unresolvable";
  if (explained.verdict.kind == TargetVerdictKind::kDenied) return std::string(explained.deny_class);
  return std::string(TargetVerdictKindName(explained.verdict.kind));
}

void Print(const char *name, const WindowsTargetFactsMeasurement &m) {
  const TargetFacts &f = m.facts;
  std::cout << name << ": path=\"" << Utf8FromWide(m.image_path) << "\" root=" << Show(f.image_root)
            << " relative=" << Show(f.image_relative_path) << " leaf=" << Show(f.image_leaf)
            << " volume=" << Show(f.image_volume) << " running=" << Show(f.running_image_matches)
            << " signature=" << Show(f.signature) << " source=" << static_cast<int>(m.signature_source)
            << " O=" << Show(f.signer_organization) << " msroot=" << Show(f.signer_microsoft_root)
            << " self=" << Show(f.signer_is_self) << " fixture=" << Show(f.acceptance_fixture)
            << " pe=" << Show(f.pe_subsystem) << " original=" << Show(f.original_filename)
            << " admin=" << Show(f.requires_administrator) << " elevated=" << Show(f.token_elevated)
            << " user=" << Show(f.token_other_user) << " session=" << Show(f.token_other_session)
            << " protected=" << Show(f.token_protected) << " uiaccess=" << Show(f.token_ui_access)
            << " il=" << Show(f.token_integrity_above_self) << " appcontainer=" << Show(f.token_app_container)
            << " packaged=" << Show(f.packaged) << " family=" << Show(f.package_family)
            << " kind=" << Show(f.package_signature_kind) << " devmode=" << Show(f.package_development_mode)
            << " own=" << Show(f.own_descendant) << " shell=" << Show(f.descendant_shell)
            << " pty=" << Show(f.descendant_pseudo_console) << " class=" << Show(f.window_class)
            << " parent=" << (m.parent_pid.has_value() ? std::to_string(*m.parent_pid) : "-")
            << " => " << ClassOf(f) << "\n";
}

// The facts every measured target here shares: this user, this session, unpackaged, not protected.
void CheckOrdinary(const char *name, const WindowsTargetFactsMeasurement &m) {
  const TargetFacts &f = m.facts;
  const std::string n = name;
  Check(Is(f.image_volume, "fixed"), n + "_volume_fixed");
  Check(Is(f.token_elevated, g_self_elevated), n + "_elevated_as_this_process");
  Check(Is(f.token_other_user, false), n + "_same_user");
  Check(Is(f.token_other_session, false), n + "_same_session");
  Check(Is(f.token_protected, false), n + "_not_protected");
  Check(Is(f.token_ui_access, false), n + "_no_uiaccess");
  Check(Is(f.token_integrity_above_self, false), n + "_integrity_not_above");
  Check(Is(f.token_app_container, false), n + "_not_appcontainer");
  Check(Is(f.packaged, false) && Is(f.package_family, "") && Is(f.package_signature_kind, "none") &&
            Is(f.package_development_mode, false),
        n + "_not_packaged");
  Check(Is(f.signer_is_self, false), n + "_not_our_signer");
  Check(m.creation.has_value(), n + "_creation_read");
}

HANDLE g_job = nullptr;
std::vector<HANDLE> g_started;

struct Started {
  PROCESS_INFORMATION info{};
  bool ok = false;
};

Started Start(std::wstring command, DWORD flags) {
  Started started;
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESHOWWINDOW;
  startup.wShowWindow = SW_SHOWMINNOACTIVE;
  if (!CreateProcessW(nullptr, command.data(), nullptr, nullptr, FALSE, flags | CREATE_SUSPENDED,
                      nullptr, nullptr, &startup, &started.info))
    return started;
  started.ok = AssignProcessToJobObject(g_job, started.info.hProcess) == TRUE;
  g_started.push_back(started.info.hProcess);
  ResumeThread(started.info.hThread);
  return started;
}

HWND TopWindowOf(DWORD pid) {
  struct Search { DWORD pid; HWND found; } search{pid, nullptr};
  for (int attempt = 0; attempt < 100 && search.found == nullptr; ++attempt) {
    EnumWindows(
        [](HWND window, LPARAM parameter) -> BOOL {
          auto *s = reinterpret_cast<Search *>(parameter);
          DWORD owner = 0;
          GetWindowThreadProcessId(window, &owner);
          if (owner == s->pid && GetWindow(window, GW_OWNER) == nullptr && IsWindowVisible(window)) {
            s->found = window;
            return FALSE;
          }
          return TRUE;
        },
        reinterpret_cast<LPARAM>(&search));
    if (search.found == nullptr) Sleep(100);
  }
  return search.found;
}

WindowsTargetFactsMeasurement Measure(DWORD pid, HWND window, const WindowsTargetFactsContext &context) {
  WindowsTargetFactsMeasurement measured;
  for (int attempt = 0; attempt < 50; ++attempt) {
    measured = MeasureWindowsTargetFacts(pid, window, context);
    if (measured.facts.running_image_matches.has_value() && measured.facts.pe_subsystem.has_value())
      break;
    Sleep(100);
  }
  return measured;
}

std::optional<DWORD> ChildWithLeaf(DWORD parent, std::string_view leaf) {
  const std::optional<std::vector<WindowsProcessNode>> nodes = SnapshotWindowsTargetProcesses();
  if (!nodes.has_value()) return std::nullopt;
  for (const WindowsProcessNode &node : *nodes)
    if (node.parent_pid == parent && target_eligibility_detail::AsciiLower(node.leaf) == leaf)
      return node.pid;
  return std::nullopt;
}

int Idle() {
  Sleep(INFINITE);
  return 0;
}

// A process with one child below it: the command line it is given.
int ChildHost(std::wstring command) {
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESHOWWINDOW;
  startup.wShowWindow = SW_SHOWMINNOACTIVE;
  PROCESS_INFORMATION info{};
  if (!CreateProcessW(nullptr, command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr,
                      nullptr, &startup, &info))
    return 3;
  Sleep(INFINITE);
  return 0;
}

// A process with a pseudo console (ConPTY) below it, and a program that is not a shell in it.
int PtyHost(const std::wstring &ping) {
  HANDLE in_read = nullptr, in_write = nullptr, out_read = nullptr, out_write = nullptr;
  if (!CreatePipe(&in_read, &in_write, nullptr, 0) || !CreatePipe(&out_read, &out_write, nullptr, 0))
    return 3;
  HPCON console = nullptr;
  if (FAILED(CreatePseudoConsole(COORD{80, 25}, in_read, out_write, 0, &console))) return 4;
  std::thread([out_read]() {
    std::array<char, 4096> buffer{};
    DWORD read = 0;
    while (ReadFile(out_read, buffer.data(), static_cast<DWORD>(buffer.size()), &read, nullptr) && read > 0) {
    }
  }).detach();
  SIZE_T bytes = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &bytes);
  std::vector<std::uint8_t> list(bytes);
  auto *attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(list.data());
  if (!InitializeProcThreadAttributeList(attributes, 1, 0, &bytes) ||
      !UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, console,
                                 sizeof(console), nullptr, nullptr))
    return 5;
  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.lpAttributeList = attributes;
  PROCESS_INFORMATION info{};
  std::wstring command = L"\"" + ping + L"\" -n 600 127.0.0.1";
  if (!CreateProcessW(nullptr, command.data(), nullptr, nullptr, FALSE, EXTENDED_STARTUPINFO_PRESENT,
                      nullptr, nullptr, &startup.StartupInfo, &info))
    return 6;
  Sleep(INFINITE);
  return 0;
}

int wmain(int argc, wchar_t **argv) {
  std::vector<wchar_t> self_buffer(32768, L'\0');
  const DWORD self_length = GetModuleFileNameW(nullptr, self_buffer.data(), static_cast<DWORD>(self_buffer.size()));
  const std::wstring self(self_buffer.data(), self_length);
  std::vector<wchar_t> system_buffer(32768, L'\0');
  const UINT system_length = GetSystemDirectoryW(system_buffer.data(), static_cast<UINT>(system_buffer.size()));
  const std::wstring system32(system_buffer.data(), system_length);
  const std::wstring cmd = system32 + L"\\cmd.exe";
  const std::wstring mode = argc > 1 ? argv[1] : L"";
  if (mode == L"idle") return Idle();
  if (mode == L"childhost" && argc > 2) {
    // The program quoted, its switches as they are.
    std::wstring command = std::wstring(L"\"") + argv[2] + L"\"";
    for (int index = 3; index < argc; ++index) command += std::wstring(L" ") + argv[index];
    return ChildHost(command);
  }
  if (mode == L"ptyhost") return PtyHost(system32 + L"\\PING.EXE");
  if (argc < 4) return 2;
  const bool ci = mode == L"ci";
  const std::wstring scratch = argv[2];
  const std::wstring fixture = argv[3];

  g_job = CreateJobObjectW(nullptr, nullptr);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (g_job == nullptr ||
      !SetInformationJobObject(g_job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)))
    return 2;
  {
    HANDLE token = nullptr;
    TOKEN_ELEVATION elevation{};
    DWORD bytes = 0;
    if (OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token) &&
        GetTokenInformation(token, TokenElevation, &elevation, sizeof(elevation), &bytes))
      g_self_elevated = elevation.TokenIsElevated != 0;
    if (token != nullptr) CloseHandle(token);
  }
  std::cout << "self elevated=" << g_self_elevated << "\n";

  // Sprint Coder stands in as a process of this program's that has no children: everything else
  // here is an outsider to it. The own-child case uses this program itself as the lineage root.
  const Started idle = Start(L"\"" + self + L"\" idle", CREATE_NO_WINDOW);
  Check(idle.ok, "idle_started");
  Sleep(300);
  WindowsTargetFactsContext outsider;
  outsider.roots = CurrentWindowsTargetRoots(L"");
  outsider.lineage_root_pid = idle.info.dwProcessId;
  outsider.lineage_root_creation = WindowsTargetCreationTime(idle.info.hProcess).value_or(0);
  outsider.acceptance_mode = true;
  WindowsTargetFactsContext own = CurrentWindowsTargetFactsContext("", true);
  own.roots = outsider.roots;
  Check(outsider.roots.has_value() && own.lineage_root_pid == GetCurrentProcessId(), "contexts_built");

  // cmd, and the conhost below it.
  const Started shell = Start(L"\"" + cmd + L"\" /d /k", CREATE_NO_WINDOW);
  Check(shell.ok, "cmd_started");
  Sleep(800);
  const WindowsTargetFactsMeasurement cmd_facts = Measure(shell.info.dwProcessId, nullptr, outsider);
  Print("cmd", cmd_facts);
  CheckOrdinary("cmd", cmd_facts);
  Check(Is(cmd_facts.facts.running_image_matches, true), "cmd_running_image_matches");
  Check(Is(cmd_facts.facts.image_root, "windows_directory") &&
            Is(cmd_facts.facts.image_relative_path, "system32\\cmd.exe") &&
            Is(cmd_facts.facts.image_leaf, "cmd.exe"),
        "cmd_root_windows_directory");
  Check(Is(cmd_facts.facts.signature, "valid") && Is(cmd_facts.facts.signer_microsoft_root, true) &&
            Is(cmd_facts.facts.signer_organization, "microsoft corporation"),
        "cmd_signed_by_microsoft_root");
  Check(Is(cmd_facts.facts.pe_subsystem, "console"), "cmd_console_subsystem");
  Check(Is(cmd_facts.facts.original_filename, "cmd.exe"), "cmd_original_filename");
  Check(Is(cmd_facts.facts.requires_administrator, false), "cmd_runs_as_invoker");
  Check(Is(cmd_facts.facts.own_descendant, false) && Is(cmd_facts.facts.descendant_shell, false),
        "cmd_lineage");
  Check(cmd_facts.parent_pid == std::optional<std::uint32_t>(GetCurrentProcessId()), "cmd_parent_is_us");
  Check(ClassOf(cmd_facts.facts) == "W-SYS", "cmd_refused_as_w_sys");

  const std::optional<DWORD> conhost = ChildWithLeaf(shell.info.dwProcessId, "conhost.exe");
  Check(conhost.has_value(), "conhost_found_below_cmd");
  Check(Is(cmd_facts.facts.descendant_pseudo_console, conhost.has_value()), "cmd_console_host_below");
  if (conhost.has_value()) {
    const WindowsTargetFactsMeasurement conhost_facts = Measure(*conhost, nullptr, outsider);
    Print("conhost", conhost_facts);
    CheckOrdinary("conhost", conhost_facts);
    Check(Is(conhost_facts.facts.running_image_matches, true), "conhost_running_image_matches");
    Check(Is(conhost_facts.facts.image_root, "windows_directory") &&
              Is(conhost_facts.facts.image_leaf, "conhost.exe"),
          "conhost_root_windows_directory");
    Check(Is(conhost_facts.facts.signature, "valid") &&
              Is(conhost_facts.facts.signer_microsoft_root, true),
          "conhost_signed_by_microsoft_root");
    Check(cmd_facts.parent_pid.has_value() &&
              conhost_facts.parent_pid == std::optional<std::uint32_t>(shell.info.dwProcessId),
          "conhost_parent_is_cmd");
    Check(ClassOf(conhost_facts.facts) == "W-SYS", "conhost_refused_as_w_sys");
  }

  // A copy of cmd under a name of no shell: the subsystem still says console (W4). The copy is in a
  // catalog by its hash, but outside %WINDIR% a catalog admits nothing (decision I).
  const std::wstring renamed = scratch + L"\\sc500-not-a-shell.exe";
  Check(CopyFileW(cmd.c_str(), renamed.c_str(), FALSE) == TRUE, "renamed_cmd_copied");
  const Started renamed_shell = Start(L"\"" + renamed + L"\" /d /k", CREATE_NO_WINDOW);
  Check(renamed_shell.ok, "renamed_cmd_started");
  Sleep(800);
  const WindowsTargetFactsMeasurement renamed_facts = Measure(renamed_shell.info.dwProcessId, nullptr, outsider);
  Print("renamed cmd", renamed_facts);
  CheckOrdinary("renamed_cmd", renamed_facts);
  Check(Is(renamed_facts.facts.running_image_matches, true), "renamed_cmd_running_image_matches");
  Check(Is(renamed_facts.facts.image_root, "temp") &&
            Is(renamed_facts.facts.image_leaf, "sc500-not-a-shell.exe"),
        "renamed_cmd_root_temp");
  Check(renamed_facts.signature_source == WindowsTargetSignatureSource::kCatalog &&
            Is(renamed_facts.facts.signature, "unsigned") &&
            Is(renamed_facts.facts.signer_microsoft_root, true),
        "renamed_cmd_catalog_admits_nothing");
  Check(Is(renamed_facts.facts.pe_subsystem, "console") &&
            Is(renamed_facts.facts.original_filename, "cmd.exe"),
        "renamed_cmd_still_console");
  Check(ClassOf(renamed_facts.facts) == "W4", "renamed_cmd_refused_as_w4");

  // mstsc.
  const std::wstring mstsc_path = system32 + L"\\mstsc.exe";
  const bool mstsc_present = GetFileAttributesW(mstsc_path.c_str()) != INVALID_FILE_ATTRIBUTES;
  Check(mstsc_present || !ci, "mstsc_present");
  if (mstsc_present) {
    const Started mstsc = Start(L"\"" + mstsc_path + L"\"", 0);
    Check(mstsc.ok, "mstsc_started");
    WaitForInputIdle(mstsc.info.hProcess, 10000);
    const HWND window = TopWindowOf(mstsc.info.dwProcessId);
    const WindowsTargetFactsMeasurement mstsc_facts = Measure(mstsc.info.dwProcessId, window, outsider);
    Print("mstsc", mstsc_facts);
    CheckOrdinary("mstsc", mstsc_facts);
    Check(Is(mstsc_facts.facts.running_image_matches, true), "mstsc_running_image_matches");
    Check(Is(mstsc_facts.facts.image_root, "windows_directory") &&
              Is(mstsc_facts.facts.image_leaf, "mstsc.exe"),
          "mstsc_root_windows_directory");
    Check(Is(mstsc_facts.facts.signature, "valid") && Is(mstsc_facts.facts.signer_microsoft_root, true),
          "mstsc_signed_by_microsoft_root");
    Check(Is(mstsc_facts.facts.pe_subsystem, "gui"), "mstsc_gui_subsystem");
    Check(window == nullptr || mstsc_facts.facts.window_class.has_value(), "mstsc_window_class_read");
    Check(ClassOf(mstsc_facts.facts) == "W-SYS", "mstsc_refused_as_w_sys");
  }

  // The acceptance fixture: unsigned, in %TEMP%, a GUI that runs as the invoker.
  const Started fixture_process = Start(L"\"" + fixture + L"\"", 0);
  Check(fixture_process.ok, "fixture_started");
  WaitForInputIdle(fixture_process.info.hProcess, 10000);
  const HWND fixture_window = TopWindowOf(fixture_process.info.dwProcessId);
  Check(fixture_window != nullptr, "fixture_window_found");
  const WindowsTargetFactsMeasurement fixture_facts =
      Measure(fixture_process.info.dwProcessId, fixture_window, outsider);
  Print("fixture", fixture_facts);
  CheckOrdinary("fixture", fixture_facts);
  Check(Is(fixture_facts.facts.running_image_matches, true), "fixture_running_image_matches");
  Check(Is(fixture_facts.facts.image_root, "temp") &&
            Is(fixture_facts.facts.image_leaf, "sprint-coder-computer-use-fixture.exe"),
        "fixture_root_temp");
  Check(Is(fixture_facts.facts.signature, "unsigned") && Is(fixture_facts.facts.signer_organization, "") &&
            Is(fixture_facts.facts.signer_microsoft_root, false) && fixture_facts.signer_thumbprint.empty(),
        "fixture_unsigned");
  Check(Is(fixture_facts.facts.original_filename, ""), "fixture_original_filename_not_read_unsigned");
  Check(Is(fixture_facts.facts.pe_subsystem, "gui") && Is(fixture_facts.facts.requires_administrator, false),
        "fixture_gui_as_invoker");
  Check(Is(fixture_facts.facts.window_class, "sprintcodercomputeruseacceptancefixturev1"),
        "fixture_window_class");
  Check(Is(fixture_facts.facts.acceptance_fixture, true), "fixture_named_in_acceptance_mode");
  Check(Is(fixture_facts.facts.own_descendant, false) && Is(fixture_facts.facts.descendant_shell, false) &&
            Is(fixture_facts.facts.descendant_pseudo_console, false),
        "fixture_lineage_outsider");
  Check(ClassOf(fixture_facts.facts) == "W6", "fixture_refused_as_w6");

  // The same fixture as this program's own child (W8).
  const WindowsTargetFactsMeasurement child_facts =
      Measure(fixture_process.info.dwProcessId, fixture_window, own);
  Print("own child", child_facts);
  Check(Is(child_facts.facts.own_descendant, true), "own_child_is_own_descendant");
  Check(ClassOf(child_facts.facts) == "W8", "own_child_refused_as_w8");

  // A process with a shell below it, one with a renamed copy of a shell below it, one with a GUI
  // below it, and one with a pseudo console below it (upper class C). Descendants are judged by
  // their running images: the renamed copy is a console image whose OriginalFilename is cmd's.
  const Started shell_host =
      Start(L"\"" + self + L"\" childhost \"" + cmd + L"\" /d /k", CREATE_NO_WINDOW);
  const Started renamed_host =
      Start(L"\"" + self + L"\" childhost \"" + renamed + L"\" /d /k", CREATE_NO_WINDOW);
  const Started gui_host =
      Start(L"\"" + self + L"\" childhost \"" + fixture + L"\"", CREATE_NO_WINDOW);
  const Started pty_host = Start(L"\"" + self + L"\" ptyhost", CREATE_NO_WINDOW);
  Check(shell_host.ok && renamed_host.ok && gui_host.ok && pty_host.ok, "lineage_hosts_started");
  Sleep(1500);
  const WindowsTargetFactsMeasurement shell_host_facts = Measure(shell_host.info.dwProcessId, nullptr, outsider);
  const WindowsTargetFactsMeasurement pty_host_facts = Measure(pty_host.info.dwProcessId, nullptr, outsider);
  Print("shell host", shell_host_facts);
  const WindowsTargetFactsMeasurement renamed_host_facts =
      Measure(renamed_host.info.dwProcessId, nullptr, outsider);
  const WindowsTargetFactsMeasurement gui_host_facts =
      Measure(gui_host.info.dwProcessId, nullptr, outsider);
  Print("pty host", pty_host_facts);
  Print("renamed shell host", renamed_host_facts);
  Print("gui host", gui_host_facts);
  Check(Is(shell_host_facts.facts.descendant_shell, true), "shell_below_is_found");
  Check(ChildWithLeaf(renamed_host.info.dwProcessId, "sc500-not-a-shell.exe").has_value(),
        "renamed_shell_runs_below_its_host");
  Check(Is(renamed_host_facts.facts.descendant_shell, true), "renamed_shell_below_is_found");
  Check(ClassOf(renamed_host_facts.facts) != "eligible", "renamed_shell_below_is_not_eligible");
  // (The host is a console program, so its own conhost is below it: only the shell fact is shown.)
  Check(Is(gui_host_facts.facts.descendant_shell, false), "gui_below_is_no_shell");
  Check(ChildWithLeaf(pty_host.info.dwProcessId, "conhost.exe").has_value(), "pty_conhost_below_host");
  // The program in the pseudo console (ping) is a console image, so it is a shell as well.
  Check(Is(pty_host_facts.facts.descendant_pseudo_console, true), "pseudo_console_below_is_found");
  Check(Is(shell_host_facts.facts.own_descendant, false) && Is(pty_host_facts.facts.own_descendant, false),
        "lineage_hosts_are_outsiders");

  // The running image renamed and another file (the console copy of cmd) put at its path, after the
  // process's path was read: the path read before now names the replacement, the image section the
  // renamed file. Holding the image with that path is a mismatch (W-UR), and every fact is of the
  // running image, never of the replacement.
  const std::wstring swap = scratch + L"\\sc500-swap.exe";
  const std::wstring moved = scratch + L"\\sc500-swap-moved.exe";
  Check(CopyFileW(fixture.c_str(), swap.c_str(), FALSE) == TRUE, "swap_copied");
  const Started swapped = Start(L"\"" + swap + L"\"", 0);
  Check(swapped.ok, "swap_started");
  WaitForInputIdle(swapped.info.hProcess, 10000);
  const WindowsTargetFactsMeasurement before = Measure(swapped.info.dwProcessId, nullptr, outsider);
  Print("swap before", before);
  Check(Is(before.facts.running_image_matches, true), "swap_matches_before_the_rename");
  std::wstring recorded_before;
  Check(ReadProcessPath(swapped.info.hProcess, &recorded_before), "swap_path_read_before");
  const bool renamed_running = MoveFileExW(swap.c_str(), moved.c_str(), 0) == TRUE;
  Check(renamed_running, "running_image_renamed");
  const bool replaced = renamed_running && CopyFileW(renamed.c_str(), swap.c_str(), FALSE) == TRUE;
  Check(replaced, "another_file_put_at_the_path");
  if (replaced) {
    WindowsTargetHeldImage raced;
    Check(HoldWindowsTargetRunningImage(swapped.info.hProcess, recorded_before, &raced),
          "renamed_running_image_is_held");
    Check(!raced.matches, "rename_after_the_path_was_read_is_a_mismatch");
    Check(raced.canonical_path.ends_with(L"\\sc500-swap-moved.exe"), "held_file_is_the_running_image");
    WindowsTargetFactsMeasurement stale = before;
    stale.facts.running_image_matches = raced.matches;
    Check(ClassOf(stale.facts) == "W-UR", "rename_replacement_refused_as_w_ur");

    // Measured afresh, the path is read again. Whether the system's recorded path follows a rename
    // depends on the Windows build; either way the facts are of the running image, and they match
    // exactly when the recorded path names it.
    const WindowsTargetFactsMeasurement after = Measure(swapped.info.dwProcessId, nullptr, outsider);
    Print("swap after", after);
    std::wstring recorded_after;
    const bool follows = ReadProcessPath(swapped.info.hProcess, &recorded_after) &&
                         recorded_after.ends_with(L"\\sc500-swap-moved.exe");
    std::cout << "recorded path follows the rename=" << follows << "\n";
    Check(Is(after.facts.running_image_matches, follows), "fresh_match_is_whether_the_path_names_the_image");
    Check(after.image_path.ends_with(L"\\sc500-swap-moved.exe"), "facts_are_of_the_running_image");
    Check(Is(after.facts.signature, "unsigned") &&
              after.signature_source == WindowsTargetSignatureSource::kNone &&
              Is(after.facts.pe_subsystem, "gui"),
          "facts_are_not_of_the_replacement");
    Check(ClassOf(after.facts) == (follows ? "W6" : "W-UR"), "fresh_measurement_class");
  }

  // A process that does not exist: nothing is measured.
  const WindowsTargetFactsMeasurement missing = MeasureWindowsTargetFacts(0xfffffff0u, nullptr, outsider);
  Check(!missing.creation.has_value() && !TargetFactsAreComplete(missing.facts) &&
            ClassOf(missing.facts) == "unresolvable",
        "missing_process_is_unresolvable");

  TerminateJobObject(g_job, 0);
  for (const HANDLE started : g_started) WaitForSingleObject(started, 5000);
  for (int attempt = 0; attempt < 100; ++attempt) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
    if (!QueryInformationJobObject(g_job, JobObjectBasicAccountingInformation, &accounting,
                                   sizeof(accounting), nullptr) ||
        accounting.ActiveProcesses == 0)
      break;
    Sleep(50);
  }
  std::cout << (g_failures == 0 ? "OK\n" : "FAILED\n");
  return g_failures == 0 ? 0 : 1;
}
`;

const source = [
  preamble,
  cut(
    '// The package catalog the v2 target facts read SignatureKind from',
    '#if defined(SPRINT_CODER_REQUIRE_WINDOWS_GRAPHICS_CAPTURE)',
  ),
  includes,
  'namespace {',
  cut('struct ScopedKernelHandle {', 'std::atomic<std::uint64_t> cancellation_epoch'),
  cut('std::string Utf8FromWide(std::wstring_view value) {', 'std::string JsonEscape('),
  cut('bool ReadProcessPath(HANDLE process, std::wstring *output) {', 'bool ReadFileDigest('),
  cut('// BEGIN windows target facts', '// END windows target facts'),
  '} // namespace',
  program,
].join('\n');

const build = findBuild();
const ci = process.env['CI'] !== undefined;
const onWindows = process.platform === 'win32';

describe('Windows target facts seam source', () => {
  it('cuts the facts block, and nothing in the host calls it or the core yet', () => {
    const block = cut('// BEGIN windows target facts', '// END windows target facts');
    expect(block).toContain('WindowsTargetFactsMeasurement MeasureWindowsTargetFacts(');
    // Measured, never judged, in the host: the core decides once PR-5 calls this.
    expect(host).not.toMatch(/ClassifyTarget|TargetFactsAreComplete/u);
    const outside = host.replace(block, '');
    for (const name of [
      'MeasureWindowsTargetFacts',
      'CurrentWindowsTargetFactsContext',
      'CurrentWindowsTargetRoots',
      'VerifyWindowsTargetSignature',
    ])
      expect(outside, name).not.toContain(name);
    // The V1 signer read keeps its embedded-only query and its revocation flags.
    const v1 = cut('bool ReadAuthenticodeSignerDigest(', 'std::string CurrentHelperSignerDigest(');
    expect(v1).toContain('CERT_QUERY_CONTENT_FLAG_PKCS7_SIGNED_EMBED');
    expect(v1).toContain('WTD_REVOKE_NONE');
    // Decision K: no revocation check and no network in the v2 signature either.
    expect(block).toContain('trust->fdwRevocationChecks = WTD_REVOKE_NONE;');
    expect(block).toContain('WTD_CACHE_ONLY_URL_RETRIEVAL');
    expect(block).not.toMatch(/WTD_REVOKE_WHOLECHAIN|WTD_REVOKE_CHAIN/u);
  });
});

describe.skipIf(!onWindows || (build === null && !ci))(
  'Windows target facts, live (#500 S5-c-3 PR-2)',
  () => {
    it('measures cmd, conhost, a renamed cmd, mstsc, the fixture, its own child, lineage and a rename swap', () => {
      expect(build, 'cl.exe (MSVC) is required on a Windows CI runner').not.toBeNull();
      const scratch = mkdtempSync(join(tmpdir(), 'computer-use-target-facts-'));
      try {
        const run = (args: string[]) => {
          const command = build!.wrap(args);
          return spawnSync(command.file, command.args, {
            encoding: 'utf8',
            windowsVerbatimArguments: command.verbatim,
            timeout: 400_000,
            env: { ...process.env, VSLANG: '1033' },
          });
        };
        const fixtureExecutable = join(scratch, 'sprint-coder-computer-use-fixture.exe');
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

        const seamSource = join(scratch, 'seam.cc');
        const binary = join(scratch, 'seam.exe');
        writeFileSync(seamSource, source);
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
          '/DWIN32_LEAN_AND_MEAN',
          '/D_WIN32_WINNT=0x0A00',
          `/I${nativeDirectory}`,
          seamSource,
          `/Fe:${binary}`,
          `/Fo:${binary}.obj`,
          '/link',
          '/DEBUG:NONE',
          'advapi32.lib',
          'crypt32.lib',
          'ole32.lib',
          'shell32.lib',
          'user32.lib',
          'windowsapp.lib',
          'wintrust.lib',
        ]);
        expect(built.status, `${built.stdout}\n${built.stderr}`).toBe(0);
        const executed = spawnSync(binary, [ci ? 'ci' : 'local', scratch, fixtureExecutable], {
          encoding: 'utf8',
          timeout: 180_000,
        });
        console.log(executed.stdout);
        expect(executed.status, `${executed.stdout}\n${executed.stderr}`).toBe(0);
        expect(executed.stdout).toContain('OK');
      } finally {
        rmSync(scratch, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
      }
    }, 600_000);
  },
);
