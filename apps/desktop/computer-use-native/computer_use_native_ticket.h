#pragma once

// Pure, portable (C++20) single-use "ordinary" ticket slot for the native
// preflight/dispatch pair. It has no platform header, hash, random source,
// clock or N-API code: the caller injects a monotonic clock value (nanoseconds)
// on every call and supplies an already generated token. It must stay
// compilable by MSVC (/W4 /sdl) and clang without platform headers.
//
// This is NOT an approval ticket. An approval ticket type is deliberately not
// defined here (out of scope until its own effect classifier exists); only the
// ordinary kind exists.
//
// Fail-closed rules:
//   * generation 0 and owner 0 are sentinels meaning "none". A ticket is never
//     issued with generation 0, and a 0 generation never matches anything;
//   * one slot per session. Issue replaces whatever was there, and a failed
//     Issue also clears the slot;
//   * Consume destroys the ticket before it returns whatever the outcome, so a
//     failed check still burns the ticket;
//   * the clock must not go backwards (now < issued is invalid) and the ticket
//     is invalid at now >= expires. TTL overflow fails the issue;
//   * the token is exactly 64 lowercase hex characters and is compared in
//     constant time; a different length never matches.

#include <cstddef>
#include <cstdint>
#include <limits>
#include <string>
#include <string_view>
#include <utility>

namespace sprint_coder::computer_use {

constexpr std::size_t kNativeOrdinaryTicketTokenChars = 64;

// Upper bound a caller may ever request, and the TTL native actually uses.
constexpr std::uint64_t kNativeOrdinaryTicketMaxTtlNs = 10'000'000'000ULL;
constexpr std::uint64_t kNativeOrdinaryTicketTtlNs = 5'000'000'000ULL;
static_assert(kNativeOrdinaryTicketTtlNs > 0 &&
                  kNativeOrdinaryTicketTtlNs <= kNativeOrdinaryTicketMaxTtlNs,
              "The ordinary ticket TTL must be positive and at most 10 seconds.");

struct NativeOrdinaryTicketBinding {
  std::string session_id;
  std::string request_id;
  std::string action_digest;
  std::string payload_digest;
  std::string context_digest;
  std::uint64_t cancel_epoch = 0;
  // 0 is the "none" sentinel and is never issued.
  std::uint64_t ticket_generation = 0;
};

[[nodiscard]] inline bool
NativeOrdinaryTicketBindingsEqual(const NativeOrdinaryTicketBinding &left,
                                  const NativeOrdinaryTicketBinding &right) {
  return left.session_id == right.session_id &&
         left.request_id == right.request_id &&
         left.action_digest == right.action_digest &&
         left.payload_digest == right.payload_digest &&
         left.context_digest == right.context_digest &&
         left.cancel_epoch == right.cancel_epoch &&
         left.ticket_generation == right.ticket_generation;
}

// 64 characters, lowercase hexadecimal only.
[[nodiscard]] inline bool
IsValidNativeOrdinaryTicketToken(std::string_view token) noexcept {
  if (token.size() != kNativeOrdinaryTicketTokenChars)
    return false;
  for (const char character : token) {
    const bool digit = character >= '0' && character <= '9';
    const bool lower = character >= 'a' && character <= 'f';
    if (!digit && !lower)
      return false;
  }
  return true;
}

// Fixed-length constant-time comparison: every one of the 64 bytes is visited
// whatever the content. Any other length is simply a mismatch.
[[nodiscard]] inline bool
NativeOrdinaryTicketTokensEqual(std::string_view left,
                                std::string_view right) noexcept {
  if (left.size() != kNativeOrdinaryTicketTokenChars ||
      right.size() != kNativeOrdinaryTicketTokenChars)
    return false;
  unsigned char difference = 0;
  for (std::size_t index = 0; index < kNativeOrdinaryTicketTokenChars; ++index) {
    const unsigned char a = static_cast<unsigned char>(left[index]);
    const unsigned char b = static_cast<unsigned char>(right[index]);
    difference = static_cast<unsigned char>(difference | (a ^ b));
  }
  return difference == 0;
}

// Best-effort wipe of a secret string before it is dropped.
inline void ScrubNativeTicketString(std::string *value) noexcept {
  if (value == nullptr)
    return;
  volatile char *bytes = value->data();
  for (std::size_t index = 0; index < value->size(); ++index)
    bytes[index] = '\0';
  value->clear();
}

// Not thread safe by itself: the owner serializes access (the macOS session
// state mutex). Move/copy are deleted so a secret is never duplicated.
class NativeOrdinaryTicketSlot {
public:
  NativeOrdinaryTicketSlot() = default;
  NativeOrdinaryTicketSlot(const NativeOrdinaryTicketSlot &) = delete;
  NativeOrdinaryTicketSlot &operator=(const NativeOrdinaryTicketSlot &) = delete;
  ~NativeOrdinaryTicketSlot() { Invalidate(); }

  // Replaces the slot. Any failure leaves the slot empty (fail closed).
  [[nodiscard]] bool Issue(std::string_view token,
                           NativeOrdinaryTicketBinding binding,
                           std::uint64_t now_ns, std::uint64_t ttl_ns) {
    Invalidate();
    if (!IsValidNativeOrdinaryTicketToken(token))
      return false;
    if (ttl_ns == 0 || ttl_ns > kNativeOrdinaryTicketMaxTtlNs)
      return false;
    if (now_ns > std::numeric_limits<std::uint64_t>::max() - ttl_ns)
      return false;
    if (binding.ticket_generation == 0)
      return false;
    if (binding.session_id.empty() || binding.request_id.empty() ||
        binding.action_digest.empty() || binding.payload_digest.empty() ||
        binding.context_digest.empty())
      return false;
    token_.assign(token.data(), token.size());
    binding_ = std::move(binding);
    issued_ns_ = now_ns;
    expires_ns_ = now_ns + ttl_ns;
    occupied_ = true;
    return true;
  }

  // Every check is evaluated and the slot is destroyed before any result is
  // returned (there is no early return after the slot is found occupied), so
  // every outcome, including a failed check, leaves the slot empty.
  [[nodiscard]] bool Consume(std::string_view presented_token,
                             const NativeOrdinaryTicketBinding &expected,
                             std::uint64_t now_ns) {
    if (!occupied_)
      return false;
    const bool token_ok =
        IsValidNativeOrdinaryTicketToken(presented_token) &&
        NativeOrdinaryTicketTokensEqual(token_, presented_token);
    const bool binding_ok =
        binding_.ticket_generation != 0 &&
        NativeOrdinaryTicketBindingsEqual(binding_, expected);
    const bool time_ok = now_ns >= issued_ns_ && now_ns < expires_ns_;
    Invalidate();
    return token_ok && binding_ok && time_ok;
  }

  void Invalidate() noexcept {
    ScrubNativeTicketString(&token_);
    binding_ = NativeOrdinaryTicketBinding{};
    issued_ns_ = 0;
    expires_ns_ = 0;
    occupied_ = false;
  }

  // Only drops a ticket that belongs to this exact generation (never 0).
  bool InvalidateIfGeneration(std::uint64_t ticket_generation) noexcept {
    if (ticket_generation == 0 || !occupied_ ||
        binding_.ticket_generation != ticket_generation)
      return false;
    Invalidate();
    return true;
  }

  [[nodiscard]] bool occupied() const noexcept { return occupied_; }
  [[nodiscard]] std::uint64_t generation() const noexcept {
    return occupied_ ? binding_.ticket_generation : 0;
  }

private:
  std::string token_;
  NativeOrdinaryTicketBinding binding_;
  std::uint64_t issued_ns_ = 0;
  std::uint64_t expires_ns_ = 0;
  bool occupied_ = false;
};

} // namespace sprint_coder::computer_use
