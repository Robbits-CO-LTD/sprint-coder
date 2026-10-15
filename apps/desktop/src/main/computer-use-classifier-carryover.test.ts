import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Source contracts for the classifier v2 carry-over (the Low items that need no real machine). The
// behaviour is in the portable harness (computer_use_protocol_fuzz.cc, MSVC and clang); what is tied
// here is wording and structure the harness cannot see: where the cancellation epoch is and is not
// checked, which statics the macOS shadow block may touch, and that the role is judged folded.

const nativeDirectory = join(__dirname, '../../computer-use-native');
const read = (name: string): string => readFileSync(join(nativeDirectory, name), 'utf8');
const shadowHeader = read('computer_use_effect_shadow.h');
const macos = read('computer_use_macos.mm');
const scheduler = read('computer_use_windows_shadow_scheduler.h');
const harness = read('computer_use_protocol_fuzz.cc');
const adr = readFileSync(
  join(__dirname, '../../../../tasks/designs/adr-computer-use-agent-driven-v2.md'),
  'utf8',
);

describe('classifier carry-over (Low items without a real machine)', () => {
  it('judges the role on the folded value, like every other fact', () => {
    const squashed = shadowHeader.replace(/\s+/gu, ' ');
    expect(squashed).toContain(
      'const bool role_present = !facts.chain.empty() && !effect_detail::NormalizeForMatch(facts.chain.front().role).empty();',
    );
    expect(squashed).not.toContain('!nodes.front().role.empty()');
    // The fold knows the ideographic space and the half-width WA with a voiced mark.
    expect(shadowHeader).toContain('if (code == 0x3000)');
    expect(shadowHeader).toContain('folded == 0x30EF ? 0x30F7');
  });

  it('says the cancellation epoch is checked when the capture starts and before every call, not when it is scheduled', () => {
    expect(macos).toContain('the cancellation epoch is checked when the capture starts and');
    expect(macos).toContain('before every AX call, not when it is scheduled');
    expect(scheduler).toContain(
      'checked when the capture starts and before every platform call; Schedule itself does not check it',
    );
    expect(scheduler).not.toContain('not only when it is scheduled');
    expect(adr).toContain(
      '取消しの確認は、取得を始めるときと、AX を 1 回呼ぶごとの 2 か所で、予約するときには行わない',
    );
    expect(adr).not.toContain('予約するときも');
    // The macOS scheduling step really does not look at the epoch (the comment would be a lie).
    const schedule = /void ScheduleEffectShadow\([\s\S]*?\n\}\n/u.exec(macos);
    expect(schedule).not.toBeNull();
    expect(schedule![0]).not.toContain('DispatchCancellationStillValid');
  });

  it('keeps every static the queued macOS block can touch alive at exit', () => {
    // The ring is leaked on purpose; the accessor forwards to it.
    expect(shadowHeader).toMatch(
      /ProcessShadowLog\(\) \{\s*static EffectShadowLog \*const log = new EffectShadowLog\(\);\s*return \*log;/u,
    );
    expect(macos).toContain('return sprint_coder::computer_use::ProcessShadowLog();');
    // The other statics are trivially destructible: an atomic flag and a queue pointer.
    expect(macos).toContain('static std::atomic<bool> in_flight{false};');
    expect(macos).toMatch(/static dispatch_queue_t queue = dispatch_queue_create\(/u);
    // No static with a destructor (a string, a vector, a mutex, a log by value) in the shadow block.
    const begin = macos.indexOf('// BEGIN effect shadow capture');
    const end = macos.indexOf('// END effect shadow capture');
    const section = macos.slice(begin, end);
    expect(section).not.toMatch(
      /static\s+(?:const\s+)?(?:std::(?:string|vector|map|set|mutex|unique_ptr|shared_ptr)|sprint_coder::computer_use::EffectShadowLog)\b[^*]/u,
    );
  });

  it('is exercised by the harness', () => {
    for (const name of [
      'shadow-blank-role-is-missing',
      'shadow-blank-label-field-is-a-takeover',
      'shadow-fold-ideographic-space',
      'effect-scroll-bare-picker-role-in-scope',
      'effect-native-value-scroll-neighbor-only-is-a-takeover',
      'effect-browser-value-scroll-neighbor-labels-it',
    ])
      expect(harness, name).toContain(`"${name}"`);
  });
});
