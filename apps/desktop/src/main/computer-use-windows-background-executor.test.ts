import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const native = (name: string): string =>
  readFileSync(join(__dirname, '../../computer-use-native', name), 'utf8');

describe('background executor native entry', () => {
  it('routes every background pattern effect through the V1 timed contact', () => {
    const executor = native('computer_use_windows_background_executor.h');
    const semantic = native('computer_use_windows_host_uia_semantic.inc');
    expect(executor.match(/->(?:Invoke|Toggle|Select|SetValue|Expand|Collapse)\(/gu)).toHaveLength(
      6,
    );
    expect(
      executor.match(
        /timed\(\[&\] \{ return \w+->(?:Invoke|Toggle|Select|SetValue|Expand|Collapse)\(/gu,
      ),
    ).toHaveLength(6);
    expect(semantic).toContain('windows_background_executor_detail::CallPattern(');
    expect(semantic).toContain('return WindowsV1UiaContact(result, call);');
  });

  it('registers the BG01 BG05 BG06 native regression cases', () => {
    expect(native('computer_use_protocol_fuzz.cc')).toContain('CheckBackgroundExecutor()');
    const tests = native('computer_use_windows_background_executor_test.h');
    for (const name of [
      'BG01_background_forbidden_api_attempts_zero',
      'BG01_invoke_checks_window_not_old_content',
      'BG01_pattern_readback_and_noop',
      'BG06_claimed_uia_never_retries_or_falls_back',
      'BG05_unissued_action_requires_handoff',
      'BG05_guard_failure_never_falls_back',
    ]) {
      expect(tests).toContain(name);
    }
  });

  it('keeps the executor behind a closed build gate and connects monitor boundaries', () => {
    const semantic = native('computer_use_windows_host_uia_semantic.inc');
    expect(semantic).toContain('#if SPRINT_CODER_BACKGROUND_EXECUTOR_TEST');
    expect(semantic).toContain('background_monitor->state.Claim(');
    expect(semantic).toContain('background_monitor->state.Finish(');
    expect(semantic).toContain('RunBackgroundExecutor(operations)');
    expect(native('computer_use_windows_background_executor.h')).toContain(
      '#define SPRINT_CODER_BACKGROUND_EXECUTOR_TEST 0',
    );
    expect(native('computer_use_windows_host_input.inc')).toContain('awaiting_foreground_handoff');
  });

  it('does not expose foreground APIs to the background pattern adapter', () => {
    const semantic = native('computer_use_windows_host_uia_semantic.inc');
    const start = semantic.indexOf('struct WindowsBackgroundPatternOperations');
    const end = semantic.indexOf('// END background pattern adapter', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(semantic.slice(start, end)).not.toMatch(
      /SetForegroundWindow|ShowWindow|SetFocus|SetCursorPos|SendInput|paste/iu,
    );
  });
});
