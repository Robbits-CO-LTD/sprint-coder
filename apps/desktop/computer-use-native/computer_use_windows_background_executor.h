#pragma once
#include <cstdint>
#include <charconv>
#include <cmath>
#include <limits>
#include <string_view>

#ifndef SPRINT_CODER_BACKGROUND_EXECUTOR_TEST
#define SPRINT_CODER_BACKGROUND_EXECUTOR_TEST 0
#endif

namespace windows_background_executor_detail {
enum class Preparation { kReady, kNoop, kHandoff, kRejected };
enum class Outcome { kCompleted, kAwaitingForegroundHandoff, kRejected, kUnknownEffect };

struct ScrollRequest {
  bool horizontal = false, absolute = false, increment = false, large = false;
  double percent = 0;
};
struct ScrollSnapshot {
  bool horizontal_scrollable = false, vertical_scrollable = false;
  double horizontal_percent = -1, vertical_percent = -1;
  double horizontal_view = 100, vertical_view = 100;
};
inline bool ScrollPercent(double value) { return std::isfinite(value) && value >= 0 && value <= 100; }
inline bool ParseScrollPercent(std::string_view token, double *percent) {
  const auto result = std::from_chars(token.data(), token.data() + token.size(), *percent);
  return result.ec == std::errc{} && result.ptr == token.data() + token.size() && ScrollPercent(*percent);
}
inline bool ParseScroll(std::string_view operation, std::string_view axis, std::string_view amount,
                        double percent, ScrollRequest *request) {
  if (axis != "horizontal" && axis != "vertical") return false;
  ScrollRequest parsed;
  parsed.horizontal = axis == "horizontal";
  if (operation == "set_scroll_percent") {
    if (!amount.empty() || !ScrollPercent(percent)) return false;
    parsed.absolute = true;
    parsed.percent = percent;
  } else if (operation == "scroll") {
    // A missing percent is represented only internally as NaN; wheel deltas are never units here.
    if (!std::isnan(percent)) return false;
    if (amount != "small_decrement" && amount != "large_decrement" &&
        amount != "small_increment" && amount != "large_increment") return false;
    parsed.increment = amount == "small_increment" || amount == "large_increment";
    parsed.large = amount == "large_decrement" || amount == "large_increment";
  } else return false;
  *request = parsed;
  return true;
}
inline bool ValidScrollSnapshot(const ScrollSnapshot &state) {
  return ScrollPercent(state.horizontal_view) && ScrollPercent(state.vertical_view) &&
      (state.horizontal_scrollable ? ScrollPercent(state.horizontal_percent) : state.horizontal_percent == -1) &&
      (state.vertical_scrollable ? ScrollPercent(state.vertical_percent) : state.vertical_percent == -1);
}
inline Preparation PrepareScroll(const ScrollRequest &request, const ScrollSnapshot &before) {
  if (!ValidScrollSnapshot(before)) return Preparation::kRejected;
  if (!(request.horizontal ? before.horizontal_scrollable : before.vertical_scrollable))
    return Preparation::kHandoff;
  const double position = request.horizontal ? before.horizontal_percent : before.vertical_percent;
  return request.absolute && position == request.percent ? Preparation::kNoop : Preparation::kReady;
}
inline bool ScrollMatches(const ScrollRequest &request, const ScrollSnapshot &before,
                          const ScrollSnapshot &after) {
  if (!ValidScrollSnapshot(after) ||
      before.horizontal_scrollable != after.horizontal_scrollable ||
      before.vertical_scrollable != after.vertical_scrollable ||
      before.horizontal_view != after.horizontal_view || before.vertical_view != after.vertical_view)
    return false;
  const double previous = request.horizontal ? before.horizontal_percent : before.vertical_percent;
  const double current = request.horizontal ? after.horizontal_percent : after.vertical_percent;
  const bool other_unchanged = request.horizontal ? before.vertical_percent == after.vertical_percent :
      before.horizontal_percent == after.horizontal_percent;
  return other_unchanged && (request.absolute ? current == request.percent && current != previous :
      (request.increment ? current > previous : current < previous));
}
template <class Scroll, class Amount, class Timed>
auto CallScroll(Scroll *scroll, const ScrollRequest &request, Amount none, Amount small_decrement,
                Amount large_decrement, Amount small_increment, Amount large_increment, Timed &&timed) {
  if (request.absolute) {
    const double horizontal_percent = request.horizontal ? request.percent : -1;
    const double vertical_percent = request.horizontal ? -1 : request.percent;
    return timed([&] { return scroll->SetScrollPercent(horizontal_percent, vertical_percent); });
  }
  const Amount amount = request.increment ? (request.large ? large_increment : small_increment) :
      (request.large ? large_decrement : small_decrement);
  const Amount horizontal = request.horizontal ? amount : none;
  const Amount vertical = request.horizontal ? none : amount;
  return timed([&] { return scroll->Scroll(horizontal, vertical); });
}

// The host supplies the V1 timed contact; each branch makes exactly one provider call.
// Text is the provider's own string type: the UIA adapter passes a SysAllocStringLen BSTR, never a
// std::wstring buffer (BSTR marshaling reads the length prefix before the pointer).
template <class Invoke, class Toggle, class Select, class Value, class Expand, class Text, class Timed,
          class Result>
Result CallPattern(Invoke *invoke, Toggle *toggle, Select *select, Value *value,
                   Expand *expand, Text text, bool desired, Timed &&timed, Result failure) {
  if (invoke) return timed([&] { return invoke->Invoke(); });
  if (toggle) return timed([&] { return toggle->Toggle(); });
  if (select) return timed([&] { return select->Select(); });
  if (value) return timed([&] { return value->SetValue(text); });
  if (expand) {
    if (desired) return timed([&] { return expand->Expand(); });
    return timed([&] { return expand->Collapse(); });
  }
  return failure;
}

// The adapter owns the bound element and the one chosen pattern. There is no alternate input path.
template <class Operations> Outcome RunBackgroundExecutor(Operations &ops) {
  std::uint64_t claim = 0;
  bool confirmed = false;
  try {
    if (!ops.Guard()) return Outcome::kRejected;
    const auto preparation = ops.Prepare();
    if (!ops.Guard()) return Outcome::kRejected;
    if (preparation == Preparation::kRejected) return Outcome::kRejected;
    if (preparation == Preparation::kHandoff) return Outcome::kAwaitingForegroundHandoff;
    if (preparation == Preparation::kNoop) return Outcome::kCompleted;
    claim = ops.Claim();
    if (claim == 0) return Outcome::kRejected;
    confirmed = ops.Call() && ops.Readback() && ops.Window();
  } catch (...) {
    if (claim == 0) return Outcome::kRejected;
  }
  // Finish always runs after a claimed call, even when the provider throws or readback fails.
  const bool finished = ops.Finish(claim, confirmed);
  return confirmed && finished ? Outcome::kCompleted : Outcome::kUnknownEffect;
}
} // namespace windows_background_executor_detail
