#pragma once

// The Computer Use native boundary deliberately has a small, dependency-free
// framing contract.  The broker owns all policy; the native boundary only
// authenticates the caller/session and performs bounded, cancellable platform
// work.  Keep this header usable from both the macOS N-API module and the
// Windows helper.

#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <optional>
#include <span>
#include <string_view>
#include <vector>

namespace sprint_coder::computer_use {

constexpr bool IsTypeTextScalar(std::uint32_t scalar) noexcept {
  return scalar >= 0x20 && scalar <= 0x10ffff &&
         !(scalar >= 0x7f && scalar <= 0x9f) &&
         !(scalar >= 0xd800 && scalar <= 0xdfff) &&
         !(scalar >= 0xf700 && scalar <= 0xf8ff);
}

constexpr std::uint16_t kProtocolVersion = 1;
constexpr std::uint16_t kApiVersion = 1;
constexpr std::uint32_t kMaxMetadataBytes = 64 * 1024;
constexpr std::uint32_t kMaxBinaryBytes = 16 * 1024 * 1024;
constexpr std::uint32_t kMaxFrameBytes = kMaxMetadataBytes + kMaxBinaryBytes;
constexpr std::uint32_t kMagic =
    0x31554353; // ASCII "SCU1" in little-endian order.
constexpr std::uint16_t kCancelMessageType = 9;

struct FrameId {
  std::array<std::uint8_t, 16> bytes{};

  [[nodiscard]] bool IsZero() const noexcept {
    for (const auto value : bytes)
      if (value != 0)
        return false;
    return true;
  }
};

// This is intentionally packed and fixed-width.  Do not add pointers, strings,
// or platform handles to the wire header.  All platform-specific values belong
// in the bounded metadata or binary section. Metadata is UTF-8 JSON; binary is
// an opaque image/capture payload.
#pragma pack(push, 1)
struct FrameHeader {
  std::uint32_t magic = kMagic;
  std::uint16_t protocol_version = kProtocolVersion;
  std::uint16_t message_type = 0;
  std::uint32_t flags = 0;
  FrameId request_id{};
  FrameId session_id{};
  FrameId cancel_id{};
  std::uint32_t metadata_bytes = 0;
  std::uint32_t binary_bytes = 0;
};
#pragma pack(pop)

static_assert(sizeof(FrameHeader) == 68,
              "Computer Use native frame header drifted");

enum class MessageType : std::uint16_t {
  kHandshake = 1,
  kHandshakeResult = 2,
  kProbe = 3,
  kProbeResult = 4,
  kObserve = 5,
  kObserveResult = 6,
  kDispatch = 7,
  kDispatchResult = 8,
  kCancel = 9,
  kError = 10,
};

struct Frame {
  FrameHeader header{};
  std::vector<std::uint8_t> metadata;
  std::vector<std::uint8_t> binary;
};

[[nodiscard]] inline bool IsKnownMessageType(std::uint16_t value) noexcept {
  return value >= static_cast<std::uint16_t>(MessageType::kHandshake) &&
         value <= static_cast<std::uint16_t>(MessageType::kError);
}

[[nodiscard]] inline bool ValidateHeader(const FrameHeader &header) noexcept {
  const bool cancel_message = header.message_type == kCancelMessageType;
  return header.magic == kMagic &&
         header.protocol_version == kProtocolVersion &&
         IsKnownMessageType(header.message_type) &&
         header.metadata_bytes <= kMaxMetadataBytes &&
         header.binary_bytes <= kMaxBinaryBytes &&
         !header.request_id.IsZero() && !header.session_id.IsZero() &&
         (cancel_message != header.cancel_id.IsZero());
}

[[nodiscard]] inline std::optional<Frame>
DecodeFrame(std::span<const std::uint8_t> encoded) {
  if (encoded.size() < sizeof(FrameHeader))
    return std::nullopt;
  Frame frame;
  std::memcpy(&frame.header, encoded.data(), sizeof(FrameHeader));
  if (!ValidateHeader(frame.header))
    return std::nullopt;
  const auto metadata_size =
      static_cast<std::size_t>(frame.header.metadata_bytes);
  const auto binary_size = static_cast<std::size_t>(frame.header.binary_bytes);
  if (metadata_size > kMaxMetadataBytes || binary_size > kMaxBinaryBytes ||
      encoded.size() != sizeof(FrameHeader) + metadata_size + binary_size)
    return std::nullopt;
  const auto metadata_begin =
      encoded.begin() + static_cast<std::ptrdiff_t>(sizeof(FrameHeader));
  const auto binary_begin =
      metadata_begin + static_cast<std::ptrdiff_t>(metadata_size);
  frame.metadata.assign(metadata_begin, binary_begin);
  frame.binary.assign(binary_begin, encoded.end());
  return frame;
}

[[nodiscard]] inline std::vector<std::uint8_t>
EncodeFrame(FrameHeader header, std::span<const std::uint8_t> metadata,
            std::span<const std::uint8_t> binary = {}) {
  if (metadata.empty() || metadata.size() > kMaxMetadataBytes ||
      binary.size() > kMaxBinaryBytes)
    return {};
  header.magic = kMagic;
  header.protocol_version = kProtocolVersion;
  header.metadata_bytes = static_cast<std::uint32_t>(metadata.size());
  header.binary_bytes = static_cast<std::uint32_t>(binary.size());
  if (!ValidateHeader(header))
    return {};
  std::vector<std::uint8_t> encoded(sizeof(FrameHeader) + metadata.size() +
                                    binary.size());
  std::memcpy(encoded.data(), &header, sizeof(FrameHeader));
  std::memcpy(encoded.data() + sizeof(FrameHeader), metadata.data(),
              metadata.size());
  if (!binary.empty())
    std::memcpy(encoded.data() + sizeof(FrameHeader) + metadata.size(),
                binary.data(), binary.size());
  return encoded;
}

// Metadata is UTF-8 JSON only after the outer binary frame has been
// authenticated and bounded. The native boundary never evaluates metadata as
// code or accepts a second action.
[[nodiscard]] inline bool
IsBoundedUtf8(std::span<const std::uint8_t> metadata) noexcept {
  if (metadata.empty() || metadata.size() > kMaxMetadataBytes)
    return false;
  for (std::size_t index = 0; index < metadata.size();) {
    const std::uint8_t first = metadata[index];
    if (first == 0)
      return false;
    std::uint32_t scalar = 0;
    std::size_t width = 0;
    if (first <= 0x7f) {
      scalar = first;
      width = 1;
    } else if (first >= 0xc2 && first <= 0xdf) {
      scalar = first & 0x1f;
      width = 2;
    } else if (first >= 0xe0 && first <= 0xef) {
      scalar = first & 0x0f;
      width = 3;
    } else if (first >= 0xf0 && first <= 0xf4) {
      scalar = first & 0x07;
      width = 4;
    } else {
      return false;
    }
    if (index + width > metadata.size())
      return false;
    for (std::size_t offset = 1; offset < width; ++offset) {
      const std::uint8_t byte = metadata[index + offset];
      if ((byte & 0xc0) != 0x80)
        return false;
      scalar = (scalar << 6) | (byte & 0x3f);
    }
    if ((width == 2 && scalar < 0x80) || (width == 3 && scalar < 0x800) ||
        (width == 4 && scalar < 0x10000) || scalar > 0x10ffff ||
        (scalar >= 0xd800 && scalar <= 0xdfff))
      return false;
    index += width;
  }
  return true;
}

} // namespace sprint_coder::computer_use
