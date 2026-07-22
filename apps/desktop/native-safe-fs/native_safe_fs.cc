#include <node_api.h>

#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

#include <array>
#include <cerrno>
#include <charconv>
#include <cstdint>
#include <cstring>
#include <mutex>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

namespace {

struct NativeFailure {
  std::string code;
  std::string message;
};

struct Session {
  std::string id;
  std::string workspace_key;
  std::string root_dev;
  std::string root_ino;
  uint64_t fence = 0;
  int root_fd = -1;
  int lock_directory_fd = -1;
  int lock_fd = -1;
};

struct GlobalState {
  std::mutex mutex;
  std::unordered_map<std::string, Session> sessions;
  std::unordered_map<std::string, std::string> active_by_workspace;
  std::unordered_set<std::string> opening_workspaces;
  std::unordered_set<std::string> closing_workspaces;
  std::unordered_map<std::string, uint64_t> highest_fences;
  std::unordered_map<std::string, uint64_t> invalidation_versions;
};

GlobalState state;

void CloseFd(int* fd) {
  if (*fd >= 0) {
    close(*fd);
    *fd = -1;
  }
}

void ReleaseSession(Session* session) {
  if (session->lock_fd >= 0) flock(session->lock_fd, LOCK_UN);
  if (session->root_fd >= 0) flock(session->root_fd, LOCK_UN);
  CloseFd(&session->lock_fd);
  CloseFd(&session->lock_directory_fd);
  CloseFd(&session->root_fd);
}

bool ParsePositiveDecimal(const std::string& value, uint64_t* result) {
  if (value.empty() || value[0] == '0') return false;
  uint64_t parsed = 0;
  const auto conversion = std::from_chars(value.data(), value.data() + value.size(), parsed);
  if (conversion.ec != std::errc() || conversion.ptr != value.data() + value.size() || parsed == 0)
    return false;
  *result = parsed;
  return true;
}

bool IsLowerHex(const std::string& value, size_t size) {
  if (value.size() != size) return false;
  for (char character : value) {
    if (!((character >= '0' && character <= '9') ||
          (character >= 'a' && character <= 'f')))
      return false;
  }
  return true;
}

std::string ErrnoMessage(const char* operation) {
  return std::string(operation) + ": " + std::strerror(errno);
}

bool ReadString(napi_env env, napi_value object, const char* name, std::string* output) {
  napi_value value;
  if (napi_get_named_property(env, object, name, &value) != napi_ok) return false;
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) return false;
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) return false;
  std::vector<char> buffer(length + 1);
  if (napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(), &length) != napi_ok)
    return false;
  output->assign(buffer.data(), length);
  return output->find('\0') == std::string::npos;
}

napi_value MakeString(napi_env env, const std::string& value) {
  napi_value result;
  napi_create_string_utf8(env, value.c_str(), value.size(), &result);
  return result;
}

napi_value MakeError(napi_env env, const NativeFailure& failure) {
  napi_value message = MakeString(env, failure.message);
  napi_value error;
  napi_create_error(env, nullptr, message, &error);
  napi_set_named_property(env, error, "code", MakeString(env, failure.code));
  return error;
}

napi_value ThrowFailure(napi_env env, const std::string& code, const std::string& message) {
  napi_throw(env, MakeError(env, NativeFailure{code, message}));
  return nullptr;
}

bool SplitAbsolutePath(const std::string& path, std::vector<std::string>* components) {
  if (path.empty() || path[0] != '/' || path.find('\0') != std::string::npos) return false;
  size_t start = 1;
  while (start <= path.size()) {
    const size_t end = path.find('/', start);
    const size_t length = (end == std::string::npos ? path.size() : end) - start;
    if (length > 0) {
      std::string component = path.substr(start, length);
      if (component == "." || component == "..") return false;
      components->push_back(std::move(component));
    }
    if (end == std::string::npos) break;
    start = end + 1;
  }
  return true;
}

int OpenDirectoryChain(const std::string& path, NativeFailure* failure,
                       const char* unsafe_code) {
  std::vector<std::string> components;
  if (!SplitAbsolutePath(path, &components)) {
    *failure = {"INVALID_INPUT", "NativeSafeFs requires an absolute canonical path"};
    return -1;
  }
  int current = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (current < 0) {
    *failure = {"NATIVE_FAILURE", ErrnoMessage("open root directory")};
    return -1;
  }
  for (const std::string& component : components) {
    int next = openat(current, component.c_str(),
                      O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (next < 0) {
      const int saved_errno = errno;
      CloseFd(&current);
      errno = saved_errno;
      *failure = {unsafe_code, ErrnoMessage("open path component")};
      return -1;
    }
    CloseFd(&current);
    current = next;
  }
  return current;
}

uint64_t FenceChecksum(const std::string& payload) {
  uint64_t hash = 1469598103934665603ULL;
  for (unsigned char byte : payload) {
    hash ^= byte;
    hash *= 1099511628211ULL;
  }
  return hash;
}

std::string Hex64(uint64_t value) {
  constexpr char digits[] = "0123456789abcdef";
  std::string result(16, '0');
  for (size_t index = 0; index < result.size(); ++index) {
    result[result.size() - index - 1] = digits[value & 0x0f];
    value >>= 4;
  }
  return result;
}

bool ParseHex64(const std::string& value, uint64_t* result) {
  if (value.size() != 16) return false;
  uint64_t parsed = 0;
  for (char character : value) {
    parsed <<= 4;
    if (character >= '0' && character <= '9')
      parsed |= static_cast<uint64_t>(character - '0');
    else if (character >= 'a' && character <= 'f')
      parsed |= static_cast<uint64_t>(character - 'a' + 10);
    else
      return false;
  }
  *result = parsed;
  return true;
}

bool AppendRecord(int fd, const std::string& record, NativeFailure* failure) {
  const off_t end = lseek(fd, 0, SEEK_END);
  if (end < 0) {
    *failure = {"NATIVE_FAILURE", ErrnoMessage("seek lock record")};
    return false;
  }
  size_t offset = 0;
  while (offset < record.size()) {
    const ssize_t written = pwrite(fd, record.data() + offset, record.size() - offset,
                                   end + static_cast<off_t>(offset));
    if (written < 0) {
      if (errno == EINTR) continue;
      *failure = {"NATIVE_FAILURE", ErrnoMessage("write lock record")};
      return false;
    }
    offset += static_cast<size_t>(written);
  }
  if (fsync(fd) != 0) {
    *failure = {"NATIVE_FAILURE", ErrnoMessage("fsync lock record")};
    return false;
  }
  return true;
}

bool StoreFence(Session* session, uint64_t fence, NativeFailure* failure) {
  const std::string payload = "v1 " + session->workspace_key + " " + std::to_string(fence);
  const std::string record = payload + " " + Hex64(FenceChecksum(payload)) + "\n";
  if (!AppendRecord(session->lock_fd, record, failure)) return false;
  if (fsync(session->lock_directory_fd) != 0) {
    *failure = {"NATIVE_FAILURE", ErrnoMessage("fsync lock directory")};
    return false;
  }
  return true;
}

bool ReadExistingFence(int fd, const std::string& workspace_key, bool newly_created,
                       uint64_t* fence, NativeFailure* failure) {
  struct stat file_stat {};
  if (fstat(fd, &file_stat) != 0) {
    *failure = {"NATIVE_FAILURE", ErrnoMessage("stat lock record")};
    return false;
  }
  if (file_stat.st_size < 0 || file_stat.st_size > 1024 * 1024) {
    *failure = {"UNSAFE_LOCK", "NativeSafeFs lock record has an unsafe size"};
    return false;
  }
  std::string record(static_cast<size_t>(file_stat.st_size), '\0');
  size_t offset = 0;
  while (offset < record.size()) {
    const ssize_t count = pread(fd, record.data() + offset, record.size() - offset,
                                static_cast<off_t>(offset));
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) {
      *failure = {"NATIVE_FAILURE", ErrnoMessage("read lock record")};
      return false;
    }
    offset += static_cast<size_t>(count);
  }
  if (record.empty()) {
    if (!newly_created) {
      *failure = {"UNSAFE_LOCK", "Existing NativeSafeFs lock record is empty"};
      return false;
    }
    *fence = 0;
    return true;
  }
  size_t valid_length = record.size();
  if (record.back() != '\n') {
    const size_t newline = record.rfind('\n');
    if (newline == std::string::npos) {
      *failure = {"UNSAFE_LOCK", "NativeSafeFs lock record has no durable entry"};
      return false;
    }
    valid_length = newline + 1;
  }
  uint64_t maximum = 0;
  size_t line_start = 0;
  while (line_start < valid_length) {
    const size_t line_end = record.find('\n', line_start);
    if (line_end == std::string::npos || line_end >= valid_length) {
      *failure = {"UNSAFE_LOCK", "NativeSafeFs lock record boundary is malformed"};
      return false;
    }
    const std::string line = record.substr(line_start, line_end - line_start);
    const size_t checksum_separator = line.rfind(' ');
    if (checksum_separator == std::string::npos) {
      *failure = {"UNSAFE_LOCK", "NativeSafeFs lock record checksum is missing"};
      return false;
    }
    const std::string payload = line.substr(0, checksum_separator);
    const std::string prefix = "v1 " + workspace_key + " ";
    uint64_t checksum = 0;
    uint64_t parsed_fence = 0;
    if (!payload.starts_with(prefix) ||
        !ParsePositiveDecimal(payload.substr(prefix.size()), &parsed_fence) ||
        !ParseHex64(line.substr(checksum_separator + 1), &checksum) ||
        checksum != FenceChecksum(payload)) {
      *failure = {"UNSAFE_LOCK", "NativeSafeFs lock record is malformed"};
      return false;
    }
    if (parsed_fence < maximum) {
      *failure = {"UNSAFE_LOCK", "NativeSafeFs lock fence regressed"};
      return false;
    }
    maximum = parsed_fence;
    line_start = line_end + 1;
  }
  if (valid_length != record.size()) {
    if (ftruncate(fd, static_cast<off_t>(valid_length)) != 0 || fsync(fd) != 0) {
      *failure = {"NATIVE_FAILURE", ErrnoMessage("repair partial lock record")};
      return false;
    }
  }
  if (maximum == 0) {
    *failure = {"UNSAFE_LOCK", "NativeSafeFs lock record has no valid fence"};
    return false;
  }
  *fence = maximum;
  return true;
}

bool FillRandom(std::array<unsigned char, 16>* bytes) {
#if defined(__APPLE__)
  arc4random_buf(bytes->data(), bytes->size());
  return true;
#else
  int fd = open("/dev/urandom", O_RDONLY | O_CLOEXEC);
  if (fd < 0) return false;
  size_t offset = 0;
  while (offset < bytes->size()) {
    const ssize_t count = read(fd, bytes->data() + offset, bytes->size() - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) {
      CloseFd(&fd);
      return false;
    }
    offset += static_cast<size_t>(count);
  }
  CloseFd(&fd);
  return true;
#endif
}

std::string RandomSessionId() {
  std::array<unsigned char, 16> bytes{};
  if (!FillRandom(&bytes)) return {};
  constexpr char hex[] = "0123456789abcdef";
  std::string result(32, '0');
  for (size_t index = 0; index < bytes.size(); ++index) {
    result[index * 2] = hex[bytes[index] >> 4];
    result[index * 2 + 1] = hex[bytes[index] & 0x0f];
  }
  return result;
}

struct OpenWork {
  napi_env env = nullptr;
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  Session session;
  std::string workspace_path;
  std::string lock_directory_path;
  NativeFailure failure;
  uint64_t invalidation_version = 0;
  bool success = false;
};

bool VerifyDirectoryNamespace(const std::string& path, int pinned_fd, NativeFailure* failure) {
  int current_fd = OpenDirectoryChain(path, failure, "UNSAFE_LOCK");
  if (current_fd < 0) return false;
  struct stat pinned_stat {};
  struct stat current_stat {};
  const bool matches = fstat(pinned_fd, &pinned_stat) == 0 &&
                       fstat(current_fd, &current_stat) == 0 &&
                       pinned_stat.st_dev == current_stat.st_dev &&
                       pinned_stat.st_ino == current_stat.st_ino;
  CloseFd(&current_fd);
  if (!matches) {
    *failure = {"UNSAFE_LOCK", "NativeSafeFs lock directory namespace changed"};
    return false;
  }
  return true;
}

void ExecuteOpen(napi_env, void* data) {
  auto* context = static_cast<OpenWork*>(data);
  Session& session = context->session;
  session.root_fd = OpenDirectoryChain(context->workspace_path, &context->failure, "UNSAFE_PATH");
  if (session.root_fd < 0) return;
  struct stat root_stat {};
  if (fstat(session.root_fd, &root_stat) != 0) {
    context->failure = {"NATIVE_FAILURE", ErrnoMessage("stat workspace root")};
    return;
  }
  if (std::to_string(static_cast<uint64_t>(root_stat.st_dev)) != session.root_dev ||
      std::to_string(static_cast<uint64_t>(root_stat.st_ino)) != session.root_ino) {
    context->failure = {"ROOT_IDENTITY_CHANGED", "Workspace root identity changed"};
    return;
  }
  if (flock(session.root_fd, LOCK_EX | LOCK_NB) != 0) {
    context->failure = {errno == EWOULDBLOCK ? "LOCK_BUSY" : "NATIVE_FAILURE",
                        ErrnoMessage("lock workspace root")};
    return;
  }

  session.lock_directory_fd =
      OpenDirectoryChain(context->lock_directory_path, &context->failure, "UNSAFE_LOCK");
  if (session.lock_directory_fd < 0) return;
  struct stat directory_stat {};
  if (fstat(session.lock_directory_fd, &directory_stat) != 0 ||
      directory_stat.st_uid != geteuid() || (directory_stat.st_mode & 0022) != 0) {
    context->failure = {"UNSAFE_LOCK", "NativeSafeFs lock directory is not private"};
    return;
  }

  const std::string leaf = session.workspace_key + ".lock";
  bool newly_created = true;
  session.lock_fd = openat(session.lock_directory_fd, leaf.c_str(),
                           O_RDWR | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (session.lock_fd < 0 && errno == EEXIST) {
    newly_created = false;
    session.lock_fd =
        openat(session.lock_directory_fd, leaf.c_str(), O_RDWR | O_CLOEXEC | O_NOFOLLOW);
  }
  if (session.lock_fd < 0) {
    context->failure = {"UNSAFE_LOCK", ErrnoMessage("open workspace lock")};
    return;
  }
  struct stat lock_stat {};
  if (fstat(session.lock_fd, &lock_stat) != 0 || !S_ISREG(lock_stat.st_mode) ||
      lock_stat.st_uid != geteuid() || lock_stat.st_nlink != 1 ||
      (lock_stat.st_mode & 0077) != 0) {
    context->failure = {"UNSAFE_LOCK", "NativeSafeFs lock file is not private and unique"};
    return;
  }
  if (flock(session.lock_fd, LOCK_EX | LOCK_NB) != 0) {
    context->failure = {errno == EWOULDBLOCK ? "LOCK_BUSY" : "NATIVE_FAILURE",
                        ErrnoMessage("lock workspace")};
    return;
  }
  struct stat namespace_stat {};
  if (fstatat(session.lock_directory_fd, leaf.c_str(), &namespace_stat,
              AT_SYMLINK_NOFOLLOW) != 0 || !S_ISREG(namespace_stat.st_mode) ||
      namespace_stat.st_dev != lock_stat.st_dev || namespace_stat.st_ino != lock_stat.st_ino) {
    context->failure = {"UNSAFE_LOCK", "Workspace lock namespace changed"};
    return;
  }
  if (!VerifyDirectoryNamespace(context->lock_directory_path, session.lock_directory_fd,
                                &context->failure))
    return;
  uint64_t durable_fence = 0;
  if (!ReadExistingFence(session.lock_fd, session.workspace_key, newly_created, &durable_fence,
                         &context->failure))
    return;
  if (durable_fence >= session.fence) {
    context->failure = {"STALE_FENCE", "Workspace mutation fence is stale"};
    return;
  }
  if (!StoreFence(&session, session.fence, &context->failure)) return;
  session.id = RandomSessionId();
  if (session.id.empty()) {
    context->failure = {"NATIVE_FAILURE", "Failed to generate a NativeSafeFs session id"};
    return;
  }
  context->success = true;
}

void CompleteOpen(napi_env env, napi_status status, void* data) {
  auto* context = static_cast<OpenWork*>(data);
  bool accepted = status == napi_ok && context->success;
  uint64_t invalidating_fence = 0;
  {
    std::lock_guard<std::mutex> guard(state.mutex);
    state.opening_workspaces.erase(context->session.workspace_key);
    const uint64_t highest = state.highest_fences[context->session.workspace_key];
    const uint64_t invalidation_version =
        state.invalidation_versions[context->session.workspace_key];
    if (invalidation_version != context->invalidation_version ||
        highest >= context->session.fence) {
      accepted = false;
      invalidating_fence = highest;
      context->failure = {"STALE_FENCE", "Workspace session was synchronously invalidated"};
    }
    if (accepted) {
      state.highest_fences[context->session.workspace_key] = context->session.fence;
      state.active_by_workspace[context->session.workspace_key] = context->session.id;
      state.sessions.emplace(context->session.id, context->session);
    }
  }
  if (!accepted) {
    if (invalidating_fence > context->session.fence && context->session.lock_fd >= 0) {
      NativeFailure ignored;
      StoreFence(&context->session, invalidating_fence, &ignored);
    }
    ReleaseSession(&context->session);
    if (context->failure.code.empty())
      context->failure = {"NATIVE_FAILURE", "NativeSafeFs asynchronous open failed"};
    napi_reject_deferred(env, context->deferred, MakeError(env, context->failure));
  } else {
    napi_value result;
    napi_create_object(env, &result);
    napi_set_named_property(env, result, "id", MakeString(env, context->session.id));
    napi_set_named_property(env, result, "workspaceKey",
                            MakeString(env, context->session.workspace_key));
    napi_set_named_property(env, result, "fence",
                            MakeString(env, std::to_string(context->session.fence)));
    napi_set_named_property(env, result, "rootDev", MakeString(env, context->session.root_dev));
    napi_set_named_property(env, result, "rootIno", MakeString(env, context->session.root_ino));
    napi_resolve_deferred(env, context->deferred, result);
  }
  napi_delete_async_work(env, context->work);
  delete context;
}

napi_value OpenSession(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  napi_valuetype type;
  if (argc != 1 || napi_typeof(env, argv[0], &type) != napi_ok || type != napi_object)
    return ThrowFailure(env, "INVALID_INPUT", "NativeSafeFs open input must be an object");

  auto* context = new OpenWork();
  context->env = env;
  std::string fence_string;
  if (!ReadString(env, argv[0], "workspacePath", &context->workspace_path) ||
      !ReadString(env, argv[0], "lockDirectoryPath", &context->lock_directory_path) ||
      !ReadString(env, argv[0], "workspaceKey", &context->session.workspace_key) ||
      !ReadString(env, argv[0], "rootDev", &context->session.root_dev) ||
      !ReadString(env, argv[0], "rootIno", &context->session.root_ino) ||
      !ReadString(env, argv[0], "fence", &fence_string) ||
      !IsLowerHex(context->session.workspace_key, 64) ||
      !ParsePositiveDecimal(fence_string, &context->session.fence)) {
    delete context;
    return ThrowFailure(env, "INVALID_INPUT", "Invalid NativeSafeFs open input");
  }
  {
    std::lock_guard<std::mutex> guard(state.mutex);
    const std::string& key = context->session.workspace_key;
    if (state.opening_workspaces.contains(key) || state.active_by_workspace.contains(key) ||
        state.closing_workspaces.contains(key)) {
      delete context;
      return ThrowFailure(env, "LOCK_BUSY", "Workspace already has an active native session");
    }
    const auto highest = state.highest_fences.find(key);
    if (highest != state.highest_fences.end() && highest->second >= context->session.fence) {
      delete context;
      return ThrowFailure(env, "STALE_FENCE", "Workspace mutation fence is stale");
    }
    context->invalidation_version = state.invalidation_versions[key];
    state.opening_workspaces.insert(key);
  }
  napi_value promise;
  napi_create_promise(env, &context->deferred, &promise);
  napi_value resource_name = MakeString(env, "NativeSafeFs.openSession");
  const napi_status create_status = napi_create_async_work(
      env, nullptr, resource_name, ExecuteOpen, CompleteOpen, context, &context->work);
  const napi_status queue_status =
      create_status == napi_ok ? napi_queue_async_work(env, context->work) : create_status;
  if (create_status != napi_ok || queue_status != napi_ok) {
    {
      std::lock_guard<std::mutex> guard(state.mutex);
      state.opening_workspaces.erase(context->session.workspace_key);
    }
    if (create_status == napi_ok) napi_delete_async_work(env, context->work);
    delete context;
    return ThrowFailure(env, "NATIVE_FAILURE", "Failed to queue NativeSafeFs open");
  }
  return promise;
}

struct CloseWork {
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  Session session;
};

void ExecuteClose(napi_env, void* data) {
  auto* context = static_cast<CloseWork*>(data);
  ReleaseSession(&context->session);
}

void CompleteClose(napi_env env, napi_status status, void* data) {
  auto* context = static_cast<CloseWork*>(data);
  {
    std::lock_guard<std::mutex> guard(state.mutex);
    state.closing_workspaces.erase(context->session.workspace_key);
  }
  if (status == napi_ok) {
    napi_value undefined;
    napi_get_undefined(env, &undefined);
    napi_resolve_deferred(env, context->deferred, undefined);
  } else {
    napi_reject_deferred(env, context->deferred,
                         MakeError(env, {"NATIVE_FAILURE", "NativeSafeFs close failed"}));
  }
  napi_delete_async_work(env, context->work);
  delete context;
}

napi_value CloseSession(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  std::string id;
  if (argc != 1) return ThrowFailure(env, "INVALID_INPUT", "Session id is required");
  size_t length = 0;
  napi_valuetype type;
  if (napi_typeof(env, argv[0], &type) != napi_ok || type != napi_string ||
      napi_get_value_string_utf8(env, argv[0], nullptr, 0, &length) != napi_ok) {
    return ThrowFailure(env, "INVALID_INPUT", "Session id must be a string");
  }
  std::vector<char> buffer(length + 1);
  napi_get_value_string_utf8(env, argv[0], buffer.data(), buffer.size(), &length);
  id.assign(buffer.data(), length);
  auto* context = new CloseWork();
  {
    std::lock_guard<std::mutex> guard(state.mutex);
    auto found = state.sessions.find(id);
    if (found == state.sessions.end()) {
      delete context;
      return ThrowFailure(env, "STALE_SESSION", "NativeSafeFs session is stale");
    }
    context->session = found->second;
    state.active_by_workspace.erase(found->second.workspace_key);
    state.closing_workspaces.insert(found->second.workspace_key);
    state.sessions.erase(found);
  }
  napi_value promise;
  napi_create_promise(env, &context->deferred, &promise);
  napi_value resource_name = MakeString(env, "NativeSafeFs.closeSession");
  const napi_status create_status = napi_create_async_work(
      env, nullptr, resource_name, ExecuteClose, CompleteClose, context, &context->work);
  const napi_status queue_status =
      create_status == napi_ok ? napi_queue_async_work(env, context->work) : create_status;
  if (create_status != napi_ok || queue_status != napi_ok) {
    {
      std::lock_guard<std::mutex> guard(state.mutex);
      state.closing_workspaces.erase(context->session.workspace_key);
    }
    ReleaseSession(&context->session);
    if (create_status == napi_ok) napi_delete_async_work(env, context->work);
    delete context;
    return ThrowFailure(env, "NATIVE_FAILURE", "Failed to queue NativeSafeFs close");
  }
  return promise;
}

napi_value InvalidateWorkspace(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc != 2) return ThrowFailure(env, "INVALID_INPUT", "Invalidation requires two strings");
  std::string workspace_key;
  std::string fence_string;
  napi_value holder;
  napi_create_object(env, &holder);
  napi_set_named_property(env, holder, "workspaceKey", argv[0]);
  napi_set_named_property(env, holder, "fence", argv[1]);
  if (!ReadString(env, holder, "workspaceKey", &workspace_key) ||
      !ReadString(env, holder, "fence", &fence_string) || !IsLowerHex(workspace_key, 64))
    return ThrowFailure(env, "INVALID_INPUT", "Invalid NativeSafeFs invalidation input");
  uint64_t fence = 0;
  if (!ParsePositiveDecimal(fence_string, &fence))
    return ThrowFailure(env, "INVALID_INPUT", "Invalid NativeSafeFs invalidation fence");

  Session invalidated;
  bool has_session = false;
  {
    std::lock_guard<std::mutex> guard(state.mutex);
    ++state.invalidation_versions[workspace_key];
    uint64_t& highest = state.highest_fences[workspace_key];
    if (fence > highest) highest = fence;
    auto active = state.active_by_workspace.find(workspace_key);
    if (active != state.active_by_workspace.end()) {
      auto session = state.sessions.find(active->second);
      if (session != state.sessions.end()) {
        invalidated = session->second;
        state.sessions.erase(session);
        has_session = true;
      }
      state.active_by_workspace.erase(active);
    }
  }
  if (has_session) {
    NativeFailure failure;
    uint64_t durable_fence;
    {
      std::lock_guard<std::mutex> guard(state.mutex);
      durable_fence = state.highest_fences[workspace_key];
    }
    if (invalidated.fence > durable_fence) durable_fence = invalidated.fence;
    if (!StoreFence(&invalidated, durable_fence, &failure)) {
      ReleaseSession(&invalidated);
      return ThrowFailure(env, failure.code, failure.message);
    }
    ReleaseSession(&invalidated);
  }
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

napi_value Probe(napi_env env, napi_callback_info) {
  napi_value result;
  napi_create_object(env, &result);
  napi_value boolean;
  napi_get_boolean(env, true, &boolean);
  napi_set_named_property(env, result, "available", boolean);
  napi_value version;
  napi_create_uint32(env, 1, &version);
  napi_set_named_property(env, result, "apiVersion", version);
#if defined(__APPLE__)
  napi_set_named_property(env, result, "platform", MakeString(env, "darwin"));
#elif defined(__linux__)
  napi_set_named_property(env, result, "platform", MakeString(env, "linux"));
#else
  napi_set_named_property(env, result, "platform", MakeString(env, "unsupported"));
#endif
  napi_value capabilities;
  napi_create_object(env, &capabilities);
  for (const char* name : {"rootSession", "workspaceLock", "durableFence",
                           "synchronousInvalidation"}) {
    napi_set_named_property(env, capabilities, name, boolean);
  }
  napi_value false_value;
  napi_get_boolean(env, false, &false_value);
  napi_set_named_property(env, capabilities, "mutation", false_value);
  napi_set_named_property(env, result, "capabilities", capabilities);
  napi_value null_value;
  napi_get_null(env, &null_value);
  napi_set_named_property(env, result, "unavailableReason", null_value);
  return result;
}

void Cleanup(void*) {
  std::lock_guard<std::mutex> guard(state.mutex);
  for (auto& [id, session] : state.sessions) {
    (void)id;
    ReleaseSession(&session);
  }
  state.sessions.clear();
  state.active_by_workspace.clear();
  state.opening_workspaces.clear();
  state.closing_workspaces.clear();
}

napi_value Initialize(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"probe", nullptr, Probe, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"openSession", nullptr, OpenSession, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"invalidateWorkspace", nullptr, InvalidateWorkspace, nullptr, nullptr, nullptr, napi_default,
       nullptr},
      {"closeSession", nullptr, CloseSession, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  napi_add_env_cleanup_hook(env, Cleanup, nullptr);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)
