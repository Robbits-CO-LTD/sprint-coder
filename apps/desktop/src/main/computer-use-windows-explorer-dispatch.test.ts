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
  });
});
