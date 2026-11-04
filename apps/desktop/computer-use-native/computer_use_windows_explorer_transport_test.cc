#define wmain ProductionHostMain
#include "explorer-host.cc"
#undef wmain
#include <stdexcept>

void Require(bool ok, const char *what = "Explorer transport assertion") {
  if (!ok) throw std::runtime_error(what);
}

int wmain() {
  const auto apartment = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  Require(SUCCEEDED(apartment));
  // Disabling call cancellation that is not enabled fails: later checks use it to prove pairing.
  Require(FAILED(CoDisableCallCancellation(nullptr)), "cancellation_initially_enabled");
  const auto name = LR"(\\.\pipe\sc-explorer-measure-)" + std::to_wstring(GetCurrentProcessId());
  ScopedKernelHandle server(CreateNamedPipeW(name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
      1, 65536, 65536, 0, nullptr));
  Require(server.value != INVALID_HANDLE_VALUE);
  ScopedKernelHandle event(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  OVERLAPPED connecting{}; connecting.hEvent = event.value;
  Require(!ConnectNamedPipe(server.value, &connecting) && GetLastError() == ERROR_IO_PENDING);
  ScopedKernelHandle client(CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr,
      OPEN_EXISTING, FILE_FLAG_OVERLAPPED, nullptr));
  Require(client.value != INVALID_HANDLE_VALUE);
  DWORD transferred = 0;
  Require(GetOverlappedResult(server.value, &connecting, &transferred, TRUE));
  bool handshaken = true;
  Frame frame;
  frame.header.message_type = static_cast<std::uint16_t>(MessageType::kProbe);
  frame.header.session_id.bytes[0] = 21;
  frame.header.request_id.bytes[0] = 1;
  constexpr bool gate = sprint_coder::computer_use::kWindowsExplorerException;
  using Refusal = WindowsExplorerRefusal;
  // Every refusal is the same error on the wire; the internal reason is read from the test seam.
  const auto exchange = [&](const std::string &metadata, std::uint64_t serial) {
    frame.metadata.assign(metadata.begin(), metadata.end());
    Require(HandlePipeRequest(server.value, BackendProbe{}, frame, &handshaken, serial));
    Frame reply;
    Require(ReadFrame(client.value, &reply));
    Require(reply.header.message_type == static_cast<std::uint16_t>(MessageType::kError));
    Require(reply.header.request_id.bytes == frame.header.request_id.bytes);
    const std::string text(reply.metadata.begin(), reply.metadata.end());
    Require(text.find(gate ? "explorer_view_unreadable" : "unsupported_operation") != std::string::npos);
    ++frame.header.request_id.bytes[0];
    return windows_explorer_trace_for_test.request;
  };
  const auto expect = [&](const std::string &metadata, std::uint64_t serial, Refusal reason,
                          const char *what) {
    const Refusal actual = exchange(metadata, serial);
    if constexpr (gate) {
      if (actual != reason) {
        std::cout << "FAIL " << what << " reason=" << static_cast<int>(actual)
                  << " expected=" << static_cast<int>(reason) << std::endl;
        Require(false, what);
      }
    } else {
      Require(actual == Refusal::kNone, what);  // The gate-off build never measures.
    }
  };
  const std::string head = "{\"operation\":\"measure_explorer_view\",";
  const auto metadata = [&](const std::string &session, const std::string &window, std::uint64_t epoch,
                            const std::string &x = "1") {
    return head + "\"sessionId\":\"" + session + "\",\"windowId\":\"" + window + "\",\"x\":" + x +
        ",\"y\":1,\"cancelEpoch\":" + std::to_string(epoch) + "}";
  };
  expect(metadata("bound", "100", 0), 0, Refusal::kNoSession, "no_session");

  // A session that passes every check before the window measurement: this process, with its own
  // duplicated process and executable handles. Each case below differs from it in one check only.
  WindowsSession bound;
  bound.session_id = "bound";
  bound.window = reinterpret_cast<HWND>(100);
  bound.approval_route_v2 = true;
  bound.cancel_epoch = 2;
  bound.pid = GetCurrentProcessId();
  bound.process_handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, bound.pid);
  Require(bound.process_handle != nullptr, "self_process");
  Require(ReadProcessPath(bound.process_handle, &bound.canonical_path), "self_path");
  Require(ReadProcessStartIdentity(bound.process_handle, &bound.process_start), "self_start");
  bound.executable_file = CreateFileW(bound.canonical_path.c_str(), GENERIC_READ,
      FILE_SHARE_READ | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, 0, nullptr);
  Require(bound.executable_file != INVALID_HANDLE_VALUE, "self_executable");
  WindowsFileIdentity file_identity;
  Require(ReadWindowsFileIdentity(bound.executable_file, &file_identity), "self_file_identity");
  bound.executable_volume_serial = file_identity.volume_serial;
  bound.executable_file_id = file_identity.file_id;
  // An elevated runner fails only the elevation part of the identity check.
  const bool elevated = IsProcessElevated(bound.pid);
  const Refusal passing = elevated ? Refusal::kIdentity : Refusal::kNotVerifiedExplorer;
  if (elevated) std::cout << "NOTE elevated runner: the bound session stops at identity\n";
  sessions.emplace(FrameIdKey(frame.header.session_id), std::move(bound));
  WindowsSession &session = sessions.begin()->second;
  cancellation_epoch.store(2);
  // The control: everything current reaches the verified-Explorer measurement (or elevation).
  expect(metadata("bound", "100", 2), 0, passing, "bound_control");
  expect(metadata("bound", "100", 1), 0, Refusal::kStaleEpoch, "stale_request_epoch");
  cancellation_epoch.store(3);
  expect(metadata("bound", "100", 2), 0, Refusal::kNotCurrent, "cancelled_epoch");
  cancellation_epoch.store(2);
  WindowsTargetListControl().stop_serial.store(1);
  expect(metadata("bound", "100", 2), 0, Refusal::kNotCurrent, "stop_after_enqueue");
  expect(metadata("bound", "100", 2), 1, passing, "bound_control_after_stop");
  expect(metadata("other", "100", 2), 1, Refusal::kSessionUnbound, "session_id");
  expect(metadata("bound", "101", 2), 1, Refusal::kWindowMismatch, "window");
  expect(metadata("bound", "100", 2, "1.5"), 1, Refusal::kPointInvalid, "point");
  session.approval_revoked = true;
  expect(metadata("bound", "100", 2), 1, Refusal::kSessionUnbound, "revoked");
  session.approval_revoked = false;
  session.approval_route_v2 = false;
  expect(metadata("bound", "100", 2), 1, Refusal::kSessionUnbound, "route_v1");
  session.approval_route_v2 = true;
#if defined(SPRINT_CODER_TEST_WINDOWS_EXPLORER_EXCEPTION)
  {
    // The acceptance-only override ignores elevation so these run on an elevated runner too. It
    // never ignores an identity mismatch.
    windows_explorer_ignore_elevation_for_test = true;
    expect(metadata("bound", "100", 2), 1, Refusal::kNotVerifiedExplorer, "override_control");
    const std::string start = session.process_start;
    session.process_start = "0";
    expect(metadata("bound", "100", 2), 1, Refusal::kIdentity, "override_keeps_identity");
    session.process_start = start;
    // L3: a body that throws after the deadline started is refused, and cancellation is paired.
    windows_explorer_fault_for_test = WindowsExplorerFault::kBody;
    expect(metadata("bound", "100", 2), 1, Refusal::kException, "body_exception");
    Require(FAILED(CoDisableCallCancellation(nullptr)), "body_exception_cancellation_pairing");
    // A watcher that cannot be created leaves the measurement disabled.
    windows_explorer_fault_for_test = WindowsExplorerFault::kWatcherThread;
    expect(metadata("bound", "100", 2), 1, Refusal::kNotCurrent, "watcher_failure");
    Require(FAILED(CoDisableCallCancellation(nullptr)), "watcher_cancellation_pairing");
    windows_explorer_fault_for_test = WindowsExplorerFault::kNone;
    windows_explorer_ignore_elevation_for_test = false;
    expect(metadata("bound", "100", 2), 1, passing, "bound_control_after_faults");
  }
#endif
  if constexpr (gate) {
    const auto evidence = std::make_shared<WindowsExplorerDispatchEvidence>();
    session.explorer_dispatch_evidence = evidence;
    frame.header.message_type = static_cast<std::uint16_t>(MessageType::kDispatch);
    const std::string dispatch_metadata = R"({"sessionId":"bound","cancelEpoch":2,"kind":"click"})";
    frame.metadata.assign(dispatch_metadata.begin(), dispatch_metadata.end());
    Require(HandlePipeRequest(server.value, BackendProbe{}, frame, &handshaken, 1),
        "ticketless_dispatch_response");
    Frame reply;
    Require(ReadFrame(client.value, &reply), "ticketless_dispatch_read");
    Require(reply.header.message_type == static_cast<std::uint16_t>(MessageType::kError),
        "ticketless_dispatch_rejected");
    const std::string text(reply.metadata.begin(), reply.metadata.end());
    Require(text.find("ticket_invalid") != std::string::npos, "ticketless_dispatch_reason");
    Require(!session.explorer_dispatch_evidence && evidence->consumed,
        "ticketless_dispatch_consumes_shared_evidence");
    frame.header.message_type = static_cast<std::uint16_t>(MessageType::kProbe);
    ++frame.header.request_id.bytes[0];
  }
  frame.header.session_id.bytes[0] = 22;
  expect(metadata("bound", "100", 2), 1, Refusal::kNoSession, "different_session");
  ReleaseWindowsSessionResources(&session);
  sessions.clear();
#if defined(SPRINT_CODER_TEST_WINDOWS_EXPLORER_EXCEPTION)
  {
    {
      WindowsExplorerDeadline deadline(2, 0);
      Require(!deadline.Current());
    }
    {
      WindowsExplorerDeadline deadline(2, 1);
      Require(deadline.Current());
      cancellation_epoch.store(3);
      Require(!deadline.Current());
    }
    Require(FAILED(CoDisableCallCancellation(nullptr)), "deadline_cancellation_pairing");
    {
      WindowsExplorerDeadline deadline(3, 1);
      Sleep(850);
      Require(!deadline.Current());
    }
    windows_explorer_fault_for_test = WindowsExplorerFault::kWatcherThread;
    {
      WindowsExplorerDeadline deadline(3, 1);
      Require(!deadline.Current(), "watcher_failure_disabled");
    }
    windows_explorer_fault_for_test = WindowsExplorerFault::kNone;
    Require(FAILED(CoDisableCallCancellation(nullptr)), "watcher_failure_pairing");
  }
#endif
  CoUninitialize();
  std::cout << "OK Explorer transport\n";
  return 0;
}
