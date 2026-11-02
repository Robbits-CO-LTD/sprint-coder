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
  if (WindowsSemanticInputInFlight() || !RevalidateWindowsTarget(session, expected, expected_epoch)) return 0;
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
  if (WindowsSemanticInputInFlight()) { *reason = "semantic_input_in_flight"; return false; }
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
      // Preserve whether the owned API is still in flight: Main must retain its original helper
      // until a later Stop proves it returned. Other unconfirmed inputs keep the generic reason.
      if (*reason != "input_timeout_unconfirmed" && *reason != "semantic_input_in_flight")
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

