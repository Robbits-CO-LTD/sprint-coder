#pragma once

// #785 T15-4w: the Windows native read of ONE node's value, for `copy` (design
// tasks/designs/t13-readback-design.md section 4.1). Portable: no platform header, no clock, no I/O.
// Every platform call goes through the shadow's `ShadowUiaSource`, so MSVC and clang compile the same
// code and the harness runs the whole read against a fake tree.
//
// What it does, in one call (the facts and the value come from the SAME node):
//   1. finds the node the way the semantic actions do (by the target id; two matches are none) and
//      reads its chain and the window around it with the shadow reader, under its gate;
//   2. builds the facts of computer_use_artifact_read_judgement.h from that capture and lets
//      `JudgeArtifactRead` decide. The ROLE is the node's control type name (Text / Edit / Document),
//      never the old `UiaRole` of the V1 tree. The judgement never looks at a subrole: that a
//      password field is refused stands on `facts.secure`, which is the node's password flag (and the
//      effect classifier's secure / credential classes). A node whose properties could not be read
//      completely is `metadata_complete = false`, so a class name that could not be read is a
//      refusal, not a pass;
//   3. only if the judgement allows, reads the value (TextPattern, else ValuePattern; at most
//      `kArtifactReadMaxBytes` bytes, never cut). A node without a value (only a Name) is refused.
// Every way of not reading ends in the same `ok = false`: the caller (and so the planner) learns
// nothing from which condition it was. `verdict` is kept for the harness and never leaves the native.
//
// The surface and origin come from the shadow's own facts, so the reads agree with the shell /
// secure surfaces the interlock refuses (a console or a secure desktop is not read), and a web window
// (Chrome_WidgetWin_*, a Document in a browser) is a browser window for the judgement (R14 / N22b).
// A browser executable is refused by name as well (the table mirrors Main's browser identity table).
//
// Nothing enables it: `artifactReadSupported` stays false in production until T15-E.

#include "computer_use_artifact_read_judgement.h"
#include "computer_use_windows_shadow.h"
#include "computer_use_windows_shadow_reader.h"

#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>

namespace sprint_coder::computer_use {

// The byte bound of one copied value. It is COMPUTER_USE_ARTIFACT_LIMITS.maxBytes of the contracts
// (= COMPUTER_USE_LIMITS.maxTextActionBytes, the input path's own bound); a source contract test
// holds the two together.
inline constexpr std::size_t kArtifactReadMaxBytes = 4096;

namespace artifact_read_detail {

// Windows executable file names of web browsers, compared whole and case-insensitively. The same
// names as BROWSER_EXECUTABLE_NAMES of computer-use-browser-identity.ts (a source contract test holds
// them together).
inline constexpr std::string_view kBrowserExecutables[] = {
    "chrome.exe",   "msedge.exe",  "firefox.exe", "brave.exe",   "arc.exe",
    "opera.exe",    "vivaldi.exe", "chromium.exe", "iexplore.exe", "librewolf.exe",
    "waterfox.exe", "floorp.exe",  "zen.exe",     "whale.exe",   "duckduckgo.exe"};

[[nodiscard]] inline bool IsBrowserExecutable(std::string_view path) {
  const std::size_t slash = path.find_last_of("\\/");
  std::string leaf(slash == std::string_view::npos ? path : path.substr(slash + 1));
  for (char &character : leaf)
    if (character >= 'A' && character <= 'Z') character = static_cast<char>(character - 'A' + 'a');
  for (const std::string_view name : kBrowserExecutables)
    if (leaf == name) return true;
  return false;
}

// The gaps that make the node's facts incomplete. The others (an unknown extension, an action the
// shadow does not know, a native Document's origin) do not bear on a read.
inline constexpr std::uint32_t kIncompleteGaps =
    kShadowGapTargetMissing | kShadowGapOversize | kShadowGapChainTruncated |
    kShadowGapNeighborsIncomplete | kShadowGapLanguage | kShadowGapRoleMissing |
    kShadowGapCanceled | kShadowGapBudget | kShadowGapReadFailed | kShadowGapBusy;

} // namespace artifact_read_detail

struct WindowsArtifactReadFacts {
  ArtifactReadFacts facts;
  // The control type name of the node (Text / Edit / Document ...); empty when there is no node.
  std::string role;
};

// The facts of the judgement for the node of `capture`. `request` carries the language and the
// maximum mode of the session (its kind is not used: the node is classified once as the target of a
// text entry, for its secure / credential / surface classes and the labels around it, and once as the
// target of an activation, for the confirmation vocabulary that makes it high-impact).
[[nodiscard]] inline WindowsArtifactReadFacts BuildWindowsArtifactReadFacts(
    const ShadowUiaCapture &capture, const ShadowRequestInfo &request) {
  WindowsArtifactReadFacts result;
  ArtifactReadFacts &facts = result.facts;
  facts.platform = ArtifactReadPlatform::kWindows;
  if (!capture.target_found || capture.chain.empty()) return result; // nothing known: all refused
  const ShadowUiaNode &node = capture.chain.front();
  result.role = node.control_type;

  ShadowRequestInfo typing = request;
  typing.kind = "type";
  // The read is judged as if the session may act: the observe-only mode of a session must not turn
  // every class into "blocked for the mode" and hide what the node itself is.
  typing.maximum_mode = "full_access_app";
  ShadowRequestInfo activating = typing;
  activating.kind = "invoke";
  const ShadowFacts typed = BuildWindowsShadowFacts(capture, typing);
  const ShadowFacts activated = BuildWindowsShadowFacts(capture, activating);
  const EffectRuleset closed;
  const EffectDecision typed_decision = ClassifyEffect(typed.facts, closed);
  const EffectDecision activated_decision = ClassifyEffect(activated.facts, closed);

  const auto secure_class = [](EffectClass effect_class) {
    return effect_class == EffectClass::kSecure || effect_class == EffectClass::kCredential;
  };
  facts.secure = node.is_password || secure_class(typed_decision.effect_class) ||
                 secure_class(activated_decision.effect_class);
  facts.high_impact = typed_decision.effect_class == EffectClass::kConfirm ||
                      activated_decision.effect_class == EffectClass::kConfirm;
  facts.surface = typed.facts.surface;
  // A command-surface word in the chain (a terminal, a console) makes the surface not ordinary even
  // when the window itself looks ordinary: the effect classifier's surface class.
  if (typed_decision.effect_class == EffectClass::kSurface ||
      activated_decision.effect_class == EffectClass::kSurface) {
    if (facts.surface == SurfaceKind::kOrdinary) facts.surface = SurfaceKind::kShellLike;
  }
  facts.origin = typed.facts.origin;
  // The node's own properties (control type, class name = the subrole, name, id, password flag) were
  // all read, and so were the chain, the neighbours and the labels the classifier judges.
  facts.metadata_complete =
      !node.read_failed && !node.oversize && capture.chain_reached_root &&
      (typed.gaps & artifact_read_detail::kIncompleteGaps) == 0 &&
      (activated.gaps & artifact_read_detail::kIncompleteGaps) == 0 &&
      typed_decision.effect_class != EffectClass::kUnclassified &&
      activated_decision.effect_class != EffectClass::kUnclassified;
  facts.browser_identity_checked = capture.process_path_read;
  facts.browser_identity_match =
      capture.process_path_read && artifact_read_detail::IsBrowserExecutable(capture.process_path);
  return result;
}

// Overwrites a string that held a value before it is dropped (best effort: the compiler is not allowed
// to remove a write through a volatile pointer). The buffers inside the platform (a BSTR, the UTF-16
// text) are outside this and are only released.
inline void ScrubArtifactText(std::string *text) {
  volatile char *bytes = text->data();
  for (std::size_t index = 0; index < text->size(); ++index) bytes[index] = '\0';
  text->clear();
}

struct WindowsArtifactReadResult {
  bool ok = false;
  // The value; set only when `ok`. UTF-8, 1 to kArtifactReadMaxBytes bytes.
  std::string text;
  // Why a read was refused, for the harness. Never on the wire.
  ArtifactReadVerdict verdict;
  // The read did not get as far as a judgement or a value: canceled, out of budget, or a failed read.
  bool incomplete = false;
  // The node the read found is not the one the observation recorded (its control signature differs,
  // or it has none): the app rebuilt the control, or two controls carry the same id.
  bool signature_mismatch = false;
};

// The read. `target_id` is the id the semantic actions use, and `expected_signature` is the control
// signature the observation recorded for it. The node this read finds (and reads the value of) must
// carry exactly that signature, whatever a search for the id found before: an element rebuilt with
// the same id has another runtime id and is refused. The source must not have been used before.
[[nodiscard]] inline WindowsArtifactReadResult ReadWindowsArtifactValue(
    ShadowUiaSource &source, std::string_view target_id, const ShadowRequestInfo &request,
    std::string_view expected_signature) {
  WindowsArtifactReadResult result;
  WindowsShadowReader reader(source);
  const ShadowUiaCapture capture = reader.Capture("copy", target_id);
  if (reader.Canceled() || !source.ActionStillValid() || capture.budget_exhausted) {
    result.incomplete = true;
    return result;
  }
  // The element found now is the one that was observed. Without a signature to compare, nothing is read.
  std::string found_signature;
  if (expected_signature.empty() || capture.target_found == false ||
      reader.ReadTargetSignature(&found_signature) != ShadowReadResult::kOk ||
      found_signature != expected_signature) {
    result.signature_mismatch = true;
    return result;
  }
  const WindowsArtifactReadFacts built = BuildWindowsArtifactReadFacts(capture, request);
  result.verdict = JudgeArtifactRead(built.facts, built.role);
  if (!result.verdict.MayRead()) return result;
  std::string text;
  const ShadowReadResult read = reader.ReadTargetValue(kArtifactReadMaxBytes, &text);
  // A cancel or a deadline during the value read: no value, whatever it returned. A call that ends
  // past the deadline marks the budget spent without canceling, so the budget is asked too.
  if (reader.Canceled() || !source.ActionStillValid() || reader.Gate().BudgetExhausted() ||
      reader.Gate().Stopped()) {
    ScrubArtifactText(&text);
    result.incomplete = true;
    return result;
  }
  if (read != ShadowReadResult::kOk) {
    ScrubArtifactText(&text);
    result.incomplete = read != ShadowReadResult::kAbsent;
    return result;
  }
  result.ok = true;
  result.text = std::move(text);
  return result;
}

} // namespace sprint_coder::computer_use
