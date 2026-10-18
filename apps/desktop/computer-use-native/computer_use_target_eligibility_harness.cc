// Harness for the shared target eligibility core (S5-c-3, #500 PR-1). It runs the golden vectors
// the TS core also runs, rebuilds the canonical text from the compiled tables and checks its hash
// against the one the generator recorded, and checks monotonicity: a refusal signal added to, or a
// fact taken away from, any golden target never makes it more eligible. It also checks the
// portable parts of the Windows target facts (PR-2): root placement, leaf, PE subsystem, manifest
// level, OriginalFilename, resources, the process snapshot, the image-unchanged check and
// descendants, and the v2 package identity (PR-4). No platform header, no window, no process. CI compiles
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

void PutLe(std::vector<std::uint8_t> &bytes, std::size_t at, std::uint32_t value,
           std::size_t width) {
  for (std::size_t index = 0; index < width; ++index)
    bytes[at + index] = static_cast<std::uint8_t>((value >> (8 * index)) & 0xff);
}

bool CheckPeClrImage();

bool CheckPeImageSummary() {
  const std::optional<bool> yes = true;
  const std::optional<bool> no = false;
  // A PE32+ image with a machine, an entry RVA, a checksum, and 16 data directories.
  std::vector<std::uint8_t> bytes = PeHeader(0x20b, 2);
  PutLe(bytes, 0x80 + 4, 0x8664, 2);            // Machine (AMD64)
  PutLe(bytes, 0x80 + 24 + 16, 0x1234, 4);      // AddressOfEntryPoint
  PutLe(bytes, 0x80 + 24 + 64, 0xabcdef, 4);    // CheckSum
  PutLe(bytes, 0x80 + 24 + 108, 16, 4);         // NumberOfRvaAndSizes (PE32+)
  const std::optional<PeImageSummary> plain = ParsePeImageSummary(bytes);
  std::vector<std::uint8_t> with_cert = bytes;
  // The certificate table is data directory 4; its size is the second dword of its entry.
  PutLe(with_cert, 0x80 + 24 + 112 + 4 * 8 + 4, 0x400, 4);
  const std::optional<PeImageSummary> cert = ParsePeImageSummary(with_cert);
  std::vector<std::uint8_t> few_dirs = bytes;
  PutLe(few_dirs, 0x80 + 24 + 108, 4, 4); // only 4 directories: no security entry
  PutLe(few_dirs, 0x80 + 24 + 112 + 4 * 8 + 4, 0x400, 4);
  const std::optional<PeImageSummary> few = ParsePeImageSummary(few_dirs);
  // A header truncated before NumberOfRvaAndSizes (PE32+ reads pe+24+108): the cert table is
  // unknown (std::nullopt), never "none", and the fields before it are still read.
  std::vector<std::uint8_t> truncated_dirs(bytes.begin(), bytes.begin() + 222);
  const std::optional<PeImageSummary> short_header = ParsePeImageSummary(truncated_dirs);
  // SizeOfOptionalHeader that claims more than the bytes hold: the directory count is not read.
  std::vector<std::uint8_t> lying_size = bytes;
  PutLe(lying_size, 0x80 + 20, 4096, 2);
  lying_size.resize(0x80 + 24 + 100);
  const std::optional<PeImageSummary> lying = ParsePeImageSummary(lying_size);
  // A huge NumberOfRvaAndSizes must not widen any read: with the fixed security slot inside the
  // bytes it reads it safely, and with the bytes cut short it falls back to unknown, never OOB.
  std::vector<std::uint8_t> huge_count = bytes;
  PutLe(huge_count, 0x80 + 24 + 108, 0xffffffff, 4);
  const std::optional<PeImageSummary> huge = ParsePeImageSummary(huge_count);
  std::vector<std::uint8_t> huge_count_cut = huge_count;
  huge_count_cut.resize(0x80 + 24 + 120); // past the count, before the security slot
  const std::optional<PeImageSummary> huge_cut = ParsePeImageSummary(huge_count_cut);
  // e_lfanew (PE offset) past the end of the bytes.
  std::vector<std::uint8_t> far_pe = bytes;
  PutLe(far_pe, 0x3c, 0x7fffffff, 4);
  const std::optional<PeImageSummary> far = ParsePeImageSummary(far_pe);
  return Check(plain.has_value() && plain->subsystem == "gui" && plain->subsystem_code == 2 &&
                   plain->machine == 0x8664 && plain->entry_rva == 0x1234 &&
                   plain->check_sum == 0xabcdef && plain->has_cert_table == no,
               "pe-summary-fields") &&
         Check(cert.has_value() && cert->has_cert_table == yes, "pe-summary-cert-table-present") &&
         Check(few.has_value() && !few->has_cert_table.has_value(),
               "pe-summary-too-few-directories-is-unknown") &&
         Check(short_header.has_value() && short_header->entry_rva == 0x1234 &&
                   !short_header->has_cert_table.has_value(),
               "pe-summary-truncated-directories-is-unknown") &&
         Check(lying.has_value() && !lying->has_cert_table.has_value(),
               "pe-summary-optional-size-beyond-bytes-is-unknown") &&
         Check(huge.has_value() && huge->has_cert_table == no,
               "pe-summary-huge-rva-count-in-range-reads-safely") &&
         Check(huge_cut.has_value() && !huge_cut->has_cert_table.has_value(),
               "pe-summary-huge-rva-count-cut-short-is-unknown") &&
         Check(!far.has_value(), "pe-summary-e-lfanew-out-of-range") && CheckPeClrImage();
}

// A PE32 (or, with `plus`, PE32+) image with one section and a CLR (COR20) header whose Flags are
// `clr_flags`.
std::vector<std::uint8_t> ClrImage(std::uint32_t clr_flags, bool plus = false) {
  std::vector<std::uint8_t> bytes(0x1800, 0);
  bytes[0] = 'M';
  bytes[1] = 'Z';
  bytes[0x3c] = 0x80;
  bytes[0x80] = 'P';
  bytes[0x81] = 'E';
  PutLe(bytes, 0x80 + 6, 1, 2);                 // NumberOfSections = 1 (COFF header offset 2)
  PutLe(bytes, 0x80 + 20, 240, 2);              // SizeOfOptionalHeader
  PutLe(bytes, 0x80 + 24, plus ? 0x20b : 0x10b, 2); // PE32 / PE32+ magic
  PutLe(bytes, 0x80 + 24 + 68, 2, 2);           // Subsystem = GUI
  const std::size_t directories = plus ? 112 : 96;
  PutLe(bytes, 0x80 + 24 + directories - 4, 16, 4); // NumberOfRvaAndSizes
  // Data directory 14 (CLR): RVA then size.
  PutLe(bytes, 0x80 + 24 + directories + 14 * 8, 0x2000, 4);
  PutLe(bytes, 0x80 + 24 + directories + 14 * 8 + 4, 0x48, 4);
  // One section header, after the optional header (0x80 + 24 + 240 = 0x118).
  const std::size_t section = 0x80 + 24 + 240;
  PutLe(bytes, section + 8, 0x1000, 4);  // VirtualSize
  PutLe(bytes, section + 12, 0x1000, 4); // VirtualAddress
  PutLe(bytes, section + 16, 0x1400, 4); // SizeOfRawData
  PutLe(bytes, section + 20, 0x400, 4);  // PointerToRawData
  // COR20 header at RVA 0x2000 -> file 0x400 + (0x2000 - 0x1000) = 0x1400; Flags at +16.
  PutLe(bytes, 0x1400 + 16, clr_flags, 4);
  return bytes;
}

bool CheckPeClrImage() {
  constexpr std::uint32_t kIlOnly = 0x1;
  constexpr std::uint32_t k32BitRequired = 0x2;
  constexpr std::uint32_t k32BitPreferred = 0x20000;
  const std::optional<bool> yes = true;
  const std::optional<bool> no = false;
  const std::optional<PeImageSummary> any_cpu = ParsePeImageSummary(ClrImage(kIlOnly));
  const std::optional<PeImageSummary> required =
      ParsePeImageSummary(ClrImage(kIlOnly | k32BitRequired));
  const std::optional<PeImageSummary> preferred =
      ParsePeImageSummary(ClrImage(kIlOnly | k32BitPreferred));
  const std::optional<PeImageSummary> native = ParsePeImageSummary(PeHeader(0x10b, 2));
  // A PE32+ IL-only image is not converted by the loader, so it keeps the full kernel cross-check.
  const std::optional<PeImageSummary> plus_il_only =
      ParsePeImageSummary(ClrImage(kIlOnly, /*plus=*/true));
  return Check(any_cpu.has_value() && any_cpu->clr_bitness_convertible == yes,
               "pe-clr-anycpu-il-only-is-convertible") &&
         Check(required.has_value() && required->clr_bitness_convertible == no,
               "pe-clr-32bit-required-is-not-convertible") &&
         Check(preferred.has_value() && preferred->clr_bitness_convertible == no,
               "pe-clr-32bit-preferred-is-not-convertible") &&
         Check(native.has_value() && !native->clr_bitness_convertible.has_value(),
               "pe-no-clr-header-is-unknown") &&
         Check(plus_il_only.has_value() && plus_il_only->clr_bitness_convertible == no,
               "pe-clr-pe32plus-il-only-is-not-convertible");
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
         Check(level("<assembly><!-- <requestedExecutionLevel level=\"requireAdministrator\"/> -->"
                     "<requestedExecutionLevel level=\"asInvoker\"/></assembly>") == no,
               "manifest-sample-tag-in-a-comment") &&
         Check(level("<assembly><![CDATA[<requestedExecutionLevel level=\"requireAdministrator\"/>]]>"
                     "<requestedExecutionLevel level=\"asInvoker\"/></assembly>") == no,
               "manifest-sample-tag-in-cdata") &&
         Check(level("<?xml version=\"1.0\"?><?sample <requestedExecutionLevel "
                     "level=\"requireAdministrator\"/> ?><assembly/>") == no,
               "manifest-sample-tag-in-a-processing-instruction") &&
         Check(level("<assembly><!-- note --><requestedExecutionLevel level=\"requireAdministrator\"/>"
                     "<!-- <requestedExecutionLevel level=\"asInvoker\"/> --></assembly>") == yes,
               "manifest-real-tag-outside-the-comments") &&
         Check(!level("<assembly><!-- <requestedExecutionLevel level=\"asInvoker\"/></assembly>")
                    .has_value(),
               "manifest-unclosed-comment") &&
         Check(!level("<assembly><![CDATA[ x </assembly>").has_value(), "manifest-unclosed-cdata") &&
         Check(!level("<?xml version=\"1.0\"<assembly/>").has_value(),
               "manifest-unclosed-processing-instruction") &&
         Check(level("<requestedExecutionLevel foo=\"a>b\" level=\"requireAdministrator\"/>") == yes,
               "manifest-gt-in-a-double-quoted-value") &&
         Check(level("<requestedExecutionLevel foo='>' level='requireAdministrator'/>") == yes,
               "manifest-gt-in-a-single-quoted-value") &&
         Check(level("<requestedExecutionLevel foo='a\">b' level=\"asInvoker\"/>") == no,
               "manifest-other-quote-inside-a-value") &&
         Check(!level("<assembly><requestedExecutionLevel foo=\"a>b level=\"asInvoker\"/></assembly>")
                    .has_value(),
               "manifest-unclosed-quote-to-the-end") &&
         Check(level("<requestedExecutionLevel level=\"asInvoker\"/>"
                     "<requestedExecutionLevel uiAccess=\"false\" level=\"highestAvailable\"/>") ==
                   yes,
               "manifest-later-element-elevated") &&
         Check(level("<requestedExecutionLevel level=\"asInvoker\" level=\"requireAdministrator\"/>") ==
                   yes,
               "manifest-repeated-level-any-elevated") &&
         Check(level("<requestedExecutionLevelX level=\"requireAdministrator\"/><assembly/>") == no,
               "manifest-longer-element-name-is-another-element") &&
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

bool CheckDescendantTimes();

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
         Check(FindWindowsDescendants(nodes, 900, 1, 64).nodes.empty(), "descendants-none") &&
         CheckDescendantTimes();
}

bool CheckDescendantTimes() {
  // The target 100 (created at 50). 900 is a SYSTEM orphan this helper could never open, created at
  // 10 under a parent that had pid 100 before the target reused it: with its time read from the
  // kernel snapshot it is not the target's child. 910 was created in the same tick as the target
  // (the deny direction: a child). 920 has no time (a source that cannot give one): a child, as are
  // its own children (930).
  const std::vector<WindowsProcessNode> nodes = {
      {100, 4, 50, "app.exe"},        {900, 100, 10, "orphan.exe"},
      {910, 100, 50, "same-tick.exe"}, {920, 100, std::nullopt, "untimed.exe"},
      {930, 920, 60, "below.exe"},
  };
  std::vector<std::uint32_t> pids;
  for (const std::size_t index : FindWindowsDescendants(nodes, 100, 50, 64).nodes)
    pids.push_back(nodes[index].pid);
  std::sort(pids.begin(), pids.end());
  return Check(std::find(pids.begin(), pids.end(), 900u) == pids.end(),
               "descendants-earlier-orphan-under-a-reused-pid-is-not-adopted") &&
         Check(std::find(pids.begin(), pids.end(), 910u) != pids.end(),
               "descendants-same-instant-is-a-child") &&
         Check(pids == std::vector<std::uint32_t>({910, 920, 930}),
               "descendants-untimed-is-a-child-with-its-children");
}

// A SystemProcessInformation buffer laid out at `address`: one 0x100-byte entry per process, each
// with its image name at entry + 0xc0.
struct SnapshotProcess {
  std::uint64_t pid;
  std::uint64_t parent;
  std::uint64_t created;
  std::u16string name;
};

void PutLe64(std::vector<std::uint8_t> &bytes, std::size_t at, std::uint64_t value) {
  PutLe(bytes, at, static_cast<std::uint32_t>(value & 0xffffffffu), 4);
  PutLe(bytes, at + 4, static_cast<std::uint32_t>(value >> 32), 4);
}

std::vector<std::uint8_t> SnapshotBuffer(const std::vector<SnapshotProcess> &processes,
                                         std::uint64_t address) {
  constexpr std::size_t kEntry = 0x100;
  std::vector<std::uint8_t> bytes(processes.size() * kEntry, 0);
  for (std::size_t index = 0; index < processes.size(); ++index) {
    const std::size_t at = index * kEntry;
    const SnapshotProcess &process = processes[index];
    PutLe(bytes, at, index + 1 < processes.size() ? static_cast<std::uint32_t>(kEntry) : 0, 4);
    PutLe64(bytes, at + kWindowsProcessEntryCreateTime, process.created);
    PutLe(bytes, at + kWindowsProcessEntryImageNameLength,
          static_cast<std::uint32_t>(process.name.size() * 2), 2);
    PutLe64(bytes, at + kWindowsProcessEntryImageNameBuffer,
            process.name.empty() ? 0 : address + at + 0xc0);
    for (std::size_t unit = 0; unit < process.name.size(); ++unit)
      PutLe(bytes, at + 0xc0 + unit * 2, process.name[unit], 2);
    PutLe64(bytes, at + kWindowsProcessEntryPid, process.pid);
    PutLe64(bytes, at + kWindowsProcessEntryParentPid, process.parent);
  }
  return bytes;
}

bool CheckProcessSnapshot() {
  constexpr std::uint64_t kAddress = 0x7ff600010000u;
  const std::vector<SnapshotProcess> processes = {
      {0, 0, 0, u""}, {4, 0, 100, u"System"}, {1234, 4, 0x01d9000000000000u, u"App.exe"}};
  const std::vector<std::uint8_t> buffer = SnapshotBuffer(processes, kAddress);
  const std::optional<std::vector<WindowsProcessNode>> nodes =
      ParseWindowsProcessSnapshot(buffer, kAddress, 64);
  const bool fields =
      nodes.has_value() && nodes->size() == 3 && (*nodes)[0].pid == 0 && (*nodes)[0].leaf.empty() &&
      (*nodes)[1].pid == 4 && (*nodes)[1].creation == std::optional<std::uint64_t>(100) &&
      (*nodes)[2].pid == 1234 && (*nodes)[2].parent_pid == 4 &&
      (*nodes)[2].creation == std::optional<std::uint64_t>(0x01d9000000000000u) &&
      (*nodes)[2].leaf == "App.exe";
  std::vector<std::uint8_t> next_outside = buffer;
  PutLe(next_outside, 0x100, 0x10000, 4);
  // An entry whose NextEntryOffset (0x50) lands inside itself, on bytes that read as a whole entry
  // (pid 9, the last): overlapping entries are refused, not read twice.
  std::vector<std::uint8_t> next_inside_entry(0x100, 0);
  PutLe(next_inside_entry, 0, 0x50, 4);
  PutLe(next_inside_entry, 0x50 + kWindowsProcessEntryPid, 9, 4);
  std::vector<std::uint8_t> name_outside = buffer;
  PutLe64(name_outside, 0x200 + kWindowsProcessEntryImageNameBuffer, kAddress + 0x10000);
  std::vector<std::uint8_t> name_below = buffer;
  PutLe64(name_below, 0x200 + kWindowsProcessEntryImageNameBuffer, kAddress - 2);
  std::vector<std::uint8_t> odd_name = buffer;
  PutLe(odd_name, 0x200 + kWindowsProcessEntryImageNameLength, 3, 2);
  std::vector<std::uint8_t> wide_pid = buffer;
  PutLe64(wide_pid, 0x200 + kWindowsProcessEntryPid, 0x100000000u);
  std::vector<std::uint8_t> truncated = buffer;
  truncated.resize(0x200 + kWindowsProcessEntryMinimum - 1);
  std::vector<std::uint8_t> surrogate = buffer;
  PutLe(surrogate, 0x200 + 0xc0, 0xd800, 2);
  const std::optional<std::vector<WindowsProcessNode>> unpaired =
      ParseWindowsProcessSnapshot(surrogate, kAddress, 64);
  return Check(fields, "snapshot-parent-creation-and-leaf-from-one-snapshot") &&
         Check(!ParseWindowsProcessSnapshot(next_outside, kAddress, 64).has_value(),
               "snapshot-next-entry-outside") &&
         Check(!ParseWindowsProcessSnapshot(next_inside_entry, kAddress, 64).has_value(),
               "snapshot-next-entry-inside-the-entry") &&
         Check(!ParseWindowsProcessSnapshot(name_outside, kAddress, 64).has_value() &&
                   !ParseWindowsProcessSnapshot(name_below, kAddress, 64).has_value(),
               "snapshot-name-outside-the-buffer") &&
         Check(!ParseWindowsProcessSnapshot(odd_name, kAddress, 64).has_value(),
               "snapshot-odd-name-length") &&
         Check(!ParseWindowsProcessSnapshot(wide_pid, kAddress, 64).has_value(),
               "snapshot-pid-wider-than-32-bits") &&
         Check(!ParseWindowsProcessSnapshot(truncated, kAddress, 64).has_value(),
               "snapshot-truncated-entry") &&
         Check(!ParseWindowsProcessSnapshot(buffer, kAddress, 2).has_value(),
               "snapshot-more-than-the-limit") &&
         Check(!ParseWindowsProcessSnapshot({}, kAddress, 64).has_value(), "snapshot-empty") &&
         Check(unpaired.has_value() && (*unpaired)[2].leaf.empty() && (*unpaired)[2].pid == 1234,
               "snapshot-unpaired-surrogate-name-is-empty");
}

bool CheckImageUnchanged() {
  using Times = std::optional<WindowsImageFileTimes>;
  const auto times = [](std::int64_t change, std::int64_t last_write) {
    return Times(WindowsImageFileTimes{change, last_write});
  };
  const std::optional<std::uint64_t> created = 1'000;
  return Check(WindowsImageUnchangedSinceCreation(times(500, 400), created),
               "image-unchanged-before-creation") &&
         Check(!WindowsImageUnchangedSinceCreation(times(1'000, 400), created),
               "image-change-time-at-creation-is-changed") &&
         Check(!WindowsImageUnchangedSinceCreation(times(1'001, 400), created),
               "image-changed-after-creation") &&
         // A future LastWriteTime (a ZIP's DOS local time from another time zone, a copy from a
         // machine whose clock ran ahead) with a ChangeTime before the creation: unchanged.
         Check(WindowsImageUnchangedSinceCreation(times(500, 2'000), created) &&
                   WindowsImageUnchangedSinceCreation(times(500, 1'000), created),
               "image-future-write-time-with-past-change-time-is-unchanged") &&
         Check(WindowsImageUnchangedSinceCreation(times(500, 0), created) &&
                   WindowsImageUnchangedSinceCreation(times(500, -1), created),
               "image-write-time-is-not-judged") &&
         Check(!WindowsImageUnchangedSinceCreation(std::nullopt, created) &&
                   !WindowsImageUnchangedSinceCreation(times(500, 400), std::nullopt),
               "image-times-unread-is-changed") &&
         Check(!WindowsImageUnchangedSinceCreation(times(0, 400), created) &&
                   !WindowsImageUnchangedSinceCreation(times(-1, 400), created),
               "image-change-time-zero-or-negative-is-changed");
}

// A PE32+ header with 16 data directories, the resource directory (2) at `resource_rva` of
// `resource_size`, and one section at `section_rva` of `virtual_size` (raw `raw_size`).
std::vector<std::uint8_t> ResourceHeader(std::uint32_t resource_rva, std::uint32_t resource_size,
                                         std::uint32_t section_rva, std::uint32_t virtual_size,
                                         std::uint32_t raw_size) {
  std::vector<std::uint8_t> bytes = PeHeader(0x20b, 2);
  bytes.resize(bytes.size() + 40, 0);
  PutLe(bytes, 0x80 + 6, 1, 2);
  PutLe(bytes, 0x80 + 24 + 108, 16, 4);
  PutLe(bytes, 0x80 + 24 + 112 + 2 * 8, resource_rva, 4);
  PutLe(bytes, 0x80 + 24 + 112 + 2 * 8 + 4, resource_size, 4);
  const std::size_t section = 0x80 + 24 + 240;
  PutLe(bytes, section + 8, virtual_size, 4);
  PutLe(bytes, section + 12, section_rva, 4);
  PutLe(bytes, section + 16, raw_size, 4);
  PutLe(bytes, section + 20, 0x400, 4);
  return bytes;
}

// A resource section at RVA 0x3000: type `type` -> name 1 -> `languages` data entries, each 4
// bytes ("abcd", "efgh", ...). The root also carries a named entry first, which is skipped.
std::vector<std::uint8_t> ResourceTree(std::uint16_t type, std::size_t languages) {
  std::vector<std::uint8_t> bytes(0x400, 0);
  constexpr std::uint32_t kHigh = 0x80000000u;
  // Root at 0: one named entry (to a name string at 0x300), one id entry.
  PutLe(bytes, 12, 1, 2);
  PutLe(bytes, 14, 1, 2);
  PutLe(bytes, 16, kHigh | 0x300, 4);
  PutLe(bytes, 20, kHigh | 0x80, 4);
  PutLe(bytes, 24, type, 4);
  PutLe(bytes, 28, kHigh | 0x20, 4);
  // Name directory at 0x20: id 1.
  PutLe(bytes, 0x20 + 14, 1, 2);
  PutLe(bytes, 0x20 + 16, 1, 4);
  PutLe(bytes, 0x20 + 20, kHigh | 0x40, 4);
  // Language directory at 0x40, its data entries at 0x100 + 16 * n, the data at 0x200 + 4 * n.
  PutLe(bytes, 0x40 + 14, static_cast<std::uint32_t>(languages), 2);
  for (std::size_t index = 0; index < languages; ++index) {
    PutLe(bytes, 0x40 + 16 + index * 8, static_cast<std::uint32_t>(0x409 + index), 4);
    PutLe(bytes, 0x40 + 16 + index * 8 + 4, static_cast<std::uint32_t>(0x100 + 16 * index), 4);
    PutLe(bytes, 0x100 + 16 * index, static_cast<std::uint32_t>(0x3000 + 0x200 + 4 * index), 4);
    PutLe(bytes, 0x100 + 16 * index + 4, 4, 4);
    for (std::size_t letter = 0; letter < 4; ++letter)
      bytes[0x200 + 4 * index + letter] = static_cast<std::uint8_t>('a' + 4 * index + letter);
  }
  return bytes;
}

bool CheckPeResources() {
  const std::optional<PeResourceSection> located =
      LocatePeResourceSection(ResourceHeader(0x3000, 0x400, 0x3000, 0x1000, 0x600));
  const std::optional<PeResourceSection> raw_sized =
      LocatePeResourceSection(ResourceHeader(0x3100, 0x100, 0x3000, 0, 0x600));
  const std::optional<PeResourceSection> none =
      LocatePeResourceSection(ResourceHeader(0, 0, 0x3000, 0x1000, 0x600));
  std::vector<std::uint8_t> two_directories = ResourceHeader(0x3000, 0x400, 0x3000, 0x1000, 0x600);
  PutLe(two_directories, 0x80 + 24 + 108, 2, 4);
  std::vector<std::uint8_t> cut_table = ResourceHeader(0x3000, 0x400, 0x3000, 0x1000, 0x600);
  cut_table.resize(cut_table.size() - 20);
  std::vector<std::uint8_t> not_pe = ResourceHeader(0x3000, 0x400, 0x3000, 0x1000, 0x600);
  not_pe[0] = 'X';
  const bool location =
      Check(located.has_value() && located->present && located->section_rva == 0x3000 &&
                located->section_size == 0x1000 && located->directory_rva == 0x3000,
            "resource-section-located") &&
      Check(raw_sized.has_value() && raw_sized->present && raw_sized->section_size == 0x600,
            "resource-section-without-virtual-size-uses-raw-size") &&
      Check(none.has_value() && !none->present, "resource-directory-empty-is-absent") &&
      Check(LocatePeResourceSection(two_directories).has_value() &&
                !LocatePeResourceSection(two_directories)->present,
            "resource-directory-beyond-rva-count-is-absent") &&
      Check(!LocatePeResourceSection(ResourceHeader(0x9000, 0x400, 0x3000, 0x1000, 0x600))
                 .has_value(),
            "resource-directory-in-no-section") &&
      Check(!LocatePeResourceSection(
                 ResourceHeader(0x3000, 0x400, 0x3000, kPeResourceSectionLimit + 1, 0x600))
                 .has_value(),
            "resource-section-over-the-limit") &&
      Check(!LocatePeResourceSection(cut_table).has_value(), "resource-section-table-truncated") &&
      Check(!LocatePeResourceSection(not_pe).has_value(), "resource-section-not-pe");

  const auto text = [](const std::span<const std::uint8_t> data) {
    return std::string(data.begin(), data.end());
  };
  const std::vector<std::uint8_t> one = ResourceTree(24, 1);
  const std::optional<std::vector<std::span<const std::uint8_t>>> found =
      FindPeResources(one, 0x3000, 0x3000, 24, 1);
  const std::vector<std::uint8_t> two = ResourceTree(16, 2);
  const std::optional<std::vector<std::span<const std::uint8_t>>> both =
      FindPeResources(two, 0x3000, 0x3000, 16, 1);
  const std::optional<std::vector<std::span<const std::uint8_t>>> no_language =
      FindPeResources(ResourceTree(24, 0), 0x3000, 0x3000, 24, 1);
  const std::optional<std::vector<std::span<const std::uint8_t>>> other_type =
      FindPeResources(one, 0x3000, 0x3000, 16, 1);
  const std::optional<std::vector<std::span<const std::uint8_t>>> other_name =
      FindPeResources(one, 0x3000, 0x3000, 24, 2);
  std::vector<std::uint8_t> language_directory = one;
  PutLe(language_directory, 0x40 + 16 + 4, 0x80000000u | 0x100, 4);
  std::vector<std::uint8_t> type_is_data = one;
  PutLe(type_is_data, 28, 0x20, 4);
  std::vector<std::uint8_t> subdirectory_outside = one;
  PutLe(subdirectory_outside, 0x20 + 20, 0x80000000u | 0x7ffffff0u, 4);
  std::vector<std::uint8_t> too_many_entries = one;
  PutLe(too_many_entries, 0x40 + 14, 0xffff, 2);
  std::vector<std::uint8_t> data_too_long = one;
  PutLe(data_too_long, 0x100 + 4, 0x10000, 4);
  std::vector<std::uint8_t> data_below = one;
  PutLe(data_below, 0x100, 0x2000, 4);
  std::vector<std::uint8_t> data_empty = one;
  PutLe(data_empty, 0x100 + 4, 0, 4);
  return location &&
         Check(found.has_value() && found->size() == 1 && text((*found)[0]) == "abcd",
               "resource-found") &&
         Check(both.has_value() && both->size() == 2 && text((*both)[0]) == "abcd" &&
                   text((*both)[1]) == "efgh",
               "resource-every-language") &&
         Check(other_type.has_value() && other_type->empty(), "resource-type-absent") &&
         Check(other_name.has_value() && other_name->empty(), "resource-name-absent") &&
         Check(no_language.has_value() && no_language->empty(), "resource-no-language-is-absent") &&
         Check(!FindPeResources(language_directory, 0x3000, 0x3000, 24, 1).has_value(),
               "resource-language-level-not-data") &&
         Check(!FindPeResources(type_is_data, 0x3000, 0x3000, 24, 1).has_value(),
               "resource-type-entry-not-a-directory") &&
         Check(!FindPeResources(subdirectory_outside, 0x3000, 0x3000, 24, 1).has_value(),
               "resource-subdirectory-outside") &&
         Check(!FindPeResources(too_many_entries, 0x3000, 0x3000, 24, 1).has_value(),
               "resource-entries-outside") &&
         Check(!FindPeResources(data_too_long, 0x3000, 0x3000, 24, 1).has_value(),
               "resource-data-outside") &&
         Check(!FindPeResources(data_below, 0x3000, 0x3000, 24, 1).has_value(),
               "resource-data-below-the-section") &&
         Check(!FindPeResources(data_empty, 0x3000, 0x3000, 24, 1).has_value(),
               "resource-data-empty") &&
         Check(!FindPeResources(one, 0x3000, 0x5000, 24, 1).has_value() &&
                   !FindPeResources(one, 0x3000, 0x2000, 24, 1).has_value(),
               "resource-directory-outside-the-section") &&
         Check(!FindPeResources({}, 0x3000, 0x3000, 24, 1).has_value(), "resource-empty-section");
}

// The v2 package identity (PR-4). The digest below is the one computer-use-grant-identity.test.ts
// recomputes from the same record, so native and Main agree on the formula.
bool CheckPackageIdentity() {
  const std::string install =
      "C:\\Program Files\\WindowsApps\\Microsoft.WindowsNotepad_11.2507.26.0_x64__8wekyb3d8bbwe";
  const WindowsPackageIdentityFacts store{true,
                                          "store",
                                          false,
                                          "Microsoft.WindowsNotepad_8wekyb3d8bbwe",
                                          "8wekyb3d8bbwe",
                                          "windows_apps",
                                          install + "\\Notepad\\Notepad.exe",
                                          install};
  const auto with = [&store](auto change) {
    WindowsPackageIdentityFacts facts = store;
    change(facts);
    return WindowsPackageIdentityFor(facts);
  };
  const std::optional<WindowsPackageIdentityParts> notepad = WindowsPackageIdentityFor(store);
  if (!Check(notepad.has_value() && notepad->family == "Microsoft.WindowsNotepad_8wekyb3d8bbwe" &&
                 notepad->publisher_id == "8wekyb3d8bbwe" &&
                 notepad->relative_path == "notepad\\notepad.exe" &&
                 notepad->preimage == "computer-win-identity-v2-package\n"
                                      "Microsoft.WindowsNotepad_8wekyb3d8bbwe\n8wekyb3d8bbwe\n"
                                      "notepad\\notepad.exe" &&
                 Sha256Hex(notepad->preimage) ==
                     "bc7613abbec5391168eb61a88ba5914d78b2b5f23dec37219a595c3dec622f6c",
             "package-identity-store"))
    return false;
  // A Store update moves the versioned directory and keeps the identity.
  const std::string updated =
      "C:\\Program Files\\WindowsApps\\Microsoft.WindowsNotepad_11.2510.6.0_x64__8wekyb3d8bbwe";
  const std::optional<WindowsPackageIdentityParts> after = with([&updated](auto &facts) {
    facts.install_root = updated;
    facts.image_path = updated + "\\Notepad\\Notepad.exe";
  });
  const std::optional<WindowsPackageIdentityParts> system =
      with([](auto &facts) { facts.signature_kind = "system"; });
  const std::optional<WindowsPackageIdentityParts> other_image =
      with([&install](auto &facts) { facts.image_path = install + "\\Notepad\\Helper.exe"; });
  if (!Check(after.has_value() && after->preimage == notepad->preimage, "package-identity-update") ||
      !Check(system.has_value() && system->preimage == notepad->preimage, "package-identity-system") ||
      !Check(other_image.has_value() && other_image->preimage != notepad->preimage,
             "package-identity-other-image"))
    return false;
  // Developer, Enterprise, sideloaded (none), development mode and unread facts keep the Win32
  // identity: no package identity.
  const bool refused =
      !with([](auto &facts) { facts.signature_kind = "developer"; }).has_value() &&
      !with([](auto &facts) { facts.signature_kind = "enterprise"; }).has_value() &&
      !with([](auto &facts) { facts.signature_kind = "none"; }).has_value() &&
      !with([](auto &facts) { facts.signature_kind = "Store"; }).has_value() &&
      !with([](auto &facts) { facts.signature_kind.reset(); }).has_value() &&
      !with([](auto &facts) { facts.development_mode = true; }).has_value() &&
      !with([](auto &facts) { facts.development_mode.reset(); }).has_value() &&
      !with([](auto &facts) { facts.packaged = false; }).has_value() &&
      !with([](auto &facts) { facts.packaged.reset(); }).has_value() &&
      !with([](auto &facts) { facts.family.reset(); }).has_value() &&
      !with([](auto &facts) { facts.publisher_id.reset(); }).has_value() &&
      !with([](auto &facts) { facts.image_path.reset(); }).has_value() &&
      !with([](auto &facts) { facts.install_root.reset(); }).has_value() &&
      !with([](auto &facts) { facts.install_root = std::string{}; }).has_value() &&
      !with([](auto &facts) { facts.image_root.reset(); }).has_value();
  // Outside WindowsApps (a %WINDIR% system package, Program Files, anything else) the Win32 rules
  // apply, and an image outside its own install location is no package image.
  const bool placed =
      !with([](auto &facts) { facts.image_root = "windows_directory"; }).has_value() &&
      !with([](auto &facts) { facts.image_root = "program_files"; }).has_value() &&
      !with([](auto &facts) { facts.image_root = "other"; }).has_value() &&
      !with([](auto &facts) {
        facts.image_path = "C:\\Program Files\\WindowsApps\\Other_1.0_x64__8wekyb3d8bbwe\\a.exe";
      }).has_value() &&
      !with([&install](auto &facts) { facts.image_path = install; }).has_value() &&
      !with([&install](auto &facts) { facts.image_path = install + "\\"; }).has_value() &&
      !with([&install](auto &facts) { facts.image_path = install + "X\\a.exe"; }).has_value();
  // The family must be the publisher's, and nothing may carry the preimage's separator.
  const bool shaped =
      !with([](auto &facts) { facts.family = "Microsoft.WindowsNotepad_0000000000000"; })
           .has_value() &&
      !with([](auto &facts) { facts.publisher_id = "8WEKYB3D8BBWE"; }).has_value() &&
      !with([](auto &facts) {
        facts.family = "Microsoft.WindowsNotepad_8wekyb3d8bbw";
        facts.publisher_id = "8wekyb3d8bbw";
      }).has_value() &&
      !with([](auto &facts) { facts.family = "Microsoft\nNotepad_8wekyb3d8bbwe"; }).has_value() &&
      !with([](auto &facts) { facts.family = "_8wekyb3d8bbwe"; }).has_value() &&
      !with([](auto &facts) { facts.family = "8wekyb3d8bbwe"; }).has_value() &&
      !with([&install](auto &facts) { facts.image_path = install + "\\a\nb.exe"; }).has_value();
  return Check(refused, "package-identity-only-store-or-system") &&
         Check(placed, "package-identity-only-under-its-install-root") &&
         Check(shaped, "package-identity-well-formed");
}

// S5-c-3 PR-5: the explicit "not web" table (System32 notepad: signature, canonical path, volume serial
// and file id). Only the very file is the entry; every other copy or change keeps the takeover.
bool CheckNotWebTable() {
  TargetFacts notepad;
  notepad.platform = TargetPlatform::kWin32;
  notepad.running_image_matches = true;
  notepad.signature = std::string("valid");
  notepad.signer_microsoft_root = true;
  notepad.packaged = false;
  notepad.image_root = std::string("windows_directory");
  notepad.image_relative_path = std::string("System32\\notepad.exe");
  WindowsFileKey file;
  file.volume_serial = 0x1234;
  file.file_id[0] = 7;
  WindowsFileKey other = file;
  other.file_id[15] = 1;
  WindowsFileKey other_volume = file;
  other_volume.volume_serial = 0x9999;
  const auto is = [](const TargetFacts &facts, std::optional<WindowsFileKey> held,
                     std::optional<WindowsFileKey> table, std::optional<WindowsFileKey> recorded,
                     bool session) {
    return WindowsTargetIsNotWebByTable(facts, held, table, recorded, session);
  };
  const bool entry = is(notepad, file, file, std::nullopt, false) && is(notepad, file, file, file, true);
  bool refused = true;
  // A copy anywhere else, a Store Notepad, another leaf, an unverified or non-Microsoft signature, a
  // mismatched running image, and each fact not measured.
  const auto without = [&](auto change) {
    TargetFacts facts = notepad;
    change(facts);
    return !is(facts, file, file, file, true);
  };
  refused = refused && without([](TargetFacts &f) { f.image_root = std::string("local_programs"); });
  refused = refused && without([](TargetFacts &f) {
              f.image_root = std::string("windows_apps");
              f.packaged = true;
            });
  refused = refused && without([](TargetFacts &f) { f.image_relative_path = std::string("SysWOW64\\notepad.exe"); });
  refused = refused && without([](TargetFacts &f) { f.image_relative_path = std::string("system32\\notepad.exe.exe"); });
  refused = refused && without([](TargetFacts &f) { f.signature = std::string("unsigned"); });
  refused = refused && without([](TargetFacts &f) { f.signer_microsoft_root = false; });
  refused = refused && without([](TargetFacts &f) { f.running_image_matches = false; });
  refused = refused && without([](TargetFacts &f) { f.running_image_matches.reset(); });
  refused = refused && without([](TargetFacts &f) { f.signature.reset(); });
  refused = refused && without([](TargetFacts &f) { f.signer_microsoft_root.reset(); });
  refused = refused && without([](TargetFacts &f) { f.packaged.reset(); });
  refused = refused && without([](TargetFacts &f) { f.image_root.reset(); });
  refused = refused && without([](TargetFacts &f) { f.image_relative_path.reset(); });
  // Not the file the system path names, the system path not opened, the held file not read, and a file
  // id or a volume that changed since the session recorded it: none comes back by itself.
  const bool files = !is(notepad, other, file, std::nullopt, false) &&
                     !is(notepad, file, std::nullopt, std::nullopt, false) &&
                     !is(notepad, std::nullopt, file, std::nullopt, false) &&
                     !is(notepad, other, other, file, true) &&
                     !is(notepad, other_volume, other_volume, file, true) &&
                     !is(notepad, file, file, std::nullopt, true);
  return Check(entry, "not-web-table-system-notepad") && Check(refused, "not-web-table-only-the-entry") &&
         Check(files, "not-web-table-only-the-very-file");
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
      !CheckPeSubsystem() || !CheckPeImageSummary() || !CheckManifestLevel() ||
      !CheckVersionInfo() ||
      !CheckDescendantLeaves() || !CheckDescendants() || !CheckProcessSnapshot() ||
      !CheckImageUnchanged() || !CheckPeResources() || !CheckPackageIdentity() ||
      !CheckNotWebTable())
    return 1;
  std::cout << "Computer Use target eligibility core: PASS (" << cases.size()
            << " golden vectors)\n";
  return 0;
}
