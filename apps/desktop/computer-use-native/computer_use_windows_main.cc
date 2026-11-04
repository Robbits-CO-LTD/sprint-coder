#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <node_api.h>
#include <cmath>
#include <memory>
#include <string>

namespace {
napi_value Boolean(napi_env env, bool value) {
  napi_value result;
  return napi_get_boolean(env, value, &result) == napi_ok ? result : nullptr;
}

bool ReadPid(napi_env env, napi_value value, DWORD* pid) {
  double number = 0;
  if (napi_get_value_double(env, value, &number) != napi_ok ||
      !std::isfinite(number) || number < 1 || number >= MAXDWORD ||
      std::floor(number) != number) return false;
  *pid = static_cast<DWORD>(number);
  return true;
}

struct HelperPermit {
  DWORD pid;
  HANDLE process;
  bool consumed = false;
  ~HelperPermit() { CloseHandle(process); }
};

napi_value AllowHelperForeground(napi_env env, napi_callback_info info) {
  napi_value args[1];
  size_t count = 1;
  void* data = nullptr;
  if (napi_get_cb_info(env, info, &count, args, nullptr, &data) != napi_ok)
    return Boolean(env, false);
  auto* permit = static_cast<HelperPermit*>(data);
  DWORD requested = 0;
  if (permit == nullptr || permit->consumed) return Boolean(env, false);
  permit->consumed = true;
  if (count != 1 || !ReadPid(env, args[0], &requested) || requested != permit->pid ||
      WaitForSingleObject(permit->process, 0) != WAIT_TIMEOUT)
    return Boolean(env, false);
  return Boolean(env, AllowSetForegroundWindow(permit->pid) != FALSE);
}

// Main binds only its attested, currently connected helper. Retain its process handle so an
// exited helper's PID cannot be recycled into a later grant. Each callback permits one attempt.
napi_value CreateHelperPermit(napi_env env, napi_callback_info info) {
  napi_value args[1];
  size_t count = 1;
  DWORD pid = 0;
  if (napi_get_cb_info(env, info, &count, args, nullptr, nullptr) != napi_ok ||
      count != 1 || !ReadPid(env, args[0], &pid)) return Boolean(env, false);
  HANDLE process = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (process == nullptr) return Boolean(env, false);
  auto permit = std::make_unique<HelperPermit>();
  permit->pid = pid;
  permit->process = process;
  napi_value callback;
  if (napi_create_function(env, "allowHelperForeground", NAPI_AUTO_LENGTH,
      AllowHelperForeground, permit.get(), &callback) != napi_ok) return nullptr;
  if (napi_add_finalizer(env, callback, permit.get(),
      [](napi_env, void* data, void*) { delete static_cast<HelperPermit*>(data); },
      nullptr, nullptr) != napi_ok) return nullptr;
  permit.release();
  return callback;
}

napi_value ReadMainIdentity(napi_env env, napi_callback_info) {
  FILETIME creation{}, exit{}, kernel{}, user{};
  std::wstring path(32768, L'\0');
  DWORD size = static_cast<DWORD>(path.size());
  if (!GetProcessTimes(GetCurrentProcess(), &creation, &exit, &kernel, &user) ||
      !QueryFullProcessImageNameW(GetCurrentProcess(), 0, path.data(), &size))
    return Boolean(env, false);
  ULARGE_INTEGER ticks{};
  ticks.LowPart = creation.dwLowDateTime;
  ticks.HighPart = creation.dwHighDateTime;
  if (ticks.QuadPart == 0 || size == 0) return Boolean(env, false);
  const auto start = std::to_string(ticks.QuadPart);
  napi_value result, pid, time, image;
  if (napi_create_object(env, &result) != napi_ok ||
      napi_create_uint32(env, GetCurrentProcessId(), &pid) != napi_ok ||
      napi_create_string_utf8(env, start.c_str(), start.size(), &time) != napi_ok ||
      napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(path.data()), size, &image) != napi_ok ||
      napi_set_named_property(env, result, "mainPid", pid) != napi_ok ||
      napi_set_named_property(env, result, "mainProcessStartTime", time) != napi_ok ||
      napi_set_named_property(env, result, "imagePath", image) != napi_ok) return nullptr;
  return result;
}

napi_value Init(napi_env env, napi_value exports) {
  const napi_property_descriptor properties[] = {
    {"readMainIdentity", nullptr, ReadMainIdentity, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"createHelperPermit", nullptr, CreateHelperPermit, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  return napi_define_properties(env, exports, 2, properties) == napi_ok ? exports : nullptr;
}
}  // namespace
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
