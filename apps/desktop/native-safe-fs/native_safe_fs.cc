#include <node_api.h>

#include <fcntl.h>
#include <dirent.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/xattr.h>
#if defined(__APPLE__)
#include <sys/stdio.h>
#elif defined(__linux__)
#include <linux/fs.h>
#include <sys/syscall.h>
#endif
#include <unistd.h>

#include <array>
#include <algorithm>
#include <cerrno>
#include <charconv>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>
#include <mutex>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>
#if defined(SPRINT_CODER_NATIVE_SAFE_FS_TESTING)
#include <chrono>
#include <condition_variable>
#endif

namespace {

struct NativeFailure {
  std::string code;
  std::string message;
};

struct Session {
  std::string id;
  std::string root_id;
  std::string workspace_key;
  std::string workspace_path;
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

#if defined(SPRINT_CODER_NATIVE_SAFE_FS_TESTING)
struct TestControlState {
  std::mutex mutex;
  std::condition_variable changed;
  std::string token;
  std::string point;
  pid_t owner_pid = 0;
  int injected_errno = 0;
  uint32_t hit_count = 0;
  bool armed = false;
  bool reached = false;
  bool released = false;
};

TestControlState test_control;

bool IsAllowedTestPoint(const std::string& point) {
  static const std::unordered_set<std::string> allowed = {
      "effect.after_pre_observe",      "effect.after_parent_verify",
      "effect.before_authority_lock",  "effect.before_kernel_call",
      "effect.after_kernel_call",      "effect.before_fsync.source",
      "effect.before_fsync.destination", "effect.before_fsync.auxiliary",
      "effect.after_fsync",            "effect.before_complete",
      "cleanup.after_pre_observe",     "cleanup.after_parent_verify",
      "cleanup.before_authority_lock", "cleanup.before_unlink",
      "cleanup.after_unlink",          "cleanup.before_parent_fsync",
      "cleanup.after_parent_fsync",    "cleanup.before_complete",
  };
  return allowed.contains(point);
}

bool HitTestControl(const char* point, int* injected_errno = nullptr) {
  std::unique_lock<std::mutex> guard(test_control.mutex);
  if (!test_control.armed || test_control.owner_pid != getpid() ||
      test_control.point != point)
    return false;
  test_control.reached = true;
  ++test_control.hit_count;
  test_control.changed.notify_all();
  const bool released = test_control.changed.wait_for(
      guard, std::chrono::seconds(5), [] { return test_control.released; });
  const int planned_errno = released ? test_control.injected_errno : ETIMEDOUT;
  test_control.armed = false;
  test_control.released = false;
  if (injected_errno != nullptr) *injected_errno = planned_errno;
  return planned_errno != 0;
}
#else
bool HitTestControl(const char*, int* = nullptr) { return false; }
#endif

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

bool ReadUint32(napi_env env, napi_value object, const char* name, uint32_t* output) {
  napi_value value;
  if (napi_get_named_property(env, object, name, &value) != napi_ok) return false;
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_number) return false;
  double parsed = 0;
  if (napi_get_value_double(env, value, &parsed) != napi_ok || !std::isfinite(parsed) ||
      std::floor(parsed) != parsed || parsed < 0 ||
      parsed > static_cast<double>(std::numeric_limits<uint32_t>::max()))
    return false;
  *output = static_cast<uint32_t>(parsed);
  return true;
}

bool ValidSegment(const std::string& value) {
  return !value.empty() && value != "." && value != ".." && value.size() <= 255 &&
         value.find('/') == std::string::npos && value.find('\\') == std::string::npos &&
         value.find(':') == std::string::npos && value.find('\0') == std::string::npos;
}

bool ReadSegments(napi_env env, napi_value object, const char* name, bool nullable,
                  bool allow_empty,
                  std::vector<std::string>* output, bool* is_null = nullptr) {
  napi_value value;
  if (napi_get_named_property(env, object, name, &value) != napi_ok) return false;
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok) return false;
  if (nullable && type == napi_null) {
    if (is_null != nullptr) *is_null = true;
    return true;
  }
  bool is_array = false;
  if (napi_is_array(env, value, &is_array) != napi_ok || !is_array) return false;
  uint32_t length = 0;
  if (napi_get_array_length(env, value, &length) != napi_ok || length > 128) return false;
  if (!allow_empty && length == 0) return false;
  if (is_null != nullptr) *is_null = false;
  output->reserve(length);
  for (uint32_t index = 0; index < length; ++index) {
    napi_value element;
    if (napi_get_element(env, value, index, &element) != napi_ok) return false;
    napi_value holder;
    if (napi_create_object(env, &holder) != napi_ok ||
        napi_set_named_property(env, holder, "segment", element) != napi_ok)
      return false;
    std::string segment;
    if (!ReadString(env, holder, "segment", &segment) || !ValidSegment(segment)) return false;
    output->push_back(std::move(segment));
  }
  return true;
}

class Sha256 {
 public:
  Sha256() { Reset(); }

  void Update(const unsigned char* data, size_t length) {
    for (size_t index = 0; index < length; ++index) {
      block_[block_length_++] = data[index];
      if (block_length_ == block_.size()) {
        Transform();
        bit_length_ += 512;
        block_length_ = 0;
      }
    }
  }

  std::array<unsigned char, 32> Final() {
    const uint64_t total_bits = bit_length_ + static_cast<uint64_t>(block_length_) * 8;
    block_[block_length_++] = 0x80;
    if (block_length_ > 56) {
      while (block_length_ < 64) block_[block_length_++] = 0;
      Transform();
      block_length_ = 0;
    }
    while (block_length_ < 56) block_[block_length_++] = 0;
    for (int shift = 56; shift >= 0; shift -= 8)
      block_[block_length_++] = static_cast<unsigned char>((total_bits >> shift) & 0xff);
    Transform();
    std::array<unsigned char, 32> digest{};
    for (size_t index = 0; index < state_.size(); ++index) {
      digest[index * 4] = static_cast<unsigned char>((state_[index] >> 24) & 0xff);
      digest[index * 4 + 1] = static_cast<unsigned char>((state_[index] >> 16) & 0xff);
      digest[index * 4 + 2] = static_cast<unsigned char>((state_[index] >> 8) & 0xff);
      digest[index * 4 + 3] = static_cast<unsigned char>(state_[index] & 0xff);
    }
    return digest;
  }

 private:
  static uint32_t RotateRight(uint32_t value, uint32_t amount) {
    return (value >> amount) | (value << (32 - amount));
  }

  void Reset() {
    state_ = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
              0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
    block_.fill(0);
    block_length_ = 0;
    bit_length_ = 0;
  }

  void Transform() {
    static constexpr std::array<uint32_t, 64> constants = {
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
        0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
        0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
        0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
        0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
        0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
        0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
        0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};
    std::array<uint32_t, 64> words{};
    for (size_t index = 0; index < 16; ++index) {
      const size_t offset = index * 4;
      words[index] = (static_cast<uint32_t>(block_[offset]) << 24) |
                     (static_cast<uint32_t>(block_[offset + 1]) << 16) |
                     (static_cast<uint32_t>(block_[offset + 2]) << 8) |
                     static_cast<uint32_t>(block_[offset + 3]);
    }
    for (size_t index = 16; index < 64; ++index) {
      const uint32_t s0 = RotateRight(words[index - 15], 7) ^
                          RotateRight(words[index - 15], 18) ^ (words[index - 15] >> 3);
      const uint32_t s1 = RotateRight(words[index - 2], 17) ^
                          RotateRight(words[index - 2], 19) ^ (words[index - 2] >> 10);
      words[index] = words[index - 16] + s0 + words[index - 7] + s1;
    }
    uint32_t a = state_[0], b = state_[1], c = state_[2], d = state_[3];
    uint32_t e = state_[4], f = state_[5], g = state_[6], h = state_[7];
    for (size_t index = 0; index < 64; ++index) {
      const uint32_t s1 = RotateRight(e, 6) ^ RotateRight(e, 11) ^ RotateRight(e, 25);
      const uint32_t choice = (e & f) ^ ((~e) & g);
      const uint32_t temp1 = h + s1 + choice + constants[index] + words[index];
      const uint32_t s0 = RotateRight(a, 2) ^ RotateRight(a, 13) ^ RotateRight(a, 22);
      const uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
      const uint32_t temp2 = s0 + majority;
      h = g;
      g = f;
      f = e;
      e = d + temp1;
      d = c;
      c = b;
      b = a;
      a = temp1 + temp2;
    }
    state_[0] += a;
    state_[1] += b;
    state_[2] += c;
    state_[3] += d;
    state_[4] += e;
    state_[5] += f;
    state_[6] += g;
    state_[7] += h;
  }

  std::array<uint32_t, 8> state_{};
  std::array<unsigned char, 64> block_{};
  size_t block_length_ = 0;
  uint64_t bit_length_ = 0;
};

std::string HexDigest(const std::array<unsigned char, 32>& bytes) {
  constexpr char digits[] = "0123456789abcdef";
  std::string result(64, '0');
  for (size_t index = 0; index < bytes.size(); ++index) {
    result[index * 2] = digits[bytes[index] >> 4];
    result[index * 2 + 1] = digits[bytes[index] & 0x0f];
  }
  return result;
}

std::string Sha256Bytes(const unsigned char* bytes, size_t length) {
  Sha256 hash;
  hash.Update(bytes, length);
  return HexDigest(hash.Final());
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

#if defined(SPRINT_CODER_NATIVE_SAFE_FS_TESTING)
bool ReadTestToken(napi_env env, napi_value value, std::string* token) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) return false;
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok || length != 64)
    return false;
  std::array<char, 65> buffer{};
  if (napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(), &length) != napi_ok)
    return false;
  token->assign(buffer.data(), length);
  return IsLowerHex(*token, 64);
}

bool AuthorizedTestToken(const std::string& token) {
  if (test_control.owner_pid != getpid() || token.size() != test_control.token.size())
    return false;
  unsigned char difference = 0;
  for (size_t index = 0; index < token.size(); ++index)
    difference |= static_cast<unsigned char>(token[index] ^ test_control.token[index]);
  return difference == 0;
}

napi_value ConfigureTestControl(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  std::string token;
  if (argc != 1 || !ReadTestToken(env, argv[0], &token))
    return ThrowFailure(env, "INVALID_INPUT", "Invalid NativeSafeFs test token");
  std::lock_guard<std::mutex> guard(test_control.mutex);
  if (!test_control.token.empty() && test_control.owner_pid == getpid())
    return ThrowFailure(env, "INVALID_INPUT", "NativeSafeFs test control is already configured");
  test_control.token = std::move(token);
  test_control.owner_pid = getpid();
  test_control.point.clear();
  test_control.injected_errno = 0;
  test_control.hit_count = 0;
  test_control.armed = false;
  test_control.reached = false;
  test_control.released = false;
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

int TestErrno(const std::string& value) {
  if (value == "EIO") return EIO;
  if (value == "ENOSPC") return ENOSPC;
  if (value == "ENOSYS") return ENOSYS;
  if (value == "EOPNOTSUPP") return EOPNOTSUPP;
  if (value == "EXDEV") return EXDEV;
  if (value == "EINVAL") return EINVAL;
  return -1;
}

napi_value ArmTestControl(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  napi_valuetype type;
  std::string token;
  std::string point;
  std::string failure;
  if (argc != 1 || napi_typeof(env, argv[0], &type) != napi_ok || type != napi_object ||
      !ReadString(env, argv[0], "token", &token) ||
      !ReadString(env, argv[0], "point", &point) ||
      !ReadString(env, argv[0], "failure", &failure) || !IsAllowedTestPoint(point))
    return ThrowFailure(env, "INVALID_INPUT", "Invalid NativeSafeFs test plan");
  const int injected_errno = failure.empty() ? 0 : TestErrno(failure);
  if (injected_errno < 0)
    return ThrowFailure(env, "INVALID_INPUT", "Invalid NativeSafeFs injected failure");
  std::lock_guard<std::mutex> guard(test_control.mutex);
  if (!AuthorizedTestToken(token) || test_control.armed)
    return ThrowFailure(env, "INVALID_INPUT", "NativeSafeFs test control is unavailable");
  test_control.point = std::move(point);
  test_control.injected_errno = injected_errno;
  test_control.reached = false;
  test_control.released = false;
  test_control.armed = true;
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

napi_value TestControlState(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  std::string token;
  if (argc != 1 || !ReadTestToken(env, argv[0], &token))
    return ThrowFailure(env, "INVALID_INPUT", "Invalid NativeSafeFs test token");
  std::lock_guard<std::mutex> guard(test_control.mutex);
  if (!AuthorizedTestToken(token))
    return ThrowFailure(env, "INVALID_INPUT", "NativeSafeFs test control is unavailable");
  napi_value result;
  napi_create_object(env, &result);
  napi_value boolean;
  napi_get_boolean(env, test_control.armed, &boolean);
  napi_set_named_property(env, result, "armed", boolean);
  napi_get_boolean(env, test_control.reached, &boolean);
  napi_set_named_property(env, result, "reached", boolean);
  napi_value hits;
  napi_create_uint32(env, test_control.hit_count, &hits);
  napi_set_named_property(env, result, "hitCount", hits);
  napi_set_named_property(env, result, "point", MakeString(env, test_control.point));
  return result;
}

napi_value ReleaseTestControl(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  std::string token;
  if (argc != 1 || !ReadTestToken(env, argv[0], &token))
    return ThrowFailure(env, "INVALID_INPUT", "Invalid NativeSafeFs test token");
  std::lock_guard<std::mutex> guard(test_control.mutex);
  if (!AuthorizedTestToken(token) || !test_control.armed || !test_control.reached)
    return ThrowFailure(env, "INVALID_INPUT", "NativeSafeFs test barrier was not reached");
  test_control.released = true;
  test_control.changed.notify_all();
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}
#endif

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

bool VerifyDirectoryNamespace(const std::string& path, int pinned_fd, NativeFailure* failure,
                              const char* unsafe_code = "UNSAFE_LOCK") {
  int current_fd = OpenDirectoryChain(path, failure, unsafe_code);
  if (current_fd < 0) return false;
  struct stat pinned_stat {};
  struct stat current_stat {};
  const bool matches = fstat(pinned_fd, &pinned_stat) == 0 &&
                       fstat(current_fd, &current_stat) == 0 &&
                       pinned_stat.st_dev == current_stat.st_dev &&
                       pinned_stat.st_ino == current_stat.st_ino;
  CloseFd(&current_fd);
  if (!matches) {
    *failure = {unsafe_code, "NativeSafeFs pinned directory namespace changed"};
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
    napi_set_named_property(env, result, "rootId", MakeString(env, context->session.root_id));
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
  if (!ReadString(env, argv[0], "rootId", &context->session.root_id) ||
      !ReadString(env, argv[0], "workspacePath", &context->workspace_path) ||
      !ReadString(env, argv[0], "lockDirectoryPath", &context->lock_directory_path) ||
      !ReadString(env, argv[0], "workspaceKey", &context->session.workspace_key) ||
      !ReadString(env, argv[0], "rootDev", &context->session.root_dev) ||
      !ReadString(env, argv[0], "rootIno", &context->session.root_ino) ||
      !ReadString(env, argv[0], "fence", &fence_string) ||
      context->session.root_id.empty() || context->session.root_id.size() > 200 ||
      !IsLowerHex(context->session.workspace_key, 64) ||
      !ParsePositiveDecimal(fence_string, &context->session.fence)) {
    delete context;
    return ThrowFailure(env, "INVALID_INPUT", "Invalid NativeSafeFs open input");
  }
  context->session.workspace_path = context->workspace_path;
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

constexpr off_t kMaximumMutationFileBytes = 1024 * 1024;

struct RevisionObservation {
  bool present = false;
  std::string identity_digest;
  std::string content_hash;
  uint32_t size = 0;
  uint32_t mode = 0;
};

bool StableStatMatches(const struct stat& before, const struct stat& after) {
  if (before.st_dev != after.st_dev || before.st_ino != after.st_ino ||
      before.st_mode != after.st_mode || before.st_nlink != after.st_nlink ||
      before.st_size != after.st_size)
    return false;
#if defined(__APPLE__)
  return before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec &&
         before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec &&
         before.st_ctimespec.tv_sec == after.st_ctimespec.tv_sec &&
         before.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec;
#else
  return before.st_mtim.tv_sec == after.st_mtim.tv_sec &&
         before.st_mtim.tv_nsec == after.st_mtim.tv_nsec &&
         before.st_ctim.tv_sec == after.st_ctim.tv_sec &&
         before.st_ctim.tv_nsec == after.st_ctim.tv_nsec;
#endif
}

std::string FileIdentityDigest(const struct stat& file_stat) {
  const std::string facts =
      "[\"native-file-identity-v1\",\"" +
      std::to_string(static_cast<uint64_t>(file_stat.st_dev)) + "\",\"" +
      std::to_string(static_cast<uint64_t>(file_stat.st_ino)) + "\"," +
      std::to_string(static_cast<uint32_t>(file_stat.st_mode)) + "," +
      std::to_string(static_cast<uint64_t>(file_stat.st_nlink)) + ",\"file\"]";
  return Sha256Bytes(reinterpret_cast<const unsigned char*>(facts.data()), facts.size());
}

std::string DirectoryIdentityDigest(const struct stat& directory_stat) {
  const std::string facts =
      "[\"native-directory-identity-v1\",\"" +
      std::to_string(static_cast<uint64_t>(directory_stat.st_dev)) + "\",\"" +
      std::to_string(static_cast<uint64_t>(directory_stat.st_ino)) + "\"," +
      std::to_string(static_cast<uint32_t>(directory_stat.st_mode)) + ",\"directory\"]";
  return Sha256Bytes(reinterpret_cast<const unsigned char*>(facts.data()), facts.size());
}

bool WriteDirectoryOwnershipToken(int directory_fd, const std::string& token) {
#if defined(__APPLE__)
  return fsetxattr(directory_fd, "com.sprint-coder.mkdir-owner", token.data(), token.size(), 0, 0) ==
         0;
#elif defined(__linux__)
  return fsetxattr(directory_fd, "user.sprint-coder.mkdir-owner", token.data(), token.size(), 0) == 0;
#else
  errno = ENOTSUP;
  return false;
#endif
}

bool ReadDirectoryOwnershipToken(int directory_fd, std::string* token) {
  std::array<char, 64> bytes {};
#if defined(__APPLE__)
  const ssize_t count =
      fgetxattr(directory_fd, "com.sprint-coder.mkdir-owner", bytes.data(), bytes.size(), 0, 0);
#elif defined(__linux__)
  const ssize_t count =
      fgetxattr(directory_fd, "user.sprint-coder.mkdir-owner", bytes.data(), bytes.size());
#else
  const ssize_t count = -1;
  errno = ENOTSUP;
#endif
  if (count != static_cast<ssize_t>(bytes.size())) return false;
  *token = std::string(bytes.data(), bytes.size());
  return IsLowerHex(*token, 64);
}

std::string OwnedDirectoryIdentityDigest(const struct stat& directory_stat,
                                         const std::string& ownership_token) {
  const std::string facts = "[\"native-owned-directory-identity-v1\",\"" +
                            DirectoryIdentityDigest(directory_stat) + "\",\"" + ownership_token +
                            "\"]";
  return Sha256Bytes(reinterpret_cast<const unsigned char*>(facts.data()), facts.size());
}

bool ObserveOpenFile(int fd, const struct stat& namespace_stat, RevisionObservation* observation,
                     NativeFailure* failure) {
  struct stat before {};
  if (fstat(fd, &before) != 0) {
    *failure = {"NATIVE_FAILURE", ErrnoMessage("stat observed file")};
    return false;
  }
  if (!S_ISREG(namespace_stat.st_mode) || !S_ISREG(before.st_mode) ||
      namespace_stat.st_dev != before.st_dev || namespace_stat.st_ino != before.st_ino ||
      namespace_stat.st_mode != before.st_mode || namespace_stat.st_nlink != before.st_nlink ||
      before.st_nlink != 1 || before.st_size < 0 || before.st_size > kMaximumMutationFileBytes) {
    *failure = {"UNSAFE_PATH", "NativeSafeFs only observes unique regular files"};
    return false;
  }
  std::vector<unsigned char> bytes(static_cast<size_t>(before.st_size));
  size_t offset = 0;
  while (offset < bytes.size()) {
    const ssize_t count = pread(fd, bytes.data() + offset, bytes.size() - offset,
                                static_cast<off_t>(offset));
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) {
      *failure = {"NATIVE_FAILURE", ErrnoMessage("read observed file")};
      return false;
    }
    offset += static_cast<size_t>(count);
  }
  struct stat after {};
  if (fstat(fd, &after) != 0) {
    *failure = {"NATIVE_FAILURE", ErrnoMessage("restat observed file")};
    return false;
  }
  if (!StableStatMatches(before, after)) {
    *failure = {"UNSAFE_PATH", "NativeSafeFs observed a concurrent file change"};
    return false;
  }
  observation->present = true;
  observation->identity_digest = FileIdentityDigest(after);
  observation->content_hash = Sha256Bytes(bytes.data(), bytes.size());
  observation->size = static_cast<uint32_t>(bytes.size());
  observation->mode = static_cast<uint32_t>(after.st_mode);
  return true;
}

int OpenRelativeParent(int root_fd, const std::vector<std::string>& segments,
                       NativeFailure* failure) {
  if (segments.empty()) {
    *failure = {"INVALID_INPUT", "NativeSafeFs endpoint requires a leaf"};
    return -1;
  }
  int current = dup(root_fd);
  if (current < 0) {
    *failure = {"NATIVE_FAILURE", ErrnoMessage("duplicate workspace root")};
    return -1;
  }
  for (size_t index = 0; index + 1 < segments.size(); ++index) {
    int next = openat(current, segments[index].c_str(),
                      O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (next < 0) {
      const int saved_errno = errno;
      CloseFd(&current);
      errno = saved_errno;
      *failure = {"UNSAFE_PATH", ErrnoMessage("open mutation parent")};
      return -1;
    }
    CloseFd(&current);
    current = next;
  }
  return current;
}

bool VerifyRelativeParentNamespace(int root_fd, const std::vector<std::string>& segments,
                                   int pinned_parent_fd, NativeFailure* failure) {
  int current_fd = OpenRelativeParent(root_fd, segments, failure);
  if (current_fd < 0) return false;
  struct stat pinned {};
  struct stat current {};
  const bool matches = fstat(pinned_parent_fd, &pinned) == 0 && fstat(current_fd, &current) == 0 &&
                       pinned.st_dev == current.st_dev && pinned.st_ino == current.st_ino;
  CloseFd(&current_fd);
  if (!matches) {
    *failure = {"UNSAFE_PATH", "NativeSafeFs mutation parent namespace changed"};
    return false;
  }
  return true;
}

struct PinnedEndpoint {
  std::vector<std::string> segments;
  bool present = false;
  int fd = -1;
  struct stat namespace_stat {};
};

void ClosePinnedEndpoint(PinnedEndpoint* endpoint) { CloseFd(&endpoint->fd); }

bool PinEndpoint(int root_fd, const std::vector<std::string>& segments,
                 PinnedEndpoint* endpoint, NativeFailure* failure) {
  endpoint->segments = segments;
  int parent_fd = OpenRelativeParent(root_fd, segments, failure);
  if (parent_fd < 0) return false;
  const std::string& leaf = segments.back();
  if (fstatat(parent_fd, leaf.c_str(), &endpoint->namespace_stat, AT_SYMLINK_NOFOLLOW) != 0) {
    const int saved_errno = errno;
    CloseFd(&parent_fd);
    if (saved_errno == ENOENT) {
      endpoint->present = false;
      return true;
    }
    errno = saved_errno;
    *failure = {"UNSAFE_PATH", ErrnoMessage("stat mutation endpoint")};
    return false;
  }
  if (!S_ISREG(endpoint->namespace_stat.st_mode) || endpoint->namespace_stat.st_nlink != 1) {
    CloseFd(&parent_fd);
    *failure = {"UNSAFE_PATH", "NativeSafeFs endpoint is not a unique regular file"};
    return false;
  }
  endpoint->fd =
      openat(parent_fd, leaf.c_str(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
  const int saved_errno = errno;
  CloseFd(&parent_fd);
  if (endpoint->fd < 0) {
    errno = saved_errno;
    *failure = {"UNSAFE_PATH", ErrnoMessage("open mutation endpoint")};
    return false;
  }
  struct stat opened {};
  if (fstat(endpoint->fd, &opened) != 0 || !S_ISREG(opened.st_mode) || opened.st_nlink != 1 ||
      opened.st_dev != endpoint->namespace_stat.st_dev ||
      opened.st_ino != endpoint->namespace_stat.st_ino ||
      opened.st_mode != endpoint->namespace_stat.st_mode ||
      opened.st_nlink != endpoint->namespace_stat.st_nlink) {
    *failure = {"UNSAFE_PATH", "NativeSafeFs endpoint changed while it was pinned"};
    return false;
  }
  endpoint->present = true;
  return true;
}

bool ObservePinnedEndpoint(const PinnedEndpoint& endpoint, RevisionObservation* observation,
                           NativeFailure* failure) {
  if (!endpoint.present) {
    observation->present = false;
    return true;
  }
  return ObserveOpenFile(endpoint.fd, endpoint.namespace_stat, observation, failure);
}

bool RevalidatePinnedEndpoint(int root_fd, const PinnedEndpoint& endpoint,
                              NativeFailure* failure) {
  int parent_fd = OpenRelativeParent(root_fd, endpoint.segments, failure);
  if (parent_fd < 0) return false;
  struct stat current {};
  const int result =
      fstatat(parent_fd, endpoint.segments.back().c_str(), &current, AT_SYMLINK_NOFOLLOW);
  const int saved_errno = errno;
  CloseFd(&parent_fd);
  if (!endpoint.present) {
    if (result != 0 && saved_errno == ENOENT) return true;
    *failure = {"UNSAFE_PATH", "NativeSafeFs absent endpoint changed during observation"};
    return false;
  }
  if (result != 0 || !S_ISREG(current.st_mode) || current.st_nlink != 1 ||
      current.st_dev != endpoint.namespace_stat.st_dev ||
      current.st_ino != endpoint.namespace_stat.st_ino ||
      current.st_mode != endpoint.namespace_stat.st_mode ||
      current.st_nlink != endpoint.namespace_stat.st_nlink) {
    *failure = {"UNSAFE_PATH", "NativeSafeFs endpoint namespace changed during observation"};
    return false;
  }
  return true;
}

napi_value MakeRevisionObservation(napi_env env, const RevisionObservation& observation) {
  napi_value result;
  napi_create_object(env, &result);
  if (!observation.present) {
    napi_set_named_property(env, result, "state", MakeString(env, "absent"));
    return result;
  }
  napi_set_named_property(env, result, "state", MakeString(env, "present"));
  napi_set_named_property(env, result, "identityDigest",
                          MakeString(env, observation.identity_digest));
  napi_set_named_property(env, result, "contentHash", MakeString(env, observation.content_hash));
  napi_value size;
  napi_create_uint32(env, observation.size, &size);
  napi_set_named_property(env, result, "size", size);
  napi_value mode;
  napi_create_uint32(env, observation.mode, &mode);
  napi_set_named_property(env, result, "mode", mode);
  napi_value nlink;
  napi_create_uint32(env, 1, &nlink);
  napi_set_named_property(env, result, "nlink", nlink);
  return result;
}

bool ReadJournalBinding(napi_env env, napi_value input, std::string* session_id,
                        NativeFailure* failure) {
  std::string intent_id;
  std::string intent_digest;
  std::string record_digest;
  uint32_t revision = 0;
  if (!ReadString(env, input, "sessionId", session_id) ||
      !ReadString(env, input, "intentId", &intent_id) ||
      !ReadString(env, input, "intentDigest", &intent_digest) ||
      !ReadString(env, input, "recordDigest", &record_digest) ||
      !ReadUint32(env, input, "revision", &revision) || !IsLowerHex(*session_id, 32) ||
      intent_id.empty() || intent_id.size() > 200 || !IsLowerHex(intent_digest, 64) ||
      !IsLowerHex(record_digest, 64)) {
    *failure = {"INVALID_INPUT", "Invalid NativeSafeFs journal binding"};
    return false;
  }
  return true;
}

bool CaptureSessionRoot(const std::string& session_id, int* root_fd,
                        std::string* workspace_key, std::string* workspace_path,
                        uint64_t* invalidation_version,
                        NativeFailure* failure) {
  std::lock_guard<std::mutex> guard(state.mutex);
  auto found = state.sessions.find(session_id);
  if (found == state.sessions.end()) {
    *failure = {"STALE_SESSION", "NativeSafeFs session is stale"};
    return false;
  }
  *root_fd = dup(found->second.root_fd);
  if (*root_fd < 0) {
    *failure = {"NATIVE_FAILURE", ErrnoMessage("duplicate mutation session root")};
    return false;
  }
  *workspace_key = found->second.workspace_key;
  *workspace_path = found->second.workspace_path;
  *invalidation_version = state.invalidation_versions[*workspace_key];
  return true;
}

struct ObserveWork {
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  std::string session_id;
  std::string workspace_key;
  std::string workspace_path;
  uint64_t invalidation_version = 0;
  int root_fd = -1;
  std::vector<std::string> source;
  std::vector<std::string> destination;
  std::vector<std::string> auxiliary;
  bool has_destination = false;
  bool has_auxiliary = false;
  RevisionObservation source_observation;
  RevisionObservation destination_observation;
  RevisionObservation auxiliary_observation;
  NativeFailure failure;
  bool success = false;
};

bool ObserveSnapshot(int root_fd, const std::string& workspace_path,
                     const std::vector<std::string>& source_segments,
                     const std::vector<std::string>* destination_segments,
                     const std::vector<std::string>* auxiliary_segments,
                     RevisionObservation* source_observation,
                     RevisionObservation* destination_observation,
                     RevisionObservation* auxiliary_observation, NativeFailure* failure) {
  PinnedEndpoint source;
  PinnedEndpoint destination;
  PinnedEndpoint auxiliary;
  bool success = false;
  do {
    if (!VerifyDirectoryNamespace(workspace_path, root_fd, failure, "UNSAFE_PATH"))
      break;
    if (!PinEndpoint(root_fd, source_segments, &source, failure)) break;
    if (destination_segments != nullptr &&
        !PinEndpoint(root_fd, *destination_segments, &destination, failure))
      break;
    if (auxiliary_segments != nullptr &&
        !PinEndpoint(root_fd, *auxiliary_segments, &auxiliary, failure))
      break;
    if (!ObservePinnedEndpoint(source, source_observation, failure)) break;
    if (destination_segments != nullptr &&
        !ObservePinnedEndpoint(destination, destination_observation, failure))
      break;
    if (auxiliary_segments != nullptr &&
        !ObservePinnedEndpoint(auxiliary, auxiliary_observation, failure))
      break;
    if (!RevalidatePinnedEndpoint(root_fd, source, failure)) break;
    if (destination_segments != nullptr &&
        !RevalidatePinnedEndpoint(root_fd, destination, failure))
      break;
    if (auxiliary_segments != nullptr && !RevalidatePinnedEndpoint(root_fd, auxiliary, failure))
      break;
    if (!VerifyDirectoryNamespace(workspace_path, root_fd, failure, "UNSAFE_PATH"))
      break;
    success = true;
  } while (false);
  ClosePinnedEndpoint(&source);
  ClosePinnedEndpoint(&destination);
  ClosePinnedEndpoint(&auxiliary);
  return success;
}

void ExecuteObserve(napi_env, void* data) {
  auto* context = static_cast<ObserveWork*>(data);
  context->success = ObserveSnapshot(
      context->root_fd, context->workspace_path, context->source,
      context->has_destination ? &context->destination : nullptr,
      context->has_auxiliary ? &context->auxiliary : nullptr, &context->source_observation,
      &context->destination_observation, &context->auxiliary_observation, &context->failure);
}

void CompleteObserve(napi_env env, napi_status status, void* data) {
  auto* context = static_cast<ObserveWork*>(data);
  CloseFd(&context->root_fd);
  if (status != napi_ok || !context->success) {
    if (context->failure.code.empty())
      context->failure = {"NATIVE_FAILURE", "NativeSafeFs observation failed"};
    napi_reject_deferred(env, context->deferred, MakeError(env, context->failure));
  } else {
    napi_value result;
    napi_create_object(env, &result);
    napi_set_named_property(env, result, "source",
                            MakeRevisionObservation(env, context->source_observation));
    napi_set_named_property(
        env, result, "destination",
        MakeRevisionObservation(env, context->has_destination
                                         ? context->destination_observation
                                         : RevisionObservation{}));
    napi_set_named_property(
        env, result, "auxiliary",
        MakeRevisionObservation(env, context->has_auxiliary ? context->auxiliary_observation
                                                            : RevisionObservation{}));
    napi_resolve_deferred(env, context->deferred, result);
  }
  napi_delete_async_work(env, context->work);
  delete context;
}

napi_value ObserveIntent(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  napi_valuetype type;
  if (argc != 1 || napi_typeof(env, argv[0], &type) != napi_ok || type != napi_object)
    return ThrowFailure(env, "INVALID_INPUT", "NativeSafeFs observation input must be an object");
  auto* context = new ObserveWork();
  bool destination_null = false;
  bool auxiliary_null = false;
  if (!ReadJournalBinding(env, argv[0], &context->session_id, &context->failure) ||
      !ReadSegments(env, argv[0], "sourceSegments", false, false, &context->source) ||
      !ReadSegments(env, argv[0], "destinationSegments", true, false, &context->destination,
                    &destination_null) ||
      !ReadSegments(env, argv[0], "auxiliarySegments", true, false, &context->auxiliary,
                    &auxiliary_null)) {
    NativeFailure failure = context->failure.code.empty()
                                ? NativeFailure{"INVALID_INPUT", "Invalid observation paths"}
                                : context->failure;
    delete context;
    return ThrowFailure(env, failure.code, failure.message);
  }
  context->has_destination = !destination_null;
  context->has_auxiliary = !auxiliary_null;
  if (!CaptureSessionRoot(context->session_id, &context->root_fd, &context->workspace_key,
                          &context->workspace_path, &context->invalidation_version,
                          &context->failure)) {
    NativeFailure failure = context->failure;
    delete context;
    return ThrowFailure(env, failure.code, failure.message);
  }
  napi_value promise;
  napi_create_promise(env, &context->deferred, &promise);
  napi_value resource_name = MakeString(env, "NativeSafeFs.observeIntent");
  const napi_status create_status = napi_create_async_work(
      env, nullptr, resource_name, ExecuteObserve, CompleteObserve, context, &context->work);
  const napi_status queue_status =
      create_status == napi_ok ? napi_queue_async_work(env, context->work) : create_status;
  if (create_status != napi_ok || queue_status != napi_ok) {
    if (create_status == napi_ok) napi_delete_async_work(env, context->work);
    CloseFd(&context->root_fd);
    delete context;
    return ThrowFailure(env, "NATIVE_FAILURE", "Failed to queue NativeSafeFs observation");
  }
  return promise;
}

struct StageWork {
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  std::string session_id;
  std::string workspace_key;
  std::string workspace_path;
  uint64_t invalidation_version = 0;
  int root_fd = -1;
  std::vector<std::string> path;
  std::vector<unsigned char> bytes;
  std::string expected_hash;
  uint32_t expected_size = 0;
  uint32_t expected_mode = 0;
  RevisionObservation observation;
  NativeFailure failure;
  bool success = false;
};

void RemoveCreatedIfSame(int parent_fd, const std::string& leaf, const struct stat& created) {
  struct stat current {};
  if (fstatat(parent_fd, leaf.c_str(), &current, AT_SYMLINK_NOFOLLOW) == 0 &&
      current.st_dev == created.st_dev && current.st_ino == created.st_ino)
    unlinkat(parent_fd, leaf.c_str(), 0);
}

void ExecuteStage(napi_env, void* data) {
  auto* context = static_cast<StageWork*>(data);
  if (context->bytes.size() != context->expected_size ||
      Sha256Bytes(context->bytes.data(), context->bytes.size()) != context->expected_hash) {
    context->failure = {"INVALID_INPUT", "Staged bytes do not match the sealed artifact"};
    return;
  }
  if (!VerifyDirectoryNamespace(context->workspace_path, context->root_fd, &context->failure,
                                "UNSAFE_PATH"))
    return;
  int parent_fd = OpenRelativeParent(context->root_fd, context->path, &context->failure);
  if (parent_fd < 0) return;
  if (!VerifyRelativeParentNamespace(context->root_fd, context->path, parent_fd,
                                     &context->failure)) {
    CloseFd(&parent_fd);
    return;
  }
  const std::string& leaf = context->path.back();
  int file_fd = -1;
  {
    std::lock_guard<std::mutex> guard(state.mutex);
    const auto session = state.sessions.find(context->session_id);
    if (session == state.sessions.end() ||
        session->second.workspace_key != context->workspace_key ||
        state.invalidation_versions[context->workspace_key] != context->invalidation_version) {
      CloseFd(&parent_fd);
      context->failure = {"STALE_SESSION", "NativeSafeFs session was invalidated before staging"};
      return;
    }
    file_fd = openat(parent_fd, leaf.c_str(),
                     O_RDWR | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
  }
  if (file_fd < 0) {
    const int saved_errno = errno;
    CloseFd(&parent_fd);
    errno = saved_errno;
    context->failure = {errno == EEXIST ? "UNSAFE_PATH" : "NATIVE_FAILURE",
                        ErrnoMessage("create staged artifact")};
    return;
  }
  struct stat created {};
  bool file_synced = false;
  if (fstat(file_fd, &created) != 0 || !S_ISREG(created.st_mode) || created.st_nlink != 1) {
    context->failure = {"UNSAFE_PATH", "Staged artifact is not a unique regular file"};
  } else {
    size_t offset = 0;
    while (offset < context->bytes.size()) {
      const ssize_t written = pwrite(file_fd, context->bytes.data() + offset,
                                     context->bytes.size() - offset,
                                     static_cast<off_t>(offset));
      if (written < 0 && errno == EINTR) continue;
      if (written <= 0) {
        context->failure = {"NATIVE_FAILURE", ErrnoMessage("write staged artifact")};
        break;
      }
      offset += static_cast<size_t>(written);
    }
    if (context->failure.code.empty() &&
        fchmod(file_fd, static_cast<mode_t>(context->expected_mode & 07777)) != 0)
      context->failure = {"NATIVE_FAILURE", ErrnoMessage("chmod staged artifact")};
    if (context->failure.code.empty()) {
      if (fsync(file_fd) != 0)
        context->failure = {"NATIVE_FAILURE", ErrnoMessage("fsync staged artifact")};
      else
        file_synced = true;
    }
    struct stat namespace_stat {};
    if (context->failure.code.empty() &&
        (fstatat(parent_fd, leaf.c_str(), &namespace_stat, AT_SYMLINK_NOFOLLOW) != 0 ||
         !ObserveOpenFile(file_fd, namespace_stat, &context->observation, &context->failure))) {
      if (context->failure.code.empty())
        context->failure = {"UNSAFE_PATH", "Staged artifact namespace changed"};
    }
    if (context->failure.code.empty() &&
        (context->observation.content_hash != context->expected_hash ||
         context->observation.size != context->expected_size ||
         context->observation.mode != context->expected_mode))
      context->failure = {"UNSAFE_PATH", "Staged artifact observation does not match intent"};
    if (context->failure.code.empty() &&
        (!VerifyRelativeParentNamespace(context->root_fd, context->path, parent_fd,
                                        &context->failure) ||
         !VerifyDirectoryNamespace(context->workspace_path, context->root_fd,
                                   &context->failure, "UNSAFE_PATH"))) {
      if (context->failure.code.empty())
        context->failure = {"UNSAFE_PATH", "Staged artifact ancestry changed"};
    }
    if (context->failure.code.empty() && fsync(parent_fd) != 0)
      context->failure = {"NATIVE_FAILURE", ErrnoMessage("fsync staged artifact parent")};
  }
  if (!context->failure.code.empty() && !file_synced) {
    RemoveCreatedIfSame(parent_fd, leaf, created);
    fsync(parent_fd);
  }
  CloseFd(&file_fd);
  CloseFd(&parent_fd);
  context->success = context->failure.code.empty();
}

void CompleteStage(napi_env env, napi_status status, void* data) {
  auto* context = static_cast<StageWork*>(data);
  CloseFd(&context->root_fd);
  if (status != napi_ok || !context->success) {
    if (context->failure.code.empty())
      context->failure = {"NATIVE_FAILURE", "NativeSafeFs staging failed"};
    napi_reject_deferred(env, context->deferred, MakeError(env, context->failure));
  } else {
    napi_resolve_deferred(env, context->deferred,
                          MakeRevisionObservation(env, context->observation));
  }
  napi_delete_async_work(env, context->work);
  delete context;
}

napi_value StageIntentArtifact(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  napi_valuetype input_type;
  bool is_buffer = false;
  if (argc != 2 || napi_typeof(env, argv[0], &input_type) != napi_ok ||
      input_type != napi_object || napi_is_buffer(env, argv[1], &is_buffer) != napi_ok ||
      !is_buffer)
    return ThrowFailure(env, "INVALID_INPUT", "NativeSafeFs staging input is invalid");
  auto* context = new StageWork();
  std::vector<std::string> parent;
  std::string leaf;
  void* buffer_data = nullptr;
  size_t buffer_length = 0;
  if (!ReadJournalBinding(env, argv[0], &context->session_id, &context->failure) ||
      !ReadSegments(env, argv[0], "parentSegments", false, true, &parent) ||
      !ReadString(env, argv[0], "leafName", &leaf) || !ValidSegment(leaf) ||
      !leaf.starts_with(".sprint-coder-temp-") || leaf.size() != 51 ||
      !IsLowerHex(leaf.substr(19), 32) ||
      !ReadString(env, argv[0], "expectedContentHash", &context->expected_hash) ||
      !ReadUint32(env, argv[0], "expectedSize", &context->expected_size) ||
      !ReadUint32(env, argv[0], "expectedMode", &context->expected_mode) ||
      !IsLowerHex(context->expected_hash, 64) ||
      context->expected_size > static_cast<uint32_t>(kMaximumMutationFileBytes) ||
      (context->expected_mode & S_IFMT) != S_IFREG ||
      napi_get_buffer_info(env, argv[1], &buffer_data, &buffer_length) != napi_ok ||
      buffer_length > static_cast<size_t>(kMaximumMutationFileBytes)) {
    NativeFailure failure = context->failure.code.empty()
                                ? NativeFailure{"INVALID_INPUT", "Invalid staged artifact input"}
                                : context->failure;
    delete context;
    return ThrowFailure(env, failure.code, failure.message);
  }
  context->path = std::move(parent);
  context->path.push_back(std::move(leaf));
  if (buffer_length > 0) {
    const auto* begin = static_cast<const unsigned char*>(buffer_data);
    context->bytes.assign(begin, begin + buffer_length);
  }
  if (!CaptureSessionRoot(context->session_id, &context->root_fd, &context->workspace_key,
                          &context->workspace_path, &context->invalidation_version,
                          &context->failure)) {
    NativeFailure failure = context->failure;
    delete context;
    return ThrowFailure(env, failure.code, failure.message);
  }
  napi_value promise;
  napi_create_promise(env, &context->deferred, &promise);
  napi_value resource_name = MakeString(env, "NativeSafeFs.stageIntentArtifact");
  const napi_status create_status = napi_create_async_work(
      env, nullptr, resource_name, ExecuteStage, CompleteStage, context, &context->work);
  const napi_status queue_status =
      create_status == napi_ok ? napi_queue_async_work(env, context->work) : create_status;
  if (create_status != napi_ok || queue_status != napi_ok) {
    if (create_status == napi_ok) napi_delete_async_work(env, context->work);
    CloseFd(&context->root_fd);
    delete context;
    return ThrowFailure(env, "NATIVE_FAILURE", "Failed to queue NativeSafeFs staging");
  }
  return promise;
}

bool ReadExpectation(napi_env env, napi_value input, const char* name,
                     RevisionObservation* expectation) {
  napi_value value;
  if (napi_get_named_property(env, input, name, &value) != napi_ok) return false;
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_object) return false;
  std::string state_value;
  if (!ReadString(env, value, "state", &state_value)) return false;
  if (state_value == "absent") {
    expectation->present = false;
    return true;
  }
  uint32_t nlink = 0;
  if (state_value != "present" ||
      !ReadString(env, value, "identityDigest", &expectation->identity_digest) ||
      !ReadString(env, value, "contentHash", &expectation->content_hash) ||
      !ReadUint32(env, value, "size", &expectation->size) ||
      !ReadUint32(env, value, "mode", &expectation->mode) ||
      !ReadUint32(env, value, "nlink", &nlink) ||
      !IsLowerHex(expectation->identity_digest, 64) ||
      !IsLowerHex(expectation->content_hash, 64) ||
      expectation->size > static_cast<uint32_t>(kMaximumMutationFileBytes) ||
      (expectation->mode & S_IFMT) != S_IFREG || nlink != 1)
    return false;
  expectation->present = true;
  return true;
}

bool ObservationMatches(const RevisionObservation& actual,
                        const RevisionObservation& expected) {
  if (actual.present != expected.present) return false;
  return !actual.present ||
         (actual.identity_digest == expected.identity_digest &&
          actual.content_hash == expected.content_hash && actual.size == expected.size &&
          actual.mode == expected.mode);
}

bool IsAuxiliaryLeaf(const std::string& leaf, const char* prefix) {
  const std::string expected_prefix(prefix);
  return leaf.size() == expected_prefix.size() + 32 && leaf.starts_with(expected_prefix) &&
         IsLowerHex(leaf.substr(expected_prefix.size()), 32);
}

int AtomicMoveNoReplace(int source_parent_fd, const char* source_leaf,
                        int destination_parent_fd, const char* destination_leaf) {
#if defined(__APPLE__)
  return renameatx_np(source_parent_fd, source_leaf, destination_parent_fd, destination_leaf,
                      RENAME_EXCL);
#elif defined(__linux__)
  return static_cast<int>(syscall(SYS_renameat2, source_parent_fd, source_leaf,
                                  destination_parent_fd, destination_leaf, RENAME_NOREPLACE));
#else
  errno = ENOTSUP;
  return -1;
#endif
}

int AtomicExchange(int first_parent_fd, const char* first_leaf, int second_parent_fd,
                   const char* second_leaf) {
#if defined(__APPLE__)
  return renameatx_np(first_parent_fd, first_leaf, second_parent_fd, second_leaf, RENAME_SWAP);
#elif defined(__linux__)
  return static_cast<int>(syscall(SYS_renameat2, first_parent_fd, first_leaf, second_parent_fd,
                                  second_leaf, RENAME_EXCHANGE));
#else
  errno = ENOTSUP;
  return -1;
#endif
}

NativeFailure AtomicMutationFailure(const char* operation) {
  if (errno == EEXIST || errno == ENOTEMPTY || errno == ENOENT)
    return {"UNSAFE_PATH", ErrnoMessage(operation)};
  if (errno == ENOTSUP || errno == EOPNOTSUPP || errno == ENOSYS || errno == EXDEV ||
      errno == EINVAL)
    return {"UNSUPPORTED_PLATFORM", ErrnoMessage(operation)};
  return {"NATIVE_FAILURE", ErrnoMessage(operation)};
}

napi_value ExchangeFiles(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1) {
    return ThrowFailure(env, "INVALID_INPUT", "exchangeFiles requires a path pair");
  }
  std::string first;
  std::string second;
  if (!ReadString(env, argv[0], "first", &first) ||
      !ReadString(env, argv[0], "second", &second) || first.empty() || second.empty() ||
      first[0] != '/' || second[0] != '/')
    return ThrowFailure(env, "INVALID_INPUT", "Invalid exchangeFiles path pair");
  if (AtomicExchange(AT_FDCWD, first.c_str(), AT_FDCWD, second.c_str()) != 0) {
    if (errno == EINVAL || errno == ENOSYS || errno == EOPNOTSUPP || errno == EXDEV)
      return ThrowFailure(env, "UNSUPPORTED", ErrnoMessage("exchange files"));
    const NativeFailure failure = AtomicMutationFailure("exchange files");
    return ThrowFailure(env, failure.code, failure.message);
  }
  napi_value result;
  napi_get_boolean(env, true, &result);
  return result;
}

bool SameDirectoryIdentity(int first_fd, int second_fd) {
  if (first_fd < 0 || second_fd < 0) return false;
  struct stat first {};
  struct stat second {};
  return fstat(first_fd, &first) == 0 && fstat(second_fd, &second) == 0 &&
         first.st_dev == second.st_dev && first.st_ino == second.st_ino;
}

bool FsyncMutationParent(int fd, const char* role, NativeFailure* failure) {
  if (fd < 0) return true;
  const std::string point = std::string("effect.before_fsync.") + role;
  int injected_errno = 0;
  if (HitTestControl(point.c_str(), &injected_errno)) {
    errno = injected_errno;
    if (failure->code.empty())
      *failure = {"NATIVE_FAILURE", ErrnoMessage("fsync mutation parent")};
    return false;
  }
  if (fsync(fd) == 0) return true;
  if (failure->code.empty())
    *failure = {"NATIVE_FAILURE", ErrnoMessage("fsync mutation parent")};
  return false;
}

struct EffectWork {
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  std::string session_id;
  std::string workspace_key;
  std::string workspace_path;
  uint64_t invalidation_version = 0;
  int root_fd = -1;
  std::string kind;
  std::vector<std::string> source;
  std::vector<std::string> destination;
  std::vector<std::string> auxiliary;
  bool has_destination = false;
  bool has_auxiliary = false;
  RevisionObservation expected_source;
  RevisionObservation expected_destination;
  RevisionObservation expected_auxiliary;
  RevisionObservation source_observation;
  RevisionObservation destination_observation;
  RevisionObservation auxiliary_observation;
  NativeFailure failure;
  bool success = false;
};

bool EffectShapeIsValid(const EffectWork& context) {
  const bool source_present = context.expected_source.present;
  const bool destination_absent = !context.expected_destination.present;
  if (context.kind == "add")
    return !source_present && destination_absent && !context.has_destination &&
           context.has_auxiliary && context.expected_auxiliary.present &&
           IsAuxiliaryLeaf(context.auxiliary.back(), ".sprint-coder-temp-");
  if (context.kind == "update")
    return source_present && destination_absent && !context.has_destination &&
           context.has_auxiliary && context.expected_auxiliary.present &&
           IsAuxiliaryLeaf(context.auxiliary.back(), ".sprint-coder-temp-");
  if (context.kind == "delete")
    return source_present && destination_absent && !context.has_destination &&
           context.has_auxiliary && !context.expected_auxiliary.present &&
           IsAuxiliaryLeaf(context.auxiliary.back(), ".sprint-coder-tomb-");
  if (context.kind == "rename")
    return source_present && destination_absent && context.has_destination &&
           !context.has_auxiliary && !context.expected_auxiliary.present;
  return false;
}

bool EffectObservationIsValid(const EffectWork& context) {
  RevisionObservation absent;
  if (context.kind == "add")
    return ObservationMatches(context.source_observation, context.expected_auxiliary) &&
           ObservationMatches(context.destination_observation, absent) &&
           ObservationMatches(context.auxiliary_observation, absent);
  if (context.kind == "update")
    return ObservationMatches(context.source_observation, context.expected_auxiliary) &&
           ObservationMatches(context.destination_observation, absent) &&
           ObservationMatches(context.auxiliary_observation, context.expected_source);
  if (context.kind == "delete")
    return ObservationMatches(context.source_observation, absent) &&
           ObservationMatches(context.destination_observation, absent) &&
           ObservationMatches(context.auxiliary_observation, context.expected_source);
  return ObservationMatches(context.source_observation, absent) &&
         ObservationMatches(context.destination_observation, context.expected_source) &&
         ObservationMatches(context.auxiliary_observation, absent);
}

void ExecuteEffect(napi_env, void* data) {
  auto* context = static_cast<EffectWork*>(data);
  RevisionObservation before_source;
  RevisionObservation before_destination;
  RevisionObservation before_auxiliary;
  if (!ObserveSnapshot(
          context->root_fd, context->workspace_path, context->source,
          context->has_destination ? &context->destination : nullptr,
          context->has_auxiliary ? &context->auxiliary : nullptr, &before_source,
          &before_destination, &before_auxiliary, &context->failure))
    return;
  if (!ObservationMatches(before_source, context->expected_source) ||
      !ObservationMatches(before_destination, context->expected_destination) ||
      !ObservationMatches(before_auxiliary, context->expected_auxiliary)) {
    context->failure = {"UNSAFE_PATH", "NativeSafeFs effect precondition changed"};
    return;
  }
  HitTestControl("effect.after_pre_observe");

  int source_parent_fd = OpenRelativeParent(context->root_fd, context->source, &context->failure);
  if (source_parent_fd < 0) return;
  int destination_parent_fd = -1;
  int auxiliary_parent_fd = -1;
  if (context->has_destination)
    destination_parent_fd =
        OpenRelativeParent(context->root_fd, context->destination, &context->failure);
  if (context->has_auxiliary)
    auxiliary_parent_fd =
        OpenRelativeParent(context->root_fd, context->auxiliary, &context->failure);
  if ((context->has_destination && destination_parent_fd < 0) ||
      (context->has_auxiliary && auxiliary_parent_fd < 0)) {
    CloseFd(&source_parent_fd);
    CloseFd(&destination_parent_fd);
    CloseFd(&auxiliary_parent_fd);
    return;
  }
  const bool parents_valid =
      VerifyRelativeParentNamespace(context->root_fd, context->source, source_parent_fd,
                                    &context->failure) &&
      (!context->has_destination ||
       VerifyRelativeParentNamespace(context->root_fd, context->destination,
                                     destination_parent_fd, &context->failure)) &&
      (!context->has_auxiliary ||
       VerifyRelativeParentNamespace(context->root_fd, context->auxiliary, auxiliary_parent_fd,
                                     &context->failure)) &&
      VerifyDirectoryNamespace(context->workspace_path, context->root_fd, &context->failure,
                               "UNSAFE_PATH");
  if (!parents_valid) {
    CloseFd(&source_parent_fd);
    CloseFd(&destination_parent_fd);
    CloseFd(&auxiliary_parent_fd);
    return;
  }
  HitTestControl("effect.after_parent_verify");
  HitTestControl("effect.before_authority_lock");
  int injected_kernel_errno = 0;
  HitTestControl("effect.before_kernel_call", &injected_kernel_errno);
  RevisionObservation final_source;
  RevisionObservation final_destination;
  RevisionObservation final_auxiliary;
  if (!ObserveSnapshot(
          context->root_fd, context->workspace_path, context->source,
          context->has_destination ? &context->destination : nullptr,
          context->has_auxiliary ? &context->auxiliary : nullptr, &final_source,
          &final_destination, &final_auxiliary, &context->failure) ||
      !ObservationMatches(final_source, context->expected_source) ||
      !ObservationMatches(final_destination, context->expected_destination) ||
      !ObservationMatches(final_auxiliary, context->expected_auxiliary) ||
      !VerifyRelativeParentNamespace(context->root_fd, context->source, source_parent_fd,
                                     &context->failure) ||
      (context->has_destination &&
       !VerifyRelativeParentNamespace(context->root_fd, context->destination,
                                      destination_parent_fd, &context->failure)) ||
      (context->has_auxiliary &&
       !VerifyRelativeParentNamespace(context->root_fd, context->auxiliary, auxiliary_parent_fd,
                                      &context->failure))) {
    if (context->failure.code.empty())
      context->failure = {"UNSAFE_PATH", "NativeSafeFs effect changed before kernel call"};
    CloseFd(&source_parent_fd);
    CloseFd(&destination_parent_fd);
    CloseFd(&auxiliary_parent_fd);
    return;
  }

  int mutation_result = -1;
  {
    std::lock_guard<std::mutex> guard(state.mutex);
    const auto session = state.sessions.find(context->session_id);
    if (session == state.sessions.end() ||
        session->second.workspace_key != context->workspace_key ||
        state.invalidation_versions[context->workspace_key] != context->invalidation_version) {
      context->failure = {"STALE_SESSION", "NativeSafeFs session was invalidated before effect"};
    } else {
      if (injected_kernel_errno != 0) {
        errno = injected_kernel_errno;
      } else if (context->kind == "add") {
        mutation_result = AtomicMoveNoReplace(
            auxiliary_parent_fd, context->auxiliary.back().c_str(), source_parent_fd,
            context->source.back().c_str());
      } else if (context->kind == "update") {
        mutation_result = AtomicExchange(source_parent_fd, context->source.back().c_str(),
                                         auxiliary_parent_fd,
                                         context->auxiliary.back().c_str());
      } else if (context->kind == "delete") {
        mutation_result = AtomicMoveNoReplace(
            source_parent_fd, context->source.back().c_str(), auxiliary_parent_fd,
            context->auxiliary.back().c_str());
      } else {
        mutation_result = AtomicMoveNoReplace(
            source_parent_fd, context->source.back().c_str(), destination_parent_fd,
            context->destination.back().c_str());
      }
    }
  }
  if (!context->failure.code.empty()) {
    CloseFd(&source_parent_fd);
    CloseFd(&destination_parent_fd);
    CloseFd(&auxiliary_parent_fd);
    return;
  }
  if (mutation_result != 0) {
    context->failure = AtomicMutationFailure("apply atomic mutation");
    CloseFd(&source_parent_fd);
    CloseFd(&destination_parent_fd);
    CloseFd(&auxiliary_parent_fd);
    return;
  }
  HitTestControl("effect.after_kernel_call");

  FsyncMutationParent(source_parent_fd, "source", &context->failure);
  if (destination_parent_fd >= 0 &&
      !SameDirectoryIdentity(destination_parent_fd, source_parent_fd))
    FsyncMutationParent(destination_parent_fd, "destination", &context->failure);
  if (auxiliary_parent_fd >= 0 &&
      !SameDirectoryIdentity(auxiliary_parent_fd, source_parent_fd) &&
      !SameDirectoryIdentity(auxiliary_parent_fd, destination_parent_fd))
    FsyncMutationParent(auxiliary_parent_fd, "auxiliary", &context->failure);
  HitTestControl("effect.after_fsync");
  CloseFd(&source_parent_fd);
  CloseFd(&destination_parent_fd);
  CloseFd(&auxiliary_parent_fd);
  if (!context->failure.code.empty()) return;

  if (!ObserveSnapshot(
          context->root_fd, context->workspace_path, context->source,
          context->has_destination ? &context->destination : nullptr,
          context->has_auxiliary ? &context->auxiliary : nullptr, &context->source_observation,
          &context->destination_observation, &context->auxiliary_observation,
          &context->failure))
    return;
  if (!EffectObservationIsValid(*context)) {
    context->failure = {"NATIVE_FAILURE", "NativeSafeFs effect topology is indeterminate"};
    return;
  }
  HitTestControl("effect.before_complete");
  context->success = true;
}

void CompleteEffect(napi_env env, napi_status status, void* data) {
  auto* context = static_cast<EffectWork*>(data);
  CloseFd(&context->root_fd);
  if (status != napi_ok || !context->success) {
    if (context->failure.code.empty())
      context->failure = {"NATIVE_FAILURE", "NativeSafeFs effect failed"};
    napi_reject_deferred(env, context->deferred, MakeError(env, context->failure));
  } else {
    napi_value result;
    napi_create_object(env, &result);
    napi_set_named_property(env, result, "source",
                            MakeRevisionObservation(env, context->source_observation));
    napi_set_named_property(env, result, "destination",
                            MakeRevisionObservation(env, context->destination_observation));
    napi_set_named_property(env, result, "auxiliary",
                            MakeRevisionObservation(env, context->auxiliary_observation));
    napi_resolve_deferred(env, context->deferred, result);
  }
  napi_delete_async_work(env, context->work);
  delete context;
}

napi_value ApplyIntentEffect(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  napi_valuetype type;
  if (argc != 1 || napi_typeof(env, argv[0], &type) != napi_ok || type != napi_object)
    return ThrowFailure(env, "INVALID_INPUT", "NativeSafeFs effect input must be an object");
  auto* context = new EffectWork();
  bool destination_null = false;
  bool auxiliary_null = false;
  if (!ReadJournalBinding(env, argv[0], &context->session_id, &context->failure) ||
      !ReadString(env, argv[0], "kind", &context->kind) ||
      !ReadSegments(env, argv[0], "sourceSegments", false, false, &context->source) ||
      !ReadSegments(env, argv[0], "destinationSegments", true, false, &context->destination,
                    &destination_null) ||
      !ReadSegments(env, argv[0], "auxiliarySegments", true, false, &context->auxiliary,
                    &auxiliary_null) ||
      !ReadExpectation(env, argv[0], "expectedSource", &context->expected_source) ||
      !ReadExpectation(env, argv[0], "expectedDestination", &context->expected_destination) ||
      !ReadExpectation(env, argv[0], "expectedAuxiliary", &context->expected_auxiliary)) {
    NativeFailure failure = context->failure.code.empty()
                                ? NativeFailure{"INVALID_INPUT", "Invalid NativeSafeFs effect"}
                                : context->failure;
    delete context;
    return ThrowFailure(env, failure.code, failure.message);
  }
  context->has_destination = !destination_null;
  context->has_auxiliary = !auxiliary_null;
  if (!EffectShapeIsValid(*context)) {
    delete context;
    return ThrowFailure(env, "INVALID_INPUT", "Invalid NativeSafeFs effect shape");
  }
  if (!CaptureSessionRoot(context->session_id, &context->root_fd, &context->workspace_key,
                          &context->workspace_path, &context->invalidation_version,
                          &context->failure)) {
    NativeFailure failure = context->failure;
    delete context;
    return ThrowFailure(env, failure.code, failure.message);
  }
  napi_value promise;
  napi_create_promise(env, &context->deferred, &promise);
  napi_value resource_name = MakeString(env, "NativeSafeFs.applyIntentEffect");
  const napi_status create_status = napi_create_async_work(
      env, nullptr, resource_name, ExecuteEffect, CompleteEffect, context, &context->work);
  const napi_status queue_status =
      create_status == napi_ok ? napi_queue_async_work(env, context->work) : create_status;
  if (create_status != napi_ok || queue_status != napi_ok) {
    if (create_status == napi_ok) napi_delete_async_work(env, context->work);
    CloseFd(&context->root_fd);
    delete context;
    return ThrowFailure(env, "NATIVE_FAILURE", "Failed to queue NativeSafeFs effect");
  }
  return promise;
}

struct CleanupWork {
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  std::string session_id;
  std::string workspace_key;
  std::string workspace_path;
  uint64_t invalidation_version = 0;
  int root_fd = -1;
  std::vector<std::string> auxiliary;
  RevisionObservation expected_auxiliary;
  NativeFailure failure;
  bool success = false;
};

void ExecuteCleanup(napi_env, void* data) {
  auto* context = static_cast<CleanupWork*>(data);
  RevisionObservation current;
  RevisionObservation ignored_destination;
  RevisionObservation ignored_auxiliary;
  if (!ObserveSnapshot(context->root_fd, context->workspace_path, context->auxiliary, nullptr,
                       nullptr, &current, &ignored_destination, &ignored_auxiliary,
                       &context->failure))
    return;
  if (!current.present) {
    context->success = true;
    return;
  }
  if (!ObservationMatches(current, context->expected_auxiliary)) {
    context->failure = {"UNSAFE_PATH", "NativeSafeFs cleanup identity changed"};
    return;
  }
  HitTestControl("cleanup.after_pre_observe");
  int parent_fd =
      OpenRelativeParent(context->root_fd, context->auxiliary, &context->failure);
  if (parent_fd < 0) return;
  if (!VerifyRelativeParentNamespace(context->root_fd, context->auxiliary, parent_fd,
                                     &context->failure) ||
      !VerifyDirectoryNamespace(context->workspace_path, context->root_fd, &context->failure,
                                "UNSAFE_PATH")) {
    CloseFd(&parent_fd);
    return;
  }
  HitTestControl("cleanup.after_parent_verify");
  HitTestControl("cleanup.before_authority_lock");
  HitTestControl("cleanup.before_unlink");
  RevisionObservation final_observation;
  if (!ObserveSnapshot(context->root_fd, context->workspace_path, context->auxiliary, nullptr,
                       nullptr, &final_observation, &ignored_destination,
                       &ignored_auxiliary, &context->failure) ||
      !ObservationMatches(final_observation, context->expected_auxiliary) ||
      !VerifyRelativeParentNamespace(context->root_fd, context->auxiliary, parent_fd,
                                     &context->failure)) {
    if (context->failure.code.empty())
      context->failure = {"UNSAFE_PATH", "NativeSafeFs cleanup target changed before unlink"};
    CloseFd(&parent_fd);
    return;
  }
  int unlink_result = -1;
  {
    std::lock_guard<std::mutex> guard(state.mutex);
    const auto session = state.sessions.find(context->session_id);
    if (session == state.sessions.end() ||
        session->second.workspace_key != context->workspace_key ||
        state.invalidation_versions[context->workspace_key] != context->invalidation_version) {
      context->failure = {"STALE_SESSION", "NativeSafeFs session was invalidated before cleanup"};
    } else {
      struct stat namespace_stat {};
      if (fstatat(parent_fd, context->auxiliary.back().c_str(), &namespace_stat,
                  AT_SYMLINK_NOFOLLOW) != 0 || !S_ISREG(namespace_stat.st_mode) ||
          namespace_stat.st_nlink != 1 ||
          FileIdentityDigest(namespace_stat) != context->expected_auxiliary.identity_digest) {
        context->failure = {"UNSAFE_PATH", "NativeSafeFs cleanup target changed"};
      } else {
        unlink_result = unlinkat(parent_fd, context->auxiliary.back().c_str(), 0);
      }
    }
  }
  if (context->failure.code.empty() && unlink_result != 0)
    context->failure = {"NATIVE_FAILURE", ErrnoMessage("unlink mutation auxiliary")};
  if (context->failure.code.empty()) HitTestControl("cleanup.after_unlink");
  if (context->failure.code.empty()) {
    int injected_errno = 0;
    const bool injected =
        HitTestControl("cleanup.before_parent_fsync", &injected_errno);
    if (injected) errno = injected_errno;
    if (injected || fsync(parent_fd) != 0)
      context->failure = {"NATIVE_FAILURE", ErrnoMessage("fsync cleanup parent")};
  }
  HitTestControl("cleanup.after_parent_fsync");
  CloseFd(&parent_fd);
  if (!context->failure.code.empty()) return;
  RevisionObservation after;
  if (!ObserveSnapshot(context->root_fd, context->workspace_path, context->auxiliary, nullptr,
                       nullptr, &after, &ignored_destination, &ignored_auxiliary,
                       &context->failure))
    return;
  if (after.present) {
    context->failure = {"NATIVE_FAILURE", "NativeSafeFs cleanup did not become absent"};
    return;
  }
  HitTestControl("cleanup.before_complete");
  context->success = true;
}

void CompleteCleanup(napi_env env, napi_status status, void* data) {
  auto* context = static_cast<CleanupWork*>(data);
  CloseFd(&context->root_fd);
  if (status != napi_ok || !context->success) {
    if (context->failure.code.empty())
      context->failure = {"NATIVE_FAILURE", "NativeSafeFs cleanup failed"};
    napi_reject_deferred(env, context->deferred, MakeError(env, context->failure));
  } else {
    napi_resolve_deferred(env, context->deferred, MakeRevisionObservation(env, {}));
  }
  napi_delete_async_work(env, context->work);
  delete context;
}

napi_value CleanupIntentAuxiliary(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  napi_valuetype type;
  if (argc != 1 || napi_typeof(env, argv[0], &type) != napi_ok || type != napi_object)
    return ThrowFailure(env, "INVALID_INPUT", "NativeSafeFs cleanup input must be an object");
  auto* context = new CleanupWork();
  if (!ReadJournalBinding(env, argv[0], &context->session_id, &context->failure) ||
      !ReadSegments(env, argv[0], "auxiliarySegments", false, false, &context->auxiliary) ||
      !ReadExpectation(env, argv[0], "expectedAuxiliary", &context->expected_auxiliary) ||
      (!IsAuxiliaryLeaf(context->auxiliary.back(), ".sprint-coder-temp-") &&
       !IsAuxiliaryLeaf(context->auxiliary.back(), ".sprint-coder-tomb-"))) {
    NativeFailure failure = context->failure.code.empty()
                                ? NativeFailure{"INVALID_INPUT", "Invalid cleanup auxiliary"}
                                : context->failure;
    delete context;
    return ThrowFailure(env, failure.code, failure.message);
  }
  if (!CaptureSessionRoot(context->session_id, &context->root_fd, &context->workspace_key,
                          &context->workspace_path, &context->invalidation_version,
                          &context->failure)) {
    NativeFailure failure = context->failure;
    delete context;
    return ThrowFailure(env, failure.code, failure.message);
  }
  napi_value promise;
  napi_create_promise(env, &context->deferred, &promise);
  napi_value resource_name = MakeString(env, "NativeSafeFs.cleanupIntentAuxiliary");
  const napi_status create_status = napi_create_async_work(
      env, nullptr, resource_name, ExecuteCleanup, CompleteCleanup, context, &context->work);
  const napi_status queue_status =
      create_status == napi_ok ? napi_queue_async_work(env, context->work) : create_status;
  if (create_status != napi_ok || queue_status != napi_ok) {
    if (create_status == napi_ok) napi_delete_async_work(env, context->work);
    CloseFd(&context->root_fd);
    delete context;
    return ThrowFailure(env, "NATIVE_FAILURE", "Failed to queue NativeSafeFs cleanup");
  }
  return promise;
}

bool ReadDirectoryInput(napi_env env, napi_value value, std::string* session_id,
                        std::vector<std::string>* segments) {
  return ReadString(env, value, "sessionId", session_id) && IsLowerHex(*session_id, 32) &&
         ReadSegments(env, value, "pathSegments", false, false, segments);
}

bool ReadDirectoryOwnershipInput(napi_env env, napi_value value, std::string* session_id,
                                 std::vector<std::string>* segments, std::string* marker_leaf,
                                 std::string* token) {
  return ReadDirectoryInput(env, value, session_id, segments) &&
         ReadString(env, value, "markerLeafName", marker_leaf) &&
         ReadString(env, value, "ownershipToken", token) && IsLowerHex(*token, 64) &&
         *marker_leaf == ".sprint-coder-mkdir-" + token->substr(0, 32);
}

bool ReadMarkerToken(int directory_fd, const std::string& marker_leaf, std::string* token) {
  int marker_fd = openat(directory_fd, marker_leaf.c_str(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (marker_fd < 0) return false;
  struct stat marker_stat {};
  std::array<char, 64> bytes {};
  size_t offset = 0;
  while (offset < bytes.size()) {
    const ssize_t count = pread(marker_fd, bytes.data() + offset, bytes.size() - offset,
                                static_cast<off_t>(offset));
    if (count <= 0) break;
    offset += static_cast<size_t>(count);
  }
  const bool valid = fstat(marker_fd, &marker_stat) == 0 && S_ISREG(marker_stat.st_mode) &&
                     marker_stat.st_nlink == 1 && marker_stat.st_size == 64 && offset == 64;
  CloseFd(&marker_fd);
  if (!valid) return false;
  *token = std::string(bytes.data(), bytes.size());
  return true;
}

bool DirectoryContainsOnlyMarker(int directory_fd, const std::string& marker_leaf) {
  const int scan_fd = dup(directory_fd);
  if (scan_fd < 0) return false;
  DIR* directory = fdopendir(scan_fd);
  if (directory == nullptr) {
    close(scan_fd);
    return false;
  }
  bool found = false;
  bool safe = true;
  while (dirent* entry = readdir(directory)) {
    const std::string name(entry->d_name);
    if (name == "." || name == "..") continue;
    if (name != marker_leaf || found) {
      safe = false;
      break;
    }
    found = true;
  }
  closedir(directory);
  return safe && found;
}

bool DirectoryIsEmpty(int directory_fd) {
  const int scan_fd = dup(directory_fd);
  if (scan_fd < 0) return false;
  DIR* directory = fdopendir(scan_fd);
  if (directory == nullptr) {
    close(scan_fd);
    return false;
  }
  bool empty = true;
  while (dirent* entry = readdir(directory)) {
    const std::string name(entry->d_name);
    if (name != "." && name != "..") {
      empty = false;
      break;
    }
  }
  closedir(directory);
  return empty;
}

napi_value MakeDirectoryObservation(napi_env env, const struct stat* directory_stat,
                                    const std::string* ownership_token = nullptr) {
  napi_value result;
  napi_create_object(env, &result);
  if (directory_stat == nullptr) {
    napi_set_named_property(env, result, "state", MakeString(env, "absent"));
    return result;
  }
  napi_set_named_property(env, result, "state", MakeString(env, "present"));
  napi_set_named_property(env, result, "identityDigest",
                          MakeString(env, ownership_token == nullptr
                                              ? DirectoryIdentityDigest(*directory_stat)
                                              : OwnedDirectoryIdentityDigest(*directory_stat,
                                                                             *ownership_token)));
  return result;
}

napi_value ObserveDirectory(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  napi_valuetype type;
  std::string session_id;
  std::vector<std::string> segments;
  if (argc != 1 || napi_typeof(env, argv[0], &type) != napi_ok || type != napi_object ||
      !ReadDirectoryInput(env, argv[0], &session_id, &segments))
    return ThrowFailure(env, "INVALID_INPUT", "Invalid NativeSafeFs directory input");

  NativeFailure failure;
  int root_fd = -1;
  int parent_fd = -1;
  std::string workspace_key;
  std::string workspace_path;
  uint64_t invalidation_version = 0;
  if (!CaptureSessionRoot(session_id, &root_fd, &workspace_key, &workspace_path,
                          &invalidation_version, &failure))
    return ThrowFailure(env, failure.code, failure.message);
  if (!VerifyDirectoryNamespace(workspace_path, root_fd, &failure, "UNSAFE_PATH")) {
    CloseFd(&root_fd);
    return ThrowFailure(env, failure.code, failure.message);
  }
  parent_fd = OpenRelativeParent(root_fd, segments, &failure);
  if (parent_fd < 0) {
    CloseFd(&root_fd);
    return ThrowFailure(env, failure.code, failure.message);
  }
  struct stat observed {};
  std::string ownership_token;
  bool has_ownership_token = false;
  int result = -1;
  {
    std::lock_guard<std::mutex> guard(state.mutex);
    const auto session = state.sessions.find(session_id);
    if (session == state.sessions.end() || session->second.workspace_key != workspace_key ||
        state.invalidation_versions[workspace_key] != invalidation_version) {
      failure = {"STALE_SESSION", "NativeSafeFs session was invalidated before observation"};
    } else if (!VerifyRelativeParentNamespace(root_fd, segments, parent_fd, &failure) ||
               !VerifyDirectoryNamespace(workspace_path, root_fd, &failure, "UNSAFE_PATH")) {
      // Verification provides the failure.
    } else {
      result = fstatat(parent_fd, segments.back().c_str(), &observed, AT_SYMLINK_NOFOLLOW);
      const int saved_errno = errno;
      if (result == 0 && !S_ISDIR(observed.st_mode)) {
        failure = {"UNSAFE_PATH", "NativeSafeFs directory endpoint is not a directory"};
      } else if (result == 0) {
        int directory_fd = openat(parent_fd, segments.back().c_str(),
                                  O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        has_ownership_token =
            directory_fd >= 0 && ReadDirectoryOwnershipToken(directory_fd, &ownership_token);
        CloseFd(&directory_fd);
      } else if (result != 0 && saved_errno != ENOENT) {
        errno = saved_errno;
        failure = {"UNSAFE_PATH", ErrnoMessage("stat workspace directory")};
      }
    }
  }
  CloseFd(&parent_fd);
  CloseFd(&root_fd);
  if (!failure.code.empty()) return ThrowFailure(env, failure.code, failure.message);
  return MakeDirectoryObservation(env, result == 0 ? &observed : nullptr,
                                  has_ownership_token ? &ownership_token : nullptr);
}

napi_value CreateDirectory(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  napi_valuetype type;
  if (argc != 1 || napi_typeof(env, argv[0], &type) != napi_ok || type != napi_object)
    return ThrowFailure(env, "INVALID_INPUT", "NativeSafeFs create directory input must be an object");
  std::string session_id;
  std::string marker_leaf;
  std::string ownership_token;
  std::vector<std::string> segments;
  if (!ReadDirectoryOwnershipInput(env, argv[0], &session_id, &segments, &marker_leaf,
                                   &ownership_token))
    return ThrowFailure(env, "INVALID_INPUT", "Invalid NativeSafeFs directory input");

  NativeFailure failure;
  int root_fd = -1;
  int parent_fd = -1;
  std::string workspace_key;
  std::string workspace_path;
  uint64_t invalidation_version = 0;
  if (!CaptureSessionRoot(session_id, &root_fd, &workspace_key, &workspace_path,
                          &invalidation_version, &failure))
    return ThrowFailure(env, failure.code, failure.message);
  if (!VerifyDirectoryNamespace(workspace_path, root_fd, &failure, "UNSAFE_PATH")) {
    CloseFd(&root_fd);
    return ThrowFailure(env, failure.code, failure.message);
  }
  parent_fd = OpenRelativeParent(root_fd, segments, &failure);
  if (parent_fd < 0) {
    CloseFd(&root_fd);
    return ThrowFailure(env, failure.code, failure.message);
  }

  int result = -1;
  struct stat created {};
  const std::string staging_leaf = ".sprint-coder-mkdir-stage-" + ownership_token.substr(0, 32);
  bool published = false;
  {
    std::lock_guard<std::mutex> guard(state.mutex);
    const auto session = state.sessions.find(session_id);
    if (session == state.sessions.end() || session->second.workspace_key != workspace_key ||
        state.invalidation_versions[workspace_key] != invalidation_version) {
      failure = {"STALE_SESSION", "NativeSafeFs session was invalidated before mkdir"};
    } else if (!VerifyRelativeParentNamespace(root_fd, segments, parent_fd, &failure) ||
               !VerifyDirectoryNamespace(workspace_path, root_fd, &failure, "UNSAFE_PATH")) {
      // VerifyRelativeParentNamespace provides the failure.
    } else {
      struct stat existing {};
      if (fstatat(parent_fd, segments.back().c_str(), &existing, AT_SYMLINK_NOFOLLOW) == 0 ||
          errno != ENOENT) {
        failure = {"UNSAFE_PATH", "NativeSafeFs directory destination already exists"};
      } else {
        result = mkdirat(parent_fd, staging_leaf.c_str(), 0755);
        if (result != 0) {
          failure = {"NATIVE_FAILURE", ErrnoMessage("mkdir workspace directory")};
        } else {
          int directory_fd = openat(parent_fd, staging_leaf.c_str(),
                                    O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
          int marker_fd = directory_fd < 0
                              ? -1
                              : openat(directory_fd, marker_leaf.c_str(),
                                       O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
          ssize_t written = marker_fd < 0
                                ? -1
                                : write(marker_fd, ownership_token.data(), ownership_token.size());
          if (marker_fd < 0 || written != static_cast<ssize_t>(ownership_token.size()) ||
              !WriteDirectoryOwnershipToken(directory_fd, ownership_token) ||
              fstat(directory_fd, &created) != 0 ||
              fsync(marker_fd) != 0 || fsync(directory_fd) != 0) {
            failure = {"NATIVE_FAILURE", "NativeSafeFs mkdir ownership marker failed"};
          }
          CloseFd(&marker_fd);
          CloseFd(&directory_fd);
        }
        if (failure.code.empty()) {
          if (AtomicMoveNoReplace(parent_fd, staging_leaf.c_str(), parent_fd,
                                  segments.back().c_str()) != 0)
            failure = AtomicMutationFailure("publish workspace directory");
          else
            published = true;
        }
        if (failure.code.empty() &&
            (!VerifyRelativeParentNamespace(root_fd, segments, parent_fd, &failure) ||
             !VerifyDirectoryNamespace(workspace_path, root_fd, &failure, "UNSAFE_PATH"))) {
          if (AtomicMoveNoReplace(parent_fd, segments.back().c_str(), parent_fd,
                                  staging_leaf.c_str()) != 0)
            failure = {"NATIVE_FAILURE", "Failed to quarantine mkdir after namespace drift"};
          else
            published = false;
        }
        if (failure.code.empty() && fsync(parent_fd) != 0)
          failure = {"NATIVE_FAILURE", ErrnoMessage("fsync mkdir parent")};
        if (!failure.code.empty()) {
          if (published &&
              AtomicMoveNoReplace(parent_fd, segments.back().c_str(), parent_fd,
                                  staging_leaf.c_str()) == 0)
            published = false;
          int cleanup_fd = openat(parent_fd, staging_leaf.c_str(),
                                  O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
          std::string cleanup_token;
          if (cleanup_fd >= 0 && ReadDirectoryOwnershipToken(cleanup_fd, &cleanup_token) &&
              cleanup_token == ownership_token) {
            unlinkat(cleanup_fd, marker_leaf.c_str(), 0);
            CloseFd(&cleanup_fd);
            unlinkat(parent_fd, staging_leaf.c_str(), AT_REMOVEDIR);
          } else {
            CloseFd(&cleanup_fd);
          }
        }
      }
    }
  }
  CloseFd(&parent_fd);
  CloseFd(&root_fd);
  if (result != 0 || !failure.code.empty())
    return ThrowFailure(env, failure.code.empty() ? "NATIVE_FAILURE" : failure.code,
                        failure.message.empty() ? "NativeSafeFs mkdir failed" : failure.message);
  return MakeDirectoryObservation(env, &created, &ownership_token);
}

napi_value InspectDirectoryOwnership(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  std::string session_id, marker_leaf, expected_token;
  std::vector<std::string> segments;
  if (argc != 1 ||
      !ReadDirectoryOwnershipInput(env, argv[0], &session_id, &segments, &marker_leaf,
                                   &expected_token))
    return ThrowFailure(env, "INVALID_INPUT", "Invalid directory ownership input");
  NativeFailure failure;
  int root_fd = -1;
  std::string workspace_key, workspace_path;
  uint64_t invalidation_version = 0;
  if (!CaptureSessionRoot(session_id, &root_fd, &workspace_key, &workspace_path,
                          &invalidation_version, &failure))
    return ThrowFailure(env, failure.code, failure.message);
  if (!VerifyDirectoryNamespace(workspace_path, root_fd, &failure, "UNSAFE_PATH")) {
    CloseFd(&root_fd);
    return ThrowFailure(env, failure.code, failure.message);
  }
  int parent_fd = OpenRelativeParent(root_fd, segments, &failure);
  struct stat observed {};
  int result = -1;
  {
    std::lock_guard<std::mutex> guard(state.mutex);
    const auto session = state.sessions.find(session_id);
    if (session == state.sessions.end() || session->second.workspace_key != workspace_key ||
        state.invalidation_versions[workspace_key] != invalidation_version) {
      failure = {"STALE_SESSION", "NativeSafeFs session was invalidated before ownership check"};
    } else if (parent_fd < 0 ||
               !VerifyRelativeParentNamespace(root_fd, segments, parent_fd, &failure) ||
               !VerifyDirectoryNamespace(workspace_path, root_fd, &failure, "UNSAFE_PATH")) {
      if (failure.code.empty()) failure = {"UNSAFE_PATH", "Directory parent changed"};
    } else {
      result = fstatat(parent_fd, segments.back().c_str(), &observed, AT_SYMLINK_NOFOLLOW);
      if (result != 0 && errno == ENOENT) {
        // Absent is a valid pre-effect observation.
      } else if (result != 0 || !S_ISDIR(observed.st_mode)) {
        failure = {"UNSAFE_PATH", "Directory ownership endpoint is unsafe"};
      } else {
        int directory_fd = openat(parent_fd, segments.back().c_str(),
                                  O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        std::string token, attribute_token;
        if (directory_fd < 0 || !ReadMarkerToken(directory_fd, marker_leaf, &token) ||
            !ReadDirectoryOwnershipToken(directory_fd, &attribute_token) ||
            token != expected_token || attribute_token != expected_token) {
          failure = {"UNSAFE_PATH", "Directory ownership marker does not match"};
        }
        CloseFd(&directory_fd);
      }
    }
  }
  CloseFd(&parent_fd);
  CloseFd(&root_fd);
  if (!failure.code.empty()) return ThrowFailure(env, failure.code, failure.message);
  return MakeDirectoryObservation(env, result == 0 ? &observed : nullptr,
                                  result == 0 ? &expected_token : nullptr);
}

napi_value CleanupDirectoryOwnership(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  std::string session_id, marker_leaf, expected_token, expected_identity;
  std::vector<std::string> segments;
  if (argc != 1 ||
      !ReadDirectoryOwnershipInput(env, argv[0], &session_id, &segments, &marker_leaf,
                                   &expected_token) ||
      !ReadString(env, argv[0], "expectedIdentityDigest", &expected_identity) ||
      !IsLowerHex(expected_identity, 64))
    return ThrowFailure(env, "INVALID_INPUT", "Invalid directory ownership cleanup input");
  NativeFailure failure;
  int root_fd = -1;
  std::string workspace_key, workspace_path;
  uint64_t invalidation_version = 0;
  if (!CaptureSessionRoot(session_id, &root_fd, &workspace_key, &workspace_path,
                          &invalidation_version, &failure))
    return ThrowFailure(env, failure.code, failure.message);
  if (!VerifyDirectoryNamespace(workspace_path, root_fd, &failure, "UNSAFE_PATH")) {
    CloseFd(&root_fd);
    return ThrowFailure(env, failure.code, failure.message);
  }
  int parent_fd = OpenRelativeParent(root_fd, segments, &failure);
  {
    std::lock_guard<std::mutex> guard(state.mutex);
    const auto session = state.sessions.find(session_id);
    struct stat observed {};
    if (session == state.sessions.end() || session->second.workspace_key != workspace_key ||
        state.invalidation_versions[workspace_key] != invalidation_version) {
      failure = {"STALE_SESSION", "NativeSafeFs session was invalidated before marker cleanup"};
    } else if (parent_fd < 0 ||
               !VerifyRelativeParentNamespace(root_fd, segments, parent_fd, &failure) ||
               !VerifyDirectoryNamespace(workspace_path, root_fd, &failure, "UNSAFE_PATH") ||
               fstatat(parent_fd, segments.back().c_str(), &observed, AT_SYMLINK_NOFOLLOW) != 0 ||
               !S_ISDIR(observed.st_mode)) {
      if (failure.code.empty()) failure = {"UNSAFE_PATH", "Directory identity changed"};
    } else {
      int directory_fd = openat(parent_fd, segments.back().c_str(),
                                O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
      std::string token, attribute_token;
      const bool attribute_matches = directory_fd >= 0 &&
                                     ReadDirectoryOwnershipToken(directory_fd, &attribute_token) &&
                                     attribute_token == expected_token &&
                                     OwnedDirectoryIdentityDigest(observed, attribute_token) ==
                                         expected_identity;
      const bool marker_present = ReadMarkerToken(directory_fd, marker_leaf, &token);
      if (!attribute_matches ||
          (marker_present
               ? token != expected_token || !DirectoryContainsOnlyMarker(directory_fd, marker_leaf)
               : !DirectoryIsEmpty(directory_fd))) {
        failure = {"UNSAFE_PATH", "Directory marker cleanup refused non-owned contents"};
      } else if (marker_present &&
                 (unlinkat(directory_fd, marker_leaf.c_str(), 0) != 0 || fsync(directory_fd) != 0)) {
        failure = {"NATIVE_FAILURE", ErrnoMessage("cleanup mkdir ownership marker")};
      }
      CloseFd(&directory_fd);
    }
  }
  CloseFd(&parent_fd);
  CloseFd(&root_fd);
  if (!failure.code.empty()) return ThrowFailure(env, failure.code, failure.message);
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

napi_value RemoveDirectory(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  napi_valuetype type;
  std::string session_id;
  std::string expected_identity;
  std::vector<std::string> segments;
  if (argc != 1 || napi_typeof(env, argv[0], &type) != napi_ok || type != napi_object ||
      !ReadDirectoryInput(env, argv[0], &session_id, &segments) ||
      !ReadString(env, argv[0], "expectedIdentityDigest", &expected_identity) ||
      !IsLowerHex(expected_identity, 64))
    return ThrowFailure(env, "INVALID_INPUT", "Invalid NativeSafeFs remove directory input");
  NativeFailure failure;
  int root_fd = -1;
  int parent_fd = -1;
  std::string workspace_key;
  std::string workspace_path;
  uint64_t invalidation_version = 0;
  if (!CaptureSessionRoot(session_id, &root_fd, &workspace_key, &workspace_path,
                          &invalidation_version, &failure))
    return ThrowFailure(env, failure.code, failure.message);
  if (!VerifyDirectoryNamespace(workspace_path, root_fd, &failure, "UNSAFE_PATH")) {
    CloseFd(&root_fd);
    return ThrowFailure(env, failure.code, failure.message);
  }
  parent_fd = OpenRelativeParent(root_fd, segments, &failure);
  struct stat current {};
  const std::string quarantine_leaf = ".sprint-coder-rmdir-" + expected_identity.substr(0, 32);
  {
    std::lock_guard<std::mutex> guard(state.mutex);
    const auto session = state.sessions.find(session_id);
    if (session == state.sessions.end() || session->second.workspace_key != workspace_key ||
        state.invalidation_versions[workspace_key] != invalidation_version) {
      failure = {"STALE_SESSION", "NativeSafeFs session was invalidated before directory removal"};
    } else if (parent_fd < 0 ||
               !VerifyRelativeParentNamespace(root_fd, segments, parent_fd, &failure) ||
               !VerifyDirectoryNamespace(workspace_path, root_fd, &failure, "UNSAFE_PATH") ||
               fstatat(parent_fd, segments.back().c_str(), &current, AT_SYMLINK_NOFOLLOW) != 0 ||
               !S_ISDIR(current.st_mode)) {
      if (failure.code.empty())
        failure = {"UNSAFE_PATH", "NativeSafeFs directory identity changed before removal"};
    } else {
      int directory_fd = openat(parent_fd, segments.back().c_str(),
                                O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
      std::string ownership_token;
      const bool identity_matches = directory_fd >= 0 &&
                                    ReadDirectoryOwnershipToken(directory_fd, &ownership_token) &&
                                    OwnedDirectoryIdentityDigest(current, ownership_token) ==
                                        expected_identity;
      CloseFd(&directory_fd);
      if (!identity_matches)
        failure = {"UNSAFE_PATH", "NativeSafeFs directory ownership changed before removal"};
    }
    if (failure.code.empty() && AtomicMoveNoReplace(parent_fd, segments.back().c_str(), parent_fd,
                                   quarantine_leaf.c_str()) != 0) {
      failure = AtomicMutationFailure("quarantine workspace directory");
    } else if (failure.code.empty()) {
      struct stat quarantined {};
      int quarantined_fd = openat(parent_fd, quarantine_leaf.c_str(),
                                  O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
      std::string ownership_token;
      const bool quarantine_matches =
          quarantined_fd >= 0 && fstat(quarantined_fd, &quarantined) == 0 &&
          ReadDirectoryOwnershipToken(quarantined_fd, &ownership_token) &&
          OwnedDirectoryIdentityDigest(quarantined, ownership_token) == expected_identity;
      CloseFd(&quarantined_fd);
      if (!quarantine_matches) {
        if (AtomicMoveNoReplace(parent_fd, quarantine_leaf.c_str(), parent_fd,
                                segments.back().c_str()) != 0)
          failure = {"NATIVE_FAILURE", "Failed to restore substituted directory quarantine"};
        else
          failure = {"UNSAFE_PATH", "Directory identity changed during quarantine"};
      } else if (unlinkat(parent_fd, quarantine_leaf.c_str(), AT_REMOVEDIR) != 0) {
        const int saved_errno = errno;
        if (AtomicMoveNoReplace(parent_fd, quarantine_leaf.c_str(), parent_fd,
                                segments.back().c_str()) != 0)
          failure = {"NATIVE_FAILURE", "Failed to restore non-empty directory quarantine"};
        else {
          errno = saved_errno;
          failure = {"UNSAFE_PATH", ErrnoMessage("remove workspace directory")};
        }
      }
    }
    if (failure.code.empty() && fsync(parent_fd) != 0) {
      failure = {"NATIVE_FAILURE", ErrnoMessage("fsync removed directory parent")};
    }
  }
  CloseFd(&parent_fd);
  CloseFd(&root_fd);
  if (!failure.code.empty()) return ThrowFailure(env, failure.code, failure.message);
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
  napi_set_named_property(env, capabilities, "mutation", boolean);
  napi_set_named_property(env, result, "capabilities", capabilities);
  napi_value null_value;
  napi_get_null(env, &null_value);
  napi_set_named_property(env, result, "unavailableReason", null_value);
  return result;
}

void Cleanup(void*) {
#if defined(SPRINT_CODER_NATIVE_SAFE_FS_TESTING)
  {
    std::lock_guard<std::mutex> test_guard(test_control.mutex);
    test_control.released = true;
    test_control.armed = false;
    test_control.changed.notify_all();
  }
#endif
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
      {"observeIntent", nullptr, ObserveIntent, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"stageIntentArtifact", nullptr, StageIntentArtifact, nullptr, nullptr, nullptr, napi_default,
       nullptr},
      {"applyIntentEffect", nullptr, ApplyIntentEffect, nullptr, nullptr, nullptr, napi_default,
       nullptr},
      {"cleanupIntentAuxiliary", nullptr, CleanupIntentAuxiliary, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"observeDirectory", nullptr, ObserveDirectory, nullptr, nullptr, nullptr, napi_default,
       nullptr},
      {"createDirectory", nullptr, CreateDirectory, nullptr, nullptr, nullptr, napi_default,
       nullptr},
      {"inspectDirectoryOwnership", nullptr, InspectDirectoryOwnership, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"cleanupDirectoryOwnership", nullptr, CleanupDirectoryOwnership, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"removeDirectory", nullptr, RemoveDirectory, nullptr, nullptr, nullptr, napi_default,
       nullptr},
      {"closeSession", nullptr, CloseSession, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"exchangeFiles", nullptr, ExchangeFiles, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
#if defined(SPRINT_CODER_NATIVE_SAFE_FS_TESTING)
  napi_property_descriptor test_properties[] = {
      {"configureTestControl", nullptr, ConfigureTestControl, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"armTestControl", nullptr, ArmTestControl, nullptr, nullptr, nullptr, napi_default,
       nullptr},
      {"testControlState", nullptr, TestControlState, nullptr, nullptr, nullptr, napi_default,
       nullptr},
      {"releaseTestControl", nullptr, ReleaseTestControl, nullptr, nullptr, nullptr, napi_default,
       nullptr},
  };
  napi_define_properties(env, exports, sizeof(test_properties) / sizeof(test_properties[0]),
                         test_properties);
#endif
  napi_add_env_cleanup_hook(env, Cleanup, nullptr);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)
