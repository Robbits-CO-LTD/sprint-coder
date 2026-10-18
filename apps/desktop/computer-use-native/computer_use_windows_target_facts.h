#pragma once

// The portable parts of the Windows target facts (S5-c-3, #500 PR-2). The Windows host measures a
// target through handles (the `windows target facts` block of computer_use_windows_host.cc) and
// leaves to this header what needs no platform API: where a canonical path lies among the roots,
// the leaf, the PE subsystem, the resources of an image (located and found without the loader),
// the manifest's execution level, OriginalFilename out of a VS_VERSIONINFO resource, whether an
// image file changed after its process was created, a SystemProcessInformation snapshot, and the
// descendants of a process in it, and the v2 package identity (PR-4). No platform header, so
// MSVC (/W4 /sdl) and clang both compile it, and the target eligibility harness checks it.
//
// Every reader here fails closed: bytes it cannot read give std::nullopt (the core then answers
// unresolvable), never a value that would admit.

#include "computer_use_target_eligibility.h"

#include <array>
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

// A little-endian value of `width` (1 to 4) bytes at `at`, or std::nullopt when any of it lies
// outside `bytes`. The bound is checked without adding to `at`, so no offset can overflow past it.
[[nodiscard]] inline std::optional<std::uint32_t>
ReadLe(std::span<const std::uint8_t> bytes, std::size_t at, std::size_t width) {
  if (width == 0 || width > 4 || at > bytes.size() || width > bytes.size() - at)
    return std::nullopt;
  std::uint32_t value = 0;
  for (std::size_t index = 0; index < width; ++index)
    value |= static_cast<std::uint32_t>(bytes[at + index]) << (8 * index);
  return value;
}

// `base + offset`, or std::nullopt when it would overflow or pass `limit`.
[[nodiscard]] constexpr std::optional<std::size_t> OffsetWithin(std::size_t base,
                                                                std::size_t offset,
                                                                std::size_t limit) {
  if (base > limit || offset > limit - base) return std::nullopt;
  return base + offset;
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
  if (end > bytes.size()) return std::nullopt;
  for (std::size_t cursor = at; cursor < end && end - cursor >= 2; cursor += 2) {
    const std::optional<std::uint32_t> read = ReadLe(bytes, cursor, 2);
    if (!read.has_value()) return std::nullopt;
    const auto unit = static_cast<char16_t>(*read);
    if (unit == 0) {
      *after = cursor + 2;
      return units;
    }
    units.push_back(unit);
  }
  return std::nullopt;
}

// The offset rounded up to a multiple of 4; std::nullopt when that would overflow.
[[nodiscard]] constexpr std::optional<std::size_t> Align4(std::size_t offset) {
  if (offset > static_cast<std::size_t>(-1) - 3) return std::nullopt;
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
  if (limit > bytes.size() || !OffsetWithin(at, 6, limit).has_value()) return std::nullopt;
  VersionBlock block;
  block.begin = at;
  const std::optional<std::uint32_t> length = ReadLe(bytes, at, 2);
  const std::optional<std::uint32_t> value_length = ReadLe(bytes, at + 2, 2);
  const std::optional<std::uint32_t> type = ReadLe(bytes, at + 4, 2);
  if (!length.has_value() || !value_length.has_value() || !type.has_value() || *length < 6)
    return std::nullopt;
  const std::optional<std::size_t> end = OffsetWithin(at, *length, limit);
  if (!end.has_value() || *type > 1) return std::nullopt;
  block.end = *end;
  block.value_length = *value_length;
  block.text = *type == 1;
  std::size_t after = 0;
  std::optional<std::vector<char16_t>> key = ReadUtf16z(bytes, at + 6, block.end, &after);
  if (!key.has_value()) return std::nullopt;
  block.key = std::move(*key);
  const std::optional<std::size_t> value = Align4(after);
  if (!value.has_value() || *value > block.end) return std::nullopt;
  block.value = *value;
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
// data directory (the embedded Authenticode certificate table) is present and non-empty, or
// std::nullopt when the header does not let that be read (the directories lie outside the bytes
// or the optional header, or there are fewer than five): unknown, which the signature check treats
// as invalid, never as "no certificate table".
struct PeImageSummary {
  std::string subsystem;
  std::uint16_t subsystem_code = 0;
  std::uint16_t machine = 0;
  std::uint32_t check_sum = 0;
  std::uint32_t entry_rva = 0;
  std::optional<bool> has_cert_table;
  // Auxiliary header values for the kernel cross-check, each std::nullopt when the optional header
  // (as SizeOfOptionalHeader declares it) or the bytes do not cover it.
  std::optional<std::uint16_t> image_characteristics;
  std::optional<std::uint16_t> dll_characteristics;
  std::optional<std::uint64_t> stack_reserve;
  std::optional<std::uint64_t> stack_commit;
  // True when a PE32 image's CLR header marks it IL-only without 32BITREQUIRED or 32BITPREFERRED: on
  // 64-bit Windows the loader converts such an AnyCPU image from PE32 to PE32+, so the kernel's
  // SECTION_IMAGE_INFORMATION differs from the file header (machine, entry point, sizes, checksum).
  // The kernel cross-check skips those fields for it. std::nullopt when the CLR header is absent or
  // could not be read.
  std::optional<bool> clr_bitness_convertible;
};

// Reads a PE image's header. Every read is bounds-checked (ReadLe) and every offset is formed with
// OffsetWithin, which compares before it adds. Not a PE image, or a header that does not fit in
// the bytes read: std::nullopt.
[[nodiscard]] inline std::optional<PeImageSummary>
ParsePeImageSummary(std::span<const std::uint8_t> bytes) {
  using windows_target_facts_detail::OffsetWithin;
  using windows_target_facts_detail::ReadLe;
  const std::size_t size = bytes.size();
  if (size < 0x40 || bytes[0] != 'M' || bytes[1] != 'Z') return std::nullopt;
  const std::optional<std::uint32_t> pe = ReadLe(bytes, 0x3c, 4);
  if (!pe.has_value()) return std::nullopt;
  // Signature (4) and file header (20) before the optional header.
  const std::optional<std::size_t> optional = OffsetWithin(*pe, 24, size);
  if (!optional.has_value()) return std::nullopt;
  const std::optional<std::uint32_t> signature = ReadLe(bytes, *pe, 4);
  const std::optional<std::uint32_t> machine = ReadLe(bytes, *pe + 4, 2);
  const std::optional<std::uint32_t> optional_size = ReadLe(bytes, *pe + 20, 2);
  const std::optional<std::uint32_t> magic = ReadLe(bytes, *optional, 2);
  if (signature != std::optional<std::uint32_t>(0x00004550u) || !machine.has_value() ||
      !optional_size.has_value() || *optional_size < 70 || !magic.has_value() ||
      (*magic != 0x10b && *magic != 0x20b))
    return std::nullopt;
  // AddressOfEntryPoint at 16, CheckSum at 64, Subsystem at 68 (the same for PE32 and PE32+).
  const std::optional<std::uint32_t> entry = ReadLe(bytes, *optional + 16, 4);
  const std::optional<std::uint32_t> check_sum = ReadLe(bytes, *optional + 64, 4);
  const std::optional<std::uint32_t> subsystem = ReadLe(bytes, *optional + 68, 2);
  if (!entry.has_value() || !check_sum.has_value() || !subsystem.has_value())
    return std::nullopt;
  PeImageSummary summary;
  summary.machine = static_cast<std::uint16_t>(*machine);
  summary.entry_rva = *entry;
  summary.check_sum = *check_sum;
  summary.subsystem_code = static_cast<std::uint16_t>(*subsystem);
  summary.subsystem = summary.subsystem_code == 2   ? "gui"
                      : summary.subsystem_code == 3 ? "console"
                                                    : "other";
  const bool wide = *magic == 0x20b;
  // A field at `offset` of `width` bytes inside the declared optional header, read checked.
  const auto field = [&](std::size_t offset, std::size_t width) -> std::optional<std::uint64_t> {
    if (*optional_size < offset + width) return std::nullopt;
    std::uint64_t value = 0;
    for (std::size_t part = 0; part < width; part += 4) {
      const std::optional<std::uint32_t> read =
          ReadLe(bytes, *optional + offset + part, width - part < 4 ? width - part : 4);
      if (!read.has_value()) return std::nullopt;
      value |= static_cast<std::uint64_t>(*read) << (8 * part);
    }
    return value;
  };
  if (const std::optional<std::uint32_t> characteristics = ReadLe(bytes, *pe + 22, 2))
    summary.image_characteristics = static_cast<std::uint16_t>(*characteristics);
  if (const std::optional<std::uint64_t> dll = field(70, 2))
    summary.dll_characteristics = static_cast<std::uint16_t>(*dll);
  // SizeOfStackReserve / SizeOfStackCommit: 4 bytes each at 72 and 76 (PE32), 8 at 72 and 80.
  summary.stack_reserve = field(72, wide ? 8 : 4);
  summary.stack_commit = field(wide ? 80 : 76, wide ? 8 : 4);
  // NumberOfRvaAndSizes at 92 (PE32) or 108 (PE32+), then the directories (8 bytes each); the
  // certificate table is directory 4, its size the second dword. All of it must lie inside both
  // the optional header (as SizeOfOptionalHeader declares it) and the bytes; otherwise unknown.
  const bool plus = *magic == 0x20b;
  const std::size_t count_at = plus ? 108 : 92;
  const std::size_t security_end = (plus ? 112 : 96) + 5 * 8;
  const std::optional<std::size_t> directories_end = OffsetWithin(*optional, security_end, size);
  if (*optional_size >= security_end && directories_end.has_value()) {
    const std::optional<std::uint32_t> count = ReadLe(bytes, *optional + count_at, 4);
    const std::optional<std::uint32_t> security_size =
        ReadLe(bytes, *optional + security_end - 4, 4);
    if (count.has_value() && *count >= 5 && security_size.has_value())
      summary.has_cert_table = *security_size != 0;
  }
  // The CLR runtime header is data directory 14. Reading its Flags needs the directory's RVA mapped
  // to a file offset through the section table (sections begin after the optional header). Every
  // read is bounds-checked; anything missing leaves clr_bitness_convertible std::nullopt.
  const std::size_t clr_dir = (plus ? 112 : 96) + 14 * 8;
  const std::optional<std::size_t> clr_dir_end = OffsetWithin(*optional, clr_dir + 8, size);
  const std::optional<std::uint32_t> clr_count = ReadLe(bytes, *optional + count_at, 4);
  if (*optional_size >= clr_dir + 8 && clr_dir_end.has_value() && clr_count.has_value() &&
      *clr_count >= 15) {
    const std::optional<std::uint32_t> clr_rva = ReadLe(bytes, *optional + clr_dir, 4);
    const std::optional<std::uint32_t> clr_size = ReadLe(bytes, *optional + clr_dir + 4, 4);
    const std::optional<std::uint32_t> sections = ReadLe(bytes, *pe + 6, 2);
    if (clr_rva.has_value() && *clr_rva != 0 && clr_size.has_value() && *clr_size != 0 &&
        sections.has_value()) {
      const std::optional<std::size_t> table = OffsetWithin(*optional, *optional_size, size);
      std::optional<std::size_t> clr_offset;
      for (std::size_t index = 0; table.has_value() && index < *sections; ++index) {
        const std::optional<std::size_t> header = OffsetWithin(*table, index * 40 + 40, size);
        if (!header.has_value()) break;
        const std::size_t at = *table + index * 40;
        const std::optional<std::uint32_t> virtual_size = ReadLe(bytes, at + 8, 4);
        const std::optional<std::uint32_t> virtual_address = ReadLe(bytes, at + 12, 4);
        const std::optional<std::uint32_t> raw_size = ReadLe(bytes, at + 16, 4);
        const std::optional<std::uint32_t> raw_pointer = ReadLe(bytes, at + 20, 4);
        if (!virtual_size.has_value() || !virtual_address.has_value() || !raw_size.has_value() ||
            !raw_pointer.has_value())
          break;
        const std::uint32_t span = *virtual_size > *raw_size ? *virtual_size : *raw_size;
        if (*clr_rva >= *virtual_address && *clr_rva < *virtual_address + span)
          clr_offset = OffsetWithin(*raw_pointer, *clr_rva - *virtual_address, size);
      }
      // COR20 header: cb(4), runtime version(4), MetaData(8), Flags(4) at offset 16.
      if (clr_offset.has_value()) {
        const std::optional<std::uint32_t> flags = ReadLe(bytes, *clr_offset + 16, 4);
        if (flags.has_value()) {
          constexpr std::uint32_t kIlOnly = 0x00000001;
          constexpr std::uint32_t k32BitRequired = 0x00000002;
          constexpr std::uint32_t k32BitPreferred = 0x00020000;
          // Only a PE32 (magic 0x10b) image is converted; a PE32+ IL-only image already loads as
          // is, so it keeps the full cross-check.
          summary.clr_bitness_convertible = !plus && (*flags & kIlOnly) != 0 &&
                                            (*flags & k32BitRequired) == 0 &&
                                            (*flags & k32BitPreferred) == 0;
        }
      }
    }
  }
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
  // The fixed file info must fit in the root block; each next offset is formed checked.
  const std::optional<std::size_t> fixed_end =
      OffsetWithin(root->value, root->value_length, root->end);
  const std::optional<std::size_t> first =
      fixed_end.has_value() ? Align4(*fixed_end) : std::nullopt;
  if (!first.has_value()) return std::nullopt;
  std::size_t child = *first;
  const auto next = [](std::size_t end) { return Align4(end); };
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
            for (std::size_t cursor = entry->value;
                 entry->value_length != 0 && cursor < entry->end && entry->end - cursor >= 2;
                 cursor += 2) {
              const std::optional<std::uint32_t> unit = ReadLe(resource, cursor, 2);
              if (!unit.has_value()) return std::nullopt;
              if (*unit == 0) break;
              value.push_back(static_cast<char16_t>(*unit));
            }
            return Utf8FromUtf16(value);
          }
          const std::optional<std::size_t> after_entry = next(entry->end);
          if (!after_entry.has_value()) return std::nullopt;
          entry_at = *after_entry;
        }
        const std::optional<std::size_t> after_table = next(table->end);
        if (!after_table.has_value()) return std::nullopt;
        table_at = *after_table;
      }
    }
    const std::optional<std::size_t> after_info = next(info->end);
    if (!after_info.has_value()) return std::nullopt;
    child = *after_info;
  }
  return std::string{};
}

// Where a PE image's resource directory lies, in the image layout (RVAs, as the loader maps it): the
// section that holds the directory (its RVA and its mapped size, VirtualSize or, when that is 0,
// SizeOfRawData) and the directory's own RVA. `present` is false when the image has no resource
// directory (fewer than three data directories, or directory 2 empty): its resources are absent.
struct PeResourceSection {
  bool present = false;
  std::uint32_t section_rva = 0;
  std::uint32_t section_size = 0;
  std::uint32_t directory_rva = 0;
};

// A resource section larger than this is not read (unresolvable): the host copies it out whole.
inline constexpr std::uint32_t kPeResourceSectionLimit = 32u * 1024u * 1024u;

// Locates the resource section from a PE image's header bytes (the header page of a mapped image,
// or the start of the file: the header is the same in both). A directory that lies in no section,
// a section larger than kPeResourceSectionLimit, or a header that does not let this be read:
// std::nullopt.
[[nodiscard]] inline std::optional<PeResourceSection>
LocatePeResourceSection(std::span<const std::uint8_t> header) {
  using windows_target_facts_detail::OffsetWithin;
  using windows_target_facts_detail::ReadLe;
  const std::size_t size = header.size();
  if (size < 0x40 || header[0] != 'M' || header[1] != 'Z') return std::nullopt;
  const std::optional<std::uint32_t> pe = ReadLe(header, 0x3c, 4);
  if (!pe.has_value()) return std::nullopt;
  const std::optional<std::size_t> optional = OffsetWithin(*pe, 24, size);
  if (!optional.has_value()) return std::nullopt;
  const std::optional<std::uint32_t> signature = ReadLe(header, *pe, 4);
  const std::optional<std::uint32_t> sections = ReadLe(header, *pe + 6, 2);
  const std::optional<std::uint32_t> optional_size = ReadLe(header, *pe + 20, 2);
  const std::optional<std::uint32_t> magic = ReadLe(header, *optional, 2);
  if (signature != std::optional<std::uint32_t>(0x00004550u) || !sections.has_value() ||
      !optional_size.has_value() || !magic.has_value() || (*magic != 0x10b && *magic != 0x20b))
    return std::nullopt;
  const bool plus = *magic == 0x20b;
  const std::size_t count_at = plus ? 108 : 92;
  const std::size_t resource_at = (plus ? 112 : 96) + 2 * 8;
  PeResourceSection result;
  // An optional header too short to hold NumberOfRvaAndSizes has no data directories at all.
  if (*optional_size < count_at + 4) return result;
  const std::optional<std::uint32_t> count = ReadLe(header, *optional + count_at, 4);
  if (!count.has_value()) return std::nullopt;
  // No third data directory, or one the optional header does not cover: no resource directory.
  if (*count < 3 || *optional_size < resource_at + 8) return result;
  const std::optional<std::uint32_t> rva = ReadLe(header, *optional + resource_at, 4);
  const std::optional<std::uint32_t> length = ReadLe(header, *optional + resource_at + 4, 4);
  if (!rva.has_value() || !length.has_value()) return std::nullopt;
  if (*rva == 0 || *length == 0) return result;
  const std::optional<std::size_t> table = OffsetWithin(*optional, *optional_size, size);
  if (!table.has_value()) return std::nullopt;
  for (std::size_t index = 0; index < *sections; ++index) {
    const std::optional<std::size_t> entry_end = OffsetWithin(*table, index * 40 + 40, size);
    if (!entry_end.has_value()) return std::nullopt;
    const std::size_t at = *table + index * 40;
    const std::optional<std::uint32_t> virtual_size = ReadLe(header, at + 8, 4);
    const std::optional<std::uint32_t> virtual_address = ReadLe(header, at + 12, 4);
    const std::optional<std::uint32_t> raw_size = ReadLe(header, at + 16, 4);
    if (!virtual_size.has_value() || !virtual_address.has_value() || !raw_size.has_value())
      return std::nullopt;
    const std::uint32_t mapped = *virtual_size != 0 ? *virtual_size : *raw_size;
    if (*rva < *virtual_address || *rva - *virtual_address >= mapped) continue;
    if (mapped > kPeResourceSectionLimit) return std::nullopt;
    result.present = true;
    result.section_rva = *virtual_address;
    result.section_size = mapped;
    result.directory_rva = *rva;
    return result;
  }
  return std::nullopt;
}

// The data of every language of the resource (type id, name id), read from a resource section's
// bytes (`section` holds the RVAs [section_rva, section_rva + section.size())). Absent (the type or
// the name is not there): an empty list. Each level is the IMAGE_RESOURCE_DIRECTORY layout (16
// bytes, then NumberOfNamedEntries + NumberOfIdEntries entries of 8 bytes; a subdirectory's offset
// is relative to the directory root and has its high bit set); the three levels are fixed (type,
// name, language), so nothing can loop. A directory or an entry outside the section, a language
// level that is not data, or data outside the section: std::nullopt (unresolvable). The loader's
// own lookup is not used: FindResource would also consult a language's .mui file, which is another
// file than the held one and not verified.
[[nodiscard]] inline std::optional<std::vector<std::span<const std::uint8_t>>>
FindPeResources(std::span<const std::uint8_t> section, std::uint32_t section_rva,
                std::uint32_t directory_rva, std::uint16_t type_id, std::uint16_t name_id) {
  using windows_target_facts_detail::OffsetWithin;
  using windows_target_facts_detail::ReadLe;
  if (directory_rva < section_rva || directory_rva - section_rva >= section.size())
    return std::nullopt;
  const std::size_t root = directory_rva - section_rva;
  // The entries of the directory at `at` (relative to the root), as (name, offset) pairs.
  struct Entry {
    std::uint32_t name;
    std::uint32_t offset;
  };
  const auto entries = [&](std::size_t relative) -> std::optional<std::vector<Entry>> {
    const std::optional<std::size_t> at = OffsetWithin(root, relative, section.size());
    if (!at.has_value() || !OffsetWithin(*at, 16, section.size()).has_value()) return std::nullopt;
    const std::optional<std::uint32_t> named = ReadLe(section, *at + 12, 2);
    const std::optional<std::uint32_t> ids = ReadLe(section, *at + 14, 2);
    if (!named.has_value() || !ids.has_value()) return std::nullopt;
    const std::size_t total = static_cast<std::size_t>(*named) + *ids;
    if (!OffsetWithin(*at + 16, total * 8, section.size()).has_value()) return std::nullopt;
    std::vector<Entry> list;
    list.reserve(total);
    for (std::size_t index = 0; index < total; ++index)
      list.push_back({*ReadLe(section, *at + 16 + index * 8, 4),
                      *ReadLe(section, *at + 16 + index * 8 + 4, 4)});
    return list;
  };
  constexpr std::uint32_t kHighBit = 0x80000000u;
  // The subdirectory an id entry names in the directory at `relative`: std::nullopt when the
  // directory cannot be read, 0 when the id is not there, or the subdirectory's offset + 1.
  const auto find = [&](std::size_t relative, std::uint16_t id) -> std::optional<std::size_t> {
    const std::optional<std::vector<Entry>> list = entries(relative);
    if (!list.has_value()) return std::nullopt;
    for (const Entry &entry : *list) {
      if ((entry.name & kHighBit) != 0 || entry.name != id) continue;
      if ((entry.offset & kHighBit) == 0) return std::nullopt;
      return static_cast<std::size_t>(entry.offset & ~kHighBit) + 1;
    }
    return std::size_t{0};
  };
  std::vector<std::span<const std::uint8_t>> found;
  const std::optional<std::size_t> type = find(0, type_id);
  if (!type.has_value()) return std::nullopt;
  if (*type == 0) return found;
  const std::optional<std::size_t> name = find(*type - 1, name_id);
  if (!name.has_value()) return std::nullopt;
  if (*name == 0) return found;
  const std::optional<std::vector<Entry>> languages = entries(*name - 1);
  if (!languages.has_value()) return std::nullopt;
  for (const Entry &language : *languages) {
    if ((language.offset & kHighBit) != 0) return std::nullopt;
    const std::optional<std::size_t> data_at = OffsetWithin(root, language.offset, section.size());
    if (!data_at.has_value() || !OffsetWithin(*data_at, 16, section.size()).has_value())
      return std::nullopt;
    const std::uint32_t data_rva = *ReadLe(section, *data_at, 4);
    const std::uint32_t data_size = *ReadLe(section, *data_at + 4, 4);
    if (data_rva < section_rva || data_size == 0) return std::nullopt;
    const std::size_t data_offset = data_rva - section_rva;
    if (!OffsetWithin(data_offset, data_size, section.size()).has_value()) return std::nullopt;
    found.push_back(section.subspan(data_offset, data_size));
  }
  // A name without a language is absent, as the loader has it (ERROR_RESOURCE_LANG_NOT_FOUND).
  return found;
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

// One process of a snapshot. The host reads every node's creation time from the same kernel
// snapshot as its parent pid (SystemProcessInformation's CreateTime), without opening the process,
// so a process this helper may not open (a SYSTEM orphan, a protected process) still has one.
// `creation` is std::nullopt only for a source that cannot give it (see FindWindowsDescendants).
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
// child of another when its parent pid names that process and it was created no earlier (the same
// time counts as a child: the deny direction): a pid the system reused after the child started
// names a later process, which is not its parent. A process whose creation time is missing is taken
// as a child (the deny direction), and so are its own children: without a time a reused pid cannot
// be told from a real parent, and leaving it out would let a real child go unseen. The host's
// snapshot gives every process a time, so this applies only to a source that cannot; the cost it
// once had (a process the helper could not open, adopted through a reused pid) is gone with it.
//
// Residual risk (not traced): a descendant whose parent chain passes through a process that has
// exited. Windows does not reparent an orphan, so its parent pid names a process that is gone (or,
// later, an unrelated process created after it, which the creation-time rule above refuses), and
// nothing in a snapshot ties it back to the target. Nor can a snapshot see a child the target
// started with another parent (PROC_THREAD_ATTRIBUTE_PARENT_PROCESS). The descendant facts are an
// upper-class cap (C) for apps that host a shell or a pseudo console in their own surface, which
// keeps its owner alive below the target; they are not a boundary against a target that hides one.
// See the lineage note in the host's facts block for why no orphan signal is used.
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

// The byte layout (x64) of one SYSTEM_PROCESS_INFORMATION entry, as
// NtQuerySystemInformation(SystemProcessInformation) returns it: NextEntryOffset at 0, CreateTime
// at 32, ImageName (a UNICODE_STRING: Length, MaximumLength, a pointer at 8) at 56,
// UniqueProcessId at 80 and InheritedFromUniqueProcessId at 88. Pinned here, as the host pins
// SECTION_IMAGE_INFORMATION, so the parser below needs no platform header.
inline constexpr std::size_t kWindowsProcessEntryNext = 0;
inline constexpr std::size_t kWindowsProcessEntryCreateTime = 32;
inline constexpr std::size_t kWindowsProcessEntryImageNameLength = 56;
inline constexpr std::size_t kWindowsProcessEntryImageNameBuffer = 64;
inline constexpr std::size_t kWindowsProcessEntryPid = 80;
inline constexpr std::size_t kWindowsProcessEntryParentPid = 88;
inline constexpr std::size_t kWindowsProcessEntryMinimum = 96;

namespace windows_target_facts_detail {

[[nodiscard]] inline std::optional<std::uint64_t> ReadLe64(std::span<const std::uint8_t> bytes,
                                                           std::size_t at) {
  const std::optional<std::size_t> high_at = OffsetWithin(at, 4, bytes.size());
  if (!high_at.has_value()) return std::nullopt;
  const std::optional<std::uint32_t> low = ReadLe(bytes, at, 4);
  const std::optional<std::uint32_t> high = ReadLe(bytes, *high_at, 4);
  if (!low.has_value() || !high.has_value()) return std::nullopt;
  return (static_cast<std::uint64_t>(*high) << 32) | *low;
}

} // namespace windows_target_facts_detail

// Every process of a SystemProcessInformation buffer, with its parent pid, its creation time and
// its leaf, all from the one kernel snapshot (no process is opened). `buffer_address` is where the
// buffer lies in memory: an ImageName points into the buffer itself. An entry that runs outside the
// buffer, a NextEntryOffset that does not move past the entry, a pid wider than 32 bits, an image
// name that does not lie inside the buffer, or more than `limit` entries: std::nullopt (the lineage
// is then not measured). A name that is not valid UTF-16 is given as "" (the name only refuses, and
// the descendant's running image is read regardless).
[[nodiscard]] inline std::optional<std::vector<WindowsProcessNode>>
ParseWindowsProcessSnapshot(std::span<const std::uint8_t> buffer, std::uint64_t buffer_address,
                            std::size_t limit) {
  using windows_target_facts_detail::OffsetWithin;
  using windows_target_facts_detail::ReadLe;
  using windows_target_facts_detail::ReadLe64;
  std::vector<WindowsProcessNode> nodes;
  std::size_t at = 0;
  while (true) {
    const std::optional<std::size_t> entry_end =
        OffsetWithin(at, kWindowsProcessEntryMinimum, buffer.size());
    if (!entry_end.has_value() || nodes.size() >= limit) return std::nullopt;
    const std::optional<std::uint32_t> next = ReadLe(buffer, at + kWindowsProcessEntryNext, 4);
    const std::optional<std::uint64_t> created =
        ReadLe64(buffer, at + kWindowsProcessEntryCreateTime);
    const std::optional<std::uint32_t> name_length =
        ReadLe(buffer, at + kWindowsProcessEntryImageNameLength, 2);
    const std::optional<std::uint64_t> name_pointer =
        ReadLe64(buffer, at + kWindowsProcessEntryImageNameBuffer);
    const std::optional<std::uint64_t> pid = ReadLe64(buffer, at + kWindowsProcessEntryPid);
    const std::optional<std::uint64_t> parent =
        ReadLe64(buffer, at + kWindowsProcessEntryParentPid);
    if (!next.has_value() || !created.has_value() || !name_length.has_value() ||
        !name_pointer.has_value() || !pid.has_value() || !parent.has_value() ||
        *pid > 0xffffffffu || *parent > 0xffffffffu || (*name_length % 2) != 0)
      return std::nullopt;
    WindowsProcessNode node;
    node.pid = static_cast<std::uint32_t>(*pid);
    node.parent_pid = static_cast<std::uint32_t>(*parent);
    node.creation = *created;
    if (*name_length != 0) {
      if (*name_pointer < buffer_address) return std::nullopt;
      const std::uint64_t name_offset = *name_pointer - buffer_address;
      if (name_offset > buffer.size() ||
          !OffsetWithin(static_cast<std::size_t>(name_offset), *name_length, buffer.size())
               .has_value())
        return std::nullopt;
      std::vector<char16_t> units;
      for (std::size_t unit = 0; unit < *name_length; unit += 2)
        units.push_back(static_cast<char16_t>(
            *ReadLe(buffer, static_cast<std::size_t>(name_offset) + unit, 2)));
      node.leaf = windows_target_facts_detail::Utf8FromUtf16(units).value_or(std::string{});
    }
    nodes.push_back(std::move(node));
    if (*next == 0) return nodes;
    if (*next < kWindowsProcessEntryMinimum) return std::nullopt;
    const std::optional<std::size_t> following = OffsetWithin(at, *next, buffer.size());
    if (!following.has_value()) return std::nullopt;
    at = *following;
  }
}

// Whether the held image file is unchanged since the process was created (process herpaderping:
// a writer that kept its handle across the image section's creation rewrites the file afterwards,
// so the bytes read later are not the bytes mapped). The file's ChangeTime (FILE_BASIC_INFO, 100 ns
// units since 1601, as the process creation time is) must be present, positive and strictly before
// the creation time: the same instant is taken as after (the deny direction; both clocks tick
// coarsely, so a change in the creation's tick cannot be ordered). On NTFS and ReFS a data write,
// SetFileTime and a rename all move ChangeTime. LastWriteTime is not judged: an honest file can
// carry one in the future (a ZIP's DOS local time unpacked in another time zone, a copy from a
// machine whose clock ran ahead), and a writer who can set ChangeTime back can set LastWriteTime
// back as well, so it would refuse honest files and catch nothing more. Anything missing is false.
// A file system that does not keep ChangeTime would not be covered, but the hold already requires
// NTFS or ReFS (a stable file id). Residual risk: a writer with FILE_WRITE_ATTRIBUTES can set
// ChangeTime back, and a rewrite made before the process object was created (after the section
// was) is older than the creation; neither is caught here.
// The times of FILE_BASIC_INFO this reads (LastWriteTime is carried so the harness can show it is
// not judged).
struct WindowsImageFileTimes {
  std::int64_t change_time = 0;
  std::int64_t last_write_time = 0;
};

[[nodiscard]] inline bool WindowsImageUnchangedSinceCreation(
    const std::optional<WindowsImageFileTimes> &times,
    std::optional<std::uint64_t> process_creation) {
  if (!times.has_value() || !process_creation.has_value() || times->change_time <= 0)
    return false;
  return static_cast<std::uint64_t>(times->change_time) < *process_creation;
}

// The v2 package identity (S5-c-3, #500 PR-4). A package target's native identity digest is
// sha256 of this preimage: the domain, the package family, the publisherId and the image's path
// inside the package's install location (ASCII case folded), one per line. The version lives in
// the install directory's name, so it is left out and an ordinary Store update keeps the digest;
// the family and the publisherId come from the process handle and bind who published it.
// Only a Store or System signed package that is not in development mode, whose image is under
// the windows_apps root and under its own install location, has one. Everything else (Developer,
// Enterprise and sideloaded packages, development mode, a package outside WindowsApps, anything
// unread) gets std::nullopt and keeps the Win32 identity. The family must end in "_" plus the
// publisherId, and none of the three may carry a separator the preimage uses. Mirrored by
// computerAppNativeIdentityDigest (computer-use-grant-identity.ts).
inline constexpr std::string_view kWindowsPackageIdentityDomain = "computer-win-identity-v2-package";

struct WindowsPackageIdentityFacts {
  std::optional<bool> packaged;
  std::optional<std::string> signature_kind;
  std::optional<bool> development_mode;
  std::optional<std::string> family;
  std::optional<std::string> publisher_id;
  // The facts' imageRoot, the held image's canonical path and the package's canonical install
  // location (GetPackagePathByFullName on the target's own full name).
  std::optional<std::string> image_root;
  std::optional<std::string> image_path;
  std::optional<std::string> install_root;
};

struct WindowsPackageIdentityParts {
  std::string family;
  std::string publisher_id;
  std::string relative_path;
  std::string preimage;
};

namespace windows_target_facts_detail {

// A publisherId: 13 characters of lower-case letters and digits.
[[nodiscard]] inline bool IsPackagePublisherId(std::string_view value) {
  if (value.size() != 13) return false;
  for (const char letter : value)
    if (!((letter >= 'a' && letter <= 'z') || (letter >= '0' && letter <= '9'))) return false;
  return true;
}

// A package family name: a package name (3 to 50 of letters, digits, '.' and '-'), '_', and the
// publisherId.
[[nodiscard]] inline bool IsPackageFamilyOf(std::string_view family, std::string_view publisher) {
  if (family.size() < publisher.size() + 4 || family.size() > publisher.size() + 51) return false;
  const std::size_t name_length = family.size() - publisher.size() - 1;
  if (family[name_length] != '_' || family.substr(name_length + 1) != publisher) return false;
  for (const char letter : family.substr(0, name_length))
    if (!((letter >= 'a' && letter <= 'z') || (letter >= 'A' && letter <= 'Z') ||
          (letter >= '0' && letter <= '9') || letter == '.' || letter == '-'))
      return false;
  return true;
}

} // namespace windows_target_facts_detail

[[nodiscard]] inline std::optional<WindowsPackageIdentityParts>
WindowsPackageIdentityFor(const WindowsPackageIdentityFacts &facts) {
  using namespace windows_target_facts_detail;
  if (!facts.packaged.has_value() || !*facts.packaged || !facts.signature_kind.has_value() ||
      (*facts.signature_kind != "store" && *facts.signature_kind != "system") ||
      !facts.development_mode.has_value() || *facts.development_mode ||
      !facts.family.has_value() || !facts.publisher_id.has_value() ||
      !facts.image_root.has_value() || *facts.image_root != "windows_apps" ||
      !facts.image_path.has_value() || !facts.install_root.has_value() ||
      facts.install_root->empty())
    return std::nullopt;
  if (!IsPackagePublisherId(*facts.publisher_id) ||
      !IsPackageFamilyOf(*facts.family, *facts.publisher_id))
    return std::nullopt;
  const WindowsImageRootPrefix own[] = {{"windows_apps", *facts.install_root}};
  const WindowsImagePlacement placement = PlaceWindowsImage(*facts.image_path, own);
  if (placement.root != "windows_apps" || placement.relative_path.empty() ||
      placement.relative_path.size() > 4'096 || IsSeparator(placement.relative_path.front()))
    return std::nullopt;
  std::string relative;
  relative.reserve(placement.relative_path.size());
  for (const char letter : placement.relative_path) {
    if (static_cast<unsigned char>(letter) < 0x20 || letter == 0x7f) return std::nullopt;
    relative += AsciiFold(letter);
  }
  WindowsPackageIdentityParts parts{*facts.family, *facts.publisher_id, std::move(relative), {}};
  parts.preimage = std::string(kWindowsPackageIdentityDomain) + "\n" + parts.family + "\n" +
                   parts.publisher_id + "\n" + parts.relative_path;
  return parts;
}

// ---- S5-c-3 PR-5: the explicit table of targets that show no web content (ADR v2 section 3.2.5) ----

// A file as the volume knows it: the volume serial and the 128-bit file id, read from a handle.
struct WindowsFileKey {
  std::uint64_t volume_serial = 0;
  std::array<std::uint8_t, 16> file_id{};
  friend bool operator==(const WindowsFileKey &, const WindowsFileKey &) = default;
};

// The one entry of the table so far: System32's notepad.exe. Path relative to %WINDIR%, ASCII lower.
inline constexpr std::string_view kWindowsNotWebSystemNotepad = "system32\\notepad.exe";

// Whether the measured target is the table's entry, so its Document may be taken as showing no web
// content. Every condition is "there and true": the running image matched and was verified signed to
// the Microsoft root, it is not a package, it lies at %WINDIR%\System32\notepad.exe, and the held
// file is the very file that path names now (`table`, opened from the system directory by the host)
// and, once a session has recorded one (`session_recorded`), the file it recorded at its start
// (`recorded`). A copy of notepad.exe anywhere else, a Store Notepad, or a System32 notepad whose
// volume serial or file id changed since the session started (an OS update) is not the entry: false,
// and its Document stays a takeover. Nothing the app reports (a title, a framework, a class) is read.
[[nodiscard]] inline bool WindowsTargetIsNotWebByTable(const TargetFacts &facts,
                                                       const std::optional<WindowsFileKey> &held,
                                                       const std::optional<WindowsFileKey> &table,
                                                       const std::optional<WindowsFileKey> &recorded,
                                                       bool session_recorded) {
  if (!(facts.running_image_matches.has_value() && *facts.running_image_matches)) return false;
  if (!(facts.signature.has_value() && *facts.signature == "valid")) return false;
  if (!(facts.signer_microsoft_root.has_value() && *facts.signer_microsoft_root)) return false;
  if (!(facts.packaged.has_value() && !*facts.packaged)) return false;
  if (!(facts.image_root.has_value() && *facts.image_root == "windows_directory")) return false;
  if (!facts.image_relative_path.has_value() ||
      target_eligibility_detail::AsciiLower(*facts.image_relative_path) != kWindowsNotWebSystemNotepad)
    return false;
  if (!held.has_value() || !table.has_value() || !(*held == *table)) return false;
  if (session_recorded && !(recorded.has_value() && *recorded == *held)) return false;
  return true;
}

} // namespace sprint_coder::computer_use
