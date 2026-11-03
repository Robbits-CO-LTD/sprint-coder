// P3a owns event attribution and claim ordering. Raw Input/heartbeat and event delivery are P3b/d.
struct WindowsBackgroundMonitor {
  using Owner = sprint_coder::computer_use::BackgroundInputOwner;
  sprint_coder::computer_use::WindowsBackgroundMonitorState state;
  const DWORD pid;
  const HWND window;
  std::mutex mutex;
  std::condition_variable ready;
  bool initialized = false;
  bool registered = false;
  std::jthread pump;
  static thread_local WindowsBackgroundMonitor *current;

  WindowsBackgroundMonitor(DWORD target_pid, HWND target_window, std::uint64_t epoch)
      : state(epoch), pid(target_pid), window(target_window) {}

  Owner Belongs(HWND candidate, bool absent_allowed = false) const {
    if (candidate == nullptr) return absent_allowed ? Owner::kNone : Owner::kUnknown;
    HWND root = GetAncestor(candidate, GA_ROOT);
    if (root == nullptr) return Owner::kUnknown;
    DWORD candidate_pid = 0;
    if (GetWindowThreadProcessId(candidate, &candidate_pid) == 0 || candidate_pid == 0)
      return Owner::kUnknown;
    if (candidate_pid == pid) return Owner::kTarget;
    // Ownership can cross processes. Never use a title, class name or input text for attribution.
    for (unsigned depth = 0; root != nullptr && depth < 32; ++depth) {
      DWORD owner_pid = 0;
      if (GetWindowThreadProcessId(root, &owner_pid) == 0 || owner_pid == 0)
        return Owner::kUnknown;
      if (root == window || owner_pid == pid) return Owner::kTarget;
      const HWND owner = GetWindow(root, GW_OWNER);
      if (owner == nullptr) return IsWindow(root) ? Owner::kOther : Owner::kUnknown;
      if (owner == root) return Owner::kUnknown;
      root = owner;
    }
    return Owner::kUnknown;
  }

  Owner Capture(HWND hit) const {
    // Foreground, hit and target queues may have distinct capture owners (inactive wheel).
    Owner result = Owner::kNone;
    for (HWND source : {GetForegroundWindow(), hit, window}) {
      const DWORD thread = source == nullptr ? 0 : GetWindowThreadProcessId(source, nullptr);
      GUITHREADINFO info{sizeof(GUITHREADINFO)};
      if (thread == 0 || !GetGUIThreadInfo(thread, &info)) return Owner::kUnknown;
      const Owner owner = Belongs(info.hwndCapture, true);
      if (owner == Owner::kTarget || owner == Owner::kUnknown) return owner;
      if (owner == Owner::kOther) result = owner;
    }
    return result;
  }

  void SamplePointer(POINT point) {
    const HWND hit = WindowFromPoint(point);
    state.Pointer(Belongs(hit), Capture(hit));
  }
  static LRESULT CALLBACK Mouse(int code, WPARAM message, LPARAM data) {
    if (code == HC_ACTION && current != nullptr) {
      // Injection flags/extra-info are deliberately ignored. Only ephemeral hit/capture metadata.
      if (data == 0) current->state.Pause();
      else current->SamplePointer(reinterpret_cast<const MSLLHOOKSTRUCT *>(data)->pt);
    }
    return CallNextHookEx(nullptr, code, message, data);
  }
  static void CALLBACK Foreground(HWINEVENTHOOK, DWORD, HWND candidate, LONG, LONG, DWORD, DWORD) {
    if (current != nullptr) current->state.Foreground(current->Belongs(candidate));
  }
  static void CALLBACK Target(HWINEVENTHOOK, DWORD, HWND, LONG, LONG, DWORD, DWORD) {
    // Registration filters the process, including destroyed HWNDs and non-window UIA objects.
    // No own-call proof exists in P3a; a call in progress alone must not suppress these events.
    if (current != nullptr) current->state.TargetEvent(Owner::kTarget);
  }

  bool Start() {
    try {
      pump = std::jthread([this](std::stop_token stop) {
        current = this;
        MSG message{};
        PeekMessageW(&message, nullptr, 0, 0, PM_NOREMOVE);
        const auto foreground = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND,
            nullptr, Foreground, 0, 0, WINEVENT_OUTOFCONTEXT);
        const auto mouse = SetWindowsHookExW(WH_MOUSE_LL, Mouse, GetModuleHandleW(nullptr), 0);
        // All target object changes, including VALUECHANGE/INVOKED and child objects.
        const auto objects = SetWinEventHook(EVENT_OBJECT_CREATE, EVENT_OBJECT_END,
            nullptr, Target, pid, 0, WINEVENT_OUTOFCONTEXT);
        const auto movement = SetWinEventHook(EVENT_SYSTEM_MOVESIZESTART, EVENT_SYSTEM_MOVESIZEEND,
            nullptr, Target, pid, 0, WINEVENT_OUTOFCONTEXT);
        const auto capture = SetWinEventHook(EVENT_SYSTEM_CAPTURESTART, EVENT_SYSTEM_CAPTUREEND,
            nullptr, Target, pid, 0, WINEVENT_OUTOFCONTEXT);
        const bool success = foreground && mouse && objects && movement && capture;
        state.Registered(success);
        state.Foreground(Belongs(GetForegroundWindow()));
        {
          std::lock_guard lock(mutex);
          registered = success;
          initialized = true;
        }
        ready.notify_all();
        while (success && !stop.stop_requested()) {
          if (MsgWaitForMultipleObjects(0, nullptr, FALSE, 20, QS_ALLINPUT) == WAIT_FAILED) {
            state.Pause();
            break;
          }
          while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
            if (message.message == WM_QUIT) { state.Pause(); break; }
            TranslateMessage(&message);
            DispatchMessageW(&message);
          }
          if (message.message == WM_QUIT) break;
        }
        state.Pause();
        for (auto hook : {foreground, objects, movement, capture})
          if (hook != nullptr) UnhookWinEvent(hook);
        if (mouse != nullptr) UnhookWindowsHookEx(mouse);
        current = nullptr;
      });
    } catch (...) {
      state.Pause();
      return false;
    }
    std::unique_lock lock(mutex);
    if (!ready.wait_for(lock, std::chrono::milliseconds(150), [&] { return initialized; }) ||
        !registered) state.Pause();
    return !state.Snapshot().paused;
  }
  ~WindowsBackgroundMonitor() {
    state.Pause();
    if (pump.joinable()) { pump.request_stop(); pump.join(); }
  }
};
thread_local WindowsBackgroundMonitor *WindowsBackgroundMonitor::current = nullptr;

bool StartWindowsBackgroundMonitor(WindowsSession &session, DWORD pid, HWND window,
                                   bool human_resume, std::string *reason) {
  std::uint64_t epoch = 1;
  if (session.background_monitor) {
    // Freeze the old claim boundary before inspecting it; resume cannot race an active claim.
    if (human_resume) session.background_monitor->state.Pause();
    const auto previous = session.background_monitor->state.Snapshot();
    if (!human_resume) {
      if (!previous.paused) return true;
      *reason = "user_takeover";
      return false;
    }
    if (previous.unknown_effect || previous.epoch == std::numeric_limits<std::uint64_t>::max()) {
      *reason = "user_takeover";
      return false;
    }
    epoch = previous.epoch + 1;
  }
  auto monitor = std::make_shared<WindowsBackgroundMonitor>(pid, window, epoch);
  if (!monitor->Start()) { *reason = "user_takeover"; return false; }
  session.background_monitor = std::move(monitor);
  return true;
}

bool WindowsBackgroundMonitorReady(const WindowsSession &session) {
  return session.background_monitor && !session.background_monitor->state.Snapshot().paused;
}

bool WindowsBackgroundMonitorCurrent(const WindowsSession &session) {
  return session.input_session.kind != sprint_coder::computer_use::InputSessionKind::kBackground ||
      WindowsBackgroundMonitorReady(session);
}
