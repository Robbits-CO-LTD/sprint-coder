#pragma once

// A small portable SHA-256, so a digest that is part of an authority binding does not depend on a
// platform library and can be checked against published vectors in the harness. Not for secrets:
// it is not constant time and keeps no state between calls.

#include <array>
#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>

namespace sprint_coder::computer_use {

namespace sha256_detail {

inline constexpr std::array<std::uint32_t, 64> kRound = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};

[[nodiscard]] constexpr std::uint32_t Rotr(std::uint32_t value, unsigned count) {
  return (value >> count) | (value << (32 - count));
}

inline void Block(std::array<std::uint32_t, 8> &state, const unsigned char *block) {
  std::array<std::uint32_t, 64> w{};
  for (std::size_t index = 0; index < 16; ++index)
    w[index] = (static_cast<std::uint32_t>(block[index * 4]) << 24) |
               (static_cast<std::uint32_t>(block[index * 4 + 1]) << 16) |
               (static_cast<std::uint32_t>(block[index * 4 + 2]) << 8) |
               static_cast<std::uint32_t>(block[index * 4 + 3]);
  for (std::size_t index = 16; index < 64; ++index) {
    const std::uint32_t s0 = Rotr(w[index - 15], 7) ^ Rotr(w[index - 15], 18) ^ (w[index - 15] >> 3);
    const std::uint32_t s1 = Rotr(w[index - 2], 17) ^ Rotr(w[index - 2], 19) ^ (w[index - 2] >> 10);
    w[index] = w[index - 16] + s0 + w[index - 7] + s1;
  }
  std::uint32_t a = state[0], b = state[1], c = state[2], d = state[3];
  std::uint32_t e = state[4], f = state[5], g = state[6], h = state[7];
  for (std::size_t index = 0; index < 64; ++index) {
    const std::uint32_t s1 = Rotr(e, 6) ^ Rotr(e, 11) ^ Rotr(e, 25);
    const std::uint32_t choose = (e & f) ^ (~e & g);
    const std::uint32_t t1 = h + s1 + choose + kRound[index] + w[index];
    const std::uint32_t s0 = Rotr(a, 2) ^ Rotr(a, 13) ^ Rotr(a, 22);
    const std::uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
    const std::uint32_t t2 = s0 + majority;
    h = g;
    g = f;
    f = e;
    e = d + t1;
    d = c;
    c = b;
    b = a;
    a = t1 + t2;
  }
  state[0] += a;
  state[1] += b;
  state[2] += c;
  state[3] += d;
  state[4] += e;
  state[5] += f;
  state[6] += g;
  state[7] += h;
}

} // namespace sha256_detail

// Lowercase hex of the SHA-256 of `data`, 64 characters.
[[nodiscard]] inline std::string Sha256Hex(std::string_view data) {
  std::array<std::uint32_t, 8> state = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                                        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
  const auto *bytes = reinterpret_cast<const unsigned char *>(data.data());
  std::size_t offset = 0;
  while (data.size() - offset >= 64) {
    sha256_detail::Block(state, bytes + offset);
    offset += 64;
  }
  std::array<unsigned char, 128> tail{};
  const std::size_t rest = data.size() - offset;
  for (std::size_t index = 0; index < rest; ++index) tail[index] = bytes[offset + index];
  tail[rest] = 0x80;
  const std::size_t total = rest + 1 + 8 <= 64 ? 64 : 128;
  const std::uint64_t bits = static_cast<std::uint64_t>(data.size()) * 8;
  for (std::size_t index = 0; index < 8; ++index)
    tail[total - 1 - index] = static_cast<unsigned char>(bits >> (8 * index));
  for (std::size_t index = 0; index < total; index += 64)
    sha256_detail::Block(state, tail.data() + index);
  static constexpr char kHex[] = "0123456789abcdef";
  std::string output(64, '0');
  for (std::size_t word = 0; word < 8; ++word)
    for (std::size_t byte = 0; byte < 4; ++byte) {
      const unsigned char value = static_cast<unsigned char>(state[word] >> (24 - 8 * byte));
      output[word * 8 + byte * 2] = kHex[value >> 4];
      output[word * 8 + byte * 2 + 1] = kHex[value & 0xf];
    }
  return output;
}

} // namespace sprint_coder::computer_use
