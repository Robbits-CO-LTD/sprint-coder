import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const native = (name: string) =>
  readFileSync(join(__dirname, '../../computer-use-native', name), 'utf8');
const input = native('computer_use_windows_host_input.inc');
const explorer = native('computer_use_windows_host_explorer.inc');
const dispatch = input.slice(input.indexOf('bool DispatchWindowsAction('));

describe('Explorer dispatch M2 source boundaries', () => {
  it('explorer_dispatch_rechecks_same_action_point', () => {
    for (const [kind, point] of [
      ['click', 'click_point'],
      ['scroll', 'point'],
    ]) {
      const branch = dispatch.slice(dispatch.indexOf(`kind == "${kind}"`));
      const check = branch.indexOf(
        `RecheckWindowsExplorerDispatch(session, explorer_evidence, ${point})`,
      );
      expect(check).toBeGreaterThan(branch.indexOf('WindowsActionPoint(bounds, metadata,'));
      expect(check).toBeLessThan(branch.indexOf('bool cursor_set = false;'));
    }
  });

  it('explorer_move_and_input_atomic', () => {
    const guard = explorer.slice(explorer.indexOf('bool SendWindowsExplorerPointInput('));
    expect(explorer).toContain('MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK');
    // Windows maps the value to floor(value * extent / 65536): the middle of the pixel's interval
    // is chosen and checked back with that same mapping (no 65535 / (extent - 1) approximation).
    expect(explorer).toContain(
      '((2 * offset + 1) * 65536) / (2 * static_cast<std::int64_t>(extent))',
    );
    expect(explorer).toContain('(value * extent) / 65536 != offset');
    expect(explorer).not.toMatch(/65535\.0|extent - 1\)/u);
    // After the last re-measure: the cursor is at the POINT and no input came, then one array.
    // The virtual desktop is read before the re-measure and again after the last check; the move
    // is fixed from the second read only when both agree, right before SendInput.
    const order = [
      'const WindowsExplorerVirtualScreen measured_screen = ReadWindowsExplorerVirtualScreen();',
      'RecheckWindowsExplorerDispatch(session, evidence, point)',
      'WindowsExplorerWheelReachesView(session.window, evidence->view)',
      'cursor.x != point.x || cursor.y != point.y',
      'now_tick != input_tick',
      'const WindowsExplorerVirtualScreen sending_screen = ReadWindowsExplorerVirtualScreen();',
      '!(sending_screen == measured_screen)',
      'WindowsExplorerAbsoluteMove(point, sending_screen, &events[0])',
      'SendInputForBoundTarget(session, bounds, expected_epoch, count, events)',
    ].map((needle) => guard.indexOf(needle));
    for (const at of order) expect(at).toBeGreaterThan(0);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(guard.split('ReadWindowsExplorerVirtualScreen()').length).toBe(3);
    // The four metrics are read only through ReadWindowsExplorerVirtualScreen.
    const metrics = explorer.slice(
      explorer.indexOf('WindowsExplorerVirtualScreen ReadWindowsExplorerVirtualScreen()'),
      explorer.indexOf('bool WindowsExplorerAbsoluteMove('),
    );
    for (const index of [
      'SM_XVIRTUALSCREEN',
      'SM_YVIRTUALSCREEN',
      'SM_CXVIRTUALSCREEN',
      'SM_CYVIRTUALSCREEN',
    ]) {
      expect(metrics).toContain(`GetSystemMetrics(${index})`);
      expect(explorer.split(`GetSystemMetrics(${index})`).length).toBe(2);
    }
    for (const [kind, point] of [
      ['click', 'click_point'],
      ['scroll', 'point'],
    ]) {
      const branch = dispatch.slice(dispatch.indexOf(`kind == "${kind}"`));
      const send = branch.indexOf('SendWindowsExplorerPointInput(session, explorer_evidence,');
      expect(send).toBeGreaterThan(branch.indexOf('bool cursor_set = false;'));
      expect(branch.slice(send, send + 200)).toContain(`${point}, explorer_input_tick,`);
    }
    // Exactly one re-measure per branch in dispatch (the last one lives in the helper): no wheel
    // is sent between two checks, so a partial scroll is never reported as a stale target.
    expect(
      dispatch.split('RecheckWindowsExplorerDispatch(session, explorer_evidence,').length,
    ).toBe(3);
  });

  it('explorer_scroll_requires_wheel_to_reach_the_view', () => {
    expect(explorer).toContain('SystemParametersInfoW(SPI_GETMOUSEWHEELROUTING, 0, &routing, 0)');
    expect(explorer).toContain('routing == MOUSEWHEEL_ROUTING_MOUSE_POS');
    expect(explorer).toContain('info.hwndFocus == view || IsChild(view, info.hwndFocus)');
  });

  it('explorer_view_change_before_input_emits_nothing', () => {
    expect(explorer).toContain('shell_view.view != evidence->view');
    expect(explorer).toContain('shell_view.folder != evidence->folder');
    expect(explorer).toContain('session.cancel_epoch != evidence->epoch');
    expect(explorer).toContain('WindowsValidationFrameStopSerial() != evidence->stop_serial');
    expect(explorer).toContain(
      'WindowsValidationStillCurrent(evidence->epoch, evidence->stop_serial)',
    );
  });

  it('explorer_preview_owner_change_blocks_dispatch', () => {
    expect(explorer).toContain(
      'WindowsExplorerPointRefusal(session.window, shell_view.view, session.pid, point,',
    );
    expect(explorer).toContain('point_owner != evidence->point_owner');
    expect(explorer).toContain('session.pid != evidence->pid');
  });

  it('closes key and semantic paths before the background executor', () => {
    expect(explorer).toContain('kind != "click" && kind != "scroll"');
    expect(
      dispatch.indexOf('BeginWindowsExplorerDispatch(session, kind, &explorer_evidence)'),
    ).toBeGreaterThan(0);
    expect(
      dispatch.indexOf('BeginWindowsExplorerDispatch(session, kind, &explorer_evidence)'),
    ).toBeLessThan(dispatch.indexOf('DispatchWindowsSemanticAction('));
  });

  it('retains native evidence only on the bound session and clears failed measurements', () => {
    expect(explorer).toContain('session->explorer_dispatch_evidence.reset();');
    expect(explorer).toContain('session->explorer_dispatch_evidence =');
    expect(dispatch).toContain('std::exchange(session.explorer_dispatch_evidence, nullptr)');
  });

  it('production dispatch uses the declaration gate, never the test hook switch', () => {
    expect(input).not.toContain('SPRINT_CODER_WINDOWS_EXPLORER_TEST_HOOKS');
    expect(dispatch).toMatch(
      /if constexpr \(sprint_coder::computer_use::kWindowsExplorerException\) \{\s*if \(!BeginWindowsExplorerDispatch/u,
    );
    expect(
      dispatch.match(
        /if constexpr \(sprint_coder::computer_use::kWindowsExplorerException\) \{\s*if \(!RecheckWindowsExplorerDispatch/gu,
      ),
    ).toHaveLength(2);
    expect(
      dispatch.match(
        /if \(sprint_coder::computer_use::kWindowsExplorerException && explorer_evidence\) \{/gu,
      ),
    ).toHaveLength(2);
    expect(
      dispatch.match(
        /if \(sprint_coder::computer_use::kWindowsExplorerException &&\s*explorer_evidence && !WindowsReadLastInputTick/gu,
      ),
    ).toHaveLength(2);
    const guard = explorer.slice(explorer.indexOf('// BEGIN windows explorer dispatch guard'));
    expect(guard).not.toContain('#if');
    for (const definition of [
      'bool WindowsExplorerNormalizeAxis(',
      'bool BeginWindowsExplorerDispatch(',
      'bool RecheckWindowsExplorerDispatch(',
      'bool WindowsExplorerAbsoluteMove(',
      'bool WindowsExplorerWheelReachesView(',
      'bool SendWindowsExplorerPointInput(',
    ])
      expect(guard).toContain(definition);
    // Fault/elevation overrides remain behind the derived, product-forbidden test switch.
    const stack: string[] = [];
    for (const line of explorer.split('\n')) {
      if (line.startsWith('#if')) stack.push(line);
      else if (line.startsWith('#endif')) stack.pop();
      if (/windows_explorer_(?:fault|ignore_elevation)_for_test/u.test(line))
        expect(stack).toContain('#if defined(SPRINT_CODER_WINDOWS_EXPLORER_TEST_HOOKS)');
    }
  });

  it('gate_off_begin_and_recheck_fail_closed', () => {
    for (const name of ['BeginWindowsExplorerDispatch', 'RecheckWindowsExplorerDispatch']) {
      const body = explorer.slice(explorer.indexOf('bool ' + name + '('));
      expect(body.slice(0, body.indexOf('return false;') + 'return false;'.length)).toMatch(
        /\{\s*if constexpr \(!sprint_coder::computer_use::kWindowsExplorerException\) return false;$/u,
      );
    }
  });

  it('gate_off_pipe_cleanup_never_looks_up_a_session', () => {
    const pipe = native('computer_use_windows_host_pipe.inc');
    const handler = pipe.slice(pipe.indexOf('bool HandlePipeRequest('));
    expect(handler).toMatch(
      /if constexpr \(sprint_coder::computer_use::kWindowsExplorerException\) \{\s*if \(type == MessageType::kDispatch \|\| type == MessageType::kDispatchApproved\)\s*finish_explorer_dispatch.session = FindWindowsSession\(request\);/u,
    );
  });

  it('consumes_shared_evidence_before_every_dispatch_refusal', () => {
    const consume = dispatch.indexOf('std::exchange(session.explorer_dispatch_evidence, nullptr)');
    expect(consume).toBeGreaterThan(0);
    expect(consume).toBeLessThan(dispatch.indexOf('*accepted = false;'));
    for (const refusal of [
      'WindowsRoundTripMayInput(',
      'WindowsSemanticInputInFlight(',
      'ValidateWindowsDispatchBinding(',
    ])
      expect(consume).toBeLessThan(dispatch.indexOf(refusal));
    expect(explorer).toContain('if (std::exchange(evidence->consumed, true)) return nullptr;');
    const begin = explorer.slice(
      explorer.indexOf('bool BeginWindowsExplorerDispatch('),
      explorer.indexOf('bool RecheckWindowsExplorerDispatch('),
    );
    expect(begin).not.toContain('session.explorer_dispatch_evidence');
    const pipe = native('computer_use_windows_host_pipe.inc');
    const handler = pipe.slice(pipe.indexOf('bool HandlePipeRequest('));
    const cleanup = handler.indexOf('} finish_explorer_dispatch;');
    expect(cleanup).toBeGreaterThan(0);
    for (const boundary of [
      'if (!IsBoundedUtf8(',
      'if (!*handshaken',
      'if (!admission_error.empty()',
      'ReplayCachedResponse(',
      'ConsumeWindowsDispatchTicket(',
      'HandleWindowsApproval(',
    ]) {
      expect(handler.indexOf(boundary)).toBeGreaterThan(cleanup);
    }
  });
});
