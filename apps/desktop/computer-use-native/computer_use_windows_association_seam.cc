// Windows-only read seam. No file is opened by its association and no UI input is sent.
// Optional live probe: seam.exe selection <x> <y> <real-path> <verified|takeover>
// Association probe: seam.exe association <real-path> <blocked|takeover>
// The parent prepares Explorer's selection (including offscreen items) before each probe.
#include "computer_use_windows_association_measurement.h"
#include "computer_use_windows_uia_source.h"
#include "computer_use_windows_association_fixture.h"
#include <iostream>

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
      ok = ok && Check(JudgeWindowsAssociation(MeasureWindowsAssociation(argv[2], Limits())) == wanted,
                       "live-association-verdict");
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
  }
  CoUninitialize();
  std::cout << (ok ? "OK\n" : "FAILED\n");
  return ok ? 0 : 1;
}
