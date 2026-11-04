// BEGIN windows v2 targets (#500 S5-c-3 PR-5)
// The v2 target eligibility, wired: list_targets, and the v2 start, resume and per-input judgement.
// Every one of them measures the target from its running image (MeasureWindowsTargetFacts), judges
// it with the shared core (ClassifyTarget) and takes the mode from the core alone: the policy
// language (the app's own MUI claim) is not a ground for the mode on this path. The V1 deny-side
// checks (the leaf table, the proxy table, elevation) are applied on top, so either refuses (ADR v2
// section 3.2.1-5). v2 builds only: a v1 build answers list_targets with unsupported_operation and
// admits no v2 session (EligibilityBasisAdmitted). The shared synchronous new-start path also serves V1,
// with its own unchanged eligibility branch and without V2 facts or context.
//
// What crosses to Main: a selectable row carries the identity Main binds a grant and a token to
// (with the path and the pid, which Main keeps to itself: ADR section 3.2.2); a refused row carries
// its kind and nothing else, no title, class, leaf, pid or identity (ADR section 3.2.1-4).

inline constexpr std::size_t kWindowsListTargetsRowLimit = 64;
// The consumer's wait budget for list_targets. Completed rows survive it; unfinished measurements
// are unresolvable. Listing, new V2 starts, session identity reads and V2 rejudgements share one
// measurement slot. Listing measures on a worker, and a driver may ignore best-effort
// CancelSynchronousIo, so list cleanup can keep it occupied after the consumer answers. New starts,
// identity reads and rejudgements keep the slot on the consumer through cleanup before the response.
// This list-only deadline is not a new native start deadline.
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
  HANDLE new_start_thread = nullptr;
  std::atomic<std::uint64_t> stop_serial{0};
  WindowsWorkerSlot running;  // numbered launches: WindowsResidualRequestScope (N5-B2)
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

// Caller holds stop_mutex, which also protects registration and handle lifetime.
void CancelWindowsNewStartMeasurementLocked(WindowsTargetListState& control) {
  if (control.new_start_thread != nullptr) CancelSynchronousIo(control.new_start_thread);
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
    CancelWindowsNewStartMeasurementLocked(control);
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
    context = CurrentWindowsTargetFactsContext(windows_v2_main_pid, WindowsV2SelfSignerThumbprint());
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
  std::optional<sprint_coder::computer_use::WindowsPackageIdentityParts> not_web_package;
  // The identity above is read once, the first time a window of the process is selectable.
  bool identity_read = false;
  bool identity_ok = false;
  // Set only by a successful prestart measurement that supplies the limited exception.
  bool explorer_prestart_admitted = false;

  [[nodiscard]] bool Selectable() const {
    using sprint_coder::computer_use::TargetVerdictKind;
    return verdict.kind == TargetVerdictKind::kEligible || verdict.kind == TargetVerdictKind::kUpper;
  }
};

// A value snapshot owned by the current measurement lane, never a process-wide permission.
struct WindowsExplorerPrestartScope {
  std::uint64_t generation = 0, epoch = 0, stop_serial = 0;
  std::function<bool()> current;
};

bool MeasureWindowsExplorerPrestart(const WindowsV2Judgement &process, HWND window,
                                    const WindowsExplorerPrestartScope &scope);

// Only W-SYS's Windows-directory exclusion is replaced by the verified Explorer route.
// All other denials (including incomplete facts) still win, regardless of rule order.
sprint_coder::computer_use::TargetVerdict WindowsExplorerPrestartVerdict(
    const sprint_coder::computer_use::TargetFacts &facts) {
  using namespace sprint_coder::computer_use;
  using namespace target_eligibility_detail;
  if (!TargetFactsAreComplete(facts)) return {};
  const auto bit = TargetPlatformBit(facts.platform);
  for (const auto &rule : kTargetRules)
    if (rule.verdict == TargetRuleVerdict::kDenied && rule.class_id != "W-SYS" &&
        (rule.platforms & bit) != 0 && AllHold(facts, rule.when))
      return {TargetVerdictKind::kDenied, {}};
  // Explorer never falls back to observe-only when its approval capability is missing.
  if (!kWindowsApprovalHandlersEnabled || windows_helper_generation == 0)
    return {TargetVerdictKind::kDenied, {}};
  return {TargetVerdictKind::kUpper, "supervised"};
}

// The core's verdict for these facts, with the V1 deny-side tables on top. Refusals never become
// eligible here; a missing piece is unresolvable.
sprint_coder::computer_use::TargetVerdict
WindowsV2VerdictFor(const WindowsTargetFactsMeasurement &measured) {
  using namespace sprint_coder::computer_use;
  TargetVerdict verdict = ClassifyTarget(measured.facts);
  if (verdict.kind == TargetVerdictKind::kUpper &&
      (!kWindowsApprovalHandlersEnabled || windows_helper_generation == 0))
    verdict.maximum_mode = "observe_only";
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
  if constexpr (sprint_coder::computer_use::kWindowsStoreNotepadNotWeb) {
    if (out->package.has_value()) {
      using sprint_coder::computer_use::WindowsPackageIdentityParts;
      out->not_web_package = WindowsPackageIdentityParts{
          out->package->family, out->package->publisher_id, out->package->relative_path, {}};
    }
  }
  out->identity_ok = true;
  return true;
}

bool WindowsExplorerVerifiedWindow(DWORD pid, HWND window) {
  const auto measured = MeasureWindowsTargetFacts(pid, window, WindowsV2FactsContext());
  return sprint_coder::computer_use::WindowsTargetIsVerifiedExplorer(measured.facts) &&
         measured.facts.window_class == std::optional<std::string>("CabinetWClass");
}

// A class only excludes windows of an
// already verified Explorer; it cannot establish an executable identity or an eligibility route.
[[nodiscard]] bool WindowsExplorerFileWindowRestriction(
    const sprint_coder::computer_use::TargetFacts &facts,
    std::optional<bool> shell_view_is_filesystem_folder = std::nullopt) {
  // CabinetWClass is necessary, not sufficient. P5 supplies measured shell-view evidence.
  return shell_view_is_filesystem_folder == std::optional<bool>(true) &&
         sprint_coder::computer_use::WindowsTargetIsVerifiedExplorer(facts) &&
         facts.window_class == std::optional<std::string>("CabinetWClass");
}

// The judgement of one window of the process: the process's facts with this window's own class.
// Each window is judged by itself, so neither the order the windows are listed in nor another
// window of the process (a console it allocated, a window gone between listing and measuring)
// changes its answer. A class that cannot be read leaves the facts incomplete: unresolvable.
sprint_coder::computer_use::TargetVerdict
WindowsV2VerdictForWindowClass(WindowsV2Judgement *process,
                               const std::optional<std::string> &window_class,
                               sprint_coder::computer_use::TargetFacts *measured_facts = nullptr,
                               HWND window = nullptr,
                               const WindowsExplorerPrestartScope *explorer_scope = nullptr) {
  using namespace sprint_coder::computer_use;
  WindowsTargetFactsMeasurement for_window = process->measured;
  process->explorer_prestart_admitted = false;
  for_window.facts.window_class = window_class;
  if (measured_facts != nullptr)
    *measured_facts = for_window.facts;
  TargetVerdict verdict = WindowsV2VerdictFor(for_window);
  if constexpr (kWindowsExplorerException) {
    const bool measured_view = explorer_scope && WindowsTargetIsVerifiedExplorer(for_window.facts) &&
        window_class == std::optional<std::string>("CabinetWClass") &&
        EnsureWindowsV2Identity(process) && !IsKnownProxyExecutable(for_window.image_path) &&
        !IsProcessElevated(for_window.pid) &&
        MeasureWindowsExplorerPrestart(*process, window, *explorer_scope);
    if (WindowsExplorerFileWindowRestriction(for_window.facts, measured_view)) {
      verdict = WindowsExplorerPrestartVerdict(for_window.facts);
      process->explorer_prestart_admitted = verdict.kind == TargetVerdictKind::kUpper;
    }
  }
  if ((verdict.kind == TargetVerdictKind::kEligible || verdict.kind == TargetVerdictKind::kUpper) &&
      !EnsureWindowsV2Identity(process))
    verdict = TargetVerdict{TargetVerdictKind::kUnresolvable, {}};
  return verdict;
}

// Judges one window of one process (the start, the resume and every input of a v2 session).
void JudgeWindowsV2Target(std::uint32_t pid, HWND window, const WindowsTargetFactsContext &context,
                          WindowsV2Judgement *out,
                          const WindowsExplorerPrestartScope *explorer_scope = nullptr) {
  MeasureWindowsV2Process(pid, context, out);
  const std::optional<std::string> window_class = WindowsTargetWindowClass(window, pid);
  out->verdict = WindowsV2VerdictForWindowClass(out, window_class, nullptr, window, explorer_scope);
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
                                   const WindowsV2RowWindow &window,
                                   bool include_start_identity = false) {
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
         ",\"facts\":" + WindowsV2TargetFactsJson(facts) +
         (include_start_identity ? ",\"processStartTime\":\"" + judgement.process_start + "\"" : "") + "}";
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
                                std::string *response, std::string *reason,
                                bool include_start_identity = false) {
  using namespace sprint_coder::computer_use;
  // Without Main's pid there is no lineage root: nothing is enumerated or measured.
  if (windows_v2_main_pid == 0 || !context_valid()) return false;
  const auto &cached = WindowsV2FactsContextCache();
  const bool had_cached_context = cached.has_value();
  WindowsTargetFactsContext context = had_cached_context ? *cached : CurrentWindowsTargetFactsContext(
      windows_v2_main_pid, WindowsV2SelfSignerThumbprint(), context_valid);
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
    WindowsExplorerPrestartScope explorer_scope;
    if constexpr (kWindowsExplorerException) {
      explorer_scope = {generation, cancellation_epoch.load(std::memory_order_acquire),
                        expected_stop, still_valid};
    }
    const TargetVerdict verdict =
        WindowsV2VerdictForWindowClass(&judgement, WindowsTargetWindowClass(window, owner),
                                       &window_facts, window, &explorer_scope);
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
    rows.push_back(WindowsV2SelectableRow(judgement, verdict, window_facts, row_window, include_start_identity));
  }
  if (!truncated) remaining = 0;
  publish();
  if (!still_valid()) return false;
  *response = WindowsV2ListResponse(generation, DenyRulesetVersion(TargetPlatform::kWin32),
                                    truncated || rows.Truncated(), rows);
  return true;
}

bool ListWindowsTargets(std::string *response, std::string *reason,
                        std::optional<std::uint64_t> queued_stop_serial = std::nullopt,
                        bool include_start_identity = false) {
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
      std::thread([pending, still_valid, context_valid, expected_stop, generation, include_start_identity] {
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
                                                    pending.get(), &built, &failure, include_start_identity);
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
// Defined alongside the frame scope below.
std::uint64_t WindowsValidationFrameStopSerial();

struct WindowsV2RejudgeResult {
  bool matches = false;
  bool not_web = false;
  std::optional<WindowsTargetFactsContext> context;
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
  std::uint64_t generation = 0;
  ScopedKernelHandle executable;
};

bool WindowsV2RejudgeStillCurrent(std::uint64_t epoch, std::uint64_t stop_serial) {
  return !parent_process_dead.load(std::memory_order_acquire) &&
      cancellation_epoch.load(std::memory_order_acquire) == epoch &&
      WindowsTargetListControl().stop_serial.load(std::memory_order_acquire) == stop_serial;
}

WindowsV2RejudgeResult MeasureWindowsV2Rejudge(const WindowsV2RejudgeWork &work) {
#if defined(SPRINT_CODER_COMPUTER_USE_TEST_HANG)
  WindowsTestHang(WindowsTestHangPoint::Rejudge);
#endif
  const auto still_valid = [&] {
    return WindowsV2RejudgeStillCurrent(work.epoch, work.stop_serial);
  };
  WindowsV2RejudgeResult result;
  if (work.main_pid == 0 || !still_valid()) return result;
  WindowsTargetFactsContext context;
  if (work.context.has_value()) {
    context = *work.context;
  } else {
    // The cold context and signer lookup both run on the consumer, before any target judgement.
    std::string signer = WindowsV2SelfSignerThumbprint();
    if (!still_valid()) return result;
    context = CurrentWindowsTargetFactsContext(work.main_pid, std::move(signer),
                                               still_valid);
  }
  if (!still_valid() || context.lineage_root_pid != work.main_pid) return result;
  WindowsV2Judgement judged;
  WindowsExplorerPrestartScope explorer_scope;
  if constexpr (sprint_coder::computer_use::kWindowsExplorerException) {
    explorer_scope = {work.generation, work.epoch, work.stop_serial, still_valid};
  }
  JudgeWindowsV2Target(work.pid, work.window, context, &judged, &explorer_scope);
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
        /*session_recorded=*/true, judged.not_web_package);
  // As before, a completed cold context can survive a target refusal. An exception or Stop never
  // supplies a candidate, and only the consumer may turn this pure value into the active cache.
  if (!work.context.has_value()) result.context = std::move(context);
  return result;
}

WindowsV2RejudgeResult RunWindowsV2RejudgeMeasurement(const WindowsV2RejudgeWork &work);

// What a v2 session's start (or resume) and every input re-judge: the target is still selectable,
// with the mode, the application identity (the package digest for a package), the process start and
// the held running image the session was bound to. `not_web` is the explicit table's answer for this
// judgement: the session's recorded notepad file, still the very file it was.
bool RejudgeWindowsV2Session(const WindowsSession &session, std::optional<bool> *not_web,
                             std::string *reason) {
  *reason = "session_identity_changed";
  const std::uint64_t epoch = session.cancel_epoch;
  const std::uint64_t stop_serial = WindowsValidationFrameStopSerial();
  auto &control = WindowsTargetListControl();
  {
    std::lock_guard stop_lock(control.stop_mutex);
    if (!WindowsV2RejudgeStillCurrent(epoch, stop_serial) || windows_v2_main_pid == 0 ||
        control.running.exchange(true, std::memory_order_acq_rel))
      return false;
  }
  // Release the shared slot only after the owned executable handle is closed.
  // Main's kill-stop bounds a consumer blocked outside cancellable synchronous I/O.
  struct Slot {
    ~Slot() { WindowsTargetListWorkerRunning().store(false, std::memory_order_release); }
  } slot;
  WindowsV2RejudgeWork work;
  work.pid = session.pid;
  work.window = session.window;
  work.maximum_mode = session.maximum_mode;
  work.app_identity = session.app_identity;
  work.process_start = session.process_start;
  work.not_web_file = session.not_web_file;
  work.epoch = epoch;
  work.stop_serial = stop_serial;
  if constexpr (sprint_coder::computer_use::kWindowsExplorerException)
    work.generation = windows_v2_list_generation;
  work.main_pid = windows_v2_main_pid;
  work.context = WindowsV2FactsContextCache();
  const std::uint32_t main_pid = work.main_pid;
  if (session.executable_file == INVALID_HANDLE_VALUE ||
      !DuplicateHandle(GetCurrentProcess(), session.executable_file, GetCurrentProcess(), &work.executable.value,
                       0, FALSE, DUPLICATE_SAME_ACCESS))
    return false;
  WindowsV2RejudgeResult measured;
  try {
    measured = RunWindowsV2RejudgeMeasurement(work);
  } catch (...) {
    return false;
  }
  // The value and context are adopted together under Stop, never after it.
  std::lock_guard stop_lock(control.stop_mutex);
  if (!WindowsV2RejudgeStillCurrent(epoch, stop_serial) || windows_v2_main_pid != main_pid)
    return false;
  if (measured.context.has_value() &&
      measured.context->lineage_root_pid == main_pid && !WindowsV2FactsContextCache().has_value())
    WindowsV2FactsContextCache() = std::move(measured.context);
  if (!measured.matches) return false;
  if (not_web != nullptr) *not_web = measured.not_web;
  reason->clear();
  return true;
}
// END windows v2 rejudge

// Before every input (ValidateWindowsDispatchBinding: the preflight that issues the ticket and the
// dispatch that spends it): a v2 session's target is judged again and the explicit table answers for
// the interlock of the same frame. A v1 session: nothing, as before.
bool JudgeWindowsV2Input(const WindowsSession &session, std::string *reason) {
  session.v2_input_not_web.reset();
  if (session.maximum_mode == "supervised" && !WindowsApprovalSessionGate(session)) {
    session.approval_revoked = true;
    *reason = "native_approval_closed";
    return false;
  }
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
// signer, and the very file `locked` holds). The mode is the core's. `not_web_file` is the
// notepad file the explicit table matched, recorded for the session's life.
bool AdmitWindowsV2StartInContext(
    std::uint32_t pid, HWND window, const LockedWindowsExecutable &locked,
    const WindowsTargetFactsContext &context, std::uint64_t ruleset_version,
    std::uint64_t generation, std::uint64_t expected_generation, bool new_session,
    std::string_view app_identity, std::string_view executable_digest,
    std::string_view signer_digest, std::string *maximum_mode,
    std::optional<sprint_coder::computer_use::WindowsFileKey> *not_web_file,
    const WindowsExplorerPrestartScope *explorer_scope = nullptr,
    bool *explorer_admitted = nullptr) {
  using namespace sprint_coder::computer_use;
  if constexpr (kWindowsExplorerException) {
    if (explorer_admitted) *explorer_admitted = false;
  }
  if (context.lineage_root_pid == 0 || ruleset_version == 0 ||
      ruleset_version != DenyRulesetVersion(TargetPlatform::kWin32) ||
      (new_session && (generation == 0 || generation != expected_generation)))
    return false;
  WindowsV2Judgement judged;
  JudgeWindowsV2Target(pid, window, context, &judged, explorer_scope);
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
  if constexpr (kWindowsExplorerException) {
    if (explorer_admitted)
      *explorer_admitted = judged.explorer_prestart_admitted;
  }
  *not_web_file = WindowsTargetIsNotWebByTable(judged.measured.facts, judged.held_key,
                                               judged.table_key, std::nullopt,
                                               /*session_recorded=*/false, judged.not_web_package)
                      ? judged.held_key
                      : std::nullopt;
  return true;
}

bool AdmitWindowsV2Start(std::uint32_t pid, HWND window, const LockedWindowsExecutable &locked,
                         const std::string &metadata, bool new_session,
                         std::string_view app_identity, std::string_view executable_digest,
                         std::string_view signer_digest, std::string *maximum_mode,
                         std::optional<sprint_coder::computer_use::WindowsFileKey> *not_web_file) {
  // The synchronous resume entry retains its I/O guard. A new start uses only its context
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
// P2a has no production capability table. P8 must connect verified provenance before opening it;
// no request, environment variable or Renderer value can enable this path.
bool WindowsBackgroundStartGate() {
  return sprint_coder::computer_use::kWindowsBackgroundInputEnabled;
}

bool WindowsBackgroundTargetSupported(const WindowsExecutableIdentity &) { return false; }

sprint_coder::computer_use::WindowsBackgroundStartFacts
MeasureWindowsBackgroundStartFacts(std::uint32_t pid, HWND window, RECT *bounds) {
  using sprint_coder::computer_use::WindowsBackgroundStartFacts;
  WindowsBackgroundStartFacts facts;
  DWORD owner = 0;
  const DWORD thread = GetWindowThreadProcessId(window, &owner);
  if (!IsWindow(window) || thread == 0 || owner != pid || !ClientBoundsPhysical(window, bounds))
    return facts;
  DWORD foreground_pid = 0;
  const HWND foreground = GetForegroundWindow();
  if (foreground == nullptr || GetWindowThreadProcessId(foreground, &foreground_pid) == 0 ||
      foreground_pid == pid || IsNativeTakeoverWindow(foreground)) return facts;
  facts.visible = IsWindowVisible(window) == TRUE;
  facts.not_minimized = IsIconic(window) == FALSE;
  facts.enabled = IsWindowEnabled(window) == TRUE;
  DWORD cloaked = 0;
  if (SUCCEEDED(DwmGetWindowAttribute(window, DWMWA_CLOAKED, &cloaked, sizeof(cloaked))))
    facts.not_cloaked = cloaked == 0;
  // Desktop handles returned by GetThreadDesktop are borrowed; only OpenInputDesktop is closed.
  const HDESK target_desktop = GetThreadDesktop(thread);
  const HDESK input_desktop = OpenInputDesktop(0, FALSE, DESKTOP_READOBJECTS);
  if (input_desktop != nullptr) {
    std::array<wchar_t, 512> target_name{}, input_name{};
    DWORD needed = 0;
    if (target_desktop != nullptr &&
        GetUserObjectInformationW(target_desktop, UOI_NAME, target_name.data(), sizeof(target_name), &needed) &&
        GetUserObjectInformationW(input_desktop, UOI_NAME, input_name.data(), sizeof(input_name), &needed))
      facts.input_desktop = std::wstring_view(target_name.data()) == std::wstring_view(input_name.data());
    CloseDesktop(input_desktop);
  }
  const HRESULT apartment = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (SUCCEEDED(apartment) || apartment == RPC_E_CHANGED_MODE) {
    IVirtualDesktopManager *manager = nullptr;
    if (SUCCEEDED(CoCreateInstance(CLSID_VirtualDesktopManager, nullptr, CLSCTX_INPROC_SERVER,
                                  IID_PPV_ARGS(&manager)))) {
      BOOL current = FALSE;
      if (SUCCEEDED(manager->IsWindowOnCurrentVirtualDesktop(window, &current)))
        facts.current_virtual_desktop = current == TRUE;
      manager->Release();
    }
    if (SUCCEEDED(apartment)) CoUninitialize();
  }
  return facts;
}

bool CaptureWindowsBackgroundStartDialogs(const WindowsSession &session,
                                          WindowsDialogSetSnapshot *snapshot, std::string *reason) {
  if (!CaptureWindowsDialogInventory(session, snapshot, reason)) return false;
  // P2a starts only at the bound application root. Never follow a popup or restore a modal owner.
  if (!snapshot->dialogs.empty() || IsWindowEnabled(session.window) != TRUE ||
      session.active_window != session.window || session.active_window_identity != session.window_identity ||
      session.active_window_kind != "application") {
    *reason = "native_dialog_user_takeover";
    return false;
  }
  snapshot->active_window = session.window;
  snapshot->active_identity = session.window_identity;
  snapshot->active_kind = "application";
  return true;
}

// BEGIN windows shared new start
struct WindowsStartInput {
  bool foreground_handoff = false;
  std::uint64_t handoff_interaction_epoch = 0;
  bool approval_route_v2 = false;
  std::uint64_t approval_helper_generation = 0;
  std::string expected_process_start;
  std::shared_ptr<WindowsStartResult> start_result = std::make_shared<WindowsStartResult>();
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
  bool explorer_admitted = false;
  WindowsExplorerPrestartScope explorer_scope;
  if constexpr (sprint_coder::computer_use::kWindowsExplorerException) {
    explorer_scope = {input.generation, input.initial_epoch, input.stop_serial, still_valid};
  }
  if (v2) {
    context = input.context.has_value() ? *input.context :
        CurrentWindowsTargetFactsContext(input.main_pid, WindowsV2SelfSignerThumbprint(),
                                        still_valid);
    if (!still_valid() || context->lineage_root_pid != input.main_pid || !AdmitWindowsV2StartInContext(
            input.pid, input.window, *process_executable, *context, input.ruleset_version,
            input.requested_generation, input.generation, /*new_session=*/true,
            input.app_identity, input.executable_digest, input.signer_digest,
            &measured->maximum_mode, &measured->not_web_file,
            &explorer_scope, &explorer_admitted)) return false;
  } else if (!MeasureWindowsV1NewStartEligibility(input, *process_executable, measured)) {
    return false;
  }
  if (!still_valid() || IsKnownProxyExecutable(process_executable->identity.path) ||
      (IsDisallowedTargetExecutable(process_executable->identity.path) && !explorer_admitted) ||
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

struct WindowsNewStartIoRegistration {
  HANDLE thread = nullptr;
  bool registered = false;
  explicit WindowsNewStartIoRegistration(bool register_thread = true) : registered(register_thread) {
    if (!DuplicateHandle(GetCurrentProcess(), GetCurrentThread(), GetCurrentProcess(),
                         &thread, 0, FALSE, DUPLICATE_SAME_ACCESS)) return;
    if (!register_thread) return;
    auto& control = WindowsTargetListControl();
    std::lock_guard lock(control.stop_mutex);
    control.new_start_thread = thread;
  }
  WindowsNewStartIoRegistration(const WindowsNewStartIoRegistration&) = delete;
  WindowsNewStartIoRegistration& operator=(const WindowsNewStartIoRegistration&) = delete;
  ~WindowsNewStartIoRegistration() {
    auto& control = WindowsTargetListControl();
    std::lock_guard lock(control.stop_mutex);
    if (registered) control.new_start_thread = nullptr;
    if (thread != nullptr) CloseHandle(thread);
  }
};

bool StartWindowsNewSession(WindowsStartInput input, std::string *response, std::string *reason) {
  if (input.foreground_handoff) { *reason = "session_input_invalid"; return false; }
  *reason = "session_target_rejected";
  auto &control = WindowsTargetListControl();
  const bool v2 = input.eligibility_basis == sprint_coder::computer_use::EligibilityBasis::kV2Denylist;
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
    if (!sessions.empty()) {
      *reason = "session_limit";
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
  // Main's E3 kill-stop owns the bound for blocked measurement/cleanup. Keep the shared
  // slot until this call has released its resources; there is no detached result to adopt.
  struct Slot {
    WindowsStartInput &input;
    ~Slot() {
      input.start_lease.reset();
      WindowsTargetListWorkerRunning().store(false, std::memory_order_release);
    }
  } slot{input};
  ScopedKernelHandle target_process;
  LockedWindowsExecutable process_executable;
  WindowsNewStartMeasurement measured;
  const auto still_valid = [&] {
    return start_valid() &&
        cancellation_epoch.load(std::memory_order_acquire) == input.initial_epoch;
  };
  bool succeeded = false;
  try {
    WindowsNewStartIoRegistration cancellation;
    if (cancellation.thread == nullptr) return false;
    struct Apartment {
      HRESULT result;
      bool initialized;
      explicit Apartment(bool needed)
          : result(needed ? CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED) : S_OK),
            initialized(needed && SUCCEEDED(result)) {}
      ~Apartment() { if (initialized) CoUninitialize(); }
    } apartment(v2);
    if (SUCCEEDED(apartment.result) && still_valid())
      succeeded = MeasureWindowsNewStart(input, still_valid, &target_process,
                                         &process_executable, &measured);
  } catch (...) {
    succeeded = false;
  }
  if (!start_valid()) {
    *reason = "session_start_canceled";
    return false;
  }
  if (!succeeded) {
    *reason = measured.reason;
    return false;
  }
  // The measured candidate is ready; focus still belongs to the consumer.
  {
    std::lock_guard stop_lock(control.stop_mutex);
    if (!start_valid()) {
      *reason = "session_start_canceled";
      return false;
    }
  }
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
  const bool background_gate = WindowsBackgroundStartGate();
  const bool background = background_gate && foreground != input.window;
  if (background && !WindowsBackgroundTargetSupported(measured.executable)) {
    *reason = "focus_required";
    return false;
  }
  if (background) session.input_session.kind = sprint_coder::computer_use::InputSessionKind::kBackground;
  if (background && !StartWindowsBackgroundMonitor(session, input.pid, input.window, false, reason))
    return false;
  const auto target_facts = [&](RECT *bounds) {
    if (!background) return TargetWindowFacts(input.pid, input.window, bounds);
    return GetForegroundWindow() != input.window &&
        sprint_coder::computer_use::WindowsBackgroundStartFactsAdmit(
            MeasureWindowsBackgroundStartFacts(input.pid, input.window, bounds));
  };
  if (input.start_lease) {
    session.start_owner = input.start_lease->owner;
    session.input_api_attempts = input.start_lease->owner->input_api_attempts;
  }
  const auto identity_matches = [&](HWND focus_window) {
    if (CheckWindowsStartFocusIdentity(target_process.value, input.pid, input.expected_process_start,
        measured.process_start, input.window, focus_window, input.app_identity, input.expected_window_identity))
      return true;
    *reason = "session_identity_changed";
    return false;
  };
  if (!identity_matches(input.window)) return false;
  const auto begin_focus = [&](HWND focus_window) {
    // Potentially blocking identity queries must not hold the reader's Stop lock.
    if (!CheckWindowsStartFocusIdentity(target_process.value, input.pid, input.expected_process_start,
        measured.process_start, input.window, focus_window, input.app_identity, input.expected_window_identity)) {
      *reason = "session_identity_changed"; return false;
    }
    std::lock_guard stop_lock(control.stop_mutex);
    if (!start_valid()) {
      *reason = "session_start_canceled";
      return false;
    }
    session.input_api_attempts->fetch_add(1, std::memory_order_acq_rel);
    ++input.start_result->attempt_count;
    return true;
  };
  if (!background_gate && GetForegroundWindow() != input.window) {
    if (IsIconic(input.window)) {
      if (!begin_focus(input.window)) return false;
      ShowWindow(input.window, SW_RESTORE);
    }
    if (!begin_focus(input.window)) return false;
    SetForegroundWindow(input.window);
  }
  RECT bounds{};
  RECT screen_bounds{};
  if (!target_facts(&bounds)) {
    *reason = background ? "session_target_rejected" : "focus_required";
    return false;
  }
  if ((v2 || background) && !geometry_matches(bounds)) {
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
  session.approval_route_v2 = input.approval_route_v2;
  session.approval_helper_generation = input.approval_helper_generation;
  if (session.maximum_mode == "supervised" && !WindowsApprovalSessionGate(session)) {
    session.maximum_mode = "observe_only";
    session.approval_revoked = true;
  }
  session.not_web_file = measured.not_web_file;
  if (background) {
    WindowsDialogSetSnapshot dialogs;
    if (!CaptureWindowsBackgroundStartDialogs(session, &dialogs, reason)) return false;
    session.dialog_set_digest = dialogs.digest;
    session.dialog_set_revision = 1;
  }
  // The response carries the monitor's epoch; a background start without a monitor never answers.
  if (background && !session.background_monitor) { *reason = "user_takeover"; return false; }
  std::uint64_t effective_epoch = std::max(input.cancel_epoch, cancellation_epoch.load(std::memory_order_acquire));
  const auto build_response = [&](std::uint64_t response_epoch) {
    return "{\"sessionId\":\"" + JsonEscape(input.session_id) +
      "\",\"platform\":\"win32\",\"appIdentityDigest\":\"" + input.app_identity +
      "\",\"windowIdentityDigest\":\"" + measured.window_identity + "\",\"windowId\":\"" +
      std::to_string(input.window_value) + "\",\"policyLanguage\":\"" + measured.executable.policy_language +
      "\",\"maximumMode\":\"" + session.maximum_mode + "\",\"screenBounds\":" + RectJson(screen_bounds) +
      ",\"profileRevision\":" + std::to_string(input.profile_revision) +
      ",\"cancelEpoch\":" + std::to_string(response_epoch) +
      ",\"inputAttemptCount\":" + std::to_string(session.input_api_attempts->load(std::memory_order_acquire)) +
      ",\"processStartTime\":\"" + JsonEscape(session.process_start) + "\"" +
      ",\"pid\":" + std::to_string(input.pid) + ",\"windowHandle\":\"" + std::to_string(input.window_value) + "\"" +
      (background_gate ? ",\"inputSession\":" + sprint_coder::computer_use::InputSessionWire(session.input_session) : "") +
      (background ? ",\"interactionEpoch\":" + std::to_string(session.background_monitor->state.Snapshot().epoch) : "") + "}";
  };
  std::string built = v2 ? build_response(effective_epoch) : std::string{};
  if ((v2 || background) && (WaitForSingleObject(target_process.value, 0) != WAIT_TIMEOUT ||
      !IsApplicationWindow(input.window) || !target_facts(&bounds) ||
      !geometry_matches(bounds))) {
    *reason = "session_target_rejected";
    return false;
  }
  if (background) {
    WindowsDialogSetSnapshot dialogs;
    if (!CaptureWindowsBackgroundStartDialogs(session, &dialogs, reason)) return false;
    if (dialogs.digest != session.dialog_set_digest) { *reason = "session_refocus_stale"; return false; }
  }
  // Stop and final start adoption share this lock. Window/geometry OS queries stay outside it so
  // their latency cannot prevent the reader from recording Stop.
  {
    std::lock_guard stop_lock(control.stop_mutex);
    if (!start_valid() || !sessions.empty()) {
      *reason = "session_start_canceled";
      return false;
    }
    if (!WindowsBackgroundMonitorCurrent(session)) { *reason = "user_takeover"; return false; }
    // All allocating session/response work precedes the ownership handoff. Cache adoption is also
    // consumer-only, and a late measurement cannot install a context after Stop.
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
    inserted->second.process_handle = target_process.release();
    inserted->second.executable_file = process_executable.file;
    process_executable.file = INVALID_HANDLE_VALUE;
    *response = std::move(built);
  }
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
  sprint_coder::computer_use::InputSessionKind session_kind = sprint_coder::computer_use::InputSessionKind::kForeground;
};

WindowsExistingStartSnapshot WindowsExistingStartBinding(const WindowsSession &session) {
  return {session.session_id, session.pid, session.window, session.app_identity,
          session.window_identity, session.process_start, session.maximum_mode,
          session.eligibility_basis, session.cancel_epoch,
          {session.executable_volume_serial, session.executable_file_id},
          session.executable_digest, session.signer_digest, session.policy_language, session.input_session.kind};
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
      expected.policy_language == session.policy_language && expected.session_kind == session.input_session.kind;
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

struct WindowsExistingStartWork {
  WindowsStartInput input;
  WindowsExistingStartSnapshot expected;
  WindowsExistingStartMeasurement before;
  ScopedKernelHandle process;
  ScopedKernelHandle executable;
  bool source_ready = false;
  WindowsExistingStartPhase phase = WindowsExistingStartPhase::BeforeFocus;
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
    return WindowsExistingStartStillCurrent(work.input, work.expected.cancel_epoch);
  };
  const auto &input = work.input;
  const bool v2 = input.eligibility_basis == sprint_coder::computer_use::EligibilityBasis::kV2Denylist;
  if (!still_valid() || (v2 && input.main_pid == 0)) return measured;
  ScopedKernelHandle target_process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, input.pid));
  LockedWindowsExecutable current_executable;
  bool explorer_admitted = false;
  WindowsExplorerPrestartScope explorer_scope;
  if constexpr (sprint_coder::computer_use::kWindowsExplorerException) {
    explorer_scope = {input.generation, work.expected.cancel_epoch, input.stop_serial, still_valid};
  }
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
                                                 still_valid);
    }
    if (!still_valid() || context.lineage_root_pid != input.main_pid) return measured;
    // A completed context may be retained on a target refusal, just as in the synchronous admission.
    if (!input.context.has_value()) measured.context = context;
    std::optional<sprint_coder::computer_use::WindowsFileKey> not_web_file;
    if (!AdmitWindowsV2StartInContext(input.pid, input.window, current_executable, context,
            input.ruleset_version, 0, 0, /*new_session=*/false, input.app_identity,
            input.executable_digest, input.signer_digest, &measured.maximum_mode, &not_web_file,
            &explorer_scope, &explorer_admitted)) return measured;
  } else if (!MeasureWindowsV1ExistingStartEligibility(input, current_executable, &measured)) {
    return measured;
  }
  if (!still_valid() || IsKnownProxyExecutable(current_executable.identity.path) ||
      (IsDisallowedTargetExecutable(current_executable.identity.path) && !explorer_admitted) || IsProcessElevated(input.pid) ||
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
    return WindowsExistingStartStillCurrent(work.input, work.expected.cancel_epoch);
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

bool RunWindowsExistingStartMeasurement(
    const WindowsStartInput &input, const WindowsSession &session, WindowsExistingStartPhase phase,
    const WindowsExistingStartMeasurement *before, WindowsExistingStartMeasurement *output,
    std::string *reason) {
  *reason = phase == WindowsExistingStartPhase::BeforeFocus ? "session_target_rejected" : "session_refocus_stale";
  auto work = std::make_unique<WindowsExistingStartWork>();
  work->input = input;
  work->expected = WindowsExistingStartBinding(session);
  work->phase = phase;
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
      if constexpr (sprint_coder::computer_use::kWindowsExplorerException)
        work->input.generation = windows_v2_list_generation;
      if (work->input.main_pid == 0) return false;
    }
    control.running.store(true, std::memory_order_release);
  }
  // Keep the slot through source-handle and COM cleanup. Main's kill-stop bounds a hung call.
  struct Slot {
    ~Slot() { WindowsTargetListWorkerRunning().store(false, std::memory_order_release); }
  } slot;
  const std::uint32_t main_pid = work->input.main_pid;
  WindowsExistingStartMeasurement measured;
  measured.reason = *reason;
  try {
    // Starts share one consumer; reuse its Stop-locked synchronous I/O registration.
    WindowsNewStartIoRegistration cancellation;
    if (cancellation.thread == nullptr) return false;
    struct Apartment {
      HRESULT result;
      bool initialized;
      explicit Apartment(bool needed)
          : result(needed ? CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED) : S_OK),
            initialized(needed && SUCCEEDED(result)) {}
      ~Apartment() { if (initialized) CoUninitialize(); }
    } apartment(v2);
    work->source_ready = source_process != nullptr && source_process != INVALID_HANDLE_VALUE &&
        source_executable != nullptr && source_executable != INVALID_HANDLE_VALUE &&
        DuplicateHandle(GetCurrentProcess(), source_process, GetCurrentProcess(), &work->process.value,
                        0, FALSE, DUPLICATE_SAME_ACCESS) &&
        DuplicateHandle(GetCurrentProcess(), source_executable, GetCurrentProcess(), &work->executable.value,
                        0, FALSE, DUPLICATE_SAME_ACCESS);
    if (SUCCEEDED(apartment.result) && current() &&
        (work->source_ready || (!v2 && phase == WindowsExistingStartPhase::BeforeFocus)))
      measured = phase == WindowsExistingStartPhase::BeforeFocus
          ? MeasureWindowsExistingStartBefore(*work) : MeasureWindowsExistingStartAfter(*work);
    work.reset();
  } catch (...) {
    work.reset();
    measured = {};
    measured.reason = *reason;
  }
  std::lock_guard stop_lock(control.stop_mutex);
  if (!current() || (v2 && windows_v2_main_pid != main_pid)) {
    *reason = "session_start_canceled";
    return false;
  }
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
  // Every attempted handoff closes its old background authority, including early rejection.
  struct HandoffMonitorCleanup {
    std::shared_ptr<WindowsBackgroundMonitor> monitor;
    ~HandoffMonitorCleanup() { if (monitor) monitor->Stop(); }
  } handoff_cleanup{input.foreground_handoff ? session.background_monitor : nullptr};
  if (!input.foreground_handoff && session.foreground_handoff_consumed &&
      session.input_session.kind == sprint_coder::computer_use::InputSessionKind::kBackground) {
    *reason = "session_refocus_stale"; return false;
  }
  if (input.foreground_handoff) {
    const bool already_consumed = session.foreground_handoff_consumed;
    session.foreground_handoff_consumed = true;
    InvalidateWindowsTicket(input.session_key);
    if (already_consumed || !WindowsBackgroundStartGate() || input.explicit_resume ||
        session.input_session.kind != sprint_coder::computer_use::InputSessionKind::kBackground ||
        input.approval_helper_generation == 0 ||
        input.approval_helper_generation != windows_helper_generation ||
        input.approval_helper_generation != session.approval_helper_generation ||
        !session.background_monitor || !WindowsBackgroundMonitorReady(session)) {
      *reason = "session_refocus_stale"; return false;
    }
  }
  const auto expected = WindowsExistingStartBinding(session);
  auto &control = WindowsTargetListControl();
  const auto measurement_current = [&] {
    return WindowsRoundTripCurrent(session) &&
        WindowsExistingStartStillCurrent(input, expected.cancel_epoch) &&
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
  const bool background_gate = WindowsBackgroundStartGate();
  const bool was_background = session.input_session.kind == sprint_coder::computer_use::InputSessionKind::kBackground;
  const bool background_supported = background_gate && WindowsBackgroundTargetSupported(before.executable);
  // A consumed handoff keeps this session on the approved foreground route across resume.
  const bool background = !input.foreground_handoff && !session.foreground_handoff_consumed && (was_background ||
      (input.explicit_resume && background_supported && GetForegroundWindow() != input.window));
  if (background && (!background_supported || GetForegroundWindow() == input.window)) {
    *reason = "focus_required";
    return false;
  }
  WindowsDialogSetSnapshot background_dialogs;
  if (background) {
    if (!StartWindowsBackgroundMonitor(session, input.pid, input.window, input.explicit_resume, reason))
      return false;
    if (!CaptureWindowsBackgroundStartDialogs(session, &background_dialogs, reason)) return false;
    if (!session.dialog_set_digest.empty() && session.dialog_set_digest != background_dialogs.digest) {
      *reason = "session_refocus_stale";
      return false;
    }
  } else if (input.explicit_resume) {
    if (!ResolveWindowsExplicitResumeTarget(&session, &refocus_window, reason)) return false;
  } else if (!ResolveWindowsSessionRefocusTarget(session, &refocus_window, reason)) {
    return false;
  }
  if (!check_current()) return false;
  if (!CheckWindowsStartFocusIdentity(session.process_handle, input.pid, input.expected_process_start,
      session.process_start, input.window, refocus_window, input.app_identity, input.expected_window_identity)) {
    *reason = "session_identity_changed"; return false;
  }
  if (input.foreground_handoff) {
    {
      std::lock_guard stop_lock(control.stop_mutex);
      if (!current() || !session.background_monitor->state.RetireForForeground(input.handoff_interaction_epoch)) {
        *reason = "session_start_canceled"; return false;
      }
    }
    // Do not join while holding Stop. The retired state cannot issue another background claim.
    session.background_monitor->Stop();
    if (!check_current()) return false;
  }
  const auto begin_focus = [&](HWND focus_window) {
    if (!CheckWindowsStartFocusIdentity(session.process_handle, input.pid, input.expected_process_start,
        session.process_start, input.window, focus_window, input.app_identity, input.expected_window_identity)) {
      *reason = "session_identity_changed"; return false;
    }
    // Existing start focus unit begins under the reader's Stop lock.
    std::lock_guard stop_lock(control.stop_mutex);
    if (!current()) { *reason = "session_start_canceled"; return false; }
    session.input_api_attempts->fetch_add(1, std::memory_order_acq_rel);
    ++input.start_result->attempt_count;
    return true;
  };
  if (!background && GetForegroundWindow() != refocus_window) {
    if (IsIconic(input.window)) {
      if (!begin_focus(input.window)) return false;
      ShowWindow(input.window, SW_RESTORE);
    }
    if (refocus_window != input.window && IsIconic(refocus_window)) {
      if (!begin_focus(refocus_window)) return false;
      ShowWindow(refocus_window, SW_RESTORE);
    }
    if (!begin_focus(refocus_window)) return false;
    SetForegroundWindow(refocus_window);
  }
  RECT bounds{};
  const auto target_facts = [&] {
    if (!background) return TargetWindowFacts(input.pid, refocus_window, &bounds);
    return GetForegroundWindow() != input.window &&
        sprint_coder::computer_use::WindowsBackgroundStartFactsAdmit(
            MeasureWindowsBackgroundStartFacts(input.pid, input.window, &bounds));
  };
  if (!target_facts()) {
    *reason = background ? "session_target_rejected" : "focus_required";
    return false;
  }
  if (background && (std::abs(static_cast<double>(bounds.left) - input.bounds_x) > 1.0 ||
      std::abs(static_cast<double>(bounds.top) - input.bounds_y) > 1.0 ||
      std::abs(static_cast<double>(bounds.right - bounds.left) - input.bounds_width) > 1.0 ||
      std::abs(static_cast<double>(bounds.bottom - bounds.top) - input.bounds_height) > 1.0)) {
    *reason = "window_geometry_changed";
    return false;
  }
  RECT screen_bounds{};
  if (!ScreenBoundsPhysicalForWindow(refocus_window, &screen_bounds)) {
    *reason = "screen_geometry_unavailable";
    return false;
  }
  WindowsDialogSetSnapshot refocused_dialogs;
  if (background) {
    if (!CaptureWindowsBackgroundStartDialogs(session, &refocused_dialogs, reason)) return false;
  } else if (!CaptureWindowsDialogSet(session, &refocused_dialogs, reason)) return false;
  if (refocused_dialogs.digest != (background ? background_dialogs.digest : session.dialog_set_digest) ||
      refocused_dialogs.active_window != session.active_window ||
      refocused_dialogs.active_identity != session.active_window_identity ||
      refocused_dialogs.active_kind != session.active_window_kind) {
    *reason = "session_refocus_stale";
    return false;
  }
  if (!check_current()) return false;
  const RECT before_final_bounds = bounds;
  WindowsExistingStartMeasurement after;
  if (!RunWindowsExistingStartMeasurement(input, session, WindowsExistingStartPhase::AfterFocus,
                                           &before, &after, reason)) return false;
  if (background) {
    if (!target_facts() || !EqualRect(&before_final_bounds, &bounds)) {
      *reason = "session_target_rejected";
      return false;
    }
    WindowsDialogSetSnapshot final_dialogs;
    if (!CaptureWindowsBackgroundStartDialogs(session, &final_dialogs, reason)) return false;
    if (final_dialogs.digest != background_dialogs.digest) { *reason = "session_refocus_stale"; return false; }
  }
  if (background && !session.background_monitor) { *reason = "user_takeover"; return false; }
  const sprint_coder::computer_use::InputSession next_input_session{
      background ? sprint_coder::computer_use::InputSessionKind::kBackground :
                   sprint_coder::computer_use::InputSessionKind::kForeground};
  std::string built = "{\"sessionId\":\"" + JsonEscape(input.session_id) +
      "\",\"platform\":\"win32\",\"appIdentityDigest\":\"" + input.app_identity +
      "\",\"windowIdentityDigest\":\"" + before.window_identity + "\",\"windowId\":\"" +
      std::to_string(input.window_value) + "\",\"policyLanguage\":\"" + before.executable.policy_language +
      "\",\"maximumMode\":\"" + before.maximum_mode + "\",\"screenBounds\":" + RectJson(screen_bounds) +
      ",\"profileRevision\":" + std::to_string(input.profile_revision) +
      ",\"cancelEpoch\":" + std::to_string(input.cancel_epoch) +
      ",\"inputAttemptCount\":" + std::to_string(session.input_api_attempts->load(std::memory_order_acquire)) +
      ",\"processStartTime\":\"" + JsonEscape(session.process_start) + "\"" +
      ",\"pid\":" + std::to_string(input.pid) + ",\"windowHandle\":\"" + std::to_string(input.window_value) + "\"" +
      (background_gate ? ",\"inputSession\":" + sprint_coder::computer_use::InputSessionWire(next_input_session) : "") +
      (background ? ",\"interactionEpoch\":" + std::to_string(session.background_monitor->state.Snapshot().epoch) : "") + "}";
  // Existing start final success decision; a completed late phase cannot resume after Stop.
  std::lock_guard stop_lock(control.stop_mutex);
  if (!current()) { *reason = "session_start_canceled"; return false; }
  if (background && !WindowsBackgroundMonitorReady(session)) { *reason = "user_takeover"; return false; }
  InvalidateWindowsTicket(input.session_key);
  session.input_session = next_input_session;
  if (background && !was_background && input.explicit_resume) session.foreground_handoff_consumed = false;
  if (input.foreground_handoff) {
    session.background_monitor.reset();
    InvalidateWindowsObservation(&session);
  }
  if (background) {
    session.dialog_set_digest = std::move(background_dialogs.digest);
    if (session.dialog_set_revision == 0) session.dialog_set_revision = 1;
    session.has_observation = false;
  }
  *response = std::move(built);
  return true;
}

// END windows shared existing start

// BEGIN windows v2 rejudge measurement
// Defined after the shared I/O registration used by starts and session validation.
WindowsV2RejudgeResult RunWindowsV2RejudgeMeasurement(const WindowsV2RejudgeWork &work) {
  WindowsNewStartIoRegistration cancellation;
  if (cancellation.thread == nullptr) return {};
  struct Apartment {
    HRESULT result = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    ~Apartment() { if (SUCCEEDED(result)) CoUninitialize(); }
  } apartment;
  if (FAILED(apartment.result)) return {};
  return MeasureWindowsV2Rejudge(work);
}
// END windows v2 rejudge measurement

// END windows v2 targets

