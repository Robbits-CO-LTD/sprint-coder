#pragma once

#include <node_api.h>

napi_value WindowsMutationOpenSession(napi_env env, napi_callback_info info);
napi_value WindowsMutationInvalidateWorkspace(napi_env env, napi_callback_info info);
napi_value WindowsMutationObserveIntent(napi_env env, napi_callback_info info);
napi_value WindowsMutationStageIntentArtifact(napi_env env, napi_callback_info info);
napi_value WindowsMutationApplyIntentEffect(napi_env env, napi_callback_info info);
napi_value WindowsMutationCleanupIntentAuxiliary(napi_env env, napi_callback_info info);
napi_value WindowsMutationCloseSession(napi_env env, napi_callback_info info);
napi_value WindowsMutationProbeCapabilities(napi_env env);
