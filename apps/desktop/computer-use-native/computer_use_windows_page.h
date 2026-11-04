#pragma once
#include "computer_use_origin_classify.h"
#include "computer_use_sha256.h"

namespace sprint_coder::computer_use {

// Native-only evidence. Neither the URL nor the Document identity goes on the wire.
struct WindowsPageEvidence {
  bool web = false;
  bool complete = false;
  OriginState origin = OriginState::kUnknown;
  std::string normalized_origin, document_identity, location_digest;
};

inline bool WindowsSamePage(const WindowsPageEvidence &observed,
                            const WindowsPageEvidence &current) {
  if (!observed.web && !current.web) return true;
  return observed.web && current.web && observed.complete && current.complete &&
      !observed.normalized_origin.empty() && !observed.document_identity.empty() &&
      !observed.location_digest.empty() &&
      observed.normalized_origin == current.normalized_origin &&
      observed.document_identity == current.document_identity &&
      observed.location_digest == current.location_digest;
}

inline bool WindowsPageAllowsInput(const WindowsPageEvidence &observed,
                                   const WindowsPageEvidence &current) {
  return WindowsSamePage(observed, current) &&
      (!current.web || (observed.origin == OriginState::kOrdinary &&
                        current.origin == OriginState::kOrdinary));
}

inline std::string WindowsPageBinding(const WindowsPageEvidence &page) {
  if (!page.web) return {};
  if (!page.complete) return Sha256Hex("unreadable-page");
  std::string frame;
  for (const auto *field : {&page.normalized_origin, &page.document_identity, &page.location_digest})
    frame += std::to_string(field->size()) + ":" + *field;
  return Sha256Hex(frame);
}

} // namespace sprint_coder::computer_use
