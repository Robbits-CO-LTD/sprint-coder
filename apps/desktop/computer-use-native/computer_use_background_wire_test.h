#pragma once

#include "computer_use_protocol.h"

// Golden producer receipts are also consumed by the TS schema test. No OS input is issued.
inline bool CheckBackgroundInputWire() {
  using namespace sprint_coder::computer_use;
  constexpr auto capability = R"wire({"version":1,"capabilityTableVersion":1,"authorityVersion":1})wire";
  constexpr auto session = R"wire({"kind":"background","backgroundCapabilityVersion":1})wire";
  constexpr auto authority = R"wire({"version":1,"sessionKind":"background","inputPath":"background_semantic","pattern":"invoke","targetAncestorsDigest":null,"contentFingerprint":null,"interactionEpoch":null})wire";
  InputAuthority binding;
  binding.session_kind = InputSessionKind::kBackground;
  binding.input_path = InputPath::kBackgroundSemantic;
  binding.pattern = "invoke";
  if (kWindowsBackgroundInputEnabled || WindowsBackgroundCapabilityWire() != capability ||
      InputSessionWire({InputSessionKind::kBackground}) != session ||
      InputAuthorityWire(binding) != authority) return false;
  if (ParseInputPath("unknown") || ParseInputPath("normal") ||
      InputPathLedgerKind(InputPath::kBackgroundSemantic) != "background_semantic" ||
      InputPathLedgerKind(InputPath::kForegroundSemantic) != "normal" ||
      InputPathLedgerKind(InputPath::kForegroundInput) != "normal") return false;
  for (const auto path : {InputPath::kBackgroundSemantic, InputPath::kForegroundSemantic,
                          InputPath::kForegroundInput})
    if (ParseInputPath(InputPathName(path)) != path) return false;
  binding.session_kind = InputSessionKind::kForeground;
  if (!InputAuthorityWire(binding).empty()) return false;
  binding.input_path = InputPath::kForegroundSemantic;
  if (InputAuthorityWire(binding).empty()) return false;
  binding.input_path = InputPath::kForegroundInput;
  if (!InputAuthorityWire(binding).empty()) return false;
  binding.pattern.reset();
  if (InputAuthorityWire(binding).empty()) return false;
  binding.input_path = InputPath::kBackgroundSemantic;
  binding.session_kind = InputSessionKind::kBackground;
  for (const auto pattern : {"scroll_into_view", "unknown", ""}) {
    binding.pattern = pattern;
    if (!InputAuthorityWire(binding).empty()) return false;
  }
  return true;
}
