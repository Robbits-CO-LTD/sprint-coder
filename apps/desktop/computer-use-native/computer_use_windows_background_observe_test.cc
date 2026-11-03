// P2b component seam: run the production observe publisher with controlled read boundaries.
// No windows are activated and no OS input is emitted. WGC itself requires the live seam.
#include <windows.h>
#include <cstdint>
#include <string>
#include <vector>
namespace {
struct WindowsSession;
struct WindowsDialogSetSnapshot;
struct WindowsControlBindings;
struct WindowsUiaRisk;
enum class WindowsV1UiaStop;
bool ObserveValidate(const WindowsSession&, RECT*, std::string*, WindowsDialogSetSnapshot*);
bool ObserveTree(std::uint32_t, HWND, std::string*, std::size_t*, bool);
bool ObserveBindings(std::uint32_t, HWND, WindowsControlBindings*, bool);
WindowsUiaRisk ObserveFocus(std::uint32_t);
bool ObserveSignature(std::uint32_t, const RECT&, std::string*);
bool ObserveScreen(HWND, RECT*);
bool ObserveCapture(HWND, std::uint64_t, std::uint64_t, std::vector<std::uint8_t>*,
                    std::size_t*, std::size_t*, WindowsV1UiaStop*, std::uint32_t);
bool ObservePng(std::vector<std::uint8_t>*, std::size_t, std::size_t, std::uint64_t,
                std::uint64_t, std::vector<std::string>*, std::size_t*, std::size_t*, WindowsV1UiaStop*);
}
#define wmain ProductionHostMain
#include "component-host.cc"
#undef wmain
#include <iostream>
#include <stdexcept>
#include "computer_use_windows_background_observe_test.h"

namespace {
bool background = true, valid = true, tree_ok = true, capture_ok = true, change_bounds = false;
bool cancel_capture = false;
unsigned validations = 0, focus_reads = 0, signature_reads = 0, captures = 0, cases = 0;
HWND target = reinterpret_cast<HWND>(static_cast<UINT_PTR>(7));
void Check(bool value) { if (!value) throw std::runtime_error("background observation seam failed"); }
bool ObserveValidate(const WindowsSession& session, RECT* bounds, std::string* reason,
                     WindowsDialogSetSnapshot* dialogs) {
  ++validations;
  Check(session.window == target);
  if (!valid) { *reason = "session_identity_changed"; return false; }
  *bounds = {0, 0, change_bounds && validations > 1 ? 101 : 100, 80};
  dialogs->active_window = target;
  dialogs->active_identity = "synthetic-window";
  dialogs->active_kind = "application";
  dialogs->digest = "synthetic-dialogs";
  return true;
}
bool ObserveTree(std::uint32_t pid, HWND window, std::string* tree, std::size_t* nodes, bool bg) {
  Check(pid == 7 && window == target && bg == background);
  *tree = "{}"; *nodes = 1; return tree_ok;
}
bool ObserveBindings(std::uint32_t pid, HWND window, WindowsControlBindings*, bool bg) {
  Check(pid == 7 && window == target && bg == background); return true;
}
WindowsUiaRisk ObserveFocus(std::uint32_t pid) {
  Check(pid == 7 && !background); ++focus_reads; return {};
}
bool ObserveSignature(std::uint32_t pid, const RECT&, std::string* signature) {
  Check(pid == 7 && !background); ++signature_reads; *signature = "synthetic-focus"; return true;
}
bool ObserveScreen(HWND window, RECT* bounds) {
  Check(window == target); *bounds = {0, 0, 1920, 1080}; return true;
}
bool ObserveCapture(HWND window, std::uint64_t, std::uint64_t, std::vector<std::uint8_t>* bytes,
                    std::size_t* width, std::size_t* height, WindowsV1UiaStop* stop, std::uint32_t pid) {
  ++captures; Check(window == target && pid == (background ? 7u : 0u));
  if (!capture_ok) { *stop = WindowsV1UiaStop::kTimeout; return false; }
  if (cancel_capture) cancellation_epoch.fetch_add(1);
  *bytes = {1, 2, 3}; *width = 100; *height = 80; return true;
}
bool ObservePng(std::vector<std::uint8_t>*, std::size_t, std::size_t, std::uint64_t,
                std::uint64_t, std::vector<std::string>* digests, std::size_t* columns,
                std::size_t* rows, WindowsV1UiaStop*) {
  *digests = {"synthetic-patch"}; *columns = 1; *rows = 1; return true;
}
void Run(bool expected) {
  cancellation_epoch.store(0); parent_process_dead.store(false);
  validations = focus_reads = signature_reads = captures = 0;
  WindowsSession session;
  session.pid = 7; session.window = target; session.cancel_epoch = 0;
  session.input_session.kind = background ? sprint_coder::computer_use::InputSessionKind::kBackground :
      sprint_coder::computer_use::InputSessionKind::kForeground;
  std::string response, reason;
  std::vector<std::uint8_t> bytes;
  Check(ObserveWindowsWindow(session, &response, &bytes, &reason) == expected);
  Check(session.has_observation == expected && session.observation_revision == (expected ? 1u : 0u));
  if (background) Check(focus_reads == 0 && signature_reads == 0);
  if (expected) {
    Check(captures == 1 && !bytes.empty());
    Check(session.has_focused_element_signature == !background);
    Check(response.find(background ? "\"focusedElementSignature\":null" :
        "\"focusedElementSignature\":\"synthetic-focus\"") != std::string::npos);
  } else Check(response.empty());
  ++cases;
}
}
int wmain() {
  try {
    Check(CheckWindowsBackgroundObservation());
    WindowsSession gated;
    gated.input_session.kind = sprint_coder::computer_use::InputSessionKind::kBackground;
    RECT bounds{};
    WindowsDialogSetSnapshot dialogs;
    std::string reason;
    Check(!ValidateWindowsObservationSession(gated, &bounds, &reason, &dialogs));
    ++cases;
    Run(true); // Occlusion is represented by background; only the bound window is read.
    background = false; Run(true); Check(focus_reads == 1 && signature_reads == 1);
    background = true; valid = false; Run(false); Check(captures == 0); valid = true;
    tree_ok = false; Run(false); Check(captures == 0); tree_ok = true;
    capture_ok = false; Run(false); Check(captures == 1); capture_ok = true;
    change_bounds = true; Run(false); change_bounds = false;
    cancel_capture = true; Run(false); cancel_capture = false;
    std::cout << "PASS: " << cases << " background observation component cases\n";
    return 0;
  } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
