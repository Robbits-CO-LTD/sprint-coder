#pragma once
#include "computer_use_windows_association.h"

namespace sprint_coder::computer_use {

static_assert(kWindowsDocumentViewerVersion == 1 &&
              kWindowsDocumentViewerDigestPinned == 0x10adf348d184174eULL);
static_assert(kWindowsDocumentViewers.empty(), "The production viewer table stays empty until measured.");

// A synthetic, test-only viewer row that matches `facts` exactly. It never enters the production
// table: it is passed to the judge so each protection must hold while a row would otherwise match.
[[nodiscard]] inline WindowsDocumentViewer WindowsTestViewerRowFor(const WindowsAssociationFacts &facts) {
  return {facts.extension, facts.perceived_type, facts.prog_id, facts.verb,
          facts.executable, facts.command, facts.signer_sha256};
}

template <class Check> bool CheckWindowsAssociationSelection(Check check) {
  using V = WindowsOpenVerdict;
  const auto with_own_row = [](const WindowsAssociationFacts &facts) {
    const std::array<WindowsDocumentViewer, 1> rows{WindowsTestViewerRowFor(facts)};
    return windows_open_detail::JudgeAssociationWith(facts, rows);
  };
  // What the resolver returns: GetFinalPathNameByHandleW's "\\?\" form, and the handle's file id.
  WindowsAssociationFacts association;
  association.real_path_verified = true;
  association.real_path = "\\\\?\\C:\\synthetic\\document.txt";
  association.file_id = "0000000000001234:00000000000000000000000000000042";
  association.extension = "txt";
  association.complete = true;
  association.command_key_matches = true;
  association.signature_valid = true;
  association.perceived_type = "text";
  association.prog_id = "Synthetic.Document";
  association.verb = "open";
  association.executable = "C:\\synthetic\\viewer.exe";
  association.command = "\"C:\\synthetic\\viewer.exe\" \"%1\"";
  association.signer_sha256 = std::string(64, 'a');
  // The production table is empty: nothing is verified by it.
  if (!check(JudgeWindowsAssociation(association) == V::kTakeover, "association-unknown-handler")) return false;
  // The synthetic row is reachable, so every negative below fails if its protection is removed.
  if (!check(with_own_row(association) == V::kVerified, "association-test-row-verified")) return false;
  // A row matches the whole tuple, not the executable alone.
  {
    const std::array<WindowsDocumentViewer, 1> rows{WindowsTestViewerRowFor(association)};
    for (int field = 0; field < 7; ++field) {
      auto changed = association;
      if (field == 0) changed.extension = "md";
      if (field == 1) changed.perceived_type = "image";
      if (field == 2) changed.prog_id = "Synthetic.Other";
      if (field == 3) changed.verb = "edit";
      if (field == 4) changed.executable = "C:\\synthetic\\other.exe";
      if (field == 5) changed.command += " /execute";
      if (field == 6) changed.signer_sha256[0] = 'b';
      if (!check(windows_open_detail::JudgeAssociationWith(changed, rows) == V::kTakeover, "association-row-field-mismatch"))
        return false;
    }
  }
  auto ide = association;
  ide.real_path_verified = false;
  ide.real_path.clear();
  if (!check(with_own_row(ide) == V::kTakeover, "association-ide-unknown-real-path")) return false;
  for (const auto extension : {"exe", "msi", "msu", "appinstaller"}) {
    auto changed = association;
    changed.extension = extension;
    // Synthetic RLO display spoof: only the real path extension is authoritative.
    changed.real_path = std::string("\\\\?\\C:\\synthetic\\report-\xe2\x80\xae" "txt.") + extension;
    if (!check(with_own_row(changed) == V::kBlocked, "association-rlo-real-executable")) return false;
  }
  // Each defect alone, with a row built from the defective facts themselves.
  for (int defect = 0; defect < 16; ++defect) {
    auto changed = association;
    if (defect == 0) changed.complete = false;
    if (defect == 1) changed.delegate_execute = true;
    if (defect == 2) changed.drop_target = true;
    if (defect == 3) changed.explorer_command_handler = true;
    if (defect == 4) changed.dde = true;
    if (defect == 5) changed.shell_extension = true;
    if (defect == 6) changed.command_key_matches = false;
    // Not a plain extension (an alternate data stream spelling): unknown, whatever a row says.
    if (defect == 7) changed.extension = "txt:ads";
    if (defect == 8) changed.real_path_verified = false;
    // A shell display path is not a resolved real path.
    if (defect == 9) changed.real_path = "C:\\synthetic\\document.txt";
    if (defect == 10) changed.file_id.clear();
    if (defect == 11) changed.signature_valid = false;
    if (defect == 12) changed.prog_id.clear();
    if (defect == 13) changed.verb.clear();
    if (defect == 14) changed.real_path.clear();
    if (defect == 15) changed.verb_restricted = true;
    if (!check(with_own_row(changed) == V::kTakeover, "association-defect-with-row")) return false;
  }
  for (int defect = 0; defect < 3; ++defect) {
    auto changed = association;
    if (defect == 0) changed.dangerous = true;
    if (defect == 1) changed.perceived_type = "application";
    if (defect == 2) changed.perceived_type = "system";
    if (!check(with_own_row(changed) == V::kBlocked,
               defect == 0 ? "association-dangerous" : "association-application")) return false;
  }

  if (!check(CanonicalWindowsRealPath("\\\\?\\C:\\a\\b.txt") == "C:\\a\\b.txt" &&
                 CanonicalWindowsRealPath("\\\\?\\UNC\\server\\share\\b.txt") == "\\\\server\\share\\b.txt" &&
                 CanonicalWindowsRealPath("C:\\a\\b.txt").empty() &&
                 CanonicalWindowsRealPath("\\\\?\\").empty(), "identity-canonical-form")) return false;

  // The shell's own spelling (SIGDN_FILESYSPATH) differs from the resolver's; both are kept.
  WindowsSingleSelectionFacts selected;
  selected.shell_complete = true;
  selected.uia_complete = true;
  selected.uia_target_matches = true;
  selected.shell_count = 1;
  selected.uia_count = 1;
  selected.shell_paths = {"C:\\synthetic\\document.txt"};
  selected.target_path = "C:\\synthetic\\document.txt";
  selected.target_real_path = association.real_path;
  selected.target_file_id = association.file_id;
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

  const std::array<WindowsDocumentViewer, 1> rows{WindowsTestViewerRowFor(association)};
  WindowsOpenFacts first{EffectClass::kE3FileManagerOpen, association, selected};
  if (!check(JudgeWindowsOpenFacts(first) == V::kTakeover, "open-production-table-empty")) return false;
  if (!check(windows_open_detail::JudgeOpenFactsWith(first, nullptr, rows) == V::kVerified, "open-e3-verified")) return false;
  {
    WindowsOpenFacts e2{EffectClass::kE2DownloadOpen, association, {}};
    if (!check(windows_open_detail::JudgeOpenFactsWith(e2, nullptr, rows) == V::kVerified, "open-e2-association-only")) return false;
  }
  // Only E2 / E3 are opens; the effect, not a caller's flag, decides that E3 checks the selection.
  for (const auto effect : {EffectClass::kUnclassified, EffectClass::kOrdinary, EffectClass::kE1ExecutableOpen,
                            EffectClass::kE4InstallerLaunch}) {
    auto changed = first;
    changed.effect = effect;
    if (!check(windows_open_detail::JudgeOpenFactsWith(changed, nullptr, rows) == V::kTakeover, "open-effect-not-e2-e3")) return false;
  }
  {
    auto changed = first;
    changed.selection = {};
    if (!check(windows_open_detail::JudgeOpenFactsWith(changed, nullptr, rows) == V::kTakeover, "open-e3-requires-selection"))
      return false;
  }
  // The selected file must be the file whose association was measured.
  for (int defect = 0; defect < 6; ++defect) {
    auto changed = first;
    // Unresolved: only the shell spelling, which differs from the "\\?\" form.
    if (defect == 0) changed.selection.target_real_path = changed.selection.target_path;
    // A junction: the shell path goes through C:\link, the association resolved to the target.
    if (defect == 1) {
      changed.association.real_path = "\\\\?\\D:\\target\\document.txt";
      changed.selection.shell_paths = {"C:\\link\\document.txt"};
      changed.selection.target_path = "C:\\link\\document.txt";
      changed.selection.target_real_path = "\\\\?\\C:\\link\\document.txt";
    }
    if (defect == 2) changed.selection.target_file_id = "0000000000001234:00000000000000000000000000000043";
    if (defect == 3) changed.selection.target_file_id.clear();
    if (defect == 4) changed.selection.target_real_path = "\\\\?\\C:\\synthetic\\other.txt";
    // A spelling that differs only in case is not the resolver's spelling of this file: not equal.
    if (defect == 5) changed.selection.target_real_path = "\\\\?\\C:\\SYNTHETIC\\document.txt";
    const std::array<WindowsDocumentViewer, 1> own{WindowsTestViewerRowFor(changed.association)};
    if (!check(windows_open_detail::JudgeOpenFactsWith(changed, nullptr, own) == V::kTakeover, "open-identity-mismatch"))
      return false;
  }
  // E3 requires the single selection by itself: the association is verified by a row and the
  // selected file is the measured one, yet each selection defect alone is takeover for E3, while
  // the very same facts are verified for E2 (which has no selection).
  for (int defect = 0; defect < 5; ++defect) {
    auto changed = first;
    if (defect == 0) {
      changed.selection.shell_count = 2;
      changed.selection.uia_count = 2;
      changed.selection.shell_paths.push_back("C:\\synthetic\\other.txt");
    }
    if (defect == 1) changed.selection.uia_target_matches = false;
    if (defect == 2) changed.selection.uia_complete = false;
    if (defect == 3) changed.selection.shell_complete = false;
    if (defect == 4) changed.selection.shell_paths[0] = "C:\\synthetic\\other.txt";
    if (!check(SameWindowsOpenTarget(changed.association, changed.selection), "open-e3-selection-identity-kept"))
      return false;
    if (!check(windows_open_detail::JudgeOpenFactsWith(changed, nullptr, rows) == V::kTakeover,
               "open-e3-selection-required")) return false;
    changed.effect = EffectClass::kE2DownloadOpen;
    if (!check(windows_open_detail::JudgeOpenFactsWith(changed, nullptr, rows) == V::kVerified,
               "open-e2-selection-not-used")) return false;
  }
  // DDE: a command or a ddeexec key always is; DDEAPPLICATION only with a name other than the
  // handler's stem, which the shell answers by itself.
  if (!check(!WindowsDdeConfigured(false, true, L"viewer", L"C:\\synthetic\\viewer.exe", false) &&
                 !WindowsDdeConfigured(false, false, L"", L"C:\\synthetic\\viewer.exe", false) &&
                 WindowsDdeConfigured(false, true, L"OtherServer", L"C:\\synthetic\\viewer.exe", false) &&
                 WindowsDdeConfigured(true, true, L"viewer", L"C:\\synthetic\\viewer.exe", false) &&
                 WindowsDdeConfigured(false, true, L"viewer", L"C:\\synthetic\\viewer.exe", true) &&
                 WindowsDdeConfigured(false, true, L"Viewer", L"C:\\synthetic\\viewer.exe", false),
             "association-dde-explicit")) return false;
  if (!check(SameWindowsOpenFacts(first, first), "boundary-identical")) return false;
  if (!check(windows_open_detail::JudgeOpenFactsWith(first, &first, rows) == V::kVerified,
             "boundary-identical-verified")) return false;
  // Every field of the boundary digest is in it: changing any one changes the digest.
  {
    using Change = void (*)(WindowsOpenFacts &);
    const Change changes[] = {
        [](WindowsOpenFacts &f) { f.effect = EffectClass::kE2DownloadOpen; },
        [](WindowsOpenFacts &f) { f.association.complete = !f.association.complete; },
        [](WindowsOpenFacts &f) { f.association.real_path_verified = !f.association.real_path_verified; },
        [](WindowsOpenFacts &f) { f.association.dangerous = !f.association.dangerous; },
        [](WindowsOpenFacts &f) { f.association.delegate_execute = !f.association.delegate_execute; },
        [](WindowsOpenFacts &f) { f.association.drop_target = !f.association.drop_target; },
        [](WindowsOpenFacts &f) { f.association.explorer_command_handler = !f.association.explorer_command_handler; },
        [](WindowsOpenFacts &f) { f.association.dde = !f.association.dde; },
        [](WindowsOpenFacts &f) { f.association.shell_extension = !f.association.shell_extension; },
        [](WindowsOpenFacts &f) { f.association.verb_restricted = !f.association.verb_restricted; },
        [](WindowsOpenFacts &f) { f.association.command_key_matches = !f.association.command_key_matches; },
        [](WindowsOpenFacts &f) { f.association.signature_valid = !f.association.signature_valid; },
        [](WindowsOpenFacts &f) { f.association.real_path += "x"; },
        [](WindowsOpenFacts &f) { f.association.file_id += "0"; },
        [](WindowsOpenFacts &f) { f.association.extension = "md"; },
        [](WindowsOpenFacts &f) { f.association.perceived_type = "image"; },
        [](WindowsOpenFacts &f) { f.association.user_choice = "Synthetic.Changed"; },
        [](WindowsOpenFacts &f) { f.association.prog_id += "2"; },
        [](WindowsOpenFacts &f) { f.association.verb = "edit"; },
        [](WindowsOpenFacts &f) { f.association.executable += "x"; },
        [](WindowsOpenFacts &f) { f.association.command += " "; },
        [](WindowsOpenFacts &f) { f.association.signer_sha256[0] = 'b'; },
        [](WindowsOpenFacts &f) { f.selection.shell_complete = !f.selection.shell_complete; },
        [](WindowsOpenFacts &f) { f.selection.uia_complete = !f.selection.uia_complete; },
        [](WindowsOpenFacts &f) { f.selection.uia_target_matches = !f.selection.uia_target_matches; },
        [](WindowsOpenFacts &f) { f.selection.shell_count += 1; },
        [](WindowsOpenFacts &f) { f.selection.uia_count += 1; },
        [](WindowsOpenFacts &f) { f.selection.target_path += "x"; },
        [](WindowsOpenFacts &f) { f.selection.target_real_path += "x"; },
        [](WindowsOpenFacts &f) { f.selection.target_file_id += "0"; },
        [](WindowsOpenFacts &f) { f.selection.shell_paths.push_back("C:\\synthetic\\other.txt"); },
        [](WindowsOpenFacts &f) { f.selection.shell_paths[0] += "x"; },
    };
    for (const auto change : changes) {
      auto changed = first;
      change(changed);
      if (!check(!SameWindowsOpenFacts(first, changed), "boundary-digest-field")) return false;
    }
  }
  for (int defect = 0; defect < 8; ++defect) {
    auto changed = first;
    if (defect == 0) changed.association.command += " /execute";
    if (defect == 1) changed.association.user_choice = "Synthetic.Changed";
    if (defect == 2) changed.association.signer_sha256[0] = 'b';
    if (defect == 3) changed.selection.shell_paths[0] = "C:\\synthetic\\other.txt";
    if (defect == 4) changed.selection.shell_count = 2;
    if (defect == 5) changed.association.file_id[0] = '1';
    if (defect == 6) changed.selection.target_real_path += "x";
    if (defect == 7) changed.effect = EffectClass::kE2DownloadOpen;
    if (!check(!SameWindowsOpenFacts(first, changed), "boundary-changed-takeover")) return false;
    // A row for the changed facts exists, so only the boundary comparison refuses them.
    const std::array<WindowsDocumentViewer, 1> own{WindowsTestViewerRowFor(changed.association)};
    if (!check(windows_open_detail::JudgeOpenFactsWith(changed, &first, own) == V::kTakeover,
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
