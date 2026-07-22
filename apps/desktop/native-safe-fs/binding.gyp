{
  "targets": [
    {
      "target_name": "vibe_native_safe_fs",
      "sources": ["native_safe_fs.cc"],
      "defines": ["NAPI_VERSION=10"],
      "cflags_cc": ["-std=c++20", "-Wall", "-Wextra"],
      "conditions": [
        ["OS=='win'", {
          "sources!": ["native_safe_fs.cc"],
          "sources": ["native_safe_fs_win.cc"]
        }]
      ],
      "xcode_settings": {
        "CLANG_CXX_LANGUAGE_STANDARD": "c++20",
        "CLANG_CXX_LIBRARY": "libc++",
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES"
      }
    }
  ]
}
