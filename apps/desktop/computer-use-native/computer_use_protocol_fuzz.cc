#include "computer_use_protocol.h"

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <span>
#include <vector>

namespace {

using sprint_coder::computer_use::DecodeFrame;
using sprint_coder::computer_use::EncodeFrame;
using sprint_coder::computer_use::FrameHeader;
using sprint_coder::computer_use::MessageType;
using sprint_coder::computer_use::kMaxBinaryBytes;
using sprint_coder::computer_use::kMaxMetadataBytes;

bool Check(bool condition, const char *code) {
  if (condition)
    return true;
  std::cerr << "computer-use protocol harness failed: " << code << '\n';
  return false;
}

FrameHeader ValidHeader() {
  FrameHeader header{};
  header.message_type = static_cast<std::uint16_t>(MessageType::kObserveResult);
  header.request_id.bytes[0] = 1;
  header.session_id.bytes[0] = 2;
  return header;
}

std::uint32_t Next(std::uint32_t *state) {
  std::uint32_t value = *state;
  value ^= value << 13;
  value ^= value >> 17;
  value ^= value << 5;
  *state = value;
  return value;
}

} // namespace

int main() {
  const std::array<std::uint8_t, 17> metadata = {
      '{', '"', 'o', 'p', 'e', 'r', 'a', 't', 'i', 'o', 'n', '"', ':', '"', 'x', '"', '}',
  };
  const std::array<std::uint8_t, 4> binary = {0, 1, 2, 3};
  const auto encoded = EncodeFrame(ValidHeader(), metadata, binary);
  if (!Check(!encoded.empty(), "encode-valid") ||
      !Check(DecodeFrame(encoded).has_value(), "decode-valid"))
    return 1;

  for (std::size_t length = 0; length < encoded.size(); ++length)
    if (!Check(!DecodeFrame(std::span(encoded).first(length)).has_value(), "truncation"))
      return 1;

  for (std::size_t index = 0; index < encoded.size(); ++index) {
    auto mutated = encoded;
    mutated[index] ^= static_cast<std::uint8_t>(0xa5u + index);
    (void)DecodeFrame(mutated);
  }

  auto oversized_metadata = encoded;
  std::uint32_t metadata_size = kMaxMetadataBytes + 1;
  std::memcpy(oversized_metadata.data() + 60, &metadata_size, sizeof(metadata_size));
  if (!Check(!DecodeFrame(oversized_metadata).has_value(), "metadata-bound"))
    return 1;
  auto oversized_binary = encoded;
  std::uint32_t binary_size = kMaxBinaryBytes + 1;
  std::memcpy(oversized_binary.data() + 64, &binary_size, sizeof(binary_size));
  if (!Check(!DecodeFrame(oversized_binary).has_value(), "binary-bound"))
    return 1;

  auto cancel_header = ValidHeader();
  cancel_header.message_type = static_cast<std::uint16_t>(MessageType::kCancel);
  if (!Check(EncodeFrame(cancel_header, metadata).empty(), "cancel-id-required"))
    return 1;
  cancel_header.cancel_id.bytes[0] = 3;
  if (!Check(!EncodeFrame(cancel_header, metadata).empty(), "cancel-id-valid"))
    return 1;

  std::vector<std::uint8_t> too_large_metadata(kMaxMetadataBytes + 1, 'x');
  std::vector<std::uint8_t> too_large_binary(kMaxBinaryBytes + 1, 0);
  if (!Check(EncodeFrame(ValidHeader(), {}).empty(), "empty-metadata") ||
      !Check(EncodeFrame(ValidHeader(), too_large_metadata).empty(), "encode-metadata-bound") ||
      !Check(EncodeFrame(ValidHeader(), metadata, too_large_binary).empty(),
             "encode-binary-bound"))
    return 1;

  std::uint32_t state = 0x3335a17u;
  for (std::size_t iteration = 0; iteration < 4'096; ++iteration) {
    const std::size_t length = Next(&state) % 1'025;
    std::vector<std::uint8_t> input(length);
    std::generate(input.begin(), input.end(), [&]() {
      return static_cast<std::uint8_t>(Next(&state));
    });
    (void)DecodeFrame(input);
  }

  std::cout << "Computer Use native protocol sanitizer harness: PASS\n";
  return 0;
}
