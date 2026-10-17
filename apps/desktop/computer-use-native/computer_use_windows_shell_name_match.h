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
//     localized "Documents"). Both kinds count together toward kShellMaxCandidates. The CALLER
//     must not cut the list at the cap and match what is left: the moment it finds one more entry
//     than the cap it gives up and the whole lookup is "not known" (ShadowReadResult::kAbsent in
//     the caller's terms; this header defines no such result, and kNoShellMatch below is its
//     counterpart for a match that is not made). MatchShellDisplayName
//     repeats that rule for its own input: a list longer than the cap (the caller's one-past-the-cap
//     case, were it ever passed in) is "not known" too, never matched; and
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
  bool renamable_directory = false; // a read-only / system directory: its desktop.ini can name it
  std::wstring shell_name; // the name the shell shows for it (valid when shell_name_known)
  bool shell_name_known = false;
  // A link (a name surrogate: symbolic link or mount point) whose target is not known to be a local disk:
  // its shell name is never asked for. A match is never made while one is among the candidates.
  bool is_link = false;
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
// name does (compared with equals: case-blind), and so does a directory that is read-only or system
// whatever its name, because a desktop.ini inside it can show it under another name.
[[nodiscard]] inline bool ShellEntryNeedsShellName(std::wstring_view name, bool is_directory,
                                                   bool readonly_or_system,
                                                   std::wstring_view display,
                                                   ShellNameEquals equals = ShellNameEqualsAsciiFold) {
  if (name == L"." || name == L".." || equals == nullptr) return false;
  if (name.size() >= display.size() && equals(name.substr(0, display.size()), display)) return true;
  return is_directory && readonly_or_system;
}

// The Win32 values the folder checks below read (kept here so the rules stay pure).
constexpr unsigned long kShellErrorFileNotFound = 2;
constexpr unsigned long kShellErrorPathNotFound = 3;
constexpr unsigned long kShellAttributeReadOnly = 0x1;
constexpr unsigned long kShellAttributeSystem = 0x4;
constexpr unsigned long kShellReparseTagMountPoint = 0xA0000003;
constexpr unsigned long kShellReparseTagSymlink = 0xA000000C;
// Bit 29 of a reparse tag says the entry NAMES ANOTHER FILE SYSTEM OBJECT (IsReparseTagNameSurrogate):
// a symbolic link, a mount point, and any other tag of that kind. A cloud file's tag does not have it.
constexpr unsigned long kShellReparseNameSurrogate = 0x20000000;

// Whether a directory entry is a link: a reparse point that names another object. Reading the shell's
// name for it would touch what it points to, which can be a network or optical location. Any other
// reparse point (a cloud file's tag, for one) is not a link in this sense. The tag is only meaningful
// when the entry IS a reparse point (the listing leaves it undefined otherwise).
[[nodiscard]] inline bool ShellReparseIsLink(bool is_reparse_point, unsigned long tag) {
  return is_reparse_point && (tag & kShellReparseNameSurrogate) != 0;
}

[[nodiscard]] inline bool ShellReparseIsMountPoint(bool is_reparse_point, unsigned long tag) {
  return is_reparse_point && tag == kShellReparseTagMountPoint;
}

// The substitute name (the target) in the bytes FSCTL_GET_REPARSE_POINT returned for a mount point
// (a junction): tag, data length, reserved, then the offsets and lengths of the substitute and the print
// name, then the path buffer. False for anything that is not a well-formed mount point buffer.
[[nodiscard]] inline bool ShellMountPointSubstituteName(const unsigned char *bytes, std::size_t size,
                                                        std::wstring *name) {
  if (bytes == nullptr || name == nullptr || size < 16) return false;
  const auto word = [&](std::size_t at) { return static_cast<unsigned>(bytes[at]) | (static_cast<unsigned>(bytes[at + 1]) << 8); };
  const unsigned long tag = static_cast<unsigned long>(word(0)) | (static_cast<unsigned long>(word(2)) << 16);
  if (tag != kShellReparseTagMountPoint) return false;
  const std::size_t offset = word(8);
  const std::size_t length = word(10);
  const std::size_t begin = 16 + offset;
  if ((length & 1u) != 0 || begin > size || length > size - begin) return false;
  name->clear();
  for (std::size_t at = begin; at < begin + length; at += 2)
    name->push_back(static_cast<wchar_t>(word(at)));
  return true;
}

// The drive letter of a mount point target of the form "\??\X:" or "\??\X:\...", else 0. A target such as
// "\??\Volume{guid}\" names a volume and not a drive letter: it is not a local drive for our purpose.
[[nodiscard]] inline wchar_t ShellLocalDriveLetterOfSubstituteName(std::wstring_view substitute) {
  constexpr std::wstring_view kPrefix = L"\\??\\";
  if (substitute.size() < kPrefix.size() + 2 || substitute.substr(0, kPrefix.size()) != kPrefix) return 0;
  const wchar_t letter = substitute[kPrefix.size()];
  const bool alpha = (letter >= L'A' && letter <= L'Z') || (letter >= L'a' && letter <= L'z');
  if (!alpha || substitute[kPrefix.size() + 1] != L':') return 0;
  if (substitute.size() > kPrefix.size() + 2 && substitute[kPrefix.size() + 2] != L'\\') return 0;
  return letter;
}

// A directory path ready to have a name appended: trailing separators are dropped (except the one of a
// drive root) and exactly one is put at the end. "C:\" stays "C:\" (it must not become "C:\\", which no
// shell call accepts: every candidate of a drive root would be unknown), "C:\Windows" and
// "C:\Windows\" both become "C:\Windows\".
[[nodiscard]] inline std::wstring ShellDirectoryWithSeparator(std::wstring path) {
  while (path.size() > 3 && path.back() == L'\\') path.pop_back();
  if (path.empty() || path.back() != L'\\') path.push_back(L'\\');
  return path;
}

// The target of a mount point as an ordinary path ("C:\redirect\subdir"), from a substitute name of the form
// "\??\C:\redirect\subdir" (or "\??\C:"); empty for any other form. The parts of this path are looked at
// one by one, from the root of the drive, before the mount point is let through.
[[nodiscard]] inline std::wstring ShellMountTargetPath(std::wstring_view substitute) {
  if (ShellLocalDriveLetterOfSubstituteName(substitute) == 0) return std::wstring();
  std::wstring path(substitute.substr(4));
  if (path.size() == 2) path.push_back(L'\\');
  return path;
}

// The most of a desktop.ini that is read (a real one is a few hundred bytes); a bigger file is a yes.
constexpr std::size_t kShellDesktopIniMaxBytes = 64 * 1024;

namespace shell_desktop_ini_detail {

[[nodiscard]] inline bool IsBlank(wchar_t c) { return c == L' ' || c == L'\t'; }

[[nodiscard]] inline std::wstring_view Trim(std::wstring_view text) {
  while (!text.empty() && IsBlank(text.front())) text.remove_prefix(1);
  while (!text.empty() && IsBlank(text.back())) text.remove_suffix(1);
  return text;
}

struct IniEntry {
  std::wstring section; // the section the line is in (empty before any header)
  std::wstring key;     // the text before '=' (the whole line when there is none)
  std::wstring value;   // the text after '='
};

// The lines of a desktop.ini that are not blank, not a comment and not a header, each with its section.
// The bytes are UTF-16 LE or BE with a byte order mark, or else single-byte text (ANSI / UTF-8 with or
// without its mark; only ASCII matters to the rules, and a character above 127 is just a character).
// False when the text cannot be judged (fail-closed for every caller): longer than
// kShellDesktopIniMaxBytes, UTF-16 with an odd number of bytes, a NUL in single-byte text (a UTF-16
// file without its mark), and a line that opens a header but does not close it.
[[nodiscard]] inline bool ParseIni(const unsigned char *bytes, std::size_t size, std::vector<IniEntry> *entries) {
  if (size > kShellDesktopIniMaxBytes) return false;
  if (size != 0 && bytes == nullptr) return false;
  std::wstring text;
  text.reserve(size);
  std::size_t at = 0;
  bool wide = false;
  bool big_endian = false;
  if (size >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE) {
    wide = true;
    at = 2;
  } else if (size >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF) {
    wide = true;
    big_endian = true;
    at = 2;
  } else if (size >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF) {
    at = 3;
  }
  if (wide) {
    if (((size - at) & 1u) != 0) return false;
    for (; at + 1 < size; at += 2) {
      const unsigned lo = big_endian ? bytes[at + 1] : bytes[at];
      const unsigned hi = big_endian ? bytes[at] : bytes[at + 1];
      text.push_back(static_cast<wchar_t>((hi << 8) | lo));
    }
  } else {
    for (; at < size; ++at) {
      if (bytes[at] == 0) return false;
      text.push_back(static_cast<wchar_t>(bytes[at]));
    }
  }
  std::wstring section;
  std::size_t line_begin = 0;
  while (line_begin <= text.size()) {
    std::size_t line_end = text.find_first_of(L"\r\n", line_begin);
    if (line_end == std::wstring::npos) line_end = text.size();
    const std::wstring_view line = Trim(std::wstring_view(text).substr(line_begin, line_end - line_begin));
    line_begin = line_end + 1;
    if (line.empty() || line.front() == L';') continue;
    if (line.front() == L'[') {
      const std::size_t close = line.find(L']');
      if (close == std::wstring_view::npos) return false; // a header that never closes: not known
      section = std::wstring(Trim(line.substr(1, close - 1)));
      continue;
    }
    IniEntry entry;
    entry.section = section;
    const std::size_t equals = line.find(L'=');
    if (equals == std::wstring_view::npos) {
      entry.key = std::wstring(line);
    } else {
      entry.key = std::wstring(Trim(line.substr(0, equals)));
      entry.value = std::wstring(Trim(line.substr(equals + 1)));
    }
    entries->push_back(std::move(entry));
  }
  return true;
}

[[nodiscard]] inline bool SameName(std::wstring_view left, std::wstring_view right) {
  return ShellNameEqualsAsciiFold(left, right);
}

} // namespace shell_desktop_ini_detail

// Whether the TEXT of a desktop.ini has a [LocalizedFileNames] section that is not empty (a section is
// empty when no line between its header and the next header is anything but blank or a comment, a line
// that starts with ';'). The section name is compared without regard to case. Text that cannot be
// judged (see ParseIni) is a YES.
[[nodiscard]] inline bool ShellDesktopIniTextHasLocalizedFileNames(const unsigned char *bytes,
                                                                   std::size_t size) {
  std::vector<shell_desktop_ini_detail::IniEntry> entries;
  if (!shell_desktop_ini_detail::ParseIni(bytes, size, &entries)) return true;
  for (const auto &entry : entries)
    if (shell_desktop_ini_detail::SameName(entry.section, L"LocalizedFileNames")) return true;
  return false;
}

using ShellDriveIsLocal = bool (*)(wchar_t);

// Whether a value from a desktop.ini is SAFE for the shell to be given: an ALLOW-list. The shell reads
// these values with GetPrivateProfileStringW, which removes one pair of surrounding quotes (' or ", the
// same at both ends), so that is removed here first, and the blanks. What is left is safe only if it is
//  (a) plain text: none of the characters  \ / : % @ ,  (a title, a tip); or
//  (b) a path under a system variable, optionally with a leading '@' (a resource reference) and
//      optionally a resource suffix ",-N" or ",N": it starts with %SystemRoot%, %windir%,
//      %ProgramFiles%, %ProgramFiles(x86)% or %CommonProgramFiles% (followed by '\'); and the rest has no
//      '/', no doubled '\' (so no UNC and no "\\?\" or "\\.\" form), no "..", and no other '%'.
// Everything else is NOT safe: a path that starts with a drive letter (even a local one: a part of it
// can be a symbolic link to the network), a relative path, a UNC or device path, a URL, an unknown
// variable, a malformed suffix. A KNOWN LIMIT: the folder a system variable expands to could itself
// hold a link; that is not looked at.
[[nodiscard]] inline bool ShellIniValueIsSafe(std::wstring_view value) {
  using shell_desktop_ini_detail::SameName;
  using shell_desktop_ini_detail::Trim;
  value = Trim(value);
  if (value.size() >= 2 && (value.front() == L'"' || value.front() == L'\'') && value.back() == value.front())
    value = Trim(value.substr(1, value.size() - 2));
  if (value.find_first_of(L"\\/:%@,") == std::wstring_view::npos) return true; // (a) plain text
  if (!value.empty() && value.front() == L'@') value.remove_prefix(1);
  // The resource suffix: ",-N" or ",N". A comma that is not that is not safe.
  const std::size_t comma = value.find(L',');
  if (comma != std::wstring_view::npos) {
    std::wstring_view tail = value.substr(comma + 1);
    if (!tail.empty() && tail.front() == L'-') tail.remove_prefix(1);
    if (tail.empty() || tail.find_first_not_of(L"0123456789") != std::wstring_view::npos) return false;
    value = value.substr(0, comma);
  }
  if (value.find(L'/') != std::wstring_view::npos || value.find(L"\\\\") != std::wstring_view::npos ||
      value.find(L"..") != std::wstring_view::npos || value.find(L',') != std::wstring_view::npos ||
      value.find(L'@') != std::wstring_view::npos)
    return false;
  // The start: a known system variable followed by '\', or a local drive letter followed by ":\".
  for (const std::wstring_view variable :
       {std::wstring_view(L"%SystemRoot%"), std::wstring_view(L"%windir%"), std::wstring_view(L"%ProgramFiles%"),
        std::wstring_view(L"%ProgramFiles(x86)%"), std::wstring_view(L"%CommonProgramFiles%")}) {
    if (value.size() > variable.size() && SameName(value.substr(0, variable.size()), variable)) {
      if (value[variable.size()] != L'\\') return false;
      return value.substr(variable.size()).find(L'%') == std::wstring_view::npos;
    }
  }
  return false; // a drive letter, an unknown variable, a relative path: not safe
}

[[nodiscard]] inline bool ShellIniValueIsRisky(std::wstring_view value) {
  return !ShellIniValueIsSafe(value);
}

// Whether a candidate FOLDER's desktop.ini could make the shell's name for it reach somewhere that is not
// a local disk. The shell reads that file to name a read-only / system folder: the keys
// LocalizedResourceName, IconResource, IconFile, InfoTip (and the logo / icon-area keys) of
// [.ShellClassInfo] can refer to a module or a file ("@\\server\share\x.dll,-1" loads a library from the
// network), and CLSID / CLSID2 / UICLSID can bind a namespace extension: a value that is not SAFE
// (ShellIniValueIsSafe: an allow-list), and any CLSID key at all, is a YES. Text that cannot be judged
// is a YES.
[[nodiscard]] inline bool ShellDesktopIniTextIsRiskyForShellName(const unsigned char *bytes,
                                                                 std::size_t size) {
  using shell_desktop_ini_detail::SameName;
  std::vector<shell_desktop_ini_detail::IniEntry> entries;
  if (!shell_desktop_ini_detail::ParseIni(bytes, size, &entries)) return true;
  for (const auto &entry : entries) {
    if (!SameName(entry.section, L".ShellClassInfo")) continue;
    if (SameName(entry.key, L"CLSID") || SameName(entry.key, L"CLSID2") || SameName(entry.key, L"UICLSID"))
      return true;
    for (const std::wstring_view key :
         {std::wstring_view(L"LocalizedResourceName"), std::wstring_view(L"IconResource"),
          std::wstring_view(L"IconFile"), std::wstring_view(L"InfoTip"), std::wstring_view(L"Logo"),
          std::wstring_view(L"WideLogo"), std::wstring_view(L"IconArea_Image"),
          std::wstring_view(L"PersonalizedName")})
      if (SameName(entry.key, key) && ShellIniValueIsRisky(entry.value)) return true;
  }
  return false;
}

// Whether a folder's desktop.ini means that its files can be shown under names with no relation to
// their file names (a non-empty [LocalizedFileNames] section). The shell honours that section only
// for a folder that is read-only or system (checked on this machine: the same desktop.ini changes no
// name in a plain folder), so a folder without those attributes is not read at all. A desktop.ini
// is normal (a user's home has one): its existence is not a yes. What cannot be known is a yes
// (fail-closed): the folder's attributes, a lookup that failed for another reason than "not there",
// a desktop.ini that is itself a reparse point of ANY kind (it is opened as the link itself, never
// followed, to a place that can be on the network), and content that cannot be read or judged
// (content_says_localized is the verdict of ShellDesktopIniTextHasLocalizedFileNames, or true when
// the bytes could not be had).
[[nodiscard]] inline bool ShellDesktopIniLocalizesFileNames(bool folder_attributes_known,
                                                            unsigned long folder_attributes,
                                                            bool file_opened,
                                                            unsigned long open_error,
                                                            bool file_is_reparse_point,
                                                            bool content_says_localized) {
  if (!folder_attributes_known) return true;
  if ((folder_attributes & (kShellAttributeReadOnly | kShellAttributeSystem)) == 0) return false;
  if (!file_opened)
    return !(open_error == kShellErrorFileNotFound || open_error == kShellErrorPathNotFound);
  if (file_is_reparse_point) return true;
  return content_says_localized;
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
    if (candidates[i].is_link) return kNoShellMatch;
    if (!candidates[i].shell_name_known) return kNoShellMatch;
    if (!equals(candidates[i].shell_name, display)) continue;
    if (found != kNoShellMatch) return kNoShellMatch; // two entries: which one was meant is not known
    found = i;
  }
  return found;
}

} // namespace sprint_coder::computer_use
