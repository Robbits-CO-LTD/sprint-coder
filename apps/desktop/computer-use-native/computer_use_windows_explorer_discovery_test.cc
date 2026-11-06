// Component seam: the production worker, candidate JSON and V2 verdict stay intact.
// Only OS/image/view reads are synthetic. No window or input is created here.
#if defined(SPRINT_CODER_EXPLORER_DISCOVERY_DEPENDENCIES)
struct WindowsV2Judgement;
struct WindowsExplorerPrestartScope;
BOOL E1Visible(HWND);
DWORD E1Owner(HWND, DWORD*);
bool E1Bounds(HWND, RECT*);
int E1Title(HWND, LPWSTR, int);
HWND E1Window(HWND, UINT);
BOOL E1Enabled(HWND);
bool E1Application(HWND);
HWND E1Foreground();
bool E1Open(const std::wstring&, LockedWindowsExecutable*);
bool E1Enumerate(const std::wstring&, std::string_view, std::string_view, std::string_view,
                 std::vector<std::string>*, const std::function<bool()>&, bool, bool);
void E1Process(std::uint32_t, const WindowsTargetFactsContext&, WindowsV2Judgement*);
bool E1Identity(WindowsV2Judgement*);
bool E1View(const WindowsV2Judgement&, HWND, const WindowsExplorerPrestartScope&);
bool E1Elevated(DWORD);
std::optional<std::string> E1Class(HWND, DWORD);
#else
#define wmain ProductionHostMain
#include "explorer-host.cc"
#undef wmain
#include "computer_use_target_eligibility_golden_generated.h"
#include <stdexcept>

namespace {
using namespace sprint_coder::computer_use;
HWND e1_window = reinterpret_cast<HWND>(100);
std::string e1_case;
unsigned e1_measurements = 0;
void Check(bool ok, const char* name) {
  if (!ok) throw std::runtime_error(name);
}
WindowsExecutableIdentity E1Executable() {
  WindowsExecutableIdentity value;
  value.path = L"C:\\Windows\\explorer.exe";
  value.path_utf8 = "C:\\Windows\\explorer.exe";
  value.identity_digest.assign(64, 'a');
  value.executable_digest.assign(64, 'b');
  value.signer_digest.assign(64, 'c');
  return value;
}
BOOL E1Visible(HWND) { return TRUE; }
DWORD E1Owner(HWND, DWORD* pid) { *pid = 42; return 1; }
bool E1Bounds(HWND, RECT* bounds) { *bounds = RECT{0, 0, 800, 600}; return true; }
int E1Title(HWND, LPWSTR, int) { return 0; }
HWND E1Window(HWND, UINT) { return nullptr; }
BOOL E1Enabled(HWND) { return TRUE; }
bool E1Application(HWND) { return true; }
HWND E1Foreground() { return e1_window; }
bool E1Open(const std::wstring&, LockedWindowsExecutable* out) {
  out->identity = E1Executable(); return true;
}
bool E1Enumerate(const std::wstring&, std::string_view identity, std::string_view executable,
                 std::string_view, std::vector<std::string>* rows,
                 const std::function<bool()>& current, bool include_start_identity, bool explorer_route) {
  WindowEnumerationContext context;
  context.pid = 42;
  context.app_identity = identity;
  context.executable_digest = executable;
  context.process_start = "123456";
  context.identity_matches = true;
  context.elevated = false;
  context.proxy = true; // The common Explorer denial must be waived per-window only.
  context.explorer_route = explorer_route;
  context.include_start_identity = include_start_identity;
  context.still_valid = current;
  CollectTopLevelWindow(e1_window, reinterpret_cast<LPARAM>(&context));
  *rows = context.candidates;
  return current();
}
void E1Process(std::uint32_t pid, const WindowsTargetFactsContext&, WindowsV2Judgement* out) {
  ++e1_measurements;
  out->measured.pid = pid;
  out->measured.image_path = E1Executable().path;
  auto& facts = out->measured.facts;
  facts = TargetGoldenCases().front().facts;
  facts.image_root = "windows_directory";
  facts.image_relative_path = facts.image_leaf = facts.original_filename = "explorer.exe";
  facts.signer_microsoft_root = true;
  if (e1_case == "fake") facts.signature = "unsigned";
  if (e1_case == "placement") facts.image_root = "other";
  if (e1_case == "elevated") facts.token_elevated = true;
}
bool E1Identity(WindowsV2Judgement* out) {
  out->executable.identity = E1Executable();
  out->app_identity.assign(64, e1_case == "app" ? 'd' : 'a');
  out->process_start = e1_case == "pid-reused" ? "123457" : "123456";
  if (e1_case == "image") out->executable.identity.executable_digest.assign(64, 'd');
  out->identity_ok = true;
  return true;
}
bool E1View(const WindowsV2Judgement&, HWND window, const WindowsExplorerPrestartScope& scope) {
  if (e1_case == "stop") WindowsTargetListControl().stop_serial.fetch_add(1);
  return scope.current() && window == e1_window && e1_case != "home" && e1_case != "this-pc";
}
bool E1Elevated(DWORD) { return e1_case == "elevated"; }
std::optional<std::string> E1Class(HWND, DWORD) {
  return e1_case == "other-window" ? "Shell_TrayWnd" : "CabinetWClass";
}
}

int wmain() {
  try {
    windows_helper_generation = 1;
    windows_v2_main_pid = GetCurrentProcessId();
    windows_v2_list_generation = 1;
    const auto query = [](std::string_view route) {
      const auto identity = E1Executable();
      return "{\"canonicalPath\":\"C:\\\\Windows\\\\explorer.exe\",\"identityDigest\":\"" +
          identity.identity_digest + "\",\"executableDigest\":\"" + identity.executable_digest +
          "\",\"signerDigest\":\"" + identity.signer_digest +
          "\",\"includeStartIdentity\":true,\"classifierRoute\":\"" + std::string(route) + "\"}";
    };
    WindowsDiscoveryWorkControl work;
    work.current = [] { return true; };
    work.remaining = [](DWORD value) { return value; };
    work.claim_launch = [] { throw std::runtime_error("discovery must never launch Explorer"); return false; };
    work.retire_launch = [] {};
    std::string response, reason;
    Check(!MeasureWindowsDiscovery(query("v1"), work, &response, &reason) &&
          reason == "target_application_unsupported", "V1 refused");
    if (!kWindowsExplorerException || !kNativeEligibilityIsV2) {
      Check(!MeasureWindowsDiscovery(query("v2"), work, &response, &reason) &&
            reason == "target_application_unsupported" && e1_measurements == 0, "gate off refused");
      std::cout << "OK explorer_discovery_gate_off_preserves_v1\n";
      return 0;
    }
    Check(MeasureWindowsDiscovery(query("v2"), work, &response, &reason), "discovery measured");
    Check(response.find("\"eligible\":true") != std::string::npos &&
          response.find("\"maximumMode\":\"supervised\"") != std::string::npos &&
          response.find("\"facts\":{") != std::string::npos &&
          response.find("\"windowClass\":\"CabinetWClass\"") != std::string::npos &&
          response.find("\"pid\":42") != std::string::npos, "bound facts emitted");
    std::cout << "FACTS " << response << '\n';
    for (const auto name : {"fake", "placement", "other-window", "home", "this-pc", "elevated",
                            "app", "pid-reused", "image", "stop"}) {
      e1_case = name;
      Check(MeasureWindowsDiscovery(query("v2"), work, &response, &reason), "refused candidate read");
      Check(response.find("\"eligible\":true") == std::string::npos &&
            response.find("\"facts\":") == std::string::npos, name);
    }
    e1_case.clear();
    Check(MeasureWindowsDiscovery(query("v2"), work, &response, &reason) &&
          response.find("\"eligible\":true") != std::string::npos && e1_measurements == 12,
          "each discovery remeasures, no stale facts cache");
    std::cout << "OK explorer_native_discovery_emits_bound_facts\n";
    return 0;
  } catch (const std::exception& error) {
    std::cout << "FAIL " << error.what() << '\n';
    return 1;
  }
}
#endif
