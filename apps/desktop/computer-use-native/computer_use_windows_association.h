#pragma once

#include "computer_use_effect_classifier.h"
#include "computer_use_windows_document_viewers.h"
#include "computer_use_sha256.h"
#include <functional>
#include <limits>
#include <algorithm>
#include <span>

namespace sprint_coder::computer_use {

enum class WindowsOpenVerdict { kVerified, kBlocked, kTakeover };
// Every path named `real_path` / `target_real_path` comes from one resolver on the Windows side:
// GetFinalPathNameByHandleW(FILE_NAME_NORMALIZED | VOLUME_NAME_DOS) of a handle opened on the file
// itself (the "\\?\" form, junctions on the way resolved), with `file_id` read from the same handle
// (FILE_ID_INFO: volume serial ":" 128-bit file id, both hex). A shell display path (SIGDN_FILESYSPATH,
// "C:\..." with junctions unresolved) is never taken for a real path.
struct WindowsAssociationFacts {
  bool complete = false;
  bool real_path_verified = false;
  bool dangerous = false;
  bool delegate_execute = false;
  bool drop_target = false;
  bool explorer_command_handler = false;
  bool dde = false;
  bool shell_extension = false;
  // The verb or its command key carries a value that demotes it from the UI default or supplies
  // another command source (LegacyDisable, Extended, IsolatedCommand, a named 'command', ...).
  bool verb_restricted = false;
  bool command_key_matches = false;
  bool signature_valid = false;
  std::string real_path;
  std::string file_id;
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
  // The single selected item resolved by the same resolver as the association (see above).
  std::string target_real_path;
  std::string target_file_id;
};
// The effect decides what is measured: E2 (download open) needs the association, E3 (file manager
// open) needs the association AND the single selection of that same file. Any other effect is
// not an open and is never verified here.
struct WindowsOpenFacts {
  EffectClass effect = EffectClass::kUnclassified;
  WindowsAssociationFacts association;
  WindowsSingleSelectionFacts selection;
};

// The one comparison form of a resolved real path: the "\\?\" / "\\?\UNC\" prefix that the
// resolver always returns is dropped, and the rest compares byte for byte (both sides are the file
// system's own normalized spelling). A path without that prefix was not resolved and is empty here,
// so it never compares equal.
[[nodiscard]] inline std::string CanonicalWindowsRealPath(std::string_view path) {
  constexpr std::string_view unc = "\\\\?\\UNC\\", local = "\\\\?\\";
  if (path.starts_with(unc) && path.size() > unc.size())
    return "\\\\" + std::string(path.substr(unc.size()));
  if (path.starts_with(local) && path.size() > local.size()) return std::string(path.substr(local.size()));
  return {};
}
// Whether the file whose association was measured is the file selected for E3: same file id and
// the same canonical real path.
[[nodiscard]] inline bool SameWindowsOpenTarget(const WindowsAssociationFacts &association,
                                                const WindowsSingleSelectionFacts &selection) {
  const std::string real = CanonicalWindowsRealPath(association.real_path);
  return !real.empty() && real == CanonicalWindowsRealPath(selection.target_real_path) &&
         !association.file_id.empty() && association.file_id == selection.target_file_id;
}

// Whether the measured verb is configured for DDE. The shell answers DDEAPPLICATION even without
// DDE, with the handler's file name stem (measured: "notepad++" for notepad++.exe), so only another
// name is an explicit DDE application; a DDE command or a ddeexec key always is DDE.
[[nodiscard]] inline bool WindowsDdeConfigured(bool command_present, bool application_present,
                                               std::wstring_view application, std::wstring_view executable,
                                               bool ddeexec_key) {
  const auto separator = executable.find_last_of(L"\\/");
  const auto leaf = separator == std::wstring_view::npos ? executable : executable.substr(separator + 1);
  const auto stem = leaf.substr(0, leaf.rfind(L'.'));
  return command_present || ddeexec_key || (application_present && application != stem);
}

// The table-taking forms are the fixture's only (source-checked): it passes a synthetic row so each
// protection is shown to hold while a row would otherwise match. Production calls the public forms
// below, bound to kWindowsDocumentViewers, whose version and digest WindowsOpenFactsDigest carries.
namespace windows_open_detail {
[[nodiscard]] inline WindowsOpenVerdict JudgeAssociationWith(const WindowsAssociationFacts &facts,
                                                             std::span<const WindowsDocumentViewer> viewers) {
  using namespace effect_detail;
  // Display labels never enter this decision. The extension comes from the verified path.
  if (facts.real_path_verified &&
      (InSet(facts.extension, kExecutableExtensions) || InSet(facts.extension, kInstallerExtensions)))
    return WindowsOpenVerdict::kBlocked;
  if (facts.dangerous || facts.perceived_type == "application" || facts.perceived_type == "system")
    return WindowsOpenVerdict::kBlocked;
  if (!facts.complete || !facts.real_path_verified || CanonicalWindowsRealPath(facts.real_path).empty() ||
      facts.file_id.empty() || !IsPlainExtension(facts.extension) || facts.delegate_execute ||
      facts.drop_target || facts.explorer_command_handler || facts.dde || facts.shell_extension ||
      facts.verb_restricted || !facts.command_key_matches || !facts.signature_valid ||
      facts.prog_id.empty() || facts.verb.empty())
    return WindowsOpenVerdict::kTakeover;
  for (const auto &row : viewers)
    if (row.extension == facts.extension && row.perceived_type == facts.perceived_type &&
        row.prog_id == facts.prog_id && row.verb == facts.verb &&
        row.executable == facts.executable && row.command == facts.command &&
        row.signer_sha256 == facts.signer_sha256)
      return WindowsOpenVerdict::kVerified;
  return WindowsOpenVerdict::kTakeover;
}
} // namespace windows_open_detail
[[nodiscard]] inline WindowsOpenVerdict JudgeWindowsAssociation(const WindowsAssociationFacts &facts) {
  return windows_open_detail::JudgeAssociationWith(facts, kWindowsDocumentViewers);
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
  std::string frame = "windows-open-facts-v3";
  const auto append = [&frame](std::string_view value) {
    frame += std::to_string(value.size()) + ":";
    frame.append(value);
  };
  append(std::to_string(kWindowsDocumentViewerVersion));
  append(std::to_string(kWindowsDocumentViewerDigest));
  append(std::to_string(static_cast<unsigned>(facts.effect)));
  const auto &a = facts.association;
  for (const auto *value : {&a.real_path, &a.file_id, &a.extension, &a.perceived_type, &a.user_choice,
                            &a.prog_id, &a.verb, &a.executable, &a.command, &a.signer_sha256}) append(*value);
  for (const bool value : {a.complete, a.real_path_verified, a.dangerous, a.delegate_execute,
                           a.drop_target, a.explorer_command_handler, a.dde, a.shell_extension,
                           a.verb_restricted, a.command_key_matches, a.signature_valid,
                           facts.selection.shell_complete, facts.selection.uia_complete,
                           facts.selection.uia_target_matches}) append(value ? "1" : "0");
  append(std::to_string(facts.selection.shell_count));
  append(std::to_string(facts.selection.uia_count));
  append(facts.selection.target_path);
  append(facts.selection.target_real_path);
  append(facts.selection.target_file_id);
  append(std::to_string(facts.selection.shell_paths.size()));
  for (const auto &path : facts.selection.shell_paths) append(path);
  return Sha256Hex(frame);
}
[[nodiscard]] inline bool SameWindowsOpenFacts(const WindowsOpenFacts &before, const WindowsOpenFacts &after) {
  return WindowsOpenFactsDigest(before) == WindowsOpenFactsDigest(after);
}
namespace windows_open_detail {
[[nodiscard]] inline WindowsOpenVerdict JudgeOpenFactsWith(const WindowsOpenFacts &current,
                                                           const WindowsOpenFacts *previous,
                                                           std::span<const WindowsDocumentViewer> viewers) {
  if (previous && !SameWindowsOpenFacts(*previous, current)) return WindowsOpenVerdict::kTakeover;
  const auto association = JudgeAssociationWith(current.association, viewers);
  if (association == WindowsOpenVerdict::kBlocked) return association;
  const bool e2 = current.effect == EffectClass::kE2DownloadOpen;
  const bool e3 = current.effect == EffectClass::kE3FileManagerOpen;
  if (!e2 && !e3) return WindowsOpenVerdict::kTakeover;
  if (association != WindowsOpenVerdict::kVerified) return association;
  if (e2) return WindowsOpenVerdict::kVerified;
  // E3 always: exactly one selected item, and it is the file whose association was measured.
  if (JudgeWindowsSingleSelection(current.selection) != WindowsOpenVerdict::kVerified ||
      !SameWindowsOpenTarget(current.association, current.selection))
    return WindowsOpenVerdict::kTakeover;
  return WindowsOpenVerdict::kVerified;
}
} // namespace windows_open_detail
[[nodiscard]] inline WindowsOpenVerdict JudgeWindowsOpenFacts(const WindowsOpenFacts &current,
                                                              const WindowsOpenFacts *previous = nullptr) {
  return windows_open_detail::JudgeOpenFactsWith(current, previous, kWindowsDocumentViewers);
}

// `still_valid` and `now_ns` are copied into a worker thread that can outlive the caller (a
// measurement abandoned at its deadline keeps running until its OS call returns). They must own
// everything they capture (values or shared_ptr), never refer to the caller's stack or to an
// object the caller may destroy. N8-2's boundary wiring has to keep this contract.
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
