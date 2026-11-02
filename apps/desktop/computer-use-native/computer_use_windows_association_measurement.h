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
// One association string through the shell's own resolution order, for `verb` when given (the
// same pszExtra for every query, so every answer comes from the same registry layer). "No such
// association" is absent; any other failure is a failed read.
[[nodiscard]] inline bool AssociationString(ASSOCSTR kind, const std::wstring &extension,
                                            const wchar_t *verb,
                                            const WindowsOpenMeasurementLimits &limits,
                                            std::wstring *value, bool *present) {
  if (!limits.MayRead()) return false;
  wchar_t buffer[32768]{};
  DWORD size = static_cast<DWORD>(std::size(buffer));
  const HRESULT result = AssocQueryStringW(ASSOCF_NONE, kind, extension.c_str(), verb, buffer, &size);
  if (!limits.MayRead()) return false;
  if (result == HRESULT_FROM_WIN32(ERROR_NO_ASSOCIATION)) { *present = false; return true; }
  if (result != S_OK || size <= 1 || size > std::size(buffer)) return false;
  value->assign(buffer, size - 1);
  *present = true;
  return value->find(L'\0') == std::wstring::npos;
}
[[nodiscard]] inline bool RequiredAssociationString(ASSOCSTR kind, const std::wstring &extension,
                                                    const wchar_t *verb,
                                                    const WindowsOpenMeasurementLimits &limits,
                                                    std::wstring *value) {
  bool present = false;
  return AssociationString(kind, extension, verb, limits, value, &present) && present && !value->empty();
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

[[nodiscard]] inline std::string HexBytes(const unsigned char *bytes, std::size_t size) {
  constexpr char digits[] = "0123456789abcdef";
  std::string text;
  for (std::size_t index = 0; index < size; ++index) {
    text += digits[bytes[index] >> 4];
    text += digits[bytes[index] & 15];
  }
  return text;
}
// THE resolver of a real file, used for the association and for the E3 selection alike, so both
// compare in one form (see WindowsAssociationFacts). The file itself is opened for its attributes
// only, without following a reparse point; a directory or a reparse point is not a file to open.
[[nodiscard]] inline bool ResolveRealFile(const std::wstring &path, const WindowsOpenMeasurementLimits &limits,
                                          std::wstring *real, std::string *file_id) {
  if (!limits.MayRead() || path.empty() || path.find(L'\0') != std::wstring::npos) return false;
  HANDLE file = CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                            FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (file == INVALID_HANDLE_VALUE) return false;
  struct Close { HANDLE file; ~Close() { CloseHandle(file); } } close{file};
  BY_HANDLE_FILE_INFORMATION info{};
  if (!limits.MayRead() || !GetFileInformationByHandle(file, &info) ||
      (info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT))) return false;
  FILE_ID_INFO id{};
  if (!limits.MayRead() || !GetFileInformationByHandleEx(file, FileIdInfo, &id, sizeof(id))) return false;
  wchar_t resolved[32768]{};
  if (!limits.MayRead()) return false;
  const auto size = GetFinalPathNameByHandleW(file, resolved, static_cast<DWORD>(std::size(resolved)),
                                             FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (!limits.MayRead() || size == 0 || size >= std::size(resolved)) return false;
  real->assign(resolved, size);
  const auto serial = id.VolumeSerialNumber;
  unsigned char serial_bytes[8]{};
  for (int index = 0; index < 8; ++index)
    serial_bytes[index] = static_cast<unsigned char>((serial >> (8 * (7 - index))) & 0xff);
  *file_id = HexBytes(serial_bytes, sizeof(serial_bytes)) + ":" +
             HexBytes(id.FileId.Identifier, sizeof(id.FileId.Identifier));
  return true;
}

[[nodiscard]] inline WindowsAssociationFacts ReadAssociation(const std::wstring &path,
                                                             const WindowsOpenMeasurementLimits &limits) {
  WindowsAssociationFacts facts;
  std::wstring real;
  std::string file_id;
  if (!ResolveRealFile(path, limits, &real, &file_id)) return facts;
  // Windows drops trailing dots and blanks of a name it runs ("setup.exe." runs setup.exe), so the
  // extension is taken after them; it can only become more executable, never less.
  std::wstring name = real;
  while (!name.empty() && (name.back() == L'.' || name.back() == L' ')) name.pop_back();
  const auto dot = name.rfind(L'.'), slash = name.find_last_of(L"\\/");
  if (dot == std::wstring::npos || (slash != std::wstring::npos && dot < slash)) return facts;
  std::wstring extension = name.substr(dot);
  facts.real_path = Utf8(real);
  facts.file_id = file_id;
  facts.real_path_verified = !facts.real_path.empty();
  facts.extension = effect_detail::NormalizeExtension(Utf8(extension));
  if (!effect_detail::IsPlainExtension(facts.extension)) return facts;
  if (!limits.MayRead()) return facts;
  facts.dangerous = AssocIsDangerous(extension.c_str()) != FALSE;
  if (!limits.MayRead()) return facts;
  std::wstring executable, command, prog_id, perceived, user_choice, verb, value, command_key, dde_value;
  bool present = false;
  if (!RequiredAssociationString(ASSOCSTR_PROGID, extension, nullptr, limits, &prog_id) ||
      !RegistryString(HKEY_CLASSES_ROOT, extension, L"PerceivedType", limits, &perceived, &present) ||
      !present) return facts;
  if (!RegistryString(HKEY_CURRENT_USER,
        L"Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\" + extension + L"\\UserChoice",
        L"ProgId", limits, &user_choice, &present)) return facts;
  if (present && user_choice != prog_id) return facts;
  // The default verb the input actually invokes: the ProgID's named default, and only that one.
  if (!RegistryString(HKEY_CLASSES_ROOT, prog_id + L"\\shell", nullptr, limits, &verb, &present) ||
      !present || verb.empty() || verb.find_first_of(L"\\/;,\"") != std::wstring::npos) return facts;
  // Every handler answer for that verb, through the same resolution path.
  bool delegate = false, drop = false, dde_command = false, dde_application = false;
  if (!RequiredAssociationString(ASSOCSTR_EXECUTABLE, extension, verb.c_str(), limits, &executable) ||
      !RequiredAssociationString(ASSOCSTR_COMMAND, extension, verb.c_str(), limits, &command) ||
      !AssociationString(ASSOCSTR_DELEGATEEXECUTE, extension, verb.c_str(), limits, &value, &delegate) ||
      !AssociationString(ASSOCSTR_DROPTARGET, extension, verb.c_str(), limits, &value, &drop) ||
      !AssociationString(ASSOCSTR_DDECOMMAND, extension, verb.c_str(), limits, &value, &dde_command) ||
      !AssociationString(ASSOCSTR_DDEAPPLICATION, extension, verb.c_str(), limits, &dde_value, &dde_application))
    return facts;
  // The same verb's keys under the ProgID: the static command must exist and be the very command
  // the shell resolved; a COM verb handler, a delegate, a drop target or DDE is not a static command.
  const auto key = prog_id + L"\\shell\\" + verb;
  bool command_present = false, delegate_key = false, drop_key = false, explorer_command = false;
  bool ddeexec = false, progid_shellex = false, extension_shellex = false;
  if (!RegistryString(HKEY_CLASSES_ROOT, key + L"\\command", nullptr, limits, &command_key, &command_present) ||
      !RegistryString(HKEY_CLASSES_ROOT, key + L"\\command", L"DelegateExecute", limits, &value, &delegate_key) ||
      !RegistryString(HKEY_CLASSES_ROOT, key, L"ExplorerCommandHandler", limits, &value, &explorer_command) ||
      !RegistryKeyPresent(key + L"\\DropTarget", limits, &drop_key) ||
      !RegistryKeyPresent(key + L"\\ddeexec", limits, &ddeexec) ||
      // A shell extension's context menu handler may supply the default item.
      !RegistryKeyPresent(prog_id + L"\\shellex\\ContextMenuHandlers", limits, &progid_shellex) ||
      !RegistryKeyPresent(extension + L"\\shellex\\ContextMenuHandlers", limits, &extension_shellex))
    return facts;
  facts.delegate_execute = delegate || delegate_key;
  facts.drop_target = drop || drop_key;
  // The shell answers DDEAPPLICATION even without DDE, with the handler's file name stem (measured:
  // "notepad++" for notepad++.exe). Only another name is an explicit DDE application.
  const auto separator = executable.find_last_of(L"\\/");
  const std::wstring leaf = separator == std::wstring::npos ? executable : executable.substr(separator + 1);
  const bool dde_application_explicit = dde_application && dde_value != leaf.substr(0, leaf.rfind(L'.'));
  facts.dde = dde_command || dde_application_explicit || ddeexec;
  facts.explorer_command_handler = explorer_command;
  facts.shell_extension = progid_shellex || extension_shellex;
  facts.command_key_matches = command_present && command_key == command;
  facts.perceived_type = Utf8(perceived); facts.user_choice = Utf8(user_choice);
  facts.prog_id = Utf8(prog_id); facts.verb = Utf8(verb);
  facts.executable = Utf8(executable); facts.command = Utf8(command);
  if (facts.delegate_execute || facts.drop_target || facts.dde || facts.explorer_command_handler ||
      facts.shell_extension || !facts.command_key_matches) return facts;
  facts.signature_valid = VerifiedSigner(executable, limits, &facts.signer_sha256);
  facts.complete = limits.MayRead() && facts.signature_valid;
  return facts;
}

// The ONE process-wide slot of every Windows open measurement (association and E3 selection
// alike, whatever the Result / Read types). While a measurement runs or its abandoned worker is
// still inside an OS call that does not return, every further measurement answers empty
// (takeover). So at most ONE detached worker thread can ever be stuck. Never destroyed: an
// abandoned worker may finish after the process has started to exit.
[[nodiscard]] inline std::atomic<bool> &WindowsOpenMeasurementRunning() {
  static std::atomic<bool> *const running = new std::atomic<bool>(false);
  return *running;
}

} // namespace windows_association_detail

// Runs `read` on its own MTA thread within min(ticket deadline, start + 150 ms), on the single
// slot above. Late answers are private and discarded; process termination remains the Stop
// owner's task. `limits` follows WindowsOpenMeasurementLimits's ownership contract.
template <class Result, class Read>
[[nodiscard]] inline Result RunWindowsOpenMeasurement(WindowsOpenMeasurementLimits limits, Read read) {
  limits.deadline_ns = WindowsOpenMeasurementDeadline(limits.started_ns, limits.deadline_ns);
  if (!limits.MayRead()) return {};
  std::atomic<bool> &running = windows_association_detail::WindowsOpenMeasurementRunning();
  if (running.exchange(true)) return {};
  struct Pending {
    std::mutex mutex;
    std::condition_variable ready;
    std::atomic<bool> abandoned{false};
    bool done = false;
    // A real handle of the worker thread (under `mutex`), closed when the last owner goes. It
    // names that thread even after it ends, so a cancel can never reach a thread that reused its id.
    HANDLE thread = nullptr;
    Result result{};
    Pending() = default;
    Pending(const Pending &) = delete;
    Pending &operator=(const Pending &) = delete;
    ~Pending() { if (thread != nullptr) CloseHandle(thread); }
  };
  auto pending = std::make_shared<Pending>();
  try {
    std::thread([pending, limits, read = std::move(read), &running]() mutable {
      const auto valid = limits.still_valid;
      limits.still_valid = [pending, valid] { return !pending->abandoned.load() && valid(); };
      {
        HANDLE self = nullptr;
        if (DuplicateHandle(GetCurrentProcess(), GetCurrentThread(), GetCurrentProcess(), &self, 0,
                            FALSE, DUPLICATE_SAME_ACCESS)) {
          std::lock_guard lock(pending->mutex);
          pending->thread = self;
        }
      }
      const HRESULT initialized = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
      Result result{};
      if (SUCCEEDED(initialized)) {
        const HRESULT cancellation = CoEnableCallCancellation(nullptr);
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
      running.store(false);
      pending->ready.notify_one();
    }).detach();
  } catch (...) { running.store(false); return {}; }
  std::unique_lock lock(pending->mutex);
  while (!pending->done && limits.MayRead())
    pending->ready.wait_for(lock, std::chrono::milliseconds(1));
  if (pending->done && limits.MayRead()) return std::move(pending->result);
  // Given up, or no longer wanted. A result that is already done is only discarded: nothing is
  // canceled. A worker that is not done is told to stop at its next step, and its blocked COM call
  // and synchronous I/O are canceled -- under the lock while `done` is false, so the worker has not
  // reached its end (it sets `done` under this lock first) and its id and handle are its own.
  pending->abandoned.store(true);
  if (!pending->done && pending->thread != nullptr) {
    CoCancelCall(GetThreadId(pending->thread), 0);
    CancelSynchronousIo(pending->thread);
  }
  return {};
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
