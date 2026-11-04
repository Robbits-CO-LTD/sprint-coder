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
    // After the last re-measure: the cursor is at the POINT and no input came, then one array.
    const order = [
      'RecheckWindowsExplorerDispatch(session, evidence, point)',
      'WindowsExplorerWheelReachesView(session.window, evidence->view)',
      'cursor.x != point.x || cursor.y != point.y',
      'now_tick != input_tick',
      'SendInputForBoundTarget(session, bounds, expected_epoch, count, events)',
    ].map((needle) => guard.indexOf(needle));
    for (const at of order) expect(at).toBeGreaterThan(0);
    expect(order).toEqual([...order].sort((a, b) => a - b));
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
    expect(explorer).toContain('std::exchange(session.explorer_dispatch_evidence, nullptr)');
  });

  it('production_gates_remain_closed_before_ruleset4', () => {
    const facts = native('computer_use_windows_target_facts.h');
    expect(facts).toContain('constexpr bool kWindowsExplorerException = false;');
    // Calls are compiled only with the existing acceptance-only Explorer definition.
    for (const call of [
      'BeginWindowsExplorerDispatch(session,',
      'RecheckWindowsExplorerDispatch(session,',
      'SendWindowsExplorerPointInput(session,',
      'WindowsReadLastInputTick(&explorer_input_tick)',
    ]) {
      let at = dispatch.indexOf(call);
      expect(at).toBeGreaterThan(0);
      while (at >= 0) {
        expect(
          dispatch.lastIndexOf('#if defined(SPRINT_CODER_WINDOWS_EXPLORER_TEST_HOOKS)', at),
        ).toBeGreaterThan(dispatch.lastIndexOf('#endif', at));
        at = dispatch.indexOf(call, at + call.length);
      }
    }
    // The coordinate-carrying send exists only in the acceptance-test build.
    for (const definition of [
      'bool WindowsExplorerAbsoluteMove(',
      'bool WindowsExplorerWheelReachesView(',
      'bool SendWindowsExplorerPointInput(',
    ]) {
      const at = explorer.indexOf(definition);
      expect(at).toBeGreaterThan(0);
      expect(
        explorer.lastIndexOf('#if defined(SPRINT_CODER_WINDOWS_EXPLORER_TEST_HOOKS)', at),
      ).toBeGreaterThan(explorer.lastIndexOf('#endif', at));
    }
  });
});
