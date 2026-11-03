#pragma once
#include "computer_use_windows_approval_wire.h"

// Shared goldens: native producer equality and TypeScript schema acceptance.
inline bool CheckApprovalRoundTripWire() {
  using namespace sprint_coder::computer_use;
  const std::vector<std::pair<ApprovalRoundTripFields, std::string>> fixtures{
    {{{"version", std::uint64_t{1}}, {"roundTripId", std::string("round-trip-1")}, {"sessionId", std::string("session-1")}, {"taskId", std::string("task-1")}, {"turnId", std::string("turn-1")}, {"helperGeneration", std::uint64_t{1}}, {"cancelEpoch", std::uint64_t{0}}, {"kind", std::string("begin")}, {"durationMs", std::uint64_t{60000}}, {"mainPid", std::uint64_t{42}}, {"mainProcessStartTime", std::string("123")}, {"mainImageIdentity", std::string("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")}},
     R"wire({"version":1,"roundTripId":"round-trip-1","sessionId":"session-1","taskId":"task-1","turnId":"turn-1","helperGeneration":1,"cancelEpoch":0,"kind":"begin","durationMs":60000,"mainPid":42,"mainProcessStartTime":"123","mainImageIdentity":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"})wire"},
    {{{"version", std::uint64_t{1}}, {"roundTripId", std::string("round-trip-1")}, {"sessionId", std::string("session-1")}, {"taskId", std::string("task-1")}, {"turnId", std::string("turn-1")}, {"helperGeneration", std::uint64_t{1}}, {"cancelEpoch", std::uint64_t{0}}, {"kind", std::string("end")}, {"reason", std::string("approved")}},
     R"wire({"version":1,"roundTripId":"round-trip-1","sessionId":"session-1","taskId":"task-1","turnId":"turn-1","helperGeneration":1,"cancelEpoch":0,"kind":"end","reason":"approved"})wire"},
    {{{"version", std::uint64_t{1}}, {"roundTripId", std::string("round-trip-1")}, {"sessionId", std::string("session-1")}, {"taskId", std::string("task-1")}, {"turnId", std::string("turn-1")}, {"helperGeneration", std::uint64_t{1}}, {"cancelEpoch", std::uint64_t{0}}, {"kind", std::string("return")}},
     R"wire({"version":1,"roundTripId":"round-trip-1","sessionId":"session-1","taskId":"task-1","turnId":"turn-1","helperGeneration":1,"cancelEpoch":0,"kind":"return"})wire"},
    {{{"version", std::uint64_t{1}}, {"roundTripId", std::string("round-trip-1")}, {"sessionId", std::string("session-1")}, {"taskId", std::string("task-1")}, {"turnId", std::string("turn-1")}, {"helperGeneration", std::uint64_t{1}}, {"cancelEpoch", std::uint64_t{0}}, {"kind", std::string("approve")}, {"approvalGeneration", std::uint64_t{1}}, {"observationRevision", std::uint64_t{2}}},
     R"wire({"version":1,"roundTripId":"round-trip-1","sessionId":"session-1","taskId":"task-1","turnId":"turn-1","helperGeneration":1,"cancelEpoch":0,"kind":"approve","approvalGeneration":1,"observationRevision":2})wire"},
    {{{"version", std::uint64_t{1}}, {"roundTripId", std::string("round-trip-1")}, {"sessionId", std::string("session-1")}, {"taskId", std::string("task-1")}, {"turnId", std::string("turn-1")}, {"helperGeneration", std::uint64_t{1}}, {"cancelEpoch", std::uint64_t{0}}, {"kind", std::string("event")}, {"sequence", std::uint64_t{1}}, {"state", std::string("active")}, {"foreground", std::string("sprint_coder")}, {"failureReason", std::string("none")}, {"failureLatched", false}},
     R"wire({"version":1,"roundTripId":"round-trip-1","sessionId":"session-1","taskId":"task-1","turnId":"turn-1","helperGeneration":1,"cancelEpoch":0,"kind":"event","sequence":1,"state":"active","foreground":"sprint_coder","failureReason":"none","failureLatched":false})wire"},
    {{{"version", std::uint64_t{1}}, {"roundTripId", std::string("round-trip-1")}, {"sessionId", std::string("session-1")}, {"taskId", std::string("task-1")}, {"turnId", std::string("turn-1")}, {"helperGeneration", std::uint64_t{1}}, {"cancelEpoch", std::uint64_t{0}}, {"kind", std::string("event")}, {"sequence", std::uint64_t{2}}, {"state", std::string("failed")}, {"foreground", std::string("other")}, {"failureReason", std::string("third_window")}, {"failureLatched", true}},
     R"wire({"version":1,"roundTripId":"round-trip-1","sessionId":"session-1","taskId":"task-1","turnId":"turn-1","helperGeneration":1,"cancelEpoch":0,"kind":"event","sequence":2,"state":"failed","foreground":"other","failureReason":"third_window","failureLatched":true})wire"},
    {{{"version", std::uint64_t{1}}, {"roundTripId", std::string("round-trip-1")}, {"sessionId", std::string("session-1")}, {"taskId", std::string("task-1")}, {"turnId", std::string("turn-1")}, {"helperGeneration", std::uint64_t{1}}, {"cancelEpoch", std::uint64_t{0}}, {"kind", std::string("begin_result")}, {"accepted", true}, {"failureReason", std::string("none")}, {"failureLatched", false}},
     R"wire({"version":1,"roundTripId":"round-trip-1","sessionId":"session-1","taskId":"task-1","turnId":"turn-1","helperGeneration":1,"cancelEpoch":0,"kind":"begin_result","accepted":true,"failureReason":"none","failureLatched":false})wire"},
    {{{"version", std::uint64_t{1}}, {"roundTripId", std::string("round-trip-1")}, {"sessionId", std::string("session-1")}, {"taskId", std::string("task-1")}, {"turnId", std::string("turn-1")}, {"helperGeneration", std::uint64_t{1}}, {"cancelEpoch", std::uint64_t{0}}, {"kind", std::string("end_result")}, {"accepted", true}, {"failureReason", std::string("none")}, {"failureLatched", false}},
     R"wire({"version":1,"roundTripId":"round-trip-1","sessionId":"session-1","taskId":"task-1","turnId":"turn-1","helperGeneration":1,"cancelEpoch":0,"kind":"end_result","accepted":true,"failureReason":"none","failureLatched":false})wire"}};
  for (const auto &[fields, golden] : fixtures) {
    if (ApprovalRoundTripWire(fields) != golden) return false;
    for (std::size_t i = 0; i < fields.size(); ++i) {
      auto missing = fields;
      missing.erase(missing.begin() + static_cast<std::ptrdiff_t>(i));
      if (!ApprovalRoundTripWire(missing).empty()) return false;
      auto duplicate = fields;
      duplicate.push_back(fields[i]);
      if (!ApprovalRoundTripWire(duplicate).empty()) return false;
    }
    auto unknown = fields;
    unknown.push_back({"unknown", true});
    if (!ApprovalRoundTripWire(unknown).empty()) return false;
  }
  const auto patch = [&](std::size_t index, std::string_view key, ApprovalRoundTripValue value) {
    auto fields = fixtures[index].first;
    for (auto &[name, field] : fields) if (name == key) field = value;
    return ApprovalRoundTripWire(fields);
  };
  for (const auto duration : {0ULL, 60001ULL, 9007199254740992ULL})
    if (!patch(0, "durationMs", std::uint64_t{duration}).empty()) return false;
  for (const auto duration : {1ULL, 59999ULL, 60000ULL})
    if (patch(0, "durationMs", std::uint64_t{duration}).empty()) return false;
  if (!patch(0, "durationMs", std::string("60000")).empty() ||
      !patch(0, "mainProcessStartTime", std::string("18446744073709551616")).empty() ||
      !patch(0, "mainImageIdentity", std::string("unknown")).empty() ||
      !patch(2, "roundTripId", std::string()).empty() ||
      !patch(3, "roundTripId", std::string()).empty() ||
      !patch(4, "foreground", std::string("other")).empty() ||
      !patch(5, "failureLatched", false).empty() ||
      !patch(5, "failureReason", std::string("none")).empty() ||
      !patch(6, "accepted", false).empty()) return false;
  auto rejected = fixtures[6].first;
  for (auto &[key, value] : rejected) {
    if (key == "accepted") value = false;
    if (key == "failureReason") value = std::string("expired");
  }
  if (!ApprovalRoundTripWire(rejected).empty()) return false;
  for (auto &[key, value] : rejected) if (key == "failureLatched") value = true;
  if (ApprovalRoundTripWire(rejected).empty()) return false;
  return !kWindowsBackgroundInputEnabled;
}
