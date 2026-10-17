import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMPUTER_USE_ARTIFACT_LIMITS } from '@sprint-coder/contracts';
import { describe, expect, it } from 'vitest';

// Source contracts of the Windows read of one node's value (#785 T15-4w). The behaviour is in the
// harness (computer_use_protocol_fuzz.cc, against a fake tree) and in the live seam
// (computer-use-windows-artifact-read-live-seam.test.ts, against real UI Automation). Tied here: the
// constants it shares with Main, that it reads and nothing else, that the host puts it on the lane
// the way the interlock entry is, and that nothing in production enables it.

const nativeDirectory = join(__dirname, '../../computer-use-native');
const read = (name: string): string => readFileSync(join(nativeDirectory, name), 'utf8');
const main = (name: string): string => readFileSync(join(__dirname, name), 'utf8');
const squash = (text: string): string => text.replace(/\s+/gu, ' ');
const code = (text: string): string =>
  text.replace(/\/\/.*$/gmu, '').replace(/"(?:[^"\\]|\\.)*"/gu, '""');

const header = read('computer_use_windows_artifact_read.h');
const host = read('computer_use_windows_host.cc');
const reader = read('computer_use_windows_shadow_reader.h');
const source = read('computer_use_windows_uia_source.h');
const block = (() => {
  const begin = host.indexOf('// BEGIN artifact read');
  const end = host.indexOf('// END artifact read');
  expect(begin).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(begin);
  return host.slice(begin, end);
})();

describe('Windows read of one node value (#785 T15-4w): portable core', () => {
  it('holds the byte bound of the contracts', () => {
    expect(header).toContain(
      `inline constexpr std::size_t kArtifactReadMaxBytes = ${COMPUTER_USE_ARTIFACT_LIMITS.maxBytes};`,
    );
  });

  it('names the same browser executables as Main', () => {
    const table = main('computer-use-browser-identity.ts');
    const windows = /BROWSER_EXECUTABLE_NAMES[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/u.exec(table)![1]!;
    const mainNames = [...windows.matchAll(/'([^']+)'/gu)].map((match) => match[1]!);
    const nativeList = /kBrowserExecutables\[\] = \{([\s\S]*?)\};/u.exec(header)![1]!;
    const nativeNames = [...nativeList.matchAll(/"([^"]+)"/gu)].map((match) => match[1]!);
    expect(nativeNames.sort()).toEqual([...mainNames].sort());
  });

  it('is portable and reads only', () => {
    for (const match of header.matchAll(/^\s*#\s*include\s+(\S+)/gmu))
      expect(
        [
          '"computer_use_artifact_read_judgement.h"',
          '"computer_use_windows_shadow.h"',
          '"computer_use_windows_shadow_reader.h"',
          '<cstddef>',
          '<cstdint>',
          '<string>',
          '<string_view>',
        ].includes(match[1]!),
        match[1],
      ).toBe(true);
    expect(code(header)).not.toMatch(
      /SendInput|mouse_event|keybd_event|SetForegroundWindow|SetFocus|PostMessage|SendMessage|WriteFile|Invoke|SetValue|Select\(/u,
    );
  });

  it('passes the control type name as the role, never the old V1 role, and never looks at a subrole', () => {
    const body = code(header);
    expect(body).toContain('result.role = node.control_type;');
    expect(body).toContain('JudgeArtifactRead(built.facts, built.role)');
    expect(body).not.toMatch(/UiaRole|UIATextField|subrole/u);
    // The password flag and the classifier's secure classes are what refuses a password field.
    expect(body).toContain('facts.secure = node.is_password ||');
    // A node whose properties could not be read is not complete metadata.
    expect(body).toContain('!node.read_failed && !node.oversize');
  });

  it('asks for the value only after the judgement allows it, through the reader gate', () => {
    const body = squash(code(header));
    const judged = body.indexOf('JudgeArtifactRead(');
    const refused = body.indexOf('if (!result.verdict.MayRead()) return result;');
    const valueRead = body.indexOf('reader.ReadTargetValue(');
    expect(judged).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(judged);
    expect(valueRead).toBeGreaterThan(refused);
    // The reader's value call is one of the gated source calls, and the only place that calls it.
    const gated = reader.slice(
      reader.indexOf('// BEGIN gated source calls'),
      reader.indexOf('// END gated source calls'),
    );
    expect(gated).toContain('return source_.Value(element, maximum_bytes, output);');
    expect(reader.replace(gated, '')).not.toMatch(/source_\.Value\(/u);
    // The reader finds a "copy" node as a semantic action's node (by the target id).
    expect(squash(reader)).toContain('kind == "expand_collapse" || kind == "copy"');
  });

  it('reads the text pattern first, bounded, then the value pattern, and never writes', () => {
    const value = source.slice(
      source.indexOf('ShadowReadResult Value(Element element'),
      source.indexOf('ShadowReadResult WindowProcessPath('),
    );
    expect(value.indexOf('UIA_TextPatternId')).toBeGreaterThan(0);
    expect(value.indexOf('UIA_ValuePatternId')).toBeGreaterThan(value.indexOf('UIA_TextPatternId'));
    expect(squash(value)).toContain('GetText(static_cast<int>(maximum_bytes + 1)');
    expect(value).not.toMatch(/SetValue|Invoke|SetFocus|Select|Expand|Collapse|Toggle/u);
    // Not normalized (the value is the node's, Main normalizes), and the bound is in UTF-8 bytes.
    expect(squash(value)).toContain(
      'ShadowTextFromUtf16(text.View(), false, maximum_bytes, output)',
    );
  });
});

describe('Windows read of one node value (#785 T15-4w): the host', () => {
  it('is a probe operation of its own, answered at once and never cached', () => {
    const probe = squash(host.slice(host.indexOf('case MessageType::kProbe: {')));
    const operation = probe.indexOf('if (operation == "read_node_value") {');
    expect(operation).toBeGreaterThan(0);
    // Before the ordinary operations (which are answered through the response cache).
    expect(operation).toBeLessThan(probe.indexOf('std::string response; std::string reason;'));
    const handler = probe.slice(
      operation,
      probe.indexOf('std::string response; std::string reason;'),
    );
    expect(handler).toContain('ReadWindowsNodeValueOnLane(*session, metadata, &text)');
    expect(handler).toContain('Respond(pipe, request, MessageType::kProbeResult, payload)');
    expect(handler).not.toContain('RespondAndCache');
    // The two answers: the value, or nothing.
    expect(handler).toContain('"{\\"ok\\":false}"');
    expect(handler).toContain('JsonEscape(text)');
    // The copies of the value are scrubbed after it is sent.
    expect(handler).toContain('ScrubString(&text); ScrubString(&payload);');
  });

  it('runs on a worker in the multithreaded apartment, the lane waits at most 500 ms, single-flight', () => {
    const body = squash(code(block));
    expect(body).toContain('CoInitializeEx(nullptr, COINIT_MULTITHREADED)');
    expect(body).toContain(
      'std::atomic<bool> &running = InterlockWorkerRunning(); if (running.exchange(true)) return false;',
    );
    expect(body).toContain('pending->ready.wait_for(lock, kInterlockLaneHoldLimit');
    expect(body).toContain('pending->abandoned.store(true, std::memory_order_release);');
    // The worker gets everything by value; the lane re-checks the epoch and the window after the wait.
    expect(body).toContain('const WindowsSession copy = session;');
    expect(body).toContain('cancellation_epoch.load(std::memory_order_acquire) != expected_epoch');
    expect(body).toContain('!RevalidateWindowsTarget(session, bounds, expected_epoch)');
  });

  it('overwrites a value wherever helper memory can still hold it after the lane gave up', () => {
    const body = squash(block);
    // The pending slot scrubs what it still holds when it is released.
    expect(body).toContain('~ArtifactReadPending() { ScrubString(&text); }');
    // A value that reaches the slot after the lane abandoned it is overwritten, never stored (the lane
    // sets the flag under the slot's lock, the worker looks under the same lock).
    const worker = body.slice(
      body.indexOf('std::lock_guard<std::mutex> lock(pending->mutex); // The lane'),
    );
    expect(squash(code(block))).toContain(
      'if (pending->abandoned.load(std::memory_order_acquire)) { ScrubString(&value); value.clear(); ok = false; }',
    );
    expect(worker.length).toBeGreaterThan(0);
    const lane = squash(code(block));
    expect(
      lane.indexOf('pending->abandoned.store(true, std::memory_order_release);'),
    ).toBeGreaterThan(lane.indexOf('pending->ready.wait_for(lock, kInterlockLaneHoldLimit'));
    // The portable read scrubs its own temporary on the failure paths.
    const portable = squash(code(header));
    expect(portable).toContain(
      'if (reader.Canceled() || !source.ActionStillValid()) { ScrubArtifactText(&text);',
    );
    expect(portable).toContain('if (read != ShadowReadResult::kOk) { ScrubArtifactText(&text);');
  });

  it('resolves the node as a semantic action does, and reads it through the 250 ms source', () => {
    const body = squash(code(block));
    const binding = body.indexOf('ValidateWindowsDispatchBinding(');
    const find = body.indexOf('FindWindowsSemanticTarget(copy, target_id, &target, &why)');
    const signature = body.indexOf(
      'ComputeWindowsControlSignature(target, copy.pid, nullptr, &current) && current == signature',
    );
    const risk = body.indexOf('RejectWindowsRisk(ClassifyWindowsUiaElement(target), &why)');
    const create = body.indexOf('WindowsUiaShadowSource::Create(');
    const portable = body.indexOf('ReadWindowsArtifactValue(*source, target_id, info, signature)');
    for (const at of [binding, find, signature, risk, create, portable])
      expect(at).toBeGreaterThan(0);
    expect(find).toBeGreaterThan(binding);
    expect(signature).toBeGreaterThan(find);
    expect(risk).toBeGreaterThan(signature);
    expect(create).toBeGreaterThan(risk);
    expect(portable).toBeGreaterThan(create);
    expect(body).toContain('WindowsUiaShadowSource::kInterlockUiaTimeoutMs');
    expect(body).toContain('windows_uia_source_detail::InterlockShellLookupRunning()');
    // The kind of the binding is "copy", and the recorded signature of the observation is required.
    expect(squash(block)).toContain('kind != "copy"');
    expect(body).toContain('session.semantic_control_signatures.find(target_id)');
    // No new UI Automation object is created here, and no input API is used.
    expect(body).not.toContain('CLSID_CUIAutomation');
    expect(body).not.toMatch(
      /SendInput|SetCursorPos|input_api_attempts|SetForegroundWindow|DispatchWindowsSemanticAction/u,
    );
  });

  it('is exposed by the Windows addon as its own method, and the host adapter does not make it a capability', () => {
    const windows = squash(main('computer-use-native-windows.ts'));
    expect(windows).toContain(
      "readNodeValue: (input) => { const value = record(input); return client.call( 'probe', 'read_node_value', value, stringField(value, 'sessionId'), `readNodeValue:${stringField(value, 'requestId')}`, ); },",
    );
    // Production never reports the capability: only a fake does, until T15-E enables it.
    expect(main('computer-use-native-host.ts')).not.toMatch(/artifactReadSupported\s*[:(=]/u);
    expect(main('computer-use-native-windows.ts')).not.toMatch(/artifactReadSupported\s*[:(=]/u);
    // The planner and the controller still ask the capability, not the method.
    expect(main('computer-use-controller.ts')).toContain(
      'native.artifactReadSupported?.() !== true',
    );
  });
});
