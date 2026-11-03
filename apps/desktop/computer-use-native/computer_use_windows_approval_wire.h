#pragma once

// Windows-only receipt serialization. The owner must supply measured display facts bound to its
// private intent. This function neither issues a ticket nor enables the production approval gate.
#include "computer_use_effect_classifier.h"
#include "computer_use_native_approval_offer.h"
#include "computer_use_preflight_classifier.h"

#include <optional>

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
           operation == "type" || operation == "scroll" || operation == "expand_collapse";
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
      "\"ticket\":null,\"classifierVersion\":2,\"inputAttemptCount\":" +
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
