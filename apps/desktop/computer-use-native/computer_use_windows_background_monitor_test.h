#pragma once
#include "computer_use_windows_background_monitor.h"
#include <iostream>
#include <thread>

inline bool CheckBackgroundMonitor() {
  using namespace sprint_coder::computer_use;
  using Owner = BackgroundInputOwner;
  const auto check = [](bool value, const char *name) {
    if (!value) std::cerr << name << '\n';
    return value;
  };
  {
    WindowsBackgroundMonitorState s;
    if (!check(!s.Claim(1), "BG03_unregistered_monitor_cannot_claim")) return false;
    s.Registered(true);
    const auto epoch = s.Snapshot().epoch;
    s.Foreground(Owner::kOther);
    s.Pointer(Owner::kOther, Owner::kNone);
    s.Pointer(Owner::kOther, Owner::kOther);
    s.TargetEvent(Owner::kOther);
    const auto claim = s.Claim(epoch);
    if (!check(claim && s.Finish(claim) && s.Snapshot().epoch == epoch,
               "BG02_unrelated_input_does_not_pause")) return false;
  }
  for (auto owner : {Owner::kTarget, Owner::kUnknown}) {
    WindowsBackgroundMonitorState s;
    s.Registered(true);
    const auto epoch = s.Snapshot().epoch;
    s.Foreground(owner);
    if (!check(s.Snapshot().paused && s.Snapshot().epoch > epoch && !s.Claim(epoch),
               "BG03_target_process_foreground_closes_claim")) return false;
  }
  for (int event = 0; event < 5; ++event) {
    WindowsBackgroundMonitorState s;
    s.Registered(true);
    const auto epoch = s.Snapshot().epoch;
    if (event == 0) s.Pointer(Owner::kTarget, Owner::kNone);
    if (event == 1) s.Pointer(Owner::kOther, Owner::kTarget);
    if (event == 2) s.Pointer(Owner::kUnknown, Owner::kNone);
    if (event == 3) s.Pointer(Owner::kOther, Owner::kUnknown);
    if (event == 4) s.TargetEvent(Owner::kTarget);
    if (!check(!s.Claim(epoch) && s.Snapshot().paused,
               "BG03_inactive_pointer_or_unknown_owner_pauses")) return false;
    s.Registered(true);
    s.Foreground(Owner::kOther);
    if (!check(!s.Claim(epoch) && !s.Claim(s.Snapshot().epoch),
               "BG03_lost_event_cannot_bypass_epoch")) return false;
  }
  {
    WindowsBackgroundMonitorState s;
    s.Registered(true);
    const auto epoch = s.Snapshot().epoch;
    const auto claim = s.Claim(epoch);
    if (!check(claim && !s.Claim(epoch), "BG03_single_claim_owner")) return false;
    s.TargetEvent(Owner::kTarget);
    if (!check(!s.Finish(claim) && s.Snapshot().unknown_effect && !s.Claim(epoch),
               "BG03_unattributed_target_event_pauses")) return false;
  }
  {
    WindowsBackgroundMonitorState s;
    s.Registered(false);
    s.Registered(true);
    if (!check(!s.Claim(s.Snapshot().epoch), "BG03_registration_failure_latches")) return false;
    WindowsBackgroundMonitorState resumed(s.Snapshot().epoch + 1);
    resumed.Registered(true);
    if (!check(!resumed.Claim(1) && !resumed.Claim(s.Snapshot().epoch) &&
                   resumed.Claim(resumed.Snapshot().epoch),
               "BG03_reordered_notification_cannot_restore_old_authority")) return false;
  }
  for (int i = 0; i < 32; ++i) {
    WindowsBackgroundMonitorState s;
    s.Registered(true);
    const auto epoch = s.Snapshot().epoch;
    std::uint64_t claim = 0;
    std::thread claimant([&] { claim = s.Claim(epoch); });
    std::thread monitor([&] { s.Foreground(Owner::kTarget); });
    claimant.join();
    monitor.join();
    if (!check(!s.Claim(epoch) && s.Snapshot().paused &&
                   (!claim || (!s.Finish(claim) && s.Snapshot().unknown_effect)),
               "BG03_claim_monitor_total_order")) return false;
  }
  return true;
}
