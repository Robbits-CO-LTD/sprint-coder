// Real V1 identity measurement on an owned classic System32 Notepad. The Store variant is never
// activated. Native Start is attempted only when this owned window is already foreground; this
// does not establish packaged-app UI/grant or Provider acceptance.
#define wmain ProductionHostMain
#include "live-host.cc"
#undef wmain
#include <iostream>
#include <stdexcept>

namespace {
void Require(bool ok, const char* message) { if (!ok) throw std::runtime_error(message); }
struct OwnedTarget {
  ScopedKernelHandle job, token, process, thread;
  bool exited = true;
  void Stop() {
    if (process.value != nullptr) {
      if (WaitForSingleObject(process.value, 0) == WAIT_TIMEOUT) TerminateProcess(process.value, 0);
      exited = WaitForSingleObject(process.value, 5000) == WAIT_OBJECT_0;
    }
  }
  ~OwnedTarget() { Stop(); }
};
bool PrepareMediumToken(OwnedTarget& owned) {
  if (!IsProcessElevated(GetCurrentProcessId())) return true;
  ScopedKernelHandle own;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ALL_ACCESS, &own.value)) return false;
  BYTE administrators[SECURITY_MAX_SID_SIZE]; DWORD size = sizeof(administrators);
  SID_AND_ATTRIBUTES deny{};
  if (!CreateWellKnownSid(WinBuiltinAdministratorsSid, nullptr, administrators, &size)) return false;
  deny.Sid = administrators;
  if (!CreateRestrictedToken(own.value, LUA_TOKEN | DISABLE_MAX_PRIVILEGE, 1, &deny, 0,
                            nullptr, 0, nullptr, &owned.token.value)) return false;
  PSID medium = nullptr;
  if (!ConvertStringSidToSidW(L"S-1-16-8192", &medium)) return false;
  TOKEN_MANDATORY_LABEL label{}; label.Label.Attributes = SE_GROUP_INTEGRITY; label.Label.Sid = medium;
  const bool lowered = SetTokenInformation(owned.token.value, TokenIntegrityLevel, &label,
      sizeof(label) + GetLengthSid(medium)) != FALSE;
  LocalFree(medium);
  TOKEN_ELEVATION elevation{}; DWORD returned = 0;
  return lowered && GetTokenInformation(owned.token.value, TokenElevation, &elevation,
      sizeof(elevation), &returned) && !elevation.TokenIsElevated;
}
HWND OwnedWindow(DWORD pid) {
  struct Search { DWORD pid; HWND window = nullptr; } search{pid};
  const auto deadline = GetTickCount64() + 10000;
  while (search.window == nullptr && GetTickCount64() < deadline) {
    EnumWindows([](HWND window, LPARAM data) -> BOOL {
      auto& search = *reinterpret_cast<Search*>(data); DWORD owner = 0;
      GetWindowThreadProcessId(window, &owner);
      if (owner == search.pid && IsWindowVisible(window) && IsApplicationWindow(window)) {
        search.window = window; return FALSE;
      }
      return TRUE;
    }, reinterpret_cast<LPARAM>(&search));
    if (search.window == nullptr) Sleep(50);
  }
  return search.window;
}
struct PipeRun {
  ScopedKernelHandle server, client;
  std::thread serving;
  bool served = false;
  PipeRun() {
    const auto name = L"\\.\pipe\sc-v1-real-" + std::to_wstring(GetCurrentProcessId());
    SECURITY_ATTRIBUTES security{}; PSECURITY_DESCRIPTOR descriptor = nullptr;
    Require(BuildCurrentUserPipeSecurity(&security, &descriptor), "private pipe security");
    server.value = CreateNamedPipeW(name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 65536, 65536, 0, &security);
    LocalFree(descriptor); Require(server.value != INVALID_HANDLE_VALUE, "private pipe");
    ScopedKernelHandle event(CreateEventW(nullptr, TRUE, FALSE, nullptr)); Require(event.value != nullptr, "connect event");
    OVERLAPPED connecting{}; connecting.hEvent = event.value;
    const BOOL immediate = ConnectNamedPipe(server.value, &connecting);
    const DWORD error = immediate ? ERROR_SUCCESS : GetLastError();
    Require(immediate || error == ERROR_IO_PENDING || error == ERROR_PIPE_CONNECTED, "listen");
    client.value = CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, nullptr);
    Require(client.value != INVALID_HANDLE_VALUE, "own client");
    if (!immediate && error == ERROR_IO_PENDING) {
      DWORD transferred = 0;
      Require(WaitForSingleObject(event.value, 5000) == WAIT_OBJECT_0 &&
          GetOverlappedResult(server.value, &connecting, &transferred, FALSE), "connect completion");
    }
    ULONG peer = 0; Require(GetNamedPipeClientProcessId(server.value, &peer) && peer == GetCurrentProcessId(), "owned peer");
    serving = std::thread([&] {
      const auto apartment = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
      if (SUCCEEDED(apartment)) {
        served = ServePipe(server.value, ProbeBackend()); CoUninitialize();
      }
      DisconnectNamedPipe(server.value);
    });
    Exchange(1, "{\"protocolVersion\":1,\"apiVersion\":3}",
        sprint_coder::computer_use::MessageType::kHandshake,
        sprint_coder::computer_use::MessageType::kHandshakeResult);
  }
  std::string Exchange(unsigned char id, const std::string& metadata,
      sprint_coder::computer_use::MessageType type = sprint_coder::computer_use::MessageType::kProbe,
      sprint_coder::computer_use::MessageType expected = sprint_coder::computer_use::MessageType::kProbeResult) {
    sprint_coder::computer_use::FrameHeader header;
    header.message_type = static_cast<std::uint16_t>(type); header.session_id.bytes[0] = 21; header.request_id.bytes[0] = id;
    Require(WriteFrame(client.value, header, metadata), "request write");
    sprint_coder::computer_use::Frame reply;
    Require(ReadFrame(client.value, &reply) && reply.header.request_id.bytes == header.request_id.bytes &&
        reply.header.session_id.bytes == header.session_id.bytes && reply.header.message_type == static_cast<std::uint16_t>(expected), "bound native reply");
    return {reply.metadata.begin(), reply.metadata.end()};
  }
  void Close() {
    if (client.value != nullptr && client.value != INVALID_HANDLE_VALUE) CloseHandle(client.release());
    if (serving.joinable()) serving.join();
  }
  ~PipeRun() { Close(); }
};
}
int wmain() {
  try {
    UINT32 packages = 0, buffer = 0;
    const LONG lookup = GetPackagesByPackageFamily(L"Microsoft.WindowsNotepad_8wekyb3d8bbwe",
        &packages, nullptr, &buffer, nullptr);
    if (lookup == ERROR_INSUFFICIENT_BUFFER && packages > 0) {
      std::cout << "RESULT:{\"measurement\":\"NOT_RUN\",\"nativeStart\":\"NOT_RUN\",\"reason\":\"store_notepad_present\",\"childExited\":true}\n";
      return 0;
    }
    Require(lookup == ERROR_SUCCESS && packages == 0, "package lookup must answer before launching");
    Require(ConfigurePerMonitorDpiAwareness(), "DPI context");
    struct Apartment {
      HRESULT result = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
      ~Apartment() { if (SUCCEEDED(result)) CoUninitialize(); }
    } apartment;
    Require(SUCCEEDED(apartment.result), "consumer COM apartment");
    std::vector<wchar_t> system(32768);
    const UINT length = GetSystemDirectoryW(system.data(), static_cast<UINT>(system.size()));
    Require(length > 0 && length < system.size(), "system directory");
    const std::wstring path = std::wstring(system.data(), length) + L"\\notepad.exe";
    LockedWindowsExecutable approved;
    Require(OpenLockedWindowsExecutable(path, &approved), "trusted executable read");
    Require(IsTrustedSystemNotepad(approved.identity) && IsSupportedWindowsV1Target(approved.identity),
            "genuine supported V1 baseline");
    OwnedTarget owned;
    owned.job.value = CreateJobObjectW(nullptr, nullptr);
    Require(owned.job.value != nullptr, "owned job");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    Require(SetInformationJobObject(owned.job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits)), "job cleanup");
    Require(PrepareMediumToken(owned), "unelevated child token");
    STARTUPINFOW startup{}; startup.cb = sizeof(startup); startup.dwFlags = STARTF_USESHOWWINDOW; startup.wShowWindow = SW_SHOWNORMAL;
    PROCESS_INFORMATION child{}; std::wstring command = L"\"" + path + L"\"";
    const BOOL launched = owned.token.value != nullptr
        ? CreateProcessAsUserW(owned.token.value, path.c_str(), command.data(), nullptr, nullptr, FALSE,
                               CREATE_SUSPENDED, nullptr, nullptr, &startup, &child)
        : CreateProcessW(path.c_str(), command.data(), nullptr, nullptr, FALSE, CREATE_SUSPENDED,
                         nullptr, nullptr, &startup, &child);
    Require(launched, "create owned suspended Notepad");
    owned.process.value = child.hProcess; owned.thread.value = child.hThread; owned.exited = false;
    Require(AssignProcessToJobObject(owned.job.value, owned.process.value), "own before resume");
    LockedWindowsExecutable running;
    Require(OpenLockedProcessExecutable(owned.process.value, &running) &&
            SameWindowsPath(running.identity.path, approved.identity.path) &&
            SameWindowsFileIdentity(running.identity.file_identity, approved.identity.file_identity), "exact running image before execution");
    Require(ResumeThread(owned.thread.value) != static_cast<DWORD>(-1), "resume owned process");
    WaitForInputIdle(owned.process.value, 10000);
    const HWND window = OwnedWindow(child.dwProcessId);
    Require(window != nullptr, "window belongs to owned process");
    WindowsStartInput input; input.eligibility_basis = sprint_coder::computer_use::EligibilityBasis::kV1Allowlist;
    input.pid = child.dwProcessId; input.window = window; input.window_value = reinterpret_cast<UINT_PTR>(window);
    input.canonical_path = running.identity.path; input.app_identity = running.identity.identity_digest;
    input.executable_digest = running.identity.executable_digest; input.signer_digest = running.identity.signer_digest;
    input.profile_revision = 1; input.session_id = "v1-owned-notepad";
    std::string created; Require(ReadProcessStartIdentity(owned.process.value, &created), "creation binding");
    input.expected_window_identity = Sha256String("computer-window-identity-v1\n" + input.app_identity + "\n" + created + "\n" + std::to_string(input.window_value));
    bool measured_ok = false; WindowsNewStartMeasurement measured;
    std::thread measure([&] {
      ScopedKernelHandle process; LockedWindowsExecutable executable;
      measured_ok = MeasureWindowsNewStart(input, [] { return true; }, &process, &executable, &measured);
    });
    measure.join();
    Require(measured_ok && measured.maximum_mode == "full_access_app" &&
            measured.executable.policy_language == running.identity.policy_language &&
            measured.window_identity == input.expected_window_identity && !measured.context &&
            !measured.not_web_file && windows_v2_main_pid == 0 && !WindowsV2FactsContextCache(), "real V1 worker measurement without V2 context");
    bool started = false; std::uint64_t input_attempts = 0;
    // This native integration does not steal focus to manufacture an interactive prerequisite.
    if (GetForegroundWindow() == window && !IsIconic(window)) {
      RECT bounds{}; Require(ClientBoundsPhysical(window, &bounds), "physical client bounds");
      const std::string metadata = "{\"operation\":\"start_session\",\"sessionId\":\"v1-owned-notepad\",\"pid\":" +
          std::to_string(input.pid) + ",\"windowId\":\"" + std::to_string(input.window_value) +
          "\",\"cancelEpoch\":0,\"appIdentityDigest\":\"" + input.app_identity + "\",\"windowIdentityDigest\":\"" +
          input.expected_window_identity + "\",\"canonicalPath\":\"" + JsonEscape(input.canonical_path.empty() ? "" : Utf8FromWide(input.canonical_path)) +
          "\",\"executableDigest\":\"" + input.executable_digest + "\",\"signerDigest\":\"" + input.signer_digest +
          "\",\"profileRevision\":1,\"expectedBoundsX\":" + std::to_string(bounds.left) + ",\"expectedBoundsY\":" + std::to_string(bounds.top) +
          ",\"expectedBoundsWidth\":" + std::to_string(bounds.right-bounds.left) + ",\"expectedBoundsHeight\":" + std::to_string(bounds.bottom-bounds.top) + "}";
      PipeRun pipe;
      const std::string response = pipe.Exchange(2, metadata);
      sprint_coder::computer_use::FrameId session_key; session_key.bytes[0] = 21;
      Require(sessions.size() == 1 && sessions.at(FrameIdKey(session_key)).eligibility_basis == input.eligibility_basis &&
              ReadJsonUint64(response, "inputAttemptCount", &input_attempts), "real V1 receipt and basis");
      const std::string stop = "{\"operation\":\"stop_pending_start\",\"sessionId\":\"v1-owned-notepad\"}";
      const auto closed = pipe.Exchange(3, stop);
      std::string result; bool drained = false;
      Require(ReadJsonString(closed, "result", &result) && result == "closed" &&
              ReadOptionalJsonBoolean(closed, "drained", &drained) && drained && sessions.empty(), "real V1 terminal close");
      pipe.Close(); Require(pipe.served, "pipe shutdown");
      std::cout << "RECEIPT:" << closed << "\n";
      started = true;
    }
    owned.Stop(); Require(owned.exited, "owned process cleanup");
    std::cout << "RESULT:{\"measurement\":\"PASS\",\"nativeStart\":\"" << (started ? "PASS" : "NOT_RUN")
              << "\",\"reason\":\"" << (started ? "" : "owned_window_not_foreground") << "\",\"inputAttempts\":" << input_attempts
              << ",\"childExited\":true,\"publicAppUi\":\"NOT_RUN\"}\n";
    return 0;
  } catch (const std::exception& error) { std::cerr << "FAIL: " << error.what() << "\n"; return 1; }
}
