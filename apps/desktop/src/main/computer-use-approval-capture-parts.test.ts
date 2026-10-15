import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Classifier v2, C4-2a: the parts that measure an approval on the serial lane, and nothing that
// calls them yet. A source contract (the behaviour of the pure half is in the harness): which
// functions the new section may call, that every read goes through Settle, that it takes no state
// lock and no N-API, and that the capture the shadow uses is the same one.

const nativeDirectory = join(__dirname, '../../computer-use-native');
const macos = readFileSync(join(nativeDirectory, 'computer_use_macos.mm'), 'utf8');

const BEGIN = '// BEGIN approval measurement capture (classifier v2 C4-2a)';
const END = '// END approval measurement capture';
const SHADOW_BEGIN = '// BEGIN effect shadow capture (classifier v2 C2)';
const SHADOW_END = '// END effect shadow capture';

function slice(begin: string, end: string): string {
  const from = macos.indexOf(begin);
  const to = macos.indexOf(end);
  expect(from, begin).toBeGreaterThan(0);
  expect(to, end).toBeGreaterThan(from);
  return macos.slice(from + begin.length, to);
}

const section = (): string => slice(BEGIN, END);
const shadow = (): string => slice(SHADOW_BEGIN, SHADOW_END);
const code = (text: string): string =>
  text.replace(/\/\/.*$/gmu, '').replace(/"(?:[^"\\]|\\.)*"/gu, '""');

/** Every function-like name the text calls or defines (member calls are not names). */
function calledNames(text: string): string[] {
  const keywords = new Set([
    'if',
    'for',
    'while',
    'switch',
    'catch',
    'return',
    'sizeof',
    'static_cast',
    'const_cast',
    'reinterpret_cast',
    'decltype',
    'noexcept',
    'operator',
  ]);
  const plain = code(text).replace(/(?:\.|->)\s*[A-Za-z_]\w*\s*\(/gu, '(');
  const names = new Set<string>();
  for (const match of plain.matchAll(/\b([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)\s*\(/gu))
    if (!keywords.has(match[1]!)) names.add(match[1]!);
  return [...names].sort();
}

const ALLOWED_CALLS = new Set([
  'AXUIElementCopyAttributeValue',
  'AXValueGetType',
  'AXValueGetTypeID',
  'AXValueGetValue',
  'CFGetTypeID',
  'CaptureShadowTargetFacts',
  'DispatchCancellationStillValid',
  'MeasureApproval',
  'ReadApprovalAuthorityIdentity',
  'ReadApprovalTargetFrame',
  'ReadShadowGeometry',
  'ReadWindowBounds',
  'RoundAuthorityUnit',
  'MeasureNativeApprovalOnLane',
  'ShadowCfRef',
  'ShadowReader',
  'HighImpactSourceFor',
  'NativeApprovalMeasurement',
  'std::fabs',
  'std::isfinite',
  'std::llround',
  'std::move',
  // Local variables and members written as `name(...)` after a member call is dropped.
  'app_identity',
  'budget',
  'process_generation',
  'window_identity',
  'holder',
  'reader',
  'request',
  'value',
  'target',
]);

describe('Computer Use approval measurement capture (classifier v2, C4-2a)', () => {
  it('is defined and called by nobody yet', () => {
    expect(macos.match(/MeasureNativeApprovalOnLane\(/gu)).toHaveLength(1);
    for (const name of [
      'ReadApprovalTargetFrame',
      'ReadApprovalAuthorityIdentity',
      'ReadShadowGeometry',
    ])
      expect(macos.match(new RegExp(`\\b${name}\\(`, 'gu'))!.length, name).toBeLessThanOrEqual(3);
    // The addon's own measurement is still the empty one: nothing is approvable.
    const empty =
      /MeasureNativeApproval\(const NativeDispatchRequest& request\) \{[\s\S]*?\n\}/u.exec(macos);
    expect(empty).not.toBeNull();
    expect(empty![0]).toContain('(void)request;');
    expect(empty![0]).toContain('return {};');
    expect(macos).not.toContain('single_use_approval');
  });

  it('may call only a closed list of functions', () => {
    expect(calledNames(section()).filter((name) => !ALLOWED_CALLS.has(name))).toEqual([]);
  });

  it('takes no state lock, no serial lock and no N-API: the caller holds the lane', () => {
    const text = code(section());
    expect(text).not.toMatch(
      /state_mutex|lock_guard|unique_lock|scoped_lock|mac_dispatch_serial_mutex|mac_sessions_mutex|napi_/u,
    );
    // And it has no way to write, act, post an event, or send a message.
    expect(text).not.toMatch(
      /\bkAX\w*Action\b|CFSTR\s*\(|SetAttributeValue|PerformAction|PostKeyboardEvent|CGEvent|NSEvent|NSWorkspace|activateWithOptions|input_api_attempts|dispatch_async|dispatch_sync/u,
    );
    expect(text.replaceAll('[&]', '').replaceAll('[[maybe_unused]]', '')).not.toMatch(/[[\]]/u);
  });

  it('passes the AX value kinds as AXValueType: the constants are not that type in C++', () => {
    const text = code(section());
    const uses = [...text.matchAll(/kAXValueCG(?:Point|Size)Type/gu)];
    expect(uses).toHaveLength(2);
    for (const use of uses)
      expect(text.slice(Math.max(0, use.index - 25), use.index)).toBe('static_cast<AXValueType>(');
  });

  it('reads only the position and size of the target beyond the shared capture', () => {
    const attributes = new Set(
      [...code(section()).matchAll(/\bkAX([A-Za-z]+)Attribute\b/gu)].map((entry) => entry[1]),
    );
    expect([...attributes].sort()).toEqual(['Position', 'Size']);
    expect(code(section())).toContain('kAXValueCGPointType');
    expect(code(section())).toContain('kAXValueCGSizeType');
  });

  it('steps the reader before every AX read and settles every result', () => {
    const text = code(section());
    const reads = [...text.matchAll(/AXUIElementCopyAttributeValue\(/gu)];
    expect(reads).toHaveLength(1);
    const before = text.slice(0, reads[0]!.index);
    expect(before.slice(before.lastIndexOf('\n}') + 2)).toContain('reader.Step()');
    // Every call of the geometry reader is the argument of reader.Settle(...).
    const geometry = [...text.matchAll(/\bReadShadowGeometry\(/gu)];
    let called = 0;
    for (const match of geometry) {
      const head = text.slice(0, match.index);
      if (/\bShadowRead\s*$/u.test(head)) continue;
      called += 1;
      expect(head, `ReadShadowGeometry at ${match.index}`).toMatch(/\bSettle\(\s*$/u);
    }
    expect(called).toBe(2);
    // The window's bounds are a read too: it is stepped.
    const identity =
      /ApprovalAuthorityIdentity ReadApprovalAuthorityIdentity\([\s\S]*?\n\}\n/u.exec(section());
    expect(identity).not.toBeNull();
    expect(identity![0].indexOf('reader.Step()')).toBeGreaterThan(0);
    expect(identity![0].indexOf('reader.Step()')).toBeLessThan(
      identity![0].indexOf('ReadWindowBounds('),
    );
  });

  it('rounds every length and position in one place, and refuses a value that is not a number', () => {
    const text = code(section());
    expect(text.match(/std::llround\(/gu)).toHaveLength(1);
    const round = /bool RoundAuthorityUnit\([\s\S]*?\n\}\n/u.exec(section());
    expect(round).not.toBeNull();
    expect(round![0]).toContain('!std::isfinite(value)');
    expect(round![0]).toContain('std::fabs(value) > 1.0e9');
    expect(round![0]).toContain('std::llround(value)');
    // The frame needs both reads and a size that makes sense; a failed rounding is a failed read.
    const frame = /ApprovalTargetFrame ReadApprovalTargetFrame\([\s\S]*?\n\}\n/u.exec(section());
    expect(frame).not.toBeNull();
    expect(frame![0]).toContain('frame.present = true;');
    expect(frame![0]).toContain('frame.width >= 0 && frame.height >= 0');
    expect(frame![0]).toMatch(/RoundAuthorityUnit\(origin\.x, &frame\.x\)/u);
    expect(frame![0]).toContain('*failed = true;');
  });

  it('uses the capture the shadow uses: one function reads the target, its chain and its neighbours', () => {
    const shared = /ShadowCfRef CaptureShadowTargetFacts\([\s\S]*?\n\}\n/u.exec(shadow());
    expect(shared).not.toBeNull();
    for (const needle of [
      'CopyShadowTarget(reader)',
      'CaptureShadowChain(',
      'CaptureShadowNeighbors(',
      'kAXURLAttribute',
      'kAXFilenameAttribute',
    ])
      expect(shared![0], needle).toContain(needle);
    const record = /void RecordEffectShadow\([\s\S]*?\n\}\n/u.exec(shadow());
    expect(record![0]).toContain('CaptureShadowTargetFacts(reader, &capture)');
    expect(section()).toContain('CaptureShadowTargetFacts(reader, &capture)');
    // The shadow's own reads did not grow: the shared function took them over as they were.
    expect([
      ...code(shadow()).matchAll(/AXUIElementCopy(?:Attribute|ElementAt)\w*\(/gu),
    ]).toHaveLength(5);
  });

  it('measures on the lane with the same bounds, and the source follows the effect', () => {
    const measure = /NativeApprovalMeasurement MeasureNativeApprovalOnLane\([\s\S]*?\n\}\n/u.exec(
      section(),
    );
    expect(measure).not.toBeNull();
    const body = measure![0];
    expect(body).toContain('noexcept');
    // No session is a person's, and so is a measurement that threw.
    expect(body).toMatch(
      /if \(request\.session == nullptr\) \{\s*measured\.takeover = true;\s*return measured;\s*\}/u,
    );
    expect(body).toMatch(
      /catch \(\.\.\.\) \{\s*NativeApprovalMeasurement person;\s*person\.takeover = true;\s*return person;\s*\}/u,
    );
    // A frame that could not be read only leaves the frame absent (a confirmation then is a
    // person's); it does not make the capture of an ordinary control incomplete.
    expect(body).toContain('ReadApprovalTargetFrame(reader, target.Element(), &frame_failed)');
    expect(body).not.toContain(
      'ReadApprovalTargetFrame(reader, target.Element(), &capture.read_failed)',
    );
    // No session is a person's; a canceled action is neither eligible nor a takeover; both come
    // before anything is read.
    expect(body.indexOf('request.session == nullptr')).toBeGreaterThan(0);
    expect(body.indexOf('request.session == nullptr')).toBeLessThan(
      body.indexOf('!DispatchCancellationStillValid(request)'),
    );
    expect(body.indexOf('!DispatchCancellationStillValid(request)')).toBeLessThan(
      body.indexOf('ShadowReader reader(request);'),
    );
    expect(body).toContain('ShadowReader reader(request);');
    expect(body).toContain('reader.canceled');
    expect(body).toContain('capture.budget_exhausted = reader.budget.Exhausted();');
    // The high-impact judgement is the core's own reading of this capture (a confirmation rests on
    // native's facts, a supervised action claims none), never a statement of the caller's.
    expect(body).toContain('input.source = HighImpactSourceFor(capture, input.request, ruleset);');
    expect(body).not.toMatch(/HighImpactSource::k/u);
    expect(body).toContain('MeasureApproval(input)');
    expect(body.indexOf('capture.budget_exhausted')).toBeLessThan(
      body.indexOf('MeasureApproval(input)'),
    );
    // Only a v2 route, the version's own rule set and the build's attest are passed in.
    expect(body).toContain('ClassifierRoute route');
    expect(body).toContain('std::uint32_t attested_classifier_version');
  });

  it('is recorded in the ADR with the C4-2a contract', () => {
    const adr = readFileSync(
      join(__dirname, '../../../../tasks/designs/adr-computer-use-agent-driven-v2.md'),
      'utf8',
    );
    expect(adr).toContain('C4-2a');
  });
});
