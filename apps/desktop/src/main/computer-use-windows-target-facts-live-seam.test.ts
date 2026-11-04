import { readWindowsHostSource } from '../../../../computer-use-windows-host-source.mjs';
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
const host = readWindowsHostSource();
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
#include <functional>
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

void CheckStoreNotepadBinding(const TargetFacts &facts,
                             const WindowsPackageIdentityFacts &package,
                             const WindowsFileKey &key) {
  const auto parts = WindowsPackageIdentityFor(package);
  Check(parts.has_value(), "store_notepad_verified_package");
  const auto judge = [&](const TargetFacts &f, const std::optional<WindowsPackageIdentityParts> &p,
                         const std::optional<WindowsFileKey> &held,
                         const std::optional<WindowsFileKey> &recorded, bool session) {
    return WindowsTargetIsNotWebByTable(f, held, std::nullopt, recorded, session, p);
  };
  Check(judge(facts, parts, key, std::nullopt, false) == kWindowsStoreNotepadNotWeb,
        "store_notepad_requires_verified_package_and_file_key");
  Check(judge(facts, parts, key, key, true) == kWindowsStoreNotepadNotWeb,
        "store_notepad_retains_session_file_binding");
  Check(!judge(facts, std::nullopt, key, key, true), "store_notepad_family_alone_rejected");
  Check(!judge(facts, parts, std::nullopt, key, true), "store_notepad_missing_held_key_rejected");
  Check(!judge(facts, parts, key, std::nullopt, true), "store_notepad_missing_session_key_rejected");
  WindowsFileKey changed = key;
  changed.file_id[0] ^= 1;
  Check(!judge(facts, parts, changed, key, true), "package_update_invalidates_session_file_binding");
  changed = key;
  changed.volume_serial ^= 1;
  Check(!judge(facts, parts, changed, key, true), "store_notepad_changed_volume_rejected");
  if (parts.has_value()) {
    auto wrong = *parts;
    wrong.publisher_id = "0000000000000";
    Check(!judge(facts, wrong, key, key, true), "store_notepad_wrong_publisher_rejected");
    wrong = *parts;
    wrong.relative_path = "other\\notepad.exe";
    Check(!judge(facts, wrong, key, key, true), "store_notepad_wrong_relative_path_rejected");
    wrong = *parts;
    wrong.family = "Example.Editor_8wekyb3d8bbwe";
    Check(!judge(facts, wrong, key, key, true), "store_notepad_wrong_family_rejected");
  }
  auto bad = facts;
  bad.package_development_mode = true;
  Check(!judge(bad, parts, key, key, true), "store_notepad_development_rejected");
  bad = facts;
  bad.package_signature_kind = "developer";
  Check(!judge(bad, parts, key, key, true), "store_notepad_developer_signature_rejected");
  bad = facts;
  bad.running_image_matches = false;
  Check(!judge(bad, parts, key, key, true), "store_notepad_running_image_mismatch_rejected");
  bad = facts;
  bad.image_volume = "network";
  Check(!judge(bad, parts, key, key, true), "store_notepad_remote_rejected");
  bad = facts;
  bad.image_root = "program_files";
  Check(!judge(bad, parts, key, key, true), "store_notepad_outside_windows_apps_rejected");
  bad = facts;
  bad.pe_subsystem = "console";
  Check(!judge(bad, parts, key, key, true), "store_notepad_non_gui_rejected");
  bad = facts;
  bad.package_family = "Example.Editor_8wekyb3d8bbwe";
  Check(!judge(bad, parts, key, key, true), "store_notepad_mismatched_facts_rejected");
  // The literal family is pinned on its own: the facts and the parts agreeing on another family of
  // the same publisher, or on a case variant of Notepad's, is still refused.
  if (parts.has_value()) {
    for (const char *other : {"Microsoft.Other_8wekyb3d8bbwe", "microsoft.windowsnotepad_8wekyb3d8bbwe"}) {
      auto agreed = facts;
      agreed.package_family = other;
      auto agreed_parts = *parts;
      agreed_parts.family = other;
      Check(!judge(agreed, agreed_parts, key, key, true), "store_notepad_other_family_rejected");
    }
  }
  auto dev = package;
  dev.development_mode = true;
  Check(!judge(facts, WindowsPackageIdentityFor(dev), key, key, true),
        "store_notepad_unverified_package_rejected");
}

void CheckInstalledStoreNotepad(const WindowsTargetFactsContext &context) {
  UINT32 count = 0;
  UINT32 length = 0;
  const LONG queried = GetPackagesByPackageFamily(L"Microsoft.WindowsNotepad_8wekyb3d8bbwe",
                                                 &count, nullptr, &length, nullptr);
  if (queried == ERROR_SUCCESS && count == 0) {
    std::cout << "SKIP store_notepad_not_installed\n";
    return;
  }
  Check(queried == ERROR_INSUFFICIENT_BUFFER && count > 0, "store_notepad_package_query");
  if (queried != ERROR_INSUFFICIENT_BUFFER || count == 0) return;
  std::vector<PWSTR> names(count);
  std::vector<wchar_t> buffer(length);
  if (GetPackagesByPackageFamily(L"Microsoft.WindowsNotepad_8wekyb3d8bbwe", &count,
                                names.data(), &length, buffer.data()) != ERROR_SUCCESS) {
    Check(false, "store_notepad_package_names");
    return;
  }
  UINT32 root_length = 0;
  Check(GetPackagePathByFullName(names[0], &root_length, nullptr) == ERROR_INSUFFICIENT_BUFFER,
        "store_notepad_install_root_size");
  if (root_length == 0) return;
  std::vector<wchar_t> root(root_length);
  if (GetPackagePathByFullName(names[0], &root_length, root.data()) != ERROR_SUCCESS) {
    Check(false, "store_notepad_install_root");
    return;
  }
  const std::wstring image = std::wstring(root.data()) + L"\\Notepad\\Notepad.exe";
  std::wstring command = L"\"" + image + L"\"";
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION process{};
  // Measure our suspended image: no UI, document restore, or hand-off to an existing Notepad.
  if (!CreateProcessW(image.c_str(), command.data(), nullptr, nullptr, FALSE, CREATE_SUSPENDED,
                      nullptr, nullptr, &startup, &process)) {
    Check(false, "store_notepad_create_suspended");
    return;
  }
  // A packaged app can refuse this job (Windows puts it in the package's own job), so a process
  // outside the job is ended here once measured; it never runs, being suspended throughout.
  struct Outside {
    HANDLE process = nullptr;
    ~Outside() {
      if (process == nullptr) return;
      TerminateProcess(process, 1);
      WaitForSingleObject(process, 5000);
      CloseHandle(process);
    }
  } outside;
  if (AssignProcessToJobObject(g_job, process.hProcess)) g_started.push_back(process.hProcess);
  else outside.process = process.hProcess;
  CloseHandle(process.hThread);
  const auto measured = Measure(process.dwProcessId, nullptr, context);
  Check(measured.file_identity.has_value(), "store_notepad_measured_file_key");
  if (!measured.file_identity.has_value()) return;
  WindowsFileKey key;
  key.volume_serial = measured.file_identity->volume_serial;
  std::memcpy(key.file_id.data(), measured.file_identity->file_id.Identifier, key.file_id.size());
  // Suspended, the module list is not readable yet, so the hold refuses and Notepad is not taken as
  // not-web; running it would open a window on the desktop. The package facts are real, so check
  // the binding as for a running image whose hold matched.
  const WindowsPackageIdentityFacts identity{measured.facts.packaged,
      measured.facts.package_signature_kind, measured.facts.package_development_mode,
      measured.facts.package_family, measured.package_publisher_id, measured.facts.image_root,
      WindowsTargetUtf8(measured.image_path), measured.package_install_root};
  Check(measured.facts.running_image_matches != std::optional<bool>(true) &&
            !WindowsTargetIsNotWebByTable(measured.facts, key, std::nullopt, std::nullopt, false,
                WindowsPackageIdentityFor(identity)),
        "store_notepad_suspended_hold_refused");
  auto facts = measured.facts;
  facts.running_image_matches = true;
  CheckStoreNotepadBinding(facts, identity, key);
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
  // The rename-follow probe runs once and must confirm it on this (NTFS) machine, with the move
  // followed and the probe volume's file system reported; the measurements below rely on it.
  const std::optional<WindowsTargetRenameProbe> rename_probe = WindowsTargetRenameFollows();
  Check(rename_probe.has_value() && rename_probe->follows &&
            rename_probe->volume.file_system == "ntfs",
        "rename_follow_probe_confirms_on_this_machine");
  outsider.rename_probe = rename_probe;
  // The probe starts and tears down a suspended child; none of its processes outlive it.
  Check(!HasProcessWithLeaf(L"sc-rename-probe-"), "rename_probe_leaves_no_process");
  {
    const wchar_t *variable = L"SPRINT_CODER_COMPUTER_USE_HELPER_TEMP";
    std::vector<wchar_t> saved(32768, L'\0');
    const DWORD saved_length = GetEnvironmentVariableW(variable, saved.data(),
                                                       static_cast<DWORD>(saved.size()));
    Check(saved_length < saved.size(), "helper_temp_environment_fits");
    const std::wstring dedicated = scratch + L"\\helper-probe-temp";
    Check(CreateDirectoryW(dedicated.c_str(), nullptr) == TRUE, "helper_temp_directory_created");
    const auto has_probe = [](const std::wstring &directory) {
      const std::wstring pattern = directory + L"\\sc-rename-probe-" +
                                  std::to_wstring(GetCurrentProcessId()) + L"-*";
      WIN32_FIND_DATAW data{};
      HANDLE found = FindFirstFileW(pattern.c_str(), &data);
      if (found == INVALID_HANDLE_VALUE) return false;
      FindClose(found);
      return true;
    };
    Check(SetEnvironmentVariableW(variable, dedicated.c_str()) == TRUE,
          "helper_temp_without_trailing_separator_set");
    bool observed_dedicated = false;
    const auto dedicated_probe = WindowsTargetRenameFollows([&] {
      observed_dedicated = has_probe(dedicated) || observed_dedicated;
      return true;
    });
    Check(dedicated_probe.has_value() && dedicated_probe->follows && observed_dedicated,
          "rename_probe_runs_inside_helper_temp_without_trailing_separator");
    Check(RemoveDirectoryW(dedicated.c_str()) == TRUE, "helper_temp_empty_after_probe");

    std::vector<wchar_t> temp(32768, L'\0');
    const DWORD temp_length = GetTempPathW(static_cast<DWORD>(temp.size()), temp.data());
    Check(temp_length > 0 && temp_length < temp.size(), "fallback_temp_available");
    const std::wstring fallback(temp.data(), temp_length);
    for (const std::wstring &invalid : {std::wstring(L"relative-helper-temp"), dedicated}) {
      Check(SetEnvironmentVariableW(variable, invalid.c_str()) == TRUE, "invalid_helper_temp_set");
      bool observed_fallback = false;
      const auto fallback_probe = WindowsTargetRenameFollows([&] {
        observed_fallback = has_probe(fallback) || observed_fallback;
        return true;
      });
      Check(fallback_probe.has_value() && fallback_probe->follows && observed_fallback,
            "invalid_helper_temp_uses_GetTempPathW");
      Check(!has_probe(fallback), "fallback_probe_files_removed");
    }
    Check(SetEnvironmentVariableW(variable, saved_length > 0 ? saved.data() : nullptr) == TRUE,
          "helper_temp_environment_restored");
  }
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
  WindowsTargetFactsContext own = CurrentWindowsTargetFactsContext(GetCurrentProcessId(), "");
  own.roots = outsider.roots;
  Check(outsider.roots.has_value() && own.lineage_root_pid == GetCurrentProcessId() &&
            own.rename_probe.has_value() && own.rename_probe->follows,
        "contexts_built");
  Check(CurrentWindowsTargetFactsContext(0, "").lineage_root_pid == 0,
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

  // S5-c-3 PR-5 (#500, the PR-2 review's merge condition): the anchor's premises fixed without a
  // machine that has them. The fixture's running image is held as MeasureWindowsTargetFacts holds it,
  // then the held image's volume is substituted (a remote volume, an unknown remoteness, another
  // file system than the probe's, an unreadable volume) and the facts are read from it as the
  // production path reads them (MeasureWindowsTargetHeldFacts). Each is W-UR or unresolvable, the
  // running image never matches, and nothing an admission rests on is given: no verdict is
  // selectable, and for a remote or unknown volume no signature, subsystem or OriginalFilename is
  // read at all. The control (the hold as it is) still matches.
  {
    ScopedKernelHandle process(OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, FALSE,
                                           fixture_process.info.dwProcessId));
    std::wstring recorded_path;
    const bool recorded = process.value != nullptr && ReadProcessPath(process.value, &recorded_path);
    Check(recorded, "anchor_seam_fixture_path_read");
    const WindowsTargetFactsMeasurement base =
        Measure(fixture_process.info.dwProcessId, fixture_window, outsider);
    const auto held_facts = [&](auto change) {
      WindowsTargetHeldImage held;
      const bool holds = HoldWindowsTargetRunningImage(
          process.value, std::optional<std::wstring>(recorded_path), &held);
      Check(holds, "anchor_seam_fixture_held");
      change(held);
      WindowsTargetFactsMeasurement measured = base;
      MeasureWindowsTargetHeldFacts(held, outsider, &measured);
      return measured;
    };
    const auto selectable = [](const WindowsTargetFactsMeasurement &m) {
      const TargetVerdictKind kind = ClassifyTarget(m.facts).kind;
      return kind == TargetVerdictKind::kEligible || kind == TargetVerdictKind::kUpper;
    };
    const WindowsTargetFactsMeasurement control = held_facts([](WindowsTargetHeldImage &) {});
    Check(Is(control.facts.running_image_matches, true) &&
              control.facts.signature.has_value() && control.facts.pe_subsystem.has_value(),
          "anchor_seam_control_matches");
    const WindowsTargetFactsMeasurement remote =
        held_facts([](WindowsTargetHeldImage &h) { h.remote = true; });
    const WindowsTargetFactsMeasurement unknown_remote =
        held_facts([](WindowsTargetHeldImage &h) { h.remote.reset(); });
    for (const WindowsTargetFactsMeasurement *m : {&remote, &unknown_remote}) {
      Check(Is(m->facts.running_image_matches, false) && !selectable(*m) &&
                (ClassOf(m->facts) == "W-UR" || ClassOf(m->facts) == "unresolvable"),
            "anchor_seam_remote_or_unknown_volume_is_w_ur");
      Check(!m->facts.signature.has_value() && !m->facts.signer_microsoft_root.has_value() &&
                !m->facts.pe_subsystem.has_value() && !m->facts.original_filename.has_value() &&
                m->signer_thumbprint.empty(),
            "anchor_seam_remote_volume_reads_no_admitting_fact");
    }
    const WindowsTargetFactsMeasurement refs = held_facts([](WindowsTargetHeldImage &h) {
      if (h.volume.has_value()) h.volume->file_system = "refs";
    });
    const WindowsTargetFactsMeasurement no_volume =
        held_facts([](WindowsTargetHeldImage &h) { h.volume.reset(); });
    for (const WindowsTargetFactsMeasurement *m : {&refs, &no_volume})
      Check(Is(m->facts.running_image_matches, false) && !selectable(*m) &&
                ClassOf(m->facts) == "W-UR",
            "anchor_seam_other_file_system_than_the_probe_is_w_ur");
    // A probe that failed (no answer), did not follow, or followed on another file system: the same.
    WindowsTargetRenameProbe no_follow;
    no_follow.volume = rename_probe->volume;
    WindowsTargetRenameProbe other_fs;
    other_fs.follows = true;
    other_fs.volume = rename_probe->volume;
    other_fs.volume.file_system = "refs";
    for (const std::optional<WindowsTargetRenameProbe> &probe :
         {std::optional<WindowsTargetRenameProbe>(), std::optional<WindowsTargetRenameProbe>(no_follow),
          std::optional<WindowsTargetRenameProbe>(other_fs)}) {
      WindowsTargetFactsContext degraded = outsider;
      degraded.rename_probe = probe;
      WindowsTargetHeldImage held;
      Check(HoldWindowsTargetRunningImage(process.value, std::optional<std::wstring>(recorded_path),
                                          &held),
            "anchor_seam_fixture_held_for_probe");
      WindowsTargetFactsMeasurement measured = base;
      MeasureWindowsTargetHeldFacts(held, degraded, &measured);
      Check(Is(measured.facts.running_image_matches, false) && !selectable(measured) &&
                ClassOf(measured.facts) == "W-UR",
            "anchor_seam_probe_failure_is_w_ur");
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

  // S5-c-3 PR-5 (#500, the PR-2 review's merge condition, measured on this runner): IL-only .NET
  // images, each copied to the scratch directory and started suspended (never run). For each, the
  // kernel's SECTION_IMAGE_INFORMATION is read directly and set beside the file's PE header: PE32
  // AnyCPU (AddInUtil, EdmGen, dfsvc), PE32 32BITREQUIRED (Framework InstallUtil) and, as the
  // control, PE32+ IL-only (Framework64 InstallUtil). PR-2 expected the loader's PE32 -> PE32+
  // conversion to show in the kernel's record; on Windows 11 26200 it does not: every compared
  // value equals the header (machine included), and the recorded entry point is the preferred
  // ImageBase + AddressOfEntryPoint, outside every MEM_IMAGE region. So the running image cannot be
  // held from the kernel's record and the target is unresolvable: no IL-only image is admitted by
  // this path, and none is admitted by skipping a header field (the skip was removed). A runner
  // whose kernel record differs from the header fails here, so the exclusion list is looked at again.
  {
    struct SectionImageInformation {
      PVOID transfer_address;
      ULONG zero_bits;
      SIZE_T maximum_stack_size;
      SIZE_T committed_stack_size;
      ULONG sub_system_type;
      ULONG sub_system_version;
      ULONG operating_system_version;
      USHORT image_characteristics;
      USHORT dll_characteristics;
      USHORT machine;
      UCHAR image_contains_code;
      UCHAR image_flags;
      ULONG loader_flags;
      ULONG image_file_size;
      ULONG check_sum;
    };
    using QueryFn = LONG(WINAPI *)(HANDLE, ULONG, PVOID, ULONG, PULONG);
    const auto query = reinterpret_cast<QueryFn>(
        GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryInformationProcess"));
    std::vector<wchar_t> windows(32768, L'\0');
    const UINT wn = GetSystemWindowsDirectoryW(windows.data(), static_cast<UINT>(windows.size()));
    const std::wstring root(windows.data(), wn);
    struct Candidate {
      std::wstring path;
      bool any_cpu;
      const char *name;
    };
    const Candidate candidates[] = {
        {root + L"\\Microsoft.NET\\Framework\\v4.0.30319\\AddInUtil.exe", true, "AddInUtil (PE32 AnyCPU)"},
        {root + L"\\Microsoft.NET\\Framework\\v4.0.30319\\EdmGen.exe", true, "EdmGen (PE32 AnyCPU)"},
        {root + L"\\Microsoft.NET\\Framework\\v4.0.30319\\dfsvc.exe", true, "dfsvc (PE32 AnyCPU, GUI)"},
        {root + L"\\Microsoft.NET\\Framework\\v4.0.30319\\InstallUtil.exe", false,
         "InstallUtil (PE32 32BITREQUIRED)"},
        {root + L"\\Microsoft.NET\\Framework64\\v4.0.30319\\InstallUtil.exe", false,
         "InstallUtil (PE32+ IL-only)"}};
    int measured_any_cpu = 0;
    int index = 0;
    for (const Candidate &candidate : candidates) {
      ++index;
      if (GetFileAttributesW(candidate.path.c_str()) == INVALID_FILE_ATTRIBUTES) {
        std::cout << "il-only " << candidate.name << ": not on this machine; skipped\n";
        continue;
      }
      const std::wstring copy = scratch + L"\\sc500-ilonly-" + std::to_wstring(index) + L".exe";
      Check(CopyFileW(candidate.path.c_str(), copy.c_str(), FALSE) == TRUE, "il_only_copied");
      std::vector<std::uint8_t> head(64 * 1024);
      DWORD got = 0;
      LARGE_INTEGER size{};
      {
        ScopedKernelHandle file(CreateFileW(copy.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
                                            OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
        Check(file.value != INVALID_HANDLE_VALUE &&
                  ReadFile(file.value, head.data(), static_cast<DWORD>(head.size()), &got, nullptr) ==
                      TRUE &&
                  GetFileSizeEx(file.value, &size) == TRUE,
              "il_only_header_read");
      }
      head.resize(got);
      const std::optional<PeImageSummary> summary = ParsePeImageSummary(head);
      Check(summary.has_value() &&
                summary->clr_bitness_convertible == std::optional<bool>(candidate.any_cpu),
            "il_only_header_says_which_is_any_cpu");
      if (!summary.has_value()) continue;
      Sleep(100);
      STARTUPINFOW startup{};
      startup.cb = sizeof(startup);
      PROCESS_INFORMATION info{};
      std::wstring command = L"\"" + copy + L"\"";
      const bool started =
          CreateProcessW(nullptr, command.data(), nullptr, nullptr, FALSE,
                         CREATE_SUSPENDED | CREATE_NO_WINDOW, nullptr, nullptr, &startup, &info);
      Check(started, "il_only_started");
      if (!started) continue;
      AssignProcessToJobObject(g_job, info.hProcess);
      g_started.push_back(info.hProcess);
      CloseHandle(info.hThread);
      SectionImageInformation kernel{};
      ULONG returned = 0;
      const bool kernel_read = query != nullptr &&
                               query(info.hProcess, 37, &kernel, sizeof(kernel), &returned) >= 0;
      MEMORY_BASIC_INFORMATION region{};
      const bool in_image =
          kernel_read &&
          VirtualQueryEx(info.hProcess, kernel.transfer_address, &region, sizeof(region)) ==
              sizeof(region) &&
          region.Type == MEM_IMAGE;
      std::cout << "il-only " << candidate.name << ": file machine=0x" << std::hex
                << summary->machine << " kernel machine=0x" << kernel.machine << " file entry=0x"
                << summary->entry_rva << " kernel transfer=0x"
                << reinterpret_cast<std::uintptr_t>(kernel.transfer_address)
                << " in MEM_IMAGE=" << (in_image ? "yes" : "no") << " checksum file/kernel=0x"
                << summary->check_sum << "/0x" << kernel.check_sum << " image size file/kernel=0x"
                << size.QuadPart << "/0x" << kernel.image_file_size << " stack file/kernel=0x"
                << summary->stack_reserve.value_or(0) << "/0x" << kernel.maximum_stack_size
                << " characteristics file/kernel=0x" << summary->image_characteristics.value_or(0)
                << "/0x" << kernel.image_characteristics << " dll file/kernel=0x"
                << summary->dll_characteristics.value_or(0) << "/0x" << kernel.dll_characteristics
                << std::dec << "\n";
      Check(kernel_read && kernel.machine == summary->machine &&
                kernel.sub_system_type == summary->subsystem_code &&
                kernel.check_sum == summary->check_sum &&
                kernel.image_file_size == static_cast<ULONG>(size.QuadPart) &&
                summary->image_characteristics ==
                    std::optional<std::uint16_t>(kernel.image_characteristics) &&
                summary->dll_characteristics ==
                    std::optional<std::uint16_t>(kernel.dll_characteristics) &&
                summary->stack_reserve == std::optional<std::uint64_t>(kernel.maximum_stack_size) &&
                summary->stack_commit == std::optional<std::uint64_t>(kernel.committed_stack_size),
            "il_only_kernel_record_equals_the_header");
      const WindowsTargetFactsMeasurement net_facts = Measure(info.dwProcessId, nullptr, outsider);
      Print(candidate.name, net_facts);
      const TargetVerdictKind kind = ClassifyTarget(net_facts.facts).kind;
      Check(!Is(net_facts.facts.running_image_matches, true) &&
                kind != TargetVerdictKind::kEligible && kind != TargetVerdictKind::kUpper,
            "il_only_image_is_not_admitted_through_the_kernel_record");
      if (candidate.any_cpu) ++measured_any_cpu;
    }
    std::cout << "il-only AnyCPU images measured: " << measured_any_cpu << "\n";
  }

  // A process that does not exist: nothing is measured.
  CheckInstalledStoreNotepad(outsider);
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

const seamPrefix = [
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
].join('\n');
const source = `${seamPrefix}\n${program}`;

// Diagnostics exist only in the generated test translation unit, never in production.
const ilAnchorSeamPrefix = (() => {
  let instrumented = seamPrefix;
  for (const [start, end, label] of [
    [
      'WindowsTargetIlOnlyImageMapping(HANDLE',
      'std::optional<WindowsTargetKernelImage> WindowsTargetKernelImageInfo',
      'mapping',
    ],
    [
      'std::optional<WindowsTargetKernelImage> WindowsTargetKernelImageInfo',
      'std::optional<std::wstring> WindowsTargetKernelImageName',
      'kernel',
    ],
    [
      'bool HoldWindowsTargetRunningImage(',
      'std::optional<std::string> WindowsTargetVolumeKind',
      'hold',
    ],
  ] as const) {
    const from = instrumented.indexOf(start);
    const to = instrumented.indexOf(end, from);
    if (from < 0 || to < 0) throw new Error(`IL anchor diagnostic markers changed: ${label}`);
    const block = instrumented.slice(from, to);
    let rejection = 0;
    const traced = block.replace(
      /return (std::nullopt|false);/gu,
      (_, value: string) =>
        `{ std::cout << "diagnostic=${label} reject=${++rejection} last_error_hint=" << GetLastError() << "\\n"; return ${value}; }`,
    );
    instrumented = instrumented.slice(0, from) + traced + instrumented.slice(to);
  }
  const holdResult = '  held->matches = anchored && !header_disagrees && again.has_value() &&';
  const mappedResult =
    '  if (!mapped_header || !WindowsIlOnlyHeadersMatch(*header, *mapped_header, clr_flags, native64) || !within_budget())';
  if (!instrumented.includes(mappedResult))
    throw new Error('IL anchor header diagnostic marker changed');
  instrumented = instrumented.replace(
    mappedResult,
    String.raw`
  std::cout << "diagnostic=mapped_header readable=" << mapped_header.has_value()
            << " native64_known=" << native64.has_value() << " native64=" << native64.value_or(false)
            << " clr_flags_known=" << clr_flags.has_value() << " clr_flags=" << clr_flags.value_or(0)
            << " elapsed_ms=" << (GetTickCount64() - started) << "\n";
  if (mapped_header) {
    const auto print_header = [](const char *kind, const WindowsIlOnlyImageHeader &h) {
      std::cout << "diagnostic=header kind=" << kind << " magic=" << h.magic
                << " machine=" << h.machine << " entry_rva=" << h.entry_rva
                << " image_size=" << h.image_size << " timestamp=" << h.timestamp
                << " checksum=" << h.check_sum << "\n";
    };
    print_header("file", *header);
    print_header("mapped", *mapped_header);
  }
` + mappedResult,
  );
  if (!instrumented.includes(holdResult))
    throw new Error('IL anchor hold diagnostic marker changed');
  return instrumented.replace(
    holdResult,
    String.raw`
  std::cout << "diagnostic=hold anchored=" << anchored
            << " header_disagrees=" << header_disagrees << " remeasured=" << again.has_value()
            << " remeasured_name_agrees=" << (again && SameWindowsTargetName(again->mapped_name, kernel->mapped_name))
            << " recorded_agrees=" << recorded_agrees << " module_available=" << module_list.has_value()
            << " module_list_agrees=" << module_list_agrees << " unchanged=" << held->unchanged << "\n";
` + holdResult,
  );
})();

const ilAnchorProgram = String.raw`
using namespace sprint_coder::computer_use;
int failures = 0;
void Check(bool ok, const char *name) {
  if (!ok) { ++failures; std::cout << "FAIL " << name << "\n"; }
}
void CheckIlOnlyHeader() {
  for (const bool wide : {false, true}) {
    std::vector<std::uint8_t> bytes(1024);
    const auto put = [&](std::size_t at, std::uint32_t value, std::size_t width = 4) {
      for (std::size_t i = 0; i < width; ++i) bytes[at + i] = (value >> (i * 8)) & 255;
    };
    put(0, 0x5a4d, 2); put(0x3c, 0x80); put(0x80, 0x4550);
    put(0x84, wide ? 0x8664 : 0x14c, 2); put(0x86, 1, 2);
    const std::size_t optional = 0x98;
    const std::size_t optional_size = wide ? 240 : 224;
    put(0x94, optional_size, 2); put(optional, wide ? 0x20b : 0x10b, 2);
    put(optional + (wide ? 108 : 92), 16);
    const std::size_t directory = optional + (wide ? 112 : 96) + 14 * 8;
    put(directory, 0x2000); put(directory + 4, 72);
    const std::size_t section = optional + optional_size;
    put(section + 8, 512); put(section + 12, 0x2000);
    put(section + 16, 512); put(section + 20, 512);
    put(512, 72); put(528, 1);
    Check(WindowsHeldImageIsIlOnly(bytes), "clr_il_only_accepted");
    Check(WindowsHeldImageClrFlags(bytes) == std::optional<std::uint32_t>(1), "clr_flags_read");
    put(optional + 56, 0x8000);
    put(optional + (wide ? 24 : 28), 0x400000);
    if (wide) put(optional + 28, 1);
    const auto header = WindowsReadIlOnlyImageHeader(bytes);
    Check(header && header->image_base == (wide ? 0x100400000ULL : 0x400000ULL),
          "mapped_header_uses_its_own_optional_layout");
    put(528, 3);
    Check(WindowsHeldImageClrFlags(bytes) == std::optional<std::uint32_t>(3), "clr_required_flag_preserved");
    put(528, 0x20001);
    Check(WindowsHeldImageIsIlOnly(bytes), "clr_32bitpreferred_il_only_accepted");
    put(528, 0);
    Check(!WindowsHeldImageIsIlOnly(bytes), "clr_mixed_mode_rejected");
    put(528, 1); put(directory, 0);
    Check(!WindowsHeldImageIsIlOnly(bytes), "native_without_clr_rejected");
    put(directory, 0x2000); put(directory + 4, 16);
    Check(!WindowsHeldImageIsIlOnly(bytes), "short_clr_directory_rejected");
    put(directory + 4, 72);
    bytes.resize(530);
    Check(!WindowsHeldImageIsIlOnly(bytes), "unreadable_clr_flags_rejected");
  }
}
void CheckConvertedHeader() {
  WindowsIlOnlyImageHeader file{0x10b, 0x14c, 0x2000, 0x8000, 123, 456, 0x400000};
  auto mapped = file;
  mapped.magic = 0x20b;
  const auto match = [&](const WindowsIlOnlyImageHeader &disk, const WindowsIlOnlyImageHeader &memory,
                         std::optional<std::uint32_t> flags, std::optional<bool> native64) {
    return WindowsIlOnlyHeadersMatch(disk, memory, flags, native64);
  };
  Check(match(file, mapped, 1, true), "native64_il_only_pe32_conversion_accepted");
  Check(!match(file, mapped, 1, false), "wow64_conversion_rejected");
  Check(!match(file, mapped, 1, std::nullopt), "unknown_architecture_conversion_rejected");
  Check(!match(file, mapped, 0, true), "mixed_mode_conversion_rejected");
  Check(!match(file, mapped, std::nullopt, true), "missing_clr_conversion_rejected");
  Check(!match(file, mapped, 3, true), "32bitrequired_conversion_rejected");
  Check(!match(file, mapped, 0x20001, false), "32bitpreferred_wow64_conversion_rejected");
  auto wrong = mapped; wrong.machine = 0x8664;
  Check(!match(file, wrong, 1, true), "conversion_machine_mismatch_rejected");
  auto wrong_file = file; wrong_file.machine = 0x8664;
  Check(!match(wrong_file, wrong, 1, true), "non_i386_conversion_rejected");
  wrong = mapped; wrong.magic = 0x107;
  Check(!match(file, wrong, 1, true), "other_magic_conversion_rejected");
  Check(!match(mapped, file, 1, true), "reverse_conversion_rejected");
  for (auto field : {&WindowsIlOnlyImageHeader::entry_rva, &WindowsIlOnlyImageHeader::image_size,
                     &WindowsIlOnlyImageHeader::timestamp, &WindowsIlOnlyImageHeader::check_sum}) {
    wrong = mapped; ++(wrong.*field);
    Check(!match(file, wrong, 1, true), "conversion_other_field_mismatch_rejected");
  }
  Check(match(file, file, std::nullopt, std::nullopt), "equal_magic_needs_no_conversion");
}
int wmain(int argc, wchar_t **argv) {
  if (argc != 3) return 2;
  const bool protected_tool = std::wstring_view(argv[2]) == L"protected";
  const bool anycpu = std::wstring_view(argv[2]) == L"anycpu";
  CheckIlOnlyHeader();
  CheckConvertedHeader();
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION child{};
  std::wstring command = L"\"" + std::wstring(argv[1]) + L"\"";
  if (!CreateProcessW(nullptr, command.data(), nullptr, nullptr, FALSE,
                      CREATE_SUSPENDED | CREATE_NO_WINDOW, nullptr, nullptr, &startup, &child))
    return 3;
  struct Cleanup {
    PROCESS_INFORMATION &child;
    ~Cleanup() {
      TerminateProcess(child.hProcess, 0);
      WaitForSingleObject(child.hProcess, 5000);
      CloseHandle(child.hThread);
      CloseHandle(child.hProcess);
    }
  } cleanup{child};
  ScopedKernelHandle file(CreateFileW(argv[1], GENERIC_READ, FILE_SHARE_READ, nullptr,
                                      OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
  const auto initial = WindowsTargetKernelImageInfo(child.hProcess);
  if constexpr (!kExpectedIlOnlyImageAnchor) {
    Check(!initial.has_value(), "disabled_il_only_stays_unresolvable");
  } else {
    const auto check_hold = [&](const char *phase, bool running) {
      DWORD exit_code = 0;
      const bool exit_read = GetExitCodeProcess(child.hProcess, &exit_code) != FALSE;
      std::cout << "phase=" << phase << " exit_code_read=" << exit_read
                << " exit_code=" << exit_code << "\n";
      Check(exit_read && exit_code == STILL_ACTIVE, "il_only_child_still_active");
      std::wstring recorded;
      WindowsTargetHeldImage held;
      const bool path_read = ReadProcessPath(child.hProcess, &recorded);
      const bool hold_read = path_read && HoldWindowsTargetRunningImage(child.hProcess, recorded, &held);
      std::cout << "phase=" << phase << " path_read=" << path_read
                << " hold_read=" << hold_read << " held_matches=" << held.matches << "\n";
      Check(hold_read, "il_only_hold_read");
      Check(running ? held.matches : !held.matches,
            running ? "resumed_il_only_hold_matches" : "suspended_il_only_hold_refuses_module_list");
      Check(held.unchanged, "hold_image_unchanged");
      const auto context = CurrentWindowsTargetFactsContext(GetCurrentProcessId(), "");
      WindowsTargetFactsMeasurement measured;
      MeasureWindowsTargetHeldFacts(held, context, &measured);
      Check(held.il_only_anchor, "hold_records_il_only_anchor");
      if (protected_tool) {
        Check(measured.facts.image_root == std::optional<std::string>("windows_directory"),
              "framework_tool_in_protected_root");
        // A suspended tool cannot pass the module-list check. Isolate placement from that check
        // using the real held file and real roots; this does not assert full target eligibility.
        held.matches = true;
        auto placement_context = context;
        if (held.volume) placement_context.rename_probe = WindowsTargetRenameProbe{true, *held.volume};
        MeasureWindowsTargetHeldFacts(held, placement_context, &measured);
        Check(measured.facts.running_image_matches == std::optional<bool>(true),
              "protected_il_only_anchor_is_usable");
      } else {
        Check(measured.facts.image_root != std::optional<std::string>("windows_directory") &&
              measured.facts.image_root != std::optional<std::string>("program_files") &&
              measured.facts.image_root != std::optional<std::string>("windows_apps"),
              "scratch_is_outside_protected_roots");
        Check(measured.facts.running_image_matches == std::optional<bool>(false) &&
              ClassifyTargetExplained(measured.facts).verdict.kind == TargetVerdictKind::kUnresolvable,
              "unprotected_il_only_stays_unresolvable");
      }
      const auto kernel = WindowsTargetKernelImageInfo(child.hProcess);
      Check(kernel.has_value(), "hold_kernel_available");
      if (kernel)
        Check(!WindowsHeldImageDisagreesWithKernel(file.value, *kernel), "hold_kernel_header_matches");
      const auto module = WindowsTargetModuleListImageName(child.hProcess);
      const DWORD module_error = GetLastError();
      std::cout << "phase=" << phase << " kernel_available=" << kernel.has_value()
                << " module_available=" << module.has_value()
                << " module_error_hint=" << module_error << "\n";
      Check(running ? module.has_value() : !module.has_value(), "hold_module_availability_by_phase");
      if (kernel && module)
        Check(SameWindowsTargetName(kernel->mapped_name, *module), "hold_module_matches");
    };
    check_hold("suspended", false);
    if (protected_tool) {
      std::cout << (failures == 0 ? "OK\n" : "FAILED\n");
      return failures == 0 ? 0 : 1;
    }
    Check(ResumeThread(child.hThread) != static_cast<DWORD>(-1), "il_only_resumed");
    // Match the independent experiment's CLR startup interval and observe premature exit.
    const DWORD resumed_wait = WaitForSingleObject(child.hProcess, 1500);
    std::cout << "phase=resumed initial_wait=" << resumed_wait << "\n";
    Check(resumed_wait == WAIT_TIMEOUT, "il_only_alive_after_clr_startup_wait");
    check_hold("resumed", true);
    Check(initial.has_value(), "enabled_il_only_finds_main_mapping");
    if (initial.has_value()) {
      std::vector<std::uint8_t> bytes(64 * 1024);
      DWORD read = 0;
      OVERLAPPED at{};
      Check(ReadFile(file.value, bytes.data(), static_cast<DWORD>(bytes.size()), &read, &at),
            "held_header_read_for_transfer_check");
      bytes.resize(read);
      const auto header = WindowsReadIlOnlyImageHeader(bytes);
      Check(header.has_value(), "held_header_parsed_for_transfer_check");
      if (header) {
        const auto transfer = header->image_base + header->entry_rva;
        Check(WindowsTargetIlOnlyImageMapping(child.hProcess,
                  reinterpret_cast<LPVOID>(transfer), file.value).has_value(),
              "matching_transfer_relation_resolves");
        Check(!WindowsTargetIlOnlyImageMapping(child.hProcess,
                  reinterpret_cast<LPVOID>(transfer + 1), file.value).has_value(),
              "mismatched_transfer_relation_is_unresolvable");
      }
      Check(!WindowsHeldImageDisagreesWithKernel(file.value, *initial),
            "enabled_il_only_kernel_header_matches_held_file");
      const auto held = WindowsTargetKernelImageInfo(child.hProcess, file.value);
      Check(held.has_value() && held->entry_rva == initial->entry_rva &&
                SameWindowsTargetName(held->mapped_name, initial->mapped_name),
            "enabled_il_only_remeasures_with_held_file");
      // Map the same section a second time in the child; uniqueness is by allocation, not region.
      ScopedKernelHandle section(CreateFileMappingW(file.value, nullptr, PAGE_READONLY | SEC_IMAGE,
                                                     0, 0, nullptr));
      using MapFn = LONG (WINAPI *)(HANDLE, HANDLE, PVOID *, ULONG_PTR, SIZE_T,
                                   LARGE_INTEGER *, SIZE_T *, ULONG, ULONG, ULONG);
      using UnmapFn = LONG (WINAPI *)(HANDLE, PVOID);
      const HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
      const auto map = reinterpret_cast<MapFn>(GetProcAddress(ntdll, "NtMapViewOfSection"));
      const auto unmap = reinterpret_cast<UnmapFn>(GetProcAddress(ntdll, "NtUnmapViewOfSection"));
      PVOID duplicate = nullptr;
      SIZE_T size = 0;
      const bool mapped = section.value != nullptr && map != nullptr && unmap != nullptr &&
          map(section.value, child.hProcess, &duplicate, 0, 0, nullptr, &size, 2, 0,
              PAGE_READONLY) >= 0;
      Check(mapped, "second_same_name_mapping_created");
      if (mapped) {
        Check(!WindowsTargetKernelImageInfo(child.hProcess, file.value).has_value(),
              "second_same_name_mapping_is_unresolvable");
        Check(unmap(child.hProcess, duplicate) >= 0, "second_mapping_removed");
      }
      Check(WindowsTargetKernelImageInfo(child.hProcess, file.value).has_value(),
            "single_mapping_recovers_after_unmap");
      // Locate the known mapping through the same kernel-name comparison, never through the PEB.
      std::uintptr_t cursor = 0;
      PVOID base = nullptr;
      for (unsigned count = 0; count < 65536; ++count) {
        MEMORY_BASIC_INFORMATION region{};
        if (VirtualQueryEx(child.hProcess, reinterpret_cast<PVOID>(cursor), &region,
                           sizeof(region)) != sizeof(region)) break;
        if (region.Type == MEM_IMAGE) {
          const auto name = WindowsTargetMappedFileName(child.hProcess, region.AllocationBase);
          if (name.has_value() && SameWindowsTargetName(*name, initial->mapped_name)) {
            base = region.AllocationBase;
            break;
          }
        }
        const auto next = reinterpret_cast<std::uintptr_t>(region.BaseAddress) + region.RegionSize;
        if (next <= cursor) break;
        cursor = next;
      }
      Check(base != nullptr, "main_mapping_available_for_header_mutation");
      if (base != nullptr) {
        const auto mapped_header = WindowsReadMappedIlOnlyHeader(child.hProcess, base);
        Check(mapped_header.has_value(), "resumed_mapped_header_read");
        if (anycpu) {
          Check(header && header->magic == 0x10b, "resumed_anycpu_file_magic_is_pe32");
          Check(mapped_header && mapped_header->magic == 0x20b,
                "resumed_anycpu_memory_magic_is_pe32plus");
        }
        IMAGE_DOS_HEADER dos{};
        SIZE_T read = 0;
        Check(ReadProcessMemory(child.hProcess, base, &dos, sizeof(dos), &read) &&
                  read == sizeof(dos), "mapped_dos_header_read");
        const auto pe = reinterpret_cast<std::uintptr_t>(base) + dos.e_lfanew;
        // Compare two valid magics against the observed header. For resumed AnyCPU the
        // on-disk PE32 is itself an allowed match, so it cannot be the baseline for this test.
        if (mapped_header) {
          auto address = reinterpret_cast<PVOID>(pe + 24);
          const std::uint16_t original = static_cast<std::uint16_t>(mapped_header->magic);
          const std::uint16_t changed = original == 0x10b ? 0x20b : 0x10b;
          DWORD protection = 0;
          SIZE_T written = 0;
          Check(VirtualProtectEx(child.hProcess, address, sizeof(changed), PAGE_READWRITE, &protection),
                "valid_magic_writable");
          Check(WriteProcessMemory(child.hProcess, address, &changed, sizeof(changed), &written) &&
                    written == sizeof(changed), "different_valid_magic_written");
          const auto mutated = WindowsReadMappedIlOnlyHeader(child.hProcess, base);
          Check(mutated && mutated->magic == changed, "different_valid_magic_parsed");
          Check(mutated && !WindowsIlOnlyHeadersMatch(*mapped_header, *mutated, 1,
                    WindowsTargetIsNative64Bit(child.hProcess)),
                "different_valid_magic_rejected_by_header_comparison");
          Check(WriteProcessMemory(child.hProcess, address, &original, sizeof(original), &written) &&
                    written == sizeof(original), "valid_magic_restored");
          DWORD ignored = 0;
          Check(VirtualProtectEx(child.hProcess, address, sizeof(original), protection, &ignored),
                "valid_magic_protection_restored");
          Check(WindowsTargetKernelImageInfo(child.hProcess, file.value).has_value(),
                "original_valid_magic_recovers");
        }
        // magic, machine, entry RVA, SizeOfImage, TimeDateStamp and CheckSum independently.
        const std::size_t offsets[] = {24, 4, 24 + 16, 24 + 56, 8, 24 + 64};
        for (const auto offset : offsets) {
          auto address = reinterpret_cast<PVOID>(pe + offset);
          std::uint16_t original = 0;
          const SIZE_T width = offset == 24 ? sizeof(original) : 1;
          DWORD protection = 0;
          const bool writable = ReadProcessMemory(child.hProcess, address, &original, width, &read) &&
              read == width && VirtualProtectEx(child.hProcess, address, width, PAGE_READWRITE, &protection);
          Check(writable, "header_field_writable");
          if (!writable) continue;
          // Retain the pre-existing invalid-magic rejection as well as the valid-magic
          // comparison above; AnyCPU permits the disk's PE32 magic after CLR conversion.
          const std::uint16_t changed = offset == 24 ? 0x107 : original ^ 1;
          SIZE_T written = 0;
          Check(WriteProcessMemory(child.hProcess, address, &changed, width, &written) && written == width,
                "header_field_changed");
          Check(!WindowsTargetKernelImageInfo(child.hProcess, file.value).has_value(),
                "mismatched_mapped_header_is_unresolvable");
          Check(WriteProcessMemory(child.hProcess, address, &original, width, &written) && written == width,
                "header_field_restored");
          DWORD ignored = 0;
          Check(VirtualProtectEx(child.hProcess, address, width, protection, &ignored),
                "header_protection_restored");
          Check(WindowsTargetKernelImageInfo(child.hProcess, file.value).has_value(),
                "matching_header_recovers");
        }
        DWORD protection = 0;
        Check(VirtualProtectEx(child.hProcess, base, 4096, PAGE_NOACCESS, &protection),
              "header_made_unreadable");
        Check(!WindowsTargetKernelImageInfo(child.hProcess, file.value).has_value(),
              "unreadable_header_is_unresolvable");
        DWORD ignored = 0;
        Check(VirtualProtectEx(child.hProcess, base, 4096, protection, &ignored),
              "readable_header_restored");
        Check(unmap != nullptr && unmap(child.hProcess, base) >= 0, "main_mapping_removed");
        Check(!WindowsTargetKernelImageInfo(child.hProcess, file.value).has_value(),
              "zero_matching_mappings_is_unresolvable");
      }
    }
  }
  std::cout << (failures == 0 ? "OK\n" : "FAILED\n");
  return failures == 0 ? 0 : 1;
}
`;

const storeNotepadUnitSource = [
  includes,
  program.slice(0, program.indexOf('std::string Show(')),
  program.slice(
    program.indexOf('void CheckStoreNotepadBinding('),
    program.indexOf('void CheckInstalledStoreNotepad('),
  ),
  String.raw`
int main() {
  TargetFacts facts;
  facts.platform = TargetPlatform::kWin32;
  facts.running_image_matches = true;
  facts.packaged = true;
  facts.package_family = "Microsoft.WindowsNotepad_8wekyb3d8bbwe";
  facts.package_signature_kind = "store";
  facts.package_development_mode = false;
  facts.image_root = "windows_apps";
  facts.image_volume = "fixed";
  facts.pe_subsystem = "gui";
  const std::string root = "C:\\Program Files\\WindowsApps\\Synthetic.Notepad";
  WindowsPackageIdentityFacts package{true, "store", false, facts.package_family,
      "8wekyb3d8bbwe", "windows_apps", root + "\\Notepad\\Notepad.exe", root};
  WindowsFileKey key;
  key.volume_serial = 17;
  key.file_id[0] = 9;
  CheckStoreNotepadBinding(facts, package, key);
  facts.package_signature_kind = "system";
  package.signature_kind = "system";
  CheckStoreNotepadBinding(facts, package, key);
  // Both builds retain the original System32 entry and its file-key refusal.
  facts.packaged = false;
  facts.image_root = "windows_directory";
  facts.image_relative_path = "system32\\notepad.exe";
  facts.signature = "valid";
  facts.signer_microsoft_root = true;
  Check(WindowsTargetIsNotWebByTable(facts, key, key, key, true), "system_notepad_unchanged");
  WindowsFileKey changed = key;
  changed.file_id[1] = 1;
  Check(!WindowsTargetIsNotWebByTable(facts, changed, changed, key, true),
        "system_notepad_changed_key_rejected");
  std::cout << (g_failures == 0 ? "OK\n" : "FAILED\n");
  return g_failures == 0 ? 0 : 1;
}
`,
].join('\n');

const build = findBuild();
const ci = process.env['CI'] !== undefined;
const onWindows = process.platform === 'win32';
const csc = 'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe';

describe.skipIf(!onWindows || (build === null && !ci) || !existsSync(csc))(
  'IL-only anchor live',
  () => {
    it('checks disabled and enabled builds for anycpu, x64 and anycpu32bitpreferred', async () => {
      expect(build, 'cl.exe (MSVC) is required on a Windows CI runner').not.toBeNull();
      const scratch = mkdtempSync(join(tmpdir(), 'computer-use-il-anchor-'));
      try {
        const managedSource = join(scratch, 'wait.cs');
        writeFileSync(
          managedSource,
          'class Wait { static void Main() { System.Threading.Thread.Sleep(60000); } }',
        );
        const seam = join(scratch, 'anchor.cc');
        for (const variant of [
          { name: 'disabled', acceptance: 1, flag: false, enabled: false },
          { name: 'enabled', acceptance: 1, flag: true, enabled: true },
          { name: 'acceptance-zero', acceptance: 0, flag: true, enabled: false },
          { name: 'acceptance-absent', acceptance: undefined, flag: true, enabled: false },
        ]) {
          writeFileSync(
            seam,
            `${ilAnchorSeamPrefix}\nconstexpr bool kExpectedIlOnlyImageAnchor = ${variant.enabled};\n${ilAnchorProgram}`,
          );
          const binary = join(scratch, `anchor-${variant.name}.exe`);
          const command = build!.wrap([
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
            ...(variant.acceptance === undefined
              ? []
              : [`/DSPRINT_CODER_COMPUTER_USE_ACCEPTANCE_BUILD=${variant.acceptance}`]),
            ...(variant.flag ? ['/DSPRINT_CODER_TEST_IL_ONLY_IMAGE_ANCHOR=1'] : []),
            `/I${nativeDirectory}`,
            seam,
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
          await promisify(execFile)(command.file, command.args, {
            encoding: 'utf8',
            windowsVerbatimArguments: command.verbatim,
            timeout: 120_000,
            env: { ...process.env, VSLANG: '1033' },
          });
          for (const platform of ['anycpu', 'x64', 'anycpu32bitpreferred']) {
            const executable = join(scratch, `${platform}.exe`);
            await promisify(execFile)(csc, [
              '/nologo',
              '/target:winexe',
              `/platform:${platform}`,
              `/out:${executable}`,
              managedSource,
            ]);
            const result = await promisify(execFile)(binary, [executable, platform], {
              encoding: 'utf8',
              timeout: 30_000,
            }).catch((error: unknown) => {
              if (error instanceof Error && 'stdout' in error)
                throw new Error(`${variant.name}/${platform}: ${String(error.stdout)}`, {
                  cause: error,
                });
              throw error;
            });
            expect(result.stdout, `${platform}, variant=${variant.name}`).toContain('OK');
          }
          for (const tool of [
            'C:/Windows/Microsoft.NET/Framework/v4.0.30319/AddInUtil.exe',
            'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/InstallUtil.exe',
          ]) {
            expect(existsSync(tool), tool).toBe(true);
            const result = await promisify(execFile)(binary, [tool, 'protected'], {
              encoding: 'utf8',
              timeout: 30_000,
            });
            expect(result.stdout, `${tool}, variant=${variant.name}`).toContain('OK');
          }
        }
      } finally {
        rmSync(scratch, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
      }
    }, 600_000);
  },
);

describe.skipIf(!onWindows || (build === null && !ci))(
  'Explorer exception native preparation',
  () => {
    // Both Explorer tests compile the complete production host (explorer-host.cc) with their driver.
    const buildExplorerHostDriver = async (
      scratch: string,
      driver: string,
      binary: string,
      gate: boolean,
    ): Promise<void> => {
      writeFileSync(join(scratch, 'explorer-host.cc'), host);
      const provenance = join(scratch, 'provenance.h');
      writeFileSync(
        provenance,
        '#define SPRINT_CODER_SOURCE_COMMIT "0000000000000000000000000000000000000000"\n',
      );
      const command = build!.wrap([
        '/nologo',
        '/std:c++20',
        '/EHsc',
        '/W4',
        '/utf-8',
        '/DNOMINMAX',
        '/DUNICODE',
        '/D_UNICODE',
        '/DWIN32_LEAN_AND_MEAN',
        '/D_WIN32_WINNT=0x0A00',
        '/DSPRINT_CODER_COMPUTER_USE_ACCEPTANCE_BUILD=1',
        ...(gate ? ['/DSPRINT_CODER_TEST_WINDOWS_EXPLORER_EXCEPTION'] : []),
        `/FI${provenance}`,
        `/I${nativeDirectory}`,
        `/I${scratch}`,
        join(nativeDirectory, driver),
        `/Fo:${binary}.obj`,
        `/Fe:${binary}`,
        '/link',
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
      ]);
      await promisify(execFile)(command.file, command.args, {
        encoding: 'utf8',
        windowsVerbatimArguments: command.verbatim,
        timeout: 120_000,
        env: { ...process.env, VSLANG: '1033' },
      }).catch((error: unknown) => {
        if (error instanceof Error && 'stdout' in error && typeof error.stdout === 'string')
          console.log(error.stdout);
        throw error;
      });
    };
    it('rejects measurement on the native transport with gate off or stale binding', async () => {
      expect(build, 'cl.exe (MSVC) is required').not.toBeNull();
      const scratch = mkdtempSync(join(tmpdir(), 'computer-use-explorer-wire-'));
      try {
        for (const gate of [false, true]) {
          const binary = join(scratch, `transport-${gate}.exe`);
          await buildExplorerHostDriver(
            scratch,
            'computer_use_windows_explorer_transport_test.cc',
            binary,
            gate,
          );
          const result = await promisify(execFile)(binary, [], {
            encoding: 'utf8',
            timeout: 15_000,
          }).catch((error: unknown) => {
            if (error instanceof Error && 'stdout' in error && typeof error.stdout === 'string')
              console.log(error.stdout);
            throw error;
          });
          expect(result.stdout).not.toContain('FAIL ');
          expect(result.stdout).toContain('OK Explorer transport');
        }
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    }, 300_000);
    it('measures live Explorer views and refuses foreign-process child windows', async (context) => {
      expect(build, 'cl.exe (MSVC) is required').not.toBeNull();
      const scratch = mkdtempSync(join(tmpdir(), 'computer-use-explorer-view-'));
      let cleanupConfirmed = true;
      try {
        const binary = join(scratch, 'explorer-view-test.exe');
        await buildExplorerHostDriver(
          scratch,
          'computer_use_windows_explorer_live_test.cc',
          binary,
          true,
        );
        cleanupConfirmed = false;
        const result = await promisify(execFile)(binary, [scratch], {
          encoding: 'utf8',
          timeout: 120_000,
        }).catch((error: unknown) => {
          if (error instanceof Error && 'stdout' in error && typeof error.stdout === 'string') {
            console.log(error.stdout);
            cleanupConfirmed = error.stdout.includes('OK explorer_cleanup');
          }
          throw error;
        });
        cleanupConfirmed = result.stdout.includes('OK explorer_cleanup');
        console.log(result.stdout);
        expect(result.stdout).not.toContain('FAIL ');
        if (result.stdout.includes('NOT_RUN explorer_tab_shared')) {
          context.skip('NOT_RUN explorer_tab_shared: existing tabs are left open');
        }
        if (result.stdout.includes('NOT_RUN explorer_window_ambiguous')) {
          context.skip('NOT_RUN explorer_window_ambiguous: no window was closed');
        }
        if (result.stdout.includes('NOT_RUN explorer_target_preexisting')) {
          context.skip('NOT_RUN explorer_target_preexisting: existing namespace is left open');
        }
        if (result.stdout.includes('NOT_RUN explorer_window_covered')) {
          context.skip('NOT_RUN explorer_window_covered: another window covers the view');
        }
        expect(cleanupConfirmed).toBe(true);
        expect(result.stdout).toContain('OK Explorer view and foreign child');
        // Every other case passed; only the dispatch cases could not run against an elevated
        // explorer.exe (whose identity check refused them with kIdentity, as asserted natively).
        if (result.stdout.includes('NOT_RUN explorer_elevated_dispatch')) {
          context.skip(
            'NOT_RUN explorer_elevated_dispatch: explorer.exe is elevated on this runner',
          );
        }
      } finally {
        if (cleanupConfirmed) {
          rmSync(scratch, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
        } else {
          console.warn('NOT_RUN explorer_cleanup_unconfirmed: scratch retained');
        }
      }
    }, 300_000);
    it('checks held-image facts, file-window restriction, and acceptance-only compilation', async () => {
      expect(build, 'cl.exe (MSVC) is required').not.toBeNull();
      const scratch = mkdtempSync(join(tmpdir(), 'computer-use-explorer-'));
      try {
        const restriction = cut(
          '[[nodiscard]] bool WindowsExplorerFileWindowRestriction(',
          '// Each window is judged by itself',
        );
        const program = String.raw`
#include "computer_use_windows_target_facts.h"
using namespace sprint_coder::computer_use;
${restriction}
int main() {
  TargetFacts facts;
  facts.platform = TargetPlatform::kWin32;
  facts.running_image_matches = true;
  facts.signature = "valid";
  facts.signer_microsoft_root = true;
  facts.packaged = false;
  facts.image_volume = "fixed";
  facts.image_root = "windows_directory";
  facts.image_relative_path = "explorer.exe";
  facts.image_leaf = "explorer.exe";
  facts.window_class = "CabinetWClass";
  if (WindowsExplorerFileWindowRestriction(facts)) return 8;
  if (WindowsExplorerFileWindowRestriction(facts, false)) return 9;
  if (WindowsExplorerFileWindowRestriction(facts, true) != kWindowsExplorerException) return 1;
  if (!kWindowsExplorerException) return 0;
  const auto original = facts;
  for (auto field : {&TargetFacts::running_image_matches, &TargetFacts::signer_microsoft_root,
                     &TargetFacts::packaged}) {
    facts = original;
    (facts.*field).reset();
    if (WindowsExplorerFileWindowRestriction(facts, true)) return 2;
    facts.*field = !(original.*field).value();
    if (WindowsExplorerFileWindowRestriction(facts, true)) return 3;
  }
  for (auto field : {&TargetFacts::signature, &TargetFacts::image_volume, &TargetFacts::image_root,
                     &TargetFacts::image_relative_path, &TargetFacts::image_leaf,
                     &TargetFacts::window_class}) {
    facts = original;
    (facts.*field).reset();
    if (WindowsExplorerFileWindowRestriction(facts, true)) return 4;
    facts.*field = "unverified";
    if (WindowsExplorerFileWindowRestriction(facts, true)) return 5;
  }
  for (const auto name : {"Progman", "WorkerW", "Shell_TrayWnd", "Windows.UI.Core.CoreWindow"}) {
    facts = original;
    facts.window_class = name;
    if (WindowsExplorerFileWindowRestriction(facts, true)) return 6;
  }
  facts = original;
  facts.platform = TargetPlatform::kDarwin;
  if (WindowsExplorerFileWindowRestriction(facts, true)) return 7;
  return 0;
}
`;
        const file = join(scratch, 'explorer.cc');
        writeFileSync(file, program);
        const compile = async (defines: string[]) => {
          const command = build!.wrap([
            '/nologo',
            '/std:c++20',
            '/EHsc',
            '/W4',
            '/utf-8',
            ...defines.map((define) => `/D${define}`),
            `/I${nativeDirectory}`,
            file,
            `/Fo:${join(scratch, 'explorer.obj')}`,
            `/Fe:${join(scratch, 'explorer.exe')}`,
          ]);
          return promisify(execFile)(command.file, command.args, {
            encoding: 'utf8',
            windowsVerbatimArguments: command.verbatim,
            timeout: 60_000,
            env: { ...process.env, VSLANG: '1033' },
          });
        };
        const seam = 'SPRINT_CODER_TEST_WINDOWS_EXPLORER_EXCEPTION';
        const acceptance = 'SPRINT_CODER_COMPUTER_USE_ACCEPTANCE_BUILD=1';
        for (const defines of [[], [acceptance], [seam, acceptance]]) {
          await compile(defines);
          await promisify(execFile)(join(scratch, 'explorer.exe'), [], { timeout: 10_000 });
        }
        for (const defines of [
          [seam],
          [seam, 'SPRINT_CODER_COMPUTER_USE_ACCEPTANCE_BUILD=0'],
          [seam, acceptance, 'SPRINT_CODER_ELIGIBILITY_FROM_BUILD'],
          [seam, acceptance, 'SPRINT_CODER_REQUIRE_WINDOWS_GRAPHICS_CAPTURE'],
        ]) {
          await expect(compile(defines)).rejects.toMatchObject({
            stdout: expect.stringContaining(
              'Explorer exception test seam must not enter a product build',
            ),
          });
        }
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    }, 120_000);
  },
);

describe('Windows target facts seam source', () => {
  it('owns Explorer automation entries and never closes a shared tab window', () => {
    const live = readFileSync(
      join(nativeDirectory, 'computer_use_windows_explorer_live_test.cc'),
      'utf8',
    );
    expect(live).toContain('browser->get_Document(document.Receive())');
    expect(live).toContain('view.Get()->get_Folder(folder.Receive())');
    expect(live).toContain('folder2.Get()->get_Self(item.Receive())');
    expect(live).toContain('item.Get()->get_Path(&path)');
    expect(live).toContain('GetLongPathNameW');
    expect(live).toContain('MsgWaitForMultipleObjects');
    expect(live).not.toContain('Sleep(25)');
    expect(live).not.toContain('entry.identity');
    expect(live).toContain('OK explorer_cleanup');
    expect(live).toContain('before.ContainsPath(target_path)');
    // Ours is exactly one HWND absent before the launch, showing the target (M4): a namespace path
    // such as Control Panel is not unique, so the path alone never selects a window to close.
    expect(live).toContain('entry.path != target_path || before.HasWindow(entry.window)');
    expect(live).toContain('before.HasWindow(window)');
    expect(live).toContain('NOT_RUN explorer_tab_shared');
    expect(live).toContain('Ambiguous("explorer_window_ambiguous")');
    expect(live).toContain('if (fresh.size() > 1)');
    expect(live).toContain('if (!launched || shared) return;');
    expect(live).toContain('entry.browser.Get()->Quit()');
    expect(live).toContain('entry.window != window || entry.path != target_path');
    expect(live).toContain('quit && !now.HasWindow(window)');
    expect(live).not.toContain('now.ContainsPath(target_path)');
    expect(live).toContain('explorer_cleanup_confirmed = false');
    // The positive case goes through the production dispatch, and the refusals name their reason.
    expect(live).toContain('#include "explorer-host.cc"');
    expect(live).toContain('HandlePipeRequest(server.value');
    expect(live).toContain('Refusal::kNotShellFsFolder, what');
    expect(live).toContain('Refusal::kPointOutsideView');
    expect(live).toContain('Refusal::kPointForeignOwner');
    expect(live).toContain('Refusal::kActiveTabUnbound');
    expect(live).toContain('Refusal::kAncestorShellClass');
    const explorer = readFileSync(
      join(nativeDirectory, 'computer_use_windows_host_explorer.inc'),
      'utf8',
    );
    expect(explorer).toContain('hit != view && !IsChild(view, hit)');
    expect(explorer).toContain('IsWindowVisible(hit)');
    expect(explorer).toContain('WindowsExplorerActiveView(window, view_window)');
    expect(explorer).toContain('IsEqualCLSID(folder_class, CLSID_ShellFSFolder)');
    expect(explorer).toContain('GetDriveTypeW(path.substr(0, 3).c_str()) != DRIVE_FIXED');
    expect(explorer).toContain('P5 REQUIREMENT (M2');
    expect(explorer).toContain(
      "if (end != 3 && end != path.size() && path[end] != L'\\\\') continue;",
    );
    expect(explorer).toContain('rest.find_first_of(L"\\r\\n")');
    // Test-only overrides and faults exist only behind the acceptance-test macro, never in a product.
    for (const name of [
      'windows_explorer_ignore_elevation_for_test',
      'windows_explorer_fault_for_test',
      'WindowsExplorerFault',
    ]) {
      let from = explorer.indexOf(name);
      expect(from, name).toBeGreaterThan(0);
      while (from >= 0) {
        const opened = explorer.lastIndexOf(
          '#if defined(SPRINT_CODER_WINDOWS_EXPLORER_TEST_HOOKS)',
          from,
        );
        const closed = explorer.lastIndexOf('#endif', from);
        expect(opened, `${name} at ${from}`).toBeGreaterThan(closed);
        from = explorer.indexOf(name, from + name.length);
      }
    }
    // M4: a window is recorded and closed only while it is the one new window on the target.
    expect(live).toContain('if (!again.valid || !OnlyOurs(again))');
    expect(live).toContain('if (!OnlyOurs(now)) { RefuseUnlessOurs(now); return; }');
    expect(live).toContain('GetTickCount64() - adopted >= kSettleMs');
    expect(live).toContain('NOT_RUN explorer_elevated_dispatch');
    // Refusal reasons stay off the wire: the response names only the kind and the point answer.
    expect(explorer).toContain('*response = "{\\"shellView\\":');
    const response = explorer.slice(explorer.indexOf('*response = "{\\"shellView\\":'));
    expect(response.slice(0, response.indexOf(';'))).not.toMatch(/trace|Refusal/u);
    expect(live).toContain('CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED)');
    expect(live).not.toContain('WM_CLOSE');
    expect(live).toContain('HWND parent = opened.Open(scratch)');
    expect(live).toContain('FAIL ');
  });
  it('cuts the facts block, and only the v2 targets block calls it or the core', () => {
    const block = cut('// BEGIN windows target facts', '// END windows target facts');
    expect(block).toContain('WindowsTargetFactsMeasurement MeasureWindowsTargetFacts(');
    // S5-c-3 PR-5: the facts are judged by the core only in the v2 targets block (list_targets and
    // the v2 start, resume and per-input judgement).
    const v2 = cut('// BEGIN windows v2 targets', '// END windows v2 targets');
    expect(block).not.toMatch(/ClassifyTarget|TargetFactsAreComplete/u);
    expect(host.replace(v2, '')).not.toMatch(/ClassifyTarget|TargetFactsAreComplete/u);
    const outside = host.replace(block, '').replace(v2, '');
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
// byte what it wrote before for nonblank names, and the package identity is answered only by a v2 build.
// #947 intentionally maps a blank-only display name to Application before this unchanged serializer.
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
  it('preserves the V1 serializer and digest, and answers a package identity only in a v2 build', () => {
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
    // Nothing outside the block calls it or writes its fields but the v2 targets block (PR-5).
    const outside = host
      .replace(block, '')
      .replace(cut('// BEGIN windows v2 targets', '// END windows v2 targets'), '');
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
    it('checks Store Notepad binding with the gate off and on and rejects production defines', async () => {
      expect(build, 'cl.exe (MSVC) is required on a Windows CI runner').not.toBeNull();
      const scratch = mkdtempSync(join(tmpdir(), 'computer-use-store-notepad-'));
      try {
        const seam = join(scratch, 'store-notepad.cc');
        const binary = join(scratch, 'store-notepad.exe');
        writeFileSync(seam, storeNotepadUnitSource);
        const acceptance = '/DSPRINT_CODER_COMPUTER_USE_ACCEPTANCE_BUILD=1';
        const enabled = '/DSPRINT_CODER_TEST_WINDOWS_STORE_NOTEPAD_NOT_WEB=1';
        const compile = async (definitions: string[]) => {
          const command = build!.wrap([
            '/nologo',
            '/std:c++20',
            '/EHsc',
            '/W4',
            '/permissive-',
            '/utf-8',
            `/I${nativeDirectory}`,
            ...definitions,
            seam,
            `/Fe:${binary}`,
            `/Fo:${binary}.obj`,
          ]);
          return promisify(execFile)(command.file, command.args, {
            encoding: 'utf8',
            windowsVerbatimArguments: command.verbatim,
            timeout: 120_000,
            env: { ...process.env, VSLANG: '1033' },
          });
        };
        for (const definitions of [[], [acceptance], [acceptance, enabled]]) {
          await compile(definitions);
          const result = await promisify(execFile)(binary, [], {
            encoding: 'utf8',
            timeout: 10_000,
          });
          expect(result.stdout).toContain('OK');
        }
        for (const definitions of [
          [enabled],
          [enabled, '/DSPRINT_CODER_COMPUTER_USE_ACCEPTANCE_BUILD=0'],
          [enabled, acceptance, '/DSPRINT_CODER_ELIGIBILITY_FROM_BUILD=1'],
          [enabled, acceptance, '/DSPRINT_CODER_REQUIRE_WINDOWS_GRAPHICS_CAPTURE=1'],
        ]) {
          await expect(compile(definitions)).rejects.toMatchObject({
            stdout: expect.stringContaining(
              'Store Notepad not-web is restricted to acceptance test builds',
            ),
          });
        }
      } finally {
        rmSync(scratch, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
      }
    }, 600_000);

    it('measures cmd, conhost, a renamed cmd, mstsc, the fixture, its own child, lineage and a rename swap', async () => {
      expect(build, 'cl.exe (MSVC) is required on a Windows CI runner').not.toBeNull();
      const scratch = mkdtempSync(join(tmpdir(), 'computer-use-target-facts-'));
      try {
        // The two builds and the live seam can exceed Vitest's 60s RPC deadline together.
        // Yield while each child runs so the worker can receive reporting acknowledgements.
        const run = async (args: string[]) => {
          const command = build!.wrap(args);
          try {
            return await promisify(execFile)(command.file, command.args, {
              encoding: 'utf8',
              windowsVerbatimArguments: command.verbatim,
              timeout: 400_000,
              env: { ...process.env, VSLANG: '1033' },
            });
          } catch (error) {
            const output =
              error instanceof Error && 'stdout' in error && typeof error.stdout === 'string'
                ? error.stdout
                : '';
            const diagnostics = output
              .split(/\r?\n/u)
              .filter((line) => /\berror (?:C|LNK)\d+:/u.test(line))
              .map((line) =>
                line.replaceAll(scratch, '<fixture>').replaceAll(nativeDirectory, '<native>'),
              )
              .join('\n')
              .slice(0, 8000);
            throw new Error(`Target facts seam compilation failed\n${diagnostics}`, {
              cause: error,
            });
          }
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
          '/DSPRINT_CODER_COMPUTER_USE_ACCEPTANCE_BUILD=1',
          '/DSPRINT_CODER_TEST_WINDOWS_STORE_NOTEPAD_NOT_WEB=1',
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
        // The installed Store Notepad is measured only where it is installed: the CI windows-2022
        // image has none, so there the real-package checks are a counted SKIP, never a pass.
        if (executed.stdout.includes('SKIP store_notepad_not_installed'))
          console.warn(
            'STORE_NOTEPAD_NOT_RUN installed Store Notepad not present; real-package checks skipped',
          );
        else expect(executed.stdout).not.toContain('FAIL store_notepad');
      } finally {
        rmSync(scratch, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
      }
    }, 600_000);
  },
);
