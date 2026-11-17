# Build and link

Sprint Coder does not ship the FFI library or its header. Below, `<ffi header>`
stands for the C header and `<ffi library>` for the library file (`.dylib` on
macOS, `.so` on Linux, `.dll` on Windows).

## ABI handshake (do this first)

After `dlopen` / `LoadLibrary`, compare the dylib major to the header you
compiled against before calling anything else:

```c
AdResult rc = ad_init(AD_ABI_VERSION_MAJOR);
if (rc != AD_RESULT_OK) {
    // header and dylib have incompatible major versions
    fprintf(stderr, "ABI mismatch: %s\n", ad_last_error_message());
    return -1;
}
```

Alternatively, read the raw dylib major and compare yourself:

```c
uint32_t dylib_major = ad_abi_version();
if (dylib_major != AD_ABI_VERSION_MAJOR) {
    fprintf(stderr, "ABI major: header=%u dylib=%u\n",
            AD_ABI_VERSION_MAJOR, dylib_major);
    abort();
}
```

`ad_init` returns `AD_RESULT_ERR_INVALID_ARGS` on mismatch, with a diagnostic in
`ad_last_error_message`. Call nothing further.

## Struct size validation

Languages whose struct layout may diverge from C (Python ctypes, Go cgo, JNI,
etc.) must validate every size-pinned struct before passing it to the library.
The FFI exposes three validation layers:

1. **Header macros** (`AD_*_SIZE`) and
2. **Runtime getters** (`ad_*_size()`, returning `size_t` compiled from the Rust
   side, equal to the macro):

   | Struct | Macro | Getter |
   |--------|-------|--------|
   | `AdAction` | `AD_ACTION_SIZE` | `ad_action_size()` |
   | `AdActionResult` | `AD_ACTION_RESULT_SIZE` | `ad_action_result_size()` |
   | `AdActionStep` | `AD_ACTION_STEP_SIZE` | `ad_action_step_size()` |
   | `AdDisplayInfo` | `AD_DISPLAY_INFO_SIZE` | `ad_display_info_size()` |
   | `AdDragParams` | `AD_DRAG_PARAMS_SIZE` | `ad_drag_params_size()` |
   | `AdElementState` | `AD_ELEMENT_STATE_SIZE` | `ad_element_state_size()` |
   | `AdExactRefEntry` | `AD_EXACT_REF_ENTRY_SIZE` | `ad_exact_ref_entry_size()` |
   | `AdExactSurfaceInfo` | `AD_EXACT_SURFACE_INFO_SIZE` | `ad_exact_surface_info_size()` |
   | `AdExactWindowInfo` | `AD_EXACT_WINDOW_INFO_SIZE` | `ad_exact_window_info_size()` |
   | `AdRefEntry` | `AD_REF_ENTRY_SIZE` | `ad_ref_entry_size()` |
   | `AdWaitArgs` | `AD_WAIT_ARGS_SIZE` | `ad_wait_args_size()` |

3. **C11 static asserts** in the header (`#ifndef AGENT_DESKTOP_ABI_ASSERTS`)
   catch mismatches at C compile time.

Compare your binding's `sizeof` equivalent against the getter at load time, before
building or passing any of these structs. Set `AdExactRefEntry.version` to
`AD_EXACT_REF_ENTRY_VERSION`, `.size` to `AD_EXACT_REF_ENTRY_SIZE`, and
`.process_instance` to the generation token the snapshot emitted.

## Minimal C example

```c
#include <stdio.h>
#include "<ffi header>"

int main(void) {
    // 1. ABI handshake
    if (ad_init(AD_ABI_VERSION_MAJOR) != AD_RESULT_OK) {
        fprintf(stderr, "ABI mismatch: %s\n", ad_last_error_message());
        return 1;
    }

    // 2. Create adapter
    AdAdapter *adapter = ad_adapter_create();
    if (!adapter) {
        fprintf(stderr, "adapter_create failed: %s\n", ad_last_error_message());
        return 1;
    }

    // 3. Check permissions
    AdResult rc = ad_check_permissions(adapter);
    if (rc != AD_RESULT_OK) {
        fprintf(stderr, "permission denied: %s\n", ad_last_error_message());
        ad_adapter_destroy(adapter);
        return 1;
    }

    // 4. Snapshot the focused window
    char *json_out = NULL;
    rc = ad_snapshot(adapter,
                     NULL,                       // app (null = focused window)
                     AD_SNAPSHOT_SURFACE_WINDOW, // surface
                     10,                         // max_depth
                     false,                      // interactive_only
                     false,                      // compact
                     &json_out);
    if (rc == AD_RESULT_OK && json_out) {
        printf("%s\n", json_out);
        // parse the JSON to find qualified refs in data.tree
        ad_free_string(json_out);
    } else if (json_out) {
        // command-level error: ok:false envelope, still must free
        fprintf(stderr, "snapshot error: %s\n", json_out);
        ad_free_string(json_out);
    } else {
        // infrastructure error: *out is null
        fprintf(stderr, "snapshot failed: %s\n", ad_last_error_message());
    }

    ad_adapter_destroy(adapter);
    return 0;
}
```

Compile (macOS and Linux):

```sh
clang -I<directory of the ffi header> main.c \
      <ffi library> \
      -Wl,-rpath,"<directory of the ffi library>" \
      -o snapshot_demo
```

The macOS install name of the library sits under `@rpath`, so a linking consumer
needs an rpath to the library's directory or dyld aborts at launch. `dlopen` and
ctypes callers resolve by path and need nothing.

## Observe-act workflow in C

After parsing the snapshot JSON and extracting a qualified ref ID:

```c
AdAction act = {0};              // zero-init before setting any field
act.kind = AD_ACTION_KIND_CLICK;

char *result = NULL;
AdResult rc = ad_execute_by_ref(
    adapter,
    "@s8f3k2p9:e5", // qualified ref from snapshot data.tree
    &act,
    AD_POLICY_KIND_HEADLESS,
    &result
);
if (result) {
    // parse JSON: ok:true on success, ok:false on STALE_REF etc.
    printf("%s\n", result);
    ad_free_string(result);
}
if (rc != AD_RESULT_OK) {
    fprintf(stderr, "execute_by_ref failed (%d): %s\n",
            (int)rc, ad_last_error_message());
}
```

To type text, set the action kind and text field:

```c
AdAction type_act = {0};
type_act.kind = AD_ACTION_KIND_TYPE_TEXT;
type_act.text = "hello";
// TypeText runs headless by default; opt in to focus fallback explicitly:
rc = ad_execute_by_ref(adapter, "@s8f3k2p9:e3", &type_act,
                       AD_POLICY_KIND_FOCUS_FALLBACK, &result);
```

## Minimal Python ctypes example

```python
import ctypes, json
from ctypes import c_int32, c_uint8, c_bool, c_char_p, POINTER, c_void_p

lib = ctypes.CDLL("<path to the ffi library>")

# ABI handshake
lib.ad_init.restype = c_int32
lib.ad_init.argtypes = [ctypes.c_uint32]
AD_ABI_VERSION_MAJOR = 7  # sync with header macro
rc = lib.ad_init(AD_ABI_VERSION_MAJOR)
assert rc == 0, f"ABI mismatch: rc={rc}"

# Adapter lifecycle
lib.ad_adapter_create.restype = c_void_p
lib.ad_adapter_create.argtypes = []
lib.ad_adapter_destroy.restype = None
lib.ad_adapter_destroy.argtypes = [c_void_p]

# Snapshot
lib.ad_snapshot.restype = c_int32
lib.ad_snapshot.argtypes = [c_void_p, c_char_p, c_int32, c_uint8, c_bool, c_bool,
                             POINTER(c_char_p)]
lib.ad_free_string.restype = None
lib.ad_free_string.argtypes = [c_char_p]

lib.ad_last_error_message.restype = c_char_p
lib.ad_last_error_message.argtypes = []

adapter = lib.ad_adapter_create()
assert adapter, "ad_adapter_create() returned null"

out = c_char_p()
rc = lib.ad_snapshot(adapter, None, 0, 10, False, False, ctypes.byref(out))
if out.value:
    envelope = json.loads(out.value)
    lib.ad_free_string(out)
    print("ok:", envelope.get("ok"))
else:
    msg = lib.ad_last_error_message()
    print("error:", msg.decode() if msg else "(no message)")

lib.ad_adapter_destroy(adapter)
```
