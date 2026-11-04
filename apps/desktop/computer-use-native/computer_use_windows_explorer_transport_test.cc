#define wmain ProductionHostMain
#include "explorer-host.cc"
#undef wmain
#include <stdexcept>

void Require(bool ok) { if (!ok) throw std::runtime_error("Explorer transport assertion"); }

int wmain() {
  const auto apartment = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  Require(SUCCEEDED(apartment));
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
  const auto exchange = [&](const std::string &metadata, std::uint64_t serial) {
    frame.metadata.assign(metadata.begin(), metadata.end());
    Require(HandlePipeRequest(server.value, BackendProbe{}, frame, &handshaken, serial));
    Frame reply;
    Require(ReadFrame(client.value, &reply));
    Require(reply.header.message_type == static_cast<std::uint16_t>(MessageType::kError));
    Require(reply.header.request_id.bytes == frame.header.request_id.bytes);
    const std::string text(reply.metadata.begin(), reply.metadata.end());
    Require(text.find(sprint_coder::computer_use::kWindowsExplorerException
        ? "explorer_view_unreadable" : "unsupported_operation") != std::string::npos);
    ++frame.header.request_id.bytes[0];
  };
  const std::string prefix = "{\"operation\":\"measure_explorer_view\",\"sessionId\":\"bound\",\"windowId\":\"100\",\"x\":1,\"y\":1,";
  exchange(prefix + "\"cancelEpoch\":0}", 0); // No bound session.
  WindowsSession bound;
  bound.session_id = "bound";
  bound.window = reinterpret_cast<HWND>(100);
  bound.approval_route_v2 = true;
  bound.cancel_epoch = 2;
  sessions.emplace(FrameIdKey(frame.header.session_id), std::move(bound));
  cancellation_epoch.store(2);
  exchange(prefix + "\"cancelEpoch\":1}", 0); // Stale epoch.
  WindowsTargetListControl().stop_serial.store(1);
  exchange(prefix + "\"cancelEpoch\":2}", 0); // Stop after enqueue.
  frame.header.session_id.bytes[0] = 22;
  exchange(prefix + "\"cancelEpoch\":2}", 1); // Different session.
  sessions.clear();
  if constexpr (sprint_coder::computer_use::kWindowsExplorerException) {
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
    {
      WindowsExplorerDeadline deadline(3, 1);
      Sleep(850);
      Require(!deadline.Current());
    }
  }
  CoUninitialize();
  std::cout << "OK Explorer transport\n";
  return 0;
}
