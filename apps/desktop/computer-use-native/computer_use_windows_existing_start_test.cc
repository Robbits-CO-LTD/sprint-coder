// Component-only matrix for the production shared existing-start engine. Identity measurements and
// window facts are controlled inputs; this is not signed-package, grant or real-input acceptance.
#include <windows.h>
#include <atomic>
#include <string>
namespace {
struct LockedWindowsExecutable;
struct WindowsSession;
struct WindowsDialogSetSnapshot;
struct WindowsStartInput;
struct WindowsFileIdentity;
struct WindowsExistingStartMeasurement;
struct WindowsTargetFactsContext;
HANDLE ComponentOpenProcess(DWORD access, BOOL inherit, DWORD pid);
bool ComponentOpenExecutable(HANDLE process, LockedWindowsExecutable* output);
BOOL ComponentCloseHandle(HANDLE handle);
BOOL ComponentDuplicateHandle(HANDLE source_process, HANDLE source, HANDLE target_process,
                              LPHANDLE target, DWORD access, BOOL inherit, DWORD options);
WindowsTargetFactsContext ComponentContext(std::uint32_t pid);
bool ComponentAdmit(const WindowsStartInput&, WindowsExistingStartMeasurement*);
bool ComponentElevated(std::uint32_t);
BOOL ComponentWindow(HWND);
bool ComponentApplicationWindow(HWND);
bool ComponentClientBounds(HWND, RECT*);
bool ComponentTargetFacts(std::uint32_t, HWND, RECT*);
bool ComponentScreenBounds(HWND, RECT*);
HWND ComponentForeground();
BOOL ComponentEnabled(HWND);
bool ComponentResolve(WindowsSession*, HWND*, std::string*);
bool ComponentRefocus(const WindowsSession&, HWND*, std::string*);
bool ComponentDialogs(const WindowsSession&, WindowsDialogSetSnapshot*, std::string*);
BOOL ComponentIconic(HWND);
BOOL ComponentShow(HWND, int);
BOOL ComponentFocus(HWND);
HRESULT ComponentCoInitialize(LPVOID, DWORD);
void ComponentCoUninitialize();
void ComponentBeforeThread();
void ComponentBeforeTicket();
bool ComponentReadHeld(HANDLE, WindowsFileIdentity*);
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
  bool thread_failure = false, after_thread_failure = false, com_failure = false;
  bool source_missing_process = false, source_missing_file = false, source_bad_digest = false;
  bool duplicate_failure = false, publication_stop = false, after_stop = false, after_read_failure = false;
  bool move_focus = false, dialog_failure = false, resolver_failure = false;
  bool hold_before_file = false, hold_after_file = false;
  std::uint64_t global_epoch = 0, closed_epoch = 0, input_epoch = 0;
  std::uint64_t session_epoch = 0;
};
Case current;
std::wstring canonical;
std::atomic<unsigned> workers{0}, reads{0}, contexts{0}, com_calls{0}, com_releases{0}, input_calls{0};
std::mutex handles_mutex;
std::set<HANDLE> tracked_handles;
unsigned case_count = 0;
HANDLE source_process = nullptr, source_file = INVALID_HANDLE_VALUE;
std::atomic<unsigned> held_reads{0}, thread_attempts{0}, resumes{0}, refocuses{0};
bool focused = false;
std::atomic<bool> held_entered{false}, release_held{false};
std::atomic<unsigned> released_reads{0};
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
  if (current.duplicate_failure && source == source_file) return FALSE;
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
bool ComponentAdmit(const WindowsStartInput&, WindowsExistingStartMeasurement* measured) {
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
HWND ComponentForeground() { return reinterpret_cast<HWND>(static_cast<UINT_PTR>(current.move_focus && !focused ? 2 : 1)); }
BOOL ComponentEnabled(HWND) { return TRUE; }
bool ComponentResolve(WindowsSession*, HWND* output, std::string* reason) {
  resumes.fetch_add(1);*output=reinterpret_cast<HWND>(static_cast<UINT_PTR>(1));
  if(current.resolver_failure){*reason="native_dialog_user_takeover";return false;}return true;
}
bool ComponentRefocus(const WindowsSession&, HWND* output, std::string* reason) {
  refocuses.fetch_add(1);*output=reinterpret_cast<HWND>(static_cast<UINT_PTR>(1));
  if(current.resolver_failure){*reason="native_dialog_user_takeover";return false;}return true;
}
bool ComponentDialogs(const WindowsSession& session, WindowsDialogSetSnapshot* output, std::string* reason) {
  if(current.dialog_failure){*reason="native_dialog_user_takeover";return false;}
  output->digest=session.dialog_set_digest;output->active_window=session.active_window;
  output->active_identity=session.active_window_identity;output->active_kind=session.active_window_kind;return true;
}
BOOL ComponentIconic(HWND) { return FALSE; }
BOOL ComponentShow(HWND, int) { input_calls.fetch_add(1); return TRUE; }
BOOL ComponentFocus(HWND) { input_calls.fetch_add(1); focused=true; return TRUE; }
HRESULT ComponentCoInitialize(LPVOID reserved, DWORD flags) {
  com_calls.fetch_add(1); return current.com_failure ? E_FAIL : ::CoInitializeEx(reserved, flags);
}
void ComponentCoUninitialize() { com_releases.fetch_add(1); ::CoUninitialize(); }
void ComponentBeforeThread() {
  const auto phase=thread_attempts.fetch_add(1);
  if ((phase==0&&current.thread_failure)||(phase==1&&current.after_thread_failure)) throw std::runtime_error("thread failure");
}
void ComponentBeforeTicket() { if(current.publication_stop) WindowsTargetListControl().stop_serial.fetch_add(1); }
bool ComponentReadHeld(HANDLE handle, WindowsFileIdentity* output) {
  const auto phase=held_reads.fetch_add(1);
  if(phase==1&&current.after_stop)WindowsTargetListControl().stop_serial.fetch_add(1);
  if(phase==1&&current.after_read_failure)return false;
  const bool hold=(phase==0&&current.hold_before_file)||(phase==1&&current.hold_after_file);
  if(hold){held_entered.store(true);while(!release_held.load())Sleep(1);}
  const bool read=ReadWindowsFileIdentity(handle,output);
  if(hold&&read)released_reads.fetch_add(1);
  return read;
}
ComponentWorkerLifetime::ComponentWorkerLifetime() { workers.fetch_add(1); }
ComponentWorkerLifetime::~ComponentWorkerLifetime() { workers.fetch_sub(1); }
void WaitWorkers() {
  const auto until = GetTickCount64() + 5000;
  while ((workers.load() != 0 || WindowsTargetListWorkerRunning().load()) && GetTickCount64() < until) Sleep(1);
  Check(workers.load() == 0 && !WindowsTargetListWorkerRunning().load(), "worker retirement");
}
void Run(const char* name, Case config, bool expected, const char* reason, unsigned ticket_calls) {
  current=config;reads=0;contexts=0;com_calls=0;com_releases=0;input_calls=0;
  held_reads=0;thread_attempts=0;resumes=0;refocuses=0;focused=false;
  held_entered=false;release_held=false;released_reads=0;
  parent_process_dead=false;cancellation_epoch=config.global_epoch;last_closed_cancel_epoch=config.closed_epoch;
  WindowsTargetListControl().stop_serial=0;WindowsTargetListControl().context_candidate.reset();WindowsV2FactsContextCache().reset();
  windows_v2_main_pid=config.v2?GetCurrentProcessId():0;windows_v2_list_generation=1;
  WindowsStartInput input;input.eligibility_basis=config.v2?Basis::kV2Denylist:Basis::kV1Allowlist;
  input.pid=GetCurrentProcessId();input.window=reinterpret_cast<HWND>(static_cast<UINT_PTR>(1));input.window_value=1;
  input.session_key=std::string(16,static_cast<char>('A'+case_count));input.session_id=name;
  input.app_identity=std::string(64,'a');input.executable_digest=std::string(64,'b');input.signer_digest=std::string(64,'c');
  input.canonical_path=canonical;input.bounds_width=100;input.bounds_height=80;input.explicit_resume=config.resume;
  input.cancel_epoch=config.input_epoch;input.profile_revision=4;input.ruleset_version=1;
  std::string created;Check(ReadProcessStartIdentity(GetCurrentProcess(),&created),"own creation time");
  const auto identity=Sha256String("computer-window-identity-v1\n"+input.app_identity+"\n"+created+"\n1");
  input.expected_window_identity=config.bad_window_identity?std::string(64,'f'):identity;
  ScopedKernelHandle process(::OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE,FALSE,GetCurrentProcessId()));
  LockedWindowsExecutable executable;Check(process.value&&OpenLockedProcessExecutable(process.value,&executable),"own source handles");
  Track(process.value);Track(executable.file);source_process=process.value;source_file=executable.file;
  WindowsSession session;session.session_id=name;session.pid=input.pid;session.window=input.window;session.active_window=input.window;
  session.app_identity=input.app_identity;session.window_identity=identity;session.active_window_identity=identity;session.process_start=created;
  session.canonical_path=canonical;session.executable_volume_serial=executable.identity.file_identity.volume_serial;session.executable_file_id=executable.identity.file_identity.file_id;
  session.executable_digest=config.source_bad_digest?std::string(64,'f'):input.executable_digest;session.signer_digest=input.signer_digest;session.policy_language="en";
  session.maximum_mode=config.v2?"observe_only":"full_access_app";session.eligibility_basis=input.eligibility_basis;session.cancel_epoch=config.session_epoch;
  session.process_handle=process.release();session.executable_file=executable.file;executable.file=INVALID_HANDLE_VALUE;
  if(config.source_missing_process){ComponentCloseHandle(session.process_handle);session.process_handle=nullptr;}
  if(config.source_missing_file){ComponentCloseHandle(session.executable_file);session.executable_file=INVALID_HANDLE_VALUE;}
  sessions.emplace(input.session_key,std::move(session));ticket_states[input.session_key].generation=10;
  const bool held_case=config.hold_before_file||config.hold_after_file;
  std::jthread stop_reader;
  if(held_case)stop_reader=std::jthread([]{
    const auto until=GetTickCount64()+5000;
    while(!held_entered.load()&&GetTickCount64()<until)Sleep(1);
    if(!held_entered.load()){release_held=true;parent_process_dead=true;return;}
    WindowsTargetListControl().stop_serial.fetch_add(1);
  });
  std::string response,failure;const bool succeeded=StartWindowsExistingSession(input,&response,&failure);
  if(held_case)Check(held_entered.load()&&!release_held.load()&&WindowsTargetListWorkerRunning().load(),"caller returns before held read and retains slot");
  else WaitWorkers();
  Check(succeeded==expected,name);if(!expected)Check(failure==reason,"refusal reason");
  Check(ticket_states[input.session_key].generation==10+ticket_calls,"ticket count");
  Check(sessions.size()==1,"existing lifetime remains until explicit close");
  const auto& remaining=sessions.at(input.session_key);
  Check(remaining.eligibility_basis==input.eligibility_basis&&remaining.cancel_epoch==config.session_epoch,"basis and session epoch retained");
  Check(remaining.input_api_attempts->load()==input_calls.load(),"all attempted focus units counted");
  if(!config.v2)Check(contexts.load()==0&&com_calls.load()==0&&!WindowsV2FactsContextCache(),"V1 context and COM independence");
  Check(com_calls.load()==com_releases.load()+(config.v2&&config.com_failure?1u:0u),"COM balance");
  if(expected){
    std::uint64_t epoch=99;Check(ReadJsonUint64(response,"cancelEpoch",&epoch)&&epoch==config.session_epoch,"receipt epoch");
    Check(config.resume?resumes.load()==1:refocuses.load()==1,"correct resolver");
  }
  if(config.after_stop||config.hold_after_file)Check(input_calls.load()==1,"pre-stop focus count retained");
  sprint_coder::computer_use::Frame frame;frame.header.session_id.bytes.fill(static_cast<unsigned char>('A'+case_count));
  std::string receipt;const auto terminal_epoch=std::max(config.global_epoch,config.session_epoch)+1;
  Check(CloseWindowsSession(frame,"{\"cancelEpoch\":"+std::to_string(terminal_epoch)+"}",&receipt),"component terminal close");
  std::uint64_t count=99;Check(ReadJsonUint64(receipt,"inputAttemptCount",&count)&&count==input_calls.load(),"terminal receipt preserves prior focus count");
  if(held_case){
    Check(!release_held.load()&&WindowsTargetListWorkerRunning().load(),"Close completes while duplicate read remains held");
    release_held=true;stop_reader.join();WaitWorkers();
    Check(released_reads.load()==1&&sessions.empty(),"real held read survives original close without late adoption");
  }
  ticket_states.clear();{std::lock_guard lock(handles_mutex);Check(tracked_handles.empty(),"all owned handles closed");}
  ++case_count;std::cout<<"CASE:"<<name<<"\n";
}
}
int wmain() {
  try {
    std::vector<wchar_t> system(32768); const auto length = GetSystemDirectoryW(system.data(), static_cast<UINT>(system.size()));
    Check(length != 0 && length < system.size(), "system directory"); canonical.assign(system.data(), length); canonical += L"\\notepad.exe";
    Run("v1-normal",{},true,"",2);
    Case c;c.resume=true;Run("v1-explicit-resume",c,true,"",2);
    c={};c.bad_path=true;Run("v1-path",c,false,"session_target_rejected",0);
    c={};c.bad_signer=true;Run("v1-signer",c,false,"session_target_rejected",0);
    c={};c.unknown_language=true;Run("v1-language",c,false,"session_target_rejected",0);
    c={};c.bad_window_identity=true;Run("v1-window",c,false,"window_identity_changed",0);
    c={};c.source_bad_digest=true;Run("v1-source-binding",c,false,"session_refocus_stale",1);
    c={};c.source_missing_process=true;Run("v1-missing-process",c,false,"session_refocus_stale",1);
    c={};c.source_missing_file=true;Run("v1-missing-file",c,false,"session_refocus_stale",1);
    c={};c.duplicate_failure=true;Run("v1-partial-dup",c,false,"session_refocus_stale",1);
    c.bad_digest=true;Run("v1-candidate-before-dup",c,false,"session_target_rejected",0);
    c={};c.global_epoch=7;c.session_epoch=7;Run("v1-stale-request",c,false,"session_start_canceled",1);
    c={};c.input_epoch=7;Run("v1-future-request",c,false,"session_start_canceled",1);
    c.bad_before_geometry=true;Run("v1-geometry-before-epoch",c,false,"window_geometry_changed",1);
    c={};c.resolver_failure=true;Run("v1-resolver",c,false,"native_dialog_user_takeover",1);
    c={};c.dialog_failure=true;Run("v1-dialog",c,false,"native_dialog_user_takeover",1);
    c={};c.stop_during_read=true;Run("v1-stop-before",c,false,"session_start_canceled",0);
    c={};c.parent_during_read=true;Run("v1-parent-before",c,false,"session_start_canceled",0);
    c={};c.publication_stop=true;Run("v1-late-identity-bool",c,false,"session_start_canceled",0);
    c={};c.thread_failure=true;Run("v1-before-thread-failure",c,false,"session_target_rejected",0);
    c={};c.after_thread_failure=true;Run("v1-after-thread-failure",c,false,"session_refocus_stale",1);
    c={};c.after_read_failure=true;Run("v1-after-read-failure",c,false,"session_refocus_stale",1);
    c={};c.move_focus=true;c.after_stop=true;Run("v1-after-stop-counter",c,false,"session_start_canceled",1);
    c={};c.com_failure=true;Run("v1-no-com",c,true,"",2);
    c={};c.hold_before_file=true;Run("v1-held-before-file",c,false,"session_start_canceled",0);
    c={};c.hold_after_file=true;c.move_focus=true;Run("v1-held-after-file-counter",c,false,"session_start_canceled",1);
    c={};c.v2=true;Run("v2-normal",c,true,"",2);
    c.input_epoch=7;Run("v2-epoch-entry",c,false,"session_start_canceled",1);
    c={};c.v2=true;c.duplicate_failure=true;Run("v2-dup-entry",c,false,"session_target_rejected",1);
    c={};c.v2=true;c.move_focus=true;c.after_stop=true;Run("v2-after-stop-counter",c,false,"session_start_canceled",1);
    std::cout << "PASS: " << case_count << " component cases, controlled focus only, no OS input\n"; return 0;
  } catch (const std::exception& error) { std::cerr << "FAIL: " << error.what() << "\n"; return 1; }
}
