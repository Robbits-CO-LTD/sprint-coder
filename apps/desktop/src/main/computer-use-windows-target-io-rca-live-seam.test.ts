import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// #940 RCA only: the real ServePipe reader/consumer and real named-pipe framing, with one
// measurement stopped by a manual event. No production file, input API, or desktop-wide
// enumeration is changed. This records the CURRENT failure boundary; a later fix must replace
// the held-case expectation with timely receipts while the measurement is still held.
const nativeDirectory = join(__dirname, '../../computer-use-native');
const host = readFileSync(join(nativeDirectory, 'computer_use_windows_host.cc'), 'utf8');
const measurement = '  out->measured = MeasureWindowsTargetFacts(pid, nullptr, context);';
const enumeration = 'EnumWindows(CollectWindowsV2TopLevel, reinterpret_cast<LPARAM>(&windows))';

function replaceOnce(source: string, before: string, after: string): string {
  if (source.split(before).length !== 2) throw new Error('RCA seam source boundary changed');
  return source.replace(before, after);
}

function instrumentedHost(): string {
  return replaceOnce(
    replaceOnce(host, measurement, `  Sc940MeasureGate(pid);\n${measurement}`),
    enumeration,
    'Sc940EnumerateOwnedWindow(CollectWindowsV2TopLevel, reinterpret_cast<LPARAM>(&windows))',
  );
}

type Build = { file: string; args: (arguments_: string[]) => string[]; verbatim: boolean };
function compiler(): Build | null {
  if (process.platform !== 'win32') return null;
  if (spawnSync('cl.exe', ['/?'], { stdio: 'ignore' }).status === 0)
    return { file: 'cl.exe', args: (arguments_) => arguments_, verbatim: false };
  const vswhere = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';
  if (!existsSync(vswhere)) return null;
  const found = spawnSync(
    vswhere,
    [
      '-latest',
      '-products',
      '*',
      '-requires',
      'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      '-property',
      'installationPath',
    ],
    { encoding: 'utf8' },
  );
  const vcvars = join(found.stdout.trim(), 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
  if (found.status !== 0 || !existsSync(vcvars)) return null;
  return {
    file: 'cmd.exe',
    args: (arguments_) => [
      '/d',
      '/s',
      '/c',
      `"call "${vcvars}" >nul && cl.exe ${arguments_.map((argument) => `"${argument}"`).join(' ')}"`,
    ],
    verbatim: true,
  };
}

function run(file: string, args: string[], timeout: number, verbatim = false) {
  return new Promise<{ status: number | null; stdout: string; stderr: string; timedOut: boolean }>(
    (resolve) => {
      const child = spawn(file, args, {
        windowsVerbatimArguments: verbatim,
        env: { ...process.env, VSLANG: '1033' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        // vcvars starts cl/link below cmd.exe; killing only cmd can leave its pipes open forever.
        if (process.platform === 'win32' && child.pid !== undefined)
          spawnSync(
            join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
            ['/pid', String(child.pid), '/t', '/f'],
            { stdio: 'ignore', timeout: 5_000 },
          );
        child.kill();
      }, timeout);
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', () => {
        clearTimeout(timer);
        resolve({ status: -1, stdout, stderr, timedOut });
      });
      child.on('close', (status) => {
        clearTimeout(timer);
        resolve({ status, stdout, stderr, timedOut });
      });
    },
  );
}

const program = String.raw`
#include <windows.h>
#include <cstdint>
namespace {
void Sc940MeasureGate(std::uint32_t pid);
BOOL Sc940EnumerateOwnedWindow(WNDENUMPROC callback, LPARAM parameter);
}
#define wmain sc940_original_host_wmain
#include "instrumented-host.cc"
#undef wmain
#include <stdexcept>

namespace {
HANDLE gate_entered = nullptr;
HANDLE gate_release = nullptr;
DWORD fixture_pid = 0;
HWND fixture_window = nullptr;
bool hold_measurement = false;
std::atomic<bool> gate_timed_out{false};
std::atomic<bool> wrong_measurement{false};

void Require(bool condition, const char *reason) {
  if (!condition) throw std::runtime_error(reason);
}

void Sc940MeasureGate(std::uint32_t pid) {
  if (pid != fixture_pid) {
    wrong_measurement.store(true);
    throw std::runtime_error("foreign_measurement");
  }
  SetEvent(gate_entered);
  if (hold_measurement && WaitForSingleObject(gate_release, 20'000) != WAIT_OBJECT_0)
    gate_timed_out.store(true);
}

BOOL Sc940EnumerateOwnedWindow(WNDENUMPROC callback, LPARAM parameter) {
  DWORD owner = 0;
  if (!IsWindow(fixture_window) ||
      GetWindowThreadProcessId(fixture_window, &owner) == 0 || owner != fixture_pid)
    return FALSE;
  return callback(fixture_window, parameter);
}

struct FixtureReady { DWORD pid; UINT_PTR window; };

int Fixture(const wchar_t *mapping_name, const wchar_t *event_name) {
  ScopedKernelHandle mapping(OpenFileMappingW(FILE_MAP_WRITE, FALSE, mapping_name));
  ScopedKernelHandle ready(OpenEventW(EVENT_MODIFY_STATE, FALSE, event_name));
  if (mapping.value == nullptr || ready.value == nullptr) return 2;
  auto *shared = static_cast<FixtureReady *>(MapViewOfFile(mapping.value, FILE_MAP_WRITE, 0, 0, sizeof(FixtureReady)));
  if (shared == nullptr) return 3;
  WNDCLASSW wc{};
  wc.lpfnWndProc = DefWindowProcW;
  wc.hInstance = GetModuleHandleW(nullptr);
  wc.lpszClassName = L"Sc940OwnedFixture";
  RegisterClassW(&wc);
  HWND window = CreateWindowExW(0, wc.lpszClassName, L"RCA fixture", WS_OVERLAPPEDWINDOW,
                                0, 0, 320, 200, nullptr, nullptr, wc.hInstance, nullptr);
  if (window == nullptr) { UnmapViewOfFile(shared); return 4; }
  ShowWindow(window, SW_SHOWNOACTIVATE);
  shared->pid = GetCurrentProcessId();
  shared->window = reinterpret_cast<UINT_PTR>(window);
  SetEvent(ready.value);
  UnmapViewOfFile(shared);
  MSG message{};
  while (GetMessageW(&message, nullptr, 0, 0) > 0) {
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }
  DestroyWindow(window);
  return 0;
}

sprint_coder::computer_use::FrameId Id(std::uint8_t byte) {
  sprint_coder::computer_use::FrameId id;
  id.bytes.fill(byte);
  return id;
}

struct RcaRun {
  ScopedKernelHandle entered{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  ScopedKernelHandle release{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  ScopedKernelHandle finished{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  ScopedKernelHandle job;
  ScopedKernelHandle child;
  ScopedKernelHandle server{INVALID_HANDLE_VALUE};
  ScopedKernelHandle client{INVALID_HANDLE_VALUE};
  std::thread serving;
  std::thread receiving;
  std::thread watchdog;
  std::mutex replies_mutex;
  std::condition_variable replies_ready;
  std::unordered_map<unsigned, Frame> replies;
  std::atomic<bool> watchdog_fired{false};
  std::atomic<bool> serve_ok{false};
  bool cleaned = false;
  bool child_exited = false;

  RcaRun() {
    Require(entered.value && release.value && finished.value, "event_creation");
    gate_entered = entered.value;
    gate_release = release.value;
    job.value = CreateJobObjectW(nullptr, nullptr);
    Require(job.value != nullptr, "job_creation");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    Require(SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) != FALSE,
            "job_limits");
    Require(SetHandleInformation(job.value, HANDLE_FLAG_INHERIT, 0) != FALSE, "job_not_inherited");
    watchdog = std::thread([this] {
      if (WaitForSingleObject(finished.value, 60'000) == WAIT_OBJECT_0) return;
      watchdog_fired.store(true);
      SetEvent(release.value);
      if (job.value != nullptr) TerminateJobObject(job.value, 90);
      // The outer test must fail instead of hanging in join if a real OS call did not return.
      if (WaitForSingleObject(finished.value, 2'000) != WAIT_OBJECT_0)
        TerminateProcess(GetCurrentProcess(), 90);
    });
  }

  void StartFixture() {
    const std::wstring suffix = std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(GetTickCount64());
    const std::wstring mapping_name = L"Local\\sc940-map-" + suffix;
    const std::wstring event_name = L"Local\\sc940-ready-" + suffix;
    ScopedKernelHandle mapping(CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, 0,
                                                  sizeof(FixtureReady), mapping_name.c_str()));
    ScopedKernelHandle ready(CreateEventW(nullptr, TRUE, FALSE, event_name.c_str()));
    Require(mapping.value && ready.value, "fixture_channels");
    std::vector<wchar_t> executable(32768, L'\0');
    const DWORD length = GetModuleFileNameW(nullptr, executable.data(), static_cast<DWORD>(executable.size()));
    Require(length > 0 && length < executable.size(), "own_executable");
    std::wstring command = L"\"" + std::wstring(executable.data(), length) + L"\" fixture \"" +
                           mapping_name + L"\" \"" + event_name + L"\"";
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION process{};
    Require(CreateProcessW(nullptr, command.data(), nullptr, nullptr, FALSE, CREATE_SUSPENDED,
                            nullptr, nullptr, &startup, &process) != FALSE, "fixture_start");
    child.value = process.hProcess;
    ScopedKernelHandle thread(process.hThread);
    Require(AssignProcessToJobObject(job.value, child.value) != FALSE, "fixture_job_assignment");
    Require(ResumeThread(thread.value) != static_cast<DWORD>(-1), "fixture_resume");
    Require(WaitForSingleObject(ready.value, 15'000) == WAIT_OBJECT_0, "fixture_ready");
    auto *shared = static_cast<const FixtureReady *>(MapViewOfFile(mapping.value, FILE_MAP_READ, 0, 0, sizeof(FixtureReady)));
    Require(shared != nullptr, "fixture_ready_mapping");
    const FixtureReady found = *shared;
    UnmapViewOfFile(shared);
    Require(found.pid == process.dwProcessId && found.window != 0, "fixture_ready_binding");
    fixture_pid = found.pid;
    fixture_window = reinterpret_cast<HWND>(found.window);
    Require(WaitForSingleObject(child.value, 0) == WAIT_TIMEOUT, "fixture_stays_alive");
  }

  void StartPipe() {
    SECURITY_ATTRIBUTES security{};
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    Require(BuildCurrentUserPipeSecurity(&security, &descriptor), "pipe_security");
    const std::wstring name = L"\\\\.\\pipe\\sprint-coder-computer-use-rca-" +
                              std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(GetTickCount64());
    server.value = CreateNamedPipeW(name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
        1, 65536, 65536, 0, &security);
    LocalFree(descriptor);
    Require(server.value != INVALID_HANDLE_VALUE, "pipe_creation");
    struct Connection {
      HANDLE pipe;
      ScopedKernelHandle event{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
      OVERLAPPED operation{};
      bool pending = false;
      explicit Connection(HANDLE value) : pipe(value) {
        Require(event.value != nullptr, "connection_event");
        operation.hEvent = event.value;
      }
      ~Connection() {
        if (!pending) return;
        // Keep OVERLAPPED and its event alive until cancellation itself has completed.
        CancelIoEx(pipe, &operation);
        DWORD transferred = 0;
        GetOverlappedResult(pipe, &operation, &transferred, TRUE);
      }
    } connection(server.value);
    const BOOL immediate = ConnectNamedPipe(server.value, &connection.operation);
    const DWORD connect_error = immediate ? ERROR_SUCCESS : GetLastError();
    connection.pending = !immediate && connect_error == ERROR_IO_PENDING;
    Require(immediate || connect_error == ERROR_IO_PENDING || connect_error == ERROR_PIPE_CONNECTED, "pipe_listening");
    client.value = CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
                               FILE_FLAG_OVERLAPPED, nullptr);
    Require(client.value != INVALID_HANDLE_VALUE, "pipe_client");
    if (connection.pending) {
      DWORD transferred = 0;
      Require(WaitForSingleObject(connection.event.value, 5000) == WAIT_OBJECT_0 &&
                  GetOverlappedResult(server.value, &connection.operation, &transferred, FALSE), "pipe_connected");
      connection.pending = false;
    }
    ULONG peer = 0;
    Require(GetNamedPipeClientProcessId(server.value, &peer) && peer == GetCurrentProcessId(), "pipe_peer");

    // This is a control session for real Cancel/Close receipts, not a claim that start/grants passed.
    WindowsSession session;
    session.session_id = "sc940-control";
    session.cancel_epoch = 1;
    sessions.emplace(FrameIdKey(Id(7)), std::move(session));
    cancellation_epoch.store(1);
    windows_v2_main_pid = GetCurrentProcessId();
    serving = std::thread([this] {
      const HRESULT apartment = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
      if (SUCCEEDED(apartment)) {
        // No capture/input capability is needed for this protocol and measurement-only seam.
        serve_ok.store(ServePipe(server.value, BackendProbe{}));
        CoUninitialize();
      }
    });
    receiving = std::thread([this] {
      Frame frame;
      while (ReadFrame(client.value, &frame)) {
        {
          std::lock_guard<std::mutex> lock(replies_mutex);
          replies.emplace(frame.header.request_id.bytes[0], std::move(frame));
        }
        replies_ready.notify_all();
        frame = {};
      }
    });
  }

  void Send(MessageType type, std::uint8_t id, std::string_view metadata) {
    FrameHeader header;
    header.message_type = static_cast<std::uint16_t>(type);
    header.request_id = Id(id);
    header.session_id = Id(7);
    if (type == MessageType::kCancel) header.cancel_id = Id(9);
    Require(WriteFrame(client.value, header, metadata), "frame_write");
  }

  bool Wait(unsigned id, DWORD milliseconds) {
    std::unique_lock<std::mutex> lock(replies_mutex);
    return replies_ready.wait_for(lock, std::chrono::milliseconds(milliseconds), [&] { return replies.contains(id); });
  }

  bool Receipt(unsigned id, MessageType type, std::string_view expected, std::uint64_t epoch) {
    std::lock_guard<std::mutex> lock(replies_mutex);
    const auto found = replies.find(id);
    if (found == replies.end()) return false;
    const Frame &frame = found->second;
    const std::string body(frame.metadata.begin(), frame.metadata.end());
    std::string result, session;
    std::uint64_t actual_epoch = 0, attempts = 1;
    bool drained = false;
    return frame.header.message_type == static_cast<std::uint16_t>(type) && frame.binary.empty() &&
           frame.header.request_id.bytes == Id(static_cast<std::uint8_t>(id)).bytes &&
           frame.header.session_id.bytes == Id(7).bytes &&
           ReadJsonString(body, "result", &result) && result == expected &&
           ReadJsonString(body, "sessionId", &session) && session == "sc940-control" &&
           ReadJsonUint64(body, "cancelEpoch", &actual_epoch) && actual_epoch == epoch &&
           ReadJsonUint64(body, "inputAttemptCount", &attempts) && attempts == 0 &&
           ReadOptionalJsonBoolean(body, "drained", &drained) && drained;
  }

  bool ProbeReply(unsigned id, MessageType type) {
    std::lock_guard<std::mutex> lock(replies_mutex);
    const auto found = replies.find(id);
    return found != replies.end() && found->second.header.message_type == static_cast<std::uint16_t>(type) &&
           found->second.header.request_id.bytes == Id(static_cast<std::uint8_t>(id)).bytes &&
           found->second.header.session_id.bytes == Id(7).bytes && found->second.binary.empty();
  }

  void Cleanup() {
    if (cleaned) return;
    cleaned = true;
    SetEvent(release.value);
    if (client.value != INVALID_HANDLE_VALUE) CancelIoEx(client.value, nullptr);
    if (server.value != INVALID_HANDLE_VALUE) { CancelIoEx(server.value, nullptr); DisconnectNamedPipe(server.value); }
    if (serving.joinable()) serving.join();
    if (receiving.joinable()) receiving.join();
    if (job.value != nullptr) TerminateJobObject(job.value, 0);
    if (child.value != nullptr) {
      if (WaitForSingleObject(child.value, 0) == WAIT_TIMEOUT) TerminateProcess(child.value, 0);
      child_exited = WaitForSingleObject(child.value, 5000) == WAIT_OBJECT_0;
    }
    for (auto &entry : sessions) ReleaseWindowsSessionResources(&entry.second);
    sessions.clear();
    SetEvent(finished.value);
    if (watchdog.joinable()) watchdog.join();
  }
  ~RcaRun() { Cleanup(); }
};

int Diagnose(bool held) {
  RcaRun run;
  hold_measurement = held;
  bool healthy_receipts = false, epoch_advanced = false, no_receipts_at_one_second = false;
  bool list_recovered = false, cancel_recovered = false, close_recovered = false;
  ULONGLONG epoch_ms = 0, receipt_wait_ms = 0;
  try {
    run.StartFixture();
    run.StartPipe();
    run.Send(MessageType::kHandshake, 1, "{\"protocolVersion\":1,\"apiVersion\":2}");
    Require(run.Wait(1, 5000) && run.ProbeReply(1, MessageType::kHandshakeResult), "handshake");
    run.Send(MessageType::kProbe, 2, "{\"operation\":\"list_targets\"}");
    Require(WaitForSingleObject(run.entered.value, 15'000) == WAIT_OBJECT_0, "measure_entered");
    if (!held) Require(run.Wait(2, 15'000) && run.ProbeReply(2, MessageType::kProbeResult), "healthy_list");
    Require(WaitForSingleObject(run.child.value, 0) == WAIT_TIMEOUT, "fixture_alive_before_cancel");
    const ULONGLONG sent = GetTickCount64();
    run.Send(MessageType::kCancel, 3, "{\"cancelEpoch\":2}");
    while (cancellation_epoch.load() < 2 && GetTickCount64() - sent < 1000) Sleep(1);
    epoch_ms = GetTickCount64() - sent;
    epoch_advanced = cancellation_epoch.load() >= 2;
    Require(epoch_advanced, "reader_epoch_advanced");
    run.Send(MessageType::kProbe, 4, "{\"operation\":\"close_session\",\"cancelEpoch\":3}");
    const ULONGLONG waiting = GetTickCount64();
    if (held) {
      const bool cancel_early = run.Wait(3, 1000);
      no_receipts_at_one_second = !cancel_early && !run.Wait(4, 0) && !run.Wait(2, 0);
      Require(no_receipts_at_one_second, "current_consumer_is_held");
      Require(!gate_timed_out.load(), "gate_did_not_release_itself");
    } else {
      healthy_receipts = run.Wait(3, 1000) && run.Wait(4, 1000);
      Require(healthy_receipts, "healthy_stop_receipts");
    }
    receipt_wait_ms = GetTickCount64() - waiting;
    SetEvent(run.release.value);
    list_recovered = run.Wait(2, 15'000) && run.ProbeReply(2, MessageType::kProbeResult);
    cancel_recovered = run.Wait(3, 5000) && run.Receipt(3, MessageType::kDispatchResult, "canceled", 2);
    close_recovered = run.Wait(4, 5000) && run.Receipt(4, MessageType::kProbeResult, "closed", 3);
    Require(list_recovered && cancel_recovered && close_recovered, "receipts_after_release");
    Require(!wrong_measurement.load() && !gate_timed_out.load(), "owned_measurement_only");
    run.Cleanup();
    Require(run.child_exited && !run.watchdog_fired.load(), "cleanup_completed");
    std::cout << "{\"case\":\"" << (held ? "measure-held" : "healthy")
              << "\",\"gateEntered\":true,\"epochAdvanced\":true,\"epochMs\":" << epoch_ms
              << ",\"receiptWaitMs\":" << receipt_wait_ms
              << ",\"healthyReceipts\":" << (healthy_receipts ? "true" : "false")
              << ",\"noReceiptsAtOneSecond\":" << (no_receipts_at_one_second ? "true" : "false")
              << ",\"listRecovered\":true,\"cancelRecovered\":true,\"closeRecovered\":true"
              << ",\"inputAttempts\":0,\"childExited\":true,\"threadsJoined\":true,\"watchdogFired\":false}\n";
    return 0;
  } catch (const std::exception &error) {
    run.Cleanup();
    // Only fixed test assertion codes, never native error text, paths, titles, values or frames.
    std::cout << "{\"failure\":\"" << error.what() << "\"}\n";
    return 1;
  }
}
} // namespace

int wmain(int argc, wchar_t **argv) {
  if (argc == 4 && std::wstring_view(argv[1]) == L"fixture") return Fixture(argv[2], argv[3]);
  if (argc != 2) return 2;
  return Diagnose(std::wstring_view(argv[1]) == L"held");
}
`;

describe('Windows target I/O RCA seam source', () => {
  it('injects only one measure gate and enumerates only its own fixture', () => {
    const generated = instrumentedHost();
    expect(generated.split('  Sc940MeasureGate(pid);')).toHaveLength(2);
    expect(generated).not.toContain(enumeration);
    expect(generated).toContain(measurement);
    expect(program).toContain('ServePipe(server.value, BackendProbe{})');
    expect(program).not.toMatch(/#define\s+(?:CreateFileW|ReadFile|WriteFile|EnumWindows)\b/u);
  });
});

const build = compiler();
describe.skipIf(
  process.platform !== 'win32' || (build === null && process.env['CI'] === undefined),
)('Windows target I/O RCA live seam (#940, current unfixed boundary)', () => {
  it('separates a progressing Cancel reader from receipts queued behind measurement', async () => {
    expect(build, 'MSVC is required on Windows CI').not.toBeNull();
    const root = mkdtempSync(join(tmpdir(), 'computer-use-target-io-rca-'));
    try {
      const source = join(root, 'seam.cc');
      const binary = join(root, 'seam.exe');
      writeFileSync(join(root, 'instrumented-host.cc'), instrumentedHost());
      writeFileSync(source, program);
      const provenance = join(root, 'provenance.h');
      writeFileSync(
        provenance,
        '#pragma once\n#define SPRINT_CODER_SOURCE_COMMIT "0000000000000000000000000000000000000000"\n',
      );
      const command = build!.args([
        '/nologo',
        '/std:c++20',
        '/EHsc',
        '/W4',
        '/we4062',
        '/sdl',
        '/permissive-',
        '/utf-8',
        '/DUNICODE',
        '/D_UNICODE',
        '/DWIN32_LEAN_AND_MEAN',
        '/DNOMINMAX',
        '/D_WIN32_WINNT=0x0A00',
        '/DSPRINT_CODER_ELIGIBILITY_V2=1',
        `/FI${provenance}`,
        `/I${nativeDirectory}`,
        source,
        `/Fe:${binary}`,
        `/Fo:${binary}.obj`,
        '/link',
        '/DEBUG:NONE',
        'ole32.lib',
        'oleaut32.lib',
        'uiautomationcore.lib',
        'user32.lib',
        'dwmapi.lib',
        'd3d11.lib',
        'dxgi.lib',
        'windowscodecs.lib',
        'bcrypt.lib',
        'advapi32.lib',
        'userenv.lib',
        'crypt32.lib',
        'wintrust.lib',
        'shell32.lib',
        'runtimeobject.lib',
        'windowsapp.lib',
        'uuid.lib',
      ]);
      const compiled = await run(build!.file, command, 500_000, build!.verbatim);
      expect(compiled.timedOut, 'RCA seam compilation deadline').toBe(false);
      expect(compiled.status, 'RCA seam must compile with MSVC').toBe(0);
      for (const scenario of ['healthy', 'held']) {
        const result = await run(binary, [scenario], 70_000);
        expect(result.timedOut, `${scenario}: outer watchdog`).toBe(false);
        const failure = /^\{"failure":"([a-z_]+)"\}$/u.exec(result.stdout.trim())?.[1];
        expect(result.status, `${scenario}: ${failure ?? 'native RCA assertions'}`).toBe(0);
        const metadata: unknown = JSON.parse(result.stdout.trim());
        expect(metadata).toMatchObject({
          case: scenario === 'held' ? 'measure-held' : 'healthy',
          gateEntered: true,
          epochAdvanced: true,
          healthyReceipts: scenario === 'healthy',
          noReceiptsAtOneSecond: scenario === 'held',
          listRecovered: true,
          cancelRecovered: true,
          closeRecovered: true,
          inputAttempts: 0,
          childExited: true,
          threadsJoined: true,
          watchdogFired: false,
        });
        console.log(JSON.stringify(metadata));
      }
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    }
  }, 700_000);
});
