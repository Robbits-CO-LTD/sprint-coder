#pragma once

// Classifier v2, C2: the shadow of the effect classifier. This header turns what the macOS
// accessibility walk read (plain strings, no Apple types) into the facts the portable core wants,
// runs the core, and keeps a summary in a bounded ring. It decides nothing: the v1 preflight
// receipt, the dispatch guards and every input API are untouched, and a shadow never reaches a
// caller. The summary carries enum values and counters only, never a label, a URL or a title.
//
// What a capture may contain is closed by the native side (see the contract test): reads of
// role, subrole, title, description, help, identifier, placeholder, the value of static text,
// parent, children, URL and file name. Nothing here reads the process, a clock or the filesystem.

#include "computer_use_effect_classifier.h"

#include <array>
#include <cstddef>
#include <cstdint>
#include <mutex>
#include <string>
#include <string_view>
#include <type_traits>
#include <vector>

namespace sprint_coder::computer_use {

constexpr std::size_t kShadowLogCapacity = 64;
// The walk reads one node more than the core accepts, so a chain that only just fits is told from
// one that does not; a window ends the walk, and an application element (if reached) is dropped.
constexpr std::size_t kShadowMaxCaptureNodes = kEffectMaxChainNodes + 1;

// Why a fact set is not whole (bit set). Reported next to the decision, so a takeover can be told
// from "the walk was cut short".
constexpr std::uint32_t kShadowGapTargetMissing = 1u << 0;
constexpr std::uint32_t kShadowGapOversize = 1u << 1;
constexpr std::uint32_t kShadowGapChainTruncated = 1u << 2;
constexpr std::uint32_t kShadowGapNeighborsIncomplete = 1u << 3;
constexpr std::uint32_t kShadowGapExtensionUnknown = 1u << 4;
constexpr std::uint32_t kShadowGapLanguage = 1u << 5;
constexpr std::uint32_t kShadowGapOrigin = 1u << 6;
constexpr std::uint32_t kShadowGapUnsupportedAction = 1u << 7;
constexpr std::uint32_t kShadowGapRoleMissing = 1u << 8;
// Nothing was read: v1 could not re-validate the bound target (closed, canceled, identity,
// generation, eligibility, focus, stale), or the action was canceled while the capture ran.
constexpr std::uint32_t kShadowGapV1Invalid = 1u << 9;
constexpr std::uint32_t kShadowGapCanceled = 1u << 10;
// The call or time budget ran out before the capture was whole.
constexpr std::uint32_t kShadowGapBudget = 1u << 11;
// An attribute failed to read (not "no value"): the facts are missing something.
constexpr std::uint32_t kShadowGapReadFailed = 1u << 12;
// Another capture was still running (a hung target app), so this one was not taken.
constexpr std::uint32_t kShadowGapBusy = 1u << 13;

// The shadow shares the serial lane with the preflight, so a capture is bounded: AX calls, and
// time on a monotonic clock. The numbers are a share of the lane's budgets (the Cancel ack waits
// one second, the Close drain ten) that a normal capture fits in (about 250 calls, well under a
// millisecond each), and are to be measured on a real device (#777).
constexpr std::uint32_t kShadowMaxAxCalls = 640;
constexpr std::uint64_t kShadowDeadlineNs = 150'000'000;

// One accessibility node as read. An attribute that is absent or could not be read is empty.
struct ShadowAxNode {
  std::string role;
  std::string subrole;
  std::string title;
  std::string description;
  std::string help;
  std::string identifier;
  std::string placeholder;
  // Only ever filled for static text (a form caption), never for an editable control.
  std::string value;
  // An attribute was longer than the core accepts (kEffectMaxLabelBytes): it was not read, and
  // the node is not whole. Never an empty string.
  bool oversize = false;
  // An attribute failed to read for a reason other than "no value" / "unsupported", or the
  // capture stopped before it: the node is not whole.
  bool read_failed = false;
};

struct ShadowAxCapture {
  bool target_found = false;
  // [0] is the target, then its parents, at most kShadowMaxCaptureNodes. The walk stops after a
  // window, or at the application element.
  std::vector<ShadowAxNode> chain;
  // The walk arrived at a window or the application element. A parent that was missing or could
  // not be read, or the cap, leaves this false: the chain is cut short.
  bool chain_reached_root = false;
  // The other children of the target's parent.
  std::vector<ShadowAxNode> neighbors;
  // Every sibling could be listed and read.
  bool neighbors_complete = false;
  // The target's own AXURL (a file item) and AXFilename.
  bool url_present = false;
  std::string url;
  std::string filename;
  // The URL of the AXWebArea in the chain, when there is one and it could be read.
  bool web_area_url_read = false;
  std::string web_area_url;
  // The call or time budget ran out, or a read of the target's URL / file name failed.
  bool budget_exhausted = false;
  bool read_failed = false;
};

// Spends AX calls against a count and a deadline. Pure: the caller passes the time.
class ShadowBudget {
public:
  explicit ShadowBudget(std::uint64_t start_ns) : deadline_ns_(start_ns + kShadowDeadlineNs) {}
  // One more AX call: false (and from then on always false) when the calls are used up or the
  // deadline has passed.
  [[nodiscard]] bool Spend(std::uint64_t now_ns) {
    if (exhausted_) return false;
    if (calls_ >= kShadowMaxAxCalls || now_ns > deadline_ns_) {
      exhausted_ = true;
      return false;
    }
    ++calls_;
    return true;
  }
  [[nodiscard]] bool Exhausted() const { return exhausted_; }
  [[nodiscard]] std::uint32_t Calls() const { return calls_; }
  // The deadline has passed (spends no call). Used once the last call has returned.
  [[nodiscard]] bool PastDeadline(std::uint64_t now_ns) const { return now_ns > deadline_ns_; }
  void MarkExhausted() { exhausted_ = true; }

private:
  std::uint64_t deadline_ns_;
  std::uint32_t calls_ = 0;
  bool exhausted_ = false;
};

struct ShadowRequestInfo {
  std::string_view kind;
  std::string_view key;
  std::string_view maximum_mode;
  std::string_view policy_language;
  std::string_view executable_path;
  // A click that opens what it lands on: it completes a double click, or the file manager opens an
  // item on one click. Facts then carry it as a double click. Ignored for any other kind.
  bool click_opens = false;
};

// Whether a click completes a double click: the previous click was at most `interval_ms` before and
// at most `slop_x` / `slop_y` pixels away on each axis (the same test the OS applies). No previous
// click (`last_tick_ms` == 0 and no `has_last`), or a clock that went backwards, is not one.
[[nodiscard]] inline bool ClickCompletesDoubleClick(bool has_last, std::uint64_t last_tick_ms,
                                                    std::int32_t last_x, std::int32_t last_y,
                                                    std::uint64_t now_tick_ms, std::int32_t x,
                                                    std::int32_t y, std::uint32_t interval_ms,
                                                    std::int32_t slop_x, std::int32_t slop_y) {
  if (!has_last || now_tick_ms < last_tick_ms) return false;
  if (now_tick_ms - last_tick_ms > interval_ms) return false;
  const std::int64_t dx = static_cast<std::int64_t>(x) - last_x;
  const std::int64_t dy = static_cast<std::int64_t>(y) - last_y;
  return (dx < 0 ? -dx : dx) <= slop_x && (dy < 0 ? -dy : dy) <= slop_y;
}

struct ShadowFacts {
  EffectFacts facts;
  std::uint32_t gaps = 0;
};

namespace shadow_detail {

[[nodiscard]] inline std::string Lowercase(std::string_view text) {
  std::string output(text);
  for (char &character : output)
    if (character >= 'A' && character <= 'Z') character = static_cast<char>(character + 32);
  return output;
}

[[nodiscard]] inline bool EndsWith(std::string_view text, std::string_view suffix) {
  return text.size() >= suffix.size() && text.substr(text.size() - suffix.size()) == suffix;
}

[[nodiscard]] inline int HexValue(char character) {
  if (character >= '0' && character <= '9') return character - '0';
  if (character >= 'a' && character <= 'f') return character - 'a' + 10;
  if (character >= 'A' && character <= 'F') return character - 'A' + 10;
  return -1;
}

[[nodiscard]] inline std::string PercentDecode(std::string_view text) {
  std::string output;
  output.reserve(text.size());
  for (std::size_t index = 0; index < text.size(); ++index) {
    if (text[index] == '%' && index + 2 < text.size() && HexValue(text[index + 1]) >= 0 &&
        HexValue(text[index + 2]) >= 0) {
      output.push_back(static_cast<char>(HexValue(text[index + 1]) * 16 + HexValue(text[index + 2])));
      index += 2;
    } else {
      output.push_back(text[index]);
    }
  }
  return output;
}

// NFKC-style folding for the characters a label can disguise itself with, applied again here so the
// portable half does not depend on the platform having folded already (the macOS capture does, with
// CFStringNormalize): full-width ASCII becomes ASCII, and half-width katakana become full-width
// katakana, with a following voiced or semi-voiced mark combined into the letter.
inline void AppendCodePoint(char32_t code, std::string *output) {
  if (code < 0x80) {
    output->push_back(static_cast<char>(code));
  } else if (code < 0x800) {
    output->push_back(static_cast<char>(0xC0 | (code >> 6)));
    output->push_back(static_cast<char>(0x80 | (code & 0x3F)));
  } else if (code < 0x10000) {
    output->push_back(static_cast<char>(0xE0 | (code >> 12)));
    output->push_back(static_cast<char>(0x80 | ((code >> 6) & 0x3F)));
    output->push_back(static_cast<char>(0x80 | (code & 0x3F)));
  } else {
    output->push_back(static_cast<char>(0xF0 | (code >> 18)));
    output->push_back(static_cast<char>(0x80 | ((code >> 12) & 0x3F)));
    output->push_back(static_cast<char>(0x80 | ((code >> 6) & 0x3F)));
    output->push_back(static_cast<char>(0x80 | (code & 0x3F)));
  }
}

// U+FF61..U+FF9F to the full-width form (U+FF9E / U+FF9F, the marks, are handled by the caller).
inline constexpr char32_t kHalfWidthKana[] = {
    0x3002, 0x300C, 0x300D, 0x3001, 0x30FB, 0x30F2, 0x30A1, 0x30A3, 0x30A5, 0x30A7, 0x30A9,
    0x30E3, 0x30E5, 0x30E7, 0x30C3, 0x30FC, 0x30A2, 0x30A4, 0x30A6, 0x30A8, 0x30AA, 0x30AB,
    0x30AD, 0x30AF, 0x30B1, 0x30B3, 0x30B5, 0x30B7, 0x30B9, 0x30BB, 0x30BD, 0x30BF, 0x30C1,
    0x30C4, 0x30C6, 0x30C8, 0x30CA, 0x30CB, 0x30CC, 0x30CD, 0x30CE, 0x30CF, 0x30D2, 0x30D5,
    0x30D8, 0x30DB, 0x30DE, 0x30DF, 0x30E0, 0x30E1, 0x30E2, 0x30E4, 0x30E6, 0x30E8, 0x30E9,
    0x30EA, 0x30EB, 0x30EC, 0x30ED, 0x30EF, 0x30F3};
static_assert(sizeof(kHalfWidthKana) / sizeof(kHalfWidthKana[0]) == 0xFF9D - 0xFF61 + 1);

[[nodiscard]] inline std::string CompatFold(std::string_view text) {
  using effect_detail::DecodeUtf8;
  std::string output;
  output.reserve(text.size());
  std::size_t index = 0;
  while (index < text.size()) {
    char32_t code = 0;
    std::size_t length = 1;
    if (!DecodeUtf8(text, index, &code, &length)) {
      output.push_back(text[index]);
      ++index;
      continue;
    }
    index += length;
    if (code == 0x3000) { // the ideographic space is a plain space under NFKC
      output.push_back(' ');
      continue;
    }
    if (code >= 0xFF01 && code <= 0xFF5E) {
      output.push_back(static_cast<char>(code - 0xFF01 + 0x21));
      continue;
    }
    if (code < 0xFF61 || code > 0xFF9D) {
      AppendCodePoint(code, &output);
      continue;
    }
    char32_t folded = kHalfWidthKana[code - 0xFF61];
    // A voiced (U+FF9E) or semi-voiced (U+FF9F) mark right after combines into the letter.
    char32_t mark = 0;
    std::size_t mark_length = 1;
    if (index < text.size() && DecodeUtf8(text, index, &mark, &mark_length) &&
        (mark == 0xFF9E || mark == 0xFF9F)) {
      const bool semi = mark == 0xFF9F;
      const bool voiceable = (folded >= 0x30AB && folded <= 0x30C1 && (folded - 0x30AB) % 2 == 0) ||
                             (folded >= 0x30C4 && folded <= 0x30C8 && (folded - 0x30C4) % 2 == 0) ||
                             (folded >= 0x30CF && folded <= 0x30DB && (folded - 0x30CF) % 3 == 0);
      if (!semi && (voiceable || folded == 0x30A6 || folded == 0x30EF || folded == 0x30F2)) {
        // U+30A6 -> U+30F4 (vu), U+30EF -> U+30F7 (va), U+30F2 -> U+30FA (vo); the rest +1.
        folded = folded == 0x30A6   ? 0x30F4
                 : folded == 0x30EF ? 0x30F7
                 : folded == 0x30F2 ? 0x30FA
                                    : folded + 1;
        index += mark_length;
      } else if (semi && folded >= 0x30CF && folded <= 0x30DB && (folded - 0x30CF) % 3 == 0) {
        folded += 2;
        index += mark_length;
      }
    }
    AppendCodePoint(folded, &output);
  }
  return output;
}

// The node's words as one label (title, description, help, placeholder, identifier, value),
// refused when any part, or the whole, is longer than the core accepts.
[[nodiscard]] inline bool JoinLabel(const ShadowAxNode &node, std::string *label) {
  const std::string_view parts[] = {node.title,       node.description, node.help,
                                    node.placeholder, node.identifier,  node.value};
  std::string joined;
  for (const std::string_view raw : parts) {
    if (raw.size() > kEffectMaxLabelBytes) return false;
    if (raw.empty()) continue;
    const std::string part = CompatFold(raw);
    if (!joined.empty()) joined.push_back(' ');
    joined.append(part);
    if (joined.size() > kEffectMaxLabelBytes) return false;
  }
  *label = std::move(joined);
  return true;
}

[[nodiscard]] inline bool NodeIsBounded(const ShadowAxNode &node) {
  return node.role.size() <= kEffectMaxLabelBytes && node.subrole.size() <= kEffectMaxLabelBytes;
}

// Packages that open as one item although the AX URL ends in a slash.
[[nodiscard]] inline bool IsPackageExtension(std::string_view extension) {
  static constexpr std::string_view kPackages[] = {"app", "bundle", "framework", "plugin",
                                                   "kext", "prefpane", "appex", "xpc", "pkg"};
  for (const std::string_view name : kPackages)
    if (extension == name) return true;
  return false;
}

struct ItemFacts {
  bool is_item = false;
  bool extension_known = false;
  std::string extension;
};

// The item a file URL (or, failing that, a file name) names. A folder opens by browsing into it.
[[nodiscard]] inline ItemFacts ReadItem(const ShadowAxCapture &capture) {
  ItemFacts item;
  std::string name;
  bool trailing_slash = false;
  if (capture.url_present && Lowercase(capture.url).rfind("file:", 0) == 0) {
    std::string_view path(capture.url);
    while (!path.empty() && (path.back() == '#' || path.back() == '?')) path.remove_suffix(1);
    trailing_slash = !path.empty() && path.back() == '/';
    while (!path.empty() && path.back() == '/') path.remove_suffix(1);
    const std::size_t slash = path.rfind('/');
    name = PercentDecode(slash == std::string_view::npos ? path : path.substr(slash + 1));
  } else if (!capture.filename.empty()) {
    name = capture.filename;
  } else {
    return item;
  }
  const std::size_t dot = name.rfind('.');
  std::string extension =
      dot == std::string::npos || dot == 0 ? std::string() : Lowercase(name.substr(dot + 1));
  if (trailing_slash && !IsPackageExtension(extension)) return item;
  item.is_item = true;
  item.extension = std::move(extension);
  item.extension_known = !item.extension.empty();
  return item;
}

[[nodiscard]] inline SurfaceKind SurfaceForExecutable(std::string_view executable_path) {
  const std::string path = Lowercase(executable_path);
  static constexpr std::string_view kShells[] = {
      "/terminal.app/", "/iterm.app/", "/warp.app/",   "/kitty.app/",
      "/alacritty.app/", "/ghostty.app/", "/hyper.app/", "/wezterm.app/"};
  for (const std::string_view name : kShells)
    if (path.find(name) != std::string::npos) return SurfaceKind::kShellLike;
  static constexpr std::string_view kPalettes[] = {"/raycast.app/", "/alfred", "/spotlight"};
  for (const std::string_view name : kPalettes)
    if (path.find(name) != std::string::npos) return SurfaceKind::kCommandPalette;
  if (path.find("/finder.app/") != std::string::npos) return SurfaceKind::kFileBrowser;
  return SurfaceKind::kOrdinary;
}

} // namespace shadow_detail

// Maps the request kind to the core's action. False for a kind the core has no action for.
[[nodiscard]] inline bool ShadowActionForKind(std::string_view kind, ActionKind *action) {
  struct Entry {
    std::string_view kind;
    ActionKind action;
  };
  static constexpr Entry kKinds[] = {
      {"click", ActionKind::kClick},       {"scroll", ActionKind::kScroll},
      {"invoke", ActionKind::kInvoke},     {"set_text", ActionKind::kSetText},
      {"select", ActionKind::kSelect},     {"toggle", ActionKind::kToggle},
      {"expand_collapse", ActionKind::kExpandCollapse}, {"type", ActionKind::kType},
      {"key", ActionKind::kKey}};
  for (const Entry &entry : kKinds)
    if (entry.kind == kind) {
      *action = entry.action;
      return true;
    }
  return false;
}

// Where a page is, from the URL of its web area (shared by every platform's capture). Not a page:
// not applicable. A page whose URL could not be read, or whose scheme is not known, is unknown.
inline void ApplyShadowOrigin(bool is_page, bool url_read, std::string_view page_url,
                              EffectFacts *facts, std::uint32_t *gaps) {
  using namespace shadow_detail;
  if (!is_page) {
    facts->origin = OriginState::kNotApplicable;
    return;
  }
  if (!url_read) {
    facts->origin = OriginState::kUnknown;
    *gaps |= kShadowGapOrigin;
    return;
  }
  const std::string url = Lowercase(page_url);
  const std::size_t colon = url.find(':');
  const std::string scheme = colon == std::string::npos ? std::string() : url.substr(0, colon);
  if (scheme == "devtools" || scheme == "chrome-devtools") {
    facts->origin = OriginState::kOrdinary;
    facts->surface = SurfaceKind::kDevToolsConsole;
  } else if (scheme == "http" || scheme == "https" || scheme == "file") {
    facts->origin = OriginState::kOrdinary;
  } else {
    facts->origin = OriginState::kUnknown;
    *gaps |= kShadowGapOrigin;
  }
}

[[nodiscard]] inline ShadowFacts BuildShadowFacts(const ShadowAxCapture &capture,
                                                  const ShadowRequestInfo &request) {
  using namespace shadow_detail;
  ShadowFacts result;
  EffectFacts &facts = result.facts;

  ActionKind action = ActionKind::kClick;
  if (!ShadowActionForKind(request.kind, &action)) result.gaps |= kShadowGapUnsupportedAction;
  if (request.kind == "click" && request.click_opens) action = ActionKind::kDoubleClick;
  facts.action = action;
  facts.key_is_activation = request.kind == "key" && request.key == "Enter";
  facts.mode = request.maximum_mode == "full_access_app" ? SessionMode::kFullAccess
               : request.maximum_mode == "supervised"    ? SessionMode::kSupervised
                                                         : SessionMode::kObserveOnly;
  facts.text_language_supported =
      request.policy_language == "en" || request.policy_language == "ja";
  if (!facts.text_language_supported) result.gaps |= kShadowGapLanguage;

  if (!capture.target_found || capture.chain.empty()) result.gaps |= kShadowGapTargetMissing;

  // The chain: the target up to the window. The application element above a window is not a node.
  std::vector<ShadowAxNode> nodes = capture.chain;
  bool chain_reached_root = capture.chain_reached_root;
  // Roles are compared after folding, like every other fact, so a full-width role cannot hide the
  // application element or a page root.
  if (!nodes.empty() && Lowercase(CompatFold(nodes.back().role)) == "axapplication")
    nodes.pop_back();
  bool oversize = false;
  bool node_read_failed = false;
  if (nodes.size() > kEffectMaxChainNodes) {
    nodes.resize(kEffectMaxChainNodes);
    chain_reached_root = false;
    result.gaps |= kShadowGapChainTruncated;
  } else if (!chain_reached_root && !nodes.empty()) {
    result.gaps |= kShadowGapChainTruncated;
  }
  bool web_area = false;
  for (const ShadowAxNode &node : nodes) {
    NodeFacts fact;
    if (node.oversize || !NodeIsBounded(node) || !JoinLabel(node, &fact.label)) oversize = true;
    if (node.read_failed) node_read_failed = true;
    if (!NodeIsBounded(node)) {
      fact.role.clear();
    } else {
      fact.role = CompatFold(node.role);
      fact.subrole = CompatFold(node.subrole);
    }
    if (Lowercase(fact.role) == "axwebarea" || Lowercase(fact.role) == "document") web_area = true;
    facts.chain.push_back(std::move(fact));
  }
  if (oversize) result.gaps |= kShadowGapOversize;
  if (node_read_failed || capture.read_failed) result.gaps |= kShadowGapReadFailed;
  if (capture.budget_exhausted) result.gaps |= kShadowGapBudget;
  // The role is judged on the folded value, like every other fact: a role of only blanks (U+3000, a
  // no-break space) is no role. facts.chain[0] is the target's node, folded; an unbounded role was
  // cleared there and is missing too.
  const bool role_present = !facts.chain.empty() &&
                            !effect_detail::NormalizeForMatch(facts.chain.front().role).empty();
  if (!nodes.empty() && !role_present) result.gaps |= kShadowGapRoleMissing;
  facts.metadata_complete = capture.target_found && role_present && !oversize &&
                            !node_read_failed && !capture.read_failed && !capture.budget_exhausted &&
                            (result.gaps & kShadowGapUnsupportedAction) == 0;
  facts.chain_complete = chain_reached_root && !nodes.empty();

  // Captions near the target. Empty ones carry nothing and are dropped.
  bool neighbors_complete = capture.neighbors_complete && !capture.budget_exhausted;
  for (const ShadowAxNode &node : capture.neighbors) {
    std::string label;
    if (node.oversize || node.read_failed || !JoinLabel(node, &label)) {
      neighbors_complete = false;
      continue;
    }
    if (label.empty()) continue;
    if (facts.neighbor_labels.size() >= kEffectMaxNeighborLabels) {
      neighbors_complete = false;
      break;
    }
    facts.neighbor_labels.push_back(std::move(label));
  }
  facts.neighbor_labels_complete = neighbors_complete;
  if (!neighbors_complete) result.gaps |= kShadowGapNeighborsIncomplete;

  // The surface and, in a page, where it is. Sensitive places are not measured yet.
  facts.surface = capture.target_found ? SurfaceForExecutable(request.executable_path)
                                       : SurfaceKind::kUnknown;
  ApplyShadowOrigin(web_area, capture.web_area_url_read, capture.web_area_url, &facts, &result.gaps);

  const ItemFacts item = ReadItem(capture);
  facts.target_is_file_item = item.is_item;
  facts.extension_known = item.is_item && item.extension_known;
  if (facts.extension_known) facts.extension = item.extension;
  if (item.is_item && !item.extension_known) result.gaps |= kShadowGapExtensionUnknown;
  return result;
}

// What stays of one shadow classification: enum values and counters only.
struct ShadowRecord {
  ActionKind action = ActionKind::kObserve;
  EffectClass effect_class = EffectClass::kUnclassified;
  DecisionKind kind = DecisionKind::kTakeover;
  DecisionReason reason = DecisionReason::kUnclassified;
  std::uint32_t gaps = 0;
  // What the v1 preflight said: it let the action through as ordinary.
  bool v1_ordinary = false;
  // Nothing was read (v1 could not re-validate the target, or the action was canceled): not a
  // comparison, so it is neither stricter nor looser.
  [[nodiscard]] bool Skipped() const {
    return (gaps & (kShadowGapV1Invalid | kShadowGapCanceled | kShadowGapBusy)) != 0;
  }
  [[nodiscard]] bool V2IsStricter() const {
    return !Skipped() && v1_ordinary && kind != DecisionKind::kOrdinary;
  }
  [[nodiscard]] bool V2IsLooser() const {
    return !Skipped() && !v1_ordinary && kind == DecisionKind::kOrdinary;
  }
};
static_assert(std::is_trivially_copyable_v<ShadowRecord>,
              "a shadow record must not be able to hold text");

// A shadow that read nothing (see kShadowGapV1Invalid / kShadowGapCanceled): not a classification.
// It is a takeover of the unclassified kind, so a count of "v2 is looser" never includes it.
[[nodiscard]] inline ShadowRecord ShadowSkippedRecord(std::string_view kind, std::uint32_t gap,
                                                      bool v1_ordinary) {
  ShadowRecord record;
  ActionKind action = ActionKind::kClick;
  if (!ShadowActionForKind(kind, &action)) gap |= kShadowGapUnsupportedAction;
  record.action = action;
  record.gaps = gap;
  record.v1_ordinary = v1_ordinary;
  return record;
}

[[nodiscard]] inline ShadowRecord ShadowClassify(const ShadowAxCapture &capture,
                                                 const ShadowRequestInfo &request,
                                                 bool v1_ordinary,
                                                 const EffectRuleset &ruleset = EffectRuleset{}) {
  const ShadowFacts built = BuildShadowFacts(capture, request);
  const EffectDecision decision = ClassifyEffect(built.facts, ruleset);
  ShadowRecord record;
  record.action = built.facts.action;
  record.effect_class = decision.effect_class;
  record.kind = decision.kind;
  record.reason = decision.reason;
  record.gaps = built.gaps;
  record.v1_ordinary = v1_ordinary;
  return record;
}

// A fixed-size ring of the most recent records, for diagnostics and tests. Nothing reads it to
// decide anything.
class EffectShadowLog {
public:
  void Record(const ShadowRecord &record) {
    std::lock_guard<std::mutex> lock(mutex_);
    entries_[next_ % kShadowLogCapacity] = record;
    ++next_;
  }
  [[nodiscard]] std::uint64_t Total() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return next_;
  }
  // Oldest first.
  [[nodiscard]] std::vector<ShadowRecord> Snapshot() const {
    std::lock_guard<std::mutex> lock(mutex_);
    std::vector<ShadowRecord> output;
    const std::uint64_t count = next_ < kShadowLogCapacity ? next_ : kShadowLogCapacity;
    for (std::uint64_t index = next_ - count; index < next_; ++index)
      output.push_back(entries_[index % kShadowLogCapacity]);
    return output;
  }

private:
  mutable std::mutex mutex_;
  std::array<ShadowRecord, kShadowLogCapacity> entries_{};
  std::uint64_t next_ = 0;
};

// The ring of the process. It is never destroyed: a capture block still queued when the process
// exits must not touch a static that has already been torn down (destruction order at exit), so
// the object is leaked on purpose and stays valid for the life of the process.
[[nodiscard]] inline EffectShadowLog &ProcessShadowLog() {
  static EffectShadowLog *const log = new EffectShadowLog();
  return *log;
}

// ---- Reading one string (used by the Windows shadow; the macOS reader keeps its own copy of the
// same rules for now, see the ADR) ------------------------------------------------------------
// A platform read ends in exactly one of these, and every one of them is Settled into a flag, so a
// failed, over-long or stopped read can never become an empty answer.
enum class ShadowReadResult : std::uint8_t { kOk, kAbsent, kFailed, kTooLong, kStopped };

// Only kOk is true. "Absent" (no value / unsupported) leaves no trace; a too-long string sets
// `too_long` when the caller keeps one apart (a node's oversize), else `failed`; a failed or
// stopped read sets `failed`.
inline bool ShadowSettle(ShadowReadResult result, bool *failed, bool *too_long = nullptr) {
  switch (result) {
  case ShadowReadResult::kOk:
    return true;
  case ShadowReadResult::kAbsent:
    return false;
  case ShadowReadResult::kTooLong:
    *(too_long != nullptr ? too_long : failed) = true;
    return false;
  case ShadowReadResult::kFailed:
  case ShadowReadResult::kStopped:
    *failed = true;
    return false;
  }
  return false;
}

// A string already normalized to NFKC (by the platform, with its own NFKC call) and
// converted to UTF-8, checked against the bound in UTF-8 BYTES. Never truncated, never emptied:
// malformed UTF-8 is a failed read, an empty string is absent, a string over the bound is too long.
[[nodiscard]] inline ShadowReadResult ShadowCheckText(std::string_view normalized_utf8,
                                                      std::size_t maximum_bytes,
                                                      std::string *output) {
  if (normalized_utf8.size() > maximum_bytes) return ShadowReadResult::kTooLong;
  if (!effect_detail::IsValidUtf8(normalized_utf8)) return ShadowReadResult::kFailed;
  if (normalized_utf8.empty()) return ShadowReadResult::kAbsent;
  output->assign(normalized_utf8);
  return ShadowReadResult::kOk;
}

// A UTF-16 length is only a cheap cut before converting something huge: every unit is at least one
// UTF-8 byte, so more units than the byte bound can never fit. Not a substitute for the byte count.
[[nodiscard]] constexpr bool ShadowUnitsTooLong(std::size_t utf16_units,
                                                std::size_t maximum_bytes) noexcept {
  return utf16_units > maximum_bytes;
}

// Admission of one more platform call: refused once the action is no longer valid (canceled, the
// target changed) or the budget is spent, and from then on always refused. Pure: the caller passes
// the monotonic time and whether the action is still valid.
class ShadowGate {
public:
  explicit ShadowGate(std::uint64_t start_ns) : budget_(start_ns) {}
  [[nodiscard]] bool Step(std::uint64_t now_ns, bool action_still_valid) {
    if (stopped_) return false;
    if (!action_still_valid) {
      canceled_ = true;
      stopped_ = true;
      return false;
    }
    if (!budget_.Spend(now_ns)) {
      stopped_ = true;
      return false;
    }
    return true;
  }
  // The capture is over: it is still good only if it was not canceled and not late. A last call that
  // succeeded after the deadline (or a cancel) must not pass for a complete, timely capture. Spends
  // no call.
  [[nodiscard]] bool Finish(std::uint64_t now_ns, bool action_still_valid) {
    if (stopped_) return false;
    if (!action_still_valid) {
      canceled_ = true;
      stopped_ = true;
      return false;
    }
    if (budget_.PastDeadline(now_ns)) {
      budget_.MarkExhausted();
      stopped_ = true;
      return false;
    }
    return true;
  }
  [[nodiscard]] bool Canceled() const { return canceled_; }
  // Refused once (canceled or out of budget): nothing more may be read.
  [[nodiscard]] bool Stopped() const { return stopped_; }
  [[nodiscard]] bool BudgetExhausted() const { return budget_.Exhausted(); }
  [[nodiscard]] std::uint32_t Calls() const { return budget_.Calls(); }
  // The gap bits this gate accounts for.
  [[nodiscard]] std::uint32_t Gaps() const {
    return (canceled_ ? kShadowGapCanceled : 0u) | (budget_.Exhausted() ? kShadowGapBudget : 0u);
  }

private:
  ShadowBudget budget_;
  bool canceled_ = false;
  bool stopped_ = false;
};

} // namespace sprint_coder::computer_use
