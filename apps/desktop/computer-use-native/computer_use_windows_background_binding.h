#pragma once

#include "computer_use_sha256.h"
#include <cstdint>
#include <string>
#include <vector>

namespace sprint_coder::computer_use {

enum class WindowsBackgroundProxy { kUnknown, kStable, kIndex };
struct WindowsBackgroundAncestor {
  std::uint32_t pid = 0;
  std::vector<std::int32_t> runtime_id;
};
// Native-only, transient read material. Only the digest is retained by the session/authority.
// Value contents are deliberately absent; the pattern availability is the value kind.
struct WindowsBackgroundBindingFacts {
  bool complete = false, reached_root = false;
  std::uint32_t pid = 0;
  std::uintptr_t window = 0;
  std::string control_signature, name, item_status, item_identity, provider;
  WindowsBackgroundProxy proxy = WindowsBackgroundProxy::kUnknown;
  std::vector<WindowsBackgroundAncestor> ancestors;
  std::size_t sibling_index = 0, sibling_count = 0;
  unsigned value_kind = 0;
};

inline std::string WindowsBackgroundBindingDigest(const WindowsBackgroundBindingFacts &facts) {
  if (!facts.complete || !facts.reached_root || facts.pid == 0 || facts.window == 0 ||
      facts.proxy != WindowsBackgroundProxy::kStable || facts.provider.empty() ||
      facts.control_signature.size() != 64 || facts.ancestors.empty() ||
      facts.ancestors.size() > 17 || facts.sibling_count == 0 || facts.sibling_count > 5000 ||
      facts.sibling_index >= facts.sibling_count || facts.value_kind > 3) return {};
  std::string material = "windows-background-binding-v1";
  const auto append = [&](std::string_view value) {
    material += std::to_string(value.size()) + ":";
    material.append(value);
  };
  for (const auto *value : {&facts.control_signature, &facts.name, &facts.item_status,
                             &facts.item_identity, &facts.provider}) {
    if (value->size() > 4096) return {};
    append(*value);
  }
  append(std::to_string(facts.pid));
  append(std::to_string(facts.window));
  append(std::to_string(facts.sibling_index));
  append(std::to_string(facts.sibling_count));
  append(std::to_string(facts.value_kind));
  for (std::size_t i = 0; i < facts.ancestors.size(); ++i) {
    const auto &node = facts.ancestors[i];
    if (node.pid != facts.pid || node.runtime_id.empty() || node.runtime_id.size() > 64) return {};
    for (std::size_t j = 0; j < i; ++j)
      if (node.runtime_id == facts.ancestors[j].runtime_id) return {};
    append(std::to_string(node.pid));
    append(std::to_string(node.runtime_id.size()));
    for (const auto id : node.runtime_id) append(std::to_string(id));
  }
  return Sha256Hex(material);
}

inline bool WindowsBackgroundBindingMatches(bool background, std::string_view observed,
                                             std::string_view current) {
  if (!background) return true;
  const auto digest = [](std::string_view value) {
    if (value.size() != 64) return false;
    for (const char c : value)
      if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
    return true;
  };
  return digest(observed) && digest(current) && observed == current;
}
} // namespace sprint_coder::computer_use
