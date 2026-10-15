import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Source contracts for classifier v2 C4-2c-2: the macOS preflight asks for an approval (route v2
// only), and an approved dispatch carries its effect. The portable decision is in the harness
// (computer_use_protocol_fuzz.cc), the production bodies run in the macOS seam
// (computer-use-macos-cancel-seam.test.ts, macOS only). What is tied here is where the new code sits:
// a route v1 session takes the v1 path untouched, the measurement happens on the lane without the
// state lock, the offer is made under it, and nothing is attested (so nothing is offered in production).

const nativeDirectory = join(__dirname, '../../computer-use-native');
const macos = readFileSync(join(nativeDirectory, 'computer_use_macos.mm'), 'utf8');
const code = (text: string): string => text.replace(/\/\/.*$/gmu, '');

function between(start: string, end: string): string {
  const from = macos.indexOf(start);
  const to = macos.indexOf(end, from + start.length);
  expect(from, start).toBeGreaterThanOrEqual(0);
  expect(to, end).toBeGreaterThan(from);
  return macos.slice(from, to);
}

const execute = between(
  'void ExecuteNativePreflight(napi_env env, void* data) {',
  'void CompleteNativePreflight(',
);
const apply = between('NativePreflightReceipt ApplyApprovalOffer(', 'void ExecuteNativePreflight(');
const issue = between(
  'NativePreflightReceipt IssueApprovalOffer(',
  'NativePreflightReceipt ApplyApprovalOffer(',
);

describe('preflight approval offer (classifier v2, C4-2c-2)', () => {
  it('runs v1 first, and the approval step only for a session bound to route v2', () => {
    const body = code(execute);
    const v1 = body.indexOf('PerformNativePreflight(work->request, &trace)');
    const gate = body.indexOf('work->request.session->classifier_route == "v2"');
    const step = body.indexOf('ApplyApprovalOffer(work->request, work->owner');
    const ticket = body.indexOf('IssueOrdinaryTicket(work->request, work->owner)');
    expect(v1).toBeGreaterThan(0);
    expect(gate).toBeGreaterThan(v1);
    expect(step).toBeGreaterThan(gate);
    expect(ticket).toBeGreaterThan(step);
    // The step is called from this one place, behind the route check.
    expect(macos.match(/\bApplyApprovalOffer\(/gu)).toHaveLength(2); // definition + the call
    expect(body).toMatch(
      /if \(work->request\.session->classifier_route == "v2"\)\s*work->receipt = ApplyApprovalOffer\(/u,
    );
  });

  it('keeps the v1 preflight as it was: it only records what it read, and reads nothing back', () => {
    const v1 = between(
      'NativePreflightReceipt PerformNativePreflightV1(',
      '// BEGIN effect shadow capture',
    );
    expect(v1.match(/RecordPreflightRisk\(trace, risk\);/gu)).toHaveLength(3);
    expect(code(v1).match(/\btrace\b/gu)?.length).toBe(4); // the parameter + the three records
    expect(v1).not.toMatch(
      /approved_effect|ApplyApprovalOffer|MeasureNativeApproval|classifier_route/u,
    );
    const record = between(
      'void RecordPreflightRisk(',
      'NativePreflightReceipt PerformNativePreflightV1(',
    );
    expect(record).toContain('if (trace == nullptr) return;');
  });

  it('measures on the lane without the state lock, only what v1 passed or paused for confirmation words', () => {
    const body = code(apply);
    expect(body).not.toMatch(/state_mutex|lock_guard|unique_lock|scoped_lock/u);
    const may = body.indexOf('PreflightMayBeMeasured(facts)');
    const measure = body.indexOf('MeasureNativeApproval(request)');
    const decide = body.indexOf('DecidePreflightV2(facts, measured)');
    expect(may).toBeGreaterThan(0);
    expect(measure).toBeGreaterThan(may);
    expect(decide).toBeGreaterThan(measure);
    // The v1 pause is recognised by its own reason code and the recorded bits, nothing else.
    expect(body).toContain('v1_receipt.reason_code == "native_high_impact_user_takeover"');
    // A measurement that needs a person is the existing takeover receipt of the closed table.
    expect(body).toContain('"native_target_unclassified"');
    expect(body).not.toMatch(/single_use_approval|PerformNative(Dispatch|Preflight)\(/u);
  });

  it('offers under the state lock: not canceled, still the owner, a generation left, a valid binding', () => {
    const body = code(issue);
    const lock = body.indexOf('std::lock_guard<std::mutex> state_lock(session.state_mutex);');
    const cancel = body.indexOf('DispatchCancellationStillValid(request)');
    const owner = body.indexOf('session.preflight_owner != owner');
    const generation = body.indexOf(
      'NextNativeApprovalGeneration(session.approval_generation_counter',
    );
    const build = body.indexOf('BuildApprovalIntentBinding(measured, context, &intent)');
    const offer = body.indexOf('session.approval.Offer(token');
    expect(lock).toBeGreaterThan(0);
    for (const [name, index] of Object.entries({ cancel, owner, generation, build, offer }))
      expect(index, name).toBeGreaterThan(lock);
    expect(owner).toBeGreaterThan(cancel);
    expect(build).toBeGreaterThan(generation);
    expect(offer).toBeGreaterThan(build);
    expect(body).toContain('binding::kNativeApprovalWaitMaxNs');
    // The counter moves only after the offer was accepted.
    expect(body.indexOf('session.approval_generation_counter = generation;')).toBeGreaterThan(
      offer,
    );
    // The intent token is a local secret: scrubbed on every path, never put in a receipt.
    expect(body.match(/ScrubNativeTicketString\(&token\)/gu)?.length).toBeGreaterThanOrEqual(5);
    expect(body).not.toMatch(/receipt\.ticket\s*=/u);
    // No ordinary ticket is made for an offer.
    expect(body).not.toMatch(/ordinary_ticket|IssueOrdinaryTicket/u);
    // The offer's words come from the portable header.
    expect(body).toContain(
      'NativePreflightDecisionName(binding::NativePreflightKind::kSingleUseApproval)',
    );
    expect(body).toContain(
      'NativeApprovalRemainingMs(now_ns, now_ns + binding::kNativeApprovalWaitMaxNs)',
    );
  });

  it('adds the version 2 keys to a receipt only for an offer, with the core classifier version', () => {
    const value = between('napi_value PreflightReceiptValue(', 'bool ReadNamedBool(');
    expect(value.match(/"receiptVersion"/gu)).toHaveLength(1);
    const offerBranch = value.slice(value.indexOf('if (offer) {'));
    for (const key of ['receiptVersion', 'approvalGeneration', 'remainingMs', 'effect'])
      expect(offerBranch, key).toContain(`"${key}"`);
    expect(value.slice(0, value.indexOf('if (offer) {'))).not.toMatch(
      /approvalGeneration|remainingMs|"effect"/u,
    );
    expect(value).toContain(
      'offer ? sprint_coder::computer_use::kNativeApprovalOfferClassifierVersion',
    );
    expect(value).toContain(': sprint_coder::computer_use::kNativePreflightClassifierVersion');
    // The closed-receipt check knows the offer, before the refusal table.
    const closed = between(
      'bool NativePreflightReceiptIsClosed(',
      'void SealNativePreflightReceipt(',
    );
    expect(closed.indexOf('NativeApprovalOfferIsClosed(')).toBeGreaterThan(0);
    expect(closed.indexOf('NativeApprovalOfferIsClosed(')).toBeLessThan(
      closed.indexOf('kNativePreflightRefusalTable'),
    );
  });

  it('attests nothing: the measurement still names classifier 1, so a production session is offered nothing', () => {
    const measure = between(
      'MeasureNativeApproval(const NativeDispatchRequest& request) {',
      'NativeApprovalFactsLocked(',
    );
    expect(measure).toContain('classifier_route != "v2"');
    expect(measure).toContain('sprint_coder::computer_use::kNativePreflightClassifierVersion');
    expect(
      readFileSync(join(nativeDirectory, 'computer_use_preflight_classifier.h'), 'utf8'),
    ).toContain('kNativePreflightClassifierVersion = 1;');
  });
});
