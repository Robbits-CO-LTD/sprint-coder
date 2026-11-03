// Windows-only read seam. No file is opened by its association and no UI input is sent.
// Optional live probe: seam.exe selection <x> <y> <real-path> <verified|takeover>
// Association probe:   seam.exe association <real-path> <blocked|takeover>   (prints the facts)
// Identity probe:      seam.exe identity <path>                              (prints the resolver's answer)
// The parent prepares Explorer's selection (including offscreen items) before each probe.
// The live selection probe is MANUAL evidence: no automated test runs it (it needs a prepared
// Explorer window). The association and identity probes run in
// src/main/computer-use-windows-association-seam.test.ts.
#include "computer_use_windows_association_measurement.h"
#include "computer_use_windows_uia_source.h"
#include "computer_use_windows_association_fixture.h"
#include "computer_use_windows_approval_handlers.h"
#include <iostream>
#include <thread>

using namespace sprint_coder::computer_use;
namespace {
bool Check(bool value, const char *name) {
  if (!value) std::cerr << name << '\n';
  return value;
}
std::uint64_t Now() {
  return static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(
      std::chrono::steady_clock::now().time_since_epoch()).count());
}
WindowsOpenMeasurementLimits Limits() {
  const auto start = Now();
  return {[] { return true; }, Now, start, WindowsOpenMeasurementDeadline(start, UINT64_MAX)};
}
void PrintAssociation(const WindowsAssociationFacts &facts) {
  const auto flag = [](bool value) { return value ? "1" : "0"; };
  std::cout << "real_path_verified=" << flag(facts.real_path_verified) << '\n'
            << "real_path=" << facts.real_path << '\n'
            << "file_id_known=" << flag(!facts.file_id.empty()) << '\n'
            << "extension=" << facts.extension << '\n'
            << "perceived_type=" << facts.perceived_type << '\n'
            << "prog_id=" << facts.prog_id << '\n'
            << "verb=" << facts.verb << '\n'
            << "command_key_matches=" << flag(facts.command_key_matches) << '\n'
            << "delegate_execute=" << flag(facts.delegate_execute) << '\n'
            << "drop_target=" << flag(facts.drop_target) << '\n'
            << "explorer_command_handler=" << flag(facts.explorer_command_handler) << '\n'
            << "dde=" << flag(facts.dde) << '\n'
            << "shell_extension=" << flag(facts.shell_extension) << '\n'
            << "verb_restricted=" << flag(facts.verb_restricted) << '\n'
            << "executable=" << facts.executable << '\n'
            << "signature_valid=" << flag(facts.signature_valid) << '\n'
            << "complete=" << flag(facts.complete) << '\n'
            << "dangerous=" << flag(facts.dangerous) << '\n';
}
bool Identity(const wchar_t *path) {
  std::wstring real;
  std::string file_id;
  if (!windows_association_detail::ResolveRealFile(path, Limits(), &real, &file_id)) return false;
  const auto utf8 = windows_association_detail::Utf8(real);
  std::cout << "real_path=" << utf8 << '\n'
            << "canonical=" << CanonicalWindowsRealPath(utf8) << '\n'
            << "file_id=" << file_id << '\n';
  return !CanonicalWindowsRealPath(utf8).empty() && !file_id.empty();
}
bool LiveSelection(int argc, wchar_t **argv) {
  using namespace windows_uia_source_detail;
  if (argc != 6 || (std::wstring_view(argv[5]) != L"verified" &&
                    std::wstring_view(argv[5]) != L"takeover")) return false;
  const POINT point{std::stoi(argv[2]), std::stoi(argv[3])};
  const HWND top = GetAncestor(WindowFromPoint(point), GA_ROOT);
  ComRef<IUIAutomation> automation;
  if (!CreateBoundedAutomation(150, 150, automation.Receive())) return false;
  ComRef<IUIAutomationElement> target;
  if (FAILED(automation.Get()->ElementFromPoint(point, target.Receive())) || !target.Get()) return false;
  SAFEARRAY *runtime = nullptr;
  if (FAILED(target.Get()->GetRuntimeId(&runtime)) || !runtime) return false;
  LONG lower = 0, upper = -1;
  std::vector<int> id;
  if (SUCCEEDED(SafeArrayGetLBound(runtime, 1, &lower)) &&
      SUCCEEDED(SafeArrayGetUBound(runtime, 1, &upper)) && upper >= lower && upper - lower < 1024) {
    for (LONG index = lower; index <= upper; ++index) {
      int value = 0;
      if (FAILED(SafeArrayGetElement(runtime, &index, &value))) { id.clear(); break; }
      id.push_back(value);
    }
  }
  SafeArrayDestroy(runtime);
  if (id.empty()) return false;
  const auto facts = MeasureWindowsSingleSelection(nullptr, top, point, std::move(id),
      windows_association_detail::Utf8(argv[4]), Limits());
  const auto wanted = std::wstring_view(argv[5]) == L"verified" ? WindowsOpenVerdict::kVerified
                                                             : WindowsOpenVerdict::kTakeover;
  return Check(JudgeWindowsSingleSelection(facts) == wanted, "live-selection-verdict");
}
// #991 N8-2c: the approval measurement's worker is abandoned at its deadline and the caller returns
// (its strings and the request it built are destroyed). The worker then reads the operation it was
// given: it must read its own copy, never a view of the caller's frame.
bool AbandonedApprovalWorkerReadsItsOwnRequest() {
  auto release = std::make_shared<std::atomic<bool>>(false);
  auto finished = std::make_shared<std::atomic<bool>>(false);
  auto observed = std::make_shared<std::string>();
  const std::string expected = "click" + std::string(48, 'k');
  int answer = -1;
  {
    auto caller_kind = std::make_unique<std::string>(expected);
    auto caller_key = std::make_unique<std::string>(std::string(48, 'q'));
    WindowsApprovalOwnedRequest request;
    request.kind = *caller_kind;
    request.key = *caller_key;
    request.maximum_mode = "full_access_app";
    auto lane = Limits();
    lane.deadline_ns = lane.started_ns + kNativeApprovalWaitMaxNs;
    answer = RunWindowsOpenMeasurement<int>(lane, WindowsApprovalMeasurementRead(std::move(request),
        [release, finished, observed](const ShadowRequestInfo &info, const WindowsOpenMeasurementLimits &) {
          while (!release->load()) std::this_thread::sleep_for(std::chrono::milliseconds(1));
          *observed = std::string(info.kind) + "|" + std::string(info.key) + "|" +
                      std::string(info.maximum_mode);
          finished->store(true);
          return 1;
        }));
    // The caller's strings go, and their memory is reused, before the worker reads.
    caller_kind.reset();
    caller_key.reset();
    std::vector<std::string> reuse(64, std::string(53, 'z'));
    release->store(true);
    for (int wait = 0; wait < 2000 && !finished->load(); ++wait)
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  for (int wait = 0; wait < 2000 && windows_association_detail::WindowsOpenMeasurementRunning().load(); ++wait)
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  return Check(answer == 0, "approval-worker-abandoned") &&
         Check(finished->load(), "approval-worker-finished") &&
         Check(*observed == expected + "|" + std::string(48, 'q') + "|full_access_app",
               "approval-worker-reads-its-own-request");
}
}

int wmain(int argc, wchar_t **argv) {
  const auto initialized = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(initialized)) return 1;
  bool ok = CheckWindowsAssociationSelection(Check);
  if (argc > 1) {
    if (argc == 4 && std::wstring_view(argv[1]) == L"association" &&
        (std::wstring_view(argv[3]) == L"blocked" || std::wstring_view(argv[3]) == L"takeover")) {
      const auto wanted = std::wstring_view(argv[3]) == L"blocked" ? WindowsOpenVerdict::kBlocked
                                                                 : WindowsOpenVerdict::kTakeover;
      const auto facts = MeasureWindowsAssociation(argv[2], Limits());
      PrintAssociation(facts);
      ok = ok && Check(JudgeWindowsAssociation(facts) == wanted, "live-association-verdict");
    } else if (argc == 3 && std::wstring_view(argv[1]) == L"identity") {
      ok = ok && Check(Identity(argv[2]), "live-identity");
    } else {
      ok = ok && std::wstring_view(argv[1]) == L"selection" && LiveSelection(argc, argv);
    }
  } else {
    auto expired = Limits();
    expired.deadline_ns = expired.started_ns;
    int calls = 0;
    const auto result = RunWindowsOpenMeasurement<int>(expired,
        [&calls](const WindowsOpenMeasurementLimits &) { ++calls; return 1; });
    ok = ok && Check(result == 0 && calls == 0, "expired-no-os-call");
    // Measurements back to back (association, then the E3 selection, at each boundary): the slot
    // is free once a result is returned, so the next one is never answered empty.
    int back_to_back = 0;
    for (int round = 0; round < 500; ++round)
      back_to_back += RunWindowsOpenMeasurement<int>(Limits(), [](const WindowsOpenMeasurementLimits &) { return 1; });
    ok = ok && Check(back_to_back == 500, "measurement-back-to-back-slot-free");
    auto cancelled = Limits();
    cancelled.still_valid = [] { return false; };
    ok = ok && Check(!MeasureWindowsAssociation(L"C:\\synthetic\\missing.txt", cancelled).complete,
                     "cancelled-association");
    const auto selected = MeasureWindowsSingleSelection(nullptr, nullptr, POINT{}, {}, "", Limits());
    ok = ok && Check(JudgeWindowsSingleSelection(selected) == WindowsOpenVerdict::kTakeover,
                     "selection-missing-view");
    const auto missing = MeasureWindowsAssociation(L"C:\\synthetic\\missing.txt", Limits());
    ok = ok && Check(JudgeWindowsAssociation(missing) == WindowsOpenVerdict::kTakeover,
                     "association-missing-real-path");
    ok = ok && AbandonedApprovalWorkerReadsItsOwnRequest();
  }
  CoUninitialize();
  std::cout << (ok ? "OK\n" : "FAILED\n");
  return ok ? 0 : 1;
}
