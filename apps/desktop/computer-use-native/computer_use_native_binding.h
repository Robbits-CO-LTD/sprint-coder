#pragma once

// Pure, portable (C++20) canonical framing for the native dispatch binding.
// This header deliberately has no CommonCrypto, Objective-C, N-API or hash
// implementation: it only turns already-parsed values into an unambiguous byte
// string. The caller hashes that byte string with its own digest primitive.
// It must stay compilable by MSVC (/W4 /sdl) and clang without platform headers.
//
// Framing rules (every field is self-delimiting, so a fixed schema per kind
// makes the encoding injective):
//   * integers and every length/count prefix are 8 bytes, big-endian;
//   * a bool is one byte (0 or 1);
//   * a string is an 8-byte length followed by its bytes;
//   * an optional string is a presence byte, followed by the string only when
//     present, so "absent" and "present but empty" never collide;
//   * a double is its IEEE-754 bit pattern with -0 normalized to +0; NaN and
//     infinities are never encoded, the writer becomes invalid (fail closed);
//   * a vector keeps its order; a std::set is iterated in its fixed order.

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <set>
#include <string>
#include <string_view>
#include <vector>

namespace sprint_coder::computer_use {

// Upper bound for a Task/Turn id in bytes. contracts idSchema allows 128 UTF-16
// code units, which is at most 384 UTF-8 bytes. The Main side also derives
// "computer-turn:" + sessionId, and the native sessionId is itself capped at 256
// bytes, so every reachable id is at most 270 bytes. 512 covers all of them.
constexpr std::size_t kNativeBindingMaxIdBytes = 512;

constexpr std::string_view kNativeBindingPayloadDomain =
    "computer-native-dispatch-payload-v1";
constexpr std::string_view kNativeBindingContextDomain =
    "computer-native-dispatch-context-v1";
constexpr std::string_view kNativeBindingEnvelopeDomain =
    "computer-native-dispatch-envelope-v2";

// NOT attested: this is a fixed label for the built-in rule set, not a binding
// that satisfies the ADR S4-4 ruleset requirement. It must not be read as proof
// that a ruleset was verified. Native also does not detect Turn switches; the
// task/turn ids are only the values captured when the session was created.
constexpr std::string_view kNativeBindingRulesetPlaceholder = "v1-builtin";

static_assert(sizeof(double) == sizeof(std::uint64_t) &&
                  std::numeric_limits<double>::is_iec559,
              "The canonical double framing requires IEEE-754 binary64.");

class NativeBindingWriter {
public:
  explicit NativeBindingWriter(std::string_view domain) { String(domain); }

  void U64(std::uint64_t value) {
    for (int shift = 56; shift >= 0; shift -= 8)
      bytes_.push_back(static_cast<char>((value >> shift) & 0xffu));
  }

  void I32(std::int32_t value) {
    U64(static_cast<std::uint64_t>(static_cast<std::int64_t>(value)));
  }

  void Bool(bool value) { bytes_.push_back(value ? '\1' : '\0'); }

  void Double(double value) {
    if (!std::isfinite(value)) {
      valid_ = false;
      U64(0);
      return;
    }
    // -0 and +0 compare equal, so they must encode identically.
    std::uint64_t bits = 0;
    if (value != 0.0)
      std::memcpy(&bits, &value, sizeof(bits));
    U64(bits);
  }

  void String(std::string_view value) {
    U64(static_cast<std::uint64_t>(value.size()));
    bytes_.append(value);
  }

  void OptionalString(bool present, std::string_view value) {
    Bool(present);
    if (present)
      String(value);
  }

  void StringList(const std::vector<std::string> &values) {
    U64(static_cast<std::uint64_t>(values.size()));
    for (const auto &value : values)
      String(value);
  }

  void StringSet(const std::set<std::string> &values) {
    U64(static_cast<std::uint64_t>(values.size()));
    for (const auto &value : values)
      String(value);
  }

  void Invalidate() noexcept { valid_ = false; }
  [[nodiscard]] bool valid() const noexcept { return valid_; }
  [[nodiscard]] const std::string &bytes() const noexcept { return bytes_; }

private:
  std::string bytes_;
  bool valid_ = true;
};

// A Task/Turn id is required, bounded and free of NUL. Empty never validates.
[[nodiscard]] inline bool IsValidNativeBindingId(std::string_view value) {
  return !value.empty() && value.size() <= kNativeBindingMaxIdBytes &&
         value.find('\0') == std::string_view::npos;
}

// Session reuse requires both pairs to be valid and identical.
[[nodiscard]] inline bool
NativeBindingIdsMatch(std::string_view session_task_id,
                      std::string_view session_turn_id,
                      std::string_view requested_task_id,
                      std::string_view requested_turn_id) {
  return IsValidNativeBindingId(session_task_id) &&
         IsValidNativeBindingId(session_turn_id) &&
         IsValidNativeBindingId(requested_task_id) &&
         IsValidNativeBindingId(requested_turn_id) &&
         session_task_id == requested_task_id &&
         session_turn_id == requested_turn_id;
}

struct NativeBindingBounds {
  double x = 0;
  double y = 0;
  double width = 0;
  double height = 0;
};

inline void AppendNativeBindingBounds(NativeBindingWriter &writer,
                                      const NativeBindingBounds &bounds) {
  writer.Double(bounds.x);
  writer.Double(bounds.y);
  writer.Double(bounds.width);
  writer.Double(bounds.height);
}

// The payload is closed over the request itself, so it can be framed before any
// session lock is taken. Each kind has its own fixed field set; fields that a
// kind does not use are not encoded.
struct NativeBindingPayload {
  std::string_view kind;
  std::string_view target_id;
  std::string_view text;
  std::string_view selected_value;
  std::string_view key;
  bool boolean_value = false;
  double x = 0;
  double y = 0;
  std::int32_t delta_x = 0;
  std::int32_t delta_y = 0;
};

[[nodiscard]] inline bool
BuildNativeBindingPayloadInput(const NativeBindingPayload &payload,
                               std::string *output) {
  if (output == nullptr)
    return false;
  NativeBindingWriter writer(kNativeBindingPayloadDomain);
  writer.String(payload.kind);
  const bool semantic = payload.kind == "invoke" ||
                        payload.kind == "set_text" ||
                        payload.kind == "select" ||
                        payload.kind == "toggle" ||
                        payload.kind == "expand_collapse";
  if (semantic) {
    if (payload.target_id.empty())
      return false;
    writer.String(payload.target_id);
    if (payload.kind == "set_text")
      writer.String(payload.text);
    else if (payload.kind == "select")
      writer.String(payload.selected_value);
    else if (payload.kind == "toggle" || payload.kind == "expand_collapse")
      writer.Bool(payload.boolean_value);
  } else if (payload.kind == "click") {
    writer.Double(payload.x);
    writer.Double(payload.y);
  } else if (payload.kind == "scroll") {
    writer.Double(payload.x);
    writer.Double(payload.y);
    writer.I32(payload.delta_x);
    writer.I32(payload.delta_y);
  } else if (payload.kind == "type") {
    writer.String(payload.text);
  } else if (payload.kind == "key") {
    writer.String(payload.key);
  } else {
    return false;
  }
  if (!writer.valid())
    return false;
  *output = writer.bytes();
  return true;
}

// Only values the request supplied, values fixed when the session was created,
// and the observation snapshot read under the session state lock belong here.
// Moving state (session cancel epoch, closed flag, input attempt counters,
// observation publication state, the process-wide cancellation epoch, or a
// re-read of the live process generation) must never be added: a replay of the
// same request has to produce the same context.
struct NativeBindingContext {
  std::string_view app_identity;
  std::string_view window_identity;
  std::string_view process_generation;
  std::uint32_t window_id = 0;
  NativeBindingBounds expected_bounds;
  std::uint64_t observation_revision = 0;
  std::uint64_t dialog_set_revision = 0;
  std::string_view dialog_set_digest;
  std::string_view active_window_identity;
  std::string_view active_window_kind;
  std::uint32_t active_window_id = 0;
  NativeBindingBounds observation_bounds;
  std::string_view focused_control_signature;
  bool has_expected_target_signature = false;
  std::string_view expected_target_signature;
  const std::set<std::string> *visual_control_signatures = nullptr;
  const std::vector<std::string> *visual_patch_digests = nullptr;
  std::string_view task_id;
  std::string_view turn_id;
  std::uint32_t classifier_version = 0;
};

[[nodiscard]] inline bool
BuildNativeBindingContextInput(const NativeBindingContext &context,
                               std::string *output) {
  if (output == nullptr || context.visual_control_signatures == nullptr ||
      context.visual_patch_digests == nullptr ||
      !IsValidNativeBindingId(context.task_id) ||
      !IsValidNativeBindingId(context.turn_id))
    return false;
  NativeBindingWriter writer(kNativeBindingContextDomain);
  writer.String(context.app_identity);
  writer.String(context.window_identity);
  writer.String(context.process_generation);
  writer.U64(context.window_id);
  AppendNativeBindingBounds(writer, context.expected_bounds);
  writer.U64(context.observation_revision);
  writer.U64(context.dialog_set_revision);
  writer.String(context.dialog_set_digest);
  writer.String(context.active_window_identity);
  writer.String(context.active_window_kind);
  writer.U64(context.active_window_id);
  AppendNativeBindingBounds(writer, context.observation_bounds);
  writer.String(context.focused_control_signature);
  writer.OptionalString(context.has_expected_target_signature,
                        context.expected_target_signature);
  writer.StringSet(*context.visual_control_signatures);
  writer.StringList(*context.visual_patch_digests);
  writer.String(context.task_id);
  writer.String(context.turn_id);
  writer.U64(context.classifier_version);
  writer.String(kNativeBindingRulesetPlaceholder);
  if (!writer.valid())
    return false;
  *output = writer.bytes();
  return true;
}

// action_digest stays in the envelope because Main correlates results by it.
[[nodiscard]] inline bool BuildNativeBindingEnvelopeInput(
    std::string_view request_id, std::string_view session_id,
    std::string_view action_digest, std::string_view payload_digest,
    std::string_view context_digest, std::uint64_t cancel_epoch,
    std::uint64_t observation_revision, std::string *output) {
  if (output == nullptr || request_id.empty() || session_id.empty() ||
      action_digest.empty() || payload_digest.empty() || context_digest.empty())
    return false;
  NativeBindingWriter writer(kNativeBindingEnvelopeDomain);
  writer.String(request_id);
  writer.String(session_id);
  writer.String(action_digest);
  writer.String(payload_digest);
  writer.String(context_digest);
  writer.U64(cancel_epoch);
  writer.U64(observation_revision);
  if (!writer.valid())
    return false;
  *output = writer.bytes();
  return true;
}

} // namespace sprint_coder::computer_use
