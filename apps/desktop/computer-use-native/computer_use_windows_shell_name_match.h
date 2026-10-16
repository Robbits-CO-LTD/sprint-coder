#pragma once

// The match of a file browser's DISPLAY name to the real directory entry (S5-c-2 PR-3). Portable and
// pure: no platform header, no clock, no I/O, no thread.
//
// UI Automation publishes only what Explorer SHOWS: "report" for "report.pdf" when known extensions
// are hidden. The real name is found by listing the folder's entries whose names START WITH the
// display name (the caller does that, in its own process, bounded) and asking this function which
// entry the display name stands for. The answer is an entry only when it is the ONLY one the display
// name can stand for; otherwise it is "not known" (kNoShellMatch), never a guess:
//
//  - the entry is named exactly like the display name; or
//  - the entry is the display name + "." + ONE extension (no further dot), where the extension is
//    hidden by Explorer: with extensions hidden (extensions_shown == false) any extension may be
//    hidden, and with extensions shown only the ones Explorer hides for good (.lnk, .url, .pif, .scf,
//    .shb, .appref-ms, .library-ms) may be.
//
// Names are compared as Explorer's file system does, case-insensitively and ordinally, by the
// function the caller passes (the host passes one built on CompareStringOrdinal); the default folds
// ASCII only. A candidate is the entry's LONG name: an entry that only its 8.3 alternate name matched
// is dropped by this comparison, because the long name is what is compared. More candidates than
// kShellMaxCandidates (the caller stops collecting one past it) is "not known".

#include <cstddef>
#include <string>
#include <string_view>
#include <vector>

namespace sprint_coder::computer_use {

struct ShellNameCandidate {
  std::wstring name; // the entry's long name, as the file system has it
  bool is_directory = false;
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

// The extensions Explorer never shows, whatever the setting.
[[nodiscard]] inline bool ShellExtensionAlwaysHidden(std::wstring_view extension,
                                                     ShellNameEquals equals) {
  for (const std::wstring_view hidden : {std::wstring_view(L"lnk"), std::wstring_view(L"url"),
                                         std::wstring_view(L"pif"), std::wstring_view(L"scf"),
                                         std::wstring_view(L"shb"), std::wstring_view(L"appref-ms"),
                                         std::wstring_view(L"library-ms")})
    if (equals(extension, hidden)) return true;
  return false;
}

// A display name that cannot be a file name (it holds a wildcard or a separator) matches nothing.
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
    bool extensions_shown, ShellNameEquals equals = ShellNameEqualsAsciiFold) {
  if (!ShellDisplayNameUsable(display) || candidates.empty() ||
      candidates.size() > kShellMaxCandidates || equals == nullptr)
    return kNoShellMatch;
  std::size_t found = kNoShellMatch;
  for (std::size_t i = 0; i < candidates.size(); ++i) {
    const std::wstring_view name = candidates[i].name;
    bool stands_for = false;
    if (equals(name, display)) {
      stands_for = true;
    } else if (name.size() > display.size() + 1 && name[display.size()] == L'.' &&
               equals(name.substr(0, display.size()), display)) {
      const std::wstring_view extension = name.substr(display.size() + 1);
      if (extension.find(L'.') == std::wstring_view::npos)
        stands_for = !extensions_shown || ShellExtensionAlwaysHidden(extension, equals);
    }
    if (!stands_for) continue;
    if (found != kNoShellMatch) return kNoShellMatch; // two entries: which one was meant is not known
    found = i;
  }
  return found;
}

} // namespace sprint_coder::computer_use
