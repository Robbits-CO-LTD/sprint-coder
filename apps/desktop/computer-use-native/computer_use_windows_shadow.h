#pragma once

// Classifier v2, S5-b-1: the portable half of the Windows shadow. UI Automation is read by the
// Windows helper (S5-b-2); this header only turns what it read (plain strings and flags, no
// Windows types) into the facts the shared shadow and the portable classifier core want. It
// decides nothing and reads nothing: no process, no clock, no filesystem, no UI Automation, and no
// platform header, so MSVC (/W4 /sdl) and clang compile it the same way.
//
// What it adds to the shared shadow header (computer_use_effect_shadow.h):
//   * the UIA node and capture structures (control type, class name, name, automation id, help
//     text, password flag), and how they map onto the facts: the control type is the role, a
//     password control is a secure text field, the Document control is the page;
//   * the surface of a Windows window (console windows, terminals, command launchers, Explorer,
//     the download page, and the OS prompts that are not classified here);
//   * the item an action would open (a file name, its extension, a folder that opens by browsing).
//
// A fact that is missing is a gap with its own bit, never an empty string: an unreadable window
// class or process path is not "an ordinary window".

#include "computer_use_effect_shadow.h"

#include <cstddef>
#include <cstdint>
#include <iterator>
#include <string>
#include <string_view>
#include <vector>

namespace sprint_coder::computer_use {

// The window or process belongs to an OS prompt or an OS settings app (UAC consent, the credential
// dialogs, the Windows Security and Settings apps). It is not classified here: the surface is
// "unknown", which is a takeover, and the refusal of such windows is a later step (S5-c). A UWP
// app's top-level window is an ApplicationFrameWindow owned by ApplicationFrameHost.exe, so it is
// judged by the process that owns its CoreWindow child; when that cannot be read it is unknown too.
constexpr std::uint32_t kShadowGapOsPromptSurface = 1u << 14;
static_assert((kShadowGapOsPromptSurface & ((1u << 14) - 1u)) == 0,
              "the Windows gap bit must not overlap a shared gap bit");

// One UI Automation element as read. An absent or unreadable property is empty.
struct ShadowUiaNode {
  // The control type by name ("Button", "Edit", "Document", "Window", "Pane", ...).
  std::string control_type;
  std::string class_name;
  std::string name;
  std::string automation_id;
  std::string help_text;
  // Only ever filled for static text (a form caption), never for an editable control.
  std::string value;
  // UIA_IsPasswordPropertyId.
  bool is_password = false;
  // A property was longer than the core accepts (kEffectMaxLabelBytes in UTF-8): it was not read.
  bool oversize = false;
  // A property failed to read for a reason other than "no value" / "unsupported".
  bool read_failed = false;
};

enum class ShadowItemKind : std::uint8_t { kNone, kFile, kFolder };

struct ShadowUiaCapture {
  bool target_found = false;
  // [0] is the target, then its parents, at most kShadowMaxCaptureNodes. It ends at the top-level
  // window.
  std::vector<ShadowUiaNode> chain;
  // The walk arrived at the top-level window. A missing or unreadable parent, or the cap, leaves
  // this false: the chain is cut short.
  bool chain_reached_root = false;
  // The other children of the target's parent.
  std::vector<ShadowUiaNode> neighbors;
  bool neighbors_complete = false;
  // The window the target is in, and the process that owns it.
  bool window_class_read = false;
  std::string window_class;
  bool process_path_read = false;
  std::string process_path;
  // A UWP window is hosted by ApplicationFrameHost.exe; the app is the process that owns its
  // CoreWindow child. Read only for such a window.
  bool core_window_process_read = false;
  std::string core_window_process_path;
  // The item the action would open (an Explorer list item, a download row).
  // CONTRACT: an extension is known only when `item_name` is the REAL file name or path of the item
  // (`item_name_is_real_path`, e.g. the shell item's parsing name), never a display name. Explorer
  // hides known extensions, and always hides .lnk / .url / .pif / .scf, so "invoice.pdf" may be
  // "invoice.pdf.exe" and "readme.txt" may be "readme.txt.lnk". A display name alone gives an unknown
  // extension (kShadowGapExtensionUnknown).
  ShadowItemKind item_kind = ShadowItemKind::kNone;
  bool item_name_read = false;
  bool item_name_is_real_path = false;
  std::string item_name;
  // The URL of the page (the Document in the chain), when there is one and it could be read.
  bool document_url_read = false;
  std::string document_url;
  // The call or time budget ran out, or a property of the target failed to read.
  bool budget_exhausted = false;
  bool read_failed = false;
};

namespace windows_shadow_detail {

using shadow_detail::CompatFold;
using shadow_detail::Lowercase;

[[nodiscard]] inline std::string_view BaseName(std::string_view path) {
  const std::size_t separator = path.find_last_of("\\/");
  return separator == std::string_view::npos ? path : path.substr(separator + 1);
}

[[nodiscard]] inline bool OneOf(std::string_view value, const std::string_view *names,
                                std::size_t count) {
  for (std::size_t index = 0; index < count; ++index)
    if (value == names[index]) return true;
  return false;
}

// What kind of surface a window is. `read_failed` when neither the class nor the path could be
// read, which the caller turns into a gap (and an unknown surface).
struct WindowSurface {
  SurfaceKind kind = SurfaceKind::kOrdinary;
  std::uint32_t gaps = 0;
};

// A browser or Electron window: everything inside is a page the page's author wrote, with or
// without a Document node in the chain.
[[nodiscard]] inline bool IsWebWindowClass(const ShadowUiaCapture &capture) {
  if (!capture.window_class_read) return false;
  const std::string name = Lowercase(CompatFold(capture.window_class));
  return name.rfind("chrome_widgetwin_", 0) == 0 || name == "mozillawindowclass";
}

// Whether the node at `index` is in a page: in a web window, or at or below a Document.
[[nodiscard]] inline bool NodeInPage(const ShadowUiaCapture &capture, std::size_t index) {
  if (IsWebWindowClass(capture)) return true;
  for (std::size_t above = index; above < capture.chain.size(); ++above)
    if (Lowercase(CompatFold(capture.chain[above].control_type)) == "document") return true;
  return false;
}

// A class name among `names` on a node of the chain. A node in a page is not looked at: its class
// name is the page's string (it could only tighten a surface, but a page is not trusted to say what
// the window around it is).
[[nodiscard]] inline bool ClassIsOneOf(const ShadowUiaCapture &capture, const std::string_view *names,
                                   std::size_t count) {
  for (std::size_t index = 0; index < capture.chain.size(); ++index) {
    if (NodeInPage(capture, index)) continue;
    if (OneOf(Lowercase(CompatFold(capture.chain[index].class_name)), names, count)) return true;
  }
  return false;
}

// The surface of the window around the target. The window class and the owning process name it
// (never the title); the class names of ancestors tighten it (a shell view is a file browser, an
// address band is a command entry). Whatever could not be measured is unknown, never ordinary.
[[nodiscard]] inline WindowSurface SurfaceForWindowOnce(const ShadowUiaCapture &capture) {
  WindowSurface result;
  if (!capture.window_class_read && !capture.process_path_read) {
    result.kind = SurfaceKind::kUnknown;
    result.gaps |= kShadowGapReadFailed;
    return result;
  }
  const std::string window_class =
      capture.window_class_read ? Lowercase(CompatFold(capture.window_class)) : std::string();
  std::string process = capture.process_path_read
                            ? Lowercase(CompatFold(BaseName(capture.process_path)))
                            : std::string();
  // A UWP window: the app is whoever owns the CoreWindow child. If that is not known, nothing is.
  if (window_class == "applicationframewindow" || process == "applicationframehost.exe") {
    if (!capture.core_window_process_read || capture.core_window_process_path.empty()) {
      result.kind = SurfaceKind::kUnknown;
      result.gaps |= kShadowGapReadFailed | kShadowGapOsPromptSurface;
      return result;
    }
    process = Lowercase(CompatFold(BaseName(capture.core_window_process_path)));
  }
  // OS prompts and OS settings first: they win over everything, and are not classified here.
  static constexpr std::string_view kPromptProcesses[] = {
      "consent.exe",        "credentialuibroker.exe", "credentialenrollmentmanager.exe",
      "windowsdefender.exe", "securityhealthsystray.exe", "sechealthui.exe", "systemsettings.exe",
      "logonui.exe",        "winlogon.exe"};
  static constexpr std::string_view kPromptClasses[] = {
      "credential dialog xaml host", "$$$secure uap dummy window class for interop"};
  if (OneOf(process, kPromptProcesses, std::size(kPromptProcesses)) ||
      OneOf(window_class, kPromptClasses, std::size(kPromptClasses))) {
    result.kind = SurfaceKind::kUnknown;
    result.gaps |= kShadowGapOsPromptSurface;
    return result;
  }
  static constexpr std::string_view kConsoleClasses[] = {
      "consolewindowclass", "pseudoconsolewindow", "cascadia_hosting_window_class", "mintty",
      "putty", "virtualconsoleclass", "org.wezfurlong.wezterm"};
  static constexpr std::string_view kShellProcesses[] = {
      "cmd.exe", "powershell.exe", "pwsh.exe", "wt.exe", "windowsterminal.exe", "conhost.exe",
      "openconsole.exe", "bash.exe", "wsl.exe", "wslhost.exe", "putty.exe", "mintty.exe",
      "alacritty.exe", "wezterm-gui.exe", "conemu64.exe", "conemu.exe"};
  if (OneOf(window_class, kConsoleClasses, std::size(kConsoleClasses)) ||
      OneOf(process, kShellProcesses, std::size(kShellProcesses))) {
    result.kind = SurfaceKind::kShellLike;
    return result;
  }
  static constexpr std::string_view kScriptProcesses[] = {"powershell_ise.exe", "wscript.exe",
                                                          "cscript.exe", "mshta.exe"};
  if (OneOf(process, kScriptProcesses, std::size(kScriptProcesses))) {
    result.kind = SurfaceKind::kScriptInput;
    return result;
  }
  // Command entries: launchers, the Task Manager (its "Run new task" starts any program), and the
  // Run dialog, which is a #32770 dialog owned by explorer.exe.
  static constexpr std::string_view kPaletteProcesses[] = {
      "powertoys.powerlauncher.exe", "flow.launcher.exe", "searchhost.exe", "searchapp.exe",
      "keypirinha.exe", "wox.exe", "ueli.exe", "taskmgr.exe"};
  if (OneOf(process, kPaletteProcesses, std::size(kPaletteProcesses)) ||
      (process == "explorer.exe" && window_class == "#32770")) {
    result.kind = SurfaceKind::kCommandPalette;
    return result;
  }
  // The address bar of Explorer runs programs too (a typed path or command line).
  static constexpr std::string_view kAddressClasses[] = {"address band root", "breadcrumb parent"};
  if (ClassIsOneOf(capture, kAddressClasses, std::size(kAddressClasses))) {
    result.kind = SurfaceKind::kCommandPalette;
    return result;
  }
  // A file browser by its name, or by its structure: any window that hosts a shell view (Explorer,
  // the common file dialogs, other file managers built on the shell) lists items that open. The
  // classes are the ones measured on Windows 11 (build 26200) as well as the older ones.
  static constexpr std::string_view kExplorerClasses[] = {"cabinetwclass", "explorewclass",
                                                          "progman", "workerw", "shell_traywnd"};
  static constexpr std::string_view kShellViewClasses[] = {
      "shelldll_defview", "directuihwnd", "duilistview", "duiviewwndclassname", "uiitemsview",
      "hwndview"};
  // Windows 11 builds the Explorer address bar (and its search box) in XAML: an AutoSuggestBox, no
  // Address Band Root. A text box in an Explorer window that is not inside a shell view (a rename
  // inside the list is) is a command entry as well, since the address bar runs programs.
  const bool explorer_window = process == "explorer.exe" || window_class == "cabinetwclass" ||
                               window_class == "explorewclass";
  if (explorer_window) {
    static constexpr std::string_view kSuggestClasses[] = {"autosuggestbox"};
    const bool in_suggest = ClassIsOneOf(capture, kSuggestClasses, std::size(kSuggestClasses));
    const bool in_shell_view =
        ClassIsOneOf(capture, kShellViewClasses, std::size(kShellViewClasses));
    const bool target_is_edit =
        !capture.chain.empty() && Lowercase(CompatFold(capture.chain[0].control_type)) == "edit";
    if (in_suggest || (target_is_edit && !in_shell_view)) {
      result.kind = SurfaceKind::kCommandPalette;
      return result;
    }
  }
  if (OneOf(window_class, kExplorerClasses, std::size(kExplorerClasses)) ||
      process == "explorer.exe" ||
      ClassIsOneOf(capture, kShellViewClasses, std::size(kShellViewClasses))) {
    result.kind = SurfaceKind::kFileBrowser;
    return result;
  }
  // Only one of the two could be read: the surface is probably ordinary, but "probably" is not
  // measured, so the capture says so.
  if (!capture.window_class_read || !capture.process_path_read) result.gaps |= kShadowGapReadFailed;
  return result;
}

// The surface of the window, with the read gap added on EVERY route: a window class or process that
// was not read leaves a gap whichever rule (a prompt, a console, Run, the address bar, the Task
// Manager, a file browser) the rest of the capture happened to satisfy.
[[nodiscard]] inline WindowSurface SurfaceForWindow(const ShadowUiaCapture &capture) {
  WindowSurface result = SurfaceForWindowOnce(capture);
  if (!capture.window_class_read || !capture.process_path_read) result.gaps |= kShadowGapReadFailed;
  return result;
}

// A browser's own download list is a page: its URL says so.
[[nodiscard]] inline bool IsDownloadPage(std::string_view url) {
  const std::string lowered = Lowercase(url);
  static constexpr std::string_view kPages[] = {"chrome://downloads", "edge://downloads",
                                                "brave://downloads", "opera://downloads",
                                                "vivaldi://downloads", "about:downloads"};
  for (const std::string_view page : kPages)
    if (lowered.rfind(page, 0) == 0) return true;
  return false;
}

} // namespace windows_shadow_detail

namespace windows_shadow_detail {

// The Win32 / WinUI class names that may become a subrole. A class name inside a web page is a
// string the page wrote (Chromium publishes the HTML class attribute as ClassName: "mdc-button__icon"
// would otherwise cut the actionable span short and let "Place order" through), so it is never a
// subrole there, and outside a page only this closed set counts.
[[nodiscard]] inline bool IsKnownNativeClass(std::string_view class_name) {
  const std::string name = Lowercase(CompatFold(class_name));
  static constexpr std::string_view kKnown[] = {
      "button", "edit", "combobox", "comboboxex32", "listbox", "static", "scrollbar", "syslistview32",
      "systreeview32", "systabcontrol32", "toolbarwindow32", "richedit20w", "richedit50w",
      "passwordbox", "textbox", "richeditbox", "toggleswitch", "checkbox", "radiobutton",
      "hyperlinkbutton", "togglebutton", "splitbutton", "appbarbutton", "slider", "listview",
      "gridview", "menuflyoutitem", "textblock"};
  return OneOf(name, kKnown, std::size(kKnown));
}

[[nodiscard]] inline bool ChainHasPage(const std::vector<ShadowUiaNode> &chain) {
  for (const ShadowUiaNode &node : chain)
    if (Lowercase(CompatFold(node.control_type)) == "document") return true;
  return false;
}

} // namespace windows_shadow_detail

[[nodiscard]] inline ShadowAxNode ShadowUiaAsAxNode(const ShadowUiaNode &node, bool in_page) {
  ShadowAxNode ax;
  ax.role = node.control_type;
  // A password control is a secure text field whatever its name says. Otherwise the class name is
  // the subrole only for a known native class outside a page (see IsKnownNativeClass).
  if (node.is_password)
    ax.subrole = "SecureTextField";
  else if (!in_page && windows_shadow_detail::IsKnownNativeClass(node.class_name))
    ax.subrole = node.class_name;
  ax.title = node.name;
  ax.help = node.help_text;
  ax.identifier = node.automation_id;
  ax.value = node.value;
  ax.oversize = node.oversize;
  ax.read_failed = node.read_failed;
  return ax;
}

[[nodiscard]] inline ShadowFacts BuildWindowsShadowFacts(const ShadowUiaCapture &capture,
                                                         const ShadowRequestInfo &request) {
  using namespace windows_shadow_detail;
  ShadowAxCapture ax;
  ax.target_found = capture.target_found;
  ax.chain_reached_root = capture.chain_reached_root;
  // A node is "in a page" when a Document is above it (or is it); the neighbors share the target's
  // place. The Document itself is the page root and carries no class.
  const bool target_in_page = NodeInPage(capture, 0);
  for (std::size_t index = 0; index < capture.chain.size(); ++index)
    ax.chain.push_back(ShadowUiaAsAxNode(capture.chain[index], NodeInPage(capture, index)));
  for (const ShadowUiaNode &node : capture.neighbors)
    ax.neighbors.push_back(ShadowUiaAsAxNode(node, target_in_page));
  ax.neighbors_complete = capture.neighbors_complete;
  ax.web_area_url_read = capture.document_url_read;
  ax.web_area_url = capture.document_url;
  ax.budget_exhausted = capture.budget_exhausted;
  ax.read_failed = capture.read_failed;
  // The item: a folder opens by browsing into it and is not an item; a file is judged by the name
  // after the last separator. The name is never passed as a URL.
  // Only the real file name or path gives a known extension; a display name never does.
  if (capture.item_kind == ShadowItemKind::kFile && capture.item_name_read &&
      capture.item_name_is_real_path)
    ax.filename = std::string(BaseName(capture.item_name));

  ShadowRequestInfo shared = request;
  shared.executable_path = {};
  ShadowFacts result = BuildShadowFacts(ax, shared);
  EffectFacts &facts = result.facts;

  // A file whose real name could not be read (nothing, or only a display name) is a file item with
  // an unknown extension.
  if (capture.item_kind == ShadowItemKind::kFile &&
      !(capture.item_name_read && capture.item_name_is_real_path)) {
    facts.target_is_file_item = true;
    facts.extension_known = false;
    result.gaps |= kShadowGapExtensionUnknown;
  }

  // A web window is a page whether or not a Document was exposed: its origin is built from its URL
  // exactly like a Document's (a URL that was not read is an unknown origin, not "not applicable").
  if (target_in_page && capture.target_found)
    ApplyShadowOrigin(true, capture.document_url_read, capture.document_url, &facts, &result.gaps);

  // The surface. A page that is a browser's download list wins over the window around it.
  if (capture.target_found) {
    if (facts.surface == SurfaceKind::kOrdinary) {
      const WindowSurface surface = SurfaceForWindow(capture);
      facts.surface = surface.kind;
      result.gaps |= surface.gaps;
      if ((surface.gaps & kShadowGapReadFailed) != 0) facts.metadata_complete = false;
      if (surface.kind == SurfaceKind::kUnknown) facts.metadata_complete = false;
    }
    if (capture.document_url_read && IsDownloadPage(capture.document_url) &&
        facts.surface != SurfaceKind::kDevToolsConsole) {
      facts.surface = SurfaceKind::kDownloadPanel;
      // A browser's own download list is a known place, not an unknown scheme: the origin agrees
      // with the surface, or the core would stop at the origin before it reaches the download rule.
      facts.origin = OriginState::kOrdinary;
      result.gaps &= ~kShadowGapOrigin;
    }
  }
  return result;
}

// The shadow record for one Windows capture (the same record the macOS shadow keeps).
[[nodiscard]] inline ShadowRecord
WindowsShadowClassify(const ShadowUiaCapture &capture, const ShadowRequestInfo &request,
                      bool v1_ordinary, const EffectRuleset &ruleset = EffectRuleset{}) {
  const ShadowFacts built = BuildWindowsShadowFacts(capture, request);
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

} // namespace sprint_coder::computer_use
