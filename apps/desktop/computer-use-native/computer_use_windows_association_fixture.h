#pragma once
#include "computer_use_windows_association.h"

namespace sprint_coder::computer_use {

static_assert(kWindowsDocumentViewerVersion == 1 &&
              kWindowsDocumentViewerDigestPinned == 0x10adf348d184174eULL);

template <class Check> bool CheckWindowsAssociationSelection(Check check) {
  using V = WindowsOpenVerdict;
  WindowsAssociationFacts association;
  association.real_path_verified = true;
  association.real_path = "C:\\synthetic\\document.txt";
  association.extension = "txt";
  association.complete = true;
  association.signature_valid = true;
  association.perceived_type = "text";
  association.prog_id = "Synthetic.Document";
  association.verb = "open";
  association.executable = "C:\\synthetic\\viewer.exe";
  association.command = "\"C:\\synthetic\\viewer.exe\" \"%1\"";
  association.signer_sha256 = std::string(64, 'a');
  if (!check(JudgeWindowsAssociation(association) == V::kTakeover, "association-unknown-handler")) return false;
  auto ide = association;
  ide.real_path_verified = false;
  ide.real_path.clear();
  if (!check(JudgeWindowsAssociation(ide) == V::kTakeover, "association-ide-unknown-real-path")) return false;
  for (const auto extension : {"exe", "msi", "msu", "appinstaller"}) {
    auto changed = association;
    changed.extension = extension;
    // Synthetic RLO display spoof: only the real path extension is authoritative.
    changed.real_path = std::string("C:\\synthetic\\report-\xe2\x80\xae" "txt.") + extension;
    if (!check(JudgeWindowsAssociation(changed) == V::kBlocked, "association-rlo-real-executable")) return false;
  }
  for (int defect = 0; defect < 7; ++defect) {
    auto changed = association;
    if (defect == 0) changed.complete = false;
    if (defect == 1) changed.delegate_execute = true;
    if (defect == 2) changed.drop_target = true;
    if (defect == 3) changed.extension = "unknown-type";
    if (defect == 4) changed.real_path_verified = false;
    if (defect == 5) changed.signature_valid = false;
    if (defect == 6) changed.command += " /execute";
    if (!check(JudgeWindowsAssociation(changed) == V::kTakeover, "association-incomplete-or-unsupported")) return false;
  }
  association.dangerous = true;
  if (!check(JudgeWindowsAssociation(association) == V::kBlocked, "association-dangerous")) return false;
  association.dangerous = false;
  association.perceived_type = "application";
  if (!check(JudgeWindowsAssociation(association) == V::kBlocked, "association-application")) return false;
  WindowsSingleSelectionFacts selected{true, true, true, 1, 1,
                                       {"C:\\synthetic\\document.txt"}, "C:\\synthetic\\document.txt"};
  if (!check(JudgeWindowsSingleSelection(selected) == V::kVerified, "selection-single")) return false;
  const char *names[] = {"selection-multiple", "selection-other", "selection-none", "selection-read-failed",
                         "selection-uia-mismatch", "selection-offscreen", "selection-uia-read-failed"};
  for (int defect = 0; defect < 7; ++defect) {
    auto changed = selected;
    if (defect == 0) { changed.shell_count = 2; changed.uia_count = 2; changed.shell_paths.push_back("C:\\synthetic\\other.txt"); }
    if (defect == 1) changed.shell_paths[0] = "C:\\synthetic\\other.txt";
    if (defect == 2) { changed.shell_count = 0; changed.shell_paths.clear(); }
    if (defect == 3) changed.shell_complete = false;
    if (defect == 4) changed.uia_target_matches = false;
    if (defect == 5) { changed.shell_count = 2; changed.shell_paths.push_back("C:\\synthetic\\offscreen.txt"); }
    if (defect == 6) changed.uia_complete = false;
    if (!check(JudgeWindowsSingleSelection(changed) == V::kTakeover, names[defect])) return false;
  }
  WindowsOpenFacts first{association, selected, true};
  if (!check(SameWindowsOpenFacts(first, first), "boundary-identical")) return false;
  for (int defect = 0; defect < 5; ++defect) {
    auto changed = first;
    if (defect == 0) changed.association.command += " /execute";
    if (defect == 1) changed.association.user_choice = "Synthetic.Changed";
    if (defect == 2) changed.association.signer_sha256[0] = 'b';
    if (defect == 3) changed.selection.shell_paths[0] = "C:\\synthetic\\other.txt";
    if (defect == 4) changed.selection.shell_count = 2;
    if (!check(!SameWindowsOpenFacts(first, changed), "boundary-changed-takeover")) return false;
    if (!check(JudgeWindowsOpenFacts(changed, &first) == V::kTakeover,
               "boundary-changed-verdict")) return false;
  }
  if (!check(WindowsOpenMeasurementDeadline(100, 200) == 200 &&
                 WindowsOpenMeasurementDeadline(100, 300'000'000) == 150'000'100 &&
                 WindowsOpenMeasurementDeadline(UINT64_MAX, UINT64_MAX) == 0, "measurement-deadline")) return false;
  std::uint64_t now = 100;
  bool valid = true;
  WindowsOpenMeasurementLimits limits{[&] { return valid; }, [&] { return now; }, 100, 200};
  if (!check(limits.MayRead(), "measurement-live")) return false;
  now = 200;
  if (!check(!limits.MayRead(), "measurement-expired")) return false;
  now = 99;
  if (!check(!limits.MayRead(), "measurement-clock-reversed")) return false;
  now = 100; valid = false;
  return check(!limits.MayRead(), "measurement-cancelled");
}
} // namespace sprint_coder::computer_use
