import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The click rule on Windows (#500 S5-c-2 PR-2). The portable rule (MayOpen, ItemInSpan,
// RecentInputMayCompleteDoubleClick) is exercised by the harness (computer_use_protocol_fuzz.cc). Tied here:
// what only the host knows (the system's last input time, the double-click time, the file
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
      'return facts.action == ActionKind::kDoubleClick || facts.action == ActionKind::kInvoke || (facts.action == ActionKind::kKey && facts.key_is_activation) || (facts.action == ActionKind::kClick && !(facts.click_tracked && facts.surface == SurfaceKind::kFileBrowser && ItemInSpan(facts)));',
    );
  });

  it('turns a true click into a double click in the facts, for a click only', () => {
    expect(squash(shadow)).toContain(
      'if (request.kind == "click" && request.click_opens) action = ActionKind::kDoubleClick;',
    );
    expect(shadow).toContain('bool click_opens = false;');
  });

  it('counts keys that open: Enter, and any chord with a command modifier; not a bare arrow', () => {
    expect(squash(shadow)).toContain(
      'facts.key_is_activation = request.kind == "key" && ShadowKeyOpens(request.key);',
    );
    expect(shadow).toContain(
      '"cmd", "command", "ctrl", "control", "alt", "option", "opt", "win", "windows", "meta", "super"',
    );
    expect(squash(shadow)).toContain(
      'facts.click_tracked = request.kind == "click" && request.click_tracked;',
    );
  });

  it('keeps the macOS source out of it: Finder has no single-click-to-open setting, and the wire has no double click', () => {
    expect(read('computer_use_macos.mm')).not.toContain('click_opens');
  });
});

describe('click rule (#500 S5-c-2 PR-2): the Windows host', () => {
  it('keeps no record of clicks: the rule is the last input time of the system alone', () => {
    const block = squash(clickRuleBlock());
    expect(host).not.toContain('RecordWindowsClick');
    expect(host).not.toContain('RecordWindowsOwnInput');
    expect(host).not.toContain('WindowsClickState');
    expect(host).not.toContain('GetTickCount()');
    // Sending input is untouched: no new Win32 call there.
    const send = host.slice(host.indexOf('UINT SendInputForBoundTarget('));
    const sendBody = send.slice(0, send.indexOf('WORD VirtualKeyForName'));
    for (const call of ['GetLastInputInfo', 'GetTickCount', 'Record', 'ClickState'])
      expect(sendBody).not.toContain(call);
    expect(sendBody).toContain('return SendInput(count, events, sizeof(INPUT));');
    expect(block).toContain('GetLastInputInfo(&info)');
    expect(block).toContain(
      'sprint_coder::computer_use::RecentInputMayCompleteDoubleClick( read, read ? info.dwTime : 0, static_cast<std::uint32_t>(GetTickCount64()), GetDoubleClickTime());',
    );
    expect(block).toContain('return WindowsSingleClickOpens() || WindowsRecentInputMayPair();');
  });

  it('reads the setting from the shell, failing toward "opens"', () => {
    const block = squash(clickRuleBlock());
    expect(block).toContain('SHELLSTATE state{};');
    expect(block).toContain('SHGetSetSettings(&state, SSF_DOUBLECLICKINWEBVIEW, FALSE);');
    expect(block).toContain('return state.fDoubleClickInWebView == 0;');
  });

  it('hands click_opens to the shadow and to the synchronous entry, for a click with a point, and nowhere else', () => {
    const squashed = squash(host);
    expect(host.match(/WindowsClickOpens\(/gu)).toHaveLength(3); // the definition and two uses
    expect(squashed).toContain(
      'job.click_tracked = kind == "click" && point_known; job.click_opens = job.click_tracked && WindowsClickOpens();',
    );
    // The synchronous entry takes both on the lane, before the worker exists, and hands them to the
    // worker by value; the worker reads no system state of its own for them.
    expect(squashed).toContain(
      'const bool click_tracked = kind == "click"; const bool click_opens = click_tracked && WindowsClickOpens();',
    );
    expect(squashed).toContain(
      'info.click_tracked = click_tracked; info.click_opens = click_opens;',
    );
    const lane = squashed.indexOf('const bool click_opens = click_tracked && WindowsClickOpens();');
    expect(lane).toBeLessThan(squashed.indexOf('std::thread([pending'));
    expect(lane).toBeLessThan(squashed.indexOf('running.exchange(true)'));
    const worker = squashed.slice(
      squashed.indexOf('std::thread([pending'),
      squashed.indexOf('}).detach();'),
    );
    expect(worker).not.toContain('WindowsClickOpens(');
    // The synchronous entry leaves before it uses the point when a click has none.
    const guard = 'if ((kind == "click" || kind == "scroll") && !point_known) return unavailable;';
    const entry = squashed.slice(squashed.indexOf('EvaluateWindowsInterlockOnLane('));
    expect(entry).toContain(guard);
    expect(entry.indexOf(guard)).toBeLessThan(entry.indexOf('WindowsClickOpens()'));
    expect(squash(scheduler)).toContain('info.click_opens = job.click_opens;');
    expect(scheduler).toContain('bool click_opens = false;');
    expect(squash(scheduler)).toContain('info.click_tracked = job.click_tracked;');
    // macOS follows no clicks yet: it sets neither flag, so a click there counts as before.
    const mac = read('computer_use_macos.mm');
    expect(mac).not.toContain('click_tracked');
    expect(mac).not.toContain('click_opens');
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

// The system's last input time must be fresh or stale on purpose: a person at the machine only makes
// the answer "may pair", so a check that expects "stale" is skipped then.
int main() {
  const DWORD interval = GetDoubleClickTime();
  std::cout << "interval=" << interval << "\n";
  // Input a moment ago: a click now may pair with it.
  INPUT key{};
  key.type = INPUT_KEYBOARD;
  key.ki.wVk = VK_F24;
  key.ki.dwFlags = KEYEVENTF_KEYUP;
  SendInput(1, &key, sizeof(INPUT));
  Sleep(30);
  DWORD stamp = 0;
  LASTINPUTINFO info{};
  info.cbSize = sizeof(info);
  const bool moved = GetLastInputInfo(&info) != FALSE;
  stamp = info.dwTime;
  if (moved && static_cast<DWORD>(GetTickCount()) - stamp <= interval)
    Check(WindowsRecentInputMayPair(), "input_a_moment_ago_may_pair");
  else
    std::cout << "skip input_a_moment_ago (the system did not stamp the input)\n";
  // Past the interval with no input from anyone: it cannot pair.
  Sleep(interval + 250);
  LASTINPUTINFO later{};
  later.cbSize = sizeof(later);
  if (GetLastInputInfo(&later) && static_cast<DWORD>(GetTickCount()) - later.dwTime > interval)
    Check(!WindowsRecentInputMayPair(), "no_input_for_longer_than_the_interval_cannot_pair");
  else
    std::cout << "skip stale_check (somebody else is using the machine)\n";
  // The click opens when either part says so.
  Check(WindowsClickOpens() == (WindowsSingleClickOpens() || WindowsRecentInputMayPair()), "click_opens_is_the_or");
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
    it('decides by the last input time alone with the real clock and the real shell setting', () => {
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
