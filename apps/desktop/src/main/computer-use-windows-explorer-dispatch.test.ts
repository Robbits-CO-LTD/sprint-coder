import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const native = (name: string) =>
  readFileSync(join(__dirname, '../../computer-use-native', name), 'utf8');
const input = native('computer_use_windows_host_input.inc');
const explorer = native('computer_use_windows_host_explorer.inc');
const dispatch = input.slice(input.indexOf('bool DispatchWindowsAction('));

describe('Explorer point item measurement boundaries', () => {
  it('rejects zero, overlapping and duplicate-name matches instead of guessing', () => {
    const item = explorer.slice(
      explorer.indexOf('std::optional<WindowsExplorerItem> ReadWindowsExplorerItem('),
      explorer.indexOf('WindowsExplorerShellView ReadWindowsExplorerShellView('),
    );
    expect(item).toContain(
      '!hit_name || !WindowsExplorerUniqueCachedName(cached_names, *hit_name, current)',
    );
    expect(item).toContain('if (hit_name) return std::nullopt;');
    expect(explorer).not.toContain('GetItemPosition(');
    expect(explorer).not.toContain('GetVisibleItem(');
    expect(explorer).not.toContain('WindowsExplorerUniqueVisiblePidl');
    expect(explorer.match(/!WindowsExplorerUnambiguousFolder\(path, current\)/gu)).toHaveLength(1);
    expect(item).not.toContain('WindowsExplorerUnambiguousFolder(candidate, current)');
    expect(item).toContain(
      'hits != 1 || !WindowsExplorerUniqueCachedName(cached_names, *hit_name, current)',
    );
    expect(explorer).toContain('FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM');
    expect(explorer).toContain('FIND_FIRST_EX_LARGE_FETCH');
    expect(item).toContain('static_cast<SHGDNF>(SHGDN_NORMAL)');
    expect(item).toContain('*hit_name != name.value');
    expect(item).toContain('"pidl_display_name"');
    expect(item).toContain('ElementFromPoint(point, at_point.Receive())');
    expect(item).toContain('CompareElements(hit.Get(), at_point.Get(), &same)');
    expect(item).toContain('folder.Get()->ParseDisplayName(');
    expect(item).not.toContain('folder_view->Item(');
    expect(item).toContain('FindAllBuildCache(');
    expect(item).toContain('runtime_id(item.Get()) != initial_id');
    expect(item.indexOf('auto result = WindowsExplorerItemFromPidl')).toBeLessThan(
      item.indexOf('windows_explorer_item_stage_for_test = "uia_final_hit"'),
    );
    expect(item).not.toMatch(/JsonStringField|metadata/u);
  });
  it('explorer_item_replacement_invalidates_evidence', () => {
    expect(explorer).toContain('shell_view.item != evidence->item');
    const harness = native('computer_use_windows_explorer_dispatch_test.cc');
    expect(harness).toContain('blocked("explorer_item_replacement_invalidates_evidence")');
    expect(harness).toContain("m2_item_digest.assign(64, 'b')");
  });
});

describe('Explorer W2 prestart source boundaries', () => {
  const targets = native('computer_use_windows_host_v2_targets.inc');
  it('item 12 keeps a consumed foreground handoff out of background reselection', () => {
    const existing = targets.slice(targets.indexOf('bool StartWindowsExistingSession('));
    expect(existing).toMatch(
      /const bool background = !input\.foreground_handoff && !session\.foreground_handoff_consumed &&/u,
    );
    expect(existing).toContain('if (v2) InvalidateWindowsTicket(input.session_key);');
    expect(existing).toContain('} else if (input.explicit_resume) {');
    expect(existing).toContain(
      'ResolveWindowsExplicitResumeTarget(&session, &refocus_window, reason)',
    );
  });
  const prestart = explorer.slice(
    explorer.indexOf('bool MeasureWindowsExplorerPrestart('),
    explorer.indexOf('// P5 REQUIREMENT (M2)'),
  );
  const section = (from: string, to: string) => {
    const start = targets.indexOf(from);
    const end = targets.indexOf(to, start + from.length);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return targets.slice(start, end);
  };

  it('keeps measurement unreachable when the build gate is off', () => {
    expect(prestart).toMatch(
      /if constexpr \(!sprint_coder::computer_use::kWindowsExplorerException\) \{\s*return false;\s*\} else \{/u,
    );
    const classification = section(
      'WindowsV2VerdictForWindowClass(WindowsV2Judgement',
      '// Judges one window',
    );
    expect(classification).toMatch(
      /if constexpr \(kWindowsExplorerException\) \{[^}]*EnsureWindowsV2Identity\(process\)[^}]*MeasureWindowsExplorerPrestart\(\*process, window, \*explorer_scope\)/u,
    );
    expect(targets.match(/MeasureWindowsExplorerPrestart\(/gu)).toHaveLength(2);
  });

  it('binds session-free measurement without creating M2 evidence', () => {
    expect(prestart.length).toBeGreaterThan(1000);
    expect(prestart).not.toMatch(/FindWindowsSession|explorer_dispatch_evidence|sessions\b/u);
    for (const binding of [
      'scope.generation == 0',
      'scope.epoch, scope.stop_serial',
      'scope.current()',
      'owner == process.measured.pid',
      'start == process.process_start',
      'window_identity(start) == expected_window_identity',
      'ReadWindowsFileIdentity(process.executable.file, &held)',
      'SameWindowsFileIdentity(held, running.identity.file_identity)',
      'WindowsTargetIsVerifiedExplorer(process.measured.facts)',
      'WindowsExplorerPointRefusal(window, view.view, process.measured.pid, point)',
    ])
      expect(prestart).toContain(binding);
    expect(prestart).toContain('if (!bound()) return false;');
    expect(prestart).toContain('return bound();');
    expect(prestart).toContain('ReadWindowsExplorerShellView(window, current)');
    expect(explorer).toContain('ReadWindowsExplorerShellView(session->window, current, &point)');
    expect(prestart).toContain('/*lane_registered=*/true');
  });

  it('uses window and scope only inside the exception gate and resets per-window evidence', () => {
    const classification = section(
      'WindowsV2VerdictForWindowClass(WindowsV2Judgement',
      '// Judges one window',
    );
    const body = classification.slice(classification.indexOf(') {') + 3);
    const gateStart = body.indexOf('  if constexpr (kWindowsExplorerException) {');
    const gateEnd = body.indexOf('  if ((verdict.kind', gateStart);
    expect(gateStart).toBeGreaterThan(0);
    expect(gateEnd).toBeGreaterThan(gateStart);
    expect(body.slice(0, gateStart) + body.slice(gateEnd)).not.toMatch(
      /\b(?:window|explorer_scope)\b/u,
    );
    expect(body.indexOf('process->explorer_prestart_admitted = false;')).toBeLessThan(gateStart);
    expect(body.slice(gateStart, gateEnd)).toMatch(
      /if \(WindowsExplorerFileWindowRestriction\(for_window.facts, measured_view\)\) \{\s*verdict = WindowsExplorerPrestartVerdict\(for_window.facts\);\s*process->explorer_prestart_admitted = verdict.kind == TargetVerdictKind::kUpper;/u,
    );
    const admission = section('bool AdmitWindowsV2StartInContext(', 'bool AdmitWindowsV2Start(');
    expect(admission).toContain('*explorer_admitted = judged.explorer_prestart_admitted;');
    expect(admission).not.toContain('WindowsExplorerFileWindowRestriction(');
  });

  it('keeps default I/O registration unchanged with the Explorer gate off', () => {
    const registration = section(
      'struct WindowsNewStartIoRegistration',
      'bool StartWindowsNewSession(',
    );
    expect(registration).toContain(
      'explicit WindowsNewStartIoRegistration(bool register_thread = true) : registered(register_thread)',
    );
    expect(registration).toContain('if (!register_thread) return;');
    expect(registration).toContain('control.new_start_thread = thread;');
    expect(registration).toContain('if (registered) control.new_start_thread = nullptr;');
    expect(registration).not.toMatch(/kWindowsExplorerException|#if/u);
    for (const [from, to] of [
      ['bool StartWindowsNewSession(', '// BEGIN windows shared existing start'],
      ['bool RunWindowsExistingStartMeasurement(', 'bool StartWindowsExistingSession('],
    ] as const) {
      expect(section(from, to)).toContain('WindowsNewStartIoRegistration cancellation;');
    }
    expect(explorer).toContain('io_(!lane_registered)');
    expect(prestart).toContain('/*lane_registered=*/true');
  });

  it('passes fresh scopes through list, admission, rejudge, and both common refusals', () => {
    expect(targets).toContain('&window_facts, window, &explorer_scope)');
    expect(targets).toContain(
      'JudgeWindowsV2Target(work.pid, work.window, context, &judged, &explorer_scope)',
    );
    expect(targets).toContain(
      'JudgeWindowsV2Target(pid, window, context, &judged, explorer_scope)',
    );
    for (const [from, to, executable] of [
      [
        'bool MeasureWindowsNewStart(',
        'struct WindowsNewStartIoRegistration',
        'process_executable->',
      ],
      [
        'WindowsExistingStartMeasurement MeasureWindowsExistingStartBefore(',
        'WindowsExistingStartMeasurement MeasureWindowsExistingStartAfter(',
        'current_executable.',
      ],
    ] as const) {
      const body = section(from, to);
      expect(body).toContain('bool explorer_admitted = false;');
      expect(body).toContain(
        'if constexpr (sprint_coder::computer_use::kWindowsExplorerException)',
      );
      expect(body).toContain(
        `&explorer_scope, &explorer_admitted, &${executable === 'process_executable->' ? 'measured->' : ''}il_acl_snapshot)`,
      );
      expect(body).toContain(
        `(IsDisallowedTargetExecutable(${executable}identity.path) && !explorer_admitted)`,
      );
    }
  });

  it('preserves other denied classes and refuses missing approval capability', () => {
    const verdict = section('TargetVerdict WindowsExplorerPrestartVerdict(', '// The core');
    expect(verdict).toContain('if (!TargetFactsAreComplete(facts)) return {};');
    expect(verdict).toContain('rule.class_id != "W-SYS"');
    expect(verdict).toContain('AllHold(facts, rule.when)');
    expect(verdict).toMatch(
      /if \(!kWindowsApprovalHandlersEnabled \|\| windows_helper_generation == 0\)\s*return \{TargetVerdictKind::kDenied/u,
    );
    expect(verdict).not.toContain('observe_only');
    const approval = section('bool JudgeWindowsV2Input(', '// The v2 admission');
    expect(approval).toContain(
      'session.maximum_mode == "supervised" && !WindowsApprovalSessionGate(session)',
    );
    expect(approval).toContain('session.approval_revoked = true;');
    expect(approval).toContain('*reason = "native_approval_closed";');
  });

  it('retains the common Explorer denial and V1 discovery rejection', () => {
    const discovery = native('computer_use_windows_host_discovery.inc');
    expect(discovery).not.toContain('kWindowsExplorerException');
    expect(discovery).toContain('L"explorer.exe"');
    expect(discovery).toMatch(
      /context.proxy = IsKnownProxyExecutable\(process_executable.identity.path\) \|\|\s*IsDisallowedTargetExecutable\(\s*process_executable.identity.path\)/u,
    );
    expect(native('computer_use_windows_host_discovery_worker.inc')).not.toContain(
      'kWindowsExplorerException',
    );
  });
});

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
    expect(explorer).toContain('if (kind != "click") return false;');
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
