#pragma once
#include <cstdint>

#ifndef SPRINT_CODER_BACKGROUND_EXECUTOR_TEST
#define SPRINT_CODER_BACKGROUND_EXECUTOR_TEST 0
#endif

namespace windows_background_executor_detail {
enum class Preparation { kReady, kNoop, kHandoff, kRejected };
enum class Outcome { kCompleted, kAwaitingForegroundHandoff, kRejected, kUnknownEffect };

// The host supplies the V1 timed contact; each branch makes exactly one provider call.
template <class Invoke, class Toggle, class Select, class Value, class Expand, class Timed, class Result>
Result CallPattern(Invoke *invoke, Toggle *toggle, Select *select, Value *value,
                   Expand *expand, const wchar_t *text, bool desired, Timed &&timed, Result failure) {
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
