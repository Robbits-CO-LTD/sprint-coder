import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Source contracts for the Windows synchronous interlock entry (classifier v2, S5-c-1). It is a
// behaviour-neutral twin of the macOS S4-1b-1: the UI Automation capture of the shadow can be run
// synchronously and answered by the interlock map, as "a verdict" or "no verdict, and why". The
// behaviour of the portable half is in the harness (computer_use_protocol_fuzz.cc, MSVC and clang,
// against a fake UI Automation tree). What is tied here: the header is portable, canceled / budget /
// incomplete are answered BEFORE the map, and NOTHING in the preflight or the dispatch calls the
// entry yet (S5-c-2 is the producer). The shadow's own wiring is not the entry's business.

const nativeDirectory = join(__dirname, '../../computer-use-native');
const read = (name: string): string => readFileSync(join(nativeDirectory, name), 'utf8');
const header = read('computer_use_windows_interlock_capture.h');
const host = read('computer_use_windows_host.cc');
const harness = read('computer_use_protocol_fuzz.cc');

const BEGIN = '// BEGIN sync interlock entry (classifier v2 S5-c-1)';
const END = '// END sync interlock entry';
const SHADOW_BEGIN = '// BEGIN effect shadow wiring';
const SHADOW_END = '// END effect shadow wiring';
const code = (text: string): string =>
  text.replace(/\/\/.*$/gmu, '').replace(/"(?:[^"\\]|\\.)*"/gu, '""');

function between(text: string, begin: string, end: string): string {
  const from = text.indexOf(begin);
  const to = text.indexOf(end, from + begin.length);
  expect(from, begin).toBeGreaterThanOrEqual(0);
  expect(to, end).toBeGreaterThan(from);
  return text.slice(from + begin.length, to);
}

const entry = between(host, BEGIN, END);
const outside = host.replace(BEGIN + entry + END, '');
const shadow = between(host, SHADOW_BEGIN, SHADOW_END);

describe('Windows synchronous interlock entry (classifier v2, S5-c-1)', () => {
  it('is portable: the two portable cores only, no platform header, no thread, no clock of its own', () => {
    expect(header).toContain('#pragma once');
    const allowed = new Set([
      '"computer_use_native_interlock_capture.h"',
      '"computer_use_windows_shadow_reader.h"',
      '<string_view>',
    ]);
    for (const match of header.matchAll(/^\s*#\s*include\s+(\S+)/gmu))
      expect(allowed.has(match[1]!), match[1]).toBe(true);
    expect(header).not.toMatch(/#\s*if(n?def)?\s+.*(_WIN32|__APPLE__|__linux__|_MSC_VER)/u);
    expect(header).not.toMatch(
      /windows\.h|UIAutomation|<chrono>|<thread>|getenv|fopen|fstream|clock_gettime|napi/iu,
    );
    expect(header).not.toMatch(/kNativePreflightClassifierVersion|classifierVersion/u);
  });

  it('answers no verdict for cancel, then budget, then incomplete facts, before the map is asked', () => {
    const squashed = code(header).replace(/\s+/gu, ' ');
    const cancel = squashed.indexOf('if (stopped_by_cancel) {');
    const budget = squashed.indexOf('if (capture.budget_exhausted) {');
    const complete = squashed.indexOf('if (!interlock_detail::FactsAreComplete(built.facts)) {');
    const map = squashed.indexOf('InterlockForFacts(built.facts, ruleset)');
    expect(cancel).toBeGreaterThan(0);
    expect(budget).toBeGreaterThan(cancel);
    expect(complete).toBeGreaterThan(budget);
    expect(map).toBeGreaterThan(complete);
    // A file item of a file manager whose real path is unknown is no verdict, asked before the map.
    const item = squashed.indexOf(
      'capture.item_kind == ShadowItemKind::kFile && !(capture.item_name_read && capture.item_name_is_real_path)',
    );
    expect(item).toBeGreaterThan(complete);
    expect(map).toBeGreaterThan(item);
    expect(squashed).toContain('result.no_verdict = InterlockNoVerdict::kCanceled;');
    expect(squashed).toContain('result.no_verdict = InterlockNoVerdict::kBudget;');
    expect(squashed).toContain('result.no_verdict = InterlockNoVerdict::kIncomplete;');
    // The shadow's own reader and gate, and the end-of-capture check the shadow asks.
    expect(squashed).toContain('WindowsShadowReader reader(source);');
    expect(squashed).toContain('reader.Canceled() || !source.ActionStillValid()');
  });

  it('is defined once in the host and asked from exactly two places: the preflight and the dispatch (S5-c-2 PR-5)', () => {
    expect(entry.length).toBeGreaterThan(200);
    expect(host).toContain('#include "computer_use_windows_interlock_capture.h"');
    // The lane's entry is defined once and used by the one wrapper; the wrapper by the two callers.
    expect(host.match(/\bEvaluateWindowsInterlockOnLane\(/gu)).toHaveLength(2);
    const calls = [...code(outside).matchAll(/\bWindowsInterlockRefusal\(/gu)];
    // the forward declaration and the two calls (the definition is inside the entry)
    expect(calls).toHaveLength(3);
    const preflightAt = outside.indexOf('bool HandleWindowsPreflight(');
    const dispatchAt = outside.indexOf('bool DispatchWindowsAction(');
    expect(preflightAt).toBeGreaterThan(0);
    expect(dispatchAt).toBeGreaterThan(0);
    const preflightText = code(
      outside.slice(preflightAt, outside.indexOf('\nbool ObserveWindowsWindow(')),
    );
    const dispatchText = code(
      outside.slice(dispatchAt, outside.indexOf('BackendProbe ProbeBackend(')),
    );
    expect(preflightText.match(/\bWindowsInterlockRefusal\(/gu)).toHaveLength(1);
    expect(dispatchText.match(/\bWindowsInterlockRefusal\(/gu)).toHaveLength(1);
    // No other message path asks: observe, start_session, list_targets, cancel, close.
    const rest = outside
      .replace(outside.slice(preflightAt, outside.indexOf('\nbool ObserveWindowsWindow(')), '')
      .replace(outside.slice(dispatchAt, outside.indexOf('BackendProbe ProbeBackend(')), '');
    expect(code(rest).match(/\bWindowsInterlockRefusal\(/gu)).toHaveLength(1); // the declaration
    expect(code(rest)).not.toMatch(
      /EvaluateWindowsInterlockOnSource|EvaluateWindowsInterlockFromCapture/u,
    );
  });

  it('asks in the preflight after the V1 binding and before a ticket is issued; in the dispatch after the binding and before any input', () => {
    const preflightAt = outside.indexOf('bool HandleWindowsPreflight(');
    const preflight = code(
      outside.slice(preflightAt, outside.indexOf('\nbool ObserveWindowsWindow(')),
    );
    const validate = preflight.indexOf('ValidateWindowsDispatchBinding(');
    const ask = preflight.indexOf('WindowsInterlockRefusal(');
    const issue = preflight.indexOf('state.slot.Issue(');
    expect(validate).toBeGreaterThan(0);
    expect(ask).toBeGreaterThan(validate);
    expect(issue).toBeGreaterThan(ask);
    // The refusal receipt goes through the closed table before it is sent; a pair outside it is denied.
    const rawPreflight = outside.slice(
      preflightAt,
      outside.indexOf('\nbool ObserveWindowsWindow('),
    );
    const refusal = rawPreflight
      .slice(
        rawPreflight.indexOf('WindowsInterlockRefusal('),
        rawPreflight.indexOf('state.slot.Issue('),
      )
      .replace(/\s+/gu, ' ');
    expect(refusal).toContain('NativePreflightRefusalAllowed(decision, code, result)');
    expect(refusal).toContain('"denied", "native_preflight_invalid"');
    expect(refusal).toContain('evaluation.verdict.DecisionName()');
    expect(refusal).toContain('evaluation.verdict.ReasonCode()');
    expect(refusal).toContain('evaluation.verdict.DeniedResult()');
    // The refusal issues no ticket and returns before the issuing code.
    expect(refusal).toContain('return sent;');

    const dispatchAt = outside.indexOf('bool DispatchWindowsAction(');
    const dispatch = code(outside.slice(dispatchAt, outside.indexOf('BackendProbe ProbeBackend(')));
    const dValidate = dispatch.indexOf('ValidateWindowsDispatchBinding(');
    const dAsk = dispatch.indexOf('WindowsInterlockRefusal(');
    expect(dValidate).toBeGreaterThan(0);
    expect(dAsk).toBeGreaterThan(dValidate);
    // Before the first input attempt, the cursor, any input API and the semantic action.
    for (const input of [
      'input_api_attempts',
      'SetCursorPos',
      'SendInput',
      'SendInputForBoundTarget',
      'DispatchWindowsSemanticAction',
    ]) {
      const at = dispatch.indexOf(input);
      expect(at, input).toBeGreaterThan(dAsk);
    }
    // A refusal sets the dispatch code of the verdict and refuses without input.
    const block = dispatch
      .slice(dAsk, dispatch.indexOf('bool dispatched = false;'))
      .replace(/\s+/gu, ' ');
    expect(block).toContain('*reason = std::string(evaluation.verdict.DispatchCode());');
    expect(block).toContain('return false;');
  });

  it('uses the Windows rule set with no approval path, and counts the cases that have no verdict', () => {
    const body = entry.replace(/\s+/gu, ' ');
    expect(body).toContain(
      'constexpr sprint_coder::computer_use::EffectRuleset kWindowsInterlockRuleset{ /*download_open=*/false, /*file_manager_open=*/false};',
    );
    expect(body).toContain(
      'EvaluateWindowsInterlockOnLane(session, metadata, kind, kWindowsInterlockRuleset, basis)',
    );
    // Counts and enum names only: no label, no title, no text.
    const counter = entry.slice(
      entry.indexOf('void CountWindowsInterlockNoVerdict('),
      entry.indexOf('WindowsInterlockRefusal(const'),
    );
    expect(counter).toContain('OutputDebugStringA(line)');
    expect(counter).not.toMatch(/label|title|name\s*=\s*node|metadata|text/iu);
  });

  it('leaves INV-3 alone: the function bodies that decide eligibility, the win32 refusal of v2 and the versions are pinned (#500 S5-c-2 PR-5)', () => {
    const squashed = (text: string): string => text.replace(/\s+/gu, ' ').trim();
    const functionBody = (signature: string): string => {
      const from = host.indexOf(signature);
      expect(from, signature).toBeGreaterThanOrEqual(0);
      const open = host.indexOf('{', from);
      let depth = 0;
      for (let index = open; index < host.length; index += 1) {
        if (host[index] === '{') depth += 1;
        else if (host[index] === '}') {
          depth -= 1;
          if (depth === 0) return squashed(host.slice(from, index + 1));
        }
      }
      throw new Error(`unterminated: ${signature}`);
    };
    // What a target must be to get full access, and the one place it is decided.
    expect(functionBody('std::string MaximumModeForWindowsExecutable(')).toBe(
      'std::string MaximumModeForWindowsExecutable( const WindowsExecutableIdentity &identity) { if (!IsPolicyLanguageSupported(identity.policy_language)) return "observe_only"; if (IsTrustedSystemNotepad(identity)) return "full_access_app"; const std::string helper_signer = CurrentHelperSignerDigest(); if (IsAcceptanceFixtureExecutable(identity.path) && !helper_signer.empty() && identity.signer_digest == helper_signer) return "full_access_app"; return "observe_only"; }',
    );
    expect(functionBody('bool IsSupportedWindowsV1Target(')).toBe(
      'bool IsSupportedWindowsV1Target( const WindowsExecutableIdentity &identity) { return MaximumModeForWindowsExecutable(identity) == "full_access_app"; }',
    );
    // The executables a session can never target (a remote desktop, a shell, an installer, Settings, ...).
    const blocked = functionBody('bool IsDisallowedTargetExecutable(const std::wstring &path) {');
    expect(
      [...blocked.matchAll(/L"([^"]+)"/gu)]
        .map((match) => match[1])
        .filter((name) => name!.endsWith('.exe')),
    ).toEqual([
      'mstsc.exe',
      'msrdc.exe',
      'SystemSettings.exe',
      'control.exe',
      'msiexec.exe',
      'setup.exe',
      'install.exe',
      'installer.exe',
      'powershell.exe',
      'pwsh.exe',
      'cmd.exe',
      'wt.exe',
      'WindowsTerminal.exe',
      'wsl.exe',
      'bash.exe',
      'cscript.exe',
      'wscript.exe',
      'regedit.exe',
      'mmc.exe',
      'explorer.exe',
      'taskmgr.exe',
      'msrdcw.exe',
      'RdClient.Windows.exe',
      'QuickAssist.exe',
      'TeamViewer.exe',
      'AnyDesk.exe',
      'RustDesk.exe',
      'parsec.exe',
    ]);
    expect(blocked).toContain(
      'if (_wcsicmp(leaf.c_str(), candidate.data()) == 0) return true; return false; }',
    );
    // The build refuses eligibility v2 for win32 (no deny-list there yet): a Windows helper cannot be
    // built with the interlocks' approval path, or with a wider eligibility.
    const build = squashed(
      readFileSync(join(__dirname, '../../../../build-computer-use-eligibility.mjs'), 'utf8'),
    );
    expect(build).toContain(
      "if (mode === MODES.v2 && target === 'win32') throw new Error( 'Computer Use native --eligibility=v2 is unsupported on Windows until S5 (no deny-list there yet)', );",
    );
    // The classifier version the preflight receipt attests, and the versions of the eligibility.
    expect(read('computer_use_preflight_classifier.h')).toContain(
      'constexpr std::uint32_t kNativePreflightClassifierVersion = 1;',
    );
    expect(
      squashed(host).match(
        /std::to_string\( ?sprint_coder::computer_use::kNativePreflightClassifierVersion\)/gu,
      ),
    ).toHaveLength(1);
    const eligibility = JSON.parse(read('eligibility.json')) as {
      versions: Record<string, number>;
    };
    expect(eligibility.versions).toEqual({
      rulesetVersion: 1,
      classifierVersion: 1,
      lexiconVersion: 1,
    });
  });

  it('takes the rule set from its caller, answers an exception or a missing source as no verdict, and changes nothing', () => {
    const body = code(entry);
    expect(body).toContain('const sprint_coder::computer_use::EffectRuleset &ruleset');
    expect(body.replace(/\s+/gu, ' ')).toContain(
      'EvaluateWindowsInterlockOnSource(*source, kind_copy, target_id, info, ruleset_copy)',
    );
    expect(body).toContain('unavailable.no_verdict = InterlockNoVerdict::kIncomplete;');
    expect(body).toContain('catch (...) {');
    // A click or scroll without a point of the window is not looked up at the screen's origin.
    expect(entry).toMatch(
      /kind == "click" \|\| kind == "scroll"\) && !point_known\)\s*return unavailable/u,
    );
    // The same cancellation epoch as the shadow, and the one point mapping of the host.
    expect(body).toContain('cancellation_epoch.load(std::memory_order_acquire) == expected_epoch');
    expect(body).toContain('WindowsActionPoint(session.observation_bounds, metadata, &point)');
    // No input API and no write: the caller holds the lane.
    expect(body).not.toMatch(
      /SendInput|mouse_event|keybd_event|SetForegroundWindow|SetFocus|PostMessage|SendMessage|WriteFile/u,
    );
  });

  it('creates the source with the synchronous bounds: 250 ms and its own lookup slot (S5-c-2 PR-1)', () => {
    const body = code(entry);
    expect(body).toMatch(
      /WindowsUiaShadowSource::Create\(\s*window, point, still_valid, WindowsUiaShadowSource::kInterlockUiaTimeoutMs,\s*windows_uia_source_detail::InterlockShellLookupRunning\(\)\)/u,
    );
    // Not the shadow's bound and not the shadow's slot.
    expect(body).not.toContain('kShadowUiaTimeoutMs');
    expect(body).not.toMatch(/[^\w]ShellLookupRunning/u);
  });

  it('runs on a worker thread of its own in the multithreaded apartment, and the lane waits at most 500 ms (S5-c-2 PR-1)', () => {
    const body = code(entry);
    // The worker's apartment is inside the entry; the lane's own thread stays an STA.
    expect(body).toContain('CoInitializeEx(nullptr, COINIT_MULTITHREADED)');
    expect(body).toContain('.detach()');
    // The lane's thread body (ServeMain) initializes its own apartment as an STA, and the entry does not.
    const serveStart = code(host).indexOf('int ServeMain(');
    expect(serveStart).toBeGreaterThan(0);
    const laneThread = code(host).slice(serveStart);
    expect(laneThread).toContain('CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED)');
    expect(outside).toContain('COINIT_APARTMENTTHREADED');
    expect(body).not.toContain('COINIT_APARTMENTTHREADED');
    expect(body).toContain('constexpr std::chrono::milliseconds kInterlockLaneHoldLimit{500};');
    expect(body).toContain('pending->ready.wait_for(lock, kInterlockLaneHoldLimit');
    // The worst case of one wait is stated and checked at compile time.
    expect(body).toMatch(
      /static_assert\(150 \+ sprint_coder::computer_use::WindowsUiaShadowSource::kInterlockUiaTimeoutMs \+ 50 <=\s*500,/u,
    );
    // The estimate is stated for the one-call case only; longer steps are bounded by the wait_for cut-off.
    expect(entry).toContain('ONE UI Automation call');
    expect(entry).toContain('ItemPath');
    expect(entry).toContain("the lane's wait_for cut-off");
    // The worker's apartment is released by a guard declared before the source, also on a throw.
    expect(body.indexOf('struct ComApartment')).toBeGreaterThan(0);
    expect(body.indexOf('struct ComApartment')).toBeLessThan(
      body.indexOf('WindowsUiaShadowSource::Create('),
    );
    // Everything that can throw is prepared before the single-flight slot is taken.
    expect(body.indexOf('std::make_shared<InterlockPending>()')).toBeLessThan(
      body.indexOf('running.exchange(true)'),
    );
    expect(body.indexOf('ReadJsonString(metadata, "targetId", &target_id)')).toBeLessThan(
      body.indexOf('running.exchange(true)'),
    );
    // A wait that ran out is a budget answer, and the worker is told it is abandoned.
    expect(body).toMatch(
      /pending->abandoned\.store\(true, std::memory_order_release\);\s*unavailable\.no_verdict = InterlockNoVerdict::kBudget;/u,
    );
    // An epoch that moved while the worker read is a cancel, whatever it found: asked again AFTER
    // the wait, before the worker's answer is returned.
    const wait = body.indexOf('pending->ready.wait_for(');
    const after = body.indexOf('if (!epoch_unchanged()) {', wait);
    expect(after).toBeGreaterThan(wait);
    expect(body.slice(after, after + 120)).toContain('InterlockNoVerdict::kCanceled');
    expect(body.indexOf('return answer;')).toBeGreaterThan(after);
  });

  it('starts one worker at a time and gives it values only, never the sessions (S5-c-2 PR-1)', () => {
    const body = code(entry);
    expect(body).toContain(
      'static std::atomic<bool> *const running = new std::atomic<bool>(false);',
    );
    // The single-flight flag is taken before anything is copied, and a taken one is a budget answer.
    expect(body).toMatch(
      /if \(running\.exchange\(true\)\) \{\s*unavailable\.no_verdict = InterlockNoVerdict::kBudget;\s*return unavailable;/u,
    );
    // A failed thread start gives the slot back.
    expect(body).toMatch(
      /\} catch \(\.\.\.\) \{\s*running\.store\(false\);\s*return unavailable;/u,
    );
    // The worker's capture list is values (and the shared pending block), never `session`/`sessions`.
    const lambda = /std::thread\(\[([^\]]*)\]/u.exec(body)?.[1] ?? '';
    expect(lambda.length).toBeGreaterThan(20);
    expect(lambda).not.toContain('session');
    expect(lambda).toContain('&running');
    expect(lambda).not.toMatch(/[=]/u);
    expect(body).not.toMatch(/\bsessions\b|ticket_states|response_cache/u);
    // Canceled before the start: no worker and no UI Automation object are made.
    const canceled = body.indexOf('if (!epoch_unchanged()) {');
    expect(canceled).toBeGreaterThan(0);
    expect(body.indexOf('running.exchange(true)')).toBeGreaterThan(canceled);
    expect(body.indexOf('WindowsUiaShadowSource::Create(')).toBeGreaterThan(canceled);
  });

  it('does not schedule the shadow', () => {
    const body = code(entry);
    expect(body).not.toMatch(
      /\.Schedule\(|WindowsEffectShadow|ScheduleWindowsEffectShadow|ProcessShadowLog/u,
    );
  });

  it('leaves the shadow wiring as it was: the scheduler, the ring and the observer only', () => {
    expect(shadow).toContain('WindowsEffectShadow().Schedule(');
    expect(shadow).toContain('LaunchWindowsShadowThread');
    expect(shadow).not.toMatch(/Interlock/u);
    expect(host.match(/ProcessShadowLog\(\)/gu)).toHaveLength(1);
  });

  it('is exercised by the harness, moves no version', () => {
    expect(harness).toContain('#include "computer_use_windows_interlock_capture.h"');
    expect(harness).toContain('CheckWindowsInterlockCapture()');
    expect(harness).toContain('Computer Use native Windows interlock capture: PASS');
    const eligibility = JSON.parse(read('eligibility.json')) as {
      versions: Record<string, number>;
    };
    expect(eligibility.versions).toEqual({
      rulesetVersion: 1,
      classifierVersion: 1,
      lexiconVersion: 1,
    });
  });
});
