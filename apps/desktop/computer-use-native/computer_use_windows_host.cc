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
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

#include "computer_use_protocol.h"

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
std::uint64_t last_closed_cancel_epoch = 0;

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
  if (!sessions.empty() && !sessions.contains(session_key)) {
    *reason = "session_limit";
    return false;
  }
  const auto active_before_focus = sessions.find(session_key);
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
    if (IsIconic(window))
      ShowWindow(window, SW_RESTORE);
    if (refocus_window != window && IsIconic(refocus_window))
      ShowWindow(refocus_window, SW_RESTORE);
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
              ",\"pid\":" + std::to_string(pid) + ",\"windowHandle\":\"" +
              std::to_string(window_value) + "\"}";
  return true;
}

bool CloseWindowsSession(const Frame &request, std::string *response) {
  const auto found = sessions.find(FrameIdKey(request.header.session_id));
  if (found != sessions.end()) {
    last_closed_cancel_epoch =
        std::max(last_closed_cancel_epoch, found->second.cancel_epoch);
    ReleaseWindowsSessionResources(&found->second);
    sessions.erase(found);
  }
  *response = "{\"result\":\"closed\"}";
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
    DWORD read = 0;
    if (!ReadFile(pipe, output + offset, request, &read, nullptr) || read == 0)
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
    DWORD written = 0;
    if (!WriteFile(pipe, input + offset, request, &written, nullptr) ||
        written == 0)
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

bool HasUiAutomation() {
  IUIAutomation *automation = nullptr;
  const HRESULT result =
      CoCreateInstance(CLSID_CUIAutomation, nullptr, CLSCTX_INPROC_SERVER,
                       IID_PPV_ARGS(&automation));
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
      *nodes >= 5'000 || json->size() > 512 * 1024)
    return false;
  ++*nodes;
  BSTR name = nullptr;
  BSTR automation_id = nullptr;
  BSTR help = nullptr;
  CONTROLTYPEID control_type = 0;
  BOOL password = FALSE;
  const bool attributes_read =
      SUCCEEDED(element->get_CurrentName(&name)) &&
      SUCCEEDED(element->get_CurrentAutomationId(&automation_id)) &&
      SUCCEEDED(element->get_CurrentHelpText(&help)) &&
      SUCCEEDED(element->get_CurrentControlType(&control_type)) &&
      SUCCEEDED(element->get_CurrentIsPassword(&password));
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
  HRESULT result = walker->GetFirstChildElement(element, &child);
  bool first = true;
  bool complete = SUCCEEDED(result);
  while (complete && child != nullptr) {
    if (!first)
      *json += ',';
    first = false;
    if (!AppendUiaTree(child, walker, depth + 1, nodes, json))
      complete = false;
    IUIAutomationElement *next = nullptr;
    if (complete && FAILED(walker->GetNextSiblingElement(child, &next)))
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
  IUIAutomation *automation = nullptr;
  if (FAILED(CoCreateInstance(CLSID_CUIAutomation, nullptr,
                              CLSCTX_INPROC_SERVER,
                              IID_PPV_ARGS(&automation))) ||
      automation == nullptr)
    return false;
  IUIAutomationElement *root = nullptr;
  IUIAutomationTreeWalker *walker = nullptr;
  const HRESULT root_result = automation->ElementFromHandle(window, &root);
  const HRESULT walker_result = automation->get_RawViewWalker(&walker);
  std::string value;
  std::size_t count = 0;
  const bool complete = SUCCEEDED(root_result) && SUCCEEDED(walker_result) &&
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
  if (element == nullptr)
    return risk;
  BSTR name = nullptr;
  BSTR automation_id = nullptr;
  BSTR help = nullptr;
  CONTROLTYPEID control_type = 0;
  BOOL password = FALSE;
  const bool attributes_read =
      SUCCEEDED(element->get_CurrentName(&name)) &&
      SUCCEEDED(element->get_CurrentAutomationId(&automation_id)) &&
      SUCCEEDED(element->get_CurrentHelpText(&help)) &&
      SUCCEEDED(element->get_CurrentControlType(&control_type)) &&
      SUCCEEDED(element->get_CurrentIsPassword(&password));
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
  IUIAutomation *automation = nullptr;
  IUIAutomationTreeWalker *walker = nullptr;
  if (FAILED(CoCreateInstance(CLSID_CUIAutomation, nullptr,
                              CLSCTX_INPROC_SERVER,
                              IID_PPV_ARGS(&automation))) ||
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
    IUIAutomationElement *parent = nullptr;
    const HRESULT parent_result = walker->GetParentElement(current, &parent);
    if (FAILED(parent_result)) {
      metadata_complete = false;
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
  IUIAutomation *automation = nullptr;
  if (FAILED(CoCreateInstance(CLSID_CUIAutomation, nullptr,
                              CLSCTX_INPROC_SERVER,
                              IID_PPV_ARGS(&automation))) ||
      automation == nullptr)
    return {};
  IUIAutomationElement *element = nullptr;
  const POINT query = point;
  const HRESULT found = automation->ElementFromPoint(query, &element);
  automation->Release();
  if (FAILED(found) || element == nullptr) {
    if (element != nullptr)
      element->Release();
    return {};
  }
  int owner_pid = 0;
  if (FAILED(element->get_CurrentProcessId(&owner_pid)) || owner_pid <= 0 ||
      static_cast<std::uint32_t>(owner_pid) != expected_pid) {
    element->Release();
    return {};
  }
  const WindowsUiaRisk risk = ClassifyWindowsUiaElement(element);
  if (control_signature != nullptr)
    ComputeWindowsControlSignature(element, expected_pid, nullptr, control_signature);
  element->Release();
  return risk;
}

WindowsUiaRisk ClassifyWindowsFocusedElement(std::uint32_t expected_pid) {
  IUIAutomation *automation = nullptr;
  if (FAILED(CoCreateInstance(CLSID_CUIAutomation, nullptr,
                              CLSCTX_INPROC_SERVER,
                              IID_PPV_ARGS(&automation))) ||
      automation == nullptr)
    return {};
  IUIAutomationElement *element = nullptr;
  const HRESULT found = automation->GetFocusedElement(&element);
  automation->Release();
  if (FAILED(found) || element == nullptr) {
    if (element != nullptr)
      element->Release();
    return {};
  }
  int owner_pid = 0;
  if (FAILED(element->get_CurrentProcessId(&owner_pid)) || owner_pid <= 0 ||
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
  if (element == nullptr || signature == nullptr)
    return false;
  int owner_pid = 0;
  CONTROLTYPEID control_type = 0;
  RECT bounds{};
  BSTR automation_id = nullptr;
  SAFEARRAY *runtime_id = nullptr;
  const bool facts =
      SUCCEEDED(element->get_CurrentProcessId(&owner_pid)) && owner_pid > 0 &&
      static_cast<std::uint32_t>(owner_pid) == expected_pid &&
      SUCCEEDED(element->get_CurrentControlType(&control_type)) &&
      SUCCEEDED(element->get_CurrentBoundingRectangle(&bounds)) &&
      bounds.right > bounds.left && bounds.bottom > bounds.top &&
      (containing_bounds == nullptr ||
       (bounds.left >= containing_bounds->left &&
        bounds.top >= containing_bounds->top &&
        bounds.right <= containing_bounds->right &&
        bounds.bottom <= containing_bounds->bottom)) &&
      SUCCEEDED(element->get_CurrentAutomationId(&automation_id)) &&
      SUCCEEDED(element->GetRuntimeId(&runtime_id)) && runtime_id != nullptr &&
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
      SUCCEEDED(element->get_CurrentAutomationId(&automation_id)) &&
      SUCCEEDED(element->get_CurrentName(&name));
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
      duplicate_targets == nullptr || depth > 16 || *nodes >= 5'000)
    return false;
  ++*nodes;

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
  const HRESULT first_result = walker->GetFirstChildElement(element, &child);
  if (FAILED(first_result))
    return false;
  while (child != nullptr) {
    if (!CollectWindowsControlBindings(child, walker, expected_pid, depth + 1, nodes,
                                       bindings, duplicate_targets)) {
      child->Release();
      return false;
    }
    IUIAutomationElement *next = nullptr;
    const HRESULT next_result = walker->GetNextSiblingElement(child, &next);
    child->Release();
    if (FAILED(next_result)) {
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
  IUIAutomation *automation = nullptr;
  if (FAILED(CoCreateInstance(CLSID_CUIAutomation, nullptr, CLSCTX_INPROC_SERVER,
                              IID_PPV_ARGS(&automation))) ||
      automation == nullptr)
    return false;
  IUIAutomationElement *root = nullptr;
  IUIAutomationTreeWalker *walker = nullptr;
  const bool initialized =
      SUCCEEDED(automation->ElementFromHandle(window, &root)) && root != nullptr &&
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
  IUIAutomation *automation = nullptr;
  if (FAILED(CoCreateInstance(CLSID_CUIAutomation, nullptr,
                              CLSCTX_INPROC_SERVER,
                              IID_PPV_ARGS(&automation))) ||
      automation == nullptr)
    return false;
  IUIAutomationElement *element = nullptr;
  const HRESULT found = automation->GetFocusedElement(&element);
  automation->Release();
  if (FAILED(found) || element == nullptr) {
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
  if (!risk.metadata_complete || !risk.classified) {
    *reason = "target_unclassified";
    return true;
  }
  if (risk.secure) {
    *reason = "secure_field_blocked";
    return true;
  }
  if (risk.high_impact) {
    *reason = "high_impact_blocked";
    return true;
  }
  return false;
}

bool FindUiaTargetRecursive(IUIAutomationElement *element,
                            IUIAutomationTreeWalker *walker,
                            std::string_view target_id, std::size_t depth,
                            std::size_t *visited, IUIAutomationElement **match,
                            bool *duplicate) {
  if (element == nullptr || walker == nullptr || depth > 16 ||
      *visited >= 5'000)
    return false;
  ++*visited;
  BSTR automation_id = nullptr;
  BSTR name = nullptr;
  const bool attributes_read =
      SUCCEEDED(element->get_CurrentAutomationId(&automation_id)) &&
      SUCCEEDED(element->get_CurrentName(&name));
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
  if (FAILED(walker->GetFirstChildElement(element, &child)))
    return false;
  while (child != nullptr && !*duplicate) {
    if (!FindUiaTargetRecursive(child, walker, target_id, depth + 1, visited,
                                match, duplicate)) {
      child->Release();
      return false;
    }
    IUIAutomationElement *next = nullptr;
    if (FAILED(walker->GetNextSiblingElement(child, &next))) {
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
  if (FAILED(CoCreateInstance(CLSID_CUIAutomation, nullptr,
                              CLSCTX_INPROC_SERVER,
                              IID_PPV_ARGS(&automation))) ||
      automation == nullptr) {
    *reason = "accessibility_unavailable";
    return false;
  }
  IUIAutomationElement *root = nullptr;
  IUIAutomationTreeWalker *walker = nullptr;
  const bool initialized =
      SUCCEEDED(automation->ElementFromHandle(session.active_window, &root)) &&
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
    *reason = duplicate ? "target_ambiguous" : "target_required";
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
    if (SUCCEEDED(target->GetCurrentPatternAs(UIA_InvokePatternId,
                                              IID_PPV_ARGS(&pattern))) &&
        pattern != nullptr) {
      *accepted = true;
      action_result = pattern->Invoke();
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
    } else if (SUCCEEDED(target->GetCurrentPatternAs(UIA_ValuePatternId,
                                                     IID_PPV_ARGS(&pattern))) &&
               pattern != nullptr) {
      BSTR value = SysAllocStringLen(wide_text.data(),
                                    static_cast<UINT>(wide_text.size()));
      if (value == nullptr && !wide_text.empty()) {
        *reason = "semantic_action_failed";
      } else {
        *accepted = true;
        action_result = pattern->SetValue(value);
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
    target->get_CurrentName(&name);
    const std::string target_name =
        name == nullptr
            ? std::string{}
            : Utf8FromWide(std::wstring_view(name, SysStringLen(name)));
    if (name != nullptr)
      SysFreeString(name);
    if (!ReadJsonString(metadata, "value", &selected_value) ||
        (selected_value != target_id && selected_value != target_name)) {
      *reason = "semantic_value_mismatch";
    } else if (SUCCEEDED(target->GetCurrentPatternAs(UIA_SelectionItemPatternId,
                                                     IID_PPV_ARGS(&pattern))) &&
               pattern != nullptr) {
      *accepted = true;
      action_result = pattern->Select();
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
        FAILED(target->GetCurrentPatternAs(UIA_TogglePatternId,
                                           IID_PPV_ARGS(&pattern))) ||
        pattern == nullptr) {
      *reason = "semantic_pattern_unavailable";
    } else {
      ToggleState current = ToggleState_Indeterminate;
      if (FAILED(pattern->get_CurrentToggleState(&current)) ||
          current == ToggleState_Indeterminate) {
        *reason = "semantic_state_unavailable";
      } else if ((current == ToggleState_On) == wants_true) {
        action_result = S_OK;
      } else {
        *accepted = true;
        action_result = pattern->Toggle();
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
        FAILED(target->GetCurrentPatternAs(UIA_ExpandCollapsePatternId,
                                           IID_PPV_ARGS(&pattern))) ||
        pattern == nullptr) {
      *reason = "semantic_pattern_unavailable";
    } else {
      ExpandCollapseState current = ExpandCollapseState_LeafNode;
      if (FAILED(pattern->get_CurrentExpandCollapseState(&current)) ||
          current == ExpandCollapseState_LeafNode) {
        *reason = "semantic_state_unavailable";
      } else if ((current == ExpandCollapseState_Expanded) == wants_expand) {
        action_result = S_OK;
      } else {
        *accepted = true;
        action_result = wants_expand ? pattern->Expand() : pattern->Collapse();
      }
      pattern->Release();
    }
  }
  target->Release();
  if (FAILED(action_result)) {
    if (reason->empty())
      *reason = *accepted ? "input_not_confirmed" : "semantic_action_failed";
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

std::string RequestPayloadDigest(const Frame &request) {
  std::string payload;
  payload.reserve(sizeof(request.header.metadata_bytes) +
                  request.metadata.size() +
                  sizeof(request.header.binary_bytes) + request.binary.size());
  payload.append(reinterpret_cast<const char *>(&request.header.metadata_bytes),
                 sizeof(request.header.metadata_bytes));
  payload.append(reinterpret_cast<const char *>(request.metadata.data()),
                 request.metadata.size());
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
  return RevalidateWindowsTarget(session, expected, expected_epoch)
             ? SendInput(count, events, sizeof(INPUT))
             : 0;
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

bool DispatchWindowsAction(const WindowsSession &session,
                           const std::string &metadata, std::string *result,
                           std::string *reason, bool *accepted) {
  *accepted = false;
  const std::uint64_t expected_epoch = session.cancel_epoch;
  std::string kind;
  std::uint64_t requested_epoch = 0;
  std::uint64_t requested_observation = 0;
  if (!ReadJsonString(metadata, "type", &kind) ||
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
  const RECT bounds = session.observation_bounds;
  if (current_bounds.left != bounds.left || current_bounds.top != bounds.top ||
      current_bounds.right != bounds.right ||
      current_bounds.bottom != bounds.bottom ||
      !RevalidateWindowsTarget(session, bounds, expected_epoch)) {
    *reason = "stale_target";
    return false;
  }
  if (kind == "key" || kind == "type") {
    std::string current_focused_signature;
    if (!session.has_focused_element_signature ||
        !WindowsFocusedElementSignature(session.pid, bounds,
                                        &current_focused_signature) ||
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
    const int screen_x =
        bounds.left +
        static_cast<int>(
            std::lround(x * std::max<LONG>(0, bounds.right - bounds.left - 1)));
    const int screen_y =
        bounds.top +
        static_cast<int>(
            std::lround(y * std::max<LONG>(0, bounds.bottom - bounds.top - 1)));
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
    const POINT point = {
        bounds.left +
            static_cast<LONG>(std::lround(
                x * std::max<LONG>(0, bounds.right - bounds.left - 1))),
        bounds.top +
            static_cast<LONG>(std::lround(
                y * std::max<LONG>(0, bounds.bottom - bounds.top - 1))),
    };
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
    if (*accepted)
      *reason = "input_not_confirmed";
    else if (cancellation_epoch.load(std::memory_order_acquire) !=
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

bool ObserveWindowsWindow(WindowsSession &session, std::string *response,
                          std::vector<std::uint8_t> *binary,
                          std::string *reason) {
  RECT bounds{};
  WindowsDialogSetSnapshot dialogs;
  if (!ValidateWindowsSession(session, &bounds, reason, &dialogs) ||
      session.cancel_epoch !=
          cancellation_epoch.load(std::memory_order_acquire))
    return false;
  std::string tree;
  std::size_t nodes = 0;
  if (!ReadUiaObservation(session.pid, dialogs.active_window, &tree, &nodes)) {
    *reason = "accessibility_unavailable";
    return false;
  }
  WindowsControlBindings bindings;
  if (!CaptureWindowsControlBindings(session.pid, dialogs.active_window,
                                     &bindings)) {
    *reason = "accessibility_binding_unavailable";
    return false;
  }
  std::string stable_tree;
  std::size_t stable_nodes = 0;
  if (!ReadUiaObservation(session.pid, dialogs.active_window, &stable_tree,
                          &stable_nodes) ||
      stable_tree != tree || stable_nodes != nodes) {
    *reason = "observation_stale";
    return false;
  }
  WindowsControlBindings stable_bindings;
  if (!CaptureWindowsControlBindings(session.pid, dialogs.active_window,
                                     &stable_bindings) ||
      stable_bindings.semantic != bindings.semantic ||
      stable_bindings.visual != bindings.visual) {
    *reason = "observation_stale";
    return false;
  }
  const WindowsUiaRisk focused_risk =
      ClassifyWindowsFocusedElement(session.pid);
  std::string focused_element_signature;
  const bool has_focused_element_signature = WindowsFocusedElementSignature(
      session.pid, bounds, &focused_element_signature);
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
      succeeded = CloseWindowsSession(request, &response);
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
                         "{\"result\":\"canceled\"}"))
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
  case MessageType::kDispatch: {
    WindowsSession *session = FindWindowsSession(request);
    if (session == nullptr) {
      if (!RespondAndCache(pipe, request, MessageType::kError,
                           ErrorPayload("session_missing")))
        return false;
      break;
    }
    std::string result;
    std::string reason;
    bool accepted = false;
    const bool succeeded =
        DispatchWindowsAction(*session, metadata, &result, &reason, &accepted);
    if (!RespondAndCache(
            pipe, request,
            succeeded ? MessageType::kDispatchResult : MessageType::kError,
            succeeded ? "{\"result\":\"completed\",\"reasonCode\":null}"
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
  HANDLE pipe = CreateNamedPipeW(pipe_name.c_str(), PIPE_ACCESS_DUPLEX,
                                 PIPE_TYPE_BYTE | PIPE_READMODE_BYTE |
                                     PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
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
  const BOOL connected =
      ConnectNamedPipe(pipe, nullptr)
          ? TRUE
          : (GetLastError() == ERROR_PIPE_CONNECTED ? TRUE : FALSE);
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
