import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const startReady = '  const auto begin_focus = [&] {';
const startAdopt = '  // Stop and final start adoption share this lock.';
const startEpilogue =
  '        // Adopted handles belong to the session; this worker must not release the shared slot.';

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
  const measureFrom = source.indexOf('bool MeasureWindowsV2NewStart(');
  const measureTo = source.indexOf('struct WindowsV2StartLease', measureFrom);
  if (measureFrom < 0 || measureTo < 0) throw new Error('Start measurement boundary changed');
  source =
    source.slice(0, measureFrom) +
    replaceOnce(
      source.slice(measureFrom, measureTo),
      'OpenLockedProcessExecutable(target_process->value, process_executable)',
      'Sc940StartOpen(target_process->value, process_executable)',
    ) +
    source.slice(measureTo);
  source = replaceOnce(source, startReady, `${startReady}\n    Sc940StartReadyGate();`);
  source = replaceOnce(source, startAdopt, `  Sc940StartAdoptGate();\n${startAdopt}`);
  source = replaceOnce(
    source,
    startEpilogue,
    `        Sc940StartEpilogueGate();\n${startEpilogue}`,
  );
  source = replaceOnce(
    source,
    '    std::thread([pending, input] {',
    '    Sc940StartWorkerAttempt();\n    std::thread([pending, input] {',
  );
  const startFrom = source.indexOf('bool StartWindowsV2NewSession(');
  const startTo = source.indexOf('// END windows v2 targets', startFrom);
  if (startFrom < 0 || startTo < 0) throw new Error('Start consumer boundary changed');
  source =
    source.slice(0, startFrom) +
    replaceOnce(
      replaceOnce(
        source.slice(startFrom, startTo),
        'ShowWindow(input.window, SW_RESTORE);',
        'Sc940StartShow(input.window, SW_RESTORE);',
      ),
      'SetForegroundWindow(input.window);',
      'Sc940StartForeground(input.window);',
    ) +
    source.slice(startTo);
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
    `    if (operation == "sc940_validation_probe") {
      try {
        return Respond(pipe, request, MessageType::kProbeResult, Sc940ValidationProbe(metadata));
      } catch (...) {
        return Respond(pipe, request, MessageType::kError, ErrorPayload("sc940_validation_probe_failed"));
      }
    }
    if (operation == "sc820_read_probe") {
      try {
        return Respond(pipe, request, MessageType::kProbeResult,
                       Sc820ReadProbe(metadata, queued_stop_serial));
      } catch (...) {
        return Respond(pipe, request, MessageType::kError, ErrorPayload("sc820_probe_failed"));
      }
    }
    if (operation == "read_node_value") {`,
  );
  const identityFrom = source.indexOf(
    'WindowsSessionIdentityResult MeasureWindowsSessionIdentity(',
  );
  const identityTo = source.indexOf('// END windows session identity validation', identityFrom);
  if (identityFrom < 0 || identityTo < 0) throw new Error('Validation identity boundary changed');
  let identity = replaceOnce(
    source.slice(identityFrom, identityTo),
    'ReadWindowsFileIdentity(work.executable.value, &held_file_identity)',
    'Sc940ValidationFileIdentity(work, &held_file_identity)',
  );
  identity = replaceOnce(
    identity,
    'void WindowsValidationWorkerLoop(WindowsValidationState *state) {',
    'void WindowsValidationWorkerLoop(WindowsValidationState *state) {\n  Sc940ValidationWorkerStarted();',
  );
  identity = replaceOnce(
    identity,
    '    CancelSynchronousIo(state.cancellation_thread);',
    '    { Sc940ValidationCancelAttempt(job_id, GetThreadId(state.cancellation_thread)); CancelSynchronousIo(state.cancellation_thread); }',
  );
  identity = replaceOnce(
    identity,
    '    // Job retirement precedes result publication. Nothing below touches the shared slot or alias:',
    '    Sc940ValidationRetired(job_id);\n    // Job retirement precedes result publication. Nothing below touches the shared slot or alias:',
  );
  source = source.slice(0, identityFrom) + identity + source.slice(identityTo);
  const from = source.indexOf('bool ValidateWindowsSession(\n');
  const to = source.indexOf('bool ReadExact(', from);
  if (from < 0 || to < 0) throw new Error('Session validation boundary changed');
  return (
    source.slice(0, from) +
    replaceOnce(
      source.slice(from, to),
      '  WindowsSessionIdentityResult identity;',
      '  Sc940SyncSessionProbe();\n  WindowsSessionIdentityResult identity;',
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
struct LockedWindowsExecutable;
struct WindowsValidationWork;
struct WindowsFileIdentity;
bool Sc940ValidationFileIdentity(const WindowsValidationWork &work, WindowsFileIdentity *identity);
void Sc940ValidationWorkerStarted();
void Sc940ValidationCancelAttempt(std::uint64_t job_id, DWORD thread_id);
void Sc940ValidationRetired(std::uint64_t job_id);
std::string Sc940ValidationProbe(const std::string &metadata);
bool Sc940StartOpen(HANDLE process, LockedWindowsExecutable *output);
void Sc940StartReadyGate();
void Sc940StartAdoptGate();
void Sc940StartEpilogueGate();
void Sc940StartWorkerAttempt();
BOOL Sc940StartShow(HWND window, int command);
BOOL Sc940StartForeground(HWND window);
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
#include <exception>
#include <stdexcept>

namespace {
HANDLE gate_entered = nullptr;
HANDLE gate_release = nullptr;
HANDLE adoption_entered = nullptr;
HANDLE start_epilogue_entered = nullptr;
HANDLE start_epilogue_release = nullptr;
std::mutex start_epilogue_mutex;
ScopedKernelHandle *start_epilogue_thread_owner = nullptr;
bool start_epilogue_capture_failed = false;
std::array<DWORD, 2> fixture_pids{};
std::array<HWND, 2> fixture_windows{};
unsigned fixture_count = 0;
unsigned enumeration_count = 0;
DWORD held_measure_pid = 0;
enum class HoldPoint { kNone, kMeasure, kContext, kCompletion, kConsumer, kStartOpen, kStartReady, kStartAdopt };
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
std::atomic<unsigned> start_open_calls{0};
std::atomic<unsigned> start_worker_attempts{0};
std::atomic<unsigned> start_open_successes{0};
std::atomic<unsigned> start_focus_calls{0};
std::atomic<bool> hold_start_epilogue{false};
std::atomic<bool> validation_case_active{false};
std::atomic<unsigned> validation_file_reads{0}, validation_file_successes{0}, validation_workers{0};
std::atomic<unsigned> validation_cancel_attempts{0}, validation_retired_jobs{0};
std::atomic<unsigned> validation_gate_read{0};
std::atomic<DWORD> validation_thread_id{0};
std::atomic<HANDLE> validation_source_process{nullptr}, validation_source_file{INVALID_HANDLE_VALUE};
std::atomic<std::uint64_t> validation_last_cancel_id{0}, validation_last_retired_id{0};
std::mutex validation_pending_mutex;
std::shared_ptr<WindowsValidationPending> validation_first_pending, validation_last_pending;
const WindowsSession *validation_probe_source = nullptr;

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

void Sc940ValidationWorkerStarted() {
  if (!validation_case_active.load()) return;
  validation_workers.fetch_add(1);
  validation_thread_id.store(GetCurrentThreadId());
}
bool Sc940ValidationFileIdentity(const WindowsValidationWork &work, WindowsFileIdentity *identity) {
  if (!validation_case_active.load()) return ReadWindowsFileIdentity(work.executable.value, identity);
  if (work.pid != fixture_pids[0] || GetProcessId(work.process.value) != fixture_pids[0] ||
      work.process.value == validation_source_process.load() || work.executable.value == validation_source_file.load() ||
      GetCurrentThreadId() != validation_thread_id.load()) {
    wrong_measurement.store(true);
    return false;
  }
  {
    std::lock_guard lock(validation_pending_mutex);
    if (validation_first_pending == nullptr) validation_first_pending = work.pending;
    validation_last_pending = work.pending;
  }
  const unsigned ordinal = validation_file_reads.fetch_add(1) + 1;
  if (ordinal == validation_gate_read.load()) {
    SetEvent(gate_entered);
    if (WaitForSingleObject(gate_release, 20'000) != WAIT_OBJECT_0) gate_timed_out.store(true);
  }
  const bool read = ReadWindowsFileIdentity(work.executable.value, identity);
  if (read) validation_file_successes.fetch_add(1);
  return read;
}
void Sc940ValidationCancelAttempt(std::uint64_t job_id, DWORD thread_id) {
  if (!validation_case_active.load()) return;
  if (thread_id == 0 || thread_id != validation_thread_id.load()) wrong_measurement.store(true);
  validation_last_cancel_id.store(job_id);
  validation_cancel_attempts.fetch_add(1);
}
void Sc940ValidationRetired(std::uint64_t job_id) {
  if (!validation_case_active.load()) return;
  validation_last_retired_id.store(job_id);
  validation_retired_jobs.fetch_add(1);
}

std::string Sc940ValidationProbe(const std::string &metadata) {
  Require(validation_probe_source != nullptr, "validation_probe_source");
  const WindowsValidationFrameScope frame;
  WindowsSession source = *validation_probe_source;
  source.cancel_epoch = cancellation_epoch.load(std::memory_order_acquire);
  std::string mode;
  ReadJsonString(metadata, "mode", &mode);
  if (mode == "start_mismatch") source.process_start += "-different";
  if (mode == "path_mismatch") source.canonical_path += L".different";
  if (mode == "file_mismatch") source.executable_file_id.Identifier[0] ^= 1;
  // A real owned event can be duplicated, but FileIdInfo on it must fail; no API result is faked.
  if (mode == "read_failure") source.executable_file = gate_entered;
  const unsigned count = mode == "repeat" ? 16 : 1;
  unsigned successes = 0;
  bool available = false, matches = false;
  const auto started = std::chrono::steady_clock::now();
  for (unsigned index = 0; index < count; ++index) {
    validation_source_process.store(source.process_handle);
    validation_source_file.store(source.executable_file);
    WindowsSessionIdentityResult result;
    available = ReadWindowsSessionIdentityOnLane(source, frame.StopSerial(), &result);
    matches = available && result.identity_matches;
    if (matches) ++successes;
    if (!available) break;
  }
  const double elapsed = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
  return "{\"identityOnly\":true,\"available\":" + std::string(available ? "true" : "false") +
      ",\"matches\":" + (matches ? "true" : "false") + ",\"calls\":" + std::to_string(count) +
      ",\"successes\":" + std::to_string(successes) + ",\"elapsedMs\":" + std::to_string(elapsed) + "}";
}

bool Sc940StartOpen(HANDLE process, LockedWindowsExecutable *output) {
  if (fixture_count != 1 || GetProcessId(process) != fixture_pids[0]) {
    wrong_measurement.store(true);
    return false;
  }
  start_open_calls.fetch_add(1);
  Sc940Gate(HoldPoint::kStartOpen);
  const bool opened = OpenLockedProcessExecutable(process, output);
  if (opened) start_open_successes.fetch_add(1);
  return opened;
}
void Sc940StartReadyGate() { Sc940Gate(HoldPoint::kStartReady); }
void Sc940StartWorkerAttempt() { start_worker_attempts.fetch_add(1); }
void Sc940StartAdoptGate() { Sc940Gate(HoldPoint::kStartAdopt); }
void Sc940StartEpilogueGate() {
  HANDLE release = nullptr;
  {
    // Publication and disarming share this lock, so cleanup either owns this real thread handle
    // or prevents the hook from borrowing its events. The worker never closes the published handle.
    std::lock_guard lock(start_epilogue_mutex);
    if (!hold_start_epilogue.load() || start_epilogue_thread_owner == nullptr) return;
    ScopedKernelHandle thread;
    if (start_epilogue_thread_owner->value != nullptr ||
        !DuplicateHandle(GetCurrentProcess(), GetCurrentThread(), GetCurrentProcess(), &thread.value,
                         SYNCHRONIZE, FALSE, 0)) {
      start_epilogue_capture_failed = true;
      SetEvent(start_epilogue_entered);
      return;
    }
    start_epilogue_thread_owner->value = thread.release();
    release = start_epilogue_release;
    SetEvent(start_epilogue_entered);
  }
  if (WaitForSingleObject(release, 20'000) != WAIT_OBJECT_0) gate_timed_out.store(true);
}
BOOL Sc940StartShow(HWND window, int command) {
  start_focus_calls.fetch_add(1);
  return ShowWindow(window, command);
}
BOOL Sc940StartForeground(HWND window) {
  start_focus_calls.fetch_add(1);
  return SetForegroundWindow(window);
}

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

void SeedOwnedValidationIdentity(WindowsSession *session) {
  ScopedKernelHandle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
                                          FALSE, fixture_pids[0]));
  LockedWindowsExecutable image;
  std::string started;
  Require(process.value != nullptr && OpenLockedProcessExecutable(process.value, &image) &&
              ReadProcessStartIdentity(process.value, &started) &&
              WaitForSingleObject(process.value, 0) == WAIT_TIMEOUT, "validation_owned_identity");
  std::wstring process_path;
  Require(ReadProcessPath(process.value, &process_path) && SameWindowsPath(process_path, image.identity.path),
          "validation_fixture_process_path_matches_held");
  session->pid = fixture_pids[0];
  session->window = session->active_window = fixture_windows[0];
  session->app_identity = image.identity.identity_digest;
  session->process_start = started;
  session->canonical_path = image.identity.path;
  session->window_identity = Sha256String("computer-window-identity-v1\n" + session->app_identity + "\n" +
      started + "\n" + std::to_string(reinterpret_cast<UINT_PTR>(session->window)));
  session->active_window_identity = session->window_identity;
  session->executable_volume_serial = image.identity.file_identity.volume_serial;
  session->executable_file_id = image.identity.file_identity.file_id;
  session->executable_digest = image.identity.executable_digest;
  session->signer_digest = image.identity.signer_digest;
  session->policy_language = image.identity.policy_language;
  session->eligibility_basis = sprint_coder::computer_use::EligibilityBasis::kV2Denylist;
  session->process_handle = process.release();
  session->executable_file = image.file;
  image.file = INVALID_HANDLE_VALUE;
}

struct ValidationProbeResult {
  bool available = false, matches = false;
  std::uint64_t calls = 0, successes = 0;
  double elapsed_ms = 0;
};

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
  ScopedKernelHandle epilogue_entered{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  ScopedKernelHandle epilogue_release{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  ScopedKernelHandle epilogue_thread;
  WindowsSession validation_probe_session;
  ScopedKernelHandle job;
  std::array<ScopedKernelHandle, 3> children;
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
  bool fixture_launch_path_canonicalized = false;

  RcaRun() {
    Require(entered.value && release.value && adopting.value && finished.value && epilogue_entered.value &&
                epilogue_release.value, "event_creation");
    gate_entered = entered.value;
    gate_release = release.value;
    adoption_entered = adopting.value;
    {
      std::lock_guard lock(start_epilogue_mutex);
      start_epilogue_entered = epilogue_entered.value;
      start_epilogue_release = epilogue_release.value;
      start_epilogue_thread_owner = &epilogue_thread;
      start_epilogue_capture_failed = false;
    }
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
      SetEvent(epilogue_release.value);
      if (job.value != nullptr) TerminateJobObject(job.value, 90);
      // The outer test must fail instead of hanging in join if a real OS call did not return.
      if (WaitForSingleObject(finished.value, 2'000) != WAIT_OBJECT_0)
        TerminateProcess(GetCurrentProcess(), 90);
    });
  }

  void StartFixture(bool canonical_executable = false) {
    Require(fixture_count < fixture_pids.size(), "fixture_limit");
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
    std::wstring fixture_executable(executable.data(), length);
    if (canonical_executable) {
      // TEMP may use an 8.3 alias. Identity tests need the same path spelling that a native
      // session records; a path mismatch would reject before the intended FileId fault gate.
      LockedWindowsExecutable image;
      Require(OpenLockedWindowsExecutable(fixture_executable, &image), "validation_fixture_executable");
      fixture_launch_path_canonicalized = !SameWindowsPath(fixture_executable, image.identity.path);
      fixture_executable = image.identity.path;
    }
    std::wstring command = L"\"" + fixture_executable + L"\" fixture \"" +
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

  void AttachOwnedSibling(DWORD pid, HWND window, const std::string &created, const std::wstring &path) {
    ScopedKernelHandle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE | PROCESS_TERMINATE,
                                          FALSE, pid));
    LockedWindowsExecutable expected, actual;
    std::string started;
    DWORD owner = 0;
    Require(process.value != nullptr && OpenLockedWindowsExecutable(path, &expected) &&
                OpenLockedProcessExecutable(process.value, &actual) &&
                SameWindowsFileIdentity(expected.identity.file_identity, actual.identity.file_identity) &&
                ReadProcessStartIdentity(process.value, &started) && started == created &&
                IsWindow(window) && GetWindowThreadProcessId(window, &owner) != 0 && owner == pid &&
                WaitForSingleObject(process.value, 0) == WAIT_TIMEOUT, "owned_sibling_binding");
    children[0].value = process.release();
    fixture_pids[0] = pid;
    fixture_windows[0] = window;
    fixture_count = enumeration_count = 1;
  }

  void PrepareValidationProbe() {
    SeedOwnedValidationIdentity(&validation_probe_session);
    validation_probe_source = &validation_probe_session;
  }

  void StartPipe(bool same_epoch_close, bool seed_control = true, bool seed_validation_handles = false) {
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
    if (seed_control) {
      WindowsSession session;
      session.session_id = "sc940-control";
      session.cancel_epoch = 1;
      session.has_observation = true;
      session.observation_revision = 1;
      const auto inserted = sessions.emplace(FrameIdKey(Id(7)), std::move(session));
      Require(inserted.second, "control_session_seed");
      if (seed_validation_handles) {
        SeedOwnedValidationIdentity(&inserted.first->second);
        validation_source_process.store(inserted.first->second.process_handle);
        validation_source_file.store(inserted.first->second.executable_file);
      }
    }
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

  void Send(MessageType type, std::uint8_t id, std::string_view metadata, std::uint8_t session_byte = 7) {
    FrameHeader header;
    header.message_type = static_cast<std::uint16_t>(type);
    header.request_id = Id(id);
    header.session_id = Id(session_byte);
    if (type == MessageType::kCancel) header.cancel_id = Id(9);
    Require(WriteFrame(client.value, header, metadata), "frame_write");
  }

  bool Wait(unsigned id, DWORD milliseconds) {
    std::unique_lock<std::mutex> lock(replies_mutex);
    return replies_ready.wait_for(lock, std::chrono::milliseconds(milliseconds), [&] { return replies.contains(id); });
  }

  bool Receipt(unsigned id, MessageType type, std::string_view expected, std::uint64_t epoch,
               std::uint8_t session_byte = 7, std::string_view session_name = "sc940-control") {
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
           frame.header.session_id.bytes == Id(session_byte).bytes &&
           ReadJsonString(body, "result", &result) && result == expected &&
           ReadJsonString(body, "sessionId", &session) && session == session_name &&
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

  bool Error(unsigned id, std::string_view code, std::uint8_t session_byte = 7) {
    std::lock_guard<std::mutex> lock(replies_mutex);
    const auto found = replies.find(id);
    if (found == replies.end()) return false;
    const Frame &frame = found->second;
    const std::string body(frame.metadata.begin(), frame.metadata.end());
    std::string actual;
    bool accepted = true;
    return frame.header.message_type == static_cast<std::uint16_t>(MessageType::kError) &&
           frame.header.request_id.bytes == Id(static_cast<std::uint8_t>(id)).bytes &&
           frame.header.session_id.bytes == Id(session_byte).bytes && frame.binary.empty() &&
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

  bool ProbeBody(unsigned id, std::string *body, std::uint8_t session_byte = 7) {
    std::lock_guard lock(replies_mutex);
    const auto found = replies.find(id);
    if (found == replies.end()) return false;
    const Frame &frame = found->second;
    if (frame.header.message_type != static_cast<std::uint16_t>(MessageType::kProbeResult) ||
        frame.header.request_id.bytes != Id(static_cast<std::uint8_t>(id)).bytes ||
        frame.header.session_id.bytes != Id(session_byte).bytes || !frame.binary.empty()) return false;
    body->assign(frame.metadata.begin(), frame.metadata.end());
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

  HANDLE StartWorkerThread() {
    std::lock_guard lock(start_epilogue_mutex);
    return start_epilogue_capture_failed ? nullptr : epilogue_thread.value;
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

  bool ValidationReply(unsigned id, ValidationProbeResult *output) {
    std::string body;
    bool identity_only = false;
    return ProbeBody(id, &body) && body.size() < 512 &&
        ReadOptionalJsonBoolean(body, "identityOnly", &identity_only) && identity_only &&
        ReadOptionalJsonBoolean(body, "available", &output->available) &&
        ReadOptionalJsonBoolean(body, "matches", &output->matches) &&
        ReadJsonUint64(body, "calls", &output->calls) && ReadJsonUint64(body, "successes", &output->successes) &&
        ReadJsonDouble(body, "elapsedMs", &output->elapsed_ms);
  }

  void Cleanup() {
    if (cleaned) return;
    cleaned = true;
    SetEvent(release.value);
    HANDLE old_start_thread = nullptr;
    bool capture_failed = false;
    {
      std::lock_guard lock(start_epilogue_mutex);
      hold_start_epilogue.store(false);
      start_epilogue_thread_owner = nullptr;
      old_start_thread = epilogue_thread.value;
      capture_failed = start_epilogue_capture_failed;
      SetEvent(epilogue_release.value);
    }
    if (old_start_thread != nullptr && WaitForSingleObject(old_start_thread, 5000) != WAIT_OBJECT_0) {
      // Do not destroy the events or the duplicated handle while the worker can still use them.
      // Fail the owned test process, as the existing watchdog does, instead of racing teardown.
      watchdog_fired.store(true);
      if (job.value != nullptr) TerminateJobObject(job.value, 90);
      TerminateProcess(GetCurrentProcess(), 90);
      std::terminate();
    }
    if (client.value != INVALID_HANDLE_VALUE) CancelIoEx(client.value, nullptr);
    if (server.value != INVALID_HANDLE_VALUE) { CancelIoEx(server.value, nullptr); DisconnectNamedPipe(server.value); }
    if (serving.joinable()) serving.join();
    if (receiving.joinable()) receiving.join();
    // The detached production worker must release its slot/resources before our fixture is killed.
    worker_idle = WaitWorkerIdle(15'000) && !capture_failed;
    worker_idle = WaitUiaWorkerIdle(15'000) && worker_idle;
    ReleaseWindowsSessionResources(&validation_probe_session);
    validation_probe_source = nullptr;
    validation_case_active.store(false);
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

struct ListedStart {
  std::uint64_t generation = 0, ruleset = 0, pid = 0;
  std::string window, app, window_identity, executable, path, signer;
  double x = 0, y = 0, width = 0, height = 0;
  std::string Metadata(std::uint64_t epoch) const {
    return "{\"operation\":\"start_session\",\"eligibilityBasis\":\"v2-denylist\",\"sessionId\":\"sc940-new\","
        "\"profileRevision\":1,\"cancelEpoch\":" + std::to_string(epoch) + ",\"pid\":" + std::to_string(pid) +
        ",\"windowId\":\"" + window + "\",\"appIdentityDigest\":\"" + app +
        "\",\"windowIdentityDigest\":\"" + window_identity + "\",\"canonicalPath\":\"" + JsonEscape(path) +
        "\",\"executableDigest\":\"" + executable + "\",\"signerDigest\":null,\"expectedBoundsX\":" + std::to_string(x) +
        ",\"expectedBoundsY\":" + std::to_string(y) + ",\"expectedBoundsWidth\":" + std::to_string(width) +
        ",\"expectedBoundsHeight\":" + std::to_string(height) + ",\"targetGeneration\":" + std::to_string(generation) +
        ",\"denyRulesetVersion\":" + std::to_string(ruleset) + "}";
  }
};

ListedStart ReadListedStart(RcaRun &run, std::uint8_t request) {
  run.Send(MessageType::kProbe, request, "{\"operation\":\"list_targets\"}");
  ListedStart result;
  std::string rows, envelope, kind, mode;
  bool truncated = true;
  Require(run.Wait(request, 7000) && run.ListTargets(request, &result.generation, &rows, &truncated) &&
              run.ProbeBody(request, &envelope) && !truncated && run.WaitWorkerIdle(1000), "start_real_list_reply");
  Require(ReadJsonUint64(envelope, "rulesetVersion", &result.ruleset) &&
              ReadJsonString(rows, "kind", &kind) && kind == "upper" &&
              ReadJsonString(rows, "maximumMode", &mode) && mode == "observe_only" &&
              ReadJsonUint64(rows, "pid", &result.pid) && result.pid == fixture_pids[0] &&
              ReadJsonString(rows, "windowId", &result.window) &&
              result.window == std::to_string(reinterpret_cast<UINT_PTR>(fixture_windows[0])) &&
              ReadJsonString(rows, "appIdentityDigest", &result.app) &&
              ReadJsonString(rows, "windowIdentityDigest", &result.window_identity) &&
              ReadJsonString(rows, "executableDigest", &result.executable) &&
              ReadJsonString(rows, "executablePath", &result.path) &&
              rows.find("\"signerDigest\":null") != std::string::npos,
          "start_unsigned_gui_list_identity");
  const auto begin = rows.find("\"bounds\":{");
  const auto end = rows.find('}', begin);
  Require(begin != std::string::npos && end != std::string::npos, "start_list_bounds_present");
  const std::string bounds = rows.substr(begin, end - begin + 1);
  Require(ReadJsonDouble(bounds, "x", &result.x) && ReadJsonDouble(bounds, "y", &result.y) &&
              ReadJsonDouble(bounds, "width", &result.width) && ReadJsonDouble(bounds, "height", &result.height) &&
              result.width > 0 && result.height > 0, "start_list_bounds_valid");
  return result;
}

void AssertStarted(RcaRun &run, std::uint8_t request, const ListedStart &listed, std::uint64_t epoch) {
  std::string body, app, window, mode;
  std::uint64_t actual_epoch = 0, attempts = 1;
  Require(run.Wait(request, 10'000) && run.ProbeBody(request, &body, 8) &&
              ReadJsonString(body, "appIdentityDigest", &app) && app == listed.app &&
              ReadJsonString(body, "windowIdentityDigest", &window) && window == listed.window_identity &&
              ReadJsonString(body, "maximumMode", &mode) && mode == "observe_only" &&
              ReadJsonUint64(body, "cancelEpoch", &actual_epoch) && actual_epoch == epoch &&
              ReadJsonUint64(body, "inputAttemptCount", &attempts) && attempts == 0,
          "start_new_session_success");
  Require(!WindowsTargetListWorkerRunning().load(), "start_success_releases_busy_immediately");
  const auto found = sessions.find(FrameIdKey(Id(8)));
  Require(found != sessions.end() && found->second.pid == fixture_pids[0] &&
              found->second.window == fixture_windows[0] && found->second.app_identity == listed.app &&
              found->second.maximum_mode == "observe_only" && GetProcessId(found->second.process_handle) == listed.pid &&
              !ticket_states.contains(FrameIdKey(Id(8))), "start_only_consumer_adopts_session");
  RECT bounds{};
  std::string reason;
  const unsigned before = synchronous_session_probes.load();
  Require(ValidateWindowsSession(found->second, &bounds, &reason) && synchronous_session_probes.load() == before + 1 &&
              std::abs(bounds.left - listed.x) <= 1 && std::abs(bounds.top - listed.y) <= 1 &&
              std::abs(bounds.right - bounds.left - listed.width) <= 1 &&
              std::abs(bounds.bottom - bounds.top - listed.height) <= 1, "start_immediate_real_validation");
}

void CloseStarted(RcaRun &run, std::uint8_t cancel_request, std::uint8_t close_request, std::uint64_t epoch) {
  run.Send(MessageType::kCancel, cancel_request, "{\"cancelEpoch\":" + std::to_string(epoch) + "}", 8);
  run.Send(MessageType::kProbe, close_request,
           "{\"operation\":\"close_session\",\"cancelEpoch\":" + std::to_string(epoch + 1) + "}", 8);
  Require(run.Wait(cancel_request, 1000) && run.Receipt(cancel_request, MessageType::kDispatchResult, "canceled", epoch, 8, "sc940-new") &&
              run.Wait(close_request, 1000) && run.Receipt(close_request, MessageType::kProbeResult, "closed", epoch + 1, 8, "sc940-new"),
          "start_real_session_drained");
  Require(!sessions.contains(FrameIdKey(Id(8))), "start_closed_session_removed");
}

int DiagnoseStart(std::wstring_view scenario, DWORD pid, HWND window, const std::string &created,
                  const std::wstring &fixture_path, bool focus_control_ready) {
  const bool healthy = scenario == L"start-healthy";
  const bool cancel = scenario == L"start-open-cancel";
  const bool queued = scenario == L"start-prequeued-close";
  const bool ready = scenario == L"start-ready-close";
  const bool adopt = scenario == L"start-adopt-close";
  const char *label = healthy ? "start-healthy" : cancel ? "start-open-cancel" : queued ? "start-prequeued-close" :
      ready ? "start-ready-close" : adopt ? "start-adopt-close" : "start-open-close";
  RcaRun run;
  ULONGLONG stop_ms = 0;
  bool stop_proven = false, late_cleanup = false, environment_failure = false;
  try {
    Require(ConfigurePerMonitorDpiAwareness(), "start_dpi_awareness");
    run.AttachOwnedSibling(pid, window, created, fixture_path);
    const auto require_foreground = [&] {
      const HWND foreground = GetForegroundWindow();
      const bool available = !IsIconic(window) && (ready
          ? focus_control_ready && foreground != nullptr && foreground != window && !IsNativeTakeoverWindow(foreground)
          : foreground == window);
      if (!available) environment_failure = true;
      Require(available, "start_owned_foreground_unavailable");
    };
    if (healthy || ready || adopt) require_foreground();
    run.StartPipe(false, cancel);
    run.Send(MessageType::kHandshake, 1, "{\"protocolVersion\":1,\"apiVersion\":2}");
    Require(run.Wait(1, 5000) && run.ProbeReply(1, MessageType::kHandshakeResult), "start_handshake");
    const ListedStart listed = ReadListedStart(run, 30);
    Require(windows_v2_main_pid == GetCurrentProcessId() && !sessions.contains(FrameIdKey(Id(8))) &&
                (cancel || sessions.empty()), "start_real_client_empty_session");
    hold_point.store(healthy ? HoldPoint::kNone : queued ? HoldPoint::kConsumer : ready ? HoldPoint::kStartReady :
                     adopt ? HoldPoint::kStartAdopt : HoldPoint::kStartOpen);
    hold_start_epilogue.store(healthy);
    run.Send(MessageType::kProbe, 2, listed.Metadata(1), 8);
    if (healthy) {
      AssertStarted(run, 2, listed, 1);
      Require(WaitForSingleObject(run.epilogue_entered.value, 5000) == WAIT_OBJECT_0, "start_old_worker_epilogue");
      Require(run.StartWorkerThread() != nullptr, "start_old_worker_thread_captured");
      // Keep the old successful worker alive while a new list owns the same single-flight slot.
      held_measure_pid = pid;
      hold_point.store(HoldPoint::kMeasure);
      run.Send(MessageType::kProbe, 31, "{\"operation\":\"list_targets\"}");
      Require(WaitForSingleObject(run.entered.value, 5000) == WAIT_OBJECT_0 && WindowsTargetListWorkerRunning().load(),
              "start_next_worker_claimed_slot");
      hold_start_epilogue.store(false);
      SetEvent(run.epilogue_release.value);
      Require(WaitForSingleObject(run.StartWorkerThread(), 5000) == WAIT_OBJECT_0, "start_old_worker_exited");
      Require(WindowsTargetListWorkerRunning().load(), "start_old_worker_does_not_release_next_slot");
      hold_point.store(HoldPoint::kNone);
      SetEvent(run.release.value);
      Require(run.Wait(31, 7000) && run.ProbeReply(31, MessageType::kProbeResult) && run.WaitWorkerIdle(1000),
              "start_next_worker_completes");
      CloseStarted(run, 22, 23, 2);
    } else {
      Require(WaitForSingleObject(run.entered.value, 10'000) == WAIT_OBJECT_0 &&
                  WaitForSingleObject(run.release.value, 0) == WAIT_TIMEOUT &&
                  WindowsTargetListWorkerRunning().load() == !queued, "start_fault_gate_entered");
      if (cancel) {
        const unsigned opens = start_open_calls.load(), measures = measurement_calls.load();
        const unsigned workers = start_worker_attempts.load();
        const std::uint64_t serial = WindowsTargetListControl().stop_serial.load();
        const ULONGLONG sent = GetTickCount64();
        // Same first Stop as the be6 RCA: a valid Cancel of the seeded control session.
        run.Send(MessageType::kCancel, 4, "{\"cancelEpoch\":2}");
        Require(WaitStopSerial(serial, 1000), "start_cancel_reader_progress");
        Require(run.Wait(2, 1000) && run.Error(2, "session_start_canceled", 8) &&
                    run.Wait(4, 1000) && run.Receipt(4, MessageType::kDispatchResult, "canceled", 2),
                "start_valid_cancel_receipt_before_release");
        // Fresh requests carry the new serial and epoch; staleness cannot stand in for the busy guard.
        run.Send(MessageType::kProbe, 6, listed.Metadata(2), 9);
        run.Send(MessageType::kProbe, 7, "{\"operation\":\"list_targets\"}");
        Require(run.Wait(6, 1000) && run.Error(6, "session_target_rejected", 9) &&
                    run.Wait(7, 1000) && run.Error(7, "list_targets_unavailable"), "start_fresh_busy_requests_refused");
        run.Send(MessageType::kCancel, 3, "{\"cancelEpoch\":2}", 8);
        Require(run.Wait(3, 1000) && run.Error(3, "invalid_cancel", 8), "start_uncreated_cancel_bounded");
        run.Send(MessageType::kProbe, 5, "{\"operation\":\"close_session\",\"cancelEpoch\":3}");
        Require(run.Wait(5, 1000) && run.Receipt(5, MessageType::kProbeResult, "closed", 3),
                "start_control_receipts_before_release");
        stop_ms = GetTickCount64() - sent;
        Require(start_open_calls.load() == opens && start_worker_attempts.load() == workers && measurement_calls.load() == measures &&
                    WindowsTargetListWorkerRunning().load(), "start_busy_starts_no_worker");
      } else {
        const std::uint64_t serial = WindowsTargetListControl().stop_serial.load();
        const ULONGLONG sent = GetTickCount64();
        run.Send(MessageType::kProbe, 3, "{\"operation\":\"close_session\",\"cancelEpoch\":2}", 8);
        Require(WaitStopSerial(serial, 1000), "start_close_reader_progress");
        if (queued || ready || adopt) {
          hold_point.store(HoldPoint::kNone);
          SetEvent(run.release.value);
        }
        Require(run.Wait(2, 1000) && run.Error(2, "session_start_canceled", 8) &&
                    run.Wait(3, 1000) && run.Error(3, "native_close_unconfirmed", 8), "start_uncreated_close_bounded");
        stop_ms = GetTickCount64() - sent;
        Require(cancellation_epoch.load() == 1, "start_close_uses_serial_not_epoch");
      }
      Require(stop_ms < 1000 && !sessions.contains(FrameIdKey(Id(8))) &&
                  !ticket_states.contains(FrameIdKey(Id(8))) && start_focus_calls.load() == 0 &&
                  windows_v2_list_generation == listed.generation, "start_stop_prevents_adoption_and_focus");
      stop_proven = true;
      if (!queued && !ready && !adopt)
        Require(WindowsTargetListWorkerRunning().load() && WaitForSingleObject(run.release.value, 0) == WAIT_TIMEOUT,
                "start_response_precedes_open_release");
      hold_point.store(HoldPoint::kNone);
      SetEvent(run.release.value);
      Require(run.WaitWorkerIdle(15'000) && start_open_calls.load() == (queued ? 0u : 1u) &&
                  start_worker_attempts.load() == (queued ? 0u : 1u) &&
                  start_open_successes.load() == (queued ? 0u : 1u) && !sessions.contains(FrameIdKey(Id(8))) &&
                  windows_v2_list_generation == listed.generation, "start_late_open_cleaned_without_adoption");
      late_cleanup = true;
      if (cancel) {
        require_foreground();
        const ListedStart fresh = ReadListedStart(run, 20);
        run.Send(MessageType::kProbe, 21, fresh.Metadata(4), 8);
        AssertStarted(run, 21, fresh, 4);
        Require(start_open_calls.load() == 2 && start_worker_attempts.load() == 2, "start_explicit_retry_has_one_new_worker");
        CloseStarted(run, 22, 23, 5);
      }
    }
    Require(start_focus_calls.load() == 0 && !wrong_measurement.load() && !gate_timed_out.load(), "start_no_input_or_foreign_target");
    run.Cleanup();
    Require(run.child_exited && run.worker_idle && !run.watchdog_fired.load(), "start_cleanup_completed");
    std::cout << "{\"case\":\"" << label << "\",\"stopMs\":" << stop_ms
              << ",\"stopProof\":" << (stop_proven ? "true" : "false")
              << ",\"lateCleanupVerified\":" << (late_cleanup ? "true" : "false")
              << ",\"healthyStartVerified\":" << (healthy || cancel ? "true" : "false")
              << ",\"inputAttempts\":0,\"lateAdoptionDiscarded\":" << (healthy ? "false" : "true")
              << ",\"slotHandoffVerified\":" << (healthy ? "true" : "false")
              << ",\"childExited\":true,\"threadsJoined\":true"
              << ",\"workerIdle\":true,\"watchdogFired\":false}\n";
    return 0;
  } catch (const std::exception &error) {
    run.Cleanup();
    std::cout << "{\"case\":\"" << label << "\",\"failure\":\"" << error.what()
              << "\",\"environmentFailure\":" << (environment_failure ? "true" : "false")
              << ",\"stopProof\":" << (stop_proven ? "true" : "false")
              << ",\"lateCleanupVerified\":" << (late_cleanup ? "true" : "false")
              << ",\"stopMs\":" << stop_ms << ",\"inputAttempts\":" << start_focus_calls.load()
              << ",\"childExited\":" << (run.child_exited ? "true" : "false")
              << ",\"workerIdle\":" << (run.worker_idle ? "true" : "false") << "}\n";
    return 1;
  }
}

// The GUI target and real pipe client are siblings. W8 therefore measures their true relationship,
// rather than accepting a forged lineage root or a special acceptance-mode/signature exemption.
int CoordinateStart(std::wstring_view scenario, const std::wstring &fixture_path) {
  RcaRun run;
  try {
    Require(ConfigurePerMonitorDpiAwareness(), "start_coordinator_dpi");
    ScopedKernelHandle child_token;
    if (IsProcessElevated(GetCurrentProcessId())) {
      ScopedKernelHandle own;
      Require(OpenProcessToken(GetCurrentProcess(), TOKEN_ALL_ACCESS, &own.value), "start_own_token");
      BYTE administrators[SECURITY_MAX_SID_SIZE];
      DWORD sid_size = sizeof(administrators);
      SID_AND_ATTRIBUTES deny{};
      Require(CreateWellKnownSid(WinBuiltinAdministratorsSid, nullptr, administrators, &sid_size), "start_admin_sid");
      deny.Sid = administrators;
      Require(CreateRestrictedToken(own.value, LUA_TOKEN | DISABLE_MAX_PRIVILEGE, 1, &deny, 0, nullptr, 0, nullptr,
                                    &child_token.value), "start_restricted_child_token");
      PSID medium = nullptr;
      Require(ConvertStringSidToSidW(L"S-1-16-8192", &medium), "start_medium_sid");
      TOKEN_MANDATORY_LABEL label{};
      label.Label.Attributes = SE_GROUP_INTEGRITY;
      label.Label.Sid = medium;
      const BOOL lowered = SetTokenInformation(child_token.value, TokenIntegrityLevel, &label,
                                               sizeof(label) + GetLengthSid(medium));
      LocalFree(medium);
      TOKEN_ELEVATION elevation{};
      DWORD bytes = 0;
      Require(lowered && GetTokenInformation(child_token.value, TokenElevation, &elevation, sizeof(elevation), &bytes) &&
                  elevation.TokenIsElevated == 0, "start_target_token_not_elevated");
    }
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESHOWWINDOW;
    startup.wShowWindow = SW_SHOWNORMAL;
    PROCESS_INFORMATION fixture{};
    std::wstring command = L"\"" + fixture_path + L"\"";
    const BOOL created = child_token.value != nullptr
        ? CreateProcessAsUserW(child_token.value, nullptr, command.data(), nullptr, nullptr, FALSE, CREATE_SUSPENDED,
                               nullptr, nullptr, &startup, &fixture)
        : CreateProcessW(nullptr, command.data(), nullptr, nullptr, FALSE, CREATE_SUSPENDED,
                         nullptr, nullptr, &startup, &fixture);
    Require(created, "start_gui_fixture_created");
    run.children[0].value = fixture.hProcess;
    ScopedKernelHandle fixture_thread(fixture.hThread);
    Require(AssignProcessToJobObject(run.job.value, fixture.hProcess) &&
                ResumeThread(fixture.hThread) != static_cast<DWORD>(-1), "start_gui_fixture_owned");
    Require(WaitForInputIdle(fixture.hProcess, 10'000) == 0, "start_gui_fixture_ready");
    struct WindowSearch { DWORD pid; HWND found = nullptr; } search{fixture.dwProcessId};
    for (unsigned attempt = 0; attempt < 200 && search.found == nullptr; ++attempt) {
      EnumThreadWindows(fixture.dwThreadId, [](HWND window, LPARAM parameter) -> BOOL {
        auto *value = reinterpret_cast<WindowSearch *>(parameter);
        DWORD owner = 0;
        if (IsWindowVisible(window) && GetWindow(window, GW_OWNER) == nullptr &&
            GetWindowThreadProcessId(window, &owner) != 0 && owner == value->pid) { value->found = window; return FALSE; }
        return TRUE;
      }, reinterpret_cast<LPARAM>(&search));
      if (search.found == nullptr) Sleep(10);
    }
    Require(search.found != nullptr && !IsProcessElevated(fixture.dwProcessId), "start_gui_fixture_window");
    bool focus_control_ready = true;
    if (scenario == L"start-ready-close") {
      // A second owned GUI window gives begin_focus real work to refuse; no synthetic key is sent.
      PROCESS_INFORMATION foreground{};
      command = L"\"" + fixture_path + L"\"";
      const BOOL opened = child_token.value != nullptr
          ? CreateProcessAsUserW(child_token.value, nullptr, command.data(), nullptr, nullptr, FALSE, CREATE_SUSPENDED,
                                 nullptr, nullptr, &startup, &foreground)
          : CreateProcessW(nullptr, command.data(), nullptr, nullptr, FALSE, CREATE_SUSPENDED,
                           nullptr, nullptr, &startup, &foreground);
      Require(opened, "start_focus_control_created");
      run.children[2].value = foreground.hProcess;
      ScopedKernelHandle foreground_thread(foreground.hThread);
      Require(AssignProcessToJobObject(run.job.value, foreground.hProcess) &&
                  ResumeThread(foreground.hThread) != static_cast<DWORD>(-1) &&
                  WaitForInputIdle(foreground.hProcess, 10'000) == 0, "start_focus_control_owned");
      DWORD foreground_pid = 0;
      focus_control_ready = GetWindowThreadProcessId(GetForegroundWindow(), &foreground_pid) != 0 &&
                            foreground_pid == foreground.dwProcessId;
    }
    std::string started;
    Require(ReadProcessStartIdentity(fixture.hProcess, &started), "start_gui_creation_identity");
    std::vector<wchar_t> executable(32768, L'\0');
    const DWORD length = GetModuleFileNameW(nullptr, executable.data(), static_cast<DWORD>(executable.size()));
    Require(length > 0 && length < executable.size(), "start_coordinator_image");
    const std::wstring start_wide(started.begin(), started.end());
    command = L"\"" + std::wstring(executable.data(), length) + L"\" start-client " + std::wstring(scenario) + L" " +
        std::to_wstring(fixture.dwProcessId) + L" " + std::to_wstring(reinterpret_cast<UINT_PTR>(search.found)) +
        L" " + start_wide + L" \"" + fixture_path + L"\" " + (focus_control_ready ? L"1" : L"0");
    SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
    ScopedKernelHandle output_read, output_write;
    Require(CreatePipe(&output_read.value, &output_write.value, &security, 4096) &&
                SetHandleInformation(output_read.value, HANDLE_FLAG_INHERIT, 0), "start_client_output_pipe");
    ScopedKernelHandle input(CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                                         &security, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
    Require(input.value != INVALID_HANDLE_VALUE, "start_client_stdin");
    startup = {};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = input.value;
    startup.hStdOutput = startup.hStdError = output_write.value;
    PROCESS_INFORMATION client{};
    Require(CreateProcessW(nullptr, command.data(), nullptr, nullptr, TRUE, CREATE_SUSPENDED | CREATE_NO_WINDOW,
                            nullptr, nullptr, &startup, &client), "start_sibling_client_created");
    run.children[1].value = client.hProcess;
    ScopedKernelHandle client_thread(client.hThread);
    Require(AssignProcessToJobObject(run.job.value, client.hProcess) &&
                ResumeThread(client.hThread) != static_cast<DWORD>(-1), "start_sibling_client_owned");
    CloseHandle(output_write.release());
    Require(WaitForSingleObject(client.hProcess, 45'000) == WAIT_OBJECT_0, "start_sibling_client_finished");
    DWORD code = 1;
    Require(GetExitCodeProcess(client.hProcess, &code), "start_sibling_client_exit");
    std::string output;
    std::array<char, 1024> chunk{};
    DWORD read = 0;
    while (ReadFile(output_read.value, chunk.data(), static_cast<DWORD>(chunk.size()), &read, nullptr) && read > 0) {
      output.append(chunk.data(), read);
      Require(output.size() <= 4096, "start_client_metadata_bound");
    }
    run.Cleanup();
    Require(run.child_exited && !run.watchdog_fired.load() &&
                (output.starts_with("{\"case\":\"start-") || output.starts_with("{\"failure\":\"")),
            "start_coordinator_cleanup");
    std::cout << output;
    return code == 0 ? 0 : 1;
  } catch (const std::exception &error) {
    run.Cleanup();
    std::cout << "{\"failure\":\"" << error.what() << "\"}\n";
    return 1;
  }
}

struct ValidationStateView {
  std::uint64_t active = 0, next = 0;
  DWORD thread = 0;
  bool queued = false, started = false;
};
ValidationStateView ValidationState() {
  auto &state = WindowsValidationControl();
  std::lock_guard lock(state.mutex);
  return {state.active_job_id, state.next_job_id,
          state.cancellation_thread == nullptr ? 0 : GetThreadId(state.cancellation_thread),
          state.queued != nullptr, state.worker_started};
}
std::shared_ptr<WindowsValidationPending> ValidationPending(bool first) {
  std::lock_guard lock(validation_pending_mutex);
  return first ? validation_first_pending : validation_last_pending;
}
bool WaitValidationDone(const std::shared_ptr<WindowsValidationPending> &pending, DWORD milliseconds) {
  if (pending == nullptr) return false;
  const ULONGLONG deadline = GetTickCount64() + milliseconds;
  do {
    {
      std::lock_guard lock(pending->mutex);
      if (pending->done) return true;
    }
    Sleep(1);
  } while (GetTickCount64() < deadline);
  return false;
}
ValidationProbeResult RunValidationProbe(RcaRun &run, std::uint8_t request, std::string_view mode) {
  run.Send(MessageType::kProbe, request,
      "{\"operation\":\"sc940_validation_probe\",\"mode\":\"" + std::string(mode) + "\"}");
  ValidationProbeResult result;
  Require(run.Wait(request, 5000) && run.ValidationReply(request, &result), "validation_probe_reply");
  return result;
}

int DiagnoseValidation(std::wstring_view scenario) {
  const bool cancel = scenario == L"validation-cancel";
  const bool queued = scenario == L"validation-prequeued-close";
  const bool repeat = scenario == L"validation-repeat";
  const char *label = cancel ? "validation-cancel" : queued ? "validation-prequeued-close" :
      repeat ? "validation-repeat" : "validation-close";
  RcaRun run;
  ULONGLONG stop_ms = 0, close_ms = 0;
  double repeat_ms = 0;
  unsigned repeat_calls = 0;
  std::uint64_t first_job = 0, next_job = 0;
  try {
    validation_case_active.store(true);
    run.StartFixture(true);
    run.PrepareValidationProbe();
    run.StartPipe(false, !repeat, !repeat);
    run.Send(MessageType::kHandshake, 1, "{\"protocolVersion\":1,\"apiVersion\":2}");
    Require(run.Wait(1, 5000) && run.ProbeReply(1, MessageType::kHandshakeResult), "validation_handshake");
    if (repeat) {
      const ValidationProbeResult result = RunValidationProbe(run, 2, "repeat");
      Require(result.available && result.matches && result.calls == 16 && result.successes == 16 &&
                  validation_file_reads.load() == 16 && validation_file_successes.load() == 16 &&
                  validation_retired_jobs.load() == 16, "validation_every_call_reads_identity");
      repeat_ms = result.elapsed_ms;
      repeat_calls = 16;
      std::uint8_t request = 10;
      for (const char *mode : {"start_mismatch", "path_mismatch", "file_mismatch", "read_failure"}) {
        const ValidationProbeResult refused = RunValidationProbe(run, request++, mode);
        Require(refused.available && !refused.matches && refused.successes == 0,
                "validation_bad_identity_or_real_read_failure_refused");
      }
      Require(validation_file_reads.load() == 18 && validation_file_successes.load() == 17 &&
                  validation_retired_jobs.load() == 20, "validation_failure_calls_are_real");
      const ValidationProbeResult fresh = RunValidationProbe(run, 20, "normal");
      Require(fresh.available && fresh.matches && validation_file_reads.load() == 19 &&
                  validation_file_successes.load() == 18, "validation_failure_not_cached");
    } else {
      validation_gate_read.store(1);
      hold_point.store(queued ? HoldPoint::kConsumer : HoldPoint::kNone);
      // The be6 path: a real preflight reaches actual Validate with owned process/exe handles.
      const std::string preflight = "{\"requestId\":\"held-file-rca\",\"actionDigest\":\"" + std::string(64, 'a') +
          "\",\"cancelEpoch\":1,\"observationRevision\":1,\"type\":\"invoke\",\"targetId\":\"fixture\"}";
      run.Send(MessageType::kPreflight, 2, preflight);
      Require(WaitForSingleObject(run.entered.value, 10'000) == WAIT_OBJECT_0 &&
                  WaitForSingleObject(run.release.value, 0) == WAIT_TIMEOUT, "validation_fault_gate_entered");
      const ValidationStateView before = ValidationState();
      if (queued) {
        Require(!before.started && before.active == 0 && !before.queued && validation_file_reads.load() == 0 &&
                    !WindowsTargetListWorkerRunning().load(), "validation_queued_frame_has_no_worker");
      } else {
        const auto pending = ValidationPending(true);
        Require(pending != nullptr, "validation_first_job_recorded");
        first_job = pending->job_id;
        Require(before.started && before.active == first_job && !before.queued &&
                    before.thread == validation_thread_id.load() && validation_workers.load() == 1 &&
                    validation_file_reads.load() == 1 && validation_file_successes.load() == 0 &&
                    WindowsTargetListWorkerRunning().load(), "validation_owned_duplicate_held");
      }
      if (cancel) {
        const std::uint64_t serial = WindowsTargetListControl().stop_serial.load();
        const ULONGLONG sent = GetTickCount64();
        run.Send(MessageType::kCancel, 3, "{\"cancelEpoch\":2}");
        Require(WaitStopSerial(serial, 1000) && run.Wait(2, 1000) && run.PreflightDenied(2) &&
                    run.Wait(3, 1000) && run.Receipt(3, MessageType::kDispatchResult, "canceled", 2),
                "validation_cancel_alone_drains_before_close");
        stop_ms = GetTickCount64() - sent;
        Require(stop_ms < 1000 && validation_file_successes.load() == 0 &&
                    WaitForSingleObject(run.release.value, 0) == WAIT_TIMEOUT,
                "validation_cancel_ack_while_real_read_held");
        const ValidationProbeResult busy = RunValidationProbe(run, 6, "normal");
        const ValidationStateView after = ValidationState();
        Require(!busy.available && !busy.matches && after.active == first_job && after.next == before.next &&
                    !after.queued && after.thread == before.thread && validation_file_reads.load() == 1 &&
                    validation_workers.load() == 1, "validation_fresh_busy_request_enqueues_nothing");
      }
      // For Close-only and prequeued Close no Cancel frame has been sent.
      const std::uint64_t serial = WindowsTargetListControl().stop_serial.load();
      const ULONGLONG close_sent = GetTickCount64();
      run.Send(MessageType::kProbe, 4, "{\"operation\":\"close_session\",\"cancelEpoch\":" +
          std::to_string(cancel ? 3 : 2) + "}");
      Require(WaitStopSerial(serial, 1000), "validation_close_reader_progress");
      if (queued) {
        Require(cancellation_epoch.load() == 1 && validation_workers.load() == 0, "validation_close_prequeued_serial_only");
        hold_point.store(HoldPoint::kNone);
        SetEvent(run.release.value);
      }
      Require(run.Wait(2, 1000) && run.PreflightDenied(2) && run.Wait(4, 1000) &&
                  run.Receipt(4, MessageType::kProbeResult, "closed", cancel ? 3 : 2), "validation_close_drains");
      close_ms = GetTickCount64() - close_sent;
      Require(close_ms < 1000 && !sessions.contains(FrameIdKey(Id(7))) &&
                  !ticket_states.contains(FrameIdKey(Id(7))), "validation_original_session_closed_without_ticket");
      if (!queued) {
        Require(validation_file_successes.load() == 0 && WindowsTargetListWorkerRunning().load() &&
                    WaitForSingleObject(run.release.value, 0) == WAIT_TIMEOUT,
                "validation_close_precedes_duplicate_read_release");
        validation_gate_read.store(0);
        SetEvent(run.release.value);
        const auto pending = ValidationPending(true);
        Require(run.WaitWorkerIdle(15'000) && WaitValidationDone(pending, 1000), "validation_old_job_drained");
        {
          std::lock_guard lock(pending->mutex);
          Require(pending->abandoned.load() && !pending->result.identity_matches,
                  "validation_late_result_not_adopted");
        }
        Require(validation_file_reads.load() == 1 && validation_file_successes.load() == 1 &&
                    validation_retired_jobs.load() == 1 && validation_last_retired_id.load() == first_job &&
                    run.ReplyCount(2) == 1, "validation_real_duplicate_read_after_close");
      } else {
        Require(!ValidationState().started && validation_file_reads.load() == 0 &&
                    validation_workers.load() == 0, "validation_prequeued_close_creates_no_job");
      }
      if (cancel) {
        ResetEvent(run.entered.value);
        ResetEvent(run.release.value);
        validation_gate_read.store(2);
        run.Send(MessageType::kProbe, 20, "{\"operation\":\"sc940_validation_probe\",\"mode\":\"normal\"}");
        Require(WaitForSingleObject(run.entered.value, 5000) == WAIT_OBJECT_0, "validation_next_job_held");
        const auto next = ValidationPending(false);
        Require(next != nullptr && next->job_id != first_job, "validation_next_job_has_new_id");
        next_job = next->job_id;
        const ValidationStateView active = ValidationState();
        const unsigned attempts = validation_cancel_attempts.load();
        Require(active.active == next_job && active.thread == before.thread && !active.queued &&
                    attempts > 0 && validation_last_cancel_id.load() == first_job &&
                    WindowsTargetListWorkerRunning().load(), "validation_same_physical_thread_new_job");
        CancelWindowsValidationJob(first_job);
        const ValidationStateView unchanged = ValidationState();
        Require(validation_cancel_attempts.load() == attempts && unchanged.active == next_job &&
                    unchanged.thread == active.thread && WindowsTargetListWorkerRunning().load() &&
                    WaitForSingleObject(run.release.value, 0) == WAIT_TIMEOUT,
                "validation_old_id_cannot_cancel_next_job");
        validation_gate_read.store(0);
        SetEvent(run.release.value);
        ValidationProbeResult fresh;
        Require(run.Wait(20, 5000) && run.ValidationReply(20, &fresh) && fresh.available && fresh.matches &&
                    WaitValidationDone(next, 1000) && validation_file_successes.load() == 2,
                "validation_explicit_retry_survives_old_cancel");
        const ValidationProbeResult repeated = RunValidationProbe(run, 21, "repeat");
        Require(repeated.available && repeated.matches && repeated.successes == 16 &&
                    validation_file_reads.load() == 18 && validation_file_successes.load() == 18 &&
                    validation_retired_jobs.load() == 18, "validation_reused_worker_never_caches");
        repeat_ms = repeated.elapsed_ms;
        repeat_calls = 16;
      } else {
        validation_gate_read.store(0);
        const ValidationProbeResult fresh = RunValidationProbe(run, 20, "normal");
        Require(fresh.available && fresh.matches && validation_file_successes.load() == (queued ? 1u : 2u),
                "validation_fresh_read_after_cleanup");
      }
    }
    const ValidationStateView idle = ValidationState();
    Require(run.WaitWorkerIdle(1000) && idle.active == 0 && !idle.queued && idle.thread == 0 && idle.started &&
                validation_workers.load() == 1 && !wrong_measurement.load() && !gate_timed_out.load(),
            "validation_jobs_and_duplicate_cleanup_complete");
    run.Cleanup();
    Require(run.child_exited && run.worker_idle && !run.watchdog_fired.load(), "validation_fixture_cleanup");
    // The reusable native thread is intentionally idle until helper exit. threadsJoined refers
    // only to this harness's pipe/reader/watchdog threads, not that persistent native worker.
    std::cout << "{\"case\":\"" << label << "\",\"stopMs\":" << stop_ms << ",\"closeMs\":" << close_ms
              << ",\"primitiveCostOnly\":true,\"stopPath\":\"" << (repeat ? "none" : "preflight_validate")
              << "\",\"inputLatencyMeasured\":false,\"repeatCalls\":" << repeat_calls
              << ",\"repeatMs\":" << repeat_ms << ",\"fileReads\":" << validation_file_reads.load()
              << ",\"fileReadSuccesses\":" << validation_file_successes.load()
              << ",\"validationWorkerThreads\":" << validation_workers.load()
              << ",\"validationRetiredJobs\":" << validation_retired_jobs.load()
              << ",\"instrumentedPrimitiveTiming\":true"
              << ",\"fixtureLaunchPathCanonicalized\":" << (run.fixture_launch_path_canonicalized ? "true" : "false")
              << ",\"fixtureProcessPathMatchesHeld\":true"
              << ",\"cancelAttempts\":" << validation_cancel_attempts.load() << ",\"firstJobId\":" << first_job
              << ",\"reusedJobId\":" << next_job << ",\"validationJobDrained\":true,\"duplicateCleanupObserved\":true"
              << ",\"validationWorkerJoined\":false,\"joinedThreads\":\"pipe-reader-watchdog\",\"inputAttempts\":0"
              << ",\"childExited\":true,\"threadsJoined\":true,\"workerIdle\":true,\"watchdogFired\":false}\n";
    return 0;
  } catch (const std::exception &error) {
    run.Cleanup();
    std::cout << "{\"case\":\"" << label << "\",\"failure\":\"" << error.what() << "\"}\n";
    return 1;
  }
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
  if (argc == 4 && std::wstring_view(argv[1]) == L"start-coordinator") return CoordinateStart(argv[2], argv[3]);
  if (argc == 8 && std::wstring_view(argv[1]) == L"start-client") {
    const std::wstring started(argv[5]);
    return DiagnoseStart(argv[2], static_cast<DWORD>(std::stoul(argv[3])),
        reinterpret_cast<HWND>(static_cast<UINT_PTR>(std::stoull(argv[4]))),
        std::string(started.begin(), started.end()), argv[6], std::wstring_view(argv[7]) == L"1");
  }
  if (argc != 2) return 2;
  if (std::wstring_view(argv[1]).starts_with(L"validation-")) return DiagnoseValidation(argv[1]);
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
    expect(
      generated.split('!Sc940StartOpen(target_process->value, process_executable)'),
    ).toHaveLength(2);
    expect(generated.split('    Sc940StartReadyGate();')).toHaveLength(2);
    expect(generated.split('  Sc940StartAdoptGate();')).toHaveLength(2);
    expect(generated.split('        Sc940StartEpilogueGate();')).toHaveLength(2);
    expect(generated.split('    Sc940StartWorkerAttempt();')).toHaveLength(2);
    expect(generated.split('!Sc940ValidationFileIdentity(work, &held_file_identity)')).toHaveLength(
      2,
    );
    expect(generated.split('  Sc940ValidationWorkerStarted();')).toHaveLength(2);
    expect(
      generated.split(
        'Sc940ValidationCancelAttempt(job_id, GetThreadId(state.cancellation_thread));',
      ),
    ).toHaveLength(2);
    expect(generated.split('    Sc940ValidationRetired(job_id);')).toHaveLength(2);
    expect(program).toContain(
      'const bool read = ReadWindowsFileIdentity(work.executable.value, identity);',
    );
    expect(program).toContain('const bool opened = OpenLockedProcessExecutable(process, output);');
    expect(program).toContain('windows_v2_main_pid = GetCurrentProcessId();');
    expect(program).not.toContain('keybd_event(');
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
    let installed: string | undefined;
    try {
      const localAppData = process.env['LOCALAPPDATA'];
      if (!localAppData)
        throw new Error('LOCALAPPDATA is required for the real V2 application root');
      const programs = join(localAppData, 'Programs');
      mkdirSync(programs, { recursive: true });
      installed = mkdtempSync(join(programs, 'sc940-start-'));
      const fixtureAppDirectory = installed;
      const fixtureDirectory = join(nativeDirectory, 'fixtures/win32-acceptance');
      const fixtureExecutable = join(installed, 'sprint-coder-computer-use-fixture.exe');
      const fixtureBuild = await run(
        build!.file,
        build!.args([
          '/nologo',
          '/std:c++20',
          '/EHsc',
          '/O2',
          '/MT',
          '/W4',
          '/GS',
          '/permissive-',
          '/utf-8',
          '/DUNICODE',
          '/D_UNICODE',
          '/DWIN32_LEAN_AND_MEAN',
          '/D_WIN32_WINNT=0x0A00',
          `/I${fixtureDirectory}`,
          join(fixtureDirectory, 'win32_acceptance_fixture.cc'),
          `/Fo:${join(root, 'start-fixture.obj')}`,
          `/Fe:${fixtureExecutable}`,
          '/link',
          '/SUBSYSTEM:WINDOWS,10.00',
          '/MANIFEST:EMBED',
          `/MANIFESTINPUT:${join(fixtureDirectory, 'win32_acceptance_fixture.manifest')}`,
          'user32.lib',
          'gdi32.lib',
          'comctl32.lib',
          'comdlg32.lib',
          'shell32.lib',
        ]),
        400_000,
        build!.verbatim,
      );
      expect(fixtureBuild.timedOut, 'GUI fixture compilation deadline').toBe(false);
      const fixtureCompileErrors = `${fixtureBuild.stdout}\n${fixtureBuild.stderr}`
        .split(/\r?\n/u)
        .filter((line) => /\berror (?:C|LNK)\d+:/u.test(line))
        .map((line) =>
          line
            .replaceAll(root, '<fixture>')
            .replaceAll(fixtureAppDirectory, '<fixture-app>')
            .replaceAll(nativeDirectory, '<native>'),
        )
        .join('\n')
        .slice(0, 8_000);
      expect(
        fixtureBuild.status,
        `Unsigned GUI fixture must compile\n${fixtureCompileErrors}`,
      ).toBe(0);
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
      const startFailures: string[] = [];
      const validationFailures: string[] = [];
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
        'start-open-close',
        'start-prequeued-close',
        'start-open-cancel',
        'start-healthy',
        'start-ready-close',
        'start-adopt-close',
        'validation-cancel',
        'validation-close',
        'validation-prequeued-close',
        'validation-repeat',
      ]) {
        const result = await run(
          binary,
          scenario.startsWith('start-')
            ? ['start-coordinator', scenario, fixtureExecutable]
            : [scenario],
          70_000,
        );
        if (scenario.startsWith('validation-')) {
          const failure = /"failure":"([a-z_]+)"/u.exec(result.stdout)?.[1];
          if (result.timedOut) {
            validationFailures.push(`${scenario}: outer_watchdog`);
            continue;
          }
          let metadata: unknown;
          try {
            metadata = JSON.parse(result.stdout.trim());
          } catch {
            validationFailures.push(`${scenario}: invalid_metadata`);
            continue;
          }
          console.log(JSON.stringify(metadata));
          if (result.status !== 0) {
            validationFailures.push(`${scenario}: ${failure ?? 'native_assertion'}`);
            continue;
          }
          try {
            expect(metadata).toMatchObject({
              case: scenario,
              primitiveCostOnly: true,
              stopPath: scenario === 'validation-repeat' ? 'none' : 'preflight_validate',
              inputLatencyMeasured: false,
              fixtureProcessPathMatchesHeld: true,
              validationWorkerThreads: 1,
              validationRetiredJobs:
                scenario === 'validation-cancel'
                  ? 18
                  : scenario === 'validation-close'
                    ? 2
                    : scenario === 'validation-repeat'
                      ? 21
                      : 1,
              instrumentedPrimitiveTiming: true,
              validationJobDrained: true,
              duplicateCleanupObserved: true,
              validationWorkerJoined: false,
              joinedThreads: 'pipe-reader-watchdog',
              inputAttempts: 0,
              childExited: true,
              threadsJoined: true,
              workerIdle: true,
              watchdogFired: false,
            });
          } catch {
            validationFailures.push(`${scenario}: metadata_assertion`);
          }
          // Process exit is distinct from the persistent native worker being idle above.
          console.log(
            JSON.stringify({ case: scenario, kind: 'helper_exit', helperProcessExited: true }),
          );
          continue;
        }
        if (scenario.startsWith('start-')) {
          const failure = /"failure":"([a-z_]+)"/u.exec(result.stdout)?.[1];
          if (result.timedOut) {
            startFailures.push(`${scenario}: outer_watchdog`);
            continue;
          }
          let metadata: unknown;
          try {
            metadata = JSON.parse(result.stdout.trim());
          } catch {
            startFailures.push(`${scenario}: invalid_metadata`);
            continue;
          }
          // Preserve Stop-phase evidence even when a later foreground prerequisite is unavailable.
          console.log(JSON.stringify(metadata));
          if (result.status !== 0) {
            startFailures.push(`${scenario}: ${failure ?? 'native_assertion'}`);
            continue;
          }
          try {
            expect(metadata).toMatchObject({
              case: scenario,
              stopProof: scenario !== 'start-healthy',
              lateCleanupVerified: scenario !== 'start-healthy',
              healthyStartVerified:
                scenario === 'start-healthy' || scenario === 'start-open-cancel',
              lateAdoptionDiscarded: scenario !== 'start-healthy',
              slotHandoffVerified: scenario === 'start-healthy',
              inputAttempts: 0,
              childExited: true,
              threadsJoined: true,
              workerIdle: true,
              watchdogFired: false,
            });
          } catch {
            startFailures.push(`${scenario}: metadata_assertion`);
          }
          continue;
        }
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
      expect(
        [...startFailures, ...validationFailures],
        'Every start and validation case must pass, including foreground prerequisites',
      ).toEqual([]);
    } finally {
      if (installed)
        rmSync(installed, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
      rmSync(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    }
  }, 700_000);
});
