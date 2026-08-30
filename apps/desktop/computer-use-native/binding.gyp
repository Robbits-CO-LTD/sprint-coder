{
  "targets": [
    {
      "target_name": "sprint_coder_computer_use_native",
      "sources": ["computer_use_macos.mm"],
      "defines": ["NAPI_VERSION=10"],
      "include_dirs": ["."],
      "conditions": [
        ["OS!='mac'", {
          "type": "none"
        }]
      ],
      "libraries": [
        "-framework ApplicationServices",
        "-framework AppKit",
        "-framework CoreGraphics",
        "-framework CoreImage",
        "-framework CoreServices",
        "-framework Foundation",
        "-framework ImageIO",
        "-framework Security",
        "-framework ScreenCaptureKit",
        "-framework UniformTypeIdentifiers"
      ],
      "xcode_settings": {
        "CLANG_CXX_LANGUAGE_STANDARD": "c++20",
        "CLANG_CXX_LIBRARY": "libc++",
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "CLANG_ENABLE_OBJC_ARC": "YES",
        "MACOSX_DEPLOYMENT_TARGET": "12.3",
        "OTHER_CPLUSPLUSFLAGS": [
          "-Wall",
          "-Wextra",
          "-Werror=return-type",
          "-fstack-protector-strong",
          "-D_FORTIFY_SOURCE=2"
        ]
      }
    }
  ]
}
