#include <node_api.h>
#include <windows.h>

#include <mutex>
#include <string>
#include <unordered_map>

namespace {

std::mutex jobs_mutex;
std::unordered_map<std::string, HANDLE> jobs;

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
  napi_get_boolean(env, false, &available);
  napi_set_named_property(env, result, "available", available);
  napi_value version;
  napi_create_uint32(env, 1, &version);
  napi_set_named_property(env, result, "apiVersion", version);
  napi_set_named_property(env, result, "platform", MakeString(env, "win32"));
  napi_set_named_property(env, result, "unavailableReason",
                          MakeString(env, "Windows backend is not implemented"));
  return result;
}

napi_value Initialize(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"probe", nullptr, Probe, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"openSession", nullptr, Unsupported, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"invalidateWorkspace", nullptr, Unsupported, nullptr, nullptr, nullptr, napi_default,
       nullptr},
      {"closeSession", nullptr, Unsupported, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"assignProcessToOwnedJob", nullptr, AssignProcessToOwnedJob, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"terminateOwnedJob", nullptr, TerminateOwnedJob, nullptr, nullptr, nullptr, napi_default,
       nullptr},
      {"closeOwnedJob", nullptr, CloseOwnedJob, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"replaceFileWithBackup", nullptr, ReplaceFileWithBackup, nullptr, nullptr, nullptr,
       napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)
