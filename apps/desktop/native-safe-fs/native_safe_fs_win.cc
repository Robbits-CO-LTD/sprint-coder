#include <node_api.h>
#include <windows.h>
#include <aclapi.h>
#include <wincrypt.h>
#include <winternl.h>

#include <algorithm>
#include <charconv>
#include <cstdint>
#include <mutex>
#include <atomic>
#include <cstring>
#include <limits>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#include "native_safe_fs_win_mutation.h"

namespace {

std::mutex jobs_mutex;
std::unordered_map<std::string, HANDLE> jobs;
struct PreparedExecutionHandles {
  HANDLE parent = INVALID_HANDLE_VALUE;
  HANDLE file = INVALID_HANDLE_VALUE;
};
std::mutex prepared_execution_mutex;
std::unordered_map<std::string, PreparedExecutionHandles> prepared_execution_images;
std::atomic<uint64_t> prepared_execution_sequence{1};

napi_value MakeString(napi_env env, const char* value) {
  napi_value result;
  napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &result);
  return result;
}

napi_value ThrowWindowsError(napi_env env, const char* operation) {
  const DWORD code = GetLastError();
  std::string message = std::string(operation) + " failed with Windows error " +
                        std::to_string(static_cast<unsigned long>(code));
  napi_value error;
  napi_create_error(env, nullptr, MakeString(env, message.c_str()), &error);
  napi_set_named_property(env, error, "code", MakeString(env, "WINDOWS_NATIVE_FAILURE"));
  napi_throw(env, error);
  return nullptr;
}

bool QueryWindowsProcessIdentity(DWORD pid, DWORD* parent_pid, uint64_t* start_identity) {
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (process == nullptr) return false;
  FILETIME created{}, exited{}, kernel{}, user{};
  const BOOL read_times = GetProcessTimes(process, &created, &exited, &kernel, &user);
  struct SprintProcessBasicInformation {
    LONG exit_status;
    PVOID peb_base_address;
    ULONG_PTR affinity_mask;
    LONG base_priority;
    ULONG_PTR unique_process_id;
    ULONG_PTR inherited_from_unique_process_id;
  } basic{};
  using NtQueryInformationProcessFn = LONG(NTAPI*)(HANDLE, ULONG, PVOID, ULONG, PULONG);
  const HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  const auto query_basic =
      ntdll == nullptr
          ? nullptr
          : reinterpret_cast<NtQueryInformationProcessFn>(
                GetProcAddress(ntdll, "NtQueryInformationProcess"));
  const LONG basic_status =
      query_basic == nullptr
          ? static_cast<LONG>(-1)
          : query_basic(process, 0, &basic, sizeof(basic), nullptr);
  CloseHandle(process);
  if (!read_times || basic_status < 0 || basic.unique_process_id != pid ||
      basic.inherited_from_unique_process_id > std::numeric_limits<DWORD>::max())
    return false;
  ULARGE_INTEGER created_ticks{};
  created_ticks.LowPart = created.dwLowDateTime;
  created_ticks.HighPart = created.dwHighDateTime;
  *parent_pid = static_cast<DWORD>(basic.inherited_from_unique_process_id);
  *start_identity = created_ticks.QuadPart;
  return true;
}

napi_value WindowsProcessIdentityObject(napi_env env, DWORD pid, DWORD parent_pid,
                                        uint64_t start_identity) {
  napi_value result;
  napi_create_object(env, &result);
  napi_value process_id;
  napi_create_uint32(env, pid, &process_id);
  napi_set_named_property(env, result, "pid", process_id);
  napi_value parent;
  napi_create_uint32(env, parent_pid, &parent);
  napi_set_named_property(env, result, "parentPid", parent);
  const std::string start = "win32:" + std::to_string(start_identity);
  napi_set_named_property(env, result, "startIdentity", MakeString(env, start.c_str()));
  return result;
}

napi_value QueryProcessIdentity(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  uint32_t pid = 0;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1 ||
      napi_get_value_uint32(env, argv[0], &pid) != napi_ok || pid == 0) {
    napi_throw_type_error(env, nullptr, "queryProcessIdentity requires a positive pid");
    return nullptr;
  }
  DWORD parent_pid = 0;
  uint64_t start_identity = 0;
  if (!QueryWindowsProcessIdentity(pid, &parent_pid, &start_identity))
    return ThrowWindowsError(env, "queryProcessIdentity");
  return WindowsProcessIdentityObject(env, pid, parent_pid, start_identity);
}

napi_value QueryNamedPipePeerIdentity(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  uint32_t broker_pid = 0;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 2 ||
      napi_get_value_uint32(env, argv[0], &broker_pid) != napi_ok || broker_pid == 0) {
    napi_throw_type_error(env, nullptr,
                          "queryNamedPipePeerIdentity requires broker pid and pipe handle");
    return nullptr;
  }
  size_t handle_length = 0;
  if (napi_get_value_string_utf8(env, argv[1], nullptr, 0, &handle_length) != napi_ok ||
      handle_length == 0 || handle_length > 32) {
    napi_throw_type_error(env, nullptr, "pipe handle must be a decimal string");
    return nullptr;
  }
  std::vector<char> handle_buffer(handle_length + 1, '\0');
  size_t copied = 0;
  if (napi_get_value_string_utf8(env, argv[1], handle_buffer.data(), handle_buffer.size(), &copied) !=
          napi_ok ||
      copied != handle_length) {
    napi_throw_type_error(env, nullptr, "pipe handle must be a decimal string");
    return nullptr;
  }
  uint64_t remote_handle_value = 0;
  const auto parsed = std::from_chars(handle_buffer.data(), handle_buffer.data() + handle_length,
                                      remote_handle_value);
  if (parsed.ec != std::errc{} || parsed.ptr != handle_buffer.data() + handle_length ||
      remote_handle_value == 0 || remote_handle_value > std::numeric_limits<uintptr_t>::max()) {
    napi_throw_type_error(env, nullptr, "pipe handle must be a positive decimal string");
    return nullptr;
  }
  HANDLE broker = OpenProcess(PROCESS_DUP_HANDLE, FALSE, broker_pid);
  if (broker == nullptr) return ThrowWindowsError(env, "OpenProcess(pipe broker)");
  HANDLE local_pipe = INVALID_HANDLE_VALUE;
  const BOOL duplicated = DuplicateHandle(
      broker, reinterpret_cast<HANDLE>(static_cast<uintptr_t>(remote_handle_value)),
      GetCurrentProcess(), &local_pipe, 0, FALSE, DUPLICATE_SAME_ACCESS);
  CloseHandle(broker);
  if (!duplicated) return ThrowWindowsError(env, "DuplicateHandle(named pipe)");
  ULONG client_pid = 0;
  const BOOL read_peer = GetNamedPipeClientProcessId(local_pipe, &client_pid);
  CloseHandle(local_pipe);
  if (!read_peer || client_pid == 0)
    return ThrowWindowsError(env, "GetNamedPipeClientProcessId");
  DWORD parent_pid = 0;
  uint64_t start_identity = 0;
  if (!QueryWindowsProcessIdentity(client_pid, &parent_pid, &start_identity))
    return ThrowWindowsError(env, "queryNamedPipePeerIdentity");
  return WindowsProcessIdentityObject(env, client_pid, parent_pid, start_identity);
}

bool ReadString(napi_env env, napi_value value, std::string* output) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) return false;
  std::string buffer(length + 1, '\0');
  if (napi_get_value_string_utf8(env, value, buffer.data(), length + 1, &length) != napi_ok)
    return false;
  buffer.resize(length);
  if (buffer.empty() || buffer.find('\0') != std::string::npos) return false;
  *output = std::move(buffer);
  return true;
}

bool Utf8ToWide(const std::string& input, std::wstring* output) {
  const int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, input.data(),
                                         static_cast<int>(input.size()), nullptr, 0);
  if (length <= 0) return false;
  output->resize(static_cast<size_t>(length));
  return MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, input.data(),
                             static_cast<int>(input.size()), output->data(), length) == length;
}

napi_value GetTrustedSystemDirectory(napi_env env, napi_callback_info info) {
  (void)info;
  std::vector<wchar_t> buffer(MAX_PATH + 1, L'\0');
  UINT length = GetSystemDirectoryW(buffer.data(), static_cast<UINT>(buffer.size()));
  if (length == 0) return ThrowWindowsError(env, "GetSystemDirectoryW");
  if (length >= buffer.size()) {
    buffer.resize(static_cast<size_t>(length) + 1, L'\0');
    length = GetSystemDirectoryW(buffer.data(), static_cast<UINT>(buffer.size()));
    if (length == 0 || length >= buffer.size())
      return ThrowWindowsError(env, "GetSystemDirectoryW");
  }
  napi_value result;
  if (napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(buffer.data()), length,
                               &result) != napi_ok) {
    napi_throw_error(env, "WINDOWS_NATIVE_FAILURE", "Could not encode the system directory");
    return nullptr;
  }
  return result;
}

napi_value ThrowUnsafeImageFile(napi_env env, const char* code) {
  napi_value error;
  napi_create_error(env, nullptr, MakeString(env, "The selected image file is unsafe"), &error);
  napi_set_named_property(env, error, "code", MakeString(env, code));
  napi_throw(env, error);
  return nullptr;
}

napi_value EnableSafeDllSearchPolicy(napi_env env, napi_callback_info info) {
  (void)info;
  HMODULE kernel32 = GetModuleHandleW(L"kernel32.dll");
  if (kernel32 == nullptr) return ThrowWindowsError(env, "GetModuleHandleW");
  using SetDefaultDllDirectoriesFn = BOOL(WINAPI*)(DWORD);
  using SetProcessMitigationPolicyFn = BOOL(WINAPI*)(PROCESS_MITIGATION_POLICY, PVOID, SIZE_T);
  auto set_directories = reinterpret_cast<SetDefaultDllDirectoriesFn>(
      GetProcAddress(kernel32, "SetDefaultDllDirectories"));
  auto set_mitigation = reinterpret_cast<SetProcessMitigationPolicyFn>(
      GetProcAddress(kernel32, "SetProcessMitigationPolicy"));
  if (set_directories == nullptr || set_mitigation == nullptr) {
    SetLastError(ERROR_PROC_NOT_FOUND);
    return ThrowWindowsError(env, "safe DLL policy discovery");
  }
  // Remove the current working directory and application directory from implicit LoadLibrary
  // searches. Static side-by-side imports were already copied and pinned by Main; Windows system
  // imports must resolve from System32 before any application-directory candidate.
  if (!set_directories(LOAD_LIBRARY_SEARCH_SYSTEM32))
    return ThrowWindowsError(env, "SetDefaultDllDirectories");
  PROCESS_MITIGATION_IMAGE_LOAD_POLICY policy{};
  policy.NoRemoteImages = 1;
  policy.NoLowMandatoryLabelImages = 1;
  policy.PreferSystem32Images = 1;
  if (!set_mitigation(ProcessImageLoadPolicy, &policy, sizeof(policy)))
    return ThrowWindowsError(env, "SetProcessMitigationPolicy");
  napi_value result;
  napi_get_boolean(env, true, &result);
  return result;
}

std::wstring QuoteCommandLineArgument(const std::wstring& value) {
  if (value.empty()) return L"\"\"";
  if (value.find_first_of(L" \t\n\v\"") == std::wstring::npos) return value;
  std::wstring quoted = L"\"";
  size_t slashes = 0;
  for (wchar_t character : value) {
    if (character == L'\\') {
      ++slashes;
      continue;
    }
    if (character == L'\"') {
      quoted.append(slashes * 2 + 1, L'\\');
      quoted.push_back(L'\"');
    } else {
      quoted.append(slashes, L'\\');
      quoted.push_back(character);
    }
    slashes = 0;
  }
  quoted.append(slashes * 2, L'\\');
  quoted.push_back(L'\"');
  return quoted;
}

bool ReadCommandArgument(napi_env env, napi_value value, std::wstring* output) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok || length > 1000000)
    return false;
  std::string utf8(length + 1, '\0');
  if (napi_get_value_string_utf8(env, value, utf8.data(), length + 1, &length) != napi_ok)
    return false;
  utf8.resize(length);
  if (utf8.find('\0') != std::string::npos) return false;
  if (utf8.empty()) {
    output->clear();
    return true;
  }
  return Utf8ToWide(utf8, output);
}

napi_value RunPreparedExecutionImage(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 2) {
    napi_throw_type_error(env, nullptr, "runPreparedExecutionImage requires executable and argv");
    return nullptr;
  }
  std::string executable_utf8;
  std::wstring executable;
  bool is_array = false;
  if (!ReadString(env, argv[0], &executable_utf8) || !Utf8ToWide(executable_utf8, &executable) ||
      napi_is_array(env, argv[1], &is_array) != napi_ok || !is_array) {
    napi_throw_type_error(env, nullptr, "Invalid prepared execution request");
    return nullptr;
  }
  uint32_t length = 0;
  if (napi_get_array_length(env, argv[1], &length) != napi_ok || length > 4096) {
    napi_throw_type_error(env, nullptr, "Invalid prepared execution argv");
    return nullptr;
  }
  std::wstring command_line = QuoteCommandLineArgument(executable);
  for (uint32_t index = 0; index < length; ++index) {
    napi_value item;
    std::wstring value;
    if (napi_get_element(env, argv[1], index, &item) != napi_ok ||
        !ReadCommandArgument(env, item, &value)) {
      napi_throw_type_error(env, nullptr, "Invalid prepared execution argv entry");
      return nullptr;
    }
    command_line.push_back(L' ');
    command_line.append(QuoteCommandLineArgument(value));
  }
  SIZE_T attribute_bytes = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &attribute_bytes);
  std::vector<unsigned char> attribute_storage(attribute_bytes);
  auto attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attribute_storage.data());
  if (!InitializeProcThreadAttributeList(attributes, 1, 0, &attribute_bytes))
    return ThrowWindowsError(env, "InitializeProcThreadAttributeList");
  ULONG64 mitigation = PROCESS_CREATION_MITIGATION_POLICY_IMAGE_LOAD_NO_REMOTE_ALWAYS_ON |
                       PROCESS_CREATION_MITIGATION_POLICY_IMAGE_LOAD_NO_LOW_LABEL_ALWAYS_ON |
                       PROCESS_CREATION_MITIGATION_POLICY_IMAGE_LOAD_PREFER_SYSTEM32_ALWAYS_ON;
  if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY,
                                 &mitigation, sizeof(mitigation), nullptr, nullptr)) {
    DeleteProcThreadAttributeList(attributes);
    return ThrowWindowsError(env, "UpdateProcThreadAttribute");
  }
  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.lpAttributeList = attributes;
  HANDLE inherited_standard_handles[3] = {nullptr, nullptr, nullptr};
  const DWORD standard_handle_ids[3] = {STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE};
  for (size_t index = 0; index < 3; ++index) {
    HANDLE source = GetStdHandle(standard_handle_ids[index]);
    if (source == nullptr || source == INVALID_HANDLE_VALUE ||
        !DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(),
                         &inherited_standard_handles[index], 0, TRUE,
                         DUPLICATE_SAME_ACCESS)) {
      for (HANDLE handle : inherited_standard_handles) {
        if (handle != nullptr) CloseHandle(handle);
      }
      DeleteProcThreadAttributeList(attributes);
      return ThrowWindowsError(env, "DuplicateHandle");
    }
  }
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = inherited_standard_handles[0];
  startup.StartupInfo.hStdOutput = inherited_standard_handles[1];
  startup.StartupInfo.hStdError = inherited_standard_handles[2];
  PROCESS_INFORMATION process{};
  std::vector<wchar_t> mutable_command(command_line.begin(), command_line.end());
  mutable_command.push_back(L'\0');
  const BOOL created = CreateProcessW(
      executable.c_str(), mutable_command.data(), nullptr, nullptr, TRUE,
      CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT, nullptr, nullptr,
      &startup.StartupInfo, &process);
  for (HANDLE handle : inherited_standard_handles) CloseHandle(handle);
  DeleteProcThreadAttributeList(attributes);
  if (!created) return ThrowWindowsError(env, "CreateProcessW");
  if (ResumeThread(process.hThread) == static_cast<DWORD>(-1)) {
    TerminateProcess(process.hProcess, 126);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    return ThrowWindowsError(env, "ResumeThread");
  }
  CloseHandle(process.hThread);
  const DWORD wait = WaitForSingleObject(process.hProcess, INFINITE);
  DWORD exit_code = 126;
  const BOOL read_exit = wait == WAIT_OBJECT_0 && GetExitCodeProcess(process.hProcess, &exit_code);
  CloseHandle(process.hProcess);
  if (!read_exit) return ThrowWindowsError(env, "WaitForSingleObject");
  napi_value result;
  napi_create_uint32(env, exit_code, &result);
  return result;
}

std::wstring NormalizeFinalPath(std::wstring path) {
  constexpr wchar_t kUncPrefix[] = L"\\\\?\\UNC\\";
  constexpr wchar_t kLongPrefix[] = L"\\\\?\\";
  if (path.rfind(kUncPrefix, 0) == 0) return L"\\\\" + path.substr(8);
  if (path.rfind(kLongPrefix, 0) == 0) return path.substr(4);
  return path;
}

bool ExpandLongPath(const std::wstring& path, std::wstring* output) {
  const DWORD length = GetLongPathNameW(path.c_str(), nullptr, 0);
  if (length == 0) return false;
  std::vector<wchar_t> buffer(length + 1, L'\0');
  const DWORD written =
      GetLongPathNameW(path.c_str(), buffer.data(), static_cast<DWORD>(buffer.size()));
  if (written == 0 || written >= buffer.size()) return false;
  *output = std::wstring(buffer.data(), written);
  return true;
}

bool SamePath(const std::wstring& left, const std::wstring& right) {
  return CompareStringOrdinal(left.data(), static_cast<int>(left.size()), right.data(),
                              static_cast<int>(right.size()), TRUE) == CSTR_EQUAL;
}

bool QueryStableImageIdentity(HANDLE file, FILE_ID_INFO* id, FILE_BASIC_INFO* basic,
                              FILE_STANDARD_INFO* standard,
                              bool require_unique_link = true) {
  FILE_ATTRIBUTE_TAG_INFO tag{};
  if (!GetFileInformationByHandleEx(file, FileAttributeTagInfo, &tag, sizeof(tag)) ||
      (tag.FileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0 ||
      tag.ReparseTag != 0 ||
      !GetFileInformationByHandleEx(file, FileIdInfo, id, sizeof(*id)) ||
      !GetFileInformationByHandleEx(file, FileBasicInfo, basic, sizeof(*basic)) ||
      !GetFileInformationByHandleEx(file, FileStandardInfo, standard, sizeof(*standard)))
    return false;
  return !standard->Directory && !standard->DeletePending && standard->NumberOfLinks >= 1 &&
         (!require_unique_link || standard->NumberOfLinks == 1);
}

bool SameImageIdentity(const FILE_ID_INFO& first_id, const FILE_BASIC_INFO& first_basic,
                       const FILE_STANDARD_INFO& first_standard, const FILE_ID_INFO& second_id,
                       const FILE_BASIC_INFO& second_basic,
                       const FILE_STANDARD_INFO& second_standard) {
  return first_id.VolumeSerialNumber == second_id.VolumeSerialNumber &&
         std::memcmp(&first_id.FileId, &second_id.FileId, sizeof(FILE_ID_128)) == 0 &&
         first_basic.CreationTime.QuadPart == second_basic.CreationTime.QuadPart &&
         first_basic.LastWriteTime.QuadPart == second_basic.LastWriteTime.QuadPart &&
         first_basic.ChangeTime.QuadPart == second_basic.ChangeTime.QuadPart &&
         first_basic.FileAttributes == second_basic.FileAttributes &&
         first_standard.EndOfFile.QuadPart == second_standard.EndOfFile.QuadPart &&
         first_standard.AllocationSize.QuadPart == second_standard.AllocationSize.QuadPart &&
         first_standard.NumberOfLinks == second_standard.NumberOfLinks &&
         !second_standard.DeletePending && !second_standard.Directory;
}

napi_value ReadNoReparseImageFile(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 1 ||
      argc > 2) {
    napi_throw_type_error(env, nullptr,
                          "readNoReparseImageFile requires a path and optional policy");
    return nullptr;
  }
  std::string path_utf8;
  std::wstring path;
  if (!ReadString(env, argv[0], &path_utf8) || !Utf8ToWide(path_utf8, &path)) {
    napi_throw_type_error(env, nullptr, "Invalid image path");
    return nullptr;
  }
  bool allow_hardlinks = false;
  if (argc == 2 && napi_get_value_bool(env, argv[1], &allow_hardlinks) != napi_ok) {
    napi_throw_type_error(env, nullptr, "Invalid image hardlink policy");
    return nullptr;
  }
  const DWORD full_length = GetFullPathNameW(path.c_str(), 0, nullptr, nullptr);
  if (full_length == 0) return ThrowUnsafeImageFile(env, "UNSAFE_IMAGE_FILE");
  std::vector<wchar_t> full_buffer(full_length, L'\0');
  if (GetFullPathNameW(path.c_str(), full_length, full_buffer.data(), nullptr) == 0)
    return ThrowUnsafeImageFile(env, "UNSAFE_IMAGE_FILE");
  const std::wstring full_path(full_buffer.data());
  if (!SamePath(path, full_path)) return ThrowUnsafeImageFile(env, "UNSAFE_IMAGE_FILE");

  std::wstring expected_final_path;
  if (!ExpandLongPath(full_path, &expected_final_path))
    return ThrowUnsafeImageFile(env, "UNSAFE_IMAGE_FILE");

  HANDLE file = CreateFileW(full_path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
                            OPEN_EXISTING,
                            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT |
                                FILE_FLAG_SEQUENTIAL_SCAN,
                            nullptr);
  if (file == INVALID_HANDLE_VALUE) return ThrowUnsafeImageFile(env, "UNSAFE_IMAGE_FILE");

  FILE_ID_INFO before_id{};
  FILE_BASIC_INFO before_basic{};
  FILE_STANDARD_INFO before_standard{};
  constexpr LONGLONG kMaximumBytes = 512LL * 1024LL * 1024LL;
  bool safe = QueryStableImageIdentity(file, &before_id, &before_basic, &before_standard,
                                       !allow_hardlinks);
  if (!safe || before_standard.EndOfFile.QuadPart < 1 ||
      before_standard.EndOfFile.QuadPart > kMaximumBytes) {
    const bool too_large = safe && before_standard.EndOfFile.QuadPart > kMaximumBytes;
    CloseHandle(file);
    return ThrowUnsafeImageFile(env, too_large ? "IMAGE_FILE_TOO_LARGE" : "UNSAFE_IMAGE_FILE");
  }

  const DWORD final_length = GetFinalPathNameByHandleW(
      file, nullptr, 0, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  std::vector<wchar_t> final_buffer(final_length + 1, L'\0');
  if (final_length == 0 ||
      GetFinalPathNameByHandleW(file, final_buffer.data(), final_length + 1,
                                FILE_NAME_NORMALIZED | VOLUME_NAME_DOS) == 0 ||
      !SamePath(expected_final_path, NormalizeFinalPath(std::wstring(final_buffer.data())))) {
    CloseHandle(file);
    return ThrowUnsafeImageFile(env, "UNSAFE_IMAGE_FILE");
  }

  const size_t byte_length = static_cast<size_t>(before_standard.EndOfFile.QuadPart);
  std::vector<unsigned char> bytes(byte_length);
  size_t offset = 0;
  while (offset < byte_length) {
    DWORD bytes_read = 0;
    const DWORD requested = static_cast<DWORD>(byte_length - offset);
    if (!ReadFile(file, bytes.data() + offset, requested, &bytes_read, nullptr) || bytes_read == 0) {
      CloseHandle(file);
      return ThrowUnsafeImageFile(env, "UNSAFE_IMAGE_FILE");
    }
    offset += bytes_read;
  }
  unsigned char overflow = 0;
  DWORD overflow_read = 0;
  if (!ReadFile(file, &overflow, 1, &overflow_read, nullptr) || overflow_read != 0) {
    CloseHandle(file);
    return ThrowUnsafeImageFile(env, "UNSAFE_IMAGE_FILE");
  }

  FILE_ID_INFO after_id{};
  FILE_BASIC_INFO after_basic{};
  FILE_STANDARD_INFO after_standard{};
  safe = QueryStableImageIdentity(file, &after_id, &after_basic, &after_standard,
                                  !allow_hardlinks) &&
         SameImageIdentity(before_id, before_basic, before_standard, after_id, after_basic,
                           after_standard);
  CloseHandle(file);
  if (!safe) return ThrowUnsafeImageFile(env, "UNSAFE_IMAGE_FILE");

  napi_value result;
  if (napi_create_buffer_copy(env, bytes.size(), bytes.data(), nullptr, &result) != napi_ok)
    return ThrowUnsafeImageFile(env, "UNSAFE_IMAGE_FILE");
  return result;
}

napi_value HoldPreparedExecutionImage(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 1 || argc > 2) {
    napi_throw_type_error(env, nullptr,
                          "holdPreparedExecutionImage requires a path and optional policy");
    return nullptr;
  }
  std::string path_utf8;
  std::wstring path;
  if (!ReadString(env, argv[0], &path_utf8) || !Utf8ToWide(path_utf8, &path))
    return ThrowUnsafeImageFile(env, "UNSAFE_EXECUTION_IMAGE");
  bool allow_hardlinks = false;
  if (argc == 2 && napi_get_value_bool(env, argv[1], &allow_hardlinks) != napi_ok) {
    napi_throw_type_error(env, nullptr, "Invalid prepared image hardlink policy");
    return nullptr;
  }
  const DWORD full_length = GetFullPathNameW(path.c_str(), 0, nullptr, nullptr);
  if (full_length == 0) return ThrowUnsafeImageFile(env, "UNSAFE_EXECUTION_IMAGE");
  std::vector<wchar_t> full_buffer(full_length, L'\0');
  if (GetFullPathNameW(path.c_str(), full_length, full_buffer.data(), nullptr) == 0)
    return ThrowUnsafeImageFile(env, "UNSAFE_EXECUTION_IMAGE");
  const std::wstring full_path(full_buffer.data());
  if (!SamePath(path, full_path)) return ThrowUnsafeImageFile(env, "UNSAFE_EXECUTION_IMAGE");
  const size_t separator = full_path.find_last_of(L"\\/");
  if (separator == std::wstring::npos) return ThrowUnsafeImageFile(env, "UNSAFE_EXECUTION_IMAGE");
  const std::wstring parent_path = full_path.substr(0, separator);
  HANDLE parent = CreateFileW(parent_path.c_str(), FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES,
                              FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                              FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (parent == INVALID_HANDLE_VALUE) return ThrowUnsafeImageFile(env, "UNSAFE_EXECUTION_IMAGE");
  FILE_ATTRIBUTE_TAG_INFO parent_tag{};
  if (!GetFileInformationByHandleEx(parent, FileAttributeTagInfo, &parent_tag,
                                    sizeof(parent_tag)) ||
      (parent_tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
      (parent_tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 || parent_tag.ReparseTag != 0) {
    CloseHandle(parent);
    return ThrowUnsafeImageFile(env, "UNSAFE_EXECUTION_IMAGE");
  }
  HANDLE file = CreateFileW(full_path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
                            OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT |
                                               FILE_FLAG_SEQUENTIAL_SCAN,
                            nullptr);
  if (file == INVALID_HANDLE_VALUE) {
    CloseHandle(parent);
    return ThrowUnsafeImageFile(env, "UNSAFE_EXECUTION_IMAGE");
  }
  FILE_ID_INFO before_id{};
  FILE_BASIC_INFO before_basic{};
  FILE_STANDARD_INFO before_standard{};
  constexpr LONGLONG kMaximumExecutionImageBytes = 512LL * 1024LL * 1024LL;
  if (!QueryStableImageIdentity(file, &before_id, &before_basic, &before_standard,
                                !allow_hardlinks) ||
      before_standard.EndOfFile.QuadPart < 1 ||
      before_standard.EndOfFile.QuadPart > kMaximumExecutionImageBytes) {
    CloseHandle(file);
    CloseHandle(parent);
    return ThrowUnsafeImageFile(env, "UNSAFE_EXECUTION_IMAGE");
  }
  const size_t byte_length = static_cast<size_t>(before_standard.EndOfFile.QuadPart);
  std::vector<unsigned char> bytes(byte_length);
  size_t offset = 0;
  while (offset < byte_length) {
    DWORD bytes_read = 0;
    const DWORD requested = static_cast<DWORD>(
        std::min<size_t>(byte_length - offset, static_cast<size_t>(MAXDWORD)));
    if (!ReadFile(file, bytes.data() + offset, requested, &bytes_read, nullptr) || bytes_read == 0) {
      CloseHandle(file);
      CloseHandle(parent);
      return ThrowUnsafeImageFile(env, "UNSAFE_EXECUTION_IMAGE");
    }
    offset += bytes_read;
  }
  FILE_ID_INFO after_id{};
  FILE_BASIC_INFO after_basic{};
  FILE_STANDARD_INFO after_standard{};
  if (!QueryStableImageIdentity(file, &after_id, &after_basic, &after_standard,
                                !allow_hardlinks) ||
      !SameImageIdentity(before_id, before_basic, before_standard, after_id, after_basic,
                         after_standard)) {
    CloseHandle(file);
    CloseHandle(parent);
    return ThrowUnsafeImageFile(env, "UNSAFE_EXECUTION_IMAGE");
  }
  const std::string id = std::to_string(GetCurrentProcessId()) + "-" +
                         std::to_string(prepared_execution_sequence.fetch_add(1));
  {
    std::lock_guard<std::mutex> guard(prepared_execution_mutex);
    prepared_execution_images.emplace(id, PreparedExecutionHandles{parent, file});
  }
  napi_value result;
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "id", MakeString(env, id.c_str()));
  napi_value buffer;
  if (napi_create_buffer_copy(env, bytes.size(), bytes.data(), nullptr, &buffer) != napi_ok) {
    std::lock_guard<std::mutex> guard(prepared_execution_mutex);
    prepared_execution_images.erase(id);
    CloseHandle(file);
    CloseHandle(parent);
    return ThrowUnsafeImageFile(env, "UNSAFE_EXECUTION_IMAGE");
  }
  napi_set_named_property(env, result, "bytes", buffer);
  return result;
}

napi_value ClosePreparedExecutionImage(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1) {
    napi_throw_type_error(env, nullptr, "closePreparedExecutionImage requires one id");
    return nullptr;
  }
  std::string id;
  if (!ReadString(env, argv[0], &id)) {
    napi_throw_type_error(env, nullptr, "Invalid prepared execution image id");
    return nullptr;
  }
  PreparedExecutionHandles handles;
  {
    std::lock_guard<std::mutex> guard(prepared_execution_mutex);
    const auto found = prepared_execution_images.find(id);
    if (found == prepared_execution_images.end()) {
      napi_throw_error(env, nullptr, "Prepared execution image is stale");
      return nullptr;
    }
    handles = found->second;
    prepared_execution_images.erase(found);
  }
  CloseHandle(handles.file);
  CloseHandle(handles.parent);
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

bool SameParentPath(const std::wstring& first, const std::wstring& second) {
  const size_t first_separator = first.find_last_of(L"\\/");
  const size_t second_separator = second.find_last_of(L"\\/");
  if (first_separator == std::wstring::npos || second_separator == std::wstring::npos ||
      first_separator != second_separator)
    return false;
  return CompareStringOrdinal(first.data(), static_cast<int>(first_separator), second.data(),
                              static_cast<int>(second_separator), TRUE) == CSTR_EQUAL;
}

bool VolumeSupportsPersistentAcls(const std::wstring& path, bool* supported) {
  std::vector<wchar_t> root(path.size() + 2, L'\0');
  if (!GetVolumePathNameW(path.c_str(), root.data(), static_cast<DWORD>(root.size()))) return false;
  DWORD flags = 0;
  if (!GetVolumeInformationW(root.data(), nullptr, 0, nullptr, nullptr, &flags, nullptr, 0))
    return false;
  *supported = (flags & FILE_PERSISTENT_ACLS) != 0;
  return true;
}

bool CurrentUserSid(std::vector<unsigned char>* storage, PSID* sid) {
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return false;
  DWORD size = 0;
  GetTokenInformation(token, TokenUser, nullptr, 0, &size);
  if (GetLastError() != ERROR_INSUFFICIENT_BUFFER) {
    CloseHandle(token);
    return false;
  }
  storage->resize(size);
  const BOOL ok = GetTokenInformation(token, TokenUser, storage->data(), size, &size);
  const DWORD error = GetLastError();
  CloseHandle(token);
  if (!ok) {
    SetLastError(error);
    return false;
  }
  *sid = reinterpret_cast<TOKEN_USER*>(storage->data())->User.Sid;
  return true;
}

napi_value ApplyWindowsAcl(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 3) {
    napi_throw_type_error(env, nullptr, "applyWindowsAcl requires path, kind, and operation");
    return nullptr;
  }
  std::string path_utf8;
  std::string kind;
  std::string operation;
  std::wstring path;
  if (!ReadString(env, argv[0], &path_utf8) || !ReadString(env, argv[1], &kind) ||
      !ReadString(env, argv[2], &operation) || !Utf8ToWide(path_utf8, &path) ||
      (kind != "file" && kind != "directory") ||
      (operation != "secure" && operation != "verify")) {
    napi_throw_type_error(env, nullptr, "Invalid Windows ACL input");
    return nullptr;
  }

  std::vector<unsigned char> sid_storage;
  PSID current_sid = nullptr;
  if (!CurrentUserSid(&sid_storage, &current_sid)) return ThrowWindowsError(env, "GetTokenInformation");

  if (operation == "secure") {
    EXPLICIT_ACCESSW access{};
    access.grfAccessPermissions = FILE_ALL_ACCESS;
    access.grfAccessMode = SET_ACCESS;
    access.grfInheritance = kind == "directory" ? SUB_CONTAINERS_AND_OBJECTS_INHERIT : NO_INHERITANCE;
    access.Trustee.TrusteeForm = TRUSTEE_IS_SID;
    access.Trustee.TrusteeType = TRUSTEE_IS_USER;
    access.Trustee.ptstrName = static_cast<LPWSTR>(current_sid);
    PACL acl = nullptr;
    DWORD error = SetEntriesInAclW(1, &access, nullptr, &acl);
    if (error == ERROR_SUCCESS) {
      error = SetNamedSecurityInfoW(path.data(), SE_FILE_OBJECT,
                                    OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION |
                                        PROTECTED_DACL_SECURITY_INFORMATION,
                                    current_sid, nullptr, acl, nullptr);
    }
    if (acl != nullptr) LocalFree(acl);
    if (error != ERROR_SUCCESS) {
      SetLastError(error);
      return ThrowWindowsError(env, "SetNamedSecurityInfoW");
    }
  }

  PSID owner = nullptr;
  PACL acl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  DWORD error = GetNamedSecurityInfoW(path.data(), SE_FILE_OBJECT,
                                      OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                                      &owner, nullptr, &acl, nullptr, &descriptor);
  bool valid = error == ERROR_SUCCESS && owner != nullptr && EqualSid(owner, current_sid) &&
               acl != nullptr && acl->AceCount == 1;
  SECURITY_DESCRIPTOR_CONTROL control = 0;
  DWORD revision = 0;
  if (valid) valid = GetSecurityDescriptorControl(descriptor, &control, &revision) &&
                     (control & SE_DACL_PROTECTED) != 0;
  void* raw_ace = nullptr;
  if (valid) valid = GetAce(acl, 0, &raw_ace) != FALSE;
  if (valid) {
    const auto* ace = static_cast<ACCESS_ALLOWED_ACE*>(raw_ace);
    PSID ace_sid = const_cast<DWORD*>(&ace->SidStart);
    // Match the previous .NET verifier: the DACL must be protected and contain exactly one
    // effective allow rule for the current user. Windows may normalize ACE inheritance flags
    // when ReplaceFileW carries the destination security descriptor onto the replacement.
    valid = ace->Header.AceType == ACCESS_ALLOWED_ACE_TYPE && EqualSid(ace_sid, current_sid) &&
            (ace->Mask & FILE_ALL_ACCESS) == FILE_ALL_ACCESS;
  }
  if (descriptor != nullptr) LocalFree(descriptor);
  if (!valid) {
    if (error != ERROR_SUCCESS) SetLastError(error);
    else SetLastError(ERROR_INVALID_ACL);
    return ThrowWindowsError(env, "VerifyWindowsAcl");
  }
  napi_value result;
  napi_get_boolean(env, true, &result);
  return result;
}

napi_value ReplaceFileWithBackup(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 3) {
    napi_throw_type_error(env, nullptr,
                          "replaceFileWithBackup requires replacement, target, and backup paths");
    return nullptr;
  }
  std::string replacement_utf8;
  std::string target_utf8;
  std::string backup_utf8;
  std::wstring replacement;
  std::wstring target;
  std::wstring backup;
  if (!ReadString(env, argv[0], &replacement_utf8) ||
      !ReadString(env, argv[1], &target_utf8) || !ReadString(env, argv[2], &backup_utf8) ||
      !Utf8ToWide(replacement_utf8, &replacement) || !Utf8ToWide(target_utf8, &target) ||
      !Utf8ToWide(backup_utf8, &backup)) {
    napi_throw_type_error(env, nullptr, "Invalid replaceFileWithBackup path");
    return nullptr;
  }
  if (!SameParentPath(replacement, target)) {
    napi_throw_type_error(env, nullptr, "Replacement and target must share a parent directory");
    return nullptr;
  }
  PSID target_owner = nullptr;
  PACL target_dacl = nullptr;
  PSECURITY_DESCRIPTOR target_descriptor = nullptr;
  DWORD error = GetNamedSecurityInfoW(target.data(), SE_FILE_OBJECT,
                                      OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                                      &target_owner, nullptr, &target_dacl, nullptr,
                                      &target_descriptor);
  bool security_unsupported = false;
  if (error == ERROR_NOT_SUPPORTED || error == ERROR_INVALID_FUNCTION) {
    const DWORD security_error = error;
    bool persistent_acls = true;
    if (!VolumeSupportsPersistentAcls(target, &persistent_acls)) {
      error = GetLastError();
    } else if (!persistent_acls) {
      security_unsupported = true;
      error = ERROR_SUCCESS;
    } else {
      error = security_error;
    }
  }
  SECURITY_DESCRIPTOR_CONTROL control = 0;
  DWORD revision = 0;
  if (!security_unsupported && error == ERROR_SUCCESS &&
      !GetSecurityDescriptorControl(target_descriptor, &control, &revision)) {
    error = GetLastError();
  }
  // A NULL DACL grants full access to everyone. Never copy that fail-open state onto staged data.
  if (!security_unsupported && error == ERROR_SUCCESS && target_dacl == nullptr)
    error = ERROR_INVALID_ACL;
  if (!security_unsupported && error == ERROR_SUCCESS) {
    SECURITY_INFORMATION information =
        DACL_SECURITY_INFORMATION |
        ((control & SE_DACL_PROTECTED) != 0 ? PROTECTED_DACL_SECURITY_INFORMATION
                                            : UNPROTECTED_DACL_SECURITY_INFORMATION);
    std::vector<unsigned char> sid_storage;
    PSID current_sid = nullptr;
    if (!CurrentUserSid(&sid_storage, &current_sid)) {
      error = GetLastError();
    } else if (target_owner != nullptr && EqualSid(target_owner, current_sid)) {
      information |= OWNER_SECURITY_INFORMATION;
    } else {
      target_owner = nullptr;
    }
    // ReplaceFileW merges security information. Seed the replacement with the destination DACL
    // first so that the merge preserves arbitrary private or shared ACLs without adding inherited
    // entries from the staging file's parent directory. Also preserve a current-user owner because
    // elevated Windows tokens can otherwise give staging files an Administrators default owner.
    if (error == ERROR_SUCCESS)
      error = SetNamedSecurityInfoW(replacement.data(), SE_FILE_OBJECT, information, target_owner,
                                    nullptr, target_dacl, nullptr);
  }
  if (target_descriptor != nullptr) LocalFree(target_descriptor);
  if (error != ERROR_SUCCESS) {
    SetLastError(error);
    return ThrowWindowsError(env, "PreserveReplaceFileDacl");
  }
  if (!ReplaceFileW(target.c_str(), replacement.c_str(), backup.c_str(),
                    REPLACEFILE_WRITE_THROUGH, nullptr, nullptr))
    return ThrowWindowsError(env, "ReplaceFileW");
  napi_value result;
  napi_get_boolean(env, true, &result);
  return result;
}

napi_value AssignProcessToOwnedJob(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 2) {
    napi_throw_type_error(env, nullptr, "assignProcessToOwnedJob requires pid and job id");
    return nullptr;
  }
  uint32_t pid = 0;
  std::string id;
  if (napi_get_value_uint32(env, argv[0], &pid) != napi_ok || pid == 0 ||
      !ReadString(env, argv[1], &id)) {
    napi_throw_type_error(env, nullptr, "Invalid process job input");
    return nullptr;
  }
  HANDLE process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
                               FALSE, pid);
  if (process == nullptr) return ThrowWindowsError(env, "OpenProcess");
  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  if (job == nullptr) {
    CloseHandle(process);
    return ThrowWindowsError(env, "CreateJobObject");
  }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) ||
      !AssignProcessToJobObject(job, process)) {
    const DWORD error = GetLastError();
    CloseHandle(process);
    CloseHandle(job);
    SetLastError(error);
    return ThrowWindowsError(env, "AssignProcessToJobObject");
  }
  CloseHandle(process);
  {
    std::lock_guard<std::mutex> guard(jobs_mutex);
    if (jobs.contains(id)) {
      CloseHandle(job);
      napi_throw_error(env, "WINDOWS_NATIVE_FAILURE", "Process job id already exists");
      return nullptr;
    }
    jobs.emplace(id, job);
  }
  napi_value result;
  napi_get_boolean(env, true, &result);
  return result;
}

napi_value TerminateOwnedJob(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1) {
    napi_throw_type_error(env, nullptr, "terminateOwnedJob requires a job id");
    return nullptr;
  }
  std::string id;
  if (!ReadString(env, argv[0], &id)) {
    napi_throw_type_error(env, nullptr, "Invalid process job id");
    return nullptr;
  }
  HANDLE job = nullptr;
  {
    std::lock_guard<std::mutex> guard(jobs_mutex);
    const auto found = jobs.find(id);
    if (found == jobs.end()) {
      napi_value result;
      napi_get_boolean(env, false, &result);
      return result;
    }
    job = found->second;
    jobs.erase(found);
  }
  const BOOL terminated = TerminateJobObject(job, 1);
  const DWORD error = GetLastError();
  CloseHandle(job);
  if (!terminated) {
    SetLastError(error);
    return ThrowWindowsError(env, "TerminateJobObject");
  }
  napi_value result;
  napi_get_boolean(env, true, &result);
  return result;
}

napi_value CloseOwnedJob(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1) {
    napi_throw_type_error(env, nullptr, "closeOwnedJob requires a job id");
    return nullptr;
  }
  std::string id;
  if (!ReadString(env, argv[0], &id)) {
    napi_throw_type_error(env, nullptr, "Invalid process job id");
    return nullptr;
  }
  HANDLE job = nullptr;
  {
    std::lock_guard<std::mutex> guard(jobs_mutex);
    const auto found = jobs.find(id);
    if (found != jobs.end()) {
      job = found->second;
      jobs.erase(found);
    }
  }
  if (job != nullptr) CloseHandle(job);
  napi_value result;
  napi_get_boolean(env, job != nullptr, &result);
  return result;
}

napi_value Unsupported(napi_env env, napi_callback_info) {
  napi_value error;
  napi_create_error(env, nullptr,
                    MakeString(env, "NativeSafeFs Windows backend is not available"), &error);
  napi_set_named_property(env, error, "code", MakeString(env, "UNSUPPORTED_PLATFORM"));
  napi_throw(env, error);
  return nullptr;
}

napi_value Probe(napi_env env, napi_callback_info) {
  napi_value result;
  napi_create_object(env, &result);
  napi_value available;
  napi_get_boolean(env, true, &available);
  napi_set_named_property(env, result, "available", available);
  napi_value version;
  napi_create_uint32(env, 1, &version);
  napi_set_named_property(env, result, "apiVersion", version);
  napi_set_named_property(env, result, "platform", MakeString(env, "win32"));
  napi_set_named_property(env, result, "capabilities", WindowsMutationProbeCapabilities(env));
  napi_value unavailable_reason;
  napi_get_null(env, &unavailable_reason);
  napi_set_named_property(env, result, "unavailableReason", unavailable_reason);
  return result;
}

void CleanupPreparedExecutionImages(void*) {
  std::lock_guard<std::mutex> guard(prepared_execution_mutex);
  for (const auto& [id, handles] : prepared_execution_images) {
    (void)id;
    CloseHandle(handles.file);
    CloseHandle(handles.parent);
  }
  prepared_execution_images.clear();
}

napi_value CaseInsensitiveNamesEqual(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  std::string left_utf8, right_utf8;
  std::wstring left, right;
  if (argc != 2 || !ReadString(env, argv[0], &left_utf8) ||
      !ReadString(env, argv[1], &right_utf8) || !Utf8ToWide(left_utf8, &left) ||
      !Utf8ToWide(right_utf8, &right)) {
    napi_throw_error(env, "INVALID_INPUT", "Invalid endpoint names");
    return nullptr;
  }
  const int comparison = CompareStringOrdinal(left.c_str(), static_cast<int>(left.size()),
      right.c_str(), static_cast<int>(right.size()), TRUE);
  if (comparison == 0) return ThrowWindowsError(env, "Compare endpoint names");
  napi_value result;
  napi_get_boolean(env, comparison == CSTR_EQUAL, &result);
  return result;
}

napi_value DirectoryCaseSensitive(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  std::string path_utf8, dev, ino;
  std::wstring path;
  auto read = [&](const char* name, std::string* output) {
    napi_value value;
    return argc == 1 && napi_get_named_property(env, argv[0], name, &value) == napi_ok &&
           ReadString(env, value, output);
  };
  if (!read("path", &path_utf8) || !read("dev", &dev) || !read("ino", &ino) ||
      !Utf8ToWide(path_utf8, &path)) {
    napi_throw_error(env, "INVALID_INPUT", "Invalid directory identity");
    return nullptr;
  }
  HANDLE directory = CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (directory == INVALID_HANDLE_VALUE) return ThrowWindowsError(env, "Open directory");
  BY_HANDLE_FILE_INFORMATION observed {};
  const bool observed_ok = GetFileInformationByHandle(directory, &observed) != FALSE;
  const uint64_t file_id = (static_cast<uint64_t>(observed.nFileIndexHigh) << 32) |
                          observed.nFileIndexLow;
  if (!observed_ok || (observed.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
      (observed.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 ||
      std::to_string(observed.dwVolumeSerialNumber) != dev || std::to_string(file_id) != ino) {
    CloseHandle(directory);
    napi_throw_error(env, "ROOT_IDENTITY_CHANGED", "Directory identity changed");
    return nullptr;
  }
  FILE_CASE_SENSITIVE_INFO rules {};
  const bool queried = GetFileInformationByHandleEx(directory, FileCaseSensitiveInfo,
      &rules, sizeof(rules)) != FALSE;
  const DWORD error = GetLastError();
  CloseHandle(directory);
  if (!queried) {
    SetLastError(error);
    return ThrowWindowsError(env, "Query directory name rules");
  }
  napi_value result;
  napi_get_boolean(env, (rules.Flags & FILE_CS_FLAG_CASE_SENSITIVE_DIR) != 0, &result);
  return result;
}

struct ReadHandleCloser {
  void operator()(void* handle) const {
    if (handle != nullptr && handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
  }
};
using ReadHandle = std::unique_ptr<void, ReadHandleCloser>;

struct ReadSession {
  napi_env owner;
  // Retain every ancestor, not just the last parent: no directory in the namespace may be
  // renamed or turned into a reparse point while its descendant is being observed.
  std::vector<ReadHandle> directories;
  HANDLE root = INVALID_HANDLE_VALUE;
  ReadHandle lock;
};
std::mutex read_sessions_mutex;
std::unordered_map<std::string, std::shared_ptr<ReadSession>> read_sessions;

napi_value ReadFailure(napi_env env, const char* code, const char* message) {
  napi_throw_error(env, code, message);
  return nullptr;
}

bool ReadNamedString(napi_env env, napi_value object, const char* key, std::string* output) {
  napi_value value;
  return napi_get_named_property(env, object, key, &value) == napi_ok &&
         ReadString(env, value, output) && output->size() <= 32767;
}

bool ReadSafeSegment(const std::wstring& segment) {
  if (segment.empty() || segment.size() > 255 || segment == L"." || segment == L".." ||
      segment.back() == L'.' || segment.back() == L' ' ||
      segment.find_first_of(L"\\/:*?\"<>|") != std::wstring::npos)
    return false;
  return std::none_of(segment.begin(), segment.end(), [](wchar_t c) { return c < 32; });
}

NTSTATUS ReadRelative(HANDLE parent, const std::wstring& name, ULONG options, ULONG disposition,
                      HANDLE* output) {
  using NtCreateFileFn = NTSTATUS(NTAPI*)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES,
      PIO_STATUS_BLOCK, PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);
  const auto create = reinterpret_cast<NtCreateFileFn>(
      GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtCreateFile"));
  if (create == nullptr) return static_cast<NTSTATUS>(0xC0000002L);
  UNICODE_STRING unicode{};
  unicode.Buffer = const_cast<PWSTR>(name.data());
  unicode.Length = static_cast<USHORT>(name.size() * sizeof(wchar_t));
  unicode.MaximumLength = unicode.Length;
  OBJECT_ATTRIBUTES attributes{};
  InitializeObjectAttributes(&attributes, &unicode, 0, parent, nullptr);
  IO_STATUS_BLOCK status{};
  // FILE_SHARE_READ excludes existing and future writers/deleters. Together with
  // FILE_OPEN_REPARSE_POINT this closes the check/open and rename/junction windows.
  return create(output, FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                &attributes, &status, nullptr, FILE_ATTRIBUTE_HIDDEN, FILE_SHARE_READ,
                disposition, options | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
                nullptr, 0);
}

bool SafeReadDirectory(HANDLE handle) {
  BY_HANDLE_FILE_INFORMATION info{};
  return GetFileInformationByHandle(handle, &info) &&
         (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0 &&
         (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0;
}

bool PinReadDirectory(HANDLE parent, const std::wstring& segment,
                      std::vector<ReadHandle>* directories) {
  HANDLE raw = INVALID_HANDLE_VALUE;
  if (!ReadSafeSegment(segment) ||
      ReadRelative(parent, segment, FILE_DIRECTORY_FILE, FILE_OPEN, &raw) < 0)
    return false;
  ReadHandle next(raw);
  if (!SafeReadDirectory(next.get())) return false;
  directories->push_back(std::move(next));
  return true;
}

bool PinReadAbsolutePath(const std::string& utf8, std::vector<ReadHandle>* directories) {
  std::wstring path;
  if (!Utf8ToWide(utf8, &path)) return false;
  std::replace(path.begin(), path.end(), L'/', L'\\');
  if (path.rfind(L"\\\\?\\UNC\\", 0) == 0) path = L"\\\\" + path.substr(8);
  else if (path.rfind(L"\\\\?\\", 0) == 0) path = path.substr(4);
  size_t root_length = 0;
  if (path.size() >= 3 && ((path[0] >= L'A' && path[0] <= L'Z') ||
                          (path[0] >= L'a' && path[0] <= L'z')) &&
      path[1] == L':' && path[2] == L'\\') {
    root_length = 3;
  } else if (path.rfind(L"\\\\", 0) == 0) {
    const size_t server_end = path.find(L'\\', 2);
    if (server_end == std::wstring::npos || !ReadSafeSegment(path.substr(2, server_end - 2)))
      return false;
    const size_t share_end = path.find(L'\\', server_end + 1);
    const size_t end = share_end == std::wstring::npos ? path.size() : share_end;
    if (!ReadSafeSegment(path.substr(server_end + 1, end - server_end - 1))) return false;
    root_length = share_end == std::wstring::npos ? end : end + 1;
  } else {
    return false;
  }
  ReadHandle volume(CreateFileW(path.substr(0, root_length).c_str(),
      FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE, FILE_SHARE_READ, nullptr,
      OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (!volume || !SafeReadDirectory(volume.get())) return false;
  directories->push_back(std::move(volume));
  size_t start = root_length;
  while (start < path.size()) {
    const size_t slash = path.find(L'\\', start);
    const size_t end = slash == std::wstring::npos ? path.size() : slash;
    if (!PinReadDirectory(directories->back().get(), path.substr(start, end - start), directories))
      return false;
    start = end + 1;
  }
  return true;
}

std::string ReadHex(const BYTE* bytes, size_t length) {
  static constexpr char hex[] = "0123456789abcdef";
  std::string result(length * 2, '0');
  for (size_t i = 0; i < length; ++i) {
    result[i * 2] = hex[bytes[i] >> 4];
    result[i * 2 + 1] = hex[bytes[i] & 15];
  }
  return result;
}

struct ReadCrypto {
  HCRYPTPROV provider = 0;
  HCRYPTHASH hash = 0;
  ReadCrypto() {
    if (CryptAcquireContextW(&provider, nullptr, nullptr, PROV_RSA_AES, CRYPT_VERIFYCONTEXT))
      CryptCreateHash(provider, CALG_SHA_256, 0, 0, &hash);
  }
  ~ReadCrypto() {
    if (hash) CryptDestroyHash(hash);
    if (provider) CryptReleaseContext(provider, 0);
  }
  bool digest(const BYTE* bytes, DWORD length, std::string* result) {
    BYTE digest[32]{};
    DWORD size = sizeof(digest);
    if (!hash || !CryptHashData(hash, bytes, length, 0) ||
        !CryptGetHashParam(hash, HP_HASHVAL, digest, &size, 0) || size != sizeof(digest))
      return false;
    *result = ReadHex(digest, size);
    return true;
  }
};

napi_value OpenReadSession(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  std::string root_id, workspace, dev, ino, key, lock_path;
  if (argc != 1 || !ReadNamedString(env, argv[0], "rootId", &root_id) ||
      !ReadNamedString(env, argv[0], "workspacePath", &workspace) ||
      !ReadNamedString(env, argv[0], "rootDev", &dev) ||
      !ReadNamedString(env, argv[0], "rootIno", &ino) ||
      !ReadNamedString(env, argv[0], "workspaceKey", &key) || key.size() != 64 ||
      key.find_first_not_of("0123456789abcdef") != std::string::npos ||
      !ReadNamedString(env, argv[0], "lockDirectoryPath", &lock_path))
    return ReadFailure(env, "INVALID_INPUT", "Invalid NativeSafeFs read session input");
  auto session = std::make_shared<ReadSession>();
  session->owner = env;
  if (!PinReadAbsolutePath(workspace, &session->directories))
    return ReadFailure(env, "UNSAFE_PATH", "Cannot pin workspace directory chain");
  session->root = session->directories.back().get();
  BY_HANDLE_FILE_INFORMATION identity{};
  if (!GetFileInformationByHandle(session->root, &identity))
    return ReadFailure(env, "NATIVE_FAILURE", "Cannot read workspace identity");
  const std::string actual_dev = std::to_string(identity.dwVolumeSerialNumber);
  const std::string actual_ino = std::to_string(
      (static_cast<uint64_t>(identity.nFileIndexHigh) << 32) | identity.nFileIndexLow);
  if (actual_dev != dev || actual_ino != ino)
    return ReadFailure(env, "ROOT_IDENTITY_CHANGED", "Workspace root identity changed");
  if (!PinReadAbsolutePath(lock_path, &session->directories))
    return ReadFailure(env, "UNSAFE_LOCK", "Cannot pin workspace lock directory chain");
  HANDLE raw_lock = INVALID_HANDLE_VALUE;
  const std::wstring lock_leaf(key.begin(), key.end());
  const NTSTATUS status = ReadRelative(session->directories.back().get(), lock_leaf + L".lock",
      FILE_NON_DIRECTORY_FILE, FILE_OPEN_IF, &raw_lock);
  if (status == static_cast<NTSTATUS>(0xC0000043L))
    return ReadFailure(env, "LOCK_BUSY", "NativeSafeFs Workspace lock is busy");
  if (status < 0)
    return ReadFailure(env, "UNSAFE_LOCK", "Cannot open shared workspace lock");
  session->lock.reset(raw_lock);
  BY_HANDLE_FILE_INFORMATION lock_info{};
  if (!GetFileInformationByHandle(session->lock.get(), &lock_info) ||
      (lock_info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) ||
      lock_info.nNumberOfLinks != 1)
    return ReadFailure(env, "UNSAFE_LOCK", "Workspace lock is not a unique regular file");
  // Share the mutation lock file but never read, write or advance its durable fence.
  ReadCrypto crypto;
  BYTE random[16]{};
  if (!crypto.provider || !CryptGenRandom(crypto.provider, sizeof(random), random))
    return ReadFailure(env, "NATIVE_FAILURE", "Cannot generate a read session id");
  const std::string id = ReadHex(random, sizeof(random));
  {
    std::lock_guard<std::mutex> guard(read_sessions_mutex);
    if (!read_sessions.emplace(id, session).second)
      return ReadFailure(env, "NATIVE_FAILURE", "Read session id collided");
  }
  napi_value result;
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "id", MakeString(env, id.c_str()));
  napi_set_named_property(env, result, "rootId", MakeString(env, root_id.c_str()));
  napi_set_named_property(env, result, "workspaceKey", MakeString(env, key.c_str()));
  napi_set_named_property(env, result, "rootDev", MakeString(env, actual_dev.c_str()));
  napi_set_named_property(env, result, "rootIno", MakeString(env, actual_ino.c_str()));
  return result;
}

napi_value CloseReadSession(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  std::string id;
  if (argc != 1 || !ReadNamedString(env, argv[0], "id", &id))
    return ReadFailure(env, "INVALID_INPUT", "Invalid NativeSafeFs read session handle");
  {
    std::lock_guard<std::mutex> guard(read_sessions_mutex);
    const auto found = read_sessions.find(id);
    if (found != read_sessions.end() && found->second->owner == env) read_sessions.erase(found);
  }
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

napi_value ObserveSealedPostImage(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1], paths;
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  std::string id;
  bool array = false;
  uint32_t length = 0;
  if (argc != 1 || !ReadNamedString(env, argv[0], "sessionId", &id) ||
      napi_get_named_property(env, argv[0], "pathSegments", &paths) != napi_ok ||
      napi_is_array(env, paths, &array) != napi_ok || !array ||
      napi_get_array_length(env, paths, &length) != napi_ok || length == 0 || length > 128)
    return ReadFailure(env, "INVALID_INPUT", "Invalid sealed endpoint segments");
  std::vector<std::wstring> segments;
  for (uint32_t index = 0; index < length; ++index) {
    napi_value item;
    std::string utf8;
    std::wstring wide;
    if (napi_get_element(env, paths, index, &item) != napi_ok || !ReadString(env, item, &utf8) ||
        utf8.size() > 1024 || !Utf8ToWide(utf8, &wide) || !ReadSafeSegment(wide))
      return ReadFailure(env, "INVALID_INPUT", "Invalid sealed endpoint segment");
    segments.push_back(std::move(wide));
  }
  std::shared_ptr<ReadSession> session;
  {
    std::lock_guard<std::mutex> guard(read_sessions_mutex);
    const auto found = read_sessions.find(id);
    if (found == read_sessions.end() || found->second->owner != env)
      return ReadFailure(env, "STALE_SESSION", "NativeSafeFs read session is stale");
    session = found->second;
  }
  std::vector<ReadHandle> parents;
  HANDLE parent = session->root;
  for (size_t index = 0; index + 1 < segments.size(); ++index) {
    if (!PinReadDirectory(parent, segments[index], &parents))
      return ReadFailure(env, "UNSAFE_PATH", "Cannot pin sealed endpoint parent");
    parent = parents.back().get();
  }
  HANDLE raw = INVALID_HANDLE_VALUE;
  const NTSTATUS status = ReadRelative(parent, segments.back(), 0, FILE_OPEN, &raw);
  const char* kind = "absent";
  std::string content_hash, identity_digest;
  uint64_t size = 0;
  ReadHandle endpoint;
  if (status != static_cast<NTSTATUS>(0xC0000034L)) {
    if (status < 0)
      return ReadFailure(env, "UNSAFE_PATH", "Cannot open sealed endpoint");
    endpoint.reset(raw);
    BY_HANDLE_FILE_INFORMATION before{};
    FILE_BASIC_INFO basic_before{};
    if (!GetFileInformationByHandle(endpoint.get(), &before) ||
        !GetFileInformationByHandleEx(endpoint.get(), FileBasicInfo, &basic_before, sizeof(basic_before)))
      return ReadFailure(env, "UNSAFE_PATH", "Cannot inspect sealed endpoint");
    if (before.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) kind = "other";
    else if (before.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) kind = "directory";
    else if (before.nNumberOfLinks != 1 || GetFileType(endpoint.get()) != FILE_TYPE_DISK) kind = "other";
    else {
      size = (static_cast<uint64_t>(before.nFileSizeHigh) << 32) | before.nFileSizeLow;
      if (size > 1024 * 1024)
        return ReadFailure(env, "UNSAFE_PATH", "Sealed endpoint exceeds the mutation byte limit");
      std::vector<BYTE> bytes(static_cast<size_t>(size));
      DWORD offset = 0;
      while (offset < bytes.size()) {
        DWORD read = 0;
        if (!ReadFile(endpoint.get(), bytes.data() + offset,
                      static_cast<DWORD>(bytes.size()) - offset, &read, nullptr) || read == 0)
          return ReadFailure(env, "UNSAFE_PATH", "Cannot read sealed endpoint bytes");
        offset += read;
      }
      ReadCrypto content;
      if (!content.digest(bytes.data(), static_cast<DWORD>(bytes.size()), &content_hash))
        return ReadFailure(env, "NATIVE_FAILURE", "Cannot hash sealed endpoint bytes");
      // Match the Windows mutation identity formula, including creation time.
      const std::string identity = std::to_string(before.dwVolumeSerialNumber) + ":" +
          std::to_string((static_cast<uint64_t>(before.nFileIndexHigh) << 32) | before.nFileIndexLow) + ":" +
          std::to_string((static_cast<uint64_t>(before.ftCreationTime.dwHighDateTime) << 32) |
                         before.ftCreationTime.dwLowDateTime);
      ReadCrypto identity_hash;
      if (!identity_hash.digest(reinterpret_cast<const BYTE*>(identity.data()),
                                static_cast<DWORD>(identity.size()), &identity_digest))
        return ReadFailure(env, "NATIVE_FAILURE", "Cannot hash sealed endpoint identity");
      BY_HANDLE_FILE_INFORMATION after{};
      FILE_BASIC_INFO basic_after{};
      if (!GetFileInformationByHandle(endpoint.get(), &after) ||
          !GetFileInformationByHandleEx(endpoint.get(), FileBasicInfo, &basic_after, sizeof(basic_after)) ||
          after.nNumberOfLinks != 1 || before.nFileSizeHigh != after.nFileSizeHigh ||
          before.nFileSizeLow != after.nFileSizeLow ||
          basic_before.ChangeTime.QuadPart != basic_after.ChangeTime.QuadPart ||
          basic_before.LastWriteTime.QuadPart != basic_after.LastWriteTime.QuadPart)
        return ReadFailure(env, "UNSAFE_PATH", "Sealed endpoint changed while reading");
      kind = "file";
    }
  }
  napi_value result;
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "kind", MakeString(env, kind));
  if (!content_hash.empty()) {
    napi_set_named_property(env, result, "contentHash", MakeString(env, content_hash.c_str()));
    napi_set_named_property(env, result, "identityDigest", MakeString(env, identity_digest.c_str()));
    napi_value bytes;
    napi_create_double(env, static_cast<double>(size), &bytes);
    napi_set_named_property(env, result, "size", bytes);
  }
  return result;
}

void CleanupReadSessions(void* owner) {
  std::lock_guard<std::mutex> guard(read_sessions_mutex);
  for (auto it = read_sessions.begin(); it != read_sessions.end();) {
    if (it->second->owner == owner) it = read_sessions.erase(it);
    else ++it;
  }
}

napi_value Initialize(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"caseInsensitiveNamesEqual", nullptr, CaseInsensitiveNamesEqual, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"directoryCaseSensitive", nullptr, DirectoryCaseSensitive, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"probe", nullptr, Probe, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"queryProcessIdentity", nullptr, QueryProcessIdentity, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"queryNamedPipePeerIdentity", nullptr, QueryNamedPipePeerIdentity, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"openSession", nullptr, WindowsMutationOpenSession, nullptr, nullptr, nullptr, napi_default,
       nullptr},
      {"invalidateWorkspace", nullptr, WindowsMutationInvalidateWorkspace, nullptr, nullptr,
       nullptr, napi_default, nullptr},
      {"observeIntent", nullptr, WindowsMutationObserveIntent, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"stageIntentArtifact", nullptr, WindowsMutationStageIntentArtifact, nullptr, nullptr,
       nullptr, napi_default, nullptr},
      {"applyIntentEffect", nullptr, WindowsMutationApplyIntentEffect, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"cleanupIntentAuxiliary", nullptr, WindowsMutationCleanupIntentAuxiliary, nullptr, nullptr,
       nullptr, napi_default, nullptr},
      {"observeDirectory", nullptr, Unsupported, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"openReadSession", nullptr, OpenReadSession, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"closeReadSession", nullptr, CloseReadSession, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"observeSealedPostImage", nullptr, ObserveSealedPostImage, nullptr, nullptr, nullptr, napi_default,
       nullptr},
      {"createDirectory", nullptr, Unsupported, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"inspectDirectoryOwnership", nullptr, Unsupported, nullptr, nullptr, nullptr, napi_default,
       nullptr},
      {"cleanupDirectoryOwnership", nullptr, Unsupported, nullptr, nullptr, nullptr, napi_default,
       nullptr},
      {"removeDirectory", nullptr, Unsupported, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"cleanupDirectoryRemoval", nullptr, Unsupported, nullptr, nullptr, nullptr, napi_default,
       nullptr},
      {"closeSession", nullptr, WindowsMutationCloseSession, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"assignProcessToOwnedJob", nullptr, AssignProcessToOwnedJob, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"terminateOwnedJob", nullptr, TerminateOwnedJob, nullptr, nullptr, nullptr, napi_default,
       nullptr},
      {"closeOwnedJob", nullptr, CloseOwnedJob, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"replaceFileWithBackup", nullptr, ReplaceFileWithBackup, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"applyWindowsAcl", nullptr, ApplyWindowsAcl, nullptr, nullptr, nullptr, napi_default,
       nullptr},
      {"readNoReparseImageFile", nullptr, ReadNoReparseImageFile, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"getTrustedSystemDirectory", nullptr, GetTrustedSystemDirectory, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"holdPreparedExecutionImage", nullptr, HoldPreparedExecutionImage, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"closePreparedExecutionImage", nullptr, ClosePreparedExecutionImage, nullptr, nullptr,
       nullptr, napi_default, nullptr},
      {"enableSafeDllSearchPolicy", nullptr, EnableSafeDllSearchPolicy, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"runPreparedExecutionImage", nullptr, RunPreparedExecutionImage, nullptr, nullptr, nullptr,
       napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  napi_add_env_cleanup_hook(env, CleanupPreparedExecutionImages, nullptr);
  napi_add_env_cleanup_hook(env, CleanupReadSessions, env);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)
