
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
// Received once from the authenticated connection. Missing generation never authorizes approval.
std::uint64_t windows_helper_generation = 0;
constexpr bool kWindowsApprovalHandlersEnabled = false;
std::uint64_t MonotonicNowNs();

// BEGIN windows worker slot launches
// A single-flight worker slot (UIA read, capture, target list, interlock) that numbers every time it is
// taken. The request whose WindowsResidualRequestScope is installed on the taking thread records that
// launch, so a response is charged only for workers its own request started: not for a slot an earlier
// request or the effect shadow holds, and not for one that was released and taken again. The slot is
// taken only through exchange(true), store(true) or assigning true on this type; a std::atomic<bool>
// reference to it only loads and releases it.
class WindowsWorkerSlot;
struct WindowsWorkerLaunch {
  const WindowsWorkerSlot *slot = nullptr;
  std::uint64_t serial = 0;
};
// Only the latest launch of a slot can still hold it, so after dropping the ended ones the entries
// never run out (four slots); `overflow` is kept anyway and then never counts as retired.
struct WindowsWorkerLaunches {
  std::array<WindowsWorkerLaunch, 8> entries{};
  std::size_t count = 0;
  bool overflow = false;
  void Add(const WindowsWorkerSlot *slot, std::uint64_t serial) noexcept;
  [[nodiscard]] WindowsWorkerLaunches Holding() const noexcept;
  [[nodiscard]] bool Retired() const noexcept { return !overflow && Holding().count == 0; }
};
// Set only on the consumer thread, while it serves one request (WindowsResidualRequestScope). So a
// request owns the launches made on that thread alone: a launch for a request must be made on the
// consumer thread, or the response is not flagged and Main is never told to wait for that worker.
// Off it (worker threads, the effect shadow) this stays null and a launch is no request's work.
thread_local WindowsWorkerLaunches *windows_worker_launches = nullptr;

class WindowsWorkerSlot : public std::atomic<bool> {
public:
  WindowsWorkerSlot() noexcept : std::atomic<bool>(false) {}
  // Hides std::atomic<bool>::exchange: taking the slot numbers the launch and records it.
  bool exchange(bool desired, std::memory_order order = std::memory_order_seq_cst) noexcept {
    const bool previous = std::atomic<bool>::exchange(desired, order);
    if (desired && !previous) {
      const auto serial = launches_.fetch_add(1, std::memory_order_acq_rel) + 1;
      if (windows_worker_launches != nullptr) windows_worker_launches->Add(this, serial);
    }
    return previous;
  }
  // Hides std::atomic<bool>::store: a store of true takes the slot like exchange(true) and is numbered.
  void store(bool desired, std::memory_order order = std::memory_order_seq_cst) noexcept {
    if (desired) (void)exchange(true, order == std::memory_order_release ? std::memory_order_acq_rel : order);
    else std::atomic<bool>::store(false, order);
  }
  // No slot is taken by compare-exchange; deleting it keeps every take numbered.
  bool compare_exchange_strong(bool &, bool, std::memory_order = std::memory_order_seq_cst) = delete;
  bool compare_exchange_weak(bool &, bool, std::memory_order = std::memory_order_seq_cst) = delete;
  // Assigning true takes the slot like exchange(true), so it is numbered too.
  bool operator=(bool desired) noexcept {
    store(desired);
    return desired;
  }
  // Whether the worker started as launch `serial` still holds the slot.
  [[nodiscard]] bool Holds(std::uint64_t serial) const noexcept {
    return load(std::memory_order_acquire) && launches_.load(std::memory_order_acquire) == serial;
  }
private:
  std::atomic<std::uint64_t> launches_{0};
};

inline void WindowsWorkerLaunches::Add(const WindowsWorkerSlot *slot, std::uint64_t serial) noexcept {
  if (count == entries.size()) *this = Holding();
  if (count == entries.size()) {
    overflow = true;
    return;
  }
  entries[count++] = {slot, serial};
}

inline WindowsWorkerLaunches WindowsWorkerLaunches::Holding() const noexcept {
  WindowsWorkerLaunches held;
  held.overflow = overflow;
  for (std::size_t index = 0; index < count; ++index)
    if (entries[index].slot->Holds(entries[index].serial)) held.entries[held.count++] = entries[index];
  return held;
}
// END windows worker slot launches

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

struct WindowsRoundTripMonitor;
struct WindowsBackgroundMonitor;
struct WindowsSession {
  std::shared_ptr<WindowsBackgroundMonitor> background_monitor;
  std::shared_ptr<sprint_coder::computer_use::WindowsApprovalRoundTrip> round_trip;
  std::shared_ptr<WindowsRoundTripMonitor> round_trip_monitor;
  std::uint64_t approved_started_ns = 0;
  std::uint64_t approved_deadline_ns = 0;
  std::uint64_t approved_stop_serial = 0;
  std::uint64_t approved_helper_generation = 0;
  bool approved_click_tracked = false;
  bool approved_click_opens = false;
  bool approved_click_input_read = false;
  DWORD approved_click_input_tick = 0;
  std::shared_ptr<WindowsStartAdmission> start_owner;
  // Counts API attempts, never inferred successful effects. Shared by session refocus copies.
  std::shared_ptr<std::atomic<std::uint64_t>> input_api_attempts =
      std::make_shared<std::atomic<std::uint64_t>>(0);
  std::string session_id;
  std::uint32_t pid = 0;
  HWND window = nullptr;
  sprint_coder::computer_use::InputSession input_session;
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
  bool approval_route_v2 = false;
  std::uint64_t approval_helper_generation = 0;
  mutable bool approval_revoked = false;
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

// Start evaluates capability and binding before the operation-mode check.
bool WindowsRoundTripCurrent(const WindowsSession &session);
bool WindowsRoundTripMayInput(const WindowsSession &session);

bool WindowsApprovalSessionBindingCurrent(const WindowsSession &session) {
  return !session.approval_revoked &&
      session.approval_route_v2 && windows_helper_generation != 0 &&
      session.approval_helper_generation == windows_helper_generation &&
      session.eligibility_basis == sprint_coder::computer_use::EligibilityBasis::kV2Denylist;
}

bool WindowsApprovalSessionGate(const WindowsSession &session) {
  return kWindowsApprovalHandlersEnabled && WindowsApprovalSessionBindingCurrent(session);
}

bool WindowsSemanticInputInFlightLocked();
bool WindowsSemanticInputInFlight();
bool StopWindowsSemanticInput(const WindowsSession &session, std::uint64_t *attempts);
void DrainWindowsSemanticInputForExit();

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
std::unordered_map<std::string, sprint_coder::computer_use::WindowsApprovalHandlers> approval_states;

void InvalidateWindowsTicket(const std::string &session_key) {
  const auto found = ticket_states.find(session_key);
  if (found == ticket_states.end()) return;
  found->second.slot.Invalidate();
  ++found->second.generation;
}

void ForgetWindowsTicket(const std::string &session_key) {
  approval_states.erase(session_key);
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
  bool include_start_identity = false;
};

struct WindowsDiscoveryStringField {
  std::string_view key;
  std::string* value;
  bool seen = false;
};

bool ReadWindowsDiscoveryFields(std::string_view metadata,
                                std::span<WindowsDiscoveryStringField> fields,
                                bool* include_start_identity = nullptr) {
  std::size_t cursor = 0;
  const auto space = [&] {
    while (cursor < metadata.size() && (metadata[cursor] == ' ' || metadata[cursor] == '\t' ||
           metadata[cursor] == '\r' || metadata[cursor] == '\n')) ++cursor;
  };
  space();
  if (cursor >= metadata.size() || metadata[cursor++] != '{') return false;
  bool identity_seen = false;
  if (include_start_identity) *include_start_identity = false;
  for (std::size_t member = 0; member <= fields.size(); ++member) {
    space(); std::string key, value;
    if (!ReadJsonStringValueAt(metadata, &cursor, &key)) return false;
    space(); if (cursor >= metadata.size() || metadata[cursor++] != ':') return false;
    space();
    if (key == "includeStartIdentity" && include_start_identity && !identity_seen) {
      identity_seen = true;
      if (metadata.substr(cursor, 4) == "true") { *include_start_identity = true; cursor += 4; }
      else if (metadata.substr(cursor, 5) == "false") cursor += 5;
      else return false;
    } else {
      if (!ReadJsonStringValueAt(metadata, &cursor, &value)) return false;
      const auto field = std::find_if(fields.begin(), fields.end(),
          [&](const auto& candidate) { return candidate.key == key; });
      if (field == fields.end() || field->seen) return false;
      field->seen = true; *field->value = std::move(value);
    }
    space();
    if (cursor >= metadata.size()) return false;
    const char separator = metadata[cursor++];
    if (separator == '}') {
      space();
      return cursor == metadata.size() && std::all_of(fields.begin(), fields.end(),
          [](const auto& field) { return field.seen; });
    }
    if (separator != ',') return false;
  }
  return false;
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
  return ReadWindowsDiscoveryFields(metadata, fields, &output->include_start_identity) && operation == "list_windows_cancellable" &&
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

