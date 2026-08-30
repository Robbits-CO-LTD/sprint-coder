#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Carbon/Carbon.h>
#import <CoreGraphics/CoreGraphics.h>
#import <CoreImage/CoreImage.h>
#import <Foundation/Foundation.h>
#import <ImageIO/ImageIO.h>
#import <Security/Security.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>

#include <node_api.h>

#include <algorithm>
#include <atomic>
#include <CommonCrypto/CommonDigest.h>
#include <charconv>
#include <cmath>
#include <cstdint>
#include <deque>
#include <dispatch/dispatch.h>
#include <libproc.h>
#include <mutex>
#include <limits>
#include <memory>
#include <set>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "computer_use_protocol.h"

@interface SprintCoderCaptureOutput : NSObject <SCStreamOutput>
@property(nonatomic, strong) dispatch_semaphore_t frameSemaphore;
@property(nonatomic, assign) CMSampleBufferRef sampleBuffer;
@end

@implementation SprintCoderCaptureOutput

- (void)stream:(SCStream*)stream
    didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer
                   ofType:(SCStreamOutputType)type {
  (void)stream;
  if (type != SCStreamOutputTypeScreen || self.sampleBuffer != nullptr || sampleBuffer == nullptr)
    return;
  CFArrayRef attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, false);
  if (attachments != nullptr && CFArrayGetCount(attachments) > 0) {
    const auto attachment = static_cast<CFDictionaryRef>(CFArrayGetValueAtIndex(attachments, 0));
    const auto status = static_cast<CFNumberRef>(
        CFDictionaryGetValue(attachment, (__bridge const void*)SCStreamFrameInfoStatus));
    int64_t frame_status = 0;
    if (status != nullptr) CFNumberGetValue(status, kCFNumberSInt64Type, &frame_status);
    if (frame_status != 0) return;
  }
  self.sampleBuffer = reinterpret_cast<CMSampleBufferRef>(const_cast<void*>(CFRetain(sampleBuffer)));
  dispatch_semaphore_signal(self.frameSemaphore);
}

@end

namespace {

using sprint_coder::computer_use::kApiVersion;
using sprint_coder::computer_use::kMaxBinaryBytes;
using sprint_coder::computer_use::kProtocolVersion;

std::atomic<std::uint64_t> cancellation_epoch{1};
constexpr std::size_t kMaxCaptureWidth = 2'560;
constexpr std::size_t kMaxCaptureHeight = 1'600;
constexpr std::size_t kMaxCaptureBytes = 8 * 1024 * 1024;
constexpr std::size_t kVisualPatchColumns = 16;
constexpr std::size_t kVisualPatchRows = 10;
constexpr std::size_t kVisualPatchWidth = 16;
constexpr std::size_t kVisualPatchHeight = 16;

struct MacComputerUseSession {
  std::string session_id;
  std::string app_identity;
  std::string executable_path;
  std::string process_generation;
  std::string window_identity;
  std::string policy_language = "unknown";
  std::string maximum_mode = "observe_only";
  std::uint32_t pid = 0;
  std::uint32_t window_id = 0;
  CGRect expected_bounds{};
  std::atomic<std::uint64_t> cancel_epoch{0};
  std::atomic<std::uint64_t> observation_publication_epoch{0};
  std::atomic<bool> observation_publication_claimed{false};
  std::atomic<bool> closed{false};
  std::mutex state_mutex;
  std::uint64_t observation_revision = 0;
  CGRect observation_bounds{};
  bool has_observation = false;
  std::uint64_t dialog_set_revision = 0;
  std::string dialog_set_digest;
  std::string active_window_identity;
  std::string active_window_kind = "application";
  std::uint32_t active_window_id = 0;
  std::string focused_control_signature;
  std::unordered_map<std::string, std::string> semantic_control_signatures;
  std::set<std::string> visual_control_signatures;
  std::vector<std::string> visual_patch_digests;
  struct ReplayEntry {
    std::string envelope_digest;
    std::string result;
    std::string reason_code;
    bool accepted = false;
    bool effect_started = false;
  };
  std::unordered_map<std::string, ReplayEntry> dispatch_replay_cache;
  std::deque<std::string> dispatch_replay_order;
  std::unordered_map<std::string, std::string> inflight_dispatches;
};

constexpr std::size_t kMaxDispatchReplayEntries = 128;
constexpr std::size_t kMaxInflightDispatchEntries = 1;
std::unordered_map<std::string, std::shared_ptr<MacComputerUseSession>> mac_sessions;
std::unordered_map<std::string, std::shared_ptr<MacComputerUseSession>> mac_pending_sessions;
std::mutex mac_sessions_mutex;
std::mutex mac_dispatch_serial_mutex;

std::shared_ptr<MacComputerUseSession> FindMacSession(std::string_view session_id) {
  std::lock_guard<std::mutex> sessions_lock(mac_sessions_mutex);
  const auto found = mac_sessions.find(std::string(session_id));
  return found == mac_sessions.end() ? nullptr : found->second;
}

std::shared_ptr<MacComputerUseSession> FindCancelableMacSession(
    std::string_view session_id) {
  std::lock_guard<std::mutex> sessions_lock(mac_sessions_mutex);
  const auto active = mac_sessions.find(std::string(session_id));
  if (active != mac_sessions.end()) return active->second;
  const auto pending = mac_pending_sessions.find(std::string(session_id));
  return pending == mac_pending_sessions.end() ? nullptr : pending->second;
}

struct AxRiskClassification {
  bool classified = false;
  bool secure = false;
  bool high_impact = false;
};

enum class AxFocusedWindowBoundary {
  kAllowed,
  kUnclassified,
  kUserTakeover,
};

struct MacDialogSetSnapshot {
  AxFocusedWindowBoundary boundary = AxFocusedWindowBoundary::kUnclassified;
  std::uint32_t active_window_id = 0;
  CGRect active_bounds{};
  std::string active_window_identity;
  std::string active_window_kind;
  std::string dialog_set_digest;
};

SCWindow* ResolveShareableWindow(std::uint32_t pid, std::uint32_t window_id);
bool ReadWindowBounds(std::uint32_t window_id, CGRect* bounds);
bool ReadFrontmostWindow(std::uint32_t pid, std::uint32_t* window_id, CGRect* bounds);
bool ReadAccessibilityWindowBounds(AXUIElementRef window, CGRect* bounds);
AXUIElementRef FindUniqueAccessibilityWindow(std::uint32_t pid,
                                             const CGRect& expected_bounds);
bool BoundsEqual(const CGRect& left, const CGRect& right);
AXUIElementRef CopyAccessibilityElementAttribute(AXUIElementRef element,
                                                 CFStringRef attribute);
bool CheckCancellationEpoch(std::uint64_t expected);
bool ReadNamedUInt64(napi_env env, napi_value object, const char* name,
                     std::uint64_t* output);
AxRiskClassification ClassifyFocusedElement(std::uint32_t pid,
                                             std::string* control_signature = nullptr);
AxFocusedWindowBoundary ClassifyFocusedWindowBoundary(std::uint32_t pid);
bool CaptureMacDialogSetSnapshot(std::uint32_t pid, std::uint32_t base_window_id,
                                 std::string_view app_identity,
                                 std::string_view process_generation,
                                 MacDialogSetSnapshot* output,
                                 bool require_frontmost = true);
std::string LowercaseAscii(std::string value);
bool ContainsAny(std::string_view haystack, const std::vector<std::string_view>& needles);
bool CopyAccessibilityString(AXUIElementRef element, CFStringRef attribute,
                             std::string* output);
bool CopyAccessibilityBoolean(AXUIElementRef element, CFStringRef attribute, bool* output);
bool IsDialogAccessibilityDescriptor(std::string_view role, std::string_view subrole);
bool IsFileOrSystemPromptTitle(std::string_view title);

napi_value StringValue(napi_env env, const char* value) {
  napi_value result;
  napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &result);
  return result;
}

napi_value BoolValue(napi_env env, bool value) {
  napi_value result;
  napi_get_boolean(env, value, &result);
  return result;
}

napi_value NumberValue(napi_env env, double value) {
  napi_value result;
  napi_create_double(env, value, &result);
  return result;
}

napi_value ThrowNativeError(napi_env env, const char* code, const char* message) {
  napi_value error;
  napi_create_error(env, nullptr, StringValue(env, message), &error);
  napi_set_named_property(env, error, "code", StringValue(env, code));
  napi_set_named_property(env, error, "accepted", BoolValue(env, false));
  napi_set_named_property(env, error, "effectStarted", BoolValue(env, false));
  napi_throw(env, error);
  return nullptr;
}

napi_value NativeErrorValue(napi_env env, const char* code, const char* message) {
  napi_value error;
  napi_create_error(env, nullptr, StringValue(env, message), &error);
  napi_set_named_property(env, error, "code", StringValue(env, code));
  napi_set_named_property(env, error, "accepted", BoolValue(env, false));
  napi_set_named_property(env, error, "effectStarted", BoolValue(env, false));
  return error;
}

void SetNativeAsyncError(std::string* code, std::string* message,
                         const char* next_code, const char* next_message) {
  if (!code->empty()) return;
  *code = next_code;
  *message = next_message;
}

bool ReadNamedUint32(napi_env env, napi_value object, const char* name, std::uint32_t* output) {
  napi_value value;
  if (napi_get_named_property(env, object, name, &value) != napi_ok) return false;
  if (napi_get_value_uint32(env, value, output) == napi_ok) return true;
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok || length == 0 ||
      length > 10)
    return false;
  std::string buffer(length + 1, '\0');
  if (napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(), &length) != napi_ok)
    return false;
  buffer.resize(length);
  const auto parsed = std::from_chars(buffer.data(), buffer.data() + length, *output);
  return parsed.ec == std::errc{} && parsed.ptr == buffer.data() + length && *output > 0;
}

bool ReadNamedDouble(napi_env env, napi_value object, const char* name, double* output) {
  napi_value value;
  if (napi_get_named_property(env, object, name, &value) != napi_ok) return false;
  return napi_get_value_double(env, value, output) == napi_ok && std::isfinite(*output);
}

bool ReadOptionalNamedBool(napi_env env, napi_value object, const char* name,
                           bool* output) {
  bool has_property = false;
  if (napi_has_named_property(env, object, name, &has_property) != napi_ok)
    return false;
  if (!has_property) {
    *output = false;
    return true;
  }
  napi_value value;
  return napi_get_named_property(env, object, name, &value) == napi_ok &&
         napi_get_value_bool(env, value, output) == napi_ok;
}

bool ReadNamedString(napi_env env, napi_value object, const char* name, std::string* output,
                     std::size_t maximum = 256) {
  napi_value value;
  if (napi_get_named_property(env, object, name, &value) != napi_ok) return false;
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok ||
      length == 0 || length > maximum)
    return false;
  std::string buffer(length + 1, '\0');
  if (napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(), &length) != napi_ok)
    return false;
  buffer.resize(length);
  if (buffer.find('\0') != std::string::npos) return false;
  *output = std::move(buffer);
  return true;
}

bool ReadValueString(napi_env env, napi_value object, const char* name, std::string* output) {
  napi_value value;
  if (napi_get_named_property(env, object, name, &value) != napi_ok) return false;
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok || length == 0 ||
      length > 4'096)
    return false;
  std::string buffer(length + 1, '\0');
  if (napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(), &length) != napi_ok)
    return false;
  buffer.resize(length);
  *output = std::move(buffer);
  return true;
}

bool IsObject(napi_env env, napi_value value) {
  napi_valuetype type;
  return napi_typeof(env, value, &type) == napi_ok && type == napi_object;
}

bool IsAccessibilityTrusted() {
  // Do not pass kAXTrustedCheckOptionPrompt: opening a native permission prompt from a probe
  // makes a supposedly read-only availability query mutate system state.
  return AXIsProcessTrusted();
}

bool IsScreenCapturePermitted() {
  if (@available(macOS 10.15, *)) return CGPreflightScreenCaptureAccess();
  return false;
}

bool IsScreenCaptureKitAvailable() {
  if (@available(macOS 12.3, *)) return NSClassFromString(@"SCShareableContent") != nil;
  return false;
}

std::uint32_t FrontmostPid() {
  NSRunningApplication* application = NSWorkspace.sharedWorkspace.frontmostApplication;
  return application == nil ? 0 : static_cast<std::uint32_t>(application.processIdentifier);
}

std::string HexDigest(const void* bytes, std::size_t size) {
  unsigned char digest[CC_SHA256_DIGEST_LENGTH] = {};
  CC_SHA256(bytes, static_cast<CC_LONG>(size), digest);
  static constexpr char hexadecimal[] = "0123456789abcdef";
  std::string result(CC_SHA256_DIGEST_LENGTH * 2, '0');
  for (std::size_t index = 0; index < CC_SHA256_DIGEST_LENGTH; ++index) {
    result[index * 2] = hexadecimal[digest[index] >> 4];
    result[index * 2 + 1] = hexadecimal[digest[index] & 0xf];
  }
  return result;
}

std::string StringDigest(std::string_view value) {
  return HexDigest(value.data(), value.size());
}

bool ReadProcessGenerationToken(std::uint32_t pid, std::string* output) {
  if (pid == 0 || output == nullptr) return false;
  proc_bsdinfo process_info{};
  const int copied = proc_pidinfo(static_cast<int>(pid), PROC_PIDTBSDINFO, 0,
                                  &process_info, PROC_PIDTBSDINFO_SIZE);
  if (copied != PROC_PIDTBSDINFO_SIZE || process_info.pbi_pid != pid ||
      process_info.pbi_start_tvsec == 0)
    return false;
  *output = StringDigest(
      "computer-process-generation-v1\n" + std::to_string(pid) + "\n" +
      std::to_string(process_info.pbi_start_tvsec) + ":" +
      std::to_string(process_info.pbi_start_tvusec));
  return !output->empty();
}

bool CurrentProcessGenerationMatches(const MacComputerUseSession& session) {
  std::string current_process_generation;
  return !session.process_generation.empty() &&
         ReadProcessGenerationToken(session.pid, &current_process_generation) &&
         current_process_generation == session.process_generation;
}

std::string FileDigest(NSString* path) {
  NSData* bytes = [NSData dataWithContentsOfFile:path options:NSDataReadingMappedIfSafe error:nil];
  if (bytes == nil || bytes.length == 0) return {};
  return HexDigest(bytes.bytes, bytes.length);
}

bool CopySigningFacts(NSString* executable, std::string* team_id, std::string* identifier,
                      std::string* cd_hash) {
  CFURLRef url = (__bridge CFURLRef)[NSURL fileURLWithPath:executable];
  SecStaticCodeRef code = nullptr;
  if (SecStaticCodeCreateWithPath(url, kSecCSDefaultFlags, &code) != errSecSuccess || code == nullptr)
    return false;
  const SecCSFlags validation_flags =
      kSecCSStrictValidate | kSecCSCheckAllArchitectures;
  if (SecStaticCodeCheckValidity(code, validation_flags, nullptr) != errSecSuccess) {
    CFRelease(code);
    return false;
  }
  CFDictionaryRef information = nullptr;
  const OSStatus result = SecCodeCopySigningInformation(code, kSecCSSigningInformation, &information);
  CFRelease(code);
  if (result != errSecSuccess || information == nullptr) {
    if (information != nullptr) CFRelease(information);
    return false;
  }
  auto copyString = [&](const void* key, std::string* output) {
    const auto value = static_cast<CFStringRef>(CFDictionaryGetValue(information, key));
    if (value == nullptr || CFGetTypeID(value) != CFStringGetTypeID()) return false;
    char buffer[257] = {};
    if (!CFStringGetCString(value, buffer, sizeof(buffer), kCFStringEncodingUTF8)) return false;
    *output = buffer;
    return !output->empty();
  };
  const bool copied_identifier = copyString(kSecCodeInfoIdentifier, identifier);
  const bool copied_team = copyString(kSecCodeInfoTeamIdentifier, team_id);
  const auto hash_data = static_cast<CFDataRef>(CFDictionaryGetValue(information, kSecCodeInfoUnique));
  if (hash_data != nullptr && CFGetTypeID(hash_data) == CFDataGetTypeID())
    *cd_hash = HexDigest(CFDataGetBytePtr(hash_data), static_cast<std::size_t>(CFDataGetLength(hash_data)));
  CFRelease(information);
  return copied_identifier && copied_team;
}

bool ReadWindowTitle(CFDictionaryRef window, std::string* title) {
  const auto value = static_cast<CFStringRef>(CFDictionaryGetValue(window, kCGWindowName));
  if (value == nullptr || CFGetTypeID(value) != CFStringGetTypeID()) return false;
  char buffer[513] = {};
  if (!CFStringGetCString(value, buffer, sizeof(buffer), kCFStringEncodingUTF8)) return false;
  *title = buffer;
  return true;
}

struct IdentityFacts {
  std::string identity_digest;
  std::string bundle_id;
  std::string executable_path;
  std::string executable_digest;
  std::string team_id;
  std::string signing_identifier;
  std::string cd_hash;
  std::string display_name;
  std::string policy_language = "unknown";
  bool signed_target = false;
};

std::string Utf8String(NSString* value) {
  return value == nil || value.UTF8String == nullptr ? "" : value.UTF8String;
}

std::string PathBasename(std::string_view path) {
  const std::size_t separator = path.find_last_of("/\\");
  return std::string(separator == std::string_view::npos ? path : path.substr(separator + 1));
}

bool SameMacExecutablePath(NSString* actual_path, std::string_view expected_path) {
  if (actual_path == nil || expected_path.empty()) return false;
  NSString* expected = [[NSString alloc] initWithBytes:expected_path.data()
                                                length:expected_path.size()
                                              encoding:NSUTF8StringEncoding];
  if (expected == nil) return false;
  NSString* normalized_actual =
      [[actual_path stringByResolvingSymlinksInPath] stringByStandardizingPath];
  NSString* normalized_expected =
      [[expected stringByResolvingSymlinksInPath] stringByStandardizingPath];
  return [normalized_actual isEqualToString:normalized_expected];
}

bool IsExactSystemTextEdit(NSString* bundle_id_string,
                           NSString* executable_string) {
  return Utf8String(bundle_id_string) == "com.apple.TextEdit" &&
         SameMacExecutablePath(
             executable_string,
             "/System/Applications/TextEdit.app/Contents/MacOS/TextEdit");
}

bool IsOfficialMicrosoftVisualStudioCodeFacts(
    std::string_view bundle_id, std::string_view team_id,
    std::string_view signing_identifier) {
  return bundle_id == "com.microsoft.VSCode" && team_id == "UBF8T346G9" &&
         signing_identifier == "com.microsoft.VSCode";
}

bool IsOfficialMicrosoftVisualStudioCode(NSString* bundle_id_string,
                                         NSString* executable_string) {
  if (Utf8String(bundle_id_string) != "com.microsoft.VSCode" ||
      executable_string == nil)
    return false;
  std::string team_id;
  std::string signing_identifier;
  std::string cd_hash;
  return CopySigningFacts(executable_string, &team_id, &signing_identifier,
                          &cd_hash) &&
         IsOfficialMicrosoftVisualStudioCodeFacts(
             Utf8String(bundle_id_string), team_id, signing_identifier);
}

bool IsMacComputerUseApplicationEligible(NSString* bundle_id_string,
                                         NSString* display_name_string,
                                         NSString* executable_string) {
  (void)display_name_string;
  const std::string normalized_bundle_id =
      LowercaseAscii(Utf8String(bundle_id_string));
  static const std::set<std::string> explicitly_prohibited_bundle_ids = {
      "com.apple.installer",
      "com.apple.remotedesktop",
      "com.apple.screensharing",
      "com.apple.systempreferences",
      "com.apple.terminal",
      "com.carriez.rustdesk",
      "com.googlecode.iterm2",
      "com.microsoft.rdc.macos",
      "com.parsecgaming.parsec",
      "com.splashtop.splashtop-remote-desktop",
      "dev.warp.warp-stable",
  };
  if (explicitly_prohibited_bundle_ids.contains(normalized_bundle_id))
    return false;
  if (IsExactSystemTextEdit(bundle_id_string, executable_string)) return true;
  if (IsOfficialMicrosoftVisualStudioCode(bundle_id_string,
                                          executable_string))
    return true;
  return false;
}

bool IsMacComputerUseApplicationEligible(NSRunningApplication* application) {
  return application != nil && application.executableURL != nil &&
         IsMacComputerUseApplicationEligible(application.bundleIdentifier,
                                              application.localizedName,
                                              application.executableURL.path);
}

bool IsMacComputerUseBundleEligible(NSBundle* bundle) {
  if (bundle == nil || bundle.executableURL == nil) return false;
  NSString* display_name = bundle.localizedInfoDictionary[@"CFBundleDisplayName"];
  if (display_name == nil) display_name = bundle.infoDictionary[@"CFBundleName"];
  if (display_name == nil) display_name = bundle.bundleIdentifier;
  return IsMacComputerUseApplicationEligible(bundle.bundleIdentifier, display_name,
                                              bundle.executableURL.path);
}

bool IsCurrentApplicationEligible(std::uint32_t pid) {
  return IsMacComputerUseApplicationEligible(
      [NSRunningApplication runningApplicationWithProcessIdentifier:static_cast<pid_t>(pid)]);
}

bool IsMacSystemUserTakeoverApplication(std::uint32_t pid) {
  NSRunningApplication* application =
      [NSRunningApplication runningApplicationWithProcessIdentifier:static_cast<pid_t>(pid)];
  if (application == nil) return false;
  const std::string bundle_id = LowercaseAscii(Utf8String(application.bundleIdentifier));
  const std::string name = LowercaseAscii(Utf8String(application.localizedName));
  return ContainsAny(bundle_id,
                     {"com.apple.securityagent", "com.apple.coreservicesuiagent",
                      "com.apple.appkit.xpc.openandsavepanelservice",
                      "com.apple.authorizationhost", "com.apple.systempreferences"}) ||
         ContainsAny(name, {"securityagent", "authorizationhost", "system settings",
                            "open and save panel service"});
}

std::string StrictPolicyLanguageFromLocaleIdentifier(NSString* identifier) {
  if (identifier == nil || identifier.length == 0) return "unknown";
  NSString* normalized = identifier.lowercaseString;
  if ([normalized isEqualToString:@"en"] || [normalized hasPrefix:@"en-"] ||
      [normalized hasPrefix:@"en_"])
    return "en";
  if ([normalized isEqualToString:@"ja"] || [normalized hasPrefix:@"ja-"] ||
      [normalized hasPrefix:@"ja_"])
    return "ja";
  return "unknown";
}

NSBundle* MacBundleForExecutable(NSString* executable) {
  if (executable == nil || executable.length == 0) return nil;
  NSString* candidate = [executable stringByDeletingLastPathComponent];
  for (std::size_t depth = 0; depth < 4 && candidate.length > 1; ++depth) {
    if ([candidate.pathExtension.lowercaseString isEqualToString:@"app"]) {
      NSBundle* bundle = [NSBundle bundleWithPath:candidate];
      if (bundle != nil && bundle.executableURL != nil &&
          SameMacExecutablePath(bundle.executableURL.path, Utf8String(executable)))
        return bundle;
      return nil;
    }
    candidate = [candidate stringByDeletingLastPathComponent];
  }
  return nil;
}

std::string PolicyLanguageForMacBundle(NSBundle* bundle) {
  if (bundle == nil || bundle.bundleIdentifier.length == 0) return "unknown";
  NSDictionary<NSString*, id>* target_domain =
      [[NSUserDefaults standardUserDefaults]
          persistentDomainForName:bundle.bundleIdentifier];
  id explicit_languages = target_domain[@"AppleLanguages"];
  if (explicit_languages != nil) {
    if ([explicit_languages isKindOfClass:[NSString class]])
      return StrictPolicyLanguageFromLocaleIdentifier(
          static_cast<NSString*>(explicit_languages));
    if (![explicit_languages isKindOfClass:[NSArray class]]) return "unknown";
    NSArray* languages = static_cast<NSArray*>(explicit_languages);
    if (languages.count != 1 ||
        ![languages.firstObject isKindOfClass:[NSString class]])
      return "unknown";
    return StrictPolicyLanguageFromLocaleIdentifier(
        static_cast<NSString*>(languages.firstObject));
  }
  CFPropertyListRef global_languages_value = CFPreferencesCopyValue(
      CFSTR("AppleLanguages"), kCFPreferencesAnyApplication,
      kCFPreferencesCurrentUser, kCFPreferencesAnyHost);
  if (global_languages_value == nullptr ||
      CFGetTypeID(global_languages_value) != CFArrayGetTypeID()) {
    if (global_languages_value != nullptr) CFRelease(global_languages_value);
    return "unknown";
  }
  NSArray* global_languages = (__bridge NSArray*)global_languages_value;
  bool valid_preferences = global_languages.count > 0;
  for (id language in global_languages)
    valid_preferences = valid_preferences &&
                        [language isKindOfClass:[NSString class]];
  NSArray<NSString*>* preferred =
      valid_preferences
          ? [NSBundle preferredLocalizationsFromArray:bundle.localizations
                                       forPreferences:global_languages]
          : nil;
  CFRelease(global_languages_value);
  if (preferred.count != 1 ||
      ![preferred.firstObject isKindOfClass:[NSString class]])
    return "unknown";
  return StrictPolicyLanguageFromLocaleIdentifier(preferred.firstObject);
}

std::string PolicyLanguageForMacExecutable(NSString* executable) {
  return PolicyLanguageForMacBundle(MacBundleForExecutable(executable));
}

std::string MaximumModeForIdentityFacts(const IdentityFacts& facts) {
  const bool policy_language_attested =
      facts.policy_language == "en" || facts.policy_language == "ja";
  if (IsExactSystemTextEdit(
          [NSString stringWithUTF8String:facts.bundle_id.c_str()],
          [NSString stringWithUTF8String:facts.executable_path.c_str()]) &&
      policy_language_attested)
    return "full_access_app";
  if (facts.signed_target && IsOfficialMicrosoftVisualStudioCodeFacts(
                                 facts.bundle_id, facts.team_id,
                                 facts.signing_identifier))
    return "supervised";
  return "observe_only";
}

void SetScreenBoundsProperty(napi_env env, napi_value object,
                             const CGRect& bounds) {
  napi_value screen;
  napi_create_object(env, &screen);
  napi_set_named_property(env, screen, "x", NumberValue(env, bounds.origin.x));
  napi_set_named_property(env, screen, "y", NumberValue(env, bounds.origin.y));
  napi_set_named_property(env, screen, "width",
                          NumberValue(env, bounds.size.width));
  napi_set_named_property(env, screen, "height",
                          NumberValue(env, bounds.size.height));
  napi_set_named_property(env, object, "screenBounds", screen);
}

bool BuildIdentityFacts(NSString* executable, NSString* bundle_id_string,
                        NSString* display_name_string, IdentityFacts* output) {
  if (executable == nil || executable.length == 0) return false;
  const std::string executable_digest = FileDigest(executable);
  if (executable_digest.empty()) return false;
  std::string team_id;
  std::string signing_identifier;
  std::string cd_hash;
  const bool signed_target = CopySigningFacts(executable, &team_id, &signing_identifier, &cd_hash);
  const std::string bundle_id = bundle_id_string.UTF8String == nullptr ? "" : bundle_id_string.UTF8String;
  const std::string display_name = display_name_string.UTF8String == nullptr
                                       ? bundle_id
                                       : display_name_string.UTF8String;
  if (bundle_id.empty()) return false;
  // A signed app's identity is stable across updates: designated requirement facts identify the
  // app while the executable digest is retained only as a re-observed metadata fact. Unsigned
  // targets have no stable signer, so they remain bound to the exact executable bytes.
  const std::string identity_digest = signed_target
                                          ? StringDigest("computer-app-identity-v2\n" + bundle_id +
                                                         "\n" + team_id + "\n" + signing_identifier)
                                          : StringDigest("computer-app-identity-v2-unsigned\n" +
                                                         bundle_id + "\n" + executable_digest);
  output->identity_digest = identity_digest;
  output->bundle_id = bundle_id;
  output->executable_path = executable.UTF8String == nullptr ? "" : executable.UTF8String;
  output->executable_digest = executable_digest;
  output->team_id = team_id;
  output->signing_identifier = signing_identifier;
  output->cd_hash = cd_hash;
  output->display_name = display_name;
  output->policy_language = PolicyLanguageForMacExecutable(executable);
  output->signed_target = signed_target;
  return !output->executable_path.empty();
}

napi_value IdentityObjectFromFacts(napi_env env, const IdentityFacts& facts, std::uint32_t pid) {
  napi_value result;
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "platform", StringValue(env, "darwin"));
  napi_set_named_property(env, result, "identityDigest", StringValue(env, facts.identity_digest.c_str()));
  napi_set_named_property(env, result, "bundleId", StringValue(env, facts.bundle_id.c_str()));
  napi_set_named_property(env, result, "executablePath", StringValue(env, facts.executable_path.c_str()));
  napi_set_named_property(env, result, "executableDigest", StringValue(env, facts.executable_digest.c_str()));
  if (facts.signed_target) {
    napi_set_named_property(env, result, "teamId", StringValue(env, facts.team_id.c_str()));
    napi_set_named_property(env, result, "signingIdentifier", StringValue(env, facts.signing_identifier.c_str()));
    if (!facts.cd_hash.empty())
      napi_set_named_property(env, result, "cdHash", StringValue(env, facts.cd_hash.c_str()));
    else {
      napi_value null_value;
      napi_get_null(env, &null_value);
      napi_set_named_property(env, result, "cdHash", null_value);
    }
  } else {
    napi_value null_value;
    napi_get_null(env, &null_value);
    napi_set_named_property(env, result, "teamId", null_value);
    napi_set_named_property(env, result, "signingIdentifier", null_value);
    napi_set_named_property(env, result, "cdHash", null_value);
  }
  napi_set_named_property(env, result, "displayName", StringValue(env, facts.display_name.c_str()));
  napi_set_named_property(env, result, "policyLanguage",
                          StringValue(env, facts.policy_language.c_str()));
  const std::string maximum_mode = MaximumModeForIdentityFacts(facts);
  napi_set_named_property(env, result, "maximumMode",
                          StringValue(env, maximum_mode.c_str()));
  // `pid` is a Main-only ephemeral binding used by the native adapter and is stripped before
  // the identity crosses any IPC boundary.
  napi_value process_id;
  napi_create_uint32(env, pid, &process_id);
  napi_set_named_property(env, result, "pid", process_id);
  return result;
}

napi_value IdentityObject(napi_env env, NSRunningApplication* application, std::uint32_t pid) {
  if (application == nil || application.executableURL == nil) return nullptr;
  std::string process_generation;
  if (pid == 0 || !ReadProcessGenerationToken(pid, &process_generation)) return nullptr;
  IdentityFacts facts;
  if (!BuildIdentityFacts(application.executableURL.path, application.bundleIdentifier,
                          application.localizedName, &facts))
    return nullptr;
  std::string confirmed_process_generation;
  NSRunningApplication* current =
      [NSRunningApplication runningApplicationWithProcessIdentifier:static_cast<pid_t>(pid)];
  if (current == nil || current.executableURL == nil ||
      !SameMacExecutablePath(current.executableURL.path, facts.executable_path) ||
      !ReadProcessGenerationToken(pid, &confirmed_process_generation) ||
      confirmed_process_generation != process_generation)
    return nullptr;
  return IdentityObjectFromFacts(env, facts, pid);
}

napi_value IdentityObjectFromBundle(napi_env env, NSURL* bundle_url, std::uint32_t pid) {
  if (bundle_url == nil) return nullptr;
  NSBundle* bundle = [NSBundle bundleWithURL:bundle_url];
  if (bundle == nil || bundle.executableURL == nil) return nullptr;
  IdentityFacts facts;
  NSString* display = bundle.localizedInfoDictionary[@"CFBundleDisplayName"];
  if (display == nil) display = bundle.infoDictionary[@"CFBundleName"];
  if (display == nil) display = bundle.bundleIdentifier;
  if (!BuildIdentityFacts(bundle.executableURL.path, bundle.bundleIdentifier, display, &facts))
    return nullptr;
  return IdentityObjectFromFacts(env, facts, pid);
}

bool CurrentApplicationMatchesIdentityNative(
    std::uint32_t pid, std::string_view expected_identity,
    std::string_view expected_executable_path = {}) {
  NSRunningApplication* application =
      [NSRunningApplication runningApplicationWithProcessIdentifier:static_cast<pid_t>(pid)];
  if (application == nil || application.executableURL == nil ||
      (!expected_executable_path.empty() &&
       !SameMacExecutablePath(application.executableURL.path, expected_executable_path)))
    return false;
  IdentityFacts facts;
  return BuildIdentityFacts(application.executableURL.path, application.bundleIdentifier,
                            application.localizedName, &facts) &&
         facts.identity_digest == expected_identity;
}

bool CurrentApplicationMatchesIdentity(napi_env env, std::uint32_t pid,
                                       std::string_view expected_identity,
                                       std::string_view expected_executable_path = {}) {
  (void)env;
  return CurrentApplicationMatchesIdentityNative(pid, expected_identity,
                                                 expected_executable_path);
}

bool ReadNestedString(napi_env env, napi_value object, const char* parent, const char* name,
                      std::string* output) {
  napi_value nested;
  if (napi_get_named_property(env, object, parent, &nested) != napi_ok || !IsObject(env, nested))
    return false;
  return ReadNamedString(env, nested, name, output);
}

std::uint32_t ResolveRunningApplicationForIdentity(napi_env env, napi_value request,
                                                   std::string_view expected_identity,
                                                   std::string_view expected_executable_path) {
  std::string bundle_id;
  if (!ReadNestedString(env, request, "identity", "bundleId", &bundle_id)) return 0;
  NSRunningApplication* selected = nil;
  bool selected_frontmost = false;
  for (NSRunningApplication* application in NSWorkspace.sharedWorkspace.runningApplications) {
    if (application.bundleIdentifier == nil || application.executableURL == nil ||
        !SameMacExecutablePath(application.executableURL.path, expected_executable_path) ||
        ![application.bundleIdentifier isEqualToString:[NSString stringWithUTF8String:bundle_id.c_str()]])
      continue;
    napi_value identity = IdentityObject(env, application,
                                         static_cast<std::uint32_t>(application.processIdentifier));
    std::string actual_identity;
    if (identity == nullptr || !ReadValueString(env, identity, "identityDigest", &actual_identity) ||
        actual_identity != expected_identity)
      continue;
    const bool frontmost = application == NSWorkspace.sharedWorkspace.frontmostApplication;
    if (selected == nil || (frontmost && !selected_frontmost)) {
      selected = application;
      selected_frontmost = frontmost;
    }
  }
  return selected == nil ? 0 : static_cast<std::uint32_t>(selected.processIdentifier);
}

NSURL* ExactApplicationBundleUrlForExecutable(std::string_view executable_path) {
  NSString* executable = [[NSString alloc] initWithBytes:executable_path.data()
                                                   length:executable_path.size()
                                                 encoding:NSUTF8StringEncoding];
  if (executable == nil) return nil;
  NSString* cursor =
      [[executable stringByResolvingSymlinksInPath] stringByStandardizingPath];
  while (cursor.length > 1) {
    if ([cursor.pathExtension.lowercaseString isEqualToString:@"app"]) {
      NSBundle* bundle = [NSBundle bundleWithPath:cursor];
      if (bundle != nil && bundle.executableURL != nil &&
          SameMacExecutablePath(bundle.executableURL.path, executable_path))
        return bundle.bundleURL;
      return nil;
    }
    NSString* parent = cursor.stringByDeletingLastPathComponent;
    if ([parent isEqualToString:cursor]) break;
    cursor = parent;
  }
  return nil;
}

std::uint32_t LaunchExactRegisteredApplication(
    std::string_view expected_identity, std::string_view expected_executable_path) {
  NSURL* bundle_url = ExactApplicationBundleUrlForExecutable(expected_executable_path);
  if (bundle_url == nil) return 0;
  NSBundle* bundle = [NSBundle bundleWithURL:bundle_url];
  if (bundle == nil || bundle.executableURL == nil || !IsMacComputerUseBundleEligible(bundle))
    return 0;
  IdentityFacts before_launch;
  NSString* display = bundle.localizedInfoDictionary[@"CFBundleDisplayName"];
  if (display == nil) display = bundle.infoDictionary[@"CFBundleName"];
  if (display == nil) display = bundle.bundleIdentifier;
  if (!BuildIdentityFacts(bundle.executableURL.path, bundle.bundleIdentifier, display,
                          &before_launch) ||
      before_launch.identity_digest != expected_identity ||
      !SameMacExecutablePath(bundle.executableURL.path, expected_executable_path))
    return 0;

  NSWorkspaceOpenConfiguration* configuration =
      [NSWorkspaceOpenConfiguration configuration];
  configuration.activates = NO;
  configuration.addsToRecentItems = NO;
  configuration.createsNewApplicationInstance = NO;
  __block NSRunningApplication* launched_application = nil;
  __block NSError* launch_error = nil;
  __block bool completed = false;
  [NSWorkspace.sharedWorkspace
      openApplicationAtURL:bundle_url
             configuration:configuration
         completionHandler:^(NSRunningApplication* application, NSError* error) {
           dispatch_async(dispatch_get_main_queue(), ^{
             launched_application = application;
             launch_error = error;
             completed = true;
           });
         }];
  constexpr int kLaunchCompletionPollAttempts = 200;
  constexpr CFTimeInterval kLaunchCompletionPollSeconds = 0.05;
  for (int attempt = 0; attempt < kLaunchCompletionPollAttempts && !completed; ++attempt)
    CFRunLoopRunInMode(kCFRunLoopDefaultMode, kLaunchCompletionPollSeconds, true);
  if (!completed || launch_error != nil || launched_application == nil) return 0;
  const std::uint32_t pid =
      static_cast<std::uint32_t>(launched_application.processIdentifier);
  if (pid == 0) return 0;
  constexpr int kLaunchIdentityPollAttempts = 100;
  for (int attempt = 0; attempt < kLaunchIdentityPollAttempts; ++attempt) {
    std::uint32_t launched_window_id = 0;
    CGRect launched_window_bounds{};
    if (launched_application.finishedLaunching &&
        CurrentApplicationMatchesIdentityNative(pid, expected_identity,
                                                expected_executable_path) &&
        IsCurrentApplicationEligible(pid) &&
        ReadFrontmostWindow(pid, &launched_window_id, &launched_window_bounds))
      return pid;
    CFRunLoopRunInMode(kCFRunLoopDefaultMode, kLaunchCompletionPollSeconds, true);
  }
  return 0;
}

napi_value PickApplication(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok ||
      argc != 1 || !IsObject(env, argv[0]))
    return ThrowNativeError(env, "INVALID_PICKER",
                            "A picker request is required");
  std::string activation_token;
  std::string picker_kind;
  if (!ReadNamedString(env, argv[0], "activationToken", &activation_token) ||
      !ReadNamedString(env, argv[0], "pickerKind", &picker_kind) ||
      (picker_kind != "application" && picker_kind != "window"))
    return ThrowNativeError(env, "INVALID_PICKER",
                            "A bound picker activation is required");
  (void)activation_token;
  // The picker is deliberately explicit. At the time the Main registration
  // button invokes this function Sprint Coder is frontmost, so inferring a
  // target from NSWorkspace.frontmostApplication would always select ourselves.
  // The panel is limited to .app bundles and returns only an app identity; no
  // path or pid is sent to the renderer.
  NSOpenPanel *panel = [NSOpenPanel openPanel];
  panel.canChooseFiles = YES;
  panel.canChooseDirectories = NO;
  panel.allowsMultipleSelection = NO;
  panel.allowedContentTypes = @[ UTTypeApplicationBundle ];
  panel.prompt = @"Select";
  if ([panel runModal] != NSModalResponseOK || panel.URL == nil)
    return nullptr;
  NSURL *selected_bundle = panel.URL;
  if (!selected_bundle.isFileURL ||
      ![selected_bundle.path.pathExtension.lowercaseString
          isEqualToString:@"app"])
    return ThrowNativeError(env, "INVALID_PICKER",
                            "Only an application bundle may be selected");
  NSBundle *selected = [NSBundle bundleWithURL:selected_bundle];
  if (selected == nil || selected.executableURL == nil ||
      selected.bundleIdentifier.length == 0 ||
      [selected.bundleIdentifier
          isEqualToString:[[NSBundle mainBundle] bundleIdentifier]])
    return ThrowNativeError(env, "TARGET_UNAVAILABLE",
                            "Sprint Coder cannot target itself");
  const std::string selected_executable_path =
      Utf8String(selected.executableURL.path);
  if (selected_executable_path.empty())
    return ThrowNativeError(env, "IDENTITY_UNAVAILABLE",
                            "App identity is unavailable");
  NSRunningApplication *application = nil;
  for (NSRunningApplication *candidate in [NSRunningApplication
           runningApplicationsWithBundleIdentifier:selected.bundleIdentifier]) {
    if (candidate.executableURL != nil &&
        SameMacExecutablePath(candidate.executableURL.path,
                              selected_executable_path)) {
      application = candidate;
      break;
    }
  }
  if (application != nil ? !IsMacComputerUseApplicationEligible(application)
                         : !IsMacComputerUseBundleEligible(selected))
    return ThrowNativeError(env, "TARGET_INELIGIBLE",
                            "This application category cannot be controlled");
  napi_value result = application != nil
                          ? IdentityObject(env, application,
                                           static_cast<std::uint32_t>(
                                               application.processIdentifier))
                          : IdentityObjectFromBundle(env, selected_bundle, 0);
  if (result == nullptr)
    return ThrowNativeError(env, "IDENTITY_UNAVAILABLE",
                            "App identity is unavailable");
  return result;
}

std::string ComputerWindowIdentityDigest(std::string_view app_identity,
                                         std::string_view process_generation,
                                         std::uint32_t window_id, const CGRect& bounds) {
  return StringDigest(
      "computer-window-identity-v1\n" + std::string(app_identity) + "\n" +
      std::string(process_generation) + "\n" + std::to_string(window_id) + "\n" +
      std::to_string(bounds.origin.x) + ":" +
      std::to_string(bounds.origin.y) + ":" + std::to_string(bounds.size.width) + ":" +
      std::to_string(bounds.size.height));
}

napi_value ListWindows(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1 ||
      !IsObject(env, argv[0]))
    return ThrowNativeError(env, "INVALID_WINDOWS_REQUEST", "A window request is required");
  std::uint32_t pid = 0;
  std::string app_identity;
  std::string executable_path;
  bool has_pid = false;
  if (napi_has_named_property(env, argv[0], "pid", &has_pid) != napi_ok ||
      !ReadNamedString(env, argv[0], "appIdentityDigest", &app_identity) ||
      app_identity.size() != 64 ||
      !ReadNamedString(env, argv[0], "canonicalPath", &executable_path, 4'096))
    return ThrowNativeError(env, "INVALID_WINDOWS_REQUEST", "A native app identity is required");
  if (has_pid && !ReadNamedUint32(env, argv[0], "pid", &pid))
    return ThrowNativeError(env, "INVALID_WINDOWS_REQUEST", "The native process id is invalid");
  const bool cached_pid_matches =
      has_pid && CurrentApplicationMatchesIdentity(env, pid, app_identity, executable_path);
  if (!cached_pid_matches) {
    pid = ResolveRunningApplicationForIdentity(env, argv[0], app_identity, executable_path);
    if (pid == 0)
      pid = LaunchExactRegisteredApplication(app_identity, executable_path);
  }
  if (pid == 0)
    return ThrowNativeError(env, "APP_NOT_RUNNING", "The selected application is not running");
  if (!CurrentApplicationMatchesIdentity(env, pid, app_identity, executable_path))
    return ThrowNativeError(env, "APP_IDENTITY_CHANGED", "The selected application identity changed");
  std::string process_generation;
  if (!ReadProcessGenerationToken(pid, &process_generation))
    return ThrowNativeError(env, "APP_PROCESS_CHANGED",
                            "The selected application process changed");
  const bool app_eligible = IsCurrentApplicationEligible(pid);
  NSString* executable_string =
      [[NSString alloc] initWithBytes:executable_path.data()
                               length:executable_path.size()
                             encoding:NSUTF8StringEncoding];
  const std::string policy_language =
      PolicyLanguageForMacExecutable(executable_string);
  NSRunningApplication* running_application =
      [NSRunningApplication
          runningApplicationWithProcessIdentifier:static_cast<pid_t>(pid)];
  IdentityFacts current_identity_facts;
  if (running_application == nil ||
      !BuildIdentityFacts(running_application.executableURL.path,
                          running_application.bundleIdentifier,
                          running_application.localizedName,
                          &current_identity_facts) ||
      current_identity_facts.identity_digest != app_identity)
    return ThrowNativeError(env, "APP_IDENTITY_CHANGED",
                            "The selected application identity changed");
  const std::string maximum_mode =
      MaximumModeForIdentityFacts(current_identity_facts);
  CFArrayRef windows = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID);
  if (windows == nullptr) return ThrowNativeError(env, "WINDOW_UNAVAILABLE", "Window list is unavailable");
  const std::uint32_t frontmost_pid = FrontmostPid();
  std::uint32_t topmost_target_window_id = 0;
  CGRect topmost_target_bounds{};
  ReadFrontmostWindow(pid, &topmost_target_window_id, &topmost_target_bounds);
  (void)topmost_target_bounds;
  bool focused_ax_dialog = false;
  bool focused_ax_modal = false;
  bool focused_ax_protected_prompt = false;
  CGRect focused_ax_bounds{};
  bool focused_ax_has_bounds = false;
  AXUIElementRef ax_application = AXUIElementCreateApplication(static_cast<pid_t>(pid));
  if (ax_application != nullptr) {
    AXUIElementRef focused_ax_window =
        CopyAccessibilityElementAttribute(ax_application, kAXFocusedWindowAttribute);
    CFRelease(ax_application);
    if (focused_ax_window != nullptr) {
      std::string focused_role;
      std::string focused_subrole;
      std::string focused_title;
      CopyAccessibilityString(focused_ax_window, kAXRoleAttribute, &focused_role);
      CopyAccessibilityString(focused_ax_window, kAXSubroleAttribute, &focused_subrole);
      CopyAccessibilityString(focused_ax_window, kAXTitleAttribute, &focused_title);
      CopyAccessibilityBoolean(focused_ax_window, kAXModalAttribute, &focused_ax_modal);
      focused_ax_has_bounds =
          ReadAccessibilityWindowBounds(focused_ax_window, &focused_ax_bounds);
      CFRelease(focused_ax_window);
      const std::string normalized =
          LowercaseAscii(focused_role + "\n" + focused_subrole);
      focused_ax_dialog =
          IsDialogAccessibilityDescriptor(focused_role, focused_subrole) ||
          focused_ax_modal;
      focused_ax_protected_prompt =
          IsFileOrSystemPromptTitle(focused_title) ||
          normalized.find("axsystemdialog") != std::string::npos;
    }
  }
  const bool foreign_system_prompt =
      frontmost_pid != pid && frontmost_pid != 0 &&
      IsMacSystemUserTakeoverApplication(frontmost_pid);
  napi_value result;
  napi_create_array(env, &result);
  std::uint32_t array_index = 0;
  for (CFIndex index = 0; index < CFArrayGetCount(windows); ++index) {
    const auto window = static_cast<CFDictionaryRef>(CFArrayGetValueAtIndex(windows, index));
    if (window == nullptr) continue;
    const auto owner_pid = static_cast<CFNumberRef>(CFDictionaryGetValue(window, kCGWindowOwnerPID));
    const auto window_number = static_cast<CFNumberRef>(CFDictionaryGetValue(window, kCGWindowNumber));
    int owner = 0;
    int number = 0;
    if (owner_pid == nullptr || window_number == nullptr ||
        !CFNumberGetValue(owner_pid, kCFNumberIntType, &owner) ||
        !CFNumberGetValue(window_number, kCFNumberIntType, &number) || owner <= 0 || number <= 0 ||
        static_cast<std::uint32_t>(owner) != pid)
      continue;
    const auto layer_number = static_cast<CFNumberRef>(CFDictionaryGetValue(window, kCGWindowLayer));
    int layer = 0;
    if (layer_number == nullptr || !CFNumberGetValue(layer_number, kCFNumberIntType, &layer) ||
        layer != 0)
      continue;
    CGRect bounds{};
    CFDictionaryRef bounds_dictionary = nullptr;
    if (!CFDictionaryGetValueIfPresent(window, kCGWindowBounds,
                                       reinterpret_cast<const void**>(&bounds_dictionary)) ||
        bounds_dictionary == nullptr || !CGRectMakeWithDictionaryRepresentation(bounds_dictionary, &bounds) ||
        bounds.size.width <= 0 || bounds.size.height <= 0)
      continue;
    std::string title;
    if (!ReadWindowTitle(window, &title) || title.empty()) title = "Application window";
    bool ax_classified = false;
    bool ax_dialog = false;
    bool ax_modal = false;
    bool protected_prompt = IsFileOrSystemPromptTitle(title);
    AXUIElementRef ax_window = FindUniqueAccessibilityWindow(pid, bounds);
    if (ax_window != nullptr) {
      std::string role;
      std::string subrole;
      std::string ax_title;
      CopyAccessibilityString(ax_window, kAXRoleAttribute, &role);
      CopyAccessibilityString(ax_window, kAXSubroleAttribute, &subrole);
      CopyAccessibilityString(ax_window, kAXTitleAttribute, &ax_title);
      CopyAccessibilityBoolean(ax_window, kAXModalAttribute, &ax_modal);
      CFRelease(ax_window);
      const std::string normalized = LowercaseAscii(role + "\n" + subrole);
      ax_classified = !role.empty();
      ax_dialog = IsDialogAccessibilityDescriptor(role, subrole) || ax_modal;
      protected_prompt = protected_prompt || IsFileOrSystemPromptTitle(ax_title) ||
                         normalized.find("axsystemdialog") != std::string::npos;
    }
    const bool hosts_focused_ax_surface =
        number == static_cast<int>(topmost_target_window_id) && focused_ax_has_bounds &&
        (BoundsEqual(bounds, focused_ax_bounds) ||
         CGRectContainsRect(bounds, focused_ax_bounds));
    if (hosts_focused_ax_surface) {
      ax_dialog = ax_dialog || focused_ax_dialog;
      ax_modal = ax_modal || focused_ax_modal;
      protected_prompt =
          protected_prompt || focused_ax_protected_prompt;
    }
    protected_prompt = protected_prompt || foreign_system_prompt;
    const char* owner_kind =
        protected_prompt ? "dialog"
                         : (!ax_classified ? "unknown"
                                           : (ax_dialog ? "dialog" : "application"));
    const bool candidate_eligible =
        app_eligible && ax_classified && !ax_dialog && !protected_prompt &&
        number == static_cast<int>(topmost_target_window_id);
    const std::string window_id = std::to_string(number);
    const std::string window_identity = ComputerWindowIdentityDigest(
        app_identity, process_generation, static_cast<std::uint32_t>(number), bounds);
    napi_value candidate;
    napi_create_object(env, &candidate);
    napi_set_named_property(env, candidate, "pid", NumberValue(env, pid));
    napi_set_named_property(env, candidate, "windowId", StringValue(env, window_id.c_str()));
    napi_set_named_property(env, candidate, "appIdentityDigest", StringValue(env, app_identity.c_str()));
    napi_set_named_property(env, candidate, "windowIdentityDigest", StringValue(env, window_identity.c_str()));
    napi_set_named_property(env, candidate, "title", StringValue(env, title.c_str()));
    napi_value candidate_bounds;
    napi_create_object(env, &candidate_bounds);
    napi_set_named_property(env, candidate_bounds, "x", NumberValue(env, bounds.origin.x));
    napi_set_named_property(env, candidate_bounds, "y", NumberValue(env, bounds.origin.y));
    napi_set_named_property(env, candidate_bounds, "width", NumberValue(env, bounds.size.width));
    napi_set_named_property(env, candidate_bounds, "height", NumberValue(env, bounds.size.height));
    napi_set_named_property(env, candidate, "bounds", candidate_bounds);
    napi_set_named_property(env, candidate, "focused",
                           BoolValue(env, frontmost_pid == pid &&
                                     number == static_cast<int>(topmost_target_window_id)));
    napi_set_named_property(env, candidate, "eligible",
                           BoolValue(env, candidate_eligible));
    napi_set_named_property(env, candidate, "ownerKind", StringValue(env, owner_kind));
    napi_set_named_property(env, candidate, "modal", BoolValue(env, ax_modal));
    napi_set_named_property(env, candidate, "policyLanguage",
                            StringValue(env, policy_language.c_str()));
    napi_set_named_property(env, candidate, "maximumMode",
                            StringValue(env, maximum_mode.c_str()));
    SetScreenBoundsProperty(env, candidate, bounds);
    napi_set_named_property(env, candidate, "revision", NumberValue(env, 1));
    napi_set_element(env, result, array_index++, candidate);
  }
  std::string confirmed_process_generation;
  const bool process_generation_matches =
      ReadProcessGenerationToken(pid, &confirmed_process_generation) &&
      confirmed_process_generation == process_generation;
  CFRelease(windows);
  if (!process_generation_matches)
    return ThrowNativeError(env, "APP_PROCESS_CHANGED",
                            "The selected application process changed");
  return result;
}

bool ReadAccessibilityWindowBounds(AXUIElementRef window, CGRect* bounds) {
  CFTypeRef position_value = nullptr;
  CFTypeRef size_value = nullptr;
  if (window == nullptr ||
      AXUIElementCopyAttributeValue(window, kAXPositionAttribute, &position_value) !=
          kAXErrorSuccess ||
      AXUIElementCopyAttributeValue(window, kAXSizeAttribute, &size_value) != kAXErrorSuccess ||
      position_value == nullptr || size_value == nullptr ||
      CFGetTypeID(position_value) != AXValueGetTypeID() ||
      CFGetTypeID(size_value) != AXValueGetTypeID()) {
    if (position_value != nullptr) CFRelease(position_value);
    if (size_value != nullptr) CFRelease(size_value);
    return false;
  }
  CGPoint position{};
  CGSize size{};
  const bool read =
      AXValueGetType(static_cast<AXValueRef>(position_value)) == kAXValueCGPointType &&
      AXValueGetType(static_cast<AXValueRef>(size_value)) == kAXValueCGSizeType &&
      AXValueGetValue(static_cast<AXValueRef>(position_value),
                      static_cast<AXValueType>(kAXValueCGPointType), &position) &&
      AXValueGetValue(static_cast<AXValueRef>(size_value),
                      static_cast<AXValueType>(kAXValueCGSizeType), &size);
  CFRelease(position_value);
  CFRelease(size_value);
  if (!read || size.width <= 0 || size.height <= 0) return false;
  *bounds = CGRectMake(position.x, position.y, size.width, size.height);
  return true;
}

AXUIElementRef FindUniqueAccessibilityWindow(std::uint32_t pid,
                                             const CGRect& expected_bounds) {
  AXUIElementRef application = AXUIElementCreateApplication(static_cast<pid_t>(pid));
  if (application == nullptr) return nullptr;
  CFTypeRef windows_value = nullptr;
  const AXError copied =
      AXUIElementCopyAttributeValue(application, kAXWindowsAttribute, &windows_value);
  CFRelease(application);
  if (copied != kAXErrorSuccess || windows_value == nullptr ||
      CFGetTypeID(windows_value) != CFArrayGetTypeID()) {
    if (windows_value != nullptr) CFRelease(windows_value);
    return nullptr;
  }
  AXUIElementRef match = nullptr;
  std::size_t matches = 0;
  const auto windows = static_cast<CFArrayRef>(windows_value);
  for (CFIndex index = 0; index < CFArrayGetCount(windows); ++index) {
    const auto window = static_cast<AXUIElementRef>(
        const_cast<void*>(CFArrayGetValueAtIndex(windows, index)));
    if (window == nullptr || CFGetTypeID(window) != AXUIElementGetTypeID()) continue;
    CGRect bounds{};
    if (!ReadAccessibilityWindowBounds(window, &bounds) || !BoundsEqual(bounds, expected_bounds))
      continue;
    ++matches;
    if (match != nullptr) CFRelease(match);
    CFRetain(window);
    match = window;
  }
  CFRelease(windows_value);
  if (matches != 1 && match != nullptr) {
    CFRelease(match);
    match = nullptr;
  }
  return match;
}

constexpr int kStartActivationPollAttempts = 20;
constexpr NSTimeInterval kStartActivationPollIntervalSeconds = 0.05;

bool ActivateAndRaiseSelectedWindow(std::uint32_t pid, std::uint32_t window_id,
                                    const CGRect& expected_bounds,
                                    std::uint64_t expected_cancel_epoch) {
  if (!CheckCancellationEpoch(expected_cancel_epoch)) return false;
  NSRunningApplication* application =
      [NSRunningApplication runningApplicationWithProcessIdentifier:static_cast<pid_t>(pid)];
  if (application == nil) return false;
  AXUIElementRef selected_window = FindUniqueAccessibilityWindow(pid, expected_bounds);
  if (selected_window == nullptr) return false;
  const NSApplicationActivationOptions options =
      NSApplicationActivateAllWindows | NSApplicationActivateIgnoringOtherApps;
  const bool activated = [application activateWithOptions:options];
  const AXError raised =
      activated && CheckCancellationEpoch(expected_cancel_epoch)
          ? AXUIElementPerformAction(selected_window, kAXRaiseAction)
          : kAXErrorCannotComplete;
  CFRelease(selected_window);
  if (!activated || raised != kAXErrorSuccess) return false;

  for (int attempt = 0; attempt < kStartActivationPollAttempts; ++attempt) {
    if (!CheckCancellationEpoch(expected_cancel_epoch)) return false;
    std::uint32_t current_window_id = 0;
    CGRect current_bounds{};
    if (FrontmostPid() == pid &&
        ReadFrontmostWindow(pid, &current_window_id, &current_bounds) &&
        current_window_id == window_id && BoundsEqual(current_bounds, expected_bounds))
      return true;
    [NSThread sleepForTimeInterval:kStartActivationPollIntervalSeconds];
  }
  return false;
}

struct NativeStartSessionRequest {
  std::uint32_t pid = 0;
  std::uint32_t window_id = 0;
  std::string session_id;
  std::string app_identity;
  std::string window_identity;
  std::string executable_path;
  CGRect requested_bounds{};
  std::uint64_t requested_cancel_epoch = 0;
  bool explicit_resume = false;
};

struct AsyncNativeStartSessionWork {
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  NativeStartSessionRequest request;
  std::shared_ptr<MacComputerUseSession> session;
  bool creating_session = false;
  std::uint64_t start_cancel_epoch = 0;
  CGRect screen_bounds{};
  std::string error_code;
  std::string error_message;
};

bool PerformNativeStartSession(AsyncNativeStartSessionWork* work);
void ExecuteNativeStartSession(napi_env env, void* data);
void CompleteNativeStartSession(napi_env env, napi_status status, void* data);

void RemovePendingStart(const AsyncNativeStartSessionWork& work) {
  if (!work.creating_session || work.session == nullptr) return;
  std::lock_guard<std::mutex> sessions_lock(mac_sessions_mutex);
  const auto pending = mac_pending_sessions.find(work.request.session_id);
  if (pending != mac_pending_sessions.end() && pending->second == work.session)
    mac_pending_sessions.erase(pending);
}

napi_value StartSession(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok ||
      argc != 1 || !IsObject(env, argv[0]))
    return ThrowNativeError(env, "INVALID_SESSION",
                            "A native session request is required");
  auto work = std::make_unique<AsyncNativeStartSessionWork>();
  NativeStartSessionRequest& request = work->request;
  if (!ReadNamedUint32(env, argv[0], "pid", &request.pid) ||
      !ReadNamedUint32(env, argv[0], "windowId", &request.window_id) ||
      !ReadNamedString(env, argv[0], "sessionId", &request.session_id) ||
      !ReadNamedString(env, argv[0], "appIdentityDigest",
                       &request.app_identity) ||
      !ReadNamedString(env, argv[0], "windowIdentityDigest",
                       &request.window_identity) ||
      !ReadNamedString(env, argv[0], "canonicalPath",
                       &request.executable_path, 4'096) ||
      !ReadNamedDouble(env, argv[0], "expectedBoundsX",
                       &request.requested_bounds.origin.x) ||
      !ReadNamedDouble(env, argv[0], "expectedBoundsY",
                       &request.requested_bounds.origin.y) ||
      !ReadNamedDouble(env, argv[0], "expectedBoundsWidth",
                       &request.requested_bounds.size.width) ||
      !ReadNamedDouble(env, argv[0], "expectedBoundsHeight",
                       &request.requested_bounds.size.height) ||
      !ReadNamedUInt64(env, argv[0], "cancelEpoch",
                       &request.requested_cancel_epoch) ||
      !ReadOptionalNamedBool(env, argv[0], "resume",
                             &request.explicit_resume) ||
      request.requested_bounds.size.width <= 0 ||
      request.requested_bounds.size.height <= 0)
    return ThrowNativeError(env, "INVALID_SESSION",
                            "A valid native session target is required");

  {
    std::lock_guard<std::mutex> sessions_lock(mac_sessions_mutex);
    const auto existing = mac_sessions.find(request.session_id);
    if (existing != mac_sessions.end()) {
      work->session = existing->second;
      work->start_cancel_epoch =
          work->session->cancel_epoch.load(std::memory_order_acquire);
    } else {
      if (mac_pending_sessions.contains(request.session_id))
        return ThrowNativeError(env, "SESSION_BUSY",
                                "The native session start is already pending");
      if (!mac_sessions.empty() || !mac_pending_sessions.empty())
        return ThrowNativeError(env, "SESSION_LIMIT",
                                "Only one Computer Use session is allowed");
      const std::uint64_t current_cancel_epoch =
          cancellation_epoch.load(std::memory_order_acquire);
      if (request.requested_cancel_epoch > current_cancel_epoch)
        return ThrowNativeError(env, "CANCELED",
                                "The native session start was canceled");
      work->creating_session = true;
      work->session = std::make_shared<MacComputerUseSession>();
      work->session->session_id = request.session_id;
      work->session->app_identity = request.app_identity;
      work->session->executable_path = request.executable_path;
      work->session->window_identity = request.window_identity;
      work->session->pid = request.pid;
      work->session->window_id = request.window_id;
      work->session->expected_bounds = request.requested_bounds;
      work->session->cancel_epoch.store(current_cancel_epoch,
                                        std::memory_order_release);
      work->session->observation_publication_epoch.store(
          current_cancel_epoch, std::memory_order_release);
      mac_pending_sessions.emplace(request.session_id, work->session);
      work->start_cancel_epoch = current_cancel_epoch;
    }
  }

  napi_value promise;
  if (napi_create_promise(env, &work->deferred, &promise) != napi_ok) {
    RemovePendingStart(*work);
    return ThrowNativeError(env, "ASYNC_UNAVAILABLE",
                            "Could not create the native start promise");
  }
  napi_value resource_name =
      StringValue(env, "SprintCoderComputerUseStartSession");
  if (napi_create_async_work(env, nullptr, resource_name,
                             ExecuteNativeStartSession,
                             CompleteNativeStartSession, work.get(),
                             &work->work) != napi_ok ||
      napi_queue_async_work(env, work->work) != napi_ok) {
    if (work->work != nullptr) napi_delete_async_work(env, work->work);
    RemovePendingStart(*work);
    return ThrowNativeError(env, "ASYNC_UNAVAILABLE",
                            "Could not queue the serial native start");
  }
  work.release();
  return promise;
}

bool PerformNativeStartSession(AsyncNativeStartSessionWork* work) {
  NativeStartSessionRequest& request = work->request;
  const std::uint32_t pid = request.pid;
  const std::uint32_t window_id = request.window_id;
  const std::string& session_id = request.session_id;
  const std::string& app_identity = request.app_identity;
  const std::string& window_identity = request.window_identity;
  const std::string& executable_path = request.executable_path;
  const CGRect requested_bounds = request.requested_bounds;
  const std::uint64_t requested_cancel_epoch =
      request.requested_cancel_epoch;
  const bool explicit_resume = request.explicit_resume;
  const bool creating_session = work->creating_session;
  std::shared_ptr<MacComputerUseSession> existing_session =
      creating_session ? nullptr : work->session;
  const auto fail = [&](const char* code, const char* message) {
    SetNativeAsyncError(&work->error_code, &work->error_message, code, message);
    return false;
  };
  const std::uint64_t start_cancel_epoch = work->start_cancel_epoch;
  const auto cancellation_still_valid = [&]() {
    return !work->session->closed.load(std::memory_order_acquire) &&
           work->session->cancel_epoch.load(std::memory_order_acquire) ==
               start_cancel_epoch &&
           CheckCancellationEpoch(start_cancel_epoch);
  };
  if (!cancellation_still_valid())
    return fail("CANCELED", "The native session start was canceled");
  if (creating_session && explicit_resume)
    return fail("INVALID_SESSION",
                "Only an existing paused session may be resumed");
  if (!creating_session && requested_cancel_epoch != start_cancel_epoch)
    return fail("CANCELED", "The native session start was canceled");
  if (!CurrentApplicationMatchesIdentityNative(pid, app_identity,
                                               executable_path))
    return fail("APP_IDENTITY_CHANGED",
                "The selected application identity changed");
  std::string process_generation;
  if (!ReadProcessGenerationToken(pid, &process_generation))
    return fail("APP_PROCESS_CHANGED",
                "The selected application process changed");
  const auto process_generation_still_valid = [&]() {
    std::string current_process_generation;
    return ReadProcessGenerationToken(pid, &current_process_generation) &&
           current_process_generation == process_generation;
  };
  NSRunningApplication* running_application =
      [NSRunningApplication
          runningApplicationWithProcessIdentifier:static_cast<pid_t>(pid)];
  IdentityFacts identity_facts;
  if (running_application == nil ||
      !BuildIdentityFacts(running_application.executableURL.path,
                          running_application.bundleIdentifier,
                          running_application.localizedName, &identity_facts) ||
      identity_facts.identity_digest != app_identity)
    return fail("APP_IDENTITY_CHANGED",
                "The selected application identity changed");
  const std::string policy_language = identity_facts.policy_language;
  const std::string maximum_mode = MaximumModeForIdentityFacts(identity_facts);
  if (!IsCurrentApplicationEligible(pid))
    return fail("TARGET_INELIGIBLE",
                "This application category cannot be controlled");
  if (!cancellation_still_valid())
    return fail("CANCELED", "The native session start was canceled");
  CGRect selected_bounds{};
  if (!ReadWindowBounds(window_id, &selected_bounds) ||
      !cancellation_still_valid() || ResolveShareableWindow(pid, window_id) == nil)
    return cancellation_still_valid()
               ? fail("WINDOW_UNAVAILABLE", "The selected window is unavailable")
               : fail("CANCELED", "The native session start was canceled");
  if (!cancellation_still_valid())
    return fail("CANCELED", "The native session start was canceled");
  if (!BoundsEqual(selected_bounds, requested_bounds))
    return fail("STALE_TARGET", "The selected window geometry changed");
  if (ComputerWindowIdentityDigest(app_identity, process_generation, window_id,
                                   selected_bounds) !=
      window_identity)
    return fail("WINDOW_IDENTITY_CHANGED",
                "The selected window identity changed");
  if (existing_session != nullptr &&
      (existing_session->closed.load(std::memory_order_acquire) ||
       existing_session->pid != pid ||
       existing_session->window_id != window_id ||
       existing_session->app_identity != app_identity ||
       existing_session->executable_path != executable_path ||
       existing_session->process_generation != process_generation ||
       existing_session->window_identity != window_identity ||
       existing_session->policy_language != policy_language ||
       existing_session->maximum_mode != maximum_mode ||
       !BoundsEqual(existing_session->expected_bounds, selected_bounds)))
    return fail("SESSION_ID_REUSE", "The native session binding changed");

  std::uint32_t activation_window_id = window_id;
  CGRect activation_bounds = selected_bounds;
  MacDialogSetSnapshot new_session_target;
  MacDialogSetSnapshot resume_target;
  if (creating_session) {
    if (!CaptureMacDialogSetSnapshot(pid, window_id, app_identity,
                                     process_generation,
                                     &new_session_target, false))
      return fail("FOCUS_REQUIRED",
                  "The selected primary window is not safely classified");
    if (new_session_target.boundary ==
        AxFocusedWindowBoundary::kUserTakeover)
      return fail(
          "DIALOG_USER_TAKEOVER",
          "A file, OS, administrator, or security prompt requires the user");
    if (new_session_target.boundary != AxFocusedWindowBoundary::kAllowed ||
        new_session_target.active_window_id != window_id ||
        new_session_target.active_window_kind != "application" ||
        !BoundsEqual(new_session_target.active_bounds, selected_bounds))
      return fail("FOCUS_REQUIRED",
                  "A dialog cannot be selected as a primary window");
    std::uint32_t topmost_target_window_id = 0;
    CGRect topmost_target_bounds{};
    if (!ReadFrontmostWindow(pid, &topmost_target_window_id,
                             &topmost_target_bounds) ||
        topmost_target_window_id != window_id ||
        !BoundsEqual(topmost_target_bounds, selected_bounds))
      return fail(
          "FOCUS_REQUIRED",
          "The selected window is not the app's topmost visible window");
  } else {
    const std::uint32_t frontmost_pid = FrontmostPid();
    if (frontmost_pid != pid && frontmost_pid != 0 &&
        IsMacSystemUserTakeoverApplication(frontmost_pid))
      return fail("OS_PROMPT_USER_TAKEOVER",
                  "A macOS prompt requires the user");
    if (!CaptureMacDialogSetSnapshot(pid, window_id, app_identity,
                                     process_generation, &resume_target, false))
      return fail("FOCUS_REQUIRED",
                  "The existing session target is not safely classified");
    if (resume_target.boundary == AxFocusedWindowBoundary::kUserTakeover)
      return fail(
          "DIALOG_USER_TAKEOVER",
          "A file, OS, administrator, or security prompt requires the user");
    if (resume_target.boundary != AxFocusedWindowBoundary::kAllowed)
      return fail("FOCUS_REQUIRED",
                  "The existing session target is not safely classified");
    bool resume_binding_matches = false;
    {
      std::lock_guard<std::mutex> state_lock(existing_session->state_mutex);
      if (!cancellation_still_valid())
        return fail("CANCELED", "The native session start was canceled");
      if (explicit_resume) {
        existing_session->dialog_set_revision += 1;
        existing_session->dialog_set_digest = resume_target.dialog_set_digest;
        existing_session->active_window_identity =
            resume_target.active_window_identity;
        existing_session->active_window_kind = resume_target.active_window_kind;
        existing_session->active_window_id = resume_target.active_window_id;
        existing_session->observation_bounds = resume_target.active_bounds;
        existing_session->has_observation = false;
        existing_session->focused_control_signature.clear();
        existing_session->semantic_control_signatures.clear();
        existing_session->visual_control_signatures.clear();
        existing_session->visual_patch_digests.clear();
        resume_binding_matches = true;
      } else {
        resume_binding_matches = existing_session->has_observation
                                     ? existing_session->dialog_set_digest ==
                                               resume_target.dialog_set_digest &&
                                           existing_session->active_window_identity ==
                                               resume_target.active_window_identity &&
                                           existing_session->active_window_kind ==
                                               resume_target.active_window_kind &&
                                           existing_session->active_window_id ==
                                               resume_target.active_window_id &&
                                           BoundsEqual(
                                               existing_session->observation_bounds,
                                               resume_target.active_bounds)
                                     : resume_target.active_window_id == window_id &&
                                           resume_target.active_window_kind ==
                                               "application" &&
                                           BoundsEqual(resume_target.active_bounds,
                                                       selected_bounds);
      }
    }
    if (!resume_binding_matches)
      return fail("STALE_TARGET",
                  "The existing session dialog set changed before resume");
    activation_window_id = resume_target.active_window_id;
    activation_bounds = resume_target.active_bounds;
  }
  if (!cancellation_still_valid())
    return fail("CANCELED", "The native session start was canceled");
  if (!process_generation_still_valid())
    return fail("APP_PROCESS_CHANGED",
                "The selected application process changed");
  if (!ActivateAndRaiseSelectedWindow(pid, activation_window_id,
                                      activation_bounds,
                                      start_cancel_epoch)) {
    if (!cancellation_still_valid())
      return fail("CANCELED", "The native session start was canceled");
    if (!creating_session &&
        ClassifyFocusedWindowBoundary(pid) ==
            AxFocusedWindowBoundary::kUserTakeover)
      return fail(
          "DIALOG_USER_TAKEOVER",
          "A file, OS, administrator, or security prompt requires the user");
    return fail("FOCUS_REQUIRED",
                "The selected window could not be focused");
  }
  if (!CheckCancellationEpoch(start_cancel_epoch) ||
      !cancellation_still_valid())
    return fail("CANCELED", "The native session start was canceled");
  if (!CurrentApplicationMatchesIdentityNative(pid, app_identity,
                                               executable_path))
    return fail("APP_IDENTITY_CHANGED",
                "The selected application identity changed");
  if (!process_generation_still_valid())
    return fail("APP_PROCESS_CHANGED",
                "The selected application process changed");
  if (!IsCurrentApplicationEligible(pid))
    return fail("TARGET_INELIGIBLE",
                "This application category cannot be controlled");
  if (creating_session) {
    std::uint32_t focused_window_id = 0;
    CGRect focused_bounds{};
    MacDialogSetSnapshot focused_new_session_target;
    if (FrontmostPid() != pid ||
        !ReadFrontmostWindow(pid, &focused_window_id, &focused_bounds) ||
        focused_window_id != window_id ||
        !BoundsEqual(focused_bounds, selected_bounds) ||
        ResolveShareableWindow(pid, window_id) == nil ||
        !CaptureMacDialogSetSnapshot(pid, window_id, app_identity,
                                     process_generation,
                                     &focused_new_session_target))
      return fail("FOCUS_REQUIRED", "The selected window is not focused");
    if (focused_new_session_target.boundary ==
        AxFocusedWindowBoundary::kUserTakeover)
      return fail(
          "DIALOG_USER_TAKEOVER",
          "A file, OS, administrator, or security prompt requires the user");
    if (focused_new_session_target.boundary !=
            AxFocusedWindowBoundary::kAllowed ||
        focused_new_session_target.active_window_id != window_id ||
        focused_new_session_target.active_window_kind != "application" ||
        focused_new_session_target.dialog_set_digest !=
            new_session_target.dialog_set_digest ||
        !BoundsEqual(focused_new_session_target.active_bounds,
                     selected_bounds))
      return fail("STALE_TARGET",
                  "The primary window dialog set changed during start");
  } else {
    MacDialogSetSnapshot focused_resume_target;
    if (!CaptureMacDialogSetSnapshot(pid, window_id, app_identity,
                                     process_generation,
                                     &focused_resume_target))
      return fail("FOCUS_REQUIRED",
                  "The existing session target could not be focused");
    if (focused_resume_target.boundary ==
        AxFocusedWindowBoundary::kUserTakeover)
      return fail(
          "DIALOG_USER_TAKEOVER",
          "A file, OS, administrator, or security prompt requires the user");
    if (focused_resume_target.boundary != AxFocusedWindowBoundary::kAllowed ||
        focused_resume_target.dialog_set_digest !=
            resume_target.dialog_set_digest ||
        focused_resume_target.active_window_identity !=
            resume_target.active_window_identity ||
        focused_resume_target.active_window_kind !=
            resume_target.active_window_kind ||
        focused_resume_target.active_window_id != resume_target.active_window_id ||
        !BoundsEqual(focused_resume_target.active_bounds,
                     resume_target.active_bounds) ||
        ResolveShareableWindow(pid, focused_resume_target.active_window_id) ==
            nil)
      return fail("STALE_TARGET",
                  "The existing session dialog set changed during resume");
  }
  if (!cancellation_still_valid())
    return fail("CANCELED", "The native session start was canceled");
  if (!process_generation_still_valid())
    return fail("APP_PROCESS_CHANGED",
                "The selected application process changed");

  std::shared_ptr<MacComputerUseSession> native_session = work->session;
  if (creating_session) {
    native_session->session_id = session_id;
    native_session->app_identity = app_identity;
    native_session->executable_path = executable_path;
    native_session->process_generation = process_generation;
    native_session->window_identity = window_identity;
    native_session->policy_language = policy_language;
    native_session->maximum_mode = maximum_mode;
    native_session->pid = pid;
    native_session->window_id = window_id;
    native_session->expected_bounds = selected_bounds;
    native_session->active_window_id = window_id;
    native_session->active_window_identity = window_identity;
    native_session->cancel_epoch.store(start_cancel_epoch,
                                       std::memory_order_release);
    native_session->observation_publication_epoch.store(
        start_cancel_epoch, std::memory_order_release);
    std::lock_guard<std::mutex> sessions_lock(mac_sessions_mutex);
    const auto pending = mac_pending_sessions.find(session_id);
    if (pending == mac_pending_sessions.end() || pending->second != native_session ||
        !mac_sessions.empty() || !cancellation_still_valid())
      return fail("CANCELED", "The native session start was canceled");
    mac_pending_sessions.erase(pending);
    mac_sessions.emplace(session_id, native_session);
  } else {
    native_session = existing_session;
    native_session->cancel_epoch.store(start_cancel_epoch,
                                       std::memory_order_release);
    native_session->observation_publication_epoch.store(
        start_cancel_epoch, std::memory_order_release);
  }
  work->screen_bounds = activation_bounds;
  return cancellation_still_valid();
}

void ExecuteNativeStartSession(napi_env env, void* data) {
  (void)env;
  auto* work = static_cast<AsyncNativeStartSessionWork*>(data);
  std::lock_guard<std::mutex> serial_lock(mac_dispatch_serial_mutex);
  @autoreleasepool {
    try {
      if (!PerformNativeStartSession(work) && work->error_code.empty())
        SetNativeAsyncError(&work->error_code, &work->error_message,
                            "NATIVE_START_FAILED",
                            "The native session could not be started");
    } catch (...) {
      SetNativeAsyncError(&work->error_code, &work->error_message,
                          "NATIVE_START_FAILED",
                          "The native session could not be started");
    }
    if (!work->error_code.empty()) RemovePendingStart(*work);
  }
}

void CompleteNativeStartSession(napi_env env, napi_status status, void* data) {
  auto* work = static_cast<AsyncNativeStartSessionWork*>(data);
  if (status != napi_ok)
    SetNativeAsyncError(&work->error_code, &work->error_message,
                        "ASYNC_UNAVAILABLE",
                        "The native start worker did not complete");
  const std::uint64_t result_cancel_epoch =
      work->session->cancel_epoch.load(std::memory_order_acquire);
  if (work->session->closed.load(std::memory_order_acquire) ||
      result_cancel_epoch != work->start_cancel_epoch ||
      !CheckCancellationEpoch(work->start_cancel_epoch)) {
    work->error_code = "CANCELED";
    work->error_message = "The native session start was canceled";
  }

  if (!work->error_code.empty()) {
    if (work->creating_session) {
      work->session->closed.store(true, std::memory_order_release);
      std::lock_guard<std::mutex> sessions_lock(mac_sessions_mutex);
      const auto active = mac_sessions.find(work->request.session_id);
      if (active != mac_sessions.end() && active->second == work->session)
        mac_sessions.erase(work->request.session_id);
      const auto pending = mac_pending_sessions.find(work->request.session_id);
      if (pending != mac_pending_sessions.end() && pending->second == work->session)
        mac_pending_sessions.erase(pending);
    }
    napi_value error = NativeErrorValue(env, work->error_code.c_str(),
                                        work->error_message.c_str());
    napi_reject_deferred(env, work->deferred, error);
  } else {
    napi_value result;
    napi_create_object(env, &result);
    napi_set_named_property(env, result, "sessionId",
                            StringValue(env, work->request.session_id.c_str()));
    napi_set_named_property(env, result, "pid",
                            NumberValue(env, work->request.pid));
    const std::string native_window_id =
        std::to_string(work->request.window_id);
    napi_set_named_property(env, result, "windowId",
                            StringValue(env, native_window_id.c_str()));
    napi_set_named_property(
        env, result, "appIdentityDigest",
        StringValue(env, work->request.app_identity.c_str()));
    napi_set_named_property(
        env, result, "windowIdentityDigest",
        StringValue(env, work->request.window_identity.c_str()));
    napi_set_named_property(
        env, result, "policyLanguage",
        StringValue(env, work->session->policy_language.c_str()));
    napi_set_named_property(
        env, result, "maximumMode",
        StringValue(env, work->session->maximum_mode.c_str()));
    SetScreenBoundsProperty(env, result, work->screen_bounds);
    napi_set_named_property(
        env, result, "cancelEpoch",
        NumberValue(env, static_cast<double>(result_cancel_epoch)));
    napi_set_named_property(
        env, result, "expectedBoundsX",
        NumberValue(env, work->session->expected_bounds.origin.x));
    napi_set_named_property(
        env, result, "expectedBoundsY",
        NumberValue(env, work->session->expected_bounds.origin.y));
    napi_set_named_property(
        env, result, "expectedBoundsWidth",
        NumberValue(env, work->session->expected_bounds.size.width));
    napi_set_named_property(
        env, result, "expectedBoundsHeight",
        NumberValue(env, work->session->expected_bounds.size.height));
    napi_set_named_property(
        env, result, "nativeObservationRevision",
        NumberValue(env,
                    static_cast<double>(work->session->observation_revision)));
    napi_resolve_deferred(env, work->deferred, result);
  }
  napi_delete_async_work(env, work->work);
  delete work;
}

napi_value CloseSession(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1 ||
      !IsObject(env, argv[0]))
    return ThrowNativeError(env, "INVALID_SESSION", "A native session close request is required");
  std::string session_id;
  if (!ReadNamedString(env, argv[0], "sessionId", &session_id))
    return ThrowNativeError(env, "INVALID_SESSION", "A native session id is required");
  std::shared_ptr<MacComputerUseSession> session;
  {
    std::lock_guard<std::mutex> sessions_lock(mac_sessions_mutex);
    const auto found = mac_sessions.find(session_id);
    if (found != mac_sessions.end()) {
      session = found->second;
      mac_sessions.erase(session_id);
    } else {
      const auto pending = mac_pending_sessions.find(session_id);
      if (pending != mac_pending_sessions.end()) {
        session = pending->second;
        mac_pending_sessions.erase(pending);
      }
    }
  }
  if (session != nullptr) {
    session->closed.store(true, std::memory_order_release);
    session->cancel_epoch.fetch_add(1, std::memory_order_acq_rel);
    session->observation_publication_claimed.store(false,
                                                   std::memory_order_release);
    std::lock_guard<std::mutex> state_lock(session->state_mutex);
    session->has_observation = false;
    session->visual_patch_digests.clear();
    session->dispatch_replay_cache.clear();
    session->dispatch_replay_order.clear();
    session->inflight_dispatches.clear();
  }
  napi_value result;
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "result", StringValue(env, "closed"));
  return result;
}

bool ReadWindowBounds(std::uint32_t window_id, CGRect* bounds) {
  CFArrayRef windows = CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, window_id);
  if (windows == nullptr || CFArrayGetCount(windows) != 1) {
    if (windows != nullptr) CFRelease(windows);
    return false;
  }
  CFDictionaryRef window = static_cast<CFDictionaryRef>(CFArrayGetValueAtIndex(windows, 0));
  CFDictionaryRef bounds_dictionary = nullptr;
  const bool read_bounds =
      window != nullptr &&
      CFDictionaryGetValueIfPresent(window, kCGWindowBounds, reinterpret_cast<const void**>(&bounds_dictionary));
  CGRect result{};
  const bool made_rect = read_bounds && bounds_dictionary != nullptr &&
                         CGRectMakeWithDictionaryRepresentation(bounds_dictionary, &result);
  if (made_rect) *bounds = result;
  CFRelease(windows);
  return made_rect && result.size.width > 0 && result.size.height > 0;
}

bool ReadFrontmostWindow(std::uint32_t pid, std::uint32_t* window_id, CGRect* bounds) {
  CFArrayRef windows = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID);
  if (windows == nullptr) return false;
  bool found = false;
  for (CFIndex index = 0; index < CFArrayGetCount(windows); ++index) {
    const auto window = static_cast<CFDictionaryRef>(CFArrayGetValueAtIndex(windows, index));
    if (window == nullptr) continue;
    const auto owner_pid = static_cast<CFNumberRef>(CFDictionaryGetValue(window, kCGWindowOwnerPID));
    int owner = 0;
    if (owner_pid == nullptr || !CFNumberGetValue(owner_pid, kCFNumberIntType, &owner) ||
        owner <= 0 || static_cast<std::uint32_t>(owner) != pid)
      continue;
    const auto layer_number = static_cast<CFNumberRef>(CFDictionaryGetValue(window, kCGWindowLayer));
    int layer = 0;
    if (layer_number == nullptr || !CFNumberGetValue(layer_number, kCFNumberIntType, &layer) ||
        layer != 0)
      continue;
    const auto number = static_cast<CFNumberRef>(CFDictionaryGetValue(window, kCGWindowNumber));
    int number_value = 0;
    if (number == nullptr || !CFNumberGetValue(number, kCFNumberIntType, &number_value) ||
        number_value <= 0)
      continue;
    CFDictionaryRef bounds_dictionary = nullptr;
    if (!CFDictionaryGetValueIfPresent(window, kCGWindowBounds,
                                       reinterpret_cast<const void**>(&bounds_dictionary)) ||
        bounds_dictionary == nullptr ||
        !CGRectMakeWithDictionaryRepresentation(bounds_dictionary, bounds) ||
        bounds->size.width <= 0 || bounds->size.height <= 0)
      continue;
    *window_id = static_cast<std::uint32_t>(number_value);
    found = true;
    break;
  }
  CFRelease(windows);
  return found;
}

bool ReadAccessibilityRole(napi_env env, AXUIElementRef element, napi_value* result) {
  CFTypeRef role = nullptr;
  if (AXUIElementCopyAttributeValue(element, kAXRoleAttribute, &role) != kAXErrorSuccess ||
      role == nullptr || CFGetTypeID(role) != CFStringGetTypeID()) {
    if (role != nullptr) CFRelease(role);
    return false;
  }
  char buffer[257] = {};
  if (!CFStringGetCString(static_cast<CFStringRef>(role), buffer, sizeof(buffer), kCFStringEncodingUTF8)) {
    CFRelease(role);
    return false;
  }
  *result = StringValue(env, buffer);
  CFRelease(role);
  return true;
}

bool CopyAccessibilityString(AXUIElementRef element, CFStringRef attribute, std::string* output) {
  CFTypeRef value = nullptr;
  if (AXUIElementCopyAttributeValue(element, attribute, &value) != kAXErrorSuccess ||
      value == nullptr || CFGetTypeID(value) != CFStringGetTypeID()) {
    if (value != nullptr) CFRelease(value);
    return false;
  }
  const auto string = static_cast<CFStringRef>(value);
  const CFIndex length = CFStringGetLength(string);
  const CFIndex maximum = CFStringGetMaximumSizeForEncoding(length, kCFStringEncodingUTF8) + 1;
  if (maximum <= 0 || maximum > 4096) {
    CFRelease(value);
    return false;
  }
  std::string buffer(static_cast<std::size_t>(maximum), '\0');
  const bool copied = CFStringGetCString(string, buffer.data(), maximum, kCFStringEncodingUTF8);
  CFRelease(value);
  if (!copied) return false;
  buffer.resize(std::char_traits<char>::length(buffer.c_str()));
  *output = std::move(buffer);
  return true;
}

bool CopyAccessibilityBoolean(AXUIElementRef element, CFStringRef attribute, bool* output) {
  CFTypeRef value = nullptr;
  if (AXUIElementCopyAttributeValue(element, attribute, &value) != kAXErrorSuccess ||
      value == nullptr || CFGetTypeID(value) != CFBooleanGetTypeID()) {
    if (value != nullptr) CFRelease(value);
    return false;
  }
  *output = CFBooleanGetValue(static_cast<CFBooleanRef>(value));
  CFRelease(value);
  return true;
}

bool CopyAccessibilityBooleanLike(AXUIElementRef element, CFStringRef attribute, bool* output) {
  CFTypeRef value = nullptr;
  if (AXUIElementCopyAttributeValue(element, attribute, &value) != kAXErrorSuccess ||
      value == nullptr) {
    if (value != nullptr) CFRelease(value);
    return false;
  }
  bool read = false;
  if (CFGetTypeID(value) == CFBooleanGetTypeID()) {
    *output = CFBooleanGetValue(static_cast<CFBooleanRef>(value));
    read = true;
  } else if (CFGetTypeID(value) == CFNumberGetTypeID()) {
    double number = 0;
    read = CFNumberGetValue(static_cast<CFNumberRef>(value), kCFNumberDoubleType, &number) &&
           std::isfinite(number) && std::floor(number) == number &&
           (number == 0 || number == 1);
    if (read) *output = number == 1;
  }
  CFRelease(value);
  return read;
}

AXUIElementRef CopyAccessibilityElementAttribute(AXUIElementRef element,
                                                 CFStringRef attribute) {
  CFTypeRef value = nullptr;
  if (element == nullptr ||
      AXUIElementCopyAttributeValue(element, attribute, &value) != kAXErrorSuccess ||
      value == nullptr || CFGetTypeID(value) != AXUIElementGetTypeID()) {
    if (value != nullptr) CFRelease(value);
    return nullptr;
  }
  return static_cast<AXUIElementRef>(value);
}

struct CapturedAccessibilityControlBindings {
  std::string focused_control_signature;
  std::unordered_map<std::string, std::string> semantic_control_signatures;
  std::set<std::string> visual_control_signatures;
};

std::string LengthPrefixed(std::string_view value) {
  return std::to_string(value.size()) + ":" + std::string(value);
}

bool ComputeAccessibilityControlSignature(AXUIElementRef element, std::string* signature) {
  if (element == nullptr) return false;
  pid_t element_pid = 0;
  std::string role;
  std::string subrole;
  std::string identifier;
  CGRect bounds{};
  if (AXUIElementGetPid(element, &element_pid) != kAXErrorSuccess || element_pid <= 0 ||
      !CopyAccessibilityString(element, kAXRoleAttribute, &role) || role.empty() ||
      role.size() > 256 || !ReadAccessibilityWindowBounds(element, &bounds) ||
      !std::isfinite(bounds.origin.x) || !std::isfinite(bounds.origin.y) ||
      !std::isfinite(bounds.size.width) || !std::isfinite(bounds.size.height))
    return false;
  CopyAccessibilityString(element, kAXSubroleAttribute, &subrole);
  CopyAccessibilityString(element, kAXIdentifierAttribute, &identifier);
  if (subrole.size() > 256 || identifier.size() > 256) return false;
  const std::string material =
      "computer-ax-control-v1\n" + std::to_string(element_pid) + "\n" +
      std::to_string(static_cast<unsigned long long>(CFHash(element))) + "\n" +
      LengthPrefixed(role) + "\n" + LengthPrefixed(subrole) + "\n" +
      LengthPrefixed(identifier) + "\n" + std::to_string(bounds.origin.x) + ":" +
      std::to_string(bounds.origin.y) + ":" + std::to_string(bounds.size.width) + ":" +
      std::to_string(bounds.size.height);
  *signature = StringDigest(material);
  return true;
}

std::string AccessibilityTargetLookupDigest(std::string_view target_id) {
  return StringDigest("computer-ax-target-key-v1\n" + std::string(target_id));
}

bool CollectAccessibilityControlBindings(
    AXUIElementRef element, std::size_t depth, std::size_t* nodes,
    CapturedAccessibilityControlBindings* bindings,
    std::set<std::string>* duplicate_target_keys) {
  if (element == nullptr || depth > 16 || *nodes >= 5'000) return false;
  ++*nodes;
  std::string signature;
  if (ComputeAccessibilityControlSignature(element, &signature)) {
    bindings->visual_control_signatures.insert(signature);
    std::string target_id;
    if (!CopyAccessibilityString(element, kAXIdentifierAttribute, &target_id) ||
        target_id.empty())
      CopyAccessibilityString(element, kAXTitleAttribute, &target_id);
    if (!target_id.empty() && target_id.size() <= 128) {
      const std::string target_key = AccessibilityTargetLookupDigest(target_id);
      if (duplicate_target_keys->contains(target_key)) {
        bindings->semantic_control_signatures.erase(target_key);
      } else if (bindings->semantic_control_signatures.contains(target_key)) {
        bindings->semantic_control_signatures.erase(target_key);
        duplicate_target_keys->insert(target_key);
      } else {
        bindings->semantic_control_signatures.emplace(target_key, signature);
      }
    }
  }

  CFTypeRef children_value = nullptr;
  if (AXUIElementCopyAttributeValue(element, kAXChildrenAttribute, &children_value) !=
          kAXErrorSuccess ||
      children_value == nullptr || CFGetTypeID(children_value) != CFArrayGetTypeID()) {
    if (children_value != nullptr) CFRelease(children_value);
    return true;
  }
  const auto children = static_cast<CFArrayRef>(children_value);
  bool complete = true;
  for (CFIndex index = 0; index < CFArrayGetCount(children); ++index) {
    const auto child = static_cast<AXUIElementRef>(
        const_cast<void*>(CFArrayGetValueAtIndex(children, index)));
    if (!CollectAccessibilityControlBindings(child, depth + 1, nodes, bindings,
                                             duplicate_target_keys)) {
      complete = false;
      break;
    }
  }
  CFRelease(children_value);
  return complete;
}

bool CaptureAccessibilityControlBindings(
    std::uint32_t pid, CapturedAccessibilityControlBindings* bindings) {
  AXUIElementRef application = AXUIElementCreateApplication(static_cast<pid_t>(pid));
  if (application == nullptr) return false;
  AXUIElementRef focused_window =
      CopyAccessibilityElementAttribute(application, kAXFocusedWindowAttribute);
  AXUIElementRef focused_element =
      CopyAccessibilityElementAttribute(application, kAXFocusedUIElementAttribute);
  CFRelease(application);
  if (focused_window == nullptr) {
    if (focused_element != nullptr) CFRelease(focused_element);
    return false;
  }
  if (focused_element != nullptr) {
    ComputeAccessibilityControlSignature(focused_element,
                                         &bindings->focused_control_signature);
    CFRelease(focused_element);
  }
  std::size_t nodes = 0;
  std::set<std::string> duplicate_target_keys;
  const bool complete = CollectAccessibilityControlBindings(
      focused_window, 0, &nodes, bindings, &duplicate_target_keys);
  CFRelease(focused_window);
  return complete && nodes > 0 && nodes <= 5'000;
}

std::string JsonEscape(std::string_view value) {
  std::string result;
  result.reserve(value.size() + 8);
  for (const unsigned char character : value) {
    switch (character) {
      case '\\': result += "\\\\"; break;
      case '"': result += "\\\""; break;
      case '\b': result += "\\b"; break;
      case '\f': result += "\\f"; break;
      case '\n': result += "\\n"; break;
      case '\r': result += "\\r"; break;
      case '\t': result += "\\t"; break;
      default:
        if (character < 0x20) {
          static constexpr char hexadecimal[] = "0123456789abcdef";
          result += "\\u00";
          result += hexadecimal[(character >> 4) & 0xf];
          result += hexadecimal[character & 0xf];
        } else {
          result.push_back(static_cast<char>(character));
        }
    }
  }
  return result;
}

bool AppendAccessibilityTree(AXUIElementRef element, std::size_t depth, std::size_t* nodes,
                             std::string* json) {
  if (element == nullptr || depth > 16 || *nodes >= 5'000 || json->size() > 512 * 1024)
    return false;
  ++*nodes;
  std::string role;
  std::string subrole;
  std::string title;
  std::string identifier;
  std::string description;
  std::string help;
  std::string placeholder;
  CopyAccessibilityString(element, kAXRoleAttribute, &role);
  CopyAccessibilityString(element, kAXSubroleAttribute, &subrole);
  CopyAccessibilityString(element, kAXTitleAttribute, &title);
  if (@available(macOS 10.10, *)) CopyAccessibilityString(element, kAXIdentifierAttribute, &identifier);
  CopyAccessibilityString(element, kAXDescriptionAttribute, &description);
  CopyAccessibilityString(element, kAXHelpAttribute, &help);
  CopyAccessibilityString(element, kAXPlaceholderValueAttribute, &placeholder);
  *json += "{\"role\":\"" + JsonEscape(role) + "\",\"title\":\"" +
           JsonEscape(title) + "\",\"identifier\":\"" + JsonEscape(identifier) +
           "\",\"subrole\":\"" + JsonEscape(subrole) + "\",\"description\":\"" +
           JsonEscape(description) + "\",\"help\":\"" + JsonEscape(help) +
           "\",\"placeholder\":\"" + JsonEscape(placeholder) + "\"";

  CFTypeRef children_value = nullptr;
  const AXError children_error =
      AXUIElementCopyAttributeValue(element, kAXChildrenAttribute, &children_value);
  if (children_error != kAXErrorSuccess || children_value == nullptr ||
      CFGetTypeID(children_value) != CFArrayGetTypeID()) {
    if (children_value != nullptr) CFRelease(children_value);
    *json += ",\"children\":[]}";
    return json->size() <= 512 * 1024;
  }
  const auto children = static_cast<CFArrayRef>(children_value);
  *json += ",\"children\":[";
  bool first = true;
  bool complete = true;
  for (CFIndex index = 0; index < CFArrayGetCount(children); ++index) {
    if (!first) *json += ',';
    first = false;
    const auto child = static_cast<AXUIElementRef>(
        const_cast<void*>(CFArrayGetValueAtIndex(children, index)));
    if (!AppendAccessibilityTree(child, depth + 1, nodes, json)) {
      complete = false;
      break;
    }
  }
  CFRelease(children_value);
  *json += "]}";
  return complete && json->size() <= 512 * 1024;
}

bool ReadAccessibilityTree(std::uint32_t pid, std::string* json, std::size_t* node_count) {
  AXUIElementRef application = AXUIElementCreateApplication(static_cast<pid_t>(pid));
  if (application == nullptr) return false;
  AXUIElementRef focused_window = nullptr;
  const AXError result = AXUIElementCopyAttributeValue(
      application, kAXFocusedWindowAttribute, reinterpret_cast<CFTypeRef*>(&focused_window));
  CFRelease(application);
  if (result != kAXErrorSuccess || focused_window == nullptr) {
    if (focused_window != nullptr) CFRelease(focused_window);
    return false;
  }
  std::string tree;
  std::size_t nodes = 0;
  const bool complete = AppendAccessibilityTree(focused_window, 0, &nodes, &tree);
  CFRelease(focused_window);
  if (!complete || tree.empty() || tree.size() > 512 * 1024 || nodes == 0 || nodes > 5'000)
    return false;
  *json = std::move(tree);
  *node_count = nodes;
  return true;
}

SCWindow* ResolveShareableWindow(std::uint32_t pid, std::uint32_t window_id) {
  if (!@available(macOS 12.3, *)) return nil;
  __block SCWindow* match = nil;
  dispatch_semaphore_t completed = dispatch_semaphore_create(0);
  [SCShareableContent getShareableContentExcludingDesktopWindows:YES
                                               onScreenWindowsOnly:YES
                                                 completionHandler:^(SCShareableContent* content,
                                                                     NSError* error) {
    if (error == nil && content != nil) {
      for (SCWindow* window in content.windows) {
        if (window.windowID != window_id || window.owningApplication == nil ||
            window.owningApplication.processID != static_cast<pid_t>(pid))
          continue;
        match = window;
        break;
      }
    }
    dispatch_semaphore_signal(completed);
  }];
  if (dispatch_semaphore_wait(completed, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC)) != 0)
    return nil;
  return match;
}

struct CaptureDimensions {
  std::size_t width = 0;
  std::size_t height = 0;
};

CaptureDimensions BoundedCaptureDimensions(SCWindow* window) {
  if (window == nil || window.frame.size.width <= 0 || window.frame.size.height <= 0) return {};
  CGFloat backing_scale = 1;
  for (NSScreen* screen in NSScreen.screens)
    backing_scale = std::max(backing_scale, screen.backingScaleFactor);
  const double source_width = std::max(1.0, std::ceil(window.frame.size.width * backing_scale));
  const double source_height = std::max(1.0, std::ceil(window.frame.size.height * backing_scale));
  const double scale = std::min(
      {1.0, static_cast<double>(kMaxCaptureWidth) / source_width,
       static_cast<double>(kMaxCaptureHeight) / source_height});
  return {
      static_cast<std::size_t>(std::max(1.0, std::floor(source_width * scale))),
      static_cast<std::size_t>(std::max(1.0, std::floor(source_height * scale))),
  };
}

CGImageRef CreateScaledImage(CGImageRef image, std::size_t width, std::size_t height) {
  if (image == nullptr || width == 0 || height == 0 || width > kMaxCaptureWidth ||
      height > kMaxCaptureHeight)
    return nullptr;
  CGColorSpaceRef color_space = CGColorSpaceCreateDeviceRGB();
  if (color_space == nullptr) return nullptr;
  const CGBitmapInfo bitmap_info = static_cast<CGBitmapInfo>(
      static_cast<std::uint32_t>(kCGImageAlphaPremultipliedLast) |
      static_cast<std::uint32_t>(kCGBitmapByteOrder32Big));
  CGContextRef context = CGBitmapContextCreate(
      nullptr, width, height, 8, width * 4, color_space, bitmap_info);
  CGColorSpaceRelease(color_space);
  if (context == nullptr) return nullptr;
  CGContextSetInterpolationQuality(context, kCGInterpolationHigh);
  CGContextDrawImage(context, CGRectMake(0, 0, width, height), image);
  CGImageRef scaled = CGBitmapContextCreateImage(context);
  CGContextRelease(context);
  return scaled;
}

bool EncodePngBytes(CGImageRef image, std::vector<std::uint8_t>* output) {
  if (image == nullptr) return false;
  CFMutableDataRef bytes = CFDataCreateMutable(kCFAllocatorDefault, 0);
  if (bytes == nullptr) return false;
  CGImageDestinationRef destination =
      CGImageDestinationCreateWithData(bytes, CFSTR("public.png"), 1, nullptr);
  const bool encoded = destination != nullptr;
  if (encoded) {
    CGImageDestinationAddImage(destination, image, nullptr);
    if (!CGImageDestinationFinalize(destination)) {
      CFRelease(destination);
      CFRelease(bytes);
      return false;
    }
    CFRelease(destination);
  }
  if (!encoded || CFDataGetLength(bytes) <= 0 ||
      CFDataGetLength(bytes) > static_cast<CFIndex>(32 * 1024 * 1024)) {
    CFRelease(bytes);
    return false;
  }
  const auto* data = CFDataGetBytePtr(bytes);
  output->assign(data, data + CFDataGetLength(bytes));
  CFRelease(bytes);
  return !output->empty();
}

bool EncodeImagePng(CGImageRef image, std::vector<std::uint8_t>* output,
                    std::size_t* width, std::size_t* height) {
  if (image == nullptr) return false;
  std::size_t current_width = CGImageGetWidth(image);
  std::size_t current_height = CGImageGetHeight(image);
  if (current_width == 0 || current_height == 0) return false;
  const double initial_scale = std::min(
      {1.0, static_cast<double>(kMaxCaptureWidth) / current_width,
       static_cast<double>(kMaxCaptureHeight) / current_height});
  CGImageRef current = initial_scale < 1
                           ? CreateScaledImage(
                                 image,
                                 static_cast<std::size_t>(std::max(
                                     1.0, std::floor(current_width * initial_scale))),
                                 static_cast<std::size_t>(std::max(
                                     1.0, std::floor(current_height * initial_scale))))
                           : CGImageRetain(image);
  if (current == nullptr) return false;
  for (int attempt = 0; attempt < 6; ++attempt) {
    std::vector<std::uint8_t> encoded;
    if (!EncodePngBytes(current, &encoded)) {
      CGImageRelease(current);
      return false;
    }
    current_width = CGImageGetWidth(current);
    current_height = CGImageGetHeight(current);
    if (encoded.size() <= kMaxCaptureBytes) {
      *output = std::move(encoded);
      *width = current_width;
      *height = current_height;
      CGImageRelease(current);
      return true;
    }
    const double byte_scale = std::clamp(
        std::sqrt(static_cast<double>(kMaxCaptureBytes) / encoded.size()) * 0.9, 0.5, 0.9);
    const std::size_t next_width = static_cast<std::size_t>(
        std::max(1.0, std::floor(current_width * byte_scale)));
    const std::size_t next_height = static_cast<std::size_t>(
        std::max(1.0, std::floor(current_height * byte_scale)));
    CGImageRef scaled = CreateScaledImage(current, next_width, next_height);
    CGImageRelease(current);
    if (scaled == nullptr) return false;
    current = scaled;
  }
  CGImageRelease(current);
  return false;
}

bool ComputeVisualPatchDigests(CGImageRef image, std::vector<std::string>* digests) {
  if (image == nullptr || digests == nullptr) return false;
  constexpr std::size_t width = kVisualPatchColumns * kVisualPatchWidth;
  constexpr std::size_t height = kVisualPatchRows * kVisualPatchHeight;
  std::vector<std::uint8_t> rgba(width * height * 4, 0);
  CGColorSpaceRef color_space = CGColorSpaceCreateDeviceRGB();
  if (color_space == nullptr) return false;
  const CGBitmapInfo bitmap_info = static_cast<CGBitmapInfo>(
      static_cast<std::uint32_t>(kCGImageAlphaPremultipliedLast) |
      static_cast<std::uint32_t>(kCGBitmapByteOrder32Big));
  CGContextRef context = CGBitmapContextCreate(rgba.data(), width, height, 8, width * 4,
                                               color_space, bitmap_info);
  CGColorSpaceRelease(color_space);
  if (context == nullptr) return false;
  CGContextSetInterpolationQuality(context, kCGInterpolationHigh);
  CGContextDrawImage(context, CGRectMake(0, 0, width, height), image);
  CGContextRelease(context);

  std::vector<std::string> result;
  result.reserve(kVisualPatchColumns * kVisualPatchRows);
  std::vector<std::uint8_t> patch(kVisualPatchWidth * kVisualPatchHeight * 4);
  for (std::size_t row = 0; row < kVisualPatchRows; ++row) {
    for (std::size_t column = 0; column < kVisualPatchColumns; ++column) {
      for (std::size_t y = 0; y < kVisualPatchHeight; ++y) {
        const std::size_t source_offset =
            ((row * kVisualPatchHeight + y) * width + column * kVisualPatchWidth) * 4;
        const std::size_t target_offset = y * kVisualPatchWidth * 4;
        std::copy_n(rgba.data() + source_offset, kVisualPatchWidth * 4,
                    patch.data() + target_offset);
      }
      result.push_back(HexDigest(patch.data(), patch.size()));
    }
  }
  *digests = std::move(result);
  return digests->size() == kVisualPatchColumns * kVisualPatchRows;
}

std::size_t VisualPatchIndex(double normalized_x, double normalized_y) {
  const std::size_t column = std::min(
      kVisualPatchColumns - 1,
      static_cast<std::size_t>(normalized_x * static_cast<double>(kVisualPatchColumns)));
  const std::size_t row = std::min(
      kVisualPatchRows - 1,
      static_cast<std::size_t>(normalized_y * static_cast<double>(kVisualPatchRows)));
  return row * kVisualPatchColumns + column;
}

bool CaptureWindowPng(SCWindow* window, std::vector<std::uint8_t>* output,
                      std::size_t* width, std::size_t* height,
                      std::vector<std::string>* visual_patch_digests = nullptr) {
  if (window == nil) return false;
  const CaptureDimensions dimensions = BoundedCaptureDimensions(window);
  if (dimensions.width == 0 || dimensions.height == 0) return false;
  __block CGImageRef captured = nullptr;
  if (@available(macOS 14.0, *)) {
    SCContentFilter* filter = [[SCContentFilter alloc] initWithDesktopIndependentWindow:window];
    SCStreamConfiguration* configuration = [[SCStreamConfiguration alloc] init];
    configuration.width = dimensions.width;
    configuration.height = dimensions.height;
    configuration.scalesToFit = NO;
    configuration.preservesAspectRatio = YES;
    configuration.showsCursor = NO;
    dispatch_semaphore_t completed = dispatch_semaphore_create(0);
    [SCScreenshotManager captureImageWithFilter:filter
                                  configuration:configuration
                                completionHandler:^(CGImageRef image, NSError* error) {
      if (error == nil && image != nullptr) captured = CGImageRetain(image);
      dispatch_semaphore_signal(completed);
    }];
    if (dispatch_semaphore_wait(completed, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC)) != 0)
      return false;
  } else if (@available(macOS 12.3, *)) {
    SCContentFilter* filter = [[SCContentFilter alloc] initWithDesktopIndependentWindow:window];
    SCStreamConfiguration* configuration = [[SCStreamConfiguration alloc] init];
    configuration.width = dimensions.width;
    configuration.height = dimensions.height;
    configuration.scalesToFit = NO;
    configuration.pixelFormat = kCVPixelFormatType_32BGRA;
    configuration.showsCursor = NO;
    SprintCoderCaptureOutput* output_delegate = [SprintCoderCaptureOutput new];
    output_delegate.frameSemaphore = dispatch_semaphore_create(0);
    NSError* stream_error = nil;
    SCStream* stream = [[SCStream alloc] initWithFilter:filter configuration:configuration delegate:nil];
    if (![stream addStreamOutput:output_delegate
                             type:SCStreamOutputTypeScreen
               sampleHandlerQueue:dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0)
                            error:&stream_error])
      return false;
    dispatch_semaphore_t started = dispatch_semaphore_create(0);
    __block bool start_ok = false;
    [stream startCaptureWithCompletionHandler:^(NSError* error) {
      start_ok = error == nil;
      dispatch_semaphore_signal(started);
    }];
    const bool frame_ready =
        dispatch_semaphore_wait(started, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC)) == 0 &&
        start_ok &&
        dispatch_semaphore_wait(output_delegate.frameSemaphore,
                                dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC)) == 0;
    CMSampleBufferRef sample = frame_ready ? output_delegate.sampleBuffer : nullptr;
    if (sample != nullptr) {
      CVImageBufferRef buffer = CMSampleBufferGetImageBuffer(sample);
      if (buffer != nullptr) {
        CIImage* ci_image = [[CIImage alloc] initWithCVPixelBuffer:buffer];
        CIContext* context = [CIContext contextWithOptions:nil];
        captured = [context createCGImage:ci_image fromRect:CGRectMake(
                                                  0, 0, CVPixelBufferGetWidth(buffer),
                                                  CVPixelBufferGetHeight(buffer))];
      }
      CFRelease(sample);
      output_delegate.sampleBuffer = nullptr;
    }
    if (start_ok) {
      dispatch_semaphore_t stopped = dispatch_semaphore_create(0);
      [stream stopCaptureWithCompletionHandler:^(NSError* error) {
        (void)error;
        dispatch_semaphore_signal(stopped);
      }];
      dispatch_semaphore_wait(stopped, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC));
    }
  }
  if (captured == nullptr) return false;
  const bool patches_ready =
      visual_patch_digests == nullptr ||
      ComputeVisualPatchDigests(captured, visual_patch_digests);
  const bool result = patches_ready && EncodeImagePng(captured, output, width, height);
  CGImageRelease(captured);
  return result;
}

bool ReadNamedUInt64(napi_env env, napi_value object, const char* name, std::uint64_t* output) {
  napi_value value;
  if (napi_get_named_property(env, object, name, &value) != napi_ok) return false;
  std::uint64_t bigint = 0;
  bool lossless = false;
  if (napi_get_value_bigint_uint64(env, value, &bigint, &lossless) == napi_ok && lossless) {
    *output = bigint;
    return true;
  }
  double number = 0;
  if (napi_get_value_double(env, value, &number) != napi_ok || !std::isfinite(number) ||
      number < 0 || number > static_cast<double>(std::numeric_limits<std::uint64_t>::max()) ||
      std::floor(number) != number)
    return false;
  *output = static_cast<std::uint64_t>(number);
  return true;
}

bool CheckCancellationEpoch(std::uint64_t expected) {
  return expected == cancellation_epoch.load(std::memory_order_acquire);
}

bool CheckCancellation(napi_env env, napi_value object) {
  std::uint64_t expected = cancellation_epoch.load(std::memory_order_acquire);
  bool has_epoch = false;
  if (napi_has_named_property(env, object, "cancelEpoch", &has_epoch) != napi_ok || !has_epoch)
    return true;
  if (!ReadNamedUInt64(env, object, "cancelEpoch", &expected)) return false;
  return CheckCancellationEpoch(expected);
}

napi_value Probe(napi_env env, napi_callback_info info) {
  (void)info;
  const bool accessibility = IsAccessibilityTrusted();
  const bool screen_capture = IsScreenCapturePermitted();
  const bool screen_capture_kit = IsScreenCaptureKitAvailable();
  const bool available = accessibility && screen_capture && screen_capture_kit;

  napi_value result;
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "protocolVersion", NumberValue(env, kProtocolVersion));
  napi_set_named_property(env, result, "apiVersion", NumberValue(env, kApiVersion));
  napi_set_named_property(env, result, "backend", StringValue(env, "macos-ax-screen-capture-kit-cgevent"));
  napi_set_named_property(env, result, "available", BoolValue(env, available));

  napi_value capabilities;
  napi_create_object(env, &capabilities);
  napi_set_named_property(env, capabilities, "observe", BoolValue(env, available));
  napi_set_named_property(env, capabilities, "control", BoolValue(env, available));
  napi_set_named_property(env, capabilities, "screenCapture", BoolValue(env, screen_capture));
  napi_set_named_property(env, capabilities, "accessibility", BoolValue(env, accessibility));
  napi_set_named_property(env, capabilities, "screenCaptureKit", BoolValue(env, screen_capture_kit));
  napi_set_named_property(env, result, "capabilities", capabilities);

  const char* reason = available
                           ? ""
                           : !accessibility
                                 ? "ACCESSIBILITY_PERMISSION_REQUIRED"
                                 : !screen_capture
                                       ? "SCREEN_RECORDING_PERMISSION_REQUIRED"
                                       : "SCREEN_CAPTURE_KIT_UNAVAILABLE";
  napi_set_named_property(env, result, "reason", StringValue(env, reason));
  return result;
}

napi_value Handshake(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1 ||
      !IsObject(env, argv[0]))
    return ThrowNativeError(env, "INVALID_HANDSHAKE", "A handshake object is required");

  std::uint32_t protocol = 0;
  std::uint32_t api = 0;
  if (!ReadNamedUint32(env, argv[0], "protocolVersion", &protocol) ||
      !ReadNamedUint32(env, argv[0], "apiVersion", &api) || protocol != kProtocolVersion ||
      api != kApiVersion)
    return ThrowNativeError(env, "PROTOCOL_MISMATCH", "Unsupported Computer Use protocol version");

  napi_value result;
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "protocolVersion", NumberValue(env, kProtocolVersion));
  napi_set_named_property(env, result, "apiVersion", NumberValue(env, kApiVersion));
  napi_set_named_property(env, result, "platform", StringValue(env, "darwin"));
  napi_set_named_property(env, result, "napiVersion", NumberValue(env, NAPI_VERSION));
  return result;
}

struct NativeObservationRequest {
  std::shared_ptr<MacComputerUseSession> session;
  std::uint32_t requested_pid = 0;
  std::uint32_t requested_window_id = 0;
  std::string requested_identity;
  std::string requested_window_identity;
  std::uint64_t requested_cancel_epoch = 0;
};

struct AsyncNativeObservationWork {
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  NativeObservationRequest request;
  std::vector<std::uint8_t> screenshot;
  std::size_t capture_width = 0;
  std::size_t capture_height = 0;
  std::string tree;
  std::size_t tree_nodes = 0;
  std::string focused_role;
  std::string focused_control_signature;
  bool focused_secure = false;
  bool focused_high_impact = false;
  CGRect observation_bounds{};
  CGRect screen_bounds{};
  std::uint64_t observation_revision = 0;
  std::uint64_t dialog_set_revision = 0;
  std::string dialog_set_digest;
  std::string active_window_identity;
  std::string active_window_kind;
  std::string error_code;
  std::string error_message;
};

bool ObservationCancellationStillValid(
    const AsyncNativeObservationWork& work) {
  const MacComputerUseSession& session = *work.request.session;
  return !session.closed.load(std::memory_order_acquire) &&
         session.cancel_epoch.load(std::memory_order_acquire) ==
             work.request.requested_cancel_epoch &&
         CheckCancellationEpoch(work.request.requested_cancel_epoch);
}

void ExecuteNativeObservation(napi_env env, void* data);
void CompleteNativeObservation(napi_env env, napi_status status, void* data);

napi_value Observe(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok ||
      argc != 1 || !IsObject(env, argv[0]))
    return ThrowNativeError(env, "INVALID_OBSERVATION",
                            "An observation target is required");
  auto work = std::make_unique<AsyncNativeObservationWork>();
  std::string session_id;
  if (!ReadNamedString(env, argv[0], "sessionId", &session_id))
    return ThrowNativeError(env, "INVALID_OBSERVATION",
                            "A native session id is required");
  work->request.session = FindMacSession(session_id);
  if (work->request.session == nullptr ||
      work->request.session->closed.load(std::memory_order_acquire))
    return ThrowNativeError(env, "SESSION_MISSING",
                            "The native session is unavailable");
  const MacComputerUseSession& session = *work->request.session;
  if (!ReadNamedUint32(env, argv[0], "pid",
                       &work->request.requested_pid) ||
      !ReadNamedUint32(env, argv[0], "windowId",
                       &work->request.requested_window_id) ||
      !ReadNamedString(env, argv[0], "appIdentityDigest",
                       &work->request.requested_identity) ||
      !ReadNamedString(env, argv[0], "windowIdentityDigest",
                       &work->request.requested_window_identity) ||
      !ReadNamedUInt64(env, argv[0], "cancelEpoch",
                       &work->request.requested_cancel_epoch) ||
      work->request.requested_pid != session.pid ||
      work->request.requested_window_id != session.window_id ||
      work->request.requested_identity != session.app_identity ||
      work->request.requested_window_identity != session.window_identity)
    return ThrowNativeError(env, "SESSION_IDENTITY_MISMATCH",
                            "The native session binding changed");
  if (!CurrentProcessGenerationMatches(session))
    return ThrowNativeError(env, "APP_PROCESS_CHANGED",
                            "The selected application process changed");

  napi_value promise;
  if (napi_create_promise(env, &work->deferred, &promise) != napi_ok)
    return ThrowNativeError(env, "ASYNC_UNAVAILABLE",
                            "Could not create the native observation promise");
  napi_value resource_name =
      StringValue(env, "SprintCoderComputerUseObserve");
  if (napi_create_async_work(env, nullptr, resource_name,
                             ExecuteNativeObservation,
                             CompleteNativeObservation, work.get(),
                             &work->work) != napi_ok ||
      napi_queue_async_work(env, work->work) != napi_ok) {
    if (work->work != nullptr) napi_delete_async_work(env, work->work);
    return ThrowNativeError(env, "ASYNC_UNAVAILABLE",
                            "Could not queue the serial native observation");
  }
  work.release();
  return promise;
}

void ExecuteNativeObservation(napi_env env, void* data) {
  (void)env;
  auto* work = static_cast<AsyncNativeObservationWork*>(data);
  std::lock_guard<std::mutex> serial_lock(mac_dispatch_serial_mutex);
  @autoreleasepool {
    MacComputerUseSession& session = *work->request.session;
    const auto fail = [&](const char* code, const char* message) {
      SetNativeAsyncError(&work->error_code, &work->error_message, code,
                          message);
    };
    try {
      if (!ObservationCancellationStillValid(*work)) {
        fail("CANCELED", "Computer Use observation was canceled");
        return;
      }
      if (!CurrentApplicationMatchesIdentityNative(
              session.pid, session.app_identity, session.executable_path)) {
        fail("APP_IDENTITY_CHANGED",
             "The selected application identity changed");
        return;
      }
      if (!CurrentProcessGenerationMatches(session)) {
        fail("APP_PROCESS_CHANGED",
             "The selected application process changed");
        return;
      }
      if (!IsCurrentApplicationEligible(session.pid)) {
        fail("TARGET_INELIGIBLE",
             "This application category cannot be controlled");
        return;
      }
      if (!IsAccessibilityTrusted() || !IsScreenCapturePermitted() ||
          !IsScreenCaptureKitAvailable()) {
        fail("NATIVE_CAPABILITY_UNAVAILABLE",
             "macOS permissions are unavailable");
        return;
      }
      if (!ObservationCancellationStillValid(*work)) {
        fail("CANCELED", "Computer Use observation was canceled");
        return;
      }
      const std::uint32_t frontmost_pid = FrontmostPid();
      if (frontmost_pid != session.pid) {
        if (frontmost_pid != 0 &&
            IsMacSystemUserTakeoverApplication(frontmost_pid))
          fail("OS_PROMPT_USER_TAKEOVER",
               "A macOS prompt requires the user");
        else
          fail("FOCUS_REQUIRED",
               "The target application is not frontmost");
        return;
      }
      CGRect base_bounds{};
      if (!ReadWindowBounds(session.window_id, &base_bounds)) {
        fail("WINDOW_UNAVAILABLE",
             "The target window could not be observed");
        return;
      }
      if (!BoundsEqual(base_bounds, session.expected_bounds) ||
          ComputerWindowIdentityDigest(session.app_identity,
                                       session.process_generation,
                                       session.window_id, base_bounds) !=
              session.window_identity) {
        fail("STALE_TARGET", "The target window geometry changed");
        return;
      }
      MacDialogSetSnapshot observed_dialogs;
      if (!CaptureMacDialogSetSnapshot(session.pid, session.window_id,
                                       session.app_identity,
                                       session.process_generation,
                                       &observed_dialogs)) {
        fail("FOCUS_REQUIRED",
             "The target app window or dialog is not safely classified");
        return;
      }
      if (observed_dialogs.boundary ==
          AxFocusedWindowBoundary::kUserTakeover) {
        fail("DIALOG_USER_TAKEOVER",
             "A file, OS, administrator, or security prompt requires the user");
        return;
      }
      if (observed_dialogs.boundary != AxFocusedWindowBoundary::kAllowed) {
        fail("FOCUS_REQUIRED",
             "The focused target window is not safely classified");
        return;
      }
      if (!ObservationCancellationStillValid(*work)) {
        fail("CANCELED", "Computer Use observation was canceled");
        return;
      }
      SCWindow* shareable_window = ResolveShareableWindow(
          session.pid, observed_dialogs.active_window_id);
      if (!ObservationCancellationStillValid(*work)) {
        fail("CANCELED", "Computer Use observation was canceled");
        return;
      }
      if (shareable_window == nil) {
        fail("WINDOW_NOT_SHAREABLE",
             "The active target window is not shareable");
        return;
      }

      std::vector<std::string> visual_patch_digests;
      if (!ObservationCancellationStillValid(*work)) {
        fail("CANCELED", "Computer Use observation was canceled");
        return;
      }
      if (!CaptureWindowPng(shareable_window, &work->screenshot,
                            &work->capture_width, &work->capture_height,
                            &visual_patch_digests)) {
        fail("CAPTURE_UNAVAILABLE", "Window capture failed");
        return;
      }
      if (!ObservationCancellationStillValid(*work)) {
        fail("CANCELED", "Computer Use observation was canceled");
        return;
      }
      MacDialogSetSnapshot captured_dialogs;
      if (!CaptureMacDialogSetSnapshot(session.pid, session.window_id,
                                       session.app_identity,
                                       session.process_generation,
                                       &captured_dialogs) ||
          captured_dialogs.boundary != AxFocusedWindowBoundary::kAllowed ||
          captured_dialogs.dialog_set_digest !=
              observed_dialogs.dialog_set_digest ||
          captured_dialogs.active_window_identity !=
              observed_dialogs.active_window_identity ||
          captured_dialogs.active_window_kind !=
              observed_dialogs.active_window_kind ||
          !BoundsEqual(captured_dialogs.active_bounds,
                       observed_dialogs.active_bounds) ||
          !ReadWindowBounds(session.window_id, &base_bounds) ||
          !BoundsEqual(base_bounds, session.expected_bounds)) {
        fail("STALE_TARGET", "The target changed during capture");
        return;
      }

      AXUIElementRef application =
          AXUIElementCreateApplication(static_cast<pid_t>(session.pid));
      if (application != nullptr) {
        AXUIElementRef focused_window = nullptr;
        if (AXUIElementCopyAttributeValue(
                application, kAXFocusedWindowAttribute,
                reinterpret_cast<CFTypeRef*>(&focused_window)) ==
                kAXErrorSuccess &&
            focused_window != nullptr) {
          CopyAccessibilityString(focused_window, kAXRoleAttribute,
                                  &work->focused_role);
          CFRelease(focused_window);
        }
        CFRelease(application);
      }
      if (!ObservationCancellationStillValid(*work)) {
        fail("CANCELED", "Computer Use observation was canceled");
        return;
      }
      if (!ReadAccessibilityTree(session.pid, &work->tree,
                                 &work->tree_nodes)) {
        fail("ACCESSIBILITY_TREE_UNAVAILABLE",
             "Accessibility tree is unavailable");
        return;
      }
      if (!ObservationCancellationStillValid(*work)) {
        fail("CANCELED", "Computer Use observation was canceled");
        return;
      }
      CapturedAccessibilityControlBindings observed_bindings;
      if (!CaptureAccessibilityControlBindings(session.pid,
                                               &observed_bindings)) {
        fail("ACCESSIBILITY_BINDING_UNAVAILABLE",
             "Accessibility control bindings are unavailable");
        return;
      }
      const AxRiskClassification focused_risk =
          ClassifyFocusedElement(session.pid);
      if (!CurrentApplicationMatchesIdentityNative(
              session.pid, session.app_identity, session.executable_path)) {
        fail("APP_IDENTITY_CHANGED",
             "The selected application identity changed");
        return;
      }
      if (!CurrentProcessGenerationMatches(session)) {
        fail("APP_PROCESS_CHANGED",
             "The selected application process changed");
        return;
      }
      if (!ObservationCancellationStillValid(*work)) {
        fail("CANCELED", "Computer Use observation was canceled");
        return;
      }
      MacDialogSetSnapshot completed_dialogs;
      if (!CaptureMacDialogSetSnapshot(session.pid, session.window_id,
                                       session.app_identity,
                                       session.process_generation,
                                       &completed_dialogs) ||
          completed_dialogs.boundary != AxFocusedWindowBoundary::kAllowed ||
          completed_dialogs.dialog_set_digest !=
              observed_dialogs.dialog_set_digest ||
          completed_dialogs.active_window_identity !=
              observed_dialogs.active_window_identity ||
          completed_dialogs.active_window_kind !=
              observed_dialogs.active_window_kind ||
          !BoundsEqual(completed_dialogs.active_bounds,
                       observed_dialogs.active_bounds) ||
          !ReadWindowBounds(session.window_id, &base_bounds) ||
          !BoundsEqual(base_bounds, session.expected_bounds)) {
        fail("STALE_TARGET", "The target changed during observation");
        return;
      }
      if (!ObservationCancellationStillValid(*work)) {
        fail("CANCELED", "Computer Use observation was canceled");
        return;
      }

      bool expected_unclaimed = false;
      if (!session.observation_publication_claimed.compare_exchange_strong(
              expected_unclaimed, true, std::memory_order_acq_rel,
              std::memory_order_acquire) ||
          session.observation_publication_epoch.load(
              std::memory_order_acquire) !=
              work->request.requested_cancel_epoch) {
        session.observation_publication_claimed.store(false,
                                                      std::memory_order_release);
        fail("CANCELED", "Computer Use observation was canceled");
        return;
      }
      {
        std::lock_guard<std::mutex> state_lock(session.state_mutex);
        if (!ObservationCancellationStillValid(*work) ||
            !session.observation_publication_claimed.load(
                std::memory_order_acquire)) {
          session.observation_publication_claimed.store(
              false, std::memory_order_release);
          fail("CANCELED", "Computer Use observation was canceled");
          return;
        }
        session.observation_revision += 1;
        session.observation_bounds = observed_dialogs.active_bounds;
        session.has_observation = true;
        if (session.dialog_set_digest != observed_dialogs.dialog_set_digest)
          session.dialog_set_revision += 1;
        if (session.dialog_set_revision == 0) session.dialog_set_revision = 1;
        session.dialog_set_digest = observed_dialogs.dialog_set_digest;
        session.active_window_identity =
            observed_dialogs.active_window_identity;
        session.active_window_kind = observed_dialogs.active_window_kind;
        session.active_window_id = observed_dialogs.active_window_id;
        session.focused_control_signature =
            observed_bindings.focused_control_signature;
        session.semantic_control_signatures =
            observed_bindings.semantic_control_signatures;
        session.visual_control_signatures =
            observed_bindings.visual_control_signatures;
        session.visual_patch_digests = std::move(visual_patch_digests);

        bool expected_claimed = true;
        if (!ObservationCancellationStillValid(*work) ||
            !session.observation_publication_claimed.compare_exchange_strong(
                expected_claimed, false, std::memory_order_acq_rel,
                std::memory_order_acquire)) {
          session.has_observation = false;
          session.observation_bounds = CGRectZero;
          session.dialog_set_digest.clear();
          session.active_window_identity.clear();
          session.active_window_kind = "application";
          session.active_window_id = 0;
          session.focused_control_signature.clear();
          session.semantic_control_signatures.clear();
          session.visual_control_signatures.clear();
          session.visual_patch_digests.clear();
          session.observation_publication_claimed.store(
              false, std::memory_order_release);
          fail("CANCELED", "Computer Use observation was canceled");
          return;
        }
        work->observation_bounds = session.observation_bounds;
        work->observation_revision = session.observation_revision;
        work->dialog_set_revision = session.dialog_set_revision;
        work->dialog_set_digest = session.dialog_set_digest;
        work->active_window_identity = session.active_window_identity;
        work->active_window_kind = session.active_window_kind;
        work->focused_control_signature =
            session.focused_control_signature;
      }
      work->focused_secure = focused_risk.secure;
      work->focused_high_impact = focused_risk.high_impact;
      work->screen_bounds = work->observation_bounds;
    } catch (...) {
      work->request.session->observation_publication_claimed.store(
          false, std::memory_order_release);
      {
        std::lock_guard<std::mutex> state_lock(
            work->request.session->state_mutex);
        work->request.session->has_observation = false;
        work->request.session->visual_patch_digests.clear();
      }
      fail("NATIVE_OBSERVATION_FAILED",
           "The native observation could not be completed");
    }
  }
}

void CompleteNativeObservation(napi_env env, napi_status status, void* data) {
  auto* work = static_cast<AsyncNativeObservationWork*>(data);
  if (status != napi_ok)
    SetNativeAsyncError(&work->error_code, &work->error_message,
                        "ASYNC_UNAVAILABLE",
                        "The native observation worker did not complete");
  if (!ObservationCancellationStillValid(*work)) {
    work->error_code = "CANCELED";
    work->error_message = "Computer Use observation was canceled";
  }
  if (!work->error_code.empty()) {
    napi_value error = NativeErrorValue(env, work->error_code.c_str(),
                                        work->error_message.c_str());
    napi_reject_deferred(env, work->deferred, error);
  } else {
    const MacComputerUseSession& session = *work->request.session;
    napi_value result;
    napi_create_object(env, &result);
    napi_set_named_property(env, result, "pid", NumberValue(env, session.pid));
    napi_set_named_property(env, result, "windowId",
                            NumberValue(env, session.window_id));
    napi_set_named_property(env, result, "x",
                            NumberValue(env, work->observation_bounds.origin.x));
    napi_set_named_property(env, result, "y",
                            NumberValue(env, work->observation_bounds.origin.y));
    napi_set_named_property(
        env, result, "width",
        NumberValue(env, work->observation_bounds.size.width));
    napi_set_named_property(
        env, result, "height",
        NumberValue(env, work->observation_bounds.size.height));
    napi_set_named_property(
        env, result, "revision",
        NumberValue(env, static_cast<double>(work->observation_revision)));
    napi_set_named_property(
        env, result, "observationBoundsX",
        NumberValue(env, work->observation_bounds.origin.x));
    napi_set_named_property(
        env, result, "observationBoundsY",
        NumberValue(env, work->observation_bounds.origin.y));
    napi_set_named_property(
        env, result, "observationBoundsWidth",
        NumberValue(env, work->observation_bounds.size.width));
    napi_set_named_property(
        env, result, "observationBoundsHeight",
        NumberValue(env, work->observation_bounds.size.height));
    napi_set_named_property(
        env, result, "dialogSetRevision",
        NumberValue(env, static_cast<double>(work->dialog_set_revision)));
    napi_set_named_property(
        env, result, "dialogSetDigest",
        StringValue(env, work->dialog_set_digest.c_str()));
    napi_set_named_property(
        env, result, "activeWindowIdentityDigest",
        StringValue(env, work->active_window_identity.c_str()));
    napi_set_named_property(
        env, result, "activeWindowKind",
        StringValue(env, work->active_window_kind.c_str()));
    napi_set_named_property(
        env, result, "policyLanguage",
        StringValue(env, session.policy_language.c_str()));
    napi_set_named_property(env, result, "maximumMode",
                            StringValue(env, session.maximum_mode.c_str()));
    SetScreenBoundsProperty(env, result, work->screen_bounds);
    napi_set_named_property(
        env, result, "captureWidth",
        NumberValue(env, static_cast<double>(work->capture_width)));
    napi_set_named_property(
        env, result, "captureHeight",
        NumberValue(env, static_cast<double>(work->capture_height)));
    napi_set_named_property(env, result, "tree",
                            StringValue(env, work->tree.c_str()));
    napi_set_named_property(
        env, result, "treeNodeCount",
        NumberValue(env, static_cast<double>(work->tree_nodes)));
    if (work->focused_control_signature.empty()) {
      napi_value null_value;
      napi_get_null(env, &null_value);
      napi_set_named_property(env, result, "focusedElementSignature",
                              null_value);
    } else {
      napi_set_named_property(
          env, result, "focusedElementSignature",
          StringValue(env, work->focused_control_signature.c_str()));
    }
    napi_set_named_property(env, result, "focusedElementSecure",
                            BoolValue(env, work->focused_secure));
    napi_set_named_property(env, result, "focusedElementHighImpact",
                            BoolValue(env, work->focused_high_impact));
    napi_value screenshot_value;
    void* screenshot_data = nullptr;
    if (napi_create_buffer_copy(env, work->screenshot.size(),
                                work->screenshot.data(), &screenshot_data,
                                &screenshot_value) != napi_ok) {
      napi_value error = NativeErrorValue(
          env, "CAPTURE_UNAVAILABLE", "Could not transfer window capture");
      napi_reject_deferred(env, work->deferred, error);
    } else {
      napi_set_named_property(env, result, "screenshot", screenshot_value);
      napi_set_named_property(env, result, "screenshotMimeType",
                              StringValue(env, "image/png"));
      if (!work->focused_role.empty())
        napi_set_named_property(env, result, "focusedRole",
                                StringValue(env, work->focused_role.c_str()));
      napi_resolve_deferred(env, work->deferred, result);
    }
  }
  napi_delete_async_work(env, work->work);
  delete work;
}

bool ReadNamedInt32(napi_env env, napi_value object, const char* name, std::int32_t* output) {
  double number = 0;
  if (!ReadNamedDouble(env, object, name, &number) || number < std::numeric_limits<std::int32_t>::min() ||
      number > std::numeric_limits<std::int32_t>::max() || std::floor(number) != number)
    return false;
  *output = static_cast<std::int32_t>(number);
  return true;
}

bool BoundsEqual(const CGRect& left, const CGRect& right) {
  return left.origin.x == right.origin.x && left.origin.y == right.origin.y &&
         left.size.width == right.size.width && left.size.height == right.size.height;
}

constexpr std::uint32_t kHighImpactPolicyVersion = 1;

std::string LowercaseAscii(std::string value) {
  for (char& character : value)
    if (character >= 'A' && character <= 'Z') character = static_cast<char>(character + ('a' - 'A'));
  return value;
}

bool ContainsAny(std::string_view haystack, const std::vector<std::string_view>& needles) {
  for (const auto needle : needles)
    if (haystack.find(needle) != std::string_view::npos) return true;
  return false;
}

bool IsAsciiTermContinuation(unsigned char character) {
  return (character >= 'a' && character <= 'z') ||
         (character >= '0' && character <= '9');
}

bool ContainsBoundedAsciiTerm(std::string_view haystack,
                              std::string_view needle) {
  for (std::size_t position = haystack.find(needle);
       position != std::string_view::npos;
       position = haystack.find(needle, position + 1)) {
    const bool bounded_before =
        position == 0 || !IsAsciiTermContinuation(static_cast<unsigned char>(
                             haystack[position - 1]));
    const std::size_t end = position + needle.size();
    const bool bounded_after =
        end == haystack.size() ||
        !IsAsciiTermContinuation(static_cast<unsigned char>(haystack[end]));
    if (bounded_before && bounded_after)
      return true;
  }
  return false;
}

bool ContainsAnyBoundedAsciiTerm(std::string_view haystack,
                                 const std::vector<std::string_view>& needles) {
  for (const auto needle : needles)
    if (ContainsBoundedAsciiTerm(haystack, needle)) return true;
  return false;
}

bool IsDialogAccessibilityDescriptor(std::string_view role, std::string_view subrole) {
  const std::string normalized = LowercaseAscii(std::string(role) + "\n" + std::string(subrole));
  return ContainsAny(normalized, {"axsheet", "axdialog", "axsystemdialog"});
}

bool IsFileOrSystemPromptTitle(std::string_view title) {
  const std::string normalized = LowercaseAscii(std::string(title));
  static const std::set<std::string> exact_titles = {
      "open",          "save",       "save as",        "choose a file",
      "choose file",   "select a file", "select file", "open file",
      "open document", "save document", "開く",        "保存",
      "別名で保存",    "ファイルを選択", "書類を選択", "フォルダを選択",
  };
  if (exact_titles.contains(normalized)) return true;
  return ContainsAny(
      normalized,
      {"file chooser", "file picker", "authentication required",
       "administrator privileges", "administrator password", "privacy & security",
       "security & privacy", "system settings", "security settings",
       "accessibility permission", "screen recording permission", "認証が必要",
       "管理者権限", "管理者パスワード", "システム設定", "プライバシーとセキュリティ",
       "セキュリティとプライバシー", "アクセシビリティの許可", "画面収録の許可"});
}

AxFocusedWindowBoundary ClassifyFocusedWindowBoundary(std::uint32_t pid) {
  AXUIElementRef application = AXUIElementCreateApplication(static_cast<pid_t>(pid));
  if (application == nullptr) return AxFocusedWindowBoundary::kUnclassified;
  AXUIElementRef focused_window =
      CopyAccessibilityElementAttribute(application, kAXFocusedWindowAttribute);
  AXUIElementRef focused_element =
      CopyAccessibilityElementAttribute(application, kAXFocusedUIElementAttribute);
  CFRelease(application);
  if (focused_window == nullptr) {
    if (focused_element != nullptr) CFRelease(focused_element);
    return AxFocusedWindowBoundary::kUnclassified;
  }

  AXUIElementRef top_level = CopyAccessibilityElementAttribute(
      focused_element == nullptr ? focused_window : focused_element,
      kAXTopLevelUIElementAttribute);
  AXUIElementRef owner_window = CopyAccessibilityElementAttribute(
      focused_element == nullptr ? focused_window : focused_element, kAXWindowAttribute);
  AXUIElementRef parent =
      CopyAccessibilityElementAttribute(focused_window, kAXParentAttribute);

  std::string role;
  std::string subrole;
  std::string title;
  std::string top_level_role;
  std::string top_level_subrole;
  std::string top_level_title;
  std::string owner_role;
  std::string owner_subrole;
  std::string parent_role;
  std::string parent_subrole;
  CopyAccessibilityString(focused_window, kAXRoleAttribute, &role);
  CopyAccessibilityString(focused_window, kAXSubroleAttribute, &subrole);
  CopyAccessibilityString(focused_window, kAXTitleAttribute, &title);
  if (top_level != nullptr) {
    CopyAccessibilityString(top_level, kAXRoleAttribute, &top_level_role);
    CopyAccessibilityString(top_level, kAXSubroleAttribute, &top_level_subrole);
    CopyAccessibilityString(top_level, kAXTitleAttribute, &top_level_title);
  }
  if (owner_window != nullptr) {
    CopyAccessibilityString(owner_window, kAXRoleAttribute, &owner_role);
    CopyAccessibilityString(owner_window, kAXSubroleAttribute, &owner_subrole);
  }
  if (parent != nullptr) {
    CopyAccessibilityString(parent, kAXRoleAttribute, &parent_role);
    CopyAccessibilityString(parent, kAXSubroleAttribute, &parent_subrole);
  }

  bool focused_modal = false;
  bool top_level_modal = false;
  bool owner_modal = false;
  CopyAccessibilityBoolean(focused_window, kAXModalAttribute, &focused_modal);
  if (top_level != nullptr)
    CopyAccessibilityBoolean(top_level, kAXModalAttribute, &top_level_modal);
  if (owner_window != nullptr)
    CopyAccessibilityBoolean(owner_window, kAXModalAttribute, &owner_modal);

  const bool distinct_top_level_owner =
      top_level != nullptr && owner_window != nullptr && !CFEqual(top_level, owner_window);
  const bool parent_is_window =
      parent_role == "AXWindow" || IsDialogAccessibilityDescriptor(parent_role, parent_subrole);
  const bool dialog_descriptor =
      IsDialogAccessibilityDescriptor(role, subrole) ||
      IsDialogAccessibilityDescriptor(top_level_role, top_level_subrole) ||
      IsDialogAccessibilityDescriptor(owner_role, owner_subrole);
  const bool prompt_title =
      IsFileOrSystemPromptTitle(title) || IsFileOrSystemPromptTitle(top_level_title);
  const bool classified = !role.empty();

  if (parent != nullptr) CFRelease(parent);
  if (owner_window != nullptr) CFRelease(owner_window);
  if (top_level != nullptr) CFRelease(top_level);
  if (focused_element != nullptr) CFRelease(focused_element);
  CFRelease(focused_window);

  const std::string normalized_descriptors = LowercaseAscii(
      role + "\n" + subrole + "\n" + top_level_role + "\n" + top_level_subrole +
      "\n" + owner_role + "\n" + owner_subrole);
  const bool system_dialog = normalized_descriptors.find("axsystemdialog") != std::string::npos;
  if (!classified) return AxFocusedWindowBoundary::kUnclassified;
  if (prompt_title || system_dialog)
    return AxFocusedWindowBoundary::kUserTakeover;
  // Ordinary same-process AXDialog/AXSheet windows are allowed, but only after the caller binds
  // the complete same-owner window set and focused dialog identity into an observation. Structural
  // ambiguity that is not explained by an ordinary dialog remains fail-closed.
  const bool ordinary_dialog = dialog_descriptor || focused_modal || top_level_modal || owner_modal;
  if ((distinct_top_level_owner || parent_is_window) && !ordinary_dialog)
    return AxFocusedWindowBoundary::kUnclassified;
  return AxFocusedWindowBoundary::kAllowed;
}

struct FocusedAxWindowFacts {
  bool classified = false;
  bool dialog = false;
  bool user_takeover = false;
  CGRect bounds{};
  std::string descriptor_digest;
};

FocusedAxWindowFacts ReadFocusedAxWindowFacts(std::uint32_t pid) {
  FocusedAxWindowFacts facts;
  AXUIElementRef application = AXUIElementCreateApplication(static_cast<pid_t>(pid));
  if (application == nullptr) return facts;
  AXUIElementRef focused_window =
      CopyAccessibilityElementAttribute(application, kAXFocusedWindowAttribute);
  CFRelease(application);
  if (focused_window == nullptr) return facts;
  std::string role;
  std::string subrole;
  std::string title;
  CopyAccessibilityString(focused_window, kAXRoleAttribute, &role);
  CopyAccessibilityString(focused_window, kAXSubroleAttribute, &subrole);
  CopyAccessibilityString(focused_window, kAXTitleAttribute, &title);
  bool modal = false;
  CopyAccessibilityBoolean(focused_window, kAXModalAttribute, &modal);
  const bool has_bounds = ReadAccessibilityWindowBounds(focused_window, &facts.bounds);
  const CFHashCode focused_window_hash = CFHash(focused_window);
  CFRelease(focused_window);
  const std::string normalized = LowercaseAscii(role + "\n" + subrole);
  facts.classified = !role.empty() && has_bounds;
  facts.dialog = IsDialogAccessibilityDescriptor(role, subrole) || modal;
  facts.user_takeover = IsFileOrSystemPromptTitle(title) ||
                        normalized.find("axsystemdialog") != std::string::npos;
  facts.descriptor_digest = StringDigest(
      "computer-dialog-descriptor-v1\n" + role + "\n" + subrole + "\n" +
      (facts.user_takeover ? "protected-prompt" : "ordinary") + "\n" +
      (modal ? "modal" : "modeless") + "\n" +
      std::to_string(static_cast<std::uint64_t>(focused_window_hash)) + "\n" +
      std::to_string(facts.bounds.origin.x) + ":" +
      std::to_string(facts.bounds.origin.y) + ":" +
      std::to_string(facts.bounds.size.width) + ":" +
      std::to_string(facts.bounds.size.height));
  return facts;
}

bool AccessibilitySurfaceReachesBaseWindow(AXUIElementRef surface,
                                           AXUIElementRef base_window) {
  if (surface == nullptr || base_window == nullptr) return false;
  pid_t base_pid = 0;
  if (AXUIElementGetPid(base_window, &base_pid) != kAXErrorSuccess || base_pid <= 0)
    return false;
  struct PendingAccessibilityElement {
    AXUIElementRef element = nullptr;
    std::size_t depth = 0;
  };
  constexpr std::size_t kMaximumOwnerChainDepth = 16;
  constexpr std::size_t kMaximumOwnerChainNodes = 64;
  std::vector<PendingAccessibilityElement> pending;
  const auto enqueue = [&](AXUIElementRef element, std::size_t depth) {
    if (element == nullptr) return false;
    pid_t element_pid = 0;
    if (AXUIElementGetPid(element, &element_pid) != kAXErrorSuccess ||
        element_pid != base_pid || depth > kMaximumOwnerChainDepth ||
        pending.size() >= kMaximumOwnerChainNodes) {
      CFRelease(element);
      return false;
    }
    for (const auto& visited : pending) {
      if (CFEqual(visited.element, element)) {
        CFRelease(element);
        return true;
      }
    }
    pending.push_back({element, depth});
    return true;
  };

  CFRetain(surface);
  bool complete = enqueue(surface, 0);
  bool reaches_base = false;
  for (std::size_t index = 0; complete && index < pending.size(); ++index) {
    const PendingAccessibilityElement current = pending[index];
    if (CFEqual(current.element, base_window)) {
      reaches_base = true;
      break;
    }
    if (current.depth == kMaximumOwnerChainDepth) {
      complete = false;
      break;
    }
    for (const CFStringRef relationship :
         {kAXParentAttribute, kAXWindowAttribute,
          kAXTopLevelUIElementAttribute}) {
      AXUIElementRef related =
          CopyAccessibilityElementAttribute(current.element, relationship);
      if (related != nullptr && !enqueue(related, current.depth + 1)) {
        complete = false;
        break;
      }
    }
  }
  for (const auto& element : pending) CFRelease(element.element);
  return complete && reaches_base;
}

bool FocusedAccessibilitySurfaceReachesBaseWindow(std::uint32_t pid,
                                                  const CGRect& base_bounds) {
  AXUIElementRef base_window = FindUniqueAccessibilityWindow(pid, base_bounds);
  if (base_window == nullptr) return false;
  AXUIElementRef application = AXUIElementCreateApplication(static_cast<pid_t>(pid));
  if (application == nullptr) {
    CFRelease(base_window);
    return false;
  }
  AXUIElementRef focused_window =
      CopyAccessibilityElementAttribute(application, kAXFocusedWindowAttribute);
  AXUIElementRef focused_element =
      CopyAccessibilityElementAttribute(application, kAXFocusedUIElementAttribute);
  CFRelease(application);
  const bool focused_surface_reaches_base =
      (focused_window != nullptr &&
       AccessibilitySurfaceReachesBaseWindow(focused_window, base_window)) ||
      (focused_element != nullptr &&
       AccessibilitySurfaceReachesBaseWindow(focused_element, base_window));
  if (focused_element != nullptr) CFRelease(focused_element);
  if (focused_window != nullptr) CFRelease(focused_window);
  CFRelease(base_window);
  return focused_surface_reaches_base;
}

bool CaptureMacDialogSetSnapshot(std::uint32_t pid, std::uint32_t base_window_id,
                                 std::string_view app_identity,
                                 std::string_view process_generation,
                                 MacDialogSetSnapshot* output,
                                 bool require_frontmost) {
  if (output == nullptr || (require_frontmost && FrontmostPid() != pid)) return false;
  std::uint32_t active_window_id = 0;
  CGRect active_bounds{};
  if (!ReadFrontmostWindow(pid, &active_window_id, &active_bounds)) return false;
  const FocusedAxWindowFacts focused = ReadFocusedAxWindowFacts(pid);
  if (!focused.classified) return false;

  CFArrayRef windows =
      CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID);
  if (windows == nullptr) return false;
  std::vector<std::string> owner_window_identities;
  bool found_base = false;
  bool found_active = false;
  for (CFIndex index = 0; index < CFArrayGetCount(windows); ++index) {
    const auto window = static_cast<CFDictionaryRef>(CFArrayGetValueAtIndex(windows, index));
    if (window == nullptr) continue;
    const auto owner_pid =
        static_cast<CFNumberRef>(CFDictionaryGetValue(window, kCGWindowOwnerPID));
    const auto window_number =
        static_cast<CFNumberRef>(CFDictionaryGetValue(window, kCGWindowNumber));
    const auto layer_number =
        static_cast<CFNumberRef>(CFDictionaryGetValue(window, kCGWindowLayer));
    int owner = 0;
    int number = 0;
    int layer = 0;
    if (owner_pid == nullptr || window_number == nullptr || layer_number == nullptr ||
        !CFNumberGetValue(owner_pid, kCFNumberIntType, &owner) ||
        !CFNumberGetValue(window_number, kCFNumberIntType, &number) ||
        !CFNumberGetValue(layer_number, kCFNumberIntType, &layer) || owner <= 0 ||
        number <= 0 || layer != 0 || static_cast<std::uint32_t>(owner) != pid)
      continue;
    CFDictionaryRef bounds_dictionary = nullptr;
    CGRect bounds{};
    if (!CFDictionaryGetValueIfPresent(
            window, kCGWindowBounds,
            reinterpret_cast<const void**>(&bounds_dictionary)) ||
        bounds_dictionary == nullptr ||
        !CGRectMakeWithDictionaryRepresentation(bounds_dictionary, &bounds) ||
        bounds.size.width <= 0 || bounds.size.height <= 0)
      continue;
    const auto id = static_cast<std::uint32_t>(number);
    found_base = found_base || id == base_window_id;
    found_active = found_active || id == active_window_id;
    owner_window_identities.push_back(
        ComputerWindowIdentityDigest(app_identity, process_generation, id, bounds));
  }
  CFRelease(windows);
  if (!found_base || !found_active) return false;
  std::sort(owner_window_identities.begin(), owner_window_identities.end());
  std::string set_material = "computer-dialog-set-v1\n";
  for (const std::string& identity : owner_window_identities)
    set_material += identity + "\n";
  set_material += focused.descriptor_digest;

  const AxFocusedWindowBoundary boundary = ClassifyFocusedWindowBoundary(pid);
  const bool active_is_dialog = focused.dialog || focused.user_takeover;
  CGRect base_bounds{};
  if (!ReadWindowBounds(base_window_id, &base_bounds)) return false;
  const bool focused_surface_reaches_base =
      !active_is_dialog ||
      FocusedAccessibilitySurfaceReachesBaseWindow(pid, base_bounds);
  if (active_window_id != base_window_id && !active_is_dialog) return false;
  if (active_is_dialog) {
    if (!CGRectContainsRect(active_bounds, focused.bounds) &&
        !BoundsEqual(active_bounds, focused.bounds))
      return false;
  } else if (!BoundsEqual(active_bounds, focused.bounds)) {
    return false;
  }
  output->boundary =
      focused.user_takeover || !focused_surface_reaches_base
          ? AxFocusedWindowBoundary::kUserTakeover
          : boundary;
  output->active_window_id = active_window_id;
  output->active_bounds = active_bounds;
  output->active_window_identity =
      ComputerWindowIdentityDigest(app_identity, process_generation, active_window_id,
                                   active_bounds);
  output->active_window_kind = active_is_dialog ? "dialog" : "application";
  output->dialog_set_digest = StringDigest(set_material);
  return !output->active_window_identity.empty() && !output->dialog_set_digest.empty();
}

AxRiskClassification ClassifyAccessibilityElementNode(AXUIElementRef element) {
  AxRiskClassification classification;
  if (element == nullptr) return classification;
  std::string role;
  std::string subrole;
  std::string title;
  std::string description;
  std::string help;
  std::string identifier;
  std::string placeholder;
  CopyAccessibilityString(element, kAXRoleAttribute, &role);
  CopyAccessibilityString(element, kAXSubroleAttribute, &subrole);
  CopyAccessibilityString(element, kAXTitleAttribute, &title);
  CopyAccessibilityString(element, kAXDescriptionAttribute, &description);
  CopyAccessibilityString(element, kAXHelpAttribute, &help);
  CopyAccessibilityString(element, kAXIdentifierAttribute, &identifier);
  CopyAccessibilityString(element, kAXPlaceholderValueAttribute, &placeholder);
  classification.classified = !role.empty() || !subrole.empty() || !title.empty() ||
                              !description.empty() || !help.empty() || !identifier.empty() ||
                              !placeholder.empty();
  const std::string normalized = LowercaseAscii(role + "\n" + subrole + "\n" + title + "\n" +
                                                description + "\n" + help + "\n" + identifier +
                                                "\n" + placeholder);
  classification.secure = ContainsAny(
      normalized,
      {"securetextfield", "passwordfield", "password", "passcode", "pin code", "パスワード",
       "暗証番号"});
  // Versioned v1 policy intentionally excludes ordinary save/send/publish/delete labels. Those
  // are normal full-access app operations unless the target independently carries a protected
  // payment/contract/installer/admin/security meaning.
  classification.high_impact = ContainsAny(
      normalized,
      {"payment", "checkout", "purchase", "billing", "credit card", "card number", "wire transfer",
       "contract", "agreement", "sign agreement", "installer", "install application",
       "administrator", "admin privileges", "sudo", "root access", "security settings",
       "privacy settings", "firewall", "accessibility permission", "screen recording permission",
       "決済", "支払い", "支払う", "購入", "注文を確定", "注文する", "請求", "送金", "契約", "署名",
       "インストール", "管理者", "セキュリティ", "プライバシー", "ファイアウォール"});
  classification.high_impact =
      classification.high_impact ||
      ContainsAnyBoundedAsciiTerm(
          normalized,
          {"pay", "pay now", "place order", "submit order", "complete order", "buy now",
           "pagar", "comprar", "acheter", "bestellen", "bezahlen", "pagare",
           "acquistare", "betalen", "kopen"}) ||
      ContainsAnyBoundedAsciiTerm(
          normalized,
          {"integrated terminal", "terminal", "terminal.app", "console", "shell",
           "powershell", "powershell.exe", "command prompt", "cmd.exe", "run script",
           "shell script", "script console"}) ||
      ContainsAny(normalized,
                  {"ターミナル", "コンソール", "シェル", "コマンドプロンプト",
                   "スクリプトを実行"});
  (void)kHighImpactPolicyVersion;
  return classification;
}

constexpr std::size_t kMaxAccessibilityRiskParentDepth = 8;

AxRiskClassification ClassifyAccessibilityElement(AXUIElementRef element) {
  AxRiskClassification classification;
  if (element == nullptr) return classification;
  CFRetain(element);
  AXUIElementRef current = element;
  for (std::size_t depth = 0;
       current != nullptr && depth < kMaxAccessibilityRiskParentDepth; ++depth) {
    const AxRiskClassification current_classification =
        ClassifyAccessibilityElementNode(current);
    // Parent metadata may only strengthen a target's risk. It must not turn an unclassified leaf
    // into an accepted target, preserving the existing fail-closed leaf requirement.
    if (depth == 0) classification.classified = current_classification.classified;
    classification.secure = classification.secure || current_classification.secure;
    classification.high_impact =
        classification.high_impact || current_classification.high_impact;
    AXUIElementRef parent = CopyAccessibilityElementAttribute(current, kAXParentAttribute);
    CFRelease(current);
    current = parent;
  }
  if (current != nullptr) {
    CFRelease(current);
    // A protected payment/security container may sit above the bounded parent walk.  Unlike a
    // complete walk to the application/window root, truncation cannot prove the leaf is safe.
    classification.classified = false;
  }
  return classification;
}

AxRiskClassification ClassifyFocusedElement(std::uint32_t pid,
                                             std::string* control_signature) {
  if (control_signature != nullptr) control_signature->clear();
  AXUIElementRef application = AXUIElementCreateApplication(static_cast<pid_t>(pid));
  if (application == nullptr) return {};
  AXUIElementRef focused_element = nullptr;
  const AXError copied = AXUIElementCopyAttributeValue(
      application, kAXFocusedUIElementAttribute, reinterpret_cast<CFTypeRef*>(&focused_element));
  CFRelease(application);
  if (copied != kAXErrorSuccess || focused_element == nullptr) {
    if (focused_element != nullptr) CFRelease(focused_element);
    return {};
  }
  const AxRiskClassification classification = ClassifyAccessibilityElement(focused_element);
  if (control_signature != nullptr)
    ComputeAccessibilityControlSignature(focused_element, control_signature);
  CFRelease(focused_element);
  return classification;
}

AxRiskClassification ClassifyElementAtPoint(std::uint32_t pid, CGPoint point,
                                            std::string* control_signature = nullptr) {
  if (control_signature != nullptr) control_signature->clear();
  AXUIElementRef application = AXUIElementCreateApplication(static_cast<pid_t>(pid));
  if (application == nullptr) return {};
  AXUIElementRef element = nullptr;
  const AXError copied = AXUIElementCopyElementAtPosition(
      application, static_cast<float>(point.x), static_cast<float>(point.y), &element);
  CFRelease(application);
  if (copied != kAXErrorSuccess || element == nullptr) {
    if (element != nullptr) CFRelease(element);
    return {};
  }
  const AxRiskClassification classification = ClassifyAccessibilityElement(element);
  if (control_signature != nullptr)
    ComputeAccessibilityControlSignature(element, control_signature);
  CFRelease(element);
  return classification;
}

napi_value RejectedAction(napi_env env, const char* result_value, const char* reason_code) {
  napi_value result;
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "result", StringValue(env, result_value));
  napi_set_named_property(env, result, "reasonCode", StringValue(env, reason_code));
  napi_set_named_property(env, result, "accepted", BoolValue(env, false));
  return result;
}

napi_value RejectFocusedWindowBoundary(napi_env env, AxFocusedWindowBoundary boundary) {
  switch (boundary) {
    case AxFocusedWindowBoundary::kAllowed:
      return nullptr;
    case AxFocusedWindowBoundary::kUnclassified:
      return RejectedAction(env, "rejected", "native_focused_window_unclassified");
    case AxFocusedWindowBoundary::kUserTakeover:
      return RejectedAction(env, "paused", "native_dialog_user_takeover");
  }
  return RejectedAction(env, "rejected", "native_focused_window_unclassified");
}

napi_value RejectFocusedWindowBoundary(napi_env env, std::uint32_t pid) {
  return RejectFocusedWindowBoundary(env, ClassifyFocusedWindowBoundary(pid));
}

napi_value RejectProtectedRiskClassification(napi_env env,
                                             const AxRiskClassification& classification) {
  if (classification.secure)
    return RejectedAction(env, "rejected", "native_secure_field_blocked");
  if (classification.high_impact)
    return RejectedAction(env, "paused", "native_high_impact_user_takeover");
  return nullptr;
}

napi_value RejectRiskClassification(napi_env env, const AxRiskClassification& classification) {
  if (!classification.classified)
    return RejectedAction(env, "rejected", "native_target_unclassified");
  return RejectProtectedRiskClassification(env, classification);
}

bool DecodeUtf8Scalars(std::string_view text, std::vector<std::uint32_t>* output) {
  if (text.empty() || text.size() > 4'096) return false;
  for (std::size_t index = 0; index < text.size();) {
    const auto first = static_cast<unsigned char>(text[index]);
    std::uint32_t scalar = 0;
    std::size_t width = 0;
    if (first <= 0x7f) {
      scalar = first;
      width = 1;
    } else if (first >= 0xc2 && first <= 0xdf) {
      scalar = first & 0x1f;
      width = 2;
    } else if (first >= 0xe0 && first <= 0xef) {
      scalar = first & 0x0f;
      width = 3;
    } else if (first >= 0xf0 && first <= 0xf4) {
      scalar = first & 0x07;
      width = 4;
    } else {
      return false;
    }
    if (index + width > text.size()) return false;
    for (std::size_t offset = 1; offset < width; ++offset) {
      const auto byte = static_cast<unsigned char>(text[index + offset]);
      if ((byte & 0xc0) != 0x80) return false;
      scalar = (scalar << 6) | (byte & 0x3f);
    }
    if (scalar > 0x10ffff || (scalar >= 0xd800 && scalar <= 0xdfff) ||
        (width == 3 && scalar < 0x800) || (width == 4 && scalar < 0x10000))
      return false;
    output->push_back(scalar);
    index += width;
  }
  return !output->empty();
}

bool CreateUnicodeScalarEvents(std::uint32_t scalar, CGEventRef* down_output,
                               CGEventRef* up_output) {
  if (down_output == nullptr || up_output == nullptr) return false;
  *down_output = nullptr;
  *up_output = nullptr;
  UniChar units[2] = {};
  UniCharCount count = 1;
  if (scalar <= 0xffff) {
    units[0] = static_cast<UniChar>(scalar);
  } else {
    scalar -= 0x10000;
    units[0] = static_cast<UniChar>(0xd800 + (scalar >> 10));
    units[1] = static_cast<UniChar>(0xdc00 + (scalar & 0x3ff));
    count = 2;
  }
  CGEventRef down = CGEventCreateKeyboardEvent(nullptr, 0, true);
  CGEventRef up = CGEventCreateKeyboardEvent(nullptr, 0, false);
  if (down == nullptr || up == nullptr) {
    if (down != nullptr) CFRelease(down);
    if (up != nullptr) CFRelease(up);
    return false;
  }
  CGEventKeyboardSetUnicodeString(down, count, units);
  CGEventKeyboardSetUnicodeString(up, count, units);
  *down_output = down;
  *up_output = up;
  return true;
}

CGKeyCode KeyCodeForName(std::string_view key) {
  static const std::unordered_map<std::string_view, CGKeyCode> keys = {
      {"Enter", kVK_Return},       {"Tab", kVK_Tab},
      {"Escape", kVK_Escape},      {"Backspace", kVK_Delete},
      {"Delete", kVK_ForwardDelete}, {"ArrowUp", kVK_UpArrow},
      {"ArrowDown", kVK_DownArrow}, {"ArrowLeft", kVK_LeftArrow},
      {"ArrowRight", kVK_RightArrow}, {"Home", kVK_Home},
      {"End", kVK_End},
  };
  const auto found = keys.find(key);
  return found == keys.end() ? UINT16_MAX : found->second;
}

bool ReadTargetAttribute(AXUIElementRef element, CFStringRef attribute, std::string* output) {
  return CopyAccessibilityString(element, attribute, output);
}

AXUIElementRef FindAccessibilityTarget(AXUIElementRef element, std::string_view target_id,
                                       int depth, int* matches) {
  if (element == nullptr || depth > 16 || *matches > 1) return nullptr;
  std::string identifier;
  std::string title;
  if (ReadTargetAttribute(element, kAXIdentifierAttribute, &identifier) && identifier == target_id) {
    ++*matches;
    CFRetain(element);
    return element;
  }
  if (ReadTargetAttribute(element, kAXTitleAttribute, &title) && title == target_id) {
    ++*matches;
    CFRetain(element);
    return element;
  }
  CFTypeRef children_value = nullptr;
  if (AXUIElementCopyAttributeValue(element, kAXChildrenAttribute, &children_value) != kAXErrorSuccess ||
      children_value == nullptr || CFGetTypeID(children_value) != CFArrayGetTypeID()) {
    if (children_value != nullptr) CFRelease(children_value);
    return nullptr;
  }
  AXUIElementRef match = nullptr;
  const auto children = static_cast<CFArrayRef>(children_value);
  for (CFIndex index = 0; index < CFArrayGetCount(children) && *matches <= 1; ++index) {
    const auto child = static_cast<AXUIElementRef>(
        const_cast<void*>(CFArrayGetValueAtIndex(children, index)));
    AXUIElementRef candidate = FindAccessibilityTarget(child, target_id, depth + 1, matches);
    if (candidate != nullptr) {
      if (match != nullptr) CFRelease(match);
      match = candidate;
    }
  }
  CFRelease(children_value);
  return match;
}

struct NativeDispatchOutcome {
  std::string result = "rejected";
  std::string reason_code = "native_dispatch_failed";
  bool accepted = false;
  bool effect_started = false;
};

struct NativeDispatchRequest {
  std::shared_ptr<MacComputerUseSession> session;
  std::string request_id;
  std::string session_id;
  std::string action_digest;
  std::string envelope_digest;
  std::string kind;
  std::string target_id;
  std::string expected_target_signature;
  std::string text;
  std::string selected_value;
  std::string key;
  bool boolean_value = false;
  double x = 0;
  double y = 0;
  std::int32_t delta_x = 0;
  std::int32_t delta_y = 0;
  std::uint64_t cancel_epoch = 0;
  std::uint64_t observation_revision = 0;
  std::uint64_t dialog_set_revision = 0;
  CGRect observation_bounds{};
  std::string dialog_set_digest;
  std::string active_window_identity;
  std::string active_window_kind;
  std::uint32_t active_window_id = 0;
  std::string focused_control_signature;
  std::set<std::string> visual_control_signatures;
  std::vector<std::string> visual_patch_digests;
};

enum class NativeTargetValidation {
  kValid,
  kCanceled,
  kClosed,
  kCapabilityUnavailable,
  kIdentityChanged,
  kProcessGenerationChanged,
  kIneligible,
  kFocusChanged,
  kDialogUserTakeover,
  kStaleObservation,
};

NativeDispatchOutcome MakeDispatchOutcome(std::string result, std::string reason_code,
                                          bool accepted = false,
                                          bool effect_started = false) {
  return {std::move(result), std::move(reason_code), accepted, effect_started};
}

bool IsLowerHexDigest(std::string_view value) {
  return value.size() == 64 &&
         std::all_of(value.begin(), value.end(), [](char character) {
           return (character >= '0' && character <= '9') ||
                  (character >= 'a' && character <= 'f');
         });
}

NativeDispatchOutcome OutcomeForValidation(NativeTargetValidation validation,
                                           bool effect_started) {
  if (effect_started)
    return MakeDispatchOutcome("unknown_effect", "native_input_effect_unknown", true,
                               true);
  switch (validation) {
    case NativeTargetValidation::kValid:
      return MakeDispatchOutcome("completed", "");
    case NativeTargetValidation::kCanceled:
    case NativeTargetValidation::kClosed:
      return MakeDispatchOutcome("canceled", "native_canceled_pre_dispatch");
    case NativeTargetValidation::kCapabilityUnavailable:
      return MakeDispatchOutcome("rejected", "native_capability_unavailable");
    case NativeTargetValidation::kDialogUserTakeover:
      return MakeDispatchOutcome("paused", "native_dialog_user_takeover");
    case NativeTargetValidation::kIdentityChanged:
      return MakeDispatchOutcome("rejected", "native_app_identity_changed");
    case NativeTargetValidation::kProcessGenerationChanged:
      return MakeDispatchOutcome("rejected", "native_process_generation_changed");
    case NativeTargetValidation::kIneligible:
      return MakeDispatchOutcome("rejected", "native_target_ineligible");
    case NativeTargetValidation::kFocusChanged:
      return MakeDispatchOutcome("rejected", "native_focus_changed");
    case NativeTargetValidation::kStaleObservation:
      return MakeDispatchOutcome("rejected", "native_stale_observation");
  }
  return MakeDispatchOutcome("rejected", "native_dispatch_failed");
}

bool DispatchCancellationStillValid(const NativeDispatchRequest& request) {
  return request.session != nullptr &&
         !request.session->closed.load(std::memory_order_acquire) &&
         request.session->cancel_epoch.load(std::memory_order_acquire) ==
             request.cancel_epoch &&
         CheckCancellationEpoch(request.cancel_epoch);
}

NativeTargetValidation RevalidateBoundTarget(const NativeDispatchRequest& request) {
  const auto& session = request.session;
  if (session == nullptr || session->closed.load(std::memory_order_acquire))
    return NativeTargetValidation::kClosed;
  if (session->cancel_epoch.load(std::memory_order_acquire) != request.cancel_epoch ||
      !CheckCancellationEpoch(request.cancel_epoch))
    return NativeTargetValidation::kCanceled;
  if (!IsAccessibilityTrusted() || !IsScreenCapturePermitted() ||
      !IsScreenCaptureKitAvailable())
    return NativeTargetValidation::kCapabilityUnavailable;
  {
    std::lock_guard<std::mutex> state_lock(session->state_mutex);
    if (!session->has_observation ||
        session->observation_revision != request.observation_revision ||
        session->dialog_set_revision != request.dialog_set_revision ||
        session->dialog_set_digest != request.dialog_set_digest ||
        session->active_window_identity != request.active_window_identity ||
        session->active_window_kind != request.active_window_kind ||
        session->active_window_id != request.active_window_id ||
        !BoundsEqual(session->observation_bounds, request.observation_bounds))
      return NativeTargetValidation::kStaleObservation;
  }
  if (!CurrentApplicationMatchesIdentityNative(
          session->pid, session->app_identity, session->executable_path))
    return NativeTargetValidation::kIdentityChanged;
  if (!CurrentProcessGenerationMatches(*session))
    return NativeTargetValidation::kProcessGenerationChanged;
  if (!IsCurrentApplicationEligible(session->pid))
    return NativeTargetValidation::kIneligible;
  const std::uint32_t frontmost_pid = FrontmostPid();
  if (frontmost_pid != session->pid)
    return frontmost_pid != 0 && IsMacSystemUserTakeoverApplication(frontmost_pid)
               ? NativeTargetValidation::kDialogUserTakeover
               : NativeTargetValidation::kFocusChanged;
  CGRect base_bounds{};
  if (!ReadWindowBounds(session->window_id, &base_bounds) ||
      !BoundsEqual(base_bounds, session->expected_bounds) ||
      ComputerWindowIdentityDigest(session->app_identity, session->process_generation,
                                   session->window_id, base_bounds) !=
          session->window_identity)
    return NativeTargetValidation::kStaleObservation;
  MacDialogSetSnapshot current;
  if (!CaptureMacDialogSetSnapshot(session->pid, session->window_id,
                                   session->app_identity,
                                   session->process_generation, &current))
    return NativeTargetValidation::kFocusChanged;
  if (current.boundary == AxFocusedWindowBoundary::kUserTakeover)
    return NativeTargetValidation::kDialogUserTakeover;
  if (current.boundary != AxFocusedWindowBoundary::kAllowed)
    return NativeTargetValidation::kFocusChanged;
  if (current.dialog_set_digest != request.dialog_set_digest ||
      current.active_window_identity != request.active_window_identity ||
      current.active_window_kind != request.active_window_kind ||
      current.active_window_id != request.active_window_id ||
      !BoundsEqual(current.active_bounds, request.observation_bounds))
    return NativeTargetValidation::kStaleObservation;
  return NativeTargetValidation::kValid;
}

void CacheDispatchOutcome(const NativeDispatchRequest& request,
                          const NativeDispatchOutcome& outcome) {
  const auto& session = request.session;
  if (session == nullptr) return;
  std::lock_guard<std::mutex> state_lock(session->state_mutex);
  const auto existing = session->dispatch_replay_cache.find(request.request_id);
  if (existing == session->dispatch_replay_cache.end()) {
    session->dispatch_replay_order.push_back(request.request_id);
    while (session->dispatch_replay_order.size() > kMaxDispatchReplayEntries) {
      session->dispatch_replay_cache.erase(session->dispatch_replay_order.front());
      session->dispatch_replay_order.pop_front();
    }
  }
  session->dispatch_replay_cache[request.request_id] = {
      request.envelope_digest, outcome.result, outcome.reason_code, outcome.accepted,
      outcome.effect_started};
  session->inflight_dispatches.erase(request.request_id);
}

napi_value DispatchResultValue(napi_env env, const NativeDispatchRequest& request,
                               const NativeDispatchOutcome& outcome) {
  napi_value result;
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "result", StringValue(env, outcome.result.c_str()));
  if (outcome.reason_code.empty()) {
    napi_value null_value;
    napi_get_null(env, &null_value);
    napi_set_named_property(env, result, "reasonCode", null_value);
  } else {
    napi_set_named_property(env, result, "reasonCode",
                           StringValue(env, outcome.reason_code.c_str()));
  }
  napi_set_named_property(env, result, "accepted", BoolValue(env, outcome.accepted));
  napi_set_named_property(env, result, "effectStarted",
                         BoolValue(env, outcome.effect_started));
  napi_set_named_property(env, result, "requestId",
                         StringValue(env, request.request_id.c_str()));
  napi_set_named_property(env, result, "sessionId",
                         StringValue(env, request.session_id.c_str()));
  napi_set_named_property(
      env, result, "observationRevision",
      NumberValue(env, static_cast<double>(request.observation_revision)));
  napi_set_named_property(env, result, "actionDigest",
                         StringValue(env, request.action_digest.c_str()));
  napi_set_named_property(env, result, "kind", StringValue(env, request.kind.c_str()));
  return result;
}

bool RiskOutcome(const AxRiskClassification& risk, NativeDispatchOutcome* outcome) {
  if (!risk.classified) {
    *outcome = MakeDispatchOutcome("rejected", "native_target_unclassified");
    return true;
  }
  if (risk.secure) {
    *outcome = MakeDispatchOutcome("rejected", "native_secure_field_blocked");
    return true;
  }
  if (risk.high_impact) {
    *outcome = MakeDispatchOutcome("paused", "native_high_impact_user_takeover");
    return true;
  }
  return false;
}

AXUIElementRef FindBoundSemanticTarget(const NativeDispatchRequest& request,
                                       AxRiskClassification* risk,
                                       NativeDispatchOutcome* outcome) {
  AXUIElementRef application =
      AXUIElementCreateApplication(static_cast<pid_t>(request.session->pid));
  if (application == nullptr) {
    *outcome = MakeDispatchOutcome("rejected", "native_target_unavailable");
    return nullptr;
  }
  AXUIElementRef focused_window =
      CopyAccessibilityElementAttribute(application, kAXFocusedWindowAttribute);
  CFRelease(application);
  if (focused_window == nullptr) {
    *outcome = MakeDispatchOutcome("rejected", "native_target_unavailable");
    return nullptr;
  }
  int matches = 0;
  AXUIElementRef target =
      FindAccessibilityTarget(focused_window, request.target_id, 0, &matches);
  CFRelease(focused_window);
  if (target == nullptr || matches != 1) {
    if (target != nullptr) CFRelease(target);
    *outcome = MakeDispatchOutcome("rejected", "native_stale_observation");
    return nullptr;
  }
  std::string current_target_signature;
  if (request.expected_target_signature.empty() ||
      !ComputeAccessibilityControlSignature(target, &current_target_signature) ||
      current_target_signature != request.expected_target_signature) {
    CFRelease(target);
    *outcome = MakeDispatchOutcome("rejected", "native_stale_observation");
    return nullptr;
  }
  *risk = ClassifyAccessibilityElement(target);
  if (RiskOutcome(*risk, outcome)) {
    CFRelease(target);
    return nullptr;
  }
  return target;
}

NativeDispatchOutcome PerformSemanticDispatch(const NativeDispatchRequest& request) {
  NativeTargetValidation validation = RevalidateBoundTarget(request);
  if (validation != NativeTargetValidation::kValid)
    return OutcomeForValidation(validation, false);
  NativeDispatchOutcome outcome;
  AxRiskClassification risk;
  AXUIElementRef target = FindBoundSemanticTarget(request, &risk, &outcome);
  if (target == nullptr) return outcome;
  validation = RevalidateBoundTarget(request);
  if (validation != NativeTargetValidation::kValid) {
    CFRelease(target);
    return OutcomeForValidation(validation, false);
  }

  if (request.kind == "toggle") {
    const auto read_toggle_state = [&](bool* state) {
      return CopyAccessibilityBooleanLike(target, kAXValueAttribute, state) ||
             CopyAccessibilityBooleanLike(target, kAXSelectedAttribute, state);
    };
    bool current = false;
    if (!read_toggle_state(&current)) {
      CFRelease(target);
      return MakeDispatchOutcome("rejected", "native_semantic_state_unavailable");
    }
    if (current == request.boolean_value) {
      CFRelease(target);
      return MakeDispatchOutcome("completed", "", true, false);
    }
    if (!DispatchCancellationStillValid(request)) {
      CFRelease(target);
      return OutcomeForValidation(NativeTargetValidation::kCanceled, false);
    }
    outcome = MakeDispatchOutcome("unknown_effect", "native_input_effect_unknown", true,
                                  true);
    const AXError pressed = AXUIElementPerformAction(target, kAXPressAction);
    bool after = false;
    const bool confirmed = pressed == kAXErrorSuccess && read_toggle_state(&after) &&
                           after == request.boolean_value;
    CFRelease(target);
    if (!confirmed) return outcome;
  } else {
    AXError effect = kAXErrorActionUnsupported;
    bool effect_confirmed = false;
    if (request.kind == "invoke") {
      if (!DispatchCancellationStillValid(request)) {
        CFRelease(target);
        return OutcomeForValidation(NativeTargetValidation::kCanceled, false);
      }
      outcome = MakeDispatchOutcome("unknown_effect", "native_input_effect_unknown", true,
                                    true);
      effect = AXUIElementPerformAction(target, kAXPressAction);
      effect_confirmed = effect == kAXErrorSuccess;
    } else if (request.kind == "set_text") {
      CFStringRef value = CFStringCreateWithBytes(
          kCFAllocatorDefault, reinterpret_cast<const UInt8*>(request.text.data()),
          static_cast<CFIndex>(request.text.size()), kCFStringEncodingUTF8, false);
      if (value == nullptr) {
        CFRelease(target);
        return MakeDispatchOutcome("rejected", "native_invalid_text");
      }
      if (!DispatchCancellationStillValid(request)) {
        CFRelease(value);
        CFRelease(target);
        return OutcomeForValidation(NativeTargetValidation::kCanceled, false);
      }
      outcome = MakeDispatchOutcome("unknown_effect", "native_input_effect_unknown", true,
                                    true);
      effect = AXUIElementSetAttributeValue(target, kAXValueAttribute, value);
      CFTypeRef after_value = nullptr;
      effect_confirmed =
          effect == kAXErrorSuccess &&
          AXUIElementCopyAttributeValue(target, kAXValueAttribute, &after_value) ==
              kAXErrorSuccess &&
          after_value != nullptr && CFEqual(after_value, value);
      if (after_value != nullptr) CFRelease(after_value);
      CFRelease(value);
    } else if (request.kind == "select") {
      std::string target_identifier;
      std::string target_title;
      CopyAccessibilityString(target, kAXIdentifierAttribute, &target_identifier);
      CopyAccessibilityString(target, kAXTitleAttribute, &target_title);
      if (request.selected_value != request.target_id &&
          request.selected_value != target_identifier &&
          request.selected_value != target_title) {
        CFRelease(target);
        return MakeDispatchOutcome("rejected", "native_invalid_selection");
      }
      if (!DispatchCancellationStillValid(request)) {
        CFRelease(target);
        return OutcomeForValidation(NativeTargetValidation::kCanceled, false);
      }
      outcome = MakeDispatchOutcome("unknown_effect", "native_input_effect_unknown", true,
                                    true);
      effect = AXUIElementSetAttributeValue(target, kAXSelectedAttribute, kCFBooleanTrue);
      bool selected = false;
      effect_confirmed = effect == kAXErrorSuccess &&
                         CopyAccessibilityBooleanLike(
                             target, kAXSelectedAttribute, &selected) &&
                         selected;
    } else if (request.kind == "expand_collapse") {
      if (!DispatchCancellationStillValid(request)) {
        CFRelease(target);
        return OutcomeForValidation(NativeTargetValidation::kCanceled, false);
      }
      outcome = MakeDispatchOutcome("unknown_effect", "native_input_effect_unknown", true,
                                    true);
      effect = AXUIElementSetAttributeValue(
          target, kAXExpandedAttribute,
          request.boolean_value ? kCFBooleanTrue : kCFBooleanFalse);
      bool expanded = false;
      effect_confirmed = effect == kAXErrorSuccess &&
                         CopyAccessibilityBooleanLike(
                             target, kAXExpandedAttribute, &expanded) &&
                         expanded == request.boolean_value;
    }
    CFRelease(target);
    if (effect != kAXErrorSuccess || !effect_confirmed) return outcome;
  }
  validation = RevalidateBoundTarget(request);
  if (validation != NativeTargetValidation::kValid)
    return OutcomeForValidation(validation, true);
  return MakeDispatchOutcome("completed", "", true, true);
}

bool FreshVisualPatchMatches(const NativeDispatchRequest& request,
                             NativeDispatchOutcome* failure) {
  if (request.visual_patch_digests.size() !=
      kVisualPatchColumns * kVisualPatchRows) {
    *failure = MakeDispatchOutcome("rejected", "native_visual_binding_unavailable");
    return false;
  }
  SCWindow* active =
      ResolveShareableWindow(request.session->pid, request.active_window_id);
  if (active == nil) {
    *failure = MakeDispatchOutcome("rejected", "native_window_not_shareable");
    return false;
  }
  std::vector<std::uint8_t> fresh_screenshot;
  std::vector<std::string> fresh_patch_digests;
  std::size_t width = 0;
  std::size_t height = 0;
  if (!CaptureWindowPng(active, &fresh_screenshot, &width, &height,
                        &fresh_patch_digests)) {
    *failure = MakeDispatchOutcome("rejected", "native_capture_unavailable");
    return false;
  }
  const NativeTargetValidation validation = RevalidateBoundTarget(request);
  if (validation != NativeTargetValidation::kValid) {
    *failure = OutcomeForValidation(validation, false);
    return false;
  }
  const std::size_t patch_index = VisualPatchIndex(request.x, request.y);
  if (fresh_patch_digests.size() != request.visual_patch_digests.size() ||
      patch_index >= fresh_patch_digests.size() ||
      fresh_patch_digests[patch_index] != request.visual_patch_digests[patch_index]) {
    *failure = MakeDispatchOutcome("rejected", "native_visual_patch_changed");
    return false;
  }
  return true;
}

bool RevalidateVisualPointBeforePost(const NativeDispatchRequest& request,
                                     const CGPoint& point,
                                     NativeDispatchOutcome* failure) {
  NativeTargetValidation validation = RevalidateBoundTarget(request);
  if (validation != NativeTargetValidation::kValid) {
    *failure = OutcomeForValidation(validation, false);
    return false;
  }
  std::string control_signature;
  const AxRiskClassification risk =
      ClassifyElementAtPoint(request.session->pid, point, &control_signature);
  if (RiskOutcome(risk, failure)) return false;
  if (control_signature.empty() ||
      !request.visual_control_signatures.contains(control_signature)) {
    *failure = MakeDispatchOutcome("rejected", "native_stale_observation");
    return false;
  }
  if (!FreshVisualPatchMatches(request, failure)) return false;

  // Capture can take long enough for focus or the AX element at the point to change. Re-read the
  // point binding after the patch and leave only the final cancellation check before posting.
  validation = RevalidateBoundTarget(request);
  if (validation != NativeTargetValidation::kValid) {
    *failure = OutcomeForValidation(validation, false);
    return false;
  }
  control_signature.clear();
  const AxRiskClassification final_risk =
      ClassifyElementAtPoint(request.session->pid, point, &control_signature);
  if (RiskOutcome(final_risk, failure)) return false;
  if (control_signature.empty() ||
      !request.visual_control_signatures.contains(control_signature)) {
    *failure = MakeDispatchOutcome("rejected", "native_stale_observation");
    return false;
  }
  if (!DispatchCancellationStillValid(request)) {
    *failure = OutcomeForValidation(NativeTargetValidation::kCanceled, false);
    return false;
  }
  return true;
}

NativeDispatchOutcome PerformVisualDispatch(const NativeDispatchRequest& request) {
  NativeTargetValidation validation = RevalidateBoundTarget(request);
  if (validation != NativeTargetValidation::kValid)
    return OutcomeForValidation(validation, false);
  const CGPoint point = CGPointMake(
      request.observation_bounds.origin.x +
          request.x * std::max<CGFloat>(0, request.observation_bounds.size.width - 1),
      request.observation_bounds.origin.y +
          request.y * std::max<CGFloat>(0, request.observation_bounds.size.height - 1));
  std::string control_signature;
  const AxRiskClassification risk =
      ClassifyElementAtPoint(request.session->pid, point, &control_signature);
  NativeDispatchOutcome outcome;
  if (RiskOutcome(risk, &outcome)) return outcome;
  if (control_signature.empty() ||
      !request.visual_control_signatures.contains(control_signature))
    return MakeDispatchOutcome("rejected", "native_stale_observation");
  if (request.kind == "click") {
    CGEventRef down = CGEventCreateMouseEvent(nullptr, kCGEventLeftMouseDown, point,
                                              kCGMouseButtonLeft);
    CGEventRef up = CGEventCreateMouseEvent(nullptr, kCGEventLeftMouseUp, point,
                                            kCGMouseButtonLeft);
    if (down == nullptr || up == nullptr) {
      if (down != nullptr) CFRelease(down);
      if (up != nullptr) CFRelease(up);
      return MakeDispatchOutcome("rejected", "native_input_unavailable");
    }
    if (!RevalidateVisualPointBeforePost(request, point, &outcome)) {
      CFRelease(down);
      CFRelease(up);
      return outcome;
    }
    CGEventPostToPid(static_cast<pid_t>(request.session->pid), down);
    CFRelease(down);
    const NativeTargetValidation between_mouse_events = RevalidateBoundTarget(request);
    // A posted down event may already have changed the target. Always release the button, then
    // classify any subsequent uncertainty as unknown_effect.
    CGEventPostToPid(static_cast<pid_t>(request.session->pid), up);
    CFRelease(up);
    if (between_mouse_events != NativeTargetValidation::kValid)
      return OutcomeForValidation(between_mouse_events, true);
  } else {
    CGEventRef event = CGEventCreateScrollWheelEvent(
        nullptr, kCGScrollEventUnitLine, 2, request.delta_y, request.delta_x);
    if (event == nullptr)
      return MakeDispatchOutcome("rejected", "native_input_unavailable");
    CGEventSetLocation(event, point);
    if (!RevalidateVisualPointBeforePost(request, point, &outcome)) {
      CFRelease(event);
      return outcome;
    }
    CGEventPostToPid(static_cast<pid_t>(request.session->pid), event);
    CFRelease(event);
  }
  validation = RevalidateBoundTarget(request);
  if (validation != NativeTargetValidation::kValid)
    return OutcomeForValidation(validation, true);
  return MakeDispatchOutcome("completed", "", true, true);
}

NativeDispatchOutcome PerformFocusedInputDispatch(
    const NativeDispatchRequest& request) {
  NativeTargetValidation validation = RevalidateBoundTarget(request);
  if (validation != NativeTargetValidation::kValid)
    return OutcomeForValidation(validation, false);
  std::string current_control_signature;
  const AxRiskClassification risk = ClassifyFocusedElement(
      request.session->pid, &current_control_signature);
  NativeDispatchOutcome outcome;
  if (RiskOutcome(risk, &outcome)) return outcome;
  if (request.focused_control_signature.empty() ||
      current_control_signature != request.focused_control_signature)
    return MakeDispatchOutcome("rejected", "native_stale_observation");
  validation = RevalidateBoundTarget(request);
  if (validation != NativeTargetValidation::kValid)
    return OutcomeForValidation(validation, false);

  if (request.kind == "type") {
    std::vector<std::uint32_t> scalars;
    if (!DecodeUtf8Scalars(request.text, &scalars) || scalars.size() != 1)
      return MakeDispatchOutcome("rejected", "native_invalid_text");
    CGEventRef down = nullptr;
    CGEventRef up = nullptr;
    if (!CreateUnicodeScalarEvents(scalars.front(), &down, &up))
      return MakeDispatchOutcome("rejected", "native_input_unavailable");
    if (!DispatchCancellationStillValid(request)) {
      CFRelease(down);
      CFRelease(up);
      return OutcomeForValidation(NativeTargetValidation::kCanceled, false);
    }
    CGEventPostToPid(static_cast<pid_t>(request.session->pid), down);
    CFRelease(down);
    const NativeTargetValidation between_key_events = RevalidateBoundTarget(request);
    CGEventPostToPid(static_cast<pid_t>(request.session->pid), up);
    CFRelease(up);
    if (between_key_events != NativeTargetValidation::kValid)
      return OutcomeForValidation(between_key_events, true);
  } else {
    const CGKeyCode key_code = KeyCodeForName(request.key);
    if (key_code == UINT16_MAX)
      return MakeDispatchOutcome("rejected", "native_key_not_allowed");
    CGEventRef down = CGEventCreateKeyboardEvent(nullptr, key_code, true);
    CGEventRef up = CGEventCreateKeyboardEvent(nullptr, key_code, false);
    if (down == nullptr || up == nullptr) {
      if (down != nullptr) CFRelease(down);
      if (up != nullptr) CFRelease(up);
      return MakeDispatchOutcome("rejected", "native_input_unavailable");
    }
    if (!DispatchCancellationStillValid(request)) {
      CFRelease(down);
      CFRelease(up);
      return OutcomeForValidation(NativeTargetValidation::kCanceled, false);
    }
    CGEventPostToPid(static_cast<pid_t>(request.session->pid), down);
    CFRelease(down);
    const NativeTargetValidation between_key_events = RevalidateBoundTarget(request);
    CGEventPostToPid(static_cast<pid_t>(request.session->pid), up);
    CFRelease(up);
    if (between_key_events != NativeTargetValidation::kValid)
      return OutcomeForValidation(between_key_events, true);
  }
  validation = RevalidateBoundTarget(request);
  if (validation != NativeTargetValidation::kValid)
    return OutcomeForValidation(validation, true);
  return MakeDispatchOutcome("completed", "", true, true);
}

NativeDispatchOutcome PerformNativeDispatch(const NativeDispatchRequest& request) {
  if (request.kind == "invoke" || request.kind == "set_text" ||
      request.kind == "select" || request.kind == "toggle" ||
      request.kind == "expand_collapse")
    return PerformSemanticDispatch(request);
  if (request.kind == "click" || request.kind == "scroll")
    return PerformVisualDispatch(request);
  if (request.kind == "type" || request.kind == "key")
    return PerformFocusedInputDispatch(request);
  return MakeDispatchOutcome("rejected", "native_unsupported_action");
}

bool ReadNamedBool(napi_env env, napi_value object, const char* name, bool* output) {
  napi_value value;
  return napi_get_named_property(env, object, name, &value) == napi_ok &&
         napi_get_value_bool(env, value, output) == napi_ok;
}

bool ParseNativeDispatchRequest(napi_env env, napi_value object,
                                NativeDispatchRequest* request,
                                NativeDispatchOutcome* replay,
                                bool* has_replay, std::string* error_code,
                                std::string* error_message) {
  *has_replay = false;
  std::uint32_t requested_pid = 0;
  std::uint32_t requested_window_id = 0;
  std::string requested_identity;
  std::string requested_window_identity;
  if (!ReadNamedString(env, object, "kind", &request->kind) &&
      !ReadNamedString(env, object, "type", &request->kind)) {
    *error_code = "INVALID_ACTION";
    *error_message = "An action kind is required";
    return false;
  }
  if (!ReadNamedString(env, object, "requestId", &request->request_id) ||
      !ReadNamedString(env, object, "sessionId", &request->session_id) ||
      !ReadNamedString(env, object, "actionDigest", &request->action_digest) ||
      !IsLowerHexDigest(request->action_digest) ||
      !ReadNamedUint32(env, object, "pid", &requested_pid) ||
      !ReadNamedUint32(env, object, "windowId", &requested_window_id) ||
      !ReadNamedString(env, object, "appIdentityDigest", &requested_identity) ||
      !ReadNamedString(env, object, "windowIdentityDigest",
                       &requested_window_identity) ||
      !ReadNamedUInt64(env, object, "cancelEpoch", &request->cancel_epoch) ||
      !ReadNamedUInt64(env, object, "observationRevision",
                       &request->observation_revision) ||
      request->observation_revision == 0) {
    *error_code = "INVALID_ACTION_ENVELOPE";
    *error_message = "A request, session, observation, and action digest binding is required";
    return false;
  }
  request->session = FindMacSession(request->session_id);
  if (request->session == nullptr ||
      request->session->closed.load(std::memory_order_acquire)) {
    *error_code = "SESSION_MISSING";
    *error_message = "The native session is unavailable";
    return false;
  }
  MacComputerUseSession& session = *request->session;
  if (requested_pid != session.pid || requested_window_id != session.window_id ||
      requested_identity != session.app_identity ||
      requested_window_identity != session.window_identity) {
    *error_code = "SESSION_IDENTITY_MISMATCH";
    *error_message = "The native session binding changed";
    return false;
  }
  if (!CurrentProcessGenerationMatches(session)) {
    *error_code = "APP_PROCESS_CHANGED";
    *error_message = "The selected application process changed";
    return false;
  }

  if (request->kind == "invoke" || request->kind == "set_text" ||
      request->kind == "select" || request->kind == "toggle" ||
      request->kind == "expand_collapse") {
    if (!ReadNamedString(env, object, "targetId", &request->target_id) &&
        !ReadNamedString(env, object, "elementId", &request->target_id)) {
      *error_code = "TARGET_REQUIRED";
      *error_message = "A unique accessibility target is required";
      return false;
    }
    if (request->kind == "set_text" &&
        !ReadNamedString(env, object, "text", &request->text, 4'096)) {
      *error_code = "INVALID_ACTION";
      *error_message = "Set text must be valid bounded UTF-8";
      return false;
    }
    if (request->kind == "select" &&
        !ReadNamedString(env, object, "value", &request->selected_value, 4'096)) {
      *error_code = "INVALID_ACTION";
      *error_message = "A bounded selection value is required";
      return false;
    }
    if (request->kind == "toggle" &&
        !ReadNamedBool(env, object, "value", &request->boolean_value)) {
      *error_code = "INVALID_ACTION";
      *error_message = "A boolean toggle value is required";
      return false;
    }
    if (request->kind == "expand_collapse" &&
        !ReadNamedBool(env, object, "expanded", &request->boolean_value)) {
      *error_code = "INVALID_ACTION";
      *error_message = "A boolean expanded value is required";
      return false;
    }
  } else if (request->kind == "click" || request->kind == "scroll") {
    if (!ReadNamedDouble(env, object, "x", &request->x) ||
        !ReadNamedDouble(env, object, "y", &request->y) || request->x < 0 ||
        request->x > 1 || request->y < 0 || request->y > 1) {
      *error_code = "INVALID_ACTION";
      *error_message = "A normalized visual coordinate is required";
      return false;
    }
    if (request->kind == "scroll" &&
        (!ReadNamedInt32(env, object, "deltaX", &request->delta_x) ||
         !ReadNamedInt32(env, object, "deltaY", &request->delta_y) ||
         request->delta_x < -10'000 || request->delta_x > 10'000 ||
         request->delta_y < -10'000 || request->delta_y > 10'000)) {
      *error_code = "INVALID_ACTION";
      *error_message = "A bounded scroll delta is required";
      return false;
    }
  } else if (request->kind == "type") {
    std::vector<std::uint32_t> scalars;
    if (!ReadNamedString(env, object, "text", &request->text, 4'096) ||
        !DecodeUtf8Scalars(request->text, &scalars) || scalars.size() != 1) {
      *error_code = "INVALID_ACTION";
      *error_message = "Each native type request must contain one Unicode scalar";
      return false;
    }
  } else if (request->kind == "key") {
    if (!ReadNamedString(env, object, "key", &request->key) ||
        KeyCodeForName(request->key) == UINT16_MAX) {
      *error_code = "INVALID_ACTION";
      *error_message = "Key is outside the Computer Use allowlist";
      return false;
    }
  } else {
    *error_code = "UNSUPPORTED_ACTION";
    *error_message = "Computer Use action is unsupported natively";
    return false;
  }

  {
    std::lock_guard<std::mutex> state_lock(session.state_mutex);
    if (!session.has_observation ||
        request->observation_revision != session.observation_revision) {
      *error_code = "STALE_TARGET";
      *error_message = "The native observation revision is stale";
      return false;
    }
    request->dialog_set_revision = session.dialog_set_revision;
    request->observation_bounds = session.observation_bounds;
    request->dialog_set_digest = session.dialog_set_digest;
    request->active_window_identity = session.active_window_identity;
    request->active_window_kind = session.active_window_kind;
    request->active_window_id = session.active_window_id;
    request->focused_control_signature = session.focused_control_signature;
    request->visual_control_signatures = session.visual_control_signatures;
    request->visual_patch_digests = session.visual_patch_digests;
    if (!request->target_id.empty()) {
      const auto target = session.semantic_control_signatures.find(
          AccessibilityTargetLookupDigest(request->target_id));
      if (target != session.semantic_control_signatures.end())
        request->expected_target_signature = target->second;
    }
    request->envelope_digest = StringDigest(
        "computer-native-dispatch-envelope-v1\n" + request->request_id + "\n" +
        request->session_id + "\n" +
        std::to_string(request->observation_revision) + "\n" +
        std::to_string(request->dialog_set_revision) + "\n" +
        request->dialog_set_digest + "\n" + request->active_window_identity + "\n" +
        request->action_digest + "\n" + std::to_string(request->cancel_epoch));
    const auto cached = session.dispatch_replay_cache.find(request->request_id);
    if (cached != session.dispatch_replay_cache.end()) {
      if (cached->second.envelope_digest != request->envelope_digest) {
        *replay = MakeDispatchOutcome("rejected", "native_request_id_conflict");
      } else {
        *replay = {cached->second.result, cached->second.reason_code,
                   cached->second.accepted, cached->second.effect_started};
      }
      *has_replay = true;
      return true;
    }
    const auto inflight = session.inflight_dispatches.find(request->request_id);
    if (inflight != session.inflight_dispatches.end()) {
      *replay = MakeDispatchOutcome(
          "rejected", inflight->second == request->envelope_digest
                          ? "native_request_in_flight"
                          : "native_request_id_conflict");
      *has_replay = true;
      return true;
    }
    if (session.inflight_dispatches.size() >= kMaxInflightDispatchEntries) {
      *replay = MakeDispatchOutcome("rejected", "native_dispatch_busy");
      *has_replay = true;
      return true;
    }
    session.inflight_dispatches.emplace(request->request_id,
                                        request->envelope_digest);
  }
  return true;
}

struct AsyncNativeDispatchWork {
  napi_env env = nullptr;
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  NativeDispatchRequest request;
  NativeDispatchOutcome outcome;
};

void ExecuteNativeDispatch(napi_env env, void* data) {
  (void)env;
  auto* work = static_cast<AsyncNativeDispatchWork*>(data);
  std::lock_guard<std::mutex> serial_lock(mac_dispatch_serial_mutex);
  @autoreleasepool {
    try {
      work->outcome = PerformNativeDispatch(work->request);
    } catch (...) {
      // Native APIs do not normally throw C++ exceptions. If one escapes after work entered the
      // serial effect lane, retry safety cannot be proven, so return unknown_effect.
      work->outcome = MakeDispatchOutcome(
          "unknown_effect", "native_dispatch_exception_unknown_effect", true, true);
    }
    CacheDispatchOutcome(work->request, work->outcome);
  }
}

void CompleteNativeDispatch(napi_env env, napi_status status, void* data) {
  auto* work = static_cast<AsyncNativeDispatchWork*>(data);
  if (status != napi_ok && work->outcome.reason_code == "native_dispatch_failed") {
    work->outcome = MakeDispatchOutcome("unknown_effect",
                                        "native_async_completion_unknown_effect", true,
                                        true);
    CacheDispatchOutcome(work->request, work->outcome);
  }
  napi_value result = DispatchResultValue(env, work->request, work->outcome);
  napi_resolve_deferred(env, work->deferred, result);
  napi_delete_async_work(env, work->work);
  delete work;
}

napi_value Dispatch(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1 ||
      !IsObject(env, argv[0]))
    return ThrowNativeError(env, "INVALID_ACTION", "A dispatch action is required");
  auto work = std::make_unique<AsyncNativeDispatchWork>();
  work->env = env;
  NativeDispatchOutcome replay;
  bool has_replay = false;
  std::string error_code;
  std::string error_message;
  if (!ParseNativeDispatchRequest(env, argv[0], &work->request, &replay, &has_replay,
                                  &error_code, &error_message))
    return ThrowNativeError(env, error_code.c_str(), error_message.c_str());
  if (has_replay) return DispatchResultValue(env, work->request, replay);

  napi_value promise;
  if (napi_create_promise(env, &work->deferred, &promise) != napi_ok) {
    std::lock_guard<std::mutex> state_lock(work->request.session->state_mutex);
    work->request.session->inflight_dispatches.erase(work->request.request_id);
    return ThrowNativeError(env, "ASYNC_UNAVAILABLE",
                            "Could not create the native dispatch promise");
  }
  napi_value resource_name = StringValue(env, "SprintCoderComputerUseDispatch");
  if (napi_create_async_work(env, nullptr, resource_name, ExecuteNativeDispatch,
                             CompleteNativeDispatch, work.get(), &work->work) != napi_ok ||
      napi_queue_async_work(env, work->work) != napi_ok) {
    if (work->work != nullptr) napi_delete_async_work(env, work->work);
    std::lock_guard<std::mutex> state_lock(work->request.session->state_mutex);
    work->request.session->inflight_dispatches.erase(work->request.request_id);
    return ThrowNativeError(env, "ASYNC_UNAVAILABLE",
                            "Could not queue the serial native dispatch");
  }
  work.release();
  return promise;
}

napi_value Cancel(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1 ||
      !IsObject(env, argv[0]))
    return ThrowNativeError(env, "INVALID_CANCEL", "A cancel request is required");
  std::string session_id;
  std::uint64_t requested_cancel_epoch = 0;
  if (!ReadNamedString(env, argv[0], "sessionId", &session_id) ||
      !ReadNamedUInt64(env, argv[0], "cancelEpoch", &requested_cancel_epoch))
    return ThrowNativeError(env, "INVALID_CANCEL", "A bound cancel request is required");
  const std::shared_ptr<MacComputerUseSession> session =
      FindCancelableMacSession(session_id);
  if (session == nullptr || session->closed.load(std::memory_order_acquire))
    return ThrowNativeError(env, "SESSION_MISSING", "The native session is unavailable");
  if (requested_cancel_epoch <= session->cancel_epoch.load(std::memory_order_acquire))
    return ThrowNativeError(env, "INVALID_CANCEL", "The cancel epoch is stale");
  std::uint64_t current_cancel_epoch =
      cancellation_epoch.load(std::memory_order_acquire);
  bool advanced = false;
  while (requested_cancel_epoch > current_cancel_epoch) {
    if (cancellation_epoch.compare_exchange_weak(
            current_cancel_epoch, requested_cancel_epoch, std::memory_order_acq_rel,
            std::memory_order_acquire)) {
      advanced = true;
      break;
    }
  }
  if (!advanced)
    return ThrowNativeError(env, "INVALID_CANCEL", "The global cancel epoch is newer");
  session->cancel_epoch.store(requested_cancel_epoch, std::memory_order_release);
  session->observation_publication_epoch.store(requested_cancel_epoch,
                                               std::memory_order_release);
  session->observation_publication_claimed.store(false,
                                                 std::memory_order_release);
  napi_value result;
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "result", StringValue(env, "canceled"));
  napi_set_named_property(
      env, result, "cancelEpoch",
      NumberValue(env, static_cast<double>(requested_cancel_epoch)));
  return result;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"probe", nullptr, Probe, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"handshake", nullptr, Handshake, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"pickApplication", nullptr, PickApplication, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"listWindows", nullptr, ListWindows, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"startSession", nullptr, StartSession, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"observe", nullptr, Observe, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"dispatch", nullptr, Dispatch, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"cancel", nullptr, Cancel, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"close", nullptr, CloseSession, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
