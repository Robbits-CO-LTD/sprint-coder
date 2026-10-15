import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Source contracts for the Windows shadow reader (classifier v2, S5-b-2a). The walk itself is run
// by the portable harness against a fake UI Automation tree (computer_use_protocol_fuzz.cc, MSVC and
// clang); the real source is Windows-only. What is tied here is the SHAPE that keeps the shadow
// safe: every platform call is admitted by the gate and settled, the real source only reads, and
// nothing is wired into the host yet (S5-b-2b runs it off the serial lane).

const nativeDirectory = join(__dirname, '../../computer-use-native');
const read = (name: string): string => readFileSync(join(nativeDirectory, name), 'utf8');
const reader = read('computer_use_windows_shadow_reader.h');
const source = read('computer_use_windows_uia_source.h');
const host = read('computer_use_windows_host.cc');
const harness = read('computer_use_protocol_fuzz.cc');
const sharedShadow = read('computer_use_effect_shadow.h');

/** The text between two markers, or a failure: an extraction that finds nothing must not pass. */
function between(text: string, begin: string, end: string): string {
  const start = text.indexOf(begin);
  expect(start, begin).toBeGreaterThanOrEqual(0);
  const stop = text.indexOf(end, start);
  expect(stop, end).toBeGreaterThan(start);
  const body = text.slice(start, stop);
  expect(body.length, begin).toBeGreaterThan(40);
  return body;
}

/** The code of a file without its line comments (a comment may name what the code must not do). */
const code = (text: string): string => text.replace(/\/\/.*$/gmu, '');

/** The source interface's methods that reach the platform (everything but the validity and clock). */
function interfaceMethods(): string[] {
  const body = between(
    reader,
    'class ShadowUiaSource {',
    'namespace windows_shadow_reader_detail {',
  );
  const names = [...body.matchAll(/virtual\s+\S+\s+(\w+)\(/gu)].map((match) => match[1]!);
  return names.filter((name) => name !== 'ActionStillValid' && name !== 'NowNs');
}

describe('Windows shadow reader is portable and decides nothing', () => {
  it('has no platform header, clock, thread, I/O or approval vocabulary', () => {
    const allowedIncludes = new Set([
      '"computer_use_windows_shadow.h"',
      '<cstddef>',
      '<cstdint>',
      '<string>',
      '<string_view>',
      '<vector>',
    ]);
    for (const match of reader.matchAll(/^\s*#\s*include\s+(\S+)/gmu))
      expect(allowedIncludes.has(match[1]!), match[1]).toBe(true);
    expect(code(reader)).not.toMatch(/#\s*if(n?def)?\s+.*(_WIN32|__APPLE__|__linux__|_MSC_VER)/u);
    expect(code(reader)).not.toMatch(
      /windows\.h|UIAutomation|IUIAutomation|CoCreateInstance|NormalizeString|chrono|<thread>|<mutex>|<random>|fstream|getenv|fopen|clock_gettime|QueryPerformanceCounter|HRESULT|HWND/iu,
    );
    expect(code(reader)).not.toMatch(/single_use_approval|SingleUseApproval|ticket|approve/iu);
    // It never writes the shadow ring or classifies: it returns a capture and nothing else.
    expect(code(reader)).not.toMatch(
      /ProcessShadowLog|\.Record\(|WindowsShadowClassify|ClassifyEffect/u,
    );
    // No version is named anywhere here.
    for (const text of [reader, source])
      expect(code(text)).not.toMatch(/kNativePreflightClassifierVersion|classifierVersion/u);
  });

  it('calls the platform only inside the gate: the one place that steps, then calls', () => {
    const gated = between(reader, '// BEGIN gated source calls', '// END gated source calls');
    // Gated() admits the call (cancellation, then the budget) BEFORE it runs it, and a refusal is a
    // stopped read, never a value.
    const gatedBody = between(gated, 'template <class Call>', 'ShadowReadResult Root(');
    expect(gatedBody.indexOf('Step()')).toBeGreaterThanOrEqual(0);
    expect(gatedBody.indexOf('Step()')).toBeLessThan(gatedBody.indexOf('call()'));
    expect(gatedBody).toContain('ShadowReadResult::kStopped');
    // Step() asks the gate with the validity and the clock, in that one place.
    const step = between(gated, 'bool Step()', 'template <class Call>');
    expect(step).toContain('gate_.Step(source_.NowNs(), source_.ActionStillValid())');

    // Outside this section the source is never touched.
    const outside = reader.replace(gated, '');
    expect(code(outside)).not.toMatch(/source_\./u);

    // Inside it, every platform call is a one-line wrapper through Gated, and the set of calls is
    // exactly the interface (a new platform read is a conscious addition, here and in the tests).
    const calls: string[] = [];
    for (const line of gated.split('\n')) {
      if (!/source_\./u.test(line)) continue;
      if (/gate_\.Step\(source_\.NowNs\(\), source_\.ActionStillValid\(\)\)/u.test(line)) continue;
      const match = /^\s*return Gated\(\[&\] \{ return source_\.(\w+)\([^;]*\); \}\);$/u.exec(line);
      expect(match, line).not.toBeNull();
      calls.push(match![1]!);
    }
    expect([...new Set(calls)].sort()).toEqual([...new Set(interfaceMethods())].sort());
    expect(interfaceMethods().length).toBeGreaterThanOrEqual(13);
  });

  it('settles every read into a flag, and never uses a read result as a value', () => {
    const gated = between(reader, '// BEGIN gated source calls', '// END gated source calls');
    const outside = reader
      .replace(gated, '')
      .replace(
        between(reader, 'class ShadowUiaSource {', 'namespace windows_shadow_reader_detail {'),
        '',
      );
    // Each platform wrapper is used through ShadowSettle, except the two sibling walks, whose result
    // is kept in `step` and read for every case afterwards.
    const settled = [
      'Root',
      'AtPoint',
      'Focused',
      'Parent',
      'Same',
      'Text',
      'IsPassword',
      'DocumentUrl',
      'WindowProcessPath',
      'CoreWindowProcessPath',
      'ItemPath',
    ];
    for (const name of settled) {
      const uses = [...outside.matchAll(new RegExp(`(?<![\\w.])${name}\\(`, 'gu'))];
      expect(uses.length, name).toBeGreaterThan(0);
      for (const use of uses) {
        const before = outside.slice(Math.max(0, use.index! - 40), use.index!);
        // Declarations of the wrappers are inside the gated section (removed above); the
        // `ReadNode` lambda wraps Text in ShadowSettle too.
        expect(/ShadowSettle\($/u.test(before), `${name}: ${before}`).toBe(true);
      }
    }
    for (const name of ['FirstChild', 'NextSibling']) {
      const uses = [...outside.matchAll(new RegExp(`(?<![\\w.])${name}\\(`, 'gu'))];
      expect(uses.length, name).toBeGreaterThan(0);
      for (const use of uses) {
        const before = outside.slice(Math.max(0, use.index! - 40), use.index!);
        expect(/(ShadowReadResult step = |step = )$/u.test(before), `${name}: ${before}`).toBe(
          true,
        );
      }
    }
    // A step that did not end by running out of siblings makes the list incomplete.
    expect(reader).toContain('ran_out_of_siblings && step != ShadowReadResult::kAbsent');
    expect(reader).toContain('if (locate_failed) capture.read_failed = true;');
  });

  it('bounds the search like v1, never normalizes an id it searches by, and reads a URL only in a web window', () => {
    const search = between(reader, 'void Search(', 'void CaptureChain(');
    expect(search).toContain('kSearchMaxDepth');
    expect(search).toContain('kSearchStringBytes');
    // Identifiers used to FIND the target are read as they are.
    expect(search).toMatch(/ShadowUiaText::kAutomationId, false, kSearchStringBytes/u);
    expect(search).toMatch(/ShadowUiaText::kName, false, kSearchStringBytes/u);
    // Labels the core reads are normalized and bounded by the core's own limit.
    const node = between(reader, 'ShadowUiaNode ReadNode(', 'void Search(');
    expect(node).toContain('Text(element, what, true, kEffectMaxLabelBytes, output)');
    // The Document value is the page address in a browser and the text of the document in an editor.
    const chain = between(reader, 'void CaptureChain(', 'void CaptureNeighbors(');
    expect(chain).toContain('IsWebWindowClass(*capture)');
    expect(chain).toMatch(/web_window && !capture->document_url_read/u);
    // The window is read before the chain, so that rule has its answer.
    const capture = between(reader, 'ShadowUiaCapture Capture(', 'private:');
    expect(capture.indexOf('CaptureWindow(')).toBeLessThan(capture.indexOf('CaptureChain('));
  });

  it('is built and run by the harness on both compilers', () => {
    expect(harness).toContain('#include "computer_use_windows_shadow_reader.h"');
    expect(harness).toContain('CheckWindowsShadowReader()');
    expect(harness).toContain('Computer Use native Windows shadow reader: PASS');
    // The reader has the gate's stop state to ask.
    expect(sharedShadow).toMatch(/bool Stopped\(\) const \{ return stopped_; \}/u);
    // The fake counts calls against the gate: "every call was admitted" is a number.
    expect(harness).toContain('winreader-every-call-is-gated');
    expect(harness).toContain('winreader-cancel-stops-every-call');
    expect(harness).toContain('winreader-call-budget-bounds-the-search');
  });
});

describe('Windows UI Automation source only reads', () => {
  it('uses a closed set of UI Automation methods and Win32 calls, none of which acts', () => {
    const methods = new Set(
      [...source.matchAll(/(?:->|\.Get\(\)->)(\w+)\(/gu)].map((match) => match[1]!),
    );
    const allowedMethods = new Set([
      'ElementFromHandle',
      'ElementFromPoint',
      'GetFocusedElement',
      'GetParentElement',
      'GetFirstChildElement',
      'GetNextSiblingElement',
      'CompareElements',
      'get_CurrentControlType',
      'get_CurrentClassName',
      'get_CurrentName',
      'get_CurrentAutomationId',
      'get_CurrentHelpText',
      'get_CurrentIsPassword',
      'get_CurrentProcessId',
      'get_CurrentNativeWindowHandle',
      // the shell: windows and views are asked for (read-only), never navigated or invoked
      'get_Count',
      'Item',
      'get_HWND',
      'QueryService',
      'QueryActiveShellView',
      'GetFolder',
      'ItemCount',
      'GetDisplayName',
      'GetAttributes',
      'GetCurrentPatternAs',
      'get_CurrentValue',
      'CreatePropertyCondition',
      'FindFirst',
      'get_RawViewWalker',
      'QueryInterface',
      'put_ConnectionTimeout',
      'put_TransactionTimeout',
      'Release',
      'AddRef',
    ]);
    for (const name of methods) expect(allowedMethods.has(name), name).toBe(true);
    // The value of a pattern is read in exactly one place, and nothing is set, invoked or moved.
    expect(source.match(/get_CurrentValue/gu)?.length).toBe(1);
    expect(code(source)).not.toMatch(
      /SetValue|Invoke\(|->Select|Toggle|Expand|Collapse|SetFocus|ScrollIntoView|->Move|Resize|->Close|SendInput|SendMessage|PostMessage|keybd_event|mouse_event|SetCursorPos|SetForegroundWindow|SetWindowPos|ShellExecute|CreateProcess|WriteProcessMemory|OpenClipboard|RegisterHotKey/u,
    );
    // The only Win32 calls: strings, the process that owns a window, and COM creation.
    const win32 = new Set(
      [
        ...source.matchAll(
          /(?<![\w.>:])(CoCreateInstance|NormalizeString|WideCharToMultiByte|MultiByteToWideChar|GetLastError|Sys\w+|Variant\w+|OpenProcess|QueryFullProcessImageNameW|CloseHandle|GetWindowThreadProcessId|FindWindow\w*|EnumWindows|GetForegroundWindow|SHCreateItemWithParent|ILFree|CoTaskMemFree|SH\w+|Shell\w+)\(/gu,
        ),
      ].map((match) => match[1]!),
    );
    const allowedWin32 = new Set([
      'CoCreateInstance',
      'NormalizeString',
      'WideCharToMultiByte',
      'GetLastError',
      'SysFreeString',
      'SysStringLen',
      'SysAllocString',
      'VariantInit',
      'VariantClear',
      'OpenProcess',
      'QueryFullProcessImageNameW',
      'CloseHandle',
      'SHCreateItemWithParent',
      'ILFree',
      'CoTaskMemFree',
      // the shell lookup of the item path (a function of this file, not a Win32 call)
      'ShellItemPathByName',
    ]);
    for (const name of win32) expect(allowedWin32.has(name), name).toBe(true);
    // The process is opened with the least right that answers.
    expect(source).toContain('PROCESS_QUERY_LIMITED_INFORMATION');
    expect(source).not.toMatch(
      /PROCESS_ALL_ACCESS|PROCESS_VM_|PROCESS_TERMINATE|PROCESS_CREATE_THREAD/u,
    );
  });

  it('turns text into NFKC UTF-8 judged in bytes, and never into an empty answer', () => {
    const text = between(source, 'ShadowTextFromUtf16(', 'ControlTypeName(');
    expect(text).toContain('NormalizationKC');
    // Both the size query and the conversion refuse a lone surrogate.
    expect(text.match(/WC_ERR_INVALID_CHARS/gu)?.length).toBe(2);
    expect(text).toContain('ShadowCheckText(utf8, maximum_bytes, output)');
    // The UTF-16 length is only a cheap cut, checked again after the NFKC (which can lengthen).
    expect((text.match(/ShadowUnitsTooLong\(/gu) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(text).toContain('maximum_bytes) return ShadowReadResult::kTooLong');
    expect(text).not.toMatch(/substr|\.resize\(maximum|erase\(|truncate/u);
    expect(text).toContain('if (text.empty()) return ShadowReadResult::kAbsent;');
    expect(source).toContain('#pragma comment(lib, "normaliz.lib")');
    // An error of the platform is a failed read; "no element / no value" is absent.
    expect(source).toMatch(
      /if \(FAILED\(result\)\) return ShadowReadResult::kFailed;\s*\n\s*if \(element\.Get\(\) == nullptr\) return ShadowReadResult::kAbsent;/u,
    );
    // Every string property goes through that one function.
    for (const property of [
      'get_CurrentClassName',
      'get_CurrentName',
      'get_CurrentAutomationId',
      'get_CurrentHelpText',
    ])
      expect(source).toContain(property);
    expect((source.match(/ShadowTextFromUtf16\(/gu) ?? []).length).toBeGreaterThanOrEqual(5);
  });

  it('looks the item path up read-only, bounded, and only when the name is unique', () => {
    const lookup = between(source, 'ShellItemPathByName(HWND tab', 'ComRef<IShellView> view;');
    expect(lookup.length).toBeGreaterThan(50);
    const body = between(
      source,
      'ShellItemPathByName(HWND tab',
      '} // namespace windows_uia_source_detail',
    );
    // Windows and views are asked for; nothing is navigated, selected, invoked, renamed or changed.
    expect(code(body)).not.toMatch(
      /navigate|SelectItem|SelectAndPositionItems|InvokeCommand|InvokeVerb|DoVerb|Execute|Refresh|Rename|Delete|SetCurrent|SetViewModeAndIconSize|ShellExecute|SetFocus/iu,
    );
    // Its own limits, because it is one gated call: the action, a deadline, and a cap on the items.
    expect(source).toContain('constexpr int kShellLookupMaxItems = 512;');
    expect(source).toContain("constexpr std::uint64_t kShellLookupBudgetNs = 60'000'000;");
    // Both the walk over the shell windows and the walk over the items stop on a cancel.
    expect(
      body.match(/if \(!limits\.still_valid\(\)\) return ShadowReadResult::kStopped;/gu)?.length,
    ).toBe(2);
    expect(body).toContain(
      'if (limits.now_ns() > limits.deadline_ns) return ShadowReadResult::kAbsent;',
    );
    expect(body).toContain('items > kShellLookupMaxItems) return ShadowReadResult::kAbsent;');
    // Two items with the same display name are not known; so is an item without a file-system path.
    expect(body).toContain('if (matched.Get() != nullptr) return ShadowReadResult::kAbsent;');
    expect(body).toContain('SIGDN_FILESYSPATH');
    expect(body).toContain('SFGAO_STREAM');
    // The path is a string like any other: UTF-8, bound in bytes, never emptied.
    const item = between(source, 'ShadowReadResult ItemPath(', 'private:');
    expect(item).toContain('ShadowTextFromUtf16(answer.path, false, maximum_bytes, path)');
    expect(item).toContain('ShellItemPathByName(');
    expect((code(source).match(/ShellItemPathByName\(/gu) ?? []).length).toBe(2);
  });

  it('is included by the host, and the reader is reached only through the scheduler (S5-b-2b)', () => {
    expect(host).toContain('#include "computer_use_windows_uia_source.h"');
    // The host names neither the reader, the classifier nor the gate: the scheduler owns them.
    for (const name of [
      'WindowsShadowReader',
      'WindowsShadowClassify',
      'BuildWindowsShadowFacts',
      'ShadowGate',
    ])
      expect(code(host), name).not.toContain(name);
    // The version stays where the V1 preflight puts it, and the win32 v2 refusal is untouched.
    expect(host).toContain('kNativePreflightClassifierVersion');
    expect(host).not.toMatch(
      /computer_use_windows_shadow_reader\.h|computer_use_windows_shadow\.h/u,
    );
  });
});
