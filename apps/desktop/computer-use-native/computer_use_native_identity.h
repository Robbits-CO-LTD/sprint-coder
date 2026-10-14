#pragma once

// Pure, portable (C++20) policy for "is the process that is running now the application the
// session was bound to" (ADR v2 D12, section 6.2.1 and S4 contract 3). It has no platform header:
// the native measures the running process and passes the observation in, and this decides. It must
// stay compilable by MSVC (/W4 /sdl) and clang without platform headers.
//
// Fail-closed rules:
//   * anything that could not be measured is a refusal, never a pass;
//   * a signed application is checked against the running process's own code signature (strict
//     validity and a requirement built from the bound signer), not against the file on disk alone, and the
//     running code directory hash must be the one that was validated on disk, so a binary that was
//     replaced after launch is refused;
//   * an application that was bound as unsigned has no signer to compare. When its image carried a
//     code directory at bind time (ad hoc, linker or platform signature), the running process must
//     still be strictly valid and carry that same code directory hash, so the kernel's copy and the
//     disk agree (a replaced binary is refused). A truly unsigned image can only be held to the
//     bytes on disk (a file read, not a read of the mapped image; the residual risk is recorded in
//     the ADR), and it must not have become signed;
//   * the normalized path of the running image must be the bound path.

#include <string>
#include <string_view>

namespace sprint_coder::computer_use {

struct NativeIdentityExpectation {
  bool signed_target = false;
  std::string team_id;
  std::string signing_identifier;
  std::string cd_hash;
  std::string executable_digest;
};

// What the native measured about the process that is running now.
struct NativeRunningObservation {
  // The image path of the running process was read and equals the bound path.
  bool path_measured = false;
  bool path_matches = false;
  // A code object for the running process was obtained and its signature was checked.
  bool dynamic_signature_checked = false;
  bool dynamic_signature_valid = false;
  bool designated_requirement_satisfied = false;
  std::string team_id;
  std::string signing_identifier;
  std::string cd_hash;
  // For a target bound as unsigned: the digest of the file at the running image's path, when read.
  bool image_digest_measured = false;
  std::string image_digest;
};

enum class NativeIdentityVerdict {
  kMatch,
  kUnavailable,
  kPathMismatch,
  kSignatureInvalid,
  kSignerMismatch,
  kCodeDirectoryMismatch,
  kBecameSigned,
  kImageDigestMismatch,
};

// A stable name for a verdict, for diagnostics only (never user-visible text, never a decision).
[[nodiscard]] constexpr std::string_view
NativeIdentityVerdictName(NativeIdentityVerdict verdict) noexcept {
  switch (verdict) {
  case NativeIdentityVerdict::kMatch:
    return "match";
  case NativeIdentityVerdict::kUnavailable:
    return "unavailable";
  case NativeIdentityVerdict::kPathMismatch:
    return "path_mismatch";
  case NativeIdentityVerdict::kSignatureInvalid:
    return "signature_invalid";
  case NativeIdentityVerdict::kSignerMismatch:
    return "signer_mismatch";
  case NativeIdentityVerdict::kCodeDirectoryMismatch:
    return "code_directory_mismatch";
  case NativeIdentityVerdict::kBecameSigned:
    return "became_signed";
  case NativeIdentityVerdict::kImageDigestMismatch:
    return "image_digest_mismatch";
  }
  return "unknown";
}

[[nodiscard]] inline NativeIdentityVerdict
CheckRunningIdentity(const NativeIdentityExpectation &expected,
                     const NativeRunningObservation &observed) {
  if (!observed.path_measured)
    return NativeIdentityVerdict::kUnavailable;
  if (!observed.path_matches)
    return NativeIdentityVerdict::kPathMismatch;
  if (expected.signed_target) {
    if (expected.team_id.empty() || expected.signing_identifier.empty() ||
        expected.cd_hash.empty())
      return NativeIdentityVerdict::kUnavailable;
    if (!observed.dynamic_signature_checked)
      return NativeIdentityVerdict::kUnavailable;
    if (!observed.dynamic_signature_valid ||
        !observed.designated_requirement_satisfied)
      return NativeIdentityVerdict::kSignatureInvalid;
    if (observed.team_id != expected.team_id ||
        observed.signing_identifier != expected.signing_identifier)
      return NativeIdentityVerdict::kSignerMismatch;
    if (observed.cd_hash != expected.cd_hash)
      return NativeIdentityVerdict::kCodeDirectoryMismatch;
    return NativeIdentityVerdict::kMatch;
  }
  if (expected.executable_digest.empty() || !observed.image_digest_measured)
    return NativeIdentityVerdict::kUnavailable;
  // Bound as unsigned: a running image that now carries a valid signature is a different thing.
  if (observed.dynamic_signature_checked && observed.dynamic_signature_valid &&
      !observed.team_id.empty())
    return NativeIdentityVerdict::kBecameSigned;
  // The image had a code directory when it was bound (ad hoc, linker or platform signature): the
  // kernel's copy is compared with the disk by the strict dynamic check, and the hash must be the
  // bound one. A binary swapped in after launch and restored on disk is caught here.
  if (!expected.cd_hash.empty()) {
    if (!observed.dynamic_signature_checked)
      return NativeIdentityVerdict::kUnavailable;
    if (!observed.dynamic_signature_valid)
      return NativeIdentityVerdict::kSignatureInvalid;
    if (observed.cd_hash != expected.cd_hash)
      return NativeIdentityVerdict::kCodeDirectoryMismatch;
  }
  if (observed.image_digest != expected.executable_digest)
    return NativeIdentityVerdict::kImageDigestMismatch;
  return NativeIdentityVerdict::kMatch;
}

[[nodiscard]] constexpr bool
NativeIdentityAllowsInput(NativeIdentityVerdict verdict) noexcept {
  return verdict == NativeIdentityVerdict::kMatch;
}

// An application with no signer to hold it to is never trusted past a person's eyes: it is capped
// at supervised, so every operation needs an approval whatever was asked for.
[[nodiscard]] inline std::string_view
CapModeForSigningState(bool signed_target, std::string_view mode) noexcept {
  if (!signed_target && mode == "full_access_app")
    return "supervised";
  return mode;
}

} // namespace sprint_coder::computer_use
