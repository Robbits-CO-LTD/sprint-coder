import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

// A LIVE seam for the Windows target facts (S5-c-3, #500 PR-2). The `windows target facts` block of
// computer_use_windows_host.cc (between its BEGIN/END markers) and the host functions it uses are
// cut out as they are and compiled into a program that measures processes it starts itself: cmd,
// the conhost under it, a copy of cmd under another name, mstsc, the acceptance fixture (built
// here), the fixture as this program's own child, a process with a shell below it, one with a
// renamed copy of cmd below it (found by its running image, not its name), one with a GUI below it,
// one with a pseudo console below it, the fixture after its running image was renamed and another file put
// at its path once that path had been read, a copy whose image file changed after its process was
// created, and a copy of cmd run from a trailing-dot name whose resources must be read through the
// held handle (the dot-less name holds another file). Each measurement is checked fact by fact, and then
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

// Copies the source to the destination and sets its PE certificate table directory size to a
// nonzero value without adding a real signature: the embedded signature is then malformed, so the
// facts must call it invalid (W-UR), not unsigned. Returns false if the file could not be patched.
bool WriteBadSignatureCopy(const std::wstring &source, const std::wstring &destination) {
  HANDLE in = CreateFileW(source.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                          FILE_ATTRIBUTE_NORMAL, nullptr);
  if (in == INVALID_HANDLE_VALUE) return false;
  std::vector<std::uint8_t> bytes(4 * 1024 * 1024);
  DWORD read = 0;
  const bool ok = ReadFile(in, bytes.data(), static_cast<DWORD>(bytes.size()), &read, nullptr) == TRUE;
  CloseHandle(in);
  if (!ok || read < 0x400) return false;
  bytes.resize(read);
  const std::size_t pe = bytes[0x3c] | (bytes[0x3d] << 8) | (bytes[0x3e] << 16) | (bytes[0x3f] << 24);
  if (pe + 24 + 240 > bytes.size() || bytes[pe] != 'P' || bytes[pe + 1] != 'E') return false;
  const std::uint16_t magic = static_cast<std::uint16_t>(bytes[pe + 24] | (bytes[pe + 25] << 8));
  const std::size_t security_size = pe + 24 + (magic == 0x20b ? 112 : 96) + 4 * 8 + 4;
  if (security_size + 4 > bytes.size()) return false;
  bytes[security_size] = 0x00;
  bytes[security_size + 1] = 0x04; // a nonzero certificate table size
  bytes[security_size + 2] = 0x00;
  bytes[security_size + 3] = 0x00;
  HANDLE out = CreateFileW(destination.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS,
                           FILE_ATTRIBUTE_NORMAL, nullptr);
  if (out == INVALID_HANDLE_VALUE) return false;
  DWORD written = 0;
  const bool wrote = WriteFile(out, bytes.data(), static_cast<DWORD>(bytes.size()), &written,
                               nullptr) == TRUE &&
                     written == bytes.size();
  CloseHandle(out);
  return wrote;
}

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

bool HasProcessWithLeaf(const std::wstring &prefix) {
  const std::optional<std::vector<WindowsProcessNode>> nodes = SnapshotWindowsTargetProcesses();
  if (!nodes.has_value()) return false;
  const std::string needle = target_eligibility_detail::AsciiLower(Utf8FromWide(prefix));
  for (const WindowsProcessNode &node : *nodes)
    if (target_eligibility_detail::AsciiLower(node.leaf).rfind(needle, 0) == 0) return true;
  return false;
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
  // The rename-follow probe runs once and must confirm it on this (NTFS) machine, with the move
  // followed and the probe volume's file system reported; the measurements below rely on it.
  const std::optional<WindowsTargetRenameProbe> rename_probe = WindowsTargetRenameFollows();
  Check(rename_probe.has_value() && rename_probe->follows &&
            rename_probe->volume.file_system == "ntfs",
        "rename_follow_probe_confirms_on_this_machine");
  outsider.rename_probe = rename_probe;
  // The probe starts and tears down a suspended child; none of its processes outlive it.
  Check(!HasProcessWithLeaf(L"sc-rename-probe-"), "rename_probe_leaves_no_process");
  // TEMP reached through an 8.3 short name still follows: the probe normalizes both sides with
  // GetFinalPathNameByHandleW before comparing. (If 8.3 is disabled, the short path equals the long
  // one, which is still a valid run of the probe.)
  {
    std::vector<wchar_t> temp(32768, L'\0');
    const DWORD n = GetTempPathW(static_cast<DWORD>(temp.size()), temp.data());
    std::vector<wchar_t> short_temp(32768, L'\0');
    const DWORD s = n > 0 && n < temp.size()
                        ? GetShortPathNameW(temp.data(), short_temp.data(),
                                            static_cast<DWORD>(short_temp.size()))
                        : 0;
    if (s > 0 && s < short_temp.size()) {
      std::vector<wchar_t> saved(32768, L'\0');
      const DWORD saved_n = GetEnvironmentVariableW(L"TMP", saved.data(),
                                                    static_cast<DWORD>(saved.size()));
      SetEnvironmentVariableW(L"TMP", short_temp.data());
      SetEnvironmentVariableW(L"TEMP", short_temp.data());
      const std::optional<WindowsTargetRenameProbe> via_short = WindowsTargetRenameFollows();
      SetEnvironmentVariableW(L"TMP", saved_n > 0 ? saved.data() : temp.data());
      SetEnvironmentVariableW(L"TEMP", saved_n > 0 ? saved.data() : temp.data());
      Check(via_short.has_value() && via_short->follows, "rename_probe_follows_through_8_3_temp");
    }
  }
  // This program stands in for Main: CurrentWindowsTargetFactsContext takes Main's pid as the
  // lineage root, so this process (and its children) are Sprint Coder's own.
  WindowsTargetFactsContext own = CurrentWindowsTargetFactsContext(GetCurrentProcessId(), "", true);
  own.roots = outsider.roots;
  Check(outsider.roots.has_value() && own.lineage_root_pid == GetCurrentProcessId() &&
            own.rename_probe.has_value() && own.rename_probe->follows,
        "contexts_built");
  Check(CurrentWindowsTargetFactsContext(0, "", true).lineage_root_pid == 0,
        "lineage_root_unmeasured_without_main");

  // The snapshot gives every process its creation time without opening it, so a process this
  // program may not open (a SYSTEM service when not elevated) is still told apart from a parent
  // whose pid it reused.
  {
    const std::optional<std::vector<WindowsProcessNode>> nodes = SnapshotWindowsTargetProcesses();
    bool timed = nodes.has_value() && nodes->size() > 4;
    std::size_t unopenable = 0;
    for (const WindowsProcessNode &node : nodes.value_or(std::vector<WindowsProcessNode>{})) {
      if (node.pid <= 4) continue;
      timed = timed && node.creation.has_value() && *node.creation > 0;
      ScopedKernelHandle opened(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, node.pid));
      if (opened.value == nullptr) ++unopenable;
    }
    std::cout << "snapshot processes=" << (nodes.has_value() ? nodes->size() : 0)
              << " not openable here=" << unopenable << "\n";
    Check(timed, "snapshot_gives_every_process_a_creation_time");
  }

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
  // A copy's ChangeTime is the copy's moment; the process must be created on a later clock tick, or
  // the image counts as changed at its creation (WindowsImageUnchangedSinceCreation's boundary).
  Sleep(100);
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

  // Remote volumes. A local fixture answers "not remote" (ERROR_INVALID_PARAMETER is the local
  // answer), and the running-image gate refuses a remote or unknown volume even when everything
  // else matches. A target on a network volume is also W-UR through image_volume. No SMB share is
  // needed: the remote result is substituted.
  {
    ScopedKernelHandle local(CreateFileW(fixture.c_str(), FILE_READ_ATTRIBUTES,
                                         FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                                         nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
    Check(WindowsTargetFileIsRemote(local.value) == std::optional<bool>(false),
          "local_fixture_is_not_remote");
    const std::optional<WindowsTargetVolume> vol =
        rename_probe.has_value() ? std::optional<WindowsTargetVolume>(rename_probe->volume)
                                 : std::nullopt;
    Check(WindowsTargetRunningImageMatches(true, false, vol, rename_probe),
          "running_image_gate_passes_local");
    Check(!WindowsTargetRunningImageMatches(true, true, vol, rename_probe) &&
              !WindowsTargetRunningImageMatches(true, std::nullopt, vol, rename_probe),
          "running_image_gate_refuses_remote_or_unknown_volume");
    // Different file system, or different volume flags, than the probe's: not a match.
    WindowsTargetVolume other_fs_vol = rename_probe->volume;
    other_fs_vol.file_system = "refs";
    WindowsTargetVolume other_flags_vol = rename_probe->volume;
    other_flags_vol.flags ^= 0x1u;
    Check(!WindowsTargetRunningImageMatches(true, false, other_fs_vol, rename_probe) &&
              !WindowsTargetRunningImageMatches(true, false, other_flags_vol, rename_probe),
          "running_image_gate_refuses_other_file_system_or_flags");
    TargetFacts network = fixture_facts.facts;
    network.image_volume = std::string("network");
    Check(ClassOf(network) == "W-UR", "network_volume_target_is_w_ur");
    network = fixture_facts.facts;
    network.running_image_matches = WindowsTargetRunningImageMatches(true, true, vol, rename_probe);
    Check(ClassOf(network) == "W-UR", "remote_held_file_target_is_w_ur");
  }

  // Fail-closed: the same target is unresolvable when the probe did not follow, when the probe is
  // missing, and when it followed but on a different file system than the target's (here the target
  // is NTFS, so a probe keyed to another file system does not apply). Substitutable here.
  {
    WindowsTargetRenameProbe no_follow;
    no_follow.follows = false;
    no_follow.volume = rename_probe->volume;
    WindowsTargetRenameProbe other_fs;
    other_fs.follows = true;
    other_fs.volume = rename_probe->volume;
    other_fs.volume.file_system = "refs";
    const std::optional<WindowsTargetRenameProbe> probes[] = {
        no_follow, other_fs, std::optional<WindowsTargetRenameProbe>()};
    for (const std::optional<WindowsTargetRenameProbe> &probe : probes) {
      WindowsTargetFactsContext degraded = outsider;
      degraded.rename_probe = probe;
      const WindowsTargetFactsMeasurement m =
          Measure(fixture_process.info.dwProcessId, fixture_window, degraded);
      Check(Is(m.facts.running_image_matches, false) && ClassOf(m.facts) == "W-UR",
            "unconfirmed_rename_follow_makes_the_target_unresolvable");
    }
  }

  // The main image is found from kernel-held data, not from the target's module list. For a benign
  // process both name the running image, so the kernel name equals the held path and the module
  // list agrees. The kernel helper is also robust: it says nothing for a handle that is not a
  // process. A test that rewrites the target's Ldr list to disagree is not run here (it would need
  // to corrupt another process); the deny-side cross-check for that is covered by the swap below.
  {
    ScopedKernelHandle probe(
        OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, FALSE, fixture_process.info.dwProcessId));
    const std::optional<std::wstring> kernel = WindowsTargetKernelImageName(probe.value);
    const std::optional<std::wstring> list = WindowsTargetModuleListImageName(probe.value);
    Check(kernel.has_value() && list.has_value() && SameWindowsTargetName(*kernel, *list),
          "kernel_image_name_and_module_list_agree_for_a_benign_process");
    Check(kernel.has_value() && kernel->ends_with(L"sprint-coder-computer-use-fixture.exe"),
          "kernel_image_name_is_the_running_image");
    Check(!WindowsTargetKernelImageName(GetCurrentThread()).has_value(),
          "kernel_image_name_is_nullopt_without_a_process_handle");
  }

  // A copy of the fixture with a non-empty certificate table directory but no real signature: a
  // malformed embedded signature is invalid (W-UR), not unsigned (which would reach the upper
  // class). Fails closed rather than treating a broken signature as "no signature".
  const std::wstring bad_sig = scratch + L"\\sc500-bad-sig.exe";
  if (WriteBadSignatureCopy(fixture, bad_sig)) {
    Sleep(100);
    const Started bad = Start(L"\"" + bad_sig + L"\"", 0);
    Check(bad.ok, "bad_signature_copy_started");
    WaitForInputIdle(bad.info.hProcess, 10000);
    const WindowsTargetFactsMeasurement bad_facts = Measure(bad.info.dwProcessId, nullptr, outsider);
    Print("bad signature", bad_facts);
    Check(Is(bad_facts.facts.signature, "invalid") &&
              bad_facts.signature_source == WindowsTargetSignatureSource::kEmbedded,
          "malformed_embedded_signature_is_invalid_not_unsigned");
    Check(ClassOf(bad_facts.facts) == "W-UR", "malformed_embedded_signature_refused_as_w_ur");
  } else {
    Check(false, "bad_signature_copy_written");
  }

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
  Sleep(100);
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
    // depends on the Windows build; either way the facts are of the running image. The rename
    // itself moved the image's ChangeTime past the process's creation, so it no longer counts as
    // unchanged since its start, and the fresh measurement is a mismatch whichever way the
    // recorded path went.
    const WindowsTargetFactsMeasurement after = Measure(swapped.info.dwProcessId, nullptr, outsider);
    Print("swap after", after);
    std::wstring recorded_after;
    const bool follows = ReadProcessPath(swapped.info.hProcess, &recorded_after) &&
                         recorded_after.ends_with(L"\\sc500-swap-moved.exe");
    std::cout << "recorded path follows the rename=" << follows << "\n";
    Check(!raced.unchanged, "renamed_running_image_is_changed_since_its_creation");
    Check(Is(after.facts.running_image_matches, false), "fresh_match_after_a_rename_is_a_mismatch");
    Check(after.image_path.ends_with(L"\\sc500-swap-moved.exe"), "facts_are_of_the_running_image");
    Check(Is(after.facts.signature, "unsigned") &&
              after.signature_source == WindowsTargetSignatureSource::kNone &&
              Is(after.facts.pe_subsystem, "gui"),
          "facts_are_not_of_the_replacement");
    Check(ClassOf(after.facts) == "W-UR", "fresh_measurement_class");
  }

  // The image file changed after its process was created (process herpaderping rewrites the bytes
  // after the section exists; a running image cannot be opened for writing, so here only its times
  // are moved, through FILE_WRITE_ATTRIBUTES, which moves ChangeTime as such a rewrite does). Before
  // the change the running image matches, although its LastWriteTime was set a day into the future
  // before it started (as a ZIP unpacked in another time zone leaves it): only ChangeTime is judged.
  // After the change, it is a mismatch (W-UR).
  {
    const std::wstring touched = scratch + L"\\sc500-touched.exe";
    Check(CopyFileW(fixture.c_str(), touched.c_str(), FALSE) == TRUE, "touched_copied");
    bool future_written = false;
    {
      ScopedKernelHandle writer(CreateFileW(touched.c_str(), FILE_WRITE_ATTRIBUTES,
                                            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                                            nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
      FILETIME now{};
      GetSystemTimeAsFileTime(&now);
      ULARGE_INTEGER later{};
      later.LowPart = now.dwLowDateTime;
      later.HighPart = now.dwHighDateTime;
      later.QuadPart += 24ull * 60 * 60 * 10'000'000;
      FILETIME future{later.LowPart, later.HighPart};
      future_written = writer.value != INVALID_HANDLE_VALUE &&
                       SetFileTime(writer.value, nullptr, nullptr, &future) == TRUE;
    }
    Check(future_written, "touched_last_write_time_set_in_the_future");
    Sleep(100);
    const Started process = Start(L"\"" + touched + L"\"", 0);
    Check(process.ok, "touched_started");
    WaitForInputIdle(process.info.hProcess, 10000);
    const WindowsTargetFactsMeasurement untouched = Measure(process.info.dwProcessId, nullptr, outsider);
    Check(Is(untouched.facts.running_image_matches, true), "image_unchanged_since_creation_matches");
    Sleep(100);
    bool moved_times = false;
    {
      ScopedKernelHandle writer(CreateFileW(touched.c_str(), FILE_WRITE_ATTRIBUTES,
                                            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                                            nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
      FILETIME now{};
      GetSystemTimeAsFileTime(&now);
      moved_times = writer.value != INVALID_HANDLE_VALUE &&
                    SetFileTime(writer.value, nullptr, nullptr, &now) == TRUE;
    }
    Check(moved_times, "touched_image_times_moved");
    const WindowsTargetFactsMeasurement changed = Measure(process.info.dwProcessId, nullptr, outsider);
    Print("touched", changed);
    Check(Is(changed.facts.running_image_matches, false) && ClassOf(changed.facts) == "W-UR",
          "image_written_after_creation_is_a_mismatch");
    WindowsTargetHeldImage held;
    Check(HoldWindowsTargetRunningImage(process.info.hProcess, std::nullopt, &held) && !held.unchanged,
          "image_written_after_creation_is_not_unchanged");
  }

  // A view read that faults is caught and is a failed read, not a crash of the helper. (A page-in
  // I/O error, EXCEPTION_IN_PAGE_ERROR, needs a failing volume; an access violation is the same
  // filter's other case, and an inaccessible address gives one here.)
  {
    std::array<std::uint8_t, 8> sink{};
    Check(!CopyWindowsTargetView(sink.data(), reinterpret_cast<const void *>(std::uintptr_t{0x10}),
                                 sink.size()),
          "view_copy_fault_is_a_failed_read");
    const std::array<std::uint8_t, 8> source{1, 2, 3, 4, 5, 6, 7, 8};
    Check(CopyWindowsTargetView(sink.data(), source.data(), source.size()) && sink == source,
          "view_copy_copies");
  }

  // The resources are read through the held handle, never by the path again. A copy of cmd runs as
  // "sc500-dot.exe." (a trailing dot, reachable only through \\?\), and the fixture sits at
  // "sc500-dot.exe", the name Win32 normalization makes of the first. Read by path, the resources
  // would be the fixture's; read through the held image, they are cmd's.
  {
    const std::wstring dotted = L"\\\\?\\" + scratch + L"\\sc500-dot.exe.";
    const std::wstring plain = scratch + L"\\sc500-dot.exe";
    Check(CopyFileW(cmd.c_str(), dotted.c_str(), FALSE) == TRUE &&
              CopyFileW(fixture.c_str(), plain.c_str(), FALSE) == TRUE,
          "trailing_dot_files_written");
    Sleep(100);
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION info{};
    std::wstring command = L"\"" + dotted + L"\" /d /k";
    const bool started = CreateProcessW(dotted.c_str(), command.data(), nullptr, nullptr, FALSE,
                                        CREATE_SUSPENDED | CREATE_NO_WINDOW, nullptr, nullptr,
                                        &startup, &info) == TRUE;
    Check(started, "trailing_dot_image_started");
    if (started) {
      AssignProcessToJobObject(g_job, info.hProcess);
      WindowsTargetHeldImage held;
      const bool holding = HoldWindowsTargetRunningImage(info.hProcess, std::nullopt, &held);
      Check(holding && held.canonical_path.ends_with(L"\\sc500-dot.exe."),
            "trailing_dot_running_image_is_held");
      Check(holding && Is(WindowsTargetOriginalFilename(held.file.value), "cmd.exe"),
            "resources_are_read_through_the_held_handle");
      TargetFacts facts;
      if (holding) ReadWindowsTargetResources(held.file.value, true, &facts);
      Check(Is(facts.original_filename, "cmd.exe") && Is(facts.requires_administrator, false),
            "verified_resources_are_of_the_held_image");
      TerminateProcess(info.hProcess, 0);
      WaitForSingleObject(info.hProcess, 5000);
      CloseHandle(info.hThread);
      CloseHandle(info.hProcess);
    }
    for (int attempt = 0; attempt < 50 && GetFileAttributesW(dotted.c_str()) != INVALID_FILE_ATTRIBUTES;
         ++attempt)
      if (DeleteFileW(dotted.c_str()) != TRUE) Sleep(100);
    Check(GetFileAttributesW(dotted.c_str()) == INVALID_FILE_ATTRIBUTES, "trailing_dot_file_removed");
  }

  // A real AnyCPU .NET exe, if one ships with Windows, must not disagree with the kernel header
  // (the loader converts it PE32 -> PE32+). Copy it to a writable temp path (the anchor renames
  // during measurement), start it suspended, and read its facts. Skipped when none is found.
  {
    std::vector<wchar_t> windows(32768, L'\0');
    const UINT wn = GetSystemWindowsDirectoryW(windows.data(), static_cast<UINT>(windows.size()));
    const std::wstring root(windows.data(), wn);
    const std::wstring candidates[] = {
        root + L"\\Microsoft.NET\\Framework64\\v4.0.30319\\InstallUtil.exe",
        root + L"\\Microsoft.NET\\Framework64\\v4.0.30319\\RegSvcs.exe",
        root + L"\\Microsoft.NET\\Framework\\v4.0.30319\\InstallUtil.exe"};
    std::wstring dotnet;
    for (const std::wstring &c : candidates)
      if (dotnet.empty() && GetFileAttributesW(c.c_str()) != INVALID_FILE_ATTRIBUTES) {
        std::vector<std::uint8_t> head(4096);
        HANDLE h = CreateFileW(c.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                               FILE_ATTRIBUTE_NORMAL, nullptr);
        DWORD got = 0;
        OVERLAPPED at{};
        const bool read = h != INVALID_HANDLE_VALUE &&
                          ReadFile(h, head.data(), static_cast<DWORD>(head.size()), &got, &at) == TRUE;
        if (h != INVALID_HANDLE_VALUE) CloseHandle(h);
        head.resize(got);
        const std::optional<PeImageSummary> s = ParsePeImageSummary(head);
        if (read && s.has_value() && s->clr_bitness_convertible == std::optional<bool>(true))
          dotnet = c;
      }
    if (!dotnet.empty()) {
      const std::wstring copy = scratch + L"\\sc500-dotnet.exe";
      Check(CopyFileW(dotnet.c_str(), copy.c_str(), FALSE) == TRUE, "anycpu_dotnet_copied");
      Sleep(100);
      // Start suspended and never resume: the image is mapped at creation, so its facts are
      // measurable, while the util never runs (it would otherwise exit at once with no args).
      STARTUPINFOW startup{};
      startup.cb = sizeof(startup);
      PROCESS_INFORMATION info{};
      std::wstring command = L"\"" + copy + L"\"";
      const bool started =
          CreateProcessW(nullptr, command.data(), nullptr, nullptr, FALSE,
                         CREATE_SUSPENDED | CREATE_NO_WINDOW, nullptr, nullptr, &startup, &info);
      Check(started, "anycpu_dotnet_started");
      if (started) AssignProcessToJobObject(g_job, info.hProcess);
      const WindowsTargetFactsMeasurement net_facts =
          Measure(info.dwProcessId, nullptr, outsider);
      Print("anycpu dotnet", net_facts);
      // When the image resolved, the AnyCPU exe's running image matches despite the PE32->PE32+
      // conversion (the header cross-check skips the converted fields), so it is not W-UR for that
      // reason. If the image could not be held in this environment (empty path), skip rather than
      // fail: the deterministic guarantee is the harness CLR test. The header cross-check never
      // refused it (that is the regression guarded here).
      if (net_facts.facts.running_image_matches.has_value())
        Check(Is(net_facts.facts.running_image_matches, true),
              "anycpu_dotnet_running_image_matches_despite_bitness_conversion");
      else
        std::cout << "anycpu dotnet image not resolvable here; skipped\n";
    } else {
      std::cout << "no AnyCPU .NET exe found; skipped\n";
    }
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

// S5-c-3 PR-4 (#500): the v2 package identity is added beside the V1 identity, never in it. The V1
// identity JSON and the V1 digest formula are pinned here as text, so a v1 build writes byte for
// byte what it wrote before, and the package identity is answered only by a v2 build.
const v1IdentityJson = String.raw`std::string WindowsIdentityJson(const WindowsExecutableIdentity &identity,
                                std::uint32_t pid = 0) {
  return "{\"platform\":\"win32\",\"identityDigest\":\"" +
         identity.identity_digest + "\",\"executablePath\":\"" +
         JsonEscape(identity.path_utf8) + "\",\"executableDigest\":\"" +
         identity.executable_digest + "\",\"signerDigest\":" +
         (identity.signer_digest.empty()
              ? "null"
              : "\"" + identity.signer_digest + "\"") +
         ",\"packageFamilyName\":null,\"appUserModelId\":null,\"displayName\":"
         "\"" +
         JsonEscape(identity.display_name) + "\"" +
         ",\"policyLanguage\":\"" + identity.policy_language + "\"" +
         ",\"maximumMode\":\"" + MaximumModeForWindowsExecutable(identity) +
         "\"" +
         (pid == 0 ? "" : ",\"pid\":" + std::to_string(pid)) + "}";
}

`;
const v1IdentityDigest = String.raw`  const std::string identity_digest =
      signer_digest.empty()
          ? Sha256String("computer-win-identity-v1-unsigned\n" +
                         executable_digest)
          : Sha256String("computer-win-identity-v1-signed\n" + normalized_path +
                         "\n" + signer_digest);`;

describe('Windows package identity source (#500 S5-c-3 PR-4)', () => {
  it('leaves the V1 identity byte for byte, and answers a package identity only in a v2 build', () => {
    expect(cut('std::string WindowsIdentityJson(', 'bool PickWindowsExecutable(')).toBe(
      v1IdentityJson,
    );
    expect(host.split(v1IdentityDigest)).toHaveLength(2);
    const block = cut('// BEGIN windows package identity', '// END windows package identity');
    // The v1 build's answer is std::nullopt before anything is read.
    expect(block).toContain(
      [
        '                             const WindowsExecutableIdentity &identity) {',
        '  if constexpr (!sprint_coder::computer_use::kNativeEligibilityIsV2) {',
        '    (void)measured;',
        '    (void)identity;',
        '    return std::nullopt;',
        '  } else {',
      ].join('\n'),
    );
    // Nothing outside the block calls it or writes its fields yet (PR-5 wires it).
    const outside = host.replace(block, '');
    for (const name of [
      'WindowsTargetPackageIdentity',
      'WindowsPackageIdentityJson',
      'WindowsPackageIdentityFor',
      'packagePublisherId',
      'packageRelativePath',
    ])
      expect(outside, name).not.toContain(name);
    // Main recomputes the digest with the same domain the portable formula uses.
    const facts = readFileSync(
      join(nativeDirectory, 'computer_use_windows_target_facts.h'),
      'utf8',
    );
    const grant = readFileSync(join(__dirname, 'computer-use-grant-identity.ts'), 'utf8');
    expect(facts).toContain(
      'inline constexpr std::string_view kWindowsPackageIdentityDomain = "computer-win-identity-v2-package";',
    );
    expect(grant).toContain('`computer-win-identity-v2-package\\n${windowsPackage.family}');
  });
});

describe.skipIf(!onWindows || (build === null && !ci))(
  'Windows target facts, live (#500 S5-c-3 PR-2)',
  () => {
    it('measures cmd, conhost, a renamed cmd, mstsc, the fixture, its own child, lineage and a rename swap', async () => {
      expect(build, 'cl.exe (MSVC) is required on a Windows CI runner').not.toBeNull();
      const scratch = mkdtempSync(join(tmpdir(), 'computer-use-target-facts-'));
      try {
        // The two builds and the live seam can exceed Vitest's 60s RPC deadline together.
        // Yield while each child runs so the worker can receive reporting acknowledgements.
        const run = (args: string[]) => {
          const command = build!.wrap(args);
          return promisify(execFile)(command.file, command.args, {
            encoding: 'utf8',
            windowsVerbatimArguments: command.verbatim,
            timeout: 400_000,
            env: { ...process.env, VSLANG: '1033' },
          });
        };
        const fixtureExecutable = join(scratch, 'sprint-coder-computer-use-fixture.exe');
        await run([
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

        const seamSource = join(scratch, 'seam.cc');
        const binary = join(scratch, 'seam.exe');
        writeFileSync(seamSource, source);
        await run([
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
        const executed = await promisify(execFile)(
          binary,
          [ci ? 'ci' : 'local', scratch, fixtureExecutable],
          {
            encoding: 'utf8',
            timeout: 180_000,
          },
        );
        console.log(executed.stdout);
        expect(executed.stdout).toContain('OK');
      } finally {
        rmSync(scratch, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
      }
    }, 600_000);
  },
);
