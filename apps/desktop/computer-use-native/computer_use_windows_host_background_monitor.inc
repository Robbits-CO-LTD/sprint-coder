// Native monitoring closes claims independently of Main event delivery (P3d).
struct WindowsBackgroundMonitor {
  using Owner = sprint_coder::computer_use::BackgroundInputOwner;
  using Pump = sprint_coder::computer_use::BackgroundMonitorPump;
  sprint_coder::computer_use::WindowsBackgroundMonitorState state;
  const DWORD pid;
  const HWND window;
  std::mutex mutex;
  std::condition_variable ready;
  unsigned initialized = 0;
  bool registered = true;
  std::jthread pump;
  std::jthread raw_pump;
  std::jthread watchdog;
  static constexpr UINT kHeartbeat = WM_APP + 73;
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
      current->state.MouseHook();
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
    // P4a keeps this fail-closed: the WinEvent our own background pattern call raises also pauses
    // here, so the claim ends as unknown_effect on a real device. BG01 completed is fake-only and
    // real-device BG01 is BLOCKED until "N9 P4a-attr claim-scoped own-call WinEvent attribution".
    if (current != nullptr) current->state.TargetEvent(Owner::kTarget);
  }

  static LRESULT CALLBACK RawWindow(HWND hwnd, UINT message, WPARAM word, LPARAM data) {
    if (message == WM_INPUT && current != nullptr) {
      // Read only the header. Never retain movement, buttons, keys or device identity.
      RAWINPUTHEADER header{};
      UINT size = sizeof(header);
      const UINT read = GetRawInputData(reinterpret_cast<HRAWINPUT>(data), RID_HEADER,
          &header, &size, sizeof(header));
      if (read != sizeof(header) || size != sizeof(header)) current->state.Pause();
      else if (header.dwType == RIM_TYPEMOUSE) current->state.RawMouse();
    }
    // DefWindowProc performs the required foreground WM_INPUT cleanup too.
    return DefWindowProcW(hwnd, message, word, data);
  }

  void Initialized(bool success) {
    if (!success) state.Registered(false);
    {
      std::lock_guard lock(mutex);
      registered = registered && success;
      ++initialized;
      if (initialized == 2) state.Registered(registered);
    }
    ready.notify_all();
  }

  void RunPump(std::stop_token stop, Pump kind) {
    using namespace sprint_coder::computer_use;
    MSG message{};
    std::uint64_t last_post = 0;
    bool pending = false;
    while (!stop.stop_requested() && !state.Snapshot().paused) {
      const auto now = BackgroundMonitorNow();
      if (!pending && now - last_post >= kBackgroundHeartbeatIntervalMs) {
        if (!PostThreadMessageW(GetCurrentThreadId(), kHeartbeat, 0, 0)) break;
        last_post = now;
        pending = true;
      }
      if (MsgWaitForMultipleObjects(0, nullptr, FALSE,
          static_cast<DWORD>(kBackgroundHeartbeatIntervalMs), QS_ALLINPUT) == WAIT_FAILED) break;
      // Bound each drain so a busy queue cannot starve stop or heartbeat checks.
      for (unsigned count = 0; count < 64 && !stop.stop_requested(); ++count) {
        if (!PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) break;
        if (message.message == WM_QUIT) { state.Pause(); return; }
        if (message.hwnd == nullptr && message.message == kHeartbeat) {
          if (pending) state.Heartbeat(kind);
          pending = false;
        } else {
          TranslateMessage(&message);
          DispatchMessageW(&message);
        }
      }
      state.CheckHealth();
    }
    state.Pause();
  }

  void RunRawPump(std::stop_token stop) {
    current = this;
    // Windows allows only one raw-input sink per device class in this process.
    // A second session must fail closed instead of silently stealing the first sink.
    static std::mutex sink_mutex;
    std::unique_lock sink_lock(sink_mutex, std::try_to_lock);
    if (!sink_lock.owns_lock()) { Initialized(false); current = nullptr; return; }
    const HINSTANCE instance = GetModuleHandleW(nullptr);
    static const ATOM window_class = [instance] {
      WNDCLASSEXW cls{};
      cls.cbSize = sizeof(cls);
      cls.lpfnWndProc = RawWindow;
      cls.hInstance = instance;
      cls.lpszClassName = L"SprintCoderBackgroundRawInput";
      return RegisterClassExW(&cls);
    }();
    const HWND sink = window_class == 0 ? nullptr : CreateWindowExW(0,
        MAKEINTATOM(window_class), L"", 0, 0, 0, 0, 0, HWND_MESSAGE, nullptr, instance, nullptr);
    RAWINPUTDEVICE device{0x01, 0x02, RIDEV_INPUTSINK, sink};
    const bool success = sink != nullptr && RegisterRawInputDevices(&device, 1, sizeof(device));
    Initialized(success);
    if (success) RunPump(stop, Pump::kRaw);
    state.Pause();
    if (success) {
      device.dwFlags = RIDEV_REMOVE;
      device.hwndTarget = nullptr;
      if (!RegisterRawInputDevices(&device, 1, sizeof(device))) state.Pause();
    }
    if (sink != nullptr) DestroyWindow(sink);
    current = nullptr;
  }

  bool Start() {
    state.BeginMonitoring();
    try {
      watchdog = std::jthread([this](std::stop_token stop) {
        while (!stop.stop_requested()) {
          state.CheckHealth();
          if (state.Snapshot().paused) break;
          std::this_thread::sleep_for(std::chrono::milliseconds(
              sprint_coder::computer_use::kBackgroundHeartbeatIntervalMs));
        }
      });
      raw_pump = std::jthread([this](std::stop_token stop) { RunRawPump(stop); });
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
        state.Foreground(Belongs(GetForegroundWindow()));
        Initialized(success);
        if (success) RunPump(stop, Pump::kHook);
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
    if (!ready.wait_for(lock, std::chrono::milliseconds(150), [&] { return initialized == 2; }) ||
        !registered) state.Pause();
    return !state.Snapshot().paused;
  }
  void Stop() {
    state.Pause();
    if (watchdog.joinable()) watchdog.request_stop();
    if (raw_pump.joinable()) raw_pump.request_stop();
    if (pump.joinable()) { pump.request_stop(); pump.join(); }
    if (raw_pump.joinable()) raw_pump.join();
    if (watchdog.joinable()) watchdog.join();
  }
  ~WindowsBackgroundMonitor() { Stop(); }
};
thread_local WindowsBackgroundMonitor *WindowsBackgroundMonitor::current = nullptr;

bool StartWindowsBackgroundMonitor(WindowsSession &session, DWORD pid, HWND window,
                                   bool human_resume, std::string *reason) {
  std::uint64_t epoch = 1;
  if (session.background_monitor) {
    session.background_monitor->state.CheckHealth();
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
    session.background_monitor->Stop();
  }
  auto monitor = std::make_shared<WindowsBackgroundMonitor>(pid, window, epoch);
  if (!monitor->Start()) { *reason = "user_takeover"; return false; }
  session.background_monitor = std::move(monitor);
  return true;
}

bool WindowsBackgroundMonitorReady(const WindowsSession &session) {
  if (session.background_monitor) session.background_monitor->state.CheckHealth();
  return session.background_monitor && !session.background_monitor->state.Snapshot().paused;
}

bool WindowsBackgroundMonitorCurrent(const WindowsSession &session) {
  return session.input_session.kind != sprint_coder::computer_use::InputSessionKind::kBackground ||
      WindowsBackgroundMonitorReady(session);
}
