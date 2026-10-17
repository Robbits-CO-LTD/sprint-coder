import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The dispatch's own interlock check (#500 S5-c-2 PR-5). The head of the REAL DispatchWindowsAction
// (from its first line to the point where V1's per-action work starts) is compiled against inert
// stand-ins for the binding check and the interlocks. What is shown: a refusal comes out with the
// verdict's dispatch code and accepted:false BEFORE anything that could send input (the stand-ins
// record every call, and the head has no input API to call: the source order is tied by
// computer-use-windows-interlock-capture.test.ts), no verdict lets the V1 guards run on, and a
// failed binding never asks the interlocks.

const nativeDirectory = join(__dirname, '../../computer-use-native');
const host = readFileSync(join(nativeDirectory, 'computer_use_windows_host.cc'), 'utf8');
const vswhere = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';

type Build = Readonly<{ name: string; file: string; args: string[]; verbatim: boolean }>;

function findBuild(path: string, output: string): Build | null {
  if (process.platform !== 'win32') {
    if (spawnSync('clang++', ['--version'], { stdio: 'ignore' }).status !== 0) return null;
    return {
      name: 'clang++',
      file: 'clang++',
      args: ['-std=c++20', '-Wall', '-Wextra', `-I${nativeDirectory}`, path, '-o', output],
      verbatim: false,
    };
  }
  const clArguments = [
    '/nologo',
    '/std:c++20',
    '/EHsc',
    '/W4',
    '/permissive-',
    '/utf-8',
    `/I${nativeDirectory}`,
    path,
    `/Fe:${output}`,
    `/Fo:${output}.obj`,
  ];
  if (spawnSync('cl.exe', ['/?'], { stdio: 'ignore' }).status === 0)
    return { name: 'cl.exe', file: 'cl.exe', args: clArguments, verbatim: false };
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
      `"call "${vcvars}" >nul && cl.exe ${clArguments.map((argument) => `"${argument}"`).join(' ')}"`,
    ],
    verbatim: true,
  };
}

const headFrom = host.indexOf('bool DispatchWindowsAction(');
const headMarker = 'bool dispatched = false;';
const headTo = host.indexOf(headMarker, headFrom);
const head =
  headFrom >= 0 && headTo > headFrom ? host.slice(headFrom, headTo + headMarker.length) : '';

const program = String.raw`
#include <cstdint>
#include <iostream>
#include <string>
#include <string_view>
#include <vector>

#include "computer_use_native_interlock_capture.h"

namespace {

using sprint_coder::computer_use::InterlockEvaluation;
using sprint_coder::computer_use::InterlockNoVerdict;
using sprint_coder::computer_use::InterlockOutcome;
using sprint_coder::computer_use::InterlockReason;

struct RECT { long left = 0; long top = 0; long right = 0; long bottom = 0; };
struct WindowsSession {
  std::uint64_t cancel_epoch = 0;
  std::uint32_t pid = 4242;
  bool has_focused_element_signature = true;
  std::string focused_element_signature = "observed-focus";
};
struct WindowsClickBasis { bool tracked = false; bool opens = false; bool input_read = false; unsigned long input_tick = 0; };

std::vector<std::string> g_calls;
std::string g_kind = "click";
bool g_binding_ok = true;
InterlockEvaluation g_answer;
// What the focus is after the interlocks ran, and whether it can be read.
std::string g_focus_after_interlock = "observed-focus";
bool g_focus_readable = true;
bool g_focus_changes_during_interlock = false;
std::string g_focus_now = "observed-focus";

bool WindowsFocusedElementSignature(std::uint32_t, const RECT &, std::string *signature) {
  g_calls.push_back("focus");
  if (!g_focus_readable) return false;
  *signature = g_focus_now;
  return true;
}

bool ValidateWindowsDispatchBinding(const WindowsSession &, const std::string &, std::string *kind,
                                    RECT *, std::string *reason) {
  g_calls.push_back("validate");
  if (!g_binding_ok) {
    *reason = "stale_target";
    return false;
  }
  *kind = g_kind;
  return true;
}

InterlockEvaluation WindowsInterlockRefusal(const WindowsSession &, const std::string &,
                                            const std::string &kind, WindowsClickBasis * = nullptr) noexcept {
  g_calls.push_back("interlock:" + kind);
  // The evaluation takes time: the focus can move to another control while it runs.
  if (g_focus_changes_during_interlock) g_focus_now = g_focus_after_interlock;
  return g_answer;
}

//@@HEAD@@
  (void)dispatched;
  (void)expected_epoch;
  (void)bounds;
  g_calls.push_back("v1-guards");
  return true;
}

int g_failures = 0;
void Check(bool ok, const char *name) {
  if (!ok) {
    ++g_failures;
    std::cout << "FAIL " << name << "\n";
  }
}

struct Outcome { bool ran_on; bool accepted; std::string reason; std::vector<std::string> calls; };
Outcome Run() {
  g_calls.clear();
  g_focus_now = "observed-focus";
  WindowsSession session;
  std::string result;
  std::string reason;
  bool accepted = true;
  const bool ran_on = DispatchWindowsAction(session, "{}", &result, &reason, &accepted);
  return {ran_on, accepted, reason, g_calls};
}

} // namespace

int main() {
  struct Row { InterlockOutcome outcome; InterlockReason reason; const char *code; };
  const Row rows[] = {
      {InterlockOutcome::kBlocked, InterlockReason::kShellSurface, "shell_surface_blocked"},
      {InterlockOutcome::kTakeover, InterlockReason::kExecutionTrigger, "execution_trigger_blocked"},
      {InterlockOutcome::kBlocked, InterlockReason::kApprovalClosed, "approval_not_enabled"},
  };
  for (const Row &row : rows) {
    g_binding_ok = true;
    g_answer = InterlockEvaluation{};
    g_answer.verdict.outcome = row.outcome;
    g_answer.verdict.reason = row.reason;
    const Outcome outcome = Run();
    Check(!outcome.ran_on && !outcome.accepted && outcome.reason == row.code, "refusal_code_and_not_accepted");
    // The binding first, the interlocks second, and nothing after a refusal (no V1 guards, no input).
    Check(outcome.calls == std::vector<std::string>({"validate", "interlock:click"}), "refusal_order_and_nothing_after");
  }
  for (const InterlockNoVerdict none : {InterlockNoVerdict::kBudget, InterlockNoVerdict::kIncomplete, InterlockNoVerdict::kCanceled}) {
    g_answer = InterlockEvaluation{};
    g_answer.no_verdict = none;
    const Outcome outcome = Run();
    Check(outcome.ran_on && outcome.reason.empty(), "no_verdict_goes_on_to_v1");
    Check(outcome.calls == std::vector<std::string>({"validate", "interlock:click", "v1-guards"}), "no_verdict_order");
  }
  // The focus recheck, for a key or a text, after the interlocks and before any input: the signature
  // is the observed one (go on), another one (stop, no input), or unreadable (stop).
  g_binding_ok = true;
  g_answer = InterlockEvaluation{};
  for (const char *kind : {"key", "type"}) {
    g_kind = kind;
    g_focus_readable = true;
    g_focus_changes_during_interlock = false;
    {
      const Outcome outcome = Run();
      Check(outcome.ran_on && outcome.calls == std::vector<std::string>({"validate", std::string("interlock:") + kind, "focus", "v1-guards"}),
            "focus_unchanged_goes_on");
    }
    g_focus_changes_during_interlock = true;
    g_focus_after_interlock = "another-control";
    {
      const Outcome outcome = Run();
      Check(!outcome.ran_on && !outcome.accepted && outcome.reason == "focused_target_changed" &&
                outcome.calls == std::vector<std::string>({"validate", std::string("interlock:") + kind, "focus"}),
            "focus_moved_during_the_interlocks_sends_nothing");
    }
    g_focus_changes_during_interlock = false;
    g_focus_readable = false;
    {
      const Outcome outcome = Run();
      Check(!outcome.ran_on && outcome.reason == "focused_target_changed", "unreadable_focus_sends_nothing");
    }
    g_focus_readable = true;
  }
  // Other kinds do not look at the focus again (their V1 checks are their own).
  g_kind = "click";
  g_focus_changes_during_interlock = true;
  {
    const Outcome outcome = Run();
    Check(outcome.ran_on && outcome.calls == std::vector<std::string>({"validate", "interlock:click", "v1-guards"}),
          "click_does_not_recheck_the_focus");
  }
  g_focus_changes_during_interlock = false;
  g_kind = "click";
  // A failed binding is V1's own refusal and the interlocks are never asked.
  g_binding_ok = false;
  g_answer = InterlockEvaluation{};
  g_answer.verdict.outcome = InterlockOutcome::kBlocked;
  g_answer.verdict.reason = InterlockReason::kShellSurface;
  {
    const Outcome outcome = Run();
    Check(!outcome.ran_on && outcome.reason == "stale_target" && outcome.calls == std::vector<std::string>({"validate"}),
          "failed_binding_asks_nothing");
  }
  std::cout << (g_failures == 0 ? "OK\n" : "FAILED\n");
  return g_failures == 0 ? 0 : 1;
}
`;

const scratch = mkdtempSync(join(tmpdir(), 'computer-use-dispatch-interlock-'));
const source = join(scratch, 'seam.cc');
const binary = join(scratch, process.platform === 'win32' ? 'seam.exe' : 'seam');
const build = findBuild(source, binary);

describe.skipIf(build === null && process.env['CI'] === undefined)(
  'dispatch interlock check, the real head of DispatchWindowsAction (#500 S5-c-2 PR-5)',
  () => {
    it('refuses with the verdict code before anything else, goes on without a verdict, and asks nothing when the binding fails', () => {
      try {
        expect(build, 'a C++ compiler is required to run this seam in CI').not.toBeNull();
        expect(head.length).toBeGreaterThan(200);
        writeFileSync(source, program.replace('//@@HEAD@@', head));
        const compiler = build!;
        const built = spawnSync(compiler.file, compiler.args, {
          encoding: 'utf8',
          windowsVerbatimArguments: compiler.verbatim,
          timeout: 120_000,
          env: { ...process.env, VSLANG: '1033' },
        });
        expect(built.status, `${compiler.name}\n${built.stdout}\n${built.stderr}`).toBe(0);
        const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 20_000 });
        expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
        expect(run.stdout).toContain('OK');
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    }, 180_000);
  },
);
