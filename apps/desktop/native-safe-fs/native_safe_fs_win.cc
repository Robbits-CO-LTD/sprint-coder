#include <node_api.h>

namespace {

napi_value MakeString(napi_env env, const char* value) {
  napi_value result;
  napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &result);
  return result;
}

napi_value Unsupported(napi_env env, napi_callback_info) {
  napi_value error;
  napi_create_error(env, nullptr,
                    MakeString(env, "NativeSafeFs Windows backend is not available"), &error);
  napi_set_named_property(env, error, "code", MakeString(env, "UNSUPPORTED_PLATFORM"));
  napi_throw(env, error);
  return nullptr;
}

napi_value Probe(napi_env env, napi_callback_info) {
  napi_value result;
  napi_create_object(env, &result);
  napi_value available;
  napi_get_boolean(env, false, &available);
  napi_set_named_property(env, result, "available", available);
  napi_value version;
  napi_create_uint32(env, 1, &version);
  napi_set_named_property(env, result, "apiVersion", version);
  napi_set_named_property(env, result, "platform", MakeString(env, "win32"));
  napi_set_named_property(env, result, "unavailableReason",
                          MakeString(env, "Windows backend is not implemented"));
  return result;
}

napi_value Initialize(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"probe", nullptr, Probe, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"openSession", nullptr, Unsupported, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"invalidateWorkspace", nullptr, Unsupported, nullptr, nullptr, nullptr, napi_default,
       nullptr},
      {"closeSession", nullptr, Unsupported, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)
