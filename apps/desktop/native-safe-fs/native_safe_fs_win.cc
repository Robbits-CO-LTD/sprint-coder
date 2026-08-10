#include <node_api.h>
#include <windows.h>
#include <aclapi.h>

#include <mutex>
#include <cstring>
#include <string>
#include <unordered_map>
#include <vector>

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

napi_value ThrowUnsafeImageFile(napi_env env, const char* code) {
  napi_value error;
  napi_create_error(env, nullptr, MakeString(env, "The selected image file is unsafe"), &error);
  napi_set_named_property(env, error, "code", MakeString(env, code));
  napi_throw(env, error);
  return nullptr;
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
                              FILE_STANDARD_INFO* standard) {
  FILE_ATTRIBUTE_TAG_INFO tag{};
  if (!GetFileInformationByHandleEx(file, FileAttributeTagInfo, &tag, sizeof(tag)) ||
      (tag.FileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0 ||
      tag.ReparseTag != 0 ||
      !GetFileInformationByHandleEx(file, FileIdInfo, id, sizeof(*id)) ||
      !GetFileInformationByHandleEx(file, FileBasicInfo, basic, sizeof(*basic)) ||
      !GetFileInformationByHandleEx(file, FileStandardInfo, standard, sizeof(*standard)))
    return false;
  return !standard->Directory && !standard->DeletePending && standard->NumberOfLinks == 1;
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
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1) {
    napi_throw_type_error(env, nullptr, "readNoReparseImageFile requires one absolute path");
    return nullptr;
  }
  std::string path_utf8;
  std::wstring path;
  if (!ReadString(env, argv[0], &path_utf8) || !Utf8ToWide(path_utf8, &path)) {
    napi_throw_type_error(env, nullptr, "Invalid image path");
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
  constexpr LONGLONG kMaximumBytes = 5LL * 1024LL * 1024LL;
  bool safe = QueryStableImageIdentity(file, &before_id, &before_basic, &before_standard);
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
  safe = QueryStableImageIdentity(file, &after_id, &after_basic, &after_standard) &&
         SameImageIdentity(before_id, before_basic, before_standard, after_id, after_basic,
                           after_standard);
  CloseHandle(file);
  if (!safe) return ThrowUnsafeImageFile(env, "UNSAFE_IMAGE_FILE");

  napi_value result;
  if (napi_create_buffer_copy(env, bytes.size(), bytes.data(), nullptr, &result) != napi_ok)
    return ThrowUnsafeImageFile(env, "UNSAFE_IMAGE_FILE");
  return result;
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
      {"applyWindowsAcl", nullptr, ApplyWindowsAcl, nullptr, nullptr, nullptr, napi_default,
       nullptr},
      {"readNoReparseImageFile", nullptr, ReadNoReparseImageFile, nullptr, nullptr, nullptr,
       napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)
