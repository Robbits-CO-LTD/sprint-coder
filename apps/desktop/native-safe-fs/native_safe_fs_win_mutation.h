#pragma once

#include <node_api.h>

#include <cstdint>
#include <string>

napi_value WindowsMutationOpenSession(napi_env env, napi_callback_info info);
napi_value WindowsMutationInvalidateWorkspace(napi_env env, napi_callback_info info);
napi_value WindowsMutationObserveIntent(napi_env env, napi_callback_info info);
napi_value WindowsMutationPreflightIntentEffect(napi_env env, napi_callback_info info);
napi_value WindowsMutationStageIntentArtifact(napi_env env, napi_callback_info info);
napi_value WindowsMutationApplyIntentEffect(napi_env env, napi_callback_info info);
napi_value WindowsMutationCleanupIntentAuxiliary(napi_env env, napi_callback_info info);
napi_value WindowsMutationCloseSession(napi_env env, napi_callback_info info);
napi_value WindowsMutationObserveDirectory(napi_env env, napi_callback_info info);
napi_value WindowsMutationCreateDirectory(napi_env env, napi_callback_info info);
napi_value WindowsMutationInspectDirectoryOwnership(napi_env env, napi_callback_info info);
napi_value WindowsMutationCleanupDirectoryOwnership(napi_env env, napi_callback_info info);
napi_value WindowsMutationRemoveDirectory(napi_env env, napi_callback_info info);
napi_value WindowsMutationCleanupDirectoryRemoval(napi_env env, napi_callback_info info);
napi_value WindowsMutationProbeCapabilities(napi_env env);

// The identity every Windows NativeSafeFs observation reports for a regular file. It is the
// digest Main's file-revision.ts derives from Node's lstat on Windows (volume serial, file index,
// libuv's attribute-derived mode, link count), so a revision read by Main can be compared with a
// native observation of the same file.
bool WindowsNativeFileIdentityDigest(uint64_t dev, uint64_t ino, uint32_t attributes,
                                     uint32_t links, std::string* output);
