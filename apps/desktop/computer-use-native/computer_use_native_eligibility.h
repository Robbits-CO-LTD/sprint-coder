#pragma once

// Pure, portable (C++20) eligibility declaration compiled into the native (ADR v2 D7). The values
// are constants fixed when the native is built: either from the generated
// computer_use_build_eligibility.h (written by build-computer-use-native.mjs from the single
// eligibility.json and the --eligibility argument) or, when none is present, the legacy v1
// numbers. Nothing here consults the process or its inputs at run time; the native only attests
// what it was compiled as, in its handshake, and Main compares that with its own compiled constant
// and the manifest. It must stay compilable by MSVC (/W4 /sdl) and clang without platform headers.

#if !defined(SPRINT_CODER_ELIGIBILITY_V2) && defined(__has_include)
#if __has_include("computer_use_build_eligibility.h")
#include "computer_use_build_eligibility.h"
#endif
#endif

#if !defined(SPRINT_CODER_ELIGIBILITY_V2)
#define SPRINT_CODER_ELIGIBILITY_V2 0
#endif
#if !defined(SPRINT_CODER_ELIGIBILITY_RULESET_VERSION)
#define SPRINT_CODER_ELIGIBILITY_RULESET_VERSION 1
#endif
#if !defined(SPRINT_CODER_ELIGIBILITY_CLASSIFIER_VERSION)
#define SPRINT_CODER_ELIGIBILITY_CLASSIFIER_VERSION 1
#endif
#if !defined(SPRINT_CODER_ELIGIBILITY_LEXICON_VERSION)
#define SPRINT_CODER_ELIGIBILITY_LEXICON_VERSION 1
#endif
#if !defined(SPRINT_CODER_ELIGIBILITY_TICKET_REQUIRED)
#define SPRINT_CODER_ELIGIBILITY_TICKET_REQUIRED 0
#endif

#include <cstdint>

namespace sprint_coder::computer_use {

static_assert(SPRINT_CODER_ELIGIBILITY_V2 == 0 || SPRINT_CODER_ELIGIBILITY_V2 == 1,
              "The eligibility mode is v1 or v2.");
static_assert(SPRINT_CODER_ELIGIBILITY_TICKET_REQUIRED == 0 ||
                  SPRINT_CODER_ELIGIBILITY_TICKET_REQUIRED == 1,
              "The ticket claim is a boolean.");

// The mode names are the contract's computerUseEligibilityModeSchema values.
constexpr const char *kNativeEligibilityModeName =
    SPRINT_CODER_ELIGIBILITY_V2 == 1 ? "v2-denylist" : "v1-allowlist";
constexpr bool kNativeEligibilityIsV2 = SPRINT_CODER_ELIGIBILITY_V2 == 1;
constexpr std::uint32_t kNativeEligibilityRulesetVersion =
    SPRINT_CODER_ELIGIBILITY_RULESET_VERSION;
constexpr std::uint32_t kNativeEligibilityClassifierVersion =
    SPRINT_CODER_ELIGIBILITY_CLASSIFIER_VERSION;
constexpr std::uint32_t kNativeEligibilityLexiconVersion =
    SPRINT_CODER_ELIGIBILITY_LEXICON_VERSION;
constexpr bool kNativeEligibilityTicketRequired =
    SPRINT_CODER_ELIGIBILITY_TICKET_REQUIRED == 1;

static_assert(kNativeEligibilityRulesetVersion > 0 && kNativeEligibilityRulesetVersion <= 0xffff &&
                  kNativeEligibilityClassifierVersion > 0 &&
                  kNativeEligibilityClassifierVersion <= 0xffff &&
                  kNativeEligibilityLexiconVersion > 0 &&
                  kNativeEligibilityLexiconVersion <= 0xffff,
              "Every version is a positive 16-bit number.");

} // namespace sprint_coder::computer_use
