// The registration type follows discovery's declarations in the assembled host.
bool MeasureWindowsPickedIdentity(const std::wstring& path, WindowsExecutableIdentity* identity,
                                  std::uint64_t serial) {
  auto& control = WindowsTargetListControl();
  WindowsNewStartIoRegistration cancellation;
  const auto current = [&] {
    return !parent_process_dead.load(std::memory_order_acquire) &&
        control.stop_serial.load(std::memory_order_acquire) == serial;
  };
  if (cancellation.thread == nullptr || !current()) return false;
  WindowsExecutableIdentity measured;
  if (!BuildWindowsExecutableIdentity(path, &measured)) return false;
  std::lock_guard lock(control.stop_mutex);
  if (!current()) return false;
  *identity = std::move(measured);
  return true;
}

// BEGIN windows cancellable discovery measurement
struct WindowsDiscoveryWorkControl {
  std::function<bool()> current;
  std::function<DWORD(DWORD)> remaining;
  std::function<bool()> claim_launch;
  std::function<void()> retire_launch;
};

bool MeasureWindowsDiscovery(const std::string &metadata, const WindowsDiscoveryWorkControl& work,
                             std::string *response, std::string *reason) {
  if (!work.current()) {
    *reason = "profile_identity_invalid";
    return false;
  }
  bool include_start_identity = false;
  if (!ReadOptionalJsonBoolean(metadata, "includeStartIdentity", &include_start_identity)) {
    *reason = "discovery_input_invalid"; return false;
  }
  std::string canonical_path_utf8;
  std::string expected_identity;
  std::string expected_executable_digest;
  std::string expected_signer_digest;
  if (!ReadJsonString(metadata, "canonicalPath", &canonical_path_utf8) ||
      !ReadJsonString(metadata, "identityDigest", &expected_identity) ||
      !ReadJsonString(metadata, "executableDigest",
                      &expected_executable_digest) ||
      expected_identity.size() != 64 ||
      expected_executable_digest.size() != 64) {
    *reason = "profile_identity_invalid";
    return false;
  }
  ReadJsonString(metadata, "signerDigest", &expected_signer_digest);
  const int path_length = MultiByteToWideChar(
      CP_UTF8, MB_ERR_INVALID_CHARS, canonical_path_utf8.data(),
      static_cast<int>(canonical_path_utf8.size()), nullptr, 0);
  if (path_length <= 0) {
    *reason = "profile_identity_invalid";
    return false;
  }
  std::wstring canonical_path(static_cast<std::size_t>(path_length), L'\0');
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
                          canonical_path_utf8.data(),
                          static_cast<int>(canonical_path_utf8.size()),
                          canonical_path.data(), path_length) != path_length) {
    *reason = "profile_identity_invalid";
    return false;
  }
  LockedWindowsExecutable current_executable;
  const bool identity_read =
      OpenLockedWindowsExecutable(canonical_path, &current_executable);
  const bool same_canonical_path =
      identity_read &&
      SameWindowsPath(current_executable.identity.path, canonical_path);
  if (!work.current()) { *reason = "window_discovery_unavailable"; return false; }
  // Authenticode identity is stable across a same-path, same-signer app update.
  // Unsigned registrations remain bound to the exact bytes because they have no
  // independent signing authority that can authenticate replacement bytes.
  const bool signed_identity_update =
      same_canonical_path && !expected_signer_digest.empty() &&
      current_executable.identity.signer_digest == expected_signer_digest &&
      current_executable.identity.identity_digest == expected_identity;
  const bool unsigned_identity_match =
      same_canonical_path && expected_signer_digest.empty() &&
      current_executable.identity.signer_digest.empty() &&
      current_executable.identity.identity_digest == expected_identity &&
      current_executable.identity.executable_digest ==
          expected_executable_digest;
  const bool identity_matches =
      signed_identity_update || unsigned_identity_match;
  if (!identity_matches) {
    CloseLockedWindowsExecutable(&current_executable);
    *reason = "app_identity_changed";
    return false;
  }
  std::string explorer_discovery_route;
  const bool explorer_v2_requested =
      ReadJsonString(metadata, "classifierRoute", &explorer_discovery_route) &&
      explorer_discovery_route == "v2";
  // This only permits enumeration, not admission: each Explorer window must pass V2 measurement.
  const auto leaf = canonical_path.substr(canonical_path.find_last_of(L"\\/") + 1);
  const bool explorer_route = sprint_coder::computer_use::kWindowsExplorerException &&
      sprint_coder::computer_use::kNativeEligibilityIsV2 &&
      explorer_v2_requested && _wcsicmp(leaf.c_str(), L"explorer.exe") == 0;
  if (identity_matches &&
      !IsSupportedWindowsV1Target(current_executable.identity) && !explorer_route) {
    CloseLockedWindowsExecutable(&current_executable);
    *reason = "target_application_unsupported";
    return false;
  }

  std::vector<std::string> candidates;
  if (identity_matches &&
      !EnumerateWindowsForExecutable(
          current_executable.identity.path, expected_identity,
          current_executable.identity.executable_digest,
          expected_signer_digest, &candidates, work.current, include_start_identity, explorer_route)) {
    CloseLockedWindowsExecutable(&current_executable);
    *reason = "process_enumeration_unavailable";
    return false;
  }
  if (!include_start_identity && work.current() && candidates.empty() && identity_matches &&
      !IsDisallowedTargetExecutable(current_executable.identity.path)) {
    ScopedKernelHandle launched_process;
    if (LaunchVerifiedExecutable(current_executable, &launched_process.value, work.claim_launch, work.retire_launch)) {
      if (!work.current()) { *reason = "window_discovery_unavailable"; return false; }
      WaitForInputIdle(launched_process.value, work.remaining(5'000));
      for (std::size_t attempt = 0; attempt < 20 && candidates.empty() && work.current();
           ++attempt) {
        if (!EnumerateWindowsForExecutable(
                current_executable.identity.path, expected_identity,
                current_executable.identity.executable_digest,
                expected_signer_digest,
                &candidates, work.current, include_start_identity, explorer_route)) {
          CloseLockedWindowsExecutable(&current_executable);
          *reason = "process_enumeration_unavailable";
          return false;
        }
        if (candidates.empty() &&
            WaitForSingleObject(launched_process.value, work.remaining(250)) != WAIT_TIMEOUT)
          break;
      }
    }
  }
  CloseLockedWindowsExecutable(&current_executable);
  if (!work.current() || candidates.size() > 64) { *reason = "window_discovery_unavailable"; return false; }
  *response = "[";
  for (std::size_t index = 0; index < candidates.size(); ++index) {
    if (index != 0)
      *response += ',';
    *response += candidates[index];
  }
  *response += ']';
  return true;
}

// END windows cancellable discovery measurement

// BEGIN windows cancellable discovery worker
bool WindowsDiscoveryCurrent(const std::shared_ptr<WindowsDiscoveryOwner>& owner,
                             std::uint64_t serial) {
  return !owner->stopped.load(std::memory_order_acquire) &&
      !parent_process_dead.load(std::memory_order_acquire) &&
      WindowsTargetListControl().stop_serial.load(std::memory_order_acquire) == serial &&
      GetTickCount64() - owner->admitted_at < kWindowsDiscoveryBudgetMs;
}

std::string WindowsDiscoveryReceiptJson(std::string_view id, std::string_view result,
                                       std::uint32_t launches) {
  return "{\"discoveryId\":\"" + JsonEscape(id) + "\",\"result\":\"" + std::string(result) +
      "\",\"drained\":true,\"launchAttemptCount\":" + std::to_string(launches) + "}";
}

// Only this pump services foreign-owner Stops while the consumer measures. It is joined
// before the consumer touches the response cache again; no other request is dispatched here.
struct WindowsDiscoveryStopPump {
  std::function<bool(const std::string&)> service;
  bool failed = false;
};

struct WindowsDiscoveryPumpScope {
  std::atomic<bool> finished{false};
  std::thread pump;
  WindowsDiscoveryPumpScope(WindowsDiscoveryStopPump* stop_pump,
                            const std::shared_ptr<WindowsDiscoveryOwner>& owner,
                            std::uint64_t serial) {
    if (stop_pump == nullptr) return;
    pump = std::thread([this, stop_pump, owner, serial] {
      const auto fail = [&] {
        auto& control = WindowsTargetListControl();
        std::lock_guard lock(control.stop_mutex);
        owner->stopped.store(true, std::memory_order_release);
        CancelWindowsNewStartMeasurementLocked(control);
        stop_pump->failed = true;
      };
      while (!finished.load(std::memory_order_acquire)) {
        {
          auto& control = WindowsTargetListControl();
          std::lock_guard lock(control.stop_mutex);
          if (!WindowsDiscoveryCurrent(owner, serial))
            CancelWindowsNewStartMeasurementLocked(control);
        }
        // A failed service must still cancel I/O that starts after the first cancellation.
        if (!stop_pump->failed) {
          try {
            if (!stop_pump->service(owner->key)) fail();
          } catch (...) { fail(); }
        }
        Sleep(20);
      }
    });
  }
  ~WindowsDiscoveryPumpScope() {
    finished.store(true, std::memory_order_release);
    if (pump.joinable()) pump.join();
  }
};

bool RunWindowsDiscovery(const std::string& metadata,
                         std::shared_ptr<WindowsDiscoveryLease> lease,
                         std::uint64_t serial, std::string* response, std::string* reason,
                         WindowsDiscoveryStopPump* stop_pump = nullptr) {
  *reason = "window_discovery_unavailable";
  if (!lease || !ClaimWindowsDiscoveryQuery(lease)) return false;
  const auto owner = lease->owner;
  auto& control = WindowsTargetListControl();
  {
    std::lock_guard stop_lock(control.stop_mutex);
    if (!WindowsDiscoveryCurrent(owner, serial) || control.running.load(std::memory_order_acquire)) {
      owner->terminal = true;
      *reason = "profile_identity_invalid";
      return false;
    }
    control.running.store(true, std::memory_order_release);
  }
  struct Slot {
    std::shared_ptr<WindowsDiscoveryLease>& lease;
    ~Slot() {
      lease.reset();
      WindowsTargetListWorkerRunning().store(false, std::memory_order_release);
    }
  } slot{lease};
  bool ok = false;
  std::string windows;
  try {
    WindowsNewStartIoRegistration cancellation;
    // The pump cancels only this consumer's registration, including deadline/pipe-end latches.
    // Non-I/O stalls are bounded by Main's E4/normal request termination, not by this thread.
    WindowsDiscoveryPumpScope pump(stop_pump, owner, serial);
    if (cancellation.thread != nullptr) {
      WindowsDiscoveryWorkControl work;
      work.current = [owner, serial] { return WindowsDiscoveryCurrent(owner, serial); };
      work.remaining = [owner](DWORD maximum) {
        const auto elapsed = GetTickCount64() - owner->admitted_at;
        return elapsed >= kWindowsDiscoveryBudgetMs ? DWORD{0} :
            static_cast<DWORD>(std::min<std::uint64_t>(maximum, kWindowsDiscoveryBudgetMs - elapsed));
      };
      work.claim_launch = [owner, serial] {
        std::lock_guard lock(WindowsTargetListControl().stop_mutex);
        if (WindowsSemanticInputInFlightLocked() || !WindowsDiscoveryCurrent(owner, serial) || owner->terminal || owner->launch_attempts != 0)
          return false;
        owner->launch_attempts = 1;
        owner->launch_in_flight = true;
        return true;
      };
      work.retire_launch = [owner] {
        std::lock_guard lock(WindowsTargetListControl().stop_mutex);
        owner->launch_in_flight = false;
        if (owner->stopped.load(std::memory_order_acquire)) {
          owner->terminal = true; owner->completed = false;
        }
      };
      ok = MeasureWindowsDiscovery(metadata, work, &windows, reason);
    }
  } catch (...) {
    ok = false;
    *reason = "window_discovery_unavailable";
  }
  FinishWindowsDiscovery(owner, ok);
  std::lock_guard stop_lock(control.stop_mutex);
  if (!WindowsDiscoveryCurrent(owner, serial) || (stop_pump != nullptr && stop_pump->failed)) {
    *reason = "window_discovery_unavailable";
    return false;
  }
  if (!ok) return false;
  if (!owner->terminal || !owner->completed || owner->launch_in_flight) return false;
  std::string built = WindowsDiscoveryReceiptJson(owner->id, "completed", owner->launch_attempts);
  built.pop_back();
  built += ",\"windows\":" + windows + "}";
  if (built.size() > kMaxMetadataBytes) return false;
  *response = std::move(built);
  return true;
}

bool StopWindowsDiscovery(const std::string& key, const std::string& metadata,
                          const std::shared_ptr<WindowsDiscoveryLease>& lease,
                          std::string* response, std::string* reason) {
  std::string id;
  if (!ReadWindowsDiscoveryStop(metadata, &id)) { *reason = "discovery_input_invalid"; return false; }
  if (!lease || lease->owner->key != key || lease->owner->id != id) {
    *reason = "window_discovery_unconfirmed"; return false;
  }
  std::lock_guard lock(WindowsTargetListControl().stop_mutex);
  const auto& owner = lease->owner;
  owner->stopped.store(true, std::memory_order_release);
  if (owner->launch_in_flight) { *reason = "window_discovery_unconfirmed"; return false; }
  owner->terminal = true;
  owner->completed = false;
  *response = WindowsDiscoveryReceiptJson(id, "stopped", owner->launch_attempts);
  return true;
}

void DrainWindowsDiscoveryLaunchesForExit() {
  StopWindowsDiscoveriesForPipeEnd();
  // The consumer now unwinds its launch guard before ServePipe returns. Keep the exit
  // barrier as a final ownership check: only verification or actual failed-child exit
  // retires a claim, never an early Stop receipt.
  for (;;) {
    {
      std::lock_guard lock(WindowsTargetListControl().stop_mutex);
      const auto& owners = WindowsDiscoveries().owners;
      if (std::none_of(owners.begin(), owners.end(), [](const auto& entry) {
            return entry.second->launch_in_flight;
          })) return;
    }
    Sleep(10);
  }
}
// END windows cancellable discovery worker

