#pragma once

// Classifier v2, S5-b-2a: the walk of the Windows shadow. The Windows helper reads UI Automation
// (computer_use_windows_uia_source.h); this header decides WHAT is read, in what order, and under
// which bounds, and turns the answers into a ShadowUiaCapture for computer_use_windows_shadow.h.
// It is portable on purpose: no platform header, no clock, no I/O. Every platform call goes through
// the `ShadowUiaSource` interface, so MSVC and clang compile it the same way and the harness runs
// the whole walk against a fake tree (cancel, budget, failed reads, oversize strings).
//
// The rules (the same as the macOS reader, see the ADR and the C2 notes):
//   * every platform call is admitted by `ShadowGate::Step` first (cancellation, then the call and
//     time budget) and, once refused, nothing more is read: a stopped capture is incomplete;
//   * every result is settled by `ShadowSettle` into a flag: a failed, over-long or stopped read can
//     never become an empty string, and "absent" (no value / unsupported) leaves no trace;
//   * it reads properties and walks the tree (parent, first child, next sibling) and nothing else:
//     no pattern is invoked, no value is written, focus is not moved, no input is sent;
//   * nothing here decides anything. The result is a capture, which `WindowsShadowClassify` turns
//     into a record that only the shadow ring keeps.
// It is not wired into the Windows host yet (S5-b-2b runs it off the serial lane).

#include "computer_use_windows_shadow.h"
#include "computer_use_origin_classify.h"
#include "computer_use_windows_page.h"

#include <cstddef>
#include <functional>
#include <array>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace sprint_coder::computer_use {

// The text properties of one element the shadow reads. The control type is the NAME of the type
// ("Button", "Edit", "Document", ...), produced by the source from the UIA id.
enum class ShadowUiaText : std::uint8_t { kControlType, kClassName, kName, kAutomationId, kHelpText };

// One platform call per method, except PageHost which admits each call through its callback.
// A method never decides whether it may run (the reader's gate does)
// and never invents a value: "no value / unsupported" is kAbsent, an error is kFailed, a string
// longer than `maximum_bytes` (in UTF-8, after normalization) is kTooLong. Elements are opaque
// tokens owned by the source for the life of the capture.
class ShadowUiaSource {
public:
  using Element = std::uint32_t;
  // "No element" (an argument that is not there).
  static constexpr Element kNoElement = 0xFFFFFFFFu;
  virtual ~ShadowUiaSource() = default;

  // Not platform reads of the target: the cancellation / validity check of the action, and the
  // monotonic clock. The reader consults both before every gated call.
  virtual bool ActionStillValid() = 0;
  virtual std::uint64_t NowNs() = 0;

  // The element of the window the session is bound to; the element at the click point; the
  // focused element.
  virtual ShadowReadResult Root(Element *output) = 0;
  virtual ShadowReadResult AtPoint(Element *output) = 0;
  virtual ShadowReadResult Focused(Element *output) = 0;
  // kAbsent: there is none (the parent of the desktop, a leaf's first child, the last sibling).
  virtual ShadowReadResult Parent(Element element, Element *output) = 0;
  virtual ShadowReadResult FirstChild(Element element, Element *output) = 0;
  virtual ShadowReadResult NextSibling(Element element, Element *output) = 0;
  virtual ShadowReadResult Same(Element first, Element second, bool *same) = 0;

  // `normalize`: NFKC, as the core expects of labels. Identifiers used only to FIND the target are
  // read as they are.
  virtual ShadowReadResult Text(Element element, ShadowUiaText what, bool normalize,
                                std::size_t maximum_bytes, std::string *output) = 0;
  virtual ShadowReadResult IsPassword(Element element, bool *is_password) = 0;
  // The URL of a Document (the page). kAbsent when the document does not publish it.
  virtual ShadowReadResult DocumentUrl(Element document, std::size_t maximum_bytes,
                                       std::string *output) = 0;
  // The executable of the process that owns the window.
  virtual ShadowReadResult WindowProcessPath(Element window, std::size_t maximum_bytes,
                                             std::string *output) = 0;
  // The executable of the process that owns the CoreWindow child of a UWP frame window.
  virtual ShadowReadResult CoreWindowProcessPath(Element window, std::size_t maximum_bytes,
                                                 std::string *output) = 0;
  // The REAL path of a shell item (its parsing / file-system path), and whether it is a folder.
  // kAbsent when the element is not a shell item or the path cannot be known.
  // `tab` is the shell tab that shows the item (an element of the walk) or kNoElement.
  virtual ShadowReadResult ItemPath(Element element, Element tab, std::size_t maximum_bytes,
                                    std::string *path, bool *is_folder) = 0;
  // The VALUE of one element, for `copy` (#785 T15-4w): its text through TextPattern when it has one
  // (bounded by `maximum_bytes`, so a whole document is never pulled in), else through ValuePattern.
  // kAbsent when the element has neither or its value is empty (a node with only a Name has no value),
  // kTooLong when the value is over the bound. Never truncated: a value cut short is not the value.
  // Not pure: only the artifact read asks for it, so a source that cannot read a value says "absent".
  virtual ShadowReadResult Value(Element element, std::size_t maximum_bytes, std::string *output) {
    (void)element;
    (void)maximum_bytes;
    (void)output;
    return ShadowReadResult::kAbsent;
  }
  // Bounded Win32 enumeration, not a UIA tree scan. Admit every platform operation.
  // Unsupported sources fail closed.
  virtual ShadowReadResult PageHost(Element window, const std::function<bool()> &admit,
                                    Element *output) {
    (void)window; (void)admit; (void)output;
    return ShadowReadResult::kFailed;
  }
  // The control signature of one element: the string the observation recorded for its target id
  // (control type, automation id, runtime id, bounds...), so the element a read is about can be
  // told from another one that carries the same id (an app that rebuilt its control). kAbsent when
  // the source cannot compute one.
  virtual ShadowReadResult ControlSignature(Element element, std::string *signature) {
    (void)element;
    (void)signature;
    return ShadowReadResult::kAbsent;
  }
  virtual ShadowReadResult TargetFrame(Element element, std::array<std::int64_t, 4> *frame) {
    (void)element;
    (void)frame;
    return ShadowReadResult::kAbsent;
  }
  // S5-c-3 PR-5: the process that provides an element (UIA_ProcessIdPropertyId) and its framework
  // (UIA_FrameworkIdPropertyId), asked only for the chain of a v2 session's capture. A source that
  // cannot read them says "absent", which the strict interlock takes over.
  virtual ShadowReadResult ProcessId(Element element, std::uint32_t *process_id) {
    (void)element;
    (void)process_id;
    return ShadowReadResult::kAbsent;
  }
  virtual ShadowReadResult FrameworkId(Element element, std::size_t maximum_bytes,
                                       std::string *output) {
    (void)element;
    (void)maximum_bytes;
    (void)output;
    return ShadowReadResult::kAbsent;
  }
};

namespace windows_shadow_reader_detail {

constexpr std::size_t kSearchStringBytes = 4096; // what the v1 search reads
constexpr std::size_t kSearchMaxDepth = 16;      // the v1 search depth
constexpr std::size_t kUrlBytes = 2048;
constexpr std::size_t kPathBytes = 1024;
constexpr std::size_t kFrameworkBytes = 64;
constexpr std::uint32_t kOriginMaxCalls = 128;
constexpr std::uint64_t kOriginDeadlineNs = 30'000'000;

[[nodiscard]] inline bool IsSemanticKind(std::string_view kind) {
  // "copy" (#785 T15-4w) finds its node exactly as the semantic actions do: by the target id.
  return kind == "invoke" || kind == "set_text" || kind == "select" || kind == "toggle" ||
         kind == "expand_collapse" || kind == "copy";
}

} // namespace windows_shadow_reader_detail

class WindowsShadowReader {
public:
  using Element = ShadowUiaSource::Element;

  explicit WindowsShadowReader(ShadowUiaSource &source)
      : source_(source), gate_(source.NowNs()) {}

  // S5-c-3 PR-5: also read who provides each element of the chain (its process and framework).
  // Only a v2 session's interlock asks for it; every other capture makes the calls it made before.
  void ReadChainIdentity(bool read) { read_chain_identity_ = read; }

  // A page read is independent of focus and of the action target. Only the unique visible page host
  // and its RootWebArea Document qualify; page content is not traversed.
  [[nodiscard]] WindowsPageEvidence ReadPage() {
    WindowsPageEvidence page;
    BeginOrigin();
    Element root = 0;
    bool failed = false;
    ShadowUiaCapture window;
    if (ShadowSettle(Root(&root), &failed)) CaptureWindow(true, root, &window);
    page.web = windows_shadow_detail::IsPageBindableBrowser(window);
    if (page.web) {
      Element document = 0;
      std::string url, identity, repeated_url, repeated_identity;
      if (FindPageDocument(root, &document) &&
          ShadowSettle(DocumentUrl(document, windows_shadow_reader_detail::kUrlBytes, &url), &failed) &&
          ShadowSettle(ControlSignature(document, &identity), &failed) &&
          ShadowSettle(DocumentUrl(document, windows_shadow_reader_detail::kUrlBytes, &repeated_url), &failed) &&
          ShadowSettle(ControlSignature(document, &repeated_identity), &failed) &&
          !url.empty() && !identity.empty() && url == repeated_url && identity == repeated_identity &&
          PageDocumentStillCurrent(root, document)) {
        const auto classified = ClassifyPageOrigin(url);
        page.origin = classified.state;
        page.normalized_origin = classified.normalized_origin;
        page.document_identity = std::move(identity);
        page.location_digest = Sha256Hex(url);
        page.complete = !page.normalized_origin.empty();
      }
    }
    const bool within = OriginWithinBudget();
    EndOrigin();
    if (!within || failed || window.read_failed || gate_.Stopped()) {
      const bool web = page.web;
      page = {};
      page.web = web;
    }
    return page;
  }

  // Input-time metadata only: the caller already bound this window to a browser page.
  // Resolve its current Document from that window, never from the foreground focus.
  [[nodiscard]] bool RecheckPage(const WindowsPageEvidence &observed) {
    if (!observed.web) return true;
    BeginOrigin();
    Element root = 0, document = 0;
    bool failed = false;
    std::string url, identity;
    auto current = observed;
    current.complete = ShadowSettle(Root(&root), &failed) &&
        FindPageDocument(root, &document) &&
        ShadowSettle(ControlSignature(document, &identity), &failed) &&
        ShadowSettle(DocumentUrl(document, windows_shadow_reader_detail::kUrlBytes, &url), &failed) &&
        PageDocumentStillCurrent(root, document);
    current.document_identity = std::move(identity);
    current.location_digest = url.empty() ? std::string{} : Sha256Hex(url);
    const bool within = OriginWithinBudget();
    EndOrigin();
    return within && !failed && !gate_.Stopped() && WindowsPageAllowsInput(observed, current);
  }

  // The action was canceled (or stopped being valid) during the capture: the caller records a
  // skipped capture rather than a classification.
  [[nodiscard]] bool Canceled() const { return gate_.Canceled(); }
  [[nodiscard]] const ShadowGate &Gate() const { return gate_; }

  // The target of the request and what is read around it. `kind` and `target_id` are the request's.
  [[nodiscard]] ShadowUiaCapture Capture(std::string_view kind, std::string_view target_id) {
    using namespace windows_shadow_reader_detail;
    ShadowUiaCapture capture;
    Element root = 0;
    const bool have_root = ShadowSettle(Root(&root), &capture.read_failed);

    Element target = 0;
    bool located = false;
    bool locate_failed = false;
    if (IsSemanticKind(kind)) {
      if (have_root) {
        int matches = 0;
        Element found = 0;
        Search(root, target_id, 0, &matches, &found, &locate_failed);
        located = matches == 1 && !locate_failed;
        target = found;
      }
    } else if (kind == "click" || kind == "scroll") {
      located = ShadowSettle(AtPoint(&target), &locate_failed);
    } else if (kind == "type" || kind == "key") {
      located = ShadowSettle(Focused(&target), &locate_failed);
    }
    // A lookup that failed or was cut off is a read gap, not "the target was not there".
    if (locate_failed) capture.read_failed = true;

    has_target_ = located;
    target_element_ = located ? target : 0;
    if (located) {
      capture.target_found = true;
      // The window first: the page URL is read only in a web window (see CaptureChain).
      CaptureWindow(have_root, root, &capture);
      CaptureChain(target, have_root, root, &capture);
      CaptureNeighbors(&capture);
      CaptureItem(&capture);
    }
    Finish();
    capture.budget_exhausted = gate_.BudgetExhausted();
    if (located && have_root && !gate_.Stopped()) {
      BeginOrigin();
      CapturePageOrigin(root, &capture);
      EndOrigin();
    }
    if (gate_.Stopped()) capture.page_origin = OriginState::kUnknown;
    return capture;
  }

  // The value of the node the last Capture found (#785 T15-4w), through the same gate as every
  // other read: a canceled or out-of-budget capture reads nothing. kFailed when there was no target.
  // After the read the capture is over: a cancel or a deadline passed during it is reported by
  // Canceled() / Gate(), and the caller must not use a value then.
  // The control signature of the node the last Capture located (same gate). kFailed without a target.
  [[nodiscard]] ShadowReadResult ReadTargetSignature(std::string *signature) {
    if (!has_target_) return ShadowReadResult::kFailed;
    return ControlSignature(target_element_, signature);
  }
  [[nodiscard]] ShadowReadResult ReadTargetFrame(std::array<std::int64_t, 4> *frame) {
    if (!has_target_) return ShadowReadResult::kFailed;
    const auto result = TargetFrame(target_element_, frame);
    Finish();
    return result;
  }

  [[nodiscard]] ShadowReadResult ReadTargetValue(std::size_t maximum_bytes, std::string *output) {
    if (!has_target_) return ShadowReadResult::kFailed;
    const ShadowReadResult result = Value(target_element_, maximum_bytes, output);
    Finish();
    return result;
  }

private:
  // ---- The only place the source is called -------------------------------------------------
  // BEGIN gated source calls
  [[nodiscard]] bool Step() {
    if (reading_origin_) {
      if (!OriginWithinBudget() || origin_calls_ >= windows_shadow_reader_detail::kOriginMaxCalls) {
        origin_stopped_ = true;
        return false;
      }
      ++origin_calls_;
      return true;
    }
    return gate_.Step(source_.NowNs() - origin_elapsed_ns_, source_.ActionStillValid());
  }
  bool OriginWithinBudget() {
    if (origin_stopped_) return false;
    if (!source_.ActionStillValid() ||
        source_.NowNs() - origin_start_ns_ > windows_shadow_reader_detail::kOriginDeadlineNs)
      origin_stopped_ = true;
    return !origin_stopped_;
  }
  void BeginOrigin() {
    reading_origin_ = true;
    origin_stopped_ = false;
    origin_calls_ = 0;
    origin_start_ns_ = source_.NowNs();
  }
  void EndOrigin() {
    // Metadata time must not consume the legacy budget, including subsequent target reads.
    origin_elapsed_ns_ += source_.NowNs() - origin_start_ns_;
    reading_origin_ = false;
    Finish(); // Cancellation still stops the action; an origin deadline does not.
  }
  template <class Call> [[nodiscard]] ShadowReadResult Gated(Call &&call) {
    if (!Step()) return ShadowReadResult::kStopped;
    return call();
  }
  ShadowReadResult TargetFrame(Element element, std::array<std::int64_t, 4> *frame) {
    return Gated([&] { return source_.TargetFrame(element, frame); });
  }
  ShadowReadResult PageHost(Element root, Element *output) {
    return source_.PageHost(root, [&] { return Step(); }, output);
  }
  ShadowReadResult Root(Element *output) {
    return Gated([&] { return source_.Root(output); });
  }
  ShadowReadResult AtPoint(Element *output) {
    return Gated([&] { return source_.AtPoint(output); });
  }
  ShadowReadResult Focused(Element *output) {
    return Gated([&] { return source_.Focused(output); });
  }
  ShadowReadResult Parent(Element element, Element *output) {
    return Gated([&] { return source_.Parent(element, output); });
  }
  ShadowReadResult FirstChild(Element element, Element *output) {
    return Gated([&] { return source_.FirstChild(element, output); });
  }
  ShadowReadResult NextSibling(Element element, Element *output) {
    return Gated([&] { return source_.NextSibling(element, output); });
  }
  ShadowReadResult Same(Element first, Element second, bool *same) {
    return Gated([&] { return source_.Same(first, second, same); });
  }
  ShadowReadResult Text(Element element, ShadowUiaText what, bool normalize,
                        std::size_t maximum_bytes, std::string *output) {
    return Gated([&] { return source_.Text(element, what, normalize, maximum_bytes, output); });
  }
  ShadowReadResult IsPassword(Element element, bool *is_password) {
    return Gated([&] { return source_.IsPassword(element, is_password); });
  }
  ShadowReadResult DocumentUrl(Element document, std::size_t maximum_bytes, std::string *output) {
    return Gated([&] { return source_.DocumentUrl(document, maximum_bytes, output); });
  }
  ShadowReadResult WindowProcessPath(Element window, std::size_t maximum_bytes,
                                     std::string *output) {
    return Gated([&] { return source_.WindowProcessPath(window, maximum_bytes, output); });
  }
  ShadowReadResult CoreWindowProcessPath(Element window, std::size_t maximum_bytes,
                                         std::string *output) {
    return Gated([&] { return source_.CoreWindowProcessPath(window, maximum_bytes, output); });
  }
  ShadowReadResult ItemPath(Element element, Element tab, std::size_t maximum_bytes, std::string *path,
                            bool *is_folder) {
    return Gated([&] { return source_.ItemPath(element, tab, maximum_bytes, path, is_folder); });
  }
  ShadowReadResult Value(Element element, std::size_t maximum_bytes, std::string *output) {
    return Gated([&] { return source_.Value(element, maximum_bytes, output); });
  }
  ShadowReadResult ControlSignature(Element element, std::string *signature) {
    return Gated([&] { return source_.ControlSignature(element, signature); });
  }
  ShadowReadResult ProcessId(Element element, std::uint32_t *process_id) {
    return Gated([&] { return source_.ProcessId(element, process_id); });
  }
  ShadowReadResult FrameworkId(Element element, std::size_t maximum_bytes, std::string *output) {
    return Gated([&] { return source_.FrameworkId(element, maximum_bytes, output); });
  }
  // The capture is over: a cancel, or a deadline passed during the last call, makes it incomplete.
  void Finish() {
    (void)gate_.Finish(source_.NowNs() - origin_elapsed_ns_, source_.ActionStillValid());
  }
  // END gated source calls

  // The node's properties. The password flag is read for every node: a failed read is an
  // incomplete node (never "not a password").
  [[nodiscard]] ShadowUiaNode ReadNode(Element element) {
    ShadowUiaNode node;
    const auto read = [&](ShadowUiaText what, std::string *output) {
      ShadowSettle(Text(element, what, true, kEffectMaxLabelBytes, output), &node.read_failed,
                   &node.oversize);
    };
    read(ShadowUiaText::kControlType, &node.control_type);
    read(ShadowUiaText::kClassName, &node.class_name);
    read(ShadowUiaText::kName, &node.name);
    read(ShadowUiaText::kAutomationId, &node.automation_id);
    read(ShadowUiaText::kHelpText, &node.help_text);
    bool password = false;
    if (ShadowSettle(IsPassword(element, &password), &node.read_failed)) node.is_password = password;
    return node;
  }

  // A bounded walk matching what v1 matches (an automation id equal to the target id, or, when the
  // element has none, its name). Two matches are none. A node or a child list that could not be
  // read makes the whole search incomplete: "exactly one match" proves nothing then.
  void Search(Element element, std::string_view target_id, std::size_t depth, int *matches,
              Element *found, bool *incomplete) {
    using namespace windows_shadow_reader_detail;
    if (*matches > 1) return;
    // Below the depth bound nothing was looked at, so "exactly one match" proves nothing: like V1's
    // search, a cut-off is a failed search, not a smaller tree.
    if (depth > kSearchMaxDepth) {
      *incomplete = true;
      return;
    }
    std::string automation_id;
    ShadowSettle(Text(element, ShadowUiaText::kAutomationId, false, kSearchStringBytes,
                      &automation_id),
                 incomplete);
    bool matched = !automation_id.empty() && automation_id == target_id;
    if (!matched && automation_id.empty()) {
      std::string name;
      ShadowSettle(Text(element, ShadowUiaText::kName, false, kSearchStringBytes, &name),
                   incomplete);
      matched = name == target_id;
    }
    // A match is counted and the walk goes on below it, like v1: a second match anywhere is none.
    if (matched) {
      if (*matches == 0) *found = element;
      ++*matches;
    }
    Element child = 0;
    ShadowReadResult step = FirstChild(element, &child);
    while (step == ShadowReadResult::kOk && *matches <= 1) {
      Search(child, target_id, depth + 1, matches, found, incomplete);
      if (gate_.Stopped()) break;
      Element next = 0;
      step = NextSibling(child, &next);
      child = next;
    }
    // A child list that failed, or a search cut off by cancel / budget, is incomplete.
    if (step == ShadowReadResult::kFailed || step == ShadowReadResult::kStopped ||
        step == ShadowReadResult::kTooLong || gate_.Stopped())
      *incomplete = true;
  }

  // The target and its parents up to the window the session is bound to, at most
  // kShadowMaxCaptureNodesWindows nodes. The walk reached the root only by arriving at that window: a
  // parent that is missing or could not be read, or the cap, leaves the chain cut short.
  void CaptureChain(Element target, bool have_root, Element root, ShadowUiaCapture *capture) {
    using namespace windows_shadow_reader_detail;
    chain_elements_.clear();
    const bool web_window = windows_shadow_detail::IsWebWindowClass(*capture);
    Element current = target;
    for (std::size_t depth = 0; depth < kShadowMaxCaptureNodesWindows; ++depth) {
      chain_elements_.push_back(current);
      capture->chain.push_back(ReadNode(current));
      if (read_chain_identity_) {
        ShadowUiaNode &read = capture->chain.back();
        std::uint32_t process_id = 0;
        // A process id that is absent, failed or zero stays 0 (not read): never "the same process".
        if (ShadowSettle(ProcessId(current, &process_id), &read.read_failed))
          read.process_id = process_id;
        std::string framework;
        if (ShadowSettle(FrameworkId(current, kFrameworkBytes, &framework), &read.read_failed)) {
          read.framework_read = true;
          read.framework_id = std::move(framework);
        }
      }
      const ShadowUiaNode &node = capture->chain.back();
      // The value of a Document is the address of the page only in a browser: in an editor it is
      // the text of the document, which is not read.
      if (web_window && !capture->document_url_read &&
          windows_shadow_detail::Lowercase(shadow_detail::CompatFold(node.control_type)) ==
              "document") {
        std::string url;
        if (ShadowSettle(DocumentUrl(current, kUrlBytes, &url), &capture->read_failed)) {
          capture->document_url_read = true;
          capture->document_url = std::move(url);
        }
      }
      if (have_root) {
        bool same = false;
        // Not comparable (absent, failed or stopped): the chain is cut short here.
        if (!ShadowSettle(Same(current, root, &same), &capture->read_failed)) return;
        if (same) {
          capture->chain_reached_root = true;
          return;
        }
      }
      Element parent = 0;
      if (!ShadowSettle(Parent(current, &parent), &capture->read_failed)) return;
      current = parent;
    }
  }

  bool FindPageDocument(Element root, Element *document) {
    using namespace windows_shadow_reader_detail;
    Element host = 0, child = 0;
    bool failed = false;
    if (!ShadowSettle(PageHost(root, &host), &failed)) return false;
    Element ancestor = host;
    bool in_contents = false;
    for (unsigned depth = 0; depth < 3; ++depth) {
      Element parent = 0;
      std::string type, name;
      if (!ShadowSettle(Parent(ancestor, &parent), &failed) ||
          !ShadowSettle(Text(parent, ShadowUiaText::kControlType, false, kFrameworkBytes, &type), &failed) ||
          !ShadowSettle(Text(parent, ShadowUiaText::kClassName, false, kSearchStringBytes, &name), &failed))
        return false;
      if (type == "Pane" && name == "MultiContentsView") { in_contents = true; break; }
      ancestor = parent;
    }
    if (!in_contents) return false;
    int count = 0;
    auto step = FirstChild(host, &child);
    while (step == ShadowReadResult::kOk) {
      std::string type, id;
      Element parent = 0;
      bool same = false;
      if (!ShadowSettle(Parent(child, &parent), &failed) ||
          !ShadowSettle(Same(parent, host, &same), &failed) || !same ||
          !ShadowSettle(Text(child, ShadowUiaText::kControlType, false, kFrameworkBytes, &type),
                        &failed)) return false;
      ShadowSettle(Text(child, ShadowUiaText::kAutomationId, false, kSearchStringBytes, &id), &failed);
      if (failed) return false;
      if (type == "Document" && id == "RootWebArea") {
        *document = child;
        if (++count > 1) return false;
      }
      Element next = 0;
      step = NextSibling(child, &next);
      child = next;
    }
    return step == ShadowReadResult::kAbsent && count == 1 && OriginWithinBudget();
  }

  bool PageDocumentStillCurrent(Element root, Element expected) {
    Element document = 0;
    bool failed = false, same = false;
    return FindPageDocument(root, &document) &&
        ShadowSettle(Same(document, expected, &same), &failed) && same;
  }

  // Separate from the legacy URL/surface path: this state grants nothing. Both page paths
  // use the same supported browser predicate and unique visible Win32 page host.
  void CapturePageOrigin(Element root, ShadowUiaCapture *capture) {
    using namespace windows_shadow_reader_detail;
    if (!capture->chain_reached_root || capture->read_failed ||
        capture->chain.size() > kEffectMaxChainNodesWindows ||
        !windows_shadow_detail::IsPageBindableBrowser(*capture)) return;
    Element expected = ShadowUiaSource::kNoElement;
    for (std::size_t i = 0; i < capture->chain.size(); ++i) {
      const auto &node = capture->chain[i];
      if (node.read_failed || node.oversize) return;
      std::string id;
      bool failed = false;
      ShadowSettle(Text(chain_elements_[i], ShadowUiaText::kAutomationId, false,
                        kSearchStringBytes, &id), &failed);
      if (failed) return;
      // The first web root is the target's frame, regardless of Document/Group role.
      if (id == "RootWebArea") {
        expected = chain_elements_[i];
        break;
      }
      // An iframe host can be the hit-test target while its web root is unavailable.
      if (node.control_type == "Document") return;
    }
    if (expected == ShadowUiaSource::kNoElement) return;
    Element document = 0;
    if (!FindPageDocument(root, &document)) return;
    bool failed = false;
    bool same = false;
    if (!ShadowSettle(Same(document, expected, &same), &failed) || !same) return;
    std::string url;
    if (!ShadowSettle(DocumentUrl(document, kUrlBytes, &url), &failed) || url.empty()) return;
    std::string repeated_url;
    if (!ShadowSettle(DocumentUrl(document, kUrlBytes, &repeated_url), &failed) ||
        url != repeated_url || !capture->document_url_read || url != capture->document_url ||
        !PageDocumentStillCurrent(root, document)) return;
    // Recheck the target's entire captured ancestry after the value read (a page may detach).
    for (std::size_t i = 0; i + 1 < chain_elements_.size(); ++i) {
      Element parent = 0;
      same = false;
      if (!ShadowSettle(Parent(chain_elements_[i], &parent), &failed) ||
          !ShadowSettle(Same(parent, chain_elements_[i + 1], &same), &failed) || !same) return;
    }
    if (OriginWithinBudget()) capture->page_origin = ClassifyPageOrigin(url).state;
  }

  // The other children of the target's parent, for the captions a page puts beside a field.
  void CaptureNeighbors(ShadowUiaCapture *capture) {
    capture->neighbors_complete = false;
    if (chain_elements_.size() < 2) return; // the parent was not read
    const Element target = chain_elements_.front();
    const Element parent = chain_elements_[1];
    Element child = 0;
    ShadowReadResult step = FirstChild(parent, &child);
    bool complete = true;
    bool ran_out_of_siblings = true;
    while (step == ShadowReadResult::kOk) {
      bool same = false;
      if (!ShadowSettle(Same(child, target, &same), &capture->read_failed)) {
        complete = false;
        ran_out_of_siblings = false;
        break;
      }
      if (!same) {
        if (capture->neighbors.size() >= kEffectMaxNeighborLabels) {
          complete = false;
          ran_out_of_siblings = false;
          break;
        }
        capture->neighbors.push_back(ReadNode(child));
      }
      Element next = 0;
      step = NextSibling(child, &next);
      child = next;
    }
    // The list ended by itself only on "no more siblings"; a failed or stopped step means not
    // every sibling was seen.
    if (ran_out_of_siblings && step != ShadowReadResult::kAbsent) {
      ShadowSettle(step, &capture->read_failed);
      complete = false;
    }
    capture->neighbors_complete = complete;
  }

  // The window the target is in, and the process that owns it. A UWP frame window is judged by the
  // process that owns its CoreWindow, read only for such a window.
  void CaptureWindow(bool have_root, Element root, ShadowUiaCapture *capture) {
    using namespace windows_shadow_reader_detail;
    if (!have_root) return;
    std::string window_class;
    if (ShadowSettle(Text(root, ShadowUiaText::kClassName, true, kEffectMaxLabelBytes, &window_class),
                     &capture->read_failed)) {
      capture->window_class_read = true;
      capture->window_class = std::move(window_class);
    }
    std::string process;
    if (ShadowSettle(WindowProcessPath(root, kPathBytes, &process), &capture->read_failed)) {
      capture->process_path_read = true;
      capture->process_path = std::move(process);
    }
    const std::string lowered_class =
        capture->window_class_read
            ? windows_shadow_detail::Lowercase(shadow_detail::CompatFold(capture->window_class))
            : std::string();
    const std::string lowered_process =
        capture->process_path_read
            ? windows_shadow_detail::Lowercase(shadow_detail::CompatFold(
                  windows_shadow_detail::BaseName(capture->process_path)))
            : std::string();
    if (lowered_class == "applicationframewindow" || lowered_process == "applicationframehost.exe") {
      std::string core;
      if (ShadowSettle(CoreWindowProcessPath(root, kPathBytes, &core), &capture->read_failed)) {
        capture->core_window_process_read = true;
        capture->core_window_process_path = std::move(core);
      }
    }
  }

  // The item the action would open: a list item of a file browser. A click lands on the item or on
  // one of its cells (a column of the details view is an Edit under the ListItem), so the item is
  // the nearest ListItem / DataItem among the target and its two parents. Its REAL path (the shell
  // item's file-system path) is read; without it the name is only a display name, which never gives
  // an extension. Folders open by browsing.
  void CaptureItem(ShadowUiaCapture *capture) {
    using namespace windows_shadow_reader_detail;
    constexpr std::size_t kItemSearchDepth = 3;
    std::size_t index = capture->chain.size();
    for (std::size_t at = 0; at < capture->chain.size() && at < kItemSearchDepth; ++at) {
      const std::string control = windows_shadow_detail::Lowercase(
          shadow_detail::CompatFold(capture->chain[at].control_type));
      if (control == "listitem" || control == "dataitem") {
        index = at;
        break;
      }
    }
    if (index >= capture->chain.size() || index >= chain_elements_.size()) return;
    if (windows_shadow_detail::SurfaceForWindow(*capture).kind != SurfaceKind::kFileBrowser) return;
    capture->item_kind = ShadowItemKind::kFile;
    // The shell tab that shows the item is its nearest ShellTabWindowClass ancestor in the walk.
    Element tab = ShadowUiaSource::kNoElement;
    // Whether the ListItem sits in the shell's ITEM VIEW (a SHELLDLL_DefView or its UIItemsView) between
    // itself and that tab: a list in the preview pane or a search suggestion is a ListItem too, but its
    // name is not an item of the folder the view shows, so the shell is not asked about it.
    bool in_item_view = false;
    for (std::size_t at = index; at < capture->chain.size() && at < chain_elements_.size(); ++at) {
      const std::string class_name =
          windows_shadow_detail::Lowercase(shadow_detail::CompatFold(capture->chain[at].class_name));
      if (class_name == "shelltabwindowclass") {
        tab = chain_elements_[at];
        break;
      }
      if (class_name == "shelldll_defview" || class_name == "uiitemsview") in_item_view = true;
    }
    std::string path;
    bool is_folder = false;
    // The shell is asked only about an item of the bound window: a target the walk could not trace
    // back to it (another window on top, the focus elsewhere) is not looked up.
    if (capture->chain_reached_root && in_item_view &&
        ShadowSettle(ItemPath(chain_elements_[index], tab, kPathBytes, &path, &is_folder),
                     &capture->read_failed)) {
      capture->item_name_read = true;
      capture->item_name_is_real_path = true;
      capture->item_name = std::move(path);
      if (is_folder) capture->item_kind = ShadowItemKind::kFolder;
      return;
    }
    // Only the display name is known.
    capture->item_name_read = !capture->chain[index].name.empty();
    capture->item_name_is_real_path = false;
    capture->item_name = capture->chain[index].name;
  }

  ShadowUiaSource &source_;
  ShadowGate gate_;
  bool reading_origin_ = false;
  bool origin_stopped_ = false;
  std::uint32_t origin_calls_ = 0;
  std::uint64_t origin_start_ns_ = 0;
  std::uint64_t origin_elapsed_ns_ = 0;
  // The node the last Capture located, for ReadTargetValue.
  bool has_target_ = false;
  Element target_element_ = 0;
  bool read_chain_identity_ = false;
  std::vector<Element> chain_elements_;
};

} // namespace sprint_coder::computer_use
