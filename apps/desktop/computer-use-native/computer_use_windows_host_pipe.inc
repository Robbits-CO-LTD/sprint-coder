bool ObserveWindowsWindow(WindowsSession &session, std::string *response,
                          std::vector<std::uint8_t> *binary,
                          std::string *reason,
                          std::optional<std::uint64_t> queued_stop_serial = std::nullopt) {
  if (!WindowsRoundTripCurrent(session) || (session.round_trip && !session.round_trip->MayObserve())) {
    *reason = "approval_round_trip_rejected";
    return false;
  }
  RECT bounds{};
  const bool background = session.input_session.kind == sprint_coder::computer_use::InputSessionKind::kBackground;
  WindowsDialogSetSnapshot dialogs;
  // The UI Automation reads of the whole observe share one budget and the cancellation epoch (see the
  // bounds above). The reason of a read that did not complete says why (WindowsV1ObserveReason).
  const auto observe_stop_serial = queued_stop_serial.value_or(WindowsValidationFrameStopSerial());
  const WindowsV1UiaPath uia_path(kWindowsV1UiaObserveBudget, session.cancel_epoch, observe_stop_serial);
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
  std::optional<WindowsValidationFrameScope> observation_frame;
  if (background) observation_frame.emplace(observe_stop_serial);
  if (!ValidateWindowsObservationSession(session, &bounds, reason, &dialogs) ||
      session.cancel_epoch !=
          cancellation_epoch.load(std::memory_order_acquire))
    return false;
  std::string tree;
  std::size_t nodes = 0;
  if (!ReadUiaObservation(session.pid, dialogs.active_window, &tree, &nodes, background)) {
    *reason = unreadable("accessibility_unavailable");
    return false;
  }
  WindowsControlBindings bindings;
  if (!CaptureWindowsControlBindings(session.pid, dialogs.active_window,
                                     &bindings, background)) {
    *reason = unreadable("accessibility_binding_unavailable");
    return false;
  }
  std::string stable_tree;
  std::size_t stable_nodes = 0;
  if (!ReadUiaObservation(session.pid, dialogs.active_window, &stable_tree,
                          &stable_nodes, background) ||
      stable_tree != tree || stable_nodes != nodes) {
    *reason = unreadable("observation_stale");
    return false;
  }
  WindowsControlBindings stable_bindings;
  if (!CaptureWindowsControlBindings(session.pid, dialogs.active_window,
                                     &stable_bindings, background) ||
      stable_bindings.semantic != bindings.semantic ||
      stable_bindings.visual != bindings.visual) {
    *reason = unreadable("observation_stale");
    return false;
  }
  const WindowsUiaRisk focused_risk =
      background ? WindowsUiaRisk{} : ClassifyWindowsFocusedElement(session.pid);
  if (!WindowsValidationStillCurrent(session.cancel_epoch, observe_stop_serial)) {
    *reason = "observation_stale";
    return false;
  }
  // The focused element's signature is read whatever its classification says, as before #820: a live
  // focus that is only unclassified (deeper than the climb, say) keeps its signature, so its key / type
  // is refused later as target_unclassified, not as a focus that moved. After a timeout or a Cancel in
  // this observe the read is refused by the path without a call (no second wait on the element).
  std::string focused_element_signature;
  const bool has_focused_element_signature =
      !background && WindowsFocusedElementSignature(session.pid, bounds, &focused_element_signature);
  if (!WindowsValidationStillCurrent(session.cancel_epoch, observe_stop_serial)) {
    *reason = "observation_stale";
    return false;
  }
  RECT screen_bounds{};
  if (!ScreenBoundsPhysicalForWindow(dialogs.active_window, &screen_bounds)) {
    *reason = "screen_geometry_unavailable";
    return false;
  }
  std::size_t width = 0;
  std::size_t height = 0;
  WindowsV1UiaStop capture_stop = WindowsV1UiaStop::kNone;
  if (!CaptureWindowWithGraphicsCapture(dialogs.active_window, session.cancel_epoch,
                                        observe_stop_serial, binary, &width, &height,
                                        &capture_stop, background ? session.pid : 0)) {
    *reason = WindowsV1ObserveReason(capture_stop, "graphics_capture_unavailable");
    return false;
  }
  RECT stable_bounds{};
  WindowsDialogSetSnapshot stable_dialogs;
  if (!ValidateWindowsObservationSession(session, &stable_bounds, reason,
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
  WindowsV1UiaStop png_stop = WindowsV1UiaStop::kNone;
  if (!ReadWindowsPngPatchGrid(binary, width, height, session.cancel_epoch,
                              observe_stop_serial, &patch_digests, &patch_columns,
                              &patch_rows, &png_stop)) {
    binary->clear();
    *reason = WindowsV1ObserveReason(png_stop, "visual_binding_unavailable");
    return false;
  }
  std::vector<std::uint8_t> staged_binary;
  staged_binary.swap(*binary);
  struct StagedBytes {
    std::vector<std::uint8_t> &bytes;
    ~StagedBytes() { std::fill(bytes.begin(), bytes.end(), 0); }
  } staged_bytes{staged_binary};
  staged_binary.reserve(screenshot_bytes + tree_bytes);
  staged_binary.insert(staged_binary.end(), tree.begin(), tree.end());
  const auto next_revision = session.observation_revision + 1;
  const auto next_dialog_revision = session.dialog_set_revision +
      (session.dialog_set_digest != dialogs.digest ? 1 : 0);
  const auto window_value =
      static_cast<std::uint64_t>(reinterpret_cast<UINT_PTR>(session.window));
  std::string staged_response =
      "{\"result\":\"completed\",\"pid\":" + std::to_string(session.pid) +
      ",\"windowId\":\"" + std::to_string(window_value) +
      "\",\"captureWidth\":" + std::to_string(width) +
      ",\"captureHeight\":" + std::to_string(height) +
      ",\"revision\":" + std::to_string(next_revision) +
      ",\"screenshotMimeType\":\"image/png\",\"screenshotBytes\":" +
      std::to_string(screenshot_bytes) +
      ",\"treeBytes\":" + std::to_string(tree_bytes) +
      ",\"treeNodeCount\":" + std::to_string(nodes) +
      ",\"dialogSetRevision\":" +
      std::to_string(next_dialog_revision) +
      ",\"dialogSetDigest\":\"" + dialogs.digest +
      "\",\"activeWindowIdentityDigest\":\"" +
      dialogs.active_identity + "\",\"activeWindowKind\":\"" +
      dialogs.active_kind + "\"" +
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
  static_assert(std::is_nothrow_swappable_v<std::string> &&
      std::is_nothrow_swappable_v<decltype(session.observation_patch_digests)> &&
      std::is_nothrow_swappable_v<decltype(session.semantic_control_signatures)> &&
      std::is_nothrow_swappable_v<decltype(session.visual_control_signatures)>);
  const char *commit_failure = nullptr;
  {
    // The consumer owns Session state. Reader Stop and parent-death latches use this same lock.
    // All payload preparation and allocating work precede this publication boundary.
    std::lock_guard stop_lock(WindowsTargetListControl().stop_mutex);
    if (!WindowsValidationStillCurrent(session.cancel_epoch, observe_stop_serial)) {
      commit_failure = "observation_stale";
    }
    else if (windows_v1_uia_lane != nullptr && windows_v1_uia_lane->has_deadline &&
        std::chrono::steady_clock::now() > windows_v1_uia_lane->deadline) {
      commit_failure = "observation_timeout";
    }
    if (commit_failure == nullptr) {
      session.dialog_set_revision = next_dialog_revision;
      session.observation_revision = next_revision;
      session.active_window = dialogs.active_window;
      session.active_window_identity.swap(dialogs.active_identity);
      session.active_window_kind.swap(dialogs.active_kind);
      session.dialog_set_digest.swap(dialogs.digest);
      session.observation_bounds = bounds;
      session.observation_capture_width = width;
      session.observation_capture_height = height;
      session.observation_patch_columns = patch_columns;
      session.observation_patch_rows = patch_rows;
      session.observation_patch_digests.swap(patch_digests);
      session.focused_element_signature.swap(focused_element_signature);
      session.has_focused_element_signature = has_focused_element_signature;
      session.semantic_control_signatures.swap(stable_bindings.semantic);
      session.visual_control_signatures.swap(stable_bindings.visual);
      session.has_observation = true;
      response->swap(staged_response);
      binary->swap(staged_binary);
    }
  }
  for (auto &digest : patch_digests) std::fill(digest.begin(), digest.end(), '0');
  if (commit_failure != nullptr) { *reason = commit_failure; return false; }
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
    WindowsWorkerSlot &running = InterlockWorkerRunning();
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
          sprint_coder::computer_use::windows_uia_source_detail::ComRef<IUIAutomationElement> target_owner;
          IUIAutomationElement *&target = *target_owner.Receive();
          std::string why;
          if (FindWindowsSemanticTarget(copy.active_window, target_id, &target, &why)) {
            std::string current;
            const bool same_control =
                ComputeWindowsControlSignature(target, copy.pid, nullptr, &current) && current == signature;
            // The V1 risk of the element, as for every semantic action: a secure or high-impact
            // element is never read, whatever else says.
            const bool risky = RejectWindowsRisk(ClassifyWindowsUiaElement(target), &why);
            target_owner.Reset();
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
  const WindowsResidualRequestScope residual_request(request);
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
  if (!admission_error.empty() && type != MessageType::kHandshake) {
    std::string operation;
    WindowsStartResult start_result;
    if (type == MessageType::kProbe && ReadJsonString(metadata, "operation", &operation) &&
        operation == "start_session") start_result = ReadWindowsStartResult(metadata);
    // Admission can reject a conflicting retry after an earlier attempt. This invocation's zero
    // counter cannot certify that the request/session has never caused foreground effects.
    start_result.execution_unknown = true;
    return Respond(pipe, request, MessageType::kError,
        AppendWindowsStartResult(ErrorPayload(admission_error), start_result, false));
  }
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
    std::uint64_t helper_generation = 0;
    (void)ReadJsonUint64(metadata, "helperGeneration", &helper_generation);
    if (helper_generation > sprint_coder::computer_use::kNativeApprovalGenerationMax ||
        (*handshaken && helper_generation != windows_helper_generation))
      return Respond(pipe, request, MessageType::kError, ErrorPayload("HANDSHAKE_MISMATCH"));
    windows_helper_generation = helper_generation;
    *handshaken = true;
    if (!Respond(pipe, request, MessageType::kHandshakeResult,
                 ProbeJson(probe)))
      return false;
    break;
  }
  case MessageType::kCheckTargetIdentity: {
    std::string response;
    const bool succeeded = CheckWindowsTargetIdentities(metadata, &response);
    if (!Respond(pipe, request,
                 succeeded ? MessageType::kTargetIdentityResult : MessageType::kError,
                 succeeded ? response : ErrorPayload("target_identity_input_invalid"))) return false;
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
    auto start_result = std::make_shared<WindowsStartResult>();
    if (operation == "probe") {
      response = ProbeJson(probe);
      succeeded = true;
    } else if (operation == "pick_application") {
      succeeded = PickWindowsExecutable(&response, &reason,
          queued_stop_serial.value_or(WindowsTargetListControl().stop_serial.load(std::memory_order_acquire)));
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
      bool include_start_identity = false;
      if (!ReadOptionalJsonBoolean(metadata, "includeStartIdentity", &include_start_identity))
        reason = "list_targets_input_invalid";
      else succeeded = ListWindowsTargets(&response, &reason, queued_stop_serial, include_start_identity);
    } else if (operation == "start_session") {
      *start_result = ReadWindowsStartResult(metadata);
      if (!admission_error.empty()) reason = admission_error;
      else succeeded = StartWindowsSession(request, metadata, &response, &reason, queued_stop_serial,
                                           std::move(start_lease), start_result);
    } else if (operation == "stop_pending_start") {
      succeeded = StopPendingWindowsStart(request, metadata, &response, &reason);
    } else if (operation == "close_session") {
      succeeded = CloseWindowsSession(request, metadata, &response, &reason);
      if (!succeeded && reason.empty()) reason = "native_close_unconfirmed";
    } else {
      reason = "unsupported_operation";
    }
    if (!succeeded && reason == "semantic_input_in_flight") {
      if (!Respond(pipe, request, MessageType::kError,
                   AppendWindowsStartResult(ErrorPayload(reason), *start_result, false))) return false;
      break;
    }
    if (!RespondAndCache(
            pipe, request,
            succeeded ? MessageType::kProbeResult : MessageType::kError,
            AppendWindowsStartResult(succeeded ? std::move(response) : ErrorPayload(reason),
                                     *start_result, succeeded)))
      return false;
    break;
  }
  case MessageType::kCancel: {
    const auto approval = approval_states.find(FrameIdKey(request.header.session_id));
    if (approval != approval_states.end()) approval->second.Invalidate();
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
    std::uint64_t attempts = 0;
    if (!StopWindowsSemanticInput(*session, &attempts)) {
      if (!Respond(pipe, request, MessageType::kError, ErrorPayload("semantic_input_in_flight"))) return false;
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
                             std::to_string(attempts) + "}"))
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
  case MessageType::kApprovalRoundTripBegin:
  case MessageType::kApprovalRoundTripEnd:
    if (!HandleWindowsApprovalRoundTrip(pipe, request, metadata, type)) return false;
    break;
  case MessageType::kApprovalApprove:
  case MessageType::kApprovalDiscard:
  case MessageType::kDispatchApproved: {
    const WindowsV1UiaPath approval_uia_path;
    if (!HandleWindowsApproval(pipe, request, metadata, type)) return false;
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

struct WindowsInteractionDelivery {
  Frame request;
  std::string task, turn, last_trip;
  std::uint64_t sequence = 0, epoch = 0;
};

// The consumer owns sessions and pipe writes. Polling only delivers already-latched native state;
// a blocked consumer or a lost notification never opens the monitor's claim gate.
bool DeliverWindowsInteractionEvents(HANDLE pipe,
    std::unordered_map<std::string, WindowsInteractionDelivery> &deliveries) {
  using namespace sprint_coder::computer_use;
  using windows_approval_wire_detail::Quote;
  for (auto it = deliveries.begin(); it != deliveries.end();) {
    const auto found = sessions.find(it->first);
    if (found == sessions.end()) { it = deliveries.erase(it); continue; }
    auto &session = found->second;
    auto &delivery = it->second;
    ++it;
    if (session.background_monitor) {
      session.background_monitor->state.CheckHealth();
      const auto snapshot = session.background_monitor->state.Snapshot();
      if (snapshot.paused && snapshot.epoch > delivery.epoch) {
        delivery.epoch = snapshot.epoch;
        const auto payload = "{\"version\":1,\"kind\":\"background_event\",\"sessionId\":" +
            Quote(session.session_id) + ",\"taskId\":" + Quote(delivery.task) +
            ",\"turnId\":" + Quote(delivery.turn) + ",\"helperGeneration\":" +
            std::to_string(windows_helper_generation) + ",\"cancelEpoch\":" +
            std::to_string(session.cancel_epoch) + ",\"interactionEpoch\":" +
            std::to_string(snapshot.epoch) + ",\"sequence\":" +
            std::to_string(++delivery.sequence) + ",\"state\":\"paused\"}";
        if (!Respond(pipe, delivery.request, MessageType::kBackgroundInteractionEvent, payload)) return false;
      }
    }
    if (session.round_trip) {
      WindowsRoundTripCurrent(session);
      const auto event = session.round_trip->ReadNotification();
      const auto &binding = event.binding;
      if (binding.id.empty()) continue;
      const auto key = binding.id + ":" + event.state + ":" + event.failure + ":" + event.foreground;
      if (key == delivery.last_trip) continue;
      delivery.last_trip = key;
      bool degraded = false;
      const auto payload = ApprovalRoundTripEventWire(
          {binding.id, binding.session, binding.task, binding.turn, event.state, event.foreground,
           event.failure, binding.generation, binding.epoch, delivery.sequence + 1},
          &degraded);
      // A notification the contract cannot carry fails this session closed (the latch blocks its
      // return, exchange and input); it never ends the pipe for every other session.
      if (degraded) session.round_trip->Invalidate("monitor_failed");
      if (payload.empty()) continue;
      ++delivery.sequence;
      if (!Respond(pipe, delivery.request, MessageType::kApprovalRoundTripEvent, payload)) return false;
    }
  }
  return true;
}

bool ServePipe(HANDLE pipe, const BackendProbe &probe) {
  std::unordered_map<std::string, WindowsInteractionDelivery> interaction_deliveries;
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
          CancelWindowsNewStartMeasurementLocked(control);
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
  // Retirements must not wait for the request the consumer is serving.
  WindowsRetirementNotifier retirements(pipe);
  if (!retirements.Start()) {
    served = false;
    CancelIoEx(pipe, nullptr);
  }
  WindowsDiscoveryStopPump discovery_stop_pump{[&](const std::string& waiting_owner) {
    // RunWindowsDiscovery lends response/cache ownership to this pump and joins it before return.
    // Bound each pass even if the reader keeps receiving Stops. Do not run another query or input.
    for (std::size_t count = 0; count < kMaximumQueuedFrames; ++count) {
      QueuedFrame stopped;
      {
        std::lock_guard lock(queue_mutex);
        const auto next = std::find_if(queue.begin(), queue.end(),
            [&](const auto& queued) {
              // This owner's Stop already breaks its wait; keep its usual query/receipt ordering.
              return queued.discovery_stop && FrameIdKey(queued.frame.header.session_id) != waiting_owner;
            });
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
    if (!served || retirements.Failed() || !DeliverWindowsRetiredOperations(pipe) ||
        !DeliverWindowsInteractionEvents(pipe, interaction_deliveries)) {
      served = false;
      CancelIoEx(pipe, nullptr);
      break;
    }
    QueuedFrame queued;
    {
      std::unique_lock lock(queue_mutex);
      queue_ready.wait_for(lock, std::chrono::milliseconds(20),
                       [&]() { return reader_finished || !queue.empty(); });
      if (queue.empty()) {
        if (reader_finished) break;
        continue;
      }
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
    const auto session_key = FrameIdKey(queued.frame.header.session_id);
    if (sessions.contains(session_key) && !interaction_deliveries.contains(session_key)) {
      const std::string metadata(queued.frame.metadata.begin(), queued.frame.metadata.end());
      std::string task, turn;
      if (ReadJsonString(metadata, "taskId", &task) && ReadJsonString(metadata, "turnId", &turn))
        interaction_deliveries.emplace(session_key, WindowsInteractionDelivery{Frame{queued.frame.header}, task, turn});
    }
  }
  // Stop cancels a retirement write that Main never reads (the loop also ends on a protocol violation).
  retirements.Stop();
  if (reader.joinable())
    reader.join();
  return served && reader_valid && !retirements.Failed();
}

