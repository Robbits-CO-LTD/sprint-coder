#pragma once
#include "computer_use_windows_approval_round_trip.h"
#include <iostream>

inline bool CheckApprovalRoundTripState() {
  using namespace sprint_coder::computer_use;
  using State = WindowsApprovalRoundTrip;
  using Focus = ApprovalRoundTripFocus;
  const ApprovalRoundTripBinding binding{"trip-1", "session-1", "task-1", "turn-1", 1, 0};
  const auto check = [](bool value, const char *name) {
    if (!value) std::cerr << name << '\n';
    return value;
  };
  const auto begin = [&](State &s, std::uint64_t duration = 60000,
                         std::uint64_t remaining = 60000) {
    return s.Begin(binding, 100, duration, remaining, 7, 3, true);
  };
  {
    State s;
    if (!check(!s.Begin(binding, 100, 60000, 60000, 7, 3, false) && !s.FocusException(),
               "RT_begin_ack_precedes_focus_exception")) return false;
  }
  {
    State s;
    if (!check(!s.FocusException() && s.MayInput(100), "RT_begin_ack_precedes_focus_exception")) return false;
    if (!check(begin(s) && s.FocusException() && !s.MayInput(100), "RT_begin_ack_precedes_focus_exception")) return false;
    for (auto focus : {Focus::kTarget, Focus::kSprintCoder, Focus::kTarget}) {
      s.Observe(focus, true, true, 101);
      if (!check(s.FocusException() && !s.MayInput(101), "RT_allowed_focus_does_not_disable_other_guards")) return false;
    }
    s.Observe(Focus::kTarget, true, false, 102);
    if (!check(s.Failed() && !s.Return(binding, 102), "RT_allowed_focus_does_not_disable_other_guards")) return false;
  }
  for (auto focus : {Focus::kOther, Focus::kShell, Focus::kExplorer, Focus::kDesktop}) {
    State s;
    if (!begin(s)) return false;
    s.Observe(focus, true, true, 101);
    s.Observe(Focus::kTarget, true, true, 102);
    if (!check(s.Failed() && !s.Return(binding, 102) && !s.Exchange(binding, 8, 4, 102),
               "RT_third_window_failure_is_native_latched")) return false;
    if (!check(!s.End(binding, true, 102) && s.Failed() && !s.MayLegacyStart() && !s.MayInput(102),
               "RT_end_first_cannot_unlock_legacy_start")) return false;
  }
  {
    State s;
    if (!begin(s)) return false;
    if (!check(!s.End(binding, true, 101) && s.Failed() && !s.MayLegacyStart(),
               "RT_end_first_cannot_unlock_legacy_start")) return false;
  }
  for (int field = 0; field < 6; ++field) {
    State s;
    if (!begin(s)) return false;
    auto wrong = binding;
    if (field == 0) wrong.id = "other";
    if (field == 1) wrong.session = "other";
    if (field == 2) wrong.task = "other";
    if (field == 3) wrong.turn = "other";
    if (field == 4) ++wrong.generation;
    if (field == 5) ++wrong.epoch;
    if (!check(!s.Return(wrong, 101) && s.Failed(), "RT_id_binding")) return false;
  }
  {
    State s;
    if (!begin(s)) return false;
    auto missing = binding;
    missing.id.clear();
    if (!check(!s.Return(missing, 101) && s.Failed(), "RT_missing_ended_failed_id_rejected")) return false;
  }
  for (const auto *reason : {"stopped", "generation_changed", "target_changed", "dialog_changed"}) {
    State s;
    if (!begin(s)) return false;
    s.Invalidate(reason);
    if (!check(!s.End(binding, true, 101) && !s.Return(binding, 101) &&
               !s.Exchange(binding, 8, 4, 101) && s.Failure() == reason,
               "RT_allowed_focus_does_not_disable_other_guards")) return false;
  }
  for (auto duration : {0ULL, 60001ULL}) {
    State s;
    if (!check(!begin(s, duration), "RT_duration_uses_native_monotonic_clock")) return false;
  }
  {
    State s;
    if (!check(!begin(s, 60000, 59999), "RT_duration_uses_native_monotonic_clock")) return false;
  }
  {
    State s;
    if (!begin(s)) return false;
    s.Observe(Focus::kTarget, true, true, 60099);
    if (!check(!s.Failed(), "RT_duration_uses_native_monotonic_clock")) return false;
    s.Observe(Focus::kTarget, true, true, 60100);
    // P3d cancels the Main card; this native half must deny return/exchange at 60 seconds.
    if (!check(s.Failed() && !s.Return(binding, 60100) && !s.Exchange(binding, 8, 4, 60100),
               "RT_v1_timeout_cancels_pending_card_native_boundary")) return false;
  }
  {
    State s;
    if (!begin(s)) return false;
    s.Observe(Focus::kTarget, true, true, 99);
    if (!check(s.Failed(), "RT_duration_uses_native_monotonic_clock")) return false;
  }
  {
    State s;
    if (!begin(s)) return false;
    s.Observe(Focus::kTarget, false, true, 101);
    if (!check(s.Failed() && !s.Return(binding, 102), "RT_foreground_monitor_heartbeat_failure_latches")) return false;
  }
  {
    State s;
    if (!begin(s)) return false;
    if (!check(!s.Exchange(binding, 8, 4, 101), "RT_return_requires_fresh_authority_before_exchange")) return false;
  }
  for (bool stale_observation : {false, true}) {
    State s;
    if (!begin(s) || !s.Return(binding, 101) || !s.Returned(binding, 101)) return false;
    if (!check(!s.Exchange(binding, stale_observation ? 7 : 8, stale_observation ? 4 : 3, 102),
               "RT_return_requires_fresh_authority_before_exchange")) return false;
  }
  {
    State s;
    if (!begin(s) || !s.Return(binding, 101) || !s.Returned(binding, 101) ||
        !s.Exchange(binding, 8, 4, 102)) return false;
    if (!check(!s.MayInput(102) && !s.MayObserve(), "RT_rejected_input_never_replays")) return false;
    if (!check(s.End(binding, true, 103) && s.MayInput(103) && !s.MayObserve(),
               "RT_return_requires_fresh_authority_before_exchange")) return false;
    if (!check(!s.Return(binding, 104) && !s.MayLegacyStart(), "RT_missing_ended_failed_id_rejected")) return false;
  }
  {
    State s;
    if (!begin(s) || !s.Return(binding, 101) || !s.Returned(binding, 101) ||
        !s.Exchange(binding, 8, 4, 102) || !s.End(binding, true, 103)) return false;
    s.InputFinished();
    if (!check(s.MayObserve() && !begin(s), "RT_rejected_input_never_replays")) return false;
    auto next = binding;
    next.id = "trip-2";
    if (!check(s.Begin(next, 104, 60000, 60000, 8, 4, true),
               "RT_foreground_has_no_interaction_epoch")) return false;
  }
  {
    State s;
    if (!begin(s) || !s.Return(binding, 101) || !s.Returned(binding, 102)) return false;
    bool completed = false;
    {
      WindowsRoundTripPreflightGuard guard{&s, completed};
      completed = s.Offer(binding, 8, 103);
    }
    s.Observe(Focus::kSprintCoder, true, true, 104);
    if (!check(completed && !s.Failed() && !s.MayInput(104) && !s.MayLegacyStart() &&
        s.MayBegin() && !s.Begin(binding, 104, 60000, 60000, 8, 4, true),
        "RT_native_offer_closes_first_trip_without_input_or_id_reuse")) return false;
    auto next = binding;
    next.id = "trip-2";
    if (!check(s.Begin(next, 105, 60000, 60000, 8, 4, true) &&
        s.Return(next, 106) && s.Returned(next, 107) && s.Exchange(next, 9, 5, 108) &&
        s.End(next, true, 109) && s.MayInput(109), "RT_two_cards_to_ordinary")) return false;
  }
  for (const auto *route : {"replay", "binding_denied", "refuse", "interlock_refusal", "invalid_action"}) {
    State s;
    if (!begin(s) || !s.Return(binding, 101) || !s.Returned(binding, 102)) return false;
    const bool completed = false;
    { WindowsRoundTripPreflightGuard guard{&s, completed}; }
    if (!check(s.Failed() && !s.MayBegin() && !s.MayInput(103) &&
        !s.Exchange(binding, 8, 4, 103), route)) return false;
  }
  for (int phase = 0; phase < 4; ++phase) {
    State s;
    if (!begin(s)) return false;
    if (phase >= 1 && !s.Return(binding, 101)) return false;
    if (phase >= 2 && !s.Returned(binding, 102)) return false;
    if (phase >= 3 && !s.Offer(binding, 8, 103)) return false;
    s.TargetEvent();
    s.Observe(Focus::kTarget, true, true, 104);
    if (!check(s.Failed() && !s.MayInput(104) && !s.MayBegin(),
        "RT_target_event_failure_latches_in_all_trip_phases")) return false;
  }
  for (const auto *failure : {"registration", "heartbeat"}) {
    State s;
    if (!begin(s)) return false;
    s.Invalidate("monitor_failed");
    if (!check(s.Failed() && !s.Return(binding, 101) && !s.MayBegin(), failure)) return false;
  }
  return !kWindowsBackgroundInputEnabled;
}
