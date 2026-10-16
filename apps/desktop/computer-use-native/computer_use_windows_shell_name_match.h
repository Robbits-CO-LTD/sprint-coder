#pragma once

// The match of a file browser's DISPLAY name to the real directory entry (S5-c-2 PR-3). Portable and
// pure: no platform header, no clock, no I/O, no thread.
//
// UI Automation publishes only what Explorer SHOWS: "report" for "report.pdf" when known extensions
// are hidden. The real file is found in two steps:
//
//  1. the caller lists the folder ONCE and keeps, only to narrow the field, the entries that can carry
//     the display name (ShellEntryNeedsShellName): those whose file name STARTS WITH it, and the
//     directories that are read-only or system (a desktop.ini can give only those another name, as a
//     localized "Documents"). At most kShellMaxCandidates are kept, both kinds counted together; and
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

// Whether a directory entry can carry the display name and so needs the name the shell shows for it
// (the pure rule of step 1). "." and ".." never do. An entry whose file name starts with the display
// name does (compared with `equals`: case-blind), and so does a directory that is read-only or system
// whatever its name, because a desktop.ini inside it can show it under another name.
[[nodiscard]] inline bool ShellEntryNeedsShellName(std::wstring_view name, bool is_directory,
                                                   bool readonly_or_system,
                                                   std::wstring_view display,
                                                   ShellNameEquals equals = ShellNameEqualsAsciiFold) {
  if (name == L"." || name == L".." || equals == nullptr) return false;
  if (name.size() >= display.size() && equals(name.substr(0, display.size()), display)) return true;
  return is_directory && readonly_or_system;
}

// The Win32 error numbers the folder checks below read (kept here so the rule stays pure).
constexpr unsigned long kShellErrorFileNotFound = 2;
constexpr unsigned long kShellErrorPathNotFound = 3;

// Whether a folder's desktop.ini means that its files can be shown under names with no relation to
// their file names (a non-empty [LocalizedFileNames] section). A desktop.ini is normal (a user's home
// has one), so its existence is not a yes; but what cannot be known is: a desktop.ini that cannot be
// looked up for another reason than "not there", and a section that cannot be read. Inputs: whether
// the file was found (and the error of that lookup if not), and the length the profile API returned
// for the section (and its error).
[[nodiscard]] inline bool ShellDesktopIniLocalizesFileNames(bool file_found,
                                                            unsigned long lookup_error,
                                                            std::size_t section_length,
                                                            unsigned long section_error) {
  if (!file_found)
    return !(lookup_error == kShellErrorFileNotFound || lookup_error == kShellErrorPathNotFound);
  if (section_length != 0) return true;
  return section_error != 0 && section_error != kShellErrorFileNotFound;
}

// The last part of a file system path (what follows the last separator; a trailing separator is
// ignored). The shell item a candidate's path resolved to is identified by the leaf of its FILE SYSTEM
// path: its relative parsing name would be a GUID for a known folder ("Documents" of a user's home).
[[nodiscard]] inline std::wstring_view ShellLeafName(std::wstring_view path) {
  while (!path.empty() && path.back() == L'\\') path.remove_suffix(1);
  const std::size_t at = path.find_last_of(L'\\');
  return at == std::wstring_view::npos ? path : path.substr(at + 1);
}

// Whether the shell item that a candidate's path resolved to IS that candidate. Win32 normalizes a
// path: a name that ends in a dot or a space resolves to the entry without them, which is another
// entry. Such a name is never taken as resolved; any other must come back with exactly its own name.
[[nodiscard]] inline bool ShellResolvedNameIsTheCandidate(std::wstring_view candidate_name,
                                                          std::wstring_view resolved_name,
                                                          ShellNameEquals equals = ShellNameEqualsAsciiFold) {
  if (candidate_name.empty() || equals == nullptr) return false;
  if (candidate_name.back() == L'.' || candidate_name.back() == L' ') return false;
  return equals(candidate_name, resolved_name);
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
