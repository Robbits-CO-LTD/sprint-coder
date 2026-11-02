#include <windows.h>
#include <cstdint>
#include <iostream>
#include <limits>
#include <string>
#include <string_view>
#include <utility>
#include <vector>
#include "component-identity.inc"

bool Check(bool condition, const char* name) {
  if (!condition) std::cerr << "FAIL: " << name << '\n';
  return condition;
}

int wmain(int argc, wchar_t**) {
  if (argc > 1) { Sleep(30000); return 0; }
  wchar_t path[32768]{};
  if (!GetModuleFileNameW(nullptr, path, 32768)) return 1;
  std::wstring command = L"\"" + std::wstring(path) + L"\" --child";
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION child{};
  if (!CreateProcessW(path, command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW,
                      nullptr, nullptr, &startup, &child)) return 1;
  CloseHandle(child.hThread);
  bool passed = true;
  std::string start;
  passed &= Check(ReadProcessStartIdentity(child.hProcess, &start), "child creation time");
  const std::string target = "{\"pid\":" + std::to_string(child.dwProcessId) +
      ",\"processStartTime\":\"" + start + "\"}";
  const auto request = [](const std::string& targets) {
    return "{\"operation\":\"check_target_identity\",\"targets\":[" + targets + "]}";
  };
  std::string output;
  passed &= Check(CheckWindowsTargetIdentities(request(target), &output) &&
      output == "{\"results\":[{\"result\":\"alive\"}]}", "alive");
  DWORD handles_before = 0, handles_after = 0;
  passed &= Check(GetProcessHandleCount(GetCurrentProcess(), &handles_before), "handle count before");
  for (int i = 0; i < 32; ++i)
    passed &= Check(CheckWindowsTargetIdentities(request(target), &output), "repeated check");
  passed &= Check(GetProcessHandleCount(GetCurrentProcess(), &handles_after) &&
      handles_before == handles_after, "process handles closed");
  passed &= Check(CheckWindowsTargetIdentities(request("{\"pid\":" +
      std::to_string(child.dwProcessId) + ",\"processStartTime\":\"1\"}"), &output) &&
      output == "{\"results\":[{\"result\":\"terminated\",\"reason\":\"start_time_mismatch\"}]}",
      "start_time_mismatch");
  passed &= Check(TerminateProcess(child.hProcess, 0) &&
      WaitForSingleObject(child.hProcess, 5000) == WAIT_OBJECT_0, "terminate child");
  passed &= Check(CheckWindowsTargetIdentities(request(target), &output) &&
      output == "{\"results\":[{\"result\":\"terminated\",\"reason\":\"signaled\"}]}", "signaled");
  CloseHandle(child.hProcess);
  // This value cannot identify a process and OpenProcess reports ERROR_INVALID_PARAMETER.
  passed &= Check(CheckWindowsTargetIdentities(request("{\"pid\":4294967295,\"processStartTime\":\"1\"}"), &output) &&
      output == "{\"results\":[{\"result\":\"terminated\",\"reason\":\"no_process\"}]}", "no_process");
  for (const std::string time : {"0", "01", "-1", "1.0", "1e3", " 1", "", "18446744073709551616"}) {
    passed &= Check(!CheckWindowsTargetIdentities(request("{\"pid\":1,\"processStartTime\":\"" + time + "\"}"), &output),
                    "invalid creation time");
  }
  std::string targets;
  for (int i = 0; i < 64; ++i) { if (i) targets += ','; targets += target; }
  passed &= Check(CheckWindowsTargetIdentities(request(targets), &output), "64 targets");
  passed &= Check(!CheckWindowsTargetIdentities(request(targets + ',' + target), &output), "65 targets refused");
  passed &= Check(CheckWindowsTargetIdentities(request(""), &output) && output == "{\"results\":[]}", "empty list");
  passed &= Check(WindowsTargetIdentityError(ERROR_ACCESS_DENIED) == "access_denied" &&
      WindowsTargetIdentityError(ERROR_INVALID_HANDLE) == "win32_error" &&
      WindowsTargetIdentityError(ERROR_INVALID_PARAMETER) == "win32_error", "error classification");
  for (const std::string invalid : {
      "{\"pid\":0,\"processStartTime\":\"1\"}",
      "{\"pid\":4294967296,\"processStartTime\":\"1\"}",
      "{\"pid\":1,\"pid\":2}",
      "{\"pid\":1,\"processStartTime\":\"1\",\"extra\":true}",
      "{\"pid\":1,\"processStartTime\":1}"})
    passed &= Check(!CheckWindowsTargetIdentities(request(invalid), &output), "invalid target refused");
  if (passed) std::cout << "PASS: target identity component\n";
  return passed ? 0 : 1;
}
