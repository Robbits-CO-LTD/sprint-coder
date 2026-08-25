#include "native_safe_fs_win_mutation.h"

#include <windows.h>
#include <wincrypt.h>
#include <winternl.h>

#include <algorithm>
#include <charconv>
#include <cstdint>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace {

constexpr uint64_t kMaxArtifactBytes = 1024 * 1024;
constexpr uint32_t kRegularFile0600 = 0100600;
constexpr NTSTATUS kStatusObjectNameNotFound = static_cast<NTSTATUS>(0xC0000034L);
constexpr NTSTATUS kStatusObjectPathNotFound = static_cast<NTSTATUS>(0xC000003AL);
constexpr NTSTATUS kStatusObjectNameCollision = static_cast<NTSTATUS>(0xC0000035L);
constexpr NTSTATUS kStatusSharingViolation = static_cast<NTSTATUS>(0xC0000043L);

struct HandleCloser {
  void operator()(void* value) const {
    HANDLE handle = static_cast<HANDLE>(value);
    if (handle != nullptr && handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
  }
};
using OwnedHandle = std::unique_ptr<void, HandleCloser>;

struct JournalState {
  std::string intent_digest;
  std::string record_digest;
  uint32_t revision = 0;
};

struct MutationSession {
  std::string id;
  std::string root_id;
  std::string workspace_key;
  uint64_t fence = 0;
  std::string root_dev;
  std::string root_ino;
  OwnedHandle root;
  OwnedHandle lock;
  bool stale = false;
  std::unordered_map<std::string, JournalState> journals;
  std::unordered_map<std::string, uint32_t> observed_modes;
};

struct EndpointRevision {
  bool present = false;
  std::string identity_digest;
  std::string content_hash;
  uint64_t size = 0;
  uint32_t mode = kRegularFile0600;
};

std::mutex sessions_mutex;
std::unordered_map<std::string, std::shared_ptr<MutationSession>> sessions;
std::unordered_map<std::string, uint64_t> minimum_fences;

using NtCreateFileFn = NTSTATUS(NTAPI*)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES,
                                       PIO_STATUS_BLOCK, PLARGE_INTEGER, ULONG, ULONG, ULONG,
                                       ULONG, PVOID, ULONG);
using NtSetInformationFileFn = NTSTATUS(NTAPI*)(HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG,
                                                FILE_INFORMATION_CLASS);

napi_value MakeString(napi_env env, const std::string& value) {
  napi_value result;
  napi_create_string_utf8(env, value.data(), value.size(), &result);
  return result;
}

napi_value MakeBoolean(napi_env env, bool value) {
  napi_value result;
  napi_get_boolean(env, value, &result);
  return result;
}

napi_value ThrowFailure(napi_env env, const char* code, const char* message) {
  napi_value error;
  napi_create_error(env, nullptr, MakeString(env, message), &error);
  napi_set_named_property(env, error, "code", MakeString(env, code));
  napi_throw(env, error);
  return nullptr;
}

bool ReadString(napi_env env, napi_value value, std::string* output) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok || length == 0 ||
      length > 32768)
    return false;
  std::string buffer(length + 1, '\0');
  size_t copied = 0;
  if (napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(), &copied) != napi_ok ||
      copied != length)
    return false;
  buffer.resize(length);
  if (buffer.find('\0') != std::string::npos) return false;
  *output = std::move(buffer);
  return true;
}

bool NamedValue(napi_env env, napi_value object, const char* name, napi_value* output) {
  bool present = false;
  return napi_has_named_property(env, object, name, &present) == napi_ok && present &&
         napi_get_named_property(env, object, name, output) == napi_ok;
}

bool NamedString(napi_env env, napi_value object, const char* name, std::string* output) {
  napi_value value;
  return NamedValue(env, object, name, &value) && ReadString(env, value, output);
}

bool NamedUint32(napi_env env, napi_value object, const char* name, uint32_t* output) {
  napi_value value;
  return NamedValue(env, object, name, &value) &&
         napi_get_value_uint32(env, value, output) == napi_ok;
}

bool ParsePositiveDecimal(const std::string& value, uint64_t* output) {
  if (value.empty() || value.size() > 20 || value[0] == '0') return false;
  uint64_t parsed = 0;
  const auto result = std::from_chars(value.data(), value.data() + value.size(), parsed);
  if (result.ec != std::errc{} || result.ptr != value.data() + value.size() || parsed == 0)
    return false;
  *output = parsed;
  return true;
}

bool IsLowerHex(const std::string& value, size_t length) {
  return value.size() == length &&
         std::all_of(value.begin(), value.end(), [](char character) {
           return (character >= '0' && character <= '9') ||
                  (character >= 'a' && character <= 'f');
         });
}

bool Utf8ToWide(const std::string& input, std::wstring* output) {
  if (input.empty() || input.size() > 32767) return false;
  const int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, input.data(),
                                         static_cast<int>(input.size()), nullptr, 0);
  if (length <= 0) return false;
  output->resize(static_cast<size_t>(length));
  return MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, input.data(),
                             static_cast<int>(input.size()), output->data(), length) == length;
}

std::wstring Uppercase(std::wstring value) {
  std::transform(value.begin(), value.end(), value.begin(),
                 [](wchar_t character) { return static_cast<wchar_t>(towupper(character)); });
  return value;
}

bool IsSafeSegment(const std::wstring& segment) {
  if (segment.empty() || segment.size() > 255 || segment == L"." || segment == L".." ||
      segment.back() == L'.' || segment.back() == L' ' ||
      segment.find_first_of(L"\\/:\0") != std::wstring::npos)
    return false;
  const size_t dot = segment.find(L'.');
  const std::wstring stem = Uppercase(segment.substr(0, dot));
  if (stem == L"CON" || stem == L"PRN" || stem == L"AUX" || stem == L"NUL") return false;
  if (stem.size() == 4 &&
      (stem.rfind(L"COM", 0) == 0 || stem.rfind(L"LPT", 0) == 0) && stem[3] >= L'1' &&
      stem[3] <= L'9')
    return false;
  return true;
}

bool ReadSegments(napi_env env, napi_value object, const char* name,
                  std::vector<std::wstring>* output) {
  napi_value value;
  bool array = false;
  uint32_t length = 0;
  if (!NamedValue(env, object, name, &value) || napi_is_array(env, value, &array) != napi_ok ||
      !array || napi_get_array_length(env, value, &length) != napi_ok || length > 128)
    return false;
  output->clear();
  output->reserve(length);
  for (uint32_t index = 0; index < length; ++index) {
    napi_value item;
    std::string utf8;
    std::wstring wide;
    if (napi_get_element(env, value, index, &item) != napi_ok || !ReadString(env, item, &utf8) ||
        !Utf8ToWide(utf8, &wide) || !IsSafeSegment(wide))
      return false;
    output->push_back(std::move(wide));
  }
  return true;
}

OwnedHandle DuplicateOwnedHandle(HANDLE source) {
  HANDLE duplicate = INVALID_HANDLE_VALUE;
  if (!DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), &duplicate, 0, FALSE,
                       DUPLICATE_SAME_ACCESS))
    return OwnedHandle(nullptr);
  return OwnedHandle(duplicate);
}

NtCreateFileFn ResolveNtCreateFile() {
  static NtCreateFileFn function = [] {
    HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    return ntdll == nullptr
               ? nullptr
               : reinterpret_cast<NtCreateFileFn>(GetProcAddress(ntdll, "NtCreateFile"));
  }();
  return function;
}

NtSetInformationFileFn ResolveNtSetInformationFile() {
  static NtSetInformationFileFn function = [] {
    HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    return ntdll == nullptr
               ? nullptr
               : reinterpret_cast<NtSetInformationFileFn>(
                     GetProcAddress(ntdll, "NtSetInformationFile"));
  }();
  return function;
}

NTSTATUS OpenRelative(HANDLE parent, const std::wstring& name, ACCESS_MASK access, ULONG share,
                      ULONG disposition, ULONG options, ULONG attributes, HANDLE* output) {
  NtCreateFileFn create_file = ResolveNtCreateFile();
  if (create_file == nullptr) return static_cast<NTSTATUS>(0xC0000002L);
  UNICODE_STRING unicode{};
  unicode.Buffer = const_cast<PWSTR>(name.data());
  unicode.Length = static_cast<USHORT>(name.size() * sizeof(wchar_t));
  unicode.MaximumLength = unicode.Length;
  OBJECT_ATTRIBUTES object{};
  InitializeObjectAttributes(&object, &unicode, OBJ_CASE_INSENSITIVE, parent, nullptr);
  IO_STATUS_BLOCK status{};
  return create_file(output, access, &object, &status, nullptr, attributes, share, disposition,
                     options | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT, nullptr, 0);
}

bool IsReparsePoint(HANDLE handle) {
  FILE_ATTRIBUTE_TAG_INFO attributes{};
  return !GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &attributes,
                                       sizeof(attributes)) ||
         (attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
}

bool IsDirectoryHandle(HANDLE handle) {
  FILE_STANDARD_INFO info{};
  return GetFileInformationByHandleEx(handle, FileStandardInfo, &info, sizeof(info)) &&
         info.Directory != FALSE;
}

bool FileIdentity(HANDLE handle, uint64_t* dev, uint64_t* ino, uint32_t* links,
                  uint64_t* created) {
  BY_HANDLE_FILE_INFORMATION info{};
  if (!GetFileInformationByHandle(handle, &info)) return false;
  *dev = info.dwVolumeSerialNumber;
  *ino = (static_cast<uint64_t>(info.nFileIndexHigh) << 32) | info.nFileIndexLow;
  *links = info.nNumberOfLinks;
  *created = (static_cast<uint64_t>(info.ftCreationTime.dwHighDateTime) << 32) |
             info.ftCreationTime.dwLowDateTime;
  return true;
}

bool Sha256Bytes(const uint8_t* bytes, size_t length, std::string* output) {
  HCRYPTPROV provider = 0;
  HCRYPTHASH hash = 0;
  if (!CryptAcquireContextW(&provider, nullptr, nullptr, PROV_RSA_AES, CRYPT_VERIFYCONTEXT) ||
      !CryptCreateHash(provider, CALG_SHA_256, 0, 0, &hash)) {
    if (provider != 0) CryptReleaseContext(provider, 0);
    return false;
  }
  bool ok = length <= MAXDWORD &&
            CryptHashData(hash, bytes, static_cast<DWORD>(length), 0) != FALSE;
  BYTE digest[32]{};
  DWORD digest_length = sizeof(digest);
  ok = ok && CryptGetHashParam(hash, HP_HASHVAL, digest, &digest_length, 0) != FALSE &&
       digest_length == sizeof(digest);
  CryptDestroyHash(hash);
  CryptReleaseContext(provider, 0);
  if (!ok) return false;
  static constexpr char alphabet[] = "0123456789abcdef";
  output->resize(64);
  for (size_t index = 0; index < sizeof(digest); ++index) {
    (*output)[index * 2] = alphabet[digest[index] >> 4];
    (*output)[index * 2 + 1] = alphabet[digest[index] & 0x0f];
  }
  return true;
}

bool Sha256String(const std::string& input, std::string* output) {
  return Sha256Bytes(reinterpret_cast<const uint8_t*>(input.data()), input.size(), output);
}

bool RandomHex(size_t bytes, std::string* output) {
  HCRYPTPROV provider = 0;
  std::vector<BYTE> random(bytes);
  if (!CryptAcquireContextW(&provider, nullptr, nullptr, PROV_RSA_AES, CRYPT_VERIFYCONTEXT) ||
      !CryptGenRandom(provider, static_cast<DWORD>(random.size()), random.data())) {
    if (provider != 0) CryptReleaseContext(provider, 0);
    return false;
  }
  CryptReleaseContext(provider, 0);
  static constexpr char alphabet[] = "0123456789abcdef";
  output->resize(bytes * 2);
  for (size_t index = 0; index < bytes; ++index) {
    (*output)[index * 2] = alphabet[random[index] >> 4];
    (*output)[index * 2 + 1] = alphabet[random[index] & 0x0f];
  }
  return true;
}

bool HashFile(HANDLE handle, uint64_t size, std::string* output) {
  if (size > kMaxArtifactBytes) return false;
  LARGE_INTEGER start{};
  if (!SetFilePointerEx(handle, start, nullptr, FILE_BEGIN)) return false;
  std::vector<uint8_t> bytes(static_cast<size_t>(size));
  size_t offset = 0;
  while (offset < bytes.size()) {
    DWORD read = 0;
    DWORD requested = static_cast<DWORD>(std::min<size_t>(bytes.size() - offset, 65536));
    if (!ReadFile(handle, bytes.data() + offset, requested, &read, nullptr) || read == 0)
      return false;
    offset += read;
  }
  return Sha256Bytes(bytes.data(), bytes.size(), output);
}

bool ObserveHandle(HANDLE handle, uint32_t mode, EndpointRevision* output) {
  if (IsReparsePoint(handle) || IsDirectoryHandle(handle)) return false;
  uint64_t dev = 0, ino = 0, created = 0;
  uint32_t links = 0;
  FILE_STANDARD_INFO standard{};
  if (!FileIdentity(handle, &dev, &ino, &links, &created) || links != 1 ||
      !GetFileInformationByHandleEx(handle, FileStandardInfo, &standard, sizeof(standard)) ||
      standard.EndOfFile.QuadPart < 0 ||
      static_cast<uint64_t>(standard.EndOfFile.QuadPart) > kMaxArtifactBytes)
    return false;
  const uint64_t size = static_cast<uint64_t>(standard.EndOfFile.QuadPart);
  std::string identity;
  if (!Sha256String(std::to_string(dev) + ":" + std::to_string(ino) + ":" +
                        std::to_string(created),
                    &identity) ||
      !HashFile(handle, size, &output->content_hash))
    return false;
  output->present = true;
  output->identity_digest = std::move(identity);
  output->size = size;
  output->mode = mode;
  return true;
}

bool OpenDirectoryPath(HANDLE root, const std::vector<std::wstring>& segments,
                       OwnedHandle* output) {
  OwnedHandle current = DuplicateOwnedHandle(root);
  if (!current) return false;
  for (const std::wstring& segment : segments) {
    HANDLE child = INVALID_HANDLE_VALUE;
    const NTSTATUS status = OpenRelative(
        current.get(), segment, FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES |
                                    SYNCHRONIZE,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, FILE_OPEN,
        FILE_DIRECTORY_FILE, FILE_ATTRIBUTE_NORMAL, &child);
    if (status < 0) return false;
    OwnedHandle next(child);
    if (IsReparsePoint(next.get()) || !IsDirectoryHandle(next.get())) return false;
    current = std::move(next);
  }
  *output = std::move(current);
  return true;
}

enum class EndpointResult { kAbsent, kPresent, kUnsafe, kFailure };

EndpointResult ObserveEndpoint(const std::shared_ptr<MutationSession>& session,
                               const std::vector<std::wstring>& segments,
                               EndpointRevision* revision, OwnedHandle* held = nullptr,
                               ACCESS_MASK extra_access = 0,
                               ULONG share = FILE_SHARE_READ | FILE_SHARE_WRITE |
                                             FILE_SHARE_DELETE) {
  if (segments.empty()) return EndpointResult::kUnsafe;
  std::vector<std::wstring> parents(segments.begin(), segments.end() - 1);
  OwnedHandle parent;
  if (!OpenDirectoryPath(session->root.get(), parents, &parent)) return EndpointResult::kUnsafe;
  HANDLE file = INVALID_HANDLE_VALUE;
  const NTSTATUS status = OpenRelative(
      parent.get(), segments.back(), FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE |
                                         extra_access,
      share, FILE_OPEN, FILE_NON_DIRECTORY_FILE, FILE_ATTRIBUTE_NORMAL, &file);
  if (status == kStatusObjectNameNotFound || status == kStatusObjectPathNotFound)
    return EndpointResult::kAbsent;
  if (status < 0) return EndpointResult::kFailure;
  OwnedHandle owned(file);
  EndpointRevision observed;
  if (!ObserveHandle(owned.get(), kRegularFile0600, &observed)) return EndpointResult::kUnsafe;
  const auto mode = session->observed_modes.find(observed.identity_digest);
  if (mode != session->observed_modes.end()) observed.mode = mode->second;
  *revision = std::move(observed);
  if (held != nullptr) *held = std::move(owned);
  return EndpointResult::kPresent;
}

napi_value AbsentEndpoint(napi_env env) {
  napi_value result;
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "state", MakeString(env, "absent"));
  return result;
}

napi_value RevisionValue(napi_env env, const EndpointRevision& revision) {
  napi_value result, size, mode, links;
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "state", MakeString(env, "present"));
  napi_set_named_property(env, result, "identityDigest", MakeString(env, revision.identity_digest));
  napi_set_named_property(env, result, "contentHash", MakeString(env, revision.content_hash));
  napi_create_double(env, static_cast<double>(revision.size), &size);
  napi_create_uint32(env, revision.mode, &mode);
  napi_create_uint32(env, 1, &links);
  napi_set_named_property(env, result, "size", size);
  napi_set_named_property(env, result, "mode", mode);
  napi_set_named_property(env, result, "nlink", links);
  return result;
}

napi_value EffectValue(napi_env env, const EndpointRevision* source,
                       const EndpointRevision* destination, const EndpointRevision* auxiliary) {
  napi_value result;
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "source",
                          source == nullptr ? AbsentEndpoint(env) : RevisionValue(env, *source));
  napi_set_named_property(env, result, "destination",
                          destination == nullptr ? AbsentEndpoint(env)
                                                 : RevisionValue(env, *destination));
  napi_set_named_property(env, result, "auxiliary",
                          auxiliary == nullptr ? AbsentEndpoint(env)
                                               : RevisionValue(env, *auxiliary));
  return result;
}

std::shared_ptr<MutationSession> SessionFor(napi_env env, napi_value input) {
  std::string id;
  if (!NamedString(env, input, "sessionId", &id) || !IsLowerHex(id, 32)) {
    ThrowFailure(env, "INVALID_INPUT", "Invalid NativeSafeFs session id");
    return nullptr;
  }
  std::lock_guard<std::mutex> guard(sessions_mutex);
  const auto found = sessions.find(id);
  if (found == sessions.end() || found->second->stale ||
      found->second->fence <= minimum_fences[found->second->workspace_key]) {
    ThrowFailure(env, "STALE_SESSION", "NativeSafeFs session is stale");
    return nullptr;
  }
  return found->second;
}

bool BindJournal(napi_env env, napi_value input, MutationSession* session) {
  std::string id, intent_digest, record_digest;
  uint32_t revision = 0;
  if (!NamedString(env, input, "intentId", &id) || id.size() > 200 ||
      !NamedString(env, input, "intentDigest", &intent_digest) ||
      !IsLowerHex(intent_digest, 64) ||
      !NamedString(env, input, "recordDigest", &record_digest) ||
      !IsLowerHex(record_digest, 64) || !NamedUint32(env, input, "revision", &revision)) {
    ThrowFailure(env, "INVALID_INPUT", "Invalid NativeSafeFs journal binding");
    return false;
  }
  auto found = session->journals.find(id);
  if (found == session->journals.end()) {
    session->journals.emplace(id, JournalState{intent_digest, record_digest, revision});
    return true;
  }
  if (found->second.intent_digest != intent_digest || revision < found->second.revision ||
      (revision == found->second.revision && found->second.record_digest != record_digest)) {
    ThrowFailure(env, "STALE_FENCE", "NativeSafeFs journal binding is stale");
    return false;
  }
  found->second.record_digest = record_digest;
  found->second.revision = revision;
  return true;
}

bool ReadExpectedRevision(napi_env env, napi_value object, const char* name,
                          EndpointRevision* output) {
  napi_value value;
  if (!NamedValue(env, object, name, &value)) return false;
  std::string state;
  if (!NamedString(env, value, "state", &state) || state != "present" ||
      !NamedString(env, value, "identityDigest", &output->identity_digest) ||
      !IsLowerHex(output->identity_digest, 64) ||
      !NamedString(env, value, "contentHash", &output->content_hash) ||
      !IsLowerHex(output->content_hash, 64) || !NamedUint32(env, value, "mode", &output->mode))
    return false;
  napi_value size_value;
  double size = -1;
  if (!NamedValue(env, value, "size", &size_value) ||
      napi_get_value_double(env, size_value, &size) != napi_ok || size < 0 ||
      size > static_cast<double>(kMaxArtifactBytes) || size != static_cast<uint64_t>(size))
    return false;
  output->present = true;
  output->size = static_cast<uint64_t>(size);
  return true;
}

bool ReadExpectedAbsent(napi_env env, napi_value object, const char* name) {
  napi_value value;
  std::string state;
  return NamedValue(env, object, name, &value) && NamedString(env, value, "state", &state) &&
         state == "absent";
}

bool ReadNamedNull(napi_env env, napi_value object, const char* name) {
  napi_value value;
  napi_valuetype type = napi_undefined;
  return NamedValue(env, object, name, &value) && napi_typeof(env, value, &type) == napi_ok &&
         type == napi_null;
}

bool IsTemporaryLeaf(const std::wstring& leaf) {
  static constexpr wchar_t prefix[] = L".sprint-coder-temp-";
  constexpr size_t prefix_length = 19;
  if (leaf.size() != prefix_length + 32 || leaf.compare(0, prefix_length, prefix) != 0)
    return false;
  return std::all_of(leaf.begin() + prefix_length, leaf.end(), [](wchar_t character) {
    return (character >= L'0' && character <= L'9') ||
           (character >= L'a' && character <= L'f');
  });
}

bool SameRevision(const EndpointRevision& left, const EndpointRevision& right) {
  return left.present && right.present && left.identity_digest == right.identity_digest &&
         left.content_hash == right.content_hash && left.size == right.size &&
         left.mode == right.mode;
}

NTSTATUS RenameWithinParent(HANDLE file, HANDLE parent, const std::wstring& leaf) {
  NtSetInformationFileFn set_information = ResolveNtSetInformationFile();
  if (set_information == nullptr) return static_cast<NTSTATUS>(0xC0000002L);
  const size_t bytes = sizeof(FILE_RENAME_INFO) + leaf.size() * sizeof(wchar_t);
  std::vector<uint8_t> storage(bytes, 0);
  auto* rename = reinterpret_cast<FILE_RENAME_INFO*>(storage.data());
  rename->ReplaceIfExists = FALSE;
  rename->RootDirectory = parent;
  rename->FileNameLength = static_cast<DWORD>(leaf.size() * sizeof(wchar_t));
  std::memcpy(rename->FileName, leaf.data(), rename->FileNameLength);
  IO_STATUS_BLOCK status{};
  return set_information(file, &status, rename, static_cast<ULONG>(bytes),
                         static_cast<FILE_INFORMATION_CLASS>(10));
}

bool StoreFence(HANDLE lock, uint64_t fence) {
  const std::string text = std::to_string(fence);
  LARGE_INTEGER start{};
  DWORD written = 0;
  return SetFilePointerEx(lock, start, nullptr, FILE_BEGIN) && SetEndOfFile(lock) &&
         WriteFile(lock, text.data(), static_cast<DWORD>(text.size()), &written, nullptr) &&
         written == text.size() && FlushFileBuffers(lock);
}

}  // namespace

napi_value WindowsMutationProbeCapabilities(napi_env env) {
  napi_value capabilities;
  napi_create_object(env, &capabilities);
  napi_set_named_property(env, capabilities, "rootSession", MakeBoolean(env, true));
  napi_set_named_property(env, capabilities, "workspaceLock", MakeBoolean(env, true));
  napi_set_named_property(env, capabilities, "durableFence", MakeBoolean(env, true));
  napi_set_named_property(env, capabilities, "synchronousInvalidation", MakeBoolean(env, true));
  napi_set_named_property(env, capabilities, "mutation", MakeBoolean(env, true));
  napi_set_named_property(env, capabilities, "mutationScope", MakeString(env, "add-only"));
  napi_set_named_property(env, capabilities, "directoryOwnership", MakeBoolean(env, false));
  return capabilities;
}

napi_value WindowsMutationOpenSession(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1)
    return ThrowFailure(env, "INVALID_INPUT", "openSession requires one input object");
  std::string root_id, workspace_path, root_dev, root_ino, workspace_key, lock_path, fence_text;
  uint64_t fence = 0, expected_dev = 0, expected_ino = 0;
  if (!NamedString(env, argv[0], "rootId", &root_id) || root_id.size() > 200 ||
      !NamedString(env, argv[0], "workspacePath", &workspace_path) ||
      !NamedString(env, argv[0], "rootDev", &root_dev) ||
      !NamedString(env, argv[0], "rootIno", &root_ino) ||
      !NamedString(env, argv[0], "workspaceKey", &workspace_key) ||
      !IsLowerHex(workspace_key, 64) ||
      !NamedString(env, argv[0], "lockDirectoryPath", &lock_path) ||
      !NamedString(env, argv[0], "fence", &fence_text) ||
      !ParsePositiveDecimal(root_dev, &expected_dev) ||
      !ParsePositiveDecimal(root_ino, &expected_ino) || !ParsePositiveDecimal(fence_text, &fence))
    return ThrowFailure(env, "INVALID_INPUT", "Invalid NativeSafeFs session input");
  std::wstring workspace_wide, lock_wide;
  if (!Utf8ToWide(workspace_path, &workspace_wide) || !Utf8ToWide(lock_path, &lock_wide))
    return ThrowFailure(env, "INVALID_INPUT", "Invalid NativeSafeFs Windows path");
  OwnedHandle root(CreateFileW(workspace_wide.c_str(), FILE_LIST_DIRECTORY | FILE_TRAVERSE |
                                                        FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                               FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
                               OPEN_EXISTING,
                               FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (!root || IsReparsePoint(root.get()) || !IsDirectoryHandle(root.get()))
    return ThrowFailure(env, "ROOT_IDENTITY_CHANGED", "Workspace root is not a safe directory");
  uint64_t actual_dev = 0, actual_ino = 0, created = 0;
  uint32_t links = 0;
  if (!FileIdentity(root.get(), &actual_dev, &actual_ino, &links, &created) ||
      actual_dev != expected_dev || actual_ino != expected_ino)
    return ThrowFailure(env, "ROOT_IDENTITY_CHANGED", "Workspace root identity changed");
  OwnedHandle lock_directory(CreateFileW(lock_wide.c_str(), FILE_LIST_DIRECTORY | FILE_TRAVERSE |
                                                                FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                                         FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                                         nullptr, OPEN_EXISTING,
                                         FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                                         nullptr));
  if (!lock_directory || IsReparsePoint(lock_directory.get()) ||
      !IsDirectoryHandle(lock_directory.get()))
    return ThrowFailure(env, "UNSAFE_LOCK", "NativeSafeFs lock directory is unsafe");
  std::wstring lock_leaf;
  if (!Utf8ToWide(workspace_key + ".lock", &lock_leaf))
    return ThrowFailure(env, "UNSAFE_LOCK", "NativeSafeFs lock name is invalid");
  HANDLE raw_lock = INVALID_HANDLE_VALUE;
  const NTSTATUS lock_status = OpenRelative(
      lock_directory.get(), lock_leaf, FILE_READ_DATA | FILE_WRITE_DATA | FILE_READ_ATTRIBUTES |
                                             FILE_WRITE_ATTRIBUTES | SYNCHRONIZE,
      0, FILE_OPEN_IF, FILE_NON_DIRECTORY_FILE, FILE_ATTRIBUTE_HIDDEN, &raw_lock);
  if (lock_status == kStatusSharingViolation)
    return ThrowFailure(env, "LOCK_BUSY", "NativeSafeFs Workspace lock is busy");
  if (lock_status < 0)
    return ThrowFailure(env, "UNSAFE_LOCK", "NativeSafeFs Workspace lock could not be opened");
  OwnedHandle lock(raw_lock);
  if (IsReparsePoint(lock.get()) || IsDirectoryHandle(lock.get()))
    return ThrowFailure(env, "UNSAFE_LOCK", "NativeSafeFs Workspace lock is unsafe");
  uint64_t lock_dev = 0, lock_ino = 0, lock_created = 0;
  uint32_t lock_links = 0;
  if (!FileIdentity(lock.get(), &lock_dev, &lock_ino, &lock_links, &lock_created) ||
      lock_links != 1)
    return ThrowFailure(env, "UNSAFE_LOCK", "NativeSafeFs Workspace lock identity is unsafe");
  char previous_buffer[32]{};
  DWORD previous_bytes = 0;
  LARGE_INTEGER start{};
  SetFilePointerEx(lock.get(), start, nullptr, FILE_BEGIN);
  if (!ReadFile(lock.get(), previous_buffer, sizeof(previous_buffer) - 1, &previous_bytes, nullptr))
    return ThrowFailure(env, "UNSAFE_LOCK", "NativeSafeFs Workspace fence could not be read");
  if (previous_bytes > 0) {
    uint64_t previous = 0;
    std::string text(previous_buffer, previous_bytes);
    if (!ParsePositiveDecimal(text, &previous) || fence <= previous)
      return ThrowFailure(env, "STALE_FENCE", "NativeSafeFs Workspace fence is stale");
  }
  auto session = std::make_shared<MutationSession>();
  if (!RandomHex(16, &session->id))
    return ThrowFailure(env, "NATIVE_FAILURE", "NativeSafeFs session id generation failed");
  session->root_id = root_id;
  session->workspace_key = workspace_key;
  session->fence = fence;
  session->root_dev = root_dev;
  session->root_ino = root_ino;
  session->root = std::move(root);
  session->lock = std::move(lock);
  {
    std::lock_guard<std::mutex> guard(sessions_mutex);
    const uint64_t minimum = minimum_fences[workspace_key];
    if (fence <= minimum)
      return ThrowFailure(env, "STALE_FENCE", "NativeSafeFs Workspace fence was invalidated");
    if (sessions.find(session->id) != sessions.end())
      return ThrowFailure(env, "NATIVE_FAILURE", "NativeSafeFs session id collided");
    if (!StoreFence(session->lock.get(), fence))
      return ThrowFailure(env, "UNSAFE_LOCK", "NativeSafeFs Workspace fence was not durable");
    sessions.emplace(session->id, session);
  }
  napi_value result;
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "id", MakeString(env, session->id));
  napi_set_named_property(env, result, "rootId", MakeString(env, root_id));
  napi_set_named_property(env, result, "workspaceKey", MakeString(env, workspace_key));
  napi_set_named_property(env, result, "fence", MakeString(env, fence_text));
  napi_set_named_property(env, result, "rootDev", MakeString(env, root_dev));
  napi_set_named_property(env, result, "rootIno", MakeString(env, root_ino));
  return result;
}

napi_value WindowsMutationInvalidateWorkspace(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  std::string key, fence_text;
  uint64_t fence = 0;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 2 ||
      !ReadString(env, argv[0], &key) || !IsLowerHex(key, 64) ||
      !ReadString(env, argv[1], &fence_text) || !ParsePositiveDecimal(fence_text, &fence))
    return ThrowFailure(env, "INVALID_INPUT", "Invalid NativeSafeFs fence invalidation");
  std::lock_guard<std::mutex> guard(sessions_mutex);
  minimum_fences[key] = std::max(minimum_fences[key], fence);
  bool durable = true;
  for (auto iterator = sessions.begin(); iterator != sessions.end();) {
    auto session = iterator->second;
    if (session->workspace_key != key) {
      ++iterator;
      continue;
    }
    session->stale = true;
    durable = StoreFence(session->lock.get(), std::max(session->fence, fence)) && durable;
    iterator = sessions.erase(iterator);
  }
  if (!durable)
    return ThrowFailure(env, "UNSAFE_LOCK", "NativeSafeFs invalidation fence was not durable");
  return MakeBoolean(env, true);
}

napi_value WindowsMutationObserveIntent(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1)
    return ThrowFailure(env, "INVALID_INPUT", "observeIntent requires one input object");
  auto session = SessionFor(env, argv[0]);
  if (!session || !BindJournal(env, argv[0], session.get())) return nullptr;
  std::vector<std::wstring> source, destination, auxiliary;
  if (!ReadSegments(env, argv[0], "sourceSegments", &source))
    return ThrowFailure(env, "INVALID_INPUT", "Invalid NativeSafeFs source path");
  napi_value destination_value, auxiliary_value;
  napi_valuetype destination_type = napi_undefined, auxiliary_type = napi_undefined;
  if (!NamedValue(env, argv[0], "destinationSegments", &destination_value) ||
      !NamedValue(env, argv[0], "auxiliarySegments", &auxiliary_value) ||
      napi_typeof(env, destination_value, &destination_type) != napi_ok ||
      napi_typeof(env, auxiliary_value, &auxiliary_type) != napi_ok)
    return ThrowFailure(env, "INVALID_INPUT", "Invalid NativeSafeFs endpoint paths");
  const bool has_destination = destination_type != napi_null;
  const bool has_auxiliary = auxiliary_type != napi_null;
  if ((has_destination && !ReadSegments(env, argv[0], "destinationSegments", &destination)) ||
      (has_auxiliary && !ReadSegments(env, argv[0], "auxiliarySegments", &auxiliary)))
    return ThrowFailure(env, "INVALID_INPUT", "Invalid NativeSafeFs endpoint path");
  EndpointRevision source_revision, destination_revision, auxiliary_revision;
  EndpointResult source_result = ObserveEndpoint(session, source, &source_revision);
  EndpointResult destination_result =
      has_destination ? ObserveEndpoint(session, destination, &destination_revision)
                      : EndpointResult::kAbsent;
  EndpointResult auxiliary_result =
      has_auxiliary ? ObserveEndpoint(session, auxiliary, &auxiliary_revision)
                    : EndpointResult::kAbsent;
  if (source_result == EndpointResult::kUnsafe || destination_result == EndpointResult::kUnsafe ||
      auxiliary_result == EndpointResult::kUnsafe)
    return ThrowFailure(env, "UNSAFE_PATH", "NativeSafeFs endpoint is unsafe");
  if (source_result == EndpointResult::kFailure ||
      destination_result == EndpointResult::kFailure ||
      auxiliary_result == EndpointResult::kFailure)
    return ThrowFailure(env, "NATIVE_FAILURE", "NativeSafeFs endpoint observation failed");
  return EffectValue(env, source_result == EndpointResult::kPresent ? &source_revision : nullptr,
                     destination_result == EndpointResult::kPresent ? &destination_revision
                                                                    : nullptr,
                     auxiliary_result == EndpointResult::kPresent ? &auxiliary_revision : nullptr);
}

napi_value WindowsMutationStageIntentArtifact(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 2)
    return ThrowFailure(env, "INVALID_INPUT", "stageIntentArtifact requires input and bytes");
  auto session = SessionFor(env, argv[0]);
  if (!session || !BindJournal(env, argv[0], session.get())) return nullptr;
  bool is_buffer = false;
  void* bytes = nullptr;
  size_t length = 0;
  std::vector<std::wstring> parents;
  std::string leaf_utf8, expected_hash;
  uint32_t expected_size = 0, expected_mode = 0;
  if (napi_is_buffer(env, argv[1], &is_buffer) != napi_ok || !is_buffer ||
      napi_get_buffer_info(env, argv[1], &bytes, &length) != napi_ok ||
      !ReadSegments(env, argv[0], "parentSegments", &parents) ||
      !NamedString(env, argv[0], "leafName", &leaf_utf8) ||
      !NamedString(env, argv[0], "expectedContentHash", &expected_hash) ||
      !IsLowerHex(expected_hash, 64) ||
      !NamedUint32(env, argv[0], "expectedSize", &expected_size) ||
      !NamedUint32(env, argv[0], "expectedMode", &expected_mode) || length != expected_size ||
      length > kMaxArtifactBytes || (expected_mode & 0170000) != 0100000)
    return ThrowFailure(env, "INVALID_INPUT", "Invalid NativeSafeFs staged artifact");
  std::string actual_hash;
  if (!Sha256Bytes(static_cast<const uint8_t*>(bytes), length, &actual_hash) ||
      actual_hash != expected_hash)
    return ThrowFailure(env, "INVALID_INPUT", "NativeSafeFs staged artifact hash mismatched");
  std::wstring leaf;
  if (!Utf8ToWide(leaf_utf8, &leaf) || !IsSafeSegment(leaf) || !IsTemporaryLeaf(leaf))
    return ThrowFailure(env, "INVALID_INPUT", "Invalid NativeSafeFs staged leaf");
  OwnedHandle parent;
  if (!OpenDirectoryPath(session->root.get(), parents, &parent))
    return ThrowFailure(env, "UNSAFE_PATH", "NativeSafeFs staging parent is unsafe");
  HANDLE raw = INVALID_HANDLE_VALUE;
  const NTSTATUS status = OpenRelative(
      parent.get(), leaf, FILE_READ_DATA | FILE_WRITE_DATA | FILE_READ_ATTRIBUTES |
                              FILE_WRITE_ATTRIBUTES | DELETE | SYNCHRONIZE,
      FILE_SHARE_READ, FILE_CREATE, FILE_NON_DIRECTORY_FILE, FILE_ATTRIBUTE_NORMAL, &raw);
  if (status == kStatusObjectNameCollision)
    return ThrowFailure(env, "UNSAFE_PATH", "NativeSafeFs staging artifact already exists");
  if (status < 0)
    return ThrowFailure(env, "NATIVE_FAILURE", "NativeSafeFs staging artifact could not be created");
  OwnedHandle file(raw);
  DWORD written = 0;
  if ((length > 0 &&
       (!WriteFile(file.get(), bytes, static_cast<DWORD>(length), &written, nullptr) ||
        written != length)) ||
      !FlushFileBuffers(file.get())) {
    FILE_DISPOSITION_INFO disposition{TRUE};
    SetFileInformationByHandle(file.get(), FileDispositionInfo, &disposition, sizeof(disposition));
    return ThrowFailure(env, "NATIVE_FAILURE", "NativeSafeFs staging artifact write failed");
  }
  EndpointRevision revision;
  if (!ObserveHandle(file.get(), expected_mode, &revision) || revision.content_hash != expected_hash ||
      revision.size != expected_size) {
    FILE_DISPOSITION_INFO disposition{TRUE};
    SetFileInformationByHandle(file.get(), FileDispositionInfo, &disposition, sizeof(disposition));
    return ThrowFailure(env, "NATIVE_FAILURE", "NativeSafeFs staging verification failed");
  }
  session->observed_modes[revision.identity_digest] = expected_mode;
  return RevisionValue(env, revision);
}

napi_value WindowsMutationApplyIntentEffect(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1)
    return ThrowFailure(env, "INVALID_INPUT", "applyIntentEffect requires one input object");
  auto session = SessionFor(env, argv[0]);
  if (!session || !BindJournal(env, argv[0], session.get())) return nullptr;
  std::string kind;
  std::vector<std::wstring> source, auxiliary;
  EndpointRevision expected_auxiliary;
  if (!NamedString(env, argv[0], "kind", &kind) || kind != "add" ||
      !ReadSegments(env, argv[0], "sourceSegments", &source) ||
      !ReadSegments(env, argv[0], "auxiliarySegments", &auxiliary) ||
      !ReadNamedNull(env, argv[0], "destinationSegments") ||
      !ReadExpectedAbsent(env, argv[0], "expectedSource") ||
      !ReadExpectedAbsent(env, argv[0], "expectedDestination") ||
      source.empty() || auxiliary.empty() ||
      !IsTemporaryLeaf(auxiliary.back()) ||
      std::vector<std::wstring>(source.begin(), source.end() - 1) !=
          std::vector<std::wstring>(auxiliary.begin(), auxiliary.end() - 1) ||
      !ReadExpectedRevision(env, argv[0], "expectedAuxiliary", &expected_auxiliary))
    return ThrowFailure(env, "UNSUPPORTED_PLATFORM",
                        "Windows NativeSafeFs currently supports add intents only");
  EndpointRevision source_revision, auxiliary_revision;
  if (ObserveEndpoint(session, source, &source_revision) != EndpointResult::kAbsent)
    return ThrowFailure(env, "UNSAFE_PATH", "NativeSafeFs add destination is not absent");
  OwnedHandle auxiliary_handle;
  const EndpointResult auxiliary_result = ObserveEndpoint(
      session, auxiliary, &auxiliary_revision, &auxiliary_handle, DELETE | FILE_WRITE_ATTRIBUTES,
      FILE_SHARE_READ);
  if (auxiliary_result != EndpointResult::kPresent ||
      !SameRevision(auxiliary_revision, expected_auxiliary))
    return ThrowFailure(env, "UNSAFE_PATH", "NativeSafeFs staged artifact identity drifted");
  std::vector<std::wstring> parents(source.begin(), source.end() - 1);
  OwnedHandle parent;
  if (!OpenDirectoryPath(session->root.get(), parents, &parent))
    return ThrowFailure(env, "UNSAFE_PATH", "NativeSafeFs add parent is unsafe");
  const NTSTATUS rename_status =
      RenameWithinParent(auxiliary_handle.get(), parent.get(), source.back());
  if (rename_status < 0)
    return ThrowFailure(env, "NATIVE_FAILURE", "NativeSafeFs atomic add failed");
  EndpointRevision final_revision;
  if (ObserveEndpoint(session, source, &final_revision) != EndpointResult::kPresent ||
      !SameRevision(final_revision, expected_auxiliary))
    return ThrowFailure(env, "NATIVE_FAILURE", "NativeSafeFs add verification failed");
  return EffectValue(env, &final_revision, nullptr, nullptr);
}

napi_value WindowsMutationCleanupIntentAuxiliary(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1)
    return ThrowFailure(env, "INVALID_INPUT", "cleanupIntentAuxiliary requires one input object");
  auto session = SessionFor(env, argv[0]);
  if (!session || !BindJournal(env, argv[0], session.get())) return nullptr;
  std::vector<std::wstring> auxiliary;
  EndpointRevision revision;
  if (!ReadSegments(env, argv[0], "auxiliarySegments", &auxiliary))
    return ThrowFailure(env, "INVALID_INPUT", "Invalid NativeSafeFs auxiliary path");
  const EndpointResult result = ObserveEndpoint(session, auxiliary, &revision);
  if (result != EndpointResult::kAbsent)
    return ThrowFailure(env, "UNSAFE_PATH", "NativeSafeFs auxiliary cleanup observed drift");
  return AbsentEndpoint(env);
}

napi_value WindowsMutationCloseSession(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  std::string id;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1 ||
      !ReadString(env, argv[0], &id) || !IsLowerHex(id, 32))
    return ThrowFailure(env, "INVALID_INPUT", "Invalid NativeSafeFs session id");
  std::shared_ptr<MutationSession> removed;
  {
    std::lock_guard<std::mutex> guard(sessions_mutex);
    const auto found = sessions.find(id);
    if (found == sessions.end())
      return ThrowFailure(env, "STALE_SESSION", "NativeSafeFs session is stale");
    removed = found->second;
    sessions.erase(found);
  }
  if (removed->stale)
    return ThrowFailure(env, "STALE_SESSION", "NativeSafeFs session is stale");
  return MakeBoolean(env, true);
}
