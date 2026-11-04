import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
const dir = join(__dirname, '../../computer-use-native');
const read = (name: string): string =>
  existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : '';
/** The code of a file without its line comments (a comment may name what the code must not do). */
const code = (text: string): string => text.replace(/\/\/.*$/gmu, '');
/** The text between two markers, or a failure: an extraction that finds nothing must not pass. */
function between(text: string, begin: string, end: string): string {
  const start = text.indexOf(begin);
  expect(start, begin).toBeGreaterThanOrEqual(0);
  const stop = text.indexOf(end, start);
  expect(stop, end).toBeGreaterThan(start);
  return text.slice(start, stop);
}
/** Every call `Name(` with its argument text up to the matching parenthesis. */
function calls(text: string, name: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(new RegExp(`(?<![\\w.>])${name}\\(`, 'gu'))) {
    let depth = 0;
    let index = match.index + match[0].length - 1;
    const start = index;
    for (; index < text.length; ++index) {
      if (text[index] === '(') depth += 1;
      if (text[index] === ')' && --depth === 0) break;
    }
    found.push(text.slice(start, index + 1));
  }
  return found;
}

describe('Windows association and selection measurement (N8-1b)', () => {
  it('includes its OS measurement dependency without relying on host include order', () => {
    const source = read('computer_use_windows_uia_source.h');
    expect(source).toContain('#include "computer_use_windows_association_measurement.h"');
  });
  it('requires OS evidence and compares all three boundary measurements', () => {
    const source =
      read('computer_use_windows_association.h') +
      read('computer_use_windows_association_measurement.h');
    for (const token of [
      'AssocIsDangerous',
      'ASSOCSTR_EXECUTABLE',
      'ASSOCSTR_COMMAND',
      'ASSOCSTR_DELEGATEEXECUTE',
      'ASSOCSTR_DROPTARGET',
      'ASSOCSTR_DDECOMMAND',
      'ASSOCSTR_DDEAPPLICATION',
      'ExplorerCommandHandler',
      'ContextMenuHandlers',
      'PerceivedType',
      'UserChoice',
      'ProgId',
      'DelegateExecute',
      'DropTarget',
      'SameWindowsOpenFacts',
    ])
      expect(source).toContain(token);
  });
  it('asks every handler question for the measured default verb through one resolution path', () => {
    const measurement = code(read('computer_use_windows_association_measurement.h'));
    const reader = between(
      measurement,
      'WindowsAssociationFacts ReadAssociation(',
      'std::atomic<bool> &WindowsOpenMeasurementRunning()',
    );
    for (const kind of [
      'ASSOCSTR_EXECUTABLE',
      'ASSOCSTR_COMMAND',
      'ASSOCSTR_DELEGATEEXECUTE',
      'ASSOCSTR_DROPTARGET',
      'ASSOCSTR_DDECOMMAND',
      'ASSOCSTR_DDEAPPLICATION',
    ])
      expect(reader.replace(/\s+/gu, ' ')).toContain(`(${kind}, extension, verb.c_str(), limits,`);
    // The verb is read before the handler questions that depend on it.
    expect(reader.indexOf('prog_id + L"\\\\shell", nullptr')).toBeLessThan(
      reader.indexOf('ASSOCSTR_EXECUTABLE'),
    );
    // The static command key must exist and equal the resolved command exactly.
    expect(reader).toContain(
      'facts.command_key_matches = command_present && command_key == command;',
    );
    // No answer to a handler question is ignored.
    expect(reader).toMatch(
      /if \(facts\.delegate_execute \|\| facts\.drop_target \|\| facts\.dde \|\| facts\.explorer_command_handler \|\|\s*facts\.shell_extension \|\| facts\.verb_restricted \|\| !facts\.command_key_matches\) return facts;/u,
    );
    // What the registry says is recorded before the handler questions, so a failed one cannot hide it.
    expect(reader.indexOf('facts.verb_restricted = verb_restricted;')).toBeLessThan(
      reader.indexOf('ASSOCSTR_EXECUTABLE'),
    );
    // Values that demote the verb from the UI default or give it another command source, on the
    // verb key and on its command key, of any type (the data is not read).
    const compact = reader.replace(/\s+/gu, ' ');
    expect(compact).toContain('for (const auto *value_key : {&key, &command_path})');
    for (const name of [
      'LegacyDisable',
      'ProgrammaticAccessOnly',
      'Extended',
      'AppliesTo',
      'CommandStateHandler',
      'CommandStateSync',
      'IsolatedCommand',
      'command',
    ])
      expect(compact).toContain(`L"${name}"`);
    expect(compact).toContain(
      'if (!RegistryValuePresent(*value_key, value_name, limits, &restricted)) return facts;',
    );
    const present = between(measurement, 'bool RegistryValuePresent(', 'bool AssociationString(');
    expect(present).toContain(
      'RegQueryValueExW(key.value, name, nullptr, &type, nullptr, nullptr)',
    );
    expect(present).toContain(
      'if (read != ERROR_SUCCESS && read != ERROR_MORE_DATA) return false;',
    );
    // Shell extensions of every layer specific to this type (not "*" / AllFilesystemObjects).
    for (const layer of [
      'prog_id + L"\\\\shellex\\\\ContextMenuHandlers"',
      'extension + L"\\\\shellex\\\\ContextMenuHandlers"',
      'L"SystemFileAssociations\\\\" + extension + L"\\\\shellex\\\\ContextMenuHandlers"',
      'L"SystemFileAssociations\\\\" + perceived + L"\\\\shellex\\\\ContextMenuHandlers"',
    ])
      expect(reader.replace(/\s+/gu, ' ')).toContain(`!ShellHandlersPresent(${layer}`);
    // Every layer by the same rule: a handler (a subkey or any value) is a shell extension; an empty
    // key left behind is not; a key that cannot be counted is a failed read.
    expect(reader.match(/ShellHandlersPresent\(/gu)?.length).toBe(4);
    expect(reader).not.toMatch(/RegistryKeyPresent\([^)]*ContextMenuHandlers/u);
    const handlers = between(
      measurement,
      'bool ShellHandlersPresent(',
      'bool RegistryValuePresent(',
    );
    expect(handlers).toContain('&subkeys, nullptr, nullptr,');
    expect(handlers.replace(/\s+/gu, ' ')).toContain(
      '&values, nullptr, nullptr, nullptr, nullptr);',
    );
    expect(handlers).toContain('if (counted != ERROR_SUCCESS || !limits.MayRead()) return false;');
    expect(handlers).toContain('*present = subkeys > 0 || values > 0;');
    expect(reader).toContain(
      'facts.dde = WindowsDdeConfigured(dde_command, dde_application, dde_value, executable, ddeexec);',
    );
    // Absent is only "no association"; any other failure is a failed read.
    expect(measurement).toContain(
      'if (result == HRESULT_FROM_WIN32(ERROR_NO_ASSOCIATION)) { *present = false; return true; }',
    );
  });
  it('judges by the effect and binds the selection to the measured file', () => {
    const core = code(read('computer_use_windows_association.h'));
    expect(core).not.toContain('requires_single_selection');
    expect(core).toContain('EffectClass effect = EffectClass::kUnclassified;');
    const judge = between(
      core,
      'WindowsOpenVerdict JudgeOpenFactsWith(',
      'struct WindowsOpenMeasurementLimits',
    );
    expect(judge).toContain('if (!e2 && !e3) return WindowsOpenVerdict::kTakeover;');
    expect(judge).toContain(
      'JudgeWindowsSingleSelection(current.selection) != WindowsOpenVerdict::kVerified',
    );
    expect(judge).toContain('!SameWindowsOpenTarget(current.association, current.selection)');
    const same = between(core, 'bool SameWindowsOpenTarget(', 'JudgeWindowsAssociation(');
    expect(same).toContain('association.file_id == selection.target_file_id');
    expect(same).toContain('CanonicalWindowsRealPath(selection.target_real_path)');
    // The selection side is resolved by the association's own resolver.
    const selection = between(
      read('computer_use_windows_uia_source.h'),
      'WindowsSingleSelectionFacts MeasureWindowsSingleSelection(',
      'class WindowsUiaShadowSource',
    );
    expect(selection).toContain(
      'windows_association_detail::ResolveRealFile(single_path, budget, &real, &facts.target_file_id)',
    );
    expect(code(read('computer_use_windows_association_measurement.h'))).toContain(
      'if (!ResolveRealFile(path, limits, &real, &file_id)) return facts;',
    );
  });
  it('ties a selected element to the bound window by the window hierarchy, not only the process', () => {
    const selection = code(
      between(
        read('computer_use_windows_uia_source.h'),
        'WindowsSingleSelectionFacts MeasureWindowsSingleSelection(',
        'class WindowsUiaShadowSource',
      ),
    );
    expect(selection).toContain('get_CurrentNativeWindowHandle(&native)');
    expect(selection).toContain('GetParentElement(node, parent.Receive())');
    expect(selection).toContain('GetAncestor(window, GA_ROOT) != top) return facts;');
    expect(selection).toContain('step = GetAncestor(step, GA_PARENT);');
    expect(selection).toContain('if (!under_tab) return facts;');
    // The hierarchy check comes before the selection is read.
    expect(selection.indexOf('GetAncestor(window, GA_ROOT)')).toBeLessThan(
      selection.indexOf('UIA_SelectionPatternId'),
    );
  });
  it('cancels only a live worker, by its own handle, under the lock', () => {
    const measurement = code(read('computer_use_windows_association_measurement.h'));
    const runner = between(
      measurement,
      'Result RunWindowsOpenMeasurement(',
      'MeasureWindowsAssociation(',
    );
    expect(runner).not.toMatch(/OpenThread|thread_id|GetCurrentThreadId|THREAD_TERMINATE/u);
    expect(runner).toContain(
      'DuplicateHandle(GetCurrentProcess(), GetCurrentThread(), GetCurrentProcess(), &self, 0,',
    );
    expect(runner).toContain('~Pending() { if (thread != nullptr) CloseHandle(thread); }');
    // A result done in time is only discarded; nothing is canceled for it.
    expect(runner.replace(/\s+/gu, ' ')).toContain(
      'if (pending->done && limits.MayRead()) { if (discarded) *discarded = pending->discarded; return std::move(pending->result); }',
    );
    const cancel = between(runner, 'pending->abandoned.store(true);', 'return {};\n}');
    expect(cancel).toContain('if (!pending->done && pending->thread != nullptr) {');
    expect(cancel).toContain('CoCancelCall(GetThreadId(pending->thread), 0);');
    expect(cancel).toContain('CancelSynchronousIo(pending->thread);');
    // The lock taken for the wait is still held: nothing unlocks it before the cancel.
    expect(runner).not.toContain('unlock(');
  });
  it('runs every measurement on one process-wide slot', () => {
    const measurement = code(read('computer_use_windows_association_measurement.h'));
    const runner = between(
      measurement,
      'Result RunWindowsOpenMeasurement(',
      'MeasureWindowsAssociation(',
    );
    expect(runner).not.toMatch(/\bstatic\b/u);
    expect(runner).toContain(
      'std::atomic<bool> &running = windows_association_detail::WindowsOpenMeasurementRunning();',
    );
    expect(measurement.match(/static std::atomic<bool> \*const running/gu)?.length).toBe(1);
    // The worker frees the slot inside the locked section, before `done`: a caller that sees
    // `done` and starts the next measurement finds the slot free.
    expect(runner.replace(/\s+/gu, ' ')).toContain(
      'pending->result = std::move(result); pending->discarded = discarded; } running.store(false); pending->done = true; }',
    );
    expect(runner.match(/running\.store\(false\)/gu)?.length).toBe(2);
    expect(read('computer_use_windows_association_seam.cc')).toContain(
      '"measurement-back-to-back-slot-free"',
    );
    expect(read('computer_use_windows_association_measurement.h')).toContain(
      'So at most ONE detached worker thread can ever be stuck.',
    );
    expect(read('computer_use_windows_association.h')).toContain('They must own');
  });
  it('only reads: the association measurement calls a closed set of OS functions', () => {
    const measurement = code(read('computer_use_windows_association_measurement.h'));
    expect(measurement).not.toBe('');
    const found = new Set(
      [
        ...measurement.matchAll(/(?<![\w.>])([A-Z]\w*)\(/gu),
        ...measurement.matchAll(/(?<![\w.>])([A-Z]\w*)<[^;(){}]*>\(/gu),
      ].map((match) => match[1]!),
    );
    const allowed = new Set([
      // Windows: strings, registry reads, association reads, attribute-only opens, trust checks.
      'WideCharToMultiByte',
      'RegCloseKey',
      'RegOpenKeyExW',
      'RegQueryValueExW',
      'RegQueryInfoKeyW',
      'AssocQueryStringW',
      'AssocIsDangerous',
      'HRESULT_FROM_WIN32',
      'CreateFileW',
      'CloseHandle',
      'GetFileInformationByHandle',
      'GetFileInformationByHandleEx',
      'GetFinalPathNameByHandleW',
      'WinVerifyTrust',
      'WTHelperProvDataFromStateData',
      'WTHelperGetProvSignerFromChain',
      // The measurement lane: its own thread, COM apartment and cancellation of its own call.
      'DuplicateHandle',
      'GetCurrentProcess',
      'GetCurrentThread',
      'GetThreadId',
      'CoInitializeEx',
      'CoUninitialize',
      'CoEnableCallCancellation',
      'CoDisableCallCancellation',
      'CoCancelCall',
      'CancelSynchronousIo',
      'SUCCEEDED',
      // This file's and the shared core's own functions.
      'Utf8',
      'Key',
      'Close',
      'Pending',
      'RegistryKeyPresent',
      'RegistryString',
      'AssociationString',
      'RequiredAssociationString',
      'RegistryValuePresent',
      'ShellHandlersPresent',
      'WindowsDdeConfigured',
      'VerifiedSigner',
      'HexBytes',
      'ResolveRealFile',
      'ReadAssociation',
      'Sha256Hex',
      'NormalizeExtension',
      'IsPlainExtension',
      'WindowsOpenMeasurementRunning',
      'WindowsOpenMeasurementDeadline',
      'RunWindowsOpenMeasurement',
      'MeasureWindowsAssociation',
    ]);
    for (const name of found) expect(allowed.has(name), name).toBe(true);
    expect(measurement).not.toMatch(
      /RegSetValue|RegSetKeyValue|RegCreateKey|RegDelete|RegRenameKey|RegCopyTree|RegLoad|RegSave|RegRestore|RegFlush|ShellExecute|CreateProcess|WinExec|DeleteFile|MoveFile|CopyFile|ReplaceFile|WriteFile|SetFile|DeviceIoControl|GENERIC_WRITE|GENERIC_ALL|FILE_WRITE|FILE_APPEND|MAXIMUM_ALLOWED|KEY_WRITE|KEY_SET_VALUE|KEY_CREATE|KEY_ALL_ACCESS|CREATE_ALWAYS|CREATE_NEW|OPEN_ALWAYS|TRUNCATE_EXISTING|DELETE_ON_CLOSE|Invoke|DoVerb|SendInput|TerminateThread|TerminateProcess|OpenThread|THREAD_TERMINATE/u,
    );
    // Files are opened existing, for reading only; registry keys for querying only.
    const opens = calls(measurement, 'CreateFileW');
    expect(opens.length).toBe(2);
    for (const open of opens) {
      expect(open).toMatch(
        /^\(path\.c_str\(\), (?:GENERIC_READ|FILE_READ_ATTRIBUTES), FILE_SHARE_READ, nullptr, OPEN_EXISTING,/u,
      );
    }
    expect(opens.some((open) => open.includes('FILE_FLAG_OPEN_REPARSE_POINT'))).toBe(true);
    const keys = calls(measurement, 'RegOpenKeyExW');
    expect(keys.length).toBe(4);
    // The trust check shows no UI, fetches nothing over the network and only verifies and closes.
    const signer = between(measurement, 'bool VerifiedSigner(', 'std::string HexBytes(');
    expect(signer).toContain('trust.dwUIChoice = WTD_UI_NONE;');
    expect(signer).toContain('trust.fdwRevocationChecks = WTD_REVOKE_NONE;');
    expect(signer).toContain('trust.dwProvFlags = WTD_CACHE_ONLY_URL_RETRIEVAL | WTD_SAFER_FLAG;');
    expect(calls(measurement, 'WinVerifyTrust')).toEqual([
      '(nullptr, &policy, &trust)',
      '(nullptr, &policy, &trust)',
    ]);
    expect(calls(signer, 'WinVerifyTrust').length).toBe(2);
    expect(signer.indexOf('WTD_STATEACTION_VERIFY')).toBeLessThan(
      signer.indexOf('WTD_STATEACTION_CLOSE'),
    );
    expect(measurement.match(/dwStateAction = /gu)?.length).toBe(2);
    // The lane's thread calls: its own thread is duplicated once; the cancels go only to that handle.
    const runner = between(
      measurement,
      'Result RunWindowsOpenMeasurement(',
      'MeasureWindowsAssociation(',
    );
    const pinned: ReadonlyArray<readonly [string, string[]]> = [
      [
        'DuplicateHandle',
        [
          '(GetCurrentProcess(), GetCurrentThread(), GetCurrentProcess(), &self, 0, FALSE, DUPLICATE_SAME_ACCESS)',
        ],
      ],
      ['CoCancelCall', ['(GetThreadId(pending->thread), 0)']],
      ['GetThreadId', ['(pending->thread)']],
      ['CancelSynchronousIo', ['(pending->thread)']],
    ];
    for (const [name, expected] of pinned) {
      const flat = (text: string): string[] =>
        calls(text, name).map((call) => call.replace(/\s+/gu, ' '));
      expect(flat(measurement), name).toEqual(expected);
      expect(flat(runner), name).toEqual(expected);
    }
    for (const key of keys) expect(key).toMatch(/, 0, KEY_QUERY_VALUE, &key\.value\)$/u);
  });
  it('keeps the portable fixture independent of Windows OS headers', () => {
    const visited = new Set<string>();
    const visit = (name: string): void => {
      if (visited.has(name)) return;
      visited.add(name);
      const source = read(name);
      expect(source, name).not.toBe('');
      expect(source, name).not.toMatch(
        /#include\s*<(?:windows|objbase|shlwapi|softpub|wintrust|wincrypt)\.h>/iu,
      );
      for (const match of source.matchAll(/#include\s*"([^"]+)"/gu)) visit(match[1]!);
    };
    visit('computer_use_windows_association_fixture.h');
    expect(read('computer_use_protocol_fuzz.cc')).toContain(
      '#include "computer_use_windows_association_fixture.h"',
    );
  });
  it('pins the Windows-only viewer table independently', () => {
    const source = read('computer_use_windows_document_viewers.h');
    expect(source).toContain('kWindowsDocumentViewerVersion = 1');
    expect(source).toContain('std::array<WindowsDocumentViewer, 0>');
    let hash = 14695981039346656037n;
    for (const byte of [...Buffer.from('windows-document-viewers-v1'), 255, 0, 0, 0, 1])
      hash = ((hash ^ BigInt(byte)) * 1099511628211n) & ((1n << 64n) - 1n);
    expect(source).toContain(`kWindowsDocumentViewerDigestPinned = 0x${hash.toString(16)}ULL`);
    expect(source).toContain(
      'static_assert(kWindowsDocumentViewerDigest == kWindowsDocumentViewerDigestPinned',
    );
  });
  it('injects the synthetic viewer row only in the fixture', () => {
    const fixture = read('computer_use_windows_association_fixture.h');
    expect(fixture).toContain('static_assert(kWindowsDocumentViewers.empty()');
    expect(fixture).toContain('WindowsTestViewerRowFor(');
    for (const name of [
      'computer_use_windows_association.h',
      'computer_use_windows_association_measurement.h',
      'computer_use_windows_document_viewers.h',
      'computer_use_windows_uia_source.h',
      'computer_use_windows_approval_measurement.h',
    ])
      expect(read(name), name).not.toContain('WindowsTestViewerRowFor');
    // Only the detail forms take a table; the public forms are bound to the production table, whose
    // version and digest the boundary digest carries.
    const core = code(read('computer_use_windows_association.h'));
    expect(core).toContain(
      'return windows_open_detail::JudgeAssociationWith(facts, kWindowsDocumentViewers);',
    );
    expect(core).toContain(
      'return windows_open_detail::JudgeOpenFactsWith(current, previous, kWindowsDocumentViewers);',
    );
    expect(core.match(/JudgeAssociationWith\(/gu)?.length).toBe(3);
    expect(core.match(/JudgeOpenFactsWith\(/gu)?.length).toBe(2);
    expect(core.match(/std::span<const WindowsDocumentViewer>/gu)?.length).toBe(2);
    expect(core).not.toMatch(/std::span<const WindowsDocumentViewer> \w+ =/u);
    const digest = between(
      core,
      'std::string WindowsOpenFactsDigest(',
      'bool SameWindowsOpenFacts(',
    );
    expect(digest).toContain('append(std::to_string(kWindowsDocumentViewerVersion));');
    expect(digest).toContain('append(std::to_string(kWindowsDocumentViewerDigest));');
    // No production source reaches the table-taking forms.
    for (const name of readdirSync(dir)) {
      if (!/\.(?:h|cc|inc|mm|cpp)$/u.test(name)) continue;
      if (
        name === 'computer_use_windows_association.h' ||
        name === 'computer_use_windows_association_fixture.h'
      )
        continue;
      expect(code(read(name)), name).not.toMatch(
        /windows_open_detail|JudgeAssociationWith|JudgeOpenFactsWith/u,
      );
    }
  });
  it('reads the complete shell selection and cross-checks SelectionPattern', () => {
    const source = read('computer_use_windows_uia_source.h');
    for (const token of [
      'SVGIO_SELECTION',
      'GetCurrentSelection',
      'UIA_SelectionPatternId',
      'MeasureWindowsSingleSelection',
    ])
      expect(source).toContain(token);
  });
  it('keeps the negative matrix connected to the portable harness and Windows seam', () => {
    const fixture = read('computer_use_windows_association_fixture.h');
    for (const name of [
      'association-unknown-handler',
      'association-test-row-verified',
      'association-row-field-mismatch',
      'association-rlo-real-executable',
      'association-defect-with-row',
      'association-dangerous',
      'association-application',
      'association-ide-unknown-real-path',
      'identity-canonical-form',
      'selection-single',
      'selection-multiple',
      'selection-other',
      'selection-none',
      'selection-read-failed',
      'selection-uia-mismatch',
      'selection-offscreen',
      'selection-uia-read-failed',
      'open-production-table-empty',
      'open-e3-verified',
      'open-e2-association-only',
      'open-effect-not-e2-e3',
      'open-e3-requires-selection',
      'open-identity-mismatch',
      'open-e3-selection-identity-kept',
      'open-e3-selection-required',
      'open-e2-selection-not-used',
      'association-dde-explicit',
      'boundary-identical-verified',
      'boundary-digest-field',
      'boundary-changed-takeover',
      'boundary-changed-verdict',
      'measurement-deadline',
      'measurement-expired',
      'measurement-clock-reversed',
      'measurement-cancelled',
    ])
      expect(fixture).toContain(`"${name}"`);
    for (const file of [
      'computer_use_protocol_fuzz.cc',
      'computer_use_windows_association_seam.cc',
    ])
      expect(read(file)).toContain('CheckWindowsAssociationSelection(Check)');
  });
  it('has a receiving slot for the open facts that MeasureWindowsApproval does not read yet', () => {
    const source = read('computer_use_windows_approval_measurement.h');
    const input = between(source, 'struct WindowsApprovalMeasurementInput {', '};');
    expect(input).toMatch(/\bWindowsOpenFacts\s*\*\s*open_facts\b/u);
    expect(input).toContain('deliberately does not read it yet');
    const body = between(
      source,
      'MeasureWindowsApproval(const WindowsApprovalMeasurementInput',
      'namespace',
    );
    expect(code(body)).not.toContain('open_facts');
  });
  it('keeps capabilities and both effect gates closed', () => {
    const source = read('computer_use_windows_host_preflight.inc');
    expect(source).toContain('/*download_open=*/false, /*file_manager_open=*/false');
    expect(source).not.toContain('documentViewerVersion');
    expect(source).not.toContain('approvalApprove');
  });
});
