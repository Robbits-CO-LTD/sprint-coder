import { readWindowsHostSource } from '../../../../computer-use-windows-host-source.mjs';
import { describe, expect, it } from 'vitest';

const source = readWindowsHostSource();
const section = (begin: string, end: string) =>
  source.slice(source.indexOf(begin), source.indexOf(end, source.indexOf(begin)));

describe('Windows opt-in start identity contract', () => {
  it('advertises the complete contract and threads opt-in discovery without launching', () => {
    expect(source).toContain(String.raw`\"identityBoundStart\":true`);
    expect(source).toContain('context.include_start_identity = include_start_identity;');
    expect(source).toContain('window_facts, row_window, include_start_identity)');
    expect(source).toContain('!include_start_identity && work.current() && candidates.empty()');
    expect(source).toContain(
      'ListWindowsTargets(&response, &reason, queued_stop_serial, include_start_identity)',
    );
  });

  it('validates the opt-in expected identity before either shared start path', () => {
    const parser = section('bool ParseWindowsStartParameters', 'bool StartWindowsSession');
    expect(parser).toContain('ReadWindowsStartIdentity(metadata');
    const start = section('bool StartWindowsSession', 'void MarkWindowsStartClosed');
    expect(start.match(/input.expected_process_start = expected_process_start;/gu)).toHaveLength(3);
  });

  it.each(['New', 'Existing'])(
    'checks identity outside Stop lock before every %s focus unit',
    (kind) => {
      const start = section(
        `bool StartWindows${kind}Session`,
        `// END windows shared ${kind.toLowerCase()} start`,
      );
      const focus = start.slice(
        start.indexOf('const auto begin_focus'),
        start.indexOf('RECT bounds{};'),
      );
      expect(focus.indexOf('CheckWindowsStartFocusIdentity(')).toBeGreaterThan(-1);
      expect(focus.indexOf('CheckWindowsStartFocusIdentity(')).toBeLessThan(
        focus.indexOf('std::lock_guard'),
      );
      expect(focus).not.toContain('begin_focus()');
      expect(focus).toContain('begin_focus(input.window)');
      if (kind === 'Existing') expect(focus).toContain('begin_focus(refocus_window)');
    },
  );

  it('keeps per-request foreground results on success and failure', () => {
    expect(source).toContain('auto start_result = std::make_shared<WindowsStartResult>();');
    expect(source).toContain('AppendWindowsStartResult(');
    expect(source).toContain('start_result.attempt_count');
    expect(source).toContain('"unconfirmed"');
    expect(source).toContain('"not_attempted"');
  });
});
