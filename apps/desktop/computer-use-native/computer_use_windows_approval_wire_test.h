#pragma once

#include "computer_use_windows_approval_wire.h"
#include "computer_use_windows_approval_round_trip_wire_test.h"

inline bool CheckWindowsApprovalWire(std::string_view golden_receipt) {
  using namespace sprint_coder::computer_use;
  if (!CheckApprovalRoundTripWire()) return false;
  WindowsApprovalReceiptContext context{"request-1", "session-1", 0, 1, 0};
  NativeApprovalOffer offer{1, 60'000, NativeApprovalEffect::kSupervisedAction};
  WindowsApprovalDisplay display{NativeApprovalEffect::kSupervisedAction, "click", "Example",
                                 std::nullopt, false};
  if (WindowsApprovalOfferReceipt(context, offer, display) != golden_receipt)
    return false;
  for (const auto effect : {NativeApprovalEffect::kSupervisedAction,
                            NativeApprovalEffect::kHighImpactConfirmation,
                            NativeApprovalEffect::kDownloadOpen,
                            NativeApprovalEffect::kFileManagerOpen}) {
    offer.effect = display.effect = effect;
    const bool open = effect == NativeApprovalEffect::kDownloadOpen ||
                      effect == NativeApprovalEffect::kFileManagerOpen;
    display.extension = open ? std::optional<std::string>("c++") : std::nullopt;
    if (WindowsApprovalOfferReceipt(context, offer, display).empty()) return false;
    auto semantic_scroll = display;
    semantic_scroll.operation = "semantic_scroll";
    const auto scroll_receipt = WindowsApprovalOfferReceipt(context, offer, semantic_scroll);
    if (scroll_receipt.empty() != (effect != NativeApprovalEffect::kSupervisedAction)) return false;
    if (effect == NativeApprovalEffect::kSupervisedAction &&
        scroll_receipt.find("\"operation\":\"semantic_scroll\"") == std::string::npos) return false;
    auto invalid = display;
    invalid.operation = "observe";
    if (!WindowsApprovalOfferReceipt(context, offer, invalid).empty()) return false;
    invalid = display;
    invalid.effect = NativeApprovalEffect::kInvalid;
    if (!WindowsApprovalOfferReceipt(context, offer, invalid).empty()) return false;
    invalid = display;
    invalid.target_label.reset();
    if (WindowsApprovalOfferReceipt(context, offer, invalid).empty() != open) return false;
    invalid = display;
    invalid.extension = open ? std::optional<std::string>("TXT.") : std::optional<std::string>("txt");
    if (!WindowsApprovalOfferReceipt(context, offer, invalid).empty()) return false;
  }
  offer.effect = display.effect = NativeApprovalEffect::kSupervisedAction;
  display.extension.reset();
  for (const auto ms : {0U, 60'001U}) {
    offer.remaining_ms = ms;
    if (!WindowsApprovalOfferReceipt(context, offer, display).empty()) return false;
  }
  offer.remaining_ms = 1;
  offer.approval_generation = kNativeApprovalGenerationMax;
  if (WindowsApprovalOfferReceipt(context, offer, display).empty()) return false;
  ++offer.approval_generation;
  if (!WindowsApprovalOfferReceipt(context, offer, display).empty()) return false;
  offer.approval_generation = 1;
  context.input_attempt_count = kNativeApprovalGenerationMax + 1;
  if (!WindowsApprovalOfferReceipt(context, offer, display).empty()) return false;
  context.input_attempt_count = 0;
  display.target_label = "a\"b\\c\n";
  const auto escaped = WindowsApprovalOfferReceipt(context, offer, display);
  if (escaped.find("a\\\"b\\\\c\\u000a") == std::string::npos) return false;
  display.target_label = std::string(1, static_cast<char>(0xff));
  return WindowsApprovalOfferReceipt(context, offer, display).empty();
}
