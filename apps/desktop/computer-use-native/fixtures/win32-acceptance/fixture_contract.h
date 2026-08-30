#pragma once

#include <array>

namespace sprint_coder::computer_use::fixture {

inline constexpr wchar_t kWindowClass[] = L"SprintCoderComputerUseAcceptanceFixtureV1";
inline constexpr wchar_t kWindowTitle[] = L"Sprint Coder Computer Use Fixture v1";

// These IDs are part of the acceptance-fixture contract. Standard Win32 providers expose
// control IDs through UI Automation, so changing a value requires updating the fixture evidence.
enum class ControlId : int {
  kNormalEdit = 1001,
  kNormalButton = 1002,
  kCheckbox = 1003,
  kCombo = 1004,
  kPasswordEdit = 1005,
  kPaymentButton = 1006,
  kFilePickerButton = 1007,
  kResetButton = 1008,
  kStatus = 1009,
  kSafeDialogButton = 1010,
  kNormalEditLabel = 1101,
  kComboLabel = 1102,
  kPasswordLabel = 1103,
  kBoundaryLabel = 1104,
  kIntroduction = 1105,
  kSafeDialogEdit = 1201,
  kSafeDialogClose = 1202,
};

inline constexpr std::array<ControlId, 17> kAllControlIds = {
    ControlId::kNormalEdit,
    ControlId::kNormalButton,
    ControlId::kCheckbox,
    ControlId::kCombo,
    ControlId::kPasswordEdit,
    ControlId::kPaymentButton,
    ControlId::kFilePickerButton,
    ControlId::kResetButton,
    ControlId::kStatus,
    ControlId::kSafeDialogButton,
    ControlId::kNormalEditLabel,
    ControlId::kComboLabel,
    ControlId::kPasswordLabel,
    ControlId::kBoundaryLabel,
    ControlId::kIntroduction,
    ControlId::kSafeDialogEdit,
    ControlId::kSafeDialogClose,
};

inline constexpr int ToInt(ControlId id) {
  return static_cast<int>(id);
}

}  // namespace sprint_coder::computer_use::fixture
