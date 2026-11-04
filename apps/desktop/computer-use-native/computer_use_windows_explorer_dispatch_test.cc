// Included at two seams of the complete host; only external measurements and input APIs are fake.
#if defined(SPRINT_CODER_EXPLORER_DISPATCH_DEPENDENCIES)
std::string m2_kind = "click";
unsigned m2_inputs = 0, m2_measurements = 0;
POINT m2_measured_point{}, m2_cursor_point{};
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
UINT M2Send(const WindowsSession &, const RECT &, std::uint64_t, UINT count, LPINPUT) {
  ++m2_inputs; return count;
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
WindowsExplorerShellView M2ReadView(HWND, const std::function<bool()> &) {
  ++m2_measurements;
  if (m2_throw) throw std::bad_alloc();
  if (m2_cancel_during_view) cancellation_epoch.fetch_add(1);
  if (m2_stop_during_view) WindowsTargetListControl().stop_serial.fetch_add(1);
  return WindowsExplorerShellView{m2_folder, m2_view};
}
WindowsExplorerRefusal M2Point(HWND, HWND, DWORD, POINT point, HWND *owner) {
  m2_measured_point = point; *owner = m2_owner;
  return m2_foreign_owner ? WindowsExplorerRefusal::kPointForeignOwner : WindowsExplorerRefusal::kNone;
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
    m2_inputs = m2_measurements = 0; m2_kind = "click";
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
  if constexpr (!gate) {
    reset(); Require(dispatch() && m2_inputs == 2, "gate_off_click_unchanged");
    Require(m2_measurements == 0, "gate_off_never_measures");
    reset(); m2_kind = "invoke";
    Require(dispatch() && m2_inputs == 1 && m2_measurements == 0, "gate_off_semantic_unchanged");
  } else {
    for (const std::string kind : {"click", "scroll"}) {
      reset(); m2_kind = kind;
      Require(dispatch() && m2_inputs == (kind == "click" ? 2u : 3u), "positive_dispatch");
      Require(m2_measured_point.x == 60 && m2_measured_point.y == 70 &&
          m2_cursor_point.x == m2_measured_point.x && m2_cursor_point.y == m2_measured_point.y,
          "explorer_dispatch_rechecks_same_action_point");
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
  }
  sessions.clear(); CoUninitialize();
  std::cout << "OK Explorer dispatch M2\n";
  return 0;
}
#endif
