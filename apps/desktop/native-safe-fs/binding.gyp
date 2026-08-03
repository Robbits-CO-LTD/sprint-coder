{
  "variables": {
    "sprint_coder_test_hooks%": 0
  },
  "targets": [
    {
      "target_name": "sprint_coder_native_safe_fs",
      "sources": ["native_safe_fs.cc"],
      "defines": ["NAPI_VERSION=10"],
      "cflags_cc": ["-std=c++20", "-Wall", "-Wextra"],
      "conditions": [
        ["OS=='win'", {
          "sources!": ["native_safe_fs.cc"],
          "sources": ["native_safe_fs_win.cc"],
          "libraries": ["Advapi32.lib"]
        }]
      ],
      "xcode_settings": {
        "CLANG_CXX_LANGUAGE_STANDARD": "c++20",
        "CLANG_CXX_LIBRARY": "libc++",
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES"
      }
    },
    {
      "target_name": "sprint_coder_native_safe_fs_test",
      "type": "none",
      "conditions": [
        ["sprint_coder_test_hooks==1 and OS!='win'", {
          "type": "loadable_module",
          "product_extension": "node",
          "sources": ["native_safe_fs.cc"],
          "defines": ["NAPI_VERSION=10", "SPRINT_CODER_NATIVE_SAFE_FS_TESTING=1"],
          "cflags_cc": ["-std=c++20", "-Wall", "-Wextra"],
          "xcode_settings": {
            "CLANG_CXX_LANGUAGE_STANDARD": "c++20",
            "CLANG_CXX_LIBRARY": "libc++",
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES"
          }
        }]
      ]
    }
  ]
}
