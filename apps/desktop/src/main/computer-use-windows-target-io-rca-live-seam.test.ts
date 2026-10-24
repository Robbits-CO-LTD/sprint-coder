import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// #940-1: the real ServePipe reader/consumer and real named-pipe framing. Held workers must not
// delay Stop/Close, publish stale results, or admit another synchronous target operation.
// Gates are injected only into generated test source; only our own fixture windows are enumerated.
const nativeDirectory = join(__dirname, '../../computer-use-native');
const host = readFileSync(join(nativeDirectory, 'computer_use_windows_host.cc'), 'utf8');
const measurement = '  out->measured = MeasureWindowsTargetFacts(pid, nullptr, context);';
const enumeration = 'EnumWindows(CollectWindowsV2TopLevel, reinterpret_cast<LPARAM>(&windows))';
const contextFactory =
  '  WindowsTargetFactsContext context = had_cached_context ? *cached : CurrentWindowsTargetFactsContext(';
const completion = '        // All measured handles and COM objects are gone';
const adoption =
  '    // Stop and adoption share this lock; a late result cannot advance the generation.';
const consumer =
  '    if (!HandlePipeRequest(pipe, probe, request, &handshaken, queued_stop_serial)) {';
const uiaContact =
  'WindowsV1UiaContact(root, [&] { return automation->ElementFromHandle(window, &root); });';

function replaceOnce(source: string, before: string, after: string): string {
  if (source.split(before).length !== 2) throw new Error('RCA seam source boundary changed');
  return source.replace(before, after);
}

function instrumentedHost(): string {
  let source = replaceOnce(
    replaceOnce(host, measurement, `  Sc940MeasureGate(pid);\n${measurement}`),
    enumeration,
    'Sc940EnumerateOwnedWindow(CollectWindowsV2TopLevel, reinterpret_cast<LPARAM>(&windows))',
  );
  source = replaceOnce(
    source,
    contextFactory,
    `  if (!had_cached_context) Sc940ContextGate();\n${contextFactory}`,
  );
  source = replaceOnce(source, completion, `        Sc940CompletionGate();\n${completion}`);
  source = replaceOnce(source, adoption, `    Sc940AdoptionGate();\n${adoption}`);
  source = replaceOnce(
    source,
    consumer,
    `    Sc940ConsumerGate(request.header.request_id.bytes[0]);\n${consumer}`,
  );
  const readFrom = source.indexOf('bool ReadUiaObservationOnWorker(');
  const readTo = source.indexOf('bool ReadUiaObservation(', readFrom);
  if (readFrom < 0 || readTo < 0) throw new Error('Observation worker boundary changed');
  source =
    source.slice(0, readFrom) +
    replaceOnce(
      replaceOnce(
        source.slice(readFrom, readTo),
        uiaContact,
        `WindowsV1UiaContact(root, [&] {
        if (!Sc820ContactGate(window)) return E_ABORT;
        const HRESULT result = automation->ElementFromHandle(window, &root);
        Sc820ContactResult(SUCCEEDED(result), root != nullptr);
        return result;
      });`,
      ),
      'if (root != nullptr) root->Release();',
      'if (root != nullptr) { root->Release(); Sc820RootReleased(); }',
    ) +
    source.slice(readTo);
  source = replaceOnce(
    source,
    '    if (operation == "read_node_value") {',
    `    if (operation == "sc820_read_probe") {
      try {
        return Respond(pipe, request, MessageType::kProbeResult,
                       Sc820ReadProbe(metadata, queued_stop_serial));
      } catch (...) {
        return Respond(pipe, request, MessageType::kError, ErrorPayload("sc820_probe_failed"));
      }
    }
    if (operation == "read_node_value") {`,
  );
  const from = source.indexOf('bool ValidateWindowsSession(\n');
  const to = source.indexOf('bool ReadExact(', from);
  if (from < 0 || to < 0) throw new Error('Session validation boundary changed');
  return (
    source.slice(0, from) +
    replaceOnce(
      source.slice(from, to),
      '  std::string current_start;',
      '  Sc940SyncSessionProbe();\n  std::string current_start;',
    ) +
    source.slice(to)
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
#include <optional>
#include <string>
namespace {
bool Sc820ContactGate(HWND window);
void Sc820ContactResult(bool succeeded, bool nonnull);
void Sc820RootReleased();
std::string Sc820ReadProbe(const std::string &metadata, std::optional<std::uint64_t> stop_serial);
void Sc940MeasureGate(std::uint32_t pid);
void Sc940ContextGate();
void Sc940CompletionGate();
void Sc940AdoptionGate();
void Sc940ConsumerGate(std::uint8_t request);
void Sc940SyncSessionProbe();
BOOL Sc940EnumerateOwnedWindow(WNDENUMPROC callback, LPARAM parameter);
}
#define wmain sc940_original_host_wmain
#include "instrumented-host.cc"
#undef wmain
#include <stdexcept>

namespace {
HANDLE gate_entered = nullptr;
HANDLE gate_release = nullptr;
HANDLE adoption_entered = nullptr;
std::array<DWORD, 2> fixture_pids{};
std::array<HWND, 2> fixture_windows{};
unsigned fixture_count = 0;
unsigned enumeration_count = 0;
DWORD held_measure_pid = 0;
enum class HoldPoint { kNone, kMeasure, kContext, kCompletion, kConsumer };
std::atomic<HoldPoint> hold_point{HoldPoint::kNone};
std::atomic<bool> hold_deadline_adoption{false};
std::atomic<bool> gate_timed_out{false};
std::atomic<bool> wrong_measurement{false};
std::atomic<unsigned> measurement_calls{0};
std::atomic<unsigned> context_factory_calls{0};
std::atomic<unsigned> synchronous_session_probes{0};
std::atomic<unsigned> uia_contacts{0};
std::atomic<unsigned> uia_completed_contacts{0};
std::atomic<unsigned> uia_successful_contacts{0};
std::atomic<unsigned> uia_nonnull_roots{0};
std::atomic<unsigned> uia_released_roots{0};
std::atomic<unsigned> uia_hold_contact{0};
std::atomic<ULONGLONG> uia_held_since{0};

void Require(bool condition, const char *reason) {
  if (!condition) throw std::runtime_error(reason);
}

void Sc940Gate(HoldPoint point) {
  if (hold_point.load() != point) return;
  SetEvent(gate_entered);
  if (WaitForSingleObject(gate_release, 20'000) != WAIT_OBJECT_0)
    gate_timed_out.store(true);
}

void Sc940MeasureGate(std::uint32_t pid) {
  if (std::find(fixture_pids.begin(), fixture_pids.begin() + fixture_count, pid) ==
      fixture_pids.begin() + fixture_count) {
    wrong_measurement.store(true);
    throw std::runtime_error("foreign_measurement");
  }
  measurement_calls.fetch_add(1);
  if (pid == held_measure_pid) Sc940Gate(HoldPoint::kMeasure);
}

void Sc940ContextGate() {
  context_factory_calls.fetch_add(1);
  Sc940Gate(HoldPoint::kContext);
}
void Sc940CompletionGate() { Sc940Gate(HoldPoint::kCompletion); }
void Sc940AdoptionGate() {
  if (!hold_deadline_adoption.load()) return;
  SetEvent(adoption_entered);
  if (WaitForSingleObject(gate_release, 20'000) != WAIT_OBJECT_0)
    gate_timed_out.store(true);
}
void Sc940ConsumerGate(std::uint8_t request) {
  if (request == 2) Sc940Gate(HoldPoint::kConsumer);
}
void Sc940SyncSessionProbe() { synchronous_session_probes.fetch_add(1); }

bool Sc820ContactGate(HWND window) {
  if (fixture_count != 1 || window != fixture_windows[0] || windows_uia_observation_pending == nullptr) {
    wrong_measurement.store(true);
    return false;
  }
  {
    std::lock_guard lock(windows_uia_observation_pending->mutex);
    if (!windows_uia_observation_pending->contact_active) {
      wrong_measurement.store(true);
      return false;
    }
  }
  const unsigned index = uia_contacts.fetch_add(1) + 1;
  if (index != uia_hold_contact.load()) return true;
  uia_held_since.store(GetTickCount64());
  SetEvent(gate_entered);
  if (WaitForSingleObject(gate_release, 20'000) != WAIT_OBJECT_0)
    gate_timed_out.store(true);
  return true;
}
void Sc820ContactResult(bool succeeded, bool nonnull) {
  uia_completed_contacts.fetch_add(1);
  if (succeeded) uia_successful_contacts.fetch_add(1);
  if (nonnull) uia_nonnull_roots.fetch_add(1);
}
void Sc820RootReleased() { uia_released_roots.fetch_add(1); }

const char *Sc820StopName(WindowsV1UiaStop stop) {
  switch (stop) {
  case WindowsV1UiaStop::kNone: return "none";
  case WindowsV1UiaStop::kTimeout: return "timeout";
  case WindowsV1UiaStop::kBudget: return "budget";
  case WindowsV1UiaStop::kCanceled: return "canceled";
  }
  return "invalid";
}

std::string Sc820ReadProbe(const std::string &metadata, std::optional<std::uint64_t> stop_serial) {
  std::string mode;
  ReadJsonString(metadata, "mode", &mode);
  const bool twice = mode == "twice" || mode == "deadline";
  const auto budget = mode == "deadline" ? std::chrono::milliseconds(1500) : kWindowsV1UiaObserveBudget;
  const auto started = std::chrono::steady_clock::now();
  // The seeded control session's epoch, as an actual observe would use, not a refreshed epoch.
  const WindowsV1UiaPath path(budget, 1, stop_serial);
  // Existing diagnostic work in the outer scope; this is not a node limit.
  const std::size_t initial_nodes = twice ? 17 : 0;
  for (std::size_t index = 0; index < initial_nodes; ++index) WindowsV1UiaCountNode();
  std::string tree;
  std::size_t first_nodes = 0, second_nodes = 0;
  const bool first = ReadUiaObservation(fixture_pids[0], fixture_windows[0], &tree, &first_nodes);
  const bool first_empty = tree.empty();
  ScrubString(&tree);
  bool second = false;
  if (twice && first && path.Stop() == WindowsV1UiaStop::kNone) {
    if (mode == "deadline") {
      // Leave about 150 ms of the SAME outer deadline for the second real contact.
      Require(std::chrono::steady_clock::now() - started < std::chrono::milliseconds(1200),
              "uia_first_read_within_test_budget");
      std::this_thread::sleep_until(started + std::chrono::milliseconds(1350));
    }
    second = ReadUiaObservation(fixture_pids[0], fixture_windows[0], &tree, &second_nodes);
  }
  const bool empty = twice ? tree.empty() : first_empty;
  ScrubString(&tree);
  return "{\"firstOk\":" + std::string(first ? "true" : "false") +
      ",\"secondOk\":" + (second ? "true" : "false") +
      ",\"firstNodes\":" + std::to_string(first_nodes) + ",\"secondNodes\":" + std::to_string(second_nodes) +
      ",\"initialNodes\":" + std::to_string(initial_nodes) + ",\"outerNodes\":" + std::to_string(path.Nodes()) +
      ",\"stop\":\"" + Sc820StopName(path.Stop()) + "\",\"treeEmpty\":" + (empty ? "true" : "false") + "}";
}

BOOL Sc940EnumerateOwnedWindow(WNDENUMPROC callback, LPARAM parameter) {
  if (enumeration_count == 0 || enumeration_count > fixture_count) return FALSE;
  for (unsigned index = 0; index < enumeration_count; ++index) {
    DWORD owner = 0;
    if (!IsWindow(fixture_windows[index]) ||
        GetWindowThreadProcessId(fixture_windows[index], &owner) == 0 || owner != fixture_pids[index] ||
        callback(fixture_windows[index], parameter) == FALSE)
      return FALSE;
  }
  return TRUE;
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

struct UiaReadResult {
  bool first = false;
  bool second = false;
  bool empty = false;
  std::uint64_t first_nodes = 0;
  std::uint64_t second_nodes = 0;
  std::uint64_t initial_nodes = 0;
  std::uint64_t outer_nodes = 0;
  std::string stop;
};

struct RcaRun {
  ScopedKernelHandle entered{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  ScopedKernelHandle release{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  ScopedKernelHandle adopting{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  ScopedKernelHandle finished{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  ScopedKernelHandle job;
  std::array<ScopedKernelHandle, 2> children;
  ScopedKernelHandle server{INVALID_HANDLE_VALUE};
  ScopedKernelHandle client{INVALID_HANDLE_VALUE};
  std::thread serving;
  std::thread receiving;
  std::thread watchdog;
  std::mutex replies_mutex;
  std::condition_variable replies_ready;
  std::unordered_map<unsigned, Frame> replies;
  std::unordered_map<unsigned, unsigned> reply_counts;
  std::atomic<bool> watchdog_fired{false};
  std::atomic<bool> serve_ok{false};
  bool cleaned = false;
  bool child_exited = false;
  bool worker_idle = false;

  RcaRun() {
    Require(entered.value && release.value && adopting.value && finished.value, "event_creation");
    gate_entered = entered.value;
    gate_release = release.value;
    adoption_entered = adopting.value;
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
    Require(fixture_count < children.size(), "fixture_limit");
    const unsigned index = fixture_count;
    ScopedKernelHandle &child = children[index];
    const std::wstring suffix = std::to_wstring(GetCurrentProcessId()) + L"-" +
                                std::to_wstring(GetTickCount64()) + L"-" + std::to_wstring(index);
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
    fixture_pids[index] = found.pid;
    fixture_windows[index] = reinterpret_cast<HWND>(found.window);
    ++fixture_count;
    enumeration_count = fixture_count;
    Require(WaitForSingleObject(child.value, 0) == WAIT_TIMEOUT, "fixture_stays_alive");
  }

  void StartPipe(bool same_epoch_close) {
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
    session.has_observation = true;
    session.observation_revision = 1;
    sessions.emplace(FrameIdKey(Id(7)), std::move(session));
    // The close-only same-epoch case proves max(cancelEpoch) is not an invalidation serial.
    cancellation_epoch.store(same_epoch_close ? 2 : 1);
    windows_v2_main_pid = GetCurrentProcessId();
    serving = std::thread([this] {
      const HRESULT apartment = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
      if (SUCCEEDED(apartment)) {
        // Match ServeMain's client-side warmup before accepting any target operation.
        WarmWindowsV1Automation();
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
          ++reply_counts[frame.header.request_id.bytes[0]];
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

  bool Error(unsigned id, std::string_view code) {
    std::lock_guard<std::mutex> lock(replies_mutex);
    const auto found = replies.find(id);
    if (found == replies.end()) return false;
    const Frame &frame = found->second;
    const std::string body(frame.metadata.begin(), frame.metadata.end());
    std::string actual;
    bool accepted = true;
    return frame.header.message_type == static_cast<std::uint16_t>(MessageType::kError) &&
           frame.header.request_id.bytes == Id(static_cast<std::uint8_t>(id)).bytes &&
           frame.header.session_id.bytes == Id(7).bytes && frame.binary.empty() &&
           ReadJsonString(body, "code", &actual) && actual == code &&
           ReadOptionalJsonBoolean(body, "accepted", &accepted) && !accepted;
  }

  bool ListTargets(unsigned id, std::uint64_t *generation, std::string *rows, bool *truncated) {
    std::lock_guard<std::mutex> lock(replies_mutex);
    const auto found = replies.find(id);
    if (found == replies.end()) return false;
    const Frame &frame = found->second;
    const std::string body(frame.metadata.begin(), frame.metadata.end());
    const std::string_view prefix = "\"targets\":[";
    const std::size_t begin = body.find(prefix);
    if (frame.header.message_type != static_cast<std::uint16_t>(MessageType::kProbeResult) ||
        frame.header.request_id.bytes != Id(static_cast<std::uint8_t>(id)).bytes ||
        frame.header.session_id.bytes != Id(7).bytes || !frame.binary.empty() ||
        body.size() > kMaxMetadataBytes || begin == std::string::npos || !body.ends_with("]}") ||
        !ReadJsonUint64(body, "generation", generation) ||
        !ReadOptionalJsonBoolean(body, "truncated", truncated))
      return false;
    *rows = body.substr(begin + prefix.size(), body.size() - begin - prefix.size() - 2);
    return true;
  }

  bool PreflightDenied(unsigned id) {
    std::lock_guard<std::mutex> lock(replies_mutex);
    const auto found = replies.find(id);
    if (found == replies.end()) return false;
    const Frame &frame = found->second;
    const std::string body(frame.metadata.begin(), frame.metadata.end());
    std::string decision, reason;
    std::uint64_t attempts = 1;
    return frame.header.message_type == static_cast<std::uint16_t>(MessageType::kPreflightResult) &&
           frame.header.request_id.bytes == Id(static_cast<std::uint8_t>(id)).bytes &&
           frame.header.session_id.bytes == Id(7).bytes && frame.binary.empty() &&
           ReadJsonString(body, "decision", &decision) && decision == "denied" &&
           ReadJsonString(body, "reasonCode", &reason) && reason == "native_session_identity_changed" &&
           ReadJsonUint64(body, "inputAttemptCount", &attempts) && attempts == 0 &&
           body.find("\"ticket\":null") != std::string::npos;
  }

  bool WaitWorkerIdle(DWORD milliseconds) {
    const ULONGLONG deadline = GetTickCount64() + milliseconds;
    while (WindowsTargetListWorkerRunning().load(std::memory_order_acquire) && GetTickCount64() < deadline)
      Sleep(1);
    return !WindowsTargetListWorkerRunning().load(std::memory_order_acquire);
  }

  bool WaitUiaWorkerIdle(DWORD milliseconds) {
    const ULONGLONG deadline = GetTickCount64() + milliseconds;
    while (WindowsUiaObservationWorkerRunning().load(std::memory_order_acquire) && GetTickCount64() < deadline)
      Sleep(1);
    return !WindowsUiaObservationWorkerRunning().load(std::memory_order_acquire);
  }

  unsigned ReplyCount(unsigned id) {
    std::lock_guard lock(replies_mutex);
    return reply_counts[id];
  }

  bool UiaReply(unsigned id, UiaReadResult *output) {
    std::lock_guard lock(replies_mutex);
    const auto found = replies.find(id);
    if (found == replies.end()) return false;
    const Frame &frame = found->second;
    const std::string body(frame.metadata.begin(), frame.metadata.end());
    return frame.header.message_type == static_cast<std::uint16_t>(MessageType::kProbeResult) &&
           frame.header.request_id.bytes == Id(static_cast<std::uint8_t>(id)).bytes &&
           frame.header.session_id.bytes == Id(7).bytes && frame.binary.empty() && body.size() < 512 &&
           ReadOptionalJsonBoolean(body, "firstOk", &output->first) &&
           ReadOptionalJsonBoolean(body, "secondOk", &output->second) &&
           ReadOptionalJsonBoolean(body, "treeEmpty", &output->empty) &&
           ReadJsonUint64(body, "firstNodes", &output->first_nodes) &&
           ReadJsonUint64(body, "secondNodes", &output->second_nodes) &&
           ReadJsonUint64(body, "initialNodes", &output->initial_nodes) &&
           ReadJsonUint64(body, "outerNodes", &output->outer_nodes) &&
           ReadJsonString(body, "stop", &output->stop);
  }

  void Cleanup() {
    if (cleaned) return;
    cleaned = true;
    SetEvent(release.value);
    if (client.value != INVALID_HANDLE_VALUE) CancelIoEx(client.value, nullptr);
    if (server.value != INVALID_HANDLE_VALUE) { CancelIoEx(server.value, nullptr); DisconnectNamedPipe(server.value); }
    if (serving.joinable()) serving.join();
    if (receiving.joinable()) receiving.join();
    // The detached production worker must release its slot/resources before our fixture is killed.
    worker_idle = WaitWorkerIdle(15'000);
    worker_idle = WaitUiaWorkerIdle(15'000) && worker_idle;
    if (job.value != nullptr) TerminateJobObject(job.value, 0);
    child_exited = true;
    for (auto &child : children)
      if (child.value != nullptr) {
        if (WaitForSingleObject(child.value, 0) == WAIT_TIMEOUT) TerminateProcess(child.value, 0);
        child_exited = WaitForSingleObject(child.value, 5000) == WAIT_OBJECT_0 && child_exited;
      }
    for (auto &entry : sessions) ReleaseWindowsSessionResources(&entry.second);
    sessions.clear();
    SetEvent(finished.value);
    if (watchdog.joinable()) watchdog.join();
  }
  ~RcaRun() { Cleanup(); }
};

bool WaitStopSerial(std::uint64_t before, DWORD milliseconds) {
  const ULONGLONG deadline = GetTickCount64() + milliseconds;
  while (WindowsTargetListControl().stop_serial.load(std::memory_order_acquire) == before &&
         GetTickCount64() < deadline)
    Sleep(1);
  return WindowsTargetListControl().stop_serial.load(std::memory_order_acquire) != before;
}

void AssertBusyRefusals(RcaRun &run) {
  const unsigned measured = measurement_calls.load();
  run.Send(MessageType::kProbe, 5, "{\"operation\":\"list_targets\"}");
  Require(run.Wait(5, 1000) && run.Error(5, "list_targets_unavailable"), "busy_list_refused");
  run.Send(MessageType::kProbe, 6, "{\"operation\":\"start_session\"}");
  Require(run.Wait(6, 1000) && run.Error(6, "session_target_rejected"), "busy_start_refused");
  WindowsSession unmeasured;
  RECT bounds{};
  std::string reason;
  Require(!ValidateWindowsSession(unmeasured, &bounds, &reason) && reason == "session_identity_changed",
          "busy_validation_refused");
  const std::string preflight = "{\"requestId\":\"busy-preflight\",\"actionDigest\":\"" +
      std::string(64, 'a') + "\",\"cancelEpoch\":1,\"observationRevision\":1,\"type\":\"invoke\",\"targetId\":\"fixture\"}";
  run.Send(MessageType::kPreflight, 8, preflight);
  Require(run.Wait(8, 1000) && run.PreflightDenied(8), "busy_preflight_refused");
  run.Send(MessageType::kProbe, 9, "{\"operation\":\"pick_application\"}");
  Require(run.Wait(9, 1000) && run.Error(9, "picker_unavailable"), "busy_picker_refused");
  run.Send(MessageType::kProbe, 10, "{\"operation\":\"list_windows\"}");
  Require(run.Wait(10, 1000) && run.Error(10, "profile_identity_invalid"), "busy_windows_refused");
  Require(measurement_calls.load() == measured && synchronous_session_probes.load() == 0,
          "busy_paths_read_no_target");
  Require(WindowsTargetListWorkerRunning().load(), "busy_worker_slot_retained");
}

bool HasContextCandidate() {
  auto &control = WindowsTargetListControl();
  std::lock_guard lock(control.stop_mutex);
  return control.context_candidate != nullptr;
}

int DiagnoseUia(std::wstring_view scenario) {
  const bool timeout = scenario == L"uia-contact-timeout";
  const bool cancel = scenario == L"uia-cancel";
  const bool close = scenario == L"uia-close";
  const bool queued = scenario == L"uia-prequeued-close";
  const bool twice = scenario == L"uia-two-reads";
  const bool deadline = scenario == L"uia-shared-deadline";
  const char *label = timeout ? "uia-contact-timeout" : cancel ? "uia-cancel" : close ? "uia-close" :
      queued ? "uia-prequeued-close" : twice ? "uia-two-reads" : "uia-shared-deadline";
  RcaRun run;
  ULONGLONG response_ms = 0, stop_ms = 0;
  try {
    run.StartFixture();
    run.StartPipe(false);
    run.Send(MessageType::kHandshake, 1, "{\"protocolVersion\":1,\"apiVersion\":2}");
    Require(run.Wait(1, 5000) && run.ProbeReply(1, MessageType::kHandshakeResult), "uia_handshake");
    uia_hold_contact.store(deadline ? 2 : timeout || cancel || close ? 1 : 0);
    hold_point.store(queued ? HoldPoint::kConsumer : HoldPoint::kNone);
    const std::string mode = twice ? "twice" : deadline ? "deadline" : "single";
    const ULONGLONG started = GetTickCount64();
    run.Send(MessageType::kProbe, 2, "{\"operation\":\"sc820_read_probe\",\"mode\":\"" + mode + "\"}");
    bool stopped = false;
    const auto stop_control = [&](bool cancel_first, bool release_consumer) {
      const std::uint64_t before = WindowsTargetListControl().stop_serial.load();
      const ULONGLONG sent = GetTickCount64();
      if (cancel_first)
        run.Send(MessageType::kCancel, 3, "{\"cancelEpoch\":2}");
      else
        run.Send(MessageType::kProbe, 4, "{\"operation\":\"close_session\",\"cancelEpoch\":2}");
      Require(WaitStopSerial(before, 1000), "uia_stop_reader_progress");
      if (release_consumer) {
        Require(!WindowsUiaObservationWorkerRunning().load() && uia_contacts.load() == 0 &&
                    cancellation_epoch.load() == 1,
                "uia_prequeued_stop_before_worker");
        hold_point.store(HoldPoint::kNone);
        SetEvent(run.release.value);
      }
      if (cancel_first) {
        Require(run.Wait(3, 1000) && run.Receipt(3, MessageType::kDispatchResult, "canceled", 2),
                "uia_cancel_receipt");
        // Cancel alone must free the consumer; Close cannot mask a missed cancellation.
        run.Send(MessageType::kProbe, 4, "{\"operation\":\"close_session\",\"cancelEpoch\":3}");
      }
      Require(run.Wait(4, 1000) && run.Receipt(4, MessageType::kProbeResult, "closed", cancel_first ? 3 : 2),
              "uia_close_receipt");
      stop_ms = GetTickCount64() - sent;
      Require(stop_ms < 1000, "uia_stop_ack_budget");
      stopped = true;
    };
    if (!twice) {
      Require(WaitForSingleObject(run.entered.value, 5000) == WAIT_OBJECT_0, "uia_gate_entered");
      Require(WaitForSingleObject(run.release.value, 0) == WAIT_TIMEOUT, "uia_gate_held");
      Require(WindowsUiaObservationWorkerRunning().load() == !queued, "uia_worker_ownership");
    }
    if (cancel || close || queued) stop_control(cancel, queued);
    UiaReadResult result;
    Require(run.Wait(2, twice ? 7000 : 1000) && run.UiaReply(2, &result), "uia_read_response");
    response_ms = GetTickCount64() - started;
    if (twice) {
      Require(result.first && result.second && result.stop == "none" && result.first_nodes > 0 &&
                  result.second_nodes > 0 && result.initial_nodes == 17 &&
                  result.outer_nodes == 17 + result.first_nodes + result.second_nodes,
              "uia_outer_nodes_accumulate_once");
    } else if (deadline) {
      Require(result.first && !result.second && result.empty && result.stop == "budget" &&
                  result.first_nodes > 0 && result.second_nodes == 0 &&
                  result.outer_nodes == 17 + result.first_nodes && response_ms >= 1450 &&
                  response_ms < 2200 && GetTickCount64() - uia_held_since.load() <
                      static_cast<ULONGLONG>(kWindowsV1UiaSlowContact.count()),
              "uia_second_read_uses_remaining_outer_deadline");
    } else {
      Require(!result.first && result.empty && result.first_nodes == 0 && result.outer_nodes == 0 &&
                  result.stop == (timeout ? "timeout" : "canceled"), "uia_outer_stop_propagated");
      if (timeout)
        Require(response_ms >= static_cast<ULONGLONG>(kWindowsV1UiaSlowContact.count()) &&
                    GetTickCount64() - uia_held_since.load() < 1000, "uia_contact_deadline_bounded");
    }
    if (queued) {
      Require(uia_contacts.load() == 0 && !WindowsUiaObservationWorkerRunning().load(),
              "uia_prequeued_close_created_no_worker");
    } else if (!twice) {
      Require(WindowsUiaObservationWorkerRunning().load() &&
                  WaitForSingleObject(run.release.value, 0) == WAIT_TIMEOUT &&
                  WaitForSingleObject(run.children[0].value, 0) == WAIT_TIMEOUT,
              "uia_response_precedes_gate_release");
      if (timeout) {
        const unsigned before = uia_contacts.load();
        run.Send(MessageType::kProbe, 6, "{\"operation\":\"sc820_read_probe\",\"mode\":\"single\"}");
        UiaReadResult busy;
        Require(run.Wait(6, 1000) && run.UiaReply(6, &busy) && !busy.first && busy.empty &&
                    busy.first_nodes == 0 && uia_contacts.load() == before &&
                    WindowsUiaObservationWorkerRunning().load(), "uia_busy_read_does_not_spawn");
      }
      uia_hold_contact.store(0);
      SetEvent(run.release.value);
    }
    Require(run.WaitUiaWorkerIdle(15'000), "uia_late_worker_drained");
    const unsigned completed = queued ? 0 : twice || deadline ? 2 : 1;
    Require(uia_contacts.load() == completed && uia_completed_contacts.load() == completed &&
                uia_successful_contacts.load() == completed && uia_nonnull_roots.load() == completed &&
                uia_released_roots.load() == completed, "uia_real_contact_and_root_cleanup");
    UiaReadResult after;
    Require(run.ReplyCount(2) == 1 && run.UiaReply(2, &after) && after.first == result.first &&
                after.second == result.second && after.outer_nodes == result.outer_nodes && after.stop == result.stop,
            "uia_late_result_not_published");
    if (timeout) {
      run.Send(MessageType::kProbe, 20, "{\"operation\":\"sc820_read_probe\",\"mode\":\"single\"}");
      UiaReadResult fresh;
      Require(run.Wait(20, 7000) && run.UiaReply(20, &fresh) && fresh.first && !fresh.empty &&
                  fresh.stop == "none" && fresh.first_nodes > 0 && fresh.outer_nodes == fresh.first_nodes &&
                  run.WaitUiaWorkerIdle(1000) && uia_contacts.load() == completed + 1 &&
                  uia_released_roots.load() == completed + 1, "uia_explicit_retry_recovers");
    }
    if (!stopped) stop_control(true, false);
    Require(!wrong_measurement.load() && !gate_timed_out.load(), "uia_owned_contact_only");
    run.Cleanup();
    Require(run.child_exited && run.worker_idle && !run.watchdog_fired.load(), "uia_cleanup_completed");
    std::cout << "{\"case\":\"" << label << "\",\"responseMs\":" << response_ms << ",\"stopMs\":" << stop_ms
              << ",\"outerStop\":\"" << result.stop << "\",\"outerNodes\":" << result.outer_nodes
              << ",\"lateResultDiscarded\":true,\"realContactCleanup\":true,\"inputAttempts\":0"
              << ",\"childExited\":true,\"threadsJoined\":true,\"workerIdle\":true,\"watchdogFired\":false}\n";
    return 0;
  } catch (const std::exception &error) {
    run.Cleanup();
    std::cout << "{\"failure\":\"" << error.what() << "\"}\n";
    return 1;
  }
}

int Diagnose(std::wstring_view scenario) {
  const bool healthy = scenario == L"healthy";
  const bool deadline = scenario == L"deadline";
  const bool deadline_race = scenario == L"deadline-stop-race";
  const bool two_fixtures = deadline || deadline_race;
  const bool cold_deadline = scenario == L"cold-context-deadline";
  const bool context = scenario == L"context-cancel" || cold_deadline;
  const bool queued = scenario == L"queued-stop";
  const bool completion_race = scenario == L"completion-race";
  const bool same_epoch_close = scenario == L"measure-same-epoch-close";
  const bool close_only = scenario == L"measure-close" || same_epoch_close;
  const char *label = healthy ? "healthy" : deadline ? "deadline" :
      deadline_race ? "deadline-stop-race" : cold_deadline ? "cold-context-deadline" :
      context ? "context-cancel" : queued ? "queued-stop" : completion_race ? "completion-race" :
      same_epoch_close ? "measure-same-epoch-close" : close_only ? "measure-close" : "measure-cancel";
  RcaRun run;
  ULONGLONG stop_ms = 0, list_ms = 0;
  bool busy_checked = false;
  bool generation_unchanged = false;
  bool partial_preserved = false;
  bool cold_context_reused = false;
  try {
    run.StartFixture();
    if (two_fixtures) run.StartFixture();
    run.StartPipe(same_epoch_close);
    run.Send(MessageType::kHandshake, 1, "{\"protocolVersion\":1,\"apiVersion\":2}");
    Require(run.Wait(1, 5000) && run.ProbeReply(1, MessageType::kHandshakeResult), "handshake");
    Require(!WindowsV2FactsContextCache().has_value(), "initial_context_empty");
    std::string completed_row;
    if (two_fixtures) {
      // A's real row is the control. No verdict or eligibility is invented for our own child.
      enumeration_count = 1;
      hold_point.store(HoldPoint::kNone);
      run.Send(MessageType::kProbe, 30, "{\"operation\":\"list_targets\"}");
      std::uint64_t baseline_generation = 0;
      bool truncated = true;
      Require(run.Wait(30, 7000) && run.ListTargets(30, &baseline_generation, &completed_row, &truncated) &&
                  !truncated && !completed_row.empty(), "completed_fixture_baseline");
      Require(run.WaitWorkerIdle(1000) && WindowsV2FactsContextCache().has_value() &&
                  measurement_calls.load() == 1, "baseline_context_committed");
      enumeration_count = 2;
    }
    held_measure_pid = fixture_pids[two_fixtures ? 1 : 0];
    hold_point.store(healthy ? HoldPoint::kNone : context ? HoldPoint::kContext :
                     queued ? HoldPoint::kConsumer : completion_race ? HoldPoint::kCompletion : HoldPoint::kMeasure);
    hold_deadline_adoption.store(deadline_race);
    const std::uint64_t generation_before = windows_v2_list_generation;
    const ULONGLONG list_started = GetTickCount64();
    run.Send(MessageType::kProbe, 2, "{\"operation\":\"list_targets\"}");
    ULONGLONG gate_started = 0;
    if (healthy) {
      Require(run.Wait(2, 7000) && run.ProbeReply(2, MessageType::kProbeResult), "healthy_list");
      Require(run.WaitWorkerIdle(1000), "healthy_worker_idle");
      Require(measurement_calls.load() == 1 && WindowsV2FactsContextCache().has_value(), "healthy_context_committed");
      Require(windows_v2_list_generation == generation_before + 1, "healthy_generation_committed");
    } else {
      Require(WaitForSingleObject(run.entered.value, 15'000) == WAIT_OBJECT_0, "fault_gate_entered");
      gate_started = GetTickCount64();
      Require(WaitForSingleObject(run.release.value, 0) == WAIT_TIMEOUT, "fault_gate_stays_closed");
      Require(WindowsTargetListWorkerRunning().load() == !queued, "worker_ownership_at_gate");
    }
    if (deadline) {
      std::uint64_t partial_generation = 0;
      std::string partial_rows;
      bool truncated = false;
      Require(run.Wait(2, static_cast<DWORD>(kWindowsListTargetsBudgetMs + 1000)) &&
                  run.ListTargets(2, &partial_generation, &partial_rows, &truncated), "deadline_partial_list");
      list_ms = GetTickCount64() - list_started;
      Require(list_ms >= kWindowsListTargetsBudgetMs && list_ms <= kWindowsListTargetsBudgetMs + 1500,
              "deadline_bounded");
      Require(truncated && partial_generation == generation_before + 1 &&
                  partial_rows == completed_row + "," + std::string(kWindowsV2UnresolvableRow) &&
                  measurement_calls.load() == 3, "completed_row_preserved_unfinished_anonymous");
      partial_preserved = true;
      Require(WindowsTargetListWorkerRunning().load(), "deadline_keeps_the_worker_slot");
      AssertBusyRefusals(run);
      busy_checked = true;
    } else if (deadline_race) {
      // B remains held. Stop wins after the consumer's deadline but before its adoption lock.
      Require(WaitForSingleObject(run.adopting.value, static_cast<DWORD>(kWindowsListTargetsBudgetMs + 1000)) ==
                  WAIT_OBJECT_0, "deadline_adoption_gate_entered");
      list_ms = GetTickCount64() - list_started;
      Require(list_ms >= kWindowsListTargetsBudgetMs && !run.Wait(2, 0) &&
                  WindowsTargetListWorkerRunning().load() &&
                  WaitForSingleObject(run.release.value, 0) == WAIT_TIMEOUT, "deadline_adoption_still_held");
    } else if (cold_deadline) {
      Require(run.Wait(2, static_cast<DWORD>(kWindowsListTargetsBudgetMs + 1000)) &&
                  run.Error(2, "list_targets_unavailable"), "cold_context_initial_deadline");
      list_ms = GetTickCount64() - list_started;
      Require(list_ms >= kWindowsListTargetsBudgetMs && list_ms <= kWindowsListTargetsBudgetMs + 1500 &&
                  windows_v2_list_generation == generation_before && !WindowsV2FactsContextCache().has_value() &&
                  context_factory_calls.load() == 1 && measurement_calls.load() == 0,
              "cold_context_initial_unadopted");
      generation_unchanged = true;
      // The context itself takes more than six seconds, with no Stop and no second worker.
      while (GetTickCount64() < gate_started + 7000) Sleep(10);
      Require(WindowsTargetListWorkerRunning().load() && !HasContextCandidate(), "cold_context_keeps_single_worker");
      hold_point.store(HoldPoint::kNone);
      SetEvent(run.release.value);
      Require(run.WaitWorkerIdle(15'000) && !WindowsV2FactsContextCache().has_value() &&
                  HasContextCandidate() && windows_v2_list_generation == generation_before &&
                  context_factory_calls.load() == 1 && measurement_calls.load() == 0,
              "late_context_is_candidate_only");
      run.Send(MessageType::kProbe, 20, "{\"operation\":\"list_targets\"}");
      Require(run.Wait(20, 7000) && run.ProbeReply(20, MessageType::kProbeResult) && run.WaitWorkerIdle(1000) &&
                  WindowsV2FactsContextCache().has_value() && !HasContextCandidate() &&
                  context_factory_calls.load() == 1 && windows_v2_list_generation == generation_before + 1,
              "explicit_retry_reuses_late_context");
      cold_context_reused = true;
    }
    for (const auto &child : run.children)
      if (child.value != nullptr)
        Require(WaitForSingleObject(child.value, 0) == WAIT_TIMEOUT, "fixture_alive_before_stop");
    const std::uint64_t serial_before = WindowsTargetListControl().stop_serial.load();
    const ULONGLONG stop_started = GetTickCount64();
    const std::uint64_t close_epoch = close_only ? 2 : 3;
    if (close_only) {
      run.Send(MessageType::kProbe, 4, "{\"operation\":\"close_session\",\"cancelEpoch\":2}");
      Require(WaitStopSerial(serial_before, 1000), "close_reader_invalidated");
    } else {
      run.Send(MessageType::kCancel, 3, "{\"cancelEpoch\":2}");
      Require(WaitStopSerial(serial_before, 1000), "cancel_reader_invalidated");
      run.Send(MessageType::kProbe, 4, "{\"operation\":\"close_session\",\"cancelEpoch\":3}");
    }
    if (queued) {
      Require(!WindowsTargetListWorkerRunning().load() && measurement_calls.load() == 0,
              "queued_stop_has_no_worker");
    }
    if (queued || deadline_race) {
      hold_point.store(HoldPoint::kNone);
      hold_deadline_adoption.store(false);
      SetEvent(run.release.value);
    }
    if (!close_only)
      Require(run.Wait(3, 1000) && run.Receipt(3, MessageType::kDispatchResult, "canceled", 2),
              "cancel_receipt_within_budget");
    Require(run.Wait(4, 1000) && run.Receipt(4, MessageType::kProbeResult, "closed", close_epoch),
            "close_receipt_within_budget");
    stop_ms = GetTickCount64() - stop_started;
    Require(stop_ms < 1000, "stop_receipts_within_ack_budget");
    Require(cancellation_epoch.load() >= 2, "stop_reader_epoch_advanced");
    if (same_epoch_close) Require(cancellation_epoch.load() == 2, "same_epoch_close_used_stop_serial");
    if (scenario == L"measure-close") {
      const auto replay_serial = WindowsTargetListControl().stop_serial.load();
      run.Send(MessageType::kProbe, 21, "{\"operation\":\"close_session\",\"cancelEpoch\":3}");
      Require(run.Wait(21, 1000) && run.Receipt(21, MessageType::kProbeResult, "closed", 3),
              "close_resend_receipt");
      const auto closed = closed_sessions.find(FrameIdKey(Id(7)));
      Require(WindowsTargetListControl().stop_serial.load() > replay_serial &&
                  cancellation_epoch.load() == 2 && last_closed_cancel_epoch == 2 &&
                  closed != closed_sessions.end() && closed->second.cancel_epoch == 3,
              "close_resend_preserves_fresh_epoch_zero_start_condition");
    }
    if (!healthy && !cold_deadline) {
      if (!deadline)
        Require(run.Wait(2, 1000) && run.Error(2, "list_targets_unavailable"), "stopped_list_refused");
      const std::uint64_t expected_generation = generation_before + (deadline ? 1 : 0);
      generation_unchanged = !deadline && windows_v2_list_generation == generation_before;
      Require(windows_v2_list_generation == expected_generation &&
                  WindowsV2FactsContextCache().has_value() == two_fixtures && !HasContextCandidate(),
              "stop_does_not_adopt_late_result");
      if (!queued && !deadline_race) {
        Require(WaitForSingleObject(run.release.value, 0) == WAIT_TIMEOUT && WindowsTargetListWorkerRunning().load(),
                "receipts_precede_worker_release");
      }
      hold_point.store(HoldPoint::kNone);
      SetEvent(run.release.value);
      Require(run.WaitWorkerIdle(15'000), "abandoned_worker_drained");
      Require(windows_v2_list_generation == expected_generation &&
                  WindowsV2FactsContextCache().has_value() == two_fixtures && !HasContextCandidate(),
              "late_result_and_context_discarded");
      if (queued || context) Require(measurement_calls.load() == 0, "stopped_before_measurement");
      run.Send(MessageType::kProbe, 20, "{\"operation\":\"list_targets\"}");
      Require(run.Wait(20, 7000) && run.ProbeReply(20, MessageType::kProbeResult), "fresh_list_recovers");
      Require(run.WaitWorkerIdle(1000) && WindowsV2FactsContextCache().has_value() &&
                  windows_v2_list_generation == expected_generation + 1, "fresh_candidate_committed_once");
      if (context) Require(context_factory_calls.load() == 2, "canceled_context_is_measured_again");
    }
    Require(!wrong_measurement.load() && !gate_timed_out.load(), "owned_measurement_only");
    run.Cleanup();
    Require(run.child_exited && run.worker_idle && !run.watchdog_fired.load(), "cleanup_completed");
    std::cout << "{\"case\":\"" << label << "\",\"stopSerialAdvanced\":true,\"stopMs\":" << stop_ms
              << ",\"listMs\":" << list_ms << ",\"busyChecked\":" << (busy_checked ? "true" : "false")
              << ",\"generationUnchangedOnRefusal\":" << (generation_unchanged ? "true" : "false")
              << ",\"partialPreserved\":" << (partial_preserved ? "true" : "false")
              << ",\"coldContextReused\":" << (cold_context_reused ? "true" : "false")
              << ",\"fixtureCount\":" << fixture_count
              << ",\"closeReplayChecked\":" << (scenario == L"measure-close" ? "true" : "false")
              << ",\"recovered\":true,\"inputAttempts\":0,\"childExited\":true,\"threadsJoined\":true"
              << ",\"workerIdle\":true,\"watchdogFired\":false}\n";
    return 0;
  } catch (const std::exception &error) {
    run.Cleanup();
    std::cout << "{\"failure\":\"" << error.what() << "\"}\n";
    return 1;
  }
}
} // namespace

int wmain(int argc, wchar_t **argv) {
  if (argc == 4 && std::wstring_view(argv[1]) == L"fixture") return Fixture(argv[2], argv[3]);
  if (argc != 2) return 2;
  if (std::wstring_view(argv[1]).starts_with(L"uia-")) return DiagnoseUia(argv[1]);
  return Diagnose(argv[1]);
}
`;

describe('Windows target I/O RCA seam source', () => {
  it('injects bounded phase gates and enumerates only its own fixture', () => {
    const generated = instrumentedHost();
    expect(generated.split('  Sc940MeasureGate(pid);')).toHaveLength(2);
    expect(generated).not.toContain(enumeration);
    expect(generated).toContain(measurement);
    expect(generated.split('  if (!had_cached_context) Sc940ContextGate();')).toHaveLength(2);
    expect(generated.split('        Sc940CompletionGate();')).toHaveLength(2);
    expect(generated.split('    Sc940AdoptionGate();')).toHaveLength(2);
    expect(
      generated.split('    Sc940ConsumerGate(request.header.request_id.bytes[0]);'),
    ).toHaveLength(2);
    expect(generated.split('  Sc940SyncSessionProbe();')).toHaveLength(2);
    expect(generated.split('if (!Sc820ContactGate(window)) return E_ABORT;')).toHaveLength(2);
    expect(generated.split('root->Release(); Sc820RootReleased();')).toHaveLength(2);
    expect(generated.split('operation == "sc820_read_probe"')).toHaveLength(2);
    expect(generated).toContain(
      'const HRESULT result = automation->ElementFromHandle(window, &root);',
    );
    expect(program).toContain('ServePipe(server.value, BackendProbe{})');
    expect(program).not.toMatch(/#define\s+(?:CreateFileW|ReadFile|WriteFile|EnumWindows)\b/u);
  });
});

const build = compiler();
describe.skipIf(
  process.platform !== 'win32' || (build === null && process.env['CI'] === undefined),
)('Windows target I/O live seam (#940 and #820, bounded readers)', () => {
  it('bounds list and UIA reads, Stop receipts, inherited budgets, and late cleanup on owned fixtures', async () => {
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
      const compileErrors = `${compiled.stdout}\n${compiled.stderr}`
        .split(/\r?\n/u)
        .filter((line) => /\berror (?:C|LNK)\d+:/u.test(line))
        .map((line) => line.replaceAll(root, '<fixture>').replaceAll(nativeDirectory, '<native>'))
        .join('\n')
        .slice(0, 8_000);
      expect(compiled.status, `RCA seam must compile with MSVC\n${compileErrors}`).toBe(0);
      for (const scenario of [
        'healthy',
        'measure-cancel',
        'measure-close',
        'measure-same-epoch-close',
        'context-cancel',
        'deadline',
        'cold-context-deadline',
        'deadline-stop-race',
        'queued-stop',
        'completion-race',
        'uia-contact-timeout',
        'uia-cancel',
        'uia-close',
        'uia-prequeued-close',
        'uia-two-reads',
        'uia-shared-deadline',
      ]) {
        const result = await run(binary, [scenario], 70_000);
        expect(result.timedOut, `${scenario}: outer watchdog`).toBe(false);
        const failure = /^\{"failure":"([a-z_]+)"\}$/u.exec(result.stdout.trim())?.[1];
        expect(result.status, `${scenario}: ${failure ?? 'native RCA assertions'}`).toBe(0);
        const metadata: unknown = JSON.parse(result.stdout.trim());
        if (scenario.startsWith('uia-')) {
          expect(metadata).toMatchObject({
            case: scenario,
            outerStop:
              scenario === 'uia-contact-timeout'
                ? 'timeout'
                : scenario === 'uia-two-reads'
                  ? 'none'
                  : scenario === 'uia-shared-deadline'
                    ? 'budget'
                    : 'canceled',
            lateResultDiscarded: true,
            realContactCleanup: true,
            inputAttempts: 0,
            childExited: true,
            threadsJoined: true,
            workerIdle: true,
            watchdogFired: false,
          });
          console.log(JSON.stringify(metadata));
          continue;
        }
        expect(metadata).toMatchObject({
          case: scenario,
          stopSerialAdvanced: true,
          busyChecked: scenario === 'deadline',
          generationUnchangedOnRefusal: scenario !== 'healthy' && scenario !== 'deadline',
          partialPreserved: scenario === 'deadline',
          coldContextReused: scenario === 'cold-context-deadline',
          fixtureCount: scenario === 'deadline' || scenario === 'deadline-stop-race' ? 2 : 1,
          closeReplayChecked: scenario === 'measure-close',
          recovered: true,
          inputAttempts: 0,
          childExited: true,
          threadsJoined: true,
          workerIdle: true,
          watchdogFired: false,
        });
        console.log(JSON.stringify(metadata));
      }
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    }
  }, 700_000);
});
