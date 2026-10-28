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
#include <mscat.h>
#include <appmodel.h>
#include <psapi.h>
#include <winioctl.h>

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

// The package catalog the v2 target facts read SignatureKind from (S5-c-3, #500 PR-2).
#if defined(_MSC_VER) && __has_include(<winrt/Windows.ApplicationModel.h>) &&     \
    __has_include(<winrt/Windows.Management.Deployment.h>)
#define SPRINT_CODER_HAS_WINDOWS_PACKAGE_CATALOG 1
#include <winrt/Windows.ApplicationModel.h>
#include <winrt/Windows.Management.Deployment.h>
#else
#define SPRINT_CODER_HAS_WINDOWS_PACKAGE_CATALOG 0
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
#include <functional>
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
#include <type_traits>
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
#include "computer_use_windows_target_facts.h"

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

std::atomic<bool> &WindowsTargetListWorkerRunning();

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

struct WindowsWireFingerprint {
  std::string digest;
  std::size_t in_flight = 0;
  bool cached = false;
};
struct WindowsWireLedger {
  std::mutex mutex;
  std::unordered_map<std::string, std::shared_ptr<WindowsWireFingerprint>> entries;
};
WindowsWireLedger& WindowsWireRequests() {
  static auto* ledger = new WindowsWireLedger;
  return *ledger;
}
struct WindowsWireLease {
  std::string key;
  std::shared_ptr<WindowsWireFingerprint> fingerprint;
  WindowsWireLease(std::string value, std::shared_ptr<WindowsWireFingerprint> owner)
      : key(std::move(value)), fingerprint(std::move(owner)) {}
  ~WindowsWireLease() {
    auto& ledger = WindowsWireRequests();
    std::lock_guard lock(ledger.mutex);
    const auto found = ledger.entries.find(key);
    if (fingerprint->in_flight != 0) --fingerprint->in_flight;
    if (found != ledger.entries.end() && found->second == fingerprint &&
        fingerprint->in_flight == 0 && !fingerprint->cached) ledger.entries.erase(found);
  }
};

std::shared_ptr<WindowsWireLease> RegisterWindowsWireRequest(
    const std::string& key, const std::string& digest, bool* fresh, std::string* error) {
  *fresh = false;
  if (digest.size() != 64) { *error = "request_id_conflict"; return nullptr; }
  auto& ledger = WindowsWireRequests();
  std::lock_guard lock(ledger.mutex);
  auto found = ledger.entries.find(key);
  if (found != ledger.entries.end() && found->second->digest != digest) {
    *error = "request_id_conflict"; return nullptr;
  }
  if (found == ledger.entries.end()) {
    // At most 256 cached responses, 64 queued frames, one consumer and one reader.
    if (ledger.entries.size() >= kMaximumCachedResponses + 66) {
      *error = "request_capacity_unavailable"; return nullptr;
    }
    auto fingerprint = std::make_shared<WindowsWireFingerprint>();
    fingerprint->digest = digest;
    found = ledger.entries.emplace(key, std::move(fingerprint)).first;
    *fresh = true;
  }
  ++found->second->in_flight;
  return std::make_shared<WindowsWireLease>(key, found->second);
}

bool MarkWindowsWireCached(const std::string& key, const std::string& digest, bool cached) {
  auto& ledger = WindowsWireRequests();
  std::lock_guard lock(ledger.mutex);
  auto found = ledger.entries.find(key);
  if (found == ledger.entries.end()) {
    if (!cached) return true;
    auto fingerprint = std::make_shared<WindowsWireFingerprint>();
    fingerprint->digest = digest;
    found = ledger.entries.emplace(key, std::move(fingerprint)).first;
  }
  if (cached && found->second->digest != digest) return false;
  found->second->cached = cached;
  if (!cached && found->second->in_flight == 0) ledger.entries.erase(found);
  return true;
}

struct WindowsStartAdmission {
  std::string session_key;
  std::string session_id;
  std::atomic<bool> stopped{false};
  std::atomic<std::uint32_t> pending_requests{0};
  std::shared_ptr<std::atomic<std::uint64_t>> input_api_attempts =
      std::make_shared<std::atomic<std::uint64_t>>(0);
  // Protected by the stop/adoption mutex; the reader never touches the sessions map.
  bool active = false;
  bool retired = false;
  bool terminal = false;
  std::uint64_t terminal_epoch = 0;
  std::uint64_t requested_epoch = 0;
  std::unordered_map<std::string, std::string> request_digests;
  std::deque<std::string> request_order;
};

struct WindowsStartLease {
  std::shared_ptr<WindowsStartAdmission> owner;
  explicit WindowsStartLease(std::shared_ptr<WindowsStartAdmission> value) : owner(std::move(value)) {
    owner->pending_requests.fetch_add(1, std::memory_order_acq_rel);
  }
  ~WindowsStartLease();
};

struct WindowsSession {
  std::shared_ptr<WindowsStartAdmission> start_owner;
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
  // What the session's eligibility stands on, bound when it is created and never changed by a resume
  // (S5-c-3 PR-3). It selects the interlocks' policy: kDeferToV1 for v1, kTakeover for v2.
  sprint_coder::computer_use::EligibilityBasis eligibility_basis =
      sprint_coder::computer_use::EligibilityBasis::kV1Allowlist;
  // A v2 session only (S5-c-3 PR-5): the System32 notepad file the explicit "not web" table matched
  // when the session started, or nothing. A file that changes later is not taken up again.
  std::optional<sprint_coder::computer_use::WindowsFileKey> not_web_file;
  // The table's answer of the last input judgement (ValidateWindowsDispatchBinding writes it, the
  // interlock of the same frame reads it; the helper serves one frame at a time). Reset before every
  // judgement, so a frame that did not judge never reads an older answer.
  mutable std::optional<bool> v2_input_not_web;
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

bool ReadJsonStringValueAt(std::string_view json, std::size_t* position, std::string* output) {
  auto& cursor = *position;
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

bool ReadPendingWindowsStop(const std::string& metadata, std::string* session_id) {
  std::size_t cursor = 0;
  const auto space = [&] {
    while (cursor < metadata.size() && (metadata[cursor] == ' ' || metadata[cursor] == '\t' ||
           metadata[cursor] == '\r' || metadata[cursor] == '\n')) ++cursor;
  };
  space();
  if (cursor >= metadata.size() || metadata[cursor++] != '{') return false;
  bool operation_seen = false, session_seen = false;
  for (int member = 0; member < 2; ++member) {
    space(); std::string key, value;
    if (!ReadJsonStringValueAt(metadata, &cursor, &key)) return false;
    space(); if (cursor >= metadata.size() || metadata[cursor++] != ':') return false;
    space(); if (!ReadJsonStringValueAt(metadata, &cursor, &value)) return false;
    if (key == "operation" && !operation_seen && value == "stop_pending_start") operation_seen = true;
    else if (key == "sessionId" && !session_seen && !value.empty() && value.size() <= 256) {
      session_seen = true; *session_id = std::move(value);
    } else return false;
    space();
    if (cursor >= metadata.size() || metadata[cursor++] != (member == 0 ? ',' : '}')) return false;
  }
  space(); return operation_seen && session_seen && cursor == metadata.size();
}

// BEGIN windows discovery syntax
struct WindowsDiscoveryParameters {
  std::string id;
  std::string canonical_path;
  std::string identity;
  std::string executable_digest;
  std::string signer_digest;
};

struct WindowsDiscoveryStringField {
  std::string_view key;
  std::string* value;
  bool seen = false;
};

bool ReadWindowsDiscoveryFields(std::string_view metadata,
                                std::span<WindowsDiscoveryStringField> fields) {
  std::size_t cursor = 0;
  const auto space = [&] {
    while (cursor < metadata.size() && (metadata[cursor] == ' ' || metadata[cursor] == '\t' ||
           metadata[cursor] == '\r' || metadata[cursor] == '\n')) ++cursor;
  };
  space();
  if (cursor >= metadata.size() || metadata[cursor++] != '{') return false;
  for (std::size_t member = 0; member < fields.size(); ++member) {
    space(); std::string key, value;
    if (!ReadJsonStringValueAt(metadata, &cursor, &key)) return false;
    space(); if (cursor >= metadata.size() || metadata[cursor++] != ':') return false;
    space(); if (!ReadJsonStringValueAt(metadata, &cursor, &value)) return false;
    const auto field = std::find_if(fields.begin(), fields.end(),
        [&](const auto& candidate) { return candidate.key == key; });
    if (field == fields.end() || field->seen) return false;
    field->seen = true; *field->value = std::move(value);
    space();
    if (cursor >= metadata.size() ||
        metadata[cursor++] != (member + 1 == fields.size() ? '}' : ',')) return false;
  }
  space();
  return cursor == metadata.size();
}

bool ReadWindowsDiscoveryQuery(std::string_view metadata, WindowsDiscoveryParameters* output) {
  std::string operation;
  std::array fields = {
    WindowsDiscoveryStringField{"operation", &operation},
    WindowsDiscoveryStringField{"discoveryId", &output->id},
    WindowsDiscoveryStringField{"canonicalPath", &output->canonical_path},
    WindowsDiscoveryStringField{"identityDigest", &output->identity},
    WindowsDiscoveryStringField{"executableDigest", &output->executable_digest},
    WindowsDiscoveryStringField{"signerDigest", &output->signer_digest},
  };
  const auto digest = [](std::string_view value) {
    return value.size() == 64 && std::all_of(value.begin(), value.end(), [](char c) {
      return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
    });
  };
  return ReadWindowsDiscoveryFields(metadata, fields) && operation == "list_windows_cancellable" &&
      !output->id.empty() && output->id.size() <= 256 && !output->canonical_path.empty() &&
      digest(output->identity) && digest(output->executable_digest) &&
      (output->signer_digest.empty() || digest(output->signer_digest));
}

bool ReadWindowsDiscoveryStop(std::string_view metadata, std::string* id) {
  std::string operation;
  std::array fields = {
    WindowsDiscoveryStringField{"operation", &operation},
    WindowsDiscoveryStringField{"discoveryId", id},
  };
  return ReadWindowsDiscoveryFields(metadata, fields) && operation == "stop_window_discovery" &&
      !id->empty() && id->size() <= 256;
}
// END windows discovery syntax

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
  // On the heap (S5-c-3 PR-5): a 1 MiB array here took the whole default 1 MiB stack, so a caller one
  // level deeper than V1's (the v2 judgement inside a start, or list_targets) overflowed it
  // (0xC00000FD, found by the v2 targets live seam). The bytes hashed and the digest are the same.
  std::vector<std::uint8_t> chunk(1 << 20);
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
  static const auto *digest = new std::string([]() {
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
  }());
  return *digest;
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

std::string WindowsV2LabelTrimmed(std::string_view text);

// Main rejects labels whose JavaScript trim is empty. Preserve all nonblank V1 bytes, including
// surrounding whitespace, and share the V2 whitespace set only to detect the fallback (#947).
std::string WindowsV1DisplayName(std::string_view display_name) {
  return WindowsV2LabelTrimmed(display_name).empty() ? "Application" : std::string(display_name);
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
             WindowsV1DisplayName(display_name),
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
  ScopedKernelHandle file(CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
                                     OPEN_EXISTING,
                                     FILE_ATTRIBUTE_NORMAL | FILE_FLAG_SEQUENTIAL_SCAN, nullptr));
  if (file.value == INVALID_HANDLE_VALUE)
    return false;
  WindowsExecutableIdentity identity;
  if (!BuildLockedWindowsExecutableIdentity(file.value, &identity))
    return false;
  output->identity = std::move(identity);
  output->file = file.release();
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
  ScopedKernelHandle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid));
  if (process.value == nullptr)
    return false;
  return OpenLockedProcessExecutable(process.value, output);
}

bool WindowsExecutableIdentityMatches(
    const WindowsExecutableIdentity &actual, std::string_view identity_digest,
    std::string_view executable_digest, std::string_view signer_digest) {
  return actual.identity_digest == identity_digest &&
         actual.executable_digest == executable_digest &&
         (signer_digest.empty() ? actual.signer_digest.empty()
                                : actual.signer_digest == signer_digest);
}

bool WindowsExecutableBindingMatches(
    const WindowsFileIdentity &recorded, std::string_view executable_digest,
    std::string_view signer_digest, std::string_view policy_language,
    const WindowsFileIdentity &held, const WindowsExecutableIdentity &current) {
  return SameWindowsFileIdentity(held, recorded) &&
         SameWindowsFileIdentity(held, current.file_identity) &&
         executable_digest == current.executable_digest &&
         signer_digest == current.signer_digest &&
         policy_language == current.policy_language;
}

bool WindowsSessionExecutableMatches(
    const WindowsSession &session,
    const LockedWindowsExecutable &current_executable) {
  WindowsFileIdentity held_identity;
  return session.executable_file != INVALID_HANDLE_VALUE &&
         current_executable.file != INVALID_HANDLE_VALUE &&
         ReadWindowsFileIdentity(session.executable_file, &held_identity) &&
         WindowsExecutableBindingMatches(
             {session.executable_volume_serial, session.executable_file_id},
             session.executable_digest, session.signer_digest,
             session.policy_language, held_identity, current_executable.identity);
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

// BEGIN windows target facts (#500 S5-c-3 PR-2)
// The facts the v2 target eligibility core reads (TargetFacts in
// computer_use_deny_ruleset_generated.h), measured for one process through handles. Nothing calls
// this yet: PR-5 makes list_targets and the v2 start, resume and per-input checks use it. No V1
// path changes: the V1 identity, its embedded-only signer read (ReadAuthenticodeSignerDigest) and
// its allow-list stay as they are. A fact that cannot be measured stays std::nullopt, and the core
// then answers unresolvable; nothing here turns a failure into a value that admits.
//
//   * Running image. The process's path is read first (QueryFullProcessImageNameW, as V1 reads it
//     before it opens the file). The main image is then found from kernel-held data, not from the
//     target's module list (the PEB Ldr list is writable by the target, so its first entry can be
//     made to name another file): NtQueryInformationProcess(ProcessImageInformation) gives the
//     entry point and header summary the kernel recorded at creation, VirtualQueryEx confirms the
//     entry point is in a MEM_IMAGE region, and GetMappedFileNameW on that region's base names the
//     backing file. That file is opened and held without write or delete sharing. The anchor that
//     the held file is the running image is a re-read of QueryFullProcessImageNameW after the hold:
//     it names the kernel's image file object, which follows a rename of the running image, so when
//     a target unmaps its image and maps another file B at the entry point's address (and rewrites
//     its Ldr list), the re-read still names the real image and opens a different file than the one
//     held, which is a mismatch (W-UR). This rests on QueryFullProcessImageNameW following a
//     rename, which a one-time probe confirms (WindowsTargetRenameFollows): it renames a suspended
//     copy of this helper within its directory and then moves it to another directory on the temp
//     volume, and both must be followed. The probe speaks only for the temp volume's file system,
//     so a target matches only when the probe followed and the target's own file system is the same
//     (a target on another file system, e.g. a Dev Drive's ReFS when temp is NTFS, is W-UR until a
//     probe for it exists). The kernel name is read once before the open and once after, both must
//     agree (a rename racing the open is caught, since the file-id compare still ties the opened
//     file to the real image's id), the held file must sit on a volume with a stable 128-bit file
//     id (NTFS or ReFS), and that volume must not be remote (SMB can report "NTFS", so
//     FileRemoteProtocolInfo decides). A hard-link count is not required: Windows servicing
//     hard-links legitimate system binaries (WinSxS), the eligible System32 image among them, and
//     the name and file-id checks already defeat a hard link placed at the old name (it carries the
//     other file's id). The PE header
//     against the kernel summary (entry
//     RVA, subsystem, machine, checksum, image file size, characteristics, stack sizes), the
//     recorded path still naming the held file, the kernel mapped name staying put, and the module
//     list are auxiliary deny-side checks. The held file must also be unchanged since the process
//     was created: its ChangeTime before the creation time (a writer that kept its handle across
//     the image section's creation can rewrite the file afterwards, as in process herpaderping,
//     and the facts would then be of the new bytes; on NTFS and ReFS a data write, SetFileTime
//     and a rename all move ChangeTime); a time that cannot be read, or one at or after the
//     creation, is a mismatch. LastWriteTime is not judged: it may lie in the future for an
//     honest file (a ZIP's DOS local time unpacked in another time zone, a copy from a machine
//     whose clock ran ahead), and a writer who can set ChangeTime back can set it back too. The
//     ChangeTime can be set back by a writer
//     with FILE_WRITE_ATTRIBUTES, and a rewrite before the process object was created is older
//     than it, so this narrows the attack rather than closing it (ADR §10 risk). Any mismatch, or
//     a target whose kernel data or re-read name cannot be read, is W-UR. Every other fact is read
//     from the held file. Residual risk: the
//     header cross-check is not by itself sufficient (checksum is outside the Authenticode hash and
//     an attacker who builds the original image can match the rest), so the defense rests on the
//     re-read naming the real image, which assumes QueryFullProcessImageNameW follows the rename;
//     an OS where it does not would not be protected (to be confirmed before PR-6; ADR §10 risk).
//   * Path, root, leaf, volume. The held file's canonical path (GetFinalPathNameByHandleW) placed
//     among roots canonicalized the same way. The volume is network when the file system says the
//     file is remote, removable for a removable, optical, RAM, USB, SD, MMC, 1394 or file-backed
//     virtual disk, and fixed otherwise; a volume that cannot be asked is not measured.
//   * Signature. WinVerifyTrust on the held file: the embedded signature, or, when the file has
//     none, a catalog that carries its hash. The leaf's thumbprint and O, and
//     CERT_CHAIN_POLICY_MICROSOFT_ROOT, come from the chain WinVerifyTrust verified (not from a
//     comparison of the O). A catalog signature makes the facts more exact but never admits
//     (decision I): outside %WINDIR% a catalog-only file is given to the core as unsigned (the
//     upper class at most), while its O and its Microsoft root still refuse.
//   * Decision K (revocation). WinVerifyTrust runs with WTD_REVOKE_NONE and
//     WTD_CACHE_ONLY_URL_RETRIEVAL, as V1 does: no revocation check and no network. A cache-only
//     revocation check was considered and not taken: (1) for most files the cache holds no
//     revocation data, so the check answers "offline", which must not admit and so changes
//     nothing; (2) when it does answer, the answer depends on what this machine happened to cache,
//     so the same target could be judged differently by two machines or flip within a session;
//     (3) it doubles the WinVerifyTrust cost of every listed target; (4) no CI runner can show a
//     revoked signer, so the path would ship untested. The residual risk is ADR §10 risk 1.
//   * PE subsystem from the held file's header; the manifest's execution level and
//     OriginalFilename from its resources. OriginalFilename is read only when the signature
//     verified (embedded or catalog), and is "" otherwise. The resources are read through the held
//     handle (an image view of it, ReadWindowsTargetResourceSection), never by opening the path
//     again, and found without the loader (FindPeResources), so no .mui file is consulted.
//   * Token. Elevation, another user, another session, a protected process, UIAccess, an integrity
//     level above this process's, and AppContainer. An item that cannot be read is given as the
//     refusing value (true).
//   * Package. Family, full name and publisherId from the process handle, development mode from
//     the package information, SignatureKind from the package catalog (C++/WinRT). PR-4 binds the
//     family and the publisherId to the identity digest (the windows package identity block, below).
//   * Lineage. One kernel snapshot (SystemProcessInformation) gives every process's parent pid
//     and creation time without opening any process; descendants follow parent pids only to
//     processes created no earlier (FindWindowsDescendants), so a reused pid is not a parent.
//     Residual risk: a child whose parent has exited cannot be traced (the system does not
//     reparent it), nor one started with another parent named (PROC_THREAD_ATTRIBUTE_PARENT_
//     PROCESS), so descendant_shell = false says "no shell below that a live chain shows". No
//     orphan signal is used, after weighing these: (a) the target's job (the job's processes
//     cannot be listed without a handle to the job, which a process handle does not give); (b)
//     orphans (same user and session, parent gone, created after the target), which would cap
//     every long-running target at C for any unrelated detached shell the user started later
//     (a terminal closed under its shell, `start` from a closed cmd), and which a hostile target
//     still evades by naming another parent. What the cap is for, an app that hosts a shell or a
//     pseudo console in its own surface, keeps the owner of that console alive below the target
//     (a pseudo console ends with its owner's handle), so a live chain shows it; hiding a shell
//     on purpose is the target lying, which these facts cannot prevent (ADR §10 risk).
//     Each descendant is read from its own running image, held as the target's is: a non-GUI
//     subsystem, or a leaf or OriginalFilename on the W4 table, is a shell, so a renamed copy of
//     a shell is one too; a descendant that cannot be read is taken as a shell. At most
//     kWindowsTargetDescendantInspectLimit descendants within kWindowsTargetDescendantBudgetMs;
//     beyond that the descendant facts are not measured.

inline constexpr std::size_t kWindowsTargetDescendantLimit = 1024;
// The descendants of one target that are read from their images, and the time that may take.
// More than that, or longer: the descendant facts are not measured (unresolvable).
inline constexpr std::size_t kWindowsTargetDescendantInspectLimit = 64;
inline constexpr ULONGLONG kWindowsTargetDescendantBudgetMs = 2'000;
inline constexpr std::string_view kWindowsTargetFixtureLeaf =
    "sprint-coder-computer-use-fixture.exe";

enum class WindowsTargetSignatureSource : std::uint8_t { kNone, kEmbedded, kCatalog };

// A volume's file system (lower-cased name and the FileSystemFlags), read from a held handle.
struct WindowsTargetVolume {
  std::string file_system;
  std::uint32_t flags = 0;
};

// What the one-time rename-follow probe found: whether QueryFullProcessImageNameW follows a rename
// of a running image on the probed volume, and that volume's file system (name and flags).
struct WindowsTargetRenameProbe {
  bool follows = false;
  WindowsTargetVolume volume;
};

// What the caller knows that the target cannot tell: the roots (in precedence order), the process
// whose descendants are Sprint Coder's own, this helper's signer, and the acceptance mode.
struct WindowsTargetFactsContext {
  std::optional<std::vector<sprint_coder::computer_use::WindowsImageRootPrefix>> roots;
  std::uint32_t lineage_root_pid = 0;
  std::uint64_t lineage_root_creation = 0;
  std::string self_signer_thumbprint;
  bool acceptance_mode = false;
  // The one-time rename-follow probe (WindowsTargetRenameFollows): whether the kernel image name
  // follows a rename on the probed (temp) volume, and that volume's file system. The running-image
  // anchor rests on it, so a target matches only when the probe followed and the target's own file
  // system is the same as the probed one; otherwise the target is unresolvable.
  std::optional<WindowsTargetRenameProbe> rename_probe;
};

struct WindowsTargetFactsMeasurement {
  sprint_coder::computer_use::TargetFacts facts;
  std::uint32_t pid = 0;
  std::optional<std::uint64_t> creation;
  // The parent, when the snapshot names one created no later than the target.
  std::optional<std::uint32_t> parent_pid;
  std::wstring image_path;
  std::optional<WindowsFileIdentity> file_identity;
  WindowsTargetSignatureSource signature_source = WindowsTargetSignatureSource::kNone;
  std::string signer_thumbprint;
  std::optional<std::string> package_full_name;
  std::optional<std::string> package_publisher_id;
  // The verified package's install location, canonicalized, when the target is a package.
  std::optional<std::string> package_install_root;
};

struct WindowsTargetSignature {
  // "valid", "unsigned" or "invalid", as verified (before decision I).
  std::optional<std::string> state;
  WindowsTargetSignatureSource source = WindowsTargetSignatureSource::kNone;
  std::string thumbprint;
  std::optional<std::string> organization;
  std::optional<bool> microsoft_root;
};

std::optional<std::uint64_t> WindowsTargetCreationTime(HANDLE process) {
  FILETIME created{}, exited{}, kernel{}, user{};
  if (process == nullptr ||
      GetProcessTimes(process, &created, &exited, &kernel, &user) != TRUE)
    return std::nullopt;
  return (static_cast<std::uint64_t>(created.dwHighDateTime) << 32) |
         created.dwLowDateTime;
}

std::optional<std::string> WindowsTargetUtf8(std::wstring_view value) {
  if (value.empty())
    return std::string{};
  std::string converted = Utf8FromWide(value);
  if (converted.empty())
    return std::nullopt;
  return converted;
}

bool SameWindowsTargetName(std::wstring_view left, std::wstring_view right) {
  return left.size() == right.size() &&
         CompareStringOrdinal(left.data(), static_cast<int>(left.size()),
                              right.data(), static_cast<int>(right.size()),
                              TRUE) == CSTR_EQUAL;
}

// A directory canonicalized the way image paths are, or "" when it cannot be opened.
std::string CanonicalWindowsTargetDirectory(const std::wstring &directory) {
  if (directory.empty())
    return {};
  ScopedKernelHandle handle(CreateFileW(
      directory.c_str(), FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
      OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr));
  std::wstring canonical;
  if (handle.value == INVALID_HANDLE_VALUE ||
      !CanonicalWindowsPathFromHandle(handle.value, &canonical))
    return {};
  return Utf8FromWide(canonical);
}

std::wstring WindowsTargetKnownFolder(REFKNOWNFOLDERID folder) {
  PWSTR path = nullptr;
  std::wstring result;
  if (SUCCEEDED(SHGetKnownFolderPath(folder, KF_FLAG_DONT_VERIFY, nullptr,
                                     &path)) &&
      path != nullptr)
    result = path;
  CoTaskMemFree(path);
  return result;
}

// Sprint Coder's own install root: the parent of the helper's `resources` directory in a package,
// or the helper's directory otherwise (a development build).
std::wstring WindowsTargetSelfInstallRoot() {
  std::vector<wchar_t> buffer(32'768, L'\0');
  const DWORD length = GetModuleFileNameW(nullptr, buffer.data(),
                                          static_cast<DWORD>(buffer.size()));
  if (length == 0 || static_cast<std::size_t>(length) >= buffer.size())
    return {};
  std::wstring directory(buffer.data(), length);
  const std::size_t leaf = directory.find_last_of(L"\\/");
  if (leaf == std::wstring::npos)
    return {};
  directory.resize(leaf);
  const std::size_t slash = directory.find_last_of(L"\\/");
  if (slash != std::wstring::npos &&
      SameWindowsTargetName(std::wstring_view(directory).substr(slash + 1),
                            L"resources"))
    directory.resize(slash);
  return directory;
}

// The roots in precedence order (the first one a path lies under names it). std::nullopt when the
// self install root was given but cannot be canonicalized: Sprint Coder's own files would then
// pass as an ordinary root. A root that does not exist holds nothing and is left out.
std::optional<std::vector<sprint_coder::computer_use::WindowsImageRootPrefix>>
CurrentWindowsTargetRoots(const std::wstring &self_install_root) {
  using sprint_coder::computer_use::WindowsImageRootPrefix;
  std::vector<WindowsImageRootPrefix> roots;
  if (!self_install_root.empty()) {
    std::string self = CanonicalWindowsTargetDirectory(self_install_root);
    if (self.empty())
      return std::nullopt;
    roots.push_back({"self_install", std::move(self)});
  }
  const auto add = [&roots](std::string_view root, const std::wstring &directory) {
    std::string prefix = CanonicalWindowsTargetDirectory(directory);
    if (!prefix.empty())
      roots.push_back({root, std::move(prefix)});
  };
  const std::string program_files = CanonicalWindowsTargetDirectory(
      WindowsTargetKnownFolder(FOLDERID_ProgramFiles));
  // WindowsApps lists nothing to a user, so its own name is spelled rather than opened.
  if (!program_files.empty())
    roots.push_back({"windows_apps", program_files + "\\WindowsApps"});
  std::vector<wchar_t> windows(32'768, L'\0');
  const UINT windows_length = GetSystemWindowsDirectoryW(
      windows.data(), static_cast<UINT>(windows.size()));
  if (windows_length > 0 && windows_length < windows.size())
    add("windows_directory", std::wstring(windows.data(), windows_length));
  if (!program_files.empty())
    roots.push_back({"program_files", program_files});
  add("program_files", WindowsTargetKnownFolder(FOLDERID_ProgramFilesX86));
  add("local_programs", WindowsTargetKnownFolder(FOLDERID_UserProgramFiles));
  std::vector<wchar_t> temp(32'768, L'\0');
  const DWORD temp_length =
      GetTempPathW(static_cast<DWORD>(temp.size()), temp.data());
  if (temp_length > 0 && temp_length < temp.size())
    add("temp", std::wstring(temp.data(), temp_length));
  add("downloads", WindowsTargetKnownFolder(FOLDERID_Downloads));
  return roots;
}

// Whether a handle's file is on a remote volume (an SMB share and such, which can report a local
// file system name like "NTFS"). The decision is made from the held handle, so it holds through
// UNC, SUBST and mount points, unlike a drive-letter or path-prefix test. The primary is the
// kernel's FileFsDeviceInformation (its Characteristics FILE_REMOTE_DEVICE bit, read with
// NtQueryVolumeInformationFile); FileRemoteProtocolInfo is a supplementary remote signal. Remote
// (true) when either shows remote; local (false) only when the device info is readable and local;
// std::nullopt (unknown, treated as W-UR) when the device info cannot be read.
std::optional<bool> WindowsTargetFileIsRemote(HANDLE file) {
  // IO_STATUS_BLOCK is in <winternl.h>, which this TU does not include; its x64 layout is two
  // pointer-sized words, pinned here as the one is for SECTION_IMAGE_INFORMATION.
  struct IoStatusBlock {
    PVOID pointer;
    ULONG_PTR information;
  };
  using NtQueryVolumeInformationFileFn =
      LONG(WINAPI *)(HANDLE, IoStatusBlock *, PVOID, ULONG, int);
  static const NtQueryVolumeInformationFileFn query = []() {
    const HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    return ntdll == nullptr ? nullptr
                            : reinterpret_cast<NtQueryVolumeInformationFileFn>(
                                  GetProcAddress(ntdll, "NtQueryVolumeInformationFile"));
  }();
  if (query == nullptr)
    return std::nullopt;
  struct FileFsDeviceInformation {
    ULONG device_type;
    ULONG characteristics;
  };
  constexpr int kFileFsDeviceInformation = 4;
  constexpr ULONG kFileRemoteDevice = 0x10; // FILE_REMOTE_DEVICE
  FileFsDeviceInformation device{};
  IoStatusBlock status{};
  if (query(file, &status, &device, sizeof(device), kFileFsDeviceInformation) < 0)
    return std::nullopt;
  if ((device.characteristics & kFileRemoteDevice) != 0)
    return true;
  FILE_REMOTE_PROTOCOL_INFO remote{};
  if (GetFileInformationByHandleEx(file, FileRemoteProtocolInfo, &remote, sizeof(remote)))
    return true;
  return false;
}

// The volume (file system name lower-cased, and FileSystemFlags) of a handle's file, or
// std::nullopt. A remote or unknown-remoteness volume is std::nullopt whatever name it reports.
std::optional<WindowsTargetVolume> WindowsTargetReadVolume(HANDLE file) {
  if (WindowsTargetFileIsRemote(file) != std::optional<bool>(false))
    return std::nullopt;
  std::array<wchar_t, MAX_PATH + 1> name{};
  DWORD flags = 0;
  if (GetVolumeInformationByHandleW(file, nullptr, 0, nullptr, nullptr, &flags, name.data(),
                                    static_cast<DWORD>(name.size())) != TRUE)
    return std::nullopt;
  std::string lowered = Utf8FromWide(name.data());
  for (char &letter : lowered)
    if (letter >= 'A' && letter <= 'Z') letter = static_cast<char>(letter - 'A' + 'a');
  return WindowsTargetVolume{std::move(lowered), flags};
}

// Whether a file system's 128-bit file id is dependable: NTFS or ReFS.
bool WindowsTargetFileSystemHasStableId(std::string_view file_system) {
  return file_system == "ntfs" || file_system == "refs";
}

// Opens a Win32 path read-only (sharing everything, so a running image can be opened) and returns
// its canonical path and file identity, or std::nullopt when it cannot be opened or read.
struct WindowsPathIdentity {
  std::wstring canonical_path;
  WindowsFileIdentity identity;
};
std::optional<WindowsPathIdentity> WindowsTargetOpenPathIdentity(const std::wstring &path) {
  ScopedKernelHandle file(CreateFileW(
      path.c_str(), FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
      FILE_ATTRIBUTE_NORMAL, nullptr));
  WindowsPathIdentity result;
  if (file.value == INVALID_HANDLE_VALUE ||
      !ReadWindowsFileIdentity(file.value, &result.identity) ||
      !CanonicalWindowsPathFromHandle(file.value, &result.canonical_path))
    return std::nullopt;
  return result;
}

// Measures, once, whether QueryFullProcessImageNameW follows a rename of a running image. A copy of
// this helper's own exe is started SUSPENDED (so it never runs a single instruction: no behaviour,
// no pipe, no window), its kernel image name is read, the file is renamed within its directory and
// then moved to another directory on the same volume, and the name is read after each; it follows
// only when both moves are followed. The child is held in a job that kills it on close and the temp
// files are deleted. std::nullopt when the probe could not run (copy, launch, rename or move
// failed, or the temp file system is unknown or remote), which the caller treats as fail closed.
// The probe runs on the temp volume, so its result speaks only for that volume's file system.
std::optional<WindowsTargetRenameProbe> WindowsTargetRenameFollows(
    const std::function<bool()> &still_valid = {}) {
  const auto active = [&] { return !still_valid || still_valid(); };
  if (!active()) return std::nullopt;
  std::vector<wchar_t> module(32'768, L'\0');
  const DWORD module_length =
      GetModuleFileNameW(nullptr, module.data(), static_cast<DWORD>(module.size()));
  std::vector<wchar_t> temp(32'768, L'\0');
  const DWORD temp_length = GetTempPathW(static_cast<DWORD>(temp.size()), temp.data());
  if (module_length == 0 || module_length >= module.size() || temp_length == 0 ||
      temp_length >= temp.size())
    return std::nullopt;
  const std::wstring directory(temp.data(), temp_length);
  const std::wstring stem = directory + L"sc-rename-probe-" +
                            std::to_wstring(GetCurrentProcessId()) + L"-" +
                            std::to_wstring(GetTickCount64());
  // A subdirectory on the same volume, for the cross-directory move.
  const std::wstring subdirectory = stem + L"-dir";
  const std::wstring first = stem + L"-a.exe";
  const std::wstring second = stem + L"-b.exe";
  const std::wstring third = subdirectory + L"\\c.exe";
  if (!active() || CopyFileW(std::wstring(module.data(), module_length).c_str(), first.c_str(), TRUE) != TRUE)
    return std::nullopt;
  if (active()) CreateDirectoryW(subdirectory.c_str(), nullptr);
  ScopedKernelHandle job(CreateJobObjectW(nullptr, nullptr));
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  std::optional<WindowsTargetRenameProbe> result;
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION process{};
  std::wstring command = L"\"" + first + L"\"";
  if (active() && job.value != nullptr &&
      SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits,
                              sizeof(limits)) && active() &&
      CreateProcessW(nullptr, command.data(), nullptr, nullptr, FALSE,
                     CREATE_SUSPENDED | CREATE_NO_WINDOW, nullptr, nullptr, &startup,
                     &process)) {
    AssignProcessToJobObject(job.value, process.hProcess);
    // The probe volume and the copied file's identity, read from the copied file itself.
    std::optional<WindowsTargetVolume> probe_volume;
    std::optional<WindowsFileIdentity> probe_id;
    if (active()) {
      ScopedKernelHandle probe_handle(CreateFileW(first.c_str(), FILE_READ_ATTRIBUTES,
                                                  FILE_SHARE_READ | FILE_SHARE_WRITE |
                                                      FILE_SHARE_DELETE,
                                                  nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL,
                                                  nullptr));
      WindowsFileIdentity identity;
      if (probe_handle.value != INVALID_HANDLE_VALUE) {
        probe_volume = WindowsTargetReadVolume(probe_handle.value);
        if (ReadWindowsFileIdentity(probe_handle.value, &identity))
          probe_id = identity;
      }
    }
    // A freshly copied exe can be held briefly by another reader (an anti-virus scan, say), which
    // fails the move with a sharing violation; retry for up to about a second before giving up.
    const auto move = [&](const std::wstring &from, const std::wstring &to) {
      for (int attempt = 0; attempt < 20; ++attempt) {
        if (!active()) return false;
        if (MoveFileExW(from.c_str(), to.c_str(), 0) == TRUE)
          return true;
        const DWORD error = GetLastError();
        if (error != ERROR_SHARING_VIOLATION && error != ERROR_ACCESS_DENIED)
          return false;
        Sleep(50);
      }
      return false;
    };
    // The kernel image name, opened and normalized the same way as the expected location, names the
    // same file (so a TEMP reached through a junction, SUBST or an 8.3 short name still matches).
    const auto names_the_file = [&](const std::wstring &expected) {
      if (!active()) return false;
      std::wstring reported;
      if (!ReadProcessPath(process.hProcess, &reported) || !active()) return false;
      const std::optional<WindowsPathIdentity> from_kernel =
          WindowsTargetOpenPathIdentity(reported);
      if (!active()) return false;
      const std::optional<WindowsPathIdentity> from_expected =
          WindowsTargetOpenPathIdentity(expected);
      return from_kernel.has_value() && from_expected.has_value() && probe_id.has_value() &&
             SameWindowsTargetName(from_kernel->canonical_path, from_expected->canonical_path) &&
             SameWindowsFileIdentity(from_kernel->identity, *probe_id) &&
             SameWindowsFileIdentity(from_expected->identity, *probe_id);
    };
    if (active() && probe_volume.has_value() && probe_id.has_value()) {
      const bool at_first = names_the_file(first);
      const bool at_second = move(first, second) && names_the_file(second);
      const bool at_third = at_second && move(second, third) && names_the_file(third);
      WindowsTargetRenameProbe probe;
      probe.follows = at_first && at_second && at_third;
      probe.volume = *probe_volume;
      if (active()) result = probe;
    }
    // Terminate on every path (success, failure, the lambdas above throwing): the job also kills it
    // on close, so the child cannot outlive this function.
    TerminateProcess(process.hProcess, 0);
    WaitForSingleObject(process.hProcess, 2'000);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
  }
  // Delete after the child is gone so its image section no longer holds the file. A short retry
  // covers the brief window while the kernel finishes tearing the mapping down.
  for (const std::wstring &file : {first, second, third})
    for (int attempt = 0; attempt < 20 && GetFileAttributesW(file.c_str()) != INVALID_FILE_ATTRIBUTES;
         ++attempt)
      if (DeleteFileW(file.c_str()) != TRUE)
        Sleep(50);
  RemoveDirectoryW(subdirectory.c_str());
  return result;
}

// The context of a measurement made by this helper: the roots with Sprint Coder's install root,
// and the lineage root for W8 ("Sprint Coder's own"). The lineage root is the Main process (the
// Electron app that ServeMain's parent check verified), not this helper: Main and all its
// descendants, this helper and the agent's child processes among them, are Sprint Coder's own, and
// the root itself counts, so a development-mode Main image (electron.exe) is W8 too. `main_pid` is
// 0 only when it cannot be opened, which leaves the lineage unmeasured (own_descendant stays
// unset, so the target is unresolvable rather than wrongly not-own).
WindowsTargetFactsContext CurrentWindowsTargetFactsContext(std::uint32_t main_pid,
                                                           std::string self_signer_thumbprint,
                                                           bool acceptance_mode,
                                                           const std::function<bool()> &still_valid = {}) {
  WindowsTargetFactsContext context;
  if (still_valid && !still_valid()) return context;
  context.roots = CurrentWindowsTargetRoots(WindowsTargetSelfInstallRoot());
  if (still_valid && !still_valid()) return WindowsTargetFactsContext{};
  ScopedKernelHandle main(
      OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, main_pid));
  const std::optional<std::uint64_t> creation =
      main.value == nullptr ? std::nullopt : WindowsTargetCreationTime(main.value);
  if (main_pid != 0 && creation.has_value() &&
      GetProcessId(main.value) == main_pid) {
    context.lineage_root_pid = main_pid;
    context.lineage_root_creation = *creation;
  }
  context.self_signer_thumbprint = std::move(self_signer_thumbprint);
  context.acceptance_mode = acceptance_mode;
  if (still_valid && !still_valid()) return WindowsTargetFactsContext{};
  context.rename_probe = WindowsTargetRenameFollows(still_valid);
  return context;
}

// The device-form name of the file mapped at `address` in `process`, or std::nullopt.
std::optional<std::wstring> WindowsTargetMappedFileName(HANDLE process, LPVOID address) {
  std::vector<wchar_t> name(32'768, L'\0');
  const DWORD length = GetMappedFileNameW(process, address, name.data(),
                                          static_cast<DWORD>(name.size()));
  if (length == 0 || length >= name.size())
    return std::nullopt;
  return std::wstring(name.data(), length);
}

// The main image from kernel-held data, not from the target's module list (the PEB Ldr list is
// writable by the target, so its first entry can be made to name another file). The kernel records
// the image's entry point and header summary in SECTION_IMAGE_INFORMATION; the entry point lies in
// the main image's MEM_IMAGE mapping, whose backing file GetMappedFileNameW returns, and the header
// values are later matched against the held file's PE header, since the target can remap another
// file at that address but cannot change what the kernel captured at creation.
struct WindowsTargetKernelImage {
  std::wstring mapped_name;
  // The entry point as a file RVA (TransferAddress - the mapping's allocation base, both from the
  // kernel: TransferAddress from SECTION_IMAGE_INFORMATION and the base from VirtualQueryEx's VAD,
  // not from the PEB), and the header values the kernel captured from the real image at creation.
  // These are an auxiliary deny-side cross-check; the running image's identity is anchored by the
  // post-hold re-read of the kernel image name (see HoldWindowsTargetRunningImage).
  std::uint32_t entry_rva = 0;
  std::uint16_t subsystem = 0;
  std::uint16_t machine = 0;
  std::uint32_t check_sum = 0;
  std::uint32_t image_file_size = 0;
  std::uint16_t image_characteristics = 0;
  std::uint16_t dll_characteristics = 0;
  std::uint64_t stack_reserve = 0;
  std::uint64_t stack_commit = 0;
};

std::optional<WindowsTargetKernelImage> WindowsTargetKernelImageInfo(HANDLE process) {
  using NtQueryInformationProcessFn =
      LONG(WINAPI *)(HANDLE, ULONG, PVOID, ULONG, PULONG);
  static const NtQueryInformationProcessFn query = []() {
    const HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    return ntdll == nullptr
               ? nullptr
               : reinterpret_cast<NtQueryInformationProcessFn>(
                     GetProcAddress(ntdll, "NtQueryInformationProcess"));
  }();
  if (query == nullptr)
    return std::nullopt;
  // SECTION_IMAGE_INFORMATION, whose x64 layout is pinned so the whole structure can be supplied.
  struct SectionImageInformation {
    PVOID transfer_address;
    ULONG zero_bits;
    SIZE_T maximum_stack_size;
    SIZE_T committed_stack_size;
    ULONG sub_system_type;
    ULONG sub_system_version;
    ULONG operating_system_version;
    USHORT image_characteristics;
    USHORT dll_characteristics;
    USHORT machine;
    UCHAR image_contains_code;
    UCHAR image_flags;
    ULONG loader_flags;
    ULONG image_file_size;
    ULONG check_sum;
  };
  static_assert(sizeof(SectionImageInformation) == 64,
                "SECTION_IMAGE_INFORMATION must match the kernel's x64 layout");
  constexpr ULONG kProcessImageInformation = 37;
  SectionImageInformation image{};
  ULONG returned = 0;
  if (query(process, kProcessImageInformation, &image, sizeof(image), &returned) < 0 ||
      image.transfer_address == nullptr)
    return std::nullopt;
  // The entry point must sit in a MEM_IMAGE region; its allocation base names the mapping.
  MEMORY_BASIC_INFORMATION region{};
  if (VirtualQueryEx(process, image.transfer_address, &region, sizeof(region)) !=
          sizeof(region) ||
      region.Type != MEM_IMAGE || region.AllocationBase == nullptr ||
      image.transfer_address < region.AllocationBase)
    return std::nullopt;
  const std::optional<std::wstring> mapped =
      WindowsTargetMappedFileName(process, region.AllocationBase);
  if (!mapped.has_value())
    return std::nullopt;
  WindowsTargetKernelImage info;
  info.mapped_name = *mapped;
  info.entry_rva = static_cast<std::uint32_t>(
      reinterpret_cast<std::uintptr_t>(image.transfer_address) -
      reinterpret_cast<std::uintptr_t>(region.AllocationBase));
  info.subsystem = static_cast<std::uint16_t>(image.sub_system_type);
  info.machine = image.machine;
  info.check_sum = image.check_sum;
  info.image_file_size = image.image_file_size;
  info.image_characteristics = image.image_characteristics;
  info.dll_characteristics = image.dll_characteristics;
  info.stack_reserve = static_cast<std::uint64_t>(image.maximum_stack_size);
  info.stack_commit = static_cast<std::uint64_t>(image.committed_stack_size);
  return info;
}

std::optional<std::wstring> WindowsTargetKernelImageName(HANDLE process) {
  const std::optional<WindowsTargetKernelImage> info = WindowsTargetKernelImageInfo(process);
  return info.has_value() ? std::optional<std::wstring>(info->mapped_name) : std::nullopt;
}

// An auxiliary deny-side check: whether a held file's PE header disagrees with what the kernel
// recorded for the process at creation. A field is compared only when both sides carry it, so a
// field the header does not cover never refuses on its own; a field that is present and differs
// does. This is not the anchor (the kernel can be fooled on checksum, which Authenticode does not
// cover, and an attacker who builds the original can match the rest); the anchor is the post-hold
// name re-read. False means a disagreement was found.
bool WindowsHeldImageDisagreesWithKernel(HANDLE file, const WindowsTargetKernelImage &kernel) {
  std::vector<std::uint8_t> header(64 * 1024);
  OVERLAPPED at{};
  DWORD read = 0;
  if (ReadFile(file, header.data(), static_cast<DWORD>(header.size()), &read, &at) != TRUE)
    return true;
  header.resize(read);
  const std::optional<sprint_coder::computer_use::PeImageSummary> summary =
      sprint_coder::computer_use::ParsePeImageSummary(header);
  if (!summary.has_value() || summary->subsystem_code != kernel.subsystem)
    return true;
  // No field is skipped for an IL-only (.NET) image (S5-c-3 PR-5, measured on Windows 11 26200). PR-2
  // skipped the fields of a PE32 AnyCPU image on the expectation that the loader's PE32 -> PE32+
  // conversion shows in SECTION_IMAGE_INFORMATION. It does not: for a PE32 AnyCPU image (AddInUtil,
  // EdmGen, dfsvc, and a csc /platform:anycpu build), a 32BITPREFERRED one and a PE32+ IL-only one
  // (Framework64 InstallUtil, csc /platform:x64), suspended and running, every header value the kernel
  // records equals the file's (machine 0x14c stays 0x14c), and its TransferAddress is the image's
  // preferred ImageBase + AddressOfEntryPoint, which lies in no MEM_IMAGE region of the process, so
  // WindowsTargetKernelImageInfo already answers nothing and the image is unresolvable (W-UR) before
  // this check is reached. Keeping the skip would only relax the check for an image whose kernel
  // record differs from its header, which no measured image does.
  if (summary->entry_rva != kernel.entry_rva || summary->machine != kernel.machine ||
      summary->check_sum != kernel.check_sum)
    return true;
  if (summary->image_characteristics.has_value() &&
      *summary->image_characteristics != kernel.image_characteristics)
    return true;
  if (summary->dll_characteristics.has_value() &&
      *summary->dll_characteristics != kernel.dll_characteristics)
    return true;
  if (summary->stack_reserve.has_value() && *summary->stack_reserve != kernel.stack_reserve)
    return true;
  if (summary->stack_commit.has_value() && *summary->stack_commit != kernel.stack_commit)
    return true;
  // ImageFileSize is the size of the image file; compare it with the held file's actual size.
  LARGE_INTEGER size{};
  if (kernel.image_file_size != 0 && GetFileSizeEx(file, &size) == TRUE &&
      static_cast<std::uint64_t>(size.QuadPart) != kernel.image_file_size)
    return true;
  return false;
}

// The first module of the target's own list (PEB Ldr). Used only as a deny-side cross-check: it is
// writable by the target, so it can only add a reason to refuse, never remove one.
std::optional<std::wstring> WindowsTargetModuleListImageName(HANDLE process) {
  HMODULE image = nullptr;
  DWORD needed = 0;
  if (EnumProcessModulesEx(process, &image, sizeof(image), &needed,
                           LIST_MODULES_DEFAULT) != TRUE ||
      image == nullptr)
    return std::nullopt;
  return WindowsTargetMappedFileName(process, image);
}

struct WindowsTargetHeldImage {
  ScopedKernelHandle file;
  std::wstring canonical_path;
  WindowsFileIdentity identity;
  bool matches = false;
  // Whether the held file was neither written nor had its metadata changed since the process was
  // created (WindowsImageUnchangedSinceCreation); part of `matches`, kept apart for the seam.
  bool unchanged = false;
  // The held file's volume (file system name and flags), for the caller to compare with the rename
  // probe's; std::nullopt when the volume is remote or could not be read.
  std::optional<WindowsTargetVolume> volume;
  // Whether the held file is on a remote volume (std::nullopt: unknown).
  std::optional<bool> remote;
};

// Whether the running image may be said to match: the hold matched, the held file is known not to
// be remote, and the one-time rename probe followed on a volume whose file system name and flags
// are the same as the held file's. Pure, so the seam can drive each input (a remote or unknown
// volume, a probe on another file system or with different flags, a probe that did not follow)
// without a real SMB share. Anything missing is false.
bool WindowsTargetRunningImageMatches(bool held_matches, std::optional<bool> remote,
                                      const std::optional<WindowsTargetVolume> &volume,
                                      const std::optional<WindowsTargetRenameProbe> &probe) {
  return held_matches && remote == std::optional<bool>(false) && probe.has_value() &&
         probe->follows && volume.has_value() &&
         volume->file_system == probe->volume.file_system && volume->flags == probe->volume.flags;
}

// Holds the running image (see the block comment). The main image is found from kernel-held data
// (WindowsTargetKernelImageInfo), never from the target's module list. `recorded` is the process's
// path as read before (QueryFullProcessImageNameW), or std::nullopt when it could not be read.
// False when the kernel data is unreadable or its file cannot be held.
//
// `matches` is anchored by re-reading the kernel image name (QueryFullProcessImageNameW) after the
// file is held, and requiring that name to open the same file (canonical path and file id) as the
// held one. QueryFullProcessImageNameW names the kernel's image file object, which follows a
// rename of the running image, so a target that unmaps its image and maps another file B at the
// entry point's address (then rewrites its Ldr list) is caught: the re-read still names the real
// image, not B. If that name cannot be read or opened, the result is unresolvable. The held file's
// PE header against the kernel summary, the recorded path still naming the held file, the kernel
// mapped name staying put, and the module list are auxiliary deny-side checks on top.
// Whether the held file is on a volume whose 128-bit file id is stable (NTFS or ReFS). On FAT and
// similar the id is not dependable, so file-id matching cannot be trusted and the target is
// unresolvable. Network and removable volumes are already W-UR by imageVolume.
bool WindowsTargetStableIdVolume(HANDLE file) {
  const std::optional<WindowsTargetVolume> volume = WindowsTargetReadVolume(file);
  return volume.has_value() && WindowsTargetFileSystemHasStableId(volume->file_system);
}

// Whether the process's running image is known to be local, from the kernel's name of it
// (PROCESS_NAME_NATIVE), before the file is opened (S5-c-3 PR-5): an image on a network redirector,
// or one whose name cannot be read, is never opened or read, since an unresponsive share would hold
// the helper's one request lane. Such a target stays unmeasured (unresolvable).
bool WindowsTargetImageKnownLocal(HANDLE process) {
  std::vector<wchar_t> name(32'768, L'\0');
  DWORD length = static_cast<DWORD>(name.size());
  if (QueryFullProcessImageNameW(process, PROCESS_NAME_NATIVE, name.data(), &length) != TRUE ||
      length == 0 || length >= name.size())
    return false;
  const std::optional<std::string> native =
      WindowsTargetUtf8(std::wstring_view(name.data(), length));
  return native.has_value() && !sprint_coder::computer_use::WindowsNativeImageIsRemote(*native);
}

bool HoldWindowsTargetRunningImage(HANDLE process,
                                   const std::optional<std::wstring> &recorded,
                                   WindowsTargetHeldImage *held) {
  const std::optional<WindowsTargetKernelImage> kernel = WindowsTargetKernelImageInfo(process);
  if (!kernel.has_value())
    return false;
  const std::wstring global = L"\\\\?\\GLOBALROOT" + kernel->mapped_name;
  held->file.value =
      CreateFileW(global.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
                  OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (held->file.value == INVALID_HANDLE_VALUE) {
    held->file.value = nullptr;
    return false;
  }
  FILE_ATTRIBUTE_TAG_INFO tag{};
  if (!GetFileInformationByHandleEx(held->file.value, FileAttributeTagInfo, &tag,
                                    sizeof(tag)) ||
      (tag.FileAttributes &
       (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0 ||
      !ReadWindowsFileIdentity(held->file.value, &held->identity) ||
      !CanonicalWindowsPathFromHandle(held->file.value, &held->canonical_path))
    return false;
  // Anchor: after holding, the kernel image name (it follows a rename of the running image, unlike
  // a view the target remapped) must open the same file as the one held. The name is read once
  // before the open and once after, and both must agree, so a rename that races the open (to put a
  // hard link to another file at the old name) is caught. The held file must have a single name
  // and sit on a volume with a stable 128-bit file id. Anything unreadable -> W-UR.
  std::wstring kernel_path_before;
  std::wstring kernel_path_after;
  const std::optional<WindowsPathIdentity> kernel_file =
      ReadProcessPath(process, &kernel_path_before)
          ? WindowsTargetOpenPathIdentity(kernel_path_before)
          : std::nullopt;
  const bool anchored =
      kernel_file.has_value() && ReadProcessPath(process, &kernel_path_after) &&
      SameWindowsTargetName(kernel_path_before, kernel_path_after) &&
      SameWindowsTargetName(kernel_file->canonical_path, held->canonical_path) &&
      SameWindowsFileIdentity(kernel_file->identity, held->identity) &&
      WindowsTargetStableIdVolume(held->file.value);
  held->volume = WindowsTargetReadVolume(held->file.value);
  held->remote = WindowsTargetFileIsRemote(held->file.value);
  // Auxiliary deny-side checks.
  const bool header_disagrees = WindowsHeldImageDisagreesWithKernel(held->file.value, *kernel);
  const std::optional<WindowsTargetKernelImage> again = WindowsTargetKernelImageInfo(process);
  bool recorded_agrees = recorded.has_value();
  if (recorded_agrees) {
    const std::optional<WindowsPathIdentity> recorded_file =
        WindowsTargetOpenPathIdentity(*recorded);
    recorded_agrees = recorded_file.has_value() &&
                      SameWindowsFileIdentity(recorded_file->identity, held->identity);
  }
  const std::optional<std::wstring> module_list = WindowsTargetModuleListImageName(process);
  const bool module_list_agrees =
      module_list.has_value() && SameWindowsTargetName(*module_list, kernel->mapped_name);
  // The held file's bytes are the ones mapped only if nothing rewrote it after the process was
  // created (process herpaderping: a writer that kept its handle across the section's creation
  // overwrites the file, and the signature and resources would then be read from the new bytes).
  // The hold shares no write, so nothing can write while it is held; what was written before is
  // told by the file's ChangeTime, which must be before the creation time (LastWriteTime is not
  // judged; see WindowsImageUnchangedSinceCreation). A rename also moves ChangeTime, so a running
  // image renamed since its start is a mismatch too. FILE_BASIC_INFO unreadable: a mismatch.
  FILE_BASIC_INFO basic{};
  const bool basic_read = GetFileInformationByHandleEx(held->file.value, FileBasicInfo, &basic,
                                                       sizeof(basic)) == TRUE;
  held->unchanged = sprint_coder::computer_use::WindowsImageUnchangedSinceCreation(
      basic_read ? std::optional<sprint_coder::computer_use::WindowsImageFileTimes>(
                       {basic.ChangeTime.QuadPart, basic.LastWriteTime.QuadPart})
                 : std::nullopt,
      WindowsTargetCreationTime(process));
  held->matches = anchored && !header_disagrees && again.has_value() &&
                  SameWindowsTargetName(again->mapped_name, kernel->mapped_name) &&
                  recorded_agrees && module_list_agrees && held->unchanged;
  return true;
}

std::optional<std::string> WindowsTargetVolumeKind(HANDLE file) {
  FILE_REMOTE_PROTOCOL_INFO remote{};
  if (GetFileInformationByHandleEx(file, FileRemoteProtocolInfo, &remote,
                                   sizeof(remote)))
    return "network";
  constexpr DWORD flags = FILE_NAME_NORMALIZED | VOLUME_NAME_GUID;
  std::vector<wchar_t> buffer(32'768, L'\0');
  const DWORD length = GetFinalPathNameByHandleW(
      file, buffer.data(), static_cast<DWORD>(buffer.size()), flags);
  if (length == 0 || length >= buffer.size())
    return std::nullopt;
  const std::wstring path(buffer.data(), length);
  static constexpr std::wstring_view volume_prefix = L"\\\\?\\Volume{";
  const std::size_t end = path.find(L'\\', volume_prefix.size());
  if (!path.starts_with(volume_prefix) || end == std::wstring::npos)
    return std::nullopt;
  const std::wstring root = path.substr(0, end + 1);
  switch (GetDriveTypeW(root.c_str())) {
  case DRIVE_REMOTE:
    return "network";
  case DRIVE_REMOVABLE:
  case DRIVE_CDROM:
  case DRIVE_RAMDISK:
    return "removable";
  case DRIVE_FIXED:
    break;
  default:
    return std::nullopt;
  }
  ScopedKernelHandle volume(CreateFileW(
      path.substr(0, end).c_str(), 0, FILE_SHARE_READ | FILE_SHARE_WRITE,
      nullptr, OPEN_EXISTING, 0, nullptr));
  if (volume.value == INVALID_HANDLE_VALUE)
    return std::nullopt;
  STORAGE_PROPERTY_QUERY query{};
  query.PropertyId = StorageDeviceProperty;
  query.QueryType = PropertyStandardQuery;
  std::array<std::uint8_t, 1024> descriptor{};
  DWORD returned = 0;
  if (!DeviceIoControl(volume.value, IOCTL_STORAGE_QUERY_PROPERTY, &query,
                       sizeof(query), descriptor.data(),
                       static_cast<DWORD>(descriptor.size()), &returned,
                       nullptr) ||
      returned < sizeof(STORAGE_DEVICE_DESCRIPTOR))
    return std::nullopt;
  STORAGE_DEVICE_DESCRIPTOR device{};
  std::memcpy(&device, descriptor.data(), sizeof(device));
  switch (device.BusType) {
  case BusTypeUsb:
  case BusType1394:
  case BusTypeSd:
  case BusTypeMmc:
  case BusTypeFileBackedVirtual:
    return "removable";
  case BusTypeiScsi:
    return "network";
  default:
    return "fixed";
  }
}

// The verified signer of the state WinVerifyTrust left open.
bool ReadWindowsTargetSigner(HANDLE state, WindowsTargetSignature *signature) {
  CRYPT_PROVIDER_DATA *provider = WTHelperProvDataFromStateData(state);
  CRYPT_PROVIDER_SGNR *signer =
      provider == nullptr ? nullptr
                          : WTHelperGetProvSignerFromChain(provider, 0, FALSE, 0);
  CRYPT_PROVIDER_CERT *leaf =
      signer == nullptr ? nullptr : WTHelperGetProvCertFromChain(signer, 0);
  if (leaf == nullptr || leaf->pCert == nullptr ||
      signer->pChainContext == nullptr)
    return false;
  std::array<std::uint8_t, 32> thumbprint{};
  DWORD thumbprint_bytes = static_cast<DWORD>(thumbprint.size());
  if (CertGetCertificateContextProperty(leaf->pCert, CERT_SHA256_HASH_PROP_ID,
                                        thumbprint.data(),
                                        &thumbprint_bytes) != TRUE ||
      thumbprint_bytes != thumbprint.size())
    return false;
  static constexpr char hexadecimal[] = "0123456789abcdef";
  signature->thumbprint.clear();
  for (const std::uint8_t byte : thumbprint) {
    signature->thumbprint += hexadecimal[byte >> 4];
    signature->thumbprint += hexadecimal[byte & 0xf];
  }
  void *organization_oid = const_cast<char *>(szOID_ORGANIZATION_NAME);
  const DWORD characters = CertGetNameStringW(
      leaf->pCert, CERT_NAME_ATTR_TYPE, 0, organization_oid, nullptr, 0);
  if (characters == 1) {
    signature->organization = std::string{};
  } else if (characters > 1 && characters <= 1'024) {
    std::wstring organization(characters, L'\0');
    if (CertGetNameStringW(leaf->pCert, CERT_NAME_ATTR_TYPE, 0,
                           organization_oid, organization.data(),
                           characters) == characters) {
      organization.resize(characters - 1);
      signature->organization = WindowsTargetUtf8(organization);
    }
  }
  // A Microsoft product root (the policy without flags), or the application root (Microsoft Root
  // Certificate Authority 2011), which that flag checks instead of the product roots.
  for (const DWORD flags :
       {DWORD{0}, DWORD{MICROSOFT_ROOT_CERT_CHAIN_POLICY_CHECK_APPLICATION_ROOT_FLAG}}) {
    CERT_CHAIN_POLICY_PARA policy{};
    policy.cbSize = sizeof(policy);
    policy.dwFlags = flags;
    CERT_CHAIN_POLICY_STATUS status{};
    status.cbSize = sizeof(status);
    if (CertVerifyCertificateChainPolicy(CERT_CHAIN_POLICY_MICROSOFT_ROOT,
                                         signer->pChainContext, &policy,
                                         &status) != TRUE) {
      signature->microsoft_root.reset();
      break;
    }
    signature->microsoft_root = status.dwError == ERROR_SUCCESS;
    if (*signature->microsoft_root)
      break;
  }
  return true;
}

// Runs WinVerifyTrust (decision K: no revocation, no network) and reads the signer on success.
// The verdict, or std::nullopt when it verified but its signer could not be read.
std::optional<LONG> VerifyWindowsTargetTrust(WINTRUST_DATA *trust,
                                             WindowsTargetSignature *signature,
                                             DWORD *last_error = nullptr) {
  trust->cbStruct = sizeof(*trust);
  trust->dwUIChoice = WTD_UI_NONE;
  trust->fdwRevocationChecks = WTD_REVOKE_NONE;
  trust->dwProvFlags = WTD_CACHE_ONLY_URL_RETRIEVAL | WTD_REVOCATION_CHECK_NONE |
                       WTD_DISABLE_MD2_MD4;
  trust->dwStateAction = WTD_STATEACTION_VERIFY;
  GUID policy = WINTRUST_ACTION_GENERIC_VERIFY_V2;
  const LONG verified = WinVerifyTrust(nullptr, &policy, trust);
  // GetLastError() right after WinVerifyTrust tells apart a truly absent signature from a present
  // but malformed one (both can return TRUST_E_NOSIGNATURE); the close below overwrites it.
  if (last_error != nullptr)
    *last_error = GetLastError();
  const bool read = verified == ERROR_SUCCESS &&
                    ReadWindowsTargetSigner(trust->hWVTStateData, signature);
  trust->dwStateAction = WTD_STATEACTION_CLOSE;
  WinVerifyTrust(nullptr, &policy, trust);
  if (verified == ERROR_SUCCESS && !read)
    return std::nullopt;
  return verified;
}

bool RewindWindowsTargetFile(HANDLE file) {
  LARGE_INTEGER beginning{};
  return SetFilePointerEx(file, beginning, nullptr, FILE_BEGIN) == TRUE;
}

// A catalog that carries the file's hash (SHA-256, then SHA-1 for older catalogs). The state is
// "unsigned" when no catalog carries it, and std::nullopt when the catalogs cannot be asked.
WindowsTargetSignature VerifyWindowsTargetCatalog(HANDLE file,
                                                  const std::wstring &path) {
  WindowsTargetSignature signature;
  for (const wchar_t *algorithm : {BCRYPT_SHA256_ALGORITHM, BCRYPT_SHA1_ALGORITHM}) {
    HCATADMIN admin = nullptr;
    if (!CryptCATAdminAcquireContext2(&admin, nullptr, algorithm, nullptr, 0) ||
        admin == nullptr)
      return signature;
    DWORD hash_bytes = 0;
    std::vector<std::uint8_t> hash;
    bool hashed = RewindWindowsTargetFile(file);
    if (hashed) {
      CryptCATAdminCalcHashFromFileHandle2(admin, file, &hash_bytes, nullptr, 0);
      hash.resize(hash_bytes);
      hashed = hash_bytes > 0 && hash_bytes <= 64 && RewindWindowsTargetFile(file) &&
               CryptCATAdminCalcHashFromFileHandle2(admin, file, &hash_bytes,
                                                    hash.data(), 0) == TRUE;
    }
    if (!hashed) {
      CryptCATAdminReleaseContext(admin, 0);
      return signature;
    }
    HCATINFO catalog = CryptCATAdminEnumCatalogFromHash(
        admin, hash.data(), hash_bytes, 0, nullptr);
    if (catalog == nullptr) {
      // Only ERROR_NOT_FOUND means "no catalog carries this hash"; any other reason (the catalog
      // store locked, CryptSvc stopped, out of memory) is unresolvable, not "unsigned", so a
      // catalog-signed Microsoft binary is not let through to the upper class by a transient error.
      const DWORD error = GetLastError();
      CryptCATAdminReleaseContext(admin, 0);
      if (error == ERROR_NOT_FOUND)
        continue;
      return signature;
    }
    CATALOG_INFO information{};
    information.cbStruct = sizeof(information);
    std::wstring tag;
    static constexpr wchar_t hexadecimal[] = L"0123456789ABCDEF";
    for (const std::uint8_t byte : hash) {
      tag += hexadecimal[byte >> 4];
      tag += hexadecimal[byte & 0xf];
    }
    std::optional<LONG> verified;
    if (CryptCATCatalogInfoFromContext(catalog, &information, 0) == TRUE &&
        RewindWindowsTargetFile(file)) {
      WINTRUST_CATALOG_INFO member{};
      member.cbStruct = sizeof(member);
      member.pcwszCatalogFilePath = information.wszCatalogFile;
      member.pcwszMemberTag = tag.c_str();
      member.pcwszMemberFilePath = path.c_str();
      member.hMemberFile = file;
      member.pbCalculatedFileHash = hash.data();
      member.cbCalculatedFileHash = hash_bytes;
      member.hCatAdmin = admin;
      WINTRUST_DATA trust{};
      trust.dwUnionChoice = WTD_CHOICE_CATALOG;
      trust.pCatalog = &member;
      verified = VerifyWindowsTargetTrust(&trust, &signature);
    }
    CryptCATAdminReleaseCatalogContext(admin, catalog, 0);
    CryptCATAdminReleaseContext(admin, 0);
    if (!verified.has_value())
      return signature;
    signature.source = WindowsTargetSignatureSource::kCatalog;
    signature.state = *verified == ERROR_SUCCESS ? "valid" : "invalid";
    return signature;
  }
  signature.state = "unsigned";
  return signature;
}

// Whether the held file has an embedded certificate table (the security data directory), or
// std::nullopt when its header cannot be read or does not say (unknown, never "none").
std::optional<bool> WindowsTargetHasCertTable(HANDLE file) {
  std::vector<std::uint8_t> header(64 * 1024);
  OVERLAPPED at{};
  DWORD read = 0;
  if (ReadFile(file, header.data(), static_cast<DWORD>(header.size()), &read, &at) != TRUE)
    return std::nullopt;
  header.resize(read);
  const std::optional<sprint_coder::computer_use::PeImageSummary> summary =
      sprint_coder::computer_use::ParsePeImageSummary(header);
  return summary.has_value() ? summary->has_cert_table : std::nullopt;
}

// The embedded signature, or the catalog when the file carries none. A present embedded signature
// that does not verify is invalid; the catalog is not asked to stand in for it. "Carries none" is
// decided as the Microsoft sample does: WinVerifyTrust returns TRUST_E_NOSIGNATURE and GetLastError
// is one of NOSIGNATURE / SUBJECT_FORM_UNKNOWN / PROVIDER_UNKNOWN, and the PE has no certificate
// table. A NOSIGNATURE verdict with any other last error, or with a certificate table present (a
// malformed or truncated embedded signature), is invalid, not a reason to try the catalog.
WindowsTargetSignature VerifyWindowsTargetSignature(HANDLE file,
                                                    const std::wstring &path) {
  WindowsTargetSignature signature;
  if (!RewindWindowsTargetFile(file))
    return signature;
  WINTRUST_FILE_INFO file_info{};
  file_info.cbStruct = sizeof(file_info);
  file_info.pcwszFilePath = path.c_str();
  file_info.hFile = file;
  WINTRUST_DATA trust{};
  trust.dwUnionChoice = WTD_CHOICE_FILE;
  trust.pFile = &file_info;
  DWORD last_error = 0;
  const std::optional<LONG> verified = VerifyWindowsTargetTrust(&trust, &signature, &last_error);
  if (!verified.has_value())
    return signature;
  if (*verified == ERROR_SUCCESS) {
    signature.source = WindowsTargetSignatureSource::kEmbedded;
    signature.state = "valid";
    return signature;
  }
  const bool no_signature =
      *verified == TRUST_E_NOSIGNATURE &&
      (last_error == static_cast<DWORD>(TRUST_E_NOSIGNATURE) ||
       last_error == static_cast<DWORD>(TRUST_E_SUBJECT_FORM_UNKNOWN) ||
       last_error == static_cast<DWORD>(TRUST_E_PROVIDER_UNKNOWN)) &&
      // Only a header that says "no certificate table" lets the catalog be asked; an unknown one
      // is invalid (fail closed).
      WindowsTargetHasCertTable(file) == std::optional<bool>(false);
  if (no_signature)
    return VerifyWindowsTargetCatalog(file, path);
  signature.source = WindowsTargetSignatureSource::kEmbedded;
  signature.state = "invalid";
  return signature;
}

std::optional<std::string> WindowsTargetPeSubsystem(HANDLE file) {
  std::vector<std::uint8_t> header(64 * 1024);
  OVERLAPPED at{};
  DWORD read = 0;
  if (ReadFile(file, header.data(), static_cast<DWORD>(header.size()), &read,
               &at) != TRUE)
    return std::nullopt;
  header.resize(read);
  return sprint_coder::computer_use::ParsePeSubsystem(header);
}

// The resource section of the held file, copied out of an image view of the held handle itself.
// The file is never opened again by its path: a path loses what the handle names (a Win32 path
// drops a trailing dot or space, so "app.exe." and "app.exe" name two files, and a path longer than
// MAX_PATH would not open), while the held handle cannot be written, renamed or deleted under it.
// The view is an image section (SEC_IMAGE_NO_EXECUTE, which needs only the GENERIC_READ the hold
// has, and maps nothing executable), so the kernel lays the file out as the loader does and refuses
// what it would not load. The view's base is not handed to FindResourceW: a base whose low bits are
// clear reads to the loader as a module it mapped, and its lookup may go to a language's .mui file
// (another, unverified file); the resources are found by FindPeResources instead. A section page
// that is not committed and readable (a section without IMAGE_SCN_MEM_READ maps no-access) is not
// read, and every read of the view (the header and the section) is a copy into a local buffer made
// by CopyWindowsTargetView under SEH, so neither a crafted image nor a page-in that fails (an SMB
// share dropped, a USB volume pulled, a bad sector: EXCEPTION_IN_PAGE_ERROR) can fault this helper;
// either makes the read unresolvable. Only the copies are parsed. `present` false: the image has
// no resources. std::nullopt: the image cannot be mapped or read (the facts read from it are then
// unmeasured).
struct WindowsTargetResourceSection {
  sprint_coder::computer_use::PeResourceSection where;
  std::vector<std::uint8_t> bytes;
};

// Copies `length` bytes of a mapped view. A fault while doing so (EXCEPTION_IN_PAGE_ERROR when the
// page cannot be read in, EXCEPTION_ACCESS_VIOLATION when it is not accessible) is caught and is
// false; any other exception passes on. No C++ object lives here (SEH cannot unwind one, C2712).
bool CopyWindowsTargetView(void *destination, const void *source, std::size_t length) {
  __try {
    std::memcpy(destination, source, length);
  } __except (GetExceptionCode() == EXCEPTION_IN_PAGE_ERROR ||
                      GetExceptionCode() == EXCEPTION_ACCESS_VIOLATION
                  ? EXCEPTION_EXECUTE_HANDLER
                  : EXCEPTION_CONTINUE_SEARCH) {
    return false;
  }
  return true;
}

std::optional<WindowsTargetResourceSection> ReadWindowsTargetResourceSection(HANDLE file) {
  ScopedKernelHandle mapping(CreateFileMappingW(
      file, nullptr, PAGE_READONLY | SEC_IMAGE_NO_EXECUTE, 0, 0, nullptr));
  if (mapping.value == nullptr)
    return std::nullopt;
  const auto *view = static_cast<const std::uint8_t *>(
      MapViewOfFile(mapping.value, FILE_MAP_READ, 0, 0, 0));
  if (view == nullptr)
    return std::nullopt;
  struct Unmap {
    const void *view;
    ~Unmap() { UnmapViewOfFile(view); }
  } unmap{view};
  // Whether [offset, offset + length) of the view is committed and readable, page region by region.
  const auto readable = [view](std::size_t offset, std::size_t length) {
    std::size_t at = offset;
    while (at < offset + length) {
      MEMORY_BASIC_INFORMATION region{};
      if (VirtualQuery(view + at, &region, sizeof(region)) != sizeof(region) ||
          region.AllocationBase != view || region.State != MEM_COMMIT ||
          (region.Protect & (PAGE_GUARD | PAGE_NOACCESS)) != 0 ||
          (region.Protect & (PAGE_READONLY | PAGE_READWRITE | PAGE_WRITECOPY)) == 0)
        return false;
      const std::size_t region_end = static_cast<std::size_t>(
          static_cast<const std::uint8_t *>(region.BaseAddress) + region.RegionSize - view);
      if (region_end <= at)
        return false;
      at = region_end;
    }
    return true;
  };
  // The header page (the first region of the view), up to 64 KiB of it.
  MEMORY_BASIC_INFORMATION first{};
  if (VirtualQuery(view, &first, sizeof(first)) != sizeof(first))
    return std::nullopt;
  const std::size_t header_size =
      first.RegionSize < 64 * 1024 ? static_cast<std::size_t>(first.RegionSize) : 64 * 1024;
  std::vector<std::uint8_t> header(header_size);
  if (!readable(0, header_size) || !CopyWindowsTargetView(header.data(), view, header_size))
    return std::nullopt;
  WindowsTargetResourceSection result;
  const std::optional<sprint_coder::computer_use::PeResourceSection> where =
      sprint_coder::computer_use::LocatePeResourceSection(header);
  if (!where.has_value())
    return std::nullopt;
  result.where = *where;
  if (!where->present)
    return result;
  result.bytes.resize(where->section_size);
  if (!readable(where->section_rva, where->section_size) ||
      !CopyWindowsTargetView(result.bytes.data(), view + where->section_rva, where->section_size))
    return std::nullopt;
  return result;
}

// One resource (id 1 of `type`) of a resource section, or std::nullopt when it cannot be read.
// Absent: an empty list.
std::optional<std::vector<std::span<const std::uint8_t>>>
WindowsTargetResources(const WindowsTargetResourceSection &section, std::uint16_t type) {
  if (!section.where.present)
    return std::vector<std::span<const std::uint8_t>>{};
  return sprint_coder::computer_use::FindPeResources(section.bytes, section.where.section_rva,
                                                     section.where.directory_rva, type, 1);
}

// OriginalFilename of version resource 1: "" when there is none, std::nullopt when it cannot be
// read or when its languages disagree (a name the loader might pick is then not one this can say).
std::optional<std::string> WindowsTargetSectionOriginalFilename(
    const WindowsTargetResourceSection &section) {
  const std::optional<std::vector<std::span<const std::uint8_t>>> versions =
      WindowsTargetResources(section, 16 /* RT_VERSION */);
  if (!versions.has_value())
    return std::nullopt;
  std::optional<std::string> original = std::string{};
  for (std::size_t index = 0; index < versions->size(); ++index) {
    const std::optional<std::string> read =
        sprint_coder::computer_use::VersionInfoOriginalFilename((*versions)[index]);
    if (!read.has_value() || (index > 0 && read != original))
      return std::nullopt;
    original = read;
  }
  return original;
}

// The manifest's execution level and, when the signature verified, OriginalFilename, read from the
// held file through its handle (ReadWindowsTargetResourceSection). The manifest asks for elevation
// when any of its languages does (the deny direction); without one the process runs as the invoker.
void ReadWindowsTargetResources(HANDLE file, bool signature_verified,
                                sprint_coder::computer_use::TargetFacts *facts) {
  if (!signature_verified)
    facts->original_filename = std::string{};
  const std::optional<WindowsTargetResourceSection> section =
      ReadWindowsTargetResourceSection(file);
  if (!section.has_value())
    return;
  const std::optional<std::vector<std::span<const std::uint8_t>>> manifests =
      WindowsTargetResources(*section, 24 /* RT_MANIFEST */);
  if (manifests.has_value()) {
    std::optional<bool> elevated = false;
    for (const std::span<const std::uint8_t> manifest : *manifests) {
      const std::optional<bool> level = sprint_coder::computer_use::ManifestRequiresAdministrator(
          std::string_view(reinterpret_cast<const char *>(manifest.data()), manifest.size()));
      if (!level.has_value()) {
        elevated.reset();
        break;
      }
      elevated = *elevated || *level;
    }
    facts->requires_administrator = elevated;
  }
  if (signature_verified)
    facts->original_filename = WindowsTargetSectionOriginalFilename(*section);
}

// OriginalFilename of an image held by the caller, whatever its signature ("" without one), for
// the deny direction only, read through the held handle. std::nullopt when it cannot be read.
std::optional<std::string> WindowsTargetOriginalFilename(HANDLE file) {
  const std::optional<WindowsTargetResourceSection> section =
      ReadWindowsTargetResourceSection(file);
  if (!section.has_value())
    return std::nullopt;
  return WindowsTargetSectionOriginalFilename(*section);
}

std::optional<std::vector<std::uint8_t>> WindowsTargetTokenInformation(
    HANDLE token, TOKEN_INFORMATION_CLASS information_class) {
  DWORD bytes = 0;
  GetTokenInformation(token, information_class, nullptr, 0, &bytes);
  if (bytes == 0 || bytes > 64 * 1024)
    return std::nullopt;
  std::vector<std::uint8_t> buffer(bytes);
  if (GetTokenInformation(token, information_class, buffer.data(), bytes,
                          &bytes) != TRUE)
    return std::nullopt;
  return buffer;
}

std::optional<DWORD> WindowsTargetTokenDword(HANDLE token,
                                             TOKEN_INFORMATION_CLASS information_class) {
  DWORD value = 0;
  DWORD bytes = 0;
  if (GetTokenInformation(token, information_class, &value, sizeof(value),
                          &bytes) != TRUE ||
      bytes != sizeof(value))
    return std::nullopt;
  return value;
}

std::optional<DWORD> WindowsTargetIntegrityRid(HANDLE token) {
  const std::optional<std::vector<std::uint8_t>> label =
      WindowsTargetTokenInformation(token, TokenIntegrityLevel);
  if (!label.has_value() || label->size() < sizeof(TOKEN_MANDATORY_LABEL))
    return std::nullopt;
  const auto *mandatory =
      reinterpret_cast<const TOKEN_MANDATORY_LABEL *>(label->data());
  PSID sid = mandatory->Label.Sid;
  if (sid == nullptr || !IsValidSid(sid) || *GetSidSubAuthorityCount(sid) == 0)
    return std::nullopt;
  return *GetSidSubAuthority(sid, *GetSidSubAuthorityCount(sid) - 1u);
}

// The 7 token items. Anything unreadable is the refusing value.
void MeasureWindowsTargetToken(HANDLE process,
                               sprint_coder::computer_use::TargetFacts *facts) {
  facts->token_elevated = true;
  facts->token_other_user = true;
  facts->token_other_session = true;
  facts->token_protected = true;
  facts->token_ui_access = true;
  facts->token_integrity_above_self = true;
  facts->token_app_container = true;
  PROCESS_PROTECTION_LEVEL_INFORMATION protection{};
  if (GetProcessInformation(process, ProcessProtectionLevelInfo, &protection,
                            sizeof(protection)) == TRUE)
    facts->token_protected = protection.ProtectionLevel != PROTECTION_LEVEL_NONE;
  HANDLE own = GetCurrentProcessToken();
  ScopedKernelHandle token;
  if (OpenProcessToken(process, TOKEN_QUERY, &token.value) != TRUE)
    return;
  if (const std::optional<DWORD> elevated =
          WindowsTargetTokenDword(token.value, TokenElevation))
    facts->token_elevated = *elevated != 0;
  const std::optional<std::vector<std::uint8_t>> user =
      WindowsTargetTokenInformation(token.value, TokenUser);
  const std::optional<std::vector<std::uint8_t>> own_user =
      WindowsTargetTokenInformation(own, TokenUser);
  if (user.has_value() && own_user.has_value() &&
      user->size() >= sizeof(TOKEN_USER) && own_user->size() >= sizeof(TOKEN_USER)) {
    PSID target_sid = reinterpret_cast<const TOKEN_USER *>(user->data())->User.Sid;
    PSID own_sid = reinterpret_cast<const TOKEN_USER *>(own_user->data())->User.Sid;
    if (target_sid != nullptr && own_sid != nullptr && IsValidSid(target_sid) &&
        IsValidSid(own_sid))
      facts->token_other_user = EqualSid(target_sid, own_sid) != TRUE;
  }
  const std::optional<DWORD> session = WindowsTargetTokenDword(token.value, TokenSessionId);
  const std::optional<DWORD> own_session = WindowsTargetTokenDword(own, TokenSessionId);
  if (session.has_value() && own_session.has_value())
    facts->token_other_session = *session != *own_session;
  if (const std::optional<DWORD> ui_access =
          WindowsTargetTokenDword(token.value, TokenUIAccess))
    facts->token_ui_access = *ui_access != 0;
  const std::optional<DWORD> integrity = WindowsTargetIntegrityRid(token.value);
  const std::optional<DWORD> own_integrity = WindowsTargetIntegrityRid(own);
  if (integrity.has_value() && own_integrity.has_value())
    facts->token_integrity_above_self = *integrity > *own_integrity;
  if (const std::optional<DWORD> app_container =
          WindowsTargetTokenDword(token.value, TokenIsAppContainer))
    facts->token_app_container = *app_container != 0;
}

std::optional<std::string> WindowsTargetPackageSignatureKind(const std::wstring &full_name) {
#if SPRINT_CODER_HAS_WINDOWS_PACKAGE_CATALOG
  try {
    const winrt::Windows::ApplicationModel::Package package =
        winrt::Windows::Management::Deployment::PackageManager().FindPackageForUser(
            L"", full_name);
    if (package == nullptr)
      return std::nullopt;
    switch (package.SignatureKind()) {
    case winrt::Windows::ApplicationModel::PackageSignatureKind::None:
      return "none";
    case winrt::Windows::ApplicationModel::PackageSignatureKind::Developer:
      return "developer";
    case winrt::Windows::ApplicationModel::PackageSignatureKind::Enterprise:
      return "enterprise";
    case winrt::Windows::ApplicationModel::PackageSignatureKind::Store:
      return "store";
    case winrt::Windows::ApplicationModel::PackageSignatureKind::System:
      return "system";
    }
  } catch (...) {
  }
#else
  (void)full_name;
#endif
  return std::nullopt;
}

// The install location of a package, by its full name, canonicalized. The name comes from the
// target's own package identity (GetPackageFullName on its handle), so this is used only to place
// a target that is already a package: a non-package exe under some X:\WindowsApps is never given
// this root. std::nullopt when the package has no path.
std::optional<std::string> WindowsTargetPackageInstallRoot(const std::wstring &full_name) {
  UINT32 length = 0;
  if (GetPackagePathByFullName(full_name.c_str(), &length, nullptr) !=
          ERROR_INSUFFICIENT_BUFFER ||
      length == 0 || length > 32'768)
    return std::nullopt;
  std::wstring path(length, L'\0');
  if (GetPackagePathByFullName(full_name.c_str(), &length, path.data()) != ERROR_SUCCESS ||
      length == 0)
    return std::nullopt;
  path.resize(length - 1);
  const std::string canonical = CanonicalWindowsTargetDirectory(path);
  if (canonical.empty())
    return std::nullopt;
  return canonical;
}

std::optional<bool> WindowsTargetPackageDevelopmentMode(const std::wstring &full_name) {
  PACKAGE_INFO_REFERENCE reference = nullptr;
  if (OpenPackageInfoByFullName(full_name.c_str(), 0, &reference) != ERROR_SUCCESS)
    return std::nullopt;
  std::optional<bool> development;
  UINT32 bytes = 0;
  UINT32 count = 0;
  constexpr UINT32 filter = PACKAGE_FILTER_HEAD | PACKAGE_FILTER_DIRECT;
  if (GetPackageInfo(reference, filter, &bytes, nullptr, &count) ==
          ERROR_INSUFFICIENT_BUFFER &&
      bytes > 0 && bytes <= 1024 * 1024) {
    std::vector<std::uint8_t> buffer(bytes);
    if (GetPackageInfo(reference, filter, &bytes, buffer.data(), &count) ==
        ERROR_SUCCESS) {
      const auto *packages = reinterpret_cast<const PACKAGE_INFO *>(buffer.data());
      for (UINT32 index = 0; index < count; ++index)
        if (packages[index].packageFullName != nullptr &&
            SameWindowsTargetName(packages[index].packageFullName, full_name))
          development = (packages[index].flags & PACKAGE_PROPERTY_DEVELOPMENT_MODE) != 0;
    }
  }
  ClosePackageInfo(reference);
  return development;
}

void MeasureWindowsTargetPackage(HANDLE process, WindowsTargetFactsMeasurement *measured) {
  sprint_coder::computer_use::TargetFacts &facts = measured->facts;
  UINT32 length = 0;
  const LONG probed = GetPackageFullName(process, &length, nullptr);
  if (probed == APPMODEL_ERROR_NO_PACKAGE) {
    facts.packaged = false;
    facts.package_family = std::string{};
    facts.package_signature_kind = "none";
    facts.package_development_mode = false;
    return;
  }
  if (probed != ERROR_INSUFFICIENT_BUFFER || length == 0 || length > 1024)
    return;
  std::wstring full_name(length, L'\0');
  if (GetPackageFullName(process, &length, full_name.data()) != ERROR_SUCCESS ||
      length == 0)
    return;
  full_name.resize(length - 1);
  facts.packaged = true;
  measured->package_full_name = WindowsTargetUtf8(full_name);
  UINT32 family_length = 0;
  if (GetPackageFamilyName(process, &family_length, nullptr) ==
          ERROR_INSUFFICIENT_BUFFER &&
      family_length > 0 && family_length <= 1024) {
    std::wstring family(family_length, L'\0');
    if (GetPackageFamilyName(process, &family_length, family.data()) ==
            ERROR_SUCCESS &&
        family_length > 0) {
      family.resize(family_length - 1);
      facts.package_family = WindowsTargetUtf8(family);
    }
  }
  UINT32 id_bytes = 0;
  if (PackageIdFromFullName(full_name.c_str(), PACKAGE_INFORMATION_BASIC,
                            &id_bytes, nullptr) == ERROR_INSUFFICIENT_BUFFER &&
      id_bytes > 0 && id_bytes <= 64 * 1024) {
    std::vector<std::uint8_t> id(id_bytes);
    if (PackageIdFromFullName(full_name.c_str(), PACKAGE_INFORMATION_BASIC,
                              &id_bytes, id.data()) == ERROR_SUCCESS) {
      const auto *package = reinterpret_cast<const PACKAGE_ID *>(id.data());
      if (package->publisherId != nullptr)
        measured->package_publisher_id = WindowsTargetUtf8(package->publisherId);
    }
  }
  facts.package_development_mode = WindowsTargetPackageDevelopmentMode(full_name);
  facts.package_signature_kind = WindowsTargetPackageSignatureKind(full_name);
  measured->package_install_root = WindowsTargetPackageInstallRoot(full_name);
}

// Every process with its parent pid, its creation time and its leaf, all from one kernel snapshot
// (NtQuerySystemInformation(SystemProcessInformation), parsed by ParseWindowsProcessSnapshot). No
// process is opened, so a process this helper may not open (a SYSTEM orphan, a protected process)
// still carries its creation time, and a reused pid is told from a parent by time for every node
// (opening each one, as before, left those without a time and adopted them as children). The
// parent pid and the time come from the same snapshot, so they agree with each other. std::nullopt
// when the snapshot cannot be taken or read (the lineage is then not measured).
std::optional<std::vector<sprint_coder::computer_use::WindowsProcessNode>>
SnapshotWindowsTargetProcesses() {
  using NtQuerySystemInformationFn = LONG(WINAPI *)(ULONG, PVOID, ULONG, PULONG);
  static const NtQuerySystemInformationFn query = []() {
    const HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    return ntdll == nullptr ? nullptr
                            : reinterpret_cast<NtQuerySystemInformationFn>(
                                  GetProcAddress(ntdll, "NtQuerySystemInformation"));
  }();
  if (query == nullptr)
    return std::nullopt;
  constexpr ULONG kSystemProcessInformation = 5;
  constexpr LONG kStatusInfoLengthMismatch = static_cast<LONG>(0xC0000004L);
  constexpr std::size_t kSnapshotLimit = 64u * 1024u * 1024u;
  std::vector<std::uint8_t> buffer(1024u * 1024u);
  // Processes come and go between the size query and the read, so grow and retry a few times.
  for (int attempt = 0; attempt < 8; ++attempt) {
    ULONG needed = 0;
    const LONG status = query(kSystemProcessInformation, buffer.data(),
                              static_cast<ULONG>(buffer.size()), &needed);
    if (status >= 0)
      return sprint_coder::computer_use::ParseWindowsProcessSnapshot(
          buffer, reinterpret_cast<std::uintptr_t>(buffer.data()), 65'536);
    if (status != kStatusInfoLengthMismatch)
      return std::nullopt;
    const std::size_t grown = std::max<std::size_t>(buffer.size() * 2,
                                                    static_cast<std::size_t>(needed) + 64 * 1024);
    if (grown > kSnapshotLimit)
      return std::nullopt;
    buffer.assign(grown, 0);
  }
  return std::nullopt;
}

struct WindowsTargetDescendant {
  bool shell = false;
  bool console_host = false;
};

// What one descendant is, read from its running image as the target's is (held, with the path it
// was recorded under): a shell when its subsystem is not GUI, or when its leaf, its image's leaf or
// its OriginalFilename is on the W4 leaf table; a console host by the same names. The names are
// read whether or not the image is signed (they only cap). A descendant that cannot be opened, is
// no longer the process the snapshot saw, or whose image cannot be read and held counts as a shell
// (the upper class C). The hold must pass the same gate as the target's own
// (WindowsTargetRunningImageMatches: not remote, and the rename probe followed on the descendant's
// file system); a descendant that does not is a shell too, never "not a shell".
WindowsTargetDescendant
InspectWindowsTargetDescendant(const sprint_coder::computer_use::WindowsProcessNode &node,
                               const std::optional<WindowsTargetRenameProbe> &rename_probe) {
  using namespace sprint_coder::computer_use;
  WindowsTargetDescendant result;
  result.console_host = WindowsLeafIsConsoleHost(node.leaf);
  result.shell = true;
  if (WindowsLeafIsShell(node.leaf))
    return result;
  ScopedKernelHandle process(OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ,
                                         FALSE, node.pid));
  if (process.value == nullptr)
    return result;
  const std::optional<std::uint64_t> creation = WindowsTargetCreationTime(process.value);
  if (!creation.has_value() || !node.creation.has_value() || *creation != *node.creation)
    return result;
  std::wstring recorded_path;
  const std::optional<std::wstring> recorded =
      ReadProcessPath(process.value, &recorded_path)
          ? std::optional<std::wstring>(std::move(recorded_path))
          : std::nullopt;
  WindowsTargetHeldImage held;
  if (!WindowsTargetImageKnownLocal(process.value) ||
      !HoldWindowsTargetRunningImage(process.value, recorded, &held) ||
      !WindowsTargetRunningImageMatches(held.matches, held.remote, held.volume,
                                        rename_probe))
    return result;
  const std::optional<std::string> path = WindowsTargetUtf8(held.canonical_path);
  const std::optional<std::string> subsystem = WindowsTargetPeSubsystem(held.file.value);
  const std::optional<std::string> original = WindowsTargetOriginalFilename(held.file.value);
  if (!path.has_value() || !subsystem.has_value() || !original.has_value())
    return result;
  const std::string leaf = WindowsImageLeaf(*path);
  result.console_host = result.console_host || WindowsLeafIsConsoleHost(leaf) ||
                        WindowsLeafIsConsoleHost(*original);
  result.shell = *subsystem != "gui" || WindowsLeafIsShell(leaf) || WindowsLeafIsShell(*original);
  return result;
}

void MeasureWindowsTargetLineage(const WindowsTargetFactsContext &context,
                                 WindowsTargetFactsMeasurement *measured) {
  using namespace sprint_coder::computer_use;
  const std::optional<std::vector<WindowsProcessNode>> nodes =
      SnapshotWindowsTargetProcesses();
  if (!nodes.has_value() || !measured->creation.has_value())
    return;
  const std::uint64_t creation = *measured->creation;
  for (const WindowsProcessNode &node : *nodes) {
    if (node.pid != measured->pid || node.creation != creation)
      continue;
    for (const WindowsProcessNode &parent : *nodes)
      if (parent.pid == node.parent_pid && parent.pid != node.pid &&
          parent.creation.has_value() && *parent.creation <= creation)
        measured->parent_pid = parent.pid;
  }
  // Every descendant is read from its running image, within a count and a time budget; a set of
  // descendants that does not fit them is not measured (unresolvable). "No shell" covers only the
  // descendants a live parent chain reaches: one below an exited intermediate is not seen (the
  // lineage note in the block comment says why no orphan signal stands in for it).
  const WindowsDescendants below = FindWindowsDescendants(
      *nodes, measured->pid, creation, kWindowsTargetDescendantLimit);
  if (!below.truncated && below.nodes.size() <= kWindowsTargetDescendantInspectLimit) {
    const ULONGLONG deadline = GetTickCount64() + kWindowsTargetDescendantBudgetMs;
    bool shell = false;
    bool pseudo_console = false;
    bool within_budget = true;
    for (const std::size_t index : below.nodes) {
      if (GetTickCount64() > deadline) {
        within_budget = false;
        break;
      }
      const WindowsTargetDescendant descendant =
          InspectWindowsTargetDescendant((*nodes)[index], context.rename_probe);
      shell = shell || descendant.shell;
      pseudo_console = pseudo_console || descendant.console_host;
    }
    if (within_budget && GetTickCount64() <= deadline) {
      measured->facts.descendant_shell = shell;
      measured->facts.descendant_pseudo_console = pseudo_console;
    }
  }
  // Without a lineage root nothing can say what is Sprint Coder's own: not measured.
  if (context.lineage_root_pid == 0)
    return;
  const WindowsDescendants own = FindWindowsDescendants(
      *nodes, context.lineage_root_pid, context.lineage_root_creation,
      kWindowsTargetDescendantLimit);
  bool own_descendant = own.truncated || (measured->pid == context.lineage_root_pid &&
                                          creation == context.lineage_root_creation);
  for (const std::size_t index : own.nodes)
    own_descendant = own_descendant || ((*nodes)[index].pid == measured->pid &&
                                        (*nodes)[index].creation == creation);
  measured->facts.own_descendant = own_descendant;
}

std::optional<std::string> WindowsTargetWindowClass(HWND window, std::uint32_t pid) {
  DWORD owner = 0;
  if (window == nullptr || GetWindowThreadProcessId(window, &owner) == 0 ||
      owner != pid)
    return std::nullopt;
  std::array<wchar_t, 257> name{};
  const int length = GetClassNameW(window, name.data(), static_cast<int>(name.size()));
  if (length <= 0)
    return std::nullopt;
  return WindowsTargetUtf8(std::wstring_view(name.data(), static_cast<std::size_t>(length)));
}

// The facts read from the held running image (S5-c-3 PR-5 split this out of
// MeasureWindowsTargetFacts so the seam can give it a held image whose volume it substitutes: a
// remote volume, another file system than the probe's, or no probe). Every fact it sets is reset
// first, so a measurement is never left with a value from another hold.
void MeasureWindowsTargetHeldFacts(const WindowsTargetHeldImage &held,
                                   const WindowsTargetFactsContext &context,
                                   WindowsTargetFactsMeasurement *out) {
  using namespace sprint_coder::computer_use;
  WindowsTargetFactsMeasurement &measured = *out;
  TargetFacts &facts = measured.facts;
  for (std::optional<std::string> *reset :
       {&facts.image_root, &facts.image_relative_path, &facts.image_leaf, &facts.image_volume,
        &facts.signature, &facts.signer_organization, &facts.pe_subsystem, &facts.original_filename})
    reset->reset();
  for (std::optional<bool> *reset : {&facts.running_image_matches, &facts.signer_microsoft_root,
                                     &facts.signer_is_self, &facts.acceptance_fixture,
                                     &facts.requires_administrator})
    reset->reset();
  measured.image_path.clear();
  measured.file_identity.reset();
  measured.signature_source = WindowsTargetSignatureSource::kNone;
  measured.signer_thumbprint.clear();
  // The running-image anchor rests on QueryFullProcessImageNameW following a rename. The one-time
  // probe confirms that only for the file system it ran on (the temp volume), so the target matches
  // only when the probe followed and the target's own file system is the same. A target on another
  // file system (e.g. temp is NTFS and the target is on ReFS or a Dev Drive) is unresolvable until
  // a probe for that file system is available. Fail closed on anything missing.
  // The held file must also be known not to be remote, checked here on top of the volume class
  // (image_volume "network" is W-UR on its own path).
  facts.running_image_matches = WindowsTargetRunningImageMatches(
      held.matches, held.remote, held.volume, context.rename_probe);
  measured.image_path = held.canonical_path;
  measured.file_identity = held.identity;
  const std::optional<std::string> path = WindowsTargetUtf8(held.canonical_path);
  if (path.has_value()) {
    facts.image_leaf = WindowsImageLeaf(*path);
    if (context.roots.has_value()) {
      WindowsImagePlacement placement = PlaceWindowsImage(*path, *context.roots);
      facts.image_root = std::move(placement.root);
      facts.image_relative_path = std::move(placement.relative_path);
    }
    // A verified package's own install location is its windows_apps root, so a Store app on a
    // volume other than the system drive is placed as a package rather than "other". The override
    // applies only when the standard placement found no known root ("other"): a package under
    // %WINDIR% (SystemApps), Program Files or self_install keeps that root, so a %WINDIR% system
    // package stays windows_directory (W-SYS) and does not slip onto the package route. This is
    // only reached for a target that is itself a package, so it never gives a non-package exe
    // windows_apps either.
    if (facts.packaged == std::optional<bool>(true) && facts.image_root == std::string("other") &&
        measured.package_install_root.has_value()) {
      const sprint_coder::computer_use::WindowsImageRootPrefix roots[] = {
          {"windows_apps", *measured.package_install_root}};
      WindowsImagePlacement placement = PlaceWindowsImage(*path, roots);
      if (placement.root == "windows_apps") {
        facts.image_root = std::move(placement.root);
        facts.image_relative_path = std::move(placement.relative_path);
      }
    }
    facts.acceptance_fixture =
        context.acceptance_mode &&
        target_eligibility_detail::AsciiLower(*facts.image_leaf) == kWindowsTargetFixtureLeaf;
  }
  facts.image_volume = WindowsTargetVolumeKind(held.file.value);
  // A held file not known to be local already records running_image_matches = false, so its bytes
  // are not read for the signature, the resources or the subsystem: those facts stay unmeasured,
  // which makes the verdict unresolvable (incomplete facts are judged before any rule), and a
  // remote share's owner could otherwise make each read fail or stall.
  if (held.remote != std::optional<bool>(false))
    return;

  const WindowsTargetSignature signature =
      VerifyWindowsTargetSignature(held.file.value, held.canonical_path);
  measured.signature_source = signature.source;
  if (signature.state.has_value()) {
    const bool verified = *signature.state == "valid";
    measured.signer_thumbprint = verified ? signature.thumbprint : std::string{};
    // Decision I: a catalog admits nothing outside %WINDIR%.
    const bool catalog_outside_windows =
        signature.source == WindowsTargetSignatureSource::kCatalog &&
        facts.image_root.value_or("") != "windows_directory";
    facts.signature = verified && catalog_outside_windows ? std::string("unsigned")
                                                          : *signature.state;
    facts.signer_organization = verified ? signature.organization : std::string{};
    facts.signer_microsoft_root = verified ? signature.microsoft_root : false;
    facts.signer_is_self = verified && !context.self_signer_thumbprint.empty() &&
                           signature.thumbprint == context.self_signer_thumbprint;
    ReadWindowsTargetResources(held.file.value, verified, &facts);
  }
  facts.pe_subsystem = WindowsTargetPeSubsystem(held.file.value);
}

// Measures one target process (and the window it is asked about, which may be null). The result
// is only facts: judging them is the core's, and nothing here calls it.
WindowsTargetFactsMeasurement MeasureWindowsTargetFacts(
    std::uint32_t pid, HWND window, const WindowsTargetFactsContext &context) {
  using namespace sprint_coder::computer_use;
  WindowsTargetFactsMeasurement measured;
  measured.pid = pid;
  measured.facts.platform = TargetPlatform::kWin32;
  ScopedKernelHandle process(
      OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, FALSE, pid));
  if (process.value == nullptr || GetProcessId(process.value) != pid)
    return measured;
  measured.creation = WindowsTargetCreationTime(process.value);
  if (!measured.creation.has_value())
    return measured;
  TargetFacts &facts = measured.facts;
  MeasureWindowsTargetToken(process.value, &facts);
  MeasureWindowsTargetPackage(process.value, &measured);
  facts.window_class = WindowsTargetWindowClass(window, pid);
  MeasureWindowsTargetLineage(context, &measured);

  // The recorded path first, as V1 reads it, then the running image: a rename in between leaves
  // the recorded path naming another file, which is a mismatch.
  std::wstring recorded_path;
  const std::optional<std::wstring> recorded =
      ReadProcessPath(process.value, &recorded_path)
          ? std::optional<std::wstring>(std::move(recorded_path))
          : std::nullopt;
  WindowsTargetHeldImage held;
  if (!WindowsTargetImageKnownLocal(process.value) ||
      !HoldWindowsTargetRunningImage(process.value, recorded, &held))
    return measured;
  MeasureWindowsTargetHeldFacts(held, context, &measured);
  return measured;
}
// END windows target facts

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

// BEGIN windows package identity (#500 S5-c-3 PR-4)
// The v2 identity of a package target. A Store or System signed package under WindowsApps is
// identified by its family, its publisherId and the image's path inside the package
// (WindowsPackageIdentityFor), so an ordinary Store update, which moves the versioned install
// directory and the bytes, keeps the identity, while another publisher, or another image in the
// same package, does not. Every other target keeps the Win32 identity. v2 builds only: a v1 build
// always answers std::nullopt, and the V1 identity (BuildLockedWindowsExecutableIdentity) and its
// JSON (WindowsIdentityJson) stay byte for byte what they were. Nothing calls this yet: PR-5 uses
// it for list_targets and the v2 start, resume and per-input checks. The executable identity must
// be of the very file the facts held (file id and path), and the running image must have matched,
// or there is no package identity.
struct WindowsPackageIdentity {
  std::string family;
  std::string publisher_id;
  std::string relative_path;
  std::string identity_digest;
};

std::optional<WindowsPackageIdentity>
WindowsTargetPackageIdentity(const WindowsTargetFactsMeasurement &measured,
                             const WindowsExecutableIdentity &identity) {
  if constexpr (!sprint_coder::computer_use::kNativeEligibilityIsV2) {
    (void)measured;
    (void)identity;
    return std::nullopt;
  } else {
    if (measured.facts.running_image_matches != std::optional<bool>(true) ||
        !measured.file_identity.has_value() ||
        !SameWindowsFileIdentity(*measured.file_identity, identity.file_identity) ||
        !SameWindowsTargetName(measured.image_path, identity.path))
      return std::nullopt;
    // The relative path is taken from the path the JSON carries, so Main's suffix check reads the
    // same string.
    const std::optional<sprint_coder::computer_use::WindowsPackageIdentityParts> parts =
        sprint_coder::computer_use::WindowsPackageIdentityFor(
            {measured.facts.packaged, measured.facts.package_signature_kind,
             measured.facts.package_development_mode, measured.facts.package_family,
             measured.package_publisher_id, measured.facts.image_root, identity.path_utf8,
             measured.package_install_root});
    if (!parts.has_value())
      return std::nullopt;
    return WindowsPackageIdentity{parts->family, parts->publisher_id, parts->relative_path,
                                  Sha256String(parts->preimage)};
  }
}

// The identity JSON of a package target: WindowsIdentityJson's fields, with the package digest as
// identityDigest, no signer digest (the package signature, not an embedded one, is what the
// identity rests on), and the family, publisherId and package-relative path that Main recomputes
// the digest from (computerAppNativeIdentityDigest). The mode is the v2 core's, given by PR-5.
std::string WindowsPackageIdentityJson(const WindowsExecutableIdentity &identity,
                                       const WindowsPackageIdentity &package,
                                       std::string_view maximum_mode, std::uint32_t pid = 0) {
  return "{\"platform\":\"win32\",\"identityDigest\":\"" + package.identity_digest +
         "\",\"executablePath\":\"" + JsonEscape(identity.path_utf8) +
         "\",\"executableDigest\":\"" + identity.executable_digest +
         "\",\"signerDigest\":null,\"packageFamilyName\":\"" + JsonEscape(package.family) +
         "\",\"packagePublisherId\":\"" + JsonEscape(package.publisher_id) +
         "\",\"packageRelativePath\":\"" + JsonEscape(package.relative_path) +
         "\",\"appUserModelId\":null,\"displayName\":\"" + JsonEscape(identity.display_name) +
         "\",\"policyLanguage\":\"" + identity.policy_language + "\",\"maximumMode\":\"" +
         JsonEscape(maximum_mode) + "\"" + (pid == 0 ? "" : ",\"pid\":" + std::to_string(pid)) +
         "}";
}
// END windows package identity

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
  if (WindowsTargetListWorkerRunning().load(std::memory_order_acquire)) {
    *reason = "picker_unavailable";
    return false;
  }
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
  std::function<bool()> still_valid;
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
  if (context != nullptr && context->still_valid && !context->still_valid()) return FALSE;
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
                                   std::vector<std::string> *candidates,
                                   const std::function<bool()>& still_valid = {}) {
  const auto current = [&] { return !still_valid || still_valid(); };
  if (!current()) return false;
  ScopedKernelHandle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
  if (snapshot.value == INVALID_HANDLE_VALUE)
    return false;
  PROCESSENTRY32W entry{};
  entry.dwSize = sizeof(entry);
  if (Process32FirstW(snapshot.value, &entry)) {
    do {
      if (!current()) return false;
      if (entry.th32ProcessID == 0)
        continue;
      LockedWindowsExecutable process_executable;
      if (!OpenLockedProcessExecutable(entry.th32ProcessID,
                                       &process_executable))
        continue;
      if (!current()) return false;
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
      context.still_valid = still_valid;
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
      if (!current()) return false;
      EnumWindows(CollectTopLevelWindow, reinterpret_cast<LPARAM>(&context));
      if (!current()) return false;
      CloseLockedWindowsExecutable(&process_executable);
      candidates->insert(candidates->end(), context.candidates.begin(),
                         context.candidates.end());
    } while (candidates->size() < 64 && Process32NextW(snapshot.value, &entry));
  }
  return current();
}

bool LaunchVerifiedExecutable(const LockedWindowsExecutable &locked,
                              HANDLE *process,
                              const std::function<bool()>& claim = {},
                              const std::function<void()>& retire = {}) {
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
  if (claim && !claim()) return false;
  struct LaunchUnit {
    const std::function<void()>& retire;
    ~LaunchUnit() { if (retire) retire(); }
  } unit{retire};
  struct OwnedChild {
    ScopedKernelHandle process, thread;
    bool verified = false;
    ~OwnedChild() {
      if (!verified && process.value != nullptr && process.value != INVALID_HANDLE_VALUE) {
        if (WaitForSingleObject(process.value, 0) != WAIT_OBJECT_0)
          TerminateProcess(process.value, ERROR_INVALID_IMAGE_HASH);
        // A failed termination is not a cleanup receipt. This worker and its launch unit stay
        // owned until exit is observed; no consumer/Stop mutex is held while waiting.
        while (WaitForSingleObject(process.value, INFINITE) != WAIT_OBJECT_0) Sleep(1000);
      }
    }
  } child;
  const BOOL created = CreateProcessW(
          canonical_path.c_str(), nullptr, nullptr, nullptr, FALSE,
          CREATE_UNICODE_ENVIRONMENT, nullptr,
          working_directory.empty() ? nullptr : working_directory.c_str(),
          &startup, &information);
  child.process.value = information.hProcess;
  child.thread.value = information.hThread;
  if (!created) return false;
  LockedWindowsExecutable launched_image;
  const bool image_matches =
      OpenLockedProcessExecutable(child.process.value, &launched_image) &&
      SameWindowsPath(launched_image.identity.path, locked.identity.path) &&
      SameWindowsFileIdentity(launched_image.identity.file_identity,
                              locked.identity.file_identity) &&
      launched_image.identity.identity_digest == locked.identity.identity_digest &&
      launched_image.identity.executable_digest ==
          locked.identity.executable_digest &&
      launched_image.identity.signer_digest == locked.identity.signer_digest;
  CloseLockedWindowsExecutable(&launched_image);
  if (!image_matches) return false;
  child.verified = true;
  *process = child.process.release();
  return true;
}

// BEGIN windows v2 targets (#500 S5-c-3 PR-5)
// The v2 target eligibility, wired: list_targets, and the v2 start, resume and per-input judgement.
// Every one of them measures the target from its running image (MeasureWindowsTargetFacts), judges
// it with the shared core (ClassifyTarget) and takes the mode from the core alone: the policy
// language (the app's own MUI claim) is not a ground for the mode on this path. The V1 deny-side
// checks (the leaf table, the proxy table, elevation) are applied on top, so either refuses (ADR v2
// section 3.2.1-5). v2 builds only: a v1 build answers list_targets with unsupported_operation and
// admits no v2 session (EligibilityBasisAdmitted). The shared new-start worker also serves V1,
// with its own unchanged eligibility branch and without V2 facts or context.
//
// What crosses to Main: a selectable row carries the identity Main binds a grant and a token to
// (with the path and the pid, which Main keeps to itself: ADR section 3.2.2); a refused row carries
// its kind and nothing else, no title, class, leaf, pid or identity (ADR section 3.2.1-4).

inline constexpr std::size_t kWindowsListTargetsRowLimit = 64;
// The consumer's wait budget for list_targets. Completed rows survive it; unfinished measurements
// are unresolvable. Listing, new V2 starts, session identity reads and V2 rejudgements share one
// measurement slot. A driver may ignore best-effort CancelSynchronousIo, so cleanup keeps it occupied even
// after the consumer answers. This list-only deadline is not a new native start deadline.
inline constexpr ULONGLONG kWindowsListTargetsBudgetMs = 6'000;

// Main's pid (the lineage root for W8), set by ServeMain before the first request.
std::uint32_t windows_v2_main_pid = 0;
// The first list generation of this helper: random in [1, 2^52), reducing the chance a restarted
// helper repeats an earlier generation. Main must still discard tokens on restart; randomness is
// not a guarantee against reuse. 2^52 keeps the value exact as a JSON number
// in Main. 0 (no list yet) when the system cannot give random bytes: then the first list is 1, as
// before, and an earlier helper's token is refused only by Main's discarding it on a restart.
std::uint64_t InitialWindowsV2ListGeneration() {
  std::uint64_t random = 0;
  if (BCryptGenRandom(nullptr, reinterpret_cast<PUCHAR>(&random), sizeof(random),
                      BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0)
    return 0;
  constexpr std::uint64_t kRange = (std::uint64_t{1} << 52) - 2;
  return 1 + random % kRange;
}

// Advanced by every list_targets that is answered: a new session must name the latest list it was
// offered from.
std::uint64_t windows_v2_list_generation = InitialWindowsV2ListGeneration();

sprint_coder::computer_use::WindowsFileKey
WindowsFileKeyOf(const WindowsFileIdentity &identity) {
  sprint_coder::computer_use::WindowsFileKey key;
  key.volume_serial = identity.volume_serial;
  static_assert(sizeof(identity.file_id.Identifier) == 16, "FILE_ID_128 is 16 bytes");
  std::memcpy(key.file_id.data(), identity.file_id.Identifier, key.file_id.size());
  return key;
}

// This helper's own leaf thumbprint, for signerIsSelf (W8): "" when it is not validly signed (a
// development build), which leaves W8 to its other rules.
std::string WindowsV2SelfSignerThumbprint() {
  std::vector<wchar_t> module(32'768, L'\0');
  const DWORD length =
      GetModuleFileNameW(nullptr, module.data(), static_cast<DWORD>(module.size()));
  if (length == 0 || length >= module.size())
    return {};
  const std::wstring path(module.data(), length);
  ScopedKernelHandle file(CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
                                      OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
  if (file.value == INVALID_HANDLE_VALUE)
    return {};
  const WindowsTargetSignature signature = VerifyWindowsTargetSignature(file.value, path);
  return signature.state == std::optional<std::string>("valid") ? signature.thumbprint
                                                                 : std::string{};
}

// Measured once per helper: the roots, the lineage root and the rename-follow probe (which starts a
// suspended copy of this helper, so it is not repeated per request).
// Without Main's pid nothing can say what is Sprint Coder's own (W8): an empty context, whose facts
// are unmeasured (unresolvable), and nothing is cached, so the real context is measured once the pid
// is known (fail closed).
struct WindowsTargetListState {
  std::mutex stop_mutex;
  std::atomic<std::uint64_t> stop_serial{0};
  std::atomic<bool> running{false};
  std::shared_ptr<const WindowsTargetFactsContext> context_candidate;
  std::uint64_t context_stop_serial = 0;
};

WindowsTargetListState &WindowsTargetListControl() {
  // An uninterruptible driver may outlive ServePipe and static destruction.
  static auto *state = new WindowsTargetListState;
  return *state;
}

struct WindowsStartRegistry {
  std::unordered_map<std::string, std::shared_ptr<WindowsStartAdmission>> owners;
  std::unordered_map<std::string, std::string> keys_by_id;
  std::deque<std::string> order;
  std::shared_ptr<WindowsStartAdmission> input_owner;
  std::weak_ptr<WindowsStartAdmission> last_input_owner;
};

WindowsStartRegistry &WindowsStarts() {
  // Like the measurement slot, a lease may outlive ServePipe and static destruction.
  static auto* registry = new WindowsStartRegistry;
  return *registry;
}

WindowsStartLease::~WindowsStartLease() {
  std::lock_guard lock(WindowsTargetListControl().stop_mutex);
  const auto previous = owner->pending_requests.fetch_sub(1, std::memory_order_acq_rel);
  auto& registry = WindowsStarts();
  if (previous == 1 && !owner->active) {
    owner->retired = true;
    if (registry.input_owner == owner) registry.input_owner.reset();
  }
}

std::shared_ptr<WindowsStartLease> AdmitWindowsStart(
    const std::string& key, const std::string& id, const std::string& request_key,
    const std::string& digest, std::string* reason, std::uint64_t requested_epoch = 0) {
  if (requested_epoch > 9007199254740991ULL || key.size() != 16 || id.empty() || id.size() > 256 || digest.size() != 64) {
    *reason = "session_input_invalid";
    return nullptr;
  }
  std::lock_guard lock(WindowsTargetListControl().stop_mutex);
  auto& registry = WindowsStarts();
  const auto by_id = registry.keys_by_id.find(id);
  auto found = registry.owners.find(key);
  if ((by_id != registry.keys_by_id.end() && by_id->second != key) ||
      (found != registry.owners.end() && found->second->session_id != id)) {
    *reason = "session_id_reuse";
    return nullptr;
  }
  if (found == registry.owners.end()) {
    constexpr std::size_t limit = 16;
    while (registry.owners.size() >= limit) {
      const auto victim = std::find_if(registry.order.begin(), registry.order.end(),
          [&](const auto& candidate) {
            const auto value = registry.owners.find(candidate);
            return value == registry.owners.end() ||
                (value->second->terminal && !value->second->active &&
                 value->second->pending_requests.load(std::memory_order_acquire) == 0);
          });
      if (victim == registry.order.end()) {
        *reason = "session_limit";
        return nullptr;
      }
      const auto value = registry.owners.find(*victim);
      if (value != registry.owners.end()) {
        registry.keys_by_id.erase(value->second->session_id);
        registry.owners.erase(value);
      }
      registry.order.erase(victim);
    }
    auto owner = std::make_shared<WindowsStartAdmission>();
    owner->session_key = key;
    owner->session_id = id;
    registry.keys_by_id.emplace(id, key);
    registry.order.push_back(key);
    found = registry.owners.emplace(key, std::move(owner)).first;
  }
  const auto& owner = found->second;
  const auto prior = owner->request_digests.find(request_key);
  if (prior != owner->request_digests.end()) {
    if (prior->second != digest) {
      *reason = "request_id_reuse";
      return nullptr;
    }
  } else {
    if (owner->stopped.load(std::memory_order_acquire) || owner->terminal || owner->retired) {
      *reason = "session_id_reuse";
      return nullptr;
    }
    if (owner->request_order.size() >= kMaximumCachedResponses) {
      owner->request_digests.erase(owner->request_order.front());
      owner->request_order.pop_front();
    }
    owner->request_order.push_back(request_key);
    owner->request_digests.emplace(request_key, digest);
  }
  owner->requested_epoch = std::max(owner->requested_epoch, requested_epoch);
  return std::make_shared<WindowsStartLease>(owner);
}

bool LatchWindowsPendingStop(const std::string& key, const std::string& id) {
  auto& control = WindowsTargetListControl();
  std::lock_guard lock(control.stop_mutex);
  auto& registry = WindowsStarts();
  const auto found = registry.owners.find(key);
  if (found == registry.owners.end() || found->second->session_id != id) return false;
  const auto& owner = found->second;
  if (!owner->stopped.exchange(true, std::memory_order_acq_rel) &&
      !owner->terminal && registry.input_owner == owner) {
    control.stop_serial.fetch_add(1, std::memory_order_acq_rel);
    control.context_candidate.reset();
  }
  return true;
}

bool ClaimWindowsStartInput(const std::shared_ptr<WindowsStartLease>& lease) {
  std::lock_guard lock(WindowsTargetListControl().stop_mutex);
  auto& registry = WindowsStarts();
  const auto& owner = lease->owner;
  const auto found = registry.owners.find(owner->session_key);
  if (found == registry.owners.end() || found->second != owner || owner->terminal || owner->retired ||
      owner->stopped.load(std::memory_order_acquire) ||
      (registry.input_owner != nullptr && registry.input_owner != owner)) return false;
  registry.input_owner = owner;
  registry.last_input_owner = owner;
  return true;
}

std::atomic<bool> &WindowsTargetListWorkerRunning() {
  return WindowsTargetListControl().running;
}

// BEGIN windows discovery ownership
inline constexpr std::uint64_t kWindowsDiscoveryBudgetMs = 25'000;

struct WindowsDiscoveryOwner {
  std::string key, id, original_request, original_digest;
  std::uint64_t admitted_at = 0;
  std::atomic<std::uint32_t> references{0};
  std::atomic<bool> stopped{false};
  bool query_claimed = false;
  bool terminal = false;
  bool completed = false;
  bool launch_in_flight = false;
  std::uint32_t launch_attempts = 0;
};

struct WindowsDiscoveryRegistry {
  std::unordered_map<std::string, std::shared_ptr<WindowsDiscoveryOwner>> owners;
  std::unordered_map<std::string, std::string> keys_by_id;
  std::deque<std::string> order;
};

WindowsDiscoveryRegistry& WindowsDiscoveries() {
  static auto* registry = new WindowsDiscoveryRegistry;
  return *registry;
}

struct WindowsDiscoveryLease {
  std::shared_ptr<WindowsDiscoveryOwner> owner;
  explicit WindowsDiscoveryLease(std::shared_ptr<WindowsDiscoveryOwner> value)
      : owner(std::move(value)) { owner->references.fetch_add(1, std::memory_order_acq_rel); }
  ~WindowsDiscoveryLease() {
    std::lock_guard lock(WindowsTargetListControl().stop_mutex);
    if (owner->references.fetch_sub(1, std::memory_order_acq_rel) == 1 && !owner->query_claimed) {
      // A frame dropped before the consumer claimed it cannot start a worker or launch.
      owner->stopped.store(true, std::memory_order_release);
      owner->terminal = true;
    }
  }
};

struct WindowsDiscoveryAdmission {
  std::shared_ptr<WindowsDiscoveryLease> lease;
  bool not_admitted = false;
  bool replay_only = false;
};

WindowsDiscoveryAdmission AdmitWindowsDiscovery(
    const std::string& key, const std::string& id, const std::string& request_key,
    const std::string& digest, bool fresh_wire_request, std::uint64_t admitted_at,
    std::string* reason) {
  if (key.size() != 16 || id.empty() || id.size() > 256 || digest.size() != 64) {
    *reason = "discovery_input_invalid"; return {};
  }
  std::lock_guard lock(WindowsTargetListControl().stop_mutex);
  auto& registry = WindowsDiscoveries();
  const auto by_id = registry.keys_by_id.find(id);
  auto found = registry.owners.find(key);
  if ((by_id != registry.keys_by_id.end() && by_id->second != key) ||
      (found != registry.owners.end() && found->second->id != id)) {
    *reason = "discovery_id_reuse"; return {};
  }
  if (found != registry.owners.end()) {
    const auto& owner = found->second;
    if (owner->original_request != request_key || owner->original_digest != digest) {
      *reason = "discovery_id_reuse"; return {};
    }
    return {std::make_shared<WindowsDiscoveryLease>(owner), false, false};
  }
  // An old wire request may still have a cached reply after its terminal owner was evicted.
  // Never create a new operation before the consumer has checked that cache.
  if (!fresh_wire_request) return {nullptr, false, true};
  constexpr std::size_t limit = 16;
  while (registry.owners.size() >= limit) {
    const auto victim = std::find_if(registry.order.begin(), registry.order.end(),
        [&](const auto& candidate) {
          const auto value = registry.owners.find(candidate);
          return value == registry.owners.end() ||
              (value->second->terminal && !value->second->launch_in_flight &&
               value->second->references.load(std::memory_order_acquire) == 0);
        });
    if (victim == registry.order.end()) return {nullptr, true, false};
    const auto value = registry.owners.find(*victim);
    if (value != registry.owners.end()) {
      registry.keys_by_id.erase(value->second->id); registry.owners.erase(value);
    }
    registry.order.erase(victim);
  }
  auto owner = std::make_shared<WindowsDiscoveryOwner>();
  owner->key = key; owner->id = id; owner->original_request = request_key;
  owner->original_digest = digest; owner->admitted_at = admitted_at;
  registry.keys_by_id.emplace(id, key);
  registry.order.push_back(key);
  registry.owners.emplace(key, owner);
  return {std::make_shared<WindowsDiscoveryLease>(owner), false, false};
}

std::shared_ptr<WindowsDiscoveryLease> ReferenceWindowsDiscoveryStop(
    const std::string& key, const std::string& id, bool latch) {
  std::lock_guard lock(WindowsTargetListControl().stop_mutex);
  const auto found = WindowsDiscoveries().owners.find(key);
  if (found == WindowsDiscoveries().owners.end() || found->second->id != id) return nullptr;
  const auto& owner = found->second;
  auto lease = std::make_shared<WindowsDiscoveryLease>(owner);
  if (latch) {
    owner->stopped.store(true, std::memory_order_release);
    if (!owner->launch_in_flight) {
      owner->terminal = true;
      owner->completed = false;
    }
  }
  return lease;
}

bool ClaimWindowsDiscoveryQuery(const std::shared_ptr<WindowsDiscoveryLease>& lease) {
  std::lock_guard lock(WindowsTargetListControl().stop_mutex);
  const auto& owner = lease->owner;
  const auto found = WindowsDiscoveries().owners.find(owner->key);
  if (found == WindowsDiscoveries().owners.end() || found->second != owner ||
      owner->query_claimed || owner->terminal || owner->stopped.load(std::memory_order_acquire))
    return false;
  owner->query_claimed = true;
  return true;
}

void FinishWindowsDiscovery(const std::shared_ptr<WindowsDiscoveryOwner>& owner, bool completed) {
  std::lock_guard lock(WindowsTargetListControl().stop_mutex);
  if (owner->launch_in_flight) return;
  owner->completed = completed && !owner->stopped.load(std::memory_order_acquire);
  owner->terminal = true;
}

void StopWindowsDiscoveriesForPipeEnd() {
  std::lock_guard lock(WindowsTargetListControl().stop_mutex);
  for (const auto& [key, owner] : WindowsDiscoveries().owners) {
    (void)key;
    owner->stopped.store(true, std::memory_order_release);
    if (!owner->launch_in_flight) { owner->terminal = true; owner->completed = false; }
  }
}
// END windows discovery ownership

std::optional<WindowsTargetFactsContext> &WindowsV2FactsContextCache() {
  static auto *context = new std::optional<WindowsTargetFactsContext>;
  return *context;
}

const WindowsTargetFactsContext &WindowsV2FactsContext() {
  static const auto *unknown = new WindowsTargetFactsContext;
  if (windows_v2_main_pid == 0)
    return *unknown;
  auto &context = WindowsV2FactsContextCache();
  if (!context.has_value())
    context = CurrentWindowsTargetFactsContext(windows_v2_main_pid, WindowsV2SelfSignerThumbprint(),
                                               /*acceptance_mode=*/false);
  return *context;
}

// The file %SystemRoot%\System32\notepad.exe names now (the explicit "not web" table), or nothing.
std::optional<sprint_coder::computer_use::WindowsFileKey> WindowsV2SystemNotepadKey() {
  std::vector<wchar_t> buffer(32'768, L'\0');
  const UINT length = GetSystemDirectoryW(buffer.data(), static_cast<UINT>(buffer.size()));
  if (length == 0 || length >= buffer.size())
    return std::nullopt;
  std::wstring path(buffer.data(), length);
  if (path.back() != L'\\')
    path.push_back(L'\\');
  path += L"note" L"pad.exe";
  const std::optional<WindowsPathIdentity> opened = WindowsTargetOpenPathIdentity(path);
  if (!opened.has_value())
    return std::nullopt;
  return WindowsFileKeyOf(opened->identity);
}

struct WindowsV2Judgement {
  sprint_coder::computer_use::TargetVerdict verdict;
  // The process's facts. Measured without a window: the window class is a fact of each window and
  // is put in by WindowsV2VerdictForWindowClass (the judgement of one window), never cached.
  WindowsTargetFactsMeasurement measured;
  LockedWindowsExecutable executable;
  std::optional<WindowsPackageIdentity> package;
  std::string app_identity;
  std::string process_start;
  std::optional<sprint_coder::computer_use::WindowsFileKey> held_key;
  std::optional<sprint_coder::computer_use::WindowsFileKey> table_key;
  // The identity above is read once, the first time a window of the process is selectable.
  bool identity_read = false;
  bool identity_ok = false;

  [[nodiscard]] bool Selectable() const {
    using sprint_coder::computer_use::TargetVerdictKind;
    return verdict.kind == TargetVerdictKind::kEligible || verdict.kind == TargetVerdictKind::kUpper;
  }
};

// The core's verdict for these facts, with the V1 deny-side tables on top. Refusals never become
// eligible here; a missing piece is unresolvable.
sprint_coder::computer_use::TargetVerdict
WindowsV2VerdictFor(const WindowsTargetFactsMeasurement &measured) {
  using namespace sprint_coder::computer_use;
  TargetVerdict verdict = ClassifyTarget(measured.facts);
  if ((verdict.kind == TargetVerdictKind::kEligible || verdict.kind == TargetVerdictKind::kUpper) &&
      (measured.image_path.empty() || IsKnownProxyExecutable(measured.image_path) ||
       IsDisallowedTargetExecutable(measured.image_path) || IsProcessElevated(measured.pid)))
    verdict = TargetVerdict{TargetVerdictKind::kDenied, {}};
  return verdict;
}

// The process half of a judgement: its facts, measured once (list_targets keeps one per process).
void MeasureWindowsV2Process(std::uint32_t pid, const WindowsTargetFactsContext &context,
                             WindowsV2Judgement *out) {
  out->measured = MeasureWindowsTargetFacts(pid, nullptr, context);
  out->verdict = sprint_coder::computer_use::TargetVerdict{};
}

// The identity a selectable window is bound with: the V1 identity of the very file the facts were
// read from (same file id and path), the package identity when the core took the package route,
// and the process start identity. Read once per process; false when any of it cannot be had.
bool EnsureWindowsV2Identity(WindowsV2Judgement *out) {
  if (out->identity_read)
    return out->identity_ok;
  out->identity_read = true;
  const std::uint32_t pid = out->measured.pid;
  if (!out->measured.file_identity.has_value() ||
      !OpenLockedProcessExecutable(pid, &out->executable) ||
      !SameWindowsFileIdentity(out->executable.identity.file_identity,
                               *out->measured.file_identity) ||
      !SameWindowsTargetName(out->executable.identity.path, out->measured.image_path) ||
      !ReadProcessStartIdentity(pid, &out->process_start))
    return false;
  out->package = WindowsTargetPackageIdentity(out->measured, out->executable.identity);
  // The core admitted a package; without the package identity there is nothing to bind it to.
  if (out->measured.facts.packaged == std::optional<bool>(true) && !out->package.has_value())
    return false;
  out->app_identity =
      out->package.has_value() ? out->package->identity_digest : out->executable.identity.identity_digest;
  out->held_key = WindowsFileKeyOf(*out->measured.file_identity);
  out->table_key = WindowsV2SystemNotepadKey();
  out->identity_ok = true;
  return true;
}

// The judgement of one window of the process: the process's facts with this window's own class.
// Each window is judged by itself, so neither the order the windows are listed in nor another
// window of the process (a console it allocated, a window gone between listing and measuring)
// changes its answer. A class that cannot be read leaves the facts incomplete: unresolvable.
sprint_coder::computer_use::TargetVerdict
WindowsV2VerdictForWindowClass(WindowsV2Judgement *process,
                               const std::optional<std::string> &window_class,
                               sprint_coder::computer_use::TargetFacts *measured_facts = nullptr) {
  using namespace sprint_coder::computer_use;
  WindowsTargetFactsMeasurement for_window = process->measured;
  for_window.facts.window_class = window_class;
  if (measured_facts != nullptr)
    *measured_facts = for_window.facts;
  TargetVerdict verdict = WindowsV2VerdictFor(for_window);
  if ((verdict.kind == TargetVerdictKind::kEligible || verdict.kind == TargetVerdictKind::kUpper) &&
      !EnsureWindowsV2Identity(process))
    verdict = TargetVerdict{TargetVerdictKind::kUnresolvable, {}};
  return verdict;
}

// Judges one window of one process (the start, the resume and every input of a v2 session).
void JudgeWindowsV2Target(std::uint32_t pid, HWND window, const WindowsTargetFactsContext &context,
                          WindowsV2Judgement *out) {
  MeasureWindowsV2Process(pid, context, out);
  const std::optional<std::string> window_class = WindowsTargetWindowClass(window, pid);
  out->verdict = WindowsV2VerdictForWindowClass(out, window_class);
  out->measured.facts.window_class = window_class;
}

// Private evidence for Main's independent classification. The generated signal table is the field
// list; unmeasured values remain null, and labels/titles are not facts.
std::string WindowsV2TargetFactsJson(const sprint_coder::computer_use::TargetFacts &facts) {
  using namespace sprint_coder::computer_use;
  std::string json = "{\"platform\":\"" + std::string(TargetPlatformName(facts.platform)) + "\"";
  for (const TargetSignalSpec &signal : kTargetSignals) {
    if ((signal.platforms & TargetPlatformBit(facts.platform)) == 0)
      continue;
    json += ",\"" + JsonEscape(std::string(signal.name)) + "\":";
    if (signal.type == TargetSignalType::kBoolean) {
      const auto *value = TargetBooleanFact(facts, signal.signal);
      json += value != nullptr && value->has_value() ? (**value ? "true" : "false") : "null";
    } else {
      const auto *value = TargetStringFact(facts, signal.signal);
      json += value != nullptr && value->has_value() ? "\"" + JsonEscape(**value) + "\"" : "null";
    }
  }
  return json + "}";
}

// Whether every fact string a row would carry is within what Main's schema takes (contracts'
// COMPUTER_NATIVE_TARGET_FACT_MAX_BYTES, the core's kTargetFactMaxBytes: UTF-8 bytes, as the strings
// are held). The core already answers unresolvable for a longer fact, so a selectable verdict
// implies this; it is checked again where the row is written, so a row Main would reject (and with
// it the whole list) is never sent. A value over the bound is never cut: the row is unresolvable.
bool WindowsV2FactsWithinContract(const sprint_coder::computer_use::TargetFacts &facts) {
  using namespace sprint_coder::computer_use;
  for (const TargetSignalSpec &signal : kTargetSignals) {
    if ((signal.platforms & TargetPlatformBit(facts.platform)) == 0 ||
        signal.type == TargetSignalType::kBoolean)
      continue;
    const std::optional<std::string> *value = TargetStringFact(facts, signal.signal);
    if (value != nullptr && value->has_value() && (*value)->size() > kTargetFactMaxBytes)
      return false;
  }
  return true;
}

// A label with the white space JavaScript's String.prototype.trim removes taken off both ends:
// WhiteSpace (U+0009, U+000B, U+000C, U+0020, U+00A0, U+FEFF and every Zs: U+1680, U+2000-U+200A,
// U+202F, U+205F, U+3000) and LineTerminator (U+000A, U+000D, U+2028, U+2029). Main's label schema
// trims the same set before it asks for a non-empty value. Bytes that are not well-formed UTF-8 end
// the trimming where they are (they are not white space).
std::string WindowsV2LabelTrimmed(std::string_view text) {
  const auto is_space = [](std::uint32_t code) {
    return code == 0x09 || code == 0x0a || code == 0x0b || code == 0x0c || code == 0x0d ||
           code == 0x20 || code == 0xa0 || code == 0x1680 || (code >= 0x2000 && code <= 0x200a) ||
           code == 0x2028 || code == 0x2029 || code == 0x202f || code == 0x205f ||
           code == 0x3000 || code == 0xfeff;
  };
  // The code point at "at" and its length, or length 0 when it is not well formed.
  const auto decode = [&text](std::size_t at, std::size_t *length) -> std::uint32_t {
    const auto byte = [&text](std::size_t index) {
      return static_cast<std::uint8_t>(text[index]);
    };
    const std::uint8_t first = byte(at);
    std::size_t width = first < 0x80 ? 1 : (first & 0xe0) == 0xc0 ? 2 : (first & 0xf0) == 0xe0 ? 3
                                                                    : (first & 0xf8) == 0xf0 ? 4 : 0;
    *length = 0;
    if (width == 0 || at + width > text.size()) return 0;
    std::uint32_t code = width == 1 ? first : first & (0xff >> (width + 1));
    for (std::size_t index = 1; index < width; ++index) {
      if ((byte(at + index) & 0xc0) != 0x80) return 0;
      code = (code << 6) | (byte(at + index) & 0x3f);
    }
    *length = width;
    return code;
  };
  std::size_t begin = 0;
  while (begin < text.size()) {
    std::size_t length = 0;
    const std::uint32_t code = decode(begin, &length);
    if (length == 0 || !is_space(code)) break;
    begin += length;
  }
  std::size_t end = text.size();
  while (end > begin) {
    // The start of the last code point before "end".
    std::size_t start = end - 1;
    while (start > begin && (static_cast<std::uint8_t>(text[start]) & 0xc0) == 0x80) --start;
    std::size_t length = 0;
    const std::uint32_t code = decode(start, &length);
    if (length == 0 || start + length != end || !is_space(code)) break;
    end = start;
  }
  return std::string(text.substr(begin, end - begin));
}

// The display name a v2 row carries: the V1 one trimmed as Main trims it, "Application" when nothing
// is left (an executable named "<U+3000>.exe" or " .exe"). V1 keeps nonblank names byte for byte;
// V2 trims their ends as well.
std::string WindowsV2DisplayName(std::string_view display_name) {
  std::string trimmed = WindowsV2LabelTrimmed(display_name);
  return trimmed.empty() ? std::string("Application") : trimmed;
}

// The identity JSON of a v2 row: the V1 fields with the mode of the window the row is for, or the
// package's.
std::string WindowsV2IdentityJson(const WindowsV2Judgement &judged, std::string_view window_mode) {
  WindowsExecutableIdentity identity = judged.executable.identity;
  identity.display_name = WindowsV2DisplayName(identity.display_name);
  const std::string mode(window_mode);
  if (judged.package.has_value())
    return WindowsPackageIdentityJson(identity, *judged.package, mode);
  return "{\"platform\":\"win32\",\"identityDigest\":\"" + identity.identity_digest +
         "\",\"executablePath\":\"" + JsonEscape(identity.path_utf8) +
         "\",\"executableDigest\":\"" + identity.executable_digest + "\",\"signerDigest\":" +
         (identity.signer_digest.empty() ? "null" : "\"" + identity.signer_digest + "\"") +
         ",\"packageFamilyName\":null,\"appUserModelId\":null,\"displayName\":\"" +
         JsonEscape(identity.display_name) + "\",\"policyLanguage\":\"" +
         identity.policy_language + "\",\"maximumMode\":\"" + JsonEscape(mode) + "\"}";
}

// The window half of a selectable row: what ListWindowsTargets read of the window itself.
struct WindowsV2RowWindow {
  std::uint64_t handle = 0;
  std::uint32_t pid = 0;
  std::string title;  // UTF-8, at most 256 bytes, not empty
  RECT client{};
  RECT screen{};
};

// Whether the identity strings a row carries are what Main's schema takes: the executable path of 1
// to 4096 characters and, for a package, its relative path within the same bound. (The display name
// is trimmed and never empty, the digests are fixed-width hex, the family is checked when it is made.)
bool WindowsV2IdentityWithinContract(const WindowsV2Judgement &judged) {
  const std::string &path = judged.executable.identity.path_utf8;
  if (path.empty() || path.size() > 4'096) return false;
  return !judged.package.has_value() ||
         (!judged.package->relative_path.empty() && judged.package->relative_path.size() <= 4'096);
}

std::string WindowsV2RefusedRow(sprint_coder::computer_use::TargetVerdictKind kind);

// One selectable row, as ListWindowsTargets writes it, or the unresolvable row when anything in it
// is outside what Main's schema takes (a fact string or an identity string): that window alone,
// never cut, and never with facts or identity.
std::string WindowsV2SelectableRow(const WindowsV2Judgement &judgement,
                                   const sprint_coder::computer_use::TargetVerdict &verdict,
                                   const sprint_coder::computer_use::TargetFacts &facts,
                                   const WindowsV2RowWindow &window) {
  using namespace sprint_coder::computer_use;
  if (!WindowsV2FactsWithinContract(facts) || !WindowsV2IdentityWithinContract(judgement) ||
      window.title.empty() || window.title.size() > 256)
    return WindowsV2RefusedRow(TargetVerdictKind::kUnresolvable);
  const std::string window_identity =
      Sha256String("computer-window-identity-v1\n" + judgement.app_identity + "\n" +
                   judgement.process_start + "\n" + std::to_string(window.handle));
  return "{\"kind\":\"" + std::string(TargetVerdictKindName(verdict.kind)) +
         "\",\"windowId\":\"" + std::to_string(window.handle) + "\",\"pid\":" +
         std::to_string(window.pid) + ",\"appIdentityDigest\":\"" + judgement.app_identity +
         "\",\"windowIdentityDigest\":\"" + window_identity + "\",\"executableDigest\":\"" +
         judgement.executable.identity.executable_digest + "\",\"title\":\"" +
         JsonEscape(window.title) + "\",\"bounds\":{\"x\":" + std::to_string(window.client.left) +
         ",\"y\":" + std::to_string(window.client.top) +
         ",\"width\":" + std::to_string(window.client.right - window.client.left) +
         ",\"height\":" + std::to_string(window.client.bottom - window.client.top) +
         "},\"screenBounds\":" + RectJson(window.screen) +
         ",\"boundsUnit\":\"physical_px\",\"maximumMode\":\"" +
         std::string(verdict.maximum_mode) + "\",\"identity\":" +
         WindowsV2IdentityJson(judgement, verdict.maximum_mode) +
         ",\"facts\":" + WindowsV2TargetFactsJson(facts) + "}";
}

// The refused rows: the kind only.
constexpr std::string_view kWindowsV2DeniedRow = "{\"kind\":\"denied\"}";
constexpr std::string_view kWindowsV2UnresolvableRow = "{\"kind\":\"unresolvable\"}";

std::string WindowsV2RefusedRow(sprint_coder::computer_use::TargetVerdictKind kind) {
  return std::string(kind == sprint_coder::computer_use::TargetVerdictKind::kDenied
                         ? kWindowsV2DeniedRow
                         : kWindowsV2UnresolvableRow);
}

BOOL CALLBACK CollectWindowsV2TopLevel(HWND window, LPARAM parameter) {
  auto *windows = reinterpret_cast<std::vector<HWND> *>(parameter);
  // An owned window (a dialog) is reached through its owner's session, never listed on its own.
  if (windows != nullptr && IsWindowVisible(window) && GetWindow(window, GW_OWNER) == nullptr &&
      IsApplicationWindow(window))
    windows->push_back(window);
  return TRUE;
}

// Each row is counted whole, as it is sent: its key names, quotes, commas, numbers, the escaped
// title and every field of its identity.
// The bytes the list_targets envelope around its rows takes ({"generation":N,"rulesetVersion":N,
// "truncated":false,"targets":[ and ]}), with room to spare: the rows get the rest of one frame's
// metadata. A response over kMaxMetadataBytes could not be framed (EncodeFrame answers nothing), the
// write would fail and the pipe would close, ending every session of this helper with the list.
inline constexpr std::size_t kWindowsListTargetsEnvelopeBytes = 256;
inline constexpr std::size_t kWindowsListTargetsRowBytes =
    kMaxMetadataBytes - kWindowsListTargetsEnvelopeBytes;

// The rows of one list_targets, bounded by count (kWindowsListTargetsRowLimit) and by bytes (the
// joined rows, commas included, within the byte limit). A row is counted as it is sent: already
// escaped (JsonEscape writes a control character as six bytes, \u00XX), so the bound is of the
// bytes on the wire, not of the raw title or path. A row that does not fit is not added, and
// no row after it is either: the list is truncated there. A single row larger than the limit (an
// executable path of tens of kilobytes) is never sent.
class WindowsV2ListRows {
public:
  explicit WindowsV2ListRows(std::size_t byte_limit) : byte_limit_(byte_limit) {}

  void push_back(const std::string &row) {
    if (Full())
      return;
    const std::size_t added = row.size() + (count_ == 0 ? 0 : 1);
    if (joined_.size() + added > byte_limit_) {
      truncated_ = true;
      return;
    }
    if (count_ != 0)
      joined_.push_back(',');
    joined_ += row;
    ++count_;
  }
  [[nodiscard]] bool Full() const {
    return truncated_ || count_ >= kWindowsListTargetsRowLimit;
  }
  [[nodiscard]] bool Truncated() const { return truncated_; }
  [[nodiscard]] std::size_t size() const { return count_; }
  [[nodiscard]] const std::string &Joined() const { return joined_; }

private:
  std::size_t byte_limit_;
  std::string joined_;
  std::size_t count_ = 0;
  bool truncated_ = false;
};

std::string WindowsV2ListResponse(std::uint64_t generation, std::uint32_t ruleset_version,
                                  bool truncated, const WindowsV2ListRows &rows) {
  return "{\"generation\":" + std::to_string(generation) +
         ",\"rulesetVersion\":" + std::to_string(ruleset_version) +
         ",\"truncated\":" + (truncated ? "true" : "false") + ",\"targets\":[" + rows.Joined() +
         "]}";
}

// The last check of a list_targets answer (the rows are bounded above; this is the belt). An answer
// that could not be framed is never handed on: false, with a reason, so HandlePipeRequest answers with
// its small error frame (ErrorPayload) and the pipe and every session on it stay up.
// The generation advances only with an answer that is sent: a refused list leaves the previous one
// the latest, so a token minted from it can still start. The reason is a fixed short code.
bool FinishWindowsV2ListResponse(std::string built, std::uint64_t generation,
                                 std::string *response, std::string *reason) {
  if (built.empty() || built.size() > kMaxMetadataBytes) {
    response->clear();
    *reason = "list_targets_unavailable";
    return false;
  }
  *response = std::move(built);
  // Taken here, after the size check, as the answer is handed to the dispatcher. If its WriteFrame
  // then fails, the pipe is lost and Main restarts the helper (a new helper starts from a fresh
  // random generation and no session; Main must discard this helper's tokens). On this helper,
  // a new session named from the list before this one is
  // refused as stale (targetGeneration), and Main must list again. A resume does not read it.
  windows_v2_list_generation = generation;
  return true;
}

// list_targets (ADR v2 section 5.2): every top-level application window, judged per process, at most
// kWindowsListTargetsRowLimit rows and kWindowsListTargetsRowBytes bytes of rows, within
// kWindowsListTargetsBudgetMs.
struct WindowsTargetListPending {
  std::mutex mutex;
  std::condition_variable ready;
  std::atomic<bool> abandoned{false};
  ScopedKernelHandle thread;
  bool done = false;
  bool succeeded = false;
  bool context_ready = false;
  bool enumerated = false;
  std::size_t remaining = 0;
  WindowsV2ListRows progress{kWindowsListTargetsRowBytes};
  std::string response;
  std::string reason = "list_targets_unavailable";
};

// Called only by the consumer, with stop_mutex held. A context that finished after an earlier
// response deadline is a candidate, not an active cache: only this new explicit request adopts it.
void AdoptWindowsV2ContextCandidate(std::uint64_t expected_stop) {
  auto &control = WindowsTargetListControl();
  if (control.running.load(std::memory_order_acquire) || !control.context_candidate)
    return;
  if (control.context_stop_serial == expected_stop &&
      control.stop_serial.load(std::memory_order_acquire) == expected_stop &&
      !parent_process_dead.load(std::memory_order_acquire) &&
      control.context_candidate->lineage_root_pid == windows_v2_main_pid &&
      !WindowsV2FactsContextCache().has_value())
    WindowsV2FactsContextCache() = *control.context_candidate;
  control.context_candidate.reset();
}

bool MeasureWindowsV2TargetList(std::uint64_t generation, std::uint64_t expected_stop,
                                const std::function<bool()> &still_valid,
                                const std::function<bool()> &context_valid,
                                WindowsTargetListPending *pending,
                                std::string *response, std::string *reason) {
  using namespace sprint_coder::computer_use;
  // Without Main's pid there is no lineage root: nothing is enumerated or measured.
  if (windows_v2_main_pid == 0 || !context_valid()) return false;
  const auto &cached = WindowsV2FactsContextCache();
  const bool had_cached_context = cached.has_value();
  WindowsTargetFactsContext context = had_cached_context ? *cached : CurrentWindowsTargetFactsContext(
      windows_v2_main_pid, WindowsV2SelfSignerThumbprint(), /*acceptance_mode=*/false, context_valid);
  if (context.lineage_root_pid == 0) {
    *reason = "list_targets_unavailable";
    return false;
  }
  if (!had_cached_context) {
    auto candidate = std::make_shared<const WindowsTargetFactsContext>(context);
    auto &control = WindowsTargetListControl();
    std::lock_guard stop_lock(control.stop_mutex);
    if (!context_valid()) return false;
    control.context_candidate = std::move(candidate);
    control.context_stop_serial = expected_stop;
  }
  {
    std::lock_guard lock(pending->mutex);
    pending->context_ready = true;
  }
  if (!still_valid()) return false;
  std::vector<HWND> windows;
  if (EnumWindows(CollectWindowsV2TopLevel, reinterpret_cast<LPARAM>(&windows)) != TRUE) {
    *reason = "process_enumeration_unavailable";
    return false;
  }
  // One judgement per process; a measurement that missed the budget has no selectable row.
  std::unordered_map<std::uint32_t, std::optional<std::shared_ptr<WindowsV2Judgement>>> judged;
  WindowsV2ListRows rows(kWindowsListTargetsRowBytes);
  bool truncated = false;
  std::size_t remaining = windows.size();
  const auto publish = [&] {
    std::lock_guard lock(pending->mutex);
    if (pending->abandoned.load(std::memory_order_acquire)) return;
    pending->progress = rows;
    pending->remaining = remaining;
    pending->enumerated = true;
  };
  for (std::size_t index = 0; index < windows.size(); ++index) {
    remaining = windows.size() - index;
    publish();
    if (!still_valid()) return false;
    const HWND window = windows[index];
    if (rows.Full()) {
      truncated = true;
      break;
    }
    DWORD owner = 0;
    if (GetWindowThreadProcessId(window, &owner) == 0 || owner == 0 ||
        owner == GetCurrentProcessId())
      continue;
    // The process's facts are measured once, without a window (the first window listed decides
    // nothing about the others); each window is then judged with its own class.
    auto found = judged.find(owner);
    if (found == judged.end()) {
      std::optional<std::shared_ptr<WindowsV2Judgement>> entry;
      if (still_valid()) {
        auto judgement = std::make_shared<WindowsV2Judgement>();
        MeasureWindowsV2Process(owner, context, judgement.get());
        if (still_valid())
          entry = std::move(judgement);
      }
      found = judged.emplace(owner, std::move(entry)).first;
    }
    if (!found->second.has_value()) {
      rows.push_back(WindowsV2RefusedRow(TargetVerdictKind::kUnresolvable));
      continue;
    }
    if (!still_valid()) return false;
    WindowsV2Judgement &judgement = **found->second;
    // This window's own verdict and mode. A window whose class cannot be read (it was destroyed
    // after it was listed) is unresolvable on its own; it does not touch its process's others.
    TargetFacts window_facts;
    const TargetVerdict verdict =
        WindowsV2VerdictForWindowClass(&judgement, WindowsTargetWindowClass(window, owner),
                                       &window_facts);
    if (!still_valid()) return false;
    RECT client{};
    RECT screen{};
    if (!(verdict.kind == TargetVerdictKind::kEligible ||
          verdict.kind == TargetVerdictKind::kUpper)) {
      rows.push_back(WindowsV2RefusedRow(verdict.kind == TargetVerdictKind::kUnresolvable
                                             ? TargetVerdictKind::kUnresolvable
                                             : TargetVerdictKind::kDenied));
      continue;
    }
    if (IsWindowEnabled(window) != TRUE || !ClientBoundsPhysical(window, &client) ||
        !ScreenBoundsPhysicalForWindow(window, &screen)) {
      rows.push_back(WindowsV2RefusedRow(TargetVerdictKind::kUnresolvable));
      continue;
    }
    std::vector<wchar_t> title(513, L'\0');
    const int title_length = GetWindowTextW(window, title.data(), static_cast<int>(title.size()));
    std::string title_utf8 = BoundedUtf8(
        title_length > 0 ? Utf8FromWide(std::wstring_view(title.data(), title_length))
                         : "Application window",
        256);
    if (title_utf8.empty())
      title_utf8 = "Application window";
    // The row: built by WindowsV2SelectableRow, which sends this window alone as unresolvable when a
    // fact or an identity string is outside what Main takes; the rest of the list stands.
    WindowsV2RowWindow row_window;
    row_window.handle = static_cast<std::uint64_t>(reinterpret_cast<UINT_PTR>(window));
    row_window.pid = owner;
    row_window.title = std::move(title_utf8);
    row_window.client = client;
    row_window.screen = screen;
    if (!still_valid()) return false;
    rows.push_back(WindowsV2SelectableRow(judgement, verdict, window_facts, row_window));
  }
  if (!truncated) remaining = 0;
  publish();
  if (!still_valid()) return false;
  *response = WindowsV2ListResponse(generation, DenyRulesetVersion(TargetPlatform::kWin32),
                                    truncated || rows.Truncated(), rows);
  return true;
}

bool ListWindowsTargets(std::string *response, std::string *reason,
                        std::optional<std::uint64_t> queued_stop_serial = std::nullopt) {
  if constexpr (!sprint_coder::computer_use::kNativeEligibilityIsV2) {
    (void)response;
    *reason = "unsupported_operation";
    return false;
  } else {
    *reason = "list_targets_unavailable";
    auto &control = WindowsTargetListControl();
    const std::uint64_t expected_stop = queued_stop_serial.value_or(
        control.stop_serial.load(std::memory_order_acquire));
    {
      std::lock_guard stop_lock(control.stop_mutex);
      AdoptWindowsV2ContextCandidate(expected_stop);
    }
    const ULONGLONG deadline = GetTickCount64() + kWindowsListTargetsBudgetMs;
    const std::uint64_t generation = windows_v2_list_generation + 1;
    auto pending = std::make_shared<WindowsTargetListPending>();
    const auto context_valid = [expected_stop] {
      return !parent_process_dead.load(std::memory_order_acquire) &&
             WindowsTargetListControl().stop_serial.load(std::memory_order_acquire) == expected_stop;
    };
    const auto still_valid = [pending, context_valid, deadline] {
      return !pending->abandoned.load(std::memory_order_acquire) && context_valid() &&
             GetTickCount64() < deadline;
    };
    if (!still_valid() || control.running.exchange(true, std::memory_order_acq_rel))
      return false;
    try {
      std::thread([pending, still_valid, context_valid, expected_stop, generation] {
        bool succeeded = false;
        std::string built;
        std::string failure = "list_targets_unavailable";
        try {
          struct Apartment {
            HRESULT result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
            ~Apartment() { if (SUCCEEDED(result)) CoUninitialize(); }
          } apartment;
          HANDLE self = nullptr;
          if (SUCCEEDED(apartment.result) &&
              DuplicateHandle(GetCurrentProcess(), GetCurrentThread(), GetCurrentProcess(), &self,
                              0, FALSE, DUPLICATE_SAME_ACCESS)) {
            {
              std::lock_guard lock(pending->mutex);
              pending->thread.value = self;
            }
            if (context_valid())
              succeeded = MeasureWindowsV2TargetList(generation, expected_stop, still_valid, context_valid,
                                                    pending.get(), &built, &failure);
          }
        } catch (...) {
          succeeded = false;
        }
        // All measured handles and COM objects are gone before the slot becomes available.
        {
          std::lock_guard lock(pending->mutex);
          if (still_valid()) {
            pending->succeeded = succeeded;
            pending->response = std::move(built);
            pending->reason = std::move(failure);
          }
          pending->done = true;
          WindowsTargetListWorkerRunning().store(false, std::memory_order_release);
        }
        pending->ready.notify_one();
      }).detach();
    } catch (...) {
      control.running.store(false, std::memory_order_release);
      return false;
    }
    std::unique_lock lock(pending->mutex);
    while (!pending->done && still_valid())
      pending->ready.wait_for(lock, std::chrono::milliseconds(20));
    // Stop and adoption share this lock; a late result cannot advance the generation.
    std::lock_guard stop_lock(control.stop_mutex);
    if (!still_valid()) {
      pending->abandoned.store(true, std::memory_order_release);
      // A response deadline does not cancel cold context initialization. It may finish off-lane
      // and supply one pure candidate to the next explicit request. Stop always cancels it.
      if (pending->thread.value != nullptr && (!context_valid() || pending->context_ready))
        CancelSynchronousIo(pending->thread.value);
      if (!context_valid() || !pending->enumerated)
        return false;
      // Keep complete rows. The unfinished windows reveal only their anonymous refusal kind.
      WindowsV2ListRows partial = pending->progress;
      for (std::size_t index = 0; index < pending->remaining && !partial.Full(); ++index)
        partial.push_back(WindowsV2RefusedRow(sprint_coder::computer_use::TargetVerdictKind::kUnresolvable));
      if (!FinishWindowsV2ListResponse(
          WindowsV2ListResponse(generation,
              sprint_coder::computer_use::DenyRulesetVersion(sprint_coder::computer_use::TargetPlatform::kWin32),
              /*truncated=*/true, partial), generation, response, reason))
        return false;
      AdoptWindowsV2ContextCandidate(expected_stop);
      return true;
    }
    if (!pending->succeeded) {
      *reason = pending->reason;
      return false;
    }
    if (!FinishWindowsV2ListResponse(std::move(pending->response), generation, response, reason))
      return false;
    AdoptWindowsV2ContextCandidate(expected_stop);
    return true;
  }
}

// BEGIN windows v2 rejudge (#940)
// Defined alongside the frame scope below. Only the value is copied to the worker.
std::uint64_t WindowsValidationFrameStopSerial();

struct WindowsV2RejudgeResult {
  bool matches = false;
  bool not_web = false;
  std::optional<WindowsTargetFactsContext> context;
};

struct WindowsV2RejudgePending {
  std::mutex mutex;
  std::condition_variable ready;
  std::atomic<bool> abandoned{false};
  std::uint64_t job_id = 0;
  bool done = false;
  WindowsV2RejudgeResult result;
};

struct WindowsV2RejudgeWork {
  std::uint32_t pid = 0;
  HWND window = nullptr;
  std::string maximum_mode;
  std::string app_identity;
  std::string process_start;
  std::optional<sprint_coder::computer_use::WindowsFileKey> not_web_file;
  std::optional<WindowsTargetFactsContext> context;
  std::uint32_t main_pid = 0;
  std::uint64_t epoch = 0;
  std::uint64_t stop_serial = 0;
  ScopedKernelHandle executable;
  std::shared_ptr<WindowsV2RejudgePending> pending;
};

struct WindowsV2RejudgeState {
  std::mutex mutex;
  std::condition_variable wake;
  std::unique_ptr<WindowsV2RejudgeWork> queued;
  std::uint64_t active_job_id = 0;
  std::uint64_t next_job_id = 0;
  HANDLE cancellation_thread = nullptr;
  bool worker_started = false;
};

WindowsV2RejudgeState &WindowsV2RejudgeControl() {
  // An abandoned device call may outlive helper shutdown; never destroy state beneath this reader.
  static auto *state = new WindowsV2RejudgeState;
  return *state;
}

bool WindowsV2RejudgeStillCurrent(std::uint64_t epoch, std::uint64_t stop_serial) {
  return !parent_process_dead.load(std::memory_order_acquire) &&
      cancellation_epoch.load(std::memory_order_acquire) == epoch &&
      WindowsTargetListControl().stop_serial.load(std::memory_order_acquire) == stop_serial;
}

WindowsV2RejudgeResult MeasureWindowsV2Rejudge(const WindowsV2RejudgeWork &work) {
  const auto still_valid = [&] {
    return !work.pending->abandoned.load(std::memory_order_acquire) &&
        WindowsV2RejudgeStillCurrent(work.epoch, work.stop_serial);
  };
  WindowsV2RejudgeResult result;
  if (work.main_pid == 0 || !still_valid()) return result;
  WindowsTargetFactsContext context;
  if (work.context.has_value()) {
    context = *work.context;
  } else {
    // The cold context and signer lookup both stay on this worker, before any target judgement.
    std::string signer = WindowsV2SelfSignerThumbprint();
    if (!still_valid()) return result;
    context = CurrentWindowsTargetFactsContext(work.main_pid, std::move(signer),
                                               /*acceptance_mode=*/false, still_valid);
  }
  if (!still_valid() || context.lineage_root_pid != work.main_pid) return result;
  WindowsV2Judgement judged;
  JudgeWindowsV2Target(work.pid, work.window, context, &judged);
  if (!still_valid()) return result;
  WindowsFileIdentity held{};
  result.matches = judged.Selectable() && std::string(judged.verdict.maximum_mode) == work.maximum_mode &&
      judged.app_identity == work.app_identity && judged.process_start == work.process_start &&
      still_valid() && ReadWindowsFileIdentity(work.executable.value, &held) &&
      judged.measured.file_identity.has_value() &&
      SameWindowsFileIdentity(held, *judged.measured.file_identity);
  if (!still_valid()) return WindowsV2RejudgeResult{};
  if (result.matches)
    result.not_web = sprint_coder::computer_use::WindowsTargetIsNotWebByTable(
        judged.measured.facts, judged.held_key, judged.table_key, work.not_web_file,
        /*session_recorded=*/true);
  // As before, a completed cold context can survive a target refusal. An exception or Stop never
  // supplies a candidate, and only the consumer may turn this pure value into the active cache.
  if (!work.context.has_value()) result.context = std::move(context);
  return result;
}

void CancelWindowsV2RejudgeJob(std::uint64_t job_id) {
  auto &state = WindowsV2RejudgeControl();
  std::lock_guard lock(state.mutex);
  if (state.active_job_id == job_id && job_id != 0 && state.cancellation_thread != nullptr)
    CancelSynchronousIo(state.cancellation_thread);
}

void WindowsV2RejudgeWorkerLoop(WindowsV2RejudgeState *state) {
  ScopedKernelHandle thread;
  const bool thread_ready =
      DuplicateHandle(GetCurrentProcess(), GetCurrentThread(), GetCurrentProcess(), &thread.value,
                      0, FALSE, DUPLICATE_SAME_ACCESS) &&
      thread.value != nullptr && thread.value != INVALID_HANDLE_VALUE;
  for (;;) {
    std::unique_ptr<WindowsV2RejudgeWork> work;
    {
      std::unique_lock lock(state->mutex);
      state->wake.wait(lock, [&] { return state->queued != nullptr; });
      work = std::move(state->queued);
      state->cancellation_thread = thread_ready ? thread.value : nullptr;
    }
    const auto pending = work->pending;
    const std::uint64_t job_id = pending->job_id;
    WindowsV2RejudgeResult result;
    try {
      // Package facts use WinRT/COM. Each job ends its apartment after its judgement and temporary
      // handles have been destroyed, before releasing the shared measurement slot.
      struct Apartment {
        HRESULT result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
        ~Apartment() { if (SUCCEEDED(result)) CoUninitialize(); }
      } apartment;
      if (thread_ready && SUCCEEDED(apartment.result)) result = MeasureWindowsV2Rejudge(*work);
    } catch (...) {
      result = {};
    }
    // Close the owned executable duplicate on this worker, even if the original session is gone.
    work.reset();
    {
      std::lock_guard lock(state->mutex);
      if (state->active_job_id == job_id) {
        state->cancellation_thread = nullptr;
        state->active_job_id = 0;
        WindowsTargetListWorkerRunning().store(false, std::memory_order_release);
      }
    }
    // Rejudge job retirement precedes result publication. No old job may touch a new job's slot.
    {
      std::lock_guard lock(pending->mutex);
      if (!pending->abandoned.load(std::memory_order_acquire)) pending->result = std::move(result);
      pending->done = true;
    }
    pending->ready.notify_one();
  }
}

struct WindowsV2RejudgeSubmission {
  std::unique_ptr<WindowsV2RejudgeWork> work;
  bool claimed = false;
  ~WindowsV2RejudgeSubmission() {
    if (!claimed) return;
    // The job was never handed off; the original session still lives on this consumer.
    work.reset();
    WindowsTargetListWorkerRunning().store(false, std::memory_order_release);
  }
};

struct WindowsV2RejudgeWaitGuard {
  std::shared_ptr<WindowsV2RejudgePending> pending;
  ~WindowsV2RejudgeWaitGuard() {
    std::lock_guard lock(pending->mutex);
    if (pending->done) return;
    pending->abandoned.store(true, std::memory_order_release);
    // pending -> state, while the worker releases state before taking pending.
    CancelWindowsV2RejudgeJob(pending->job_id);
  }
};

// What a v2 session's start (or resume) and every input re-judge: the target is still selectable,
// with the mode, the application identity (the package digest for a package), the process start and
// the held running image the session was bound to. `not_web` is the explicit table's answer for this
// judgement: the session's recorded System32 notepad file, still the very file it was.
bool RejudgeWindowsV2Session(const WindowsSession &session, std::optional<bool> *not_web,
                             std::string *reason) {
  *reason = "session_identity_changed";
  if (WindowsTargetListWorkerRunning().load(std::memory_order_acquire) || windows_v2_main_pid == 0)
    return false;
  auto pending = std::make_shared<WindowsV2RejudgePending>();
  WindowsV2RejudgeSubmission submission;
  submission.work = std::make_unique<WindowsV2RejudgeWork>();
  auto &work = *submission.work;
  work.pid = session.pid;
  work.window = session.window;
  work.maximum_mode = session.maximum_mode;
  work.app_identity = session.app_identity;
  work.process_start = session.process_start;
  work.not_web_file = session.not_web_file;
  work.epoch = session.cancel_epoch;
  work.stop_serial = WindowsValidationFrameStopSerial();
  work.pending = pending;
  const std::uint64_t epoch = work.epoch;
  const std::uint64_t stop_serial = work.stop_serial;
  auto &control = WindowsTargetListControl();
  {
    std::lock_guard stop_lock(control.stop_mutex);
    if (!WindowsV2RejudgeStillCurrent(epoch, stop_serial) ||
        control.running.load(std::memory_order_acquire) || windows_v2_main_pid == 0)
      return false;
    work.main_pid = windows_v2_main_pid;
    work.context = WindowsV2FactsContextCache();
    if (control.running.exchange(true, std::memory_order_acq_rel)) return false;
    submission.claimed = true;
  }
  const std::uint32_t main_pid = work.main_pid;
  if (session.executable_file == INVALID_HANDLE_VALUE ||
      !DuplicateHandle(GetCurrentProcess(), session.executable_file, GetCurrentProcess(), &work.executable.value,
                       0, FALSE, DUPLICATE_SAME_ACCESS))
    return false;
  auto &state = WindowsV2RejudgeControl();
  try {
    std::lock_guard lock(state.mutex);
    if (state.active_job_id != 0 || state.queued != nullptr ||
        state.next_job_id == std::numeric_limits<std::uint64_t>::max())
      return false;
    if (!state.worker_started) {
      std::thread(WindowsV2RejudgeWorkerLoop, &state).detach();
      state.worker_started = true;
    }
    pending->job_id = ++state.next_job_id;
    state.active_job_id = pending->job_id;
    state.queued = std::move(submission.work);
    submission.claimed = false;
  } catch (...) {
    return false;
  }
  state.wake.notify_one();
  WindowsV2RejudgeWaitGuard guard{pending};
  std::unique_lock lock(pending->mutex);
  for (;;) {
    {
      // The value and context are adopted together under pending -> stop, never after Stop.
      std::lock_guard stop_lock(control.stop_mutex);
      if (!WindowsV2RejudgeStillCurrent(epoch, stop_serial) || windows_v2_main_pid != main_pid)
        return false;
      if (pending->done) {
        if (pending->result.context.has_value() &&
            pending->result.context->lineage_root_pid == main_pid && !WindowsV2FactsContextCache().has_value())
          WindowsV2FactsContextCache() = std::move(pending->result.context);
        if (!pending->result.matches) return false;
        if (not_web != nullptr) *not_web = pending->result.not_web;
        reason->clear();
        return true;
      }
    }
    pending->ready.wait_for(lock, std::chrono::milliseconds(20));
  }
}
// END windows v2 rejudge

// Before every input (ValidateWindowsDispatchBinding: the preflight that issues the ticket and the
// dispatch that spends it): a v2 session's target is judged again and the explicit table answers for
// the interlock of the same frame. A v1 session: nothing, as before.
bool JudgeWindowsV2Input(const WindowsSession &session, std::string *reason) {
  session.v2_input_not_web.reset();
  if (session.eligibility_basis != sprint_coder::computer_use::EligibilityBasis::kV2Denylist)
    return true;
  if constexpr (!sprint_coder::computer_use::kNativeEligibilityIsV2) {
    *reason = "eligibility_basis_unsupported";
    return false;
  } else {
    return RejudgeWindowsV2Session(session, &session.v2_input_not_web, reason);
  }
}

// The v2 admission of a start or resume (in place of the V1 allow-list): the ruleset version the
// token was minted under is this build's, a new session names the latest list, and the target is
// judged again now and is the one the token named (identity, executable and, outside a package, the
// signer, and the very file `locked` holds). The mode is the core's. `not_web_file` is the System32
// notepad file the explicit table matched, recorded for the session's life.
bool AdmitWindowsV2StartInContext(
    std::uint32_t pid, HWND window, const LockedWindowsExecutable &locked,
    const WindowsTargetFactsContext &context, std::uint64_t ruleset_version,
    std::uint64_t generation, std::uint64_t expected_generation, bool new_session,
    std::string_view app_identity, std::string_view executable_digest,
    std::string_view signer_digest, std::string *maximum_mode,
    std::optional<sprint_coder::computer_use::WindowsFileKey> *not_web_file) {
  using namespace sprint_coder::computer_use;
  if (context.lineage_root_pid == 0 || ruleset_version == 0 ||
      ruleset_version != DenyRulesetVersion(TargetPlatform::kWin32) ||
      (new_session && (generation == 0 || generation != expected_generation)))
    return false;
  WindowsV2Judgement judged;
  JudgeWindowsV2Target(pid, window, context, &judged);
  if (!judged.Selectable() || judged.app_identity != app_identity ||
      judged.executable.identity.executable_digest != executable_digest ||
      !SameWindowsFileIdentity(judged.executable.identity.file_identity,
                               locked.identity.file_identity) ||
      !SameWindowsTargetName(judged.executable.identity.path, locked.identity.path))
    return false;
  // A package's identity rests on the package, not on an embedded signer (its JSON says null).
  if (!judged.package.has_value() &&
      (signer_digest.empty() ? !judged.executable.identity.signer_digest.empty()
                             : judged.executable.identity.signer_digest != signer_digest))
    return false;
  *maximum_mode = std::string(judged.verdict.maximum_mode);
  *not_web_file = WindowsTargetIsNotWebByTable(judged.measured.facts, judged.held_key,
                                               judged.table_key, std::nullopt,
                                               /*session_recorded=*/false)
                      ? judged.held_key
                      : std::nullopt;
  return true;
}

bool AdmitWindowsV2Start(std::uint32_t pid, HWND window, const LockedWindowsExecutable &locked,
                         const std::string &metadata, bool new_session,
                         std::string_view app_identity, std::string_view executable_digest,
                         std::string_view signer_digest, std::string *maximum_mode,
                         std::optional<sprint_coder::computer_use::WindowsFileKey> *not_web_file) {
  // The synchronous resume entry retains its I/O guard. A new-start worker uses only its context
  // snapshot through AdmitWindowsV2StartInContext, never the consumer's mutable cache.
  if (WindowsTargetListWorkerRunning().load(std::memory_order_acquire) ||
      WindowsV2FactsContext().lineage_root_pid == 0)
    return false;
  std::uint64_t ruleset_version = 0;
  std::uint64_t generation = 0;
  if (!ReadJsonUint64(metadata, "denyRulesetVersion", &ruleset_version) ||
      (new_session && !ReadJsonUint64(metadata, "targetGeneration", &generation)))
    return false;
  return AdmitWindowsV2StartInContext(pid, window, locked, WindowsV2FactsContext(),
      ruleset_version, generation, windows_v2_list_generation, new_session,
      app_identity, executable_digest, signer_digest, maximum_mode, not_web_file);
}
// BEGIN windows shared new start
struct WindowsStartInput {
  sprint_coder::computer_use::EligibilityBasis eligibility_basis =
      sprint_coder::computer_use::EligibilityBasis::kV2Denylist;
  std::shared_ptr<WindowsStartLease> start_lease;
  std::uint32_t pid = 0;
  HWND window = nullptr;
  std::uint64_t window_value = 0;
  std::string session_key;
  std::string session_id;
  std::string app_identity;
  std::string expected_window_identity;
  std::wstring canonical_path;
  std::string executable_digest;
  std::string signer_digest;
  double bounds_x = 0;
  double bounds_y = 0;
  double bounds_width = 0;
  double bounds_height = 0;
  bool explicit_resume = false;
  std::uint64_t cancel_epoch = 0;
  std::uint64_t profile_revision = 0;
  std::uint64_t ruleset_version = 0;
  std::uint64_t requested_generation = 0;
  std::uint64_t generation = 0;
  std::uint64_t stop_serial = 0;
  std::uint64_t initial_epoch = 0;
  std::uint32_t main_pid = 0;
  std::optional<WindowsTargetFactsContext> context;
};

struct WindowsNewStartMeasurement {
  WindowsExecutableIdentity executable;
  std::string process_start;
  std::string window_identity;
  std::string maximum_mode;
  std::optional<sprint_coder::computer_use::WindowsFileKey> not_web_file;
  std::optional<WindowsTargetFactsContext> context;
  std::string reason = "session_target_rejected";
};

enum class WindowsNewStartDecision { kWaiting, kAdopt, kDrop };

struct WindowsNewStartPending {
  std::mutex mutex;
  std::condition_variable changed;
  std::atomic<bool> abandoned{false};
  bool ready = false;
  bool succeeded = false;
  WindowsNewStartDecision decision = WindowsNewStartDecision::kWaiting;
  WindowsNewStartMeasurement measured;
  // Aliases only: the worker's RAII owners retain these until adoption. Destroying pending on the
  // consumer must never bring a potentially blocking handle close back onto its lane.
  HANDLE thread = nullptr;
  HANDLE process = nullptr;
  HANDLE executable = INVALID_HANDLE_VALUE;
};

// BEGIN windows v1 new-start eligibility
bool MeasureWindowsV1NewStartEligibility(const WindowsStartInput &input,
                                        const LockedWindowsExecutable &executable,
                                        WindowsNewStartMeasurement *measured) {
  if (!WindowsExecutableIdentityMatches(executable.identity, input.app_identity,
                                        input.executable_digest, input.signer_digest) ||
      !IsSupportedWindowsV1Target(executable.identity)) return false;
  measured->maximum_mode = MaximumModeForWindowsExecutable(executable.identity);
  return true;
}
// END windows v1 new-start eligibility

bool MeasureWindowsNewStart(const WindowsStartInput &input,
                              const std::function<bool()> &still_valid,
                              ScopedKernelHandle *target_process,
                              LockedWindowsExecutable *process_executable,
                              WindowsNewStartMeasurement *measured) {
  const bool v2 = input.eligibility_basis == sprint_coder::computer_use::EligibilityBasis::kV2Denylist;
  if (!still_valid() || (v2 && input.main_pid == 0)) return false;
  target_process->value = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, input.pid);
  if (target_process->value == nullptr || !still_valid() ||
      !OpenLockedProcessExecutable(target_process->value, process_executable) ||
      !still_valid() || !SameWindowsPath(process_executable->identity.path, input.canonical_path))
    return false;
  std::optional<WindowsTargetFactsContext> context;
  if (v2) {
    context = input.context.has_value() ? *input.context :
        CurrentWindowsTargetFactsContext(input.main_pid, WindowsV2SelfSignerThumbprint(),
                                        /*acceptance_mode=*/false, still_valid);
    if (!still_valid() || context->lineage_root_pid != input.main_pid || !AdmitWindowsV2StartInContext(
            input.pid, input.window, *process_executable, *context, input.ruleset_version,
            input.requested_generation, input.generation, /*new_session=*/true,
            input.app_identity, input.executable_digest, input.signer_digest,
            &measured->maximum_mode, &measured->not_web_file)) return false;
  } else if (!MeasureWindowsV1NewStartEligibility(input, *process_executable, measured)) {
    return false;
  }
  if (!still_valid() || IsKnownProxyExecutable(process_executable->identity.path) ||
      IsDisallowedTargetExecutable(process_executable->identity.path) ||
      IsProcessElevated(input.pid) || !still_valid() ||
      !ReadProcessStartIdentity(target_process->value, &measured->process_start) ||
      !still_valid() || WaitForSingleObject(target_process->value, 0) != WAIT_TIMEOUT ||
      !IsWindow(input.window) || !IsApplicationWindow(input.window))
    return false;
  measured->window_identity = Sha256String("computer-window-identity-v1\n" + input.app_identity + "\n" +
                                           measured->process_start + "\n" + std::to_string(input.window_value));
  if (measured->window_identity != input.expected_window_identity) {
    measured->reason = "window_identity_changed";
    return false;
  }
  measured->executable = process_executable->identity;
  if (v2 && !input.context.has_value()) measured->context = std::move(context);
  return still_valid();
}

// Stops the worker on every consumer exit, including an allocation failure while preparing the
// response/session. Adoption is the only path that transfers its handles and releases its slot here.
struct WindowsNewStartWaitGuard {
  std::shared_ptr<WindowsNewStartPending> pending;
  ~WindowsNewStartWaitGuard() {
    {
      std::lock_guard lock(pending->mutex);
      if (pending->decision == WindowsNewStartDecision::kAdopt) return;
      pending->abandoned.store(true, std::memory_order_release);
      pending->decision = WindowsNewStartDecision::kDrop;
      if (pending->thread != nullptr) CancelSynchronousIo(pending->thread);
    }
    pending->changed.notify_one();
  }
};

bool StartWindowsNewSession(WindowsStartInput input, std::string *response, std::string *reason) {
  *reason = "session_target_rejected";
  auto &control = WindowsTargetListControl();
  const bool v2 = input.eligibility_basis == sprint_coder::computer_use::EligibilityBasis::kV2Denylist;
  auto pending = std::make_shared<WindowsNewStartPending>();
  const auto start_valid = [&] {
    const std::uint64_t epoch = cancellation_epoch.load(std::memory_order_acquire);
    return !parent_process_dead.load(std::memory_order_acquire) &&
        (!input.start_lease || !input.start_lease->owner->stopped.load(std::memory_order_acquire)) &&
        control.stop_serial.load(std::memory_order_acquire) == input.stop_serial &&
        (!v2 || windows_v2_list_generation == input.generation) && !sessions.contains(input.session_key) &&
        (epoch <= last_closed_cancel_epoch || input.cancel_epoch >= epoch);
  };
  {
    std::lock_guard stop_lock(control.stop_mutex);
    if (v2) input.generation = windows_v2_list_generation;
    if (!start_valid()) {
      *reason = "session_start_canceled";
      return false;
    }
    if (control.running.load(std::memory_order_acquire)) return false;
    if (v2) {
      AdoptWindowsV2ContextCandidate(input.stop_serial);
      input.context = WindowsV2FactsContextCache();
      input.main_pid = windows_v2_main_pid;
    }
    input.initial_epoch = cancellation_epoch.load(std::memory_order_acquire);
    if (control.running.exchange(true, std::memory_order_acq_rel)) return false;
  }
  WindowsNewStartWaitGuard lease{pending};
  try {
    std::thread([pending, input]() mutable {
      bool adopted = false;
      {
        ScopedKernelHandle target_process;
        LockedWindowsExecutable process_executable;
        WindowsNewStartMeasurement measured;
        bool succeeded = false;
        const auto still_valid = [&] {
          return !pending->abandoned.load(std::memory_order_acquire) &&
              (!input.start_lease || !input.start_lease->owner->stopped.load(std::memory_order_acquire)) &&
              !parent_process_dead.load(std::memory_order_acquire) &&
              WindowsTargetListControl().stop_serial.load(std::memory_order_acquire) == input.stop_serial &&
              cancellation_epoch.load(std::memory_order_acquire) == input.initial_epoch;
        };
        {
          ScopedKernelHandle thread;
          try {
            struct Apartment {
              HRESULT result;
              bool initialized;
              explicit Apartment(bool needed)
                  : result(needed ? CoInitializeEx(nullptr, COINIT_MULTITHREADED) : S_OK),
                    initialized(needed && SUCCEEDED(result)) {}
              ~Apartment() { if (initialized) CoUninitialize(); }
            } apartment(input.eligibility_basis == sprint_coder::computer_use::EligibilityBasis::kV2Denylist);
            if (SUCCEEDED(apartment.result) && still_valid() &&
                DuplicateHandle(GetCurrentProcess(), GetCurrentThread(), GetCurrentProcess(), &thread.value,
                                0, FALSE, DUPLICATE_SAME_ACCESS)) {
              {
                std::lock_guard lock(pending->mutex);
                pending->thread = thread.value;
              }
              succeeded = MeasureWindowsNewStart(input, still_valid, &target_process,
                                                   &process_executable, &measured);
            }
          } catch (...) {
            succeeded = false;
          }
          // The COM apartment and temporary judgement are already gone; withdraw the cancellable
          // thread alias before closing its duplicate, and before publishing ready.
          std::lock_guard lock(pending->mutex);
          pending->thread = nullptr;
        }
        {
          std::unique_lock lock(pending->mutex);
          if (succeeded && still_valid()) {
            pending->measured = std::move(measured);
            pending->process = target_process.value;
            pending->executable = process_executable.file;
            pending->succeeded = true;
            pending->ready = true;
            pending->changed.notify_one();
            pending->changed.wait(lock, [&] { return pending->decision != WindowsNewStartDecision::kWaiting; });
            adopted = pending->decision == WindowsNewStartDecision::kAdopt;
            if (adopted) {
              target_process.release();
              process_executable.file = INVALID_HANDLE_VALUE;
            }
            pending->process = nullptr;
            pending->executable = INVALID_HANDLE_VALUE;
          } else {
            pending->measured.reason = std::move(measured.reason);
          }
        }
      }
      if (adopted) {
        // Adopted handles belong to the session; this worker must not release the shared slot.
        return;
      }
      // Rejected candidates are closed on this worker before another measurement can begin.
      input.start_lease.reset();
      {
        std::lock_guard lock(pending->mutex);
        pending->ready = true;
        WindowsTargetListWorkerRunning().store(false, std::memory_order_release);
      }
      pending->changed.notify_one();
    }).detach();
  } catch (...) {
    control.running.store(false, std::memory_order_release);
    return false;
  }
  {
    std::unique_lock lock(pending->mutex);
    while (!pending->ready && start_valid())
      pending->changed.wait_for(lock, std::chrono::milliseconds(20));
    if (!start_valid()) {
      *reason = "session_start_canceled";
      return false;
    }
    if (!pending->succeeded) {
      *reason = pending->measured.reason;
      return false;
    }
  }
  // The measured candidate is ready; focus still belongs to the consumer.
  {
    std::lock_guard stop_lock(control.stop_mutex);
    if (!start_valid()) {
      *reason = "session_start_canceled";
      return false;
    }
  }
  const auto &measured = pending->measured;
  InvalidateWindowsTicket(input.session_key);
  if (!sessions.empty()) {
    *reason = "session_limit";
    return false;
  }
  if (v2 && input.explicit_resume) {
    *reason = "session_input_invalid";
    return false;
  }
  const auto geometry_matches = [&](const RECT &bounds) {
    return std::abs(static_cast<double>(bounds.left) - input.bounds_x) <= 1.0 &&
        std::abs(static_cast<double>(bounds.top) - input.bounds_y) <= 1.0 &&
        std::abs(static_cast<double>(bounds.right - bounds.left) - input.bounds_width) <= 1.0 &&
        std::abs(static_cast<double>(bounds.bottom - bounds.top) - input.bounds_height) <= 1.0;
  };
  RECT physical_client{};
  if (!ClientBoundsPhysical(input.window, &physical_client) || !geometry_matches(physical_client)) {
    *reason = "window_geometry_changed";
    return false;
  }
  if (!v2) {
    std::lock_guard stop_lock(control.stop_mutex);
    if (!start_valid()) { *reason = "session_start_canceled"; return false; }
    if (input.explicit_resume) { *reason = "session_input_invalid"; return false; }
  }
  const HWND foreground = GetForegroundWindow();
  if (IsWindowEnabled(input.window) != TRUE || foreground == nullptr ||
      (foreground != input.window && IsNativeTakeoverWindow(foreground))) {
    *reason = "native_dialog_user_takeover";
    return false;
  }
  WindowsSession session;
  if (input.start_lease) {
    session.start_owner = input.start_lease->owner;
    session.input_api_attempts = input.start_lease->owner->input_api_attempts;
  }
  const auto begin_focus = [&] {
    std::lock_guard stop_lock(control.stop_mutex);
    if (!start_valid()) {
      *reason = "session_start_canceled";
      return false;
    }
    session.input_api_attempts->fetch_add(1, std::memory_order_acq_rel);
    return true;
  };
  if (GetForegroundWindow() != input.window) {
    if (IsIconic(input.window)) {
      if (!begin_focus()) return false;
      ShowWindow(input.window, SW_RESTORE);
    }
    if (!begin_focus()) return false;
    SetForegroundWindow(input.window);
  }
  RECT bounds{};
  RECT screen_bounds{};
  if (!TargetWindowFacts(input.pid, input.window, &bounds)) {
    *reason = "focus_required";
    return false;
  }
  if (v2 && !geometry_matches(bounds)) {
    *reason = "window_geometry_changed";
    return false;
  }
  if (!ScreenBoundsPhysicalForWindow(input.window, &screen_bounds)) {
    *reason = "screen_geometry_unavailable";
    return false;
  }
  session.session_id = input.session_id;
  session.pid = input.pid;
  session.window = input.window;
  session.active_window = input.window;
  session.app_identity = input.app_identity;
  session.window_identity = measured.window_identity;
  session.active_window_identity = measured.window_identity;
  session.process_start = measured.process_start;
  session.canonical_path = measured.executable.path;
  session.executable_volume_serial = measured.executable.file_identity.volume_serial;
  session.executable_file_id = measured.executable.file_identity.file_id;
  session.executable_digest = measured.executable.executable_digest;
  session.signer_digest = measured.executable.signer_digest;
  session.policy_language = measured.executable.policy_language;
  session.maximum_mode = measured.maximum_mode;
  session.eligibility_basis = input.eligibility_basis;
  session.not_web_file = measured.not_web_file;
  std::uint64_t effective_epoch = std::max(input.cancel_epoch, cancellation_epoch.load(std::memory_order_acquire));
  const auto build_response = [&](std::uint64_t response_epoch) {
    return "{\"sessionId\":\"" + JsonEscape(input.session_id) +
      "\",\"platform\":\"win32\",\"appIdentityDigest\":\"" + input.app_identity +
      "\",\"windowIdentityDigest\":\"" + measured.window_identity + "\",\"windowId\":\"" +
      std::to_string(input.window_value) + "\",\"policyLanguage\":\"" + measured.executable.policy_language +
      "\",\"maximumMode\":\"" + measured.maximum_mode + "\",\"screenBounds\":" + RectJson(screen_bounds) +
      ",\"profileRevision\":" + std::to_string(input.profile_revision) +
      ",\"cancelEpoch\":" + std::to_string(response_epoch) +
      ",\"inputAttemptCount\":" + std::to_string(session.input_api_attempts->load(std::memory_order_acquire)) +
      ",\"pid\":" + std::to_string(input.pid) + ",\"windowHandle\":\"" + std::to_string(input.window_value) + "\"}";
  };
  std::string built = v2 ? build_response(effective_epoch) : std::string{};
  if (v2 && (WaitForSingleObject(pending->process, 0) != WAIT_TIMEOUT ||
      !IsApplicationWindow(input.window) || !TargetWindowFacts(input.pid, input.window, &bounds) ||
      !geometry_matches(bounds))) {
    *reason = "session_target_rejected";
    return false;
  }
  // Stop and final start adoption share this lock. Window/geometry OS queries stay outside it so
  // their latency cannot prevent the reader from recording Stop.
  {
    std::lock_guard lock(pending->mutex);
    std::lock_guard stop_lock(control.stop_mutex);
    if (!start_valid() || !sessions.empty()) {
      *reason = "session_start_canceled";
      return false;
    }
    // All allocating session/response work precedes the ownership handoff. Cache adoption is also
    // consumer-only, and a late worker cannot install a context after Stop.
    if (v2 && measured.context.has_value() && !WindowsV2FactsContextCache().has_value())
      WindowsV2FactsContextCache() = measured.context;
    std::uint64_t previous_epoch = v2 ? input.initial_epoch : cancellation_epoch.load(std::memory_order_acquire);
    if (!v2) {
      effective_epoch = std::max(previous_epoch, input.cancel_epoch);
      built = build_response(effective_epoch);
    }
    session.cancel_epoch = effective_epoch;
    auto [inserted, fresh] = sessions.emplace(input.session_key, std::move(session));
    if (!fresh) return false;
    if (!cancellation_epoch.compare_exchange_strong(previous_epoch, effective_epoch,
            std::memory_order_acq_rel, std::memory_order_acquire)) {
      sessions.erase(inserted);
      *reason = "session_start_canceled";
      return false;
    }
    inserted->second.process_handle = pending->process;
    inserted->second.executable_file = pending->executable;
    pending->process = nullptr;
    pending->executable = INVALID_HANDLE_VALUE;
    pending->decision = WindowsNewStartDecision::kAdopt;
    control.running.store(false, std::memory_order_release);
    *response = std::move(built);
  }
  pending->changed.notify_one();
  if (!v2) InvalidateWindowsTicket(input.session_key);
  return true;
}

// END windows shared new start

// BEGIN windows shared existing start

enum class WindowsExistingStartPhase { BeforeFocus, AfterFocus };

struct WindowsExistingStartSnapshot {
  std::string session_id;
  std::uint32_t pid = 0;
  HWND window = nullptr;
  std::string app_identity;
  std::string window_identity;
  std::string process_start;
  std::string maximum_mode;
  sprint_coder::computer_use::EligibilityBasis eligibility_basis =
      sprint_coder::computer_use::EligibilityBasis::kV1Allowlist;
  std::uint64_t cancel_epoch = 0;
  WindowsFileIdentity file_identity;
  std::string executable_digest;
  std::string signer_digest;
  std::string policy_language;
};

WindowsExistingStartSnapshot WindowsExistingStartBinding(const WindowsSession &session) {
  return {session.session_id, session.pid, session.window, session.app_identity,
          session.window_identity, session.process_start, session.maximum_mode,
          session.eligibility_basis, session.cancel_epoch,
          {session.executable_volume_serial, session.executable_file_id},
          session.executable_digest, session.signer_digest, session.policy_language};
}

bool WindowsExistingStartBindingMatches(const WindowsExistingStartSnapshot &expected,
                                        const WindowsSession &session) {
  return expected.session_id == session.session_id && expected.pid == session.pid &&
      expected.window == session.window && expected.app_identity == session.app_identity &&
      expected.window_identity == session.window_identity && expected.process_start == session.process_start &&
      expected.maximum_mode == session.maximum_mode && expected.eligibility_basis == session.eligibility_basis &&
      expected.cancel_epoch == session.cancel_epoch &&
      SameWindowsFileIdentity(expected.file_identity,
                              {session.executable_volume_serial, session.executable_file_id}) &&
      expected.executable_digest == session.executable_digest && expected.signer_digest == session.signer_digest &&
      expected.policy_language == session.policy_language;
}

struct WindowsExistingStartMeasurement {
  bool succeeded = false;
  bool identity_verified = false;
  WindowsExecutableIdentity executable;
  std::string process_start;
  std::string window_identity;
  std::string maximum_mode;
  std::optional<WindowsTargetFactsContext> context;
  std::string reason = "session_target_rejected";
};

struct WindowsExistingStartPending {
  std::mutex mutex;
  std::condition_variable ready;
  std::atomic<bool> abandoned{false};
  bool done = false;
  // This job alone owns the cancellation handle; it is closed on its worker before publication.
  ScopedKernelHandle thread;
  WindowsExistingStartMeasurement result;
};

struct WindowsExistingStartWork {
  WindowsStartInput input;
  WindowsExistingStartSnapshot expected;
  WindowsExistingStartMeasurement before;
  ScopedKernelHandle process;
  ScopedKernelHandle executable;
  bool source_ready = false;
  WindowsExistingStartPhase phase = WindowsExistingStartPhase::BeforeFocus;
  std::shared_ptr<WindowsExistingStartPending> pending;
};

bool WindowsExistingStartStillCurrent(const WindowsStartInput &input, std::uint64_t expected_epoch) {
  return !parent_process_dead.load(std::memory_order_acquire) &&
      (!input.start_lease || !input.start_lease->owner->stopped.load(std::memory_order_acquire)) &&
      cancellation_epoch.load(std::memory_order_acquire) == expected_epoch &&
      WindowsTargetListControl().stop_serial.load(std::memory_order_acquire) == input.stop_serial;
}

bool WindowsExistingStartRequestMatches(const WindowsExistingStartWork &work,
                                        const WindowsExistingStartMeasurement &measured) {
  const auto &expected = work.expected;
  const auto &input = work.input;
  return expected.session_id == input.session_id && expected.pid == input.pid &&
      expected.window == input.window && expected.app_identity == input.app_identity &&
      expected.window_identity == measured.window_identity && expected.process_start == measured.process_start &&
      expected.eligibility_basis == input.eligibility_basis;
}

// BEGIN windows v1 existing-start eligibility
bool MeasureWindowsV1ExistingStartEligibility(const WindowsStartInput &input,
                                              const LockedWindowsExecutable &executable,
                                              WindowsExistingStartMeasurement *measured) {
  if (!WindowsExecutableIdentityMatches(executable.identity, input.app_identity,
                                        input.executable_digest, input.signer_digest) ||
      !IsSupportedWindowsV1Target(executable.identity)) return false;
  measured->maximum_mode = MaximumModeForWindowsExecutable(executable.identity);
  return true;
}
// END windows v1 existing-start eligibility

WindowsExistingStartMeasurement MeasureWindowsExistingStartBefore(const WindowsExistingStartWork &work) {
  WindowsExistingStartMeasurement measured;
  const auto still_valid = [&] {
    return !work.pending->abandoned.load(std::memory_order_acquire) &&
        WindowsExistingStartStillCurrent(work.input, work.expected.cancel_epoch);
  };
  const auto &input = work.input;
  const bool v2 = input.eligibility_basis == sprint_coder::computer_use::EligibilityBasis::kV2Denylist;
  if (!still_valid() || (v2 && input.main_pid == 0)) return measured;
  ScopedKernelHandle target_process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, input.pid));
  LockedWindowsExecutable current_executable;
  if (target_process.value == nullptr || !still_valid() ||
      !OpenLockedProcessExecutable(target_process.value, &current_executable) || !still_valid() ||
      !SameWindowsPath(current_executable.identity.path, input.canonical_path))
    return measured;
  if (v2) {
    WindowsTargetFactsContext context;
    if (input.context.has_value()) {
      context = *input.context;
    } else {
      std::string signer = WindowsV2SelfSignerThumbprint();
      if (!still_valid()) return measured;
      context = CurrentWindowsTargetFactsContext(input.main_pid, std::move(signer),
                                                 /*acceptance_mode=*/false, still_valid);
    }
    if (!still_valid() || context.lineage_root_pid != input.main_pid) return measured;
    // A completed context may be retained on a target refusal, just as in the synchronous admission.
    if (!input.context.has_value()) measured.context = context;
    std::optional<sprint_coder::computer_use::WindowsFileKey> not_web_file;
    if (!AdmitWindowsV2StartInContext(input.pid, input.window, current_executable, context,
            input.ruleset_version, 0, 0, /*new_session=*/false, input.app_identity,
            input.executable_digest, input.signer_digest, &measured.maximum_mode, &not_web_file)) return measured;
  } else if (!MeasureWindowsV1ExistingStartEligibility(input, current_executable, &measured)) {
    return measured;
  }
  if (!still_valid() || IsKnownProxyExecutable(current_executable.identity.path) ||
      IsDisallowedTargetExecutable(current_executable.identity.path) || IsProcessElevated(input.pid) ||
      !still_valid() || !ReadProcessStartIdentity(target_process.value, &measured.process_start) ||
      !still_valid() || WaitForSingleObject(target_process.value, 0) != WAIT_TIMEOUT ||
      !IsWindow(input.window) || !IsApplicationWindow(input.window))
    return measured;
  measured.window_identity = Sha256String("computer-window-identity-v1\n" + input.app_identity + "\n" +
      measured.process_start + "\n" + std::to_string(input.window_value));
  if (measured.window_identity != input.expected_window_identity) {
    measured.reason = "window_identity_changed";
    return measured;
  }
  measured.identity_verified = true;
  measured.reason = "session_refocus_stale";
  std::string source_start;
  WindowsFileIdentity held{};
  if (!work.source_ready || !WindowsExistingStartRequestMatches(work, measured) || !still_valid() ||
      GetProcessId(work.process.value) != work.expected.pid ||
      WaitForSingleObject(work.process.value, 0) != WAIT_TIMEOUT ||
      !ReadProcessStartIdentity(work.process.value, &source_start) || !still_valid() ||
      source_start != work.expected.process_start ||
      !ReadWindowsFileIdentity(work.executable.value, &held) || !still_valid() ||
      !WindowsExecutableBindingMatches(work.expected.file_identity, work.expected.executable_digest,
          work.expected.signer_digest, work.expected.policy_language, held, current_executable.identity))
    return measured;
  measured.executable = current_executable.identity;
  measured.succeeded = true;
  measured.reason.clear();
  return measured;
}

WindowsExistingStartMeasurement MeasureWindowsExistingStartAfter(const WindowsExistingStartWork &work) {
  WindowsExistingStartMeasurement measured;
  measured.reason = "session_refocus_stale";
  const auto still_valid = [&] {
    return !work.pending->abandoned.load(std::memory_order_acquire) &&
        WindowsExistingStartStillCurrent(work.input, work.expected.cancel_epoch);
  };
  std::string source_start;
  WindowsFileIdentity held{};
  // The source session's file lock stays open across focus. Re-read that pin and the process;
  // do not replace the old post-focus comparison with a new path lookup or an invalid handle.
  if (!work.source_ready || !work.before.succeeded || !WindowsExistingStartRequestMatches(work, work.before) ||
      work.expected.maximum_mode != work.before.maximum_mode || !still_valid() ||
      GetProcessId(work.process.value) != work.expected.pid ||
      WaitForSingleObject(work.process.value, 0) != WAIT_TIMEOUT ||
      !ReadProcessStartIdentity(work.process.value, &source_start) || !still_valid() ||
      source_start != work.expected.process_start ||
      !ReadWindowsFileIdentity(work.executable.value, &held) || !still_valid() ||
      !WindowsExecutableBindingMatches(work.expected.file_identity, work.expected.executable_digest,
          work.expected.signer_digest, work.expected.policy_language, held, work.before.executable))
    return measured;
  measured.succeeded = true;
  measured.reason.clear();
  return measured;
}

void CancelWindowsExistingStartJob(const std::shared_ptr<WindowsExistingStartPending> &pending) {
  std::lock_guard lock(pending->mutex);
  if (pending->done) return;
  pending->abandoned.store(true, std::memory_order_release);
  if (pending->thread.value != nullptr) CancelSynchronousIo(pending->thread.value);
}

void WindowsExistingStartWorker(std::unique_ptr<WindowsExistingStartWork> work) {
  // Existing start worker entry; this job owns its thread and source duplicates.
  const auto pending = work->pending;
  const char *failure_reason = work->phase == WindowsExistingStartPhase::BeforeFocus
      ? "session_target_rejected" : "session_refocus_stale";
  WindowsExistingStartMeasurement measured;
  measured.reason = failure_reason;
  try {
    struct Apartment {
      HRESULT result;
      bool initialized;
      explicit Apartment(bool needed)
          : result(needed ? CoInitializeEx(nullptr, COINIT_MULTITHREADED) : S_OK),
            initialized(needed && SUCCEEDED(result)) {}
      ~Apartment() { if (initialized) CoUninitialize(); }
    } apartment(work->input.eligibility_basis == sprint_coder::computer_use::EligibilityBasis::kV2Denylist);
    bool thread_ready = false;
    {
      std::lock_guard lock(pending->mutex);
      thread_ready = DuplicateHandle(GetCurrentProcess(), GetCurrentThread(), GetCurrentProcess(),
          &pending->thread.value, 0, FALSE, DUPLICATE_SAME_ACCESS) != FALSE;
    }
    if (SUCCEEDED(apartment.result) && thread_ready)
      measured = work->phase == WindowsExistingStartPhase::BeforeFocus
          ? MeasureWindowsExistingStartBefore(*work) : MeasureWindowsExistingStartAfter(*work);
  } catch (...) {
    measured = {};
    measured.reason = failure_reason;
  }
  // All candidates, COM objects and source duplicates are released on this worker.
  work.reset();
  {
    std::lock_guard lock(pending->mutex);
    if (pending->thread.value != nullptr) CloseHandle(pending->thread.release());
    WindowsTargetListWorkerRunning().store(false, std::memory_order_release);
    if (!pending->abandoned.load(std::memory_order_acquire)) pending->result = std::move(measured);
    pending->done = true;
  }
  pending->ready.notify_one();
  // Existing start worker epilogue; no handle or shared-slot access remains.
}

struct WindowsExistingStartLease {
  std::shared_ptr<WindowsExistingStartPending> pending;
  ~WindowsExistingStartLease() { CancelWindowsExistingStartJob(pending); }
};

bool RunWindowsExistingStartMeasurement(
    const WindowsStartInput &input, const WindowsSession &session, WindowsExistingStartPhase phase,
    const WindowsExistingStartMeasurement *before, WindowsExistingStartMeasurement *output,
    std::string *reason) {
  *reason = phase == WindowsExistingStartPhase::BeforeFocus ? "session_target_rejected" : "session_refocus_stale";
  auto pending = std::make_shared<WindowsExistingStartPending>();
  auto work = std::make_unique<WindowsExistingStartWork>();
  work->input = input;
  work->expected = WindowsExistingStartBinding(session);
  work->phase = phase;
  work->pending = pending;
  if (before != nullptr) work->before = *before;
  const auto expected = work->expected;
  const bool v2 = input.eligibility_basis == sprint_coder::computer_use::EligibilityBasis::kV2Denylist;
  const HANDLE source_process = session.process_handle;
  const HANDLE source_executable = session.executable_file;
  auto &control = WindowsTargetListControl();
  const auto current = [&] {
    const auto found = sessions.find(input.session_key);
    return WindowsExistingStartStillCurrent(input, expected.cancel_epoch) && found != sessions.end() &&
        &found->second == &session && (!v2 || session.cancel_epoch == input.cancel_epoch) &&
        WindowsExistingStartBindingMatches(expected, session) &&
        session.process_handle == source_process && session.executable_file == source_executable;
  };
  {
    std::lock_guard stop_lock(control.stop_mutex);
    if (!current()) { *reason = "session_start_canceled"; return false; }
    if (control.running.load(std::memory_order_acquire)) return false;
    if (v2) {
      AdoptWindowsV2ContextCandidate(input.stop_serial);
      work->input.context = WindowsV2FactsContextCache();
      work->input.main_pid = windows_v2_main_pid;
      if (work->input.main_pid == 0) return false;
    }
    control.running.store(true, std::memory_order_release);
  }
  const std::uint32_t main_pid = work->input.main_pid;
  try {
    work->source_ready = source_process != nullptr && source_process != INVALID_HANDLE_VALUE &&
        source_executable != nullptr && source_executable != INVALID_HANDLE_VALUE &&
        DuplicateHandle(GetCurrentProcess(), source_process, GetCurrentProcess(), &work->process.value,
                        0, FALSE, DUPLICATE_SAME_ACCESS) &&
        DuplicateHandle(GetCurrentProcess(), source_executable, GetCurrentProcess(), &work->executable.value,
                        0, FALSE, DUPLICATE_SAME_ACCESS);
    if (!work->source_ready && (v2 || phase == WindowsExistingStartPhase::AfterFocus)) {
      work.reset();
      control.running.store(false, std::memory_order_release);
      return false;
    }
    std::thread(WindowsExistingStartWorker, std::move(work)).detach();
  } catch (...) {
    work.reset();
    control.running.store(false, std::memory_order_release);
    return false;
  }
  WindowsExistingStartLease lease{pending};
  std::unique_lock lock(pending->mutex);
  while (!pending->done && current()) pending->ready.wait_for(lock, std::chrono::milliseconds(20));
  std::lock_guard stop_lock(control.stop_mutex);
  if (!current() || (v2 && windows_v2_main_pid != main_pid)) {
    *reason = "session_start_canceled";
    return false;
  }
  const auto &measured = pending->result;
  if (v2 && measured.context.has_value() && !WindowsV2FactsContextCache().has_value())
    WindowsV2FactsContextCache() = measured.context;
  *output = measured;
  if (!measured.succeeded) {
    *reason = measured.reason;
    return false;
  }
  reason->clear();
  return true;
}

bool StartWindowsExistingSession(WindowsStartInput input, std::string *response, std::string *reason) {
  const auto found = sessions.find(input.session_key);
  if (found == sessions.end()) { *reason = "session_refocus_stale"; return false; }
  const bool v2 = input.eligibility_basis == sprint_coder::computer_use::EligibilityBasis::kV2Denylist;
  // V2 invalidates at entry; V1 keeps its candidate-identity boundary before invalidation.
  if (v2) InvalidateWindowsTicket(input.session_key);
  WindowsSession &session = found->second;
  const auto expected = WindowsExistingStartBinding(session);
  auto &control = WindowsTargetListControl();
  const auto measurement_current = [&] {
    return WindowsExistingStartStillCurrent(input, expected.cancel_epoch) &&
        WindowsExistingStartBindingMatches(expected, session);
  };
  WindowsExistingStartMeasurement before;
  const bool measured = RunWindowsExistingStartMeasurement(input, session, WindowsExistingStartPhase::BeforeFocus,
                                                           nullptr, &before, reason);
  if (!v2 && before.identity_verified) {
    std::lock_guard stop_lock(control.stop_mutex);
    if (!measurement_current()) { *reason = "session_start_canceled"; return false; }
    InvalidateWindowsTicket(input.session_key);
  }
  if (!measured) return false;
  const auto current = [&] {
    return measurement_current() && session.cancel_epoch == input.cancel_epoch;
  };
  const auto check_current = [&] {
    std::lock_guard stop_lock(control.stop_mutex);
    if (current()) return true;
    *reason = "session_start_canceled";
    return false;
  };
  // Existing start before consumer focus preparation.
  {
    std::lock_guard stop_lock(control.stop_mutex);
    if (!measurement_current() || (v2 && !current())) { *reason = "session_start_canceled"; return false; }
  }
  RECT physical_client{};
  if (!ClientBoundsPhysical(input.window, &physical_client) ||
      std::abs(static_cast<double>(physical_client.left) - input.bounds_x) > 1.0 ||
      std::abs(static_cast<double>(physical_client.top) - input.bounds_y) > 1.0 ||
      std::abs(static_cast<double>(physical_client.right - physical_client.left) - input.bounds_width) > 1.0 ||
      std::abs(static_cast<double>(physical_client.bottom - physical_client.top) - input.bounds_height) > 1.0) {
    *reason = "window_geometry_changed";
    return false;
  }
  if (!check_current()) return false;
  HWND refocus_window = input.window;
  if (input.explicit_resume) {
    if (!ResolveWindowsExplicitResumeTarget(&session, &refocus_window, reason)) return false;
  } else if (!ResolveWindowsSessionRefocusTarget(session, &refocus_window, reason)) {
    return false;
  }
  if (!check_current()) return false;
  const auto begin_focus = [&] {
    // Existing start focus unit begins under the reader's Stop lock.
    std::lock_guard stop_lock(control.stop_mutex);
    if (!current()) { *reason = "session_start_canceled"; return false; }
    session.input_api_attempts->fetch_add(1, std::memory_order_acq_rel);
    return true;
  };
  if (GetForegroundWindow() != refocus_window) {
    if (IsIconic(input.window)) {
      if (!begin_focus()) return false;
      ShowWindow(input.window, SW_RESTORE);
    }
    if (refocus_window != input.window && IsIconic(refocus_window)) {
      if (!begin_focus()) return false;
      ShowWindow(refocus_window, SW_RESTORE);
    }
    if (!begin_focus()) return false;
    SetForegroundWindow(refocus_window);
  }
  RECT bounds{};
  if (!TargetWindowFacts(input.pid, refocus_window, &bounds)) {
    *reason = "focus_required";
    return false;
  }
  RECT screen_bounds{};
  if (!ScreenBoundsPhysicalForWindow(refocus_window, &screen_bounds)) {
    *reason = "screen_geometry_unavailable";
    return false;
  }
  WindowsDialogSetSnapshot refocused_dialogs;
  if (!CaptureWindowsDialogSet(session, &refocused_dialogs, reason)) return false;
  if (refocused_dialogs.digest != session.dialog_set_digest ||
      refocused_dialogs.active_window != session.active_window ||
      refocused_dialogs.active_identity != session.active_window_identity ||
      refocused_dialogs.active_kind != session.active_window_kind) {
    *reason = "session_refocus_stale";
    return false;
  }
  if (!check_current()) return false;
  WindowsExistingStartMeasurement after;
  if (!RunWindowsExistingStartMeasurement(input, session, WindowsExistingStartPhase::AfterFocus,
                                           &before, &after, reason)) return false;
  std::string built = "{\"sessionId\":\"" + JsonEscape(input.session_id) +
      "\",\"platform\":\"win32\",\"appIdentityDigest\":\"" + input.app_identity +
      "\",\"windowIdentityDigest\":\"" + before.window_identity + "\",\"windowId\":\"" +
      std::to_string(input.window_value) + "\",\"policyLanguage\":\"" + before.executable.policy_language +
      "\",\"maximumMode\":\"" + before.maximum_mode + "\",\"screenBounds\":" + RectJson(screen_bounds) +
      ",\"profileRevision\":" + std::to_string(input.profile_revision) +
      ",\"cancelEpoch\":" + std::to_string(input.cancel_epoch) +
      ",\"inputAttemptCount\":" + std::to_string(session.input_api_attempts->load(std::memory_order_acquire)) +
      ",\"pid\":" + std::to_string(input.pid) + ",\"windowHandle\":\"" + std::to_string(input.window_value) + "\"}";
  // Existing start final success decision; a completed late phase cannot resume after Stop.
  std::lock_guard stop_lock(control.stop_mutex);
  if (!current()) { *reason = "session_start_canceled"; return false; }
  InvalidateWindowsTicket(input.session_key);
  *response = std::move(built);
  return true;
}

// END windows shared existing start

// END windows v2 targets

// BEGIN windows cancellable discovery measurement
struct WindowsDiscoveryWorkControl {
  std::function<bool()> current;
  std::function<DWORD(DWORD)> remaining;
  std::function<bool()> claim_launch;
  std::function<void()> retire_launch;
};

bool MeasureWindowsDiscovery(const std::string &metadata, const WindowsDiscoveryWorkControl& work,
                             std::string *response, std::string *reason) {
  if (!work.current()) {
    *reason = "profile_identity_invalid";
    return false;
  }
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
  if (!work.current()) { *reason = "window_discovery_unavailable"; return false; }
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
          expected_signer_digest, &candidates, work.current)) {
    CloseLockedWindowsExecutable(&current_executable);
    *reason = "process_enumeration_unavailable";
    return false;
  }
  if (work.current() && candidates.empty() && identity_matches &&
      !IsDisallowedTargetExecutable(current_executable.identity.path)) {
    ScopedKernelHandle launched_process;
    if (LaunchVerifiedExecutable(current_executable, &launched_process.value, work.claim_launch, work.retire_launch)) {
      if (!work.current()) { *reason = "window_discovery_unavailable"; return false; }
      WaitForInputIdle(launched_process.value, work.remaining(5'000));
      for (std::size_t attempt = 0; attempt < 20 && candidates.empty() && work.current();
           ++attempt) {
        if (!EnumerateWindowsForExecutable(
                current_executable.identity.path, expected_identity,
                current_executable.identity.executable_digest,
                expected_signer_digest,
                &candidates, work.current)) {
          CloseLockedWindowsExecutable(&current_executable);
          *reason = "process_enumeration_unavailable";
          return false;
        }
        if (candidates.empty() &&
            WaitForSingleObject(launched_process.value, work.remaining(250)) != WAIT_TIMEOUT)
          break;
      }
    }
  }
  CloseLockedWindowsExecutable(&current_executable);
  if (!work.current() || candidates.size() > 64) { *reason = "window_discovery_unavailable"; return false; }
  *response = "[";
  for (std::size_t index = 0; index < candidates.size(); ++index) {
    if (index != 0)
      *response += ',';
    *response += candidates[index];
  }
  *response += ']';
  return true;
}

// END windows cancellable discovery measurement

// BEGIN windows cancellable discovery worker
bool WindowsDiscoveryCurrent(const std::shared_ptr<WindowsDiscoveryOwner>& owner,
                             std::uint64_t serial) {
  return !owner->stopped.load(std::memory_order_acquire) &&
      !parent_process_dead.load(std::memory_order_acquire) &&
      WindowsTargetListControl().stop_serial.load(std::memory_order_acquire) == serial &&
      GetTickCount64() - owner->admitted_at < kWindowsDiscoveryBudgetMs;
}

std::string WindowsDiscoveryReceiptJson(std::string_view id, std::string_view result,
                                       std::uint32_t launches) {
  return "{\"discoveryId\":\"" + JsonEscape(id) + "\",\"result\":\"" + std::string(result) +
      "\",\"drained\":true,\"launchAttemptCount\":" + std::to_string(launches) + "}";
}

struct WindowsDiscoveryPending {
  std::mutex mutex;
  std::condition_variable ready;
  HANDLE thread = nullptr;
  bool done = false;
  bool ok = false;
  std::string windows;
  std::string reason = "window_discovery_unavailable";
};

struct WindowsDiscoveryWaitGuard {
  std::shared_ptr<WindowsDiscoveryOwner> owner;
  std::shared_ptr<WindowsDiscoveryPending> pending;
  bool completed = false;
  ~WindowsDiscoveryWaitGuard() {
    if (completed) return;
    std::lock_guard lock(pending->mutex);
    {
      std::lock_guard stop_lock(WindowsTargetListControl().stop_mutex);
      owner->stopped.store(true, std::memory_order_release);
      if (!owner->launch_in_flight) { owner->terminal = true; owner->completed = false; }
    }
    if (pending->thread != nullptr) CancelSynchronousIo(pending->thread);
  }
};

// Only the consumer services these queued owner-specific Stops, so response/cache writes stay serial.
struct WindowsDiscoveryStopPump {
  std::function<bool()> service;
  bool failed = false;
  bool Poll() {
    if (!failed && !service()) failed = true;
    return !failed;
  }
};

bool RunWindowsDiscovery(const std::string& metadata,
                         std::shared_ptr<WindowsDiscoveryLease> lease,
                         std::uint64_t serial, std::string* response, std::string* reason,
                         WindowsDiscoveryStopPump* stop_pump = nullptr) {
  *reason = "window_discovery_unavailable";
  if (!lease || !ClaimWindowsDiscoveryQuery(lease)) return false;
  const auto owner = lease->owner;
  auto& control = WindowsTargetListControl();
  std::shared_ptr<WindowsDiscoveryPending> pending;
  try { pending = std::make_shared<WindowsDiscoveryPending>(); }
  catch (...) { FinishWindowsDiscovery(owner, false); return false; }
  {
    std::lock_guard stop_lock(control.stop_mutex);
    if (!WindowsDiscoveryCurrent(owner, serial) || control.running.load(std::memory_order_acquire)) {
      owner->terminal = true;
      *reason = "profile_identity_invalid";
      return false;
    }
    control.running.store(true, std::memory_order_release);
  }
  WindowsDiscoveryWaitGuard guard{owner, pending};
  try {
    std::thread([pending, lease, metadata, serial]() mutable {
      const auto owner = lease->owner;
      bool ok = false;
      std::string windows, reason = "window_discovery_unavailable";
      {
        ScopedKernelHandle thread;
        try {
          if (DuplicateHandle(GetCurrentProcess(), GetCurrentThread(), GetCurrentProcess(),
                              &thread.value, 0, FALSE, DUPLICATE_SAME_ACCESS)) {
            {
              std::lock_guard lock(pending->mutex);
              pending->thread = thread.value;
            }
            WindowsDiscoveryWorkControl work;
            work.current = [owner, serial] { return WindowsDiscoveryCurrent(owner, serial); };
            work.remaining = [owner](DWORD maximum) {
              const auto elapsed = GetTickCount64() - owner->admitted_at;
              return elapsed >= kWindowsDiscoveryBudgetMs ? DWORD{0} :
                  static_cast<DWORD>(std::min<std::uint64_t>(maximum, kWindowsDiscoveryBudgetMs - elapsed));
            };
            work.claim_launch = [owner, serial] {
              std::lock_guard lock(WindowsTargetListControl().stop_mutex);
              if (!WindowsDiscoveryCurrent(owner, serial) || owner->terminal || owner->launch_attempts != 0)
                return false;
              owner->launch_attempts = 1;
              owner->launch_in_flight = true;
              return true;
            };
            work.retire_launch = [owner] {
              std::lock_guard lock(WindowsTargetListControl().stop_mutex);
              owner->launch_in_flight = false;
              if (owner->stopped.load(std::memory_order_acquire)) {
                owner->terminal = true; owner->completed = false;
              }
            };
            ok = MeasureWindowsDiscovery(metadata, work, &windows, &reason);
          }
        } catch (...) {
          ok = false;
          reason = "window_discovery_unavailable";
        }
        // Withdrawing the alias and cancelling it are ordered by the same pending mutex.
        std::lock_guard lock(pending->mutex);
        pending->thread = nullptr;
      }
      FinishWindowsDiscovery(owner, ok);
      lease.reset();
      {
        std::lock_guard lock(pending->mutex);
        pending->windows = std::move(windows);
        pending->reason = std::move(reason);
        pending->ok = ok;
        pending->done = true;
        WindowsTargetListWorkerRunning().store(false, std::memory_order_release);
      }
      pending->ready.notify_one();
    }).detach();
  } catch (...) {
    FinishWindowsDiscovery(owner, false);
    control.running.store(false, std::memory_order_release);
    return false;
  }
  std::unique_lock lock(pending->mutex);
  while (!pending->done && WindowsDiscoveryCurrent(owner, serial)) {
    // A different owner may already be terminal while this measurement is still blocked.
    lock.unlock();
    if (stop_pump != nullptr && !stop_pump->Poll()) return false;
    lock.lock();
    if (!pending->done && WindowsDiscoveryCurrent(owner, serial))
      pending->ready.wait_for(lock, std::chrono::milliseconds(20));
  }
  std::lock_guard stop_lock(control.stop_mutex);
  if (!WindowsDiscoveryCurrent(owner, serial)) return false;
  if (!pending->ok) { *reason = pending->reason; return false; }
  if (!owner->terminal || !owner->completed || owner->launch_in_flight) return false;
  std::string built = WindowsDiscoveryReceiptJson(owner->id, "completed", owner->launch_attempts);
  built.pop_back();
  built += ",\"windows\":" + pending->windows + "}";
  if (built.size() > kMaxMetadataBytes) return false;
  *response = std::move(built);
  guard.completed = true;
  return true;
}

bool StopWindowsDiscovery(const std::string& key, const std::string& metadata,
                          const std::shared_ptr<WindowsDiscoveryLease>& lease,
                          std::string* response, std::string* reason) {
  std::string id;
  if (!ReadWindowsDiscoveryStop(metadata, &id)) { *reason = "discovery_input_invalid"; return false; }
  if (!lease || lease->owner->key != key || lease->owner->id != id) {
    *reason = "window_discovery_unconfirmed"; return false;
  }
  std::lock_guard lock(WindowsTargetListControl().stop_mutex);
  const auto& owner = lease->owner;
  owner->stopped.store(true, std::memory_order_release);
  if (owner->launch_in_flight) { *reason = "window_discovery_unconfirmed"; return false; }
  owner->terminal = true;
  owner->completed = false;
  *response = WindowsDiscoveryReceiptJson(id, "stopped", owner->launch_attempts);
  return true;
}

void DrainWindowsDiscoveryLaunchesForExit() {
  StopWindowsDiscoveriesForPipeEnd();
  // Returning from main does not unwind detached workers. Keep their launch guards alive
  // until verification or actual failed-child exit retires the claimed unit. Read-only
  // workers cannot claim a launch after this latch and do not delay process exit.
  for (;;) {
    {
      std::lock_guard lock(WindowsTargetListControl().stop_mutex);
      const auto& owners = WindowsDiscoveries().owners;
      if (std::none_of(owners.begin(), owners.end(), [](const auto& entry) {
            return entry.second->launch_in_flight;
          })) return;
    }
    Sleep(10);
  }
}
// END windows cancellable discovery worker

// BEGIN windows session identity validation (#940)
thread_local const std::uint64_t *windows_validation_frame_serial = nullptr;

std::uint64_t WindowsValidationFrameStopSerial() {
  return windows_validation_frame_serial != nullptr ? *windows_validation_frame_serial
      : WindowsTargetListControl().stop_serial.load(std::memory_order_acquire);
}

class WindowsValidationFrameScope {
public:
  explicit WindowsValidationFrameScope(std::optional<std::uint64_t> queued_serial = std::nullopt) {
    if (windows_validation_frame_serial != nullptr) return;
    serial_ = queued_serial.value_or(WindowsTargetListControl().stop_serial.load(std::memory_order_acquire));
    windows_validation_frame_serial = &serial_;
    owner_ = true;
  }
  ~WindowsValidationFrameScope() {
    if (owner_) windows_validation_frame_serial = nullptr;
  }
  WindowsValidationFrameScope(const WindowsValidationFrameScope &) = delete;
  WindowsValidationFrameScope &operator=(const WindowsValidationFrameScope &) = delete;
  [[nodiscard]] std::uint64_t StopSerial() const { return *windows_validation_frame_serial; }

private:
  std::uint64_t serial_ = 0;
  bool owner_ = false;
};

bool WindowsValidationStillCurrent(std::uint64_t epoch, std::uint64_t stop_serial) {
  return !parent_process_dead.load(std::memory_order_acquire) &&
      cancellation_epoch.load(std::memory_order_acquire) == epoch &&
      WindowsTargetListControl().stop_serial.load(std::memory_order_acquire) == stop_serial;
}

struct WindowsSessionIdentityResult {
  bool identity_matches = false;
  bool elevated = true;
};

struct WindowsValidationPending {
  std::mutex mutex;
  std::condition_variable ready;
  std::atomic<bool> abandoned{false};
  std::uint64_t job_id = 0;
  bool done = false;
  WindowsSessionIdentityResult result;
};

struct WindowsValidationWork {
  std::uint32_t pid = 0;
  std::string process_start;
  std::wstring canonical_path;
  std::uint64_t volume_serial = 0;
  FILE_ID_128 file_id{};
  std::uint64_t epoch = 0;
  std::uint64_t stop_serial = 0;
  ScopedKernelHandle process;
  ScopedKernelHandle executable;
  std::shared_ptr<WindowsValidationPending> pending;
};

struct WindowsValidationState {
  std::mutex mutex;
  std::condition_variable wake;
  std::unique_ptr<WindowsValidationWork> queued;
  std::uint64_t active_job_id = 0;
  std::uint64_t next_job_id = 0;
  HANDLE cancellation_thread = nullptr;
  bool worker_started = false;
};

WindowsValidationState &WindowsValidationControl() {
  // One reusable reader for the helper's lifetime. An uninterruptible driver must not race static
  // destruction, and a stopped job must not cause another worker to be created.
  static auto *state = new WindowsValidationState;
  return *state;
}

WindowsSessionIdentityResult MeasureWindowsSessionIdentity(const WindowsValidationWork &work) {
  const auto still_valid = [&] {
    return !work.pending->abandoned.load(std::memory_order_acquire) &&
        WindowsValidationStillCurrent(work.epoch, work.stop_serial);
  };
  WindowsSessionIdentityResult result;
  std::string process_start;
  std::string current_start;
  std::wstring current_path;
  WindowsFileIdentity held_file_identity;
  // Keep both start-time checks that Validate performed, including the held-process check. These
  // reads are fresh for every call; the worker never caches a preceding validation's answer.
  if (!still_valid() || work.process.value == nullptr ||
      GetProcessId(work.process.value) != work.pid ||
      WaitForSingleObject(work.process.value, 0) != WAIT_TIMEOUT || !still_valid() ||
      !ReadProcessStartIdentity(work.process.value, &process_start) || process_start != work.process_start ||
      !still_valid() || !ReadProcessStartIdentity(work.process.value, &current_start) ||
      current_start != work.process_start || !still_valid() ||
      !ReadProcessPath(work.process.value, &current_path) ||
      !SameWindowsPath(current_path, work.canonical_path) || !still_valid() ||
      !ReadWindowsFileIdentity(work.executable.value, &held_file_identity) ||
      held_file_identity.volume_serial != work.volume_serial ||
      std::memcmp(held_file_identity.file_id.Identifier, work.file_id.Identifier,
                  sizeof(held_file_identity.file_id.Identifier)) != 0 || !still_valid())
    return result;
  result.identity_matches = true;
  result.elevated = IsProcessElevated(work.pid);
  return still_valid() ? result : WindowsSessionIdentityResult{};
}

void CancelWindowsValidationJob(std::uint64_t job_id) {
  auto &state = WindowsValidationControl();
  std::lock_guard lock(state.mutex);
  // The physical thread is reused. An old caller may cancel only its still-active job, never the
  // next job that happens to be on that same thread.
  if (state.active_job_id == job_id && job_id != 0 && state.cancellation_thread != nullptr)
    CancelSynchronousIo(state.cancellation_thread);
}

void WindowsValidationWorkerLoop(WindowsValidationState *state) {
  // The reusable thread owns its cancellation handle for its lifetime; state exposes an alias only
  // while one job owns the shared measurement slot. No COM apartment or input API is needed here.
  ScopedKernelHandle thread;
  const bool thread_ready =
      DuplicateHandle(GetCurrentProcess(), GetCurrentThread(), GetCurrentProcess(), &thread.value,
                      0, FALSE, DUPLICATE_SAME_ACCESS) &&
      thread.value != nullptr && thread.value != INVALID_HANDLE_VALUE;
  for (;;) {
    std::unique_ptr<WindowsValidationWork> work;
    {
      std::unique_lock lock(state->mutex);
      state->wake.wait(lock, [&] { return state->queued != nullptr; });
      work = std::move(state->queued);
      state->cancellation_thread = thread_ready ? thread.value : nullptr;
    }
    const auto pending = work->pending;
    const std::uint64_t job_id = pending->job_id;
    WindowsSessionIdentityResult result;
    try {
      if (thread_ready) result = MeasureWindowsSessionIdentity(*work);
    } catch (...) {
      result = {};
    }
    // The worker closes the job's duplicated process/exe handles, even after the session was closed.
    work.reset();
    {
      std::lock_guard lock(state->mutex);
      if (state->active_job_id == job_id) {
        state->cancellation_thread = nullptr;
        state->active_job_id = 0;
        WindowsTargetListWorkerRunning().store(false, std::memory_order_release);
      }
    }
    // Job retirement precedes result publication. Nothing below touches the shared slot or alias:
    // a new request may already own them while the old consumer is abandoning this result.
    {
      std::lock_guard lock(pending->mutex);
      if (!pending->abandoned.load(std::memory_order_acquire)) pending->result = result;
      pending->done = true;
    }
    pending->ready.notify_one();
  }
}

struct WindowsValidationSubmission {
  std::unique_ptr<WindowsValidationWork> work;
  bool claimed = false;
  ~WindowsValidationSubmission() {
    if (!claimed) return;
    // Not accepted by the worker: the original session still owns its handles on this consumer.
    work.reset();
    WindowsTargetListWorkerRunning().store(false, std::memory_order_release);
  }
};

struct WindowsValidationWaitGuard {
  std::shared_ptr<WindowsValidationPending> pending;
  ~WindowsValidationWaitGuard() {
    std::lock_guard lock(pending->mutex);
    if (pending->done) return;
    pending->abandoned.store(true, std::memory_order_release);
    // Lock order: pending -> state. The worker retires state before locking pending.
    CancelWindowsValidationJob(pending->job_id);
  }
};

bool ReadWindowsSessionIdentityOnLane(const WindowsSession &session, std::uint64_t stop_serial,
                                      WindowsSessionIdentityResult *result) {
  auto pending = std::make_shared<WindowsValidationPending>();
  WindowsValidationSubmission submission;
  submission.work = std::make_unique<WindowsValidationWork>();
  auto &work = *submission.work;
  work.pid = session.pid;
  work.process_start = session.process_start;
  work.canonical_path = session.canonical_path;
  work.volume_serial = session.executable_volume_serial;
  work.file_id = session.executable_file_id;
  work.epoch = session.cancel_epoch;
  work.stop_serial = stop_serial;
  work.pending = pending;
  const std::uint64_t epoch = work.epoch;
  {
    auto &control = WindowsTargetListControl();
    std::lock_guard stop_lock(control.stop_mutex);
    if (!WindowsValidationStillCurrent(epoch, stop_serial) ||
        control.running.exchange(true, std::memory_order_acq_rel))
      return false;
    submission.claimed = true;
  }
  // Duplicate while the consumer still owns the session. The worker never borrows handles that a
  // later Close can release or reuse. A submission failure is cleaned before this frame returns.
  if (session.process_handle == nullptr || session.executable_file == INVALID_HANDLE_VALUE ||
      !DuplicateHandle(GetCurrentProcess(), session.process_handle, GetCurrentProcess(), &work.process.value,
                       0, FALSE, DUPLICATE_SAME_ACCESS) ||
      !DuplicateHandle(GetCurrentProcess(), session.executable_file, GetCurrentProcess(), &work.executable.value,
                       0, FALSE, DUPLICATE_SAME_ACCESS))
    return false;
  auto &state = WindowsValidationControl();
  try {
    std::lock_guard lock(state.mutex);
    if (state.active_job_id != 0 || state.queued != nullptr ||
        state.next_job_id == std::numeric_limits<std::uint64_t>::max())
      return false;
    if (!state.worker_started) {
      std::thread(WindowsValidationWorkerLoop, &state).detach();
      state.worker_started = true;
    }
    pending->job_id = ++state.next_job_id;
    state.active_job_id = pending->job_id;
    state.queued = std::move(submission.work);
    submission.claimed = false;
  } catch (...) {
    return false;
  }
  state.wake.notify_one();
  WindowsValidationWaitGuard guard{pending};
  std::unique_lock lock(pending->mutex);
  for (;;) {
    {
      // Lock order: pending -> stop. The reader takes only stop_mutex.
      std::lock_guard stop_lock(WindowsTargetListControl().stop_mutex);
      if (!WindowsValidationStillCurrent(epoch, stop_serial)) return false;
      if (pending->done) {
        *result = pending->result;
        return true;
      }
    }
    pending->ready.wait_for(lock, std::chrono::milliseconds(20));
  }
}
// END windows session identity validation

std::string FrameIdKey(const sprint_coder::computer_use::FrameId &id) {
  return std::string(reinterpret_cast<const char *>(id.bytes.data()),
                     id.bytes.size());
}

std::string ResponseCacheKey(const Frame& request);
std::string RequestPayloadDigest(const Frame& request);

struct WindowsStartAttemptScope {
  std::shared_ptr<WindowsStartAdmission> owner;
  ~WindowsStartAttemptScope() {
    std::lock_guard lock(WindowsTargetListControl().stop_mutex);
    const auto active = sessions.find(owner->session_key);
    owner->active = active != sessions.end() && active->second.session_id == owner->session_id;
    if (owner->active) {
      active->second.start_owner = owner;
      owner->input_api_attempts = active->second.input_api_attempts;
    }
  }
};

struct WindowsStartParameters {
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
};

bool ParseWindowsStartParameters(const std::string& metadata, WindowsStartParameters* output) {
  auto& [pid_value, window_value, cancel_epoch, session_id, app_identity, expected_window_identity, canonical_path_utf8, expected_executable_digest, expected_signer_digest, expected_bounds_x, expected_bounds_y, expected_bounds_width, expected_bounds_height, explicit_resume] = *output;
  (void)expected_signer_digest;
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
    return false;
  }
  return !session_id.empty() && session_id.size() <= 256;
}

bool StartWindowsSession(const Frame &request, const std::string &metadata,
                         std::string *response, std::string *reason,
                         std::optional<std::uint64_t> queued_stop_serial = std::nullopt,
                         std::shared_ptr<WindowsStartLease> start_lease = nullptr) {
  const auto start_serial = queued_stop_serial.value_or(WindowsTargetListControl().stop_serial.load(std::memory_order_acquire));
  WindowsStartParameters parsed;
  if (!ParseWindowsStartParameters(metadata, &parsed)) { *reason = "session_input_invalid"; return false; }
  auto& [pid_value, window_value, cancel_epoch, session_id, app_identity, expected_window_identity, canonical_path_utf8, expected_executable_digest, expected_signer_digest, expected_bounds_x, expected_bounds_y, expected_bounds_width, expected_bounds_height, explicit_resume] = parsed;
  if (!start_lease) start_lease = AdmitWindowsStart(FrameIdKey(request.header.session_id), session_id,
      ResponseCacheKey(request), RequestPayloadDigest(request), reason, cancel_epoch);
  if (!start_lease || start_lease->owner->session_id != session_id ||
      start_lease->owner->session_key != FrameIdKey(request.header.session_id)) return false;
  WindowsStartAttemptScope ownership{start_lease->owner};
  if (!ClaimWindowsStartInput(start_lease)) { *reason = "session_start_canceled"; return false; }
  if (WindowsTargetListWorkerRunning().load(std::memory_order_acquire)) {
    *reason = "session_target_rejected"; return false;
  }
  // The eligibility basis the session is bound to (S5-c-3 PR-3). No field is the v1 basis, the only
  // one this function admits through (the V1 allow-list below). A field that is there must name a
  // basis; one this build does not admit (v2 in a v1 build) is refused.
  sprint_coder::computer_use::EligibilityBasis eligibility_basis =
      sprint_coder::computer_use::EligibilityBasis::kV1Allowlist;
  if (metadata.find("\"eligibilityBasis\"") != std::string::npos) {
    std::string basis_name;
    if (!ReadJsonString(metadata, "eligibilityBasis", &basis_name) ||
        !sprint_coder::computer_use::ParseEligibilityBasis(basis_name, &eligibility_basis)) {
      *reason = "session_input_invalid";
      return false;
    }
  }
  if (!sprint_coder::computer_use::EligibilityBasisAdmitted(
          eligibility_basis, sprint_coder::computer_use::kNativeEligibilityIsV2)) {
    *reason = "eligibility_basis_unsupported";
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
  const bool v2_basis =
      eligibility_basis == sprint_coder::computer_use::EligibilityBasis::kV2Denylist;
  if (sessions.contains(FrameIdKey(request.header.session_id))) {
    WindowsStartInput input;
    input.eligibility_basis = eligibility_basis;
    input.start_lease = start_lease;
    input.pid = pid;
    input.window = window;
    input.window_value = window_value;
    input.session_key = FrameIdKey(request.header.session_id);
    input.session_id = session_id;
    input.app_identity = app_identity;
    input.expected_window_identity = expected_window_identity;
    input.canonical_path = canonical_path;
    input.executable_digest = expected_executable_digest;
    input.signer_digest = expected_signer_digest;
    input.bounds_x = expected_bounds_x;
    input.bounds_y = expected_bounds_y;
    input.bounds_width = expected_bounds_width;
    input.bounds_height = expected_bounds_height;
    input.explicit_resume = explicit_resume;
    input.cancel_epoch = cancel_epoch;
    input.stop_serial = start_serial;
    ReadJsonUint64(metadata, "profileRevision", &input.profile_revision);
    if (v2_basis && !ReadJsonUint64(metadata, "denyRulesetVersion", &input.ruleset_version)) {
      *reason = "session_target_rejected";
      return false;
    }
    return StartWindowsExistingSession(std::move(input), response, reason);
  }
  if (v2_basis && !sessions.contains(FrameIdKey(request.header.session_id))) {
    if constexpr (sprint_coder::computer_use::kNativeEligibilityIsV2) {
      WindowsStartInput input;
      input.start_lease = start_lease;
      input.pid = pid;
      input.window = window;
      input.window_value = window_value;
      input.session_key = FrameIdKey(request.header.session_id);
      input.session_id = session_id;
      input.app_identity = app_identity;
      input.expected_window_identity = expected_window_identity;
      input.canonical_path = canonical_path;
      input.executable_digest = expected_executable_digest;
      input.signer_digest = expected_signer_digest;
      input.bounds_x = expected_bounds_x;
      input.bounds_y = expected_bounds_y;
      input.bounds_width = expected_bounds_width;
      input.bounds_height = expected_bounds_height;
      input.explicit_resume = explicit_resume;
      input.cancel_epoch = cancel_epoch;
      input.stop_serial = start_serial;
      ReadJsonUint64(metadata, "profileRevision", &input.profile_revision);
      if (!ReadJsonUint64(metadata, "denyRulesetVersion", &input.ruleset_version) ||
          !ReadJsonUint64(metadata, "targetGeneration", &input.requested_generation)) {
        *reason = "session_target_rejected";
        return false;
      }
      return StartWindowsNewSession(std::move(input), response, reason);
    }
  }
  if (!v2_basis && !sessions.contains(FrameIdKey(request.header.session_id))) {
    WindowsStartInput input;
    input.eligibility_basis = eligibility_basis;
    input.start_lease = start_lease;
    input.pid = pid;
    input.window = window;
    input.window_value = window_value;
    input.session_key = FrameIdKey(request.header.session_id);
    input.session_id = session_id;
    input.app_identity = app_identity;
    input.expected_window_identity = expected_window_identity;
    input.canonical_path = canonical_path;
    input.executable_digest = expected_executable_digest;
    input.signer_digest = expected_signer_digest;
    input.bounds_x = expected_bounds_x;
    input.bounds_y = expected_bounds_y;
    input.bounds_width = expected_bounds_width;
    input.bounds_height = expected_bounds_height;
    input.explicit_resume = explicit_resume;
    input.cancel_epoch = cancel_epoch;
    input.stop_serial = start_serial;
    ReadJsonUint64(metadata, "profileRevision", &input.profile_revision);
    return StartWindowsNewSession(std::move(input), response, reason);
  }
  *reason = "eligibility_basis_unsupported";
  return false;
}

void MarkWindowsStartClosed(const std::string& key, const ClosedWindowsSessionRecord& receipt) {
  std::lock_guard lock(WindowsTargetListControl().stop_mutex);
  auto& registry = WindowsStarts();
  const auto found = registry.owners.find(key);
  if (found == registry.owners.end() || found->second->session_id != receipt.session_id) return;
  const auto& owner = found->second;
  owner->active = false;
  owner->terminal = true;
  owner->terminal_epoch = std::max(owner->terminal_epoch, receipt.cancel_epoch);
  owner->stopped.store(true, std::memory_order_release);
  if (registry.input_owner == owner && owner->pending_requests.load(std::memory_order_acquire) == 0)
    registry.input_owner.reset();
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
  MarkWindowsStartClosed(session_key, receipt);
  *response = "{\"result\":\"closed\",\"drained\":true,\"sessionId\":\"" +
      JsonEscape(receipt.session_id) + "\",\"cancelEpoch\":" + std::to_string(receipt.cancel_epoch) +
      ",\"inputAttemptCount\":" + std::to_string(receipt.input_api_attempts) + "}";
  return true;
}

bool StopPendingWindowsStart(const Frame& request, const std::string& metadata,
                             std::string* response, std::string* reason) {
  constexpr std::uint64_t max_safe_epoch = 9007199254740991ULL;
  std::string id;
  if (!ReadPendingWindowsStop(metadata, &id)) { *reason = "session_input_invalid"; return false; }
  const auto key = FrameIdKey(request.header.session_id);
  if (!LatchWindowsPendingStop(key, id)) { *reason = "native_close_unconfirmed"; return false; }
  std::shared_ptr<WindowsStartAdmission> owner;
  std::uint64_t epoch = 0;
  bool active = false;
  {
    std::lock_guard lock(WindowsTargetListControl().stop_mutex);
    auto& registry = WindowsStarts();
    const auto found = registry.owners.find(key);
    if (found == registry.owners.end() || found->second->session_id != id) {
      *reason = "native_close_unconfirmed"; return false;
    }
    owner = found->second;
    const auto session = sessions.find(key);
    active = session != sessions.end() && session->second.session_id == id;
    if (active) owner->input_api_attempts = session->second.input_api_attempts;
    const auto base = owner->terminal ? owner->terminal_epoch :
        std::max({cancellation_epoch.load(std::memory_order_acquire), owner->requested_epoch,
                  active ? session->second.cancel_epoch : owner->terminal_epoch});
    if (base >= max_safe_epoch) { *reason = "native_stop_epoch_exhausted"; return false; }
    epoch = base + 1;
    if (!active) {
      if (!owner->terminal && registry.input_owner == owner) {
        auto current = cancellation_epoch.load(std::memory_order_acquire);
        while (epoch > current && !cancellation_epoch.compare_exchange_weak(current, epoch,
            std::memory_order_acq_rel, std::memory_order_acquire)) {}
        last_closed_cancel_epoch = std::max(last_closed_cancel_epoch, epoch);
      } else if (!owner->terminal && registry.input_owner == nullptr && registry.last_input_owner.lock() == owner) {
        // The failed input owner has no work left. Release its old barrier without canceling
        // unrelated discovery by advancing the global epoch.
        last_closed_cancel_epoch = std::max(last_closed_cancel_epoch,
            cancellation_epoch.load(std::memory_order_acquire));
      }
      owner->terminal = true;
      owner->terminal_epoch = epoch;
      owner->active = false;
      if (registry.input_owner == owner && owner->pending_requests.load(std::memory_order_acquire) == 0)
        registry.input_owner.reset();
    }
  }
  if (active) {
    const auto close_metadata = "{\"cancelEpoch\":" + std::to_string(epoch) + "}";
    if (!CloseWindowsSession(request, close_metadata, response)) {
      *reason = "native_close_unconfirmed"; return false;
    }
    return true;
  }
  *response = "{\"result\":\"closed\",\"drained\":true,\"sessionId\":\"" + JsonEscape(id) +
      "\",\"cancelEpoch\":" + std::to_string(epoch) + ",\"inputAttemptCount\":" +
      std::to_string(owner->input_api_attempts->load(std::memory_order_acquire)) + "}";
  return true;
}

bool ValidateWindowsSession(
    const WindowsSession &session, RECT *bounds, std::string *reason,
    WindowsDialogSetSnapshot *dialog_snapshot = nullptr) {
  const WindowsValidationFrameScope frame;
  if (WindowsTargetListWorkerRunning().load(std::memory_order_acquire)) {
    *reason = "session_identity_changed";
    return false;
  }
  WindowsSessionIdentityResult identity;
  DWORD owner_pid = 0;
  if (!ReadWindowsSessionIdentityOnLane(session, frame.StopSerial(), &identity) ||
      !identity.identity_matches ||
      !IsWindow(session.window) || !IsApplicationWindow(session.window) ||
      GetWindowThreadProcessId(session.window, &owner_pid) == 0 ||
      owner_pid != session.pid) {
    *reason = "session_identity_changed";
    return false;
  }
  if (identity.elevated) {
    *reason = "elevated_target_blocked";
    return false;
  }
  WindowsDialogSetSnapshot current_dialogs;
  if (!CaptureWindowsDialogSet(session, &current_dialogs, reason))
    return false;
  std::lock_guard stop_lock(WindowsTargetListControl().stop_mutex);
  if (!WindowsValidationStillCurrent(session.cancel_epoch, frame.StopSerial())) {
    *reason = "session_identity_changed";
    return false;
  }
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
//     transaction is bounded by BOTH: the worst case of one call is counted as 500 + 300 = 800 ms,
//     inside the 1 s of the Cancel acknowledgment (COMPUTER_USE_NATIVE_CANCEL_ACK_TIMEOUT_MS). The two
//     waits DO follow each other: on the CI of PR #822 (2026-10-17) a ClassifyWindowsFocusedElement case
//     of the live seam came back after 844 ms. The margin is SMALL: what is left of the 1 s for
//     everything else the lane does between the epoch moving and the acknowledgment (the pipe, the frame,
//     the answer) was about 156 ms there. Measured on CI one at a time: a transaction-bound call is cut
//     after 310-320 ms, a first contact after 505-514 ms. Under more load the margin can be less (not
//     verified). The live seam's bound on one case is this counted worst case and 150 ms (950 ms).
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
//  timeout AND left its output empty (the shape only a cut-off call produces: no element, no string,
//  zero; WindowsV1UiaEmpty) is a timed-out call (WindowsV1UiaTimed), whatever the HRESULT says. A slow
//  call that did hand back a value has answered: a live app under load can be slow and right, and
//  cutting it off would turn it into "unclassified" (#823). Where an empty output is also a real answer
//  (an empty name, no child, FALSE), a slow one is still taken for a timeout: fail closed. A first
//  contact is the exception: a slow one is a timeout whatever it hands back, because UI Automation
//  builds the element of a window from its HWND even when the app's provider was cut off
//  (WindowsV1UiaContact).
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

struct WindowsUiaObservationPending {
  std::mutex mutex;
  std::condition_variable ready;
  std::atomic<WindowsV1UiaStop> abandoned{WindowsV1UiaStop::kNone};
  std::atomic<WindowsV1UiaStop> stop{WindowsV1UiaStop::kNone};
  std::atomic<std::size_t> nodes{0};
  bool contact_active = false;
  std::chrono::steady_clock::time_point contact_started;
  bool done = false;
  bool succeeded = false;
  std::string tree;
  std::size_t tree_nodes = 0;
};

// Installed only by the observation worker. No caller's lane or COM pointer crosses threads.
thread_local WindowsUiaObservationPending *windows_uia_observation_pending = nullptr;

std::atomic<bool> &WindowsUiaObservationWorkerRunning() {
  // A provider stuck in COM may outlive ServePipe and static destruction.
  static auto *running = new std::atomic<bool>{false};
  return *running;
}

struct WindowsV1UiaLane {
  bool has_deadline = false;
  std::chrono::steady_clock::time_point deadline;
  std::uint64_t epoch = 0;
  std::optional<std::uint64_t> stop_serial;
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
  WindowsV1UiaPath(std::chrono::milliseconds budget, std::uint64_t epoch,
                   std::optional<std::uint64_t> stop_serial = std::nullopt) {
    if (windows_v1_uia_lane != nullptr)
      return;
    if (budget > std::chrono::milliseconds::zero()) {
      lane_.has_deadline = true;
      lane_.deadline = std::chrono::steady_clock::now() + budget;
    }
    lane_.epoch = epoch;
    lane_.stop_serial = stop_serial;
    windows_v1_uia_lane = &lane_;
    owner_ = true;
  }
  // An observation worker inherits the absolute deadline, not a fresh budget.
  explicit WindowsV1UiaPath(WindowsV1UiaLane snapshot) : lane_(std::move(snapshot)) {
    if (windows_v1_uia_lane == nullptr) {
      windows_v1_uia_lane = &lane_;
      owner_ = true;
    }
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
  // The consumer already rejected this result; no further provider calls are useful.
  if (lane->stop == WindowsV1UiaStop::kNone && windows_uia_observation_pending != nullptr)
    lane->stop = windows_uia_observation_pending->abandoned.load(std::memory_order_acquire);
  if (lane->stop == WindowsV1UiaStop::kNone) {
    if (cancellation_epoch.load(std::memory_order_acquire) != lane->epoch ||
        (lane->stop_serial.has_value() &&
         (WindowsTargetListControl().stop_serial.load(std::memory_order_acquire) !=
              *lane->stop_serial || parent_process_dead.load(std::memory_order_acquire))))
      lane->stop = WindowsV1UiaStop::kCanceled;
    else if (lane->has_deadline && std::chrono::steady_clock::now() > lane->deadline)
      lane->stop = WindowsV1UiaStop::kBudget;
  }
  if (windows_uia_observation_pending != nullptr && lane->stop != WindowsV1UiaStop::kNone)
    windows_uia_observation_pending->stop.store(lane->stop, std::memory_order_release);
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
  if (windows_uia_observation_pending != nullptr && lane != nullptr &&
      lane->stop != WindowsV1UiaStop::kNone)
    windows_uia_observation_pending->stop.store(lane->stop, std::memory_order_release);
  return false;
}

// A call that took this long and "succeeded" with an empty output has been cut off by its timeout
// (30 ms under it): 270 ms against the 300 ms transaction timeout, 470 ms against the 500 ms connection
// timeout.
constexpr std::chrono::milliseconds kWindowsV1UiaSlowRead{270};
constexpr std::chrono::milliseconds kWindowsV1UiaSlowContact{470};
static_assert(kWindowsV1UiaSlowRead.count() < kWindowsV1UiaTransactionTimeoutMs, "a read is slow before it times out");
static_assert(kWindowsV1UiaSlowContact.count() < kWindowsV1UiaConnectionTimeoutMs, "a contact is slow before it times out");

// Whether the output of a call has the shape a cut-off call leaves behind (#823): nothing. Measured on
// CI, a timed-out read comes back S_OK with an empty value; a slow call that handed back something real
// has answered. One rule for every type, its zero value: no element / pattern / walker / SAFEARRAY (a
// null pointer), no string (a null or zero-length BSTR), and for the value types, which have no "nothing"
// of their own, the zero a cut-off call leaves (0, FALSE, the first enumerator, an all-zero RECT). A
// process id or a control type of 0 is no answer at all. Where the zero is a real answer too (an element
// with no name, a leaf with no child, the last sibling, a control that is not a password one,
// ToggleState_Off, ExpandCollapseState_Collapsed), a SLOW zero is still taken for a timeout: fail closed,
// as before #823 (IsPassword in particular must never read a cut-off FALSE as "not a password"). A fast
// zero is an answer, whatever it is. A cut-off call that writes nothing leaves the caller's starting
// value: every output starts empty (nullptr, 0, FALSE, an all-zero RECT), except the two pattern states,
// which start at ToggleState_Indeterminate / ExpandCollapseState_LeafNode; a slow one of those is taken
// for an answer here, but the caller rejects exactly those values (semantic_state_unavailable), so both
// shapes of a cut-off state read are refused.
inline bool WindowsV1UiaEmpty(BSTR value) { return SysStringLen(value) == 0; }
template <class Pointee> bool WindowsV1UiaEmpty(Pointee *value) { return value == nullptr; }
inline bool WindowsV1UiaEmpty(const RECT &value) {
  return value.left == 0 && value.top == 0 && value.right == 0 && value.bottom == 0;
}
template <class Value>
  requires(std::is_arithmetic_v<Value> || std::is_enum_v<Value>)
bool WindowsV1UiaEmpty(Value value) {
  return value == Value{};
}

class WindowsUiaObservationContact {
public:
  WindowsUiaObservationContact(bool contact, std::chrono::steady_clock::time_point started)
      : pending_(contact ? windows_uia_observation_pending : nullptr) {
    if (pending_ == nullptr)
      return;
    {
      std::lock_guard lock(pending_->mutex);
      pending_->contact_started = started;
      pending_->contact_active = true;
    }
    pending_->ready.notify_one();
  }
  ~WindowsUiaObservationContact() {
    if (pending_ == nullptr)
      return;
    {
      std::lock_guard lock(pending_->mutex);
      pending_->contact_active = false;
    }
    pending_->ready.notify_one();
  }
  void Completed(HRESULT result) {
    // Publish before clearing contact_active, including when later COM cleanup blocks.
    if (pending_ != nullptr && WindowsV1UiaIsTimeout(result))
      pending_->stop.store(WindowsV1UiaStop::kTimeout, std::memory_order_release);
  }

private:
  WindowsUiaObservationPending *pending_;
};

// One UI Automation call of a path: the cancel / timeout / budget check first (E_ABORT, no call made,
// when the path has ended), then the call, timed. `output` is the call's own out-value (read after the
// call). A call that came back only after nearly its whole timeout with an empty output (or, where the
// output proves nothing, with any output) is a timed-out call (UIA_E_TIMEOUT), even if it says S_OK; a
// slow call with a real output is a success.
template <class Value, class Call>
HRESULT WindowsV1UiaTimed(std::chrono::milliseconds slow, bool output_proves_answer, const Value &output, Call &&call) {
  if (!WindowsV1UiaMayCall())
    return E_ABORT;
  const auto start = std::chrono::steady_clock::now();
  WindowsUiaObservationContact contact(!output_proves_answer, start);
  HRESULT result = call();
  if (SUCCEEDED(result) && std::chrono::steady_clock::now() - start >= slow &&
      (!output_proves_answer || WindowsV1UiaEmpty(output)))
    result = kWindowsV1UiaTimeoutResult;
  contact.Completed(result);
  return result;
}
// A call on a connected element (walker moves, the parent): a slow one is an answer when it hands back
// an element.
template <class Value, class Call> HRESULT WindowsV1UiaCall(const Value &output, Call &&call) {
  return WindowsV1UiaTimed(kWindowsV1UiaSlowRead, true, output, call);
}
// The first contact with a target (ElementFromHandle / ElementFromPoint / GetFocusedElement). A slow
// contact is a timeout WHATEVER it hands back (as in #820, kept by #823): UI Automation builds the
// element of a window from its HWND (the host proxy) even when the app's own provider was cut off
// (measured locally: ElementFromHandle on a provider that stopped answering, 1026 ms, S_OK, an element),
// so an element is no proof that the app answered. The output is still named, as every wrapped call names
// its own, but it does not decide.
template <class Value, class Call> HRESULT WindowsV1UiaContact(const Value &output, Call &&call) {
  return WindowsV1UiaTimed(kWindowsV1UiaSlowContact, false, output, call);
}
// One read of a property: true only for a call that answered (in time, or slowly with a value).
template <class Value, class Call> bool WindowsV1UiaRead(const Value &output, Call &&call) {
  return WindowsV1UiaOk(WindowsV1UiaTimed(kWindowsV1UiaSlowRead, true, output, call));
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
  if (windows_uia_observation_pending != nullptr)
    windows_uia_observation_pending->nodes.fetch_add(1, std::memory_order_relaxed);
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

// The warm-up of the client side of UI Automation, once, when the serving host starts (ServeMain,
// after ProbeBackend and before the pipe is connected; not in ProbeMain, whose process ends at once):
// the first contact a process makes loads UI Automation's client side, and that cost would be charged
// to the first app the lane contacts, against the slow-contact mark (kWindowsV1UiaSlowContact): an app
// that answers would be reported as accessibility_timeout. Measured locally (2026-10-18, 40 busy
// processes on 20 cores, a target window that already answered): the cold first contact took
// 160-460 ms; after reading the desktop root once (UI Automation's own element, no app behind it, also
// from another thread) it took 7-34 ms. The read is not a V1 path and decides nothing: its result is
// ignored.
void WarmWindowsV1Automation() {
  IUIAutomation *automation = nullptr;
  if (FAILED(CreateWindowsV1Automation(&automation)) || automation == nullptr)
    return;
  IUIAutomationElement *desktop = nullptr;
  if (SUCCEEDED(automation->GetRootElement(&desktop)) && desktop != nullptr)
    desktop->Release();
  automation->Release();
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
      WindowsV1UiaRead(name, [&] { return element->get_CurrentName(&name); }) &&
      WindowsV1UiaRead(automation_id, [&] { return element->get_CurrentAutomationId(&automation_id); }) &&
      WindowsV1UiaRead(help, [&] { return element->get_CurrentHelpText(&help); }) &&
      WindowsV1UiaRead(control_type, [&] { return element->get_CurrentControlType(&control_type); }) &&
      WindowsV1UiaRead(password, [&] { return element->get_CurrentIsPassword(&password); });
  const auto free_string = [](OLECHAR *value) { SysFreeString(value); };
  std::unique_ptr<OLECHAR, decltype(free_string)> owned_name(name, free_string);
  std::unique_ptr<OLECHAR, decltype(free_string)> owned_id(automation_id, free_string);
  std::unique_ptr<OLECHAR, decltype(free_string)> owned_help(help, free_string);
  if (!attributes_read)
    return false;
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
  if (!text_converted)
    return false;
  owned_name.reset();
  owned_id.reset();
  owned_help.reset();
  *json += "{\"role\":\"" +
           JsonEscape(UiaRole(control_type, password == TRUE)) +
           "\",\"title\":\"" + JsonEscape(name_utf8) + "\",\"identifier\":\"" +
           JsonEscape(automation_utf8) + "\"";
  if (!help_utf8.empty())
    *json += ",\"help\":\"" + JsonEscape(help_utf8) + "\"";
  *json += ",\"children\":[";
  IUIAutomationElement *child = nullptr;
  struct ChildOwner {
    IUIAutomationElement *&child;
    ~ChildOwner() { if (child != nullptr) child->Release(); }
  } owned_child{child};
  HRESULT result = WindowsV1UiaCall(child, [&] { return walker->GetFirstChildElement(element, &child); });
  bool first = true;
  bool complete = WindowsV1UiaOk(result);
  while (complete && child != nullptr) {
    if (!first)
      *json += ',';
    first = false;
    if (!AppendUiaTree(child, walker, depth + 1, nodes, json))
      complete = false;
    IUIAutomationElement *next = nullptr;
    if (complete && !WindowsV1UiaOk(WindowsV1UiaCall(next, [&] { return walker->GetNextSiblingElement(child, &next); })))
      complete = false;
    child->Release();
    child = next;
  }
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

bool ReadUiaObservationOnWorker(std::uint32_t pid, HWND window, std::string *tree,
                                std::size_t *nodes) {
  const WindowsV1UiaPath path;
  struct Objects {
    IUIAutomation *automation = nullptr;
    IUIAutomationElement *root = nullptr;
    IUIAutomationTreeWalker *walker = nullptr;
    ~Objects() {
      if (root != nullptr) root->Release();
      if (walker != nullptr) walker->Release();
      if (automation != nullptr) automation->Release();
    }
  } objects;
  IUIAutomation *&automation = objects.automation;
  IUIAutomationElement *&root = objects.root;
  IUIAutomationTreeWalker *&walker = objects.walker;
  if (!WindowsV1UiaMayCall())
    return false;
  if (FAILED(CreateWindowsV1Automation(&automation)) ||
      automation == nullptr)
    return false;
  const HRESULT root_result =
      WindowsV1UiaContact(root, [&] { return automation->ElementFromHandle(window, &root); });
  if (!WindowsV1UiaOk(root_result) || root == nullptr || !WindowsV1UiaMayCall())
    return false;
  const HRESULT walker_result = automation->get_RawViewWalker(&walker);
  std::string value;
  std::size_t count = 0;
  const bool complete = SUCCEEDED(walker_result) && walker != nullptr &&
                        AppendUiaTree(root, walker, 0, &count, &value);
  if (!complete)
    return false;
  *tree = std::move(value);
  *nodes = count;
  (void)pid;
  return true;
}

bool ReadUiaObservation(std::uint32_t pid, HWND window, std::string *tree,
                        std::size_t *nodes) {
  const WindowsV1UiaPath path;
  if (!WindowsV1UiaMayCall())
    return false;
  WindowsV1UiaLane snapshot = *windows_v1_uia_lane;
  auto &control = WindowsTargetListControl();
  if (!snapshot.stop_serial.has_value())
    snapshot.stop_serial = control.stop_serial.load(std::memory_order_acquire);
  auto pending = std::make_shared<WindowsUiaObservationPending>();
  {
    std::lock_guard stop_lock(control.stop_mutex);
    if (parent_process_dead.load(std::memory_order_acquire) ||
        control.stop_serial.load(std::memory_order_acquire) != *snapshot.stop_serial) {
      windows_v1_uia_lane->stop = WindowsV1UiaStop::kCanceled;
      return false;
    }
    if (WindowsUiaObservationWorkerRunning().exchange(true, std::memory_order_acq_rel))
      return false;
  }
  try {
    std::thread([pending, snapshot, pid, window] {
      struct Progress {
        explicit Progress(WindowsUiaObservationPending *value) {
          windows_uia_observation_pending = value;
        }
        ~Progress() { windows_uia_observation_pending = nullptr; }
      } progress(pending.get());
      const WindowsV1UiaPath worker_path(snapshot);
      bool succeeded = false;
      std::string value;
      std::size_t count = 0;
      try {
        struct Apartment {
          HRESULT result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
          ~Apartment() { if (SUCCEEDED(result)) CoUninitialize(); }
        } apartment;
        if (SUCCEEDED(apartment.result) && WindowsV1UiaMayCall())
          succeeded = ReadUiaObservationOnWorker(pid, window, &value, &count);
      } catch (...) {
        succeeded = false;
      }
      // Release and CoUninitialize finish before another observation can claim the slot.
      {
        std::lock_guard lock(pending->mutex);
        if (pending->abandoned.load(std::memory_order_acquire) == WindowsV1UiaStop::kNone) {
          pending->succeeded = succeeded;
          pending->tree = std::move(value);
          pending->tree_nodes = count;
          pending->stop.store(worker_path.Stop(), std::memory_order_release);
        }
        pending->done = true;
        WindowsUiaObservationWorkerRunning().store(false, std::memory_order_release);
      }
      pending->ready.notify_one();
    }).detach();
  } catch (...) {
    WindowsUiaObservationWorkerRunning().store(false, std::memory_order_release);
    return false;
  }
  std::unique_lock lock(pending->mutex);
  for (;;) {
    // As with list_targets, Stop receipt and adoption are serialized. Close is identified by the
    // enqueue serial, independently of its input cancellation epoch and replay watermark.
    {
      std::lock_guard stop_lock(control.stop_mutex);
      WindowsV1UiaLane &lane = *windows_v1_uia_lane;
      WindowsV1UiaMayCall();
      if (lane.stop == WindowsV1UiaStop::kNone &&
          (parent_process_dead.load(std::memory_order_acquire) ||
           control.stop_serial.load(std::memory_order_acquire) != *snapshot.stop_serial))
        lane.stop = WindowsV1UiaStop::kCanceled;
      if (lane.stop == WindowsV1UiaStop::kNone)
        lane.stop = pending->stop.load(std::memory_order_acquire);
      if (lane.stop == WindowsV1UiaStop::kNone && pending->contact_active &&
          std::chrono::steady_clock::now() - pending->contact_started >= kWindowsV1UiaSlowContact)
        lane.stop = WindowsV1UiaStop::kTimeout;
      if (lane.stop != WindowsV1UiaStop::kNone || pending->done) {
        lane.nodes += pending->nodes.load(std::memory_order_acquire);
        if (lane.stop != WindowsV1UiaStop::kNone) {
          pending->abandoned.store(lane.stop, std::memory_order_release);
          return false;
        }
        if (!pending->succeeded)
          return false;
        *tree = std::move(pending->tree);
        *nodes = pending->tree_nodes;
        return true;
      }
    }
    pending->ready.wait_for(lock, std::chrono::milliseconds(20));
  }
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
      WindowsV1UiaRead(name, [&] { return element->get_CurrentName(&name); }) &&
      WindowsV1UiaRead(automation_id, [&] { return element->get_CurrentAutomationId(&automation_id); }) &&
      WindowsV1UiaRead(help, [&] { return element->get_CurrentHelpText(&help); }) &&
      WindowsV1UiaRead(control_type, [&] { return element->get_CurrentControlType(&control_type); }) &&
      WindowsV1UiaRead(password, [&] { return element->get_CurrentIsPassword(&password); });
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
        WindowsV1UiaCall(parent, [&] { return walker->GetParentElement(current, &parent); });
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
      WindowsV1UiaContact(element, [&] { return automation->ElementFromPoint(query, &element); });
  automation->Release();
  if (!WindowsV1UiaOk(found) || element == nullptr) {
    if (element != nullptr)
      element->Release();
    return {};
  }
  int owner_pid = 0;
  if (!WindowsV1UiaRead(owner_pid, [&] { return element->get_CurrentProcessId(&owner_pid); }) || owner_pid <= 0 ||
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
      WindowsV1UiaContact(element, [&] { return automation->GetFocusedElement(&element); });
  automation->Release();
  if (!WindowsV1UiaOk(found) || element == nullptr) {
    if (element != nullptr)
      element->Release();
    return {};
  }
  int owner_pid = 0;
  if (!WindowsV1UiaRead(owner_pid, [&] { return element->get_CurrentProcessId(&owner_pid); }) || owner_pid <= 0 ||
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
      WindowsV1UiaRead(owner_pid, [&] { return element->get_CurrentProcessId(&owner_pid); }) && owner_pid > 0 &&
      static_cast<std::uint32_t>(owner_pid) == expected_pid &&
      WindowsV1UiaRead(control_type, [&] { return element->get_CurrentControlType(&control_type); }) &&
      WindowsV1UiaRead(bounds, [&] { return element->get_CurrentBoundingRectangle(&bounds); }) &&
      bounds.right > bounds.left && bounds.bottom > bounds.top &&
      (containing_bounds == nullptr ||
       (bounds.left >= containing_bounds->left &&
        bounds.top >= containing_bounds->top &&
        bounds.right <= containing_bounds->right &&
        bounds.bottom <= containing_bounds->bottom)) &&
      WindowsV1UiaRead(automation_id, [&] { return element->get_CurrentAutomationId(&automation_id); }) &&
      WindowsV1UiaRead(runtime_id, [&] { return element->GetRuntimeId(&runtime_id); }) && runtime_id != nullptr &&
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
      WindowsV1UiaRead(automation_id, [&] { return element->get_CurrentAutomationId(&automation_id); }) &&
      WindowsV1UiaRead(name, [&] { return element->get_CurrentName(&name); });
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
      WindowsV1UiaCall(child, [&] { return walker->GetFirstChildElement(element, &child); });
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
        WindowsV1UiaCall(next, [&] { return walker->GetNextSiblingElement(child, &next); });
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
      WindowsV1UiaOk(WindowsV1UiaContact(root, [&] { return automation->ElementFromHandle(window, &root); })) &&
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
      WindowsV1UiaContact(element, [&] { return automation->GetFocusedElement(&element); });
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
      WindowsV1UiaRead(automation_id, [&] { return element->get_CurrentAutomationId(&automation_id); }) &&
      WindowsV1UiaRead(name, [&] { return element->get_CurrentName(&name); });
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
  if (!WindowsV1UiaOk(WindowsV1UiaCall(child, [&] { return walker->GetFirstChildElement(element, &child); }))) {
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
    if (!WindowsV1UiaOk(WindowsV1UiaCall(next, [&] { return walker->GetNextSiblingElement(child, &next); }))) {
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
      WindowsV1UiaOk(WindowsV1UiaContact(root, [&] { return automation->ElementFromHandle(session.active_window, &root); })) &&
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
  const bool read = WindowsV1UiaRead(*pattern, [&] { return target->GetCurrentPatternAs(id, IID_PPV_ARGS(pattern)); });
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
    const bool name_read = WindowsV1UiaRead(name, [&] { return target->get_CurrentName(&name); });
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
      if (!WindowsV1UiaRead(current, [&] { return pattern->get_CurrentToggleState(&current); }) ||
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
      if (!WindowsV1UiaRead(current, [&] { return pattern->get_CurrentExpandCollapseState(&current); }) ||
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
  // S5-c-3 PR-5: a v2 session judges its target again before every input (the preflight that issues
  // the ticket and the dispatch that spends it), and the explicit "not web" table is answered here.
  if (!JudgeWindowsV2Input(session, reason))
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
         ",\"cancellableWindowDiscovery\":true" +
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
        MarkWindowsWireCached(response_cache_order.front(), {}, false);
        response_cache.erase(evicted);
      }
      response_cache_order.pop_front();
    }
    if (incoming_bytes > kMaximumResponseCacheBytes)
      return false;
    response_cache_order.push_back(key);
    response_cache_bytes += incoming_bytes;
    if (!MarkWindowsWireCached(key, request_digest, true)) return false;
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
    // A v2 session's capture also reads who provides each element, and carries the explicit table's
    // "not web" answer of this frame's judgement (S5-c-3 PR-5). Every other session: not asked.
    WindowsStrictCaptureIdentity strict;
    strict.asked = session.eligibility_basis == EligibilityBasis::kV2Denylist;
    strict.process_id = strict.asked ? session.pid : 0;
    strict.target_not_web = strict.asked ? session.v2_input_not_web : std::nullopt;
    // Single-flight: a worker still stuck from an earlier evaluation means no second one.
    std::atomic<bool> &running = InterlockWorkerRunning();
    if (running.exchange(true)) {
      unavailable.no_verdict = InterlockNoVerdict::kBudget;
      return unavailable;
    }
    try {
      std::thread([pending, window, point, maximum_mode, policy_language, kind_copy, key,
                   target_id, ruleset_copy, strict, expected_epoch, click_tracked, click_opens,
                   &running]() {
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
                                                        ruleset_copy, strict);
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
  // The session's policy (S5-c-3 PR-3): a v1 session keeps the answer as it is (no verdict, V1
  // decides); a v2 session takes over what the interlocks could not judge and is answered by the strict
  // map. A basis this build does not admit is answered strictly.
  return sprint_coder::computer_use::ApplyIncompletePolicy(
      evaluation, sprint_coder::computer_use::SessionInterlockPolicy(
                      session.eligibility_basis, sprint_coder::computer_use::kNativeEligibilityIsV2));
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
                          std::string *reason,
                          std::optional<std::uint64_t> queued_stop_serial = std::nullopt) {
  RECT bounds{};
  WindowsDialogSetSnapshot dialogs;
  // The UI Automation reads of the whole observe share one budget and the cancellation epoch (see the
  // bounds above). The reason of a read that did not complete says why (WindowsV1ObserveReason).
  const WindowsV1UiaPath uia_path(kWindowsV1UiaObserveBudget, session.cancel_epoch,
      queued_stop_serial.value_or(WindowsTargetListControl().stop_serial.load(std::memory_order_acquire)));
  const auto unreadable = [&uia_path](const char *otherwise) -> const char * {
    if (uia_path.Stop() == WindowsV1UiaStop::kBudget) {
      // Only a count (never a label or a text): how far the walks got before the budget was spent.
      const std::string note = "computer-use: observe UI Automation budget spent after " +
                               std::to_string(uia_path.Nodes()) + " nodes\n";
      OutputDebugStringA(note.c_str());
    }
    return WindowsV1ObserveReason(uia_path.Stop(), otherwise);
  };
  if (!WindowsV1UiaMayCall()) {
    *reason = unreadable("observation_stale");
    return false;
  }
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
          // The V1 resolution (search, signature, risk) and the signature the read checks run on
          // this worker inside ONE bounded V1 path (#820), with the epoch of the request: the first
          // timed-out call ends them all and a Cancel stops them before the next call. Outside a path
          // the V1 calls are refused, so without it no node could be read. The path's budget is the
          // lane's wait: once the lane has given up (abandoned), the walk ends at its next call
          // instead of holding the single-flight slot, which the interlock entry shares, for as long
          // as a large tree takes.
          const WindowsV1UiaPath uia_path(kInterlockLaneHoldLimit, expected_epoch);
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
                       const Frame &request, bool *handshaken,
                       std::optional<std::uint64_t> queued_stop_serial = std::nullopt,
                       std::shared_ptr<WindowsStartLease> start_lease = nullptr,
                       const std::string& admission_error = {},
                       WindowsDiscoveryAdmission discovery = {},
                       WindowsDiscoveryStopPump* discovery_stop_pump = nullptr) {
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
  if (!admission_error.empty() && type != MessageType::kHandshake)
    return Respond(pipe, request, MessageType::kError, ErrorPayload(admission_error));
  if (type != MessageType::kHandshake) {
    bool replayed = false;
    if (!ReplayCachedResponse(pipe, request, &replayed))
      return false;
    if (replayed)
      return true;
  }
  const WindowsValidationFrameScope validation_frame(queued_stop_serial);
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
    } else if (operation == "list_windows_cancellable") {
      if (discovery.not_admitted) {
        WindowsDiscoveryParameters parsed;
        if (ReadWindowsDiscoveryQuery(metadata, &parsed)) {
          response = WindowsDiscoveryReceiptJson(parsed.id, "not_admitted", 0);
          response.pop_back();
          response += ",\"reason\":\"discovery_capacity\"}";
          succeeded = true;
        } else reason = "discovery_input_invalid";
      } else if (discovery.replay_only) {
        reason = "discovery_id_reuse";
      } else {
        succeeded = RunWindowsDiscovery(metadata, std::move(discovery.lease),
            queued_stop_serial.value_or(WindowsTargetListControl().stop_serial.load()),
            &response, &reason, discovery_stop_pump);
        if (discovery_stop_pump != nullptr && discovery_stop_pump->failed) return false;
      }
    } else if (operation == "stop_window_discovery") {
      succeeded = StopWindowsDiscovery(FrameIdKey(request.header.session_id), metadata,
                                       discovery.lease, &response, &reason);
    } else if (operation == "list_targets") {
      // S5-c-3 PR-5: unsupported_operation in a v1 build.
      succeeded = ListWindowsTargets(&response, &reason, queued_stop_serial);
    } else if (operation == "start_session") {
      if (!admission_error.empty()) reason = admission_error;
      else succeeded = StartWindowsSession(request, metadata, &response, &reason, queued_stop_serial, std::move(start_lease));
    } else if (operation == "stop_pending_start") {
      succeeded = StopPendingWindowsStart(request, metadata, &response, &reason);
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
        ObserveWindowsWindow(*session, &response, &binary, &reason, queued_stop_serial);
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
  struct QueuedFrame {
    Frame frame;
    std::uint64_t stop_serial = 0;
    std::shared_ptr<WindowsStartLease> start_lease;
    std::string admission_error;
    std::shared_ptr<WindowsWireLease> wire_lease;
    WindowsDiscoveryAdmission discovery;
    bool discovery_stop = false;
  };
  std::deque<QueuedFrame> queue;
  bool reader_finished = false;
  bool reader_valid = true;
  std::thread reader([&]() {
    bool reader_handshaken = false;
    Frame request;
    while (ReadFrame(pipe, &request)) {
      if (!IsBoundedUtf8(request.metadata) || !request.binary.empty()) {
        reader_valid = false;
        break;
      }
      const std::string metadata(reinterpret_cast<const char *>(request.metadata.data()),
                                 request.metadata.size());
      std::string operation;
      const auto type = static_cast<MessageType>(request.header.message_type);
      const bool has_operation = type == MessageType::kProbe && ReadJsonString(metadata, "operation", &operation);
      const bool close = has_operation && operation == "close_session";
      const bool pending_stop = has_operation && operation == "stop_pending_start";
      std::shared_ptr<WindowsStartLease> start_lease;
      std::string admission_error;
      WindowsDiscoveryAdmission discovery;
      // This is the same side-effect-free version check used by the consumer. The verified pipe
      // peer may pipeline frames, but cannot obtain an owner before a valid handshake frame.
      if (type == MessageType::kHandshake) {
        std::uint64_t protocol = 0, api = 0;
        if (ReadJsonUint64(metadata, "protocolVersion", &protocol) &&
            ReadJsonUint64(metadata, "apiVersion", &api) && protocol == kProtocolVersion && api == kApiVersion)
          reader_handshaken = true;
      }
      bool fresh_request = false;
      std::shared_ptr<WindowsWireLease> wire_lease;
      if (type != MessageType::kHandshake && reader_handshaken)
        wire_lease = RegisterWindowsWireRequest(ResponseCacheKey(request), RequestPayloadDigest(request),
            &fresh_request, &admission_error);
      if (has_operation && operation == "start_session" && reader_handshaken && admission_error.empty()) {
        WindowsStartParameters parsed;
        if (!ParseWindowsStartParameters(metadata, &parsed)) admission_error = "session_input_invalid";
        else start_lease = AdmitWindowsStart(FrameIdKey(request.header.session_id), parsed.session_id,
            ResponseCacheKey(request), RequestPayloadDigest(request), &admission_error, parsed.cancel_epoch);
      }
      if (has_operation && reader_handshaken && admission_error.empty()) {
        if (operation == "list_windows_cancellable") {
          WindowsDiscoveryParameters parsed;
          if (!ReadWindowsDiscoveryQuery(metadata, &parsed)) admission_error = "discovery_input_invalid";
          else discovery = AdmitWindowsDiscovery(FrameIdKey(request.header.session_id), parsed.id,
              ResponseCacheKey(request), RequestPayloadDigest(request), fresh_request, GetTickCount64(),
              &admission_error);
        } else if (operation == "stop_window_discovery") {
          std::string id;
          if (!ReadWindowsDiscoveryStop(metadata, &id)) admission_error = "discovery_input_invalid";
          else discovery.lease = ReferenceWindowsDiscoveryStop(FrameIdKey(request.header.session_id), id,
                                                               fresh_request);
        }
      }
      if (type == MessageType::kCancel || close || pending_stop) {
        const bool new_cancel = fresh_request && admission_error.empty();
        std::uint64_t requested_epoch = 0;
        if (new_cancel && pending_stop && reader_handshaken) {
          std::string id;
          if (ReadPendingWindowsStop(metadata, &id))
            LatchWindowsPendingStop(FrameIdKey(request.header.session_id), id);
        } else if (new_cancel && !pending_stop &&
            ReadJsonUint64(metadata, "cancelEpoch", &requested_epoch)) {
          auto &control = WindowsTargetListControl();
          std::lock_guard stop_lock(control.stop_mutex);
          // A new Close must stop discovery even when its epoch equals the current input epoch.
          control.stop_serial.fetch_add(1, std::memory_order_acq_rel);
          control.context_candidate.reset();
          // Close invalidates discovery here, but only its consumer owns session epochs. A retry
          // for an already-closed session must not cancel another session or raise the input epoch
          // beyond last_closed_cancel_epoch and prevent a fresh epoch-zero start.
          if (type == MessageType::kCancel) {
            std::uint64_t current =
                cancellation_epoch.load(std::memory_order_acquire);
            while (requested_epoch > current &&
                   !cancellation_epoch.compare_exchange_weak(
                       current, requested_epoch, std::memory_order_acq_rel,
                       std::memory_order_acquire)) {
            }
          }
        }
      }
      {
        std::lock_guard lock(queue_mutex);
        if (queue.size() >= kMaximumQueuedFrames) {
          reader_valid = false;
          break;
        }
        queue.push_back(QueuedFrame{std::move(request),
            WindowsTargetListControl().stop_serial.load(std::memory_order_acquire),
            std::move(start_lease), std::move(admission_error), std::move(wire_lease),
            std::move(discovery), has_operation && operation == "stop_window_discovery"});
      }
      queue_ready.notify_one();
      request = {};
    }
    StopWindowsDiscoveriesForPipeEnd();
    {
      std::lock_guard lock(queue_mutex);
      reader_finished = true;
    }
    queue_ready.notify_one();
  });

  bool handshaken = false;
  bool served = true;
  WindowsDiscoveryStopPump discovery_stop_pump{[&]() {
    // Bound each pass even if the reader keeps receiving Stops. Do not run another query or input.
    for (std::size_t count = 0; count < kMaximumQueuedFrames; ++count) {
      QueuedFrame stopped;
      {
        std::lock_guard lock(queue_mutex);
        const auto next = std::find_if(queue.begin(), queue.end(),
            [](const auto& queued) { return queued.discovery_stop; });
        if (next == queue.end()) return true;
        stopped = std::move(*next);
        queue.erase(next);
      }
      if (!HandlePipeRequest(pipe, probe, stopped.frame, &handshaken, stopped.stop_serial,
                             std::move(stopped.start_lease), stopped.admission_error,
                             std::move(stopped.discovery))) return false;
    }
    return true;
  }};
  for (;;) {
    QueuedFrame queued;
    {
      std::unique_lock lock(queue_mutex);
      queue_ready.wait(lock,
                       [&]() { return reader_finished || !queue.empty(); });
      if (queue.empty())
        break;
      queued = std::move(queue.front());
      queue.pop_front();
    }
    if (!HandlePipeRequest(pipe, probe, queued.frame, &handshaken, queued.stop_serial,
                           std::move(queued.start_lease), queued.admission_error,
                           std::move(queued.discovery), &discovery_stop_pump)) {
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
  WarmWindowsV1Automation();
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
    // The lineage root of the v2 facts (W8): Main, the parent this helper verified and the one client
    // its pipe accepted, fixed before the first request (the facts context reads it once, then).
    windows_v2_main_pid = static_cast<std::uint32_t>(client_pid);
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
  DrainWindowsDiscoveryLaunchesForExit();
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
