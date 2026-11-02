#pragma once

#include <array>
#include <cstdint>
#include <string_view>

namespace sprint_coder::computer_use {

struct WindowsDocumentViewer {
  std::string_view extension;
  std::string_view perceived_type;
  std::string_view prog_id;
  std::string_view verb;
  std::string_view executable;
  std::string_view command;
  std::string_view signer_sha256;
};

// No installation has supplied a verified tuple yet (ADR 2.5 / 4). An empty table
// deliberately permits nothing. Add measured tuples, version, pin and fixtures together.
inline constexpr std::uint32_t kWindowsDocumentViewerVersion = 1;
inline constexpr std::array<WindowsDocumentViewer, 0> kWindowsDocumentViewers{};

constexpr std::uint64_t WindowsViewerMix(std::uint64_t hash, std::string_view value) {
  for (const unsigned char byte : value) { hash ^= byte; hash *= 1099511628211ULL; }
  hash ^= 255U;
  return hash * 1099511628211ULL;
}
constexpr std::uint64_t WindowsViewerDigest() {
  auto hash = WindowsViewerMix(14695981039346656037ULL, "windows-document-viewers-v1");
  for (const auto &row : kWindowsDocumentViewers)
    for (const auto field : {row.extension, row.perceived_type, row.prog_id, row.verb,
                            row.executable, row.command, row.signer_sha256})
      hash = WindowsViewerMix(hash, field);
  for (int shift = 24; shift >= 0; shift -= 8) {
    hash ^= (kWindowsDocumentViewerVersion >> shift) & 255U;
    hash *= 1099511628211ULL;
  }
  return hash;
}
inline constexpr auto kWindowsDocumentViewerDigest = WindowsViewerDigest();
inline constexpr std::uint64_t kWindowsDocumentViewerDigestPinned = 0x10adf348d184174eULL;
static_assert(kWindowsDocumentViewerDigest == kWindowsDocumentViewerDigestPinned,
              "Review viewer changes and update the Windows version, digest and fixtures together.");

} // namespace sprint_coder::computer_use
