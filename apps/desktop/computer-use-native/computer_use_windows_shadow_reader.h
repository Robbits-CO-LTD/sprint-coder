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

#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace sprint_coder::computer_use {

// The text properties of one element the shadow reads. The control type is the NAME of the type
// ("Button", "Edit", "Document", ...), produced by the source from the UIA id.
enum class ShadowUiaText : std::uint8_t { kControlType, kClassName, kName, kAutomationId, kHelpText };

// One platform call per method. A method never decides whether it may run (the reader's gate does)
// and never invents a value: "no value / unsupported" is kAbsent, an error is kFailed, a string
// longer than `maximum_bytes` (in UTF-8, after normalization) is kTooLong. Elements are opaque
// tokens owned by the source for the life of the capture.
class ShadowUiaSource {
public:
  using Element = std::uint32_t;
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
  virtual ShadowReadResult ItemPath(Element element, std::size_t maximum_bytes, std::string *path,
                                    bool *is_folder) = 0;
};

namespace windows_shadow_reader_detail {

constexpr std::size_t kSearchStringBytes = 4096; // what the v1 search reads
constexpr std::size_t kSearchMaxDepth = 16;      // the v1 search depth
constexpr std::size_t kUrlBytes = 2048;
constexpr std::size_t kPathBytes = 1024;

[[nodiscard]] inline bool IsSemanticKind(std::string_view kind) {
  return kind == "invoke" || kind == "set_text" || kind == "select" || kind == "toggle" ||
         kind == "expand_collapse";
}

} // namespace windows_shadow_reader_detail

class WindowsShadowReader {
public:
  using Element = ShadowUiaSource::Element;

  explicit WindowsShadowReader(ShadowUiaSource &source)
      : source_(source), gate_(source.NowNs()) {}

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

    if (located) {
      capture.target_found = true;
      // The window first: the page URL is read only in a web window (see CaptureChain).
      CaptureWindow(have_root, root, &capture);
      CaptureChain(target, have_root, root, &capture);
      CaptureNeighbors(&capture);
      CaptureItem(&capture);
    }
    capture.budget_exhausted = gate_.BudgetExhausted();
    return capture;
  }

private:
  // ---- The only place the source is called -------------------------------------------------
  // BEGIN gated source calls
  [[nodiscard]] bool Step() {
    return gate_.Step(source_.NowNs(), source_.ActionStillValid());
  }
  template <class Call> [[nodiscard]] ShadowReadResult Gated(Call &&call) {
    if (!Step()) return ShadowReadResult::kStopped;
    return call();
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
  ShadowReadResult ItemPath(Element element, std::size_t maximum_bytes, std::string *path,
                            bool *is_folder) {
    return Gated([&] { return source_.ItemPath(element, maximum_bytes, path, is_folder); });
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
  // kShadowMaxCaptureNodes nodes. The walk reached the root only by arriving at that window: a
  // parent that is missing or could not be read, or the cap, leaves the chain cut short.
  void CaptureChain(Element target, bool have_root, Element root, ShadowUiaCapture *capture) {
    using namespace windows_shadow_reader_detail;
    chain_elements_.clear();
    const bool web_window = windows_shadow_detail::IsWebWindowClass(*capture);
    Element current = target;
    for (std::size_t depth = 0; depth < kShadowMaxCaptureNodes; ++depth) {
      chain_elements_.push_back(current);
      capture->chain.push_back(ReadNode(current));
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
    std::string path;
    bool is_folder = false;
    // The shell is asked only about an item of the bound window: a target the walk could not trace
    // back to it (another window on top, the focus elsewhere) is not looked up.
    if (capture->chain_reached_root &&
        ShadowSettle(ItemPath(chain_elements_[index], kPathBytes, &path, &is_folder),
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
  std::vector<Element> chain_elements_;
};

} // namespace sprint_coder::computer_use
