#pragma once

#include "computer_use_effect_classifier.h"
#include "computer_use_windows_document_viewers.h"
#include "computer_use_sha256.h"
#include <functional>
#include <limits>
#include <algorithm>

namespace sprint_coder::computer_use {

enum class WindowsOpenVerdict { kVerified, kBlocked, kTakeover };
struct WindowsAssociationFacts {
  bool complete = false;
  bool real_path_verified = false;
  bool dangerous = false;
  bool delegate_execute = false;
  bool drop_target = false;
  bool signature_valid = false;
  std::string real_path;
  std::string extension;
  std::string perceived_type;
  std::string user_choice;
  std::string prog_id;
  std::string verb;
  std::string executable;
  std::string command;
  std::string signer_sha256;
};
struct WindowsSingleSelectionFacts {
  bool shell_complete = false;
  bool uia_complete = false;
  bool uia_target_matches = false;
  std::uint32_t shell_count = 0;
  std::uint32_t uia_count = 0;
  std::vector<std::string> shell_paths;
  std::string target_path;
};
struct WindowsOpenFacts {
  WindowsAssociationFacts association;
  WindowsSingleSelectionFacts selection;
  bool requires_single_selection = false;
};

[[nodiscard]] inline WindowsOpenVerdict JudgeWindowsAssociation(const WindowsAssociationFacts &facts) {
  using namespace effect_detail;
  // Display labels never enter this decision. The extension comes from the verified path.
  if (facts.real_path_verified &&
      (InSet(facts.extension, kExecutableExtensions) || InSet(facts.extension, kInstallerExtensions)))
    return WindowsOpenVerdict::kBlocked;
  if (facts.dangerous || facts.perceived_type == "application" || facts.perceived_type == "system")
    return WindowsOpenVerdict::kBlocked;
  if (!facts.complete || !facts.real_path_verified || facts.real_path.empty() ||
      !IsPlainExtension(facts.extension) || facts.delegate_execute || facts.drop_target ||
      !facts.signature_valid || facts.prog_id.empty() || facts.verb.empty())
    return WindowsOpenVerdict::kTakeover;
  for (const auto &row : kWindowsDocumentViewers)
    if (row.extension == facts.extension && row.perceived_type == facts.perceived_type &&
        row.prog_id == facts.prog_id && row.verb == facts.verb &&
        row.executable == facts.executable && row.command == facts.command &&
        row.signer_sha256 == facts.signer_sha256)
      return WindowsOpenVerdict::kVerified;
  return WindowsOpenVerdict::kTakeover;
}

[[nodiscard]] inline WindowsOpenVerdict JudgeWindowsSingleSelection(const WindowsSingleSelectionFacts &facts) {
  if (!facts.shell_complete || !facts.uia_complete || !facts.uia_target_matches ||
      facts.shell_count != 1 || facts.uia_count != 1 || facts.shell_paths.size() != 1 ||
      facts.target_path.empty() || facts.shell_paths[0] != facts.target_path)
    return WindowsOpenVerdict::kTakeover;
  return WindowsOpenVerdict::kVerified;
}

// Native-only framing for comparison at preflight, approve and approved dispatch.
// Counts and every path are included; UIA viewport truncation cannot hide an extra selection.
[[nodiscard]] inline std::string WindowsOpenFactsDigest(const WindowsOpenFacts &facts) {
  std::string frame = "windows-open-facts-v1";
  const auto append = [&frame](std::string_view value) {
    frame += std::to_string(value.size()) + ":";
    frame.append(value);
  };
  append(std::to_string(kWindowsDocumentViewerVersion));
  append(std::to_string(kWindowsDocumentViewerDigest));
  const auto &a = facts.association;
  for (const auto *value : {&a.real_path, &a.extension, &a.perceived_type, &a.user_choice,
                            &a.prog_id, &a.verb, &a.executable, &a.command, &a.signer_sha256}) append(*value);
  for (const bool value : {a.complete, a.real_path_verified, a.dangerous, a.delegate_execute,
                           a.drop_target, a.signature_valid, facts.requires_single_selection,
                           facts.selection.shell_complete, facts.selection.uia_complete,
                           facts.selection.uia_target_matches}) append(value ? "1" : "0");
  append(std::to_string(facts.selection.shell_count));
  append(std::to_string(facts.selection.uia_count));
  append(facts.selection.target_path);
  append(std::to_string(facts.selection.shell_paths.size()));
  for (const auto &path : facts.selection.shell_paths) append(path);
  return Sha256Hex(frame);
}
[[nodiscard]] inline bool SameWindowsOpenFacts(const WindowsOpenFacts &before, const WindowsOpenFacts &after) {
  return WindowsOpenFactsDigest(before) == WindowsOpenFactsDigest(after);
}
[[nodiscard]] inline WindowsOpenVerdict JudgeWindowsOpenFacts(
    const WindowsOpenFacts &current, const WindowsOpenFacts *previous = nullptr) {
  if (previous && !SameWindowsOpenFacts(*previous, current)) return WindowsOpenVerdict::kTakeover;
  const auto association = JudgeWindowsAssociation(current.association);
  if (association != WindowsOpenVerdict::kVerified) return association;
  return current.requires_single_selection ? JudgeWindowsSingleSelection(current.selection)
                                           : WindowsOpenVerdict::kVerified;
}

struct WindowsOpenMeasurementLimits {
  std::function<bool()> still_valid;
  std::function<std::uint64_t()> now_ns;
  std::uint64_t started_ns = 0;
  std::uint64_t deadline_ns = 0;
  [[nodiscard]] bool MayRead() const {
    if (!still_valid || !now_ns || !still_valid()) return false;
    const auto now = now_ns();
    return now >= started_ns && now < deadline_ns;
  }
};
[[nodiscard]] inline std::uint64_t WindowsOpenMeasurementDeadline(std::uint64_t start,
                                                                 std::uint64_t ticket_deadline) {
  constexpr std::uint64_t budget = 150'000'000;
  if (start > (std::numeric_limits<std::uint64_t>::max)() - budget) return 0;
  return (std::min)(ticket_deadline, start + budget);
}

} // namespace sprint_coder::computer_use
