import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

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
    expect(v2Block).toContain('if (rows.size() >= kWindowsListTargetsRowLimit) {');
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

PROCESS_INFORMATION Start(std::wstring command, DWORD flags) {
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESHOWWINDOW;
  startup.wShowWindow = SW_SHOWMINNOACTIVE;
  PROCESS_INFORMATION info{};
  if (!CreateProcessW(nullptr, command.data(), nullptr, nullptr, FALSE, flags | CREATE_SUSPENDED,
                      nullptr, nullptr, &startup, &info))
    return {};
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
  windows_v2_main_pid = root_process.dwProcessId;
  const WindowsTargetFactsContext &context = WindowsV2FactsContext();
  Check(context.lineage_root_pid == root_process.dwProcessId, "v2_context_lineage_root_is_main");

  // cmd: W-SYS, refused, and its row is its kind only. It has no window of its own (its console is
  // conhost's), so it is judged again with an empty window class. It runs (a suspended process has
  // no loader data yet, which is a running-image mismatch of its own).
  const PROCESS_INFORMATION cmd = Start(L"\"" + system32 + L"\\cmd.exe\" /k", CREATE_NO_WINDOW);
  Sleep(1000);
  WindowsV2Judgement shell;
  JudgeWindowsV2Target(cmd.dwProcessId, nullptr, context, &shell);
  WindowsTargetFactsMeasurement shell_window = shell.measured;
  shell_window.facts.window_class = std::string{};
  std::cout << "cmd: verdict=" << TargetVerdictKindName(shell.verdict.kind)
            << " with a window=" << TargetVerdictKindName(WindowsV2VerdictFor(shell_window).kind)
            << " class=" << ClassifyTargetExplained(shell_window.facts).deny_class << "\n";
  Check(!shell.Selectable() && shell.app_identity.empty() && !shell.package.has_value() &&
            WindowsV2VerdictFor(shell_window).kind == TargetVerdictKind::kDenied &&
            ClassifyTargetExplained(shell_window.facts).deny_class == "W-SYS",
        "v2_cmd_is_refused");
  Check(WindowsV2RefusedRow(TargetVerdictKind::kDenied) == "{\"kind\":\"denied\"}" &&
            WindowsV2RefusedRow(TargetVerdictKind::kUnresolvable) == "{\"kind\":\"unresolvable\"}",
        "v2_refused_rows_are_the_kind_only");

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
  Check(judged.verdict.kind == TargetVerdictKind::kUpper &&
            judged.verdict.maximum_mode == "observe_only" &&
            judged.measured.facts.image_root == std::optional<std::string>("local_programs") &&
            !judged.package.has_value() &&
            judged.app_identity == judged.executable.identity.identity_digest &&
            !judged.process_start.empty(),
        "v2_fixture_is_the_upper_class_with_the_core_mode");
  Check(!WindowsTargetIsNotWebByTable(judged.measured.facts, judged.held_key, judged.table_key,
                                      std::nullopt, false),
        "v2_fixture_is_not_in_the_not_web_table");
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
    CloseLockedWindowsExecutable(&locked);
  }

  // Notepad, started here. On Server 2022 it is System32's classic image, in the not-web table. On
  // Windows 11 with the Store Notepad the started process hands the window to the package's own
  // activation, which is not this program's process: then nothing more is looked at.
  const PROCESS_INFORMATION notepad = Start(L"\"" + system32 + L"\\notepad.exe\"", 0);
  WaitForInputIdle(notepad.hProcess, 10000);
  const HWND window = TopWindowOf(notepad.dwProcessId);
  if (window == nullptr) {
    std::cout << "notepad: no window of the started process; skipped\n";
  } else {
    WindowsV2Judgement note;
    JudgeWindowsV2Target(notepad.dwProcessId, window, context, &note);
    const TargetFacts &facts = note.measured.facts;
    std::cout << "notepad: verdict=" << TargetVerdictKindName(note.verdict.kind)
              << " mode=" << note.verdict.maximum_mode
              << " packaged=" << (facts.packaged.has_value() ? (*facts.packaged ? "true" : "false") : "-")
              << " root=" << facts.image_root.value_or("-")
              << " package_identity=" << (note.package.has_value() ? "yes" : "no") << "\n";
    Check(note.Selectable() && note.verdict.maximum_mode == "full_access_app",
          "v2_notepad_is_selectable_with_the_core_mode");
    const bool not_web =
        WindowsTargetIsNotWebByTable(facts, note.held_key, note.table_key, std::nullopt, false);
    if (facts.packaged == std::optional<bool>(true))
      Check(note.package.has_value() && note.app_identity == note.package->identity_digest && !not_web,
            "v2_packaged_notepad_is_bound_to_its_package_digest");
    else
      Check(!note.package.has_value() && note.app_identity == note.executable.identity.identity_digest &&
                not_web,
            "v2_system_notepad_is_in_the_not_web_table");
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
        } finally {
          rmSync(scratch, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
          rmSync(installed, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
        }
      },
      600_000,
    );
  },
);
