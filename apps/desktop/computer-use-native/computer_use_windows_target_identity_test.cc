#include <windows.h>
#include <cstdint>
#include <iostream>
#include <limits>
#include <string>
#include <string_view>
#include <utility>
#include <vector>
#include "component-identity.inc"
#pragma comment(lib, "advapi32.lib")

bool Check(bool condition, const char* name) {
  if (!condition) std::cerr << "FAIL: " << name << '\n';
  return condition;
}

bool CheckAccessDeniedChild(const wchar_t* path) {
  SECURITY_DESCRIPTOR descriptor{};
  ACL dacl{};
  if (!Check(InitializeSecurityDescriptor(&descriptor, SECURITY_DESCRIPTOR_REVISION) &&
      InitializeAcl(&dacl, sizeof(dacl), ACL_REVISION) &&
      SetSecurityDescriptorDacl(&descriptor, TRUE, &dacl, FALSE), "empty process DACL")) return false;
  SECURITY_ATTRIBUTES attributes{sizeof(SECURITY_ATTRIBUTES), &descriptor, FALSE};
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION child{};
  std::wstring command = L"\"" + std::wstring(path) + L"\" --child";
  if (!Check(CreateProcessW(path, command.data(), &attributes, nullptr, FALSE,
      CREATE_NO_WINDOW | CREATE_SUSPENDED, nullptr, nullptr, &startup, &child),
      "create access-denied child")) return false;
  struct ChildScope {
    PROCESS_INFORMATION child;
    ~ChildScope() {
      if (child.hProcess) {
        TerminateProcess(child.hProcess, 0);
        WaitForSingleObject(child.hProcess, 5000);
        CloseHandle(child.hProcess);
      }
      if (child.hThread) CloseHandle(child.hThread);
    }
  } scope{child};
  std::string start;
  bool passed = Check(ReadProcessStartIdentity(child.hProcess, &start), "restricted child creation time");
  const std::string request = "{\"targets\":[{\"pid\":" + std::to_string(child.dwProcessId) +
      ",\"processStartTime\":\"" + start + "\"}],\"operation\":\"check_target_identity\"}";
  HANDLE probe = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, child.dwProcessId);
  const DWORD error = probe ? ERROR_SUCCESS : GetLastError();
  if (probe) CloseHandle(probe);
  std::string output;
  if (!probe && error == ERROR_ACCESS_DENIED) {
    passed &= Check(CheckWindowsTargetIdentities(request, &output) &&
        output == "{\"results\":[{\"result\":\"unverifiable\",\"reason\":\"access_denied\"}]}",
        "real process access_denied is unverifiable");
  } else {
    std::cout << "SKIP: real process access_denied: OpenProcess did not return ERROR_ACCESS_DENIED"
              << " (error=" << error << "; enabled SeDebugPrivilege may bypass the DACL)\n";
  }
  const bool terminated = TerminateProcess(child.hProcess, 0) &&
      WaitForSingleObject(child.hProcess, 5000) == WAIT_OBJECT_0;
  passed &= Check(terminated, "terminate access-denied child");
  if (terminated) {
    CloseHandle(scope.child.hThread);
    scope.child.hThread = nullptr;
    CloseHandle(scope.child.hProcess);
    scope.child.hProcess = nullptr;
    const bool checked = CheckWindowsTargetIdentities(request, &output);
    passed &= Check(checked && output != "{\"results\":[{\"result\":\"alive\"}]}",
                    "released child is not alive");
    if (checked && output != "{\"results\":[{\"result\":\"terminated\",\"reason\":\"no_process\"}]}" &&
        output != "{\"results\":[{\"result\":\"terminated\",\"reason\":\"start_time_mismatch\"}]}")
      std::cout << "SKIP: released PID reclamation: process object may still be retained or inaccessible\n";
  }
  return passed;
}

int wmain(int argc, wchar_t**) {
  if (argc > 1) { Sleep(30000); return 0; }
  wchar_t path[32768]{};
  if (!GetModuleFileNameW(nullptr, path, 32768)) return 1;
  bool passed = CheckAccessDeniedChild(path);
  std::wstring command = L"\"" + std::wstring(path) + L"\" --child";
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION child{};
  if (!CreateProcessW(path, command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW,
                      nullptr, nullptr, &startup, &child)) return 1;
  CloseHandle(child.hThread);
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
  // Match JSON.stringify({ targets, operation }) from the TS client, including key order.
  passed &= Check(CheckWindowsTargetIdentities("{\"targets\":[" + target +
      "],\"operation\":\"check_target_identity\"}", &output) &&
      output == "{\"results\":[{\"result\":\"alive\"}]}", "targets-first client metadata");
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
