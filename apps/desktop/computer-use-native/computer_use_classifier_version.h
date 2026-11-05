#pragma once
#include <cstdint>
namespace sprint_coder::computer_use {
#if defined(_WIN32) || defined(SPRINT_CODER_TEST_WINDOWS_CLASSIFIER)
inline constexpr std::uint32_t kPlatformEffectClassifierVersion = 4;
#else
inline constexpr std::uint32_t kPlatformEffectClassifierVersion = 3;
#endif
} // namespace sprint_coder::computer_use
