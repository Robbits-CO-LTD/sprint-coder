#pragma once

#include "computer_use_windows_background_binding.h"

namespace sprint_coder::computer_use::windows_background_binding_test {
inline bool Check() {
  WindowsBackgroundBindingFacts facts;
  facts.complete = facts.reached_root = true;
  facts.pid = 7;
  facts.window = 101;
  facts.control_signature = std::string(64, 'a');
  facts.ancestors = {{7, {3, 10}}, {7, {42, 101}}};
  facts.name = "Synthetic item";
  facts.item_status = "Synthetic status";
  facts.provider = "Synthetic native provider";
  facts.proxy = WindowsBackgroundProxy::kStable;
  facts.sibling_count = 2;
  facts.sibling_index = 0;
  facts.value_kind = 1;
  const auto signature = WindowsBackgroundBindingDigest(facts);
  if (signature.size() != 64 || !WindowsBackgroundBindingMatches(true, signature, signature) ||
      !WindowsBackgroundBindingMatches(false, {}, {}) ||
      WindowsBackgroundBindingMatches(true, {}, {})) return false;
  const auto changed = [&](auto change) {
    auto other = facts;
    change(other);
    return !WindowsBackgroundBindingMatches(true, signature, WindowsBackgroundBindingDigest(other));
  };
  // Same runtime id/index: content replacement and virtualized item reuse still invalidate.
  if (!changed([](auto &f) { f.name = "Replacement item"; }) ||
      !changed([](auto &f) { f.item_status = "Changed status"; }) ||
      !changed([](auto &f) { f.item_identity = "Synthetic item identity"; }) ||
      !changed([](auto &f) { f.value_kind = 2; }) ||
      !changed([](auto &f) { f.sibling_index = 1; }) ||
      !changed([](auto &f) { f.sibling_count = 3; }) ||
      !changed([](auto &f) { f.ancestors[1].runtime_id[1]++; }) ||
      !changed([](auto &f) { f.ancestors[1].pid++; }) ||
      !changed([](auto &f) { f.window++; }) ||
      !changed([](auto &f) { f.control_signature[0] = 'b'; }) ||
      !changed([](auto &f) { f.reached_root = false; }) ||
      !changed([](auto &f) { f.complete = false; }) ||
      !changed([](auto &f) { f.proxy = WindowsBackgroundProxy::kIndex; }) ||
      !changed([](auto &f) { f.proxy = WindowsBackgroundProxy::kUnknown; }) ||
      !changed([](auto &f) { f.ancestors.push_back(f.ancestors.front()); }) ||
      !changed([](auto &f) { f.ancestors.resize(18); }) ||
      !changed([](auto &f) { f.sibling_count = 5001; }) ||
      !changed([](auto &f) { f.sibling_index = f.sibling_count; })) return false;
  return true;
}
} // namespace sprint_coder::computer_use::windows_background_binding_test
