#pragma once

// The portable parts of the Windows target facts (S5-c-3, #500 PR-2). The Windows host measures a
// target through handles (the `windows target facts` block of computer_use_windows_host.cc) and
// leaves to this header what needs no platform API: where a canonical path lies among the roots,
// the leaf, the PE subsystem, the manifest's execution level, OriginalFilename out of a
// VS_VERSIONINFO resource, and the descendants of a process in a snapshot. No platform header, so
// MSVC (/W4 /sdl) and clang both compile it, and the target eligibility harness checks it.
//
// Every reader here fails closed: bytes it cannot read give std::nullopt (the core then answers
// unresolvable), never a value that would admit.

#include "computer_use_target_eligibility.h"

#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace sprint_coder::computer_use {

// A root the host measured (a canonical directory, UTF-8, without a trailing separator) and the
// imageRoot value of what lies under it. The host passes the roots in precedence order: the first
// root a path lies under names it.
struct WindowsImageRootPrefix {
  std::string_view root;
  std::string prefix;
};

struct WindowsImagePlacement {
  std::string root;
  std::string relative_path;
};

namespace windows_target_facts_detail {

[[nodiscard]] constexpr char AsciiFold(char letter) {
  return letter >= 'A' && letter <= 'Z' ? static_cast<char>(letter - 'A' + 'a') : letter;
}

[[nodiscard]] constexpr bool IsSeparator(char letter) { return letter == '\\' || letter == '/'; }

[[nodiscard]] inline std::uint32_t ReadLe(std::span<const std::uint8_t> bytes, std::size_t at,
                                          std::size_t width) {
  std::uint32_t value = 0;
  for (std::size_t index = 0; index < width; ++index)
    value |= static_cast<std::uint32_t>(bytes[at + index]) << (8 * index);
  return value;
}

// UTF-16LE code units to UTF-8; an unpaired surrogate gives std::nullopt.
[[nodiscard]] inline std::optional<std::string> Utf8FromUtf16(std::span<const char16_t> units) {
  std::string output;
  output.reserve(units.size());
  for (std::size_t index = 0; index < units.size(); ++index) {
    std::uint32_t code = units[index];
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= units.size() || units[index + 1] < 0xdc00 || units[index + 1] > 0xdfff)
        return std::nullopt;
      code = 0x10000 + ((code - 0xd800) << 10) + (units[++index] - 0xdc00);
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return std::nullopt;
    }
    if (code < 0x80) {
      output += static_cast<char>(code);
    } else if (code < 0x800) {
      output += static_cast<char>(0xc0 | (code >> 6));
      output += static_cast<char>(0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      output += static_cast<char>(0xe0 | (code >> 12));
      output += static_cast<char>(0x80 | ((code >> 6) & 0x3f));
      output += static_cast<char>(0x80 | (code & 0x3f));
    } else {
      output += static_cast<char>(0xf0 | (code >> 18));
      output += static_cast<char>(0x80 | ((code >> 12) & 0x3f));
      output += static_cast<char>(0x80 | ((code >> 6) & 0x3f));
      output += static_cast<char>(0x80 | (code & 0x3f));
    }
  }
  return output;
}

// The NUL-terminated UTF-16 string at `at` (inside `end`), as code units, and where it ends.
[[nodiscard]] inline std::optional<std::vector<char16_t>>
ReadUtf16z(std::span<const std::uint8_t> bytes, std::size_t at, std::size_t end,
           std::size_t *after) {
  std::vector<char16_t> units;
  for (std::size_t cursor = at; cursor + 1 < end; cursor += 2) {
    const auto unit = static_cast<char16_t>(ReadLe(bytes, cursor, 2));
    if (unit == 0) {
      *after = cursor + 2;
      return units;
    }
    units.push_back(unit);
  }
  return std::nullopt;
}

[[nodiscard]] constexpr std::size_t Align4(std::size_t offset) {
  return (offset + 3) & ~std::size_t{3};
}

[[nodiscard]] inline bool UnitsEqual(const std::vector<char16_t> &units, std::string_view ascii) {
  if (units.size() != ascii.size()) return false;
  for (std::size_t index = 0; index < units.size(); ++index)
    if (units[index] != static_cast<unsigned char>(ascii[index])) return false;
  return true;
}

// One VS_VERSIONINFO-style block: wLength, wValueLength, wType, szKey, padding, value, children.
struct VersionBlock {
  std::size_t begin = 0;
  std::size_t end = 0;
  std::size_t value_length = 0;
  bool text = false;
  std::vector<char16_t> key;
  std::size_t value = 0;
};

[[nodiscard]] inline std::optional<VersionBlock>
ReadVersionBlock(std::span<const std::uint8_t> bytes, std::size_t at, std::size_t limit) {
  if (at + 6 > limit) return std::nullopt;
  VersionBlock block;
  block.begin = at;
  const std::size_t length = ReadLe(bytes, at, 2);
  if (length < 6 || at + length > limit) return std::nullopt;
  block.end = at + length;
  block.value_length = ReadLe(bytes, at + 2, 2);
  const std::uint32_t type = ReadLe(bytes, at + 4, 2);
  if (type > 1) return std::nullopt;
  block.text = type == 1;
  std::size_t after = 0;
  std::optional<std::vector<char16_t>> key = ReadUtf16z(bytes, at + 6, block.end, &after);
  if (!key.has_value()) return std::nullopt;
  block.key = std::move(*key);
  block.value = Align4(after);
  if (block.value > block.end) return std::nullopt;
  return block;
}

} // namespace windows_target_facts_detail

// True when `path` lies strictly under the directory `prefix` (ASCII case is folded: both come
// from GetFinalPathNameByHandleW, which spells every component as the volume stores it).
[[nodiscard]] inline bool WindowsPathIsUnder(std::string_view path, std::string_view prefix) {
  using namespace windows_target_facts_detail;
  while (!prefix.empty() && IsSeparator(prefix.back())) prefix.remove_suffix(1);
  if (prefix.empty() || path.size() <= prefix.size() + 1 || !IsSeparator(path[prefix.size()]))
    return false;
  for (std::size_t index = 0; index < prefix.size(); ++index) {
    const char left = path[index];
    const char right = prefix[index];
    if (IsSeparator(left) && IsSeparator(right)) continue;
    if (AsciiFold(left) != AsciiFold(right)) return false;
  }
  return true;
}

// The root a canonical path lies under (the first in `roots`), and the path below it. A path
// under none of them is "other", and its relative path is the whole path.
[[nodiscard]] inline WindowsImagePlacement
PlaceWindowsImage(std::string_view canonical_path, std::span<const WindowsImageRootPrefix> roots) {
  for (const WindowsImageRootPrefix &candidate : roots) {
    std::string_view prefix = candidate.prefix;
    while (!prefix.empty() && windows_target_facts_detail::IsSeparator(prefix.back()))
      prefix.remove_suffix(1);
    if (WindowsPathIsUnder(canonical_path, prefix))
      return {std::string(candidate.root), std::string(canonical_path.substr(prefix.size() + 1))};
  }
  return {"other", std::string(canonical_path)};
}

// The last component of a path.
[[nodiscard]] inline std::string WindowsImageLeaf(std::string_view path) {
  const std::size_t slash = path.find_last_of("\\/");
  return std::string(slash == std::string_view::npos ? path : path.substr(slash + 1));
}

// The fields of a PE image the facts and the kernel cross-check need. subsystem is "gui",
// "console" or "other"; subsystem_code, machine and check_sum are the raw header values;
// entry_rva is the optional header's AddressOfEntryPoint; has_cert_table is whether the security
// data directory (the embedded Authenticode certificate table) is present and non-empty.
struct PeImageSummary {
  std::string subsystem;
  std::uint16_t subsystem_code = 0;
  std::uint16_t machine = 0;
  std::uint32_t check_sum = 0;
  std::uint32_t entry_rva = 0;
  bool has_cert_table = false;
};

// Reads a PE image's header. Not a PE image (or one too short to read): std::nullopt.
[[nodiscard]] inline std::optional<PeImageSummary>
ParsePeImageSummary(std::span<const std::uint8_t> bytes) {
  using windows_target_facts_detail::ReadLe;
  if (bytes.size() < 0x40 || bytes[0] != 'M' || bytes[1] != 'Z') return std::nullopt;
  const std::size_t pe = ReadLe(bytes, 0x3c, 4);
  // Signature (4), file header (20), then the optional header: magic (2), AddressOfEntryPoint at
  // 16, CheckSum at 64, Subsystem at 68 (the same for PE32 and PE32+), then the data directories.
  if (pe > bytes.size() || bytes.size() - pe < 24 + 70) return std::nullopt;
  if (bytes[pe] != 'P' || bytes[pe + 1] != 'E' || bytes[pe + 2] != 0 || bytes[pe + 3] != 0)
    return std::nullopt;
  const std::size_t optional_size = ReadLe(bytes, pe + 20, 2);
  const std::uint32_t magic = ReadLe(bytes, pe + 24, 2);
  if (optional_size < 70 || (magic != 0x10b && magic != 0x20b)) return std::nullopt;
  PeImageSummary summary;
  summary.machine = static_cast<std::uint16_t>(ReadLe(bytes, pe + 4, 2));
  summary.entry_rva = ReadLe(bytes, pe + 24 + 16, 4);
  summary.check_sum = ReadLe(bytes, pe + 24 + 64, 4);
  summary.subsystem_code = static_cast<std::uint16_t>(ReadLe(bytes, pe + 24 + 68, 2));
  summary.subsystem = summary.subsystem_code == 2   ? "gui"
                      : summary.subsystem_code == 3 ? "console"
                                                    : "other";
  // The certificate table is data directory 4 (8 bytes each): its VA and, at +4, its size. The
  // directories begin at the optional header's offset 96 (PE32) or 112 (PE32+).
  const std::size_t directories = pe + 24 + (magic == 0x20b ? 112 : 96);
  const std::size_t count = ReadLe(bytes, pe + 24 + (magic == 0x20b ? 108 : 92), 4);
  const std::size_t security = directories + 4 * 8;
  if (count > 4 && optional_size >= (magic == 0x20b ? 112 : 96) + 5 * 8 &&
      security + 8 <= bytes.size())
    summary.has_cert_table = ReadLe(bytes, security + 4, 4) != 0;
  return summary;
}

// The PE optional header's subsystem: "gui", "console" or "other". Not a PE image: std::nullopt.
[[nodiscard]] inline std::optional<std::string>
ParsePeSubsystem(std::span<const std::uint8_t> bytes) {
  const std::optional<PeImageSummary> summary = ParsePeImageSummary(bytes);
  if (!summary.has_value()) return std::nullopt;
  return summary->subsystem;
}

namespace windows_target_facts_detail {

[[nodiscard]] inline bool IsWellFormedUtf8(std::string_view text) {
  for (std::size_t index = 0; index < text.size();) {
    const auto lead = static_cast<unsigned char>(text[index]);
    std::size_t length = 0;
    std::uint32_t code = 0;
    if (lead < 0x80) {
      length = 1;
      code = lead;
    } else if (lead >= 0xc2 && lead <= 0xdf) {
      length = 2;
      code = lead & 0x1f;
    } else if (lead >= 0xe0 && lead <= 0xef) {
      length = 3;
      code = lead & 0x0f;
    } else if (lead >= 0xf0 && lead <= 0xf4) {
      length = 4;
      code = lead & 0x07;
    } else {
      return false;
    }
    if (index + length > text.size()) return false;
    for (std::size_t next = 1; next < length; ++next) {
      const auto unit = static_cast<unsigned char>(text[index + next]);
      if ((unit & 0xc0) != 0x80) return false;
      code = (code << 6) | (unit & 0x3f);
    }
    if ((length == 3 && code < 0x800) || (length == 4 && (code < 0x10000 || code > 0x10ffff)) ||
        (code >= 0xd800 && code <= 0xdfff))
      return false;
    index += length;
  }
  return true;
}

// A manifest's bytes as UTF-8: UTF-8 (with or without its BOM) as it is, UTF-16 (little or big
// endian, by its BOM or by the NUL bytes ASCII leaves in every other place) converted. Anything
// else (UTF-32, a NUL left in the text, bytes that are not well-formed): std::nullopt.
[[nodiscard]] inline std::optional<std::string> ManifestText(std::string_view bytes) {
  const auto byte = [&bytes](std::size_t index) {
    return static_cast<unsigned char>(bytes[index]);
  };
  if (bytes.size() >= 4 && ((byte(0) == 0xff && byte(1) == 0xfe && byte(2) == 0 && byte(3) == 0) ||
                            (byte(0) == 0 && byte(1) == 0 && byte(2) == 0xfe && byte(3) == 0xff)))
    return std::nullopt;
  std::optional<bool> big_endian;
  std::size_t skip = 0;
  if (bytes.size() >= 2 && byte(0) == 0xff && byte(1) == 0xfe) {
    big_endian = false;
    skip = 2;
  } else if (bytes.size() >= 2 && byte(0) == 0xfe && byte(1) == 0xff) {
    big_endian = true;
    skip = 2;
  } else if (bytes.size() >= 2 && byte(0) != 0 && byte(1) == 0) {
    big_endian = false;
  } else if (bytes.size() >= 2 && byte(0) == 0 && byte(1) != 0) {
    big_endian = true;
  }
  std::string text;
  if (big_endian.has_value()) {
    if ((bytes.size() - skip) % 2 != 0) return std::nullopt;
    std::vector<char16_t> units;
    units.reserve((bytes.size() - skip) / 2);
    for (std::size_t index = skip; index < bytes.size(); index += 2)
      units.push_back(static_cast<char16_t>(*big_endian ? (byte(index) << 8) | byte(index + 1)
                                                        : byte(index) | (byte(index + 1) << 8)));
    std::optional<std::string> converted = Utf8FromUtf16(units);
    if (!converted.has_value()) return std::nullopt;
    text = std::move(*converted);
  } else {
    if (bytes.size() >= 3 && byte(0) == 0xef && byte(1) == 0xbb && byte(2) == 0xbf)
      bytes.remove_prefix(3);
    text = std::string(bytes);
  }
  // A resource may be padded with NULs after the text; a NUL inside it is not text.
  while (!text.empty() && text.back() == '\0') text.pop_back();
  if (text.find('\0') != std::string::npos || !IsWellFormedUtf8(text)) return std::nullopt;
  return text;
}

// The manifest text with its comments (`<!-- -->`), CDATA sections (`<![CDATA[ ]]>`) and
// processing instructions (`<? ?>`) each replaced by a space: none of them is an element, so a
// sample tag inside one says nothing. One that is not closed: std::nullopt.
[[nodiscard]] inline std::optional<std::string> ManifestElementsOnly(std::string_view text) {
  struct Skip {
    std::string_view open;
    std::string_view close;
  };
  static constexpr Skip kSkips[] = {
      {"<!--", "-->"}, {"<![CDATA[", "]]>"}, {"<?", "?>"}};
  std::string output;
  output.reserve(text.size());
  std::size_t at = 0;
  while (at < text.size()) {
    const Skip *skip = nullptr;
    for (const Skip &candidate : kSkips)
      if (text.substr(at, candidate.open.size()) == candidate.open) skip = &candidate;
    if (skip == nullptr) {
      output += text[at++];
      continue;
    }
    const std::size_t end = text.find(skip->close, at + skip->open.size());
    if (end == std::string_view::npos) return std::nullopt;
    output += ' ';
    at = end + skip->close.size();
  }
  return output;
}

} // namespace windows_target_facts_detail

// Whether an application manifest asks to run elevated. requireAdministrator and highestAvailable
// both count (the deny direction); a manifest without requestedExecutionLevel runs as the invoker,
// which is said only of a manifest read whole as UTF-8 or UTF-16. Comments, CDATA sections and
// processing instructions are not read. A level the reader does not know counts as elevated. An
// encoding, a tag, or an unclosed comment, CDATA section or processing instruction it cannot read:
// std::nullopt.
[[nodiscard]] inline std::optional<bool> ManifestRequiresAdministrator(std::string_view bytes) {
  const std::optional<std::string> decoded = windows_target_facts_detail::ManifestText(bytes);
  if (!decoded.has_value()) return std::nullopt;
  const std::optional<std::string> elements =
      windows_target_facts_detail::ManifestElementsOnly(*decoded);
  if (!elements.has_value()) return std::nullopt;
  const std::string_view manifest = *elements;
  static constexpr std::string_view kElement = "requestedExecutionLevel";
  bool elevated = false;
  std::size_t next = 0;
  for (std::size_t at = manifest.find(kElement); at != std::string_view::npos;
       at = manifest.find(kElement, next)) {
    next = at + kElement.size();
    // The element itself (`<requestedExecutionLevel` or `<prefix:requestedExecutionLevel`), its
    // name ending there (not `requestedExecutionLevelX`).
    std::size_t open = at;
    while (open > 0 && manifest[open - 1] != '<' && manifest[open - 1] != '>' &&
           manifest[open - 1] != ' ' && manifest[open - 1] != '/')
      --open;
    if (open == 0 || manifest[open - 1] != '<') continue;
    if (next < manifest.size() && std::string_view(" \t\r\n/>").find(manifest[next]) ==
                                      std::string_view::npos)
      continue;
    // The tag ends at the first `>` outside a quoted attribute value (a value may hold `>`).
    std::size_t close = std::string_view::npos;
    char quote = '\0';
    for (std::size_t cursor = next; cursor < manifest.size(); ++cursor) {
      const char letter = manifest[cursor];
      if (quote != '\0') {
        if (letter == quote) quote = '\0';
      } else if (letter == '"' || letter == '\'') {
        quote = letter;
      } else if (letter == '>') {
        close = cursor;
        break;
      }
    }
    if (close == std::string_view::npos) return std::nullopt;
    std::string_view tag = manifest.substr(next, close - next);
    next = close + 1;
    // Every level the element carries (a repeated attribute is malformed; any elevated one counts).
    std::optional<std::string_view> level;
    while (true) {
      const std::size_t name_begin = tag.find_first_not_of(" \t\r\n/");
      if (name_begin == std::string_view::npos) break;
      const std::size_t equals = tag.find('=', name_begin);
      if (equals == std::string_view::npos) return std::nullopt;
      std::string_view name = tag.substr(name_begin, equals - name_begin);
      while (!name.empty() && (name.back() == ' ' || name.back() == '\t' || name.back() == '\r' ||
                               name.back() == '\n'))
        name.remove_suffix(1);
      const std::size_t quote_at = tag.find_first_not_of(" \t\r\n", equals + 1);
      if (quote_at == std::string_view::npos || (tag[quote_at] != '"' && tag[quote_at] != '\''))
        return std::nullopt;
      const std::size_t end_quote = tag.find(tag[quote_at], quote_at + 1);
      if (end_quote == std::string_view::npos) return std::nullopt;
      if (name == "level") {
        level = tag.substr(quote_at + 1, end_quote - quote_at - 1);
        if (*level != "asInvoker") elevated = true;
      }
      tag.remove_prefix(end_quote + 1);
    }
    if (!level.has_value()) return std::nullopt;
  }
  return elevated;
}

// OriginalFilename out of an RT_VERSION resource (VS_VERSIONINFO). The first string table that
// carries it wins; a resource without one gives "". A resource it cannot walk: std::nullopt.
[[nodiscard]] inline std::optional<std::string>
VersionInfoOriginalFilename(std::span<const std::uint8_t> resource) {
  using namespace windows_target_facts_detail;
  const std::optional<VersionBlock> root = ReadVersionBlock(resource, 0, resource.size());
  if (!root.has_value() || !UnitsEqual(root->key, "VS_VERSION_INFO")) return std::nullopt;
  std::size_t child = Align4(root->value + root->value_length);
  while (child < root->end) {
    const std::optional<VersionBlock> info = ReadVersionBlock(resource, child, root->end);
    if (!info.has_value()) return std::nullopt;
    if (UnitsEqual(info->key, "StringFileInfo")) {
      for (std::size_t table_at = info->value; table_at < info->end;) {
        const std::optional<VersionBlock> table = ReadVersionBlock(resource, table_at, info->end);
        if (!table.has_value()) return std::nullopt;
        for (std::size_t entry_at = table->value; entry_at < table->end;) {
          const std::optional<VersionBlock> entry =
              ReadVersionBlock(resource, entry_at, table->end);
          if (!entry.has_value()) return std::nullopt;
          if (UnitsEqual(entry->key, "OriginalFilename")) {
            // The value runs to its NUL, or to the end of the entry when a linker left that out.
            std::vector<char16_t> value;
            for (std::size_t cursor = entry->value; entry->value_length != 0 &&
                                                    cursor + 1 < entry->end;
                 cursor += 2) {
              const auto unit = static_cast<char16_t>(ReadLe(resource, cursor, 2));
              if (unit == 0) break;
              value.push_back(unit);
            }
            return Utf8FromUtf16(value);
          }
          entry_at = Align4(entry->end);
        }
        table_at = Align4(table->end);
      }
    }
    child = Align4(info->end);
  }
  return std::string{};
}

// A leaf a descendant shell has: the W4 leaf rule of the deny ruleset (so the list stays one),
// without the console hosts, which say a pseudo console instead.
[[nodiscard]] inline bool WindowsLeafIsConsoleHost(std::string_view leaf) {
  const std::string folded = target_eligibility_detail::AsciiLower(leaf);
  return folded == "conhost.exe" || folded == "openconsole.exe";
}

[[nodiscard]] inline bool WindowsLeafIsShell(std::string_view leaf) {
  if (WindowsLeafIsConsoleHost(leaf)) return false;
  const std::string folded = target_eligibility_detail::AsciiLower(leaf);
  const std::uint32_t bit = TargetPlatformBit(TargetPlatform::kWin32);
  for (const TargetRule &rule : kTargetRules) {
    if (rule.class_id != "W4" || rule.verdict != TargetRuleVerdict::kDenied ||
        (rule.platforms & bit) == 0 || rule.when.size() != 1)
      continue;
    const TargetCondition &condition = rule.when.front();
    if (condition.signal != TargetSignal::kImageLeaf || condition.negate) continue;
    for (const std::string_view candidate : condition.values)
      if (condition.match == TargetMatch::kGlob
              ? target_eligibility_detail::GlobMatches(candidate, folded)
              : folded == candidate)
        return true;
  }
  return false;
}

// One process of a snapshot. `creation` is std::nullopt when the host could not open the process.
struct WindowsProcessNode {
  std::uint32_t pid = 0;
  std::uint32_t parent_pid = 0;
  std::optional<std::uint64_t> creation;
  std::string leaf;
};

struct WindowsDescendants {
  std::vector<std::size_t> nodes;
  // More descendants than the limit: the set is not whole.
  bool truncated = false;
};

// The processes descended from (root_pid, root_creation), as indices into `nodes`. A process is a
// child of another when its parent pid names that process and it was created no earlier: a pid the
// system reused after the child started names a later process, which is not its parent. A process
// whose creation time could not be read is taken as a child (the deny direction), and so are its
// own children.
[[nodiscard]] inline WindowsDescendants
FindWindowsDescendants(std::span<const WindowsProcessNode> nodes, std::uint32_t root_pid,
                       std::uint64_t root_creation, std::size_t limit) {
  WindowsDescendants result;
  std::vector<bool> taken(nodes.size(), false);
  struct Parent {
    std::uint32_t pid;
    std::optional<std::uint64_t> creation;
  };
  std::vector<Parent> frontier{{root_pid, root_creation}};
  while (!frontier.empty()) {
    const Parent parent = frontier.back();
    frontier.pop_back();
    for (std::size_t index = 0; index < nodes.size(); ++index) {
      const WindowsProcessNode &node = nodes[index];
      if (taken[index] || node.pid == 0 || node.pid == parent.pid ||
          node.parent_pid != parent.pid)
        continue;
      if (node.pid == root_pid && node.creation.has_value() && *node.creation == root_creation)
        continue;
      if (parent.creation.has_value() && node.creation.has_value() &&
          *node.creation < *parent.creation)
        continue;
      if (result.nodes.size() >= limit) {
        result.truncated = true;
        return result;
      }
      taken[index] = true;
      result.nodes.push_back(index);
      frontier.push_back({node.pid, node.creation});
    }
  }
  return result;
}

} // namespace sprint_coder::computer_use
