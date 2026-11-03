// BEGIN windows session identity validation (#940)
thread_local const std::uint64_t *windows_validation_frame_serial = nullptr;

std::uint64_t WindowsValidationFrameStopSerial() {
  return windows_validation_frame_serial != nullptr ? *windows_validation_frame_serial
      : WindowsTargetListControl().stop_serial.load(std::memory_order_acquire);
}

class WindowsValidationFrameScope {
public:
  explicit WindowsValidationFrameScope(std::optional<std::uint64_t> queued_serial = std::nullopt) {
    if (windows_validation_frame_serial != nullptr) return;
    serial_ = queued_serial.value_or(WindowsTargetListControl().stop_serial.load(std::memory_order_acquire));
    windows_validation_frame_serial = &serial_;
    owner_ = true;
  }
  ~WindowsValidationFrameScope() {
    if (owner_) windows_validation_frame_serial = nullptr;
  }
  WindowsValidationFrameScope(const WindowsValidationFrameScope &) = delete;
  WindowsValidationFrameScope &operator=(const WindowsValidationFrameScope &) = delete;
  [[nodiscard]] std::uint64_t StopSerial() const { return *windows_validation_frame_serial; }

private:
  std::uint64_t serial_ = 0;
  bool owner_ = false;
};

bool WindowsValidationStillCurrent(std::uint64_t epoch, std::uint64_t stop_serial) {
  return !parent_process_dead.load(std::memory_order_acquire) &&
      cancellation_epoch.load(std::memory_order_acquire) == epoch &&
      WindowsTargetListControl().stop_serial.load(std::memory_order_acquire) == stop_serial;
}

struct WindowsSessionIdentityResult {
  bool identity_matches = false;
  bool elevated = true;
};

struct WindowsValidationPending {
  std::mutex mutex;
  std::condition_variable ready;
  std::atomic<bool> abandoned{false};
  std::uint64_t job_id = 0;
  bool done = false;
  WindowsSessionIdentityResult result;
};

struct WindowsValidationWork {
  std::uint32_t pid = 0;
  std::string process_start;
  std::wstring canonical_path;
  std::uint64_t volume_serial = 0;
  FILE_ID_128 file_id{};
  std::uint64_t epoch = 0;
  std::uint64_t stop_serial = 0;
  ScopedKernelHandle process;
  ScopedKernelHandle executable;
  std::shared_ptr<WindowsValidationPending> pending;
};

struct WindowsValidationState {
  std::mutex mutex;
  std::condition_variable wake;
  std::unique_ptr<WindowsValidationWork> queued;
  std::uint64_t active_job_id = 0;
  std::uint64_t next_job_id = 0;
  HANDLE cancellation_thread = nullptr;
  bool worker_started = false;
};

WindowsValidationState &WindowsValidationControl() {
  // One reusable reader for the helper's lifetime. An uninterruptible driver must not race static
  // destruction, and a stopped job must not cause another worker to be created.
  static auto *state = new WindowsValidationState;
  return *state;
}

WindowsSessionIdentityResult MeasureWindowsSessionIdentity(const WindowsValidationWork &work) {
  const auto still_valid = [&] {
    return !work.pending->abandoned.load(std::memory_order_acquire) &&
        WindowsValidationStillCurrent(work.epoch, work.stop_serial);
  };
  WindowsSessionIdentityResult result;
  std::string process_start;
  std::string current_start;
  std::wstring current_path;
  WindowsFileIdentity held_file_identity;
  // Keep both start-time checks that Validate performed, including the held-process check. These
  // reads are fresh for every call; the worker never caches a preceding validation's answer.
  if (!still_valid() || work.process.value == nullptr ||
      GetProcessId(work.process.value) != work.pid ||
      WaitForSingleObject(work.process.value, 0) != WAIT_TIMEOUT || !still_valid() ||
      !ReadProcessStartIdentity(work.process.value, &process_start) || process_start != work.process_start ||
      !still_valid() || !ReadProcessStartIdentity(work.process.value, &current_start) ||
      current_start != work.process_start || !still_valid() ||
      !ReadProcessPath(work.process.value, &current_path) ||
      !SameWindowsPath(current_path, work.canonical_path) || !still_valid() ||
      !ReadWindowsFileIdentity(work.executable.value, &held_file_identity) ||
      held_file_identity.volume_serial != work.volume_serial ||
      std::memcmp(held_file_identity.file_id.Identifier, work.file_id.Identifier,
                  sizeof(held_file_identity.file_id.Identifier)) != 0 || !still_valid())
    return result;
  result.identity_matches = true;
  result.elevated = IsProcessElevated(work.pid);
  return still_valid() ? result : WindowsSessionIdentityResult{};
}

void CancelWindowsValidationJob(std::uint64_t job_id) {
  auto &state = WindowsValidationControl();
  std::lock_guard lock(state.mutex);
  // The physical thread is reused. An old caller may cancel only its still-active job, never the
  // next job that happens to be on that same thread.
  if (state.active_job_id == job_id && job_id != 0 && state.cancellation_thread != nullptr)
    CancelSynchronousIo(state.cancellation_thread);
}

void WindowsValidationWorkerLoop(WindowsValidationState *state) {
  // The reusable thread owns its cancellation handle for its lifetime; state exposes an alias only
  // while one job owns the shared measurement slot. No COM apartment or input API is needed here.
  ScopedKernelHandle thread;
  const bool thread_ready =
      DuplicateHandle(GetCurrentProcess(), GetCurrentThread(), GetCurrentProcess(), &thread.value,
                      0, FALSE, DUPLICATE_SAME_ACCESS) &&
      thread.value != nullptr && thread.value != INVALID_HANDLE_VALUE;
  for (;;) {
    std::unique_ptr<WindowsValidationWork> work;
    {
      std::unique_lock lock(state->mutex);
      state->wake.wait(lock, [&] { return state->queued != nullptr; });
      work = std::move(state->queued);
      state->cancellation_thread = thread_ready ? thread.value : nullptr;
    }
    const auto pending = work->pending;
    const std::uint64_t job_id = pending->job_id;
    WindowsSessionIdentityResult result;
    try {
      if (thread_ready) result = MeasureWindowsSessionIdentity(*work);
    } catch (...) {
      result = {};
    }
    // The worker closes the job's duplicated process/exe handles, even after the session was closed.
    work.reset();
    {
      std::lock_guard lock(state->mutex);
      if (state->active_job_id == job_id) {
        state->cancellation_thread = nullptr;
        state->active_job_id = 0;
        WindowsTargetListWorkerRunning().store(false, std::memory_order_release);
      }
    }
    // Job retirement precedes result publication. Nothing below touches the shared slot or alias:
    // a new request may already own them while the old consumer is abandoning this result.
    {
      std::lock_guard lock(pending->mutex);
      if (!pending->abandoned.load(std::memory_order_acquire)) pending->result = result;
      pending->done = true;
    }
    pending->ready.notify_one();
  }
}

struct WindowsValidationSubmission {
  std::unique_ptr<WindowsValidationWork> work;
  bool claimed = false;
  ~WindowsValidationSubmission() {
    if (!claimed) return;
    // Not accepted by the worker: the original session still owns its handles on this consumer.
    work.reset();
    WindowsTargetListWorkerRunning().store(false, std::memory_order_release);
  }
};

struct WindowsValidationWaitGuard {
  std::shared_ptr<WindowsValidationPending> pending;
  ~WindowsValidationWaitGuard() {
    std::lock_guard lock(pending->mutex);
    if (pending->done) return;
    pending->abandoned.store(true, std::memory_order_release);
    // Lock order: pending -> state. The worker retires state before locking pending.
    CancelWindowsValidationJob(pending->job_id);
  }
};

bool ReadWindowsSessionIdentityOnLane(const WindowsSession &session, std::uint64_t stop_serial,
                                      WindowsSessionIdentityResult *result) {
  auto pending = std::make_shared<WindowsValidationPending>();
  WindowsValidationSubmission submission;
  submission.work = std::make_unique<WindowsValidationWork>();
  auto &work = *submission.work;
  work.pid = session.pid;
  work.process_start = session.process_start;
  work.canonical_path = session.canonical_path;
  work.volume_serial = session.executable_volume_serial;
  work.file_id = session.executable_file_id;
  work.epoch = session.cancel_epoch;
  work.stop_serial = stop_serial;
  work.pending = pending;
  const std::uint64_t epoch = work.epoch;
  {
    auto &control = WindowsTargetListControl();
    std::lock_guard stop_lock(control.stop_mutex);
    if (!WindowsValidationStillCurrent(epoch, stop_serial) ||
        control.running.exchange(true, std::memory_order_acq_rel))
      return false;
    submission.claimed = true;
  }
  // Duplicate while the consumer still owns the session. The worker never borrows handles that a
  // later Close can release or reuse. A submission failure is cleaned before this frame returns.
  if (session.process_handle == nullptr || session.executable_file == INVALID_HANDLE_VALUE ||
      !DuplicateHandle(GetCurrentProcess(), session.process_handle, GetCurrentProcess(), &work.process.value,
                       0, FALSE, DUPLICATE_SAME_ACCESS) ||
      !DuplicateHandle(GetCurrentProcess(), session.executable_file, GetCurrentProcess(), &work.executable.value,
                       0, FALSE, DUPLICATE_SAME_ACCESS))
    return false;
  auto &state = WindowsValidationControl();
  try {
    std::lock_guard lock(state.mutex);
    if (state.active_job_id != 0 || state.queued != nullptr ||
        state.next_job_id == std::numeric_limits<std::uint64_t>::max())
      return false;
    if (!state.worker_started) {
      std::thread(WindowsValidationWorkerLoop, &state).detach();
      state.worker_started = true;
    }
    pending->job_id = ++state.next_job_id;
    state.active_job_id = pending->job_id;
    state.queued = std::move(submission.work);
    submission.claimed = false;
  } catch (...) {
    return false;
  }
  state.wake.notify_one();
  WindowsValidationWaitGuard guard{pending};
  std::unique_lock lock(pending->mutex);
  for (;;) {
    {
      // Lock order: pending -> stop. The reader takes only stop_mutex.
      std::lock_guard stop_lock(WindowsTargetListControl().stop_mutex);
      if (!WindowsValidationStillCurrent(epoch, stop_serial)) return false;
      if (pending->done) {
        *result = pending->result;
        return true;
      }
    }
    pending->ready.wait_for(lock, std::chrono::milliseconds(20));
  }
}
// END windows session identity validation

std::string FrameIdKey(const sprint_coder::computer_use::FrameId &id) {
  return std::string(reinterpret_cast<const char *>(id.bytes.data()),
                     id.bytes.size());
}

// The foreground pump owns its session snapshot. It does not read the consumer's session map.
// Stop -> round-trip is the lock order; the pump never acquires the Stop lock.
struct WindowsRoundTripMonitor {
  WindowsSession snapshot;
  DWORD main_pid = 0;
  std::uint64_t stop_serial = 0;
  std::uint64_t generation = 0;
  std::mutex mutex;
  std::condition_variable ready;
  DWORD thread_id = 0;
  bool registered = false;
  bool initialized = false;
  std::uint64_t requested = 0, acknowledged = 0;
  std::jthread pump;
  static constexpr UINT kPing = WM_APP + 91;
  static thread_local WindowsRoundTripMonitor *current;

  void Sample(HWND foreground) {
    using Focus = sprint_coder::computer_use::ApprovalRoundTripFocus;
    DWORD pid = 0;
    std::wstring window_class;
    Focus focus = Focus::kOther;
    if (foreground != nullptr && ReadWindowClass(foreground, &window_class) &&
        GetWindowThreadProcessId(foreground, &pid) != 0) {
      if (window_class == L"Shell_TrayWnd" || window_class == L"Shell_SecondaryTrayWnd" ||
          window_class == L"Progman" || window_class == L"WorkerW" ||
          window_class == L"CabinetWClass" || window_class == L"ExploreWClass") focus = Focus::kShell;
      else if (pid == snapshot.pid && (foreground == snapshot.window ||
               IsOwnedByRootWindow(foreground, snapshot.window, snapshot.pid, nullptr))) focus = Focus::kTarget;
      else if (pid == main_pid) focus = Focus::kSprintCoder;
    }
    RECT bounds{};
    WindowsDialogSetSnapshot dialogs;
    std::string reason;
    const bool guards = WindowsValidationStillCurrent(snapshot.cancel_epoch, stop_serial) &&
        generation == windows_helper_generation && IsWindow(snapshot.window) &&
        WaitForSingleObject(snapshot.process_handle, 0) == WAIT_TIMEOUT &&
        ClientBoundsPhysical(snapshot.active_window, &bounds) &&
        EqualRect(&bounds, &snapshot.observation_bounds) &&
        CaptureWindowsDialogInventory(snapshot, &dialogs, &reason) &&
        dialogs.digest == snapshot.dialog_set_digest;
    snapshot.round_trip->Observe(focus, registered, guards, MonotonicNowNs() / 1000000);
  }
  static void CALLBACK Foreground(HWINEVENTHOOK, DWORD, HWND window, LONG, LONG, DWORD, DWORD) {
    if (current != nullptr) current->Sample(window);
  }
  bool Start(const WindowsSession &session, DWORD pid) {
    snapshot = session;
    snapshot.round_trip_monitor.reset();
    main_pid = pid;
    stop_serial = WindowsValidationFrameStopSerial();
    generation = windows_helper_generation;
    // Keep the process alive independently of Close releasing the session's original handle.
    HANDLE process = nullptr;
    snapshot.process_handle = nullptr;
    if (!DuplicateHandle(GetCurrentProcess(), session.process_handle, GetCurrentProcess(),
                         &process, 0, FALSE, DUPLICATE_SAME_ACCESS)) return false;
    snapshot.process_handle = process;
    try {
      pump = std::jthread([this](std::stop_token stop) {
        current = this;
        MSG message{};
        PeekMessageW(&message, nullptr, 0, 0, PM_NOREMOVE);
        const auto hook = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND,
            nullptr, Foreground, 0, 0, WINEVENT_OUTOFCONTEXT);
        {
          std::lock_guard lock(mutex);
          thread_id = GetCurrentThreadId();
          registered = hook != nullptr;
          initialized = true;
        }
        ready.notify_all();
        while (hook != nullptr && !stop.stop_requested()) {
          MsgWaitForMultipleObjects(0, nullptr, FALSE, 20, QS_ALLINPUT);
          while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
            TranslateMessage(&message);
            DispatchMessageW(&message);
            if (message.message == kPing) {
              Sample(GetForegroundWindow());
              std::lock_guard lock(mutex);
              acknowledged = static_cast<std::uint64_t>(message.wParam);
              ready.notify_all();
            }
          }
          Sample(GetForegroundWindow());
        }
        if (hook != nullptr) UnhookWinEvent(hook);
        current = nullptr;
      });
    } catch (...) {
      CloseHandle(snapshot.process_handle);
      snapshot.process_handle = nullptr;
      return false;
    }
    std::unique_lock lock(mutex);
    return ready.wait_for(lock, std::chrono::milliseconds(150), [&] { return initialized; }) && registered;
  }
  bool Sync() {
    std::unique_lock lock(mutex);
    const auto serial = ++requested;
    if (!registered || !PostThreadMessageW(thread_id, kPing, static_cast<WPARAM>(serial), 0) ||
        !ready.wait_for(lock, std::chrono::milliseconds(150), [&] { return acknowledged >= serial; })) {
      snapshot.round_trip->Invalidate("monitor_failed");
      return false;
    }
    return !snapshot.round_trip->Failed();
  }
  ~WindowsRoundTripMonitor() {
    if (pump.joinable()) { pump.request_stop(); pump.join(); }
    if (snapshot.process_handle != nullptr) CloseHandle(snapshot.process_handle);
  }
};
thread_local WindowsRoundTripMonitor *WindowsRoundTripMonitor::current = nullptr;

bool ReadWindowsRoundTripBinding(const WindowsSession &session, const std::string &metadata,
    sprint_coder::computer_use::ApprovalRoundTripBinding *binding) {
  return ReadJsonString(metadata, "roundTripId", &binding->id) && !binding->id.empty() &&
      ReadJsonString(metadata, "sessionId", &binding->session) && binding->session == session.session_id &&
      ReadJsonString(metadata, "taskId", &binding->task) && !binding->task.empty() &&
      ReadJsonString(metadata, "turnId", &binding->turn) && !binding->turn.empty() &&
      ReadJsonUint64(metadata, "helperGeneration", &binding->generation) &&
      binding->generation == windows_helper_generation && binding->generation != 0 &&
      ReadJsonUint64(metadata, "cancelEpoch", &binding->epoch) && binding->epoch == session.cancel_epoch;
}

bool WindowsRoundTripCurrent(const WindowsSession &session) {
  return !session.round_trip || (session.round_trip_monitor && session.round_trip_monitor->Sync());
}

bool WindowsRoundTripMayInput(const WindowsSession &session) {
  return !session.round_trip ||
      (WindowsRoundTripCurrent(session) && session.round_trip->MayInput(MonotonicNowNs() / 1000000));
}

std::string ResponseCacheKey(const Frame& request);
std::string RequestPayloadDigest(const Frame& request);

struct WindowsStartAttemptScope {
  std::shared_ptr<WindowsStartAdmission> owner;
  ~WindowsStartAttemptScope() {
    std::lock_guard lock(WindowsTargetListControl().stop_mutex);
    const auto active = sessions.find(owner->session_key);
    owner->active = active != sessions.end() && active->second.session_id == owner->session_id;
    if (owner->active) {
      active->second.start_owner = owner;
      owner->input_api_attempts = active->second.input_api_attempts;
    }
  }
};

struct WindowsStartParameters {
  std::uint64_t pid_value = 0;
  std::uint64_t window_value = 0;
  std::uint64_t cancel_epoch = 0;
  std::string session_id;
  std::string app_identity;
  std::string expected_window_identity;
  std::string canonical_path_utf8;
  std::string expected_executable_digest;
  std::string expected_signer_digest;
  double expected_bounds_x = 0;
  double expected_bounds_y = 0;
  double expected_bounds_width = 0;
  double expected_bounds_height = 0;
  bool explicit_resume = false;
  std::string expected_process_start;
};

bool ParseWindowsStartParameters(const std::string& metadata, WindowsStartParameters* output) {
  auto& [pid_value, window_value, cancel_epoch, session_id, app_identity, expected_window_identity, canonical_path_utf8, expected_executable_digest, expected_signer_digest, expected_bounds_x, expected_bounds_y, expected_bounds_width, expected_bounds_height, explicit_resume, expected_process_start] = *output;
  (void)expected_signer_digest;
  if (!ReadWindowsStartIdentity(metadata, &expected_process_start)) return false;
  if (!ReadJsonUint64(metadata, "pid", &pid_value) || pid_value == 0 ||
      pid_value > std::numeric_limits<DWORD>::max() ||
      !ReadJsonUint64(metadata, "windowId", &window_value) ||
      window_value == 0 ||
      window_value > std::numeric_limits<UINT_PTR>::max() ||
      !ReadJsonUint64(metadata, "cancelEpoch", &cancel_epoch) ||
      !ReadJsonString(metadata, "sessionId", &session_id) ||
      !ReadJsonString(metadata, "appIdentityDigest", &app_identity) ||
      !ReadJsonString(metadata, "windowIdentityDigest",
                      &expected_window_identity) ||
      !ReadJsonString(metadata, "canonicalPath", &canonical_path_utf8) ||
      !ReadJsonString(metadata, "executableDigest",
                      &expected_executable_digest) ||
      !ReadJsonDouble(metadata, "expectedBoundsX", &expected_bounds_x) ||
      !ReadJsonDouble(metadata, "expectedBoundsY", &expected_bounds_y) ||
      !ReadJsonDouble(metadata, "expectedBoundsWidth",
                      &expected_bounds_width) ||
      !ReadJsonDouble(metadata, "expectedBoundsHeight",
                      &expected_bounds_height) ||
      !ReadOptionalJsonBoolean(metadata, "resume", &explicit_resume) ||
      expected_bounds_width <= 0 || expected_bounds_height <= 0) {
    return false;
  }
  return !session_id.empty() && session_id.size() <= 256;
}

bool StartWindowsSession(const Frame &request, const std::string &metadata,
                         std::string *response, std::string *reason,
                         std::optional<std::uint64_t> queued_stop_serial = std::nullopt,
                         std::shared_ptr<WindowsStartLease> start_lease = nullptr,
                         std::shared_ptr<WindowsStartResult> start_result = std::make_shared<WindowsStartResult>()) {
  if (WindowsSemanticInputInFlight()) { *reason = "semantic_input_in_flight"; return false; }
  const auto start_serial = queued_stop_serial.value_or(WindowsTargetListControl().stop_serial.load(std::memory_order_acquire));
  WindowsStartParameters parsed;
  if (!ParseWindowsStartParameters(metadata, &parsed)) { *reason = "session_input_invalid"; return false; }
  auto& [pid_value, window_value, cancel_epoch, session_id, app_identity, expected_window_identity, canonical_path_utf8, expected_executable_digest, expected_signer_digest, expected_bounds_x, expected_bounds_y, expected_bounds_width, expected_bounds_height, explicit_resume, expected_process_start] = parsed;
  if (!start_lease) start_lease = AdmitWindowsStart(FrameIdKey(request.header.session_id), session_id,
      ResponseCacheKey(request), RequestPayloadDigest(request), reason, cancel_epoch);
  if (!start_lease || start_lease->owner->session_id != session_id ||
      start_lease->owner->session_key != FrameIdKey(request.header.session_id)) return false;
  WindowsStartAttemptScope ownership{start_lease->owner};
  if (!ClaimWindowsStartInput(start_lease)) { *reason = "session_start_canceled"; return false; }
  if (WindowsTargetListWorkerRunning().load(std::memory_order_acquire)) {
    *reason = "session_target_rejected"; return false;
  }
  // The eligibility basis the session is bound to (S5-c-3 PR-3). No field is the v1 basis, the only
  // one this function admits through (the V1 allow-list below). A field that is there must name a
  // basis; one this build does not admit (v2 in a v1 build) is refused.
  sprint_coder::computer_use::EligibilityBasis eligibility_basis =
      sprint_coder::computer_use::EligibilityBasis::kV1Allowlist;
  if (metadata.find("\"eligibilityBasis\"") != std::string::npos) {
    std::string basis_name;
    if (!ReadJsonString(metadata, "eligibilityBasis", &basis_name) ||
        !sprint_coder::computer_use::ParseEligibilityBasis(basis_name, &eligibility_basis)) {
      *reason = "session_input_invalid";
      return false;
    }
  }
  if (!sprint_coder::computer_use::EligibilityBasisAdmitted(
          eligibility_basis, sprint_coder::computer_use::kNativeEligibilityIsV2)) {
    *reason = "eligibility_basis_unsupported";
    return false;
  }
  ReadJsonString(metadata, "signerDigest", &expected_signer_digest);
  const int path_length = MultiByteToWideChar(
      CP_UTF8, MB_ERR_INVALID_CHARS, canonical_path_utf8.data(),
      static_cast<int>(canonical_path_utf8.size()), nullptr, 0);
  if (path_length <= 0) {
    *reason = "session_identity_invalid";
    return false;
  }
  std::wstring canonical_path(static_cast<std::size_t>(path_length), L'\0');
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
                          canonical_path_utf8.data(),
                          static_cast<int>(canonical_path_utf8.size()),
                          canonical_path.data(), path_length) != path_length) {
    *reason = "session_identity_invalid";
    return false;
  }
  const auto pid = static_cast<std::uint32_t>(pid_value);
  const HWND window =
      reinterpret_cast<HWND>(static_cast<UINT_PTR>(window_value));
  const bool v2_basis =
      eligibility_basis == sprint_coder::computer_use::EligibilityBasis::kV2Denylist;
  if (sessions.contains(FrameIdKey(request.header.session_id))) {
    WindowsStartInput input;
    std::string approval_route;
    input.approval_route_v2 = ReadJsonString(metadata, "classifierRoute", &approval_route) && approval_route == "v2";
    ReadJsonUint64(metadata, "helperGeneration", &input.approval_helper_generation);
    input.eligibility_basis = eligibility_basis;
    input.start_lease = start_lease;
    input.expected_process_start = expected_process_start;
    input.start_result = start_result;
    input.pid = pid;
    input.window = window;
    input.window_value = window_value;
    input.session_key = FrameIdKey(request.header.session_id);
    input.session_id = session_id;
    input.app_identity = app_identity;
    input.expected_window_identity = expected_window_identity;
    input.canonical_path = canonical_path;
    input.executable_digest = expected_executable_digest;
    input.signer_digest = expected_signer_digest;
    input.bounds_x = expected_bounds_x;
    input.bounds_y = expected_bounds_y;
    input.bounds_width = expected_bounds_width;
    input.bounds_height = expected_bounds_height;
    input.explicit_resume = explicit_resume;
    input.cancel_epoch = cancel_epoch;
    input.stop_serial = start_serial;
    ReadJsonUint64(metadata, "profileRevision", &input.profile_revision);
    if (v2_basis && !ReadJsonUint64(metadata, "denyRulesetVersion", &input.ruleset_version)) {
      *reason = "session_target_rejected";
      return false;
    }
    auto &existing = sessions.at(input.session_key);
    sprint_coder::computer_use::ApprovalRoundTripBinding binding;
    if (existing.round_trip && !existing.round_trip->MayLegacyStart()) {
      // Main consumes trusted activation before sending the P1b return binding. A plain resume
      // cannot clear a retained failure; human recovery closes this session and starts a new one.
      if (!ReadWindowsRoundTripBinding(existing, metadata, &binding) ||
          !WindowsRoundTripCurrent(existing) ||
          !existing.round_trip->Return(binding, MonotonicNowNs() / 1000000)) {
        existing.round_trip->Invalidate();
        *reason = "approval_round_trip_rejected";
        return false;
      }
    } else if (metadata.find("\"roundTripId\"") != std::string::npos) {
      *reason = "approval_round_trip_rejected";
      return false;
    }
    const bool succeeded = StartWindowsExistingSession(std::move(input), response, reason);
    if (!binding.id.empty()) {
      if (!succeeded || !WindowsRoundTripCurrent(existing) ||
          !existing.round_trip->Returned(binding, MonotonicNowNs() / 1000000)) {
        existing.round_trip->Invalidate();
        *reason = "approval_round_trip_rejected";
        return false;
      }
    }
    return succeeded;
  }
  if (v2_basis && !sessions.contains(FrameIdKey(request.header.session_id))) {
    if constexpr (sprint_coder::computer_use::kNativeEligibilityIsV2) {
      WindowsStartInput input;
      std::string approval_route;
      input.approval_route_v2 = ReadJsonString(metadata, "classifierRoute", &approval_route) && approval_route == "v2";
      ReadJsonUint64(metadata, "helperGeneration", &input.approval_helper_generation);
      input.start_lease = start_lease;
      input.expected_process_start = expected_process_start;
      input.start_result = start_result;
      input.pid = pid;
      input.window = window;
      input.window_value = window_value;
      input.session_key = FrameIdKey(request.header.session_id);
      input.session_id = session_id;
      input.app_identity = app_identity;
      input.expected_window_identity = expected_window_identity;
      input.canonical_path = canonical_path;
      input.executable_digest = expected_executable_digest;
      input.signer_digest = expected_signer_digest;
      input.bounds_x = expected_bounds_x;
      input.bounds_y = expected_bounds_y;
      input.bounds_width = expected_bounds_width;
      input.bounds_height = expected_bounds_height;
      input.explicit_resume = explicit_resume;
      input.cancel_epoch = cancel_epoch;
      input.stop_serial = start_serial;
      ReadJsonUint64(metadata, "profileRevision", &input.profile_revision);
      if (!ReadJsonUint64(metadata, "denyRulesetVersion", &input.ruleset_version) ||
          !ReadJsonUint64(metadata, "targetGeneration", &input.requested_generation)) {
        *reason = "session_target_rejected";
        return false;
      }
      return StartWindowsNewSession(std::move(input), response, reason);
    }
  }
  if (!v2_basis && !sessions.contains(FrameIdKey(request.header.session_id))) {
    WindowsStartInput input;
    std::string approval_route;
    input.approval_route_v2 = ReadJsonString(metadata, "classifierRoute", &approval_route) && approval_route == "v2";
    ReadJsonUint64(metadata, "helperGeneration", &input.approval_helper_generation);
    input.eligibility_basis = eligibility_basis;
    input.start_lease = start_lease;
    input.expected_process_start = expected_process_start;
    input.start_result = start_result;
    input.pid = pid;
    input.window = window;
    input.window_value = window_value;
    input.session_key = FrameIdKey(request.header.session_id);
    input.session_id = session_id;
    input.app_identity = app_identity;
    input.expected_window_identity = expected_window_identity;
    input.canonical_path = canonical_path;
    input.executable_digest = expected_executable_digest;
    input.signer_digest = expected_signer_digest;
    input.bounds_x = expected_bounds_x;
    input.bounds_y = expected_bounds_y;
    input.bounds_width = expected_bounds_width;
    input.bounds_height = expected_bounds_height;
    input.explicit_resume = explicit_resume;
    input.cancel_epoch = cancel_epoch;
    input.stop_serial = start_serial;
    ReadJsonUint64(metadata, "profileRevision", &input.profile_revision);
    return StartWindowsNewSession(std::move(input), response, reason);
  }
  *reason = "eligibility_basis_unsupported";
  return false;
}

void MarkWindowsStartClosed(const std::string& key, const ClosedWindowsSessionRecord& receipt) {
  std::lock_guard lock(WindowsTargetListControl().stop_mutex);
  auto& registry = WindowsStarts();
  const auto found = registry.owners.find(key);
  if (found == registry.owners.end() || found->second->session_id != receipt.session_id) return;
  const auto& owner = found->second;
  owner->active = false;
  owner->terminal = true;
  owner->terminal_epoch = std::max(owner->terminal_epoch, receipt.cancel_epoch);
  owner->stopped.store(true, std::memory_order_release);
  if (registry.input_owner == owner && owner->pending_requests.load(std::memory_order_acquire) == 0)
    registry.input_owner.reset();
}

bool CloseWindowsSession(const Frame &request, const std::string& metadata, std::string *response, std::string *reason = nullptr) {
  const std::string session_key = FrameIdKey(request.header.session_id);
  std::uint64_t requested_epoch = 0;
  if (!ReadJsonUint64(metadata, "cancelEpoch", &requested_epoch)) return false;
  const auto found = sessions.find(session_key);
  ClosedWindowsSessionRecord receipt;
  if (found == sessions.end()) {
    // The first close already released the session, so only the record of a close that produced a
    // drained response can answer this one. Main keeps the host quarantined until it sees a
    // confirmed close receipt and answers an unconfirmed close by re-sending it for the same
    // session id with a higher epoch.
    const auto closed = closed_sessions.find(session_key);
    if (closed == closed_sessions.end() || requested_epoch <= closed->second.cancel_epoch)
      return false;
    closed->second.cancel_epoch = requested_epoch;
    receipt = closed->second;
  } else {
    if (requested_epoch <= found->second.cancel_epoch) return false;
    std::uint64_t attempts = 0;
    if (!StopWindowsSemanticInput(found->second, &attempts)) {
      if (reason != nullptr) *reason = "semantic_input_in_flight";
      return false;
    }
    found->second.cancel_epoch = requested_epoch;
    auto current = cancellation_epoch.load(std::memory_order_acquire);
    while (requested_epoch > current && !cancellation_epoch.compare_exchange_weak(
        current, requested_epoch, std::memory_order_acq_rel, std::memory_order_acquire)) {}
    receipt = ClosedWindowsSessionRecord{
        found->second.session_id, requested_epoch, attempts};
    last_closed_cancel_epoch =
        std::max(last_closed_cancel_epoch, found->second.cancel_epoch);
    RememberClosedWindowsSession(session_key, receipt);
    ReleaseWindowsSessionResources(&found->second);
    ForgetWindowsTicket(session_key);
    sessions.erase(found);
  }
  MarkWindowsStartClosed(session_key, receipt);
  *response = "{\"result\":\"closed\",\"drained\":true,\"sessionId\":\"" +
      JsonEscape(receipt.session_id) + "\",\"cancelEpoch\":" + std::to_string(receipt.cancel_epoch) +
      ",\"inputAttemptCount\":" + std::to_string(receipt.input_api_attempts) + "}";
  return true;
}

bool StopPendingWindowsStart(const Frame& request, const std::string& metadata,
                             std::string* response, std::string* reason) {
  constexpr std::uint64_t max_safe_epoch = 9007199254740991ULL;
  std::string id;
  if (!ReadPendingWindowsStop(metadata, &id)) { *reason = "session_input_invalid"; return false; }
  const auto key = FrameIdKey(request.header.session_id);
  if (!LatchWindowsPendingStop(key, id)) { *reason = "native_close_unconfirmed"; return false; }
  std::shared_ptr<WindowsStartAdmission> owner;
  std::uint64_t epoch = 0;
  bool active = false;
  {
    std::lock_guard lock(WindowsTargetListControl().stop_mutex);
    auto& registry = WindowsStarts();
    const auto found = registry.owners.find(key);
    if (found == registry.owners.end() || found->second->session_id != id) {
      *reason = "native_close_unconfirmed"; return false;
    }
    owner = found->second;
    const auto session = sessions.find(key);
    active = session != sessions.end() && session->second.session_id == id;
    if (active) owner->input_api_attempts = session->second.input_api_attempts;
    const auto base = owner->terminal ? owner->terminal_epoch :
        std::max({cancellation_epoch.load(std::memory_order_acquire), owner->requested_epoch,
                  active ? session->second.cancel_epoch : owner->terminal_epoch});
    if (base >= max_safe_epoch) { *reason = "native_stop_epoch_exhausted"; return false; }
    epoch = base + 1;
    if (!active) {
      if (!owner->terminal && registry.input_owner == owner) {
        auto current = cancellation_epoch.load(std::memory_order_acquire);
        while (epoch > current && !cancellation_epoch.compare_exchange_weak(current, epoch,
            std::memory_order_acq_rel, std::memory_order_acquire)) {}
        last_closed_cancel_epoch = std::max(last_closed_cancel_epoch, epoch);
      } else if (!owner->terminal && registry.input_owner == nullptr && registry.last_input_owner.lock() == owner) {
        // The failed input owner has no work left. Release its old barrier without canceling
        // unrelated discovery by advancing the global epoch.
        last_closed_cancel_epoch = std::max(last_closed_cancel_epoch,
            cancellation_epoch.load(std::memory_order_acquire));
      }
      owner->terminal = true;
      owner->terminal_epoch = epoch;
      owner->active = false;
      if (registry.input_owner == owner && owner->pending_requests.load(std::memory_order_acquire) == 0)
        registry.input_owner.reset();
    }
  }
  if (active) {
    const auto close_metadata = "{\"cancelEpoch\":" + std::to_string(epoch) + "}";
    if (!CloseWindowsSession(request, close_metadata, response, reason)) {
      if (reason->empty()) *reason = "native_close_unconfirmed";
      return false;
    }
    return true;
  }
  *response = "{\"result\":\"closed\",\"drained\":true,\"sessionId\":\"" + JsonEscape(id) +
      "\",\"cancelEpoch\":" + std::to_string(epoch) + ",\"inputAttemptCount\":" +
      std::to_string(owner->input_api_attempts->load(std::memory_order_acquire)) + "}";
  return true;
}

bool ValidateWindowsSession(
    const WindowsSession &session, RECT *bounds, std::string *reason,
    WindowsDialogSetSnapshot *dialog_snapshot = nullptr) {
  bool valid = false;
  struct RoundTripValidation {
    const WindowsSession &session;
    const std::string *reason;
    const bool &valid;
    ~RoundTripValidation() {
      if (valid || !session.round_trip || session.round_trip->MayLegacyStart()) return;
      // Only the permitted focus transfer is non-terminal. All identity/dialog/Stop failures
      // remain terminal, including a failure whose notification never reaches Main.
      if (*reason == "focus_required" && WindowsRoundTripCurrent(session) &&
          session.round_trip->FocusException()) return;
      session.round_trip->Invalidate();
    }
  } round_trip_validation{session, reason, valid};
  const WindowsValidationFrameScope frame;
  if (WindowsTargetListWorkerRunning().load(std::memory_order_acquire)) {
    *reason = "session_identity_changed";
    return false;
  }
  WindowsSessionIdentityResult identity;
  DWORD owner_pid = 0;
  if (!ReadWindowsSessionIdentityOnLane(session, frame.StopSerial(), &identity) ||
      !identity.identity_matches ||
      !IsWindow(session.window) || !IsApplicationWindow(session.window) ||
      GetWindowThreadProcessId(session.window, &owner_pid) == 0 ||
      owner_pid != session.pid) {
    *reason = "session_identity_changed";
    return false;
  }
  if (identity.elevated) {
    *reason = "elevated_target_blocked";
    return false;
  }
  WindowsDialogSetSnapshot current_dialogs;
  if (!CaptureWindowsDialogSet(session, &current_dialogs, reason))
    return false;
  std::lock_guard stop_lock(WindowsTargetListControl().stop_mutex);
  if (!WindowsValidationStillCurrent(session.cancel_epoch, frame.StopSerial())) {
    *reason = "session_identity_changed";
    return false;
  }
  *bounds = current_dialogs.active_bounds;
  if (dialog_snapshot != nullptr)
    *dialog_snapshot = std::move(current_dialogs);
  valid = true;
  return true;
}

bool ReadExact(HANDLE pipe, void *destination, std::size_t bytes) {
  auto *output = static_cast<std::uint8_t *>(destination);
  std::size_t offset = 0;
  while (offset < bytes) {
    const DWORD request =
        static_cast<DWORD>(std::min<std::size_t>(bytes - offset, 1u << 20));
    ScopedKernelHandle event(CreateEventW(nullptr, TRUE, FALSE, nullptr));
    if (event.value == nullptr)
      return false;
    OVERLAPPED operation{};
    operation.hEvent = event.value;
    DWORD read = 0;
    const BOOL started =
        ReadFile(pipe, output + offset, request, nullptr, &operation);
    if ((!started && GetLastError() != ERROR_IO_PENDING) ||
        !GetOverlappedResult(pipe, &operation, &read, TRUE) || read == 0)
      return false;
    offset += read;
  }
  return true;
}

bool WriteExact(HANDLE pipe, const void *source, std::size_t bytes) {
  const auto *input = static_cast<const std::uint8_t *>(source);
  std::size_t offset = 0;
  while (offset < bytes) {
    const DWORD request =
        static_cast<DWORD>(std::min<std::size_t>(bytes - offset, 1u << 20));
    ScopedKernelHandle event(CreateEventW(nullptr, TRUE, FALSE, nullptr));
    if (event.value == nullptr)
      return false;
    OVERLAPPED operation{};
    operation.hEvent = event.value;
    DWORD written = 0;
    const BOOL started =
        WriteFile(pipe, input + offset, request, nullptr, &operation);
    if ((!started && GetLastError() != ERROR_IO_PENDING) ||
        !GetOverlappedResult(pipe, &operation, &written, TRUE) || written == 0)
      return false;
    offset += written;
  }
  return true;
}

bool ReadFrame(HANDLE pipe, Frame *output) {
  FrameHeader header{};
  if (!ReadExact(pipe, &header, sizeof(header)))
    return false;
  if (!sprint_coder::computer_use::ValidateHeader(header))
    return false;
  std::vector<std::uint8_t> encoded(sizeof(header) + header.metadata_bytes +
                                    header.binary_bytes);
  std::memcpy(encoded.data(), &header, sizeof(header));
  if (header.metadata_bytes + header.binary_bytes > 0 &&
      !ReadExact(pipe, encoded.data() + sizeof(header),
                 header.metadata_bytes + header.binary_bytes))
    return false;
  const auto decoded = DecodeFrame(encoded);
  if (!decoded.has_value())
    return false;
  *output = *decoded;
  return true;
}

bool WriteFrame(HANDLE pipe, FrameHeader header, std::string_view metadata,
                std::span<const std::uint8_t> binary = {}) {
  const auto *bytes = reinterpret_cast<const std::uint8_t *>(metadata.data());
  const auto encoded = EncodeFrame(
      header, std::span<const std::uint8_t>(bytes, metadata.size()), binary);
  return !encoded.empty() && WriteExact(pipe, encoded.data(), encoded.size());
}

std::uint32_t WindowsBuildNumber() {
  // RtlGetVersion is deliberately resolved at runtime because VersionHelpers
  // uses the app manifest and may report a compatibility shim value.  A
  // missing/invalid result is unsafe.
  using RtlGetVersionFn = LONG(WINAPI *)(PRTL_OSVERSIONINFOW);
  const HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  if (ntdll == nullptr)
    return 0;
  const auto query =
      reinterpret_cast<RtlGetVersionFn>(GetProcAddress(ntdll, "RtlGetVersion"));
  if (query == nullptr)
    return 0;
  RTL_OSVERSIONINFOW version{};
  version.dwOSVersionInfoSize = sizeof(version);
  if (query(&version) != 0)
    return 0;
  return version.dwBuildNumber;
}

