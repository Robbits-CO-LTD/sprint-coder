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
      // The admission of a call (Step) and the admission of the end of the capture (Finish) ask the
      // gate with the clock and the validity; they read nothing of the target.
      if (/gate_\.(Step|Finish)\(source_\.NowNs\(\), source_\.ActionStillValid\(\)\)/u.test(line))
        continue;
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
          /(?<![\w.>:])(CoCreateInstance|NormalizeString|WideCharToMultiByte|MultiByteToWideChar|GetLastError|Sys\w+|Variant\w+|OpenProcess|QueryFullProcessImageNameW|CloseHandle|GetWindowThreadProcessId|FindWindow\w*|EnumWindows|GetForegroundWindow|SHCreateItemWithParent|ILFree|CoTaskMemFree|GetAncestor|FindFirstFileExW|FindNextFileW|FindClose|CompareStringOrdinal|GetDriveTypeW|GetFileAttributesW|CancelSynchronousIo|DuplicateHandle|SH\w+|Shell\w+)\(/gu,
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
      'GetAncestor',
      // the folder's path and a listing of its entries in this process (read-only)
      'SHGetIDListFromObject',
      'SHGetPathFromIDListEx',
      'SHGetKnownFolderPath',
      'SHCreateItemFromIDList',
      'SHCreateItemFromParsingName',
      'FindFirstFileExW',
      'FindNextFileW',
      'FindClose',
      'CompareStringOrdinal',
      'GetDriveTypeW',
      'GetFileAttributesW',
      'CancelSynchronousIo',
      'DuplicateHandle',
      // the shell lookup of the item path (functions of this file, not Win32 calls)
      'ShellItemPathByName',
      'ShellLookupPending',
      'ShellNameEqualsOrdinal',
      'ShellDisplayNameUsable',
      'MatchShellDisplayName',
      'ShellFolderMayBeListed',
      'ShellLookupMustStop',
      'ShellPathHasLink',
      'ShellEntryNeedsShellName',
      'ShellDesktopIniLocalizesFileNames',
      'ShellResolvedNameIsTheCandidate',
      'ShellLeafName',
      'ShellFolderHasLocalizedFileNames',
      'ShellPathWithoutTrailingSeparator',
      'ShellLookupRunning',
      'InterlockShellLookupRunning',
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

  it('calls a closed set of free functions: every capitalized call is listed, none of them acts on a window', () => {
    const calls = new Set(
      [...code(source).matchAll(/(?<![\w.>])([A-Z]\w*)\(/gu)].map((match) => match[1]!),
    );
    // Win32 / COM / macros the source may use.
    const platform = [
      'CloseHandle',
      'CoCreateInstance',
      'CoInitializeEx',
      'CoTaskMemFree',
      'CoUninitialize',
      'FAILED',
      'GetAncestor',
      'GetLastError',
      'IID_PPV_ARGS',
      'ILFree',
      'CompareStringOrdinal',
      'FindClose',
      'FindFirstFileExW',
      'FindNextFileW',
      'SHGetIDListFromObject',
      'SHGetPathFromIDListEx',
      'SHGetKnownFolderPath',
      'SHCreateItemFromIDList',
      'SHCreateItemFromParsingName',
      'GetDriveTypeW',
      'GetFileAttributesW',
      'CancelSynchronousIo',
      'DuplicateHandle',
      'GetCurrentProcess',
      'GetCurrentThread',
      'GetPrivateProfileSectionW',
      'GetVolumePathNameW',
      'SetLastError',
      'ILIsEmpty',
      'NormalizeString',
      'OpenProcess',
      'QueryFullProcessImageNameW',
      'SHCreateItemWithParent',
      'SUCCEEDED',
      'SysAllocString',
      'SysFreeString',
      'SysStringLen',
      'VariantClear',
      'VariantInit',
      'WideCharToMultiByte',
    ];
    // The shared shadow helpers and this file's own functions and methods.
    const own = [
      'ActionStillValid',
      'At',
      'AtPoint',
      'BstrHolder',
      'ComRef',
      'ControlTypeName',
      'CoreWindowProcessPath',
      'Create',
      'DocumentUrl',
      'FindHandle',
      'FirstChild',
      'Focused',
      'Get',
      'IsPassword',
      'ItemPath',
      'Keep',
      'NextSibling',
      'NowNs',
      'Parent',
      'ProcessPathOf',
      'Receive',
      'Reset',
      'Root',
      'Same',
      'ShadowCheckText',
      'ShadowTextFromUtf16',
      'ShadowUnitsTooLong',
      'ShellItemPathByName',
      'ShellNameEqualsOrdinal',
      'ShellDisplayNameUsable',
      'MatchShellDisplayName',
      'ShellFolderMayBeListed',
      'ShellLookupMustStop',
      'ShellPathHasLink',
      'ShellEntryNeedsShellName',
      'ShellDesktopIniLocalizesFileNames',
      'ShellResolvedNameIsTheCandidate',
      'ShellLeafName',
      'ShellFolderHasLocalizedFileNames',
      'ShellPathWithoutTrailingSeparator',
      'AbsoluteIdList',
      'ComApartment',
      'Finish',
      'ShellLookupPending',
      'ShellLookupRunning',
      'InterlockShellLookupRunning',
      'Text',
      'View',
      'Widen',
      'WindowProcessPath',
      'WindowsUiaShadowSource',
    ];
    const allowed = new Set([...platform, ...own]);
    for (const name of calls) expect(allowed.has(name), name).toBe(true);
    // What the source actually calls from outside itself acts on no window, focus, input or process:
    // checked on the extracted calls (including ::Name forms), not on the list above.
    for (const name of calls) {
      if (own.includes(name)) continue;
      expect(name).not.toMatch(
        /^(Show|Bring|SetActive|SetForeground|SetFocus|SetWindow|SetCursor|Send|Post|Attach|SwitchTo|SystemParameters|Terminate|CreateProcess|Shell)/u,
      );
    }
    expect(code(source)).not.toMatch(
      /\b(ShowWindow|BringWindowToTop|SetActiveWindow|AttachThreadInput|PostThreadMessage\w*|SwitchToThisWindow|SetForegroundWindow|SendInput)\s*\(/u,
    );
  });

  it('creates UI Automation with its call timeouts as a precondition', () => {
    const create = between(
      source,
      'static std::unique_ptr<WindowsUiaShadowSource> Create(',
      'WindowsUiaShadowSource(const',
    );
    // CUIAutomation8 is the only coclass with IUIAutomation2 (ConnectionTimeout / TransactionTimeout);
    // with the original CUIAutomation a call to a hung app never returns (measured).
    expect(create).toContain('CLSID_CUIAutomation8');
    expect(code(create)).not.toMatch(/CLSID_CUIAutomation\b(?!8)/u);
    expect(create).toContain('ComRef<IUIAutomation2> bounded;');
    expect(create).toContain('put_ConnectionTimeout(timeout_ms)');
    expect(create).toContain('put_TransactionTimeout(timeout_ms)');
    expect(code(source)).not.toContain('IUIAutomation6');
    // Failing to set either is "no source" (the capture is skipped), never a call without a bound.
    expect(create).toMatch(
      /FAILED\(bounded\.Get\(\)->put_ConnectionTimeout\(timeout_ms\)\) \|\|\s*FAILED\(bounded\.Get\(\)->put_TransactionTimeout\(timeout_ms\)\)\)\s*return nullptr;/u,
    );
    expect(create.indexOf('put_TransactionTimeout')).toBeLessThan(
      create.indexOf('get_RawViewWalker'),
    );
    // The bound is the caller's (S5-c-2 PR-1): the shadow is asynchronous and waits up to 1500 ms, the
    // synchronous entry holds the serial lane and waits up to 250 ms. No bound is left in the class.
    expect(source).toMatch(/kShadowUiaTimeoutMs = 1500;/u);
    expect(source).toMatch(/kInterlockUiaTimeoutMs = 250;/u);
    expect(code(source)).not.toContain('kTimeoutMilliseconds');
    expect(create).toMatch(/DWORD timeout_ms,\s*std::atomic<bool> &lookup_slot\)/u);
  });

  it('uses the lookup slot it is given, one slot for the shadow and one for the synchronous entry', () => {
    const item = between(source, 'ShadowReadResult ItemPath(', 'private:');
    expect(item).toContain('std::atomic<bool> &running = lookup_slot_;');
    expect(code(item)).not.toContain('ShellLookupRunning');
    // Two slots, each a static that is never destroyed: at most one stuck lookup per slot.
    expect(source).toMatch(
      /std::atomic<bool> &ShellLookupRunning\(\) \{\s*static std::atomic<bool> \*const running = new std::atomic<bool>\(false\);/u,
    );
    expect(source).toMatch(
      /std::atomic<bool> &InterlockShellLookupRunning\(\) \{\s*static std::atomic<bool> \*const running = new std::atomic<bool>\(false\);/u,
    );
  });

  it('asks the shell only about a tab of the bound window', () => {
    const item = between(source, 'ShadowReadResult ItemPath(', 'private:');
    expect(item).toContain(
      'GetAncestor(tab, GA_ROOT) != window_) return ShadowReadResult::kAbsent;',
    );
    expect(item.indexOf('GetAncestor(tab, GA_ROOT)')).toBeLessThan(
      item.indexOf('ShellItemPathByName('),
    );
    // and the reader asks only for an item it could trace back to the bound window.
    const reader_item = between(reader, 'void CaptureItem(', 'ShadowUiaSource &source_;');
    expect(reader_item).toContain('capture->chain_reached_root &&');
  });

  it('walks nothing of its own for the shell tab, and closes a capture with a final admission', () => {
    // The tab is an element of the walk the reader already paid for (gated); the source reads only its
    // window handle. No parent walk (and no class-name reads) hides in ItemPath.
    const item = between(source, 'ShadowReadResult ItemPath(', 'private:');
    expect(code(item)).not.toMatch(/GetParentElement|get_CurrentClassName|FindFirst|FindAll/u);
    expect(item).toContain('get_CurrentNativeWindowHandle(&native)');
    expect(reader).toContain('Element tab = ShadowUiaSource::kNoElement;');
    expect(reader).toContain('"shelltabwindowclass"');
    // The last gated call succeeding is not enough: after it the gate is asked once more (a deadline
    // passed during that call, or a cancel after it, makes the capture late or canceled), and that
    // admission spends no call.
    const capture = between(reader, 'ShadowUiaCapture Capture(', 'private:');
    expect(capture.indexOf('Finish();')).toBeGreaterThan(capture.indexOf('CaptureItem('));
    expect(capture.indexOf('Finish();')).toBeLessThan(
      capture.indexOf('capture.budget_exhausted ='),
    );
    const finish = between(
      sharedShadow,
      'bool Finish(std::uint64_t now_ns',
      'bool Canceled() const',
    );
    expect(finish).toContain('PastDeadline(now_ns)');
    expect(finish).not.toContain('Spend(');
    expect(harness).toContain('winreader-late-last-call-is-over-budget');
    expect(harness).toContain('winreader-cancel-after-the-last-call-is-canceled');
  });

  it('does not guess at an item it could not read, and does not wait on Explorer for ever', () => {
    const body = between(
      source,
      'ShellItemPathByName(HWND tab',
      '} // namespace windows_uia_source_detail',
    );
    const compact = body.replace(/\s+/gu, ' ');
    // The folder is listed in THIS process: no walk over the view's items (IFolderView2::Item /
    // ItemCount) and no per-item shell object are left.
    expect(code(body)).not.toMatch(
      /ItemCount|folder_view\.Get\(\)->Item\(|SHCreateItemWithParent|kShellLookupMaxItems/u,
    );
    const listing = between(body, 'FindFirstFileExW(', 'MatchShellDisplayName(');
    expect(listing).toContain('FindExInfoBasic');
    expect(listing).toContain('FindExSearchNameMatch');
    expect(listing).toContain('FIND_FIRST_EX_LARGE_FETCH');
    // A failed read of the listing is a failed lookup (the uniqueness is unknown), never a skipped entry.
    expect(listing).toContain('return ShadowReadResult::kFailed;');
    // The whole folder is listed once (the display name does not narrow the listing).
    expect(code(body)).not.toContain('pattern.append(display_name)');
    expect(body).toContain("pattern.push_back(L'*');");
    // The folder's path is asked for once; a folder with no path of the file system is not known.
    expect((code(body).match(/SHGetPathFromIDListEx\(/gu) ?? []).length).toBe(1);
    expect(body).toMatch(/if \(!has_path\) return ShadowReadResult::kAbsent;/u);
    // No rule about extensions: the SHELL is asked, for every candidate, for the name it shows.
    expect(code(body)).not.toMatch(/SHGetSetSettings|SSF_SHOWEXTENSIONS|extensions_shown/u);
    const names = between(
      body,
      'for (ShellNameCandidate &candidate : candidates) {',
      'MatchShellDisplayName(',
    );
    expect(names).toContain('SHCreateItemFromParsingName(');
    expect(names).toContain('GetDisplayName(SIGDN_FILESYSPATH, &resolved)');
    expect(names).toContain('GetDisplayName(SIGDN_NORMALDISPLAY, &shown)');
    expect(body).toContain(
      'MatchShellDisplayName(display_name, candidates, ShellNameEqualsOrdinal)',
    );
    // A name is known ONLY when the path resolved, resolved to the candidate itself (not to the entry
    // Win32 normalizes a trailing dot or space to), and the shell gave its name: one assignment, in
    // that branch and nowhere else.
    expect((code(source).match(/shell_name_known = true/gu) ?? []).length).toBe(1);
    expect(code(names).replace(/\s+/gu, ' ')).toMatch(
      /if \(SUCCEEDED\(SHCreateItemFromParsingName\([^{}]*ShellResolvedNameIsTheCandidate\(candidate\.name, ShellLeafName\(resolved\), ShellNameEqualsOrdinal\) && SUCCEEDED\(item\.Get\(\)->GetDisplayName\(SIGDN_NORMALDISPLAY, &shown\)\) && shown != nullptr\) \{ candidate\.shell_name = shown; candidate\.shell_name_known = true; \}/u,
    );
    // Where it may look is decided BEFORE the first listing (and its file system call): the root of the
    // desktop namespace (an empty id list), a slow folder, and then a plain local directory only.
    const find = body.indexOf('FindFirstFileExW(');
    for (const guard of [
      'ILIsEmpty(folder_id.id)',
      'SFGAO_ISSLOW',
      'ShellFolderMayBeListed(folder_path)',
    ]) {
      expect(body.indexOf(guard), guard).toBeGreaterThanOrEqual(0);
      expect(body.indexOf(guard), guard).toBeLessThan(find);
    }
    // A slow folder is refused on the shell's own attribute, before any listing.
    expect(body).toContain('(folder_attributes & SFGAO_ISSLOW) != 0)');
    expect(body).toContain(
      'FAILED(folder_item.Get()->GetAttributes(SFGAO_ISSLOW, &folder_attributes))',
    );
    // The place check comes before the desktop.ini check, and both before the listing; the caller turns
    // either answer into "not known".
    expect(body.indexOf('ShellFolderMayBeListed(folder_path)')).toBeLessThan(
      body.indexOf('ShellFolderHasLocalizedFileNames(folder_path)'),
    );
    expect(body.indexOf('ShellFolderHasLocalizedFileNames(folder_path)')).toBeLessThan(find);
    expect(compact).toContain(
      'if (!ShellFolderMayBeListed(folder_path)) return ShadowReadResult::kAbsent;',
    );
    expect(compact).toContain(
      'if (ShellFolderHasLocalizedFileNames(folder_path)) return ShadowReadResult::kAbsent;',
    );
    // NO new I/O after the caller gave up or the deadline passed: asked before the place check, the
    // desktop.ini, the first listing and each candidate's shell name.
    for (const step of [
      'if (!ShellFolderMayBeListed(folder_path))',
      'if (ShellFolderHasLocalizedFileNames(folder_path))',
      'find.handle = FindFirstFileExW(',
      'SHCreateItemFromParsingName(',
    ]) {
      const at = compact.indexOf(step);
      expect(at, step).toBeGreaterThan(0);
      expect(compact.slice(Math.max(0, at - 170), at), step).toMatch(
        /if \(ShellLookupMustStop\(limits, &stopped\)\) return stopped;(?: ComRef<IShellItem> item; PWSTR shown = nullptr; PWSTR resolved = nullptr;)? ?(?:if \(SUCCEEDED\()?$/u,
      );
    }
    const stop = between(
      source,
      'ShellLookupMustStop(const ShellLookupLimits',
      'Whether any part of',
    );
    expect(stop).toContain('if (!limits.still_valid())');
    expect(stop).toContain('limits.now_ns() > limits.deadline_ns');
    // Which entries need the shell's name is the pure rule of the matcher, fed the attributes.
    expect(compact).toContain('ShellEntryNeedsShellName(found, is_directory,');
    expect(compact).toContain('(FILE_ATTRIBUTE_READONLY | FILE_ATTRIBUTE_SYSTEM)');
    expect(code(body)).not.toMatch(
      /starts_with_display|renamable_directory|FILE_ATTRIBUTE_HIDDEN/u,
    );
    // The place check: the volume of the path (not its first three characters), no link on the way,
    // the desktop folders asked without verifying, and the drive types, all in one fixed expression.
    const guardFunction = between(
      source,
      'ShellFolderMayBeListed(const std::wstring &path) {',
      'ShellFolderHasLocalizedFileNames(const std::wstring &path) {',
    );
    const guardCompact = guardFunction.replace(/\s+/gu, ' ');
    expect(guardFunction.includes("path[0] == L'" + '\\\\' + "'")).toBe(true);
    expect(guardCompact).toContain(
      'if (drive == DRIVE_REMOTE || drive == DRIVE_CDROM || drive == DRIVE_UNKNOWN || drive == DRIVE_NO_ROOT_DIR) return false;',
    );
    expect(guardCompact).toContain('if (same) return false;');
    expect(guardCompact).toContain('FOLDERID_Desktop, FOLDERID_PublicDesktop');
    expect(guardCompact).toContain(
      'SHGetKnownFolderPath(known, KF_FLAG_DONT_VERIFY, nullptr, &folder)',
    );
    expect(guardCompact).toContain('GetVolumePathNameW(path.c_str(), root.data()');
    expect(guardCompact).toContain('GetDriveTypeW(root.c_str())');
    expect(guardCompact).toContain('return !ShellPathHasLink(root, path);');
    expect(guardFunction).not.toContain('substr(0, 3)');
    const link = between(
      source,
      'ShellPathHasLink(const std::wstring &root',
      'ShellFolderMayBeListed(',
    );
    expect(link).toContain('IO_REPARSE_TAG_SYMLINK');
    expect(link).toContain('IO_REPARSE_TAG_MOUNT_POINT');
    expect(link).toContain('FILE_ATTRIBUTE_REPARSE_POINT');
    expect(link).toContain('if (find.handle == INVALID_HANDLE_VALUE) return true;');
    // A desktop.ini is normal (a user's home has one): only its [LocalizedFileNames] section counts, it
    // is read with the profile API, never opened, and the pure rule turns the answers into a verdict.
    const localized = between(
      source,
      'ShellFolderHasLocalizedFileNames(const std::wstring &path) {',
      'The path of the item a file browser shows',
    );
    expect(localized).toContain('GetPrivateProfileSectionW(L"LocalizedFileNames"');
    expect(localized).toContain('desktop.ini');
    expect(localized).toContain(
      'return ShellDesktopIniLocalizesFileNames(found, lookup_error, length, section_error);',
    );
    expect(code(localized)).not.toMatch(/CreateFile|ReadFile|ifstream|fopen/u);
    // The guards decide before any listing of ours.
    expect(guardFunction).not.toContain('FindFirstFileExW(part');
    // A folder is a directory of the file system.
    expect(body).toContain('FILE_ATTRIBUTE_DIRECTORY');
    // Explorer's calls have no timeout: the lookup runs on its own thread, the caller waits a bounded
    // time, an unanswered lookup is abandoned, and no second one starts while one is stuck.
    const item = between(source, 'ShadowReadResult ItemPath(', 'private:');
    expect(item).toContain('running.exchange(true)) return ShadowReadResult::kAbsent;');
    expect(item).toContain('}).detach();');
    expect(item).toContain('wait_for(lock, windows_uia_source_detail::kShellLookupWait');
    // A caller that gives up cancels the file system call the lookup's thread may be blocked in.
    expect(item).toContain('pending->abandoned.store(true, std::memory_order_release);');
    expect(item).toContain('CancelSynchronousIo(pending->thread)');
    expect(item).toContain('DuplicateHandle(GetCurrentProcess(), GetCurrentThread()');
    expect(item).toMatch(/return !pending->abandoned\.load\(std::memory_order_acquire\)/u);
    expect(item.indexOf('running.exchange(true)')).toBeLessThan(item.indexOf('std::thread('));
    // Nothing of this object is used on that thread (it may outlive the object).
    const thread = between(item, 'std::thread([', '}).detach();');
    expect(thread).not.toMatch(/\bthis\b|window_|still_valid_|walker_|automation_/u);
    expect(thread).toContain('CoInitializeEx(nullptr, COINIT_MULTITHREADED)');
    // No exception ends the process: the lookup is wrapped, and the slot and the waiting caller are
    // released by a guard that runs whatever happened.
    expect(thread).toMatch(
      /try \{[\s\S]*ShellItemPathByName\([\s\S]*\} catch \(\.\.\.\) \{\s*\/\/[^\n]*\n\s*result = ShadowReadResult::kFailed;/u,
    );
    expect(thread).toContain('struct ComApartment');
    expect(thread.indexOf('struct ComApartment')).toBeLessThan(
      thread.indexOf('ShellItemPathByName('),
    );
    expect(thread).toMatch(
      /struct Finish \{[\s\S]*~Finish\(\) \{\s*running\.store\(false\);\s*pending->ready\.notify_one\(\);/u,
    );
    expect(thread.indexOf('} catch (...)')).toBeLessThan(thread.indexOf('struct Finish'));
    expect(source).toContain(
      'static std::atomic<bool> *const running = new std::atomic<bool>(false);',
    );
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
    expect(code(body).replaceAll('= delete', '')).not.toMatch(
      /navigate|SelectItem|SelectAndPositionItems|InvokeCommand|InvokeVerb|DoVerb|Execute|Refresh|Rename|Delete|SetCurrent|SetViewModeAndIconSize|ShellExecute|SetFocus/iu,
    );
    // Its own limits, because it is one gated call: the action, a deadline, and a cap on the candidates.
    expect(source).not.toContain('kShellLookupMaxItems');
    expect(source).toContain('#include "computer_use_windows_shell_name_match.h"');
    expect(source).toContain('kShellMaxCandidates');
    expect(source).toContain("constexpr std::uint64_t kShellLookupBudgetNs = 60'000'000;");
    // Both the walk over the shell windows and the listing of the entries stop on a cancel.
    expect(
      body.match(/if \(!limits\.still_valid\(\)\) return ShadowReadResult::kStopped;/gu)?.length,
    ).toBe(2);
    expect(body).toContain(
      'if (limits.now_ns() > limits.deadline_ns) return ShadowReadResult::kAbsent;',
    );
    // More candidates than the cap are not known; so are two entries a name can stand for (the matcher).
    expect(body).toContain(
      'if (candidates.size() >= kShellMaxCandidates) return ShadowReadResult::kAbsent;',
    );
    expect(body).toContain('if (index == kNoShellMatch) return ShadowReadResult::kAbsent;');
    // The path is a string like any other: UTF-8, bound in bytes, never emptied.
    const item = between(source, 'ShadowReadResult ItemPath(', 'private:');
    expect(item).toContain('ShadowTextFromUtf16(answer.path, false, maximum_bytes, path)');
    expect(item).toContain('ShellItemPathByName(');
    expect((code(source).match(/ShellItemPathByName\(/gu) ?? []).length).toBe(2);
  });

  it('asks the shell only about a ListItem of the shell item view (S5-c-2 PR-3)', () => {
    const capture = between(
      reader,
      'void CaptureItem(ShadowUiaCapture *capture) {',
      'ShadowUiaSource &source_;',
    );
    const compact = capture.replace(/\s+/gu, ' ');
    expect(compact).toContain('class_name == "shelldll_defview" || class_name == "uiitemsview"');
    expect(compact).toContain('capture->chain_reached_root && in_item_view &&');
    // The scan for the view stops at the tab, like the scan for the tab itself.
    expect(compact).toMatch(
      /if \(class_name == "shelltabwindowclass"\) \{ tab = chain_elements_\[at\]; break; \}/u,
    );
    expect(harness).toContain('winreader-list-item-outside-the-item-view-is-not-asked');
    expect(harness).toContain('winreader-list-item-in-a-defview-is-asked');
    expect(harness).toContain('winreader-list-item-in-the-item-view-is-asked');
  });

  it('matches a display name to the real entry in a portable header the harness runs (S5-c-2 PR-3)', () => {
    const matcher = read('computer_use_windows_shell_name_match.h');
    // Pure: no platform header, no clock, no I/O, no thread.
    expect(code(matcher)).not.toMatch(
      /#include\s*<(windows|shlobj|shobjidl|ole2|chrono|thread|mutex|atomic|fstream|filesystem|iostream)/u,
    );
    expect(code(matcher)).not.toMatch(/FindFirstFile|CompareString|GetLastError|CoCreate/u);
    expect(matcher).toContain('constexpr std::size_t kShellMaxCandidates = 64;');
    // No rule about extensions lives in the matcher: the shell's own name for each candidate is compared.
    expect(code(matcher)).not.toMatch(/lnk|appref|extension|\bstem\b/u);
    // Two entries a name can stand for are "not known"; so are more candidates than the cap, and a
    // candidate whose shell name could not be read.
    expect(matcher).toContain('if (found != kNoShellMatch) return kNoShellMatch;');
    expect(matcher).toContain('candidates.size() > kShellMaxCandidates');
    expect(matcher).toContain('if (!candidates[i].shell_name_known) return kNoShellMatch;');
    // The pure rules: which entries need the shell's name, what a desktop.ini means, and whether a
    // path resolved to the candidate itself.
    expect(matcher).toContain('ShellEntryNeedsShellName(');
    expect(matcher).toContain('ShellDesktopIniLocalizesFileNames(');
    expect(matcher).toContain('ShellResolvedNameIsTheCandidate(');
    expect(matcher).toContain("candidate_name.back() == L'.' || candidate_name.back() == L' '");
    // The intro names both kinds of candidate.
    expect(matcher).toContain('directories that are read-only or system');
    // The real source compares as the file system does, and the harness runs the table.
    expect(source).toContain('CompareStringOrdinal(');
    expect(harness).toContain('computer_use_windows_shell_name_match.h');
    expect(harness).toContain('CheckWindowsShellNameMatch()');
    for (const id of [
      'shellname-lnk-collides-with-same-name',
      'shellname-pdf-exe-hidden-is-the-second',
      'shellname-never-shown-extension-is-the-shells-answer',
      'shellname-x-and-x-website-collide',
      'shellname-folder-with-a-dot-is-not-a-stem',
      'shellname-unreadable-after-the-match',
      'shellname-file-name-is-not-the-display-name',
      'shellname-over-the-cap-is-unknown',
      'shellneeds-read-only-or-system-directory-is-a-candidate',
      'shellneeds-ordinary-directory-is-not-a-candidate',
      'shellneeds-dot-is-never-a-candidate',
      'desktopini-unreadable-section-is-a-yes',
      'desktopini-with-the-section-is-a-yes',
      'resolved-trailing-dot-resolves-to-another-entry',
    ])
      expect(harness, id).toContain(id);
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
