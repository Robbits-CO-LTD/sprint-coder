#if !defined(_WIN32)
#error "The Computer Use Windows host must be compiled on Windows"
#endif

#if !defined(SPRINT_CODER_SOURCE_COMMIT)
#error "The Computer Use Windows host requires an embedded source commit"
#endif

#include <windows.h>

#include <ole2.h>
#include <UIAutomation.h>
#include <VersionHelpers.h>
#include <bcrypt.h>
#include <dwmapi.h>
#include <sddl.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <softpub.h>
#include <tlhelp32.h>
#include <userenv.h>
#include <wincrypt.h>
#include <winnls.h>
#include <wintrust.h>

#if defined(_MSC_VER) && __has_include(<winrt/Windows.Graphics.Capture.h>) && \
    __has_include(<windows.graphics.capture.interop.h>) && \
    __has_include(<windows.graphics.directx.direct3d11.interop.h>)
#define SPRINT_CODER_HAS_WINDOWS_GRAPHICS_CAPTURE 1
#include <d3d11.h>
#include <dxgi1_2.h>
#include <wincodec.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <winrt/base.h>
#include <wrl/client.h>
#else
#define SPRINT_CODER_HAS_WINDOWS_GRAPHICS_CAPTURE 0
#endif

#if defined(SPRINT_CODER_REQUIRE_WINDOWS_GRAPHICS_CAPTURE) &&                  \
    !SPRINT_CODER_HAS_WINDOWS_GRAPHICS_CAPTURE
#error                                                                         \
    "Windows Graphics Capture headers are required for the packaged Computer Use helper"
#endif

#include <algorithm>
#include <array>
#include <atomic>
#include <charconv>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <iostream>
#include <iterator>
#include <limits>
#include <memory>
#include <mutex>
#include <set>
#include <span>
#include <string>
#include <string_view>
#include <chrono>
#include <cstdio>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

#include "computer_use_protocol.h"
#include "computer_use_native_ticket.h"
#include "computer_use_preflight_classifier.h"
#include "computer_use_native_eligibility.h"
#include "computer_use_windows_uia_source.h"
#include "computer_use_windows_shadow_scheduler.h"
#include "computer_use_windows_interlock_capture.h"
#include "computer_use_native_refusal_table.h"
#include "computer_use_windows_artifact_read.h"

namespace {

using sprint_coder::computer_use::DecodeFrame;
using sprint_coder::computer_use::EncodeFrame;
using sprint_coder::computer_use::Frame;
using sprint_coder::computer_use::FrameHeader;
using sprint_coder::computer_use::IsBoundedUtf8;
using sprint_coder::computer_use::kApiVersion;
using sprint_coder::computer_use::kMaxBinaryBytes;
using sprint_coder::computer_use::kMaxMetadataBytes;
using sprint_coder::computer_use::kProtocolVersion;
using sprint_coder::computer_use::MessageType;

constexpr std::uint32_t kMinimumWindowsBuild = 18362;
constexpr std::string_view kSourceCommit = SPRINT_CODER_SOURCE_COMMIT;
static_assert(kSourceCommit.size() == 40,
              "Computer Use source commit must be a full Git commit id");
static_assert(sizeof(void *) == 8, "Windows Computer Use helper is x64-only");

struct BackendProbe {
  bool os_supported = false;
  bool ui_automation = false;
  bool graphics_capture = false;
  bool send_input = false;
};

struct ScopedKernelHandle {
  HANDLE value = nullptr;
  ScopedKernelHandle() = default;
  explicit ScopedKernelHandle(HANDLE handle) : value(handle) {}
  ScopedKernelHandle(const ScopedKernelHandle &) = delete;
  ScopedKernelHandle &operator=(const ScopedKernelHandle &) = delete;
  ~ScopedKernelHandle() {
    if (value != nullptr && value != INVALID_HANDLE_VALUE)
      CloseHandle(value);
  }
  HANDLE release() {
    const HANDLE handle = value;
    value = nullptr;
    return handle;
  }
};

std::atomic<std::uint64_t> cancellation_epoch{0};
std::atomic<bool> parent_process_dead{false};

struct CachedResponse {
  MessageType type = MessageType::kError;
  std::string request_digest;
  std::string metadata;
  std::vector<std::uint8_t> binary;
};

constexpr std::size_t kMaximumCachedResponses = 256;
constexpr std::size_t kMaximumResponseCacheBytes = 32 * 1024 * 1024;
std::unordered_map<std::string, CachedResponse> response_cache;
std::deque<std::string> response_cache_order;
std::size_t response_cache_bytes = 0;

struct WindowsSession {
  // Counts API attempts, never inferred successful effects. Shared by session refocus copies.
  std::shared_ptr<std::atomic<std::uint64_t>> input_api_attempts =
      std::make_shared<std::atomic<std::uint64_t>>(0);
  std::string session_id;
  std::uint32_t pid = 0;
  HWND window = nullptr;
  HWND active_window = nullptr;
  std::string app_identity;
  std::string window_identity;
  std::string active_window_identity;
  std::string active_window_kind = "application";
  std::string process_start;
  std::wstring canonical_path;
  HANDLE process_handle = nullptr;
  HANDLE executable_file = INVALID_HANDLE_VALUE;
  std::uint64_t executable_volume_serial = 0;
  FILE_ID_128 executable_file_id{};
  std::string executable_digest;
  std::string signer_digest;
  std::string policy_language = "unknown";
  std::string maximum_mode = "observe_only";
  std::uint64_t cancel_epoch = 0;
  std::uint64_t observation_revision = 0;
  bool has_observation = false;
  std::uint64_t dialog_set_revision = 0;
  std::string dialog_set_digest;
  RECT observation_bounds{};
  std::size_t observation_capture_width = 0;
  std::size_t observation_capture_height = 0;
  std::size_t observation_patch_columns = 0;
  std::size_t observation_patch_rows = 0;
  std::vector<std::string> observation_patch_digests;
  std::string focused_element_signature;
  bool has_focused_element_signature = false;
  std::unordered_map<std::string, std::string> semantic_control_signatures;
  std::set<std::string> visual_control_signatures;
};

std::unordered_map<std::string, WindowsSession> sessions;

// The ordinary dispatch ticket (ADR v2 S4-4 addendum 5). The Windows helper serves one frame at a
// time, so the slot and its generation need no lock. A ticket is issued by a preflight and consumed
// by exactly one dispatch; every session boundary (start/resume, cancel, close) drops it.
struct WindowsTicketState {
  sprint_coder::computer_use::NativeOrdinaryTicketSlot slot;
  // 0 is the "none" sentinel and is never issued; it advances on every issue and every dispatch.
  std::uint64_t generation = 0;
};
std::unordered_map<std::string, WindowsTicketState> ticket_states;

void InvalidateWindowsTicket(const std::string &session_key) {
  const auto found = ticket_states.find(session_key);
  if (found == ticket_states.end()) return;
  found->second.slot.Invalidate();
  ++found->second.generation;
}

void ForgetWindowsTicket(const std::string &session_key) {
  const auto found = ticket_states.find(session_key);
  if (found == ticket_states.end()) return;
  found->second.slot.Invalidate();
  ticket_states.erase(found);
}
std::uint64_t last_closed_cancel_epoch = 0;

// A close releases the session before Main can acknowledge the response, so a close whose answer
// never arrived left the session id unreachable: every repeat close was refused and Main kept the
// process-local input quarantine for the rest of the helper's life. This bounded record is what
// answers a repeat close. It is written only where a drained close response is produced, so it
// cannot turn a stop that never drained into a confirmed one. It lives as long as this helper
// process does, which covers the close Main gave up on before its answer arrived: the transport
// keeps this helper alive across Main's whole bounded re-send window
// (COMPUTER_USE_NATIVE_CLOSE_TRANSPORT_TIMEOUT_MS in computer-use-native-windows.ts), so the
// re-send reaches this record. A close this helper never answers at all is a different case: once
// the last close attempt's transport budget runs out the transport aborts and kills this process,
// the record dies with it, and Main stays quarantined, which is the intended fail-closed outcome.
// Carrying the input attempt count across helper processes is a separate change.
struct ClosedWindowsSessionRecord {
  std::string session_id;
  std::uint64_t cancel_epoch = 0;
  std::uint64_t input_api_attempts = 0;
};

std::unordered_map<std::string, ClosedWindowsSessionRecord> closed_sessions;
std::deque<std::string> closed_session_order;
constexpr std::size_t kMaximumClosedSessionRecords = 16;

void RememberClosedWindowsSession(const std::string &session_key,
                                  const ClosedWindowsSessionRecord &record) {
  const auto existing = closed_sessions.find(session_key);
  if (existing != closed_sessions.end()) {
    existing->second = record;
    return;
  }
  while (closed_session_order.size() >= kMaximumClosedSessionRecords) {
    closed_sessions.erase(closed_session_order.front());
    closed_session_order.pop_front();
  }
  closed_session_order.push_back(session_key);
  closed_sessions.emplace(session_key, record);
}

void ReleaseWindowsSessionResources(WindowsSession *session) {
  if (session == nullptr)
    return;
  if (session->executable_file != INVALID_HANDLE_VALUE) {
    CloseHandle(session->executable_file);
    session->executable_file = INVALID_HANDLE_VALUE;
  }
  if (session->process_handle != nullptr) {
    CloseHandle(session->process_handle);
    session->process_handle = nullptr;
  }
  for (auto &digest : session->observation_patch_digests)
    std::fill(digest.begin(), digest.end(), '0');
  session->observation_patch_digests.clear();
  session->observation_patch_digests.shrink_to_fit();
}

void InvalidateWindowsObservation(WindowsSession *session) {
  if (session == nullptr)
    return;
  session->has_observation = false;
  if (session->observation_revision <
      std::numeric_limits<std::uint64_t>::max())
    session->observation_revision += 1;
  session->observation_bounds = {};
  session->observation_capture_width = 0;
  session->observation_capture_height = 0;
  session->observation_patch_columns = 0;
  session->observation_patch_rows = 0;
  for (auto &digest : session->observation_patch_digests)
    std::fill(digest.begin(), digest.end(), '0');
  session->observation_patch_digests.clear();
  session->focused_element_signature.clear();
  session->has_focused_element_signature = false;
  session->semantic_control_signatures.clear();
  session->visual_control_signatures.clear();
}

bool IsProcessElevated(std::uint32_t pid);
bool TargetWindowFacts(std::uint32_t pid, HWND window, RECT *bounds);
bool ClientBoundsPhysical(HWND window, RECT *bounds);
bool IsKnownProxyExecutable(const std::wstring &path);
bool IsDisallowedTargetExecutable(const std::wstring &path);
bool IsAcceptanceFixtureExecutable(const std::wstring &path);
bool RevalidateWindowsTarget(const WindowsSession &session,
                             const RECT &expected,
                             std::uint64_t expected_epoch);
bool ComputeWindowsControlSignature(IUIAutomationElement *element,
                                    std::uint32_t expected_pid,
                                    const RECT *containing_bounds,
                                    std::string *signature);
std::string BoundedUtf8(std::string value, std::size_t maximum_bytes);

std::string Utf8FromWide(std::wstring_view value) {
  if (value.empty())
    return {};
  const int length = WideCharToMultiByte(
      CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
      static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  if (length <= 0)
    return {};
  std::string result(static_cast<std::size_t>(length), '\0');
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
                          static_cast<int>(value.size()), result.data(), length,
                          nullptr, nullptr) != length)
    return {};
  return result;
}

std::string JsonEscape(std::string_view value) {
  std::string result;
  result.reserve(value.size() + 8);
  for (const unsigned char character : value) {
    switch (character) {
    case '\\':
      result += "\\\\";
      break;
    case '"':
      result += "\\\"";
      break;
    case '\b':
      result += "\\b";
      break;
    case '\f':
      result += "\\f";
      break;
    case '\n':
      result += "\\n";
      break;
    case '\r':
      result += "\\r";
      break;
    case '\t':
      result += "\\t";
      break;
    default:
      if (character < 0x20) {
        static constexpr char hexadecimal[] = "0123456789abcdef";
        result += "\\u00";
        result += hexadecimal[(character >> 4) & 0xf];
        result += hexadecimal[character & 0xf];
      } else {
        result.push_back(static_cast<char>(character));
      }
    }
  }
  return result;
}

bool ReadJsonString(std::string_view json, std::string_view key,
                    std::string *output) {
  const std::string needle = "\"" + std::string(key) + "\"";
  const auto position = json.find(needle);
  if (position == std::string_view::npos)
    return false;
  std::size_t cursor = position + needle.size();
  while (cursor < json.size() &&
         (json[cursor] == ' ' || json[cursor] == '\t' || json[cursor] == '\r' ||
          json[cursor] == '\n' || json[cursor] == ':'))
    ++cursor;
  if (cursor >= json.size() || json[cursor] != '"')
    return false;
  ++cursor;
  std::string result;
  while (cursor < json.size()) {
    const char character = json[cursor++];
    if (character == '"') {
      *output = std::move(result);
      return output->size() <= 4'096;
    }
    if (character == '\\') {
      if (cursor >= json.size())
        return false;
      const char escaped = json[cursor++];
      if (escaped == '"' || escaped == '\\' || escaped == '/')
        result.push_back(escaped);
      else if (escaped == 'n')
        result.push_back('\n');
      else if (escaped == 'r')
        result.push_back('\r');
      else if (escaped == 't')
        result.push_back('\t');
      else
        return false;
    } else {
      if (static_cast<unsigned char>(character) < 0x20)
        return false;
      result.push_back(character);
    }
  }
  return false;
}

bool ReadJsonUint64(std::string_view json, std::string_view key,
                    std::uint64_t *output) {
  const std::string needle = "\"" + std::string(key) + "\"";
  const auto position = json.find(needle);
  if (position == std::string_view::npos)
    return false;
  std::size_t cursor = position + needle.size();
  while (cursor < json.size() &&
         (json[cursor] == ' ' || json[cursor] == '\t' || json[cursor] == '\r' ||
          json[cursor] == '\n' || json[cursor] == ':'))
    ++cursor;
  bool quoted = false;
  if (cursor < json.size() && json[cursor] == '"') {
    quoted = true;
    ++cursor;
  }
  const auto begin = cursor;
  while (cursor < json.size() && json[cursor] >= '0' && json[cursor] <= '9')
    ++cursor;
  if (cursor == begin ||
      (quoted && (cursor >= json.size() || json[cursor] != '"')))
    return false;
  const auto parsed =
      std::from_chars(json.data() + begin, json.data() + cursor, *output);
  return parsed.ec == std::errc{} && parsed.ptr == json.data() + cursor;
}

bool ReadOptionalJsonBoolean(std::string_view json, std::string_view key,
                             bool *output) {
  if (output == nullptr)
    return false;
  *output = false;
  const std::string needle = "\"" + std::string(key) + "\"";
  const auto position = json.find(needle);
  if (position == std::string_view::npos)
    return true;
  if (json.find(needle, position + needle.size()) != std::string_view::npos)
    return false;
  std::size_t cursor = position + needle.size();
  while (cursor < json.size() &&
         (json[cursor] == ' ' || json[cursor] == '\t' ||
          json[cursor] == '\r' || json[cursor] == '\n'))
    ++cursor;
  if (cursor >= json.size() || json[cursor] != ':')
    return false;
  ++cursor;
  while (cursor < json.size() &&
         (json[cursor] == ' ' || json[cursor] == '\t' ||
          json[cursor] == '\r' || json[cursor] == '\n'))
    ++cursor;
  std::size_t end = cursor;
  if (json.substr(cursor, 4) == "true") {
    *output = true;
    end += 4;
  } else if (json.substr(cursor, 5) == "false") {
    end += 5;
  } else {
    return false;
  }
  while (end < json.size() &&
         (json[end] == ' ' || json[end] == '\t' || json[end] == '\r' ||
          json[end] == '\n'))
    ++end;
  return end < json.size() && (json[end] == ',' || json[end] == '}');
}

bool ReadJsonDouble(std::string_view json, std::string_view key,
                    double *output) {
  const std::string needle = "\"" + std::string(key) + "\"";
  const auto position = json.find(needle);
  if (position == std::string_view::npos)
    return false;
  std::size_t cursor = position + needle.size();
  while (cursor < json.size() &&
         (json[cursor] == ' ' || json[cursor] == '\t' || json[cursor] == '\r' ||
          json[cursor] == '\n' || json[cursor] == ':'))
    ++cursor;
  const auto begin = cursor;
  while (cursor < json.size() &&
         (json[cursor] == '-' || json[cursor] == '+' || json[cursor] == '.' ||
          (json[cursor] >= '0' && json[cursor] <= '9')))
    ++cursor;
  if (cursor == begin)
    return false;
  std::string number(json.substr(begin, cursor - begin));
  char *end = nullptr;
  *output = std::strtod(number.c_str(), &end);
  return end != number.c_str() && *end == '\0' && std::isfinite(*output);
}

std::string Sha256Bytes(const std::vector<std::uint8_t> &bytes) {
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  DWORD object_bytes = 0;
  DWORD result_bytes = 0;
  DWORD digest_bytes = 0;
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr,
                                  0) != 0 ||
      BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH,
                        reinterpret_cast<PUCHAR>(&object_bytes),
                        sizeof(object_bytes), &result_bytes, 0) != 0 ||
      BCryptGetProperty(algorithm, BCRYPT_HASH_LENGTH,
                        reinterpret_cast<PUCHAR>(&digest_bytes),
                        sizeof(digest_bytes), &result_bytes, 0) != 0 ||
      digest_bytes != 32) {
    if (algorithm != nullptr)
      BCryptCloseAlgorithmProvider(algorithm, 0);
    return {};
  }
  std::vector<std::uint8_t> object(object_bytes);
  std::vector<std::uint8_t> digest(digest_bytes);
  if (BCryptCreateHash(algorithm, &hash, object.data(), object_bytes, nullptr,
                       0, 0) != 0 ||
      (!bytes.empty() &&
       BCryptHashData(hash, const_cast<PUCHAR>(bytes.data()),
                      static_cast<ULONG>(bytes.size()), 0) != 0) ||
      BCryptFinishHash(hash, digest.data(), digest_bytes, 0) != 0) {
    if (hash != nullptr)
      BCryptDestroyHash(hash);
    BCryptCloseAlgorithmProvider(algorithm, 0);
    return {};
  }
  BCryptDestroyHash(hash);
  BCryptCloseAlgorithmProvider(algorithm, 0);
  static constexpr char hexadecimal[] = "0123456789abcdef";
  std::string result(digest.size() * 2, '0');
  for (std::size_t index = 0; index < digest.size(); ++index) {
    result[index * 2] = hexadecimal[digest[index] >> 4];
    result[index * 2 + 1] = hexadecimal[digest[index] & 0xf];
  }
  return result;
}

std::string Sha256String(std::string_view value) {
  return Sha256Bytes(std::vector<std::uint8_t>(value.begin(), value.end()));
}

bool ReadProcessPath(HANDLE process, std::wstring *output) {
  if (process == nullptr || output == nullptr)
    return false;
  std::vector<wchar_t> buffer(32768, L'\0');
  DWORD length = static_cast<DWORD>(buffer.size());
  const bool read =
      QueryFullProcessImageNameW(process, 0, buffer.data(), &length) == TRUE;
  if (!read || length == 0 || length >= buffer.size())
    return false;
  *output = std::wstring(buffer.data(), length);
  return true;
}

bool ReadProcessPath(std::uint32_t pid, std::wstring *output) {
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (process == nullptr)
    return false;
  const bool read = ReadProcessPath(process, output);
  CloseHandle(process);
  return read;
}

struct WindowsFileIdentity {
  std::uint64_t volume_serial = 0;
  FILE_ID_128 file_id{};
};

struct WindowsExecutableIdentity {
  std::wstring path;
  std::string path_utf8;
  std::string executable_digest;
  std::string signer_digest;
  std::string identity_digest;
  std::string display_name;
  std::string policy_language = "unknown";
  bool microsoft_signer = false;
  WindowsFileIdentity file_identity;
};

struct LockedWindowsExecutable {
  HANDLE file = INVALID_HANDLE_VALUE;
  WindowsExecutableIdentity identity;

  LockedWindowsExecutable() = default;
  LockedWindowsExecutable(const LockedWindowsExecutable &) = delete;
  LockedWindowsExecutable &operator=(const LockedWindowsExecutable &) = delete;
  LockedWindowsExecutable(LockedWindowsExecutable &&other) noexcept
      : file(other.file), identity(std::move(other.identity)) {
    other.file = INVALID_HANDLE_VALUE;
  }
  LockedWindowsExecutable &operator=(LockedWindowsExecutable &&other) noexcept {
    if (this == &other)
      return *this;
    if (file != INVALID_HANDLE_VALUE)
      CloseHandle(file);
    file = other.file;
    identity = std::move(other.identity);
    other.file = INVALID_HANDLE_VALUE;
    return *this;
  }
  ~LockedWindowsExecutable() {
    if (file != INVALID_HANDLE_VALUE)
      CloseHandle(file);
  }
};

void CloseLockedWindowsExecutable(LockedWindowsExecutable *locked) {
  if (locked != nullptr && locked->file != INVALID_HANDLE_VALUE) {
    CloseHandle(locked->file);
    locked->file = INVALID_HANDLE_VALUE;
  }
}

bool SameWindowsFileIdentity(const WindowsFileIdentity &left,
                             const WindowsFileIdentity &right) {
  return left.volume_serial == right.volume_serial &&
         std::memcmp(left.file_id.Identifier, right.file_id.Identifier,
                     sizeof(left.file_id.Identifier)) == 0;
}

bool ReadWindowsFileIdentity(HANDLE file, WindowsFileIdentity *identity) {
  FILE_ID_INFO information{};
  if (file == INVALID_HANDLE_VALUE || identity == nullptr ||
      !GetFileInformationByHandleEx(file, FileIdInfo, &information,
                                    sizeof(information)))
    return false;
  identity->volume_serial = information.VolumeSerialNumber;
  identity->file_id = information.FileId;
  return true;
}

bool CanonicalWindowsPathFromHandle(HANDLE file, std::wstring *output) {
  if (file == INVALID_HANDLE_VALUE || output == nullptr)
    return false;
  constexpr DWORD flags = FILE_NAME_NORMALIZED | VOLUME_NAME_DOS;
  const DWORD required = GetFinalPathNameByHandleW(file, nullptr, 0, flags);
  if (required == 0 || required > 32'767)
    return false;
  std::wstring path(static_cast<std::size_t>(required) + 1, L'\0');
  const DWORD length = GetFinalPathNameByHandleW(
      file, path.data(), static_cast<DWORD>(path.size()), flags);
  if (length == 0 || length >= path.size())
    return false;
  path.resize(length);
  static constexpr std::wstring_view unc_prefix = L"\\\\?\\UNC\\";
  static constexpr std::wstring_view local_prefix = L"\\\\?\\";
  if (path.starts_with(unc_prefix))
    path = L"\\\\" + path.substr(unc_prefix.size());
  else if (path.starts_with(local_prefix))
    path.erase(0, local_prefix.size());
  if (path.empty() || path.size() > 32'767)
    return false;
  *output = std::move(path);
  return true;
}

bool ReadFileDigest(HANDLE file, std::string *digest) {
  if (file == INVALID_HANDLE_VALUE || digest == nullptr)
    return false;
  FILE_ATTRIBUTE_TAG_INFO tag{};
  if (!GetFileInformationByHandleEx(file, FileAttributeTagInfo, &tag,
                                    sizeof(tag)) ||
      (tag.FileAttributes & (FILE_ATTRIBUTE_DIRECTORY |
                             FILE_ATTRIBUTE_REPARSE_POINT)) != 0) {
    return false;
  }
  LARGE_INTEGER beginning{};
  if (!SetFilePointerEx(file, beginning, nullptr, FILE_BEGIN))
    return false;
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  DWORD object_bytes = 0;
  DWORD result_bytes = 0;
  DWORD digest_bytes = 0;
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr,
                                  0) != 0 ||
      BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH,
                        reinterpret_cast<PUCHAR>(&object_bytes),
                        sizeof(object_bytes), &result_bytes, 0) != 0 ||
      BCryptGetProperty(algorithm, BCRYPT_HASH_LENGTH,
                        reinterpret_cast<PUCHAR>(&digest_bytes),
                        sizeof(digest_bytes), &result_bytes, 0) != 0 ||
      digest_bytes != 32) {
    if (algorithm != nullptr)
      BCryptCloseAlgorithmProvider(algorithm, 0);
    return false;
  }
  std::vector<std::uint8_t> object(object_bytes);
  std::vector<std::uint8_t> digest_bytes_buffer(digest_bytes);
  if (BCryptCreateHash(algorithm, &hash, object.data(), object_bytes, nullptr,
                       0, 0) != 0) {
    BCryptCloseAlgorithmProvider(algorithm, 0);
    return false;
  }
  std::array<std::uint8_t, 1 << 20> chunk{};
  bool succeeded = true;
  for (;;) {
    DWORD read = 0;
    if (!ReadFile(file, chunk.data(), static_cast<DWORD>(chunk.size()), &read,
                  nullptr)) {
      succeeded = false;
      break;
    }
    if (read == 0)
      break;
    if (BCryptHashData(hash, chunk.data(), read, 0) != 0) {
      succeeded = false;
      break;
    }
  }
  if (succeeded)
    succeeded = BCryptFinishHash(hash, digest_bytes_buffer.data(), digest_bytes,
                                 0) == 0;
  BCryptDestroyHash(hash);
  BCryptCloseAlgorithmProvider(algorithm, 0);
  if (!succeeded)
    return false;
  static constexpr char hexadecimal[] = "0123456789abcdef";
  digest->assign(digest_bytes_buffer.size() * 2, '0');
  for (std::size_t index = 0; index < digest_bytes_buffer.size(); ++index) {
    (*digest)[index * 2] = hexadecimal[digest_bytes_buffer[index] >> 4];
    (*digest)[index * 2 + 1] = hexadecimal[digest_bytes_buffer[index] & 0xf];
  }
  return true;
}

std::string HexBytes(std::span<const std::uint8_t> bytes) {
  static constexpr char hexadecimal[] = "0123456789abcdef";
  std::string result(bytes.size() * 2, '0');
  for (std::size_t index = 0; index < bytes.size(); ++index) {
    result[index * 2] = hexadecimal[bytes[index] >> 4];
    result[index * 2 + 1] = hexadecimal[bytes[index] & 0xf];
  }
  return result;
}

bool ReadCertificateOrganization(PCCERT_CONTEXT certificate,
                                 std::wstring *organization) {
  if (certificate == nullptr || organization == nullptr)
    return false;
  void *organization_oid = const_cast<char *>(szOID_ORGANIZATION_NAME);
  const DWORD characters = CertGetNameStringW(
      certificate, CERT_NAME_ATTR_TYPE, 0, organization_oid, nullptr, 0);
  if (characters <= 1 || characters > 256)
    return false;
  std::wstring value(static_cast<std::size_t>(characters), L'\0');
  if (CertGetNameStringW(certificate, CERT_NAME_ATTR_TYPE, 0,
                         organization_oid, value.data(), characters) !=
      characters)
    return false;
  value.resize(characters - 1);
  *organization = std::move(value);
  return true;
}

bool ReadAuthenticodeSignerDigest(HANDLE file, const std::wstring &path,
                                  std::string *signer_digest,
                                  bool *microsoft_signer = nullptr) {
  if (microsoft_signer != nullptr)
    *microsoft_signer = false;
  WINTRUST_FILE_INFO file_info{};
  file_info.cbStruct = sizeof(file_info);
  file_info.pcwszFilePath = path.c_str();
  file_info.hFile = file;
  WINTRUST_DATA trust{};
  trust.cbStruct = sizeof(trust);
  trust.dwUIChoice = WTD_UI_NONE;
  trust.fdwRevocationChecks = WTD_REVOKE_NONE;
  trust.dwUnionChoice = WTD_CHOICE_FILE;
  trust.pFile = &file_info;
  trust.dwStateAction = WTD_STATEACTION_VERIFY;
  trust.dwProvFlags = WTD_CACHE_ONLY_URL_RETRIEVAL | WTD_SAFER_FLAG;
  GUID policy = WINTRUST_ACTION_GENERIC_VERIFY_V2;
  const LONG verified = WinVerifyTrust(nullptr, &policy, &trust);
  trust.dwStateAction = WTD_STATEACTION_CLOSE;
  WinVerifyTrust(nullptr, &policy, &trust);
  if (verified != ERROR_SUCCESS)
    return false;

  HCERTSTORE store = nullptr;
  HCRYPTMSG message = nullptr;
  DWORD encoding = 0;
  DWORD content = 0;
  DWORD format = 0;
  if (!CryptQueryObject(CERT_QUERY_OBJECT_FILE, path.c_str(),
                        CERT_QUERY_CONTENT_FLAG_PKCS7_SIGNED_EMBED,
                        CERT_QUERY_FORMAT_FLAG_BINARY, 0, &encoding, &content,
                        &format, &store, &message, nullptr))
    return false;
  DWORD signer_bytes = 0;
  bool success = CryptMsgGetParam(message, CMSG_SIGNER_INFO_PARAM, 0, nullptr,
                                  &signer_bytes) == TRUE &&
                 signer_bytes >= sizeof(CMSG_SIGNER_INFO);
  std::vector<std::uint8_t> signer_buffer(signer_bytes);
  if (success)
    success = CryptMsgGetParam(message, CMSG_SIGNER_INFO_PARAM, 0,
                               signer_buffer.data(), &signer_bytes) == TRUE;
  PCCERT_CONTEXT certificate = nullptr;
  if (success) {
    const auto *signer =
        reinterpret_cast<const CMSG_SIGNER_INFO *>(signer_buffer.data());
    CERT_INFO certificate_info{};
    certificate_info.Issuer = signer->Issuer;
    certificate_info.SerialNumber = signer->SerialNumber;
    certificate = CertFindCertificateInStore(
        store, encoding, 0, CERT_FIND_SUBJECT_CERT, &certificate_info, nullptr);
    success = certificate != nullptr;
  }
  std::array<std::uint8_t, 32> thumbprint{};
  DWORD thumbprint_bytes = static_cast<DWORD>(thumbprint.size());
  if (success)
    success = CertGetCertificateContextProperty(
                  certificate, CERT_SHA256_HASH_PROP_ID, thumbprint.data(),
                  &thumbprint_bytes) == TRUE &&
              thumbprint_bytes == thumbprint.size();
  if (success && microsoft_signer != nullptr) {
    std::wstring organization;
    *microsoft_signer =
        ReadCertificateOrganization(certificate, &organization) &&
        _wcsicmp(organization.c_str(), L"Microsoft Corporation") == 0;
  }
  if (certificate != nullptr)
    CertFreeCertificateContext(certificate);
  if (message != nullptr)
    CryptMsgClose(message);
  if (store != nullptr)
    CertCloseStore(store, 0);
  if (!success)
    return false;
  *signer_digest = HexBytes(thumbprint);
  return true;
}

std::string CurrentHelperSignerDigest() {
  static const std::string digest = []() {
    std::vector<wchar_t> path(32'768, L'\0');
    const DWORD length = GetModuleFileNameW(
        nullptr, path.data(), static_cast<DWORD>(path.size()));
    if (length == 0 || static_cast<std::size_t>(length) >= path.size())
      return std::string{};
    const std::wstring image_path(path.data(), length);
    HANDLE file = CreateFileW(image_path.c_str(), GENERIC_READ, FILE_SHARE_READ,
                              nullptr, OPEN_EXISTING,
                              FILE_ATTRIBUTE_NORMAL | FILE_FLAG_SEQUENTIAL_SCAN,
                              nullptr);
    if (file == INVALID_HANDLE_VALUE)
      return std::string{};
    std::string signer;
    const bool verified =
        ReadAuthenticodeSignerDigest(file, image_path, &signer);
    CloseHandle(file);
    return verified ? signer : std::string{};
  }();
  return digest;
}

std::string PolicyLanguageForWindowsExecutable(const std::wstring &path) {
  if (path.empty())
    return "unknown";
  std::array<wchar_t, LOCALE_NAME_MAX_LENGTH> language{};
  std::vector<wchar_t> mui_path(32'768, L'\0');
  ULONG language_characters = static_cast<ULONG>(language.size());
  ULONG mui_path_characters = static_cast<ULONG>(mui_path.size());
  ULONGLONG enumerator = 0;
  if (!GetFileMUIPath(MUI_LANGUAGE_NAME | MUI_USER_PREFERRED_UI_LANGUAGES,
                      path.c_str(), language.data(), &language_characters,
                      mui_path.data(), &mui_path_characters, &enumerator))
    return "unknown";
  const std::size_t length = wcsnlen_s(language.data(), language.size());
  if (length == 2 && _wcsnicmp(language.data(), L"en", 2) == 0)
    return "en";
  if (length == 2 && _wcsnicmp(language.data(), L"ja", 2) == 0)
    return "ja";
  if (length > 2 && (language[2] == L'-' || language[2] == L'_')) {
    if (_wcsnicmp(language.data(), L"en", 2) == 0)
      return "en";
    if (_wcsnicmp(language.data(), L"ja", 2) == 0)
      return "ja";
  }
  return "unknown";
}

bool BuildLockedWindowsExecutableIdentity(HANDLE file,
                                          WindowsExecutableIdentity *output) {
  if (file == INVALID_HANDLE_VALUE || output == nullptr)
    return false;
  std::wstring path;
  WindowsFileIdentity file_identity;
  std::string executable_digest;
  if (!CanonicalWindowsPathFromHandle(file, &path) ||
      !ReadWindowsFileIdentity(file, &file_identity) ||
      !ReadFileDigest(file, &executable_digest))
    return false;
  std::string signer_digest;
  bool microsoft_signer = false;
  // The no-write/no-delete share lock remains held while trust metadata is
  // read by path, so the bytes verified here cannot be swapped underneath the
  // Authenticode APIs.
  ReadAuthenticodeSignerDigest(file, path, &signer_digest,
                               &microsoft_signer);
  const std::string path_utf8 = Utf8FromWide(path);
  if (path_utf8.empty() || path_utf8.size() > 4'096)
    return false;
  std::wstring display_path = path;
  const auto slash = display_path.find_last_of(L"\\/");
  std::wstring display = slash == std::wstring::npos
                             ? display_path
                             : display_path.substr(slash + 1);
  const auto extension = display.rfind(L'.');
  if (extension != std::wstring::npos)
    display.resize(extension);
  const std::string display_name = BoundedUtf8(Utf8FromWide(display), 256);
  std::string policy_language = PolicyLanguageForWindowsExecutable(path);
  if (policy_language == "unknown" && IsAcceptanceFixtureExecutable(path) &&
      !signer_digest.empty() && signer_digest == CurrentHelperSignerDigest())
    policy_language = "en";
  std::string normalized_path = path_utf8;
  for (char &character : normalized_path)
    if (character >= 'A' && character <= 'Z')
      character = static_cast<char>(character + ('a' - 'A'));
  const std::string identity_digest =
      signer_digest.empty()
          ? Sha256String("computer-win-identity-v1-unsigned\n" +
                         executable_digest)
          : Sha256String("computer-win-identity-v1-signed\n" + normalized_path +
                         "\n" + signer_digest);
  *output = {path,
             path_utf8,
             executable_digest,
             signer_digest,
             identity_digest,
             display_name.empty() ? "Application" : display_name,
             policy_language,
             microsoft_signer,
             file_identity};
  return true;
}

bool OpenLockedWindowsExecutable(const std::wstring &path,
                                 LockedWindowsExecutable *output) {
  if (output == nullptr)
    return false;
  output->file = INVALID_HANDLE_VALUE;
  output->identity = {};
  // Deliberately allow read sharing only. Existing or future handles with
  // write/delete access make this open fail, preventing executable
  // swap/restore between identity verification and CreateProcessW.
  HANDLE file =
      CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
                  OPEN_EXISTING,
                  FILE_ATTRIBUTE_NORMAL | FILE_FLAG_SEQUENTIAL_SCAN, nullptr);
  if (file == INVALID_HANDLE_VALUE)
    return false;
  WindowsExecutableIdentity identity;
  if (!BuildLockedWindowsExecutableIdentity(file, &identity)) {
    CloseHandle(file);
    return false;
  }
  output->file = file;
  output->identity = std::move(identity);
  return true;
}

bool BuildWindowsExecutableIdentity(const std::wstring &path,
                                    WindowsExecutableIdentity *output) {
  LockedWindowsExecutable locked;
  if (!OpenLockedWindowsExecutable(path, &locked))
    return false;
  *output = locked.identity;
  CloseLockedWindowsExecutable(&locked);
  return true;
}

bool OpenLockedProcessExecutable(HANDLE process,
                                 LockedWindowsExecutable *output) {
  std::wstring process_path;
  return ReadProcessPath(process, &process_path) &&
         OpenLockedWindowsExecutable(process_path, output);
}

bool OpenLockedProcessExecutable(std::uint32_t pid,
                                 LockedWindowsExecutable *output) {
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (process == nullptr)
    return false;
  const bool opened = OpenLockedProcessExecutable(process, output);
  CloseHandle(process);
  return opened;
}

bool WindowsExecutableIdentityMatches(
    const WindowsExecutableIdentity &actual, std::string_view identity_digest,
    std::string_view executable_digest, std::string_view signer_digest) {
  return actual.identity_digest == identity_digest &&
         actual.executable_digest == executable_digest &&
         (signer_digest.empty() ? actual.signer_digest.empty()
                                : actual.signer_digest == signer_digest);
}

bool WindowsSessionExecutableMatches(
    const WindowsSession &session,
    const LockedWindowsExecutable &current_executable) {
  WindowsFileIdentity held_identity;
  return session.executable_file != INVALID_HANDLE_VALUE &&
         current_executable.file != INVALID_HANDLE_VALUE &&
         ReadWindowsFileIdentity(session.executable_file, &held_identity) &&
         held_identity.volume_serial == session.executable_volume_serial &&
         std::memcmp(held_identity.file_id.Identifier,
                     session.executable_file_id.Identifier,
                     sizeof(held_identity.file_id.Identifier)) == 0 &&
         SameWindowsFileIdentity(held_identity,
                                 current_executable.identity.file_identity) &&
         session.executable_digest ==
             current_executable.identity.executable_digest &&
         session.signer_digest == current_executable.identity.signer_digest &&
         session.policy_language == current_executable.identity.policy_language;
}

bool IsPolicyLanguageSupported(std::string_view language) {
  return language == "en" || language == "ja";
}

bool IsTrustedSystemNotepad(const WindowsExecutableIdentity &identity) {
  std::vector<wchar_t> system_directory_buffer(32'768, L'\0');
  const UINT length = GetSystemDirectoryW(
      system_directory_buffer.data(),
      static_cast<UINT>(system_directory_buffer.size()));
  if (length == 0 ||
      static_cast<std::size_t>(length) >= system_directory_buffer.size())
    return false;
  std::wstring system_directory(system_directory_buffer.data(), length);
  if (!system_directory.empty() && system_directory.back() != L'\\')
    system_directory.push_back(L'\\');
  system_directory += L"note" L"pad.exe";
  return identity.microsoft_signer &&
         identity.path.size() == system_directory.size() &&
         CompareStringOrdinal(identity.path.c_str(),
                              static_cast<int>(identity.path.size()),
                              system_directory.c_str(),
                              static_cast<int>(system_directory.size()), TRUE) ==
             CSTR_EQUAL;
}

std::string MaximumModeForWindowsExecutable(
    const WindowsExecutableIdentity &identity) {
  if (!IsPolicyLanguageSupported(identity.policy_language))
    return "observe_only";
  if (IsTrustedSystemNotepad(identity))
    return "full_access_app";
  const std::string helper_signer = CurrentHelperSignerDigest();
  if (IsAcceptanceFixtureExecutable(identity.path) &&
      !helper_signer.empty() && identity.signer_digest == helper_signer)
    return "full_access_app";
  return "observe_only";
}

bool IsSupportedWindowsV1Target(
    const WindowsExecutableIdentity &identity) {
  return MaximumModeForWindowsExecutable(identity) == "full_access_app";
}

bool ScreenBoundsPhysicalForWindow(HWND window, RECT *bounds) {
  return window != nullptr && ClientBoundsPhysical(window, bounds);
}

std::string RectJson(const RECT &bounds) {
  return "{\"x\":" + std::to_string(bounds.left) +
         ",\"y\":" + std::to_string(bounds.top) +
         ",\"width\":" +
         std::to_string(bounds.right - bounds.left) +
         ",\"height\":" +
         std::to_string(bounds.bottom - bounds.top) + "}";
}

std::string WindowsIdentityJson(const WindowsExecutableIdentity &identity,
                                std::uint32_t pid = 0) {
  return "{\"platform\":\"win32\",\"identityDigest\":\"" +
         identity.identity_digest + "\",\"executablePath\":\"" +
         JsonEscape(identity.path_utf8) + "\",\"executableDigest\":\"" +
         identity.executable_digest + "\",\"signerDigest\":" +
         (identity.signer_digest.empty()
              ? "null"
              : "\"" + identity.signer_digest + "\"") +
         ",\"packageFamilyName\":null,\"appUserModelId\":null,\"displayName\":"
         "\"" +
         JsonEscape(identity.display_name) + "\"" +
         ",\"policyLanguage\":\"" + identity.policy_language + "\"" +
         ",\"maximumMode\":\"" + MaximumModeForWindowsExecutable(identity) +
         "\"" +
         (pid == 0 ? "" : ",\"pid\":" + std::to_string(pid)) + "}";
}

bool PickWindowsExecutable(std::string *response, std::string *reason) {
  IFileOpenDialog *dialog = nullptr;
  if (FAILED(CoCreateInstance(CLSID_FileOpenDialog, nullptr,
                              CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dialog))) ||
      dialog == nullptr) {
    *reason = "picker_unavailable";
    return false;
  }
  DWORD options = 0;
  dialog->GetOptions(&options);
  dialog->SetOptions(options | FOS_FILEMUSTEXIST | FOS_PATHMUSTEXIST |
                     FOS_FORCEFILESYSTEM | FOS_DONTADDTORECENT |
                     FOS_NODEREFERENCELINKS);
  const COMDLG_FILTERSPEC filters[] = {{L"Applications", L"*.exe"}};
  dialog->SetFileTypes(1, filters);
  dialog->SetDefaultExtension(L"exe");
  const HRESULT shown = dialog->Show(nullptr);
  if (shown == HRESULT_FROM_WIN32(ERROR_CANCELLED)) {
    dialog->Release();
    *response = "null";
    return true;
  }
  if (FAILED(shown)) {
    dialog->Release();
    *reason = "picker_failed";
    return false;
  }
  IShellItem *item = nullptr;
  PWSTR selected_path = nullptr;
  const bool selected =
      SUCCEEDED(dialog->GetResult(&item)) && item != nullptr &&
      SUCCEEDED(item->GetDisplayName(SIGDN_FILESYSPATH, &selected_path)) &&
      selected_path != nullptr;
  if (item != nullptr)
    item->Release();
  dialog->Release();
  if (!selected) {
    if (selected_path != nullptr)
      CoTaskMemFree(selected_path);
    *reason = "picker_selection_invalid";
    return false;
  }
  const std::wstring path(selected_path);
  CoTaskMemFree(selected_path);
  if (path.size() < 5 ||
      _wcsicmp(path.c_str() + path.size() - 4, L".exe") != 0) {
    *reason = "picker_selection_invalid";
    return false;
  }
  WindowsExecutableIdentity identity;
  if (!BuildWindowsExecutableIdentity(path, &identity)) {
    *reason = "identity_unavailable";
    return false;
  }
  if (!IsSupportedWindowsV1Target(identity) ||
      IsDisallowedTargetExecutable(identity.path) ||
      IsKnownProxyExecutable(identity.path)) {
    *reason = "target_application_unsupported";
    return false;
  }
  *response = WindowsIdentityJson(identity);
  return true;
}

bool SameWindowsPath(const std::wstring &left, const std::wstring &right) {
  return left.size() == right.size() &&
         CompareStringOrdinal(left.c_str(), static_cast<int>(left.size()),
                              right.c_str(), static_cast<int>(right.size()),
                              TRUE) == CSTR_EQUAL;
}

bool ReadProcessStartIdentity(HANDLE process, std::string *output) {
  if (process == nullptr || output == nullptr)
    return false;
  FILETIME created{}, exited{}, kernel{}, user{};
  const bool read =
      GetProcessTimes(process, &created, &exited, &kernel, &user) == TRUE;
  if (!read)
    return false;
  ULARGE_INTEGER ticks{};
  ticks.LowPart = created.dwLowDateTime;
  ticks.HighPart = created.dwHighDateTime;
  *output = std::to_string(ticks.QuadPart);
  return true;
}

bool ReadProcessStartIdentity(std::uint32_t pid, std::string *output) {
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (process == nullptr)
    return false;
  const bool read = ReadProcessStartIdentity(process, output);
  CloseHandle(process);
  return read;
}

bool WindowsSessionProcessMatches(const WindowsSession &session) {
  std::string process_start;
  return session.process_handle != nullptr &&
         GetProcessId(session.process_handle) == session.pid &&
         WaitForSingleObject(session.process_handle, 0) == WAIT_TIMEOUT &&
         ReadProcessStartIdentity(session.process_handle, &process_start) &&
         process_start == session.process_start;
}

struct WindowEnumerationContext {
  std::uint32_t pid = 0;
  std::string app_identity;
  std::string executable_digest;
  std::string process_start;
  std::string policy_language = "unknown";
  std::string maximum_mode = "observe_only";
  bool identity_matches = false;
  bool elevated = true;
  bool proxy = false;
  std::vector<std::string> candidates;
};

bool IsApplicationWindow(HWND window) {
  if (window == nullptr || GetWindow(window, GW_OWNER) != nullptr ||
      (GetWindowLongPtrW(window, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) != 0)
    return false;
  std::array<wchar_t, 64> class_name{};
  const int class_length = GetClassNameW(window, class_name.data(),
                                         static_cast<int>(class_name.size()));
  if (class_length <= 0 ||
      class_length >= static_cast<int>(class_name.size() - 1))
    return false;
  return _wcsicmp(class_name.data(), L"#32770") != 0;
}

bool ClientBoundsPhysical(HWND window, RECT *bounds) {
  RECT client{};
  POINT origin{};
  if (!GetClientRect(window, &client) || !ClientToScreen(window, &origin))
    return false;
  const LONG width = client.right - client.left;
  const LONG height = client.bottom - client.top;
  if (width <= 0 || height <= 0 || width > 32768 || height > 32768)
    return false;
  *bounds = {origin.x, origin.y, origin.x + width, origin.y + height};
  return true;
}

struct BoundWindowsDialog {
  HWND window = nullptr;
  HWND owner = nullptr;
  RECT bounds{};
  bool modal = false;
  std::string identity;
  std::wstring class_name;
};

struct WindowsDialogSetSnapshot {
  std::vector<BoundWindowsDialog> dialogs;
  std::string digest;
  HWND active_window = nullptr;
  RECT active_bounds{};
  std::string active_identity;
  std::string active_kind;
};

bool ReadWindowClass(HWND window, std::wstring *output) {
  if (window == nullptr || output == nullptr)
    return false;
  std::array<wchar_t, 256> class_name{};
  const int length = GetClassNameW(window, class_name.data(),
                                   static_cast<int>(class_name.size()));
  if (length <= 0 || length >= static_cast<int>(class_name.size() - 1))
    return false;
  output->assign(class_name.data(), static_cast<std::size_t>(length));
  return true;
}

bool IsOwnedByRootWindow(HWND window, HWND root, std::uint32_t pid,
                         HWND *direct_owner) {
  HWND current = window;
  HWND owner = nullptr;
  for (std::size_t depth = 0; depth < 16; ++depth) {
    owner = GetWindow(current, GW_OWNER);
    if (owner == nullptr)
      return false;
    if (depth == 0 && direct_owner != nullptr)
      *direct_owner = owner;
    DWORD owner_pid = 0;
    if (GetWindowThreadProcessId(owner, &owner_pid) == 0 || owner_pid != pid)
      return false;
    if (owner == root)
      return true;
    current = owner;
  }
  return false;
}

bool IsNativeTakeoverDialogClass(std::wstring_view class_name) {
  static constexpr std::array<std::wstring_view, 4> denied = {
      L"Credential Dialog Xaml Host", L"DirectUIHWND",
      L"ApplicationFrameWindow", L"Windows.UI.Core.CoreWindow"};
  for (const auto candidate : denied)
    if (_wcsicmp(std::wstring(class_name).c_str(), candidate.data()) == 0)
      return true;
  return false;
}

struct ShellDialogChildContext {
  bool found = false;
};

BOOL CALLBACK FindShellDialogChild(HWND window, LPARAM parameter) {
  auto *context = reinterpret_cast<ShellDialogChildContext *>(parameter);
  if (context == nullptr)
    return FALSE;
  std::wstring class_name;
  if (!ReadWindowClass(window, &class_name)) {
    context->found = true;
    return FALSE;
  }
  static constexpr std::array<std::wstring_view, 4> shell_classes = {
      L"SHELLDLL_DefView", L"DirectUIHWND", L"SysListView32",
      L"WorkerW"};
  for (const auto candidate : shell_classes) {
    if (_wcsicmp(class_name.c_str(), candidate.data()) == 0) {
      context->found = true;
      return FALSE;
    }
  }
  return TRUE;
}

bool IsNativeTakeoverDialog(HWND window, std::wstring_view class_name) {
  if (IsNativeTakeoverDialogClass(class_name))
    return true;
  if (_wcsicmp(std::wstring(class_name).c_str(), L"#32770") != 0)
    return false;
  ShellDialogChildContext child_context;
  EnumChildWindows(window, FindShellDialogChild,
                   reinterpret_cast<LPARAM>(&child_context));
  if (child_context.found)
    return true;
  std::array<wchar_t, 512> title{};
  const int length = GetWindowTextW(window, title.data(),
                                    static_cast<int>(title.size()));
  if (length < 0 || length >= static_cast<int>(title.size() - 1))
    return true;
  std::wstring normalized(title.data(), static_cast<std::size_t>(length));
  for (wchar_t &character : normalized)
    if (character >= L'A' && character <= L'Z')
      character = static_cast<wchar_t>(character + (L'a' - L'A'));
  static constexpr std::array<std::wstring_view, 13> denied_titles = {
      L"file picker", L"open file", L"save file", L"choose file",
      L"select file", L"select folder", L"administrator", L"security",
      L"credential", L"permission", L"installer", L"installation",
      L"user account control"};
  for (const auto term : denied_titles)
    if (normalized.find(term) != std::wstring::npos)
      return true;
  return false;
}

bool IsNativeTakeoverWindow(HWND window) {
  if (window == nullptr)
    return true;
  std::wstring class_name;
  if (!ReadWindowClass(window, &class_name) ||
      IsNativeTakeoverDialog(window, class_name))
    return true;
  DWORD pid = 0;
  std::wstring process_path;
  if (GetWindowThreadProcessId(window, &pid) == 0 || pid == 0 ||
      !ReadProcessPath(pid, &process_path))
    return true;
  const auto slash = process_path.find_last_of(L"\\/");
  const std::wstring leaf = slash == std::wstring::npos
                                ? process_path
                                : process_path.substr(slash + 1);
  static constexpr std::array<std::wstring_view, 7> denied_processes = {
      L"consent.exe", L"CredentialUIBroker.exe", L"SystemSettings.exe",
      L"msiexec.exe", L"setup.exe", L"install.exe", L"installer.exe"};
  for (const auto candidate : denied_processes)
    if (_wcsicmp(leaf.c_str(), candidate.data()) == 0)
      return true;
  return false;
}

struct DialogEnumerationContext {
  const WindowsSession *session = nullptr;
  std::vector<BoundWindowsDialog> dialogs;
  bool invalid = false;
  bool user_takeover = false;
};

BOOL CALLBACK CollectBoundWindowsDialog(HWND window, LPARAM parameter) {
  auto *context = reinterpret_cast<DialogEnumerationContext *>(parameter);
  if (context == nullptr || context->session == nullptr || context->invalid ||
      !IsWindowVisible(window) || window == context->session->window)
    return context != nullptr && !context->invalid ? TRUE : FALSE;
  DWORD pid = 0;
  if (GetWindowThreadProcessId(window, &pid) == 0 ||
      pid != context->session->pid)
    return TRUE;
  HWND owner = nullptr;
  if (!IsOwnedByRootWindow(window, context->session->window,
                           context->session->pid, &owner))
    return TRUE;
  BoundWindowsDialog dialog;
  dialog.window = window;
  dialog.owner = owner;
  dialog.modal = IsWindowEnabled(owner) == FALSE;
  if (!ClientBoundsPhysical(window, &dialog.bounds) ||
      !ReadWindowClass(window, &dialog.class_name)) {
    context->invalid = true;
    return FALSE;
  }
  if (IsNativeTakeoverDialog(window, dialog.class_name)) {
    context->user_takeover = true;
    return FALSE;
  }
  const auto window_value =
      static_cast<std::uint64_t>(reinterpret_cast<UINT_PTR>(window));
  const auto owner_value =
      static_cast<std::uint64_t>(reinterpret_cast<UINT_PTR>(owner));
  dialog.identity = Sha256String(
      "computer-dialog-identity-v1\n" + context->session->app_identity +
      "\n" + context->session->process_start + "\n" +
      std::to_string(window_value) + "\n" + std::to_string(owner_value));
  if (dialog.identity.size() != 64 || context->dialogs.size() >= 16) {
    context->invalid = true;
    return FALSE;
  }
  context->dialogs.push_back(std::move(dialog));
  return TRUE;
}

bool CaptureWindowsDialogInventory(const WindowsSession &session,
                                   WindowsDialogSetSnapshot *snapshot,
                                   std::string *reason) {
  if (snapshot == nullptr || reason == nullptr || !IsWindow(session.window)) {
    if (reason != nullptr)
      *reason = "session_identity_changed";
    return false;
  }
  DialogEnumerationContext context;
  context.session = &session;
  EnumWindows(CollectBoundWindowsDialog,
              reinterpret_cast<LPARAM>(&context));
  if (context.user_takeover) {
    *reason = "native_dialog_user_takeover";
    return false;
  }
  if (context.invalid) {
    *reason = "dialog_set_unavailable";
    return false;
  }
  std::sort(context.dialogs.begin(), context.dialogs.end(),
            [](const BoundWindowsDialog &left,
               const BoundWindowsDialog &right) {
              return left.identity < right.identity;
            });
  std::string material = "computer-dialog-set-v1\n" +
                         session.window_identity + "\n";
  for (const auto &dialog : context.dialogs) {
    const auto owner_value = static_cast<std::uint64_t>(
        reinterpret_cast<UINT_PTR>(dialog.owner));
    material += dialog.identity + ":" + std::to_string(owner_value) + ":" +
                (dialog.modal ? "modal" : "modeless") + ":" +
                std::to_string(dialog.bounds.left) + "," +
                std::to_string(dialog.bounds.top) + "," +
                std::to_string(dialog.bounds.right) + "," +
                std::to_string(dialog.bounds.bottom) + "\n";
  }
  WindowsDialogSetSnapshot result;
  result.dialogs = std::move(context.dialogs);
  result.digest = Sha256String(material);
  if (result.digest.size() != 64) {
    *reason = "dialog_set_unavailable";
    return false;
  }
  *snapshot = std::move(result);
  return true;
}

bool CaptureWindowsDialogSet(const WindowsSession &session,
                             WindowsDialogSetSnapshot *snapshot,
                             std::string *reason) {
  WindowsDialogSetSnapshot result;
  if (!CaptureWindowsDialogInventory(session, &result, reason))
    return false;
  const HWND foreground = GetForegroundWindow();
  if (foreground == session.window) {
    result.active_window = session.window;
    result.active_identity = session.window_identity;
    result.active_kind = "application";
  } else {
    const auto active = std::find_if(
        result.dialogs.begin(), result.dialogs.end(),
        [foreground](const BoundWindowsDialog &dialog) {
          return dialog.window == foreground;
        });
    if (active == result.dialogs.end()) {
      *reason = IsWindowEnabled(session.window) == FALSE ||
                        IsNativeTakeoverWindow(foreground)
                    ? "native_dialog_user_takeover"
                    : "focus_required";
      return false;
    }
    result.active_window = active->window;
    result.active_identity = active->identity;
    result.active_kind = "dialog";
  }
  if (!ClientBoundsPhysical(result.active_window, &result.active_bounds)) {
    *reason = "window_geometry_changed";
    return false;
  }
  *snapshot = std::move(result);
  return true;
}

bool ResolveWindowsSessionRefocusTarget(const WindowsSession &session,
                                        HWND *target,
                                        std::string *reason) {
  if (target == nullptr || reason == nullptr || !IsWindow(session.window)) {
    if (reason != nullptr)
      *reason = "session_refocus_stale";
    return false;
  }
  const HWND foreground = GetForegroundWindow();
  if (foreground == nullptr) {
    *reason = "native_dialog_user_takeover";
    return false;
  }
  if (foreground != session.window &&
      foreground != session.active_window &&
      IsNativeTakeoverWindow(foreground)) {
    *reason = "native_dialog_user_takeover";
    return false;
  }
  WindowsDialogSetSnapshot inventory;
  if (!CaptureWindowsDialogInventory(session, &inventory, reason))
    return false;
  if (session.dialog_set_digest.empty()) {
    if (session.dialog_set_revision != 0 || !inventory.dialogs.empty() ||
        session.active_window != session.window ||
        session.active_window_identity != session.window_identity ||
        session.active_window_kind != "application" ||
        IsWindowEnabled(session.window) != TRUE) {
      *reason = "session_refocus_stale";
      return false;
    }
    *target = session.window;
    return true;
  }
  if (session.dialog_set_revision == 0 ||
      inventory.digest != session.dialog_set_digest) {
    *reason = "session_refocus_stale";
    return false;
  }
  HWND expected = nullptr;
  if (session.active_window_kind == "application" &&
      session.active_window == session.window &&
      session.active_window_identity == session.window_identity &&
      IsWindowEnabled(session.window) == TRUE) {
    expected = session.window;
  } else if (session.active_window_kind == "dialog") {
    const auto dialog = std::find_if(
        inventory.dialogs.begin(), inventory.dialogs.end(),
        [&session](const BoundWindowsDialog &candidate) {
          return candidate.window == session.active_window &&
                 candidate.identity == session.active_window_identity;
        });
    if (dialog != inventory.dialogs.end() &&
        IsWindowEnabled(dialog->window) == TRUE)
      expected = dialog->window;
  }
  if (expected == nullptr) {
    *reason = IsWindowEnabled(session.window) == FALSE &&
                      session.active_window_kind != "dialog"
                  ? "native_dialog_user_takeover"
                  : "session_refocus_stale";
    return false;
  }
  *target = expected;
  return true;
}

bool ResolveWindowsExplicitResumeTarget(WindowsSession *session, HWND *target,
                                        std::string *reason) {
  if (session == nullptr || target == nullptr || reason == nullptr ||
      !IsWindow(session->window)) {
    if (reason != nullptr)
      *reason = "session_refocus_stale";
    return false;
  }
  const HWND foreground = GetForegroundWindow();
  if (foreground == nullptr) {
    *reason = "native_dialog_user_takeover";
    return false;
  }
  if (foreground != session->window && foreground != session->active_window &&
      IsNativeTakeoverWindow(foreground)) {
    *reason = "native_dialog_user_takeover";
    return false;
  }
  WindowsDialogSetSnapshot inventory;
  if (!CaptureWindowsDialogInventory(*session, &inventory, reason))
    return false;

  const auto find_dialog = [&inventory](HWND window) {
    return std::find_if(
        inventory.dialogs.begin(), inventory.dialogs.end(),
        [window](const BoundWindowsDialog &candidate) {
          return candidate.window == window &&
                 IsWindowEnabled(candidate.window) == TRUE;
        });
  };
  auto selected_dialog = inventory.dialogs.end();
  const HWND last_active = GetLastActivePopup(session->window);
  if (last_active != nullptr && last_active != session->window)
    selected_dialog = find_dialog(last_active);
  if (selected_dialog == inventory.dialogs.end() &&
      session->active_window_kind == "dialog")
    selected_dialog = find_dialog(session->active_window);

  HWND selected_window = nullptr;
  std::string selected_identity;
  std::string selected_kind;
  if (selected_dialog != inventory.dialogs.end()) {
    selected_window = selected_dialog->window;
    selected_identity = selected_dialog->identity;
    selected_kind = "dialog";
  } else if (IsWindowEnabled(session->window) == TRUE) {
    selected_window = session->window;
    selected_identity = session->window_identity;
    selected_kind = "application";
  } else {
    const auto modal = std::find_if(
        inventory.dialogs.begin(), inventory.dialogs.end(),
        [](const BoundWindowsDialog &candidate) {
          return candidate.modal && IsWindowEnabled(candidate.window) == TRUE;
        });
    if (modal != inventory.dialogs.end() &&
        std::find_if(std::next(modal), inventory.dialogs.end(),
                     [](const BoundWindowsDialog &candidate) {
                       return candidate.modal &&
                              IsWindowEnabled(candidate.window) == TRUE;
                     }) == inventory.dialogs.end()) {
      selected_window = modal->window;
      selected_identity = modal->identity;
      selected_kind = "dialog";
    }
  }
  if (selected_window == nullptr || selected_identity.size() != 64) {
    *reason = "native_dialog_user_takeover";
    return false;
  }
  const bool set_changed = inventory.digest != session->dialog_set_digest;
  if ((set_changed || session->dialog_set_revision == 0) &&
      session->dialog_set_revision ==
          std::numeric_limits<std::uint64_t>::max()) {
    *reason = "session_refocus_stale";
    return false;
  }
  if (set_changed || session->dialog_set_revision == 0)
    session->dialog_set_revision += 1;
  session->dialog_set_digest = inventory.digest;
  session->active_window = selected_window;
  session->active_window_identity = std::move(selected_identity);
  session->active_window_kind = std::move(selected_kind);
  InvalidateWindowsObservation(session);
  *target = selected_window;
  return true;
}

BOOL CALLBACK CollectTopLevelWindow(HWND window, LPARAM parameter) {
  auto *context = reinterpret_cast<WindowEnumerationContext *>(parameter);
  DWORD owner_pid = 0;
  if (context == nullptr || !IsWindowVisible(window) ||
      GetWindowThreadProcessId(window, &owner_pid) == 0 ||
      owner_pid != context->pid)
    return TRUE;
  RECT client{};
  if (!ClientBoundsPhysical(window, &client))
    return TRUE;
  const LONG client_width = client.right - client.left;
  const LONG client_height = client.bottom - client.top;
  RECT screen_bounds{};
  if (!ScreenBoundsPhysicalForWindow(window, &screen_bounds))
    return TRUE;
  std::vector<wchar_t> title(513, L'\0');
  const int title_length =
      GetWindowTextW(window, title.data(), static_cast<int>(title.size()));
  std::string title_utf8 = BoundedUtf8(
      title_length > 0
          ? Utf8FromWide(std::wstring_view(title.data(), title_length))
          : "Application window",
      256);
  if (title_utf8.empty())
    title_utf8 = "Application window";
  const auto handle_value =
      static_cast<std::uint64_t>(reinterpret_cast<UINT_PTR>(window));
  const HWND owner = GetWindow(window, GW_OWNER);
  DWORD owner_window_pid = 0;
  if (owner != nullptr)
    GetWindowThreadProcessId(owner, &owner_window_pid);
  const bool same_owner_dialog =
      owner != nullptr && owner_window_pid == context->pid;
  const bool modal = same_owner_dialog && IsWindowEnabled(owner) == FALSE;
  const bool eligible = context->identity_matches && !context->elevated &&
                        !context->proxy && !same_owner_dialog &&
                        IsApplicationWindow(window) &&
                        IsWindowEnabled(window) == TRUE;
  const std::string window_identity = Sha256String(
      "computer-window-identity-v1\n" + context->app_identity + "\n" +
      context->process_start + "\n" + std::to_string(handle_value));
  context->candidates.push_back(
      "{\"windowId\":\"" + std::to_string(handle_value) +
      "\",\"pid\":" + std::to_string(context->pid) + ",\"windowHandle\":\"" +
      std::to_string(handle_value) + "\",\"appIdentityDigest\":\"" +
      context->app_identity + "\",\"windowIdentityDigest\":\"" +
      window_identity + "\",\"title\":\"" + JsonEscape(title_utf8) +
      "\",\"executableDigest\":\"" + context->executable_digest +
      "\",\"bounds\":{" + "\"x\":" + std::to_string(client.left) +
      ",\"y\":" + std::to_string(client.top) +
      ",\"width\":" + std::to_string(client_width) +
      ",\"height\":" + std::to_string(client_height) +
      "},\"screenBounds\":" + RectJson(screen_bounds) +
      ",\"boundsUnit\":\"physical_px\",\"focused\":" +
      (GetForegroundWindow() == window ? "true" : "false") +
      ",\"eligible\":" + (eligible ? "true" : "false") + ",\"ownerKind\":\"" +
      (same_owner_dialog ? "dialog" : "application") +
      "\",\"modal\":" + (modal ? "true" : "false") +
      ",\"policyLanguage\":\"" + context->policy_language +
      "\",\"maximumMode\":\"" + context->maximum_mode +
      "\",\"revision\":1}");
  return context->candidates.size() < 64 ? TRUE : FALSE;
}

bool IsKnownProxyExecutable(const std::wstring &path) {
  const auto slash = path.find_last_of(L"\\/");
  const std::wstring leaf =
      slash == std::wstring::npos ? path : path.substr(slash + 1);
  return _wcsicmp(leaf.c_str(), L"ApplicationFrameHost.exe") == 0 ||
         _wcsicmp(leaf.c_str(), L"WWAHost.exe") == 0;
}

bool IsAcceptanceFixtureExecutable(const std::wstring &path) {
  const auto slash = path.find_last_of(L"\\/");
  const std::wstring leaf =
      slash == std::wstring::npos ? path : path.substr(slash + 1);
  return _wcsicmp(leaf.c_str(),
                  L"sprint-coder-computer-use-fixture.exe") == 0;
}

bool IsDisallowedTargetExecutable(const std::wstring &path) {
  const auto slash = path.find_last_of(L"\\/");
  const std::wstring leaf =
      slash == std::wstring::npos ? path : path.substr(slash + 1);
  static constexpr std::array<std::wstring_view, 28> blocked = {
      L"mstsc.exe",
      L"msrdc.exe",
      L"SystemSettings.exe",
      L"control.exe",
      L"msiexec.exe",
      L"setup.exe",
      L"install.exe",
      L"installer.exe",
      L"powershell.exe",
      L"pwsh.exe",
      L"cmd.exe",
      L"wt.exe",
      L"WindowsTerminal.exe",
      L"wsl.exe",
      L"bash.exe",
      L"cscript.exe",
      L"wscript.exe",
      L"regedit.exe",
      L"mmc.exe",
      L"explorer.exe",
      L"taskmgr.exe",
      L"msrdcw.exe",
      L"RdClient.Windows.exe",
      L"QuickAssist.exe",
      L"TeamViewer.exe",
      L"AnyDesk.exe",
      L"RustDesk.exe",
      L"parsec.exe",
  };
  for (const auto candidate : blocked)
    if (_wcsicmp(leaf.c_str(), candidate.data()) == 0)
      return true;
  return false;
}

bool EnumerateWindowsForExecutable(const std::wstring &canonical_path,
                                   std::string_view expected_identity,
                                   std::string_view expected_executable_digest,
                                   std::string_view expected_signer_digest,
                                   std::vector<std::string> *candidates) {
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE)
    return false;
  PROCESSENTRY32W entry{};
  entry.dwSize = sizeof(entry);
  if (Process32FirstW(snapshot, &entry)) {
    do {
      if (entry.th32ProcessID == 0)
        continue;
      LockedWindowsExecutable process_executable;
      if (!OpenLockedProcessExecutable(entry.th32ProcessID,
                                       &process_executable))
        continue;
      const bool exact_process_identity =
          SameWindowsPath(process_executable.identity.path, canonical_path) &&
          WindowsExecutableIdentityMatches(
              process_executable.identity, expected_identity,
              expected_executable_digest, expected_signer_digest);
      if (!exact_process_identity) {
        CloseLockedWindowsExecutable(&process_executable);
        continue;
      }
      WindowEnumerationContext context;
      context.pid = entry.th32ProcessID;
      context.app_identity = std::string(expected_identity);
      context.executable_digest =
          process_executable.identity.executable_digest;
      context.policy_language = process_executable.identity.policy_language;
      context.maximum_mode =
          MaximumModeForWindowsExecutable(process_executable.identity);
      context.identity_matches = exact_process_identity;
      context.elevated = IsProcessElevated(entry.th32ProcessID);
      context.proxy = IsKnownProxyExecutable(process_executable.identity.path) ||
                      IsDisallowedTargetExecutable(
                          process_executable.identity.path);
      if (!ReadProcessStartIdentity(entry.th32ProcessID,
                                    &context.process_start))
        context.identity_matches = false;
      EnumWindows(CollectTopLevelWindow, reinterpret_cast<LPARAM>(&context));
      CloseLockedWindowsExecutable(&process_executable);
      candidates->insert(candidates->end(), context.candidates.begin(),
                         context.candidates.end());
    } while (candidates->size() < 64 && Process32NextW(snapshot, &entry));
  }
  CloseHandle(snapshot);
  return true;
}

bool LaunchVerifiedExecutable(const LockedWindowsExecutable &locked,
                              HANDLE *process) {
  if (locked.file == INVALID_HANDLE_VALUE || process == nullptr)
    return false;
  const std::wstring &canonical_path = locked.identity.path;
  const auto separator = canonical_path.find_last_of(L"\\/");
  const std::wstring working_directory =
      separator == std::wstring::npos ? std::wstring{}
                                      : canonical_path.substr(0, separator);
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION information{};
  if (!CreateProcessW(
          canonical_path.c_str(), nullptr, nullptr, nullptr, FALSE,
          CREATE_UNICODE_ENVIRONMENT, nullptr,
          working_directory.empty() ? nullptr : working_directory.c_str(),
          &startup, &information)) {
    return false;
  }
  CloseHandle(information.hThread);
  LockedWindowsExecutable launched_image;
  const bool image_matches =
      OpenLockedProcessExecutable(information.hProcess, &launched_image) &&
      SameWindowsPath(launched_image.identity.path, locked.identity.path) &&
      SameWindowsFileIdentity(launched_image.identity.file_identity,
                              locked.identity.file_identity) &&
      launched_image.identity.identity_digest == locked.identity.identity_digest &&
      launched_image.identity.executable_digest ==
          locked.identity.executable_digest &&
      launched_image.identity.signer_digest == locked.identity.signer_digest;
  CloseLockedWindowsExecutable(&launched_image);
  if (!image_matches) {
    TerminateProcess(information.hProcess, ERROR_INVALID_IMAGE_HASH);
    CloseHandle(information.hProcess);
    return false;
  }
  *process = information.hProcess;
  return true;
}

bool ListWindowsForIdentity(const std::string &metadata, std::string *response,
                            std::string *reason) {
  std::string canonical_path_utf8;
  std::string expected_identity;
  std::string expected_executable_digest;
  std::string expected_signer_digest;
  if (!ReadJsonString(metadata, "canonicalPath", &canonical_path_utf8) ||
      !ReadJsonString(metadata, "identityDigest", &expected_identity) ||
      !ReadJsonString(metadata, "executableDigest",
                      &expected_executable_digest) ||
      expected_identity.size() != 64 ||
      expected_executable_digest.size() != 64) {
    *reason = "profile_identity_invalid";
    return false;
  }
  ReadJsonString(metadata, "signerDigest", &expected_signer_digest);
  const int path_length = MultiByteToWideChar(
      CP_UTF8, MB_ERR_INVALID_CHARS, canonical_path_utf8.data(),
      static_cast<int>(canonical_path_utf8.size()), nullptr, 0);
  if (path_length <= 0) {
    *reason = "profile_identity_invalid";
    return false;
  }
  std::wstring canonical_path(static_cast<std::size_t>(path_length), L'\0');
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
                          canonical_path_utf8.data(),
                          static_cast<int>(canonical_path_utf8.size()),
                          canonical_path.data(), path_length) != path_length) {
    *reason = "profile_identity_invalid";
    return false;
  }
  LockedWindowsExecutable current_executable;
  const bool identity_read =
      OpenLockedWindowsExecutable(canonical_path, &current_executable);
  const bool same_canonical_path =
      identity_read &&
      SameWindowsPath(current_executable.identity.path, canonical_path);
  // Authenticode identity is stable across a same-path, same-signer app update.
  // Unsigned registrations remain bound to the exact bytes because they have no
  // independent signing authority that can authenticate replacement bytes.
  const bool signed_identity_update =
      same_canonical_path && !expected_signer_digest.empty() &&
      current_executable.identity.signer_digest == expected_signer_digest &&
      current_executable.identity.identity_digest == expected_identity;
  const bool unsigned_identity_match =
      same_canonical_path && expected_signer_digest.empty() &&
      current_executable.identity.signer_digest.empty() &&
      current_executable.identity.identity_digest == expected_identity &&
      current_executable.identity.executable_digest ==
          expected_executable_digest;
  const bool identity_matches =
      signed_identity_update || unsigned_identity_match;
  if (!identity_matches) {
    CloseLockedWindowsExecutable(&current_executable);
    *reason = "app_identity_changed";
    return false;
  }
  if (identity_matches &&
      !IsSupportedWindowsV1Target(current_executable.identity)) {
    CloseLockedWindowsExecutable(&current_executable);
    *reason = "target_application_unsupported";
    return false;
  }

  std::vector<std::string> candidates;
  if (identity_matches &&
      !EnumerateWindowsForExecutable(
          current_executable.identity.path, expected_identity,
          current_executable.identity.executable_digest,
          expected_signer_digest, &candidates)) {
    CloseLockedWindowsExecutable(&current_executable);
    *reason = "process_enumeration_unavailable";
    return false;
  }
  if (candidates.empty() && identity_matches &&
      !IsDisallowedTargetExecutable(current_executable.identity.path)) {
    HANDLE launched_process = nullptr;
    if (LaunchVerifiedExecutable(current_executable, &launched_process)) {
      WaitForInputIdle(launched_process, 5'000);
      for (std::size_t attempt = 0; attempt < 20 && candidates.empty();
           ++attempt) {
        if (!EnumerateWindowsForExecutable(
                current_executable.identity.path, expected_identity,
                current_executable.identity.executable_digest,
                expected_signer_digest,
                &candidates)) {
          CloseHandle(launched_process);
          CloseLockedWindowsExecutable(&current_executable);
          *reason = "process_enumeration_unavailable";
          return false;
        }
        if (candidates.empty() &&
            WaitForSingleObject(launched_process, 250) != WAIT_TIMEOUT)
          break;
      }
      CloseHandle(launched_process);
    }
  }
  CloseLockedWindowsExecutable(&current_executable);
  *response = "[";
  for (std::size_t index = 0; index < candidates.size(); ++index) {
    if (index != 0)
      *response += ',';
    *response += candidates[index];
  }
  *response += ']';
  return true;
}

std::string FrameIdKey(const sprint_coder::computer_use::FrameId &id) {
  return std::string(reinterpret_cast<const char *>(id.bytes.data()),
                     id.bytes.size());
}

bool StartWindowsSession(const Frame &request, const std::string &metadata,
                         std::string *response, std::string *reason) {
  std::uint64_t pid_value = 0;
  std::uint64_t window_value = 0;
  std::uint64_t cancel_epoch = 0;
  std::string session_id;
  std::string app_identity;
  std::string expected_window_identity;
  std::string canonical_path_utf8;
  std::string expected_executable_digest;
  std::string expected_signer_digest;
  double expected_bounds_x = 0;
  double expected_bounds_y = 0;
  double expected_bounds_width = 0;
  double expected_bounds_height = 0;
  bool explicit_resume = false;
  if (!ReadJsonUint64(metadata, "pid", &pid_value) || pid_value == 0 ||
      pid_value > std::numeric_limits<DWORD>::max() ||
      !ReadJsonUint64(metadata, "windowId", &window_value) ||
      window_value == 0 ||
      window_value > std::numeric_limits<UINT_PTR>::max() ||
      !ReadJsonUint64(metadata, "cancelEpoch", &cancel_epoch) ||
      !ReadJsonString(metadata, "sessionId", &session_id) ||
      !ReadJsonString(metadata, "appIdentityDigest", &app_identity) ||
      !ReadJsonString(metadata, "windowIdentityDigest",
                      &expected_window_identity) ||
      !ReadJsonString(metadata, "canonicalPath", &canonical_path_utf8) ||
      !ReadJsonString(metadata, "executableDigest",
                      &expected_executable_digest) ||
      !ReadJsonDouble(metadata, "expectedBoundsX", &expected_bounds_x) ||
      !ReadJsonDouble(metadata, "expectedBoundsY", &expected_bounds_y) ||
      !ReadJsonDouble(metadata, "expectedBoundsWidth",
                      &expected_bounds_width) ||
      !ReadJsonDouble(metadata, "expectedBoundsHeight",
                      &expected_bounds_height) ||
      !ReadOptionalJsonBoolean(metadata, "resume", &explicit_resume) ||
      expected_bounds_width <= 0 || expected_bounds_height <= 0) {
    *reason = "session_input_invalid";
    return false;
  }
  ReadJsonString(metadata, "signerDigest", &expected_signer_digest);
  const int path_length = MultiByteToWideChar(
      CP_UTF8, MB_ERR_INVALID_CHARS, canonical_path_utf8.data(),
      static_cast<int>(canonical_path_utf8.size()), nullptr, 0);
  if (path_length <= 0) {
    *reason = "session_identity_invalid";
    return false;
  }
  std::wstring canonical_path(static_cast<std::size_t>(path_length), L'\0');
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
                          canonical_path_utf8.data(),
                          static_cast<int>(canonical_path_utf8.size()),
                          canonical_path.data(), path_length) != path_length) {
    *reason = "session_identity_invalid";
    return false;
  }
  const auto pid = static_cast<std::uint32_t>(pid_value);
  const HWND window =
      reinterpret_cast<HWND>(static_cast<UINT_PTR>(window_value));
  ScopedKernelHandle target_process(OpenProcess(
      PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid));
  LockedWindowsExecutable process_executable;
  std::string process_start;
  RECT bounds{};
  if (target_process.value == nullptr ||
      !OpenLockedProcessExecutable(target_process.value,
                                   &process_executable) ||
      !SameWindowsPath(process_executable.identity.path, canonical_path) ||
      !WindowsExecutableIdentityMatches(
          process_executable.identity, app_identity,
          expected_executable_digest, expected_signer_digest) ||
      !IsSupportedWindowsV1Target(process_executable.identity) ||
      (IsKnownProxyExecutable(process_executable.identity.path) ||
       IsDisallowedTargetExecutable(process_executable.identity.path)) ||
      IsProcessElevated(pid) ||
      !ReadProcessStartIdentity(target_process.value, &process_start) ||
      WaitForSingleObject(target_process.value, 0) != WAIT_TIMEOUT ||
      !IsWindow(window) || !IsApplicationWindow(window)) {
    *reason = "session_target_rejected";
    return false;
  }
  const std::string maximum_mode =
      MaximumModeForWindowsExecutable(process_executable.identity);
  const std::string actual_window_identity =
      Sha256String("computer-window-identity-v1\n" + app_identity + "\n" +
                   process_start + "\n" + std::to_string(window_value));
  if (actual_window_identity != expected_window_identity) {
    *reason = "window_identity_changed";
    return false;
  }
  const std::string session_key = FrameIdKey(request.header.session_id);
  // Any attempt to (re)start the session, successful or not, voids a ticket from before it.
  InvalidateWindowsTicket(session_key);
  if (!sessions.empty() && !sessions.contains(session_key)) {
    *reason = "session_limit";
    return false;
  }
  const auto active_before_focus = sessions.find(session_key);
  const auto input_api_attempts = active_before_focus == sessions.end()
      ? std::make_shared<std::atomic<std::uint64_t>>(0)
      : active_before_focus->second.input_api_attempts;
  if (active_before_focus != sessions.end() &&
      (active_before_focus->second.session_id != session_id ||
       active_before_focus->second.pid != pid ||
       active_before_focus->second.window != window ||
       active_before_focus->second.app_identity != app_identity ||
       active_before_focus->second.window_identity != actual_window_identity ||
       active_before_focus->second.process_start != process_start ||
       !WindowsSessionProcessMatches(active_before_focus->second) ||
       !WindowsSessionExecutableMatches(active_before_focus->second,
                                        process_executable))) {
    *reason = "session_refocus_stale";
    return false;
  }
  const auto start_not_canceled = [&]() {
    if (parent_process_dead.load(std::memory_order_acquire))
      return false;
    const std::uint64_t current =
        cancellation_epoch.load(std::memory_order_acquire);
    const auto active = sessions.find(session_key);
    if (active != sessions.end())
      return active->second.cancel_epoch == cancel_epoch &&
             current == cancel_epoch;
    return current <= last_closed_cancel_epoch || cancel_epoch >= current;
  };
  RECT physical_client{};
  if (!ClientBoundsPhysical(window, &physical_client) ||
      std::abs(static_cast<double>(physical_client.left) - expected_bounds_x) >
          1.0 ||
      std::abs(static_cast<double>(physical_client.top) - expected_bounds_y) >
          1.0 ||
      std::abs(
          static_cast<double>(physical_client.right - physical_client.left) -
          expected_bounds_width) > 1.0 ||
      std::abs(
          static_cast<double>(physical_client.bottom - physical_client.top) -
          expected_bounds_height) > 1.0) {
    *reason = "window_geometry_changed";
    return false;
  }
  if (!start_not_canceled()) {
    *reason = "session_start_canceled";
    return false;
  }
  HWND refocus_window = window;
  if (active_before_focus == sessions.end()) {
    if (explicit_resume) {
      *reason = "session_input_invalid";
      return false;
    }
    const HWND foreground = GetForegroundWindow();
    if (IsWindowEnabled(window) != TRUE || foreground == nullptr ||
        (foreground != window && IsNativeTakeoverWindow(foreground))) {
      *reason = "native_dialog_user_takeover";
      return false;
    }
  } else if (explicit_resume) {
    if (!ResolveWindowsExplicitResumeTarget(
            &active_before_focus->second, &refocus_window, reason))
      return false;
  } else if (!ResolveWindowsSessionRefocusTarget(
                 active_before_focus->second, &refocus_window, reason)) {
    return false;
  }
  if (!start_not_canceled()) {
    *reason = "session_start_canceled";
    return false;
  }
  if (GetForegroundWindow() != refocus_window) {
    if (IsIconic(window)) {
      input_api_attempts->fetch_add(1, std::memory_order_acq_rel);
      ShowWindow(window, SW_RESTORE);
    }
    if (refocus_window != window && IsIconic(refocus_window)) {
      input_api_attempts->fetch_add(1, std::memory_order_acq_rel);
      ShowWindow(refocus_window, SW_RESTORE);
    }
    input_api_attempts->fetch_add(1, std::memory_order_acq_rel);
    SetForegroundWindow(refocus_window);
  }
  if (!TargetWindowFacts(pid, refocus_window, &bounds)) {
    *reason = "focus_required";
    return false;
  }
  RECT screen_bounds{};
  if (!ScreenBoundsPhysicalForWindow(refocus_window, &screen_bounds)) {
    *reason = "screen_geometry_unavailable";
    return false;
  }
  if (active_before_focus != sessions.end()) {
    WindowsDialogSetSnapshot refocused_dialogs;
    if (!CaptureWindowsDialogSet(active_before_focus->second,
                                 &refocused_dialogs, reason))
      return false;
    if (refocused_dialogs.digest !=
            active_before_focus->second.dialog_set_digest ||
        refocused_dialogs.active_window !=
            active_before_focus->second.active_window ||
        refocused_dialogs.active_identity !=
            active_before_focus->second.active_window_identity ||
        refocused_dialogs.active_kind !=
            active_before_focus->second.active_window_kind) {
      *reason = "session_refocus_stale";
      return false;
    }
  }
  if (!start_not_canceled()) {
    *reason = "session_start_canceled";
    return false;
  }
  std::uint64_t effective_cancel_epoch =
      cancellation_epoch.load(std::memory_order_acquire);
  const auto existing = sessions.find(session_key);
  if (existing != sessions.end()) {
    if (existing->second.session_id != session_id ||
        existing->second.pid != pid || existing->second.window != window ||
        existing->second.app_identity != app_identity ||
        existing->second.window_identity != actual_window_identity ||
        existing->second.maximum_mode != maximum_mode ||
        existing->second.process_start != process_start ||
        !WindowsSessionProcessMatches(existing->second) ||
        existing->second.cancel_epoch != cancel_epoch ||
        effective_cancel_epoch != cancel_epoch ||
        !WindowsSessionExecutableMatches(existing->second,
                                         process_executable)) {
      *reason = "session_refocus_stale";
      return false;
    }
  } else if (effective_cancel_epoch > last_closed_cancel_epoch &&
             cancel_epoch < effective_cancel_epoch) {
    *reason = "session_start_canceled";
    return false;
  } else if (cancel_epoch > effective_cancel_epoch) {
    std::uint64_t current = effective_cancel_epoch;
    while (cancel_epoch > current &&
           !cancellation_epoch.compare_exchange_weak(
               current, cancel_epoch, std::memory_order_acq_rel,
               std::memory_order_acquire)) {
    }
    effective_cancel_epoch = cancellation_epoch.load(std::memory_order_acquire);
  }
  if (existing == sessions.end()) {
    WindowsSession session;
    session.input_api_attempts = input_api_attempts;
    session.session_id = session_id;
    session.pid = pid;
    session.window = window;
    session.active_window = window;
    session.app_identity = app_identity;
    session.window_identity = actual_window_identity;
    session.active_window_identity = actual_window_identity;
    session.active_window_kind = "application";
    session.process_start = process_start;
    session.canonical_path = process_executable.identity.path;
    session.process_handle = target_process.release();
    session.executable_file = process_executable.file;
    process_executable.file = INVALID_HANDLE_VALUE;
    session.executable_volume_serial =
        process_executable.identity.file_identity.volume_serial;
    session.executable_file_id =
        process_executable.identity.file_identity.file_id;
    session.executable_digest =
        process_executable.identity.executable_digest;
    session.signer_digest = process_executable.identity.signer_digest;
    session.policy_language = process_executable.identity.policy_language;
    session.maximum_mode = maximum_mode;
    session.cancel_epoch = effective_cancel_epoch;
    sessions.emplace(session_key, std::move(session));
  }
  // A start or a resume begins a new measurement; any ticket from before it is void.
  InvalidateWindowsTicket(session_key);
  std::uint64_t profile_revision = 0;
  ReadJsonUint64(metadata, "profileRevision", &profile_revision);
  *response = "{\"sessionId\":\"" + JsonEscape(session_id) +
              "\",\"platform\":\"win32\",\"appIdentityDigest\":\"" +
              app_identity + "\",\"windowIdentityDigest\":\"" +
              actual_window_identity + "\",\"windowId\":\"" +
              std::to_string(window_value) +
              "\",\"policyLanguage\":\"" +
              process_executable.identity.policy_language +
              "\",\"maximumMode\":\"" + maximum_mode +
              "\",\"screenBounds\":" + RectJson(screen_bounds) +
              ",\"profileRevision\":" + std::to_string(profile_revision) +
              ",\"cancelEpoch\":" + std::to_string(effective_cancel_epoch) +
              ",\"inputAttemptCount\":" + std::to_string(input_api_attempts->load(std::memory_order_acquire)) +
              ",\"pid\":" + std::to_string(pid) + ",\"windowHandle\":\"" +
              std::to_string(window_value) + "\"}";
  return true;
}

bool CloseWindowsSession(const Frame &request, const std::string& metadata, std::string *response) {
  const std::string session_key = FrameIdKey(request.header.session_id);
  std::uint64_t requested_epoch = 0;
  if (!ReadJsonUint64(metadata, "cancelEpoch", &requested_epoch)) return false;
  const auto found = sessions.find(session_key);
  ClosedWindowsSessionRecord receipt;
  if (found == sessions.end()) {
    // The first close already released the session, so only the record of a close that produced a
    // drained response can answer this one. Main keeps the host quarantined until it sees a
    // confirmed close receipt and answers an unconfirmed close by re-sending it for the same
    // session id with a higher epoch.
    const auto closed = closed_sessions.find(session_key);
    if (closed == closed_sessions.end() || requested_epoch <= closed->second.cancel_epoch)
      return false;
    closed->second.cancel_epoch = requested_epoch;
    receipt = closed->second;
  } else {
    if (requested_epoch <= found->second.cancel_epoch) return false;
    found->second.cancel_epoch = requested_epoch;
    auto current = cancellation_epoch.load(std::memory_order_acquire);
    while (requested_epoch > current && !cancellation_epoch.compare_exchange_weak(
        current, requested_epoch, std::memory_order_acq_rel, std::memory_order_acquire)) {}
    receipt = ClosedWindowsSessionRecord{
        found->second.session_id, requested_epoch,
        found->second.input_api_attempts->load(std::memory_order_acquire)};
    last_closed_cancel_epoch =
        std::max(last_closed_cancel_epoch, found->second.cancel_epoch);
    RememberClosedWindowsSession(session_key, receipt);
    ReleaseWindowsSessionResources(&found->second);
    ForgetWindowsTicket(session_key);
    sessions.erase(found);
  }
  *response = "{\"result\":\"closed\",\"drained\":true,\"sessionId\":\"" +
      JsonEscape(receipt.session_id) + "\",\"cancelEpoch\":" + std::to_string(receipt.cancel_epoch) +
      ",\"inputAttemptCount\":" + std::to_string(receipt.input_api_attempts) + "}";
  return true;
}

bool ValidateWindowsSession(
    const WindowsSession &session, RECT *bounds, std::string *reason,
    WindowsDialogSetSnapshot *dialog_snapshot = nullptr) {
  std::string current_start;
  std::wstring current_path;
  WindowsFileIdentity held_file_identity;
  DWORD owner_pid = 0;
  if (!WindowsSessionProcessMatches(session) ||
      !ReadProcessStartIdentity(session.process_handle, &current_start) ||
      current_start != session.process_start ||
      !ReadProcessPath(session.process_handle, &current_path) ||
      !SameWindowsPath(current_path, session.canonical_path) ||
      !ReadWindowsFileIdentity(session.executable_file,
                               &held_file_identity) ||
      held_file_identity.volume_serial != session.executable_volume_serial ||
      std::memcmp(held_file_identity.file_id.Identifier,
                  session.executable_file_id.Identifier,
                  sizeof(held_file_identity.file_id.Identifier)) != 0 ||
      !IsWindow(session.window) || !IsApplicationWindow(session.window) ||
      GetWindowThreadProcessId(session.window, &owner_pid) == 0 ||
      owner_pid != session.pid) {
    *reason = "session_identity_changed";
    return false;
  }
  if (IsProcessElevated(session.pid)) {
    *reason = "elevated_target_blocked";
    return false;
  }
  WindowsDialogSetSnapshot current_dialogs;
  if (!CaptureWindowsDialogSet(session, &current_dialogs, reason))
    return false;
  *bounds = current_dialogs.active_bounds;
  if (dialog_snapshot != nullptr)
    *dialog_snapshot = std::move(current_dialogs);
  return true;
}

bool ReadExact(HANDLE pipe, void *destination, std::size_t bytes) {
  auto *output = static_cast<std::uint8_t *>(destination);
  std::size_t offset = 0;
  while (offset < bytes) {
    const DWORD request =
        static_cast<DWORD>(std::min<std::size_t>(bytes - offset, 1u << 20));
    ScopedKernelHandle event(CreateEventW(nullptr, TRUE, FALSE, nullptr));
    if (event.value == nullptr)
      return false;
    OVERLAPPED operation{};
    operation.hEvent = event.value;
    DWORD read = 0;
    const BOOL started =
        ReadFile(pipe, output + offset, request, nullptr, &operation);
    if ((!started && GetLastError() != ERROR_IO_PENDING) ||
        !GetOverlappedResult(pipe, &operation, &read, TRUE) || read == 0)
      return false;
    offset += read;
  }
  return true;
}

bool WriteExact(HANDLE pipe, const void *source, std::size_t bytes) {
  const auto *input = static_cast<const std::uint8_t *>(source);
  std::size_t offset = 0;
  while (offset < bytes) {
    const DWORD request =
        static_cast<DWORD>(std::min<std::size_t>(bytes - offset, 1u << 20));
    ScopedKernelHandle event(CreateEventW(nullptr, TRUE, FALSE, nullptr));
    if (event.value == nullptr)
      return false;
    OVERLAPPED operation{};
    operation.hEvent = event.value;
    DWORD written = 0;
    const BOOL started =
        WriteFile(pipe, input + offset, request, nullptr, &operation);
    if ((!started && GetLastError() != ERROR_IO_PENDING) ||
        !GetOverlappedResult(pipe, &operation, &written, TRUE) || written == 0)
      return false;
    offset += written;
  }
  return true;
}

bool ReadFrame(HANDLE pipe, Frame *output) {
  FrameHeader header{};
  if (!ReadExact(pipe, &header, sizeof(header)))
    return false;
  if (!sprint_coder::computer_use::ValidateHeader(header))
    return false;
  std::vector<std::uint8_t> encoded(sizeof(header) + header.metadata_bytes +
                                    header.binary_bytes);
  std::memcpy(encoded.data(), &header, sizeof(header));
  if (header.metadata_bytes + header.binary_bytes > 0 &&
      !ReadExact(pipe, encoded.data() + sizeof(header),
                 header.metadata_bytes + header.binary_bytes))
    return false;
  const auto decoded = DecodeFrame(encoded);
  if (!decoded.has_value())
    return false;
  *output = *decoded;
  return true;
}

bool WriteFrame(HANDLE pipe, FrameHeader header, std::string_view metadata,
                std::span<const std::uint8_t> binary = {}) {
  const auto *bytes = reinterpret_cast<const std::uint8_t *>(metadata.data());
  const auto encoded = EncodeFrame(
      header, std::span<const std::uint8_t>(bytes, metadata.size()), binary);
  return !encoded.empty() && WriteExact(pipe, encoded.data(), encoded.size());
}

std::uint32_t WindowsBuildNumber() {
  // RtlGetVersion is deliberately resolved at runtime because VersionHelpers
  // uses the app manifest and may report a compatibility shim value.  A
  // missing/invalid result is unsafe.
  using RtlGetVersionFn = LONG(WINAPI *)(PRTL_OSVERSIONINFOW);
  const HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  if (ntdll == nullptr)
    return 0;
  const auto query =
      reinterpret_cast<RtlGetVersionFn>(GetProcAddress(ntdll, "RtlGetVersion"));
  if (query == nullptr)
    return 0;
  RTL_OSVERSIONINFOW version{};
  version.dwOSVersionInfoSize = sizeof(version);
  if (query(&version) != 0)
    return 0;
  return version.dwBuildNumber;
}

// The bounds on the UI Automation calls of the V1 lane (observe, the point / focus classification, the
// control bindings, the semantic target search, the focused-element signature that the re-validation
// uses). Without them a target that does not answer holds the serial lane for good, and every later
// frame (observe, preflight, dispatch, Cancel) waits behind it (#820). Three rules:
//
//  1. ONE call is bounded. The CONNECTION timeout (500 ms) bounds the first contact with a target and
//     the TRANSACTION timeout (300 ms) a call on an element already connected (measured on a window that
//     does not answer: 311 ms for 300 and 2001 ms for 2000; the connection timeout is the one that
//     governs a first contact). 500 ms leaves a cold app time to load its providers on the first call (a
//     call that still times out is reported as accessibility_timeout, a failure that a new observe does
//     not repeat once the providers are loaded). A call that waits for the connection and then for the
//     transaction is bounded by BOTH: the worst case of one call is counted as 500 + 300 = 800 ms
//     (whether the two waits can really follow each other is not established; the sum is the safe
//     side), inside the 1 s of the Cancel acknowledgment (COMPUTER_USE_NATIVE_CANCEL_ACK_TIMEOUT_MS).
//     The margin is SMALL: 1000 - 800 = about 200 ms for everything else the lane does between the
//     epoch moving and the acknowledgment (the pipe, the frame, the answer). Measured on CI: a
//     transaction-bound call is cut after 310-320 ms, a first contact after 505-514 ms. The sum of
//     these two measurements, taken one at a time, is about 830 ms (the chain itself was not measured;
//     800 ms is the nominal value, not a measured upper bound), which leaves about 170 ms for the pipe,
//     the frame and the acknowledgment together; under load it can be less (not verified).
//  2. The FIRST timed-out call (UIA_E_TIMEOUT or an equivalent failure) ends its path for good: no
//     UI Automation call after it, fail closed, the "unreadable" of the caller. A target that answers
//     the first contact and then stops therefore costs one timeout, not one per remaining call.
//  3. A CANCEL ends the path too, and it is asked before EVERY call (WindowsV1UiaCall, and the entry of
//     every read of properties): the epoch is the one that was current when the path began (observe:
//     the session's own). So a Cancel that arrives while the lane reads a slow but live app waits for
//     at most the call that is under way: one call, 800 ms at the worst, never the whole path.
//  There is deliberately NO time budget on a path: a deep tree of a live app (an Electron or Office
//  window read up the parents, one call each) can take a long time while every call answers, and
//  cutting it short would turn a live app into "unclassified" and change what V1 answers. A Cancel needs
//  no budget either (rule 3). The one budget is the whole observe (25 s), and it is there only so that
//  the native answers with its own reason (observation_timeout, with the number of nodes it had read
//  logged) before the 30 s Main gives an observe runs out; it is wide because a tree of several thousand
//  nodes of an ordinary app is read four times (two readings, two binding captures) and must not fail.
//  4. A call that "succeeds" only after (nearly) the whole timeout has not answered either: some
//  systems return a default value for a property when the provider times out (measured on a CI runner:
//  five property reads of a native provider that does not answer took 1.5 s and all succeeded, with
//  empty values). So the time of each call is measured, and a call that took within 30 ms of its
//  timeout is a timed-out call (WindowsV1UiaTimed), whatever the HRESULT says.
// A failed (timed out, canceled, over the observe budget) read is exactly the "unreadable" of each
// caller (stale target, rejected action, or an observation that is not produced): the meaning of V1's
// answers is not changed.
constexpr DWORD kWindowsV1UiaConnectionTimeoutMs = 500;
constexpr DWORD kWindowsV1UiaTransactionTimeoutMs = 300;
constexpr std::chrono::milliseconds kWindowsV1UiaObserveBudget{25'000};

// The ONE place the V1 lane creates UI Automation. The bounded one when the system has it
// (CreateBoundedAutomation); if IUIAutomation2 cannot be had it falls back to the plain one, as before
// this bound existed (no timeout), and counts it, so that the missing bound is visible and not silent.
std::atomic<long> windows_v1_uia_unbounded_creations{0};
HRESULT CreateWindowsV1Automation(IUIAutomation **automation) {
  *automation = nullptr;
  if (sprint_coder::computer_use::windows_uia_source_detail::CreateBoundedAutomation(
          kWindowsV1UiaConnectionTimeoutMs, kWindowsV1UiaTransactionTimeoutMs, automation))
    return S_OK;
  if (windows_v1_uia_unbounded_creations.fetch_add(1) == 0)
    OutputDebugStringA("computer-use: V1 UI Automation without a call timeout (IUIAutomation2 unavailable)\n");
  return CoCreateInstance(CLSID_CUIAutomation, nullptr, CLSCTX_INPROC_SERVER,
                          IID_PPV_ARGS(automation));
}

enum class WindowsV1UiaStop { kNone, kTimeout, kBudget, kCanceled };

struct WindowsV1UiaLane {
  bool has_deadline = false;
  std::chrono::steady_clock::time_point deadline;
  std::uint64_t epoch = 0;
  std::size_t nodes = 0;  // the nodes of the walks read so far (for the log of a spent budget)
  WindowsV1UiaStop stop = WindowsV1UiaStop::kNone;
};
thread_local WindowsV1UiaLane *windows_v1_uia_lane = nullptr;

// One path of UI Automation calls on the lane. The OUTERMOST scope owns the state; one inside it (the
// classification inside a dispatch's own scope, the signature inside a re-validation) shares it. A path
// always watches the cancellation epoch; only the observe has a time budget.
class WindowsV1UiaPath {
public:
  // A path that watches the cancellation epoch as it is now, with no time budget.
  WindowsV1UiaPath()
      : WindowsV1UiaPath(std::chrono::milliseconds::zero(),
                         cancellation_epoch.load(std::memory_order_acquire)) {}
  WindowsV1UiaPath(std::chrono::milliseconds budget, std::uint64_t epoch) {
    if (windows_v1_uia_lane != nullptr)
      return;
    if (budget > std::chrono::milliseconds::zero()) {
      lane_.has_deadline = true;
      lane_.deadline = std::chrono::steady_clock::now() + budget;
    }
    lane_.epoch = epoch;
    windows_v1_uia_lane = &lane_;
    owner_ = true;
  }
  ~WindowsV1UiaPath() {
    if (owner_)
      windows_v1_uia_lane = nullptr;
  }
  WindowsV1UiaPath(const WindowsV1UiaPath &) = delete;
  WindowsV1UiaPath &operator=(const WindowsV1UiaPath &) = delete;
  [[nodiscard]] WindowsV1UiaStop Stop() const { return windows_v1_uia_lane != nullptr ? windows_v1_uia_lane->stop : WindowsV1UiaStop::kNone; }
  [[nodiscard]] std::size_t Nodes() const { return windows_v1_uia_lane != nullptr ? windows_v1_uia_lane->nodes : 0; }

private:
  WindowsV1UiaLane lane_;
  bool owner_ = false;
};

// Whether the path may make one more UI Automation call. False for good once a call timed out, the
// action was canceled or (the observe) the budget is spent. Outside any path: false (fail closed). Every
// V1 call is reached from inside a path; a call that is not would watch neither a Cancel nor the first
// timeout, so it is refused instead of made unwatched.
bool WindowsV1UiaMayCall() {
  WindowsV1UiaLane *lane = windows_v1_uia_lane;
  if (lane == nullptr)
    return false;
  if (lane->stop == WindowsV1UiaStop::kNone) {
    if (cancellation_epoch.load(std::memory_order_acquire) != lane->epoch)
      lane->stop = WindowsV1UiaStop::kCanceled;
    else if (lane->has_deadline && std::chrono::steady_clock::now() > lane->deadline)
      lane->stop = WindowsV1UiaStop::kBudget;
  }
  return lane->stop == WindowsV1UiaStop::kNone;
}

constexpr HRESULT kWindowsV1UiaTimeoutResult = static_cast<HRESULT>(0x80131505);  // UIA_E_TIMEOUT

// A timeout of UI Automation or of the RPC under it.
bool WindowsV1UiaIsTimeout(HRESULT result) {
  constexpr HRESULT kWin32Timeout = static_cast<HRESULT>(0x800705B4);  // HRESULT_FROM_WIN32(ERROR_TIMEOUT)
  constexpr HRESULT kRpcTimeout = static_cast<HRESULT>(0x8001011F);    // RPC_E_TIMEOUT
  return result == kWindowsV1UiaTimeoutResult || result == kWin32Timeout || result == kRpcTimeout;
}

// The result of a UI Automation call, as success or not. A timed-out call also ends its path.
bool WindowsV1UiaOk(HRESULT result) {
  if (SUCCEEDED(result))
    return true;
  WindowsV1UiaLane *lane = windows_v1_uia_lane;
  if (lane != nullptr && lane->stop == WindowsV1UiaStop::kNone && WindowsV1UiaIsTimeout(result))
    lane->stop = WindowsV1UiaStop::kTimeout;
  return false;
}

// A call that took this long and still "succeeded" has been cut off by its timeout (30 ms under it):
// 270 ms against the 300 ms transaction timeout, 470 ms against the 500 ms connection timeout.
constexpr std::chrono::milliseconds kWindowsV1UiaSlowRead{270};
constexpr std::chrono::milliseconds kWindowsV1UiaSlowContact{470};
static_assert(kWindowsV1UiaSlowRead.count() < kWindowsV1UiaTransactionTimeoutMs, "a read is slow before it times out");
static_assert(kWindowsV1UiaSlowContact.count() < kWindowsV1UiaConnectionTimeoutMs, "a contact is slow before it times out");

// One UI Automation call of a path: the cancel / timeout / budget check first (E_ABORT, no call made,
// when the path has ended), then the call, timed. A call that came back only after nearly its whole
// timeout is a timed-out call (UIA_E_TIMEOUT), even if it says S_OK.
template <class Call> HRESULT WindowsV1UiaTimed(std::chrono::milliseconds slow, Call &&call) {
  if (!WindowsV1UiaMayCall())
    return E_ABORT;
  const auto start = std::chrono::steady_clock::now();
  HRESULT result = call();
  if (SUCCEEDED(result) && std::chrono::steady_clock::now() - start >= slow)
    result = kWindowsV1UiaTimeoutResult;
  return result;
}
// A call on a connected element (walker moves, the parent).
template <class Call> HRESULT WindowsV1UiaCall(Call &&call) {
  return WindowsV1UiaTimed(kWindowsV1UiaSlowRead, call);
}
// The first contact with a target (ElementFromHandle / ElementFromPoint / GetFocusedElement).
template <class Call> HRESULT WindowsV1UiaContact(Call &&call) {
  return WindowsV1UiaTimed(kWindowsV1UiaSlowContact, call);
}
// One read of a property: true only for a call that answered in time.
template <class Call> bool WindowsV1UiaRead(Call &&call) {
  return WindowsV1UiaOk(WindowsV1UiaTimed(kWindowsV1UiaSlowRead, call));
}

// Why the path ended, now (kNone outside a path).
WindowsV1UiaStop WindowsV1UiaCurrentStop() {
  return windows_v1_uia_lane != nullptr ? windows_v1_uia_lane->stop : WindowsV1UiaStop::kNone;
}

// The reason of an action that was NOT sent because the path had ended (a timeout, a Cancel): nothing
// was done, so it is a rejection before any input.
const char *WindowsV1UiaEndedReason() {
  return WindowsV1UiaCurrentStop() == WindowsV1UiaStop::kTimeout ? "accessibility_timeout"
                                                                  : "semantic_action_failed";
}

// One node of a walk was visited.
void WindowsV1UiaCountNode() {
  if (windows_v1_uia_lane != nullptr)
    ++windows_v1_uia_lane->nodes;
}

// The reason an observe gives for a read that did not complete: a target that did not answer
// (accessibility_timeout: transient, a new observe can succeed, for example once a cold app has loaded
// its providers), a spent budget (observation_timeout) or a cancel (observation_stale); else the reason
// the step had.
const char *WindowsV1ObserveReason(WindowsV1UiaStop stop, const char *otherwise) {
  switch (stop) {
  case WindowsV1UiaStop::kTimeout:
    return "accessibility_timeout";
  case WindowsV1UiaStop::kBudget:
    return "observation_timeout";
  case WindowsV1UiaStop::kCanceled:
    return "observation_stale";
  case WindowsV1UiaStop::kNone:
    break;
  }
  return otherwise;
}

bool HasUiAutomation() {
  IUIAutomation *automation = nullptr;
  const HRESULT result =
      CreateWindowsV1Automation(&automation);
  if (FAILED(result) || automation == nullptr)
    return false;
  automation->Release();
  return true;
}

bool HasGraphicsCaptureFactory() {
#if SPRINT_CODER_HAS_WINDOWS_GRAPHICS_CAPTURE
  try {
    auto factory = winrt::get_activation_factory<
        winrt::Windows::Graphics::Capture::GraphicsCaptureItem,
        IGraphicsCaptureItemInterop>();
    return factory != nullptr;
  } catch (...) {
    return false;
  }
#else
  return false;
#endif
}

#if SPRINT_CODER_HAS_WINDOWS_GRAPHICS_CAPTURE
bool CaptureWindowWithGraphicsCapture(HWND window,
                                      std::vector<std::uint8_t> *output,
                                      std::size_t *width, std::size_t *height) {
  if (window == nullptr || GetForegroundWindow() != window)
    return false;
  try {
    RECT client_bounds{};
    RECT frame_bounds{};
    if (!ClientBoundsPhysical(window, &client_bounds) ||
        FAILED(DwmGetWindowAttribute(window, DWMWA_EXTENDED_FRAME_BOUNDS,
                                     &frame_bounds, sizeof(frame_bounds))) ||
        frame_bounds.right <= frame_bounds.left ||
        frame_bounds.bottom <= frame_bounds.top ||
        client_bounds.left < frame_bounds.left ||
        client_bounds.top < frame_bounds.top ||
        client_bounds.right > frame_bounds.right ||
        client_bounds.bottom > frame_bounds.bottom)
      return false;
    auto interop = winrt::get_activation_factory<
        winrt::Windows::Graphics::Capture::GraphicsCaptureItem,
        IGraphicsCaptureItemInterop>();
    winrt::Windows::Graphics::Capture::GraphicsCaptureItem capture_item{
        nullptr};
    if (FAILED(interop->CreateForWindow(
            window,
            winrt::guid_of<
                winrt::Windows::Graphics::Capture::GraphicsCaptureItem>(),
            reinterpret_cast<void **>(winrt::put_abi(capture_item)))))
      return false;
    const auto source_size = capture_item.Size();
    if (source_size.Width <= 0 || source_size.Height <= 0 ||
        source_size.Width > 16'384 || source_size.Height > 16'384)
      return false;
    const double source_x_scale =
        static_cast<double>(source_size.Width) /
        static_cast<double>(frame_bounds.right - frame_bounds.left);
    const double source_y_scale =
        static_cast<double>(source_size.Height) /
        static_cast<double>(frame_bounds.bottom - frame_bounds.top);
    const auto crop_left = static_cast<UINT>(std::clamp(
        std::lround((client_bounds.left - frame_bounds.left) * source_x_scale),
        0l, static_cast<long>(source_size.Width - 1)));
    const auto crop_top = static_cast<UINT>(std::clamp(
        std::lround((client_bounds.top - frame_bounds.top) * source_y_scale),
        0l, static_cast<long>(source_size.Height - 1)));
    const auto crop_right = static_cast<UINT>(std::clamp(
        std::lround((client_bounds.right - frame_bounds.left) * source_x_scale),
        static_cast<long>(crop_left + 1),
        static_cast<long>(source_size.Width)));
    const auto crop_bottom = static_cast<UINT>(std::clamp(
        std::lround((client_bounds.bottom - frame_bounds.top) * source_y_scale),
        static_cast<long>(crop_top + 1),
        static_cast<long>(source_size.Height)));
    const UINT client_width = crop_right - crop_left;
    const UINT client_height = crop_bottom - crop_top;
    constexpr double kMaximumRawCapturePixels = (7.0 * 1024.0 * 1024.0) / 4.0;
    const double byte_scale = std::sqrt(kMaximumRawCapturePixels /
                                        (static_cast<double>(client_width) *
                                         static_cast<double>(client_height)));
    const double scale = std::min(
        1.0, std::min(byte_scale,
                      std::min(2'560.0 / static_cast<double>(client_width),
                               1'600.0 / static_cast<double>(client_height))));
    const auto capture_width = static_cast<std::size_t>(
        std::max(1.0, std::floor(static_cast<double>(client_width) * scale)));
    const auto capture_height = static_cast<std::size_t>(
        std::max(1.0, std::floor(static_cast<double>(client_height) * scale)));
    if (capture_width == 0 || capture_height == 0)
      return false;

    Microsoft::WRL::ComPtr<ID3D11Device> device;
    Microsoft::WRL::ComPtr<ID3D11DeviceContext> context;
    D3D_FEATURE_LEVEL level{};
    if (FAILED(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
                                 D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0,
                                 D3D11_SDK_VERSION, &device, &level, &context)))
      return false;
    Microsoft::WRL::ComPtr<IDXGIDevice> dxgi_device;
    if (FAILED(device.As(&dxgi_device)))
      return false;
    winrt::com_ptr<IInspectable> inspectable_device;
    if (FAILED(CreateDirect3D11DeviceFromDXGIDevice(dxgi_device.Get(),
                                                    inspectable_device.put())))
      return false;
    auto direct3d_device = inspectable_device.as<
        winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice>();
    const auto frame_pool =
        winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool::
            CreateFreeThreaded(direct3d_device,
                               winrt::Windows::Graphics::DirectX::
                                   DirectXPixelFormat::B8G8R8A8UIntNormalized,
                               1, source_size);
    const auto session = frame_pool.CreateCaptureSession(capture_item);
    const HANDLE frame_event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (frame_event == nullptr)
      return false;
    const auto event_token = frame_pool.FrameArrived(
        [frame_event](auto const &, auto const &) { SetEvent(frame_event); });
    session.StartCapture();
    const DWORD ready = WaitForSingleObject(frame_event, 5'000);
    frame_pool.FrameArrived(event_token);
    CloseHandle(frame_event);
    if (ready != WAIT_OBJECT_0)
      return false;
    const auto frame = frame_pool.TryGetNextFrame();
    if (frame == nullptr)
      return false;
    const auto surface = frame.Surface();
    auto surface_access = surface.as<::Windows::Graphics::DirectX::Direct3D11::
                                         IDirect3DDxgiInterfaceAccess>();
    Microsoft::WRL::ComPtr<ID3D11Texture2D> source_texture;
    if (FAILED(surface_access->GetInterface(IID_PPV_ARGS(&source_texture))))
      return false;
    D3D11_TEXTURE2D_DESC source_desc{};
    source_texture->GetDesc(&source_desc);
    D3D11_TEXTURE2D_DESC staging_desc = source_desc;
    staging_desc.Width = client_width;
    staging_desc.Height = client_height;
    staging_desc.Usage = D3D11_USAGE_STAGING;
    staging_desc.BindFlags = 0;
    staging_desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    staging_desc.MiscFlags = 0;
    Microsoft::WRL::ComPtr<ID3D11Texture2D> staging;
    if (FAILED(device->CreateTexture2D(&staging_desc, nullptr, &staging)))
      return false;
    const D3D11_BOX client_box = {crop_left,  crop_top,    0,
                                  crop_right, crop_bottom, 1};
    context->CopySubresourceRegion(staging.Get(), 0, 0, 0, 0,
                                   source_texture.Get(), 0, &client_box);
    D3D11_MAPPED_SUBRESOURCE mapped{};
    if (FAILED(context->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &mapped)))
      return false;

    Microsoft::WRL::ComPtr<IWICImagingFactory> imaging;
    if (FAILED(CoCreateInstance(CLSID_WICImagingFactory, nullptr,
                                CLSCTX_INPROC_SERVER,
                                IID_PPV_ARGS(&imaging)))) {
      context->Unmap(staging.Get(), 0);
      return false;
    }
    Microsoft::WRL::ComPtr<IWICBitmapEncoder> encoder;
    Microsoft::WRL::ComPtr<IWICBitmapFrameEncode> frame_encoder;
    Microsoft::WRL::ComPtr<IPropertyBag2> options;
    Microsoft::WRL::ComPtr<IWICBitmap> source_bitmap;
    Microsoft::WRL::ComPtr<IWICBitmapScaler> scaler;
    bool success = SUCCEEDED(
        imaging->CreateEncoder(GUID_ContainerFormatPng, nullptr, &encoder));
    // WIC's in-memory stream encoder is intentionally kept bounded. If this
    // platform cannot encode the mapped frame, the helper reports capture
    // unavailable instead of returning raw GPU memory.
    if (success) {
      Microsoft::WRL::ComPtr<IStream> output_stream;
      success = SUCCEEDED(CreateStreamOnHGlobal(nullptr, TRUE, &output_stream));
      if (success)
        success = SUCCEEDED(
            encoder->Initialize(output_stream.Get(), WICBitmapEncoderNoCache));
      if (success)
        success = SUCCEEDED(encoder->CreateNewFrame(&frame_encoder, &options));
      if (success)
        success = SUCCEEDED(frame_encoder->Initialize(options.Get()));
      if (success)
        success = SUCCEEDED(imaging->CreateBitmapFromMemory(
            staging_desc.Width, staging_desc.Height,
            GUID_WICPixelFormat32bppBGRA, mapped.RowPitch,
            mapped.RowPitch * staging_desc.Height,
            static_cast<BYTE *>(mapped.pData), &source_bitmap));
      IWICBitmapSource *source_to_write = source_bitmap.Get();
      if (success && (staging_desc.Width != capture_width ||
                      staging_desc.Height != capture_height)) {
        success = SUCCEEDED(imaging->CreateBitmapScaler(&scaler)) &&
                  SUCCEEDED(scaler->Initialize(
                      source_bitmap.Get(), static_cast<UINT>(capture_width),
                      static_cast<UINT>(capture_height),
                      WICBitmapInterpolationModeFant));
        source_to_write = scaler.Get();
      }
      if (success)
        success = SUCCEEDED(
            frame_encoder->SetSize(static_cast<UINT>(capture_width),
                                   static_cast<UINT>(capture_height)));
      GUID pixel_format = GUID_WICPixelFormat32bppBGRA;
      if (success)
        success = SUCCEEDED(frame_encoder->SetPixelFormat(&pixel_format));
      if (success)
        success =
            source_to_write != nullptr &&
            SUCCEEDED(frame_encoder->WriteSource(source_to_write, nullptr));
      if (success)
        success =
            SUCCEEDED(frame_encoder->Commit()) && SUCCEEDED(encoder->Commit());
      if (success) {
        STATSTG stat{};
        success = SUCCEEDED(output_stream->Stat(&stat, STATFLAG_NONAME)) &&
                  stat.cbSize.QuadPart > 0 &&
                  stat.cbSize.QuadPart <= 8ll * 1024ll * 1024ll;
        if (success) {
          LARGE_INTEGER start{};
          output_stream->Seek(start, STREAM_SEEK_SET, nullptr);
          output->resize(static_cast<std::size_t>(stat.cbSize.QuadPart));
          ULONG read = 0;
          success =
              SUCCEEDED(output_stream->Read(
                  output->data(), static_cast<ULONG>(output->size()), &read)) &&
              read == output->size();
        }
      }
    }
    context->Unmap(staging.Get(), 0);
    if (!success)
      return false;
    *width = capture_width;
    *height = capture_height;
    return !output->empty();
  } catch (...) {
    output->clear();
    return false;
  }
}
#else
bool CaptureWindowWithGraphicsCapture(HWND, std::vector<std::uint8_t> *,
                                      std::size_t *, std::size_t *) {
  return false;
}
#endif

#if SPRINT_CODER_HAS_WINDOWS_GRAPHICS_CAPTURE
constexpr std::size_t kVisualPatchSize = 64;
constexpr std::size_t kMaximumVisualPatchDigests = 1'000;

bool DecodePngBgra(std::span<const std::uint8_t> png,
                   std::size_t expected_width, std::size_t expected_height,
                   std::vector<std::uint8_t> *pixels) {
  if (png.empty() || png.size() > 8 * 1024 * 1024 || expected_width == 0 ||
      expected_height == 0 || expected_width > 2'560 ||
      expected_height > 1'600 || pixels == nullptr)
    return false;
  Microsoft::WRL::ComPtr<IStream> stream;
  if (FAILED(CreateStreamOnHGlobal(nullptr, TRUE, &stream)))
    return false;
  ULONG written = 0;
  if (FAILED(stream->Write(png.data(), static_cast<ULONG>(png.size()),
                           &written)) ||
      written != static_cast<ULONG>(png.size()))
    return false;
  LARGE_INTEGER beginning{};
  if (FAILED(stream->Seek(beginning, STREAM_SEEK_SET, nullptr)))
    return false;
  Microsoft::WRL::ComPtr<IWICImagingFactory> imaging;
  Microsoft::WRL::ComPtr<IWICBitmapDecoder> decoder;
  Microsoft::WRL::ComPtr<IWICBitmapFrameDecode> frame;
  Microsoft::WRL::ComPtr<IWICFormatConverter> converter;
  if (FAILED(CoCreateInstance(CLSID_WICImagingFactory, nullptr,
                              CLSCTX_INPROC_SERVER,
                              IID_PPV_ARGS(&imaging))) ||
      FAILED(imaging->CreateDecoderFromStream(
          stream.Get(), nullptr, WICDecodeMetadataCacheOnLoad, &decoder)) ||
      FAILED(decoder->GetFrame(0, &frame)) ||
      FAILED(imaging->CreateFormatConverter(&converter)) ||
      FAILED(converter->Initialize(
          frame.Get(), GUID_WICPixelFormat32bppBGRA,
          WICBitmapDitherTypeNone, nullptr, 0.0,
          WICBitmapPaletteTypeCustom)))
    return false;
  UINT width = 0;
  UINT height = 0;
  if (FAILED(converter->GetSize(&width, &height)) ||
      width != static_cast<UINT>(expected_width) ||
      height != static_cast<UINT>(expected_height))
    return false;
  const std::size_t byte_count = expected_width * expected_height * 4;
  if (byte_count == 0 || byte_count > 8 * 1024 * 1024)
    return false;
  pixels->resize(byte_count);
  const UINT stride = width * 4;
  if (FAILED(converter->CopyPixels(
          nullptr, stride, static_cast<UINT>(pixels->size()),
          pixels->data()))) {
    std::fill(pixels->begin(), pixels->end(), 0);
    pixels->clear();
    return false;
  }
  return true;
}

bool ComputeBgraPatchDigest(std::span<const std::uint8_t> pixels,
                            std::size_t width, std::size_t height,
                            std::size_t column, std::size_t row,
                            std::string *digest) {
  const std::size_t columns = (width + kVisualPatchSize - 1) /
                              kVisualPatchSize;
  const std::size_t rows = (height + kVisualPatchSize - 1) /
                           kVisualPatchSize;
  if (digest == nullptr || width == 0 || height == 0 || column >= columns ||
      row >= rows || pixels.size() != width * height * 4)
    return false;
  const std::size_t left = column * kVisualPatchSize;
  const std::size_t top = row * kVisualPatchSize;
  const std::size_t patch_width =
      std::min(kVisualPatchSize, width - left);
  const std::size_t patch_height =
      std::min(kVisualPatchSize, height - top);
  std::vector<std::uint8_t> patch;
  patch.reserve(patch_width * patch_height * 4);
  for (std::size_t y = 0; y < patch_height; ++y) {
    const std::size_t offset = ((top + y) * width + left) * 4;
    patch.insert(patch.end(), pixels.begin() + offset,
                 pixels.begin() + offset + patch_width * 4);
  }
  std::vector<std::uint8_t> material;
  static constexpr std::string_view prefix =
      "computer-visual-patch-v1\n";
  material.reserve(prefix.size() + 32 + patch.size());
  material.insert(material.end(), prefix.begin(), prefix.end());
  const std::string dimensions =
      std::to_string(left) + "," + std::to_string(top) + "," +
      std::to_string(patch_width) + "," +
      std::to_string(patch_height) + "\n";
  material.insert(material.end(), dimensions.begin(), dimensions.end());
  material.insert(material.end(), patch.begin(), patch.end());
  *digest = Sha256Bytes(material);
  std::fill(patch.begin(), patch.end(), 0);
  std::fill(material.begin(), material.end(), 0);
  return digest->size() == 64;
}

bool VisualPatchCoordinates(std::size_t width, std::size_t height,
                            double normalized_x, double normalized_y,
                            std::size_t *column, std::size_t *row,
                            std::size_t *index) {
  if (width == 0 || height == 0 || normalized_x < 0 || normalized_x > 1 ||
      normalized_y < 0 || normalized_y > 1 || column == nullptr ||
      row == nullptr || index == nullptr)
    return false;
  const std::size_t pixel_x = static_cast<std::size_t>(std::lround(
      normalized_x * static_cast<double>(width - 1)));
  const std::size_t pixel_y = static_cast<std::size_t>(std::lround(
      normalized_y * static_cast<double>(height - 1)));
  const std::size_t columns = (width + kVisualPatchSize - 1) /
                              kVisualPatchSize;
  *column = pixel_x / kVisualPatchSize;
  *row = pixel_y / kVisualPatchSize;
  *index = *row * columns + *column;
  return true;
}

bool ComputePngPatchDigest(std::span<const std::uint8_t> png,
                           std::size_t expected_width,
                           std::size_t expected_height, double normalized_x,
                           double normalized_y, std::string *digest,
                           std::size_t *patch_index = nullptr) {
  std::vector<std::uint8_t> pixels;
  if (!DecodePngBgra(png, expected_width, expected_height, &pixels))
    return false;
  std::size_t column = 0;
  std::size_t row = 0;
  std::size_t index = 0;
  const bool located = VisualPatchCoordinates(
      expected_width, expected_height, normalized_x, normalized_y, &column,
      &row, &index);
  const bool hashed =
      located && ComputeBgraPatchDigest(pixels, expected_width,
                                       expected_height, column, row, digest);
  std::fill(pixels.begin(), pixels.end(), 0);
  if (hashed && patch_index != nullptr)
    *patch_index = index;
  return hashed;
}

bool ComputePngPatchGrid(std::span<const std::uint8_t> png,
                         std::size_t width, std::size_t height,
                         std::vector<std::string> *digests,
                         std::size_t *columns, std::size_t *rows) {
  if (digests == nullptr || columns == nullptr || rows == nullptr)
    return false;
  std::vector<std::uint8_t> pixels;
  if (!DecodePngBgra(png, width, height, &pixels))
    return false;
  *columns = (width + kVisualPatchSize - 1) / kVisualPatchSize;
  *rows = (height + kVisualPatchSize - 1) / kVisualPatchSize;
  if (*columns == 0 || *rows == 0 ||
      *columns * *rows > kMaximumVisualPatchDigests) {
    std::fill(pixels.begin(), pixels.end(), 0);
    return false;
  }
  std::vector<std::string> result;
  result.reserve(*columns * *rows);
  bool complete = true;
  for (std::size_t row = 0; complete && row < *rows; ++row) {
    for (std::size_t column = 0; column < *columns; ++column) {
      std::string digest;
      if (!ComputeBgraPatchDigest(pixels, width, height, column, row,
                                  &digest)) {
        complete = false;
        break;
      }
      result.push_back(std::move(digest));
    }
  }
  std::fill(pixels.begin(), pixels.end(), 0);
  if (!complete)
    return false;
  *digests = std::move(result);
  return true;
}

bool RevalidateVisualPatch(const WindowsSession &session, double normalized_x,
                           double normalized_y, std::string *reason) {
  if (!session.has_observation || session.active_window == nullptr ||
      session.observation_patch_digests.empty() ||
      session.observation_patch_digests.size() >
          kMaximumVisualPatchDigests ||
      session.observation_capture_width == 0 ||
      session.observation_capture_height == 0 ||
      session.observation_patch_columns == 0 ||
      session.observation_patch_rows == 0 ||
      session.observation_patch_digests.size() !=
          session.observation_patch_columns * session.observation_patch_rows) {
    *reason = "visual_observation_missing";
    return false;
  }
  std::size_t column = 0;
  std::size_t row = 0;
  std::size_t patch_index = 0;
  if (!VisualPatchCoordinates(
          session.observation_capture_width,
          session.observation_capture_height, normalized_x, normalized_y,
          &column, &row, &patch_index) ||
      patch_index >= session.observation_patch_digests.size()) {
    *reason = "visual_observation_invalid";
    return false;
  }
  std::vector<std::uint8_t> current_screenshot;
  std::size_t current_width = 0;
  std::size_t current_height = 0;
  if (!CaptureWindowWithGraphicsCapture(
          session.active_window, &current_screenshot, &current_width,
          &current_height) ||
      current_width != session.observation_capture_width ||
      current_height != session.observation_capture_height) {
    std::fill(current_screenshot.begin(), current_screenshot.end(), 0);
    *reason = "native_visual_patch_changed";
    return false;
  }
  std::string current_digest;
  std::size_t current_patch_index = 0;
  const bool decoded = ComputePngPatchDigest(
      current_screenshot, current_width, current_height, normalized_x,
      normalized_y, &current_digest, &current_patch_index);
  std::fill(current_screenshot.begin(), current_screenshot.end(), 0);
  if (!decoded || current_patch_index != patch_index ||
      current_digest != session.observation_patch_digests[patch_index]) {
    *reason = "native_visual_patch_changed";
    return false;
  }
  return true;
}
#else
bool ComputePngPatchGrid(std::span<const std::uint8_t>, std::size_t,
                         std::size_t, std::vector<std::string> *,
                         std::size_t *, std::size_t *) {
  return false;
}

bool RevalidateVisualPatch(const WindowsSession &, double, double,
                           std::string *reason) {
  if (reason != nullptr)
    *reason = "graphics_capture_unavailable";
  return false;
}
#endif

std::string BoundedUtf8(std::string value, std::size_t maximum_bytes) {
  if (value.size() <= maximum_bytes)
    return value;
  value.resize(maximum_bytes);
  while (!value.empty() &&
         (static_cast<unsigned char>(value.back()) & 0xc0) == 0x80)
    value.pop_back();
  if (!value.empty() && static_cast<unsigned char>(value.back()) >= 0xc0)
    value.pop_back();
  return value;
}

std::string UiaRole(CONTROLTYPEID control_type, bool password) {
  if (password)
    return "AXSecureTextField";
  switch (control_type) {
  case UIA_WindowControlTypeId:
    return "AXWindow";
  case UIA_ButtonControlTypeId:
    return "UIAButton";
  case UIA_EditControlTypeId:
    return "UIATextField";
  case UIA_CheckBoxControlTypeId:
    return "UIACheckBox";
  case UIA_RadioButtonControlTypeId:
    return "UIARadioButton";
  case UIA_ComboBoxControlTypeId:
    return "UIAComboBox";
  case UIA_ListItemControlTypeId:
    return "UIAListItem";
  case UIA_MenuItemControlTypeId:
    return "UIAMenuItem";
  case UIA_TabItemControlTypeId:
    return "UIATabItem";
  case UIA_TreeItemControlTypeId:
    return "UIATreeItem";
  case UIA_HyperlinkControlTypeId:
    return "UIAHyperlink";
  default:
    return "UIAControl" +
           std::to_string(static_cast<unsigned int>(control_type));
  }
}

bool AppendUiaTree(IUIAutomationElement *element,
                   IUIAutomationTreeWalker *walker, std::size_t depth,
                   std::size_t *nodes, std::string *json) {
  if (element == nullptr || walker == nullptr || depth > 16 ||
      *nodes >= 5'000 || json->size() > 512 * 1024 || !WindowsV1UiaMayCall())
    return false;
  ++*nodes;
  WindowsV1UiaCountNode();
  BSTR name = nullptr;
  BSTR automation_id = nullptr;
  BSTR help = nullptr;
  CONTROLTYPEID control_type = 0;
  BOOL password = FALSE;
  const bool attributes_read =
      WindowsV1UiaRead([&] { return element->get_CurrentName(&name); }) &&
      WindowsV1UiaRead([&] { return element->get_CurrentAutomationId(&automation_id); }) &&
      WindowsV1UiaRead([&] { return element->get_CurrentHelpText(&help); }) &&
      WindowsV1UiaRead([&] { return element->get_CurrentControlType(&control_type); }) &&
      WindowsV1UiaRead([&] { return element->get_CurrentIsPassword(&password); });
  if (!attributes_read) {
    if (name != nullptr)
      SysFreeString(name);
    if (automation_id != nullptr)
      SysFreeString(automation_id);
    if (help != nullptr)
      SysFreeString(help);
    return false;
  }
  const std::string name_utf8 = BoundedUtf8(
      name == nullptr
          ? std::string{}
          : Utf8FromWide(std::wstring_view(name, SysStringLen(name))),
      256);
  const std::string automation_utf8 =
      BoundedUtf8(automation_id == nullptr
                      ? std::string{}
                      : Utf8FromWide(std::wstring_view(
                            automation_id, SysStringLen(automation_id))),
                  256);
  const std::string help_utf8 = BoundedUtf8(
      help == nullptr
          ? std::string{}
          : Utf8FromWide(std::wstring_view(help, SysStringLen(help))),
      4'096);
  const bool text_converted =
      (name == nullptr || SysStringLen(name) == 0 || !name_utf8.empty()) &&
      (automation_id == nullptr || SysStringLen(automation_id) == 0 ||
       !automation_utf8.empty()) &&
      (help == nullptr || SysStringLen(help) == 0 || !help_utf8.empty());
  if (!text_converted) {
    if (name != nullptr)
      SysFreeString(name);
    if (automation_id != nullptr)
      SysFreeString(automation_id);
    if (help != nullptr)
      SysFreeString(help);
    return false;
  }
  if (name != nullptr)
    SysFreeString(name);
  if (automation_id != nullptr)
    SysFreeString(automation_id);
  if (help != nullptr)
    SysFreeString(help);
  *json += "{\"role\":\"" +
           JsonEscape(UiaRole(control_type, password == TRUE)) +
           "\",\"title\":\"" + JsonEscape(name_utf8) + "\",\"identifier\":\"" +
           JsonEscape(automation_utf8) + "\"";
  if (!help_utf8.empty())
    *json += ",\"help\":\"" + JsonEscape(help_utf8) + "\"";
  *json += ",\"children\":[";
  IUIAutomationElement *child = nullptr;
  HRESULT result = WindowsV1UiaCall([&] { return walker->GetFirstChildElement(element, &child); });
  bool first = true;
  bool complete = WindowsV1UiaOk(result);
  while (complete && child != nullptr) {
    if (!first)
      *json += ',';
    first = false;
    if (!AppendUiaTree(child, walker, depth + 1, nodes, json))
      complete = false;
    IUIAutomationElement *next = nullptr;
    if (complete && !WindowsV1UiaOk(WindowsV1UiaCall([&] { return walker->GetNextSiblingElement(child, &next); })))
      complete = false;
    child->Release();
    child = next;
  }
  if (child != nullptr)
    child->Release();
  *json += "]}";
  return complete && json->size() <= 512 * 1024;
}

bool TargetWindowFacts(std::uint32_t pid, HWND window, RECT *bounds) {
  if (window == nullptr || !IsWindow(window) || !IsWindowVisible(window))
    return false;
  if (GetForegroundWindow() != window)
    return false;
  DWORD owner_pid = 0;
  if (GetWindowThreadProcessId(window, &owner_pid) == 0 || owner_pid != pid)
    return false;
  return ClientBoundsPhysical(window, bounds);
}

bool IsProcessElevated(std::uint32_t pid) {
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (process == nullptr)
    return true;
  HANDLE token = nullptr;
  const bool opened = OpenProcessToken(process, TOKEN_QUERY, &token) == TRUE;
  TOKEN_ELEVATION elevation{};
  DWORD length = 0;
  const bool read =
      opened && GetTokenInformation(token, TokenElevation, &elevation,
                                    sizeof(elevation), &length) == TRUE;
  if (token != nullptr)
    CloseHandle(token);
  CloseHandle(process);
  return !read || elevation.TokenIsElevated != 0;
}

bool ReadUiaObservation(std::uint32_t pid, HWND window, std::string *tree,
                        std::size_t *nodes) {
  const WindowsV1UiaPath path;
  IUIAutomation *automation = nullptr;
  if (FAILED(CreateWindowsV1Automation(&automation)) ||
      automation == nullptr)
    return false;
  IUIAutomationElement *root = nullptr;
  IUIAutomationTreeWalker *walker = nullptr;
  const HRESULT root_result =
      WindowsV1UiaContact([&] { return automation->ElementFromHandle(window, &root); });
  const HRESULT walker_result = automation->get_RawViewWalker(&walker);
  std::string value;
  std::size_t count = 0;
  const bool complete = WindowsV1UiaOk(root_result) && SUCCEEDED(walker_result) &&
                        root != nullptr && walker != nullptr &&
                        AppendUiaTree(root, walker, 0, &count, &value);
  if (root != nullptr)
    root->Release();
  if (walker != nullptr)
    walker->Release();
  automation->Release();
  if (!complete)
    return false;
  *tree = std::move(value);
  *nodes = count;
  (void)pid;
  return true;
}

struct WindowsUiaRisk {
  bool classified = false;
  bool secure = false;
  bool high_impact = false;
  bool metadata_complete = false;
};

std::string LowercaseAscii(std::string value) {
  for (char &character : value)
    if (character >= 'A' && character <= 'Z')
      character = static_cast<char>(character + ('a' - 'A'));
  return value;
}

bool IsWindowsRiskWordCharacter(char character) {
  return (character >= 'a' && character <= 'z') ||
         (character >= '0' && character <= '9');
}

bool ContainsBoundedWindowsRiskTerm(std::string_view text,
                                    std::string_view term) {
  std::size_t offset = 0;
  while ((offset = text.find(term, offset)) != std::string_view::npos) {
    const bool left_bounded =
        offset == 0 || !IsWindowsRiskWordCharacter(text[offset - 1]);
    const std::size_t end = offset + term.size();
    const bool right_bounded =
        end == text.size() || !IsWindowsRiskWordCharacter(text[end]);
    if (left_bounded && right_bounded)
      return true;
    offset = end;
  }
  return false;
}

bool ContainsWindowsRiskText(std::string_view text) {
  static constexpr std::array<std::string_view, 36> terms = {
      "payment",
      "checkout",
      "purchase",
      "billing",
      "credit card",
      "card number",
      "wire transfer",
      "contract",
      "agreement",
      "sign agreement",
      "installer",
      "install application",
      "administrator",
      "admin privileges",
      "sudo",
      "root access",
      "security settings",
      "privacy settings",
      "firewall",
      "accessibility permission",
      "screen recording permission",
      "決済",
      "支払い",
      "支払う",
      "購入",
      "注文を確定",
      "注文する",
      "請求",
      "送金",
      "契約",
      "署名",
      "インストール",
      "管理者",
      "セキュリティ",
      "プライバシー",
      "ファイアウォール",
  };
  for (const auto term : terms)
    if (text.find(term) != std::string_view::npos)
      return true;
  static constexpr std::array<std::string_view, 15> payment_terms = {
      "pay",          "pay now",        "place order", "submit order",
      "complete order", "buy now",      "pagar",       "comprar",
      "acheter",      "bestellen",      "bezahlen",    "pagare",
      "acquistare",   "betalen",        "kopen"};
  for (const auto term : payment_terms)
    if (ContainsBoundedWindowsRiskTerm(text, term))
      return true;
  static constexpr std::array<std::string_view, 9> shell_terms = {
      "integrated terminal", "terminal", "console", "shell", "powershell",
      "command prompt",      "cmd.exe",  "pwsh",    "wsl",
  };
  for (const auto term : shell_terms)
    if (ContainsBoundedWindowsRiskTerm(text, term))
      return true;
  return false;
}

WindowsUiaRisk ClassifyWindowsUiaElementSelf(IUIAutomationElement *element) {
  WindowsUiaRisk risk;
  if (element == nullptr || !WindowsV1UiaMayCall())
    return risk;
  BSTR name = nullptr;
  BSTR automation_id = nullptr;
  BSTR help = nullptr;
  CONTROLTYPEID control_type = 0;
  BOOL password = FALSE;
  const bool attributes_read =
      WindowsV1UiaRead([&] { return element->get_CurrentName(&name); }) &&
      WindowsV1UiaRead([&] { return element->get_CurrentAutomationId(&automation_id); }) &&
      WindowsV1UiaRead([&] { return element->get_CurrentHelpText(&help); }) &&
      WindowsV1UiaRead([&] { return element->get_CurrentControlType(&control_type); }) &&
      WindowsV1UiaRead([&] { return element->get_CurrentIsPassword(&password); });
  if (!attributes_read) {
    if (name != nullptr)
      SysFreeString(name);
    if (automation_id != nullptr)
      SysFreeString(automation_id);
    if (help != nullptr)
      SysFreeString(help);
    return risk;
  }
  const auto convert = [](BSTR value) {
    return value == nullptr
               ? std::string{}
               : Utf8FromWide(std::wstring_view(value, SysStringLen(value)));
  };
  const std::string name_text = convert(name);
  const std::string automation_text = convert(automation_id);
  const std::string help_text = convert(help);
  const bool text_converted =
      (name == nullptr || SysStringLen(name) == 0 || !name_text.empty()) &&
      (automation_id == nullptr || SysStringLen(automation_id) == 0 ||
       !automation_text.empty()) &&
      (help == nullptr || SysStringLen(help) == 0 || !help_text.empty());
  if (!text_converted) {
    if (name != nullptr)
      SysFreeString(name);
    if (automation_id != nullptr)
      SysFreeString(automation_id);
    if (help != nullptr)
      SysFreeString(help);
    return risk;
  }
  if (name != nullptr)
    SysFreeString(name);
  if (automation_id != nullptr)
    SysFreeString(automation_id);
  if (help != nullptr)
    SysFreeString(help);
  const std::string normalized =
      LowercaseAscii(name_text + "\n" + automation_text + "\n" + help_text);
  risk.classified = control_type != 0 || !normalized.empty();
  risk.secure = password == TRUE ||
                normalized.find("password") != std::string::npos ||
                normalized.find("passcode") != std::string::npos ||
                normalized.find("パスワード") != std::string::npos;
  // Version 1 excludes ordinary save/send/publish/delete labels from this
  // high-impact list.
  risk.high_impact = ContainsWindowsRiskText(normalized);
  risk.metadata_complete = true;
  return risk;
}

WindowsUiaRisk ClassifyWindowsUiaElement(IUIAutomationElement *element) {
  WindowsUiaRisk merged;
  if (element == nullptr)
    return merged;
  const WindowsV1UiaPath path;
  IUIAutomation *automation = nullptr;
  IUIAutomationTreeWalker *walker = nullptr;
  if (FAILED(CreateWindowsV1Automation(&automation)) ||
      automation == nullptr || FAILED(automation->get_RawViewWalker(&walker)) ||
      walker == nullptr) {
    if (walker != nullptr)
      walker->Release();
    if (automation != nullptr)
      automation->Release();
    return {};
  }
  element->AddRef();
  IUIAutomationElement *current = element;
  bool metadata_complete = true;
  for (std::size_t depth = 0; current != nullptr && depth < 8; ++depth) {
    const WindowsUiaRisk risk = ClassifyWindowsUiaElementSelf(current);
    merged.classified = merged.classified || risk.classified;
    merged.secure = merged.secure || risk.secure;
    merged.high_impact = merged.high_impact || risk.high_impact;
    metadata_complete = metadata_complete && risk.metadata_complete;
    // An element that could not be read ends the climb: the facts are incomplete whatever the parents
    // say (ClassifyNativePreflightFacts puts incomplete metadata ahead of secure and high impact, so
    // the reason does not change), and asking the parents of a target that stopped answering costs one
    // more timeout each.
    if (!risk.metadata_complete)
      break;
    IUIAutomationElement *parent = nullptr;
    const HRESULT parent_result =
        WindowsV1UiaCall([&] { return walker->GetParentElement(current, &parent); });
    if (!WindowsV1UiaOk(parent_result)) {
      metadata_complete = false;
      if (parent != nullptr)
        parent->Release();
      parent = nullptr;
    }
    current->Release();
    current = parent;
  }
  if (current != nullptr) {
    current->Release();
    metadata_complete = false;
  }
  walker->Release();
  automation->Release();
  merged.metadata_complete = metadata_complete;
  return merged;
}

WindowsUiaRisk ClassifyWindowsPoint(POINT point, std::uint32_t expected_pid,
                                    std::string *control_signature = nullptr) {
  if (control_signature != nullptr)
    control_signature->clear();
  const WindowsV1UiaPath path;
  IUIAutomation *automation = nullptr;
  if (FAILED(CreateWindowsV1Automation(&automation)) ||
      automation == nullptr)
    return {};
  IUIAutomationElement *element = nullptr;
  const POINT query = point;
  const HRESULT found =
      WindowsV1UiaContact([&] { return automation->ElementFromPoint(query, &element); });
  automation->Release();
  if (!WindowsV1UiaOk(found) || element == nullptr) {
    if (element != nullptr)
      element->Release();
    return {};
  }
  int owner_pid = 0;
  if (!WindowsV1UiaRead([&] { return element->get_CurrentProcessId(&owner_pid); }) || owner_pid <= 0 ||
      static_cast<std::uint32_t>(owner_pid) != expected_pid) {
    element->Release();
    return {};
  }
  const WindowsUiaRisk risk = ClassifyWindowsUiaElement(element);
  // The control signature is only for a target that is going to be acted on: when the facts are
  // incomplete the caller rejects the action and never reads it, so it is not asked for (one more call
  // to an element that has just failed to answer).
  if (control_signature != nullptr && risk.metadata_complete)
    ComputeWindowsControlSignature(element, expected_pid, nullptr, control_signature);
  element->Release();
  return risk;
}

WindowsUiaRisk ClassifyWindowsFocusedElement(std::uint32_t expected_pid) {
  const WindowsV1UiaPath path;
  IUIAutomation *automation = nullptr;
  if (FAILED(CreateWindowsV1Automation(&automation)) ||
      automation == nullptr)
    return {};
  IUIAutomationElement *element = nullptr;
  const HRESULT found =
      WindowsV1UiaContact([&] { return automation->GetFocusedElement(&element); });
  automation->Release();
  if (!WindowsV1UiaOk(found) || element == nullptr) {
    if (element != nullptr)
      element->Release();
    return {};
  }
  int owner_pid = 0;
  if (!WindowsV1UiaRead([&] { return element->get_CurrentProcessId(&owner_pid); }) || owner_pid <= 0 ||
      static_cast<std::uint32_t>(owner_pid) != expected_pid) {
    element->Release();
    return {};
  }
  const WindowsUiaRisk risk = ClassifyWindowsUiaElement(element);
  element->Release();
  return risk;
}

bool ComputeWindowsControlSignature(IUIAutomationElement *element,
                                    std::uint32_t expected_pid,
                                    const RECT *containing_bounds,
                                    std::string *signature) {
  if (element == nullptr || signature == nullptr || !WindowsV1UiaMayCall())
    return false;
  int owner_pid = 0;
  CONTROLTYPEID control_type = 0;
  RECT bounds{};
  BSTR automation_id = nullptr;
  SAFEARRAY *runtime_id = nullptr;
  const bool facts =
      WindowsV1UiaRead([&] { return element->get_CurrentProcessId(&owner_pid); }) && owner_pid > 0 &&
      static_cast<std::uint32_t>(owner_pid) == expected_pid &&
      WindowsV1UiaRead([&] { return element->get_CurrentControlType(&control_type); }) &&
      WindowsV1UiaRead([&] { return element->get_CurrentBoundingRectangle(&bounds); }) &&
      bounds.right > bounds.left && bounds.bottom > bounds.top &&
      (containing_bounds == nullptr ||
       (bounds.left >= containing_bounds->left &&
        bounds.top >= containing_bounds->top &&
        bounds.right <= containing_bounds->right &&
        bounds.bottom <= containing_bounds->bottom)) &&
      WindowsV1UiaRead([&] { return element->get_CurrentAutomationId(&automation_id); }) &&
      WindowsV1UiaRead([&] { return element->GetRuntimeId(&runtime_id); }) && runtime_id != nullptr &&
      SafeArrayGetDim(runtime_id) == 1;
  if (!facts) {
    if (automation_id != nullptr)
      SysFreeString(automation_id);
    if (runtime_id != nullptr)
      SafeArrayDestroy(runtime_id);
    return false;
  }
  LONG lower = 0;
  LONG upper = -1;
  LONG *runtime_values = nullptr;
  const bool bounded_shape =
      SUCCEEDED(SafeArrayGetLBound(runtime_id, 1, &lower)) &&
      SUCCEEDED(SafeArrayGetUBound(runtime_id, 1, &upper)) && upper >= lower &&
      upper - lower < 64;
  const HRESULT accessed =
      bounded_shape
          ? SafeArrayAccessData(runtime_id,
                                reinterpret_cast<void **>(&runtime_values))
          : E_FAIL;
  if (!bounded_shape || FAILED(accessed) || runtime_values == nullptr) {
    if (SUCCEEDED(accessed))
      SafeArrayUnaccessData(runtime_id);
    if (automation_id != nullptr)
      SysFreeString(automation_id);
    SafeArrayDestroy(runtime_id);
    return false;
  }
  std::string material =
      "computer-control-element-v1\n" + std::to_string(control_type) + "\n" +
      std::to_string(bounds.left) + "," + std::to_string(bounds.top) + "," +
      std::to_string(bounds.right) + "," + std::to_string(bounds.bottom) + "\n";
  for (LONG index = lower; index <= upper; ++index)
    material += std::to_string(runtime_values[index - lower]) + ",";
  SafeArrayUnaccessData(runtime_id);
  SafeArrayDestroy(runtime_id);
  material += "\n";
  if (automation_id != nullptr) {
    material += Utf8FromWide(
        std::wstring_view(automation_id, SysStringLen(automation_id)));
    SysFreeString(automation_id);
  }
  *signature = Sha256String(material);
  return signature->size() == 64;
}

struct WindowsControlBindings {
  std::unordered_map<std::string, std::string> semantic;
  std::set<std::string> visual;
};

bool ReadWindowsElementTargetId(IUIAutomationElement *element,
                                std::string *target_id) {
  if (element == nullptr || target_id == nullptr)
    return false;
  BSTR automation_id = nullptr;
  BSTR name = nullptr;
  const bool read =
      WindowsV1UiaRead([&] { return element->get_CurrentAutomationId(&automation_id); }) &&
      WindowsV1UiaRead([&] { return element->get_CurrentName(&name); });
  if (!read) {
    if (automation_id != nullptr)
      SysFreeString(automation_id);
    if (name != nullptr)
      SysFreeString(name);
    return false;
  }
  const std::string automation_utf8 =
      automation_id == nullptr
          ? std::string{}
          : Utf8FromWide(std::wstring_view(automation_id, SysStringLen(automation_id)));
  const std::string name_utf8 =
      name == nullptr
          ? std::string{}
          : Utf8FromWide(std::wstring_view(name, SysStringLen(name)));
  const bool text_converted =
      (automation_id == nullptr || SysStringLen(automation_id) == 0 ||
       !automation_utf8.empty()) &&
      (name == nullptr || SysStringLen(name) == 0 || !name_utf8.empty());
  if (!text_converted) {
    if (automation_id != nullptr)
      SysFreeString(automation_id);
    if (name != nullptr)
      SysFreeString(name);
    return false;
  }
  if (automation_id != nullptr)
    SysFreeString(automation_id);
  if (name != nullptr)
    SysFreeString(name);
  *target_id = automation_utf8.empty() ? name_utf8 : automation_utf8;
  return target_id->size() <= 128;
}

bool CollectWindowsControlBindings(IUIAutomationElement *element,
                                   IUIAutomationTreeWalker *walker,
                                   std::uint32_t expected_pid, std::size_t depth,
                                   std::size_t *nodes,
                                   WindowsControlBindings *bindings,
                                   std::set<std::string> *duplicate_targets) {
  if (element == nullptr || walker == nullptr || nodes == nullptr || bindings == nullptr ||
      duplicate_targets == nullptr || depth > 16 || *nodes >= 5'000 || !WindowsV1UiaMayCall())
    return false;
  ++*nodes;
  WindowsV1UiaCountNode();

  std::string signature;
  if (!ComputeWindowsControlSignature(element, expected_pid, nullptr, &signature))
    return false;
  bindings->visual.insert(signature);

  std::string target_id;
  if (!ReadWindowsElementTargetId(element, &target_id))
    return false;
  if (!target_id.empty()) {
    if (duplicate_targets->contains(target_id)) {
      bindings->semantic.erase(target_id);
    } else if (bindings->semantic.contains(target_id)) {
      bindings->semantic.erase(target_id);
      duplicate_targets->insert(target_id);
    } else {
      bindings->semantic.emplace(target_id, signature);
    }
  }

  IUIAutomationElement *child = nullptr;
  const HRESULT first_result =
      WindowsV1UiaCall([&] { return walker->GetFirstChildElement(element, &child); });
  if (!WindowsV1UiaOk(first_result)) {
    if (child != nullptr)
      child->Release();
    return false;
  }
  while (child != nullptr) {
    if (!CollectWindowsControlBindings(child, walker, expected_pid, depth + 1, nodes,
                                       bindings, duplicate_targets)) {
      child->Release();
      return false;
    }
    IUIAutomationElement *next = nullptr;
    const HRESULT next_result =
        WindowsV1UiaCall([&] { return walker->GetNextSiblingElement(child, &next); });
    child->Release();
    if (!WindowsV1UiaOk(next_result)) {
      if (next != nullptr)
        next->Release();
      return false;
    }
    child = next;
  }
  return true;
}

bool CaptureWindowsControlBindings(std::uint32_t pid, HWND window,
                                  WindowsControlBindings *bindings) {
  if (bindings == nullptr)
    return false;
  const WindowsV1UiaPath path;
  IUIAutomation *automation = nullptr;
  if (FAILED(CreateWindowsV1Automation(&automation)) ||
      automation == nullptr)
    return false;
  IUIAutomationElement *root = nullptr;
  IUIAutomationTreeWalker *walker = nullptr;
  const bool initialized =
      WindowsV1UiaOk(WindowsV1UiaContact([&] { return automation->ElementFromHandle(window, &root); })) &&
      root != nullptr &&
      SUCCEEDED(automation->get_RawViewWalker(&walker)) && walker != nullptr;
  std::size_t nodes = 0;
  std::set<std::string> duplicate_targets;
  const bool complete =
      initialized && CollectWindowsControlBindings(root, walker, pid, 0, &nodes, bindings,
                                                   &duplicate_targets);
  if (root != nullptr)
    root->Release();
  if (walker != nullptr)
    walker->Release();
  automation->Release();
  return complete && nodes > 0 && nodes <= 5'000;
}

bool WindowsFocusedElementSignature(std::uint32_t expected_pid,
                                    const RECT &client_bounds,
                                    std::string *signature) {
  if (signature == nullptr)
    return false;
  const WindowsV1UiaPath path;
  IUIAutomation *automation = nullptr;
  if (FAILED(CreateWindowsV1Automation(&automation)) ||
      automation == nullptr)
    return false;
  IUIAutomationElement *element = nullptr;
  const HRESULT found =
      WindowsV1UiaContact([&] { return automation->GetFocusedElement(&element); });
  automation->Release();
  if (!WindowsV1UiaOk(found) || element == nullptr) {
    if (element != nullptr)
      element->Release();
    return false;
  }
  const bool result =
      ComputeWindowsControlSignature(element, expected_pid, &client_bounds, signature);
  element->Release();
  return result;
}

bool RejectWindowsRisk(const WindowsUiaRisk &risk, std::string *reason) {
  using namespace sprint_coder::computer_use;
  const auto decision = ClassifyNativePreflightFacts(
      {risk.metadata_complete, risk.classified, risk.secure, risk.high_impact});
  if (NativePreflightAllowsDispatch(decision)) return false;
  switch (decision.reason) {
    case NativePreflightReason::kSecure:
      *reason = "secure_field_blocked";
      break;
    case NativePreflightReason::kHighImpact:
      *reason = "high_impact_blocked";
      break;
    default:
      *reason = "target_unclassified";
      break;
  }
  return true;
}

bool FindUiaTargetRecursive(IUIAutomationElement *element,
                            IUIAutomationTreeWalker *walker,
                            std::string_view target_id, std::size_t depth,
                            std::size_t *visited, IUIAutomationElement **match,
                            bool *duplicate) {
  if (element == nullptr || walker == nullptr || depth > 16 ||
      *visited >= 5'000 || !WindowsV1UiaMayCall())
    return false;
  ++*visited;
  WindowsV1UiaCountNode();
  BSTR automation_id = nullptr;
  BSTR name = nullptr;
  const bool attributes_read =
      WindowsV1UiaRead([&] { return element->get_CurrentAutomationId(&automation_id); }) &&
      WindowsV1UiaRead([&] { return element->get_CurrentName(&name); });
  if (!attributes_read) {
    if (automation_id != nullptr)
      SysFreeString(automation_id);
    if (name != nullptr)
      SysFreeString(name);
    return false;
  }
  const std::string automation_utf8 =
      automation_id == nullptr
          ? std::string{}
          : Utf8FromWide(
                std::wstring_view(automation_id, SysStringLen(automation_id)));
  const std::string name_utf8 =
      name == nullptr
          ? std::string{}
          : Utf8FromWide(std::wstring_view(name, SysStringLen(name)));
  if (automation_id != nullptr)
    SysFreeString(automation_id);
  if (name != nullptr)
    SysFreeString(name);
  if (automation_utf8 == target_id ||
      (automation_utf8.empty() && name_utf8 == target_id)) {
    if (*match == nullptr) {
      element->AddRef();
      *match = element;
    } else {
      *duplicate = true;
    }
  }
  IUIAutomationElement *child = nullptr;
  if (!WindowsV1UiaOk(WindowsV1UiaCall([&] { return walker->GetFirstChildElement(element, &child); }))) {
    if (child != nullptr)
      child->Release();
    return false;
  }
  while (child != nullptr && !*duplicate) {
    if (!FindUiaTargetRecursive(child, walker, target_id, depth + 1, visited,
                                match, duplicate)) {
      child->Release();
      return false;
    }
    IUIAutomationElement *next = nullptr;
    if (!WindowsV1UiaOk(WindowsV1UiaCall([&] { return walker->GetNextSiblingElement(child, &next); }))) {
      if (next != nullptr)
        next->Release();
      child->Release();
      return false;
    }
    child->Release();
    child = next;
  }
  if (child != nullptr)
    child->Release();
  return !*duplicate;
}

bool FindWindowsSemanticTarget(const WindowsSession &session,
                               std::string_view target_id,
                               IUIAutomationElement **output,
                               std::string *reason) {
  if (target_id.empty() || target_id.size() > 128) {
    *reason = "target_required";
    return false;
  }
  IUIAutomation *automation = nullptr;
  if (FAILED(CreateWindowsV1Automation(&automation)) ||
      automation == nullptr) {
    *reason = "accessibility_unavailable";
    return false;
  }
  IUIAutomationElement *root = nullptr;
  IUIAutomationTreeWalker *walker = nullptr;
  const WindowsV1UiaPath path;
  const bool initialized =
      WindowsV1UiaOk(WindowsV1UiaContact([&] { return automation->ElementFromHandle(session.active_window, &root); })) &&
      root != nullptr && SUCCEEDED(automation->get_RawViewWalker(&walker)) &&
      walker != nullptr;
  std::size_t visited = 0;
  bool duplicate = false;
  IUIAutomationElement *match = nullptr;
  const bool searched =
      initialized && FindUiaTargetRecursive(root, walker, target_id, 0,
                                            &visited, &match, &duplicate);
  if (root != nullptr)
    root->Release();
  if (walker != nullptr)
    walker->Release();
  automation->Release();
  if (!searched || duplicate || match == nullptr) {
    if (match != nullptr)
      match->Release();
    // A call that timed out is not "no such target": the target did not answer (transient).
    *reason = duplicate ? "target_ambiguous"
              : path.Stop() == WindowsV1UiaStop::kTimeout ? "accessibility_timeout"
                                                          : "target_required";
    return false;
  }
  *output = match;
  return true;
}

bool Utf16FromUtf8(std::string_view value, std::wstring *output) {
  if (value.empty() || value.size() > 4'096)
    return false;
  const int length =
      MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                          static_cast<int>(value.size()), nullptr, 0);
  if (length <= 0)
    return false;
  std::wstring converted(static_cast<std::size_t>(length), L'\0');
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                          static_cast<int>(value.size()), converted.data(),
                          length) != length)
    return false;
  *output = std::move(converted);
  return true;
}

// A pattern of the target, read through the timed read. A read that did not complete (it timed out, or
// "succeeded" too slowly to be believed) hands nothing back: a pattern it did produce is released here,
// so the caller never holds, or acts on, the answer of a target that stopped answering.
template <class Pattern>
bool ReadWindowsV1Pattern(IUIAutomationElement *target, PATTERNID id, Pattern **pattern) {
  *pattern = nullptr;
  const bool read = WindowsV1UiaRead([&] { return target->GetCurrentPatternAs(id, IID_PPV_ARGS(pattern)); });
  if (!read || *pattern == nullptr) {
    if (*pattern != nullptr)
      (*pattern)->Release();
    *pattern = nullptr;
    return false;
  }
  return true;
}

bool DispatchWindowsSemanticAction(const WindowsSession &session,
                                   const RECT &expected,
                                   std::uint64_t expected_epoch,
                                   std::string_view kind,
                                   const std::string &metadata, bool *accepted,
                                   std::string *reason) {
  std::string target_id;
  if (!ReadJsonString(metadata, "targetId", &target_id)) {
    *reason = "target_required";
    return false;
  }
  IUIAutomationElement *target = nullptr;
  if (!FindWindowsSemanticTarget(session, target_id, &target, reason))
    return false;
  std::string current_target_signature;
  const auto observed_target = session.semantic_control_signatures.find(target_id);
  if (observed_target == session.semantic_control_signatures.end() ||
      !ComputeWindowsControlSignature(target, session.pid, nullptr,
                                      &current_target_signature) ||
      current_target_signature != observed_target->second) {
    target->Release();
    *reason = "stale_target";
    return false;
  }
  if (RejectWindowsRisk(ClassifyWindowsUiaElement(target), reason)) {
    target->Release();
    return false;
  }
  if (!RevalidateWindowsTarget(session, expected, expected_epoch)) {
    target->Release();
    *reason = "stale_target";
    return false;
  }

  HRESULT action_result = E_FAIL;
  if (kind == "invoke") {
    IUIAutomationInvokePattern *pattern = nullptr;
    if (ReadWindowsV1Pattern(target, UIA_InvokePatternId, &pattern)) {
      // The action is SENT only while the path is alive: after a timeout or a Cancel nothing is done
      // (a rejection before any input), never a call that cannot be confirmed.
      if (!WindowsV1UiaMayCall()) {
        *reason = WindowsV1UiaEndedReason();
      } else {
        *accepted = true;
        session.input_api_attempts->fetch_add(1, std::memory_order_acq_rel);
        action_result = pattern->Invoke();
      }
      pattern->Release();
    } else {
      *reason = "semantic_pattern_unavailable";
    }
  } else if (kind == "set_text") {
    std::string text;
    std::wstring wide_text;
    IUIAutomationValuePattern *pattern = nullptr;
    if (!ReadJsonString(metadata, "text", &text) ||
        !Utf16FromUtf8(text, &wide_text)) {
      *reason = "invalid_text";
    } else if (ReadWindowsV1Pattern(target, UIA_ValuePatternId, &pattern)) {
      BSTR value = SysAllocStringLen(wide_text.data(),
                                    static_cast<UINT>(wide_text.size()));
      if (value == nullptr && !wide_text.empty()) {
        *reason = "semantic_action_failed";
      } else {
        // The action is SENT only while the path is alive: after a timeout or a Cancel nothing is done
        // (a rejection before any input), never a call that cannot be confirmed.
        if (!WindowsV1UiaMayCall()) {
          *reason = WindowsV1UiaEndedReason();
        } else {
          *accepted = true;
          session.input_api_attempts->fetch_add(1, std::memory_order_acq_rel);
          action_result = pattern->SetValue(value);
        }
      }
      if (value != nullptr)
        SysFreeString(value);
      pattern->Release();
    } else {
      *reason = "semantic_pattern_unavailable";
    }
  } else if (kind == "select") {
    std::string selected_value;
    IUIAutomationSelectionItemPattern *pattern = nullptr;
    BSTR name = nullptr;
    const bool name_read = WindowsV1UiaRead([&] { return target->get_CurrentName(&name); });
    const std::string target_name =
        name == nullptr || !name_read
            ? std::string{}
            : Utf8FromWide(std::wstring_view(name, SysStringLen(name)));
    if (name != nullptr)
      SysFreeString(name);
    if (!name_read) {
      // The target did not answer: nothing is compared with a name that was not read, and nothing is sent.
      *reason = WindowsV1UiaEndedReason();
    } else if (!ReadJsonString(metadata, "value", &selected_value) ||
        (selected_value != target_id && selected_value != target_name)) {
      *reason = "semantic_value_mismatch";
    } else if (ReadWindowsV1Pattern(target, UIA_SelectionItemPatternId, &pattern)) {
      // The action is SENT only while the path is alive: after a timeout or a Cancel nothing is done
      // (a rejection before any input), never a call that cannot be confirmed.
      if (!WindowsV1UiaMayCall()) {
        *reason = WindowsV1UiaEndedReason();
      } else {
        *accepted = true;
        session.input_api_attempts->fetch_add(1, std::memory_order_acq_rel);
        action_result = pattern->Select();
      }
      pattern->Release();
    } else {
      *reason = "semantic_pattern_unavailable";
    }
  } else if (kind == "toggle") {
    const bool wants_true =
        metadata.find("\"value\":true") != std::string::npos;
    const bool wants_false =
        metadata.find("\"value\":false") != std::string::npos;
    IUIAutomationTogglePattern *pattern = nullptr;
    if ((!wants_true && !wants_false) ||
        !ReadWindowsV1Pattern(target, UIA_TogglePatternId, &pattern) ||
        pattern == nullptr) {
      *reason = "semantic_pattern_unavailable";
    } else {
      ToggleState current = ToggleState_Indeterminate;
      if (!WindowsV1UiaRead([&] { return pattern->get_CurrentToggleState(&current); }) ||
          current == ToggleState_Indeterminate) {
        *reason = "semantic_state_unavailable";
      } else if ((current == ToggleState_On) == wants_true) {
        action_result = S_OK;
      } else {
        // The action is SENT only while the path is alive: after a timeout or a Cancel nothing is done
        // (a rejection before any input), never a call that cannot be confirmed.
        if (!WindowsV1UiaMayCall()) {
          *reason = WindowsV1UiaEndedReason();
        } else {
          *accepted = true;
          session.input_api_attempts->fetch_add(1, std::memory_order_acq_rel);
          action_result = pattern->Toggle();
        }
      }
      pattern->Release();
    }
  } else if (kind == "expand_collapse") {
    const bool wants_expand =
        metadata.find("\"expanded\":true") != std::string::npos;
    const bool wants_collapse =
        metadata.find("\"expanded\":false") != std::string::npos;
    IUIAutomationExpandCollapsePattern *pattern = nullptr;
    if ((!wants_expand && !wants_collapse) ||
        !ReadWindowsV1Pattern(target, UIA_ExpandCollapsePatternId, &pattern) ||
        pattern == nullptr) {
      *reason = "semantic_pattern_unavailable";
    } else {
      ExpandCollapseState current = ExpandCollapseState_LeafNode;
      if (!WindowsV1UiaRead([&] { return pattern->get_CurrentExpandCollapseState(&current); }) ||
          current == ExpandCollapseState_LeafNode) {
        *reason = "semantic_state_unavailable";
      } else if ((current == ExpandCollapseState_Expanded) == wants_expand) {
        action_result = S_OK;
      } else {
        // The action is SENT only while the path is alive: after a timeout or a Cancel nothing is done
        // (a rejection before any input), never a call that cannot be confirmed.
        if (!WindowsV1UiaMayCall()) {
          *reason = WindowsV1UiaEndedReason();
        } else {
          *accepted = true;
          session.input_api_attempts->fetch_add(1, std::memory_order_acq_rel);
          action_result = wants_expand ? pattern->Expand() : pattern->Collapse();
        }
      }
      pattern->Release();
    }
  }
  target->Release();
  if (FAILED(action_result) && !*accepted &&
      WindowsV1UiaCurrentStop() == WindowsV1UiaStop::kTimeout)
    *reason = "accessibility_timeout";
  if (FAILED(action_result)) {
    if (reason->empty())
      // A pattern call (Invoke, SetValue, Select, Toggle, Expand) that timed out may still have been
      // applied by the target: unconfirmed, and told apart from the other failures so that the caller
      // does not repeat the action blindly (a retry is the agent's decision, after a new observation).
      *reason = !*accepted ? "semantic_action_failed"
                : WindowsV1UiaIsTimeout(action_result) ? "input_timeout_unconfirmed"
                                                       : "input_not_confirmed";
    return false;
  }
  return true;
}

std::string ResponseCacheKey(const Frame &request) {
  std::string identity;
  identity.reserve(sizeof(request.header.message_type) +
                   request.header.session_id.bytes.size() +
                   request.header.request_id.bytes.size());
  identity.append(reinterpret_cast<const char *>(&request.header.message_type),
                  sizeof(request.header.message_type));
  identity.append(
      reinterpret_cast<const char *>(request.header.session_id.bytes.data()),
      request.header.session_id.bytes.size());
  identity.append(
      reinterpret_cast<const char *>(request.header.request_id.bytes.data()),
      request.header.request_id.bytes.size());
  return identity;
}

bool IsLowerHexDigest64(std::string_view value) {
  if (value.size() != 64) return false;
  for (const char c : value)
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  return true;
}

// A dispatch carries the ticket its preflight issued, but a repeat of a finished request is answered
// from the cache whatever ticket (or none) it carries, so the request identity used for that
// comparison leaves the ticket out. Only the exact `"ticket":"<64 lowercase hex>"` member is
// removed; a text field that merely contains those characters has them escaped and never matches.
std::string WithoutDispatchTicket(const std::string &metadata) {
  const std::string needle = "\"ticket\":\"";
  for (std::size_t at = metadata.find(needle); at != std::string::npos;
       at = metadata.find(needle, at + 1)) {
    const std::size_t value_at = at + needle.size();
    if (value_at + 65 > metadata.size() ||
        !IsLowerHexDigest64(std::string_view(metadata).substr(value_at, 64)) ||
        metadata[value_at + 64] != '"')
      continue;
    std::size_t begin = at;
    std::size_t end = value_at + 65;
    if (begin > 0 && metadata[begin - 1] == ',')
      --begin;
    else if (end < metadata.size() && metadata[end] == ',')
      ++end;
    return metadata.substr(0, begin) + metadata.substr(end);
  }
  return metadata;
}

std::string RequestPayloadDigest(const Frame &request) {
  // The metadata the request is compared by. For a dispatch that leaves out the ticket, and the
  // length that goes into the digest is the length of what is compared, not of what was sent.
  std::string metadata(reinterpret_cast<const char *>(request.metadata.data()),
                       request.metadata.size());
  if (request.header.message_type ==
      static_cast<std::uint16_t>(MessageType::kDispatch))
    metadata = WithoutDispatchTicket(metadata);
  const std::uint32_t metadata_bytes =
      request.header.message_type ==
              static_cast<std::uint16_t>(MessageType::kDispatch)
          ? static_cast<std::uint32_t>(metadata.size())
          : request.header.metadata_bytes;
  std::string payload;
  payload.reserve(sizeof(metadata_bytes) + metadata.size() +
                  sizeof(request.header.binary_bytes) + request.binary.size());
  payload.append(reinterpret_cast<const char *>(&metadata_bytes),
                 sizeof(metadata_bytes));
  payload.append(metadata);
  payload.append(reinterpret_cast<const char *>(&request.header.binary_bytes),
                 sizeof(request.header.binary_bytes));
  if (!request.binary.empty())
    payload.append(reinterpret_cast<const char *>(request.binary.data()),
                   request.binary.size());
  return Sha256String(payload);
}

bool RevalidateWindowsTarget(const WindowsSession &session,
                             const RECT &expected,
                             std::uint64_t expected_epoch) {
  if (parent_process_dead.load(std::memory_order_acquire) ||
      !session.has_observation || session.active_window == nullptr ||
      GetForegroundWindow() != session.active_window ||
      session.cancel_epoch != expected_epoch ||
      cancellation_epoch.load(std::memory_order_acquire) != expected_epoch)
    return false;
  RECT current{};
  std::string reason;
  WindowsDialogSetSnapshot dialogs;
  if (!ValidateWindowsSession(session, &current, &reason, &dialogs) ||
      dialogs.digest != session.dialog_set_digest ||
      dialogs.active_window != session.active_window ||
      dialogs.active_identity != session.active_window_identity ||
      dialogs.active_kind != session.active_window_kind)
    return false;
  return current.left == expected.left && current.top == expected.top &&
         current.right == expected.right && current.bottom == expected.bottom;
}

UINT SendInputForBoundTarget(const WindowsSession &session,
                             const RECT &expected, std::uint64_t expected_epoch,
                             UINT count, LPINPUT events) {
  if (!RevalidateWindowsTarget(session, expected, expected_epoch)) return 0;
  session.input_api_attempts->fetch_add(1, std::memory_order_acq_rel);
  return SendInput(count, events, sizeof(INPUT));
}

WORD VirtualKeyForName(std::string_view key) {
  static const std::unordered_map<std::string_view, WORD> keys = {
      {"Enter", VK_RETURN},   {"Tab", VK_TAB},        {"Escape", VK_ESCAPE},
      {"Backspace", VK_BACK}, {"Delete", VK_DELETE},  {"ArrowUp", VK_UP},
      {"ArrowDown", VK_DOWN}, {"ArrowLeft", VK_LEFT}, {"ArrowRight", VK_RIGHT},
      {"Home", VK_HOME},      {"End", VK_END},
  };
  const auto found = keys.find(key);
  return found == keys.end() ? 0 : found->second;
}

bool SendUnicodeScalar(const WindowsSession &session, const RECT &expected,
                       std::uint64_t expected_epoch, std::uint32_t scalar,
                       bool *accepted) {
  if (!RevalidateWindowsTarget(session, expected, expected_epoch))
    return false;
  INPUT events[2]{};
  events[0].type = INPUT_KEYBOARD;
  events[0].ki.wVk = 0;
  events[0].ki.wScan = static_cast<WORD>(
      scalar <= 0xffff ? scalar : 0xd800 + ((scalar - 0x10000) >> 10));
  events[0].ki.dwFlags = KEYEVENTF_UNICODE;
  events[1] = events[0];
  events[1].ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
  if (scalar > 0xffff) {
    // SendInput's KEYEVENTF_UNICODE consumes UTF-16 units. A supplementary
    // scalar is emitted as a surrogate pair in two complete down/up pairs, with
    // a fresh focus check for each unit.
    const std::uint32_t pair = scalar - 0x10000;
    events[0].ki.wScan = static_cast<WORD>(0xd800 + (pair >> 10));
    events[1].ki.wScan = events[0].ki.wScan;
    const UINT first_pair_sent =
        SendInputForBoundTarget(session, expected, expected_epoch, 2, events);
    if (first_pair_sent > 0)
      *accepted = true;
    if (first_pair_sent != 2 ||
        !RevalidateWindowsTarget(session, expected, expected_epoch))
      return false;
    events[0].ki.wScan = static_cast<WORD>(0xdc00 + (pair & 0x3ff));
    events[1].ki.wScan = events[0].ki.wScan;
  }
  const UINT sent =
      SendInputForBoundTarget(session, expected, expected_epoch, 2, events);
  if (sent > 0)
    *accepted = true;
  return sent == 2 &&
         RevalidateWindowsTarget(session, expected, expected_epoch);
}

bool DecodeUtf8Scalars(std::string_view text,
                       std::vector<std::uint32_t> *output) {
  // The Windows helper accepts the same 4096-byte UTF-8 text ceiling as Main.
  // WideCharToMultiByte is not used here because it can replace malformed
  // sequences instead of rejecting them.
  if (text.empty() || text.size() > 4'096)
    return false;
  for (std::size_t index = 0; index < text.size();) {
    const auto first = static_cast<unsigned char>(text[index]);
    std::uint32_t scalar = 0;
    std::size_t width = 0;
    if (first <= 0x7f) {
      scalar = first;
      width = 1;
    } else if (first >= 0xc2 && first <= 0xdf) {
      scalar = first & 0x1f;
      width = 2;
    } else if (first >= 0xe0 && first <= 0xef) {
      scalar = first & 0x0f;
      width = 3;
    } else if (first >= 0xf0 && first <= 0xf4) {
      scalar = first & 0x07;
      width = 4;
    } else {
      return false;
    }
    if (index + width > text.size())
      return false;
    for (std::size_t offset = 1; offset < width; ++offset) {
      const auto byte = static_cast<unsigned char>(text[index + offset]);
      if ((byte & 0xc0) != 0x80)
        return false;
      scalar = (scalar << 6) | (byte & 0x3f);
    }
    if (scalar > 0x10ffff || (scalar >= 0xd800 && scalar <= 0xdfff) ||
        (width == 3 && scalar < 0x800) || (width == 4 && scalar < 0x10000))
      return false;
    if (!sprint_coder::computer_use::IsTypeTextScalar(scalar)) return false;
    output->push_back(scalar);
    index += width;
  }
  return !output->empty();
}

// What a dispatch needs before it may do anything, shared by the preflight (which issues the
// ticket) and the dispatch itself (which consumes it): the request names this session's current
// cancel epoch and observation, the bound window is still the observed one, and the key/type
// focus has not moved. It performs no input.
bool ValidateWindowsDispatchBinding(const WindowsSession &session,
                                    const std::string &metadata,
                                    std::string *kind, RECT *bounds,
                                    std::string *reason) {
  const std::uint64_t expected_epoch = session.cancel_epoch;
  std::uint64_t requested_epoch = 0;
  std::uint64_t requested_observation = 0;
  if (!ReadJsonString(metadata, "type", kind) ||
      !ReadJsonUint64(metadata, "cancelEpoch", &requested_epoch) ||
      !ReadJsonUint64(metadata, "observationRevision",
                      &requested_observation) ||
      requested_epoch != expected_epoch || requested_observation == 0 ||
      !session.has_observation ||
      requested_observation != session.observation_revision) {
    *reason = "invalid_action";
    return false;
  }
  RECT current_bounds{};
  if (!ValidateWindowsSession(session, &current_bounds, reason))
    return false;
  const RECT observed = session.observation_bounds;
  if (current_bounds.left != observed.left ||
      current_bounds.top != observed.top ||
      current_bounds.right != observed.right ||
      current_bounds.bottom != observed.bottom ||
      !RevalidateWindowsTarget(session, observed, expected_epoch)) {
    *reason = "stale_target";
    return false;
  }
  if (*kind == "key" || *kind == "type") {
    std::string current_focused_signature;
    if (!session.has_focused_element_signature ||
        !WindowsFocusedElementSignature(session.pid, observed,
                                        &current_focused_signature) ||
        current_focused_signature != session.focused_element_signature) {
      *reason = "focused_target_changed";
      return false;
    }
  }
  *bounds = observed;
  return true;
}

void AppendDigestField(std::string *frame, std::string_view name,
                       std::string_view value, bool present) {
  frame->append(std::to_string(name.size()));
  frame->push_back(':');
  frame->append(name);
  frame->push_back(present ? '1' : '0');
  frame->append(std::to_string(value.size()));
  frame->push_back(':');
  frame->append(value);
}

// The fields the dispatch reads from the request, framed so adjacent fields cannot run together and
// an absent field differs from an empty one. A field the dispatch does not read cannot change what
// it does, so it is not bound.
std::string WindowsDispatchPayloadDigest(const std::string &metadata) {
  std::string frame = "windows-dispatch-payload-v1";
  for (const char *name : {"type", "targetId", "name", "key", "text", "value",
                           "button"}) {
    std::string value;
    const bool present = ReadJsonString(metadata, name, &value);
    AppendDigestField(&frame, name, value, present);
  }
  for (const char *name : {"x", "y", "deltaX", "deltaY"}) {
    double number = 0;
    const bool present = ReadJsonDouble(metadata, name, &number);
    char text[48]{};
    if (present) std::snprintf(text, sizeof(text), "%.17g", number);
    AppendDigestField(&frame, name, text, present);
  }
  // The booleans a toggle and an expand/collapse are decided by, read with the same text search the
  // dispatch uses (true, false or absent), so a flipped target state cannot ride on the same ticket.
  for (const char *name : {"value", "expanded"}) {
    const std::string member = "\"" + std::string(name) + "\":";
    const bool is_true = metadata.find(member + "true") != std::string::npos;
    const bool is_false = metadata.find(member + "false") != std::string::npos;
    AppendDigestField(&frame, std::string(name) + "Boolean",
                      is_true ? "true" : (is_false ? "false" : ""),
                      is_true || is_false);
  }
  return Sha256String(frame);
}

// The session state a dispatch acts on, so a ticket measured against one window state is refused
// against another. It does not include the observation counters of this request (the binding does).
std::string WindowsDispatchContextDigest(const WindowsSession &session) {
  std::string frame = "windows-dispatch-context-v1";
  AppendDigestField(&frame, "app", session.app_identity, true);
  AppendDigestField(&frame, "window", session.window_identity, true);
  AppendDigestField(&frame, "activeWindow", session.active_window_identity, true);
  AppendDigestField(&frame, "activeKind", session.active_window_kind, true);
  AppendDigestField(&frame, "processStart", session.process_start, true);
  AppendDigestField(&frame, "pid", std::to_string(session.pid), true);
  AppendDigestField(&frame, "dialogs", session.dialog_set_digest, true);
  AppendDigestField(&frame, "dialogRevision",
                    std::to_string(session.dialog_set_revision), true);
  AppendDigestField(&frame, "observation",
                    std::to_string(session.observation_revision), true);
  const RECT bounds = session.observation_bounds;
  AppendDigestField(&frame, "bounds",
                    std::to_string(bounds.left) + "," +
                        std::to_string(bounds.top) + "," +
                        std::to_string(bounds.right) + "," +
                        std::to_string(bounds.bottom),
                    true);
  AppendDigestField(&frame, "focused", session.focused_element_signature,
                    session.has_focused_element_signature);
  return Sha256String(frame);
}

std::uint64_t MonotonicNowNs() {
  return static_cast<std::uint64_t>(
      std::chrono::duration_cast<std::chrono::nanoseconds>(
          std::chrono::steady_clock::now().time_since_epoch())
          .count());
}

// Overwrites a secret before its storage is released (the token and the receipt that carries it).
void ScrubString(std::string *value) {
  if (value == nullptr || value->empty()) return;
  SecureZeroMemory(value->data(), value->size());
  value->clear();
}

bool GenerateTicketToken(std::string *token) {
  std::array<std::uint8_t, 32> bytes{};
  token->clear();
  const bool generated =
      BCryptGenRandom(nullptr, bytes.data(), static_cast<ULONG>(bytes.size()),
                      BCRYPT_USE_SYSTEM_PREFERRED_RNG) == 0;
  if (generated) {
    static const char hex[] = "0123456789abcdef";
    for (const auto byte : bytes) {
      token->push_back(hex[byte >> 4]);
      token->push_back(hex[byte & 0x0f]);
    }
  }
  SecureZeroMemory(bytes.data(), bytes.size());
  return generated;
}

sprint_coder::computer_use::NativeOrdinaryTicketBinding WindowsTicketBinding(
    const WindowsSession &session, const std::string &request_id,
    const std::string &action_digest, const std::string &payload_digest,
    std::uint64_t cancel_epoch, std::uint64_t generation) {
  sprint_coder::computer_use::NativeOrdinaryTicketBinding binding;
  binding.session_id = session.session_id;
  binding.request_id = request_id;
  binding.action_digest = action_digest;
  binding.payload_digest = payload_digest;
  binding.context_digest = WindowsDispatchContextDigest(session);
  binding.cancel_epoch = cancel_epoch;
  binding.ticket_generation = generation;
  return binding;
}

// Consumes the ordinary ticket a dispatch carries. A request without the key is refused and leaves
// the slot alone; a request that carries it burns the slot whatever the outcome, and the
// generation advances so a ticket measured before cannot match again. Replays are answered from the
// response cache before this runs, so they need no ticket.
bool ConsumeWindowsDispatchTicket(const std::string &session_key,
                                  const WindowsSession &session,
                                  const std::string &metadata) {
  const auto found = ticket_states.find(session_key);
  std::string token;
  if (found == ticket_states.end() || !ReadJsonString(metadata, "ticket", &token))
    return false;
  WindowsTicketState &state = found->second;
  std::string request_id;
  std::string action_digest;
  std::uint64_t cancel_epoch = 0;
  const bool readable =
      ReadJsonString(metadata, "requestId", &request_id) &&
      ReadJsonString(metadata, "actionDigest", &action_digest) &&
      ReadJsonUint64(metadata, "cancelEpoch", &cancel_epoch) &&
      IsLowerHexDigest64(action_digest);
  const bool consumed =
      readable &&
      state.slot.Consume(
          token,
          WindowsTicketBinding(session, request_id, action_digest,
                               WindowsDispatchPayloadDigest(metadata),
                               cancel_epoch, state.generation),
          MonotonicNowNs());
  state.slot.Invalidate();
  ++state.generation;
  ScrubString(&token);
  return consumed && session.cancel_epoch == cancel_epoch;
}

// BEGIN click rule (#500 S5-c-2 PR-2)
// A single click on a passive item of a file manager only selects it (#777), unless it completes a
// double click or the file manager opens an item on one click (its "single click to open" setting).
// The portable rule is MayOpen; these are the facts only the host knows.

// Whether the user's file manager opens an item on ONE click. Read from the shell state each time.
// The state starts zeroed, so a read that fills nothing says "single click" (= it opens: fail
// closed). fDoubleClickInWebView is TRUE (-1) when a double click is required (the default).
bool WindowsSingleClickOpens() noexcept {
  SHELLSTATE state{};
  SHGetSetSettings(&state, SSF_DOUBLECLICKINWEBVIEW, FALSE);
  return state.fDoubleClickInWebView == 0;
}

// Whether a click made now may complete a double click. The OS pairs two presses within the
// double-click time, whoever sent them, and the earlier press is an input, so it is at or before the
// system's LAST input time: if that is older than the double-click time, no pair can form. That is all
// this asks (see RecentInputMayCompleteDoubleClick); it keeps no record of its own clicks and tells
// nobody's input from anybody's. The price: a click within the double-click time (500 ms by default)
// of any input, this helper's own included, counts as opening; the agent acts one step per model
// round trip, which is seconds. Anything this cannot read is "opens".
bool WindowsRecentInputMayPair() noexcept {
  LASTINPUTINFO info{};
  info.cbSize = sizeof(info);
  const bool read = GetLastInputInfo(&info) != FALSE;
  return sprint_coder::computer_use::RecentInputMayCompleteDoubleClick(
      read, read ? info.dwTime : 0, static_cast<std::uint32_t>(GetTickCount64()),
      GetDoubleClickTime());
}

// Whether a click opens what it lands on: the file manager opens on one click, or it may complete a
// double click.
bool WindowsClickOpens() noexcept {
  return WindowsSingleClickOpens() || WindowsRecentInputMayPair();
}

// What the interlock evaluation knew about the click when it ran (#500 S5-c-2 PR-5, review): whether
// the click is followed at all, whether it was already taken as opening, and the system's last input
// time at that moment. The evaluation can take up to the lane's hold limit; this lets the dispatch
// tell, just before it sends the click, that input came in after the evaluation.
struct WindowsClickBasis {
  bool tracked = false;
  bool opens = false;
  bool input_read = false;
  DWORD input_tick = 0;
};

bool WindowsReadLastInputTick(DWORD *tick) noexcept {
  LASTINPUTINFO info{};
  info.cbSize = sizeof(info);
  if (!GetLastInputInfo(&info)) return false;
  *tick = info.dwTime;
  return true;
}

// Whether input has come in since the evaluation, for a click the evaluation judged as NOT opening
// (a click already taken as opening has nothing to lose). The dispatch then stops the click before
// it is sent (fail closed): the verdict was made for a moment that is no longer the present one, and
// a person's click that now pairs with ours would open the item. A last input time that cannot be
// read counts as moved. The cost: a person moving the mouse during the evaluation stops the click
// (the agent tries again).
bool WindowsInputMovedSinceEvaluation(const WindowsClickBasis &basis) noexcept {
  if (!basis.tracked || basis.opens) return false;
  DWORD now_tick = 0;
  if (!basis.input_read || !WindowsReadLastInputTick(&now_tick)) return true;
  return now_tick != basis.input_tick;
}

// The v2 interlocks' answer for an action whose V1 binding is valid (defined with the synchronous
// entry): a refusal, or no verdict. A click fills `basis` with what the evaluation knew.
sprint_coder::computer_use::InterlockEvaluation
WindowsInterlockRefusal(const WindowsSession &session, const std::string &metadata,
                        const std::string &kind, WindowsClickBasis *basis = nullptr) noexcept;
// END click rule

// BEGIN windows action point
// The screen point a click or scroll lands on: the metadata's x / y (each in 0..1) mapped onto the
// bounds. THE one copy of the mapping: the dispatch, the effect shadow and the synchronous interlock
// entry all call it, so they cannot disagree about where an action lands. False (and no point) when
// x or y is missing or out of range.
bool WindowsActionPoint(const RECT &bounds, const std::string &metadata,
                        POINT *point) {
  double x = 0;
  double y = 0;
  if (!ReadJsonDouble(metadata, "x", &x) || !ReadJsonDouble(metadata, "y", &y) ||
      x < 0 || x > 1 || y < 0 || y > 1)
    return false;
  point->x = bounds.left + static_cast<LONG>(std::lround(
                               x * std::max<LONG>(0, bounds.right - bounds.left - 1)));
  point->y = bounds.top + static_cast<LONG>(std::lround(
                              y * std::max<LONG>(0, bounds.bottom - bounds.top - 1)));
  return true;
}
// END windows action point

bool DispatchWindowsAction(const WindowsSession &session,
                           const std::string &metadata, std::string *result,
                           std::string *reason, bool *accepted) {
  *accepted = false;
  const std::uint64_t expected_epoch = session.cancel_epoch;
  std::string kind;
  RECT bounds{};
  if (!ValidateWindowsDispatchBinding(session, metadata, &kind, &bounds, reason))
    return false;
  // The v2 interlocks again, right before any input (#500 S5-c-2 PR-5): the screen can have changed
  // since the preflight (the ticket lives seconds), and the click facts (the last input time) are read
  // again by the evaluation. A refusal is made before the first input API attempt, SetCursorPos or
  // SendInput. No verdict leaves the V1 guards below as they are.
  WindowsClickBasis click_basis;
  {
    const sprint_coder::computer_use::InterlockEvaluation evaluation =
        WindowsInterlockRefusal(session, metadata, kind, &click_basis);
    if (evaluation.Refuses()) {
      *reason = std::string(evaluation.verdict.DispatchCode());
      return false;
    }
  }
  // The evaluation took time (up to the lane's hold limit) after the binding check, and the focus
  // moved to another control of the same window in that time would send the key or the text to an
  // element the observation never saw. The same check as the binding's, again, before any input.
  if (kind == "key" || kind == "type") {
    std::string current_focused_signature;
    if (!session.has_focused_element_signature ||
        !WindowsFocusedElementSignature(session.pid, bounds, &current_focused_signature) ||
        current_focused_signature != session.focused_element_signature) {
      *reason = "focused_target_changed";
      return false;
    }
  }
  bool dispatched = false;
  if (kind == "click") {
    double x = 0;
    double y = 0;
    if (!ReadJsonDouble(metadata, "x", &x) ||
        !ReadJsonDouble(metadata, "y", &y) || x < 0 || x > 1 || y < 0 ||
        y > 1 || !RevalidateWindowsTarget(session, bounds, expected_epoch)) {
      *reason = "stale_target";
      return false;
    }
    POINT click_point{0, 0};
    if (!WindowsActionPoint(bounds, metadata, &click_point)) {
      *reason = "stale_target";
      return false;
    }
    const int screen_x = click_point.x;
    const int screen_y = click_point.y;
    std::string visual_signature;
    if (RejectWindowsRisk(ClassifyWindowsPoint({screen_x, screen_y},
                                               session.pid, &visual_signature),
                          reason))
      return false;
    if (visual_signature.empty() ||
        !session.visual_control_signatures.contains(visual_signature)) {
      *reason = "stale_target";
      return false;
    }
    if (!RevalidateWindowsTarget(session, bounds, expected_epoch)) {
      *reason = "stale_target";
      return false;
    }
    if (!RevalidateVisualPatch(session, x, y, reason) ||
        !RevalidateWindowsTarget(session, bounds, expected_epoch)) {
      if (reason->empty())
        *reason = "stale_target";
      return false;
    }
    session.input_api_attempts->fetch_add(1, std::memory_order_acq_rel);
    if (!SetCursorPos(screen_x, screen_y)) {
      *reason = "input_unavailable";
      return false;
    }
    std::string current_visual_signature;
    if (RejectWindowsRisk(ClassifyWindowsPoint({screen_x, screen_y},
                                               session.pid,
                                               &current_visual_signature),
                          reason))
      return false;
    if (current_visual_signature.empty() ||
        !session.visual_control_signatures.contains(current_visual_signature)) {
      *reason = "stale_target";
      return false;
    }
    if (!RevalidateWindowsTarget(session, bounds, expected_epoch)) {
      *reason = "stale_target";
      return false;
    }
    // Input came in after the interlock evaluation judged this click as not opening: it is not sent.
    // The reuse of "focused_target_changed" is on purpose (Main maps every code of this kind to the
    // same plain rejection): for a click it means "input from elsewhere came in after the
    // evaluation", not that the focus moved.
    if (WindowsInputMovedSinceEvaluation(click_basis)) {
      *reason = "focused_target_changed";
      return false;
    }
    INPUT events[2]{};
    events[0].type = INPUT_MOUSE;
    events[0].mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
    events[1] = events[0];
    events[1].mi.dwFlags = MOUSEEVENTF_LEFTUP;
    const UINT sent =
        SendInputForBoundTarget(session, bounds, expected_epoch, 2, events);
    if (sent > 0)
      *accepted = true;
    dispatched =
        sent == 2 && RevalidateWindowsTarget(session, bounds, expected_epoch);
  } else if (kind == "scroll") {
    double delta_y_value = 0;
    double delta_x_value = 0;
    double x = 0;
    double y = 0;
    if (!ReadJsonDouble(metadata, "deltaY", &delta_y_value) ||
        !ReadJsonDouble(metadata, "deltaX", &delta_x_value) ||
        !ReadJsonDouble(metadata, "x", &x) ||
        !ReadJsonDouble(metadata, "y", &y) || x < 0 || x > 1 || y < 0 ||
        y > 1) {
      *reason = "invalid_action";
      return false;
    }
    POINT point{0, 0};
    if (!WindowsActionPoint(bounds, metadata, &point)) {
      *reason = "invalid_action";
      return false;
    }
    std::string visual_signature;
    if (RejectWindowsRisk(
            ClassifyWindowsPoint(point, session.pid, &visual_signature),
            reason))
      return false;
    if (visual_signature.empty() ||
        !session.visual_control_signatures.contains(visual_signature)) {
      *reason = "stale_target";
      return false;
    }
    if (!RevalidateWindowsTarget(session, bounds, expected_epoch) ||
        !RevalidateVisualPatch(session, x, y, reason) ||
        !RevalidateWindowsTarget(session, bounds, expected_epoch)) {
      if (reason->empty())
        *reason = "stale_target";
      return false;
    }
    session.input_api_attempts->fetch_add(1, std::memory_order_acq_rel);
    if (!SetCursorPos(point.x, point.y)) {
      *reason = "input_unavailable";
      return false;
    }
    std::string current_visual_signature;
    if (RejectWindowsRisk(
            ClassifyWindowsPoint(point, session.pid, &current_visual_signature),
            reason))
      return false;
    if (current_visual_signature.empty() ||
        !session.visual_control_signatures.contains(current_visual_signature)) {
      *reason = "stale_target";
      return false;
    }
    const auto delta_y = static_cast<std::int32_t>(delta_y_value);
    const auto delta_x = static_cast<std::int32_t>(delta_x_value);
    if ((delta_x == 0 && delta_y == 0) || delta_x < -10'000 ||
        delta_x > 10'000 || delta_y < -10'000 || delta_y > 10'000 ||
        !RevalidateWindowsTarget(session, bounds, expected_epoch)) {
      *reason = "stale_target";
      return false;
    }
    dispatched = true;
    if (delta_y != 0) {
      INPUT vertical{};
      vertical.type = INPUT_MOUSE;
      vertical.mi.mouseData = static_cast<DWORD>(delta_y * WHEEL_DELTA);
      vertical.mi.dwFlags = MOUSEEVENTF_WHEEL;
      const UINT sent = SendInputForBoundTarget(session, bounds, expected_epoch,
                                                1, &vertical);
      if (sent > 0)
        *accepted = true;
      dispatched =
          sent == 1 && RevalidateWindowsTarget(session, bounds, expected_epoch);
    }
    if (dispatched && delta_x != 0) {
      INPUT horizontal{};
      horizontal.type = INPUT_MOUSE;
      horizontal.mi.mouseData = static_cast<DWORD>(delta_x * WHEEL_DELTA);
      horizontal.mi.dwFlags = MOUSEEVENTF_HWHEEL;
      const UINT sent = SendInputForBoundTarget(session, bounds, expected_epoch,
                                                1, &horizontal);
      if (sent > 0)
        *accepted = true;
      dispatched =
          sent == 1 && RevalidateWindowsTarget(session, bounds, expected_epoch);
    }
  } else if (kind == "key") {
    std::string key;
    const WORD virtual_key =
        ReadJsonString(metadata, "key", &key) ? VirtualKeyForName(key) : 0;
    if (virtual_key == 0 ||
        !RevalidateWindowsTarget(session, bounds, expected_epoch)) {
      *reason = "invalid_key";
      return false;
    }
    if (RejectWindowsRisk(ClassifyWindowsFocusedElement(session.pid), reason))
      return false;
    if (!RevalidateWindowsTarget(session, bounds, expected_epoch)) {
      *reason = "stale_target";
      return false;
    }
    INPUT events[2]{};
    events[0].type = INPUT_KEYBOARD;
    events[0].ki.wVk = virtual_key;
    events[1] = events[0];
    events[1].ki.dwFlags = KEYEVENTF_KEYUP;
    const UINT sent =
        SendInputForBoundTarget(session, bounds, expected_epoch, 2, events);
    if (sent > 0)
      *accepted = true;
    dispatched =
        sent == 2 && RevalidateWindowsTarget(session, bounds, expected_epoch);
  } else if (kind == "type") {
    std::string text;
    std::vector<std::uint32_t> scalars;
    if (!ReadJsonString(metadata, "text", &text) ||
        !DecodeUtf8Scalars(text, &scalars) || scalars.size() != 1) {
      *reason = "invalid_text";
      return false;
    }
    if (RejectWindowsRisk(ClassifyWindowsFocusedElement(session.pid), reason))
      return false;
    dispatched = true;
    for (const auto scalar : scalars) {
      if (!SendUnicodeScalar(session, bounds, expected_epoch, scalar,
                             accepted)) {
        dispatched = false;
        break;
      }
    }
  } else if (kind == "invoke" || kind == "set_text" || kind == "select" ||
             kind == "toggle" || kind == "expand_collapse") {
    dispatched =
        DispatchWindowsSemanticAction(session, bounds, expected_epoch, kind,
                                      metadata, accepted, reason) &&
        RevalidateWindowsTarget(session, bounds, expected_epoch);
    if (!dispatched && *accepted && reason->empty())
      *reason = "input_not_confirmed";
  } else {
    *reason = "unsupported_action";
    return false;
  }
  if (!dispatched) {
    if (*accepted) {
      // A pattern call that timed out keeps its own reason (input_timeout_unconfirmed); every other
      // input that was sent and not confirmed is input_not_confirmed.
      if (*reason != "input_timeout_unconfirmed")
        *reason = "input_not_confirmed";
    } else if (cancellation_epoch.load(std::memory_order_acquire) !=
             expected_epoch)
      *reason = "canceled";
    else if (reason->empty())
      *reason = "input_not_confirmed";
    return false;
  }
  *result = "completed";
  reason->clear();
  return true;
}

BackendProbe ProbeBackend() {
  BackendProbe result;
  const auto build = WindowsBuildNumber();
  result.os_supported = build >= kMinimumWindowsBuild;
  result.ui_automation = result.os_supported && HasUiAutomation();
  // The process-level probe proves the WGC API factory only. A real
  // single-window frame requires a user-selected, foreground, identity-bound
  // target and is therefore checked by `observe`. Probe must neither fabricate
  // a target nor require a full-screen fallback.
  result.graphics_capture = result.os_supported && HasGraphicsCaptureFactory();
  result.send_input = result.os_supported;
  return result;
}

std::string ProbeJson(const BackendProbe &probe) {
  const bool backend_ready = probe.os_supported && probe.ui_automation &&
                             probe.graphics_capture && probe.send_input;
  const char *reason = !probe.os_supported    ? "WINDOWS_BUILD_UNSUPPORTED"
                       : !probe.ui_automation ? "UI_AUTOMATION_UNAVAILABLE"
                       : !probe.graphics_capture
                           ? "GRAPHICS_CAPTURE_UNAVAILABLE"
                           : "READY";
  return std::string("{\"protocolVersion\":") +
         std::to_string(kProtocolVersion) +
         ",\"apiVersion\":" + std::to_string(kApiVersion) +
         ",\"sourceCommit\":\"" + std::string(kSourceCommit) + "\"" +
         ",\"backend\":\"windows-uia-graphics-capture-sendinput\"" +
         ",\"platform\":\"win32\",\"architecture\":\"x64\",\"napiVersion\":10" +
         ",\"available\":" + (backend_ready ? "true" : "false") +
         ",\"capabilities\":{"
         "\"observe\":" +
         (backend_ready ? "true" : "false") +
         ",\"control\":" + (backend_ready ? "true" : "false") +
         ",\"uiAutomation\":" + (probe.ui_automation ? "true" : "false") +
         ",\"graphicsCapture\":" + (probe.graphics_capture ? "true" : "false") +
         ",\"sendInput\":" + (probe.send_input ? "true" : "false") +
         "},\"eligibility\":{\"mode\":\"" +
         std::string(sprint_coder::computer_use::kNativeEligibilityModeName) +
         "\",\"rulesetVersion\":" +
         std::to_string(sprint_coder::computer_use::kNativeEligibilityRulesetVersion) +
         ",\"classifierVersion\":" +
         std::to_string(sprint_coder::computer_use::kNativeEligibilityClassifierVersion) +
         ",\"lexiconVersion\":" +
         std::to_string(sprint_coder::computer_use::kNativeEligibilityLexiconVersion) +
         ",\"ticketRequired\":" +
         (sprint_coder::computer_use::kNativeEligibilityTicketRequired ? "true" : "false") +
         "},\"reason\":\"" + reason + "\"}\n";
}

std::string ErrorPayload(std::string_view code, bool accepted = false) {
  return std::string("{\"result\":\"rejected\",\"code\":\"") +
         std::string(code) +
         "\",\"accepted\":" + (accepted ? "true" : "false") + "}";
}

bool Respond(HANDLE pipe, const Frame &request, MessageType type,
             std::string_view payload,
             std::span<const std::uint8_t> binary = {}) {
  FrameHeader response = request.header;
  response.message_type = static_cast<std::uint16_t>(type);
  response.cancel_id = {};
  return WriteFrame(pipe, response, payload, binary);
}

bool RespondAndCache(HANDLE pipe, const Frame &request, MessageType type,
                     std::string payload,
                     std::vector<std::uint8_t> binary = {}) {
  const std::string key = ResponseCacheKey(request);
  const std::string request_digest = RequestPayloadDigest(request);
  if (request_digest.size() != 64)
    return false;
  if (!response_cache.contains(key)) {
    const std::size_t incoming_bytes = payload.size() + binary.size();
    while (
        !response_cache_order.empty() &&
        (response_cache_order.size() >= kMaximumCachedResponses ||
         response_cache_bytes + incoming_bytes > kMaximumResponseCacheBytes)) {
      const auto evicted = response_cache.find(response_cache_order.front());
      if (evicted != response_cache.end()) {
        response_cache_bytes -=
            evicted->second.metadata.size() + evicted->second.binary.size();
        response_cache.erase(evicted);
      }
      response_cache_order.pop_front();
    }
    if (incoming_bytes > kMaximumResponseCacheBytes)
      return false;
    response_cache_order.push_back(key);
    response_cache_bytes += incoming_bytes;
    response_cache.emplace(
        key, CachedResponse{type, request_digest, std::move(payload),
                            std::move(binary)});
  }
  const auto found = response_cache.find(key);
  return found != response_cache.end() &&
         Respond(pipe, request, found->second.type, found->second.metadata,
                 found->second.binary);
}

bool ReplayCachedResponse(HANDLE pipe, const Frame &request, bool *replayed) {
  const auto found = response_cache.find(ResponseCacheKey(request));
  if (found == response_cache.end()) {
    *replayed = false;
    return true;
  }
  *replayed = true;
  const std::string request_digest = RequestPayloadDigest(request);
  if (request_digest.size() != 64)
    return false;
  if (found->second.request_digest != request_digest)
    return Respond(pipe, request, MessageType::kError,
                   ErrorPayload("request_id_conflict"));
  return Respond(pipe, request, found->second.type, found->second.metadata,
                 found->second.binary);
}

WindowsSession *FindWindowsSession(const Frame &request) {
  const auto found = sessions.find(FrameIdKey(request.header.session_id));
  return found == sessions.end() ? nullptr : &found->second;
}

std::string WindowsPreflightReceipt(const WindowsSession &session,
                                    const std::string &request_id,
                                    std::uint64_t cancel_epoch,
                                    std::uint64_t observation_revision,
                                    std::string_view decision,
                                    std::string_view denied_reason,
                                    const std::string &ticket,
                                    std::string_view refusal_result = "rejected") {
  const bool denied = decision == "denied";
  const bool ordinary = decision == "ordinary";
  // A v2 refusal (blocked / takeover) carries its reason and the result of its own table row.
  const bool refused = decision == "blocked" || decision == "takeover";
  const bool with_reason = denied || refused;
  return "{\"decision\":\"" + std::string(decision) +
         "\",\"reasonCode\":" +
         (with_reason ? "\"" + std::string(denied_reason) + "\"" : std::string("null")) +
         ",\"deniedResult\":" +
         (denied ? "\"rejected\""
                 : (refused ? "\"" + std::string(refusal_result) + "\"" : std::string("null"))) +
         ",\"ticket\":" + (ordinary ? "\"" + ticket + "\"" : "null") +
         ",\"classifierVersion\":" +
         std::to_string(sprint_coder::computer_use::kNativePreflightClassifierVersion) +
         ",\"inputAttemptCount\":" +
         std::to_string(session.input_api_attempts->load(std::memory_order_acquire)) +
         ",\"requestId\":\"" + JsonEscape(request_id) + "\",\"sessionId\":\"" +
         JsonEscape(session.session_id) + "\",\"cancelEpoch\":" +
         std::to_string(cancel_epoch) + ",\"observationRevision\":" +
         std::to_string(observation_revision) + "}";
}

// The wire request id of the dispatch for a request id, derived the way Main derives it
// (the first 16 bytes of SHA-256("request:" + id)), so a finished dispatch can be found in the
// response cache from the preflight that precedes its repeat.
bool DispatchFrameIdFor(const std::string &request_id,
                        sprint_coder::computer_use::FrameId *id) {
  const std::string digest = Sha256String("request:" + request_id);
  if (digest.size() < 32) return false;
  for (std::size_t index = 0; index < 16; ++index) {
    const auto nibble = [](char c) -> int {
      return c >= '0' && c <= '9' ? c - '0' : (c >= 'a' && c <= 'f' ? c - 'a' + 10 : -1);
    };
    const int high = nibble(digest[index * 2]);
    const int low = nibble(digest[index * 2 + 1]);
    if (high < 0 || low < 0) return false;
    id->bytes[index] = static_cast<std::uint8_t>(high * 16 + low);
  }
  return true;
}

// Side-effect-free: it makes no input call. It checks the same binding a dispatch checks, and on
// success issues the one ordinary ticket that dispatch must present. Risk classification of the
// target stays in the dispatch for now, so a secure or high-impact target is refused there exactly
// as before; this step only decides whether a dispatch may start. A preflight is never cached,
// because a repeat must get a fresh ticket rather than a spent one. Like the macOS preflight, any
// preflight for an existing session first voids the ticket it holds, whatever its own outcome, and
// a request whose dispatch already finished answers `replay` (the dispatch is then answered from
// the cache and needs no ticket).
// BEGIN effect shadow wiring (classifier v2 S5-b-2b)
// The v2 effect classifier runs here in SHADOW: after the V1 preflight has its answer, the request
// is handed to a low-priority thread of its own, which reads the target through UI Automation,
// classifies, and keeps an enum-only summary in the shadow ring. Nothing here decides anything: the
// V1 receipt is built before this is called and is returned exactly as V1 built it. This function
// reads nothing through UI Automation (that is the shadow thread's work, one capture at a time),
// holds no lock, calls no input API, and never throws.
//
// It is called only from HandleWindowsPreflight, once, after ValidateWindowsDispatchBinding: a
// binding that could not be re-validated leaves a skipped record and reads nothing. The shadow gives
// way to everything else: the capture stops at the first refusal of its gate (cancel epoch, call
// and time budget) and a hung target costs only the shadow's own thread.
void LaunchWindowsShadowThread(std::function<void()> work) {
  std::thread([work = std::move(work)]() mutable {
    SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_LOWEST);
    const HRESULT initialized = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    work();
    if (SUCCEEDED(initialized))
      CoUninitialize();
  }).detach();
}

// Enum values and counters only, to the debug output (the macOS shadow does the same to os_log):
// never a label, a title, a URL or a path. A ShadowRecord holds none of them.
void ReportWindowsEffectShadow(const sprint_coder::computer_use::ShadowRecord &record) {
  char line[160];
  const int length = std::snprintf(
      line, sizeof(line),
      "computer-use effect shadow action=%u class=%u kind=%u reason=%u gaps=%u v1_ordinary=%d\n",
      static_cast<unsigned>(record.action), static_cast<unsigned>(record.effect_class),
      static_cast<unsigned>(record.kind), static_cast<unsigned>(record.reason),
      static_cast<unsigned>(record.gaps), record.v1_ordinary ? 1 : 0);
  if (length > 0)
    OutputDebugStringA(line);
}

// Never destroyed: a capture still running when the process exits must not find it torn down.
sprint_coder::computer_use::WindowsShadowScheduler &WindowsEffectShadow() {
  static sprint_coder::computer_use::WindowsShadowScheduler *const scheduler =
      new sprint_coder::computer_use::WindowsShadowScheduler(
          sprint_coder::computer_use::ProcessShadowLog(), LaunchWindowsShadowThread,
          ReportWindowsEffectShadow);
  return *scheduler;
}

void ScheduleWindowsEffectShadow(const WindowsSession &session,
                                 const std::string &metadata,
                                 const std::string &kind, bool v1_valid,
                                 bool v1_ordinary) noexcept {
  using namespace sprint_coder::computer_use;
  try {
    WindowsShadowJob job;
    job.kind = kind;
    job.v1_ordinary = v1_ordinary;
    job.maximum_mode = session.maximum_mode;
    job.policy_language = session.policy_language;
    (void)ReadJsonString(metadata, "key", &job.key);
    (void)ReadJsonString(metadata, "targetId", &job.target_id);
    // The point a click or scroll lands on, computed as the dispatch computes it.
    POINT point{0, 0};
    const bool point_known =
        WindowsActionPoint(session.observation_bounds, metadata, &point);
    job.click_tracked = kind == "click" && point_known;
    job.click_opens = job.click_tracked && WindowsClickOpens();
    const HWND window = session.active_window;
    const std::uint64_t expected_epoch = session.cancel_epoch;
    // Valid while the cancellation epoch is the one the preflight was bound to (a cancel and the
    // death of the parent both move it).
    const auto still_valid = [expected_epoch]() {
      return cancellation_epoch.load(std::memory_order_acquire) == expected_epoch;
    };
    WindowsShadowEnvironment environment;
    environment.still_valid = still_valid;
    // A click or scroll whose point is not a point of the window is not looked up at the screen's
    // origin: no source, so the capture is recorded as skipped.
    const bool needs_point = kind == "click" || kind == "scroll";
    environment.open_source = [window, point, still_valid, point_known, needs_point]()
        -> std::unique_ptr<ShadowUiaSource> {
      if (needs_point && !point_known)
        return nullptr;
      return WindowsUiaShadowSource::Create(
          window, point, still_valid,
          WindowsUiaShadowSource::kShadowUiaTimeoutMs,
          windows_uia_source_detail::ShellLookupRunning());
    };
    WindowsEffectShadow().Schedule(std::move(job), v1_valid,
                                   std::move(environment));
  } catch (...) {
    // A shadow failure is invisible to the caller.
  }
}
// END effect shadow wiring

// BEGIN sync interlock entry (classifier v2 S5-c-1)
// The shadow's capture, called synchronously: the same UI Automation source and the same reader and
// gate (a cancellation check before every call, a budget of kShadowMaxAxCalls calls and
// kShadowDeadlineNs, and the end-of-capture check), answered by the portable
// EvaluateWindowsInterlockOnSource. A canceled or out-of-budget capture, a failed read and
// incomplete facts are NO VERDICT (the answer carries the reason): never a refusal and never an
// approval, so the V1 preflight decides.
//
// Called from exactly two places, through WindowsInterlockRefusal below: the preflight, before it
// issues a ticket, and the dispatch, before any input (#500 S5-c-2 PR-5). The caller must call it
// only AFTER the V1 re-validation of the bound target succeeded (ValidateWindowsDispatchBinding): the
// point is only right for a binding that is still valid.
//
// THE SERIAL LANE IS HELD AT MOST kInterlockLaneHoldLimit. The lane's thread is an STA (the picker
// and the WinRT capture need it), and a UI Automation call to an app that does not answer is
// bounded only by its timeout. So the evaluation runs on a worker thread of its own, one per
// evaluation, in the multithreaded apartment, and the lane waits for it a bounded time: a worker
// that has not answered by then is abandoned (kBudget), and until it ends no second one is started
// (single-flight), so at most one such thread is ever stuck. The worker gets everything by value
// and never touches `sessions`; the lane's own apartment is not changed.
//
// Worst case of one wait. The gate bounds the START of a step, not its length. For a step that makes
// ONE UI Automation call: the gate's deadline (150 ms) + that call (250 ms) + creating the source and
// starting the thread (50 ms) = 450 ms, within the 500 ms the lane may wait (the static_assert below
// states only this case). Some steps make several calls inside ONE gate step: ItemPath (two UI
// Automation calls, then a shell lookup's wait of 150 ms: up to 650 ms) and CoreWindowProcessPath
// (two calls: 500 ms). Started just before the deadline they can run past 500 ms (about 850 ms by
// this arithmetic); for them the lane's wait_for cut-off (kBudget, worker abandoned) is the real
// bound of the hold, not the estimate. Before the wait the lane also reads the click facts
// (WindowsClickOpens: a settings read and GetLastInputInfo, microseconds, never a wait); that read
// sits outside this bound.
constexpr std::chrono::milliseconds kInterlockLaneHoldLimit{500};
static_assert(150 + sprint_coder::computer_use::WindowsUiaShadowSource::kInterlockUiaTimeoutMs + 50 <= 500,
              "holds for a step of ONE UI Automation call only; longer steps are bounded by the wait_for cut-off");
static_assert(sprint_coder::computer_use::kShadowDeadlineNs == 150'000'000,
              "the lane's worst-case estimate assumes the gate's 150 ms deadline");

struct InterlockPending {
  std::mutex mutex;
  std::condition_variable ready;
  bool done = false;
  // Set by the lane when it stops waiting: the worker's captures then stop at the next call.
  std::atomic<bool> abandoned{false};
  sprint_coder::computer_use::InterlockEvaluation result;
};

// Never destroyed: an abandoned worker may end after the process has started to exit.
std::atomic<bool> &InterlockWorkerRunning() {
  static std::atomic<bool> *const running = new std::atomic<bool>(false);
  return *running;
}

sprint_coder::computer_use::InterlockEvaluation EvaluateWindowsInterlockOnLane(
    const WindowsSession &session, const std::string &metadata, const std::string &kind,
    const sprint_coder::computer_use::EffectRuleset &ruleset,
    WindowsClickBasis *basis = nullptr) noexcept {
  using namespace sprint_coder::computer_use;
  InterlockEvaluation unavailable;
  unavailable.no_verdict = InterlockNoVerdict::kIncomplete;
  try {
    POINT point{0, 0};
    const bool point_known =
        WindowsActionPoint(session.observation_bounds, metadata, &point);
    // A click or scroll whose point is not a point of the window is not looked up at the screen's
    // origin.
    if ((kind == "click" || kind == "scroll") && !point_known)
      return unavailable;
    const std::uint64_t expected_epoch = session.cancel_epoch;
    const auto epoch_unchanged = [expected_epoch]() {
      return cancellation_epoch.load(std::memory_order_acquire) == expected_epoch;
    };
    // Canceled before anything is created or read: no verdict, no worker and no UI Automation object.
    if (!epoch_unchanged()) {
      unavailable.no_verdict = InterlockNoVerdict::kCanceled;
      return unavailable;
    }
    // The click facts the host alone knows, taken HERE on the lane (a cheap system call, never a
    // wait) and handed to the worker by value: the worker touches no session and no system state.
    // The time of the last input is read at this request, not when a worker finally runs.
    const bool click_tracked = kind == "click" && point_known;
    // The last input time first, then the click facts (which read it again): the time of the basis is
    // never later than the one the verdict used.
    if (basis != nullptr && click_tracked) {
      basis->input_read = WindowsReadLastInputTick(&basis->input_tick);
    }
    const bool click_opens = click_tracked && WindowsClickOpens();
    if (basis != nullptr) {
      basis->tracked = click_tracked;
      basis->opens = click_opens;
    }
    // Everything that can throw is prepared BEFORE the single-flight slot is taken, so a failure
    // here cannot leave the slot taken for ever.
    auto pending = std::make_shared<InterlockPending>();
    // Everything the worker needs, by value.
    const HWND window = session.active_window;
    const std::string maximum_mode = session.maximum_mode;
    const std::string policy_language = session.policy_language;
    const std::string kind_copy = kind;
    std::string key;
    std::string target_id;
    (void)ReadJsonString(metadata, "key", &key);
    (void)ReadJsonString(metadata, "targetId", &target_id);
    const EffectRuleset ruleset_copy = ruleset;
    // Single-flight: a worker still stuck from an earlier evaluation means no second one.
    std::atomic<bool> &running = InterlockWorkerRunning();
    if (running.exchange(true)) {
      unavailable.no_verdict = InterlockNoVerdict::kBudget;
      return unavailable;
    }
    try {
      std::thread([pending, window, point, maximum_mode, policy_language, kind_copy, key,
                   target_id, ruleset_copy, expected_epoch, click_tracked, click_opens, &running]() {
        InterlockEvaluation answer;
        answer.no_verdict = InterlockNoVerdict::kIncomplete;
        try {
          // Declared before the source: released after it, also when something throws.
          struct ComApartment {
            HRESULT initialized = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
            ~ComApartment() {
              if (SUCCEEDED(initialized)) CoUninitialize();
            }
          } apartment;
          {
            const auto still_valid = [pending, expected_epoch]() {
              return !pending->abandoned.load(std::memory_order_acquire) &&
                     cancellation_epoch.load(std::memory_order_acquire) == expected_epoch;
            };
            std::unique_ptr<ShadowUiaSource> source = WindowsUiaShadowSource::Create(
                window, point, still_valid, WindowsUiaShadowSource::kInterlockUiaTimeoutMs,
                windows_uia_source_detail::InterlockShellLookupRunning());
            if (source != nullptr) {
              ShadowRequestInfo info;
              info.kind = kind_copy;
              info.key = key;
              info.maximum_mode = maximum_mode;
              info.policy_language = policy_language;
              info.click_tracked = click_tracked;
              info.click_opens = click_opens;
              answer = EvaluateWindowsInterlockOnSource(*source, kind_copy, target_id, info,
                                                        ruleset_copy);
            }
          }
        } catch (...) {
          answer = InterlockEvaluation{};
          answer.no_verdict = InterlockNoVerdict::kIncomplete;
        }
        {
          std::lock_guard<std::mutex> lock(pending->mutex);
          pending->result = answer;
          pending->done = true;
        }
        running.store(false);
        pending->ready.notify_one();
      }).detach();
    } catch (...) {
      running.store(false);
      return unavailable;
    }
    InterlockEvaluation answer;
    {
      std::unique_lock<std::mutex> lock(pending->mutex);
      if (!pending->ready.wait_for(lock, kInterlockLaneHoldLimit,
                                   [&pending] { return pending->done; })) {
        pending->abandoned.store(true, std::memory_order_release);
        unavailable.no_verdict = InterlockNoVerdict::kBudget;
        return unavailable;
      }
      answer = pending->result;
    }
    // The action was canceled while the worker read: no verdict, whatever it found.
    if (!epoch_unchanged()) {
      unavailable.no_verdict = InterlockNoVerdict::kCanceled;
      return unavailable;
    }
    return answer;
  } catch (...) {
    return unavailable;
  }
}
// Windows has no approval path (the route v2 build is refused for win32 by
// build-computer-use-eligibility.mjs), so a file opened from a file manager or a download list is a
// closed approval.
constexpr sprint_coder::computer_use::EffectRuleset kWindowsInterlockRuleset{
    /*download_open=*/false, /*file_manager_open=*/false};

// How often the interlocks had NO verdict, by reason, and how often the lane's time ran out. Only
// enum names and counts are written, never a label or a title.
void CountWindowsInterlockNoVerdict(sprint_coder::computer_use::InterlockNoVerdict reason) noexcept {
  using sprint_coder::computer_use::InterlockNoVerdict;
  static std::atomic<std::uint64_t> counts[4];
  const std::size_t index = static_cast<std::size_t>(reason);
  if (index >= 4) return;
  const std::uint64_t count = counts[index].fetch_add(1, std::memory_order_relaxed) + 1;
  const char *name = reason == InterlockNoVerdict::kCanceled
                         ? "canceled"
                         : (reason == InterlockNoVerdict::kBudget ? "budget" : "incomplete");
  char line[96];
  const int written = std::snprintf(line, sizeof(line), "computer-use interlock: no verdict %s count=%llu\n",
                                    name, static_cast<unsigned long long>(count));
  if (written > 0) OutputDebugStringA(line);
}

sprint_coder::computer_use::InterlockEvaluation
WindowsInterlockRefusal(const WindowsSession &session, const std::string &metadata,
                        const std::string &kind, WindowsClickBasis *basis) noexcept {
  const sprint_coder::computer_use::InterlockEvaluation evaluation =
      EvaluateWindowsInterlockOnLane(session, metadata, kind, kWindowsInterlockRuleset, basis);
  if (!evaluation.Refuses() &&
      evaluation.no_verdict != sprint_coder::computer_use::InterlockNoVerdict::kNone)
    CountWindowsInterlockNoVerdict(evaluation.no_verdict);
  return evaluation;
}
// END sync interlock entry

bool HandleWindowsPreflight(HANDLE pipe, const Frame &request,
                            const std::string &metadata) {
  const std::string session_key = FrameIdKey(request.header.session_id);
  const auto found = sessions.find(session_key);
  if (found == sessions.end())
    return Respond(pipe, request, MessageType::kError,
                   ErrorPayload("session_missing"));
  const WindowsSession &session = found->second;
  WindowsTicketState &state = ticket_states[session_key];
  state.slot.Invalidate();
  ++state.generation;
  std::string request_id;
  std::string action_digest;
  std::uint64_t cancel_epoch = 0;
  std::uint64_t observation_revision = 0;
  if (!ReadJsonString(metadata, "requestId", &request_id) ||
      request_id.empty() || request_id.size() > 256 ||
      !ReadJsonString(metadata, "actionDigest", &action_digest) ||
      !IsLowerHexDigest64(action_digest) ||
      !ReadJsonUint64(metadata, "cancelEpoch", &cancel_epoch) ||
      !ReadJsonUint64(metadata, "observationRevision", &observation_revision))
    return Respond(pipe, request, MessageType::kError,
                   ErrorPayload("invalid_action"));
  Frame finished;
  finished.header = request.header;
  finished.header.message_type = static_cast<std::uint16_t>(MessageType::kDispatch);
  if (DispatchFrameIdFor(request_id, &finished.header.request_id) &&
      response_cache.contains(ResponseCacheKey(finished)))
    return Respond(pipe, request, MessageType::kPreflightResult,
                   WindowsPreflightReceipt(session, request_id, cancel_epoch,
                                           observation_revision, "replay", "",
                                           ""));
  std::string kind;
  RECT bounds{};
  std::string reason;
  if (!ValidateWindowsDispatchBinding(session, metadata, &kind, &bounds,
                                      &reason)) {
    const bool denied_sent =
        Respond(pipe, request, MessageType::kPreflightResult,
                WindowsPreflightReceipt(session, request_id, cancel_epoch,
                                        observation_revision, "denied",
                                        "native_" + reason, ""));
    // V1 could not re-validate the bound target and its denial is out: the shadow only records
    // that it read nothing.
    if (!kind.empty())
      ScheduleWindowsEffectShadow(session, metadata, kind, false, false);
    return denied_sent;
  }
  // The v2 interlocks (#500 S5-c-2 PR-5): AFTER the V1 binding is valid and BEFORE a ticket is
  // issued. A refusal issues no ticket (the slot was invalidated above). No verdict (budget,
  // incomplete facts, canceled) leaves the V1 answer: an ordinary ticket as before.
  {
    const sprint_coder::computer_use::InterlockEvaluation evaluation =
        WindowsInterlockRefusal(session, metadata, kind);
    if (evaluation.Refuses()) {
      const std::string decision(evaluation.verdict.DecisionName());
      const std::string code(evaluation.verdict.ReasonCode());
      const std::string result(evaluation.verdict.DeniedResult());
      const bool sent = Respond(
          pipe, request, MessageType::kPreflightResult,
          sprint_coder::computer_use::NativePreflightRefusalAllowed(decision, code, result)
              ? WindowsPreflightReceipt(session, request_id, cancel_epoch, observation_revision,
                                        decision, code, "", result)
              : WindowsPreflightReceipt(session, request_id, cancel_epoch, observation_revision,
                                        "denied", "native_preflight_invalid", ""));
      // The V1 answer is "no ticket": the shadow records that V1 did not issue its ordinary one.
      ScheduleWindowsEffectShadow(session, metadata, kind, true, false);
      return sent;
    }
  }
  std::string token;
  const bool issued =
      GenerateTicketToken(&token) &&
      state.slot.Issue(
          token,
          WindowsTicketBinding(session, request_id, action_digest,
                               WindowsDispatchPayloadDigest(metadata),
                               cancel_epoch, state.generation),
          MonotonicNowNs(),
          sprint_coder::computer_use::kNativeOrdinaryTicketTtlNs);
  std::string receipt = WindowsPreflightReceipt(
      session, request_id, cancel_epoch, observation_revision,
      issued ? "ordinary" : "denied",
      issued ? "" : "native_ticket_unavailable", issued ? token : "");
  const bool sent =
      Respond(pipe, request, MessageType::kPreflightResult, receipt);
  // The secret only needs to live until it is on the wire (the slot keeps its own copy).
  ScrubString(&token);
  ScrubString(&receipt);
  // The V1 answer is out; the v2 classifier only watches (see the shadow wiring above).
  ScheduleWindowsEffectShadow(session, metadata, kind, true, issued);
  return sent;
}

bool ObserveWindowsWindow(WindowsSession &session, std::string *response,
                          std::vector<std::uint8_t> *binary,
                          std::string *reason) {
  RECT bounds{};
  WindowsDialogSetSnapshot dialogs;
  // The UI Automation reads of the whole observe share one budget and the cancellation epoch (see the
  // bounds above). The reason of a read that did not complete says why (WindowsV1ObserveReason).
  const WindowsV1UiaPath uia_path(kWindowsV1UiaObserveBudget, session.cancel_epoch);
  const auto unreadable = [&uia_path](const char *otherwise) -> const char * {
    if (uia_path.Stop() == WindowsV1UiaStop::kBudget) {
      // Only a count (never a label or a text): how far the walks got before the budget was spent.
      const std::string note = "computer-use: observe UI Automation budget spent after " +
                               std::to_string(uia_path.Nodes()) + " nodes\n";
      OutputDebugStringA(note.c_str());
    }
    return WindowsV1ObserveReason(uia_path.Stop(), otherwise);
  };
  if (!ValidateWindowsSession(session, &bounds, reason, &dialogs) ||
      session.cancel_epoch !=
          cancellation_epoch.load(std::memory_order_acquire))
    return false;
  std::string tree;
  std::size_t nodes = 0;
  if (!ReadUiaObservation(session.pid, dialogs.active_window, &tree, &nodes)) {
    *reason = unreadable("accessibility_unavailable");
    return false;
  }
  WindowsControlBindings bindings;
  if (!CaptureWindowsControlBindings(session.pid, dialogs.active_window,
                                     &bindings)) {
    *reason = unreadable("accessibility_binding_unavailable");
    return false;
  }
  std::string stable_tree;
  std::size_t stable_nodes = 0;
  if (!ReadUiaObservation(session.pid, dialogs.active_window, &stable_tree,
                          &stable_nodes) ||
      stable_tree != tree || stable_nodes != nodes) {
    *reason = unreadable("observation_stale");
    return false;
  }
  WindowsControlBindings stable_bindings;
  if (!CaptureWindowsControlBindings(session.pid, dialogs.active_window,
                                     &stable_bindings) ||
      stable_bindings.semantic != bindings.semantic ||
      stable_bindings.visual != bindings.visual) {
    *reason = unreadable("observation_stale");
    return false;
  }
  const WindowsUiaRisk focused_risk =
      ClassifyWindowsFocusedElement(session.pid);
  // The focused element's signature is read whatever its classification says, as before #820: a live
  // focus that is only unclassified (deeper than the climb, say) keeps its signature, so its key / type
  // is refused later as target_unclassified, not as a focus that moved. After a timeout or a Cancel in
  // this observe the read is refused by the path without a call (no second wait on the element).
  std::string focused_element_signature;
  const bool has_focused_element_signature =
      WindowsFocusedElementSignature(session.pid, bounds, &focused_element_signature);
  RECT screen_bounds{};
  if (!ScreenBoundsPhysicalForWindow(dialogs.active_window, &screen_bounds)) {
    *reason = "screen_geometry_unavailable";
    return false;
  }
  std::size_t width = 0;
  std::size_t height = 0;
  if (!CaptureWindowWithGraphicsCapture(dialogs.active_window, binary, &width,
                                        &height)) {
    *reason = "graphics_capture_unavailable";
    return false;
  }
  RECT stable_bounds{};
  WindowsDialogSetSnapshot stable_dialogs;
  if (!ValidateWindowsSession(session, &stable_bounds, reason,
                              &stable_dialogs) ||
      session.cancel_epoch !=
          cancellation_epoch.load(std::memory_order_acquire) ||
      stable_dialogs.digest != dialogs.digest ||
      stable_dialogs.active_window != dialogs.active_window ||
      stable_dialogs.active_identity != dialogs.active_identity ||
      stable_dialogs.active_kind != dialogs.active_kind ||
      stable_bounds.left != bounds.left || stable_bounds.top != bounds.top ||
      stable_bounds.right != bounds.right ||
      stable_bounds.bottom != bounds.bottom) {
    binary->clear();
    if (reason->empty())
      *reason = "observation_stale";
    return false;
  }
  const std::size_t screenshot_bytes = binary->size();
  const std::size_t tree_bytes = tree.size();
  if (screenshot_bytes == 0 || screenshot_bytes > 8 * 1024 * 1024 ||
      tree_bytes == 0 || tree_bytes > 512 * 1024 ||
      screenshot_bytes + tree_bytes > kMaxBinaryBytes) {
    binary->clear();
    *reason = "observation_payload_oversized";
    return false;
  }
  std::vector<std::string> patch_digests;
  std::size_t patch_columns = 0;
  std::size_t patch_rows = 0;
  if (!ComputePngPatchGrid(*binary, width, height, &patch_digests,
                           &patch_columns, &patch_rows)) {
    binary->clear();
    *reason = "visual_binding_unavailable";
    return false;
  }
  binary->reserve(screenshot_bytes + tree_bytes);
  binary->insert(binary->end(), tree.begin(), tree.end());
  if (session.dialog_set_digest != dialogs.digest)
    session.dialog_set_revision += 1;
  session.observation_revision += 1;
  session.active_window = dialogs.active_window;
  session.active_window_identity = dialogs.active_identity;
  session.active_window_kind = dialogs.active_kind;
  session.dialog_set_digest = dialogs.digest;
  session.observation_bounds = bounds;
  session.observation_capture_width = width;
  session.observation_capture_height = height;
  session.observation_patch_columns = patch_columns;
  session.observation_patch_rows = patch_rows;
  for (auto &digest : session.observation_patch_digests)
    std::fill(digest.begin(), digest.end(), '0');
  session.observation_patch_digests = std::move(patch_digests);
  session.focused_element_signature = std::move(focused_element_signature);
  session.has_focused_element_signature = has_focused_element_signature;
  session.semantic_control_signatures = std::move(stable_bindings.semantic);
  session.visual_control_signatures = std::move(stable_bindings.visual);
  session.has_observation = true;
  const auto window_value =
      static_cast<std::uint64_t>(reinterpret_cast<UINT_PTR>(session.window));
  *response =
      "{\"result\":\"completed\",\"pid\":" + std::to_string(session.pid) +
      ",\"windowId\":\"" + std::to_string(window_value) +
      "\",\"captureWidth\":" + std::to_string(width) +
      ",\"captureHeight\":" + std::to_string(height) +
      ",\"revision\":" + std::to_string(session.observation_revision) +
      ",\"screenshotMimeType\":\"image/png\",\"screenshotBytes\":" +
      std::to_string(screenshot_bytes) +
      ",\"treeBytes\":" + std::to_string(tree_bytes) +
      ",\"treeNodeCount\":" + std::to_string(nodes) +
      ",\"dialogSetRevision\":" +
      std::to_string(session.dialog_set_revision) +
      ",\"dialogSetDigest\":\"" + session.dialog_set_digest +
      "\",\"activeWindowIdentityDigest\":\"" +
      session.active_window_identity + "\",\"activeWindowKind\":\"" +
      session.active_window_kind + "\"" +
      ",\"policyLanguage\":\"" + session.policy_language + "\"" +
      ",\"maximumMode\":\"" + session.maximum_mode +
      "\",\"screenBounds\":" + RectJson(screen_bounds) +
      ",\"focusedElementSignature\":" +
      (has_focused_element_signature
           ? "\"" + focused_element_signature + "\""
           : "null") +
      ",\"focusedElementSecure\":" + (focused_risk.secure ? "true" : "false") +
      ",\"focusedElementHighImpact\":" +
      (focused_risk.high_impact ? "true" : "false") + "}";
  reason->clear();
  return true;
}

// BEGIN artifact read (#785 T15-4w)
// The value of ONE node, for `copy`. Like the interlock entry it runs on a worker of its own in the
// multithreaded apartment while the lane waits at most kInterlockLaneHoldLimit, with the same
// single-flight slot (at most one stuck worker in the process); the worker gets everything by value.
// The node is resolved as the semantic actions resolve it (the V1 search by target id, the signature
// the observation recorded, the V1 risk of the element); the facts and the value then come from the
// shadow's source and reader (portable: ReadWindowsArtifactValue), which also judges the role, the
// secure / high-impact / surface facts and the browser window (the judgement lives in that header).
// Any way of not reading is the same "not read". The value is never cached by the helper (the answer
// goes out with Respond, not RespondAndCache) and the copy of it is scrubbed after it is sent.
// Reads only: no input API, no pattern is invoked, nothing is set.
struct ArtifactReadPending {
  // Whatever value is still here when the last owner lets go (the lane gave up, or never took it)
  // is overwritten first.
  ~ArtifactReadPending() { ScrubString(&text); }
  std::mutex mutex;
  std::condition_variable ready;
  bool done = false;
  std::atomic<bool> abandoned{false};
  bool ok = false;
  std::string text;
};

bool ReadWindowsNodeValueOnLane(const WindowsSession &session, const std::string &metadata,
                                std::string *text) noexcept {
  using namespace sprint_coder::computer_use;
  try {
    std::string kind;
    RECT bounds{};
    std::string reason;
    if (!ValidateWindowsDispatchBinding(session, metadata, &kind, &bounds, &reason) || kind != "copy")
      return false;
    std::string target_id;
    if (!ReadJsonString(metadata, "targetId", &target_id) || target_id.empty() || target_id.size() > 128)
      return false;
    const auto observed = session.semantic_control_signatures.find(target_id);
    if (observed == session.semantic_control_signatures.end()) return false;
    const std::uint64_t expected_epoch = session.cancel_epoch;
    auto pending = std::make_shared<ArtifactReadPending>();
    const WindowsSession copy = session;
    const std::string signature = observed->second;
    std::atomic<bool> &running = InterlockWorkerRunning();
    if (running.exchange(true)) return false;
    try {
      std::thread([pending, copy, target_id, signature, expected_epoch, &running]() {
        bool ok = false;
        std::string value;
        try {
          struct ComApartment {
            HRESULT initialized = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
            ~ComApartment() {
              if (SUCCEEDED(initialized)) CoUninitialize();
            }
          } apartment;
          const auto still_valid = [pending, expected_epoch]() {
            return !pending->abandoned.load(std::memory_order_acquire) &&
                   cancellation_epoch.load(std::memory_order_acquire) == expected_epoch;
          };
          IUIAutomationElement *target = nullptr;
          std::string why;
          if (FindWindowsSemanticTarget(copy, target_id, &target, &why)) {
            std::string current;
            const bool same_control =
                ComputeWindowsControlSignature(target, copy.pid, nullptr, &current) && current == signature;
            // The V1 risk of the element, as for every semantic action: a secure or high-impact
            // element is never read, whatever else says.
            const bool risky = RejectWindowsRisk(ClassifyWindowsUiaElement(target), &why);
            target->Release();
            if (same_control && !risky) {
              std::unique_ptr<WindowsUiaShadowSource> source = WindowsUiaShadowSource::Create(
                  copy.active_window, POINT{0, 0}, still_valid,
                  WindowsUiaShadowSource::kInterlockUiaTimeoutMs,
                  windows_uia_source_detail::InterlockShellLookupRunning());
              if (source != nullptr) {
                // The element the read finds is checked against the observed signature (runtime id
                // included), the same function the observation and the semantic actions use.
                const std::uint32_t pid = copy.pid;
                source->SetSignatureProvider([pid](IUIAutomationElement *element, std::string *out) {
                  return ComputeWindowsControlSignature(element, pid, nullptr, out);
                });
                ShadowRequestInfo info;
                info.policy_language = copy.policy_language;
                info.maximum_mode = "full_access_app";
                WindowsArtifactReadResult result = ReadWindowsArtifactValue(*source, target_id, info, signature);
                ok = result.ok;
                value = std::move(result.text);
              }
            }
          }
        } catch (...) {
          ok = false;
          value.clear();
        }
        {
          std::lock_guard<std::mutex> lock(pending->mutex);
          // The lane sets `abandoned` while it holds this lock, so this look is not a race: a value
          // that arrives after the lane gave up is overwritten here and never stored.
          if (pending->abandoned.load(std::memory_order_acquire)) {
            ScrubString(&value);
            value.clear();
            ok = false;
          }
          pending->ok = ok;
          pending->text = std::move(value);
          pending->done = true;
        }
        running.store(false);
        pending->ready.notify_one();
      }).detach();
    } catch (...) {
      running.store(false);
      return false;
    }
    {
      std::unique_lock<std::mutex> lock(pending->mutex);
      if (!pending->ready.wait_for(lock, kInterlockLaneHoldLimit, [&pending] { return pending->done; })) {
        pending->abandoned.store(true, std::memory_order_release);
        return false;
      }
      if (!pending->ok) return false;
      *text = pending->text;
      ScrubString(&pending->text);
    }
    // The action was canceled or the window changed while the worker read: no value.
    if (cancellation_epoch.load(std::memory_order_acquire) != expected_epoch ||
        !RevalidateWindowsTarget(session, bounds, expected_epoch) || text->empty() ||
        text->size() > kArtifactReadMaxBytes) {
      ScrubString(text);
      text->clear();
      return false;
    }
    return true;
  } catch (...) {
    ScrubString(text);
    text->clear();
    return false;
  }
}
// END artifact read

bool HandlePipeRequest(HANDLE pipe, const BackendProbe &probe,
                       const Frame &request, bool *handshaken) {
  const auto type = static_cast<MessageType>(request.header.message_type);
  if (!IsBoundedUtf8(request.metadata) || !request.binary.empty())
    return false;
  const std::string metadata(
      reinterpret_cast<const char *>(request.metadata.data()),
      request.metadata.size());
  if (!*handshaken && type != MessageType::kHandshake) {
    Respond(pipe, request, MessageType::kError,
            ErrorPayload("HANDSHAKE_REQUIRED"));
    return false;
  }
  if (type != MessageType::kHandshake) {
    bool replayed = false;
    if (!ReplayCachedResponse(pipe, request, &replayed))
      return false;
    if (replayed)
      return true;
  }
  switch (type) {
  case MessageType::kHandshake: {
    std::uint64_t protocol_version = 0;
    std::uint64_t api_version = 0;
    if (!ReadJsonUint64(metadata, "protocolVersion", &protocol_version) ||
        !ReadJsonUint64(metadata, "apiVersion", &api_version) ||
        protocol_version != kProtocolVersion || api_version != kApiVersion)
      return Respond(pipe, request, MessageType::kError,
                     ErrorPayload("HANDSHAKE_MISMATCH"));
    *handshaken = true;
    if (!Respond(pipe, request, MessageType::kHandshakeResult,
                 ProbeJson(probe)))
      return false;
    break;
  }
  case MessageType::kProbe: {
    std::string operation;
    if (!ReadJsonString(metadata, "operation", &operation))
      operation = "probe";
    if (operation == "read_node_value") {
      // The value of one node for copy (#785 T15-4w): its own answer, never cached.
      WindowsSession *session = FindWindowsSession(request);
      std::string text;
      const bool read = session != nullptr && ReadWindowsNodeValueOnLane(*session, metadata, &text);
      std::string payload = read ? "{\"ok\":true,\"text\":\"" + JsonEscape(text) + "\"}" : "{\"ok\":false}";
      const bool sent = Respond(pipe, request, MessageType::kProbeResult, payload);
      ScrubString(&text);
      ScrubString(&payload);
      if (!sent) return false;
      break;
    }
    std::string response;
    std::string reason;
    bool succeeded = false;
    if (operation == "probe") {
      response = ProbeJson(probe);
      succeeded = true;
    } else if (operation == "pick_application") {
      succeeded = PickWindowsExecutable(&response, &reason);
    } else if (operation == "list_windows") {
      succeeded = ListWindowsForIdentity(metadata, &response, &reason);
    } else if (operation == "start_session") {
      succeeded = StartWindowsSession(request, metadata, &response, &reason);
    } else if (operation == "close_session") {
      succeeded = CloseWindowsSession(request, metadata, &response);
      if (!succeeded) reason = "native_close_unconfirmed";
    } else {
      reason = "unsupported_operation";
    }
    if (!RespondAndCache(
            pipe, request,
            succeeded ? MessageType::kProbeResult : MessageType::kError,
            succeeded ? std::move(response) : ErrorPayload(reason)))
      return false;
    break;
  }
  case MessageType::kCancel: {
    WindowsSession *session = FindWindowsSession(request);
    std::uint64_t requested_epoch = 0;
    if (session == nullptr ||
        !ReadJsonUint64(metadata, "cancelEpoch", &requested_epoch) ||
        requested_epoch <= session->cancel_epoch) {
      if (!RespondAndCache(pipe, request, MessageType::kError,
                           ErrorPayload("invalid_cancel")))
        return false;
      break;
    }
    session->cancel_epoch = requested_epoch;
    InvalidateWindowsTicket(FrameIdKey(request.header.session_id));
    std::uint64_t current = cancellation_epoch.load(std::memory_order_acquire);
    while (requested_epoch > current &&
           !cancellation_epoch.compare_exchange_weak(
               current, requested_epoch, std::memory_order_acq_rel,
               std::memory_order_acquire)) {
    }
    // Cancellation is acknowledged idempotently. Any in-flight atomic input
    // checks the epoch before its next unit and stops; no retry is generated by
    // the native helper.
    if (!RespondAndCache(pipe, request, MessageType::kDispatchResult,
                         "{\"result\":\"canceled\",\"drained\":true,\"sessionId\":\"" +
                             JsonEscape(session->session_id) + "\",\"cancelEpoch\":" +
                             std::to_string(requested_epoch) + ",\"inputAttemptCount\":" +
                             std::to_string(session->input_api_attempts->load(std::memory_order_acquire)) + "}"))
      return false;
    break;
  }
  case MessageType::kObserve: {
    WindowsSession *session = FindWindowsSession(request);
    if (session == nullptr) {
      if (!RespondAndCache(pipe, request, MessageType::kError,
                           ErrorPayload("session_missing")))
        return false;
      break;
    }
    // A new observation changes what a ticket was measured against, as on macOS.
    InvalidateWindowsTicket(FrameIdKey(request.header.session_id));
    std::string response;
    std::vector<std::uint8_t> binary;
    std::string reason;
    const bool succeeded =
        ObserveWindowsWindow(*session, &response, &binary, &reason);
    if (!RespondAndCache(
            pipe, request,
            succeeded ? MessageType::kObserveResult : MessageType::kError,
            succeeded ? std::move(response) : ErrorPayload(reason),
            succeeded ? std::move(binary) : std::vector<std::uint8_t>{})) {
      return false;
    }
    break;
  }
  case MessageType::kPreflight: {
    // One path for the whole frame: the first timed-out UI Automation call of any of its steps ends all
    // the later ones, and a Cancel ends them too (the inner paths share this state).
    const WindowsV1UiaPath preflight_uia_path;
    if (!HandleWindowsPreflight(pipe, request, metadata)) return false;
    break;
  }
  case MessageType::kDispatch: {
    WindowsSession *session = FindWindowsSession(request);
    if (session == nullptr) {
      if (!RespondAndCache(pipe, request, MessageType::kError,
                           ErrorPayload("session_missing")))
        return false;
      break;
    }
    // A ticket is required for every input. This sits after the replay answer above, so a repeat of
    // a finished request still gets its cached result, and it is not cached itself, so the same
    // request id can be tried again with a ticket.
    if (!ConsumeWindowsDispatchTicket(FrameIdKey(request.header.session_id),
                                      *session, metadata)) {
      if (!Respond(pipe, request, MessageType::kError,
                   ErrorPayload("ticket_invalid")))
        return false;
      break;
    }
    std::string result;
    std::string reason;
    bool accepted = false;
    // One path for the whole dispatch (the interlock, the classification, the signatures, the
    // re-validation): the first timed-out UI Automation call ends all the later ones, and a Cancel ends
    // them too (the inner paths share this state).
    const WindowsV1UiaPath dispatch_uia_path;
    const bool succeeded =
        DispatchWindowsAction(*session, metadata, &result, &reason, &accepted);
    if (!RespondAndCache(
            pipe, request,
            succeeded ? MessageType::kDispatchResult : MessageType::kError,
            succeeded ? "{\"result\":\"completed\",\"reasonCode\":null,\"sessionId\":\"" +
                            JsonEscape(session->session_id) + "\",\"cancelEpoch\":" +
                            std::to_string(session->cancel_epoch) + ",\"inputAttemptCount\":" +
                            std::to_string(session->input_api_attempts->load(std::memory_order_acquire)) + "}"
                      : ErrorPayload(reason, accepted))) {
      return false;
    }
    break;
  }
  default:
    if (!RespondAndCache(pipe, request, MessageType::kError,
                         ErrorPayload("UNSUPPORTED_MESSAGE")))
      return false;
    break;
  }
  return true;
}

bool ServePipe(HANDLE pipe, const BackendProbe &probe) {
  constexpr std::size_t kMaximumQueuedFrames = 64;
  std::mutex queue_mutex;
  std::condition_variable queue_ready;
  std::deque<Frame> queue;
  bool reader_finished = false;
  bool reader_valid = true;
  std::thread reader([&]() {
    std::unordered_map<std::string, std::string> cancel_request_digests;
    std::deque<std::string> cancel_request_order;
    Frame request;
    while (ReadFrame(pipe, &request)) {
      if (!IsBoundedUtf8(request.metadata) || !request.binary.empty()) {
        reader_valid = false;
        break;
      }
      if (static_cast<MessageType>(request.header.message_type) ==
          MessageType::kCancel) {
        const std::string request_key = ResponseCacheKey(request);
        const std::string request_digest = RequestPayloadDigest(request);
        const auto prior = cancel_request_digests.find(request_key);
        const bool new_cancel = request_digest.size() == 64 &&
                                prior == cancel_request_digests.end();
        if (new_cancel) {
          if (cancel_request_order.size() >= kMaximumCachedResponses) {
            cancel_request_digests.erase(cancel_request_order.front());
            cancel_request_order.pop_front();
          }
          cancel_request_order.push_back(request_key);
          cancel_request_digests.emplace(request_key, request_digest);
        }
        const std::string metadata(
            reinterpret_cast<const char *>(request.metadata.data()),
            request.metadata.size());
        std::uint64_t requested_epoch = 0;
        if (new_cancel &&
            ReadJsonUint64(metadata, "cancelEpoch", &requested_epoch)) {
          std::uint64_t current =
              cancellation_epoch.load(std::memory_order_acquire);
          while (requested_epoch > current &&
                 !cancellation_epoch.compare_exchange_weak(
                     current, requested_epoch, std::memory_order_acq_rel,
                     std::memory_order_acquire)) {
          }
        }
      }
      {
        std::lock_guard lock(queue_mutex);
        if (queue.size() >= kMaximumQueuedFrames) {
          reader_valid = false;
          break;
        }
        queue.push_back(std::move(request));
      }
      queue_ready.notify_one();
      request = {};
    }
    {
      std::lock_guard lock(queue_mutex);
      reader_finished = true;
    }
    queue_ready.notify_one();
  });

  bool handshaken = false;
  bool served = true;
  for (;;) {
    Frame request;
    {
      std::unique_lock lock(queue_mutex);
      queue_ready.wait(lock,
                       [&]() { return reader_finished || !queue.empty(); });
      if (queue.empty())
        break;
      request = std::move(queue.front());
      queue.pop_front();
    }
    if (!HandlePipeRequest(pipe, probe, request, &handshaken)) {
      served = false;
      CancelIoEx(pipe, nullptr);
      break;
    }
  }
  if (reader.joinable())
    reader.join();
  return served && reader_valid;
}

bool ParseUnsigned(std::wstring_view value, DWORD *output) {
  if (value.empty() || value.size() > 10)
    return false;
  DWORD parsed = 0;
  for (const wchar_t character : value) {
    if (character < L'0' || character > L'9')
      return false;
    const auto digit = static_cast<DWORD>(character - L'0');
    if (parsed > (std::numeric_limits<DWORD>::max() - digit) / 10)
      return false;
    parsed = parsed * 10 + digit;
  }
  *output = parsed;
  return parsed > 0;
}

bool ConfigurePerMonitorDpiAwareness() {
  if (SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2))
    return true;
  return GetAwarenessFromDpiAwarenessContext(GetThreadDpiAwarenessContext()) ==
         DPI_AWARENESS_PER_MONITOR_AWARE;
}

bool IsActualParentProcess(DWORD expected_parent_pid) {
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE)
    return false;
  PROCESSENTRY32W entry{};
  entry.dwSize = sizeof(entry);
  bool matches = false;
  if (Process32FirstW(snapshot, &entry)) {
    do {
      if (entry.th32ProcessID == GetCurrentProcessId()) {
        matches = entry.th32ParentProcessID == expected_parent_pid;
        break;
      }
    } while (Process32NextW(snapshot, &entry));
  }
  CloseHandle(snapshot);
  return matches;
}

bool BuildCurrentUserPipeSecurity(SECURITY_ATTRIBUTES *security,
                                  PSECURITY_DESCRIPTOR *descriptor) {
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token))
    return false;
  DWORD token_bytes = 0;
  GetTokenInformation(token, TokenUser, nullptr, 0, &token_bytes);
  std::vector<std::uint8_t> token_buffer(token_bytes);
  const bool read = token_bytes >= sizeof(TOKEN_USER) &&
                    GetTokenInformation(token, TokenUser, token_buffer.data(),
                                        token_bytes, &token_bytes) == TRUE;
  CloseHandle(token);
  if (!read)
    return false;
  const auto *token_user =
      reinterpret_cast<const TOKEN_USER *>(token_buffer.data());
  LPWSTR sid_text = nullptr;
  if (!ConvertSidToStringSidW(token_user->User.Sid, &sid_text) ||
      sid_text == nullptr)
    return false;
  const std::wstring sddl =
      L"D:P(A;;GA;;;SY)(A;;GA;;;" + std::wstring(sid_text) + L")";
  LocalFree(sid_text);
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
          sddl.c_str(), SDDL_REVISION_1, descriptor, nullptr) ||
      *descriptor == nullptr)
    return false;
  security->nLength = sizeof(*security);
  security->lpSecurityDescriptor = *descriptor;
  security->bInheritHandle = FALSE;
  return true;
}

int ProbeMain() {
  HRESULT initialized = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  const BackendProbe probe = ProbeBackend();
  std::cout << ProbeJson(probe);
  if (SUCCEEDED(initialized))
    CoUninitialize();
  return 0;
}

int ServeMain(const std::wstring &pipe_name, DWORD parent_pid) {
  if (pipe_name.size() < 10 || pipe_name.size() > 240 ||
      pipe_name.rfind(L"\\\\.\\pipe\\sprint-coder-computer-use-", 0) != 0)
    return 2;
  if (parent_pid == 0 || !IsActualParentProcess(parent_pid))
    return 2;
  HANDLE parent = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                              FALSE, parent_pid);
  if (parent == nullptr)
    return 3;

  // Keep DLL resolution on the system directory/application directory.  Loading
  // from the current directory or PATH would defeat the packaged-helper digest
  // boundary.
  using SetDefaultDllDirectoriesFn = BOOL(WINAPI *)(DWORD);
  const auto kernel32 = GetModuleHandleW(L"kernel32.dll");
  const auto set_dll_directories =
      kernel32 == nullptr
          ? nullptr
          : reinterpret_cast<SetDefaultDllDirectoriesFn>(
                GetProcAddress(kernel32, "SetDefaultDllDirectories"));
  if (set_dll_directories == nullptr ||
      !set_dll_directories(LOAD_LIBRARY_SEARCH_SYSTEM32 |
                           LOAD_LIBRARY_SEARCH_APPLICATION_DIR)) {
    CloseHandle(parent);
    return 4;
  }

  SECURITY_ATTRIBUTES security{};
  PSECURITY_DESCRIPTOR security_descriptor = nullptr;
  if (!BuildCurrentUserPipeSecurity(&security, &security_descriptor)) {
    CloseHandle(parent);
    return 5;
  }
  // ServePipe reads the next request on one thread while another writes the current response.
  // A synchronous handle serializes those operations: the pending read can block the response
  // until another request arrives. Each overlapped operation owns its own completion event.
  HANDLE pipe = CreateNamedPipeW(
      pipe_name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
      1, 64 * 1024, 64 * 1024, 0, &security);
  LocalFree(security_descriptor);
  if (pipe == INVALID_HANDLE_VALUE) {
    CloseHandle(parent);
    return 6;
  }

  const HRESULT initialized = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  if (FAILED(initialized)) {
    CloseHandle(pipe);
    CloseHandle(parent);
    return 7;
  }
  const BackendProbe probe = ProbeBackend();
  ScopedKernelHandle connected_event(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  OVERLAPPED connection{};
  connection.hEvent = connected_event.value;
  BOOL connected = FALSE;
  if (connected_event.value != nullptr) {
    connected = ConnectNamedPipe(pipe, &connection);
    if (!connected) {
      const DWORD error = GetLastError();
      DWORD transferred = 0;
      connected = error == ERROR_PIPE_CONNECTED ||
                  (error == ERROR_IO_PENDING &&
                   GetOverlappedResult(pipe, &connection, &transferred, TRUE));
    }
  }
  ULONG client_pid = 0;
  const bool authenticated_client =
      connected == TRUE &&
      GetNamedPipeClientProcessId(pipe, &client_pid) == TRUE &&
      client_pid == parent_pid;
  std::atomic<bool> serving{authenticated_client};
  std::thread parent_watcher;
  if (authenticated_client) {
    parent_watcher = std::thread([parent, pipe, &serving]() {
      while (serving.load(std::memory_order_acquire)) {
        if (WaitForSingleObject(parent, 100) == WAIT_OBJECT_0) {
          parent_process_dead.store(true, std::memory_order_release);
          cancellation_epoch.fetch_add(1, std::memory_order_acq_rel);
          CancelIoEx(pipe, nullptr);
          DisconnectNamedPipe(pipe);
          break;
        }
      }
    });
    ServePipe(pipe, probe);
    serving.store(false, std::memory_order_release);
  }
  if (parent_watcher.joinable())
    parent_watcher.join();
  DisconnectNamedPipe(pipe);
  for (auto &entry : sessions)
    ReleaseWindowsSessionResources(&entry.second);
  sessions.clear();
  if (SUCCEEDED(initialized))
    CoUninitialize();
  CloseHandle(pipe);
  CloseHandle(parent);
  return 0;
}

} // namespace

int wmain(int argc, wchar_t **argv) {
  if (!ConfigurePerMonitorDpiAwareness())
    return 8;
  if (argc == 2 && std::wstring_view(argv[1]) == L"--probe-json")
    return ProbeMain();
  if (argc != 5 || std::wstring_view(argv[1]) != L"--pipe" ||
      std::wstring_view(argv[3]) != L"--parent-pid")
    return 1;
  DWORD parent_pid = 0;
  if (!ParseUnsigned(argv[4], &parent_pid))
    return 1;
  return ServeMain(argv[2], parent_pid);
}
