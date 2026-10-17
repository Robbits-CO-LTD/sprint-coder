#include "computer_use_native_binding.h"
#include "computer_use_native_ticket.h"
#include "computer_use_native_approval_ticket.h"
#include "computer_use_native_approval_flow.h"
#include "computer_use_native_eligibility.h"
#include "computer_use_native_identity.h"
#include "computer_use_effect_classifier.h"
#include "computer_use_effect_shadow.h"
#include "computer_use_windows_shadow.h"
#include "computer_use_windows_shadow_reader.h"
#include "computer_use_windows_shadow_scheduler.h"
#include "computer_use_effect_measurement.h"
#include "computer_use_artifact_read_judgement.h"
#include "computer_use_native_interlock.h"
#include "computer_use_native_interlock_capture.h"
#include "computer_use_windows_interlock_capture.h"
#include "computer_use_native_approved_risk.h"
#include "computer_use_native_approval_offer.h"
#include "computer_use_native_refusal_table.h"
#include "computer_use_protocol.h"
#include "computer_use_preflight_classifier.h"

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <functional>
#include <iostream>
#include <limits>
#include <memory>
#include <set>
#include <span>
#include <string>
#include <string_view>
#include <type_traits>
#include <vector>

namespace {

using sprint_coder::computer_use::DecodeFrame;
using sprint_coder::computer_use::EncodeFrame;
using sprint_coder::computer_use::FrameHeader;
using sprint_coder::computer_use::MessageType;
using sprint_coder::computer_use::kMaxBinaryBytes;
using sprint_coder::computer_use::kMaxMetadataBytes;

bool Check(bool condition, const char *code) {
  if (condition)
    return true;
  std::cerr << "computer-use protocol harness failed: " << code << '\n';
  return false;
}

bool CheckNativePreflightClassifier() {
  using namespace sprint_coder::computer_use;
  // Independent fixed truth table, bit order metadata/classified/secure/highimpact.
  constexpr std::array<NativePreflightReason, 16> reasons = {
      NativePreflightReason::kUnclassified, NativePreflightReason::kUnclassified,
      NativePreflightReason::kUnclassified, NativePreflightReason::kNone,
      NativePreflightReason::kUnclassified, NativePreflightReason::kUnclassified,
      NativePreflightReason::kUnclassified, NativePreflightReason::kSecure,
      NativePreflightReason::kUnclassified, NativePreflightReason::kUnclassified,
      NativePreflightReason::kUnclassified, NativePreflightReason::kHighImpact,
      NativePreflightReason::kUnclassified, NativePreflightReason::kUnclassified,
      NativePreflightReason::kUnclassified, NativePreflightReason::kSecure};
  for (std::uint32_t mask = 0; mask < 16; ++mask) {
    const auto decision = ClassifyNativePreflightFacts(
        {(mask & 1) != 0, (mask & 2) != 0, (mask & 4) != 0, (mask & 8) != 0});
    const auto expected_kind = mask == 3 ? NativePreflightKind::kOrdinary
        : mask == 7 || mask == 15 ? NativePreflightKind::kBlocked
                                 : NativePreflightKind::kTakeover;
    if (!Check(decision.classifier_version == 1 &&
                   decision.reason == reasons[mask] &&
                   decision.kind == expected_kind &&
                   NativePreflightAllowsDispatch(decision) == (mask == 3),
               "native-preflight-fact-matrix")) return false;
  }
  // Only the exact supported ordinary/none tuple can dispatch. Reserved
  // approval and contradictory tuples never bypass the native decision gate.
  for (const auto version : {0u, 1u, 2u, UINT32_MAX}) {
    for (const auto kind : {NativePreflightKind::kOrdinary,
                           NativePreflightKind::kSingleUseApproval,
                           NativePreflightKind::kBlocked, NativePreflightKind::kTakeover,
                           static_cast<NativePreflightKind>(255)}) {
      for (const auto reason : {NativePreflightReason::kNone,
                               NativePreflightReason::kUnclassified,
                               NativePreflightReason::kSecure,
                               NativePreflightReason::kHighImpact,
                               static_cast<NativePreflightReason>(255)}) {
        const bool expected = version == 1 && kind == NativePreflightKind::kOrdinary &&
                              reason == NativePreflightReason::kNone;
        if (!Check(NativePreflightAllowsDispatch({kind, reason, version}) == expected,
                   "native-preflight-invalid-authority-tuple")) return false;
      }
    }
  }
  return true;
}

// Owns the strings/containers that a NativeBindingContext only views.
struct BindingContextFixture {
  std::string app_identity = "app";
  std::string window_identity = "window";
  std::string process_generation = "generation";
  std::uint32_t window_id = 2;
  sprint_coder::computer_use::NativeBindingBounds expected_bounds{1, 2, 300, 400};
  std::uint64_t observation_revision = 7;
  std::uint64_t dialog_set_revision = 4;
  std::string dialog_set_digest = "dialogs";
  std::string active_window_identity = "active";
  std::string active_window_kind = "application";
  std::uint32_t active_window_id = 2;
  sprint_coder::computer_use::NativeBindingBounds observation_bounds{1, 2, 300, 400};
  std::string focused_control_signature = "focused";
  bool has_expected_target_signature = true;
  std::string expected_target_signature = "target-signature";
  std::set<std::string> visual_control_signatures{"alpha", "beta"};
  std::vector<std::string> visual_patch_digests{"patch-a", "patch-b"};
  std::string task_id = "task";
  std::string turn_id = "turn";
  std::uint32_t classifier_version = 1;

  sprint_coder::computer_use::NativeBindingContext View() const {
    sprint_coder::computer_use::NativeBindingContext context;
    context.app_identity = app_identity;
    context.window_identity = window_identity;
    context.process_generation = process_generation;
    context.window_id = window_id;
    context.expected_bounds = expected_bounds;
    context.observation_revision = observation_revision;
    context.dialog_set_revision = dialog_set_revision;
    context.dialog_set_digest = dialog_set_digest;
    context.active_window_identity = active_window_identity;
    context.active_window_kind = active_window_kind;
    context.active_window_id = active_window_id;
    context.observation_bounds = observation_bounds;
    context.focused_control_signature = focused_control_signature;
    context.has_expected_target_signature = has_expected_target_signature;
    context.expected_target_signature = expected_target_signature;
    context.visual_control_signatures = &visual_control_signatures;
    context.visual_patch_digests = &visual_patch_digests;
    context.task_id = task_id;
    context.turn_id = turn_id;
    context.classifier_version = classifier_version;
    return context;
  }
};

bool BuildContext(const BindingContextFixture &fixture, std::string *output) {
  return sprint_coder::computer_use::BuildNativeBindingContextInput(fixture.View(), output);
}

sprint_coder::computer_use::NativeBindingPayload BasePayload(std::string_view kind) {
  sprint_coder::computer_use::NativeBindingPayload payload;
  payload.kind = kind;
  payload.target_id = "target";
  payload.text = "text";
  payload.selected_value = "value";
  payload.key = "Enter";
  payload.boolean_value = true;
  payload.x = 0.25;
  payload.y = 0.75;
  payload.delta_x = 3;
  payload.delta_y = -4;
  return payload;
}

bool BuildEnvelope(std::string_view request, std::string_view session, std::string_view action,
                   std::string_view payload, std::string_view context, std::uint64_t cancel,
                   std::uint64_t revision, std::string *output) {
  return sprint_coder::computer_use::BuildNativeBindingEnvelopeInput(
      request, session, action, payload, context, cancel, revision, output);
}

bool CheckNativeBindingWriter() {
  using namespace sprint_coder::computer_use;
  // Length prefixes make adjacent strings unambiguous.
  NativeBindingWriter first("d");
  first.String("ab");
  first.String("c");
  NativeBindingWriter second("d");
  second.String("a");
  second.String("bc");
  NativeBindingWriter same("d");
  same.String("ab");
  same.String("c");
  if (!Check(first.bytes() != second.bytes(), "binding-adjacent-strings") ||
      !Check(first.bytes() == same.bytes(), "binding-deterministic")) return false;
  // Absent is not the same as present-but-empty, and an absent value is never encoded.
  NativeBindingWriter absent("d");
  absent.OptionalString(false, "");
  NativeBindingWriter empty("d");
  empty.OptionalString(true, "");
  NativeBindingWriter ignored("d");
  ignored.OptionalString(false, "ignored");
  if (!Check(absent.bytes() != empty.bytes(), "binding-absent-vs-empty") ||
      !Check(absent.bytes() == ignored.bytes(), "binding-absent-ignores-value")) return false;
  // A count prefix cannot be shifted into a neighbouring field.
  NativeBindingWriter one_list("d");
  one_list.StringList({"a", "b"});
  one_list.String("c");
  NativeBindingWriter shifted("d");
  shifted.StringList({"a"});
  shifted.String("b");
  shifted.String("c");
  NativeBindingWriter empty_list("d");
  empty_list.StringList({});
  NativeBindingWriter missing("d");
  if (!Check(one_list.bytes() != shifted.bytes(), "binding-count-shift") ||
      !Check(empty_list.bytes() != missing.bytes(), "binding-empty-list-vs-missing")) return false;
  // -0 normalizes to +0; non-finite values never encode.
  NativeBindingWriter positive("d");
  positive.Double(0.0);
  NativeBindingWriter negative("d");
  negative.Double(-0.0);
  NativeBindingWriter one("d");
  one.Double(1.0);
  if (!Check(positive.bytes() == negative.bytes() && positive.valid() && negative.valid(),
             "binding-negative-zero") ||
      !Check(positive.bytes() != one.bytes(), "binding-double-distinct")) return false;
  for (const double bad : {std::numeric_limits<double>::quiet_NaN(),
                           std::numeric_limits<double>::infinity(),
                           -std::numeric_limits<double>::infinity()}) {
    NativeBindingWriter writer("d");
    writer.Double(bad);
    NativeBindingPayload payload = BasePayload("click");
    payload.x = bad;
    BindingContextFixture fixture;
    fixture.observation_bounds.width = bad;
    std::string output;
    if (!Check(!writer.valid(), "binding-non-finite-invalid") ||
        !Check(!BuildNativeBindingPayloadInput(payload, &output), "binding-payload-non-finite") ||
        !Check(!BuildContext(fixture, &output), "binding-context-non-finite")) return false;
  }
  return true;
}

bool CheckNativeBindingContext() {
  using namespace sprint_coder::computer_use;
  // set order is deterministic; vector order is preserved.
  BindingContextFixture baseline;
  BindingContextFixture reversed;
  reversed.visual_control_signatures.clear();
  reversed.visual_control_signatures.insert("beta");
  reversed.visual_control_signatures.insert("alpha");
  BindingContextFixture reordered;
  reordered.visual_patch_digests = {"patch-b", "patch-a"};
  std::string base, again, reversed_output, reordered_output;
  if (!Check(BuildContext(baseline, &base) && BuildContext(baseline, &again) &&
                 BuildContext(reversed, &reversed_output) &&
                 BuildContext(reordered, &reordered_output), "binding-context-build") ||
      !Check(base == again, "binding-context-deterministic") ||
      !Check(base == reversed_output, "binding-set-order") ||
      !Check(base != reordered_output, "binding-vector-order")) return false;
  // Changing any single context field changes the output.
  const std::vector<std::function<void(BindingContextFixture &)>> mutations = {
      [](BindingContextFixture &f) { f.app_identity += "x"; },
      [](BindingContextFixture &f) { f.window_identity += "x"; },
      [](BindingContextFixture &f) { f.process_generation += "x"; },
      [](BindingContextFixture &f) { f.window_id += 1; },
      [](BindingContextFixture &f) { f.expected_bounds.x += 1; },
      [](BindingContextFixture &f) { f.expected_bounds.y += 1; },
      [](BindingContextFixture &f) { f.expected_bounds.width += 1; },
      [](BindingContextFixture &f) { f.expected_bounds.height += 1; },
      [](BindingContextFixture &f) { f.observation_revision += 1; },
      [](BindingContextFixture &f) { f.dialog_set_revision += 1; },
      [](BindingContextFixture &f) { f.dialog_set_digest += "x"; },
      [](BindingContextFixture &f) { f.active_window_identity += "x"; },
      [](BindingContextFixture &f) { f.active_window_kind += "x"; },
      [](BindingContextFixture &f) { f.active_window_id += 1; },
      [](BindingContextFixture &f) { f.observation_bounds.x += 1; },
      [](BindingContextFixture &f) { f.observation_bounds.y += 1; },
      [](BindingContextFixture &f) { f.observation_bounds.width += 1; },
      [](BindingContextFixture &f) { f.observation_bounds.height += 1; },
      [](BindingContextFixture &f) { f.focused_control_signature += "x"; },
      [](BindingContextFixture &f) { f.focused_control_signature.clear(); },
      [](BindingContextFixture &f) { f.has_expected_target_signature = false; },
      [](BindingContextFixture &f) { f.expected_target_signature.clear(); },
      [](BindingContextFixture &f) { f.expected_target_signature += "x"; },
      [](BindingContextFixture &f) { f.visual_control_signatures.insert("gamma"); },
      [](BindingContextFixture &f) { f.visual_control_signatures.clear(); },
      [](BindingContextFixture &f) { f.visual_patch_digests.push_back("patch-c"); },
      [](BindingContextFixture &f) { f.visual_patch_digests.clear(); },
      [](BindingContextFixture &f) { f.task_id += "x"; },
      [](BindingContextFixture &f) { f.turn_id += "x"; },
      [](BindingContextFixture &f) { f.classifier_version += 1; },
  };
  for (const auto &mutate : mutations) {
    BindingContextFixture changed;
    mutate(changed);
    std::string output;
    if (!Check(BuildContext(changed, &output) && output != base, "binding-context-field-change"))
      return false;
  }
  // Absent differs from present-but-empty even when the value itself is empty.
  BindingContextFixture absent_target;
  absent_target.has_expected_target_signature = false;
  absent_target.expected_target_signature.clear();
  BindingContextFixture empty_target;
  empty_target.expected_target_signature.clear();
  std::string absent_output, empty_output;
  if (!Check(BuildContext(absent_target, &absent_output) &&
                 BuildContext(empty_target, &empty_output) && absent_output != empty_output,
             "binding-context-absent-vs-empty-target")) return false;
  // Missing containers, missing ids and a missing output fail closed.
  BindingContextFixture no_task;
  no_task.task_id.clear();
  BindingContextFixture no_turn;
  no_turn.turn_id.clear();
  NativeBindingContext null_set = baseline.View();
  null_set.visual_control_signatures = nullptr;
  NativeBindingContext null_vector = baseline.View();
  null_vector.visual_patch_digests = nullptr;
  std::string output;
  return Check(!BuildContext(no_task, &output) && !BuildContext(no_turn, &output) &&
                   !BuildNativeBindingContextInput(null_set, &output) &&
                   !BuildNativeBindingContextInput(null_vector, &output) &&
                   !BuildNativeBindingContextInput(baseline.View(), nullptr),
               "binding-context-fail-closed");
}

bool CheckNativeBindingPayload() {
  using namespace sprint_coder::computer_use;
  // Each payload kind has its own field set; every field a kind uses changes the output.
  std::set<std::string> kinds;
  for (const std::string_view kind : {"invoke", "set_text", "select", "toggle",
                                      "expand_collapse", "click", "scroll", "type", "key"}) {
    std::string base, again;
    if (!Check(BuildNativeBindingPayloadInput(BasePayload(kind), &base) &&
                   BuildNativeBindingPayloadInput(BasePayload(kind), &again) && base == again,
               "binding-payload-deterministic")) return false;
    kinds.insert(base);
    std::vector<std::function<void(NativeBindingPayload &)>> mutations;
    const bool semantic = kind != "click" && kind != "scroll" && kind != "type" && kind != "key";
    if (semantic) mutations.push_back([](NativeBindingPayload &p) { p.target_id = "target2"; });
    if (kind == "set_text" || kind == "type")
      mutations.push_back([](NativeBindingPayload &p) { p.text = "text2"; });
    if (kind == "select")
      mutations.push_back([](NativeBindingPayload &p) { p.selected_value = "value2"; });
    if (kind == "toggle" || kind == "expand_collapse")
      mutations.push_back([](NativeBindingPayload &p) { p.boolean_value = false; });
    if (kind == "key") mutations.push_back([](NativeBindingPayload &p) { p.key = "Tab"; });
    if (kind == "click" || kind == "scroll") {
      mutations.push_back([](NativeBindingPayload &p) { p.x = 0.5; });
      mutations.push_back([](NativeBindingPayload &p) { p.y = 0.5; });
    }
    if (kind == "scroll") {
      mutations.push_back([](NativeBindingPayload &p) { p.delta_x = 5; });
      mutations.push_back([](NativeBindingPayload &p) { p.delta_y = 5; });
    }
    for (const auto &mutate : mutations) {
      NativeBindingPayload changed = BasePayload(kind);
      mutate(changed);
      std::string output;
      if (!Check(BuildNativeBindingPayloadInput(changed, &output) && output != base,
                 "binding-payload-field-change")) return false;
    }
  }
  // Different kinds never collide, and a field a kind does not use does not alter it.
  std::string click, click_other_text;
  NativeBindingPayload other_text = BasePayload("click");
  other_text.text = "different";
  if (!Check(kinds.size() == 9, "binding-payload-kind-distinct") ||
      !Check(BuildNativeBindingPayloadInput(BasePayload("click"), &click) &&
                 BuildNativeBindingPayloadInput(other_text, &click_other_text) &&
                 click == click_other_text, "binding-payload-unused-field")) return false;
  // -0 and +0 coordinates are the same request.
  NativeBindingPayload negative_zero = BasePayload("click");
  negative_zero.x = -0.0;
  NativeBindingPayload positive_zero = BasePayload("click");
  positive_zero.x = 0.0;
  std::string negative_output, positive_output;
  if (!Check(BuildNativeBindingPayloadInput(negative_zero, &negative_output) &&
                 BuildNativeBindingPayloadInput(positive_zero, &positive_output) &&
                 negative_output == positive_output, "binding-payload-negative-zero"))
    return false;
  // Unknown kinds, a missing semantic target and a missing output fail closed.
  std::string output;
  NativeBindingPayload unknown = BasePayload("unknown");
  NativeBindingPayload no_target = BasePayload("invoke");
  no_target.target_id = std::string_view();
  return Check(!BuildNativeBindingPayloadInput(unknown, &output) &&
                   !BuildNativeBindingPayloadInput(no_target, &output) &&
                   !BuildNativeBindingPayloadInput(BasePayload("click"), nullptr),
               "binding-payload-fail-closed");
}

bool CheckNativeBindingEnvelopeAndIds() {
  using namespace sprint_coder::computer_use;
  // The envelope binds each of its fields and requires non-empty digests.
  std::string base;
  if (!Check(BuildEnvelope("r", "s", "a", "p", "c", 1, 2, &base), "binding-envelope-build"))
    return false;
  std::array<std::string, 7> changed;
  if (!Check(BuildEnvelope("r2", "s", "a", "p", "c", 1, 2, &changed[0]) &&
                 BuildEnvelope("r", "s2", "a", "p", "c", 1, 2, &changed[1]) &&
                 BuildEnvelope("r", "s", "a2", "p", "c", 1, 2, &changed[2]) &&
                 BuildEnvelope("r", "s", "a", "p2", "c", 1, 2, &changed[3]) &&
                 BuildEnvelope("r", "s", "a", "p", "c2", 1, 2, &changed[4]) &&
                 BuildEnvelope("r", "s", "a", "p", "c", 2, 2, &changed[5]) &&
                 BuildEnvelope("r", "s", "a", "p", "c", 1, 3, &changed[6]),
             "binding-envelope-build-changed")) return false;
  for (const auto &value : changed)
    if (!Check(value != base, "binding-envelope-field-change")) return false;
  std::string output;
  if (!Check(!BuildEnvelope("", "s", "a", "p", "c", 1, 2, &output) &&
                 !BuildEnvelope("r", "", "a", "p", "c", 1, 2, &output) &&
                 !BuildEnvelope("r", "s", "", "p", "c", 1, 2, &output) &&
                 !BuildEnvelope("r", "s", "a", "", "c", 1, 2, &output) &&
                 !BuildEnvelope("r", "s", "a", "p", "", 1, 2, &output) &&
                 !BuildNativeBindingEnvelopeInput("r", "s", "a", "p", "c", 1, 2, nullptr),
             "binding-envelope-fail-closed")) return false;
  // Adjacent-field boundary shifts stay distinct.
  std::string left, right;
  if (!Check(BuildEnvelope("ab", "c", "a", "p", "c", 1, 2, &left) &&
                 BuildEnvelope("a", "bc", "a", "p", "c", 1, 2, &right) && left != right,
             "binding-envelope-boundary")) return false;
  // Task/Turn validation and comparison.
  const std::string at_limit(kNativeBindingMaxIdBytes, 'a');
  const std::string over_limit(kNativeBindingMaxIdBytes + 1, 'a');
  const std::string with_nul = std::string("a") + '\0' + "b";
  if (!Check(kNativeBindingMaxIdBytes >= 512, "binding-id-limit-covers-contract") ||
      !Check(IsValidNativeBindingId("task") && IsValidNativeBindingId(at_limit),
             "binding-id-valid") ||
      !Check(!IsValidNativeBindingId("") && !IsValidNativeBindingId(over_limit) &&
                 !IsValidNativeBindingId(with_nul), "binding-id-invalid")) return false;
  return Check(NativeBindingIdsMatch("task", "turn", "task", "turn"), "binding-ids-match") &&
         Check(!NativeBindingIdsMatch("task", "turn", "task", "other"), "binding-turn-mismatch") &&
         Check(!NativeBindingIdsMatch("task", "turn", "other", "turn"), "binding-task-mismatch") &&
         Check(!NativeBindingIdsMatch("", "", "", ""), "binding-empty-ids-never-match") &&
         Check(!NativeBindingIdsMatch("task", "turn", "task", ""), "binding-empty-request-turn") &&
         Check(!NativeBindingIdsMatch(over_limit, "turn", over_limit, "turn"),
               "binding-oversized-never-match");
}

bool CheckNativeBinding() {
  return CheckNativeBindingWriter() && CheckNativeBindingContext() &&
         CheckNativeBindingPayload() && CheckNativeBindingEnvelopeAndIds();
}

using sprint_coder::computer_use::IsValidNativeOrdinaryTicketToken;
using sprint_coder::computer_use::NativeOrdinaryTicketBinding;
using sprint_coder::computer_use::NativeOrdinaryTicketSlot;
using sprint_coder::computer_use::NativeOrdinaryTicketTokensEqual;
using sprint_coder::computer_use::ScrubNativeTicketString;
using sprint_coder::computer_use::kNativeOrdinaryTicketMaxTtlNs;
using sprint_coder::computer_use::kNativeOrdinaryTicketTtlNs;

NativeOrdinaryTicketBinding TicketBinding() {
  NativeOrdinaryTicketBinding binding;
  binding.session_id = "session";
  binding.request_id = "request";
  binding.action_digest = "action";
  binding.payload_digest = "payload";
  binding.context_digest = "context";
  binding.cancel_epoch = 7;
  binding.ticket_generation = 5;
  return binding;
}

// Changes exactly one of the seven bound fields.
NativeOrdinaryTicketBinding MutatedTicketBinding(int field) {
  NativeOrdinaryTicketBinding binding = TicketBinding();
  switch (field) {
  case 0: binding.session_id += "x"; break;
  case 1: binding.request_id += "x"; break;
  case 2: binding.action_digest += "x"; break;
  case 3: binding.payload_digest += "x"; break;
  case 4: binding.context_digest += "x"; break;
  case 5: binding.cancel_epoch += 1; break;
  default: binding.ticket_generation += 1; break;
  }
  return binding;
}

bool CheckNativeOrdinaryTicket() {
  constexpr std::uint64_t kNow = 1'000;
  constexpr std::uint64_t kTtl = kNativeOrdinaryTicketTtlNs;
  const std::string token(64, 'a');
  const std::string other_token = std::string(63, 'a') + 'b';

  if (!Check(kNativeOrdinaryTicketMaxTtlNs <= 10'000'000'000ULL && kTtl > 0 &&
                 kTtl <= kNativeOrdinaryTicketMaxTtlNs,
             "ticket-ttl-limit")) return false;

  // Token format and constant-time comparison.
  std::string with_nul = token;
  with_nul[10] = '\0';
  if (!Check(IsValidNativeOrdinaryTicketToken(token) &&
                 IsValidNativeOrdinaryTicketToken("0123456789abcdef0123456789abcdef"
                                                  "0123456789abcdef0123456789abcdef") &&
                 !IsValidNativeOrdinaryTicketToken("") &&
                 !IsValidNativeOrdinaryTicketToken(std::string(63, 'a')) &&
                 !IsValidNativeOrdinaryTicketToken(std::string(65, 'a')) &&
                 !IsValidNativeOrdinaryTicketToken(std::string(64, 'A')) &&
                 !IsValidNativeOrdinaryTicketToken(std::string(64, 'g')) &&
                 !IsValidNativeOrdinaryTicketToken(with_nul),
             "ticket-token-format")) return false;
  std::string first_differs = token;
  first_differs[0] = 'b';
  if (!Check(NativeOrdinaryTicketTokensEqual(token, token) &&
                 !NativeOrdinaryTicketTokensEqual(token, other_token) &&
                 !NativeOrdinaryTicketTokensEqual(token, first_differs) &&
                 !NativeOrdinaryTicketTokensEqual(token, std::string(63, 'a')) &&
                 !NativeOrdinaryTicketTokensEqual(token, std::string(65, 'a')) &&
                 !NativeOrdinaryTicketTokensEqual("", ""),
             "ticket-constant-time-equality")) return false;

  // Single use.
  NativeOrdinaryTicketSlot slot;
  if (!Check(!slot.occupied() && !slot.Consume(token, TicketBinding(), kNow),
             "ticket-empty-slot")) return false;
  if (!Check(slot.Issue(token, TicketBinding(), kNow, kTtl) && slot.occupied() &&
                 slot.generation() == 5,
             "ticket-issue")) return false;
  if (!Check(slot.Consume(token, TicketBinding(), kNow) && !slot.occupied() &&
                 !slot.Consume(token, TicketBinding(), kNow),
             "ticket-single-use")) return false;

  // A new Issue replaces the previous ticket; the replaced one never validates.
  NativeOrdinaryTicketBinding second = TicketBinding();
  second.request_id = "second";
  if (!Check(slot.Issue(token, TicketBinding(), kNow, kTtl) &&
                 slot.Issue(other_token, second, kNow, kTtl) &&
                 !slot.Consume(token, TicketBinding(), kNow),
             "ticket-replaced-never-validates")) return false;
  if (!Check(!slot.occupied(), "ticket-failed-consume-burns")) return false;
  if (!Check(slot.Issue(token, TicketBinding(), kNow, kTtl) &&
                 slot.Issue(other_token, second, kNow, kTtl) &&
                 slot.Consume(other_token, second, kNow),
             "ticket-replacement-consumes")) return false;

  // A failed check destroys the ticket (fail closed), even when a later attempt is correct.
  if (!Check(slot.Issue(token, TicketBinding(), kNow, kTtl) &&
                 !slot.Consume(other_token, TicketBinding(), kNow) && !slot.occupied() &&
                 !slot.Consume(token, TicketBinding(), kNow),
             "ticket-wrong-token-burns")) return false;
  if (!Check(slot.Issue(token, TicketBinding(), kNow, kTtl) &&
                 !slot.Consume("", TicketBinding(), kNow) && !slot.occupied(),
             "ticket-empty-token-burns")) return false;
  if (!Check(slot.Issue(token, TicketBinding(), kNow, kTtl) &&
                 !slot.Consume(std::string(65, 'a'), TicketBinding(), kNow) && !slot.occupied(),
             "ticket-long-token-burns")) return false;

  // TTL, expiry and a clock that goes backwards.
  if (!Check(slot.Issue(token, TicketBinding(), kNow, kTtl) &&
                 slot.Consume(token, TicketBinding(), kNow + kTtl - 1),
             "ticket-valid-before-expiry")) return false;
  if (!Check(slot.Issue(token, TicketBinding(), kNow, kTtl) &&
                 !slot.Consume(token, TicketBinding(), kNow + kTtl) && !slot.occupied(),
             "ticket-expired-at-ttl")) return false;
  if (!Check(slot.Issue(token, TicketBinding(), kNow, kTtl) &&
                 !slot.Consume(token, TicketBinding(), kNow + kTtl + 1),
             "ticket-expired-after-ttl")) return false;
  if (!Check(slot.Issue(token, TicketBinding(), kNow, kTtl) &&
                 !slot.Consume(token, TicketBinding(), kNow - 1) && !slot.occupied(),
             "ticket-clock-backwards")) return false;
  if (!Check(slot.Issue(token, TicketBinding(), 0, kTtl) &&
                 slot.Consume(token, TicketBinding(), 0),
             "ticket-zero-clock-is-a-valid-instant")) return false;

  // TTL bounds and overflow of the expiry computation.
  constexpr std::uint64_t kMax = std::numeric_limits<std::uint64_t>::max();
  if (!Check(!slot.Issue(token, TicketBinding(), kNow, 0) && !slot.occupied() &&
                 !slot.Issue(token, TicketBinding(), kNow, kNativeOrdinaryTicketMaxTtlNs + 1) &&
                 !slot.occupied() &&
                 slot.Issue(token, TicketBinding(), kNow, kNativeOrdinaryTicketMaxTtlNs) &&
                 slot.Consume(token, TicketBinding(), kNow),
             "ticket-ttl-bounds")) return false;
  if (!Check(!slot.Issue(token, TicketBinding(), kMax - kTtl + 1, kTtl) && !slot.occupied() &&
                 !slot.Issue(token, TicketBinding(), kMax, kTtl) && !slot.occupied() &&
                 slot.Issue(token, TicketBinding(), kMax - kTtl, kTtl) &&
                 slot.Consume(token, TicketBinding(), kMax - kTtl),
             "ticket-expiry-overflow")) return false;

  // Every bound field must match exactly.
  for (int field = 0; field < 7; ++field) {
    if (!Check(slot.Issue(token, TicketBinding(), kNow, kTtl) &&
                   !slot.Consume(token, MutatedTicketBinding(field), kNow) && !slot.occupied(),
               "ticket-binding-field-mismatch")) return false;
  }

  // Generation 0 is a sentinel, never issued; a generation only invalidates its own ticket.
  NativeOrdinaryTicketBinding zero_generation = TicketBinding();
  zero_generation.ticket_generation = 0;
  if (!Check(!slot.Issue(token, zero_generation, kNow, kTtl) && !slot.occupied() &&
                 slot.generation() == 0,
             "ticket-generation-zero-never-issued")) return false;
  if (!Check(slot.Issue(token, TicketBinding(), kNow, kTtl) && !slot.InvalidateIfGeneration(0) &&
                 !slot.InvalidateIfGeneration(4) && !slot.InvalidateIfGeneration(6) && slot.occupied() &&
                 slot.InvalidateIfGeneration(5) && !slot.occupied() &&
                 !slot.InvalidateIfGeneration(5),
             "ticket-invalidate-only-own-generation")) return false;
  if (!Check(slot.Issue(token, TicketBinding(), kNow, kTtl) && slot.occupied(),
             "ticket-issue-again")) return false;
  slot.Invalidate();
  if (!Check(!slot.occupied() && !slot.Consume(token, TicketBinding(), kNow), "ticket-invalidate")) return false;

  // Issue failures leave nothing behind, and each required binding string is mandatory.
  if (!Check(slot.Issue(token, TicketBinding(), kNow, kTtl) &&
                 !slot.Issue("not-hex", TicketBinding(), kNow, kTtl) && !slot.occupied(),
             "ticket-failed-issue-clears-previous")) return false;
  for (int field = 0; field < 5; ++field) {
    NativeOrdinaryTicketBinding empty_field = TicketBinding();
    switch (field) {
    case 0: empty_field.session_id.clear(); break;
    case 1: empty_field.request_id.clear(); break;
    case 2: empty_field.action_digest.clear(); break;
    case 3: empty_field.payload_digest.clear(); break;
    default: empty_field.context_digest.clear(); break;
    }
    if (!Check(!slot.Issue(token, empty_field, kNow, kTtl) && !slot.occupied(),
               "ticket-binding-string-required")) return false;
  }

  // The scrub helper empties a secret and tolerates a null pointer.
  std::string secret = token;
  ScrubNativeTicketString(&secret);
  ScrubNativeTicketString(nullptr);
  return Check(secret.empty(), "ticket-scrub");
}


using sprint_coder::computer_use::NativeApprovalEffect;
using sprint_coder::computer_use::NativeApprovalIntentBinding;
using sprint_coder::computer_use::NativeApprovalExecutionBinding;
using sprint_coder::computer_use::NativeApprovalTicketSlot;
using sprint_coder::computer_use::kNativeApprovalWaitMaxNs;
using sprint_coder::computer_use::kNativeApprovalExecutionTtlNs;

NativeApprovalIntentBinding ApprovalIntentBinding() {
  NativeApprovalIntentBinding binding;
  binding.session_id = "session";
  binding.task_id = "task";
  binding.turn_id = "turn";
  binding.approval_request_id = "original-request";
  binding.action_digest = std::string(64, 'a');
  binding.payload_digest = std::string(64, 'b');
  binding.authority_digest = std::string(64, 'c');
  binding.cancel_epoch = 3;
  binding.approval_generation = 7;
  binding.observation_revision = 10;
  binding.ticket_generation = 12;
  binding.classifier_version = 2;
  binding.ruleset_version = 1;
  binding.lexicon_version = 1;
  binding.effect = NativeApprovalEffect::kFileManagerOpen;
  return binding;
}

NativeApprovalExecutionBinding ApprovalExecutionBinding() {
  return {ApprovalIntentBinding(), "fresh-request", std::string(64, 'd'), 11, 13};
}

NativeApprovalIntentBinding MutatedApprovalIntent(int field) {
  auto binding = ApprovalIntentBinding();
  switch (field) {
  case 0: binding.session_id += "x"; break;
  case 1: binding.task_id += "x"; break;
  case 2: binding.turn_id += "x"; break;
  case 3: binding.approval_request_id += "x"; break;
  case 4: binding.action_digest[0] = 'f'; break;
  case 5: binding.payload_digest[0] = 'f'; break;
  case 6: binding.authority_digest[0] = 'f'; break;
  case 7: binding.cancel_epoch += 1; break;
  case 8: binding.approval_generation += 1; break;
  case 9: binding.observation_revision += 1; break;
  case 10: binding.ticket_generation += 1; break;
  case 11: binding.classifier_version += 1; break;
  case 12: binding.ruleset_version += 1; break;
  case 13: binding.lexicon_version += 1; break;
  default: binding.effect = NativeApprovalEffect::kDownloadOpen; break;
  }
  return binding;
}

bool CheckNativeApprovalTicket() {
  constexpr std::uint64_t kNow = 100;
  constexpr std::uint64_t kApproved = kNow + 20;
  constexpr std::uint64_t kMax = std::numeric_limits<std::uint64_t>::max();
  const std::string intent_token(64, 'e');
  const std::string execution_token(64, 'f');
  NativeApprovalTicketSlot slot;
  static_assert(!std::is_copy_constructible_v<NativeApprovalTicketSlot>);
  static_assert(!std::is_move_constructible_v<NativeApprovalTicketSlot>);
  static_assert(!std::is_convertible_v<NativeApprovalExecutionBinding,
                                       NativeOrdinaryTicketBinding>);
  const auto begin = [&] {
    return slot.Begin(intent_token, ApprovalIntentBinding(), kNow,
                      kNativeApprovalWaitMaxNs);
  };
  const auto approve = [&] {
    return slot.Approve(intent_token, ApprovalIntentBinding(),
                        ApprovalExecutionBinding(), execution_token, kApproved);
  };
  const auto ready = [&] { return begin() && approve(); };
  if (!Check(kNativeApprovalWaitMaxNs == 60'000'000'000ULL &&
                 kNativeApprovalExecutionTtlNs == 5'000'000'000ULL &&
                 !slot.occupied() && !approve() && !slot.occupied() &&
                 !slot.Consume(execution_token, ApprovalExecutionBinding(), kApproved),
             "approval-empty-and-bounds")) return false;
  if (!Check(begin() && slot.pending() && !slot.ready() &&
                 slot.approval_generation() == 7 && slot.ticket_generation() == 0 &&
                 approve() && slot.ready() && !slot.pending() &&
                 slot.ticket_generation() == 13 &&
                 slot.Consume(execution_token, ApprovalExecutionBinding(), kApproved) &&
                 !slot.occupied() &&
                 !slot.Consume(execution_token, ApprovalExecutionBinding(), kApproved),
             "approval-begin-approve-consume-once")) return false;
  if (!Check(begin() && !slot.Consume(intent_token, ApprovalExecutionBinding(), kNow) &&
                 slot.pending() && approve() &&
                 !slot.Consume(intent_token, ApprovalExecutionBinding(), kApproved) &&
                 !slot.occupied(), "approval-intent-is-not-execution")) return false;
  if (!Check(begin() && !slot.Approve(intent_token, ApprovalIntentBinding(),
                                    ApprovalExecutionBinding(), intent_token, kApproved) &&
                 !slot.occupied(), "approval-token-rotation-required")) return false;
  if (!Check(begin() && !slot.Approve(execution_token, ApprovalIntentBinding(),
                                    ApprovalExecutionBinding(), execution_token, kApproved) &&
                 !slot.occupied(), "approval-wrong-token-burns")) return false;

  if (!Check(ready() && !approve() && slot.ready() &&
                 slot.Consume(execution_token, ApprovalExecutionBinding(), kApproved),
             "approval-duplicate-completion-preserves-ready")) return false;

  // Every original authority field and fresh execution field is independently bound.
  for (int field = 0; field < 15; ++field) {
    if (!Check(begin() &&
                   !slot.Approve(intent_token, MutatedApprovalIntent(field),
                                 ApprovalExecutionBinding(), execution_token, kApproved) &&
                   slot.occupied() == (field == 8), "approval-intent-binding-changed")) return false;
    auto fresh = ApprovalExecutionBinding();
    fresh.intent = MutatedApprovalIntent(field);
    if (!Check(begin() && !slot.Approve(intent_token, ApprovalIntentBinding(), fresh,
                                      execution_token, kApproved) && !slot.occupied(),
               "approval-fresh-authority-changed")) return false;
    if (!Check(ready() && !slot.Consume(execution_token, fresh, kApproved) &&
                   slot.occupied() == (field == 8), "approval-consume-authority-changed")) return false;
  }
  for (int field = 0; field < 4; ++field) {
    auto changed = ApprovalExecutionBinding();
    switch (field) {
    case 0: changed.request_id += "x"; break;
    case 1: changed.context_digest[0] = 'a'; break;
    case 2: changed.observation_revision += 1; break;
    default: changed.ticket_generation += 1; break;
    }
    if (!Check(ready() && !slot.Consume(execution_token, changed, kApproved) &&
                   slot.occupied() == (field == 3), "approval-execution-binding-changed")) return false;
  }
  for (int field = 0; field < 6; ++field) {
    auto stale = ApprovalExecutionBinding();
    switch (field) {
    case 0: stale.request_id = stale.intent.approval_request_id; break;
    case 1: stale.observation_revision = stale.intent.observation_revision; break;
    case 2: stale.ticket_generation = stale.intent.ticket_generation; break;
    case 3: stale.observation_revision = 0; break;
    case 4: stale.ticket_generation = 0; break;
    default: stale.context_digest = "not-a-native-digest"; break;
    }
    if (!Check(begin() && !slot.Approve(intent_token, ApprovalIntentBinding(), stale,
                                      execution_token, kApproved) && !slot.occupied(),
               "approval-requires-fresh-observation-and-request")) return false;
  }

  // Expires at the boundary; a late approval never extends the waiting deadline.
  if (!Check(begin() && !slot.Approve(intent_token, ApprovalIntentBinding(),
                                    ApprovalExecutionBinding(), execution_token, kNow - 1) &&
                 !slot.occupied() && begin() &&
                 !slot.Approve(intent_token, ApprovalIntentBinding(), ApprovalExecutionBinding(),
                               execution_token, kNow + kNativeApprovalWaitMaxNs) &&
                 !slot.occupied(), "approval-wait-clock-and-expiry")) return false;
  if (!Check(ready() && slot.Consume(execution_token, ApprovalExecutionBinding(),
                                    kApproved + kNativeApprovalExecutionTtlNs - 1) &&
                 ready() && !slot.Consume(execution_token, ApprovalExecutionBinding(),
                                         kApproved + kNativeApprovalExecutionTtlNs) &&
                 !slot.occupied() && ready() &&
                 !slot.Consume(execution_token, ApprovalExecutionBinding(), kApproved - 1),
             "approval-execution-clock-and-expiry")) return false;
  if (!Check(slot.Begin(intent_token, ApprovalIntentBinding(), kNow, 30) && approve() &&
                 !slot.Consume(execution_token, ApprovalExecutionBinding(), kNow + 30),
             "approval-wait-deadline-also-bounds-ready")) return false;
  if (!Check(!slot.Begin(intent_token, ApprovalIntentBinding(), kNow, 0) &&
                 !slot.Begin(intent_token, ApprovalIntentBinding(), kNow,
                             kNativeApprovalWaitMaxNs + 1) &&
                 !slot.Begin(intent_token, ApprovalIntentBinding(), kMax - 9, 10) &&
                 !slot.occupied(), "approval-wait-overflow-and-ttl")) return false;
  if (!Check(slot.Begin(intent_token, ApprovalIntentBinding(), kMax - 9, 9) &&
                 !slot.Approve(intent_token, ApprovalIntentBinding(), ApprovalExecutionBinding(),
                               execution_token, kMax - 8) && !slot.occupied(),
             "approval-ready-expiry-overflow")) return false;

  // Unknown/legacy classification, missing bindings and zero generation never grant authority.
  for (int field = 0; field < 15; ++field) {
    auto invalid = ApprovalIntentBinding();
    switch (field) {
    case 0: invalid.session_id.clear(); break;
    case 1: invalid.task_id.clear(); break;
    case 2: invalid.turn_id.clear(); break;
    case 3: invalid.approval_request_id.clear(); break;
    case 4: invalid.action_digest.clear(); break;
    case 5: invalid.payload_digest.clear(); break;
    case 6: invalid.authority_digest.clear(); break;
    case 7: invalid.approval_generation = 0; break;
    case 8: invalid.observation_revision = 0; break;
    case 9: invalid.ticket_generation = 0; break;
    case 10: invalid.classifier_version = 1; break;
    case 11: invalid.ruleset_version = 0; break;
    case 12: invalid.lexicon_version = 0; break;
    case 13: invalid.effect = NativeApprovalEffect::kInvalid; break;
    default: invalid.task_id = std::string(513, 'x'); break;
    }
    if (!Check(ready() && !slot.Begin(intent_token, invalid, kNow,
                                    kNativeApprovalWaitMaxNs) && !slot.occupied(),
               "approval-invalid-begin-clears-previous")) return false;
  }
  for (const auto effect : {NativeApprovalEffect::kDownloadOpen,
                           NativeApprovalEffect::kFileManagerOpen,
                           NativeApprovalEffect::kHighImpactConfirmation,
                           NativeApprovalEffect::kSupervisedAction}) {
    auto binding = ApprovalIntentBinding();
    binding.effect = effect;
    auto fresh = ApprovalExecutionBinding();
    fresh.intent = binding;
    if (!Check(slot.Begin(intent_token, binding, kNow, kNativeApprovalWaitMaxNs) &&
                   slot.Approve(intent_token, binding, fresh, execution_token, kApproved) &&
                   slot.Consume(execution_token, fresh, kApproved),
               "approval-supported-effect")) return false;
  }
  auto unknown = ApprovalIntentBinding();
  unknown.effect = static_cast<NativeApprovalEffect>(255);
  if (!Check(!slot.Begin(intent_token, unknown, kNow, kNativeApprovalWaitMaxNs),
             "approval-unknown-effect-denied")) return false;

  // Late owners cannot invalidate a replacement. Explicit Stop/close burns every stage.
  if (!Check(begin() && !slot.InvalidateIfApprovalGeneration(0) &&
                 !slot.InvalidateIfApprovalGeneration(6) && slot.pending() &&
                 slot.InvalidateIfApprovalGeneration(7) && !slot.occupied() && ready() &&
                 !slot.InvalidateIfTicketGeneration(12) && slot.ready() &&
                 slot.InvalidateIfTicketGeneration(13) && !slot.occupied(),
             "approval-owner-scoped-invalidation")) return false;
  auto replacement = ApprovalIntentBinding();
  replacement.approval_generation = 8;
  if (!Check(begin() && slot.Begin(execution_token, replacement, kNow,
                                  kNativeApprovalWaitMaxNs) &&
                 !slot.InvalidateIfApprovalGeneration(7) && slot.pending() &&
                 !slot.Approve(intent_token, ApprovalIntentBinding(),
                               ApprovalExecutionBinding(), execution_token, kApproved) &&
                 slot.pending(),
             "approval-old-owner-cannot-clear-new-intent")) return false;
  slot.Invalidate();
  if (!Check(!slot.occupied() && !approve() && ready(), "approval-stop-clears-intent")) return false;
  slot.Invalidate();
  if (!Check(!slot.Consume(execution_token, ApprovalExecutionBinding(), kApproved),
             "approval-close-clears-ready")) return false;
  NativeOrdinaryTicketSlot ordinary;
  if (!Check(ordinary.Issue(std::string(64, '0'), TicketBinding(), kNow,
                           kNativeOrdinaryTicketTtlNs) && ready() &&
                 !slot.Consume(std::string(64, '0'), ApprovalExecutionBinding(), kApproved) &&
                 !ordinary.Consume(execution_token, TicketBinding(), kApproved),
             "approval-ordinary-tokens-cannot-be-exchanged")) return false;
  return true;
}

FrameHeader ValidHeader() {
  FrameHeader header{};
  header.message_type = static_cast<std::uint16_t>(MessageType::kObserveResult);
  header.request_id.bytes[0] = 1;
  header.session_id.bytes[0] = 2;
  return header;
}

std::uint32_t Next(std::uint32_t *state) {
  std::uint32_t value = *state;
  value ^= value << 13;
  value ^= value >> 17;
  value ^= value << 5;
  *state = value;
  return value;
}

} // namespace

using sprint_coder::computer_use::NativeApprovalFacts;
using sprint_coder::computer_use::NativeApprovalFailure;
using sprint_coder::computer_use::NativeApprovalFlow;
using sprint_coder::computer_use::NativeApprovalMeasurement;
using sprint_coder::computer_use::NativeApprovalDenialFor;
using sprint_coder::computer_use::kNativeApprovalClassifierVersion;

NativeApprovalFacts FlowFacts() {
  NativeApprovalFacts facts;
  facts.session_id = "session";
  facts.task_id = "task";
  facts.turn_id = "turn";
  facts.request_id = "fresh-request";
  facts.context_digest = std::string(64, 'd');
  facts.action_digest = std::string(64, 'a');
  facts.payload_digest = std::string(64, 'b');
  facts.cancel_epoch = 3;
  facts.current_cancel_epoch = 3;
  facts.approval_generation = 7;
  facts.observation_revision = 11;
  facts.ticket_generation = 13;
  return facts;
}

NativeApprovalMeasurement FlowMeasured() {
  NativeApprovalMeasurement measured;
  measured.eligible = true;
  measured.effect = NativeApprovalEffect::kFileManagerOpen;
  measured.authority_digest = std::string(64, 'c');
  measured.classifier_version = 2;
  measured.ruleset_version = 1;
  measured.lexicon_version = 1;
  return measured;
}

struct FlowCase {
  const char *name;
  void (*mutate)(NativeApprovalFacts *, NativeApprovalMeasurement *, std::uint64_t *);
  NativeApprovalFailure expected;
};

bool CheckNativeApprovalFlow() {
  constexpr std::uint64_t kNow = 100;
  constexpr std::uint64_t kApproved = kNow + 20;
  const std::string intent_token(64, 'e');
  const std::string execution_token(64, 'f');
  NativeApprovalFlow flow;
  const auto offer = [&] {
    return flow.Offer(intent_token, ApprovalIntentBinding(), kNow, kNativeApprovalWaitMaxNs);
  };

  // A production native never offers: nothing is pending, so every call fails closed and nothing
  // ever begins an intent on its own.
  if (!Check(kNativeApprovalClassifierVersion == 2 && !flow.occupied(), "flow-constants"))
    return false;
  {
    const auto approve = flow.Approve(FlowFacts(), FlowMeasured(), execution_token, kApproved);
    const auto consume = flow.ConsumeApproved(FlowFacts(), FlowMeasured(), kApproved);
    if (!Check(!approve.ok && approve.failure == NativeApprovalFailure::kUnavailable &&
                   !consume.ok && consume.failure == NativeApprovalFailure::kUnavailable &&
                   !flow.Discard(7) && !flow.occupied() && !flow.pending(),
               "flow-empty-fails-closed")) return false;
  }

  // Offer -> Approve -> ConsumeApproved, once.
  if (!Check(offer() && flow.pending() && flow.approval_generation() == 7, "flow-offer"))
    return false;
  if (!Check(flow.Approve(FlowFacts(), FlowMeasured(), execution_token, kApproved).ok &&
                 flow.ready() && !flow.pending(), "flow-approve")) return false;
  // The fresh classification is still approval-eligible (it is the very action that was approved):
  // that alone is not a refusal. It matches the bound ticket, so it consumes once and begins no
  // new intent.
  if (!Check(flow.ConsumeApproved(FlowFacts(), FlowMeasured(), kApproved).ok &&
                 !flow.occupied() && !flow.pending(), "flow-consume-once")) return false;
  {
    const auto again = flow.ConsumeApproved(FlowFacts(), FlowMeasured(), kApproved);
    if (!Check(!again.ok && again.failure == NativeApprovalFailure::kUnavailable &&
                   !flow.occupied(), "flow-consume-twice")) return false;
  }

  // A generation that does not match changes nothing; the matching one is discarded.
  {
    auto wrong = FlowFacts();
    wrong.approval_generation = 8;
    if (!Check(offer(), "flow-offer-2")) return false;
    const auto result = flow.Approve(wrong, FlowMeasured(), execution_token, kApproved);
    if (!Check(!result.ok && result.failure == NativeApprovalFailure::kUnavailable &&
                   flow.pending() && !flow.Discard(8) && flow.pending() && flow.Discard(7) &&
                   !flow.occupied() && !flow.Discard(7), "flow-generation-mismatch"))
      return false;
    wrong.approval_generation = 0;
    if (!Check(offer() && !flow.Approve(wrong, FlowMeasured(), execution_token, kApproved).ok &&
                   flow.pending() && !flow.Discard(0), "flow-generation-zero")) return false;
    flow.Invalidate();
  }

  // Every failed approve attempt on the matching generation burns the slot and fails closed.
  {
    const FlowCase cases[] = {
        {"closed", [](NativeApprovalFacts *f, NativeApprovalMeasurement *, std::uint64_t *) { f->session_closed = true; }, NativeApprovalFailure::kCanceled},
        {"cancel-epoch", [](NativeApprovalFacts *f, NativeApprovalMeasurement *, std::uint64_t *) { f->current_cancel_epoch = 4; }, NativeApprovalFailure::kCanceled},
        {"expired-at-deadline", [](NativeApprovalFacts *, NativeApprovalMeasurement *, std::uint64_t *now) { *now = 100 + kNativeApprovalWaitMaxNs; }, NativeApprovalFailure::kExpired},
        {"clock-backwards", [](NativeApprovalFacts *, NativeApprovalMeasurement *, std::uint64_t *now) { *now = 50; }, NativeApprovalFailure::kRevalidationFailed},
        {"takeover", [](NativeApprovalFacts *, NativeApprovalMeasurement *m, std::uint64_t *) { m->takeover = true; }, NativeApprovalFailure::kTakeover},
        {"no-longer-eligible", [](NativeApprovalFacts *, NativeApprovalMeasurement *m, std::uint64_t *) { m->eligible = false; }, NativeApprovalFailure::kRevalidationFailed},
        {"authority", [](NativeApprovalFacts *, NativeApprovalMeasurement *m, std::uint64_t *) { m->authority_digest[0] = 'f'; }, NativeApprovalFailure::kRevalidationFailed},
        {"effect", [](NativeApprovalFacts *, NativeApprovalMeasurement *m, std::uint64_t *) { m->effect = NativeApprovalEffect::kDownloadOpen; }, NativeApprovalFailure::kRevalidationFailed},
        {"classifier-v1", [](NativeApprovalFacts *, NativeApprovalMeasurement *m, std::uint64_t *) { m->classifier_version = 1; }, NativeApprovalFailure::kRevalidationFailed},
        {"ruleset", [](NativeApprovalFacts *, NativeApprovalMeasurement *m, std::uint64_t *) { m->ruleset_version = 2; }, NativeApprovalFailure::kRevalidationFailed},
        {"lexicon", [](NativeApprovalFacts *, NativeApprovalMeasurement *m, std::uint64_t *) { m->lexicon_version = 2; }, NativeApprovalFailure::kRevalidationFailed},
        {"action", [](NativeApprovalFacts *f, NativeApprovalMeasurement *, std::uint64_t *) { f->action_digest[0] = 'f'; }, NativeApprovalFailure::kRevalidationFailed},
        {"payload", [](NativeApprovalFacts *f, NativeApprovalMeasurement *, std::uint64_t *) { f->payload_digest[0] = 'f'; }, NativeApprovalFailure::kRevalidationFailed},
        {"session", [](NativeApprovalFacts *f, NativeApprovalMeasurement *, std::uint64_t *) { f->session_id = "other"; }, NativeApprovalFailure::kRevalidationFailed},
        {"task", [](NativeApprovalFacts *f, NativeApprovalMeasurement *, std::uint64_t *) { f->task_id = "other"; }, NativeApprovalFailure::kRevalidationFailed},
        {"turn", [](NativeApprovalFacts *f, NativeApprovalMeasurement *, std::uint64_t *) { f->turn_id = "other"; }, NativeApprovalFailure::kRevalidationFailed},
        {"same-request-id", [](NativeApprovalFacts *f, NativeApprovalMeasurement *, std::uint64_t *) { f->request_id = "original-request"; }, NativeApprovalFailure::kRevalidationFailed},
        {"observation-not-advanced", [](NativeApprovalFacts *f, NativeApprovalMeasurement *, std::uint64_t *) { f->observation_revision = 10; }, NativeApprovalFailure::kRevalidationFailed},
        {"ticket-generation-not-advanced", [](NativeApprovalFacts *f, NativeApprovalMeasurement *, std::uint64_t *) { f->ticket_generation = 12; }, NativeApprovalFailure::kRevalidationFailed},
        {"context-digest-invalid", [](NativeApprovalFacts *f, NativeApprovalMeasurement *, std::uint64_t *) { f->context_digest = "short"; }, NativeApprovalFailure::kRevalidationFailed},
    };
    for (const FlowCase &c : cases) {
      auto facts = FlowFacts();
      auto measured = FlowMeasured();
      std::uint64_t now = kApproved;
      c.mutate(&facts, &measured, &now);
      if (!Check(offer(), "flow-approve-case-offer")) return false;
      const auto result = flow.Approve(facts, measured, execution_token, now);
      if (!Check(!result.ok && result.failure == c.expected && !flow.occupied(), c.name))
        return false;
    }
    // The execution token must differ from the waiting one, and be a well-formed secret.
    if (!Check(offer() && !flow.Approve(FlowFacts(), FlowMeasured(), intent_token, kApproved).ok &&
                   !flow.occupied(), "flow-token-rotation")) return false;
    if (!Check(offer() && !flow.Approve(FlowFacts(), FlowMeasured(), "short", kApproved).ok &&
                   !flow.occupied(), "flow-token-shape")) return false;
  }

  // Every failed consume burns the ready slot, and none of them begins a new intent.
  {
    const FlowCase cases[] = {
        {"closed", [](NativeApprovalFacts *f, NativeApprovalMeasurement *, std::uint64_t *) { f->session_closed = true; }, NativeApprovalFailure::kCanceled},
        {"cancel-epoch", [](NativeApprovalFacts *f, NativeApprovalMeasurement *, std::uint64_t *) { f->current_cancel_epoch = 4; }, NativeApprovalFailure::kCanceled},
        {"execution-expired", [](NativeApprovalFacts *, NativeApprovalMeasurement *, std::uint64_t *now) { *now = 120 + kNativeApprovalExecutionTtlNs; }, NativeApprovalFailure::kExpired},
        {"takeover", [](NativeApprovalFacts *, NativeApprovalMeasurement *m, std::uint64_t *) { m->takeover = true; }, NativeApprovalFailure::kTakeover},
        {"reclassified-not-approvable", [](NativeApprovalFacts *, NativeApprovalMeasurement *m, std::uint64_t *) { m->eligible = false; }, NativeApprovalFailure::kRevalidationFailed},
        {"authority", [](NativeApprovalFacts *, NativeApprovalMeasurement *m, std::uint64_t *) { m->authority_digest[0] = 'f'; }, NativeApprovalFailure::kRevalidationFailed},
        {"effect", [](NativeApprovalFacts *, NativeApprovalMeasurement *m, std::uint64_t *) { m->effect = NativeApprovalEffect::kSupervisedAction; }, NativeApprovalFailure::kRevalidationFailed},
        {"different-request-id", [](NativeApprovalFacts *f, NativeApprovalMeasurement *, std::uint64_t *) { f->request_id = "another-request"; }, NativeApprovalFailure::kRevalidationFailed},
        {"context-changed", [](NativeApprovalFacts *f, NativeApprovalMeasurement *, std::uint64_t *) { f->context_digest[0] = 'f'; }, NativeApprovalFailure::kRevalidationFailed},
        {"observed-again", [](NativeApprovalFacts *f, NativeApprovalMeasurement *, std::uint64_t *) { f->ticket_generation = 14; }, NativeApprovalFailure::kRevalidationFailed},
        {"observation-revision", [](NativeApprovalFacts *f, NativeApprovalMeasurement *, std::uint64_t *) { f->observation_revision = 12; }, NativeApprovalFailure::kRevalidationFailed},
        {"action", [](NativeApprovalFacts *f, NativeApprovalMeasurement *, std::uint64_t *) { f->action_digest[0] = 'f'; }, NativeApprovalFailure::kRevalidationFailed},
    };
    for (const FlowCase &c : cases) {
      if (!Check(offer() &&
                     flow.Approve(FlowFacts(), FlowMeasured(), execution_token, kApproved).ok &&
                     flow.ready(), "flow-consume-case-ready")) return false;
      auto facts = FlowFacts();
      auto measured = FlowMeasured();
      std::uint64_t now = kApproved;
      c.mutate(&facts, &measured, &now);
      const auto result = flow.ConsumeApproved(facts, measured, now);
      if (!Check(!result.ok && result.failure == c.expected && !flow.occupied() &&
                     !flow.pending(), c.name)) return false;
    }
    // The last instant of the execution window still consumes.
    if (!Check(offer() &&
                   flow.Approve(FlowFacts(), FlowMeasured(), execution_token, kApproved).ok &&
                   flow.ConsumeApproved(FlowFacts(), FlowMeasured(),
                                        kApproved + kNativeApprovalExecutionTtlNs - 1).ok &&
                   !flow.occupied(), "flow-consume-last-instant")) return false;
    // A generation that does not match changes nothing, even on a ready slot.
    auto wrong = FlowFacts();
    wrong.approval_generation = 9;
    if (!Check(offer() &&
                   flow.Approve(FlowFacts(), FlowMeasured(), execution_token, kApproved).ok &&
                   !flow.ConsumeApproved(wrong, FlowMeasured(), kApproved).ok && flow.ready() &&
                   !flow.Discard(9) && flow.ready() && flow.Discard(7) && !flow.occupied(),
               "flow-consume-generation-mismatch")) return false;
  }

  // Approve cannot be applied to a ready slot, a replacement offer ends the old one, and cancel /
  // close end either stage.
  if (!Check(offer() &&
                 flow.Approve(FlowFacts(), FlowMeasured(), execution_token, kApproved).ok &&
                 !flow.Approve(FlowFacts(), FlowMeasured(), execution_token, kApproved).ok &&
                 flow.ready(), "flow-approve-not-twice")) return false;
  flow.Invalidate();
  {
    auto next = ApprovalIntentBinding();
    next.approval_generation = 9;
    if (!Check(offer() && flow.Offer(intent_token, next, kNow, kNativeApprovalWaitMaxNs) &&
                   flow.approval_generation() == 9 && !flow.Discard(7) && flow.pending(),
               "flow-offer-replaces")) return false;
    flow.Invalidate();
    if (!Check(!flow.occupied() && offer(), "flow-invalidate-pending")) return false;
    flow.Invalidate();
    if (!Check(offer() &&
                   flow.Approve(FlowFacts(), FlowMeasured(), execution_token, kApproved).ok,
               "flow-invalidate-ready-setup")) return false;
    flow.Invalidate();
    if (!Check(!flow.occupied() &&
                   !flow.ConsumeApproved(FlowFacts(), FlowMeasured(), kApproved).ok,
               "flow-invalidate-ready")) return false;
  }

  // The denial table is the contract with Main.
  const auto same = [](const char *left, const char *right) {
    return std::string_view(left) == std::string_view(right);
  };
  struct Row {
    NativeApprovalFailure failure;
    const char *reason;
    const char *result;
  };
  const Row rows[] = {
      {NativeApprovalFailure::kUnavailable, "native_approval_unavailable", "rejected"},
      {NativeApprovalFailure::kExpired, "native_approval_expired", "rejected"},
      {NativeApprovalFailure::kRevalidationFailed, "native_approval_revalidation_failed", "rejected"},
      {NativeApprovalFailure::kTakeover, "native_approval_revalidation_failed", "paused"},
      {NativeApprovalFailure::kCanceled, "native_canceled_pre_dispatch", "canceled"},
      {NativeApprovalFailure::kTicketUnavailable, "native_ticket_unavailable", "rejected"},
  };
  for (const Row &row : rows) {
    const auto denial = NativeApprovalDenialFor(row.failure);
    if (!Check(same(denial.reason_code, row.reason) && same(denial.result, row.result),
               "flow-denial-table")) return false;
  }
  return true;
}

bool CheckNativeRunningIdentity() {
  using namespace sprint_coder::computer_use;
  NativeIdentityExpectation signed_app;
  signed_app.signed_target = true;
  signed_app.team_id = "TEAMID";
  signed_app.signing_identifier = "com.example.app";
  signed_app.cd_hash = "cdhash-a";
  NativeRunningObservation good;
  good.path_measured = true;
  good.path_matches = true;
  good.dynamic_signature_checked = true;
  good.dynamic_signature_valid = true;
  good.designated_requirement_satisfied = true;
  good.team_id = "TEAMID";
  good.signing_identifier = "com.example.app";
  good.cd_hash = "cdhash-a";
  if (!Check(CheckRunningIdentity(signed_app, good) == NativeIdentityVerdict::kMatch &&
                 NativeIdentityAllowsInput(CheckRunningIdentity(signed_app, good)),
             "identity-signed-match"))
    return false;
  // Every field that could differ is refused on its own, and only the exact match passes.
  const auto refuses = [&](const char *name, auto mutate, NativeIdentityVerdict verdict) {
    NativeRunningObservation observed = good;
    mutate(observed);
    return Check(CheckRunningIdentity(signed_app, observed) == verdict &&
                     !NativeIdentityAllowsInput(CheckRunningIdentity(signed_app, observed)),
                 name);
  };
  if (!refuses("identity-path-not-measured", [](auto &o) { o.path_measured = false; },
               NativeIdentityVerdict::kUnavailable) ||
      !refuses("identity-path-differs", [](auto &o) { o.path_matches = false; },
               NativeIdentityVerdict::kPathMismatch) ||
      !refuses("identity-signature-not-checked", [](auto &o) { o.dynamic_signature_checked = false; },
               NativeIdentityVerdict::kUnavailable) ||
      !refuses("identity-signature-invalid", [](auto &o) { o.dynamic_signature_valid = false; },
               NativeIdentityVerdict::kSignatureInvalid) ||
      !refuses("identity-requirement-unsatisfied",
               [](auto &o) { o.designated_requirement_satisfied = false; },
               NativeIdentityVerdict::kSignatureInvalid) ||
      !refuses("identity-team-differs", [](auto &o) { o.team_id = "OTHER"; },
               NativeIdentityVerdict::kSignerMismatch) ||
      !refuses("identity-identifier-differs", [](auto &o) { o.signing_identifier = "com.example.other"; },
               NativeIdentityVerdict::kSignerMismatch) ||
      !refuses("identity-cdhash-differs", [](auto &o) { o.cd_hash = "cdhash-b"; },
               NativeIdentityVerdict::kCodeDirectoryMismatch) ||
      !refuses("identity-cdhash-missing", [](auto &o) { o.cd_hash.clear(); },
               NativeIdentityVerdict::kCodeDirectoryMismatch))
    return false;
  // An expectation that is itself incomplete cannot be satisfied (nothing to compare is no match).
  for (auto field : {&NativeIdentityExpectation::team_id, &NativeIdentityExpectation::signing_identifier,
                     &NativeIdentityExpectation::cd_hash}) {
    NativeIdentityExpectation incomplete = signed_app;
    incomplete.*field = "";
    if (!Check(CheckRunningIdentity(incomplete, good) == NativeIdentityVerdict::kUnavailable,
               "identity-incomplete-expectation-refused"))
      return false;
  }
  // Bound as unsigned: the exact bytes, and it must not have become signed.
  NativeIdentityExpectation unsigned_app;
  unsigned_app.executable_digest = "digest-a";
  NativeRunningObservation image;
  image.path_measured = true;
  image.path_matches = true;
  image.image_digest_measured = true;
  image.image_digest = "digest-a";
  if (!Check(CheckRunningIdentity(unsigned_app, image) == NativeIdentityVerdict::kMatch,
             "identity-unsigned-match"))
    return false;
  NativeRunningObservation changed = image;
  changed.image_digest = "digest-b";
  NativeRunningObservation unreadable = image;
  unreadable.image_digest_measured = false;
  NativeRunningObservation became_signed = image;
  became_signed.dynamic_signature_checked = true;
  became_signed.dynamic_signature_valid = true;
  became_signed.team_id = "TEAMID";
  NativeIdentityExpectation no_digest = unsigned_app;
  no_digest.executable_digest.clear();
  if (!Check(CheckRunningIdentity(unsigned_app, changed) == NativeIdentityVerdict::kImageDigestMismatch,
             "identity-unsigned-digest-differs") ||
      !Check(CheckRunningIdentity(unsigned_app, unreadable) == NativeIdentityVerdict::kUnavailable,
             "identity-unsigned-unreadable") ||
      !Check(CheckRunningIdentity(unsigned_app, became_signed) == NativeIdentityVerdict::kBecameSigned,
             "identity-unsigned-became-signed") ||
      !Check(CheckRunningIdentity(no_digest, image) == NativeIdentityVerdict::kUnavailable,
             "identity-unsigned-no-bound-digest"))
    return false;
  // A truly unsigned binding (no code directory) with a signature that is valid but has no team
  // (nothing to compare) still matches on its bytes.
  NativeRunningObservation adhoc = image;
  adhoc.dynamic_signature_checked = true;
  adhoc.dynamic_signature_valid = true;
  if (!Check(CheckRunningIdentity(unsigned_app, adhoc) == NativeIdentityVerdict::kMatch,
             "identity-adhoc-without-team-matches-bytes"))
    return false;
  // A signature that is broken or tampered while it still names a team is not "became signed"
  // (that needs a valid one); the bytes decide.
  NativeRunningObservation broken_team = image;
  broken_team.dynamic_signature_checked = true;
  broken_team.dynamic_signature_valid = false;
  broken_team.team_id = "TEAMID";
  if (!Check(CheckRunningIdentity(unsigned_app, broken_team) == NativeIdentityVerdict::kMatch,
             "identity-unsigned-broken-signature-with-team-uses-bytes"))
    return false;
  // Bound unsigned but with a code directory (ad hoc, linker or platform signature): the running
  // process must be strictly valid and carry that code directory hash, whatever the file digest says.
  NativeIdentityExpectation adhoc_bound = unsigned_app;
  adhoc_bound.cd_hash = "cdhash-a";
  NativeRunningObservation adhoc_running = image;
  adhoc_running.dynamic_signature_checked = true;
  adhoc_running.dynamic_signature_valid = true;
  adhoc_running.cd_hash = "cdhash-a";
  NativeRunningObservation adhoc_swapped = adhoc_running;
  adhoc_swapped.cd_hash = "cdhash-b";
  NativeRunningObservation adhoc_invalid = adhoc_running;
  adhoc_invalid.dynamic_signature_valid = false;
  NativeRunningObservation adhoc_unchecked = adhoc_running;
  adhoc_unchecked.dynamic_signature_checked = false;
  if (!Check(CheckRunningIdentity(adhoc_bound, adhoc_running) == NativeIdentityVerdict::kMatch,
             "identity-adhoc-bound-match") ||
      !Check(CheckRunningIdentity(adhoc_bound, adhoc_swapped) == NativeIdentityVerdict::kCodeDirectoryMismatch,
             "identity-adhoc-bound-swapped-image-refused") ||
      !Check(CheckRunningIdentity(adhoc_bound, adhoc_invalid) == NativeIdentityVerdict::kSignatureInvalid,
             "identity-adhoc-bound-kernel-disk-disagree-refused") ||
      !Check(CheckRunningIdentity(adhoc_bound, adhoc_unchecked) == NativeIdentityVerdict::kUnavailable,
             "identity-adhoc-bound-unchecked-refused"))
    return false;
  // Verdict names are stable diagnostics, one per verdict.
  if (!Check(NativeIdentityVerdictName(NativeIdentityVerdict::kMatch) == "match" &&
                 NativeIdentityVerdictName(NativeIdentityVerdict::kSignatureInvalid) == "signature_invalid" &&
                 NativeIdentityVerdictName(NativeIdentityVerdict::kCodeDirectoryMismatch) ==
                     "code_directory_mismatch" &&
                 NativeIdentityVerdictName(NativeIdentityVerdict::kImageDigestMismatch) ==
                     "image_digest_mismatch",
             "identity-verdict-names"))
    return false;
  // The signing-state cap: unsigned is never above supervised, and nothing else is changed.
  if (!Check(CapModeForSigningState(false, "full_access_app") == "supervised" &&
                 CapModeForSigningState(false, "supervised") == "supervised" &&
                 CapModeForSigningState(false, "observe_only") == "observe_only" &&
                 CapModeForSigningState(true, "full_access_app") == "full_access_app" &&
                 CapModeForSigningState(true, "supervised") == "supervised",
             "identity-unsigned-mode-cap"))
    return false;
  return true;
}

bool CheckNativeEligibility() {
  using namespace sprint_coder::computer_use;
  const std::string_view name = kNativeEligibilityModeName;
  // The only two names the contract knows, and the flag agrees with the name.
  if (!Check(name == "v1-allowlist" || name == "v2-denylist", "eligibility-mode-name") ||
      !Check((name == "v2-denylist") == kNativeEligibilityIsV2, "eligibility-mode-flag"))
    return false;
  // Every version is a positive 16-bit number and a ticket claim is a plain boolean.
  if (!Check(kNativeEligibilityRulesetVersion > 0 && kNativeEligibilityRulesetVersion <= 0xffff &&
                 kNativeEligibilityClassifierVersion > 0 &&
                 kNativeEligibilityClassifierVersion <= 0xffff &&
                 kNativeEligibilityLexiconVersion > 0 && kNativeEligibilityLexiconVersion <= 0xffff,
             "eligibility-versions")) return false;
  // The classifier version the native attests is the one its classifier actually is.
  if (!Check(kNativeEligibilityClassifierVersion == kNativePreflightClassifierVersion,
             "eligibility-classifier-version-matches-classifier")) return false;
#if defined(SPRINT_CODER_EXPECT_ELIGIBILITY_V2)
  // CI names the mode the harness was compiled for (the matrix row), so a harness built against
  // the wrong generated header cannot pass on self-consistency alone.
  static_assert(SPRINT_CODER_EXPECT_ELIGIBILITY_V2 == 0 || SPRINT_CODER_EXPECT_ELIGIBILITY_V2 == 1,
                "The expected eligibility mode is v1 (0) or v2 (1).");
  if (!Check(kNativeEligibilityIsV2 == (SPRINT_CODER_EXPECT_ELIGIBILITY_V2 == 1),
             "eligibility-mode-matches-matrix")) return false;
#endif
#if !defined(SPRINT_CODER_ELIGIBILITY_FROM_BUILD)
  // The harness is compiled without the generated header: the legacy v1 defaults apply. The
  // ticket claim is true on both platforms: each native requires a ticket for every input.
  if (!Check(name == "v1-allowlist" && !kNativeEligibilityIsV2 &&
                 kNativeEligibilityTicketRequired,
             "eligibility-defaults")) return false;
#endif
  return true;
}

using sprint_coder::computer_use::ActionKind;
using sprint_coder::computer_use::ClassifyEffect;
using sprint_coder::computer_use::DecisionKind;
using sprint_coder::computer_use::DecisionReason;
using sprint_coder::computer_use::EffectClass;
using sprint_coder::computer_use::EffectDecision;
using sprint_coder::computer_use::EffectFacts;
using sprint_coder::computer_use::EffectRuleset;
using sprint_coder::computer_use::NodeFacts;
using sprint_coder::computer_use::OriginState;
using sprint_coder::computer_use::SessionMode;
using sprint_coder::computer_use::SurfaceKind;

// UTF-8 text whatever the compiler's execution character set is.
std::string operator""_u8(const char8_t *text, std::size_t length) {
  return std::string(reinterpret_cast<const char *>(text), length);
}

// A complete, ordinary click in a full-access session on a control that says "ok".
EffectFacts EffBase() {
  EffectFacts facts;
  facts.metadata_complete = true;
  facts.chain_complete = true;
  facts.text_language_supported = true;
  facts.surface = SurfaceKind::kOrdinary;
  facts.action = ActionKind::kClick;
  facts.mode = SessionMode::kFullAccess;
  facts.origin = OriginState::kNotApplicable;
  // The core defaults a key to "may open" (fail closed); most cases here mean plain typing.
  facts.key_is_activation = false;
  facts.chain.push_back(NodeFacts{"axbutton", "", "ok"});
  return facts;
}

EffectFacts EffLabel(const std::string &label, ActionKind action = ActionKind::kClick) {
  EffectFacts facts = EffBase();
  facts.chain[0].label = label;
  facts.action = action;
  return facts;
}

// A file item shown on a surface, to be opened by an action, with a known extension.
EffectFacts EffItem(SurfaceKind surface, ActionKind action, const std::string &extension) {
  EffectFacts facts = EffBase();
  facts.surface = surface;
  facts.action = action;
  facts.target_is_file_item = true;
  facts.extension_known = true;
  facts.extension = extension;
  return facts;
}

// Every approval a rule set can authorize is enabled here, to prove the table itself.
EffectRuleset EffAllEnabled() {
  EffectRuleset ruleset;
  ruleset.download_open = true;
  ruleset.file_manager_open = true;
  ruleset.high_impact_confirmation = true;
  ruleset.supervised_action = true;
  return ruleset;
}

bool EffIs(const EffectDecision &decision, DecisionKind kind, DecisionReason reason,
           EffectClass effect_class) {
  return decision.kind == kind && decision.reason == reason &&
         decision.effect_class == effect_class;
}

bool EffTakeover(const EffectFacts &facts, const EffectRuleset &ruleset = EffectRuleset{}) {
  return EffIs(ClassifyEffect(facts, ruleset), DecisionKind::kTakeover,
               DecisionReason::kUnclassified, EffectClass::kUnclassified);
}

const ActionKind kEffAllInputs[] = {
    ActionKind::kClick,   ActionKind::kDoubleClick, ActionKind::kInvoke, ActionKind::kSetText,
    ActionKind::kType,    ActionKind::kKey,         ActionKind::kScroll, ActionKind::kSelect,
    ActionKind::kToggle,  ActionKind::kExpandCollapse};

using sprint_coder::computer_use::ShadowAxNode;
using sprint_coder::computer_use::ShadowBudget;
using sprint_coder::computer_use::kShadowGapBusy;
using sprint_coder::computer_use::ShadowSkippedRecord;
using sprint_coder::computer_use::kShadowMaxAxCalls;
using sprint_coder::computer_use::kShadowDeadlineNs;
using sprint_coder::computer_use::kShadowGapV1Invalid;
using sprint_coder::computer_use::kShadowGapCanceled;
using sprint_coder::computer_use::kShadowGapBudget;
using sprint_coder::computer_use::kShadowGapReadFailed;
using sprint_coder::computer_use::ShadowAxCapture;
using sprint_coder::computer_use::ShadowRequestInfo;
using sprint_coder::computer_use::ShadowFacts;
using sprint_coder::computer_use::ShadowRecord;
using sprint_coder::computer_use::EffectShadowLog;
using sprint_coder::computer_use::BuildShadowFacts;
using sprint_coder::computer_use::ShadowClassify;
using sprint_coder::computer_use::kShadowLogCapacity;
using sprint_coder::computer_use::kShadowMaxCaptureNodes;
using sprint_coder::computer_use::kShadowGapTargetMissing;
using sprint_coder::computer_use::kShadowGapOversize;
using sprint_coder::computer_use::kShadowGapChainTruncated;
using sprint_coder::computer_use::kShadowGapNeighborsIncomplete;
using sprint_coder::computer_use::kShadowGapExtensionUnknown;
using sprint_coder::computer_use::kShadowGapLanguage;
using sprint_coder::computer_use::kShadowGapOrigin;
using sprint_coder::computer_use::kShadowGapUnsupportedAction;
using sprint_coder::computer_use::kShadowGapRoleMissing;
using sprint_coder::computer_use::kEffectMaxChainNodes;
using sprint_coder::computer_use::kEffectMaxLabelBytes;
using sprint_coder::computer_use::kEffectMaxNeighborLabels;

// ---- Classifier v2 C2: the shadow (facts built from an AX capture, recorded, never decisive) ----

ShadowAxNode ShadowNode(const std::string &role, const std::string &title = "") {
  ShadowAxNode node;
  node.role = role;
  node.title = title;
  return node;
}

// A TextEdit-like capture: a button in a window. The native walk ends at the window.
ShadowAxCapture ShadowBase() {
  ShadowAxCapture capture;
  capture.target_found = true;
  capture.chain = {ShadowNode("AXButton", "Save"), ShadowNode("AXWindow", "Notes")};
  capture.chain_reached_root = true;
  capture.neighbors_complete = true;
  return capture;
}

ShadowRequestInfo ShadowRequest(std::string_view kind = "invoke") {
  ShadowRequestInfo request;
  request.kind = kind;
  request.maximum_mode = "full_access_app";
  request.policy_language = "en";
  request.executable_path = "/System/Applications/TextEdit.app/Contents/MacOS/TextEdit";
  return request;
}

bool CheckEffectShadow() {
  // A complete capture is a complete fact set, and the application element is not a node.
  {
    const ShadowFacts built = BuildShadowFacts(ShadowBase(), ShadowRequest());
    if (!Check(built.gaps == 0 && built.facts.metadata_complete && built.facts.chain_complete &&
                   built.facts.chain.size() == 2 && built.facts.chain[0].role == "AXButton" &&
                   built.facts.chain[0].label == "Save" && built.facts.chain[1].role == "AXWindow",
               "shadow-complete-capture")) return false;
    if (!Check(built.facts.text_language_supported && built.facts.mode == SessionMode::kFullAccess &&
                   built.facts.origin == OriginState::kNotApplicable &&
                   built.facts.surface == SurfaceKind::kOrdinary && !built.facts.target_is_file_item &&
                   built.facts.action == ActionKind::kInvoke,
               "shadow-complete-capture-fields")) return false;
    const ShadowRecord record = ShadowClassify(ShadowBase(), ShadowRequest(), true);
    if (!Check(record.kind == DecisionKind::kOrdinary && record.gaps == 0 && !record.V2IsStricter() &&
                   !record.V2IsLooser(),
               "shadow-complete-capture-classifies")) return false;
  }

  // Request kinds map to the core's actions; an unknown kind is never ordinary.
  for (const auto &entry : std::vector<std::pair<std::string_view, ActionKind>>{
           {"click", ActionKind::kClick},   {"scroll", ActionKind::kScroll},
           {"invoke", ActionKind::kInvoke}, {"set_text", ActionKind::kSetText},
           {"select", ActionKind::kSelect}, {"toggle", ActionKind::kToggle},
           {"expand_collapse", ActionKind::kExpandCollapse}, {"type", ActionKind::kType},
           {"key", ActionKind::kKey}}) {
    if (!Check(BuildShadowFacts(ShadowBase(), ShadowRequest(entry.first)).facts.action == entry.second,
               "shadow-action-mapping")) return false;
  }
  {
    const ShadowFacts built = BuildShadowFacts(ShadowBase(), ShadowRequest("observe"));
    if (!Check((built.gaps & kShadowGapUnsupportedAction) != 0, "shadow-unknown-kind-gap")) return false;
    if (!Check(ShadowClassify(ShadowBase(), ShadowRequest("observe"), true).kind == DecisionKind::kTakeover,
               "shadow-unknown-kind-takeover")) return false;
    ShadowRequestInfo enter = ShadowRequest("key");
    enter.key = "Enter";
    if (!Check(BuildShadowFacts(ShadowBase(), enter).facts.key_is_activation, "shadow-enter-activates"))
      return false;
    enter.key = "Tab";
    if (!Check(!BuildShadowFacts(ShadowBase(), enter).facts.key_is_activation, "shadow-tab-does-not-activate"))
      return false;
  }

  // Mode and language come from the session, and an unattested language is a gap.
  {
    ShadowRequestInfo request = ShadowRequest();
    request.maximum_mode = "supervised";
    if (!Check(BuildShadowFacts(ShadowBase(), request).facts.mode == SessionMode::kSupervised, "shadow-mode-supervised"))
      return false;
    request.maximum_mode = "observe_only";
    if (!Check(BuildShadowFacts(ShadowBase(), request).facts.mode == SessionMode::kObserveOnly, "shadow-mode-observe"))
      return false;
    request.maximum_mode = "anything-else";
    if (!Check(BuildShadowFacts(ShadowBase(), request).facts.mode == SessionMode::kObserveOnly, "shadow-mode-closed"))
      return false;
    request = ShadowRequest();
    request.policy_language = "ja";
    if (!Check(BuildShadowFacts(ShadowBase(), request).facts.text_language_supported, "shadow-language-ja"))
      return false;
    request.policy_language = "de";
    const ShadowFacts german = BuildShadowFacts(ShadowBase(), request);
    if (!Check(!german.facts.text_language_supported && (german.gaps & kShadowGapLanguage) != 0, "shadow-language-gap"))
      return false;
    request.policy_language = "unknown";
    if (!Check(ShadowClassify(ShadowBase(), request, true).kind == DecisionKind::kTakeover, "shadow-language-takeover"))
      return false;
  }

  // The walk: a missing target, a cut-short walk, a node count over the cap, a long label.
  {
    ShadowAxCapture missing = ShadowBase();
    missing.target_found = false;
    missing.chain.clear();
    const ShadowFacts built = BuildShadowFacts(missing, ShadowRequest());
    if (!Check((built.gaps & kShadowGapTargetMissing) != 0 && !built.facts.metadata_complete &&
                   built.facts.surface == SurfaceKind::kUnknown,
               "shadow-target-missing")) return false;
    if (!Check(ShadowClassify(missing, ShadowRequest(), true).kind == DecisionKind::kTakeover,
               "shadow-target-missing-takeover")) return false;

    ShadowAxCapture cut = ShadowBase();
    cut.chain_reached_root = false;
    const ShadowFacts truncated = BuildShadowFacts(cut, ShadowRequest());
    if (!Check(!truncated.facts.chain_complete && (truncated.gaps & kShadowGapChainTruncated) != 0,
               "shadow-walk-cut-short")) return false;
    if (!Check(ShadowClassify(cut, ShadowRequest(), true).kind == DecisionKind::kTakeover, "shadow-walk-cut-short-takeover"))
      return false;

    ShadowAxCapture deep = ShadowBase();
    deep.chain.clear();
    for (std::size_t index = 0; index < kShadowMaxCaptureNodes; ++index)
      deep.chain.push_back(ShadowNode(index == 0 ? "AXButton" : "AXGroup", index == 0 ? "Save" : ""));
    deep.chain_reached_root = false;
    const ShadowFacts capped = BuildShadowFacts(deep, ShadowRequest());
    if (!Check(capped.facts.chain.size() == kEffectMaxChainNodes && !capped.facts.chain_complete,
               "shadow-chain-capped")) return false;
    // A walk that ended at the window with an application node on top is whole, even at the cap.
    ShadowAxCapture exact = ShadowBase();
    exact.chain.clear();
    for (std::size_t index = 0; index + 1 < kShadowMaxCaptureNodes; ++index)
      exact.chain.push_back(ShadowNode(index == 0 ? "AXButton" : "AXGroup", index == 0 ? "Save" : ""));
    exact.chain.push_back(ShadowNode("AXApplication"));
    exact.chain_reached_root = true;
    const ShadowFacts whole = BuildShadowFacts(exact, ShadowRequest());
    if (!Check(whole.facts.chain.size() == kEffectMaxChainNodes && whole.facts.chain_complete, "shadow-chain-at-cap"))
      return false;

    ShadowAxCapture oversize = ShadowBase();
    oversize.chain[0].title = std::string(kEffectMaxLabelBytes + 1, 'a');
    const ShadowFacts big = BuildShadowFacts(oversize, ShadowRequest());
    if (!Check((big.gaps & kShadowGapOversize) != 0 && !big.facts.metadata_complete, "shadow-label-oversize"))
      return false;
    ShadowAxCapture joined = ShadowBase();
    joined.chain[0].title = std::string(300, 'a');
    joined.chain[0].description = std::string(300, 'b');
    if (!Check((BuildShadowFacts(joined, ShadowRequest()).gaps & kShadowGapOversize) != 0, "shadow-joined-label-oversize"))
      return false;
    ShadowAxCapture roleless = ShadowBase();
    roleless.chain[0].role.clear();
    const ShadowFacts blank_role = BuildShadowFacts(roleless, ShadowRequest());
    if (!Check(!blank_role.facts.metadata_complete && (blank_role.gaps & kShadowGapRoleMissing) != 0, "shadow-role-missing"))
      return false;
    // A role of only blanks (an ideographic space, a no-break space, half-width spaces) is no role:
    // it is judged on the folded value, so it cannot pass for a present role.
    for (const std::string &blank_role_text :
         std::vector<std::string>{"\xE3\x80\x80", "\xC2\xA0", " ", "\xE3\x80\x80 \xC2\xA0"}) {
      ShadowAxCapture blanks = ShadowBase();
      blanks.chain[0].role = blank_role_text;
      const ShadowFacts blank_built = BuildShadowFacts(blanks, ShadowRequest());
      if (!Check(!blank_built.facts.metadata_complete && (blank_built.gaps & kShadowGapRoleMissing) != 0,
                 "shadow-blank-role-is-missing")) return false;
      if (!Check(ShadowClassify(blanks, ShadowRequest(), true).kind == DecisionKind::kTakeover,
                 "shadow-blank-role-is-a-takeover")) return false;
    }
    // A label of only blanks (title, NBSP, ideographic space) on a field a value is entered into is
    // no label: takeover, whatever mix of blanks it is. The same capture with a real label is not.
    for (const std::string &blank_label : std::vector<std::string>{
             " ", "\xC2\xA0", "\xE3\x80\x80", " \xE3\x80\x80\xC2\xA0 ", "\xE2\x80\x8B\xE3\x80\x80"}) {
      for (const char *kind : {"type", "set_text"}) {
        ShadowAxCapture field = ShadowBase();
        field.chain[0] = ShadowNode("AXTextField", blank_label);
        if (!Check(ShadowClassify(field, ShadowRequest(kind), true).kind == DecisionKind::kTakeover,
                   "shadow-blank-label-field-is-a-takeover")) return false;
        field.chain[0].title = "Name";
        if (!Check(ShadowClassify(field, ShadowRequest(kind), true).kind != DecisionKind::kTakeover,
                   "shadow-labeled-field-is-not-a-takeover")) return false;
      }
    }
    // The fold itself: the ideographic space is a plain space, a half-width WA + voiced mark is VA.
    if (!Check(sprint_coder::computer_use::shadow_detail::CompatFold("\xE3\x80\x80") == " ", "shadow-fold-ideographic-space-alone")) return false;
  }

  // The label joins title, description, help, placeholder, identifier and static text in order.
  {
    ShadowAxCapture capture = ShadowBase();
    capture.chain[0].title = "t";
    capture.chain[0].description = "d";
    capture.chain[0].help = "h";
    capture.chain[0].placeholder = "p";
    capture.chain[0].identifier = "i";
    capture.chain[0].value = "v";
    if (!Check(BuildShadowFacts(capture, ShadowRequest()).facts.chain[0].label == "t d h p i v", "shadow-label-join"))
      return false;
    // A purchase button is a confirmation for the core, and v1 (here: ordinary) is looser.
    ShadowAxCapture pay = ShadowBase();
    pay.chain[0].title = "Place order";
    const ShadowRecord record = ShadowClassify(pay, ShadowRequest(), true);
    if (!Check(record.effect_class == EffectClass::kConfirm && record.V2IsStricter() && !record.V2IsLooser(),
               "shadow-confirm-is-stricter")) return false;
  }

  // Neighbours: collected for every action, empty ones dropped, over 16 or unreadable are incomplete.
  {
    ShadowAxCapture capture = ShadowBase();
    capture.chain[0] = ShadowNode("AXComboBox", "Year");
    capture.neighbors = {ShadowNode("AXStaticText"), ShadowNode("AXStaticText")};
    capture.neighbors[1].value = "Card expiration date";
    for (const char *kind : {"click", "select", "invoke", "scroll", "type"}) {
      const ShadowFacts built = BuildShadowFacts(capture, ShadowRequest(kind));
      if (!Check(built.facts.neighbor_labels.size() == 1 &&
                     built.facts.neighbor_labels[0] == "Card expiration date" &&
                     built.facts.neighbor_labels_complete,
                 "shadow-neighbors-for-every-action")) return false;
    }
    ShadowAxCapture web = capture;
    web.chain.insert(web.chain.begin() + 1, ShadowNode("AXWebArea", "Checkout"));
    web.web_area_url_read = true;
    web.web_area_url = "https://example.com/pay";
    const ShadowRecord blocked = ShadowClassify(web, ShadowRequest("select"), true);
    if (!Check(blocked.kind == DecisionKind::kBlocked && blocked.effect_class == EffectClass::kCredential,
               "shadow-value-select-reads-neighbor")) return false;

    ShadowAxCapture many = ShadowBase();
    for (int index = 0; index < 17; ++index) {
      ShadowAxNode node = ShadowNode("AXStaticText");
      node.value = "caption " + std::to_string(index);
      many.neighbors.push_back(node);
    }
    const ShadowFacts crowded = BuildShadowFacts(many, ShadowRequest());
    if (!Check(crowded.facts.neighbor_labels.size() == kEffectMaxNeighborLabels &&
                   !crowded.facts.neighbor_labels_complete &&
                   (crowded.gaps & kShadowGapNeighborsIncomplete) != 0,
               "shadow-neighbors-over-the-cap")) return false;
    ShadowAxCapture partial = ShadowBase();
    partial.neighbors_complete = false;
    if (!Check(!BuildShadowFacts(partial, ShadowRequest()).facts.neighbor_labels_complete, "shadow-neighbors-incomplete"))
      return false;
    ShadowAxCapture long_neighbor = ShadowBase();
    long_neighbor.neighbors = {ShadowNode("AXStaticText")};
    long_neighbor.neighbors[0].value = std::string(kEffectMaxLabelBytes + 1, 'a');
    if (!Check(!BuildShadowFacts(long_neighbor, ShadowRequest()).facts.neighbor_labels_complete, "shadow-neighbor-oversize"))
      return false;
  }

  // A page: the web area's URL decides the origin; an unreadable one is unknown.
  {
    ShadowAxCapture page = ShadowBase();
    page.chain.insert(page.chain.begin() + 1, ShadowNode("AXWebArea", "Shop"));
    page.web_area_url_read = true;
    page.web_area_url = "https://example.com/";
    if (!Check(BuildShadowFacts(page, ShadowRequest()).facts.origin == OriginState::kOrdinary, "shadow-origin-https"))
      return false;
    page.web_area_url = "HTTP://example.com/";
    if (!Check(BuildShadowFacts(page, ShadowRequest()).facts.origin == OriginState::kOrdinary, "shadow-origin-case"))
      return false;
    page.web_area_url = "vscode-file://vscode-app/x";
    const ShadowFacts other = BuildShadowFacts(page, ShadowRequest());
    if (!Check(other.facts.origin == OriginState::kUnknown && (other.gaps & kShadowGapOrigin) != 0, "shadow-origin-other-scheme"))
      return false;
    page.web_area_url_read = false;
    page.web_area_url.clear();
    if (!Check(BuildShadowFacts(page, ShadowRequest()).facts.origin == OriginState::kUnknown, "shadow-origin-unreadable"))
      return false;
    if (!Check(ShadowClassify(page, ShadowRequest(), true).kind == DecisionKind::kTakeover, "shadow-origin-unreadable-takeover"))
      return false;
    page.web_area_url_read = true;
    page.web_area_url = "devtools://devtools/bundled/inspector.html";
    const ShadowFacts devtools = BuildShadowFacts(page, ShadowRequest());
    if (!Check(devtools.facts.surface == SurfaceKind::kDevToolsConsole && devtools.facts.origin == OriginState::kOrdinary,
               "shadow-devtools-surface")) return false;
    if (!Check(ShadowClassify(page, ShadowRequest(), true).kind == DecisionKind::kBlocked, "shadow-devtools-blocked"))
      return false;
  }

  // The surface comes from the executable; a terminal is a command surface.
  for (const auto &entry : std::vector<std::pair<std::string, SurfaceKind>>{
           {"/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal", SurfaceKind::kShellLike},
           {"/Applications/iTerm.app/Contents/MacOS/iTerm2", SurfaceKind::kShellLike},
           {"/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder", SurfaceKind::kFileBrowser},
           {"/Applications/Raycast.app/Contents/MacOS/Raycast", SurfaceKind::kCommandPalette},
           {"/Applications/Safari.app/Contents/MacOS/Safari", SurfaceKind::kOrdinary},
           {"", SurfaceKind::kOrdinary}}) {
    ShadowRequestInfo request = ShadowRequest();
    request.executable_path = entry.first;
    if (!Check(BuildShadowFacts(ShadowBase(), request).facts.surface == entry.second, "shadow-surface-from-executable"))
      return false;
  }
  {
    ShadowRequestInfo request = ShadowRequest();
    request.executable_path = "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal";
    if (!Check(ShadowClassify(ShadowBase(), request, true).effect_class == EffectClass::kSurface, "shadow-terminal-is-a-surface"))
      return false;
  }

  // File items: the URL (or the file name) gives the extension; a folder is not an item.
  {
    ShadowAxCapture item = ShadowBase();
    item.url_present = true;
    item.url = "file:///Users/me/Downloads/Setup%2Eexe";
    ShadowFacts built = BuildShadowFacts(item, ShadowRequest("click"));
    if (!Check(built.facts.target_is_file_item && built.facts.extension_known && built.facts.extension == "exe",
               "shadow-file-url-extension")) return false;
    if (!Check(ShadowClassify(item, ShadowRequest("click"), true).kind == DecisionKind::kBlocked, "shadow-exe-is-blocked"))
      return false;
    item.url = "file:///Users/me/Downloads/Report.PDF";
    built = BuildShadowFacts(item, ShadowRequest());
    if (!Check(built.facts.extension == "pdf", "shadow-extension-lowercase")) return false;
    item.url = "file:///Users/me/Applications/Tool.app/";
    built = BuildShadowFacts(item, ShadowRequest());
    if (!Check(built.facts.target_is_file_item && built.facts.extension == "app", "shadow-package-is-an-item")) return false;
    item.url = "file:///Users/me/Projects/";
    built = BuildShadowFacts(item, ShadowRequest());
    if (!Check(!built.facts.target_is_file_item && !built.facts.extension_known && built.gaps == 0, "shadow-folder-is-not-an-item"))
      return false;
    item.url = "file:///Users/me/Projects/archive.v1/";
    if (!Check(!BuildShadowFacts(item, ShadowRequest()).facts.target_is_file_item, "shadow-dotted-folder-is-not-an-item"))
      return false;
    item.url = "file:///Users/me/bin/run";
    built = BuildShadowFacts(item, ShadowRequest());
    if (!Check(built.facts.target_is_file_item && !built.facts.extension_known &&
                   (built.gaps & kShadowGapExtensionUnknown) != 0,
               "shadow-extensionless-file-is-unknown")) return false;
    item.url = "file:///Users/me/.zshrc";
    if (!Check(!BuildShadowFacts(item, ShadowRequest()).facts.extension_known, "shadow-dotfile-has-no-extension"))
      return false;
    ShadowAxCapture named = ShadowBase();
    named.filename = "installer.pkg";
    built = BuildShadowFacts(named, ShadowRequest("click"));
    if (!Check(built.facts.target_is_file_item && built.facts.extension == "pkg", "shadow-filename-extension")) return false;
    ShadowAxCapture web_url = ShadowBase();
    web_url.url_present = true;
    web_url.url = "https://example.com/setup.exe";
    if (!Check(!BuildShadowFacts(web_url, ShadowRequest()).facts.target_is_file_item, "shadow-web-link-is-not-a-file-item"))
      return false;
  }

  // The record is plain data and the ring keeps the newest records only.
  {
    EffectShadowLog log;
    if (!Check(log.Total() == 0 && log.Snapshot().empty(), "shadow-log-empty")) return false;
    for (std::uint32_t index = 0; index < kShadowLogCapacity + 10; ++index) {
      ShadowRecord record;
      record.gaps = index;
      log.Record(record);
    }
    const std::vector<ShadowRecord> snapshot = log.Snapshot();
    if (!Check(log.Total() == kShadowLogCapacity + 10 && snapshot.size() == kShadowLogCapacity &&
                   snapshot.front().gaps == 10 && snapshot.back().gaps == kShadowLogCapacity + 9,
               "shadow-log-bounded-newest")) return false;
    if (!Check(sizeof(ShadowRecord) <= 32, "shadow-record-is-small")) return false;
  }

  // The same capture gives the same record every time.
  {
    const ShadowAxCapture capture = ShadowBase();
    const ShadowRecord first = ShadowClassify(capture, ShadowRequest(), true);
    const ShadowRecord second = ShadowClassify(capture, ShadowRequest(), true);
    if (!Check(first.kind == second.kind && first.reason == second.reason &&
                   first.effect_class == second.effect_class && first.gaps == second.gaps,
               "shadow-is-deterministic")) return false;
  }
  std::cout << "Computer Use native effect shadow: PASS\n";
  return true;
}

// The shadow is bounded, gives way, and never reads a gap as an empty string.
bool CheckEffectShadowBounds() {
  // The budget: calls are counted, the deadline is on the caller's clock, and a spent budget stays spent.
  {
    ShadowBudget calls(1000);
    for (std::uint32_t index = 0; index < kShadowMaxAxCalls; ++index)
      if (!Check(calls.Spend(1000), "shadow-budget-spends-calls")) return false;
    if (!Check(calls.Calls() == kShadowMaxAxCalls && !calls.Exhausted(), "shadow-budget-counts")) return false;
    if (!Check(!calls.Spend(1000) && calls.Exhausted(), "shadow-budget-call-limit")) return false;
    if (!Check(!calls.Spend(1000) && calls.Calls() == kShadowMaxAxCalls, "shadow-budget-stays-spent")) return false;

    ShadowBudget timed(5000);
    if (!Check(timed.Spend(5000 + kShadowDeadlineNs), "shadow-budget-deadline-inclusive")) return false;
    if (!Check(!timed.Spend(5000 + kShadowDeadlineNs + 1) && timed.Exhausted(), "shadow-budget-deadline")) return false;
    if (!Check(!timed.Spend(5000), "shadow-budget-deadline-is-sticky")) return false;
    if (!Check(kShadowDeadlineNs <= 200'000'000 && kShadowMaxAxCalls >= 256, "shadow-budget-is-small-but-whole"))
      return false;
  }

  // A capture that stopped, or lost an attribute, is not whole: takeover, with the reason.
  {
    ShadowAxCapture stopped = ShadowBase();
    stopped.budget_exhausted = true;
    ShadowFacts built = BuildShadowFacts(stopped, ShadowRequest());
    if (!Check((built.gaps & kShadowGapBudget) != 0 && !built.facts.metadata_complete &&
                   !built.facts.neighbor_labels_complete,
               "shadow-budget-exhausted-is-incomplete")) return false;
    const ShadowRecord stopped_record = ShadowClassify(stopped, ShadowRequest(), true);
    if (!Check(stopped_record.kind == DecisionKind::kTakeover && (stopped_record.gaps & kShadowGapBudget) != 0 &&
                   !stopped_record.Skipped() && stopped_record.V2IsStricter(),
               "shadow-budget-exhausted-takeover")) return false;

    ShadowAxCapture failed_read = ShadowBase();
    failed_read.chain[0].read_failed = true;
    built = BuildShadowFacts(failed_read, ShadowRequest());
    if (!Check((built.gaps & kShadowGapReadFailed) != 0 && !built.facts.metadata_complete, "shadow-node-read-failed"))
      return false;
    ShadowAxCapture ancestor = ShadowBase();
    ancestor.chain[1].read_failed = true;
    if (!Check(ShadowClassify(ancestor, ShadowRequest(), true).kind == DecisionKind::kTakeover,
               "shadow-ancestor-read-failed-takeover")) return false;
    ShadowAxCapture url_failed = ShadowBase();
    url_failed.read_failed = true;
    built = BuildShadowFacts(url_failed, ShadowRequest());
    if (!Check((built.gaps & kShadowGapReadFailed) != 0 && !built.facts.metadata_complete, "shadow-url-read-failed"))
      return false;

    // A long attribute next to a short one is not "the short one": the node is not whole.
    ShadowAxCapture long_attribute = ShadowBase();
    long_attribute.chain[0].title = "Notes";
    long_attribute.chain[0].description.clear();
    long_attribute.chain[0].oversize = true;
    built = BuildShadowFacts(long_attribute, ShadowRequest());
    if (!Check((built.gaps & kShadowGapOversize) != 0 && !built.facts.metadata_complete, "shadow-oversize-flag-is-a-gap"))
      return false;
    if (!Check(ShadowClassify(long_attribute, ShadowRequest(), true).kind == DecisionKind::kTakeover,
               "shadow-oversize-flag-takeover")) return false;

    // The same on a neighbour: its caption is lost, so the neighbours are not complete.
    for (const bool oversize : {true, false}) {
      ShadowAxCapture neighbor = ShadowBase();
      neighbor.neighbors = {ShadowNode("AXStaticText")};
      neighbor.neighbors[0].value = "Year";
      neighbor.neighbors[0].oversize = oversize;
      neighbor.neighbors[0].read_failed = !oversize;
      const ShadowFacts lost = BuildShadowFacts(neighbor, ShadowRequest());
      if (!Check(!lost.facts.neighbor_labels_complete && lost.facts.neighbor_labels.empty() &&
                     (lost.gaps & kShadowGapNeighborsIncomplete) != 0,
                 "shadow-neighbor-lost-caption")) return false;
    }
    // Over the node count with the window last: the window would be cut, so the chain is cut short.
    ShadowAxCapture deep = ShadowBase();
    deep.chain.clear();
    for (std::size_t index = 0; index + 1 < kShadowMaxCaptureNodes; ++index)
      deep.chain.push_back(ShadowNode(index == 0 ? "AXButton" : "AXGroup", index == 0 ? "Save" : ""));
    deep.chain.push_back(ShadowNode("AXWindow", "Notes"));
    deep.chain_reached_root = true;
    built = BuildShadowFacts(deep, ShadowRequest());
    if (!Check(built.facts.chain.size() == kEffectMaxChainNodes && !built.facts.chain_complete &&
                   (built.gaps & kShadowGapChainTruncated) != 0,
               "shadow-ten-nodes-is-cut-short")) return false;
    // Nine nodes ending at the window is whole.
    deep.chain.erase(deep.chain.begin() + 1);
    built = BuildShadowFacts(deep, ShadowRequest());
    if (!Check(built.facts.chain.size() == kEffectMaxChainNodes && built.facts.chain_complete && built.gaps == 0,
               "shadow-nine-nodes-to-the-window-is-whole")) return false;
    // A role over the bound is dropped and is a gap.
    ShadowAxCapture long_role = ShadowBase();
    long_role.chain[1].role = std::string(kEffectMaxLabelBytes + 1, 'r');
    built = BuildShadowFacts(long_role, ShadowRequest());
    if (!Check((built.gaps & kShadowGapOversize) != 0 && built.facts.chain[1].role.empty() && !built.facts.metadata_complete,
               "shadow-role-over-the-bound")) return false;
  }

  // Nothing was read: neither stricter nor looser, and a takeover of the unclassified kind.
  for (const std::uint32_t gap : {kShadowGapV1Invalid, kShadowGapCanceled}) {
    for (const bool v1 : {true, false}) {
      const ShadowRecord skipped = ShadowSkippedRecord("invoke", gap, v1);
      if (!Check(skipped.Skipped() && !skipped.V2IsStricter() && !skipped.V2IsLooser() &&
                     skipped.kind == DecisionKind::kTakeover && skipped.effect_class == EffectClass::kUnclassified &&
                     skipped.gaps == gap && skipped.v1_ordinary == v1 && skipped.action == ActionKind::kInvoke,
                 "shadow-skipped-record")) return false;
    }
  }
  if (!Check((ShadowSkippedRecord("nonsense", kShadowGapV1Invalid, false).gaps & kShadowGapUnsupportedAction) != 0,
             "shadow-skipped-unknown-kind")) return false;

  // The comparison with v1 goes both ways, and the record keeps what v1 said and what was asked.
  {
    ShadowAxCapture pay = ShadowBase();
    pay.chain[0].title = "Place order";
    const ShadowRecord stricter = ShadowClassify(pay, ShadowRequest(), true);
    if (!Check(stricter.V2IsStricter() && !stricter.V2IsLooser() && stricter.v1_ordinary &&
                   stricter.action == ActionKind::kInvoke && !stricter.Skipped(),
               "shadow-record-stricter")) return false;
    // v1 refused and v2 would let it through: the looser case that matters for the roll-out.
    const ShadowRecord looser = ShadowClassify(ShadowBase(), ShadowRequest("click"), false);
    if (!Check(looser.V2IsLooser() && !looser.V2IsStricter() && !looser.v1_ordinary &&
                   looser.kind == DecisionKind::kOrdinary && looser.action == ActionKind::kClick,
               "shadow-record-looser")) return false;
    const ShadowRecord both_refuse = ShadowClassify(pay, ShadowRequest(), false);
    if (!Check(!both_refuse.V2IsLooser() && !both_refuse.V2IsStricter() && !both_refuse.v1_ordinary,
               "shadow-record-both-refuse")) return false;
  }

  // Schemes and executables the first cases did not reach.
  {
    ShadowAxCapture page = ShadowBase();
    page.chain.insert(page.chain.begin() + 1, ShadowNode("AXWebArea", "Shop"));
    page.web_area_url_read = true;
    for (const std::string url : {"file:///Users/me/index.html", "chrome-devtools://devtools/x"}) {
      page.web_area_url = url;
      if (!Check(BuildShadowFacts(page, ShadowRequest()).facts.origin == OriginState::kOrdinary, "shadow-origin-more-schemes"))
        return false;
    }
    page.web_area_url = "chrome-devtools://devtools/x";
    if (!Check(BuildShadowFacts(page, ShadowRequest()).facts.surface == SurfaceKind::kDevToolsConsole, "shadow-chrome-devtools-surface"))
      return false;
    page.web_area_url = "javascript:alert(1)";
    if (!Check(BuildShadowFacts(page, ShadowRequest()).facts.origin == OriginState::kUnknown, "shadow-origin-javascript"))
      return false;
    for (const auto &entry : std::vector<std::pair<std::string, SurfaceKind>>{
             {"/Applications/Alfred 5.app/Contents/MacOS/Alfred", SurfaceKind::kCommandPalette},
             {"/System/Library/CoreServices/Spotlight.app/Contents/MacOS/Spotlight", SurfaceKind::kCommandPalette},
             {"/Applications/WezTerm.app/Contents/MacOS/wezterm-gui", SurfaceKind::kShellLike}}) {
      ShadowRequestInfo request = ShadowRequest();
      request.executable_path = entry.first;
      if (!Check(BuildShadowFacts(ShadowBase(), request).facts.surface == entry.second, "shadow-surface-more-executables"))
        return false;
    }
  }
  std::cout << "Computer Use native effect shadow bounds: PASS\n";
  return true;
}

// Labels disguised by character width are folded before the core reads them.
bool CheckEffectShadowFolding() {
  using sprint_coder::computer_use::shadow_detail::CompatFold;
  // Half-width katakana become full-width ones, marks combine into the letter.
  if (!Check(CompatFold(u8"ﾊﾟｽﾜｰﾄﾞ"_u8) == u8"パスワード"_u8,
             "shadow-fold-password-katakana")) return false;
  if (!Check(CompatFold(u8"ｶｰﾄﾞ"_u8) == u8"カード"_u8, "shadow-fold-card")) return false;
  if (!Check(CompatFold(u8"ｳﾞ"_u8) == u8"ヴ"_u8, "shadow-fold-vu")) return false;
  if (!Check(CompatFold(u8"ﾊﾞﾋﾟ"_u8) == u8"バピ"_u8, "shadow-fold-voiced-and-semi")) return false;
  // A mark that cannot combine stays, a lone mark stays, and other text is untouched.
  if (!Check(CompatFold(u8"ｱﾞ"_u8) == u8"アﾞ"_u8, "shadow-fold-mark-on-a-vowel")) return false;
  if (!Check(CompatFold(u8"ﾊﾞﾞ"_u8) == u8"バﾞ"_u8, "shadow-fold-second-mark")) return false;
  if (!Check(CompatFold(u8"ﾞ"_u8) == u8"ﾞ"_u8, "shadow-fold-lone-mark")) return false;
  if (!Check(CompatFold(u8"パス pay"_u8) == u8"パス pay"_u8, "shadow-fold-leaves-other-text")) return false;
  // Full-width Latin, digits and punctuation become ASCII.
  if (!Check(CompatFold(u8"Ｐａｙ ｎｏｗ！１"_u8) == u8"Pay now!1"_u8, "shadow-fold-fullwidth-ascii"))
    return false;
  if (!Check(CompatFold(std::string("a\xE3\x81")) == std::string("a\xE3\x81"), "shadow-fold-malformed-passes")) return false;
  if (!Check(CompatFold("") .empty(), "shadow-fold-empty")) return false;

  // The core now sees what the label says.
  const std::string half_width_password = u8"ﾊﾟｽﾜｰﾄﾞ"_u8;
  {
    ShadowAxCapture field = ShadowBase();
    field.chain[0] = ShadowNode("AXTextField", half_width_password);
    const ShadowRecord record = ShadowClassify(field, ShadowRequest("type"), true);
    if (!Check(record.kind == DecisionKind::kBlocked && record.effect_class == EffectClass::kSecure,
               "shadow-halfwidth-password-is-secure")) return false;
    ShadowAxCapture card = ShadowBase();
    card.chain[0] = ShadowNode("AXTextField", u8"ｶｰﾄﾞ番号"_u8);
    if (!Check(ShadowClassify(card, ShadowRequest("type"), true).effect_class == EffectClass::kCredential,
               "shadow-halfwidth-card-number")) return false;
    ShadowAxCapture wide = ShadowBase();
    wide.chain[0] = ShadowNode("AXTextField", u8"Ｐａｓｓｗｏｒｄ"_u8);
    if (!Check(ShadowClassify(wide, ShadowRequest("type"), true).effect_class == EffectClass::kSecure,
               "shadow-fullwidth-password-is-secure")) return false;
    ShadowAxCapture pay = ShadowBase();
    pay.chain[0] = ShadowNode("AXButton", u8"Ｐａｙ ｎｏｗ"_u8);
    if (!Check(ShadowClassify(pay, ShadowRequest("click"), true).effect_class == EffectClass::kConfirm,
               "shadow-fullwidth-pay-now-is-confirm")) return false;
    // The caption near a field, the role and the subrole are folded too.
    ShadowAxCapture near = ShadowBase();
    near.chain[0] = ShadowNode("AXTextField", "Year");
    near.neighbors = {ShadowNode("AXStaticText")};
    near.neighbors[0].value = u8"Ｃａｒｄ ｎｕｍｂｅｒ"_u8;
    near.chain.insert(near.chain.begin() + 1, ShadowNode("AXWebArea", "Checkout"));
    near.web_area_url_read = true;
    near.web_area_url = "https://example.com/";
    if (!Check(ShadowClassify(near, ShadowRequest("type"), true).effect_class == EffectClass::kCredential,
               "shadow-fullwidth-neighbor-caption")) return false;
    ShadowAxCapture role = ShadowBase();
    role.chain[0].role = u8"AXSecureＴｅｘｔＦｉｅｌｄ"_u8;
    role.chain[0].title = "Name";
    if (!Check(BuildShadowFacts(role, ShadowRequest("type")).facts.chain[0].role == "AXSecureTextField",
               "shadow-fold-role")) return false;
  }
  // Every half-width character folds to its own full-width one.
  {
    std::string all;
    for (char32_t code = 0xFF61; code <= 0xFF9D; ++code)
      sprint_coder::computer_use::shadow_detail::AppendCodePoint(code, &all);
    const std::string expected = u8"。「」、・ヲァィゥェォャュョッーアイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン"_u8;
    if (!Check(CompatFold(all) == expected, "shadow-fold-every-halfwidth-kana")) return false;
    ShadowAxCapture subrole = ShadowBase();
    subrole.chain[0].role = "AXTextField";
    subrole.chain[0].subrole = u8"AXSecureTextField"_u8;
    subrole.chain[0].subrole = u8"AX\uFF33\uFF45\uFF43\uFF55\uFF52\uFF45\uFF34\uFF45\uFF58\uFF54\uFF26\uFF49\uFF45\uFF4C\uFF44"_u8;
    subrole.chain[0].title = "Name";
    if (!Check(BuildShadowFacts(subrole, ShadowRequest("type")).facts.chain[0].subrole == "AXSecureTextField",
               "shadow-fold-subrole")) return false;
    if (!Check(ShadowClassify(subrole, ShadowRequest("type"), true).effect_class == EffectClass::kSecure,
               "shadow-fullwidth-subrole-is-secure")) return false;
  }
  // The ideographic space and the voiced half-width W row fold like NFKC does.
  {
    if (!Check(CompatFold(u8"ﾜﾞ"_u8) == u8"ヷ"_u8, "shadow-fold-va")) return false;
    if (!Check(CompatFold(u8"ｦﾞ"_u8) == u8"ヺ"_u8, "shadow-fold-vo")) return false;
    if (!Check(CompatFold(u8"a　b"_u8) == "a b", "shadow-fold-ideographic-space")) return false;
    ShadowAxCapture spaced = ShadowBase();
    spaced.chain[0] = ShadowNode("AXTextField", u8"カード　番号"_u8);
    if (!Check(BuildShadowFacts(spaced, ShadowRequest("type")).facts.chain[0].label == u8"カード 番号"_u8,
               "shadow-fold-ideographic-space-in-label")) return false;
  }
  // The root and the page are recognized after folding, like every other role.
  {
    ShadowAxCapture app = ShadowBase();
    app.chain.push_back(ShadowNode(u8"ＡＸＡｐｐｌｉｃａｔｉｏｎ"_u8, "App"));
    if (!Check(BuildShadowFacts(app, ShadowRequest("type")).facts.chain.size() == 2,
               "shadow-fullwidth-application-root-is-dropped")) return false;
    ShadowAxCapture page = ShadowBase();
    page.chain.insert(page.chain.begin() + 1, ShadowNode(u8"ＡＸＷｅｂＡｒｅａ"_u8, "Page"));
    if (!Check(BuildShadowFacts(page, ShadowRequest("type")).facts.origin == OriginState::kUnknown,
               "shadow-fullwidth-web-area-is-a-page")) return false;
  }
  // A capture that was not taken because another was running is not a comparison.
  {
    const ShadowRecord busy = ShadowSkippedRecord("click", kShadowGapBusy, true);
    if (!Check(busy.Skipped() && !busy.V2IsStricter() && !busy.V2IsLooser() &&
                   busy.kind == DecisionKind::kTakeover && (busy.gaps & kShadowGapBusy) != 0,
               "shadow-busy-record")) return false;
  }
  std::cout << "Computer Use native effect shadow folding: PASS\n";
  return true;
}

using sprint_coder::computer_use::ShadowUiaNode;
using sprint_coder::computer_use::ShadowUiaCapture;
using sprint_coder::computer_use::ShadowItemKind;
using sprint_coder::computer_use::BuildWindowsShadowFacts;
using sprint_coder::computer_use::WindowsShadowClassify;
using sprint_coder::computer_use::kShadowGapOsPromptSurface;
using sprint_coder::computer_use::kShadowGapNativeDocument;
using sprint_coder::computer_use::ShadowCheckText;
using sprint_coder::computer_use::ShadowReadResult;
using sprint_coder::computer_use::ShadowSettle;
using sprint_coder::computer_use::ShadowUnitsTooLong;
using sprint_coder::computer_use::ShadowGate;
using sprint_coder::computer_use::ShadowCheckText;
using sprint_coder::computer_use::ShadowUiaSource;
using sprint_coder::computer_use::ShadowUiaText;
using sprint_coder::computer_use::WindowsShadowReader;
using sprint_coder::computer_use::WindowsShadowScheduler;
using sprint_coder::computer_use::WindowsShadowJob;
using sprint_coder::computer_use::WindowsShadowEnvironment;
using sprint_coder::computer_use::WindowsShadowLauncher;
using sprint_coder::computer_use::kShadowMaxCaptureNodes;
using sprint_coder::computer_use::kEffectMaxNeighborLabels;
using sprint_coder::computer_use::ProcessShadowLog;
using sprint_coder::computer_use::kShadowMaxAxCalls;
using sprint_coder::computer_use::kShadowDeadlineNs;
using sprint_coder::computer_use::kShadowGapCanceled;
using sprint_coder::computer_use::kShadowGapBudget;
using sprint_coder::computer_use::kShadowGapTargetMissing;
using sprint_coder::computer_use::kShadowGapOversize;
using sprint_coder::computer_use::kShadowGapReadFailed;
using sprint_coder::computer_use::kShadowGapChainTruncated;
using sprint_coder::computer_use::kShadowGapExtensionUnknown;
using sprint_coder::computer_use::kShadowGapBusy;
using sprint_coder::computer_use::EffectShadowLog;
using sprint_coder::computer_use::ShadowSkippedRecord;

// ---- Windows shadow core (S5-b-1): UIA facts, reads, gate and surfaces, all portable ------------

ShadowUiaNode UiaNode(const std::string &control_type, const std::string &name = "") {
  ShadowUiaNode node;
  node.control_type = control_type;
  node.name = name;
  return node;
}

// A Notepad-like capture: a button in a window of an ordinary process.
ShadowUiaCapture UiaBase() {
  ShadowUiaCapture capture;
  capture.target_found = true;
  capture.chain = {UiaNode("Button", "Save"), UiaNode("Window", "Untitled - Notepad")};
  capture.chain_reached_root = true;
  capture.neighbors_complete = true;
  capture.window_class_read = true;
  capture.window_class = "Notepad";
  capture.process_path_read = true;
  capture.process_path = "C:\\Windows\\System32\\notepad.exe";
  return capture;
}

ShadowRequestInfo UiaRequest(std::string_view kind = "invoke") {
  ShadowRequestInfo request;
  request.kind = kind;
  request.maximum_mode = "full_access_app";
  request.policy_language = "en";
  return request;
}

bool CheckWindowsShadowCore() {
  // A complete capture is a complete fact set and an ordinary decision.
  {
    const ShadowFacts built = BuildWindowsShadowFacts(UiaBase(), UiaRequest());
    if (!Check(built.gaps == 0 && built.facts.metadata_complete && built.facts.chain_complete &&
                   built.facts.chain.size() == 2 && built.facts.chain[0].role == "Button" &&
                   built.facts.chain[0].label == "Save" && built.facts.chain[1].role == "Window" &&
                   built.facts.surface == SurfaceKind::kOrdinary &&
                   built.facts.origin == OriginState::kNotApplicable && !built.facts.target_is_file_item,
               "winshadow-complete-capture")) return false;
    const ShadowRecord record = WindowsShadowClassify(UiaBase(), UiaRequest(), true);
    if (!Check(record.kind == DecisionKind::kOrdinary && record.gaps == 0 && !record.V2IsStricter() &&
                   !record.V2IsLooser(),
               "winshadow-complete-capture-classifies")) return false;
  }
  // The same bounds and gaps as the macOS shadow: nothing is ever truncated or emptied.
  {
    ShadowUiaCapture missing = UiaBase();
    missing.target_found = false;
    missing.chain.clear();
    if (!Check((BuildWindowsShadowFacts(missing, UiaRequest()).gaps & kShadowGapTargetMissing) != 0,
               "winshadow-target-missing")) return false;
    ShadowUiaCapture oversize = UiaBase();
    oversize.chain[0].oversize = true;
    const ShadowFacts built = BuildWindowsShadowFacts(oversize, UiaRequest());
    if (!Check((built.gaps & kShadowGapOversize) != 0 && !built.facts.metadata_complete &&
                   WindowsShadowClassify(oversize, UiaRequest(), true).kind == DecisionKind::kTakeover,
               "winshadow-oversize-is-a-gap")) return false;
    ShadowUiaCapture too_long = UiaBase();
    too_long.chain[0].name = std::string(kEffectMaxLabelBytes + 1, 'a');
    if (!Check((BuildWindowsShadowFacts(too_long, UiaRequest()).gaps & kShadowGapOversize) != 0,
               "winshadow-long-name-is-oversize")) return false;
    ShadowUiaCapture failed = UiaBase();
    failed.chain[0].read_failed = true;
    if (!Check((BuildWindowsShadowFacts(failed, UiaRequest()).gaps & kShadowGapReadFailed) != 0,
               "winshadow-read-failed-is-a-gap")) return false;
    ShadowUiaCapture cut = UiaBase();
    cut.chain_reached_root = false;
    if (!Check((BuildWindowsShadowFacts(cut, UiaRequest()).gaps & kShadowGapChainTruncated) != 0 &&
                   !BuildWindowsShadowFacts(cut, UiaRequest()).facts.chain_complete,
               "winshadow-cut-chain")) return false;
    ShadowUiaCapture budget = UiaBase();
    budget.budget_exhausted = true;
    if (!Check((BuildWindowsShadowFacts(budget, UiaRequest()).gaps & kShadowGapBudget) != 0 &&
                   !BuildWindowsShadowFacts(budget, UiaRequest()).facts.metadata_complete,
               "winshadow-budget-gap")) return false;
  }
  // A password control is secure whatever its name says; a Win32 class name is the subrole.
  {
    ShadowUiaCapture password = UiaBase();
    password.chain[0] = UiaNode("Edit", "Name");
    password.chain[0].is_password = true;
    const ShadowRecord record = WindowsShadowClassify(password, UiaRequest("type"), true);
    if (!Check(record.kind == DecisionKind::kBlocked && record.effect_class == EffectClass::kSecure,
               "winshadow-password-control-is-secure")) return false;
    ShadowUiaCapture box = UiaBase();
    box.chain[0] = UiaNode("Edit", "Name");
    box.chain[0].class_name = "PasswordBox";
    if (!Check(WindowsShadowClassify(box, UiaRequest("type"), true).effect_class == EffectClass::kSecure,
               "winshadow-password-class-is-secure")) return false;
    // Half-width katakana in a name are folded before the core reads them.
    ShadowUiaCapture kana = UiaBase();
    kana.chain[0] = UiaNode("Edit", u8"ﾊﾟｽﾜｰﾄﾞ"_u8);
    if (!Check(WindowsShadowClassify(kana, UiaRequest("type"), true).effect_class == EffectClass::kSecure,
               "winshadow-halfwidth-password")) return false;
    // The ideographic space is a space: a caption split by it still reads as its words.
    ShadowUiaCapture spaced = UiaBase();
    spaced.chain[0] = UiaNode("Edit", u8"カード\u3000番号"_u8);
    if (!Check(BuildWindowsShadowFacts(spaced, UiaRequest("type")).facts.chain[0].label == u8"カード 番号"_u8,
               "winshadow-ideographic-space")) return false;
  }
  // The surface of the window.
  {
    const auto surface_of = [](const std::string &window_class, const std::string &process) {
      ShadowUiaCapture capture = UiaBase();
      capture.window_class = window_class;
      capture.process_path = process;
      return BuildWindowsShadowFacts(capture, UiaRequest("type"));
    };
    if (!Check(surface_of("ConsoleWindowClass", "C:\\Windows\\System32\\conhost.exe").facts.surface ==
                   SurfaceKind::kShellLike,
               "winshadow-console-window-class")) return false;
    if (!Check(surface_of("CASCADIA_HOSTING_WINDOW_CLASS", "C:\\x\\WindowsTerminal.exe").facts.surface ==
                   SurfaceKind::kShellLike,
               "winshadow-windows-terminal")) return false;
    if (!Check(surface_of("SomeClass", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
                       .facts.surface == SurfaceKind::kShellLike,
               "winshadow-powershell-process")) return false;
    if (!Check(surface_of("PseudoConsoleWindow", "C:\\a\\unknown.exe").facts.surface ==
                   SurfaceKind::kShellLike,
               "winshadow-pseudo-console")) return false;
    if (!Check(surface_of("CabinetWClass", "C:\\Windows\\explorer.exe").facts.surface ==
                   SurfaceKind::kFileBrowser,
               "winshadow-explorer")) return false;
    if (!Check(surface_of("Chrome_WidgetWin_1", "C:\\PowerToys\\PowerToys.PowerLauncher.exe")
                       .facts.surface == SurfaceKind::kCommandPalette,
               "winshadow-command-launcher")) return false;
    if (!Check(surface_of("Window", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\PowerShell_ISE.exe")
                       .facts.surface == SurfaceKind::kScriptInput,
               "winshadow-script-input")) return false;
    // OS prompts are not classified here: unknown surface, own gap, a takeover.
    for (const auto &entry : std::vector<std::pair<std::string, std::string>>{
             {"Credential Dialog Xaml Host", "C:\\Windows\\System32\\CredentialUIBroker.exe"},
             {"NativeHWNDHost", "C:\\Windows\\System32\\consent.exe"}}) {
      const ShadowFacts prompt = surface_of(entry.first, entry.second);
      if (!Check(prompt.facts.surface == SurfaceKind::kUnknown &&
                     (prompt.gaps & kShadowGapOsPromptSurface) != 0 && !prompt.facts.metadata_complete,
                 "winshadow-os-prompt-surface")) return false;
    }
    // Names are compared after folding and without case.
    if (!Check(surface_of("consolewindowclass", "C:\\x\\a.exe").facts.surface == SurfaceKind::kShellLike,
               "winshadow-surface-ignores-case")) return false;
    // A window that could not be measured is not an ordinary one.
    ShadowUiaCapture blind = UiaBase();
    blind.window_class_read = false;
    blind.process_path_read = false;
    const ShadowFacts unmeasured = BuildWindowsShadowFacts(blind, UiaRequest("type"));
    if (!Check(unmeasured.facts.surface == SurfaceKind::kUnknown &&
                   (unmeasured.gaps & kShadowGapReadFailed) != 0 && !unmeasured.facts.metadata_complete,
               "winshadow-unmeasured-window")) return false;
    ShadowUiaCapture half = UiaBase();
    half.process_path_read = false;
    const ShadowFacts partly = BuildWindowsShadowFacts(half, UiaRequest("type"));
    if (!Check((partly.gaps & kShadowGapReadFailed) != 0 && !partly.facts.metadata_complete,
               "winshadow-half-measured-window")) return false;
    // A console is a shell: a typed input there is refused by the core.
    ShadowUiaCapture console = UiaBase();
    console.window_class = "ConsoleWindowClass";
    console.chain[0] = UiaNode("Edit", "Command line");
    const ShadowRecord shell = WindowsShadowClassify(console, UiaRequest("type"), true);
    if (!Check(shell.kind == DecisionKind::kBlocked && shell.effect_class == EffectClass::kSurface,
               "winshadow-console-input-is-blocked")) return false;
  }
  // S5-c-2 PR-4: a Document in a window that is not a web window (Notepad's text area) leaves an
  // unknown origin that is not a stricter-than-v1 finding; it is counted apart. Facts and verdict
  // stay what they were. A web window's Document without a URL is still stricter.
  {
    ShadowUiaCapture native = UiaBase();
    native.chain = {UiaNode("Document", "Text editor"), UiaNode("Window", "Untitled - Notepad")};
    const ShadowFacts native_facts = BuildWindowsShadowFacts(native, UiaRequest("type"));
    const ShadowRecord native_record = WindowsShadowClassify(native, UiaRequest("type"), true);
    if (!Check(native_facts.facts.origin == OriginState::kUnknown &&
                   (native_facts.gaps & kShadowGapOrigin) != 0 &&
                   (native_facts.gaps & kShadowGapNativeDocument) == 0 &&
                   (native_record.gaps & kShadowGapNativeDocument) != 0 &&
                   native_record.kind == DecisionKind::kTakeover && !native_record.V2IsStricter() &&
                   native_record.NativeDocumentGap(),
               "winshadow-native-document-is-a-separate-gap")) return false;
    ShadowUiaCapture web = UiaBase();
    web.window_class = "Chrome_WidgetWin_1";
    web.chain = {UiaNode("Edit", "Search"), UiaNode("Document", "Shop"), UiaNode("Window", "Browser")};
    const ShadowFacts web_facts = BuildWindowsShadowFacts(web, UiaRequest("type"));
    const ShadowRecord web_record = WindowsShadowClassify(web, UiaRequest("type"), true);
    if (!Check(web_facts.facts.origin == OriginState::kUnknown &&
                   (web_record.gaps & kShadowGapNativeDocument) == 0 && web_record.V2IsStricter() &&
                   !web_record.NativeDocumentGap(),
               "winshadow-web-document-stays-stricter")) return false;
    // Another cause of the non-ordinary verdict (a secure-looking title) keeps it stricter.
    ShadowUiaCapture secret = UiaBase();
    secret.chain = {UiaNode("Document", "Text editor"), UiaNode("Window", "passwords.txt - Notepad")};
    const ShadowRecord secret_record = WindowsShadowClassify(secret, UiaRequest("type"), true);
    if (!Check(secret_record.kind != DecisionKind::kOrdinary && secret_record.V2IsStricter() &&
                   !secret_record.NativeDocumentGap(),
               "winshadow-native-document-other-cause-stays-stricter")) return false;
    // A window class that could not be read is a read gap, not a native window.
    ShadowUiaCapture blind = UiaBase();
    blind.chain = {UiaNode("Document", "Text editor"), UiaNode("Window", "Browser")};
    blind.window_class_read = false;
    const ShadowRecord blind_record = WindowsShadowClassify(blind, UiaRequest("type"), true);
    if (!Check(!blind_record.NativeDocumentGap() && (blind_record.gaps & kShadowGapNativeDocument) == 0,
               "winshadow-native-document-unread-class")) return false;
    // A download page overrides the origin: no bit.
    ShadowUiaCapture dl = UiaBase();
    dl.chain = {UiaNode("Document", "Text editor"), UiaNode("Window", "Notepad")};
    dl.document_url_read = true;
    dl.document_url = "chrome://downloads/";
    if (!Check((WindowsShadowClassify(dl, UiaRequest("type"), true).gaps & kShadowGapNativeDocument) == 0,
               "winshadow-native-document-download-override")) return false;
    // A native Document with an unknown origin AND another reason to refuse stays stricter: no bit.
    // (Canceled: a canceled capture is a skipped record and never reaches this path. Budget: an
    // exhausted capture has incomplete metadata, which refuses on its own.)
    bool other_causes_ok = true;
    const auto other_cause = [&](const char *name, const ShadowUiaCapture &capture,
                                 std::string_view language) {
      ShadowRequestInfo request = UiaRequest("type");
      request.policy_language = language;
      const ShadowFacts facts = BuildWindowsShadowFacts(capture, request);
      const ShadowRecord record = WindowsShadowClassify(capture, request, true);
      const bool ok = facts.facts.origin == OriginState::kUnknown &&
                      record.kind != DecisionKind::kOrdinary &&
                      (record.gaps & kShadowGapNativeDocument) == 0 && record.V2IsStricter() &&
                      !record.NativeDocumentGap();
      // Every case is reported (no early return), so one run names all that fail.
      if (!Check(ok, name)) other_causes_ok = false;
    };
    ShadowUiaCapture shell = UiaBase();
    shell.chain = {UiaNode("Document", "Console"), UiaNode("Window", "Command Prompt")};
    shell.window_class = "ConsoleWindowClass";
    other_cause("winshadow-native-document-shell-surface", shell, "en");
    ShadowUiaCapture prompt = UiaBase();
    prompt.chain = {UiaNode("Document", "Prompt"), UiaNode("Window", "User Account Control")};
    prompt.window_class = "NativeHWNDHost";
    prompt.process_path = "C:\\Windows\\System32\\consent.exe";
    other_cause("winshadow-native-document-os-prompt-surface", prompt, "en");
    ShadowUiaCapture budget_cut = UiaBase();
    budget_cut.chain = {UiaNode("Document", "Text editor"), UiaNode("Window", "Notepad")};
    budget_cut.budget_exhausted = true;
    other_cause("winshadow-native-document-budget", budget_cut, "en");
    other_cause("winshadow-native-document-unsupported-language", native, "fr");
    if (!Check(other_causes_ok, "winshadow-native-document-other-causes-stay-stricter"))
      return false;
  }
  // The page: a Document in the chain is a page; its URL decides the origin and the download list.
  {
    ShadowUiaCapture page = UiaBase();
    page.chain = {UiaNode("Edit", "Search"), UiaNode("Document", "Shop"), UiaNode("Window", "Browser")};
    if (!Check(BuildWindowsShadowFacts(page, UiaRequest("type")).facts.origin == OriginState::kUnknown &&
                   (BuildWindowsShadowFacts(page, UiaRequest("type")).gaps & kShadowGapOrigin) != 0,
               "winshadow-page-without-url-is-unknown-origin")) return false;
    page.document_url_read = true;
    page.document_url = "https://example.com/";
    if (!Check(BuildWindowsShadowFacts(page, UiaRequest("type")).facts.origin == OriginState::kOrdinary,
               "winshadow-page-origin")) return false;
    page.document_url = "chrome://downloads/";
    const ShadowFacts downloads = BuildWindowsShadowFacts(page, UiaRequest("invoke"));
    if (!Check(downloads.facts.surface == SurfaceKind::kDownloadPanel, "winshadow-download-page"))
      return false;
    page.document_url = "devtools://devtools/bundled/inspector.html";
    if (!Check(BuildWindowsShadowFacts(page, UiaRequest("type")).facts.surface == SurfaceKind::kDevToolsConsole,
               "winshadow-devtools-page")) return false;
    page.document_url = "ftp://example.com/";
    if (!Check(BuildWindowsShadowFacts(page, UiaRequest("type")).facts.origin == OriginState::kUnknown,
               "winshadow-unknown-scheme")) return false;
  }
  // The item an action would open: a file by its name, a folder by browsing, an unnamed one unknown.
  {
    ShadowUiaCapture item = UiaBase();
    item.window_class = "CabinetWClass";
    item.process_path = "C:\\Windows\\explorer.exe";
    item.chain = {UiaNode("ListItem", "setup.exe"), UiaNode("Window", "Downloads")};
    item.item_kind = ShadowItemKind::kFile;
    item.item_name_read = true;
    item.item_name_is_real_path = true;
    item.item_name = "C:\\Users\\a.b\\Downloads\\Setup.EXE";
    const ShadowFacts file = BuildWindowsShadowFacts(item, UiaRequest("invoke"));
    if (!Check(file.facts.target_is_file_item && file.facts.extension_known && file.facts.extension == "exe" &&
                   file.facts.surface == SurfaceKind::kFileBrowser,
               "winshadow-file-item")) return false;
    item.item_name = "C:\\dir.v2\\README";
    const ShadowFacts bare = BuildWindowsShadowFacts(item, UiaRequest("invoke"));
    if (!Check(bare.facts.target_is_file_item && !bare.facts.extension_known &&
                   (bare.gaps & kShadowGapExtensionUnknown) != 0,
               "winshadow-hidden-extension-is-unknown")) return false;
    item.item_kind = ShadowItemKind::kFolder;
    item.item_name = "C:\\Users\\a\\Downloads";
    if (!Check(!BuildWindowsShadowFacts(item, UiaRequest("invoke")).facts.target_is_file_item,
               "winshadow-folder-is-not-an-item")) return false;
    item.item_kind = ShadowItemKind::kFile;
    item.item_name_read = false;
    const ShadowFacts unnamed = BuildWindowsShadowFacts(item, UiaRequest("invoke"));
    if (!Check(unnamed.facts.target_is_file_item && !unnamed.facts.extension_known &&
                   (unnamed.gaps & kShadowGapExtensionUnknown) != 0,
               "winshadow-unnamed-file-item")) return false;
    // Opening an executable from the file manager is not ordinary.
    item.item_name_read = true;
    item.item_name_is_real_path = true;
    item.item_name = "Setup.exe";
    if (!Check(WindowsShadowClassify(item, UiaRequest("invoke"), true).kind != DecisionKind::kOrdinary,
               "winshadow-executable-open-is-not-ordinary")) return false;
  }
  // A class name inside a page is the page's string, never a subrole: an icon whose class says
  // "button" or "link" must not cut the span short and hide the "Place order" it sits in.
  {
    const auto order = [](const std::string &icon_class) {
      ShadowUiaCapture capture = UiaBase();
      ShadowUiaNode icon = UiaNode("Image", "arrow_forward");
      icon.class_name = icon_class;
      capture.chain = {icon, UiaNode("Button", "Place order"), UiaNode("Document", "Shop"),
                       UiaNode("Pane", "Chrome Legacy Window"), UiaNode("Window", "Browser")};
      capture.document_url_read = true;
      capture.document_url = "https://example.com/";
      return WindowsShadowClassify(capture, UiaRequest("click"), true);
    };
    const ShadowRecord plain = order("");
    if (!Check(plain.kind == DecisionKind::kApproval, "winshadow-place-order-needs-approval"))
      return false;
    for (const char *icon_class : {"material-icons mdc-button__icon", "link-arrow", "Button",
                                   "listitem tabitem", "HyperlinkButton"}) {
      const ShadowRecord record = order(icon_class);
      if (!Check(record.kind == plain.kind && record.effect_class == plain.effect_class,
                 "winshadow-page-class-name-cannot-shorten-the-span")) return false;
    }
    // The same class outside a page, on a native control, is the control's own subrole.
    ShadowUiaCapture native = UiaBase();
    native.chain[0] = UiaNode("Pane", "Place order");
    native.chain[0].class_name = "Button";
    if (!Check(BuildWindowsShadowFacts(native, UiaRequest("click")).facts.chain[0].subrole == "Button",
               "winshadow-native-class-is-a-subrole")) return false;
    native.chain[0].class_name = "SomeAppDefinedClass";
    if (!Check(BuildWindowsShadowFacts(native, UiaRequest("click")).facts.chain[0].subrole.empty(),
               "winshadow-unknown-class-is-no-subrole")) return false;
    // A neighbor of a target inside a page is in the page as well.
    ShadowUiaCapture caption = UiaBase();
    caption.chain = {UiaNode("Edit", "Year"), UiaNode("Document", "Checkout"), UiaNode("Window", "B")};
    caption.document_url_read = true;
    caption.document_url = "https://example.com/";
    caption.neighbors = {UiaNode("Text", "Card number")};
    caption.neighbors[0].class_name = "Button";
    if (!Check(BuildWindowsShadowFacts(caption, UiaRequest("type")).facts.neighbor_labels.size() == 1 &&
                   WindowsShadowClassify(caption, UiaRequest("type"), true).effect_class ==
                       EffectClass::kCredential,
               "winshadow-neighbor-caption-in-a-page")) return false;
  }
  // Command entries other than a terminal: Run (a #32770 owned by explorer.exe), the Explorer
  // address bar, and the Task Manager's "Run new task".
  {
    ShadowUiaCapture run = UiaBase();
    run.window_class = "#32770";
    run.process_path = "C:\\Windows\\explorer.exe";
    run.chain = {UiaNode("Edit", "Open:"), UiaNode("Window", "Run")};
    if (!Check(BuildWindowsShadowFacts(run, UiaRequest("type")).facts.surface == SurfaceKind::kCommandPalette &&
                   WindowsShadowClassify(run, UiaRequest("type"), true).kind == DecisionKind::kBlocked,
               "winshadow-run-dialog-is-a-command-entry")) return false;
    run.chain = {UiaNode("Button", "OK"), UiaNode("Window", "Run")};
    if (!Check(WindowsShadowClassify(run, UiaRequest("click"), true).kind != DecisionKind::kOrdinary,
               "winshadow-run-dialog-ok-is-not-ordinary")) return false;
    ShadowUiaCapture address = UiaBase();
    address.window_class = "CabinetWClass";
    address.process_path = "C:\\Windows\\explorer.exe";
    address.chain = {UiaNode("Edit", "Address"), UiaNode("ComboBox", "Address"),
                     UiaNode("Pane", "Address Band Root"), UiaNode("Window", "Downloads")};
    address.chain[2].class_name = "Address Band Root";
    if (!Check(BuildWindowsShadowFacts(address, UiaRequest("type")).facts.surface == SurfaceKind::kCommandPalette &&
                   WindowsShadowClassify(address, UiaRequest("type"), true).kind == DecisionKind::kBlocked,
               "winshadow-explorer-address-bar")) return false;
    ShadowUiaCapture task = UiaBase();
    task.window_class = "#32770";
    task.process_path = "C:\\Windows\\System32\\Taskmgr.exe";
    task.chain = {UiaNode("Edit", "Open"), UiaNode("Window", "Create new task")};
    if (!Check(BuildWindowsShadowFacts(task, UiaRequest("type")).facts.surface == SurfaceKind::kCommandPalette,
               "winshadow-task-manager-run-new-task")) return false;
    // A file manager nobody listed is still one when it hosts a shell view.
    ShadowUiaCapture other = UiaBase();
    other.window_class = "TTOTAL_CMD";
    other.process_path = "C:\\Tools\\TOTALCMD64.EXE";
    other.chain = {UiaNode("ListItem", "setup.exe"), UiaNode("Pane", "FolderView"), UiaNode("Window", "TC")};
    other.chain[1].class_name = "DirectUIHWND";
    if (!Check(BuildWindowsShadowFacts(other, UiaRequest("invoke")).facts.surface == SurfaceKind::kFileBrowser,
               "winshadow-shell-view-is-a-file-browser")) return false;
  }
  // A UWP window is judged by the process that owns its CoreWindow child; unreadable is unknown.
  {
    ShadowUiaCapture uwp = UiaBase();
    uwp.window_class = "ApplicationFrameWindow";
    uwp.process_path = "C:\\Windows\\System32\\ApplicationFrameHost.exe";
    uwp.chain = {UiaNode("Button", "Real-time protection"), UiaNode("Window", "Windows Security")};
    const ShadowFacts unread = BuildWindowsShadowFacts(uwp, UiaRequest("toggle"));
    if (!Check(unread.facts.surface == SurfaceKind::kUnknown && (unread.gaps & kShadowGapReadFailed) != 0 &&
                   (unread.gaps & kShadowGapOsPromptSurface) != 0 && !unread.facts.metadata_complete,
               "winshadow-frame-host-without-core-window-is-unknown")) return false;
    uwp.core_window_process_read = true;
    uwp.core_window_process_path = "C:\\Windows\\SystemApps\\Microsoft.Windows.SecHealthUI_x\\SecHealthUI.exe";
    const ShadowFacts security = BuildWindowsShadowFacts(uwp, UiaRequest("toggle"));
    if (!Check(security.facts.surface == SurfaceKind::kUnknown && (security.gaps & kShadowGapOsPromptSurface) != 0 &&
                   WindowsShadowClassify(uwp, UiaRequest("toggle"), true).kind == DecisionKind::kTakeover,
               "winshadow-windows-security-is-a-prompt-surface")) return false;
    uwp.core_window_process_path = "C:\\Windows\\ImmersiveControlPanel\\SystemSettings.exe";
    if (!Check((BuildWindowsShadowFacts(uwp, UiaRequest("toggle")).gaps & kShadowGapOsPromptSurface) != 0,
               "winshadow-settings-is-a-prompt-surface")) return false;
    uwp.core_window_process_path = "C:\\Program Files\\WindowsApps\\Calculator\\CalculatorApp.exe";
    const ShadowFacts calculator = BuildWindowsShadowFacts(uwp, UiaRequest("invoke"));
    if (!Check(calculator.facts.surface == SurfaceKind::kOrdinary && calculator.facts.metadata_complete,
               "winshadow-hosted-app-by-its-own-process")) return false;
    // Also by the host's process alone, whatever the window class says.
    ShadowUiaCapture host = UiaBase();
    host.window_class = "Windows.UI.Core.CoreWindow";
    host.process_path = "C:\\Windows\\System32\\ApplicationFrameHost.exe";
    if (!Check(BuildWindowsShadowFacts(host, UiaRequest("invoke")).facts.surface == SurfaceKind::kUnknown,
               "winshadow-frame-host-process-alone")) return false;
  }
  // Every property of a node reaches the core: a secret word that only the automation id, the help
  // text or a neighbor carries is found, and a failed read of the capture is never ignored.
  {
    ShadowUiaCapture by_id = UiaBase();
    by_id.chain[0] = UiaNode("Edit", "Field");
    by_id.chain[0].automation_id = "PasswordInput";
    if (!Check(WindowsShadowClassify(by_id, UiaRequest("type"), true).effect_class == EffectClass::kSecure,
               "winshadow-automation-id-reaches-the-core")) return false;
    ShadowUiaCapture by_help = UiaBase();
    by_help.chain[0] = UiaNode("Edit", "Field");
    by_help.chain[0].help_text = "Enter your password";
    if (!Check(WindowsShadowClassify(by_help, UiaRequest("type"), true).effect_class == EffectClass::kSecure,
               "winshadow-help-text-reaches-the-core")) return false;
    ShadowUiaCapture by_neighbor = UiaBase();
    by_neighbor.chain = {UiaNode("Edit", "Field"), UiaNode("Document", "Login"), UiaNode("Window", "B")};
    by_neighbor.document_url_read = true;
    by_neighbor.document_url = "https://example.com/";
    by_neighbor.neighbors = {UiaNode("Text", "Password")};
    if (!Check(WindowsShadowClassify(by_neighbor, UiaRequest("type"), true).effect_class == EffectClass::kSecure,
               "winshadow-neighbor-reaches-the-core")) return false;
    ShadowUiaCapture by_value = UiaBase();
    by_value.chain = {UiaNode("Edit", "Field"), UiaNode("Document", "Login"), UiaNode("Window", "B")};
    by_value.document_url_read = true;
    by_value.document_url = "https://example.com/";
    by_value.neighbors = {UiaNode("Text", "")};
    by_value.neighbors[0].value = "Password";
    if (!Check(WindowsShadowClassify(by_value, UiaRequest("type"), true).effect_class == EffectClass::kSecure,
               "winshadow-static-text-value-reaches-the-core")) return false;
    ShadowUiaCapture capture_failed = UiaBase();
    capture_failed.read_failed = true;
    const ShadowRecord failed_record = WindowsShadowClassify(capture_failed, UiaRequest("invoke"), true);
    if (!Check(failed_record.kind == DecisionKind::kTakeover && (failed_record.gaps & kShadowGapReadFailed) != 0,
               "winshadow-capture-read-failed-is-a-takeover")) return false;
    ShadowUiaCapture bad_neighbor = UiaBase();
    bad_neighbor.neighbors = {UiaNode("Text", "x")};
    bad_neighbor.neighbors[0].read_failed = true;
    if (!Check((BuildWindowsShadowFacts(bad_neighbor, UiaRequest("invoke")).gaps & kShadowGapNeighborsIncomplete) != 0,
               "winshadow-unreadable-neighbor-is-incomplete")) return false;
  }
  // Surface signals count one at a time: either the class or the process is enough, a full-width
  // spelling folds, and a path may use either separator.
  {
    const auto surface = [](bool class_read, const std::string &window_class, bool process_read,
                            const std::string &process) {
      ShadowUiaCapture capture = UiaBase();
      capture.window_class_read = class_read;
      capture.window_class = window_class;
      capture.process_path_read = process_read;
      capture.process_path = process;
      return BuildWindowsShadowFacts(capture, UiaRequest("type")).facts.surface;
    };
    if (!Check(surface(true, "CASCADIA_HOSTING_WINDOW_CLASS", true, "C:\\x\\other.exe") == SurfaceKind::kShellLike &&
                   surface(true, "Other", true, "C:\\x\\WindowsTerminal.exe") == SurfaceKind::kShellLike,
               "winshadow-terminal-class-or-process")) return false;
    if (!Check(surface(true, "Credential Dialog Xaml Host", true, "C:\\x\\other.exe") == SurfaceKind::kUnknown &&
                   surface(true, "Other", true, "C:\\x\\CredentialUIBroker.exe") == SurfaceKind::kUnknown,
               "winshadow-prompt-class-or-process")) return false;
    if (!Check(surface(true, "Other", true, "C:\\Windows\\explorer.exe") == SurfaceKind::kFileBrowser,
               "winshadow-explorer-by-process-alone")) return false;
    if (!Check(surface(true, u8"Ｃｏｎｓｏｌｅ\uFF37ｉｎｄｏｗＣｌａｓｓ"_u8, true, "C:\\x\\a.exe") == SurfaceKind::kShellLike,
               "winshadow-fullwidth-class-is-folded")) return false;
    if (!Check(surface(false, "", true, "C:/Windows/System32/cmd.exe") == SurfaceKind::kShellLike,
               "winshadow-forward-slash-path")) return false;
  }
  // A display name never gives a known extension: only the item's real name or path does.
  {
    ShadowUiaCapture item = UiaBase();
    item.window_class = "#32770";
    item.process_path = "C:\\Tools\\app.exe";
    item.chain = {UiaNode("ListItem", "invoice.pdf"), UiaNode("Window", "Open")};
    item.item_kind = ShadowItemKind::kFile;
    item.item_name_read = true;
    item.item_name = "invoice.pdf";
    const ShadowFacts display = BuildWindowsShadowFacts(item, UiaRequest("invoke"));
    if (!Check(display.facts.target_is_file_item && !display.facts.extension_known &&
                   (display.gaps & kShadowGapExtensionUnknown) != 0,
               "winshadow-display-name-gives-no-extension")) return false;
    if (!Check(WindowsShadowClassify(item, UiaRequest("invoke"), true).kind != DecisionKind::kOrdinary,
               "winshadow-display-name-open-is-not-ordinary")) return false;
    item.item_name_is_real_path = true;
    item.item_name = "C:\\Users\\a\\invoice.pdf.exe";
    const ShadowFacts real = BuildWindowsShadowFacts(item, UiaRequest("invoke"));
    if (!Check(real.facts.extension_known && real.facts.extension == "exe", "winshadow-real-name-gives-the-extension"))
      return false;
    item.item_name = "C:/Users/a/readme.txt.lnk";
    if (!Check(BuildWindowsShadowFacts(item, UiaRequest("invoke")).facts.extension == "lnk",
               "winshadow-forward-slash-item-path")) return false;
  }
  // Windows 11 (build 26200) Explorer: the address bar is XAML, measured as
  //   [Edit|TextBox] < [Group|AutoSuggestBox] < [Pane|InputSiteWindowClass]
  //   < [Pane|Microsoft.UI.Content.DesktopChildSiteBridge] < [Window|CabinetWClass]
  // with no Address Band Root, and the list is DUIListView / DUIViewWndClassName / UIItemsView.
  {
    const auto explorer = [](std::vector<ShadowUiaNode> chain) {
      ShadowUiaCapture capture = UiaBase();
      capture.window_class = "CabinetWClass";
      capture.process_path = "C:\\Windows\\explorer.exe";
      capture.chain = std::move(chain);
      return capture;
    };
    const auto with_class = [](ShadowUiaNode node, const char *class_name) {
      node.class_name = class_name;
      return node;
    };
    const ShadowUiaCapture bar = explorer(
        {with_class(UiaNode("Edit", u8"アドレス バー"_u8), "TextBox"),
         with_class(UiaNode("Group", ""), "AutoSuggestBox"),
         with_class(UiaNode("Pane", ""), "InputSiteWindowClass"),
         with_class(UiaNode("Pane", ""), "Microsoft.UI.Content.DesktopChildSiteBridge"),
         with_class(UiaNode("Window", "Downloads"), "CabinetWClass")});
    if (!Check(BuildWindowsShadowFacts(bar, UiaRequest("type")).facts.surface == SurfaceKind::kCommandPalette &&
                   WindowsShadowClassify(bar, UiaRequest("type"), true).kind == DecisionKind::kBlocked,
               "winshadow-win11-address-bar")) return false;
    // A click on its suggestion is inside the same box.
    const ShadowUiaCapture suggestion = explorer(
        {with_class(UiaNode("ListItem", "C:\\Windows"), "ListViewItem"),
         with_class(UiaNode("Group", ""), "AutoSuggestBox"),
         with_class(UiaNode("Window", "Downloads"), "CabinetWClass")});
    if (!Check(BuildWindowsShadowFacts(suggestion, UiaRequest("click")).facts.surface == SurfaceKind::kCommandPalette,
               "winshadow-win11-suggestion")) return false;
    // A text box in an Explorer window that is not in the shell view is a command entry too.
    const ShadowUiaCapture loose = explorer({UiaNode("Edit", "Search"), UiaNode("Window", "Downloads")});
    if (!Check(BuildWindowsShadowFacts(loose, UiaRequest("type")).facts.surface == SurfaceKind::kCommandPalette,
               "winshadow-explorer-edit-outside-the-shell-view")) return false;
    // A rename inside the list is not.
    const ShadowUiaCapture rename =
        explorer({UiaNode("Edit", "Name"), with_class(UiaNode("List", "Items View"), "UIItemsView"),
                  with_class(UiaNode("Pane", ""), "DUIListView"), UiaNode("Window", "Downloads")});
    if (!Check(BuildWindowsShadowFacts(rename, UiaRequest("type")).facts.surface == SurfaceKind::kFileBrowser,
               "winshadow-explorer-rename-in-the-list")) return false;
    // The measured shell view classes make any window with one a file browser.
    for (const char *view : {"DUIListView", "DUIViewWndClassName", "UIItemsView", "HWNDView"}) {
      ShadowUiaCapture other = UiaBase();
      other.window_class = "SomeFilerClass";
      other.process_path = "C:\\Tools\\filer.exe";
      other.chain = {UiaNode("ListItem", "setup.exe"), with_class(UiaNode("Pane", ""), view),
                     UiaNode("Window", "Filer")};
      if (!Check(BuildWindowsShadowFacts(other, UiaRequest("invoke")).facts.surface == SurfaceKind::kFileBrowser,
                 "winshadow-measured-shell-view-class")) return false;
    }
  }
  // The page is not trusted to say what its window is, and a web window is a page throughout.
  {
    ShadowUiaCapture page = UiaBase();
    page.window_class = "Chrome_WidgetWin_1";
    page.process_path = "C:\\Program Files\\Browser\\browser.exe";
    page.document_url_read = true;
    page.document_url = "https://example.com/";
    page.chain = {UiaNode("Button", "Open"), UiaNode("Pane", "Files"), UiaNode("Document", "Page"),
                  UiaNode("Window", "Browser")};
    page.chain[1].class_name = "DUIListView";
    if (!Check(BuildWindowsShadowFacts(page, UiaRequest("click")).facts.surface != SurfaceKind::kFileBrowser,
               "winshadow-page-class-is-not-a-surface")) return false;
    // No Document in the chain (an Electron app that did not expose one): still a page.
    ShadowUiaCapture electron = UiaBase();
    electron.window_class = "Chrome_WidgetWin_1";
    electron.process_path = "C:\\Apps\\shop.exe";
    ShadowUiaNode icon = UiaNode("Image", "arrow_forward");
    icon.class_name = "material-icons mdc-button__icon";
    electron.chain = {icon, UiaNode("Button", "Place order"), UiaNode("Pane", "Shop"), UiaNode("Window", "Shop")};
    ShadowUiaCapture clean = electron;
    clean.chain[0].class_name.clear();
    const ShadowRecord with_class_name = WindowsShadowClassify(electron, UiaRequest("click"), true);
    const ShadowRecord without = WindowsShadowClassify(clean, UiaRequest("click"), true);
    if (!Check(with_class_name.kind == without.kind && with_class_name.effect_class == without.effect_class,
               "winshadow-web-window-without-document-is-a-page")) return false;
    ShadowUiaCapture button_class = electron;
    button_class.chain[1].class_name = "Button";
    if (!Check(BuildWindowsShadowFacts(button_class, UiaRequest("click")).facts.chain[1].subrole.empty(),
               "winshadow-web-window-class-is-no-subrole")) return false;
    // A UWP core window whose path is empty was not read.
    ShadowUiaCapture uwp = UiaBase();
    uwp.window_class = "ApplicationFrameWindow";
    uwp.process_path = "C:\\Windows\\System32\\ApplicationFrameHost.exe";
    uwp.core_window_process_read = true;
    uwp.core_window_process_path = "";
    const ShadowFacts empty_path = BuildWindowsShadowFacts(uwp, UiaRequest("invoke"));
    if (!Check(empty_path.facts.surface == SurfaceKind::kUnknown && (empty_path.gaps & kShadowGapReadFailed) != 0,
               "winshadow-empty-core-window-path-is-unread")) return false;
  }
  // BOT #784: a known download page is a known origin, so a complete capture reaches the core's
  // download rule instead of stopping at an unknown origin.
  {
    for (const char *url : {"chrome://downloads/", "edge://downloads/", "brave://downloads", "about:downloads"}) {
      ShadowUiaCapture downloads = UiaBase();
      downloads.window_class = "Chrome_WidgetWin_1";
      downloads.process_path = "C:\\Program Files\\Browser\\browser.exe";
      downloads.chain = {UiaNode("Button", "Open"), UiaNode("Document", "Downloads"), UiaNode("Window", "Browser")};
      downloads.document_url_read = true;
      downloads.document_url = url;
      downloads.item_kind = ShadowItemKind::kFile;
      downloads.item_name_read = true;
      downloads.item_name_is_real_path = true;
      downloads.item_name = "C:\\Users\\a\\Downloads\\report.pdf";
      const ShadowFacts facts = BuildWindowsShadowFacts(downloads, UiaRequest("click"));
      if (!Check(facts.facts.surface == SurfaceKind::kDownloadPanel && facts.facts.origin == OriginState::kOrdinary &&
                     (facts.gaps & kShadowGapOrigin) == 0,
                 "winshadow-download-page-origin-is-known")) return false;
      if (!Check(WindowsShadowClassify(downloads, UiaRequest("click"), true).effect_class == EffectClass::kE2DownloadOpen,
                 "winshadow-download-page-reaches-e2")) return false;
    }
    // A page that merely looks similar is not one.
    ShadowUiaCapture other = UiaBase();
    other.window_class = "Chrome_WidgetWin_1";
    other.process_path = "C:\\Program Files\\Browser\\browser.exe";
    other.chain = {UiaNode("Button", "Open"), UiaNode("Document", "Page"), UiaNode("Window", "Browser")};
    other.document_url_read = true;
    other.document_url = "chrome://settings/";
    if (!Check(BuildWindowsShadowFacts(other, UiaRequest("click")).facts.origin == OriginState::kUnknown,
               "winshadow-other-browser-scheme-stays-unknown")) return false;
  }
  // BOT #784: a window class or process that was not read must leave a gap on every route to a
  // surface, including the ones that return early (Run, the address bar, the Task Manager).
  {
    const auto run = [](bool class_read, bool process_read) {
      ShadowUiaCapture capture = UiaBase();
      capture.window_class_read = class_read;
      capture.window_class = class_read ? "#32770" : "";
      capture.process_path_read = process_read;
      capture.process_path = process_read ? "C:\\Windows\\explorer.exe" : "";
      capture.chain = {UiaNode("Edit", "Open:"), UiaNode("Window", "Run")};
      return capture;
    };
    for (const auto &flags : std::vector<std::pair<bool, bool>>{{false, true}, {true, false}}) {
      const ShadowUiaCapture capture = run(flags.first, flags.second);
      const ShadowFacts facts = BuildWindowsShadowFacts(capture, UiaRequest("type"));
      if (!Check((facts.gaps & kShadowGapReadFailed) != 0 && !facts.facts.metadata_complete &&
                     WindowsShadowClassify(capture, UiaRequest("type"), true).kind != DecisionKind::kOrdinary,
                 "winshadow-run-dialog-with-an-unread-class-or-process")) return false;
    }
    ShadowUiaCapture address = run(false, true);
    address.chain = {UiaNode("Edit", "Address"), UiaNode("Pane", "Address Band Root"), UiaNode("Window", "Downloads")};
    address.chain[1].class_name = "Address Band Root";
    const ShadowFacts address_facts = BuildWindowsShadowFacts(address, UiaRequest("type"));
    if (!Check(address_facts.facts.surface == SurfaceKind::kCommandPalette &&
                   (address_facts.gaps & kShadowGapReadFailed) != 0 && !address_facts.facts.metadata_complete,
               "winshadow-address-bar-with-an-unread-class")) return false;
    ShadowUiaCapture task = UiaBase();
    task.window_class_read = false;
    task.window_class = "";
    task.process_path = "C:\\Windows\\System32\\Taskmgr.exe";
    task.chain = {UiaNode("Edit", "Open"), UiaNode("Window", "Create new task")};
    const ShadowFacts task_facts = BuildWindowsShadowFacts(task, UiaRequest("type"));
    if (!Check(task_facts.facts.surface == SurfaceKind::kCommandPalette &&
                   (task_facts.gaps & kShadowGapReadFailed) != 0 && !task_facts.facts.metadata_complete,
               "winshadow-task-manager-with-an-unread-class")) return false;
    ShadowUiaCapture console = UiaBase();
    console.window_class = "ConsoleWindowClass";
    console.process_path_read = false;
    console.process_path = "";
    console.chain = {UiaNode("Edit", "Command line"), UiaNode("Window", "Console")};
    const ShadowFacts console_facts = BuildWindowsShadowFacts(console, UiaRequest("type"));
    if (!Check(console_facts.facts.surface == SurfaceKind::kShellLike &&
                   (console_facts.gaps & kShadowGapReadFailed) != 0,
               "winshadow-console-with-an-unread-process")) return false;
  }
  // BOT #784: a web window is a page whether or not a Document was exposed, so its origin is built
  // the same way: a URL that was not read, or a missing near caption, is not "not applicable".
  {
    ShadowUiaCapture electron = UiaBase();
    electron.window_class = "Chrome_WidgetWin_1";
    electron.process_path = "C:\\Apps\\app.exe";
    electron.chain = {UiaNode("Edit", "Field"), UiaNode("Pane", "App"), UiaNode("Window", "App")};
    electron.neighbors_complete = false;
    const ShadowFacts unread = BuildWindowsShadowFacts(electron, UiaRequest("type"));
    if (!Check(unread.facts.origin == OriginState::kUnknown && (unread.gaps & kShadowGapOrigin) != 0 &&
                   (unread.gaps & kShadowGapNeighborsIncomplete) != 0 &&
                   WindowsShadowClassify(electron, UiaRequest("type"), true).kind != DecisionKind::kOrdinary,
               "winshadow-web-window-without-document-has-an-origin")) return false;
    electron.document_url_read = true;
    electron.document_url = "https://example.com/";
    if (!Check(BuildWindowsShadowFacts(electron, UiaRequest("type")).facts.origin == OriginState::kOrdinary,
               "winshadow-web-window-origin-from-its-url")) return false;
    ShadowUiaCapture firefox = electron;
    firefox.window_class = "MozillaWindowClass";
    firefox.document_url_read = false;
    if (!Check(BuildWindowsShadowFacts(firefox, UiaRequest("type")).facts.origin == OriginState::kUnknown,
               "winshadow-gecko-window-without-document-has-an-origin")) return false;
    // A native window is not a page.
    ShadowUiaCapture native = UiaBase();
    if (!Check(BuildWindowsShadowFacts(native, UiaRequest("type")).facts.origin == OriginState::kNotApplicable,
               "winshadow-native-window-has-no-origin")) return false;
  }
  // An unsupported action kind is a gap and never ordinary.
  {
    const ShadowFacts odd = BuildWindowsShadowFacts(UiaBase(), UiaRequest("drag"));
    if (!Check((odd.gaps & kShadowGapUnsupportedAction) != 0 && !odd.facts.metadata_complete,
               "winshadow-unsupported-action")) return false;
  }
  std::cout << "Computer Use native Windows shadow core: PASS\n";
  return true;
}

// ---- The shared read helpers: one string, one gate, one ring -----------------------------------

bool CheckShadowReadHelpers() {
  // The byte bound is on the converted UTF-8, never truncated, never emptied.
  std::string out;
  const std::string japanese_170 = [] {
    std::string text;
    for (int index = 0; index < 170; ++index) text += u8"あ"_u8;
    return text;
  }();
  const std::string japanese_171 = japanese_170 + u8"あ"_u8;
  if (!Check(japanese_170.size() == 510 && japanese_171.size() == 513, "shadowread-fixture")) return false;
  if (!Check(ShadowCheckText(japanese_170, kEffectMaxLabelBytes, &out) == ShadowReadResult::kOk &&
                 out == japanese_170,
             "shadowread-fits-by-bytes")) return false;
  out = "keep";
  if (!Check(ShadowCheckText(japanese_171, kEffectMaxLabelBytes, &out) == ShadowReadResult::kTooLong &&
                 out == "keep",
             "shadowread-too-long-by-bytes-and-untouched")) return false;
  if (!Check(ShadowCheckText(std::string(kEffectMaxLabelBytes, 'a'), kEffectMaxLabelBytes, &out) ==
                 ShadowReadResult::kOk,
             "shadowread-exact-bound")) return false;
  if (!Check(ShadowCheckText(std::string(kEffectMaxLabelBytes + 1, 'a'), kEffectMaxLabelBytes, &out) ==
                 ShadowReadResult::kTooLong,
             "shadowread-bound-plus-one")) return false;
  if (!Check(ShadowCheckText("", kEffectMaxLabelBytes, &out) == ShadowReadResult::kAbsent,
             "shadowread-empty-is-absent")) return false;
  if (!Check(ShadowCheckText(std::string("a\xE3\x81"), kEffectMaxLabelBytes, &out) == ShadowReadResult::kFailed,
             "shadowread-malformed-is-failed")) return false;
  if (!Check(!ShadowUnitsTooLong(512, 512) && ShadowUnitsTooLong(513, 512), "shadowread-units")) return false;

  // Settle: only kOk is true; everything but absent leaves a flag, and a too-long one is kept apart
  // when the caller keeps one.
  for (const ShadowReadResult result : {ShadowReadResult::kOk, ShadowReadResult::kAbsent,
                                        ShadowReadResult::kFailed, ShadowReadResult::kTooLong,
                                        ShadowReadResult::kStopped}) {
    bool failed = false;
    bool too_long = false;
    const bool ok = ShadowSettle(result, &failed, &too_long);
    const bool expect_ok = result == ShadowReadResult::kOk;
    const bool expect_failed = result == ShadowReadResult::kFailed || result == ShadowReadResult::kStopped;
    const bool expect_long = result == ShadowReadResult::kTooLong;
    if (!Check(ok == expect_ok && failed == expect_failed && too_long == expect_long, "shadowread-settle"))
      return false;
    bool failed_only = false;
    (void)ShadowSettle(result, &failed_only);
    if (!Check(failed_only == (expect_failed || expect_long), "shadowread-settle-without-too-long-flag"))
      return false;
  }

  // The gate: admits while the action is valid and the budget lasts, refuses for good after.
  {
    ShadowGate gate(1'000);
    if (!Check(gate.Step(1'000, true) && gate.Calls() == 1 && gate.Gaps() == 0, "shadowgate-first-step"))
      return false;
    if (!Check(!gate.Step(1'001, false) && gate.Canceled() && (gate.Gaps() & kShadowGapCanceled) != 0,
               "shadowgate-cancel")) return false;
    if (!Check(!gate.Step(1'002, true), "shadowgate-stays-stopped-after-cancel")) return false;
  }
  {
    ShadowGate gate(0);
    bool all = true;
    for (std::uint32_t call = 0; call < kShadowMaxAxCalls; ++call) all = all && gate.Step(1, true);
    if (!Check(all && gate.Calls() == kShadowMaxAxCalls && !gate.BudgetExhausted(), "shadowgate-spends-all-calls"))
      return false;
    if (!Check(!gate.Step(2, true) && gate.BudgetExhausted() && (gate.Gaps() & kShadowGapBudget) != 0 &&
                   !gate.Canceled(),
               "shadowgate-call-budget")) return false;
    if (!Check(!gate.Step(3, true), "shadowgate-budget-is-final")) return false;
  }
  {
    ShadowGate gate(10);
    if (!Check(gate.Step(10 + kShadowDeadlineNs, true), "shadowgate-at-deadline")) return false;
    if (!Check(!gate.Step(11 + kShadowDeadlineNs, true) && (gate.Gaps() & kShadowGapBudget) != 0,
               "shadowgate-deadline")) return false;
  }
  {
    // A canceled action that is also past the deadline is a cancel (checked first): the record is
    // skipped, not a comparison.
    ShadowGate both(0);
    if (!Check(!both.Step(kShadowDeadlineNs + 1, false) && both.Canceled() && !both.BudgetExhausted() &&
                   (both.Gaps() & kShadowGapBudget) == 0,
               "shadowgate-cancel-before-budget")) return false;
    ShadowGate gate(0);
    if (!Check(!gate.Step(kShadowDeadlineNs + 1, true) && gate.BudgetExhausted() && !gate.Canceled(),
               "shadowgate-deadline-first")) return false;
  }

  // The ring of the process is one object that is never destroyed.
  {
    EffectShadowLog &first = ProcessShadowLog();
    EffectShadowLog &second = ProcessShadowLog();
    const std::uint64_t before = first.Total();
    first.Record(ShadowSkippedRecord("click", kShadowGapBusy, true));
    if (!Check(&first == &second && second.Total() == before + 1, "shadowlog-process-ring-is-one-object"))
      return false;
  }
  std::cout << "Computer Use native shadow read helpers: PASS\n";
  return true;
}

// ---- Windows shadow reader (S5-b-2a): the walk, against a fake UI Automation tree ---------------
// The reader is portable; only the source that talks to UI Automation is Windows. This fake tree
// stands in for it, and counts every call so that "every call was admitted by the gate" is a number.

struct FakeUiaNode {
  int parent = -1;
  std::vector<int> children;
  std::string control_type = "Pane";
  std::string class_name;
  std::string name;
  std::string automation_id;
  std::string help_text;
  bool password = false;
  bool has_url = false;
  std::string url;
  bool has_item = false;
  std::string item_path;
  bool item_is_folder = false;
  ShadowReadResult name_result = ShadowReadResult::kOk;
  ShadowReadResult id_result = ShadowReadResult::kOk;
  // The class read that fails (1 = the first one), counted per node; 0 = none.
  int class_fails_on_read = 0;
  int class_reads = 0;
  ShadowReadResult password_result = ShadowReadResult::kOk;
  ShadowReadResult parent_result = ShadowReadResult::kOk;
  ShadowReadResult children_result = ShadowReadResult::kOk;
  ShadowReadResult url_result = ShadowReadResult::kOk;
  ShadowReadResult item_result = ShadowReadResult::kOk;
};

class FakeUia final : public ShadowUiaSource {
public:
  std::vector<FakeUiaNode> nodes;
  int root = 0;
  int point = -1;
  int focused = -1;
  std::string process_path = "C:\\Windows\\System32\\notepad.exe";
  ShadowReadResult process_result = ShadowReadResult::kOk;
  std::string core_path;
  ShadowReadResult core_result = ShadowReadResult::kOk;
  ShadowReadResult root_result = ShadowReadResult::kOk;
  ShadowReadResult point_result = ShadowReadResult::kOk;
  ShadowReadResult focus_result = ShadowReadResult::kOk;
  // A comparison that involves this node fails (-1 = none).
  int same_fails_with = -1;
  std::uint64_t now = 1'000'000;
  std::uint64_t step_ns = 0;
  long cancel_after = -1;
  long calls = 0;
  long core_calls = 0;
  long item_calls = 0;
  long url_calls = 0;
  Element last_tab = kNoElement;
  // Time that passes inside the shell lookup (a slow Explorer).
  std::uint64_t item_delay_ns = 0;

  int Add(int parent, const std::string &control, const std::string &name = "",
          const std::string &class_name = "") {
    FakeUiaNode node;
    node.parent = parent;
    node.control_type = control;
    node.name = name;
    node.class_name = class_name;
    nodes.push_back(node);
    const int index = static_cast<int>(nodes.size()) - 1;
    if (parent >= 0) nodes[static_cast<std::size_t>(parent)].children.push_back(index);
    return index;
  }

  bool ActionStillValid() override { return cancel_after < 0 || calls < cancel_after; }
  std::uint64_t NowNs() override { return now; }

  ShadowReadResult Root(Element *output) override {
    Tick();
    if (root_result != ShadowReadResult::kOk) return root_result;
    *output = static_cast<Element>(root);
    return ShadowReadResult::kOk;
  }
  ShadowReadResult AtPoint(Element *output) override { return Pick(point, point_result, output); }
  ShadowReadResult Focused(Element *output) override { return Pick(focused, focus_result, output); }
  ShadowReadResult Parent(Element element, Element *output) override {
    Tick();
    const FakeUiaNode &node = nodes[element];
    if (node.parent_result != ShadowReadResult::kOk) return node.parent_result;
    if (node.parent < 0) return ShadowReadResult::kAbsent;
    *output = static_cast<Element>(node.parent);
    return ShadowReadResult::kOk;
  }
  ShadowReadResult FirstChild(Element element, Element *output) override {
    Tick();
    const FakeUiaNode &node = nodes[element];
    if (node.children_result != ShadowReadResult::kOk) return node.children_result;
    if (node.children.empty()) return ShadowReadResult::kAbsent;
    *output = static_cast<Element>(node.children.front());
    return ShadowReadResult::kOk;
  }
  ShadowReadResult NextSibling(Element element, Element *output) override {
    Tick();
    const FakeUiaNode &node = nodes[element];
    if (node.parent < 0) return ShadowReadResult::kAbsent;
    const std::vector<int> &siblings = nodes[static_cast<std::size_t>(node.parent)].children;
    for (std::size_t index = 0; index + 1 < siblings.size(); ++index)
      if (siblings[index] == static_cast<int>(element)) {
        *output = static_cast<Element>(siblings[index + 1]);
        return ShadowReadResult::kOk;
      }
    return ShadowReadResult::kAbsent;
  }
  ShadowReadResult Same(Element first, Element second, bool *same) override {
    Tick();
    if (same_fails_with >= 0 && (static_cast<int>(first) == same_fails_with ||
                                 static_cast<int>(second) == same_fails_with))
      return ShadowReadResult::kFailed;
    *same = first == second;
    return ShadowReadResult::kOk;
  }
  ShadowReadResult Text(Element element, ShadowUiaText what, bool, std::size_t maximum_bytes,
                        std::string *output) override {
    Tick();
    FakeUiaNode &node = nodes[element];
    const std::string *value = &node.control_type;
    switch (what) {
    case ShadowUiaText::kControlType: value = &node.control_type; break;
    case ShadowUiaText::kClassName:
      if (++node.class_reads == node.class_fails_on_read) return ShadowReadResult::kFailed;
      value = &node.class_name;
      break;
    case ShadowUiaText::kName:
      if (node.name_result != ShadowReadResult::kOk) return node.name_result;
      value = &node.name;
      break;
    case ShadowUiaText::kAutomationId:
      if (node.id_result != ShadowReadResult::kOk) return node.id_result;
      value = &node.automation_id;
      break;
    case ShadowUiaText::kHelpText: value = &node.help_text; break;
    }
    return ShadowCheckText(*value, maximum_bytes, output);
  }
  ShadowReadResult IsPassword(Element element, bool *is_password) override {
    Tick();
    const FakeUiaNode &node = nodes[element];
    if (node.password_result != ShadowReadResult::kOk) return node.password_result;
    *is_password = node.password;
    return ShadowReadResult::kOk;
  }
  ShadowReadResult DocumentUrl(Element element, std::size_t maximum_bytes,
                               std::string *output) override {
    Tick();
    ++url_calls;
    const FakeUiaNode &node = nodes[element];
    if (node.url_result != ShadowReadResult::kOk) return node.url_result;
    if (!node.has_url) return ShadowReadResult::kAbsent;
    return ShadowCheckText(node.url, maximum_bytes, output);
  }
  ShadowReadResult WindowProcessPath(Element, std::size_t maximum_bytes,
                                     std::string *output) override {
    Tick();
    if (process_result != ShadowReadResult::kOk) return process_result;
    return ShadowCheckText(process_path, maximum_bytes, output);
  }
  ShadowReadResult CoreWindowProcessPath(Element, std::size_t maximum_bytes,
                                         std::string *output) override {
    Tick();
    ++core_calls;
    if (core_result != ShadowReadResult::kOk) return core_result;
    return ShadowCheckText(core_path, maximum_bytes, output);
  }
  ShadowReadResult ItemPath(Element element, Element tab, std::size_t maximum_bytes, std::string *path,
                            bool *is_folder) override {
    Tick();
    ++item_calls;
    last_tab = tab;
    now += item_delay_ns;
    const FakeUiaNode &node = nodes[element];
    if (node.item_result != ShadowReadResult::kOk) return node.item_result;
    if (!node.has_item) return ShadowReadResult::kAbsent;
    *is_folder = node.item_is_folder;
    return ShadowCheckText(node.item_path, maximum_bytes, path);
  }

private:
  void Tick() {
    ++calls;
    now += step_ns;
  }
  ShadowReadResult Pick(int index, ShadowReadResult result, Element *output) {
    Tick();
    if (result != ShadowReadResult::kOk) return result;
    if (index < 0) return ShadowReadResult::kAbsent;
    *output = static_cast<Element>(index);
    return ShadowReadResult::kOk;
  }
};

// A window with a form: Window(root) > Pane > [Text "Name", Edit(target), Text "Required"].
struct FakeForm {
  FakeUia source;
  int desktop = 0;
  int window = 0;
  int pane = 0;
  int caption = 0;
  int edit = 0;
  int hint = 0;
  FakeForm() {
    desktop = source.Add(-1, "Pane", "Desktop");
    window = source.Add(desktop, "Window", "Form", "Notepad");
    pane = source.Add(window, "Pane");
    caption = source.Add(pane, "Text", "Name");
    edit = source.Add(pane, "Edit", "Name field", "Edit");
    hint = source.Add(pane, "Text", "Required");
    source.nodes[static_cast<std::size_t>(edit)].automation_id = "name";
    source.root = window;
    source.point = edit;
    source.focused = edit;
  }
  FakeUiaNode &Node(int index) { return source.nodes[static_cast<std::size_t>(index)]; }
};

// A form in a file browser: Window(CabinetWClass, explorer.exe) > List(UIItemsView) > ListItem.
struct FakeExplorer {
  FakeForm form;
  int item = 0;
  int tab = -1;
  explicit FakeExplorer(const std::string &name, bool with_tab = false) {
    form.Node(form.window).class_name = "CabinetWClass";
    form.source.process_path = "C:\\Windows\\explorer.exe";
    int parent = form.window;
    if (with_tab) {
      tab = form.source.Add(form.window, "Pane", "Tab", "ShellTabWindowClass");
      parent = tab;
    }
    const int list = form.source.Add(parent, "List", "Items", "UIItemsView");
    item = form.source.Add(list, "ListItem", name, "UIItem");
    form.source.point = item;
  }
  void GiveRealPath(const std::string &path, bool folder = false) {
    form.Node(item).has_item = true;
    form.Node(item).item_path = path;
    form.Node(item).item_is_folder = folder;
  }
};

bool CheckWindowsShadowReader() {
  // A click on a field: the target, its parents up to the bound window, the other children of the
  // parent, the window class and the process. Every source call was admitted by the gate.
  {
    FakeForm form;
    WindowsShadowReader reader(form.source);
    const ShadowUiaCapture capture = reader.Capture("click", "");
    if (!Check(capture.target_found && capture.chain.size() == 3 && capture.chain[0].control_type == "Edit" &&
                   capture.chain[0].name == "Name field" && capture.chain[0].automation_id == "name" &&
                   capture.chain[1].control_type == "Pane" && capture.chain[2].control_type == "Window" &&
                   capture.chain_reached_root,
               "winreader-click-chain")) return false;
    if (!Check(capture.neighbors.size() == 2 && capture.neighbors_complete &&
                   capture.neighbors[0].name == "Name" && capture.neighbors[1].name == "Required",
               "winreader-click-neighbors-without-the-target")) return false;
    if (!Check(capture.window_class_read && capture.window_class == "Notepad" && capture.process_path_read &&
                   capture.process_path == form.source.process_path && !capture.core_window_process_read &&
                   form.source.core_calls == 0,
               "winreader-window-facts-and-no-core-window-read")) return false;
    if (!Check(!capture.read_failed && !capture.budget_exhausted && !reader.Canceled() &&
                   form.source.calls == static_cast<long>(reader.Gate().Calls()),
               "winreader-every-call-is-gated")) return false;
    const ShadowRecord record = WindowsShadowClassify(capture, UiaRequest("click"), true);
    if (!Check(record.gaps == 0 && record.kind == DecisionKind::kOrdinary,
               "winreader-complete-capture-is-ordinary")) return false;
  }
  // type / key read the focused element; an unknown kind reads no target at all.
  {
    FakeForm form;
    WindowsShadowReader reader(form.source);
    const ShadowUiaCapture typed = reader.Capture("type", "");
    if (!Check(typed.target_found && typed.chain[0].control_type == "Edit", "winreader-type-reads-focused"))
      return false;
    FakeForm other;
    WindowsShadowReader other_reader(other.source);
    const ShadowUiaCapture unknown = other_reader.Capture("observe", "");
    if (!Check(!unknown.target_found && unknown.chain.empty() && other.source.calls <= 1,
               "winreader-unknown-kind-reads-no-target")) return false;
    FakeForm none;
    none.source.focused = -1;
    WindowsShadowReader none_reader(none.source);
    if (!Check(!none_reader.Capture("key", "").target_found, "winreader-no-focus-is-not-found")) return false;
  }
  // The semantic search matches what v1 matches: an id equal to the target id, or a name when there
  // is no id. Two matches are none. A node that cannot be read makes the search incomplete.
  {
    FakeForm form;
    WindowsShadowReader reader(form.source);
    const ShadowUiaCapture found = reader.Capture("invoke", "name");
    if (!Check(found.target_found && found.chain[0].control_type == "Edit", "winreader-search-by-id"))
      return false;
    FakeForm by_name;
    WindowsShadowReader by_name_reader(by_name.source);
    if (!Check(by_name_reader.Capture("invoke", "Required").target_found, "winreader-search-by-name-without-id"))
      return false;
    FakeForm named_with_id;
    WindowsShadowReader named_reader(named_with_id.source);
    // The edit has an id, so its name does not count.
    if (!Check(!named_reader.Capture("invoke", "Name field").target_found, "winreader-name-does-not-count-with-an-id"))
      return false;
    FakeForm duplicate;
    const int twin = duplicate.source.Add(duplicate.pane, "Edit", "Other");
    duplicate.Node(twin).automation_id = "name";
    WindowsShadowReader duplicate_reader(duplicate.source);
    const ShadowUiaCapture two = duplicate_reader.Capture("invoke", "name");
    if (!Check(!two.target_found && two.chain.empty() && !two.read_failed, "winreader-two-matches-are-none"))
      return false;
    FakeForm broken;
    broken.Node(broken.caption).name_result = ShadowReadResult::kFailed;
    WindowsShadowReader broken_reader(broken.source);
    const ShadowUiaCapture incomplete = broken_reader.Capture("invoke", "name");
    if (!Check(!incomplete.target_found && incomplete.read_failed, "winreader-unreadable-node-makes-search-incomplete"))
      return false;
    FakeForm id_broken;
    id_broken.Node(id_broken.hint).id_result = ShadowReadResult::kFailed;
    WindowsShadowReader id_reader(id_broken.source);
    const ShadowUiaCapture id_incomplete = id_reader.Capture("invoke", "name");
    if (!Check(!id_incomplete.target_found && id_incomplete.read_failed, "winreader-unreadable-id-makes-search-incomplete"))
      return false;
    FakeForm children_failed;
    children_failed.Node(children_failed.pane).children_result = ShadowReadResult::kFailed;
    WindowsShadowReader children_reader(children_failed.source);
    const ShadowUiaCapture cut = children_reader.Capture("invoke", "name");
    if (!Check(!cut.target_found && cut.read_failed, "winreader-unreadable-children-make-search-incomplete"))
      return false;
    // A search that cannot even start (no window) finds nothing, with a gap.
    FakeForm no_class;
    no_class.Node(no_class.window).class_fails_on_read = 1;
    WindowsShadowReader no_class_reader(no_class.source);
    const ShadowUiaCapture classless = no_class_reader.Capture("click", "");
    if (!Check(!classless.window_class_read && classless.read_failed && !classless.chain[2].read_failed, "winreader-unread-window-class-is-a-gap"))
      return false;
    FakeForm no_root;
    no_root.source.root_result = ShadowReadResult::kFailed;
    WindowsShadowReader no_root_reader(no_root.source);
    const ShadowUiaCapture lost = no_root_reader.Capture("invoke", "name");
    if (!Check(!lost.target_found && lost.read_failed, "winreader-no-window-is-a-gap")) return false;
  }
  // A string that is too long is oversize, never empty; a failed read is a failed node.
  {
    FakeForm form;
    form.Node(form.edit).name = std::string(kEffectMaxLabelBytes + 1, 'a');
    WindowsShadowReader reader(form.source);
    const ShadowUiaCapture capture = reader.Capture("click", "");
    if (!Check(capture.chain[0].oversize && capture.chain[0].name.empty() && !capture.chain[0].read_failed,
               "winreader-oversize-name-is-flagged")) return false;
    const ShadowRecord record = WindowsShadowClassify(capture, UiaRequest("click"), true);
    if (!Check((record.gaps & kShadowGapOversize) != 0 && record.kind != DecisionKind::kOrdinary,
               "winreader-oversize-is-not-ordinary")) return false;
    FakeForm failed;
    failed.Node(failed.edit).name_result = ShadowReadResult::kFailed;
    WindowsShadowReader failed_reader(failed.source);
    const ShadowUiaCapture bad = failed_reader.Capture("click", "");
    if (!Check(bad.chain[0].read_failed && !bad.chain[0].oversize, "winreader-failed-read-is-flagged")) return false;
    FakeForm password_failed;
    password_failed.Node(password_failed.edit).password_result = ShadowReadResult::kFailed;
    WindowsShadowReader password_reader(password_failed.source);
    const ShadowUiaCapture unknown_password = password_reader.Capture("click", "");
    if (!Check(unknown_password.chain[0].read_failed && !unknown_password.chain[0].is_password,
               "winreader-unreadable-password-flag-is-a-failed-node")) return false;
    FakeForm secure;
    secure.Node(secure.edit).password = true;
    WindowsShadowReader secure_reader(secure.source);
    const ShadowUiaCapture secret = secure_reader.Capture("type", "");
    if (!Check(secret.chain[0].is_password, "winreader-password-flag-is-kept")) return false;
  }
  // A chain that does not arrive at the bound window is cut short; so is a parent that fails.
  {
    FakeForm form;
    int tip = form.pane;
    for (int level = 0; level < 14; ++level) tip = form.source.Add(tip, "Group");
    form.source.point = tip;
    WindowsShadowReader reader(form.source);
    const ShadowUiaCapture deep = reader.Capture("click", "");
    if (!Check(deep.chain.size() == kShadowMaxCaptureNodes && !deep.chain_reached_root, "winreader-chain-cap"))
      return false;
    FakeForm failed;
    failed.Node(failed.pane).parent_result = ShadowReadResult::kFailed;
    WindowsShadowReader failed_reader(failed.source);
    const ShadowUiaCapture cut = failed_reader.Capture("click", "");
    if (!Check(cut.chain.size() == 2 && !cut.chain_reached_root && cut.read_failed,
               "winreader-failed-parent-cuts-the-chain")) return false;
    const ShadowRecord record = WindowsShadowClassify(cut, UiaRequest("click"), true);
    if (!Check(record.kind != DecisionKind::kOrdinary, "winreader-cut-chain-is-not-ordinary")) return false;
    // The target is the bound window itself: the chain is that one node.
    FakeForm window_itself;
    window_itself.source.point = window_itself.window;
    WindowsShadowReader window_reader(window_itself.source);
    const ShadowUiaCapture only = window_reader.Capture("click", "");
    if (!Check(only.chain.size() == 1 && only.chain_reached_root, "winreader-target-is-the-window")) return false;
  }
  // The neighbors: bounded, never including the target, incomplete when cut off.
  {
    FakeForm form;
    for (int extra = 0; extra < 40; ++extra) form.source.Add(form.pane, "Text", "caption");
    WindowsShadowReader reader(form.source);
    const ShadowUiaCapture capture = reader.Capture("click", "");
    if (!Check(capture.neighbors.size() == kEffectMaxNeighborLabels && !capture.neighbors_complete &&
                   capture.target_found,
               "winreader-neighbors-are-bounded-and-incomplete")) return false;
    FakeForm failed;
    failed.Node(failed.pane).children_result = ShadowReadResult::kFailed;
    WindowsShadowReader failed_reader(failed.source);
    // The target is found by point, so only the sibling listing fails.
    const ShadowUiaCapture none = failed_reader.Capture("click", "");
    if (!Check(none.target_found && !none.neighbors_complete && none.neighbors.empty() && none.read_failed,
               "winreader-failed-sibling-list-is-incomplete")) return false;
  }
  // Cancellation: once the action stops being valid nothing more is read (not one more call), the
  // capture is flagged as canceled, and what was gathered is incomplete.
  for (long after = 0; after < 40; after += 3) {
    FakeForm form;
    form.source.cancel_after = after;
    WindowsShadowReader reader(form.source);
    const ShadowUiaCapture capture = reader.Capture("click", "");
    if (!Check(form.source.calls == after && reader.Canceled() &&
                   form.source.calls == static_cast<long>(reader.Gate().Calls()),
               "winreader-cancel-stops-every-call")) return false;
    if (!Check(!(capture.chain_reached_root && capture.neighbors_complete && !capture.read_failed),
               "winreader-canceled-capture-is-incomplete")) return false;
  }
  {
    FakeForm form;
    form.source.cancel_after = 1000;
    WindowsShadowReader reader(form.source);
    (void)reader.Capture("click", "");
    if (!Check(!reader.Canceled(), "winreader-not-canceled-when-valid")) return false;
  }
  // The budget: the call count and the deadline stop the walk for good, and say so.
  {
    FakeForm form;
    for (int extra = 0; extra < 2000; ++extra) form.source.Add(form.pane, "Group");
    // The search of a name that is not there walks everything: bounded by the call budget.
    WindowsShadowReader reader(form.source);
    const ShadowUiaCapture search = reader.Capture("invoke", "nothing-by-this-name");
    if (!Check(!search.target_found && search.budget_exhausted && search.read_failed &&
                   form.source.calls <= static_cast<long>(kShadowMaxAxCalls) &&
                   form.source.calls == static_cast<long>(reader.Gate().Calls()),
               "winreader-call-budget-bounds-the-search")) return false;
    FakeForm slow;
    slow.source.step_ns = kShadowDeadlineNs / 4;
    WindowsShadowReader slow_reader(slow.source);
    const ShadowUiaCapture late = slow_reader.Capture("click", "");
    if (!Check(late.budget_exhausted && slow.source.calls <= 6 && !(late.chain_reached_root && late.neighbors_complete),
               "winreader-deadline-bounds-the-walk")) return false;
    const ShadowRecord record = WindowsShadowClassify(late, UiaRequest("click"), true);
    if (!Check((record.gaps & kShadowGapBudget) != 0 && record.kind != DecisionKind::kOrdinary,
               "winreader-budget-is-not-ordinary")) return false;
  }
  // The page: the Document in the chain gives the URL; one that is not published is not read.
  {
    FakeForm form;
    form.Node(form.window).class_name = "Chrome_WidgetWin_1";
    form.source.process_path = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    const int document = form.source.Add(form.window, "Document", "Page");
    form.Node(document).has_url = true;
    form.Node(document).url = "https://example.com/form";
    const int field = form.source.Add(document, "Edit", "Email");
    form.source.point = field;
    WindowsShadowReader reader(form.source);
    const ShadowUiaCapture capture = reader.Capture("click", "");
    if (!Check(capture.document_url_read && capture.document_url == "https://example.com/form" &&
                   capture.chain_reached_root,
               "winreader-document-url")) return false;
    FakeForm silent;
    silent.Node(silent.window).class_name = "Chrome_WidgetWin_1";
    silent.source.process_path = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    const int silent_doc = silent.source.Add(silent.window, "Document", "Page");
    const int silent_field = silent.source.Add(silent_doc, "Edit", "Email");
    silent.source.point = silent_field;
    WindowsShadowReader silent_reader(silent.source);
    const ShadowUiaCapture unknown = silent_reader.Capture("click", "");
    if (!Check(!unknown.document_url_read && !unknown.read_failed, "winreader-unpublished-url-is-absent")) return false;
    const ShadowRecord record = WindowsShadowClassify(unknown, UiaRequest("click"), true);
    if (!Check((record.gaps & kShadowGapOrigin) != 0 && record.kind != DecisionKind::kOrdinary,
               "winreader-unknown-origin-is-not-ordinary")) return false;
    // A target that is not in a page reads no URL at all.
    FakeForm plain;
    WindowsShadowReader plain_reader(plain.source);
    (void)plain_reader.Capture("click", "");
    if (!Check(plain.source.url_calls == 0, "winreader-no-url-read-outside-a-page")) return false;
    // A Document of an editor is its text, not an address: nothing is read from it, and its origin
    // stays unknown (a gap, never an empty URL).
    FakeForm editor;
    const int editor_doc = editor.source.Add(editor.window, "Document", "Text editor");
    editor.Node(editor_doc).has_url = true;
    editor.Node(editor_doc).url = "the text of the document";
    editor.source.point = editor_doc;
    WindowsShadowReader editor_reader(editor.source);
    const ShadowUiaCapture text = editor_reader.Capture("click", "");
    if (!Check(editor.source.url_calls == 0 && !text.document_url_read && text.document_url.empty() &&
                   !text.read_failed,
               "winreader-no-document-value-outside-a-web-window")) return false;
  }
  // A UWP frame window is judged by the process that owns its CoreWindow.
  {
    FakeForm form;
    form.Node(form.window).class_name = "ApplicationFrameWindow";
    form.source.process_path = "C:\\Windows\\System32\\ApplicationFrameHost.exe";
    form.source.core_path = "C:\\Program Files\\WindowsApps\\Calc\\CalculatorApp.exe";
    WindowsShadowReader reader(form.source);
    const ShadowUiaCapture capture = reader.Capture("click", "");
    if (!Check(capture.core_window_process_read && capture.core_window_process_path == form.source.core_path &&
                   form.source.core_calls == 1,
               "winreader-core-window-process")) return false;
    FakeForm unread;
    unread.Node(unread.window).class_name = "ApplicationFrameWindow";
    unread.source.process_path = "C:\\Windows\\System32\\ApplicationFrameHost.exe";
    unread.source.core_result = ShadowReadResult::kFailed;
    WindowsShadowReader unread_reader(unread.source);
    const ShadowUiaCapture lost = unread_reader.Capture("click", "");
    if (!Check(!lost.core_window_process_read && lost.read_failed, "winreader-unread-core-window-is-a-gap")) return false;
    const ShadowRecord record = WindowsShadowClassify(lost, UiaRequest("click"), true);
    if (!Check(record.kind != DecisionKind::kOrdinary, "winreader-unread-core-window-is-not-ordinary")) return false;
  }
  // The window or process that could not be read is a gap on every route.
  {
    FakeForm form;
    form.source.process_result = ShadowReadResult::kFailed;
    WindowsShadowReader reader(form.source);
    const ShadowUiaCapture capture = reader.Capture("click", "");
    if (!Check(!capture.process_path_read && capture.read_failed, "winreader-unread-process-is-a-gap")) return false;
    const ShadowRecord record = WindowsShadowClassify(capture, UiaRequest("click"), true);
    if (!Check((record.gaps & kShadowGapReadFailed) != 0 && record.kind != DecisionKind::kOrdinary,
               "winreader-unread-process-is-not-ordinary")) return false;
  }
  // The item of a file browser: its real path gives the extension; a display name never does.
  {
    FakeExplorer real("invoice.pdf");
    real.GiveRealPath("C:\\Users\\a\\invoice.pdf.exe");
    WindowsShadowReader reader(real.form.source);
    const ShadowUiaCapture capture = reader.Capture("click", "");
    if (!Check(capture.item_kind == ShadowItemKind::kFile && capture.item_name_read &&
                   capture.item_name_is_real_path && capture.item_name == "C:\\Users\\a\\invoice.pdf.exe",
               "winreader-item-real-path")) return false;
    const ShadowFacts facts = BuildWindowsShadowFacts(capture, UiaRequest("click"));
    if (!Check(facts.facts.target_is_file_item && facts.facts.extension_known && facts.facts.extension == "exe",
               "winreader-real-path-gives-the-extension")) return false;

    FakeExplorer display("invoice.pdf");
    WindowsShadowReader display_reader(display.form.source);
    const ShadowUiaCapture shown = display_reader.Capture("click", "");
    if (!Check(shown.item_kind == ShadowItemKind::kFile && !shown.item_name_is_real_path && !shown.read_failed,
               "winreader-display-name-only")) return false;
    const ShadowFacts shown_facts = BuildWindowsShadowFacts(shown, UiaRequest("click"));
    if (!Check(shown_facts.facts.target_is_file_item && !shown_facts.facts.extension_known &&
                   (shown_facts.gaps & kShadowGapExtensionUnknown) != 0,
               "winreader-display-name-never-gives-an-extension")) return false;

    FakeExplorer folder("Docs");
    folder.GiveRealPath("C:\\Users\\a\\Docs", true);
    WindowsShadowReader folder_reader(folder.form.source);
    if (!Check(folder_reader.Capture("click", "").item_kind == ShadowItemKind::kFolder, "winreader-folder-item"))
      return false;

    // A click on a cell of the details view lands under the ListItem: the item is that ListItem.
    FakeExplorer cell("invoice.pdf");
    cell.GiveRealPath("C:\\Users\\a\\invoice.pdf.exe");
    cell.form.source.point = cell.form.source.Add(cell.item, "Edit", "Date modified", "UIProperty");
    WindowsShadowReader cell_reader(cell.form.source);
    const ShadowUiaCapture in_cell = cell_reader.Capture("click", "");
    if (!Check(in_cell.item_kind == ShadowItemKind::kFile && in_cell.item_name_is_real_path &&
                   in_cell.item_name == "C:\\Users\\a\\invoice.pdf.exe",
               "winreader-item-of-a-cell")) return false;
    // Further than the target's two parents is not the target's item.
    FakeExplorer far_item("invoice.pdf");
    far_item.GiveRealPath("C:\\Users\\a\\invoice.pdf.exe");
    int tip = far_item.item;
    for (int level = 0; level < 3; ++level) tip = far_item.form.source.Add(tip, "Group");
    far_item.form.source.point = tip;
    WindowsShadowReader far_reader(far_item.form.source);
    if (!Check(far_reader.Capture("click", "").item_kind == ShadowItemKind::kNone && far_item.form.source.item_calls == 0,
               "winreader-item-too-far-above-the-target")) return false;

    // A list item of an ordinary window is not a file: nothing is asked of the shell.
    FakeForm ordinary;
    const int ordinary_list = ordinary.source.Add(ordinary.pane, "List", "Entries");
    const int ordinary_item = ordinary.source.Add(ordinary_list, "ListItem", "readme.txt");
    ordinary.source.point = ordinary_item;
    WindowsShadowReader ordinary_reader(ordinary.source);
    const ShadowUiaCapture plain = ordinary_reader.Capture("click", "");
    if (!Check(plain.item_kind == ShadowItemKind::kNone && ordinary.source.item_calls == 0,
               "winreader-no-item-outside-a-file-browser")) return false;

    // A path longer than the core accepts is a gap, and still only a display name.
    FakeExplorer lost("a.txt");
    lost.GiveRealPath(std::string(2048, 'p'));
    WindowsShadowReader lost_reader(lost.form.source);
    const ShadowUiaCapture too_long = lost_reader.Capture("click", "");
    if (!Check(too_long.item_kind == ShadowItemKind::kFile && !too_long.item_name_is_real_path && too_long.read_failed,
               "winreader-too-long-path-is-a-gap")) return false;
  }
  // A search that is cut off by its depth bound is incomplete: a second match below it is unknown.
  {
    FakeForm deep;
    int tip = deep.pane;
    for (int level = 0; level < 17; ++level) tip = deep.source.Add(tip, "Group");
    const int twin = deep.source.Add(tip, "Edit", "Twin");
    deep.Node(twin).automation_id = "name";
    WindowsShadowReader deep_reader(deep.source);
    const ShadowUiaCapture cut = deep_reader.Capture("invoke", "name");
    if (!Check(!cut.target_found && cut.read_failed, "winreader-depth-bound-makes-the-search-incomplete")) return false;
  }
  // Failures of single calls are gaps, never an ordinary capture.
  {
    FakeForm lost_point;
    lost_point.source.point_result = ShadowReadResult::kFailed;
    WindowsShadowReader point_reader(lost_point.source);
    const ShadowUiaCapture no_point = point_reader.Capture("click", "");
    if (!Check(!no_point.target_found && no_point.read_failed, "winreader-failed-point-lookup-is-a-gap")) return false;
    FakeForm lost_focus;
    lost_focus.source.focus_result = ShadowReadResult::kFailed;
    WindowsShadowReader focus_reader(lost_focus.source);
    const ShadowUiaCapture no_focus = focus_reader.Capture("type", "");
    if (!Check(!no_focus.target_found && no_focus.read_failed, "winreader-failed-focus-lookup-is-a-gap")) return false;
    // A comparison with the bound window that fails ends the chain there, with a gap.
    FakeForm same_target;
    same_target.source.same_fails_with = same_target.edit;
    WindowsShadowReader same_reader(same_target.source);
    const ShadowUiaCapture cut = same_reader.Capture("click", "");
    if (!Check(cut.chain.size() == 1 && !cut.chain_reached_root && cut.read_failed,
               "winreader-failed-comparison-ends-the-chain")) return false;
    // A comparison of a sibling that fails makes the neighbors incomplete.
    FakeForm same_sibling;
    same_sibling.source.same_fails_with = same_sibling.hint;
    WindowsShadowReader sibling_reader(same_sibling.source);
    const ShadowUiaCapture partial = sibling_reader.Capture("click", "");
    if (!Check(!partial.neighbors_complete && partial.read_failed && partial.chain_reached_root,
               "winreader-failed-sibling-comparison-is-incomplete")) return false;
    // A Document value that fails to read in a web window is a failed read, not an unknown origin.
    FakeForm web;
    web.Node(web.window).class_name = "Chrome_WidgetWin_1";
    const int page = web.source.Add(web.window, "Document", "Page");
    web.Node(page).url_result = ShadowReadResult::kFailed;
    web.source.point = page;
    WindowsShadowReader web_reader(web.source);
    const ShadowUiaCapture unreadable = web_reader.Capture("click", "");
    if (!Check(!unreadable.document_url_read && unreadable.read_failed, "winreader-failed-url-read-is-a-gap")) return false;
    // A UWP frame is recognized by its host process alone as well.
    FakeForm frame;
    frame.source.process_path = "C:\\Windows\\System32\\ApplicationFrameHost.exe";
    frame.source.core_path = "C:\\Program Files\\WindowsApps\\App.exe";
    WindowsShadowReader frame_reader(frame.source);
    (void)frame_reader.Capture("click", "");
    if (!Check(frame.source.core_calls == 1, "winreader-uwp-by-process-alone")) return false;
  }
  // The shell is asked only about an item of the bound window: a target the walk could not trace
  // back to it is a file with an unknown extension and nothing is looked up.
  {
    FakeExplorer foreign("invoice.pdf");
    const int other_window = foreign.form.source.Add(-1, "Window", "Other", "CabinetWClass");
    const int other_list = foreign.form.source.Add(other_window, "List", "Items", "UIItemsView");
    const int other_item = foreign.form.source.Add(other_list, "ListItem", "secret.docx", "UIItem");
    foreign.form.source.nodes[static_cast<std::size_t>(other_item)].has_item = true;
    foreign.form.source.nodes[static_cast<std::size_t>(other_item)].item_path = "C:\\Other\\secret.docx";
    foreign.form.source.point = other_item;
    WindowsShadowReader foreign_reader(foreign.form.source);
    const ShadowUiaCapture outside = foreign_reader.Capture("click", "");
    if (!Check(!outside.chain_reached_root && outside.item_kind == ShadowItemKind::kFile &&
                   !outside.item_name_is_real_path && foreign.form.source.item_calls == 0,
               "winreader-no-shell-lookup-outside-the-bound-window")) return false;
    // A failed shell lookup is a gap and a display name only.
    FakeExplorer failed_lookup("a.txt");
    failed_lookup.form.Node(failed_lookup.item).item_result = ShadowReadResult::kFailed;
    WindowsShadowReader failed_reader(failed_lookup.form.source);
    const ShadowUiaCapture failed = failed_reader.Capture("click", "");
    if (!Check(failed.item_kind == ShadowItemKind::kFile && !failed.item_name_is_real_path && failed.read_failed,
               "winreader-failed-shell-lookup-is-a-gap")) return false;
  }
  // The shell tab is an element the walk already reached; no walk of the source's own is needed.
  {
    FakeExplorer tabbed("invoice.pdf", true);
    tabbed.GiveRealPath("C:\\Users\\a\\invoice.pdf");
    WindowsShadowReader tab_reader(tabbed.form.source);
    const ShadowUiaCapture with_tab = tab_reader.Capture("click", "");
    if (!Check(with_tab.item_name_is_real_path && tabbed.form.source.last_tab == static_cast<ShadowUiaSource::Element>(tabbed.tab),
               "winreader-item-gets-its-shell-tab-from-the-walk")) return false;
    FakeExplorer untabbed("invoice.pdf");
    untabbed.GiveRealPath("C:\\Users\\a\\invoice.pdf");
    WindowsShadowReader untabbed_reader(untabbed.form.source);
    (void)untabbed_reader.Capture("click", "");
    if (!Check(untabbed.form.source.last_tab == ShadowUiaSource::kNoElement, "winreader-no-tab-without-one-in-the-chain"))
      return false;
  }
  // The last call decides nothing alone: a shell lookup that returns after the deadline, or a cancel
  // that arrives after it, makes the capture late or canceled, not a complete one.
  {
    FakeExplorer slow("invoice.pdf");
    slow.GiveRealPath("C:\\Users\\a\\invoice.pdf");
    slow.form.source.item_delay_ns = kShadowDeadlineNs * 2;
    WindowsShadowReader slow_reader(slow.form.source);
    const ShadowUiaCapture late = slow_reader.Capture("click", "");
    if (!Check(late.budget_exhausted && late.item_name_is_real_path, "winreader-late-last-call-is-over-budget")) return false;
    const ShadowRecord late_record = WindowsShadowClassify(late, UiaRequest("click"), true);
    if (!Check((late_record.gaps & kShadowGapBudget) != 0 && late_record.kind != DecisionKind::kOrdinary,
               "winreader-late-last-call-is-not-ordinary")) return false;
    FakeExplorer counted("invoice.pdf");
    counted.GiveRealPath("C:\\Users\\a\\invoice.pdf");
    WindowsShadowReader count_reader(counted.form.source);
    (void)count_reader.Capture("click", "");
    const long total = counted.form.source.calls;
    FakeExplorer canceled("invoice.pdf");
    canceled.GiveRealPath("C:\\Users\\a\\invoice.pdf");
    canceled.form.source.cancel_after = total;
    WindowsShadowReader cancel_reader(canceled.form.source);
    (void)cancel_reader.Capture("click", "");
    if (!Check(cancel_reader.Canceled() && canceled.form.source.calls == total, "winreader-cancel-after-the-last-call-is-canceled"))
      return false;
  }
  // A label is passed through as read (the core reads the words, the reader does not).
  {
    FakeForm form;
    form.Node(form.edit).name = "Place order";
    WindowsShadowReader reader(form.source);
    const ShadowUiaCapture capture = reader.Capture("click", "");
    if (!Check(capture.chain[0].name == "Place order", "winreader-label-is-passed-through")) return false;
  }
  std::cout << "Computer Use native Windows shadow reader: PASS\n";
  return true;
}

// ---- Windows shadow scheduler (S5-b-2b): when the shadow may run, and what it records ----------
// The launcher, the clock-free environment and the source are all fakes: the scheduler is portable.

struct QueuedLauncher {
  std::vector<std::function<void()>> queued;
  bool throws = false;
  WindowsShadowLauncher Get() {
    return [this](std::function<void()> work) {
      if (throws) throw 1;
      queued.push_back(std::move(work));
    };
  }
  void RunAll() {
    std::vector<std::function<void()>> work;
    work.swap(queued);
    for (auto &item : work) item();
  }
};

WindowsShadowJob SchedulerJob(const std::string &kind = "click") {
  WindowsShadowJob job;
  job.kind = kind;
  job.maximum_mode = "full_access_app";
  job.policy_language = "en";
  job.v1_ordinary = true;
  return job;
}

struct SchedulerWorld {
  FakeForm form;
  int opened = 0;
  bool valid = true;
  // How many times still_valid answers yes before it says no (-1 = always yes while valid).
  int valid_answers = -1;
  bool unavailable = false;
  bool open_throws = false;
  WindowsShadowEnvironment Environment() {
    WindowsShadowEnvironment environment;
    environment.still_valid = [this] {
      if (!valid) return false;
      if (valid_answers < 0) return true;
      return valid_answers-- > 0;
    };
    environment.open_source = [this]() -> std::unique_ptr<ShadowUiaSource> {
      ++opened;
      if (open_throws) throw 1;
      if (unavailable) return nullptr;
      return std::make_unique<FakeUia>(form.source);
    };
    return environment;
  }
};

bool CheckWindowsShadowScheduler() {
  // V1 could not re-validate the bound target: nothing is read, nothing is opened, one skipped record.
  {
    EffectShadowLog ring;
    QueuedLauncher launcher;
    WindowsShadowScheduler scheduler(ring, launcher.Get());
    SchedulerWorld world;
    scheduler.Schedule(SchedulerJob(), false, world.Environment());
    const std::vector<ShadowRecord> records = ring.Snapshot();
    if (!Check(records.size() == 1 && (records[0].gaps & kShadowGapV1Invalid) != 0 && records[0].v1_ordinary &&
                   launcher.queued.empty() && world.opened == 0 && !scheduler.InFlight(),
               "winsched-v1-invalid-reads-nothing")) return false;
  }
  // The happy path: the caller's thread reads nothing (the capture is only handed over), and the
  // work records exactly one classification, identical to classifying the same capture directly.
  {
    EffectShadowLog ring;
    QueuedLauncher launcher;
    WindowsShadowScheduler scheduler(ring, launcher.Get());
    SchedulerWorld world;
    scheduler.Schedule(SchedulerJob(), true, world.Environment());
    if (!Check(launcher.queued.size() == 1 && ring.Total() == 0 && world.opened == 0 && scheduler.InFlight(),
               "winsched-schedule-reads-nothing-on-the-callers-thread")) return false;
    launcher.RunAll();
    FakeForm direct;
    WindowsShadowReader reader(direct.source);
    ShadowRequestInfo info = UiaRequest("click");
    const ShadowRecord expected = WindowsShadowClassify(reader.Capture("click", ""), info, true);
    const std::vector<ShadowRecord> records = ring.Snapshot();
    if (!Check(records.size() == 1 && records[0].gaps == expected.gaps && records[0].kind == expected.kind &&
                   records[0].effect_class == expected.effect_class && records[0].v1_ordinary &&
                   world.opened == 1 && !scheduler.InFlight(),
               "winsched-records-one-classification")) return false;
  }
  // One capture in flight: another is recorded as busy, not queued; once it ends, the next is taken.
  {
    EffectShadowLog ring;
    QueuedLauncher launcher;
    WindowsShadowScheduler scheduler(ring, launcher.Get());
    SchedulerWorld world;
    scheduler.Schedule(SchedulerJob(), true, world.Environment());
    scheduler.Schedule(SchedulerJob(), true, world.Environment());
    const std::vector<ShadowRecord> busy = ring.Snapshot();
    if (!Check(launcher.queued.size() == 1 && busy.size() == 1 && (busy[0].gaps & kShadowGapBusy) != 0,
               "winsched-second-capture-is-busy")) return false;
    launcher.RunAll();
    scheduler.Schedule(SchedulerJob(), true, world.Environment());
    if (!Check(launcher.queued.size() == 1 && scheduler.InFlight(), "winsched-next-capture-after-the-first"))
      return false;
    launcher.RunAll();
    if (!Check(ring.Total() == 3 && !scheduler.InFlight(), "winsched-three-records")) return false;
  }
  // Canceled between the schedule and the start: nothing is opened or read.
  {
    EffectShadowLog ring;
    QueuedLauncher launcher;
    WindowsShadowScheduler scheduler(ring, launcher.Get());
    SchedulerWorld world;
    scheduler.Schedule(SchedulerJob(), true, world.Environment());
    world.valid = false;
    launcher.RunAll();
    const std::vector<ShadowRecord> records = ring.Snapshot();
    if (!Check(records.size() == 1 && records[0].gaps == kShadowGapCanceled && world.opened == 0 && !scheduler.InFlight(),
               "winsched-canceled-before-start-reads-nothing")) return false;
  }
  // UI Automation cannot be created: a read gap, never a classification.
  {
    EffectShadowLog ring;
    QueuedLauncher launcher;
    WindowsShadowScheduler scheduler(ring, launcher.Get());
    SchedulerWorld world;
    world.unavailable = true;
    scheduler.Schedule(SchedulerJob(), true, world.Environment());
    launcher.RunAll();
    const std::vector<ShadowRecord> records = ring.Snapshot();
    if (!Check(records.size() == 1 && records[0].gaps == kShadowGapReadFailed && !scheduler.InFlight(),
               "winsched-no-uia-is-a-read-gap")) return false;
  }
  // Canceled while the capture runs: a skipped record, never a (partial) classification.
  {
    EffectShadowLog ring;
    QueuedLauncher launcher;
    WindowsShadowScheduler scheduler(ring, launcher.Get());
    SchedulerWorld world;
    world.form.source.cancel_after = 4;
    scheduler.Schedule(SchedulerJob(), true, world.Environment());
    launcher.RunAll();
    const std::vector<ShadowRecord> records = ring.Snapshot();
    if (!Check(records.size() == 1 && records[0].gaps == kShadowGapCanceled && !scheduler.InFlight(),
               "winsched-canceled-mid-capture-is-skipped")) return false;
  }
  // Out of budget: the classification stands, with the budget gap (incomplete is a takeover).
  {
    EffectShadowLog ring;
    QueuedLauncher launcher;
    WindowsShadowScheduler scheduler(ring, launcher.Get());
    SchedulerWorld world;
    for (int extra = 0; extra < 2000; ++extra) world.form.source.Add(world.form.pane, "Group");
    WindowsShadowJob job = SchedulerJob("invoke");
    job.target_id = "no-such-target";
    scheduler.Schedule(std::move(job), true, world.Environment());
    launcher.RunAll();
    const std::vector<ShadowRecord> records = ring.Snapshot();
    if (!Check(records.size() == 1 && (records[0].gaps & kShadowGapBudget) != 0 &&
                   (records[0].gaps & kShadowGapCanceled) == 0 && records[0].kind != DecisionKind::kOrdinary,
               "winsched-budget-is-a-classification-with-a-gap")) return false;
  }
  // A failure of the shadow is invisible and frees the slot: an exception in the source, an
  // exception in the launcher.
  {
    EffectShadowLog ring;
    QueuedLauncher launcher;
    WindowsShadowScheduler scheduler(ring, launcher.Get());
    SchedulerWorld world;
    world.open_throws = true;
    scheduler.Schedule(SchedulerJob(), true, world.Environment());
    launcher.RunAll();
    if (!Check(ring.Total() == 0 && !scheduler.InFlight(), "winsched-source-exception-is-swallowed")) return false;
    world.open_throws = false;
    launcher.throws = true;
    scheduler.Schedule(SchedulerJob(), true, world.Environment());
    if (!Check(!scheduler.InFlight() && ring.Total() == 0, "winsched-launcher-exception-frees-the-slot")) return false;
    launcher.throws = false;
    scheduler.Schedule(SchedulerJob(), true, world.Environment());
    launcher.RunAll();
    if (!Check(ring.Total() == 1, "winsched-works-after-failures")) return false;
  }
  // Canceled right after the last call of the capture: still not a classification of a stale target.
  {
    EffectShadowLog ring;
    QueuedLauncher launcher;
    WindowsShadowScheduler scheduler(ring, launcher.Get());
    SchedulerWorld world;
    world.valid_answers = 1;
    scheduler.Schedule(SchedulerJob(), true, world.Environment());
    launcher.RunAll();
    const std::vector<ShadowRecord> records = ring.Snapshot();
    if (!Check(records.size() == 1 && records[0].gaps == kShadowGapCanceled && world.opened == 1,
               "winsched-canceled-after-the-last-call-is-skipped")) return false;
  }
  // Every record the ring keeps is also given to the observer, unchanged, and an observer that
  // throws does not lose the record or the slot.
  {
    EffectShadowLog ring;
    QueuedLauncher launcher;
    std::vector<ShadowRecord> seen;
    bool observer_throws = false;
    WindowsShadowScheduler scheduler(ring, launcher.Get(), [&](const ShadowRecord &record) {
      seen.push_back(record);
      if (observer_throws) throw 1;
    });
    SchedulerWorld world;
    scheduler.Schedule(SchedulerJob(), false, world.Environment());
    scheduler.Schedule(SchedulerJob(), true, world.Environment());
    scheduler.Schedule(SchedulerJob(), true, world.Environment());
    // The records made on the caller's side (V1 invalid, busy) are kept at once but not announced there.
    if (!Check(seen.empty() && ring.Total() == 2, "winsched-observer-is-not-called-on-the-callers-thread")) return false;
    launcher.RunAll();
    world.unavailable = true;
    scheduler.Schedule(SchedulerJob(), true, world.Environment());
    launcher.RunAll();
    observer_throws = true;
    world.unavailable = false;
    scheduler.Schedule(SchedulerJob(), true, world.Environment());
    launcher.RunAll();
    const std::vector<ShadowRecord> kept = ring.Snapshot();
    // The shadow's thread passes the caller-side records on after its own, so compare as sets.
    const auto order = [](const ShadowRecord &left, const ShadowRecord &right) {
      return left.gaps != right.gaps ? left.gaps < right.gaps
                                     : static_cast<unsigned>(left.kind) < static_cast<unsigned>(right.kind);
    };
    std::vector<ShadowRecord> sorted_kept = kept;
    std::vector<ShadowRecord> sorted_seen = seen;
    std::sort(sorted_kept.begin(), sorted_kept.end(), order);
    std::sort(sorted_seen.begin(), sorted_seen.end(), order);
    bool same = sorted_kept.size() == sorted_seen.size();
    for (std::size_t index = 0; same && index < sorted_kept.size(); ++index)
      same = sorted_kept[index].gaps == sorted_seen[index].gaps && sorted_kept[index].kind == sorted_seen[index].kind &&
             sorted_kept[index].effect_class == sorted_seen[index].effect_class &&
             sorted_kept[index].reason == sorted_seen[index].reason && sorted_kept[index].action == sorted_seen[index].action &&
             sorted_kept[index].v1_ordinary == sorted_seen[index].v1_ordinary;
    if (!Check(kept.size() == 5 && same && !scheduler.InFlight(), "winsched-observer-sees-every-record-the-ring-keeps"))
      return false;
  }
  // The V1 verdict is carried into every kind of record.
  {
    EffectShadowLog ring;
    QueuedLauncher launcher;
    WindowsShadowScheduler scheduler(ring, launcher.Get());
    SchedulerWorld world;
    WindowsShadowJob job = SchedulerJob();
    job.v1_ordinary = false;
    scheduler.Schedule(job, false, world.Environment());
    scheduler.Schedule(job, true, world.Environment());
    launcher.RunAll();
    bool all_false = true;
    for (const ShadowRecord &record : ring.Snapshot()) all_false = all_false && !record.v1_ordinary;
    if (!Check(ring.Total() == 2 && all_false, "winsched-v1-verdict-is-carried")) return false;
  }
  std::cout << "Computer Use native Windows shadow scheduler: PASS\n";
  return true;
}

// ---- Classifier v2 C4-1: the measurement an approval is judged on (portable; nothing is wired) ----

using sprint_coder::computer_use::ApprovalAuthorityDigest;
using sprint_coder::computer_use::ApprovalAuthorityFrame;
using sprint_coder::computer_use::ApprovalAuthorityIdentity;
using sprint_coder::computer_use::ApprovalMeasurementInput;
using sprint_coder::computer_use::ApprovalAuthorityBinding;
using sprint_coder::computer_use::ApprovalTargetFrame;
using sprint_coder::computer_use::DeriveAuthorityBinding;
using sprint_coder::computer_use::NormalizeOrigin;
using sprint_coder::computer_use::RulesetEnables;
using sprint_coder::computer_use::kAuthorityFrameGrid;
using sprint_coder::computer_use::AuthorityString;
using sprint_coder::computer_use::ClassifierRoute;
using sprint_coder::computer_use::HighImpactSource;
using sprint_coder::computer_use::IntentRefusal;
using sprint_coder::computer_use::JudgeIntentOffer;
using sprint_coder::computer_use::MeasureApproval;
using sprint_coder::computer_use::Sha256Hex;
using sprint_coder::computer_use::kApprovalAuthorityDomain;

ApprovalAuthorityIdentity MeasureIdentity() {
  ApprovalAuthorityIdentity identity;
  identity.app_identity = AuthorityString{true, std::string(64, '1')};
  identity.process_generation = AuthorityString{true, "generation-1"};
  identity.window_identity = AuthorityString{true, std::string(64, '2')};
  identity.geometry_present = true;
  identity.x = 10;
  identity.y = 20;
  identity.width = 800;
  identity.height = 600;
  return identity;
}

// A purchase button in a window, which the core treats as a confirmation.
ShadowAxCapture MeasureCapture() {
  ShadowAxCapture capture = ShadowBase();
  capture.chain[0].title = "Place order";
  return capture;
}

ApprovalMeasurementInput MeasureInput(const ShadowAxCapture &capture) {
  ApprovalMeasurementInput input;
  input.capture = &capture;
  input.request = ShadowRequest("invoke");
  input.identity = MeasureIdentity();
  input.ruleset = EffectRuleset{};
  input.route = ClassifierRoute::kV2;
  input.source = HighImpactSource::kNativeFacts;
  input.attested_classifier_version = 2;
  input.target_frame = ApprovalTargetFrame{true, 30, 60, 100, 24};
  return input;
}

NativeApprovalIntentBinding MeasureIntent(const NativeApprovalMeasurement &measured) {
  NativeApprovalIntentBinding binding;
  binding.session_id = "session";
  binding.task_id = "task";
  binding.turn_id = "turn";
  binding.approval_request_id = "original-request";
  binding.action_digest = std::string(64, 'a');
  binding.payload_digest = std::string(64, 'b');
  binding.authority_digest = measured.authority_digest;
  binding.cancel_epoch = 3;
  binding.approval_generation = 7;
  binding.observation_revision = 10;
  binding.ticket_generation = 12;
  binding.classifier_version = measured.classifier_version;
  binding.ruleset_version = measured.ruleset_version;
  binding.lexicon_version = measured.lexicon_version;
  binding.effect = measured.effect;
  return binding;
}

// The binding that keeps an approval to the page and, for a confirmation, to what the person saw.
bool CheckEffectMeasurementBinding() {
  // Origin normalization.
  if (!Check(NormalizeOrigin("https://Shop.Example/checkout?a=1#x") == "https://shop.example" &&
                 NormalizeOrigin("https://shop.example:443/") == "https://shop.example" &&
                 NormalizeOrigin("http://shop.example:80") == "http://shop.example" &&
                 NormalizeOrigin("http://shop.example:8080/a") == "http://shop.example:8080" &&
                 NormalizeOrigin("https://shop.example:80/") == "https://shop.example:80" &&
                 NormalizeOrigin("HTTPS://user:pw@Shop.Example/") == "https://shop.example" &&
                 NormalizeOrigin("https://[::1]:8443/x") == "https://[::1]:8443" &&
                 NormalizeOrigin("https://good.example\\evil.example/path") == "https://good.example" &&
                 NormalizeOrigin("https://good.example:8443\\x") == "https://good.example:8443",
             "binding-origin-normalization")) return false;
  if (!Check(NormalizeOrigin("").empty() && NormalizeOrigin("shop.example/a").empty() &&
                 NormalizeOrigin("https:///x").empty() && NormalizeOrigin("https://host:12a/").empty() &&
                 NormalizeOrigin("://host").empty() && NormalizeOrigin("https://[::1/").empty() &&
                 NormalizeOrigin("data:text/html,x").empty() && NormalizeOrigin("http:shop.example/x").empty() &&
                 NormalizeOrigin("http:/x").empty() && NormalizeOrigin("https://\\x").empty() &&
                 NormalizeOrigin("file:///Users/me/a.html").empty() && NormalizeOrigin("file://host/a").empty() &&
                 NormalizeOrigin("FILE:///x").empty(),
             "binding-origin-rejects-non-origins")) return false;
  // The page of a web control: the same control on another host is another authority.
  const auto web = [](const std::string &url, const std::string &caption) {
    ShadowAxCapture capture = MeasureCapture();
    capture.chain.insert(capture.chain.begin() + 1, ShadowNode("AXWebArea", "Checkout"));
    capture.web_area_url_read = true;
    capture.web_area_url = url;
    capture.neighbors = {ShadowNode("AXStaticText")};
    capture.neighbors[0].value = caption;
    return capture;
  };
  const ShadowAxCapture shop = web("https://shop.example/checkout", "Total: $5");
  const NativeApprovalMeasurement base = MeasureApproval(MeasureInput(shop));
  if (!Check(base.eligible, "binding-fixture-is-eligible")) return false;
  const ShadowAxCapture elsewhere = web("https://attacker.example/checkout", "Total: $5");
  if (!Check(MeasureApproval(MeasureInput(elsewhere)).eligible &&
                 MeasureApproval(MeasureInput(elsewhere)).authority_digest != base.authority_digest,
             "binding-host-change-moves-the-digest")) return false;
  for (const char *url : {"https://shop.example:8443/checkout", "http://shop.example/checkout",
                          "https://shop.example.evil/checkout", "https://sub.shop.example/checkout"}) {
    if (!Check(MeasureApproval(MeasureInput(web(url, "Total: $5"))).authority_digest != base.authority_digest,
               "binding-origin-parts-move-the-digest")) return false;
  }
  // The path, the query and the host's case or default port do not.
  for (const char *url : {"https://SHOP.example/other/page?x=1#top", "https://shop.example:443/checkout"}) {
    if (!Check(MeasureApproval(MeasureInput(web(url, "Total: $5"))).authority_digest == base.authority_digest,
               "binding-path-does-not-move-the-digest")) return false;
  }
  // A URL that cannot be read is no origin: the facts say unknown and the measurement is a person's.
  {
    ShadowAxCapture unreadable = shop;
    unreadable.web_area_url_read = false;
    unreadable.web_area_url.clear();
    const NativeApprovalMeasurement measured = MeasureApproval(MeasureInput(unreadable));
    if (!Check(measured.takeover && !measured.eligible, "binding-unreadable-url-is-a-takeover")) return false;
    ShadowAxCapture odd = web("data:text/html,x", "Total: $5");
    if (!Check(!MeasureApproval(MeasureInput(odd)).eligible, "binding-non-origin-url-is-not-eligible")) return false;
    // A URL that reads as an origin-less page must not share the digest of another: it is a person's.
    for (const char *url : {"http:a.example/x", "http:b.example/x", "http:/x", "https:///x", "https://\\x",
                            "file:///Users/me/checkout.html", "file://host/checkout.html"}) {
      const NativeApprovalMeasurement odd_measured = MeasureApproval(MeasureInput(web(url, "Total: $5")));
      if (!Check(odd_measured.takeover && !odd_measured.eligible && odd_measured.authority_digest.empty(),
                 "binding-unreadable-origin-is-a-takeover")) return false;
    }
    // The same for an approval that is not a confirmation (the origin is bound for every effect).
    ShadowAxCapture odd_supervised = web("http:a.example/x", "Draft");
    ApprovalMeasurementInput odd_input = MeasureInput(odd_supervised);
    odd_input.request.maximum_mode = "supervised";
    odd_input.request.kind = "click";
    odd_input.source = HighImpactSource::kNone;
    odd_input.capture = &odd_supervised;
    odd_supervised.chain[0].title = "Save";
    if (!Check(MeasureApproval(odd_input).takeover, "binding-unreadable-origin-for-every-effect")) return false;
  }

  // A confirmation is bound to what the person saw and to where the control was.
  if (!Check(MeasureApproval(MeasureInput(web("https://shop.example/checkout", "Total: $5000"))).authority_digest !=
                 base.authority_digest,
             "binding-caption-change-moves-the-digest")) return false;
  {
    ShadowAxCapture more = shop;
    more.neighbors.push_back(ShadowNode("AXStaticText"));
    more.neighbors.back().value = "Free shipping";
    if (!Check(MeasureApproval(MeasureInput(more)).authority_digest != base.authority_digest, "binding-extra-caption")) return false;
    ShadowAxCapture reordered = more;
    std::swap(reordered.neighbors[0], reordered.neighbors[1]);
    if (!Check(MeasureApproval(MeasureInput(reordered)).authority_digest != MeasureApproval(MeasureInput(more)).authority_digest,
               "binding-caption-order")) return false;
    ShadowAxCapture split = shop;
    split.neighbors[0].value = "Total: ";
    split.neighbors.push_back(ShadowNode("AXStaticText"));
    split.neighbors.back().value = "$5";
    if (!Check(MeasureApproval(MeasureInput(split)).authority_digest != base.authority_digest, "binding-captions-are-not-concatenated"))
      return false;
    // The same number of captions with the boundary moved is another content.
    ShadowAxCapture ab_c = shop;
    ab_c.neighbors = {ShadowNode("AXStaticText"), ShadowNode("AXStaticText")};
    ab_c.neighbors[0].value = "ab";
    ab_c.neighbors[1].value = "c";
    ShadowAxCapture a_bc = ab_c;
    a_bc.neighbors[0].value = "a";
    a_bc.neighbors[1].value = "bc";
    if (!Check(MeasureApproval(MeasureInput(ab_c)).authority_digest != MeasureApproval(MeasureInput(a_bc)).authority_digest,
               "binding-caption-boundary")) return false;
  }
  // The place is window-relative and rounded: a window that moved with its control is the same;
  // a control that moved by a grid step, or changed size, is not; less than a step is.
  {
    const auto place = [&](std::int64_t window_x, std::int64_t window_y, ApprovalTargetFrame frame) {
      ApprovalMeasurementInput input = MeasureInput(shop);
      input.identity.x = window_x;
      input.identity.y = window_y;
      input.target_frame = frame;
      return MeasureApproval(input).authority_digest;
    };
    const std::string at_rest = place(10, 20, ApprovalTargetFrame{true, 30, 60, 100, 24});
    // (the window's own position is in the identity's geometry, so a moved window is another authority;
    // what the relative frame removes is the dependence on the control's absolute position)
    ApprovalMeasurementInput moved_window = MeasureInput(shop);
    moved_window.identity.x = 110;
    moved_window.identity.y = 70;
    moved_window.target_frame = ApprovalTargetFrame{true, 130, 110, 100, 24};
    ApprovalMeasurementInput rest = MeasureInput(shop);
    const auto digest_without_window = [&](ApprovalMeasurementInput input) {
      const ShadowFacts built = BuildShadowFacts(*input.capture, input.request);
      const EffectDecision decision = ClassifyEffect(built.facts, input.ruleset);
      return DeriveAuthorityBinding(*input.capture, input.identity, input.target_frame, built.facts, decision).binding;
    };
    const ApprovalAuthorityBinding a = digest_without_window(moved_window);
    const ApprovalAuthorityBinding b = digest_without_window(rest);
    if (!Check(a.relative_x == b.relative_x && a.relative_y == b.relative_y && a.relative_width == b.relative_width &&
                   a.relative_height == b.relative_height,
               "binding-frame-is-window-relative")) return false;
    if (!Check(place(10, 20, ApprovalTargetFrame{true, 30 + kAuthorityFrameGrid, 60, 100, 24}) != at_rest &&
                   place(10, 20, ApprovalTargetFrame{true, 30, 60 + kAuthorityFrameGrid, 100, 24}) != at_rest &&
                   place(10, 20, ApprovalTargetFrame{true, 30, 60, 100 + kAuthorityFrameGrid, 24}) != at_rest &&
                   place(10, 20, ApprovalTargetFrame{true, 30, 60, 100, 24 + kAuthorityFrameGrid}) != at_rest,
               "binding-frame-grid-step-moves-the-digest")) return false;
    if (!Check(place(10, 20, ApprovalTargetFrame{true, 31, 61, 101, 25}) == at_rest, "binding-frame-below-the-grid-is-rounded"))
      return false;
    // Rounding is a floor, also below zero.
    if (!Check(DeriveAuthorityBinding(shop, MeasureIdentity(), ApprovalTargetFrame{true, 7, 17, 100, 24},
                                      BuildShadowFacts(shop, ShadowRequest("invoke")).facts,
                                      ClassifyEffect(BuildShadowFacts(shop, ShadowRequest("invoke")).facts, EffectRuleset{}))
                       .binding.relative_x == -1,
               "binding-frame-floor-below-zero")) return false;
  }
  // The captions and the place must be whole for a confirmation, else it is a person's.
  {
    ShadowAxCapture partial = shop;
    partial.neighbors_complete = false;
    const NativeApprovalMeasurement measured = MeasureApproval(MeasureInput(partial));
    if (!Check(measured.takeover && !measured.eligible, "binding-partial-captions-are-a-takeover")) return false;
    ApprovalMeasurementInput no_frame = MeasureInput(shop);
    no_frame.target_frame = ApprovalTargetFrame{};
    const NativeApprovalMeasurement unplaced = MeasureApproval(no_frame);
    if (!Check(unplaced.takeover && !unplaced.eligible, "binding-unknown-frame-is-a-takeover")) return false;
  }
  // Other effects are not bound to the captions or the place: a supervised action is the same
  // authority whatever is near it and wherever the control sits.
  {
    ShadowAxCapture save = ShadowBase();
    save.neighbors = {ShadowNode("AXStaticText")};
    save.neighbors[0].value = "Draft";
    ApprovalMeasurementInput supervised = MeasureInput(save);
    supervised.request.maximum_mode = "supervised";
    supervised.request.kind = "click";
    supervised.source = HighImpactSource::kNone;
    const NativeApprovalMeasurement first = MeasureApproval(supervised);
    save.neighbors[0].value = "Final";
    supervised.target_frame = ApprovalTargetFrame{true, 300, 400, 10, 10};
    const NativeApprovalMeasurement second = MeasureApproval(supervised);
    if (!Check(first.eligible && second.eligible && first.effect == NativeApprovalEffect::kSupervisedAction &&
                   first.authority_digest == second.authority_digest,
               "binding-supervised-is-not-content-bound")) return false;
    // ...and it does not need a frame or whole captions.
    supervised.target_frame = ApprovalTargetFrame{};
    save.neighbors_complete = false;
    if (!Check(MeasureApproval(supervised).eligible, "binding-supervised-needs-neither")) return false;
  }
  // The high-impact source is the core's own reading of the capture, not a caller's statement.
  {
    using sprint_coder::computer_use::HighImpactSourceFor;
    const ShadowAxCapture confirmation = MeasureCapture();
    if (!Check(HighImpactSourceFor(confirmation, ShadowRequest("invoke"), EffectRuleset{}) == HighImpactSource::kNativeFacts,
               "source-confirmation-is-native-facts")) return false;
    ShadowRequestInfo supervised = ShadowRequest("click");
    supervised.maximum_mode = "supervised";
    if (!Check(HighImpactSourceFor(ShadowBase(), supervised, EffectRuleset{}) == HighImpactSource::kNone,
               "source-supervised-claims-none")) return false;
    if (!Check(HighImpactSourceFor(ShadowBase(), ShadowRequest("invoke"), EffectRuleset{}) == HighImpactSource::kNone,
               "source-ordinary-claims-none")) return false;
    EffectRuleset closed;
    closed.high_impact_confirmation = false;
    if (!Check(HighImpactSourceFor(confirmation, ShadowRequest("invoke"), closed) == HighImpactSource::kNone,
               "source-closed-ruleset-claims-none")) return false;
  }
  std::cout << "Computer Use native effect measurement binding: PASS\n";
  return true;
}

bool CheckEffectMeasurement() {
  // SHA-256, so the digest does not depend on a platform library.
  if (!Check(Sha256Hex("") == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" &&
                 Sha256Hex("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" &&
                 Sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq") ==
                     "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
             "measure-sha256-vectors")) return false;
  if (!Check(Sha256Hex(std::string(55, 'a')) == "9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318" &&
                 Sha256Hex(std::string(56, 'a')) == "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a" &&
                 Sha256Hex(std::string(64, 'a')) == "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb" &&
                 Sha256Hex(std::string(1000, 'a')) == "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3",
             "measure-sha256-padding-boundaries")) return false;

  // The frame: a domain, length-prefixed fields in a fixed order, absent told from empty.
  {
    const ShadowAxCapture capture = MeasureCapture();
    const ShadowFacts built = BuildShadowFacts(capture, ShadowRequest("invoke"));
    const EffectDecision decision = ClassifyEffect(built.facts, EffectRuleset{});
    const ApprovalAuthorityBinding binding =
        DeriveAuthorityBinding(capture, MeasureIdentity(), ApprovalTargetFrame{true, 30, 60, 100, 24},
                               built.facts, decision)
            .binding;
    const std::string frame = ApprovalAuthorityFrame(MeasureIdentity(), binding, built.facts, decision);
    if (!Check(kApprovalAuthorityDomain == "approval-authority-v1" &&
                   frame.rfind("21:approval-authority-v1", 0) == 0,
               "measure-frame-domain")) return false;
    if (!Check(frame == ApprovalAuthorityFrame(MeasureIdentity(), binding, built.facts, decision), "measure-frame-deterministic"))
      return false;
    // What is not authority is not in it.
    for (const char *name : {"observation", "ticket", "revision"})
      if (!Check(frame.find(name) == std::string::npos, "measure-frame-has-no-revision")) return false;
    const std::string digest = ApprovalAuthorityDigest(MeasureIdentity(), binding, built.facts, decision);
    if (!Check(digest.size() == 64 && digest == Sha256Hex(frame), "measure-digest-is-sha256-of-frame")) return false;

    // Every field moves the digest.
    struct Mutation {
      const char *name;
      void (*apply)(ApprovalAuthorityIdentity *, EffectFacts *, EffectDecision *);
    };
    const Mutation mutations[] = {
        {"app", [](ApprovalAuthorityIdentity *i, EffectFacts *, EffectDecision *) { i->app_identity.value[0] = '9'; }},
        {"app-absent", [](ApprovalAuthorityIdentity *i, EffectFacts *, EffectDecision *) { i->app_identity = AuthorityString{}; }},
        {"generation", [](ApprovalAuthorityIdentity *i, EffectFacts *, EffectDecision *) { i->process_generation.value += "x"; }},
        {"window", [](ApprovalAuthorityIdentity *i, EffectFacts *, EffectDecision *) { i->window_identity.value[0] = '9'; }},
        {"x", [](ApprovalAuthorityIdentity *i, EffectFacts *, EffectDecision *) { i->x += 1; }},
        {"y", [](ApprovalAuthorityIdentity *i, EffectFacts *, EffectDecision *) { i->y += 1; }},
        {"width", [](ApprovalAuthorityIdentity *i, EffectFacts *, EffectDecision *) { i->width += 1; }},
        {"height", [](ApprovalAuthorityIdentity *i, EffectFacts *, EffectDecision *) { i->height += 1; }},
        {"geometry-absent", [](ApprovalAuthorityIdentity *i, EffectFacts *, EffectDecision *) { i->geometry_present = false; }},
        {"role", [](ApprovalAuthorityIdentity *, EffectFacts *f, EffectDecision *) { f->chain[0].role += "x"; }},
        {"subrole", [](ApprovalAuthorityIdentity *, EffectFacts *f, EffectDecision *) { f->chain[0].subrole = "s"; }},
        {"label", [](ApprovalAuthorityIdentity *, EffectFacts *f, EffectDecision *) { f->chain[0].label += "!"; }},
        {"ancestor", [](ApprovalAuthorityIdentity *, EffectFacts *f, EffectDecision *) { f->chain[1].label += "!"; }},
        {"extra-node", [](ApprovalAuthorityIdentity *, EffectFacts *f, EffectDecision *) { f->chain.push_back(NodeFacts{"AXGroup", "", ""}); }},
        {"surface", [](ApprovalAuthorityIdentity *, EffectFacts *f, EffectDecision *) { f->surface = SurfaceKind::kFileBrowser; }},
        {"origin", [](ApprovalAuthorityIdentity *, EffectFacts *f, EffectDecision *) { f->origin = OriginState::kOrdinary; }},
        {"file-item", [](ApprovalAuthorityIdentity *, EffectFacts *f, EffectDecision *) { f->target_is_file_item = true; }},
        {"extension", [](ApprovalAuthorityIdentity *, EffectFacts *f, EffectDecision *) { f->extension_known = true; f->extension = "pdf"; }},
        {"effect-class", [](ApprovalAuthorityIdentity *, EffectFacts *, EffectDecision *d) { d->effect_class = EffectClass::kE3FileManagerOpen; }},
        {"effect", [](ApprovalAuthorityIdentity *, EffectFacts *, EffectDecision *d) { d->approval_effect = NativeApprovalEffect::kSupervisedAction; }},
        {"classifier-version", [](ApprovalAuthorityIdentity *, EffectFacts *, EffectDecision *d) { d->classifier_version += 1; }},
        {"ruleset-version", [](ApprovalAuthorityIdentity *, EffectFacts *, EffectDecision *d) { d->ruleset_version += 1; }},
        {"lexicon-version", [](ApprovalAuthorityIdentity *, EffectFacts *, EffectDecision *d) { d->lexicon_version += 1; }},
    };
    for (const Mutation &mutation : mutations) {
      ApprovalAuthorityIdentity identity = MeasureIdentity();
      EffectFacts facts = built.facts;
      EffectDecision changed = decision;
      mutation.apply(&identity, &facts, &changed);
      if (!Check(ApprovalAuthorityDigest(identity, binding, facts, changed) != digest, mutation.name)) return false;
    }

    // Absent is not empty, and neighbouring strings do not run into each other.
    ApprovalAuthorityIdentity absent = MeasureIdentity();
    absent.process_generation = AuthorityString{};
    ApprovalAuthorityIdentity empty = MeasureIdentity();
    empty.process_generation = AuthorityString{true, ""};
    if (!Check(ApprovalAuthorityDigest(absent, binding, built.facts, decision) !=
                   ApprovalAuthorityDigest(empty, binding, built.facts, decision),
               "measure-absent-is-not-empty")) return false;
    // A value that looks like the next field's framing cannot take its place: with the lengths
    // left out these two frames are the same string.
    ApprovalAuthorityIdentity left = MeasureIdentity();
    left.process_generation = AuthorityString{true, "a6:windowPb"};
    left.window_identity = AuthorityString{true, "c"};
    ApprovalAuthorityIdentity right = MeasureIdentity();
    right.process_generation = AuthorityString{true, "a"};
    right.window_identity = AuthorityString{true, "b6:windowPc"};
    if (!Check(ApprovalAuthorityDigest(left, binding, built.facts, decision) !=
                   ApprovalAuthorityDigest(right, binding, built.facts, decision),
               "measure-adjacent-strings")) return false;
    ApprovalAuthorityIdentity moved_boundary_left = MeasureIdentity();
    moved_boundary_left.app_identity = AuthorityString{true, "ab"};
    moved_boundary_left.process_generation = AuthorityString{true, "c"};
    ApprovalAuthorityIdentity moved_boundary_right = MeasureIdentity();
    moved_boundary_right.app_identity = AuthorityString{true, "a"};
    moved_boundary_right.process_generation = AuthorityString{true, "bc"};
    if (!Check(ApprovalAuthorityDigest(moved_boundary_left, binding, built.facts, decision) !=
                   ApprovalAuthorityDigest(moved_boundary_right, binding, built.facts, decision),
               "measure-moved-boundary")) return false;
    // Inside one node: the same text moved between the role, the subrole and the label.
    const auto digest_of_node = [&](const NodeFacts &node) {
      EffectFacts facts = built.facts;
      facts.chain[0] = node;
      return ApprovalAuthorityDigest(MeasureIdentity(), binding, facts, decision);
    };
    if (!Check(digest_of_node(NodeFacts{"AXButton", "", "Place order"}) !=
                   digest_of_node(NodeFacts{"AXButton", "Place order", ""}),
               "measure-node-subrole-label-swap")) return false;
    if (!Check(digest_of_node(NodeFacts{"AB", "", "x"}) != digest_of_node(NodeFacts{"A", "B", "x"}) &&
                   digest_of_node(NodeFacts{"A", "B", ""}) != digest_of_node(NodeFacts{"A", "", "B"}) &&
                   digest_of_node(NodeFacts{"", "AB", "C"}) != digest_of_node(NodeFacts{"", "A", "BC"}),
               "measure-node-boundaries")) return false;
    // Nodes of the chain are told apart from one longer node.
    EffectFacts joined_nodes = built.facts;
    joined_nodes.chain = {NodeFacts{"AXButton", "", "Place order"}, NodeFacts{"AXWindow", "", "Notes"}};
    EffectFacts one_node = built.facts;
    one_node.chain = {NodeFacts{"AXButton", "", "Place orderAXWindowNotes"}};
    if (!Check(ApprovalAuthorityDigest(MeasureIdentity(), binding, joined_nodes, decision) !=
                   ApprovalAuthorityDigest(MeasureIdentity(), binding, one_node, decision),
               "measure-node-count-boundary")) return false;
    // Neighbouring labels and the action are not authority: the same effect on the same control.
    EffectFacts with_neighbors = built.facts;
    with_neighbors.neighbor_labels = {"Total"};
    with_neighbors.action = ActionKind::kClick;
    if (!Check(ApprovalAuthorityDigest(MeasureIdentity(), binding, with_neighbors, decision) == digest,
               "measure-neighbors-are-not-authority")) return false;
  }

  // When an offer is allowed: route v2, an enabled approval, native's own facts, current versions.
  {
    const ShadowFacts built = BuildShadowFacts(MeasureCapture(), ShadowRequest("invoke"));
    const EffectDecision confirm = ClassifyEffect(built.facts, EffectRuleset{});
    if (!Check(confirm.kind == DecisionKind::kApproval && confirm.approval_effect == NativeApprovalEffect::kHighImpactConfirmation,
               "measure-fixture-is-a-confirmation")) return false;
    const auto offered = JudgeIntentOffer(ClassifierRoute::kV2, EffectRuleset{}, confirm, HighImpactSource::kNativeFacts, 2);
    if (!Check(offered.offer && offered.refusal == IntentRefusal::kNone &&
                   offered.effect == NativeApprovalEffect::kHighImpactConfirmation,
               "measure-offer-all-conditions")) return false;
    const auto v1 = JudgeIntentOffer(ClassifierRoute::kV1, EffectRuleset{}, confirm, HighImpactSource::kNativeFacts, 2);
    if (!Check(!v1.offer && v1.refusal == IntentRefusal::kRouteNotV2 && v1.effect == NativeApprovalEffect::kInvalid,
               "measure-offer-needs-route-v2")) return false;
    for (const HighImpactSource source : {HighImpactSource::kNone, HighImpactSource::kMainProjection}) {
      const auto refused = JudgeIntentOffer(ClassifierRoute::kV2, EffectRuleset{}, confirm, source, 2);
      if (!Check(!refused.offer && refused.refusal == IntentRefusal::kNotNativeFacts, "measure-offer-needs-native-facts"))
        return false;
    }
    EffectRuleset closed;
    closed.high_impact_confirmation = false;
    const auto disabled = JudgeIntentOffer(ClassifierRoute::kV2, closed, confirm, HighImpactSource::kNativeFacts, 2);
    if (!Check(!disabled.offer && disabled.refusal == IntentRefusal::kNotEnabled, "measure-offer-needs-enabled-effect"))
      return false;
    // The build must attest the version the core has.
    for (const std::uint32_t attested : {0u, 1u, 3u}) {
      const auto refused = JudgeIntentOffer(ClassifierRoute::kV2, EffectRuleset{}, confirm, HighImpactSource::kNativeFacts, attested);
      if (!Check(!refused.offer && refused.refusal == IntentRefusal::kNotAttested, "measure-offer-needs-the-attested-version"))
        return false;
    }
    // A supervised action is not about high impact: it needs no claim, and Main's projection never grants.
    EffectDecision supervised_decision = confirm;
    supervised_decision.effect_class = EffectClass::kOrdinary;
    supervised_decision.approval_effect = NativeApprovalEffect::kSupervisedAction;
    for (const HighImpactSource source : {HighImpactSource::kNone, HighImpactSource::kNativeFacts}) {
      if (!Check(JudgeIntentOffer(ClassifierRoute::kV2, EffectRuleset{}, supervised_decision, source, 2).offer,
                 "measure-supervised-needs-no-high-impact-claim")) return false;
    }
    {
      const auto projected = JudgeIntentOffer(ClassifierRoute::kV2, EffectRuleset{}, supervised_decision, HighImpactSource::kMainProjection, 2);
      if (!Check(!projected.offer && projected.refusal == IntentRefusal::kNotNativeFacts, "measure-projection-never-grants"))
        return false;
    }
    // Anything that is not an approval is not offered, whatever else is true.
    for (const DecisionKind kind : {DecisionKind::kOrdinary, DecisionKind::kBlocked, DecisionKind::kTakeover}) {
      EffectDecision other = confirm;
      other.kind = kind;
      const auto refused = JudgeIntentOffer(ClassifierRoute::kV2, EffectRuleset{}, other, HighImpactSource::kNativeFacts, 2);
      if (!Check(!refused.offer && refused.refusal == IntentRefusal::kNotAnApproval, "measure-offer-needs-an-approval"))
        return false;
    }
    EffectDecision no_effect = confirm;
    no_effect.approval_effect = NativeApprovalEffect::kInvalid;
    if (!Check(JudgeIntentOffer(ClassifierRoute::kV2, EffectRuleset{}, no_effect, HighImpactSource::kNativeFacts, 2).refusal ==
                   IntentRefusal::kNotAnApproval,
               "measure-offer-needs-an-effect")) return false;
    // A decision made by another version of the core is not trusted.
    for (int field = 0; field < 3; ++field) {
      EffectDecision other = confirm;
      if (field == 0) other.classifier_version += 1;
      if (field == 1) other.ruleset_version += 1;
      if (field == 2) other.lexicon_version += 1;
      const auto refused = JudgeIntentOffer(ClassifierRoute::kV2, EffectRuleset{}, other, HighImpactSource::kNativeFacts, 2);
      if (!Check(!refused.offer && refused.refusal == IntentRefusal::kVersionMismatch, "measure-offer-needs-current-versions"))
        return false;
    }
    // Each flag enables its own effect and no other.
    {
      EffectRuleset download;
      download.download_open = true;
      EffectRuleset files;
      files.file_manager_open = true;
      if (!Check(RulesetEnables(download, NativeApprovalEffect::kDownloadOpen) &&
                     !RulesetEnables(download, NativeApprovalEffect::kFileManagerOpen) &&
                     RulesetEnables(files, NativeApprovalEffect::kFileManagerOpen) &&
                     !RulesetEnables(files, NativeApprovalEffect::kDownloadOpen) &&
                     !RulesetEnables(EffectRuleset{}, NativeApprovalEffect::kDownloadOpen) &&
                     !RulesetEnables(EffectRuleset{}, NativeApprovalEffect::kFileManagerOpen) &&
                     RulesetEnables(EffectRuleset{}, NativeApprovalEffect::kHighImpactConfirmation) &&
                     RulesetEnables(EffectRuleset{}, NativeApprovalEffect::kSupervisedAction) &&
                     !RulesetEnables(EffectRuleset{}, NativeApprovalEffect::kInvalid),
                 "measure-ruleset-flags-map-to-effects")) return false;
      // Widening the rule set without a new ruleset version does not widen what is offered.
      EffectDecision download_open = confirm;
      download_open.effect_class = EffectClass::kE2DownloadOpen;
      download_open.approval_effect = NativeApprovalEffect::kDownloadOpen;
      const auto widened = JudgeIntentOffer(ClassifierRoute::kV2, download, download_open, HighImpactSource::kNativeFacts, 2);
      if (!Check(!widened.offer && widened.refusal == IntentRefusal::kNotEnabled, "measure-ruleset-is-the-versions-own"))
        return false;
      // Any flag that is not the version's own refuses a confirmation too, whichever way it differs.
      for (int flag = 0; flag < 4; ++flag) {
        EffectRuleset other;
        if (flag == 0) other.download_open = true;
        if (flag == 1) other.file_manager_open = true;
        if (flag == 2) other.high_impact_confirmation = false;
        if (flag == 3) other.supervised_action = false;
        if (!Check(!JudgeIntentOffer(ClassifierRoute::kV2, other, confirm, HighImpactSource::kNativeFacts, 2).offer,
                   "measure-every-ruleset-flag-is-compared")) return false;
      }
      EffectRuleset also_files;
      also_files.file_manager_open = true;
      if (!Check(!JudgeIntentOffer(ClassifierRoute::kV2, also_files, confirm, HighImpactSource::kNativeFacts, 2).offer,
                 "measure-ruleset-widened-refuses-everything")) return false;
    }
    // The first release's rule set offers only the two approvals; E2 / E3 stay refused (decision 2-A).
    for (const NativeApprovalEffect effect : {NativeApprovalEffect::kDownloadOpen, NativeApprovalEffect::kFileManagerOpen}) {
      EffectDecision file = confirm;
      file.approval_effect = effect;
      const auto refused = JudgeIntentOffer(ClassifierRoute::kV2, EffectRuleset{}, file, HighImpactSource::kNativeFacts, 2);
      if (!Check(!refused.offer && refused.refusal == IntentRefusal::kNotEnabled, "measure-file-effects-stay-closed"))
        return false;
    }
  }

  // The measurement: what the flow compares.
  {
    const ShadowAxCapture capture = MeasureCapture();
    const NativeApprovalMeasurement measured = MeasureApproval(MeasureInput(capture));
    if (!Check(measured.eligible && !measured.takeover && measured.effect == NativeApprovalEffect::kHighImpactConfirmation &&
                   measured.authority_digest.size() == 64 && measured.classifier_version == 2 &&
                   measured.ruleset_version == 2 && measured.lexicon_version == 2,
               "measure-eligible")) return false;
    // The same capture measures the same.
    if (!Check(MeasureApproval(MeasureInput(capture)).authority_digest == measured.authority_digest, "measure-deterministic"))
      return false;
    // Route v1, or a projection that is not native's, is not eligible (and is not a takeover).
    ApprovalMeasurementInput v1 = MeasureInput(capture);
    v1.route = ClassifierRoute::kV1;
    const NativeApprovalMeasurement v1_measured = MeasureApproval(v1);
    if (!Check(!v1_measured.eligible && !v1_measured.takeover && v1_measured.effect == NativeApprovalEffect::kInvalid &&
                   v1_measured.authority_digest.empty(),
               "measure-v1-route-is-not-eligible")) return false;
    ApprovalMeasurementInput main_side = MeasureInput(capture);
    main_side.source = HighImpactSource::kMainProjection;
    if (!Check(!MeasureApproval(main_side).eligible, "measure-main-projection-is-not-eligible")) return false;
    // An ordinary control and a refused one are not approvals; a capture that is not whole is a person's.
    const ShadowAxCapture ordinary = ShadowBase();
    if (!Check(!MeasureApproval(MeasureInput(ordinary)).eligible && !MeasureApproval(MeasureInput(ordinary)).takeover,
               "measure-ordinary-is-not-eligible")) return false;
    ShadowAxCapture password = ShadowBase();
    password.chain[0] = ShadowNode("AXTextField", "Password");
    ApprovalMeasurementInput secure = MeasureInput(password);
    secure.request = ShadowRequest("type");
    if (!Check(!MeasureApproval(secure).eligible && !MeasureApproval(secure).takeover, "measure-secure-is-not-eligible"))
      return false;
    ShadowAxCapture stopped = MeasureCapture();
    stopped.budget_exhausted = true;
    const NativeApprovalMeasurement person = MeasureApproval(MeasureInput(stopped));
    if (!Check(person.takeover && !person.eligible, "measure-incomplete-is-a-takeover")) return false;
    // An approval whose identity could not be measured whole is a person's; an ordinary control with
    // the same gaps is simply not an approval.
    {
      const ShadowAxCapture capture_with_gaps = MeasureCapture();
      for (int field = 0; field < 4; ++field) {
        ApprovalMeasurementInput input = MeasureInput(capture_with_gaps);
        if (field == 0) input.identity.app_identity = AuthorityString{};
        if (field == 1) input.identity.process_generation = AuthorityString{};
        if (field == 2) input.identity.window_identity = AuthorityString{};
        if (field == 3) input.identity.geometry_present = false;
        const NativeApprovalMeasurement gap = MeasureApproval(input);
        if (!Check(gap.takeover && !gap.eligible && gap.authority_digest.empty(), "measure-identity-gap-is-a-takeover"))
          return false;
      }
      ApprovalMeasurementInput plain = MeasureInput(ordinary);
      plain.identity.app_identity = AuthorityString{};
      if (!Check(!MeasureApproval(plain).takeover && !MeasureApproval(plain).eligible, "measure-identity-gap-on-an-ordinary-control"))
        return false;
    }
    // No capture is a person's, and a v1 route is "no" before the capture is looked at.
    {
      ApprovalMeasurementInput none = MeasureInput(ordinary);
      none.capture = nullptr;
      if (!Check(MeasureApproval(none).takeover && !MeasureApproval(none).eligible, "measure-no-capture-is-a-takeover"))
        return false;
      ShadowAxCapture broken = MeasureCapture();
      broken.budget_exhausted = true;
      ApprovalMeasurementInput v1_broken = MeasureInput(broken);
      v1_broken.route = ClassifierRoute::kV1;
      const NativeApprovalMeasurement v1_result = MeasureApproval(v1_broken);
      if (!Check(!v1_result.takeover && !v1_result.eligible, "measure-v1-route-before-the-capture")) return false;
      ApprovalMeasurementInput unattested = MeasureInput(capture);
      unattested.attested_classifier_version = 1;
      if (!Check(!MeasureApproval(unattested).eligible && !MeasureApproval(unattested).takeover, "measure-unattested-is-not-eligible"))
        return false;
      ApprovalMeasurementInput widened = MeasureInput(capture);
      widened.ruleset.file_manager_open = true;
      if (!Check(!MeasureApproval(widened).eligible, "measure-widened-ruleset-is-not-eligible")) return false;
    }
    // The versions and the effect are the core's, not the caller's.
    ApprovalMeasurementInput supervised = MeasureInput(ordinary);
    supervised.request.maximum_mode = "supervised";
    supervised.request.kind = "click";
    supervised.source = HighImpactSource::kNone;
    const NativeApprovalMeasurement supervised_measured = MeasureApproval(supervised);
    if (!Check(supervised_measured.eligible && supervised_measured.effect == NativeApprovalEffect::kSupervisedAction &&
                   supervised_measured.authority_digest != measured.authority_digest,
               "measure-supervised-action")) return false;
    EffectRuleset no_supervised;
    no_supervised.supervised_action = false;
    supervised.ruleset = no_supervised;
    if (!Check(!MeasureApproval(supervised).eligible, "measure-supervised-needs-the-ruleset")) return false;
  }

  // The flow with a real measurement: the same effect on the same control approves and consumes
  // once; any change of effect, authority or version is refused.
  {
    const std::string intent_token(64, 'e');
    const std::string execution_token(64, 'f');
    constexpr std::uint64_t kNow = 100;
    constexpr std::uint64_t kApproved = kNow + 20;
    const ShadowAxCapture capture = MeasureCapture();
    const NativeApprovalMeasurement first = MeasureApproval(MeasureInput(capture));
    NativeApprovalFlow flow;
    if (!Check(first.eligible && flow.Offer(intent_token, MeasureIntent(first), kNow, kNativeApprovalWaitMaxNs),
               "measure-flow-offer")) return false;
    // The revision and the ticket generation moved, and the digest did not need to know.
    NativeApprovalFacts approve_facts = FlowFacts();
    if (!Check(flow.Approve(approve_facts, MeasureApproval(MeasureInput(capture)), execution_token, kApproved).ok &&
                   flow.ready(),
               "measure-flow-approve")) return false;
    if (!Check(flow.ConsumeApproved(approve_facts, MeasureApproval(MeasureInput(capture)), kApproved).ok && !flow.occupied(),
               "measure-flow-consume")) return false;

    struct Change {
      const char *name;
      void (*apply)(ShadowAxCapture *, ApprovalMeasurementInput *);
      NativeApprovalFailure expected;
    };
    const Change changes[] = {
        {"label", [](ShadowAxCapture *c, ApprovalMeasurementInput *) { c->chain[0].title = "Pay now"; }, NativeApprovalFailure::kRevalidationFailed},
        {"ancestor", [](ShadowAxCapture *c, ApprovalMeasurementInput *) { c->chain[1].title = "Other window"; }, NativeApprovalFailure::kRevalidationFailed},
        {"window", [](ShadowAxCapture *, ApprovalMeasurementInput *i) { i->identity.window_identity.value[0] = '9'; }, NativeApprovalFailure::kRevalidationFailed},
        {"app", [](ShadowAxCapture *, ApprovalMeasurementInput *i) { i->identity.app_identity.value[0] = '9'; }, NativeApprovalFailure::kRevalidationFailed},
        {"generation", [](ShadowAxCapture *, ApprovalMeasurementInput *i) { i->identity.process_generation.value = "generation-2"; }, NativeApprovalFailure::kRevalidationFailed},
        {"geometry", [](ShadowAxCapture *, ApprovalMeasurementInput *i) { i->identity.width += 1; }, NativeApprovalFailure::kRevalidationFailed},
        {"surface", [](ShadowAxCapture *, ApprovalMeasurementInput *i) { i->request.executable_path = "/Applications/Raycast.app/Contents/MacOS/Raycast"; }, NativeApprovalFailure::kRevalidationFailed},
        {"mode", [](ShadowAxCapture *, ApprovalMeasurementInput *i) { i->request.maximum_mode = "observe_only"; }, NativeApprovalFailure::kRevalidationFailed},
        {"route", [](ShadowAxCapture *, ApprovalMeasurementInput *i) { i->route = ClassifierRoute::kV1; }, NativeApprovalFailure::kRevalidationFailed},
        {"source", [](ShadowAxCapture *, ApprovalMeasurementInput *i) { i->source = HighImpactSource::kMainProjection; }, NativeApprovalFailure::kRevalidationFailed},
        {"ruleset", [](ShadowAxCapture *, ApprovalMeasurementInput *i) { i->ruleset.high_impact_confirmation = false; }, NativeApprovalFailure::kRevalidationFailed},
        {"no-longer-whole", [](ShadowAxCapture *c, ApprovalMeasurementInput *) { c->budget_exhausted = true; }, NativeApprovalFailure::kTakeover},
        {"password-appeared", [](ShadowAxCapture *c, ApprovalMeasurementInput *) { c->chain[0].title = "Password"; }, NativeApprovalFailure::kRevalidationFailed},
    };
    for (const Change &change : changes) {
      for (const bool at_consume : {false, true}) {
        NativeApprovalFlow tried;
        if (!Check(tried.Offer(intent_token, MeasureIntent(first), kNow, kNativeApprovalWaitMaxNs), change.name)) return false;
        ShadowAxCapture changed = capture;
        ApprovalMeasurementInput input = MeasureInput(changed);
        change.apply(&changed, &input);
        input.capture = &changed;
        const NativeApprovalMeasurement measured = MeasureApproval(input);
        if (at_consume) {
          if (!Check(tried.Approve(approve_facts, MeasureApproval(MeasureInput(capture)), execution_token, kApproved).ok, change.name))
            return false;
          const auto outcome = tried.ConsumeApproved(approve_facts, measured, kApproved);
          if (!Check(!outcome.ok && outcome.failure == change.expected && !tried.occupied(), change.name)) return false;
        } else {
          const auto outcome = tried.Approve(approve_facts, measured, execution_token, kApproved);
          if (!Check(!outcome.ok && outcome.failure == change.expected && !tried.occupied(), change.name)) return false;
        }
      }
    }
    // A measurement whose version fields are not the intent's is refused too.
    for (int field = 0; field < 3; ++field) {
      NativeApprovalFlow tried;
      if (!Check(tried.Offer(intent_token, MeasureIntent(first), kNow, kNativeApprovalWaitMaxNs), "measure-flow-version"))
        return false;
      NativeApprovalMeasurement measured = MeasureApproval(MeasureInput(capture));
      if (field == 0) measured.classifier_version = 1;
      if (field == 1) measured.ruleset_version += 1;
      if (field == 2) measured.lexicon_version += 1;
      const auto outcome = tried.Approve(approve_facts, measured, execution_token, kApproved);
      if (!Check(!outcome.ok && outcome.failure == NativeApprovalFailure::kRevalidationFailed, "measure-flow-version"))
        return false;
    }
    // The digest does not know the observation revision or the ticket generation.
    NativeApprovalFacts later = approve_facts;
    later.observation_revision += 5;
    later.ticket_generation += 5;
    NativeApprovalFlow moved;
    if (!Check(moved.Offer(intent_token, MeasureIntent(first), kNow, kNativeApprovalWaitMaxNs) &&
                   moved.Approve(later, MeasureApproval(MeasureInput(capture)), execution_token, kApproved).ok,
               "measure-flow-ignores-revisions")) return false;
  }
  std::cout << "Computer Use native effect measurement: PASS\n";
  return true;
}

// ---- Classifier v2, S4-1-0: the interlock map (pure; nothing calls it yet) ----------------------

// #785 T15-4p: the artifact read judgement, every role against every condition. The expected
// answer is written out here from the owner's decision (design section 7.1), not taken from the
// header: a role that may be read, a node that is neither secure nor high-impact, an ordinary
// surface, an origin with no web content, no browser identity match, and every fact present.
bool CheckArtifactReadJudgement() {
  using sprint_coder::computer_use::ArtifactReadFacts;
  using sprint_coder::computer_use::ArtifactReadPlatform;
  using sprint_coder::computer_use::ArtifactReadRefusal;
  using sprint_coder::computer_use::JudgeArtifactRead;
  using sprint_coder::computer_use::OriginState;
  using sprint_coder::computer_use::SurfaceKind;
  const std::vector<std::string> roles = {
      "AXStaticText", "AXTextField", "AXTextArea", "AXSecureTextField", "AXComboBox", "AXGroup",
      "AXCell",       "AXRow",       "AXTable",    "AXWebArea",         "AXButton",   "AXScrollArea",
      "AXDocument",   "AXEdit",      "AXText",     "Text",              "Edit",       "Document",
      "TextBox",      "TextArea",    "TextField",  "StaticText",        "DataItem",   "Table",
      "Pane",         "Group",       "Custom",     "ComboBox",          "Hyperlink",  "",
      "Texts",        "AXStaticTextX", "Text ",    "EDIT",              "document",
      "ListItem",     "List",        "MenuItem",   "Image",             "Button",     "Hyperlink",
      "AXList",       "AXLink",      "AXImage",    "AXMenuItem",        "AXCheckBox", "AXSlider",
      "AXOutline",    "AXOutlineRow", "AXLayoutArea", "TreeItem",       "Header",     "Tab",
      "ToolBar",      "ScrollBar",   "Window",     "Spinner",           "Calendar",   "Thumb"};
  const auto allowed = [](ArtifactReadPlatform platform, const std::string &role) {
    if (platform == ArtifactReadPlatform::kMacOs)
      return role == "AXStaticText" || role == "AXTextField" || role == "AXTextArea" ||
             role == "StaticText" || role == "TextField" || role == "TextArea";
    return role == "Text" || role == "Edit" || role == "Document" || role == "EDIT" ||
           role == "document" || role == "Text ";
  };
  constexpr SurfaceKind surfaces[] = {SurfaceKind::kUnknown,      SurfaceKind::kOrdinary,
                                      SurfaceKind::kFileBrowser,  SurfaceKind::kDownloadPanel,
                                      SurfaceKind::kShellLike,    SurfaceKind::kScriptInput,
                                      SurfaceKind::kCommandPalette, SurfaceKind::kDevToolsConsole};
  constexpr OriginState origins[] = {OriginState::kNotApplicable, OriginState::kOrdinary,
                                     OriginState::kUnknown, OriginState::kSensitive};
  constexpr ArtifactReadPlatform platforms[] = {ArtifactReadPlatform::kMacOs,
                                                ArtifactReadPlatform::kWindows};
  std::size_t reads = 0;
  // A platform value outside the two is refused for every role and every fact set.
  {
    ArtifactReadFacts facts;
    facts.platform = static_cast<ArtifactReadPlatform>(7);
    facts.metadata_complete = true;
    facts.surface = SurfaceKind::kOrdinary;
    facts.origin = OriginState::kNotApplicable;
    facts.browser_identity_checked = true;
    for (const char *role : {"Text", "Edit", "Document", "AXStaticText", "AXTextField"})
      if (!Check(!JudgeArtifactRead(facts, role).MayRead(), "artifact-read-unknown-platform-refuses"))
        return false;
  }
  for (const ArtifactReadPlatform platform : platforms)
    for (const std::string &role : roles)
      for (unsigned bits = 0; bits < 32; ++bits)
        for (const SurfaceKind surface : surfaces)
          for (const OriginState origin : origins) {
            ArtifactReadFacts facts;
            facts.platform = platform;
            facts.metadata_complete = (bits & 1U) != 0;
            facts.secure = (bits & 2U) != 0;
            facts.high_impact = (bits & 4U) != 0;
            facts.browser_identity_checked = (bits & 8U) != 0;
            facts.browser_identity_match = (bits & 16U) != 0;
            facts.surface = surface;
            facts.origin = origin;
            const auto verdict = JudgeArtifactRead(facts, role);
            const bool role_ok = allowed(platform, role);
            const bool missing =
                !facts.metadata_complete || surface == SurfaceKind::kUnknown || !facts.browser_identity_checked;
            const bool origin_bad = origin == OriginState::kSensitive || origin == OriginState::kUnknown;
            const bool browser = origin != OriginState::kNotApplicable || facts.browser_identity_match;
            const bool expect_read = role_ok && !missing && !facts.secure && !facts.high_impact &&
                                     surface == SurfaceKind::kOrdinary && !origin_bad && !browser;
            if (!Check(verdict.MayRead() == expect_read, "artifact-read-may-read")) return false;
            if (!Check(verdict.MayRead() == (verdict.refusals == 0), "artifact-read-refusals-are-the-answer"))
              return false;
            if (!Check(verdict.Has(ArtifactReadRefusal::kFactsMissing) == missing, "artifact-read-reason-missing") ||
                !Check(verdict.Has(ArtifactReadRefusal::kRoleNotAllowed) == !role_ok, "artifact-read-reason-role") ||
                !Check(verdict.Has(ArtifactReadRefusal::kSecure) == facts.secure, "artifact-read-reason-secure") ||
                !Check(verdict.Has(ArtifactReadRefusal::kHighImpact) == facts.high_impact, "artifact-read-reason-high-impact") ||
                !Check(verdict.Has(ArtifactReadRefusal::kSurfaceNotOrdinary) == (surface != SurfaceKind::kOrdinary),
                       "artifact-read-reason-surface") ||
                !Check(verdict.Has(ArtifactReadRefusal::kOriginSensitiveOrUnknown) == origin_bad, "artifact-read-reason-origin") ||
                !Check(verdict.Has(ArtifactReadRefusal::kBrowserWindow) == browser, "artifact-read-reason-browser"))
              return false;
            if (expect_read) ++reads;
          }
  // Reads happen: 6 macOS spellings of three roles + 6 Windows spellings of three types, each in exactly one fact combination.
  if (!Check(reads == 6 + 6, "artifact-read-reads-are-exactly-the-allow-list")) return false;
  // A default-constructed fact set refuses (fail closed).
  if (!Check(!JudgeArtifactRead(ArtifactReadFacts{}, "AXStaticText").MayRead(), "artifact-read-default-refuses"))
    return false;
  std::cout << "Computer Use artifact read judgement: PASS\n";
  return true;
}

bool CheckNativeInterlockMap() {
  using sprint_coder::computer_use::EffectDecision;
  using sprint_coder::computer_use::InterlockOutcome;
  using sprint_coder::computer_use::InterlockReason;
  using sprint_coder::computer_use::InterlockVerdict;
  using sprint_coder::computer_use::InterlockForFacts;
  using sprint_coder::computer_use::MapEffectToInterlock;
  const auto none = [](const EffectFacts &facts, const char *name) {
    const InterlockVerdict verdict = InterlockForFacts(facts);
    return Check(!verdict.Refuses() && verdict.outcome == InterlockOutcome::kNone &&
                     verdict.reason == InterlockReason::kNone && verdict.ReasonCode().empty() &&
                     verdict.DeniedResult().empty(),
                 name);
  };
  // Every verdict this map gives is a row of the closed receipt table, looked up there and not
  // written again here.
  const auto is_receipt_pair = [](const InterlockVerdict &verdict) {
    return Check(sprint_coder::computer_use::NativePreflightRefusalAllowed(
                     verdict.DecisionName(), verdict.ReasonCode(), verdict.DeniedResult()),
                 "interlock-verdict-is-a-receipt-pair");
  };
  const auto shell_blocked = [&](const EffectFacts &facts, const char *name) {
    const InterlockVerdict verdict = InterlockForFacts(facts);
    if (verdict.Refuses() && !is_receipt_pair(verdict)) return false;
    return Check(verdict.Refuses() && verdict.outcome == InterlockOutcome::kBlocked &&
                     verdict.reason == InterlockReason::kShellSurface &&
                     verdict.ReasonCode() == "native_shell_surface_blocked" &&
                     verdict.DeniedResult() == "rejected",
                 name);
  };
  const auto trigger_takeover = [&](const EffectFacts &facts, const char *name) {
    const InterlockVerdict verdict = InterlockForFacts(facts);
    if (verdict.Refuses() && !is_receipt_pair(verdict)) return false;
    return Check(verdict.Refuses() && verdict.outcome == InterlockOutcome::kTakeover &&
                     verdict.reason == InterlockReason::kExecutionTrigger &&
                     verdict.ReasonCode() == "native_execution_trigger_blocked" &&
                     verdict.DeniedResult() == "paused",
                 name);
  };
  const auto trigger_blocked = [&](const EffectFacts &facts, const char *name) {
    const InterlockVerdict verdict = InterlockForFacts(facts);
    if (verdict.Refuses() && !is_receipt_pair(verdict)) return false;
    return Check(verdict.Refuses() && verdict.outcome == InterlockOutcome::kBlocked &&
                     verdict.reason == InterlockReason::kApprovalClosed &&
                     verdict.ReasonCode() == "native_approval_not_enabled" &&
                     verdict.DeniedResult() == "rejected",
                 name);
  };

  // An ordinary control is nobody's business here.
  if (!none(EffBase(), "interlock-ordinary-is-no-verdict")) return false;

  // Surfaces that take commands: refused, with the surface reason (ADR 3.7).
  for (const SurfaceKind surface : {SurfaceKind::kShellLike, SurfaceKind::kScriptInput,
                                    SurfaceKind::kCommandPalette, SurfaceKind::kDevToolsConsole}) {
    EffectFacts facts = EffBase();
    facts.surface = surface;
    facts.action = ActionKind::kType;
    facts.chain = {{"axtextfield", "", "Command line"}, {"axwindow", "", "Editor"}};
    if (!shell_blocked(facts, "interlock-command-surface-is-blocked")) return false;
    facts.action = ActionKind::kKey;
    facts.key_is_activation = true;
    if (!shell_blocked(facts, "interlock-command-surface-enter-is-blocked")) return false;
  }
  {
    // The same surface named by a word in the chain rather than by the surface kind.
    EffectFacts facts = EffBase();
    facts.action = ActionKind::kType;
    facts.chain = {{"axtextarea", "", "Integrated Terminal"}, {"axwindow", "", "Editor"}};
    if (!shell_blocked(facts, "interlock-surface-term-in-the-chain")) return false;
  }
  // Reading is never refused, and a surface judged on incomplete facts is not a verdict.
  {
    EffectFacts facts = EffBase();
    facts.surface = SurfaceKind::kShellLike;
    facts.action = ActionKind::kObserve;
    if (!none(facts, "interlock-observe-is-no-verdict")) return false;
    facts.action = ActionKind::kType;
    facts.metadata_complete = false;
    if (!none(facts, "interlock-incomplete-metadata-is-no-verdict")) return false;
    facts.metadata_complete = true;
    facts.chain_complete = false;
    if (!none(facts, "interlock-cut-chain-is-no-verdict")) return false;
    facts.chain_complete = true;
    facts.surface = SurfaceKind::kUnknown;
    if (!none(facts, "interlock-unknown-surface-is-no-verdict")) return false;
  }

  // E1 / E4 by extension: refused where opening the item runs or installs it (a file manager, a
  // download list), as a takeover. The same file opened inside an application is not refused here.
  for (const SurfaceKind surface : {SurfaceKind::kFileBrowser, SurfaceKind::kDownloadPanel}) {
    for (const char *extension : {"command", "sh", "exe", "msi", "pkg", "dmg", "bat", "app"}) {
      EffectFacts facts = EffBase();
      facts.surface = surface;
      facts.action = ActionKind::kDoubleClick;
      facts.target_is_file_item = true;
      facts.extension_known = true;
      facts.extension = extension;
      facts.chain = {{"axrow", "", "item"}, {"axwindow", "", "Downloads"}};
      if (!trigger_takeover(facts, "interlock-executable-open-is-a-takeover")) return false;
      facts.mode = SessionMode::kSupervised;
      if (!trigger_takeover(facts, "interlock-executable-open-ignores-the-mode")) return false;
    }
  }
  {
    EffectFacts facts = EffBase();
    facts.surface = SurfaceKind::kOrdinary;
    facts.action = ActionKind::kInvoke;
    facts.target_is_file_item = true;
    facts.extension_known = true;
    facts.extension = "sh";
    facts.chain = {{"axrow", "", "install.sh"}, {"axoutline", "", "Explorer"}, {"axwindow", "", "Editor"}};
    if (!none(facts, "interlock-script-opened-in-an-editor-is-not-refused")) return false;
    facts.extension = "pkg";
    if (!none(facts, "interlock-installer-name-opened-in-an-app-is-not-refused")) return false;
  }
  {
    // An installer button is a trigger on any surface: it is the control that installs.
    EffectFacts facts = EffBase();
    facts.action = ActionKind::kClick;
    facts.chain = {{"axbutton", "", "Install now"}, {"axwindow", "", "Setup"}};
    if (!trigger_takeover(facts, "interlock-installer-button-is-a-takeover")) return false;
    facts.action = ActionKind::kType;
    if (!none(facts, "interlock-typing-near-install-is-no-verdict")) return false;
  }
  {
    // The installer control is a trigger on any surface even when an executable extension comes with
    // it: the extension must not make the refusal go away (the core says E4 either way).
    for (const char *extension : {"pkg", "sh", "exe", "dmg"}) {
      EffectFacts facts = EffBase();
      facts.surface = SurfaceKind::kOrdinary;
      facts.action = ActionKind::kClick;
      facts.extension_known = true;
      facts.extension = extension;
      facts.chain = {{"axbutton", "", "Install"}, {"axwindow", "", "Setup"}};
      if (!trigger_takeover(facts, "interlock-install-button-with-an-extension-is-a-takeover")) return false;
    }
    // Without a known extension it is the same button, with the same answer.
    EffectFacts unknown = EffBase();
    unknown.action = ActionKind::kClick;
    unknown.extension_known = false;
    unknown.extension = "sh";
    unknown.chain = {{"axbutton", "", "Install"}, {"axwindow", "", "Setup"}};
    if (!trigger_takeover(unknown, "interlock-install-button-with-an-unknown-extension")) return false;
    // An extension that is not plain is no extension at all: the button still decides.
    EffectFacts odd = unknown;
    odd.extension_known = true;
    odd.extension = "s h";
    if (!trigger_takeover(odd, "interlock-install-button-with-an-odd-extension")) return false;
    // The shape facts really have: a button that also carries a file (an AXURL / AXFilename makes
    // it an item) is still a control, and is judged as one.
    for (const char *extension : {"pkg", "sh", "exe"}) {
      EffectFacts facts = EffBase();
      facts.action = ActionKind::kClick;
      facts.target_is_file_item = true;
      facts.extension_known = true;
      facts.extension = extension;
      facts.chain = {{"axbutton", "", "Install"}, {"axwindow", "", "Setup"}};
      if (!trigger_takeover(facts, "interlock-install-button-that-is-also-an-item")) return false;
    }
    {
      // The label inside the button is inside the control.
      EffectFacts facts = EffBase();
      facts.action = ActionKind::kClick;
      facts.target_is_file_item = true;
      facts.extension_known = true;
      facts.extension = "pkg";
      facts.chain = {{"axstatictext", "", "Install"}, {"axbutton", "", "Install"}, {"axwindow", "", "Setup"}};
      if (!trigger_takeover(facts, "interlock-install-label-inside-a-button")) return false;
    }
    // A row, a cell or a text that is named like an installer is a file in a list, judged by its
    // extension and, inside an application, not refused: with or without an extension known.
    for (const char *role : {"axrow", "axcell", "axoutlinerow", "axstatictext", "listitem", "treeitem", "dataitem", "text"}) {
      for (const bool known : {true, false}) {
        EffectFacts facts = EffBase();
        facts.action = ActionKind::kInvoke;
        facts.target_is_file_item = known;
        facts.extension_known = known;
        facts.extension = known ? "sh" : "";
        facts.chain = {{role, "", "install.sh"}, {"axoutline", "", "Explorer"}, {"axwindow", "", "Editor"}};
        if (!none(facts, "interlock-installer-named-item-in-an-app-is-not-refused")) return false;
      }
    }
    {
      // The same on Windows, from the UIA facts the helper builds: a Button is a control, a ListItem
      // is a file.
      const auto windows = [](const char *control_type, const char *name) {
        ShadowUiaCapture capture = UiaBase();
        capture.window_class = "SomeAppClass";
        capture.process_path = "C:\\Apps\\app.exe";
        capture.chain = {UiaNode(control_type, name), UiaNode("Window", "App")};
        capture.item_kind = ShadowItemKind::kFile;
        capture.item_name_read = true;
        capture.item_name_is_real_path = true;
        capture.item_name = "C:\\Apps\\setup.pkg";
        return capture;
      };
      const ShadowUiaCapture button = windows("Button", "Install");
      if (!trigger_takeover(BuildWindowsShadowFacts(button, UiaRequest("click")).facts,
                            "interlock-windows-install-button-that-is-also-an-item")) return false;
      ShadowUiaCapture list_item = windows("ListItem", "install.sh");
      list_item.item_name = "C:\\Apps\\install.sh";
      if (!none(BuildWindowsShadowFacts(list_item, UiaRequest("invoke")).facts,
                "interlock-windows-installer-named-list-item")) return false;
    }
    // Fail closed: a role that is not known to be a passive item is a control. Unknown and custom
    // roles, and the controls that were never listed, are refused when the words or the extension say
    // install, and the allow list is matched whole, not by a word inside the role.
    for (const char *role : {"axcustomwidget", "AXDisclosureTriangle", "axcombobox", "axrowcustom", "axtextarea",
                             "axcellrenderer", "axsplitbutton", "axoutline", "AXGroup", "AXMenuBarItem",
                             "AXIncrementor", "AXButton", "AXLink", "AXMenuItem", "AXCheckBox",
                             "AXPopUpButton", "AXRadioButton", "AXTabGroup"}) {
      EffectFacts by_label = EffBase();
      by_label.action = ActionKind::kClick;
      by_label.chain = {{role, "", "Install"}, {"axwindow", "", "Setup"}};
      if (!trigger_takeover(by_label, "interlock-unknown-role-install-label")) return false;
      EffectFacts by_extension = by_label;
      by_extension.extension_known = true;
      by_extension.extension = "pkg";
      if (!trigger_takeover(by_extension, "interlock-unknown-role-install-label-with-an-extension")) return false;
    }
    {
      // The Windows control types that are not in the allow list.
      ShadowUiaCapture split = UiaBase();
      split.window_class = "SomeAppClass";
      split.process_path = "C:\\Apps\\app.exe";
      split.chain = {UiaNode("SplitButton", "Install"), UiaNode("Window", "App")};
      if (!trigger_takeover(BuildWindowsShadowFacts(split, UiaRequest("click")).facts,
                            "interlock-windows-split-button-install")) return false;
      for (const char *control_type : {"Custom", "ComboBox", "Spinner", "Button", "Hyperlink", "MenuItem",
                                       "CheckBox", "Group", "Pane", "TabItem"}) {
        ShadowUiaCapture custom = split;
        custom.chain = {UiaNode(control_type, "Install"), UiaNode("Window", "App")};
        if (!trigger_takeover(BuildWindowsShadowFacts(custom, UiaRequest("click")).facts,
                              "interlock-windows-control-type-install")) return false;
      }
    }
    {
      // A role in the allow list with a subrole that says button is not a passive item.
      EffectFacts mixed = EffBase();
      mixed.action = ActionKind::kClick;
      mixed.chain = {{"axrow", "axbutton", "Install"}, {"axwindow", "", "Setup"}};
      if (!trigger_takeover(mixed, "interlock-item-role-with-a-control-subrole")) return false;
    }
    {
      // A toggle aimed at a file with an executable extension, in an application, by a control that is
      // not an installer, is not a launch (the extension rule covers the toggle, and the editor
      // excuse applies to it like to any other opening in an application).
      EffectFacts toggle_control = EffBase();
      toggle_control.action = ActionKind::kToggle;
      toggle_control.target_is_file_item = true;
      toggle_control.extension_known = true;
      toggle_control.extension = "sh";
      toggle_control.chain = {{"axcheckbox", "", "keep"}, {"axwindow", "", "Editor"}};
      if (!none(toggle_control, "interlock-toggle-control-in-an-app-is-not-a-launch")) return false;
      // A download row whose extension is not known stays with v1 (a person decides): no verdict.
      EffectFacts dmg = EffBase();
      dmg.surface = SurfaceKind::kDownloadPanel;
      dmg.action = ActionKind::kDoubleClick;
      dmg.target_is_file_item = true;
      dmg.extension_known = false;
      dmg.chain = {{"axrow", "", "Installer.dmg"}, {"axwindow", "", "Downloads"}};
      if (!none(dmg, "interlock-download-row-with-an-unknown-extension-is-no-verdict")) return false;
    }
    {
      // An unknown ancestor between the label and the nearest known container may be the control that
      // is pressed (a page makes a group clickable): the passive item must reach a known container
      // through allow-listed roles only.
      EffectFacts group = EffBase();
      group.action = ActionKind::kClick;
      group.chain = {{"axstatictext", "", "Install"}, {"axgroup", "", ""}, {"axwindow", "", "Setup"}};
      if (!trigger_takeover(group, "interlock-label-under-an-unknown-group")) return false;
      EffectFacts custom_group = EffBase();
      custom_group.action = ActionKind::kClick;
      custom_group.chain = {{"axstatictext", "", "Install"}, {"axcustomwidget", "", ""}, {"axwindow", "", "Setup"}};
      if (!trigger_takeover(custom_group, "interlock-label-under-a-custom-ancestor")) return false;
      EffectFacts row_in_group = EffBase();
      row_in_group.action = ActionKind::kInvoke;
      row_in_group.chain = {{"axrow", "", "install.sh"}, {"axgroup", "", ""}, {"axoutline", "", "Explorer"},
                            {"axwindow", "", "Editor"}};
      if (!trigger_takeover(row_in_group, "interlock-row-under-an-unknown-group")) return false;
      // A chain that never reaches a known container proves nothing about what it is under.
      EffectFacts open_ended = EffBase();
      open_ended.action = ActionKind::kClick;
      open_ended.chain = {{"axrow", "", "Install"}, {"axrow", "", "Setup"}};
      if (!trigger_takeover(open_ended, "interlock-chain-without-a-known-container")) return false;
      // A container is not an item: the target itself being one is a control.
      EffectFacts container = EffBase();
      container.action = ActionKind::kClick;
      container.chain = {{"axoutline", "", "Install"}, {"axwindow", "", "Setup"}};
      if (!trigger_takeover(container, "interlock-container-as-the-target")) return false;
      // The passive chain under the usual containers stays no verdict.
      for (const char *container_role : {"axtable", "axlist", "axoutline", "axbrowser", "axscrollarea"}) {
        EffectFacts row = EffBase();
        row.action = ActionKind::kInvoke;
        row.chain = {{"axstatictext", "", "install.sh"}, {"axrow", "", ""}, {container_role, "", "Explorer"},
                     {"axwindow", "", "Editor"}};
        if (!none(row, "interlock-statictext-in-a-row-in-a-container")) return false;
      }
      {
        // The same shapes from UI Automation.
        ShadowUiaCapture text = UiaBase();
        text.window_class = "SomeAppClass";
        text.process_path = "C:\\Apps\\app.exe";
        text.chain = {UiaNode("Text", "Install"), UiaNode("Custom", ""), UiaNode("Window", "App")};
        if (!trigger_takeover(BuildWindowsShadowFacts(text, UiaRequest("click")).facts,
                              "interlock-windows-text-under-a-custom")) return false;
        ShadowUiaCapture item = UiaBase();
        item.window_class = "SomeAppClass";
        item.process_path = "C:\\Apps\\app.exe";
        item.chain = {UiaNode("Text", "install.sh"), UiaNode("ListItem", ""), UiaNode("List", "Files"),
                      UiaNode("Window", "App")};
        if (!none(BuildWindowsShadowFacts(item, UiaRequest("invoke")).facts,
                  "interlock-windows-text-in-a-list-item")) return false;
        for (const char *container_type : {"List", "Tree", "DataGrid", "Table", "Pane", "Document"}) {
          ShadowUiaCapture in_container = item;
          in_container.chain = {UiaNode("ListItem", "install.sh"), UiaNode(container_type, "Files"),
                                UiaNode("Window", "App")};
          if (!none(BuildWindowsShadowFacts(in_container, UiaRequest("invoke")).facts,
                    "interlock-windows-list-item-in-a-container")) return false;
        }
      }
    }
    {
      // A file named like an installer, opened from a file manager or a download list, is an opening
      // that needs an approval (E2 / E3): refused while the approval path is closed. The core may
      // call it E4 for the word in the name; the answer does not get weaker for that.
      for (const SurfaceKind surface : {SurfaceKind::kFileBrowser, SurfaceKind::kDownloadPanel}) {
        for (const bool item_flag : {true, false}) {
          for (const ActionKind action : {ActionKind::kDoubleClick, ActionKind::kInvoke, ActionKind::kClick}) {
            EffectFacts facts = EffBase();
            facts.surface = surface;
            facts.action = action;
            facts.target_is_file_item = item_flag;
            facts.extension_known = true;
            facts.extension = "txt";
            facts.chain = {{"axrow", "", "install.txt"}, {"axoutline", "", "Files"}, {"axwindow", "", "Downloads"}};
            // A single click on a passive item of a file manager only selects it (#777): no verdict.
            if (surface == SurfaceKind::kFileBrowser && action == ActionKind::kClick) {
              facts.click_tracked = true;
              if (!none(facts, "interlock-installer-named-item-clicked-in-a-file-manager")) return false;
              continue;
            }
            if (!trigger_blocked(facts, "interlock-installer-named-file-opened-from-a-list")) return false;
            if (!Check(InterlockForFacts(facts).effect_class ==
                           (surface == SurfaceKind::kDownloadPanel ? EffectClass::kE2DownloadOpen
                                                                   : EffectClass::kE3FileManagerOpen),
                       "interlock-listed-opening-names-its-class")) return false;
          }
        }
        // The refusal says "the approval is closed", so it is only true while it is: once the rule set
        // trusts the approval for this surface, the approval decides and this map has no verdict.
        for (const std::string &name : std::vector<std::string>{"install.txt", u8"インストール手順.pdf"_u8}) {
          EffectFacts named = EffBase();
          named.surface = surface;
          named.action = ActionKind::kDoubleClick;
          named.target_is_file_item = true;
          named.extension_known = true;
          named.extension = name.find("pdf") != std::string::npos ? "pdf" : "txt";
          named.chain = {{"axrow", "", name}, {"axoutline", "", "Files"}, {"axwindow", "", "Downloads"}};
          if (!trigger_blocked(named, "interlock-closed-approval-refuses-an-installer-named-file")) return false;
          EffectRuleset trusting;
          trusting.download_open = true;
          trusting.file_manager_open = true;
          if (!Check(!InterlockForFacts(named, trusting).Refuses(), "interlock-open-approval-leaves-an-installer-named-file"))
            return false;
          // Only the rule for this surface counts.
          EffectRuleset other;
          other.download_open = surface != SurfaceKind::kDownloadPanel;
          other.file_manager_open = surface != SurfaceKind::kFileBrowser;
          if (!Check(InterlockForFacts(named, other).Refuses(), "interlock-the-other-surfaces-approval-does-not-count"))
            return false;
          EffectRuleset own;
          own.download_open = surface == SurfaceKind::kDownloadPanel;
          own.file_manager_open = surface == SurfaceKind::kFileBrowser;
          if (!Check(!InterlockForFacts(named, own).Refuses(), "interlock-own-surfaces-approval-counts")) return false;
        }
        // Browsing it is not opening it.
        EffectFacts browse = EffBase();
        browse.surface = surface;
        browse.action = ActionKind::kSelect;
        browse.target_is_file_item = true;
        browse.extension_known = true;
        browse.extension = "txt";
        browse.chain = {{"axrow", "", "install.txt"}, {"axoutline", "", "Files"}, {"axwindow", "", "Downloads"}};
        if (!none(browse, "interlock-installer-named-file-selected-in-a-list")) return false;
        // An unknown extension stays with v1 (a person decides), as for any other name.
        EffectFacts unknown = browse;
        unknown.action = ActionKind::kDoubleClick;
        unknown.extension_known = false;
        unknown.extension = "";
        unknown.chain = {{"axrow", "", "Installer.dmg"}, {"axoutline", "", "Files"}, {"axwindow", "", "Downloads"}};
        if (!none(unknown, "interlock-installer-named-file-with-an-unknown-extension-in-a-list")) return false;
      }
      // The same name opened inside an application is a file in an editor, not refused.
      EffectFacts editor = EffBase();
      editor.surface = SurfaceKind::kOrdinary;
      editor.action = ActionKind::kDoubleClick;
      editor.target_is_file_item = true;
      editor.extension_known = true;
      editor.extension = "txt";
      editor.chain = {{"axrow", "", "install.txt"}, {"axoutline", "", "Explorer"}, {"axwindow", "", "Editor"}};
      if (!none(editor, "interlock-installer-named-file-opened-in-an-editor")) return false;
      // From UI Automation: an Explorer ListItem.
      ShadowUiaCapture explorer = UiaBase();
      explorer.window_class = "CabinetWClass";
      explorer.process_path = "C:\\Windows\\explorer.exe";
      explorer.chain = {UiaNode("ListItem", "install.txt"), UiaNode("List", "Items View"), UiaNode("Window", "Downloads")};
      explorer.item_kind = ShadowItemKind::kFile;
      explorer.item_name_read = true;
      explorer.item_name_is_real_path = true;
      explorer.item_name = "C:\\Users\\a\\Downloads\\install.txt";
      explorer.chain[1].class_name = "UIItemsView";
      if (!trigger_blocked(BuildWindowsShadowFacts(explorer, UiaRequest("invoke")).facts,
                           "interlock-windows-installer-named-file-in-explorer")) return false;
    }
    // The installer rule is the core's: the control must be activated, and its words must be readable.
    EffectFacts typed = EffBase();
    typed.action = ActionKind::kKey;
    typed.key_is_activation = false;
    typed.extension_known = true;
    typed.extension = "sh";
    typed.chain = {{"axbutton", "", "Install"}, {"axwindow", "", "Setup"}};
    if (!none(typed, "interlock-a-key-that-does-not-activate-is-not-an-installer")) return false;
    EffectFacts unreadable = EffBase();
    unreadable.action = ActionKind::kClick;
    unreadable.text_language_supported = false;
    unreadable.extension_known = true;
    unreadable.extension = "sh";
    unreadable.chain = {{"axbutton", "", "Install"}, {"axwindow", "", "Setup"}};
    if (!none(unreadable, "interlock-unreadable-words-are-not-an-installer")) return false;
    // A toggle in an application, aimed at an item with an executable extension, is not a launch.
    EffectFacts toggle = EffBase();
    toggle.action = ActionKind::kToggle;
    toggle.target_is_file_item = true;
    toggle.extension_known = true;
    toggle.extension = "sh";
    toggle.chain = {{"axrow", "", "install.sh"}, {"axwindow", "", "Editor"}};
    if (!none(toggle, "interlock-toggle-in-an-app-is-not-a-launch")) return false;
    // The core's extension rule without an extension behind it is not an extension verdict: a claimed
    // E1 on an ordinary surface with no known extension has no editor excuse.
    EffectFacts claim = EffBase();
    claim.action = ActionKind::kClick;
    claim.extension_known = false;
    claim.extension = "sh";
    EffectDecision e1;
    e1.effect_class = EffectClass::kE1ExecutableOpen;
    e1.kind = DecisionKind::kBlocked;
    e1.reason = DecisionReason::kExecutionTrigger;
    if (!Check(MapEffectToInterlock(claim, e1).Refuses(), "interlock-e1-claim-without-a-known-extension")) return false;
    claim.extension_known = true;
    if (!Check(!MapEffectToInterlock(claim, e1).Refuses(), "interlock-e1-claim-by-extension-in-an-app")) return false;
  }

  // E2 / E3: opening from a download list or a file manager needs an approval, and the approval
  // path is closed, so it is refused; once the rule set trusts it, the approval decides, not this.
  for (const SurfaceKind surface : {SurfaceKind::kFileBrowser, SurfaceKind::kDownloadPanel}) {
    EffectFacts facts = EffBase();
    facts.surface = surface;
    facts.action = ActionKind::kDoubleClick;
    facts.target_is_file_item = true;
    facts.extension_known = true;
    facts.extension = "pdf";
    facts.chain = {{"axrow", "", "report"}, {"axwindow", "", "Downloads"}};
    if (!trigger_blocked(facts, "interlock-approval-closed-is-blocked")) return false;
    EffectRuleset open;
    open.download_open = true;
    open.file_manager_open = true;
    if (!Check(!InterlockForFacts(facts, open).Refuses(), "interlock-approval-open-is-not-this-map")) return false;
    // Browsing is not opening, and an unknown extension is v1's.
    facts.action = ActionKind::kSelect;
    if (!none(facts, "interlock-browsing-is-no-verdict")) return false;
    facts.action = ActionKind::kDoubleClick;
    facts.extension_known = false;
    if (!none(facts, "interlock-unknown-extension-is-no-verdict")) return false;
  }

  // Everything else the core says is not an interlock: secure and credential fields, a confirmation,
  // a supervised action waiting for an approval, a sensitive origin, a round it could not classify.
  {
    EffectFacts facts = EffBase();
    facts.action = ActionKind::kType;
    facts.chain = {{"axsecuretextfield", "", "Password"}, {"axwindow", "", "Login"}};
    if (!none(facts, "interlock-secure-is-v1s")) return false;
    facts.chain = {{"axtextfield", "", "Card number"}, {"axwindow", "", "Pay"}};
    if (!none(facts, "interlock-credential-is-not-this-map")) return false;
    facts = EffBase();
    facts.chain = {{"axbutton", "", "Pay now"}, {"axwindow", "", "Shop"}};
    if (!none(facts, "interlock-confirm-is-not-this-map")) return false;
    facts = EffBase();
    facts.mode = SessionMode::kSupervised;
    if (!none(facts, "interlock-supervised-approval-is-not-this-map")) return false;
    facts = EffBase();
    facts.origin = OriginState::kSensitive;
    if (!none(facts, "interlock-sensitive-origin-is-not-this-map")) return false;
    facts = EffBase();
    facts.text_language_supported = false;
    if (!none(facts, "interlock-unclassifiable-is-no-verdict")) return false;
    facts = EffBase();
    facts.mode = SessionMode::kObserveOnly;
    if (!none(facts, "interlock-observe-only-mode-is-not-this-map")) return false;
  }

  // The map takes the core's decision and the facts. It does not re-derive the decision: it checks
  // the facts gate (complete metadata and chain, a known surface) and that the class comes with its
  // own reason, and takes a decision that passes both as given.
  {
    EffectFacts facts = EffBase();
    facts.action = ActionKind::kClick;
    EffectDecision claimed;
    claimed.effect_class = EffectClass::kSurface;
    claimed.kind = DecisionKind::kBlocked;
    claimed.reason = DecisionReason::kSurface;
    facts.surface = SurfaceKind::kShellLike;
    facts.metadata_complete = false;
    if (!Check(!MapEffectToInterlock(facts, claimed).Refuses(), "interlock-claim-on-incomplete-facts")) return false;
    facts.metadata_complete = true;
    if (!Check(MapEffectToInterlock(facts, claimed).Refuses(), "interlock-claim-on-complete-facts")) return false;
    // The gate is the core's: a cut chain, an empty chain and an unknown surface are not a ground.
    EffectFacts cut = facts;
    cut.chain_complete = false;
    if (!Check(!MapEffectToInterlock(cut, claimed).Refuses(), "interlock-claim-on-a-cut-chain")) return false;
    EffectFacts empty = facts;
    empty.chain.clear();
    if (!Check(!MapEffectToInterlock(empty, claimed).Refuses(), "interlock-claim-on-an-empty-chain")) return false;
    EffectFacts unknown = facts;
    unknown.surface = SurfaceKind::kUnknown;
    if (!Check(!MapEffectToInterlock(unknown, claimed).Refuses(), "interlock-claim-on-an-unknown-surface")) return false;
    // The reason has to be the class's own: another reason on the same class is not this map's.
    EffectDecision odd = claimed;
    odd.reason = DecisionReason::kSensitiveOrigin;
    if (!Check(!MapEffectToInterlock(facts, odd).Refuses(), "interlock-surface-class-with-another-reason")) return false;
    odd.effect_class = EffectClass::kE1ExecutableOpen;
    odd.reason = DecisionReason::kApprovalNotEnabled;
    if (!Check(!MapEffectToInterlock(facts, odd).Refuses(), "interlock-trigger-class-with-another-reason")) return false;
    odd.effect_class = EffectClass::kE3FileManagerOpen;
    odd.reason = DecisionReason::kExecutionTrigger;
    if (!Check(!MapEffectToInterlock(facts, odd).Refuses(), "interlock-approval-class-with-another-reason")) return false;
    // A decision that is not a block is never an interlock, whatever its class.
    odd.effect_class = EffectClass::kSurface;
    odd.reason = DecisionReason::kSurface;
    odd.kind = DecisionKind::kTakeover;
    if (!Check(!MapEffectToInterlock(facts, odd).Refuses(), "interlock-takeover-decision-is-not-a-block")) return false;
    // A blocked decision of another class does not become a surface verdict.
    claimed.effect_class = EffectClass::kSecure;
    claimed.reason = DecisionReason::kSecure;
    if (!Check(!MapEffectToInterlock(facts, claimed).Refuses(), "interlock-other-blocked-class")) return false;
  }
  // The three reasons the map can give each have exactly one row, and the table has no row the map
  // cannot explain: the interlock codes of the table are the codes of the map.
  {
    std::size_t interlock_rows = 0;
    for (const auto &entry : sprint_coder::computer_use::kNativePreflightRefusalTable) {
      const std::string_view code = entry.reason_code;
      if (code == "native_shell_surface_blocked" || code == "native_execution_trigger_blocked" ||
          code == "native_approval_not_enabled")
        ++interlock_rows;
    }
    if (!Check(interlock_rows == 3 && sprint_coder::computer_use::kNativePreflightRefusalCount == 6,
               "interlock-codes-have-one-row-each")) return false;
  }
  std::cout << "Computer Use native interlock map: PASS\n";
  return true;
}

// A page scroll is judged on nothing: the page title is not the scrolled control's caption.
bool CheckEffectPageScroll() {
  for (const char *role : {"axwebarea", "AXWebArea", "Document"}) {
    EffectFacts facts = EffBase();
    facts.action = ActionKind::kScroll;
    facts.chain = {{"axscrollarea", "", ""}, {role, "", "Card number tips"}, {"axwindow", "", "Browser"}};
    if (!Check(ClassifyEffect(facts).kind == DecisionKind::kOrdinary, "effect-page-scroll-title-is-out-of-scope"))
      return false;
    facts.chain = {{role, "", "Password reset"}, {"axwindow", "", "Browser"}};
    if (!Check(ClassifyEffect(facts).kind == DecisionKind::kOrdinary, "effect-page-root-scroll-is-ordinary"))
      return false;
    // A labeled control inside the page is still looked at.
    facts.chain = {{"axtextfield", "", "Password"}, {role, "", "Sign in"}, {"axwindow", "", "Browser"}};
    if (!Check(ClassifyEffect(facts).kind == DecisionKind::kBlocked, "effect-page-scroll-control-is-in-scope"))
      return false;
    // The page title is no caption for an unlabeled combobox, and no label for it either.
    facts.chain = {{"axcombobox", "", ""}, {role, "", "Pick a year"}, {"axwindow", "", "Browser"}};
    if (!Check(EffTakeover(facts), "effect-page-title-is-no-label-for-a-value-scroll")) return false;
    // Everything else about a page's text still applies to other actions.
    facts.action = ActionKind::kClick;
    facts.chain = {{"axbutton", "", "Pay now"}, {role, "", "Checkout"}, {"axwindow", "", "Browser"}};
    if (!Check(ClassifyEffect(facts).effect_class == EffectClass::kConfirm, "effect-page-title-still-read-for-click"))
      return false;
  }
  std::cout << "Computer Use native effect page scroll: PASS\n";
  return true;
}

bool CheckEffectClassifierCore() {
  using namespace sprint_coder::computer_use;
  using namespace sprint_coder::computer_use::effect_detail;

  // Candidate versions the enabling change will attest. The attested versions are still 1.
  if (!Check(kEffectClassifierVersion == 2 && kEffectRulesetVersion == 2 &&
                 kEffectLexiconVersion == 2 && kNativePreflightClassifierVersion == 1,
             "effect-versions-not-yet-attested")) return false;

  // An ordinary click is ordinary; reading is ordinary even when nothing could be classified.
  {
    const auto decision = ClassifyEffect(EffBase());
    if (!Check(EffIs(decision, DecisionKind::kOrdinary, DecisionReason::kNone,
                     EffectClass::kOrdinary) &&
                   decision.approval_effect == NativeApprovalEffect::kInvalid,
               "effect-ordinary")) return false;
    EffectFacts blind;
    blind.action = ActionKind::kObserve;
    if (!Check(ClassifyEffect(blind).kind == DecisionKind::kOrdinary, "effect-observe-never-blocked"))
      return false;
  }

  // Incomplete facts never become ordinary (D13): every input action, every way a fact can be
  // missing, including an unknown surface and sizes beyond the bounds.
  for (const ActionKind action : kEffAllInputs) {
    for (int missing = 0; missing < 8; ++missing) {
      EffectFacts facts = EffBase();
      facts.action = action;
      if (missing == 0) facts.metadata_complete = false;
      if (missing == 1) facts.chain_complete = false;
      if (missing == 2) facts.chain.clear();
      if (missing == 3) facts.surface = SurfaceKind::kUnknown;
      if (missing == 4) facts.chain.resize(kEffectMaxChainNodes + 1, NodeFacts{"axgroup", "", "x"});
      if (missing == 5) facts.chain[0].label = std::string(kEffectMaxLabelBytes + 1, 'a');
      if (missing == 6) facts.neighbor_labels.assign(kEffectMaxNeighborLabels + 1, "x");
      if (missing == 7) facts.extension = std::string(kEffectMaxLabelBytes + 1, 'a');
      if (!Check(EffTakeover(facts, EffAllEnabled()), "effect-incomplete-takeover")) return false;
    }
  }

  // Text the classifier cannot read is a round it could not be applied to (ADR section 4): no
  // label anywhere, an unsupported language, or a script that imitates Latin letters. A scroll
  // cannot confirm, open or run anything, so it does not need readable text.
  for (const ActionKind action : kEffAllInputs) {
    EffectFacts blank = EffLabel("", action);
    EffectFacts unsupported = EffLabel("Jetzt kaufen", action);
    unsupported.text_language_supported = false;
    EffectFacts lookalike = EffLabel("p\xD0\xB0y now", action);  // Cyrillic a
    EffectFacts greek = EffLabel("\xCE\xBF\x6b", action);          // Greek omicron + "k"
    EffectFacts roleOnly = EffBase();
    roleOnly.action = action;
    roleOnly.chain[0] = NodeFacts{"axbutton", "axpress", ""};
    for (const EffectFacts *facts : {&blank, &unsupported, &lookalike, &greek, &roleOnly}) {
      if (action == ActionKind::kScroll) {
        // A scroll needs no label or language, but the text it is judged on must be readable.
        const bool unreadable = facts == &lookalike || facts == &greek;
        if (!Check((ClassifyEffect(*facts).kind == DecisionKind::kTakeover) == unreadable,
                   "effect-scroll-needs-no-text-but-readable-text")) return false;
      } else if (!Check(EffTakeover(*facts, EffAllEnabled()), "effect-unreadable-text-takeover")) {
        return false;
      }
    }
  }
  {
    EffectFacts supervised = EffLabel("");
    supervised.mode = SessionMode::kSupervised;
    if (!Check(EffTakeover(supervised), "effect-unreadable-text-not-supervised-approval")) return false;
    EffectFacts observe = EffLabel("");
    observe.action = ActionKind::kObserve;
    if (!Check(ClassifyEffect(observe).kind == DecisionKind::kOrdinary, "effect-unreadable-observe"))
      return false;
  }

  // Invisible code points cannot hide a word (soft hyphen, zero-width space and joiners,
  // directional marks, word joiner, variation selectors, BOM) and ASCII case is folded.
  {
    const std::string invisible[] = {"\xC2\xAD", "\xE2\x80\x8B", "\xE2\x80\x8C", "\xE2\x80\x8D",
                                     "\xE2\x80\x8E", "\xE2\x80\xAA", "\xE2\x81\xA0",
                                     "\xE1\xA0\x8E", "\xEF\xBB\xBF", "\xEF\xB8\x8F"};
    for (const std::string &mark : invisible) {
      if (!Check(ClassifyEffect(EffLabel("pa" + mark + "y no" + mark + "w", ActionKind::kInvoke))
                         .effect_class == EffectClass::kConfirm,
                 "effect-invisible-confirm")) return false;
      if (!Check(ClassifyEffect(EffLabel("pass" + mark + "word", ActionKind::kType)).reason ==
                     DecisionReason::kSecure,
                 "effect-invisible-secure")) return false;
      if (!Check(ClassifyEffect(EffLabel("c" + mark + "vv", ActionKind::kType)).reason ==
                     DecisionReason::kCredential,
                 "effect-invisible-credential")) return false;
    }
    if (!Check(NormalizeForMatch("PAY \xE2\x80\x8B" "Now") == "pay now", "effect-normalize")) return false;
    if (!Check(ClassifyEffect(EffLabel("PAY NOW", ActionKind::kInvoke)).effect_class == EffectClass::kConfirm,
               "effect-case-fold")) return false;
  }

  // Secure fields are blocked outright, by role or by words (en / ja), also from an ancestor, with
  // the usual spellings around them.
  for (const std::string &label : std::vector<std::string>{"securetextfield", "password", "passcode", "pin code", u8"パスワード"_u8,
                            u8"暗証番号"_u8, "passwords", "password1", "userpassword", "Enter PIN", "PIN",
                            "pin entry"}) {
    EffectFacts facts = EffLabel(label, ActionKind::kType);
    if (!Check(EffIs(ClassifyEffect(facts), DecisionKind::kBlocked, DecisionReason::kSecure,
                     EffectClass::kSecure), "effect-secure")) return false;
    EffectFacts ancestor = EffBase();
    ancestor.action = ActionKind::kType;
    ancestor.chain.push_back(NodeFacts{"axgroup", "", label});
    if (!Check(ClassifyEffect(ancestor).reason == DecisionReason::kSecure, "effect-secure-ancestor"))
      return false;
  }
  for (const std::string &label : std::vector<std::string>{"pinterest", "shipping", "spinner", "opinion"}) {
    if (!Check(ClassifyEffect(EffLabel(label, ActionKind::kType)).kind == DecisionKind::kOrdinary,
               "effect-secure-negatives")) return false;
  }
  {
    EffectFacts facts = EffBase();
    facts.action = ActionKind::kSetText;
    facts.chain[0].subrole = "axsecuretextfield";
    if (!Check(ClassifyEffect(facts).reason == DecisionReason::kSecure, "effect-secure-subrole"))
      return false;
  }

  // Card numbers, security codes and expiry fields are refused with no approval for any input,
  // including the codes and identifiers real forms use.
  for (const std::string &label : std::vector<std::string>{"card number", "cvv", "cvc", "security code", "expiration date",
                            u8"カード番号"_u8, u8"セキュリティコード"_u8, u8"有効期限"_u8, "CVV2", "CVC2",
                            "cardNumber", "cc-csc", "cc-number", "cc-exp", "cvv code",
                            "cardholder name", "account number"}) {
    for (const ActionKind action : {ActionKind::kSetText, ActionKind::kType, ActionKind::kKey,
                                    ActionKind::kClick, ActionKind::kSelect}) {
      if (!Check(EffIs(ClassifyEffect(EffLabel(label, action), EffAllEnabled()),
                       DecisionKind::kBlocked, DecisionReason::kCredential,
                       EffectClass::kCredential), "effect-credential")) return false;
    }
    if (!Check(ClassifyEffect(EffLabel(label, ActionKind::kObserve)).kind == DecisionKind::kOrdinary,
               "effect-credential-observe")) return false;
  }
  if (!Check(ClassifyEffect(EffLabel("csc", ActionKind::kType)).kind == DecisionKind::kOrdinary &&
                 ClassifyEffect(EffLabel("discover", ActionKind::kType)).kind ==
                     DecisionKind::kOrdinary,
             "effect-credential-negatives")) return false;

  // A field's caption often sits next to it, not on it. For text entry in a browser the
  // neighbours count, and unread neighbours are a takeover; clicking a neighbour is not entry.
  {
    EffectFacts facts = EffLabel("input", ActionKind::kType);
    facts.origin = OriginState::kOrdinary;
    facts.neighbor_labels = {"Card number"};
    facts.neighbor_labels_complete = true;
    if (!Check(ClassifyEffect(facts).reason == DecisionReason::kCredential, "effect-neighbor-credential"))
      return false;
    facts.neighbor_labels = {"Password"};
    if (!Check(ClassifyEffect(facts).reason == DecisionReason::kSecure, "effect-neighbor-secure"))
      return false;
    facts.neighbor_labels = {"Nickname"};
    if (!Check(ClassifyEffect(facts).kind == DecisionKind::kOrdinary, "effect-neighbor-ordinary"))
      return false;
    facts.neighbor_labels_complete = false;
    if (!Check(EffTakeover(facts), "effect-neighbor-incomplete-takeover")) return false;
    facts.action = ActionKind::kClick;
    facts.neighbor_labels = {"Card number"};
    if (!Check(ClassifyEffect(facts).kind == DecisionKind::kOrdinary, "effect-neighbor-click-unaffected"))
      return false;
    // A native app has no neighbour requirement.
    EffectFacts native = EffLabel("input", ActionKind::kType);
    if (!Check(ClassifyEffect(native).kind == DecisionKind::kOrdinary, "effect-neighbor-native"))
      return false;
  }

  // Command surfaces refuse input, whether the surface kind or the words say so.
  for (const SurfaceKind surface :
       {SurfaceKind::kShellLike, SurfaceKind::kScriptInput, SurfaceKind::kCommandPalette,
        SurfaceKind::kDevToolsConsole}) {
    for (const ActionKind action : {ActionKind::kType, ActionKind::kKey, ActionKind::kSetText,
                                    ActionKind::kInvoke, ActionKind::kClick}) {
      EffectFacts facts = EffBase();
      facts.surface = surface;
      facts.action = action;
      if (!Check(EffIs(ClassifyEffect(facts, EffAllEnabled()), DecisionKind::kBlocked,
                       DecisionReason::kSurface, EffectClass::kSurface), "effect-surface"))
        return false;
    }
  }
  for (const std::string &label : std::vector<std::string>{"integrated terminal", "terminal", "powershell", "command prompt",
                            "run script", "shell script", u8"ターミナル"_u8, u8"コンソール"_u8,
                            u8"コマンドプロンプト"_u8, u8"スクリプトを実行"_u8}) {
    if (!Check(ClassifyEffect(EffLabel(label, ActionKind::kType)).reason == DecisionReason::kSurface,
               "effect-surface-words")) return false;
  }

  // E1 / E4: an executable or installer extension is refused for anything that might open the
  // item, wherever it is shown and whether or not the target is the item itself. It wins over
  // E2 / E3 and over a fully enabled rule set. Browsing (a semantic select, a rename) is not it.
  for (const std::string_view ext : kExecutableExtensions) {
    const bool installer = [&] {
      for (const std::string_view entry : kInstallerExtensions)
        if (entry == ext) return true;
      return false;
    }();
    for (const SurfaceKind surface :
         {SurfaceKind::kFileBrowser, SurfaceKind::kDownloadPanel, SurfaceKind::kOrdinary}) {
      for (const ActionKind action :
           {ActionKind::kInvoke, ActionKind::kDoubleClick, ActionKind::kClick, ActionKind::kKey,
            ActionKind::kToggle}) {
        for (const bool item : {true, false}) {
          EffectFacts facts = EffItem(surface, action, std::string(ext));
          facts.target_is_file_item = item;
          facts.chain[0].label = item ? "ok" : "open";
          facts.key_is_activation = action == ActionKind::kKey;
          const auto decision = ClassifyEffect(facts, EffAllEnabled());
          if (!Check(decision.kind == DecisionKind::kBlocked &&
                         decision.reason == DecisionReason::kExecutionTrigger &&
                         decision.effect_class == (installer ? EffectClass::kE4InstallerLaunch
                                                             : EffectClass::kE1ExecutableOpen),
                     "effect-e1-e4-extension")) return false;
        }
      }
    }
    for (const ActionKind browsing : {ActionKind::kSelect, ActionKind::kSetText, ActionKind::kScroll}) {
      EffectFacts facts = EffItem(SurfaceKind::kFileBrowser, browsing, std::string(ext));
      if (!Check(ClassifyEffect(facts, EffAllEnabled()).kind == DecisionKind::kOrdinary,
                 "effect-e1-browsing-is-not-opening")) return false;
    }
  }
  // An uppercase extension from the platform is the same extension, and a macOS package is an item.
  {
    EffectFacts facts = EffItem(SurfaceKind::kFileBrowser, ActionKind::kInvoke, "EXE");
    if (!Check(ClassifyEffect(facts, EffAllEnabled()).kind == DecisionKind::kBlocked,
               "effect-e1-extension-case")) return false;
    EffectFacts package = EffItem(SurfaceKind::kFileBrowser, ActionKind::kDoubleClick, "app");
    if (!Check(ClassifyEffect(package, EffAllEnabled()).effect_class == EffectClass::kE1ExecutableOpen,
               "effect-e1-package")) return false;
  }
  // E4 by label: a control that starts an installer, however it is activated, or reached through an
  // unlabeled child whose nearest actionable ancestor says so.
  for (const std::string &label : std::vector<std::string>{"install", "install application", u8"インストール"_u8}) {
    for (const ActionKind action : {ActionKind::kInvoke, ActionKind::kClick, ActionKind::kToggle,
                                    ActionKind::kSelect, ActionKind::kKey}) {
      EffectFacts facts = EffLabel(label, action);
      facts.key_is_activation = action == ActionKind::kKey;
      if (!Check(EffIs(ClassifyEffect(facts, EffAllEnabled()), DecisionKind::kBlocked,
                       DecisionReason::kExecutionTrigger, EffectClass::kE4InstallerLaunch),
                 "effect-e4-label")) return false;
    }
    EffectFacts child = EffBase();
    child.chain[0] = NodeFacts{"aximage", "", ""};
    child.chain.push_back(NodeFacts{"axbutton", "", label});
    child.chain.push_back(NodeFacts{"axwindow", "", "Setup"});
    if (!Check(ClassifyEffect(child, EffAllEnabled()).effect_class == EffectClass::kE4InstallerLaunch,
               "effect-e4-actionable-ancestor")) return false;
  }
  {
    // Typing the word is not activating an installer.
    if (!Check(ClassifyEffect(EffLabel("install", ActionKind::kType)).kind == DecisionKind::kOrdinary,
               "effect-e4-typing")) return false;
  }

  // E2: a download list's open control (a file row or a bare "open" button), for a harmless
  // extension, is an approval when the rule set enables it, a refusal while it does not, and a
  // takeover when the extension is unknown.
  for (const bool item : {true, false}) {
    for (const ActionKind action : {ActionKind::kInvoke, ActionKind::kClick, ActionKind::kDoubleClick,
                                    ActionKind::kKey}) {
      EffectFacts facts = EffItem(SurfaceKind::kDownloadPanel, action, "pdf");
      facts.target_is_file_item = item;
      facts.key_is_activation = action == ActionKind::kKey;
      facts.chain[0].label = item ? "report" : "open";
      const auto enabled = ClassifyEffect(facts, EffAllEnabled());
      if (!Check(EffIs(enabled, DecisionKind::kApproval, DecisionReason::kNone,
                       EffectClass::kE2DownloadOpen) &&
                     enabled.approval_effect == NativeApprovalEffect::kDownloadOpen,
                 "effect-e2-approval")) return false;
      if (!Check(EffIs(ClassifyEffect(facts), DecisionKind::kBlocked,
                       DecisionReason::kApprovalNotEnabled, EffectClass::kE2DownloadOpen),
                 "effect-e2-not-enabled-by-default")) return false;
      facts.extension_known = false;
      if (!Check(EffTakeover(facts, EffAllEnabled()), "effect-e2-unknown-extension")) return false;
    }
  }
  // A control in a download list that is not an opening one stays ordinary.
  {
    EffectFacts facts = EffItem(SurfaceKind::kDownloadPanel, ActionKind::kClick, "pdf");
    facts.target_is_file_item = false;
    facts.chain[0].label = "cancel";
    if (!Check(ClassifyEffect(facts, EffAllEnabled()).kind == DecisionKind::kOrdinary,
               "effect-e2-other-control")) return false;
  }
  // E3: opening a file in a file manager, by any action that might open it. A semantic select, a
  // rename and a scroll are browsing; so is anything on a folder.
  {
    for (const ActionKind action : {ActionKind::kInvoke, ActionKind::kDoubleClick, ActionKind::kClick,
                                    ActionKind::kKey}) {
      EffectFacts facts = EffItem(SurfaceKind::kFileBrowser, action, "txt");
      facts.key_is_activation = action == ActionKind::kKey;
      const auto decision = ClassifyEffect(facts, EffAllEnabled());
      if (!Check(EffIs(decision, DecisionKind::kApproval, DecisionReason::kNone,
                       EffectClass::kE3FileManagerOpen) &&
                     decision.approval_effect == NativeApprovalEffect::kFileManagerOpen,
                 "effect-e3-approval")) return false;
      if (!Check(EffIs(ClassifyEffect(facts), DecisionKind::kBlocked,
                       DecisionReason::kApprovalNotEnabled, EffectClass::kE3FileManagerOpen),
                 "effect-e3-not-enabled-by-default")) return false;
      facts.extension_known = false;
      if (!Check(EffTakeover(facts, EffAllEnabled()), "effect-e3-unknown-extension")) return false;
      facts.extension_known = true;
      facts.key_is_activation = false;
      // Only an activating key (Enter) opens; an arrow, Tab or Escape moves or dismisses (click rule).
      if (action == ActionKind::kKey &&
          !Check(ClassifyEffect(facts, EffAllEnabled()).kind == DecisionKind::kOrdinary,
                 "effect-e3-only-an-activating-key-opens")) return false;
    }
    for (const ActionKind browsing : {ActionKind::kSelect, ActionKind::kSetText, ActionKind::kScroll,
                                      ActionKind::kExpandCollapse}) {
      EffectFacts facts = EffItem(SurfaceKind::kFileBrowser, browsing, "txt");
      if (!Check(ClassifyEffect(facts, EffAllEnabled()).kind == DecisionKind::kOrdinary,
                 "effect-e3-browsing-ordinary")) return false;
    }
    for (const ActionKind action : {ActionKind::kClick, ActionKind::kInvoke, ActionKind::kDoubleClick,
                                    ActionKind::kKey}) {
      EffectFacts folder = EffItem(SurfaceKind::kFileBrowser, action, "");
      folder.target_is_file_item = false;
      folder.extension_known = false;
      if (!Check(ClassifyEffect(folder, EffAllEnabled()).kind == DecisionKind::kOrdinary,
                 "effect-e3-folder-ordinary")) return false;
    }
    // A menu item that opens the selection ("Open", "Open with", ja) is the opening control; the
    // extension is the selected item's.
    for (const std::string &label : std::vector<std::string>{"open", "open with", u8"開く"_u8, u8"アプリケーションで開く"_u8}) {
      EffectFacts menu = EffBase();
      menu.surface = SurfaceKind::kFileBrowser;
      menu.action = ActionKind::kInvoke;
      menu.chain[0] = NodeFacts{"axmenuitem", "", label};
      menu.extension_known = true;
      menu.extension = "txt";
      if (!Check(ClassifyEffect(menu, EffAllEnabled()).effect_class == EffectClass::kE3FileManagerOpen,
                 "effect-e3-menu-open")) return false;
      menu.extension = "exe";
      if (!Check(ClassifyEffect(menu, EffAllEnabled()).effect_class == EffectClass::kE1ExecutableOpen,
                 "effect-e3-menu-open-executable")) return false;
      menu.extension_known = false;
      if (!Check(EffTakeover(menu, EffAllEnabled()), "effect-e3-menu-open-unknown")) return false;
    }
    // A file item opened from an ordinary surface needs its extension too.
    EffectFacts mail = EffItem(SurfaceKind::kOrdinary, ActionKind::kDoubleClick, "txt");
    if (!Check(ClassifyEffect(mail, EffAllEnabled()).kind == DecisionKind::kOrdinary,
               "effect-unlisted-known-extension")) return false;
    mail.extension_known = false;
    if (!Check(EffTakeover(mail, EffAllEnabled()), "effect-unlisted-unknown-extension")) return false;
  }

  // §3.5 confirmations are approvals by default for anything that activates the control; typing
  // is not activation. Everyday labels are not confirmations (v1 policy).
  for (const std::string &label : std::vector<std::string>{"pay now", "place order", "buy now", "wire transfer", "send money",
                            "grant access", "authorize", "delete and continue", "purchase",
                            "checkout", "subscribe", "allow", "Buy", "Purchase", u8"送金"_u8, u8"振込"_u8,
                            u8"決済"_u8, u8"購入確定"_u8, u8"注文を確定"_u8, u8"アクセスを許可"_u8, u8"権限を付与"_u8,
                            u8"削除して続行"_u8, u8"購入する"_u8, u8"今すぐ購入"_u8, u8"注文する"_u8, u8"お支払い"_u8,
                            u8"お支払いを確定する"_u8, u8"支払います"_u8, u8"同意して続行"_u8}) {
    for (const ActionKind action : {ActionKind::kClick, ActionKind::kInvoke, ActionKind::kToggle,
                                    ActionKind::kSelect, ActionKind::kDoubleClick}) {
      const auto decision = ClassifyEffect(EffLabel(label, action));
      if (!Check(EffIs(decision, DecisionKind::kApproval, DecisionReason::kNone,
                       EffectClass::kConfirm) &&
                     decision.approval_effect == NativeApprovalEffect::kHighImpactConfirmation,
                 "effect-confirm")) return false;
    }
    EffectFacts space = EffLabel(label, ActionKind::kKey);
    space.key_is_activation = true;
    if (!Check(ClassifyEffect(space).effect_class == EffectClass::kConfirm, "effect-confirm-space"))
      return false;
    for (const ActionKind inert : {ActionKind::kObserve, ActionKind::kScroll}) {
      if (!Check(ClassifyEffect(EffLabel(label, inert)).kind == DecisionKind::kOrdinary,
                 "effect-confirm-inert")) return false;
    }
    if (!Check(ClassifyEffect(EffLabel(label, ActionKind::kSetText)).kind == DecisionKind::kOrdinary,
               "effect-confirm-typing")) return false;
  }
  for (const std::string &label : std::vector<std::string>{"save", "send", "publish", "delete", "submit", "ok", "cancel", u8"保存"_u8,
                            u8"送信"_u8, u8"公開"_u8, u8"削除"_u8, "payload", "repay", "buyer",
                            "payment history viewer settings", "allowance", "purchased items"}) {
    if (!Check(ClassifyEffect(EffLabel(label, ActionKind::kInvoke)).kind == DecisionKind::kOrdinary,
               "effect-everyday-labels")) return false;
  }
  if (!Check(ClassifyEffect(EffLabel("please pay now to continue")).effect_class == EffectClass::kConfirm,
             "effect-bounded-terms")) return false;
  // The click lands on an unlabeled child: the nearest actionable ancestor decides, and a nearer
  // actionable control hides a farther caption.
  {
    EffectFacts facts = EffBase();
    facts.chain[0] = NodeFacts{"axstatictext", "", ""};
    facts.chain.push_back(NodeFacts{"axbutton", "", "pay now"});
    facts.chain.push_back(NodeFacts{"axwindow", "", "Shop"});
    if (!Check(ClassifyEffect(facts).effect_class == EffectClass::kConfirm, "effect-actionable-ancestor"))
      return false;
    facts.chain[1].label = "save";
    facts.chain[2].label = "pay now";
    if (!Check(ClassifyEffect(facts).kind == DecisionKind::kOrdinary, "effect-nearest-actionable-wins"))
      return false;
  }

  // Session modes: a supervised session gets an approval for any ordinary input; a full-access
  // one does not; observe-only refuses input.
  {
    EffectFacts facts = EffBase();
    facts.mode = SessionMode::kSupervised;
    const auto decision = ClassifyEffect(facts);
    if (!Check(EffIs(decision, DecisionKind::kApproval, DecisionReason::kNone,
                     EffectClass::kOrdinary) &&
                   decision.approval_effect == NativeApprovalEffect::kSupervisedAction,
               "effect-supervised")) return false;
    EffectRuleset off;
    off.supervised_action = false;
    if (!Check(EffIs(ClassifyEffect(facts, off), DecisionKind::kBlocked,
                     DecisionReason::kApprovalNotEnabled, EffectClass::kOrdinary),
               "effect-supervised-not-enabled")) return false;
    facts.mode = SessionMode::kObserveOnly;
    if (!Check(EffIs(ClassifyEffect(facts), DecisionKind::kBlocked, DecisionReason::kObserveOnly,
                     EffectClass::kOrdinary), "effect-observe-only")) return false;
    facts.action = ActionKind::kObserve;
    if (!Check(ClassifyEffect(facts).kind == DecisionKind::kOrdinary, "effect-observe-only-read"))
      return false;
  }

  // A browser whose origin was read and is ordinary behaves like any other app; one whose origin
  // could not be read, or is sensitive, is taken over by a person for every input but never
  // blocks reading.
  {
    EffectFacts ordinary = EffLabel("pay now", ActionKind::kInvoke);
    ordinary.origin = OriginState::kOrdinary;
    const auto confirm = ClassifyEffect(ordinary);
    if (!Check(confirm.kind == DecisionKind::kApproval &&
                   confirm.effect_class == EffectClass::kConfirm,
               "effect-origin-ordinary-confirm")) return false;
    ordinary.chain[0].label = "ok";
    if (!Check(ClassifyEffect(ordinary).kind == DecisionKind::kOrdinary, "effect-origin-ordinary-click"))
      return false;
    ordinary.mode = SessionMode::kSupervised;
    if (!Check(ClassifyEffect(ordinary).approval_effect == NativeApprovalEffect::kSupervisedAction,
               "effect-origin-ordinary-supervised")) return false;

    EffectFacts unknown = EffLabel("pay now", ActionKind::kInvoke);
    unknown.origin = OriginState::kUnknown;
    for (const ActionKind action : kEffAllInputs) {
      unknown.action = action;
      if (!Check(EffTakeover(unknown, EffAllEnabled()), "effect-origin-unknown")) return false;
    }
    EffectFacts sensitive = EffLabel("ok", ActionKind::kInvoke);
    sensitive.origin = OriginState::kSensitive;
    if (!Check(EffIs(ClassifyEffect(sensitive, EffAllEnabled()), DecisionKind::kTakeover,
                     DecisionReason::kSensitiveOrigin, EffectClass::kSurface),
               "effect-origin-sensitive")) return false;
    sensitive.action = ActionKind::kObserve;
    unknown.action = ActionKind::kObserve;
    if (!Check(ClassifyEffect(sensitive).kind == DecisionKind::kOrdinary &&
                   ClassifyEffect(unknown).kind == DecisionKind::kOrdinary,
               "effect-origin-observe")) return false;
  }

  // Precedence: secure > credential > surface > execution triggers > confirmation > supervised.
  {
    EffectFacts facts = EffLabel("password card number pay now install", ActionKind::kInvoke);
    facts.mode = SessionMode::kSupervised;
    if (!Check(ClassifyEffect(facts, EffAllEnabled()).reason == DecisionReason::kSecure,
               "effect-precedence-secure")) return false;
    facts.chain[0].label = "card number pay now install";
    if (!Check(ClassifyEffect(facts, EffAllEnabled()).reason == DecisionReason::kCredential,
               "effect-precedence-credential")) return false;
    facts.chain[0].label = "terminal pay now install";
    if (!Check(ClassifyEffect(facts, EffAllEnabled()).reason == DecisionReason::kSurface,
               "effect-precedence-surface")) return false;
    facts.chain[0].label = "pay now install";
    if (!Check(ClassifyEffect(facts, EffAllEnabled()).effect_class == EffectClass::kE4InstallerLaunch,
               "effect-precedence-execution")) return false;
    facts.chain[0].label = "pay now";
    if (!Check(ClassifyEffect(facts, EffAllEnabled()).effect_class == EffectClass::kConfirm,
               "effect-precedence-confirm")) return false;
    facts.surface = SurfaceKind::kShellLike;
    facts.chain[0].label = "";
    if (!Check(ClassifyEffect(facts, EffAllEnabled()).reason == DecisionReason::kSurface,
               "effect-precedence-surface-without-text")) return false;
  }

  // The control the action lands on must carry the label, not the window around it: a titled
  // window with an unlabeled button (or an icon inside one) is unreadable, however it is reached.
  {
    auto unlabeled = [](std::vector<NodeFacts> chain) {
      EffectFacts facts = EffBase();
      facts.chain = std::move(chain);
      return facts;
    };
    const std::vector<std::vector<NodeFacts>> chains = {
        {{"axbutton", "", ""}, {"axwindow", "", "Shop"}},
        {{"aximage", "", ""}, {"axbutton", "", ""}, {"axwindow", "", "Checkout"}},
        {{"axgroup", "", ""}, {"axwindow", "", "pay now"}},
    };
    for (const auto &chain : chains) {
      for (const SessionMode mode : {SessionMode::kFullAccess, SessionMode::kSupervised}) {
        for (const ActionKind action : {ActionKind::kClick, ActionKind::kInvoke, ActionKind::kToggle,
                                        ActionKind::kSelect, ActionKind::kDoubleClick}) {
          EffectFacts facts = unlabeled(chain);
          facts.mode = mode;
          facts.action = action;
          if (!Check(EffTakeover(facts, EffAllEnabled()), "effect-unlabeled-control-takeover"))
            return false;
        }
      }
      EffectFacts scroll = unlabeled(chain);
      scroll.action = ActionKind::kScroll;
      if (!Check(ClassifyEffect(scroll).kind == DecisionKind::kOrdinary, "effect-unlabeled-scroll"))
        return false;
    }
    // Text entry: the field's own label, or in a browser a caption near it; a window title is not.
    EffectFacts field = unlabeled({{"axtextfield", "", ""}, {"axwindow", "", "Pay"}});
    field.action = ActionKind::kType;
    if (!Check(EffTakeover(field), "effect-unlabeled-field-takeover")) return false;
    field.origin = OriginState::kOrdinary;
    field.neighbor_labels = {"Nickname"};
    field.neighbor_labels_complete = true;
    if (!Check(ClassifyEffect(field).kind == DecisionKind::kOrdinary, "effect-field-captioned-by-neighbor"))
      return false;
    field.neighbor_labels = {""};
    if (!Check(EffTakeover(field), "effect-field-empty-neighbor")) return false;
    field.origin = OriginState::kNotApplicable;
    field.neighbor_labels = {"Nickname"};
    if (!Check(EffTakeover(field), "effect-native-field-neighbor-is-not-a-label")) return false;
    // A labeled control in an untitled window is fine, and a window title never counts as the
    // control's own words: with no actionable ancestor only the target is looked at.
    EffectFacts titled = unlabeled({{"axbutton", "", "ok"}, {"axwindow", "", ""}});
    if (!Check(ClassifyEffect(titled).kind == DecisionKind::kOrdinary, "effect-labeled-control"))
      return false;
    EffectFacts plain = unlabeled({{"axgroup", "", "ok"}, {"axwindow", "", "pay now"}});
    if (!Check(ClassifyEffect(plain, EffAllEnabled()).kind == DecisionKind::kOrdinary,
               "effect-window-title-is-not-the-control")) return false;
    EffectFacts installer = unlabeled({{"axgroup", "", "ok"}, {"axwindow", "", "install"}});
    if (!Check(ClassifyEffect(installer, EffAllEnabled()).kind == DecisionKind::kOrdinary,
               "effect-window-title-is-not-an-installer")) return false;
  }

  // Captions near a field count for text entry in a browser, with the short codes too, for every
  // way of entering text; clicking next to a caption is not entry. Look-alike text anywhere near
  // the field cannot be read.
  for (const ActionKind action : {ActionKind::kType, ActionKind::kSetText, ActionKind::kKey}) {
    for (const auto &[caption, reason] :
         std::vector<std::pair<std::string, DecisionReason>>{{"CVV", DecisionReason::kCredential},
                                                              {"cvc code", DecisionReason::kCredential},
                                                              {"CC-CSC", DecisionReason::kCredential},
                                                              {"PIN", DecisionReason::kSecure},
                                                              {"Enter your PIN", DecisionReason::kSecure}}) {
      EffectFacts facts = EffLabel("input", action);
      facts.origin = OriginState::kOrdinary;
      facts.neighbor_labels = {caption};
      facts.neighbor_labels_complete = true;
      if (!Check(ClassifyEffect(facts).reason == reason, "effect-neighbor-short-codes")) return false;
    }
    EffectFacts lookalike = EffLabel("input", action);
    lookalike.origin = OriginState::kOrdinary;
    lookalike.neighbor_labels = {"P\xD0\xB0ssword"};  // Cyrillic a
    lookalike.neighbor_labels_complete = true;
    if (!Check(EffTakeover(lookalike), "effect-neighbor-lookalike")) return false;
    EffectFacts incomplete = EffLabel("input", action);
    incomplete.origin = OriginState::kOrdinary;
    incomplete.neighbor_labels = {"Nickname"};
    if (!Check(EffTakeover(incomplete), "effect-neighbor-incomplete-for-every-entry")) return false;
  }
  {
    // A key that only types (not an activation) is not an activation of a "pay now" button.
    EffectFacts typed = EffLabel("pay now", ActionKind::kKey);
    typed.key_is_activation = false;
    if (!Check(ClassifyEffect(typed).kind == DecisionKind::kOrdinary, "effect-typing-key-is-not-activation"))
      return false;
    typed.key_is_activation = true;
    if (!Check(ClassifyEffect(typed).effect_class == EffectClass::kConfirm, "effect-activation-key"))
      return false;
    // Role or subrole in a look-alike script cannot be read either.
    EffectFacts role = EffBase();
    role.chain[0].role = "\xD0\xB0xbutton";
    if (!Check(EffTakeover(role), "effect-role-lookalike")) return false;
    role = EffBase();
    role.chain[0].subrole = "\xCE\xBFk";
    if (!Check(EffTakeover(role), "effect-subrole-lookalike")) return false;
  }

  // An executable is refused even when nothing around it could be read, and before the text check.
  {
    EffectFacts facts = EffItem(SurfaceKind::kOrdinary, ActionKind::kClick, "exe");
    facts.chain[0].label = "";
    facts.text_language_supported = false;
    if (!Check(EffIs(ClassifyEffect(facts), DecisionKind::kBlocked, DecisionReason::kExecutionTrigger,
                     EffectClass::kE1ExecutableOpen), "effect-e1-before-text-check")) return false;
  }

  // Invisible and format code points of every kind cannot hide a word.
  {
    const std::string marks[] = {
        "\xE2\x81\xA6", "\xE2\x81\xA9", "\xCD\x8F",         "\xD8\x9C",         "\xE1\x85\x9F",
        "\xE1\x85\xA0", "\xE1\x9E\xB4", "\xE1\xA0\x8B",     "\xE3\x85\xA4",     "\xEF\xBE\xA0",
        "\xF3\xA0\x80\xA0", "\xF0\x9D\x85\xB3", "\xE2\x81\xAF", "\xEF\xB8\x80", "\xF3\xA0\x84\x80"};
    for (const std::string &mark : marks) {
      if (!Check(ClassifyEffect(EffLabel("pa" + mark + "y now", ActionKind::kInvoke)).effect_class ==
                     EffectClass::kConfirm, "effect-ignorable-confirm")) return false;
      if (!Check(ClassifyEffect(EffLabel("card" + mark + " number", ActionKind::kType)).reason ==
                     DecisionReason::kCredential, "effect-ignorable-credential")) return false;
      if (!Check(ClassifyEffect(EffLabel("pass" + mark + "word", ActionKind::kType)).reason ==
                     DecisionReason::kSecure, "effect-ignorable-secure")) return false;
      if (!Check(NormalizeForMatch("a" + mark + "b") == "ab", "effect-ignorable-normalize"))
        return false;
    }
  }

  // Text that carries letters a lexicon cannot read, or is not valid UTF-8, is not classified.
  for (const std::string &label : std::vector<std::string>{
           "K\xC3\xA4ufen", "p\xC9\x91y now", "Security c\xD6\x85" "de", "\xEF\xBD\x90\xEF\xBD\x81\xEF\xBD\x99 now",
           "\xED\x8C\x8C\xEC\x9D\xB4", "pay\xC3", "pay\xC0\xAF now", "\xED\xA0\x80 pay", "pay \xF4\x90\x80\x80"}) {
    if (!Check(EffTakeover(EffLabel(label, ActionKind::kClick), EffAllEnabled()), "effect-unreadable-characters"))
      return false;
    if (!Check(EffTakeover(EffLabel(label, ActionKind::kScroll), EffAllEnabled()),
               "effect-unreadable-characters-scroll")) return false;
  }
  for (const std::string &label : std::vector<std::string>{
           "\xF0\x9F\x9B\x92 Buy", u8"保存"_u8, "Cost: \xC2\xA5" "100", "Next \xE2\x86\x92",
           "\xE2\x80\x9CPay now\xE2\x80\x9D"}) {
    if (!Check(ClassifyEffect(EffLabel(label, ActionKind::kClick)).kind != DecisionKind::kTakeover,
               "effect-readable-symbols")) return false;
  }
  if (!Check(ClassifyEffect(EffLabel("\xF0\x9F\x9B\x92 Buy", ActionKind::kClick)).effect_class ==
                 EffectClass::kConfirm, "effect-emoji-label")) return false;

  // Extensions are read the way the platform reads file names, and an odd one is unknown.
  for (const std::string &extension :
       std::vector<std::string>{"exe ", "exe.", ".exe", " EXE\t", "exe..", ". exe .", "Exe"}) {
    if (!Check(ClassifyEffect(EffItem(SurfaceKind::kOrdinary, ActionKind::kClick, extension),
                              EffAllEnabled()).effect_class == EffectClass::kE1ExecutableOpen,
               "effect-extension-normalized")) return false;
  }
  for (const std::string &extension :
       std::vector<std::string>{"ex e", "exe$", "e\xCC\x81xe", "", "a.b", std::string(40, 'a')}) {
    EffectFacts facts = EffItem(SurfaceKind::kOrdinary, ActionKind::kClick, extension);
    if (!Check(EffTakeover(facts, EffAllEnabled()), "effect-extension-odd-is-unknown")) return false;
    facts.surface = SurfaceKind::kFileBrowser;
    if (!Check(EffTakeover(facts, EffAllEnabled()), "effect-extension-odd-is-unknown-listed"))
      return false;
  }

  // An "open" control on any surface needs the extension of what it opens.
  {
    EffectFacts menu = EffBase();
    menu.action = ActionKind::kClick;
    menu.chain[0] = NodeFacts{"axmenuitem", "", "Open"};
    menu.chain.push_back(NodeFacts{"axmenu", "", ""});
    menu.chain.push_back(NodeFacts{"axwindow", "", "Finder"});
    if (!Check(EffTakeover(menu, EffAllEnabled()), "effect-open-control-unlisted-unknown")) return false;
    menu.extension_known = true;
    menu.extension = "txt";
    if (!Check(ClassifyEffect(menu, EffAllEnabled()).kind == DecisionKind::kOrdinary,
               "effect-open-control-unlisted-known")) return false;
    menu.extension = "exe";
    if (!Check(ClassifyEffect(menu, EffAllEnabled()).effect_class == EffectClass::kE1ExecutableOpen,
               "effect-open-control-unlisted-executable")) return false;
  }

  // A scroll cannot enter a secret: words in the window around it do not stop it. Clicking and
  // typing there still do.
  for (const char *title : {"Change password", "1Password", "Card expiration FAQ", "Account number"}) {
    EffectFacts facts = EffBase();
    facts.chain[0] = NodeFacts{"axscrollarea", "", ""};
    facts.chain.push_back(NodeFacts{"axwindow", "", title});
    facts.action = ActionKind::kScroll;
    if (!Check(ClassifyEffect(facts).kind == DecisionKind::kOrdinary, "effect-scroll-ignores-window-title"))
      return false;
    facts.chain[0].label = "Read more";
    facts.chain[0].role = "axlink";
    for (const ActionKind action : {ActionKind::kClick, ActionKind::kType}) {
      facts.action = action;
      if (!Check(ClassifyEffect(facts).kind == DecisionKind::kBlocked, "effect-click-still-refused-near-secret"))
        return false;
    }
  }
  {
    EffectFacts facts = EffBase();
    facts.action = ActionKind::kScroll;
    facts.chain[0].label = "terminal";
    if (!Check(ClassifyEffect(facts).reason == DecisionReason::kSurface, "effect-scroll-still-refused-on-surface"))
      return false;
  }

  // The exemption for a scroll stops at the window around the scrolled control: the control itself
  // (up to its nearest actionable ancestor) is still checked, since a wheel can change a value.
  for (const std::vector<NodeFacts> &chain : std::vector<std::vector<NodeFacts>>{
           {{"axtextfield", "", "Card expiration month"}, {"axwindow", "", "Pay"}},
           {{"axcombobox", "", "Expiration year"}, {"axwindow", "", "Pay"}},
           {{"axsecuretextfield", "", "Password"}, {"axwindow", "", "Pay"}},
           {{"axgroup", "", ""}, {"axbutton", "", "Account number"}, {"axwindow", "", "Pay"}},
           {{"axtextfield", "", "CVV2"}, {"axwindow", "", "Pay"}}}) {
    for (const SessionMode mode : {SessionMode::kFullAccess, SessionMode::kSupervised}) {
      EffectFacts facts = EffBase();
      facts.chain = chain;
      facts.action = ActionKind::kScroll;
      facts.mode = mode;
      if (!Check(ClassifyEffect(facts).kind == DecisionKind::kBlocked, "effect-scroll-checks-the-control"))
        return false;
    }
  }
  {
    // Above the actionable ancestor the same words are only a window title.
    EffectFacts facts = EffBase();
    facts.chain = {{"axgroup", "", ""},
                   {"axbutton", "", "Read more"},
                   {"axwindow", "", "Card expiration FAQ"}};
    facts.action = ActionKind::kScroll;
    if (!Check(ClassifyEffect(facts).kind == DecisionKind::kOrdinary, "effect-scroll-window-above-the-control"))
      return false;
  }

  // Malformed UTF-8 is unreadable in the raw text too: removing an invisible code point from
  // between broken bytes must not join them into a character that was never there.
  {
    for (const std::string &label : std::vector<std::string>{
             "pa\xE3\xE2\x80\x8B\x81\x82ss", "p\xE0\x81\xA1y now", "p\xE0\x80\xAFy now",
             "pay\xE2\x80\x8B\xC3", "pa\xC3\xE2\x81\xA6\xA9y now"}) {
      if (!Check(EffTakeover(EffLabel(label, ActionKind::kType), EffAllEnabled()), "effect-raw-malformed-utf8"))
        return false;
    }
    EffectFacts role = EffBase();
    role.chain[0].role = "ax\xE3\xE2\x80\x8B\x81\x82";
    if (!Check(EffTakeover(role), "effect-raw-malformed-role")) return false;
    EffectFacts neighbor = EffLabel("input", ActionKind::kType);
    neighbor.origin = OriginState::kOrdinary;
    neighbor.neighbor_labels = {"pa\xE3\xE2\x80\x8B\x81\x82ss"};
    neighbor.neighbor_labels_complete = true;
    if (!Check(EffTakeover(neighbor), "effect-raw-malformed-neighbor")) return false;
    EffectFacts extension = EffItem(SurfaceKind::kOrdinary, ActionKind::kClick, "tx\xC3");
    if (!Check(EffTakeover(extension, EffAllEnabled()), "effect-raw-malformed-extension")) return false;
  }

  // Characters that stand in for Latin letters are unreadable: ordinal indicators, superscripts,
  // micro sign, circled / squared / regional-indicator letters, APL letters, halfwidth Hangul.
  for (const std::string &label : std::vector<std::string>{
           "p\xC2\xAAy now", "P\xC2\xAAssword", "\xC2\xB5 pay now", "pay\xC2\xB2", "pay now\xC2\xB3",
           "\xC2\xB9 pay now", "pay n\xC2\xBA" "w", "\xF0\x9F\x85\xBF\xF0\x9F\x84\xB0ssword",
           "\xF0\x9F\x87\xB5\xF0\x9F\x87\xA6y now", "\xF0\x9F\x85\x9F" "ay now", "p\xE2\x8D\xBAy now",
           "\xE2\x8D\xB6 pay now", "\xEF\xBE\xA1 pay now", "\xEF\xBF\x9C pay now"}) {
    if (!Check(EffTakeover(EffLabel(label, ActionKind::kClick), EffAllEnabled()), "effect-latin-stand-ins"))
      return false;
  }
  // The punctuation, symbols and emoji next to them stay readable.
  for (const std::string &label : std::vector<std::string>{
           "\xC2\xA9 2026", "\xC2\xAB" "pay now\xC2\xBB", "\xC2\xB7 pay now", "\xE2\x86\x90 back",
           "\xE2\x8C\x98" "S", "\xF0\x9F\x8E\x81 gift", "\xEF\xBC\x81 pay now"}) {
    if (!Check(ClassifyEffect(EffLabel(label, ActionKind::kClick)).kind != DecisionKind::kTakeover,
               "effect-readable-neighbours-of-the-stand-ins")) return false;
  }

  // The scope of a scroll reaches an unlabeled control's caption on the groups above it, up to the
  // first labeled node and never the window; text in that scope must be readable too.
  {
    for (const std::vector<NodeFacts> &chain : std::vector<std::vector<NodeFacts>>{
             {{"axcombobox", "", ""}, {"axgroup", "", "Expiration year"}, {"axwindow", "", "Pay"}},
             {{"axtextfield", "", ""}, {"axgroup", "", ""}, {"axgroup", "", "Card number"},
              {"axwindow", "", "Pay"}},
             {{"axsecuretextfield", "", ""}, {"axwindow", "", "Pay"}}}) {
      EffectFacts facts = EffBase();
      facts.chain = chain;
      facts.action = ActionKind::kScroll;
      if (!Check(ClassifyEffect(facts).kind == DecisionKind::kBlocked, "effect-scroll-scope-first-labeled"))
        return false;
    }
    // A labeled window is still outside it, and so is anything beyond the first labeled node.
    EffectFacts window = EffBase();
    window.chain = {{"axscrollarea", "", ""}, {"axwindow", "", "Card expiration FAQ"}};
    window.action = ActionKind::kScroll;
    if (!Check(ClassifyEffect(window).kind == DecisionKind::kOrdinary, "effect-scroll-scope-stops-before-window"))
      return false;
    EffectFacts beyond = EffBase();
    beyond.chain = {{"axscrollarea", "", "Results"}, {"axgroup", "", "Password tips"}, {"axwindow", "", "Help"}};
    beyond.action = ActionKind::kScroll;
    if (!Check(ClassifyEffect(beyond).kind == DecisionKind::kOrdinary, "effect-scroll-scope-stops-at-first-label"))
      return false;
    EffectFacts accented = EffBase();
    accented.chain = {{"axscrollarea", "", ""}, {"axwindow", "", "Caf\xC3\xA9"}};
    accented.action = ActionKind::kScroll;
    if (!Check(ClassifyEffect(accented).kind == DecisionKind::kOrdinary, "effect-scroll-ignores-window-title-text"))
      return false;
    // A look-alike letter in the scrolled control's caption cannot be read.
    for (const std::vector<NodeFacts> &chain : std::vector<std::vector<NodeFacts>>{
             {{"axcombobox", "", "Expir\xC2\xAAtion year"}, {"axwindow", "", "Pay"}},
             {{"axcombobox", "", ""}, {"axgroup", "", "Expir\xC2\xAAtion year"}, {"axwindow", "", "Pay"}},
             {{"axcombobox", "", "Expir\xD0\xB0tion year"}, {"axwindow", "", "Pay"}},
             {{"axcombobox", "", "Expir\xC3"}, {"axwindow", "", "Pay"}},
             {{"axscrollarea", "\xD0\xB0x", ""}, {"axwindow", "", "Pay"}}}) {
      EffectFacts facts = EffBase();
      facts.chain = chain;
      facts.action = ActionKind::kScroll;
      if (!Check(EffTakeover(facts, EffAllEnabled()), "effect-scroll-scope-unreadable")) return false;
    }
    EffectFacts subrole = EffBase();
    subrole.action = ActionKind::kScroll;
    subrole.chain[0].subrole = "ax\xE3\xE2\x80\x8B\x81\x82";
    if (!Check(EffTakeover(subrole), "effect-scroll-scope-malformed-subrole")) return false;
  }

  // Malformed UTF-8 in a subrole is refused like the same in a role.
  {
    EffectFacts subrole = EffBase();
    subrole.chain[0].subrole = "ax\xE3\xE2\x80\x8B\x81\x82";
    if (!Check(EffTakeover(subrole), "effect-raw-malformed-subrole")) return false;
  }

  // Whitespace between the words is one blank: runs, tabs, line breaks and the Unicode spaces.
  for (const std::string &gap : std::vector<std::string>{
           "  ", "\t", "\n", "\r\n", " \t \n ", "\xC2\xA0", "\xE2\x80\x83", "\xE2\x80\xA8",
           "\xE3\x80\x80", "\xE2\x80\xAF", " \xE2\x80\x8B ", "\xC2\x85"}) {
    if (!Check(ClassifyEffect(EffLabel("Place" + gap + "order", ActionKind::kInvoke)).effect_class ==
                   EffectClass::kConfirm,
               "effect-whitespace-confirm")) return false;
    if (!Check(ClassifyEffect(EffLabel("Card" + gap + "number", ActionKind::kType)).kind ==
                   DecisionKind::kBlocked,
               "effect-whitespace-credential")) return false;
    if (!Check(ClassifyEffect(EffLabel("Security" + gap + "code", ActionKind::kType)).kind ==
                   DecisionKind::kBlocked,
               "effect-whitespace-credential-two")) return false;
  }
  // A leading, trailing or only-whitespace label is still the same words, or no words.
  if (!Check(ClassifyEffect(EffLabel("\n Place order \t", ActionKind::kInvoke)).effect_class ==
                 EffectClass::kConfirm,
             "effect-whitespace-edges")) return false;
  if (!Check(ClassifyEffect(EffLabel("pla ce order", ActionKind::kInvoke)).effect_class !=
                 EffectClass::kConfirm,
             "effect-whitespace-does-not-join-words")) return false;

  // A wheel over a text field inside a combobox changes the combobox: the scope reaches it.
  for (const char *role : {"axcombobox", "axpopupbutton", "axincrementor", "axslider", "axspinbutton",
                           "ComboBox", "Spinner", "Slider", "AXStepper"}) {
    EffectFacts facts = EffBase();
    facts.chain = {{"axtextfield", "", "2026"}, {role, "", "Expiration year"}, {"axwindow", "", "Pay"}};
    facts.action = ActionKind::kScroll;
    if (!Check(ClassifyEffect(facts).kind == DecisionKind::kBlocked, "effect-scroll-value-ancestor-in-scope"))
      return false;
    facts.chain = {{"axtextfield", "", "2026"}, {"axgroup", "", ""}, {role, "", "Card number"},
                   {"axwindow", "", "Pay"}};
    if (!Check(ClassifyEffect(facts).kind == DecisionKind::kBlocked, "effect-scroll-value-ancestor-past-group"))
      return false;
    // A value-changing role in the subrole counts too.
    facts.chain = {{"axtextfield", "", "2026"}, {"axgroup", role, "Expiration year"}, {"axwindow", "", "Pay"}};
    if (!Check(ClassifyEffect(facts).kind == DecisionKind::kBlocked, "effect-scroll-value-ancestor-subrole"))
      return false;
  }
  // The window above is still out of scope, even if it is a combobox-like role.
  {
    EffectFacts facts = EffBase();
    facts.chain = {{"axscrollarea", "", "Results"}, {"axwindow", "", "Password"}};
    facts.action = ActionKind::kScroll;
    if (!Check(ClassifyEffect(facts).kind == DecisionKind::kOrdinary, "effect-scroll-value-scope-keeps-window-out"))
      return false;
  }

  // A scroll that can change a value needs a language the lexicon covers; browsing does not.
  {
    EffectFacts value = EffBase();
    value.chain = {{"axtextfield", "", "2026"}, {"axcombobox", "", "Ablaufdatum"}, {"axwindow", "", "Pay"}};
    value.action = ActionKind::kScroll;
    value.text_language_supported = false;
    if (!Check(EffTakeover(value), "effect-scroll-value-unsupported-language")) return false;
    value.text_language_supported = true;
    if (!Check(ClassifyEffect(value).kind != DecisionKind::kTakeover, "effect-scroll-value-supported-language"))
      return false;
    EffectFacts unlabeled = EffBase();
    unlabeled.chain = {{"axcombobox", "", ""}, {"axwindow", "", ""}};
    unlabeled.action = ActionKind::kScroll;
    if (!Check(EffTakeover(unlabeled), "effect-scroll-value-without-label")) return false;
    EffectFacts browse = EffBase();
    browse.chain = {{"axscrollarea", "", "Ergebnisse"}, {"axwindow", "", "Hilfe"}};
    browse.action = ActionKind::kScroll;
    browse.text_language_supported = false;
    if (!Check(ClassifyEffect(browse).kind == DecisionKind::kOrdinary, "effect-scroll-browse-unsupported-language"))
      return false;
    browse.chain = {{"axscrollarea", "", ""}, {"axwindow", "", ""}};
    if (!Check(ClassifyEffect(browse).kind == DecisionKind::kOrdinary, "effect-scroll-browse-no-label"))
      return false;
  }

  // A label of only whitespace is no label: a button, a field, a caption near a field and a
  // value-changing scroll all treat it as empty.
  for (const std::string &blank : std::vector<std::string>{
           " ", " \t\n", "\xC2\xA0", "\xE3\x80\x80", "\xE2\x80\xA8", " \xE2\x80\x8B ", "\xE2\x80\xAF\xC2\x85"}) {
    if (!Check(EffTakeover(EffLabel(blank, ActionKind::kClick)), "effect-blank-button")) return false;
    if (!Check(EffTakeover(EffLabel(blank, ActionKind::kType)), "effect-blank-field")) return false;
    EffectFacts browser = EffLabel("", ActionKind::kType);
    browser.origin = OriginState::kOrdinary;
    browser.neighbor_labels = {blank};
    browser.neighbor_labels_complete = true;
    if (!Check(EffTakeover(browser), "effect-blank-neighbor-caption")) return false;
    browser.neighbor_labels = {blank, "Name"};
    if (!Check(ClassifyEffect(browser).kind != DecisionKind::kTakeover, "effect-blank-neighbor-with-real-caption"))
      return false;
    EffectFacts scroll = EffBase();
    scroll.chain = {{"axcombobox", "", blank}, {"axwindow", "", "Pay"}};
    scroll.action = ActionKind::kScroll;
    if (!Check(EffTakeover(scroll), "effect-blank-value-scroll")) return false;
    scroll.origin = OriginState::kOrdinary;
    scroll.neighbor_labels = {blank};
    scroll.neighbor_labels_complete = true;
    if (!Check(EffTakeover(scroll), "effect-blank-value-scroll-neighbor")) return false;
  }

  // A value-changing scroll in a browser reads the captions near the control, as typing does.
  {
    for (const std::string &caption : std::vector<std::string>{"Card expiration date", "Security code",
                                                               "Password", "\xE3\x82\xAB\xE3\x83\xBC\xE3\x83\x89\xE7\x95\xAA\xE5\x8F\xB7"}) {
      EffectFacts facts = EffBase();
      facts.chain = {{"axcombobox", "", "Year"}, {"axwindow", "", "Checkout"}};
      facts.action = ActionKind::kScroll;
      facts.origin = OriginState::kOrdinary;
      facts.neighbor_labels = {caption};
      facts.neighbor_labels_complete = true;
      if (!Check(ClassifyEffect(facts).kind == DecisionKind::kBlocked, "effect-value-scroll-neighbor-blocks"))
        return false;
      // A neighbouring caption that could not be read completely is a person's decision.
      facts.neighbor_labels = {"Year"};
      facts.neighbor_labels_complete = false;
      if (!Check(EffTakeover(facts), "effect-value-scroll-neighbors-incomplete")) return false;
      facts.neighbor_labels_complete = true;
      if (!Check(ClassifyEffect(facts).kind != DecisionKind::kTakeover, "effect-value-scroll-neighbors-complete"))
        return false;
    }
    EffectFacts unreadable = EffBase();
    unreadable.chain = {{"axcombobox", "", "Year"}, {"axwindow", "", "Checkout"}};
    unreadable.action = ActionKind::kScroll;
    unreadable.origin = OriginState::kOrdinary;
    unreadable.neighbor_labels = {"Expir\xD0\xB0tion date"};
    unreadable.neighbor_labels_complete = true;
    if (!Check(EffTakeover(unreadable), "effect-value-scroll-neighbor-unreadable")) return false;
    // Browsing keeps ignoring what is next to it.
    EffectFacts browse = EffBase();
    browse.chain = {{"axscrollarea", "", "Results"}, {"axwindow", "", "Help"}};
    browse.action = ActionKind::kScroll;
    browse.origin = OriginState::kOrdinary;
    browse.neighbor_labels = {"Card number", "Expir\xD0\xB0tion date"};
    browse.neighbor_labels_complete = false;
    if (!Check(ClassifyEffect(browse).kind == DecisionKind::kOrdinary, "effect-browse-scroll-ignores-neighbors"))
      return false;
  }

  // The bare names of the value-changing roles, in the role and in the subrole, in AX and UIA
  // spelling: each one is value-changing for a wheel, and a scroll over it needs a label.
  for (const char *role : {"AXPicker", "Picker", "picker", "AXDropDown", "Dropdown", "dropdown", "AXListBox",
                           "listbox", "ListBox"}) {
    EffectFacts facts = EffBase();
    facts.chain = {{role, "", "Expiration year"}, {"axwindow", "", "Pay"}};
    facts.action = ActionKind::kScroll;
    if (!Check(ClassifyEffect(facts).kind == DecisionKind::kBlocked, "effect-scroll-bare-picker-role-in-scope"))
      return false;
    facts.chain = {{"axgroup", role, "Expiration year"}, {"axwindow", "", "Pay"}};
    if (!Check(ClassifyEffect(facts).kind == DecisionKind::kBlocked, "effect-scroll-bare-picker-subrole-in-scope"))
      return false;
    facts.chain = {{role, "", ""}, {"axwindow", "", "Pay"}};
    if (!Check(EffTakeover(facts), "effect-scroll-bare-picker-needs-a-label")) return false;
  }

  // A value-changing scroll in a native application (origin not applicable): a caption NEXT to the
  // control is not its label there (only a browser has captions beside a field), so a control with
  // no label of its own is a takeover; in a browser the same caption labels it.
  for (const char *role : {"axcombobox", "axpopupbutton", "axslider", "axdatepicker", "ComboBox"}) {
    EffectFacts native = EffBase();
    native.chain = {{role, "", ""}, {"axwindow", "", "Pay"}};
    native.action = ActionKind::kScroll;
    native.origin = OriginState::kNotApplicable;
    native.neighbor_labels = {"Font size"};
    native.neighbor_labels_complete = true;
    if (!Check(EffTakeover(native), "effect-native-value-scroll-neighbor-only-is-a-takeover")) return false;
    native.chain = {{role, "", "Font size"}, {"axwindow", "", "Pay"}};
    if (!Check(!EffTakeover(native), "effect-native-value-scroll-own-label-is-judged")) return false;
    EffectFacts browser = EffBase();
    browser.chain = {{role, "", ""}, {"axwindow", "", "Pay"}};
    browser.action = ActionKind::kScroll;
    browser.origin = OriginState::kOrdinary;
    browser.neighbor_labels = {"Font size"};
    browser.neighbor_labels_complete = true;
    if (!Check(!EffTakeover(browser), "effect-browser-value-scroll-neighbor-labels-it")) return false;
  }

  // Pickers, drop-downs and list boxes are value-changing too.
  for (const char *role : {"axdatepicker", "AXTimePicker", "ColorPicker", "axdropdown", "DropDown",
                           "axlistbox", "ListBox"}) {
    EffectFacts facts = EffBase();
    facts.chain = {{"axtextfield", "", "2026"}, {role, "", "Expiration year"}, {"axwindow", "", "Pay"}};
    facts.action = ActionKind::kScroll;
    if (!Check(ClassifyEffect(facts).kind == DecisionKind::kBlocked, "effect-scroll-picker-ancestor-in-scope"))
      return false;
    facts.chain = {{"axtextfield", "", ""}, {role, "", ""}, {"axwindow", "", "Pay"}};
    facts.text_language_supported = false;
    if (!Check(EffTakeover(facts), "effect-scroll-picker-needs-readable-language")) return false;
  }

  // Japanese does not put blanks between words: a blank between two Japanese characters goes.
  for (const std::string &label : std::vector<std::string>{
           "\xE3\x82\xAB\xE3\x83\xBC\xE3\x83\x89\xE3\x80\x80\xE7\x95\xAA\xE5\x8F\xB7",
           "\xE3\x82\xAB\xE3\x83\xBC\xE3\x83\x89 \xE7\x95\xAA\xE5\x8F\xB7",
           "\xE3\x82\xAB\xE3\x83\xBC\xE3\x83\x89\n\n\xE7\x95\xAA\xE5\x8F\xB7",
           "\xE3\x82\xAB\xE3\x83\xBC\xE3\x83\x89\xC2\xA0\xE7\x95\xAA\xE5\x8F\xB7",
           "\xE3\x82\xAB\xE3\x83\xBC \xE3\x83\x89\xE7\x95\xAA\xE5\x8F\xB7",
           "\xE6\x9C\x89\xE5\x8A\xB9 \xE6\x9C\x9F\xE9\x99\x90",
           "\xE3\x82\xBB\xE3\x82\xAD\xE3\x83\xA5\xE3\x83\xAA\xE3\x83\x86\xE3\x82\xA3\xE3\x80\x80\xE3\x82\xB3\xE3\x83\xBC\xE3\x83\x89"}) {
    if (!Check(ClassifyEffect(EffLabel(label, ActionKind::kType)).kind == DecisionKind::kBlocked,
               "effect-cjk-whitespace-credential")) return false;
  }
  // The same gap between Latin words stays one blank; a Japanese-Latin gap is not joined.
  if (!Check(NormalizeForMatch("a \xE3\x81\x82 b") == "a \xE3\x81\x82 b", "effect-cjk-whitespace-keeps-latin-gaps"))
    return false;
  if (!Check(NormalizeForMatch("\xE3\x81\x82\xE3\x80\x80\xE3\x81\x84") == "\xE3\x81\x82\xE3\x81\x84",
             "effect-cjk-whitespace-joins-japanese")) return false;
  if (!Check(NormalizeForMatch("  a  b \t") == "a b", "effect-normalize-trims-and-collapses")) return false;

  // In a browser the caption of a value-changing scroll may be only a neighbour; nothing at all is
  // not a label.
  {
    EffectFacts facts = EffBase();
    facts.chain = {{"axcombobox", "", ""}, {"axwindow", "", ""}};
    facts.action = ActionKind::kScroll;
    facts.origin = OriginState::kOrdinary;
    facts.neighbor_labels = {"Sort by"};
    facts.neighbor_labels_complete = true;
    if (!Check(ClassifyEffect(facts).kind == DecisionKind::kOrdinary, "effect-value-scroll-neighbor-is-the-label"))
      return false;
    facts.neighbor_labels.clear();
    if (!Check(EffTakeover(facts), "effect-value-scroll-browser-without-any-label")) return false;
  }

  // Any action inside a value-changing control (a selection, a click, an invoke, a toggle, a key)
  // changes the value, so it reads the captions near it like typing does.
  for (const ActionKind action : {ActionKind::kSelect, ActionKind::kClick, ActionKind::kDoubleClick,
                                  ActionKind::kInvoke, ActionKind::kToggle, ActionKind::kKey}) {
    for (const char *role : {"axcombobox", "ComboBox", "axpopupbutton", "axslider"}) {
      EffectFacts facts = EffBase();
      facts.chain = {{"axlistitem", "", "2026"}, {role, "", "Year"}, {"axwindow", "", "Checkout"}};
      facts.action = action;
      facts.key_is_activation = true;
      facts.origin = OriginState::kOrdinary;
      facts.neighbor_labels = {"Card expiration date"};
      facts.neighbor_labels_complete = true;
      if (!Check(ClassifyEffect(facts).kind == DecisionKind::kBlocked, "effect-value-action-neighbor-blocks"))
        return false;
      facts.neighbor_labels = {"Security code"};
      if (!Check(ClassifyEffect(facts).effect_class == EffectClass::kCredential, "effect-value-action-neighbor-credential"))
        return false;
      facts.neighbor_labels = {"Password"};
      if (!Check(ClassifyEffect(facts).effect_class == EffectClass::kSecure, "effect-value-action-neighbor-secure"))
        return false;
      facts.neighbor_labels = {"Year"};
      facts.neighbor_labels_complete = false;
      if (!Check(EffTakeover(facts), "effect-value-action-neighbors-incomplete")) return false;
      facts.neighbor_labels_complete = true;
      if (!Check(ClassifyEffect(facts).kind == DecisionKind::kOrdinary, "effect-value-action-neighbors-complete"))
        return false;
      facts.neighbor_labels = {"Year", "Expir\xD0\xB0tion"};
      if (!Check(EffTakeover(facts), "effect-value-action-neighbor-unreadable")) return false;
      facts.neighbor_labels = {"Year"};
      facts.text_language_supported = false;
      if (!Check(EffTakeover(facts), "effect-value-action-unsupported-language")) return false;
    }
  }
  // A selection that is not inside a value-changing control only browses.
  {
    EffectFacts facts = EffBase();
    facts.chain = {{"axrow", "", "report.docx"}, {"axwindow", "", "Files"}};
    facts.action = ActionKind::kSelect;
    facts.origin = OriginState::kOrdinary;
    facts.neighbor_labels = {"Card number"};
    facts.neighbor_labels_complete = false;
    if (!Check(ClassifyEffect(facts).kind == DecisionKind::kOrdinary, "effect-plain-select-ignores-neighbors"))
      return false;
  }
  // In a native app (no origin) a neighbouring caption is not the control's label.
  {
    EffectFacts facts = EffBase();
    facts.chain = {{"axcombobox", "", ""}, {"axwindow", "", ""}};
    facts.action = ActionKind::kScroll;
    facts.origin = OriginState::kNotApplicable;
    facts.neighbor_labels = {"Sort by"};
    facts.neighbor_labels_complete = true;
    if (!Check(EffTakeover(facts), "effect-value-scroll-native-neighbor-is-not-a-label")) return false;
  }

  // Invariant sweep: an approval is only ever offered for a complete, non-refused fact set, and
  // always carries a valid native effect; everything else carries none.
  {
    const char *labels[] = {"ok", "pay now", "open", "install", "card number", "terminal",
                            "password", "save", ""};
    const char *extensions[] = {"", "txt", "pdf", "exe", "pkg", "js"};
    for (const char *label : labels)
      for (const SurfaceKind surface :
           {SurfaceKind::kOrdinary, SurfaceKind::kFileBrowser, SurfaceKind::kDownloadPanel,
            SurfaceKind::kShellLike, SurfaceKind::kUnknown})
        for (const ActionKind action :
             {ActionKind::kObserve, ActionKind::kClick, ActionKind::kDoubleClick,
              ActionKind::kInvoke, ActionKind::kType, ActionKind::kKey, ActionKind::kSetText,
              ActionKind::kToggle, ActionKind::kSelect})
          for (const SessionMode mode :
               {SessionMode::kObserveOnly, SessionMode::kSupervised, SessionMode::kFullAccess})
            for (const char *ext : extensions)
              for (const OriginState origin :
                   {OriginState::kNotApplicable, OriginState::kOrdinary, OriginState::kUnknown,
                    OriginState::kSensitive})
                for (int complete = 0; complete < 2; ++complete)
                  for (const bool file_item : {false, true}) {
                    EffectFacts facts = EffLabel(label, action);
                    facts.surface = surface;
                    facts.mode = mode;
                    facts.origin = origin;
                    facts.metadata_complete = complete == 1;
                    facts.target_is_file_item = file_item;
                    facts.extension_known = std::string_view(ext).size() > 0;
                    facts.extension = ext;
                    facts.key_is_activation = action == ActionKind::kKey;
                    const auto decision = ClassifyEffect(facts, EffAllEnabled());
                    const bool approval = decision.kind == DecisionKind::kApproval;
                    const bool valid_effect =
                        decision.approval_effect == NativeApprovalEffect::kDownloadOpen ||
                        decision.approval_effect == NativeApprovalEffect::kFileManagerOpen ||
                        decision.approval_effect == NativeApprovalEffect::kHighImpactConfirmation ||
                        decision.approval_effect == NativeApprovalEffect::kSupervisedAction;
                    if (!Check(approval == valid_effect, "effect-sweep-effect-iff-approval"))
                      return false;
                    if (approval) {
                      if (!Check(complete == 1 && action != ActionKind::kObserve &&
                                     surface != SurfaceKind::kUnknown &&
                                     mode != SessionMode::kObserveOnly &&
                                     (origin == OriginState::kNotApplicable ||
                                      origin == OriginState::kOrdinary) &&
                                     (std::string_view(label).size() > 0 ||
                                      action == ActionKind::kScroll) &&
                                     decision.effect_class != EffectClass::kSecure &&
                                     decision.effect_class != EffectClass::kCredential &&
                                     decision.effect_class != EffectClass::kSurface &&
                                     decision.effect_class != EffectClass::kE1ExecutableOpen &&
                                     decision.effect_class != EffectClass::kE4InstallerLaunch &&
                                     decision.effect_class != EffectClass::kE5ScriptSurface &&
                                     decision.effect_class != EffectClass::kUnclassified,
                                 "effect-sweep-approval-preconditions")) return false;
                    }
                    // Nothing that fails to be complete, or sits on an unknown surface or has no
                    // text, is ever ordinary or an approval (a scroll needs no text).
                    const bool needs_text = action != ActionKind::kScroll;
                    if (action != ActionKind::kObserve &&
                        (complete == 0 || surface == SurfaceKind::kUnknown ||
                         (needs_text && std::string_view(label).empty())) &&
                        !Check(decision.kind != DecisionKind::kOrdinary && !approval,
                               "effect-sweep-incomplete")) return false;
                    if (decision.kind != DecisionKind::kOrdinary &&
                        !Check(decision.classifier_version == kEffectClassifierVersion &&
                                   decision.ruleset_version == kEffectRulesetVersion &&
                                   decision.lexicon_version == kEffectLexiconVersion,
                               "effect-sweep-versions")) return false;
                  }
  }

  // The default rule set enables exactly the two approval kinds the first release trusts.
  {
    const EffectRuleset defaults;
    if (!Check(!defaults.download_open && !defaults.file_manager_open &&
                   defaults.high_impact_confirmation && defaults.supervised_action,
               "effect-default-ruleset")) return false;
  }

  // The tables are versioned data. The pin is also a static_assert in the header (a wrong edit or a
  // wrongly read character set fails every build); this repeats it where the log shows it.
  if (!Check(kEffectTablesDigest == kEffectTablesDigestPinned, "effect-tables-digest")) return false;
  for (const auto &table : kEffectLexiconTables) {
    if (!Check(!table.empty(), "effect-table-nonempty")) return false;
    for (const std::u8string_view term : table) {
      if (!Check(!term.empty() && term.find(u8'\0') == std::u8string_view::npos, "effect-term-shape"))
        return false;
      for (const char8_t character : term)
        if (!Check(!(character >= u8'A' && character <= u8'Z'), "effect-term-lowercase"))
          return false;
    }
  }
  for (const auto &table : kEffectExtensionTables)
    for (const std::string_view extension : table)
      for (const char character : extension)
        if (!Check(!(character >= 'A' && character <= 'Z') && character != '.',
                   "effect-extension-shape")) return false;
  for (const std::string_view installer : kInstallerExtensions) {
    bool inside = false;
    for (const std::string_view executable : kExecutableExtensions)
      inside = inside || executable == installer;
    if (!Check(inside, "effect-installer-extensions-are-executable")) return false;
  }
  std::cout << "Computer Use native effect classifier core: PASS\n";
  return true;
}

// ---- Classifier v2, S4-1b-1: the synchronous interlock evaluation (pure; nothing calls it yet) ----

bool CheckNativeInterlockCapture() {
  using namespace sprint_coder::computer_use;
  const auto terminal = [] {
    ShadowRequestInfo request = ShadowRequest("invoke");
    request.executable_path = "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal";
    return request;
  };
  // A script in a file manager: a row in a list in a window, with a file URL.
  const auto finder_script = [] {
    ShadowAxCapture capture = ShadowBase();
    capture.chain = {ShadowNode("AXRow", "run.sh"), ShadowNode("AXList"), ShadowNode("AXWindow", "Files")};
    capture.url_present = true;
    capture.url = "file:///Users/me/run.sh";
    return capture;
  };
  const auto finder = [] {
    ShadowRequestInfo request = ShadowRequest("invoke");
    request.executable_path = "/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder";
    return request;
  };
  const auto no_verdict = [](const InterlockEvaluation &evaluation, InterlockNoVerdict why,
                             const char *code) {
    return Check(!evaluation.Refuses() && !evaluation.verdict.Refuses() &&
                     evaluation.no_verdict == why && evaluation.verdict.ReasonCode().empty(),
                 code);
  };

  // A complete capture of an ordinary target: asked, and nothing to refuse.
  if (!no_verdict(EvaluateInterlockFromCapture(ShadowBase(), ShadowRequest(), false),
                  InterlockNoVerdict::kNone, "capture-interlock-ordinary-is-no-refusal"))
    return false;
  // A complete capture of a command surface refuses, with the map's own verdict.
  {
    const InterlockEvaluation evaluation =
        EvaluateInterlockFromCapture(ShadowBase(), terminal(), false);
    if (!Check(evaluation.Refuses() && evaluation.no_verdict == InterlockNoVerdict::kNone &&
                   evaluation.verdict.outcome == InterlockOutcome::kBlocked &&
                   evaluation.verdict.reason == InterlockReason::kShellSurface,
               "capture-interlock-shell-surface-refuses"))
      return false;
  }
  // A complete capture of an executable opened from a file manager is an execution trigger (E1).
  {
    const InterlockEvaluation evaluation =
        EvaluateInterlockFromCapture(finder_script(), finder(), false);
    if (!Check(evaluation.Refuses() && evaluation.verdict.outcome == InterlockOutcome::kTakeover &&
                   evaluation.verdict.reason == InterlockReason::kExecutionTrigger &&
                   evaluation.verdict.effect_class == EffectClass::kE1ExecutableOpen,
               "capture-interlock-file-manager-script-is-e1"))
      return false;
  }
  // The result is exactly the map's: for each capture the evaluation equals the map on the same facts.
  for (const auto &entry : std::vector<std::pair<ShadowAxCapture, ShadowRequestInfo>>{
           {ShadowBase(), ShadowRequest()}, {ShadowBase(), terminal()}, {finder_script(), finder()}}) {
    const ShadowFacts built = BuildShadowFacts(entry.first, entry.second);
    const InterlockVerdict direct = InterlockForFacts(built.facts);
    const InterlockEvaluation evaluation = EvaluateInterlockFromCapture(entry.first, entry.second, false);
    if (!Check(evaluation.verdict.outcome == direct.outcome && evaluation.verdict.reason == direct.reason,
               "capture-interlock-equals-the-map"))
      return false;
  }

  // A rule set that trusts the file manager approval: the closed-approval refusal is not said.
  {
    ShadowAxCapture pdf = finder_script();
    pdf.chain[0].title = "report.pdf";
    pdf.url = "file:///Users/me/report.pdf";
    const InterlockEvaluation closed = EvaluateInterlockFromCapture(pdf, finder(), false);
    if (!Check(closed.Refuses() && closed.verdict.reason == InterlockReason::kApprovalClosed,
               "capture-interlock-default-ruleset-approval-closed"))
      return false;
    EffectRuleset trusting;
    trusting.file_manager_open = true;
    if (!no_verdict(EvaluateInterlockFromCapture(pdf, finder(), false, trusting),
                    InterlockNoVerdict::kNone, "capture-interlock-trusting-ruleset-is-no-refusal"))
      return false;
  }

  // Canceled: no verdict, even where the facts would refuse.
  if (!no_verdict(EvaluateInterlockFromCapture(ShadowBase(), terminal(), true),
                  InterlockNoVerdict::kCanceled, "capture-interlock-canceled-is-no-verdict"))
    return false;
  if (!no_verdict(EvaluateInterlockFromCapture(finder_script(), finder(), true),
                  InterlockNoVerdict::kCanceled, "capture-interlock-canceled-trigger-is-no-verdict"))
    return false;
  // Canceled wins over a spent budget.
  {
    ShadowAxCapture capture = ShadowBase();
    capture.budget_exhausted = true;
    if (!no_verdict(EvaluateInterlockFromCapture(capture, terminal(), true),
                    InterlockNoVerdict::kCanceled, "capture-interlock-canceled-before-budget"))
      return false;
  }
  // Budget spent: no verdict, even where the facts read so far would refuse.
  {
    ShadowAxCapture capture = ShadowBase();
    capture.budget_exhausted = true;
    if (!no_verdict(EvaluateInterlockFromCapture(capture, terminal(), false),
                    InterlockNoVerdict::kBudget, "capture-interlock-budget-is-no-verdict"))
      return false;
    ShadowAxCapture script = finder_script();
    script.budget_exhausted = true;
    if (!no_verdict(EvaluateInterlockFromCapture(script, finder(), false),
                    InterlockNoVerdict::kBudget, "capture-interlock-budget-trigger-is-no-verdict"))
      return false;
  }
  // The real budget: 640 calls, the deadline and a cancellation end in no verdict through the same
  // gate the platform readers use.
  {
    ShadowGate gate(0);
    std::uint32_t admitted = 0;
    while (gate.Step(1, true)) ++admitted;
    ShadowAxCapture capture = finder_script();
    capture.budget_exhausted = gate.BudgetExhausted();
    if (!Check(admitted == kShadowMaxAxCalls && gate.BudgetExhausted(), "capture-interlock-gate-spends-640") ||
        !no_verdict(EvaluateInterlockFromCapture(capture, finder(), gate.Canceled()),
                    InterlockNoVerdict::kBudget, "capture-interlock-gate-budget-is-no-verdict"))
      return false;
    ShadowGate late(0);
    const bool admitted_late = late.Step(kShadowDeadlineNs + 1, true);
    capture.budget_exhausted = late.BudgetExhausted();
    if (!Check(!admitted_late && late.BudgetExhausted(), "capture-interlock-gate-deadline") ||
        !no_verdict(EvaluateInterlockFromCapture(capture, finder(), late.Canceled()),
                    InterlockNoVerdict::kBudget, "capture-interlock-gate-deadline-is-no-verdict"))
      return false;
    ShadowGate canceled(0);
    const bool admitted_canceled = canceled.Step(1, false);
    if (!Check(!admitted_canceled && canceled.Canceled(), "capture-interlock-gate-cancel") ||
        !no_verdict(EvaluateInterlockFromCapture(finder_script(), finder(), canceled.Canceled()),
                    InterlockNoVerdict::kCanceled, "capture-interlock-gate-cancel-is-no-verdict"))
      return false;
  }

  // Incomplete facts never map to a refusal: each gap, with a request that would refuse if complete.
  {
    ShadowAxCapture cut = ShadowBase();
    cut.chain_reached_root = false;
    if (!no_verdict(EvaluateInterlockFromCapture(cut, terminal(), false),
                    InterlockNoVerdict::kIncomplete, "capture-interlock-cut-chain-is-no-verdict"))
      return false;
    ShadowAxCapture failed = ShadowBase();
    failed.read_failed = true;
    if (!no_verdict(EvaluateInterlockFromCapture(failed, terminal(), false),
                    InterlockNoVerdict::kIncomplete, "capture-interlock-read-failure-is-no-verdict"))
      return false;
    ShadowAxCapture missing = ShadowBase();
    missing.target_found = false;
    if (!no_verdict(EvaluateInterlockFromCapture(missing, terminal(), false),
                    InterlockNoVerdict::kIncomplete, "capture-interlock-missing-target-is-no-verdict"))
      return false;
    ShadowAxCapture oversize = ShadowBase();
    oversize.chain[0].oversize = true;
    if (!no_verdict(EvaluateInterlockFromCapture(oversize, terminal(), false),
                    InterlockNoVerdict::kIncomplete, "capture-interlock-oversize-is-no-verdict"))
      return false;
    ShadowAxCapture node_failed = finder_script();
    node_failed.chain[1].read_failed = true;
    if (!no_verdict(EvaluateInterlockFromCapture(node_failed, finder(), false),
                    InterlockNoVerdict::kIncomplete, "capture-interlock-node-read-failure-is-no-verdict"))
      return false;
    const ShadowAxCapture empty;
    if (!no_verdict(EvaluateInterlockFromCapture(empty, terminal(), false),
                    InterlockNoVerdict::kIncomplete, "capture-interlock-empty-capture-is-no-verdict"))
      return false;
    ShadowRequestInfo unsupported = terminal();
    unsupported.kind = "observe";
    if (!no_verdict(EvaluateInterlockFromCapture(ShadowBase(), unsupported, false),
                    InterlockNoVerdict::kIncomplete, "capture-interlock-unsupported-kind-is-no-verdict"))
      return false;
  }

  std::cout << "Computer Use native interlock capture: PASS\n";
  return true;
}

// ---- Classifier v2, S5-c-1: the Windows synchronous interlock evaluation (nothing calls it yet) ---

bool CheckWindowsInterlockCapture() {
  using namespace sprint_coder::computer_use;
  const auto no_verdict = [](const InterlockEvaluation &evaluation, InterlockNoVerdict why,
                             const char *code) {
    return Check(!evaluation.Refuses() && !evaluation.verdict.Refuses() &&
                     evaluation.no_verdict == why && evaluation.verdict.ReasonCode().empty(),
                 code);
  };
  const auto evaluate = [](FakeUia &source, std::string_view kind, std::string_view target_id = "",
                           const EffectRuleset &ruleset = EffectRuleset{}, bool click_opens = false) {
    ShadowRequestInfo request = UiaRequest(kind);
    request.click_opens = click_opens;
    return EvaluateWindowsInterlockOnSource(source, kind, target_id, request, ruleset);
  };

  // An ordinary window: asked, and nothing to refuse.
  {
    FakeForm form;
    if (!no_verdict(evaluate(form.source, "invoke", "name"), InterlockNoVerdict::kNone,
                    "winlane-ordinary-is-no-refusal")) return false;
  }
  // A console window is a command surface: blocked, the map's own verdict.
  for (const auto &entry : std::vector<std::pair<const char *, const char *>>{
           {"ConsoleWindowClass", "C:\\Windows\\System32\\conhost.exe"},
           {"CASCADIA_HOSTING_WINDOW_CLASS", "C:\\x\\WindowsTerminal.exe"}}) {
    FakeForm form;
    form.Node(form.window).class_name = entry.first;
    form.source.process_path = entry.second;
    const InterlockEvaluation evaluation = evaluate(form.source, "type");
    if (!Check(evaluation.Refuses() && evaluation.no_verdict == InterlockNoVerdict::kNone &&
                   evaluation.verdict.outcome == InterlockOutcome::kBlocked &&
                   evaluation.verdict.reason == InterlockReason::kShellSurface,
               "winlane-console-window-is-blocked")) return false;
  }
  // An executable opened from a file manager is an execution trigger (E1): takeover.
  {
    FakeExplorer script("run.bat");
    script.GiveRealPath("C:\\Users\\me\\run.bat");
    const InterlockEvaluation evaluation = evaluate(script.form.source, "invoke", "run.bat");
    if (!Check(evaluation.Refuses() && evaluation.verdict.outcome == InterlockOutcome::kTakeover &&
                   evaluation.verdict.reason == InterlockReason::kExecutionTrigger,
               "winlane-file-manager-script-is-a-takeover")) return false;
  }
  // The result is the map's: the evaluation equals the map on the facts of the same capture.
  {
    FakeExplorer script("run.bat");
    script.GiveRealPath("C:\\Users\\me\\run.bat");
    WindowsShadowReader reader(script.form.source);
    const ShadowUiaCapture capture = reader.Capture("invoke", "run.bat");
    const ShadowFacts built = BuildWindowsShadowFacts(capture, UiaRequest("invoke"));
    const InterlockVerdict direct = InterlockForFacts(built.facts);
    FakeExplorer again("run.bat");
    again.GiveRealPath("C:\\Users\\me\\run.bat");
    const InterlockEvaluation evaluation = evaluate(again.form.source, "invoke", "run.bat");
    if (!Check(evaluation.verdict.outcome == direct.outcome && evaluation.verdict.reason == direct.reason,
               "winlane-equals-the-map")) return false;
  }
  // A rule set other than the default is honored: opening a file from a file manager is refused
  // while the approval is closed, and is no refusal once the rule set trusts it.
  {
    FakeExplorer closed("invoice.pdf");
    closed.GiveRealPath("C:\\Users\\me\\invoice.pdf");
    const InterlockEvaluation refused = evaluate(closed.form.source, "invoke", "invoice.pdf");
    if (!Check(refused.Refuses() && refused.verdict.reason == InterlockReason::kApprovalClosed,
               "winlane-default-ruleset-approval-closed")) return false;
    FakeExplorer trusted("invoice.pdf");
    trusted.GiveRealPath("C:\\Users\\me\\invoice.pdf");
    EffectRuleset ruleset;
    ruleset.file_manager_open = true;
    if (!no_verdict(evaluate(trusted.form.source, "invoke", "invoice.pdf", ruleset), InterlockNoVerdict::kNone,
                    "winlane-trusting-ruleset-is-no-refusal")) return false;
  }
  // The real path of a file item could not be read (lookup abandoned or refused, shell slot busy):
  // only a display name is known, the extension is unknown, and that is NO VERDICT. It must not look
  // like "nothing to refuse" (which would drop the E1 / E4 and the closed-approval refusals).
  {
    FakeExplorer abandoned_script("run.bat");
    if (!no_verdict(evaluate(abandoned_script.form.source, "click"), InterlockNoVerdict::kIncomplete,
                    "winlane-unread-path-script-is-no-verdict")) return false;
    FakeExplorer abandoned_pdf("invoice.pdf");
    if (!no_verdict(evaluate(abandoned_pdf.form.source, "click"), InterlockNoVerdict::kIncomplete,
                    "winlane-unread-path-document-is-no-verdict")) return false;
    FakeExplorer refused_lookup("run.bat");
    refused_lookup.GiveRealPath("C:\\Users\\me\\run.bat");
    refused_lookup.form.Node(refused_lookup.item).item_result = ShadowReadResult::kFailed;
    if (!no_verdict(evaluate(refused_lookup.form.source, "click"), InterlockNoVerdict::kIncomplete,
                    "winlane-failed-lookup-is-no-verdict")) return false;
    // With the real path the same item is refused as the map says.
    FakeExplorer known_script("run.bat");
    known_script.GiveRealPath("C:\\Users\\me\\run.bat");
    if (!Check(evaluate(known_script.form.source, "invoke", "run.bat").Refuses(), "winlane-known-path-script-refuses"))
      return false;
  }
  // Canceled and out of budget together: canceled wins, as on macOS.
  {
    ShadowUiaCapture capture = UiaBase();
    capture.budget_exhausted = true;
    capture.window_class = "ConsoleWindowClass";
    capture.process_path = "C:\\Windows\\System32\\conhost.exe";
    if (!no_verdict(EvaluateWindowsInterlockFromCapture(capture, UiaRequest("type"), true),
                    InterlockNoVerdict::kCanceled, "winlane-canceled-before-budget")) return false;
    if (!no_verdict(EvaluateWindowsInterlockFromCapture(capture, UiaRequest("type"), false),
                    InterlockNoVerdict::kBudget, "winlane-budget-without-cancel")) return false;
  }
  // Canceled while the capture ran: no verdict, even where the facts would refuse.
  {
    FakeForm form;
    form.Node(form.window).class_name = "ConsoleWindowClass";
    form.source.process_path = "C:\\Windows\\System32\\conhost.exe";
    form.source.cancel_after = 3;
    if (!no_verdict(evaluate(form.source, "type"), InterlockNoVerdict::kCanceled,
                    "winlane-canceled-is-no-verdict")) return false;
  }
  // Out of time: no verdict. Every call takes 20 ms, so the 150 ms deadline passes mid-capture.
  {
    FakeForm form;
    form.Node(form.window).class_name = "ConsoleWindowClass";
    form.source.process_path = "C:\\Windows\\System32\\conhost.exe";
    form.source.step_ns = 20'000'000;
    if (!no_verdict(evaluate(form.source, "type"), InterlockNoVerdict::kBudget,
                    "winlane-deadline-is-no-verdict")) return false;
  }
  // The deadline passes inside the LAST call (a slow shell lookup): Finish makes it a budget answer.
  {
    FakeExplorer script("run.bat");
    script.GiveRealPath("C:\\Users\\me\\run.bat");
    script.form.source.item_delay_ns = kShadowDeadlineNs + 1;
    if (!no_verdict(evaluate(script.form.source, "click"), InterlockNoVerdict::kBudget,
                    "winlane-late-shell-lookup-is-no-verdict")) return false;
  }
  // The call budget: a search through more nodes than 640 calls can read never refuses.
  {
    FakeForm form;
    for (int index = 0; index < 700; ++index) form.source.Add(form.pane, "Text", "x");
    const InterlockEvaluation evaluation = evaluate(form.source, "invoke", "no-such-id");
    if (!Check(!evaluation.Refuses(), "winlane-many-nodes-never-refuses")) return false;
  }
  // Incomplete facts never map to a refusal.
  {
    FakeForm lost;
    lost.Node(lost.window).class_name = "ConsoleWindowClass";
    lost.source.process_path = "C:\\Windows\\System32\\conhost.exe";
    lost.source.root_result = ShadowReadResult::kFailed;
    if (!no_verdict(evaluate(lost.source, "invoke", "name"), InterlockNoVerdict::kIncomplete,
                    "winlane-no-window-is-no-verdict")) return false;
    FakeForm cut;
    cut.Node(cut.window).class_name = "ConsoleWindowClass";
    cut.source.process_path = "C:\\Windows\\System32\\conhost.exe";
    cut.Node(cut.pane).parent_result = ShadowReadResult::kFailed;
    if (!no_verdict(evaluate(cut.source, "type"), InterlockNoVerdict::kIncomplete,
                    "winlane-cut-chain-is-no-verdict")) return false;
    FakeForm none;
    none.Node(none.window).class_name = "ConsoleWindowClass";
    none.source.process_path = "C:\\Windows\\System32\\conhost.exe";
    none.source.focused = -1;
    if (!no_verdict(evaluate(none.source, "type"), InterlockNoVerdict::kIncomplete,
                    "winlane-no-target-is-no-verdict")) return false;
    FakeForm unknown;
    if (!no_verdict(evaluate(unknown.source, "observe"), InterlockNoVerdict::kIncomplete,
                    "winlane-unknown-kind-is-no-verdict")) return false;
  }

  std::cout << "Computer Use native Windows interlock capture: PASS\n";
  return true;
}

// ---- Classifier v2, C4-2c-1: the split high-impact vocabulary and the approved-effect judgement ----
// The v1 vocabulary as it was before the split, frozen here byte for byte (the lists, and the two
// matching rules). The table in computer_use_native_approved_risk.h must say exactly the same when
// no effect was approved; it is the golden for "v1 route behaves as before".

namespace frozen_v1 {

const std::vector<std::string> kSubstring = {
    "payment", "checkout", "purchase", "billing", "credit card", "card number", "wire transfer",
    "contract", "agreement", "sign agreement", "installer", "install application",
    "administrator", "admin privileges", "sudo", "root access", "security settings",
    "privacy settings", "firewall", "accessibility permission", "screen recording permission",
    u8"決済"_u8, u8"支払い"_u8, u8"支払う"_u8, u8"購入"_u8, u8"注文を確定"_u8, u8"注文する"_u8, u8"請求"_u8, u8"送金"_u8, u8"契約"_u8, u8"署名"_u8,
    u8"インストール"_u8, u8"管理者"_u8, u8"セキュリティ"_u8, u8"プライバシー"_u8, u8"ファイアウォール"_u8};
const std::vector<std::string> kBoundedPay = {
    "pay", "pay now", "place order", "submit order", "complete order", "buy now",
    "pagar", "comprar", "acheter", "bestellen", "bezahlen", "pagare",
    "acquistare", "betalen", "kopen"};
const std::vector<std::string> kBoundedSurface = {
    "integrated terminal", "terminal", "terminal.app", "console", "shell",
    "powershell", "powershell.exe", "command prompt", "cmd.exe", "run script",
    "shell script", "script console"};
const std::vector<std::string> kSubstringSurfaceJa = {
    u8"ターミナル"_u8, u8"コンソール"_u8, u8"シェル"_u8, u8"コマンドプロンプト"_u8, u8"スクリプトを実行"_u8};

bool IsContinuation(unsigned char character) {
  return (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9');
}

bool ContainsBounded(std::string_view haystack, std::string_view needle) {
  for (std::size_t position = haystack.find(needle); position != std::string_view::npos;
       position = haystack.find(needle, position + 1)) {
    const bool before = position == 0 || !IsContinuation(static_cast<unsigned char>(haystack[position - 1]));
    const std::size_t end = position + needle.size();
    const bool after = end == haystack.size() || !IsContinuation(static_cast<unsigned char>(haystack[end]));
    if (before && after) return true;
  }
  return false;
}

bool ContainsAny(std::string_view haystack, const std::vector<std::string> &needles) {
  for (const auto needle : needles)
    if (haystack.find(needle) != std::string_view::npos) return true;
  return false;
}

bool ContainsAnyBounded(std::string_view haystack, const std::vector<std::string> &needles) {
  for (const auto needle : needles)
    if (ContainsBounded(haystack, needle)) return true;
  return false;
}

bool HighImpact(std::string_view text) {
  return ContainsAny(text, kSubstring) || ContainsAnyBounded(text, kBoundedPay) ||
         ContainsAnyBounded(text, kBoundedSurface) || ContainsAny(text, kSubstringSurfaceJa);
}

} // namespace frozen_v1

bool CheckNativeApprovedRisk() {
  using namespace sprint_coder::computer_use;

  // The words. Four groups, each compared whole (==) with the ADR's classification table; a word that
  // moves from one group to another, is added or is dropped fails here. The union of the groups is
  // the frozen v1 vocabulary, and nothing is on two sides.
  {
    using high_impact_terms::Bytes;
    const auto to_set = [](const auto &first, const auto &second) {
      std::set<std::string> out;
      for (const auto term : first) out.insert(std::string(Bytes(term)));
      for (const auto term : second) out.insert(std::string(Bytes(term)));
      return out;
    };
    const std::array<std::u8string_view, 0> none{};
    const std::set<std::string> confirmation_substring =
        to_set(high_impact_terms::kConfirmationSubstring, high_impact_terms::kConfirmationSubstringJa);
    const std::set<std::string> confirmation_bounded = to_set(high_impact_terms::kConfirmationBounded, none);
    const std::set<std::string> ambiguous = to_set(high_impact_terms::kOtherSubstring, high_impact_terms::kOtherSubstringJa);
    const std::set<std::string> surface_substring = to_set(high_impact_terms::kOtherSurfaceJa, none);
    const std::set<std::string> surface_bounded = to_set(high_impact_terms::kOtherBounded, none);
    const std::set<std::string> expected_confirmation_substring = {
        "payment", "checkout", "purchase", "billing", "credit card", "card number", "wire transfer",
        "contract", "agreement", "sign agreement", u8"決済"_u8, u8"支払い"_u8, u8"支払う"_u8, u8"購入"_u8,
        u8"注文を確定"_u8, u8"注文する"_u8, u8"請求"_u8, u8"送金"_u8, u8"契約"_u8, u8"署名"_u8};
    const std::set<std::string> expected_confirmation_bounded = {
        "pay", "pay now", "place order", "submit order", "complete order", "buy now", "pagar", "comprar",
        "acheter", "bestellen", "bezahlen", "pagare", "acquistare", "betalen", "kopen"};
    const std::set<std::string> expected_ambiguous = {
        "installer", "install application", "administrator", "admin privileges", "sudo", "root access",
        "security settings", "privacy settings", "firewall", "accessibility permission",
        "screen recording permission", u8"インストール"_u8, u8"管理者"_u8, u8"セキュリティ"_u8,
        u8"プライバシー"_u8, u8"ファイアウォール"_u8};
    const std::set<std::string> expected_surface_substring = {
        u8"ターミナル"_u8, u8"コンソール"_u8, u8"シェル"_u8, u8"コマンドプロンプト"_u8, u8"スクリプトを実行"_u8};
    const std::set<std::string> expected_surface_bounded = {
        "integrated terminal", "terminal", "terminal.app", "console", "shell", "powershell", "powershell.exe",
        "command prompt", "cmd.exe", "run script", "shell script", "script console"};
    if (!Check(confirmation_substring == expected_confirmation_substring, "approved-risk-confirmation-substring-set")) return false;
    if (!Check(confirmation_bounded == expected_confirmation_bounded, "approved-risk-confirmation-bounded-set")) return false;
    if (!Check(ambiguous == expected_ambiguous, "approved-risk-ambiguous-set")) return false;
    if (!Check(surface_substring == expected_surface_substring, "approved-risk-surface-substring-set")) return false;
    if (!Check(surface_bounded == expected_surface_bounded, "approved-risk-surface-bounded-set")) return false;
    // No empty word (it would match everything) and no duplicate inside an array.
    for (const auto *group : {&confirmation_substring, &confirmation_bounded, &ambiguous, &surface_substring,
                              &surface_bounded})
      if (!Check(group->find("") == group->end(), "approved-risk-no-empty-word")) return false;
    if (!Check(high_impact_terms::kConfirmationSubstring.size() + high_impact_terms::kConfirmationSubstringJa.size() ==
                       confirmation_substring.size() &&
                   high_impact_terms::kConfirmationBounded.size() == confirmation_bounded.size() &&
                   high_impact_terms::kOtherSubstring.size() + high_impact_terms::kOtherSubstringJa.size() ==
                       ambiguous.size() &&
                   high_impact_terms::kOtherSurfaceJa.size() == surface_substring.size() &&
                   high_impact_terms::kOtherBounded.size() == surface_bounded.size(),
               "approved-risk-no-duplicate-word")) return false;
    // The union of the groups is the frozen v1 vocabulary, and no word is on two sides.
    std::set<std::string> union_substring = confirmation_substring;
    union_substring.insert(ambiguous.begin(), ambiguous.end());
    union_substring.insert(surface_substring.begin(), surface_substring.end());
    std::set<std::string> union_bounded = confirmation_bounded;
    union_bounded.insert(surface_bounded.begin(), surface_bounded.end());
    std::set<std::string> old_substring;
    std::set<std::string> old_bounded;
    for (const auto &term : frozen_v1::kSubstring) old_substring.insert(term);
    for (const auto &term : frozen_v1::kSubstringSurfaceJa) old_substring.insert(term);
    for (const auto &term : frozen_v1::kBoundedPay) old_bounded.insert(term);
    for (const auto &term : frozen_v1::kBoundedSurface) old_bounded.insert(term);
    if (!Check(union_substring == old_substring && union_bounded == old_bounded,
               "approved-risk-union-is-the-v1-vocabulary")) return false;
    if (!Check(union_substring.size() == confirmation_substring.size() + ambiguous.size() + surface_substring.size() &&
                   union_bounded.size() == confirmation_bounded.size() + surface_bounded.size(),
               "approved-risk-no-word-on-both-sides")) return false;
  }

  // The text judgement equals the frozen v1 one on a corpus: every word alone and with every kind of
  // neighbour (the bounded rule), every pair of words, and ordinary text.
  {
    std::vector<std::string> words;
    for (const auto *list : {&frozen_v1::kSubstring, &frozen_v1::kBoundedPay, &frozen_v1::kBoundedSurface,
                             &frozen_v1::kSubstringSurfaceJa})
      for (const auto term : *list) words.emplace_back(term);
    for (const std::string &plain : std::vector<std::string>{"save", "open", "ok", "name", "play", "payload", "repay", "paying", "shells",
                              "consoles", "x", "", " ", "axbutton\nsave", "pay2", "2pay", "pay-now", "_pay_",
                              "terminalx", "xterminal", "console1", u8"契約書"_u8, u8"お支払い方法"_u8, u8"ご購入ありがとう"_u8})
      words.emplace_back(plain);
    std::vector<std::string> corpus;
    for (const std::string &word : words) {
      corpus.push_back(word);
      corpus.push_back("x" + word);
      corpus.push_back(word + "x");
      corpus.push_back("1" + word);
      corpus.push_back(word + "1");
      corpus.push_back(" " + word + " ");
      corpus.push_back("axbutton\n" + word + "\nsave");
      corpus.push_back("-" + word + "-");
      corpus.push_back("_" + word + "_");
    }
    for (std::size_t a = 0; a < words.size(); a += 3)
      for (std::size_t b = 0; b < words.size(); b += 5) corpus.push_back(words[a] + "\n" + words[b]);
    for (const std::string &text : corpus) {
      const HighImpactTextBits bits = ClassifyHighImpactText(text);
      if (!Check((bits.confirmation || bits.other) == frozen_v1::HighImpact(text),
                 "approved-risk-text-equals-frozen-v1")) {
        std::cerr << "text: " << text << '\n';
        return false;
      }
    }
    // Both sides can be present, and each side is found alone.
    if (!Check(ClassifyHighImpactText("pay now").confirmation && !ClassifyHighImpactText("pay now").other,
               "approved-risk-confirmation-alone")) return false;
    if (!Check(ClassifyHighImpactText("integrated terminal").other && !ClassifyHighImpactText("integrated terminal").confirmation,
               "approved-risk-surface-alone")) return false;
    if (!Check(ClassifyHighImpactText("pay now terminal").confirmation && ClassifyHighImpactText("pay now terminal").other,
               "approved-risk-both-sides")) return false;
  }

  // The judgement over every combination of bits and every effect. With no effect, or any effect but
  // the confirmation, it is exactly ClassifyNativePreflightFacts of the v1 bits (the golden). With
  // the approved confirmation it differs in one case only: high impact by confirmation words alone.
  {
    const NativeApprovalEffect effects[] = {
        NativeApprovalEffect::kInvalid, NativeApprovalEffect::kDownloadOpen,
        NativeApprovalEffect::kFileManagerOpen, NativeApprovalEffect::kHighImpactConfirmation,
        NativeApprovalEffect::kSupervisedAction};
    int relaxed_cases = 0;
    for (unsigned mask = 0; mask < 32; ++mask) {
      NativeRiskBits bits;
      bits.classified = (mask & 1u) != 0;
      bits.secure = (mask & 2u) != 0;
      bits.high_impact = (mask & 4u) != 0;
      bits.confirmation = (mask & 8u) != 0;
      bits.other = (mask & 16u) != 0;
      const NativePreflightDecision v1 =
          ClassifyNativePreflightFacts({true, bits.classified, bits.secure, bits.high_impact});
      for (const NativeApprovalEffect effect : effects) {
        const NativePreflightDecision got = ClassifyNativeRisk(bits, effect);
        const bool relaxes = effect == NativeApprovalEffect::kHighImpactConfirmation && bits.high_impact &&
                             bits.confirmation && !bits.other;
        if (!relaxes) {
          if (!Check(got.kind == v1.kind && got.reason == v1.reason &&
                         got.classifier_version == v1.classifier_version,
                     "approved-risk-equals-v1-unless-relaxed")) return false;
        } else {
          const NativePreflightDecision expected =
              ClassifyNativePreflightFacts({true, bits.classified, bits.secure, false});
          if (!Check(got.kind == expected.kind && got.reason == expected.reason, "approved-risk-relaxed-case"))
            return false;
          ++relaxed_cases;
          // Secure and unclassified are never relaxed.
          if (bits.secure && bits.classified && !Check(got.kind == NativePreflightKind::kBlocked, "approved-risk-secure-never-relaxed"))
            return false;
          if (!bits.classified && !Check(got.reason == NativePreflightReason::kUnclassified,
                                         "approved-risk-unclassified-never-relaxed")) return false;
        }
        // The default argument is the v1 judgement.
        if (effect == NativeApprovalEffect::kInvalid) {
          const NativePreflightDecision by_default = ClassifyNativeRisk(bits);
          if (!Check(by_default.kind == got.kind && by_default.reason == got.reason, "approved-risk-default-is-no-effect"))
            return false;
        }
        // Only an ordinary result allows a dispatch, as before.
        if (!Check(NativePreflightAllowsDispatch(got) == (got.kind == NativePreflightKind::kOrdinary &&
                                                          got.reason == NativePreflightReason::kNone),
                   "approved-risk-allows-only-ordinary")) return false;
      }
    }
    // The cases that relax: high impact by confirmation words alone (4 = classified x secure; of those
    // only a classified, non-secure target ends up ordinary).
    if (!Check(relaxed_cases == 4, "approved-risk-only-confirmation-words-alone-relax")) return false;
    // A concrete one: "Pay now" relaxes; "Pay now" inside a terminal does not; a secure one does not.
    const auto from_text = [](std::string_view text, bool secure) {
      const HighImpactTextBits text_bits = ClassifyHighImpactText(text);
      NativeRiskBits bits;
      bits.classified = true;
      bits.secure = secure;
      bits.high_impact = text_bits.confirmation || text_bits.other;
      bits.confirmation = text_bits.confirmation;
      bits.other = text_bits.other;
      return bits;
    };
    const NativeApprovalEffect confirm = NativeApprovalEffect::kHighImpactConfirmation;
    if (!Check(NativePreflightAllowsDispatch(ClassifyNativeRisk(from_text("pay now", false), confirm)) &&
                   !NativePreflightAllowsDispatch(ClassifyNativeRisk(from_text("pay now", false))) &&
                   !NativePreflightAllowsDispatch(ClassifyNativeRisk(from_text("pay now\nintegrated terminal", false), confirm)) &&
                   !NativePreflightAllowsDispatch(ClassifyNativeRisk(from_text("pay now\nsecuretextfield", true), confirm)) &&
                   !NativePreflightAllowsDispatch(ClassifyNativeRisk(from_text("install application", false), confirm)) &&
                   !NativePreflightAllowsDispatch(ClassifyNativeRisk(from_text("pay now", false), NativeApprovalEffect::kSupervisedAction)),
               "approved-risk-concrete-cases")) return false;
  }

  std::cout << "Computer Use native approved risk: PASS\n";
  return true;
}

// ---- Classifier v2, C4-2c-1: the approval offer (receipt model, binding, remaining time) ----------

bool CheckNativeApprovalOffer() {
  using namespace sprint_coder::computer_use;

  // The decision words.
  if (!Check(NativePreflightDecisionName(NativePreflightKind::kOrdinary) == "ordinary" &&
                 NativePreflightDecisionName(NativePreflightKind::kSingleUseApproval) == "single_use_approval" &&
                 NativePreflightDecisionName(NativePreflightKind::kBlocked) == "blocked" &&
                 NativePreflightDecisionName(NativePreflightKind::kTakeover) == "takeover",
             "offer-decision-names")) return false;
  if (!Check(kNativePreflightClassifierVersion == 1 && kNativePreflightReceiptVersion == 2 &&
                 kNativeApprovalOfferClassifierVersion == 2 && kNativeApprovalOfferMaxMs == 60'000u,
             "offer-constants")) return false;

  // The key sets: v1 is the original ten; v2 adds one; an offer adds three more. All distinct.
  {
    const std::set<std::string_view> v1(kNativePreflightReceiptKeysV1.begin(), kNativePreflightReceiptKeysV1.end());
    const std::set<std::string_view> v2(kNativePreflightReceiptKeysV2.begin(), kNativePreflightReceiptKeysV2.end());
    const std::set<std::string_view> offer(kNativeApprovalOfferReceiptKeys.begin(), kNativeApprovalOfferReceiptKeys.end());
    if (!Check(v1.size() == 10 && v2.size() == 11 && offer.size() == 14, "offer-key-sets-have-no-duplicates"))
      return false;
    std::set<std::string_view> v2_expected = v1;
    v2_expected.insert("receiptVersion");
    std::set<std::string_view> offer_expected = v2;
    for (const char *key : {"approvalGeneration", "remainingMs", "effect"}) offer_expected.insert(key);
    if (!Check(v2 == v2_expected && offer == offer_expected, "offer-key-sets-are-nested")) return false;
  }

  // The effect words are the four Main spells, and an invalid effect has none.
  if (!Check(NativeApprovalEffectName(NativeApprovalEffect::kDownloadOpen) == "download_open" &&
                 NativeApprovalEffectName(NativeApprovalEffect::kFileManagerOpen) == "file_manager_open" &&
                 NativeApprovalEffectName(NativeApprovalEffect::kHighImpactConfirmation) == "high_impact_confirmation" &&
                 NativeApprovalEffectName(NativeApprovalEffect::kSupervisedAction) == "supervised_action" &&
                 NativeApprovalEffectName(NativeApprovalEffect::kInvalid).empty(),
             "offer-effect-names")) return false;

  // The remaining time: rounded up, never zero while live, capped, zero once expired.
  if (!Check(NativeApprovalRemainingMs(0, 1) == 1 && NativeApprovalRemainingMs(0, 999'999) == 1 &&
                 NativeApprovalRemainingMs(0, 1'000'000) == 1 && NativeApprovalRemainingMs(0, 1'000'001) == 2 &&
                 NativeApprovalRemainingMs(100, 100) == 0 && NativeApprovalRemainingMs(101, 100) == 0 &&
                 NativeApprovalRemainingMs(0, kNativeApprovalWaitMaxNs) == 60'000u &&
                 NativeApprovalRemainingMs(0, kNativeApprovalWaitMaxNs + 5'000'000'000ULL) == 60'000u &&
                 NativeApprovalRemainingMs(1'000, kNativeApprovalWaitMaxNs + 1'000) == 60'000u,
             "offer-remaining-ms")) return false;

  // A closed offer.
  {
    NativeApprovalOffer offer{7, 30'000, NativeApprovalEffect::kHighImpactConfirmation};
    if (!Check(NativeApprovalOfferIsClosed(offer), "offer-closed")) return false;
    NativeApprovalOffer bad = offer;
    bad.approval_generation = 0;
    if (!Check(!NativeApprovalOfferIsClosed(bad), "offer-generation-zero")) return false;
    bad = offer;
    bad.remaining_ms = 0;
    if (!Check(!NativeApprovalOfferIsClosed(bad), "offer-remaining-zero")) return false;
    bad.remaining_ms = 60'001;
    if (!Check(!NativeApprovalOfferIsClosed(bad), "offer-remaining-too-long")) return false;
    bad = offer;
    bad.effect = NativeApprovalEffect::kInvalid;
    if (!Check(!NativeApprovalOfferIsClosed(bad), "offer-effect-invalid")) return false;
    bad.remaining_ms = 60'000;
    bad.effect = NativeApprovalEffect::kSupervisedAction;
    if (!Check(NativeApprovalOfferIsClosed(bad), "offer-remaining-at-bound")) return false;
  }

  // The binding from a measurement: Offer -> Approve -> ConsumeApproved, through the real flow, with
  // the measurement the core makes of a purchase button.
  {
    const ShadowAxCapture capture = MeasureCapture();
    const NativeApprovalMeasurement measured = MeasureApproval(MeasureInput(capture));
    if (!Check(measured.eligible && measured.effect == NativeApprovalEffect::kHighImpactConfirmation,
               "offer-fixture-is-a-confirmation")) return false;
    NativeApprovalOfferContext context;
    context.session_id = "session";
    context.task_id = "task";
    context.turn_id = "turn";
    context.approval_request_id = "original-request";
    context.action_digest = std::string(64, 'a');
    context.payload_digest = std::string(64, 'b');
    context.cancel_epoch = 3;
    context.approval_generation = 7;
    context.observation_revision = 10;
    context.ticket_generation = 12;
    NativeApprovalIntentBinding binding;
    if (!Check(BuildApprovalIntentBinding(measured, context, &binding), "offer-binding-built")) return false;
    if (!Check(binding.authority_digest == measured.authority_digest && binding.effect == measured.effect &&
                   binding.classifier_version == measured.classifier_version &&
                   binding.ruleset_version == measured.ruleset_version &&
                   binding.lexicon_version == measured.lexicon_version && IsValidNativeApprovalIntent(binding) &&
                   NativeApprovalIntentBindingsEqual(binding, MeasureIntent(measured)),
               "offer-binding-fields")) return false;
    // The binding is refused for anything that is not an eligible approval, or not valid as a whole.
    NativeApprovalIntentBinding untouched;
    NativeApprovalMeasurement not_eligible = measured;
    not_eligible.eligible = false;
    NativeApprovalMeasurement taken_over = measured;
    taken_over.takeover = true;
    NativeApprovalMeasurement no_effect = measured;
    no_effect.effect = NativeApprovalEffect::kInvalid;
    NativeApprovalMeasurement old_version = measured;
    old_version.classifier_version = 1;
    NativeApprovalMeasurement no_digest = measured;
    no_digest.authority_digest.clear();
    for (const NativeApprovalMeasurement *refused :
         {&not_eligible, &taken_over, &no_effect, &old_version, &no_digest})
      if (!Check(!BuildApprovalIntentBinding(*refused, context, &untouched) && untouched.session_id.empty(),
                 "offer-binding-refused")) return false;
    if (!Check(!BuildApprovalIntentBinding(measured, context, nullptr), "offer-binding-needs-an-output")) return false;
    for (int field = 0; field < 7; ++field) {
      NativeApprovalOfferContext broken = context;
      switch (field) {
      case 0: broken.session_id.clear(); break;
      case 1: broken.approval_request_id.clear(); break;
      case 2: broken.action_digest = "short"; break;
      case 3: broken.payload_digest.clear(); break;
      case 4: broken.approval_generation = 0; break;
      case 5: broken.observation_revision = 0; break;
      default: broken.ticket_generation = 0; break;
      }
      if (!Check(!BuildApprovalIntentBinding(measured, broken, &untouched), "offer-binding-invalid-context")) return false;
    }

    // The flow: the offer holds the binding; the approval re-measures and exchanges it; the
    // execution consumes once. The same fresh measurement serves both (nothing changed).
    NativeApprovalFlow flow;
    const std::string intent_token(64, 'e');
    const std::string execution_token(64, 'f');
    if (!Check(flow.Offer(intent_token, binding, 100, kNativeApprovalWaitMaxNs) && flow.pending() &&
                   flow.approval_generation() == 7,
               "offer-flow-offer")) return false;
    NativeApprovalFacts facts = FlowFacts();
    const NativeApprovalMeasurement fresh = MeasureApproval(MeasureInput(capture));
    if (!Check(flow.Approve(facts, fresh, execution_token, 120).ok && flow.ready(), "offer-flow-approve"))
      return false;
    if (!Check(flow.ConsumeApproved(facts, fresh, 130).ok && !flow.occupied(), "offer-flow-consume")) return false;
    // A different page or window is another authority: the exchange fails and burns the offer.
    NativeApprovalFlow other;
    if (!Check(other.Offer(intent_token, binding, 100, kNativeApprovalWaitMaxNs), "offer-flow-offer-2")) return false;
    ApprovalMeasurementInput changed = MeasureInput(capture);
    changed.identity.x += 1;
    const NativeApprovalMeasurement moved = MeasureApproval(changed);
    if (!Check(moved.eligible && !other.Approve(facts, moved, execution_token, 120).ok && !other.occupied(),
               "offer-flow-moved-window-burns")) return false;
    // The remaining time of that offer, as the receipt would carry it.
    if (!Check(NativeApprovalRemainingMs(100, 100 + kNativeApprovalWaitMaxNs) == 60'000u &&
                   NativeApprovalRemainingMs(100 + kNativeApprovalWaitMaxNs - 1, 100 + kNativeApprovalWaitMaxNs) == 1u,
               "offer-flow-remaining")) return false;
  }

  std::cout << "Computer Use native approval offer: PASS\n";
  return true;
}

// ---- Classifier v2, C4-2c-2: what a route v2 preflight does with the v1 answer (portable part) -----

bool CheckNativePreflightV2() {
  using namespace sprint_coder::computer_use;

  // The approval generation: counted from 1, never past the largest safe integer, never wrapping.
  {
    std::uint64_t next = 99;
    if (!Check(NextNativeApprovalGeneration(0, &next) && next == 1, "v2-generation-first")) return false;
    if (!Check(NextNativeApprovalGeneration(41, &next) && next == 42, "v2-generation-next")) return false;
    if (!Check(NextNativeApprovalGeneration(kNativeApprovalGenerationMax - 1, &next) &&
                   next == kNativeApprovalGenerationMax && next == 9'007'199'254'740'991ULL,
               "v2-generation-last-safe-integer")) return false;
    next = 5;
    if (!Check(!NextNativeApprovalGeneration(kNativeApprovalGenerationMax, &next) && next == 5 &&
                   !NextNativeApprovalGeneration(std::numeric_limits<std::uint64_t>::max(), &next) && next == 5 &&
                   !NextNativeApprovalGeneration(1, nullptr),
               "v2-generation-exhausted")) return false;
    NativeApprovalOffer offer{kNativeApprovalGenerationMax, 1, NativeApprovalEffect::kSupervisedAction};
    if (!Check(NativeApprovalOfferIsClosed(offer), "v2-offer-at-the-largest-generation")) return false;
    offer.approval_generation = kNativeApprovalGenerationMax + 1;
    if (!Check(!NativeApprovalOfferIsClosed(offer), "v2-offer-past-the-largest-generation")) return false;
  }

  // The decision, over every combination of what v1 said and read, and of the measurement.
  int offers = 0;
  int takeovers = 0;
  for (unsigned mask = 0; mask < 256; ++mask) {
    V1PreflightFacts facts;
    facts.ordinary = (mask & 1u) != 0;
    facts.high_impact_takeover = (mask & 2u) != 0;
    facts.risk_recorded = (mask & 4u) != 0;
    facts.classified = (mask & 8u) != 0;
    facts.secure = (mask & 16u) != 0;
    facts.high_impact = (mask & 32u) != 0;
    facts.confirmation = (mask & 64u) != 0;
    facts.other = (mask & 128u) != 0;
    // v1 cannot have been both ordinary and a pause; the table must still not offer anything for it.
    const bool consistent = !(facts.ordinary && facts.high_impact_takeover);
    const bool only_confirmation = facts.high_impact_takeover && facts.risk_recorded && facts.classified &&
                                   !facts.secure && facts.high_impact && facts.confirmation && !facts.other;
    if (!Check(V1StoppedOnlyByConfirmation(facts) == only_confirmation, "v2-stopped-only-by-confirmation"))
      return false;
    if (!Check(PreflightMayBeMeasured(facts) == (facts.ordinary || only_confirmation), "v2-may-be-measured"))
      return false;
    for (unsigned flags = 0; flags < 16; ++flags) {
      NativeApprovalMeasurement measured;
      measured.eligible = (flags & 1u) != 0;
      measured.takeover = (flags & 2u) != 0;
      const NativeApprovalEffect effects[] = {
          NativeApprovalEffect::kHighImpactConfirmation, NativeApprovalEffect::kSupervisedAction,
          NativeApprovalEffect::kFileManagerOpen, NativeApprovalEffect::kDownloadOpen};
      measured.effect = effects[flags >> 2];
      const PreflightV2Action action = DecidePreflightV2(facts, measured);
      PreflightV2Action expected = PreflightV2Action::kKeepV1;
      if (facts.ordinary || only_confirmation) {
        if (measured.takeover)
          expected = facts.ordinary ? PreflightV2Action::kTakeover : PreflightV2Action::kKeepV1;
        else if (measured.eligible)
          // Over a v1 pause for confirmation words only a confirmation is offered: the dispatch
          // lets nothing else through, so any other approval would be spent for nothing.
          expected = (facts.ordinary || measured.effect == NativeApprovalEffect::kHighImpactConfirmation)
                         ? PreflightV2Action::kOffer
                         : PreflightV2Action::kKeepV1;
      }
      if (!Check(action == expected, "v2-decision-table")) return false;
      if (consistent && action == PreflightV2Action::kOffer) ++offers;
      if (consistent && action == PreflightV2Action::kTakeover) ++takeovers;
      // v2 never loosens a refusal: a secure, unclassified, command-surface or other pause is kept.
      if (facts.secure || !facts.classified || facts.other || !facts.risk_recorded) {
        if (!facts.ordinary && !Check(action == PreflightV2Action::kKeepV1, "v2-never-loosens-a-refusal"))
          return false;
      }
      // A denial, a block and a replay (none of ordinary, nor the confirmation pause) are never measured.
      if (!facts.ordinary && !facts.high_impact_takeover &&
          !Check(action == PreflightV2Action::kKeepV1, "v2-keeps-every-other-v1-answer")) return false;
    }
  }
  // Offers come from an ordinary control (any risk bits) and from the confirmation pause only.
  if (!Check(offers > 0 && takeovers > 0, "v2-table-is-not-empty")) return false;

  std::cout << "Computer Use native preflight v2 step: PASS\n";
  return true;
}

// ---- #500 S5-c-2 PR-2: the click rule (one click on a passive item of a file manager selects it) ---

bool CheckClickRule() {
  using namespace sprint_coder::computer_use;
  using sprint_coder::computer_use::effect_detail::ItemInSpan;
  using sprint_coder::computer_use::effect_detail::MayOpen;
  const auto refusal = [](const InterlockEvaluation &evaluation) {
    return evaluation.Refuses() ? evaluation.verdict.ReasonCode() : std::string();
  };
  const auto explorer = [&](const char *name, const char *path, std::string_view kind,
                            const char *key = "", bool click_opens = false) {
    FakeExplorer item(name);
    item.GiveRealPath(path);
    item.form.source.focused = item.item;
    ShadowRequestInfo request = UiaRequest(kind);
    request.key = key;
    request.click_opens = click_opens;
    request.click_tracked = true;
    return EvaluateWindowsInterlockOnSource(item.form.source, kind, kind == "invoke" ? name : "", request,
                                            EffectRuleset{});
  };

  // Windows file manager: a passive ListItem named like a script.
  if (!Check(refusal(explorer("run.bat", "C:\\Users\\me\\run.bat", "click")).empty(),
             "click-rule-script-item-one-click-is-no-refusal")) return false;
  {
    const auto invoked = explorer("run.bat", "C:\\Users\\me\\run.bat", "invoke");
    if (!Check(invoked.Refuses() && invoked.verdict.outcome == InterlockOutcome::kTakeover &&
                   invoked.verdict.reason == InterlockReason::kExecutionTrigger,
               "click-rule-script-item-invoke-is-a-takeover")) return false;
    const auto entered = explorer("run.bat", "C:\\Users\\me\\run.bat", "key", "Enter");
    if (!Check(entered.Refuses() && entered.verdict.reason == InterlockReason::kExecutionTrigger,
               "click-rule-script-item-enter-is-a-takeover")) return false;
    const auto doubled = explorer("run.bat", "C:\\Users\\me\\run.bat", "click", "", true);
    if (!Check(doubled.Refuses() && doubled.verdict.outcome == InterlockOutcome::kTakeover &&
                   doubled.verdict.reason == InterlockReason::kExecutionTrigger,
               "click-rule-script-item-double-click-is-a-takeover")) return false;
  }
  // A document: one click selects; an invoke is the closed approval; a click that opens is too.
  if (!Check(refusal(explorer("invoice.pdf", "C:\\Users\\me\\invoice.pdf", "click")).empty(),
             "click-rule-document-one-click-is-no-refusal")) return false;
  {
    const auto invoked = explorer("invoice.pdf", "C:\\Users\\me\\invoice.pdf", "invoke");
    if (!Check(invoked.Refuses() && invoked.verdict.outcome == InterlockOutcome::kBlocked &&
                   invoked.verdict.reason == InterlockReason::kApprovalClosed,
               "click-rule-document-invoke-is-approval-closed")) return false;
    const auto opened = explorer("invoice.pdf", "C:\\Users\\me\\invoice.pdf", "click", "", true);
    if (!Check(opened.Refuses() && opened.verdict.reason == InterlockReason::kApprovalClosed,
               "click-rule-document-click-that-opens-is-approval-closed")) return false;
    // The flag belongs to a click: it changes nothing for another kind.
    const auto scrolled = explorer("invoice.pdf", "C:\\Users\\me\\invoice.pdf", "scroll", "", true);
    if (!Check(refusal(scrolled).empty(), "click-rule-flag-does-not-touch-a-scroll")) return false;
  }
  // A click on a cell of the details view lands on an Edit of class UIProperty under the ListItem: the
  // row is what is clicked, so one click selects it (no verdict at all), a click that opens does not.
  {
    const auto in_cell = [&](const char *name, const char *path, bool click_opens, const char *cell_class) {
      FakeExplorer item(name);
      item.GiveRealPath(path);
      item.form.source.point = item.form.source.Add(item.item, "Edit", "Date modified", cell_class);
      ShadowRequestInfo request = UiaRequest("click");
      request.click_opens = click_opens;
      request.click_tracked = true;
      return EvaluateWindowsInterlockOnSource(item.form.source, "click", "", request, EffectRuleset{});
    };
    const auto one = in_cell("run.bat", "C:\\Users\\me\\run.bat", false, "UIProperty");
    if (!Check(!one.Refuses() && one.no_verdict == InterlockNoVerdict::kNone,
               "click-rule-cell-one-click-is-no-verdict")) return false;
    const auto doubled = in_cell("run.bat", "C:\\Users\\me\\run.bat", true, "UIProperty");
    if (!Check(doubled.Refuses() && doubled.verdict.outcome == InterlockOutcome::kTakeover &&
                   doubled.verdict.reason == InterlockReason::kExecutionTrigger,
               "click-rule-cell-click-that-opens-is-a-takeover")) return false;
    // The cell can also be a Text of class UIProperty (a column that shows plain text).
    EffectFacts text_cell = EffBase();
    text_cell.surface = SurfaceKind::kFileBrowser;
    text_cell.action = ActionKind::kClick;
    text_cell.target_is_file_item = true;
    text_cell.click_tracked = true;
    text_cell.extension_known = true;
    text_cell.extension = "bat";
    text_cell.chain = {{"text", "UIProperty", "Size"}, {"listitem", "", "run.bat"}, {"list", "", "Items"},
                       {"window", "", "Docs"}};
    if (!Check(ItemInSpan(text_cell) && !MayOpen(text_cell) && !InterlockForFacts(text_cell).Refuses(),
               "click-rule-text-cell-one-click-is-no-refusal")) return false;
    {
      FakeExplorer item("run.bat");
      item.GiveRealPath("C:\\Users\\me\\run.bat");
      item.form.source.point = item.form.source.Add(item.item, "Text", "Size", "UIProperty");
      ShadowRequestInfo text_request = UiaRequest("click");
      text_request.click_tracked = true;
      const auto one_text = EvaluateWindowsInterlockOnSource(item.form.source, "click", "", text_request,
                                                             EffectRuleset{});
      if (!Check(!one_text.Refuses() && one_text.no_verdict == InterlockNoVerdict::kNone,
                 "click-rule-text-cell-through-the-reader-is-no-verdict")) return false;
    }
    // Only the exact shape: the same Edit with another class (a rename box is "Edit") still counts.
    const auto rename = in_cell("run.bat", "C:\\Users\\me\\run.bat", false, "Edit");
    if (!Check(rename.Refuses(), "click-rule-edit-of-another-class-still-counts")) return false;
    // The facts: the cell is passive only with the ListItem right above it and a file manager around.
    const std::vector<NodeFacts> cell = {{"edit", "UIProperty", "Date modified"},
                                         {"listitem", "", "run.bat"}, {"list", "", "Items"},
                                         {"window", "", "Docs"}};
    EffectFacts cell_facts = EffBase();
    cell_facts.surface = SurfaceKind::kFileBrowser;
    cell_facts.action = ActionKind::kClick;
    cell_facts.target_is_file_item = true;
    cell_facts.click_tracked = true;
    cell_facts.extension_known = true;
    cell_facts.extension = "bat";
    cell_facts.chain = cell;
    if (!Check(ItemInSpan(cell_facts) && !MayOpen(cell_facts), "click-rule-cell-is-a-passive-item")) return false;
    std::vector<NodeFacts> bare = cell;
    bare[0].subrole = "";
    cell_facts.chain = bare;
    if (!Check(!ItemInSpan(cell_facts) && MayOpen(cell_facts), "click-rule-edit-without-the-class-counts")) return false;
    bare = cell;
    bare.erase(bare.begin() + 1);
    cell_facts.chain = bare;
    if (!Check(!ItemInSpan(cell_facts), "click-rule-cell-without-a-listitem-above-counts")) return false;
    bare = cell;
    bare[1].role = "group";
    cell_facts.chain = bare;
    if (!Check(!ItemInSpan(cell_facts), "click-rule-cell-under-a-group-counts")) return false;
    // The cell shape is for the target node only: an Edit higher up the chain is not it.
    cell_facts.chain = {{"listitem", "", "run.bat"}, cell[0], cell[1], cell[2]};
    if (!Check(!ItemInSpan(cell_facts), "click-rule-the-cell-exception-is-for-the-target-only")) return false;
  }
  // click_opens makes the facts carry a double click, and only for a click.
  {
    ShadowRequestInfo request = UiaRequest("click");
    request.click_opens = true;
    if (!Check(BuildWindowsShadowFacts(UiaBase(), request).facts.action == ActionKind::kDoubleClick,
               "click-rule-flag-makes-a-double-click")) return false;
    request.click_opens = false;
    if (!Check(BuildWindowsShadowFacts(UiaBase(), request).facts.action == ActionKind::kClick,
               "click-rule-no-flag-stays-a-click")) return false;
    ShadowRequestInfo other = UiaRequest("invoke");
    other.click_opens = true;
    if (!Check(BuildWindowsShadowFacts(UiaBase(), other).facts.action == ActionKind::kInvoke,
               "click-rule-flag-leaves-an-invoke")) return false;
  }

  // The rule on facts: file manager vs download list vs a control vs an unlisted role.
  const auto facts_for = [](SurfaceKind surface, ActionKind action,
                            std::vector<NodeFacts> chain, const char *extension, bool file_item) {
    EffectFacts facts = EffBase();
    facts.surface = surface;
    facts.action = action;
    facts.target_is_file_item = file_item;
    facts.click_tracked = true;
    facts.extension_known = true;
    facts.extension = extension;
    facts.chain = std::move(chain);
    return facts;
  };
  const std::vector<NodeFacts> row = {{"listitem", "", "run.bat"}, {"list", "", "Items"}, {"window", "", "Docs"}};
  // A Button "Open" in a file manager: still the closed approval (E3).
  {
    const EffectFacts button = facts_for(SurfaceKind::kFileBrowser, ActionKind::kClick,
                                         {{"button", "", "Open"}, {"window", "", "Docs"}}, "txt", false);
    const InterlockVerdict verdict = InterlockForFacts(button);
    if (!Check(MayOpen(button) && verdict.Refuses() && verdict.reason == InterlockReason::kApprovalClosed &&
                   verdict.effect_class == EffectClass::kE3FileManagerOpen,
               "click-rule-open-button-in-a-file-manager-is-still-e3")) return false;
  }
  // A download list's item: one click still opens in some browsers; still E2.
  {
    const EffectFacts item = facts_for(SurfaceKind::kDownloadPanel, ActionKind::kClick, row, "pdf", true);
    const InterlockVerdict verdict = InterlockForFacts(item);
    if (!Check(MayOpen(item) && verdict.Refuses() && verdict.reason == InterlockReason::kApprovalClosed &&
                   verdict.effect_class == EffectClass::kE2DownloadOpen,
               "click-rule-download-item-click-is-still-e2")) return false;
  }
  // A role nobody listed (Custom) in a file manager counts as opening: fail closed.
  {
    const EffectFacts custom = facts_for(
        SurfaceKind::kFileBrowser, ActionKind::kClick,
        {{"custom", "", "run.bat"}, {"list", "", "Items"}, {"window", "", "Docs"}}, "bat", true);
    const InterlockVerdict verdict = InterlockForFacts(custom);
    if (!Check(MayOpen(custom) && !ItemInSpan(custom) && verdict.Refuses() &&
                   verdict.outcome == InterlockOutcome::kTakeover,
               "click-rule-custom-role-click-counts-as-opening")) return false;
  }
  // Tracked does not make everything passive: a Group, the List itself and a Custom stay controls.
  {
    for (const std::vector<NodeFacts> &chain : {
             std::vector<NodeFacts>{{"group", "", "run.bat"}, {"list", "", "Items"}, {"window", "", "Docs"}},
             std::vector<NodeFacts>{{"list", "", "Items"}, {"window", "", "Docs"}},
             std::vector<NodeFacts>{{"pane", "", "Docs"}, {"window", "", "Docs"}},
             std::vector<NodeFacts>{{"custom", "", "run.bat"}, {"list", "", "Items"}, {"window", "", "Docs"}}}) {
      const EffectFacts container = facts_for(SurfaceKind::kFileBrowser, ActionKind::kClick, chain, "bat", true);
      if (!Check(container.click_tracked && !ItemInSpan(container) && MayOpen(container),
                 "click-rule-tracked-click-on-a-container-or-control-counts")) return false;
    }
  }
  // An arrow key (or Tab, Escape) is not an opening; Enter is.
  {
    EffectFacts arrow = facts_for(SurfaceKind::kFileBrowser, ActionKind::kKey, row, "bat", true);
    arrow.key_is_activation = false;
    if (!Check(!MayOpen(arrow) && !InterlockForFacts(arrow).Refuses(), "click-rule-arrow-key-is-not-opening"))
      return false;
    arrow.key_is_activation = true;
    if (!Check(MayOpen(arrow) && InterlockForFacts(arrow).Refuses(), "click-rule-enter-key-is-opening"))
      return false;
    EffectFacts down = facts_for(SurfaceKind::kDownloadPanel, ActionKind::kKey, row, "pdf", true);
    down.key_is_activation = false;
    if (!Check(!MayOpen(down), "click-rule-arrow-key-in-a-download-list-is-not-opening")) return false;
  }
  // Finder: an AXRow under an AXOutline, one click: nothing to refuse; the same row double clicked is.
  {
    const std::vector<NodeFacts> finder = {{"axrow", "", "run.command"}, {"axoutline", "", "Files"},
                                           {"axwindow", "", "Documents"}};
    EffectFacts click = facts_for(SurfaceKind::kFileBrowser, ActionKind::kClick, finder, "command", true);
    if (!Check(!MayOpen(click) && !InterlockForFacts(click).Refuses(), "click-rule-finder-row-one-click-is-no-refusal"))
      return false;
    click.action = ActionKind::kDoubleClick;
    if (!Check(MayOpen(click) && InterlockForFacts(click).Refuses(), "click-rule-finder-row-double-click-refuses"))
      return false;
  }
  // An AXButton that carries a file (AXURL): a button, decided by its role, still opens.
  {
    const EffectFacts button = facts_for(
        SurfaceKind::kFileBrowser, ActionKind::kClick,
        {{"axbutton", "", "run.command"}, {"axwindow", "", "Documents"}}, "command", true);
    if (!Check(MayOpen(button) && InterlockForFacts(button).Refuses(), "click-rule-button-with-a-url-click-is-opening"))
      return false;
  }
  // The same click on any other surface is unchanged: it still counts.
  {
    const EffectFacts app = facts_for(SurfaceKind::kOrdinary, ActionKind::kClick, row, "bat", true);
    if (!Check(MayOpen(app), "click-rule-click-outside-a-file-manager-still-counts")) return false;
  }

  // A host that does not follow clicks (macOS: no record of the previous click; or a click with no
  // point) leaves click_tracked false: every click may open, a passive item's too (fail closed).
  {
    const std::vector<NodeFacts> finder = {{"axrow", "", "run.command"}, {"axoutline", "", "Files"},
                                           {"axwindow", "", "Documents"}};
    EffectFacts untracked = facts_for(SurfaceKind::kFileBrowser, ActionKind::kClick, finder, "command", true);
    untracked.click_tracked = false;
    const InterlockVerdict verdict = InterlockForFacts(untracked);
    if (!Check(MayOpen(untracked) && verdict.Refuses() && verdict.outcome == InterlockOutcome::kTakeover,
               "click-rule-untracked-finder-row-click-counts")) return false;
    untracked.click_tracked = true;
    if (!Check(!MayOpen(untracked) && !InterlockForFacts(untracked).Refuses(),
               "click-rule-tracked-finder-row-click-is-no-refusal")) return false;
    // The request flag reaches the facts for a click only, and a plain request is untracked.
    ShadowRequestInfo request = UiaRequest("click");
    if (!Check(!BuildWindowsShadowFacts(UiaBase(), request).facts.click_tracked, "click-rule-request-is-untracked-by-default"))
      return false;
    request.click_tracked = true;
    if (!Check(BuildWindowsShadowFacts(UiaBase(), request).facts.click_tracked, "click-rule-request-tracked-reaches-the-facts"))
      return false;
    // Tracked and opening (a pair with an input within the double-click time, or a file manager that
    // opens on one click): the facts carry a double click and the click is still tracked.
    request.click_opens = true;
    const ShadowFacts paired = BuildWindowsShadowFacts(UiaBase(), request);
    if (!Check(paired.facts.action == ActionKind::kDoubleClick && paired.facts.click_tracked,
               "click-rule-tracked-and-opening-is-a-double-click-in-the-facts")) return false;
    ShadowRequestInfo other = UiaRequest("invoke");
    other.click_tracked = true;
    if (!Check(!BuildWindowsShadowFacts(UiaBase(), other).facts.click_tracked, "click-rule-tracked-is-for-a-click-only"))
      return false;
    // Through the reader: an untracked click on a script item is a takeover.
    FakeExplorer item("run.bat");
    item.GiveRealPath("C:\\Users\\me\\run.bat");
    item.form.source.focused = item.item;
    const auto evaluated = EvaluateWindowsInterlockOnSource(item.form.source, "click", "", UiaRequest("click"), EffectRuleset{});
    if (!Check(evaluated.Refuses() && evaluated.verdict.outcome == InterlockOutcome::kTakeover,
               "click-rule-untracked-click-through-the-reader-is-a-takeover")) return false;
  }
  // Keys that open: an ALLOW LIST of keys that cannot, everything else counts (fail closed).
  {
    for (const char *key : {"Enter", "enter", "Return", "Shift+Enter", "Ctrl+Enter", "ctrl+Enter", "Alt+Enter",
                            "cmd+o", "Cmd+O", "Command+Down", "cmd+ArrowDown", "Control+O", "Option+Down",
                            "Meta+O", "Super+E", "Win+E", "Windows+E", "ctrl+shift+n", "Alt+F4",
                            // Other spellings of Enter, and blanks and case around the parts.
                            "KP_Enter", "kp-enter", "NumpadEnter", "Numpad Enter", "KeypadEnter", "\n", "\r", "\r\n",
                            " Enter ", "Shift + Enter", "CMD + o", "Ctrl +  Enter",
                            // A chord with a command modifier counts whatever its key (intended: fail closed).
                            "Cmd+C", "Ctrl+A", "Ctrl+Z", "Alt+Tab",
                            // An empty key, an empty part inside a chord, and the text backslash-n count.
                            "", "ctrl++", "Ctrl+", "a+", "+a", "\\n", "\\r", "\\r\\n",
                            // Names nobody listed open too: F keys and unknown names, also ones that merely
                            // contain a modifier's name (they are unknown names, not modifiers).
                            "F1", "F12", "Insert", "Enterprise", "Entr", "altgr", "metadata", "controller",
                            "commander", "optional", "winner", "superb", "Shift+altgr", "ctrlx", "xcmd",
                            "Unidentified", "MediaPlayPause", "ArrowDownX", "Shift+F2",
                            // Space presses the focused button or link; a character is a menu access key.
                            "Space", " ", "a", "A", "z", "7", "-", "_", "+", "/", ".", "o", "O", "\u3042", "\u00e9",
                            "Shift+a", "Shift+Space", "Shift+o", "Shift+Shift+a"})
      if (!Check(ShadowKeyOpens(key), (std::string("key-opens-") + key).c_str())) return false;
    // Only Shift, spelled exactly, may stand before a quiet key.
    if (!Check(ShadowKeyOpens("shiftx+a"), "key-opens-a-prefix-that-merely-starts-with-shift")) return false;
    if (!Check(!ShadowKeyOpens("Shift+Shift+Tab"), "key-does-not-open-shift-shift-tab")) return false;
    for (const char *key : {"ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Down", "Up", "Left", "Right",
                            "KP_Down", "kp_up", "Tab", "Escape", "Esc", "Backspace", "Delete", "Del",
                            "Home", "End", "PageUp", "PageDown", "PgUp", "PgDn",
                            // Shift in front of a quiet key is the same key.
                            "Shift+ArrowDown", "Shift+Tab", "Shift + Tab", "shift+Home"})
      if (!Check(!ShadowKeyOpens(key), (std::string("key-does-not-open-") + key).c_str())) return false;
    // The core's own default is fail closed: facts built without a key decision treat a key as one
    // that may open (never as plain typing); every production path sets it from ShadowKeyOpens.
    {
      EffectFacts bare;
      bare.action = ActionKind::kKey;
      if (!Check(bare.key_is_activation && MayOpen(bare), "key-default-is-fail-closed")) return false;
      bare.key_is_activation = false;
      if (!Check(!MayOpen(bare), "key-explicit-typing-does-not-open")) return false;
    }
    // BEGIN host key names
    // Every key name the hosts accept (Windows VirtualKeyForName, macOS KeyCodeForName), with what it
    // is: the vitest contract reads this list and the two host sources and requires them to match,
    // so a name added to a host is classified here on purpose.
    static const std::pair<const char *, bool> kHostKeys[] = {
        {"Enter", true},     {"Tab", false},       {"Escape", false},     {"Backspace", false},
        {"Delete", false},   {"ArrowUp", false},   {"ArrowDown", false},  {"ArrowLeft", false},
        {"ArrowRight", false}, {"Home", false},    {"End", false},
    };
    // END host key names
    for (const auto &entry : kHostKeys)
      if (!Check(ShadowKeyOpens(entry.first) == entry.second, (std::string("host-key-") + entry.first).c_str()))
        return false;
    // Through the facts: a chord is an activating key; an arrow is not.
    ShadowRequestInfo request = UiaRequest("key");
    request.key = "Cmd+O";
    if (!Check(BuildWindowsShadowFacts(UiaBase(), request).facts.key_is_activation, "key-chord-is-activation-in-the-facts"))
      return false;
    request.key = "ArrowDown";
    if (!Check(!BuildWindowsShadowFacts(UiaBase(), request).facts.key_is_activation, "arrow-is-not-activation-in-the-facts"))
      return false;
    EffectFacts finder_key = facts_for(SurfaceKind::kFileBrowser, ActionKind::kKey,
                                       {{"axrow", "", "run.command"}, {"axoutline", "", "Files"}, {"axwindow", "", "Documents"}},
                                       "command", true);
    finder_key.key_is_activation = ShadowKeyOpens("Cmd+Down");
    if (!Check(MayOpen(finder_key) && InterlockForFacts(finder_key).Refuses(), "key-cmd-down-on-a-finder-row-is-opening"))
      return false;
  }

  // RecentInputMayCompleteDoubleClick: a click may pair only with an input within the double-click
  // time of now; the last input time is the latest of all inputs, whoever sent them. Interval 500.
  {
    const auto may = [](bool read_ok, std::uint32_t last, std::uint32_t now) {
      return RecentInputMayCompleteDoubleClick(read_ok, last, now, 500);
    };
    if (!Check(may(true, 1000, 1000), "recent-input-same-tick")) return false;
    if (!Check(may(true, 1000, 1500), "recent-input-exactly-at-the-interval")) return false;
    // One tick of room (16 ms) for the coarse clock, on the safe side.
    if (!Check(may(true, 1000, 1516), "recent-input-at-the-interval-plus-a-tick")) return false;
    if (!Check(!may(true, 1000, 1517), "recent-input-one-past-the-interval-and-a-tick")) return false;
    if (!Check(!may(true, 1000, 60000), "recent-input-long-ago-cannot-pair")) return false;
    if (!Check(may(true, 1500, 1000), "recent-input-in-the-future-may-pair")) return false;
    if (!Check(may(false, 0, 60000), "recent-input-unreadable-may-pair")) return false;
    // Ticks wrap at 2^32.
    if (!Check(may(true, 0xFFFFFFF0u, 0x00000010u), "recent-input-across-the-wrap")) return false;
    if (!Check(!may(true, 0xFFFFFFF0u, 0x00000300u), "recent-input-across-the-wrap-too-old")) return false;
    // A last input 2^31 or more behind now reads as the future (fail closed), not as ancient.
    if (!Check(may(true, 0x00001000u, 0x80001000u), "recent-input-two-pow-31-apart-is-fail-closed")) return false;
    // The scenarios that a "who sent it" rule gets wrong. A person clicks at t=1000, this helper
    // sends a key at t=1100 (it overwrites the system's last input), then clicks at t=1300: the OS
    // sees two presses 300 ms apart.
    if (!Check(may(true, 1100, 1300), "recent-input-person-click-then-our-key-then-our-click")) return false;
    // A person's click lands 40 ms after our injection, inside any slack; then our click at t=1200.
    if (!Check(may(true, 1040, 1200), "recent-input-person-click-in-the-slack")) return false;
    // Our own previous click and the next one a model round trip later: not a pair.
    if (!Check(!may(true, 1000, 4000), "recent-input-our-own-click-seconds-ago-cannot-pair")) return false;
  }

  std::cout << "Computer Use native click rule: PASS\n";
  return true;
}

// ---- #500 S5-c-2 PR-5: the dispatch's refusal codes ---------------------------------------------

bool CheckInterlockDispatchCodes() {
  using namespace sprint_coder::computer_use;
  // One reason, one dispatch code: the preflight code without its "native_" prefix (Main adds it back
  // and takes the result from the same row of the receipt table). No verdict, no code.
  struct Row { InterlockOutcome outcome; InterlockReason reason; const char *dispatch; const char *preflight; };
  const Row rows[] = {
      {InterlockOutcome::kBlocked, InterlockReason::kShellSurface, "shell_surface_blocked", "native_shell_surface_blocked"},
      {InterlockOutcome::kTakeover, InterlockReason::kExecutionTrigger, "execution_trigger_blocked", "native_execution_trigger_blocked"},
      {InterlockOutcome::kBlocked, InterlockReason::kApprovalClosed, "approval_not_enabled", "native_approval_not_enabled"},
  };
  for (const Row &row : rows) {
    InterlockVerdict verdict;
    verdict.outcome = row.outcome;
    verdict.reason = row.reason;
    if (!Check(verdict.DispatchCode() == row.dispatch, "dispatch-code-of-the-reason")) return false;
    if (!Check(std::string("native_") + std::string(verdict.DispatchCode()) == verdict.ReasonCode() &&
                   verdict.ReasonCode() == row.preflight,
               "dispatch-code-is-the-preflight-code-without-the-prefix")) return false;
    // The pair the preflight sends is a row of the closed table (the dispatch has the same reason).
    if (!Check(NativePreflightRefusalAllowed(verdict.DecisionName(), verdict.ReasonCode(), verdict.DeniedResult()),
               "interlock-pair-is-a-table-row")) return false;
  }
  // One to one: the three codes are pairwise different, and a verdict with nothing has none.
  if (!Check(std::string_view("shell_surface_blocked") != "execution_trigger_blocked" &&
                 std::string_view("execution_trigger_blocked") != "approval_not_enabled" &&
                 std::string_view("shell_surface_blocked") != "approval_not_enabled",
             "dispatch-codes-differ")) return false;
  if (!Check(InterlockVerdict{}.DispatchCode().empty(), "no-verdict-has-no-dispatch-code")) return false;
  if (!Check(InterlockVerdict{}.ReasonCode().empty() && InterlockVerdict{}.DecisionName().empty(),
             "no-verdict-has-no-receipt-fields")) return false;
  std::cout << "Computer Use native interlock dispatch codes: PASS\n";
  return true;
}

// ---- #500 S5-c-2 PR-5: what V1's users can reach is not newly refused --------------------------------
//
// V1 reaches the acceptance fixture and Notepad only. Their UI Automation trees (every control of the
// fixture; the old and the new Notepad) are fed to the interlock with every action kind and a title in
// English and Japanese. A refusal is allowed only where V1's own word list refuses too, or for one of
// the words the owner accepted (the vocabulary test pins the list).

bool CheckWindowsInterlockJourneys() {
  using namespace sprint_coder::computer_use;
  const EffectRuleset closed;  // the Windows rule set: no approval path (download_open / file_manager_open false)
  const auto node = [](const char *type, const char *klass, const std::string &name, bool password = false) {
    ShadowUiaNode item;
    item.control_type = type;
    item.class_name = klass;
    item.name = name;
    item.is_password = password;
    return item;
  };
  const auto capture = [&](std::vector<ShadowUiaNode> chain, const std::string &window_class,
                           const std::string &process_path) {
    ShadowUiaCapture result;
    result.target_found = true;
    result.chain = std::move(chain);
    result.chain_reached_root = true;
    result.neighbors_complete = true;
    result.window_class_read = true;
    result.window_class = window_class;
    result.process_path_read = true;
    result.process_path = process_path;
    return result;
  };
  const char *const kinds[] = {"click", "invoke", "key", "type", "set_text", "scroll", "select", "toggle", "expand_collapse"};
  const auto notepad_path_for_install = []() { return std::string("C:\\Windows\\System32\\notepad.exe"); };
  const auto refused = [&](const ShadowUiaCapture &tree, const char *kind, const char *language) {
    ShadowRequestInfo request = UiaRequest(kind);
    request.policy_language = language;
    request.key = "Enter";
    request.click_tracked = true;
    // The worst case for a click: it may open (a double click).
    request.click_opens = std::string_view(kind) == "click";
    return EvaluateWindowsInterlockFromCapture(tree, request, false, closed).Refuses();
  };

  // The acceptance fixture: every control, in the window of the fixture. The values below are the
  // fixture's own (its class and title from fixture_contract.h, its labels from
  // win32_acceptance_fixture.cc); computer-use-windows-interlock-journeys.test.ts reads both sources
  // and requires this block to agree with them, so the tree cannot drift from the real one.
  // BEGIN fixture tree
  const std::string fixture_class = "SprintCoderComputerUseAcceptanceFixtureV1";
  const std::string fixture_title = "Sprint Coder Computer Use Fixture v1";
  const std::string fixture_path = "C:\\Fixture\\win32_acceptance_fixture.exe";
  const std::string dialog_class = "SprintCoderComputerUseSafeDialogV1";
  const std::string dialog_title = "Fixture same-owner safe dialog";
  const std::string picker_title = u8"Fixture file picker — Sprint Coder must request user takeover"_u8;
  struct Control { std::string type; std::string klass; std::string name; bool password; };
  const std::vector<Control> controls = {
      {"Text", "Static", "Deterministic non-production fixture. Normal controls are safe; boundary controls must stop Computer Use.", false},
      {"Text", "Static", "Normal text", false},
      {"Edit", "Edit", "Fixture text: safe to replace", false},
      {"Button", "Button", "Run deterministic normal action", false},
      {"CheckBox", "Button", "Enable deterministic option", false},
      {"Text", "Static", "Normal selection", false},
      {"ComboBox", "ComboBox", "", false},
      {"ListItem", "", "Alpha", false},
      {"ListItem", "", "Beta", false},
      {"ListItem", "", "Gamma", false},
      {"Text", "Static", u8"Password field — MUST BLOCK"_u8, false},
      {"Edit", "Edit", "not-a-real-secret", true},
      {"Text", "Static", "Safety boundary controls below are inert test affordances. They perform no payment and retain no selected path.", false},
      {"Button", "Button", u8"Authorize test payment — MUST BLOCK"_u8, false},
      {"Button", "Button", u8"Open file picker — USER TAKEOVER"_u8, false},
      {"Button", "Button", "Reset deterministic state", false},
      {"Button", "Button", "Open same-owner safe dialog", false},
      {"Text", "Static", "READY: no boundary control has been invoked", false},
      {"Text", "Static", "NORMAL_ACTION_COMPLETED: deterministic button invoked", false},
  };
  const std::vector<Control> dialog_controls = {
      {"Text", "Static", "This custom same-owner dialog is safe to automate.", false},
      {"Edit", "Edit", "Safe dialog text", false},
      {"Button", "Button", "Close safe dialog", false},
  };
  // END fixture tree
  for (const Control &control : controls)
    for (const char *kind : kinds)
      for (const char *language : {"en", "ja"})
        if (!Check(!refused(capture({node(control.type.c_str(), control.klass.c_str(), control.name, control.password),
                                     node("Window", fixture_class.c_str(), fixture_title)},
                                    fixture_class, fixture_path),
                            kind, language),
                   (std::string("journey-fixture-not-refused-") + control.name).c_str()))
          return false;
  // The safe dialog the fixture opens (its controls), and the file picker (a takeover of V1's own,
  // outside the interlock).
  for (const Control &control : dialog_controls)
    for (const char *kind : kinds)
      if (!Check(!refused(capture({node(control.type.c_str(), control.klass.c_str(), control.name),
                                   node("Window", dialog_class.c_str(), dialog_title)},
                                  dialog_class, fixture_path),
                          kind, "en"),
                 (std::string("journey-safe-dialog-not-refused-") + control.name).c_str()))
        return false;
  for (const char *kind : kinds)
    if (!Check(!refused(capture({node("Window", "#32770", picker_title)}, "#32770", fixture_path), kind, "en"),
               "journey-file-picker-window-not-refused"))
      return false;

  // E4, the installer rule: a control named like an installer is a takeover (paused) on every surface.
  // V1 knows "installer", "install application" and the Japanese word for install; the interlock also
  // knows "install" on its own and the Japanese installer word (owner accepted; the vocabulary test pins
  // the words). Starting an installer is a takeover, whatever the control is.
  for (const char *type : {"Button", "MenuItem"})
    for (const std::string &name : std::vector<std::string>{"Install", "install", u8"\u30a4\u30f3\u30b9\u30c8\u30fc\u30e9"_u8}) {
      ShadowRequestInfo request = UiaRequest("invoke");
      request.click_tracked = true;
      const InterlockEvaluation evaluation = EvaluateWindowsInterlockFromCapture(
          capture({node(type, "Button", name), node("Window", "Notepad", "Untitled - Notepad")}, "Notepad", notepad_path_for_install()),
          request, false, closed);
      if (!Check(evaluation.Refuses() && evaluation.verdict.outcome == InterlockOutcome::kTakeover &&
                     evaluation.verdict.reason == InterlockReason::kExecutionTrigger &&
                     evaluation.verdict.DeniedResult() == "paused",
                 (std::string("journey-installer-control-is-a-paused-takeover-") + type + "-" + name).c_str()))
        return false;
    }
  // A word that merely contains it is not an installer (the rule is bounded).
  {
    ShadowRequestInfo request = UiaRequest("invoke");
    request.click_tracked = true;
    if (!Check(!EvaluateWindowsInterlockFromCapture(
                    capture({node("Button", "Button", "Reinstall guide"), node("Window", "Notepad", "Untitled - Notepad")},
                            "Notepad", notepad_path_for_install()),
                    request, false, closed).Refuses(),
               "journey-install-inside-a-word-is-not-an-installer"))
      return false;
  }

  // Notepad, old (a Window, an Edit, a menu bar) and new (a Document), English and Japanese titles.
  const std::string notepad_path = "C:\\Windows\\System32\\notepad.exe";
  struct Tree { const char *name; std::vector<ShadowUiaNode> chain; };
  const std::vector<Tree> notepads = {
      {"old-edit", {node("Edit", "Edit", "Text Editor"), node("Window", "Notepad", "Untitled - Notepad")}},
      {"old-edit-ja", {node("Edit", "Edit", u8"テキスト エディター"_u8), node("Window", "Notepad", u8"無題 - メモ帳"_u8)}},
      {"old-menu", {node("MenuItem", "", "File"), node("MenuBar", "", "Application"), node("Window", "Notepad", "Untitled - Notepad")}},
      {"old-menu-ja", {node("MenuItem", "", u8"ファイル(F)"_u8), node("MenuBar", "", u8"アプリケーション"_u8), node("Window", "Notepad", u8"無題 - メモ帳"_u8)}},
      {"old-find", {node("Button", "Button", "Find Next"), node("Window", "#32770", "Find")}},
      {"old-replace", {node("Button", "Button", "Replace All"), node("Window", "#32770", "Replace")}},
      {"old-font", {node("Button", "Button", "OK"), node("Window", "#32770", "Font")}},
      {"new-document", {node("Document", "RichEditD2DPT", "Text editor"), node("Window", "Notepad", "Untitled - Notepad")}},
      {"new-document-ja", {node("Document", "RichEditD2DPT", u8"テキスト エディター"_u8), node("Window", "Notepad", u8"無題 - メモ帳"_u8)}},
      {"new-saved-file", {node("Document", "RichEditD2DPT", "Text editor"), node("Window", "Notepad", "notes.txt - Notepad")}},
      {"new-saved-file-ja", {node("Document", "RichEditD2DPT", u8"テキスト エディター"_u8), node("Window", "Notepad", u8"メモ.txt - メモ帳"_u8)}},
  };
  for (const Tree &tree : notepads)
    for (const char *kind : kinds)
      for (const char *language : {"en", "ja"})
        if (!Check(!refused(capture(tree.chain, tree.chain.back().class_name, notepad_path), kind, language),
                   (std::string("journey-notepad-not-refused-") + tree.name).c_str()))
          return false;

  // Where the refusal is allowed. A title with a word V1 refuses too: refused (no change for V1).
  const auto titled = [&](const std::string &title) {
    return capture({node("Edit", "Edit", "Text Editor"), node("Window", "Notepad", title)}, "Notepad", notepad_path);
  };
  for (const char *title : {"terminal notes.txt - Notepad", "console log - Notepad", "shell.txt - Notepad", "powershell tips - Notepad"})
    if (!Check(refused(titled(title), "click", "en") && refused(titled(title), "type", "en"),
               (std::string("journey-v1-word-in-the-title-is-refused-") + title).c_str()))
      return false;
  // The words the owner accepted (not refused by V1 today): refused now, and only these.
  for (const std::string &title : std::vector<std::string>{"xterm settings - Notepad", "run script.txt - Notepad", u8"ターミナル手順.txt - メモ帳"_u8,
                            u8"コンソール - メモ帳"_u8, u8"コマンドプロンプト入門 - メモ帳"_u8, u8"スクリプトを実行 - メモ帳"_u8})
    if (!Check(refused(titled(title), "click", "ja"), (std::string("journey-accepted-new-word-is-refused-") + title).c_str()))
      return false;
  // The same words in full width are folded to ASCII before they are matched (NFKC): refused as in
  // ASCII. This is the spelling difference the owner accepted (V1 matches the characters as they are).
  for (const std::string &title : std::vector<std::string>{u8"ｘｔｅｒｍ settings - Notepad"_u8, u8"ｔｅｒｍｉｎａｌ notes - Notepad"_u8})
    if (!Check(refused(titled(title), "click", "en"), (std::string("journey-full-width-word-is-refused-") + title).c_str()))
      return false;

  std::cout << "Computer Use native Windows interlock journeys: PASS\n";
  return true;
}

int main() {
  if (!CheckNativePreflightClassifier()) return 1;
  std::cout << "Computer Use native classifier core: PASS (16 facts, 100 authority tuples)\n";
  if (!CheckNativeBinding()) return 1;
  std::cout << "Computer Use native binding canonical framing: PASS\n";
  if (!CheckNativeApprovalTicket()) return 1;
  if (!CheckNativeApprovalFlow()) return 1;
  if (!CheckNativeEligibility()) return 1;
  if (!CheckNativeRunningIdentity()) return 1;
  if (!CheckEffectClassifierCore()) return 1;
  if (!CheckEffectShadow()) return 1;
  if (!CheckEffectShadowBounds()) return 1;
  if (!CheckEffectShadowFolding()) return 1;
  if (!CheckWindowsShadowCore()) return 1;
  if (!CheckShadowReadHelpers()) return 1;
  if (!CheckWindowsShadowReader()) return 1;
  if (!CheckWindowsShadowScheduler()) return 1;
  if (!CheckEffectMeasurement()) return 1;
  if (!CheckEffectMeasurementBinding()) return 1;
  if (!CheckNativeInterlockMap()) return 1;
  if (!CheckArtifactReadJudgement()) return 1;
  if (!CheckNativeInterlockCapture()) return 1;
  if (!CheckWindowsInterlockCapture()) return 1;
  if (!CheckClickRule()) return 1;
  if (!CheckInterlockDispatchCodes()) return 1;
  if (!CheckWindowsInterlockJourneys()) return 1;
  if (!CheckNativeApprovedRisk()) return 1;
  if (!CheckNativeApprovalOffer()) return 1;
  if (!CheckNativePreflightV2()) return 1;
  if (!CheckEffectPageScroll()) return 1;
  std::cout << "Computer Use native approval ticket policy: PASS\n";
  if (!CheckNativeOrdinaryTicket()) return 1;
  std::cout << "Computer Use native ordinary ticket slot: PASS\n";
  using sprint_coder::computer_use::IsTypeTextScalar;
  for (std::uint32_t scalar = 0; scalar < 0x20; ++scalar)
    if (!Check(!IsTypeTextScalar(scalar), "type-c0-control")) return 1;
  for (std::uint32_t scalar = 0x7f; scalar <= 0x9f; ++scalar)
    if (!Check(!IsTypeTextScalar(scalar), "type-c1-control")) return 1;
  for (std::uint32_t scalar = 0xf700; scalar <= 0xf8ff; ++scalar)
    if (!Check(!IsTypeTextScalar(scalar), "type-function-key")) return 1;
  if (!Check(IsTypeTextScalar(0x65e5) && IsTypeTextScalar(0x1f469) &&
             IsTypeTextScalar(0x200d) && IsTypeTextScalar(0x1f4bb), "type-printable-unicode")) return 1;
  const std::array<std::uint8_t, 17> metadata = {
      '{', '"', 'o', 'p', 'e', 'r', 'a', 't', 'i', 'o', 'n', '"', ':', '"', 'x', '"', '}',
  };
  const std::array<std::uint8_t, 4> binary = {0, 1, 2, 3};
  const auto encoded = EncodeFrame(ValidHeader(), metadata, binary);
  if (!Check(!encoded.empty(), "encode-valid") ||
      !Check(DecodeFrame(encoded).has_value(), "decode-valid"))
    return 1;

  for (std::size_t length = 0; length < encoded.size(); ++length)
    if (!Check(!DecodeFrame(std::span(encoded).first(length)).has_value(), "truncation"))
      return 1;

  for (std::size_t index = 0; index < encoded.size(); ++index) {
    auto mutated = encoded;
    mutated[index] ^= static_cast<std::uint8_t>(0xa5u + index);
    (void)DecodeFrame(mutated);
  }

  auto oversized_metadata = encoded;
  std::uint32_t metadata_size = kMaxMetadataBytes + 1;
  std::memcpy(oversized_metadata.data() + 60, &metadata_size, sizeof(metadata_size));
  if (!Check(!DecodeFrame(oversized_metadata).has_value(), "metadata-bound"))
    return 1;
  auto oversized_binary = encoded;
  std::uint32_t binary_size = kMaxBinaryBytes + 1;
  std::memcpy(oversized_binary.data() + 64, &binary_size, sizeof(binary_size));
  if (!Check(!DecodeFrame(oversized_binary).has_value(), "binary-bound"))
    return 1;

  auto cancel_header = ValidHeader();
  cancel_header.message_type = static_cast<std::uint16_t>(MessageType::kCancel);
  if (!Check(EncodeFrame(cancel_header, metadata).empty(), "cancel-id-required"))
    return 1;
  cancel_header.cancel_id.bytes[0] = 3;
  if (!Check(!EncodeFrame(cancel_header, metadata).empty(), "cancel-id-valid"))
    return 1;

  // The preflight pair (S5-a) is part of the wire vocabulary, and the next number is not.
  for (const auto type : {MessageType::kPreflight, MessageType::kPreflightResult}) {
    auto preflight_header = ValidHeader();
    preflight_header.message_type = static_cast<std::uint16_t>(type);
    if (!Check(!EncodeFrame(preflight_header, metadata).empty() &&
                   DecodeFrame(EncodeFrame(preflight_header, metadata)).has_value(),
               "preflight-message-type-known"))
      return 1;
  }
  auto unknown_type_header = ValidHeader();
  unknown_type_header.message_type =
      static_cast<std::uint16_t>(MessageType::kPreflightResult) + 1;
  if (!Check(EncodeFrame(unknown_type_header, metadata).empty() ||
                 !DecodeFrame(EncodeFrame(unknown_type_header, metadata)).has_value(),
             "message-type-after-preflight-unknown"))
    return 1;

  std::vector<std::uint8_t> too_large_metadata(kMaxMetadataBytes + 1, 'x');
  std::vector<std::uint8_t> too_large_binary(kMaxBinaryBytes + 1, 0);
  if (!Check(EncodeFrame(ValidHeader(), {}).empty(), "empty-metadata") ||
      !Check(EncodeFrame(ValidHeader(), too_large_metadata).empty(), "encode-metadata-bound") ||
      !Check(EncodeFrame(ValidHeader(), metadata, too_large_binary).empty(),
             "encode-binary-bound"))
    return 1;

  std::uint32_t state = 0x3335a17u;
  for (std::size_t iteration = 0; iteration < 4'096; ++iteration) {
    const std::size_t length = Next(&state) % 1'025;
    std::vector<std::uint8_t> input(length);
    std::generate(input.begin(), input.end(), [&]() {
      return static_cast<std::uint8_t>(Next(&state));
    });
    (void)DecodeFrame(input);
  }

  std::cout << "Computer Use native protocol sanitizer harness: PASS\n";
  return 0;
}
