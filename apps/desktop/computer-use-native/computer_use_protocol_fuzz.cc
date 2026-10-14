#include "computer_use_native_binding.h"
#include "computer_use_native_ticket.h"
#include "computer_use_native_approval_ticket.h"
#include "computer_use_native_approval_flow.h"
#include "computer_use_native_eligibility.h"
#include "computer_use_effect_classifier.h"
#include "computer_use_effect_shadow.h"
#include "computer_use_protocol.h"
#include "computer_use_preflight_classifier.h"

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <functional>
#include <iostream>
#include <limits>
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
  // ticket claim follows the platform: the macOS native requires a ticket for every input, the
  // Windows helper does not until S5.
#if defined(__APPLE__)
  constexpr bool kExpectedTicketRequired = true;
#else
  constexpr bool kExpectedTicketRequired = false;
#endif
  if (!Check(name == "v1-allowlist" && !kNativeEligibilityIsV2 &&
                 kNativeEligibilityTicketRequired == kExpectedTicketRequired,
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
      if (action == ActionKind::kKey &&
          !Check(ClassifyEffect(facts, EffAllEnabled()).effect_class == EffectClass::kE3FileManagerOpen,
                 "effect-e3-any-key")) return false;
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

int main() {
  if (!CheckNativePreflightClassifier()) return 1;
  std::cout << "Computer Use native classifier core: PASS (16 facts, 100 authority tuples)\n";
  if (!CheckNativeBinding()) return 1;
  std::cout << "Computer Use native binding canonical framing: PASS\n";
  if (!CheckNativeApprovalTicket()) return 1;
  if (!CheckNativeApprovalFlow()) return 1;
  if (!CheckNativeEligibility()) return 1;
  if (!CheckEffectClassifierCore()) return 1;
  if (!CheckEffectShadow()) return 1;
  if (!CheckEffectShadowBounds()) return 1;
  if (!CheckEffectShadowFolding()) return 1;
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
