// Harness for the shared target eligibility core (S5-c-3, #500 PR-1). It runs the golden vectors
// the TS core also runs, rebuilds the canonical text from the compiled tables and checks its hash
// against the one the generator recorded, and checks monotonicity: a refusal signal added to, or a
// fact taken away from, any golden target never makes it more eligible. It also checks the
// portable parts of the Windows target facts (PR-2): root placement, leaf, PE subsystem, manifest
// level, OriginalFilename and descendants. No platform header, no window, no process. CI compiles
// it with MSVC (the Windows v2 harness row) and clang (macOS).

#include "computer_use_native_eligibility.h"
#include "computer_use_sha256.h"
#include "computer_use_target_eligibility.h"
#include "computer_use_target_eligibility_golden_generated.h"
#include "computer_use_windows_target_facts.h"

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <iostream>
#include <iterator>
#include <optional>
#include <string>
#include <string_view>
#include <type_traits>
#include <vector>

namespace {

using namespace sprint_coder::computer_use;

bool Check(bool condition, std::string_view code) {
  if (!condition) std::cerr << "target eligibility harness: FAIL " << code << '\n';
  return condition;
}

// More is more permissive. A refusal and an unresolvable target are equally not eligible.
int Rank(TargetVerdictKind kind) {
  switch (kind) {
  case TargetVerdictKind::kEligible: return 2;
  case TargetVerdictKind::kUpper: return 1;
  case TargetVerdictKind::kDenied:
  case TargetVerdictKind::kUnresolvable: return 0;
  }
  return 0;
}

// What leaves the core is the kind and the mode only (the TS source contract pins the fields).
static_assert(std::is_same_v<decltype(TargetVerdict{}.kind), TargetVerdictKind>);
static_assert(std::is_same_v<decltype(TargetVerdict{}.maximum_mode), std::string_view>);

bool CheckGlob() {
  return Check(target_eligibility_detail::GlobMatches("setup*", "setup.exe"), "glob-prefix") &&
         Check(target_eligibility_detail::GlobMatches("*install*", "uninstall.exe"),
               "glob-infix") &&
         Check(target_eligibility_detail::GlobMatches("*update*.exe", "contosoupdater.exe"),
               "glob-two-stars") &&
         Check(!target_eligibility_detail::GlobMatches("*update*.exe", "update.dll"),
               "glob-suffix") &&
         Check(target_eligibility_detail::GlobMatches("a*b*c", "aXbYbZc"), "glob-backtrack") &&
         Check(!target_eligibility_detail::GlobMatches("cmd.exe", "cmd.exe2"), "glob-exact") &&
         Check(target_eligibility_detail::GlobMatches("*", ""), "glob-empty");
}

bool CheckTables() {
  // A deny-only signal never admits a route and is never negated (the generator refuses it too).
  for (const TargetRoute &route : kTargetRoutes)
    for (const TargetCondition &condition : route.when)
      for (const TargetSignalSpec &spec : kTargetSignals)
        if (spec.signal == condition.signal && !Check(!spec.deny_only, "deny-only-in-route"))
          return false;
  for (const TargetRule &rule : kTargetRules)
    for (const TargetCondition &condition : rule.when)
      for (const TargetSignalSpec &spec : kTargetSignals)
        if (spec.signal == condition.signal &&
            !Check(!(spec.deny_only && condition.negate), "deny-only-negated"))
          return false;
  if (!Check(std::size(kTargetSignals) == kTargetSignalCount, "signal-count")) return false;
  for (std::size_t index = 0; index < std::size(kTargetSignals); ++index)
    if (!Check(static_cast<std::size_t>(kTargetSignals[index].signal) == index, "signal-order"))
      return false;
  return true;
}

bool CheckContentHash() {
  for (const TargetPlatformRuleset &ruleset : kTargetPlatformRulesets) {
    const std::string text = DenyRulesetCanonicalText(ruleset.platform);
    if (!Check(!text.empty() && Sha256Hex(text) == ruleset.content_sha256, "content-hash"))
      return false;
    if (!Check(DenyRulesetVersion(ruleset.platform) == ruleset.ruleset_version &&
                   ruleset.ruleset_version > 0 && ruleset.ruleset_version <= 0xffff,
               "ruleset-version"))
      return false;
  }
  return Check(DenyRulesetCanonicalText(TargetPlatform::kUnknown).empty() &&
                   DenyRulesetVersion(TargetPlatform::kUnknown) == 0,
               "no-ruleset-unknown-platform");
}

bool CheckGolden(const std::vector<TargetGoldenCase> &cases) {
  for (const TargetGoldenCase &entry : cases) {
    const TargetClassification explained = ClassifyTargetExplained(entry.facts);
    const TargetVerdict verdict = ClassifyTarget(entry.facts);
    if (explained.verdict.kind != entry.kind || explained.deny_class != entry.deny_class ||
        verdict.kind != entry.kind) {
      std::cerr << "golden case \"" << entry.name << "\": got "
                << TargetVerdictKindName(explained.verdict.kind) << ' ' << explained.deny_class
                << ", want " << TargetVerdictKindName(entry.kind) << ' ' << entry.deny_class
                << '\n';
      return Check(false, "golden");
    }
    const bool admitted =
        entry.kind == TargetVerdictKind::kEligible || entry.kind == TargetVerdictKind::kUpper;
    if (!Check(admitted == !verdict.maximum_mode.empty(), "golden-mode-only-when-admitted") ||
        !Check(admitted == !explained.route.empty(), "golden-route-only-when-admitted"))
      return false;
  }
  return Check(cases.size() >= 40, "golden-count");
}

// Sets the fact `condition` reads to a value that satisfies it. Only called for conditions that
// are not negated, in rules that refuse or cap.
void Satisfy(TargetFacts *facts, const TargetCondition &condition) {
  if (condition.match == TargetMatch::kTrue || condition.match == TargetMatch::kFalse) {
    *MutableTargetBooleanFact(*facts, condition.signal) = condition.match == TargetMatch::kTrue;
    return;
  }
  std::string value(condition.values.front());
  for (char &letter : value)
    if (letter == '*') letter = 'x';
  *MutableTargetStringFact(*facts, condition.signal) = value;
}

// True when the fact `signal` already holds a refusal or cap signal (or holds nothing). A fact
// holds one value, so setting it to another signal would take that one away rather than add one;
// such a fact is not mutated.
bool CarriesSignal(const TargetFacts &facts, TargetSignal signal) {
  // An unmeasured fact (or one the ruleset does not know) is not mutated either: measuring it is
  // not adding a signal.
  for (const TargetSignalSpec &spec : kTargetSignals)
    if (spec.signal == signal && !target_eligibility_detail::FactIsMeasured(facts, spec))
      return true;
  for (const TargetRule &rule : kTargetRules)
    for (const TargetCondition &condition : rule.when)
      if (condition.signal == signal && !condition.negate &&
          target_eligibility_detail::ConditionHolds(facts, condition))
        return true;
  return false;
}

bool CheckMonotonic(const std::vector<TargetGoldenCase> &cases) {
  std::size_t mutations = 0;
  for (const TargetGoldenCase &entry : cases) {
    const int before = Rank(ClassifyTarget(entry.facts).kind);
    for (const TargetRule &rule : kTargetRules) {
      bool negated = false;
      for (const TargetCondition &condition : rule.when) negated = negated || condition.negate;
      if (negated) continue;
      bool carried = false;
      for (const TargetCondition &condition : rule.when)
        carried = carried || CarriesSignal(entry.facts, condition.signal);
      TargetFacts whole = entry.facts;
      for (const TargetCondition &condition : rule.when) {
        if (CarriesSignal(entry.facts, condition.signal)) continue;
        TargetFacts single = entry.facts;
        Satisfy(&single, condition);
        Satisfy(&whole, condition);
        ++mutations;
        if (Rank(ClassifyTarget(single).kind) > before) {
          std::cerr << "golden case \"" << entry.name << "\" became more eligible\n";
          return Check(false, "monotonic-signal");
        }
      }
      if (carried) continue;
      if (!Check(Rank(ClassifyTarget(whole).kind) <= before, "monotonic-rule")) return false;
      // A whole refusing rule refuses a target whose facts are complete.
      if (rule.verdict == TargetRuleVerdict::kDenied && TargetFactsAreComplete(whole) &&
          (rule.platforms & TargetPlatformBit(whole.platform)) != 0 &&
          !Check(ClassifyTarget(whole).kind == TargetVerdictKind::kDenied, "rule-refuses"))
        return false;
    }
    for (const TargetSignalSpec &spec : kTargetSignals) {
      TargetFacts unknown = entry.facts;
      if (spec.type == TargetSignalType::kBoolean)
        MutableTargetBooleanFact(unknown, spec.signal)->reset();
      else
        MutableTargetStringFact(unknown, spec.signal)->reset();
      ++mutations;
      const TargetVerdictKind kind = ClassifyTarget(unknown).kind;
      if (!Check(Rank(kind) <= before, "monotonic-unknown")) return false;
      if ((spec.platforms & TargetPlatformBit(unknown.platform)) != 0 &&
          !Check(kind == TargetVerdictKind::kUnresolvable, "unknown-is-unresolvable"))
        return false;
    }
  }
  std::cout << "  monotonic mutations checked: " << mutations << '\n';
  return true;
}

// S5-c-3 PR-2: the portable parts of the Windows target facts
// (computer_use_windows_target_facts.h).

bool CheckWindowsImagePlacement() {
  const std::vector<WindowsImageRootPrefix> roots = {
      {"self_install", "C:\\Users\\a\\AppData\\Local\\Programs\\sprint-coder"},
      {"windows_apps", "C:\\Program Files\\WindowsApps"},
      {"windows_directory", "C:\\Windows\\"},
      {"program_files", "C:\\Program Files"},
      {"program_files", "C:\\Program Files (x86)"},
      {"local_programs", "C:\\Users\\a\\AppData\\Local\\Programs"},
      {"temp", "C:\\Users\\a\\AppData\\Local\\Temp"},
      {"downloads", "C:\\Users\\\xe3\x81\x82\\Downloads"},
  };
  const auto placed = [&roots](std::string_view path, std::string_view root,
                               std::string_view relative) {
    const WindowsImagePlacement placement = PlaceWindowsImage(path, roots);
    return placement.root == root && placement.relative_path == relative;
  };
  return Check(placed("C:\\Windows\\System32\\notepad.exe", "windows_directory",
                      "System32\\notepad.exe"),
               "place-windows-directory-trailing-separator") &&
         Check(placed("c:\\windows\\system32\\cmd.exe", "windows_directory",
                      "system32\\cmd.exe"),
               "place-ascii-case-folded") &&
         Check(placed("C:\\Program Files\\WindowsApps\\Microsoft.Notepad_1_x64__8w\\Notepad.exe",
                      "windows_apps", "Microsoft.Notepad_1_x64__8w\\Notepad.exe"),
               "place-windows-apps-before-program-files") &&
         Check(placed("C:\\Program Files (x86)\\Contoso\\app.exe", "program_files",
                      "Contoso\\app.exe"),
               "place-program-files-x86") &&
         Check(placed("C:\\Program FilesX\\app.exe", "other", "C:\\Program FilesX\\app.exe"),
               "place-component-boundary") &&
         Check(placed("C:\\Program Files", "other", "C:\\Program Files"), "place-root-itself") &&
         Check(placed("C:\\Program Files\\", "other", "C:\\Program Files\\"),
               "place-root-with-separator") &&
         Check(placed("C:\\Users\\a\\AppData\\Local\\Programs\\sprint-coder\\Sprint Coder.exe",
                      "self_install", "Sprint Coder.exe"),
               "place-self-install-before-local-programs") &&
         Check(placed("C:\\Users\\a\\AppData\\Local\\Programs\\Contoso\\app.exe",
                      "local_programs", "Contoso\\app.exe"),
               "place-local-programs") &&
         Check(placed("C:\\Users\\a\\AppData\\Local\\Temp\\x\\setup.exe", "temp", "x\\setup.exe"),
               "place-temp") &&
         Check(placed("C:\\Users\\\xe3\x81\x82\\Downloads\\app.exe", "downloads", "app.exe"),
               "place-non-ascii-root") &&
         Check(placed("\\\\server\\share\\app.exe", "other", "\\\\server\\share\\app.exe"),
               "place-unc-other") &&
         Check(PlaceWindowsImage("C:\\Windows\\notepad.exe", {}).root == "other",
               "place-no-roots") &&
         Check(WindowsImageLeaf("C:\\Windows\\System32\\cmd.exe") == "cmd.exe" &&
                   WindowsImageLeaf("cmd.exe") == "cmd.exe" &&
                   WindowsImageLeaf("C:/a/b.exe") == "b.exe",
               "leaf");
}

// A PE image header with the given optional header magic and subsystem.
std::vector<std::uint8_t> PeHeader(std::uint16_t magic, std::uint16_t subsystem) {
  std::vector<std::uint8_t> bytes(0x80 + 24 + 240, 0);
  bytes[0] = 'M';
  bytes[1] = 'Z';
  bytes[0x3c] = 0x80;
  bytes[0x80] = 'P';
  bytes[0x81] = 'E';
  bytes[0x80 + 20] = 240; // SizeOfOptionalHeader
  bytes[0x80 + 24] = static_cast<std::uint8_t>(magic & 0xff);
  bytes[0x80 + 25] = static_cast<std::uint8_t>(magic >> 8);
  bytes[0x80 + 24 + 68] = static_cast<std::uint8_t>(subsystem & 0xff);
  bytes[0x80 + 24 + 69] = static_cast<std::uint8_t>(subsystem >> 8);
  return bytes;
}

bool CheckPeSubsystem() {
  std::vector<std::uint8_t> not_pe = PeHeader(0x20b, 2);
  not_pe[0] = 'X';
  std::vector<std::uint8_t> bad_signature = PeHeader(0x20b, 2);
  bad_signature[0x81] = 'X';
  std::vector<std::uint8_t> far_header = PeHeader(0x20b, 2);
  far_header[0x3c] = 0xff;
  far_header[0x3f] = 0x7f;
  std::vector<std::uint8_t> short_optional = PeHeader(0x20b, 2);
  short_optional[0x80 + 20] = 60;
  std::vector<std::uint8_t> truncated = PeHeader(0x20b, 2);
  truncated.resize(0x80 + 24 + 69);
  return Check(ParsePeSubsystem(PeHeader(0x20b, 2)) == std::optional<std::string>("gui"),
               "pe-pe32plus-gui") &&
         Check(ParsePeSubsystem(PeHeader(0x10b, 3)) == std::optional<std::string>("console"),
               "pe-pe32-console") &&
         Check(ParsePeSubsystem(PeHeader(0x20b, 1)) == std::optional<std::string>("other"),
               "pe-native-is-other") &&
         Check(!ParsePeSubsystem(PeHeader(0x107, 2)).has_value(), "pe-bad-magic") &&
         Check(!ParsePeSubsystem(not_pe).has_value(), "pe-not-mz") &&
         Check(!ParsePeSubsystem(bad_signature).has_value(), "pe-bad-signature") &&
         Check(!ParsePeSubsystem(far_header).has_value(), "pe-header-outside") &&
         Check(!ParsePeSubsystem(short_optional).has_value(), "pe-short-optional-header") &&
         Check(!ParsePeSubsystem(truncated).has_value(), "pe-truncated") &&
         Check(!ParsePeSubsystem({}).has_value(), "pe-empty");
}

// ASCII text as UTF-16 bytes, little or big endian, with or without the BOM.
std::string Utf16Bytes(std::string_view ascii, bool big_endian, bool bom) {
  std::string bytes;
  const auto unit = [&bytes, big_endian](unsigned int value) {
    const char low = static_cast<char>(value & 0xff);
    const char high = static_cast<char>((value >> 8) & 0xff);
    bytes += big_endian ? high : low;
    bytes += big_endian ? low : high;
  };
  if (bom) unit(0xfeff);
  for (const char letter : ascii) unit(static_cast<unsigned char>(letter));
  return bytes;
}

// The encodings a manifest can come in: UTF-16 is read, and what cannot be read is std::nullopt,
// never "no elevation asked" (the reader must not fail open on an encoding).
bool CheckManifestEncodings() {
  const auto level = [](const std::string &manifest) {
    return ManifestRequiresAdministrator(manifest);
  };
  const std::string admin = "<?xml version=\"1.0\" encoding=\"UTF-16\"?><assembly>"
                            "<requestedExecutionLevel level=\"requireAdministrator\"/></assembly>";
  const std::string invoker = "<assembly><requestedExecutionLevel level=\"asInvoker\"/></assembly>";
  const std::optional<bool> no = false;
  const std::optional<bool> yes = true;
  std::string utf32 = {'\xff', '\xfe', '\0', '\0'};
  for (const char letter : std::string_view("<a/>")) {
    utf32 += letter;
    utf32 += std::string(3, '\0');
  }
  std::string odd = Utf16Bytes(admin, false, true);
  odd.pop_back();
  const std::string with_nul =
      std::string("<assembly>") + '\0' + "<requestedExecutionLevel level=\"requireAdministrator\"/>";
  return Check(level(Utf16Bytes(admin, false, true)) == yes, "manifest-utf16le-bom") &&
         Check(level(Utf16Bytes(admin, false, false)) == yes, "manifest-utf16le-no-bom") &&
         Check(level(Utf16Bytes(admin, true, true)) == yes, "manifest-utf16be-bom") &&
         Check(level(Utf16Bytes(admin, true, false)) == yes, "manifest-utf16be-no-bom") &&
         Check(level(Utf16Bytes(invoker, false, true)) == no, "manifest-utf16le-as-invoker") &&
         Check(level(Utf16Bytes("<assembly/>", true, true)) == no, "manifest-utf16-without-level") &&
         Check(!level(utf32).has_value(), "manifest-utf32-unreadable") &&
         Check(!level(odd).has_value(), "manifest-utf16-odd-length-unreadable") &&
         Check(!level("<assembly>\xff\xfe</assembly>").has_value(), "manifest-not-utf8-unreadable") &&
         Check(!level("<assembly>\xc0\xaf</assembly>").has_value(),
               "manifest-overlong-utf8-unreadable") &&
         Check(!level(with_nul).has_value(), "manifest-nul-in-utf8-unreadable") &&
         Check(level(admin + std::string(3, '\0')) == yes &&
                   level(Utf16Bytes(admin, false, true) + std::string(2, '\0')) == yes,
               "manifest-trailing-nul-padding") &&
         Check(level("<assembly><!-- \xe6\x97\xa5\xe6\x9c\xac --></assembly>") == no,
               "manifest-utf8-multibyte-without-level");
}

bool CheckManifestLevel() {
  const auto level = [](std::string_view manifest) {
    return ManifestRequiresAdministrator(manifest);
  };
  const std::optional<bool> no = false;
  const std::optional<bool> yes = true;
  return Check(level("<assembly><trustInfo><security><requestedPrivileges>"
                     "<requestedExecutionLevel level=\"asInvoker\" uiAccess=\"false\" />"
                     "</requestedPrivileges></security></trustInfo></assembly>") == no,
               "manifest-as-invoker") &&
         Check(level("<requestedExecutionLevel level=\"requireAdministrator\"/>") == yes,
               "manifest-require-administrator") &&
         Check(level("<requestedExecutionLevel uiAccess='false' level='highestAvailable'/>") == yes,
               "manifest-highest-available-single-quotes") &&
         Check(level("<ms_asmv2:requestedExecutionLevel level=\"requireAdministrator\">"
                     "</ms_asmv2:requestedExecutionLevel>") == yes,
               "manifest-prefixed-element") &&
         Check(level("<requestedExecutionLevel\n  level = \"asInvoker\"\n/>") == no,
               "manifest-spaced-attribute") &&
         Check(level("<requestedExecutionLevel level=\"somethingNew\"/>") == yes,
               "manifest-unknown-level-refuses") &&
         Check(level("<assembly><!-- requestedExecutionLevel --></assembly>") == no,
               "manifest-comment-is-not-an-element") &&
         Check(level("<assembly/>") == no, "manifest-without-level") &&
         Check(level("\xef\xbb\xbf<requestedExecutionLevel level=\"requireAdministrator\"/>") ==
                   yes,
               "manifest-bom") &&
         Check(level("<requestedExecutionLevel level=\"asInvoker\"/>"
                     "<requestedExecutionLevel level=\"requireAdministrator\"/>") == yes,
               "manifest-any-elevated-level") &&
         Check(!level("<requestedExecutionLevel level=\"asInvoker/>").has_value(),
               "manifest-unclosed-quote") &&
         Check(!level("<requestedExecutionLevel uiAccess=\"false\"/>").has_value(),
               "manifest-element-without-level") &&
         Check(!level("<requestedExecutionLevel level=\"asInvoker\"").has_value(),
               "manifest-unclosed-tag") &&
         CheckManifestEncodings();
}

// A VS_VERSIONINFO-style block: wLength, wValueLength, wType, key, padding, value, children.
std::vector<std::uint8_t> VersionBlock(std::u16string_view key, std::uint16_t type,
                                       std::vector<std::uint8_t> value,
                                       std::uint16_t value_length,
                                       const std::vector<std::vector<std::uint8_t>> &children) {
  std::vector<std::uint8_t> bytes(6, 0);
  for (const char16_t unit : key) {
    bytes.push_back(static_cast<std::uint8_t>(unit & 0xff));
    bytes.push_back(static_cast<std::uint8_t>(unit >> 8));
  }
  bytes.push_back(0);
  bytes.push_back(0);
  while (bytes.size() % 4 != 0) bytes.push_back(0);
  bytes.insert(bytes.end(), value.begin(), value.end());
  for (const std::vector<std::uint8_t> &child : children) {
    while (bytes.size() % 4 != 0) bytes.push_back(0);
    bytes.insert(bytes.end(), child.begin(), child.end());
  }
  bytes[0] = static_cast<std::uint8_t>(bytes.size() & 0xff);
  bytes[1] = static_cast<std::uint8_t>(bytes.size() >> 8);
  bytes[2] = static_cast<std::uint8_t>(value_length & 0xff);
  bytes[3] = static_cast<std::uint8_t>(value_length >> 8);
  bytes[4] = static_cast<std::uint8_t>(type);
  return bytes;
}

std::vector<std::uint8_t> VersionString(std::u16string_view key, std::u16string_view value) {
  std::vector<std::uint8_t> bytes;
  for (const char16_t unit : value) {
    bytes.push_back(static_cast<std::uint8_t>(unit & 0xff));
    bytes.push_back(static_cast<std::uint8_t>(unit >> 8));
  }
  bytes.push_back(0);
  bytes.push_back(0);
  return VersionBlock(key, 1, bytes, static_cast<std::uint16_t>(value.size() + 1), {});
}

std::vector<std::uint8_t> VersionResource(const std::vector<std::vector<std::uint8_t>> &strings) {
  const std::vector<std::uint8_t> fixed(52, 0); // VS_FIXEDFILEINFO
  const std::vector<std::uint8_t> translation = {0x09, 0x04, 0xb0, 0x04};
  return VersionBlock(
      u"VS_VERSION_INFO", 0, fixed, 52,
      {VersionBlock(u"VarFileInfo", 1, {}, 0,
                    {VersionBlock(u"Translation", 0, translation, 4, {})}),
       VersionBlock(u"StringFileInfo", 1, {}, 0,
                    {VersionBlock(u"040904B0", 1, {}, 0, strings)})});
}

bool CheckVersionInfo() {
  const std::vector<std::uint8_t> cmd = VersionResource(
      {VersionString(u"CompanyName", u"Microsoft Corporation"),
       VersionString(u"OriginalFilename", u"Cmd.Exe")});
  const std::vector<std::uint8_t> without =
      VersionResource({VersionString(u"CompanyName", u"Contoso")});
  const std::vector<std::uint8_t> wide = VersionResource(
      {VersionString(u"OriginalFilename", u"\u30e1\u30e2\U0001f600.exe")});
  const char16_t unpaired_value[] = {u'a', static_cast<char16_t>(0xd800), u'.', u'e', u'x', u'e'};
  const std::vector<std::uint8_t> unpaired = VersionResource(
      {VersionString(u"OriginalFilename", std::u16string_view(unpaired_value, 6))});
  std::vector<std::uint8_t> overlong = cmd;
  overlong[0] = static_cast<std::uint8_t>((overlong.size() + 4) & 0xff);
  overlong[1] = static_cast<std::uint8_t>((overlong.size() + 4) >> 8);
  std::vector<std::uint8_t> wrong_root = cmd;
  wrong_root[6] = 'X';
  std::vector<std::uint8_t> truncated = cmd;
  truncated.resize(truncated.size() - 10);
  return Check(VersionInfoOriginalFilename(cmd) == std::optional<std::string>("Cmd.Exe"),
               "version-original-filename") &&
         Check(VersionInfoOriginalFilename(without) == std::optional<std::string>(""),
               "version-without-original-filename") &&
         Check(VersionInfoOriginalFilename(wide) ==
                   std::optional<std::string>("\xe3\x83\xa1\xe3\x83\xa2\xf0\x9f\x98\x80.exe"),
               "version-utf16-to-utf8") &&
         Check(!VersionInfoOriginalFilename(unpaired).has_value(), "version-unpaired-surrogate") &&
         Check(!VersionInfoOriginalFilename(overlong).has_value(), "version-length-outside") &&
         Check(!VersionInfoOriginalFilename(wrong_root).has_value(), "version-wrong-root-key") &&
         Check(!VersionInfoOriginalFilename(truncated).has_value(), "version-truncated") &&
         Check(!VersionInfoOriginalFilename({}).has_value(), "version-empty");
}

bool CheckDescendantLeaves() {
  return Check(WindowsLeafIsShell("cmd.exe") && WindowsLeafIsShell("PowerShell.exe") &&
                   WindowsLeafIsShell("pwsh-preview.exe") && WindowsLeafIsShell("WSL.exe") &&
                   WindowsLeafIsShell("bash.exe"),
               "shell-leaves-from-the-w4-rule") &&
         Check(!WindowsLeafIsShell("conhost.exe") && !WindowsLeafIsShell("OpenConsole.exe") &&
                   !WindowsLeafIsShell("notepad.exe") && !WindowsLeafIsShell("ping.exe") &&
                   !WindowsLeafIsShell(""),
               "not-shell-leaves") &&
         Check(WindowsLeafIsConsoleHost("conhost.exe") &&
                   WindowsLeafIsConsoleHost("OpenConsole.exe") &&
                   !WindowsLeafIsConsoleHost("cmd.exe"),
               "console-host-leaves");
}

bool CheckDescendants() {
  // 100 (created at 10) -> 200 (20) -> 300 (30); 400 names 200 as its parent but was created
  // before it (200 is a reused pid); 500 could not be opened; 600 is under 500; 700 is its own
  // parent; 800 is unrelated; the last 100 is a later process with the root's pid.
  const std::vector<WindowsProcessNode> nodes = {
      {100, 4, 10, "app.exe"},           {200, 100, 20, "cmd.exe"},
      {300, 200, 30, "conhost.exe"},     {400, 200, 15, "old.exe"},
      {500, 100, std::nullopt, "x.exe"}, {600, 500, 40, "y.exe"},
      {700, 700, 50, "loop.exe"},        {800, 4, 5, "other.exe"},
      {100, 4, 99, "later.exe"},
  };
  const auto pids = [&nodes](const WindowsDescendants &found) {
    std::vector<std::uint32_t> result;
    for (const std::size_t index : found.nodes) result.push_back(nodes[index].pid);
    std::sort(result.begin(), result.end());
    return result;
  };
  const WindowsDescendants all = FindWindowsDescendants(nodes, 100, 10, 64);
  const WindowsDescendants below_cmd = FindWindowsDescendants(nodes, 200, 20, 64);
  const WindowsDescendants limited = FindWindowsDescendants(nodes, 100, 10, 2);
  const WindowsDescendants loop = FindWindowsDescendants(nodes, 700, 50, 64);
  return Check(pids(all) == std::vector<std::uint32_t>({200, 300, 500, 600}) && !all.truncated,
               "descendants-follow-creation-order") &&
         Check(pids(below_cmd) == std::vector<std::uint32_t>({300}), "descendants-reused-pid") &&
         Check(limited.truncated && limited.nodes.size() == 2, "descendants-limit") &&
         Check(loop.nodes.empty(), "descendants-self-parent") &&
         Check(FindWindowsDescendants(nodes, 900, 1, 64).nodes.empty(), "descendants-none");
}

bool CheckEligibilityMode() {
#if defined(SPRINT_CODER_EXPECT_ELIGIBILITY_V2)
  // The CI row names the mode it compiled the harness for.
  static_assert(SPRINT_CODER_EXPECT_ELIGIBILITY_V2 == 0 || SPRINT_CODER_EXPECT_ELIGIBILITY_V2 == 1,
                "The expected eligibility mode is v1 (0) or v2 (1).");
  if (!Check(kNativeEligibilityIsV2 == (SPRINT_CODER_EXPECT_ELIGIBILITY_V2 == 1),
             "eligibility-mode-matches-row"))
    return false;
#endif
  std::cout << "  compiled eligibility mode: " << kNativeEligibilityModeName << '\n';
  return true;
}

} // namespace

int main() {
  const std::vector<TargetGoldenCase> cases = TargetGoldenCases();
  if (!CheckEligibilityMode() || !CheckGlob() || !CheckTables() || !CheckContentHash() ||
      !CheckGolden(cases) || !CheckMonotonic(cases) || !CheckWindowsImagePlacement() ||
      !CheckPeSubsystem() || !CheckManifestLevel() || !CheckVersionInfo() ||
      !CheckDescendantLeaves() || !CheckDescendants())
    return 1;
  std::cout << "Computer Use target eligibility core: PASS (" << cases.size()
            << " golden vectors)\n";
  return 0;
}
