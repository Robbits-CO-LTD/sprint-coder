// Component-only matrix for the production shared new-start engine. Identity measurements and
// window facts are controlled inputs; this is not signed-package, grant or real-input acceptance.
#include <windows.h>
#include <atomic>
#include <string>
#include "computer_use_windows_target_facts.h"
namespace {
struct WindowsSession;
struct WindowsDialogSetSnapshot;
struct WindowsExecutableIdentity;
// Monitor behavior is covered by the dedicated P3a native seam.
bool ComponentBackgroundMonitor(WindowsSession&, DWORD, HWND, bool, std::string*);
bool ComponentBackgroundMonitorReady(const WindowsSession&) { return true; }
bool ComponentBackgroundGate();
bool ComponentBackgroundSupported(const WindowsExecutableIdentity&);
sprint_coder::computer_use::WindowsBackgroundStartFacts ComponentBackgroundFacts(std::uint32_t, HWND, RECT*);
bool ComponentBackgroundDialogs(const WindowsSession&, WindowsDialogSetSnapshot*, std::string*);
struct LockedWindowsExecutable;
struct WindowsStartInput;
struct WindowsNewStartMeasurement;
struct WindowsTargetFactsContext;
struct WindowsV2Judgement;
void ComponentStoreJudgement(DWORD, HWND, const WindowsTargetFactsContext&, WindowsV2Judgement*);
HANDLE ComponentOpenProcess(DWORD access, BOOL inherit, DWORD pid);
bool ComponentOpenExecutable(HANDLE process, LockedWindowsExecutable* output);
BOOL ComponentCloseHandle(HANDLE handle);
BOOL ComponentCancelSynchronousIo(HANDLE thread);
BOOL ComponentDuplicateHandle(HANDLE source_process, HANDLE source, HANDLE target_process,
                              LPHANDLE target, DWORD access, BOOL inherit, DWORD options);
WindowsTargetFactsContext ComponentContext(std::uint32_t pid);
bool ComponentAdmit(const WindowsStartInput&, WindowsNewStartMeasurement*);
bool ComponentElevated(std::uint32_t);
BOOL ComponentWindow(HWND);
bool ComponentStartTime(HANDLE, std::string*);
DWORD ComponentWindowOwner(HWND, LPDWORD);
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
void ComponentBeforeMeasurement();
void ComponentBeforeAdopt();
}
#define wmain ProductionHostMain
#include "component-host.cc"
#undef wmain
#include <iostream>
#include <set>
#include <stdexcept>

namespace {
// Supply the receipt state without starting OS monitor threads.
bool ComponentBackgroundMonitor(WindowsSession& session, DWORD pid, HWND window,
                                bool human_resume, std::string*) {
  const auto epoch = session.background_monitor
      ? session.background_monitor->state.Snapshot().epoch + (human_resume ? 1 : 0) : 1;
  session.background_monitor = std::make_shared<WindowsBackgroundMonitor>(pid, window, epoch);
  return true;
}
using Basis = sprint_coder::computer_use::EligibilityBasis;
struct Case {
  bool background_gate = false, background_supported = false;
  bool cloaked = false, other_desktop = false, other_virtual_desktop = false, unreadable = false;
  bool hidden = false, background_dialog = false, late_cloak = false;
  bool supervised_ceiling = false;
  bool bound_start = false, bad_start = false, identity_read_failure = false;
  bool window_replaced = false, late_window = false, stop_identity = false;
  bool iconic = false, focus_failure = false, stop_after_restore = false, stop_after_focus = false;
  unsigned expected_focus_calls = 0;
  bool v2 = false, unsigned_image = false, bad_signer = false, bad_digest = false;
  bool bad_identity = false, bad_path = false, bad_window_identity = false;
  bool unknown_language = false, elevated = false, proxy = false, denied = false;
  bool bad_before_geometry = false, changed_after_geometry = false, resume = false;
  bool stop_during_read = false, parent_during_read = false, io_failure = false;
  bool measurement_failure = false, allocation_failure = false, com_failure = false;
  bool latch_during_read = false;
  bool occupied = false;
  bool store_notepad = false, changed_store_key = false;
  std::uint64_t global_epoch = 0, closed_epoch = 0, input_epoch = 0;
  std::optional<std::uint64_t> adopt_epoch;
};
Case current;
unsigned identity_reads = 0, background_reads = 0;
std::wstring canonical;
std::atomic<unsigned> reads{0}, contexts{0}, com_calls{0}, com_releases{0}, input_calls{0};
std::mutex handles_mutex;
std::set<HANDLE> tracked_handles;
unsigned case_count = 0;
unsigned cancel_calls = 0;
DWORD consumer_thread = 0;
void Check(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
BOOL ComponentCancelSynchronousIo(HANDLE thread) {
  Check(GetThreadId(thread) == consumer_thread,
        "cancellation uses a real thread handle");
  ++cancel_calls;
  return TRUE;
}
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
  if (current.latch_during_read) {
    const auto owner = WindowsStarts().input_owner;
    Check(owner != nullptr, "start owns cancellation");
    std::thread reader([&] { LatchWindowsPendingStop(owner->session_key, owner->session_id); });
    reader.join();
    Check(cancel_calls == 1, "Stop cancels the registered measurement thread");
    return false;
  }
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
void ComponentStoreJudgement(DWORD, HWND, const WindowsTargetFactsContext&, WindowsV2Judgement* out) {
  using namespace sprint_coder::computer_use;
  Check(current.store_notepad, "controlled Store measurement only");
  Check(ComponentOpenExecutable(GetCurrentProcess(), &out->executable), "Store held image");
  out->verdict = {TargetVerdictKind::kEligible, "observe_only"};
  out->app_identity = std::string(64, 'a');
  Check(ReadProcessStartIdentity(GetCurrentProcess(), &out->process_start), "Store creation time");
  out->measured.file_identity = out->executable.identity.file_identity;
  out->held_key = WindowsFileKeyOf(*out->measured.file_identity);
  if (current.changed_store_key) out->held_key->file_id[0] ^= 1;
  auto& facts = out->measured.facts;
  facts.platform = TargetPlatform::kWin32;
  facts.running_image_matches = true; facts.packaged = true;
  facts.package_family = "Microsoft.WindowsNotepad_8wekyb3d8bbwe";
  facts.package_signature_kind = "store"; facts.package_development_mode = false;
  facts.image_root = "windows_apps"; facts.image_volume = "fixed"; facts.pe_subsystem = "gui";
  out->not_web_package = WindowsPackageIdentityParts{*facts.package_family,
      "8wekyb3d8bbwe", "notepad\\notepad.exe", {}};
}
bool ComponentAdmit(const WindowsStartInput& input, WindowsNewStartMeasurement* measured) {
  if (current.store_notepad) {
    LockedWindowsExecutable locked;
    Check(ComponentOpenExecutable(GetCurrentProcess(), &locked), "Store start locked image");
    WindowsTargetFactsContext context; context.lineage_root_pid = GetCurrentProcessId();
    return AdmitWindowsV2StartInContext(input.pid, input.window, locked, context,
        sprint_coder::computer_use::DenyRulesetVersion(sprint_coder::computer_use::TargetPlatform::kWin32),
        1, 1, true, input.app_identity, input.executable_digest, input.signer_digest,
        &measured->maximum_mode, &measured->not_web_file);
  }
  measured->maximum_mode = current.supervised_ceiling ? "supervised" : "observe_only"; return true;
}
bool ComponentBackgroundGate() { return current.background_gate; }
bool ComponentBackgroundSupported(const WindowsExecutableIdentity&) { return current.background_supported; }
sprint_coder::computer_use::WindowsBackgroundStartFacts ComponentBackgroundFacts(std::uint32_t, HWND, RECT* bounds) {
  ++background_reads;
  *bounds = {0, 0, 100, 80};
  if (current.unreadable) return {};
  return {!current.hidden, !current.iconic, true,
      !(current.cloaked || (current.late_cloak && background_reads > 1)),
      !current.other_desktop, !current.other_virtual_desktop};
}
bool ComponentBackgroundDialogs(const WindowsSession& session, WindowsDialogSetSnapshot* output, std::string* reason) {
  if (current.background_dialog) { *reason = "native_dialog_user_takeover"; return false; }
  output->digest = "synthetic-dialog-set"; output->active_window = session.window;
  output->active_identity = session.window_identity; output->active_kind = "application";
  return true;
}
bool ComponentElevated(std::uint32_t) { return current.elevated; }
BOOL ComponentWindow(HWND) { return TRUE; }
bool ComponentStartTime(HANDLE process, std::string* output) {
  ++identity_reads;
  if (current.stop_identity && identity_reads == 2) WindowsTargetListControl().stop_serial.fetch_add(1);
  if (current.identity_read_failure) { SetLastError(ERROR_ACCESS_DENIED); return false; }
  return ReadProcessStartIdentity(process, output);
}
DWORD ComponentWindowOwner(HWND, LPDWORD pid) {
  *pid = current.window_replaced || (current.late_window && identity_reads >= 3)
      ? GetCurrentProcessId() + 1 : GetCurrentProcessId();
  return 1;
}
bool ComponentApplicationWindow(HWND) { return true; }
bool ComponentClientBounds(HWND, RECT* output) {
  *output = {current.bad_before_geometry ? 5 : 0, 0, 100, 80}; return true;
}
bool ComponentTargetFacts(std::uint32_t, HWND, RECT* output) {
  *output = {current.changed_after_geometry ? 5 : 0, 0, 100, 80}; return !current.focus_failure;
}
bool ComponentScreenBounds(HWND, RECT* output) { *output = {0, 0, 800, 600}; return true; }
HWND ComponentForeground() { return reinterpret_cast<HWND>(static_cast<UINT_PTR>(current.bound_start ? 2 : 1)); }
BOOL ComponentEnabled(HWND) { return TRUE; }
bool ComponentTakeover(HWND) { return false; }
BOOL ComponentIconic(HWND) { return current.iconic ? TRUE : FALSE; }
BOOL ComponentShow(HWND, int) {
  input_calls.fetch_add(1);
  if (current.stop_after_restore) WindowsTargetListControl().stop_serial.fetch_add(1);
  return TRUE;
}
BOOL ComponentFocus(HWND) {
  input_calls.fetch_add(1);
  if (current.stop_after_focus) WindowsTargetListControl().stop_serial.fetch_add(1);
  return TRUE;
}
HRESULT ComponentCoInitialize(LPVOID reserved, DWORD flags) {
  com_calls.fetch_add(1); return current.com_failure ? E_FAIL : ::CoInitializeEx(reserved, flags);
}
void ComponentCoUninitialize() { com_releases.fetch_add(1); ::CoUninitialize(); }
void ComponentBeforeMeasurement() { if (current.measurement_failure) throw std::runtime_error("measurement failure"); }
void ComponentBeforeAdopt() {
  if (current.allocation_failure) throw std::bad_alloc();
  if (current.adopt_epoch) {
    std::lock_guard lock(WindowsTargetListControl().stop_mutex);
    cancellation_epoch.store(*current.adopt_epoch); last_closed_cancel_epoch = *current.adopt_epoch;
  }
}
void CheckStartContract() {
  using sprint_coder::computer_use::WindowsBackgroundStartFacts;
  using sprint_coder::computer_use::WindowsBackgroundStartFactsAdmit;
  const WindowsBackgroundStartFacts admitted{true, true, true, true, true, true};
  Check(WindowsBackgroundStartFactsAdmit(admitted), "all background evidence present");
  for (const auto field : {&WindowsBackgroundStartFacts::visible,
      &WindowsBackgroundStartFacts::not_minimized, &WindowsBackgroundStartFacts::enabled,
      &WindowsBackgroundStartFacts::not_cloaked, &WindowsBackgroundStartFacts::input_desktop,
      &WindowsBackgroundStartFacts::current_virtual_desktop}) {
    auto facts = admitted;
    facts.*field = false;
    Check(!WindowsBackgroundStartFactsAdmit(facts), "negative background evidence refused");
    (facts.*field).reset();
    Check(!WindowsBackgroundStartFactsAdmit(facts), "missing background evidence refused");
  }
  std::string start;
  Check(ReadWindowsStartIdentity("{}", &start) && start.empty(), "legacy start has no new identity");
  for (const auto value : {"1", "18446744073709551615"}) {
    Check(ReadWindowsStartIdentity("{\"requireStartIdentity\":true,\"expectedProcessStartTime\":\"" +
        std::string(value) + "\"}", &start) && start == value, "decimal string preserved");
  }
  for (const auto value : {"", "0", "01", "-1", "1.5", "1e2", "18446744073709551616"}) {
    Check(!ReadWindowsStartIdentity("{\"requireStartIdentity\":true,\"expectedProcessStartTime\":\"" +
        std::string(value) + "\"}", &start), "invalid identity refused");
  }
  for (const auto metadata : {
      "{\"requireStartIdentity\":true}",
      "{\"expectedProcessStartTime\":\"1\"}",
      "{\"requireStartIdentity\":false,\"expectedProcessStartTime\":\"1\"}",
      "{\"requireStartIdentity\":true,\"expectedProcessStartTime\":1}",
      "{\"requireStartIdentity\":true,\"expectedProcessStartTime\":\"1\"x}",
      "{\"requireStartIdentity\":true,\"expectedProcessStartTime\"::\"1\"}",
      "{\"requireStartIdentity\":true,\"expectedProcessStartTime\":\"1\",\"expectedProcessStartTime\":\"2\"}",
      "{\"requireStartIdentity\":true,\"requireStartIdentity\":false,\"expectedProcessStartTime\":\"1\"}"}) {
    Check(!ReadWindowsStartIdentity(metadata, &start), "missing or ambiguous expected identity refused");
  }
  WindowsStartResult result;
  Check(AppendWindowsStartResult("{}", result, false) == "{}", "legacy response unchanged");
  result.pid = 7; result.process_start = "18446744073709551615";
  Check(AppendWindowsStartResult("{}", result, false).find("\"foregroundResult\":\"not_attempted\"") !=
      std::string::npos, "verified no attempt");
  result.execution_unknown = true;
  Check(AppendWindowsStartResult(ErrorPayload("request_id_reuse"), result, false).find(
      "\"foregroundResult\":\"unconfirmed\"") != std::string::npos, "admission conflict is not zero-effect proof");
  result.execution_unknown = false;
  result.attempt_count = 2;
  Check(AppendWindowsStartResult(ErrorPayload("focus_required"), result, false).find(
      "\"foregroundResult\":\"unconfirmed\"") != std::string::npos, "failure retains uncertain effect");
  Check(AppendWindowsStartResult("{}", result, true).find("\"foregroundResult\":\"confirmed\"") !=
      std::string::npos, "successful result");
  const std::string query = "{\"operation\":\"list_windows_cancellable\",\"discoveryId\":\"synthetic\","
      "\"canonicalPath\":\"C:\\\\synthetic.exe\",\"identityDigest\":\"" + std::string(64, 'a') +
      "\",\"executableDigest\":\"" + std::string(64, 'b') + "\",\"signerDigest\":\"\"";
  WindowsDiscoveryParameters parsed;
  Check(ReadWindowsDiscoveryQuery(query + "}", &parsed) && !parsed.include_start_identity, "legacy discovery");
  Check(ReadWindowsDiscoveryQuery(query + ",\"includeStartIdentity\":true}", &parsed) &&
      parsed.include_start_identity, "identity discovery opt-in");
  Check(ReadWindowsDiscoveryQuery(query + ",\"includeStartIdentity\":false}", &parsed) &&
      !parsed.include_start_identity, "explicit legacy discovery");
  for (const auto suffix : {",\"includeStartIdentity\":\"true\"}", ",\"includeStartIdentity\":truex}",
      ",\"includeStartIdentity\":true,\"includeStartIdentity\":false}", ",\"unexpected\":true}"}) {
    Check(!ReadWindowsDiscoveryQuery(query + suffix, &parsed), "strict discovery opt-in");
  }
  // Serialization only: the synthetic facts are not evidence of target eligibility.
  using namespace sprint_coder::computer_use;
  WindowsV2Judgement judged;
  judged.app_identity = std::string(64, 'a');
  judged.process_start = "18446744073709551615";
  judged.executable.identity.path_utf8 = "C:\\synthetic.exe";
  WindowsV2RowWindow window;
  window.pid = 7; window.handle = 9; window.title = "Synthetic";
  TargetFacts facts; facts.platform = TargetPlatform::kWin32;
  const TargetVerdict verdict{TargetVerdictKind::kEligible, "observe_only"};
  const auto legacy = WindowsV2SelectableRow(judged, verdict, facts, window);
  const auto bound = WindowsV2SelectableRow(judged, verdict, facts, window, true);
  Check(legacy.find("processStartTime") == std::string::npos, "legacy discovery identity not exposed");
  Check(ReadJsonString(bound, "processStartTime", &start) && start == judged.process_start,
      "opt-in discovery decimal preserved");
  std::string digest;
  Check(ReadJsonString(bound, "windowIdentityDigest", &digest) && digest ==
      Sha256String("computer-window-identity-v1\n" + judged.app_identity + "\n" + start + "\n9"),
      "discovery creation time bound to selected window");
  judged.executable.identity.path_utf8.clear();
  Check(WindowsV2SelectableRow(judged, verdict, facts, window, true) == "{\"kind\":\"unresolvable\"}",
      "refused discovery never reveals identity");
}
void Run(const char* name, Case config, bool expected, const char* reason, unsigned ticket_calls) {
  identity_reads = 0; background_reads = 0;
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
  if (config.bound_start) input.expected_process_start = config.bad_start ? "1" : created;
  input.expected_window_identity = config.bad_window_identity ? std::string(64, 'f') :
      Sha256String("computer-window-identity-v1\n" + input.app_identity + "\n" + created + "\n1");
  ticket_states[input.session_key].generation = 10;
  if (config.occupied) sessions.try_emplace("synthetic-active-session");
  cancel_calls = 0;
  if (config.latch_during_read) {
    std::string admission_reason;
    input.start_lease = AdmitWindowsStart(input.session_key, input.session_id,
        "synthetic-request", std::string(64, 'a'), &admission_reason);
    Check(input.start_lease && ClaimWindowsStartInput(input.start_lease), "start admission");
  }
  std::string response, failure; bool succeeded = false;
  try { succeeded = StartWindowsNewSession(input, &response, &failure); }
  catch (const std::bad_alloc&) { Check(config.allocation_failure, "unexpected allocation error"); failure = "allocation_failure"; }
  if (config.latch_during_read) {
    std::lock_guard lock(WindowsTargetListControl().stop_mutex);
    Check(WindowsTargetListControl().new_start_thread == nullptr, "measurement unregisters before return");
    CancelWindowsNewStartMeasurementLocked(WindowsTargetListControl());
    Check(cancel_calls == 1, "later Stop cannot cancel unrelated consumer I/O");
  }
  Check(!WindowsTargetListWorkerRunning().load(), "synchronous measurement releases slot");
  Check(succeeded == expected, name);
  if (!expected) Check(failure == reason, "expected refusal reason");
  Check(ticket_states[input.session_key].generation == 10 + ticket_calls, "ticket invalidation count");
  Check(input_calls.load() == config.expected_focus_calls, "controlled focus calls match expectation");
  if (config.bound_start) {
    Check(input_calls.load() == config.expected_focus_calls, "bound start focus count");
    Check(input.start_result->attempt_count == input_calls.load(), "per-request count survives failure");
    input.start_result->pid = input.pid; input.start_result->process_start = input.expected_process_start;
    const auto result = AppendWindowsStartResult(succeeded ? response : ErrorPayload(failure), *input.start_result, succeeded);
    std::string outcome;
    Check(ReadJsonString(result, "foregroundResult", &outcome) && outcome ==
        (input_calls.load() == 0 ? "not_attempted" : succeeded ? "confirmed" : "unconfirmed"), "foreground result");
  }
  if (!config.v2) Check(contexts.load() == 0 && com_calls.load() == 0 && !WindowsV2FactsContextCache(), "V1 has no V2 context or COM prerequisite");
  Check(com_calls.load() == com_releases.load() + (config.v2 && config.com_failure ? 1u : 0u), "COM balance");
  if (expected) {
    Check(sessions.size() == 1, "single adopted session");
    const auto& session = sessions.at(input.session_key);
    const bool background = config.background_gate && config.bound_start && config.background_supported;
    std::uint64_t interaction_epoch = 0;
    Check(ReadJsonUint64(response, "interactionEpoch", &interaction_epoch) == background,
          "interaction epoch only for background");
    if (background) Check(session.background_monitor && interaction_epoch ==
        session.background_monitor->state.Snapshot().epoch && interaction_epoch > 0,
        "receipt carries monitor epoch");
    Check((session.input_session.kind == sprint_coder::computer_use::InputSessionKind::kBackground) == background,
          "native session kind");
    Check((response.find("\"inputSession\":") != std::string::npos) == config.background_gate,
          "legacy wire unchanged");
    const auto epoch = std::max(config.input_epoch, config.adopt_epoch.value_or(config.global_epoch));
    Check(session.eligibility_basis == input.eligibility_basis && session.cancel_epoch == epoch && cancellation_epoch.load() == epoch, "basis and epoch");
    Check(session.maximum_mode == (config.v2 ? "observe_only" : "full_access_app") && session.policy_language == "en", "mode and language");
    if (config.store_notepad) {
      Check(session.not_web_file.has_value(), "Store start records not_web_file");
      const auto recorded = session.not_web_file;
      std::string rejudge_reason;
      Check(JudgeWindowsV2Input(session, &rejudge_reason), "Store first rejudge matches session");
      Check(session.v2_input_not_web == std::optional<bool>(true), "Store first rejudge is not-web");
      current.changed_store_key = true;
      Check(JudgeWindowsV2Input(session, &rejudge_reason), "Store key-only rejudge completes");
      Check(session.v2_input_not_web == std::optional<bool>(false), "Store changed key is not not-web");
      Check(session.not_web_file == recorded, "Store rejudge cannot replace recorded start key");
    } else Check(!session.not_web_file, "no invented not-web key");
    std::string process_start;
    Check(ReadJsonString(response, "processStartTime", &process_start) && process_start == created &&
          process_start == session.process_start, "bound process creation time");
    std::uint64_t reply_epoch = 0, count = 1;
    Check(ReadJsonUint64(response, "cancelEpoch", &reply_epoch) && reply_epoch == epoch &&
          ReadJsonUint64(response, "inputAttemptCount", &count) && count == config.expected_focus_calls, "bound receipt fields");
    WindowsFileIdentity actual;
    Check(ReadWindowsFileIdentity(session.executable_file, &actual) && actual.volume_serial == session.executable_volume_serial &&
          std::memcmp(actual.file_id.Identifier, session.executable_file_id.Identifier, sizeof(actual.file_id.Identifier)) == 0, "real held FileId handoff");
  } else Check(sessions.size() == (config.occupied ? 1u : 0u), "refusal cannot adopt");
  if (config.occupied) Check(reads == 0 && com_calls == 0, "occupied session refuses before measurement");
  for (auto& entry : sessions) ReleaseWindowsSessionResources(&entry.second);
  sessions.clear(); ticket_states.clear();
  { std::lock_guard lock(handles_mutex); Check(tracked_handles.empty(), "all tracked handles released once"); }
  ++case_count; std::cout << "CASE:" << name << "\n";
}
}
int wmain() {
  try {
    Check(SUCCEEDED(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED)), "production consumer STA");
    consumer_thread = GetCurrentThreadId();
    CheckStartContract();
    std::vector<wchar_t> system(32768); const auto length = GetSystemDirectoryW(system.data(), static_cast<UINT>(system.size()));
    Check(length != 0 && length < system.size(), "system directory"); canonical.assign(system.data(), length); canonical += L"\\notepad.exe";
    Run("v1-normal", {}, true, "", 2);
    Case stopped; stopped.latch_during_read = true;
    Run("v1-latched-stop-during-measurement", stopped, false, "session_start_canceled", 0);
    stopped.v2 = true;
    Run("v2-latched-stop-during-measurement", stopped, false, "session_start_canceled", 0);
    Case occupied; occupied.occupied = true;
    Run("v1-occupied-before-measurement", occupied, false, "session_limit", 0);
    occupied.v2 = true;
    Run("v2-occupied-before-measurement", occupied, false, "session_limit", 0);
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
    c = {}; c.measurement_failure = true; Run("v1-measurement-exception", c, false, "session_target_rejected", 0);
    c = {}; c.allocation_failure = true; Run("v1-allocation-failure", c, false, "allocation_failure", 1);
    c = {}; c.com_failure = true; Run("v1-no-com-dependency", c, true, "", 2);
    c = {}; c.v2 = true; Run("v2-normal", c, true, "", 1);
    c.supervised_ceiling = true; Run("v2-approval-ceiling-closed", c, true, "", 1);
    c.supervised_ceiling = false;
    c.changed_after_geometry = true; Run("v2-after-geometry", c, false, "window_geometry_changed", 1);
    c = {}; c.v2 = true; c.resume = true; c.bad_before_geometry = true; Run("v2-resume-before-geometry", c, false, "session_input_invalid", 1);
    c = {}; c.v2 = true; c.adopt_epoch = 7; Run("v2-initial-epoch-cas", c, false, "session_start_canceled", 1);
    for (const bool v2 : {false, true}) {
      const unsigned tickets = v2 ? 1 : 2;
      c = {}; c.v2 = v2; c.bound_start = true; c.expected_focus_calls = 1;
      Run(v2 ? "v2-bound" : "v1-bound", c, true, "", tickets);
      c.bad_start = true; c.expected_focus_calls = 0; Run("bound-pid-reuse", c, false, "session_identity_changed", 1);
      c.bad_start = false; c.identity_read_failure = true; Run("bound-access-denied", c, false, "session_identity_changed", 1);
      c.identity_read_failure = false; c.window_replaced = true; Run("bound-window-replaced", c, false, "session_identity_changed", 1);
      c.window_replaced = false; c.stop_identity = true; Run("bound-stop-at-focus", c, false, "session_start_canceled", 1);
      c.stop_identity = false; c.iconic = true; c.late_window = true; c.expected_focus_calls = 1;
      Run("bound-change-after-restore", c, false, "session_identity_changed", 1);
      c.iconic = false; c.late_window = false; c.focus_failure = true;
      Run("bound-failure-after-focus", c, false, "focus_required", 1);
      c.focus_failure = false; c.iconic = true; c.stop_after_restore = true;
      Run("bound-stop-after-restore-no-next-input", c, false, "session_start_canceled", 1);
      c.iconic = false; c.stop_after_restore = false; c.stop_after_focus = true;
      Run("bound-stop-after-focus-no-adoption", c, false, "session_start_canceled", 1);
    }
    c = {}; c.v2 = true; c.background_gate = true;
    Run("BG08-already-foreground", c, true, "", 1);
    c.bound_start = true;
    Run("BG08-all-new-starts-never-autofocus", c, false, "focus_required", 1);
    c.background_supported = true;
    Run("BG-background-start", c, true, "", 1);
    c.cloaked = true; Run("BG-cloaked", c, false, "session_target_rejected", 1); c.cloaked = false;
    c.other_desktop = true; Run("BG-other-desktop", c, false, "session_target_rejected", 1); c.other_desktop = false;
    c.other_virtual_desktop = true; Run("BG-other-virtual-desktop", c, false, "session_target_rejected", 1); c.other_virtual_desktop = false;
    c.unreadable = true; Run("BG-unreadable", c, false, "session_target_rejected", 1); c.unreadable = false;
    c.hidden = true; Run("BG-hidden", c, false, "session_target_rejected", 1); c.hidden = false;
    c.iconic = true; Run("BG-no-restore", c, false, "session_target_rejected", 1); c.iconic = false;
    c.background_dialog = true; Run("BG-dialog", c, false, "native_dialog_user_takeover", 1); c.background_dialog = false;
    c.late_cloak = true; Run("BG-late-cloak", c, false, "session_target_rejected", 1); c.late_cloak = false;
    c.background_gate = false; c.expected_focus_calls = 1;
    Run("BG08-closed-gate-legacy-focus", c, true, "", 1);
    c = {}; c.background_gate = true; c.bound_start = true;
    Run("BG08-v1-new-start-never-autofocus", c, false, "focus_required", 1);
    c.background_supported = true;
    Run("BG-v1-background-start", c, true, "", 2);
    c = {}; c.v2 = true; c.store_notepad = true;
    Run("store-notepad-start-rejudge-changed-key", c, true, "", 1);
    CoUninitialize();
    std::cout << "PASS: " << case_count << " component cases, controlled focus only, no OS input\n"; return 0;
  } catch (const std::exception& error) { std::cerr << "FAIL: " << error.what() << "\n"; return 1; }
}
