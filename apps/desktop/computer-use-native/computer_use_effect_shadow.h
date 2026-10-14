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
// The walk reads one node more than the core accepts: the application element above the window is
// read to know the window was the root, then dropped.
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
};

struct ShadowAxCapture {
  bool target_found = false;
  // [0] is the target, then its parents, at most kShadowMaxCaptureNodes. The walk stops after a
  // window, or at the application element.
  std::vector<ShadowAxNode> chain;
  // The walk ended because there was no parent (or it reached the window), not because of the cap.
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
};

struct ShadowRequestInfo {
  std::string_view kind;
  std::string_view key;
  std::string_view maximum_mode;
  std::string_view policy_language;
  std::string_view executable_path;
};

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

// The node's words as one label (title, description, help, placeholder, identifier, value),
// refused when any part, or the whole, is longer than the core accepts.
[[nodiscard]] inline bool JoinLabel(const ShadowAxNode &node, std::string *label) {
  const std::string_view parts[] = {node.title,       node.description, node.help,
                                    node.placeholder, node.identifier,  node.value};
  std::string joined;
  for (const std::string_view part : parts) {
    if (part.size() > kEffectMaxLabelBytes) return false;
    if (part.empty()) continue;
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

[[nodiscard]] inline ShadowFacts BuildShadowFacts(const ShadowAxCapture &capture,
                                                  const ShadowRequestInfo &request) {
  using namespace shadow_detail;
  ShadowFacts result;
  EffectFacts &facts = result.facts;

  ActionKind action = ActionKind::kClick;
  if (!ShadowActionForKind(request.kind, &action)) result.gaps |= kShadowGapUnsupportedAction;
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
  if (!nodes.empty() && Lowercase(nodes.back().role) == "axapplication") nodes.pop_back();
  bool oversize = false;
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
    if (!NodeIsBounded(node) || !JoinLabel(node, &fact.label)) oversize = true;
    if (!NodeIsBounded(node)) {
      fact.role.clear();
    } else {
      fact.role = node.role;
      fact.subrole = node.subrole;
    }
    if (Lowercase(node.role) == "axwebarea") web_area = true;
    facts.chain.push_back(std::move(fact));
  }
  if (oversize) result.gaps |= kShadowGapOversize;
  const bool role_present = !nodes.empty() && !nodes.front().role.empty();
  if (!nodes.empty() && !role_present) result.gaps |= kShadowGapRoleMissing;
  facts.metadata_complete = capture.target_found && role_present && !oversize &&
                            (result.gaps & kShadowGapUnsupportedAction) == 0;
  facts.chain_complete = chain_reached_root && !nodes.empty();

  // Captions near the target. Empty ones carry nothing and are dropped.
  bool neighbors_complete = capture.neighbors_complete;
  for (const ShadowAxNode &node : capture.neighbors) {
    std::string label;
    if (!JoinLabel(node, &label)) {
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
  if (!web_area) {
    facts.origin = OriginState::kNotApplicable;
  } else if (!capture.web_area_url_read) {
    facts.origin = OriginState::kUnknown;
    result.gaps |= kShadowGapOrigin;
  } else {
    const std::string url = Lowercase(capture.web_area_url);
    const std::size_t colon = url.find(':');
    const std::string scheme = colon == std::string::npos ? std::string() : url.substr(0, colon);
    if (scheme == "devtools" || scheme == "chrome-devtools") {
      facts.origin = OriginState::kOrdinary;
      facts.surface = SurfaceKind::kDevToolsConsole;
    } else if (scheme == "http" || scheme == "https" || scheme == "file") {
      facts.origin = OriginState::kOrdinary;
    } else {
      facts.origin = OriginState::kUnknown;
      result.gaps |= kShadowGapOrigin;
    }
  }

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
  [[nodiscard]] bool V2IsStricter() const { return v1_ordinary && kind != DecisionKind::kOrdinary; }
  [[nodiscard]] bool V2IsLooser() const { return !v1_ordinary && kind == DecisionKind::kOrdinary; }
};
static_assert(std::is_trivially_copyable_v<ShadowRecord>,
              "a shadow record must not be able to hold text");

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

} // namespace sprint_coder::computer_use
