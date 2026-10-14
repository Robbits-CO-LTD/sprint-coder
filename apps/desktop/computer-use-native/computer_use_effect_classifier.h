#pragma once

// Pure, portable (C++20) effect classifier core for Computer Use (ADR v2 section 3.5 to 3.7, D13).
// It turns freshly measured, already normalized facts about the target of one action into a fixed
// decision: ordinary, a single-use approval for a named effect, a refusal, or a takeover by a
// person. It has no platform header, N-API, clock, random source or I/O, and must stay compilable
// by MSVC (/W4 /sdl) and clang without platform headers, so macOS and Windows share one table.
//
// Scope of this file (classifier v2, change C1):
//   * Nothing in the native calls it yet. The attested classifier version, the preflight receipt
//     and `kNativePreflightClassifierVersion` are all still 1; the versions below are the
//     candidates a later, separate change attests. Only tests call this code.
//   * The facts are a model. Producing them from AX / UIA is per OS (and needs a real device to
//     validate); text is expected already NFKC-normalized by the caller. This file lowercases
//     ASCII and compares; it never consults the process or any input but its facts.
//
// Fail-closed rules:
//   * Only `ActionKind::kObserve` is exempt. Any other action with incomplete facts (target
//     metadata, the ancestor walk, the window surface) is a takeover, never ordinary.
//   * A refusal class always wins over an approval class, in this order: secure, credential,
//     command surface, executable / installer triggers. An approval is only ever produced for a
//     complete fact set, never together with a refusal, and always carries a valid effect.
//   * An approval whose effect the rule set has not enabled is a refusal, not an approval.

#include "computer_use_native_approval_ticket.h"

#include <array>
#include <cstddef>
#include <cstdint>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace sprint_coder::computer_use {

// Candidate versions. They are NOT attested anywhere yet; the change that turns the classifier on
// raises the attested versions (eligibility.json) to these numbers.
constexpr std::uint32_t kEffectClassifierVersion = 2;
constexpr std::uint32_t kEffectRulesetVersion = 2;
constexpr std::uint32_t kEffectLexiconVersion = 2;

enum class ActionKind : std::uint8_t {
  kObserve,
  kClick,
  kDoubleClick,
  kInvoke,
  kSetText,
  kType,
  kKey,
  kScroll,
  kSelect,
  kToggle,
  kExpandCollapse,
};

enum class SessionMode : std::uint8_t { kObserveOnly, kSupervised, kFullAccess };

enum class SurfaceKind : std::uint8_t {
  kUnknown,
  kOrdinary,
  kFileBrowser,
  kDownloadPanel,
  kShellLike,
  kScriptInput,
  kCommandPalette,
  kDevToolsConsole,
};

// What a browser's origin looked like at this observation (ADR 3.5, D13).
enum class OriginState : std::uint8_t { kNotApplicable, kOrdinary, kUnknown, kSensitive };

struct NodeFacts {
  std::string role;
  std::string subrole;
  // Title, description, help, identifier and placeholder, joined; length capped by the caller.
  std::string label;
};

struct EffectFacts {
  // The target leaf's metadata could be read.
  bool metadata_complete = false;
  // The bounded walk reached the window root (a truncated walk proves nothing).
  bool chain_complete = false;
  SurfaceKind surface = SurfaceKind::kUnknown;
  ActionKind action = ActionKind::kObserve;
  SessionMode mode = SessionMode::kObserveOnly;
  OriginState origin = OriginState::kNotApplicable;
  // The key is Enter / Return (an activation), for `ActionKind::kKey`.
  bool key_is_activation = false;
  // The target is a file (not a folder) item of a file browser or a download list.
  bool target_is_file_item = false;
  bool extension_known = false;
  std::string extension;
  // [0] is the target, then its ancestors up to the bounded depth.
  std::vector<NodeFacts> chain;
};

enum class EffectClass : std::uint8_t {
  kOrdinary,
  kE1ExecutableOpen,
  kE2DownloadOpen,
  kE3FileManagerOpen,
  kE4InstallerLaunch,
  kE5ScriptSurface,
  kConfirm,
  kCredential,
  kSurface,
  kSecure,
  kUnclassified,
};

enum class DecisionKind : std::uint8_t { kOrdinary, kApproval, kBlocked, kTakeover };

enum class DecisionReason : std::uint8_t {
  kNone,
  kUnclassified,
  kSecure,
  kCredential,
  kSurface,
  kExecutionTrigger,
  kSensitiveOrigin,
  kObserveOnly,
  kApprovalNotEnabled,
};

struct EffectDecision {
  EffectClass effect_class = EffectClass::kUnclassified;
  DecisionKind kind = DecisionKind::kTakeover;
  DecisionReason reason = DecisionReason::kUnclassified;
  // Valid only for `DecisionKind::kApproval`; `kInvalid` for every other kind.
  NativeApprovalEffect approval_effect = NativeApprovalEffect::kInvalid;
  std::uint32_t classifier_version = kEffectClassifierVersion;
  std::uint32_t ruleset_version = kEffectRulesetVersion;
  std::uint32_t lexicon_version = kEffectLexiconVersion;
};

// Which approvals this rule set trusts. The first release enables only the two whose facts native
// can state without a real-device study of Finder and download UIs (ADR v2, decision 2-A).
struct EffectRuleset {
  bool download_open = false;
  bool file_manager_open = false;
  bool high_impact_confirmation = true;
  bool supervised_action = true;
};

// ----------------------------------------------------------------------------------------------
// Versioned tables. All terms are lowercase ASCII or CJK text. ASCII terms match on word
// boundaries ("pay" does not match "payload"); CJK terms match as substrings.
// ----------------------------------------------------------------------------------------------

// Secure fields (password and PIN entry).
inline constexpr std::array<std::string_view, 9> kSecureTerms = {
    "securetextfield", "axsecuretextfield", "passwordfield", "password", "passcode",
    "pin code",        "パスワード",        "暗証番号",       "パスコード"};

// Card data and other credentials a plain text field can hold.
inline constexpr std::array<std::string_view, 14> kCredentialTerms = {
    "card number",   "cvv",       "cvc",         "security code", "card verification",
    "expiration date", "expiry date", "expiration", "カード番号", "セキュリティコード",
    "有効期限",       "クレジットカード番号", "カード有効期限", "認証コード"};

// Command-running words (a terminal, a console, a script runner).
inline constexpr std::array<std::string_view, 15> kSurfaceTerms = {
    "integrated terminal", "terminal", "console",   "shell", "powershell", "command prompt",
    "cmd.exe",             "xterm",    "run script", "shell script", "script console",
    "ターミナル",          "コンソール", "コマンドプロンプト", "スクリプトを実行"};

// Final confirmations of payment, transfer, purchase, permission grants and destructive steps.
inline constexpr std::array<std::string_view, 27> kConfirmTerms = {
    "pay now",   "pay",         "place order",   "submit order",   "complete order",
    "buy now",   "confirm purchase", "complete purchase", "confirm payment", "wire transfer",
    "send money", "transfer funds", "grant access", "grant permission", "allow access",
    "authorize", "delete and continue", "送金",     "振込",            "決済",
    "購入確定",  "注文を確定",  "アクセスを許可", "権限を付与",     "削除して続行",
    "支払いを確定", "支払う"};

// Words on a control that starts an installer.
inline constexpr std::array<std::string_view, 5> kInstallerTerms = {
    "install", "install application", "installer", "インストール", "インストーラ"};

// Words on a control that opens or runs a file.
inline constexpr std::array<std::string_view, 8> kOpenTerms = {
    "open", "run", "execute", "open with", "開く", "実行", "アプリケーションで開く", "起動"};

inline constexpr std::array<std::span<const std::string_view>, 6> kEffectLexiconTables = {
    std::span<const std::string_view>(kSecureTerms),
    std::span<const std::string_view>(kCredentialTerms),
    std::span<const std::string_view>(kSurfaceTerms),
    std::span<const std::string_view>(kConfirmTerms),
    std::span<const std::string_view>(kInstallerTerms),
    std::span<const std::string_view>(kOpenTerms)};

// Extensions whose opening can run code (E1). Platform-reported case is normalized before lookup.
inline constexpr std::array<std::string_view, 24> kExecutableExtensions = {
    "command", "sh",  "bash", "zsh", "app", "pkg", "dmg", "scpt",
    "scptd",   "applescript", "jar", "bat", "cmd", "com", "exe", "msi",
    "msix",    "ps1", "vbs",  "wsf", "reg", "lnk", "scr", "hta"};

// The subset of E1 that is an installer (E4).
inline constexpr std::array<std::string_view, 4> kInstallerExtensions = {"pkg", "dmg", "msi",
                                                                         "msix"};

inline constexpr std::array<std::span<const std::string_view>, 2> kEffectExtensionTables = {
    std::span<const std::string_view>(kExecutableExtensions),
    std::span<const std::string_view>(kInstallerExtensions)};

constexpr std::uint64_t EffectDigestMix(std::uint64_t hash, std::string_view text) {
  // FNV-1a 64-bit over the bytes, then a separator so adjacent terms cannot merge.
  for (const char character : text) {
    hash ^= static_cast<std::uint8_t>(character);
    hash *= 1099511628211ULL;
  }
  hash ^= 0xffU;
  hash *= 1099511628211ULL;
  return hash;
}

constexpr std::uint64_t ComputeEffectTablesDigest() {
  std::uint64_t hash = 14695981039346656037ULL;
  for (const auto &table : kEffectLexiconTables)
    for (const std::string_view term : table)
      hash = EffectDigestMix(hash, term);
  hash = EffectDigestMix(hash, "|extensions|");
  for (const auto &table : kEffectExtensionTables)
    for (const std::string_view term : table)
      hash = EffectDigestMix(hash, term);
  return hash;
}

// Any edit to a table changes this; the harness pins the expected value, so a silent edit fails
// until the digest and the lexicon / ruleset versions are updated together.
inline constexpr std::uint64_t kEffectTablesDigest = ComputeEffectTablesDigest();

// ----------------------------------------------------------------------------------------------
// Matching
// ----------------------------------------------------------------------------------------------

namespace effect_detail {

[[nodiscard]] inline std::string LowerAscii(std::string_view text) {
  std::string output(text);
  for (char &character : output)
    if (character >= 'A' && character <= 'Z')
      character = static_cast<char>(character + ('a' - 'A'));
  return output;
}

[[nodiscard]] inline bool IsAsciiWordCharacter(char character) {
  return (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9');
}

[[nodiscard]] inline bool IsAsciiTerm(std::string_view term) {
  for (const char character : term)
    if (static_cast<unsigned char>(character) >= 0x80) return false;
  return true;
}

// ASCII terms must be bounded by non-word characters; anything with a non-ASCII byte is a plain
// substring (CJK has no word separators).
[[nodiscard]] inline bool ContainsTerm(std::string_view haystack, std::string_view term) {
  const bool bounded = IsAsciiTerm(term);
  for (std::size_t position = haystack.find(term); position != std::string_view::npos;
       position = haystack.find(term, position + 1)) {
    if (!bounded) return true;
    const bool before = position == 0 || !IsAsciiWordCharacter(haystack[position - 1]);
    const std::size_t end = position + term.size();
    const bool after = end == haystack.size() || !IsAsciiWordCharacter(haystack[end]);
    if (before && after) return true;
  }
  return false;
}

[[nodiscard]] inline bool ContainsAnyTerm(std::string_view haystack,
                                          std::span<const std::string_view> terms) {
  for (const std::string_view term : terms)
    if (ContainsTerm(haystack, term)) return true;
  return false;
}

[[nodiscard]] inline bool InSet(std::string_view value, std::span<const std::string_view> set) {
  for (const std::string_view entry : set)
    if (entry == value) return true;
  return false;
}

// One lowercase text for a node: role, subrole and label. Lines keep terms from fusing.
[[nodiscard]] inline std::string NodeText(const NodeFacts &node) {
  return LowerAscii(node.role) + "\n" + LowerAscii(node.subrole) + "\n" + LowerAscii(node.label);
}

[[nodiscard]] inline bool ChainContains(const EffectFacts &facts,
                                        std::span<const std::string_view> terms) {
  for (const NodeFacts &node : facts.chain)
    if (ContainsAnyTerm(NodeText(node), terms)) return true;
  return false;
}

[[nodiscard]] inline bool TargetContains(const EffectFacts &facts,
                                         std::span<const std::string_view> terms) {
  return !facts.chain.empty() && ContainsAnyTerm(NodeText(facts.chain.front()), terms);
}

[[nodiscard]] inline bool IsCommandSurface(SurfaceKind surface) {
  return surface == SurfaceKind::kShellLike || surface == SurfaceKind::kScriptInput ||
         surface == SurfaceKind::kCommandPalette || surface == SurfaceKind::kDevToolsConsole;
}

// An action that can open, run or confirm something (as opposed to typing, selecting or reading).
[[nodiscard]] inline bool IsOpeningAction(const EffectFacts &facts) {
  return facts.action == ActionKind::kInvoke || facts.action == ActionKind::kDoubleClick ||
         (facts.action == ActionKind::kKey && facts.key_is_activation);
}

[[nodiscard]] inline bool IsConfirmingAction(const EffectFacts &facts) {
  return facts.action == ActionKind::kClick || IsOpeningAction(facts);
}

[[nodiscard]] inline EffectDecision Make(EffectClass effect_class, DecisionKind kind,
                                         DecisionReason reason,
                                         NativeApprovalEffect approval_effect =
                                             NativeApprovalEffect::kInvalid) {
  EffectDecision decision;
  decision.effect_class = effect_class;
  decision.kind = kind;
  decision.reason = reason;
  decision.approval_effect = approval_effect;
  return decision;
}

[[nodiscard]] inline bool Enabled(const EffectRuleset &ruleset, NativeApprovalEffect effect) {
  switch (effect) {
  case NativeApprovalEffect::kDownloadOpen:
    return ruleset.download_open;
  case NativeApprovalEffect::kFileManagerOpen:
    return ruleset.file_manager_open;
  case NativeApprovalEffect::kHighImpactConfirmation:
    return ruleset.high_impact_confirmation;
  case NativeApprovalEffect::kSupervisedAction:
    return ruleset.supervised_action;
  case NativeApprovalEffect::kInvalid:
  default:
    return false;
  }
}

// An approval, or the refusal that stands in for it while the rule set does not trust it.
[[nodiscard]] inline EffectDecision Approval(EffectClass effect_class, NativeApprovalEffect effect,
                                             const EffectRuleset &ruleset) {
  if (!Enabled(ruleset, effect))
    return Make(effect_class, DecisionKind::kBlocked, DecisionReason::kApprovalNotEnabled);
  return Make(effect_class, DecisionKind::kApproval, DecisionReason::kNone, effect);
}

} // namespace effect_detail

[[nodiscard]] inline EffectDecision ClassifyEffect(const EffectFacts &facts,
                                                   const EffectRuleset &ruleset = EffectRuleset{}) {
  using namespace effect_detail;
  // Reading is never refused here; every other action needs a complete picture.
  if (facts.action == ActionKind::kObserve)
    return Make(EffectClass::kOrdinary, DecisionKind::kOrdinary, DecisionReason::kNone);
  if (!facts.metadata_complete || !facts.chain_complete || facts.chain.empty() ||
      facts.surface == SurfaceKind::kUnknown)
    return Make(EffectClass::kUnclassified, DecisionKind::kTakeover, DecisionReason::kUnclassified);

  if (ChainContains(facts, kSecureTerms))
    return Make(EffectClass::kSecure, DecisionKind::kBlocked, DecisionReason::kSecure);
  if (ChainContains(facts, kCredentialTerms))
    return Make(EffectClass::kCredential, DecisionKind::kBlocked, DecisionReason::kCredential);
  if (IsCommandSurface(facts.surface) || ChainContains(facts, kSurfaceTerms))
    return Make(EffectClass::kSurface, DecisionKind::kBlocked, DecisionReason::kSurface);

  // Executable and installer triggers (E1, E4) are refused for every opening action.
  const std::string extension = LowerAscii(facts.extension);
  if (IsOpeningAction(facts) && facts.target_is_file_item && facts.extension_known &&
      InSet(extension, kExecutableExtensions)) {
    return Make(InSet(extension, kInstallerExtensions) ? EffectClass::kE4InstallerLaunch
                                                       : EffectClass::kE1ExecutableOpen,
                DecisionKind::kBlocked, DecisionReason::kExecutionTrigger);
  }
  if (IsConfirmingAction(facts) && TargetContains(facts, kInstallerTerms))
    return Make(EffectClass::kE4InstallerLaunch, DecisionKind::kBlocked,
                DecisionReason::kExecutionTrigger);

  // A browser that cannot show where it is, or shows a sensitive place, is a person's.
  if (facts.origin == OriginState::kUnknown)
    return Make(EffectClass::kUnclassified, DecisionKind::kTakeover, DecisionReason::kUnclassified);
  if (facts.origin == OriginState::kSensitive)
    return Make(EffectClass::kSurface, DecisionKind::kTakeover, DecisionReason::kSensitiveOrigin);

  // E2 / E3: opening a file from a download list or a file manager. Folders are just browsing.
  const bool download_open =
      facts.surface == SurfaceKind::kDownloadPanel && IsOpeningAction(facts) &&
      (facts.target_is_file_item || TargetContains(facts, kOpenTerms));
  const bool file_manager_open = facts.surface == SurfaceKind::kFileBrowser &&
                                 IsOpeningAction(facts) && facts.target_is_file_item;
  if (download_open || file_manager_open) {
    if (!facts.extension_known)
      return Make(EffectClass::kUnclassified, DecisionKind::kTakeover,
                  DecisionReason::kUnclassified);
    if (facts.mode == SessionMode::kObserveOnly)
      return Make(EffectClass::kOrdinary, DecisionKind::kBlocked, DecisionReason::kObserveOnly);
    return download_open ? Approval(EffectClass::kE2DownloadOpen, NativeApprovalEffect::kDownloadOpen,
                                    ruleset)
                         : Approval(EffectClass::kE3FileManagerOpen,
                                    NativeApprovalEffect::kFileManagerOpen, ruleset);
  }

  if (facts.mode == SessionMode::kObserveOnly)
    return Make(EffectClass::kOrdinary, DecisionKind::kBlocked, DecisionReason::kObserveOnly);

  if (IsConfirmingAction(facts) && TargetContains(facts, kConfirmTerms))
    return Approval(EffectClass::kConfirm, NativeApprovalEffect::kHighImpactConfirmation, ruleset);

  if (facts.mode == SessionMode::kSupervised)
    return Approval(EffectClass::kOrdinary, NativeApprovalEffect::kSupervisedAction, ruleset);
  return Make(EffectClass::kOrdinary, DecisionKind::kOrdinary, DecisionReason::kNone);
}

} // namespace sprint_coder::computer_use
