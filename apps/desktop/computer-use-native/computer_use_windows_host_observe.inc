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
                   std::size_t *nodes, std::string *json, std::uint32_t background_pid = 0) {
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
  if (background_pid != 0) {
    int owner = 0;
    const auto normalized = sprint_coder::computer_use::windows_interlock_capture_detail::FoldedLower(
        name_utf8 + "\n" + automation_utf8 + "\n" + help_utf8);
    const auto risk = sprint_coder::computer_use::ClassifyWindowsRiskText(normalized);
    const bool secure = password == TRUE || normalized.find("password") != std::string::npos ||
        normalized.find("passcode") != std::string::npos || normalized.find("パスワード") != std::string::npos;
    // Classify full labels only. Truncation is insufficient evidence for the background path.
    const bool complete_labels =
        (name == nullptr || Utf8FromWide(std::wstring_view(name, SysStringLen(name))).size() <= 256) &&
        (automation_id == nullptr || Utf8FromWide(std::wstring_view(automation_id, SysStringLen(automation_id))).size() <= 256) &&
        (help == nullptr || Utf8FromWide(std::wstring_view(help, SysStringLen(help))).size() <= 4'096);
    if (!WindowsV1UiaRead(owner, [&] { return element->get_CurrentProcessId(&owner); }) ||
        !sprint_coder::computer_use::WindowsBackgroundObservationNodeAdmitted(
            static_cast<std::uint32_t>(owner), background_pid, control_type != 0,
            complete_labels, secure, risk.confirmation || risk.other)) return false;
  }
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
    if (!AppendUiaTree(child, walker, depth + 1, nodes, json, background_pid))
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

// Observation alone opts into this validator. Input/approval keep their foreground validator
// until their separately reviewed background binding and monitoring stages are connected.
bool ValidateWindowsObservationSession(const WindowsSession &session, RECT *bounds,
                                       std::string *reason, WindowsDialogSetSnapshot *dialogs) {
  if (session.input_session.kind != sprint_coder::computer_use::InputSessionKind::kBackground)
    return ValidateWindowsSession(session, bounds, reason, dialogs);
  const WindowsValidationFrameScope frame;
  WindowsSessionIdentityResult identity;
  if (!WindowsBackgroundStartGate() || WindowsTargetListWorkerRunning().load(std::memory_order_acquire) ||
      !ReadWindowsSessionIdentityOnLane(session, frame.StopSerial(), &identity) ||
      !identity.identity_matches || identity.elevated || !IsApplicationWindow(session.window) ||
      !sprint_coder::computer_use::WindowsBackgroundStartFactsAdmit(
          MeasureWindowsBackgroundStartFacts(session.pid, session.window, bounds))) {
    *reason = "session_identity_changed";
    return false;
  }
  if (!CaptureWindowsBackgroundStartDialogs(session, dialogs, reason)) return false;
  std::lock_guard stop_lock(WindowsTargetListControl().stop_mutex);
  if (!WindowsValidationStillCurrent(session.cancel_epoch, frame.StopSerial())) {
    *reason = "observation_stale";
    return false;
  }
  dialogs->active_bounds = *bounds;
  return true;
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
                                std::size_t *nodes, bool background = false) {
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
                        AppendUiaTree(root, walker, 0, &count, &value, background ? pid : 0);
  if (!complete)
    return false;
  *tree = std::move(value);
  *nodes = count;
  (void)pid;
  return true;
}

// Observation rejects a worker timeout as soon as it is known. Classification instead keeps
// the worker's partial risk/signature and first stop, once its COM cleanup has completed.
// Both policies abandon immediately on consumer-side Stop, deadline or slow first contact.
template <class Result, class Measure, class Adopt>
bool RunWindowsUiaRead(bool preserve_stopped_result, Measure measure, Adopt adopt,
                       std::atomic<bool> &running = WindowsUiaReadWorkerRunning()) {
  static_assert(std::is_nothrow_move_constructible_v<Result> && std::is_nothrow_move_assignable_v<Result>,
                "UIA read results must be publishable without throwing.");
  const WindowsV1UiaPath path;
  if (!WindowsV1UiaMayCall()) return false;
  WindowsV1UiaLane snapshot = *windows_v1_uia_lane;
  // Bound the read and its cleanup without restarting an inherited operation deadline.
  const auto read_deadline = std::chrono::steady_clock::now() +
      (&running == &WindowsCaptureWorkerRunning() ? kWindowsV1UiaObserveBudget : kWindowsUiaReadBudget);
  if (!snapshot.has_deadline) {
    snapshot.has_deadline = true;
    snapshot.deadline = read_deadline;
  }
  auto &control = WindowsTargetListControl();
  if (!snapshot.stop_serial.has_value())
    snapshot.stop_serial = WindowsValidationFrameStopSerial();
  std::shared_ptr<WindowsUiaReadPending<Result>> pending;
  try { pending = std::make_shared<WindowsUiaReadPending<Result>>(); }
  catch (...) { if (preserve_stopped_result) WindowsV1UiaOk(kWindowsV1UiaTimeoutResult); return false; }
  {
    std::lock_guard stop_lock(control.stop_mutex);
    if (parent_process_dead.load(std::memory_order_acquire) ||
        control.stop_serial.load(std::memory_order_acquire) != *snapshot.stop_serial) {
      windows_v1_uia_lane->stop = WindowsV1UiaStop::kCanceled;
      return false;
    }
    if (running.exchange(true, std::memory_order_acq_rel)) {
      if (preserve_stopped_result) WindowsV1UiaOk(kWindowsV1UiaTimeoutResult);
      return false;
    }
  }
  try {
    std::thread([pending, snapshot, preserve_stopped_result, measure = std::move(measure), &running]() mutable {
      struct Progress {
        explicit Progress(WindowsUiaReadProgress *value) { windows_uia_read_progress = value; }
        ~Progress() { windows_uia_read_progress = nullptr; }
      } progress(pending.get());
      const WindowsV1UiaPath worker_path(snapshot);
      std::optional<Result> value;
      try {
        struct Apartment {
          HRESULT result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
          ~Apartment() { if (SUCCEEDED(result)) CoUninitialize(); }
        } apartment;
        if (SUCCEEDED(apartment.result) && WindowsV1UiaMayCall()) value = measure();
        else if (FAILED(apartment.result) && preserve_stopped_result) WindowsV1UiaOk(kWindowsV1UiaTimeoutResult);
      } catch (...) {
        value.reset();
        if (preserve_stopped_result) WindowsV1UiaOk(kWindowsV1UiaTimeoutResult);
      }
      // No result or free slot is published while Release/CoUninitialize can still be running.
      {
        std::lock_guard lock(pending->mutex);
        if (pending->abandoned.load(std::memory_order_acquire) == WindowsV1UiaStop::kNone) {
          pending->value = std::move(value);
          pending->stop.store(worker_path.Stop(), std::memory_order_release);
        }
        pending->done = true;
        running.store(false, std::memory_order_release);
      }
      pending->ready.notify_one();
    }).detach();
  } catch (...) {
    running.store(false, std::memory_order_release);
    if (preserve_stopped_result) WindowsV1UiaOk(kWindowsV1UiaTimeoutResult);
    return false;
  }
  std::unique_lock lock(pending->mutex);
  for (;;) {
    {
      std::lock_guard stop_lock(control.stop_mutex);
      WindowsV1UiaLane &lane = *windows_v1_uia_lane;
      auto external_stop = lane.stop;
      if (external_stop == WindowsV1UiaStop::kNone) {
        if (parent_process_dead.load(std::memory_order_acquire) ||
            cancellation_epoch.load(std::memory_order_acquire) != snapshot.epoch ||
            control.stop_serial.load(std::memory_order_acquire) != *snapshot.stop_serial)
          external_stop = WindowsV1UiaStop::kCanceled;
        else if (snapshot.has_deadline && std::chrono::steady_clock::now() >= snapshot.deadline)
          external_stop = WindowsV1UiaStop::kBudget;
      }
      const auto worker_stop = pending->stop.load(std::memory_order_acquire);
      if (external_stop == WindowsV1UiaStop::kNone &&
          (pending->contact_active || (pending->call_active && !lane.has_deadline)) &&
          std::chrono::steady_clock::now() - pending->contact_started >=
              (pending->contact_active ? kWindowsV1UiaSlowContact : kWindowsUiaCallBudget))
        external_stop = WindowsV1UiaStop::kTimeout;
      if (external_stop != WindowsV1UiaStop::kNone ||
          (!preserve_stopped_result && worker_stop != WindowsV1UiaStop::kNone)) {
        if (lane.stop == WindowsV1UiaStop::kNone)
          lane.stop = preserve_stopped_result && worker_stop != WindowsV1UiaStop::kNone
              ? worker_stop : external_stop != WindowsV1UiaStop::kNone ? external_stop : worker_stop;
        pending->abandoned.store(lane.stop, std::memory_order_release);
        lane.nodes += pending->nodes.load(std::memory_order_acquire);
        return false;
      }
      if (pending->done) {
        lane.nodes += pending->nodes.load(std::memory_order_acquire);
        lane.stop = worker_stop;
        if (!pending->value.has_value()) return false;
        adopt(std::move(*pending->value));
        return true;
      }
    }
    pending->ready.wait_for(lock, std::chrono::milliseconds(20));
  }
}

struct WindowsUiaObservationResult {
  std::string tree;
  std::size_t nodes = 0;
};

bool ReadUiaObservation(std::uint32_t pid, HWND window, std::string *tree,
                        std::size_t *nodes, bool background = false) {
  return RunWindowsUiaRead<WindowsUiaObservationResult>(false,
      [pid, window, background]() -> std::optional<WindowsUiaObservationResult> {
        WindowsUiaObservationResult value;
        if (!ReadUiaObservationOnWorker(pid, window, &value.tree, &value.nodes, background)) return std::nullopt;
        return value;
      }, [tree, nodes](WindowsUiaObservationResult value) {
        *tree = std::move(value.tree);
        *nodes = value.nodes;
      });
}

// BEGIN windows capture read ownership
struct WindowsCaptureBytes {
  std::vector<std::uint8_t> bytes;
  std::size_t width = 0;
  std::size_t height = 0;
  ~WindowsCaptureBytes() { std::fill(bytes.begin(), bytes.end(), 0); }
};

class WindowsCaptureLaneScope {
public:
  explicit WindowsCaptureLaneScope(WindowsV1UiaLane *lane)
      : previous_(std::exchange(windows_v1_uia_lane, lane)) {}
  ~WindowsCaptureLaneScope() { windows_v1_uia_lane = previous_; }
  WindowsCaptureLaneScope(const WindowsCaptureLaneScope &) = delete;
  WindowsCaptureLaneScope &operator=(const WindowsCaptureLaneScope &) = delete;
private:
  WindowsV1UiaLane *previous_;
};

template<class Result, class Measure, class Adopt>
bool RunWindowsImageRead(std::uint64_t epoch, std::uint64_t stop_serial,
                         Measure measure, Adopt adopt, WindowsV1UiaStop *stop) {
  if (stop != nullptr) *stop = WindowsV1UiaStop::kNone;
  WindowsV1UiaLane snapshot = windows_v1_uia_lane != nullptr
      ? *windows_v1_uia_lane : WindowsV1UiaLane{};
  snapshot.epoch = epoch;
  snapshot.stop_serial = stop_serial;
  snapshot.nodes = 0;
  // A failed focus read may omit a signature without invalidating a screenshot. Preserve the
  // caller's timeout state, but give capture its own lane and slot while retaining Stop/deadline.
  if (snapshot.stop == WindowsV1UiaStop::kTimeout) snapshot.stop = WindowsV1UiaStop::kNone;
  bool read = false;
  {
    const WindowsCaptureLaneScope scope(&snapshot);
    read = RunWindowsUiaRead<Result>(false, std::move(measure), std::move(adopt),
                                    WindowsCaptureWorkerRunning());
  }
  if (stop != nullptr) *stop = snapshot.stop;
  return read;
}

bool CaptureWindowWithGraphicsCapture(HWND window, std::uint64_t epoch,
                                      std::uint64_t stop_serial,
                                      std::vector<std::uint8_t> *output,
                                      std::size_t *width, std::size_t *height,
                                      WindowsV1UiaStop *stop, std::uint32_t background_pid) {
  if (stop != nullptr) *stop = WindowsV1UiaStop::kNone;
#if SPRINT_CODER_HAS_WINDOWS_GRAPHICS_CAPTURE
  std::unique_ptr<WindowsCaptureBytes> result;
  const bool captured = RunWindowsImageRead<std::unique_ptr<WindowsCaptureBytes>>(epoch, stop_serial,
        [window, background_pid]() -> std::optional<std::unique_ptr<WindowsCaptureBytes>> {
          winrt::init_apartment(winrt::apartment_type::multi_threaded);
          struct Runtime { ~Runtime() { winrt::uninit_apartment(); } } runtime;
          auto value = std::make_unique<WindowsCaptureBytes>();
          if (!CaptureWindowWithGraphicsCaptureOnWorker(window, &value->bytes,
                                                        &value->width, &value->height, background_pid))
            return std::nullopt;
          return value;
        }, [&result](std::unique_ptr<WindowsCaptureBytes> value) noexcept {
          result = std::move(value);
        }, stop);
  if (captured) {
    output->swap(result->bytes);
    *width = result->width;
    *height = result->height;
    return true;
  }
#else
  (void)window; (void)epoch; (void)stop_serial; (void)width; (void)height; (void)background_pid;
#endif
  std::fill(output->begin(), output->end(), 0);
  output->clear();
  return false;
}
// END windows capture read ownership

// PNG bytes are transferred into one image job, never borrowed from the consumer's output buffer.
struct WindowsPngResult {
  WindowsCaptureBytes image;
  std::vector<std::string> digests;
  std::string digest;
  std::size_t columns = 0, rows = 0, index = 0;
};

bool ReadWindowsPng(std::vector<std::uint8_t> *png, std::size_t width, std::size_t height,
                    std::uint64_t epoch, std::uint64_t serial, bool grid, double x, double y,
                    std::unique_ptr<WindowsPngResult> *result, WindowsV1UiaStop *stop) {
  if (stop != nullptr) *stop = WindowsV1UiaStop::kNone;
#if SPRINT_CODER_HAS_WINDOWS_GRAPHICS_CAPTURE
  try {
    if (!png->empty() && png->size() <= 8 * 1024 * 1024 && width > 0 && height > 0 &&
        width <= 2'560 && height <= 1'600) {
      auto work = std::make_unique<WindowsPngResult>();
      work->image.bytes.swap(*png);
      work->image.width = width; work->image.height = height;
      return RunWindowsImageRead<std::unique_ptr<WindowsPngResult>>(epoch, serial,
          [work = std::move(work), grid, x, y]() mutable -> std::optional<std::unique_ptr<WindowsPngResult>> {
            if (!WindowsV1UiaMayCall()) return std::nullopt;
            const bool ok = grid
                ? ComputePngPatchGrid(work->image.bytes, work->image.width, work->image.height,
                                      &work->digests, &work->columns, &work->rows)
                : ComputePngPatchDigest(work->image.bytes, work->image.width, work->image.height,
                                        x, y, &work->digest, &work->index);
            if (!ok || !WindowsV1UiaMayCall()) return std::nullopt;
            return std::move(work);
          }, [result](std::unique_ptr<WindowsPngResult> value) noexcept {
            *result = std::move(value);
          }, stop);
    }
  } catch (...) {}
#else
  (void)width; (void)height; (void)epoch; (void)serial; (void)grid; (void)x; (void)y; (void)result;
#endif
  std::fill(png->begin(), png->end(), 0); png->clear();
  return false;
}

bool ReadWindowsPngPatchGrid(std::vector<std::uint8_t> *png, std::size_t width,
                             std::size_t height, std::uint64_t epoch, std::uint64_t serial,
                             std::vector<std::string> *digests, std::size_t *columns,
                             std::size_t *rows, WindowsV1UiaStop *stop) {
  std::unique_ptr<WindowsPngResult> result;
  if (!ReadWindowsPng(png, width, height, epoch, serial, true, 0, 0, &result, stop)) return false;
  png->swap(result->image.bytes); digests->swap(result->digests);
  *columns = result->columns; *rows = result->rows;
  return true;
}

bool ReadWindowsPngPatchDigest(std::vector<std::uint8_t> *png, std::size_t width,
                               std::size_t height, double x, double y,
                               std::uint64_t epoch, std::uint64_t serial,
                               std::string *digest, std::size_t *index) {
  std::unique_ptr<WindowsPngResult> result;
  if (!ReadWindowsPng(png, width, height, epoch, serial, false, x, y, &result, nullptr)) return false;
  png->swap(result->image.bytes); digest->swap(result->digest); *index = result->index;
  return true;
}

