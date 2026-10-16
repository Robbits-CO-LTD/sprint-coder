import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The click rule on Windows (#500 S5-c-2 PR-2). The portable rule (MayOpen, ItemInSpan,
// ClickCompletesDoubleClick) is exercised by the harness (computer_use_protocol_fuzz.cc). Tied here:
// what only the host knows (the previous click, the double-click time and distance, the file
// manager's "single click to open" setting) reaches the facts as `click_opens`, and a live run of the
// host's own helpers against the real clock and the real shell setting.

const nativeDirectory = join(__dirname, '../../computer-use-native');
const read = (name: string): string => readFileSync(join(nativeDirectory, name), 'utf8');
const host = read('computer_use_windows_host.cc');
const scheduler = read('computer_use_windows_shadow_scheduler.h');
const shadow = read('computer_use_effect_shadow.h');
const classifier = read('computer_use_effect_classifier.h');
const interlock = read('computer_use_native_interlock.h');
const squash = (text: string): string => text.replace(/\s+/gu, ' ');

const BEGIN = '// BEGIN click rule';
const END = '// END click rule';

function clickRuleBlock(): string {
  const begin = host.indexOf(BEGIN);
  const end = host.indexOf(END);
  if (begin < 0 || end <= begin) throw new Error('Click rule markers changed');
  return host.slice(begin, end);
}

describe('click rule (#500 S5-c-2 PR-2): portable', () => {
  it('moves the role walk into the core and leaves the interlock a reference only', () => {
    for (const name of ['RoleIsPassiveItem', 'RoleIsKnownContainer', 'ItemInSpan']) {
      expect(classifier, name).toMatch(new RegExp(`inline bool ${name}\\(`, 'u'));
      expect(interlock, name).not.toMatch(new RegExp(`inline bool ${name}\\(`, 'u'));
      expect(interlock, name).toContain(`using effect_detail::${name};`);
    }
    // The walk is defined before MayOpen, inside the core's detail namespace.
    expect(classifier.indexOf('inline bool ItemInSpan(')).toBeLessThan(
      classifier.indexOf('inline bool MayOpen('),
    );
  });

  it('counts a double click, an invoke, an activating key and a click that is not a known passive file-manager item', () => {
    const body = squash(classifier.slice(classifier.indexOf('inline bool MayOpen(')));
    expect(body).toContain(
      'return facts.action == ActionKind::kDoubleClick || facts.action == ActionKind::kInvoke || (facts.action == ActionKind::kKey && facts.key_is_activation) || (facts.action == ActionKind::kClick && !(facts.surface == SurfaceKind::kFileBrowser && ItemInSpan(facts)));',
    );
  });

  it('turns a true click into a double click in the facts, for a click only', () => {
    expect(squash(shadow)).toContain(
      'if (request.kind == "click" && request.click_opens) action = ActionKind::kDoubleClick;',
    );
    expect(shadow).toContain('bool click_opens = false;');
  });

  it('keeps the macOS source out of it: Finder has no single-click-to-open setting, and the wire has no double click', () => {
    expect(read('computer_use_macos.mm')).not.toContain('click_opens');
  });
});

describe('click rule (#500 S5-c-2 PR-2): the Windows host', () => {
  it('remembers the click that was sent, only when input was accepted', () => {
    const squashed = squash(host);
    expect(squashed).toContain(
      'if (sent > 0) { *accepted = true; RecordWindowsClick(session, screen_x, screen_y); }',
    );
    expect(host.match(/RecordWindowsClick\(/gu)).toHaveLength(2); // the definition and that one call
    expect(squash(host)).toContain(
      'struct WindowsLastClick { bool has = false; std::uint64_t tick_ms = 0; LONG x = 0; LONG y = 0; };',
    );
    expect(host).toContain(
      'std::shared_ptr<WindowsLastClick> last_click = std::make_shared<WindowsLastClick>();',
    );
  });

  it('reads the double-click time and distance from the system, and the setting from the shell, failing toward "opens"', () => {
    const block = squash(clickRuleBlock());
    expect(block).toContain('SHELLSTATE state{};');
    expect(block).toContain('SHGetSetSettings(&state, SSF_DOUBLECLICKINWEBVIEW, FALSE);');
    expect(block).toContain('return state.fDoubleClickInWebView == 0;');
    expect(block).toContain('GetSystemMetrics(SM_CXDOUBLECLK) / 2');
    expect(block).toContain('GetSystemMetrics(SM_CYDOUBLECLK) / 2');
    expect(block).toContain('GetDoubleClickTime()');
    expect(block).toContain('GetTickCount64()');
    expect(block).toContain('if (slop_x <= 0 || slop_y <= 0) return true;');
    expect(block).toContain('if (WindowsSingleClickOpens()) return true;');
    expect(block).toContain('sprint_coder::computer_use::ClickCompletesDoubleClick(');
  });

  it('hands click_opens to the shadow and to the synchronous entry, for a click with a point, and nowhere else', () => {
    const squashed = squash(host);
    expect(host.match(/WindowsClickOpens\(/gu)).toHaveLength(3); // the definition and two uses
    expect(squashed).toContain(
      'job.click_opens = kind == "click" && point_known && WindowsClickOpens(session, point);',
    );
    expect(squashed).toContain(
      'info.click_opens = kind == "click" && WindowsClickOpens(session, point);',
    );
    expect(squash(scheduler)).toContain('info.click_opens = job.click_opens;');
    expect(scheduler).toContain('bool click_opens = false;');
    // Not the dispatch: the click that is being sent is not yet a "previous" click.
    const dispatch = host.slice(host.indexOf('bool DispatchWindowsAction('));
    expect(dispatch.slice(0, dispatch.indexOf('BackendProbe ProbeBackend('))).not.toContain(
      'WindowsClickOpens(',
    );
  });

  it('adds no version and wires nothing new into preflight or dispatch', () => {
    const eligibility = JSON.parse(read('eligibility.json')) as {
      versions: Record<string, number>;
    };
    expect(eligibility.versions).toEqual({
      rulesetVersion: 1,
      classifierVersion: 1,
      lexiconVersion: 1,
    });
    expect(host).not.toContain('EvaluateWindowsInterlockOnLane(session, metadata, kind');
  });
});

const vswhere = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';

type Build = Readonly<{ name: string; file: string; args: string[]; verbatim: boolean }>;

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
    'user32.lib',
    'shell32.lib',
  ];
}

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

// The host's own helpers, cut out as they are, with a stub session that has only what they read.
const program = String.raw`
#include <windows.h>
#include <shlobj.h>

#include <cstdint>
#include <iostream>
#include <memory>

#include "computer_use_effect_shadow.h"

namespace {

struct WindowsLastClick {
  bool has = false;
  std::uint64_t tick_ms = 0;
  LONG x = 0;
  LONG y = 0;
};
struct WindowsSession {
  std::shared_ptr<WindowsLastClick> last_click = std::make_shared<WindowsLastClick>();
};

//@@BLOCK@@

} // namespace

int failures = 0;
void Check(bool ok, const char *name) {
  if (!ok) {
    ++failures;
    std::cout << "FAIL " << name << "\n";
  }
}

int main() {
  const bool single = WindowsSingleClickOpens();
  const DWORD interval = GetDoubleClickTime();
  std::cout << "single_click_opens=" << single << " interval=" << interval << "\n";
  WindowsSession session;
  // No click was sent yet: only the setting can make a click open.
  Check(WindowsClickOpens(session, POINT{50, 50}) == single, "no_previous_click");
  RecordWindowsClick(session, 50, 50);
  // The same point at once: a double click (and always opens when the setting is on).
  Check(WindowsClickOpens(session, POINT{50, 50}), "same_point_at_once_completes_a_double_click");
  // Far away: not one.
  Check(WindowsClickOpens(session, POINT{500, 500}) == single, "far_away_is_not_a_double_click");
  // After the interval: not one.
  Sleep(interval + 150);
  Check(WindowsClickOpens(session, POINT{50, 50}) == single, "after_the_interval_is_not_a_double_click");
  // A new click starts a new pair.
  RecordWindowsClick(session, 50, 50);
  Check(WindowsClickOpens(session, POINT{50, 50}), "a_new_record_pairs_again");
  std::cout << (failures == 0 ? "OK\n" : "FAILED\n");
  return failures == 0 ? 0 : 1;
}
`;

const onWindows = process.platform === 'win32';
const build = (() => {
  if (!onWindows) return null;
  const scratch = mkdtempSync(join(tmpdir(), 'computer-use-click-rule-'));
  const source = join(scratch, 'seam.cc');
  const binary = join(scratch, 'seam.exe');
  return { scratch, source, binary, compiler: findBuild(source, binary) };
})();

describe.skipIf(!onWindows || (build?.compiler === null && !process.env['CI']))(
  'click rule, the host helpers live (#500 S5-c-2 PR-2)',
  () => {
    it('pairs two clicks by time and distance with the real clock and the real shell setting', () => {
      const context = build!;
      try {
        expect(context.compiler, 'cl.exe (MSVC) is required on a Windows CI runner').not.toBeNull();
        writeFileSync(context.source, program.replace('//@@BLOCK@@', clickRuleBlock()));
        const compiler = context.compiler!;
        const built = spawnSync(compiler.file, compiler.args, {
          encoding: 'utf8',
          windowsVerbatimArguments: compiler.verbatim,
          timeout: 180_000,
          env: { ...process.env, VSLANG: '1033' },
        });
        expect(built.status, `${compiler.name}\n${built.stdout}\n${built.stderr}`).toBe(0);
        const run = spawnSync(context.binary, [], { encoding: 'utf8', timeout: 60_000 });
        console.log(run.stdout);
        expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
        expect(run.stdout).toContain('OK');
      } finally {
        rmSync(context.scratch, { recursive: true, force: true });
      }
    }, 300_000);
  },
);
