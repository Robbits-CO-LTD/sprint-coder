// Component integration: qualification and enumeration are controlled for this owned executable.
// Child creation, image reads, process exit and pipe receipts are real; no public grant is claimed.
#include <windows.h>
#include <atomic>
#include <functional>
#include <string>
#include <string_view>
#include <vector>
namespace {
struct WindowsExecutableIdentity;
struct LockedWindowsExecutable;
bool FixtureSupported(const WindowsExecutableIdentity&);
bool FixtureEnumerate(const std::wstring&, std::string_view, std::string_view, std::string_view,
                      std::vector<std::string>*, const std::function<bool()>&);
void FixtureBeforeClaim();
BOOL FixtureCreate(LPCWSTR, LPWSTR, LPSECURITY_ATTRIBUTES, LPSECURITY_ATTRIBUTES, BOOL, DWORD,
                   LPVOID, LPCWSTR, LPSTARTUPINFOW, LPPROCESS_INFORMATION);
bool FixtureImage(HANDLE, LockedWindowsExecutable*);
BOOL FixtureTerminate(HANDLE, UINT);
void FixtureWorkerStarted();
bool FixtureRetainLaunchOnExit();
BOOL RefuseShow(HWND, int);
BOOL RefuseFocus(HWND);
UINT RefuseInput(UINT, LPINPUT, int);
}
#define wmain ProductionHostMain
#include "launch-host.cc"
#undef wmain
#include <iostream>
#include <stdexcept>

namespace {
using namespace sprint_coder::computer_use;
std::string mode;
std::wstring owned_path;
ScopedKernelHandle job, gate_entered, gate_release;
struct ExitState { volatile LONG child_pid = 0, reads = 0, terminations = 0; };
ExitState* exit_state = nullptr;
std::atomic<HANDLE> child_observer{nullptr}, worker_observer{nullptr};
std::atomic<unsigned> create_entries{0}, created_children{0}, image_reads{0}, termination_calls{0};
void Check(bool ok, const char* message) { if (!ok) throw std::runtime_error(message); }
void Gate() {
  SetEvent(gate_entered.value);
  Check(WaitForSingleObject(gate_release.value, 15000) == WAIT_OBJECT_0, "gate release");
}
bool FixtureSupported(const WindowsExecutableIdentity& identity) {
  Check(SameWindowsPath(identity.path, owned_path), "qualification seam is owned-only");
  return true;
}
bool FixtureEnumerate(const std::wstring& path, std::string_view, std::string_view,
                      std::string_view, std::vector<std::string>* rows,
                      const std::function<bool()>& current) {
  Check(SameWindowsPath(path, owned_path), "enumeration seam is owned-only");
  if (!current()) return false;
  if (created_children.load() != 0) rows->push_back("{\"diagnostic\":\"owned-child\"}");
  return true;
}
void FixtureBeforeClaim() { if (mode == "before-claim") Gate(); }
BOOL FixtureCreate(LPCWSTR application, LPWSTR command, LPSECURITY_ATTRIBUTES process_security,
                   LPSECURITY_ATTRIBUTES thread_security, BOOL inherit, DWORD flags,
                   LPVOID environment, LPCWSTR directory, LPSTARTUPINFOW startup,
                   LPPROCESS_INFORMATION information) {
  Check(application && SameWindowsPath(application, owned_path) && !inherit,
        "only the exact owned child may be created");
  Check(create_entries.fetch_add(1) == 0, "one launch claim cannot create twice");
  if (mode == "claim-before-api") Gate();
  if (mode == "create-failure") return FALSE;
  const BOOL created = ::CreateProcessW(application, command, process_security, thread_security,
      inherit, flags | CREATE_NO_WINDOW, environment, directory, startup, information);
  if (!created) return FALSE;
  created_children.fetch_add(1);
  if (!AssignProcessToJobObject(job.value, information->hProcess)) {
    ::TerminateProcess(information->hProcess, 1);
    WaitForSingleObject(information->hProcess, 35000);
    CloseHandle(information->hThread); CloseHandle(information->hProcess);
    *information = {};
    throw std::runtime_error("child job assignment");
  }
  HANDLE observation = nullptr;
  if (!DuplicateHandle(GetCurrentProcess(), information->hProcess, GetCurrentProcess(), &observation,
                       SYNCHRONIZE | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, 0)) {
    TerminateJobObject(job.value, 1);
    WaitForSingleObject(information->hProcess, 35000);
    CloseHandle(information->hThread); CloseHandle(information->hProcess);
    *information = {};
    throw std::runtime_error("child observation handle");
  }
  child_observer.store(observation);
  if (exit_state) InterlockedExchange(&exit_state->child_pid, static_cast<LONG>(GetProcessId(observation)));
  return TRUE;
}
bool FixtureImage(HANDLE process, LockedWindowsExecutable* output) {
  const auto child = child_observer.load();
  Check(child && GetProcessId(child) == GetProcessId(process), "image read is owned-only");
  if (mode == "after-create-read" || mode.starts_with("helper-exit-")) Gate();
  if (mode == "post-create-exception") throw std::bad_alloc();
  image_reads.fetch_add(1);
  const bool read = OpenLockedProcessExecutable(process, output);
  if (read && exit_state) InterlockedIncrement(&exit_state->reads);
  if (read && (mode == "image-mismatch" || mode == "termination-unconfirmed" || mode == "helper-exit-mismatch"))
    output->identity.executable_digest = std::string(64, 'f');
  return read;
}
BOOL FixtureTerminate(HANDLE process, UINT code) {
  Check(child_observer.load() && GetProcessId(process) == GetProcessId(child_observer.load()),
        "termination is owned-only");
  termination_calls.fetch_add(1);
  if (exit_state) InterlockedIncrement(&exit_state->terminations);
  if (mode == "termination-unconfirmed") {
    SetEvent(gate_entered.value);
    return FALSE;
  }
  return ::TerminateProcess(process, code);
}
void FixtureWorkerStarted() {
  HANDLE thread = nullptr;
  Check(DuplicateHandle(GetCurrentProcess(), GetCurrentThread(), GetCurrentProcess(), &thread,
                        SYNCHRONIZE, FALSE, 0), "worker observation handle");
  Check(worker_observer.exchange(thread) == nullptr, "single worker");
}
bool FixtureRetainLaunchOnExit() { return mode != "helper-exit-control"; }
BOOL RefuseShow(HWND, int) { Check(false, "unexpected show"); return FALSE; }
BOOL RefuseFocus(HWND) { Check(false, "unexpected focus"); return FALSE; }
UINT RefuseInput(UINT, LPINPUT, int) { Check(false, "unexpected input"); return 0; }

struct Harness {
  explicit Harness(const std::wstring& name = {}) {
    job.value = CreateJobObjectW(nullptr, name.empty() ? nullptr : (name + L"-job").c_str()); Check(job.value, "owned job");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    Check(SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits,
                                   sizeof(limits)), "owned job cleanup");
    gate_entered.value = CreateEventW(nullptr, TRUE, FALSE, name.empty() ? nullptr : (name + L"-entered").c_str());
    gate_release.value = CreateEventW(nullptr, TRUE, FALSE, name.empty() ? nullptr : (name + L"-release").c_str());
    Check(gate_entered.value && gate_release.value, "gate events");
    Check(SetEnvironmentVariableW(L"SC_CU_DISCOVERY_FIXTURE_CHILD", L"owned"), "child mode");
  }
  bool Cleanup() {
    SetEvent(gate_release.value);
    TerminateJobObject(job.value, 0);
    const auto worker = worker_observer.load();
    const bool worker_done = !worker || WaitForSingleObject(worker, 5000) == WAIT_OBJECT_0;
    // A claimed CreateProcess can finish after the first cleanup attempt released its gate.
    TerminateJobObject(job.value, 0);
    const auto child = child_observer.load();
    const bool child_done = !child || WaitForSingleObject(child, 35000) == WAIT_OBJECT_0;
    return child_done && worker_done;
  }
  ~Harness() {
    Cleanup();
    SetEnvironmentVariableW(L"SC_CU_DISCOVERY_FIXTURE_CHILD", nullptr);
    if (const auto child = child_observer.exchange(nullptr)) CloseHandle(child);
    if (const auto worker = worker_observer.exchange(nullptr)) CloseHandle(worker);
  }
};

struct Pipe {
  ScopedKernelHandle server, client;
  std::thread serving;
  bool served = false;
  Pipe() {
    const auto name = LR"(\\.\pipe\sc-discovery-launch-)" + std::to_wstring(GetCurrentProcessId());
    SECURITY_ATTRIBUTES security{}; PSECURITY_DESCRIPTOR descriptor = nullptr;
    Check(BuildCurrentUserPipeSecurity(&security, &descriptor), "private pipe security");
    server.value = CreateNamedPipeW(name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 65536, 65536, 0, &security);
    LocalFree(descriptor); Check(server.value != INVALID_HANDLE_VALUE, "pipe");
    ScopedKernelHandle event(CreateEventW(nullptr, TRUE, FALSE, nullptr));
    OVERLAPPED connecting{}; connecting.hEvent = event.value;
    const BOOL immediate = ConnectNamedPipe(server.value, &connecting);
    const DWORD error = immediate ? ERROR_SUCCESS : GetLastError();
    Check(immediate || error == ERROR_IO_PENDING || error == ERROR_PIPE_CONNECTED, "listen");
    client.value = CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
                               FILE_FLAG_OVERLAPPED, nullptr);
    Check(client.value != INVALID_HANDLE_VALUE, "owned client");
    if (!immediate && error == ERROR_IO_PENDING) {
      DWORD transferred = 0;
      Check(WaitForSingleObject(event.value, 5000) == WAIT_OBJECT_0 &&
            GetOverlappedResult(server.value, &connecting, &transferred, FALSE), "connect");
    }
    ULONG peer = 0;
    Check(GetNamedPipeClientProcessId(server.value, &peer) && peer == GetCurrentProcessId(), "owned peer");
    serving = std::thread([&] {
      BackendProbe probe; served = ServePipe(server.value, probe); DisconnectNamedPipe(server.value);
    });
  }
  void Send(unsigned char id, const std::string& metadata, MessageType type = MessageType::kProbe) {
    FrameHeader header; header.message_type = static_cast<std::uint16_t>(type);
    header.request_id.bytes[0] = id; header.session_id.bytes[0] = 21;
    Check(WriteFrame(client.value, header, metadata), "write");
  }
  std::string Read(unsigned char id, MessageType type) {
    Frame frame; Check(ReadFrame(client.value, &frame), "read");
    FrameId request, session; request.bytes[0] = id; session.bytes[0] = 21;
    Check(frame.header.request_id.bytes == request.bytes && frame.header.session_id.bytes == session.bytes &&
          frame.header.message_type == static_cast<std::uint16_t>(type), "bound reply");
    return {frame.metadata.begin(), frame.metadata.end()};
  }
  void Close() {
    if (client.value && client.value != INVALID_HANDLE_VALUE) CloseHandle(client.release());
    if (serving.joinable()) serving.join();
  }
  ~Pipe() { Close(); }
};

struct ExitMapping {
  ScopedKernelHandle handle;
  explicit ExitMapping(const std::wstring& name, bool create) {
    handle.value = create ? CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE,
        0, sizeof(ExitState), (name + L"-state").c_str())
        : OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, (name + L"-state").c_str());
    Check(handle.value != nullptr, "exit state mapping");
    exit_state = static_cast<ExitState*>(MapViewOfFile(handle.value, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(ExitState)));
    Check(exit_state != nullptr, "exit state view");
  }
  ~ExitMapping() { if (exit_state) UnmapViewOfFile(exit_state); exit_state = nullptr; }
};

void ReadOwnPath() {
  ScopedKernelHandle self(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, GetCurrentProcessId()));
  LockedWindowsExecutable image;
  Check(self.value && OpenLockedProcessExecutable(self.value, &image), "exit helper own image");
  owned_path = image.identity.path;
}

int RunExitHelper(const std::wstring& pipe, DWORD parent, const std::wstring& name) {
  ExitMapping mapping(name, false);
  job.value = OpenJobObjectW(JOB_OBJECT_ASSIGN_PROCESS | JOB_OBJECT_TERMINATE, FALSE, (name + L"-job").c_str());
  gate_entered.value = OpenEventW(EVENT_MODIFY_STATE | SYNCHRONIZE, FALSE, (name + L"-entered").c_str());
  gate_release.value = OpenEventW(EVENT_MODIFY_STATE | SYNCHRONIZE, FALSE, (name + L"-release").c_str());
  Check(job.value && gate_entered.value && gate_release.value, "observer owns fixture resources");
  ReadOwnPath();
  Check(SetEnvironmentVariableW(L"SC_CU_DISCOVERY_FIXTURE_CHILD", L"owned"), "exit child mode");
  return ServeMain(pipe, parent);
}

void RunHelperExitCase(const LockedWindowsExecutable& image, const std::wstring& name, Harness& harness) {
  ExitMapping mapping(name, true);
  const auto pipe_name = LR"(\\.\pipe\sprint-coder-computer-use-exit-)" + std::to_wstring(GetCurrentProcessId());
  const auto command = L"\"" + owned_path + L"\" --fixture-exit-helper \"" + pipe_name + L"\" " +
      std::to_wstring(GetCurrentProcessId()) + L" " + name + L" " + std::wstring(mode.begin(), mode.end());
  std::vector<wchar_t> writable(command.begin(), command.end()); writable.push_back(L'\0');
  STARTUPINFOW startup{}; startup.cb = sizeof(startup);
  PROCESS_INFORMATION info{};
  Check(::CreateProcessW(owned_path.c_str(), writable.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW,
                         nullptr, nullptr, &startup, &info), "spawn owned exit helper");
  struct Helper {
    ScopedKernelHandle process, thread;
    ~Helper() {
      if (WaitForSingleObject(process.value, 0) == WAIT_TIMEOUT) ::TerminateProcess(process.value, 1);
      WaitForSingleObject(process.value, 5000);
    }
  } helper;
  helper.process.value = info.hProcess; helper.thread.value = info.hThread;
  ScopedKernelHandle pipe;
  for (unsigned attempt = 0; attempt < 1000; ++attempt) {
    pipe.value = CreateFileW(pipe_name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr,
                             OPEN_EXISTING, FILE_FLAG_OVERLAPPED, nullptr);
    if (pipe.value != INVALID_HANDLE_VALUE) break;
    Check(WaitForSingleObject(helper.process.value, 0) == WAIT_TIMEOUT, "helper alive before pipe");
    Sleep(10);
  }
  Check(pipe.value != INVALID_HANDLE_VALUE, "exit helper pipe");
  auto send = [&](unsigned char id, MessageType type, const std::string& metadata) {
    FrameHeader header; header.message_type = static_cast<std::uint16_t>(type);
    header.request_id.bytes[0] = id; header.session_id.bytes[0] = 21;
    Check(WriteFrame(pipe.value, header, metadata), "exit request");
  };
  send(1, MessageType::kHandshake, "{\"protocolVersion\":1,\"apiVersion\":3}");
  Frame answer; Check(ReadFrame(pipe.value, &answer) && answer.header.message_type == static_cast<std::uint16_t>(MessageType::kHandshakeResult), "exit handshake");
  const std::string query = "{\"operation\":\"list_windows_cancellable\",\"discoveryId\":\"exit:1\",\"canonicalPath\":\"" +
      JsonEscape(Utf8FromWide(owned_path)) + "\",\"identityDigest\":\"" + image.identity.identity_digest +
      "\",\"executableDigest\":\"" + image.identity.executable_digest + "\",\"signerDigest\":\"" + image.identity.signer_digest + "\"}";
  send(2, MessageType::kProbe, query);
  Check(WaitForSingleObject(gate_entered.value, 15000) == WAIT_OBJECT_0, "actual helper image read held");
  const DWORD child_pid = static_cast<DWORD>(InterlockedCompareExchange(&exit_state->child_pid, 0, 0));
  Check(child_pid != 0, "owned child published");
  ScopedKernelHandle child(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | SYNCHRONIZE, FALSE, child_pid));
  LockedWindowsExecutable child_image;
  Check(child.value && OpenLockedProcessExecutable(child.value, &child_image) &&
        SameWindowsFileIdentity(child_image.identity.file_identity, image.identity.file_identity), "observer checks exact owned child");
  child_observer.store(child.release());
  CloseHandle(pipe.release());
  // The observer, not the helper, keeps the kill-on-close job open. Helper exit therefore
  // cannot hide an abandoned child by accidentally triggering fixture cleanup.
  if (mode == "helper-exit-control") {
    Check(WaitForSingleObject(helper.process.value, 5000) == WAIT_OBJECT_0, "old helper exits while worker is held");
    DWORD helper_code = 99;
    Check(GetExitCodeProcess(helper.process.value, &helper_code) && helper_code == 0, "old helper normal exit");
    Check(WaitForSingleObject(child_observer.load(), 0) == WAIT_TIMEOUT && exit_state->reads == 0 &&
          exit_state->terminations == 0, "old helper abandons its unverified child");
    std::cout << "CONTROLSTATE:{\"helperExit\":" << helper_code
              << ",\"childAlive\":true,\"reads\":" << exit_state->reads
              << ",\"terminations\":" << exit_state->terminations << "}\n";
    Check(harness.Cleanup(), "observer removes abandoned owned child");
    std::cout << "CONTROL: normal helper exit abandoned held unverified child; observer cleaned it\n";
    return;
  }
  Check(WaitForSingleObject(helper.process.value, 500) == WAIT_TIMEOUT &&
        WaitForSingleObject(child_observer.load(), 0) == WAIT_TIMEOUT && exit_state->reads == 0,
        "helper retains launch guard while post-create read is held");
  SetEvent(gate_release.value);
  Check(WaitForSingleObject(helper.process.value, 5000) == WAIT_OBJECT_0 && exit_state->reads == 1,
        "helper exits after actual image verification");
  DWORD helper_code = 99; Check(GetExitCodeProcess(helper.process.value, &helper_code) && helper_code == 0,
        "ServeMain exits normally");
  if (mode == "helper-exit-mismatch")
    Check(exit_state->terminations == 1 && WaitForSingleObject(child_observer.load(), 0) == WAIT_OBJECT_0,
          "unverified child exited before helper owner disappeared");
  else
    Check(exit_state->terminations == 0 && WaitForSingleObject(child_observer.load(), 0) == WAIT_TIMEOUT,
          "verified child is not rolled back on helper exit");
  Check(harness.Cleanup(), "observer completes own cleanup");
  std::cout << "PASS: " << mode << " helper lifetime preserves launch ownership\n";
}
}

int wmain(int argc, wchar_t** argv) {
  wchar_t child_mode[16]{};
  if (argc == 1 && GetEnvironmentVariableW(L"SC_CU_DISCOVERY_FIXTURE_CHILD", child_mode, 16) != 0) {
    Sleep(30000); return 0;
  }
  try {
    if (argc == 6 && std::wstring_view(argv[1]) == L"--fixture-exit-helper") {
      std::thread([] { Sleep(60000); ::TerminateProcess(GetCurrentProcess(), 43); }).detach();
      DWORD parent = 0; Check(ParseUnsigned(argv[3], &parent), "exit parent PID");
      mode = Utf8FromWide(argv[5]);
      return RunExitHelper(argv[2], parent, argv[4]);
    }
    Check(argc == 2, "one case required"); mode = Utf8FromWide(argv[1]);
    if (mode == "observer-rights") {
      ScopedKernelHandle limited;
      Check(DuplicateHandle(GetCurrentProcess(), GetCurrentProcess(), GetCurrentProcess(),
                            &limited.value, SYNCHRONIZE | PROCESS_TERMINATE, FALSE, 0),
            "limited observer duplicate");
      SetLastError(ERROR_SUCCESS);
      const DWORD observed = GetProcessId(limited.value), error = GetLastError();
      Check(observed == 0 && error == ERROR_ACCESS_DENIED, "PID read requires query access");
      std::cout << "PASS: old observer lacks PID query access\n"; return 0;
    }
    if (mode.starts_with("helper-exit-"))
      std::thread([] { Sleep(60000); ::TerminateProcess(GetCurrentProcess(), 43); }).detach();
    const std::wstring exit_name = mode.starts_with("helper-exit-")
        ? L"sc-discovery-exit-" + std::to_wstring(GetCurrentProcessId()) : std::wstring{};
    Harness harness(exit_name);
    ScopedKernelHandle self(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
                                        FALSE, GetCurrentProcessId()));
    LockedWindowsExecutable image;
    Check(self.value && OpenLockedProcessExecutable(self.value, &image), "own image");
    owned_path = image.identity.path;
    if (mode.starts_with("helper-exit-")) { RunHelperExitCase(image, exit_name, harness); return 0; }
    const auto id = "launch:" + mode;
    const std::string query = "{\"operation\":\"list_windows_cancellable\",\"discoveryId\":\"" + id +
        "\",\"canonicalPath\":\"" + JsonEscape(Utf8FromWide(owned_path)) + "\",\"identityDigest\":\"" +
        image.identity.identity_digest + "\",\"executableDigest\":\"" + image.identity.executable_digest +
        "\",\"signerDigest\":\"" + image.identity.signer_digest + "\"}";
    const std::string stop = "{\"operation\":\"stop_window_discovery\",\"discoveryId\":\"" + id + "\"}";
    Pipe pipe;
    pipe.Send(1, "{\"protocolVersion\":1,\"apiVersion\":3}", MessageType::kHandshake);
    pipe.Read(1, MessageType::kHandshakeResult);
    pipe.Send(2, query);
    const bool held = mode == "before-claim" || mode == "claim-before-api" ||
        mode == "after-create-read" || mode == "termination-unconfirmed";
    std::string receipt;
    if (held) {
      Check(WaitForSingleObject(gate_entered.value, 10000) == WAIT_OBJECT_0, "held boundary");
      const auto began = GetTickCount64(); pipe.Send(3, stop);
      Check(pipe.Read(2, MessageType::kError).find("window_discovery_unavailable") != std::string::npos,
            "query stops before held unit returns");
      if (mode == "before-claim") receipt = pipe.Read(3, MessageType::kProbeResult);
      else Check(pipe.Read(3, MessageType::kError).find("window_discovery_unconfirmed") != std::string::npos,
                 "claimed unit stays unconfirmed");
      Check(GetTickCount64() - began < 1000, "bounded Stop answer");
      if (mode == "termination-unconfirmed") {
        Check(child_observer.load() && WaitForSingleObject(child_observer.load(), 0) == WAIT_TIMEOUT,
              "failed termination retains live child");
        Check(::TerminateProcess(child_observer.load(), 0), "fixture releases owned child");
      } else SetEvent(gate_release.value);
    } else if (mode == "post-create-exception") {
      Check(pipe.Read(2, MessageType::kError).find("window_discovery_unavailable") != std::string::npos,
            "post-create exception reported");
    } else {
      const auto completed = pipe.Read(2, MessageType::kProbeResult);
      Check(completed.find("\"result\":\"completed\"") != std::string::npos, "normal terminal envelope");
      pipe.Send(4, query);
      Check(pipe.Read(4, MessageType::kError).find("discovery_id_reuse") != std::string::npos,
            "fresh wire cannot repeat a completed query");
    }
    Check(worker_observer.load() && WaitForSingleObject(worker_observer.load(), 5000) == WAIT_OBJECT_0,
          "worker exits before final proof");
    pipe.Send(5, stop); receipt = pipe.Read(5, MessageType::kProbeResult);
    std::uint64_t attempts = 99;
    Check(ReadJsonUint64(receipt, "launchAttemptCount", &attempts) &&
          attempts == (mode == "before-claim" ? 0u : 1u), "claim counter");
    if (mode == "before-claim" || mode == "create-failure") Check(created_children.load() == 0, "no child");
    else if (mode == "image-mismatch" || mode == "post-create-exception" || mode == "termination-unconfirmed")
      Check(child_observer.load() && WaitForSingleObject(child_observer.load(), 0) == WAIT_OBJECT_0,
            "unverified child exit precedes terminal proof");
    else Check(child_observer.load() && WaitForSingleObject(child_observer.load(), 0) == WAIT_TIMEOUT,
               "verified launch is not rolled back");
    pipe.Close(); Check(pipe.served, "pipe joined");
    FrameId key; key.bytes[0] = 21;
    const auto owner = WindowsDiscoveries().owners.at(FrameIdKey(key));
    Check(owner->terminal && !owner->launch_in_flight && owner->references.load() == 0 &&
          !WindowsTargetListWorkerRunning().load(), "terminal ownership reclaimed");
    Check(harness.Cleanup(), "owned child and worker cleanup");
    std::cout << "RECEIPT:" << receipt << "\n";
    std::cout << "PASS: " << mode << " child cleanup, no OS input, no public qualification\n";
    return 0;
  } catch (const std::exception& error) { std::cerr << "FAIL: " << error.what() << "\n"; return 1; }
}
