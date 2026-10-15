#pragma once

// Classifier v2, S5-b-2b: when the Windows shadow runs, and what it may touch. The host calls
// `Schedule` once the V1 preflight has its answer; this header decides whether a capture may start
// at all and runs it OFF the serial lane, then keeps an enum-only summary in the shadow ring. It
// is portable (the thread, the COM apartment and the UI Automation source are the host's, handed in
// as functions), so the harness runs every path with a fake launcher and a fake source.
//
// The rules (the same as the macOS shadow, see the ADR and the C2 notes):
//   * it never decides: the V1 receipt is already built when `Schedule` is called, nothing it does
//     can change it, and an exception is swallowed;
//   * it reads NOTHING when V1 could not re-validate the bound target, when the action was canceled
//     (checked again when the capture starts, not only when it is scheduled), or when UI Automation
//     cannot be created: each of these leaves a skipped record with its own gap bit, never a
//     classification;
//   * one capture is in flight at a time; another one is recorded as busy, not queued, so a hung
//     target app can hold the shadow's thread but never the serial lane or a second capture;
//   * a capture that was stopped by a cancel is a skipped record; one that ran out of budget is a
//     classification with the budget gap (incomplete is a takeover for the core);
//   * the record carries enum values and counters only: never a label, a title, a URL or a path.

#include "computer_use_windows_shadow_reader.h"

#include <atomic>
#include <functional>
#include <memory>
#include <string>
#include <string_view>
#include <utility>

namespace sprint_coder::computer_use {

// What the capture needs from the request: a trimmed copy, no text and no ticket.
struct WindowsShadowJob {
  std::string kind;
  std::string key;
  std::string target_id;
  std::string maximum_mode;
  std::string policy_language;
  // The V1 preflight issued its ordinary ticket for this request.
  bool v1_ordinary = false;
};

// How the host gives the capture its world. Both run on the shadow's thread.
struct WindowsShadowEnvironment {
  // False once the action was canceled or its target stopped being the one V1 validated.
  std::function<bool()> still_valid;
  // The UI Automation source for this request, or null when it cannot be created. The host
  // initializes COM on the thread before the work runs.
  std::function<std::unique_ptr<ShadowUiaSource>()> open_source;
};

// Runs `work` on the shadow's own low-priority thread, never on the caller's.
using WindowsShadowLauncher = std::function<void(std::function<void()>)>;

class WindowsShadowScheduler {
public:
  WindowsShadowScheduler(EffectShadowLog &ring, WindowsShadowLauncher launcher)
      : ring_(ring), launcher_(std::move(launcher)) {}

  // Called after the V1 preflight. `v1_valid` is whether V1 could re-validate the bound target.
  // Reads nothing itself: it only decides whether a capture may start and hands the work over.
  void Schedule(WindowsShadowJob job, bool v1_valid, WindowsShadowEnvironment environment) noexcept {
    bool claimed = false;
    bool handed_over = false;
    try {
      if (!v1_valid) {
        ring_.Record(ShadowSkippedRecord(job.kind, kShadowGapV1Invalid, job.v1_ordinary));
        return;
      }
      if (in_flight_.exchange(true)) {
        ring_.Record(ShadowSkippedRecord(job.kind, kShadowGapBusy, job.v1_ordinary));
        return;
      }
      claimed = true;
      launcher_([this, job = std::move(job), environment = std::move(environment)]() mutable {
        Run(job, environment);
        in_flight_.store(false);
      });
      handed_over = true;
    } catch (...) {
      // A shadow failure is invisible to the caller.
      if (claimed && !handed_over) in_flight_.store(false);
    }
  }

  [[nodiscard]] bool InFlight() const { return in_flight_.load(); }

private:
  // The capture itself, on the shadow's thread. Never throws.
  void Run(const WindowsShadowJob &job, const WindowsShadowEnvironment &environment) noexcept {
    try {
      // The action may have been canceled between the schedule and the start: nothing is read.
      if (!environment.still_valid || !environment.still_valid()) {
        ring_.Record(ShadowSkippedRecord(job.kind, kShadowGapCanceled, job.v1_ordinary));
        return;
      }
      std::unique_ptr<ShadowUiaSource> source =
          environment.open_source ? environment.open_source() : nullptr;
      if (source == nullptr) {
        // UI Automation could not be created: the shadow has no facts, which is a read gap.
        ring_.Record(ShadowSkippedRecord(job.kind, kShadowGapReadFailed, job.v1_ordinary));
        return;
      }
      WindowsShadowReader reader(*source);
      const ShadowUiaCapture capture = reader.Capture(job.kind, job.target_id);
      if (reader.Canceled()) {
        ring_.Record(ShadowSkippedRecord(job.kind, kShadowGapCanceled, job.v1_ordinary));
        return;
      }
      ShadowRequestInfo info;
      info.kind = job.kind;
      info.key = job.key;
      info.maximum_mode = job.maximum_mode;
      info.policy_language = job.policy_language;
      ring_.Record(WindowsShadowClassify(capture, info, job.v1_ordinary));
    } catch (...) {
      // A shadow failure is invisible to the caller.
    }
  }

  EffectShadowLog &ring_;
  WindowsShadowLauncher launcher_;
  std::atomic<bool> in_flight_{false};
};

} // namespace sprint_coder::computer_use
