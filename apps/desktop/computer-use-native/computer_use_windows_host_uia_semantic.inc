// BEGIN windows semantic operation ownership
struct WindowsSemanticPending : WindowsUiaReadProgress {
  std::shared_ptr<sprint_coder::computer_use::WindowsApprovalRoundTrip> round_trip;
  std::uint64_t approved_started_ns = 0;
  std::uint64_t approved_deadline_ns = 0;
  std::string session_id;
  std::shared_ptr<std::atomic<std::uint64_t>> attempts;
  // stop_mutex protects the claim and its terminal boundary.
  bool input_in_flight = false;
  bool ever_claimed = false;
  // The pending mutex protects the consumer validation handshake and final result.
  bool validation_requested = false;
  bool validation_started = false;
  std::optional<bool> validation;
  bool succeeded = false;
  std::string reason;
};
struct WindowsSemanticControl {
  std::shared_ptr<WindowsSemanticPending> active;
};
WindowsSemanticControl &WindowsSemanticOperations() {
  static auto *state = new WindowsSemanticControl;
  return *state;
}
thread_local WindowsSemanticPending *windows_semantic_operation = nullptr;

bool WindowsSemanticInputInFlightLocked() {
  const auto &active = WindowsSemanticOperations().active;
  return active != nullptr && active->input_in_flight;
}
bool WindowsSemanticInputInFlight() {
  std::lock_guard lock(WindowsTargetListControl().stop_mutex);
  return WindowsSemanticInputInFlightLocked();
}
bool StopWindowsSemanticInput(const WindowsSession &session, std::uint64_t *attempts) {
  std::lock_guard lock(WindowsTargetListControl().stop_mutex);
  const auto &active = WindowsSemanticOperations().active;
  if (active != nullptr && active->session_id == session.session_id) {
    auto expected = WindowsV1UiaStop::kNone;
    active->abandoned.compare_exchange_strong(expected, WindowsV1UiaStop::kCanceled);
    active->ready.notify_all();
    if (active->input_in_flight) return false;
  }
  // The abandoned barrier forbids any later claim; other input runs on this same consumer.
  *attempts = session.input_api_attempts->load(std::memory_order_acquire);
  return true;
}
void DrainWindowsSemanticInputForExit() {
  for (;;) {
    {
      std::lock_guard lock(WindowsTargetListControl().stop_mutex);
      const auto &active = WindowsSemanticOperations().active;
      if (active == nullptr) return;
      auto expected = WindowsV1UiaStop::kNone;
      active->abandoned.compare_exchange_strong(expected, WindowsV1UiaStop::kCanceled);
      active->ready.notify_all();
      if (!active->input_in_flight) return;
    }
    Sleep(10);
  }
}

bool AwaitWindowsSemanticValidation() {
  auto *pending = windows_semantic_operation;
  if (pending == nullptr || !WindowsV1UiaMayCall()) return false;
  std::unique_lock lock(pending->mutex);
  pending->validation_requested = true;
  pending->ready.notify_all();
  while (!pending->validation.has_value()) {
    if (!WindowsV1UiaMayCall()) return false;
    pending->ready.wait_for(lock, std::chrono::milliseconds(20));
  }
  return *pending->validation && WindowsV1UiaMayCall();
}

template <class Call> HRESULT InvokeWindowsSemanticInput(Call &&call, bool *accepted) {
  auto *pending = windows_semantic_operation;
  if (pending == nullptr) return E_ABORT;
  {
    std::lock_guard lock(WindowsTargetListControl().stop_mutex);
    if (WindowsSemanticOperations().active.get() != pending || pending->session_id.empty() ||
        (pending->round_trip && !pending->round_trip->MayInput(MonotonicNowNs() / 1000000)) ||
        (pending->approved_deadline_ns != 0 &&
         (MonotonicNowNs() < pending->approved_started_ns ||
          MonotonicNowNs() >= pending->approved_deadline_ns)) ||
        pending->input_in_flight || pending->ever_claimed ||
        pending->abandoned.load(std::memory_order_acquire) != WindowsV1UiaStop::kNone ||
        !WindowsV1UiaMayCall()) return E_ABORT;
    pending->input_in_flight = true;
    pending->ever_claimed = true;
    pending->attempts->fetch_add(1, std::memory_order_acq_rel);
    *accepted = true;
  }
#if defined(SPRINT_CODER_COMPUTER_USE_TEST_HANG)
  WindowsTestHang(WindowsTestHangPoint::SemanticPattern);
#endif
  struct Returned {
    WindowsSemanticPending *pending;
    ~Returned() {
      std::lock_guard lock(WindowsTargetListControl().stop_mutex);
      pending->input_in_flight = false;
      pending->ready.notify_all();
    }
  } returned{pending};
  return call();
}

struct WindowsSemanticWork {
  sprint_coder::computer_use::NativeApprovalEffect approved_effect =
      sprint_coder::computer_use::NativeApprovalEffect::kInvalid;
  std::uint32_t pid = 0;
  HWND window = nullptr;
  std::string target_id;
  std::optional<std::string> observed_signature;
  std::string kind;
  std::string metadata;
  ~WindowsSemanticWork() { std::fill(metadata.begin(), metadata.end(), '\0'); }
};
// END windows semantic operation ownership

struct WindowsUiaRisk {
  bool classified = false;
  bool secure = false;
  bool high_impact = false;
  bool metadata_complete = false;
  bool confirmation = false;
  bool other = false;
};

std::string LowercaseAscii(std::string value) {
  for (char &character : value)
    if (character >= 'A' && character <= 'Z')
      character = static_cast<char>(character + ('a' - 'A'));
  return value;
}

bool ContainsWindowsRiskText(std::string_view text) {
  const auto bits = sprint_coder::computer_use::ClassifyWindowsRiskText(text);
  return bits.confirmation || bits.other;
}

WindowsUiaRisk ClassifyWindowsUiaElementSelf(IUIAutomationElement *element) {
  WindowsUiaRisk risk;
  if (element == nullptr || !WindowsV1UiaMayCall())
    return risk;
  struct Labels {
    BSTR name = nullptr, automation_id = nullptr, help = nullptr;
    ~Labels() {
      if (name != nullptr) SysFreeString(name);
      if (automation_id != nullptr) SysFreeString(automation_id);
      if (help != nullptr) SysFreeString(help);
    }
  } labels;
  BSTR &name = labels.name, &automation_id = labels.automation_id, &help = labels.help;
  CONTROLTYPEID control_type = 0;
  BOOL password = FALSE;
  const bool attributes_read =
      WindowsV1UiaRead(name, [&] { return element->get_CurrentName(&name); }) &&
      WindowsV1UiaRead(automation_id, [&] { return element->get_CurrentAutomationId(&automation_id); }) &&
      WindowsV1UiaRead(help, [&] { return element->get_CurrentHelpText(&help); }) &&
      WindowsV1UiaRead(control_type, [&] { return element->get_CurrentControlType(&control_type); }) &&
      WindowsV1UiaRead(password, [&] { return element->get_CurrentIsPassword(&password); });
  if (!attributes_read) {
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
    return risk;
  }
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
  const auto split = sprint_coder::computer_use::ClassifyWindowsRiskText(normalized);
  risk.confirmation = split.confirmation;
  risk.other = split.other;
  risk.metadata_complete = true;
  return risk;
}

WindowsUiaRisk ClassifyWindowsUiaElement(IUIAutomationElement *element) {
  WindowsUiaRisk merged;
  if (element == nullptr)
    return merged;
  const WindowsV1UiaPath path;
  if (!WindowsV1UiaMayCall()) return merged;
  struct Objects {
    IUIAutomation *automation = nullptr;
    IUIAutomationTreeWalker *walker = nullptr;
    IUIAutomationElement *current = nullptr, *parent = nullptr;
    ~Objects() {
      if (parent != nullptr) parent->Release();
      if (current != nullptr) current->Release();
      if (walker != nullptr) walker->Release();
      if (automation != nullptr) automation->Release();
    }
  } objects;
  IUIAutomation *&automation = objects.automation;
  IUIAutomationTreeWalker *&walker = objects.walker;
  IUIAutomationElement *&current = objects.current, *&parent = objects.parent;
  if (FAILED(CreateWindowsV1Automation(&automation)) ||
      automation == nullptr || FAILED(automation->get_RawViewWalker(&walker)) ||
      walker == nullptr) {
    return {};
  }
  element->AddRef();
  current = element;
  bool metadata_complete = true;
  for (std::size_t depth = 0; current != nullptr && depth < 8; ++depth) {
    const WindowsUiaRisk risk = ClassifyWindowsUiaElementSelf(current);
    merged.classified = merged.classified || risk.classified;
    merged.secure = merged.secure || risk.secure;
    merged.high_impact = merged.high_impact || risk.high_impact;
    merged.confirmation = merged.confirmation || risk.confirmation;
    merged.other = merged.other || risk.other;
    metadata_complete = metadata_complete && risk.metadata_complete;
    // An element that could not be read ends the climb: the facts are incomplete whatever the parents
    // say (ClassifyNativePreflightFacts puts incomplete metadata ahead of secure and high impact, so
    // the reason does not change), and asking the parents of a target that stopped answering costs one
    // more timeout each.
    if (!risk.metadata_complete)
      break;
    parent = nullptr;
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
    parent = nullptr;
  }
  if (current != nullptr) metadata_complete = false;
  merged.metadata_complete = metadata_complete;
  return merged;
}

WindowsUiaRisk ClassifyWindowsPointOnWorker(POINT point, std::uint32_t expected_pid,
                                    std::string *control_signature) {
  if (control_signature != nullptr)
    control_signature->clear();
  struct Objects {
    IUIAutomation *automation = nullptr;
    IUIAutomationElement *element = nullptr;
    ~Objects() {
      if (element != nullptr) element->Release();
      if (automation != nullptr) automation->Release();
    }
  } objects;
  IUIAutomation *&automation = objects.automation;
  IUIAutomationElement *&element = objects.element;
  if (FAILED(CreateWindowsV1Automation(&automation)) ||
      automation == nullptr)
    return {};
  const POINT query = point;
  const HRESULT found =
      WindowsV1UiaContact(element, [&] { return automation->ElementFromPoint(query, &element); });
  if (!WindowsV1UiaOk(found) || element == nullptr) {
    return {};
  }
  int owner_pid = 0;
  if (!WindowsV1UiaRead(owner_pid, [&] { return element->get_CurrentProcessId(&owner_pid); }) || owner_pid <= 0 ||
      static_cast<std::uint32_t>(owner_pid) != expected_pid) {
    return {};
  }
  const WindowsUiaRisk risk = ClassifyWindowsUiaElement(element);
  // The control signature is only for a target that is going to be acted on: when the facts are
  // incomplete the caller rejects the action and never reads it, so it is not asked for (one more call
  // to an element that has just failed to answer).
  if (control_signature != nullptr && risk.metadata_complete)
    ComputeWindowsControlSignature(element, expected_pid, nullptr, control_signature);
  return risk;
}

WindowsUiaRisk ClassifyWindowsFocusedElementOnWorker(std::uint32_t expected_pid) {
  struct Objects {
    IUIAutomation *automation = nullptr;
    IUIAutomationElement *element = nullptr;
    ~Objects() {
      if (element != nullptr) element->Release();
      if (automation != nullptr) automation->Release();
    }
  } objects;
  IUIAutomation *&automation = objects.automation;
  IUIAutomationElement *&element = objects.element;
  if (FAILED(CreateWindowsV1Automation(&automation)) ||
      automation == nullptr)
    return {};
  const HRESULT found =
      WindowsV1UiaContact(element, [&] { return automation->GetFocusedElement(&element); });
  if (!WindowsV1UiaOk(found) || element == nullptr) {
    return {};
  }
  int owner_pid = 0;
  if (!WindowsV1UiaRead(owner_pid, [&] { return element->get_CurrentProcessId(&owner_pid); }) || owner_pid <= 0 ||
      static_cast<std::uint32_t>(owner_pid) != expected_pid) {
    return {};
  }
  const WindowsUiaRisk risk = ClassifyWindowsUiaElement(element);
  return risk;
}

struct WindowsUiaPointResult {
  WindowsUiaRisk risk;
  std::string signature;
};

WindowsUiaRisk ClassifyWindowsPoint(POINT point, std::uint32_t expected_pid,
                                    std::string *control_signature = nullptr) {
  if (control_signature != nullptr) control_signature->clear();
  WindowsUiaRisk result;
  const bool want_signature = control_signature != nullptr;
  RunWindowsUiaRead<WindowsUiaPointResult>(true,
      [point, expected_pid, want_signature]() -> std::optional<WindowsUiaPointResult> {
        WindowsUiaPointResult value;
        value.risk = ClassifyWindowsPointOnWorker(point, expected_pid, want_signature ? &value.signature : nullptr);
        return value;
      }, [&result, control_signature](WindowsUiaPointResult value) {
        result = value.risk;
        if (control_signature != nullptr) *control_signature = std::move(value.signature);
      });
  return result;
}

WindowsUiaRisk ClassifyWindowsFocusedElement(std::uint32_t expected_pid) {
  WindowsUiaRisk result;
  RunWindowsUiaRead<WindowsUiaRisk>(true,
      [expected_pid]() -> std::optional<WindowsUiaRisk> {
        return ClassifyWindowsFocusedElementOnWorker(expected_pid);
      }, [&result](WindowsUiaRisk value) { result = value; });
  return result;
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
  struct Values {
    BSTR automation_id = nullptr;
    SAFEARRAY *runtime_id = nullptr;
    bool accessed = false;
    ~Values() {
      if (automation_id != nullptr) SysFreeString(automation_id);
      if (runtime_id != nullptr) {
        if (accessed) SafeArrayUnaccessData(runtime_id);
        SafeArrayDestroy(runtime_id);
      }
    }
  } values;
  BSTR &automation_id = values.automation_id;
  SAFEARRAY *&runtime_id = values.runtime_id;
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
  values.accessed = SUCCEEDED(accessed);
  if (!bounded_shape || FAILED(accessed) || runtime_values == nullptr) return false;
  std::string material =
      "computer-control-element-v1\n" + std::to_string(control_type) + "\n" +
      std::to_string(bounds.left) + "," + std::to_string(bounds.top) + "," +
      std::to_string(bounds.right) + "," + std::to_string(bounds.bottom) + "\n";
  for (LONG index = lower; index <= upper; ++index)
    material += std::to_string(runtime_values[index - lower]) + ",";
  material += "\n";
  if (automation_id != nullptr) {
    material += Utf8FromWide(
        std::wstring_view(automation_id, SysStringLen(automation_id)));
  }
  *signature = Sha256String(material);
  return signature->size() == 64;
}

bool ReadWindowsBackgroundRuntimeId(IUIAutomationElement *element,
                                    sprint_coder::computer_use::WindowsBackgroundAncestor *node) {
  int pid = 0;
  struct Runtime {
    SAFEARRAY *value = nullptr;
    ~Runtime() { if (value != nullptr) SafeArrayDestroy(value); }
  } runtime;
  SAFEARRAY *&runtime_id = runtime.value;
  if (!WindowsV1UiaRead(pid, [&] { return element->get_CurrentProcessId(&pid); }) || pid <= 0 ||
      !WindowsV1UiaRead(runtime_id, [&] { return element->GetRuntimeId(&runtime_id); }) ||
      runtime.value == nullptr || SafeArrayGetDim(runtime.value) != 1 ||
      SafeArrayGetElemsize(runtime.value) != sizeof(LONG)) return false;
  LONG lower = 0, upper = -1;
  if (FAILED(SafeArrayGetLBound(runtime.value, 1, &lower)) ||
      FAILED(SafeArrayGetUBound(runtime.value, 1, &upper)) ||
      upper < lower || static_cast<std::int64_t>(upper) - lower >= 64) return false;
  node->pid = static_cast<std::uint32_t>(pid);
  for (std::int64_t index = lower; index <= upper; ++index) {
    LONG at = static_cast<LONG>(index), value = 0;
    if (FAILED(SafeArrayGetElement(runtime.value, &at, &value))) return false;
    node->runtime_id.push_back(value);
  }
  return WindowsV1UiaMayCall();
}

bool ComputeWindowsBackgroundControlSignature(IUIAutomationElement *element,
    std::uint32_t pid, HWND window, std::string *signature) {
  using namespace sprint_coder::computer_use;
  using windows_uia_source_detail::ComRef;
  if (element == nullptr || signature == nullptr || window == nullptr) return false;
  signature->clear();
  WindowsBackgroundBindingFacts facts;
  facts.pid = pid;
  facts.window = reinterpret_cast<std::uintptr_t>(window);
  if (!ComputeWindowsControlSignature(element, pid, nullptr, &facts.control_signature)) return false;
  const auto text = [&](PROPERTYID property, std::string *out) {
    VARIANT value;
    VariantInit(&value);
    const bool read = WindowsV1UiaRead(value.vt, [&] {
      return element->GetCurrentPropertyValueEx(property, TRUE, &value);
    });
    bool ok = read && value.vt == VT_BSTR && value.bstrVal != nullptr &&
              SysStringLen(value.bstrVal) <= 4096;
    if (ok) {
      const auto wide = std::wstring_view(value.bstrVal, SysStringLen(value.bstrVal));
      *out = Utf8FromWide(wide);
      ok = (wide.empty() || !out->empty()) && out->size() <= 4096;
    }
    VariantClear(&value);
    return ok;
  };
  if (!text(UIA_NamePropertyId, &facts.name) ||
      !text(UIA_ItemStatusPropertyId, &facts.item_status) ||
      !text(UIA_ProviderDescriptionPropertyId, &facts.provider)) return false;
  // Descriptions are evidence of exclusion, not an attestation of stable item identity.
  // Unknown provider/runtime combinations stay closed until the versioned provider table exists.
  const auto provider = LowercaseAscii(facts.provider);
  if (provider.find("proxy") != std::string::npos || provider.find("msaa") != std::string::npos)
    facts.proxy = WindowsBackgroundProxy::kIndex;
  if (facts.proxy != WindowsBackgroundProxy::kStable) return false;
  for (const auto property : {UIA_IsValuePatternAvailablePropertyId, UIA_IsRangeValuePatternAvailablePropertyId}) {
    VARIANT value;
    VariantInit(&value);
    const bool ok = WindowsV1UiaRead(value.vt, [&] {
      return element->GetCurrentPropertyValueEx(property, TRUE, &value);
    }) && value.vt == VT_BOOL;
    if (ok && value.boolVal == VARIANT_TRUE)
      facts.value_kind |= property == UIA_IsValuePatternAvailablePropertyId ? 1u : 2u;
    VariantClear(&value);
    if (!ok) return false;
  }
  ComRef<IUIAutomation> automation;
  ComRef<IUIAutomationTreeWalker> walker;
  ComRef<IUIAutomationElement> root;
  auto *&automation_raw = *automation.Receive();
  if (FAILED(CreateWindowsV1Automation(&automation_raw)) || automation.Get() == nullptr) return false;
  auto *&root_raw = *root.Receive();
  auto *&walker_raw = *walker.Receive();
  if (!WindowsV1UiaOk(WindowsV1UiaContact(root_raw, [&] { return automation_raw->ElementFromHandle(window, &root_raw); })) ||
      root.Get() == nullptr ||
      !WindowsV1UiaRead(walker_raw, [&] { return automation_raw->get_RawViewWalker(&walker_raw); }) ||
      walker.Get() == nullptr) return false;
  element->AddRef();
  ComRef<IUIAutomationElement> current(element);
  for (std::size_t depth = 0; depth <= 16; ++depth) {
    WindowsBackgroundAncestor node;
    if (!ReadWindowsBackgroundRuntimeId(current.Get(), &node) || node.pid != pid) return false;
    facts.ancestors.push_back(std::move(node));
    BOOL at_root = FALSE;
    if (!WindowsV1UiaRead(at_root, [&] {
      return automation_raw->CompareElements(current.Get(), root.Get(), &at_root);
    })) return false;
    if (at_root) {
      facts.reached_root = true;
      if (depth == 0) facts.sibling_count = 1;
      break;
    }
    ComRef<IUIAutomationElement> parent;
    auto *&parent_raw = *parent.Receive();
    if (!WindowsV1UiaOk(WindowsV1UiaCall(parent_raw, [&] { return walker_raw->GetParentElement(current.Get(), &parent_raw); })) || parent.Get() == nullptr) return false;
    if (depth == 0) {
      ComRef<IUIAutomationElement> sibling;
      auto *&child_raw = *sibling.Receive();
      if (!WindowsV1UiaOk(WindowsV1UiaCall(child_raw, [&] { return walker_raw->GetFirstChildElement(parent.Get(), &child_raw); }))) return false;
      std::set<std::vector<std::int32_t>> identities;
      std::size_t matches = 0;
      while (sibling.Get() != nullptr) {
        if (facts.sibling_count >= 5000) return false;
        WindowsBackgroundAncestor identity;
        if (!ReadWindowsBackgroundRuntimeId(sibling.Get(), &identity) || identity.pid != pid ||
            !identities.insert(identity.runtime_id).second) return false;
        BOOL same = FALSE;
        if (!WindowsV1UiaRead(same, [&] {
          return automation_raw->CompareElements(element, sibling.Get(), &same);
        })) return false;
        if (same) { ++matches; facts.sibling_index = facts.sibling_count; }
        ++facts.sibling_count;
        ComRef<IUIAutomationElement> next;
        auto *&next_raw = *next.Receive();
        if (!WindowsV1UiaOk(WindowsV1UiaCall(next_raw, [&] { return walker_raw->GetNextSiblingElement(sibling.Get(), &next_raw); }))) return false;
        sibling = std::move(next);
      }
      if (matches != 1) return false;
    }
    current = std::move(parent);
  }
  facts.complete = WindowsV1UiaMayCall();
  *signature = WindowsBackgroundBindingDigest(facts);
  return !signature->empty();
}

struct WindowsControlBindings {
  std::unordered_map<std::string, std::string> semantic;
  std::set<std::string> visual;
};

bool ReadWindowsElementTargetId(IUIAutomationElement *element,
                                std::string *target_id) {
  if (element == nullptr || target_id == nullptr)
    return false;
  struct Labels {
    BSTR automation_id = nullptr, name = nullptr;
    ~Labels() {
      if (automation_id != nullptr) SysFreeString(automation_id);
      if (name != nullptr) SysFreeString(name);
    }
  } labels;
  BSTR &automation_id = labels.automation_id, &name = labels.name;
  const bool read =
      WindowsV1UiaRead(automation_id, [&] { return element->get_CurrentAutomationId(&automation_id); }) &&
      WindowsV1UiaRead(name, [&] { return element->get_CurrentName(&name); });
  if (!read) {
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
    return false;
  }
  *target_id = automation_utf8.empty() ? name_utf8 : automation_utf8;
  return target_id->size() <= 128;
}

bool CollectWindowsControlBindings(IUIAutomationElement *element,
                                   IUIAutomationTreeWalker *walker,
                                   std::uint32_t expected_pid, std::size_t depth,
                                   std::size_t *nodes,
                                   WindowsControlBindings *bindings,
                                   std::set<std::string> *duplicate_targets,
                                   HWND background_window = nullptr) {
  if (element == nullptr || walker == nullptr || nodes == nullptr || bindings == nullptr ||
      duplicate_targets == nullptr || depth > 16 || *nodes >= 5'000 || !WindowsV1UiaMayCall())
    return false;
  ++*nodes;
  WindowsV1UiaCountNode();

  std::string signature;
  if (!ComputeWindowsControlSignature(element, expected_pid, nullptr, &signature))
    return false;
  bindings->visual.insert(signature);
  if (background_window != nullptr &&
      !ComputeWindowsBackgroundControlSignature(element, expected_pid, background_window, &signature))
    signature.clear();

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

  struct Children {
    IUIAutomationElement *child = nullptr, *next = nullptr;
    ~Children() {
      if (next != nullptr) next->Release();
      if (child != nullptr) child->Release();
    }
  } children;
  IUIAutomationElement *&child = children.child, *&next = children.next;
  const HRESULT first_result =
      WindowsV1UiaCall(child, [&] { return walker->GetFirstChildElement(element, &child); });
  if (!WindowsV1UiaOk(first_result)) {
    return false;
  }
  while (child != nullptr) {
    if (!CollectWindowsControlBindings(child, walker, expected_pid, depth + 1, nodes,
                                       bindings, duplicate_targets, background_window)) {
      return false;
    }
    next = nullptr;
    const HRESULT next_result =
        WindowsV1UiaCall(next, [&] { return walker->GetNextSiblingElement(child, &next); });
    child->Release();
    child = nullptr;
    if (!WindowsV1UiaOk(next_result)) return false;
    child = next;
    next = nullptr;
  }
  return true;
}

bool CaptureWindowsControlBindingsOnWorker(std::uint32_t pid, HWND window,
                                  WindowsControlBindings *bindings, bool background = false) {
  if (bindings == nullptr)
    return false;
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
  if (FAILED(CreateWindowsV1Automation(&automation)) ||
      automation == nullptr)
    return false;
  const bool initialized =
      WindowsV1UiaOk(WindowsV1UiaContact(root, [&] { return automation->ElementFromHandle(window, &root); })) &&
      root != nullptr &&
      SUCCEEDED(automation->get_RawViewWalker(&walker)) && walker != nullptr;
  std::size_t nodes = 0;
  std::set<std::string> duplicate_targets;
  const bool complete =
      initialized && CollectWindowsControlBindings(root, walker, pid, 0, &nodes, bindings,
                                                   &duplicate_targets, background ? window : nullptr);
  return complete && nodes > 0 && nodes <= 5'000;
}

bool CaptureWindowsControlBindings(std::uint32_t pid, HWND window,
                                  WindowsControlBindings *bindings, bool background = false) {
  if (bindings == nullptr) return false;
  // MSVC containers can allocate in a move constructor. Publish only ownership under the
  // engine's locks; swap/destroy the caller's old value after those locks have been released.
  std::unique_ptr<WindowsControlBindings> measured;
  if (!RunWindowsUiaRead<std::unique_ptr<WindowsControlBindings>>(false,
      [pid, window, background]() -> std::optional<std::unique_ptr<WindowsControlBindings>> {
        auto value = std::make_unique<WindowsControlBindings>();
        if (!CaptureWindowsControlBindingsOnWorker(pid, window, value.get(), background)) return std::nullopt;
        return value;
      }, [&measured](std::unique_ptr<WindowsControlBindings> value) { measured = std::move(value); }))
    return false;
  static_assert(noexcept(bindings->semantic.swap(measured->semantic)) &&
                noexcept(bindings->visual.swap(measured->visual)));
  bindings->semantic.swap(measured->semantic);
  bindings->visual.swap(measured->visual);
  return true;
}

bool WindowsFocusedElementSignatureOnWorker(std::uint32_t expected_pid,
                                    const RECT &client_bounds,
                                    std::string *signature) {
  if (signature == nullptr)
    return false;
  if (!WindowsV1UiaMayCall()) return false;
  struct Objects {
    IUIAutomation *automation = nullptr;
    IUIAutomationElement *element = nullptr;
    ~Objects() {
      if (element != nullptr) element->Release();
      if (automation != nullptr) automation->Release();
    }
  } objects;
  IUIAutomation *&automation = objects.automation;
  IUIAutomationElement *&element = objects.element;
  if (FAILED(CreateWindowsV1Automation(&automation)) ||
      automation == nullptr)
    return false;
  const HRESULT found =
      WindowsV1UiaContact(element, [&] { return automation->GetFocusedElement(&element); });
  if (!WindowsV1UiaOk(found) || element == nullptr) {
    return false;
  }
  const bool result =
      ComputeWindowsControlSignature(element, expected_pid, &client_bounds, signature);
  return result;
}

bool WindowsFocusedElementSignature(std::uint32_t expected_pid,
                                    const RECT &client_bounds,
                                    std::string *signature) {
  if (signature == nullptr) return false;
  std::string measured;
  if (!RunWindowsUiaRead<std::string>(false,
      [expected_pid, client_bounds]() -> std::optional<std::string> {
        std::string value;
        if (!WindowsFocusedElementSignatureOnWorker(expected_pid, client_bounds, &value)) return std::nullopt;
        return value;
      }, [&measured](std::string value) { measured = std::move(value); }))
    return false;
  signature->swap(measured);
  return true;
}

bool RejectWindowsRisk(const WindowsUiaRisk &risk, std::string *reason,
    sprint_coder::computer_use::NativeApprovalEffect approved_effect =
        sprint_coder::computer_use::NativeApprovalEffect::kInvalid) {
  using namespace sprint_coder::computer_use;
  const auto decision = ClassifyNativePreflightFacts(
      {risk.metadata_complete, risk.classified, risk.secure, risk.high_impact});
  // An approved dispatch is judged by the Windows approved-risk table for its claimed effect; every
  // other dispatch keeps the V1 decision above unchanged.
  const auto judged = approved_effect == NativeApprovalEffect::kInvalid
      ? decision
      : ClassifyWindowsNativeRisk(
          {risk.classified, risk.secure, risk.high_impact, risk.confirmation, risk.other},
          risk.metadata_complete, approved_effect);
  if (NativePreflightAllowsDispatch(judged)) return false;
  switch (judged.reason) {
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
  using sprint_coder::computer_use::windows_uia_source_detail::BstrHolder;
  BstrHolder automation_owner, name_owner;
  BSTR &automation_id = *automation_owner.Receive(), &name = *name_owner.Receive();
  const bool attributes_read =
      WindowsV1UiaRead(automation_id, [&] { return element->get_CurrentAutomationId(&automation_id); }) &&
      WindowsV1UiaRead(name, [&] { return element->get_CurrentName(&name); });
  if (!attributes_read) {
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
  if (automation_utf8 == target_id ||
      (automation_utf8.empty() && name_utf8 == target_id)) {
    if (*match == nullptr) {
      element->AddRef();
      *match = element;
    } else {
      *duplicate = true;
    }
  }
  using sprint_coder::computer_use::windows_uia_source_detail::ComRef;
  ComRef<IUIAutomationElement> child_owner, next_owner;
  IUIAutomationElement *&child = *child_owner.Receive(), *&next = *next_owner.Receive();
  if (!WindowsV1UiaOk(WindowsV1UiaCall(child, [&] { return walker->GetFirstChildElement(element, &child); }))) {
    return false;
  }
  while (child != nullptr && !*duplicate) {
    if (!FindUiaTargetRecursive(child, walker, target_id, depth + 1, visited,
                                match, duplicate)) {
      return false;
    }
    next = nullptr;
    if (!WindowsV1UiaOk(WindowsV1UiaCall(next, [&] { return walker->GetNextSiblingElement(child, &next); }))) {
      return false;
    }
    child_owner.Reset();
    child = next;
    next = nullptr;
  }
  return !*duplicate;
}

bool FindWindowsSemanticTarget(HWND window,
                               std::string_view target_id,
                               IUIAutomationElement **output,
                               std::string *reason) {
  if (target_id.empty() || target_id.size() > 128) {
    *reason = "target_required";
    return false;
  }
  using sprint_coder::computer_use::windows_uia_source_detail::ComRef;
  ComRef<IUIAutomation> automation_owner;
  ComRef<IUIAutomationElement> root_owner, match_owner;
  ComRef<IUIAutomationTreeWalker> walker_owner;
  IUIAutomation *&automation = *automation_owner.Receive();
  IUIAutomationElement *&root = *root_owner.Receive(), *&match = *match_owner.Receive();
  IUIAutomationTreeWalker *&walker = *walker_owner.Receive();
  if (FAILED(CreateWindowsV1Automation(&automation)) ||
      automation == nullptr) {
    *reason = "accessibility_unavailable";
    return false;
  }
  const WindowsV1UiaPath path;
  const bool initialized =
      WindowsV1UiaOk(WindowsV1UiaContact(root, [&] { return automation->ElementFromHandle(window, &root); })) &&
      root != nullptr && SUCCEEDED(automation->get_RawViewWalker(&walker)) &&
      walker != nullptr;
  std::size_t visited = 0;
  bool duplicate = false;
  const bool searched =
      initialized && FindUiaTargetRecursive(root, walker, target_id, 0,
                                            &visited, &match, &duplicate);
  root_owner.Reset();
  walker_owner.Reset();
  automation_owner.Reset();
  if (!searched || duplicate || match == nullptr) {
    // A call that timed out is not "no such target": the target did not answer (transient).
    *reason = duplicate ? "target_ambiguous"
              : path.Stop() == WindowsV1UiaStop::kTimeout ? "accessibility_timeout"
                                                          : "target_required";
    return false;
  }
  *output = match;
  match = nullptr;
  return true;
}

// Shared by ordinary preflight and every approval remeasurement. No focus fallback.
bool ValidateWindowsBackgroundActionBinding(const WindowsSession &session,
                                            const std::string &metadata) {
  using namespace sprint_coder::computer_use;
  if (session.input_session.kind != InputSessionKind::kBackground) return true;
  std::string target;
  if (!ReadJsonString(metadata, "targetId", &target) || target.empty()) return false;
  const auto observed = session.semantic_control_signatures.find(target);
  if (observed == session.semantic_control_signatures.end()) return false;
  std::string current;
  const auto pid = session.pid;
  const auto window = session.active_window;
  if (!RunWindowsUiaRead<std::string>(false,
      [pid, window, target]() -> std::optional<std::string> {
        windows_uia_source_detail::ComRef<IUIAutomationElement> element;
        std::string reason, signature;
        if (!FindWindowsSemanticTarget(window, target, element.Receive(), &reason) ||
            !ComputeWindowsBackgroundControlSignature(element.Get(), pid, window, &signature))
          return std::nullopt;
        return signature;
      }, [&current](std::string signature) { current = std::move(signature); })) return false;
  return WindowsBackgroundBindingMatches(true, observed->second, current);
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

bool DispatchWindowsSemanticActionOnWorker(const WindowsSemanticWork &work, bool *accepted,
                                           std::string *reason) {
  using sprint_coder::computer_use::windows_uia_source_detail::ComRef;
  using sprint_coder::computer_use::windows_uia_source_detail::BstrHolder;
  const auto &target_id = work.target_id;
  const auto &metadata = work.metadata;
  const auto &kind = work.kind;
  ComRef<IUIAutomationElement> target_owner;
  IUIAutomationElement *&target = *target_owner.Receive();
  if (!FindWindowsSemanticTarget(work.window, target_id, &target, reason))
    return false;
  std::string current_target_signature;
  if (!work.observed_signature.has_value() ||
      !ComputeWindowsControlSignature(target, work.pid, nullptr,
                                      &current_target_signature) ||
      current_target_signature != *work.observed_signature) {
    *reason = "stale_target";
    return false;
  }
  if (RejectWindowsRisk(ClassifyWindowsUiaElement(target), reason, work.approved_effect)) {
    return false;
  }
  if (!AwaitWindowsSemanticValidation()) {
    *reason = "stale_target";
    return false;
  }

  HRESULT action_result = E_FAIL;
  if (kind == "invoke") {
    ComRef<IUIAutomationInvokePattern> pattern_owner;
    IUIAutomationInvokePattern *&pattern = *pattern_owner.Receive();
    if (ReadWindowsV1Pattern(target, UIA_InvokePatternId, &pattern)) {
      // The action is SENT only while the path is alive: after a timeout or a Cancel nothing is done
      // (a rejection before any input), never a call that cannot be confirmed.
      if (!WindowsV1UiaMayCall()) {
        *reason = WindowsV1UiaEndedReason();
      } else {
        action_result = InvokeWindowsSemanticInput([&] { return pattern->Invoke(); }, accepted);
      }
    } else {
      *reason = "semantic_pattern_unavailable";
    }
  } else if (kind == "set_text") {
    std::string text;
    std::wstring wide_text;
    ComRef<IUIAutomationValuePattern> pattern_owner;
    IUIAutomationValuePattern *&pattern = *pattern_owner.Receive();
    if (!ReadJsonString(metadata, "text", &text) ||
        !Utf16FromUtf8(text, &wide_text)) {
      *reason = "invalid_text";
    } else if (ReadWindowsV1Pattern(target, UIA_ValuePatternId, &pattern)) {
      BstrHolder value_owner;
      BSTR &value = *value_owner.Receive();
      value = SysAllocStringLen(wide_text.data(), static_cast<UINT>(wide_text.size()));
      if (value == nullptr && !wide_text.empty()) {
        *reason = "semantic_action_failed";
      } else {
        // The action is SENT only while the path is alive: after a timeout or a Cancel nothing is done
        // (a rejection before any input), never a call that cannot be confirmed.
        if (!WindowsV1UiaMayCall()) {
          *reason = WindowsV1UiaEndedReason();
        } else {
          action_result = InvokeWindowsSemanticInput([&] { return pattern->SetValue(value); }, accepted);
        }
      }
    } else {
      *reason = "semantic_pattern_unavailable";
    }
  } else if (kind == "select") {
    std::string selected_value;
    ComRef<IUIAutomationSelectionItemPattern> pattern_owner;
    IUIAutomationSelectionItemPattern *&pattern = *pattern_owner.Receive();
    BstrHolder name_owner;
    BSTR &name = *name_owner.Receive();
    const bool name_read = WindowsV1UiaRead(name, [&] { return target->get_CurrentName(&name); });
    const std::string target_name =
        name == nullptr || !name_read
            ? std::string{}
            : Utf8FromWide(std::wstring_view(name, SysStringLen(name)));
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
        action_result = InvokeWindowsSemanticInput([&] { return pattern->Select(); }, accepted);
      }
    } else {
      *reason = "semantic_pattern_unavailable";
    }
  } else if (kind == "toggle") {
    const bool wants_true =
        metadata.find("\"value\":true") != std::string::npos;
    const bool wants_false =
        metadata.find("\"value\":false") != std::string::npos;
    ComRef<IUIAutomationTogglePattern> pattern_owner;
    IUIAutomationTogglePattern *&pattern = *pattern_owner.Receive();
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
          action_result = InvokeWindowsSemanticInput([&] { return pattern->Toggle(); }, accepted);
        }
      }
    }
  } else if (kind == "expand_collapse") {
    const bool wants_expand =
        metadata.find("\"expanded\":true") != std::string::npos;
    const bool wants_collapse =
        metadata.find("\"expanded\":false") != std::string::npos;
    ComRef<IUIAutomationExpandCollapsePattern> pattern_owner;
    IUIAutomationExpandCollapsePattern *&pattern = *pattern_owner.Receive();
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
          action_result = InvokeWindowsSemanticInput([&] { return wants_expand ? pattern->Expand() : pattern->Collapse(); }, accepted);
        }
      }
    }
  }
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

bool DispatchWindowsSemanticAction(const WindowsSession &session, const RECT &expected,
                                   std::uint64_t expected_epoch, std::string_view kind,
                                   const std::string &metadata, bool *accepted, std::string *reason,
                                   sprint_coder::computer_use::NativeApprovalEffect approved_effect =
                                       sprint_coder::computer_use::NativeApprovalEffect::kInvalid) {
  *accepted = false;
  const WindowsV1UiaPath path;
  if (!WindowsV1UiaMayCall()) { *reason = WindowsV1UiaEndedReason(); return false; }
  WindowsV1UiaLane snapshot = *windows_v1_uia_lane;
  snapshot.epoch = expected_epoch;
  if (!snapshot.stop_serial.has_value()) snapshot.stop_serial = WindowsValidationFrameStopSerial();
  auto work = std::make_unique<WindowsSemanticWork>();
  work->approved_effect = approved_effect;
  if (!ReadJsonString(metadata, "targetId", &work->target_id) || work->target_id.empty() || work->target_id.size() > 128) {
    *reason = "target_required"; return false;
  }
  work->pid = session.pid;
  work->window = session.active_window;
  const auto observed = session.semantic_control_signatures.find(work->target_id);
  if (observed != session.semantic_control_signatures.end()) work->observed_signature = observed->second;
  work->kind = std::string(kind);
  work->metadata = metadata;
  auto pending = std::make_shared<WindowsSemanticPending>();
  pending->approved_started_ns = session.approved_started_ns;
  pending->approved_deadline_ns = session.approved_deadline_ns;
  pending->session_id = session.session_id;
  pending->round_trip = session.round_trip;
  pending->attempts = session.input_api_attempts;
  auto &control = WindowsTargetListControl();
  {
    std::lock_guard stop_lock(control.stop_mutex);
    if (!WindowsValidationStillCurrent(snapshot.epoch, *snapshot.stop_serial)) {
      *reason = "semantic_action_failed"; return false;
    }
    if (WindowsUiaReadWorkerRunning().exchange(true, std::memory_order_acq_rel)) {
      *reason = "accessibility_unavailable"; return false;
    }
    WindowsSemanticOperations().active = pending;
  }
  try {
    std::thread([pending, snapshot, work = std::move(work)]() mutable {
      struct Progress {
        explicit Progress(WindowsSemanticPending *value) {
          windows_uia_read_progress = value;
          windows_semantic_operation = value;
        }
        ~Progress() { windows_semantic_operation = nullptr; windows_uia_read_progress = nullptr; }
      } progress(pending.get());
      const WindowsV1UiaPath worker_path(snapshot);
      bool succeeded = false, accepted = false;
      std::string reason;
      try {
        struct Apartment {
          HRESULT result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
          ~Apartment() { if (SUCCEEDED(result)) CoUninitialize(); }
        } apartment;
        if (SUCCEEDED(apartment.result) && WindowsV1UiaMayCall())
          succeeded = DispatchWindowsSemanticActionOnWorker(*work, &accepted, &reason);
        else reason = "accessibility_unavailable";
      } catch (...) {
        succeeded = false;
        reason = accepted ? "input_not_confirmed" : "semantic_action_failed";
      }
      work.reset();
      {
        std::lock_guard lock(pending->mutex);
        std::lock_guard stop_lock(WindowsTargetListControl().stop_mutex);
        if (pending->abandoned.load(std::memory_order_acquire) == WindowsV1UiaStop::kNone) {
          pending->succeeded = succeeded;
          pending->reason = std::move(reason);
          pending->stop.store(worker_path.Stop(), std::memory_order_release);
        }
        pending->done = true;
        if (WindowsSemanticOperations().active == pending) WindowsSemanticOperations().active.reset();
        WindowsUiaReadWorkerRunning().store(false, std::memory_order_release);
      }
      pending->ready.notify_all();
    }).detach();
  } catch (...) {
    std::lock_guard stop_lock(control.stop_mutex);
    if (WindowsSemanticOperations().active == pending) WindowsSemanticOperations().active.reset();
    WindowsUiaReadWorkerRunning().store(false, std::memory_order_release);
    *reason = "accessibility_unavailable";
    return false;
  }
  struct Abandon {
    std::shared_ptr<WindowsSemanticPending> pending;
    ~Abandon() {
      std::lock_guard lock(WindowsTargetListControl().stop_mutex);
      auto none = WindowsV1UiaStop::kNone;
      pending->abandoned.compare_exchange_strong(none, WindowsV1UiaStop::kCanceled);
      pending->ready.notify_all();
    }
  } abandon{pending};
  std::unique_lock lock(pending->mutex);
  for (;;) {
    bool validate = false;
    {
      std::lock_guard stop_lock(control.stop_mutex);
      auto &lane = *windows_v1_uia_lane;
      auto stop = lane.stop;
      if (stop == WindowsV1UiaStop::kNone) stop = pending->abandoned.load(std::memory_order_acquire);
      if (stop == WindowsV1UiaStop::kNone && !WindowsValidationStillCurrent(snapshot.epoch, *snapshot.stop_serial)) stop = WindowsV1UiaStop::kCanceled;
      if (stop == WindowsV1UiaStop::kNone && lane.has_deadline && std::chrono::steady_clock::now() > lane.deadline) stop = WindowsV1UiaStop::kBudget;
      if (stop == WindowsV1UiaStop::kNone && pending->contact_active &&
          std::chrono::steady_clock::now() - pending->contact_started >= kWindowsV1UiaSlowContact) stop = WindowsV1UiaStop::kTimeout;
      if (stop != WindowsV1UiaStop::kNone) {
        auto none = WindowsV1UiaStop::kNone;
        pending->abandoned.compare_exchange_strong(none, stop);
        lane.stop = pending->stop.load(std::memory_order_acquire);
        if (lane.stop == WindowsV1UiaStop::kNone) lane.stop = stop;
        lane.nodes += pending->nodes.load(std::memory_order_acquire);
        *accepted = pending->ever_claimed;
        *reason = pending->input_in_flight ? "semantic_input_in_flight" : pending->ever_claimed ? "input_not_confirmed" :
            stop == WindowsV1UiaStop::kTimeout ? "accessibility_timeout" : "semantic_action_failed";
        return false;
      }
      if (pending->done) {
        lane.stop = pending->stop.load(std::memory_order_acquire);
        lane.nodes += pending->nodes.load(std::memory_order_acquire);
        *accepted = pending->ever_claimed;
        *reason = std::move(pending->reason);
        return pending->succeeded;
      }
      if (pending->validation_requested && !pending->validation_started) {
        pending->validation_started = true;
        validate = true;
      }
    }
    if (validate) {
      lock.unlock();
      const bool valid = RevalidateWindowsTarget(session, expected, expected_epoch);
      lock.lock();
      {
        std::lock_guard stop_lock(control.stop_mutex);
        const bool current = WindowsValidationStillCurrent(snapshot.epoch, *snapshot.stop_serial) &&
            pending->abandoned.load(std::memory_order_acquire) == WindowsV1UiaStop::kNone;
        pending->validation = valid && current;
        if (!valid && current) {
          auto none = WindowsV1UiaStop::kNone;
          pending->abandoned.compare_exchange_strong(none, WindowsV1UiaStop::kCanceled);
          windows_v1_uia_lane->nodes += pending->nodes.load(std::memory_order_acquire);
          windows_v1_uia_lane->stop = pending->stop.load(std::memory_order_acquire);
          *reason = "stale_target";
          pending->ready.notify_all();
          return false;
        }
      }
      pending->ready.notify_all();
    } else pending->ready.wait_for(lock, std::chrono::milliseconds(20));
  }
}

