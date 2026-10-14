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
//     ASCII, drops invisible code points and compares; it never consults the process or any input
//     but its facts.
//   * This file is UTF-8 with a byte order mark, so MSVC reads it as UTF-8 whatever the code page,
//     and every lexicon term is a u8 literal, so its bytes do not depend on the execution
//     character set. The digest pin below fails the build of any translation unit that still got
//     them wrong.
//
// Fail-closed rules:
//   * Only `ActionKind::kObserve` is exempt. Any other action with incomplete facts (target
//     metadata, the ancestor walk, the window surface, bounded sizes) is a takeover, never
//     ordinary. Any action but a scroll also needs text it can read: no label anywhere, a label in
//     a language the lexicon does not cover, or a script that can imitate Latin letters is a
//     takeover ("the classifier could not be applied", ADR section 4).
//   * A refusal class always wins over an approval class, in this order: secure, credential,
//     command surface, executable / installer triggers. An approval is only ever produced for a
//     complete fact set, never together with a refusal, and always carries a valid effect.
//   * An approval whose effect the rule set has not enabled is a refusal, not an approval.
//   * Anything that might open a file from a file browser or a download list (a visual click, a
//     key, an invoke, a double click) is treated as opening it until a real device shows otherwise
//     (ADR v2 S4 contract 5, decision 2-A). Only a semantic select, a rename or a scroll is
//     browsing.

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

// Bounds the caller must respect; anything larger is a takeover rather than a slow scan.
constexpr std::size_t kEffectMaxChainNodes = 9;
constexpr std::size_t kEffectMaxLabelBytes = 512;
constexpr std::size_t kEffectMaxNeighborLabels = 16;

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
  // Title, description, help, identifier and placeholder, joined; at most kEffectMaxLabelBytes.
  std::string label;
};

struct EffectFacts {
  // The target leaf's metadata could be read.
  bool metadata_complete = false;
  // The bounded walk reached the window root (a truncated walk proves nothing).
  bool chain_complete = false;
  // The labels are in a language the lexicon covers (English or Japanese). The classifier cannot
  // judge text it cannot read, so the default is "no".
  bool text_language_supported = false;
  SurfaceKind surface = SurfaceKind::kUnknown;
  ActionKind action = ActionKind::kObserve;
  SessionMode mode = SessionMode::kObserveOnly;
  OriginState origin = OriginState::kNotApplicable;
  // The key activates the focused control (Enter, Return, Space or a control's own shortcut).
  bool key_is_activation = false;
  // The target (or the item the action would open) is a document or program item rather than a
  // folder that opens by browsing into it. macOS packages (.app and the like) count as items.
  bool target_is_file_item = false;
  // The extension of the item the action would open, when it is known.
  bool extension_known = false;
  std::string extension;
  // [0] is the target, then its ancestors up to kEffectMaxChainNodes.
  std::vector<NodeFacts> chain;
  // Labels near the target in the same window (a web form's field caption often sits in a sibling
  // element). At most kEffectMaxNeighborLabels, each at most kEffectMaxLabelBytes.
  std::vector<std::string> neighbor_labels;
  bool neighbor_labels_complete = false;
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
// Versioned tables. All terms are lowercase ASCII or CJK text. Matching depends on the table:
//   bounded:   an ASCII term must sit on word boundaries ("pay" does not match "payload");
//   prefix:    only the start must sit on a boundary ("cvv" matches "cvv2");
//   substring: anywhere ("password" matches "userpassword" and "passwords").
// A non-ASCII term is always a substring (CJK has no word separators).
// ----------------------------------------------------------------------------------------------

// Secure fields (password and PIN entry): substring.
inline constexpr std::u8string_view kSecureTerms[] = {
    u8"securetextfield", u8"axsecuretextfield", u8"passwordfield", u8"password", u8"passcode",
    u8"pin code",        u8"パスワード",        u8"暗証番号",       u8"パスコード"};
// A bare "pin" is too short to match inside words: bounded.
inline constexpr std::u8string_view kSecureBoundedTerms[] = {u8"pin", u8"pin entry"};

// Card data and other credentials a plain text field can hold: substring.
inline constexpr std::u8string_view kCredentialTerms[] = {
    u8"card number",        u8"cardnumber",         u8"cc-number", u8"cc-exp",       u8"card verification",
    u8"security code",      u8"securitycode",       u8"expiration date", u8"expiry date", u8"expiration",
    u8"カード番号",         u8"セキュリティコード", u8"有効期限",  u8"クレジットカード番号",
    u8"カード有効期限",     u8"認証コード",         u8"cardholder", u8"account number", u8"routing number"};
// Short codes: only the start needs a boundary.
inline constexpr std::u8string_view kCredentialPrefixTerms[] = {u8"cvv", u8"cvc", u8"cc-csc"};

// Command-running words (a terminal, a console, a script runner): bounded.
inline constexpr std::u8string_view kSurfaceTerms[] = {
    u8"integrated terminal", u8"terminal", u8"console",   u8"shell", u8"powershell", u8"command prompt",
    u8"cmd.exe",             u8"xterm",    u8"run script", u8"shell script", u8"script console",
    u8"ターミナル",          u8"コンソール", u8"コマンドプロンプト", u8"スクリプトを実行"};

// Final confirmations of payment, transfer, purchase, permission grants and destructive steps:
// bounded.
inline constexpr std::u8string_view kConfirmTerms[] = {
    u8"pay now",       u8"pay",          u8"place order",      u8"submit order",  u8"complete order",
    u8"buy now",       u8"buy",          u8"purchase",         u8"checkout",      u8"subscribe",
    u8"confirm order", u8"order now",    u8"confirm purchase", u8"complete purchase", u8"confirm payment",
    u8"wire transfer", u8"send money",   u8"transfer funds",   u8"grant access",  u8"grant permission",
    u8"allow access",  u8"allow",        u8"authorize",        u8"delete and continue", u8"送金",
    u8"振込",          u8"決済",         u8"購入確定",         u8"購入する",      u8"今すぐ購入",
    u8"注文する",      u8"注文を確定",   u8"お支払い",         u8"支払います",    u8"アクセスを許可",
    u8"権限を付与",    u8"削除して続行", u8"支払いを確定",     u8"支払う",        u8"決済する",
    u8"申し込む",      u8"申込み",       u8"登録する",         u8"契約する",      u8"同意して続行",
    u8"送金する",      u8"振り込む"};

// Words on a control that starts an installer: bounded.
inline constexpr std::u8string_view kInstallerTerms[] = {
    u8"install", u8"install application", u8"installer", u8"インストール", u8"インストーラ"};

// Words on a control that opens or runs a file: bounded.
inline constexpr std::u8string_view kOpenTerms[] = {
    u8"open", u8"run", u8"execute", u8"open with", u8"開く", u8"実行", u8"アプリケーションで開く", u8"起動"};

inline constexpr std::array<std::span<const std::u8string_view>, 8> kEffectLexiconTables = {
    std::span<const std::u8string_view>(kSecureTerms),
    std::span<const std::u8string_view>(kSecureBoundedTerms),
    std::span<const std::u8string_view>(kCredentialTerms),
    std::span<const std::u8string_view>(kCredentialPrefixTerms),
    std::span<const std::u8string_view>(kSurfaceTerms),
    std::span<const std::u8string_view>(kConfirmTerms),
    std::span<const std::u8string_view>(kInstallerTerms),
    std::span<const std::u8string_view>(kOpenTerms)};

// Extensions whose opening can run code (E1). Platform-reported case is normalized before lookup.
inline constexpr std::string_view kExecutableExtensions[] = {
    "command", "sh",   "bash",  "zsh",  "app",  "pkg",  "mpkg", "dmg",  "scpt",
    "scptd",   "applescript", "jar",  "bat",  "cmd",  "com",  "exe",  "msi",
    "msix",    "msixbundle", "appx", "appxbundle", "ps1", "vbs", "vbe", "wsf", "wsh",
    "reg",     "lnk",  "scr",   "hta",  "js",   "jse",  "msc",  "cpl",  "pif",
    "appref-ms", "url", "settingcontent-ms", "py", "pyw", "terminal", "workflow", "action",
    "fileloc", "inetloc"};

// The subset of E1 that is an installer (E4).
inline constexpr std::string_view kInstallerExtensions[] = {
    "pkg", "mpkg", "dmg", "msi", "msix", "msixbundle", "appxbundle"};

inline constexpr std::array<std::span<const std::string_view>, 2> kEffectExtensionTables = {
    std::span<const std::string_view>(kExecutableExtensions),
    std::span<const std::string_view>(kInstallerExtensions)};

// FNV-1a 64-bit over the bytes, then a separator so adjacent terms cannot merge.
template <typename Text>
constexpr std::uint64_t EffectDigestMix(std::uint64_t hash, Text text) {
  for (const auto character : text) {
    hash ^= static_cast<std::uint8_t>(character);
    hash *= 1099511628211ULL;
  }
  hash ^= 0xffU;
  hash *= 1099511628211ULL;
  return hash;
}

constexpr std::uint64_t EffectDigestMixNumber(std::uint64_t hash, std::uint32_t value) {
  for (int shift = 24; shift >= 0; shift -= 8) {
    hash ^= (value >> shift) & 0xffU;
    hash *= 1099511628211ULL;
  }
  return hash;
}

// Covers every term, every extension and the three candidate versions. It does not cover the
// decision rules in ClassifyEffect (their order and conditions); the harness cases, which fail
// when a rule is mutated, pin those.
constexpr std::uint64_t ComputeEffectTablesDigest() {
  std::uint64_t hash = 14695981039346656037ULL;
  for (const auto &table : kEffectLexiconTables)
    for (const std::u8string_view term : table)
      hash = EffectDigestMix(hash, term);
  hash = EffectDigestMix(hash, std::string_view("|extensions|"));
  for (const auto &table : kEffectExtensionTables)
    for (const std::string_view term : table)
      hash = EffectDigestMix(hash, term);
  hash = EffectDigestMix(hash, std::string_view("|versions|"));
  hash = EffectDigestMixNumber(hash, kEffectClassifierVersion);
  hash = EffectDigestMixNumber(hash, kEffectRulesetVersion);
  hash = EffectDigestMixNumber(hash, kEffectLexiconVersion);
  return hash;
}

inline constexpr std::uint64_t kEffectTablesDigest = ComputeEffectTablesDigest();

// The reviewed value. Editing a table or raising a version without updating this pin is a compile
// error in every translation unit that includes the header, and so is reading the CJK terms with a
// wrong character set: the build fails closed instead of matching nothing.
inline constexpr std::uint64_t kEffectTablesDigestPinned = 0x9d3ac3d7ac1f9012ULL;
static_assert(kEffectTablesDigest == kEffectTablesDigestPinned,
              "The effect classifier tables changed: review them, bump the lexicon / ruleset "
              "version, and update kEffectTablesDigestPinned.");

// ----------------------------------------------------------------------------------------------
// Matching
// ----------------------------------------------------------------------------------------------

namespace effect_detail {

enum class MatchMode : std::uint8_t { kBounded, kPrefix, kSubstring };

[[nodiscard]] inline bool IsAsciiWordCharacter(char character) {
  return (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9');
}

[[nodiscard]] inline bool IsAsciiTerm(std::string_view term) {
  for (const char character : term)
    if (static_cast<unsigned char>(character) >= 0x80) return false;
  return true;
}

// Decodes one UTF-8 code point at `index`. False for anything malformed (overlong forms, surrogates,
// values above U+10FFFF, truncated sequences).
[[nodiscard]] inline bool DecodeUtf8(std::string_view text, std::size_t index, char32_t *code,
                                     std::size_t *length) {
  const auto byte = [&](std::size_t offset) -> unsigned {
    return index + offset < text.size() ? static_cast<unsigned char>(text[index + offset]) : 0x100U;
  };
  const unsigned lead = byte(0);
  const auto continuation = [&](std::size_t offset) {
    const unsigned value = byte(offset);
    return value >= 0x80 && value <= 0xBF;
  };
  if (lead < 0x80) {
    *code = lead;
    *length = 1;
    return true;
  }
  if (lead >= 0xC2 && lead <= 0xDF && continuation(1)) {
    *code = static_cast<char32_t>(((lead & 0x1FU) << 6) | (byte(1) & 0x3FU));
    *length = 2;
    return true;
  }
  if (lead >= 0xE0 && lead <= 0xEF && continuation(1) && continuation(2)) {
    const char32_t value = static_cast<char32_t>(((lead & 0x0FU) << 12) | ((byte(1) & 0x3FU) << 6) |
                                                 (byte(2) & 0x3FU));
    if (value < 0x800 || (value >= 0xD800 && value <= 0xDFFF)) return false;
    *code = value;
    *length = 3;
    return true;
  }
  if (lead >= 0xF0 && lead <= 0xF4 && continuation(1) && continuation(2) && continuation(3)) {
    const char32_t value = static_cast<char32_t>(((lead & 0x07U) << 18) | ((byte(1) & 0x3FU) << 12) |
                                                 ((byte(2) & 0x3FU) << 6) | (byte(3) & 0x3FU));
    if (value < 0x10000 || value > 0x10FFFF) return false;
    *code = value;
    *length = 4;
    return true;
  }
  return false;
}

// The Default_Ignorable_Code_Point set (invisible, joining or glyph-varying code points): soft
// hyphen, combining grapheme joiner, Arabic letter mark, Hangul fillers, Khmer inherent vowels,
// Mongolian free variation selectors, the zero-width and directional controls up to the invisible
// operators and isolates, the Hangul and halfwidth Hangul fillers, variation selectors, BOM, the
// shorthand and musical format controls and the tag characters.
[[nodiscard]] constexpr bool IsDefaultIgnorable(char32_t code) {
  return code == 0x00AD || code == 0x034F || code == 0x061C || code == 0x115F || code == 0x1160 ||
         code == 0x17B4 || code == 0x17B5 || (code >= 0x180B && code <= 0x180F) ||
         (code >= 0x200B && code <= 0x200F) || (code >= 0x202A && code <= 0x202E) ||
         (code >= 0x2060 && code <= 0x206F) || code == 0x3164 || (code >= 0xFE00 && code <= 0xFE0F) ||
         code == 0xFEFF || code == 0xFFA0 || (code >= 0xFFF0 && code <= 0xFFF8) ||
         (code >= 0x1BCA0 && code <= 0x1BCA3) || (code >= 0x1D173 && code <= 0x1D17A) ||
         (code >= 0xE0000 && code <= 0xE0FFF);
}

// Drops the default-ignorable code points, so a label cannot hide a word behind them, and folds
// ASCII case. Malformed UTF-8 bytes are kept as they are (TextIsClassifiable refuses such text).
[[nodiscard]] inline std::string NormalizeForMatch(std::string_view text) {
  std::string output;
  output.reserve(text.size());
  for (std::size_t index = 0; index < text.size();) {
    char32_t code = 0;
    std::size_t length = 1;
    if (DecodeUtf8(text, index, &code, &length)) {
      if (IsDefaultIgnorable(code)) {
        index += length;
        continue;
      }
      if (length == 1) {
        char character = text[index];
        if (character >= 'A' && character <= 'Z')
          character = static_cast<char>(character + ('a' - 'A'));
        output.push_back(character);
      } else {
        output.append(text.substr(index, length));
      }
      index += length;
    } else {
      output.push_back(text[index]);
      ++index;
    }
  }
  return output;
}

// Non-ASCII code points the lexicon can read: Japanese text (kana, ideographs, CJK punctuation,
// fullwidth punctuation and signs), punctuation, symbols, arrows, currency and emoji. Letters of
// other scripts (accented Latin, IPA, Greek, Cyrillic, Armenian, Hangul, fullwidth Latin) can
// imitate or replace Latin letters, so text carrying them is not classified.
[[nodiscard]] constexpr bool IsReadableNonAscii(char32_t code) {
  if ((code >= 0xFF10 && code <= 0xFF19) || (code >= 0xFF21 && code <= 0xFF3A) ||
      (code >= 0xFF41 && code <= 0xFF5A))
    return false;
  return (code >= 0x00A0 && code <= 0x00BF) || (code >= 0x2000 && code <= 0x206F) ||
         (code >= 0x20A0 && code <= 0x20CF) || (code >= 0x2190 && code <= 0x23FF) ||
         (code >= 0x2500 && code <= 0x27BF) || (code >= 0x2900 && code <= 0x2BFF) ||
         (code >= 0x3000 && code <= 0x30FF) || (code >= 0x31F0 && code <= 0x31FF) ||
         (code >= 0x3400 && code <= 0x4DBF) || (code >= 0x4E00 && code <= 0x9FFF) ||
         (code >= 0xF900 && code <= 0xFAFF) || (code >= 0xFE30 && code <= 0xFE4F) ||
         (code >= 0xFF00 && code <= 0xFFEF) || (code >= 0x1F000 && code <= 0x1FAFF) ||
         (code >= 0x20000 && code <= 0x2FA1F);
}

// True for malformed UTF-8 and for text a lexicon cannot read; the argument is normalized text.
[[nodiscard]] inline bool HasUnreadableCharacters(std::string_view normalized) {
  for (std::size_t index = 0; index < normalized.size();) {
    char32_t code = 0;
    std::size_t length = 1;
    if (!DecodeUtf8(normalized, index, &code, &length)) return true;
    if (code >= 0x80 && !IsReadableNonAscii(code)) return true;
    index += length;
  }
  return false;
}

// An extension as the platform names it: leading and trailing dots and blanks dropped, ASCII
// folded. Windows ignores trailing dots and spaces in a file name, so "setup.exe." still runs.
[[nodiscard]] inline std::string NormalizeExtension(std::string_view extension) {
  std::string text = NormalizeForMatch(extension);
  const auto trim = [](char character) {
    return character == '.' || character == ' ' || character == '\t';
  };
  while (!text.empty() && trim(text.front())) text.erase(text.begin());
  while (!text.empty() && trim(text.back())) text.pop_back();
  return text;
}

// A plain extension: one to 32 of [a-z0-9_+-]. Anything else is treated as unknown.
[[nodiscard]] inline bool IsPlainExtension(std::string_view extension) {
  if (extension.empty() || extension.size() > 32) return false;
  for (const char character : extension)
    if (!((character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') ||
          character == '_' || character == '+' || character == '-'))
      return false;
  return true;
}

[[nodiscard]] inline std::string_view TermBytes(std::u8string_view term) {
  return std::string_view(reinterpret_cast<const char *>(term.data()), term.size());
}

[[nodiscard]] inline bool ContainsTerm(std::string_view haystack, std::u8string_view lexicon_term,
                                       MatchMode mode) {
  const std::string_view term = TermBytes(lexicon_term);
  if (term.empty()) return false;
  const bool plain = mode == MatchMode::kSubstring || !IsAsciiTerm(term);
  for (std::size_t position = haystack.find(term); position != std::string_view::npos;
       position = haystack.find(term, position + 1)) {
    if (plain) return true;
    const bool before = position == 0 || !IsAsciiWordCharacter(haystack[position - 1]);
    const std::size_t end = position + term.size();
    const bool after = mode == MatchMode::kPrefix || end == haystack.size() ||
                       !IsAsciiWordCharacter(haystack[end]);
    if (before && after) return true;
  }
  return false;
}

[[nodiscard]] inline bool ContainsAnyTerm(std::string_view haystack,
                                          std::span<const std::u8string_view> terms,
                                          MatchMode mode) {
  for (const std::u8string_view term : terms)
    if (ContainsTerm(haystack, term, mode)) return true;
  return false;
}

[[nodiscard]] inline bool InSet(std::string_view value, std::span<const std::string_view> set) {
  for (const std::string_view entry : set)
    if (entry == value) return true;
  return false;
}

// One lowercase text for a node: role, subrole and label. Lines keep terms from fusing.
[[nodiscard]] inline std::string NodeText(const NodeFacts &node) {
  return NormalizeForMatch(node.role) + "\n" + NormalizeForMatch(node.subrole) + "\n" +
         NormalizeForMatch(node.label);
}

// Role names of controls that act when activated. The nearest one (or the target) carries the
// meaning of a click that lands on an unlabeled child such as an icon.
[[nodiscard]] inline bool IsActionableRole(std::string_view role_text) {
  static constexpr std::string_view kActionable[] = {
      "button", "link",     "menuitem",   "checkbox",  "radiobutton", "switch",
      "popupbutton", "menubutton", "hyperlink", "listitem", "tabitem", "splitbutton"};
  for (const std::string_view name : kActionable)
    if (role_text.find(name) != std::string_view::npos) return true;
  return false;
}

// How many nodes, from the target up, make the control the action lands on: the target itself, or
// everything up to and including the nearest actionable ancestor.
[[nodiscard]] inline std::size_t ActionableSpan(const EffectFacts &facts) {
  for (std::size_t index = 0; index < facts.chain.size(); ++index) {
    const std::string role = NormalizeForMatch(facts.chain[index].role) + " " +
                             NormalizeForMatch(facts.chain[index].subrole);
    if (IsActionableRole(role)) return index + 1;
  }
  return facts.chain.empty() ? 0 : 1;
}

[[nodiscard]] inline bool ChainContains(const EffectFacts &facts,
                                        std::span<const std::u8string_view> terms, MatchMode mode) {
  for (const NodeFacts &node : facts.chain)
    if (ContainsAnyTerm(NodeText(node), terms, mode)) return true;
  return false;
}

[[nodiscard]] inline bool NeighborsContain(const EffectFacts &facts,
                                           std::span<const std::u8string_view> terms,
                                           MatchMode mode) {
  for (const std::string &label : facts.neighbor_labels)
    if (ContainsAnyTerm(NormalizeForMatch(label), terms, mode)) return true;
  return false;
}

[[nodiscard]] inline bool ActionableContains(const EffectFacts &facts,
                                             std::span<const std::u8string_view> terms) {
  const std::size_t span = ActionableSpan(facts);
  for (std::size_t index = 0; index < span; ++index)
    if (ContainsAnyTerm(NodeText(facts.chain[index]), terms, MatchMode::kBounded)) return true;
  return false;
}

[[nodiscard]] inline bool IsCommandSurface(SurfaceKind surface) {
  return surface == SurfaceKind::kShellLike || surface == SurfaceKind::kScriptInput ||
         surface == SurfaceKind::kCommandPalette || surface == SurfaceKind::kDevToolsConsole;
}

// Entering text: the field's own caption may sit next to it rather than on it.
[[nodiscard]] inline bool IsTextEntry(const EffectFacts &facts) {
  return facts.action == ActionKind::kSetText || facts.action == ActionKind::kType ||
         (facts.action == ActionKind::kKey && !facts.key_is_activation);
}

// An action that might open a file when aimed at one: until a real device shows what a visual
// click or a key does in a file browser or a download list, they all count (ADR v2 S4-5).
[[nodiscard]] inline bool MayOpen(const EffectFacts &facts) {
  return facts.action == ActionKind::kClick || facts.action == ActionKind::kDoubleClick ||
         facts.action == ActionKind::kInvoke || facts.action == ActionKind::kKey;
}

// An action that activates a control: a click, an invoke, a toggle, a menu pick or an activating
// key. Typing letters is not activation.
[[nodiscard]] inline bool IsActivating(const EffectFacts &facts) {
  return facts.action == ActionKind::kClick || facts.action == ActionKind::kDoubleClick ||
         facts.action == ActionKind::kInvoke || facts.action == ActionKind::kToggle ||
         facts.action == ActionKind::kSelect ||
         (facts.action == ActionKind::kKey && facts.key_is_activation);
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

[[nodiscard]] inline EffectDecision Takeover() {
  return Make(EffectClass::kUnclassified, DecisionKind::kTakeover, DecisionReason::kUnclassified);
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

[[nodiscard]] inline bool WithinBounds(const EffectFacts &facts) {
  if (facts.chain.size() > kEffectMaxChainNodes ||
      facts.neighbor_labels.size() > kEffectMaxNeighborLabels ||
      facts.extension.size() > kEffectMaxLabelBytes)
    return false;
  for (const NodeFacts &node : facts.chain)
    if (node.role.size() > kEffectMaxLabelBytes || node.subrole.size() > kEffectMaxLabelBytes ||
        node.label.size() > kEffectMaxLabelBytes)
      return false;
  for (const std::string &label : facts.neighbor_labels)
    if (label.size() > kEffectMaxLabelBytes) return false;
  return true;
}

// Text the lexicon can read: the caller says the language is one it covers; nothing readable-less
// (malformed UTF-8, or letters that imitate Latin ones) appears anywhere in the chain or the
// neighbours; and the control the action lands on has a label. For a click or invoke that control
// is the target up to the nearest actionable ancestor (a window title does not label a button);
// for text entry it is the field itself, or, in a browser, a caption near it.
[[nodiscard]] inline bool TextIsClassifiable(const EffectFacts &facts) {
  if (!facts.text_language_supported) return false;
  for (const NodeFacts &node : facts.chain)
    if (HasUnreadableCharacters(NormalizeForMatch(node.label)) ||
        HasUnreadableCharacters(NormalizeForMatch(node.role)) ||
        HasUnreadableCharacters(NormalizeForMatch(node.subrole)))
      return false;
  for (const std::string &label : facts.neighbor_labels)
    if (HasUnreadableCharacters(NormalizeForMatch(label))) return false;
  if (IsTextEntry(facts)) {
    if (!NormalizeForMatch(facts.chain.front().label).empty()) return true;
    if (facts.origin == OriginState::kNotApplicable) return false;
    for (const std::string &label : facts.neighbor_labels)
      if (!NormalizeForMatch(label).empty()) return true;
    return false;
  }
  const std::size_t span = ActionableSpan(facts);
  for (std::size_t index = 0; index < span; ++index)
    if (!NormalizeForMatch(facts.chain[index].label).empty()) return true;
  return false;
}

} // namespace effect_detail

[[nodiscard]] inline EffectDecision ClassifyEffect(const EffectFacts &facts,
                                                   const EffectRuleset &ruleset = EffectRuleset{}) {
  using namespace effect_detail;
  using Mode = MatchMode;
  // Reading is never refused here; every other action needs a complete picture.
  if (facts.action == ActionKind::kObserve)
    return Make(EffectClass::kOrdinary, DecisionKind::kOrdinary, DecisionReason::kNone);
  if (!facts.metadata_complete || !facts.chain_complete || facts.chain.empty() ||
      facts.surface == SurfaceKind::kUnknown || !WithinBounds(facts))
    return Takeover();

  const bool entering_text = IsTextEntry(facts);
  // A scroll cannot enter a secret, so words in a window title around it do not stop it.
  const bool can_enter = facts.action != ActionKind::kScroll;
  if ((can_enter && (ChainContains(facts, kSecureTerms, Mode::kSubstring) ||
                     ChainContains(facts, kSecureBoundedTerms, Mode::kBounded))) ||
      (entering_text && (NeighborsContain(facts, kSecureTerms, Mode::kSubstring) ||
                         NeighborsContain(facts, kSecureBoundedTerms, Mode::kBounded))))
    return Make(EffectClass::kSecure, DecisionKind::kBlocked, DecisionReason::kSecure);
  if ((can_enter && (ChainContains(facts, kCredentialTerms, Mode::kSubstring) ||
                     ChainContains(facts, kCredentialPrefixTerms, Mode::kPrefix))) ||
      (entering_text && (NeighborsContain(facts, kCredentialTerms, Mode::kSubstring) ||
                         NeighborsContain(facts, kCredentialPrefixTerms, Mode::kPrefix))))
    return Make(EffectClass::kCredential, DecisionKind::kBlocked, DecisionReason::kCredential);
  if (IsCommandSurface(facts.surface) || ChainContains(facts, kSurfaceTerms, Mode::kBounded))
    return Make(EffectClass::kSurface, DecisionKind::kBlocked, DecisionReason::kSurface);

  // Executable and installer extensions (E1, E4) are refused for anything that might open the
  // item, wherever it is shown, and whether or not the target is the item itself.
  // An extension that is not plain ([a-z0-9_+-], after trimming dots and blanks) is unknown.
  const std::string extension = NormalizeExtension(facts.extension);
  const bool extension_known = facts.extension_known && IsPlainExtension(extension);
  if ((MayOpen(facts) || facts.action == ActionKind::kToggle) && extension_known &&
      InSet(extension, kExecutableExtensions)) {
    return Make(InSet(extension, kInstallerExtensions) ? EffectClass::kE4InstallerLaunch
                                                       : EffectClass::kE1ExecutableOpen,
                DecisionKind::kBlocked, DecisionReason::kExecutionTrigger);
  }

  // Text the lexicon cannot read is a round the classifier could not be applied to (ADR section
  // 4). A scroll cannot confirm, open or run anything, so it does not need readable text.
  if (facts.action != ActionKind::kScroll && !TextIsClassifiable(facts)) return Takeover();

  if (IsActivating(facts) && ActionableContains(facts, kInstallerTerms))
    return Make(EffectClass::kE4InstallerLaunch, DecisionKind::kBlocked,
                DecisionReason::kExecutionTrigger);

  // A browser that cannot show where it is, or shows a sensitive place, is a person's. A text
  // field whose neighbouring captions could not be read is, too (ADR 3.5-5).
  if (facts.origin == OriginState::kUnknown) return Takeover();
  if (facts.origin == OriginState::kSensitive)
    return Make(EffectClass::kSurface, DecisionKind::kTakeover, DecisionReason::kSensitiveOrigin);
  if (entering_text && facts.origin != OriginState::kNotApplicable &&
      !facts.neighbor_labels_complete)
    return Takeover();

  // E2 / E3: opening a file from a download list or a file manager. A folder opens by browsing.
  const bool listed_surface =
      facts.surface == SurfaceKind::kDownloadPanel || facts.surface == SurfaceKind::kFileBrowser;
  const bool opens_item =
      listed_surface && MayOpen(facts) &&
      (facts.target_is_file_item || ActionableContains(facts, kOpenTerms));
  // A file item opened from any other surface still needs its extension.
  // A file item, or a control that says "open", on any other surface needs its extension too.
  const bool opens_unlisted_item =
      !listed_surface && MayOpen(facts) &&
      (facts.target_is_file_item || ActionableContains(facts, kOpenTerms));
  if (opens_item || opens_unlisted_item) {
    if (!extension_known) return Takeover();
    if (opens_item) {
      if (facts.mode == SessionMode::kObserveOnly)
        return Make(EffectClass::kOrdinary, DecisionKind::kBlocked, DecisionReason::kObserveOnly);
      return facts.surface == SurfaceKind::kDownloadPanel
                 ? Approval(EffectClass::kE2DownloadOpen, NativeApprovalEffect::kDownloadOpen,
                            ruleset)
                 : Approval(EffectClass::kE3FileManagerOpen,
                            NativeApprovalEffect::kFileManagerOpen, ruleset);
    }
  }

  if (facts.mode == SessionMode::kObserveOnly)
    return Make(EffectClass::kOrdinary, DecisionKind::kBlocked, DecisionReason::kObserveOnly);

  if (IsActivating(facts) && ActionableContains(facts, kConfirmTerms))
    return Approval(EffectClass::kConfirm, NativeApprovalEffect::kHighImpactConfirmation, ruleset);

  if (facts.mode == SessionMode::kSupervised)
    return Approval(EffectClass::kOrdinary, NativeApprovalEffect::kSupervisedAction, ruleset);
  return Make(EffectClass::kOrdinary, DecisionKind::kOrdinary, DecisionReason::kNone);
}

} // namespace sprint_coder::computer_use
