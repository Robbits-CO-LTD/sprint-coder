#include "computer_use_native_binding.h"
#include "computer_use_native_ticket.h"
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

int main() {
  if (!CheckNativePreflightClassifier()) return 1;
  std::cout << "Computer Use native classifier core: PASS (16 facts, 100 authority tuples)\n";
  if (!CheckNativeBinding()) return 1;
  std::cout << "Computer Use native binding canonical framing: PASS\n";
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
