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
      'if (sent > 0) { *accepted = true; RecordWindowsClick(screen_x, screen_y); }',
    );
    expect(host.match(/RecordWindowsClick\(/gu)).toHaveLength(2); // the definition and that one call
  });

  it('keeps the previous click and our last injection once per process, behind a mutex, never destroyed', () => {
    const block = squash(clickRuleBlock());
    expect(block).toContain('struct WindowsClickState { std::mutex lock;');
    expect(block).toContain('static WindowsClickState *state = new WindowsClickState();');
    // No per-session copy of it (a new session starts on the same machine).
    expect(host).not.toContain('WindowsLastClick');
    expect(host).not.toContain('last_click');
    // Every read and write of it holds the lock.
    expect(block.match(/std::lock_guard<std::mutex> guard\(state\.lock\);/gu)).toHaveLength(3);
    // Our own injections are noted at the one place that sends input.
    const send = squash(host.slice(host.indexOf('UINT SendInputForBoundTarget(')));
    expect(send.slice(0, send.indexOf('WORD VirtualKeyForName'))).toContain(
      'if (sent > 0) RecordWindowsOwnInput(before_read, before_tick);',
    );
  });

  it('treats input from somewhere else since our last injection as possibly pairing, failing toward "opens"', () => {
    const block = squash(clickRuleBlock());
    expect(block).toContain('GetLastInputInfo(&info)');
    expect(block).toContain('if (!ReadSystemLastInput(&last_input)) return true;');
    expect(block).toContain('sprint_coder::computer_use::ExternalInputWithinDoubleClick(');
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
      'job.click_opens = kind == "click" && point_known && WindowsClickOpens(point);',
    );
    expect(squashed).toContain('info.click_opens = kind == "click" && WindowsClickOpens(point);');
    // The synchronous entry leaves before it uses the point when a click has none.
    const guard = 'if ((kind == "click" || kind == "scroll") && !point_known) return unavailable;';
    const entry = squashed.slice(squashed.indexOf('EvaluateWindowsInterlockOnLane('));
    expect(entry).toContain(guard);
    expect(entry.indexOf(guard)).toBeLessThan(entry.indexOf('WindowsClickOpens(point)'));
    // Only the dispatch records a click, and the dispatch never asks: preflight (where click_opens
    // is computed) runs before the dispatch of the same click (the ticket comes from it), so a click
    // is compared with the PREVIOUS one, never with itself.
    const preflight = host.slice(host.indexOf('bool HandleWindowsPreflight('));
    expect(preflight.slice(0, preflight.indexOf('\nbool ', 10))).not.toContain(
      'RecordWindowsClick(',
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
#include <mutex>

#include "computer_use_effect_shadow.h"

namespace {

//@@BLOCK@@

} // namespace

int failures = 0;
void Check(bool ok, const char *name) {
  if (!ok) {
    ++failures;
    std::cout << "FAIL " << name << "\n";
  }
}

// True while nobody else has touched the mouse or keyboard since our last injection (a person at
// the machine during the run only makes the helper answer "opens", which is the safe side).
void NoteOwn() {
  DWORD tick = 0;
  ReadSystemLastInput(&tick);
  RecordWindowsOwnInput(true, tick);
}
bool Quiet() {
  DWORD last = 0;
  if (!ReadSystemLastInput(&last)) return false;
  WindowsClickState &state = ClickState();
  return !sprint_coder::computer_use::ExternalInputWithinDoubleClick(
      state.has_input, state.input_before_tick, state.input_after_tick, last, static_cast<std::uint32_t>(GetTickCount64()),
      GetDoubleClickTime());
}
void CheckNotOpening(POINT point, bool single, const char *name) {
  const bool before = Quiet();
  const bool result = WindowsClickOpens(point);
  if (before && Quiet()) Check(result == single, name);
}

int main() {
  const bool single = WindowsSingleClickOpens();
  const DWORD interval = GetDoubleClickTime();
  std::cout << "single_click_opens=" << single << " interval=" << interval << "\n";
  // A baseline: our own injection note, as the host takes after each SendInput.
  Sleep(interval + 150);
  NoteOwn();
  CheckNotOpening(POINT{50, 50}, single, "no_previous_click");
  RecordWindowsClick(50, 50);
  // The same point at once: a double click (and always opens when the setting is on).
  Check(WindowsClickOpens(POINT{50, 50}), "same_point_at_once_completes_a_double_click");
  // Far away: not one.
  CheckNotOpening(POINT{500, 500}, single, "far_away_is_not_a_double_click");
  // After the interval: not one.
  Sleep(interval + 150);
  NoteOwn();
  CheckNotOpening(POINT{50, 50}, single, "after_the_interval_is_not_a_double_click");
  // A new click starts a new pair.
  RecordWindowsClick(50, 50);
  Check(WindowsClickOpens(POINT{50, 50}), "a_new_record_pairs_again");
  // The helper's own injection, noted the way the host does it (before and after SendInput, with no
  // wait in between), is not input from elsewhere. Skipped when a person is at the machine.
  {
    DWORD before = 0;
    const bool before_read = ReadSystemLastInput(&before);
    INPUT own{};
    own.type = INPUT_KEYBOARD;
    own.ki.wVk = VK_F24;
    own.ki.dwFlags = KEYEVENTF_KEYUP;
    SendInput(1, &own, sizeof(INPUT));
    RecordWindowsOwnInput(before_read, before);
    if (Quiet())
      Check(!WindowsClickOpens(POINT{900, 900}) || single, "own_injection_is_not_external_input");
    else
      std::cout << "skip own_injection (somebody else is using the machine)\n";
  }
  // Input that did not come through the helper (a key-up of an unassigned key sent directly)
  // makes the next click possibly paired, wherever it lands.
  Sleep(interval + 150);
  NoteOwn();
  DWORD before_tick = 0;
  ReadSystemLastInput(&before_tick);
  INPUT key{};
  key.type = INPUT_KEYBOARD;
  key.ki.wVk = VK_F24;
  key.ki.dwFlags = KEYEVENTF_KEYUP;
  SendInput(1, &key, sizeof(INPUT));
  Sleep(30);
  DWORD after_tick = 0;
  ReadSystemLastInput(&after_tick);
  if (after_tick != before_tick)
    Check(WindowsClickOpens(POINT{900, 900}), "input_from_elsewhere_is_possibly_a_pair");
  else
    std::cout << "skip input_from_elsewhere (the system did not move its last input time)\n";
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
