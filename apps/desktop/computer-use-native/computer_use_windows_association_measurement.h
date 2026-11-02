#pragma once

#include "computer_use_windows_association.h"

#if defined(_WIN32)
#include <windows.h>
#include <objbase.h>
#include <shlwapi.h>
#include <softpub.h>
#include <wintrust.h>
#include <wincrypt.h>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <thread>
#pragma comment(lib, "shlwapi.lib")
#pragma comment(lib, "wintrust.lib")
#pragma comment(lib, "crypt32.lib")
#pragma comment(lib, "advapi32.lib")

namespace sprint_coder::computer_use {
namespace windows_association_detail {

[[nodiscard]] inline std::string Utf8(std::wstring_view value) {
  if (value.empty() || value.size() > 32768) return {};
  const int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
                                      static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  if (size <= 0) return {};
  std::string result(static_cast<std::size_t>(size), '\0');
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()),
                          result.data(), size, nullptr, nullptr) != size) return {};
  return result;
}
struct Key {
  HKEY value = nullptr;
  ~Key() { if (value) RegCloseKey(value); }
};
[[nodiscard]] inline bool RegistryKeyPresent(const std::wstring &path,
                                             const WindowsOpenMeasurementLimits &limits, bool *present) {
  if (!limits.MayRead()) return false;
  Key key;
  const auto result = RegOpenKeyExW(HKEY_CLASSES_ROOT, path.c_str(), 0, KEY_QUERY_VALUE, &key.value);
  if (!limits.MayRead()) return false;
  *present = result == ERROR_SUCCESS;
  return result == ERROR_SUCCESS || result == ERROR_FILE_NOT_FOUND;
}
// Missing is distinct from a failed read, including access denied and wrong registry types.
[[nodiscard]] inline bool RegistryString(HKEY root, const std::wstring &path, const wchar_t *name,
                                         const WindowsOpenMeasurementLimits &limits,
                                         std::wstring *value, bool *present) {
  if (!limits.MayRead()) return false;
  Key key;
  const auto opened = RegOpenKeyExW(root, path.c_str(), 0, KEY_QUERY_VALUE, &key.value);
  if (opened == ERROR_FILE_NOT_FOUND) { *present = false; return limits.MayRead(); }
  if (opened != ERROR_SUCCESS || !limits.MayRead()) return false;
  wchar_t buffer[32768]{};
  DWORD bytes = sizeof(buffer), type = 0;
  const auto read = RegQueryValueExW(key.value, name, nullptr, &type,
                                    reinterpret_cast<BYTE *>(buffer), &bytes);
  if (!limits.MayRead()) return false;
  if (read == ERROR_FILE_NOT_FOUND) { *present = false; return true; }
  if (read != ERROR_SUCCESS || type != REG_SZ || bytes < sizeof(wchar_t) ||
      bytes % sizeof(wchar_t) || buffer[bytes / sizeof(wchar_t) - 1] != 0) return false;
  value->assign(buffer, bytes / sizeof(wchar_t) - 1);
  if (value->find(L'\0') != std::wstring::npos) return false;
  *present = true;
  return true;
}
[[nodiscard]] inline bool AssociationString(ASSOCSTR kind, const std::wstring &extension,
                                            const WindowsOpenMeasurementLimits &limits,
                                            std::wstring *value) {
  if (!limits.MayRead()) return false;
  wchar_t buffer[32768]{};
  DWORD size = static_cast<DWORD>(std::size(buffer));
  if (AssocQueryStringW(ASSOCF_NONE, kind, extension.c_str(), nullptr, buffer, &size) != S_OK ||
      !limits.MayRead() || size <= 1 || size > std::size(buffer)) return false;
  value->assign(buffer, size - 1);
  return value->find(L'\0') == std::wstring::npos;
}
[[nodiscard]] inline bool VerifiedSigner(const std::wstring &path,
                                         const WindowsOpenMeasurementLimits &limits, std::string *digest) {
  if (!limits.MayRead()) return false;
  HANDLE file = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                            FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) return false;
  struct Close { HANDLE file; ~Close() { CloseHandle(file); } } close{file};
  if (!limits.MayRead()) return false;
  WINTRUST_FILE_INFO info{};
  info.cbStruct = sizeof(info); info.pcwszFilePath = path.c_str(); info.hFile = file;
  WINTRUST_DATA trust{};
  trust.cbStruct = sizeof(trust); trust.dwUIChoice = WTD_UI_NONE;
  trust.fdwRevocationChecks = WTD_REVOKE_NONE; trust.dwUnionChoice = WTD_CHOICE_FILE;
  trust.pFile = &info; trust.dwStateAction = WTD_STATEACTION_VERIFY;
  trust.dwProvFlags = WTD_CACHE_ONLY_URL_RETRIEVAL | WTD_SAFER_FLAG;
  GUID policy = WINTRUST_ACTION_GENERIC_VERIFY_V2;
  const LONG status = WinVerifyTrust(nullptr, &policy, &trust);
  // Read the signer from the verified state, never by reopening a mutable path.
  if (status == ERROR_SUCCESS && limits.MayRead()) {
    auto *data = WTHelperProvDataFromStateData(trust.hWVTStateData);
    auto *signer = data ? WTHelperGetProvSignerFromChain(data, 0, FALSE, 0) : nullptr;
    if (signer && signer->csCertChain > 0 && signer->pasCertChain[0].pCert) {
      const auto *cert = signer->pasCertChain[0].pCert;
      *digest = Sha256Hex(std::string_view(reinterpret_cast<const char *>(cert->pbCertEncoded),
                                           cert->cbCertEncoded));
    }
  }
  trust.dwStateAction = WTD_STATEACTION_CLOSE;
  WinVerifyTrust(nullptr, &policy, &trust);
  return limits.MayRead() && !digest->empty();
}

[[nodiscard]] inline WindowsAssociationFacts ReadAssociation(const std::wstring &path,
                                                             const WindowsOpenMeasurementLimits &limits) {
  WindowsAssociationFacts facts;
  if (!limits.MayRead() || path.empty() || path.find(L'\0') != std::wstring::npos) return facts;
  HANDLE file = CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                            FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (file == INVALID_HANDLE_VALUE) return facts;
  struct Close { HANDLE file; ~Close() { CloseHandle(file); } } close{file};
  BY_HANDLE_FILE_INFORMATION info{};
  if (!limits.MayRead() || !GetFileInformationByHandle(file, &info) ||
      (info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT))) return facts;
  wchar_t resolved[32768]{};
  if (!limits.MayRead()) return facts;
  const auto size = GetFinalPathNameByHandleW(file, resolved, static_cast<DWORD>(std::size(resolved)),
                                             FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (!limits.MayRead() || size == 0 || size >= std::size(resolved)) return facts;
  const std::wstring real(resolved, size);
  const auto dot = real.rfind(L'.'), slash = real.find_last_of(L"\\/");
  if (dot == std::wstring::npos || (slash != std::wstring::npos && dot < slash)) return facts;
  std::wstring extension = real.substr(dot);
  facts.real_path = Utf8(real);
  facts.real_path_verified = !facts.real_path.empty();
  facts.extension = effect_detail::NormalizeExtension(Utf8(extension));
  if (!effect_detail::IsPlainExtension(facts.extension)) return facts;
  if (!limits.MayRead()) return facts;
  facts.dangerous = AssocIsDangerous(extension.c_str()) != FALSE;
  if (!limits.MayRead()) return facts;
  std::wstring executable, command, prog_id, perceived, user_choice, verb, value;
  bool present = false;
  if (!AssociationString(ASSOCSTR_EXECUTABLE, extension, limits, &executable) ||
      !AssociationString(ASSOCSTR_COMMAND, extension, limits, &command) ||
      !AssociationString(ASSOCSTR_PROGID, extension, limits, &prog_id) ||
      !RegistryString(HKEY_CLASSES_ROOT, extension, L"PerceivedType", limits, &perceived, &present) ||
      !present) return facts;
  if (!RegistryString(HKEY_CURRENT_USER,
        L"Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\" + extension + L"\\UserChoice",
        L"ProgId", limits, &user_choice, &present)) return facts;
  if (present && user_choice != prog_id) return facts;
  if (!RegistryString(HKEY_CLASSES_ROOT, prog_id + L"\\shell", nullptr, limits, &verb, &present) ||
      !present || verb.empty() || verb.find_first_of(L"\\/;") != std::wstring::npos) return facts;
  const auto key = prog_id + L"\\shell\\" + verb;
  if (!RegistryString(HKEY_CLASSES_ROOT, key + L"\\command", L"DelegateExecute", limits, &value,
                       &facts.delegate_execute) ||
      !RegistryKeyPresent(key + L"\\DropTarget", limits, &facts.drop_target)) return facts;
  facts.perceived_type = Utf8(perceived); facts.user_choice = Utf8(user_choice);
  facts.prog_id = Utf8(prog_id); facts.verb = Utf8(verb);
  facts.executable = Utf8(executable); facts.command = Utf8(command);
  if (facts.delegate_execute || facts.drop_target) return facts;
  facts.signature_valid = VerifiedSigner(executable, limits, &facts.signer_sha256);
  facts.complete = limits.MayRead() && facts.signature_valid;
  return facts;
}

} // namespace windows_association_detail

// One bounded read lane. Late answers are private and discarded; an unresponsive OS call
// occupies its slot until it returns. Process termination remains the Stop owner's task.
template <class Result, class Read>
[[nodiscard]] inline Result RunWindowsOpenMeasurement(WindowsOpenMeasurementLimits limits, Read read) {
  limits.deadline_ns = WindowsOpenMeasurementDeadline(limits.started_ns, limits.deadline_ns);
  if (!limits.MayRead()) return {};
  static auto *running = new std::atomic<bool>(false);
  if (running->exchange(true)) return {};
  struct Pending {
    std::mutex mutex;
    std::condition_variable ready;
    std::atomic<bool> abandoned{false};
    bool done = false;
    DWORD thread_id = 0;
    Result result{};
  };
  auto pending = std::make_shared<Pending>();
  try {
    std::thread([pending, limits, read = std::move(read)]() mutable {
      const auto valid = limits.still_valid;
      limits.still_valid = [pending, valid] { return !pending->abandoned.load() && valid(); };
      const HRESULT initialized = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
      Result result{};
      if (SUCCEEDED(initialized)) {
        const HRESULT cancellation = CoEnableCallCancellation(nullptr);
        {
          std::lock_guard lock(pending->mutex);
          pending->thread_id = GetCurrentThreadId();
        }
        try {
          if (SUCCEEDED(cancellation) && limits.MayRead()) result = read(limits);
        } catch (...) { result = {}; }
        if (SUCCEEDED(cancellation)) CoDisableCallCancellation(nullptr);
        CoUninitialize();
      }
      {
        std::lock_guard lock(pending->mutex);
        if (!pending->abandoned.load()) pending->result = std::move(result);
        pending->done = true;
      }
      running->store(false);
      pending->ready.notify_one();
    }).detach();
  } catch (...) { running->store(false); return {}; }
  std::unique_lock lock(pending->mutex);
  while (!pending->done && limits.MayRead())
    pending->ready.wait_for(lock, std::chrono::milliseconds(1));
  if (!limits.MayRead() || !pending->done) {
    pending->abandoned.store(true);
    const DWORD thread = pending->thread_id;
    lock.unlock();
    if (thread != 0) {
      CoCancelCall(thread, 0);
      HANDLE handle = OpenThread(THREAD_TERMINATE, FALSE, thread);
      if (handle) { CancelSynchronousIo(handle); CloseHandle(handle); }
    }
    return {};
  }
  return std::move(pending->result);
}

[[nodiscard]] inline WindowsAssociationFacts MeasureWindowsAssociation(
    std::wstring path, const WindowsOpenMeasurementLimits &limits) {
  return RunWindowsOpenMeasurement<WindowsAssociationFacts>(limits,
      [path = std::move(path)](const WindowsOpenMeasurementLimits &budget) {
        return windows_association_detail::ReadAssociation(path, budget);
      });
}
} // namespace sprint_coder::computer_use
#endif
