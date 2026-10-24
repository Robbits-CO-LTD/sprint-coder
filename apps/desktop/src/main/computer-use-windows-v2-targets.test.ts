import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computerWindowsTargetFactsSchema } from '@sprint-coder/contracts';

// S5-c-3 PR-5 (#500): the v2 target judgement wired into the Windows helper (list_targets, and the
// v2 start, resume and per-input judgement). The source contracts below hold the v1 build to what it
// was (list_targets is unsupported_operation, nothing v2 runs) and the v2 path to its rules (the
// mode is the core's, a refused row is its kind only, the not-web table is the only confirmation).
// The live part compiles the whole helper source into a program of its own (the helper's wmain is
// renamed) and judges processes it starts itself: Notepad and cmd. No other window or process is
// touched: list_targets, which reads every window on the desktop, is not run here.

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

const v2Block = cut('// BEGIN windows v2 targets', '// END windows v2 targets');

describe('Windows v2 targets source (#500 S5-c-3 PR-5)', () => {
  it('answers list_targets with unsupported_operation in a v1 build, before anything is read', () => {
    expect(host).toContain(
      [
        '    } else if (operation == "list_targets") {',
        '      // S5-c-3 PR-5: unsupported_operation in a v1 build.',
        '      succeeded = ListWindowsTargets(&response, &reason);',
      ].join('\n'),
    );
    expect(v2Block).toContain(
      [
        'bool ListWindowsTargets(std::string *response, std::string *reason) {',
        '  if constexpr (!sprint_coder::computer_use::kNativeEligibilityIsV2) {',
        '    (void)response;',
        '    *reason = "unsupported_operation";',
        '    return false;',
        '  } else {',
      ].join('\n'),
    );
    // The bounds: 64 rows and a time budget.
    expect(v2Block).toContain('inline constexpr std::size_t kWindowsListTargetsRowLimit = 64;');
    expect(v2Block).toMatch(/kWindowsListTargetsBudgetMs = \d/u);
    expect(v2Block).toContain('if (rows.Full()) {');
    // ... and a byte bound: the response always fits one frame (kMaxMetadataBytes).
    expect(v2Block).toContain('WindowsV2ListRows rows(kWindowsListTargetsRowBytes);');
    // An answer over one frame is never handed on: the request gets the small error frame (the
    // dispatcher answers a false with ErrorPayload(reason)) and the pipe stays up.
    expect(v2Block).toContain('if (built.empty() || built.size() > kMaxMetadataBytes) {');
    expect(v2Block).toContain('*reason = "list_targets_unavailable";');
    expect(host).toContain('succeeded ? std::move(response) : ErrorPayload(reason)))');
  });

  it('gives a refused row its kind and nothing else', () => {
    expect(v2Block).toContain(
      'constexpr std::string_view kWindowsV2DeniedRow = "{\\"kind\\":\\"denied\\"}";',
    );
    expect(v2Block).toContain(
      'constexpr std::string_view kWindowsV2UnresolvableRow = "{\\"kind\\":\\"unresolvable\\"}";',
    );
    // Only the selectable row is built with fields; every other push is a refused row.
    const pushes = v2Block.match(/rows\.push_back\(/gu) ?? [];
    const refused = v2Block.match(/rows\.push_back\(WindowsV2RefusedRow\(/gu) ?? [];
    expect(pushes.length - refused.length).toBe(1);
  });

  it('measures a process without a window and judges every window by its own class', () => {
    const list = cut(
      'bool ListWindowsTargets(std::string *response, std::string *reason) {',
      'bool RejudgeWindowsV2Session(',
    );
    // The cached per-process facts are measured with no window, so the first window listed (a console
    // the app allocated, a window already gone) decides nothing for the others (the review of #881).
    expect(list).toContain('MeasureWindowsV2Process(owner, context, judgement.get());');
    expect(list).not.toContain('JudgeWindowsV2Target(');
    expect(list).toMatch(
      /WindowsV2VerdictForWindowClass\(&judgement, WindowsTargetWindowClass\(window, owner\),\s+&window_facts\);/u,
    );
    expect(list).toContain('WindowsV2TargetFactsJson(window_facts)');
    // Each row carries its own window's mode; no row is refused for another window's mode.
    expect(list).not.toContain('judgement.verdict');
    expect(list).toContain('WindowsV2IdentityJson(judgement, verdict.maximum_mode)');
    const measure = cut('void MeasureWindowsV2Process(', 'bool EnsureWindowsV2Identity(');
    expect(measure).toContain('MeasureWindowsTargetFacts(pid, nullptr, context);');
  });

  it('takes the v2 mode from the core, never from the policy language', () => {
    expect(v2Block).not.toContain('MaximumModeForWindowsExecutable');
    expect(v2Block).not.toContain('IsPolicyLanguageSupported');
    expect(v2Block).toContain('*maximum_mode = std::string(judged.verdict.maximum_mode);');
    const start = cut('bool StartWindowsSession(', 'bool CloseWindowsSession(');
    expect(start).toContain(
      [
        '  const std::string maximum_mode =',
        '      v2_basis ? v2_maximum_mode',
        '               : MaximumModeForWindowsExecutable(process_executable.identity);',
      ].join('\n'),
    );
    // A v1 session is admitted exactly as before; the v2 judgement exists only in a v2 build.
    expect(start).toContain('IsSupportedWindowsV1Target(process_executable.identity);');
    expect(start).toMatch(
      /if constexpr \(!sprint_coder::computer_use::kNativeEligibilityIsV2\) \{\s+return false;\s+\} else \{\s+return AdmitWindowsV2Start\(/u,
    );
  });

  it('judges a v2 session again before every input, and only there answers the not-web table', () => {
    const binding = cut('bool ValidateWindowsDispatchBinding(', '// BEGIN windows action point');
    expect(binding).toContain('if (!JudgeWindowsV2Input(session, reason))');
    const input = cut('bool JudgeWindowsV2Input(', '// The v2 admission of a start or resume');
    expect(input).toContain('session.v2_input_not_web.reset();');
    expect(input).toContain(
      'return RejudgeWindowsV2Session(session, &session.v2_input_not_web, reason);',
    );
    const lane = cut(
      'sprint_coder::computer_use::InterlockEvaluation EvaluateWindowsInterlockOnLane(',
      '// Windows has no approval path',
    );
    expect(lane).toContain(
      'strict.asked = session.eligibility_basis == EligibilityBasis::kV2Denylist;',
    );
    expect(lane).toContain('ruleset_copy, strict);');
    // The table is the only thing that confirms "not web".
    expect(host.match(/target_not_web\s*=/gu) ?? []).toHaveLength(1);
    expect(host).toContain(
      'strict.target_not_web = strict.asked ? session.v2_input_not_web : std::nullopt;',
    );
  });

  it('fixes the lineage root (Main) from the authenticated pipe client before the first request', () => {
    const serve = cut(
      'int ServeMain(const std::wstring &pipe_name, DWORD parent_pid) {',
      'int wmain(',
    );
    const assigned = serve.indexOf('windows_v2_main_pid = static_cast<std::uint32_t>(client_pid);');
    const authenticated = serve.indexOf('client_pid == parent_pid;');
    const served = serve.indexOf('ServePipe(pipe, probe);');
    expect(authenticated).toBeGreaterThan(0);
    expect(assigned).toBeGreaterThan(authenticated);
    expect(served).toBeGreaterThan(assigned);
    // A peer that is not the verified parent is never served: the pid and ServePipe are both inside
    // the one branch that the authentication opens.
    const branch = serve.indexOf('  if (authenticated_client) {');
    expect(branch).toBeGreaterThan(authenticated);
    expect(branch).toBeLessThan(assigned);
    expect(serve).toContain('std::atomic<bool> serving{authenticated_client};');
    expect(serve.match(/ServePipe\(/gu) ?? []).toHaveLength(1);
    // Assigned in one place only (the declaration aside).
    expect(host.match(/^\s+windows_v2_main_pid = /gmu) ?? []).toHaveLength(1);
    // The facts context is measured once Main's pid is known; with no pid it is empty and not kept.
    const context = cut(
      'const WindowsTargetFactsContext &WindowsV2FactsContext() {',
      '// The file %SystemRoot%',
    );
    expect(context).toContain('if (windows_v2_main_pid == 0)\n    return unknown_root;');
    expect(context).toContain('context = CurrentWindowsTargetFactsContext(windows_v2_main_pid,');
    // A list takes its generation only when its answer is sent.
    expect(v2Block).not.toContain('++windows_v2_list_generation');
    expect(host.match(/^\s+windows_v2_list_generation = generation;/gmu) ?? []).toHaveLength(1);
  });

  it('never opens a running image a network redirector holds', () => {
    const facts = cut('// BEGIN windows target facts', '// END windows target facts');
    expect(facts).toContain('QueryFullProcessImageNameW(process, PROCESS_NAME_NATIVE,');
    expect(
      facts.match(/!WindowsTargetImageKnownLocal\(process\.value\) \|\|/gu) ?? [],
    ).toHaveLength(2);
  });

  it('never reads an unmeasured value as the admitting one', () => {
    const sources = [
      v2Block,
      readFileSync(join(nativeDirectory, 'computer_use_native_interlock.h'), 'utf8'),
      readFileSync(join(nativeDirectory, 'computer_use_windows_interlock_capture.h'), 'utf8'),
      readFileSync(join(nativeDirectory, 'computer_use_windows_target_facts.h'), 'utf8'),
    ];
    for (const text of sources) {
      expect(text).not.toMatch(/value_or\(\s*true\s*\)/u);
      expect(text).not.toMatch(/!=\s*false\b/u);
      expect(text).not.toMatch(/==\s*false\)/u);
    }
  });
});

type Build = Readonly<{
  wrap: (arguments_: string[]) => { file: string; args: string[]; verbatim: boolean };
}>;

function findBuild(): Build | null {
  if (process.platform !== 'win32') return null;
  if (spawnSync('cl.exe', ['/?'], { stdio: 'ignore' }).status === 0)
    return { wrap: (args) => ({ file: 'cl.exe', args, verbatim: false }) };
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
#define wmain sprint_coder_host_wmain
#include "computer_use_windows_host.cc"
#undef wmain

#include <winsafer.h>

#include <algorithm>
#include <initializer_list>
#include <iostream>

namespace {

int g_failures = 0;
HANDLE g_job = nullptr;

void Check(bool ok, const char *name) {
  if (!ok) {
    ++g_failures;
    std::cout << "FAIL " << name << "\n";
  }
}

// An elevated runner (windows-2022 runs as an administrator, with UAC off) starts every child
// elevated, and an elevated target is W7 before anything else is judged. So the targets are started
// the way a person's own apps run: with a restricted LUA token of this program's own (Administrators
// deny-only, privileges removed) at medium integrity, which the kernel reports as not elevated (on
// windows-2022 the SAFER normal-user token is still reported elevated, so it is not used). The same
// checks run on both kinds of runner. SC500_FORCE_RESTRICTED_TOKEN=1 starts the targets with that
// token on an unelevated machine too, so the elevated runner's conditions can be rehearsed locally.
// Null when this program is not elevated (the token it has already is that one).
HANDLE g_child_token = nullptr;
// Whether a token says it is elevated (TokenElevation), or nothing when it cannot be read.
std::optional<bool> TokenIsElevated(HANDLE token) {
  TOKEN_ELEVATION elevation{};
  DWORD length = 0;
  if (GetTokenInformation(token, TokenElevation, &elevation, sizeof(elevation), &length) != TRUE)
    return std::nullopt;
  return elevation.TokenIsElevated != 0;
}

bool LowerToMediumIntegrity(HANDLE token) {
  PSID medium = nullptr;
  if (!ConvertStringSidToSidW(L"S-1-16-8192", &medium)) return false;
  TOKEN_MANDATORY_LABEL label{};
  label.Label.Attributes = SE_GROUP_INTEGRITY;
  label.Label.Sid = medium;
  const BOOL lowered =
      SetTokenInformation(token, TokenIntegrityLevel, &label, sizeof(label) + GetLengthSid(medium));
  LocalFree(medium);
  return lowered == TRUE;
}

// False when an elevated runner could not make a token the kernel reports as not elevated: then the
// positive checks cannot run, which the program reports (POSITIVE_CHECKS_NOT_RUN) and the test fails
// on in CI.
bool PrepareChildToken() {
  wchar_t force[8] = {};
  const bool forced = GetEnvironmentVariableW(L"SC500_FORCE_RESTRICTED_TOKEN", force, 8) > 0 &&
                      std::wstring(force) == L"1";
  if (!forced && !IsProcessElevated(GetCurrentProcessId())) return true;
  HANDLE own = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ALL_ACCESS, &own)) return false;
  BYTE administrators[SECURITY_MAX_SID_SIZE];
  DWORD size = sizeof(administrators);
  SID_AND_ATTRIBUTES deny{};
  HANDLE token = nullptr;
  const bool made = CreateWellKnownSid(WinBuiltinAdministratorsSid, nullptr, administrators, &size) &&
                    ((deny.Sid = administrators), true) &&
                    CreateRestrictedToken(own, LUA_TOKEN | DISABLE_MAX_PRIVILEGE, 1, &deny, 0,
                                          nullptr, 0, nullptr, &token);
  CloseHandle(own);
  if (!made) return false;
  const bool lowered = LowerToMediumIntegrity(token);
  const std::optional<bool> elevated = TokenIsElevated(token);
  std::cout << "child token restricted-lua: medium=" << (lowered ? "yes" : "no") << " elevated="
            << (elevated.has_value() ? (*elevated ? "yes" : "no") : "-")
            << (forced ? " (forced)" : "") << "\n";
  if (!(lowered && elevated == std::optional<bool>(false))) {
    CloseHandle(token);
    return false;
  }
  g_child_token = token;
  return true;
}

PROCESS_INFORMATION Start(std::wstring command, DWORD flags) {
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESHOWWINDOW;
  startup.wShowWindow = SW_SHOWMINNOACTIVE;
  PROCESS_INFORMATION info{};
  const BOOL created =
      g_child_token != nullptr
          ? CreateProcessAsUserW(g_child_token, nullptr, command.data(), nullptr, nullptr, FALSE,
                                 flags | CREATE_SUSPENDED, nullptr, nullptr, &startup, &info)
          : CreateProcessW(nullptr, command.data(), nullptr, nullptr, FALSE, flags | CREATE_SUSPENDED,
                           nullptr, nullptr, &startup, &info);
  if (!created) {
    std::cout << "start failed: " << GetLastError() << "\n";
    return {};
  }
  AssignProcessToJobObject(g_job, info.hProcess);
  if ((flags & CREATE_SUSPENDED) == 0) ResumeThread(info.hThread);
  return info;
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

std::string Metadata(std::uint64_t ruleset, std::uint64_t generation) {
  return "{\"denyRulesetVersion\":" + std::to_string(ruleset) +
         ",\"targetGeneration\":" + std::to_string(generation) + "}";
}

} // namespace

int wmain(int argc, wchar_t **argv) {
  const std::wstring fixture = argc > 1 ? argv[1] : L"";
  using namespace sprint_coder::computer_use;
  g_job = CreateJobObjectW(nullptr, nullptr);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  SetInformationJobObject(g_job, JobObjectExtendedLimitInformation, &limits, sizeof(limits));
  std::vector<wchar_t> system(32768, L'\0');
  const UINT length = GetSystemDirectoryW(system.data(), static_cast<UINT>(system.size()));
  const std::wstring system32(system.data(), length);

  const bool elevated = IsProcessElevated(GetCurrentProcessId());
  // An elevated runner that cannot make an unelevated token fails here: the positive checks below
  // must run on every runner, never be skipped.
  const bool prepared = PrepareChildToken();
  if (!prepared) std::cout << "POSITIVE_CHECKS_NOT_RUN: no unelevated token\n";
  Check(prepared, "child_token_prepared");
  std::cout << "runner elevated=" << (elevated ? "yes" : "no") << " targets started "
            << (g_child_token != nullptr ? "with the restricted LUA token" : "with this program's token")
            << "\n";

#if SPRINT_CODER_ELIGIBILITY_V2 == 0
  (void)fixture;
  // A v1 build: list_targets reads nothing and says it is not supported.
  std::string response = "untouched";
  std::string reason;
  Check(!ListWindowsTargets(&response, &reason) && reason == "unsupported_operation" &&
            response == "untouched",
        "v1_list_targets_is_unsupported");
  Check(!EligibilityBasisAdmitted(EligibilityBasis::kV2Denylist, kNativeEligibilityIsV2),
        "v1_build_refuses_the_v2_basis");
#else
  // Main stands for the lineage root (W8): a suspended process that is not the targets' parent.
  const PROCESS_INFORMATION root_process = Start(L"\"" + system32 + L"\\cmd.exe\"", CREATE_SUSPENDED);
  // Without Main's pid the context is empty (every target unresolvable) and is not kept: the real
  // one is measured once the pid is known.
  windows_v2_main_pid = 0;
  {
    const WindowsTargetFactsContext &no_root = WindowsV2FactsContext();
    Check(no_root.lineage_root_pid == 0 && !no_root.roots.has_value() &&
              !no_root.rename_probe.has_value(),
          "v2_context_without_main_is_empty");
  }
  windows_v2_main_pid = root_process.dwProcessId;
  const WindowsTargetFactsContext &context = WindowsV2FactsContext();
  Check(context.lineage_root_pid == root_process.dwProcessId, "v2_context_lineage_root_is_main");

  // cmd: W-SYS, refused, and its row is its kind only. It has no window of its own (its console is
  // conhost's), so it is judged again with an empty window class. It runs (a suspended process has
  // no loader data yet, which is a running-image mismatch of its own).
  // A new or hidden console under the restricted LUA token fails initialization on windows-2022
  // (exit 0xc0000142). Inherit this program's console instead. Run a bounded loopback wait rather
  // than an interactive /k prompt, which could exit on CI's closed stdin. The job ends both children.
  const PROCESS_INFORMATION cmd = Start(
      L"\"" + system32 + L"\\cmd.exe\" /d /c \"\"" + system32 +
          L"\\ping.exe\" -n 120 127.0.0.1 >nul\"", 0);
  Sleep(1000);
  DWORD cmd_exit = 0;
  const bool cmd_exit_read = cmd.hProcess != nullptr && GetExitCodeProcess(cmd.hProcess, &cmd_exit);
  std::cout << "cmd lifecycle: exit_read=" << (cmd_exit_read ? "yes" : "no")
            << " exit=0x" << std::hex << cmd_exit << std::dec << "\n";
  Check(cmd.hProcess != nullptr && WaitForSingleObject(cmd.hProcess, 0) == WAIT_TIMEOUT,
        "v2_cmd_is_running");
  WindowsV2Judgement shell;
  JudgeWindowsV2Target(cmd.dwProcessId, nullptr, context, &shell);
  WindowsTargetFactsMeasurement shell_window = shell.measured;
  shell_window.facts.window_class = std::string{};
  std::cout << "cmd: verdict=" << TargetVerdictKindName(shell.verdict.kind)
            << " with a window=" << TargetVerdictKindName(WindowsV2VerdictFor(shell_window).kind)
            << " class=" << ClassifyTargetExplained(shell_window.facts).deny_class
            << " complete=" << (TargetFactsAreComplete(shell_window.facts) ? "yes" : "no")
            << " image=" << (shell.measured.image_path.empty() ? "unread" : "read") << " running="
            << (shell.measured.facts.running_image_matches.has_value()
                    ? (*shell.measured.facts.running_image_matches ? "match" : "mismatch")
                    : "-")
            << " shell=" << (shell.measured.facts.descendant_shell.has_value() ? "measured" : "-")
            << " own=" << (shell.measured.facts.own_descendant.has_value() ? "measured" : "-") << "\n";
  Check(!shell.Selectable() && shell.app_identity.empty() && !shell.package.has_value() &&
            WindowsV2VerdictFor(shell_window).kind == TargetVerdictKind::kDenied &&
            ClassifyTargetExplained(shell_window.facts).deny_class == "W-SYS",
        "v2_cmd_is_refused");
  Check(WindowsV2RefusedRow(TargetVerdictKind::kDenied) == "{\"kind\":\"denied\"}" &&
            WindowsV2RefusedRow(TargetVerdictKind::kUnresolvable) == "{\"kind\":\"unresolvable\"}",
        "v2_refused_rows_are_the_kind_only");

  // The response fits one frame (the review of #881): the rows are bounded in bytes as well as in
  // count, and a row that does not fit ends the list there (truncated).
  {
    WindowsV2ListRows at_limit(9);
    at_limit.push_back("abcd");
    at_limit.push_back("abcd");  // 4 + 1 + 4 = 9: exactly the limit
    WindowsV2ListRows over_limit(8);
    over_limit.push_back("abcd");
    over_limit.push_back("abcd");  // 9 > 8: one byte over
    over_limit.push_back("a");     // after a refusal, nothing more
    Check(at_limit.size() == 2 && !at_limit.Truncated() && at_limit.Joined() == "abcd,abcd" &&
              over_limit.size() == 1 && over_limit.Truncated() && over_limit.Joined() == "abcd",
          "v2_list_rows_stop_at_the_byte_limit");
    // A row with a very long title or path is never sent, and the list says it is cut.
    WindowsV2ListRows long_row(kWindowsListTargetsRowBytes);
    long_row.push_back("{\"kind\":\"upper\",\"title\":\"" + std::string(70 * 1024, 'x') + "\"}");
    Check(long_row.size() == 0 && long_row.Truncated(), "v2_list_rows_refuse_a_row_over_the_limit");
    // Many windows of one process with long rows: the list stops below one frame's metadata.
    WindowsV2ListRows many(kWindowsListTargetsRowBytes);
    const std::string row = "{\"kind\":\"upper\",\"title\":\"" + std::string(2000, 't') + "\"}";
    for (int index = 0; index < 64; ++index) many.push_back(row);
    const std::string response = WindowsV2ListResponse(~std::uint64_t{0}, 0xffffffffu, true, many);
    Check(many.Truncated() && many.size() > 0 && many.size() < 64 &&
              response.size() <= kMaxMetadataBytes &&
              IsBoundedUtf8(std::span<const std::uint8_t>(
                  reinterpret_cast<const std::uint8_t *>(response.data()), response.size())),
          "v2_list_response_fits_one_frame");
    std::cout << "list rows: " << many.size() << " rows of " << row.size() << " bytes, response "
              << response.size() << " of " << kMaxMetadataBytes << " bytes\n";
    // A title of control characters: JsonEscape writes each as six bytes (\u00XX), and the rows are
    // counted as escaped, so the answer still fits one frame.
    const std::string controls(256, '\x01');
    const std::string escaped = JsonEscape(controls);
    TargetFacts wire_facts;
    wire_facts.platform = TargetPlatform::kWin32;
    wire_facts.image_leaf = "fixture\"\\\n\t";
    wire_facts.token_elevated = false;
    wire_facts.running_image_matches = true;
    std::cout << "private-facts\t" << WindowsV2TargetFactsJson(wire_facts) << "\n";
    wire_facts.image_leaf = std::string(1024, '\x01');
    WindowsV2ListRows control_rows(kWindowsListTargetsRowBytes);
    const std::string control_row = "{\"kind\":\"upper\",\"title\":\"" + escaped + "\",\"identity\":{\"executablePath\":\"" +
                                    JsonEscape(std::string(4096, '\x1f')) + "\"},\"facts\":" +
                                    WindowsV2TargetFactsJson(wire_facts) + "}";
    for (int index = 0; index < 64; ++index) control_rows.push_back(control_row);
    const std::string control_response =
        WindowsV2ListResponse(~std::uint64_t{0}, 0xffffffffu, true, control_rows);
    Check(escaped.size() == controls.size() * 6 && control_rows.Truncated() &&
              control_rows.size() > 0 && control_response.size() <= kMaxMetadataBytes,
          "v2_list_rows_are_counted_escaped");
    std::cout << "control rows: " << control_rows.size() << " rows of " << control_row.size()
              << " bytes, response " << control_response.size() << " bytes\n";
    // The belt: an answer over one frame is not handed on; the request is answered with the small
    // error frame instead, so the pipe and its sessions stay up.
    // One row exactly at the byte limit is sent; one byte less and it is not.
    WindowsV2ListRows exact(row.size());
    exact.push_back(row);
    WindowsV2ListRows short_by_one(row.size() - 1);
    short_by_one.push_back(row);
    Check(exact.size() == 1 && !exact.Truncated() && exact.Joined() == row &&
              short_by_one.size() == 0 && short_by_one.Truncated(),
          "v2_list_rows_one_row_at_the_limit");
    std::string answer = "stale";
    std::string reason;
    windows_v2_list_generation = 40;
    const bool oversized = FinishWindowsV2ListResponse(std::string(kMaxMetadataBytes + 1, 'x'), 41,
                                                       &answer, &reason);
    const std::string error = ErrorPayload(reason);
    Check(!oversized && answer.empty() && reason == "list_targets_unavailable" && !error.empty() &&
              error.size() <= kMaxMetadataBytes && error.find("list_targets_unavailable") != std::string::npos,
          "v2_list_response_over_one_frame_is_an_error_frame");
    // A refused list does not take a generation: the previous list stays the latest.
    Check(windows_v2_list_generation == 40, "v2_list_refused_keeps_the_generation");
    // The next request is answered as before (the refusal changed nothing it reads), and only then
    // does the generation move.
    std::string fitting;
    std::string no_reason;
    Check(FinishWindowsV2ListResponse(control_response, 41, &fitting, &no_reason) &&
              fitting == control_response && no_reason.empty() && windows_v2_list_generation == 41,
          "v2_list_response_within_one_frame_is_answered");
  }

  // A general application: the acceptance fixture, copied under %LOCALAPPDATA%\Programs (decision A)
  // by the test. Unsigned, so the upper class C: selectable, with the core's mode observe_only.
  const PROCESS_INFORMATION app = Start(L"\"" + fixture + L"\"", 0);
  WaitForInputIdle(app.hProcess, 10000);
  const HWND app_window = TopWindowOf(app.dwProcessId);
  Check(app_window != nullptr, "v2_fixture_window");
  WindowsV2Judgement judged;
  JudgeWindowsV2Target(app.dwProcessId, app_window, context, &judged);
  std::cout << "fixture: verdict=" << TargetVerdictKindName(judged.verdict.kind)
            << " mode=" << judged.verdict.maximum_mode
            << " root=" << judged.measured.facts.image_root.value_or("-") << "\n";
  std::cout << "fixture token: elevated="
            << (judged.measured.facts.token_elevated.has_value()
                    ? (*judged.measured.facts.token_elevated ? "yes" : "no")
                    : "-")
            << "\n";
  Check(judged.verdict.kind == TargetVerdictKind::kUpper &&
            judged.verdict.maximum_mode == "observe_only" &&
            judged.measured.facts.image_root == std::optional<std::string>("local_programs") &&
            !judged.package.has_value() &&
            judged.app_identity == judged.executable.identity.identity_digest &&
            !judged.process_start.empty(),
        "v2_fixture_is_the_upper_class_with_the_core_mode");
  Check(!IsProcessElevated(app.dwProcessId), "v2_fixture_runs_unelevated");
  Check(!WindowsTargetIsNotWebByTable(judged.measured.facts, judged.held_key, judged.table_key,
                                      std::nullopt, false),
        "v2_fixture_is_not_in_the_not_web_table");
  {
    // Each window is judged with its own class, from the process's facts measured without a window:
    // a console window the process allocated (W4) or a window gone before its class was read
    // (unresolvable) does not change the answer for its real window, in whichever order they come.
    WindowsV2Judgement process;
    MeasureWindowsV2Process(app.dwProcessId, context, &process);
    const std::optional<std::string> real = WindowsTargetWindowClass(app_window, app.dwProcessId);
    const std::optional<std::string> console = std::string("ConsoleWindowClass");
    const std::optional<std::string> gone;
    const auto kinds = [&](std::initializer_list<const std::optional<std::string> *> order) {
      std::vector<std::pair<std::string, std::string>> answers;
      for (const std::optional<std::string> *window_class : order) {
        const TargetVerdict verdict = WindowsV2VerdictForWindowClass(&process, *window_class);
        answers.emplace_back(window_class->has_value() ? **window_class : std::string("-"),
                             std::string(TargetVerdictKindName(verdict.kind)) + "/" +
                                 std::string(verdict.maximum_mode));
      }
      std::sort(answers.begin(), answers.end());
      return answers;
    };
    const auto first = kinds({&console, &gone, &real});
    const auto second = kinds({&real, &console, &gone});
    const auto third = kinds({&gone, &real, &console});
    const auto at = [&](const std::optional<std::string> &which) {
      return WindowsV2VerdictForWindowClass(&process, which).kind;
    };
    TargetFacts emitted;
    WindowsV2VerdictForWindowClass(&process, real, &emitted);
    Check(emitted.window_class == real && !process.measured.facts.window_class.has_value(),
          "v2_wire_facts_have_this_windows_class_without_changing_the_process_cache");
    Check(real.has_value() && first == second && second == third &&
              at(console) == TargetVerdictKind::kDenied && at(gone) == TargetVerdictKind::kUnresolvable &&
              at(real) == TargetVerdictKind::kUpper &&
              WindowsV2VerdictForWindowClass(&process, real).maximum_mode == "observe_only" &&
              !process.measured.facts.window_class.has_value(),
          "v2_each_window_is_judged_by_its_own_class_in_any_order");
  }
  {
    // The admission of a start: this build's ruleset version, the latest list, the very target.
    windows_v2_list_generation = 7;
    const std::uint64_t version = DenyRulesetVersion(TargetPlatform::kWin32);
    LockedWindowsExecutable locked;
    Check(OpenLockedProcessExecutable(app.dwProcessId, &locked), "v2_fixture_locked");
    const std::string signer = judged.executable.identity.signer_digest;
    const auto admit = [&](const std::string &metadata, bool new_session, const std::string &identity,
                           const std::string &executable, std::string *mode) {
      std::optional<WindowsFileKey> file;
      return AdmitWindowsV2Start(app.dwProcessId, app_window, locked, metadata, new_session,
                                 identity, executable, signer, mode, &file);
    };
    const std::string identity = judged.app_identity;
    const std::string executable = judged.executable.identity.executable_digest;
    std::string mode;
    Check(admit(Metadata(version, 7), true, identity, executable, &mode) && mode == "observe_only",
          "v2_start_admits_the_listed_target_with_the_core_mode");
    Check(!admit(Metadata(version + 1, 7), true, identity, executable, &mode) &&
              !admit(Metadata(0, 7), true, identity, executable, &mode) &&
              !admit("{\"targetGeneration\":7}", true, identity, executable, &mode),
          "v2_start_refuses_another_ruleset_version");
    Check(!admit(Metadata(version, 6), true, identity, executable, &mode) &&
              !admit("{\"denyRulesetVersion\":" + std::to_string(version) + "}", true, identity,
                     executable, &mode),
          "v2_start_refuses_a_stale_list");
    Check(admit(Metadata(version, 6), false, identity, executable, &mode),
          "v2_resume_does_not_need_the_latest_list");
    Check(!admit(Metadata(version, 7), true, std::string(64, 'a'), executable, &mode) &&
              !admit(Metadata(version, 7), true, identity, std::string(64, 'b'), &mode),
          "v2_start_refuses_another_identity");
    WindowsSession session;
    session.pid = app.dwProcessId;
    session.window = app_window;
    session.app_identity = identity;
    session.process_start = judged.process_start;
    session.maximum_mode = "observe_only";
    // Borrowed until the lock below is closed; WindowsSession does not own this handle.
    session.executable_file = locked.file;
    session.eligibility_basis = EligibilityBasis::kV2Denylist;
    std::string input_reason;
    Check(JudgeWindowsV2Input(session, &input_reason) && input_reason.empty() &&
              session.v2_input_not_web == std::optional<bool>(false),
          "v2_input_rejudges_the_same_live_target");
    const auto refuses_changed_session = [&](WindowsSession changed, const char *label) {
      changed.v2_input_not_web = true;
      std::string reason;
      Check(!JudgeWindowsV2Input(changed, &reason) && reason == "session_identity_changed" &&
                !changed.v2_input_not_web.has_value(),
            label);
    };
    WindowsSession changed = session;
    changed.maximum_mode = "full_access_app";
    refuses_changed_session(changed, "v2_input_refuses_changed_mode");
    changed = session;
    changed.app_identity = std::string(64, '0');
    refuses_changed_session(changed, "v2_input_refuses_changed_app_identity");
    changed = session;
    changed.process_start += "-changed";
    refuses_changed_session(changed, "v2_input_refuses_changed_process_start");
    changed = session;
    changed.executable_file = INVALID_HANDLE_VALUE;
    refuses_changed_session(changed, "v2_input_refuses_unreadable_held_file");
    LockedWindowsExecutable different;
    Check(OpenLockedWindowsExecutable(system32 + L"\\cmd.exe", &different),
          "v2_input_other_file_locked");
    changed = session;
    changed.executable_file = different.file;
    refuses_changed_session(changed, "v2_input_refuses_different_held_file");
    // The V1 bypass must also discard a cached answer without querying an invalid target.
    changed = session;
    changed.eligibility_basis = EligibilityBasis::kV1Allowlist;
    changed.pid = 0;
    changed.window = nullptr;
    changed.v2_input_not_web = true;
    input_reason.clear();
    Check(JudgeWindowsV2Input(changed, &input_reason) && input_reason.empty() &&
              !changed.v2_input_not_web.has_value(),
          "v1_input_does_not_run_the_v2_rejudgement");
    CloseLockedWindowsExecutable(&locked);
  }

  // Notepad. It is started suspended first: where System32's notepad.exe runs the Store Notepad
  // (Windows 11), the kernel's image name of the suspended process is the package's, and the process
  // is ended before it runs a single instruction, so no activation starts a Notepad outside this
  // program's job (and no window is left on the desktop). Only System32's classic image is run on.
  // The started file is %SystemRoot%\System32\notepad.exe by its absolute path. The process's image
  // (the kernel's name of it) is compared with that file by what the volume says, the volume serial
  // and the file id, which no spelling (case, 8.3 name, \\?\ prefix) changes.
  const std::wstring system_notepad = system32 + L"\\notepad.exe";
  const PROCESS_INFORMATION probe = Start(L"\"" + system_notepad + L"\"", CREATE_SUSPENDED);
  std::wstring probe_image;
  const bool probe_read = probe.hProcess != nullptr && ReadProcessPath(probe.hProcess, &probe_image);
  const std::optional<WindowsPathIdentity> probe_file =
      probe_read ? WindowsTargetOpenPathIdentity(probe_image) : std::nullopt;
  const std::optional<WindowsPathIdentity> system_file = WindowsTargetOpenPathIdentity(system_notepad);
  const bool classic = probe_file.has_value() && system_file.has_value() &&
                       SameWindowsFileIdentity(probe_file->identity, system_file->identity);
  if (probe.hProcess != nullptr) {
    TerminateProcess(probe.hProcess, 0);
    WaitForSingleObject(probe.hProcess, 5000);
    CloseHandle(probe.hThread);
    CloseHandle(probe.hProcess);
  }
  Check(probe_read, "v2_notepad_image_read");
  if (!classic) {
    std::cout << "notepad: System32's notepad.exe runs another image here (" << Utf8FromWide(probe_image)
              << "); skipped: it was ended before it ran, and is not started\n";
  } else {
    const PROCESS_INFORMATION notepad = Start(L"\"" + system32 + L"\\notepad.exe\"", 0);
    WaitForInputIdle(notepad.hProcess, 10000);
    const HWND window = TopWindowOf(notepad.dwProcessId);
    Check(window != nullptr, "v2_notepad_window");
    WindowsV2Judgement note;
    JudgeWindowsV2Target(notepad.dwProcessId, window, context, &note);
    const TargetFacts &facts = note.measured.facts;
    std::cout << "notepad: verdict=" << TargetVerdictKindName(note.verdict.kind)
              << " mode=" << note.verdict.maximum_mode
              << " root=" << (facts.image_root.has_value() ? *facts.image_root : std::string("-"))
              << "\n";
    Check(note.Selectable() && note.verdict.maximum_mode == "full_access_app" &&
              !note.package.has_value() &&
              note.app_identity == note.executable.identity.identity_digest &&
              WindowsTargetIsNotWebByTable(facts, note.held_key, note.table_key, std::nullopt, false),
          "v2_system_notepad_is_selectable_and_in_the_not_web_table");
  }
#endif
  TerminateJobObject(g_job, 0);
  CloseHandle(g_job);
  if (g_failures != 0) return 1;
  std::cout << "OK\n";
  return 0;
}
`;

const build = findBuild();
const ci = process.env['CI'] !== undefined;
const onWindows = process.platform === 'win32';

describe.skipIf(!onWindows || (build === null && !ci))(
  'Windows v2 targets, live (#500 S5-c-3 PR-5)',
  () => {
    it.each([0, 1])(
      'judges processes it starts itself (eligibility v%i)',
      (v2) => {
        expect(build, 'cl.exe (MSVC) is required on a Windows CI runner').not.toBeNull();
        const scratch = mkdtempSync(join(tmpdir(), 'computer-use-v2-targets-'));
        // The general application root of decision A, under this user's own profile; removed below.
        const programs = join(process.env['LOCALAPPDATA'] ?? tmpdir(), 'Programs');
        mkdirSync(programs, { recursive: true });
        const installed = mkdtempSync(join(programs, 'sc500-v2-targets-'));
        try {
          const fixtureExecutable = join(installed, 'sprint-coder-computer-use-fixture.exe');
          const fixtureCommand = build!.wrap([
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
          const fixtureBuild = spawnSync(fixtureCommand.file, fixtureCommand.args, {
            encoding: 'utf8',
            windowsVerbatimArguments: fixtureCommand.verbatim,
            timeout: 400_000,
            env: { ...process.env, VSLANG: '1033' },
          });
          expect(
            fixtureBuild.status,
            `fixture
${fixtureBuild.stdout}`,
          ).toBe(0);
          const seamSource = join(scratch, 'seam.cc');
          const binary = join(scratch, 'seam.exe');
          writeFileSync(seamSource, program);
          const provenance = join(scratch, 'provenance.h');
          writeFileSync(
            provenance,
            '#pragma once\n#define SPRINT_CODER_SOURCE_COMMIT "0000000000000000000000000000000000000000"\n',
          );
          const command = build!.wrap([
            '/nologo',
            '/std:c++20',
            '/EHsc',
            '/W4',
            '/we4062',
            '/sdl',
            '/permissive-',
            '/utf-8',
            '/DUNICODE',
            '/D_UNICODE',
            '/DWIN32_LEAN_AND_MEAN',
            '/DNOMINMAX',
            '/D_WIN32_WINNT=0x0A00',
            `/DSPRINT_CODER_ELIGIBILITY_V2=${v2}`,
            `/FI${provenance}`,
            `/I${nativeDirectory}`,
            seamSource,
            `/Fe:${binary}`,
            `/Fo:${binary}.obj`,
            '/link',
            '/DEBUG:NONE',
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
          const built = spawnSync(command.file, command.args, {
            encoding: 'utf8',
            windowsVerbatimArguments: command.verbatim,
            timeout: 500_000,
            env: { ...process.env, VSLANG: '1033' },
          });
          expect(built.status, `${built.stdout}\n${built.stderr}`).toBe(0);
          const executed = spawnSync(binary, [fixtureExecutable], {
            encoding: 'utf8',
            timeout: 180_000,
          });
          console.log(executed.stdout);
          expect(executed.status, `${executed.stdout}\n${executed.stderr}`).toBe(0);
          expect(executed.stdout).toContain('OK');
          if (v2 === 1) {
            const encoded = executed.stdout
              .split(/\r?\n/u)
              .find((line) => line.startsWith('private-facts\t'));
            expect(encoded).toBeDefined();
            const value: unknown = JSON.parse(encoded!.slice('private-facts\t'.length));
            const facts = computerWindowsTargetFactsSchema.parse(value);
            expect(facts.imageLeaf).toBe('fixture"\\\n\t');
            expect(facts.tokenElevated).toBe(false);
            expect(facts.runningImageMatches).toBe(true);
            expect(facts.windowClass).toBeNull();
          }
        } finally {
          rmSync(scratch, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
          rmSync(installed, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
        }
      },
      600_000,
    );
  },
);
