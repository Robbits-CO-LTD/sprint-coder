// Component-only matrix for the production shared new-start engine. Identity measurements and
// window facts are controlled inputs; this is not signed-package, grant or real-input acceptance.
#include <windows.h>
#include <atomic>
#include <string>
namespace {
struct LockedWindowsExecutable;
struct WindowsStartInput;
struct WindowsNewStartMeasurement;
struct WindowsTargetFactsContext;
HANDLE ComponentOpenProcess(DWORD access, BOOL inherit, DWORD pid);
bool ComponentOpenExecutable(HANDLE process, LockedWindowsExecutable* output);
BOOL ComponentCloseHandle(HANDLE handle);
BOOL ComponentDuplicateHandle(HANDLE source_process, HANDLE source, HANDLE target_process,
                              LPHANDLE target, DWORD access, BOOL inherit, DWORD options);
WindowsTargetFactsContext ComponentContext(std::uint32_t pid);
bool ComponentAdmit(const WindowsStartInput&, WindowsNewStartMeasurement*);
bool ComponentElevated(std::uint32_t);
BOOL ComponentWindow(HWND);
bool ComponentApplicationWindow(HWND);
bool ComponentClientBounds(HWND, RECT*);
bool ComponentTargetFacts(std::uint32_t, HWND, RECT*);
bool ComponentScreenBounds(HWND, RECT*);
HWND ComponentForeground();
BOOL ComponentEnabled(HWND);
bool ComponentTakeover(HWND);
BOOL ComponentIconic(HWND);
BOOL ComponentShow(HWND, int);
BOOL ComponentFocus(HWND);
HRESULT ComponentCoInitialize(LPVOID, DWORD);
void ComponentCoUninitialize();
void ComponentBeforeThread();
void ComponentBeforeAdopt();
struct ComponentWorkerLifetime { ComponentWorkerLifetime(); ~ComponentWorkerLifetime(); };
}
#define wmain ProductionHostMain
#include "component-host.cc"
#undef wmain
#include <iostream>
#include <set>
#include <stdexcept>

namespace {
using Basis = sprint_coder::computer_use::EligibilityBasis;
struct Case {
  bool v2 = false, unsigned_image = false, bad_signer = false, bad_digest = false;
  bool bad_identity = false, bad_path = false, bad_window_identity = false;
  bool unknown_language = false, elevated = false, proxy = false, denied = false;
  bool bad_before_geometry = false, changed_after_geometry = false, resume = false;
  bool stop_during_read = false, parent_during_read = false, io_failure = false;
  bool thread_failure = false, allocation_failure = false, com_failure = false;
  std::uint64_t global_epoch = 0, closed_epoch = 0, input_epoch = 0;
  std::optional<std::uint64_t> adopt_epoch;
};
Case current;
std::wstring canonical;
std::atomic<unsigned> workers{0}, reads{0}, contexts{0}, com_calls{0}, com_releases{0}, input_calls{0};
std::mutex handles_mutex;
std::set<HANDLE> tracked_handles;
unsigned case_count = 0;
void Check(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
void Track(HANDLE handle) {
  if (handle == nullptr || handle == INVALID_HANDLE_VALUE) return;
  std::lock_guard lock(handles_mutex); tracked_handles.insert(handle);
}
BOOL ComponentCloseHandle(HANDLE handle) {
  const BOOL closed = ::CloseHandle(handle);
  if (closed) { std::lock_guard lock(handles_mutex); tracked_handles.erase(handle); }
  return closed;
}
HANDLE ComponentOpenProcess(DWORD access, BOOL inherit, DWORD pid) {
  Check(pid == GetCurrentProcessId(), "component may read only its own process");
  HANDLE handle = ::OpenProcess(access, inherit, pid); Track(handle); return handle;
}
BOOL ComponentDuplicateHandle(HANDLE sp, HANDLE source, HANDLE tp, LPHANDLE target,
                              DWORD access, BOOL inherit, DWORD options) {
  const BOOL copied = ::DuplicateHandle(sp, source, tp, target, access, inherit, options);
  if (copied) Track(*target); return copied;
}
bool ComponentOpenExecutable(HANDLE process, LockedWindowsExecutable* output) {
  if (current.io_failure) return false;
  const bool opened = OpenLockedProcessExecutable(process, output);
  if (!opened) return false;
  Track(output->file); reads.fetch_add(1);
  // Keep the real file handle/FileId. These fields model measured identity facts for the
  // eligibility/consumer tests; no result from this executable is public V1 Start evidence.
  auto& identity = output->identity;
  identity.path = current.bad_path ? L"C:\\different.exe" : canonical;
  if (current.proxy) identity.path = L"C:\\Windows\\System32\\ApplicationFrameHost.exe";
  if (current.denied) identity.path = L"C:\\Windows\\System32\\cmd.exe";
  identity.identity_digest = std::string(64, current.bad_identity ? 'f' : 'a');
  identity.executable_digest = std::string(64, current.bad_digest ? 'f' : 'b');
  identity.signer_digest = current.unsigned_image ? "" : std::string(64, current.bad_signer ? 'f' : 'c');
  identity.microsoft_signer = !current.unsigned_image;
  identity.policy_language = current.unknown_language ? "unknown" : "en";
  if (current.stop_during_read) WindowsTargetListControl().stop_serial.fetch_add(1);
  if (current.parent_during_read) parent_process_dead.store(true);
  return true;
}
WindowsTargetFactsContext ComponentContext(std::uint32_t pid) {
  contexts.fetch_add(1); WindowsTargetFactsContext value; value.lineage_root_pid = pid; return value;
}
bool ComponentAdmit(const WindowsStartInput&, WindowsNewStartMeasurement* measured) {
  measured->maximum_mode = "observe_only"; return true;
}
bool ComponentElevated(std::uint32_t) { return current.elevated; }
BOOL ComponentWindow(HWND) { return TRUE; }
bool ComponentApplicationWindow(HWND) { return true; }
bool ComponentClientBounds(HWND, RECT* output) {
  *output = {current.bad_before_geometry ? 5 : 0, 0, 100, 80}; return true;
}
bool ComponentTargetFacts(std::uint32_t, HWND, RECT* output) {
  *output = {current.changed_after_geometry ? 5 : 0, 0, 100, 80}; return true;
}
bool ComponentScreenBounds(HWND, RECT* output) { *output = {0, 0, 800, 600}; return true; }
HWND ComponentForeground() { return reinterpret_cast<HWND>(static_cast<UINT_PTR>(1)); }
BOOL ComponentEnabled(HWND) { return TRUE; }
bool ComponentTakeover(HWND) { return false; }
BOOL ComponentIconic(HWND) { return FALSE; }
BOOL ComponentShow(HWND, int) { input_calls.fetch_add(1); return TRUE; }
BOOL ComponentFocus(HWND) { input_calls.fetch_add(1); return TRUE; }
HRESULT ComponentCoInitialize(LPVOID reserved, DWORD flags) {
  com_calls.fetch_add(1); return current.com_failure ? E_FAIL : ::CoInitializeEx(reserved, flags);
}
void ComponentCoUninitialize() { com_releases.fetch_add(1); ::CoUninitialize(); }
void ComponentBeforeThread() { if (current.thread_failure) throw std::runtime_error("thread failure"); }
void ComponentBeforeAdopt() {
  if (current.allocation_failure) throw std::bad_alloc();
  if (current.adopt_epoch) {
    std::lock_guard lock(WindowsTargetListControl().stop_mutex);
    cancellation_epoch.store(*current.adopt_epoch); last_closed_cancel_epoch = *current.adopt_epoch;
  }
}
ComponentWorkerLifetime::ComponentWorkerLifetime() { workers.fetch_add(1); }
ComponentWorkerLifetime::~ComponentWorkerLifetime() { workers.fetch_sub(1); }
void WaitWorkers() {
  const auto until = GetTickCount64() + 5000;
  while ((workers.load() != 0 || WindowsTargetListWorkerRunning().load()) && GetTickCount64() < until) Sleep(1);
  Check(workers.load() == 0 && !WindowsTargetListWorkerRunning().load(), "worker retirement");
}
void Run(const char* name, Case config, bool expected, const char* reason, unsigned ticket_calls) {
  current = config; reads = 0; contexts = 0; com_calls = 0; com_releases = 0; input_calls = 0;
  parent_process_dead = false; cancellation_epoch = config.global_epoch;
  last_closed_cancel_epoch = config.closed_epoch; WindowsTargetListControl().stop_serial = 0;
  WindowsTargetListControl().context_candidate.reset(); WindowsV2FactsContextCache().reset();
  windows_v2_main_pid = config.v2 ? GetCurrentProcessId() : 0; windows_v2_list_generation = 1;
  WindowsStartInput input;
  input.eligibility_basis = config.v2 ? Basis::kV2Denylist : Basis::kV1Allowlist;
  input.pid = GetCurrentProcessId(); input.window = reinterpret_cast<HWND>(static_cast<UINT_PTR>(1)); input.window_value = 1;
  input.session_key = std::string(16, static_cast<char>('A' + case_count)); input.session_id = name;
  input.app_identity = std::string(64, 'a'); input.executable_digest = std::string(64, 'b');
  input.signer_digest = config.unsigned_image ? "" : std::string(64, 'c'); input.canonical_path = canonical;
  if (config.proxy) input.canonical_path = L"C:\\Windows\\System32\\ApplicationFrameHost.exe";
  if (config.denied) input.canonical_path = L"C:\\Windows\\System32\\cmd.exe";
  input.bounds_width = 100; input.bounds_height = 80; input.explicit_resume = config.resume;
  input.cancel_epoch = config.input_epoch; input.profile_revision = 4;
  input.ruleset_version = 1; input.requested_generation = 1;
  std::string created; Check(ReadProcessStartIdentity(GetCurrentProcess(), &created), "own creation time");
  input.expected_window_identity = config.bad_window_identity ? std::string(64, 'f') :
      Sha256String("computer-window-identity-v1\n" + input.app_identity + "\n" + created + "\n1");
  ticket_states[input.session_key].generation = 10;
  std::string response, failure; bool succeeded = false;
  try { succeeded = StartWindowsNewSession(input, &response, &failure); }
  catch (const std::bad_alloc&) { Check(config.allocation_failure, "unexpected allocation error"); failure = "allocation_failure"; }
  WaitWorkers();
  Check(succeeded == expected, name);
  if (!expected) Check(failure == reason, "expected refusal reason");
  Check(ticket_states[input.session_key].generation == 10 + ticket_calls, "ticket invalidation count");
  Check(input_calls.load() == 0, "no native input API in component cases");
  if (!config.v2) Check(contexts.load() == 0 && com_calls.load() == 0 && !WindowsV2FactsContextCache(), "V1 has no V2 context or COM prerequisite");
  Check(com_calls.load() == com_releases.load() + (config.v2 && config.com_failure ? 1u : 0u), "COM balance");
  if (expected) {
    Check(sessions.size() == 1, "single adopted session");
    const auto& session = sessions.at(input.session_key);
    const auto epoch = std::max(config.input_epoch, config.adopt_epoch.value_or(config.global_epoch));
    Check(session.eligibility_basis == input.eligibility_basis && session.cancel_epoch == epoch && cancellation_epoch.load() == epoch, "basis and epoch");
    Check(session.maximum_mode == (config.v2 ? "observe_only" : "full_access_app") && session.policy_language == "en", "mode and language");
    Check(!session.not_web_file, "no invented not-web key");
    std::uint64_t reply_epoch = 0, count = 1;
    Check(ReadJsonUint64(response, "cancelEpoch", &reply_epoch) && reply_epoch == epoch &&
          ReadJsonUint64(response, "inputAttemptCount", &count) && count == 0, "bound receipt fields");
    WindowsFileIdentity actual;
    Check(ReadWindowsFileIdentity(session.executable_file, &actual) && actual.volume_serial == session.executable_volume_serial &&
          std::memcmp(actual.file_id.Identifier, session.executable_file_id.Identifier, sizeof(actual.file_id.Identifier)) == 0, "real held FileId handoff");
  } else Check(sessions.empty(), "refusal cannot adopt");
  for (auto& entry : sessions) ReleaseWindowsSessionResources(&entry.second);
  sessions.clear(); ticket_states.clear();
  { std::lock_guard lock(handles_mutex); Check(tracked_handles.empty(), "all tracked handles released once"); }
  ++case_count; std::cout << "CASE:" << name << "\n";
}
}
int wmain() {
  try {
    std::vector<wchar_t> system(32768); const auto length = GetSystemDirectoryW(system.data(), static_cast<UINT>(system.size()));
    Check(length != 0 && length < system.size(), "system directory"); canonical.assign(system.data(), length); canonical += L"\\notepad.exe";
    Run("v1-normal", {}, true, "", 2);
    Case c; c.unsigned_image = true; Run("v1-unsigned", c, false, "session_target_rejected", 0);
    c = {}; c.bad_signer = true; Run("v1-signer", c, false, "session_target_rejected", 0);
    c = {}; c.bad_digest = true; Run("v1-digest", c, false, "session_target_rejected", 0);
    c = {}; c.bad_identity = true; Run("v1-identity", c, false, "session_target_rejected", 0);
    c = {}; c.bad_path = true; Run("v1-path", c, false, "session_target_rejected", 0);
    c = {}; c.unknown_language = true; Run("v1-language", c, false, "session_target_rejected", 0);
    c = {}; c.bad_window_identity = true; Run("v1-window", c, false, "window_identity_changed", 0);
    c = {}; c.proxy = true; Run("v1-proxy", c, false, "session_target_rejected", 0);
    c = {}; c.denied = true; Run("v1-denied", c, false, "session_target_rejected", 0);
    c = {}; c.elevated = true; Run("v1-elevated", c, false, "session_target_rejected", 0);
    c = {}; c.bad_before_geometry = true; Run("v1-before-geometry", c, false, "window_geometry_changed", 1);
    c.resume = true; Run("v1-geometry-before-resume", c, false, "window_geometry_changed", 1);
    c = {}; c.resume = true; Run("v1-new-resume", c, false, "session_input_invalid", 1);
    c = {}; c.changed_after_geometry = true; Run("v1-after-geometry", c, true, "", 2);
    c = {}; c.global_epoch = 7; Run("v1-old-unclosed-epoch", c, false, "session_start_canceled", 0);
    c.closed_epoch = 7; Run("v1-closed-epoch", c, true, "", 2);
    c = {}; c.input_epoch = 9; Run("v1-future-epoch", c, true, "", 2);
    c = {}; c.adopt_epoch = 7; Run("v1-current-adopt-epoch", c, true, "", 2);
    c = {}; c.stop_during_read = true; Run("v1-stop-during-read", c, false, "session_start_canceled", 0);
    c = {}; c.parent_during_read = true; Run("v1-parent-during-read", c, false, "session_start_canceled", 0);
    c = {}; c.io_failure = true; Run("v1-io-failure", c, false, "session_target_rejected", 0);
    c = {}; c.thread_failure = true; Run("v1-thread-failure", c, false, "session_target_rejected", 0);
    c = {}; c.allocation_failure = true; Run("v1-allocation-failure", c, false, "allocation_failure", 1);
    c = {}; c.com_failure = true; Run("v1-no-com-dependency", c, true, "", 2);
    c = {}; c.v2 = true; Run("v2-normal", c, true, "", 1);
    c.changed_after_geometry = true; Run("v2-after-geometry", c, false, "window_geometry_changed", 1);
    c = {}; c.v2 = true; c.resume = true; c.bad_before_geometry = true; Run("v2-resume-before-geometry", c, false, "session_input_invalid", 1);
    c = {}; c.v2 = true; c.adopt_epoch = 7; Run("v2-initial-epoch-cas", c, false, "session_start_canceled", 1);
    std::cout << "PASS: " << case_count << " component cases, no GUI or input\n"; return 0;
  } catch (const std::exception& error) { std::cerr << "FAIL: " << error.what() << "\n"; return 1; }
}
