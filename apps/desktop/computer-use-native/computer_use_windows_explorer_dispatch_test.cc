// Included at two seams of the complete host; only external measurements and input APIs are fake.
#if defined(SPRINT_CODER_EXPLORER_DISPATCH_DEPENDENCIES)
std::string m2_kind = "click";
unsigned m2_inputs = 0, m2_measurements = 0, m2_rechecks = 0, m2_send_calls = 0;
POINT m2_measured_point{}, m2_recheck_point{}, m2_cursor_point{};
std::vector<INPUT> m2_sent;
DWORD m2_last_input = 1000;
UINT m2_routing = MOUSEWHEEL_ROUTING_MOUSE_POS;
HWND m2_focus = reinterpret_cast<HWND>(200);
bool m2_spi_ok = true, m2_tick_ok = true, m2_short_send = false;
bool m2_cursor_moves_during_recheck = false, m2_input_during_recheck = false;
bool m2_change_in_send = false;
bool m2_screen_width_changes_during_recheck = false, m2_screen_origin_changes_during_recheck = false;
int m2_screen_width_delta = 0, m2_screen_left_delta = 0;
HWND m2_view = reinterpret_cast<HWND>(200), m2_owner = reinterpret_cast<HWND>(201);
std::wstring m2_folder = L"C:\\synthetic-folder";
bool m2_foreign_owner = false, m2_identity = true, m2_verified = true, m2_throw = false;
bool m2_cancel_during_view = false, m2_stop_during_view = false;
bool m2_change_after_cursor = false, m2_change_during_interlock = false;
bool M2MayInput(const WindowsSession &) { return true; }
bool M2Flight() { return false; }
bool M2Binding(const WindowsSession &, const std::string &, std::string *kind, RECT *bounds,
               std::string *) { *kind = m2_kind; *bounds = RECT{10, 20, 111, 121}; return true; }
sprint_coder::computer_use::InterlockEvaluation M2Interlock(const WindowsSession &,
    const std::string &, const std::string &, WindowsClickBasis *) {
  if (m2_change_during_interlock) m2_folder = L"C:\\changed-folder";
  return {};
}
bool M2Revalidate(const WindowsSession &, const RECT &, std::uint64_t) { return true; }
bool M2Patch(const WindowsSession &, double, double, std::string *) { return true; }
WindowsUiaRisk M2Risk(POINT, std::uint32_t, std::string *signature) {
  *signature = "synthetic-control"; return WindowsUiaRisk{true, false, false, true};
}
WindowsUiaRisk M2FocusedRisk(std::uint32_t) { return WindowsUiaRisk{true, false, false, true}; }
bool M2Focus(std::uint32_t, const RECT &, std::string *signature) {
  *signature = "synthetic-control"; return true;
}
bool M2Moved(const WindowsClickBasis &) { return false; }
BOOL M2Cursor(int x, int y) {
  ++m2_inputs; m2_cursor_point = POINT{x, y};
  if (m2_change_after_cursor) m2_folder = L"C:\\changed-folder";
  return TRUE;
}
bool M2ApprovedCursor(const WindowsSession &, int x, int y) { return M2Cursor(x, y) != FALSE; }
UINT M2Send(const WindowsSession &, const RECT &, std::uint64_t, UINT count, LPINPUT events) {
  ++m2_inputs; ++m2_send_calls;
  m2_sent.assign(events, events + count);
  if (m2_change_in_send) m2_folder = L"C:\\changed-folder";
  return m2_short_send ? count - 1 : count;
}
bool M2LastInput(DWORD *tick) { *tick = m2_last_input; return m2_tick_ok; }
BOOL M2CursorPos(POINT *point) { *point = m2_cursor_point; return TRUE; }
BOOL M2Spi(UINT action, UINT, PVOID value, UINT) {
  if (!m2_spi_ok || action != SPI_GETMOUSEWHEELROUTING) return FALSE;
  *static_cast<UINT *>(value) = m2_routing; return TRUE;
}
BOOL M2GuiThread(DWORD, GUITHREADINFO *info) { info->hwndFocus = m2_focus; return TRUE; }
// The virtual desktop as the dispatch guard reads it: the real one, unless a monitor is "added".
int M2Metrics(int index) {
  const int value = GetSystemMetrics(index);
  if (index == SM_CXVIRTUALSCREEN) return value + m2_screen_width_delta;
  if (index == SM_XVIRTUALSCREEN) return value + m2_screen_left_delta;
  return value;
}
bool M2Unicode(const WindowsSession &, const RECT &, std::uint64_t, std::uint32_t, bool *accepted) {
  ++m2_inputs; *accepted = true; return true;
}
bool M2Semantic(const WindowsSession &, const RECT &, std::uint64_t, const std::string &,
    const std::string &, bool *accepted, std::string *,
    sprint_coder::computer_use::NativeApprovalEffect) {
  ++m2_inputs; *accepted = true; return true;
}
#elif defined(SPRINT_CODER_EXPLORER_MEASUREMENT_DEPENDENCIES)
bool M2Identity(const WindowsSession &, std::uint64_t, WindowsSessionIdentityResult *identity) {
  identity->identity_matches = m2_identity; identity->elevated = false; return true;
}
bool M2Verified(DWORD, HWND) { return m2_verified; }
DWORD M2WindowOwner(HWND, DWORD *pid) { *pid = 42; return 1; }
WindowsExplorerShellView M2View() {
  if (m2_throw) throw std::bad_alloc();
  if (m2_cancel_during_view) cancellation_epoch.fetch_add(1);
  if (m2_stop_during_view) WindowsTargetListControl().stop_serial.fetch_add(1);
  return WindowsExplorerShellView{m2_folder, m2_view};
}
WindowsExplorerShellView M2ReadView(HWND, const std::function<bool()> &) {
  ++m2_measurements; return M2View();
}
// The re-measure inside dispatch, counted apart from the measurement the evidence came from.
WindowsExplorerShellView M2RecheckView(HWND, const std::function<bool()> &) {
  ++m2_rechecks;
  // A person moves the mouse or presses a key while the last re-measure runs (hundreds of ms).
  if (m2_rechecks == 2 && m2_cursor_moves_during_recheck) ++m2_cursor_point.x;
  if (m2_rechecks == 2 && m2_input_during_recheck) ++m2_last_input;
  // A monitor is added to the right (wider) or to the left (origin moves) during the re-measure.
  if (m2_rechecks == 2 && m2_screen_width_changes_during_recheck) m2_screen_width_delta = 1920;
  if (m2_rechecks == 2 && m2_screen_origin_changes_during_recheck) {
    m2_screen_left_delta = -1920; m2_screen_width_delta = 1920;
  }
  return M2View();
}
WindowsExplorerRefusal M2Point(HWND, HWND, DWORD, POINT point, HWND *owner) {
  m2_measured_point = point; *owner = m2_owner;
  return m2_foreign_owner ? WindowsExplorerRefusal::kPointForeignOwner : WindowsExplorerRefusal::kNone;
}
WindowsExplorerRefusal M2RecheckPoint(HWND window, HWND view, DWORD pid, POINT point, HWND *owner) {
  const POINT measured = m2_measured_point;
  const auto refusal = M2Point(window, view, pid, point, owner);
  m2_recheck_point = point; m2_measured_point = measured;
  return refusal;
}
#else
#define wmain ProductionHostMain
#include "explorer-host.cc"
#undef wmain
#include <stdexcept>

void Require(bool ok, const char *what) {
  if (!ok) { std::cout << "FAIL " << what << std::endl; throw std::runtime_error(what); }
}

int wmain() {
  Require(SUCCEEDED(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED)), "apartment");
  constexpr bool gate = sprint_coder::computer_use::kWindowsExplorerException;
  Frame frame;
  frame.header.session_id.bytes[0] = 31;
  WindowsSession initial;
  initial.session_id = "synthetic-session";
  initial.pid = 42;
  initial.window = reinterpret_cast<HWND>(100);
  initial.active_window = initial.window;
  initial.canonical_path = L"C:\\Windows\\explorer.exe";
  initial.approval_route_v2 = true;
  initial.cancel_epoch = 2;
  initial.has_focused_element_signature = true;
  initial.focused_element_signature = "synthetic-control";
  initial.visual_control_signatures.insert("synthetic-control");
  sessions.emplace(FrameIdKey(frame.header.session_id), std::move(initial));
  auto &session = sessions.begin()->second;
  const std::string measure = R"({"sessionId":"synthetic-session","windowId":"100","cancelEpoch":2,"x":60,"y":70})";
  const std::string action = R"({"x":0.5,"y":0.5,"deltaX":1,"deltaY":1,"key":"Enter","text":"a"})";
  const auto reset = [&] {
    session.explorer_dispatch_evidence.reset();
    session.pid = 42; session.cancel_epoch = 2; session.approval_route_v2 = true;
    session.approval_revoked = false; session.active_window = session.window;
    session.input_session.kind = sprint_coder::computer_use::InputSessionKind::kForeground;
    session.approved_deadline_ns = 0;
    cancellation_epoch.store(2); WindowsTargetListControl().stop_serial.store(0);
    m2_inputs = m2_measurements = m2_rechecks = m2_send_calls = 0; m2_kind = "click";
    m2_sent.clear(); m2_last_input = 1000; m2_routing = MOUSEWHEEL_ROUTING_MOUSE_POS;
    m2_focus = reinterpret_cast<HWND>(200); m2_recheck_point = POINT{};
    m2_spi_ok = m2_tick_ok = true; m2_short_send = m2_change_in_send = false;
    m2_cursor_moves_during_recheck = m2_input_during_recheck = false;
    m2_screen_width_changes_during_recheck = m2_screen_origin_changes_during_recheck = false;
    m2_screen_width_delta = m2_screen_left_delta = 0;
    m2_view = reinterpret_cast<HWND>(200); m2_owner = reinterpret_cast<HWND>(201);
    m2_folder = L"C:\\synthetic-folder";
    m2_foreign_owner = m2_throw = m2_cancel_during_view = m2_stop_during_view = false;
    m2_change_after_cursor = m2_change_during_interlock = false;
    m2_identity = m2_verified = true;
    std::string response;
    Require(MeasureWindowsExplorerView(frame, measure, &response) == gate, "measurement_gate");
    Require(static_cast<bool>(session.explorer_dispatch_evidence) == gate, "native_evidence_retained");
  };
  const auto dispatch = [&](const std::string &metadata = std::string{}) {
    std::string result, reason; bool accepted = false;
    const bool ok = DispatchWindowsAction(session, metadata.empty() ? action : metadata,
                                          &result, &reason, &accepted);
    if (!ok) Require(!accepted, "refusal_not_accepted");
    return ok;
  };
  const auto blocked = [&](const char *name) {
    Require(!dispatch() && m2_inputs == 0, name);
    std::cout << "OK " << name << '\n';
  };
  // Refused after the cursor was placed and before any SendInput: no button or wheel event at all.
  const auto refused_before_send = [&](const char *name) {
    std::string result, reason; bool accepted = false;
    Require(!DispatchWindowsAction(session, action, &result, &reason, &accepted) && !accepted &&
        reason == "stale_target" && m2_send_calls == 0 && m2_inputs == 1 && m2_sent.empty(), name);
    std::cout << "OK " << name << '\n';
  };
  const auto plain_flags = [&](std::initializer_list<DWORD> flags) {
    if (m2_sent.size() != flags.size()) return false;
    std::size_t index = 0;
    for (const DWORD flag : flags)
      if (m2_sent[index].type != INPUT_MOUSE || m2_sent[index++].mi.dwFlags != flag) return false;
    return true;
  };
  // Windows' own mapping of an ABSOLUTE|VIRTUALDESK value to a pixel offset from the virtual desktop
  // origin, written here independently of the host: floor(normalized * extent / 65536).
  const auto windows_absolute_pixel = [](LONG normalized, int extent) {
    if (normalized < 0 || normalized > 65535) return LONG{-1};
    return static_cast<LONG>((static_cast<std::int64_t>(normalized) * extent) / 65536);
  };
  // The first event moves to exactly (60, 70) on the virtual desktop, in the same array as the rest.
  const auto moves_to_action_point = [&] {
    if (m2_sent.empty() || m2_sent[0].type != INPUT_MOUSE ||
        m2_sent[0].mi.dwFlags != (MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK))
      return false;
    return GetSystemMetrics(SM_XVIRTUALSCREEN) +
            windows_absolute_pixel(m2_sent[0].mi.dx, GetSystemMetrics(SM_CXVIRTUALSCREEN)) == 60 &&
        GetSystemMetrics(SM_YVIRTUALSCREEN) +
            windows_absolute_pixel(m2_sent[0].mi.dy, GetSystemMetrics(SM_CYVIRTUALSCREEN)) == 70;
  };
  if constexpr (!gate) {
    reset(); Require(dispatch() && m2_inputs == 2, "gate_off_click_unchanged");
    Require(m2_measurements == 0, "gate_off_never_measures");
    Require(m2_send_calls == 1 && plain_flags({MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP}),
        "gate_off_click_events_unchanged");
    reset(); m2_kind = "scroll";
    Require(dispatch() && m2_inputs == 3 && m2_send_calls == 2 && plain_flags({MOUSEEVENTF_HWHEEL}),
        "gate_off_scroll_unchanged");
    reset(); m2_kind = "invoke";
    Require(dispatch() && m2_inputs == 1 && m2_measurements == 0, "gate_off_semantic_unchanged");
  } else {
#if defined(SPRINT_CODER_WINDOWS_EXPLORER_TEST_HOOKS)
    {
      // Every chosen value lands, by Windows' mapping, on the very pixel asked for.
      struct AxisCase { LONG coordinate; int origin; int extent; };
      for (const AxisCase axis : {AxisCase{100, 0, 7680}, AxisCase{0, 0, 1920},
               AxisCase{1919, 0, 1920}, AxisCase{-1920, -1920, 3840}, AxisCase{1919, -1920, 3840},
               AxisCase{1, 0, 2}, AxisCase{0, 0, 2}, AxisCase{7679, 0, 7680}}) {
        LONG normalized = -1;
        Require(WindowsExplorerNormalizeAxis(axis.coordinate, axis.origin, axis.extent, &normalized) &&
            windows_absolute_pixel(normalized, axis.extent) == axis.coordinate - axis.origin,
            "absolute_move_matches_windows_pixel_mapping");
      }
      for (int extent = 1; extent <= 8192; extent += (extent < 64 ? 1 : 97))
        for (LONG offset = 0; offset < extent; offset += (extent < 64 ? 1 : 13)) {
          LONG normalized = -1;
          Require(WindowsExplorerNormalizeAxis(offset, 0, extent, &normalized) &&
              windows_absolute_pixel(normalized, extent) == offset,
              "absolute_move_matches_windows_pixel_mapping_sweep");
        }
      LONG unused = 0;
      Require(!WindowsExplorerNormalizeAxis(1920, 0, 1920, &unused) &&
          !WindowsExplorerNormalizeAxis(-1921, -1920, 3840, &unused),
          "absolute_move_refuses_off_desktop");
      std::cout << "OK absolute_move_matches_windows_pixel_mapping\n";
    }
#endif
    for (const std::string kind : {"click", "scroll"}) {
      reset(); m2_kind = kind;
      // One cursor placement and ONE SendInput: [absolute move to the POINT, button or wheels].
      Require(dispatch() && m2_inputs == 2 && m2_send_calls == 1, "positive_dispatch");
      Require(m2_measured_point.x == 60 && m2_measured_point.y == 70 &&
          m2_cursor_point.x == m2_measured_point.x && m2_cursor_point.y == m2_measured_point.y,
          "explorer_dispatch_measures_action_point");
      // 1 measurement (the evidence) + 2 re-measures in dispatch: before the cursor and right
      // before the SendInput, both at the very POINT WindowsActionPoint produced.
      Require(m2_measurements == 1 && m2_rechecks == 2 &&
          m2_recheck_point.x == 60 && m2_recheck_point.y == 70,
          "explorer_dispatch_rechecks_same_action_point");
      Require(m2_sent.size() == 3 && moves_to_action_point(), "explorer_move_and_input_atomic");
      Require(kind == "click"
          ? m2_sent[1].mi.dwFlags == MOUSEEVENTF_LEFTDOWN && m2_sent[2].mi.dwFlags == MOUSEEVENTF_LEFTUP
          : m2_sent[1].mi.dwFlags == MOUSEEVENTF_WHEEL && m2_sent[2].mi.dwFlags == MOUSEEVENTF_HWHEEL &&
            m2_sent[1].mi.mouseData == WHEEL_DELTA && m2_sent[2].mi.mouseData == WHEEL_DELTA,
          "explorer_actions_follow_move");
      std::cout << "OK explorer_move_and_input_atomic\n";
      Require(!session.explorer_dispatch_evidence, "single_use_evidence");
      m2_inputs = 0; blocked("replay_emits_nothing");
      reset(); m2_kind = kind;
      const WindowsSession copy = session;
      Require(dispatch(), "original_session_dispatch");
      m2_inputs = 0;
      std::string copied_result, copied_reason; bool copied_accepted = false;
      Require(!DispatchWindowsAction(copy, action, &copied_result, &copied_reason, &copied_accepted) &&
          !copied_accepted && m2_inputs == 0, "session_copy_cannot_replay_evidence");
      reset(); m2_kind = kind; m2_view = reinterpret_cast<HWND>(202);
      blocked("explorer_view_change_before_input_emits_nothing");
      reset(); m2_kind = kind; m2_folder = L"C:\\changed-folder";
      blocked("folder_change_emits_nothing");
      reset(); m2_kind = kind; m2_foreign_owner = true;
      blocked("explorer_preview_owner_change_blocks_dispatch");
      reset(); m2_kind = kind; m2_owner = reinterpret_cast<HWND>(203);
      blocked("same_pid_different_child_emits_nothing");
      reset(); m2_kind = kind; session.pid = 43; blocked("pid_change_emits_nothing");
      reset(); m2_kind = kind; session.cancel_epoch = 3; blocked("epoch_change_emits_nothing");
      reset(); m2_kind = kind; cancellation_epoch.store(3); blocked("cancel_emits_nothing");
      reset(); m2_kind = kind; WindowsTargetListControl().stop_serial.store(1);
      blocked("stop_emits_nothing");
      reset(); m2_kind = kind; m2_cancel_during_view = true; blocked("cancel_during_view_emits_nothing");
      reset(); m2_kind = kind; m2_stop_during_view = true; blocked("stop_during_view_emits_nothing");
      reset(); m2_kind = kind; m2_identity = false; blocked("identity_change_emits_nothing");
      reset(); m2_kind = kind; m2_verified = false; blocked("unverified_emits_nothing");
      reset(); m2_kind = kind; m2_throw = true; blocked("measurement_exception_emits_nothing");
      reset(); m2_kind = kind; m2_change_during_interlock = true;
      blocked("view_changes_after_dispatch_binding");
      reset(); m2_kind = kind; session.approval_route_v2 = false; blocked("v1_emits_nothing");
      reset(); m2_kind = kind; session.approval_revoked = true; blocked("revoked_emits_nothing");
      reset(); m2_kind = kind; session.active_window = reinterpret_cast<HWND>(204);
      blocked("dialog_emits_nothing");
      reset(); m2_kind = kind; session.input_api_attempts = std::make_shared<std::atomic<std::uint64_t>>(0);
      blocked("different_session_binding_emits_nothing");
      reset(); m2_kind = kind;
      Require(!dispatch(R"({"x":0.6,"y":0.5,"deltaX":1,"deltaY":1})") && m2_inputs == 0,
          "different_action_point_emits_nothing");
      reset(); m2_kind = kind; m2_change_after_cursor = true;
      Require(!dispatch() && m2_inputs == 1, "view_change_after_cursor_prevents_send_input");
      reset(); m2_kind = kind; m2_cursor_moves_during_recheck = true;
      refused_before_send("cursor_moved_during_recheck_emits_nothing");
      reset(); m2_kind = kind; m2_input_during_recheck = true;
      refused_before_send("human_input_during_recheck_emits_nothing");
      reset(); m2_kind = kind; m2_screen_width_changes_during_recheck = true;
      refused_before_send("virtual_screen_width_change_during_recheck_emits_nothing");
      reset(); m2_kind = kind; m2_screen_origin_changes_during_recheck = true;
      refused_before_send("virtual_screen_origin_change_during_recheck_emits_nothing");
      reset(); m2_kind = kind; m2_tick_ok = false;
      Require(!dispatch() && m2_send_calls == 0, "unreadable_last_input_emits_nothing");
      reset(); m2_kind = kind; m2_change_in_send = true;
      Require(dispatch() && m2_send_calls == 1 && m2_rechecks == 2,
          "state_change_after_send_sends_no_later_input");
      {
        reset(); m2_kind = kind; m2_short_send = true;
        std::string result, reason; bool accepted = false;
        Require(!DispatchWindowsAction(session, action, &result, &reason, &accepted) && accepted &&
            reason == "input_not_confirmed", "short_send_is_unconfirmed");
      }
      // Wheel routing: with "scroll inactive windows" off the wheel goes to the keyboard focus.
      reset(); m2_kind = kind; m2_routing = MOUSEWHEEL_ROUTING_FOCUS;
      m2_focus = reinterpret_cast<HWND>(205);
      if (kind == "scroll") refused_before_send("focus_routed_wheel_outside_view_emits_nothing");
      else Require(dispatch(), "click_ignores_wheel_routing");
      reset(); m2_kind = kind; m2_routing = MOUSEWHEEL_ROUTING_HYBRID;
      m2_focus = reinterpret_cast<HWND>(205);
      if (kind == "scroll") refused_before_send("hybrid_routed_wheel_outside_view_emits_nothing");
      reset(); m2_kind = kind; m2_spi_ok = false;
      if (kind == "scroll") refused_before_send("unreadable_wheel_routing_emits_nothing");
      reset(); m2_kind = kind; m2_routing = MOUSEWHEEL_ROUTING_FOCUS;
      Require(dispatch() && m2_send_calls == 1, "focus_routed_wheel_inside_view_sends");
      reset(); m2_kind = kind; session.approved_deadline_ns = UINT64_MAX;
      Require(dispatch(), "approved_cursor_guard_positive");
      reset(); m2_kind = kind; session.approved_deadline_ns = UINT64_MAX; m2_foreign_owner = true;
      blocked("approved_cursor_guard_refusal");
    }
    for (const std::string kind : {"key", "type", "invoke", "toggle", "select", "set_text",
                                   "expand_collapse", "semantic_scroll"}) {
      reset(); m2_kind = kind; blocked("key_and_semantic_emit_nothing");
      reset(); m2_kind = kind;
      session.input_session.kind = sprint_coder::computer_use::InputSessionKind::kBackground;
      blocked("background_key_and_semantic_emit_nothing");
      reset(); m2_kind = kind; session.approved_deadline_ns = UINT64_MAX;
      std::string result, reason; bool accepted = false;
      Require(!DispatchWindowsAction(session, action, &result, &reason, &accepted,
          sprint_coder::computer_use::NativeApprovalEffect::kSupervisedAction) &&
          !accepted && m2_inputs == 0, "approved_key_and_semantic_emit_nothing");
      reset(); m2_kind = kind; session.explorer_dispatch_evidence.reset();
      blocked("missing_evidence_emits_nothing");
    }
    reset(); std::string response;
    Require(!MeasureWindowsExplorerView(frame, "{}", &response) && !session.explorer_dispatch_evidence,
        "failed_measurement_clears_evidence");
    blocked("failed_measurement_not_reusable");
    reset(); session.canonical_path = L"C:\\synthetic-app.exe";
    session.explorer_dispatch_evidence.reset(); m2_kind = "invoke"; m2_measurements = 0;
    Require(dispatch() && m2_inputs == 1 && m2_measurements == 0, "non_explorer_unchanged");
    reset(); session.explorer_dispatch_evidence.reset(); m2_kind = "click";
    m2_measurements = 0; m2_send_calls = 0; m2_inputs = 0; m2_sent.clear();
    Require(dispatch() && m2_inputs == 2 && m2_rechecks == 0 &&
        plain_flags({MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP}), "non_explorer_click_unchanged");
    reset(); session.explorer_dispatch_evidence.reset(); m2_kind = "scroll";
    m2_send_calls = 0; m2_inputs = 0; m2_sent.clear();
    Require(dispatch() && m2_inputs == 3 && m2_send_calls == 2 && m2_rechecks == 0 &&
        plain_flags({MOUSEEVENTF_HWHEEL}), "non_explorer_scroll_unchanged");
  }
  sessions.clear(); CoUninitialize();
  std::cout << "OK Explorer dispatch M2\n";
  return 0;
}
#endif
