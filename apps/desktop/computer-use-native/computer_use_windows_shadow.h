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

// The window or process belongs to an OS prompt (UAC consent, the credential dialogs, Windows
// Security). It is not classified here: the surface is "unknown", which is a takeover, and the
// refusal of such windows is a later step (S5-c).
constexpr std::uint32_t kShadowGapOsPromptSurface = 1u << 14;

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
  // The item the action would open (an Explorer list item, a download row). The name is the file
  // name or a path; Explorer often hides the extension, which is then an unknown extension.
  ShadowItemKind item_kind = ShadowItemKind::kNone;
  bool item_name_read = false;
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

[[nodiscard]] inline WindowSurface SurfaceForWindow(const ShadowUiaCapture &capture) {
  WindowSurface result;
  if (!capture.window_class_read && !capture.process_path_read) {
    result.kind = SurfaceKind::kUnknown;
    result.gaps |= kShadowGapReadFailed;
    return result;
  }
  const std::string window_class =
      capture.window_class_read ? Lowercase(CompatFold(capture.window_class)) : std::string();
  const std::string process = capture.process_path_read
                                  ? Lowercase(CompatFold(BaseName(capture.process_path)))
                                  : std::string();
  // OS prompts first: they win over everything, and are not classified here.
  static constexpr std::string_view kPromptProcesses[] = {
      "consent.exe", "credentialuibroker.exe", "credentialenrollmentmanager.exe",
      "windowsdefender.exe", "securityhealthsystray.exe", "logonui.exe", "winlogon.exe"};
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
  static constexpr std::string_view kPaletteProcesses[] = {
      "powertoys.powerlauncher.exe", "flow.launcher.exe", "searchhost.exe", "searchapp.exe",
      "keypirinha.exe", "wox.exe", "ueli.exe"};
  if (OneOf(process, kPaletteProcesses, std::size(kPaletteProcesses))) {
    result.kind = SurfaceKind::kCommandPalette;
    return result;
  }
  static constexpr std::string_view kExplorerClasses[] = {"cabinetwclass", "explorewclass",
                                                          "progman", "workerw",
                                                          "shell_traywnd"};
  if (OneOf(window_class, kExplorerClasses, std::size(kExplorerClasses)) ||
      process == "explorer.exe") {
    result.kind = SurfaceKind::kFileBrowser;
    return result;
  }
  // Only one of the two could be read: the surface is probably ordinary, but "probably" is not
  // measured, so the capture says so.
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

[[nodiscard]] inline ShadowAxNode ShadowUiaAsAxNode(const ShadowUiaNode &node) {
  ShadowAxNode ax;
  ax.role = node.control_type;
  // A password control is a secure text field whatever its name says; otherwise the class name is
  // the subrole (Win32 class names such as "Button", "Edit", "PasswordBox" carry meaning).
  ax.subrole = node.is_password ? std::string("SecureTextField") : node.class_name;
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
  for (const ShadowUiaNode &node : capture.chain) ax.chain.push_back(ShadowUiaAsAxNode(node));
  for (const ShadowUiaNode &node : capture.neighbors) ax.neighbors.push_back(ShadowUiaAsAxNode(node));
  ax.neighbors_complete = capture.neighbors_complete;
  ax.web_area_url_read = capture.document_url_read;
  ax.web_area_url = capture.document_url;
  ax.budget_exhausted = capture.budget_exhausted;
  ax.read_failed = capture.read_failed;
  // The item: a folder opens by browsing into it and is not an item; a file is judged by the name
  // after the last separator. The name is never passed as a URL.
  if (capture.item_kind == ShadowItemKind::kFile && capture.item_name_read)
    ax.filename = std::string(BaseName(capture.item_name));

  ShadowRequestInfo shared = request;
  shared.executable_path = {};
  ShadowFacts result = BuildShadowFacts(ax, shared);
  EffectFacts &facts = result.facts;

  // A file whose name could not be read is a file item with an unknown extension.
  if (capture.item_kind == ShadowItemKind::kFile && !capture.item_name_read) {
    facts.target_is_file_item = true;
    facts.extension_known = false;
    result.gaps |= kShadowGapExtensionUnknown;
  }

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
        facts.surface != SurfaceKind::kDevToolsConsole)
      facts.surface = SurfaceKind::kDownloadPanel;
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
