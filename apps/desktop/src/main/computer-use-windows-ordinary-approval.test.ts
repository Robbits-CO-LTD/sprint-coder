import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readWindowsHostSource } from '../../../../computer-use-windows-host-source.mjs';

const read = (name: string): string =>
  readFileSync(join(__dirname, '../../computer-use-native', name), 'utf8');

describe('Windows ordinary path excludes approval effects', () => {
  it('closes approval only in the Windows strict verdict after stronger refusals', () => {
    const source = read('computer_use_windows_interlock_capture.h');
    const guard = source.indexOf(
      'const EffectDecision decision = ClassifyEffect(built.facts, ruleset);',
    );
    const ownedChain = source.indexOf('!WindowsCaptureChainOwnedBy(');
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(ownedChain).toBeGreaterThanOrEqual(0);
    expect(guard).toBeGreaterThan(ownedChain);
    const resultReturn = source.indexOf('return result;', guard);
    expect(resultReturn).toBeGreaterThanOrEqual(0);
    const tail = source.slice(guard, resultReturn);
    expect(tail).toContain('result.strict_verdict.outcome == InterlockOutcome::kNone');
    expect(tail).toContain('decision.kind == DecisionKind::kApproval');
    expect(tail).toContain('result.strict_verdict = interlock_detail::Refusal(');
    expect(tail).toContain('InterlockOutcome::kBlocked, InterlockReason::kApprovalClosed');
    expect(tail).not.toMatch(/result\.verdict\s*=/u);
  });

  it('uses that verdict before ordinary ticket issue and before any dispatch input', () => {
    const host = readWindowsHostSource();
    const preflightStart = host.indexOf('bool HandleWindowsPreflight(');
    expect(preflightStart).toBeGreaterThanOrEqual(0);
    const preflight = host.slice(preflightStart);
    const preflightGuard = preflight.indexOf('if (evaluation.Refuses())');
    const ticketIssue = preflight.indexOf('state.slot.Issue(');
    expect(preflightGuard).toBeGreaterThanOrEqual(0);
    expect(ticketIssue).toBeGreaterThanOrEqual(0);
    expect(preflightGuard).toBeLessThan(ticketIssue);
    const dispatchStart = host.indexOf('bool DispatchWindowsAction(');
    expect(dispatchStart).toBeGreaterThanOrEqual(0);
    const dispatch = host.slice(dispatchStart);
    const dispatchGuard = dispatch.indexOf('if (evaluation.Refuses())');
    const inputAttempt = dispatch.indexOf('input_api_attempts->fetch_add(');
    expect(dispatchGuard).toBeGreaterThanOrEqual(0);
    expect(inputAttempt).toBeGreaterThanOrEqual(0);
    expect(dispatchGuard).toBeLessThan(inputAttempt);
    expect(host).toContain('ApplyIncompletePolicy(');
    expect(host).toContain('EvaluateWindowsInterlockOnSource(');
  });

  it('includes behavioral regressions for all four effects and preserved fallback in the native harness', () => {
    const harness = read('computer_use_protocol_fuzz.cc');
    expect(harness).toContain('if (!CheckWindowsOrdinaryApprovalClosed()) return 1;');
    for (const name of [
      'windows-ordinary-approval-positive-classification',
      'windows-ordinary-approval-closed',
      'windows-ordinary-approval-v1-unchanged',
      'windows-ordinary-approval-owned-chain-required',
      'windows-ordinary-approval-ordinary-unchanged',
    ]) {
      expect(harness).toContain(`"${name}"`);
    }
  });
});
