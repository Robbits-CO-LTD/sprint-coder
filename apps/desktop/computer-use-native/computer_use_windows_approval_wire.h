#pragma once

// Windows-only receipt serialization. The owner must supply measured display facts bound to its
// private intent. This function neither issues a ticket nor enables the production approval gate.
#include "computer_use_effect_classifier.h"
#include "computer_use_native_approval_offer.h"
#include "computer_use_preflight_classifier.h"

#include "computer_use_protocol.h"

#include <algorithm>
#include <optional>
#include <variant>

namespace sprint_coder::computer_use {

inline constexpr std::uint32_t kWindowsApprovalReceiptVersion = 3;

struct WindowsApprovalReceiptContext {
  std::string request_id;
  std::string session_id;
  std::uint64_t cancel_epoch = 0;
  std::uint64_t observation_revision = 0;
  std::uint64_t input_attempt_count = 0;
};

struct WindowsApprovalDisplay {
  NativeApprovalEffect effect = NativeApprovalEffect::kInvalid;
  std::string operation;
  // The measured UI label, never the real path. Main sanitizes it before applying its 512-byte
  // display limit. A missing label is allowed only for general and confirmation operations.
  std::optional<std::string> target_label;
  std::optional<std::string> extension;
  bool unsigned_main_image = false;
};

namespace windows_approval_wire_detail {

inline std::string Quote(std::string_view text) {
  std::string result = "\"";
  for (const unsigned char byte : text) {
    if (byte == '"' || byte == '\\') {
      result += '\\';
      result += static_cast<char>(byte);
    } else if (byte < 0x20) {
      result += "\\u00";
      result += "0123456789abcdef"[byte >> 4];
      result += "0123456789abcdef"[byte & 15];
    } else result += static_cast<char>(byte);
  }
  return result + '"';
}

inline bool OperationAllowed(const WindowsApprovalDisplay &display) {
  const auto &operation = display.operation;
  const bool opens = operation == "click" || operation == "double_click" ||
                     operation == "invoke" || operation == "key";
  switch (display.effect) {
  case NativeApprovalEffect::kDownloadOpen:
  case NativeApprovalEffect::kFileManagerOpen:
    return opens;
  case NativeApprovalEffect::kHighImpactConfirmation:
    return opens || operation == "toggle" || operation == "select";
  case NativeApprovalEffect::kSupervisedAction:
    return opens || operation == "toggle" || operation == "select" || operation == "set_text" ||
           operation == "type" || operation == "scroll" || operation == "expand_collapse" ||
           operation == "semantic_scroll";
  case NativeApprovalEffect::kInvalid:
    return false;
  }
  return false;
}

} // namespace windows_approval_wire_detail

// Empty means no offer. Keep all wire integers exactly representable by Main and leave the old
// macOS serializer untouched. Raw labels are bounded by the wire, then sanitized strictly by Main.
[[nodiscard]] inline std::string WindowsApprovalOfferReceipt(
    const WindowsApprovalReceiptContext &context, const NativeApprovalOffer &offer,
    const WindowsApprovalDisplay &display) {
  using windows_approval_wire_detail::Quote;
  const bool open = offer.effect == NativeApprovalEffect::kDownloadOpen ||
                    offer.effect == NativeApprovalEffect::kFileManagerOpen;
  if (!NativeApprovalOfferIsClosed(offer) || display.effect != offer.effect ||
      !windows_approval_wire_detail::OperationAllowed(display) ||
      context.request_id.empty() || context.request_id.size() > 256 ||
      context.session_id.empty() || context.session_id.size() > 256 ||
      !effect_detail::IsValidUtf8(context.request_id) ||
      !effect_detail::IsValidUtf8(context.session_id) ||
      context.cancel_epoch > kNativeApprovalGenerationMax ||
      context.observation_revision > kNativeApprovalGenerationMax ||
      context.input_attempt_count > kNativeApprovalGenerationMax ||
      (display.target_label && !effect_detail::IsValidUtf8(*display.target_label)) ||
      (open && (!display.target_label || display.target_label->empty() || !display.extension)) ||
      (!open && display.extension) ||
      (display.extension &&
       (!effect_detail::IsPlainExtension(*display.extension) ||
        effect_detail::NormalizeExtension(*display.extension) != *display.extension))) return {};
  const std::string effect(NativeApprovalEffectName(offer.effect));
  std::string receipt =
      "{\"decision\":" + Quote(NativePreflightDecisionName(NativePreflightKind::kSingleUseApproval)) +
      ",\"reasonCode\":null,\"deniedResult\":null,"
      "\"ticket\":null,\"classifierVersion\":4,\"inputAttemptCount\":" +
      std::to_string(context.input_attempt_count) + ",\"requestId\":" + Quote(context.request_id) +
      ",\"sessionId\":" + Quote(context.session_id) +
      ",\"cancelEpoch\":" + std::to_string(context.cancel_epoch) +
      ",\"observationRevision\":" + std::to_string(context.observation_revision) +
      ",\"receiptVersion\":" + std::to_string(kWindowsApprovalReceiptVersion) +
      ",\"approvalGeneration\":" + std::to_string(offer.approval_generation) +
      ",\"remainingMs\":" + std::to_string(offer.remaining_ms) +
      ",\"effect\":" + Quote(effect) + ",\"display\":{\"effect\":" + Quote(effect) +
      ",\"operation\":" + Quote(display.operation) +
      ",\"targetLabel\":" + (display.target_label ? Quote(*display.target_label) : "null") +
      ",\"extension\":" + (display.extension ? Quote(*display.extension) : "null") +
      ",\"externalApplication\":" + Quote(open ? "may_open" : "not_applicable") +
      ",\"unsignedWarning\":" + Quote(display.unsigned_main_image ? "main_image_only" : "none") + "}}";
  if (receipt.size() > 64 * 1024) return {};
  return receipt;
}

} // namespace sprint_coder::computer_use

// P1b closed metadata extension. The future JSON adapter must preserve duplicate members when
// constructing fields. Validation here is shape-only, never session admission or ticket authority.

namespace sprint_coder::computer_use {
using ApprovalRoundTripValue = std::variant<std::string, std::uint64_t, bool>;
using ApprovalRoundTripFields = std::vector<std::pair<std::string, ApprovalRoundTripValue>>;

namespace approval_round_trip_wire_detail {
inline bool Id(std::string_view value) {
  return !value.empty() && value.size() <= 256 &&
      std::all_of(value.begin(), value.end(), [](unsigned char c) {
        return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
            (c >= '0' && c <= '9') || c == '_' || c == '.' || c == ':' || c == '-';
      });
}
inline bool OneOf(std::string_view value, std::initializer_list<std::string_view> choices) {
  return std::find(choices.begin(), choices.end(), value) != choices.end();
}
inline bool ProcessStart(std::string_view value) {
  if (value.empty() || value.size() > 20 || value.front() == '0') return false;
  if (!std::all_of(value.begin(), value.end(), [](char c) { return c >= '0' && c <= '9'; }))
    return false;
  return value.size() < 20 || value <= "18446744073709551615";
}
} // namespace approval_round_trip_wire_detail

[[nodiscard]] inline bool ValidateApprovalRoundTripFields(const ApprovalRoundTripFields &fields) {
  using namespace approval_round_trip_wire_detail;
  const auto get = [&](std::string_view key) -> const ApprovalRoundTripValue* {
    const ApprovalRoundTripValue* result = nullptr;
    for (const auto &[name, value] : fields) if (name == key) {
      if (result) return nullptr;
      result = &value;
    }
    return result;
  };
  const auto str = [&](std::string_view key) -> std::string_view {
    const auto value = get(key);
    const auto text = value ? std::get_if<std::string>(value) : nullptr;
    return text ? *text : std::string_view{};
  };
  const auto number = [&](std::string_view key, std::uint64_t min, std::uint64_t max) {
    const auto value = get(key);
    const auto n = value ? std::get_if<std::uint64_t>(value) : nullptr;
    return n && *n >= min && *n <= max;
  };
  std::vector<std::string_view> keys{
      "version", "roundTripId", "sessionId", "taskId", "turnId", "helperGeneration", "cancelEpoch", "kind"};
  if (!number("version", kApprovalRoundTripVersion, kApprovalRoundTripVersion) ||
      !number("helperGeneration", 1, kNativeApprovalGenerationMax) ||
      !number("cancelEpoch", 0, kNativeApprovalGenerationMax)) return false;
  for (const auto key : {"roundTripId", "sessionId", "taskId", "turnId"})
    if (!Id(str(key))) return false;
  const auto kind = str("kind");
  if (kind == "begin") {
    keys.insert(keys.end(), {"durationMs", "mainPid", "mainProcessStartTime", "mainImageIdentity"});
    const auto image = str("mainImageIdentity");
    if (!number("durationMs", 1, kApprovalRoundTripMaxDurationMs) ||
        !number("mainPid", 1, 0xffffffffULL) || !ProcessStart(str("mainProcessStartTime")) ||
        image.size() != 64 || !std::all_of(image.begin(), image.end(), [](char c) {
          return (c >= 'a' && c <= 'f') || (c >= '0' && c <= '9');
        })) return false;
  } else if (kind == "end") {
    keys.push_back("reason");
    if (!OneOf(str("reason"), {"approved", "rejected", "expired", "stopped", "generation_changed"})) return false;
  } else if (kind == "approve") {
    keys.insert(keys.end(), {"approvalGeneration", "observationRevision"});
    if (!number("approvalGeneration", 1, kNativeApprovalGenerationMax) ||
        !number("observationRevision", 1, kNativeApprovalGenerationMax)) return false;
  } else if (kind == "begin_result" || kind == "end_result") {
    keys.insert(keys.end(), {"accepted", "failureReason", "failureLatched"});
    const auto a = get("accepted"), l = get("failureLatched");
    const auto accepted = a ? std::get_if<bool>(a) : nullptr;
    const auto latched = l ? std::get_if<bool>(l) : nullptr;
    const auto reason = str("failureReason");
    if (!accepted || !latched ||
        !OneOf(reason, {"none", "third_window", "expired", "rejected", "stopped", "generation_changed",
                       "target_changed", "dialog_changed", "unattributed_target_event", "monitor_failed",
                       "id_mismatch", "ended", "invalid_state"}) ||
        *accepted != (reason == "none") || (*accepted && *latched) ||
        (!OneOf(reason, {"none", "id_mismatch", "ended", "invalid_state"}) && !*latched)) return false;
  } else if (kind == "event") {
    keys.insert(keys.end(), {"sequence", "state", "foreground", "failureReason", "failureLatched"});
    const auto state = str("state"), foreground = str("foreground"), reason = str("failureReason");
    const auto value = get("failureLatched");
    const auto latched = value ? std::get_if<bool>(value) : nullptr;
    const bool failed = state == "failed";
    if (!number("sequence", 1, kNativeApprovalGenerationMax) || !latched ||
        !OneOf(state, {"active", "ended", "failed"}) ||
        !OneOf(foreground, {"target", "sprint_coder", "other"}) ||
        !OneOf(reason, {"none", "third_window", "expired", "rejected", "stopped", "generation_changed",
                       "target_changed", "dialog_changed", "unattributed_target_event", "monitor_failed"}) ||
        failed != *latched || failed != (reason != "none") ||
        (foreground == "other" && !failed) || (reason == "third_window" && foreground != "other")) return false;
  } else if (kind != "return") return false;
  if (keys.size() != fields.size()) return false;
  for (const auto key : keys) if (!get(key)) return false;
  return true;
}

[[nodiscard]] inline std::string ApprovalRoundTripWire(const ApprovalRoundTripFields &fields);

struct ApprovalRoundTripEventInput {
  std::string id, session, task, turn, state, foreground, failure;
  std::uint64_t generation = 0, epoch = 0, sequence = 0;
};
// The round-trip event frame. A notification that the wire contract cannot carry is sent as a
// latched `monitor_failed` failure and reports `degraded`, so the owner latches the same failure
// and fails that session closed. Empty only when even that cannot be sent (invalid binding).
[[nodiscard]] inline std::string ApprovalRoundTripEventWire(const ApprovalRoundTripEventInput &in,
                                                            bool *degraded) {
  const auto build = [&](const std::string &state, const std::string &foreground,
                         const std::string &failure) {
    const bool failed = state == "failed";
    return ApprovalRoundTripWire(ApprovalRoundTripFields{{"version", std::uint64_t{1}},
        {"roundTripId", in.id}, {"sessionId", in.session}, {"taskId", in.task},
        {"turnId", in.turn}, {"helperGeneration", in.generation}, {"cancelEpoch", in.epoch},
        {"kind", std::string("event")}, {"sequence", in.sequence}, {"state", state},
        {"foreground", foreground}, {"failureReason", failed ? failure : std::string("none")},
        {"failureLatched", failed}});
  };
  *degraded = false;
  auto payload = build(in.state, in.foreground, in.failure);
  if (!payload.empty()) return payload;
  *degraded = true;
  const bool known = in.foreground == "target" || in.foreground == "sprint_coder";
  return build("failed", known ? in.foreground : std::string("other"), "monitor_failed");
}

// Invalid/missing/unknown/duplicate members cannot be emitted. No OS operation is performed.
[[nodiscard]] inline std::string ApprovalRoundTripWire(const ApprovalRoundTripFields &fields) {
  if (!ValidateApprovalRoundTripFields(fields)) return {};
  std::string result = "{";
  for (const auto &[key, value] : fields) {
    if (result.size() > 1) result += ',';
    result += windows_approval_wire_detail::Quote(key) + ':';
    if (const auto text = std::get_if<std::string>(&value))
      result += windows_approval_wire_detail::Quote(*text);
    else if (const auto n = std::get_if<std::uint64_t>(&value)) result += std::to_string(*n);
    else result += std::get<bool>(value) ? "true" : "false";
  }
  return result + '}';
}
} // namespace sprint_coder::computer_use
