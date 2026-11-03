// Component seam: exercises the production host functions without foreground or input operations.
#define SPRINT_CODER_SOURCE_COMMIT "ffffffffffffffffffffffffffffffffffffffff"
#define wmain ApprovalHostProductionMain
#include "computer_use_windows_host.cc"
#undef wmain
#include <stdexcept>

int wmain() {
  const auto check = [](bool value, const char *label) {
    if (!value) throw std::runtime_error(label);
  };
  WindowsSession session;
  session.session_id = "approval-host-session";
  session.cancel_epoch = 0;
  session.observation_revision = 1;
  windows_helper_generation = 7;
  cancellation_epoch.store(0);
  const std::string fields = "\"taskId\":\"task-1\",\"turnId\":\"turn-1\","
      "\"requestId\":\"request-1\",\"actionDigest\":\"" + std::string(64, 'a') +
      "\",\"approvalGeneration\":1,\"cancelEpoch\":0,\"observationRevision\":1";
  for (const bool offer : {false, true}) {
    sprint_coder::computer_use::WindowsApprovalReference reference;
    check(ReadWindowsApprovalReference(session, "{\"helperGeneration\":7," + fields + "}",
                                       1, &reference, offer), "matching-generation");
    for (const std::string prefix : {std::string(), std::string("\"helperGeneration\":0,"),
                                    std::string("\"helperGeneration\":8,")})
      check(!ReadWindowsApprovalReference(session, "{" + prefix + fields + "}",
                                         1, &reference, offer), "missing-or-stale-generation");
  }
  Frame request{};
  const std::string key = FrameIdKey(request.header.session_id);
  auto &stored = sessions[key];
  stored.session_id = session.session_id;
  auto &state = ticket_states[key];
  sprint_coder::computer_use::NativeOrdinaryTicketBinding binding;
  binding.session_id = session.session_id;
  binding.request_id = "ordinary-request";
  binding.action_digest = binding.payload_digest = binding.context_digest = std::string(64, 'a');
  binding.ticket_generation = 1;
  state.generation = 1;
  check(state.slot.Issue(std::string(64, 'b'), binding, 1, 100), "ordinary-ticket-seeded");
  // Malformed preflight must burn the previous ordinary ticket before returning its error.
  (void)HandleWindowsPreflight(INVALID_HANDLE_VALUE, request, "{}");
  check(!state.slot.occupied() && state.generation == 2, "preflight-invalidates-ordinary-slot");
  check(!state.slot.Consume(std::string(64, 'b'), binding, 2), "ordinary-ticket-cannot-replay");
  check(!kWindowsApprovalHandlersEnabled, "production-gate-remains-closed");
  std::cout << "Windows approval host seam PASS\n";
  return 0;
}
