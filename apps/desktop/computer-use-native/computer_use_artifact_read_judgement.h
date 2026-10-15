#pragma once

// #785 T15-4p: whether the native may read the value of ONE node for `copy` (design
// tasks/designs/t13-readback-design.md section 4.1 and 7.1). A pure function from the facts the
// native took in the same call and the node's role to "read" or "refuse" with every reason that
// applies. It has no platform header, N-API, clock or I/O, and is used the same way on macOS and on
// Windows (the facts and the role differ, the rules do not). NOTHING calls it yet: the native read,
// the `copy` vocabulary and the handshake attest are later slices (T15-4m / T15-4w); no version moves.
//
// Fail closed, unlike the S4-1-0 interlock map: a missing fact is a refusal here, never "no
// verdict". A read that cannot be proven allowed does not happen. The reasons are a set, not a first
// match, so a harness can tell which condition each refusal stands on.
//
// What may be read (owner decision, section 7.1 item 3): displayed text and ordinary input fields and
// the content of a document, and nothing else.
//   * macOS:   AXStaticText, and AXTextField / AXTextArea that are not secure.
//   * Windows: Text, Edit and Document.
// A table, a cell, a row, a group, a web area or any other role is "not allowed" whatever else is
// true. The role is matched whole after the same normalisation the interlock map uses (lowercased,
// the macOS "ax" prefix dropped), and per platform: Windows "Edit" is not a macOS role and macOS
// "TextArea" is not a Windows control type, so a role string that exists on only one platform cannot
// open the other.
// What is refused whatever the role: a secure node, a high-impact node (the native's lexicon), a
// surface that is not ordinary, an origin that is sensitive or unknown, a browser window (R14 / N22b:
// the browser is refused as a source at first; it is opened after S7 and #777 measured it), and any
// fact that is missing.

#include "computer_use_effect_classifier.h"

#include <cstdint>
#include <string>
#include <string_view>

namespace sprint_coder::computer_use {

enum class ArtifactReadPlatform : std::uint8_t { kMacOs, kWindows };

// Reasons a read is refused. A bit set: a refusal may stand on several at once.
enum class ArtifactReadRefusal : std::uint8_t {
  kFactsMissing = 1U << 0,
  kRoleNotAllowed = 1U << 1,
  kSecure = 1U << 2,
  kHighImpact = 1U << 3,
  kSurfaceNotOrdinary = 1U << 4,
  kOriginSensitiveOrUnknown = 1U << 5,
  kBrowserWindow = 1U << 6,
};

struct ArtifactReadFacts {
  ArtifactReadPlatform platform = ArtifactReadPlatform::kMacOs;
  // The node's metadata (secure, high-impact) could be read in this call. False = unknown.
  bool metadata_complete = false;
  bool secure = false;
  bool high_impact = false;
  // The window's surface; kUnknown is a missing fact.
  SurfaceKind surface = SurfaceKind::kUnknown;
  // The window's origin state. kNotApplicable means the window has no web content.
  OriginState origin = OriginState::kUnknown;
  // Whether the window was checked against the browser identity table (bundle id / AppUserModelID).
  bool browser_identity_checked = false;
  // The identity table named this window's application a browser.
  bool browser_identity_match = false;
};

struct ArtifactReadVerdict {
  std::uint8_t refusals = 0;

  [[nodiscard]] bool MayRead() const { return refusals == 0; }
  [[nodiscard]] bool Has(ArtifactReadRefusal reason) const {
    return (refusals & static_cast<std::uint8_t>(reason)) != 0;
  }
};

namespace artifact_read_detail {

[[nodiscard]] inline std::string NormalizedRole(std::string_view role) {
  std::string name = effect_detail::NormalizeForMatch(role);
  if (name.rfind("ax", 0) == 0) name.erase(0, 2);
  return name;
}

[[nodiscard]] inline bool RoleIsReadable(ArtifactReadPlatform platform, std::string_view role) {
  const std::string name = NormalizedRole(role);
  if (platform == ArtifactReadPlatform::kMacOs)
    return name == "statictext" || name == "textfield" || name == "textarea";
  // Windows control types; the "ax" prefix does not exist there, so a role that still starts with it
  // (and was stripped above) cannot be one of these three: compare the unstripped form.
  const std::string unstripped = effect_detail::NormalizeForMatch(role);
  return unstripped == "text" || unstripped == "edit" || unstripped == "document";
}

} // namespace artifact_read_detail

// The verdict for one node. `role` is the platform's role string of the target node.
[[nodiscard]] inline ArtifactReadVerdict JudgeArtifactRead(const ArtifactReadFacts &facts,
                                                           std::string_view role) {
  using Reason = ArtifactReadRefusal;
  ArtifactReadVerdict verdict;
  const auto add = [&](Reason reason) { verdict.refusals |= static_cast<std::uint8_t>(reason); };
  if (!facts.metadata_complete || facts.surface == SurfaceKind::kUnknown ||
      !facts.browser_identity_checked)
    add(Reason::kFactsMissing);
  if (!artifact_read_detail::RoleIsReadable(facts.platform, role)) add(Reason::kRoleNotAllowed);
  if (facts.secure) add(Reason::kSecure);
  if (facts.high_impact) add(Reason::kHighImpact);
  if (facts.surface != SurfaceKind::kOrdinary) add(Reason::kSurfaceNotOrdinary);
  if (facts.origin == OriginState::kSensitive || facts.origin == OriginState::kUnknown)
    add(Reason::kOriginSensitiveOrUnknown);
  // A window with web content, or one the identity table names a browser, is a browser window.
  if (facts.origin != OriginState::kNotApplicable || facts.browser_identity_match)
    add(Reason::kBrowserWindow);
  return verdict;
}

} // namespace sprint_coder::computer_use
