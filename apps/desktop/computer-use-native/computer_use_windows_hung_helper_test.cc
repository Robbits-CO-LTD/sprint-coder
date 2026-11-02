// Test-only entry points; the pipe still runs the production host and hang hook.
#include <windows.h>
#include <cstdio>
#include <cwchar>
#include <string>
#include <string_view>

#if defined(SPRINT_CODER_COMPUTER_USE_TEST_HANG)
// Only the hook's infinite wait is witnessed. No production wait or timeout is replaced.
DWORD WitnessHang(HANDLE event, DWORD timeout) {
  wchar_t path[32768]{};
  const DWORD size = GetModuleFileNameW(nullptr, path, 32768);
  if (size > 0 && size < 32768) {
    std::wstring marker(path, size);
    marker.resize(marker.find_last_of(L"\\/") + 1);
    marker += L"hang-entered.txt";
    HANDLE file = CreateFileW(marker.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr,
                              CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file != INVALID_HANDLE_VALUE) {
      CloseHandle(file);
    }
  }
  return WaitForSingleObject(event, timeout);
}
// The host detects these headers before including the hook. Repeat that detection here because
// the hook is included early solely to witness its wait, then guarded by pragma once.
#if defined(_MSC_VER) && __has_include(<winrt/Windows.Graphics.Capture.h>) && \
    __has_include(<windows.graphics.capture.interop.h>) && \
    __has_include(<windows.graphics.directx.direct3d11.interop.h>)
#define SPRINT_CODER_HAS_WINDOWS_GRAPHICS_CAPTURE 1
#endif
#define WaitForSingleObject WitnessHang
#include "computer_use_windows_test_hang.h"
#undef WaitForSingleObject
#endif

#define wmain ComputerUseHostMain
#include "computer_use_windows_host.cc"
#undef wmain

// Closes only what the seam can prove it opened: a visible top-level window whose title contains
// the seam's unique scratch file name, whose process image is notepad.exe, and whose process was
// created no earlier than the --now value the seam read just before it spawned Notepad. A window of
// an older process (e.g. the person's packaged Notepad that took the file as a new tab) is never
// closed, only counted as not_owned. WM_CLOSE lets Notepad ask about unsaved text; no process is
// terminated. With close false it only counts. Prints {"matched":n,"not_owned":m}.
static int TitledNotepadWindows(bool close, std::wstring_view needle, const wchar_t *spawned) {
  struct TitleQuery {
    std::wstring_view needle;
    bool close;
    ULONGLONG spawned;
    unsigned matched;
    unsigned not_owned;
  } query{needle, close, 0, 0, 0};
  if (query.needle.size() < 16) return 5;
  wchar_t *end = nullptr;
  query.spawned = std::wcstoull(spawned, &end, 10);
  if (end == spawned || *end != L'\0' || query.spawned == 0) return 6;
  EnumWindows([](HWND window, LPARAM parameter) -> BOOL {
    auto *query = reinterpret_cast<TitleQuery *>(parameter);
    if (!IsWindowVisible(window) || GetWindow(window, GW_OWNER) != nullptr) return TRUE;
    wchar_t title[1024]{};
    const int length = GetWindowTextW(window, title, 1024);
    if (length <= 0 || std::wstring_view(title, length).find(query->needle) == std::wstring_view::npos)
      return TRUE;
    DWORD pid = 0;
    GetWindowThreadProcessId(window, &pid);
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (process == nullptr) return TRUE;
    wchar_t image[32768]{};
    DWORD size = 32768;
    const BOOL named = QueryFullProcessImageNameW(process, 0, image, &size);
    FILETIME created{}, exited{}, kernel{}, user{};
    const BOOL timed = GetProcessTimes(process, &created, &exited, &kernel, &user);
    CloseHandle(process);
    constexpr std::wstring_view suffix = L"\\notepad.exe";
    if (!named || size < suffix.size() ||
        _wcsicmp(image + (size - suffix.size()), suffix.data()) != 0)
      return TRUE;
    const ULONGLONG createdAt =
        (static_cast<ULONGLONG>(created.dwHighDateTime) << 32) | created.dwLowDateTime;
    if (!timed || createdAt < query->spawned) {
      query->not_owned += 1;
      return TRUE;
    }
    query->matched += 1;
    if (query->close) PostMessageW(window, WM_CLOSE, 0, 0);
    return TRUE;
  }, reinterpret_cast<LPARAM>(&query));
  std::printf("{\"matched\":%u,\"not_owned\":%u}\n", query.matched, query.not_owned);
  return 0;
}

// --watch-attest: diagnosis of the production helper attestation (#1002 N2-3), run by the seam as
// a separate process because the attestation's execFileSync blocks the seam's own event loop.
// It only reads: the processes it opens are opened for query and memory read alone, and the only
// process it ends is its own PowerShell stage runner (inside the runner's own job).
#include <psapi.h>
#include <atomic>
#include <climits>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <thread>
#include <vector>

namespace attest_watch {

using QuerySystemFn = LONG(WINAPI *)(ULONG, PVOID, ULONG, PULONG);
using QueryProcessFn = LONG(WINAPI *)(HANDLE, ULONG, PVOID, ULONG, PULONG);
struct CountedString {
  USHORT length;
  USHORT maximum;
  PWSTR buffer;
};
// x64 SYSTEM_THREAD_INFORMATION / SYSTEM_PROCESS_INFORMATION (winternl.h is not in this TU).
struct ThreadRow {
  LARGE_INTEGER kernel, user, created;
  ULONG wait_time;
  PVOID start;
  HANDLE process_id, thread_id;
  LONG priority, base_priority;
  ULONG switches, state, wait_reason;
};
struct ProcessRow {
  ULONG next, thread_count;
  LARGE_INTEGER private_working_set;
  ULONG hard_faults, thread_high;
  ULONGLONG cycles;
  LARGE_INTEGER created, user, kernel;
  CountedString image;
  LONG base_priority;
  HANDLE pid, parent;
  ULONG handles, session;
  ULONG_PTR key;
  SIZE_T virtual_sizes[2];
  ULONG page_faults;
  SIZE_T memory[9];
  LARGE_INTEGER io[6];
};
static_assert(sizeof(ThreadRow) == 0x50 && sizeof(ProcessRow) == 0x100, "x64 layout");

constexpr wchar_t kPowerShell[] = L"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
constexpr ULONGLONG kSecond = 10'000'000ULL; // FILETIME units
HANDLE stop_event = nullptr;

ULONGLONG Now() {
  FILETIME now{};
  GetSystemTimePreciseAsFileTime(&now);
  return (static_cast<ULONGLONG>(now.dwHighDateTime) << 32) | now.dwLowDateTime;
}
std::string Fixed(double value) {
  char text[48];
  std::snprintf(text, sizeof(text), "%.3f", value);
  return text;
}
// Epoch milliseconds, the clock the seam compares with its own spawn time.
std::string At(ULONGLONG time) {
  return time == 0 ? "null" : Fixed(static_cast<double>(time - 116444736000000000ULL) / 10000.0);
}
double Since(ULONGLONG from) { return static_cast<double>(Now() - from) / 10000.0; }
std::string Quote(std::string_view text) {
  std::string out = "\"";
  for (const unsigned char c : text) {
    if (c == '"' || c == '\\') {
      out += '\\';
      out += static_cast<char>(c);
    } else if (c < 0x20) {
      char escaped[8];
      std::snprintf(escaped, sizeof(escaped), "\\u%04x", c);
      out += escaped;
    } else {
      out += static_cast<char>(c);
    }
  }
  return out + "\"";
}
std::string Quote(std::wstring_view text) {
  if (text.empty()) return "\"\"";
  const int size = WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()),
                                       nullptr, 0, nullptr, nullptr);
  std::string utf8(size > 0 ? size : 0, '\0');
  if (size > 0)
    WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), utf8.data(), size,
                        nullptr, nullptr);
  return Quote(std::string_view(utf8));
}

// Thread states as "ThreadState:WaitReason" counts; suspended is Waiting (5) for Suspended (5) or
// WrSuspended (12); main is the earliest-created thread.
struct Threads {
  unsigned count = 0;
  unsigned suspended = 0;
  std::string main;
  std::map<std::string, unsigned> states;
  std::string Json() const {
    std::string out = "{\"count\":" + std::to_string(count) +
                      ",\"suspended\":" + std::to_string(suspended) + ",\"main\":" + Quote(main) +
                      ",\"states\":{";
    bool first = true;
    for (const auto &[key, value] : states) {
      if (!first) out += ',';
      first = false;
      out += Quote(key) + ":" + std::to_string(value);
    }
    return out + "}}";
  }
};
struct Row {
  DWORD pid = 0;
  DWORD parent = 0;
  DWORD session = 0;
  ULONGLONG created = 0;
  std::wstring image;
  Threads threads;
};

bool Snapshot(QuerySystemFn query, std::vector<BYTE> *buffer, std::map<DWORD, Row> *rows) {
  LONG status = 0;
  for (int attempt = 0; attempt < 8; ++attempt) {
    ULONG needed = 0;
    status = query(5, buffer->data(), static_cast<ULONG>(buffer->size()), &needed);
    if (status != static_cast<LONG>(0xC0000004L)) break; // STATUS_INFO_LENGTH_MISMATCH
    buffer->resize((std::max)(buffer->size() * 2, static_cast<size_t>(needed) + 65536));
  }
  if (status != 0) return false;
  rows->clear();
  for (size_t offset = 0;;) {
    const auto *process = reinterpret_cast<const ProcessRow *>(buffer->data() + offset);
    Row row;
    row.pid = static_cast<DWORD>(reinterpret_cast<ULONG_PTR>(process->pid));
    row.parent = static_cast<DWORD>(reinterpret_cast<ULONG_PTR>(process->parent));
    row.session = process->session;
    row.created = static_cast<ULONGLONG>(process->created.QuadPart);
    if (process->image.buffer != nullptr)
      row.image.assign(process->image.buffer, process->image.length / sizeof(wchar_t));
    const auto *threads = reinterpret_cast<const ThreadRow *>(process + 1);
    LONGLONG earliest = LLONG_MAX;
    for (ULONG index = 0; index < process->thread_count; ++index) {
      const ThreadRow &thread = threads[index];
      const std::string key =
          std::to_string(thread.state) + ":" + std::to_string(thread.wait_reason);
      row.threads.states[key] += 1;
      row.threads.count += 1;
      if (thread.state == 5 && (thread.wait_reason == 5 || thread.wait_reason == 12))
        row.threads.suspended += 1;
      if (thread.created.QuadPart < earliest) {
        earliest = thread.created.QuadPart;
        row.threads.main = key;
      }
    }
    (*rows)[row.pid] = std::move(row);
    if (process->next == 0) break;
    offset += process->next;
  }
  return true;
}

std::wstring CommandLine(HANDLE process, QueryProcessFn query) {
  std::vector<BYTE> buffer(8192);
  ULONG needed = 0;
  LONG status = query(process, 60, buffer.data(), static_cast<ULONG>(buffer.size()), &needed);
  if (status != 0 && needed > buffer.size() && needed < (1u << 20)) {
    buffer.resize(needed);
    status = query(process, 60, buffer.data(), needed, &needed);
  }
  if (status != 0) return L"";
  const auto *text = reinterpret_cast<const CountedString *>(buffer.data());
  return text->buffer == nullptr ? L"" : std::wstring(text->buffer, text->length / sizeof(wchar_t));
}

// SPRINT_CODER_COMPUTER_USE_HELPER_PID from the process environment (PEB → process parameters).
long long HelperPidFromEnvironment(HANDLE process, QueryProcessFn query, bool *read) {
  struct Basic {
    LONG exit;
    PVOID peb;
    ULONG_PTR affinity;
    LONG priority;
    ULONG_PTR pid, parent;
  } basic{};
  ULONG length = 0;
  if (query(process, 0, &basic, sizeof(basic), &length) != 0 || basic.peb == nullptr) return -1;
  SIZE_T got = 0;
  PVOID parameters = nullptr;
  PVOID environment = nullptr;
  SIZE_T size = 0;
  if (!ReadProcessMemory(process, static_cast<BYTE *>(basic.peb) + 0x20, &parameters,
                         sizeof(parameters), &got) ||
      parameters == nullptr ||
      !ReadProcessMemory(process, static_cast<BYTE *>(parameters) + 0x80, &environment,
                         sizeof(environment), &got) ||
      environment == nullptr ||
      !ReadProcessMemory(process, static_cast<BYTE *>(parameters) + 0x3F0, &size, sizeof(size),
                         &got) ||
      size == 0 || size > (1u << 20))
    return -1;
  std::wstring block(size / sizeof(wchar_t), L'\0');
  if (!ReadProcessMemory(process, environment, block.data(), block.size() * sizeof(wchar_t), &got))
    return -1;
  *read = true;
  constexpr std::wstring_view key = L"SPRINT_CODER_COMPUTER_USE_HELPER_PID=";
  for (size_t at = 0; at < block.size();) {
    size_t end = block.find(L'\0', at);
    if (end == std::wstring::npos) end = block.size();
    if (end == at) break;
    const std::wstring_view entry(block.data() + at, end - at);
    if (entry.substr(0, key.size()) == key) return std::wcstoll(entry.data() + key.size(), nullptr, 10);
    at = end + 1;
  }
  return -1;
}

// The native module query System.Diagnostics.Process.MainModule makes (EnumProcessModules with
// .NET Framework's 50 retries, then GetModuleFileNameExW), timed per step.
struct NativeProbe {
  std::atomic<int> step{0}; // 1 open, 2 enumerate, 3 file name, 4 done
  double open_ms = -1, enum_ms = -1, file_ms = -1;
  int attempts = 0;
  DWORD open_error = 0, enum_error = 0, file_error = 0;
  std::wstring file;
  std::string Json() const {
    const int at = step.load();
    if (at != 4) {
      static constexpr const char *kSteps[] = {"not_started", "in_open", "in_enumerate", "in_file_name"};
      return std::string("{\"state\":") + Quote(std::string_view(kSteps[at])) + "}";
    }
    return "{\"state\":\"done\",\"open_ms\":" + Fixed(open_ms) +
           ",\"open_error\":" + std::to_string(open_error) + ",\"enum_ms\":" + Fixed(enum_ms) +
           ",\"enum_attempts\":" + std::to_string(attempts) +
           ",\"enum_error\":" + std::to_string(enum_error) + ",\"file_name_ms\":" + Fixed(file_ms) +
           ",\"file_name_error\":" + std::to_string(file_error) + ",\"file_name\":" + Quote(file) +
           "}";
  }
};
void RunNativeProbe(DWORD pid, std::shared_ptr<NativeProbe> probe) {
  probe->step = 1;
  ULONGLONG started = Now();
  HANDLE process = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, FALSE, pid);
  probe->open_ms = Since(started);
  if (process == nullptr) {
    probe->open_error = GetLastError();
    probe->step = 4;
    return;
  }
  probe->step = 2;
  started = Now();
  HMODULE first = nullptr;
  DWORD needed = 0;
  BOOL listed = FALSE;
  for (int attempt = 0; attempt < 50 && !listed; ++attempt) {
    probe->attempts = attempt + 1;
    listed = EnumProcessModules(process, &first, sizeof(first), &needed);
    if (!listed) {
      probe->enum_error = GetLastError();
      Sleep(1);
    }
  }
  probe->enum_ms = Since(started);
  if (listed) {
    probe->enum_error = 0;
    probe->step = 3;
    started = Now();
    std::vector<wchar_t> name(32768);
    const DWORD size = GetModuleFileNameExW(process, first, name.data(), 32768);
    probe->file_ms = Since(started);
    if (size > 0) probe->file.assign(name.data(), size);
    else probe->file_error = GetLastError();
  }
  CloseHandle(process);
  probe->step = 4;
}

// The production attestation's steps, in its order, in a Windows PowerShell of the watcher's own
// environment (the seam starts the watcher with the product's helper environment) plus
// SPRINT_CODER_COMPUTER_USE_HELPER_PID. Each stage prints one line as it ends; 60 s in all.
struct StageRun {
  std::mutex lock;
  ULONGLONG spawned = 0, ended = 0;
  std::string outcome = "pending";
  DWORD exit_code = 0, error = 0;
  std::string output;
  std::string Json() {
    std::lock_guard guard(lock);
    return "{\"spawned_at\":" + At(spawned) + ",\"ended_at\":" + At(ended) +
           ",\"outcome\":" + Quote(std::string_view(outcome)) +
           ",\"exit_code\":" + std::to_string(exit_code) + ",\"error\":" + std::to_string(error) +
           ",\"output\":" + Quote(std::string_view(output)) + "}";
  }
};
void RunStages(DWORD pid, std::wstring encoded, std::shared_ptr<StageRun> run) {
  const auto fail = [&](const char *outcome) {
    std::lock_guard guard(run->lock);
    run->outcome = outcome;
    run->error = GetLastError();
    run->ended = Now();
  };
  std::wstring environment;
  if (wchar_t *block = GetEnvironmentStringsW()) {
    for (const wchar_t *entry = block; *entry != L'\0'; entry += std::wcslen(entry) + 1) {
      environment.append(entry);
      environment.push_back(L'\0');
    }
    FreeEnvironmentStringsW(block);
  }
  environment += L"SPRINT_CODER_COMPUTER_USE_HELPER_PID=" + std::to_wstring(pid);
  environment.push_back(L'\0');
  environment.push_back(L'\0');
  SECURITY_ATTRIBUTES inherit{sizeof(inherit), nullptr, TRUE};
  HANDLE read = nullptr;
  HANDLE write = nullptr;
  if (!CreatePipe(&read, &write, &inherit, 0)) return fail("pipe_failed");
  SetHandleInformation(read, HANDLE_FLAG_INHERIT, 0);
  HANDLE nul = CreateFileW(L"NUL", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                           &inherit, OPEN_EXISTING, 0, nullptr);
  // Only the runner's own stdout pipe and NUL are inherited.
  HANDLE inherited[2] = {write, nul};
  SIZE_T attribute_size = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &attribute_size);
  std::vector<BYTE> attribute_storage(attribute_size);
  auto *attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attribute_storage.data());
  const bool listed =
      nul != INVALID_HANDLE_VALUE &&
      InitializeProcThreadAttributeList(attributes, 1, 0, &attribute_size) &&
      UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited,
                                sizeof(inherited), nullptr, nullptr);
  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  if (job != nullptr) {
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits));
  }
  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = nul;
  startup.StartupInfo.hStdOutput = write;
  startup.StartupInfo.hStdError = nul;
  startup.lpAttributeList = attributes;
  std::wstring command = std::wstring(L"\"") + kPowerShell +
                         L"\" -NoLogo -NoProfile -NonInteractive -EncodedCommand " + encoded;
  PROCESS_INFORMATION child{};
  run->spawned = Now();
  const BOOL created =
      listed && CreateProcessW(kPowerShell, command.data(), nullptr, nullptr, TRUE,
                               CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED |
                                   EXTENDED_STARTUPINFO_PRESENT,
                               environment.data(), nullptr, &startup.StartupInfo, &child);
  if (listed) DeleteProcThreadAttributeList(attributes);
  CloseHandle(write);
  if (nul != INVALID_HANDLE_VALUE) CloseHandle(nul);
  if (!created) {
    fail("spawn_failed");
    CloseHandle(read);
    if (job != nullptr) CloseHandle(job);
    return;
  }
  const bool owned = job != nullptr && AssignProcessToJobObject(job, child.hProcess);
  ResumeThread(child.hThread);
  CloseHandle(child.hThread);
  std::thread reader([read, run]() {
    char chunk[1024];
    DWORD got = 0;
    while (ReadFile(read, chunk, sizeof(chunk), &got, nullptr) && got > 0) {
      std::lock_guard guard(run->lock);
      if (run->output.size() < 16384) run->output.append(chunk, got);
    }
  });
  HANDLE waits[2] = {child.hProcess, stop_event};
  const DWORD waited = WaitForMultipleObjects(2, waits, FALSE, 60'000);
  const char *outcome = waited == WAIT_OBJECT_0       ? "exited"
                        : waited == WAIT_OBJECT_0 + 1 ? "stopped_with_case"
                                                      : "timed_out_60s";
  if (waited != WAIT_OBJECT_0) {
    if (owned) TerminateJobObject(job, 1);
    else TerminateProcess(child.hProcess, 1);
    WaitForSingleObject(child.hProcess, 5'000);
  }
  DWORD code = 0;
  GetExitCodeProcess(child.hProcess, &code);
  reader.join();
  {
    std::lock_guard guard(run->lock);
    run->outcome = outcome;
    run->exit_code = code;
    run->ended = Now();
  }
  CloseHandle(read);
  CloseHandle(child.hProcess);
  if (job != nullptr) CloseHandle(job);
}

struct Sample {
  ULONGLONG at;
  Threads threads;
};
struct Tracked {
  DWORD pid = 0;
  ULONGLONG created = 0, detected = 0, gone = 0, last_sample = 0;
  std::vector<Sample> samples;
  void Track(const std::map<DWORD, Row> &rows, ULONGLONG now) {
    if (gone != 0) return;
    const auto found = rows.find(pid);
    if (found == rows.end() || found->second.created != created) {
      gone = now;
      return;
    }
    if (now - last_sample >= kSecond && samples.size() < 20) {
      samples.push_back({now, found->second.threads});
      last_sample = now;
    }
  }
  std::string Common() const {
    std::string out = "\"pid\":" + std::to_string(pid) + ",\"created_at\":" + At(created) +
                      ",\"detected_at\":" + At(detected) + ",\"gone_at\":" + At(gone) +
                      ",\"samples\":[";
    for (size_t index = 0; index < samples.size(); ++index) {
      if (index > 0) out += ',';
      out += "{\"at\":" + At(samples[index].at) + ",\"threads\":" + samples[index].threads.Json() + "}";
    }
    return out + "]";
  }
};
struct Helper : Tracked {
  std::wstring image;
  DWORD parent = 0, session = 0;
  BOOL in_job = FALSE;
  std::shared_ptr<NativeProbe> native;
  std::shared_ptr<StageRun> stages;
};
struct Attestation : Tracked {
  long long helper_pid = -1;
  bool environment_read = false;
};

int Main(const wchar_t *output_path, const wchar_t *parent_text, const wchar_t *image_a,
         const wchar_t *image_b, const wchar_t *encoded) {
  const HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  const auto query_system = ntdll == nullptr ? nullptr
                                             : reinterpret_cast<QuerySystemFn>(
                                                   GetProcAddress(ntdll, "NtQuerySystemInformation"));
  const auto query_process = ntdll == nullptr ? nullptr
                                              : reinterpret_cast<QueryProcessFn>(GetProcAddress(
                                                    ntdll, "NtQueryInformationProcess"));
  if (query_system == nullptr || query_process == nullptr) return 20;
  const DWORD parent_pid = std::wcstoul(parent_text, nullptr, 10);
  HANDLE parent = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, parent_pid);
  if (parent == nullptr) return 21;
  stop_event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (stop_event == nullptr) return 22;
  std::vector<BYTE> buffer(1 << 20);
  std::map<DWORD, Row> rows;
  if (!Snapshot(query_system, &buffer, &rows)) return 23;
  std::set<DWORD> classified;
  for (const auto &entry : rows) classified.insert(entry.first);
  BOOL watcher_in_job = FALSE;
  BOOL parent_in_job = FALSE;
  IsProcessInJob(GetCurrentProcess(), nullptr, &watcher_in_job);
  IsProcessInJob(parent, nullptr, &parent_in_job);
  // The seam stops the watcher by closing its stdin.
  std::thread([]() {
    char chunk[64];
    DWORD got = 0;
    const HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
    while (ReadFile(input, chunk, sizeof(chunk), &got, nullptr) && got > 0) {
    }
    SetEvent(stop_event);
  }).detach();
  const ULONGLONG started = Now();
  std::puts("ready");
  std::fflush(stdout);

  std::vector<Helper> helpers;
  std::vector<Attestation> attestations;
  std::vector<std::thread> runners;
  std::map<DWORD, int> retries;
  unsigned detailed = 0;
  unsigned polls = 0;
  double max_gap_ms = 0;
  ULONGLONG previous = started;
  std::string stop_reason = "stdin_closed";
  const auto retry = [&](DWORD pid) {
    if (++retries[pid] > 50) classified.insert(pid);
  };
  // A high-resolution timer polls about every 2 ms without changing the system timer resolution.
  HANDLE timer = CreateWaitableTimerExW(nullptr, nullptr, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION,
                                        TIMER_ALL_ACCESS);
  for (;;) {
    LARGE_INTEGER due{};
    due.QuadPart = -20'000; // 2 ms, relative
    const bool timed = timer != nullptr && SetWaitableTimer(timer, &due, 0, nullptr, nullptr, FALSE);
    HANDLE waits[2] = {stop_event, timer};
    if ((timed ? WaitForMultipleObjects(2, waits, FALSE, INFINITE)
               : WaitForSingleObject(stop_event, 5)) == WAIT_OBJECT_0)
      break;
    if (WaitForSingleObject(parent, 0) == WAIT_OBJECT_0) {
      stop_reason = "parent_exited";
      break;
    }
    const ULONGLONG poll = Now();
    if (poll - started > 20 * 60 * kSecond) {
      stop_reason = "limit_20min";
      break;
    }
    max_gap_ms = (std::max)(max_gap_ms, static_cast<double>(poll - previous) / 10000.0);
    previous = poll;
    polls += 1;
    if (!Snapshot(query_system, &buffer, &rows)) continue;
    const ULONGLONG now = Now(); // after the snapshot, which itself can take several ms
    for (const auto &[pid, row] : rows) {
      if (classified.count(pid) != 0) continue;
      const bool helper_image =
          _wcsicmp(row.image.c_str(), image_a) == 0 || _wcsicmp(row.image.c_str(), image_b) == 0;
      const bool powershell = _wcsicmp(row.image.c_str(), L"powershell.exe") == 0;
      if (row.parent != parent_pid || (!helper_image && !powershell)) {
        classified.insert(pid);
        continue;
      }
      HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, FALSE, pid);
      if (process == nullptr) {
        retry(pid);
        continue;
      }
      if (helper_image) {
        const std::wstring command = CommandLine(process, query_process);
        if (command.empty()) {
          CloseHandle(process);
          retry(pid);
          continue;
        }
        classified.insert(pid);
        // Only a transport helper (--pipe); the seam's own --fixture/--identity runs are not.
        if (command.find(L" --pipe ") == std::wstring::npos) {
          CloseHandle(process);
          continue;
        }
        Helper helper;
        IsProcessInJob(process, nullptr, &helper.in_job);
        CloseHandle(process);
        helper.pid = pid;
        helper.created = row.created;
        helper.detected = now;
        helper.last_sample = now;
        helper.samples.push_back({now, row.threads});
        helper.image = row.image;
        helper.parent = row.parent;
        helper.session = row.session;
        if (detailed < 4) {
          detailed += 1;
          helper.native = std::make_shared<NativeProbe>();
          std::thread(RunNativeProbe, pid, helper.native).detach();
          if (runners.size() < 2) {
            helper.stages = std::make_shared<StageRun>();
            runners.emplace_back(RunStages, pid, std::wstring(encoded), helper.stages);
          }
        }
        helpers.push_back(std::move(helper));
      } else {
        bool read = false;
        const long long helper_pid = HelperPidFromEnvironment(process, query_process, &read);
        CloseHandle(process);
        if (!read && retries[pid] < 50) {
          retry(pid);
          continue;
        }
        classified.insert(pid);
        if (read && helper_pid < 0) continue; // a PowerShell child without the attestation marker
        if (attestations.size() >= 64) continue;
        Attestation attestation;
        attestation.pid = pid;
        attestation.created = row.created;
        attestation.detected = now;
        attestation.last_sample = now;
        attestation.samples.push_back({now, row.threads});
        attestation.helper_pid = helper_pid;
        attestation.environment_read = read;
        attestations.push_back(std::move(attestation));
      }
    }
    for (auto &helper : helpers) helper.Track(rows, now);
    for (auto &attestation : attestations) attestation.Track(rows, now);
  }
  const ULONGLONG stopped = Now();
  SetEvent(stop_event);
  for (auto &runner : runners) runner.join();
  // A native probe stuck inside a module query is reported by its step, not waited for.
  for (const ULONGLONG until = Now() + 2 * kSecond; Now() < until;) {
    bool pending = false;
    for (const auto &helper : helpers)
      if (helper.native && helper.native->step.load() != 4) pending = true;
    if (!pending) break;
    Sleep(10);
  }
  std::string json = "{\"watcher\":{\"pid\":" + std::to_string(GetCurrentProcessId()) +
                     ",\"in_job\":" + (watcher_in_job ? "true" : "false") +
                     ",\"parent_pid\":" + std::to_string(parent_pid) +
                     ",\"parent_in_job\":" + (parent_in_job ? "true" : "false") +
                     ",\"started_at\":" + At(started) + ",\"stopped_at\":" + At(stopped) +
                     ",\"stop_reason\":" + Quote(std::string_view(stop_reason)) +
                     ",\"polls\":" + std::to_string(polls) +
                     ",\"max_poll_gap_ms\":" + Fixed(max_gap_ms) + "},\"helpers\":[";
  for (size_t index = 0; index < helpers.size(); ++index) {
    const Helper &helper = helpers[index];
    if (index > 0) json += ',';
    json += "{" + helper.Common() + ",\"image\":" + Quote(std::wstring_view(helper.image)) +
            ",\"parent_pid\":" + std::to_string(helper.parent) +
            ",\"session_id\":" + std::to_string(helper.session) +
            ",\"in_job\":" + (helper.in_job ? "true" : "false") +
            ",\"native\":" + (helper.native ? helper.native->Json() : "null") +
            ",\"stages\":" + (helper.stages ? helper.stages->Json() : "null") + "}";
  }
  json += "],\"attestations\":[";
  for (size_t index = 0; index < attestations.size(); ++index) {
    const Attestation &attestation = attestations[index];
    if (index > 0) json += ',';
    json += "{" + attestation.Common() + ",\"helper_pid\":" +
            (attestation.helper_pid < 0 ? std::string("null")
                                        : std::to_string(attestation.helper_pid)) +
            ",\"environment_read\":" + (attestation.environment_read ? "true" : "false") + "}";
  }
  json += "]}\n";
  FILE *file = _wfopen(output_path, L"wb");
  if (file == nullptr) return 24;
  std::fwrite(json.data(), 1, json.size(), file);
  std::fclose(file);
  CloseHandle(parent);
  if (timer != nullptr) CloseHandle(timer);
  return 0;
}

} // namespace attest_watch

int wmain(int argc, wchar_t **argv) {
  if (argc == 7 && std::wstring_view(argv[1]) == L"--watch-attest")
    return attest_watch::Main(argv[2], argv[3], argv[4], argv[5], argv[6]);
  if (argc == 3 && std::wstring_view(argv[1]) == L"--window") {
    struct WindowQuery { DWORD pid; HWND window; } query{static_cast<DWORD>(_wtoi(argv[2])), nullptr};
    EnumWindows([](HWND window, LPARAM parameter) -> BOOL {
      auto *query = reinterpret_cast<WindowQuery *>(parameter);
      DWORD pid = 0;
      GetWindowThreadProcessId(window, &pid);
      if (pid == query->pid && IsWindowVisible(window) && GetWindow(window, GW_OWNER) == nullptr) {
        query->window = window;
        return FALSE;
      }
      return TRUE;
    }, reinterpret_cast<LPARAM>(&query));
    if (query.window == nullptr) return 4;
    SetForegroundWindow(query.window);
    std::printf("%llu\n", static_cast<unsigned long long>(reinterpret_cast<UINT_PTR>(query.window)));
    return 0;
  }
  // The seam reads this clock just before it spawns Notepad and passes the value to --close-titled
  // and --count-titled (FILETIME, 100 ns units since 1601). GetSystemTimeAsFileTime is the
  // tick-granular system time, and a process creation time is stamped from the system time at
  // creation (that tick or finer), so a process started after the read is never stamped earlier.
  if (argc == 2 && std::wstring_view(argv[1]) == L"--now") {
    FILETIME now{};
    GetSystemTimeAsFileTime(&now);
    std::printf("%llu\n", (static_cast<unsigned long long>(now.dwHighDateTime) << 32) |
                              now.dwLowDateTime);
    return 0;
  }
  if (argc == 4 && (std::wstring_view(argv[1]) == L"--close-titled" ||
                    std::wstring_view(argv[1]) == L"--count-titled"))
    return TitledNotepadWindows(std::wstring_view(argv[1]) == L"--close-titled", argv[2], argv[3]);
  if (argc == 3 && std::wstring_view(argv[1]) == L"--identity") {
    WindowsExecutableIdentity identity;
    if (!BuildWindowsExecutableIdentity(argv[2], &identity)) return 2;
    std::puts(WindowsIdentityJson(identity).c_str());
    return 0;
  }
  if (argc == 2 && std::wstring_view(argv[1]) == L"--fixture") {
    HWND window = CreateWindowExW(0, L"STATIC", L"Hung helper seam", WS_OVERLAPPEDWINDOW,
                                   40, 40, 640, 480, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
    if (window == nullptr) return 3;
    ShowWindow(window, SW_SHOWNORMAL);
    std::printf("{\"pid\":%lu,\"windowId\":\"%llu\"}\n", GetCurrentProcessId(),
                static_cast<unsigned long long>(reinterpret_cast<UINT_PTR>(window)));
    std::fflush(stdout);
    MSG message{};
    while (GetMessageW(&message, nullptr, 0, 0) > 0) {
      TranslateMessage(&message);
      DispatchMessageW(&message);
    }
    return 0;
  }
  return ComputerUseHostMain(argc, argv);
}
