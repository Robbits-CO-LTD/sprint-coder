import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Diagnostic only (#940): identical identity I/O on this test process and its held executable.
// This measures dispatch overhead, not input latency. No typing, window, UIA, or eligibility test
// runs here. The 7/9 checks per scalar are call-count models, not actual text input.
// A borrows the existing session/handles. B/C include the same per-call value snapshot allocation,
// two handle duplicates, I/O, and confirmed duplicate cleanup. C caches no validation result.
const nativeDirectory = join(__dirname, '../../computer-use-native');
const host = readFileSync(join(nativeDirectory, 'computer_use_windows_host.cc'), 'utf8');

type Build = { file: string; args: (values: string[]) => string[]; verbatim: boolean };
function compiler(): Build | null {
  if (process.platform !== 'win32') return null;
  if (spawnSync('cl.exe', ['/?'], { stdio: 'ignore' }).status === 0)
    return { file: 'cl.exe', args: (values) => values, verbatim: false };
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
    args: (values) => [
      '/d',
      '/s',
      '/c',
      `"call "${vcvars}" >nul && cl.exe ${values.map((value) => `"${value}"`).join(' ')}"`,
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
      let stdout = '',
        stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
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
#define wmain sc940_validation_original_wmain
#include "computer_use_windows_host.cc"
#undef wmain
#include <iomanip>
#include <memory>

namespace {
using Clock = std::chrono::steady_clock;
struct Failure { const char *code; };
void Require(bool condition, const char *code) { if (!condition) throw Failure{code}; }
double Milliseconds(Clock::duration value) { return std::chrono::duration<double, std::milli>(value).count(); }

struct Watchdog {
  ScopedKernelHandle finished{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  std::thread thread;
  Watchdog() {
    Require(finished.value != nullptr, "watchdog_event");
    thread = std::thread([this] {
      if (WaitForSingleObject(finished.value, 120'000) != WAIT_OBJECT_0)
        TerminateProcess(GetCurrentProcess(), 90);
    });
  }
  ~Watchdog() { SetEvent(finished.value); if (thread.joinable()) thread.join(); }
};

struct Ledger {
  std::atomic<std::uint64_t> duplicates{0}, closes{0}, close_failures{0};
  std::atomic<std::uint64_t> fresh_starts{0}, reusable_starts{0}, io_calls{0};
};

// The entire identity interval is read on every call, including when elevation is denied. This
// keeps the amount of I/O equal and distinguishes a failed identity read from the same false result.
std::uint32_t ReadIdentity(const WindowsSession &session, Ledger &ledger) {
  ledger.io_calls.fetch_add(1);
  std::string current_start;
  std::wstring current_path;
  WindowsFileIdentity file{};
  const bool process = WindowsSessionProcessMatches(session);
  const bool start_read = ReadProcessStartIdentity(session.process_handle, &current_start);
  const bool start_matches = current_start == session.process_start;
  const bool path_read = ReadProcessPath(session.process_handle, &current_path);
  const bool path_matches = SameWindowsPath(current_path, session.canonical_path);
  const bool file_read = ReadWindowsFileIdentity(session.executable_file, &file);
  const bool file_matches = file.volume_serial == session.executable_volume_serial &&
      std::memcmp(file.file_id.Identifier, session.executable_file_id.Identifier,
                  sizeof(file.file_id.Identifier)) == 0;
  const bool unelevated = !IsProcessElevated(session.pid);
  return (process ? 1u : 0u) | (start_read ? 2u : 0u) | (start_matches ? 4u : 0u) |
      (path_read ? 8u : 0u) | (path_matches ? 16u : 0u) | (file_read ? 32u : 0u) |
      (file_matches ? 64u : 0u) | (unelevated ? 128u : 0u);
}

struct Duplicate {
  Ledger &ledger;
  HANDLE value = nullptr;
  explicit Duplicate(Ledger &counts) : ledger(counts) {}
  Duplicate(const Duplicate &) = delete;
  Duplicate &operator=(const Duplicate &) = delete;
  bool Open(HANDLE source) {
    if (!DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), &value,
                         0, FALSE, DUPLICATE_SAME_ACCESS)) return false;
    ledger.duplicates.fetch_add(1);
    return true;
  }
  bool Close() noexcept {
    const HANDLE held = value;
    value = nullptr;
    if (held == nullptr) return true;
    if (CloseHandle(held)) { ledger.closes.fetch_add(1); return true; }
    ledger.close_failures.fetch_add(1);
    return false;
  }
  ~Duplicate() { Close(); }
};

struct IdentityJob {
  // A local value snapshot, never an entry of the native sessions/tickets maps. The source has
  // no input counter or observation data. B and C perform exactly this same copy on every call.
  WindowsSession snapshot;
  Duplicate process, executable;
  std::uint32_t result = 0;
  bool failed = false, done = false;
  IdentityJob(const WindowsSession &source, Ledger &ledger)
      : snapshot(source), process(ledger), executable(ledger) {}
  bool Prepare() {
    if (!process.Open(snapshot.process_handle) || !executable.Open(snapshot.executable_file)) {
      failed = true;
      Close();
      return false;
    }
    snapshot.process_handle = process.value;
    snapshot.executable_file = executable.value;
    return true;
  }
  void Close() noexcept {
    const bool process_closed = process.Close();
    const bool file_closed = executable.Close();
    if (!process_closed || !file_closed) failed = true;
    snapshot.process_handle = nullptr;
    snapshot.executable_file = INVALID_HANDLE_VALUE;
  }
  void Execute(Ledger &ledger) noexcept {
    try { result = ReadIdentity(snapshot, ledger); } catch (...) { failed = true; }
    // Completion is published only after both real duplicate closes have finished.
    Close();
  }
};

class ReusableWorker {
 public:
  explicit ReusableWorker(Ledger &ledger) : ledger_(ledger) {
    thread_ = std::thread([this] {
      ledger_.reusable_starts.fetch_add(1);
      {
        std::lock_guard lock(mutex_);
        started_ = true;
      }
      ready_.notify_one();
      for (;;) {
        std::shared_ptr<IdentityJob> job;
        {
          std::unique_lock lock(mutex_);
          ready_.wait(lock, [&] { return stopping_ || pending_ != nullptr; });
          if (pending_ == nullptr && stopping_) break;
          job = std::move(pending_);
        }
        job->Execute(ledger_);
        {
          std::lock_guard lock(mutex_);
          job->done = true;
          // The caller owns the remaining reference before it can wake, so its timed call also
          // includes destruction of the snapshot. No result is retained for the next request.
          job.reset();
        }
        ready_.notify_one();
      }
      exited_.store(true, std::memory_order_release);
    });
    try {
      std::unique_lock lock(mutex_);
      ready_.wait(lock, [&] { return started_; });
    } catch (...) { Shutdown(); throw; }
  }
  void Submit(const std::shared_ptr<IdentityJob> &job) {
    std::unique_lock lock(mutex_);
    Require(!stopping_ && pending_ == nullptr, "single_flight_submission");
    pending_ = job;
    ready_.notify_one();
    ready_.wait(lock, [&] { return job->done; });
  }
  void Shutdown() {
    if (!thread_.joinable()) return;
    {
      std::lock_guard lock(mutex_);
      stopping_ = true;
    }
    ready_.notify_one();
    thread_.join();
  }
  bool Exited() const { return exited_.load(std::memory_order_acquire) && !thread_.joinable(); }
  ~ReusableWorker() { Shutdown(); }
 private:
  Ledger &ledger_;
  std::mutex mutex_;
  std::condition_variable ready_;
  bool started_ = false, stopping_ = false;
  std::shared_ptr<IdentityJob> pending_;
  std::atomic<bool> exited_{false};
  std::thread thread_;
};

enum class Mode { kSync, kFresh, kReuse };
const char *ModeName(Mode mode) {
  switch (mode) {
  case Mode::kSync: return "sync";
  case Mode::kFresh: return "fresh_thread";
  case Mode::kReuse: return "reused_worker";
  }
  return "invalid";
}

bool Once(Mode mode, const WindowsSession &source, std::uint32_t expected, Ledger &ledger,
          ReusableWorker &worker) {
  if (mode == Mode::kSync) {
    // The current consumer baseline: no snapshot/job allocation, duplicate, or worker.
    try { return ReadIdentity(source, ledger) == expected; } catch (...) { return false; }
  }
  const auto job = std::make_shared<IdentityJob>(source, ledger);
  if (!job->Prepare()) return false;
  if (mode == Mode::kFresh) {
    std::thread thread;
    try {
      thread = std::thread([job, &ledger] { ledger.fresh_starts.fetch_add(1); job->Execute(ledger); });
      thread.join();
    } catch (...) {
      if (thread.joinable()) thread.join();
      job->failed = true;
      job->Close();
    }
  } else {
    worker.Submit(job);
  }
  return !job->failed && job->result == expected;
}

int Benchmark() {
  Watchdog watchdog;
  Ledger ledger;
  ScopedKernelHandle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
                                         FALSE, GetCurrentProcessId()));
  LockedWindowsExecutable executable;
  Require(process.value != nullptr && GetProcessId(process.value) == GetCurrentProcessId() &&
              OpenLockedProcessExecutable(process.value, &executable), "own_process_and_image");
  WindowsSession source;
  source.input_api_attempts.reset();
  source.pid = GetCurrentProcessId();
  source.process_handle = process.value;
  source.executable_file = executable.file;
  source.canonical_path = executable.identity.path;
  source.executable_volume_serial = executable.identity.file_identity.volume_serial;
  source.executable_file_id = executable.identity.file_identity.file_id;
  Require(ReadProcessStartIdentity(process.value, &source.process_start), "own_process_start");
  const std::uint32_t expected = ReadIdentity(source, ledger);
  Require((expected & 127u) == 127u, "baseline_identity_reads");

  const auto startup = Clock::now();
  ReusableWorker worker(ledger);
  const double startup_ms = Milliseconds(Clock::now() - startup);
  constexpr unsigned kWarmupCalls = 32, kScalars = 32, kSamples = 3;
  constexpr std::array<Mode, 3> modes{Mode::kSync, Mode::kFresh, Mode::kReuse};
  std::uint64_t failures = 0;
  for (const Mode mode : modes)
    for (unsigned call = 0; call < kWarmupCalls; ++call)
      if (!Once(mode, source, expected, ledger, worker)) ++failures;
  Require(failures == 0 && ledger.duplicates.load() == ledger.closes.load(), "warmup_results_and_cleanup");

  struct Workload { const char *name; unsigned checks; };
  constexpr Workload workloads[]{{"ascii", 7}, {"bmp_japanese", 7}, {"supplementary", 9}};
  std::cout << std::fixed << std::setprecision(3);
  for (const auto &workload : workloads) {
    for (unsigned sample = 0; sample < kSamples; ++sample) {
      // Rotate order across the three samples so one mode is not always first or last.
      for (unsigned offset = 0; offset < modes.size(); ++offset) {
        const Mode mode = modes[(sample + offset) % modes.size()];
        const unsigned calls = kScalars * workload.checks;
        const auto io_before = ledger.io_calls.load();
        const auto starts_before = ledger.fresh_starts.load() + ledger.reusable_starts.load();
        const auto duplicates_before = ledger.duplicates.load(), closes_before = ledger.closes.load();
        std::uint64_t mismatches = 0;
        const auto started = Clock::now();
        for (unsigned call = 0; call < calls; ++call)
          if (!Once(mode, source, expected, ledger, worker)) ++mismatches;
        const double elapsed_ms = Milliseconds(Clock::now() - started);
        const auto actual_calls = ledger.io_calls.load() - io_before;
        const auto starts = ledger.fresh_starts.load() + ledger.reusable_starts.load() - starts_before;
        const auto duplicates = ledger.duplicates.load() - duplicates_before;
        const auto closes = ledger.closes.load() - closes_before;
        const std::uint64_t expected_duplicates = mode == Mode::kSync ? 0 : 2 * calls;
        if (actual_calls != calls || duplicates != expected_duplicates || closes != duplicates ||
            starts != (mode == Mode::kFresh ? calls : 0)) ++mismatches;
        failures += mismatches;
        std::cout << "{\"kind\":\"sample\",\"mode\":\"" << ModeName(mode)
                  << "\",\"workload\":\"" << workload.name << "\",\"sample\":" << sample + 1
                  << ",\"scalarsEquivalent\":" << kScalars << ",\"checksPerScalar\":" << workload.checks
                  << ",\"calls\":" << actual_calls << ",\"threadStarts\":" << starts
                  << ",\"duplicateHandles\":" << duplicates << ",\"closedHandles\":" << closes
                  << ",\"failures\":" << mismatches << ",\"totalMs\":" << elapsed_ms << "}\n";
      }
    }
  }
  const auto shutdown = Clock::now();
  worker.Shutdown();
  const double shutdown_ms = Milliseconds(Clock::now() - shutdown);
  const bool joined = worker.Exited();
  source.process_handle = nullptr;
  source.executable_file = INVALID_HANDLE_VALUE;
  const HANDLE file = executable.file;
  executable.file = INVALID_HANDLE_VALUE;
  const bool file_closed = CloseHandle(file) != FALSE;
  const bool process_closed = CloseHandle(process.release()) != FALSE;
  const bool cleaned = joined && file_closed && process_closed && ledger.close_failures.load() == 0 &&
      ledger.duplicates.load() == ledger.closes.load();
  std::cout << "{\"kind\":\"cleanup\",\"diagnosticOnly\":true,\"inputExecuted\":false,\"baselineIdentityMask\":"
            << expected << ",\"warmupCallsPerMode\":" << kWarmupCalls
            << ",\"callsIncludingBaselineAndWarmup\":" << ledger.io_calls.load()
            << ",\"freshThreadStarts\":" << ledger.fresh_starts.load()
            << ",\"reusedWorkerStarts\":" << ledger.reusable_starts.load()
            << ",\"duplicateHandles\":" << ledger.duplicates.load() << ",\"closedHandles\":" << ledger.closes.load()
            << ",\"closeFailures\":" << ledger.close_failures.load() << ",\"failures\":" << failures
            << ",\"workerStartupMs\":" << startup_ms << ",\"workerShutdownMs\":" << shutdown_ms
            << ",\"workerJoined\":" << (joined ? "true" : "false")
            << ",\"baseHandlesClosed\":" << (file_closed && process_closed ? "true" : "false")
            << ",\"cleanupVerified\":" << (cleaned ? "true" : "false") << "}\n";
  return failures == 0 && cleaned ? 0 : 1;
}
} // namespace

int wmain() {
  try { return Benchmark(); }
  catch (const Failure &failure) { std::cout << "{\"kind\":\"failure\",\"code\":\"" << failure.code << "\"}\n"; }
  catch (...) { std::cout << "{\"kind\":\"failure\",\"code\":\"unexpected_exception\"}\n"; }
  return 1;
}
`;

type Mode = 'sync' | 'fresh_thread' | 'reused_worker';
type Workload = 'ascii' | 'bmp_japanese' | 'supplementary';
type Sample = {
  kind: 'sample';
  mode: Mode;
  workload: Workload;
  sample: number;
  scalarsEquivalent: number;
  checksPerScalar: number;
  calls: number;
  threadStarts: number;
  duplicateHandles: number;
  closedHandles: number;
  failures: number;
  totalMs: number;
};
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function sample(value: unknown): value is Sample {
  return (
    record(value) &&
    value['kind'] === 'sample' &&
    typeof value['mode'] === 'string' &&
    ['sync', 'fresh_thread', 'reused_worker'].includes(value['mode']) &&
    typeof value['workload'] === 'string' &&
    ['ascii', 'bmp_japanese', 'supplementary'].includes(value['workload']) &&
    [
      'sample',
      'scalarsEquivalent',
      'checksPerScalar',
      'calls',
      'threadStarts',
      'duplicateHandles',
      'closedHandles',
      'failures',
      'totalMs',
    ].every(
      (key) => typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0,
    )
  );
}

describe('Windows validation I/O benchmark source', () => {
  it('uses the real identity interval on its own target without input or UI APIs', () => {
    const begin = host.indexOf('bool ValidateWindowsSession(');
    const end = host.indexOf('bool ReadExact(', begin);
    expect(begin).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(begin);
    for (const name of [
      'WindowsSessionProcessMatches',
      'ReadProcessStartIdentity',
      'ReadProcessPath',
      'SameWindowsPath',
      'ReadWindowsFileIdentity',
      'IsProcessElevated',
    ]) {
      expect(host.slice(begin, end)).toContain(`${name}(`);
      expect(program).toContain(`${name}(`);
    }
    expect(program).toContain('OpenLockedProcessExecutable(process.value, &executable)');
    expect(program).toContain('source.pid = GetCurrentProcessId();');
    expect(program).not.toMatch(
      /\b(?:EnumWindows|SendInput|SetForegroundWindow|SetFocus|ReadUiaObservation|CoCreateInstance|CreateProcessW)\s*\(/u,
    );
    expect(program).not.toMatch(
      /#define\s+(?:OpenProcess|ReadFile|DuplicateHandle|CloseHandle)\b/u,
    );
  });
});

const build = compiler();
describe.skipIf(process.platform !== 'win32')(
  'Windows validation I/O diagnostic benchmark (#940)',
  () => {
    it('compares sync, fresh threads, and one uncached worker with real handle cleanup', async () => {
      expect(build, 'MSVC is required to run this diagnostic').not.toBeNull();
      const root = mkdtempSync(join(tmpdir(), 'computer-use-validation-io-bench-'));
      try {
        const source = join(root, 'bench.cc'),
          binary = join(root, 'bench.exe');
        const provenance = join(root, 'provenance.h');
        writeFileSync(source, program);
        writeFileSync(
          provenance,
          '#pragma once\n#define SPRINT_CODER_SOURCE_COMMIT "0000000000000000000000000000000000000000"\n',
        );
        const compiled = await run(
          build!.file,
          build!.args([
            '/nologo',
            '/std:c++20',
            '/EHsc',
            '/O2',
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
          ]),
          500_000,
          build!.verbatim,
        );
        const compileErrors = `${compiled.stdout}\n${compiled.stderr}`
          .split(/\r?\n/u)
          .filter((line) => /\berror (?:C|LNK)\d+:/u.test(line))
          .map((line) => line.replaceAll(root, '<bench>').replaceAll(nativeDirectory, '<native>'))
          .join('\n')
          .slice(0, 8_000);
        expect(compiled.timedOut, 'Benchmark compilation deadline').toBe(false);
        expect(compiled.status, `Benchmark must compile with MSVC\n${compileErrors}`).toBe(0);
        const executed = await run(binary, [], 150_000);
        expect(executed.timedOut, 'Benchmark outer watchdog').toBe(false);
        const rows: Sample[] = [];
        let cleanup: unknown;
        const lines = executed.stdout.trim().split(/\r?\n/u).filter(Boolean);
        expect(lines.length, `Native benchmark exit ${executed.status}`).toBeGreaterThan(0);
        for (const line of lines) {
          const value: unknown = JSON.parse(line);
          expect(record(value)).toBe(true);
          if (sample(value)) {
            rows.push(value);
            console.log(JSON.stringify(value));
          } else if (record(value) && value['kind'] === 'cleanup') {
            cleanup = value;
            console.log(JSON.stringify(value));
          } else if (
            record(value) &&
            value['kind'] === 'failure' &&
            typeof value['code'] === 'string' &&
            /^[a-z_]+$/u.test(value['code'])
          ) {
            throw new Error(`Native diagnostic failure: ${value['code']}`);
          } else {
            throw new Error('Unexpected native diagnostic metadata');
          }
        }
        expect(executed.status, 'Native benchmark and cleanup').toBe(0);
        expect(rows).toHaveLength(27);
        expect(cleanup).toMatchObject({
          kind: 'cleanup',
          diagnosticOnly: true,
          inputExecuted: false,
          warmupCallsPerMode: 32,
          callsIncludingBaselineAndWarmup: 6721,
          freshThreadStarts: 2240,
          reusedWorkerStarts: 1,
          duplicateHandles: 8960,
          closedHandles: 8960,
          closeFailures: 0,
          failures: 0,
          workerJoined: true,
          baseHandlesClosed: true,
          cleanupVerified: true,
        });
        for (const row of rows) {
          const checks = row.workload === 'supplementary' ? 9 : 7;
          const calls = 32 * checks;
          expect(row).toMatchObject({
            scalarsEquivalent: 32,
            checksPerScalar: checks,
            calls,
            failures: 0,
            threadStarts: row.mode === 'fresh_thread' ? calls : 0,
            duplicateHandles: row.mode === 'sync' ? 0 : 2 * calls,
            closedHandles: row.mode === 'sync' ? 0 : 2 * calls,
          });
        }
        for (const workload of ['ascii', 'bmp_japanese', 'supplementary'] as const) {
          const baseline = rows
            .filter((row) => row.workload === workload && row.mode === 'sync')
            .map((row) => row.totalMs)
            .sort((a, b) => a - b);
          expect(baseline).toHaveLength(3);
          for (const mode of ['sync', 'fresh_thread', 'reused_worker'] as const) {
            const selected = rows.filter((row) => row.workload === workload && row.mode === mode);
            expect(selected.map((row) => row.sample).sort()).toEqual([1, 2, 3]);
            const times = selected.map((row) => row.totalMs).sort((a, b) => a - b);
            const median = times[1]!;
            console.log(
              JSON.stringify({
                kind: 'summary',
                workload,
                mode,
                samples: 3,
                minMs: times[0],
                medianMs: median,
                maxMs: times[2],
                incrementVsSyncMs: Number((median - baseline[1]!).toFixed(3)),
                diagnosticOnly: true,
                inputLatencyMeasured: false,
                productionDecision: 'pending',
              }),
            );
          }
        }
      } finally {
        rmSync(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
      }
    }, 700_000);
  },
);
