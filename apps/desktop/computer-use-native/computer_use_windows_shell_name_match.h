#pragma once

// The match of a file browser's DISPLAY name to the real directory entry (S5-c-2 PR-3). Portable and
// pure: no platform header, no clock, no I/O, no thread.
//
// UI Automation publishes only what Explorer SHOWS: "report" for "report.pdf" when known extensions
// are hidden. The real file is found in two steps:
//
//  1. the caller lists the folder's entries whose names START WITH the display name (bounded, at most
//     kShellMaxCandidates), only to narrow the field; and
//  2. for EVERY candidate the caller asks the SHELL for the name it shows (the same name Explorer
//     shows, whatever hides an extension: the user's setting, an extension that is never shown,
//     a folder with a dot in its name), and this function decides which candidate the display name
//     stands for. No rule about extensions lives here: the shell's own answer is compared.
//
// The answer is an entry only when it is the ONLY candidate whose shell name equals the display name.
// It is "not known" (kNoShellMatch), never a guess, when no candidate does, when two or more do, when
// there are more candidates than the cap, or when the shell name of ANY candidate could not be read
// (a candidate that could not be read might be the one, or a second one).
//
// Names are compared as the file system does, case-insensitively and ordinally, by the function the
// caller passes (the host passes one built on CompareStringOrdinal); the default folds ASCII only.

#include <cstddef>
#include <string>
#include <string_view>
#include <vector>

namespace sprint_coder::computer_use {

struct ShellNameCandidate {
  std::wstring name; // the entry's long name, as the file system has it
  bool is_directory = false;
  std::wstring shell_name; // the name the shell shows for it (valid when shell_name_known)
  bool shell_name_known = false;
};

constexpr std::size_t kShellMaxCandidates = 64;
constexpr std::size_t kNoShellMatch = static_cast<std::size_t>(-1);

using ShellNameEquals = bool (*)(std::wstring_view, std::wstring_view);

[[nodiscard]] inline bool ShellNameEqualsAsciiFold(std::wstring_view left, std::wstring_view right) {
  if (left.size() != right.size()) return false;
  for (std::size_t i = 0; i < left.size(); ++i) {
    wchar_t a = left[i];
    wchar_t b = right[i];
    if (a >= L'A' && a <= L'Z') a = static_cast<wchar_t>(a - L'A' + L'a');
    if (b >= L'A' && b <= L'Z') b = static_cast<wchar_t>(b - L'A' + L'a');
    if (a != b) return false;
  }
  return true;
}

// A display name that cannot be a file name (it holds a wildcard or a separator) matches nothing, and
// is never used to build a search pattern.
[[nodiscard]] inline bool ShellDisplayNameUsable(std::wstring_view display) {
  if (display.empty()) return false;
  for (const wchar_t c : display)
    if (c == L'*' || c == L'?' || c == L'<' || c == L'>' || c == L'"' || c == L'|' || c == L'/' ||
        c == L'\\' || c == L':' || c < 0x20)
      return false;
  return true;
}

// The index of the one candidate the display name stands for, or kNoShellMatch.
[[nodiscard]] inline std::size_t MatchShellDisplayName(
    std::wstring_view display, const std::vector<ShellNameCandidate> &candidates,
    ShellNameEquals equals = ShellNameEqualsAsciiFold) {
  if (!ShellDisplayNameUsable(display) || candidates.empty() ||
      candidates.size() > kShellMaxCandidates || equals == nullptr)
    return kNoShellMatch;
  std::size_t found = kNoShellMatch;
  for (std::size_t i = 0; i < candidates.size(); ++i) {
    // A candidate whose shell name is not known could be the one, or a second one.
    if (!candidates[i].shell_name_known) return kNoShellMatch;
    if (!equals(candidates[i].shell_name, display)) continue;
    if (found != kNoShellMatch) return kNoShellMatch; // two entries: which one was meant is not known
    found = i;
  }
  return found;
}

} // namespace sprint_coder::computer_use
